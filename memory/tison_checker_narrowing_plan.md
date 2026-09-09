---
name: tison-checker-narrowing-plan
description: Planned checker feature (integer/range narrowing for numbers) and why it matters to towasm.ts
metadata: 
  node_type: memory
  type: project
  originSessionId: c2e69915-5131-4028-bab6-a72ffab7a920
  modified: 2026-07-31T23:18:46.586Z
---

User plans to add "narrowing" info to the checker (`tison/examples/TS/checker.ts`/`type-utils.ts`) so a
`number` value can be known to actually be an integer, plus its possible value range. Stated 2026-07-31,
no timeline given.

**Why:** `towasm.ts` (the wasm-GC backend) currently has no way to ask the checker "is this provably an
integer/in-range" — it fakes the distinction with ad hoc, scattered heuristics: `arithInline`/
`equalityInline` dispatch i32-vs-f64 purely off `args[0]`'s kind, `operandKind`/`arrayKindOf` special-case
indexed reads because the checker gives `any` for them, and numeric literals get a "transient i32" tag
from `emitExpr` that has to be reconciled against the checker's `number` type at every `var_decl`/
`emitAs` call site (see [[tison_towasm]] and the `substElem`/`ARRAY_ELEM_TYPES` design work same day).
This whole class of fragility was discussed at length in the 2026-07-31 towasm session.

**How to apply:** Once real narrowing lands, revisit `towasm.ts`'s i32/f64 dispatch — `arithInline`/
`equalityInline`/`operandKind` could likely dispatch off the checker's own narrowed type instead of the
current heuristic chain, which would remove real fragility rather than just reorganizing it. Don't assume
this is done until confirmed in a later session (check `type-utils.ts` for actual narrowing support
before citing it as available).
