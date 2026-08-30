export const WIFI_FULFILMENT_STATUSES = [
  'awaiting_payment',
  'payment_failed',
  'paid',
  'packing',
  'dispatched',
  'with_customer',
  'return_due',
  'returned',
  'closed',
  'cancelled',
] as const;

export const ESIM_FULFILMENT_STATUSES = [
  'awaiting_payment',
  'payment_failed',
  'awaiting_fulfilment',
  'fulfilled',
  'closed',
  'cancelled',
] as const;

export function isEsimProduct(productType?: string | null) {
  return productType === 'esim';
}

export function validFulfilmentStatus(productType: string | null | undefined, status: string) {
  return (isEsimProduct(productType) ? ESIM_FULFILMENT_STATUSES : WIFI_FULFILMENT_STATUSES).includes(status as never);
}

export function initialFulfilmentStatus(productType: string | null | undefined, paymentStatus: string) {
  if (paymentStatus !== 'paid') return paymentStatus === 'failed' ? 'payment_failed' : 'awaiting_payment';
  return isEsimProduct(productType) ? 'awaiting_fulfilment' : 'paid';
}
