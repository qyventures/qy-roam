export const MAX_POCKET_WIFI_RENTAL_DAYS = 90;

const DAY_MS = 86_400_000;

/** Inclusive rental length for already validated UTC calendar dates. */
export function pocketWifiRentalDays(start: Date, end: Date) {
  return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
}
