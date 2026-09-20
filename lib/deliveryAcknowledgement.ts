export function fulfilmentRelayAcknowledged(responseBody: string, expectedMessageId: string) {
  try {
    const acknowledgement: unknown = JSON.parse(responseBody);
    if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) return false;
    const value = acknowledgement as { delivered?: unknown; message_id?: unknown };
    return value.delivered === true && value.message_id === expectedMessageId;
  } catch {
    return false;
  }
}
