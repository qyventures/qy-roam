import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// The authenticated health document is currently well below 2 KiB. Keep the
// release authority bounded even when a broken proxy, compromised upstream,
// or accidentally supplied file returns an unlimited body. The chunk ceiling
// also prevents a pathological stream from making the validator spend
// unbounded per-chunk bookkeeping work inside the byte limit.
export const SALES_READINESS_MAX_INPUT_BYTES = 64 * 1024;
export const SALES_READINESS_MAX_INPUT_CHUNKS = 256;

export async function readBoundedSalesReadinessInput(source) {
  const chunks = [];
  let total = 0;
  let chunkCount = 0;
  for await (const value of source) {
    chunkCount += 1;
    if (chunkCount > SALES_READINESS_MAX_INPUT_CHUNKS) {
      throw new RangeError('Sales readiness input is too fragmented');
    }
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > SALES_READINESS_MAX_INPUT_BYTES) {
      throw new RangeError('Sales readiness input is too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function input() {
  const path = process.argv[2];
  if (path) {
    const file = await open(path, 'r');
    try {
      return await readBoundedSalesReadinessInput(file.createReadStream({
        autoClose: false,
        highWaterMark: Math.min(16 * 1024, SALES_READINESS_MAX_INPUT_BYTES + 1),
      }));
    } finally {
      await file.close();
    }
  }

  return readBoundedSalesReadinessInput(process.stdin);
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function allTrue(record, names) {
  return names.every((name) => record[name] === true);
}

function allBoolean(record, names) {
  return names.every((name) => typeof record[name] === 'boolean');
}

// Release checks run on the same host as the application, so a two-minute
// window is generous for provider probes and retry loops while still refusing
// a readiness document retained by a broken intermediary or replayed from an
// earlier process. Permit a small future skew between the server response and
// validator clocks, but never let an arbitrarily future timestamp remain
// valid indefinitely.
export const SALES_READINESS_MAX_AGE_MS = 120_000;
export const SALES_READINESS_MAX_FUTURE_SKEW_MS = 30_000;

function freshTimestamp(value, nowMs) {
  if (typeof value !== 'string' || value.length > 40) return false;
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) &&
    timestampMs >= nowMs - SALES_READINESS_MAX_AGE_MS &&
    timestampMs <= nowMs + SALES_READINESS_MAX_FUTURE_SKEW_MS;
}

export function salesReadinessResponseIsValid(result, nowMs = Date.now()) {
  if (!plainRecord(result) || result.service !== 'qy-roam' || result.ok !== true ||
      result.launchReady !== true || result.salesReady !== true ||
      !Number.isFinite(nowMs) || !freshTimestamp(result.timestamp, nowMs) ||
      !plainRecord(result.checks) || !plainRecord(result.checkoutChecks) ||
      !plainRecord(result.availabilityChecks)) {
    return false;
  }

  const { esim, pocketWifi } = result.checkoutChecks;
  const launchEvidence = [
    'stripe', 'stripeApi', 'siteUrl', 'webhook', 'orderIntegrity',
    'supabase', 'operationsSchema', 'admin', 'fulfilmentEmail',
  ];
  const productEvidence = [
    'esimOrderSchema', 'paymentSchema', 'pocketWifiFulfilmentSchema',
    'inventory', 'deliveryLeadDays', 'courierFee', 'pocketWifiPricing',
  ];
  const pocketWifiEvidence = [
    'paymentSchema', 'pocketWifiFulfilmentSchema', 'inventory',
    'deliveryLeadDays', 'courierFee', 'pocketWifiPricing',
  ];
  // Require the complete named product contract, not an arbitrary truthy
  // field. This makes deployment/recovery prove the same at-least-one-path
  // invariant as the health route while retaining visibility of which
  // checkout is actually saleable. Require every current evidence field to
  // be a boolean even when its product is paused: this rejects a stale health
  // document from an older application graph instead of interpreting a
  // missing field as harmless product-specific evidence.
  return typeof esim === 'boolean' && typeof pocketWifi === 'boolean' &&
    (esim === true || pocketWifi === true) &&
    result.checkoutReady === (esim && pocketWifi) &&
    allTrue(result.checks, launchEvidence) &&
    allBoolean(result.checks, productEvidence) &&
    typeof result.availabilityChecks.pocketWifiStock === 'boolean' &&
    (!esim || result.checks.esimOrderSchema === true) &&
    (!pocketWifi || allTrue(result.checks, pocketWifiEvidence)) &&
    (!pocketWifi || result.availabilityChecks.pocketWifiStock === true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!salesReadinessResponseIsValid(JSON.parse(await input()))) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
