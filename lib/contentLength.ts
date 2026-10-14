// JavaScript's largest safe integer has 16 decimal digits. Bound the raw
// header before applying a regular expression or converting it to a number so
// a directly reached application runtime cannot be made to scan an
// arbitrarily long, attacker-controlled Content-Length value. Values longer
// than this cannot describe a body size this parser can safely represent.
export const MAX_CONTENT_LENGTH_HEADER_LENGTH = String(Number.MAX_SAFE_INTEGER).length;

export function declaredContentLength(value: string | null, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError('Invalid request body limit');
  }
  if (value === null) return null;
  if (value.length > MAX_CONTENT_LENGTH_HEADER_LENGTH) throw new TypeError('Invalid Content-Length');
  if (!/^\d+$/.test(value)) throw new TypeError('Invalid Content-Length');
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new TypeError('Invalid Content-Length');
  if (length > maximumBytes) throw new RangeError('Request body is too large');
  return length;
}

export function contentLengthMatches(declared: number | null, actual: number) {
  return declared === null || declared === actual;
}
