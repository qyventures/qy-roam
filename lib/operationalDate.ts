// Pocket WiFi delivery and return operations are run from Singapore. Calendar
// dates entered at checkout must therefore be compared against Singapore's
// calendar, rather than the server's UTC day or the visitor's local timezone.
export const OPERATIONAL_TIME_ZONE = 'Asia/Singapore';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: OPERATIONAL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Return the operational calendar date as a canonical YYYY-MM-DD string. */
export function operationalIsoDate(now = new Date()) {
  if (Number.isNaN(now.getTime())) throw new Error('Invalid operational clock');
  const parts = formatter.formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = value('year'), month = value('month'), day = value('day');
  if (!year || !month || !day) throw new Error('Unable to determine operational date');
  return `${year}-${month}-${day}`;
}

/** Add calendar days to Singapore's current date without daylight-saving drift. */
export function operationalIsoDateAfter(days: number, now = new Date()) {
  if (!Number.isSafeInteger(days)) throw new Error('Invalid operational day offset');
  const date = new Date(`${operationalIsoDate(now)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Return the number of Singapore calendar days from today to a canonical
 * YYYY-MM-DD operational date. This deliberately compares date-only values
 * as UTC midnights after deriving "today" in Singapore; parsing a formatted
 * Singapore clock time in the host timezone can otherwise move an operations
 * exception by a day on a non-Singapore server.
 */
export function operationalDaysFromToday(value: string | null | undefined, now = new Date()) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const target = new Date(`${value}T00:00:00Z`);
  // Date normalisation (for example, 2026-02-30) must not quietly turn into
  // a different trip day in a fulfilment exception view.
  if (Number.isNaN(target.getTime()) || target.toISOString().slice(0, 10) !== value) return null;
  const today = new Date(`${operationalIsoDate(now)}T00:00:00Z`);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}
