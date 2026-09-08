import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

const requiredContracts = [
  'create table if not exists public.inventory_items',
  'create table if not exists public.inventory_movements',
  'create or replace function public.qy_adjust_inventory',
  'create or replace function public.qy_transition_pocket_wifi_order',
  "and status = 'available'",
  'selected Pocket WiFi inventory item is not available for dispatch',
  'create or replace function public.qy_create_manual_pocket_wifi_order',
  'create table if not exists public.customers',
  'create table if not exists public.crm_activities',
  'create table if not exists public.sales_opportunities',
  'create table if not exists public.forecasts',
  'create table if not exists public.closing_periods',
  'create or replace view public.sales_daily_summary',
  'alter table public.inventory_items enable row level security',
  'alter table public.customers enable row level security',
  'grant execute on function public.qy_adjust_inventory(bigint,integer,text,text,text) to service_role',
  'return_disposition text',
  "return_quarantined', 'return_damaged",
  "p_return_disposition text default 'restock'",
  'grant execute on function public.qy_transition_pocket_wifi_order(bigint,text,text,text,text,text,bigint,text) to service_role',
  'grant execute on function public.qy_create_manual_pocket_wifi_order(text,text,text,text,numeric,text,text,date,date,text,integer) to service_role',
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

console.log(`Operations schema guard passed for ${requiredContracts.length} admin contracts and clean-install dependency order.`);
