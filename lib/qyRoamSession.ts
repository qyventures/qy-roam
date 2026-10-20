import type Stripe from 'stripe';
import { ESIM_PROMO, getEsimPlan } from './esimPlans';
import { LAUNCH_PROMO } from './promotions';
import { getWifiPlan, WIFI_BENCHMARK } from './wifiPlans';
import { parseExactIsoDate, validCheckoutRequestId } from './checkoutValidation';
import { validQyRoamProvenance } from './orderProvenance';
import { operationalConfig } from './operationalConfig';
import { pocketWifiRentalCents } from './pocketWifiPricing';
import { MAX_POCKET_WIFI_RENTAL_DAYS, pocketWifiRentalDays } from './pocketWifiRentalPeriod';
import { validStripeCheckoutSessionIdForMode } from './stripeSessionId';
import { validStripeEventCreated } from './stripeEventCreated';
import { CHECKOUT_PAYMENT_WINDOW_MINUTES, STRIPE_HOLD_SCAN_WINDOW_SECONDS } from './checkoutExpiry';

export type QyRoamProductType = 'esim' | 'pocket_wifi';

export function qyRoamProductType(session: Stripe.Checkout.Session): QyRoamProductType | null {
  if (session.metadata?.source !== 'qyroam.com') return null;
  const productType = session.metadata?.product_type;
  return productType === 'esim' || productType === 'pocket_wifi' ? productType : null;
}

export type QyRoamSessionValidation =
  | { valid: true; productType: QyRoamProductType }
  | { valid: false; reason: string };

function moneyMetadataCents(value?: string) {
  if (!value || !/^\d+\.\d{2}$/.test(value)) return null;
  const cents = Number(value.replace('.', ''));
  return Number.isSafeInteger(cents) ? cents : null;
}

