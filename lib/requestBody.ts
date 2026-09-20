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

function validRequestBodyLimit(maxBytes: number, timeoutMs: number) {
  return Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= MAX_REQUEST_BODY_LIMIT_BYTES &&
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_REQUEST_BODY_TIMEOUT_MS;
}

/**
 * Accept JSON media types with optional parameters (for example a charset),
 * but do not treat a lookalike type such as `application/jsonp` as JSON.
 * Public checkout and authenticated operations routes use this before reading
 * a request body, keeping their declared and parsed formats aligned.
 */
export function isJsonRequestContentType(value: string | null) {
  if (!value) return false;
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

export async function readLimitedRequestText(req: Request, maxBytes: number, timeoutMs: number) {
  // Validate the bounds before consulting Content-Length or obtaining a
  // reader. This keeps a programming/configuration error fail-closed instead
  // of reading an unbounded request body, and makes it impossible to create a
  // timer that never provides the promised deadline.
  if (!validRequestBodyLimit(maxBytes, timeoutMs)) {
    throw new InvalidRequestBodyLimitError('Invalid request body limits');
  }
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null && !/^\d+$/.test(contentLength)) {
    throw new InvalidRequestBodyLengthError('Invalid request body length');
  }
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new RequestBodyTooLargeError('Request body is too large');
  }
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
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
      chunks.push(value);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}
