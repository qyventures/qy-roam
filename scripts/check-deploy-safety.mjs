import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const deploy = readFileSync(new URL('../deploy/deploy.sh', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.ok(existsSync(new URL('../package-lock.json', import.meta.url)), 'package-lock.json is required for reproducible production installs');
assert.match(deploy, /git branch --show-current/);
assert.match(deploy, /production checkout must already be on main/);
assert.match(deploy, /git diff --quiet/);
assert.match(deploy, /git diff --cached --quiet/);
assert.doesNotMatch(deploy, /git checkout\s/);
assert.match(deploy, /npm ci --no-audit --no-fund/);
assert.doesNotMatch(deploy, /npm install --no-audit --no-fund/);

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
  'npm run test:order-integrity',
  'npm run build',
]) {
  assert.ok(deploy.includes(command), `Deployment preflight is missing ${command}`);
}

console.log('Deployment safety guard passed: clean main checkout, locked install, and release checks required.');
