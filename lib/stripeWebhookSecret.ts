/**
 * Return the one canonical Stripe webhook signing secret accepted by both
 * readiness and the verifier. Secret managers commonly append a final
 * newline; treating that formatting artefact as part of the secret would let
 * launch readiness and live verification disagree. The post-trim value stays
 * deliberately strict ASCII, bounded by Stripe's namespace, and is never
 * logged or returned from a public route.
 */
export function stripeWebhookSigningSecret(value = process.env.STRIPE_WEBHOOK_SECRET) {
  const secret = value?.trim();
  return secret && /^whsec_[A-Za-z0-9]+$/.test(secret) && secret.length >= 20
    ? secret
    : null;
}
