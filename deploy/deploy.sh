#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/qy-roam}"
ENV_FILE="${ENV_FILE:-/root/.config/qyroam/.env}"
SERVICE_NAME="${SERVICE_NAME:-qy-roam}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://qyroam.com}"
SYSTEMD_UNIT_PATH="${SYSTEMD_UNIT_PATH:-/etc/systemd/system/${SERVICE_NAME}.service}"
NGINX_CONFIG_PATH="${NGINX_CONFIG_PATH:-/etc/nginx/sites-available/qyroam}"
# Releases share fixed staging paths and replace one supervised service. A
# second deploy must never build into, clean up, or promote the first deploy's
# artifact. Keep the lock outside the repository so Git cleanliness and build
# packaging are unaffected, and acquire it before any source, dependency, or
# service mutation.
DEPLOY_LOCK_PATH="${DEPLOY_LOCK_PATH:-/run/lock/qyroam-deploy.lock}"
# Authenticated readiness can legitimately wait for the application's bounded
# database probes. Keep curl's deadline above that application budget so a
# slow-but-healthy probe can return its authoritative result instead of being
# mistaken for a failed release and triggering rollback.
READINESS_CURL_TIMEOUT_SECONDS=12
# Keep the wire-level readiness response within the same ceiling enforced by
# validate-sales-readiness.mjs. In particular, the post-restart probe writes
# to a temporary file before validation; without a curl limit, a broken proxy
# could fill disk even though the validator would eventually reject the body.
READINESS_MAX_RESPONSE_BYTES=65536
# Build away from the artifact that the live Next.js process is still serving.
# Next clears its dist directory during compilation; pointing it at `.next`
# here would create a customer-visible missing/mixed asset window before the
# release has passed smoke tests or reached the controlled restart boundary.
RELEASE_DIST_DIR=.next-release
# Restore a known-good rollback artifact into a separate tree on the same
# filesystem as the live `.next` directory. Copying directly into `.next`
# after moving the failed release away can leave a partial production tree if
# the copy runs out of space or is interrupted. The staged tree is promoted
# only after the complete snapshot copy succeeds.
ROLLBACK_RESTORE_DIST_DIR=.next-rollback-restore

# These values control filesystem replacement, cleanup, service restarts and
# the readiness authority used to approve a release. The application env file
# is sourced later to provide runtime secrets, but it must never be able to
# replace deployment control variables through an accidental name collision.
# Make the resolved operator overrides immutable before reading that file;
# Bash will fail closed if it tries to assign one of these names.
readonly APP_DIR ENV_FILE SERVICE_NAME HEALTH_URL PUBLIC_ORIGIN
readonly SYSTEMD_UNIT_PATH NGINX_CONFIG_PATH READINESS_CURL_TIMEOUT_SECONDS READINESS_MAX_RESPONSE_BYTES
readonly RELEASE_DIST_DIR ROLLBACK_RESTORE_DIST_DIR DEPLOY_LOCK_PATH

# Hold this descriptor for the complete script lifetime. `flock --nonblock`
# fails fast instead of queueing a stale release which could deploy an older
# commit after the active release finishes. Opening the root-managed lock file
# does not truncate it and the kernel releases the lease on every exit path.
exec 9>>"$DEPLOY_LOCK_PATH"
if ! flock --nonblock 9; then
  echo "Refusing to deploy: another QY Roam release is already in progress" >&2
  exit 1
fi

cd "$APP_DIR"

echo "[1/11] Checking production runtime"
# Keep the build and systemd runtime on the same supported Node release line.
# npm's engines field is advisory by default, so enforce it before touching
# source or dependencies; otherwise an obsolete VPS runtime can appear to
# deploy successfully and fail only when checkout first reaches Supabase.
node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$node_major" -ne 22 ]]; then
  echo "Refusing to deploy: Node.js 22.x is required (found $(node --version))" >&2
  exit 1
fi

echo "[2/11] Updating source"
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Refusing to deploy: production checkout must already be on main" >&2
  exit 1
fi
# `git diff` does not report untracked files. Next.js discovers routes and
# configuration from the worktree, so an untracked source file could otherwise
# be compiled into the production artifact even though the deploy claimed to
# use the reviewed commit. Ignore only files covered by the repository's
# ignore rules (such as `.next` and `node_modules`); every other worktree entry
# must be committed or removed before a release.
if [[ -n "$(git status --porcelain=v1 --untracked-files=normal)" ]]; then
  echo "Refusing to deploy: production checkout has tracked or untracked local changes" >&2
  exit 1
fi
git fetch --prune origin
git pull --ff-only origin main

