import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const deploy = readFileSync(new URL('../deploy/deploy.sh', import.meta.url), 'utf8');
const service = readFileSync(new URL('../deploy/qy-roam.service', import.meta.url), 'utf8');
const nginx = readFileSync(new URL('../deploy/nginx-qyroam.conf', import.meta.url), 'utf8');
const productionReadiness = readFileSync(new URL('../lib/productionReadiness.ts', import.meta.url), 'utf8');
const standalonePackager = readFileSync(new URL('./package-standalone.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.ok(existsSync(new URL('../package-lock.json', import.meta.url)), 'package-lock.json is required for reproducible production installs');
assert.equal(packageJson.engines?.node, '>=22.0.0 <23', 'production Node release line must be explicit');
assert.equal(
  packageJson.scripts.build,
  'NEXT_IGNORE_INCORRECT_LOCKFILE=1 next build && node scripts/package-standalone.mjs',
  'production build must package browser and public assets into the standalone artifact',
);
assert.match(deploy, /process\.versions\.node\.split/);
assert.match(deploy, /Node\.js 22\.x is required/);
assert.ok(
  deploy.indexOf('Node.js 22.x is required') < deploy.indexOf('git fetch --prune origin'),
  'runtime compatibility must fail before deployment mutates the checkout',
);
assert.match(deploy, /git branch --show-current/);
assert.match(deploy, /production checkout must already be on main/);
assert.match(deploy, /git status --porcelain=v1 --untracked-files=normal/);
assert.match(deploy, /production checkout has tracked or untracked local changes/);
assert.doesNotMatch(deploy, /git diff --quiet/);
assert.doesNotMatch(deploy, /git diff --cached --quiet/);
assert.doesNotMatch(deploy, /git checkout\s/);
assert.match(deploy, /npm ci --no-audit --no-fund/);
assert.doesNotMatch(deploy, /npm install --no-audit --no-fund/);
// The isolated artifact test cannot reproduce a production-port conflict or
// every systemd-only failure. Preserve the previously serving artifact until
// live readiness succeeds. Because `next build` replaces `.next`, every
// failure after the snapshot (including build, smoke, and config checks before
// cutover) must restore that restartable artifact.
assert.match(deploy, /mktemp -d \/tmp\/qyroam-release-rollback/);
assert.match(deploy, /cp -a \.next "\$rollback_dir\/previous-next"/);
assert.match(deploy, /restore_previous_artifact\(\)/);
assert.match(deploy, /cp -a "\$rollback_dir\/previous-next" \.next/);
assert.match(deploy, /release_snapshot_cleanup_enabled=0/);
assert.match(deploy, /retained recovery snapshot at \$rollback_dir\/previous-next/);
assert.match(deploy, /handle_release_exit\(\)/);
assert.match(deploy, /status.*-ne 0.*release_verified.*-ne 1.*previous_artifact_available.*-eq 1/);
assert.ok(
  deploy.indexOf("trap 'handle_release_exit") < deploy.indexOf('npm run check:esim-pricing'),
  'automatic artifact restoration must be armed before any build preflight can fail',
);
assert.match(deploy, /cutover_attempted=1\nif ! systemctl restart/);
assert.match(deploy, /if \[\[ "\$cutover_attempted" -eq 0 \]\]; then/);
assert.match(deploy, /qyroam-rollback-curl/);
assert.match(deploy, /rollback_ready=0/);
assert.match(deploy, /result\.launchReady!==true\|\|result\.service!=='qy-roam'/);
assert.match(deploy, /Previous QY Roam artifact restored, restarted, and launch-ready/);
assert.match(deploy, /Automatic rollback did not become launch-ready/);
assert.ok(
  deploy.indexOf('if systemctl restart "$SERVICE_NAME"; then') === -1,
  'rollback must not treat systemd accepting a restart as proof that checkout recovered',
);
assert.ok(
  deploy.indexOf('rollback_ready=0') < deploy.indexOf('Previous QY Roam artifact restored, restarted, and launch-ready'),
  'rollback success must be reported only after authenticated readiness succeeds',
);
assert.match(deploy, /release_verified=1\ncleanup_release_snapshot/);
assert.ok(
  deploy.lastIndexOf('cleanup_release_snapshot') > deploy.indexOf('if [[ "$ready" -ne 1 ]]'),
  'the rollback snapshot must survive until live readiness succeeds',
);
// Compile success alone is not a safe restart boundary. Boot the exact
// standalone artifact on loopback and require its authenticated order
// readiness response before replacing the live process. This catches a
// partial production migration/configuration before customer traffic moves
// to the freshly built process.
assert.match(deploy, /node \.next\/standalone\/server\.js/);
assert.match(deploy, /HOSTNAME=127\.0\.0\.1 PORT="\$smoke_port"/);
assert.match(deploy, /http:\/\/127\.0\.0\.1:\$\{smoke_port\}\/api\/health/);
assert.match(deploy, /smoke_curl_config=/);
assert.match(deploy, /chmod 600 "\$smoke_log" "\$smoke_curl_config"/);
assert.match(deploy, /curl --config "\$smoke_curl_config" --fail --silent --show-error --max-time "\$READINESS_CURL_TIMEOUT_SECONDS"/);
assert.match(deploy, /result\.launchReady!==true\|\|result\.service!=='qy-roam'/);
assert.match(deploy, /Built QY Roam artifact failed its isolated startup smoke test/);
assert.match(standalonePackager, /resolve\(root, 'public'\)/);
assert.match(standalonePackager, /resolve\(root, '\.next\/static'\)/);
assert.match(standalonePackager, /resolve\(standalone, 'public'\)/);
assert.match(standalonePackager, /resolve\(standalone, '\.next\/static'\)/);
assert.match(deploy, /verify_sales_page_assets\(\)/);
assert.match(deploy, /for sales_page in \/ \/esim/);
assert.match(deploy, /unique\.some\(asset=>asset\.split/);
assert.match(deploy, /Built QY Roam artifact has an unavailable sales page or browser asset/);
assert.ok(
  deploy.indexOf('verify_sales_page_assets()') < deploy.indexOf('echo "[10/11] Restarting service"'),
  'every sales-page browser asset must be fetched from the isolated artifact before restart',
);
assert.ok(
  deploy.indexOf('Smoke-testing the production artifact') < deploy.indexOf('echo "[10/11] Restarting service"'),
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

// Both authenticated health calls execute the bounded schema probes in
// productionReadiness. Their transport deadline must be strictly longer than
// the probe deadline or a valid readiness response can be aborted by curl and
// cause an unnecessary rollback after the new process is already healthy.
const readinessProbeTimeout = Number(productionReadiness.match(/const READINESS_PROBE_TIMEOUT_MS = ([\d_]+);/)?.[1].replaceAll('_', ''));
const readinessCurlTimeout = Number(deploy.match(/^READINESS_CURL_TIMEOUT_SECONDS=(\d+)$/m)?.[1]);
assert.ok(Number.isFinite(readinessProbeTimeout), 'application readiness probe timeout must remain explicit');
assert.ok(Number.isFinite(readinessCurlTimeout), 'deployment readiness curl timeout must remain explicit');
assert.ok(
  readinessCurlTimeout * 1_000 > readinessProbeTimeout,
  'deployment readiness deadline must exceed the application probe deadline',
);
assert.match(deploy, /curl --config "\$health_config" --fail --silent --show-error --max-time "\$READINESS_CURL_TIMEOUT_SECONDS"/);

// Checkout throttling and consented CAPI attribution use the single client IP
// written by Nginx. The app must therefore never be reachable directly on a
// public interface where a caller could provide its own X-Real-IP header.
assert.match(service, /^Environment=HOSTNAME=127\.0\.0\.1$/m, 'standalone Next.js must bind only to loopback behind Nginx');
// systemd must own the actual Next server process. Supervising `npm run start`
// leaves a wrapper between systemd's SIGTERM and the HTTP worker, so a deploy
// can wait for the hard stop while the child retains port 3100 instead of
// immediately beginning the graceful webhook drain configured below.
assert.match(
  service,
  /^ExecStart=\/usr\/bin\/node \/root\/qy-roam\/\.next\/standalone\/server\.js$/m,
  'systemd must directly supervise the standalone Next.js server',
);
assert.doesNotMatch(service, /^ExecStart=.*\bnpm\b/m, 'systemd must not supervise an npm wrapper');
// A deploy must not force-kill a legitimate in-flight paid-order webhook
// before Nginx's reviewed proxy window can complete. Stripe retries are an
// idempotent recovery mechanism, not the normal outcome of a healthy restart.
assert.match(service, /^TimeoutStopSec=150$/m, 'systemd graceful-stop budget must exceed the webhook proxy deadline');
assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3100;/);
assert.match(nginx, /proxy_set_header X-Real-IP \$remote_addr;/);
// Do not retain a client-supplied forwarding chain behind the trusted
// loopback ingress. Checkout throttling currently uses X-Real-IP, but the
// reviewed proxy contract must keep every forwarded client-IP header equally
// authoritative so a future consumer cannot accidentally trust a spoofed
// first hop.
assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
assert.doesNotMatch(nginx, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
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
// The standalone server changes its working directory to `.next/standalone`.
// Next does not copy these browser assets automatically, so the packaging
// step is part of the release boundary rather than an optional deploy detail.
assert.match(packageJson.scripts.build, /node scripts\/package-standalone\.mjs/);

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
