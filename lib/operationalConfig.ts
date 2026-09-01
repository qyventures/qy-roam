type OperationalConfig = {
  pocketWifiInventory: number;
  minDeliveryLeadDays: number;
  courierFeeCents: number;
};

const MAX_INVENTORY = 1_000_000;
const MAX_LEAD_DAYS = 365;
const MAX_COURIER_FEE_CENTS = 1_000_000;

function wholeNumber(value: string | undefined, fallback: number, maximum: number) {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function moneyCents(value: string | undefined, fallback: number) {
  const raw = value?.trim();
  if (!raw) return fallback;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  const dollars = Number(match[1]);
  const cents = Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(dollars) || !Number.isSafeInteger(cents)) return null;
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) && total <= MAX_COURIER_FEE_CENTS ? total : null;
}

/**
 * Parse the operational values that affect whether a customer can buy a router
 * and what Stripe will charge. A malformed deployed value must fail closed,
 * rather than silently becoming zero, Infinity, or a rounded amount.
 */
export function operationalConfig(): OperationalConfig | null {
  const pocketWifiInventory = wholeNumber(process.env.POCKET_WIFI_INVENTORY, 10, MAX_INVENTORY);
  const minDeliveryLeadDays = wholeNumber(process.env.MIN_DELIVERY_LEAD_DAYS, 2, MAX_LEAD_DAYS);
  const courierFeeCents = moneyCents(process.env.COURIER_FEE_SGD, 0);
  if (pocketWifiInventory === null || minDeliveryLeadDays === null || courierFeeCents === null) return null;
  return { pocketWifiInventory, minDeliveryLeadDays, courierFeeCents };
}
