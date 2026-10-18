// The deployment wrapper writes this value into a curl header file. Keep the
// accepted format explicit and shared with the application so a configured
// token cannot contain a second header or be interpreted as configuration
// syntax during release readiness checks.
export const MAX_HEALTH_CHECK_TOKEN_LENGTH = 1_024;

export function healthCheckToken(value = process.env.HEALTH_CHECK_TOKEN) {
  if (!value || value.length < 24 || value.length > MAX_HEALTH_CHECK_TOKEN_LENGTH) return null;
  // HTTP field values permit optional whitespace around their contents, and
  // proxies/clients are allowed to normalize it. A token containing spaces
  // could therefore pass deployment preflight but arrive at the application
  // with different bytes, making every authenticated readiness probe fail.
  // Require visible non-space ASCII so the environment value, curl header
  // file, proxy hop and application comparison all share one exact identity.
  return /^[\x21-\x7e]+$/.test(value) ? value : null;
}
