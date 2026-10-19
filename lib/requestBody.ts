import { contentLengthMatches, declaredContentLength } from './contentLength';

// Route handlers receive a streaming Request body.  Do not rely on a proxy's
// Content-Length/body timeout for a public endpoint: chunked requests can omit
// that header and a client can otherwise occupy a Node worker indefinitely.
export class RequestBodyTooLargeError extends Error {}
export class RequestBodyTimeoutError extends Error {}
export class InvalidRequestBodyLengthError extends Error {}
export class InvalidRequestBodyLimitError extends Error {}

// Route handlers currently need only a few KiB of JSON. Keep the shared
// streaming helper safe if a future endpoint accidentally passes a value from
// configuration (or an unvalidated calculation): `NaN` makes a `total >
// maxBytes` comparison permanently false, while an infinite deadline defeats
// the slow-upload protection entirely. Larger uploads should use a dedicated
// streaming protocol rather than this text-buffering helper.
export const MAX_REQUEST_BODY_LIMIT_BYTES = 1_000_000;
export const MAX_REQUEST_BODY_TIMEOUT_MS = 60_000;
// Web Streams do not require chunks to contain any bytes. A hostile client
// can therefore stay below the byte ceiling while forcing an unbounded number
// of reads/promises (including zero-length chunks). Real HTTP bodies arrive
// in far fewer chunks; cap the work independently from the payload size.
export const MAX_REQUEST_BODY_CHUNKS = 4_096;
// These headers are parsed before a public request reaches any body or
// dependency-work admission pool. Reverse proxies normally cap all headers,
// but the standalone server can also be reached directly in a smoke test or
// a changed deployment topology. Bound normalization work here so an
// attacker-controlled value cannot make a cheap media-type check allocate or
// scan an arbitrarily large string before the route rejects the request.
export const MAX_JSON_CONTENT_TYPE_HEADER_LENGTH = 256;
export const MAX_CONTENT_ENCODING_HEADER_LENGTH = 64;

function validRequestBodyLimit(maxBytes: number, timeoutMs: number) {
  return Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= MAX_REQUEST_BODY_LIMIT_BYTES &&
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_REQUEST_BODY_TIMEOUT_MS;
}

// Content-Length is only a hint until the streaming reader compares it with
// the bytes actually received, but an invalid or already-oversized hint can be
// rejected before a request occupies a scarce slow-upload slot. Keep the
// classification shared with the reader so pre-admission and final validation
// cannot disagree about whether a request is malformed or too large.
export function validateLimitedRequestContentLength(req: Request, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_REQUEST_BODY_LIMIT_BYTES) {
    throw new InvalidRequestBodyLimitError('Invalid request body limit');
  }
  try {
    return declaredContentLength(req.headers.get('content-length'), maxBytes);
  } catch (error) {
    if (error instanceof RangeError) throw new RequestBodyTooLargeError('Request body is too large');
    throw new InvalidRequestBodyLengthError('Invalid request body length');
  }
}

/**
 * Accept JSON media types with optional parameters (for example a charset),
 * but do not treat a lookalike type such as `application/jsonp` as JSON.
 * Public checkout and authenticated operations routes use this before reading
 * a request body, keeping their declared and parsed formats aligned.
 */
export function isJsonRequestContentType(value: string | null) {
  if (!value || value.length > MAX_JSON_CONTENT_TYPE_HEADER_LENGTH) return false;
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

/**
 * The bounded readers account for the exact bytes exposed by the runtime and
 * compare them with the request's declared Content-Length. Content codings can
 * make that relationship depend on whether a proxy/runtime has already
 * decoded the stream, and a compact encoded request can expand well beyond
 * the intended application work budget. JSON mutation endpoints therefore
 * accept only the untransformed representation (an explicit identity coding
 * is equivalent to an omitted header).
 */
export function hasIdentityRequestContentEncoding(value: string | null) {
  return value === null || (
    value.length <= MAX_CONTENT_ENCODING_HEADER_LENGTH &&
    value.trim().toLowerCase() === 'identity'
  );
}

export async function readLimitedRequestText(req: Request, maxBytes: number, timeoutMs: number) {
  // Validate the bounds before consulting Content-Length or obtaining a
  // reader. This keeps a programming/configuration error fail-closed instead
  // of reading an unbounded request body, and makes it impossible to create a
  // timer that never provides the promised deadline.
  if (!validRequestBodyLimit(maxBytes, timeoutMs)) {
    throw new InvalidRequestBodyLimitError('Invalid request body limits');
  }
  const contentLength = validateLimitedRequestContentLength(req, maxBytes);
  if (!req.body) {
    if (!contentLengthMatches(contentLength, 0)) throw new InvalidRequestBodyLengthError('Request body length does not match Content-Length');
    return '';
  }

  const reader = req.body.getReader();
  // Allocate exactly the already-validated maximum and copy each chunk into
  // it so payload storage cannot grow with fragmentation. The independent
  // chunk ceiling below bounds read/promise work as well. Callers use small
  // JSON limits; larger uploads should stream directly to durable storage.
  const body = Buffer.allocUnsafe(maxBytes);
  let total = 0;
  let chunks = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bodyTimeout = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new RequestBodyTimeoutError('Request body timed out'));
      // Reject before cancelling. Cancelling can resolve a pending read with
      // `done: true`; doing it first would let Promise.race accept that empty
      // read instead of surfacing this deadline.
      // Cancellation is deliberately not awaited: a peer that ignores it must
      // not extend the deadline while the route is trying to free the stream.
      void reader.cancel().catch(() => undefined);
    }, timeoutMs);
  });

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), bodyTimeout]);
      if (done) break;
      chunks += 1;
      if (chunks > MAX_REQUEST_BODY_CHUNKS) {
        void reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError('Request body is too fragmented');
      }
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // A peer can ignore (or indefinitely delay) stream cancellation.
        // The size boundary has already been crossed, so return the bounded
        // error immediately instead of letting cleanup pin this route worker.
        // This mirrors the timeout path above; the stream is still asked to
        // stop, but cancellation is never part of the request's latency.
        void reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError('Request body is too large');
      }
      body.set(value, total - value.byteLength);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    // A timeout or size rejection can leave a read settling while the
    // best-effort cancellation above is still in progress. Web Streams are
    // allowed to reject releaseLock in that narrow state. Cleanup must never
    // mask the intentional bounded-body error (and accidentally turn a 408
    // or 413 into the route's generic invalid-request response).
    try { reader.releaseLock(); } catch {}
  }
  if (!contentLengthMatches(contentLength, total)) {
    throw new InvalidRequestBodyLengthError('Request body length does not match Content-Length');
  }
  return body.subarray(0, total).toString('utf8');
}
