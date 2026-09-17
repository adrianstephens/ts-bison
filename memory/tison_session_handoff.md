---
name: tison-session-handoff
description: LIVE cold-start state for the self-hosting work — where the row stands, what is deliberately unfixed, what the user has not decided. Read this before the 2233-line plan.
metadata:
  node_type: memory
  type: project
  modified: 2026-09-17
---

**Read this first, and usually instead of [[tison-towasm-self-hosting-plan]]** (2233 lines — open it
only when you need the accumulated history of a specific row). This file is the live state and
nothing else: it is rewritten wholesale, not appended to.

## As of 2026-09-17

**HEAD `64dab09`.** The cross-language split is at the end of Step 2 (see
[[tison-towasm-cross-language-plan]]). `d40a84d` (`presplit`) was the baseline; `ec2a21f` landed Step 1
(the neutral `wasm-types.ts` + the `towasm-analysis.ts` component); then Step 2 landed in two commits:

- **`cd1001f` — checker owns `makeLibScope`, pseudo-type names have one owner.** `checker.ts` exports
  `makeLibScope(libAst)`; `towasm.ts` exports `LIB_AST` and every caller passes it. The plan said "one
  caller"; there were **24** (all the gitignored `assistant/` instruments), so all were updated —
  `assistant/` is untracked, so none of that shows in the commit. `TYPED_ARRAY_TAGS` was deleted in
  favour of `T.WASM_PSEUDO_TYPES`. Also fixed: `assistant/corpus-ab.sh` never built its base worktree,
  so its base run always died on the gitignored `dist/` and the A/B compared nothing.
- **`64dab09` — one generic-call inference policy.** `instantiate`'s map-building core is now the
  exported `inferTypeArgMap` in `checker.ts`; `towasm.ts`'s `inferCallTypeArgs` adapts codegen's own
  `Expr[]` arguments to it. This deleted towasm's duplicate of the checker's inference (and its already
  drifted contextual step), so it is a real behaviour change — deliberate, and every gate was identical.

**Gates at `64dab09`:** build clean · test-towasm 915 · test-checker green · difftest **2182/2191 agree
· 0 disagree** · corpus-ab identical (all buckets +0) · self-host survey **103/324** declarations compile
in isolation, 259 failures from 168 causes, no regressions.

## Next, by value

- **`towasm-asm.ts`** — the one remaining component split the plan keeps. The inline-`__asm` machinery
  is a component the language half uses; it must stay `import type`-only from `towasm.ts` so no runtime
  cycle forms (it is not urgent — do it slowly).
- **Step 3's three generic cores** (independent, any order): `src/examples/layout.ts` (the printer
  skeleton, `Printer<K>` finally implemented), `guard<R>` into `walker.ts`, `buildStateMachine` into
  `src/examples/statemachine.ts`.
- The plan's Step 4 (the real 2-way split) stays on the shelf; §2's `TypeOracle`/IR is the destination,
  only if a second language is still wanted.
- The **`WT` prefix rename** (~459 refs) was explicitly handed to the user — an editor find/replace, not
  agent work.

## Open, waiting on the user — do not assume

- The BigInt row (6 declarations) is a real overload-*resolution* gap in `candidateFits`. Proposed as
  the next self-hosting row; not chosen. The split work above takes precedence until its stages land.

## Deliberately unfixed, each its own row

- `Object.keys/values/entries` counts a struct's OPTIONAL fields that were never assigned —
  `Partial<Record<NumericType, T>>` with one key set answers 4, not 1. Both the static and cascade
  paths build a fixed-length literal from `owner.fields`; a correct answer needs a null test per
  optional field and a dynamically built array.
- The same intrinsics trap (do not answer wrongly) for an array-, string- or boxed-scalar-backed
  receiver, and for a `Map` reached through an `object`/`unknown`-typed value — the latter because
  its real answer is a `K[]`/`V[]` whose element KIND has no conversion to the single `any[]` result.

## Tree state

HEAD `64dab09`. **The user edits and commits concurrently — re-check `git status`; never trust this
line.** At the time of writing the only uncommitted files are the user's own
`memory/tison_vsdg_cpp.md` + `test/test-vsdg-cpp.ts` (the `++`/`--` boundary tests). Treat any other
modified file as theirs.

## Keeping this current

Rewrite the dated section when a fix lands or a session ends — state, not history; history is in the
commits. Keep it under ~60 lines, or it stops being cheaper than the plan. An out-of-date handoff is
worse than none, because a cold session will trust it.

Related: [[feedback-session-boundaries]], [[feedback-two-tier-gates]], [[tison-towasm]].
