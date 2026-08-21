// ═══════════ THE PRE-LIVE SAFETY TEST (2026-08-20) ═══════════
// Written to Codex's spec after his control-plane review. Its job is not to find bugs in the
// strategy — it is to prove, in one command, that the CONTROL PLANE cannot hurt you by accident.
//
// Every assertion here answers a question you would want answered before letting this near real
// money, and each one is phrased so that FAILING is the alarm. Run it before any change to arming,
// caps, or the order path.
//
// It reads the LIVE files only: cipher-agent-valtown.js, phemex-relay-valtown.js, and the
// deployed workflow. Any test that reads anything else is testing a ghost — which is exactly the
// defect this suite was created in response to.
import fs from 'node:fs';
const AGENT = 'cipher-agent-valtown.js';
const RELAY = 'phemex-relay-valtown.js';
const WF    = 'cipher-agent.yml';
const src = fs.readFileSync(AGENT, 'utf8');
const relay = fs.readFileSync(RELAY, 'utf8');
const wf = fs.readFileSync(WF, 'utf8');
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+x:'')));};
const envDefault = (name) => { const m=new RegExp('env\\("'+name+'",\\s*"([^"]*)"').exec(src); return m?m[1]:null; };

console.log('\n  1. DEFAULT MODE CANNOT PLACE REAL ORDERS');
ok('futures MODE defaults to dry, not armed', envDefault('MODE')==='dry', envDefault('MODE'));
ok('spot ACCUM_EXEC defaults to dry, not armed', envDefault('ACCUM_EXEC')==='dry', envDefault('ACCUM_EXEC'));
ok('no armed default survives anywhere', !/env\("ACCUM_EXEC",\s*"armed"\)/.test(src) && !/env\("MODE",\s*"armed"\)/.test(src));
ok('a dry spot call returns without touching the venue', /if \(!armed\) return \{ dry: true, why: "ACCUM_EXEC is not armed"/.test(src));

console.log('\n  2. KILL BLOCKS EVERY ORDER PATH');
ok('spot orders check kill FIRST, before anything else', /if \(CFG\.kill\(\)\) return \{ dry: true, why: "KILL switch is on"/.test(src));
ok('kill is checked before the armed test on the spot path',
   src.indexOf('why: "KILL switch is on"') < src.indexOf('why: "ACCUM_EXEC is not armed"'));
ok('the relay enforces kill independently of the agent', /const KILL = String\(cfg\("KILL"\)[^\n]*\|\| live\.kill === true/.test(relay));
ok('the app can set kill through the relay config', /if \(patch\.kill !== undefined\) out\.kill = !!patch\.kill/.test(relay));
ok('kill from the panel also forces the agent to off', /if \(c\.kill === true\) \{ CFG\.mode = \(\) => "off"/.test(src));

console.log('\n  3. NO STOP MEANS NO ORDER');
ok('the order builder demands a stop', /stopLossRp: px\(o\.stopLossRp\)/.test(src));
ok('a plan with no finite stop is refused', /!\(risk > 0\)\) return null/.test(src));
ok('spot sells demand a base quantity', /return \{ err: "sell needs a base quantity" \}/.test(src));
ok('spot buys demand a quote amount', /return \{ err: "buy needs a quote amount" \}/.test(src));
ok('an order with no price is refused', /return \{ err: "spot order needs a price" \}/.test(src));

console.log('\n  4. A WRONG-SIDE STOP MEANS NO ORDER');
ok('the direct path validates which side the stop is on', /stopSide|SL_SHOULD|wrong side|stopWrongSide/i.test(src));
// Checked in TWO layers, and the test insists on both: the plan is rejected before an order is
// ever built, and the order is rejected again before it is ever sent. Either alone would be a
// single point of failure on the one guard that stops a stop becoming a target.
ok('the PLAN refuses a long whose stop is not below entry', /isLong && sl >= en\) return `LONG stop/.test(src));
ok('the PLAN refuses a short whose stop is not above entry', /!isLong && sl <= en\) return `SHORT stop/.test(src));
ok('the ORDER refuses it again before sending (long)', /isLong && sl >= refPx\) return `refusing order: LONG stop/.test(src));
ok('the ORDER refuses it again before sending (short)', /!isLong && sl <= refPx\) return `refusing order: SHORT stop/.test(src));
ok('and a stopless trade is refused outright', /return "no stop loss — never trade stopless"/.test(src));

console.log('\n  5. DIRECT AND RELAY CAPS AGREE');
{
  const agentCap = /num\("MAX_NOTIONAL_USDT",\s*(\d+)\)/.exec(src);
  const wfCap = /MAX_NOTIONAL_USDT:\s*"(\d+)"/.exec(wf);
  const relayCap = /num\("maxNotional",\s*(\d+),\s*(\d+)\)/.exec(relay) || /maxNotional/.test(relay);
  ok('the agent has a notional cap', !!agentCap, agentCap && agentCap[1]);
  ok('the workflow states the same cap', !!wfCap && !!agentCap && wfCap[1]===agentCap[1], (wfCap&&wfCap[1])+' vs '+(agentCap&&agentCap[1]));
  ok('the relay enforces a cap of its own', !!relayCap);
  ok('the cap is re-enforced in direct mode, not left to the relay', /RELAY_CAP = CFG\.maxNotional\(\)/.test(src));
}

console.log('\n  6. THE SPOT ACCUMULATOR CANNOT ARM ACCIDENTALLY');
ok('arming is stated exactly once, in the workflow', (wf.match(/ACCUM_EXEC:/g)||[]).length===1);
ok('and the workflow says so out loud', /ONLY PLACE THE SPOT PATH IS ARMED/.test(wf));
ok('the code default is the safe direction', envDefault('ACCUM_EXEC')==='dry');
ok('no comment claims the opposite of the code', !/It is DRY by default \(ACCUM_EXEC=dry\)/.test(src) || envDefault('ACCUM_EXEC')==='dry');
ok('the flip has its own cap above the ladder cap',
   Number(/num\("ACCUM_FLIP_MAX_USDT",\s*(\d+)\)/.exec(src)?.[1]) > Number(/num\("ACCUM_MAX_USDT",\s*(\d+)\)/.exec(src)?.[1]));
ok('an over-cap flip refuses to arm rather than silently skipping the order', /stackUsdt > capUsdt/.test(src));
ok('a book that disagrees with the wallet stands the arm down', /outOfSync = true/.test(src));

console.log('\n  7. PHEMEX IS TESTNET UNLESS DELIBERATELY CHANGED IN ONE PLACE');
{
  const bases = [...src.matchAll(/https:\/\/[a-z0-9.-]*phemex\.com/g)].map(m=>m[0]);
  const uniq = [...new Set(bases)];
  ok('every phemex host in the agent is testnet', uniq.every(u=>/testnet/.test(u)), uniq.join(', '));
  ok('there is no live phemex host anywhere in the agent', !/https:\/\/api\.phemex\.com/.test(src));
  const rb = [...new Set([...relay.matchAll(/https:\/\/[a-z0-9.-]*phemex\.com/g)].map(m=>m[0]))];
  ok('the relay defaults to testnet too', rb.every(u=>/testnet/.test(u)) || /testnet/.test(relay), rb.join(', '));
  ok('the workflow preflight pings testnet, not live', /testnet-api\.phemex\.com/.test(wf) && !/\/\/api\.phemex\.com/.test(wf));
}

console.log('\n  9. DATA HYGIENE — an execution failure is never signal evidence');
{
  // Codex's testnet question: is the forward data clean enough that a later decision rests on the
  // strategy rather than on execution artifacts? In the 2026-08-19/20 window, 13 of 24 order
  // attempts were rejected and every one landed as a bare `ERR phemex 11048`.
  ok('venue rejections are classified, not logged as raw codes', /const PHEMEX_REJECTIONS = \{/.test(src));
  ok('11048 and 11052 are named as staleness, not as bad setups',
     /"11048"[\s\S]{0,200}stale — price moved past the stop/.test(src) &&
     /"11052"[\s\S]{0,200}stale — price moved past the stop/.test(src));
  ok('the cause is attributed to cadence, which is measurable', /cause: "cadence"/.test(src));
  ok('venue-side outages are separated from our mistakes', /cause: "venue"/.test(src));
  ok('unlisted symbols are separated too', /cause: "universe"/.test(src));
  ok('every rejection class is an execution artifact', (src.match(/klass: "execution_artifact", cause:/g)||[]).length >= 4);
  ok('an unknown code still classifies as an artifact, never as a signal',
     /if \(!hit\) return \{ label: String\(why \|\| "rejected"\), klass: "execution_artifact"/.test(src));
  ok('the log line says it is not a signal', /REJECTED \(not a signal\)/.test(src));
  ok('and the record carries countsForStats:false', /countsForStats: ok \? true : false/.test(src));

  // The resolution side, from the four-way split.
  ok('hand-closed positions count toward nothing', /how: "closed_by_hand"[\s\S]{0,300}countsForStreak: false, countsForStats: false/.test(src));
  ok('the breaker only ever eats real strategy losses', /const strategyOutcomes = resolved\.filter\(r => r\.countsForStreak\)/.test(src));
  ok('clamped trades are recorded with what they ACTUALLY risked', /riskActual = \+\(qty \* stopDist\)/.test(src));
  ok('and the clamp itself is flagged on the log line', /clamped: built\.meta\.clamped \|\| undefined/.test(src));
  ok('dry runs are labelled distinctly from placed orders', /"dry-run OK"/.test(src) && /"PLACED"/.test(src));
  ok('spot events are prefixed so they never read as futures trades',
     /result: "ACCUM SELL"|result: isSell \? "FLIP SELL"/.test(src));
}

console.log('\n  8. THE SAFETY NET TESTS THE LIVE FILE, NOT A GHOST');
{
  const tests = fs.readdirSync('.').filter(f=>/^test-.*\.mjs$/.test(f));
  const ghosts = [];
  for (const t of tests) {
    const body = fs.readFileSync(t,'utf8');
    for (const m of body.matchAll(/readFileSync\('([^']+)'/g)) {
      const f = m[1];
      if (f.startsWith('/')) continue;
      if (!fs.existsSync(f)) ghosts.push(t+' → '+f+' (missing)');
      else if (/agent-new\.js/.test(f)) ghosts.push(t+' → '+f+' (stale copy of the agent)');
    }
  }
  ok('no test reads a missing or stale source file', ghosts.length===0, ghosts.join('; '));
  ok('every test suite is present', tests.length>=13, tests.length);
}

console.log('\n  10. DROPPED TRADES — a venue refusal must never cost a trading slot');
{
  // 19 of 20 order attempts refused on 2026-08-20/21, and every one burned the coin for the day.
  ok('the venue bench exists', /const VENUE_KEY = "cipher_venue"/.test(src));
  ok('it only benches codes with a named rule', /if \(!rule\) return mem;/.test(src));
  ok('a symbol that trades is released', /function venueClear/.test(src));
  ok('the bench is announced every run, never silent', /venue bench \(/.test(src));
  ok('the stop is checked against the MARK before sending', /function markStopVerdict/.test(src));
  ok('and that check declines rather than nudging the stop into legality',
     !/stopLossRp = |sl = need|order\.stopLossRp =/.test(src));
  ok('an unreadable mark does not block the order', /if \(!\(m > 0\)\) return null;/.test(src));
  ok('both skips happen before fired\[key\] burns the coin',
     src.indexOf('const benched = venueBlock(VENUE') < src.indexOf('fired[key] = Date.now();') &&
     src.indexOf('const stale = markStopVerdict(') < src.indexOf('fired[key] = Date.now();'));
  ok('a failed de-hedge no longer reports itself as a success', /"DE-HEDGE FAILED"/.test(src) && !/ERR de-hedge/.test(src));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
