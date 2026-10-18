import { isIP } from 'node:net';

// Paid-order delivery requests contain customer details and, for the optional
// SMTP relay, mail-server credentials. Keep the URL boundary shared between
// checkout readiness and the actual webhook/admin delivery path so a runtime
// configuration change cannot bypass the pre-payment check.
export function safeHttpsDeliveryEndpoint(value: string | null | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    // This request carries paid-order PII plus SMTP credentials. A relay must
    // be a named HTTPS service; do not let an environment typo (or a poisoned
    // configuration value) aim those credentials at a loopback/private IP
    // literal. DNS policy is owned by deployment infrastructure, but refusing
    // literal addresses also makes the expected public relay boundary clear.
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const normalizedHostname = hostname.toLowerCase();
    // WHATWG URL parsing preserves a terminal dot on DNS names. Without an
    // explicit check, `localhost.` bypasses the localhost comparison while
    // resolving to the same loopback host. Single-label and special-use DNS
    // suffixes are likewise deployment-local rather than public relay names.
    // Reject them here so both readiness and the eventual credential-bearing
    // delivery enforce the public-service boundary they advertise.
    const labels = normalizedHostname.split('.');
    const hasCanonicalDnsLabels =
      normalizedHostname.length <= 253 &&
      labels.length >= 2 &&
      labels.every((label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      );
    // These suffixes are reserved for local, documentation, testing, reverse
    // lookup, or alternative-resolution use. They cannot be the public HTTPS
    // relay promised by this configuration boundary. Reject the complete
    // namespace rather than a few familiar hosts: for example,
    // `relay.example.com` is intentionally non-production even though it has
    // an otherwise valid DNS shape.
    const reservedSuffixes = [
      'alt',
      'arpa',
      'example',
      'example.com',
      'example.net',
      'example.org',
      'home.arpa',
      'internal',
      'invalid',
      'local',
      'localhost',
      'onion',
      'test',
    ];
    const hasPublicDnsShape =
      hasCanonicalDnsLabels &&
      !reservedSuffixes.some(
        (suffix) => normalizedHostname === suffix || normalizedHostname.endsWith(`.${suffix}`),
      );
    if (
      url.protocol !== 'https:' ||
      !hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      isIP(hostname) ||
      !hasPublicDnsShape
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}
