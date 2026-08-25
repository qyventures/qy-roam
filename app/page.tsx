'use client';

import { FormEvent, useMemo, useState } from 'react';

const plans = [
  { country: 'Japan', code: 'JP', daily: 1.84, data: '1GB/day high-speed', note: 'Then managed speed' },
  { country: 'South Korea', code: 'KR', daily: 1.84, data: '1GB/day high-speed', note: 'Then managed speed' },
  { country: 'Thailand', code: 'TH', daily: 1.84, data: '1GB/day high-speed', note: 'Then managed speed' },
  { country: 'Malaysia', code: 'MY', daily: 1.84, data: '1GB/day high-speed', note: 'Then managed speed' },
  { country: 'Indonesia', code: 'ID', daily: 1.84, data: '1GB/day high-speed', note: 'Then managed speed' },
  { country: 'Taiwan', code: 'TW', daily: 1.84, data: '1GB/day high-speed', note: 'Then managed speed' },
  { country: 'Vietnam', code: 'VN', daily: 1.84, data: '1GB/day high-speed', note: 'Then managed speed' },
  { country: 'Australia', code: 'AU', daily: 3.78, data: '1GB/day high-speed', note: 'Then managed speed' },
  { country: 'United States', code: 'US', daily: 3.78, data: '1GB/day high-speed', note: 'Then managed speed' },
  { country: 'United Kingdom', code: 'GB', daily: 3.78, data: '1GB/day high-speed', note: 'Then managed speed' }
];

function daysBetween(start: string, end: string) {
  if (!start || !end) return 1;
  const a = new Date(start + 'T00:00:00');
  const b = new Date(end + 'T00:00:00');
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);
}

export default function Home() {
  const today = new Date().toISOString().slice(0, 10);
  const [country, setCountry] = useState('Japan');
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [searched, setSearched] = useState(false);
  const plan = useMemo(() => plans.find(p => p.country === country) || plans[0], [country]);
  const days = daysBetween(start, end);
  const subtotal = Math.max(10, plan.daily * days);

  function search(e: FormEvent) {
    e.preventDefault();
    setSearched(true);
    document.getElementById('plans')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function checkout() {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country, start, end, days, daily: plan.daily, subtotal })
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else alert(data.error || 'Checkout is temporarily unavailable. Please contact +65 8032 7183.');
  }

  return (
    <main>
      <section className="hero">
        <div className="wrap hero-grid">
          <div>
            <span className="eyebrow">Travel WiFi delivered in Singapore</span>
            <h1>Stay connected overseas without the roaming bill.</h1>
            <p className="lead">Pocket WiFi for your whole travel group. We courier it to you before departure, and you courier it back after your trip.</p>
            <div className="trust-row"><span>Share across devices</span><span>Singapore support</span><span>Secure checkout</span></div>
          </div>
          <form className="search-card" onSubmit={search}>
            <h2>Find your plan</h2>
            <label>Destination<select value={country} onChange={e => setCountry(e.target.value)}>{plans.map(p => <option key={p.code}>{p.country}</option>)}</select></label>
            <div className="date-grid">
              <label>Start date<input type="date" min={today} value={start} onChange={e => setStart(e.target.value)} /></label>
              <label>End date<input type="date" min={start || today} value={end} onChange={e => setEnd(e.target.value)} /></label>
            </div>
            <button type="submit" className="primary">Search plans</button>
            <small>Prices shown in SGD. Minimum checkout S$10.</small>
          </form>
        </div>
      </section>

      <section className="wrap section" id="plans">
        <div className="section-head"><div><span className="eyebrow">Simple daily pricing</span><h2>{searched ? `${country} plan` : 'Popular destinations'}</h2></div><p>Launch pricing is benchmarked below comparable Yoowifi day-pass rates where a comparable public rate is available.</p></div>
        <div className="plan-card featured">
          <div><span className="pill">Pocket WiFi</span><h3>{country}</h3><p>{plan.data} · {plan.note}</p><p className="muted">Rental period: {days} day{days !== 1 ? 's' : ''}</p></div>
          <div className="price"><span>S$</span>{plan.daily.toFixed(2)}<small>/day</small><p>Total from S${subtotal.toFixed(2)}</p><button className="primary" onClick={checkout}>Reserve & pay</button></div>
        </div>
        <p className="pricing-note">Courier charges, if applicable, are shown before payment. Final coverage and network performance depend on local operators.</p>
      </section>

      <section className="soft" id="how"><div className="wrap section"><span className="eyebrow">Door-to-door convenience</span><h2>How QY Roam works</h2><div className="steps"><article><b>1</b><h3>Book online</h3><p>Choose destination and travel dates, then pay securely by card or PayNow where available.</p></article><article><b>2</b><h3>We courier it to you</h3><p>Your pocket WiFi arrives at your Singapore delivery address before departure.</p></article><article><b>3</b><h3>Travel connected</h3><p>Switch it on, connect your devices and use it throughout the booked period.</p></article><article><b>4</b><h3>Courier it back</h3><p>After your trip, pack the device and return it to us using the return instructions supplied with your order.</p></article></div></div></section>

      <section className="wrap section cta"><h2>Questions before booking?</h2><p>WhatsApp or call our Singapore customer support team.</p><a className="secondary" href="https://wa.me/6580327183">WhatsApp +65 8032 7183</a></section>
    </main>
  );
}
