import { readFile } from 'node:fs/promises';

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

try {
  const result = JSON.parse(await input());
  if (!plainRecord(result) || result.service !== 'qy-roam' || result.ok !== true ||
      result.launchReady !== true || result.salesReady !== true ||
      !plainRecord(result.checkoutChecks)) {
    process.exitCode = 1;
  } else {
    const { esim, pocketWifi } = result.checkoutChecks;
    // Require the complete named product contract, not an arbitrary truthy
    // field. This makes deployment/recovery prove the same at-least-one-path
    // invariant as the health route while retaining visibility of which
    // checkout is actually saleable.
    if (typeof esim !== 'boolean' || typeof pocketWifi !== 'boolean' ||
        (esim !== true && pocketWifi !== true) ||
        result.checkoutReady !== (esim && pocketWifi)) {
      process.exitCode = 1;
    }
  }
} catch {
  process.exitCode = 1;
}
