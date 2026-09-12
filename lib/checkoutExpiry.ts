// Stripe requires a custom Checkout Session expiry to be at least 30 minutes
// after Stripe creates the Session. An expiry calculated as exactly 30 minutes
// from the application clock can fall below that boundary while the request is
// in flight. Keep a small explicit margin, and use the same complete window
// whenever recent open Sessions are scanned for inventory holds.
export const CHECKOUT_PAYMENT_WINDOW_MINUTES = 30;
// Covers the bounded Stripe request/retry plus the Pocket WiFi reservation
// write that happens before Session creation. This still leaves an abandoned
// checkout far below Stripe's 24-hour maximum/default.
export const STRIPE_EXPIRY_SAFETY_SECONDS = 5 * 60;
export const CHECKOUT_HOLD_WINDOW_SECONDS = CHECKOUT_PAYMENT_WINDOW_MINUTES * 60 + STRIPE_EXPIRY_SAFETY_SECONDS;
// Stripe's list endpoint is scoped to the account rather than QY Roam's
// metadata. A shared account can therefore contain unrelated open Checkout
// Sessions inside this short window. Capacity checks must inspect every page
// they choose to rely on, but must also have a finite upstream-work budget.
// If this ceiling is reached callers fail closed instead of silently
// undercounting holds (and selling an unavailable router) or keeping a public
// checkout worker busy without bound. Five pages cover 500 recent open
// Sessions, far beyond the physical fleet, while leaving an explicit signal
// for operations to separate or clear noisy shared-account traffic.
export const MAX_STRIPE_HOLD_SCAN_PAGES = 5;
// Expiry webhooks release abandoned holds promptly in healthy operation. Keep
// a database-only grace through Stripe's retry window so delayed completion
// delivery cannot create a paid commitment after the router was resold.
export const CHECKOUT_WEBHOOK_HANDOFF_GRACE_MS = 4 * 24 * 60 * 60 * 1000;

export function checkoutExpiresAt(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000) + CHECKOUT_HOLD_WINDOW_SECONDS;
}
