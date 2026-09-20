'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { metaMeasurementConsent, setMetaMeasurementConsent } from '@/lib/metaClient';
import { metaPixelId } from '@/lib/runtimeConfig';

declare global { interface Window { fbq?: (...args: any[]) => void; _fbq?: any; } }

type Consent = 'accepted' | 'essential';

function loadPixel(pixelId: string) {
  if (!pixelId) return;
  if (window.fbq) {
    // A visitor can revoke and later re-grant measurement in the same page.
    // Reuse the existing Pixel instance while explicitly restoring consent.
    window.fbq('consent', 'grant');
    return;
  }
  const f: any = function(){ f.callMethod ? f.callMethod.apply(f, arguments) : f.queue.push(arguments); };
  f.queue = []; f.loaded = true; f.version = '2.0';
  window.fbq = f;
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(script);
  f('consent', 'grant');
  f('init', pixelId);
  f('track', 'PageView');
}

function revokePixel() {
  // The script may already be resident after an earlier opt-in. Tell Meta to
  // stop measurement immediately; all QY Roam event helpers independently
  // check the stored choice before queueing another event.
  window.fbq?.('consent', 'revoke');
}

export default function MetaConsent() {
  const [choice, setChoice] = useState<Consent | null>(null);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Use the exact validated identifier accepted by server-side CAPI. This
  // keeps browser Pixel and CAPI conversion reporting aligned when an
  // environment value contains deploy-time whitespace or an invalid value.
  const pixelId = metaPixelId() || '';

  useEffect(() => {
    const saved = metaMeasurementConsent();
    // The helper also tolerates storage being unavailable. In that case we do
    // not invent a saved choice, so the banner remains available to collect an
    // explicit, tab-local preference.
    setChoice(saved);
    setReady(true);
    if (saved === 'accepted' && pixelId) loadPixel(pixelId);
  }, [pixelId]);

  function choose(value: Consent) {
    setMetaMeasurementConsent(value);
    setChoice(value);
    setSettingsOpen(false);
    if (value === 'accepted' && pixelId) loadPixel(pixelId);
    if (value === 'essential') revokePixel();
  }

  if (!ready) return null;

  if (choice && !settingsOpen) {
    return <button type="button" onClick={() => setSettingsOpen(true)} aria-label="Open cookie preferences" style={{position:'fixed',right:16,bottom:16,zIndex:49,border:'1px solid #d8dee8',background:'#fff',color:'#152238',padding:'8px 12px',borderRadius:999,fontSize:12,fontWeight:700,boxShadow:'0 4px 18px rgba(0,0,0,.12)'}}>Privacy choices</button>;
  }

  return <div role="dialog" aria-label="Cookie preferences" style={{position:'fixed',left:16,right:16,bottom:16,zIndex:50,maxWidth:720,margin:'0 auto',background:'#152238',color:'#fff',padding:18,borderRadius:12,boxShadow:'0 10px 40px rgba(0,0,0,.25)'}}>
    <div style={{fontWeight:800,marginBottom:6}}>Cookies & advertising measurement</div>
    <div style={{fontSize:13,lineHeight:1.5,opacity:.9}}>Essential technologies are used to run bookings and payments. With your permission, QY Roam also uses Meta advertising measurement to understand campaign performance. Choosing essential only does not affect your ability to book.</div>
    <div style={{fontSize:12,marginTop:8}}><Link href="/privacy" style={{color:'#fff',textDecoration:'underline'}}>Read our privacy notice</Link></div>
    <div style={{display:'flex',gap:10,marginTop:12,flexWrap:'wrap'}}><button type="button" onClick={()=>choose('accepted')} className="primary" style={{width:'auto'}}>Allow measurement</button><button type="button" onClick={()=>choose('essential')} className="secondary">Essential only</button>{choice && <button type="button" onClick={()=>setSettingsOpen(false)} className="secondary">Cancel</button>}</div>
  </div>;
}
