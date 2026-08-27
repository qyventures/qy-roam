'use client';

import { useMemo, useState } from 'react';
import { ESIM_PLANS, ESIM_PROMO } from '../../lib/esimPlans';

export default function EsimPage() {
  const [planId, setPlanId] = useState(ESIM_PLANS[0].id);
  const [promoCode, setPromoCode] = useState(ESIM_PROMO.code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const plan = useMemo(() => ESIM_PLANS.find((item) => item.id === planId) || ESIM_PLANS[0], [planId]);

  async function checkout() {
    setBusy(true);
    setError('');
    try {
      const measurementConsent = localStorage.getItem('qyroam_consent') === 'accepted';
      const res = await fetch('/api/esim-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, promoCode, measurementConsent })
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
    <section className="promo-banner"><div className="wrap promo-inner"><div><span className="promo-kicker">{ESIM_PROMO.label}</span><strong>15% off QY Roam travel eSIMs</strong><span>Code <b>{ESIM_PROMO.code}</b> · launch offer</span></div><a href="#esim-plans" className="promo-cta">Shop eSIM</a></div></section>

    <section className="hero esim-hero"><div className="wrap hero-grid"><div><span className="eyebrow">Travel eSIM</span><h1>Land connected. No SIM swapping required.</h1><p className="lead">Choose your destination, buy online and install your eSIM by QR code. QY Roam launch pricing is benchmarked to current Changi Recommends public eSIM pricing, then discounted by 15%.</p><div className="trust-row"><span>QR-code setup</span><span>No physical SIM swap</span><span>Hotspot on supported plans</span></div></div><div className="search-card"><span className="promo-kicker esim-kicker">15% OFF</span><h2>Choose your eSIM</h2><label>Plan<select value={planId} onChange={(e) => setPlanId(e.target.value)}>{ESIM_PLANS.map((item) => <option value={item.id} key={item.id}>{item.destination} · {item.days} days</option>)}</select></label><label>Promo code<input value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase())} /></label><div className="promo-applied">✓ {ESIM_PROMO.code} · {ESIM_PROMO.percent}% off launch pricing</div><button className="primary" onClick={checkout} disabled={busy}>{busy ? 'Opening secure checkout…' : `Buy for S$${plan.qyPriceSgd.toFixed(2)}`}</button>{error && <p className="muted">{error}</p>}<small>Card & PayNow where available. eSIM-compatible device required.</small></div></div></section>

    <section className="wrap section" id="esim-plans"><div className="section-head"><div><span className="eyebrow">Travel eSIM plans</span><h2>Launch selection</h2></div><p>We are starting with verified public benchmark plans and will expand the catalogue as more destination pricing is validated.</p></div><div className="esim-grid">{ESIM_PLANS.map((item) => <article className="esim-card" key={item.id}><span className="pill">eSIM</span><h3>{item.destination}</h3><p>{item.days} days · {item.data}</p><p className="muted">{item.note}</p><div className="esim-price-row"><div><span className="old-total">S${item.benchmarkPriceSgd.toFixed(2)}</span><strong>S${item.qyPriceSgd.toFixed(2)}</strong><small> after 15% off</small></div><button className="secondary" onClick={() => { setPlanId(item.id); document.querySelector('.esim-hero')?.scrollIntoView({ behavior: 'smooth' }); }}>Choose</button></div></article>)}</div></section>

    <section className="soft"><div className="wrap section"><span className="eyebrow">How it works</span><h2>Three simple steps</h2><div className="steps three"><article><b>1</b><h3>Buy online</h3><p>Select a destination plan and complete secure checkout.</p></article><article><b>2</b><h3>Receive your eSIM details</h3><p>We process the order for QR-code fulfilment to your email.</p></article><article><b>3</b><h3>Install & travel</h3><p>Scan the QR code on an eSIM-compatible phone and follow the activation instructions before or at departure.</p></article></div></div></section>

    <section className="wrap section"><div className="section-head"><div><span className="eyebrow">Choose the right connection</span><h2>eSIM or Pocket WiFi?</h2></div></div><div className="product-compare"><article><span className="pill">eSIM</span><h3>Best for one phone</h3><p>Fast digital setup with no hardware to carry or return.</p><a className="secondary" href="/esim">Shop eSIM</a></article><article><span className="pill">Pocket WiFi</span><h3>Best for groups & multiple devices</h3><p>Share one connection across phones, tablets and laptops.</p><a className="secondary" href="/#plans">Rent Pocket WiFi</a></article></div></section>

    <section className="wrap section cta"><h2>Need help choosing?</h2><p>WhatsApp our Singapore support team.</p><a className="secondary" href="https://wa.me/6580327183">WhatsApp +65 8032 7183</a></section>
  </main>;
}
