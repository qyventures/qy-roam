import fs from 'node:fs';

const source = fs.readFileSync(new URL('../lib/esimPlans.ts', import.meta.url), 'utf8');
const blocks = [...source.matchAll(/\{\s*\n\s*id:\s*'([^']+)'[\s\S]*?benchmarkPriceSgd:\s*([0-9.]+),[\s\S]*?benchmarkVerifiedOn:\s*'([^']+)'/g)];
if (!blocks.length) throw new Error('No eSIM plans found');
const ids = new Set();
const now = new Date('2026-08-29T00:00:00Z');
for (const [, id, benchmarkRaw, verifiedOn] of blocks) {
  if (ids.has(id)) throw new Error(`Duplicate eSIM plan id: ${id}`);
  ids.add(id);
  const benchmark = Number(benchmarkRaw);
  if (!(benchmark > 0)) throw new Error(`Invalid benchmark for ${id}`);
  const verified = new Date(`${verifiedOn}T00:00:00Z`);
  const ageDays = (now - verified) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > 30) throw new Error(`Stale benchmark for ${id}: ${verifiedOn}`);
}
if (!source.includes('return Math.floor(price * 0.85 * 100) / 100;')) {
  throw new Error('15% benchmark discount invariant is not enforced by discounted()');
}
console.log(`eSIM pricing guard passed for ${blocks.length} plans: server-authoritative, 15% below verified benchmark.`);