function canonicalMetadataText(value: unknown, maxLength: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function checkoutAmountSnapshotIsConsistent(session: Stripe.Checkout.Session) {
  const amount = session.amount_total;
  // Keep the amount snapshot canonical as well as signed. A valid HMAC proves
  // that metadata came from this application, but it does not make a
  // server-side creation defect (or a future consumer of this field) safe.
  // The Stripe amount is the payment authority and must exactly match the
  // server-authored integer-cent snapshot used throughout the order record.
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return false;
  return session.metadata?.checkout_amount_cents === String(amount);
}

function historicalPocketWifiSnapshotIsConsistent(session: Stripe.Checkout.Session, days: number) {
  const metadata = session.metadata;
  const country = metadata?.country || '';
  const daily = moneyMetadataCents(metadata?.daily_rate_sgd);
  const benchmark = moneyMetadataCents(metadata?.benchmark_rate_sgd);
  const rental = moneyMetadataCents(metadata?.rental_before_promo_sgd);
  const discount = moneyMetadataCents(metadata?.promo_discount_sgd);
  const courierFee = moneyMetadataCents(metadata?.courier_fee_sgd);
  const checkoutAmount = Number(metadata?.checkout_amount_cents);
  if (!country || country.length > 100 || metadata?.plan_name !== `${country} Pocket WiFi` ||
    daily === null || daily < 1 || rental === null || discount === null || courierFee === null ||
    !checkoutAmountSnapshotIsConsistent(session) || !Number.isSafeInteger(checkoutAmount) || checkoutAmount < 1 ||
    !canonicalMetadataText(country, 100) || !canonicalMetadataText(metadata?.plan_name, 120) ||
    !canonicalMetadataText(metadata?.benchmark_provider, 100) ||
    benchmark === null || benchmark < 1 || !parseExactIsoDate(metadata?.benchmark_verified_on)) {
    return false;
  }
  // A retired or repriced catalogue row cannot re-authorise the public
  // below-benchmark claim from today's plan data. Reconstruct that claim from
  // the signed integer-cent snapshot instead. The HMAC proves authorship, but
  // it must not make a server-side construction defect (such as recording a
  // benchmark equal to or below QY's price) saleable or fulfilment-worthy.
  // Cross multiplication keeps the comparison exact and aligned with the
  // catalogue's approved minimum discount without floating-point rounding.
  if (daily * 100 > benchmark * (100 - WIFI_BENCHMARK.minimumDiscountPercent)) return false;
  const expectedRental = pocketWifiRentalCents(daily / 100, days);
  const expectedDiscount = metadata?.promo_code === LAUNCH_PROMO.code
    ? Math.floor((expectedRental * LAUNCH_PROMO.percent) / 100)
    : metadata?.promo_code === '' ? 0 : null;
  return rental === expectedRental && discount === expectedDiscount &&
    session.currency?.toLowerCase() === 'sgd' && checkoutAmount === rental - discount + courierFee;
}

function historicalEsimSnapshotIsConsistent(session: Stripe.Checkout.Session) {
  const metadata = session.metadata;
  const planId = metadata?.plan_id || '';
  const country = metadata?.country || '';
  const planName = metadata?.plan_name || '';
  const checkoutAmount = Number(metadata?.checkout_amount_cents);
  const benchmarkPrice = moneyMetadataCents(metadata?.benchmark_price_sgd);
  const dataAllowance = metadata?.data_allowance;
  // The checkout provenance authenticates this immutable-at-creation snapshot.
  // These checks still reject malformed records if a historic plan has since
  // been retired or repriced in the live catalogue.
  return /^[a-z0-9][a-z0-9-]{1,80}$/.test(planId) && canonicalMetadataText(country, 100) &&
    canonicalMetadataText(planName, 200) &&
    planName.startsWith(`${country} · `) && / · [1-9]\d{0,2} days$/.test(planName) &&
    // A current catalogue plan can safely supply a missing allowance for a
    // legacy in-flight Session. Once that plan is retired, however, this
    // signed snapshot is the only entitlement authority available to the
    // webhook and fulfilment team. Require it to identify the actual package
    // instead of accepting an order that the database must reject (and staff
    // could not provision unambiguously).
    canonicalMetadataText(dataAllowance, 200) &&
    metadata?.promo_code === ESIM_PROMO.code && metadata?.promo_discount_percent === String(ESIM_PROMO.percent) &&
    benchmarkPrice !== null && benchmarkPrice > 0 &&
    checkoutAmountSnapshotIsConsistent(session) && Number.isSafeInteger(checkoutAmount) && checkoutAmount >= 50 &&
    // A retired plan has no live catalogue row to re-authorise its price.
    // Reconstruct the advertised cent-floored launch price from the signed
    // benchmark instead of treating any positive signed amount as a valid
    // digital entitlement. This preserves legitimate historical sessions
    // while catching malformed server-authored snapshots before fulfilment.
    checkoutAmount === Math.floor(benchmarkPrice * (100 - ESIM_PROMO.percent) / 100) &&
    session.currency?.toLowerCase() === 'sgd';
}

/**
 * Validate the server-authored identity of a QY Roam Checkout Session before
 * paid-order persistence or fulfilment. Stripe signs webhook events, but a
 * session can also be created manually in a shared Stripe account. The source
 * marker alone must therefore not be enough to persist or fulfil an order.
 */
function validateQyRoamSessionSnapshot(session: Stripe.Checkout.Session): QyRoamSessionValidation {
  // Webhook callers validate this discriminator while deserialising the
  // signed event, but confirmation and protected admin recovery also pass
  // direct Stripe API reads through this shared authority. Keep the object
  // boundary here as well: an unexpected API shape must not become a durable
  // order, customer-visible confirmation, or fulfilment entitlement merely
  // because it carries copied Session fields and valid signed metadata.
  if (session.object !== 'checkout.session') {
    return { valid: false, reason: 'invalid Stripe Checkout Session object' };
  }
  const productType = qyRoamProductType(session);
  if (!productType) return { valid: false, reason: 'unknown QY Roam product identity' };
  // This validator is the reusable order/fulfilment authority, so it must not
  // depend on every caller remembering to validate the Stripe capability
  // first. Bind the opaque Checkout Session identity to its live/test mode
  // before spending HMAC work or accepting its signed commercial snapshot.
  // A correctly signed but malformed or cross-mode identity is not a QY Roam
  // order that confirmation, admin recovery, or a future worker may fulfil.
  if (!validStripeCheckoutSessionIdForMode(session.id, session.livemode)) {
    return { valid: false, reason: 'invalid or mode-mismatched Stripe Checkout Session identity' };
  }
  // Stripe's creation epoch is the immutable chronology anchor used by paid
  // webhook events and admin delivery recovery. The webhook validates it at
  // its deserialisation boundary, but this shared validator is also called on
  // direct Stripe API reads by customer confirmation and protected recovery
  // paths. Keep those callers from accepting an equally malformed signed
  // snapshot with a missing, pre-Stripe, or implausibly future creation time.
  if (!validStripeEventCreated(session.created)) {
    return { valid: false, reason: 'invalid Stripe Checkout Session creation time' };
  }
  // Both QY Roam checkout routes create a short, explicit payment window.
  // Stripe's object shape makes `expires_at` nullable at compile time, and a
  // valid metadata HMAC only proves that this application signed the
  // snapshot; neither is evidence that the Session retained the reviewed
  // payment window. Bind the fulfilment authority to the same lower bound
  // Stripe enforces and the same upper bound used by inventory hold scans.
  // This relationship remains valid for historical webhook retries because
  // both timestamps are immutable properties of the Checkout Session.
  const expiresAt = session.expires_at;
  const minimumExpiry = session.created + CHECKOUT_PAYMENT_WINDOW_MINUTES * 60;
  const maximumExpiry = session.created + STRIPE_HOLD_SCAN_WINDOW_SECONDS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt < minimumExpiry || expiresAt > maximumExpiry) {
    return { valid: false, reason: 'invalid QY Roam Checkout Session expiry window' };
  }
  // QY Roam sells one-time travel products. The metadata HMAC authenticates
  // the server-authored order snapshot, but it does not itself bind Stripe's
  // Checkout mode. Keep this payment boundary explicit so a future checkout
  // configuration regression (for example, a subscription session carrying
  // otherwise valid metadata) cannot enter fulfilment as a one-time order.
  if (session.mode !== 'payment') {
    return { valid: false, reason: 'QY Roam orders must use one-time payment Checkout mode' };
  }
  // Customer confirmation and protected delivery recovery read Checkout
  // Sessions directly from Stripe, while webhook callers validate a signed
  // event transition before reaching this shared boundary. Do not make the
  // direct-read callers rely on that webhook-only check: a missing, malformed,
  // or future lifecycle value must not authenticate as an order snapshot that
  // downstream code may persist, display, or use for fulfilment decisions.
  if (session.status !== 'open' && session.status !== 'complete' && session.status !== 'expired') {
    return { valid: false, reason: 'QY Roam order has an unsupported Checkout Session status' };
  }
  // Every QY Roam Checkout Session has a positive payable amount. Stripe's
  // `no_payment_required` state (and any future/unknown SDK value) therefore
  // cannot represent one of our orders. Keep this explicit at the shared
  // webhook/admin validation boundary: otherwise an unexpected state could be
  // persisted as an apparently legitimate awaiting-payment order and consume
  // Pocket WiFi capacity indefinitely without a matching success/failure
  // transition that our lifecycle understands.
  if (session.payment_status !== 'paid' && session.payment_status !== 'unpaid') {
    return { valid: false, reason: 'QY Roam order has an unsupported payment status' };
  }
  // The individual values above are not sufficient: Stripe's lifecycle also
  // constrains which combinations can describe a real positive-value Checkout
  // Session. A paid Session is complete; an open or expired Session is still
  // unpaid. Keep that invariant in this shared authority so confirmation,
  // booking status, admin recovery, and any future caller cannot authenticate
  // an impossible provider response merely because each field is recognised.
  // Completed + unpaid remains valid for asynchronous payment methods while
  // Stripe is waiting for their later succeeded/failed event.
  if (session.payment_status === 'paid' && session.status !== 'complete') {
    return { valid: false, reason: 'QY Roam paid order is not a complete Checkout Session' };
  }
  if (!validCheckoutRequestId(session.metadata?.checkout_request_id)) {
    return { valid: false, reason: 'missing or invalid checkout request id' };
  }
  if (!validQyRoamProvenance(session.id, session.metadata)) {
    return { valid: false, reason: 'missing or invalid QY Roam checkout provenance' };
  }
  if (!checkoutAmountSnapshotIsConsistent(session)) {
    return { valid: false, reason: 'checkout amount snapshot does not match the Stripe payment amount' };
  }

  if (productType === 'pocket_wifi') {
    const config = operationalConfig();
    const plan = getWifiPlan(session.metadata?.country);
    const start = parseExactIsoDate(session.metadata?.start);
    const end = parseExactIsoDate(session.metadata?.end);
    if (!start || !end || end < start) return { valid: false, reason: 'invalid Pocket WiFi travel dates' };
    const days = pocketWifiRentalDays(start, end);
    if (days < 1 || days > MAX_POCKET_WIFI_RENTAL_DAYS || session.metadata?.days !== String(days)) {
      return { valid: false, reason: 'Pocket WiFi rental duration does not match its dates' };
    }

    // The webhook can run after a catalogue rate or destination changes. The
    // v2 provenance binds every pricing field and the Checkout Session id, so
    // a valid historical snapshot remains safer than rejecting a real payment
    // solely because today's catalogue differs from the one the buyer saw.
    if (!plan) {
      return historicalPocketWifiSnapshotIsConsistent(session, days)
        ? { valid: true, productType }
        : { valid: false, reason: 'unknown Pocket WiFi destination or invalid historical snapshot' };
    }

    const rentalBeforePromo = pocketWifiRentalCents(plan.daily, days);
    const promoCode = session.metadata?.promo_code || '';
    if (promoCode !== '' && promoCode !== LAUNCH_PROMO.code) {
      return { valid: false, reason: 'unknown Pocket WiFi promo code' };
    }
    const discount = promoCode === LAUNCH_PROMO.code
      ? Math.floor((rentalBeforePromo * LAUNCH_PROMO.percent) / 100)
      : 0;
    const courierFeeMetadata = session.metadata?.courier_fee_sgd;
    // Sessions opened immediately before this field was deployed remain valid
    // against the server's configured fee during a rolling release.
    const configuredCourierFee = config?.courierFeeCents;
    const courierFee = courierFeeMetadata === undefined
      ? configuredCourierFee
      : moneyMetadataCents(courierFeeMetadata);
    if (typeof courierFee !== 'number' || !Number.isSafeInteger(courierFee) || (courierFeeMetadata === undefined && !Number.isSafeInteger(configuredCourierFee))) {
      return { valid: false, reason: 'missing or invalid Pocket WiFi courier fee' };
    }
    const expectedAmount = rentalBeforePromo - discount + courierFee;
    if (session.currency?.toLowerCase() !== 'sgd' || session.amount_total !== expectedAmount) {
      return historicalPocketWifiSnapshotIsConsistent(session, days)
        ? { valid: true, productType }
        : { valid: false, reason: 'Pocket WiFi currency or amount does not match the catalogue' };
    }
    if (
      session.metadata?.plan_name !== `${plan.country} Pocket WiFi` ||
      session.metadata?.daily_rate_sgd !== plan.daily.toFixed(2) ||
      session.metadata?.benchmark_provider !== WIFI_BENCHMARK.provider ||
      session.metadata?.benchmark_rate_sgd !== plan.benchmarkRateSgd.toFixed(2) ||
      session.metadata?.benchmark_verified_on !== WIFI_BENCHMARK.verifiedOn ||
      session.metadata?.rental_before_promo_sgd !== (rentalBeforePromo / 100).toFixed(2) ||
      session.metadata?.promo_discount_sgd !== (discount / 100).toFixed(2)
    ) {
      return historicalPocketWifiSnapshotIsConsistent(session, days)
        ? { valid: true, productType }
        : { valid: false, reason: 'Pocket WiFi catalogue metadata does not match the selected plan' };
    }
  }

  if (productType === 'esim') {
    const plan = getEsimPlan(session.metadata?.plan_id);
    if (!plan) {
      return historicalEsimSnapshotIsConsistent(session)
        ? { valid: true, productType }
        : { valid: false, reason: 'unknown eSIM plan id or invalid historical snapshot' };
    }
    const expectedAmount = Math.max(50, Math.round(plan.qyPriceSgd * 100));
    if (session.currency?.toLowerCase() !== 'sgd' || session.amount_total !== expectedAmount) {
      return historicalEsimSnapshotIsConsistent(session)
        ? { valid: true, productType }
        : { valid: false, reason: 'eSIM currency or amount does not match the catalogue' };
    }
    if (
      session.metadata?.country !== plan.destination ||
      session.metadata?.plan_name !== `${plan.destination} · ${plan.days} days` ||
      // The data package is the digital entitlement, not presentation-only
      // catalogue text. Never reconstruct a missing signed snapshot from the
      // current plan: the catalogue can change after Checkout while a paid
      // webhook is retrying, which would otherwise fulfil a different package
      // from the one recorded when the customer paid.
      session.metadata?.data_allowance !== plan.data ||
      session.metadata?.promo_code !== ESIM_PROMO.code ||
      session.metadata?.benchmark_price_sgd !== plan.benchmarkPriceSgd.toFixed(2) ||
      session.metadata?.promo_discount_percent !== String(ESIM_PROMO.percent)
    ) {
      return historicalEsimSnapshotIsConsistent(session)
        ? { valid: true, productType }
        : { valid: false, reason: 'eSIM catalogue metadata does not match the selected plan' };
    }
  }

  return { valid: true, productType };
}

