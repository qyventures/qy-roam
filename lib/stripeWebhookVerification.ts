import Stripe from 'stripe';

export type StripeWebhookVerificationFailure = 'signature' | 'payload';

/**
 * Classify only the failures that make a webhook request permanently invalid.
 *
 * Stripe raises its dedicated verification error for a missing/mismatched
 * HMAC or an expired signature. Once the HMAC matches, malformed signed JSON
 * is surfaced as a SyntaxError. Both are request defects and should receive a
 * terminal 400. Any other SDK/runtime exception is deliberately left
 * unclassified so the route returns a retryable 500 instead of silently
 * discarding an authentic payment event during an application failure.
 */
export function stripeWebhookVerificationFailure(
  error: unknown,
): StripeWebhookVerificationFailure | null {
  if (error instanceof Stripe.errors.StripeSignatureVerificationError) return 'signature';
  if (error instanceof SyntaxError) return 'payload';
  return null;
}
