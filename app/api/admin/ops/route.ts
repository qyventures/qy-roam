import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { initialFulfilmentStatus, validFulfilmentStatus } from '@/lib/orderLifecycle';
import { parseExactIsoDate } from '@/lib/checkoutValidation';
import { operationalConfig } from '@/lib/operationalConfig';
import { hasIdentityRequestContentEncoding, InvalidRequestBodyLengthError, isJsonRequestContentType, readLimitedRequestText, RequestBodyTimeoutError, RequestBodyTooLargeError, validateLimitedRequestContentLength } from '@/lib/requestBody';
import { isSafeSmtpMailbox } from '@/lib/smtp';
import { getEsimPlan } from '@/lib/esimPlans';
import { manualOrderReference, manualOrderSessionId } from '@/lib/manualOrderReference';
import { tryAcquireAdminOpsConcurrency } from '@/lib/adminOpsConcurrency';
import { MAX_POCKET_WIFI_RENTAL_DAYS, pocketWifiRentalDays } from '@/lib/pocketWifiRentalPeriod';
import { acknowledgedInventoryMutation } from '@/lib/inventoryMutation';
import { acknowledgedManualOrder } from '@/lib/manualOrderAcknowledgement';
import { acknowledgedClosingPeriod } from '@/lib/closingPeriodAcknowledgement';
import { acknowledgedAdminRecord } from '@/lib/adminRecordAcknowledgement';
import { validAdminOperationId } from '@/lib/adminOperationId';
import { inventoryMutationFailure } from '@/lib/inventoryMutationFailure';
import { normalizedCustomerPhone } from '@/lib/customerPhone';
import { createAdminOpsDeadline } from '@/lib/adminOpsDeadline';

export const dynamic = 'force-dynamic';

// Admin requests can include reconciliation notes, but should remain small.
// Basic authentication is not a worker-safety boundary: a malformed or
// stalled authenticated request must not be able to retain a Node worker
// indefinitely while awaiting req.json().
const MAX_ADMIN_OPS_BODY_BYTES = 16 * 1024;
const ADMIN_OPS_BODY_TIMEOUT_MS = 15_000;
// PostgREST/Supabase commonly caps a single response at 1,000 rows. Closing
// a sales period is an accounting operation, so it must never treat that
// transport page as the complete ledger. Keep the operational request
// bounded, but fail loudly once it exceeds the amount this request can read
// safely instead of recording an understated close.
const CLOSING_ORDER_PAGE_SIZE = 1_000;
const MAX_CLOSING_ORDERS = 50_000;

function text(v: unknown, max = 500) { return String(v ?? '').trim().slice(0, max); }
function optionalSingleLineText(value: unknown, max: number) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value || null;
}
function optionalTrimmedText(value: unknown, max: number) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}
function money(value: unknown) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [dollars, fraction = ''] = raw.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 10_000_000 ? cents : null;
}

// Operational reports are business records, not display-only estimates. Keep
// their numeric boundary explicit: `Number('invalid') || 0` would silently
// turn a malformed refund, fee, COGS, or forecast into a plausible zero.
function nonNegativeMoney(value: unknown) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [dollars, fraction = ''] = raw.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 10_000_000 ? cents : null;
}

function nonNegativeInteger(value: unknown) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= 1_000_000 ? parsed : null;
}

function signedNonZeroInteger(value: unknown) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^-?\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed !== 0 && Math.abs(parsed) <= 1_000_000 ? parsed : null;
}

function positiveSafeInteger(value: unknown) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function optionalPositiveSafeInteger(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  return positiveSafeInteger(value);
}

function exactPercentage(value: unknown) {
  const parsed = nonNegativeInteger(value);
  return parsed !== null && parsed <= 100 ? parsed : null;
}

// Admin browsers submit datetime-local values without an offset. Operations
// are run on the Singapore business calendar, so make that interpretation
// explicit before persisting a timestamptz. Accept an offset-bearing ISO value
// from intentional API clients too, but reject normalized dates (31 February,
// hour 24, and similar) instead of letting the database/provider reinterpret
// them differently.
function optionalOperationalDateTime(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value !== value.trim() || value.length > 35) return undefined;
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  const candidate = local ? `${value}${local[6] ? '' : ':00'}+08:00` : value;
  if (!local && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(candidate)) return undefined;
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  if (local) {
    const [year, month, day, hour, minute, second = '00'] = local.slice(1);
    const singapore = new Date(parsed.getTime() + 8 * 60 * 60 * 1000);
    if (
      singapore.getUTCFullYear() !== Number(year) || singapore.getUTCMonth() + 1 !== Number(month) ||
      singapore.getUTCDate() !== Number(day) || singapore.getUTCHours() !== Number(hour) ||
      singapore.getUTCMinutes() !== Number(minute) || singapore.getUTCSeconds() !== Number(second)
    ) return undefined;
  }
  return parsed.toISOString();
}

function validInventoryReference(value: string) {
  return value.length >= 1 && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
}

