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

> **2026-09-14 — the file MOVED and is now generic.** The model below still holds, but it lives in
> `src/examples/vsdg.ts` (the language-neutral core; `INode<E, S, T>`, `RawNode<E, S, T>`)
> with the TS-specific half in `src/examples/TS/vsdg.ts`. `INode` gained `except.handlerTypeNodeId`
> and `RawNode` gained shape stamps (`plainAssign`, `freshTarget`, `suppressed`). Gate is now
> `assistant/vsdg-check.sh` (test-vsdg + test-vsdg-py + test-vsdg-cpp). Read
> [[tison-vsdg-dialects]] first; everything below is the node-model detail it assumes.

- **`class Node` is gone.** `type Node<N extends INode = INode> = RawNode & N`.
  `type NodeOf<T extends NodeType> = Node<Extract<INode, { type: T }>>` — the full variant for a tag.
  `makeNode(inode)` / `MakeNode(id, inode)` return `NodeOf<N['type']>`.
- **`INode`**: fully discriminated union over `type`. Payload (`expr`/`stmt`/`name`) is on the
  variant only — **no mirror on RawNode** (dropped in bf0a0ad), so every payload access needs a
  narrowed node.
- **`RawNode`**: `id`/`inputs`/`outputs`/`outDegree()` + only the genuinely cross-cutting stamps:
  `bound` (this node IS the current binding of its own variant's `name`; cleared when superseded),
  `forcedPrint`, `switchInternal` (gamma + `hit` var/mutation), `scopeAnchorId`, `exported`,
  `classInfo` (class_decl + class-expr effect), `plainAssign`/`freshTarget`/`suppressed`.
- **Tag-local annotations on their variant**: `loopKind`→mu, `neverMaterialize`→gammaValue,
  `catchParam`→except, `optional`→member, `switchDiscriminantId`/`switchCases`→break_scope,
  `declKind`/`typeAnnotation`/`capturedRead`→var, `returnNodeId`/`destructuredParams`→function.
- **`except` split into `except` (state anchor) + `exceptValue` (per-variable try/catch merge)**
  (c861844) — same shape as the pre-existing `gamma`/`gammaValue` split, applied by analogy. Every
  `.name === undefined`/`!== undefined` disambiguation across `isVestigialEdge`, `reconcileVariables`,
  `emitLocalStatements`, `emitControlNode`, `BlockTree`'s root discovery, and `scheduleLate` collapsed
  into a plain tag check; `exceptValue` needs no fields of its own (the bound `name` carries identity, like
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
- No `'literal'` tag — a literal is `'floating'` with `expr.type === 'literal'`, recognised through
  the dialect's `literalValue` (not a stamp). `foldConstants` folds
  by swapping `.expr` (the one remaining in-place `.type` mutation is gone too now).
- **`slotName(node)` is a FREE FUNCTION; `isVestigialEdge(port)` is a `RawNode` METHOD.** The pair was
  both-methods for a long time (ef7e954 reverted free functions to methods, for `node.foo()` call-site
  ergonomics), and `slotName` went back to a function on 2026-09-16 for a concrete reason: reading a
  tag-local payload from a `RawNode` method would reintroduce the `self` cast. `isVestigialEdge` stays a
  method — it reads only the tag and RawNode fields — `isVestigialEdge` needed an unchecked escape hatch for years (a single `get self()`,
  `this as unknown as NodeAny`; `as unknown as` rather than a bare `as Node` is required — the latter
  does NOT compile when a polymorphic `this` type is involved). **That hatch is GONE as of
  2026-09-16**: `RawNode` declares `type!: NodeType` itself and switches on `this.type` directly —
  see the note at the top for why the field is the tag UNION rather than `string`, and why `NodeAny`
  survives regardless. The real type-safe alternative (a genuine class per INode tag) was considered
  and rejected as too big a structural detour from the flat `RawNode & N` design.

**GCM signature changed underneath this** (user's own uncommitted rewrite, landed alongside c861844,
not yet audited by me beyond "tests still pass"): `applyGlobalCodeMotion(graph: VSDG)` now returns
`{ blocks: BlockTree, blockIds }` (was `{ blockIds, blockControl, getLoopDepth }`), and
`BuildProgram(graph: VSDG, blocks?: BlockTree, blockIds?)` (was 4 separate params). `BlockTree` is a
real class (`roots`/`control`/`tree`/`loopDepthMemo`, a `getControl()` method) replacing the old
`buildBlockTree` free function. Re-read the actual class before relying on internals beyond this.

Gate: `assistant/vsdg-check.sh` — builds first (`npm run examples`), then tsc on src/examples, then
`test-vsdg` (50 exact-output cases), `test-vsdg-py` (28) and `test-vsdg-cpp` (41). See
[[tison-vsdg-dialects]] for what the gate guarantees and why the build-first ordering matters.

**2026-09-16 — `boundName` is gone: the name is tag-local, and `bound` is the flag.** `boundName` held
the same string as `var.name` on a declaration, and was the only name on `mutation`/`gammaValue`/
`exceptValue` (params/catch-params/imports/externals had `name` only), so one name + one bit holds
identical information — but a name is a PAYLOAD, so it belongs on the variants: `gammaValue` and
`exceptValue` now declare a REQUIRED `name`, `mutation` and `unary_post` optional ones, alongside `var`/
`muValue`/`thetaValue`'s existing fields. `RawNode` keeps only `bound`, set by `rebindVar` (for exactly
the three tags whose name comes and goes with the binding: var, mutation, unary_post — postfix ++/--
is a rebind too, and omitting it silently moved the write after the read) and cleared by `reconcileVariables` — which leaves a
cleared node's `name` set, invisible because the only generic `name` reader is `getStructuralKey` and
those tags are all CSE-skip-listed. The pair is read by `slotName(node)`, a FREE FUNCTION that narrows
the tag: `gammaValue`/`exceptValue` return their name directly (it IS their identity, never cleared —
no flag to consult), `var`/`mutation`/`unary_post` return `bound ? name : undefined`, and everything else
undefined
(a muValue/thetaValue is trusted by name where resolveNode reads it). The flag is NOT derivable: only
`reconcileVariables` clears a binding, and for a var "is bound" is not the tag (CPP declarations
deliberately carry no `declKind`). Keep the asymmetry "has a name" ⊃ "is bound": folding onto the
binding alone would make PARAMS look bound (CPP's `nameStoredTo` would stop eliding declarations) and
would drop params' names out of the structural CSE key (`'var' + name + inputs`, and `var` is not in
CSE's skip list). `buildSwitch`'s three explicit `X.name = ...` writes are gone — `rebindVar` sets the
name itself, which also makes `local()`'s `name: ''` placeholder harmless. Verified byte-identical:
TS 50/1, PY 28, CPP 41.
`test-ts-parser.ts` is a coverage harness (GAP/WARNING/ERROR counts), not pass/fail. Run test-vsdg:
`ts-node --transpile-only --compilerOptions '{"module":"commonjs","moduleResolution":"node","ignoreDeprecations":"6.0"}' test/test-vsdg.ts`

**The two postfix tags (`unary_post` + `unary_post_old`) are NOT collapsible into `mutation`/`floating`**
(measured 2026-09-16 by flipping `node.type` on the live graph before Optimize/GCM/build, see
`assistant/ts-postfix-tag-collapse.ts` and `assistant/ts-snapshot-floating.ts`). Snapshot as 'floating' →
`g(i++)` prints `g(null)`: a floating node's value IS its rebuilt payload, while this one's value is its
INPUT (the payload expr is identity only), and `needsTemp`'s single-consumer inlining (correct for a
floating value) inlines it away instead of freezing it. Same with the payload swapped to the postfix's
own OPERAND: `i` → `g(null)` (a bare identifier is never a floating payload), `a[b]++` → throws `Missing
operand edge for slot 1` (a floating node's ports are the payload's OWN sub-expressions, and this node
has one input: the whole operand), and `o.count++` prints the increment BEFORE its consumer — the
tag-keyed "always materialise a read snapshot" rule is what keeps the read above the write. Increment as 'mutation' → `i = null`, and a bare `i++;` grows a spurious `var t0 = i;`
(mutation's `isVestigialEdge` no longer excludes port 1, so the snapshot counts as a real reader). A
stamp-based collapse would also need `isVestigialEdge` and `isSchedulingRelevant` to disagree about the
same edge — vestigial "for values" but load-bearing for scheduling — which one tag cannot say without two
exceptions. Right test for tag-vs-stamp: does the CORE branch on it? It branches on these two; it does not
branch on `pointerMember`/`optional` (printing only), which is why those are stamps.

See [[tison_codegen]] (stale, different file).
