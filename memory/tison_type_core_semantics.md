---
name: tison-type-core-semantics
description: "type-utils.ts was split (2026-09-18) into TS/type-core.ts (language-neutral, TS vocabulary) + type-utils.ts (JS runtime rules, re-exports the core). The Semantics hook on a root Scope is the seam a Python front end plugs into; what stays out of it, and the C++ tiering."
metadata:
  type: project
  modified: 2026-09-18
---

**Shape.** `TS/type-core.ts` holds the whole type model, spelled in TypeScript's vocabulary: `Array`,
`Promise`, `Function`, `Object`, `null`/`undefined` stay core *names*. The user's decision: other
languages reuse the TS types internally, and each language's lib declares what those names contain.
`TS/type-utils.ts` is TypeScript's layer. It holds truthiness, `typeof`, JS literal typing
(`literalTypeOf`), the iteration protocol (`[Symbol.iterator]`), the hand-modelled Array methods,
`FixParams`/`FixSig` and `makeGlobal`, and it does `export * from './type-core'`. Every TS consumer
still imports `type-utils` as `T`; a Python front end must import `type-core` and never `type-utils`.

**The seam is `Semantics`** (in type-core, beside `Scope`). A root `Scope` is constructed from one
(`new Scope(TS_SEMANTICS)`); every child copies its parent's `scope.semantics`. The constructor takes
`Scope | Semantics`, so a root without one is a compile error, not a runtime check. Detached export
scopes in checker.ts use `new Scope(inner.semantics)`. The core calls the hooks in exactly two places:
- `lookupMember`: `refinedMember` first (TS: `length` bounds, Array method refinements), then `boxed`
  for a primitive ref, then `apparentMember` as the object/callable fallback (`Object`/`Function`).
- `isAssignable`: `boxed` (a primitive against a structural target or a class).

**Why the interface is so small.** The measured call graph found only these core→JS edges. Everything
else JS-specific (truthiness, typeof, iteration, globals) is called only by the TS front end, so it moved
out with no hook at all. Do not grow `Semantics` for a question only a front end asks. That code belongs
in the language's own layer.

**Not built:** Python semantics. The seam is unverified until a Python front end uses it. Its known gaps
are keyword arguments (`TS.CallSig` has no pass-by-name), Python truthiness, `isinstance`, and MRO/dunder
member lookup.

**C++ (discussed, not planned):** the common core for C++ is smaller: type terms, scopes/namespaces,
substitution, `typeArgMap` defaults, deduction (`inferTypeArgs`/`matchInfer`). Unions, literal types,
`any` and narrowing are TS+Python only. Leaks to fix before C++ could use the core: `substituteType` calls
`reduceInstantiated` (union/any reduction), `typeKey` prints via the TS printer, and `resolve` mixes
mapped/conditional/`keyof` with plain ref expansion. See [[tison-towasm-cross-language-plan]].
