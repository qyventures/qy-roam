import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const productionReadiness = readFileSync(new URL('../lib/productionReadiness.ts', import.meta.url), 'utf8');

// Checkout and the migration publish opposite sides of one compatibility
// handshake. Catch a one-sided version bump locally: otherwise a release can
// either accept payment against stale database logic or remain unnecessarily
// unavailable after the matching migration is installed.
const applicationSchemaVersion = productionReadiness.match(/const REQUIRED_ORDER_INTEGRITY_SCHEMA_VERSION = (\d+);/)?.[1];
const databaseSchemaVersion = schema.match(/create or replace function public\.qy_order_integrity_schema_version\(\)[\s\S]*?select (\d+);/)?.[1];
assert.ok(applicationSchemaVersion, 'Missing application order-integrity schema version');
assert.ok(databaseSchemaVersion, 'Missing database order-integrity schema version');
assert.equal(applicationSchemaVersion, databaseSchemaVersion, 'Application and database order-integrity schema versions must match');

// This guard runs without production database credentials, so it cannot ask
// PostgreSQL to compile the migration. Still reject common damaging classes
// of hand-edited PL/pgSQL breakage before deployment: an unterminated
// dollar-quoted function body, unbalanced control-flow blocks, and unmatched
// parentheses. Presence-only checks below would otherwise pass these and leave
// a clean Supabase install failing partway through schema application.
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
      // PostgreSQL accepts function attributes on either side of AS. Retain
      // the bounded text after the body so `AS $$...$$ LANGUAGE plpgsql`
      // receives the same release validation as this schema's current
      // `LANGUAGE plpgsql AS $$...$$` convention.
      suffix: sql.slice(closingAt + opening.delimiter.length, closingAt + opening.delimiter.length + 300),
    });
    dollarDelimiter.lastIndex = closingAt + opening.delimiter.length;
  }

  for (const { prefix, body, suffix } of blocks) {
    if (!/language\s+plpgsql/i.test(prefix) && !/^\s*language\s+plpgsql\b/i.test(suffix)) continue;
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

    const loopTokens = code.match(/\bend\s+loop\b|\bloop\b/gi) || [];
    depth = 0;
    for (const token of loopTokens) {
      if (/^end/i.test(token)) {
        depth -= 1;
        assert.ok(depth >= 0, 'PL/pgSQL function contains END LOOP without a matching LOOP');
      } else {
        depth += 1;
      }
    }
    assert.equal(depth, 0, 'PL/pgSQL function contains a LOOP without a matching END LOOP');

    // A duplicated condition terminator such as `) then` is not visible to
    // the keyword-only check above. Track parentheses after stripping strings
    // and comments so malformed trigger expressions cannot pass the offline
    // release guard merely because their IF and END IF tokens still balance.
    let parenthesisDepth = 0;
    for (const character of code) {
      if (character === '(') parenthesisDepth += 1;
      if (character === ')') {
        parenthesisDepth -= 1;
        assert.ok(parenthesisDepth >= 0, 'PL/pgSQL function contains an unmatched closing parenthesis');
      }
    }
    assert.equal(parenthesisDepth, 0, 'PL/pgSQL function contains an unmatched opening parenthesis');
  }
}

validatePlpgsqlStructure(schema);

// Keep both halves of the lightweight parser covered in the release command
// itself; the broader integrity suite also exercises these exported guards.
validatePlpgsqlStructure(`
  create function public.example() returns trigger language plpgsql as $$
  begin
    if new.value is not null and (new.value > 0 or new.value = -1) then
      return new;
    end if;
    return old;
  end;
  $$;
`);
assert.throws(
  () => validatePlpgsqlStructure(`
    create function public.example() returns trigger language plpgsql as $$
    begin
      if new.value is not null and (new.value > 0) then
      ) then
        return new;
      end if;
      return old;
    end;
    $$;
  `),
  /unmatched closing parenthesis/,
);
assert.throws(
  () => validatePlpgsqlStructure(`
    create function public.example() returns void as $$
    begin
      loop
        return;
    end;
    $$ language plpgsql;
  `),
  /LOOP without a matching END LOOP/,
);

