import { createClient } from '@supabase/supabase-js';
import { contentLengthMatches, declaredContentLength } from './contentLength';

// PostgREST requests otherwise inherit the platform fetch timeout, which can
// be several minutes (or unlimited). Supabase backs checkout reservations,
// paid-order persistence, and webhook idempotency, so a network partition
// must release the Node worker and let the existing idempotent recovery paths
// retry rather than indefinitely consuming capacity.
export const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;
// Every current operational list is explicitly paginated, while checkout and
// webhook mutations return only a handful of rows. This ceiling is generous
// for those responses but prevents a broken PostgREST gateway or proxy from
// streaming an unbounded body into a worker that will eventually call json().
export const SUPABASE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
// A byte ceiling alone does not bound the amount of stream bookkeeping. A
// broken gateway can deliver a legal-sized JSON response one byte at a time,
// forcing millions of pull/promise turns on a checkout or webhook worker.
// Normal PostgREST responses use comparatively large network chunks; this
// ceiling leaves ample headroom while putting a deterministic bound on work.
export const SUPABASE_RESPONSE_MAX_CHUNKS = 16_384;

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

export async function fetchSupabaseWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = SUPABASE_REQUEST_TIMEOUT_MS,
  maximumResponseBytes = SUPABASE_RESPONSE_MAX_BYTES,
) {
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 0) {
    throw new RangeError('Invalid Supabase response body limit');
  }
  const controller = new AbortController();
  const requestSignal = init?.signal || (input instanceof Request ? input.signal : undefined);
  const timeoutError = new Error('Supabase request timed out');
  const abortFromRequest = () => {
    const reason = requestSignal?.reason instanceof Error
      ? requestSignal.reason
      : new Error('Supabase request aborted');
    controller.abort(reason);
    // Some fetch implementations and proxy-backed response streams do not
    // promptly reject when their AbortSignal fires. Caller cancellation is a
    // stricter deadline than this transport's own timeout (notably the 8s
    // production-readiness probe inside the 15s Supabase boundary), so race
    // it explicitly as well as forwarding the signal to fetch.
    rejectDeadline?.(reason);
  };
  let cleanedUp = false;
  let rejectDeadline: ((reason: Error) => void) | undefined;

  // Aborting the fetch is normally enough to reject an in-flight body read,
  // but the custom fetch boundary can also be backed by a proxy/runtime stream
  // that does not promptly observe AbortSignal. Race the header request and
  // every body read against one explicit deadline so an order-critical worker
  // is released even when that upstream stream never settles.
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timeout);
    requestSignal?.removeEventListener('abort', abortFromRequest);
  };

  if (requestSignal?.aborted) abortFromRequest();
  else requestSignal?.addEventListener('abort', abortFromRequest, { once: true });

  const timeout = setTimeout(() => {
    controller.abort(timeoutError);
    rejectDeadline?.(timeoutError);
  }, timeoutMs);
  let response: Response;
  try {
    response = await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      deadline,
    ]);
  } catch (error) {
    cleanup();
    throw error;
  }

  let contentLength: number | null;
  try {
    contentLength = declaredContentLength(response.headers.get('content-length'), maximumResponseBytes);
  } catch {
    cleanup();
    void response.body?.cancel().catch(() => undefined);
    throw new RangeError('Supabase response body is too large or invalid');
  }

  // `fetch` resolves as soon as response headers arrive. Supabase then reads
  // the PostgREST body (usually with `response.json()`), so clearing the
  // deadline here would let a proxy that stalls after its headers pin an
  // order-critical worker indefinitely. Wrap the body and retain the same
  // abort signal until it is fully consumed or cancelled.
  // Fetch implementations generally expose a decoded body while preserving
  // the encoded Content-Length. Only require an exact byte count when no
  // content coding is present; the decoded stream remains protected by the
  // independent maximum below in either case.
  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  const exactLengthExpected = !contentEncoding || contentEncoding === 'identity';
  if (!response.body) {
    cleanup();
    if (exactLengthExpected && !contentLengthMatches(contentLength, 0)) {
      throw new Error('Supabase response body is incomplete');
    }
    return response;
  }

  const reader = response.body.getReader();
  let responseBytes = 0;
  let responseChunks = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.done) {
          cleanup();
          if (exactLengthExpected && !contentLengthMatches(contentLength, responseBytes)) {
            streamController.error(new Error('Supabase response body is incomplete'));
            return;
          }
          streamController.close();
          return;
        }
        responseChunks += 1;
        if (responseChunks > SUPABASE_RESPONSE_MAX_CHUNKS) {
          const fragmentationError = new RangeError('Supabase response body is too fragmented');
          cleanup();
          void reader.cancel(fragmentationError).catch(() => undefined);
          streamController.error(fragmentationError);
          return;
        }
        responseBytes += chunk.value.byteLength;
        if (responseBytes > maximumResponseBytes) {
          const sizeError = new RangeError('Supabase response body is too large');
          cleanup();
          // Do not await cancellation: a broken upstream must not be able to
          // turn the response-size boundary into another unbounded wait.
          void reader.cancel(sizeError).catch(() => undefined);
          streamController.error(sizeError);
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
