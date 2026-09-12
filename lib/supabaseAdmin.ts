import { createClient } from '@supabase/supabase-js';

// PostgREST requests otherwise inherit the platform fetch timeout, which can
// be several minutes (or unlimited). Supabase backs checkout reservations,
// paid-order persistence, and webhook idempotency, so a network partition
// must release the Node worker and let the existing idempotent recovery paths
// retry rather than indefinitely consuming capacity.
export const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;

export async function fetchSupabaseWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = SUPABASE_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const requestSignal = init?.signal || (input instanceof Request ? input.signal : undefined);
  const timeoutError = new Error('Supabase request timed out');
  const abortFromRequest = () => controller.abort(requestSignal?.reason);

  if (requestSignal?.aborted) abortFromRequest();
  else requestSignal?.addEventListener('abort', abortFromRequest, { once: true });

  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener('abort', abortFromRequest);
  }
}

export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchSupabaseWithTimeout },
  });
}
