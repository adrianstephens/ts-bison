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

**Last three commits** — `7d8a74c` `moduleScopeOf` accepts a class with no home module (this had
broken `tsc -b src/examples`, so `dist/` had been stale for many commits); `e25282c`
`Object.keys/values/entries` resolve the receiver's runtime type via a new `ensureAnyEntries`
`ref.test` cascade; `08e1c0e` a dynamic field read on an object lacking the field returns
`undefined` instead of trapping. The `Object.keys` row (35 declarations) is closed.

**The survey is STALE — re-run it first.** The cause table predates those three fixes. The last
table (102/344 compiled) was headed by: Object.keys 35 (now closed), object literal needing a known
target 23 (ts-parser/type-utils), `cannot convert ref:Array<any> to ref:{...}` 11 (js-parser),
`Array.from` missing 10, `no overload of 'BigInt's constructor' matches this call` 6.

**Gate status at that point:** towasm 915 checks green, checker green, difftest 2182/2191 agree ·
0 disagree · 9 unsupported. Corpus A/B not run — the changes were towasm-only, which does not
require it.

## Open, waiting on the user — do not assume

- The BigInt row (6 declarations) is a real overload-*resolution* gap in `candidateFits`. Proposed
  as the next row; not chosen.
- Splitting `towasm.ts` (12,410 lines) into modules. Raised as a token-cost measure; the user is
  considering it. It would change what the survey measures, since towasm.ts is itself a target.

## Deliberately unfixed, each its own row

- `Object.keys/values/entries` counts a struct's OPTIONAL fields that were never assigned —
  `Partial<Record<NumericType, T>>` with one key set answers 4, not 1. Both the static and cascade
  paths build a fixed-length literal from `owner.fields`; a correct answer needs a null test per
  optional field and a dynamically built array.
- The same intrinsics trap (do not answer wrongly) for an array-, string- or boxed-scalar-backed
  receiver, and for a `Map` reached through an `object`/`unknown`-typed value — the latter because
  its real answer is a `K[]`/`V[]` whose element KIND has no conversion to the single `any[]` result.

## Tree state

The user edits and commits concurrently. Uncommitted and NOT yours: `src/tableCache.ts` (they
rewrote it to drop JSON/zlib/crypto), printer.ts, vsdg.ts, lib.d.ts, the CPP/PY parsers, and several
`memory/` files. `memory/MEMORY.md` carries uncommitted index lines for memory files that are still
untracked — leave them; stage only your own hunk.

## Keeping this current

Rewrite the dated section when a fix lands or a session ends — state, not history; history is in the
commits. Keep it under ~60 lines, or it stops being cheaper than the plan. An out-of-date handoff is
worse than none, because a cold session will trust it.

Related: [[feedback-session-boundaries]], [[feedback-two-tier-gates]], [[tison-towasm]].
