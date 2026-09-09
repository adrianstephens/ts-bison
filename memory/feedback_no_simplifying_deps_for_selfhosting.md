---
name: feedback-no-simplifying-deps-for-selfhosting
description: "don't rewrite a dependency's real source to dodge a compiler gap when self-hosting -- treat a hard construct as needing a real compiler feature"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dd9b34bb-3a6a-434d-b03c-a908764c046d
  modified: 2026-08-19T23:40:43.363Z
---

When a construct in code being self-hosted (or otherwise fed through towasm.ts as a stress test)
is hard to compile because it's genuine metaprogramming or an otherwise-advanced pattern, the fix
is a real new compiler feature -- not rewriting that source to a simpler shape the compiler already
handles. This applies to the *target's own* source (towasm.ts itself) and equally to any
dependency pulled into scope (e.g. `binary-libs/src/wasm.ts`'s `bin.Class(spec)` factory pattern
and its `TableBuilder`/`TreeBuilder` metaprogramming).

**Why**: rejected explicitly during planning for [[tison_towasm_self_hosting_plan]] — an early
draft proposed flattening wasm.ts's table-construction metaprogramming into precomputed static data
to avoid the gap. The user's point: the whole reason to attempt self-hosting is to drive the
compiler to real capability; quietly rewriting a dependency's source to fit current limits defeats
that just as much as simplifying the target's own source would, and produces a self-hosting claim
that isn't actually true of the real code.

**How to apply**: before proposing to change *any* file being compiled (target or dependency) to
avoid a gap, ask "is this a real feature the compiler should have?" first. If the construct is
compile-time-resolvable (e.g. a factory called with compile-time-constant arguments), the answer is
often a compile-time-evaluation feature rather than a runtime one — see the "comptime" plan in
[[tison_towasm_self_hosting_plan]] for a concrete instance of this reasoning.
