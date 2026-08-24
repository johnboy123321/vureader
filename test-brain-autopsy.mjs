// The server-side brain (2026-08-19): it labels losses, clusters causes, and can never spend
// past its cap or reach the order path. No test here ever calls the real API.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
const out = path.join(process.cwd(), '.brain-under-test.mjs');
fs.writeFileSync(out, src.replace(/\n\/\/ ── Node \/ GitHub Actions entry point[\s\S]*$/, '\n') +
  '\nexport { buildAutopsyPrompt, parseAutopsy, brainBudget, vetoCandidates, AUTOPSY_CAUSES };\n');
const M = await import(pathToFileURL(out).href);
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+x:'')));};

console.log('\n1. The prompt is compact, complete, and demands the taxonomy');
{
  const p=M.buildAutopsyPrompt([{coin:'XRP',dir:'long',tf:'4H',note:'rollover on 4H',quality:5.5,rs:0.2,reg:'bear',regDist:-8,breadth:0.3,entry:3,stop:2.9,R:-1}]);
  ok('carries the trade fields', /XRP/.test(p) && /rollover/.test(p) && /-1/.test(p));
  ok('stop width is derived for the model', /3\.33/.test(p));
  ok('every cause id is offered', M.AUTOPSY_CAUSES.every(c=>p.includes(c)));
  ok('demands JSON only', /Reply ONLY a JSON array/.test(p));
  ok('one prompt stays small (~1k tokens for a full batch)',
     M.buildAutopsyPrompt(Array.from({length:8},(_,i)=>({coin:'C'+i,dir:'long',tf:'1D',entry:100,stop:95,R:-1}))).length < 4000);
}
console.log('\n2. The parser survives what models do to JSON');
{
  ok('clean JSON parses', M.parseAutopsy('[{"i":0,"c":"quiet-market","w":"atr tiny"}]',1).length===1);
  ok('prose and fences around it are ignored', M.parseAutopsy('Sure! Here:\n```json\n[{"i":0,"c":"late-fill","w":"x"}]\n```\nHope that helps',1)[0].c==='late-fill');
  ok('an invented cause becomes unknown, never a new category', M.parseAutopsy('[{"i":0,"c":"mercury-retrograde","w":"x"}]',1)[0].c==='unknown');
  ok('an out-of-range index is dropped', M.parseAutopsy('[{"i":7,"c":"quiet-market"}]',1).length===0);
  ok('garbage returns empty, never throws', M.parseAutopsy('the market was simply bad',1).length===0 && M.parseAutopsy(null,1).length===0);
  ok('runaway why-text is clipped', M.parseAutopsy(`[{"i":0,"c":"quiet-market","w":"${'x'.repeat(500)}"}]`,1)[0].w.length<=90);
}
console.log('\n3. The budget is a hard wall that resets daily');
{
  const slot={};
  const day1=Date.UTC(2026,7,19,10), day2=Date.UTC(2026,7,20,10);
  ok('fresh day starts under budget', M.brainBudget(slot,day1,null)===true && slot.spendUsd===0);
  M.brainBudget(slot,day1,{input_tokens:100000,output_tokens:30000});   // $0.10+$0.15=$0.25
  ok('spend is metered from real usage', slot.spendUsd===0.25 && slot.calls===1);
  ok('at the cap, the answer is NO', M.brainBudget(slot,day1,null)===false);
  ok('a new day resets the meter', M.brainBudget(slot,day2,null)===true && slot.spendUsd===0);
  const tiny={spendDay:'2026-08-19',spendUsd:0};
  M.brainBudget(tiny,day1,{input_tokens:700,output_tokens:250});
  ok('a typical call costs a fraction of a cent', tiny.spendUsd<0.01, tiny.spendUsd);
}
console.log('\n4. Veto candidates: persistence, not the circular "losses lose"');
{
  const rec=(cause,at)=>({arm:'baseline',R:-1,autopsy:cause,at});
  // quiet-market recurs across the whole timeline; late-fill clustered in one early burst
  const recs=[
    ...Array.from({length:6},(_,i)=>rec('quiet-market',i)),
    ...Array.from({length:6},(_,i)=>rec('quiet-market',100+i)),
    ...Array.from({length:10},(_,i)=>rec('late-fill',i)),
    ...Array.from({length:12},(_,i)=>rec('unknown',i*10)),
  ];
  const vc=M.vetoCandidates(recs);
  const quiet=vc.find(v=>v.cause==='quiet-market'), late=vc.find(v=>v.cause==='late-fill');
  ok('a recurring cause is a CANDIDATE', quiet && quiet.candidate===true, JSON.stringify(quiet));
  ok('a one-burst cause is reported but NOT a candidate', late && late.candidate===false, JSON.stringify(late));
  ok('unknown can never become a rule', !vc.find(v=>v.cause==='unknown'));
  ok('thin samples are never candidates', M.vetoCandidates([rec('regime-turn',1),rec('regime-turn',99)]).every(v=>!v.candidate));
  ok('ungraded and variant records are excluded',
     M.vetoCandidates([{arm:'variant',R:-1,autopsy:'quiet-market',at:1},{arm:'baseline',R:null,autopsy:'quiet-market',at:2}]).length===0);
}
console.log('\n5. The brain can never reach an order, a size, or a stop');
{
  // Slice to the section that actually FOLLOWS the brain module. The previous end marker moved
  // above this block in a 2026-08-19 reorder, which made indexOf return -1 and silently widened
  // the slice to the whole rest of the file. The length guard catches that class of mistake.
  const brainStart=src.indexOf('THE SERVER-SIDE BRAIN');
  const brainEnd=src.indexOf('Cause \u2192 veto candidate', brainStart);
  const block=src.slice(brainStart, brainEnd > brainStart ? brainEnd : undefined);
  ok('the brain slice is sane (guards against a reorder)', block.length > 500 && block.length < 12000, block.length);
  ok('the brain module exists', block.length>500);
  ok('no order function anywhere in it', !/execOrder|directOrder|buildOrder|cancelOrder|closeOrderFor|rememberResting/.test(block));
  const runBlock=src.slice(src.indexOf("THE BRAIN'S EYES"), src.indexOf('brain autopsy failed'));
  ok('the run-loop pass only stamps labels', !/execOrder|directOrder|buildOrder\(|planValid/.test(runBlock));
  // Wording changed 2026-08-24 when the brain stopped being welded to Anthropic — the PROPERTY is
  // the same and is what this asserts: no brain configured means silently off, with the backlog
  // stated and both ways of switching it on named.
  ok('no brain = silently off, with the backlog stated',
     /no brain configured/.test(runBlock) && /unread loss\(es\) waiting/.test(runBlock));
  ok('and the message says how to turn it on, either provider',
     /Set ANTHROPIC_API_KEY, or BRAIN_BASE_URL \+ BRAIN_API_KEY/.test(runBlock));
  ok('budget is checked BEFORE the call', runBlock.indexOf('brainBudget(bSlot, Date.now(), null)') < runBlock.indexOf('brainCall('));
  ok('one batched call per run, not one per loss', (runBlock.match(/brainCall\(/g)||[]).length===1);
  ok('candidates are logged as advisory', /must be written as a mechanical rule and win a shadow arm/.test(runBlock));
  ok('model and cap are configurable', /env\("BRAIN_MODEL", "claude-haiku-4-5"\)/.test(src) && /num\("BRAIN_DAILY_USD", 0\.25\)/.test(src));
  ok('the API call has a timeout', /AbortController/.test(block));
}
fs.unlinkSync(out);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
