export const LAUNCH_PROMO = {
  code: 'QY10',
  percent: 10,
  label: 'Launch Special',
  headline: '10% off your Pocket WiFi rental',
  endDate: '2026-09-30'
} as const;

export function normalisePromoCode(value: unknown) {
  return String(value || '').trim().toUpperCase();
}

export function promoIsActive(today = new Date()) {
  const end = new Date(`${LAUNCH_PROMO.endDate}T23:59:59+08:00`);
  return today.getTime() <= end.getTime();
}

export function validLaunchPromo(value: unknown, today = new Date()) {
  return promoIsActive(today) && normalisePromoCode(value) === LAUNCH_PROMO.code;
}

export function applyPromoCents(amountCents: number, promoCode: unknown, today = new Date()) {
  if (!validLaunchPromo(promoCode, today)) return { amountCents, discountCents: 0, promoCode: '' };
  const discountCents = Math.floor((amountCents * LAUNCH_PROMO.percent) / 100);
  return {
    amountCents: Math.max(0, amountCents - discountCents),
    discountCents,
    promoCode: LAUNCH_PROMO.code
  };
}
