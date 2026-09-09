---
name: feedback-no-checker-state
description: "keep checker.ts's makeChecker() instance stateless (transient state only); don't add persistent per-instance caches even to solve a real cross-consumer data-sharing problem"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 40e5e473-1802-45b7-97bc-65a00de50147
  modified: 2026-08-16T01:15:54.415Z
---

Don't add persistent, accumulating state to `checker.ts`'s `makeChecker()` closure (tison project) —
e.g. a cache that grows as the checker walks the AST and is meant to be queried later. `muted`/
`yieldCollector`-style transient state (reset to baseline after each operation, via `runMuted`'s
try/finally) is fine; a `WeakMap` that persists and grows for the checker instance's whole lifetime is
not, even when it looks locally justified.

**Why**: user's own words, "I don't want any persistent state on checker... [I'd like this] for
consistency with everywhere else" — flagged directly when I added a `WeakMap<Statement, Scope>` inside
`makeChecker` to solve a real problem (towasm.ts needing narrowing-aware per-statement scope info the
checker computes but doesn't expose). The instance-state approach was ALSO functionally broken in a way
I hadn't caught: consumers other than the one call that ran the check (e.g. `TStoWasm`, which creates
its own fresh `makeChecker()` instance) see an empty cache and get no benefit, silently falling back to
worse behavior with no error. See [[tison_checker_scopeofstmt]] for the full incident.

**How to apply**: when the fix requires exposing checker-computed per-node info to a later consumer,
first check whether the codebase already has an established convention for stamping metadata directly
onto the AST node itself — untyped (`(node as any).foo`, matching `pos`'s existing pattern throughout
this codebase), not necessarily a formal typed field on the node's type (a formal field can be fine for
a single-interface node type like `CallSig`, but breaks large discriminated unions like `Statement<T>`
via `keyof`-sensitive generic tooling — see the same incident). Reach for per-instance caching only as
a last resort, and even then, flag the persistence explicitly rather than assuming it's fine.
</content>
