import { validStripeEventId } from './stripeEventId';
import { validStripeCheckoutSessionId } from './stripeSessionId';
import { POSTGRES_INTEGER_MAX } from './retryAttempt';

const DELIVERY_STATUSES = new Set(['pending', 'sending', 'sent']);
const STRIPE_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);
const MAX_FAILURE_LENGTH = 500;

function exactTimestamp(value: unknown) {
  // Postgres timestamptz is an audit token here, not display-only text. Keep
  // the accepted form aligned with PostgREST's ISO response so permissive
  // Date.parse inputs (date-only values, local times, or prose) cannot enter
  // recovery chronology comparisons as plausible operational evidence.
  if (typeof value !== 'string' || value.length < 20 || value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = Date.parse(value);
  const year = new Date(instant).getUTCFullYear();
  return Number.isFinite(instant) && year >= 2000 && year <= 2200 ? value : null;
}

function nullableTimestamp(value: unknown) {
  return value === null ? null : exactTimestamp(value);
}

function validAttempts(value: unknown, minimum: number) {
  // These are PostgreSQL `integer` ledgers. The workers deliberately
  // saturate at that storage ceiling so a long-lived or inherited record
  // remains retryable. Accept the same complete domain here: imposing a
  // smaller display-only ceiling would make a valid recovery row disappear
  // from the operations dashboard exactly when it needs reconciliation.
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= POSTGRES_INTEGER_MAX
    ? value as number
    : null;
}

function validFailure(value: unknown) {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= MAX_FAILURE_LENGTH && !/[\u0000-\u001f\u007f]/.test(value));
}

export function validatedDeliveryLedgerRow(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const sessionId = validStripeCheckoutSessionId(row.stripe_session_id);
  const attempts = validAttempts(row.attempts, 0);
  const lastAttemptAt = nullableTimestamp(row.last_attempt_at);
  const sentAt = nullableTimestamp(row.sent_at);
  if (!sessionId || attempts === null || typeof row.status !== 'string' || !DELIVERY_STATUSES.has(row.status) ||
    lastAttemptAt === null && row.last_attempt_at !== null || sentAt === null && row.sent_at !== null ||
    !validFailure(row.last_error) || (row.status === 'sent') !== Boolean(sentAt) ||
    (row.last_error !== null && (row.status !== 'pending' || attempts < 1))) return null;
  // Mirror the database delivery state machine. A provider hand-off cannot be
  // sending, failed, or sent without an audited attempt; an untouched pending
  // row cannot carry attempt evidence; and success cannot predate its claim.
  // Rejecting impossible legacy/repair rows makes the admin panel fail loudly
  // instead of reporting an unaudited irreversible delivery as healthy.
  if (attempts === 0) {
    if (row.status !== 'pending' || lastAttemptAt || sentAt || row.last_error !== null) return null;
  } else {
    if (!lastAttemptAt) return null;
    if (row.status === 'pending' && row.last_error === null) return null;
  }
  if (sentAt && lastAttemptAt && Date.parse(sentAt) < Date.parse(lastAttemptAt)) return null;
  return { ...row, stripe_session_id: sessionId, status: row.status, attempts, last_attempt_at: lastAttemptAt, sent_at: sentAt, last_error: row.last_error as string | null };
}

export function validatedStripeEventRecoveryRow(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const rawEventId = typeof row.event_id === 'string' && row.event_id.startsWith('stripe:') ? row.event_id.slice(7) : null;
  const eventId = validStripeEventId(rawEventId);
  const sessionId = validStripeCheckoutSessionId(row.stripe_session_id);
  const attempts = validAttempts(row.attempts, 1);
  const receivedAt = exactTimestamp(row.received_at);
  const processingStartedAt = exactTimestamp(row.processing_started_at);
  const lastFailedAt = nullableTimestamp(row.last_failed_at);
  if (!eventId || !sessionId || attempts === null || typeof row.event_type !== 'string' || !STRIPE_EVENT_TYPES.has(row.event_type) ||
    !receivedAt || !processingStartedAt || lastFailedAt === null && row.last_failed_at !== null ||
    !validFailure(row.last_error) || (row.last_error !== null) !== Boolean(lastFailedAt)) return null;
  // A claim can be refreshed by a retry, but it can never begin before the
  // event was first received. Failure evidence belongs to that exact claim
  // and therefore cannot predate it either.
  if (Date.parse(processingStartedAt) < Date.parse(receivedAt) ||
    lastFailedAt && Date.parse(lastFailedAt) < Date.parse(processingStartedAt)) return null;
  return { ...row, event_id: `stripe:${eventId}`, event_type: row.event_type, stripe_session_id: sessionId, received_at: receivedAt, attempts, processing_started_at: processingStartedAt, last_failed_at: lastFailedAt, last_error: row.last_error as string | null };
}
