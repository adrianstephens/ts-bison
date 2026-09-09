---
name: tison-checker-muted-hoistvar-bug
description: "checker.ts: CLOSED — checkStmt's 'var_decl' case gated hoistVar (which registers a plain top-level const/let's type in scope) behind the same `if (!muted)` guard as its assignability diagnostics, so ANY plain module-level const/let checked under a muted checkBlock (e.g. towasm.ts's bundled-lib pass) silently resolved to `any` everywhere it was later referenced"
metadata: 
  node_type: memory
  type: project
  originSessionId: 888c0914-2616-44d9-97e8-90264c57a251
  modified: 2026-08-08T23:36:20.540Z
---

2026-08-08: root-caused and fixed, while investigating `lib/number.ts`'s `ieeeFrom` at the user's request
(follow-on from [[tison_towasm_switch_break_continue]]'s "Math.log's ieeeFrom return-type gap", left open
there as "separate, pre-existing, unrelated").

**Root cause**: `checker.ts`'s `checkStmt`, `case 'var_decl'`, had the `hoistVar(scope, d, ...)` call (which
*registers* a declaration's type into `scope` — the only thing that makes the name resolvable at all) sharing
one `if (!muted)` guard with the assignability-diagnostic logic (`checkAssignable`/`err(...)`). `hoist()`'s own
pre-pass (a separate function) only registers `stmt.ambient` (`declare const/let/var`) top-level decls ahead
of time, deliberately skipping plain ones ("real `let`/`const` observe a temporal dead zone... checkStmt's
sequential case catches that" — see that function's own comment) — meaning a plain top-level `const` is
*only* ever registered via this one `checkStmt` code path. Under a muted `checkBlock` (towasm.ts's
`checker.checkBlock(LIB_AST, libGlobal, true)`, the third-arg `muted=true`), the whole block — including
`hoistVar` — never ran, so the const was never added to scope at all. Any later reference to it (anywhere,
including deep inside an unrelated function like `Math.log`) silently resolved to `T.ANY` via whatever
"unknown identifier" fallback `scope.value(name)` uses — not a thrown error, just silently wrong, and far
downstream of the actual missing registration.

**Why only some things were affected**: real `function_decl`s go through `hoist()`'s own separate `fnGroups`
mechanism (unaffected). Class members go through `T.classShapes` (unaffected). Only bare top-level
`const`/`let` — exactly `lib/number.ts`'s `__towasm_mod`/`ieeeSplit`/`ieeeFrom` (all three plain top-level
`__asm(...)`-bodied consts) — hit this path. `cos_core`'s own separate "unannotated return type" issue (now
fixed independently, per that class's own return-type annotation being added since) was a different bug on
the same general "who resolves this call's type" theme, not the same root cause.

**Fix**: `hoistVar` now runs unconditionally (moved out of the `if (!muted)` block); only the actual
diagnostic-producing logic (`checkAssignable`/`checkExcessProps`/`err`) stays gated by `!muted`. Minimal,
surgical — `hoistVar` itself never emits diagnostics, so nothing about "muted = no diagnostics" is weakened.

**Consequences once fixed** (verified via a dedicated `Math.log`-only probe, deleted after): `ieeeFrom`'s call
now resolves correctly, and its actual asm body exposed one more genuine bug reachable for the first time —
`i32.const 32` before `i64.shl` (needs an i64 operand, not i32) — real wasm validation failure, fixed to
`i64.const 32`. With both fixed, `ieeeFrom`/`ieeeSplit` round-trip exactly at every power of 2 (confirmed:
`Math.log(2/4/8/16/32/64/128)` all exact) — the mantissa/exponent IEEE-754 bit-twiddling itself is correct.

