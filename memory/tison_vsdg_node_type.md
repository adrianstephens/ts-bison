---
name: tison_vsdg_node_type
description: "vsdg.ts node representation — RawNode & INode, fully discriminated union (no payload mirror)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 29b01f87-14a7-4830-9b81-678c050f31d5
  modified: 2026-09-03T19:32:29.375Z
---

`src/examples/TS/vsdg.ts` node model, latest on tison main (commits 3d39b3f, ce2b641, e767d42,
0ce5a86, eb34f98, 58a66dc, 03ed3f9, bf0a0ad):

- **`class Node` is gone.** `type Node<N extends INode = INode> = RawNode & N`.
  `type NodeOf<T extends NodeType> = Node<Extract<INode, { type: T }>>` — the full variant for a tag.
  `makeNode(inode)` / `MakeNode(id, inode)` return `NodeOf<N['type']>`.
- **`INode`**: fully discriminated union over `type`. Payload (`expr`/`stmt`/`name`) is on the
  variant only — **no mirror on RawNode** (dropped in bf0a0ad), so every payload access needs a
  narrowed node.
- **`RawNode`**: `id`/`inputs`/`outputs`/`outDegree()` + only the genuinely cross-cutting stamps:
  `boundName`, `forcedPrint`, `switchInternal` (gamma + `hit` var/mutation), `scopeAnchorId`,
  `exported`, `classInfo`/`objectMembers` (class_decl + class-expr effect), `programEndId`.
- **Tag-local annotations on their variant**: `loopKind`→mu, `neverMaterialize`→gammaValue,
  `catchParam`→except, `optional`→member, `switchDiscriminantId`/`switchCases`→break_scope,
  `declKind`/`typeAnnotation`/`capturedRead`→var, `returnNodeId`/`destructuredParams`→function.
- **`except` split into `except` (state anchor) + `exceptValue` (per-variable try/catch merge)**
  (c861844) — same shape as the pre-existing `gamma`/`gammaValue` split, applied by analogy. Every
  `.name === undefined`/`!== undefined` disambiguation across `isVestigialEdge`, `reconcileVariables`,
  `emitLocalStatements`, `emitControlNode`, `BlockTree`'s root discovery, and `scheduleLate` collapsed
  into a plain tag check; `exceptValue` needs no fields of its own (boundName carries identity, like
  gammaValue). `exceptValue` was added to `valueConsumers`' `CONTROL` set (mirroring `except` already
  being there) to keep tryVal/catchVal consumer-counting behavior-identical — verified via the 4
  exact-output try/catch tests, not just reasoned about.
- **The effect family is 3 tags** (bf0a0ad): `marker` `{name: MarkerName}` (12-value closed union —
  PROGRAM_START/RETURN_ANCHOR/*_MARKER/*_START); `effect` `{expr: Expr}` (impure
  call/new/yield/await/jsx/tagged_template); `function` `{stmt?, expr?, returnNodeId,
  destructuredParams?}` — ONE tag for a declaration (stmt), a method (neither), or a function/arrow
  EXPRESSION (expr, prints inline). `isEffect()` and `retag()` are **gone**: `node.type === 'effect'`
  is the check; the arrow case sets `.expr` on the plain `function` entry.
  - "is it a function-expression value" = `node.type === 'function' && node.expr` (emitControlNode
    skips it, emitLocalStatements materialises it, buildExpr returns `node.expr` verbatim).
  - `isPureSubgraph`'s param check needs `inputs[0].port >= 1` (a param comes from an entry OUTPUT
    port; `const f = () => {}` reads the function's value port 0).
- No `'literal'` tag — a literal is `'floating'` with `expr.type === 'literal'`. `foldConstants` folds
  by swapping `.expr` (the one remaining in-place `.type` mutation is gone too now).
- **`slotName()` / `isLiteralNode()` / `isVestigialEdge(port)` are `RawNode` METHODS** (ef7e954), not
  free functions — reverted from free functions per the user's explicit preference for `node.foo()`
  call-site ergonomics, even though `RawNode` itself carries no `type`/payload (only the intersected
  INode variant does) so every narrowing method needs an unchecked escape hatch. That hatch is a single
  `protected get self(): Node { return this as unknown as Node; }`, asserted once, used by any method
  that needs to switch on `.type`. `slotName()` is the exception — it only reads `boundName` (a real
  RawNode field), so it needs no cast at all. Confirmed empirically: a single `this as Node` (skipping
  the `unknown` hop) does NOT compile here — TS's `as`-assertion overlap heuristic doesn't fully solve
  assignability when a polymorphic `this` type is involved, so `as unknown as` is required, not just
  cautious. The real type-safe alternative (a genuine class per INode tag) was considered and rejected
  as too big a structural detour from the flat `RawNode & N` design.

**GCM signature changed underneath this** (user's own uncommitted rewrite, landed alongside c861844,
not yet audited by me beyond "tests still pass"): `applyGlobalCodeMotion(graph: VSDG)` now returns
`{ blocks: BlockTree, blockIds }` (was `{ blockIds, blockControl, getLoopDepth }`), and
`BuildProgram(graph: VSDG, blocks?: BlockTree, blockIds?)` (was 4 separate params). `BlockTree` is a
real class (`roots`/`control`/`tree`/`loopDepthMemo`, a `getControl()` method) replacing the old
`buildBlockTree` free function. Re-read the actual class before relying on internals beyond this.

Gate: `assistant/vsdg-check.sh` (tsc on src/examples + `test/test-vsdg.ts`, 25 exact-output tests).
`test-ts-parser.ts` is a coverage harness (GAP/WARNING/ERROR counts), not pass/fail. Run test-vsdg:
`ts-node --transpile-only --compilerOptions '{"module":"commonjs","moduleResolution":"node","ignoreDeprecations":"6.0"}' test/test-vsdg.ts`

See [[tison_codegen]] (stale, different file).
