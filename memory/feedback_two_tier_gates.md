---
name: feedback-two-tier-gates
description: Run the fast gates while iterating and the full set once before committing — measured 10.1 gate runs per commit, ~3x more than the work needed.
metadata:
  node_type: memory
  type: feedback
  modified: 2026-09-16
---

Split tison's gates into two tiers instead of running all of them after every edit.

**While iterating on a fix:** `test/test-towasm.ts` (or `test-checker.ts`, whichever the change
touches) and `assistant/parse-one.ts` on any surveyed file that was edited. Both are fast and catch
the ordinary mistakes.

**Once, immediately before the commit:** the rest — `test-checker.ts`, `difftest.sh`, `corpus-ab.sh`
when the change touches checker.ts / type-utils.ts / transform.ts / lib/, and `selfhost-survey.sh`
to record the cause-table delta the fix produced.

**Why:** measured over 8 sessions (2026-09-16), 2353 gate runs against 233 commits — 10.1 per commit
(towasm 683, survey 684, difftest 494, corpus 275, checker 217). The survey is the work queue: one
run per landed fix is what the delta means, and 684 runs for 233 commits is ~3x that. Re-running the
slow gates mid-iteration cannot tell you anything the fast ones didn't, because nothing has been
decided yet — it just resends their output into context, and context resent per turn is what
actually dominates token cost.

**TRAP — `test/test-towasm.ts` AND `test/test-checker.ts` import from `dist/`, not `src/`.** Editing `src/examples/TS/*.ts` and
running either measures the PREVIOUS build. An in-place A/B toggle needs `npm run examples` on EACH side (2026-09-19: three
"the test passes without the fix" runs were all measuring the same build). Always `npm run examples` first. This is not
theoretical: `tsc -b src/examples` (stricter than the root `tsc -p`, which is what `dist/` is built
with) silently stopped emitting on an error introduced in `540e0ed`, and the towasm gate then ran
against pre-fix code for many commits until `7d8a74c` fixed it on 2026-09-16. A build error there is
easy to miss because the root typecheck stays green.

**How to apply:** don't re-run a gate to confirm a result it already gave for the same tree state.
`git commit` failing is loud; so is a red gate. The one case that justifies an extra full run is a
gate that was green before an edit and is expected to change because of it.

Related: [[tison-towasm-self-hosting-plan]], [[feedback-towasm-symbol-index]].
