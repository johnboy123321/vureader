// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  THE SETUP SCHEMA — what the brain is allowed to say
//
//  John: "maybe it starts to learn itself, and find setups that we can store and back test… use a
//  head and shoulders with some of the VuManChu waves, or some other setup."
//
//  The whole idea turns on one decision: the brain proposes a RULE, not a trade. "Buy XRP at 1.10"
//  can only be graded by waiting. "Inverse head and shoulders, with WaveTrend crossing up below
//  −53 on 4H, stop under the right shoulder, target 2R" can be replayed across twelve coins and
//  three years in about ninety seconds. Same brain, same intelligence — but one of them accumulates
//  evidence while you make a cup of tea and the other one takes six months.
//
//  ── WHY A VOCABULARY AND NOT CODE ─────────────────────────────────────────────────────────────
//  The obvious implementation is to let the model write JavaScript and eval it. That is a remote
//  code execution hole with extra steps, and it also fails quietly: a model that writes almost-
//  right code produces a rule that runs and means something slightly different from what it said.
//
//  So a setup is DATA. Every condition is a name from the table below plus arguments, looked up in
//  a fixed function table. Nothing is evaluated. A term the model invents does not silently do
//  nothing — it is REJECTED, by name, with the list of what was available, which is the feedback
//  the model needs to write a better one next time.
//
//  ── THE ONE RULE ABOUT REJECTION ──────────────────────────────────────────────────────────────
//  Reject loudly, never repair. If a proposal is nearly valid it is tempting to fix it up and run
//  it — and then the thing being tested is not the thing that was proposed, and the record is
//  quietly about a strategy nobody wrote. Every rejection names the field and the reason.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// ── CONDITIONS ────────────────────────────────────────────────────────────────────────────────
// `args` documents what each takes. `needs` is the minimum bars of history before it can answer,
// so the engine can refuse to evaluate a rule too early rather than reading NaN as false.
export const CONDITIONS = {
  // WaveTrend — the VuManChu engine already in the agent, same settings.
  wtCrossUp:      { args: [],                 needs: 80, doc: "wt1 crosses up through wt2 on this bar (the green dot)" },
  wtCrossDown:    { args: [],                 needs: 80, doc: "wt1 crosses down through wt2 on this bar (the red dot)" },
  wt2Below:       { args: ["value"],          needs: 80, doc: "wt2 is below a level, e.g. -53 for the oversold band" },
  wt2Above:       { args: ["value"],          needs: 80, doc: "wt2 is above a level, e.g. 53 for the overbought band" },
  wtRising:       { args: ["bars"],           needs: 80, doc: "wt1 has risen for N consecutive bars" },
  wtFalling:      { args: ["bars"],           needs: 80, doc: "wt1 has fallen for N consecutive bars" },

  // Money flow — computed by the agent today and used by nothing. Tested 2026-08-24: a flip on its
  // own has no predictive power (1.02x the base rate, 0.7% recall). Exposed anyway, because as a
  // FILTER alongside something else it has never been tested, and that is a different question.
  mfPositive:     { args: [],                 needs: 80, doc: "money flow above zero (the green band)" },
  mfNegative:     { args: [],                 needs: 80, doc: "money flow below zero (the red band)" },
  mfFlippedUp:    { args: ["within"],         needs: 80, doc: "money flow crossed up through zero within N bars" },
  mfFlippedDown:  { args: ["within"],         needs: 80, doc: "money flow crossed down through zero within N bars" },

  rsiBelow:       { args: ["value", "period"], needs: 40, doc: "RSI under a level" },
  rsiAbove:       { args: ["value", "period"], needs: 40, doc: "RSI over a level" },

  aboveSma:       { args: ["period"],         needs: 220, doc: "close above its N-bar simple average" },
  belowSma:       { args: ["period"],         needs: 220, doc: "close below its N-bar simple average" },

  // Volatility, as a percentage of price — the honest way to compare a coin at 0.50 with one at
  // 78,000. Useful as a gate: the 2.2% cost floor makes low-ATR setups untradeable whatever they
  // look like, so a rule can simply refuse to fire there.
  atrPctAbove:    { args: ["value"],          needs: 40, doc: "ATR(14) is more than N% of price" },
  atrPctBelow:    { args: ["value"],          needs: 40, doc: "ATR(14) is less than N% of price" },

  // Structure and classical patterns, all built from confirmed pivots — never from the bar being
  // decided on. See engine.mjs for why that distinction is the whole ballgame.
  pattern:        { args: ["name", "within"], needs: 120,
                    doc: "a completed chart pattern within N bars: invHeadShoulders, headShoulders, doubleBottom, doubleTop" },
  pivotLow:       { args: ["within"],         needs: 60, doc: "a confirmed swing low within N bars" },
  pivotHigh:      { args: ["within"],         needs: 60, doc: "a confirmed swing high within N bars" },
  higherHigh:     { args: [],                 needs: 60, doc: "market structure is making higher highs" },
  lowerLow:       { args: [],                 needs: 60, doc: "market structure is making lower lows" },
  bullFvg:        { args: ["within"],         needs: 60, doc: "an unfilled bullish fair value gap within N bars" },
  bearFvg:        { args: ["within"],         needs: 60, doc: "an unfilled bearish fair value gap within N bars" },

  // Multi-timeframe. The higher timeframe is aggregated from the bars being tested, never fetched
  // separately, so there is no possibility of the two series disagreeing about what time it is.
  htf:            { args: ["mult", "cond"],   needs: 240,
                    doc: "a condition true on a higher timeframe built by aggregating N bars, e.g. mult 6 turns 4H into 1D" },
};

