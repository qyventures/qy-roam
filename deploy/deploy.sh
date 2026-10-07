#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/qy-roam}"
ENV_FILE="${ENV_FILE:-/root/.config/qyroam/.env}"
SERVICE_NAME="${SERVICE_NAME:-qy-roam}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://qyroam.com}"
SYSTEMD_UNIT_PATH="${SYSTEMD_UNIT_PATH:-/etc/systemd/system/${SERVICE_NAME}.service}"
NGINX_CONFIG_PATH="${NGINX_CONFIG_PATH:-/etc/nginx/sites-available/qyroam}"
# Authenticated readiness can legitimately wait for the application's bounded
# database probes. Keep curl's deadline above that application budget so a
# slow-but-healthy probe can return its authoritative result instead of being
# mistaken for a failed release and triggering rollback.
READINESS_CURL_TIMEOUT_SECONDS=12
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
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi
chmod 600 "$ENV_FILE"

echo "[4/11] Installing locked dependencies"
if [[ ! -f package-lock.json ]]; then
  echo "package-lock.json is required for a reproducible production deploy" >&2
  exit 1
fi
npm ci --no-audit --no-fund

# Keep the last built standalone artifact recoverable until the replacement
# has passed its live-port readiness check. The isolated smoke test below
# catches application/configuration failures, but it cannot detect a conflict
# or supervision problem that exists only on the production service port. A
# failed restart must therefore restore the previously serving artifact rather
# than leave checkout offline. The snapshot lives outside the repository and
# is removed after a successful release.
rollback_dir="$(mktemp -d /tmp/qyroam-release-rollback.XXXXXX)"
previous_artifact_available=0
release_snapshot_cleanup_enabled=1
release_verified=0
cutover_attempted=0
artifact_promotion_started=0
if [[ -f .next/standalone/server.js ]]; then
  cp -a .next "$rollback_dir/previous-next"
  previous_artifact_available=1
fi

cleanup_release_snapshot() {
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
  local rollback_health_header
  rollback_health_header="$(mktemp /tmp/qyroam-rollback-health.XXXXXX.header)"
  chmod 600 "$rollback_health_header"
  printf 'Authorization: Bearer %s\n' "${health_check_token:-}" > "$rollback_health_header"
  local rollback_ready=0
  local attempt
  for attempt in {1..15}; do
    if curl --header "@$rollback_health_header" --fail --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS" "$HEALTH_URL" |
       node -e "let body='';process.stdin.on('data',chunk=>body+=chunk).on('end',()=>{const result=JSON.parse(body);if(result.launchReady!==true||result.service!=='qy-roam')process.exit(1)})"; then
      rollback_ready=1
      break
    fi
    sleep 2
  done
  rm -f "$rollback_health_header"
  if [[ "$rollback_ready" -eq 1 ]]; then
    echo "Previous QY Roam artifact restored, restarted, and launch-ready." >&2
    return 0
  fi

  release_snapshot_cleanup_enabled=0
  echo "Automatic rollback did not become launch-ready; operator intervention is required." >&2
  echo "Recovery snapshot retained at $rollback_dir/previous-next" >&2
  systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
  journalctl -u "$SERVICE_NAME" -n 50 --no-pager >&2 || true
  return 1
}

handle_release_exit() {
  local status="$1"
  trap - EXIT
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
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
health_check_token="${HEALTH_CHECK_TOKEN:-}"
if ! node -e "const token=process.env.HEALTH_CHECK_TOKEN||'';if(token.length<24||token.length>1024||!/^[\\x20-\\x7e]+$/.test(token))process.exit(1)"; then
  echo "HEALTH_CHECK_TOKEN must be 24-1024 printable ASCII characters" >&2
  exit 1
fi
npm run check:esim-pricing
npm run check:wifi-pricing
npm run check:operations-schema
npm run check:deploy-safety
npm run test:order-integrity
QY_ROAM_DIST_DIR="$RELEASE_DIST_DIR" npm run build

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
    if ! "$@" --dump-header "$response_headers" --output /dev/null "${base_url}${private_path}?session_id=cs_test_release_header_probe" ||
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
  if curl --header "@$smoke_health_header" --fail --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS" "http://127.0.0.1:${smoke_port}/api/health" |
     node -e "let body='';process.stdin.on('data',chunk=>body+=chunk).on('end',()=>{const result=JSON.parse(body);if(result.launchReady!==true||result.salesReady!==true||result.service!=='qy-roam')process.exit(1)})"; then
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
  local page_assets
  page_assets="$(
    curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${smoke_port}${page_path}" |
      node -e "let body='';process.stdin.on('data',chunk=>body+=chunk).on('end',()=>{const assets=[...body.matchAll(/(?:src|href)=\"(\/_next\/static\/[^\"?#]+(?:[?#][^\"]*)?)\"/g)].map(match=>match[1]);const unique=[...new Set(assets)];if(!unique.length||!unique.some(asset=>asset.split(/[?#]/,1)[0].endsWith('.js')))process.exit(1);process.stdout.write(unique.join('\\n'))})"
  )" || return 1
  while IFS= read -r static_asset; do
    [[ "$static_asset" == /_next/static/* ]] || return 1
    curl --fail --silent --show-error --output /dev/null --max-time 10 \
      "http://127.0.0.1:${smoke_port}${static_asset}" || return 1
  done <<< "$page_assets"
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
  if curl --header "@$health_header" --fail --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS" "$HEALTH_URL" > "$health_output" &&
     node -e "const fs=require('fs');const result=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(result.launchReady!==true||result.salesReady!==true||result.service!=='qy-roam')process.exit(1)" "$health_output"; then
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
if ! "${public_curl[@]}" --header "@$health_header" "$PUBLIC_ORIGIN/api/health" |
   node -e "let body='';process.stdin.on('data',chunk=>body+=chunk).on('end',()=>{const result=JSON.parse(body);if(result.launchReady!==true||result.salesReady!==true||result.service!=='qy-roam')process.exit(1)})"; then
  echo "QY Roam public TLS ingress did not reach the launch-ready service" >&2
  exit 1
fi

verify_public_sales_page_assets() {
  local page_path="$1"
  local page_assets
  page_assets="$(
    "${public_curl[@]}" "$PUBLIC_ORIGIN${page_path}" |
      node -e "let body='';process.stdin.on('data',chunk=>body+=chunk).on('end',()=>{const assets=[...body.matchAll(/(?:src|href)=\"(\/_next\/static\/[^\"?#]+(?:[?#][^\"]*)?)\"/g)].map(match=>match[1]);const unique=[...new Set(assets)];if(!unique.length||!unique.some(asset=>asset.split(/[?#]/,1)[0].endsWith('.js')))process.exit(1);process.stdout.write(unique.join('\\n'))})"
  )" || return 1
  while IFS= read -r static_asset; do
    [[ "$static_asset" == /_next/static/* ]] || return 1
    "${public_curl[@]}" --output /dev/null "$PUBLIC_ORIGIN${static_asset}" || return 1
  done <<< "$page_assets"
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

release_verified=1
cleanup_release_snapshot

echo "Deployment verification complete"
printf 'Deploy completed successfully.\n'
