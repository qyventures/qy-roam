import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

// This guard runs without production database credentials, so it cannot ask
// PostgreSQL to compile the migration. Still reject the two most damaging
// classes of hand-edited PL/pgSQL breakage before deployment: an unterminated
// dollar-quoted function body and an unbalanced IF/END IF block. Presence-only
// checks below would otherwise pass both and leave a clean Supabase install
// failing partway through schema application.
export function validatePlpgsqlStructure(sql) {
  const dollarDelimiter = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g;
  const blocks = [];
  let match;

  while ((match = dollarDelimiter.exec(sql)) !== null) {
    const opening = { delimiter: match[0], start: match.index, bodyStart: dollarDelimiter.lastIndex };
    // A function body can itself contain a differently tagged dollar-quoted
    // string (usually dynamic SQL). Only the exact opening tag closes it.
    const closingAt = sql.indexOf(opening.delimiter, opening.bodyStart);
    assert.ok(closingAt >= 0, `Unterminated SQL dollar-quoted block beginning at byte ${opening.start}`);
    blocks.push({
      prefix: sql.slice(Math.max(0, opening.start - 300), opening.start),
      body: sql.slice(opening.bodyStart, closingAt),
    });
    dollarDelimiter.lastIndex = closingAt + opening.delimiter.length;
  }

  for (const { prefix, body } of blocks) {
    if (!/language\s+plpgsql/i.test(prefix)) continue;
    // Remove text that cannot contain control-flow tokens. PostgreSQL strings
    // escape a quote by doubling it; comments can contain arbitrary examples.
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\r\n]*/g, ' ')
      .replace(/'(?:''|[^'])*'/g, ' ')
      .replace(/"(?:""|[^"])*"/g, ' ');
    const tokens = code.match(/\bend\s+if\b|\bif\b/gi) || [];
    let depth = 0;
    for (const token of tokens) {
      if (/^end/i.test(token)) {
        depth -= 1;
        assert.ok(depth >= 0, 'PL/pgSQL function contains END IF without a matching IF');
      } else {
        depth += 1;
      }
    }
    assert.equal(depth, 0, 'PL/pgSQL function contains an IF without a matching END IF');
  }
}

validatePlpgsqlStructure(schema);

const requiredContracts = [
  'create table if not exists public.inventory_items',
  'create table if not exists public.inventory_movements',
  'create or replace function public.qy_adjust_inventory',
  'create or replace function public.qy_transition_pocket_wifi_order',
  "and status = 'available'",
  'selected Pocket WiFi inventory item is not available for dispatch',
  'create or replace function public.qy_create_manual_pocket_wifi_order',
  'create or replace function public.qy_create_inventory_item',
  'create table if not exists public.customers',
  'create or replace function public.qy_reconcile_customer_paid_totals',
  'create or replace function public.qy_reconcile_customer_from_paid_order',
  'create trigger qy_reconcile_customer_from_paid_order',
  'create or replace function public.qy_order_integrity_schema_ready',
  'grant execute on function public.qy_order_integrity_schema_ready() to service_role',
  'create or replace function public.qy_claim_stripe_event',
  'grant execute on function public.qy_claim_stripe_event(text,text,text) to service_role',
  "after insert or update of payment_status, customer_name, email, phone, amount_sgd on public.orders",
  "new.payment_status <> 'paid'",
  "pg_advisory_xact_lock(hashtext('qy_roam_customer:' || v_identity))",
  "pg_advisory_xact_lock(hashtext('qy_roam_customer:' || v_old_identity))",
  'foreach v_previous_customer_id in array v_previous_customer_ids loop',
  'perform public.qy_reconcile_customer_paid_totals(v_customer_id)',
  "'customer', 'checkout'",
  'customers_normalized_email_idx',
  'customers_normalized_phone_idx',
  'create table if not exists public.crm_activities',
  'create table if not exists public.sales_opportunities',
  'create table if not exists public.forecasts',
  'create table if not exists public.closing_periods',
  'create or replace function public.qy_record_closing_period',
  "pg_advisory_xact_lock(hashtext('qy_roam_closing_period:' || p_period_start::text || ':' || p_period_end::text))",
  'closed accounting period cannot be replaced',
  'grant execute on function public.qy_record_closing_period(date,date,boolean,numeric,numeric,numeric,numeric,numeric,numeric,text,text) to service_role',
  'create or replace view public.sales_daily_summary',
  'alter table public.inventory_items enable row level security',
  'alter table public.customers enable row level security',
  'grant execute on function public.qy_adjust_inventory(bigint,integer,text,text,text) to service_role',
  'return_disposition text',
  'digital_delivery_reference text',
  'orders_product_fulfilment_status_check',
  'orders_fulfilment_requires_paid_payment_check',
  "coalesce(payment_status = 'paid', false)",
  'orders_payment_confirmed_at_requires_paid_payment_check',
  "product_type = 'pocket_wifi' and fulfilment_status in",
  "product_type = 'esim' and fulfilment_status in",
  'create or replace function public.qy_enforce_esim_fulfilment_transition',
  'create trigger qy_enforce_esim_fulfilment_transition',
  'invalid eSIM fulfilment transition',
  'new eSIM order must begin before digital fulfilment',
  'order product type is immutable',
  "before insert or update of product_type, fulfilment_status on public.orders",
  ') not valid;',
  "return_quarantined', 'return_damaged",
  'p_return_disposition text',
  'Require an explicit',
  'grant execute on function public.qy_transition_pocket_wifi_order(bigint,text,text,text,text,text,bigint,text) to service_role',
  'grant execute on function public.qy_create_manual_pocket_wifi_order(text,text,text,text,numeric,text,text,date,date,text,integer) to service_role',
  'grant execute on function public.qy_create_inventory_item(text,text,text,text,text,integer,integer,numeric,text,text) to service_role',
];

for (const contract of requiredContracts) {
  assert.ok(schema.includes(contract), `Missing operations schema contract: ${contract}`);
}

// This file is also the clean-install migration. Keep database objects ahead
// of functions that resolve their tables/columns; testing only for presence
// allowed a schema that upgraded successfully but failed on an empty project.
const inventoryTable = schema.indexOf('create table if not exists public.inventory_items');
const orderInventoryColumn = schema.indexOf('alter table public.orders add column if not exists inventory_item_id');
const reservationFunction = schema.indexOf('create or replace function public.qy_reserve_pocket_wifi');
const manualOrderFunction = schema.indexOf('create or replace function public.qy_create_manual_pocket_wifi_order');
assert.ok(inventoryTable >= 0 && inventoryTable < reservationFunction, 'inventory_items must exist before the reservation function');
assert.ok(orderInventoryColumn > inventoryTable && orderInventoryColumn < reservationFunction, 'orders.inventory_item_id must exist before the reservation function');
assert.ok(inventoryTable < manualOrderFunction, 'inventory_items must exist before the manual-order function');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Operations schema guard passed for ${requiredContracts.length} admin contracts, PL/pgSQL structure, and clean-install dependency order.`);
}
