import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import crypto from 'crypto';
import { isSafeSmtpHost, isSafeSmtpMailbox } from '@/lib/smtp';
export { hasRequiredStripeCheckoutConfig } from '@/lib/stripeCheckoutConfig';

// Checkout invokes these guards immediately before creating a payable Stripe
// Session. A healthy schema does not change between adjacent requests, while
// repeatedly probing it adds several database round trips (and, for Pocket
// WiFi, briefly takes the same advisory lock used to reserve inventory).
// Cache only a successful result and only for a short interval: an outage or
// incomplete migration is never cached and continues to fail closed.
const READINESS_CACHE_MS = 15_000;
// A readiness check sits directly on the customer checkout path. Supabase's
// normal request timeout is intentionally generous, but waiting that long
// here can exhaust server workers during a network partition. Abort the
// probe itself (rather than only racing its result) so a failed dependency
// produces the existing fail-closed response within a bounded time.
const READINESS_PROBE_TIMEOUT_MS = 8_000;
let paymentSchemaReadyUntil = 0;
let esimOrderSchemaReadyUntil = 0;
let operationsSchemaReadyUntil = 0;
let paymentSchemaCheckInFlight: Promise<boolean> | null = null;
let esimOrderSchemaCheckInFlight: Promise<boolean> | null = null;
let operationsSchemaCheckInFlight: Promise<boolean> | null = null;

class ReadinessProbeTimeoutError extends Error {}

