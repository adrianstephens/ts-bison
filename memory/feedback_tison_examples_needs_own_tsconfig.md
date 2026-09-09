---
name: feedback-tison-examples-needs-own-tsconfig
description: "verifying tison/src/examples/TS/*.ts (towasm.ts, checker.ts, etc) requires running tsc from src/examples/, not the tison package root -- the root tsconfig doesn't check that directory at all"
metadata: 
  node_type: memory
  type: project
  originSessionId: dd9b34bb-3a6a-434d-b03c-a908764c046d
  modified: 2026-08-24T20:31:43.189Z
---

`tison/tsconfig.json`'s `include` is `["src/*.ts"]` -- top-level files only. It does NOT include
`src/examples/**`, even though `src/examples/tsconfig.json` exists as a separate (TS project
references) config extending the root one. Running `npx tsc --noEmit -p .` from the tison package
root therefore silently checks *nothing* under `src/examples/TS/` (towasm.ts, checker.ts,
type-utils.ts, walker.ts, transform.ts, ts-parser.ts, js-parser.ts, ...) -- it reports "clean" even
when that directory has real type errors.

**Why this matters**: caught live during [[tison_towasm_self_hosting_plan]] work -- ran
`cd tison && npx tsc --noEmit -p .` repeatedly through a whole session believing it verified
towasm.ts edits, including a real `Property 'ref' does not exist on type '{...} | {...}'` error
(a `WasmType` union-narrowing bug in a `ref.eq` fix) that the root-config run reported as clean.
Only surfaced because VSCode's own language server (which uses the *actual* nearest tsconfig,
`src/examples/tsconfig.json`) flagged it, and the user reported it. eslint and the runtime test
suite were the only real signal from tooling that whole session for anything under `src/examples/`.

**How to apply**: to actually type-check anything under `tison/src/examples/TS/`, run
`cd tison/src/examples && npx tsc --noEmit -p .` (or `-p src/examples` from the tison root) --
never `-p .` from the tison package root. Note `src/examples/tsconfig.json` also excludes
`TS/lib/**/*.ts` on purpose (those files are deliberately non-standalone-valid TS, parsed by
towasm.ts's own parser rather than tsc -- not a gap, working as intended). `test/tsconfig.json`
(run from `tison/test/`) is a third, separately-correct scope covering the test files themselves
plus `../src/**` and `../examples/**` -- also fine to use, also NOT the same as root `-p .`.

**Recurred, 2026-08-24, same session already using this exact memory**: ran `npx tsc --noEmit -p .`
from the tison root repeatedly across a whole session (both directly and via prompts written for two
separate spawned sub-agents, neither prompt specified the correct path) believing it verified
`checker.ts`/`towasm.ts`/`module-loader.ts`/`tsw.ts` edits -- including a real, committed
excess-property error in `towasm.ts` (`ensureObjectShape`'s local `fields` array missing `optional`)
that the root-scoped run reported as clean. Only caught because the user directly flagged it from
their own IDE. **The memory existing was not sufficient** -- it needs to be *applied* at the moment of
writing any tsc verification step or sub-agent prompt, not just known about. When writing a
verification instruction (for yourself or a spawned agent) for anything under `tison/src/examples/`,
the full command — `cd tison/src/examples && npx tsc --noEmit -p .` — must be spelled out explicitly,
never abbreviated to "run tsc" or "npx tsc --noEmit -p ." with an implied/root directory.
