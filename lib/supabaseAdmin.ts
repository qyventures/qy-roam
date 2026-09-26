import { createClient } from '@supabase/supabase-js';

// PostgREST requests otherwise inherit the platform fetch timeout, which can
// be several minutes (or unlimited). Supabase backs checkout reservations,
// paid-order persistence, and webhook idempotency, so a network partition
// must release the Node worker and let the existing idempotent recovery paths
// retry rather than indefinitely consuming capacity.
export const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;

// The service-role key bypasses row-level security and is attached to every
// Supabase request. Treat its destination as a credential boundary rather
// than passing an arbitrary environment string to the client. QY Roam uses a
// hosted Supabase project, whose canonical API origin is
// https://<project-ref>.supabase.co with no path, query, userinfo, or custom
// port. Failing closed here also keeps checkout, webhook, admin, and readiness
// on one configuration decision.
export function canonicalSupabaseProjectUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || /[\u0000-\u001f\u007f]/.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:' ||
      url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function supabaseServiceRoleKey(value: unknown) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key.length >= 32 && key.length <= 4096 && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

export function hasRequiredSupabaseAdminConfig() {
  return Boolean(
    canonicalSupabaseProjectUrl(process.env.SUPABASE_URL) &&
    supabaseServiceRoleKey(process.env.SUPABASE_SERVICE_ROLE_KEY),
  );
}

export async function fetchSupabaseWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = SUPABASE_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const requestSignal = init?.signal || (input instanceof Request ? input.signal : undefined);
  const timeoutError = new Error('Supabase request timed out');
  const abortFromRequest = () => controller.abort(requestSignal?.reason);
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timeout);
    requestSignal?.removeEventListener('abort', abortFromRequest);
  };

  if (requestSignal?.aborted) abortFromRequest();
  else requestSignal?.addEventListener('abort', abortFromRequest, { once: true });

  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  let response: Response;
  try {
    response = await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    cleanup();
    throw error;
  }

  // `fetch` resolves as soon as response headers arrive. Supabase then reads
  // the PostgREST body (usually with `response.json()`), so clearing the
  // deadline here would let a proxy that stalls after its headers pin an
  // order-critical worker indefinitely. Wrap the body and retain the same
  // abort signal until it is fully consumed or cancelled.
  if (!response.body) {
    cleanup();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          cleanup();
          streamController.close();
          return;
        }
        streamController.enqueue(chunk.value);
      } catch (error) {
        cleanup();
        streamController.error(controller.signal.reason === timeoutError ? timeoutError : error);
      }
    },
    async cancel(reason) {
      cleanup();
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function getSupabaseAdmin() {
  const url = canonicalSupabaseProjectUrl(process.env.SUPABASE_URL);
  const key = supabaseServiceRoleKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchSupabaseWithTimeout },
  });
}
