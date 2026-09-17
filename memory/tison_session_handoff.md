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

**HEAD `8a3da35` — "the asm island is neutral, and its seam is a concrete signature".** Steps 1–2 of the
cross-language split are landed (see [[tison-towasm-cross-language-plan]]), and the inline-`__asm` island is
now `src/examples/wasm-asm.ts` (neutral) plus an `Inline __asm` section in `TS/towasm.ts`. The two commits
that first held this work (`82a292f`, `1435768`) were REWRITTEN AWAY, so hashes in older notes point at
nothing; §5 of the plan records the design.

**The seam rule this settled — reuse it for Steps 4/5.** Neutral code manipulates representations only, and
the language hands over a CONCRETE base interface (`AsmDecl extends WT.ClosureSig`, one method); never a
parameter over the language's type. A first cut used `AsmTypes<TA>` plus a six-member adapter — the idiom
§3 rules out ("a base interface plus a language subtype, never a type parameter") — and was *larger*
(280 code lines against 272). **If sharing something needs a type parameter, the logic is on the wrong side:
leave the few lines of policy with the language and share the representation work.** Corollary from the
user: don't spend code forcing neutrality; if it isn't simple and clean it isn't useful.

**Gates at `8a3da35`:** build clean · test-towasm all green · test-checker green · difftest **2182/2191
agree · 0 disagree · 9 unsupported** — identical to baseline, so no codegen bytes moved. Self-host survey
**125/355** declarations compile in isolation, 84 more need a driver, **270 failures from 177 causes**, with
`wasm-types.ts`/`wasm-asm.ts`/`towasm-analysis.ts` now IN TARGETS (they were invisible to the work queue, so
a declaration moved out of a surveyed file used to read as progress when it was a scope change).

**Instrument fix (`assistant/selfhost-survey.ts`, untracked):** the aggregate read EVERY per-file report on
disk, so a file dropped from TARGETS kept rendering a PHANTOM row — the deleted `TS/towasm-asm.ts` was still
counted, its 2 failures included. Reports are kept across runs on purpose (`knownHeavy` reads one to skip a
doomed full attempt), so the fix prunes non-target reports on a whole-TARGETS run rather than clearing the
directory. The corrected run's "Since the previous run" now names the 4 declarations that went with the file.

## Next, by value

- **The general pseudo-type mapper.** `asmDeclaredType` (~20 lines) exists only because `builtinTypes` holds
  i32/i64/f32/f64/u32 and `T.resolve` deliberately leaves the pseudo-type names unresolved, so
  `typeOf(RefType('i8'))` is `undefined` while an asm signature declaring `i8` means `i32`. Teaching
  `typeOf`/`wasmTypeOf` those spellings deletes it — a GENERAL codegen change, difftest-gated. Offered.
- **`TS/towasm-analysis.ts` (261 lines, 11/12 compile).** Per-language AST queries with one consumer. The
  user's stated expectation is a SINGLE TS module for all TypeScript-specific compilation, which folds it
  into `towasm.ts`; asked, not decided.
- **Step 3's three generic cores** (independent, any order): `src/examples/layout.ts` (the printer skeleton,
  `Printer<K>` finally implemented), `guard<R>` into `walker.ts`, `buildStateMachine` into
  `src/examples/statemachine.ts`.
- **Step 4 → Step 5** are the route to the user's goal (towasm's core in the examples root, TS wrappers):
  neutralise the SHAPES first (`FuncCtx`, `ClassInfo`, `FuncSig` base + language subtype), then the
  `Emitter`/`TSEmitter` split. Apply the seam rule above: the base emits, the language subclass lowers types.
  The plan's numbering was fixed 2026-09-17 (it had two Step 3s and two Step 4s).

## Open, waiting on the user — do not assume

- The **BigInt row** (6 declarations) is a real overload-*resolution* gap in `candidateFits`; still unchosen.
- Whether to do the general pseudo-type mapper, and whether to fold `towasm-analysis.ts` (both above).
- The **`WT` prefix rename** (~459 refs) was explicitly handed to the user — an editor find/replace.

## Deliberately unfixed, each its own row

- `Object.keys/values/entries` counts a struct's OPTIONAL fields that were never assigned —
  `Partial<Record<NumericType, T>>` with one key set answers 4, not 1. Both the static and cascade
  paths build a fixed-length literal from `owner.fields`; a correct answer needs a null test per
  optional field and a dynamically built array.
- The same intrinsics trap (do not answer wrongly) for an array-, string- or boxed-scalar-backed
  receiver, and for a `Map` reached through an `object`/`unknown`-typed value.

## Tree state

HEAD `8a3da35`. **The user edits and commits concurrently — re-check `git status`; never trust this
line.** At the time of writing the only uncommitted files are the user's own
`memory/tison_vsdg_cpp.md` + `test/test-vsdg-cpp.ts` (the `++`/`--` boundary tests) — which is also why the
survey header says "2 uncommitted files; numbers describe a tree mid-edit": neither file is surveyed, so the
numbers are the committed tree's.

## Keeping this current

Rewrite the dated section when a fix lands or a session ends — state, not history; history is in the
commits. Keep it under ~60 lines, or it stops being cheaper than the plan. An out-of-date handoff is
worse than none, because a cold session will trust it.

Related: [[feedback-session-boundaries]], [[feedback-two-tier-gates]], [[tison-towasm]].
