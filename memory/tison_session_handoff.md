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

## As of 2026-09-17 (late)

**HEAD `efe46bd`.** Six commits: `307aa89` folded `towasm-analysis.ts` back in, `a69d68a` renamed
`wasm-types.ts` → `wasm-codegen.ts`, `f09f3d4` put `emitBlock`/`emitLoop` and `TagSection` on the neutral
side, `b9be812` swept 50 hand-built identifier nodes onto `Identifier()`, `025cc32` did the other nine node kinds,
`efe46bd` renamed `TSWError` → `WasmError`. The file architecture is settled
(see its own section) and the cross-language row is CLOSED, not paused: with `TSEmitter` rejected there is
no further neutral extraction of consequence. Sizes: towasm **9,722** · type-utils 3,911 · wasm-codegen 829
· wasm-asm 227. Gates at each commit: build clean · eslint 0 errors / 94 warnings, none in towasm.ts ·
test-towasm green · test-checker green · difftest **2191/2200 · 0 disagree · 9 unsupported** — unchanged
since `6e29763`, so all four were behaviour-preserving.

**`emitBlock`/`emitLoop` follow `emitIf`**: the body goes into its own list and the wrapper is built AFTER
it, because the branches inside already carry depths relative to that wrapper. They own only the wrapping,
NOT the break/continue targets — at `while` the test is emitted before `enterBreakTarget`, so the targets
don't bracket the body uniformly and folding them in would reorder instructions.

**Two loops stay hand-written on purpose** (`compileGeneratorFunc`, `compileAsyncFunc`): 32- and 70-line
bodies, so a closure wrapper would push deeply nested code a level deeper to save two lines. Both share one
protocol — load state, `emitResumableDispatch`, wrap in a loop — and **the right fix is for
`emitResumableDispatch` to own its own loop** (it already owns the `br_table` ladder; it would need a
`loadState` callback, the read counterpart of `setFrame`). Not done; a real next step. The try/finally
block ladder is also left alone: it uses the UNMATCHED `swapOut()` form (close off what has accumulated,
continue in a fresh list), which `emitBlock` does not fit.

**The AST-node sweep is DONE** (`b9be812` identifiers, `025cc32` the other nine kinds). Every node in
towasm.ts is built with common.ts's or js-parser's constructor now; `as Expr`/`as Stmt` went 38 → 16,
because an object literal doesn't widen to the union on its own and a constructor's return type does.
Use `JS.Member`/`Call`/`Index`/`Spread` (they carry `optional`), common.ts's for the rest.

**ONE site is deliberately still hand-built** — the union-discriminant arm in `case 'object'` (~line 2097).
Converting it surfaced a real latent problem: `v` there is a TS literal **type**, not an expression, used
in an expression position. That is legal only because both are `Common.Literal`, differing in the value
type parameter (`TemplatePart<Type>[]` vs `TemplatePart<Expr>[]`), and the whole-node `as Expr` hid it.
**The fix**: exclude template-literal members in the `every` guard (they have no comparable runtime value,
so an arm for one is already meaningless) and build `Literal(v.value)` — that removes the neighbouring
`v as unknown as Expr` too. Deferred because it changes WHICH union members compile into arms, so it needs
its own difftest run. Do not "fix" it by adding a cast; that was tried and reverted.

The previous entry, for the work that built the neutral layer:

