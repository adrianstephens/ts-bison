---
name: tison-unbound-type-param-row
description: OPEN, diagnosed but unfixed — the survey's largest row (~109 declarations) is a signature reaching codegen with its typeParams gone but its params still naming one. Reproducer, what is ruled out, and the single remaining question.
metadata:
  type: project
  modified: 2026-09-17
---

The self-hosting survey's biggest cause row. **Diagnosed, deliberately NOT fixed** — the two obvious fixes
are forbidden workarounds, and the real one is in fragile substitution code that should not be improvised.

## Reproduce it in ~30s

```
npx ts-node -T tison/assistant/probe-one-decl.ts tison/src/examples/TS/type-utils.ts \
    typeofName tupleReadType primitiveConstraint intersectionConstraint
```

All four fail with the **identical** message — `function type parameter 'x': 'T'367' has no representation,
in '(x:T'367) => T'367'` — so it is ONE shared signature being hit repeatedly, not a per-declaration fault.
Run from the workspace root. (`alwaysThrows` in `checker.ts` is NOT a reproducer: it is one of the ~20 that
compile with a fresh scope. Shared-vs-fresh `libScope` changes only WHICH declaration hits the wall first;
re-probing all 129 with a fresh scope per run still fails 109.)

## The mechanism, confirmed

Every failure exits through the single throw in `closureSigParts` (`TS/backend.ts`). At that point the
signature **has no `typeParams`, while a parameter annotation still names one** — so the substitution branch
just above (`if (func.typeParams?.length)`, which exists precisely for generic signatures) never runs, and
`typeOf` has nothing to resolve `T'367` to.

Proof without instrumenting anything: `printer.ts`'s `case 'function'` renders `typeParams(t.typeParams)`
before the parameter list, and the message shows `(x:T'367) => T'367` with **no `<…>` binder**.

## Three claims from the first write-up that are WRONG — do not act on them

1. **"`T'N` is a red herring, typeKey renames for display."** No. `typeKey` is `tocode.type(t)` — the
   printer, no renaming. `T'367` is the actual name in the node.
2. **"The fresh names are `U'N`/`S'N` from `arrayMethod`."** Not for these. `freshTypeParamName` has exactly
   four call sites: `avoidCapture` (base = the existing param's own name) and three in `arrayMethod` that
   mint `U`, `U`, `S`. A `T'`-based name can ONLY come from `avoidCapture`.
3. **"The parameter named `x` means it is `Object.entries<T>(x: T)` in lib.d.ts."** No. Those return
   `[string, any][]` / `any[]` / `string[]`; this signature returns `T`. **No `(x: T) => T` exists anywhere
   in `lib/`** — so the failing signature is synthesized, not read from source.

(Also corrected: the first write-up said `tison/CLAUDE.md` flags the substitution core as fragile. It does
not — CLAUDE.md says nothing about substitution. The fragility notes that exist cover different areas:
`Array`'s dual declaration in [[tison-towasm-self-hosting-plan]], `resolveTypes` in
[[tison-readtype-resolution]].)

## Ruled out — all three PRESERVE typeParams, verified by reading them

- `avoidCapture` (`type-utils.ts`) — renames the bound param and every reference to it consistently, and
  rebuilds `typeParams` with the new names.
- `substituteShadowed` — rebuilds `typeParams: own.map(...)`.
- the walker's `mapSig` — includes `typeParams: mapArrayA(mapTypeParam)`.

So the loss happens **downstream of substitution**, not inside it.

## The single remaining question

`closureSigParts` has exactly ONE caller: `typeOfUncached`'s `case 'function'`, which passes `resolved` —
the output of `T.resolve`. **So: does `resolve` (or something it calls) rebuild a function type without its
`typeParams`?** That is where to start, and it is one question rather than a hunt.

## Do not "fix" it either of these ways

Deleting the throw, or returning `REF_ANY` for an unbound parameter, converts 109 honest failures into 109
silent `any` boxes. The survey count would jump while nothing worked — exactly what CLAUDE.md's
"instruments must not reward silence" section describes.

Related: [[tison-session-handoff]], [[tison-checker-inference]], [[tison-towasm-self-hosting-plan]].
