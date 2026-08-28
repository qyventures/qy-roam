import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function text(v: unknown, max = 500) { return String(v ?? '').trim().slice(0, max); }
function num(v: unknown, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function int(v: unknown, fallback = 0) { return Math.trunc(num(v, fallback)); }

export async function POST(req: NextRequest) {
  const db = getSupabaseAdmin();
  if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  const action = text(body.action, 60);

  try {
    if (action === 'inventory_create') {
      const row = {
        sku: text(body.sku, 80), name: text(body.name, 120), product_type: text(body.product_type, 40) || 'pocket_wifi',
        serial_no: text(body.serial_no, 120) || null, status: text(body.status, 40) || 'available',
        quantity_on_hand: Math.max(0, int(body.quantity_on_hand)), reorder_level: Math.max(0, int(body.reorder_level)),
        unit_cost_sgd: Math.max(0, num(body.unit_cost_sgd)), location: text(body.location, 120) || null, notes: text(body.notes, 1000) || null,
        updated_at: new Date().toISOString()
      };
      if (!row.sku || !row.name) return NextResponse.json({ error: 'SKU and name are required' }, { status: 400 });
      const { error } = await db.from('inventory_items').insert(row); if (error) throw error;
    } else if (action === 'inventory_adjust') {
      const { error } = await db.rpc('qy_adjust_inventory', { p_item_id: int(body.item_id), p_delta: int(body.delta), p_type: text(body.movement_type, 40) || 'adjustment', p_reference: text(body.reference, 120) || null, p_notes: text(body.notes, 1000) || null }); if (error) throw error;
    } else if (action === 'customer_create') {
      const row = { email: text(body.email, 200).toLowerCase() || null, phone: text(body.phone, 60) || null, name: text(body.name, 120) || null, status: text(body.status, 40) || 'lead', source: text(body.source, 80) || 'manual', notes: text(body.notes, 1500) || null, updated_at: new Date().toISOString() };
      if (!row.email && !row.phone) return NextResponse.json({ error: 'Email or phone is required' }, { status: 400 });
      const { error } = await db.from('customers').insert(row); if (error) throw error;
    } else if (action === 'activity_create') {
      const { error } = await db.from('crm_activities').insert({ customer_id: int(body.customer_id) || null, activity_type: text(body.activity_type, 40) || 'note', subject: text(body.subject, 160) || null, detail: text(body.detail, 2000) || null, due_at: body.due_at || null, owner: text(body.owner, 100) || null }); if (error) throw error;
    } else if (action === 'activity_complete') {
      const { error } = await db.from('crm_activities').update({ completed_at: new Date().toISOString() }).eq('id', int(body.id)); if (error) throw error;
    } else if (action === 'opportunity_create') {
      const row = { customer_id: int(body.customer_id) || null, title: text(body.title, 180), product_type: text(body.product_type, 40) || null, stage: text(body.stage, 40) || 'lead', probability: Math.min(100, Math.max(0, num(body.probability))), expected_value_sgd: Math.max(0, num(body.expected_value_sgd)), expected_close_date: body.expected_close_date || null, source: text(body.source, 80) || null, owner: text(body.owner, 100) || null, notes: text(body.notes, 1500) || null, updated_at: new Date().toISOString() };
      if (!row.title) return NextResponse.json({ error: 'Opportunity title is required' }, { status: 400 });
      const { error } = await db.from('sales_opportunities').insert(row); if (error) throw error;
    } else if (action === 'opportunity_stage') {
      const stage = text(body.stage, 40); const probability = Math.min(100, Math.max(0, num(body.probability)));
      const { error } = await db.from('sales_opportunities').update({ stage, probability, updated_at: new Date().toISOString() }).eq('id', int(body.id)); if (error) throw error;
    } else if (action === 'forecast_upsert') {
      const month = text(body.forecast_month, 10); const product = text(body.product_type, 40);
      if (!month || !product) return NextResponse.json({ error: 'Month and product are required' }, { status: 400 });
      await db.from('forecasts').delete().eq('forecast_month', month).eq('product_type', product);
      const { error } = await db.from('forecasts').insert({ forecast_month: month, product_type: product, forecast_orders: Math.max(0, int(body.forecast_orders)), forecast_revenue_sgd: Math.max(0, num(body.forecast_revenue_sgd)), forecast_units: Math.max(0, int(body.forecast_units)), method: text(body.method, 80) || 'management', notes: text(body.notes, 1200) || null, updated_at: new Date().toISOString() }); if (error) throw error;
    } else if (action === 'close_period') {
      const start = text(body.period_start, 10), end = text(body.period_end, 10); if (!start || !end) return NextResponse.json({ error: 'Period dates are required' }, { status: 400 });
      const { data: orders, error: orderError } = await db.from('orders').select('amount_sgd').eq('payment_status', 'paid').gte('created_at', `${start}T00:00:00+08:00`).lte('created_at', `${end}T23:59:59+08:00`); if (orderError) throw orderError;
      const gross = (orders ?? []).reduce((s: number, x: any) => s + Number(x.amount_sgd || 0), 0); const refunds = Math.max(0, num(body.refunds_sgd)); const fees = Math.max(0, num(body.fees_sgd)); const cogs = Math.max(0, num(body.cogs_sgd)); const net = gross - refunds; const gp = net - fees - cogs;
      const { error } = await db.from('closing_periods').insert({ period_start: start, period_end: end, status: body.lock ? 'closed' : 'open', gross_sales_sgd: gross, refunds_sgd: refunds, net_sales_sgd: net, fees_sgd: fees, cogs_sgd: cogs, gross_profit_sgd: gp, closed_by: body.lock ? (text(body.closed_by, 100) || 'qyadmin') : null, closed_at: body.lock ? new Date().toISOString() : null, notes: text(body.notes, 1500) || null, updated_at: new Date().toISOString() }); if (error) throw error;
    } else return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('admin ops action failed', action, error?.message || error);
    return NextResponse.json({ error: error?.message || 'Operation failed' }, { status: 500 });
  }
}
