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
  'grant execute on function public.qy_transition_pocket_wifi_order(bigint,text,text,text,text,text,bigint) to service_role',
  'grant execute on function public.qy_create_manual_pocket_wifi_order(text,text,text,text,numeric,text,text,date,date,text,integer) to service_role',
];

for (const contract of requiredContracts) {
  assert.ok(schema.includes(contract), `Missing operations schema contract: ${contract}`);
}

console.log(`Operations schema guard passed for ${requiredContracts.length} admin contracts.`);
