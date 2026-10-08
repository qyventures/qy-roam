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

/**
 * Return the bounded set of secrets accepted during an intentional Stripe
 * endpoint-secret rotation. New deployments still require the active secret;
 * when a previous value is explicitly present it must be just as valid, so a
 * typo cannot make readiness green while old signed deliveries are rejected.
 * Equal values are collapsed to avoid doing duplicate verification work.
 */
export function stripeWebhookSigningSecrets() {
  const current = stripeWebhookSigningSecret();
  if (!current) return null;

  const previousValue = process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS;
  if (!previousValue) return [current];

  const previous = stripeWebhookSigningSecret(previousValue);
  if (!previous) return null;
  return previous === current ? [current] : [current, previous];
}
