/**
 * Return the public origin used in Stripe redirect URLs.
 *
 * Stripe redirects after payment are part of the payment boundary, not a
 * cosmetic frontend setting. In production, only the canonical QY Roam HTTPS
 * origins are safe: accepting an arbitrary parseable URL here could send a
 * paid customer to a misconfigured third-party domain after Checkout.
 */
export function checkoutSiteOrigin(requestUrl: string) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new Error('Invalid NEXT_PUBLIC_SITE_URL');
    }
    if (process.env.NODE_ENV === 'production' && !isProductionQyRoamOrigin(url)) {
      throw new Error('NEXT_PUBLIC_SITE_URL must use the canonical QY Roam HTTPS origin in production');
    }
    return url.origin;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('NEXT_PUBLIC_SITE_URL is required in production');
  return new URL(requestUrl).origin;
}

export function isProductionQyRoamOrigin(value: string | URL | undefined) {
  if (!value) return false;
  try {
    const url = typeof value === 'string' ? new URL(value) : value;
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ['qyroam.com', 'www.qyroam.com'].includes(url.hostname);
  } catch {
    return false;
  }
}
