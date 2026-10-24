export type EsimPlan = {
  id: string;
  destination: string;
  days: number;
  data: string;
  benchmarkPriceSgd: number;
  qyPriceSgd: number;
  benchmarkSource: 'Changi Recommends';
  benchmarkVerifiedOn: string;
  note: string;
};

export const ESIM_PROMO = {
  code: 'QYESIM15',
  percent: 15,
  label: 'eSIM Launch Special',
  endDate: '2026-09-30'
} as const;

export function esimPromoIsActive(now = new Date()) {
  const end = new Date(`${ESIM_PROMO.endDate}T23:59:59+08:00`);
  return Number.isFinite(now.getTime()) && Number.isFinite(end.getTime()) && now.getTime() <= end.getTime();
}

export const ESIM_BENCHMARK_MAX_AGE_DAYS = 30;

function singaporeIsoDate(now: Date) {
  if (!Number.isFinite(now.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const value = `${values.year}-${values.month}-${values.day}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function exactIsoDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function discounted(price: number) {
  return Math.floor(price * 0.85 * 100) / 100;
}

// Server-authoritative catalogue. Do not add or reprice a plan unless its
// like-for-like Changi Recommends public benchmark has been freshly verified.
export const ESIM_PLANS: EsimPlan[] = [
  {
    id: 'jp-10d-500mb-daily',
    destination: 'Japan',
    days: 10,
    data: '500MB high-speed daily, then unlimited managed speed',
    benchmarkPriceSgd: 5.67,
    qyPriceSgd: discounted(5.67),
    benchmarkSource: 'Changi Recommends',
    benchmarkVerifiedOn: '2026-08-29',
    note: 'Hotspot/tethering supported'
  },
  {
    id: 'tw-5d-unlimited',
    destination: 'Taiwan',
    days: 5,
    data: 'Unlimited 4G data',
    benchmarkPriceSgd: 13.0,
    qyPriceSgd: discounted(13.0),
    benchmarkSource: 'Changi Recommends',
    benchmarkVerifiedOn: '2026-08-29',
    note: 'Hotspot/tethering supported'
  },
  {
    id: 'usca-3d-5gb',
    destination: 'USA + Canada',
    days: 3,
    data: '5GB high-speed total, then unlimited managed speed',
    benchmarkPriceSgd: 15.0,
    qyPriceSgd: discounted(15.0),
    benchmarkSource: 'Changi Recommends',
    benchmarkVerifiedOn: '2026-08-29',
    note: 'Hotspot/tethering supported'
  },
  {
    id: 'europe-uk-30d-3gb',
    destination: 'Europe + UK',
    days: 30,
    data: '3GB high-speed total, then unlimited managed speed',
    benchmarkPriceSgd: 10.54,
    qyPriceSgd: discounted(10.54),
    benchmarkSource: 'Changi Recommends',
    benchmarkVerifiedOn: '2026-08-29',
    note: 'Reloadable plan benchmark'
  },
  {
    id: 'cn-hk-mo-5d-20gb',
    destination: 'China + Hong Kong + Macau',
    days: 5,
    data: '20GB high-speed total, then unlimited managed speed',
    benchmarkPriceSgd: 36.9,
    qyPriceSgd: discounted(36.9),
    benchmarkSource: 'Changi Recommends',
    benchmarkVerifiedOn: '2026-08-29',
    note: 'Hotspot/tethering supported'
  }
];

/**
 * Runtime counterpart to the release pricing check. A process can remain
 * online after a benchmark's reviewed window ends, so checkout and public
 * offer surfaces must fail closed without waiting for another deployment.
 */
export function esimBenchmarksAreFresh(now = new Date()) {
  const today = singaporeIsoDate(now);
  const todayMs = today ? exactIsoDay(today) : null;
  if (todayMs === null) return false;
  return ESIM_PLANS.every((plan) => {
    const verifiedMs = exactIsoDay(plan.benchmarkVerifiedOn);
    if (verifiedMs === null) return false;
    const ageDays = (todayMs - verifiedMs) / 86_400_000;
    return ageDays >= 0 && ageDays <= ESIM_BENCHMARK_MAX_AGE_DAYS;
  });
}

export function esimOfferIsSaleable(now = new Date()) {
  return esimPromoIsActive(now) && esimBenchmarksAreFresh(now);
}

export function getEsimPlan(id: unknown) {
  if (typeof id !== 'string') return undefined;
  return ESIM_PLANS.find((plan) => plan.id === id);
}