function optionalTravelDates(body: Record<string, unknown>) {
  const startRaw = text(body.travel_start, 10);
  const endRaw = text(body.travel_end, 10);
  if (!startRaw && !endRaw) return { start: null, end: null };
  const start = parseExactIsoDate(startRaw), end = parseExactIsoDate(endRaw);
  if (!start || !end || end < start) return null;
  return { start: startRaw, end: endRaw };
}

async function paidOrderGrossForPeriod(db: ReturnType<typeof getSupabaseAdmin>, start: string, end: string, signal: AbortSignal) {
  if (!db) throw new Error('Database unavailable');
  let grossCents = 0;
  let afterId: number | null = null;
  let loaded = 0;
  for (;;) {
    let query = db
      .from('orders')
      .select('id,amount_sgd')
      .eq('payment_status', 'paid')
      // Checkout can be opened on one accounting day and settle on another
      // (notably for asynchronous methods). A period close is a cash-sales
      // record, so group revenue by the immutable Stripe/manual payment
      // confirmation boundary rather than when the draft order was created.
      .gte('payment_confirmed_at', `${start}T00:00:00+08:00`)
      .lte('payment_confirmed_at', `${end}T23:59:59+08:00`)
      // Page on the immutable primary key. Offset pages without a stable
      // identity can overlap or skip rows when webhook settlements arrive
      // while an operator is preparing the close.
      .order('id')
      .limit(CLOSING_ORDER_PAGE_SIZE)
      .abortSignal(signal);
    if (afterId !== null) query = query.gt('id', afterId);
    const { data: orders, error } = await query;
    if (error) throw error;
    const page = orders || [];
    for (const order of page as { id: unknown; amount_sgd: unknown }[]) {
      const amountCents = nonNegativeMoney(order.amount_sgd);
      // This is the source ledger for an accounting close. A malformed
      // service-role import must not be silently coerced to zero or rounded
      // through binary floating-point arithmetic into a plausible total.
      if (amountCents === null) throw new Error('Paid order has an invalid accounting amount');
      grossCents += amountCents;
      if (!Number.isSafeInteger(grossCents) || grossCents > 10_000_000_000) {
        throw new Error('Accounting period gross exceeds the supported total');
      }
    }
    if (page.length < CLOSING_ORDER_PAGE_SIZE) return grossCents / 100;
    const nextId = positiveSafeInteger(page[page.length - 1]?.id);
    if (nextId === null || nextId === afterId) throw new Error('Paid-order ledger returned an invalid pagination cursor');
    afterId = nextId;
    loaded += page.length;
    if (loaded >= MAX_CLOSING_ORDERS) {
      throw new Error(`Sales period has ${MAX_CLOSING_ORDERS.toLocaleString()} or more paid orders. Close it from the audited reporting workflow before recording this period.`);
    }
  }
}

