---
name: tison-towasm-nullable-primitives
description: "towasm.ts nullable-primitive support (number|null, boolean|null) — representation, coerceTop extension, and the checker gaps it exposed"
metadata: 
  node_type: memory
  type: project
  originSessionId: 40e5e473-1802-45b7-97bc-65a00de50147
  modified: 2026-08-15T19:45:02.263Z
---

2026-08-15: implemented nullable-primitive support in [[tison_towasm]] (towasm.ts), closing the last
"Types:" gap in the file's own top-of-file comment. Plan-mode → approved → implemented in one session.

**Design**: reused the existing `ensureBoxType`/`{typeIndex, nullable}` shape (already used for boxing
a scalar into `any`) rather than inventing a new `WasmType` variant — inherits `toValType`/
`heapTypeIndexOf`'s existing generality for free. Added `primKind: 'f64'|'i32'` directly on the box's
own `WasmType` object (not a side-table keyed by type index) — a reverse-lookup map was the first
design but `registerType`'s structural memoization can coincidentally share a type index between an
`ensureBoxType('f64')` box and an unrelated single-f64-field struct (e.g. a closure env), which would
have corrupted a table-based lookup. Two small pure helpers (`unboxedPrimitive`, `scalarKind`) plus
`nullableWtype` (builds the nullable form of any WasmType, boxing bare scalars) are the "small helper"
the user asked for — they let `coerceTop`'s new unbox/box branches, `numericPairWtype`/`equalityInline`/
`arithInline1`'s operator-kind dispatch, and every `?.`-optional-chain site all share one mechanism
instead of scattering type-shape checks. Scope-limited: `++`/`--` on a nullable primitive still
rejected (needs narrowing-then-non-null tracking codegen doesn't have), with a clearer error message.

**Real bugs found during implementation** (beyond the planned scope, all fixed):
- `emitExpr`'s `case 'conditional':` (ternary) computed its own type via `wtypeOf(e,ctx)`, ignoring the
  caller's `want` — safe for bare scalars (coercion happens at the outer level) but wrong for boxed
  nullable primitives: a ternary branch like `n ? null : 42` self-narrowed `42` to an `i32` box while
  the context wanted an `f64` box, and the box-kind-conversion `coerceTop` then did `ref.as_non_null`
  unconditionally on what could be a genuine `ref.null` from the other branch → runtime trap. Fixed by
  preferring `want` when the caller has one.
- `coerceTop`'s `any`→concrete narrowing branch called `I.ref.cast(heapTypeIndexOf(want))` with no
  second arg, always defaulting to a *non-nullable* cast even when `want` was nullable — broke reading
  a `null` element back out of a `'ref'`-kind array (e.g. `(number|null)[]`) with "illegal cast". Fixed
  by passing `!!want.nullable`. Generic fix, not primitive-specific.
- Array-literal/rest-arg/index-assign per-element write targets used the bare `REF_ANY` singleton
  (non-nullable) even for `'ref'`-kind array slots, which physically *are* nullable anyref — writing a
  literal `null` element threw. Added a `REF_ANY_NULLABLE` singleton.
- `emitTruthy` (if/while/ternary-test/`!` conditions) had no unbox branch at all — `b.flag ? ... : ...`
  on a `boolean | null` field threw "cannot be used as a boolean condition". Fixed to unbox via the same
  `unboxedPrimitive` helper first.
- My own `a?.field`/`a?.method()` fixes initially forgot to `coerceTop` the raw field/method result into
  the boxed nullable return type before handing it to `emitOptionalAccess`'s two `if`-arms (which must
  produce the same wasm value type) — real wasm-validation type error, caught by dumping WAT via
  `mod.toWAT({expandTypes:true})` (also usable via `tsw.ts --wat`) and comparing the two branches.

**Checker gaps found, handed off to (and fixed by) a background agent same session**:
`case 'index':` in checker.ts's `typeOf` never read `e.optional` *and* never `T.nonNullable`-stripped
the object type first (so `arr?.[i]` on `arr: number[] | null` fell through every branch to `T.ANY`
regardless) — both fixed, mirroring `case 'member'`'s existing pattern. Second bug root-caused to
towasm.ts, not checker.ts: the unannotated-`const` var_decl fast path (~towasm.ts:2856-2894) read a
method/index-callee's raw declared type directly off the decl, bypassing `checker.typeOf`'s own
`calleeOptional`/`e.optional` wrapping entirely — fixed by capturing and reattaching it there. Full
suite went 258→270 (agent added its own tests), verified via `tsc -b` + plain `node` (raw `ts-node
--transpile-only` against the full suite is unreliable in this environment — hits a deterministic-looking
but environment-specific failure around test #201 that doesn't reproduce standalone or via a proper
build; same class of issue the agent independently found and worked around — always verify via `tsc -b
src/examples` + `node dist/...`, not raw ts-node, for the full suite specifically). Also re-confirmed
the known `T.isNumberLike` union-leniency gap (unnarrowed `x + 1` on `number|null` passes the checker)
is real and unfixed by design — verified it traps cleanly at runtime instead of misbehaving, which is
the accepted mitigation.

**Also found, not a bug**: `Array<T>`/`String` both already declare a real `get length()` getter
(lib/array.ts:10, lib/string.ts:49) — the separate `arrayKindOf`-based `.length` fallback in
`emitExpr`'s member-access case is dead code for those two (getter dispatch wins, checked first), but
still load-bearing for a plain non-nominal `T[]` array type with no `ClassInfo` at all.

Test suite: `test/test-towasm.ts` was 258→266 (added real assertions; replaced 3 stale
"this throws because it's unimplemented" tests per [[feedback_no_unimplemented_throws_tests]], all now
real positive tests), full suite green, `tsc -b src/examples` clean.
