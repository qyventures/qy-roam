// Route handlers receive a streaming Request body.  Do not rely on a proxy's
// Content-Length/body timeout for a public endpoint: chunked requests can omit
// that header and a client can otherwise occupy a Node worker indefinitely.
export class RequestBodyTooLargeError extends Error {}
export class RequestBodyTimeoutError extends Error {}
export class InvalidRequestBodyLengthError extends Error {}

export async function readLimitedRequestText(req: Request, maxBytes: number, timeoutMs: number) {
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
        await reader.cancel();
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
