---
name: tison-difftest-cross-module
description: "difftest can now express a case with a sibling USER module (addModule/addCross) and filter with --only; this is the only instrument that sees cross-module bugs, which the survey structurally cannot."
metadata: 
  node_type: memory
  type: project
  originSessionId: b3f17fe0-e4c2-48e4-8dae-3996e8d1069c
  modified: 2026-09-05T21:45:56.774Z
---

`assistant/difftest.ts` (run via `assistant/difftest.sh`) gained two things on 2026-09-05:

- **`--only <substr>`** filters by `group/name`, so one group runs in seconds instead of the whole
  suite. The printed totals are of the SELECTED cases, so a filtered run's numbers are not comparable
  with a full one's.
- **`addModule(name, src)` / `addCross(group, name, body, top)`** — a case with a real sibling USER
  module. `addModule` writes a fixture `.ts` into `MODDIR` (under the difftest sandbox); `addCross`
  marks a case to resolve against a `ModuleLoader` rooted there, so it may
  `import ... from './<name>'`. Node builtins still resolve, because `NODE_LIB_DIR` is absolute and
  independent of the loader root.

`reference()` was split into `transpile` + `evalModule`, whose `require` transpiles a RELATIVE
specifier fresh every time. **Never cache it**: the subject re-instantiates its wasm per case, so a
cached module-level `let` would desynchronise the two sides on any case that mutates one.

**Why this matters more than it looks**: [[tison-towasm-self-hosting-plan]] records that the survey
compiles every file AS THE ENTRY and so is structurally blind to cross-module bugs. Before this,
difftest's only cross-module coverage was `import 'path'`/`'fs'`. The 11 `module/scalar` cases it now
carries fail 10-out-of-11 without `d9a8511`, verified by reverting it — which is the standard worth
holding a regression case to: **assert that the case actually fails without the fix**, or it proves
nothing.

Groups added: `module/scalar` (cross-module module-level consts), `arr/refkind` + `arr/union` +
`arr/bisect` (indexing through narrowed receivers), `node/process`, `nullcmp`.
