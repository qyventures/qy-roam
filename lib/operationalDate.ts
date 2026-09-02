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
