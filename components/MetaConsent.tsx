'use client';

import { useEffect, useState } from 'react';

declare global { interface Window { fbq?: (...args: any[]) => void; _fbq?: any; } }

function loadPixel(pixelId: string) {
  if (!pixelId || window.fbq) return;
  const f: any = function(){ f.callMethod ? f.callMethod.apply(f, arguments) : f.queue.push(arguments); };
  f.queue = []; f.loaded = true; f.version = '2.0';
  window.fbq = f;
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(script);
  f('init', pixelId);
  f('track', 'PageView');
}

export default function MetaConsent() {
  const [choice, setChoice] = useState<string | null>(null);
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID || '';

  useEffect(() => {
    const saved = localStorage.getItem('qyroam_consent');
    setChoice(saved);
    if (saved === 'accepted' && pixelId) loadPixel(pixelId);
  }, [pixelId]);

  function choose(value: 'accepted' | 'essential') {
    localStorage.setItem('qyroam_consent', value);
    setChoice(value);
    if (value === 'accepted' && pixelId) loadPixel(pixelId);
  }

  if (choice) return null;
  return <div style={{position:'fixed',left:16,right:16,bottom:16,zIndex:50,maxWidth:720,margin:'0 auto',background:'#152238',color:'#fff',padding:18,borderRadius:12,boxShadow:'0 10px 40px rgba(0,0,0,.25)'}}>
    <div style={{fontWeight:800,marginBottom:6}}>Cookies & measurement</div>
    <div style={{fontSize:13,lineHeight:1.5,opacity:.9}}>We use essential technologies to run bookings. With your permission, we also use advertising measurement to understand campaign performance.</div>
    <div style={{display:'flex',gap:10,marginTop:12,flexWrap:'wrap'}}><button onClick={()=>choose('accepted')} className="primary" style={{width:'auto'}}>Accept analytics</button><button onClick={()=>choose('essential')} className="secondary">Essential only</button></div>
  </div>;
}
