---
name: tison-checker-scopeofstmt
description: "checker.ts's scopeOfStmt mechanism exposing narrowing-aware per-statement scopes to towasm.ts; two design iterations and why; a real pre-existing bug it uncovered (RegExpMatch.group() chaining)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 40e5e473-1802-45b7-97bc-65a00de50147
  modified: 2026-08-16T01:15:39.191Z
---

2026-08-15: added `checker.scopeOfStmt(stmt): Scope | undefined` (checker.ts, exported from
`makeChecker`'s return object next to the existing `scopeOf(fnj)` for `CallSig.scope`). Fixes a real
gap: towasm.ts's own `ctx.scope` (built independently during codegen) never reflects flow-sensitive
narrowing — `emitStmt`'s `case 'if'` never builds a narrowed child scope the way `checkStmt`'s own
`narrow()` use does — so any `checker.typeOf(expr, ctx.scope)` call from towasm.ts for an expression
involving a variable narrowed earlier in the same function (`if (m === null) return; ...; m.foo()`)
would see the un-narrowed type. towasm.ts's `emitStmt`'s `var_decl` case now does
`checker.scopeOfStmt(s) ?? ctx.scope` before calling `checker.typeOf` for an unannotated declaration.

**Final mechanism (2 design iterations, both real, in order)**:
1. First attempt: a stamped `scope?: unknown` field directly on the `Statement<T>` AST type (mirroring
   `CallSig.scope`'s own declared field) via `(A|B|C|...) & {scope}`. Broke unrelated code in
   `walker.ts` — its generic `NodeMap<N> = Partial<{[K in keyof N]: ...}>` mapped-type utility, used by
   `mapObject`/`mapStatement`, produced confused inference (surfaced as a nonsensical `Element<any>`/JSX
   type error) once `scope` became a key common to every union member. `CallSig<T>` is a single
   interface so the same field addition there was fine; `Statement<T>` is a big discriminated union, and
   `keyof` over a union-with-shared-intersected-field ripples into unrelated generic tooling in ways
   that are hard to predict.
2. Second attempt (reacting to #1): moved the scope into a `WeakMap<TS.Statement, Scope>` held as
   `makeChecker`-instance-local state instead, populated by `checkStmt`. This compiled fine but was
   **functionally broken**: `TStoWasm` creates its own fresh `makeChecker()` instance (separate from
   whatever instance `TStypeCheck` used earlier), so its `stmtScopes` map started empty and `scopeOfStmt`
   silently always returned `undefined`, falling back to the same never-narrows `ctx.scope` it was meant
   to replace. Confirmed via direct instrumentation (`stmtScope === ctx.scope` was `true`) — every prior
   "verification" test had passed for an unrelated reason (the `methodOwner` special-case in
   `var_decl` reads a method's return type structurally off the class decl and never actually needed
   narrowing info in the first place).
3. **User caught the state issue directly ("I don't want any persistent state on checker") and proposed
   the actual fix**: stamp `.scope` directly on each statement node via a plain untyped cast —
   `(stmt as any).scope ??= scope;` in `checkStmt` — exactly like `pos` already works throughout this
   codebase (never a formal `Statement` field, always accessed via `as any`). This sidesteps walker.ts
   entirely (no type-level change to `Statement<T>` at all) *and* has zero checker-instance state, since
   the value lives on the AST node itself and is readable by *any* checker instance, including a later,
   separately-constructed one. `checker.scopeOfStmt(stmt)` now just reads `(stmt as any).scope`.
   **Lesson: when the first "principled-looking" fix (mirror an existing typed-field precedent) breaks
   something unrelated, don't reach for instance-local caching as the fallback — check whether the
   codebase already has an established *untyped* stamping convention for exactly this AST-metadata
   problem (it did: `pos`) before inventing new state.**

**Real, pre-existing, unrelated bug surfaced along the way, NOT fixed**: `m.group(0).length` (where
`m: RegExpMatch`, `RegExpMatch` declared in lib/regexp.ts with `get length()` as a getter and
`group(i): string` as a plain method) throws `towasm: unknown field 'length'` even with zero narrowing
and zero var_decl involved (reproduces as a single inline expression: `return m.group(0).length;`).
Confirmed general method-call→member chaining works fine for ordinary classes (tested both a
string-returning method chained into `.length` and a class-returning method chained into a field, both
OK) — specific to `RegExpMatch`/`group()` somehow, root cause not found. towasm.ts's `emitStmt`
`var_decl` case still reads a method's declared return type directly off the class decl (bypassing
`checker.typeOf` entirely) specifically to route around this, alongside the two other reasons noted
in-code (the checker's now-fixed optional-chain gaps, and the narrowing gap `scopeOfStmt` now
genuinely fixes) — so the special-casing in that function could NOT be fully removed this session; a
`var_decl` full-simplification attempt was tried twice and reverted twice, see
[[tison_towasm_nullable_primitives]] for the two other reasons it was first attempted. Worth a
dedicated investigation later.

Verified via `test/test-towasm.ts` (271/271, full green) plus targeted probes for: `a?.[i]`/`a?.method()`
unannotated-const narrowing-independent cases, `widenedTypes`-ordering, literal-tightness (`const x = 5`
still picks `i32` not `f64`), and the `m.group(0)` regression repro (passes via the restored
`methodOwner` special-case, confirmed NOT a narrowing issue by reproducing it with zero narrowing).
</content>
