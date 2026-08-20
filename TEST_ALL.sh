#!/usr/bin/env bash
# One command, whole safety net. The preflight runs FIRST and hard-stops the rest if it fails —
# a control-plane fault makes every strategy result below it meaningless.
set -o pipefail
cd "$(dirname "$0")"
echo "══ PRE-LIVE SAFETY (control plane) ══"
node test-preflight-safety.mjs || { echo; echo "PREFLIGHT FAILED — stopping. Fix the control plane before reading anything else."; exit 1; }
tot=0; bad=0
for t in test-*.mjs; do
  [ "$t" = "test-preflight-safety.mjs" ] && continue
  out=$(node "$t" 2>&1); line=$(echo "$out" | grep -E '[0-9]+ passed' | tail -1)
  n=$(echo "$line" | grep -oE '^[[:space:]]*[0-9]+' | tr -d ' '); f=$(echo "$line" | grep -oE '[0-9]+ failed' | grep -oE '^[0-9]+')
  tot=$((tot + ${n:-0})); bad=$((bad + ${f:-0}))
  printf "  %-28s %s\n" "$t" "${line:-NO RESULT}"
  [ "${f:-0}" != "0" ] && echo "$out" | grep FAIL
done
echo; echo "  TOTAL: $tot assertions, $bad failed"
exit $([ "$bad" = "0" ] && echo 0 || echo 1)
