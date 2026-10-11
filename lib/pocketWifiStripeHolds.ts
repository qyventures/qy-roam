import type Stripe from 'stripe';
import { parseExactIsoDate } from './checkoutValidation';
import {
  MAX_STRIPE_HOLD_SCAN_PAGES,
  STRIPE_HOLD_SCAN_PAGE_TIMEOUT_MS,
  STRIPE_HOLD_SCAN_WINDOW_SECONDS,
} from './checkoutExpiry';
import { stripeEventMatchesConfiguredMode } from './stripeCheckoutConfig';
import { validQyRoamProvenance } from './orderProvenance';
import { validStripeCheckoutSessionIdForMode } from './stripeSessionId';

export type ActivePocketWifiStripeHold = {
  session: Stripe.Checkout.Session;
  sessionId: string;
  start: string;
  end: string;
};

/**
 * Inspect every recent open Stripe Session that can authoritatively consume
 * Pocket WiFi stock. Availability and checkout deliberately share this scan:
 * a difference in provenance, expiry, pagination, or mode handling between
 * those two purchase boundaries could advertise capacity that checkout must
 * reject, or let checkout omit a hold that availability counted.
 */
export async function scanActivePocketWifiStripeHolds(
  stripe: Stripe,
  stripeKey: string,
  visit: (hold: ActivePocketWifiStripeHold) => void,
) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - STRIPE_HOLD_SCAN_WINDOW_SECONDS;
  let startingAfter: string | undefined;
  let pagesScanned = 0;
  const seenSessionIds = new Set<string>();

  for (;;) {
    if (pagesScanned >= MAX_STRIPE_HOLD_SCAN_PAGES) {
      throw new Error('Stripe Pocket WiFi hold scan exceeded its safe page limit');
    }
    const sessions = await stripe.checkout.sessions.list(
      { status: 'open', limit: 100, created: { gte: cutoff }, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      { timeout: STRIPE_HOLD_SCAN_PAGE_TIMEOUT_MS, maxNetworkRetries: 0 },
    );
    pagesScanned += 1;

    // The Stripe SDK is a compile-time shape guarantee, not a runtime one.
    // This response controls both inventory arithmetic and the next outbound
    // pagination cursor, so an incomplete proxy/SDK response must fail the
    // whole capacity check closed instead of being interpreted as an empty or
    // final page.
    if (!sessions || !Array.isArray(sessions.data) || typeof sessions.has_more !== 'boolean') {
      throw new Error('Stripe Pocket WiFi hold scan returned an invalid page');
    }

    for (const session of sessions.data) {
      // Validate every identifier because the last row may become an outbound
      // pagination cursor even when the Session is unrelated to QY Roam.
      const sessionId = validStripeCheckoutSessionIdForMode(session.id, session.livemode);
      if (!sessionId) throw new Error('Stripe returned an invalid Checkout Session identifier');
      // Cursor pagination should expose each Checkout Session exactly once.
      // If Stripe or an intermediary repeats a row across pages, counting it
      // twice makes availability inconsistent with the durable reservation
      // authority; silently ignoring it could hide a non-advancing page.
      // Reject the snapshot so both availability and checkout remain aligned.
      if (seenSessionIds.has(sessionId)) {
        throw new Error('Stripe Pocket WiFi hold scan returned a duplicate Checkout Session');
      }
      seenSessionIds.add(sessionId);
      if (!stripeEventMatchesConfiguredMode(stripeKey, session.livemode)) continue;
      if (session.metadata?.source !== 'qyroam.com' || !validQyRoamProvenance(sessionId, session.metadata)) continue;
      if (session.metadata?.product_type !== 'pocket_wifi') continue;
      if (session.mode !== 'payment' ||
        !Number.isSafeInteger(session.created) || session.created < cutoff ||
        !Number.isSafeInteger(session.expires_at) || session.expires_at! <= session.created) {
        throw new Error('Stripe returned an invalid authenticated Pocket WiFi hold lifecycle');
      }
      if (session.expires_at <= nowSeconds) continue;

      const start = session.metadata?.start;
      const end = session.metadata?.end;
      const startDate = parseExactIsoDate(start);
      const endDate = parseExactIsoDate(end);
      if (!startDate || !endDate || endDate < startDate) {
        throw new Error('Stripe returned invalid dates for an authenticated Pocket WiFi hold');
      }
      visit({ session, sessionId, start: start!, end: end! });
    }

    if (!sessions.has_more) return;
    if (sessions.data.length === 0) {
      throw new Error('Stripe Pocket WiFi hold scan returned an empty continuation page');
    }
    const cursor = sessions.data[sessions.data.length - 1];
    startingAfter = validStripeCheckoutSessionIdForMode(cursor.id, cursor.livemode)!;
  }
}
