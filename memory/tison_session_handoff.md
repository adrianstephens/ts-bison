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

**HEAD `0fcf399` — "give each helper its owner and each module its own helpers".** Two strands landed
together, both instances of the one rule: a method goes on the state it reads, a free function goes in the
module whose vocabulary it speaks. `ClassInfo.addField`/`fieldDeclaredType`, `Types.func`/`funcAt`/
`nullable`/`envBase` and `narrowedTypeOf`/`narrowedValueTypeOf`/`inNarrowed`/`staticGuard` are methods now;
`withContext`/`emitTrailingUnreachable`/`emitResumableDispatch` stayed on the TS subclass (async/generator
lowering is TS-only); `resolveOverload` went to `checker.ts`, where `candidateFits` lives (so it takes a
`scope`); `nextCall`, four helpers that took `global` only to pass it on, and `objectShapes` went to
`type-utils.ts`. Sizes: towasm 9,802 · type-utils 3,915 · wasm-types 605 · wasm-asm 227.

**The placement rule, for every future candidate** (the user endorsed it): needs `TStoWasm`'s registries
(`classes`, `types`, `ensureClass`) -> stays a free function taking `ctx` for now, because Step 5's
`TSEmitter` move takes them together; no registries but needs TS state or a JS/TS concept -> subclass
method; no registries and no language type, generic wasm over the context's own state -> base method. A
single dependency is a LEAD, not a verdict — signature-local types count (`mergeOverloadSigs` depends only
on `types` but returns `FullSig`, so it stays free), and "reads only base members" != "belongs on the base".

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

**Gates at `0fcf399`:** build clean · test-towasm green · test-checker green · difftest **2182/2191 · 0
disagree · 9 unsupported** (baseline, unchanged by the batch). At `bce6f7d`, corpus-ab vs `7b6e3fc` was
every bucket **+0** (tested 13,527 · threw 345 · GAP 346 · WARNING 1,469 · ERROR 864 · false-positive 1,209).

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

- **Retune remaining functions to the neutral base.** Still free functions taking `ctx` whose bodies only
  touch base members: `emitRawSlot`, `emitHolderRead`, maybe `numericOpInline`/`isNamespaceValue`. Retype
  them `ctx: WT.FunctionContext` (and move, where the body allows) — the move `emitBreak`/`rawSlot`/
  `emitTrailingUnreachable` already made. Neutral methods go ON `ClassInfo`, which is a class.
- **The `--single` leads** (13 functions whose only in-scope dependency is one binding, from
  `assistant/towasm-hoist-survey.ts --single`): `classes`->`newTypeArgs`, `closureBindings`->`closureWtype`,
  `moduleBodies`->`moduleFilename`, `functionDeclByName`->`resolveDecl`, `ast`->`needsHolder`, `globals`->
  `ensureGlobal`, `data`->`addData`, `types`->`mergeOverloadSigs`, `userGenericClassDecls`->
  `staticTypeArgsFor`, `libGlobal`->`resolveClassAlias`, `openShapes`->`noteTypes`. Fan-in leaders:
  `toValType` (5), then `ensureClass`/`typeOf`/`ownerOf`/`methodSig`/`ownerFor`/`emitStmt` (2 each).
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

HEAD `0fcf399`, working tree clean at the time of writing. **The user edits and commits concurrently —
re-check `git status`; never trust this line.**

## Keeping this current

Rewrite the dated section when a fix lands or a session ends — state, not history; history is in the
commits. Keep it under ~60 lines, or it stops being cheaper than the plan. An out-of-date handoff is
worse than none, because a cold session will trust it.

Related: [[feedback-session-boundaries]], [[feedback-two-tier-gates]], [[tison-towasm]].