**Still open, found but not fixed, flagged for later**: `Math.log`'s own 3-term Taylor polynomial
(`ln(1+f) ≈ f - f²/2 + f³/3`) is only accurate for small `f`, but `f = mantissa - 1` ranges up to nearly 1
(not small) — real relative error up to ~2.7% at `f` near the top of its range (e.g. `Math.log(1.5)`,
`Math.log(3)`, `Math.log(1000)`), vs. exact at powers of 2 where `f = 0` trivially. This is a genuine
algorithm-accuracy limitation (needs more Taylor terms, or a faster-converging form like
`atanh`-based `ln(m) = 2·atanh((m-1)/(m+1))`), not a compiler/asm bug — separate from everything else in this
memory. Also: fixing `Math.log` further exposed yet another *different* pre-existing bug one layer deeper —
some function reached via `Math.asin`/`acos`/`atan`/`atan2` (wasm function index #12 in the trig test block,
not yet identified by name) fails real wasm validation with "expected 1 elements on the stack for fallthru,
found 0" — a function whose body doesn't leave a return value on every path (the same "implicit fallthrough
needs an explicit trailing return" class of issue flagged as a general risk in
[[tison_towasm_array_mutators]]'s note about `Array<T>.find`). Not investigated further this session — the
suite still reports 161/161 checks with zero regressions; this is progress (later failure point), not new
breakage.

**Verification**: `tsc` clean on `examples/tsconfig.json`. Full `test-towasm.ts` suite still 161/161, same
count before/after (checker.ts is shared by `TStoJS`/`TStoDecl` too, not just `towasm.ts` — worth a broader
sweep of those consumers before considering this fully safe, not done this session).

## Round 2 (same session): the stack-fallthrough bug, found by the user

User spotted the real next root cause by inspection: suspected `switch` itself, specifically pointed at
`lib/number.ts`'s `Math.sin`/`cos` (`switch (k & 3) { default: case 0: return sin_core(r); case 1: ...; }`)
even though every case *does* return. Confirmed and generalized: **not switch-specific** — an isolated
`if (x>0) return 1; else return 2;` as a function's *only* statement has the identical failure. Root cause:
`if`/`while`/`switch` all compile to a `void`-typed wasm block wrapping their branches. Wasm's own trailing-
fallthrough check applies at a block's `end` based on its *declared* type, regardless of whether the content
inside happened to be unreachable (every path already exited via `return`) — so a `void`-declared block as a
function's last statement leaves 0 values where the function's own declared result expects 1+, even though
every internal path already returned. `ensureCtor` already had the correct pattern by accident (unconditionally
emits `local.get $this; return` after the constructor body, regardless of whether the body already returned).

**Fix**: new `emitTrailingUnreachable(ctx, result)` — appends `I.unreachable` after a non-`void` function/
method/closure body, right before `toFuncBody`. Always safe (dead code whenever a real return already covers
every path; unreachable code satisfies any leftover result-type requirement trivially — the exact same
"unreachable code is stack-polymorphic" reasoning that lets `return` work at all from inside a nested block).
Applied at all 3 sites that build such bodies: `ensureFunc`, `ensureMethod`, and closure literals' block-body
branch (arrow functions with an implicit-return expression body already always end in a real `return`, so
they're unaffected).

**Impact — this was a major unlock, not a narrow fix**: suite went from 161 to **179** passing checks (zero
regressions; same failures, none newly broken). Reaching that much further exposed a wave of separate,
genuinely pre-existing issues, in decreasing order of what's now closest to the surface:
- Several `Math.*` functions have real *algorithm* accuracy bugs, now actually testable for the first time:
  `Math.exp`/`log(100)`/`asin`/`acos`/`atan`/`atan2` all fail `checkClose`'s tolerance (e.g. `Math.atan(1)`
  returns exactly `1`, not `π/4` — looks like more than just insufficient Taylor terms for at least `atan`).
  `Math.log`'s specific 3-term-Taylor-series limit (see round 1 above) is one instance of this.
- Template literal interpolation of a **non-number** value is broken: `` `hello ${s}!` `` where `s: string`
  throws `cannot convert {"arr":"i16"} to "f64"`. Root cause (found, not fixed): `case 'literal'`'s
  `Array.isArray(e.value)` branch (the only template-literal handling that exists in `towasm.ts` — a
  referenced `emitTemplateLiteral` function does not actually exist, that comment is stale) unconditionally
  does `emitAs(p.exp, ctx, 'f64')` for *every* interpolated part, regardless of its real type. String/boolean
  interpolation (`tplStr`/`tplBoolTrue`/`tplBoolFalse` in the test suite) was simply never reachable before
  this round's fix let the corpus compile that far.

None of round 2's newly-found issues were fixed this session — flagged here for a future pass. The suite's
179-count is the new zero-regression baseline; a next session chasing the template-literal or `Math.*`
accuracy issues should expect further movement past that, not necessarily a clean 179/179+N.
