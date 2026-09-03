import fs from 'node:fs';
const src=fs.readFileSync(new URL('../lib/wifiPlans.ts',import.meta.url),'utf8');
const MAX_BENCHMARK_AGE_DAYS=30;
const min=Number((src.match(/minimumDiscountPercent:\s*(\d+(?:\.\d+)?)/)||[])[1]);
const verifiedOn=(src.match(/verifiedOn:\s*'([^']+)'/)||[])[1];
const singaporeParts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).reduce((result,part)=>{if(part.type!=='literal')result[part.type]=part.value;return result;},{});
const today=`${singaporeParts.year}-${singaporeParts.month}-${singaporeParts.day}`;
function exactIsoDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return null;const date=new Date(`${value}T00:00:00Z`);return Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==value?null:date;}
const verified=exactIsoDate(verifiedOn), now=exactIsoDate(today);
const ageDays=verified&&now?(now.getTime()-verified.getTime())/86400000:Number.NaN;
if(!Number.isFinite(ageDays)||ageDays<0||ageDays>MAX_BENCHMARK_AGE_DAYS) throw new Error(`Stale WiFi benchmark: ${verifiedOn||'missing'} (checked ${today})`);
if(!Number.isFinite(min)||min<=0) throw new Error('Unable to parse WiFi pricing guard inputs');
const undercut=b=>Math.floor(b*(1-min/100)*100)/100;
const plans=[...src.matchAll(/\{\s*country:'([^']+)',\s*code:'[^']+',\s*benchmarkRateSgd:([^,]+),\s*daily:([^,}]+)/g)];
if(!plans.length) throw new Error('No WiFi plans found');
const countries=new Set();
for(const [,country,benchmarkExpression,dailyExpression] of plans){
  if(countries.has(country)) throw new Error(`Duplicate WiFi destination: ${country}`);
  countries.add(country);
  const benchmarkConstant=(benchmarkExpression.match(/^\s*([A-Z_]+)\s*$/)||[])[1];
  const benchmark=Number((src.match(new RegExp(`const ${benchmarkConstant} = (\\d+(?:\\.\\d+)?)`))||[])[1]);
  if(!benchmarkConstant||!Number.isFinite(benchmark)||benchmark<=0||dailyExpression.trim()!==`undercut(${benchmarkConstant})`) throw new Error(`Invalid server pricing expression for ${country}`);
  const q=undercut(benchmark), d=(benchmark-q)/benchmark*100;
  if(d+1e-9<min) throw new Error(`${country} discount ${d.toFixed(2)}% is below ${min}%`);
  console.log(`${country}: benchmark S$${benchmark.toFixed(2)} -> QY S$${q.toFixed(2)} (${d.toFixed(2)}% below)`);
}
console.log(`WiFi pricing guard passed for ${plans.length} destinations with benchmarks verified within ${MAX_BENCHMARK_AGE_DAYS} days.`);
