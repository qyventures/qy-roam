import { validStripeEventId } from './stripeEventId';
import { validStripeCheckoutSessionId } from './stripeSessionId';

const DELIVERY_STATUSES = new Set(['pending', 'sending', 'sent']);
const STRIPE_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);
const MAX_ATTEMPTS = 1_000_000;
const MAX_FAILURE_LENGTH = 500;

function exactTimestamp(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? value : null;
}

function nullableTimestamp(value: unknown) {
  return value === null ? null : exactTimestamp(value);
}

function validAttempts(value: unknown, minimum: number) {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= MAX_ATTEMPTS
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
  return { ...row, event_id: `stripe:${eventId}`, event_type: row.event_type, stripe_session_id: sessionId, received_at: receivedAt, attempts, processing_started_at: processingStartedAt, last_failed_at: lastFailedAt, last_error: row.last_error as string | null };
}
