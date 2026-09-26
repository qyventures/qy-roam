// A Checkout Session URL is a browser payment capability. Even after the
// Session's commercial identity and provenance have been verified, never
// reflect an arbitrary SDK/provider value into a customer redirect. QY Roam
// uses Stripe-hosted Checkout, whose Session URLs are HTTPS links on this
// exact host.
export function safeStripeCheckoutUrl(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'checkout.stripe.com' ||
      url.port ||
      url.username ||
      url.password ||
      !url.pathname.startsWith('/c/pay/')
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}
