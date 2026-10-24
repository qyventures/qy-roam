'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { applyPromoCents, LAUNCH_PROMO, promoIsActive, validLaunchPromo } from '../lib/promotions';
import { WIFI_PLANS } from '../lib/wifiPlans';
import { pocketWifiRentalCents, sgdFromCents } from '../lib/pocketWifiPricing';
import { metaAttribution, metaMeasurementAllowed, trackMeta } from '../lib/metaClient';
import { operationalIsoDateAfter } from '../lib/operationalDate';
import { checkoutAttempt, clearCheckoutAttempt, type CheckoutAttempt } from '../lib/checkoutAttempt';
import { fetchCustomerJson } from '../lib/clientRequest';
import { fetchCustomerCheckout } from '../lib/customerCheckout';
import { esimOfferIsSaleable } from '../lib/esimPlans';
import { parsePocketWifiAvailability, parsePocketWifiBookingTerms, type PocketWifiAvailability } from '../lib/pocketWifiAvailability';
import { pocketWifiCheckoutFingerprint } from '../lib/checkoutFingerprint';
import { MAX_POCKET_WIFI_RENTAL_DAYS, pocketWifiRentalDays } from '../lib/pocketWifiRentalPeriod';

const plans = WIFI_PLANS;

const DEFAULT_DELIVERY_LEAD_DAYS = 2;
const POCKET_WIFI_CHECKOUT_DRAFT_KEY = 'qyroam:pocket-wifi-checkout-draft:v1';
const MAX_CHECKOUT_DRAFT_BYTES = 1_024;
type Availability = PocketWifiAvailability & {
  checkedCountry?: string;
  checkedStart?: string;
  checkedEnd?: string;
};

type PocketWifiCheckoutDraft = {
  country: string;
  start: string;
  end: string;
  promoCode: string;
};

function exactIsoDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function restoredPocketWifiDraft(value: string | null, earliestStart: string): PocketWifiCheckoutDraft | null {
  if (!value || value.length > MAX_CHECKOUT_DRAFT_BYTES) return null;
  try {
    const draft: unknown = JSON.parse(value);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
    const input = draft as Record<string, unknown>;
    if (typeof input.country !== 'string' || !plans.some(plan => plan.country === input.country) ||
      !exactIsoDate(input.start) || !exactIsoDate(input.end) ||
      (input.start as string) < earliestStart || (input.end as string) < (input.start as string) ||
      typeof input.promoCode !== 'string' || input.promoCode.length > 32) return null;
    return {
      country: input.country,
      start: input.start as string,
      end: input.end as string,
      promoCode: input.promoCode,
    };
  } catch {
    return null;
  }
}

