// Operational timestamps are decisions, not decoration: staff use them to
// release checkout holds, follow up with customers and reconcile stock. Keep
// them independent of the VPS/container timezone and fail visibly on malformed
// legacy values instead of rendering "Invalid Date" or a plausible local time.
const singaporeTimestampFormatter = new Intl.DateTimeFormat('en-SG', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const singaporeDateFormatter = new Intl.DateTimeFormat('en-SG', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

function validInstant(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatSingaporeTimestamp(value: unknown, fallback = '—') {
  const timestamp = validInstant(value);
  return timestamp === null ? fallback : singaporeTimestampFormatter.format(timestamp);
}

export function formatSingaporeDate(value: unknown, fallback = '—') {
  const timestamp = validInstant(value);
  return timestamp === null ? fallback : singaporeDateFormatter.format(timestamp);
}
