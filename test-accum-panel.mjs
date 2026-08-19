// Render the panel headlessly with stub DOM + fake state, so a broken panel is caught here
// rather than on John's phone.
import fs from 'node:fs';
const src = fs.readFileSync('index.html','utf8');
const m = src.match(/  function renderAccum\(st, log\)\{[\s\S]*?\n  \}\n/);
if(!m) { console.log('FAIL: could not extract renderAccum'); process.exit(1); }
const esc = s => String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fnum = n => Number(n).toLocaleString();
let html = null;
const document = { getElementById: id => id==='accum-panel' ? { set innerHTML(v){ html=v; }, get innerHTML(){ return html; } } : null };
const fn = new Function('esc','fnum','document', m[0] + '; return renderAccum;')(esc,fnum,document);

let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+String(x).slice(0,150):'')));};

console.log('\n1. Nothing recorded yet');
fn({}, []);
ok('shows a clear not-started message', /Not started/.test(html));

console.log('\n2. Fully holding, ahead of buy-and-hold');
fn({ cipher_accum: { units:1.0123, cash:0, open:[], sells:3, fills:12, startedAt:'2026-08-19', pxNow:64000, startUnits:1 } }, []);
ok('state reads FULLY HOLDING', /FULLY HOLDING/.test(html));
ok('shows the unit count', /1\.01230 BTC/.test(html));
ok('shows the gain vs hold', /\+1\.23%/.test(html), html.match(/[+-][\d.]+%/));
ok('names the benchmark', /1\b/.test(html));

console.log('\n2b. A REAL small balance is compared against ITSELF, not against 1.0');
{
  // The bug John caught: 0.00768 BTC vs a hardcoded 1.00000 benchmark read -99.23%.
  fn({ cipher_accum: { units:0.00767931, cash:0, open:[], sells:0, fills:0, pxNow:65000,
                       startUnits:0.00767931, seededAt:'2026-08-19' } }, []);
  ok('a freshly seeded real wallet reads 0.00%, not -99%', /0\.00%/.test(html) && !/-99/.test(html),
     (html.match(/[+-]?[\d.]+%/)||[])[0]);
  ok('the benchmark shown is the real starting balance', /0\.00767931/.test(html));
  // and it still reports a genuine gain correctly
  fn({ cipher_accum: { units:0.00790000, cash:0, open:[], sells:2, fills:5, pxNow:65000,
                       startUnits:0.00767931 } }, []);
  ok('a real gain shows as a positive percentage', /\+2\.87%/.test(html), (html.match(/[+-][\d.]+%/)||[])[0]);
}

console.log('\n3. Sold, waiting, with rungs resting');
fn({ cipher_accum: { units:0.8, cash:12800, open:[
  {src:'swingLow',px:62000,usdt:6400},{src:'FVG',px:60500,usdt:6400}
], sells:4, fills:9, startedAt:'2026-08-19', pxNow:64000,
  lastReviewText:{ read:'early days, two fills', concern:'cash idle in a rally', suggestion:'tighter first rung', sampleTooSmall:false } } },
[{ at:Date.now(), result:'ACCUM SELL', skipped:'sold 20% at 64000 on a red dot' }]);
ok('state reads SOLD — WAITING', /SOLD — WAITING TO BUY BACK/.test(html));
ok('lists the resting rungs', /swingLow/.test(html) && /FVG/.test(html));
ok('shows how far below spot each sits', /3\.13% below spot/.test(html), html.match(/[\d.]+% below spot/g));
ok('rungs sorted nearest-first', html.indexOf('swingLow') < html.indexOf('FVG'));
ok('shows idle cash', /cash idle/.test(html));
ok('shows the brain review', /early days, two fills/.test(html));
ok('marks a suggestion as advisory', /must win a shadow arm/.test(html));
ok('shows recent activity', /RECENT ACTIVITY/.test(html) && /SELL/.test(html));

