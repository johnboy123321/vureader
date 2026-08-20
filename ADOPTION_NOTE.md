# What was adopted from these packs, and what was not — 2026-08-20

Decided with John and Codex. Recorded here so the reasoning survives the conversation.

## Adopted, live now

**The four-way split.** Every resolution now carries `how`, `outcome`, `klass`,
and `execution` instead of one blended verdict, in `classifyResolution`.

**`execution_artifact` as a class that counts toward nothing.** An order that was
rejected, a position closed by hand, a plan-less position, or a case where price
traded through both the stop and the target between two runs — all are recorded
in full and consumed by neither the circuit breaker nor the strategy record.
This fixed a live defect: hand-closing a winner and letting price slip under the
entry before the next run recorded a LOSS and moved the account a third of the
way to a twelve-hour pause.

**Range-based grading.** Resolutions are judged on the high/low the position
traded through since it was last seen, not on a snapshot up to forty minutes
stale. Where no range is available the old snapshot test is used and the result
is labelled `filled_snapshot_only` rather than passed off as equivalent.

**Three entry arms**, in `entryArmPlan` / `entryArmResolve`:
`immediate_marketable` (live baseline), `structure_retest` (expires),
`no_chase_filter` (records skips). Shadow only. Nothing filters, scores,
promotes, demotes or sizes.

**The promotion rules**, which already matched ours: 60 resolved per arm, both
halves the same sign, never promote on relative improvement alone.

## Not adopted, and why

**The full pattern taxonomy — roughly 50 tags across the two manifests.** Kept as
reference the brain may cite in notes, wired to nothing. Two reasons. There are
detectors for about five of them, so the rest would be labels with no data
behind them. And a large free vocabulary applied to a small sample is how a
system finds patterns that are not there.

**Eight entry arms and six exit arms.** This is arithmetic, not preference. The
bot resolves ~10.7 trades a day. At the packs' own 60-per-arm gate:

| arms | days to fill |
|---|---|
| 3 | 17 |
| 8 | 45 |
| 8 x 6 grid | 268 |

268 days is longer than the strategy will stay unchanged, which makes it a wish
rather than an experiment. Three arms answers the one question the record cannot
currently answer — are the losses from bad signals or late entries — in 17 days.

## What neither pack foregrounds, and should have

Cost. At this bot's trade frequency, costs decide outcomes more than signals do.
The 5m dot flip lost 3.75% of the stack in a day while the underlying signal was
roughly break-even; the difference was 22.7 trades a day at 20bps a round trip.
A brain diligently labelling `bull_flag` would have missed that entirely. Any
arm added later must carry its cost in the same table as its edge.