function daysBetween(start: string, end: string) {
  if (!start || !end) return 1;
  // Rental dates are destination-independent calendar dates, not instants in
  // the shopper's local timezone. Parse them at UTC midnight and use the same
  // inclusive-day authority as availability, checkout, webhook validation,
  // and manual orders. Local-midnight arithmetic can cross a timezone offset
  // transition and render a total that the server correctly refuses.
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end}T00:00:00Z`);
  return Math.max(1, pocketWifiRentalDays(a, b));
}

export default function Home() {
  const launchPromoActive = promoIsActive();
  // The eSIM catalogue is deliberately paused when its approved offer
  // expires. Keep the primary sales choice on that same boundary so the
  // homepage never promises an immediately purchasable digital product while
  // the checkout correctly rejects it.
  const esimOfferActive = esimOfferIsSaleable();
  // Keep the picker aligned with the server's Singapore delivery calendar.
  const [deliveryLeadDays, setDeliveryLeadDays] = useState(DEFAULT_DELIVERY_LEAD_DAYS);
  const [courierFeeSgd, setCourierFeeSgd] = useState(0);
  // Zero is a valid configured courier fee, so track authority separately.
  // Until a complete booking-terms snapshot arrives, the rental subtotal is
  // safe to show but a "due today" total would silently assume free delivery.
  const [bookingTermsLoaded, setBookingTermsLoaded] = useState(false);
  const earliestStart = operationalIsoDateAfter(deliveryLeadDays);
  const [country, setCountry] = useState('Japan');
  const [start, setStart] = useState(earliestStart);
  const [end, setEnd] = useState(earliestStart);
  // Do not prefill or advertise a promotion after its approved campaign
  // boundary. The server remains authoritative, but the storefront must not
  // invite shoppers to submit a code that checkout will correctly reject.
  const [promoCode, setPromoCode] = useState<string>(launchPromoActive ? LAUNCH_PROMO.code : '');
  const [searched, setSearched] = useState(false);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [checkoutCancelled, setCheckoutCancelled] = useState(false);
  const activeCheckoutAttempt = useRef<CheckoutAttempt | null>(null);
  const checkoutInFlight = useRef(false);
  const checkoutAbortController = useRef<AbortController | null>(null);
  const bookingTermsAbortController = useRef<AbortController | null>(null);
  const availabilityAbortController = useRef<AbortController | null>(null);
  const availabilityRequest = useRef(0);
  const selectedBooking = useRef({ country, start, end });
  selectedBooking.current = { country, start, end };
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('checkout') !== 'cancelled') return;
    setCheckoutCancelled(true);
    // Stripe's cancellation URL deliberately contains no commercial fields.
    // Restore only the bounded same-tab draft written immediately before the
    // shopper opened Checkout; never let query parameters author a quote.
    let saved: string | null = null;
    try {
      saved = window.sessionStorage.getItem(POCKET_WIFI_CHECKOUT_DRAFT_KEY);
      window.sessionStorage.removeItem(POCKET_WIFI_CHECKOUT_DRAFT_KEY);
    } catch {}
    const draft = restoredPocketWifiDraft(saved, operationalIsoDateAfter(DEFAULT_DELIVERY_LEAD_DAYS));
    if (draft) {
      setCountry(draft.country);
      setStart(draft.start);
      setEnd(draft.end);
      if (launchPromoActive && validLaunchPromo(draft.promoCode)) setPromoCode(draft.promoCode);
    }
    // Consume the marker so refresh/back navigation does not repeatedly
    // restore an old draft. The in-memory notice remains visible this visit.
    url.searchParams.delete('checkout');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [launchPromoActive]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    bookingTermsAbortController.current = controller;
    void fetchCustomerJson('/api/booking-terms', { cache: 'no-store', signal: controller.signal }).then(({ response, value }) => {
      if (!active || !response.ok || !value || typeof value !== 'object' || Array.isArray(value)) return;
      // Treat the initial public terms as one coherent price/date snapshot.
      // Applying only one valid field from a malformed or partially deployed
      // response could still show a payable total that disagrees with the
      // checkout authority until the first availability lookup.
      const terms = parsePocketWifiBookingTerms(value);
      if (!terms) return;

      const authoritativeLeadDays = terms.minDeliveryLeadDays;
      const previousDefault = operationalIsoDateAfter(DEFAULT_DELIVERY_LEAD_DAYS);
      const nextEarliest = operationalIsoDateAfter(authoritativeLeadDays);
      setDeliveryLeadDays(authoritativeLeadDays);
      setCourierFeeSgd(terms.courierFeeSgd);
      setBookingTermsLoaded(true);
      // Move only untouched defaults. Never overwrite dates the traveller has
      // already selected while this small terms request was in flight.
      setStart(current => current === previousDefault ? nextEarliest : current);
      setEnd(current => current === previousDefault ? nextEarliest : current);
    }).catch(() => undefined).finally(() => {
      if (bookingTermsAbortController.current === controller) bookingTermsAbortController.current = null;
    });
    return () => {
      active = false;
      controller.abort();
      if (bookingTermsAbortController.current === controller) bookingTermsAbortController.current = null;
    };
  }, []);
  useEffect(() => () => {
    // Checkout may be reconciling a paid Session through several bounded
    // polls. Leaving the storefront owns cancellation of that complete cycle.
    checkoutAbortController.current?.abort();
    checkoutAbortController.current = null;
    // The initial booking-terms request is only a fast first-render hint.
    // Never retain it after the storefront has gone away.
    bookingTermsAbortController.current?.abort();
    bookingTermsAbortController.current = null;
    // Availability can be waiting on a paginated Stripe hold scan and an
    // inventory snapshot. A detached storefront has no use for that promise,
    // so release the browser connection instead of retaining it until the
    // general customer-request deadline.
    availabilityAbortController.current?.abort();
    availabilityAbortController.current = null;
  }, []);
  useEffect(() => {
    // An availability result belongs to one exact commercial selection. The
    // response guard below prevents stale data from enabling checkout, while
    // aborting here also stops an obsolete browser request as soon as the
    // traveller changes destination or dates. Incrementing the generation
    // means even a fetch implementation that settles during abort cannot own
    // the shared loading state.
    availabilityRequest.current += 1;
    availabilityAbortController.current?.abort();
    availabilityAbortController.current = null;
    setChecking(false);
  }, [country, start, end]);
  const plan = useMemo(() => plans.find(p => p.country === country) || plans[0], [country]);
  const datesValid = Boolean(start && end && start >= earliestStart && end >= start);
  const days = daysBetween(start, end);
  // Mirror the server's integer-cent calculation. This displayed amount is a
  // customer promise, so it must not be a floating-point approximation of
  // the Stripe amount calculated in /api/checkout.
  const rentalCents = pocketWifiRentalCents(plan.daily, days);
  const baseSubtotal = sgdFromCents(rentalCents);
  const promoActive = validLaunchPromo(promoCode);
  const promo = applyPromoCents(rentalCents, promoCode);
  const promoDiscount = sgdFromCents(promo.discountCents);
  const subtotal = sgdFromCents(promo.amountCents);
  const courierFeeCents = Math.round(courierFeeSgd * 100);
  const payableTotalCents = promo.amountCents + courierFeeCents;
  const payableTotal = sgdFromCents(payableTotalCents);
  const minimumApplied = rentalCents === 1_000 && plan.daily * days * 100 < 1_000;
  // An availability response is a promise for one exact travel window. A
  // shopper can edit either date while the provider-backed request is still
  // in flight, so never let that stale response enable checkout or describe
  // the newly selected dates as available.
  const availabilityMatchesSelection = availability?.checkedCountry === country && availability?.checkedStart === start && availability?.checkedEnd === end;

  function validateDates() {
    if (!start || !end) return 'Choose both travel dates.';
    if (start < earliestStart) return `Please book at least ${deliveryLeadDays} day${deliveryLeadDays === 1 ? '' : 's'} before departure.`;
    if (end < start) return 'End date must be on or after the start date.';
    if (days > MAX_POCKET_WIFI_RENTAL_DAYS) return `Bookings must be between 1 and ${MAX_POCKET_WIFI_RENTAL_DAYS} days.`;
    return '';
  }

  async function checkAvailability(): Promise<Availability> {
    const validationError = validateDates();
    if (validationError) {
      const result = { available: false, error: validationError };
      setAvailability(result); setCheckoutError(validationError); return result;
    }
    const requestNumber = ++availabilityRequest.current;
    const checkedCountry = country;
    const checkedStart = start;
    const checkedEnd = end;
    // Availability returns the current booking terms together with the stock
    // snapshot. Once this more authoritative request starts, an older initial
    // `/api/booking-terms` response must not arrive later and overwrite its
    // lead time or courier fee, making the displayed total stale immediately
    // before checkout.
    bookingTermsAbortController.current?.abort();
    bookingTermsAbortController.current = null;
    availabilityAbortController.current?.abort();
    const controller = new AbortController();
    availabilityAbortController.current = controller;
    setChecking(true); setAvailability(null); setCheckoutError('');
    try {
      const { response: res, value: payload } = await fetchCustomerJson(`/api/availability?start=${encodeURIComponent(checkedStart)}&end=${encodeURIComponent(checkedEnd)}`, { cache: 'no-store', signal: controller.signal });
      // Availability is also the public source of operational booking terms.
      // Require a complete live response before enabling payment; Checkout
      // still recalculates every amount and date rule independently.
      const data = parsePocketWifiAvailability(payload, res.ok);
      const result: Availability = data
        ? { ...data, checkedCountry, checkedStart, checkedEnd }
        : { available: false, error: 'Unable to check availability.', checkedCountry, checkedStart, checkedEnd };
      if (requestNumber === availabilityRequest.current && selectedBooking.current.country === checkedCountry && selectedBooking.current.start === checkedStart && selectedBooking.current.end === checkedEnd) {
        if (data?.minDeliveryLeadDays !== undefined && data.courierFeeSgd !== undefined) {
          setDeliveryLeadDays(data.minDeliveryLeadDays);
          setCourierFeeSgd(data.courierFeeSgd);
          setBookingTermsLoaded(true);
        }
        setAvailability(result);
      }
      return result;
    } catch {
      const result = { available: false, error: 'Unable to check availability. Please try again.', checkedCountry, checkedStart, checkedEnd };
      if (!controller.signal.aborted && requestNumber === availabilityRequest.current && selectedBooking.current.country === checkedCountry && selectedBooking.current.start === checkedStart && selectedBooking.current.end === checkedEnd) setAvailability(result);
      return result;
    } finally {
      // An older request can finish after a newer one starts. It does not own
      // the shared loading state or payment-facing booking terms.
      if (availabilityAbortController.current === controller) availabilityAbortController.current = null;
      if (requestNumber === availabilityRequest.current) setChecking(false);
    }
  }

  async function search(e: FormEvent) { e.preventDefault(); setSearched(true); await checkAvailability(); document.getElementById('plans')?.scrollIntoView({ behavior: 'smooth' }); }

  async function checkout() {
    if (checkoutInFlight.current) return;
    checkoutInFlight.current = true;
    setCheckoutError('');
    const validationError = validateDates();
    if (validationError) { setCheckoutError(validationError); checkoutInFlight.current = false; return; }
    let currentAvailability = availability;
    if (!currentAvailability?.available || currentAvailability.checkedCountry !== country || currentAvailability.checkedStart !== start || currentAvailability.checkedEnd !== end) {
      currentAvailability = await checkAvailability();
      // Availability also returns the live courier fee and delivery lead time.
      // Do not send a shopper directly to Stripe on the same click that first
      // learns those terms: React has not rendered the revised total yet, so
      // that flow could make a newly configured courier charge a surprise.
      // The next explicit action uses this checked availability snapshot;
      // Checkout still recalculates and validates the amount on the server.
      if (currentAvailability.available && selectedBooking.current.country === currentAvailability.checkedCountry && selectedBooking.current.start === currentAvailability.checkedStart && selectedBooking.current.end === currentAvailability.checkedEnd) {
        setCheckoutError('Availability confirmed. Please review the updated total, then select Reserve.');
      }
      checkoutInFlight.current = false;
      return;
    }
    const measurementConsent = metaMeasurementAllowed();
    const fingerprint = pocketWifiCheckoutFingerprint(country, start, end, promoCode);
    activeCheckoutAttempt.current = checkoutAttempt('pocket_wifi', fingerprint, activeCheckoutAttempt.current);
    // Stripe returns cancellations to a deliberately generic URL. Preserve
    // this non-sensitive commercial selection in same-tab storage so a
    // traveller can review and retry without rebuilding the booking. The
    // server still recalculates dates, stock, promotion and amount on retry.
    try {
      window.sessionStorage.setItem(POCKET_WIFI_CHECKOUT_DRAFT_KEY, JSON.stringify({ country, start, end, promoCode }));
    } catch {}
    // A transient browser/network failure can retry this exact Stripe
    // idempotency key. Give Pixel the same stable attempt identity so it does
    // not turn one customer's recovery attempt into multiple checkout starts.
    // A deliberately changed booking gets a new request id and remains a new
    // funnel event.
    if (measurementConsent) trackMeta('InitiateCheckout', {
      content_name: `${country} Pocket WiFi`,
      content_category: 'Pocket WiFi',
      // Keep the catalogue identity and value identical to the browser/CAPI
      // Purchase contract. Meta otherwise sees checkout and purchase as two
      // unrelated products, and a configured courier fee understates the
      // value entering the funnel compared with the Stripe amount paid.
      content_ids: [`pocket_wifi:${country}`],
      content_type: 'product',
      value: Number(payableTotal.toFixed(2)),
      currency: 'SGD',
      num_items: 1
    }, { eventID: `checkout_${activeCheckoutAttempt.current.requestId}` });
    setCheckingOut(true);
    const controller = new AbortController();
    checkoutAbortController.current = controller;
    try {
      const data = await fetchCustomerCheckout('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ country, start, end, promoCode, expectedTotalCents: payableTotalCents, measurementConsent, attribution: measurementConsent ? metaAttribution() : undefined, checkoutRequestId: activeCheckoutAttempt.current.requestId, checkoutAttemptCreatedAt: activeCheckoutAttempt.current.createdAt }), signal: controller.signal });
      if (data.checkoutUrl) window.location.href = data.checkoutUrl;
      else if (data.completedSessionId) window.location.href = `/success?session_id=${encodeURIComponent(data.completedSessionId)}`;
      else {
        // Operations can change courier pricing while a tab is open. The
        // server refuses to create a differently priced Stripe Session; make
        // the next click obtain a fresh live quote and show its total before
        // the customer can try payment again.
        if (data.priceChanged || data.bookingWindowChanged || data.pricingExpired) setAvailability(null);
        // Keep the idempotency key after ordinary failures: the server may have
        // created a session before a network response was lost. Rotate it only
        // after the server has confirmed that the prior session expired or
        // belongs to different server-priced booking details, or its signed
        // webhook has durably recorded a terminal payment failure.
        if (data.checkoutExpired || data.checkoutRequestConflict || data.paymentFailed) {
          activeCheckoutAttempt.current = null;
          clearCheckoutAttempt('pocket_wifi');
        }
        setCheckoutError(data.error || 'Checkout is temporarily unavailable. Please contact +65 8032 7183.');
      }
    } catch {
      if (!controller.signal.aborted) setCheckoutError('Checkout is temporarily unavailable. Please contact +65 8032 7183.');
    }
    finally {
      // The unmount cleanup clears this ref before aborting, preventing a
      // detached request from writing state after its storefront disappears.
      if (checkoutAbortController.current === controller) {
        checkoutAbortController.current = null;
        checkoutInFlight.current = false;
        setCheckingOut(false);
      }
    }
  }

  return <main>
    {checkoutCancelled && <div className="wrap" role="status"><p className="muted">Secure checkout was closed before this page received payment confirmation. Your trip details have been restored where possible. Review the total before trying again; if you completed payment, do not pay again—use your confirmation link or contact +65 8032 7183.</p></div>}
    {launchPromoActive && <section className="promo-banner"><div className="wrap promo-inner"><div><span className="promo-kicker">{LAUNCH_PROMO.label}</span><strong>{LAUNCH_PROMO.headline}</strong><span>Use code <b>{LAUNCH_PROMO.code}</b> · valid through 30 Sep 2026</span></div><a href="#plans" className="promo-cta">Book now</a></div></section>}
    <section className="hero"><div className="wrap hero-grid"><div><span className="eyebrow">Travel connectivity for every trip</span><h1>Stay connected overseas without the roaming bill.</h1><p className="lead">{esimOfferActive ? 'Choose a travel eSIM for your phone or Pocket WiFi to share across multiple devices.' : 'Book Pocket WiFi to share across multiple devices. Online eSIM ordering is temporarily paused while availability and pricing are reviewed.'}</p><div className="product-switch"><a className="product-choice" href="/esim"><span className="pill">Travel eSIM</span><strong>{esimOfferActive ? 'Digital travel option' : 'Online ordering paused'}</strong><small>{esimOfferActive ? 'No collection or return. Pick a plan and receive fulfilment after payment.' : 'View plan information or contact our Singapore support team for current availability.'}</small><b>{esimOfferActive ? 'View eSIM plans →' : 'View current status →'}</b></a><a className="product-choice featured-choice" href="#plans"><span className="pill">Pocket WiFi</span><strong>Share across devices</strong><small>Delivered before departure and returned after your trip.</small><b>Check Pocket WiFi →</b></a></div><div className="trust-row"><span>eSIM & Pocket WiFi</span><span>Singapore-based support</span><span>Secure online checkout</span></div></div><form className="search-card" onSubmit={search}><h2>Pocket WiFi availability</h2><label>Destination<select value={country} onChange={e => { setCountry(e.target.value); setAvailability(null); setCheckoutError(''); }}>{plans.map(p => <option key={p.code}>{p.country}</option>)}</select></label><div className="date-grid"><label>Start date<input type="date" min={earliestStart} value={start} onChange={e => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value); setAvailability(null); setCheckoutError(''); }} /></label><label>End date<input type="date" min={start || earliestStart} value={end} onChange={e => { setEnd(e.target.value); setAvailability(null); setCheckoutError(''); }} /></label></div>{launchPromoActive && <label>Promo code<input value={promoCode} onChange={e => setPromoCode(e.target.value.toUpperCase())} placeholder="Enter promo code" /></label>}{promoActive && <div className="promo-applied">✓ {LAUNCH_PROMO.code} applied — {LAUNCH_PROMO.percent}% off rental</div>}<button type="submit" className="primary" disabled={checking || !datesValid}>{checking ? 'Checking availability…' : 'Check price & availability'}</button><small>Book at least {deliveryLeadDays} day{deliveryLeadDays === 1 ? '' : 's'} before departure. SGD pricing · S$10 minimum booking{launchPromoActive ? ' before promotion' : ''}.</small></form></div></section>
    <section className="wrap section" id="plans"><div className="section-head"><div><span className="eyebrow">Simple daily pricing</span><h2>{searched ? `${country} Pocket WiFi` : 'Popular destinations'}</h2></div><p>Clear daily rates with the rental total calculated from your selected travel dates.</p></div><div className="plan-card featured"><div><span className="pill">Pocket WiFi</span><h3>{country}</h3><p>{plan.data} · {plan.note}</p><p className="muted">Rental: {days} day{days !== 1 ? 's' : ''} × S${plan.daily.toFixed(2)}{minimumApplied ? ' · S$10 minimum booking applies' : ''}</p>{promoActive && <p className="promo-line">Launch promo: {LAUNCH_PROMO.percent}% off with {LAUNCH_PROMO.code}</p>}{searched && availabilityMatchesSelection && availability?.available && <p className="muted">✓ Available for your dates{typeof availability.remaining === 'number' ? ` · ${availability.remaining} unit${availability.remaining === 1 ? '' : 's'} remaining` : ''}</p>}{searched && availabilityMatchesSelection && availability && !availability.available && <p className="muted">{availability.error || 'Sold out for these dates. Choose different dates or contact +65 8032 7183.'}</p>}{checkoutError && <p className="muted">{checkoutError}</p>}</div><div className="price"><span>S$</span>{plan.daily.toFixed(2)}<small>/day</small>{promoActive && <><p className="old-total">Before promo: S${baseSubtotal.toFixed(2)}</p><p className="discount-total">Save S${promoDiscount.toFixed(2)}</p></>}<p>Rental total: S${subtotal.toFixed(2)}</p>{bookingTermsLoaded ? <>{courierFeeSgd > 0 && <p>Courier fee: S${courierFeeSgd.toFixed(2)}</p>}<p><strong>Total due today: S${payableTotal.toFixed(2)}</strong></p></> : <p className="muted">Checking live delivery fee and total…</p>}<button className="primary" onClick={checkout} disabled={checking || checkingOut || !datesValid}>{checking ? 'Checking…' : checkingOut ? 'Opening secure checkout…' : availabilityMatchesSelection && availability?.available && bookingTermsLoaded ? `Reserve for S$${payableTotal.toFixed(2)}` : 'Check availability'}</button><small>Live booking terms are checked before payment.</small></div></div></section>
    <section className="soft"><div className="wrap section"><div className="section-head"><div><span className="eyebrow">Why travellers choose QY Roam</span><h2>Easy to book. Easy to use. Easy to return.</h2></div><p>Clear pricing, simple booking, Singapore-based support and straightforward fulfilment from checkout through return.</p></div><div className="steps"><article><h3>Easy booking</h3><p>Choose your destination and dates, check live availability, and reserve online.</p></article><article><h3>Share across devices</h3><p>Connect phones, tablets and laptops to one Pocket WiFi during your trip.</p></article><article><h3>Local support</h3><p>Singapore-based support at +65 8032 7183 before, during and after your rental.</p></article><article><h3>No surprise rental pricing</h3><p>See your rental total{launchPromoActive ? ' and promotion' : ''} before payment. Courier charges are disclosed at checkout.</p></article></div></div></section>
    {launchPromoActive && <section className="wrap section promo-section"><div className="promo-panel"><div><span className="eyebrow">Latest promotion</span><h2>Launch Special: save 10%</h2><p>Use <strong>QY10</strong> on any eligible Pocket WiFi rental through 30 September 2026. The discount applies to the rental component; courier charges, if any, are excluded.</p></div><a className="primary promo-panel-button" href="#plans">Claim 10% off</a></div></section>}
    <section className="soft" id="how"><div className="wrap section"><span className="eyebrow">Door-to-door convenience</span><h2>Four simple steps</h2><div className="steps"><article><b>1</b><h3>Book online</h3><p>Choose destination and dates, then pay securely by card or PayNow where available.</p></article><article><b>2</b><h3>Receive before departure</h3><p>We courier the Pocket WiFi to your Singapore delivery address.</p></article><article><b>3</b><h3>Travel connected</h3><p>Switch it on and connect your phones, tablets or laptops.</p></article><article><b>4</b><h3>Return after your trip</h3><p>Pack the complete kit and follow the supplied courier return instructions.</p></article></div></div></section>
    <section className="wrap section"><div className="section-head"><div><span className="eyebrow">Book with confidence</span><h2>Built for straightforward travel connectivity</h2></div></div><div className="steps"><article><h3>Upfront pricing</h3><p>See your rental total before checkout. Any applicable courier charge is disclosed before payment.</p></article><article><h3>Local help</h3><p>Need help before or during your rental? Contact our Singapore support team at +65 8032 7183.</p></article><article><h3>Track your booking</h3><p>After payment, use your secure booking-status page to follow fulfilment and delivery tracking.</p></article><article><h3>Clear return process</h3><p>Return the complete kit within five calendar days after your rental ends and retain courier evidence until receipt is confirmed.</p></article></div></section>
    <section className="wrap section cta"><h2>Questions before booking?</h2><p>WhatsApp or call our Singapore customer support team.</p><a className="secondary" href="https://wa.me/6580327183">WhatsApp +65 8032 7183</a></section>
  </main>;
}
