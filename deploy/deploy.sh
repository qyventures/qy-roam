#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/qy-roam}"
ENV_FILE="${ENV_FILE:-/root/.config/qyroam/.env}"
SERVICE_NAME="${SERVICE_NAME:-qy-roam}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3002/api/health}"

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
npm run build

echo "[5/7] Restarting service"
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,15p'

echo "[6/7] Waiting for application readiness"
ready=0
for attempt in {1..15}; do
  if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" > /tmp/qyroam-health.json; then
    ready=1
    break
  fi
  echo "Health check attempt $attempt/15 not ready yet"
  sleep 2
done
if [[ "$ready" -ne 1 ]]; then
  echo "QY Roam did not become healthy after restart" >&2
  journalctl -u "$SERVICE_NAME" -n 50 --no-pager >&2 || true
  exit 1
fi
cat /tmp/qyroam-health.json
printf '\n'

echo "[7/7] Deployment verification complete"
printf 'Deploy completed successfully.\n'
