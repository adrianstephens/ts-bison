---
name: tison-session-handoff
description: LIVE cold-start state for the wasm-backend work — where things stand, what is deliberately unfixed, what the user has not decided. Read this before the 2233-line plan.
metadata:
  node_type: memory
  type: project
  modified: 2026-09-18
---

**Read this first, and usually instead of [[tison-towasm-self-hosting-plan]]** (2233 lines — open it only
for the accumulated history of a specific row). This file is live state and nothing else: **rewrite it
wholesale, do not append.** It drifted to 223 lines by appending; that is the failure mode.

## Latest: 2026-09-18 night -- HEAD `a4966cc` (Iterable) + an UNCOMMITTED regression fix in the tree

**`a4966cc` REGRESSED the survey** (the gates did not see it): 144 compile, and 81 that compiled at `71e9ddf` no longer did. Main cause:
backend.ts's module-level `builtinTypes = new Map<string,{...}>([...])` fits no array-constructor overload in the checker
(the old `Map<string,{...}>` row); the new `Iterable` constructor fit, and codegen then failed converting to it.

**The fix is in the working tree, NOT committed** (backend.ts + test-towasm.ts; gates green: towasm 960, checker, cpp,
difftest 2191/2200 0 disagree, corpus gate 838). Survey on it: **208/402 compile** (233 failures, 62 causes). What it does:
- `collectOpenShapes` walks `new` too (construct signatures instantiated from the built type: `instantiateConstruct`);
  a declared parameter mentioning its signature's own type parameters is skipped.
- `noteSlot`: `a = b` is `b`; `c ? a : b` is each branch in its NARROWED scope (`narrow`); a `new` of the slot's own class
  is built at the slot; an array literal meeting a non-array object slot opens it; values typed IN the slot's context.
- `openKey`: a shape opens under its struct's key (`layoutArgs`/`layoutKey`, factored out of `ensureObjectShape`); classes by own key.
- Nullable slots strip nullish; `fits` shared by both any-dispatchers, and method dispatch drops candidates whose result can't
  become `want`. REVERTED from `a4966cc`: noting `x as T` (an `as` never changes representation; opened view casts spuriously),
  so `for (... of m as Iterable<...>)` is unsupported again (explicit internal error). Proper fix: dispatch on `unwrapAs`'s type.

**UNRESOLVED before committing:** the 208 run lists **46 checker.ts declarations** failing with `cannot convert ref:Param<any>
@./js-parser to ref:{...}` (checker.ts was 58/58 at `71e9ddf`). Probed alone (`probe-one-decl.ts`, even several per process
with `DBG_SHARED_LIB=1`) they compile. Suspect probe-order state in the survey's shared lib scope, possibly from the pre-pass
now calling the checker's `typeOf` WITH an expected type. Next step: `selfhost-survey.sh tison/src/examples/TS/checker.ts`
(single file, several minutes) -- the user interrupted that run, and has not chosen between re-running / committing / stopping.

`probe-one-decl.ts` (gitignored) now resolves sibling packages from the packages root, so it matches the survey.
Pre-existing, not a regression: a `Map` literal whose object values omit an optional field (`{wtype}` beside
`{wtype, class}`) traps "illegal cast" at `ecc5f6c` too.

**`Iterable` design (`a4966cc`):** lib declares `Iterator`/`Iterable`/`IterableIterator`; `Array`/`ReadonlyArray` have a real
`[Symbol.iterator]`; a `for...of` over a known array stays positional. Open shapes are THE mechanism for interface-typed values:
a named function's structural parameter specializes per argument; any other slot (closure/method/constructor parameter, literal
contents) that receives another layout is stored as `any`. `ownerFor` answers none for an open shape; `dispatchesAsAny` sends a
receiver typed or stored as `any` to `ensureAnyDispatch`. `Set`/`Map` take `Iterable | null | undefined` after their fast paths.
`Iterator.next` is `next(v?: N)`, not TS's rest-tuple form.

