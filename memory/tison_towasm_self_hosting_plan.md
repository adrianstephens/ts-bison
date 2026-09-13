---
name: tison-towasm-self-hosting-plan
description: "towasm.ts self-hosting (compile+run its own implementation, WITHOUT adapting the source) — current measured state, the instruments and their traps (the survey was nondeterministic until `935a4e1`), and the causes that gate everything; 56/274 at `935a4e1`."
metadata: 
  node_type: memory
  type: project
  originSessionId: e1e31c24-8d38-47f3-aa27-e8c84bc6b664
  modified: 2026-09-08T16:50:01.196Z
---

**Goal (set 2026-08-19)**: make `towasm.ts` compile its own implementation and have the compiled-to-
wasm result *actually run* as a working compiler. Not "passes the checker without hitting a gap" —
it must take real input and produce correct executable output.

## INSTRUMENT CORRECTION (`25d2cc0`): a module-level statement no longer blocks its whole file

Every top-level statement shares ONE start function, emitted as a single worklist item -- so one
unrepresentable module-level `const` failed the entire module, and every other declaration in the file
with it. `TStoWasm`'s new `onTopLevelError` callback makes it recoverable (the statement's own partial
output is discarded into its own emit buffer, the error is reported, the rest compiles); the survey and
`probe-decl` pass a collector. Omitted, it rethrows exactly as before -- the CLI should not hand back a
module whose initialisation silently didn't run.

**Read the pre-`25d2cc0` "moved N declarations" figures with this in mind.** The 40/43/43/45 that the
towasm.ts chain produced were partly measuring THAT COUPLING, not per-declaration progress: each fix
unblocked one module-level statement, and the ~35 declarations behind it all moved together to whatever
the next module-level statement was. The fixes were real; the multiplier was an artifact. Numbers after
`25d2cc0` attribute a declaration to its own blocker -- expect them to be smaller and more honest.

## The instruments, and what each is for

- **`assistant/selfhost-survey.sh`** -- the cause table (below). Now also prints **"Since the previous
  run"**: how many declarations MOVED TO A NEW CAUSE, newly compile, or regressed, diffed against
  `selfhost-survey.prev.json` (snapshotted automatically before the workers run). **This is the metric
  that matters** -- blockers are serial, so a declaration reads "failed" whether eight or three of them
  remain, and `compiled` can sit flat through real progress. First real reading: the `T[number]` fix
  moved **41 declarations** while `compiled` stayed at 17/254. It also makes a symptom-fix obvious: one
  that moves a single declaration says so.
- **`assistant/difftest.sh`** -- differential CODEGEN test, 1281 cases (70 of them the `any/*` matrix). Compiles a snippet to wasm and
  runs it, runs the same source through the real TypeScript compiler under node, compares with
  `Object.is`. No expected outputs to author and the test cannot be wrong about what TS means. **Green
  as of `ab27225`, so it is usable as a gate.** Every case exports `main(): number` (the one result kind
  that crosses the wasm boundary unambiguously; string cases return `.length`).
- **`assistant/corpus-ab.sh [base-rev]`** -- the checker A/B (see below).
- **`tison/assistant/probe-decl.ts`** -- one declaration, seconds instead of ~10 min.

**Why difftest exists**: the two halves of the compiler were instrumented very unevenly --
`test-ts-official` puts 13527 corpus files through the CHECKER and never calls `TStoWasm` at all, while
codegen had only ~590 hand-written checks. That asymmetry is why `!0.5` returned `true` and `&&`
returned a boolean: the simplest operators on the simplest types, found by accident while chasing
self-hosting blockers rather than by the suite. **A top-down target program is a bad work queue for
exactly this reason** -- it surfaces bugs in the order one hard program happens to hit them.

## Run the instrument before believing any status claim, including this file's

`assistant/selfhost-survey.sh` (repo root). Runs the whole dependency set, never aborts, one worker
process per file, and stamps the tison git SHA + uncommitted-file count into its own output. Reads:

- **"Causes, ranked by declarations unblocked"** — this is the work queue.
- **"Shapes"** — a hint that two causes *might* share a root. Verify; never read it as a count.
- Per-file `distinct causes` — usually far smaller than the failure count, because one module-level
  declaration blocks every probe in its file (and, via imports, in others).

`--whole` skips per-declaration probing (~15s). Full run is ~10 min. It **prints** the tables to
stdout (redirect them yourself) and writes only `assistant/selfhost-survey.json` + per-file JSON.

**`tison/assistant/probe-decl.ts` (built 2026-09-04) is the fast companion**: compiles ONE named
top-level declaration exactly the way the survey does --
`npx ts-node -T --compilerOptions '{"module":"commonjs","target":"es2022","ignoreDeprecations":"6.0"}' \
assistant/probe-decl.ts src/examples/TS/checker.ts applyContextualParams`
-- printing the checker errors then the single codegen throw. Seconds instead of the survey's ~10 min,
and it is how the `closureSigParts` work was actually done: fix, re-probe the same 5 declarations,
watch the error move. Use the survey only to confirm the cluster moved.

**Re-run after every fix and diff the table. The delta is the unit of progress.** A fix that moves
one row by one is evidence you fixed a symptom, not a cause — pull the cluster's sibling sites out of
the JSON first and require them all to go away.

## 2026-09-10 (later): THE SURVEY WAS NONDETERMINISTIC -- an import-cycle race (`935a4e1`)

**Symptom**: probe-decl and the survey disagreed on js-parser.ts at the same commit (`'param 'lex' needs
an explicit type` vs `cannot convert ref:Token`), and re-running the SAME probe flipped between the two
about half the time. Not contamination between probes -- a race.

**Cause**: `TStypeCheckAsync` resolved imports with `Promise.all`. tison.ts <-> lalr.ts (and peg.ts) is
an import cycle, and tableCache.ts enters it from the lalr side, so WHICH edge `wouldDeadlock` cut
depended on I/O timing. Cutting tison's `export * from './lalr'` left js-parser's `RecoveryCallback`
unresolved (silently -- unresolved names are lenient), so `recover`'s params lost their contextual
types. `ownScopeSettled`'s comment "imports never need re-exports" is the false assumption.
**Fix**: imports resolve one at a time, in source order. Corpus byte-identical. The 18-block `lex` row
vanished; every declaration in it moved to a real blocker (`Parser<any>` 11->22, `TextPos` 5->9).

**Trap**: before trusting a survey delta, check the instrument is deterministic -- run one probe 3-5x.
Deltas before `935a4e1` for anything importing tison.ts (js-parser, ts-parser, towasm...) carry noise.

