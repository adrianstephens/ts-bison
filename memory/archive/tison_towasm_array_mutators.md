---
name: tison-towasm-array-mutators
description: "towasm.ts (TS-to-wasm) supports \"self-reassigning\" methods generally (assignsToThis/reassignsThis) via a real wasm multi-value result, not by hardcoding method names -- Array<T>.push/pop/shift/unshift are just the first real bodies to use it; also generalized rest-param call-site bundling"
metadata: 
  node_type: memory
  type: project
  originSessionId: 888c0914-2616-44d9-97e8-90264c57a251
  modified: 2026-08-08T23:02:58.380Z
---

2026-08-08: implemented `Array<T>.push`/`pop`/`shift`/`unshift` in `examples/TS/towasm.ts`, TWICE. First pass
special-cased the four method names directly in `case 'call'` (`emitArrayMutatingCall`) -- **user pushed back
hard on this** ("having to special-case 'push', 'pop', etc is taking us in the wrong direction... an absolute
last resort... a general mechanism that will work for any similar situation"), and specifically suggested the
real trigger: detect an attempt to write to `this`. Second pass replaced it with that general mechanism;
`emitArrayMutatingCall` is gone entirely. **Lesson for future work in this file**: default to a shape-based/
structural trigger (matches `scanInlineMethods`'s asm-body recognition, `methodSig`'s get/set probe, this
session's own `assignsToThis`), not a name/owner-based special case, even under time pressure -- ask first if
unsure whether a per-method-name shortcut is acceptable.

**The general mechanism**: real TS never allows assigning to `this` -- so a declared method body that does it
anyway has exactly one sensible meaning in this compiler's subset: "replace my own receiver's physical
value" (needed because a wasm-GC array/struct can't resize/relocate in place). `assignsToThis(body)` walks a
method's body (`walkB`, same tool the file already uses for top-level `console.log` detection) for a
`{type:'binary', operator:'=', left:{type:'this'}}` node -- structural, not name-based, so *any* method on
*any* class gets the same treatment automatically. `ensureMethod` computes this once per method
(`reassignsThis`), and when true: compiles the method with a REAL wasm multi-value function type (declared
result, if not void, followed by `this`'s own type as a second result -- `wasm.HeapType`/the type section
already support this natively via `results: ValType[]`, `FuncInfo`/`FuncSig` just never needed more than one
before), and every `return` (`case 'return'`, `FuncCtx.appendThisOnReturn`) appends the *current* value of
`this` as that extra result. The call site (`case 'call'`'s final generic member-call dispatch, not a special
branch) checks `ensureMethod(owner, name)?.reassignsThis`; if true, it pushes the receiver via
`emitAssignTarget(obj, ctx, 'keep')` (same lvalue machinery compound assignment/`++`/`--` already use --
handles identifier/member/index receivers uniformly, and throws its own "cannot assign to X" for a temporary
receiver like `foo().push(x)`, for free), calls normally through the ordinary `emitMethodCall`, then
`target.write(false)` consumes the extra `this` result off the stack and writes it back, leaving the method's
ordinary declared result as the call expression's own value. Net result: the whole call-site mechanism is
~10 lines, reusing `emitAssignTarget` + `emitMethodCall` as-is -- no bespoke instruction emission at all
(contrast with round 1's ~100-line hand-rolled `array.new_default`/`array.copy`/`array.set` sequence, one per
method name).

**A second, orthogonal generalization needed along the way**: `push`/`unshift`'s real declared bodies need
`...items: T[]` to be a genuinely usable runtime array inside the method (`items.length`, `Array._copy(...,
items, ...)`), but the call site had *never* bundled trailing call-site arguments into a real array for a
rest param at all (`fillDefaultArgs` just threw "takes exactly N arguments" the moment a rest-param method
was called with more than N-1 args -- confirmed via an isolated non-Array probe, so this predates and is
independent of Array's own reassignment problem). Fixed generally too: new `emitCallArgs` (shared by
`emitCall`/`emitMethodCall`) checks `FuncInfo.hasRest`; when set, it bundles every trailing call-site argument
via the *existing* `emitArrayElements` (the same builder array-literals already use, which already handles a
spread among the elements for free -- `arr.push(...other)` now just works). Also fixed a real pre-existing
bug found in the same area: `ensureMethod`'s worklist callback never included `decl.rest` in
`ctx.declareParams` (only `ensureFunc`, for top-level functions, did) -- a rest param on a *method* had no
real local at all before this.

**Bugs found in round 1 (all pre-existing, all "ref-kind array physically stores boxed `anyref` but callers
assume the concrete class type" -- still valid, still fixed, survived into round 2 unchanged)**:
1. `coerceTop` had no upcast case (concrete class ref -> `anyref`) -- fixed.
2. `toValType`/`heapTypeIndexOf` didn't handle `{ref:'any'}` as a real (not just transient) WasmType -- fixed.
3. `case 'member'`'s plain struct-field read used raw `emitExpr` instead of `emitAs`, skipping a needed
   narrowing cast when the object came from a ref-kind array index read (`a[i].field`) -- fixed.

Also added `REF_ANY`, a shared singleton for a ref-kind element's own `{ref:'any'}` wtype (object-identity
comparison gotcha, same reasoning `ARR_WTYPE` already documents) -- used by the new mechanism and retrofitted
into one pre-existing site (`emitAssignTarget`'s `'index'` write branch) with the identical latent bug.

**Still open / known separate limitations, unchanged by this work**: `splice` still has its old stub body (not
migrated to `reassignsThis` yet -- same design would apply). Scalar-`T` `Array<T>.pop()`/`.shift()` still
throw resolving `T | undefined` (pre-existing "nullable number/boolean not supported" limit, same one `find`
already has -- ref-kind element arrays work fully). Nested arrays (`number[][]`) have a separate, confirmed
pre-existing bug unrelated to any of this (`arrs[0] = new Array<number>(n)` throws `cannot convert {arr:f64}
to {arr:ref}` even with zero mutating-method calls involved) -- found while testing an index-typed receiver
for the reassignment mechanism, isolated and confirmed unrelated, left open. `Math.log`'s `ieeeFrom`
return-type gap (see `tison_towasm_switch_break_continue.md`) is still the suite's stopping point, still
confirmed unrelated to any array work.

**Verification**: `tsc` clean; full suite 161/161 both before and after round 2's full rewrite (zero
regressions from swapping the mechanism); dedicated probes covering push (single/multi-arg/spread), unshift,
identifier/member/index receivers (including a receiver reached through another method's own `this.arr`),
pop/shift (empty + non-empty, ref-kind elements), and a standalone non-Array rest-param method, all passed
and were deleted per convention.
