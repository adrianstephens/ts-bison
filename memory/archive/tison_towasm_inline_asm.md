---
name: tison-towasm-inline-asm
description: "towasm.ts: emitExpr now handles a bare __asm<[P],R>('...')(args) call anywhere an expression is allowed, not just as a class member's sole body statement -- 2026-08-09"
metadata:
  type: project
  originSessionId: 888c0914-2616-44d9-97e8-90264c57a251
  modified: 2026-08-09T18:04:22.896Z
---

Follow-on from investigating why `ensureCtor` can't just eagerly *compile* a constructor's `return`
expression to determine `ClassInfo.thisWtype` (see [[tison_generic_classes_accessors]] Round 5's "first
attempt, rejected"). Root cause there was deeper than a fixable restriction: `Array._alloc`'s body has *no*
compilation path except the pre-scanned `scanInlineMethods`/`makeAsmBuiltin` mechanism, which needs the
owner's `typeIndex` as an input up front -- a real structural circularity, not just `ensureMethod`'s
generic-method check. Making `$this`'s resolution properly lazy/patchable (the actual fix for *that*) would
touch `wat-parser.ts`'s `WAT.parseAsmBody`, a bigger change -- user said to leave the constructor case for
now, but asked for the adjacent, independently-useful piece: let `emitExpr` compile a bare
`__asm<[Params],Result>('asm text')(args...)` call *anywhere* an expression is allowed, not only as a class
member's sole statement.

**Implementation** (towasm.ts, `emitExpr`'s `case 'call'`, new branch at the very top): detects
`e.callee.type === 'call' && isAsm(e.callee)` (the shape of `__asm<...>(...)`'s own invocation, called with
real args) and reuses the *exact same* machinery `scanInlineMethods` already built, just invoked live instead
of pre-scanned:
```ts
if (e.callee.type === 'call' && isAsm(e.callee)) {
    if (e.arguments.some(a => a.type === 'spread'))
        throw new Error('towasm: inline asm does not support spread call arguments');
    const owner = ctx.owner;
    const ownerCls = owner && 'fields' in owner ? owner as ClassInfo : undefined;
    const builtin = makeAsmBuiltin('<inline>', e.callee, owner?.name ?? '<top-level>', owner?.typeIndex ?? -1,
        ownerCls && typeof ownerCls.thisWtype !== 'string' && ownerCls.thisWtype && 'arr' in ownerCls.thisWtype ? ownerCls.thisWtype.arr : undefined);
    if (!builtin)
        throw new Error('towasm: inline asm failed to resolve (see the console warning above for details)');
    return emitInline('<inline>', builtin(e.arguments.map(a => operandInfo(a, ctx)), ctx), e.arguments, ctx);
}
```
`makeAsmBuiltin`/`emitInline` needed zero changes -- both were already generic over *how* their inputs get
supplied; `scanInlineMethods` was just one particular caller (pre-scanning a class body, passing a
class-wide `index`/`elemKind` down as params). This new call site reads the same two facts (`$this`'s
typeIndex, bare-`T`'s element kind) *live*, off `ctx.owner` -- whatever class (if any) is actually being
compiled at the moment this expression is reached -- rather than requiring them precomputed and threaded
through ahead of time. `ctx.owner?.typeIndex ?? -1` works with no extra narrowing since `typeIndex` is a base
`MethodOwner` field, present on every owner (builtin or class). Outside any method (a plain top-level
function, `ctx.owner` undefined), `$this`/`$elem` simply aren't available -- fine unless the asm text
actually references them, exactly matching `WAT.parseAsmBody`'s existing lazy/conditional defines lookup
(no special-casing needed for the no-owner case).

**Also handles the `$T`-generic asm variant for free**: `makeAsmBuiltin`'s return value is already uniform
over both the fixed-type and `$T`-generic (`WAT.isTypeGeneric`) cases -- the generic branch's own closure
picks a variant from the actual operands' `wtype` at call time, which this new call site already supplies via
`operandInfo`. No separate handling needed.

**Verified via a dedicated probe** (deleted after use): a plain top-level function using inline asm mid-body
(not as its only statement) -- `__asm<[i32],i32>('i32.const 1 i32.add')(x)`, correct; a *user class* (`Box`)
method with more than one statement, inline asm referencing the class's own value via `$this`-independent
plain-value coercion mid-body -- correct (`21` for `(10*2)+1`). Full suite re-run: 179/179, identical
stopping point, zero regressions -- this is a pure *addition* (a new, previously-unreachable `case 'call'`
branch), nothing existing changed shape.

Constructor eager-compilation itself remains unaddressed (deliberately, per the user) -- `ensureClass` still
uses the static `ctorReturnHelper` declared-return-type lookup, not real compilation, for
`ClassInfo.thisWtype` derivation. This inline-asm generalization does NOT retroactively unblock that case on
its own (the constructor-compile circularity is about `Array._alloc` needing a *class method call* — i.e.
`Array._alloc(n)`, not a bare `__asm(...)` expression — to resolve before the owner's typeIndex is known;
this round only generalizes bare `__asm(...)` expressions, not ordinary method calls).