// PostgreSQL rejects an ON CONFLICT update that assigns the same target
// column twice. This is easy to introduce while editing the long, safety-
// critical paid-order upserts below, and the duplicate can hide among comments
// while all presence-based contract checks continue to pass. We do not have a
// production database available in the build workspace, so parse the bounded
// assignment lists here and fail before a partially applied schema reaches it.
export function validateOnConflictAssignments(sql) {
  const clause = /\bon\s+conflict\b[\s\S]*?\bdo\s+update\s+set\b/gi;
  let match;

  while ((match = clause.exec(sql)) !== null) {
    const assignmentsStart = clause.lastIndex;
    let depth = 0;
    let quote = null;
    let lineComment = false;
    let blockComment = false;
    let end = sql.length;

    for (let index = assignmentsStart; index < sql.length; index += 1) {
      const char = sql[index];
      const next = sql[index + 1];
      if (lineComment) {
        if (char === '\n') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === '*' && next === '/') { blockComment = false; index += 1; }
        continue;
      }
      if (quote) {
        if (char === quote && next === quote) { index += 1; continue; }
        if (char === quote) quote = null;
        continue;
      }
      if (char === '-' && next === '-') { lineComment = true; index += 1; continue; }
      if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if (depth === 0 && char === ';') { end = index; break; }
      else if (depth === 0 && /^\sreturning\b/i.test(sql.slice(index))) { end = index; break; }
    }

    const list = sql.slice(assignmentsStart, end)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\r\n]*/g, ' ');
    const columns = [];
    let itemStart = 0;
    depth = 0;
    quote = null;
    for (let index = 0; index <= list.length; index += 1) {
      const char = list[index];
      const next = list[index + 1];
      if (quote) {
        if (char === quote && next === quote) { index += 1; continue; }
        if (char === quote) quote = null;
      } else if (char === "'" || char === '"') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if ((char === ',' && depth === 0) || index === list.length) {
        const assignment = list.slice(itemStart, index).trim();
        const column = assignment.match(/^([a-z_][a-z0-9_]*)\s*=/i)?.[1]?.toLowerCase();
        assert.ok(column, `Unable to parse ON CONFLICT assignment: ${assignment.slice(0, 80)}`);
        columns.push(column);
        itemStart = index + 1;
      }
    }
    const duplicates = columns.filter((column, index) => columns.indexOf(column) !== index);
    assert.deepEqual([...new Set(duplicates)], [], `ON CONFLICT assigns a target column more than once: ${[...new Set(duplicates)].join(', ')}`);
    clause.lastIndex = end;
  }
}

validateOnConflictAssignments(schema);

// Keep the guard itself honest: this is a release check, so a parser
// regression must fail locally instead of silently weakening deployment.
validateOnConflictAssignments(`
  insert into example(id, email) values (1, 'a@example.com')
  on conflict (id) do update set
    email = case when (example.email is null) then excluded.email else example.email end,
    updated_at = now()
  returning id;
`);
assert.throws(
  () => validateOnConflictAssignments(`
    insert into example(id, email) values (1, 'a@example.com')
    on conflict (id) do update set email = excluded.email, -- accidental copy
      email = lower(excluded.email)
    returning id;
  `),
  /assigns a target column more than once: email/,
);

const requiredContracts = [
  'create table if not exists public.inventory_items',
  'create table if not exists public.inventory_movements',
  'create or replace function public.qy_adjust_inventory',
  'create or replace function public.qy_transition_pocket_wifi_order',
  "and status = 'available'",
  'selected Pocket WiFi inventory item is not available for dispatch',
  'orders_pocket_wifi_custody_reference_shape_check',
  'create or replace function public.qy_create_manual_pocket_wifi_order',
  'create or replace function public.qy_create_inventory_item',
  'create table if not exists public.customers',
  'create or replace function public.qy_reconcile_customer_paid_totals',
  'create or replace function public.qy_reconcile_customer_from_paid_order',
  'create trigger qy_reconcile_customer_from_paid_order',
  'create or replace function public.qy_order_integrity_schema_ready',
  'grant execute on function public.qy_order_integrity_schema_ready() to service_role',
  "tgenabled in ('O', 'A')",
  'create or replace function public.qy_order_integrity_schema_version',
  'grant execute on function public.qy_order_integrity_schema_version() to service_role',
  'create or replace function public.qy_claim_stripe_event',
  'grant execute on function public.qy_claim_stripe_event(text,text,text) to service_role',
  'stripe_events_event_id_check',
  'stripe_events_session_id_check',
  'stripe_events_event_type_check',
  'stripe_events_failure_timestamp_check',
  'stripe_events_processed_failure_check',
  'orders_session_id_format_check',
  "coalesce(btrim(shipping_address ->> 'postal_code') ~ '^[0-9]{6}$', false)",
  'create trigger qy_validate_order_payment_confirmation_time',
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
const pocketWifiPersistenceFunction = schema.indexOf('create or replace function public.qy_persist_stripe_pocket_wifi_order');
const integritySchemaVersion = schema.indexOf('create or replace function public.qy_order_integrity_schema_version');
assert.ok(inventoryTable >= 0 && inventoryTable < reservationFunction, 'inventory_items must exist before the reservation function');
assert.ok(orderInventoryColumn > inventoryTable && orderInventoryColumn < reservationFunction, 'orders.inventory_item_id must exist before the reservation function');
assert.ok(inventoryTable < manualOrderFunction, 'inventory_items must exist before the manual-order function');
assert.ok(integritySchemaVersion > pocketWifiPersistenceFunction, 'order-integrity schema version must be written after every paid-order function it certifies');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Operations schema guard passed for ${requiredContracts.length} admin contracts, PL/pgSQL structure, conflict-update assignments, and clean-install dependency order.`);
}
