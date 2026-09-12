---
name: tison-scope-stamping
description: "How checker scopes reach towasm (statement stamp + branch stamp + synthetic marker), and the measured cost/benefit of the block-node / sparse-stamping idea that was deliberately NOT done"
metadata:
  node_type: memory
  type: project
---

How the checker's flow-narrowing reaches `towasm`, after 2026-09-12 (`017239c`, `eee985a`).

## Three AST marks, all untyped

All are `(node as any).x`, matching `pos` — **never make them formal typed fields**: per
[[feedback-no-checker-state]] a declared field on a discriminated union this large already broke
`keyof`-sensitive generic tooling once. `CallSig.scope?: unknown` is fine only because `CallSig` is a
single interface.

- `(stmt as any).scope` — per-STATEMENT, `checkStmt1`. Suppressed by `Scope.isGenericTemplate()`,
  stripped by `substituteTypeParams`.
- `(expr as any).scope` — per-BRANCH: `&&`/`||`'s right operand, a ternary's consequent/alternate
  (`stampBranch`, checker.ts). towasm's `inNarrowed` prefers it and falls back to re-deriving with
  `narrow()`. Stripped by `substituteTypeParams` AND `substituteEarlierParamRefs`.
- `(stmt as any).synthetic` — `markSynthetic`/`isSynthetic`, for statements BUILT AFTER the check pass.

**`stampBranch` must stay gated on the `narrowing` depth counter.** `narrow()` calls `typeOf` at ~13
sites, and its disjunctive case passes the UNnarrowed scope to `recurse(test.right, ...)` — without the
counter a nested `&&`/ternary inside a test freezes the wrong scope into `??=`'s first win. Do not
substitute `err` for this: `err` is unset for `makeLibScope`'s one real (muted) check of every lib body,
so gating on it costs ~75% of the stamps (measured 98 vs 429 consumption hits over difftest).

## Do NOT "fix" narrowedTypeOf

`narrowedTypeOf` (towasm.ts) looks like a workaround for missing block-level scope. It is not. Its
comment explicitly rejects using `ctx.typeScope` outright: a narrowed scope resolves a clean nominal
`Map<K,V>` into its full structural shape, which `ownerFor` then builds an anonymous struct for instead
of finding the class. `backToDeclaredMembers` maps a refined type back to physical struct members.
Block-level scope inheritance IS "`ctx.typeScope` outright" — it would reintroduce exactly this.

## The block-node / sparse-stamping idea — measured, then declined

Surveyed 2026-09-12 over checker/tocode/walker/transform (probe:
`assistant/scope-stamp-survey.ts`):

- 2406 statements, 99% stamped, but only **1166 distinct scope objects** across **1041 statement lists**
  (mean 1.13/list). No scope is shared between lists, so a scope is essentially a per-list thing.
- Only **8%** of lists have a mid-list scope change (135 points, 132 after an `if`, 3 after a `switch`)
  — `checkBlock`'s guard-clause / assign-merge / exhaustive-switch rebinding. **No node boundary
  exists there**, and splicing the tail into a synthetic block breaks `hoist` (it does not recurse into
  blocks, so declarations after a guard clause stop being hoisted).
- **57.5%** of if/loop body slots (345 of 600) are bare statements, not blocks.

So block nodes would cover 1041 of 1166 scopes and leave 135 + 345 needing something else. Net benefit
is only ~2400 stamps → ~480 (memory/tidiness, **no capability or correctness gain**); cost is three
towasm reader changes plus a new synthetic marker. Declined by the user on that trade. The
`markSynthetic` half was done anyway, since it stands on its own.

## What the synthetic marker actually fixed

`emitStmt`'s `var_decl` case tested `!(s as any).scope` and its comment called that "a SYNTHETIC
statement". Measured over difftest: **only 2 of 58 firings were synthetic** — the rest are generic
method-body templates and `substituteTypeParams`-stripped bodies. The condition was right for all 58;
its stated reason was wrong for 56. It now names both (`isSynthetic(s) || !stamped`).

## Instruments

`assistant/scope-stamp-survey.ts` (scopes per statement list), `assistant/branch-stamp-probe.ts` (branch
stamps landed, by position). Both read-only, run against any file.

**Trap hit this session:** comparing counts between a `/tmp` worktree and the real tree gave a completely
bogus delta (ts-parser GAP 483 vs 942) — see [[feedback-baseline-in-real-tree]]. A/B with an in-place
toggle instead; done that way, the change measured exactly neutral.
