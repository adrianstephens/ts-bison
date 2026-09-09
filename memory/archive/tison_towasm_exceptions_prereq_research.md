---
name: tison_towasm_exceptions_prereq_research
description: "CLOSED 2026-08-18: prerequisite #2 (binary-libs wasm.ts exception-handling support) is now done -- see update at file end. Original research below (checker.ts readiness, and the wasm.ts gap as it stood 2026-08-18 before the fix) kept for context."
metadata: 
  node_type: memory
  type: project
  originSessionId: 40e5e473-1802-45b7-97bc-65a00de50147
  modified: 2026-08-18T23:35:21.593Z
---

**SUPERSEDED 2026-08-18 (later same day) by [[tison_towasm_exceptions_design]]** -- this memory's own
"target legacy EH" recommendation (bottom of file) did not hold: another agent independently targeted the
newer exnref/`try_table` proposal instead, the user chose to keep that, and it was verified to work fine
(with a one-line `v8.setFlagsFromString` fix for the flag gate). Read [[tison_towasm_exceptions_design]]
first for the current plan/facts; the two-prerequisite-question research below is still valid background.

Research done 2026-08-18, at the user's explicit request, specifically to hand off to a future/new session
before starting real design/implementation work on exception handling in [[tison_towasm]] (towasm.ts) --
the single biggest remaining item in that file's own top-of-file gap comment. Two prerequisite questions,
both now answered with direct evidence, not guessed.

## 1. Does checker.ts already handle try/catch/throw/finally? YES, already fairly complete.

Confirmed via direct reading:
- The parser (`js-parser.ts`) already has full grammar support: `{type:'try', block, handlerParam?,
  handlerBody?, finalizer?}` and `{type:'throw', argument}` AST nodes, `catch`/`catch(e)`/`finally`, all
  real rules (js-parser.ts:900-943).
- `checker.ts`'s main statement-checking switch (`checkStmt`, ~line 1876-1892) already has real
  `case 'throw':`/`case 'try':` handling: `throw` type-checks its argument; `try` checks `block` in its
  own child scope, `handlerBody` (catch) in its own child scope with the catch param typed `T.ANY`
  (matching real TS's untyped-catch-clause default), `finalizer` in its own scope. No typed-catch
  modeling attempted -- correct, since vanilla JS/TS doesn't have typed catch clauses either.
- Two existing control-flow helpers already model throw/try correctly for their own purposes:
  `alwaysThrows` (checker.ts:19-29, powers "does this body always throw" -> `never` return-type
  inference) and `alwaysExits` (checker.ts:79-93, powers guard-clause narrowing) both already have real
  `case 'throw':`/`case 'try':` branches.

**Conclusion: no checker prerequisite work is needed.** The front-end (parse + type-check) side is already
essentially ready for towasm.ts to consume real `try`/`catch`/`throw`/`finally` AST nodes with correctly
inferred types throughout.

## 2. Does binary-libs/src/wasm.ts support the wasm exception-handling proposal? NO -- a real, necessary prerequisite.

Confirmed via direct reading of `binary-libs/src/wasm.ts`, not assumed:
- The file's own top-of-file comment states outright: "Not covered (throws rather than misparses):
  exception-handling (tag section, try/catch instructions)."
- No tag-section reader/writer exists at all -- the module's own section-id switch (`WasmSpec`, ~line
  726-747) handles ids 0-12 (custom/types/imports/functionTypes/tables/memories/globals/exports/start/
  elements/code/datas/dataCount) with a `default: {unknown: bin.RemainingBuffer()}` fallback for anything
  else -- section id 13 (the real wasm tag section) would just read as an opaque unparsed blob, and
  there's no `WasmModule.tags` field or builder to *write* one at all.
- No `try`/`catch`/`throw`/`throw_ref`/`catch_all`/`delegate` instruction opcodes exist anywhere in the
  instruction-decode tables (confirmed via a full grep across every opcode switch in the file).
- `EXPORT_KIND` (~line 616) is `['func', 'table', 'memory', 'global']` -- no `'tag'` entry, so a tag
  can't even be exported. There IS a stray, likely-incidental `kind: 'tag'` case in the *import*
  descriptor switch (`ImportDesc`, line 591, `{attribute: UINT8, typeIndex: U32}` -- structurally correct
  per spec) but it's orphaned: with no tag section, no instructions to use an imported tag, and no export
  counterpart, it doesn't add up to real support on its own.

**Conclusion: this is a genuine, necessary prerequisite.** Before towasm.ts can emit any real
try/catch/throw code, `binary-libs/src/wasm.ts` needs: a tag section reader/writer, `try`/`catch`/
`catch_all`/`delegate`/`throw`/`throw_ref` instruction support, and an export-kind entry for `'tag'`. This
is real, separate work in a *different package* (binary-libs, not tison) -- same relationship
`flattenStateMachine` (transform.ts) had to async/generators: a building block that had to exist before
the compiler feature could use it, except this one crosses a package boundary.

## What a real design pass would still need to work out (named during discussion, not yet researched/decided)

- A single universal exception "tag" (JS's `catch(e)` is untyped/catches everything, unlike wasm's own
  tag-typed catches) -- likely one project-wide tag carrying an `anyref` payload, `throw` boxes whatever
  value into that regardless of its real TS type.
- What a thrown value's real GC shape is (a real `Error`-like class? a bare boxed `any`?).
- `finally`'s "run on every exit path" semantics (normal completion, thrown exception, and `break`/
  `continue`/`return` from inside the try) -- usually the fiddliest part of implementing exceptions in any
  compiler.
- How a `try` spanning a generator/async suspend point interacts with the resumable-function state
  machine ([[tison_towasm]]'s `flattenStateMachine`/`compileGeneratorFunc`/`compileAsyncFunc`) -- the
  exception-handling state would need to survive suspension, similar in spirit to how ordinary hoisted
  locals already do, but genuinely new territory, not looked at at all yet.

## Recommended next step

A fresh session, using Plan mode, to (1) decide whether to tackle the binary-libs prerequisite first as
its own piece of work or defer/stub it, and (2) design the four open items above -- mirroring exactly how
[[tison_towasm]]'s async/generator work started: a written plan with explicit checkpoints, each verified
by real execution before moving to the next.

## Update 2026-08-18: prerequisite #2 done

`binary-libs/src/wasm.ts` now has full exception-handling support (tag section id 13, `throw`/`throw_ref`/
`try_table`+`catch`/`catch_ref`/`catch_all`/`catch_all_ref`, `tag` import/export kind), targeting the
current exnref/`try_table` proposal. Verified against real `wasmtime` (not just self-round-trip): a
hand-built module using a tag, `throw`, and `try_table`/`catch`+`catch_all` compiled and executed
correctly, delivering the tag payload through `catch`. Full details in [[binary_wasm_module]].

**Prerequisite #1 (checker.ts) was already confirmed ready in the original research above.** Both
prerequisites are now clear -- the four open *design* items listed above (universal tag/payload shape,
thrown-value GC representation, `finally`'s multi-exit-path semantics, try/generator-suspend interaction)
are still fully open and still the real next step before touching towasm.ts itself.
