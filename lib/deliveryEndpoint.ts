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
    if (
      url.protocol !== 'https:' ||
      !hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      isIP(hostname) ||
      hostname.toLowerCase() === 'localhost' ||
      hostname.toLowerCase().endsWith('.localhost')
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}