Earlier the same day (`0009613`..`0cabd72`): object-literal METHODS are closures in their fields; METHOD VALUES are
closures over one `envThis` (option A, user's choice; `.apply`/`.bind` not done); `fieldDeclaredType` is what a field
ACCEPTS; uncontextual `[]` is `never[]`, `AUTO_ARRAY` for untyped `let x = []`; `objectShapeOf` is the one type-to-struct
resolution; a GENERIC CLASS instance is re-checked as generic functions are (`0cabd72`, not a hack -- same mechanism).

**Committing beside the user's WIP**: they edit backend.ts/wasm-codegen.ts/lib.d.ts concurrently. Stage only your hunks
(`git diff > p; filter hunks; git apply --cached --recount`). **Trap:** `cd src/examples/TS/lib && tsc -p .` EMITS `.js`
beside every lib source; use `--noEmit` (tsc lives in the WORKSPACE root's `node_modules/.bin`).

## As of 2026-09-18 -- HEAD `148f0b4`

**The files:** `TS/backend.ts` (~9,750) and `CPP/backend.ts` (379) over the neutral `wasm-codegen.ts`
(~1,046); `TS/type-utils.ts` ~3,950. The module is imported as `W` since the user's `b3a0b01` rename.

**2026-09-18 session:** 18 fixes from the self-hosting survey, `5a0a944`..`148f0b4`; each commit message
has its root cause. The general mechanisms, worth knowing before editing nearby:
- **A caller's type carries the caller's scope.** `T.Inference.add`/`inferReturn` stamp every candidate, and
  `inferTypeArgMap` stamps explicit type arguments. A caller type substituted into a callee alias and resolved in
  the callee's module scope went opaque, and `resolve`'s per-scope cache then kept the stale answer.
- **Call arguments are typed in order** against what the earlier arguments inferred (TS's non-fixing mapper).
- **Generic instances use NARROWED argument types** (`ctx.narrowedTypeOf`), as the checker infers. Since a call
  result then need not match the un-narrowed view, `FunctionContext.physicalScope` types a call/`new` in the
  narrowed scope; variables keep their slot's type.
- **One struct per object type per compile**: `matchObjectShapeByType` memoizes under the typeKey, and a shape
  built by `ensureAnonObjectShape` is `anonymous`, never a match candidate for another type.
- `precise` in `isAssignable` is TS's subtype relation: `any` is below nothing but itself.
- The lib declares `ReadonlyArray`. A mapped type's key is a binder in `substituteType` (`renameMappedKey`).
- Callback parameters are checked BIVARIANTLY (`62ec84a`); the old "parameters deliberately unchecked" leniency is gone.

**`npm run gate` is PARSER-ONLY** -- it cannot see a checker change. The checker gate is
`bash tison/assistant/corpus-ab.sh <base-sha>` (~7 min): at `62ec84a` vs `17e1da7` it read false positives
1209 -> 1204. Its "tsc-clean" label is from missing `.errors.txt` baselines, and some are stale: verify a new
ERROR with the real tsc (`node_modules/.bin/tsc --noEmit --target es2020 <file>`, 6.0.3) before calling it a
false positive -- seven of this session's were true positives.

**Gates, at every commit through `148f0b4`:** build clean · test-towasm · test-checker · test-cpp-backend ·
difftest **2191/2200 · 0 disagree · 9 unsupported** · corpus gate (parser) **838 / 11,012, baseline 838**.

**Gate note:** difftest does NOT cover a change to *which* code reaches codegen — it only compares output
for cases that already compile. `npm run gate` (the 11,012-file corpus) is the one that does. Run both for
any guard or eligibility change. difftest's corpus is 2200 only with the nine assignment-order cases in
`assistant/difftest.ts`, which is GITIGNORED — a fresh tree reports 2182/2191.

## Architecture — SETTLED, do not re-propose

**Two components, one file each: `TS/backend.ts` is the TS half, `wasm-codegen.ts` the neutral half.**
A file is earned by CROSS-LANGUAGE REUSE and nothing else — not by being wasm-free (that is what
`towasm-analysis.ts` was drawn on, and why it was folded back), and not by size.

- **`TSEmitter` is rejected** — the subclass would be ~90% of the file, so the split buys nothing: the big
  file stays unnavigable and the small one is no more reusable than a module. Plan Step 5 estimated
  1,500–2,500 neutral vs 10,000+ TS and called the lopsidedness "the point"; it is not. And the ~1,083
  neutral lines exist today WITHOUT the class conversion, so it cannot be revived as "what unlocks the
  neutral half". Every "blocked until Step 5" note elsewhere means **not happening**.
- Do not split `TS/backend.ts` for navigability. `emitExpr` (1,630 lines) and `emitStmt` (654) stay.
- **Neutral extraction is exhausted, measured.** The four biggest in-closure clusters are saturated with TS
  types: class layout 620 lines (48 `Type`, 27 `Scope`), any-dispatch 502, async/generator 420,
  union/virtual dispatch 235. Don't re-survey them hoping for a neutral core.
- This rejects the SPLIT, not methods. Moving a genuinely neutral function onto `FunctionContext`/`Types`/
  `ClassInfo` is right and is what recent commits did.

**wasm-knowledge is NOT language-neutral**, and grepping for TS types will mislead you. The test is "would
a second front end want exactly this?" `numericOpInline` is the trap: 30 lines of pure opcode selection
with no TS type in it, but it encodes JAVASCRIPT semantics (always-float division, `shr_u` → u32). Also not
neutral: `toValType`/`heapTypeIndexOf` (resolving a class NAME is language knowledge — `toValType` stays an
explicit parameter, the `toFuncBody(numParams, toValType)` idiom), and `isSubclassOf`/`storageKindOf`/
`builtinTypeOwner`/`namespaceOwner` (they read the `classes`/`builtinTypes` registries).

**`CPP/backend.ts` is the neutrality gate.** Scalars, functions, locals, if/while/break/continue/return,
arithmetic conversions, direct calls, `?:`; anything else throws `W.Error`. It was written against
`wasm-codegen.ts` **without adding or changing a line of it** — that is the evidence the split is real.
`test-cpp-backend.ts` compiles, instantiates and RUNS the output. Keep it green: it is the only thing that
fails when a "neutral" helper quietly assumes TypeScript. Do not read 379-vs-9,697 as a measure of
anything — it buys a fraction of the features; the gap measures how little of the TS backend is wasm.

## Contracts worth knowing before editing codegen

**`emitIf`/`emitBlock`/`emitLoop` own the wasm levels they open** (`460b781`). `emitIf`/`emitBlock` enter
one; `emitLoop` enters two AND registers them, since a loop's levels ARE its targets (`break` → the block,
`continue` → the loop). `emitContinueBlock` shadows the continue target for a `for`, whose update must
still run. Callers do no depth bookkeeping. `enterBreakTarget`/`enterContinueTarget` still open-and-mark,
for `switch` and the resumable dispatch, which build their blocks by hand. This changed because the old
caller-accounts contract failed invisibly: a `break` inside an `if` targeted the loop restart and hung.

**Locals are named and freed by `FunctionContext`.** `tempCounter` names every generated local, unique per
context. What keeps the count down is LIFETIME: `closeScope` alone returns a slot to `freeSlots`, so
assignment sites wrap the whole expression in `ctx.inScope`. Without it, one local per same-typed write
site survives until the block closes (measured: a 40-write probe 7 → 45 locals; with the scope, 7).
`assistant/local-count.ts` measures this; `local-probe.ts` is its stress input.

**`Types` owns the shapes** (`array`, `box`, `envBase`, `closureBase`, `closure`, `holder`, `heapType`);
rendering a `Type` to a `wasm.ValType` stays the language's. `register` dedupes structurally, so
`Types.closure` needs no cache; `closureTypes` in the backend is a signature REGISTRY, not a cache.

**Structural, not stylistic:** `declScope?: Scope` can never be neutral (`Scope` is type-utils', which
imports wasm-codegen); a subtype must RE-NARROW a base's recursive member (`declare superClass?: ClassInfo`)
or every chain walk degrades to the base — `declare`, never `!`, because a field initializer emits after
`super()` and clobbers what the constructor assigned (verified; TS2612); `typeIndex: -1` on `ClassInfo` is
a real state (a scalar-returning constructor never gets a struct type index).

**Placement rule for a new candidate:** needs the `TStoWasm` registries (`classes`, `types`, `ensureClass`)
→ free function taking `ctx`; no registries but needs TS state or a JS/TS concept → subclass method; no
registries and no language type → base method. A single dependency is a LEAD, not a verdict —
signature-local types count (`mergeOverloadSigs` needs only `types` but returns `FullSig`, so it stays free).

## Open

- **The `OneOf` precedence defect** — see [[tison-precedence-resolution]]. Half is fixed (`87a809b`); an
  operator spelled `OneOf([...])` still takes a default shift, losing precedence AND associativity
  (`a * b + c` → `a * (b + c)`). **`termOneOf` is NOT the fix** — the user rejected it.
- **`emitResumableDispatch` should own its own loop**, retiring the last two hand-written loops in
  `compileGeneratorFunc`/`compileAsyncFunc` (32- and 70-line bodies, so wrapping them at the call site
  makes things worse). It needs a `loadState` callback, the read counterpart of `setFrame`.
- **The BigInt row** (6 declarations) is a real overload-*resolution* gap in `candidateFits`; unchosen.
- **The `WT` prefix rename** (~459 refs) was handed to the user — an editor find/replace.
- `test-towasm.ts` is now the odd name beside `test-cpp-backend.ts`; not renamed, to avoid churn.
- **Inlining is a PREPASS, not a backend pass** (user's call, `3793591`): `inlineSmallCalls` was deleted.
  Do it over the VSDG, where sizes and call sites are visible. `assistant/bench-inline.ts` measures the win.
- **Step 3's three generic cores** (independent): `src/examples/layout.ts`, `guard<R>` into `walker.ts`,
  `buildStateMachine` into `src/examples/statemachine.ts`.

## The self-hosting survey — run it OCCASIONALLY, never as a gate (user's call)

**It is slow and causes friction, so run it deliberately, not routinely.** The gates are difftest, the
corpus gates and the test suites; the survey is a probe to be read. Its per-declaration results are
order/state-dependent, so a single-run `REGRESSED` line is noise — never read a delta as progress.
`--whole` is the ~15s mode, but it OVERWRITES the stored per-file JSON with whole-only data, discarding
the last full run's per-declaration results. Its TARGETS list was repointed at `ed2d662` (it had been
naming three files that no longer exist).

At 2026-09-18 (`148f0b4`): type-utils.ts compiles **152/164** declarations (69 at session start), walker.ts 3/4,
no declaration regressed. Rows left, biggest first: unresolved identifier `m` (54, checker.ts), object literal needs
a known target type (24, ts-parser/peg), `Map<string,{...}>` constructor overload (23, backend.ts), `Array.from` on
the constructor type (11), js-parser `Array<any>` -> `{...}` (11). `probe-one-decl.ts` takes `FULL=1` for positions.

**Open, found this session:** a spread of a generic `N` types as `{[key: string]: any}` where TS keeps `N`;
`xs.nope` on a `readonly T[]` is not reported; the checker writes no contextual annotation for a callback in an
annotated const inside an IMPORTED module's function (codegen now copes); backend's `resolveOverload` still picks
an overload with the un-narrowed scope.

`assistant/towasm-hoist-survey.ts` still answers "does this need the scope?" by the binding rather than the
name (`--module`, `--single`, `--dump`/`--apply`), but most of what it unlocked was gated on `TSEmitter`
and is therefore moot.

While relocating code, run only the fast set: `npx tsc -b src/examples`, `test-towasm`, `test-checker`,
`difftest.sh` (~2 min).

## Tree state

**Never trust this line — the user edits and commits concurrently; re-check `git status`.** At the time of
writing: HEAD `a4966cc`; backend.ts and test-towasm.ts hold the uncommitted regression fix above.

## Keeping this current

Rewrite the dated sections when work lands — state, not history; history is in the commits. Target ~100
lines. An out-of-date handoff is worse than none, because a cold session will trust it.

Related: [[feedback-session-boundaries]], [[feedback-two-tier-gates]], [[tison-towasm]],
[[tison-precedence-resolution]], [[tison-towasm-cross-language-plan]].
