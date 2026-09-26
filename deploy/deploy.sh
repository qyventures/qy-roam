#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/qy-roam}"
ENV_FILE="${ENV_FILE:-/root/.config/qyroam/.env}"
SERVICE_NAME="${SERVICE_NAME:-qy-roam}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"
SYSTEMD_UNIT_PATH="${SYSTEMD_UNIT_PATH:-/etc/systemd/system/${SERVICE_NAME}.service}"
NGINX_CONFIG_PATH="${NGINX_CONFIG_PATH:-/etc/nginx/sites-available/qyroam}"
# Authenticated readiness can legitimately wait for the application's bounded
# database probes. Keep curl's deadline above that application budget so a
# slow-but-healthy probe can return its authoritative result instead of being
# mistaken for a failed release and triggering rollback.
READINESS_CURL_TIMEOUT_SECONDS=12

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
if [[ -f .next/standalone/server.js ]]; then
  cp -a .next "$rollback_dir/previous-next"
  previous_artifact_available=1
fi

cleanup_release_snapshot() {
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
  if [[ -e .next ]]; then
    mv .next "$rollback_dir/failed-next"
  fi
  if ! cp -a "$rollback_dir/previous-next" .next; then
    # Keep the known-good snapshot outside the worktree when storage or
    # permissions prevent restoration. If possible, put the failed artifact
    # back so the service path is not left absent while an operator responds.
    release_snapshot_cleanup_enabled=0
    if [[ ! -e .next && -e "$rollback_dir/failed-next" ]]; then
      mv "$rollback_dir/failed-next" .next || true
    fi
    echo "Automatic rollback copy failed; retained recovery snapshot at $rollback_dir/previous-next" >&2
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
  local rollback_health_config
  rollback_health_config="$(mktemp /tmp/qyroam-rollback-curl.XXXXXX.conf)"
  chmod 600 "$rollback_health_config"
  printf 'header = "Authorization: Bearer %s"\n' "${health_check_token:-}" > "$rollback_health_config"
  local rollback_ready=0
  local attempt
  for attempt in {1..15}; do
    if curl --config "$rollback_health_config" --fail --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS" "$HEALTH_URL" |
       node -e "let body='';process.stdin.on('data',chunk=>body+=chunk).on('end',()=>{const result=JSON.parse(body);if(result.launchReady!==true||result.service!=='qy-roam')process.exit(1)})"; then
      rollback_ready=1
      break
    fi
    sleep 2
  done
  rm -f "$rollback_health_config"
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
  if [[ "$status" -ne 0 && "$release_verified" -ne 1 && "$previous_artifact_available" -eq 1 ]]; then
    restore_previous_artifact || true
  fi
  cleanup_release_snapshot
  exit "$status"
}

# From this point onward `next build` may replace the artifact used by the
# currently serving process. Any failed preflight, build, smoke test, or
# infrastructure verification must put the restartable previous artifact back
# on disk, even when live cutover has not happened yet.
trap 'handle_release_exit "$?"' EXIT

echo "[5/11] Building"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
health_check_token="${HEALTH_CHECK_TOKEN:-}"
if [[ ${#health_check_token} -lt 24 ]]; then
  echo "HEALTH_CHECK_TOKEN must be configured with at least 24 characters" >&2
  exit 1
fi
npm run check:esim-pricing
npm run check:wifi-pricing
npm run check:operations-schema
npm run check:deploy-safety
npm run test:order-integrity
npm run build

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
smoke_curl_config="$(mktemp /tmp/qyroam-smoke-curl.XXXXXX.conf)"
chmod 600 "$smoke_log" "$smoke_curl_config"
printf 'header = "Authorization: Bearer %s"\n' "$health_check_token" > "$smoke_curl_config"
smoke_pid=""
cleanup_smoke() {
  if [[ -n "$smoke_pid" ]] && kill -0 "$smoke_pid" 2>/dev/null; then
    kill "$smoke_pid" 2>/dev/null || true
    wait "$smoke_pid" 2>/dev/null || true
  fi
  rm -f "$smoke_log" "$smoke_curl_config"
}
trap 'status=$?; cleanup_smoke; handle_release_exit "$status"' EXIT
HOSTNAME=127.0.0.1 PORT="$smoke_port" node .next/standalone/server.js >"$smoke_log" 2>&1 &
smoke_pid=$!
smoke_ready=0
for attempt in {1..15}; do
  if ! kill -0 "$smoke_pid" 2>/dev/null; then
    break
  fi
  if curl --config "$smoke_curl_config" --fail --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS" "http://127.0.0.1:${smoke_port}/api/health" |
     node -e "let body='';process.stdin.on('data',chunk=>body+=chunk).on('end',()=>{const result=JSON.parse(body);if(result.launchReady!==true||result.service!=='qy-roam')process.exit(1)})"; then
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

echo "[10/11] Restarting service"
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
health_config="$(mktemp /tmp/qyroam-curl.XXXXXX.conf)"
trap 'status=$?; rm -f "$health_output" "$health_config"; handle_release_exit "$status"' EXIT
chmod 600 "$health_output" "$health_config"
printf 'header = "Authorization: Bearer %s"\n' "$health_check_token" > "$health_config"
ready=0
for attempt in {1..15}; do
  if curl --config "$health_config" --fail --silent --show-error --max-time "$READINESS_CURL_TIMEOUT_SECONDS" "$HEALTH_URL" > "$health_output" &&
     node -e "const fs=require('fs');const result=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(result.launchReady!==true)process.exit(1)" "$health_output"; then
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

release_verified=1
cleanup_release_snapshot

echo "Deployment verification complete"
printf 'Deploy completed successfully.\n'
