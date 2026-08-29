'use client';

import { useMemo, useState } from 'react';
import { ESIM_PLANS, ESIM_PROMO } from '../../lib/esimPlans';
import { trackMeta } from '../../lib/metaClient';

export default function EsimPage() {
  const [planId, setPlanId] = useState<string>(ESIM_PLANS[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const plan = useMemo(() => ESIM_PLANS.find((item) => item.id === planId) || ESIM_PLANS[0], [planId]);
  const dailyPrice = plan.qyPriceSgd / plan.days;

  async function checkout() {
    setBusy(true);
    setError('');
    try {
      const measurementConsent = localStorage.getItem('qyroam_consent') === 'accepted';
      if (measurementConsent) trackMeta('InitiateCheckout', {
        content_name: `${plan.destination} Travel eSIM`,
        content_category: 'Travel eSIM',
        content_ids: [plan.id],
        content_type: 'product',
        value: Number(plan.qyPriceSgd.toFixed(2)),
        currency: 'SGD',
        num_items: 1
      });
      const res = await fetch('/api/esim-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, measurementConsent })
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else setError(data.error || 'Checkout is temporarily unavailable. Please contact +65 8032 7183.');
    } catch {
      setError('Checkout is temporarily unavailable. Please contact +65 8032 7183.');
    } finally {
      setBusy(false);
    }
  }

  return <main>
    <section className="promo-banner"><div className="wrap promo-inner"><div><span className="promo-kicker">{ESIM_PROMO.label}</span><strong>Competitive travel data from S$0.48/day</strong><span>Verified benchmark discount is applied automatically at checkout</span></div><a href="#esim-plans" className="promo-cta">Shop eSIM</a></div></section>

    <section className="hero esim-hero"><div className="wrap hero-grid"><div><span className="eyebrow">Travel eSIM</span><h1>Land connected. No SIM swapping required.</h1><p className="lead">Choose your destination, buy online and install your eSIM by QR code. QY Roam uses server-authoritative launch pricing so the price shown at checkout is the price you pay.</p><div className="trust-row"><span>QR-code setup</span><span>No physical SIM swap</span><span>Hotspot on supported plans</span></div></div><div className="search-card"><span className="promo-kicker esim-kicker">LAUNCH PRICE</span><h2>Choose your eSIM</h2><label>Plan<select value={planId} onChange={(e) => setPlanId(e.target.value)}>{ESIM_PLANS.map((item) => <option value={item.id} key={item.id}>{item.destination} · {item.days} days</option>)}</select></label><div className="promo-applied">✓ Launch discount already included · no code needed</div><p className="muted">Effective price: S${dailyPrice.toFixed(2)}/day</p><button className="primary" onClick={checkout} disabled={busy}>{busy ? 'Opening secure checkout…' : `Buy for S$${plan.qyPriceSgd.toFixed(2)}`}</button>{error && <p className="muted">{error}</p>}<small>Card & PayNow where available. eSIM-compatible, carrier-unlocked device required.</small></div></div></section>

    <section className="wrap section" id="esim-plans"><div className="section-head"><div><span className="eyebrow">Travel eSIM plans</span><h2>Launch selection</h2></div><p>We list only plans with a verified comparable public benchmark and expand the catalogue as additional destination pricing is validated.</p></div><div className="esim-grid">{ESIM_PLANS.map((item) => <article className="esim-card" key={item.id}><span className="pill">eSIM</span><h3>{item.destination}</h3><p>{item.days} days · {item.data}</p><p className="muted">{item.note}</p><div className="esim-price-row"><div><span className="old-total">Benchmark S${item.benchmarkPriceSgd.toFixed(2)}</span><strong>S${item.qyPriceSgd.toFixed(2)}</strong><small> QY Roam launch price · S${(item.qyPriceSgd / item.days).toFixed(2)}/day</small></div><button className="secondary" onClick={() => { setPlanId(item.id); document.querySelector('.esim-hero')?.scrollIntoView({ behavior: 'smooth' }); }}>Choose</button></div></article>)}</div></section>

    <section className="soft"><div className="wrap section"><span className="eyebrow">How it works</span><h2>Three simple steps</h2><div className="steps three"><article><b>1</b><h3>Buy online</h3><p>Select a destination plan and complete secure checkout.</p></article><article><b>2</b><h3>Receive your eSIM details</h3><p>After payment is confirmed, your order is routed to our fulfilment team for the QR code and activation instructions to be sent to your checkout email.</p></article><article><b>3</b><h3>Install & travel</h3><p>Use a stable internet connection to add the eSIM. Activate it according to the supplied instructions and enable data roaming for the travel eSIM when required at your destination.</p></article></div></div></section>

    <section className="wrap section"><div className="section-head"><div><span className="eyebrow">Before you buy</span><h2>eSIM essentials</h2></div><p>A few checks prevent most activation problems.</p></div><div className="product-compare"><article><span className="pill">Compatibility</span><h3>Check your phone first</h3><p>Your device must support eSIM and be carrier-unlocked. On many phones, an “Add eSIM” option appears in cellular or SIM settings.</p></article><article><span className="pill">QR code</span><h3>Install only on the intended device</h3><p>An eSIM QR code is generally a single-device credential. Do not delete an installed travel eSIM unless your supplied plan instructions say it can be reinstalled.</p></article></div></section>

    <section className="soft"><div className="wrap section"><div className="section-head"><div><span className="eyebrow">eSIM FAQ</span><h2>Know before checkout</h2></div><p>Clear answers for the most common purchase and activation questions.</p></div><div className="product-compare"><article><h3>When will I receive the QR code?</h3><p>After successful payment, QY Roam routes the order to our fulfilment team. Your eSIM details and activation instructions are sent to the email used at checkout.</p><h3>When should I install or activate it?</h3><p>Follow the instructions supplied with your specific plan. Install while you have a stable internet connection, and avoid deleting the eSIM after installation.</p></article><article><h3>Can I use the same eSIM on two phones?</h3><p>No. Treat the QR code as a single-device credential and install it only on the phone you intend to use for travel.</p><h3>What if I need help?</h3><p>WhatsApp QY Roam Singapore support at +65 8032 7183 before departure so we can help you check the order and setup instructions.</p></article></div></div></section>

    <section className="wrap section"><div className="section-head"><div><span className="eyebrow">Choose the right connection</span><h2>eSIM or Pocket WiFi?</h2></div></div><div className="product-compare"><article><span className="pill">eSIM</span><h3>Best for one phone</h3><p>Fast digital setup with no hardware to carry or return.</p><a className="secondary" href="/esim">Shop eSIM</a></article><article><span className="pill">Pocket WiFi</span><h3>Best for groups & multiple devices</h3><p>Share one connection across phones, tablets and laptops.</p><a className="secondary" href="/#plans">Rent Pocket WiFi</a></article></div></section>

    <section className="wrap section cta"><h2>Need help choosing?</h2><p>WhatsApp our Singapore support team.</p><a className="secondary" href="https://wa.me/6580327183">WhatsApp +65 8032 7183</a></section>
  </main>;
}
