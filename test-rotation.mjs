// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE ROTATION MUST NOT ORPHAN COINS (2026-08-24)
//
//  John: "coins are pumping and dumping all the time, why are we not bagging them?"
//  Part of the answer was that a third of the universe was never scanned. Not rarely — never.
//  The cursor advanced by the batch size before the scan ran, and the scan stopped early on its
//  time budget, so the tail of every batch was skipped at a fixed stride: the same positions,
//  every run, for ever.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+String(x).slice(0,140):'')));};

console.log('\n1. The cursor follows the scan instead of leading it');
ok('it is no longer advanced before the loop',
   !/await setJSON\(KEY\.cursor, \(cursor \+ batch\) % uni\.length\);/.test(src));
ok('it is advanced by what was actually reached',
   /await setJSON\(KEY\.cursor, \(cursor \+ Math\.max\(1, consumed\)\) % uni\.length\);/.test(src));
ok('and never by zero, or a stalled run would freeze the rotation on one coin',
   /Math\.max\(1, consumed\)/.test(src));
ok('every position in the slice counts, even one skipped for not being crypto',
   /consumed\+\+;\n    if \(!coin \|\| NOT_CRYPTO\.test\(coin\)\) continue;/.test(src));
ok('the early stop says how far it got', /time budget reached — stopping early after \$\{consumed\}/.test(src));

console.log('\n2. And the arithmetic actually covers the universe');
{
  // The bug, reproduced, then the fix — same numbers, so the test states the problem rather than
  // just asserting the patch is present.
  const sweep = (advanceByBatch) => {
    const UNI=60, BATCH=20, REACH=13; let cur=0; const seen=new Set();
    for (let r=0;r<400;r++){
      for(let i=0;i<REACH;i++) seen.add((cur+i)%UNI);
      cur=(cur+(advanceByBatch?BATCH:REACH))%UNI;
    }
    return seen.size;
  };
  ok('the OLD behaviour left 21 of 60 coins unreachable', sweep(true) === 39, sweep(true));
  ok('the NEW behaviour reaches every coin in the universe', sweep(false) === 60, sweep(false));
}

console.log('\n3. A failed plan says WHICH failure it was');
ok('the single catch-all sentence is gone',
   !/skipped: "could not build a trade plan"/.test(src));
ok('no candles at all is named as such', /no \$\{sig\.planTf \|\| "1D"\} candles came back/.test(src));
ok('too few candles is a different message', /only \$\{nb\} \$\{sig\.planTf \|\| "1D"\} candles came back/.test(src));
ok('and a genuine 3-ATR refusal is a third', /more than 3× ATR away/.test(src));
ok('the bar count goes on the record so this never needs guessing again',
   /planTf: sig\.planTf \|\| "1D", bars: nb/.test(src));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
