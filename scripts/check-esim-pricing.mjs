import fs from 'node:fs';

const source = fs.readFileSync(new URL('../lib/esimPlans.ts', import.meta.url), 'utf8');
const MAX_BENCHMARK_AGE_DAYS = 30;
const singaporeDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date()).reduce((result, part) => {
  if (part.type !== 'literal') result[part.type] = part.value;
  return result;
}, {});
const today = `${singaporeDate.year}-${singaporeDate.month}-${singaporeDate.day}`;

function exactIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function ageInDays(verifiedOn) {
  const verified = exactIsoDate(verifiedOn);
  const now = exactIsoDate(today);
  if (!verified || !now) return Number.NaN;
  return (now.getTime() - verified.getTime()) / 86_400_000;
}

const blocks = [...source.matchAll(/\{\s*\n\s*id:\s*'([^']+)'[\s\S]*?benchmarkPriceSgd:\s*([0-9.]+),[\s\S]*?qyPriceSgd:\s*discounted\(\2\),[\s\S]*?benchmarkVerifiedOn:\s*'([^']+)'/g)];
if (!blocks.length) throw new Error('No eSIM plans found');
const ids = new Set();
for (const [, id, benchmarkRaw, verifiedOn] of blocks) {
  if (ids.has(id)) throw new Error(`Duplicate eSIM plan id: ${id}`);
  ids.add(id);
  const benchmark = Number(benchmarkRaw);
  if (!(benchmark > 0)) throw new Error(`Invalid benchmark for ${id}`);
  const ageDays = ageInDays(verifiedOn);
  if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > MAX_BENCHMARK_AGE_DAYS) throw new Error(`Stale benchmark for ${id}: ${verifiedOn} (checked ${today})`);
}
if (!source.includes('return Math.floor(price * 0.85 * 100) / 100;')) {
  throw new Error('15% benchmark discount invariant is not enforced by discounted()');
}
const promo = source.match(/export const ESIM_PROMO\s*=\s*\{[\s\S]*?endDate:\s*'([^']+)'/);
if (!promo || !exactIsoDate(promo[1]) || today > promo[1]) {
  throw new Error(`The eSIM launch promotion is expired or has an invalid end date (checked ${today})`);
}
console.log(`eSIM pricing guard passed for ${blocks.length} plans: server-authoritative, 15% below benchmarks verified within ${MAX_BENCHMARK_AGE_DAYS} days.`);