echo "[3/11] Checking environment file"
# This script runs as root and later sources this file as shell input. A
# symlink or a file controlled by another account is therefore code execution,
# not merely a configuration mistake. Check the object itself before chmod:
# `-f` follows symlinks, and chmod would otherwise change the target while
# making an unsafe deployment appear repaired.
if [[ ! -f "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  echo "Missing or unsafe environment file: $ENV_FILE must be a regular, non-symlink file" >&2
  exit 1
fi
env_file_owner="$(stat --format='%u' -- "$ENV_FILE")"
if [[ "$env_file_owner" != "0" ]]; then
  echo "Unsafe environment file ownership: $ENV_FILE must be owned by root" >&2
  exit 1
fi
chmod 600 "$ENV_FILE"

echo "[4/11] Installing locked dependencies"
if [[ ! -f package-lock.json ]]; then
  echo "package-lock.json is required for a reproducible production deploy" >&2
  exit 1
fi
npm ci --no-audit --no-fund

# Dependency lifecycle scripts execute before the production artifact is
# compiled. Even with a committed lockfile, a compromised or accidentally
# stateful package script could rewrite application source or add a route that
# was not present in the reviewed commit. Re-establish the clean-worktree
# invariant after installation so only ignored dependency/build directories
# may have changed before pricing, integrity, and compilation checks run.
if [[ -n "$(git status --porcelain=v1 --untracked-files=normal)" ]]; then
  echo "Refusing to deploy: dependency installation modified tracked or untracked repository files" >&2
  exit 1
fi

# Keep the last built standalone artifact recoverable until the replacement
# has passed its live-port readiness check. The isolated smoke test below
# catches application/configuration failures, but it cannot detect a conflict
# or supervision problem that exists only on the production service port. A
# failed restart must therefore restore the previously serving artifact rather
# than leave checkout offline. The snapshot lives outside the repository and
# is removed after a successful release.
rollback_dir="$(mktemp -d /tmp/qyroam-release-rollback.XXXXXX)"
# Snapshot creation happens before the full release-exit handler is installed.
# Arm a narrow cleanup immediately so an interrupted or disk-full copy cannot
# strand a partial production artifact (and consume the space needed by the
# still-serving release). The complete handler below replaces this trap after
# all of its state and functions have been declared.
trap 'rm -rf -- "$rollback_dir"' EXIT
# Bash does not run an EXIT trap for an unhandled terminating signal. Convert
# ordinary operator/service-manager interruptions into explicit shell exits so
# the snapshot cleanup above runs even while `cp` is still in progress. The
# full release handler installed below inherits these signal traps, which also
# means an interruption after artifact promotion follows the same automatic
# rollback path as any other failed cutover. SIGKILL remains intentionally
# outside the script's control.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
previous_artifact_available=0
release_snapshot_cleanup_enabled=1
release_verified=0
cutover_attempted=0
artifact_promotion_started=0
# Automatic rollback may need the authenticated readiness credential after a
# failed cutover. Track its protected curl header file outside the function so
# the process-wide EXIT cleanup can remove it if the rollback is interrupted
# between creation and the normal success/failure cleanup below.
rollback_health_header=""
if [[ -f .next/standalone/server.js ]]; then
  # Never let a partial recursive copy acquire the authoritative rollback
  # name. Stage it beside the final snapshot, validate the restart entrypoint,
  # and promote it with a same-filesystem rename only after the copy is whole.
  # The early EXIT trap above removes either name on every failure.
  cp -a .next "$rollback_dir/previous-next.partial"
  if [[ ! -f "$rollback_dir/previous-next.partial/standalone/server.js" ]]; then
    echo "Previous production artifact snapshot is incomplete" >&2
    exit 1
  fi
  mv "$rollback_dir/previous-next.partial" "$rollback_dir/previous-next"
  previous_artifact_available=1
fi

cleanup_release_snapshot() {
  if [[ -n "$rollback_health_header" ]]; then
    rm -f -- "$rollback_health_header"
    rollback_health_header=""
  fi
  # This directory is never the live service target. Remove a failed or
  # already-promoted staging build without touching the active `.next` tree.
  rm -rf -- "$APP_DIR/$RELEASE_DIST_DIR"
  rm -rf -- "$APP_DIR/$ROLLBACK_RESTORE_DIST_DIR"
  if [[ "$release_snapshot_cleanup_enabled" -eq 1 ]]; then
    rm -rf "$rollback_dir"
  fi
}

restore_previous_artifact() {
  if [[ "$previous_artifact_available" -ne 1 ]]; then
    echo "No previous production artifact is available for automatic rollback." >&2
    return 1
  fi

  echo "Restoring the previous production artifact" >&2
  # Build the complete restore candidate before touching the current service
  # path. This preserves the failed-but-complete release as a fallback when a
  # low-disk or I/O failure prevents copying the known-good snapshot.
  rm -rf -- "$APP_DIR/$ROLLBACK_RESTORE_DIST_DIR"
  if ! cp -a "$rollback_dir/previous-next" "$APP_DIR/$ROLLBACK_RESTORE_DIST_DIR"; then
    release_snapshot_cleanup_enabled=0
    echo "Automatic rollback copy failed; retained recovery snapshot at $rollback_dir/previous-next" >&2
    return 1
  fi
  if [[ -e .next ]] && ! mv .next "$rollback_dir/failed-next"; then
    release_snapshot_cleanup_enabled=0
    echo "Unable to preserve the failed release before rollback; retained recovery snapshot at $rollback_dir/previous-next" >&2
    return 1
  fi
  if ! mv "$APP_DIR/$ROLLBACK_RESTORE_DIST_DIR" .next; then
    # The staged candidate and live path share a filesystem, so this rename is
    # expected to be atomic. If an unexpected filesystem error still occurs,
    # put the complete failed artifact back instead of leaving the service
    # path absent while retaining both recovery copies for an operator.
    release_snapshot_cleanup_enabled=0
    if [[ ! -e .next && -e "$rollback_dir/failed-next" ]]; then
      mv "$rollback_dir/failed-next" .next || true
    fi
    echo "Automatic rollback promotion failed; retained recovery snapshot at $rollback_dir/previous-next" >&2
    return 1
  fi
  # Before cutover the old process is still serving from memory. Restore its
  # on-disk artifact without an unnecessary interruption. Once a restart has
  # been attempted, restart the restored artifact so the live port cannot be
  # left on the failed release.
  if [[ "$cutover_attempted" -eq 0 ]]; then
    echo "Previous QY Roam artifact restored; the serving process was not interrupted." >&2
    return 0
  fi
  if ! systemctl restart "$SERVICE_NAME"; then
    release_snapshot_cleanup_enabled=0
    echo "Automatic rollback restart failed; operator intervention is required." >&2
    echo "Recovery snapshot retained at $rollback_dir/previous-next" >&2
    systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
    return 1
  fi

  # A successful systemd restart only confirms that the start request was
  # accepted. The restored process can still fail to bind, boot, or satisfy
  # the order-critical configuration/schema boundary. Do not discard the
  # recovery snapshot or report a successful rollback until the old artifact
  # is actually serving the same authenticated readiness contract used for
  # release verification.
  rollback_health_header="$(mktemp /tmp/qyroam-rollback-health.XXXXXX.header)"
  chmod 600 "$rollback_health_header"
  printf 'Authorization: Bearer %s\n' "${health_check_token:-}" > "$rollback_health_header"
  local rollback_ready=0
  local attempt
  for attempt in {1..15}; do
    if curl --header "@$rollback_health_header" --fail --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS" --max-filesize "$READINESS_MAX_RESPONSE_BYTES" "$HEALTH_URL" |
       node scripts/validate-sales-readiness.mjs; then
      rollback_ready=1
      break
    fi
    sleep 2
  done
  rm -f -- "$rollback_health_header"
  rollback_health_header=""
  if [[ "$rollback_ready" -eq 1 ]]; then
    echo "Previous QY Roam artifact restored, restarted, and sales-ready." >&2
    return 0
  fi

  release_snapshot_cleanup_enabled=0
  echo "Automatic rollback did not become sales-ready; operator intervention is required." >&2
  echo "Recovery snapshot retained at $rollback_dir/previous-next" >&2
  systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
  journalctl -u "$SERVICE_NAME" -n 50 --no-pager >&2 || true
  return 1
}

handle_release_exit() {
  local status="$1"
  # Disarm every release trap before cleanup/rollback. A second signal should
  # never recursively enter this handler and race artifact restoration. Keep
  # a narrow interrupt handler active, however: rollback readiness writes the
  # bearer credential to a protected temporary file, and an operator abort at
  # that point must remove it before terminating. The recovery snapshot is
  # deliberately retained because the artifact transition may be incomplete.
  trap - EXIT HUP INT TERM
  handle_release_interrupt() {
    local signal_status="$1"
    trap - EXIT HUP INT TERM
    if [[ -n "$rollback_health_header" ]]; then
      rm -f -- "$rollback_health_header"
      rollback_health_header=""
    fi
    release_snapshot_cleanup_enabled=0
    echo "Release recovery interrupted; retained recovery artifacts for operator reconciliation." >&2
    exit "$signal_status"
  }
  trap 'handle_release_interrupt 129' HUP
  trap 'handle_release_interrupt 130' INT
  trap 'handle_release_interrupt 143' TERM
  if [[ "$status" -ne 0 && "$release_verified" -ne 1 && "$artifact_promotion_started" -eq 1 && "$previous_artifact_available" -eq 1 ]]; then
    restore_previous_artifact || true
  fi
  cleanup_release_snapshot
  exit "$status"
}

# From this point onward a failure must clean up its isolated build. The live
# artifact remains untouched until the explicit promotion boundary below, so
# preflight and smoke-test failures do not disturb the serving process.
trap 'handle_release_exit "$?"' EXIT

echo "[5/11] Building"
set -a
# Do not allow an operator's inherited `bash -x`/SHELLOPTS state to copy live
# Stripe, Supabase, SMTP or admin credentials into the terminal or deployment
# journal. Keep tracing disabled after the source as subsequent assignments and
# readiness setup also handle values derived from this protected file.
set +x
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
health_check_token="${HEALTH_CHECK_TOKEN:-}"
if ! node -e "const token=process.env.HEALTH_CHECK_TOKEN||'';if(token.length<24||token.length>1024||!/^[\\x21-\\x7e]+$/.test(token))process.exit(1)"; then
  echo "HEALTH_CHECK_TOKEN must be 24-1024 visible non-space ASCII characters" >&2
  exit 1
fi
npm run check:esim-pricing
npm run check:wifi-pricing
npm run check:operations-schema
npm run check:deploy-safety
npm run test:order-integrity
QY_ROAM_DIST_DIR="$RELEASE_DIST_DIR" npm run build

# Release checks and the Next.js build execute repository-owned JavaScript
# with the same write access as deployment. Re-establish source provenance
# after all of that code has run, not only after npm lifecycle scripts: a
# broken check/build hook must not be able to rewrite a route (or add an
# untracked one), compile that mutation into the candidate, and still reach
# the production cutover. Build output remains ignored by Git, so the isolated
# `.next-release` artifact itself does not make a healthy checkout dirty.
if [[ -n "$(git status --porcelain=v1 --untracked-files=normal)" ]]; then
  echo "Refusing to deploy: release checks or build modified tracked or untracked repository files" >&2
  exit 1
fi

# Response headers are part of the customer-order boundary, not merely static
# configuration. Verify the exact built server and, after cutover, the public
# TLS ingress both preserve them. In particular, /success and /booking carry a
# Stripe Checkout Session id in their query string and must remain private,
# non-cacheable and unable to pass that capability in a referrer.
verify_customer_response_headers() {
  local base_url="$1"
  shift
  local response_headers
  response_headers="$(mktemp /tmp/qyroam-response-headers.XXXXXX)"

  if ! "$@" --dump-header "$response_headers" --output /dev/null "$base_url/"; then
    rm -f "$response_headers"
    return 1
  fi
  if ! grep -Eiq '^content-security-policy:.*frame-ancestors[^;]*none' "$response_headers" ||
     grep -Eiq '^content-security-policy:.*unsafe-eval' "$response_headers" ||
     ! grep -Eiq '^x-frame-options:[[:space:]]*DENY[[:space:]]*$' "$response_headers" ||
     ! grep -Eiq '^x-content-type-options:[[:space:]]*nosniff[[:space:]]*$' "$response_headers" ||
     ! grep -Eiq '^strict-transport-security:.*max-age=31536000.*includeSubDomains' "$response_headers" ||
     ! grep -Eiq '^referrer-policy:[[:space:]]*strict-origin-when-cross-origin[[:space:]]*$' "$response_headers" ||
     ! grep -Eiq '^cross-origin-opener-policy:[[:space:]]*same-origin[[:space:]]*$' "$response_headers" ||
     ! grep -Eiq '^permissions-policy:.*camera=\(\).*microphone=\(\).*geolocation=\(\)' "$response_headers"; then
    rm -f "$response_headers"
    return 1
  fi

  # API responses expose live order/configuration state and must never become
  # a shared-cache or crawler surface. Use dependency-free public liveness.
  : > "$response_headers"
  if ! "$@" --dump-header "$response_headers" --output /dev/null "$base_url/api/health" ||
     ! grep -Eiq '^cache-control:.*no-store' "$response_headers" ||
     ! grep -Eiq '^x-robots-tag:.*noindex' "$response_headers"; then
    rm -f "$response_headers"
    return 1
  fi

  local private_path
  for private_path in /success /booking; do
    : > "$response_headers"
    # Header verification must remain a local ingress check. A syntactically
    # valid `cs_test_...` value crosses the page's Stripe lookup boundary when
    # production credentials are configured, making both the isolated smoke
    # boot and the live post-cutover check depend on an unnecessary provider
    # request. Keep a query parameter here so the capability-bearing URL shape
    # is exercised, but deliberately fail the bounded Session-id parser before
    # either page can acquire confirmation capacity or call Stripe/Supabase.
    if ! "$@" --dump-header "$response_headers" --output /dev/null "${base_url}${private_path}?session_id=release-header-probe" ||
       ! grep -Eiq '^cache-control:.*no-store' "$response_headers" ||
       ! grep -Eiq '^cache-control:.*private' "$response_headers" ||
       ! grep -Eiq '^x-robots-tag:.*noindex' "$response_headers" ||
       ! grep -Eiq '^referrer-policy:[[:space:]]*no-referrer[[:space:]]*$' "$response_headers"; then
      rm -f "$response_headers"
      return 1
    fi
  done

  rm -f "$response_headers"
}

# A healthy page render does not prove that Nginx and the standalone runtime
# preserve the public mutation contract used by each sales form. Exercise a
# deliberately invalid, side-effect-free request against both product routes:
# it must reach the application, be rejected before configuration, pricing,
# Stripe or Supabase work, and retain the privacy/cache boundary required for
# every checkout response. This also catches proxy drift that blocks POST,
# buffers/replaces JSON errors, or routes either checkout API somewhere other
# than the smoke-tested application.
verify_checkout_ingress() {
  local base_url="$1"
  shift
  local checkout_path response_headers response_body status
  response_headers="$(mktemp /tmp/qyroam-checkout-headers.XXXXXX)"
  response_body="$(mktemp /tmp/qyroam-checkout-body.XXXXXX)"

  for checkout_path in /api/checkout /api/esim-checkout; do
    : > "$response_headers"
    : > "$response_body"
    status="$("$@" --request POST \
      --header 'Content-Type: text/plain' \
      --data 'qy-roam-release-probe' \
      --dump-header "$response_headers" \
      --output "$response_body" \
      --max-filesize "$READINESS_MAX_RESPONSE_BYTES" \
      --write-out '%{http_code}' \
      "${base_url}${checkout_path}")" || {
        rm -f "$response_headers" "$response_body"
        return 1
      }

    if [[ "$status" != "415" ]] ||
       ! grep -Eiq '^content-type:[[:space:]]*application/json([[:space:]]*;|[[:space:]]*$)' "$response_headers" ||
       ! grep -Eiq '^cache-control:.*no-store' "$response_headers" ||
       ! grep -Eiq '^x-robots-tag:.*noindex' "$response_headers" ||
       ! node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(value?.error!=='Expected JSON request.')process.exit(1)" "$response_body"; then
      rm -f "$response_headers" "$response_body"
      return 1
    fi
  done

  rm -f "$response_headers" "$response_body"
}

# Pocket WiFi's first customer-visible quote depends on these public read APIs.
# Readiness proves their dependencies, but not that the built routes and public
# proxy preserve their JSON/cache contracts. The availability probe is
# deliberately invalid so it returns before Stripe or Supabase work.
verify_pocket_wifi_sales_api_ingress() {
  local base_url="$1"
  shift
  local response_headers response_body status
  response_headers="$(mktemp /tmp/qyroam-sales-api-headers.XXXXXX)"
  response_body="$(mktemp /tmp/qyroam-sales-api-body.XXXXXX)"

  status="$("$@" --dump-header "$response_headers" --output "$response_body" \
    --max-filesize "$READINESS_MAX_RESPONSE_BYTES" \
    --write-out '%{http_code}' "$base_url/api/booking-terms")" || {
      rm -f "$response_headers" "$response_body"
      return 1
    }
  if [[ "$status" != "200" ]] ||
     ! grep -Eiq '^content-type:[[:space:]]*application/json([[:space:]]*;|[[:space:]]*$)' "$response_headers" ||
     ! grep -Eiq '^cache-control:.*no-store' "$response_headers" ||
     ! grep -Eiq '^x-robots-tag:.*noindex' "$response_headers" ||
     ! node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!Number.isSafeInteger(value?.minDeliveryLeadDays)||value.minDeliveryLeadDays<0||typeof value?.courierFeeSgd!=='number'||!Number.isFinite(value.courierFeeSgd)||value.courierFeeSgd<0)process.exit(1)" "$response_body"; then
    rm -f "$response_headers" "$response_body"
    return 1
  fi

  : > "$response_headers"
  : > "$response_body"
  status="$("$@" --dump-header "$response_headers" --output "$response_body" \
    --max-filesize "$READINESS_MAX_RESPONSE_BYTES" \
    --write-out '%{http_code}' \
    "$base_url/api/availability?start=2026-01-01&start=2026-01-02&end=2026-01-03")" || {
      rm -f "$response_headers" "$response_body"
      return 1
    }
  if [[ "$status" != "400" ]] ||
     ! grep -Eiq '^content-type:[[:space:]]*application/json([[:space:]]*;|[[:space:]]*$)' "$response_headers" ||
     ! grep -Eiq '^cache-control:.*no-store' "$response_headers" ||
     ! grep -Eiq '^x-robots-tag:.*noindex' "$response_headers" ||
     ! node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(value?.available!==false||value?.error!=='Valid start and end dates are required.')process.exit(1)" "$response_body"; then
    rm -f "$response_headers" "$response_body"
    return 1
  fi

  rm -f "$response_headers" "$response_body"
}

# Readiness proves that webhook secrets are configured, but not that Stripe's
# POST routes exist in the standalone artifact or survive the public proxy.
# Probe both the canonical endpoint and its migration alias with inert,
# unsigned JSON. Rejection must happen at signature verification, before any
# event parsing, durable claim, provider read, or order side effect.
verify_webhook_ingress() {
  local base_url="$1"
  shift
  local webhook_path response_headers response_body status
  response_headers="$(mktemp /tmp/qyroam-webhook-headers.XXXXXX)"
  response_body="$(mktemp /tmp/qyroam-webhook-body.XXXXXX)"

  for webhook_path in /api/stripe/webhook /api/stripe-webhook; do
    : > "$response_headers"
    : > "$response_body"
    status="$("$@" --request POST \
      --header 'Content-Type: application/json' \
      --data '{}' \
      --dump-header "$response_headers" \
      --output "$response_body" \
      --max-filesize "$READINESS_MAX_RESPONSE_BYTES" \
      --write-out '%{http_code}' \
      "${base_url}${webhook_path}")" || {
        rm -f "$response_headers" "$response_body"
        return 1
      }

    if [[ "$status" != "400" ]] ||
       ! grep -Eiq '^content-type:[[:space:]]*application/json([[:space:]]*;|[[:space:]]*$)' "$response_headers" ||
       ! grep -Eiq '^cache-control:.*no-store' "$response_headers" ||
       ! grep -Eiq '^x-robots-tag:.*noindex' "$response_headers" ||
       ! node -e "const fs=require('fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(value?.error!=='Invalid signature')process.exit(1)" "$response_body"; then
      rm -f "$response_headers" "$response_body"
      return 1
    fi
  done

  rm -f "$response_headers" "$response_body"
}

# Readiness proves that strong admin credentials are configured, but it does
# not prove that the built middleware still protects the operations pages (or
# that the public proxy preserves its authentication challenge). Exercise the
# dashboard without credentials and require the exact fail-closed boundary.
# This request is read-only and deliberately never submits operator secrets.
verify_admin_ingress() {
  local base_url="$1"
  shift
  local response_headers response_body status
  response_headers="$(mktemp /tmp/qyroam-admin-headers.XXXXXX)"
  response_body="$(mktemp /tmp/qyroam-admin-body.XXXXXX)"

  status="$("$@" \
    --dump-header "$response_headers" \
    --output "$response_body" \
    --max-filesize "$READINESS_MAX_RESPONSE_BYTES" \
    --write-out '%{http_code}' \
    "$base_url/admin")" || {
      rm -f "$response_headers" "$response_body"
      return 1
    }

  if [[ "$status" != "401" ]] ||
     ! grep -Eiq '^www-authenticate:[[:space:]]*Basic realm="QY Roam Admin"[[:space:]]*$' "$response_headers" ||
     ! grep -Eiq '^cache-control:.*no-store' "$response_headers" ||
     grep -Eiq '^cache-control:.*(public|s-maxage)' "$response_headers"; then
    rm -f "$response_headers" "$response_body"
    return 1
  fi

  rm -f "$response_headers" "$response_body"
}

# QY Roam has no Server Actions. Exercise the capability header against both
# the standalone artifact and public TLS ingress so an application matcher or
# installed Nginx drift cannot silently expose the unused action parser.
verify_server_action_rejection() {
  local base_url="$1"
  shift
  local status
  status="$("$@" --request POST \
    --header 'Content-Type: text/plain' \
    --header 'Next-Action: qyroam-release-probe' \
    --data 'unsupported' \
    --output /dev/null \
    --write-out '%{http_code}' \
    "$base_url/")" || return 1
  [[ "$status" == "403" ]]
}

echo "[6/11] Smoke-testing the production artifact"
# A successful compilation does not prove that the standalone server can boot
# or accept an order with the deployed runtime configuration. Test the exact
# production entrypoint on an isolated loopback port before replacing the
# currently healthy service. The authenticated health boundary includes the
# deployed database/order contracts, so a partial migration or missing
# order-critical configuration fails before—not after—the live restart.
smoke_port="${SMOKE_PORT:-3199}"
if [[ ! "$smoke_port" =~ ^[0-9]+$ ]] || (( smoke_port < 1024 || smoke_port > 65535 )); then
  echo "SMOKE_PORT must be an integer between 1024 and 65535" >&2
  exit 1
fi
smoke_log="$(mktemp /tmp/qyroam-smoke.XXXXXX.log)"
smoke_health_header="$(mktemp /tmp/qyroam-smoke-health.XXXXXX.header)"
chmod 600 "$smoke_log" "$smoke_health_header"
printf 'Authorization: Bearer %s\n' "$health_check_token" > "$smoke_health_header"
smoke_pid=""
cleanup_smoke() {
  if [[ -n "$smoke_pid" ]] && kill -0 "$smoke_pid" 2>/dev/null; then
    kill "$smoke_pid" 2>/dev/null || true
    wait "$smoke_pid" 2>/dev/null || true
  fi
  rm -f "$smoke_log" "$smoke_health_header"
}
trap 'status=$?; cleanup_smoke; handle_release_exit "$status"' EXIT
HOSTNAME=127.0.0.1 PORT="$smoke_port" node "$RELEASE_DIST_DIR/standalone/server.js" >"$smoke_log" 2>&1 &
smoke_pid=$!
smoke_ready=0
for attempt in {1..15}; do
  if ! kill -0 "$smoke_pid" 2>/dev/null; then
    break
  fi
  if curl --header "@$smoke_health_header" --fail --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS" --max-filesize "$READINESS_MAX_RESPONSE_BYTES" "http://127.0.0.1:${smoke_port}/api/health" |
     node scripts/validate-sales-readiness.mjs; then
    smoke_ready=1
    break
  fi
  sleep 1
done
if [[ "$smoke_ready" -ne 1 ]] || ! kill -0 "$smoke_pid" 2>/dev/null; then
  echo "Built QY Roam artifact failed its isolated startup smoke test" >&2
  tail -n 50 "$smoke_log" >&2 || true
  exit 1
fi
# Readiness exercises the server path, but a standalone Next artifact can boot
# without the separately packaged browser chunks. Exercise both public sales
# entry points and fetch every static asset they advertise before replacing the
# live process. Checking only one home-page chunk can miss a route-specific
# eSIM bundle (or a later Pocket WiFi split chunk) that was omitted while the
# health API and shared framework runtime remain healthy.
verify_sales_page_assets() {
  local page_path="$1"
  local page_assets response_headers static_asset asset_path downloaded_bytes
  response_headers="$(mktemp /tmp/qyroam-static-headers.XXXXXX)"
  page_assets="$(
    curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${smoke_port}${page_path}" |
      node -e "let body='';process.stdin.on('data',chunk=>body+=chunk).on('end',()=>{const assets=[...body.matchAll(/(?:src|href)=\"(\/_next\/static\/[^\"?#]+(?:[?#][^\"]*)?)\"/g)].map(match=>match[1]);const unique=[...new Set(assets)];if(!unique.length||!unique.some(asset=>asset.split(/[?#]/,1)[0].endsWith('.js')))process.exit(1);process.stdout.write(unique.join('\\n'))})"
  )" || { rm -f "$response_headers"; return 1; }
  while IFS= read -r static_asset; do
    [[ "$static_asset" == /_next/static/* ]] || { rm -f "$response_headers"; return 1; }
    : > "$response_headers"
    downloaded_bytes="$(curl --fail --silent --show-error --output /dev/null --max-time 10 \
      --dump-header "$response_headers" --write-out '%{size_download}' \
      "http://127.0.0.1:${smoke_port}${static_asset}")" || { rm -f "$response_headers"; return 1; }
    asset_path="${static_asset%%[?#]*}"
    if [[ ! "$downloaded_bytes" =~ ^[0-9]+$ ]] || (( downloaded_bytes < 1 )); then
      rm -f "$response_headers"
      return 1
    fi
    case "$asset_path" in
      *.js)
        grep -Eiq '^content-type:[[:space:]]*(application|text)/javascript([[:space:]]*;|[[:space:]]*$)' "$response_headers" || { rm -f "$response_headers"; return 1; }
        ;;
      *.css)
        grep -Eiq '^content-type:[[:space:]]*text/css([[:space:]]*;|[[:space:]]*$)' "$response_headers" || { rm -f "$response_headers"; return 1; }
        ;;
      *)
        # Future Next.js releases may advertise fonts or other static assets.
        # They still need an explicit non-HTML representation: a proxy SPA
        # fallback returning the sales page with HTTP 200 is not a usable
        # browser asset and must not approve this release.
        grep -Eiq '^content-type:' "$response_headers" || { rm -f "$response_headers"; return 1; }
        grep -Eiq '^content-type:[[:space:]]*text/html' "$response_headers" && { rm -f "$response_headers"; return 1; }
        ;;
    esac
  done <<< "$page_assets"
  rm -f "$response_headers"
}

for sales_page in / /esim; do
  if ! verify_sales_page_assets "$sales_page"; then
    echo "Built QY Roam artifact has an unavailable sales page or browser asset: $sales_page" >&2
    exit 1
  fi
done
if ! verify_customer_response_headers "http://127.0.0.1:${smoke_port}" curl --fail --silent --show-error --max-time 10; then
  echo "Built QY Roam artifact is missing required customer security or privacy headers" >&2
  exit 1
fi
if ! verify_checkout_ingress "http://127.0.0.1:${smoke_port}" curl --silent --show-error --max-time 10; then
  echo "Built QY Roam artifact does not preserve the checkout mutation contract" >&2
  exit 1
fi
if ! verify_pocket_wifi_sales_api_ingress "http://127.0.0.1:${smoke_port}" curl --silent --show-error --max-time 10; then
  echo "Built QY Roam artifact does not preserve the Pocket WiFi sales API contract" >&2
  exit 1
fi
if ! verify_webhook_ingress "http://127.0.0.1:${smoke_port}" curl --silent --show-error --max-time 10; then
  echo "Built QY Roam artifact does not preserve the Stripe webhook ingress contract" >&2
  exit 1
fi
if ! verify_admin_ingress "http://127.0.0.1:${smoke_port}" curl --silent --show-error --max-time 10; then
  echo "Built QY Roam artifact does not preserve the protected admin ingress contract" >&2
  exit 1
fi
if ! verify_server_action_rejection "http://127.0.0.1:${smoke_port}" curl --silent --show-error --max-time 10; then
  echo "Built QY Roam artifact accepts unsupported Server Action traffic" >&2
  exit 1
fi
cleanup_smoke
smoke_pid=""
trap 'handle_release_exit "$?"' EXIT

echo "[7/11] Verifying service definition"
# `daemon-reload` only rereads the installed unit; it does not copy the
# checked-in definition into /etc. Refuse a release if the installed unit has
# drifted, so loopback binding, restart policy, and sandboxing changes cannot
# sit in the worktree while an older service definition keeps serving checkout.
# The reviewed unit also supervises the Node server directly so SIGTERM begins
# graceful request draining immediately rather than stopping an npm wrapper
# and leaving its child to retain the production port until the hard timeout.
# Deliberately do not overwrite /etc here: service-local operator changes need
# an explicit reviewed install before they become part of a paid-order release.
if [[ ! -f "$SYSTEMD_UNIT_PATH" ]] || ! cmp -s deploy/qy-roam.service "$SYSTEMD_UNIT_PATH"; then
  echo "Installed systemd unit does not match deploy/qy-roam.service: $SYSTEMD_UNIT_PATH" >&2
  echo "Review and install the checked-in unit, then rerun deployment." >&2
  exit 1
fi

echo "[8/11] Verifying Nginx ingress definition"
# The app trusts X-Real-IP only because the checked-in Nginx configuration
# overwrites it while proxying to a loopback-only listener.  A drifted proxy
# can therefore weaken checkout rate limiting/CAPI attribution or expose the
# app directly without its TLS and request-size boundaries.  As with the
# systemd unit above, do not overwrite an operator-managed file here: require
# an explicit reviewed install before a paid-order release can proceed.
if [[ ! -f "$NGINX_CONFIG_PATH" ]] || ! cmp -s deploy/nginx-qyroam.conf "$NGINX_CONFIG_PATH"; then
  echo "Installed Nginx site does not match deploy/nginx-qyroam.conf: $NGINX_CONFIG_PATH" >&2
  echo "Review and install the checked-in Nginx site, then rerun deployment." >&2
  exit 1
fi
if ! nginx -t; then
  echo "Nginx configuration validation failed" >&2
  exit 1
fi

echo "[9/11] Reloading service definition"
if ! systemctl daemon-reload; then
  echo "Unable to reload the systemd service definition" >&2
  systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
  exit 1
fi

# A byte-for-byte FragmentPath check above does not cover systemd drop-ins.
# An operator override can replace ExecStart, remove loopback binding, weaken
# the sandbox, or change shutdown/restart behaviour while the installed main
# unit still matches this repository. Refuse cutover unless systemd confirms
# that the reviewed file is the effective fragment and no drop-in is active.
# This check belongs after daemon-reload so it inspects the definition that the
# immediately following restart would actually use.
effective_fragment="$(systemctl show "$SERVICE_NAME" --property=FragmentPath --value)"
effective_drop_ins="$(systemctl show "$SERVICE_NAME" --property=DropInPaths --value)"
if [[ "$effective_fragment" != "$SYSTEMD_UNIT_PATH" ]]; then
  echo "Effective systemd unit is not the reviewed service definition: ${effective_fragment:-missing}" >&2
  exit 1
fi
if [[ -n "$effective_drop_ins" ]]; then
  echo "Refusing to deploy with unreviewed systemd drop-ins: $effective_drop_ins" >&2
  exit 1
fi

echo "[10/11] Restarting service"
# Promote only the artifact that passed the isolated readiness, asset, and
# response-header checks. Renaming within the checkout filesystem prevents the
# live process from observing Next's incremental build output; the old tree
# stays available both in memory and in the protected rollback snapshot until
# the replacement is verified through public TLS.
artifact_promotion_started=1
if [[ -e .next ]]; then
  mv .next "$rollback_dir/replaced-live-next"
fi
if ! mv "$RELEASE_DIST_DIR" .next; then
  echo "Unable to promote the smoke-tested QY Roam artifact" >&2
  exit 1
fi
cutover_attempted=1
if ! systemctl restart "$SERVICE_NAME"; then
  echo "QY Roam service restart failed" >&2
  systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
  journalctl -u "$SERVICE_NAME" -n 50 --no-pager >&2 || true
  exit 1
fi
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,15p'

echo "[11/11] Waiting for application readiness"
health_output="$(mktemp /tmp/qyroam-health.XXXXXX.json)"
health_header="$(mktemp /tmp/qyroam-health.XXXXXX.header)"
trap 'status=$?; rm -f "$health_output" "$health_header"; handle_release_exit "$status"' EXIT
chmod 600 "$health_output" "$health_header"
printf 'Authorization: Bearer %s\n' "$health_check_token" > "$health_header"
ready=0
for attempt in {1..15}; do
  if curl --header "@$health_header" --fail --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS" --max-filesize "$READINESS_MAX_RESPONSE_BYTES" "$HEALTH_URL" > "$health_output" &&
     node scripts/validate-sales-readiness.mjs "$health_output"; then
    ready=1
    break
  fi
  echo "Health check attempt $attempt/15 not ready yet"
  sleep 2
done
if [[ "$ready" -ne 1 ]]; then
  echo "QY Roam did not become launch-ready after restart" >&2
  if [[ -s "$health_output" ]]; then
    echo "Last health response:" >&2
    cat "$health_output" >&2
    printf '\n' >&2
  fi
  journalctl -u "$SERVICE_NAME" -n 50 --no-pager >&2 || true
  exit 1
fi
cat "$health_output"
printf '\n'

# Loopback readiness proves that the restarted application and its order
# dependencies are healthy, but customers reach it through the reviewed TLS
# and Nginx boundary. Exercise that exact local ingress without relying on
# public DNS: --resolve keeps the qyroam.com hostname/SNI (and therefore normal
# certificate validation) while routing the request to this VPS. Verify the
# authenticated readiness response and both public sales pages, including all
# browser assets they advertise, before discarding the rollback artifact.
if [[ "$PUBLIC_ORIGIN" != "https://qyroam.com" ]]; then
  echo "PUBLIC_ORIGIN must be the canonical https://qyroam.com origin" >&2
  exit 1
fi
# Ignore any host-level proxy environment for this local assertion; otherwise
# curl can send the request to an outbound proxy and accidentally test a
# different server despite the loopback --resolve entry.
public_curl=(curl --noproxy '*' --resolve qyroam.com:443:127.0.0.1 --fail --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS")
if ! "${public_curl[@]}" --header "@$health_header" --max-filesize "$READINESS_MAX_RESPONSE_BYTES" "$PUBLIC_ORIGIN/api/health" |
   node scripts/validate-sales-readiness.mjs; then
  echo "QY Roam public TLS ingress did not reach the launch-ready service" >&2
  exit 1
fi

verify_public_sales_page_assets() {
  local page_path="$1"
  local page_assets response_headers static_asset asset_path downloaded_bytes
  response_headers="$(mktemp /tmp/qyroam-public-static-headers.XXXXXX)"
  page_assets="$(
    "${public_curl[@]}" "$PUBLIC_ORIGIN${page_path}" |
      node -e "let body='';process.stdin.on('data',chunk=>body+=chunk).on('end',()=>{const assets=[...body.matchAll(/(?:src|href)=\"(\/_next\/static\/[^\"?#]+(?:[?#][^\"]*)?)\"/g)].map(match=>match[1]);const unique=[...new Set(assets)];if(!unique.length||!unique.some(asset=>asset.split(/[?#]/,1)[0].endsWith('.js')))process.exit(1);process.stdout.write(unique.join('\\n'))})"
  )" || { rm -f "$response_headers"; return 1; }
  while IFS= read -r static_asset; do
    [[ "$static_asset" == /_next/static/* ]] || { rm -f "$response_headers"; return 1; }
    : > "$response_headers"
    downloaded_bytes="$("${public_curl[@]}" --output /dev/null \
      --dump-header "$response_headers" --write-out '%{size_download}' \
      "$PUBLIC_ORIGIN${static_asset}")" || { rm -f "$response_headers"; return 1; }
    asset_path="${static_asset%%[?#]*}"
    if [[ ! "$downloaded_bytes" =~ ^[0-9]+$ ]] || (( downloaded_bytes < 1 )); then
      rm -f "$response_headers"
      return 1
    fi
    case "$asset_path" in
      *.js)
        grep -Eiq '^content-type:[[:space:]]*(application|text)/javascript([[:space:]]*;|[[:space:]]*$)' "$response_headers" || { rm -f "$response_headers"; return 1; }
        ;;
      *.css)
        grep -Eiq '^content-type:[[:space:]]*text/css([[:space:]]*;|[[:space:]]*$)' "$response_headers" || { rm -f "$response_headers"; return 1; }
        ;;
      *)
        grep -Eiq '^content-type:' "$response_headers" || { rm -f "$response_headers"; return 1; }
        grep -Eiq '^content-type:[[:space:]]*text/html' "$response_headers" && { rm -f "$response_headers"; return 1; }
        ;;
    esac
  done <<< "$page_assets"
  rm -f "$response_headers"
}

for sales_page in / /esim; do
  if ! verify_public_sales_page_assets "$sales_page"; then
    echo "QY Roam public TLS ingress has an unavailable sales page or browser asset: $sales_page" >&2
    exit 1
  fi
done
if ! verify_customer_response_headers "$PUBLIC_ORIGIN" "${public_curl[@]}"; then
  echo "QY Roam public TLS ingress is missing required customer security or privacy headers" >&2
  exit 1
fi
public_mutation_curl=(curl --noproxy '*' --resolve qyroam.com:443:127.0.0.1 --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS")
if ! verify_checkout_ingress "$PUBLIC_ORIGIN" "${public_mutation_curl[@]}"; then
  echo "QY Roam public TLS ingress does not preserve the checkout mutation contract" >&2
  exit 1
fi
if ! verify_pocket_wifi_sales_api_ingress "$PUBLIC_ORIGIN" "${public_mutation_curl[@]}"; then
  echo "QY Roam public TLS ingress does not preserve the Pocket WiFi sales API contract" >&2
  exit 1
fi
if ! verify_webhook_ingress "$PUBLIC_ORIGIN" "${public_mutation_curl[@]}"; then
  echo "QY Roam public TLS ingress does not preserve the Stripe webhook ingress contract" >&2
  exit 1
fi
if ! verify_admin_ingress "$PUBLIC_ORIGIN" "${public_mutation_curl[@]}"; then
  echo "QY Roam public TLS ingress does not preserve the protected admin ingress contract" >&2
  exit 1
fi
if ! verify_server_action_rejection "$PUBLIC_ORIGIN" "${public_mutation_curl[@]}"; then
  echo "QY Roam public TLS ingress accepts unsupported Server Action traffic" >&2
  exit 1
fi

release_verified=1
cleanup_release_snapshot

echo "Deployment verification complete"
printf 'Deploy completed successfully.\n'
