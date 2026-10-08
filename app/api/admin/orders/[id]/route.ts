import { NextResponse } from 'next/server';
import { createStripeClient } from '@/lib/stripeClient';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { fulfilmentNotificationActionable, validFulfilmentStatus, validFulfilmentTransition } from '@/lib/orderLifecycle';
import { validateQyRoamSession } from '@/lib/qyRoamSession';
import { deliverFulfilmentNotification, deliverMetaPurchase } from '@/app/api/stripe-webhook/route';
import { InvalidRequestBodyLengthError, isJsonRequestContentType, readLimitedRequestText, RequestBodyTimeoutError, RequestBodyTooLargeError } from '@/lib/requestBody';
import { hasRequiredStripeCheckoutConfig } from '@/lib/productionReadiness';
import { stripeEventMatchesConfiguredMode } from '@/lib/stripeCheckoutConfig';
import { hasRequiredMetaCapiPurchaseConfig } from '@/lib/runtimeConfig';
import { digitalDeliveryReferenceIssue, normalizeDigitalDeliveryReference } from '@/lib/digitalDeliveryReference';
import { validStripeCheckoutSessionId, validStripeCheckoutSessionIdForMode } from '@/lib/stripeSessionId';
import { validStripePaymentEventCreated } from '@/lib/stripeEventCreated';
import { custodyReferenceIssue, normalizeCustodyReference } from '@/lib/custodyReference';
import { durableOrderMatchesPaidSession } from '@/lib/durableOrderSnapshot';

export const runtime = 'nodejs';

// Order transitions have a deliberately small, fixed payload. Do not rely on
// an upstream proxy limit here: this authenticated route is still reachable by
// a stale browser session, and an unbounded `req.json()` can exhaust an admin
// worker before the request is rejected.
const MAX_ADMIN_ORDER_BODY_BYTES = 8_192;
const ADMIN_ORDER_BODY_TIMEOUT_MS = 15_000;
// Manual sales can already carry up to 1,500 characters of source/support
// context plus the application-authored payment reference. Leave enough room
// to append required cancellation evidence without deleting that audit trail.
// The database RPCs and table constraint enforce the same cap.
const MAX_ORDER_NOTES_LENGTH = 2_500;

function trackingValue(value: unknown, existing: string | null) {
  // Keep an already-recorded reference when an older admin client submits no
  // tracking field, but treat whitespace as absent. A physical dispatch or
  // return without a reference cannot be reliably followed up by operations
  // or the customer.
  if (typeof value !== 'string') return normalizeCustodyReference(existing);
  return normalizeCustodyReference(value);
}

function digitalDeliveryReference(value: unknown, existing: string | null) {
  // This is deliberately an audit pointer, not the eSIM QR code, activation
  // string, or other customer credential. Keeping it short also makes it safe
  // to show to authorised operations staff without turning the order table
  // into a secrets store.
  if (typeof value !== 'string') return normalizeDigitalDeliveryReference(existing);
  return normalizeDigitalDeliveryReference(value);
}

function cancellationReason(value: unknown) {
  if (typeof value !== 'string') return '';
  const reason = value.trim();
  if (reason.length < 5 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) return '';
  return reason;
}

function notesWithCancellationReason(existing: unknown, reason: string) {
  const evidence = `Cancellation reason: ${reason}`;
  const previous = typeof existing === 'string' ? existing.trim() : '';
  if (!previous) return evidence;
  // Cancellation is a financial reconciliation boundary. Never silently
  // discard payment/source or support context merely to make the evidence
  // fit; reject an unexpectedly oversized legacy row below instead.
  return `${previous}\n${evidence}`;
}

