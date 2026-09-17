---
name: tison-session-handoff
description: LIVE cold-start state for the self-hosting work — where the row stands, what is deliberately unfixed, what the user has not decided. Read this before the 2233-line plan.
metadata:
  node_type: memory
  type: project
  modified: 2026-09-17
---

**Read this first, and usually instead of [[tison-towasm-self-hosting-plan]]** (2233 lines — open it
only when you need the accumulated history of a specific row). This file is the live state and
nothing else: it is rewritten wholesale, not appended to.

## As of 2026-09-17 (evening)

**HEAD `bce6f7d` — "pull the neutral half out of towasm.ts, in measured steps".** The extraction is under
way by a repeatable method rather than by hand, and the neutral half now has real homes:
`wasm-types.ts` (vocabulary, `TSWError`/`withCatch*`, `Local`/`ClosureEnv`/`FinallyGuard`, the
`FunctionContext` base, `Types` (the type section), `ClassInfo` (a class), `wantedShape`,
`mentionsTypeIndex`, `ownerThisType`), `wasm-asm.ts` (the island), `type-utils.ts` (the TS type model — 26
declarations moved in), and `towasm.ts` = the TypeScript-specific codegen (10,001 lines; wasm-types 532,
type-utils 3,839).

**The method, which is the thing to reuse:** `assistant/towasm-hoist-survey.ts` resolves every identifier
with the checker, so "does this need the scope?" is answered by the binding, not by a name. `--module`
classifies module-level declarations by their externals with a transitive fixed point (a declaration moves
only with everything it leans on), `--move --write` relocates to `type-utils.ts`, and `--dump`/`--apply`
does the `TStoWasm`-child hoist (41 of 209 functions needed nothing and moved; a second pass found 0 more).
`assistant/towasm-comment-pass.js` is the comment tool (449 blocks >2 lines -> 274, with a printer-based
code-identity gate).

**Shape facts that are structural, not stylistic:** `declScope?: Scope` can never be neutral (`Scope` is
type-utils', and type-utils imports wasm-types); a language subtype must RE-NARROW a base's recursive member
(`declare superClass?: ClassInfo`) or every chain walk degrades to the base — and `declare` is required,
because a plain (or `!`) field definition emits after `super()` and clobbers what the base constructor
assigned (verified; TS2612 names it); `typeIndex: -1` on `ClassInfo` is a real state (a class whose
constructor returns a scalar never gets a struct type index).

**Gates at `bce6f7d`:** build clean · test-towasm green · test-checker green · difftest **2182/2191 · 0
disagree · 9 unsupported** (baseline) · corpus-ab vs `7b6e3fc` every bucket **+0** (tested 13,527 · threw
345 · GAP 346 · WARNING 1,469 · ERROR 864 · false-positive 1,209).

## The survey is PARKED (user's call, 2026-09-17) — do not wait on it

The first full survey after `bce6f7d` reads **134/391**, 297 failures / 190 causes, and **10 REGRESSED**
(`towasm-analysis.ts`'s six `walkerB` users + `wasm-types.ts`'s `notUnsigned`, `elementKind`, `wasmTypeKey`,
`combineUnionWtypes`), all failing `Cannot read properties of undefined (reading 'scope')`. **That is the
instrument, not a regression:** `selfhost-survey.sh tison/src/examples/TS/towasm-analysis.ts` alone compiles
all six, and a two-file run fails a DIFFERENT set with a DIFFERENT message. Per-declaration results are
order/state-dependent beyond the `935a4e1` import-cycle fix, so a single-run `REGRESSED` line is noise.
**The user's direction is to keep moving code rather than wait ~10 minutes per survey run**, so: while
relocating, run only the fast set — `npx tsc -b src/examples`, `test-towasm`, `test-checker`,
`difftest.sh` (all under ~2 min) and on a move they must be identical to baseline. Fix the determinism
later; until then never read a survey delta as progress or regression.

## Next, by value

- **Retune functions to the neutral base.** `FunctionContext` is already split, but functions that take the
  local subclass and only use base members (e.g. `emitRawSlot`, `emitHolderRead`, `emitTrailingUnreachable`,
  maybe `numericOpInline`/`isNamespaceValue`) can be retyped `ctx: WT.FunctionContext` and move — the same
  move `ClassInfo`/`ownerThisType` just made. `ClassInfo` is now a class, so neutral methods go ON it.
- **`towasm-analysis.ts`** (261 lines) is per-language AST queries with one consumer; the user's stated
  expectation is ONE TS module, which folds it into `towasm.ts` — asked, not decided.
- **`rawElemKind`/`asmDeclaredType` stay TS-side deliberately** (they reason about TS type spellings).
- **Step 3's three generic cores** (independent): `src/examples/layout.ts`, `guard<R>` into `walker.ts`,
  `buildStateMachine` into `src/examples/statemachine.ts`.

## Open, waiting on the user — do not assume

- The **BigInt row** (6 declarations) is a real overload-*resolution* gap in `candidateFits`; unchosen.
- Whether to fold `towasm-analysis.ts` (above).
- The **`WT` prefix rename** (~459 refs) was explicitly handed to the user — an editor find/replace.

## Tree state

HEAD `bce6f7d`, working tree clean at the time of writing (`42c3cd6` added the VSDG C++ `++`/`--` pins).
**The user edits and commits concurrently — re-check `git status`; never trust this line.**

## Keeping this current

Rewrite the dated section when a fix lands or a session ends — state, not history; history is in the
commits. Keep it under ~60 lines, or it stops being cheaper than the plan. An out-of-date handoff is
worse than none, because a cold session will trust it.

Related: [[feedback-session-boundaries]], [[feedback-two-tier-gates]], [[tison-towasm]].
