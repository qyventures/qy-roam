export function metaMeasurementAllowed() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem('qyroam_consent') === 'accepted';
}

export function trackMeta(event: string, params: Record<string, unknown> = {}) {
  if (!metaMeasurementAllowed() || typeof window === 'undefined') return;
  const fbq = (window as Window & { fbq?: (...args: any[]) => void }).fbq;
  if (typeof fbq === 'function') fbq('track', event, params);
}

// The consent banner loads the Pixel asynchronously. A conversion can be
// rendered immediately after Stripe redirects back, so allow a short bounded
// wait for the Pixel instead of silently losing the browser half of a
// browser/CAPI-deduplicated Purchase event.
export function trackMetaWhenReady(event: string, params: Record<string, unknown> = {}, options: Record<string, unknown> = {}, attemptsLeft = 20) {
  if (!metaMeasurementAllowed() || typeof window === 'undefined') return;
  const fbq = (window as Window & { fbq?: (...args: any[]) => void }).fbq;
  if (typeof fbq === 'function') {
    fbq('track', event, params, options);
    return;
  }
  if (attemptsLeft > 0) window.setTimeout(() => trackMetaWhenReady(event, params, options, attemptsLeft - 1), 100);
}
