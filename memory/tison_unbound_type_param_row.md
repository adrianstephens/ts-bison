---
name: tison-unbound-type-param-row
description: OPEN, diagnosed but unfixed — the survey's largest row ("has no representation", ~109 declarations) is a substitution-layer bug that drops a signature's own typeParams before codegen. Read before touching closureSigParts.
metadata:
  type: project
  modified: 2026-09-17
---

The self-hosting survey's biggest cause row. **Diagnosed, deliberately NOT fixed** — the two obvious fixes
are forbidden workarounds, and the real one needs a session with the type structure in hand.

## What is established

- The row is **real, not an instrument artifact**. The first hypothesis was that it came from the survey's
  shared `libScope`, since with a fresh scope `alwaysThrows` compiled and the same error moved to a later
  declaration. Re-probing all 129 with a **fresh scope per run still fails 109** (20 compile). Shared vs
  fresh changes only WHICH declaration hits the wall first, never whether.
- Every one of the 109 exits through the **single throw in `closureSigParts`** (`TS/backend.ts`, the
  `has no representation` message).
- At that throw, `func.typeParams` is empty **while a parameter annotation still references an unbound type
  parameter** — a signature that owns a type parameter reached codegen with the binding already dropped, so
  the substitution branch just above it (`if (func.typeParams?.length)`, which exists precisely for generic
  signatures) never runs.
- **The `T'N` in the message is a red herring** — `T.typeKey` renames type params for display. Instrumenting
  the mint showed the real fresh names are `U'N`/`S'N`, from two sources: `arrayMethod`'s hand-built
  signatures and `avoidCapture` (`type-utils.ts`, with `substituteShadowed`'s callers).
- The parameter is literally named `x`, and the only synthetic signatures with a parameter named `x` are the
  hand-written `Object` intrinsics in `lib/lib.d.ts` — `entries<T>(x: T)`, `values<T>(x: T)`, `keys<T>(x: T)`.

**So the fix belongs in the substitution layer** — `avoidCapture`/`substituteShadowed`/`withReturnType`
failing to carry a nested signature's own `typeParams` through to codegen — **not at the throw.**

## Do not "fix" it either of these ways

Deleting the throw, or returning `REF_ANY` for an unbound parameter, converts 109 honest failures into 109
silent `any` boxes. The survey count would jump while nothing actually worked — which is exactly the trap
`CLAUDE.md`'s "instruments must not reward silence" section describes.

## One correction to the write-up this came from

It claimed the substitution core is "flagged in `tison/CLAUDE.md` as historically fragile". **It is not** —
CLAUDE.md says nothing about substitution or `avoidCapture`. The fragility notes that do exist are about
different areas: `Array`'s ambient-interface/real-class duplication (in [[tison-towasm-self-hosting-plan]])
and `resolveTypes`/return-type inference (in [[tison-readtype-resolution]]). Do not go looking for a
guardrail that isn't there.

## Verified against the tree at 2026-09-17

`closureSigParts` and its throw, `lib.d.ts`'s three `x`-parameter intrinsics, and `avoidCapture` /
`substituteShadowed` / `arrayMethod` in `type-utils.ts` all exist as described. Line numbers in the original
write-up are off by one or two — the user renamed symbols in `wasm-codegen.ts` the same evening. **Locate by
function name, not line number.**

Related: [[tison-session-handoff]], [[tison-checker-inference]], [[tison-towasm-self-hosting-plan]].
