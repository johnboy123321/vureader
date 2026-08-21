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
ok('state reads HOLDING BITCOIN', /HOLDING BITCOIN/.test(html));
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
ok('state reads IN CASH — WAITING', /IN CASH — WAITING TO BUY BACK/.test(html));
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

console.log('\n8. The toggles look like something you can press');
{
  // The first version drew them as bare text and John could not see them. A control that does
  // not read as a control is a bug, so it gets an assertion like any other.
  const flips = { '1H':{gainPct:0.86,trips:28,holding:true} };
  fn({ cipher_accum: { units:0.0077, cash:0, open:[], sells:0, fills:0, pxNow:65000, startUnits:0.0077, flips } }, []);
  const chips = html.match(/<button class="flip-tf"[^>]*>/g) || [];
  ok('nine chips render', chips.length === 9, chips.length);
  ok('every chip has a visible fill', chips.every(c => /background:rgba/.test(c)));
  ok('every chip has a visible border', chips.every(c => /border:1px solid #(8bd|4a4a4a)/.test(c)));
  ok('every chip says it is clickable', chips.every(c => /cursor:pointer/.test(c)));
  ok('the tap target is not tiny', chips.every(c => /padding:9px 15px/.test(c)));
  ok('unselected chips are readable, not dimmed to nothing', chips.some(c => /color:#cfcfcf/.test(c)));
  ok('OFF is highlighted when nothing is armed', /data-tf="off"[^>]*color:#8bd/.test(html));

  fn({ cipher_accum: { units:0.0077, cash:0, open:[], sells:0, fills:0, pxNow:65000, startUnits:0.0077, flips,
                       liveFlip:{ tf:'1H', holding:true, gainPct:0.1, sells:1, trips:0 } } }, []);
  ok('the armed chip is highlighted instead', /data-tf="1H"[^>]*color:#8bd/.test(html));
  ok('and OFF is not', !/data-tf="off"[^>]*color:#8bd/.test(html));
}

console.log('\n9. The flip\'s trades appear in Recent Activity');
{
  // 2026-08-20: the filter matched only results starting "ACCUM", so twenty real FLIP orders
  // were invisible and John concluded nothing was happening. A panel that hides the activity it
  // exists to show reports silence as fact.
  const flips = { '5m':{gainPct:-4.65,trips:58,holding:true} };
  const base = { units:0.00739181, cash:0, open:[], sells:0, fills:0, pxNow:72650,
                 startUnits:0.00767949, flips,
                 liveFlip:{ tf:'5m', holding:true, gainPct:-3.75, sells:10, trips:10 } };
  const log = [
    { at:'2026-08-20T19:48:00Z', result:'FLIP BUY',  skipped:'5m green dot — bought back with 537.57 USDT at 72652.9. SPOT BUY PLACED' },
    { at:'2026-08-20T17:35:00Z', result:'FLIP SELL', skipped:'5m red dot — sold the whole stack at 72748.6. SPOT SELL PLACED' },
    { at:'2026-08-19T17:09:00Z', result:'FLIP UNPLACED', skipped:'did not reach the venue' },
    { at:'2026-08-19T16:48:00Z', result:'FLIP ARMED', skipped:'5m dot flip is now live' },
    { at:'2026-08-19T13:59:00Z', result:'ACCUM SEEDED', skipped:'spot wallet funded' },
  ];
  fn({ cipher_accum: base }, log);
  ok('a flip buy is listed', /FLIP BUY/.test(html));
  ok('a flip sell is listed', /FLIP SELL/.test(html));
  ok('the arming event is listed', /FLIP ARMED/.test(html));
  ok('ladder events still listed too', /SEEDED/.test(html));
  ok('flip rows are labelled as such', /dot flip/.test(html));
  ok('a buy is green', /color:#9c9;font-weight:700;">FLIP BUY/.test(html));
  ok('a sell is amber', /color:#e8c07a;font-weight:700;">FLIP SELL/.test(html));
  ok('a FAILED order is red, never mistaken for a fill',
     /color:#e88;font-weight:700;">FLIP UNPLACED/.test(html));
  ok('the section header appears', /RECENT ACTIVITY/.test(html));

  // The old filter would have shown only the one ACCUM row.
  const oldWouldShow = log.filter(e => String(e.result).startsWith('ACCUM')).length;
  ok('the old filter would have hidden all four flip rows', oldWouldShow === 1, oldWouldShow);
}

console.log('\n10. The header reports whichever strategy actually holds the coins');
{
  // 2026-08-20: the header read "sells 0 · buy-backs 0 · trigger pump1" while the flip line two
  // rows below reported ten sells. Both true of their own book, shown as if they were one thing.
  const flips = { '5m':{gainPct:-4.65,trips:58,holding:true} };
  const withFlip = { units:0.00739181, cash:0, open:[], sells:0, fills:0, pxNow:72650,
                     startUnits:0.00767949, trigger:'pump1', flips,
                     liveFlip:{ tf:'5m', holding:true, gainPct:-3.75, sells:10, trips:10 } };
  fn({ cipher_accum: withFlip }, []);
  ok('it names the driver', /driving[\s\S]{0,80}5m dot flip/.test(html));
  ok('it shows the FLIP\'s sells, not the ladder\'s zero', /sells <b>10<\/b>/.test(html));
  ok('and the flip\'s buy-backs', /buy-backs <b>10<\/b>/.test(html));
  ok('the stood-down ladder trigger is NOT shown as live', !/trigger <b>/.test(html));
  ok('no contradiction: header sells matches the flip line', !/sells <b>0<\/b>/.test(html));
  ok('start and finish are both stated in coins', /You started with[\s\S]{0,200}You now have/.test(html));
  ok('the loss is also given in money, which people can feel', /of Bitcoin\)/.test(html));
  ok('the money figure is right', /\$20\.9\d/.test(html), (html.match(/[−+]\$[\d.]+/)||[])[0]);
  ok('holding is described in plain words', /HOLDING BITCOIN/.test(html));

  // Ladder driving instead.
  const ladder = { ...withFlip, liveFlip:{ tf:null }, sells:3, fills:2 };
  fn({ cipher_accum: ladder }, []);
  ok('with the flip off, the ladder is named', /pump ladder \(pump1\)/.test(html));
  ok('and the ladder\'s own counters are used', /sells <b>3<\/b>/.test(html));

  // In cash.
  const inCash = { ...withFlip, liveFlip:{ tf:'5m', holding:false, sells:11, trips:10 } };
  fn({ cipher_accum: inCash }, []);
  ok('being in cash is stated plainly', /IN CASH — WAITING TO BUY BACK/.test(html));
}

// ── THE PANEL CAN BE RIGHT AND STILL LIE (2026-08-21) ──────────────────────────────────────
// John reported two bugs this morning — "sells 0 / buy-backs 0" and "the timeframe toggles are
// gone" — and both had been fixed the day before. His browser was serving yesterday's index.html
// out of its cache. Every assertion above passed the whole time, because they test the file in
// the repo and he was not looking at the file in the repo. A panel that is correct in git and
// stale on the phone is still a panel that reports the wrong numbers.
console.log('\n7. The page can tell when it is out of date');
{
  ok('there is a build stamp to compare against', /const APP_BUILD = '[^']+'/.test(src));
  ok('the stamp is current, not left at an old release', !/const APP_BUILD = 'v3\.9/.test(src));
  ok('the page re-fetches its own source past the cache', /cache: 'no-store'/.test(src) && /checkForUpdate/.test(src));
  ok('it compares the published stamp with the running one',
     /const m = \/const APP_BUILD = '\(\[\^'\]\+\)'\/\.exec/.test(src) && /m\[1\] === APP_BUILD/.test(src));
  ok('it tells the user rather than silently showing old numbers', /This page is out of date/.test(src));
  ok('the reload defeats the cache with a fresh URL', /location\.replace\(location\.pathname \+ '\?v=' \+ Date\.now\(\)\)/.test(src));
  ok('it never reloads on its own — there is a Later button', /dismiss\.textContent = 'Later'/.test(src));
  ok('it re-checks when the tab comes back to the front', /visibilitychange/.test(src) && /if \(!document\.hidden\) checkForUpdate\(\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
