export function normalizedCustomerPhone(value: unknown) {
  // Customer contact is copied into the durable order and operational CRM.
  // Accept ordinary international formatting, but keep `+` at the beginning
  // and reject controls, letters, extensions, and implausible digit counts.
  if (typeof value !== 'string' || value.length > 32 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (!/^\+?[0-9 ()-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}