export async function POST(req: NextRequest) {
  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
  if (!isJsonRequestContentType(req.headers.get('content-type'))) {
    return NextResponse.json({ error: 'Expected JSON request' }, { status: 415 });
  }
  // The byte and exact Content-Length limits below apply to the representation
  // exposed by the runtime. Refuse content codings so proxy decompression
  // cannot turn a small declared admin request into a larger mutation body.
  if (!hasIdentityRequestContentEncoding(req.headers.get('content-encoding'))) {
    return NextResponse.json({ error: 'Unsupported request content encoding' }, { status: 415 });
  }
  // Reject an impossible declared size before entering the streaming reader.
  // An authenticated client can otherwise hold this route until the upload
  // deadline even though its headers already prove the mutation is invalid.
  try {
    validateLimitedRequestContentLength(req, MAX_ADMIN_OPS_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  let raw: string;
  try {
    raw = await readLimitedRequestText(req, MAX_ADMIN_OPS_BODY_BYTES, ADMIN_OPS_BODY_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
    if (error instanceof InvalidRequestBodyLengthError) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    if (error instanceof RequestBodyTimeoutError) return NextResponse.json({ error: 'Request timed out. Please try again.' }, { status: 408 });
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Invalid request body');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request' }, { status: 400 });
  }
  const action = text(body.action, 60);

  // Read and validate the bounded request body before reserving database-work
  // capacity, so an authenticated slow upload cannot occupy this pool. From
  // here every supported action can issue mutable Supabase work, and period
  // closing can perform many bounded ledger reads; reject excess overlap
  // rather than queueing stale operator mutations behind a long close.
  const releaseAdminOps = tryAcquireAdminOpsConcurrency();
  if (!releaseAdminOps) {
    return NextResponse.json({ error: 'Operations are busy. Please try again shortly.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
    });
  }
  const adminOpsDeadline = createAdminOpsDeadline();

  try {
    if (action === 'order_create') {
      const product = text(body.product_type, 40) || 'pocket_wifi';
      if (product !== 'pocket_wifi' && product !== 'esim') return NextResponse.json({ error: 'Invalid product type' }, { status: 400 });
      const paymentStatus = text(body.payment_status, 40) || 'paid';
      // Manual orders represent an already-confirmed offline sale. There is
      // no payment provider callback (or protected admin transition) that can
      // later settle an unpaid manual record. Allowing one would leave Pocket
      // WiFi in `awaiting_payment` indefinitely and used to consume router
      // capacity forever. Quotes/leads belong in CRM until payment is real.
      if (paymentStatus !== 'paid') return NextResponse.json({ error: 'Manual sales orders can only be recorded after payment is confirmed' }, { status: 400 });
      const reference = manualOrderReference(body.order_reference);
      if (!reference) return NextResponse.json({ error: 'A payment or sales reference of 5–120 letters, numbers, or . _ : / # - characters is required' }, { status: 400 });
      const requestedStatus = text(body.fulfilment_status, 40);
      if (requestedStatus && !validFulfilmentStatus(product, requestedStatus)) return NextResponse.json({ error: 'Invalid fulfilment status for this product' }, { status: 400 });
      const initialStatus = initialFulfilmentStatus(product, paymentStatus);
      // New orders must begin at the same lifecycle boundary as Stripe orders.
      // Dispatch and return evidence can only be added through the guarded
      // order-status endpoint after the order has been created.
      if (requestedStatus && requestedStatus !== initialStatus) return NextResponse.json({ error: 'New orders must start in their initial fulfilment status' }, { status: 400 });
      const travel = optionalTravelDates(body);
      if (!travel) return NextResponse.json({ error: 'Travel dates must be valid ISO dates with the end date on or after the start date' }, { status: 400 });
      const amountCents = money(body.amount_sgd);
      if (amountCents === null) return NextResponse.json({ error: 'Order amount must be a positive amount with no more than two decimal places' }, { status: 400 });
      const customerName = optionalSingleLineText(body.customer_name, 120);
      if (customerName === undefined) return NextResponse.json({ error: 'Customer name must be a single line of at most 120 characters' }, { status: 400 });
      const email = optionalTrimmedText(body.email, 200);
      if (email === undefined) return NextResponse.json({ error: 'Customer email must be at most 200 characters and cannot contain control characters' }, { status: 400 });
      const phone = optionalTrimmedText(body.phone, 32);
      if (phone === undefined) return NextResponse.json({ error: 'Customer phone must be at most 32 characters and cannot contain control characters' }, { status: 400 });
      const submittedNotes = optionalTrimmedText(body.notes, 1500);
      if (submittedNotes === undefined) return NextResponse.json({ error: 'Order notes must be at most 1,500 characters and cannot contain control characters' }, { status: 400 });
      // A manual digital sale creates the same entitlement as Checkout. Bind
      // it to the server catalogue instead of trusting free-text plan fields,
      // which can otherwise leave fulfilment guessing which data package was
      // actually sold. The paid amount remains an operator-entered accounting
      // value because offline/corporate sales can have separately approved
      // pricing, but product identity is never negotiable free text.
      const esimPlan = product === 'esim' ? getEsimPlan(body.plan_id) : undefined;
      if (product === 'esim' && !esimPlan) {
        return NextResponse.json({ error: 'Select a valid eSIM catalogue plan' }, { status: 400 });
      }
      const submittedCountry = optionalTrimmedText(body.country, 120);
      if (submittedCountry === undefined) return NextResponse.json({ error: 'Destination must be at most 120 characters and cannot contain control characters' }, { status: 400 });
      const submittedPlanName = optionalTrimmedText(body.plan_name, 160);
      if (submittedPlanName === undefined) return NextResponse.json({ error: 'Plan name must be at most 160 characters and cannot contain control characters' }, { status: 400 });
      const country = esimPlan?.destination || submittedCountry;
      if (product === 'pocket_wifi' && (!country || !travel.start || !travel.end)) {
        return NextResponse.json({ error: 'Pocket WiFi orders require a destination and valid travel start and end dates' }, { status: 400 });
      }
      if (product === 'pocket_wifi') {
        const rentalDays = pocketWifiRentalDays(
          parseExactIsoDate(travel.start!)!,
          parseExactIsoDate(travel.end!)!,
        );
        if (rentalDays > MAX_POCKET_WIFI_RENTAL_DAYS) {
          return NextResponse.json({ error: `Pocket WiFi rentals cannot exceed ${MAX_POCKET_WIFI_RENTAL_DAYS} days` }, { status: 400 });
        }
      }
      const recordedAt = new Date().toISOString();
      const row = {
        stripe_session_id: manualOrderSessionId(reference),
        payment_status: paymentStatus, customer_name: customerName,
        email: email?.toLowerCase() || null, phone,
        amount_sgd: amountCents / 100, product_type: product,
        plan_id: esimPlan?.id || null,
        plan_name: esimPlan ? `${esimPlan.destination} · ${esimPlan.days} days` : submittedPlanName,
        data_allowance: esimPlan?.data || null,
        country, travel_start: travel.start, travel_end: travel.end,
        fulfilment_status: initialStatus,
        // Manual sales do not have a signed Stripe event timestamp. Record
        // the protected staff-entry time instead so every paid order has a
        // durable payment boundary for revenue reports and later recovery.
        payment_confirmed_at: paymentStatus === 'paid' ? recordedAt : null,
        // Manual sales have no browser measurement-consent flow. Record that
        // explicitly instead of leaving a nullable value that a later report
        // or recovery job could misinterpret as permission to send CAPI.
        measurement_consent: 'essential',
        notes: `Manual order · Reference: ${reference}${submittedNotes ? ` · ${submittedNotes}` : ''}`,
        updated_at: recordedAt
      };
      if (!row.email && !row.phone) return NextResponse.json({ error: 'Customer email or phone is required' }, { status: 400 });
      // A phone-only Pocket WiFi sale is valid, but an email that is supplied
      // becomes durable customer/CRM identity and can later be used for
      // support or fulfilment follow-up. Do not persist a malformed mailbox
      // merely because the same record also has a phone number. eSIM keeps
      // the stricter rule below that a safe email must actually be present.
      if (row.email && !isSafeSmtpMailbox(row.email)) {
        return NextResponse.json({ error: 'Enter a valid customer email or leave it blank for a phone-only Pocket WiFi order' }, { status: 400 });
      }
      if (row.phone && !normalizedCustomerPhone(row.phone)) {
        return NextResponse.json({ error: 'Enter a valid customer phone number or leave it blank when a valid email is supplied' }, { status: 400 });
      }
      // A manual eSIM sale joins the same fulfilment lifecycle as a Stripe
      // sale, but it does not receive Stripe Checkout's required-email field.
      // Do not let an offline entry create an apparently paid digital order
      // with no safe delivery destination: a phone number alone cannot carry
      // the QR code / activation instructions or provide a durable delivery
      // trail. Pocket WiFi remains permitted to use a phone-only offline
      // record because its physical dispatch is coordinated separately.
      if (product === 'esim' && !isSafeSmtpMailbox(row.email || undefined)) {
        return NextResponse.json({ error: 'eSIM orders require a valid customer email for digital delivery' }, { status: 400 });
      }
      if (product === 'pocket_wifi' && paymentStatus === 'paid') {
        // A manual paid rental is a real inventory commitment, not merely an
        // admin record. Let the database create it under the same advisory
        // lock as Checkout reservations so concurrent staff entries cannot
        // oversell an overlapping travel period.
        const config = operationalConfig();
        if (!config) return NextResponse.json({ error: 'Pocket WiFi inventory configuration is unavailable' }, { status: 503 });
        const { data, error } = await db.rpc('qy_create_manual_pocket_wifi_order', {
          p_stripe_session_id: row.stripe_session_id,
          p_customer_name: row.customer_name,
          p_email: row.email,
          p_phone: row.phone,
          p_amount_sgd: row.amount_sgd,
          p_plan_name: row.plan_name,
          p_country: row.country,
          p_travel_start: row.travel_start,
          p_travel_end: row.travel_end,
          p_notes: row.notes,
          p_inventory: config.pocketWifiInventory,
        }).abortSignal(adminOpsDeadline.signal);
        if (error) {
          if (/manual order reference already belongs to different order details/i.test(error.message || '')) {
            return NextResponse.json({ error: 'This payment or sales reference already belongs to different order details. Reconcile the existing order before continuing.' }, { status: 409 });
          }
          throw error;
        }
        if (!acknowledgedManualOrder(data, {
          stripeSessionId: row.stripe_session_id, productType: 'pocket_wifi',
          fulfilmentStatus: initialStatus, amountCents,
          customerName: row.customer_name, email: row.email, phone: row.phone,
          planId: null, planName: row.plan_name, dataAllowance: null,
          country: row.country, travelStart: row.travel_start, travelEnd: row.travel_end,
          notes: row.notes,
        })) throw new Error('Manual Pocket WiFi order acknowledgement mismatch');
      } else {
        // Manual eSIM creation is an irreversible digital entitlement. Keep
        // first insert and exact retry comparison in one database transaction
        // instead of repairing a uniqueness race with a second API query.
        const { data, error } = await db.rpc('qy_create_manual_esim_order', {
          p_stripe_session_id: row.stripe_session_id,
          p_customer_name: row.customer_name,
          p_email: row.email,
          p_phone: row.phone,
          p_amount_sgd: row.amount_sgd,
          p_plan_id: row.plan_id,
          p_plan_name: row.plan_name,
          p_data_allowance: row.data_allowance,
          p_country: row.country,
          p_travel_start: row.travel_start,
          p_travel_end: row.travel_end,
          p_notes: row.notes,
        }).abortSignal(adminOpsDeadline.signal);
        if (error) {
          if (/manual order reference already belongs to different order details/i.test(error.message || '')) {
            return NextResponse.json({ error: 'This payment or sales reference already belongs to different order details. Reconcile the existing order before continuing.' }, { status: 409 });
          }
          throw error;
        }
        if (!acknowledgedManualOrder(data, {
          stripeSessionId: row.stripe_session_id, productType: 'esim',
          fulfilmentStatus: initialStatus, amountCents,
          customerName: row.customer_name, email: row.email, phone: row.phone,
          planId: row.plan_id, planName: row.plan_name, dataAllowance: row.data_allowance,
          country: row.country, travelStart: row.travel_start, travelEnd: row.travel_end,
          notes: row.notes,
        })) throw new Error('Manual eSIM order acknowledgement mismatch');
      }
    } else if (action === 'inventory_create') {
      const operationId = validAdminOperationId(body.operation_id);
      const quantityOnHand = nonNegativeInteger(body.quantity_on_hand);
      const reorderLevel = nonNegativeInteger(body.reorder_level);
      const unitCostCents = nonNegativeMoney(body.unit_cost_sgd);
      const productType = text(body.product_type, 40) || 'pocket_wifi';
      const status = text(body.status, 40).toLowerCase() || 'available';
      if (!operationId) return NextResponse.json({ error: 'Invalid inventory operation identity. Refresh the page before retrying.' }, { status: 400 });
      if (quantityOnHand === null || reorderLevel === null || unitCostCents === null) {
        return NextResponse.json({ error: 'Stock and reorder quantities must be whole non-negative numbers; unit cost must be a non-negative amount with at most two decimal places' }, { status: 400 });
      }
      if (!['pocket_wifi', 'esim'].includes(productType) || !['available', 'quarantined', 'damaged', 'maintenance'].includes(status)) {
        return NextResponse.json({ error: 'Choose a valid inventory product type and status' }, { status: 400 });
      }
      // Inventory identity and custody context are audit records. The older
      // generic `text()` helper truncated these values, so an operator could
      // submit one SKU, serial number, location, or note and receive success
      // for a different stored value. Reject overlong/control-bearing input
      // instead; an idempotent retry must describe the exact same item.
      const sku = optionalSingleLineText(body.sku, 80);
      const name = optionalSingleLineText(body.name, 120);
      const serialNo = optionalSingleLineText(body.serial_no, 120);
      const location = optionalSingleLineText(body.location, 120);
      const inventoryNotes = optionalSingleLineText(body.notes, 1000);
      if (!sku || !name) return NextResponse.json({ error: 'SKU and name are required and must be single-line values within their displayed limits' }, { status: 400 });
      if (serialNo === undefined || location === undefined || inventoryNotes === undefined) {
        return NextResponse.json({ error: 'Inventory details exceed their displayed limits or contain unsupported control characters' }, { status: 400 });
      }
      const row = {
        sku, name, product_type: productType,
        serial_no: serialNo, status,
        quantity_on_hand: quantityOnHand, reorder_level: reorderLevel,
        unit_cost_sgd: unitCostCents / 100, location, notes: inventoryNotes,
        updated_at: new Date().toISOString()
      };
      // Opening stock is a real physical-stock movement. Do not insert the
      // item directly: a later audit would otherwise show its adjustments,
      // dispatch and return records but not how its original saleable balance
      // entered the fleet. The RPC creates the item and its opening movement
      // in one transaction.
      const { data, error } = await db.rpc('qy_create_inventory_item', {
        p_sku: row.sku,
        p_name: row.name,
        p_product_type: row.product_type,
        p_serial_no: row.serial_no,
        p_status: row.status,
        p_quantity_on_hand: row.quantity_on_hand,
        p_reorder_level: row.reorder_level,
        p_unit_cost_sgd: row.unit_cost_sgd,
        p_location: row.location,
        p_notes: row.notes,
        p_operation_id: operationId,
      }).abortSignal(adminOpsDeadline.signal);
      if (error) {
        const failure = inventoryMutationFailure(error);
        if (failure) return NextResponse.json({ error: failure.message }, { status: failure.status });
        throw error;
      }
      if (!acknowledgedInventoryMutation(data, {
        sku: row.sku,
        status: row.status,
        quantityOnHand: row.quantity_on_hand,
      })) {
        return NextResponse.json({ error: 'Unable to verify the saved inventory item. Refresh the stock register before making another change.' }, {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
        });
      }
    } else if (action === 'inventory_adjust') {
      const operationId = validAdminOperationId(body.operation_id);
      const movementType = text(body.movement_type, 40).toLowerCase() || 'adjustment';
      const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
      const itemId = positiveSafeInteger(body.item_id);
      const delta = signedNonZeroInteger(body.delta);
      if (!operationId) return NextResponse.json({ error: 'Invalid inventory operation identity. Refresh the page before retrying.' }, { status: 400 });
      if (!itemId || delta === null) return NextResponse.json({ error: 'Choose an inventory item and enter a non-zero whole-number quantity change' }, { status: 400 });
      // Keep generic stock corrections on a closed vocabulary. Custody and
      // inspection movement names are interpreted as audit evidence by the
      // database; a stale or hand-authored client must not be able to forge
      // one through this general-purpose endpoint.
      if (!['adjustment', 'purchase', 'write_off'].includes(movementType)) return NextResponse.json({ error: 'Choose adjustment, purchase, or write-off as the stock movement type' }, { status: 400 });
      if (movementType === 'purchase' && delta < 1) return NextResponse.json({ error: 'A purchase must increase stock' }, { status: 400 });
      if (movementType === 'write_off' && delta > -1) return NextResponse.json({ error: 'A write-off must decrease stock' }, { status: 400 });
      if (!reference) return NextResponse.json({ error: 'An inventory adjustment reference is required' }, { status: 400 });
      if (!validInventoryReference(reference)) return NextResponse.json({ error: 'Inventory references must be a single line of 120 characters or fewer' }, { status: 400 });
      const adjustmentNotes = optionalSingleLineText(body.notes, 1000);
      if (adjustmentNotes === undefined) return NextResponse.json({ error: 'Inventory notes must be a single line of 1,000 characters or fewer' }, { status: 400 });
      const { data, error } = await db.rpc('qy_adjust_inventory', { p_item_id: itemId, p_delta: delta, p_type: movementType, p_reference: reference, p_notes: adjustmentNotes, p_operation_id: operationId }).abortSignal(adminOpsDeadline.signal);
      if (error) {
        const failure = inventoryMutationFailure(error);
        if (failure) return NextResponse.json({ error: failure.message }, { status: failure.status });
        throw error;
      }
      if (!acknowledgedInventoryMutation(data, { id: itemId })) {
        return NextResponse.json({ error: 'Unable to verify the inventory adjustment. Refresh the stock register before making another change.' }, {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
        });
      }
    } else if (action === 'inventory_status') {
      const operationId = validAdminOperationId(body.operation_id);
      const itemId = positiveSafeInteger(body.item_id);
      const status = text(body.status, 40).toLowerCase();
      // Status is intentionally separate from a quantity adjustment. Returning
      // a quarantined unit to service requires staff to both record the
      // inspection decision here and post the physical stock movement above.
      if (!operationId) return NextResponse.json({ error: 'Invalid inventory operation identity. Refresh the page before retrying.' }, { status: 400 });
      if (itemId === null) return NextResponse.json({ error: 'Choose an inventory item' }, { status: 400 });
      if (!['available', 'quarantined', 'damaged', 'maintenance'].includes(status)) {
        return NextResponse.json({ error: 'Choose a valid inventory status' }, { status: 400 });
      }
      const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
      if (!reference) return NextResponse.json({ error: 'An inspection or repair reference is required before changing device status' }, { status: 400 });
      if (!validInventoryReference(reference)) return NextResponse.json({ error: 'Inventory references must be a single line of 120 characters or fewer' }, { status: 400 });
      const inspectionNotes = optionalSingleLineText(body.notes, 1000);
      if (inspectionNotes === undefined) return NextResponse.json({ error: 'Inspection notes must be a single line of 1,000 characters or fewer' }, { status: 400 });
      // Status changes control whether a router can be dispatched. Keep them
      // in the inventory movement ledger instead of making an unaudited table
      // update that could silently restore a quarantined unit to saleable use.
      const { data, error } = await db.rpc('qy_set_inventory_status', {
        p_item_id: itemId,
        p_status: status,
        p_reference: reference,
        p_notes: inspectionNotes,
        p_operation_id: operationId,
      }).abortSignal(adminOpsDeadline.signal);
      if (error) {
        const failure = inventoryMutationFailure(error);
        if (failure) return NextResponse.json({ error: failure.message }, { status: failure.status });
        throw error;
      }
      if (!acknowledgedInventoryMutation(data, { id: itemId, status })) {
        return NextResponse.json({ error: 'Unable to verify the inventory status change. Refresh the stock register before making another change.' }, {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
        });
      }
    } else if (action === 'customer_create') {
      const status = text(body.status, 40) || 'lead';
      if (!['lead', 'active', 'inactive'].includes(status)) return NextResponse.json({ error: 'Choose a valid customer status' }, { status: 400 });
      const row = { email: text(body.email, 200).toLowerCase() || null, phone: text(body.phone, 60) || null, name: text(body.name, 120) || null, status, source: text(body.source, 80) || 'manual', notes: text(body.notes, 1500) || null, updated_at: new Date().toISOString() };
      if (!row.email && !row.phone) return NextResponse.json({ error: 'Email or phone is required' }, { status: 400 });
      const { data, error } = await db.from('customers').insert(row).select('id,email,phone,name,status,source').abortSignal(adminOpsDeadline.signal).single();
      if (error) throw error;
      if (!acknowledgedAdminRecord(data, {
        email: row.email, phone: row.phone, name: row.name, status: row.status, source: row.source,
      })) throw new Error('Customer acknowledgement mismatch');
    } else if (action === 'activity_create') {
      const customerId = optionalPositiveSafeInteger(body.customer_id);
      const activityType = text(body.activity_type, 40) || 'note';
      const dueAt = optionalOperationalDateTime(body.due_at);
      if (body.customer_id !== undefined && body.customer_id !== null && body.customer_id !== '' && customerId === null) return NextResponse.json({ error: 'Choose a valid customer' }, { status: 400 });
      if (!['note', 'call', 'whatsapp', 'email', 'task'].includes(activityType)) return NextResponse.json({ error: 'Choose a valid activity type' }, { status: 400 });
      if (dueAt === undefined) return NextResponse.json({ error: 'Choose a valid follow-up date and time' }, { status: 400 });
      const row = { customer_id: customerId, activity_type: activityType, subject: text(body.subject, 160) || null, detail: text(body.detail, 2000) || null, due_at: dueAt, owner: text(body.owner, 100) || null };
      const { data, error } = await db.from('crm_activities').insert(row).select('id,customer_id,activity_type,subject,detail,due_at,owner').abortSignal(adminOpsDeadline.signal).single();
      if (error) throw error;
      if (!acknowledgedAdminRecord(data, row)) throw new Error('CRM activity acknowledgement mismatch');
    } else if (action === 'activity_complete') {
      const activityId = positiveSafeInteger(body.id);
      if (activityId === null) return NextResponse.json({ error: 'Choose a valid activity' }, { status: 400 });
      const completedAt = new Date().toISOString();
      const { data, error } = await db.from('crm_activities').update({ completed_at: completedAt }).eq('id', activityId).select('id,completed_at').abortSignal(adminOpsDeadline.signal).maybeSingle();
      if (error) throw error;
      if (!data) return NextResponse.json({ error: 'Activity not found' }, { status: 404 });
      if (!acknowledgedAdminRecord(data, { completed_at: completedAt }, activityId)) throw new Error('CRM activity completion acknowledgement mismatch');
    } else if (action === 'opportunity_create') {
      const customerId = optionalPositiveSafeInteger(body.customer_id);
      const productType = text(body.product_type, 40) || null;
      const stage = text(body.stage, 40) || 'lead';
      const probability = exactPercentage(body.probability);
      // A blank optional value means the opportunity has not been valued yet.
      // Preserve that existing UI contract as zero, while rejecting malformed,
      // negative, fractional-cent, or oversized values instead of coercing
      // them through Number(...).
      const expectedValueCents = body.expected_value_sgd === ''
        ? 0
        : nonNegativeMoney(body.expected_value_sgd);
      const expectedCloseDate = text(body.expected_close_date, 10) || null;
      if (body.customer_id !== undefined && body.customer_id !== null && body.customer_id !== '' && customerId === null) return NextResponse.json({ error: 'Choose a valid customer' }, { status: 400 });
      if (productType !== null && !['pocket_wifi', 'esim'].includes(productType)) return NextResponse.json({ error: 'Choose a valid opportunity product type' }, { status: 400 });
      if (!['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'].includes(stage)) return NextResponse.json({ error: 'Choose a valid opportunity stage' }, { status: 400 });
      if (probability === null || expectedValueCents === null) return NextResponse.json({ error: 'Probability must be a whole percentage from 0 to 100 and expected value must be a non-negative amount with at most two decimal places' }, { status: 400 });
      if (expectedCloseDate !== null && !parseExactIsoDate(expectedCloseDate)) return NextResponse.json({ error: 'Choose a valid expected close date' }, { status: 400 });
      const row = { customer_id: customerId, title: text(body.title, 180), product_type: productType, stage, probability, expected_value_sgd: expectedValueCents / 100, expected_close_date: expectedCloseDate, source: text(body.source, 80) || null, owner: text(body.owner, 100) || null, notes: text(body.notes, 1500) || null, updated_at: new Date().toISOString() };
      if (!row.title) return NextResponse.json({ error: 'Opportunity title is required' }, { status: 400 });
      const { data, error } = await db.from('sales_opportunities').insert(row).select('id,customer_id,title,product_type,stage,probability,expected_value_sgd,expected_close_date,source,owner').abortSignal(adminOpsDeadline.signal).single();
      if (error) throw error;
      if (!acknowledgedAdminRecord(data, {
        customer_id: row.customer_id, title: row.title, product_type: row.product_type,
        stage: row.stage, probability: row.probability, expected_value_sgd: row.expected_value_sgd,
        expected_close_date: row.expected_close_date, source: row.source, owner: row.owner,
      })) throw new Error('Sales opportunity acknowledgement mismatch');
    } else if (action === 'opportunity_stage') {
      const opportunityId = positiveSafeInteger(body.id);
      const stage = text(body.stage, 40);
      const probability = exactPercentage(body.probability);
      if (opportunityId === null) return NextResponse.json({ error: 'Choose a valid opportunity' }, { status: 400 });
      if (!['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'].includes(stage)) return NextResponse.json({ error: 'Choose a valid opportunity stage' }, { status: 400 });
      if (probability === null) return NextResponse.json({ error: 'Probability must be a whole percentage from 0 to 100' }, { status: 400 });
      const { data, error } = await db.from('sales_opportunities').update({ stage, probability, updated_at: new Date().toISOString() }).eq('id', opportunityId).select('id,stage,probability').abortSignal(adminOpsDeadline.signal).maybeSingle();
      if (error) throw error;
      if (!data) return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
      if (!acknowledgedAdminRecord(data, { stage, probability }, opportunityId)) throw new Error('Opportunity stage acknowledgement mismatch');
    } else if (action === 'forecast_upsert') {
      const month = text(body.forecast_month, 10); const product = text(body.product_type, 40);
      const forecastOrders = nonNegativeInteger(body.forecast_orders);
      const forecastRevenueCents = nonNegativeMoney(body.forecast_revenue_sgd);
      const forecastUnits = nonNegativeInteger(body.forecast_units);
      if (!parseExactIsoDate(month) || !['pocket_wifi', 'esim'].includes(product)) return NextResponse.json({ error: 'Choose a valid forecast date and product type' }, { status: 400 });
      if (forecastOrders === null || forecastRevenueCents === null || forecastUnits === null) return NextResponse.json({ error: 'Forecast orders and units must be whole non-negative numbers; revenue must be a non-negative amount with at most two decimal places' }, { status: 400 });
      // The schema owns this natural key. Use its atomic conflict boundary
      // rather than deleting the previous forecast before inserting a new
      // one: an interrupted request must retain the last approved forecast.
      const row = { forecast_month: month, product_type: product, forecast_orders: forecastOrders, forecast_revenue_sgd: forecastRevenueCents / 100, forecast_units: forecastUnits, method: text(body.method, 80) || 'management', notes: text(body.notes, 1200) || null, updated_at: new Date().toISOString() };
      const { data, error } = await db.from('forecasts').upsert(row, { onConflict: 'forecast_month,product_type' }).select('id,forecast_month,product_type,forecast_orders,forecast_revenue_sgd,forecast_units,method,notes').abortSignal(adminOpsDeadline.signal).single();
      if (error) throw error;
      if (!acknowledgedAdminRecord(data, {
        forecast_month: row.forecast_month, product_type: row.product_type,
        forecast_orders: row.forecast_orders, forecast_revenue_sgd: row.forecast_revenue_sgd,
        forecast_units: row.forecast_units, method: row.method, notes: row.notes,
      })) throw new Error('Forecast acknowledgement mismatch');
    } else if (action === 'close_period') {
      const start = text(body.period_start, 10), end = text(body.period_end, 10); if (!start || !end) return NextResponse.json({ error: 'Period dates are required' }, { status: 400 });
      const dates = optionalTravelDates({ travel_start: start, travel_end: end });
      if (!dates) return NextResponse.json({ error: 'Period dates must be valid ISO dates with the end date on or after the start date' }, { status: 400 });
      const refundsCents = nonNegativeMoney(body.refunds_sgd), feesCents = nonNegativeMoney(body.fees_sgd), cogsCents = nonNegativeMoney(body.cogs_sgd);
      if (refundsCents === null || feesCents === null || cogsCents === null) return NextResponse.json({ error: 'Refunds, fees and COGS must be non-negative amounts with at most two decimal places' }, { status: 400 });
      // A truthy string such as "false" must never close an accounting
      // period. The browser sends a boolean, and non-browser callers get the
      // same explicit contract rather than an accidental irreversible close.
      if (body.lock !== undefined && typeof body.lock !== 'boolean') return NextResponse.json({ error: 'Accounting period lock must be a boolean choice' }, { status: 400 });
      const lock = body.lock === true;
      const closedBy = text(body.closed_by, 100);
      if (lock && !closedBy) return NextResponse.json({ error: 'Closed accounting periods require an accountable operator name' }, { status: 400 });
      const gross = await paidOrderGrossForPeriod(db, dates.start!, dates.end!, adminOpsDeadline.signal); const refunds = refundsCents / 100, fees = feesCents / 100, cogs = cogsCents / 100, net = gross - refunds, gp = net - fees - cogs;
      const notes = text(body.notes, 1500) || null;
      const { data, error } = await db.rpc('qy_record_closing_period', {
        p_period_start: start, p_period_end: end, p_lock: lock,
        p_gross_sales_sgd: gross, p_refunds_sgd: refunds, p_net_sales_sgd: net,
        p_fees_sgd: fees, p_cogs_sgd: cogs, p_gross_profit_sgd: gp,
        p_closed_by: closedBy || null, p_notes: notes,
      }).abortSignal(adminOpsDeadline.signal);
      if (error) {
        if (/closed accounting period|multiple accounting records/i.test(error.message || '')) return NextResponse.json({ error: error.message }, { status: 409 });
        if (/paid-order ledger changed/i.test(error.message || '')) {
          return NextResponse.json({ error: 'Paid orders changed while this accounting period was being prepared. Review the refreshed totals and save again.' }, { status: 409 });
        }
        throw error;
      }
      if (!acknowledgedClosingPeriod(data, {
        periodStart: start, periodEnd: end, locked: lock,
        grossSalesCents: Math.round(gross * 100), refundsCents,
        netSalesCents: Math.round(net * 100), feesCents, cogsCents,
        grossProfitCents: Math.round(gp * 100),
        closedBy: lock ? closedBy : null, notes,
      })) throw new Error('Accounting period acknowledgement mismatch');
    } else return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });

    return NextResponse.json({ ok: true });
  } catch {
    // A Supabase/PostgREST error can include SQL details or echoed operator
    // input. Expected, actionable conflicts are returned above; unexpected
    // failures should neither become an operator-facing raw error nor a log
    // sink for customer and provider data.
    console.error('admin_ops_action_failed', { action });
    return NextResponse.json({ error: 'Operation failed. Please try again or contact an administrator.' }, { status: 500 });
  } finally {
    adminOpsDeadline.dispose();
    releaseAdminOps();
  }
}