function pocketWifiTransitionError(message: string) {
  // PostgREST can attach SQL, proxy, or connection context to an RPC error.
  // This route is a browser-facing operations boundary, so expose only the
  // small set of deliberate, actionable conflicts from the database function.
  // Everything else is a server failure with a stable response; the database
  // remains the authority when two operators update the same order.
  if (/changed since it was loaded/i.test(message)) {
    return { status: 409, error: 'Order changed since it was loaded. Refresh before updating it.' };
  }
  if (/out of stock|not available for dispatch/i.test(message)) {
    return { status: 409, error: 'The selected Pocket WiFi inventory item is not available for dispatch.' };
  }
  if (/inventory item not found|has no inventory item/i.test(message)) {
    return { status: 409, error: 'The assigned Pocket WiFi inventory item is unavailable. Refresh the order before updating it.' };
  }
  if (/required before dispatch|required before receipt|cannot be returned without a recorded dispatch/i.test(message)) {
    return { status: 409, error: 'Required Pocket WiFi dispatch or return evidence is missing. Refresh the order and record the operational reference.' };
  }
  if (/evidence exists before the (dispatch|return) transition/i.test(message)) {
    return { status: 409, error: 'Existing Pocket WiFi custody evidence needs reconciliation before this transition can be recorded.' };
  }
  if (/invalid Pocket WiFi fulfilment transition|only paid Pocket WiFi orders can be transitioned here|order not found/i.test(message)) {
    return { status: 409, error: 'This Pocket WiFi order can no longer make the requested transition. Refresh before updating it.' };
  }
  if (/cancellation evidence is immutable/i.test(message)) {
    return { status: 409, error: 'The original paid-order cancellation reason is immutable. Keep it in the notes and record any correction separately.' };
  }
  return null;
}

