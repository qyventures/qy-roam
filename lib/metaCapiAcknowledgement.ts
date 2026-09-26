// Meta can return an HTTP 2xx through an intermediary even when the body is
// not a Conversions API acknowledgement. This application submits exactly
// one Purchase at a time, so settle the durable delivery ledger only when a
// bounded provider response is valid JSON and explicitly acknowledges that
// one event. Keep parsing in a small pure boundary so malformed success
// responses are covered by executable tests rather than source inspection.
export function metaCapiPurchaseAcknowledged(responseBody: string) {
  try {
    const acknowledgement: unknown = JSON.parse(responseBody);
    return Boolean(
      acknowledgement &&
      typeof acknowledgement === 'object' &&
      !Array.isArray(acknowledgement) &&
      (acknowledgement as { events_received?: unknown }).events_received === 1,
    );
  } catch {
    return false;
  }
}
