---
name: tison-session-handoff
description: LIVE cold-start state for the self-hosting work — where the row stands, what is deliberately unfixed, what the user has not decided. Read this before the 2233-line plan.
metadata:
  node_type: memory
  type: project
  modified: 2026-09-16
---

**Read this first, and usually instead of [[tison-towasm-self-hosting-plan]]** (2233 lines — open it
only when you need the accumulated history of a specific row). This file is the live state and
nothing else: it is rewritten wholesale, not appended to.

## As of 2026-09-16

**HEAD `d40a84d` (`presplit`)** — the commit the towasm split starts from. Last real towasm fix was
`08e1c0e` (a dynamic field read on a missing field returns `undefined`, not a trap); before it `7d8a74c`
had broken `tsc -b src/examples`, so `dist/` was stale for many commits. The `Object.keys` row (35
declarations) is closed.

**The survey is STALE — re-run it first.** The cause table predates those three fixes. The last
table (102/344 compiled) was headed by: Object.keys 35 (now closed), object literal needing a known
target 23 (ts-parser/type-utils), `cannot convert ref:Array<any> to ref:{...}` 11 (js-parser),
`Array.from` missing 10, `no overload of 'BigInt's constructor' matches this call` 6.

**Gate status at that point:** towasm 915 checks green, checker green, difftest 2182/2191 agree ·
0 disagree · 9 unsupported. Corpus A/B not run — the changes were towasm-only, which does not
require it.

## Current thread: the towasm split — Step 1 LANDED, uncommitted

Separating the TS-specific code out of `towasm.ts` (axis: **TS-specificity**). **Plan, the measured cut,
the blocker and all four closed decisions: [[tison-towasm-cross-language-plan]]; working tables:
`assistant/towasm-split-inventory.md`.** That plan records the verified gate baseline at `d40a84d`.

Landed 2026-09-16, gates green (build clean · test-towasm 915 · difftest 2182/2191 · 0 disagree, identical
to baseline): **`src/examples/wasm-types.ts`** (165 lines, language-NEUTRAL) holds the physical type
vocabulary (`Type`/`ClosureSig`/`ARR_WTYPE`/`REF_*`/the helpers); **`TS/towasm-analysis.ts`** (260 lines)
holds the 12 name/free-variable AST queries. `TS/towasm.ts` 12,411 → **12,063**. `TS/towasm-types.ts` was
created and folded back the same day — see the file-splitting rule in the plan (¾6): don't split without a
reason, so TS types + TS codegen stay together. `WasmType`/`FuncSig` were split so the closure payload
carries no TS types (identity-keyed `closureBindings` + `closureWtype`/`closureSigOf`) — that is what
unblocked neutrality. Next, by value: the relocation into `checker.ts` (which is imported by NAME, so no
call-site churn) including `inferTypeArgMap`, whose move deletes a re-implementation of the checker's own
inference policy; then `towasm-asm.ts` as the one remaining component split; then the ~326 lines toward
`type-utils` (namespace-imported as `T`, so that one DOES cost call-site qualification).

## Open, waiting on the user — do not assume

- The BigInt row (6 declarations) is a real overload-*resolution* gap in `candidateFits`. Proposed
  as the next row; not chosen.
- The split work above takes precedence until its four stages land — do not start a self-hosting row
  without checking which stage the tree is at.

## Deliberately unfixed, each its own row

- `Object.keys/values/entries` counts a struct's OPTIONAL fields that were never assigned —
  `Partial<Record<NumericType, T>>` with one key set answers 4, not 1. Both the static and cascade
  paths build a fixed-length literal from `owner.fields`; a correct answer needs a null test per
  optional field and a dynamically built array.
- The same intrinsics trap (do not answer wrongly) for an array-, string- or boxed-scalar-backed
  receiver, and for a `Map` reached through an `object`/`unknown`-typed value — the latter because
  its real answer is a `K[]`/`V[]` whose element KIND has no conversion to the single `any[]` result.

## Tree state

HEAD `d40a84d`. **The user edits and commits concurrently — re-check `git status`; never trust this line.**
At the time of writing the only uncommitted files were the assistant's two `memory/` edits plus the user's
`memory/tison_vsdg_cpp.md` + `test/test-vsdg-cpp.ts`. Treat any other modified file as theirs.
`memory/MEMORY.md` carries uncommitted index lines for still-untracked memory files — leave them; stage only
your own hunk.

## Keeping this current

Rewrite the dated section when a fix lands or a session ends — state, not history; history is in the
commits. Keep it under ~60 lines, or it stops being cheaper than the plan. An out-of-date handoff is
worse than none, because a cold session will trust it.

Related: [[feedback-session-boundaries]], [[feedback-two-tier-gates]], [[tison-towasm]].