export const PATTERNS = ["invHeadShoulders", "headShoulders", "doubleBottom", "doubleTop"];

// ── STOPS ─────────────────────────────────────────────────────────────────────────────────────
// A setup without a stop cannot be graded, and ungraded is what has already eaten 83% of the live
// record. So the stop is REQUIRED and it must be one of these — every one of them a level that
// exists on the chart, not a number the model liked the look of.
export const STOPS = {
  swing:      { args: ["lookback", "padAtr"], doc: "beyond the highest high / lowest low of the last N bars, padded by N × ATR" },
  atr:        { args: ["mult"],               doc: "N × ATR(14) from entry" },
  percent:    { args: ["value"],              doc: "a fixed percentage from entry" },
  pattern:    { args: ["padAtr"],             doc: "beyond the pattern that triggered it — the right shoulder, or the second low" },
};

// The target is always in R. A target in percent cannot be compared across coins, and a record you
// cannot add up is a record you cannot learn from.
export const TARGETS = { rMultiple: { args: ["value"], doc: "N × the risk taken" } };

export const TIMEFRAMES = ["1D", "4H", "1H"];

// ── THE VALIDATOR ─────────────────────────────────────────────────────────────────────────────
const isNum = v => typeof v === "number" && Number.isFinite(v);

function checkCond(c, path, errs, depth = 0) {
  if (!c || typeof c !== "object" || Array.isArray(c)) { errs.push(`${path}: each condition must be an object like {"fn":"wtCrossUp"}`); return; }
  const spec = CONDITIONS[c.fn];
  if (!spec) {
    errs.push(`${path}: unknown condition "${c.fn}". Available: ${Object.keys(CONDITIONS).join(", ")}`);
    return;
  }
  for (const a of spec.args) {
    if (a === "cond") continue;                                    // checked below, recursively
    if (a === "name") {
      if (!PATTERNS.includes(c.name)) errs.push(`${path}.name: unknown pattern "${c.name}". Available: ${PATTERNS.join(", ")}`);
      continue;
    }
    if (a === "period" && c[a] === undefined) continue;            // has a sensible default
    if (!isNum(c[a])) errs.push(`${path}.${a}: "${c.fn}" needs a number for "${a}" (${spec.doc})`);
  }
  for (const k of ["within", "bars", "lookback", "mult", "period"])
    if (c[k] !== undefined && (!isNum(c[k]) || c[k] < 1 || c[k] > 400))
      errs.push(`${path}.${k}: must be a number between 1 and 400, got ${JSON.stringify(c[k])}`);
  if (c.fn === "htf") {
    if (depth >= 1) { errs.push(`${path}: htf cannot be nested inside another htf`); return; }
    checkCond(c.cond, `${path}.cond`, errs, depth + 1);
  }
}

