// Meta's browser identifiers are opaque cookies. Accept only their documented
// shape and keep them out of the order unless the buyer opted into measurement.
// This lets the webhook join the browser Pixel and CAPI Purchase without
// turning arbitrary request data into long-lived Stripe metadata.
const META_BROWSER_ID = /^fb\.1\.\d{10,13}\.[A-Za-z0-9_-]{1,200}$/;
const MAX_USER_AGENT_LENGTH = 500;

export type MetaAttribution = { fbp?: string; fbc?: string };

function validBrowserId(value: unknown) {
  return typeof value === 'string' && META_BROWSER_ID.test(value) ? value : undefined;
}

export function metaAttributionFromRequest(value: unknown, userAgent?: string | null): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const attribution = value as MetaAttribution;
  const fbp = validBrowserId(attribution.fbp);
  const fbc = validBrowserId(attribution.fbc);
  // The User-Agent comes from the HTTP request, never the browser JSON body.
  // It is useful to CAPI matching but is still sent only after consent.
  const clientUserAgent = typeof userAgent === 'string'
    ? userAgent.trim().replace(/[\r\n]/g, '').slice(0, MAX_USER_AGENT_LENGTH)
    : '';
  return {
    ...(fbp ? { meta_fbp: fbp } : {}),
    ...(fbc ? { meta_fbc: fbc } : {}),
    ...(clientUserAgent ? { meta_client_user_agent: clientUserAgent } : {}),
  };
}
