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

const REQUIRED_OPERATIONS_SCHEMA = [
  { table: 'inventory_items', columns: 'id,sku,quantity_on_hand,reorder_level' },
  { table: 'inventory_movements', columns: 'id,inventory_item_id,movement_type,quantity' },
  { table: 'customers', columns: 'id,email,phone,total_orders,lifetime_value_sgd' },
  { table: 'crm_activities', columns: 'id,customer_id,activity_type,completed_at' },
  { table: 'sales_opportunities', columns: 'id,title,stage,probability,expected_value_sgd' },
  { table: 'forecasts', columns: 'id,forecast_month,product_type,forecast_revenue_sgd' },
  { table: 'closing_periods', columns: 'id,period_start,period_end,status,net_sales_sgd' },
  { table: 'sales_daily_summary', columns: 'sales_date,product_type,paid_orders,revenue_sgd' },
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

/**
 * The admin UI is deliberately server-only, but it is still a production
 * contract. Verify its tables and reporting view separately from checkout so
 * operators can distinguish an order-taking issue from an incomplete admin
 * migration.
 */
export async function hasRequiredOperationsSchema() {
  const supabase = getSupabaseAdmin();
  if (!supabase) return false;

  try {
    // The Supabase generated-schema generic forms an impractically large union
    // when probing many operational relations at once. These are deliberately
    // runtime schema probes, so keep the query surface untyped here.
    const database: any = supabase;
    const results = await Promise.all(
      REQUIRED_OPERATIONS_SCHEMA.map(({ table, columns }) =>
        database.from(table).select(columns).limit(1),
      ),
    );
    const failures = results
      .map((result, index) => result.error ? REQUIRED_OPERATIONS_SCHEMA[index].table : null)
      .filter(Boolean);
    if (failures.length) {
      console.error('production_operations_schema_check_failed', { tables: failures });
      return false;
    }
  } catch {
    console.error('production_operations_schema_check_unavailable');
    return false;
  }
  return true;
}
