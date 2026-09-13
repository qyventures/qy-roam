// Paid-order delivery requests contain customer details and, for the optional
// SMTP relay, mail-server credentials. Keep the URL boundary shared between
// checkout readiness and the actual webhook/admin delivery path so a runtime
// configuration change cannot bypass the pre-payment check.
export function safeHttpsDeliveryEndpoint(value: string | null | undefined) {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
