type MetaConsent = 'accepted' | 'essential';

const META_CONSENT_KEY = 'qyroam_consent';

// Some privacy-focused browsers and embedded web views expose `localStorage`
// but throw when it is accessed. Measurement must remain strictly opt-in, but
// an optional analytics preference must never stop a customer from opening
// Checkout. Retain an explicit choice for the current tab when persistence is
// unavailable; a fresh tab defaults back to no measurement.
let transientConsent: MetaConsent | null = null;

export function metaMeasurementConsent(): MetaConsent | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(META_CONSENT_KEY);
    if (stored === 'accepted' || stored === 'essential') return stored;
  } catch {
    // Fall through to the non-persistent, explicit choice for this tab.
  }
  return transientConsent;
}

export function metaMeasurementAllowed() {
  return metaMeasurementConsent() === 'accepted';
}

export function setMetaMeasurementConsent(consent: MetaConsent) {
  transientConsent = consent;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(META_CONSENT_KEY, consent);
  } catch {
    // The in-memory choice above still lets this tab honour the customer's
    // explicit decision without making storage availability a checkout gate.
  }
}

function cookieValue(name: string) {
  if (typeof document === 'undefined') return undefined;
  const prefix = `${name}=`;
  const cookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!cookie) return undefined;
  try { return decodeURIComponent(cookie.slice(prefix.length)); }
  catch { return undefined; }
}

// Capture these only after the customer has opted in. They are passed to the
// server solely to improve consented browser/CAPI Purchase matching.
export function metaAttribution() {
  if (!metaMeasurementAllowed()) return undefined;
  return { fbp: cookieValue('_fbp'), fbc: cookieValue('_fbc') };
}

// Meta Pixel accepts an optional event-options argument, including `eventID`.
// Keep it available to immediate browser events too: checkout retries reuse
// their Stripe idempotency identity and must not become separate Pixel events.
export function trackMeta(event: string, params: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  if (!metaMeasurementAllowed() || typeof window === 'undefined') return;
  const fbq = (window as Window & { fbq?: (...args: any[]) => void }).fbq;
  if (typeof fbq === 'function') fbq('track', event, params, options);
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
