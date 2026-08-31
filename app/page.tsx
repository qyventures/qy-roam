'use client';

import { FormEvent, useMemo, useRef, useState } from 'react';
import { LAUNCH_PROMO, validLaunchPromo } from '../lib/promotions';
import { WIFI_PLANS } from '../lib/wifiPlans';
import { trackMeta } from '../lib/metaClient';

const plans = WIFI_PLANS;

const DELIVERY_LEAD_DAYS = 2;
type Availability = { available: boolean; remaining?: number; error?: string };

function isoDateWithOffset(days: number) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string) {
  if (!start || !end) return 1;
  const a = new Date(start + 'T00:00:00');
  const b = new Date(end + 'T00:00:00');
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);
}

export default function Home() {
  const earliestStart = isoDateWithOffset(DELIVERY_LEAD_DAYS);
  const [country, setCountry] = useState('Japan');
  const [start, setStart] = useState(earliestStart);
  const [end, setEnd] = useState(earliestStart);
  const [promoCode, setPromoCode] = useState<string>(LAUNCH_PROMO.code);
  const [searched, setSearched] = useState(false);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const checkoutAttempt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const checkoutInFlight = useRef(false);
  const plan = useMemo(() => plans.find(p => p.country === country) || plans[0], [country]);
  const datesValid = Boolean(start && end && start >= earliestStart && end >= start);
  const days = daysBetween(start, end);
  const rental = plan.daily * days;
  const baseSubtotal = Math.max(10, rental);
  const promoActive = validLaunchPromo(promoCode);
  const promoDiscount = promoActive ? Math.floor(baseSubtotal * LAUNCH_PROMO.percent * 100) / 10000 : 0;
  const subtotal = Math.max(0, baseSubtotal - promoDiscount);
  const minimumApplied = rental < 10;

  function validateDates() {
    if (!start || !end) return 'Choose both travel dates.';
    if (start < earliestStart) return `Please book at least ${DELIVERY_LEAD_DAYS} days before departure.`;
    if (end < start) return 'End date must be on or after the start date.';
    return '';
  }

  async function checkAvailability(): Promise<Availability> {
    const validationError = validateDates();
    if (validationError) {
      const result = { available: false, error: validationError };
      setAvailability(result); setCheckoutError(validationError); return result;
    }
    setChecking(true); setAvailability(null); setCheckoutError('');
    try {
      const res = await fetch(`/api/availability?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { cache: 'no-store' });
      const data = (await res.json()) as Availability;
      const result = res.ok ? data : { available: false, error: data.error || 'Unable to check availability.' };
      setAvailability(result); return result;
    } catch {
      const result = { available: false, error: 'Unable to check availability. Please try again.' };
      setAvailability(result); return result;
    } finally { setChecking(false); }
  }

  async function search(e: FormEvent) { e.preventDefault(); setSearched(true); await checkAvailability(); document.getElementById('plans')?.scrollIntoView({ behavior: 'smooth' }); }

  async function checkout() {
    if (checkoutInFlight.current) return;
    checkoutInFlight.current = true;
    setCheckoutError('');
    const validationError = validateDates();
    if (validationError) { setCheckoutError(validationError); checkoutInFlight.current = false; return; }
    let currentAvailability = availability;
    if (!currentAvailability?.available) { currentAvailability = await checkAvailability(); if (!currentAvailability.available) { checkoutInFlight.current = false; return; } }
    const measurementConsent = localStorage.getItem('qyroam_consent') === 'accepted';
    if (measurementConsent) trackMeta('InitiateCheckout', {
      content_name: `${country} Pocket WiFi`,
      content_category: 'Pocket WiFi',
      content_ids: [plan.code],
      content_type: 'product',
      value: Number(subtotal.toFixed(2)),
      currency: 'SGD',
      num_items: 1
    });
    const fingerprint = JSON.stringify({ country, start, end, promoCode, measurementConsent });
    if (checkoutAttempt.current?.fingerprint !== fingerprint) {
      checkoutAttempt.current = { fingerprint, requestId: crypto.randomUUID() };
    }
    setCheckingOut(true);
    try {
      const res = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ country, start, end, promoCode, measurementConsent, checkoutRequestId: checkoutAttempt.current.requestId }) });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else setCheckoutError(data.error || 'Checkout is temporarily unavailable. Please contact +65 8032 7183.');
    } catch { setCheckoutError('Checkout is temporarily unavailable. Please contact +65 8032 7183.'); }
    finally { checkoutInFlight.current = false; setCheckingOut(false); }
  }

  return <main>
    <section className="promo-banner"><div className="wrap promo-inner"><div><span className="promo-kicker">{LAUNCH_PROMO.label}</span><strong>{LAUNCH_PROMO.headline}</strong><span>Use code <b>{LAUNCH_PROMO.code}</b> · valid through 30 Sep 2026</span></div><a href="#plans" className="promo-cta">Book now</a></div></section>
    <section className="hero"><div className="wrap hero-grid"><div><span className="eyebrow">Travel connectivity for every trip</span><h1>Stay connected overseas without the roaming bill.</h1><p className="lead">Choose an instant travel eSIM for your phone or Pocket WiFi to share across multiple devices.</p><div className="product-switch"><a className="product-choice" href="/esim"><span className="pill">Travel eSIM</span><strong>Instant digital option</strong><small>No collection or return. Pick a plan and receive fulfilment after payment.</small><b>View eSIM plans →</b></a><a className="product-choice featured-choice" href="#plans"><span className="pill">Pocket WiFi</span><strong>Share across devices</strong><small>Delivered before departure and returned after your trip.</small><b>Check Pocket WiFi →</b></a></div><div className="trust-row"><span>eSIM & Pocket WiFi</span><span>Singapore-based support</span><span>Secure online checkout</span></div></div><form className="search-card" onSubmit={search}><h2>Pocket WiFi availability</h2><label>Destination<select value={country} onChange={e => { setCountry(e.target.value); setAvailability(null); setCheckoutError(''); }}>{plans.map(p => <option key={p.code}>{p.country}</option>)}</select></label><div className="date-grid"><label>Start date<input type="date" min={earliestStart} value={start} onChange={e => { setStart(e.target.value); if (end < e.target.value) setEnd(e.target.value); setAvailability(null); setCheckoutError(''); }} /></label><label>End date<input type="date" min={start || earliestStart} value={end} onChange={e => { setEnd(e.target.value); setAvailability(null); setCheckoutError(''); }} /></label></div><label>Promo code<input value={promoCode} onChange={e => setPromoCode(e.target.value.toUpperCase())} placeholder="Enter promo code" /></label>{promoActive && <div className="promo-applied">✓ {LAUNCH_PROMO.code} applied — {LAUNCH_PROMO.percent}% off rental</div>}<button type="submit" className="primary" disabled={checking || !datesValid}>{checking ? 'Checking availability…' : 'Check price & availability'}</button><small>Book at least {DELIVERY_LEAD_DAYS} days before departure. SGD pricing · S$10 minimum booking before promotion.</small></form></div></section>
    <section className="wrap section" id="plans"><div className="section-head"><div><span className="eyebrow">Simple daily pricing</span><h2>{searched ? `${country} Pocket WiFi` : 'Popular destinations'}</h2></div><p>Clear daily rates with the rental total calculated from your selected travel dates.</p></div><div className="plan-card featured"><div><span className="pill">Pocket WiFi</span><h3>{country}</h3><p>{plan.data} · {plan.note}</p><p className="muted">Rental: {days} day{days !== 1 ? 's' : ''} × S${plan.daily.toFixed(2)}{minimumApplied ? ' · S$10 minimum booking applies' : ''}</p>{promoActive && <p className="promo-line">Launch promo: {LAUNCH_PROMO.percent}% off with {LAUNCH_PROMO.code}</p>}{searched && availability?.available && <p className="muted">✓ Available for your dates{typeof availability.remaining === 'number' ? ` · ${availability.remaining} unit${availability.remaining === 1 ? '' : 's'} remaining` : ''}</p>}{searched && availability && !availability.available && <p className="muted">{availability.error || 'Sold out for these dates. Choose different dates or contact +65 8032 7183.'}</p>}{checkoutError && <p className="muted">{checkoutError}</p>}</div><div className="price"><span>S$</span>{plan.daily.toFixed(2)}<small>/day</small>{promoActive && <><p className="old-total">Before promo: S${baseSubtotal.toFixed(2)}</p><p className="discount-total">Save S${promoDiscount.toFixed(2)}</p></>}<p>Rental total: S${subtotal.toFixed(2)}</p><button className="primary" onClick={checkout} disabled={checking || checkingOut || !datesValid}>{checking ? 'Checking…' : checkingOut ? 'Opening secure checkout…' : availability?.available ? `Reserve for S$${subtotal.toFixed(2)}` : 'Check availability'}</button><small>Courier charges, if applicable, are shown before payment.</small></div></div></section>
    <section className="soft"><div className="wrap section"><div className="section-head"><div><span className="eyebrow">Why travellers choose QY Roam</span><h2>Easy to book. Easy to use. Easy to return.</h2></div><p>Clear pricing, simple booking, Singapore-based support and straightforward fulfilment from checkout through return.</p></div><div className="steps"><article><h3>Easy booking</h3><p>Choose your destination and dates, check live availability, and reserve online.</p></article><article><h3>Share across devices</h3><p>Connect phones, tablets and laptops to one Pocket WiFi during your trip.</p></article><article><h3>Local support</h3><p>Singapore-based support at +65 8032 7183 before, during and after your rental.</p></article><article><h3>No surprise rental pricing</h3><p>See your rental total and promotion before payment. Courier charges are disclosed at checkout.</p></article></div></div></section>
    <section className="wrap section promo-section"><div className="promo-panel"><div><span className="eyebrow">Latest promotion</span><h2>Launch Special: save 10%</h2><p>Use <strong>QY10</strong> on any eligible Pocket WiFi rental through 30 September 2026. The discount applies to the rental component; courier charges, if any, are excluded.</p></div><a className="primary promo-panel-button" href="#plans">Claim 10% off</a></div></section>
    <section className="soft" id="how"><div className="wrap section"><span className="eyebrow">Door-to-door convenience</span><h2>Four simple steps</h2><div className="steps"><article><b>1</b><h3>Book online</h3><p>Choose destination and dates, then pay securely by card or PayNow where available.</p></article><article><b>2</b><h3>Receive before departure</h3><p>We courier the Pocket WiFi to your Singapore delivery address.</p></article><article><b>3</b><h3>Travel connected</h3><p>Switch it on and connect your phones, tablets or laptops.</p></article><article><b>4</b><h3>Return after your trip</h3><p>Pack the complete kit and follow the supplied courier return instructions.</p></article></div></div></section>
    <section className="wrap section"><div className="section-head"><div><span className="eyebrow">Book with confidence</span><h2>Built for straightforward travel connectivity</h2></div></div><div className="steps"><article><h3>Upfront pricing</h3><p>See your rental total before checkout. Any applicable courier charge is disclosed before payment.</p></article><article><h3>Local help</h3><p>Need help before or during your rental? Contact our Singapore support team at +65 8032 7183.</p></article><article><h3>Track your booking</h3><p>After payment, use your secure booking-status page to follow fulfilment and delivery tracking.</p></article><article><h3>Clear return process</h3><p>Return the complete kit within five calendar days after your rental ends and retain courier evidence until receipt is confirmed.</p></article></div></section>
    <section className="wrap section cta"><h2>Questions before booking?</h2><p>WhatsApp or call our Singapore customer support team.</p><a className="secondary" href="https://wa.me/6580327183">WhatsApp +65 8032 7183</a></section>
  </main>;
}
