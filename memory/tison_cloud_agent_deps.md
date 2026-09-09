---
name: tison-cloud-agent-deps
description: tison/package.json deliberately has no devDependencies (relies on parent monorepo hoisting) — cloud/CI runs against the standalone ts-bison repo need an explicit devtools install step first
metadata: 
  node_type: memory
  type: project
  originSessionId: c2e69915-5131-4028-bab6-a72ffab7a920
  modified: 2026-07-31T18:36:13.099Z
---

`tison/package.json` has no `devDependencies` (no `typescript`, `ts-node`, `eslint`, `typescript-eslint`,
`@types/node`) — this is **deliberate**, per the user: tison relies on these being hoisted from the
parent `/Volumes/DevSSD/dev/packages` monorepo's `node_modules` during local dev. Its only real dependency
is `@isopodlabs/binary_libs` (published on npm, `^1.10.0`), resolved locally via an `npm link`-style
symlink to the sibling `../binary-libs` checkout but also installable from the registry standalone.

tison's own git remote is `https://github.com/adrianstephens/ts-bison` — it is **not** a tracked submodule
of the parent `packages` repo (not in `.gitmodules`, not in `git ls-files --stage`), just a sibling
directory that happens to be its own repo.

**Why this matters**: a cloud agent (via `RemoteTrigger`/scheduled routines) that clones the standalone
`ts-bison` repo gets none of the parent's hoisted devDependencies. `npm install` there only pulls
`binary_libs`; `ts-node`, `tsc`, `eslint` are then simply missing (`ts-node <file>` fails outright — no
PATH entry; `npx tsc`/`npx eslint` would try registry auto-install every invocation). A real scheduled run
on 2026-07-31 (trig_01PFcDYeH6oYqpNCFMFMnZy3, [[tison_towasm]] Array<T>/lib-source/BigInt task) burned ~5%
of weekly quota and produced zero commits/PR/branch — almost certainly this exact failure, discovered only
after the fact since the routine UI showed "Completed" with no visible transcript (`persist_session: false`
in the trigger config may also suppress transcript retention).

**How to apply**: never touch `tison/package.json` to "fix" this (user confirmed it's intentional). Instead,
any cloud-agent/CI prompt targeting the standalone `ts-bison` clone must include an explicit first step:
`npm install --no-save typescript@^5.7.3 ts-node@^10.9.2 eslint@^9.21.0 typescript-eslint@^8.26.0 @types/node@^22.13.8`
(versions match what's actually hoisted/used locally) before running any `tsc`/`ts-node`/`eslint` command.
