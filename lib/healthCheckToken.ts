// The deployment wrapper writes this value into a curl header file. Keep the
// accepted format explicit and shared with the application so a configured
// token cannot contain a second header or be interpreted as configuration
// syntax during release readiness checks.
export const MAX_HEALTH_CHECK_TOKEN_LENGTH = 1_024;

export function healthCheckToken(value = process.env.HEALTH_CHECK_TOKEN) {
  if (!value || value.length < 24 || value.length > MAX_HEALTH_CHECK_TOKEN_LENGTH) return null;
  return /^[\x20-\x7e]+$/.test(value) ? value : null;
}
