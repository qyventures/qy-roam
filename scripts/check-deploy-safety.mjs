import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const deploy = readFileSync(new URL('../deploy/deploy.sh', import.meta.url), 'utf8');
const service = readFileSync(new URL('../deploy/qy-roam.service', import.meta.url), 'utf8');
const nginx = readFileSync(new URL('../deploy/nginx-qyroam.conf', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.ok(existsSync(new URL('../package-lock.json', import.meta.url)), 'package-lock.json is required for reproducible production installs');
assert.equal(packageJson.engines?.node, '>=22.0.0 <23', 'production Node release line must be explicit');
assert.match(deploy, /process\.versions\.node\.split/);
assert.match(deploy, /Node\.js 22\.x is required/);
assert.ok(
  deploy.indexOf('Node.js 22.x is required') < deploy.indexOf('git fetch --prune origin'),
  'runtime compatibility must fail before deployment mutates the checkout',
);
assert.match(deploy, /git branch --show-current/);
assert.match(deploy, /production checkout must already be on main/);
assert.match(deploy, /git diff --quiet/);
assert.match(deploy, /git diff --cached --quiet/);
assert.doesNotMatch(deploy, /git checkout\s/);
assert.match(deploy, /npm ci --no-audit --no-fund/);
assert.doesNotMatch(deploy, /npm install --no-audit --no-fund/);
// Compile success alone is not a safe restart boundary. Boot the exact
// standalone artifact on loopback and require its public, dependency-free
// liveness response before replacing the live process.
assert.match(deploy, /node \.next\/standalone\/server\.js/);
assert.match(deploy, /HOSTNAME=127\.0\.0\.1 PORT="\$smoke_port"/);
assert.match(deploy, /http:\/\/127\.0\.0\.1:\$\{smoke_port\}\/api\/health/);
assert.match(deploy, /result\.ok!==true\|\|result\.service!=='qy-roam'/);
assert.match(deploy, /Built QY Roam artifact failed its isolated startup smoke test/);
assert.ok(
  deploy.indexOf('Smoke-testing the production artifact') < deploy.indexOf('systemctl restart "$SERVICE_NAME"'),
  'the built artifact must boot successfully before the live service is restarted',
);
// The checked-in unit carries the loopback and restart hardening relied on by
// the app. `daemon-reload` cannot install that file, so a release must first
// fail closed if the active unit has drifted before it reloads and restarts.
assert.match(deploy, /SYSTEMD_UNIT_PATH=/);
assert.match(deploy, /cmp -s deploy\/qy-roam\.service/);
assert.match(deploy, /Installed systemd unit does not match deploy\/qy-roam\.service/);
assert.match(deploy, /systemctl daemon-reload/);
assert.match(deploy, /Unable to reload the systemd service definition/);
// Nginx is part of the paid-order trust boundary: it keeps the standalone
// app on loopback, supplies the trusted client IP, and rejects oversized or
// stalled public uploads. A production release must fail if that installed
// ingress file drifts from the reviewed version, then validate the complete
// effective Nginx configuration before restarting the app.
assert.match(deploy, /NGINX_CONFIG_PATH=/);
assert.match(deploy, /cmp -s deploy\/nginx-qyroam\.conf/);
assert.match(deploy, /Installed Nginx site does not match deploy\/nginx-qyroam\.conf/);
assert.match(deploy, /if ! nginx -t; then/);
assert.match(deploy, /Nginx configuration validation failed/);
assert.match(deploy, /if ! systemctl restart "\$SERVICE_NAME"; then/);
assert.match(deploy, /QY Roam service restart failed/);

// Checkout throttling and consented CAPI attribution use the single client IP
// written by Nginx. The app must therefore never be reachable directly on a
// public interface where a caller could provide its own X-Real-IP header.
assert.match(service, /^Environment=HOSTNAME=127\.0\.0\.1$/m, 'standalone Next.js must bind only to loopback behind Nginx');
// A deploy must not force-kill a legitimate in-flight paid-order webhook
// before Nginx's reviewed proxy window can complete. Stripe retries are an
// idempotent recovery mechanism, not the normal outcome of a healthy restart.
assert.match(service, /^TimeoutStopSec=150$/m, 'systemd graceful-stop budget must exceed the webhook proxy deadline');
assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3100;/);
assert.match(nginx, /proxy_set_header X-Real-IP \$remote_addr;/);
// The public proxy must enforce the same coarse body boundary as the signed
// Stripe webhook reader. This stops oversized or stalled uploads before they
// consume an application worker; checkout/admin routes apply narrower limits
// again at their own request boundaries.
assert.match(nginx, /client_max_body_size 1m;/);
assert.match(nginx, /client_body_timeout 15s;/);
// A successful webhook can include bounded Stripe retrieval, persistence,
// and independent paid-order delivery work. Do not let the proxy abandon a
// healthy worker before it can settle the idempotency lease and acknowledge
// Stripe; retries remain a recovery path, not the normal slow-path.
assert.match(nginx, /proxy_read_timeout 120s;/);

// npm v9 lockfiles record only the optional SWC binaries resolved for the
// install platform. Next 14 nevertheless tries to patch in every foreign
// platform binary during a build, which makes an otherwise locked production
// build depend on a live registry request. The installed native binary remains
// lockfile-pinned by npm ci; this narrowly prevents that unrelated mutation.
assert.equal(packageJson.scripts.build, 'NEXT_IGNORE_INCORRECT_LOCKFILE=1 next build');

for (const command of [
  'npm run check:esim-pricing',
  'npm run check:wifi-pricing',
  'npm run check:operations-schema',
  'npm run check:deploy-safety',
  'npm run test:order-integrity',
  'npm run build',
]) {
  assert.ok(deploy.includes(command), `Deployment preflight is missing ${command}`);
}

console.log('Deployment safety guard passed: Node 22, clean main checkout, locked install, and release checks required.');