async function runReadinessProbe<T>(probe: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), READINESS_PROBE_TIMEOUT_MS);
  try {
    return await probe(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new ReadinessProbeTimeoutError('Production readiness probe timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const REQUIRED_PAYMENT_SCHEMA = [
  {
    table: 'orders',
    // This is the complete persisted Checkout Session snapshot, not merely
    // the fields used to list orders.  A partial migration must fail before
    // checkout exposes a payment URL instead of failing after Stripe accepts
    // a real order in persistSession.
    columns: 'stripe_session_id,payment_status,customer_name,email,phone,amount_sgd,product_type,plan_id,plan_name,data_allowance,country,travel_start,travel_end,fulfilment_status,payment_confirmed_at,measurement_consent,shipping_address,updated_at',
  },
  {
    table: 'stripe_events',
    // Failed claims remain visible and immediately retryable. Probe the full
    // recovery contract so checkout cannot accept payment against an older
    // event ledger that would hide or temporarily strand a failed webhook.
    columns: 'event_id,event_type,stripe_session_id,processing_started_at,processed_at,attempts,last_failed_at,last_error',
  },
  {
    table: 'fulfilment_notifications',
    // The webhook claims, retries, records errors and marks this ledger sent.
    // Probe every column in that write contract before accepting payment.
    columns: 'stripe_session_id,status,attempts,last_attempt_at,sent_at,last_error,updated_at',
  },
  {
    table: 'meta_purchase_deliveries',
    // event_time is essential to CAPI retry deduplication. Its migration was
    // deliberately additive, so include it here to prevent an older schema
    // from passing checkout readiness and failing only after payment.
    columns: 'stripe_session_id,status,event_time,attempts,last_attempt_at,sent_at,last_error,updated_at',
  },
  {
    // Every paid order invokes qy_reconcile_customer_from_paid_order. That
    // trigger writes this CRM record in the same transaction as the order,
    // so it is part of the payment-persistence contract rather than an
    // optional admin-only table. Without this probe, a partially deployed
    // CRM schema could let Checkout accept payment and then make the webhook
    // fail while inserting the paid order.
    table: 'customers',
    columns: 'id,email,phone,name,status,source,total_orders,lifetime_value_sgd,last_order_at,updated_at',
  },
  {
    // Pocket WiFi checkout relies on this durable hold ledger to make the
    // availability check and the subsequent Stripe session creation safe under
    // concurrent requests. Treat its absence as launch-blocking rather than
    // discovering it only after a customer begins checkout.
    table: 'checkout_reservations',
    columns: 'checkout_request_id,stripe_session_id,travel_start,travel_end,expires_at',
  },
  {
    // The reservation RPC caps bookings at saleable, physical router stock.
    // Ensure a pre-inventory schema cannot pass checkout readiness and then
    // fail only after a traveller starts paying.
    table: 'inventory_items',
    columns: 'id,product_type,status,quantity_on_hand',
  },
] as const;

// eSIM orders do not need the Pocket WiFi reservation RPC, but they still
// depend on the order ledger, event idempotency and delivery ledgers after a
// customer pays. Keep this smaller contract separately so digital checkout
// can fail closed before creating a payable Stripe Session without coupling it
// to router-inventory configuration.
const REQUIRED_ESIM_ORDER_SCHEMA = REQUIRED_PAYMENT_SCHEMA.slice(0, 5);

const REQUIRED_OPERATIONS_SCHEMA = [
  // The order fields below are the durable evidence used by the guarded
  // dispatch/return RPC.  A table-only probe can otherwise pass against an
  // older deployment and leave staff unable to receive a router safely.
  { table: 'orders', columns: 'id,product_type,payment_status,fulfilment_status,inventory_item_id,courier_tracking,return_tracking,digital_delivery_reference,return_disposition,dispatched_at,returned_at' },
  { table: 'inventory_items', columns: 'id,sku,product_type,status,quantity_on_hand,reorder_level' },
  { table: 'inventory_movements', columns: 'id,inventory_item_id,movement_type,quantity' },
  { table: 'customers', columns: 'id,email,phone,total_orders,lifetime_value_sgd' },
  { table: 'crm_activities', columns: 'id,customer_id,activity_type,completed_at' },
  { table: 'sales_opportunities', columns: 'id,title,stage,probability,expected_value_sgd' },
  { table: 'forecasts', columns: 'id,forecast_month,product_type,forecast_revenue_sgd' },
  { table: 'closing_periods', columns: 'id,period_start,period_end,status,net_sales_sgd' },
  { table: 'sales_daily_summary', columns: 'sales_date,product_type,paid_orders,revenue_sgd' },
] as const;

/**
 * A Checkout Session must not be exposed unless paid orders can reach the
 * human fulfilment queue. The webhook intentionally retries failed delivery,
 * but accepting payment with no configured transport would leave every order
 * needing manual database recovery.
 */
export function hasRequiredFulfilmentEmailConfig() {
  const port = Number(process.env.SMTP_PORT || '587');
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const from = (process.env.SMTP_FROM || user || '').trim();
  // Fulfilment contains paid-order PII and must always have an explicitly
  // configured destination. A historical fallback mailbox can silently route
  // customer details to the wrong operations team on a fresh deployment.
  const recipient = (process.env.ORDER_FULFILMENT_EMAIL || process.env.FULFILMENT_TO || '').trim();
  const relayUrl = process.env.SMTP_RELAY_URL?.trim();
  const relaySecret = process.env.SMTP_RELAY_SECRET?.trim();
  // The relay is optional, but a partial or malformed relay configuration
  // must not be silently ignored after checkout has accepted payment. The
  // request carries SMTP credentials and paid-order PII, so require a direct
  // HTTPS endpoint without embedded credentials whenever the relay is used.
  let relayConfigured = !relayUrl && !relaySecret;
  if (relayUrl && relaySecret && relaySecret.length >= 24 && !/[\r\n]/.test(relaySecret)) {
    try {
      const url = new URL(relayUrl);
      relayConfigured = url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      relayConfigured = false;
    }
  }
  return Boolean(
    isSafeSmtpHost(host) &&
    Number.isInteger(port) && port > 0 && port <= 65535 &&
    user && !/[\r\n]/.test(user) && pass &&
    isSafeSmtpMailbox(from) && isSafeSmtpMailbox(recipient) && relayConfigured,
  );
}

// Stripe Checkout can accept payment without this application being able to
// persist the signed completion event. Keep this small configuration gate next
// to the other pre-payment guards so the public checkout routes fail closed
// instead of creating an order that requires dashboard recovery.
export function hasRequiredStripeWebhookConfig() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  return Boolean(secret && /^whsec_[A-Za-z0-9]+$/.test(secret) && secret.length >= 20);
}

/**
 * Verify the database contract needed after a customer pays. Checking only that
 * credentials exist is insufficient: a valid Supabase project with an older
 * schema would accept checkout and then reject the signed Stripe webhook.
 */
async function checkRequiredPaymentSchema() {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;
  // These are runtime probes across unrelated relations. Keeping this query
  // surface untyped avoids expanding Supabase's generated table union as the
  // paid-order transaction gains durable trigger dependencies.
  const database: any = supabase;

  try {
    return await runReadinessProbe(async (signal) => {
      const results = await Promise.all(
        REQUIRED_PAYMENT_SCHEMA.map(({ table, columns }) =>
          database.from(table).select(columns).limit(1).abortSignal(signal),
        ),
      );
      const failures = results
        .map((result, index) => result.error ? REQUIRED_PAYMENT_SCHEMA[index].table : null)
        .filter(Boolean);
      if (failures.length > 0) {
        console.error('production_payment_schema_check_failed', { tables: failures });
        return false;
      }

      // The table checks above are not enough for Pocket WiFi sales: checkout uses
      // this RPC as the atomic inventory boundary. Probe it with zero inventory so
      // it can never create a reservation while still verifying that the function,
      // its current signature, and the service-role grant are all deployed.
      const today = new Date().toISOString().slice(0, 10);
      const reservationProbe = await supabase.rpc('qy_reserve_pocket_wifi', {
        p_checkout_request_id: `readiness_${crypto.randomUUID().replaceAll('-', '')}`,
        p_travel_start: today,
        p_travel_end: today,
        p_inventory: 0,
        p_expires_at: new Date(Date.now() + 60_000).toISOString(),
        p_stripe_hold_count: 0,
        p_stripe_hold_request_ids: [],
      }).abortSignal(signal);
      if (reservationProbe.error || reservationProbe.data?.[0]?.reserved !== false) {
        console.error('production_payment_reservation_rpc_check_failed');
        return false;
      }
      // Probe the Stripe-to-inventory hand-off RPC inside a transaction that
      // is guaranteed to fail validation. PostgREST still resolves its exact
      // deployed signature, without creating an operational order.
      const persistenceProbe = await supabase.rpc('qy_persist_stripe_pocket_wifi_order', {
        p_stripe_session_id: '',
        p_payment_status: 'unpaid',
        p_customer_name: null,
        p_email: null,
        p_phone: null,
        p_amount_sgd: 0,
        p_plan_name: null,
        p_country: null,
        p_travel_start: today,
        p_travel_end: today,
        p_measurement_consent: 'essential',
        p_shipping_address: null,
        p_payment_confirmed_at: null,
        p_payment_failed: false,
        p_checkout_request_id: null,
      }).abortSignal(signal);
      if (!persistenceProbe.error || !/Stripe session id is required/i.test(persistenceProbe.error.message || '')) {
        console.error('production_payment_persistence_rpc_check_failed');
        return false;
      }
      return true;
    });
  } catch {
    console.error('production_payment_schema_check_unavailable');
    return false;
  }
}

export async function hasRequiredPaymentSchema() {
  if (Date.now() < paymentSchemaReadyUntil) return true;
  if (!paymentSchemaCheckInFlight) {
    paymentSchemaCheckInFlight = checkRequiredPaymentSchema()
      .then((ready) => {
        if (ready) paymentSchemaReadyUntil = Date.now() + READINESS_CACHE_MS;
        return ready;
      })
      .catch((error) => {
        console.error('production_payment_schema_check_unexpected_error', error);
        return false;
      })
      .finally(() => { paymentSchemaCheckInFlight = null; });
  }
  return paymentSchemaCheckInFlight;
}

/**
 * Check the durable tables a paid eSIM webhook must use. This is called before
 * creating an eSIM Checkout Session: accepting payment while these relations
 * are unavailable would leave a legitimate digital order unrecorded and
 * unfulfillable.
 */
async function checkRequiredEsimOrderSchema() {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;
  // See the matching Pocket WiFi probe above: this is an intentionally
  // dynamic schema contract, not an application data query.
  const database: any = supabase;

  try {
    return await runReadinessProbe(async (signal) => {
      const results = await Promise.all(
        REQUIRED_ESIM_ORDER_SCHEMA.map(({ table, columns }) =>
          database.from(table).select(columns).limit(1).abortSignal(signal),
        ),
      );
      const failures = results
        .map((result, index) => result.error ? REQUIRED_ESIM_ORDER_SCHEMA[index].table : null)
        .filter(Boolean);
      if (failures.length > 0) {
        console.error('production_esim_order_schema_check_failed', { tables: failures });
        return false;
      }
      return true;
    });
  } catch {
    console.error('production_esim_order_schema_check_unavailable');
    return false;
  }
}

export async function hasRequiredEsimOrderSchema() {
  if (Date.now() < esimOrderSchemaReadyUntil) return true;
  if (!esimOrderSchemaCheckInFlight) {
    esimOrderSchemaCheckInFlight = checkRequiredEsimOrderSchema()
      .then((ready) => {
        if (ready) esimOrderSchemaReadyUntil = Date.now() + READINESS_CACHE_MS;
        return ready;
      })
      .catch((error) => {
        console.error('production_esim_order_schema_check_unexpected_error', error);
        return false;
      })
      .finally(() => { esimOrderSchemaCheckInFlight = null; });
  }
  return esimOrderSchemaCheckInFlight;
}

/**
 * The admin UI is deliberately server-only, but it is still a production
 * contract. Verify its tables and reporting view separately from checkout so
 * operators can distinguish an order-taking issue from an incomplete admin
 * migration.
 */
async function checkRequiredOperationsSchema() {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  try {
    // The Supabase generated-schema generic forms an impractically large union
    // when probing many operational relations at once. These are deliberately
    // runtime schema probes, so keep the query surface untyped here.
    const database: any = supabase;
    return await runReadinessProbe(async (signal) => {
      const results = await Promise.all(
        REQUIRED_OPERATIONS_SCHEMA.map(({ table, columns }) =>
          database.from(table).select(columns).limit(1).abortSignal(signal),
        ),
      );
      const failures = results
        .map((result, index) => result.error ? REQUIRED_OPERATIONS_SCHEMA[index].table : null)
        .filter(Boolean);
      if (failures.length) {
        console.error('production_operations_schema_check_failed', { tables: failures });
        return false;
      }

      // Probe the five inventory/order RPCs without changing any state. A zero
      // order or item id is rejected before inventory functions write, while
      // empty manual-order and SKU values are rejected before either creation
      // routine can insert rows. Their expected domain errors prove the
      // functions, current argument signatures and service-role grants are
      // deployed. Missing-function or permission errors instead fail the
      // launch gate before staff need to receive, dispatch, create stock, or
      // record a capacity-consuming manual rental.
      const [transitionProbe, adjustmentProbe, statusProbe, creationProbe, manualOrderProbe, closingProbe] = await Promise.all([
        database.rpc('qy_transition_pocket_wifi_order', {
          p_order_id: 0,
          p_expected_status: 'paid',
          p_next_status: 'paid',
          p_courier_tracking: null,
          p_return_tracking: null,
          p_notes: null,
          p_inventory_item_id: null,
          p_return_disposition: 'restock',
        }).abortSignal(signal),
        database.rpc('qy_adjust_inventory', {
          p_item_id: 0,
          p_delta: 1,
          p_type: 'readiness_probe',
          p_reference: null,
          p_notes: null,
        }).abortSignal(signal),
        database.rpc('qy_set_inventory_status', {
          p_item_id: 0,
          p_status: 'available',
          p_reference: null,
          p_notes: null,
        }).abortSignal(signal),
        database.rpc('qy_create_inventory_item', {
          p_sku: '',
          p_name: 'readiness probe',
          p_product_type: 'pocket_wifi',
          p_serial_no: null,
          p_status: 'available',
          p_quantity_on_hand: 0,
          p_reorder_level: 0,
          p_unit_cost_sgd: 0,
          p_location: null,
          p_notes: null,
        }).abortSignal(signal),
        database.rpc('qy_create_manual_pocket_wifi_order', {
          p_stripe_session_id: '',
          p_customer_name: null,
          p_email: null,
          p_phone: null,
          p_amount_sgd: 0,
          p_plan_name: null,
          p_country: null,
          p_travel_start: null,
          p_travel_end: null,
          p_notes: null,
          p_inventory: 0,
        }).abortSignal(signal),
        // A null period is rejected before the accounting routine can write,
        // while still verifying its deployed signature and service-role grant.
        database.rpc('qy_record_closing_period', {
          p_period_start: null,
          p_period_end: null,
          p_lock: false,
          p_gross_sales_sgd: 0,
          p_refunds_sgd: 0,
          p_net_sales_sgd: 0,
          p_fees_sgd: 0,
          p_cogs_sgd: 0,
          p_gross_profit_sgd: 0,
          p_closed_by: null,
          p_notes: null,
        }).abortSignal(signal),
      ]);
      if (!transitionProbe.error || !/order not found/i.test(transitionProbe.error.message || '') ||
        !adjustmentProbe.error || !/invalid inventory item/i.test(adjustmentProbe.error.message || '')) {
        console.error('production_operations_inventory_rpc_check_failed');
        return false;
      }
      if (!statusProbe.error || !/invalid inventory item/i.test(statusProbe.error.message || '')) {
        console.error('production_operations_inventory_status_rpc_check_failed');
        return false;
      }
      if (!creationProbe.error || !/inventory SKU is required/i.test(creationProbe.error.message || '')) {
        console.error('production_operations_inventory_creation_rpc_check_failed');
        return false;
      }
      if (!manualOrderProbe.error || !/manual order reference is required/i.test(manualOrderProbe.error.message || '')) {
        console.error('production_operations_manual_order_rpc_check_failed');
        return false;
      }
      if (!closingProbe.error || !/accounting period dates are invalid/i.test(closingProbe.error.message || '')) {
        console.error('production_operations_closing_rpc_check_failed');
        return false;
      }
      return true;
    });
  } catch {
    console.error('production_operations_schema_check_unavailable');
    return false;
  }
}

// Health checks commonly run on a short interval and this operations probe is
// intentionally comprehensive (nine relations plus five RPC contracts). Keep
// it responsive under multiple health-check workers without hiding a failed
// migration or outage: only a successful result is cached, and only briefly.
export async function hasRequiredOperationsSchema() {
  if (Date.now() < operationsSchemaReadyUntil) return true;
  if (!operationsSchemaCheckInFlight) {
    operationsSchemaCheckInFlight = checkRequiredOperationsSchema()
      .then((ready) => {
        if (ready) operationsSchemaReadyUntil = Date.now() + READINESS_CACHE_MS;
        return ready;
      })
      .catch((error) => {
        console.error('production_operations_schema_check_unexpected_error', error);
        return false;
      })
      .finally(() => { operationsSchemaCheckInFlight = null; });
  }
  return operationsSchemaCheckInFlight;
}
