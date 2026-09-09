---
name: tison-interface-inheritance
description: "How tison models `interface X extends Y` (an intersection) and the ONE ordering convention that makes member override, index-signature override and inherited call-signature ordering all work; fixed 2026-09-09 in `e1f495e`."
metadata:
  node_type: memory
  type: project
---

An `interface X extends A, B` becomes `intersectTypes([...bases, own])` (`checker.ts`'s `hoist`).
There is no separate inheritance concept — every override question is therefore an *ordering*
question over an intersection's parts, and the whole thing hangs on ONE convention:

> **The LAST part of an intersection is the most concrete.**

`Scope.mergeType`/`mergeTypeEntry` already appended that way (a cross-file `interface` augmentation
after the declaration it augments; `hoist` processes interfaces before classes, so an ambient
interface merged with its implementing class has the class last). `hoist`'s `extends` case was the
sole violator until `e1f495e` — it built `[own, ...bases]` under a comment claiming "first match wins",
which is only true when exactly ONE part matches.

**Every consumer must therefore read an intersection BACKWARDS**, and there are four:
- `lookupMember`'s `case 'intersection'` — already did (`[...distinct].reverse()` before merging
  same-named signatures into one overload set). This is what made own-first backwards.
- `lookupMember`'s no-named-match index fallback — now does.
- `indexSignatureOf` — now does. This is the `NodeListOf<T>`'s `[index: number]: T` over the `Node`
  it inherits from `NodeList` case, and it is reached only by a **COMPUTED** index (`l[i]`); a
  LITERAL index (`l[0]`) goes through `lookupMember` with prop `'0'` instead and never sees it.
  A repro written with `l[0]` is green for the wrong reason.
- `collectMembers` (call/construct signatures, `checker.ts`'s `case 'call'`) — now does, but
  reversal alone is NOT enough; see below.

## `collectMembers` must be LEVEL-ORDER, not merely reversed

`intersectTypes` flattens a nested *intersection* but **not a `ref`**, so `interface C extends C1, C2`
stores `[C1ref, C2ref, own]` with each base's own parts still nested. A depth-first walk therefore
emits all of C2's ancestors — including an inherited catch-all `(key: string): void` — before C1's
own `(x: 'C1'): number[]`, and overload resolution's "first arity+type fit wins" then answers every
specialized call with `void`. Real TS orders inherited call signatures by inheritance **DEPTH**;
`collectMembers` now does a level-order walk (reversing within each level) and reproduces it exactly.
The official suite's `inheritedOverloadedSpecializedSignatures.ts` is the test for precisely this and
was failing 5 of its 9 assertions before `e1f495e`.

## What this closed, and the cascade lesson

`e1f495e`: corpus false positives 1392 -> 1387 (zero added, all five that one test); workspace
ERROR 207 -> 185 (zero added).

**The `realRoot<polyType>` sighting from `ba8a867` was DOWNSTREAM of this, not a separate inference
bug** — the plan spent a session pointing at "we substitute a type parameter's CONSTRAINT where tsc
has the concrete argument" as an independent cause. In fact `curvature_from_tangent`'s `.sub` failed
on the wrongly-inherited `mul` return type, which poisoned its local to `any`, and an `any` argument
leaves `T` uninferable so inference falls back to the constraint. One bug, three diagnostics, two
files apart. **Chase the FIRST error in a file before believing a later one names its own cause.**

Reordering an intersection also changes how `typeKey` PRINTS it (bases first now), so an A/B diff
shows same-`file:line:col` lines "changing" that are only re-rendered. Match on position, not message.

Related: [[tison_towasm_self_hosting_plan]], [[tison_nominal_class_refs]], [[tison_checker_inference]].
