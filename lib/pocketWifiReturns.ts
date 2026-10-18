import { operationalDaysFromToday } from './operationalDate';

// The public Pocket WiFi return instruction and the operations exception view
// must use one calendar policy. Keep it independent of a server timezone: the
// surrounding operational-date helper always evaluates travel dates in SG.
export const POCKET_WIFI_RETURN_GRACE_DAYS = 5;

export type PocketWifiReturnTiming = 'not_due' | 'due' | 'overdue' | 'complete';

/**
 * Derive the customer and operations return prompt from the booked rental end,
 * not from a staff-authored lifecycle transition. An operator can be late
 * moving `with_customer` to `return_due`; that delay must not also delay the
 * customer's return instruction. Recorded receipt/closure and cancellation
 * remain authoritative terminal states.
 */
export function pocketWifiReturnTiming(
  travelEnd: string | null | undefined,
  fulfilmentStatus: string | null | undefined,
): PocketWifiReturnTiming {
  if (['returned', 'closed', 'cancelled'].includes(fulfilmentStatus || '')) return 'complete';
  // An explicit staff transition may open the return workflow early (for
  // example, after an itinerary change). Preserve that operational signal;
  // the date rule below is the fallback that prevents a delayed transition
  // from suppressing an instruction after the booked rental has ended.
  if (fulfilmentStatus === 'return_due') return 'due';
  const daysUntilEnd = operationalDaysFromToday(travelEnd);
  if (typeof daysUntilEnd !== 'number' || daysUntilEnd >= 0) return 'not_due';
  return daysUntilEnd < -POCKET_WIFI_RETURN_GRACE_DAYS ? 'overdue' : 'due';
}