/**
 * Validate a terminal unpaid Session before recording its failure/expiry.
 * A shopper can abandon Checkout before reaching Stripe's terms checkbox, so
 * an authentic expired Session is not expected to carry accepted consent.
 * The commercial identity, amount, product, and provenance remain mandatory;
 * callers must independently prove the terminal unpaid Stripe event state.
 */
export function validateQyRoamTerminalUnpaidSession(session: Stripe.Checkout.Session): QyRoamSessionValidation {
  // Keep the exceptional no-consent path self-contained. The webhook also
  // validates the signed event and refreshed Session state before calling
  // this helper, but a validator explicitly intended for terminal cleanup
  // must not report a paid, open, or merely completed Session as safe if a
  // future caller omits that separate routing check. Expiry is the only
  // terminal state where QY Roam may legitimately lack terms acceptance.
  if (session.status !== 'expired' || session.payment_status !== 'unpaid') {
    return { valid: false, reason: 'QY Roam terminal unpaid cleanup requires an expired unpaid Checkout Session' };
  }
  return validateQyRoamSessionSnapshot(session);
}

export function validateQyRoamSession(session: Stripe.Checkout.Session): QyRoamSessionValidation {
  // Every order or entitlement boundary requires the published terms. Keep
  // this stricter public validator as the default for paid/unpaid completion,
  // customer confirmation, and admin recovery. Only authenticated terminal
  // unpaid cleanup uses the explicitly named validator above.
  if (session.consent?.terms_of_service !== 'accepted') {
    return { valid: false, reason: 'QY Roam order is missing terms acceptance' };
  }
  return validateQyRoamSessionSnapshot(session);
}
