export type PocketWifiAvailability = {
  available: boolean;
  remaining?: number;
  error?: string;
  minDeliveryLeadDays?: number;
  courierFeeSgd?: number;
};

function validLeadDays(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 365;
}

function validCourierFee(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000 &&
    // JSON represents currency with binary floating point. Accept ordinary
    // cent values such as 1.15 without admitting a genuine sub-cent amount.
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
}

function validPublicError(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
}

// The browser uses this response to disclose the payable total and enable the
// Stripe action. Treat the network payload as runtime data: an HTTP 200 alone
// is not evidence that live stock and current booking terms were returned.
export function parsePocketWifiAvailability(value: unknown, responseOk: boolean): PocketWifiAvailability | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;

  if (responseOk) {
    if (input.inventoryMode !== 'live' || typeof input.available !== 'boolean' ||
      !Number.isSafeInteger(input.remaining) || (input.remaining as number) < 0 || (input.remaining as number) > 10_000 ||
      !validLeadDays(input.minDeliveryLeadDays) || !validCourierFee(input.courierFeeSgd) ||
      input.available !== ((input.remaining as number) > 0)) return null;
    return {
      available: input.available,
      remaining: input.remaining as number,
      minDeliveryLeadDays: input.minDeliveryLeadDays as number,
      courierFeeSgd: input.courierFeeSgd as number,
    };
  }

  if (input.available !== false) return null;
  const result: PocketWifiAvailability = { available: false };
  if (validPublicError(input.error)) result.error = input.error as string;
  // Error responses either publish the complete pair of booking terms or no
  // terms. Never combine one fresh value with one stale value in the total.
  const hasLeadDays = input.minDeliveryLeadDays !== undefined;
  const hasCourierFee = input.courierFeeSgd !== undefined;
  if (hasLeadDays !== hasCourierFee) return null;
  if (hasLeadDays) {
    if (!validLeadDays(input.minDeliveryLeadDays) || !validCourierFee(input.courierFeeSgd)) return null;
    result.minDeliveryLeadDays = input.minDeliveryLeadDays as number;
    result.courierFeeSgd = input.courierFeeSgd as number;
  }
  return result;
}
