// Admin mutation fields are audit and workflow inputs, not display excerpts.
// Normalise harmless surrounding whitespace, but never truncate or coerce a
// supplied value: doing so can turn a malformed date/enum with a valid prefix
// into a different command that passes downstream validation.
export function boundedInputText(value: unknown, maxLength = 500) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError('Invalid input text limit');
  }
  if (value === undefined || value === null) return '';
  // Keep invalid supplied values distinct from an omitted optional field.
  // Callers commonly use `value || default`; returning an empty string here
  // would let malformed input silently select that default.
  const invalid = () => '\ufffd'.repeat(maxLength + 1);
  if (typeof value !== 'string') return invalid();
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return invalid();
  return normalized;
}
