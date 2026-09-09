---
name: tison-towasm-lazy-array-types
description: "towasm.ts: replaced eager builtinArrayOwners/placeholderArrayTypeIndex (7 wasm-GC array types pre-registered at fixed indices 0-6, manually kept in sync) with a lazy, memoized ensureArrayType(kind) -- and found+fixed a real, currently-in-tree regression in scanInlineMethods along the way; round 2 generalized the same lazy-per-compile idea to builtinOwners (Number/Boolean/BigInt/Math), closing BigInt's dangling typeIndex:-1 for real; round 3 fully unified builtinTypes onto ensureClass alone (constructor-return-type detection generalized to any WasmType, not just array-shaped, given real constructors for Number/BigInt) -- 2026-08-09"
metadata:
  type: project
  originSessionId: 888c0914-2616-44d9-97e8-90264c57a251
  modified: 2026-08-09T20:13:34.688Z
---

Follow-on from [[tison_generic_classes_accessors]]'s `thisWtype` work. User asked, of the `string`/`String`
double-lookup in `ownerFor`, a deeper question: "there isn't really any difference between Array and String
other than we elected to pre-instantiate the arrays at fixed type indices -- are those fixed type indices
necessary still?"

**Answer given, then implemented**: the *sharing* is necessary (wasm-GC array types are `final`/no-supertype,
so every consumer of one element kind -- `Array<T>`'s own instantiations, `String`, any user class whose
constructor returns an array -- must land on the same typeIndex or cross-instantiation ops like `array.copy`
fail validation). The *eagerness* (`builtinArrayOwners`'s 7-entry table, each built via
`placeholderArrayTypeIndex(index)` with a manually-assigned index 0-6, plus a `for` loop at module-build start
unconditionally calling `registerType` for all 7 kinds regardless of whether a given program uses them) was
not necessary -- `registerType` is just `types.push(type); return types.length-1`, no ordering constraint,
exactly the same primitive `ensureClass` already uses lazily for structs.