// Returns { ok, errors, rule }. On failure `errors` is written FOR THE MODEL — each line names the
// field and what was expected, so a rejection is a usable instruction rather than a shrug.
export function validateSetup(raw) {
  const errs = [];
  let r = raw;
  if (typeof raw === "string") {
    try { r = JSON.parse(raw); } catch (e) { return { ok: false, errors: [`not valid JSON: ${e.message}`], rule: null }; }
  }
  if (!r || typeof r !== "object") return { ok: false, errors: ["the setup must be a JSON object"], rule: null };

  if (typeof r.name !== "string" || !/^[a-zA-Z0-9 _-]{3,60}$/.test(r.name))
    errs.push('name: 3–60 characters, letters/numbers/spaces/dashes only');
  if (r.dir !== "long" && r.dir !== "short") errs.push('dir: must be "long" or "short"');
  if (!TIMEFRAMES.includes(r.timeframe)) errs.push(`timeframe: must be one of ${TIMEFRAMES.join(", ")}`);

  if (!Array.isArray(r.when) || !r.when.length) errs.push('when: needs at least one condition');
  else if (r.when.length > 6) errs.push(`when: at most 6 conditions — ${r.when.length} is a rule fitted to the past, not a setup`);
  else r.when.forEach((c, i) => checkCond(c, `when[${i}]`, errs));

  const s = r.stop;
  if (!s || typeof s !== "object") errs.push('stop: required — a setup with no stop cannot be graded, and ungraded means it never happened');
  else if (!STOPS[s.kind]) errs.push(`stop.kind: unknown "${s.kind}". Available: ${Object.keys(STOPS).join(", ")}`);
  else for (const a of STOPS[s.kind].args) {
    if (a === "padAtr" && s[a] === undefined) continue;             // defaults to 0
    if (!isNum(s[a])) errs.push(`stop.${a}: "${s.kind}" needs a number for "${a}" (${STOPS[s.kind].doc})`);
  }

  const t = r.target;
  if (!t || typeof t !== "object") errs.push('target: required, e.g. {"kind":"rMultiple","value":2}');
  else if (!TARGETS[t.kind]) errs.push(`target.kind: unknown "${t.kind}". Available: ${Object.keys(TARGETS).join(", ")}`);
  else if (!isNum(t.value) || t.value < 0.5 || t.value > 10)
    errs.push('target.value: an R multiple between 0.5 and 10');

  // A falsifier is not decoration. A model asked only to justify itself will justify anything —
  // that is exactly how a shape on one XRP chart becomes a strategy. Making it name the thing that
  // would prove it wrong costs one field and changes what it writes.
  if (typeof r.falsifier !== "string" || r.falsifier.trim().length < 15)
    errs.push('falsifier: one sentence naming what would show this setup does NOT work');

  if (r.maxBars !== undefined && (!isNum(r.maxBars) || r.maxBars < 5 || r.maxBars > 200))
    errs.push('maxBars: how long to give the trade before abandoning it, 5–200');

  return errs.length ? { ok: false, errors: errs, rule: null }
                     : { ok: true, errors: [], rule: { maxBars: 60, ...r } };
}

// A compact description of the vocabulary, to paste into the brain's prompt. Generated from the
// tables above so the prompt can never drift out of step with what the validator accepts — a
// documented option the code rejects is worse than no documentation.
export function vocabularyForPrompt() {
  const L = [];
  L.push("CONDITIONS (use in `when`):");
  for (const [k, v] of Object.entries(CONDITIONS))
    L.push(`  ${k}(${v.args.join(", ")}) — ${v.doc}`);
  L.push(`PATTERNS (for pattern.name): ${PATTERNS.join(", ")}`);
  L.push("STOPS (use in `stop`):");
  for (const [k, v] of Object.entries(STOPS)) L.push(`  ${k}(${v.args.join(", ")}) — ${v.doc}`);
  L.push('TARGET: {"kind":"rMultiple","value":N} — N times the risk.');
  L.push(`TIMEFRAMES: ${TIMEFRAMES.join(", ")}`);
  return L.join("\n");
}
