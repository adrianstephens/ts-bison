---
name: feedback-no-json-stringify-ast
description: Never JSON.stringify a tison Type/AST node when debugging — bigints throw. Use T.typeKey / T.exprKey / T.stmtKey from type-utils.ts.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 178556ce-c30e-428b-96cd-0e2a1bbd0a46
  modified: 2026-09-04T20:18:36.462Z
---

Do not `JSON.stringify` a tison `Type` or AST node, in debug prints or anywhere else.

**Why:** these trees can carry embedded `bigint` values, and `JSON.stringify` throws on them —
so a debug line meant to explain a failure becomes a second, unrelated failure. (It also drags
in whole `declScope` chains, which is why the custom-replacer habit grows.)

**How to apply:** type-utils.ts exports all three printers over one shared compact `Output`
(tocode.ts) — `T.typeKey(t)`, `T.exprKey(e)`, `T.stmtKey(s)` (type-utils.ts:32-34, added
2026-09-04). Use those; constructing an `Output` yourself is no longer necessary.

Related: [[tison-debugging-technique]], [[tison-project]].
