export const CUSTOMER_REQUEST_TIMEOUT_MS = 120_000;
// Checkout and operations endpoints return compact JSON envelopes. Bound the
// browser-side response as well as its deadline: an erroneous proxy response
// must not keep allocating memory before the UI can restore the checkout
// button and safely retry with the same idempotency key.
export const CUSTOMER_JSON_RESPONSE_MAX_BYTES = 64 * 1024;
export const CUSTOMER_JSON_RESPONSE_MAX_CHUNKS = 1_024;
// This value is inspected before splitting or normalising Content-Type. The
// application emits the short canonical JSON media type, so a larger value
// cannot be useful to a customer response and should not make browser work
// scale with a malformed proxy or service-worker header.
export const CUSTOMER_JSON_CONTENT_TYPE_MAX_LENGTH = 256;
export const CUSTOMER_JSON_CONTENT_ENCODING_MAX_LENGTH = 64;

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

function customerRequestInputIsSameOrigin(input: RequestInfo | URL) {
  const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;

  // Relative application paths remain testable outside a browser, while an
  // absolute input needs the browser's current origin as its authority. Parse
  // even an apparently root-relative path: for special URL schemes browsers
  // normalise backslashes as path separators, so `/\\example.com` resolves to
  // a cross-origin authority rather than an application path.
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) {
    try {
      const relativeBase = new URL('https://qy-roam.invalid/');
      const target = new URL(raw, relativeBase);
      return target.protocol === relativeBase.protocol && target.origin === relativeBase.origin;
    } catch {
      return false;
    }
  }
  if (typeof window === 'undefined') return false;

  try {
    const target = new URL(raw, window.location.href);
    return (target.protocol === 'https:' || target.protocol === 'http:') &&
      target.origin === window.location.origin;
  } catch {
    return false;
  }
}

export function isCustomerJsonResponseContentType(value: string | null) {
  if (!value || value.length > CUSTOMER_JSON_CONTENT_TYPE_MAX_LENGTH) return false;
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

export function customerResponseContentEncoding(value: string | null) {
  if (value === null) return 'identity' as const;
  // Fetch normally exposes the decoded representation while retaining the
  // wire Content-Encoding header. Bound and validate that header before any
  // normalisation so a malformed proxy/service-worker response cannot make
  // checkout work scale with attacker-controlled metadata. Multiple or
  // parameterised encodings are not valid for this compact same-origin JSON
  // contract and therefore cannot waive the identity length check below.
  if (!value || value.length > CUSTOMER_JSON_CONTENT_ENCODING_MAX_LENGTH ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) {
    throw new Error('Invalid customer response content encoding');
  }
  const encoding = value.toLowerCase();
  if (encoding === 'identity') return 'identity' as const;
  // Browser fetch exposes decoded response bytes for these standard content
  // codings while it may retain the encoded wire Content-Length. Only those
  // runtime-supported values may waive the exact decoded-length comparison;
  // an arbitrary token from a proxy or service worker must not weaken the
  // authority boundary for checkout URLs and confirmation capabilities.
  if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') return 'encoded' as const;
  throw new Error('Unsupported customer response content encoding');
}

async function readBoundedJson(response: Response, signal: AbortSignal) {
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
    // A safe integer has at most 16 decimal digits. Check the raw header
    // before regex/number conversion; surrounding whitespace is not part of
    // the canonical browser capability-response contract.
    if (declared.length > String(Number.MAX_SAFE_INTEGER).length || !/^\d+$/.test(declared)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Invalid customer response length');
    }
    declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > CUSTOMER_JSON_RESPONSE_MAX_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Customer response is too large');
    }
  }
  let contentEncoding: string | null;
  try {
    contentEncoding = customerResponseContentEncoding(response.headers.get('content-encoding'));
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  if (!response.body) throw new Error('Customer response body is missing');

  const reader = response.body.getReader();
  const bytes = new Uint8Array(CUSTOMER_JSON_RESPONSE_MAX_BYTES);
  let total = 0;
  let chunks = 0;
  let rejectCancellation: ((reason: unknown) => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const cancelFromSignal = () => {
    const reason = signal.reason instanceof Error
      ? signal.reason
      : new Error('Customer response cancelled');
    // An explicit race releases the UI even when a custom/proxy-backed
    // response reader ignores fetch's AbortSignal. Cancel the locked reader
    // as well so that the underlying stream is not left consuming network or
    // service-worker work after the caller has already recovered.
    rejectCancellation?.(reason);
    void reader.cancel(reason).catch(() => undefined);
  };
  if (signal.aborted) cancelFromSignal();
  else signal.addEventListener('abort', cancelFromSignal, { once: true });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), cancellation]);
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
  } catch (error) {
    // Parsing, size, fragmentation and cancellation failures are all
    // terminal. Stop the source explicitly; releasing a reader lock alone
    // does not cancel its stream and can leave a response running unnoticed.
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelFromSignal);
    rejectCancellation = undefined;
    try { reader.releaseLock(); } catch {}
  }
  // Fetch can expose a decoded stream while retaining the compressed wire
  // length, so only require byte-for-byte agreement for identity responses.
  // Same-origin checkout APIs are uncompressed at the application boundary;
  // a short or overlong body there must not become an authoritative payment
  // capability merely because its available prefix is still valid JSON.
  if (declaredBytes !== null && contentEncoding === 'identity' && total !== declaredBytes) {
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
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('Invalid customer request timeout');
  }
  if (!customerRequestInputIsSameOrigin(input)) {
    throw new TypeError('Customer requests must use the current application origin');
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
    // These helpers are an authority boundary for checkout URLs and completed
    // Session ids returned by QY Roam's same-origin APIs. Fetch follows
    // redirects by default, including POST redirects that can change the
    // method to GET. A proxy, service worker, or future route regression must
    // not be able to move that request to another response authority before
    // the bounded JSON and capability validators run. Keep this after the
    // caller's init so an accidental `redirect: 'follow'` cannot weaken the
    // shared contract.
    const operation = fetch(input, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
      credentials: 'same-origin',
    })
      .then((response) => consume(response, controller.signal));
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
  return runCustomerRequest(input, init, timeoutMs, async (response, signal) => ({
    response,
    value: await readBoundedJson(response, signal),
  }));
}
