---
name: tison-session-handoff
description: LIVE cold-start state for the wasm-backend work — where things stand, what is deliberately unfixed, what the user has not decided. Read this before the 2233-line plan.
metadata:
  node_type: memory
  type: project
  modified: 2026-09-19
---

**Read this first, and usually instead of [[tison-towasm-self-hosting-plan]]** (2233 lines — open it only
for the accumulated history of a specific row). This file is live state and nothing else: **rewrite it
wholesale, do not append.** It drifted to 223 lines by appending; that is the failure mode.

## Latest: 2026-09-20 -- HEAD `c8c8fbc` (checker work, step 2 of the open-shape plan)

**The plan the user approved:** drive towasm's open-shape pass from the checker's own assignability checks (every
accepted "value into slot" flow stamped on the value node), in order: (2) check rest/spread arguments -- DONE
`fa0e437`; then (1) `checkFlow` stamping at the nine flow sites; (3) towasm reads the stamps (keeping its
monomorphization/erasure rules); (4) spreads + union-member descent in `noteSlot`. **Steps 1, 3, 4 not started.**

**Step 2 and its fallout, all committed** (`fa0e437`..`c8c8fbc`), corpus A/B +25 errors ALL verified true positives
with tsc 6.0.3, -11 false positives, corpus gate 838 = baseline throughout:
- `fa0e437` rest/spread arguments checked as one tuple; overload choice reads them too.
- `864c5f1` declarations merge whatever order they are hoisted in (namespace blocks checked in the MERGED scope,
  function+namespace values, annotation-only refs resolved lazily). Fixed 24 pre-existing false positives.
- `70f0a53` TS's covariant/contravariant preference + arrays inferred by element; `ed85749` a generic source
  signature is instantiated in the target's context.
- `ba05b5d` destructuring parameters typed from their PATTERN; `ad475ae` a script's `interface` augments the
  global one every declaration sees (`Scope.recordTypes()` undoes it between corpus files / checker cases);
  `c843304` ``tag<T>`...` `` parses as a tagged template.
- `c8c8fbc` **inventory C4's methods**: assignability compares method members. Call/index signatures still skipped.

**Watch for:** an unannotated function with a destructuring parameter infers an `any` RETURN (found, unfixed).
A script's non-interface declarations are still local, so a second script does not see them.

**Instruments:** `assistant/probe-fulllib.ts <file>` checks a file under lib.esnext.full exactly as test-checker does;
`assistant/tsc-type-at.ts <file> <line> <text>` prints tsc's own type, and its RESOLVED SIGNATURE for a call.
Probe traps: literal types compare leniently (probe with `number`/`string`, never `'yes'`); in zsh `echo ====` aborts.

## Earlier -- the towasm literal work, `a01d942`..`9c94144` (2026-09-19)

**Survey 268/404 at `fd5df24`, nothing regressed; checker.ts 58/58 and whole-file (3073 funcs).** The rules that
came out of it, worth knowing before editing codegen nearby:
- **A literal's struct holds every key it PROVIDES**, spreads included (`matchObjectShape`, `spreadOwner`);
  `spreadKeys` reads the operand's TYPE (`T.collectMembers` per union member), never a struct's field list.
- **Who READS a literal decides its struct.** With a context, the context (`matchContextualUnionMember`: one shape
  decides even `{}`; a member's required keys must be supplied). With none (`any` is none), the literal's own type --
  ambiguity builds the anonymous shape. A spread operand's reader is the spread copy, so it is emitted in its OWN
  type's context (`emitSpreadOperand`). An arrow's INFERRED return yields to the caller's context; `as const` is none.
- **A type is laid out as a declared class only where every member keeps its layout** (`holdsLayout`); `Partial<X>` is
  no `X`; spreading an absent value supplies nothing.
- **`resolve` never caches a result produced under a depth bail** (`depthBails`). Depth 10 is shallow: core.ts's
  `ElemValue` chain costs one level per `extends` arm. The circular bail is still cached (stack-dependent too).

**Survey rows left** (at `fd5df24`): object literal needs a known target (52: backend.ts 51, peg 1), ts-parser's
`cannot convert {key:string} to Rest<any>` (24), `Array.from` on the constructor type (11), js-parser
`Array<any>` -> `{...}` (11), backend's `Type` vs `W.Type` (7+). **Re-run the survey: it predates all checker work
since `fd5df24`.**

**Option 1 (precision) hit its limit at ts-parser.ts:469** -- `{ ...$[2], typeParams }` is correctly a `FunctionType`,
but `$[2].rest` is an anonymous `{key}` struct where `FunctionType.rest` is a `Rest`: a real width-subtyping flow,
which only option 2 (open shapes) handles. That is what the open-shape plan above is for. The user's call: keep types
MORE precise than tsc where it buys codegen (the rest-element union is marked OPTIMISATION in type-core, droppable
once option 2 exists), and accept less optimal code where the source is too vague for tsc to be precise either.

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
writing: HEAD `c8c8fbc`; the user's own uncommitted `Tuple` export in ts-parser.ts.

## Keeping this current

Rewrite the dated sections when work lands — state, not history; history is in the commits. Target ~100
lines. An out-of-date handoff is worse than none, because a cold session will trust it.

Related: [[feedback-session-boundaries]], [[feedback-two-tier-gates]], [[tison-towasm]],
[[tison-precedence-resolution]], [[tison-towasm-cross-language-plan]].
