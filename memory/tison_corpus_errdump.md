---
name: tison-corpus-errdump
description: "assistant/corpus-errdump.ts dumps PER-ERROR corpus detail so a checker change's ERROR delta can be attributed to real files; corpus-ab.sh only gives the totals."
metadata:
  node_type: memory
  type: project
  originSessionId: b3f17fe0-e4c2-48e4-8dae-3996e8d1069c
  modified: 2026-09-07T20:50:23.882Z
---

`assistant/corpus-ab.sh` reports `tested/threw/GAP/WARNING/ERROR` totals across a commit boundary and
nothing else, so "ERROR +6" tells you a checker change regressed something but not what. Written
2026-09-07: **`assistant/corpus-errdump.ts`** runs the same official-TS-corpus walk and prints one
`file<TAB>line:col<TAB>message` line per ERROR.

2026-09-09: restricted to the **tsc-clean bucket** (tests with no `.errors.txt` baseline) — every
line is now a real false positive, not a diagnostic we happen to disagree with tsc about. See
[[tison-official-ts-test-suite]] for the bucketing. `test-ts-official.ts` itself now dumps this list
to `assistant/corpus-false-positives.txt` on every run, so a separate errdump A/B is only needed for
line/col/message-level attribution.

```
node ./node_modules/.bin/ts-node -T --compilerOptions '{"module":"commonjs","target":"es2022","rootDir":".","ignoreDeprecations":"6.0"}' \
    assistant/corpus-errdump.ts > assistant/errdump-head.txt
diff <(sort assistant/errdump-base.txt) <(sort assistant/errdump-head.txt)
```

Baseline side: `git -C tison worktree add tison/assistant/base-wt HEAD`, symlink
`packages/node_modules` into it, then run a copy of the script with its `../tison/` imports rewritten
to `../tison/assistant/base-wt/`. ~4 min a side; run both in the background. **Remove the worktree
when done** (`git -C tison worktree remove ... --force && worktree prune`) or the survey walks it.

Two things that make the diff readable:
- Redirect stderr to a **separate** file. Merging it in puts parse-failure noise into the diff.
- Some messages are multi-line (a big structural type), so a diff hunk can show stray fragment lines;
  match on the `tests/cases/...` lines, not the count.

This is what proved the array/interface work landed at **exactly** base — 6035 ERROR lines both
sides, zero added, zero lost — after two intermediate versions each traded one false positive for one
lost true positive. Neither trade was visible in the totals, which read "+1".

Related: [[tison-official-ts-test-suite]] (the harness this reuses), [[tison-conformance-sweeps]].
