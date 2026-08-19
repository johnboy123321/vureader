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
fn({ cipher_accum: { units:1.0123, cash:0, open:[], sells:3, fills:12, startedAt:'2026-08-19', pxNow:64000 } }, []);
ok('state reads FULLY HOLDING', /FULLY HOLDING/.test(html));
ok('shows the unit count', /1\.01230 BTC/.test(html));
ok('shows the gain vs hold', /\+1\.23%/.test(html), html.match(/[+-][\d.]+%/));
ok('names the benchmark', /1\.00000/.test(html));

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
fn({ cipher_accum: { units:0.94, cash:0, open:[], sells:9, fills:20, startedAt:'2026-01-01', pxNow:64000 } }, []);
ok('shows a negative number, not a spun one', /-6\.00%/.test(html), html.match(/[+-][\d.]+%/));

console.log('\n5. Junk state does not crash the panel');
fn({ cipher_accum: { units:null, cash:null, open:null, pxNow:0 } }, null);
ok('renders something rather than throwing', typeof html === 'string' && html.length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
