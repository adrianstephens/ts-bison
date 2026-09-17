---
name: tison-harness-portability
description: what a DIFFERENT agent harness needs in order to work in tison safely — cwd, gate order, the acceptance numbers, which instruments gate by exit code, and what does not travel
metadata:
  type: project
---

Written 2026-09-16 for a move to a different agent harness.

**What already travels.** All durable context is plain files in the repo:
`memory/MEMORY.md` -> this project's `memory/*.md` -> [[tison-session-handoff]] -> the plans. There is no
harness-specific state anywhere. The session transcript does NOT travel (assistant responses are clipped at
5,000 chars in the local session store, and tool results are not stored at all — see the `tison`
conversation's own measurement), which is why findings here are written to `memory/` rather than left in
chat. Resuming a session restores the *thread*, never the *evidence*.

**Acceptance run for a new harness** — should reproduce exactly, at `ec2a21f`:

| command | expected |
|---|---|
| `npm run examples` (`tsc -b src/examples`) | clean |
| `npx ts-node -T test/test-towasm.ts` | all green (915 checks) |
| `bash tison/assistant/difftest.sh` | 2182/2191 agree · 0 disagree · 9 unsupported |

Run everything from the WORKSPACE ROOT (`/Volumes/DevSSD/dev/packages`) — that is where `node_modules` lives.
Every instrument `cd`s there itself, but `npx`/`ts-node` resolution still needs it.

**Which instruments gate by EXIT CODE, and which must be READ** (verified 2026-09-16 — an earlier claim the
same day that they all "pass silently" was wrong, and came from grepping for a literal `exit 1`, which a
script that delegates does not contain):

- `difftest.sh` — **gates**. It `exec`s `difftest.ts`, which ends `process.exit(wrong.length ? 1 : 0)`, so
  the status propagates. Non-zero means wasm and TypeScript disagreed.
- `vsdg-check.sh` — **gates**. Ends `exit $failures`, counting each failed suite.
- `selfhost-survey.sh` — a **PROBE, not a gate**. Its output is a table; it should exit non-zero only if it
  crashes. A harness must READ it, never treat it as pass/fail.
- `ast-gate.sh`, `corpus-ab.sh`, `anyleak-probe.sh`, `self-errors.sh` — check each before relying on its
  status; the two that matter most are the ones above.

**Facts that were load-bearing here, in case a new harness trips on them:**

- `npm run examples` MUST precede `test-towasm.ts` — the suite reads `dist/`, so a stale build silently
  tests old code.
- `selfhost-survey.sh` takes ~10 minutes: run it in the background as one job, and never with an A/B toggle
  left in a surveyed file (`towasm.ts` is itself a target). It prints its own warning when the tree is dirty.
- The survey was NONDETERMINISTIC before `935a4e1` (import-cycle race) — re-run a probe 3-5x before trusting
  a delta, and read the MOVED/REGRESSED lines rather than the flat total.
- `test-towasm.ts` runs under `ts-node -T` (transpile-only), so it does NOT type-check: it will pass while
  `tsc` fails. Both gates are needed; neither substitutes for the other.
- Verify every write actually landed (grep after the edit). An edit tool can report success without writing.

Related: [[tison-session-handoff]], [[feedback-two-tier-gates]], [[tison-towasm-self-hosting-plan]].
