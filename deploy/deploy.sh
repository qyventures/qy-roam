#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/qy-roam}"
ENV_FILE="${ENV_FILE:-/root/.config/qyroam/.env}"
SERVICE_NAME="${SERVICE_NAME:-qy-roam}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"

cd "$APP_DIR"

echo "[1/7] Updating source"
git fetch --prune origin
git checkout main
git pull --ff-only origin main

echo "[2/7] Checking environment file"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi
chmod 600 "$ENV_FILE"

echo "[3/7] Installing locked dependencies"
if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

echo "[4/7] Building"
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
npm run build

echo "[5/7] Restarting service"
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,15p'

echo "[6/7] Waiting for application readiness"
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

echo "[7/7] Deployment verification complete"
printf 'Deploy completed successfully.\n'
