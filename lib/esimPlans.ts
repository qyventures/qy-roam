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

export function getEsimPlan(id: unknown) {
  return ESIM_PLANS.find((plan) => plan.id === String(id || ''));
}
