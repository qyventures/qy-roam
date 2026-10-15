// Postgres timestamps can carry six fractional-second digits while JavaScript
// Date retains only three. The database-issued claim timestamp is also the
// compare-and-swap ownership token, so validate it without normalising it.
export function exactDatabaseTimestampToken(value: unknown) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 64 || value !== value.trim()) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

// Retain the domain-specific name at existing Stripe event call sites while
// sharing the exact, non-normalising database timestamp boundary with other
// compare-and-swap leases.
export const exactStripeClaimToken = exactDatabaseTimestampToken;
