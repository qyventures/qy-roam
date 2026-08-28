export function metaMeasurementAllowed() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem('qyroam_consent') === 'accepted';
}

export function trackMeta(event: string, params: Record<string, unknown> = {}) {
  if (!metaMeasurementAllowed() || typeof window === 'undefined') return;
  const fbq = (window as Window & { fbq?: (...args: any[]) => void }).fbq;
  if (typeof fbq === 'function') fbq('track', event, params);
}
