---
name: tison-towasm
description: "backend.ts (TS-AST-to-wasm backend, tison/src/examples/TS/) — what it is, where the authoritative gap list lives, and the design invariants worth not rediscovering."
metadata: 
  node_type: memory
  type: project
  originSessionId: e1e31c24-8d38-47f3-aa27-e8c84bc6b664
  modified: 2026-09-04T18:23:12.324Z
---

`src/examples/TS/backend.ts` (~7.8k lines) compiles a static TS subset straight to a
`wasm.WasmModule` (no WAT stage), via [[binary-wasm-module]]. It assumes the AST already passed
`TStypeCheck`/`TStypeCheckAsync`. Every gap throws a clear error rather than silently miscompiling.

**The authoritative gap list is backend.ts's own top-of-file header comment. Read it there, not from
memory.** It is maintained per-fix and is the only copy that stays current. An item listed under a
category is either a whole missing construct or the one unsupported edge of an otherwise-working
one — never a description of what does work.

**Design invariants (each was established the hard way; don't undo them):**

- **Demand-driven, monomorphizing.** Only what is reachable from top-level execution gets compiled.
  A file of exported generics with no driver compiles to an *empty module* — this is why "file X
  compiles" is a near-meaningless metric on its own. See [[tison-towasm-self-hosting-plan]].
- **Lib is real self-hosted source**, in `src/examples/TS/lib/` (`number/bigint/string/array/
  typedarray/regexp/map/console/generator/promise.ts` + `lib.d.ts`), registered in `LIB_AST`. A real
  implementation always beats a same-named ambient `declare` stub (`LIB_DECL_MAP` enforces this).
  Host imports are declared with ordinary TS (`declare module 'x'` + `import`), not hand-registered.
- **One shared wasm-GC rec group** for every struct/array type — wasm-GC canonicalizes structurally
  *across* separate groups, so two singleton groups of identical shape collapse into one runtime type
  that `ref.test` then can't tell apart. Only *imported* func types get singleton groups (verified
  against wasmtime; Node's WASI path is lenient and masks the bug).
- **No name special-casing.** Hardcoding a method or function name is not acceptable in this file;
  find the structural trigger. See [[feedback-no-name-special-casing]].
- **The checker stays stateless.** Prefer untyped AST-node stamping over new checker state
  ([[feedback-no-checker-state]]); `checker.scopeOfStmt` is the sanctioned way to reach real
  narrowing-aware scope from codegen ([[tison-towasm-capabilities]] has the `stmtScope` gate story).

**Toolchain history, one line:** wabt (no GC) → binaryen (~93MB, 200× oversized) → a first-party
reader/writer, `binary-libs/src/wasm.ts`. Don't reintroduce a heavyweight dependency.

**Testing:** `test/test-towasm.ts`, 458 checks as of 2026-09-03, each compiling a snippet and running
it under real wasm. **Known structural blind spot: every check is a self-contained snippet with all
state local — none exercise module-level aggregate state**, which is the shape that dominates real
target code. A green suite says nothing about it.

**History**: this file was a ~150KB dated changelog of every feature added since 2026-07. Closed
feature work is now summarised in [[tison-towasm-capabilities]]; the full original is at
`../memory-archive/tison_towasm.md`.
