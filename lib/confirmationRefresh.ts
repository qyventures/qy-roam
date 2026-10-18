export const CONFIRMATION_REFRESH_INITIAL_DELAY_MS = 3_000;
export const CONFIRMATION_REFRESH_MAX_DELAY_MS = 10_000;
export const CONFIRMATION_REFRESH_DELAY_STEP_MS = 500;
export const CONFIRMATION_REFRESH_MAX_ATTEMPTS = 20;

/**
 * Keep the first post-checkout reconciliation prompt, then back off enough
 * that a temporary one-minute confirmation throttle cannot consume the
 * customer's complete retry budget. The cap still bounds the longest quiet
 * period while a signed webhook or delayed payment is being reconciled.
 */
export function confirmationRefreshDelayMs(completedAttempts: number) {
  if (!Number.isSafeInteger(completedAttempts) || completedAttempts < 0) {
    return CONFIRMATION_REFRESH_INITIAL_DELAY_MS;
  }
  return Math.min(
    CONFIRMATION_REFRESH_INITIAL_DELAY_MS + completedAttempts * CONFIRMATION_REFRESH_DELAY_STEP_MS,
    CONFIRMATION_REFRESH_MAX_DELAY_MS,
  );
}
