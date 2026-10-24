const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CHECKOUT_REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/;

/** Parse only real, canonical ISO calendar dates without Date normalization. */
export function parseExactIsoDate(value: unknown) {
  // Checkout fields cross an untrusted JSON boundary. Do not let arrays such
  // as ["2026-10-25"] stringify into a valid commercial value.
  if (typeof value !== 'string') return null;
  const text = value;
  if (!ISO_DATE.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? date : null;
}

export function validCheckoutRequestId(value: unknown) {
  if (typeof value !== 'string') return null;
  const id = value;
  return CHECKOUT_REQUEST_ID.test(id) ? id : null;
}
