---
name: tison-towasm-switch-break-continue
description: "towasm.ts (TS-to-wasm) gained real switch-statement support; break/continue rewritten from hardcoded br(1)/br(0) to a real depth-tracking stack, fixing a genuine infinite-loop bug in for/for-of's continue semantics"
metadata: 
  node_type: memory
  type: project
  originSessionId: 888c0914-2616-44d9-97e8-90264c57a251
  modified: 2026-08-08T22:14:07.374Z
---

2026-08-08: added `switch` support to `examples/TS/towasm.ts`'s `emitStmt` (previously entirely unsupported —
`lib/number.ts`'s `getUnsigned` has a `let stop = false` workaround comment noting `break` "isn't supported").

**Root design**: `switch` lowers to `n` nested wasm `block`s (n = case count, case 0 innermost), all wrapped
in one outer `block` (the `break` target). Discriminant is materialized once via a synthetic `const` (reusing
the existing `var_decl` case, same "desugar + recurse into `emitStmt`" convention `for`/`for...of` already
use). Dispatch (a flat sequence of `discriminant === test` comparisons + `br_if`) sits entirely inside the
innermost block; a match branches straight to that case's own block, landing exactly at its statements. No
`break` = falls off that block's end, which is nested *inside* the next case's block = real fallthrough,
independent of where `default` sits in source order (only the "nothing matched" branch target depends on
`default`'s position/existence).

**The real find**: implementing `switch` (and being asked to verify `break`/`continue` while in there) exposed
that `break`/`continue` were hardcoded to `I.br(1)`/`I.br(0)` — correct *only* when used directly at the top
level of a loop body, since real wasm `if`/`block`/`loop` each push their own implicit label. Any `break`/
`continue` inside an `if` nested in a loop was silently wrong (never caught: no test/lib code combined the
two before). Fixed by giving `FuncCtx` a real `depth` counter plus `breakTargets`/`continueTargets` stacks
(pushed at the `depth` value of each construct's own label; `break`/`continue` compute `depth - target` for
the correct relative index). `switch` pushes only `breakTargets` (`continue` inside a `switch` still targets
the nearest *enclosing loop*, not the switch — real JS semantics, verified with a `continue` inside a
`switch` inside a `for`).

**Second real bug, found via the first fix**: `for` (C-style) and `for...of` both desugared into a synthetic
`while` with the loop's own update/increment step appended to the *end* of the body. Once `continue` started
computing real relative depths (instead of the old blanket `br(0)`), a `continue` inside such a loop's body
correctly targeted the `while`'s own restart label — which, for a *plain* `while`, is correct, but for a
desugared `for`, that label wraps update *and* body together, so branching to it from mid-body skips the
update entirely. Since nothing before ever exercised `continue` in a `for`/`for...of` loop, this was a latent,
genuine infinite loop (found by writing `for (i=0;i<6;i++) { switch(i%2){case 0: continue;} sum+=i; }` as a
switch-verification probe — hung at runtime, not compile time).

**Fix**: `for` (`kind: 'normal'`) is no longer desugared through a synthetic `while` — it's now a native
`emitStmt` case with the body wrapped in its *own* inner block, pushed as the real `continueTargets` entry
(distinct from the outer `loop`'s own restart label). `continue` now lands right before `update`, which then
runs before the next test — matching real JS. `for...of` was simplified to desugar into a synthetic `for`
(`kind: 'normal'`, with an explicit `update` field) instead of directly into `while` + manually-appended
increment — same fix applies for free, and removes its own hand-rolled increment-append.

**Verification**: `tsc` clean; full suite still 161/161 (same count as before, zero regressions); a dedicated
probe covering fallthrough (multiple case labels sharing one body, `default` in the middle, `default` with no
match), `break` inside an `if` inside a `switch` inside a `while`, and `continue` inside a `switch` inside a
`for` all passed and were deleted per convention. The corpus now compiles further than before (reaches
`Math.cos`'s `cos_core`, previously unreachable since its caller's `switch` dispatch made it uncompilable) and
hits a **separate, pre-existing, unrelated** bug there: `cos_core` has no explicit return-type annotation,
and its inferred return type interacts badly with a leading integral float literal (`1.0 + ...`) — the `+`
compiles through `i32` (truncating the float operand) instead of `f64`. Confirmed unrelated to switch/
break/continue via an isolated repro with no switch at all. Left open, flagged for a future session — not
fixed here (session was at ~97% quota when found).
