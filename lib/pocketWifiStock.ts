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

type PocketWifiStockReadinessState = {
  readyUntil: number;
  readyConfiguredInventory: number | null;
  checkInFlight: Promise<boolean> | null;
  checkInFlightConfiguredInventory: number | null;
};

type PocketWifiStockReadinessGlobal = typeof globalThis & {
  __qyRoamPocketWifiStockReadinessState?: PocketWifiStockReadinessState;
};

// Health and the launch dashboard are separate Next server entrypoints and
// can evaluate independent copies of this module. Keep their cache and active
// scan on the process singleton so a deploy cannot start two identical
// multi-page inventory scans or receive contradictory readiness answers from
// two route-local success windows. The configured fleet limit remains part of
// the cache/coalescing identity below.
const stockReadinessState = (
  (globalThis as PocketWifiStockReadinessGlobal).__qyRoamPocketWifiStockReadinessState ??= {
    readyUntil: 0,
    readyConfiguredInventory: null,
    checkInFlight: null,
    checkInFlightConfiguredInventory: null,
  }
);

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
    if (!Array.isArray(response.data) || response.data.length > INVENTORY_SCAN_PAGE_SIZE) {
      throw new Error('Pocket WiFi inventory scan returned an invalid page');
    }
    const rows = response.data;
    let previousId: number | null = afterId;
    for (const row of rows) {
      const id = Number(row.id);
      const quantity = Number(row.quantity_on_hand);
      // Keyset pagination is safe only while the provider honours the exact
      // ascending, unique cursor contract requested above. A repeated or
      // backwards row could otherwise be counted twice and make deployment
      // readiness claim that more physical routers exist than the register
      // actually contains.
      if (!Number.isSafeInteger(id) || id < 1 || (previousId !== null && id <= previousId) ||
        !Number.isSafeInteger(quantity) || quantity < 1) {
        throw new Error('Pocket WiFi inventory contains an invalid saleable quantity');
      }
      previousId = id;
      total = Math.min(configuredInventory, total + Math.min(quantity, configuredInventory));
      if (total >= configuredInventory) return total;
    }
    if (rows.length < INVENTORY_SCAN_PAGE_SIZE) return total;
    // A full page must have advanced to a validated final row. Keeping that
    // exact cursor is what makes the next page disjoint from this one.
    if (previousId === null) throw new Error('Pocket WiFi inventory scan returned an invalid cursor');
    afterId = previousId;
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
    stockReadinessState.readyConfiguredInventory === configuredInventory &&
    Date.now() < stockReadinessState.readyUntil
  ) return true;

  // Operational configuration is process-stable, but keep coalescing keyed
  // to its exact inventory ceiling so a hot configuration drift cannot reuse
  // a scan performed under a different capacity boundary.
  if (!stockReadinessState.checkInFlight || stockReadinessState.checkInFlightConfiguredInventory !== configuredInventory) {
    stockReadinessState.checkInFlightConfiguredInventory = configuredInventory;
    const check = checkSaleablePocketWifiInventory(configuredInventory)
      .then((ready) => {
        if (ready) {
          stockReadinessState.readyConfiguredInventory = configuredInventory;
          stockReadinessState.readyUntil = Date.now() + STOCK_READINESS_CACHE_MS;
        }
        return ready;
      })
      .catch(() => false)
      .finally(() => {
        // A second, differently keyed probe may have replaced this shared
        // promise while it was running. Only its owner may clear the slot.
        if (stockReadinessState.checkInFlight === check) {
          stockReadinessState.checkInFlight = null;
          stockReadinessState.checkInFlightConfiguredInventory = null;
        }
      });
    stockReadinessState.checkInFlight = check;
  }
  return stockReadinessState.checkInFlight;
}
