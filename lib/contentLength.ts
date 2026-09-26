export function declaredContentLength(value: string | null, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('Invalid request body limit');
  }
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new TypeError('Invalid Content-Length');
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new TypeError('Invalid Content-Length');
  if (length > maximumBytes) throw new RangeError('Request body is too large');
  return length;
}

export function contentLengthMatches(declared: number | null, actual: number) {
  return declared === null || declared === actual;
}
