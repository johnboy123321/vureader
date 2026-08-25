// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE BRAIN MUST NOT BE WELDED TO ONE PROVIDER (2026-08-24)
//
//  John had no Claude credits, and the brain was hardcoded to api.anthropic.com — so an advisory
//  component that "can never place, size or block an order" was nonetheless able to hold the whole
//  feature hostage over billing.
//
//  The subtle half is the spend meter. The daily cap counts input_tokens/output_tokens; an
//  OpenAI-shaped reply calls them prompt_tokens/completion_tokens. Left untranslated the meter
//  reads zero on every call and the cap never engages — a budget that has silently stopped
//  counting, which still looks like protection. That is what §3 is for.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
const src = fs.readFileSync('cipher-agent-valtown.js','utf8');
let pass=0, fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(x!==undefined?' → '+String(x).slice(0,140):'')));};

console.log('\n1. A provider is chosen, not assumed');
ok('there is a brainProvider()', /function brainProvider\(\)/.test(src));
ok('an OpenAI-compatible base URL is honoured', /BRAIN_BASE_URL/.test(src));
ok('a separate key var exists, falling back to the Anthropic one so nothing breaks',
   /env\("BRAIN_API_KEY", ""\) \|\| env\("ANTHROPIC_API_KEY", ""\)/.test(src));
ok('no key at all means no brain, as before', /if \(!key\) return null;/.test(src));
ok('the default path is still Anthropic, unchanged',
   /if \(!base\) return \{ kind: "anthropic", url: "https:\/\/api\.anthropic\.com\/v1\/messages"/.test(src));
ok('a trailing slash on the base URL cannot produce a double slash', /replace\(\/\\\\\/\+\$\/, ""\)/.test(src) || /replace\(\/\\\/\+\$\/, ""\)/.test(src));

console.log('\n2. Both wire formats are handled');
ok('Anthropic uses x-api-key', /"x-api-key": p\.key/.test(src));
ok('the other uses a bearer token', /"authorization": "Bearer " \+ p\.key/.test(src));
ok('and the reply is read from the right place in each shape',
   /j\.content && j\.content\[0\] && j\.content\[0\]\.text/.test(src) &&
   /j\.choices && j\.choices\[0\] && j\.choices\[0\]\.message/.test(src));
ok('an error is reported with its message, not a bare status',
   /brain call refused \(\$\{p\.kind\}\)/.test(src));

console.log('\n3. The spend cap still counts — the easy thing to get wrong');
ok('usage is normalised at the boundary',
   /input_tokens: u\.prompt_tokens \|\| 0, output_tokens: u\.completion_tokens \|\| 0/.test(src));
ok('the budget still reads the Anthropic field names, which is why the translation is needed',
   /usage\.input_tokens \|\| 0/.test(src) && /usage\.output_tokens \|\| 0/.test(src));
ok('and the daily cap is still enforced', /< num\("BRAIN_DAILY_USD", 0\.25\)/.test(src));

console.log('\n4. Every gate asks "is a brain configured", not "is there an Anthropic key"');
{
  // A gate left checking the old variable would keep a feature dark for anyone on another
  // provider — off, with no error, which is the worst way for a feature to be missing.
  const gates = src.match(/env\("ANTHROPIC_API_KEY", ""\)/g) || [];
  ok('the only remaining ANTHROPIC_API_KEY read is inside brainProvider itself',
     gates.length === 1, `${gates.length} reads`);
  ok('the accumulator review gates on the provider', /if \(brainProvider\(\) && due/.test(src));
  ok('the loser autopsy gates on the provider', /if \(!brainProvider\(\)\) \{/.test(src));
  ok('and the "brain is off" message names both ways to switch it on',
     /Set ANTHROPIC_API_KEY, or BRAIN_BASE_URL \+ BRAIN_API_KEY/.test(src));
}

console.log('\n5. Nothing about the brain gained any power');
ok('it still cannot place an order — no order call anywhere near brainCall',
   !/brainCall[\s\S]{0,2000}sendSpotOrder/.test(src));
ok('the key is never logged', !/console\.log\([^)]*p\.key/.test(src) && !/console\.error\([^)]*p\.key/.test(src));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