function esimTransitionError(message: string) {
  if (/changed since it was loaded/i.test(message)) {
    return { status: 409, error: 'Order changed since it was loaded. Refresh before updating it.' };
  }
  if (/delivery reference is required/i.test(message)) {
    return { status: 409, error: 'A delivery reference is required before marking this eSIM order fulfilled.' };
  }
  if (/invalid eSIM fulfilment transition|only paid eSIM orders can be transitioned here|order not found/i.test(message)) {
    return { status: 409, error: 'This eSIM order can no longer make the requested transition. Refresh before updating it.' };
  }
  if (/cancellation evidence is immutable/i.test(message)) {
    return { status: 409, error: 'The original paid-order cancellation reason is immutable. Keep it in the notes and record any correction separately.' };
  }
  return null;
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: 'Order database not configured' }, { status: 503 });

  if (!isJsonRequestContentType(req.headers.get('content-type'))) {
    return NextResponse.json({ error: 'Expected JSON request' }, { status: 415 });
  }
  let body: Record<string, unknown>;
  try {
    const raw = await readLimitedRequestText(req, MAX_ADMIN_ORDER_BODY_BYTES, ADMIN_ORDER_BODY_TIMEOUT_MS);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JSON object');
    body = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
    if (error instanceof InvalidRequestBodyLengthError) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    if (error instanceof RequestBodyTimeoutError) return NextResponse.json({ error: 'Request timed out. Please try again.' }, { status: 408 });
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const status = String(body.status || '');
  const expectedUpdatedAt = typeof body.expected_updated_at === 'string' ? body.expected_updated_at : '';
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
  if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) return NextResponse.json({ error: 'Invalid order version. Refresh before updating it.' }, { status: 400 });

  const existing = await supabase.from('orders').select('product_type,payment_status,fulfilment_status,dispatched_at,returned_at,courier_tracking,return_tracking,digital_delivery_reference,notes').eq('id', id).maybeSingle();
  if (existing.error) return NextResponse.json({ error: 'Unable to load order' }, { status: 500 });
  if (!existing.data) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (!validFulfilmentStatus(existing.data.product_type, status)) return NextResponse.json({ error: 'Invalid fulfilment status for this order' }, { status: 400 });
  if (existing.data.payment_status !== 'paid') {
    return NextResponse.json({ error: 'Only paid orders can be updated for fulfilment' }, { status: 409 });
  }
  if (!validFulfilmentTransition(existing.data.product_type, existing.data.fulfilment_status, status)) {
    return NextResponse.json({ error: 'This fulfilment transition is not allowed for the current order state' }, { status: 409 });
  }

  const courierTracking = trackingValue(body.courier_tracking, existing.data.courier_tracking);
  const returnTracking = trackingValue(body.return_tracking, existing.data.return_tracking);
  const deliveryReference = digitalDeliveryReference(body.digital_delivery_reference, existing.data.digital_delivery_reference);
  const returnDisposition = typeof body.return_disposition === 'string' ? body.return_disposition.trim().toLowerCase() : '';
  const cancelReason = cancellationReason(body.cancellation_reason);
  // Notes are operational audit evidence. Never silently save only a prefix:
  // an older/custom admin client may submit this field even though the current
  // compact UI only adds structured cancellation evidence. Reject an invalid
  // value before either atomic transition RPC so the operator knows that the
  // complete note was not recorded.
  let submittedNotes: string | null = null;
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
    if (typeof body.notes !== 'string' || body.notes.length > MAX_ORDER_NOTES_LENGTH || /\u0000/.test(body.notes)) {
      return NextResponse.json({ error: `Order notes must be text of ${MAX_ORDER_NOTES_LENGTH.toLocaleString()} characters or fewer and cannot contain null characters.` }, { status: 400 });
    }
    submittedNotes = body.notes;
  }
  // Product-specific evidence must not leak across fulfilment workflows. A
  // stale or hand-authored admin client can submit fields that the current UI
  // does not render; accepting router custody data on an eSIM would make the
  // order look physically dispatched/returned to reports and future tooling.
  // Keep the API boundary explicit and let the database constraint below act
  // as the final backstop for service-role writes.
  if (existing.data.product_type === 'esim' && [
    'inventory_item_id',
    'courier_tracking',
    'return_tracking',
    'return_disposition',
  ].some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    return NextResponse.json({ error: 'Physical inventory and courier fields are not valid for an eSIM order' }, { status: 400 });
  }
  if (status === 'cancelled' && existing.data.fulfilment_status !== 'cancelled' && !cancelReason) {
    return NextResponse.json({ error: 'Enter a cancellation reason of 5–500 characters so the paid order can be reconciled.' }, { status: 400 });
  }
  // Cancellation appends immutable financial-reconciliation evidence to the
  // notes already protected by the optimistic version check. A legacy or
  // custom client must not submit a replacement notes value in the same
  // request: previously that value was validated but silently ignored in
  // favour of the database snapshot. Requiring the two edits to be separate
  // makes each write explicit and prevents either the existing audit trail or
  // the operator's newly submitted context from disappearing unnoticed.
  if (cancelReason && submittedNotes !== null) {
    return NextResponse.json({ error: 'Save order-note changes before cancelling, then refresh and submit the cancellation reason separately.' }, { status: 409 });
  }
  const cancellationNotes = cancelReason ? notesWithCancellationReason(existing.data.notes, cancelReason) : null;
  if (cancellationNotes && cancellationNotes.length > MAX_ORDER_NOTES_LENGTH) {
    return NextResponse.json({ error: `The existing order notes leave no safe room for cancellation evidence. Reconcile them to ${MAX_ORDER_NOTES_LENGTH.toLocaleString()} characters or fewer without deleting audit context, then try again.` }, { status: 409 });
  }
  // Courier and receipt references are custody evidence, not editable order
  // notes. Once the corresponding physical boundary has been crossed, a
  // later lifecycle save must not replace the evidence staff used to hand
  // off or receive the exact router. The database trigger below is the final
  // authority; this check gives the operator an actionable response first.
  if (existing.data.product_type === 'pocket_wifi' && existing.data.dispatched_at && typeof body.courier_tracking === 'string' && courierTracking !== trackingValue(undefined, existing.data.courier_tracking)) {
    return NextResponse.json({ error: 'The courier tracking reference is immutable after a Pocket WiFi order is dispatched. Record corrections in the order notes.' }, { status: 409 });
  }
  if (existing.data.product_type === 'pocket_wifi' && existing.data.returned_at && typeof body.return_tracking === 'string' && returnTracking !== trackingValue(undefined, existing.data.return_tracking)) {
    return NextResponse.json({ error: 'The return receipt reference is immutable after a Pocket WiFi order is received. Record corrections in the order notes.' }, { status: 409 });
  }
  if (existing.data.product_type === 'pocket_wifi' && typeof body.courier_tracking === 'string' && courierTracking) {
    const referenceIssue = custodyReferenceIssue(courierTracking);
    if (referenceIssue) return NextResponse.json({ error: referenceIssue }, { status: 400 });
  }
  if (existing.data.product_type === 'pocket_wifi' && typeof body.return_tracking === 'string' && returnTracking) {
    const referenceIssue = custodyReferenceIssue(returnTracking);
    if (referenceIssue) return NextResponse.json({ error: referenceIssue }, { status: 400 });
  }
  if (existing.data.product_type === 'esim' && status === 'fulfilled' && !deliveryReference) {
    return NextResponse.json({ error: 'A delivery reference is required before marking an eSIM order fulfilled. Record a provider order ID or secure delivery/email log reference, not the eSIM QR code.' }, { status: 400 });
  }
  if (existing.data.product_type === 'esim' && typeof body.digital_delivery_reference === 'string') {
    const referenceIssue = digitalDeliveryReferenceIssue(deliveryReference);
    if (referenceIssue) return NextResponse.json({ error: referenceIssue }, { status: 400 });
    // A fulfilled eSIM is an irreversible hand-off. Its audit pointer must
    // remain stable so later edits cannot hide the actual delivery record or
    // replace it with a credential. Corrections belong in the support/refund
    // record, not in this fulfilment ledger.
    if (['fulfilled', 'closed'].includes(existing.data.fulfilment_status) && deliveryReference !== normalizeDigitalDeliveryReference(existing.data.digital_delivery_reference)) {
      return NextResponse.json({ error: 'The delivery reference is immutable after an eSIM order is fulfilled or closed. Record any correction in the support/refund log.' }, { status: 409 });
    }
  }
  if (existing.data.product_type === 'esim' && status === 'fulfilled') {
    const referenceIssue = digitalDeliveryReferenceIssue(deliveryReference);
    if (referenceIssue) return NextResponse.json({ error: `${referenceIssue} Record a provider order ID or secure delivery/email log reference, not the eSIM QR code.` }, { status: 400 });
  }
  if (existing.data.product_type === 'pocket_wifi' && status === 'dispatched' && !courierTracking) {
    return NextResponse.json({ error: 'Courier tracking or delivery reference is required before dispatching a Pocket WiFi order' }, { status: 400 });
  }
  // `returned` is the inventory-release boundary. Require an operator to
  // record the courier tracking/reference first so a missing device cannot be
  // accidentally made available for another overlapping booking.
  if (existing.data.product_type === 'pocket_wifi' && status === 'returned' && !returnTracking) {
    return NextResponse.json({ error: 'Return tracking or receipt reference is required before marking a Pocket WiFi order returned' }, { status: 400 });
  }
  if (existing.data.product_type === 'pocket_wifi' && status === 'returned' && !['restock', 'quarantine', 'damaged'].includes(returnDisposition)) {
    return NextResponse.json({ error: 'Choose whether the returned Pocket WiFi unit is restocked, quarantined, or damaged' }, { status: 400 });
  }

  if (existing.data.product_type === 'pocket_wifi') {
    const selectedInventoryItemId = body.inventory_item_id === undefined || body.inventory_item_id === ''
      ? null
      : Number(body.inventory_item_id);
    if (selectedInventoryItemId !== null && (!Number.isSafeInteger(selectedInventoryItemId) || selectedInventoryItemId < 1)) {
      return NextResponse.json({ error: 'Invalid Pocket WiFi inventory item' }, { status: 400 });
    }
    // Dispatch/return update both ledgers inside the database transaction. This
    // is the physical inventory boundary, so do not fall back to a plain order
    // update if the new RPC has not been deployed yet.
    const { data, error } = await supabase.rpc('qy_transition_pocket_wifi_order', {
      p_order_id: id,
      p_expected_status: existing.data.fulfilment_status,
      p_expected_updated_at: expectedUpdatedAt,
      p_next_status: status,
      p_courier_tracking: typeof body.courier_tracking === 'string' ? courierTracking : null,
      p_return_tracking: typeof body.return_tracking === 'string' ? returnTracking : null,
      p_notes: cancellationNotes || submittedNotes,
      p_inventory_item_id: selectedInventoryItemId,
      p_return_disposition: returnDisposition,
    });
    if (error) {
      const transitionError = pocketWifiTransitionError(error.message || '');
      if (transitionError) return NextResponse.json({ error: transitionError.error }, { status: transitionError.status });
      // Do not expose a raw PostgREST/RPC message. Provider and database
      // errors can contain query details or values supplied by another admin
      // client, neither of which is an actionable browser response.
      console.error('admin_pocket_wifi_transition_error');
      return NextResponse.json({ error: 'Unable to update order. Please try again or contact an administrator.' }, { status: 500 });
    }
    const order = Array.isArray(data) ? data[0] : data;
    if (!order?.id) return NextResponse.json({ error: 'Unable to update order' }, { status: 500 });
    return NextResponse.json({ id: order.id, fulfilment_status: order.fulfilment_status, updated_at: order.updated_at }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // A digital hand-off is irreversible. Bind the paid-order check, expected
  // state, lifecycle edge and audit reference under one database row lock.
  const { data, error } = await supabase.rpc('qy_transition_esim_order', {
    p_order_id: id,
    p_expected_status: existing.data.fulfilment_status,
    p_expected_updated_at: expectedUpdatedAt,
    p_next_status: status,
    p_digital_delivery_reference: typeof body.digital_delivery_reference === 'string' ? deliveryReference || null : null,
    p_notes: cancellationNotes || submittedNotes,
  });
  if (error) {
    const transitionError = esimTransitionError(error.message || '');
    if (transitionError) return NextResponse.json({ error: transitionError.error }, { status: transitionError.status });
    console.error('admin_esim_transition_error');
    return NextResponse.json({ error: 'Unable to update order. Please try again or contact an administrator.' }, { status: 500 });
  }
  const order = Array.isArray(data) ? data[0] : data;
  if (!order?.id) return NextResponse.json({ error: 'Unable to update order' }, { status: 500 });
  return NextResponse.json({ id: order.id, fulfilment_status: order.fulfilment_status, updated_at: order.updated_at }, { headers: { 'Cache-Control': 'no-store' } });
}

// Stripe retries delivery failures for a finite window. This protected recovery
// action lets an operator safely resume a failed paid-order notification after
// that window: the same per-session ledgers used by the webhook prevent a
// duplicate email or Meta Purchase once either delivery is already marked sent.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return NextResponse.json({ error: 'Order database not configured' }, { status: 503 });
  // Recovery must use the same canonical credential that checkout readiness
  // validates; an accidental trailing newline must not strand a paid-order
  // delivery retry after health has reported Stripe as configured.
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!stripeKey || !hasRequiredStripeCheckoutConfig()) return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 });

  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });

  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('stripe_session_id,payment_status,payment_confirmed_at,product_type,amount_sgd,plan_id,plan_name,data_allowance,country,travel_start,travel_end,fulfilment_status,measurement_consent')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    if (order.payment_status !== 'paid') return NextResponse.json({ error: 'Only paid orders can retry fulfilment notifications' }, { status: 409 });
    // This value is durable operational data, but it can still be from a
    // manual import or a damaged row. Do not use a prefix check here: a
    // malformed or unbounded value must not become an outbound Stripe request
    // when an operator tries to recover a delivery. Manual orders intentionally
    // use a non-Stripe reference and remain outside this recovery workflow.
    const sessionId = validStripeCheckoutSessionId(order.stripe_session_id);
    if (!sessionId) {
      return NextResponse.json({ error: 'Manual orders do not have a Stripe fulfilment notification to retry' }, { status: 409 });
    }

    const stripe = createStripeClient(stripeKey);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    // Stripe should return the requested object, but this is an external
    // recovery boundary with fulfilment and analytics side effects. Keep the
    // durable order reference authoritative if an SDK edge case, test double,
    // or upstream response ever supplies a different Checkout Session.
    if (validStripeCheckoutSessionIdForMode(session.id, session.livemode) !== sessionId) {
      throw new Error('Retrieved Checkout Session does not match the order');
    }
    // Recovery is an operational mutation with external side effects. Keep it
    // on the same Stripe credential-mode boundary as checkout, webhook, and
    // the customer confirmation pages: a misrouted or unexpected test-mode
    // session must never trigger a real fulfilment email or CAPI Purchase.
    if (!stripeEventMatchesConfiguredMode(stripeKey, session.livemode)) {
      throw new Error('Stripe Checkout Session mode does not match configured credential');
    }
    const validation = validateQyRoamSession(session);
    if (!validation.valid || session.status !== 'complete' || session.payment_status !== 'paid') {
      return NextResponse.json({ error: 'The linked Stripe session is not a valid paid QY Roam order' }, { status: 409 });
    }

    // The Stripe Session is the authority for payment and the signed
    // commercial snapshot, while the database row is the authority for its
    // operational lifecycle. Recovery must prove the complete durable order
    // identity before joining those records for an external side effect. A
    // product-type-only check can attach a valid paid Session to a damaged or
    // incorrectly repaired row for another same-product order, retrying the
    // wrong plan, digital entitlement, amount, destination, or rental dates.
    // Do not repair that mismatch implicitly: operations must reconcile it.
    if (!durableOrderMatchesPaidSession(order, session, validation.productType)) {
      return NextResponse.json({ error: 'The stored order details do not match its signed Stripe session. Reconcile the order before retrying deliveries.' }, { status: 409 });
    }

    // A fulfilment alert asks staff to send a device or digital entitlement.
    // Retrying it after cancellation, physical return, or completion could
    // create an accidental second fulfilment. CAPI is an independent record
    // of the already-paid purchase, however, so it remains recoverable for a
    // consented buyer even when the operational order is no longer actionable.
    const retryFulfilment = fulfilmentNotificationActionable(validation.productType, order.fulfilment_status);
    const metaRequested = order.measurement_consent === 'accepted' && session.metadata?.measurement_consent === 'accepted';
    // The webhook intentionally treats Meta as optional so a missing campaign
    // integration cannot block customer fulfilment. Preserve that separation
    // during manual recovery too: a consented Purchase can remain pending
    // while an independently actionable operations email is retried. When
    // Meta is the only remaining delivery, fail explicitly rather than claim
    // that an unconfigured CAPI destination was recovered.
    const metaConfigured = hasRequiredMetaCapiPurchaseConfig();
    if (!retryFulfilment && metaRequested && !metaConfigured) {
      return NextResponse.json({ error: 'Meta CAPI is not configured, so this consented Purchase cannot be retried yet.' }, { status: 503 });
    }
    const retryMeta = metaRequested && metaConfigured;
    if (!retryFulfilment && !retryMeta) {
      return NextResponse.json({ error: 'This order no longer needs a fulfilment or consented analytics delivery retry' }, { status: 409 });
    }

    // The delivery ledgers preserve the original webhook event timestamp and
    // make each selected side effect independently retry-safe. If a previous
    // attempt failed before it created the Meta row, use the first signed
    // payment-confirmation time persisted by the webhook. Session creation
    // remains a stable fallback only for legacy orders.
    const hasPaymentConfirmedAt=order.payment_confirmed_at!==null&&order.payment_confirmed_at!==undefined;
    const confirmedAtMs=typeof order.payment_confirmed_at==='string'
      ? new Date(order.payment_confirmed_at).getTime()
      : Number.NaN;
    const confirmedAtSeconds=Number.isFinite(confirmedAtMs) ? Math.floor(confirmedAtMs/1000) : null;
    // Apply the webhook's timestamp boundary to manual recovery too. A
    // damaged/imported payment timestamp must not create a pre-Checkout or
    // far-future Meta Purchase. Only a genuinely absent timestamp may use the
    // Session creation time for a legacy order; an explicitly stored but
    // invalid value is an operational conflict that must be reconciled rather
    // than silently rewritten during delivery recovery.
    const metaEventTime=hasPaymentConfirmedAt
      ? validStripePaymentEventCreated(confirmedAtSeconds,session.created)
      : validStripePaymentEventCreated(session.created,session.created);
    if (retryMeta && !metaEventTime) {
      return NextResponse.json({ error: 'The payment timestamp is invalid. Reconcile the order before retrying analytics delivery.' }, { status: 409 });
    }
    const deliveries = await Promise.allSettled([
      ...(retryFulfilment ? [deliverFulfilmentNotification(supabase, session)] : []),
      ...(retryMeta ? [deliverMetaPurchase(supabase, session, metaEventTime!)] : []),
    ]);
    const failures = deliveries.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'One or more order deliveries failed');
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // Stripe, SMTP, CAPI and PostgREST failures can echo request, customer,
    // or configuration details. The delivery ledgers retain safe diagnostics
    // for operators, so keep server logs to a stable event name here.
    console.error('admin_order_notification_retry_error');
    return NextResponse.json({ error: 'Unable to retry order notifications. Please try again shortly.' }, { status: 500 });
  }
}
