import fs from 'node:fs';
const src=fs.readFileSync(new URL('../lib/wifiPlans.ts',import.meta.url),'utf8');
const min=Number((src.match(/minimumDiscountPercent:\s*(\d+(?:\.\d+)?)/)||[])[1]);
const asia=Number((src.match(/const ASIA = (\d+(?:\.\d+)?)/)||[])[1]);
const long=Number((src.match(/const LONG_HAUL = (\d+(?:\.\d+)?)/)||[])[1]);
if(!Number.isFinite(min)||!Number.isFinite(asia)||!Number.isFinite(long)) throw new Error('Unable to parse WiFi pricing guard inputs');
const undercut=b=>Math.floor(b*(1-min/100)*100)/100;
for(const [name,b] of [['Asia',asia],['Long-haul',long]]){ const q=undercut(b); const d=(b-q)/b*100; if(d+1e-9<min) throw new Error(`${name} discount ${d.toFixed(2)}% is below ${min}%`); console.log(`${name}: benchmark S$${b.toFixed(2)} -> QY S$${q.toFixed(2)} (${d.toFixed(2)}% below)`);}
