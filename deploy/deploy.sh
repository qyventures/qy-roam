#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/qy-roam}"
ENV_FILE="${ENV_FILE:-/root/.config/qyroam/.env}"
SERVICE_NAME="${SERVICE_NAME:-qy-roam}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"
SYSTEMD_UNIT_PATH="${SYSTEMD_UNIT_PATH:-/etc/systemd/system/${SERVICE_NAME}.service}"
NGINX_CONFIG_PATH="${NGINX_CONFIG_PATH:-/etc/nginx/sites-available/qyroam}"

cd "$APP_DIR"

echo "[1/10] Checking production runtime"
# Keep the build and systemd runtime on the same supported Node release line.
# npm's engines field is advisory by default, so enforce it before touching
# source or dependencies; otherwise an obsolete VPS runtime can appear to
# deploy successfully and fail only when checkout first reaches Supabase.
node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$node_major" -ne 22 ]]; then
  echo "Refusing to deploy: Node.js 22.x is required (found $(node --version))" >&2
  exit 1
fi

echo "[2/10] Updating source"
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Refusing to deploy: production checkout must already be on main" >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy: production checkout has tracked local changes" >&2
  exit 1
fi
git fetch --prune origin
git pull --ff-only origin main

echo "[3/10] Checking environment file"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi
chmod 600 "$ENV_FILE"

echo "[4/10] Installing locked dependencies"
if [[ ! -f package-lock.json ]]; then
  echo "package-lock.json is required for a reproducible production deploy" >&2
  exit 1
fi
npm ci --no-audit --no-fund

echo "[5/10] Building"
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

echo "[6/10] Verifying service definition"
# `daemon-reload` only rereads the installed unit; it does not copy the
# checked-in definition into /etc. Refuse a release if the installed unit has
# drifted, so loopback binding, restart policy, and sandboxing changes cannot
# sit in the worktree while an older service definition keeps serving checkout.
# Deliberately do not overwrite /etc here: service-local operator changes need
# an explicit reviewed install before they become part of a paid-order release.
if [[ ! -f "$SYSTEMD_UNIT_PATH" ]] || ! cmp -s deploy/qy-roam.service "$SYSTEMD_UNIT_PATH"; then
  echo "Installed systemd unit does not match deploy/qy-roam.service: $SYSTEMD_UNIT_PATH" >&2
  echo "Review and install the checked-in unit, then rerun deployment." >&2
  exit 1
fi

echo "[7/10] Verifying Nginx ingress definition"
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

echo "[8/10] Reloading service definition"
if ! systemctl daemon-reload; then
  echo "Unable to reload the systemd service definition" >&2
  systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
  exit 1
fi

echo "[9/10] Restarting service"
if ! systemctl restart "$SERVICE_NAME"; then
  echo "QY Roam service restart failed" >&2
  systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
  journalctl -u "$SERVICE_NAME" -n 50 --no-pager >&2 || true
  exit 1
fi
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,15p'

echo "[10/10] Waiting for application readiness"
health_output="$(mktemp /tmp/qyroam-health.XXXXXX.json)"
health_config="$(mktemp /tmp/qyroam-curl.XXXXXX.conf)"
trap 'rm -f "$health_output" "$health_config"' EXIT
chmod 600 "$health_output" "$health_config"
printf 'header = "Authorization: Bearer %s"\n' "$health_check_token" > "$health_config"
ready=0
for attempt in {1..15}; do
  if curl --config "$health_config" --fail --silent --show-error --max-time 5 "$HEALTH_URL" > "$health_output" &&
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

echo "Deployment verification complete"
printf 'Deploy completed successfully.\n'
