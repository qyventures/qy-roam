const ADMIN_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A browser-generated UUID v4 used to make one admin mutation retry-safe. */
export function validAdminOperationId(value: unknown) {
  return typeof value === 'string' && ADMIN_OPERATION_ID_PATTERN.test(value) ? value : null;
}

export function createAdminOperationId() {
  return crypto.randomUUID();
}
