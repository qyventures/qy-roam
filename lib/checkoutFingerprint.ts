// A checkout fingerprint decides whether the browser may replace its durable
// Stripe idempotency key. Keep it limited to commercial selections: optional
// measurement consent can change while a payment response is in flight, but
// that must never turn one order into a second payable Checkout Session.
export function esimCheckoutFingerprint(planId: string) {
  return JSON.stringify({ planId });
}

export function pocketWifiCheckoutFingerprint(
  country: string,
  start: string,
  end: string,
  promoCode: string,
) {
  // The server trims and uppercases promo codes before pricing. Apply the
  // same harmless normalization here so visually equivalent input retains
  // the existing attempt identity after a network or browser retry.
  return JSON.stringify({ country, start, end, promoCode: promoCode.trim().toUpperCase() });
}
