---
name: tison-module-records
description: "A module is a RECORD (`TS.Module` = body + scope + filename), not a bare `Stmt[]` -- landed 2026-09-09 (`426ea79`, `a065da0`); why the array stamping had to go and what consumed it."
metadata:
  node_type: memory
  type: project
---

`TS.Program` is now **`TS.Module`** (`type: 'module'`), matching `PY.Module`, and a module travels
as that record rather than as a bare `TS.Stmt[]`. The user's design; `TS.parse` was already
returning the record at every load site and every one of them threw it away to keep `.body`.

**What it replaced.** The two things that travel WITH a module had nowhere to live, so they were
stamped onto the body ARRAY as expando properties: `exportScope` set `.scope`, `module-loader` set
`.filename`, and towasm's `moduleScopeOf`/`moduleFilename` read both back. `exportScope` now
RETURNS its `inner` scope (the caller puts it on the record), `bindModuleNames` takes a `filename`,
`collectModules` yields `Map<string, TS.Module>`, and `LoadedModule` holds the record.

**Why it mattered beyond tidiness.** `.scope` on a `Stmt[]` was an expando on a WasmGC ARRAY, and
an array has no fields at all -- no allocation-side or subtype mechanism could ever represent it,
so it was the one expando case [[tison_towasm_capabilities]]'s pre-pass could not reach. Removing
it at the source removed a compiler requirement instead of adding one. `exportScope` and
`bindModuleNames` both moved off their `unknown field` causes as a result.

**`module` cannot be the grammar rule's name.** It is already a TERMINAL (`declare module '...'`),
so naming the nonterminal that gives `'module used as terminal and nonterminal'` and breaks both
parser tests outright. The TYPE takes the name; the rule stays `program`.

**Two process traps this cost:**
- `tsc -p test` was NOT in the per-commit gate list (root, `src/examples` and `lib` were). So
  `test-ts-official.ts` still passing `lib.body` type-checked fine and turned every corpus file
  into `stmts is not iterable` -- 1387 false positives became 8169. Run all FOUR tsconfigs.
- A public shape change needs an `assistant/` sweep too: `check1.ts`, `corpus-errdump.ts` and
  `selfhost-survey.ts` all used `LoadedModule.body` or the `TS.Program` cast.

Related: [[tison_towasm_capabilities]], [[tison_towasm_self_hosting_plan]].
