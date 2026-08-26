#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/qy-roam}"
ENV_FILE="${ENV_FILE:-/root/.config/qyroam/.env}"
SERVICE_NAME="${SERVICE_NAME:-qy-roam}"

cd "$APP_DIR"

echo "[1/6] Updating source"
git fetch --prune origin
git checkout main
git pull --ff-only origin main

echo "[2/6] Checking environment file"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi
chmod 600 "$ENV_FILE"

echo "[3/6] Installing dependencies"
npm install --no-audit --no-fund

echo "[4/6] Building"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
npm run build

echo "[5/6] Restarting service"
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,15p'

echo "[6/6] Local readiness check"
sleep 2
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
printf '\nDeploy completed.\n'
