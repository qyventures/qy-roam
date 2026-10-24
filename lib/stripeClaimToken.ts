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

// PostgreSQL may render the same timestamptz with a different UTC offset and
// up to microsecond precision. Compare the represented instant without
// weakening the exact-token rule used for ownership predicates. This is used
// for write acknowledgements, where accepting merely "some valid timestamp"
// could let a stale or transformed gateway response appear to confirm the
// value the application just committed.
export function databaseTimestampInstantEquals(left: unknown, right: unknown) {
  const leftToken = exactDatabaseTimestampToken(left);
  const rightToken = exactDatabaseTimestampToken(right);
  if (!leftToken || !rightToken) return false;

  return databaseTimestampEpochMicroseconds(leftToken) === databaseTimestampEpochMicroseconds(rightToken);
}

function databaseTimestampEpochMicroseconds(token: string) {
  const fractional = /\.(\d{1,6})/.exec(token)?.[1] || '';
  const subMillisecond = Number(fractional.padEnd(6, '0').slice(3, 6));
  return BigInt(new Date(token).getTime()) * BigInt(1_000) + BigInt(subMillisecond);
}

/**
 * Compare two exact PostgreSQL timestamptz values without losing the final
 * three fractional digits to JavaScript Date. Lifecycle acknowledgements use
 * this to reject a syntactically valid response whose completion/failure time
 * predates the database lease it claims to have settled.
 */
export function databaseTimestampInstantIsAtOrAfter(value: unknown, boundary: unknown) {
  const valueToken = exactDatabaseTimestampToken(value);
  const boundaryToken = exactDatabaseTimestampToken(boundary);
  if (!valueToken || !boundaryToken) return false;
  return databaseTimestampEpochMicroseconds(valueToken) >= databaseTimestampEpochMicroseconds(boundaryToken);
}

// Retain the domain-specific name at existing Stripe event call sites while
// sharing the exact, non-normalising database timestamp boundary with other
// compare-and-swap leases.
export const exactStripeClaimToken = exactDatabaseTimestampToken;
