export const MAX_CUSTODY_REFERENCE_LENGTH = 200;

export function normalizeCustodyReference(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function custodyReferenceIssue(value: string) {
  if (!value) return 'A custody reference is required.';
  if (value.length > MAX_CUSTODY_REFERENCE_LENGTH) {
    return `Custody references must be ${MAX_CUSTODY_REFERENCE_LENGTH} characters or fewer.`;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return 'Custody references cannot contain control characters or line breaks.';
  }
  return null;
}