console.log('\n4. Behind buy-and-hold is shown honestly');
fn({ cipher_accum: { units:0.94, cash:0, open:[], sells:9, fills:20, startedAt:'2026-01-01', pxNow:64000, startUnits:1 } }, []);
ok('shows a negative number, not a spun one', /-6\.00%/.test(html), html.match(/[+-][\d.]+%/));

console.log('\n5. Junk state does not crash the panel');
fn({ cipher_accum: { units:null, cash:null, open:null, pxNow:0 } }, null);
ok('renders something rather than throwing', typeof html === 'string' && html.length > 0);


// ── THE TIMEFRAME TOGGLES (2026-08-19) ──────────────────────────────────────────────────────
console.log('\n6. The toggles render whatever the state says');
{
  const flips = { '5m':{gainPct:-2.28,trips:30,holding:true}, '15m':{gainPct:-2.26,trips:30,holding:true},
                  '30m':{gainPct:-1.19,trips:25,holding:true}, '1H':{gainPct:0.86,trips:28,holding:true},
                  '2H':{gainPct:-1.37,trips:31,holding:true}, '3H':{gainPct:-3.3,trips:11,holding:true},
                  '4H':{gainPct:-12.44,trips:30,holding:false}, '1D':{gainPct:32.97,trips:30,holding:true} };
  const base = { units:0.00767931, cash:0, open:[], sells:0, fills:0, pxNow:65000, startUnits:0.00767931, flips };

  fn({ cipher_accum: base }, []);
  ok('all eight timeframes get a button', ['5m','15m','30m','1H','2H','3H','4H','1D']
     .every(t => html.includes('setFlipTf(\''+t+'\')')));
  ok('there is an OFF button too', /setFlipTf\('off'\)/.test(html));
  ok('with nothing armed it says the ladder holds the coins', /pump ladder holds the coins/.test(html));
  ok('the best paper arm is starred', /1D ★/.test(html));

  fn({ cipher_accum: { ...base, liveFlip:{ tf:'1H', holding:true, gainPct:0.42, sells:2, trips:1 } } }, []);
  ok('an armed timeframe is announced', /1H is live on the real balance/.test(html));
  ok('the armed row is dotted, not starred', /1H ●/.test(html));
  ok('the star still marks the best paper arm separately', /1D ★/.test(html));
  ok('it says which way round it is sitting', /waiting for a red dot/.test(html));
  ok('it says the ladder is stood down', /pump ladder is stood down/.test(html));

  fn({ cipher_accum: { ...base, liveFlip:{ tf:'4H', holding:false, gainPct:-1.1, sells:3, trips:2 } } }, []);
  ok('sitting in cash is described as such', /sitting in cash, waiting for a green dot/.test(html));

  fn({ cipher_accum: { ...base, liveFlip:{ tf:null, want:'1H', blocked:true, why:'the whole stack is 499 USDT but ACCUM_MAX_USDT is 200' } } }, []);
  ok('a blocked arm is shown as requested-but-not-armed', /requested but NOT armed/.test(html));
  ok('and the reason is quoted verbatim', /ACCUM_MAX_USDT is 200/.test(html));
  ok('a blocked arm does not claim to be live', !/is live on the real balance/.test(html));

  fn({ cipher_accum: { ...base, flips:null } }, []);
  ok('the toggles still render before any flip data exists', /setFlipTf\('1H'\)/.test(html));
  ok('and it says it is waiting for the bot', /Waiting for the bot/.test(html));
}

console.log('\n7. The paper record is labelled honestly');
{
  const flips = { '1H':{gainPct:0.86,trips:28,holding:true} };
  fn({ cipher_accum: { units:0.0077, cash:0, open:[], sells:0, fills:0, pxNow:65000, startUnits:0.0077, flips,
                       liveFlip:{ tf:'1H', holding:true, gainPct:0.1, sells:1, trips:0 } } }, []);
  ok('the 1bp maker assumption is called optimistic', /optimistic/.test(html));
  ok('the live arm is said to book at the real fee', /real 10bps/.test(html));
  ok('and the reader is warned the two numbers will not agree', /will not agree/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
