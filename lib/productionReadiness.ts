import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

const REQUIRED_PAYMENT_SCHEMA = [
  {
    table: 'orders',
    columns: 'stripe_session_id,payment_status,product_type,travel_start,travel_end,fulfilment_status,shipping_address',
  },
  {
    table: 'stripe_events',
    columns: 'event_id,event_type,processing_started_at,processed_at',
  },
  {
    table: 'fulfilment_notifications',
    columns: 'stripe_session_id,status,attempts,updated_at',
  },
  {
    table: 'meta_purchase_deliveries',
    columns: 'stripe_session_id,status,attempts,updated_at',
  },
  {
    // Pocket WiFi checkout relies on this durable hold ledger to make the
    // availability check and the subsequent Stripe session creation safe under
    // concurrent requests. Treat its absence as launch-blocking rather than
    // discovering it only after a customer begins checkout.
    table: 'checkout_reservations',
    columns: 'checkout_request_id,stripe_session_id,travel_start,travel_end,expires_at',
  },
] as const;

/**
 * Verify the database contract needed after a customer pays. Checking only that
 * credentials exist is insufficient: a valid Supabase project with an older
 * schema would accept checkout and then reject the signed Stripe webhook.
 */
export async function hasRequiredPaymentSchema() {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  let results;
  try {
    results = await Promise.all(
      REQUIRED_PAYMENT_SCHEMA.map(({ table, columns }) =>
        supabase.from(table).select(columns).limit(1),
      ),
    );
  } catch {
    console.error('production_payment_schema_check_unavailable');
    return false;
  }

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
  });
  if (reservationProbe.error || reservationProbe.data?.[0]?.reserved !== false) {
    console.error('production_payment_reservation_rpc_check_failed');
    return false;
  }
  return true;
}
