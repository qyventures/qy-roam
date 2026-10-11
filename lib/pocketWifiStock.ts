import { getSupabaseAdmin } from './supabaseAdmin';

const INVENTORY_SCAN_PAGE_SIZE = 1_000;
// Operational configuration caps the fleet at 10,000 units. Because this
// scan excludes zero-quantity rows, ten full pages are enough to reach that
// cap; one final page lets a smaller, highly fragmented register prove EOF.
export const MAX_INVENTORY_SCAN_PAGES = 11;
// Stock readiness is part of the authenticated health response used during
// deployment. The scan can legitimately span several PostgREST pages, so the
// transport's per-request timeout is not an end-to-end bound. Keep the whole
// scan inside the same budget as the other database readiness probes: a
// slow-but-responsive database must not leave a deploy probe (or admin launch
// page render) working through eleven independent request deadlines.
export const STOCK_READINESS_TIMEOUT_MS = 8_000;
// Health and launch-dashboard renders can arrive together during a deploy.
// Coalesce their identical stock scan and briefly reuse only a successful
// result. A failure or an empty register is never cached, so restocked units
// become visible on the very next probe. Keep this shorter than the schema
// readiness cache because physical stock is operationally more volatile.
export const STOCK_READINESS_CACHE_MS = 5_000;
let stockReadyUntil = 0;
let stockReadyConfiguredInventory: number | null = null;
let stockCheckInFlight: Promise<boolean> | null = null;
let stockCheckInFlightConfiguredInventory: number | null = null;

export async function saleablePocketWifiInventory(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  configuredInventory: number,
  signal?: AbortSignal,
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
    if (signal) query = query.abortSignal(signal);
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

async function checkSaleablePocketWifiInventory(configuredInventory: number) {
  const supabase = getSupabaseAdmin();
  if (!supabase || !Number.isSafeInteger(configuredInventory) || configuredInventory < 1) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Pocket WiFi stock readiness timed out')), STOCK_READINESS_TIMEOUT_MS);
  try {
    return await saleablePocketWifiInventory(supabase, configuredInventory, controller.signal) > 0;
  } catch {
    // Health is a release authority. An incomplete stock read must not
    // promote a storefront whose only active product cannot be purchased.
    console.error('production_pocket_wifi_inventory_check_failed');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function hasSaleablePocketWifiInventory(configuredInventory: number) {
  // Do not let a malformed caller inherit a cached success produced for a
  // valid fleet limit. This check also avoids starting/coalescing work that
  // the underlying scanner would reject immediately.
  if (!Number.isSafeInteger(configuredInventory) || configuredInventory < 1) return false;
  if (
    stockReadyConfiguredInventory === configuredInventory &&
    Date.now() < stockReadyUntil
  ) return true;

  // Operational configuration is process-stable, but keep coalescing keyed
  // to its exact inventory ceiling so a hot configuration drift cannot reuse
  // a scan performed under a different capacity boundary.
  if (!stockCheckInFlight || stockCheckInFlightConfiguredInventory !== configuredInventory) {
    stockCheckInFlightConfiguredInventory = configuredInventory;
    const check = checkSaleablePocketWifiInventory(configuredInventory)
      .then((ready) => {
        if (ready) {
          stockReadyConfiguredInventory = configuredInventory;
          stockReadyUntil = Date.now() + STOCK_READINESS_CACHE_MS;
        }
        return ready;
      })
      .catch(() => false)
      .finally(() => {
        // A second, differently keyed probe may have replaced this shared
        // promise while it was running. Only its owner may clear the slot.
        if (stockCheckInFlight === check) {
          stockCheckInFlight = null;
          stockCheckInFlightConfiguredInventory = null;
        }
      });
    stockCheckInFlight = check;
  }
  return stockCheckInFlight;
}
