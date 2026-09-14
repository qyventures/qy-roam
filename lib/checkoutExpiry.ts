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
// Leave a meaningful cushion after any browser attempt is accepted. The
// checkout routes can still be completing readiness, inventory and Stripe
// work after validation; this protects the final Session-create call from
// reaching Stripe with an expiry that is merely technically valid at the
// beginning of the request.
export const CHECKOUT_EXPIRY_CREATION_MARGIN_SECONDS = 2 * 60;
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

// The browser keeps this timestamp beside the checkout request id. Stripe
// requires every request that reuses an idempotency key to have identical
// parameters, so `expires_at` must be based on the original attempt rather
// than recalculated on each retry. Bound the client-authored timestamp before
// it can influence a payable Session: a small future allowance covers clock
// skew, while the existing browser recovery window limits stale attempts.
// A retry must leave Stripe's required 30-minute minimum between Session
// creation and expiry. Because the expiry is fixed from the first browser
// attempt (to keep Stripe idempotency parameters stable), its reuse window is
// only the remaining safety margin, not the full Checkout payment window.
// Keep one second of margin for the floor/ceil conversion below.
export const CHECKOUT_ATTEMPT_MAX_AGE_MS = (STRIPE_EXPIRY_SAFETY_SECONDS - CHECKOUT_EXPIRY_CREATION_MARGIN_SECONDS) * 1000 - 1_000;
export const CHECKOUT_ATTEMPT_MAX_FUTURE_MS = 60 * 1000;

export function checkoutAttemptExpiresAt(value: unknown, nowMs = Date.now()) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value > nowMs + CHECKOUT_ATTEMPT_MAX_FUTURE_MS) return null;
  if (nowMs - value > CHECKOUT_ATTEMPT_MAX_AGE_MS) return null;
  const expiresAt = Math.floor(value / 1000) + CHECKOUT_HOLD_WINDOW_SECONDS;
  // Keep the acceptance decision tied directly to the expiry sent to Stripe.
  // This remains correct if either window constant changes and rejects a
  // timestamp whose integer-second rounding would leave an invalid expiry.
  if (expiresAt - Math.ceil(nowMs / 1000) < CHECKOUT_PAYMENT_WINDOW_MINUTES * 60 + CHECKOUT_EXPIRY_CREATION_MARGIN_SECONDS) return null;
  return expiresAt;
}

export function checkoutExpiresAt(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000) + CHECKOUT_HOLD_WINDOW_SECONDS;
}
