export const CUSTOMER_REQUEST_TIMEOUT_MS = 120_000;
// Checkout and operations endpoints return compact JSON envelopes. Bound the
// browser-side response as well as its deadline: an erroneous proxy response
// must not keep allocating memory before the UI can restore the checkout
// button and safely retry with the same idempotency key.
export const CUSTOMER_JSON_RESPONSE_MAX_BYTES = 64 * 1024;
export const CUSTOMER_JSON_RESPONSE_MAX_CHUNKS = 1_024;

export class CustomerRequestTimeoutError extends Error {
  constructor() {
    super('QY Roam request timed out');
    this.name = 'CustomerRequestTimeoutError';
  }
}

type CustomerJsonResponse = {
  response: Response;
  value: unknown;
};

export function isCustomerJsonResponseContentType(value: string | null) {
  if (!value) return false;
  const parts = value.split(';').map((part) => part.trim());
  if (parts.shift()?.toLowerCase() !== 'application/json') return false;

  let sawCharset = false;
  for (const parameter of parts) {
    const separator = parameter.indexOf('=');
    if (separator < 1) return false;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    const raw = parameter.slice(separator + 1).trim().toLowerCase();
    const parameterValue = raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1)
      : raw;
    // The reader below always decodes bytes as UTF-8. Reject additional or
    // conflicting response parameters instead of silently interpreting a
    // payment-capability document under different media-type semantics.
    if (name !== 'charset' || sawCharset || (parameterValue !== 'utf-8' && parameterValue !== 'utf8')) return false;
    sawCharset = true;
  }
  return true;
}

async function readBoundedJson(response: Response) {
  // Checkout URLs and completed-session ids are browser capabilities. A
  // proxy error page or stale service worker must not become authoritative
  // merely because its body happens to parse as JSON.
  if (!isCustomerJsonResponseContentType(response.headers.get('content-type'))) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('Invalid customer response content type');
  }
  const declared = response.headers.get('content-length');
  let declaredBytes: number | null = null;
  if (declared !== null) {
    // Content-Length is bytes on the wire. Browsers may expose a decoded body
    // while retaining the encoded length, so it is useful as an early upper
    // bound but not as an exact decoded-length assertion.
    if (!/^\d+$/.test(declared.trim())) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Invalid customer response length');
    }
    declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > CUSTOMER_JSON_RESPONSE_MAX_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Customer response is too large');
    }
  }
  if (!response.body) throw new Error('Customer response body is missing');

  const reader = response.body.getReader();
  const bytes = new Uint8Array(CUSTOMER_JSON_RESPONSE_MAX_BYTES);
  let total = 0;
  let chunks = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      if (chunks > CUSTOMER_JSON_RESPONSE_MAX_CHUNKS) {
        void reader.cancel().catch(() => undefined);
        throw new Error('Customer response is too fragmented');
      }
      if (!value) continue;
      total += value.byteLength;
      if (total > CUSTOMER_JSON_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error('Customer response is too large');
      }
      bytes.set(value, total - value.byteLength);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  // Fetch can expose a decoded stream while retaining the compressed wire
  // length, so only require byte-for-byte agreement for identity responses.
  // Same-origin checkout APIs are uncompressed at the application boundary;
  // a short or overlong body there must not become an authoritative payment
  // capability merely because its available prefix is still valid JSON.
  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if (declaredBytes !== null && (!contentEncoding || contentEncoding === 'identity') && total !== declaredBytes) {
    throw new Error('Customer response body length does not match Content-Length');
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
  } catch {
    throw new Error('Invalid customer JSON encoding');
  }
  return JSON.parse(decoded) as unknown;
}

async function runCustomerRequest<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('Invalid customer request timeout');
  }

  const controller = new AbortController();
  const callerSignal = init.signal;
  let rejectDeadline: ((reason: Error) => void) | undefined;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const abortFromCaller = () => {
    const reason = callerSignal?.reason instanceof Error
      ? callerSignal.reason
      : new Error('Customer request cancelled');
    controller.abort(reason);
    rejectDeadline?.(reason);
  };
  const timeoutError = new CustomerRequestTimeoutError();
  const timeout = setTimeout(() => {
    controller.abort(timeoutError);
    // Race explicitly as well as aborting fetch and response consumption:
    // some browser/network edge cases do not settle either promise promptly
    // after signal cancellation.
    rejectDeadline?.(timeoutError);
  }, timeoutMs);

  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const operation = fetch(input, { ...init, signal: controller.signal })
      .then(consume);
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
    rejectDeadline = undefined;
  }
}

// Customer requests can legitimately span several bounded Stripe and
// persistence calls. Give the server its full reviewed proxy window, but do
// not leave the storefront disabled forever when a mobile connection drops
// without closing its fetch. The checkout attempt id is retained by callers,
// so retrying after this timeout remains idempotent.
export async function fetchCustomerRequest(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = CUSTOMER_REQUEST_TIMEOUT_MS,
) {
  return runCustomerRequest(input, init, timeoutMs, async (response) => response);
}

// Storefront callers need the deadline to cover the complete response, not
// only receipt of its headers. A proxy or mobile peer can return headers and
// then stall the JSON body; clearing the timer at that point would leave the
// checkout button disabled forever. Keep parsing inside the same abortable,
// explicitly raced operation and return the Response metadata separately for
// the existing status-aware envelope validators.
export async function fetchCustomerJson(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = CUSTOMER_REQUEST_TIMEOUT_MS,
): Promise<CustomerJsonResponse> {
  return runCustomerRequest(input, init, timeoutMs, async (response) => ({
    response,
    value: await readBoundedJson(response),
  }));
}