**HEAD `6e29763` — "DataSection owns the data segment and its string table".** `0fcf399` landed
the placement batch: `ClassInfo.addField`/`fieldDeclaredType`/`isBaseOf`, `Types.func`/`funcAt`/`nullable`/
`envBase` and `narrowedTypeOf`/`narrowedValueTypeOf`/`inNarrowed`/`staticGuard` are methods; `withContext`/
`emitTrailingUnreachable`/`emitResumableDispatch` stayed on the TS subclass (async/generator lowering is
TS-only); `resolveOverload` went to `checker.ts`, where `candidateFits` lives (so it takes a `scope`);
`nextCall`, four helpers that took `global` only to pass it on, `objectShapes` and `emitAnyTruthy` went to
the neutral modules. Then: one `FunctionContext.tempCounter` replaced six module-wide counters AND
`scratchName`, and assignment expressions run in their own scope so their scratch slots are freed; the type
section took its own struct shapes (`Types.closureBase`/`closure`/`holder`) so `emitDefaultValue`,
`emitOptionalAccess` and `typeofHeapType` could leave, taking `toValType` as an explicit parameter the way
`toFuncBody` already does; `inlineSmallCalls` was deleted; and `emitIf` replaced the hand-swapped
conditional protocol at 21 sites (towasm's `swapOut` uses 131 -> 71); then `memOp`/`touchesMemory`,
`Types.groupSizes` and `DataSection` left the language side. Sizes: towasm 9,481 · type-utils 3,911 ·
wasm-codegen 812 · wasm-asm 227.

**The placement rule, for every future candidate** (the user endorsed it): needs `TStoWasm`'s registries
(`classes`, `types`, `ensureClass`) -> stays a free function taking `ctx` for now, because Step 5's
`TSEmitter` move takes them together; no registries but needs TS state or a JS/TS concept -> subclass
method; no registries and no language type, generic wasm over the context's own state -> base method. A
single dependency is a LEAD, not a verdict — signature-local types count (`mergeOverloadSigs` depends only
on `types` but returns `FullSig`, so it stays free), and "reads only base members" != "belongs on the base".

**The method to reuse:** `assistant/towasm-hoist-survey.ts` resolves every identifier with the checker, so
"does this need the scope?" is answered by the binding, not a name: `--module` classifies module-level
declarations by their externals with a transitive fixed point, `--move --write` relocates to
`type-utils.ts`, `--dump`/`--apply` does the `TStoWasm`-child hoist (41 of 209 needed nothing; a second
pass found 0 more), `--single` lists functions with exactly one in-scope dependency.
`assistant/towasm-comment-pass.js` is the comment tool (449 blocks >2 lines -> 274).

**Structural, not stylistic:** `declScope?: Scope` can never be neutral (`Scope` is type-utils', and
type-utils imports wasm-codegen); a subtype must RE-NARROW a base's recursive member (`declare superClass?:
ClassInfo`) or every chain walk degrades to the base — `declare`, never `!`, because a field initializer
emits after `super()` and clobbers what the constructor assigned (verified; TS2612); `typeIndex: -1` on
`ClassInfo` is a real state (a scalar-returning constructor never gets a struct type index).

**Locals are named and freed by `FunctionContext`.** `tempCounter` names every generated local, unique per
context, so nothing is kept apart by a name any more (`scratchName` is gone). What keeps the count down is
LIFETIME, not naming: `closeScope` is the only thing that returns a slot to `freeSlots`, so the assignment
sites wrap the whole expression in `ctx.inScope` — a write's `$old`/`$new`/`$obj` are dead once it has
written back. Without that, one local per same-typed write site survives until the block closes (measured:
a 40-write probe function 7 -> 45 locals; with the scope, 7, and `lib/node/path.ts` 320 -> 319).
`assistant/local-count.ts` measures this (`mod.code[].locals`); `local-probe.ts` is its stress input.

**Where the type section ends and the language begins.** `Types` owns the shapes (`array`, `box`, `envBase`,
`closureBase`, `closure(funcTypeIndex)`, `holder(vt)`); rendering a `Type` to a `wasm.ValType` stays the
language's, and the neutral functions that need it take `toValType` as an EXPLICIT parameter (the
`toFuncBody(numParams, toValType)` pattern) — no resolver hook on `Types`, nothing to install, and
`ensureClass` unreachable from the neutral layer. `register` dedupes structurally, so `Types.closure` needs
no cache; `closureTypes` in towasm is a signature REGISTRY (`an`-dispatch scans it), not a cache.

**Reuse is exhausted as whole functions, and the neutral layer is now harvested.** With every registry
assumed neutral the survey unlocks only 17 of 145 functions (327 of those lines are the two expando
collectors, which are language code), and the rest stay blocked by `typeOf`/`emitAs`/`coerceTop`/`owner*`/
`ensure*` — the TS layer itself, i.e. Step 5's `TSEmitter`. This session took everything that was cheap and
neutral out: `emitIf` on the base (21 sites, towasm's `swapOut` uses 131 -> 71), `memOp`/`touchesMemory` out
of type-utils, `Types.groupSizes` (the rec-group policy), `DataSection` (the data segment + string table).
What is left there is marginal and deliberately skipped: the assembler tail's `place`/`datas`/`elements`
(~15 trivial lines, and the globals section beside them is language — it reads TS literal ASTs), `emitLoop`
(4 sites), and the leads whose signatures name a towasm-local type (`declareHolder`, `mergeOverloadSigs`,
`toParams2`). Look for more misplaced wasm questions before designing anything new; `memOp` was the only one
in type-utils.

**Gates at `6e29763`:** build clean · eslint clean · test-towasm green · test-checker green · difftest
**2191/2200 · 0 disagree · 9 unsupported**. The corpus is 2200 cases only with the nine assignment-order
cases added to `assistant/difftest.ts` — that file is GITIGNORED, so a tree without them reports 2182/2191.
At `bce6f7d`, corpus-ab vs `7b6e3fc` was every bucket **+0** (tested 13,527 · threw 345 · GAP 346 ·
WARNING 1,469 · ERROR 864 · false-positive 1,209).

## The survey is PARKED (user's call, 2026-09-17) — do not wait on it

The first full survey after `bce6f7d` reads **134/391** with **10 REGRESSED**, all `Cannot read properties
of undefined (reading 'scope')` — **the instrument, not a regression** (one file alone compiles all six; a
two-file run fails a different set with a different message), so per-declaration results are order/state-
dependent and a single-run `REGRESSED` line is noise. Keep moving code: while relocating run only the fast
set — `npx tsc -b src/examples`, `test-towasm`, `test-checker`, `difftest.sh` (~2 min), identical to
baseline on a move. Fix the determinism later; never read a survey delta as progress or regression.

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
- **`towasm-analysis.ts` is GONE** (folded into `towasm.ts`, `307aa89`) — see the architecture note below.
- **`rawElemKind`/`asmDeclaredType` stay TS-side deliberately** (they reason about TS type spellings).
- **Inlining is a PREPASS, not a towasm pass** (user's call, `3793591`): `inlineSmallCalls` was deleted. Do not
  re-add a splice-into-instruction-lists pass; do it over the VSDG, where sizes and call sites are visible.
  `assistant/bench-inline.ts` measures the call overhead that prepass would remove.
- **Step 3's three generic cores** (independent): `src/examples/layout.ts`, `guard<R>` into `walker.ts`,
  `buildStateMachine` into `src/examples/statemachine.ts`.

## The file architecture is SETTLED (user, 2026-09-17) — two components, two files

**`TS/towasm.ts` IS the TS-specific component; `wasm-codegen.ts` (+`wasm-asm.ts`) is the generic one.**
(`wasm-codegen.ts` was named `wasm-types.ts` until 2026-09-17 — commits and plan text before then say
`wasm-types`, and it is the same file. The name went wrong once it grew `FunctionContext`/`Types`/
`DataSection`: only ~180 of its 812 lines are the type vocabulary.) A
file is earned by CROSS-LANGUAGE REUSE and by nothing else — not by being wasm-free (that is what
`towasm-analysis.ts` was drawn on, and why it was folded back in at `307aa89`), and not by size. So:

- **Do not propose splitting `towasm.ts` for navigability.** `TS/asm.ts` (the ~140-line TS asm spelling) and
  `TS/lib-decls.ts` (the lib ingestion) were proposed on those grounds and are DECLINED by this rule.
- **`TSEmitter` is rejected** (Step 5, and see the plan memory). 8,517 of towasm's lines are inside
  `TStoWasm`'s closure and will stay there; `emitExpr` (1,630) and `emitStmt` (654) do not get split.
- **Neutral extraction is exhausted, confirmed by measurement.** The four biggest clusters inside the
  closure are all saturated with TS types — class layout 620 lines (48 `Type`, 27 `Scope`, `TS.RefType`),
  any-dispatch 502 (49 `Type`, 8 `Scope`), async/generator 420 (47 `Type`), union/virtual dispatch 235.
  Don't re-survey these hoping for a neutral core.

**wasm-knowledge is NOT the same as language-neutral**, and a grep for TS types will mislead you. The test
is "would a second front-end want exactly this?" `numericOpInline` is the trap: 30 lines of pure wasm
opcode selection with no TS type in it, but it encodes JAVASCRIPT semantics — always-float division
("matching real JS `number` semantics", its own comment) and `shr_u` yielding `u32`. Python or C++ need
different rules, so it stays. Four more that read neutral and are not: `toValType`/`heapTypeIndexOf`
(resolving a class NAME is language knowledge — `toValType` stays an explicit parameter), and
`isSubclassOf`/`storageKindOf`/`builtinTypeOwner`/`namespaceOwner` (all read the `classes`/`builtinTypes`
registries). `towasm-analysis.ts` failed this same test from the other direction: wasm-FREE is not neutral
either.

## Open, waiting on the user — do not assume

- (`TSWError` → `WasmError` is DONE, `efe46bd`. The `tsw:` message prefix stays — it is the binary's name.)
- The **BigInt row** (6 declarations) is a real overload-*resolution* gap in `candidateFits`; unchosen.
- The **`WT` prefix rename** (~459 refs) was explicitly handed to the user — an editor find/replace. A file
  rename does not force it: `import * as WT from '../wasm-codegen'` is fine.

## Tree state

HEAD `6e29763`, working tree clean at the time of writing. **The user edits and commits concurrently —
re-check `git status`; never trust this line.**

## Keeping this current

Rewrite the dated section when a fix lands or a session ends — state, not history; history is in the
commits. Keep it under ~60 lines, or it stops being cheaper than the plan. An out-of-date handoff is
worse than none, because a cold session will trust it.

Related: [[feedback-session-boundaries]], [[feedback-two-tier-gates]], [[tison-towasm]].
