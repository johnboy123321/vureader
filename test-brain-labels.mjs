// THE TRAINING VOCABULARY IN THE APP BRAIN (2026-08-20)
// John: "input the brain pack in the app brain as well, just accumulating data, we might need it
// at some point." So: record labels now, wire them to nothing. The tests that matter most are the
// ones proving nothing is wired — an inert feature that quietly becomes live is the whole risk.
import fs from 'node:fs';
const app = fs.readFileSync('index.html', 'utf8');
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+x:'')));};

// Pull the brain block out and exercise the pure helpers against a stub localStorage.
const seg = app.slice(app.indexOf("const BRAIN_LS='mc_exec_brainlog'"), app.indexOf('function gateLive()'));
const vocabSrc = seg.slice(seg.indexOf('const BRAIN_VOCAB ='), seg.indexOf('const BRAIN_LEARNING_LABELS'));
const V = new Function(vocabSrc + '; return BRAIN_VOCAB;')();

console.log('\n  1. THE VOCABULARY IS CLOSED');
ok('six labelled axes', Object.keys(V).length===6, Object.keys(V).join(','));
ok('signal families present', V.signal_family.includes('rollover') && V.signal_family.includes('divergence'));
ok('entry states cover the question we are asking', ['early','fresh','late','chased'].every(x=>V.entry_state.includes(x)));
ok('risk states carry the cost-aware ones', V.risk_state.includes('stop_too_tight_for_costs'));
ok('pattern tags are present but bounded', V.pattern_tags.length>20 && V.pattern_tags.length<60, V.pattern_tags.length);
ok('the vocab is rendered into the prompt', /BRAIN_VOCAB_TEXT/.test(app));

console.log('\n  2. INVENTED LABELS ARE DROPPED, NOT STORED');
{
  const pickSrc = seg.slice(seg.indexOf('const pick=(field'), seg.indexOf('let labels=null;'));
  const f = new Function('BRAIN_VOCAB', vocabSrc.replace('const BRAIN_VOCAB =','var _unused =') + pickSrc + '; return {pick,pickMany};')(V);
  ok('a known value is kept', f.pick('entry_state','chased')==='chased');
  ok('case is normalised', f.pick('entry_state','CHASED')==='chased');
  ok('an invented value is dropped', f.pick('entry_state','vibes')==='');
  ok('a known tag is kept', f.pickMany('pattern_tags',['bull_flag'])[0]==='bull_flag');
  ok('invented tags are filtered out', f.pickMany('pattern_tags',['bull_flag','moon_pattern']).length===1);
  ok('tags are capped so one call cannot spam the record', f.pickMany('pattern_tags',new Array(30).fill('bull_flag')).length<=6);
  ok('non-arrays do not throw', Array.isArray(f.pickMany('pattern_tags','bull_flag')));
}

console.log('\n  3. NOTHING IS WIRED — the point of the exercise');
ok('the gate still reads only graded/brain/bot', /function gateLive\(\)\{[^}]*s\.graded>=BRAIN_PROMOTE_N && s\.brain>s\.bot/.test(app));
ok('gateLive never mentions labels', !/gateLive[\s\S]{0,300}labels/.test(app));
ok('brainScore never mentions labels', !/function brainScore\(\)\{[\s\S]{0,400}labels/.test(app));
ok('brainRight is still decided by the verdict alone', /e\.brainRight=\(brainSaidTake===won\)/.test(app));
ok('botRight is still decided by botTook alone', /e\.botRight=\(!!e\.botTook===won\)/.test(app));
ok('no label appears in an order-building path', !/buildOrder[\s\S]{0,1500}labels/.test(app));
ok('no label changes size', !/size[\s\S]{0,120}labels\./.test(app));
ok('the code says so out loud', /Wired to NOTHING/.test(app));
ok('and the readout says so to the user', /filters, scores, sizes, gates, promotes or demotes/.test(app));

console.log('\n  4. THE VERDICT SURVIVES A BAD LABEL BLOCK');
ok('labels are parsed in their own try/catch', /try\{ const L=v&&v\.labels;[\s\S]{0,900}\}catch\{ labels=null; \}/.test(app));
ok('labels are asked for AFTER the verdict fields', app.indexOf('"verdict":"TAKE"') < app.indexOf('"labels":{'));
ok('a missing label block stores null, not a crash', /let labels=null;/.test(app));
ok('max_tokens was raised to fit the extra fields', /max_tokens:300/.test(app));
ok('the brain is told the labels change nothing', /do not affect this trade, your verdict, sizing, or any rule/.test(app));
ok('and told to label what it sees', /Label what you SEE, not what you want the outcome to be/.test(app));

console.log('\n  5. THE OUTCOME LABEL, INCLUDING EXECUTION ARTIFACTS');
{
  const g = app.slice(app.indexOf('const noFill='), app.indexOf('dirty=true;', app.indexOf('const noFill=')));
  ok('a no-fill is an execution artifact', /noFill\|\|byHand\)\s*\?\s*'execution_artifact'/.test(g));
  ok('a hand-close is too', /byHand=!!\(t\.closedByHand\|\|t\.manualClose\)/.test(g));
  ok('a full stop-out is a clean loss', /R<=-0\.95\) \? 'clean_loss'/.test(g));
  ok('a partial loss is distinguished from a clean one', /'stopped_before_thesis'/.test(g));
  ok('unknowns admit it', /'insufficient_data'/.test(g));
  ok('it is assigned at grading, not at verdict time', app.indexOf('learning_label:null') < app.indexOf('e.learning_label ='));
}

console.log('\n  6. THE PILE IS COUNTABLE AND HONEST ABOUT ITS SIZE');
ok('a stats function exists', /function brainLabelStats\(\)/.test(app));
ok('it reports the sample, not just the counts', /labelled:withLabels\.length, graded:graded\.length/.test(app));
ok('it counts invented tags that were dropped', /dropped:withLabels\.reduce/.test(app));
ok('it states the bar for testability', /readyAt:60/.test(app));
ok('the report warns about small n', /60 per hypothesis before anything is testable/.test(app));
ok('both are reachable from the console', /brainLabelStats, brainLabelReport/.test(app));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
