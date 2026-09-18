---
name: tison-unbound-type-param-row
description: RESOLVED 2026-09-17 — the survey's ~109-declaration "function type parameter 'x': 'T'367' has no representation" row was inferTypeArgs leaking a GENERIC argument's own bound type parameter; fixed with baseSignature. How it was found, and the traps.
metadata:
  type: project
  modified: 2026-09-17
---

**Resolved.** The row went from ~109 declarations to 3, and those 3 are unrelated signatures
(`EnumValue<EnumType>`, `Parameters<typeof …>[1]`). The ~96 that moved now stop at the next real wall,
`param 'fields' needs an explicit type`.

## Root cause

`walker.ts`: `const mapTypeA = mapDefined(mapType)`. `mapType` is GENERIC (`<T extends Type>(t?: T) => …`,
from `makeProcess`), and `mapDefined<T>(map: (x: T) => T | undefined)` infers its `T` from it.
`inferTypeArgs`'s `function` case (and its `method`-member twin) matched the argument's parameters without
accounting for the argument's OWN `typeParams`, so `T := T'367`: the bound name escaped its binder, and
`mapTypeA` came out `(x: T'367) => T'367`. The substitution layer (`avoidCapture` etc.) was innocent;
the memory's earlier "is it `resolve`?" question was wrong too.

**Fix:** `baseSignature` in `type-utils.ts` — TS's `getBaseSignature`: own type params → their
constraints (`unknown` when unconstrained), applied to the argument signature before matching. TS would
go further with higher-order inference (TS 3.4) and give `<T extends Type>(x: T) => T`; tison does not
implement that — a missing feature, not this bug.

## How it was found (reusable technique)

The throw's message names a fresh `T'N`. Instrument `freshTypeParamName` to print a stack when the id is N,
then instrument `typeKey` to print a stack when it renders the failing string: the second stack reached
`emitStmt`'s local-declaration `typeOf`, and one temporary log there printed the function and local name.

## Traps

- `test/test-checker.ts` imports from `dist/` — an A/B without `npm run examples` on each side tests nothing.
- The checker shows the leak too: before the fix the checker printed
  `(x: any) => any` for the test's `total(id)`, silently `any`-ing it — so the leak was ALSO a checker
  silent-`any`, not just a codegen throw.

Related: [[tison-session-handoff]], [[tison-checker-inference]], [[tison-towasm-self-hosting-plan]].