**Implementation**: removed `builtinArrayOwners`/`placeholderArrayTypeIndex` entirely. Added, right after
`registerType` inside `TStoWasm`'s closure:
```ts
const arrayTypeIndices = new Map<wasmElement, number>();
function ensureArrayType(kind: wasmElement): number {
	let typeIndex = arrayTypeIndices.get(kind);
	if (typeIndex === undefined) {
		typeIndex = registerType({ final: true, supertypes: [], type: { kind: 'array', field: { type: kind === 'ref' ? { ref: 'any', nullable: true } : kind === 'u32' ? 'i32' : kind as NumericType, mut: true } } });
		arrayTypeIndices.set(kind, typeIndex);
	}
	return typeIndex;
}
```
Every one of the 14 `builtinArrayOwners[kind].typeIndex`/`builtinArrayOwners.<kind>.typeIndex` call sites
(confirmed via grep: all 14 only ever read `.typeIndex`, never used the placeholder `MethodOwner` shape
itself -- `decl`/`thisTsType`/`methodDecls` were dead weight on it, per that function's own prior comment)
became `ensureArrayType(kind)`. Removed the eager pre-registration loop at module-build start entirely --
each element kind's physical type now registers on first real demand, same as a struct class.

**Real regression found and fixed along the way (unrelated to this change, but blocking verification of it)**:
`git diff` against HEAD showed `scanInlineMethods`'s method/get/set-accessor recognition branch had been
silently broken during an earlier *comment-trimming* pass this session (before this specific round) --
`if (!isAsm(outer.callee)) continue;` (correct: checks the *inner* `__asm<...>('text')` call) had become
`if (isAsm(outer)) { ... }` (wrong: checks the *outer* invocation `__asm<...>('text')(args)`, whose `.callee`
is a `call` node, never `'identifier'` -- confirmed via a throwaway AST-dump probe). This made the whole
branch permanently dead: any accessor/method declared as `get length(): number { return
__asm<[],u32>('array.len')(); }` (as opposed to a bare field like `charCodeAt = __asm<[i32],i32>('array.get_u
$this')`) could never be recognized as inline again, silently falling through to `ensureMethod`'s general
statement-compilation path -- which has no implicit receiver-push prologue for a body that never textually
references `this`, producing "not enough arguments on the stack for array.len" the moment such a getter was
ever actually reached as a real function call rather than inlined at every call site. Fixed by checking
`outer?.type === 'call' && isAsm(outer.callee)` -- same shape as the general inline-asm `emitExpr` branch from
[[tison_towasm_inline_asm]]. This bug, not the array-laziness change, was what crashed the very first test
(`strTemplate`, exercising `String.length`) when first verifying this round's change -- diagnosed by comparing
against a `git stash`-recovered prior state, which turned out to be a much older pre-`thisWtype` version of the
file (nothing committed all session), not a true adjacent-commit baseline -- worth remembering: `git stash`
here reverts to the last *commit*, not "a moment ago in this session," when nothing has been committed.

**Verification**: `tsc --noEmit -p examples/tsconfig.json` clean, eslint clean (0 warnings on the new code; the
21 pre-existing `custom/no-single-use-local` warnings elsewhere in the file are unrelated). Full
`test-towasm.ts` suite: 187 "ok" lines (up from the previously-documented 179 baseline -- other, unrelated
work landed in the same uncommitted session) before stopping at the same already-documented, pre-existing,
open template-literal-interpolation bug ([[tison_checker_muted_hoistvar_bug]]'s "Template literal
interpolation of a non-number value is broken" -- same file:line, same message, confirmed not a new
regression). A dedicated probe (deleted after use) directly exercised `string.length`, `number[].length`, and
`arr[i]`/`arr[i]=v` get/set through real wasm execution end-to-end: all correct (5, 4, 99).

## Round 2 (same day): generalized to `builtinOwners` (Number/Boolean/BigInt/Math)

User noticed `builtinOwners.bigint = builtinOwner('BigInt', T.BIGINT, 'BigInt')` passes no `index`, defaulting
`MethodOwner.typeIndex` to `-1` -- despite `BigInt` being genuinely array-backed (`u32[]`, per
[[tison_bigint_gc_array]]). Traced to the same root cause as Round 1: `builtinOwner`/`builtinOwners`/
`builtinTypes` all live at *module* scope, so they structurally cannot call `ensureArrayType` (per-compile,
only exists inside `TStoWasm`) to get BigInt a real typeIndex -- `-1` isn't a considered choice, it's the only
thing available there. Currently harmless only because `class BigInt` (`lib/bigint.ts`) has zero asm-bodied
members (every method is plain TS reinterpreting `this as unknown as u32[]` and delegating to free functions)
-- add one asm-bodied method later (e.g. a fast `get(i)`) and `$this` silently bakes in as `-1`, invalid wasm,
no compile-time catch.

User's fix, generalizing Round 1's insight: `builtinTypes` should store the *name* of the builtin, not a
pre-built instantiation -- exactly what `string`/`String` already do (`ensureClass('String')`, resolved
dynamically). Implemented:
- `builtinOwner(name, thisTsType, index=-1, elemKind?)`: dropped the now-fully-dead `builtin`/`subs` params
  (every remaining caller had `name === builtin` and never passed `subs` -- that was only ever for the old
  hand-enumerated `Array<...>` instantiations, gone since [[tison_generic_classes_accessors]]).
- New module-level `BUILTIN_THIS_TYPES: Record<string, Type>` (`Number`/`Boolean`/`BigInt`/`Math` -> their
  canonical checker `Type` -- pure data, fine at module scope, unlike the owner construction itself).
- `builtinTypes` entries: `owner?: MethodOwner` field replaced by `builtin?: string; elemKind?: wasmElement`
  (just which lib class backs this type, plus its element kind if array-backed -- `bigint` now carries
  `elemKind: 'u32'`).
- New, inside `TStoWasm`'s closure (next to `ensureArrayType`): `ensureBuiltinOwner(name, elemKind?)`, a
  `Map`-memoized lazy builder --  `elemKind ? ensureArrayType(elemKind) : -1` as the real `index` passed to
  `builtinOwner`. `BigInt` now gets a genuine, correct typeIndex; `Number`/`Boolean`/`Math` still get `-1`,
  now for a principled, shared reason (never array/struct-backed) instead of an eager-construction accident.
  Plus a thin `builtinTypeOwner(name)` wrapper (`builtinTypes[name]`'s `.builtin`/`.elemKind` -> `ensureBuiltinOwner`)
  shared by all 3 real call sites (`ownerFor`'s fast path + fallback, `namespaceOwner`).
- **Knock-on fix, found via `tsc`**: `equalityInline`/`bigintAware` (module-level, dispatch bigint arithmetic/
  equality) compared `args[0].owner === builtinTypes.bigint.owner` by *object identity* against what used to
  be a stable module-level singleton. With the owner now per-compile-memoized (no module-level field to
  compare against at all), switched both to `args[0].owner?.name === 'BigInt'` -- a *name* check, exactly
  matching the adjacent pre-existing `args[0].owner?.name === 'String'` check one line below it in
  `equalityInline`. Identity still holds *within* one compile (same memoized instance throughout), so this
  isn't a behavior change, just matching an already-established pattern instead of relying on a property that
  no longer exists.

**Verification**: `tsc`/eslint clean (same 21 pre-existing unrelated warnings, none new). Full suite: still 187
oks, same stopping point, zero regressions -- specifically confirmed `bigRoundTrip`/`bigAddSmall`/`bigAddCarry`/
`bigLt`/`bigGtFalse`/`bigEq`/`bigNeq` all still pass (exercises exactly the `equalityInline`/`bigintAware`
name-based dispatch path this round touched).

## Round 3 (same day): full unification -- every `builtinTypes` entry resolves via `ensureClass` alone

User pushed back on `string`/`String` staying special-cased (`ensureClass('String')` directly) while
`Number`/`Boolean`/`BigInt`/`Math` used the separate `ensureBuiltinOwner` path: "the idea was that the
constructor's return type would determine the stack and storage type, and it wasn't supposed to be
restricted to GC arrays or structs. Number's constructor should return an f64." Then: "generalise so all
builtinTypes can take the name of their implementation."

**Root design gap**: `ensureClass`'s explicit-return-constructor branch had two accidental restrictions,
neither ever asked for: (1) `if (!result || typeof result === 'string' || !('arr' in result)) throw` --
rejected any *scalar* result outright, only array-shaped was allowed; (2) the underlying detector
(`ctorReturnHelper`) only recognized `return SomeClass.staticHelper(...)` -- a call to one of the class's
own static helpers -- because it read that helper's own *declared* return type directly off the AST, no
compilation/re-inference needed. `Number`'s natural body (`constructor(value: number) { return value; }`)
isn't a call at all, so the detector found nothing and fell through to the struct-default branch --
wrong, `Number` values are `f64`, not a boxed GC struct.

**Fix, `ctorReturnType` (replaces `ctorReturnHelper`)**: strips all `as` casts unconditionally first (they're
compile-time-only, don't affect the wasm stack -- same reasoning as `emitExpr`'s own `case 'as'` passthrough),
then resolves the stripped expression's type two ways, tried in order:
1. **Same-class static-helper call** (`Array._alloc(n)`, `String.alloc(0)`) -- read the helper's own declared
   return type straight off `info.decl` (already substituted to this concrete instantiation), syntactically.
   **Load-bearing, not optional**: my first attempt dropped this and always re-resolved via
   `checker.typeOf(strippedExpr, scope)` against `libGlobal` -- for a *generic* class this looks up
   `Array._alloc<T>(n): T[]` against `Array`'s own still-generic signature (`T` unconstrained by `n`'s type)
   and loses the `T -> number` substitution entirely. Caught by the full suite: `Array<number>` silently got
   the generic catch-all `{arr:'ref'}` representation instead of `{arr:'f64'}`, and `values[i]` (an
   `Array<number>`) baked the *wrong* shared array typeIndex into its inline `array.get`, producing a real
   wasm validation failure (`array.get[0] expected type (ref null 2), found local.get of type (ref 3)`) the
   moment two different element kinds coexisted in one compile (`strTemplate`'s `strings: string[]` +
   `values: number[]`). Restoring this syntactic branch as the first-tried check fixed it.
2. **Otherwise** (not a same-class-helper call, e.g. `Number`'s bare `return value;`): ask the checker
   directly (`checker.typeOf(e, scope)`), with the constructor's own params bound into a fresh
   `new Scope(libGlobal)` first. Safe here specifically because a non-generic constructor's own params carry
   no substitution to lose.
3. The `!('arr' in result)` restriction in `ensureClass` itself is gone -- any scalar (`typeof result ===
   'string'`) or array-shaped result is accepted; `info.typeIndex = typeof result === 'string' ? -1 :
   ensureArrayType(result.arr)`.

**Lib changes**: `Number`'s `constructor(value?: any) {}` (empty, dead) -> `constructor(value: number) {
return value as unknown as Number; }`. `BigInt` had *no* constructor at all (real bigint values never flow
through one -- they come from literal parsing / `bigAdd`-style free functions reinterpreting `u32[]`) -- given
one purely for `ensureClass`'s detection: `constructor(value?: any) { return new Array<u32>(0) as unknown as
BigInt; }` (never meaningfully invoked, exactly like `String`'s own constructor comment already describes for
itself). `Math` needed no change -- no constructor, falls to the struct-default branch, which is harmless
since `new Math()` never happens (nothing ever references that unused struct type).

**`builtinTypes`/dispatch unification**: `builtin?: string; elemKind?: wasmElement` fields replaced by a single
`class?: string`; `builtinOwner`/`ensureBuiltinOwner`/`BUILTIN_THIS_TYPES`/`builtinOwnerCache` deleted entirely
(their whole reason to exist -- a *weaker* mechanism than `ensureClass`, no get/set-accessor or
struct/array-representation handling -- no longer needed once scalar results are supported). `builtinTypeOwner`
is now just `bt.class ? ensureClass(bt.class) : undefined` -- `Boolean` (no decl exists) still cleanly resolves
to `undefined` through the exact same path, no special case. This also let the `string`/`String` special-casing
be deleted from all three call sites (`ownerFor`'s fast path, its `case 'ref'` switch, `namespaceOwner`) --
`builtinTypeOwner('String')` reaches `ensureClass('String')` the same way any other entry does now.

**Verification**: `tsc`/eslint clean (20 pre-existing unrelated warnings now, one fewer than Round 2's 21 --
`builtinOwner`'s own single-use-local warning went away with the function). Full suite: 187 oks, identical
stopping point, zero regressions -- specifically re-confirmed after the generic-substitution bug was found and
fixed (bigint tests + `Number` method tests like `toFixed`/`toPrecision`/`toString` all still pass, exercising
both migrated classes' method dispatch through the new path).
