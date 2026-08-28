export type WifiPlan = {
  country: string;
  code: string;
  data: string;
  note: string;
  benchmarkRateSgd: number;
  daily: number;
};

// Public Yoowifi benchmark verified 28 Aug 2026. Asia destinations are advertised
// from S$1.90/day and Australia/North America/Europe from S$3.90/day. QY's
// server-authoritative rates are floored to cents at >=3% below benchmark.
export const WIFI_BENCHMARK = {
  provider: 'Yoowifi',
  verifiedOn: '2026-08-28',
  sourceUrl: 'https://order.yoowifi.com/how-it-works',
  minimumDiscountPercent: 3
} as const;

function undercut(benchmark: number) {
  return Math.floor(benchmark * (1 - WIFI_BENCHMARK.minimumDiscountPercent / 100) * 100) / 100;
}

const ASIA = 1.90;
const LONG_HAUL = 3.90;
export const WIFI_PLANS: WifiPlan[] = [
  { country:'Japan', code:'JP', benchmarkRateSgd:ASIA, daily:undercut(ASIA), data:'1GB/day high-speed', note:'Then managed speed' },
  { country:'South Korea', code:'KR', benchmarkRateSgd:ASIA, daily:undercut(ASIA), data:'1GB/day high-speed', note:'Then managed speed' },
  { country:'Thailand', code:'TH', benchmarkRateSgd:ASIA, daily:undercut(ASIA), data:'1GB/day high-speed', note:'Then managed speed' },
  { country:'Malaysia', code:'MY', benchmarkRateSgd:ASIA, daily:undercut(ASIA), data:'1GB/day high-speed', note:'Then managed speed' },
  { country:'Indonesia', code:'ID', benchmarkRateSgd:ASIA, daily:undercut(ASIA), data:'1GB/day high-speed', note:'Then managed speed' },
  { country:'Taiwan', code:'TW', benchmarkRateSgd:ASIA, daily:undercut(ASIA), data:'1GB/day high-speed', note:'Then managed speed' },
  { country:'Vietnam', code:'VN', benchmarkRateSgd:ASIA, daily:undercut(ASIA), data:'1GB/day high-speed', note:'Then managed speed' },
  { country:'Australia', code:'AU', benchmarkRateSgd:LONG_HAUL, daily:undercut(LONG_HAUL), data:'1GB/day high-speed', note:'Then managed speed' },
  { country:'United States', code:'US', benchmarkRateSgd:LONG_HAUL, daily:undercut(LONG_HAUL), data:'1GB/day high-speed', note:'Then managed speed' },
  { country:'United Kingdom', code:'GB', benchmarkRateSgd:LONG_HAUL, daily:undercut(LONG_HAUL), data:'1GB/day high-speed', note:'Then managed speed' }
];

export function getWifiPlan(country: unknown) {
  return WIFI_PLANS.find((p)=>p.country===String(country||''));
}

for (const plan of WIFI_PLANS) {
  const discount=((plan.benchmarkRateSgd-plan.daily)/plan.benchmarkRateSgd)*100;
  if (discount + 1e-9 < WIFI_BENCHMARK.minimumDiscountPercent) throw new Error(`WiFi rate guard failed for ${plan.country}`);
}
