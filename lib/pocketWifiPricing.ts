// Keep the public estimate, Checkout amount, and webhook validation on the
// same integer-cent calculation. Currency amounts must never be derived from
// a floating-point dollar subtotal after the daily rate is multiplied by a
// rental length: values such as 3.78 can otherwise display one cent away from
// the amount Stripe is asked to collect.
export function pocketWifiRentalCents(dailyRateSgd: number, days: number) {
  if (!Number.isFinite(dailyRateSgd) || dailyRateSgd <= 0 || !Number.isSafeInteger(days) || days < 1) {
    throw new Error('Invalid Pocket WiFi pricing inputs');
  }
  return Math.max(1_000, Math.round(dailyRateSgd * days * 100));
}

export function sgdFromCents(cents: number) {
  if (!Number.isSafeInteger(cents)) throw new Error('Invalid SGD cents');
  return cents / 100;
}
