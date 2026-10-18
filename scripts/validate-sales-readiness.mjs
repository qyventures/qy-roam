import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

async function input() {
  const path = process.argv[2];
  if (path) return readFile(path, 'utf8');

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function allTrue(record, names) {
  return names.every((name) => record[name] === true);
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
  // Require the complete named product contract, not an arbitrary truthy
  // field. This makes deployment/recovery prove the same at-least-one-path
  // invariant as the health route while retaining visibility of which
  // checkout is actually saleable.
  return typeof esim === 'boolean' && typeof pocketWifi === 'boolean' &&
    (esim === true || pocketWifi === true) &&
    result.checkoutReady === (esim && pocketWifi) &&
    allTrue(result.checks, launchEvidence) &&
    (!esim || result.checks.esimOrderSchema === true) &&
    (!pocketWifi || allTrue(result.checks, [
      'paymentSchema', 'pocketWifiFulfilmentSchema', 'inventory',
    ])) &&
    (!pocketWifi || result.availabilityChecks.pocketWifiStock === true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!salesReadinessResponseIsValid(JSON.parse(await input()))) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
