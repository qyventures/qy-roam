const RETRYABLE_STRIPE_CONFIRMATION_FAILURES = new Set([
  'StripeAPIError',
  'StripeConnectionError',
  'StripeRateLimitError',
]);

/**
 * A structurally valid Checkout Session id is still not proof that the
 * caller owns a real QY Roam order. Only retry provider failures that Stripe
 * classifies as transient; invalid/missing sessions must remain a one-shot
 * lookup so an arbitrary id cannot make the browser amplify provider work.
 */
export function retryableStripeConfirmationFailure(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && RETRYABLE_STRIPE_CONFIRMATION_FAILURES.has(type);
}
