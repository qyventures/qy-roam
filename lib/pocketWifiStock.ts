import { getSupabaseAdmin } from './supabaseAdmin';

const INVENTORY_SCAN_PAGE_SIZE = 1_000;
// Operational configuration caps the fleet at 10,000 units. Because this
// scan excludes zero-quantity rows, ten full pages are enough to reach that
// cap; one final page lets a smaller, highly fragmented register prove EOF.
export const MAX_INVENTORY_SCAN_PAGES = 11;

export async function saleablePocketWifiInventory(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  configuredInventory: number,
) {
  let afterId: number | null = null;
  let total = 0;
  for (let page = 0; page < MAX_INVENTORY_SCAN_PAGES; page += 1) {
    let query = supabase.from('inventory_items').select('id,quantity_on_hand')
      .eq('product_type', 'pocket_wifi')
      .eq('status', 'available')
      .gt('quantity_on_hand', 0)
      .order('id')
      .limit(INVENTORY_SCAN_PAGE_SIZE);
    if (afterId !== null) query = query.gt('id', afterId);
    const response = await query;
    if (response.error) throw response.error;
    const rows = response.data || [];
    for (const row of rows) {
      const id = Number(row.id);
      const quantity = Number(row.quantity_on_hand);
      if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(quantity) || quantity < 1) {
        throw new Error('Pocket WiFi inventory contains an invalid saleable quantity');
      }
      total = Math.min(configuredInventory, total + Math.min(quantity, configuredInventory));
      if (total >= configuredInventory) return total;
    }
    if (rows.length < INVENTORY_SCAN_PAGE_SIZE) return total;
    const lastId = Number(rows[rows.length - 1].id);
    if (!Number.isSafeInteger(lastId) || lastId < 1) throw new Error('Pocket WiFi inventory scan returned an invalid cursor');
    afterId = lastId;
  }
  throw new Error('Pocket WiFi inventory scan exceeded its safe page limit');
}

export async function hasSaleablePocketWifiInventory(configuredInventory: number) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !Number.isSafeInteger(configuredInventory) || configuredInventory < 1) return false;
  try {
    return await saleablePocketWifiInventory(supabase, configuredInventory) > 0;
  } catch {
    // Health is a release authority. An incomplete stock read must not
    // promote a storefront whose only active product cannot be purchased.
    console.error('production_pocket_wifi_inventory_check_failed');
    return false;
  }
}
