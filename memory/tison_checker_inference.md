---
name: tison-checker-inference
description: "tison checker inference/conditional mechanisms added 2026-09-08 — distributive conditionals, contextual callback returns, provisional bindings, tuple inference, and the `undefined` binding the wasm path was missing."
metadata:
  type: project
---

Five connected checker mechanisms, all landed 2026-09-08 while clearing towasm.ts:193's
`new Map(LIB_AST.filter(...).map(n => [n.name, n]))`. Read together: they are how a type argument
gets inferred through a nested generic call.

**Tuple inference (`9603085`).** `inferTypeArgs` had cases for array/ref/intersection/conditional/
function but NONE for a tuple, so `constructor(entries: [K, V][])` inferred nothing and every
entries-style construction was `<any, any>` — which towasm rejects outright.

**Contextual array literals (`9603085`).** A generic parameter's declared type is deliberately NOT
passed as an argument's expected type. An array literal is the exception: `case 'array'`'s `wantTuple`
needs only the tuple SHAPE, and the type params inside `[K, V][]` land solely as per-position expected
types where an unresolved ref is inert. **The shape is the information, the leaves are inert** — that
principle recurs in all of this.

**Contextual callback RETURN + provisional bindings (`af8175a`).** Reverse matching (`expected` vs
`sig.returnType`) already existed and already fired, binding `.map`'s `U = [K, V]`. Two things were
missing: `applyContextualParams` typed a callback's PARAMETERS but nothing typed its RETURN (so the
literal never became a tuple), and the placeholder binding was taken as the ANSWER — `out`'s
first-wins guard then made the deferred body-derived inference a no-op and `K`/`V` leaked out as
`Map<K,V>`. A binding still mentioning an unsolved param now yields to the argument's own type.
**A hint must carry structure**: threading a bare unsolved `R` through cost 2 real diagnostics
(`after<V, R>` in binary/src/interop.ts), found by bisecting with env toggles, not by reasoning.

**Distributive conditionals (`ba8a867`, `e536ffd`).** `Extract<T,U> = T extends U ? T : never` only
works if the union distributes; tested whole it fails and the entire family (`Extract`/`Exclude`/
`Omit`) collapsed to `never` — assignable to everything, so it failed SILENTLY, surfacing only as a
member read coming back `any`. Distributed at the ALIAS-INSTANTIATION site, not the conditional node:
each arm must see the member substituted for `T` in its BRANCHES too, and by the time a conditional
node exists that has already happened. Only when every type argument is CONCRETE (real TS defers
otherwise). `e536ffd`: a DOTTED name is never a type parameter — `scope.type` doesn't split on '.', so
`TS.Stmt` looked unbound and blocked its own distribution.

**`undefined` had no binding on the wasm path (`f37c63c`).** `makeLibScope` starts from a bare
`new Scope` and builds globals from `lib.d.ts`, which CANNOT declare `undefined` — real tsc rejects it
as a built-in conflict. `T.makeGlobal` binds it for the checker-only path. So the identifier typed as
`any`, `cond ? x : undefined` came out `number | any`, and the `any` swallowed the union leaving
nothing nullable for a later `!== undefined`. One `addValue` in `makeLibScope`.

**Measuring these**: `corpus-ab.sh`'s total LIES here — the distributive fix read as +4 errors and all
four were TRUE POSITIVES that TypeScript's own `.errors.txt` baselines require (`omitTypeTestErrors01`,
`intersectionsAndOptionalProperties`, both built on `Omit`). Attribute with
`assistant/corpus-errdump.ts` and check the TS baseline before believing a regression. See
[[tison_corpus_errdump]].

**Const contexts and template literals (`87e2045`, 2026-09-10).** `as const` / a `const` type
param's argument make a READONLY TUPLE (`CONST_CONTEXT` travels as the expected type, so the
`recurseCache` stays sound). Making `E4 = [...] as const` a real tuple exposed two older gaps:
`inferTypeArgs` fixed `T` from a tuple's FIRST element against `readonly T[]` (now pools and unions
every element), and template literal types were NEVER evaluated -- a `Literal` whose value is a
parts array, which `isLiteral(t, 'string')` also accepts. `resolve` now expands finite ones to their
cross product (`expandTemplate`); unexpandable ones match as a regex (`templatePattern`).

**Probe traps found doing it**: (1) `isAssignable(string, 'x')` is TRUE by design (widened-source
leniency) and declarations widen their init first, so `const f: 'x' = 'q'` is SILENT -- a probe on a
literal mismatch needs `as const` or a non-literal source. (2) A read of a missing member on an
OPAQUE type is silently `any`, so a "does this key exist" probe proves nothing; assert the member's
TYPE (`const bad: string = s.yx` must error). (3) test-ts-parser prints its errors to STDERR.

Related: [[tison_nominal_class_refs]], [[tison_towasm_self_hosting_plan]].