**probe-decl now matches the survey**: it had un-exported exported CONSTS too, which changes which
blocker is hit first. New env: `WHOLE_FIRST=1|check` (the survey's stage-2a run first), `SHOW=<const>`
(that const's arrow params as the checker left them, and its declared type resolved).

## `&&` on an object-typed nullable -- `T.logicalLeftPart` (2026-09-10)

`n && n.type === 2` with `n: Tok | undefined` is `boolean | undefined` (an object is never falsy); the
checker already said so for an interface, but codegen's `keepLeft` converted the left's struct ref into
the result box (`internal: cannot convert ref:Tok to typeIndex:N`). It now emits `undefined` when the
kept part is purely nullish; the checker's per-member logic is `T.logicalLeftPart`, shared by both.

- **OPEN (checker)**: for a CLASS left the checker still says `Tok | undefined | boolean` -- `isTruthy`
  never sees a nominal class ref as an object. Fix per [[tison_nominal_class_refs]]: `resolveMembers`.
- **CLOSED `20d8c28`**: `'any' (ref:TextPos) cannot be used as a boolean condition` -- truthiness tests
  read `t` from `ctx.scope`, so `lex.prev.pos` under `lex.prev &&` was `any`. All four sites now use
  `narrowedTypeOf`. Survey: TextPos row gone, 12 moved, 57/275.

## Calling a module-level factory-made closure const (`Rule = makeRule(...)`) -- 2026-09-10

- **Call path**: `case 'call'`'s factory-const branch looked only in `ctx.scope.decl`, which answers for
  IMPORTED modules; an ENTRY module's top-level consts live in `topLevelVars`. It now uses
  `lazyGlobalFor`, the same lookup a plain read already used. (`const R = mk(1); R(41)` threw
  `call to unknown function 'R'`; a LOCAL const, or a module-level arrow literal, always worked.)
- **Latent bug it exposed**: `coerceTop` sent two closure types differing ONLY in nullability through
  the closure coercion wrapper, which wrapped a nullable ref: invalid wasm (`struct.new[0] expected
  (ref N), found (ref null N)`). Reachable without the call path too (`const g = R; g(41)`) -- every
  closure-typed lazy global's slot is a nullable closure of the same signature. Now the ref/arr rule.
- Survey: the `Rule` row (10) gone, 13 moved, 57/275. They landed mostly in **`comparing to 'null'/
  'undefined' needs a nullable object-typed value`, now the #1 row (26, js-parser/towasm/type-utils)**
  -- js-parser's `startsPropertyName` hits it at 350:26. Start there next session, then the object-
  literal alias row (24) and `Parser<any>` (22, below).

## 2026-09-10 (evening): re-export barrels, and `any` is NULLABLE

- **`b1d5692` (the user's)**: tison.ts is now a pure re-export barrel over core.ts/lalr.ts/peg.ts, so the
  cycle behind the survey race is gone. `assistant/selfhost-survey.ts`'s TARGETS now include core.ts --
  without it the 12 declarations that moved there silently dropped out of the denominator.
- **`0c586b2`**: `collectModules` walks `export ... from` and resolves each named import through the
  re-export chain to the DECLARING module; a namespace import through a barrel only needed the loading
  (the checker's scope already had the declaration, just no home module). Without it the barrel broke
  everything reaching js-parser (`call to unknown function 'terminal'`). Survey-neutral. Remaining
  edge: a NAMESPACE access to a RENAMED re-export (`NS.dbl` via `export {twice as dbl}`) -- the two
  `nsTarget` sites look up by the public name, not `nsDecl.name`.
- **nullable `any`**: `builtinTypes.any`/`unknown` were the non-null `REF_ANY`, so an `any` could never
  hold `undefined` and `x !== undefined` on one was refused. Now `REF_ANY_NULLABLE`, plus `wtypeOf`
  keeps the slot's type when the narrowing is nullish-only (`a = undefined`). **The null-comparison
  row (26) is gone**, moved to `uncached` (1 -> 19) and `parseInt` (0 -> 8); zero blast radius in
  test-towasm and difftest (measured behind an in-place toggle before flipping the default).
- **TRAP, hit here**: that toggle read `process.env` INSIDE towasm.ts -- which is itself a SURVEYED
  file. The toggle-on survey compiled the toggle too: a fake 29-block `unresolved identifier 'process'`
  row, which masked the `Parser<any>` row and made it look cleared, and a bogus "54 moved". Remove every
  toggle from a surveyed file before surveying, and diff the cause TABLES against the last clean run.
- **Next session's top rows**: the object-literal alias row (24); `Parser<any>` (22, below -- NOT
  cleared); `call to unknown function 'uncached'` (19, type-utils -- a nested `function` declaration
  called before its textual position: towasm doesn't hoist nested function declarations); `parseInt`
  (8, js-parser -- the wasm lib has only `Number.parseInt`/`parseFloat`, no global functions).

## Nested function hoisting -- `emitStmts` (2026-09-10, late)

`uncached` is closed. A nested `function` was only materialised at its own statement, so a call above
it (`resolve`'s `const result = uncached(); ... function uncached()`) was an unknown function. Every
statement-list site now goes through `emitStmts`: a pending nested function is created just before the
FIRST statement in its list whose free names mention it (`collectFreeVars`, computed only while
something is pending), pulling in pending siblings it mentions first. Not at block start: closures
capture by value, and creating it at first mention means its captures already exist; forward holders
(`ensureForwardHolder`) cover a later `const`/`let` sibling.
- **OPEN: mutual recursion between nested functions** (`isEven`/`isOdd`) -- `ensureForwardHolder`
  scans only `var_decl` siblings, not function declarations. The fix is to extend it to them.
- An old `checkThrows` test PINNED "no hoisting" as expected behaviour -- exactly what
  [[feedback_no_unimplemented_throws_tests]] forbids; it is now a value check.
- Survey: `uncached` (19) and `call to unknown function 'recurse'` (4) gone, 23 moved, nothing
  regressed (57/275). They landed in `'a?.hitDepthLimit(...)' is not supported -- returns 'void'`
  (2 -> 19: `this.parent?.hitDepthLimit(fn)`, an optional call to a `void` method used only as a
  statement) and `unresolved identifier 'recurse'` (2 -- probably the mutual-recursion case above).
- **CLOSED**: `a?.m()` as a STATEMENT on a `void` method -- `want === 'void'` lowers to a guarded call
  with nothing to yield. `hitDepthLimit` row 19 -> 0; they moved to `unknown method 'isArray'` (7 -> 25).
- **`Array.isArray`** is a lib static: `typeof x !== 'string' && __asm('ref.test (ref array)')` -- a
  string shares the `i16[]` wasm form. The asm grammar needs `ref.test (ref <heap>)`, not a bare name.
  Declared `x is any[]`, so the checker narrows through it: that ALSO removed four checker false
  positives in type-utils.ts. Survey: `isArray` 25 -> 0, `removeRules` newly compiles -> **58/275**.
- **Top rows after this session**: object-literal alias (24), `Parser<any>` (22), `find` (17, below),
  getter `a?.length` (13), `typeof` used as a VALUE (6, `unsupported unary operator 'typeof'`).
## 2026-09-11: the `find` row CLOSED (`d4c25a4`, `b669846`) -- and two SILENT miscompiles under it

The row was a CHECKER gap, not codegen: `resolvedParts` is `(Ty[] | Lit[]).map(...)` and the call typed
as `any` silently. My first repro (`readonly number[] | number[]`) was the WRONG shape -- same element
type, so only the identical-signature merge applied; the survey said `find` 17 -> 20, not gone. **Probe
the real declaration (`probe-decl`) before trusting a hand repro matches it.** Fixed, all general:
- union of signatures identical up to type-param renaming = one signature (`T.mergeIdenticalSignatures`);
- a method on a union of arrays is called on ONE array of the combined element (`T.arrayUnionAsArray`,
  TS 5.2); indexing such a union reads the combined element (a desugared `for...of` got `any`);
- a tuple's positions are real properties in `lookupMember` (`'0'`, `'1'`), so a literal index on a
  tuple union reads per member AND `c[0] === 'aa'` narrows `c` (discriminant branch takes `index`);
- a numeric key prefers the numeric index signature (was: first index signature that admitted it);
- codegen: a `var_decl`'s method-call bypass read `map<U>(): U[]` raw -> `arr:ref` vs real `arr:f64`.
Corpus A/B: +1, numericIndexerTyping2 -- a STALE baseline (no `.errors.txt`, but real tsc errors
there; check with `npx tsc --noEmit --ignoreConfig` before believing a "false positive").
Survey: 22 moved, `negValue` compiles, **59/277**. The next wall is `new Map([[t.keyName, Literal(key)]])`
(`cannot convert ref:Map<any,...>`, 20, type-utils `resolve`).

**Two silent WRONG RESULTS found by the regression test, both pre-existing -- fixed, not worked around:**
- `operandInfo` read `ctx.scope`, not `narrowedTypeOf`: `hit.type === 'lit'` on `Ty | undefined` inside
  `hit && ...` was `any`, so `===` became `ref.eq` -- string IDENTITY. `'lit' === hit.type` was right.
- **`===` with a boxed `any` operand was `ref.eq`**: `anyStr === 'lit'`, `anyNum === anyNum2`, and
  `['x','yy'].indexOf('y'+'y')` (-1!) / `includes`, since `Array<any>` compiles `this[i] === x`. Now
  `ensureAnyStrictEq`: a late-built helper comparing strings (`String.eq`) and f64/i32/i64 boxes by value,
  anything else by identity. Numbers always enter `any` as `f64` boxes (verified), so no int/float split.
  NOT covered: bigint `i32[]` limbs -- `typeofHeapType` conflates them with `boolean[]` storage.
- `toWAT` exists (`mod.toWAT({expandTypes, hexFloats})`, binary-libs wasm.ts) -- `assistant/wrun-wat.ts`
  prints it with `WAT=1`. Read the WAT instead of reasoning about emitted code.

## 2026-09-11 (later): `Parser<any>` CLOSED -- and a survey result I had to retract

**Retraction**: `0eb2ccf` reported the `Parser<any>` row gone. It was my own `backToDeclaredMembers` mapping
refined parts onto an `any` member (everything is assignable to `any`), hiding the conversion; `f9dfeee`
excludes `any` and says so. **A row vanishing right after a narrowing/mapping change: probe one of its
declarations before believing it.**

What actually closed it (all general):
- `new C(...)` builds the instantiation its destination (`want`) names -- two instantiations are two structs.
- A generic CALL's type args: where the result is going (else the checker's own type for the call, lazily)
  REPLACES an `any` the arguments left (`inferTypeArgMap`). ts-parser's `make()` inferred `T = any` from its
  spread-heavy spec literal.
- `interface X extends Y`: X's shape is a wasm SUBTYPE of Y's (Y's fields first; `superClass` set), the
  interface analogue of class `extends`; bases marked non-final by a pre-scan (`markExtendedInterfaces`).
- A dynamic-object literal's `k: v` -> `map.set` result was never dropped (commented-out `drop`): a stray
  value shifted every later struct field -> invalid wasm.
- A lazy module-level global's initializer now gets its declared type as context (`withContext`), like a local.

## IMPORTED MODULES WERE NEVER CHECKED -- only hoisted (`exportScope`)

So their bodies had no per-statement scope stamps (narrowing) and local annotations no `declScope`. The
survey HID this: it compiles each file as the ENTRY. Real self-hosting (towasm.ts as entry) compiles every
other module as an import. `TStoWasm` now runs `checkHoisted` (muted, stamping, no re-hoist) once per
module record. **And a latent checker bug under it**: `checkStmt1` stamps a `function_decl`'s `.scope` as a
STATEMENT before `checkFunctionBody` runs, and that is the same property as `fn.scope`, so every muted pass
(the lib's too) skipped every top-level function body as "already walked". "Walked" is now read off the
body's first statement. Corpus: GAP -3, nothing else moved. Local `var_decl` annotations are stamped too.

## 2026-09-11 (end): object-literal row 25 -> out of the top ten; 61/281. NEXT, in order:

1. **Generic-shape PHYSICAL LAYOUT (the general fix, a rewrite).** Two instantiations of one generic
   interface/alias are two structs (`Params<number>` vs `Params<any>`), so any `T` mismatch between the
   builder and the reader traps at runtime -- repro `assistant/xmcs/` (three modules, `ROOT=assistant/xmcs
   assistant/probe-run2.ts`): the literal is built `CallSig<number>`, `JS.sig(...args)` instantiates at
   `T = any`, dispatch falls through to `unreachable`. The identical-layout TWIN merge only covers a subset.
   Fix: ONE layout per generic shape, fields that depend on a type parameter stored ERASED (boxed
   `anyref`), reads coerced to the instantiation's type -- then every instantiation shares a struct.
2. **Inference across a namespace alias**: `CallSigParams<T>` vs `JS.CallSigParams<number>` -- the named
   match compares ref NAMES, so a dotted alias misses and falls to structural unfolding.
3. **Dynamic call on `any`** (`params[0](() => rules)`, core.ts `Rules`): row 22. Needs a uniform boxed
   calling convention for closures (every closure reachable through `any` callable with boxed args).
4. **Checker: `strictNullChecks` off** (TS's default): ~223 of ~845 corpus false positives are null/
   undefined assignability in non-strict files. Option on the scope chain (default strict, so towasm is
   unchanged); non-strict = nullish source assignable to anything, `memberOptional` adds nothing; harness
   parses `// @strict` / `// @strictNullChecks` onto a per-file child of the shared lib scope.
5. **Checker: iteration over an `Iterable`** is `any` (`for...of` element type handles only arrays and
   strings); array-literal context from `Iterable<X>` and inference through it (Map's iterable overload).

## NEXT (diagnosed 2026-09-11, not started): the object-literal row (25) is MISSING CONTEXT, not a shape gap

First site, ts-parser.ts:599, `parameter_clause.push(Rule([...], $ => ({ ...$[0], returnType: $[2] } as const)))`:
the literal is a callback's return with `want` = boxed `any` and NO `ctx.contextualReturn`, so
`matchObjectShape` sees several fits (`CallSig<any>` plus all-optional `Partial<...>` shapes) and refuses to
guess -- rightly: a heuristic tiebreak (e.g. prefer non-"weak" types) would build a struct the consumer may
not cast to. Context is dropped at two hops; thread it with `withContext`, as fields/array elements/lazy
globals already are:
1. `emitCallArgs`: each argument should get its parameter's TS type as context (a rest arg: the element).
   Then `Rule(...)` inside `push(...)` sees `Rule<CallSig>`, and `inferTypeArgMap`'s `expected` binds `T`
   before the deferred callback-return inference can bind it to the literal's own type.
2. A closure literal whose context is a function type should give its `return`s / concise body that
   type's `returnType` as context (`emitClosureLiteral`, towasm.ts ~4644; `case 'return'` ~6965).
DONE 2026-09-11 (both hops, `withContext`: `emitCallArgs` per argument; `plainReturn(result, context)` for
closures -- captured at the literal, the body compiles later -- plain functions and methods). Line 599 now
compiles; line 600 does not, and the reason is OVERLOADS: `Rule` has two generic overload signatures and a
NON-generic implementation `Rule(rhs, action?: Action<any, any>)`. Codegen compiles the implementation, so
the action's context is `Action<any, any>` -- only the CHECKER's chosen overload knows `T = CallSig`. Next
step: stamp the callback node with its checker-side contextual type (the substituted `declared` at
`applyContextualParams`, checker.ts `case 'call'`), and have `emitClosureLiteral` fall back to it. Care:
the same call is typed more than once, with and without context, so first-wins may keep the worse one.
LATER 2026-09-11: the checker now stamps a callback node's `contextualType` (only once fully determined,
defaulted type params filled), rest ARGUMENTS are contextually typed (`declaredArg` in the pre-pass), and
`matchContextualUnionMember` skips spreads. Repro `assistant/ov1.ts` (overloaded `Rule` + push into
`Rule<CS>[]`) now picks `CS` and compiles -- but traps `illegal cast` at runtime: the non-generic
IMPLEMENTATION builds `{rhs, action}` with `action: ($) => any`, read back as `Rule<CS>`. And ts-parser.ts:600
itself still reports no context: `assistant/ctx-probe.ts` (LINES=...) showed NO stamp on its arrow -- unexplained
(the probe's line filter was flaky); start by confirming whether that call's checker pass has `expected`.
NOTE: the lazy checker-call-type fallback (`() => checkerTypeOf(e, ctx.scope)`) does NOT help here -- the
checker types the call in isolation, without push's expected type, so it too answers `Rule<{literal}>`.
Second site, type-utils.ts:448 (`freeze`): `{ ...t, frozen: true }` with `t: Literal | RangeType` -- a
spread of a UNION needs a runtime `ref.test` cascade building each member's struct. A separate feature.

## The `Parser<any> -> Parser<{...}>` row (22 decls) -- one root, partly characterised

21 of the 22 are tiny towasm.ts helpers: towasm.ts imports ts-parser.ts, whose module-level
`const parser = make()` fails, and an IMPORTED module's init is not recoverable the way the entry's is.
A real blocker, not an artifact -- compiled towasm needs that parser. The error carries no position.
- Plain nested inference is NOT it: `outer<T>(spec: Spec<T>): P<T> { return inner(spec); }` compiles.
  The `any` comes from somewhere in `makeCachedParser`'s real shape (options spread, try/catch, the
  `LALRParser<T>` return of `makeParser`) -- bisect that next, from `assistant/repro/parser1.ts`.
- **A sibling gap found on the way**: an interface that `extends` another can't be converted to its
  base at the SAME type argument -- `LP<{a}> -> P<{a}>` is `internal: cannot convert`. `LALRParser<T>
  extends Parser<T>` is exactly that shape. See [[tison_interface_inheritance]] before touching it.

## Measured state (clean survey at `c3c208e`, 2026-09-07) -- 45/263, `assistant/survey-c3c208e.txt`

| blocks | files | cause |
|---|---|---|
| 29 | towasm.ts, lalr.ts | `class 'Map' needs 2 explicit type argument(s)` -- the towasm.ts domino, now at line 194 |
| 24 | checker.ts | `internal: cannot convert i64 to ref:any` (checker.ts:48) -- ALL of checker.ts, one cause |
| 16 | towasm.ts, type-utils.ts, peg.ts | comparing to null/undefined needs a nullable object-typed value |
| 16 | ts-parser.ts | `WithTextPos<ValuesOf<...>>` has no representation |
| 8 | js-parser.ts | closure parameter needs an explicit type |
| 7 | type-utils.ts | `'a?.length' on a getter is not supported` |

**59 declarations moved** since `b360b91`. The spread row (31) is gone entirely. `tocode.ts` remains the
one file that essentially works: 17/18 declarations and 21 functions as a WHOLE FILE.

## MEASURED STATE 2026-09-09 (`5e148b7`) -- 56/270, towasm.ts:193 CLEAR, tocode.ts COMPLETE

**towasm.ts:193 is done.** `const LIB_AMBIENT_MODULES = new Map(LIB_AST.filter(...).map(n => [n.name,
n]))` blocked 30 of towasm.ts's 41 declarations for most of two sessions. Clearing it took SEVEN
general fixes, none specific to that statement -- it was an unusually good probe:
tuple inference in `inferTypeArgs`; contextual array literals; `Extract` distribution; dotted-name
abstractness; the missing `undefined` binding; `??` + empty-literal context; and a
statically-shaped spread into a dynamic-object literal. See [[tison_checker_inference]].

Current causes (every row of the previous table is closed):

| blocks | files | cause |
|---|---|---|
| 17 | ts-parser.ts | `closure parameter 'self' needs an explicit number/boolean/object type` |
| 16 | towasm.ts, ts-parser.ts | `unknown field 'recover'` |
| 16 | towasm.ts, type-utils.ts | comparing to null/undefined needs a nullable object-typed value |
| 11 | checker.ts, type-utils.ts | `'a?.length' on a getter is not supported` |
| 10 | towasm.ts, transform.ts, type-utils.ts | `unresolved identifier 'isJsStatement'` |

Flatter than it has been: no single wall left, and towasm.ts's declarations are now spread across
several causes rather than piled behind one.

## DO NOT TIGHTEN ASSIGNABILITY YET -- measured 2026-09-09, and reverted

The leniencies in `isAssignable` look wrong and are load-bearing. Probing nine invalid assignments,
seven are already rejected correctly; two are not: `boolean -> false`, and **`A -> B` for two
unrelated classes**. The second is a real hole opened by `bfd0aeb` (classes stay nominal, so both
sides reach the "unresolved names: lenient" fallback as refs instead of being expanded and compared
structurally) -- and probably part of why that commit showed 468 FEWER corpus errors.

Fixing it properly needs BOTH leniencies: the early `unresolved named source` bail AND the final
fallback, with differently-named class refs compared via `resolveMembers`. That works -- and costs
**+13 corpus errors, 0 removed: 7 in files TS expects errors in, 6 FALSE POSITIVES concentrated in
`genericClassWithObjectTypeArgsAndConstraints`** (a generic class against a constrained type
parameter), plus 2 more in tison.ts where tsc is clean. Roughly 1:1 true-to-false.

**The leniencies are absorbing errors our own type-argument inference creates.** The same imprecision
shows up as `realRoot<polyType>` (`ba8a867`), `NodeMap<Stmt[]>` (`b927285`), and those 6. Tighten
before fixing that and silent imprecision becomes loud false positives, which is WORSE than the
status quo because a false positive blocks `tsw` outright. **Order: fix type-argument precision
first (constraint-instead-of-argument substitution is the recurring culprit), then tighten.**

## MEASURED STATE 2026-09-08 (`132771a`) -- 55/270, and tocode.ts is COMPLETE

**`tocode.ts` compiles 18/18 -- the first target file to compile completely.** Per-file: type-utils
22/94, tison.ts 7/12, lalr.ts 6/16, peg.ts 2/7, and checker.ts / towasm.ts / transform.ts /
ts-parser.ts / js-parser.ts / walker.ts / binary-libs wasm.ts all still 0.

Top causes now (every row from the old table is closed):

| blocks | files | cause |
|---|---|---|
| 21 | towasm.ts, ts-parser.ts | `internal: 'parse' has a non-literal default with no resolved parameter info` |
| 16 | towasm.ts, type-utils.ts | comparing to null/undefined needs a nullable object-typed value |
| 16 | ts-parser.ts | `WithTextPos<ValuesOf<readonly GrammarSym<any>[]>>` has no representation |
| 11 | checker.ts, type-utils.ts | `'a?.length' on a getter is not supported` |
| 10 | towasm.ts, transform.ts, type-utils.ts | `unresolved identifier 'isJsStatement'` |
| 9 | checker.ts | `unknown field 'scope'` |

The `internal:` prefix on the top row means an internal invariant, not a missing feature -- likely a
bug, and worth probing before assuming it needs a new capability.

**Two structural walls came down this session, each of which had been ONE cause hiding a whole file:**
- checker.ts's 25 declarations all shared `Maximum call stack size exceeded`. It was a self-referential
  FUNCTION TYPE -- `typeOf` -> `closureSigParts` -> `params.map` -> `typeOf` on the same annotation.
  checker.ts's own `checkStmt(s, scope, typeOf, checkStmt)` is exactly that shape. `T.resolve`'s cycle
  guard cannot see it: the loop is BETWEEN `typeOf` calls. Fixed with an identity in-progress set in
  `typeOf` returning `REF_ANY` (`3a93dc4`).
- towasm.ts's 30 declarations all shared line 193's `new Map(LIB_AST.filter(...).map(n => [n.name, n]))`.
  It took FOUR fixes to clear: tuple inference, contextual array literals, `Extract` distribution, and
  a dotted-name abstractness bug. See [[tison_checker_inference]].

**Instrument discipline that this session earned the hard way**: run the SLOW attributing instruments
(survey, `corpus-ab.sh`, the position-independent workspace diff) BEFORE committing a
checker/type-utils/lib change, not after. Three commits this session existed only to repair the
commit before, every one of them found by an instrument I ran post-commit. See
[[feedback_baseline_in_real_tree]].

**JSON is gone from the surveyed set** (`132771a`): `tocode.ts` owns `quoteString` (byte-identical to
`JSON.stringify`, committed test) and `lalr.ts` owns `entryKey` (structural `ActionEntry` identity).
The user directed this explicitly, against [[feedback_no_simplifying_deps_for_selfhosting]] -- the
justification was that neither file wanted a serializer, they wanted string-quoting and record
equality. Do NOT read it as licence to rewrite a target file that merely hits a gap; that is the
`pathKey` mistake below.

**`pathKey` -- a real mistake to learn from.** After adding narrowing for literal-indexed paths, the
function stopped compiling, and I rewrote its SOURCE to get it compiling again. The user caught it:
type-utils.ts is a SURVEYED file, so rewriting it improves the number without improving the compiler
-- gaming the instrument the whole plan is steered by. The real cause was `undefined` having no
binding on the wasm path at all (`f37c63c`).

## 2026-09-08 (later): the drain is COMMITTED, and the `Array<T>` top-level collapse is GONE

The user committed the microtask queue + export-drain wrappers as `3237b26` mid-session. On top of
that, `303f7fd` + `bfd0aeb`:

- **The `illegal cast` "in the await-resumption path" was not about await at all.** `promise.ts`'s
  `resolve` queued `() => cb(value)`; with `cb` read as `any` (the `Array<T>` ELEMENT collapse), that
  compiled to a `() => any` closure struct -- physically different from the `() => void` that
  `drainMicrotasks` casts the queue back to. Fixed by typing `cb` through a local.
  `conform/async` 49/56 -> **52/56, 0 disagreements**; remaining 4 are known unrelated gaps
  (generator `for..of` `.length`, `.then` returning `void`, then-chaining).
- **The six wrong-per-JS async tests are rewritten** to observe after the export boundary (a second
  exported call) and now also assert the JS-faithful "still 0 inside the call". `test-towasm` green.
- **The memory's diagnosis of the `Array<T>` top-level collapse was too narrow.** It is not generic-
  specific and not about `Array`'s ambient/real dual declaration: ANY named-class annotation on a
  MODULE-LEVEL binding lost its nominal identity (`class C {}; const c: C = new C(5);` -> `cannot
  convert ref:C to ref:{x:number;...}`). A local never hit it because towasm reads its raw annotation
  instead of the scope. Root cause and general fix: [[tison_nominal_class_refs]].
- **Two `promise.ts` workarounds turned out to have different roots**: the `(() => void)[]`-instead-of-
  `Array<() => void>` one is obsolete and is deleted; the `shift()` annotation stays -- it reproduces
  with the `T[]` spelling too, so it is the genuine `Array<T>` ELEMENT collapse (towasm.ts:7604),
  still open and still the root of the callback cluster.

**difftest is FULLY GREEN again -- 2090/2100, 0 disagreements** (`d95533f`, `baeba85`). The three
that were left both had a precise structural trigger:
- **`lib/typedarray.ts` had no float path at all.** `get`/`set` composed the element's bytes as an
  INTEGER for every element type, so `Float32Array`/`Float64Array` truncated going in and read back
  what they truncated to. A `TypedArray.isFloat()` static (same `(switch $T ...)` as `elemSize()`)
  picks a reinterpret path; f64 goes round as two i32 halves because `ArrayBuffer.set` and the byte
  loops are all i32. The reinterpret asm helpers already existed next to the commented-out
  `DataView` -- written, never wired up.
- **`collectCapturedMutables` listed every `for`-init binding as PER-ITERATION.** True for
  `let`/`const`; `var` is function-scoped, one binding for the whole loop, so it is precisely the
  case that NEEDS the shared holder. One condition on the declaration's own `kind`.

Both have committed regression tests in `test-towasm` (difftest lives in the gitignored
`packages/assistant/`, so it protects nothing across a clone).

## PARKED 2026-09-08: a STATIC lib file can't hold shared top-level state its own methods can read

Found chasing `conform/async`'s Promise-ordering disagreements (`lib/promise.ts`'s `then`/`resolve`
called callbacks INLINE even when already settled -- real JS always defers to a microtask, never
synchronous). The ordering fix itself (a `microtasks: (() => void)[]` queue; `then`/`resolve` push a
thunk instead of calling one) is written and hand-verified correct against every `conform/async` case
(traced by hand: e.g. `twoThensRegistrationOrder` 129 -> 9, `asyncOnlyFirstAwaitSync` 111 -> 1, matching
real JS) but **cannot be difftest-verified** -- it hits a new, general, previously-unexercised gap.
Left in the working tree, UNCOMMITTED (doesn't clear the auto-commit bar -- [[feedback_auto_commit_verified]]
-- since it's reasoned-correct, not empirically green).

**The gap, root-caused precisely**: a plain module-level `const`/`let` declared in a STATIC lib file
(`array.ts`, `promise.ts`, `map.ts`, ... -- the always-available `LIB_AST` bundle, distinct from the
entry module and from `lib/node/*`'s ON-DEMAND, `collectModules`-loaded files) is unreachable from any
function or method declared in that SAME file. Traced with temporary instrumentation in
`lazyGlobalFor`/`ensureClass` (added, verified, removed -- `towasm.ts` itself has no diff):
- `ensureClass`'s `homeModule` for a lib class comes from `stmtHomeModule.get(decl)` (towasm.ts:8144).
- `stmtHomeModule` is populated by exactly one loop, over `moduleBodies` (towasm.ts:9275) --
  `['.', entry]` plus `modules` (files reached via `collectModules`, how `lib/node/*` gets in). **Static
  `LIB_AST` files are never added to `moduleBodies` at all.**
- So `stmtHomeModule.get(decl)` is `undefined` for `Promise`'s class decl, and since
  `FunctionContext`'s `homeModule` param defaults to `'.'` on `undefined`, every `Promise` method
  silently compiles as if it belonged to the ENTRY module.
- `resolve()`/`then()` then read `microtasks` via `lazyGlobalFor`, which -- believing it's in `'.'` --
  looks in `topLevelVars`, ALSO only populated from `moduleBodies` (towasm.ts:9318) -- so
  `microtasks` (declared in `lib/promise.ts`, never scanned by that loop either) isn't there. Throws
  `unresolved identifier 'microtasks'`.

**Bisected the trigger precisely** (isolated repros, all reverted, none committed):
- A top-level `const`/`let` in the ENTRY module works fine for scalars, strings, AND arrays -- read,
  written, indexed, `.length`, `.push`, all correct (verified by actually running the wasm, not just
  compiling it: `let n=5; export function check(){ n=n+100; return n; } ` -> real `105`).
- A SCALAR top-level const in a static lib file also works -- it goes through a separate, simpler path
  (towasm.ts:4950-4959, straight off `LIB_DECL_MAP`) that never needs `stmtHomeModule` at all. This is
  exactly why the gap was never noticed before: every existing static lib file either has no shared
  top-level state, or only a scalar one.
- Only a NON-scalar (array/object/class-typed) top-level binding in a static lib file, read from a
  function/method IN THAT SAME FILE, hits the missing `ensureLazyGlobal` wiring above.

**Separately, also found and fixed (real, committed-worthy on its own, not blocked)**: an EXPLICIT
`Array<T>` generic annotation on a top-level (module-scope, not local) `const`/`let` resolves through
the checker's `declare class Array<T>` / `array.ts` dual-declaration merge to the INTERFACE's fully
expanded structural shape (an object type with `[i:number]:number`, `length`, methods, ...) instead of
staying a nominal array type -- `ownerFor`'s `case 'ref': if (w.name === 'Array')` never fires, member/
index dispatch falls through to "unknown field"/"indexing is only supported on ...". Reproduces for
`Array<number>` exactly as for `Array<() => void>` -- not closure-specific. **Only a TOP-LEVEL annotated
binding triggers it**: the `T[]` shorthand (`number[]`, `(() => void)[]`) resolves correctly at module
scope, and an explicit `Array<T>` annotation on a LOCAL variable also resolves correctly -- it's the
intersection of "top-level" and "explicit generic name" that's wrong. This is exactly the fragile
territory [[tison_towasm_self_hosting_plan]]'s own `fb7e12b`/`c3869ae` entry already flags (`Array`'s
ambient-interface/real-class duplication "must stay", removing it previously took walker.ts 1->29
checker errors) -- did NOT touch it. Sidestepped in `promise.ts` by writing the queue as
`(() => void)[]`, which is the idiomatic spelling here anyway (the rest of the file already prefers
`T[]` over `Array<T>` for annotations, reserving the generic form for `new Array<T>(n)`).

## RESOLVED 2026-09-08 (`bdedd90`) -- the diagnosis above was WRONG, and no pipeline change was needed

The prescribed "extend `moduleBodies`/`stmtHomeModule` to cover `LIB_AST`" was not the cause. A lib
FUNCTION reaches a lib const fine (`LIB_DECL_MAP` already resolves it); the claim that it is
"unreachable from any function or method" was too broad. Three separate, ordinary gaps:

1. **The eager-global path was unconditional.** A lib module-level binding registered a wasm global
   whatever its initializer, so a non-scalar one threw "needs a compile-time-constant initializer" at
   emit time -- and, having registered it, SHADOWED the `lazyGlobalFor` fallback immediately below
   that exists for exactly this. Gated on the same test the entry scan uses; `lazyGlobalFor` now finds
   a static-lib declaration under ONE fixed identity for the whole lib (`'#lib'`). Per-FILE identity is
   the wrong granularity — `LIB_AST` is a flat concatenation sharing one `libGlobal` — and a
   per-caller `ctx.homeModule` fallback would be actively wrong, giving each referencing module its
   own copy of the shared state.
2. **`() => sideEffect()` did not compile at all** — a concise arrow body becomes `return <expr>`, and
   a `void`-returning callee has no value to return.
3. **A `void` expression returned where the signature declares a value** now yields `undefined`, per
   JS. Routine once a `() => void` closure meets an `any`-returning signature, which `Array<T>`'s
   single physical bucket for non-scalar elements guarantees.

Two further one-liners went into `promise.ts` itself: `microtasks.shift()` needs an explicit
`(() => void) | undefined` annotation (the `Array<T>` collapse makes its inferred type `any`, so the
call resolved as a function NAME), and `then` must read `this.value` at drain time rather than binding
it to a local, since `Promise<void>` makes that local's type `void`.

**`conform/async` is 52/56 with 0 disagreements** (was 41/56 with 11) -- the ordering work is correct.

## THE SIX FAILING TESTS ARE WRONG-PER-JS -- verified in node, 2026-09-08

They are all of the shape "resolve a promise, call an async function, read the result in the SAME
synchronous call". Run in real node, that shape gives **0**, exactly as the microtask version does;
the value appears only after the job boundary. So they were pinning the OLD synchronous design, the
same way `(255).toString(16)`'s uppercase and the `Infinity | 0` saturation expectations were.

Rewriting them around an explicit `drainMicrotasks()` works end to end -- verified: resolve, call the
async function, drain, read -> 42, matching node's post-boundary value.

## AUTOMATING THE DRAIN -- BUILT 2026-09-08, blocked on one further gap (UNCOMMITTED)

Implemented in the working tree: each EXPORT is re-pointed at a wrapper that emits
`call __towasm_enterCall` / `call <real>` / `call __towasm_exitCall`, built after the worklist drains
and gated on `lazyGlobalSlots.has(homeKey('#lib', 'microtasks'))` -- so the lib DIRECTS it by
referencing the queue and a promise-free module is unchanged down to its function indices.

**Verified working with an UNCONDITIONAL drain**: `main()` -> 0 and a later `after()` -> 42, exactly
matching node's before/after-the-job-boundary values.

**NO DEPTH COUNTER IS NEEDED** -- the user's observation, and it is right: "outermost" is STRUCTURAL.
The wrapper is a separate function that only the export TABLE points at, so an internal call --
INCLUDING one export calling another -- resolves to the real function's own index and never goes
through a wrapper. A wrapper therefore only ever runs with the host as the caller. Verified: an export
calling another export does not drain early (`outer()` -> 0, then 7), byte-identical to node on the
same shape. Both hooks collapsed to a single `__towasm_exitCall`, and `callDepth` is gone.

(A counter WOULD be needed if wasm could re-enter an export through a host callback; there is no such
mechanism here.)

**Latent gap found on the way, worth keeping**: an ASSIGNMENT to a lib module-level global writes to a
LOCAL rather than the global -- `__towasm_enterCall`'s body was `global.get 3 ... local.set 0`, so
`callDepth = callDepth + 1` read the global and dropped the result. That is the WRITE side of the same
lib-global wiring whose READ side `bdedd90` fixed. No longer on the critical path, but real.

**NEW SIGNAL, previously masked**: with the drain actually running, 3 `conform/async` cases hit
`illegal cast` at runtime. Narrowed: `async f(): Promise<number> { return 3 }` + `.then` works, while
an AWAITING one (`const v = await p; return v + 1`) + `.then` fails. It is in the await-resumption
path and was invisible while nothing drained. Not investigated.

**Still uncommitted, and test-towasm is RED**: 6 async tests assert the pre-microtask synchronous
behaviour (verified non-JS in node) and need rewriting to observe after the boundary -- call the
export, then a second export that reads the result.

## The original design sketch (asked for 2026-09-08)

Wanted: not hardwired into the compiler, but directed by the lib actually referencing the queue.
Shape that fits this codebase:

- The compiler looks up ONE well-known lib hook by name. That is an established idiom here, not the
  name-special-casing [[feedback_no_name_special_casing]] forbids (which is about USER names):
  `LIB_DECL_MAP.get('stringTemplate')`, `'bigFromNumber'` and `'bigToNumber'` are all already done
  exactly this way.
- Each EXPORTED function gets a trivial wrapper -- push params, `call` the real function, `call` the
  hook, return. The result sits on the stack underneath a void call, so nothing else is disturbed, and
  it handles multiple `return`s for free where an epilogue could not.
- **Gated on the machinery actually being reached** -- e.g. the `microtasks` lazy-global slot existing
  after the worklist drains. A program that never touches promises emits nothing.
- Ordering note: the export loop (towasm.ts:9561) runs BEFORE the worklist, so the Promise class may
  not be instantiated yet. Build the wrappers after the worklist and patch `mod.exports`' indices.

This is faithful to JS: a host call to a wasm export IS the job, and JS runs microtasks at the end of
one. It does commit the runtime to "every exported call drains on the way out".

## The fork, if the drain is NOT automated

With the queue in place, **six existing `test-towasm` async tests fail**, all of the shape "resolve a
promise, call an async function, read the result in the SAME synchronous call". They get 0, because a
`.then`/`await` continuation now only runs on `drainMicrotasks()`. These are not ordering tests; they
are "does async/await work at all" tests.

Draining at the entry boundary does NOT rescue them either -- they need resumption BEFORE the exported
function returns, which is precisely what deferring forbids. So the fork is real and only two-sided:

- **Synchronous resumption (today, committed)**: async/await works end to end; 11 `conform/async`
  ordering cases diverge from real JS.
- **Microtask queue (`promise.ts`, UNCOMMITTED in the working tree)**: ordering is JS-exact; a program
  must call `drainMicrotasks()` itself, and those six tests must be rewritten around that.

The three compiler fixes are committed and independent of this choice -- they are correct either way.

**INSTRUMENT BUG, fixed in `assistant/selfhost-survey.ts` (gitignored, so it lives only in the working
tree): `errText` stopped at the first `.msg`**, but a `TSWError`'s `msg` can be ANOTHER `TSWError` --
they nest as the error propagates out through scopes -- so the cluster rendered as **`[object Object]`**
and hid all 24 of checker.ts's declarations behind a meaningless row. It now unwraps until a string.
**`probe-decl.ts` was unaffected and gave the real message immediately** -- when a survey row looks
meaningless, probe a declaration rather than believing the table.

### The array-callback gap, diagnosed 2026-09-07 (ref-element half still open)

`[1, 2, 3].map(x => x * 2)` does not compile. **Arity is NOT the problem** -- `coerceTop`'s fewer-params
wrapper handles that, and an annotated callback works at any arity. Two distinct causes:

- ~~A bare integer array literal types its elements `i32`~~ -- **CLOSED `b6e30ae`**, see above.
- **A callback over a REF-element array needs its params COERCED, not matched.** `['a','bb'].map(x =>
  x.length)` fails `(arr:i16)=>...` vs `(ref:any,...)`, **and annotating does not help**: `Array<T>` uses
  one physical `arr:ref` bucket for every non-scalar element, so its methods compile at `T = any`.
  `ensureClosureCoercionWrapper` requires shared params to be EQUAL, so it declines. Extending it to
  insert a per-argument cast is the real feature. 5 difftest cases are already red on this
  (`lang/arrayMap`/`arrayFilter`/`arrayReduce`/`arraySome`/`arrayFlatMap`).

The two interact: `[0, ...b.filter(x => x > 0)]` works for `number[]` and fails for `string[]`.

### THE `Array<T>` COLLAPSE (towasm.ts:7604) -- the root of the callback cluster, measured 2026-09-07

```ts
if (name === 'Array') {
    if (typeArgs?.[0].type !== 'ref' || (!TYPED_ARRAY_TAGS.has(...) && name !== 'number'/'boolean'/'any'))
        typeArgs = [T.ANY];
}
```
**Every `Array<T>` whose T is not a wasm pseudo-type / `number` / `boolean` / `any` is collapsed to
`Array<any>`** -- one ClassInfo, all methods compiled at T = any. That is why `Array<number>.map`
substitutes (`(f64,f64,arr:f64)`) and `Array<string>.map` does not (`(ref:any,f64,arr:ref)`), and why
annotating the callback does not help. It is the root of the ~18-block callback cluster, of the
recorded "generic method's `U[]` result stays `arr:ref`" limitation, and probably part of the spread row.

**MONOMORPHIZING PER `T` IS THE WRONG FIX -- do not do it (established 2026-09-07).** Because storage
is uniform (`arr:ref` for every non-scalar T), the callback can be ADAPTED AT THE BOUNDARY instead:
`ensureClosureCoercionWrapper` already handles arity and the result, and line ~4479 pushed the args
RAW. Coercing each arg (`coerceTop(wantSig.params[i], ..., gotSig.params[i])`) plus relaxing the
`wasmTypeEq` guard to allow a REFERENCE mismatch is **~2 lines** and makes the closure conversion
succeed. Patch parked at `assistant/wip-closure-param-coercion.patch`.
**Guard rule that matters: both sides must be reference types.** A scalar mismatch (`f64` caller,
`i32` callback) is a LOSSY narrowing -- silently truncating an argument is worse than the error it
replaces -- which is why the integer-literal misinference stays a separate fix.

### `TYPEINDEX("T[]")` (`30f26fe`) -- an asm names a type index by its TYPE

The user's design, and it superseded `$ret`/`$p0`/`$p2` the same day. The assembler stays ignorant of
TS types (the boundary wat-parser's `toWasm` note draws): `TYPEINDEX("...")` lexes as an ordinary
STRING, lowers to a `type:`-prefixed sentinel, and towasm resolves it afterwards in
`resolveTypeExprs` -- the sibling of `resolveAsmLocals`. `ID` always starts with `$`, so the sentinel
cannot collide with a name and `index` never had to widen. **It also deleted the per-instantiation
re-parse**: nothing is baked in at parse time, so the asm parses ONCE.

**Two traps, both cost real time:**
- **`array.copy` carries `dst`/`src`, NOT `typeIndex`** (wat-parser `FB_OPS.TYPE2`). Resolving only
  `typeIndex` left sentinels in place, surfacing much later as "The number NaN cannot be converted to
  a BigInt". Check which FIELD an op's type operand lands in.
- **A type expression must be looked up against the SIGNATURE this call settled on**, keyed by the
  type as written -- not resolved independently. With no explicit type args, `T[]` alone falls back to
  `arr:ref` while the signature already took `arr:f64` from the argument, and the operand then
  disagreed with its own operands.

### CLOSED `94f2151`: `$ret` -- an inline asm can name its own return type's index (SUPERSEDED, see above)

`$this` in a STATIC was the bug (user's own diagnosis): it names the ENCLOSING CLASS's array type, so
`Array._alloc<T>(n): T[]` allocated `arr:ref` for every T. `makeAsm` already had `resolveType` to turn
`T[]` into a WasmType; the missing step was WasmType -> type INDEX, with the CALL SITE's type args
substituted. `emitMethodCall` had `typeArgs` all along and the inline path dropped them. An asm
mentioning `$ret` is now parsed per resolved index, memoised. The wrapper param-coercion landed with
it. `['a','bb','c'].map(x => x.length)[1]` compiles and returns 2.

**CLOSED `033c43c`, and the user's framing was the better one: A STATIC MEMBER CANNOT SEE ITS CLASS'S
TYPE PARAMETERS.** Real TS says so outright, so `substituteClassTypeParam` simply restores statics
verbatim -- truer to the language AND simpler than teaching the walk about shadowing. (`Array<any>`'s
`_alloc<T>(n): T[]` had its own unrelated `T` rewritten to `any[]`.) With `T` genuinely open in a
static, `$this` is wrong for `_copy`/`_fill` too -- they now name `$p0`/`$p2`, their own declared
parameter types, the same way `_alloc` names `$ret`.

**A generic asm called with NO explicit type arguments** (`Array._copy(dst, 0, src, 0, n)`) takes the
ARGUMENT's physical type for an open position -- **and only for an open position**: overriding closed
ones too took difftest 12 -> 50, because a coercion `emitInline` would have emitted silently vanished.

**Traps hit implementing `$ret`, worth not repeating:** the early-return branch must sit AFTER
`resolveAsmLocals`' `const` (an early return skips its initialisation, and the closure then hits TDZ);
and `makeAsm` is module-level, so `ensureArrayType` has to be passed in as a resolver.

**The older next-layer note (now historical)**: `in Array<any>.map<number>: cannot convert arr:ref to
arr:f64`. `Array._alloc<T>` (array.ts:14) is `__asm('array.new_default $this')` -- **`$this` is the
ENCLOSING CLASS's array type, not `T`'s** -- so `map<number>` over a ref array allocates `arr:ref`
where `number[]` is `arr:f64`. THAT is where a real per-instantiation cost lives, and it is bounded by
the ~7 array KINDS, not by the number of element types. array.ts:189 already documents a sibling of
this limitation.

**Two decisions ride on that one line and only one of them is sound:**
- **Shared PHYSICAL storage** -- one `(array anyref)` for every ref element -- is right and should stay.
  wasm-GC arrays are INVARIANT, so per-element array types would make `Foo[]` unassignable to `any[]`
  and force copies.
- **Shared CLASS IDENTITY** is the over-reach: it erases T from every method signature.

**Measured cost of removing it (do not repeat this, it is recorded):** removing the collapse entirely
takes difftest from 16 -> **71** unsupported; allowing only `string` through still gives **56**. 0
disagreements either way -- it fails loudly, not silently.

**The dominant failure names the missing piece**: `array.len[0] expected type arrayref`. A per-T
`Array<string>` no longer resolves `thisWtype` to the shared `{arr:'ref'}` array type, so its own
`length` getter (`__asm('array.len')`) runs on a non-array `this`. **So the decoupling is concrete:
pin `Array<T>`'s `thisWtype` to `ARR_WTYPE[elementKind(T)]` regardless of instantiation identity, and
coerce element reads/writes inside the methods.** Tractable, but a real project -- not a one-liner.

### `[1,2,3]` is ALREADY `(array (mut f64))` -- there is no integer array to protect

Checked before "fixing" the callback param inference: a bare integer array literal already gets f64
storage (one shared f64 array type for `[1,2,3]`, `[1.5,2.5]` and an annotated `number[]` alike).
The callback param being inferred `i32` is a plain MISINFERENCE, not a storage decision -- typing it
`f64` promotes nothing at runtime, and leaving it `i32` would truncate. Only typed arrays
(`Int32Array`/etc) give integer storage. Giving `number[]` i32 storage would be a separate, much larger
question with real observable-semantics risk (`[1, 2.5]`).

### `fae8b1d`/`c2fd745`/`2d2f1e2`: `checkStmt1` binds a walk, and it exposed a real checker bug

**FINAL shape is `c3c208e` -- the user's own design, OPEN RECURSION.** `checkStmt` takes ITSELF as a
parameter, so a caller's wrapper IS the walk and every recursion re-enters through it:
```ts
type checkStmt = (s, scope, typeOf, checkStmt) => void;
checkBlock(body, inner, typeOf1(err), (s, scope, typeOf1, checkStmt1) => {
    stamp(s, scope);
    checkStmt(s, scope, typeOf1, checkStmt1, err);
});
```
Plain inline functions at the four call sites replace the factory + `stampScopes`/`afterReturn`
composition I built. **`err` needs no type change**: the wrapper closes over it and re-supplies it on
each entry -- that is what open recursion buys, and forgetting it silently drops every statement
diagnostic. Keep the stamp as `??=` (first real check wins over a speculative re-walk) and keep a
default `checkStmt1(err?)` for `checkBlock`'s two-arg callers.

**My earlier intermediate shape (`2d2f1e2`), superseded: NEITHER `onReturn` NOR `noStamp` as flags.** Both are WRAPPERS a caller composes, not flags `checkStmt` carries:
```
stampScopes(check)     -> (s, scope, typeOf) => { (s as any).scope ??= scope; check(...); }
afterReturn(check, f)  -> (s, scope, typeOf) => { check(...); if return, f(s, scope); }
```
`checkStmt1(err, wrap = stampScopes)` takes how to compose the base walk into the one every nested
statement recurses through. NOT stamping is a caller not composing it (`c => c`). `noStamp` survives
only inside `checkFunctionBody`, for the separate function-level `fn.scope` stamp.

The user's refactor: `err`/`onReturn`/`noStamp` were parameters on `checkStmt` AND `checkBlock`,
threaded through every recursive call. Bound by `checkStmt1` now -- a walk that needs them is *a*
checkStmt. **`onReturn` is not part of the check at all**: it is what *a* checkStmt does AFTER calling
*the* checkStmt, so it composes as a WRAPPER and `checkBlock` lost its `return` case entirely.

**The bug it exposed (user spotted it):** the hook lived in `checkBlock`, so it only saw a `return`
that was a direct member of a BLOCK. `if (x) return 'ab';` inferred **`void`** while
`if (x) { return 'ab'; }` inferred `string | undefined` -- **adding braces changed the type** -- and
where a return type was DECLARED, a bare nested return was never checked against it at all.

**Raises the project's own checker-error counts** (js-parser 1->2, checker 4->5, towasm 32->35). Those
are returns that were never being checked, not new faults; js-parser.ts:633 shows `BigInt()` is
declared to return the `BigInt` INTERFACE where real TS returns the `bigint` primitive. Left standing.

### `b1256a0`: the primitive wrappers (`BigInt`/`String`/`Boolean`/`Number`) are CALLABLE

`BigInt(5)` typed as `BigInt`, `String(5)` as `String`, `Number('5')` rejected its own argument. Two
causes, both on the CALL side -- **`new BigInt()` yielding `BigInt` was always correct**:
- `class_decl` used `addValue` (overwrite) while the line above already used `mergeType`. So
  `declare var BigInt` + `class BigInt` -- TS's own two-declaration shape for a wrapper, class supplies
  `new`, var supplies the call signature -- collapsed to whichever came last. **`Scope.mergeValue`**
  merges, and ONLY against a binding in the same scope (a user class must never merge with a lib one).
- Signature selection took a bare `constructor` part for a plain call, pre-empting the call-vs-construct
  preference the member scan below already implemented. Kept as the lenient fallback.

**type-utils.ts went 15 -> 3 checker errors, js-parser 2 -> 1.**

### `11410b6`: `Number`/`Boolean` convert for real -- and 4 unrelated lib bugs fell out

Twelve EDGE cases written BEFORE the implementations found four pre-existing bugs that had nothing to
do with wrappers. This is the pattern to repeat: the edges are where a pass-through looks fine.
- **`getUnsigned` tested `d > radix` instead of `d >= radix`** -- 'a' counted as digit 10 in radix 10,
  so `Number('abc')` parsed as **10**. Affects `parseInt`/`parseFloat` at every radix.
- **`Number.toString` walked digits for non-finite values**, so `String(NaN)` was the EMPTY STRING.
- **`bigFromNumber`'s limb loop assumes a magnitude** -- `BigInt(-5)` produced garbage that compared
  as positive.
- **`Number(str)` is NOT `parseFloat(str)`**: trims, empty is 0 (not NaN), trailing junk makes the
  whole thing NaN instead of being ignored. `parseFloat`'s body is now `getFloat(p)`.

**`bigToNumber` needed an ambient declaration in `lib.d.ts`**, same as `StringParser`: it is `export`ed
from `bigint.ts`, which makes that file a MODULE to tsc and its exports invisible to a SIBLING lib
file, even though towasm sees one flat scope. Expect this for any cross-lib-file reference.

### `7cf18df`: the wrapper CALL lowers to the constructor, and bigints compare by VALUE

`C(...)` on a class lowers to its constructor -- which is right because `String`'s constructor is a real
conversion (`return s.toString()`), and is only ever as correct as the constructor is. `BigInt`'s was a
stub, so it now converts via `bigFromNumber` (which `toString` already used -- it is NOT dead code).
**The `as unknown as BigInt` cast stays**: tsc requires a constructor's return to be assignable to the
instance type, and towasm strips casts to read the real type underneath.

**`bigCompare` was wrong for EVERY bigint comparison**, not just these: it walked limbs UNSIGNED while
the representation is two's complement, so `0n > -1n` was false (`0 < 0xffffffff`). Now sign-first and
**SIGN-EXTENDED rather than length-based** -- a `bigint` has TWO physical forms here (**a literal emits
`i64.const`; the `BigInt` class holds `u32[]`**), so the same value arrives with different limb counts
and `BigInt(0) === 0n` was false purely because one zero was a limb longer. That dual representation is
still there and is worth knowing about before touching bigint again.

**TRAP I fell into first, do not repeat: lowering `X(v)` to `new X(v)` is WRONG *while a constructor is
a stub*.** These constructors
are stubs whose own comment says the argument "is never actually read" -- `BigInt(5)` then computes
ZERO and compiles cleanly. The user caught it. Codegen still throws "call to unknown function" for all
four, which is honest; the real lowering needs actual conversions (`bigFromNumber`, `toString`,
`parseFloat`, truthiness). **Write the difftest cases against real JS first.**

**Also corrected: towasm's explicit-return-constructor convention SKIPS `as` nodes** (`unwrapAs` at
towasm.ts:7811), so a cast target is NOT "declared intent" -- it is there for tsc's benefit only.

### `7852172`: a parameter default may be a CLOSURE, and is typed by its annotation

Two fixes, both needed before `Array.sort()` worked without an explicit comparator (the blocker after
`readdirSync`, and why difftest's own helper could not use `sort`):
- A default is restricted because it is **RE-EMITTED at every call site that omits the argument**, so
  the question is what it CAPTURES, not what kind of expression it is. A closure qualifies when it
  mentions only its own params and the earlier params those sites already pass.
- **The checker typed a default with NO contextual type** -- an unannotated arrow default under
  `compareFn: (a: T, b: T) => number` gave its params `any`. Real TS checks a default AGAINST the
  parameter's declared type; pass `anno` as `expected` (checker.ts ~1860).

**towasm.ts:170 is now fully unblocked** -- the domino moves to line 194, `class 'Map' needs 2 explicit
type argument(s)`.

### OPEN: `Array.sort` diverges from JS twice (reproduced, not fixed)

- **The default comparator should compare by STRING conversion.** `[10, 9].sort()` stays `[10, 9]` in
  JS; ours gives `[9, 10]`. `[1,5,20,10].sort()[1]` is 10 in JS, 5 here.
- **`sort` should sort IN PLACE and return the same array**, not a copy: `a.sort()[0] + a[0]` is 2 in
  JS, 3 here.

Cases to re-add when fixing (removed only because difftest has no baseline for a known failure):
```
add('lang/sort', 'stringOrder',     `const a: number[] = [10, 9]; return a.sort()[0];`);
add('lang/sort', 'stringOrder2',    `const a: number[] = [1, 5, 20, 10]; return a.sort()[1];`);
add('lang/sort', 'sortReturnsSelf', `const a: number[] = [2, 1]; return a.sort()[0] + a[0];`);
add('lang/sort', 'strsDefault',     `const a: string[] = ['c','a','b']; return h(a.sort().join(''));`, HASH);
```
**Attempting the fix hit two further codegen bugs**: a `String(a) < String(b)` default produced
"local '$exp' redeclared with different type" (5 cases), and an in-place `Array._copy` back over `this`
produced an "illegal cast" (3). Also learned: `Array._copy` with the DESTINATION first needs an
explicit `<T>` -- with T open the two `TYPEINDEX("T[]")` operands resolve from the arguments, which
differ. Budget a real session for this, not a tail-end patch.

### `b2c1bcc`: `fs.readdirSync` -- and towasm.ts:170's domino moved again

The spread cause's towasm.ts sites were ALL one module-level statement (the `LIB_FILES` glob) blocked
on `readdirSync` not existing -- debt from `bf316eb`, where I added the glob without the lib support.
Implemented over WASI `fd_readdir`: 24-byte dirent header (d_next u64, d_ino u64, d_namlen u32,
d_type u8) then the name bytes, packed. **LOOP on the cookie** -- one buffer does not hold a directory,
and a trailing PARTIAL entry is how the host says "buffer full". Drops `.`/`..` as node does.

**Exposed a pre-existing trap in `findPreopen`**: when the path IS the preopen root, `rel` is empty and
`rel.charCodeAt(0)` reads element 0 of a zero-length array. Nothing had reached it because every other
entry point has a filename after the directory. **This runtime's `charCodeAt` TRAPS out of range where
JS gives NaN** -- worth knowing.

**Compare directory listings by a SUMMED hash, not a sorted one** -- addition is commutative, so it
tests the set of names without depending on an order neither WASI nor node promises (and without
needing `sort`, which has its own gap).

**towasm.ts:170 now fails on `sort`'s ARROW-FUNCTION DEFAULT PARAMETER** ("a param's default value must
be a literal ... or a read of an earlier parameter"). That is the next domino, and it bites twice --
the lib's own `Array.sort` is unusable for the same reason.

### CLOSED `b360b91`: the spread cause was TWO bugs, neither about spreads

The survey's #1 for three runs (33 blocks, 5 files). Plain spreads always worked; the trigger was a
receiver **narrowed out of `T | undefined`**, then a field off it spread.
- `objectArrayKind` asked `wtypeOf` (which reads `ctx.scope`), so the narrowed receiver still read as
  the whole union, the field came back `any`, and an `any` has no array kind. Now `narrowedTypeOf`,
  as `ownerOf` already does. **Third time this session that split was behind a message naming
  something else.**
- Underneath: **`ensureObjectShape` keys a named alias/interface by NAME while `ensureAnonObjectShape`
  keys the identical shape STRUCTURALLY**, so `type A = {n:number}` written as `A` in one place and
  inlined in another built TWO struct types -- and a value built as one failed `ref.cast` to the other.
  Not a compile error: **"illegal cast" at RUNTIME**, from spreading an array of them. They share one
  shape now, keyed structurally (what TS means by these being one type). A real `class` is untouched.
- **`matchObjectShape`'s "exactly one candidate" scans must dedupe by identity** now that one
  `ClassInfo` is reachable under several keys -- missing that took difftest 12 -> 37 unsupported.

### (historical) the spread cause was NOT isolated for a long time

Simple spreads all WORK: `['a', ...b]`, `[...b, 'a']`, `[...a, ...b]`, for both `string[]` and
`number[]`, and spreading a `slice()` result. The failing sites involve ref-element arrays
(`checker.ts:2003` is `[...a.rights, ...b.rights]`) and generic-method results. towasm.ts's own site
(`['lib.d.ts', ...readdirSync(...).filter(...).sort()]`) also drags in `@types/node`. An attempt to
repro with an `interface`-typed element hit a DIFFERENT gap first: **`interface_decl` is unsupported as
a top-level statement in the entry module**. Isolate before building anything.

## Closed 2026-09-05: the 13-block indexing cause was THREE narrowing bugs, not an array gap

"indexing is only supported on number[]/boolean[]/..." named the site that gave up, not the thing that
broke -- for the THIRD time in this project. The receiver was `any` in every case, and the recorded
ref-kind-array repro (`const a = mk(s); a[0].length` cross-module) **no longer fails at all**; `13be2ae`
had already fixed it and the memo was stale. Narrowing simply never reached codegen:

- **`1a7e3d8`** -- `narrowedTypeOf` consulted `ctx.stmtScope` only when the expression's OWN baseline was
  a union. A field read THROUGH a narrowed receiver is not: inside `if (w.kind === 'w')`, `ctx.scope`
  still sees the whole union, on which `body` does not exist, so `w.body` is `any`. Accept an `any`
  baseline too -- every divergence the union-only guard excluded needs `ctx.scope` to have a real answer.
- **`f6244eb`** -- narrowing introduced INSIDE an expression had no stamp at all: the checker stamps a
  scope on STATEMENTS. `expected = p ? p.typeArgs![0] : expected` (checker.ts:1773). **`narrow` is now
  exported** -- it is pure, so codegen re-deriving it reaches the same scope the check pass used -- and
  each ternary branch and `&&`/`||` right operand is emitted under it, refining `ctx.typeScope` so
  nesting composes, restored on the way out.
- **`9cbdb88` + `f3c0325`** -- a SYNTHETIC statement is never stamped, and `for...of`/destructuring both
  synthesize a `var_decl`, so its "shouldn't happen" fallback to `ctx.scope` is the NORMAL path for them
  and discarded the enclosing narrowing.

**`f3c0325` is the trap worth remembering.** `9cbdb88` took the narrowed scope UNCONDITIONALLY, and a
narrowing-aware scope does not only narrow: it resolved a clean nominal `Map<K,V>` into its full
STRUCTURAL shape, `ownerFor` built an anonymous struct for it, and that choked on `set`'s `this` return.
One regression (lalr.ts `fillAlwaysEntries`), and **only the survey's REGRESSED line caught it** -- gate,
difftest and tsc were all green. Fix: apply `narrowedTypeOf`'s existing rule everywhere -- `ctx.scope` is
the baseline, the narrowed scope is consulted only where the baseline is `any`.

**Run the survey after a scope/type-resolution change even when every other gate is green.**

## Closed 2026-09-05: `process.env.FOO`, via a general dot-vs-bracket gap (`82c3fe1`)

`{[k: string]: V}` is routed to `Map<string, V>`, and only the BRACKET form was ever routed to that
`get` -- a DOT read fell through to the ordinary field lookup and threw "unknown field". In TS the two
spellings are the same access. Now routed in `case 'member'`, **ahead of the getter and field checks**:
the receiver's TS type exposes no `Map` member, so `env.size` must read the `'size'` KEY, not the map's
count. A real `Map`-typed value is untouched (its type is a `ref`, so `indexSignatureValueType` is
undefined for it). `lib/node/process.ts` then declares `env` with the index signature it is read through.

Still open: a MISSING key (`process.env.NOPE === undefined`) hits the 14-block null-comparison cause,
identically for both spellings.

## Closed 2026-09-05: `null === undefined` returned true (`3c4afbe`)

Both are `ref.null`, so the comparison lowered to a bare `ref.is_null` and answered them alike -- right
for `==`, wrong for `===`. A strict comparison now separates them STATICALLY: where the value's type
carries the other nullish kind and not this one, the result is a constant (the value still evaluated and
dropped -- its side effect is observable). **Deliberately not extended to a type carrying NEITHER**,
which still throws: this compiler hands back a physical `undefined` where the declared type says it
cannot (a missing key on `{[k: string]: V}`), and a constant there turns a loud error into a silent
wrong one. Found by difftest, not inspection.

### difftest RUNS WASI now -- `lib/node/fs` is executed, not argued about

`subject()` builds a fresh `WASI` (`node:wasi`) per case, preopening a real temp sandbox **under its own
absolute path** (not remapped to '/'), so ONE case source means the same file to both sides: the subject
reaches it through `path_open`/`fd_read`, the reference through node's own `fs`. `wasi.initialize` only
when the instance exports `memory` -- exactly the modules that can call WASI at all. Passing the imports
unconditionally is free (wasm ignores unused imports; only a MISSING one errors). 8 `node/fs` cases,
including two that re-read within one call specifically to catch a mark/release bug.

**On its first execution ever, `readFileSync` had never worked**, and the trap-the-import trick
(`assistant/probe-fsrun.ts`, `TRACE=1` wraps every WASI fn and logs its errno) is what showed why:
- `path_open` asked for ALL-ONES rights. WASI refuses any right the parent dir fd does not hold ->
  **errno 76 ENOTCAPABLE**, every time, on every real host.
- Every errno was DISCARDED, so the out-pointer stayed unwritten and the next step read leftover scratch
  as an fd, then as a length. A garbage length hit `String._alloc`: sometimes "array is too large",
  sometimes a huge allocation + fill loop that **looked exactly like a hang** (it hung the whole suite).

Fixed `527188f`: exact rights, and a failed call traps rather than continuing on invented data.

### CLOSED `d8baf3a`: `const f = __asm<...>('...')` now binds in ANY module

Sibling of the scalar bug below, and it also turned out to live partly in `ensureLazyGlobal`. `builtins`
is built once from `LIB_DECLS`, so the shorthand only ever resolved inside `lib/*.ts` proper -- **the
ENTRY module was equally broken** ("call to unknown function 'add1'"; from an import, "call to unknown
function '__asm'"). Only the inline `__asm<...>(...)(args)` form worked anywhere.

Three places had to agree such a const DECLARES a builtin rather than holding a value:
- `moduleAsmBuiltins` -- a per-module registry keyed like a top-level function, consulted by `emitCall`.
- `isAliasInit` -- so the start function stops trying to CALL `__asm`.
- **`ensureLazyGlobal`** -- guarded THERE, not in `lazyGlobalFor`, because `case 'call'`'s own
  closure-valued-const path calls it directly. Missing that third one is why the imported case kept
  failing after the first two looked right.

`lib/node/*` is back on the shorthand and the workaround comment is gone; the module is smaller for it
(2202 -> 2158 bytes), since the wrappers were real calls.

**Reusable: a top-level const is reached from THREE directions** -- the start function, `lazyGlobalFor`,
and `case 'call'` going straight to `ensureLazyGlobal`. Fixing one or two of them looks like progress and
leaves the bug.

### CLOSED `d9a8511`+`053ab70`: the cross-module module-level SCALAR const silent miscompile

Was: codegen SUCCEEDED and emitted wasm no runtime would load ("type error in return[0] (expected i32,
got (ref N))"); `tsw` wrote the bad bytes out. Root cause was NOT the missing module-scoped-global
feature it looked like -- a non-entry scalar already resolves through `ensureLazyGlobal`, and that path
was simply wrong for scalars: its slot is `nullableWtype(wt)`, which BOXES an `i32`/`f64`, and the
wrapper hand-emitted `ref.as_non_null` and returned the box while its own signature promised the scalar.
The write path stored a raw scalar into the boxed slot the same way. Both now go through `coerceTop`,
which already unboxes/boxes and is a no-op when the two types agree (so string/array/object consts are
unaffected). Eager promotion is still entry-only and that is now fine.

**`053ab70`: `tsw` instantiates the bytes before writing them.** `new WebAssembly.Module`, not
`WebAssembly.validate` -- the message is the point. Third bug this week that only this gate could see.

**`cf2a4c1` is the correction that gate needed**: a validator only knows the features ITS OWN HOST has
enabled, and node rejects a perfectly valid exception-handling module without
`--experimental-wasm-exnref` -- so `053ab70` briefly stopped every `throw`/`catch` program from
compiling at all, while the bytes it refused to write run fine under that flag. A host-capability
message (`/--experimental|not enabled|unsupported feature/i`) now warns and still writes; a real
disagreement about well-formed wasm stays fatal.

### CLOSED 2026-09-06: fs error behaviour, and the three prerequisites under it

`fs` trapped (`__asm('unreachable')`) where node throws, so a missing file was UNCOMPARABLE -- a trap
is not observable from a test. Now it throws node's own error in node's own message format
(`ENOENT: no such file or directory, open '/p'`), verified by CONTENT HASH against node's real message
(errno 44 for a missing file, established empirically with `probe-fsrun.ts`, not from a constants
table). **Release the alloc mark BEFORE throwing** -- the bump allocator reclaims only by restoring a
mark, so an escaping throw strands every buffer the call took; a difftest case reads a real file after
swallowing a throw, which is what fails if it is stranded.

Three prerequisites, each its own commit:
- **`60b03f6` `lib/error.ts`** -- `throw`/`catch` already worked over any value (the payload is a plain
  `anyref`, a catch param binds as `any`); only the CLASS was missing. `name`/`message`/`toString`, no
  `stack` (no call-stack introspection to build one from).
- **`difftest.sh` now runs `node --experimental-wasm-exnref`** -- without it V8 will not validate an
  exnref module AT ALL, so every exception case read as "unsupported" when it was the HARNESS that
  could not run it. `NODE_OPTIONS` refuses this flag; it must be on the real node argv.
- **`c77ead0` dynamic field read** -- see below.

### `ensureAnyField` could not see an owner with no struct of its own (`c77ead0`)

`e.message.length` on a caught error (a dynamic field read, then a dynamic GETTER read on the string)
failed "no reachable class declares a field 'length'". Three real causes, and the first two hid the third:
- `typeIndex === -1` was read as "no heap type". It means **no STRUCT of its own** -- `string` is
  `arr:i16` and has a fine `ref.test` target. `String.length` is a getter on exactly such a class.
- `classes` holds only what was reached AS A CLASS; a `string` value never reaches
  `ensureClass('String')`, nor an array literal `ensureClass('Array', ...)`. Seed the builtin owners
  first, as `findAnyDispatchCandidates` already does for `number`/`boolean`. Array owners are gated on
  `hasArrayType(kind)` -- a NON-registering query, because a speculative scan must not add types
  nothing uses.
- **Then an "illegal cast" at runtime**: the result was boxed by the physical width the getter's body
  produced, not the member's DECLARED type. `get length(): number` over `array.len` yields `u32` -> an
  i32 box, while consumers read a `number` out of an `any` by casting to the F64 box. Anything entering
  an `any` slot must be in its logical type's canonical form; `T.lookupMember` gives that type (an
  `__asm` accessor keeps no declaration to read).

### The lib's ambient/real duplication: what it was for, and what is left (`b1df5b2`, `fb7e12b`)

`lib.d.ts` restated by hand what `lib/*.ts` implements. Two consumers, nothing making them agree:
`tsc` under `noLib` (where a primitive's member access resolves through `interface String`, NOT through
any class) and towasm's `LIB_DECL_MAP`.

**`b1df5b2` -- `npm run libdecls` is a new ratchet** (`--update` to re-baseline, same shape as the corpus
gate). It compares DISCOVERED pairs, not a list. Found **21 declared-but-unimplemented members on a
clean tree**, and the hazard is real, verified not assumed: `'abc'.valueOf()`, `u8.map(f)` and
`[1,2].toLocaleString()` all type-check clean and then throw "unknown method" in codegen. Most of the
remaining 16 are an aspirational copy of TypeScript's own `TypedArray` interface; closing that is its
own project. Five were fixed rather than baselined (the `toLocale*`/`valueOf` aliases -- with no locale
support the locale-aware form IS the plain one -- plus dropping deprecated `RegExp.compile`).
**Watch the false positive I hit**: a constructor PARAMETER PROPERTY (`constructor(public message: string)`)
is a real field and must be collected as one, or `Error.message`/`RegExp.source` read as unimplemented.

**`fb7e12b` + `c3869ae` -- the duplicates for `Error`/`Map` are gone; `Array`'s is NOT and must stay.**
Each existed so `lib/node/*` could NAME the class instead of importing it. Under `noLib` a name is
global only if its file is a SCRIPT, and `export` is what made these modules; dropping it makes them
global. towasm does not care (`LIB_EXPORTS` only unwraps `export_decl` so the inner declaration reaches
`LIB_DECLS`, which a non-exported one reaches directly).

**But the CHECKER does, and I claimed otherwise and was wrong.** `declare class Array<T>` is the
CURATED VIEW OF WHAT `T[]` MEANS; `array.ts` is an implementation with a different member set
(internal `get`/`set`, `_alloc` statics, no `readonly length`). Swapping one for the other changed
structural assignability against `readonly T[]`: **walker.ts went 1 -> 29 checker errors and
js-parser.ts 1 -> 14, on files neither commit touched.** Reverted for `Array` only.

**NO GATE CAUGHT IT.** difftest, both tsconfigs and the lib ratchet were green, and **the corpus gate
is about PARSING, not checking** -- do not cite it as checker coverage. Only the survey's per-file
"checker errs" column sees this class of regression. `assistant/errcount.ts` (built 2026-09-07) counts
checker errors for named files in seconds, which is how this was bisected against a `git worktree` of
an older revision.

**It does NOT generalise to `String`/`RegExp`** -- `lib.d.ts` must declare `interface String` for TS's
own primitive mapping, so a global `class String` is a duplicate identifier (34 errors when tried).
Those keep their exports; `StringParser` keeps its ambient declaration only because it shares
`string.ts` with one of them. Moving it to its own script file would free it, if anyone cares later.

**I proposed EMBEDDING the lib to kill the LIB_DIR blocker and the user rejected it, correctly.**

### `bf316eb`: lib files are GLOBBED now -- adding one needs no towasm change

`LIB_AST` listed its files by hand, which failed silently when a new one was forgotten (the
declarations just did not exist; the first sign was an "unknown class" somewhere unrelated). Now
`readdirSync` + `.sort()` for reproducibility, `lib.d.ts` pinned first. **The resulting order differs
completely from the hand-written one and every gate was unchanged**, so that order carried nothing
beyond lib.d.ts-first. `lib/node/*` stays out (on-demand modules, resolved through the loader).

### `429bb6c`: a closure need not CAPTURE a module-level const -- it is a global

The survey's largest single cause (24 declarations, `unresolved identifier 'LIB_DIR'`, towasm.ts:162)
was a one-clause gap in `resolvesGlobally`, the function deciding what a closure must capture. A
top-level `const`/`let` becomes a real global or an `ensureLazyGlobal` wrapper, so it never needs a
capture slot -- but `hoist` deliberately does not hoist a plain top-level `var_decl` into a scope, so
`resolveDecl` could not see one (`topLevelVars` is where the entry module's live). Exact same shape as
the namespace-import clause directly above it. Repro is 5 lines; 9 `capture/global` difftest cases.

**towasm.ts:162 now fails on the SHORT-ARITY ARRAY CALLBACK gap instead** -- `flatMap(f => ...)` where
the signature is `(value, index, array)`. `coerceTop` already has a fewer-params closure coercion; it
does not fire here because the PARAM TYPE differs too (`arr:i16` vs `ref:any`), i.e. the array
literal's element type resolved to `any` rather than `string`. difftest already tracks this family
(`lang/arrayMap`/`arrayFilter`/`arrayReduce`/`arraySome`/`arrayFlatMap`, 5 cases).

**Embedding the lib was proposed to kill this row and rejected, correctly** -- that is
[[feedback-no-simplifying-deps-for-selfhosting]]: deleting the closure to dodge a construct the
compiler cannot handle is the anti-pattern. The blocker is a missing compiler feature every time; find
and fix that. See [[feedback-fix-prerequisites-not-workarounds]] for the same instinct pointed forward.

### `ff5ae02`: every scalar can be null-boxed now, not just `f64`/`i32`

A box is a one-field struct and nothing is special about the field's type, but `nullableWtype` accepted
only those two. An `ensureLazyGlobal` slot IS a nullable box, so an `i64` module-level `const` in an
imported module had nowhere to live -- the reason `lib/node/fs.ts` wrote its WASI rights masks as
functions returning literals. `u32`/`u64` normalise to their signed twins (one box, not a duplicate
type); `void` is rejected on its own terms. **The `lib/node/fs.ts` comment blaming "a module-level
scalar const in an on-demand module" was stale twice over** -- `d9a8511` (user-facing scalars) and the
user's own `d8baf3a` (`const f = __asm<...>(...)` binding anywhere) had each removed half of it.
Check that comment's claims before believing them again.

**`5610273`: `tsw` printed `e.message` for a raw `throw 'text'`** -- towasm's own idiom for a codegen
gap -- so every such error surfaced as a bare `undefined`. Cost real time before it was noticed.

**Lesson to reuse: the missing FEATURE was a red herring.** "Non-entry scalar globals aren't
implemented" was the standing diagnosis; the mechanism existed and had a two-line type bug. Probe what
the failing path actually emits before building the feature you think is missing.

### difftest can now express a case with a SIBLING USER MODULE (`addModule`/`addCross`)

Cases were single-source strings, so the only cross-module coverage was `import 'path'`/`'fs'`. Now:
`addModule(name, src)` writes a fixture `.ts` into `MODDIR` (under the difftest sandbox), `addCross(...)`
marks a case to resolve against a loader rooted there, and `reference()`'s `require` transpiles a
relative specifier fresh each time (never cached -- the subject re-instantiates its wasm per case, so a
cached module-level `let` would desynchronise the two sides). 11 `module/scalar` cases; **10 of them fail
without `d9a8511`**, verified by reverting it. This closes the instrument gap the memo below names.

### `lib/node/*` is now actually reachable (`00769cc`, `d7c2420`)

**Until `d7c2420` NO `lib/node/*` function touching WASI could compile at all** -- every `fs`/`process`
entry point was dead, and nothing noticed because difftest has no case importing them and the survey
never serializes. Two independent bugs:
- `emitCall` guards on `funcs.has(name)` (the BARE key a host import is registered under) but resolves via
  `ensureFunc`, which keys on `homeKey(homeModule, name)`. Equal only for the entry. Elsewhere: miss, then
  a crash in `compileFunc` on the absent decl.
- `LIB_HOST_IMPORTS` scanned only `LIB_AST`, so a host import declared in an on-demand module registered
  nothing. Now collected from every module body, deduped by name.

**Allocator rules for `lib/node/*`, learned the hard way:**
- `heap` is a bump OFFSET, not a heap; `__alloc` is not an allocator. The only reclamation is restoring
  the previous value. `__allocMark`/`__allocRelease` (`00769cc`) are the public form; `heap` stays private.
  Release only once everything surviving is in GC memory -- a `String.fromCharCodesAt` result is a GC
  array, a raw `i32` pointer is not. Releasing with a live pointer is silent corruption, worse than a leak.
- **`const x = __asm<...>('...')` only binds in a STATIC lib file.** From an on-demand module it throws
  "call to unknown function '__asm'". Use the same asm as an inline call inside a real function body.
- Never `import` a static lib file from `lib/node/*` (second `heap` over one memory). Ambient-declare.

### towasm.ts:161-162 is a DOMINO CHAIN -- one identifier at a time, 22ish declarations each

The same two lines have now been the survey's #1 cause four times running, each fix advancing it exactly
one identifier and the block count barely moving:

`unresolved identifier 'path'` (22) -> `'__dirname'` (22) -> `'TS'` (23) -> a closure-signature conversion
at `LIB_EXPORTS`. **Expect the next one too.** `43/258` has not moved through ANY of it, because these
declarations are blocked serially; "moved to a new cause" (11, then 28) is the only signal. Do not read a
flat total as no progress, and do not expect the NEXT fix here to move it either.

Closed on the way through:
- **`__dirname`/`__filename`** (`f2caa7e`) -- per-MODULE bindings, as CommonJS's own module wrapper makes
  them, never lib globals (a global gives every module the same answer). `checker.bindModuleNames`, plus
  `LoadedModule.filename` from the loader and a caller-stamped `Program.filename` for the entry.
- **namespace imports in `resolvesGlobally`** -- `import * as TS` binds a compile-time namespace, resolved
  at each use site, so it never needs a capture slot; only NAMED imports were listed, so `TS.parse(...)`
  inside a callback read as a free variable. Uses `moduleScopeOf`, which `13be2ae` made possible.

### THE SURVEY CANNOT SEE CROSS-MODULE BUGS -- it probes every file as the ENTRY

Structural blind spot, learned the hard way at `13be2ae`. A fix that took difftest's unsupported count
from **46 to 15** moved the survey by **0 newly compiled** (11 moved cause). Not a contradiction: the
survey compiles each target file AS THE ENTRY MODULE, where `global = ast.scope` already worked. The bug
only ever hit functions in IMPORTED modules. **difftest-with-imports is the only instrument that sees
this whole class.** Weight the two accordingly; a flat 43/258 does not mean nothing happened.

### Closed `13be2ae`: an imported module's function body saw only `libGlobal`

`compileFunc` rooted a non-entry body at `libGlobal` unless `global.value(name)` found it -- and that only
finds a name imported DIRECTLY into the entry, so a function reached through a namespace import
(`path.join`) never resolved. Every module-local name in its body, **a sibling function's RETURN TYPE
included, typed as `any`**. Codegen paths reading the PHYSICAL wtype were fine (a scalar or class return
worked); every path reading the CHECKER's type -- indexing, `.length`, a field read -- silently lost.

Fix: `exportScope` already builds that internal scope and discards it, keeping only the export-only view.
It now stamps it on the body it hoisted, the way a checked `Program` already carries `.scope`.

**THREE symptoms, one cause -- and two of them were convincing wrong diagnoses:**
- "indexing is only supported on number[]/..." -- read as a ref-kind array gap. It was an `any` receiver.
- "unknown method 'join'" / "'lastIndexOf'" -- read as missing lib methods. **Both exist in the lib.**

**The error text names the site that GAVE UP, not the thing that broke.** Same lesson as "unresolved
identifier 'path'" (a codegen message about a bodyless module, not a loader failure). Probe before
believing a cause row.

### Still open and GENUINE: indexing a boxed-`any` array (13 blocks)

The survey's own indexing row survives the above and is a real gap. `checker.ts:63`
`stmt.body[stmt.body.length - 1]` -- `stmt` is a union, so `.body` comes back through union field
dispatch as a boxed `any`, and `objectArrayKind` can name no element kind. 13 declarations over 5 files.
This is the ref-kind indexing feature, for real this time.

### difftest now runs through the ModuleLoader -- and immediately found what review missed

`subject()` uses `TStypeCheckAsync` + `collectModules` + `TStoWasm(program, modules, namedImports)`, and
`reference()` gets `require` so a case importing `'path'` compares against **node's real `path`**. String
results are compared by **CONTENT HASH** (`n = (n*31 + c) % 1000000007`, exact in f64), never `.length` --
two different paths of equal length are exactly the confusion being hunted. Behaviour-preserving for the
pre-existing cases (identical 1266/1281 before and after the swap).

**First run of the `node/path` group found, in one pass, what parse+tsc+the survey all missed:**
- `path.join` and `path.resolve` **do not compile at all** cross-module -- and the SURVEY CANNOT SEE THIS,
  because `LIB_DIR`'s own declaration dies on `__dirname` before it ever reaches `join`'s body.
- `extname` needs `String.lastIndexOf`; `resolve` needs `Array.join`. **Both missing from the lib** --
  `Array.join` is also 2 blocks of the survey's own table (towasm.ts, peg.ts), so it pays twice.
- `dirname` was WRONG on every repeated separator (fixed, `6a114ca`).

**Root cause of the `join` failure, isolated to a 2-line repro** -- in an IMPORTED module:
```ts
function mk(s: string): string[] { return [s]; }
export function viaHelper(s: string): number { const a = mk(s); return a[0].length; }
```
"indexing is only supported on number[]/boolean[]/..." (towasm.ts:4740). Binding the `string[]` RESULT OF A
CALL into a local, then indexing it, degrades to a ref-kind (`arr:ref`) array, which index reads don't
support. A locally-built `string[]`, a rest param, and `for...of` over the same value all work; only the
returned-array binding fails, and only cross-module. **Same family as the recorded `map` limitation**
("binding a generic method's `U[]` result to a concrete-typed local still fails ... the return stays
physically `arr:ref`"). Making index reads work on ref-kind arrays closes the whole family.

### `WebAssembly.validate` is a THIRD gate, and it catches what the other two cannot (`97fc4a2`)

Codegen reporting success does not mean the bytes are valid. `String.fromCharCodesAt` (a linear-memory
read that never allocates) produced a module that failed validation: **"memory index 0 exceeds number of
declared memories (0)"**. The memory was declared only `if (globals.has('heap'))` -- the NAME of
console.ts's allocator global, standing in for "uses linear memory", exactly the name-special-casing
anti-pattern. Now it scans the emitted code for a real memory instruction (`memory.*`, any `load`/`store`).

**Neither existing gate could see this**: the corpus gate is checker-only, and NO difftest case uses
linear memory. `assistant/validate-whole.ts` (serialize + `WebAssembly.validate`) is the check that did.
Worth folding into the survey's own `codegen()` -- it never calls `toBytes` at all.

### `lib/` HAS ITS OWN tsconfig -- run it, it is the check for lib files

**`src/examples/TS/lib/tsconfig.json`** (`noLib: true`, `types: []`, `include: **/*.ts`) type-checks the
whole lib tree, `lib/node/*` included, against `lib.d.ts`'s ambient declarations instead of TypeScript's
own lib. **It is at zero errors, and VSCode uses it**, so an error there shows in the editor.
Run `cd src/examples/TS/lib && npx tsc -p . --noEmit` after touching anything under `lib/`.

Do NOT conclude "nothing checks lib/" from the other two exclusions -- `src/examples/tsconfig.json`
excludes `TS/lib/**` and `eslint.config.mjs` globally ignores it (verified: eslint reports "File ignored
because of a matching ignore pattern", and `--no-ignore` cannot parse it either since it is in no
program). This tsconfig is the one that does the work, and I missed it once and told the user the wrong
thing.

Two consequences of `noLib`:
- **A global the lib uses must be declared in `lib.d.ts`** -- there is no ambient `Error`/`Map`/`String`
  to inherit. Adding `lib/error.ts` needed `declare class Error` there too (`0695c74`), the same
  `declare class Map<K,V>` shape directly above it. Having both an ambient declaration and the real
  `export class` is the established, working pattern, not a conflict.
- It does NOT catch everything: the tison checker is still the only thing that reads these files for
  ASSIGNABILITY the way towasm will. Caught 2026-09-06 in `lib/node/process.ts`:
  `loadEnv(): Map<string, string>` assigned to `const env: {[key: string]: string}` -- fixed `2b7f912`
  by using the index-signature type throughout (physically identical: `{[k: string]: V}` routes to
  `Map<string, V>`).

**Possible checker bug, unverified**: `Map<K, V>` should not be assignable to `{[k: string]: V}`.
Worth a corpus A/B before "fixing" -- tightening it could move real numbers either way.

### Reviewing subagent lib work: what to actually re-run

A lib change touches the LIB SCOPE, so **`npm run gate` is mandatory** even when the change looks local --
an agent briefed on probe-libfile + tsc + difftest will skip it. Also: **difftest does NOT prove new lib
code compiles.** Unreached lib declarations are never codegen'd, so a new `String` method can sit there
broken while difftest stays green. Compile it explicitly.

### Node builtins: `lib/node/`, resolved ON DEMAND (`76fbec6`)

Two different mechanisms, do not confuse them:
- **`lib/*.ts` proper is STATIC** -- concatenated into one always-present global declaration list
  (`LIB_AST`), linked into every module used or not.
- **`lib/node/*.ts` is ON DEMAND** -- ordinary modules; `ModuleLoader.get0` resolves a bare specifier
  there only if a program imports it. **Adding a builtin is a new file, not a compiler change.**
  Placed ahead of `node_modules` so it beats `@types/node`'s bodyless `.d.ts`. Its own directory so a
  bare specifier can never collide with a static lib file (`string`/`map`/`array` are all real filenames).

**RULE for every `lib/node/*` file: reference the static lib, never `import` it.** An
`import { __alloc } from './console'` compiles a SECOND copy of console.ts -- a second bump-allocator
`heap` over the same linear memory, which is silent corruption. Name it as a global and ambient-declare
it in `lib.d.ts`, the shape `Array<T>`/`StringParser`/now `__alloc`/`Map` already use.

towasm needed NO change for this: `import * as NS` cross-module calls already worked (the namespace-call
site's own comment already named `path.join` as the case failing only because the target had no bodies).

**Nothing executes any of it.** difftest never touches the loader (0 of 1281 cases contain an `import`);
the survey never even serializes a module. `path` needs no WASI and could be differentially tested
against node's real `path` as soon as difftest can compile a case with imports -- the same gap that
blocks multi-module coverage of the dynamic-`any` work. `fs`/`process` need a WASI host (`node:wasi`).
Known unfixed defect: `fs.readFileSync` builds its result one `String.concat` per byte, which is
quadratic (`concat` reallocates and copies both sides each call).

### Closed 2026-09-05: the dynamic-`any` cluster (`0ff5c1c`)

`walker.ts`'s `guard()` is ONE expression -- `node && typeof node === 'object' && 'type' in node &&
set.has(node.type)` -- and all four arms were gaps. **Fixing them one at a time only moved the throw
along the chain**, which is why the survey's per-cause rows understated it: truthiness -> `typeof` ->
`in` -> field read, each revealed by re-probing the same declaration. They had to land together.

- `emitAnyTruthy` -- `ref.test` against the boxes a scalar takes on entering an `any` slot (`coerceTop`),
  so `0`/`NaN`/`false`/`''` are separated from a real object, which is unconditionally truthy.
- `typeof x === 'object'` -- the one tag with NO physical form of its own, so it is the COMPLEMENT of the
  ones that have one: a plain OR of those `ref.test`s, no branching.
- `ensureAnyIn` / `ensureAnyField` -- the `in` and field-read siblings of `ensureAnyDispatch`, sharing its
  `lateWorklist` deferral because the candidate set is "every class ever reached" and is only final once
  `worklist` drains.

**Known wrong answer, deliberate**: a `bigint` shares `arr:i32` with `Int32Array` (`typeofHeapType`), so
`0n` in a dynamic slot reads as truthy. Same physical ambiguity the `typeof` side already documented.

**difftest grew an `any/truthy` + `any/guard` + `any/field` matrix (70 cases)** over `-0`, `NaN`, `''`
and each reference kind. It is the reason this landed with 0 disagreements rather than on inspection.

## Measured state (clean survey at `25d2cc0`, 2026-09-05) -- FIRST HONEST PER-DECLARATION NUMBERS

**25 of 257 compile in isolation.** 318 failures from **154** distinct causes. The cause count jumped
because `25d2cc0` stopped a module-level statement blocking its whole file (see the correction above):
towasm.ts now reports **16** distinct causes over its 38 declarations instead of 1, ts-parser.ts 6
instead of 1. `type-utils.ts` went **7 -> 14 compiling**, peg.ts 0 -> 1.

| blocks | causes | shape |
|---|---|---|
| 54 | 34 | `ERR: Argument of type 'X' is not assignable to parameter 'X'` -- checker diagnostics, very fragmented |
| 30 | 7 | `unresolved identifier 'X'` -- NEW, and partly a consequence: a skipped module-level statement declares no name, so dependents now say so honestly instead of hiding behind it |
| 28 | 2 | `'X' cannot be used as a boolean condition` -- the dynamic-`any` work (tocode.ts's `guard()`) |
| 25 | 13 | `unknown method 'X'` -- array methods on unresolved receivers + missing statics (`Array.isArray`, `JSON.stringify`, `Object.is`) |
| 21 | 6 | `unknown field 'X'` |

**Nothing is concentrated any more.** The biggest single CAUSE is now small; the era of one fix moving
35 declarations is over, because that multiplier was the file-level coupling. Pick by breadth (a cause
appearing in several files) or by difftest agreement, not by row size.

**Next levers**: the dynamic-`any` cluster (28 blocks, 2 causes -- the largest concentrated one left,
and `guard()` needs truthiness + `typeof` + `in` + field read on a boxed `any`); the array-callback
cluster (short-arity arrow vs `(value, index, array)` -- 5 difftest cases); missing lib statics.

### INSTRUMENT TRAP found 2026-09-04, and fixed: towasm.ts was surveyed against `wasm: any`

`ModuleLoader` cannot resolve `@isopodlabs/binary_libs/wasm` -- the package's `exports` map points at a
built `dist/*.js` and the loader never reads `exports`. So `import * as wasm` bound a *value* with no
namespace, `wasm.I` was a member read on `any`, and every towasm.ts measurement before this was partly
an artifact. `selfhost-survey.ts` and `assistant/probe-decl.ts` now pass a `paths` option mapping
`@isopodlabs/binary_libs/` and `@isopodlabs/binary/` to the sibling **`src/`** trees (a `.d.ts` has no
bodies to compile, and `binary-libs/src/wasm.ts` is itself a target). Making the loader read `exports`
would fix `tsw` the CLI too, and is still open.

### The structural lesson: the start function evaluated every top-level const

`__toplevel` emitted every top-level `var_decl`, into a start-function LOCAL that nothing else can even
see -- while every real cross-function read already goes through `ensureLazyGlobal`. So a single
module-level const whose value has no physical representation failed the WHOLE module, which is why one
statement blocked 32-42 declarations at a time. Four separate top-row causes this session were all that
same shape:

- `const Scope = T.Scope` (towasm.ts) -- a class alias. 42 blocks.
- `const I = wasm.I` (towasm.ts) -- a cross-module binding alias. 32 blocks.
- `const JSBinary = Binary<Expr, binaryOps>` (js-parser.ts) -- a generic declaration named with explicit
  type arguments.
- `export type { Location } from '../common';` (js-parser.ts) -- a bare `export` statement, which binds
  and evaluates nothing at all.

`isAliasInit` now skips all of these in the start function (`export default <expr>` deliberately
excluded -- that one has a value). **When a whole file dies on one line, check whether the start
function is evaluating something nothing reads.**

### Closed 2026-09-04 (later session)

- **mapped type with a NESTED-union key constraint** (`de4f2c9`): `resolve` reduces a union but leaves
  its MEMBERS alone -- the FOURTH thing that broke on today, after the `in` test, the union dispatches
  and `never`. A constraint like `WasmScalarI | 'i8' | 'ref'` kept one member as an unresolved alias, the
  flat "every key is a literal" test failed, and the mapped type stayed opaque. `literalKeys` resolves as
  it descends. towasm.ts's `ARR_WTYPE: Record<WasmElementI, WasmType>` is exactly this. **45 moved.**
  Corpus: **GAP 601 -> 599**, everything else unchanged.

**RECURRING TRAP (4x in one session), now with a shared fix: `T.resolve` does NOT resolve union
members**, and a `never` member makes a union look unanswerable. Use **`T.unionMembers(t, scope)`**
(`a6d9e9d`) instead of walking `.types`.

**It yields the RAW member, deliberately.** Resolving is only how nesting is DISCOVERED -- handing a
consumer the resolved form breaks `ownerFor`'s nominal `ref` fast path (a real class expands to a bare
structural shape, every `ref.test` arm misses, and working dispatches start trapping). The
owner-resolving paths -- `flattenOwners` and the two dispatch gates -- therefore keep their own raw
walks and only drop `never`. Migrating them onto the helper was a real regression, caught by the towasm
suite.

**Audited rather than assumed** (`a6d9e9d`): 9 union shapes x 7 operations. Every class / nullable /
nested-alias / `never` combination passes. The only failures are unions mixing a SCALAR with a
reference, which are the already-tracked dynamic-`any` row -- so there is no hidden union backlog.

- **union METHOD dispatch** (`06f1706`): `u.n()` on `A | B` threw `unknown method`. Same `ref.test`
  cascade as the field side, emitted INLINE rather than as a shared dispatcher -- the arguments are
  ordinary expressions at the call site, and re-emitting per arm duplicates code but not evaluation,
  since one arm runs. Every member must be struct-backed AND declare the method, or it falls through
  (a partial answer is a silent wrong dispatch). **Moved only 7** -- see the note above about that row.

- **`'k' in u` on a union is a TYPE TEST** (`29969ce`): `in` only ever worked over a dynamic object, but
  on a union it is how TS narrows members with no literal discriminant, and each member is its own
  nominal struct. Static when every member agrees, else a `ref.test` over the declaring ones. An
  OPTIONAL declaration counts as declaring (no property-presence concept here; a null test would be a
  different wrong answer). Members must be FLATTENED, not just resolved -- `resolve` reduces the union
  but leaves members alone, so `typeof X[number] | undefined` hides a nested union. **43 moved.**
- **`never` members** (`0eac98f`): nothing inhabits one, so it can never be the runtime value -- but
  every union walk treated it as unresolvable and gave up on the whole union. THIRD place it bit
  (`alwaysTruthy`, `T.typeofName`, then the dispatches); now one shared `isUninhabited`. **43 moved.**

- **`Array.flatMap` was never declared** (`693a926`): not in `lib/array.ts` nor `lib.d.ts`, so every
  `xs.flatMap(...)` typed as `any`, and ONE `any` in a spread poisons the whole array literal.
  towasm.ts's `LIB_DECLS = [...filter(...), ...filter(...).flatMap(...)]` therefore gave `d: any` in its
  `for...of`, which was all 35 of that file's `unknown field 'name'`. **40 declarations moved.**
  Pre-existing limits it does NOT fix, shared with `map`: binding a generic method's `U[]` result to a
  concrete-typed local (`const r = a.map(...)`) still fails -- method-level generics are not
  monomorphized, so the return stays physically `arr:ref`.

- **union member lacking the field** (`58d301b`): `u.k === 'b' ? u.b : u.a` was an "internal
  inconsistency" throw. The dispatch assumed the checker required EVERY member to have the property --
  true only when it did not NARROW. Codegen doesn't track narrowing, but a member the narrowing excluded
  cannot be the runtime value, so it is dropped from the `ref.test` cascade (and an unchecked program
  still traps on the trailing `unreachable`). **23 declarations across six files; 7 newly compiling.**

- **`&&`/`||` yielded a boolean, and `%` was not fmod** (`ab27225`): both SILENT WRONG ANSWERS, both
  found by `difftest.sh` on its first pass (996/1161 -> 1161/1161). `a && b` yields an OPERAND (`0.5 &&
  7` is `7`); the bare boolean lowering agrees with JS in a CONDITION, which is exactly why it survived.
  The value form tees the left into a local and tests that (side effects once); `emitTruthy` keeps the
  cheap boolean form for conditions and a statement-position `a && f()` needs no representable result,
  so `f` may return void. `%` was `x - trunc(x/y)*y`, making `7 % Infinity` a `0 * Infinity` NaN and
  losing the dividend's sign (`-1 % 1` is `-0`); fixed with `|x| < |y| -> x` plus `copysign(..., x)`.

- **closure structs share a declared base** (`0b38d15`): I claimed closures had no common base to
  `ref.test`; the user pushed back and was right. They had none *declared*, but one is sound and cheap --
  a closure value struct is `{(ref $itsFuncType), (ref $envBase)}` and every func type is a subtype of
  the abstract `func`, so `{(ref func), (ref $envBase)}` is a valid supertype by wasm-GC's COVARIANT
  IMMUTABLE-FIELD subtyping. `ref.test` against it is nominal, so two differently-shaped closures both
  match and no unrelated struct can. This is the `typeof x === 'function'` tag. **Worth remembering as a
  general tool: any set of structs with a common field layout can be given a base retroactively, at the
  cost of one non-final type.**

- **`typeof x === 'lit'`** (`f453ed3`): EVERY one of the 14 blocked sites was a comparison against a
  literal tag, never a bare `typeof` used as a string -- so none needed a `typeof` string to exist.
  Three answers in order: statically when the checker's type gives every inhabitant the same tag
  (`typeofTagOf`, the only way to reach `'object'`); a null test when only nullability varies; otherwise `ref.test` for the four tags with one physical form (number, boolean,
  string, bigint). **Restricted to an operand that really lands in a boxed `any` slot** -- `number` and
  `boolean` both lower to `f64`, so testing anything else gives a WRONG answer rather than an
  unsupported one (the probe caught exactly that).

- **`!` for every operand shape, and NaN** (`7489b54`): `!` was scalar-only, so `!x` on a nullable object
  reference, a string or an array threw -- 15 blocked declarations across three files. It is exactly "is
  x falsy", so it routes through `emitTruthy`. That also fixed a WRONG ANSWER: the scalar path coerced to
  `i32` first, so `!0.5` truncated to `!0` and came out `true`. And `emitTruthy`'s float case called NaN
  truthy (wasm's `ne` is true for an unordered compare) -- `abs(x) > 0` is right for NaN and `-0` and
  needs no scratch local.
- **truthiness of a boxed union / array slot** (`8662b40`, `8639006`): `Stmt | undefined` boxes to a plain
  `any` slot, and `emitTruthy` refused every such slot ("could be holding 0") even though the CHECKER's
  type says every non-null thing it can hold is an object. `alwaysTruthy` reads that type -- never for a
  string/number/boolean/literal/genuine `any`; an interface that `extends` another resolves to an
  INTERSECTION so one object-ish part is enough there (unless another part makes it a primitive, a
  branded `string & {brand}`); a `never` member is skipped like a nullish one, since nothing inhabits it.
  Separately, a real wasm ARRAY slot holds an array whatever the checker type degraded to, so that is a
  null test too -- `arr:i16` excepted, since a string shares that physical form and `''` is falsy.

- **`typeof X` type query carries its declaring scope** (`1e19d1b`): THE root under the survey's largest
  cause. `type Options = Partial<typeof DefaultOptions>` exported from tocode.ts resolved its members in
  the IMPORTER's scope, where `DefaultOptions` (a plain non-exported const) is not a name -- so
  `Options`'s members stayed an unresolved `typeof DefaultOptions["newline"]` with no representation.
  `stampScope` now stamps the query and `resolve`'s `case 'typeof'` prefers it, matching `case 'ref'`.
  **Official corpus, measured against `dfaea3c` in a worktree: ERROR 5241 -> 5240, GAP 601 and the same
  1519 throwing.**
- **an imported class resolves in its own module** (`a2bd106`): `ClassInfo` now records its declaring
  scope + canonical path, and the field loop, `ensureCtor` and `ensureMethod` all use them instead of the
  entry scope -- the same `homeScope`/`homeModule` pairing `compileFunc` already gave a top-level
  function. Without it an un-annotated field could not get its type from the constructor, and
  `T.lookupMember(thisTsType, ...)` could not even resolve the class's own NAME in an importer that only
  wrote `C.Output`. `homeModule` is read off the ORIGINAL decl -- a generic instantiation replaces `decl`
  with a substituted copy `stmtHomeModule` never saw. With `1e19d1b` this closed the 34-block row:
  tocode.ts's `Output` compiled and ran standalone but failed every way it was actually imported.
- **a top-level const's initializer ran TWICE** (`09875b5`): a real correctness bug found while working
  that cluster -- once in the start function (into a local nothing else can see) and again in the
  `ensureLazyGlobal` wrapper on the first cross-function read. A side-effecting initializer bumped its
  counter twice and two different values circulated. The start function now FORCES the wrapper (call,
  drop) instead of re-emitting: one evaluation, still at module-init time, visible everywhere.

- **an array carrying extra properties** (`90bdacc`): ONE root under two separate top rows plus every
  `RegExpMatchArray` in the parsers -- `TemplateStringsArray` (`ReadonlyArray<string> & {raw}`, 10
  blocks), tison's `WithTextPos<T> = T & {pos}` (32 blocks), and the lib's own
  `interface RegExpMatchArray extends Array<string>`. `arrayPartOf` finds the array part of an
  intersection and BOTH `typeOf` and `ownerFor` route through it, so the physical type and the
  field/method owner can never disagree. Physically the value IS the array; the extra properties get no
  slot, so reading one is an honest `unknown field`, and erasing them is what keeps such a value
  assignable to a plain array parameter with no conversion. **Matched on each part's own written shape,
  never through `T.resolve`** -- with `Array` declared in the lib scope, resolving `Array<string>`
  expands it to the class's object shape and loses the very thing being looked for, which is why the
  long-commented-out `case 'intersection'` could never have worked. `TemplateStringsArray` was also
  simply absent from `lib/lib.d.ts`.
- **a class through a namespace member, and through a const alias** (`18af73c`): `new NS.Cls(...)`
  (`case 'new'` only ever accepted a bare identifier callee); `c: NS.Cls` as a TYPE (`ensureClass`'s
  lookup never splits on '.', so a dotted ref got a structural shape-only stand-in with no constructor
  -- and cached it under the leaf name, so whichever of the annotation and the `new` ran first won for
  both); and `const X = C` / `const X = NS.C` as a compile-time alias.
- **a module-level const through its namespace** (`64ef598`): `NS.someConst` had no read path at all --
  `ensureLazyGlobal`'s wrapper was only ever reached from a bare identifier. `lazyGlobalFor` now takes
  the scope to resolve in.
- **the towasm.ts chain merged into the `opts` cluster**: with `wasm` really resolved, towasm.ts's next
  blocker is `new Output({newline:'', ...})` at towasm.ts:138 -- the same tocode.ts `Output` shape
  transform.ts already sat on. Fixing `Output` now unblocks 34.

### tocode.ts's 16-block row is `guard()`, and it is NOT a quick win

`walker.ts:13` -- `guard<R>(types) => (node: any): node is R => node && typeof node === 'object' &&
'type' in node && set.has(node.type)`. That ONE line needs four separate dynamic-`any` features:
truthiness of a boxed `any`, `typeof` on one, `in` on one, and a field read off one. towasm's own header
already excludes the last two. Treat it as one coherent "dynamic operations on `any`" project, not as
the truthiness row it reports as. A boxed-`any` truthiness helper (`ref.test` cascade: null -> 0, boxed
f64 -> `v==v && v!=0`, boxed i32 -> `!=0`, i16 array -> `array.len!=0`, else 1) is designable today but
closes none of the 16 on its own.

### The `opts` row: CLOSED (`1e19d1b` + `a2bd106`)

Kept only for the lesson. The whole `tocode.ts` `Output` shape compiled and ran as a standalone
reproduction for a whole session while every real file that IMPORTED it still failed -- four layers were
peeled off the standalone version (`73ce42a`, `6fbb187`, `c11dcc1`, `5923642`, `7a1fe88`) before anyone
checked the cross-module case, and both remaining roots were purely cross-module. **When a shape
reproduces standalone but not in the real files, stop peeling the standalone one and reproduce the
IMPORT.** A four-case probe (single-file / named import / namespace import / module-level const) split
it apart in minutes.

### Closed 2026-09-04 (later session)

- **`typeof X` type query carries its declaring scope** (`1e19d1b`): THE root under the survey's largest
  cause. `type Options = Partial<typeof DefaultOptions>` exported from tocode.ts resolved its members in
  the IMPORTER's scope, where `DefaultOptions` (a plain non-exported const) is not a name -- so
  `Options`'s members stayed an unresolved `typeof DefaultOptions["newline"]` with no representation.
  `stampScope` now stamps the query and `resolve`'s `case 'typeof'` prefers it, matching `case 'ref'`.
  **Official corpus, measured against `dfaea3c` in a worktree: ERROR 5241 -> 5240, GAP 601 and the same
  1519 throwing.**
- **an imported class resolves in its own module** (`a2bd106`): `ClassInfo` now records its declaring
  scope + canonical path, and the field loop, `ensureCtor` and `ensureMethod` all use them instead of the
  entry scope -- the same `homeScope`/`homeModule` pairing `compileFunc` already gave a top-level
  function. Without it an un-annotated field could not get its type from the constructor, and
  `T.lookupMember(thisTsType, ...)` could not even resolve the class's own NAME in an importer that only
  wrote `C.Output`. `homeModule` is read off the ORIGINAL decl -- a generic instantiation replaces `decl`
  with a substituted copy `stmtHomeModule` never saw. With `1e19d1b` this closed the 34-block row:
  tocode.ts's `Output` compiled and ran standalone but failed every way it was actually imported.
- **a top-level const's initializer ran TWICE** (`09875b5`): a real correctness bug found while working
  that cluster -- once in the start function (into a local nothing else can see) and again in the
  `ensureLazyGlobal` wrapper on the first cross-function read. A side-effecting initializer bumped its
  counter twice and two different values circulated. The start function now FORCES the wrapper (call,
  drop) instead of re-emitting: one evaluation, still at module-init time, visible everywhere.

- **an array carrying extra properties** (`90bdacc`): ONE root under two separate top rows plus every
  `RegExpMatchArray` in the parsers -- `TemplateStringsArray` (`ReadonlyArray<string> & {raw}`, 10
  blocks), tison's `WithTextPos<T> = T & {pos}` (32 blocks), and the lib's own
  `interface RegExpMatchArray extends Array<string>`. `arrayPartOf` finds the array part of an
  intersection and BOTH `typeOf` and `ownerFor` route through it, so the physical type and the
  field/method owner can never disagree. Physically the value IS the array; the extra properties get no
  slot, so reading one is an honest `unknown field`, and erasing them is what keeps such a value
  assignable to a plain array parameter with no conversion. **Matched on each part's own written shape,
  never through `T.resolve`** -- with `Array` declared in the lib scope, resolving `Array<string>`
  expands it to the class's object shape and loses the very thing being looked for, which is why the
  long-commented-out `case 'intersection'` could never have worked. `TemplateStringsArray` was also
  simply absent from `lib/lib.d.ts`.
- **a class through a namespace member, and through a const alias** (`18af73c`): `new NS.Cls(...)`
  (`case 'new'` only ever accepted a bare identifier callee); `c: NS.Cls` as a TYPE (`ensureClass`'s
  lookup never splits on '.', so a dotted ref got a structural shape-only stand-in with no constructor
  -- and cached it under the leaf name, so whichever of the annotation and the `new` ran first won for
  both); and `const X = C` / `const X = NS.C` as a compile-time alias.
- **a module-level const through its namespace** (`64ef598`): `NS.someConst` had no read path at all --
  `ensureLazyGlobal`'s wrapper was only ever reached from a bare identifier. `lazyGlobalFor` now takes
  the scope to resolve in.
- **the towasm.ts chain merged into the `opts` cluster**: with `wasm` really resolved, towasm.ts's next
  blocker is `new Output({newline:'', ...})` at towasm.ts:138 -- the same tocode.ts `Output` shape
  transform.ts already sat on. Fixing `Output` now unblocks 34.

### tocode.ts's 16-block row is `guard()`, and it is NOT a quick win

`walker.ts:13` -- `guard<R>(types) => (node: any): node is R => node && typeof node === 'object' &&
'type' in node && set.has(node.type)`. That ONE line needs four separate dynamic-`any` features:
truthiness of a boxed `any`, `typeof` on one, `in` on one, and a field read off one. towasm's own header
already excludes the last two. Treat it as one coherent "dynamic operations on `any`" project, not as
the truthiness row it reports as. A boxed-`any` truthiness helper (`ref.test` cascade: null -> 0, boxed
f64 -> `v==v && v!=0`, boxed i32 -> `!=0`, i16 array -> `array.len!=0`, else 1) is designable today but
closes none of the 16 on its own.

### The `opts` row: closed as a shape, 11 left as a cross-module remnant

The whole `tocode.ts` `Output` shape now **compiles and runs** as a standalone reproduction
(`assistant/opts-probe.ts`, `full Output shape`): `new Output({spaceAfterColon:false}).colon` is `':'`,
the default is `': '`. All four original layers are closed (`73ce42a`, `6fbb187`, `c11dcc1`,
`5923642`, `7a1fe88`).

What is left is only reachable through the real files: probing `type-utils.ts` gets to
`'newline' needs an explicit type` and `checker.ts` still says `'opts'` -- the same class reached
through an IMPORT rather than as the entry module, so suspect the cross-module side of
`ensureLazyGlobal`/`topLevelVars` (`topLevelVars` is entry-only by construction).

**Probing `tocode.ts` itself now stops at `'any' (ref:any:false) cannot be used as a boolean
condition`.** Not a missing truthiness case -- string truthiness went in at `cab7c17` -- but a value
that shouldn't be `any` in the first place. Fixing it means finding what types it as `any`, upstream;
supporting `any` as a condition would need a runtime type dispatch and is probably the wrong answer.

**`tocode.ts` still isn't in the survey's file list** and is now clearly on the critical path. Add it.

### The `opts` row: four layers peeled, one precise blocker left

`tocode.ts`'s `Output`, reached from type-utils.ts's `typeKey`/`exprKey`/`stmtKey`. Taken apart with
`assistant/opts-probe.ts`, which has every layer as a runnable case:

1. `opts;` -- un-annotated, un-initialized field. CLOSED (`73ce42a`).
2. `constructor(opts: Options = {})` -- object-literal parameter default. CLOSED (`6fbb187`).
3. `this.opts = DefaultOptions` -- the module-level-const gap. CLOSED (`c11dcc1`).
4. `{...DefaultOptions, ...opts}` -- object spread. Codegen CLOSED (`5923642`: anonymous shapes as
   operands, plus a real semantic fix -- see below).

**What is left is one thing, and it is in the CHECKER, not towasm**: `typeOf` gives an object literal
containing a spread the type `any`. Verified directly --

    class C { p; q; constructor(o: Part = {}) { this.p = {...D, ...o}; this.q = {a: 1}; } }
    // C instance = { p: any; q: { a: number } }

`q` infers fine; `p` is `any`, so the field's wtype is boxed `any` and the literal has no target shape
to build (`an object literal needs a known target type`). The fix is to compute the merged member set:
a later non-optional property overrides, an optional one unions with what it may not replace. Do that
and layer 4 -- and the whole 54-block row -- should fall, since every other layer is already through.

A second, smaller symptom of the same root: with an explicit annotation the probe reaches
`unknown field 'spaceAfterColon'`, i.e. two anonymous shapes were built for what should be one. Expect
that to go with the same fix; if not, it is a shape-identity (`typeKey`) question.

### Closed 2026-09-04

- **WeakMap** (`3eebc2c`): absent from `lib/` while type-utils.ts:2021-2022 declared two WeakMap-typed
  fields on `Scope`; one unresolvable field type on `Scope` was the biggest cause (48 blocks / 4 files).
  Added to `lib/map.ts` (already in `LIB_AST`), Map-backed -- nothing is actually weak; every use is a
  cache keyed by an immutable Type node, so it costs retention only.
- **`empty` statement** (`930b7b2`): no `case 'empty'` in `emitStmt`. One line, 7 blocks.
- **`optional` on class fields** (`1f25ac9`): `addField` always forced an optional field's wtype
  nullable, but the `class_decl` path never passed the flag (plain `c?: P` *or* `constructor(public
  b?: P)`); only structural `{c?: P}` did. Two symptoms, one root: `??=` threw "needs a nullable
  object-typed target", and an omitted optional *parameter property* **silently trapped** on a `?.`
  read because `classShapes` (checker.ts:231) handed the synthesized property the CONSTRUCTOR's
  modifiers instead of the parameter's. Constructors needed a matching change: an optional field is
  seeded with its null default up front and left out of `remaining`, and an all-optional class now
  materializes `this` before the body runs.
- **anon-shape vetting** (`51e503d`): `typeOf` falling back to `ensureAnonObjectShape` for ANY object
  type (needed for a namespace-qualified `TS.RefType | undefined` in return position) meant it
  committed to building before checking, so the first unrepresentable member threw out of `addField`
  while the caller still had `wasmTypeOf` untried. A NAMESPACE object (`import * as T from ...`) is a
  real object TYPE whose members are classes and aliases and is never a value struct. It now vets
  properties first and declines. Vetting recurses through member types, so shapes mid-vet are tracked
  -- without that guard it was a stack overflow rather than an answer.
- **interface-extends + Readonly containers** (`7762ba9`): `JS.CallSig<any>` -- `T.FixSig`'s parameter,
  a 40-block row -- had no representation. An interface that `extends` another resolves to an
  INTERSECTION, not an 'object'. By its BARE name that never mattered (`ensureClass` resolves it
  directly); by a NAMESPACE-QUALIFIED one it did, because `ensureClass`'s lookup never splits on '.'
  and the fallback beside it for exactly that reason only handled a plain 'object'. **A single-file
  test passes either way -- only the `compileMulti` one covers the fix.** `ReadonlyMap`/`ReadonlySet`
  turned up right behind it: no declarations of their own, the position `ReadonlyArray` was already
  handled in.
- **earlier-parameter defaults in a function type** (`64975a5`): `dstScope = scope`. `resolvedParams`
  moved from `FuncInfo` to `FuncSig`, built by `closureSigParts` only when a default reads an earlier
  parameter, and threaded to the closure call sites. **The memo key now includes parameter NAMES when
  that applies** -- the rewrite substitutes by name, so same-shape/same-default-text signatures with
  different names must not share an entry. I reverted the check-relaxation half of this in `7762ba9`
  (relaxing without the machinery only trades an honest error for an `internal:` one) and the survey
  promptly made the leftover row the largest, so it got done properly.
- **the options-bag shape** (`7a1fe88`): `this.opts = {...DefaultOptions, ...o}` typed as `any`. THREE
  causes, each verified alone: (a) `73ce42a` resolved a field's inferred initializer against the CLASS
  scope, where a constructor PARAMETER is an unknown name -- so it typed `any` and quietly defeated the
  inference, for every ctor-param-derived field, not just spreads; (b) the literal's member merge was
  "last key wins" outright, so `{...Full, ...Partial}` came out Partial -- a later OPTIONAL member must
  not erase an earlier required one, matching what `5923642` made the codegen do; (c) a mapped type's
  member (`Partial<typeof D>['k']`) is an unresolved indexed access that unioned with the earlier
  `string` instead of collapsing into it. Then `ownerFor` needed the literal side's own last resort --
  synthesize an anonymous shape when nothing declared matches -- or a value of a bare anonymous object
  type has no owner to read fields off. **That last one alone killed the 25-block `unknown field
  'type'` row.**
- **string truthiness** (`cab7c17`): a string tests its LENGTH (`''` is falsy), not its reference, and
  shares its physical `{arr:'i16'}` form with real arrays so only the checker's type can tell them
  apart. Nullable tests null first (`array.len` traps). The remaining rejection -- a boxed `any` --
  now names the type and wasm kind, which is how tocode.ts's next blocker was identified.
- **un-annotated field inference** (`73ce42a`): `class Output { opts; }` -- type exists only in the
  constructor's `this.opts = ...`. `classShapes` already had the right machinery (`pendingFieldInit`'s
  lazy self-memoizing getter, which exists because a field initializer can't be typed during `hoist`);
  constructor assignments are collected after the member loop (the ctor may come later in the body)
  and resolved through that same getter, unioned when there's more than one. Scoped to top-level
  statements of a ctor body. towasm now asks `T.lookupMember` instead of re-deriving from the AST.
  The inferred type is REAL, so a later mismatched write is now an error where `any` allowed it -- that
  is the one extra corpus diagnostic (ERROR 5240 -> 5241), **verified a true positive by running real
  `tsc --strict` on the same shape, which reports the identical TS2322**.
- **object spread** (`5923642`): an operand had to be a NOMINAL class, so an anonymous shape had no
  `ClassInfo` (now `ensureAnonObjectShape`; `ensureLazyGlobal` grew the matching fallback so such a
  const has a physical type at all). And "last property wins" was applied STATICALLY by name -- only
  correct when the later operand's property is actually present. An absent OPTIONAL one read the null
  slot and trapped. Each field now lowers to the same `??` chain the operator does, trimmed at the last
  source certain to hold a value, so the all-present case emits exactly what it did before. **This was
  already wrong for nominal classes**, not just the anonymous shapes the commit adds.
- **module-level state** (`c11dcc1`): THE "sits underneath everything" item, now closed. A top-level
  `const`/`let` holding anything but a wasm compile-time constant was visible to nothing but the top
  level. `ensureLazyGlobal` already built the right thing (null slot + wrapper that runs the
  initializer once) but only a CALL reached it -- the `Rule(...)` grammar-DSL idiom it was written
  for. A plain READ didn't consult it; a WRITE fell off the end of `emitAssignTarget` into a raw
  `TypeError` from `loc!` (now an honest throw) and now goes to the wrapper's own backing slot; and
  only `exportScope` (an IMPORTED module) stamps `Scope.addDecl` for a var_decl, so the ENTRY module's
  declarators had to be recorded separately (`topLevelVars`). Also: a top-level STRING const was
  eagerly claimed as a wasm global and then threw at emit time, since a string has no constant form.
  Killed the 9-block `unresolved identifier 'IDENT'` row. **The suite had zero coverage of
  module-level aggregate state before this** -- every other check keeps state inside one function,
  which is exactly why it survived; the 8 new checks include two functions sharing an accumulator.
- **object-literal parameter defaults** (`6fbb187`): `isReemittableDefault` took a literal, an array
  of them, an earlier param and a member chain, but not an object literal -- so `f(opts = {})` was
  rejected outright, empty `{}` included.
- **function types: predicate returns + defaulted params** (`ab28041`): `closureSigParts` rejected two
  shapes a function DECLARATION already handled. A type predicate (`t is Foo`) had no representation --
  as a value it IS a boolean, `asserts` yields nothing, the same reduction the checker already applies;
  one `case 'predicate'` in `typeOf`. And a defaulted parameter was rejected on a premise that is false
  whenever the type comes FROM a declaration (`typeof f`, a method's own type -- how `Scope.copy(...,
  typeOnly = false)` got here): the default is on the signature and call sites already synthesize it,
  so the slot keeps its plain type, the rule `resolveParam` uses. **Killed the 38- and 20-block rows
  AND nine separate `'isX' has an unsupported return type` rows** (predicate returns on declarations).
  Two supporting fixes: `FixParams` widened an un-annotated defaulted param's synthesized type (it was
  the UNWIDENED literal, so `by = 10` typed as pseudo-type `i32` while the declaration inferred `number`
  -- one function's type and body lowering to different physical signatures); and the closure-type
  memoization key now includes each default's own TEXT, not just whether a position has one, because a
  call site synthesizes the omitted argument FROM that memoized signature -- `(a, by = 10)` and
  `(a, by = 10.5)` shared an entry and one function silently got the other's default.
- **object reference as a condition** (`6c1010c`): `emitTruthy` only handled scalar kinds, so every
  reference hit its `default:` throw. A real object/array/closure reference is always truthy in JS, so
  this is exactly a null test (non-nullable: `drop` + `const 1`, keeping side effects). String and
  boxed-`any` still rejected, decided from the CHECKER's type -- a string and a real array share one
  physical wtype here, so the wasm type can't tell them apart.
- **optional scalar fields** (`57de78c`): `n?: number` kept a bare `f64` slot with a zero default, so
  there was no absent state -- `??=` threw, and an unassigned field silently read back as `0` instead
  of `undefined`. Now null-boxed like an optional *parameter* already was. The point of the boxing is
  that `0` is falsy but not nullish, so `??=` must leave a stored `0` alone. Dragged in a real
  conversion fix: bigint's physical form is an i32 array, so an optional bigint field is a NULLABLE
  array slot, and the i64->bigint conversion compared nullability before matching and gave up.
- **bare `new C` type arguments** (`65f3dc7`): killed the whole 80-block `class 'Set' needs 1 explicit
  type argument(s)` row. **This was never a missing feature** -- both answers already existed and
  `case 'new'` asked for neither. The checker already solves a constructor's type params from its own
  arguments (ask it about `new Set(['a'])` and it answers `Set<string>`), and `ctx.contextualReturn`
  already carries the declaration's declared type. `newTypeArgs` merges them per position. Plus two
  reach-fixes: towasm seeds `contextualReturn` from the assignment target for `=`/`??=`, and the
  checker contextually types an assignment's right side by its target (without which the VALUE of
  `(cache ??= new WeakMap)` stayed `WeakMap<any,any>` and the chained `.set()` couldn't resolve).

**Measure a checker change against the official corpus, not the gate** (`npm run gate` is parser-only).
**`assistant/corpus-ab.sh [base-rev]`** does the whole A/B: worktree at the base, `node_modules`
symlinked, both ~7min runs concurrent, a delta table, and a non-zero exit if `threw`/GAP/ERROR rose.
Full logs in `assistant/corpus-ab/{base,head}.txt` for finding which files moved. It exists because
both of its traps cost real time: a `cd` into the comparison worktree persists across shell
invocations (so a round of "my fix broke X" was HEAD measured twice), and an unsymlinked worktree
resolves a different TypeScript. Known-answer verified against `dfaea3c` (ERROR -1, everything else 0).
A towasm-only change doesn't need it.

**Totals barely move until they do.** 301 -> 301 -> 299 -> 302 -> 304 -> 299 -> 299 across ten fixes, while
the top row was replaced three times (`resolveCache` 48 -> `Set` 80 -> `opts` 73). One module-level
declaration blocks its whole file, so killing it exposes the next one. **Diff the rows, never the sum.**

Both "smaller honest limits" from earlier are now closed (`6c1010c`, `57de78c`, above). What
still legitimately rejects: `??=` on an `f32`/`i64`/`u32` optional field (only `f64`/`i32` have a box
in `nullableWtype`), a *string* as a bare truthiness condition (`''` is falsy -- needs a length test,
and a string shares its physical `{arr:'i16'}` form with real arrays so the wasm type can't decide
it), and a boxed `any` as one (could be holding `0`).

**Survey-script trap**: `selfhost-survey.sh` PRINTS the tables to stdout -- it only writes the `.json`
files. Redirect stdout yourself or `selfhost-survey.md` silently stays stale.

**Worktree trap (cost real time)**: `cd`ing into a comparison worktree persists across Bash calls. A
round of "my fix broke X" was actually HEAD's own behavior being measured. `pwd` or `git diff --stat`
before believing any before/after comparison.

**Earlier baselines, for shape only**: `fdb8b11` measured 2/235 with a 48-block `resolveCache` row on
top; `5249bff` measured 8/224 with 46 causes over 10 files.

## The ASI regression, and what it taught (2026-09-04)

`08ad816` made 5 of 10 target files unparseable and produced 119 spurious
`walk: mapper deleted a required node` errors. Root cause: **`makeCachedParser` accepted an `options`
argument and never forwarded it**, silently dropping `recover`/`merge`/`slr`/`optimize`/`forkCtx` for
every cached parser. Losing `recover` disabled ASI. Fixed in `064d5ac`; the walker errors were
downstream of the malformed ASTs and vanished with it — they were never a separate bug.

Three lessons worth keeping:
- **An accepted-but-unused parameter is not a type error.** Nothing caught this at the refactor.
- **`tsconfig.json` includes only `src/*.ts`, so `test/` is never typechecked.** A second stale call
  site (`forkCtx` passed inside the spec) survived the same refactor and only failed at runtime
  (`fdb8b11`). Consider adding `test/**/*.ts` to a typecheck config.
- **Read the provenance stamp, not just HEAD.** Both regressions were mis-attributed to the PEG commit
  `1e8e513` because that was HEAD while the tree carried 23 uncommitted files — the work that later
  became `08ad816`. Bisecting in throwaway `git worktree` checkouts settled it cleanly and never
  touched the live tree.

## Two traps this plan already fell into

- **"File X compiles" means nothing on its own.** towasm is demand-driven: a file of exported
  generics with no driver emits an *empty module*. The "walker.ts compiles clean end-to-end"
  milestone was exactly this. Note there are two walkers — `src/examples/walker.ts` (70 lines, the
  shared primitives, the one that milestone meant) and `src/examples/TS/walker.ts` (650 lines).
- **The test suite is structurally blind to the target's shape.** All 530 checks compile a
  self-contained snippet with state local; none use module-level aggregate state, which is what cause
  5 is about and what every target file is built around.

**Diagnostics are part of the work.** A missing `Array.flatMap` reports as
`Type '{k,v}' is not callable` — naming the *element* type, because member lookup falls through to
the numeric index signature. That message actively disguises clusters; fixing it re-clusters rows.

## 2026-09-12: the identity rule, once (`80ac3c4`) -- 77 moved, the largest delta recorded

Struct identity came from `T.typeKey`, the type's printed TEXT, which is finer than the physical layout.
Since wasm struct fields are mutable and therefore INVARIANT, two instantiations sharing a layout got two
structs that nothing could ever convert between -- every `internal: cannot convert ref:X<a> to ref:X<b>`
in the table was this one mistake. Fixed in both places at once (see [[tison-workaround-inventory]] for
the full rule and the rows it cleared). `compiled` went 68/324 -> 67/326 while 77 declarations moved:
**read the moved/regressed lines, never the flat total** -- exactly the trap this file already warns about.

**Method that worked, and is worth repeating.** The inventory said "log inside `buildObjectShape` BEFORE
its `const info` literal". That was right, and one step short: logging the KEY showed four `Rest<...>`
being built, but only logging each built struct's FIELD WASM TYPES showed why -- two of the four were
already byte-identical (`Rest<any>` and `Rest<unknown>`), which is what proved the key, not the layout,
was the bug. **Log the layout, not just the key.** `SHAPELOG`-style `process.env` logging inside
towasm.ts is fine for probing but MUST be removed before surveying (this file's own toggle trap).

**The one regression (`patternBindings`) is RESOLVED** by removing the marker that caused it -- it was
behaviour-identical (see [[tison-scope-stamping]]). The towasm gap it exposed -- now COVERED by the receiver analysis below --
was: `unknown field 'synthetic'` for an expando write reached through a generic
type parameter (`markSynthetic<S extends Stmt>(s: S)`, a union whose members are all generic refs).
Three fixes TRIED AND INSUFFICIENT, each reverted (do not retry these blind):
- resolving each union member as well in the expando-discovery `note` pass, to reach `S`'s constraint;
- dropping the `part.typeArgs?.length` skip there, since a generic now has one struct keyed by bare name;
- routing the write through a `Stmt`-typed helper so the receiver is a real union rather than `S`;
- and the last two TOGETHER.
So the blocker is upstream of the discovery pass, not in its member filter. If it resurfaces: log what
`note` actually receives for the write before changing anything else.

**Family (b) closed later the same day by `layoutTwin`** -- see [[tison-workaround-inventory]]; 20 moved.

## `objectKeyNames` closed -- and a walker bug under it (2026-09-12, evening)

Two separate general fixes, both found by writing the regression test FIRST:
- **Nested self-reference** (towasm): `ensureForwardHolder` only scanned the function's TOP-LEVEL
  `var_decl`s, and `objectKeyNames` sits in a switch case. `FunctionContext.initializing` now holds the
  declarators whose initializers are compiling; the forward-holder lookup checks it first, so a closure in
  its own initializer finds itself at any depth and its holder lands in that block's scope. Do NOT widen
  the shallow scan to outer blocks instead: the holder would be declared in the INNER scope and the outer
  declaration could never fill it. (That latent hazard already exists for a nested closure forward-
  referencing a later TOP-LEVEL sibling -- OPEN, untested.)
- **Walker root misclassification** (walker.ts `isType`): a bare ternary EXPRESSION root shares the tag
  'conditional' with a conditional TYPE and the field tiebreak did not cover it, so `walkB`/`walk` walked it
  as a type -- a closure whose body is a bare ternary had NO free variables and captured nothing. Fixed by
  shape (`test` exists only on the expression). Superseded by `abb7fd8` (the user's rework): `walk`/`walkB`
  now take each node's kind from the CALLER (`walkB(...).body(body)`), so nothing guesses a root's kind any
  more -- `isType`, the `test` tiebreak and the `this`/`literal` ambiguity are all gone.
Survey: 3 newly compile, 39 moved, 68 -> 71/325. The `parseInt` rows only RELABELED (call to unknown
function -> unresolved identifier) -- those closures now see `parseInt` as a free name; same blocker.

## The `??=` row closed, 45 -> 22 -> 0 (2026-09-13)

One defect in two places: a value that may be ABSENT had a NON-nullable slot, so it could neither read back
`undefined` nor be tested by `??=`.
- `addField` made every optional field nullable EXCEPT a boxed `any` (a carve-out from `6eedae0`, when `any`
  was still non-null), whose default is a boxed `0` -- an absent `defaultSubstitution?: Type` read as `0`.
- The dynamic-field protocol (`ensureAnyField`/`ensureAnyFieldWrite`: a property read or written through
  `as any`, e.g. checker.ts's own statement stamp) used the non-null `any` for its value. Now nullable; the
  receiver stays non-null.
Compiled stayed 75/328 -- all 45 moved to later blockers, nothing regressed. The two fixes also EXPOSED a
latent bug: `FunctionContext.temp` compared scratch-local types by object IDENTITY while naming them by
`wasmTypeKey`, so a fresh `nullableWtype(REF_ANY)` and the `REF_ANY_NULLABLE` constant collided under one
name. Now compared by key; `inferReturn`/`checkFunctionBody` moved on.

**`unknown method 'RefType'` closed (24 -> 0)**: a lazy global's initializer was compiled in the scope its
name was FOUND in -- for an `NS.name` read, the declaring module's EXPORT scope, which lacks that module's own
imports -- so type-utils.ts's `ANY = TS.RefType('any')` could not see `TS`. `lazyGlobalFor` now compiles it in
`moduleScopeOf(homeModule)`, the scope the module's functions already compile in.

## Expandos through untyped receivers -- `collectReceivedExpandos` (2026-09-13)

`unknown field 'pos'` 19 -> 0. Position stamping writes `pos` onto a receiver typed `T`/`any`
(`stampPos<T>`, installed as every parser's rule action; `mapObject`'s `r`; checker.ts's `at<N>`), which names
no struct, so discovery gave no struct the slot. The pre-pass now follows such a receiver BACKWARDS to its
sources: parameter -> callers' args, local -> assigned values, call -> callees' returns, ternary/logical ->
both sides, object spread -> source, with FUNCTION VALUES tracked to a fixpoint (the stamper is passed as a
value and called through a parameter). Structural shapes' expandos are keyed by member names (`shapeKey`),
not name, so a named interface and its anonymous twin keep one layout; classes stay by name. `defineProperty`
on an erased receiver lowers to the dynamic field write. The user's framing that made it tractable: a function
that stamps its own parameter makes that parameter "receive" the key, inductively through callers.
- **Known holes (runtime, not compile-time)**: trails ending at a value typed `any` (~70 for `pos`) and function
  values stored into object/array fields are not followed; a stamp reaching one hits the dynamic write's
  `unreachable`. The survey cannot see this -- it only compiles.
- **Found, separate, OPEN**: the intrinsic `object` type has no wasm representation (`<T extends object>`
  erased to its bound throws "'object' has no representation"); it should be a non-null `anyref`.
- **Trap -- a WRONG conclusion was committed here**: the object-literal row went 0 -> 34 and `ff36157` called
  it blocker order. It was a real regression: a base interface gaining expando fields stopped being its derived
  interface's wasm supertype (`CallSig` lost `super=Params`), so `{params, rest}` matched both. Fixed by
  repeating the base's full layout, expandos and `#ext` included, as the derived prefix (`derivedUpcast` test).
  The A/B was too coarse: it toggled the whole feature. Compare the struct layouts (`super=`) before calling a jump "order".

`default value must be a literal...` 19 -> 0 (76/330). towasm re-emitted every default at the CALL site, so a
default naming anything the caller can't see (`checkBlock(..., typeOf = typeOf1())`, a capture, `this`) was
rejected, and closure literals rejected ALL defaults. Now a default that can't be re-emitted is applied in the
CALLEE, as JS does: its slot is exactly an optional `p?: T` slot, callers pass `undefined`, and `declareParams`
emits `let p: T = #param$i ?? <default>`. One rule, decided by `defaultsWithImplicitUndefined`, shared by
declarations, function types and closure literals. The checker now writes an unannotated defaulted param's
inferred type back onto the node, like `applyContextualParams` does. Open: a type admitting `null` is rejected
(an omitted argument arrives as null), and async/generator functions still reject defaults.

The `indexing is only supported on number[]/...` row is NOT about strings: that message fires whenever the
indexed value resolves to no array and no class with `get` (a plain `s[i]` works via lib `String.get`).
Batch-probed 2026-09-13, it holds several causes: (a) an expression-bodied arrow lost a capture's narrowing
(`wasmTypeEq`'s `b.closure.params[i]`): towasm compiles the body as a synthesized, UNSTAMPED `return`, so
`ctx.stmtScope` stayed unset. FIXED: the checker stamps an expression body with its `inner` scope, gated on
`narrowing` like branch stamps, and the synthesized return carries it. (b) a computed key on `any`
(checker.ts:580 `out[k]`, wasm.ts:418 `(OP as any)[v.op]`) needs a runtime-keyed dynamic read. (c) a
`Record` indexed by a literal-union key (`ARR_WTYPE[we]`, towasm.ts:324). (d) `t.typeArgs?.[i]`
(type-utils.ts:2984) turned out to be (a) too: an arrow capturing a narrowed `t`. (e) about 12 declarations threw with no position at all.
**Trap**: a probe's `at L:C` names no file, and the position can be in ANY module the probe reaches
(`parse`'s 33:131 was tableCache.ts). Two repros "failed to reproduce" because I had the wrong file.
FIXED in `f9863c0`: `TSWError.module` is recorded where `pos` is, and the probe prints `module:line:col`.
`withCatchAt` wraps worklist BODIES (closures, top-level functions), which run outside their declaration's
named catch, so an error on a synthesized node now names its body ("recurse in narrow") and falls back to
the body's position. The indexing error also prints the indexed expression and its type now.
(e) was mostly array DESTRUCTURING of a non-array: `patternBindings` (transform.ts) lowers every array
pattern to indexing (`#destructure$0[0]`), right only for arrays/tuples. `const [[name, arg]] = map`
(type-utils.ts `substituteType`) indexes a Map, and `for (const [l, r] of [[..], [..]] as const)` in
checker.ts `narrow` iterates a tuple whose element type comes out `any`. JS uses the iteration protocol
here. **Correction**: towasm has NO iterator protocol -- its `for...of` lowers EVERY source to
`arr.length` + `arr[i]`, so `for (const [k, v] of map)` and `for (const x of gen())` fail too ("unknown
field 'length'"). **User, 2026-09-13: implement the iteration protocol** (`[Symbol.iterator]()`/`next()`),
keeping the indexed path for arrays, over materializing. The checker already has it (`T.iterationTypes`,
`T.memberKey` gives `'[Symbol.iterator]'`); towasm and the lib do not.
Implementation: a computed-key method registers under `T.memberKey`'s name; `iteratesByProtocol` (a non-array
with `[Symbol.iterator]`) drives both `for...of` and array patterns (`emitPatternBinding`, towasm-owned, one
typed temp per level -- transform.ts's `patternBindings` is type-blind and always indexes). Map/Set iterate
live through the lib generator `__towasm_indexed`.
**Regression I committed in `6ec2275`, fixed next**: iterating a Map/Set takes the checker's PROTOCOL path
(`[Symbol.iterator]()` returns a Generator, then `next()`'s bundled IteratorResult types `value` as `Y | R`),
not the Generator fast path I claimed. So `for (const n of someSet)` made `n: string | void`, and 14 survey
blocks became checker ERRs. The survey's "moved to a new cause" line hid it. Fix: `iterationTypes` reads an
iterator that is a global Iterator/Generator ref off its type args, as TS's getIterationTypesOfIteratorFast
does. **Lesson**: after any lib or checker change, diff the cause TABLE for new rows (especially `ERR:`),
not just the survey's "Since" summary.
**Open, found doing it**: (1) the lib's `IteratorResult` is ONE class (`value: Y | R; done: boolean`), not
TS's discriminated union, so `T.iterationTypes` can't split `value` by `done` for a user iterator class that
returns it -- its yield comes out `Y | R`. Faithful fix: make it TS's union and have `compileGeneratorFunc`
build the shape. (2) a generator returning `undefined` (`Generator<T, undefined, N>`) throws "unsupported
return type" (towasm.ts `compileGeneratorFunc`); `void` works. (3) `for...of` over a TUPLE value
(`[[a, b], [b, a]] as const`, checker.ts `narrow`) fails "unknown field 'length'" -- a tuple is neither
array-kind nor iterable to towasm.

**Progress 2026-09-13, "biggest rows first" (user's choice)**: 78 -> 80 -> 86/330. Fixed: lib find/findIndex
predicates `=> unknown` (arr:ref->i32 24 -> 0); spread of any iterable; a type parameter never infers from a leaked
copy of itself (flatMap's `[]` typed `U[]`; param 'value' 18 -> 0); lib `flat()` + `staticGuard` (a type guard its
argument's type settles is folded, the dead branch not compiled); `x || undefined`; lib `at`; discriminant vs a
literal-UNION comparand narrows; instantiation expressions as values; `typeof` as a value (run-time cascade);
collecting-constructor field locals. **Lesson (again)**: removing the leaked-`U` leniency exposed a real
checker gap (literal-union narrowing) as a NEW checker ERR -- fixed the gap, did not restore the leniency. Diff the
cause table's ERR rows after every checker/lib change. `typeof` on a fully dynamic `any` inherits
`emitTypeofTest`'s limit: an i32 array (`boolean[]`) tests as 'bigint'.
`Stmt & { type: 'switch' }` (checker.ts `clausesNeverFallOut`/`noCaseMatched`) lost `cases` in towasm: FIXED.
type-utils `isAbstract` treated a stamped member of an imported union (`EnumDecl`) as an unbound type parameter
because the AMBIENT scope did not know it, while `resolve` looks it up in the ref's own `declScope`. So the
distributed intersection kept every conflicting member. It now looks up in `declScope ?? scope`, as `resolve` does.
Guard narrowing (`if (isRef(src, 'never')) return;` then `src.type === 'ref'`) left `src` as `never` for TWO checker
reasons, both fixed: (1) inference widened `'never'` to `string` for `T extends string` -- TS's hasPrimitiveConstraint keeps
the literal (`primitiveConstraint`); (2) `narrowTo`'s false branch used lax `isAssignable`, whose inventory-C1 rule lets a
widened `string` satisfy `"never"`, so `RefType` was excluded -- exclusion now uses `precise` (inference already did).

An inferred type predicate (`isAny(t)` = `t.type === 'ref' && ...`) is only valid when its false branch is exact (TS
5.5's rule) -- the checker inferred `t is RefType` and every caller's else branch lost all RefTypes (`unknown field 'name'`,
32 -> 0). Survey 86/331 after d8a5abc/817bff7/b3bafc9: no new ERR rows; `name`, `reduce`, `stmt.cases` rows gone.

Unary `+` on a string lowers to `Number(s)` (e40b3f4, 40 blocks). TRIED AND REMOVED: taking a method's owner from
`(x as T)` when `x` is `any`/`unknown` -- UNSOUND, since an `unknown` array literal is built as a boxed `arr:ref`, so `as
number[]` traps (illegal cast). The any-METHOD dispatch (`findAnyDispatchCandidates`) only takes ZERO-arg methods and
skips array-backed owners; the general fix is a dynamic call convention with arguments -- the same design as item 4.

**Next rows** (86/331): `cannot convert ref:Param to
ref:{...}` 23 -- a NAMED struct passed where a STRUCTURAL type is expected (`hasMod(p, 'optional')`, param `{modifiers?:
string[]}`): towasm has no struct -> structural-supertype conversion, a representation design question for the user;
direct calls through `any` 22 (item 4, user decision pending); `unknown method 'some'` 17 (`(x as T[]).some` over an
`unknown`); `closure parameter 'name' needs an explicit ... type` 14; `unknown method 'parse'` 24 -- `JSON.parse` in tableCache.ts. **User, 2026-09-13:
skip tableCache.ts entirely for now** -- do not work this row, and do not touch tableCache.ts; `indexing is only supported
on number[]/...` 19 (not strings, see above); `only direct calls...` 21 -- core.ts:185 `params[0](...)`, calling an
`any`-typed value, which needs a calling convention for closures boxed as `any`; `param 'value' needs an
explicit type` 18; `cannot convert arr:ref:true to i32` 18; `unsupported expression 'instantiation'` 16 --
`export const CallSig = JS.CallSig<Type>` (ts-parser.ts:29).

**Traps hit this session**: parallel Bash calls share ONE working directory -- a `cd` in one races another's
relative paths (a survey "lost" its baseline JSON this way); run each in a `( cd X && ... )` subshell. And
my own grep filter (`grep -v 'free=\[\]'`) hid the decisive log line for three rounds: when a probe prints
nothing, rerun it UNFILTERED before concluding a code path was never reached.

## Scope

In: towasm.ts, checker.ts, type-utils.ts, walker.ts, transform.ts, tison.ts, ts-parser.ts,
js-parser.ts, `binary-libs/src/wasm.ts`. True bootstrap — the image parses raw TS source text itself,
including the parser engine and grammars (explicit user correction: don't treat tison as a native
pre-pass). Out: `tableCache.ts` (fs/crypto/zlib convenience wrapper), `module-loader.ts`.

**Unscoped transitive requirement**: wasm.ts uses 26 distinct `bin.*` entry points, so the whole
`binary` package (~4.7k lines) is needed too. Real target is ~27k lines, not ~22k.

**Standing rule**: a dependency's real source is off-limits to rewrite just to dodge a compiler gap
([[feedback-no-simplifying-deps-for-selfhosting]]). Hard constructs need a real compiler feature.
`binary-libs/wasm.ts`'s metaprogramming is *not* a simplification target — its elaborate generic types
are hand-asserted via casts and fully erased; the runtime underneath is ordinary dynamic JS that must
genuinely run ([[feedback-types-vs-runtime-behavior]]).

The phased roadmap at `~/.claude/plans/witty-plotting-kernighan.md` is sequenced by file, which is
the wrong cut — work the cause table instead. Full 186KB original of this memory, with the complete
per-gap history, is at `../memory-archive/tison_towasm_self_hosting_plan.md`.
