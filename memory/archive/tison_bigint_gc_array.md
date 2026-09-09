---
name: tison-bigint-gc-array
description: "towasm.ts/lib/bigint.ts: gave Array<T> a real u32 element kind and migrated bigint's limb storage from Uint32Array (linear memory, never freed) to a real u32[] wasm-GC array (reclaimed by the host GC) -- 2026-08-07"
metadata:
  type: project
  originSessionId: 888c0914-2616-44d9-97e8-90264c57a251
  modified: 2026-08-08T04:04:42.150Z
---

Follows [[tison_typedarray_linear_memory]]'s round 3. User asked why `bigint` used `Uint32Array` at all
rather than `Array<u32>`, given the project's `emitAlloc` bump allocator (towasm.ts) has **no free path** --
`lib/bigint.ts`'s arithmetic (`bigAdd`/`bigMulMag`/`bigSubMag`/etc) allocates a fresh limb array on *every*
operation, including throwaway intermediates `bigTrim` discards immediately, so every one permanently
leaked linear memory. A wasm-GC array (`Array<u32>`) gets reclaimed by the host GC once unreachable --
real win for a type this allocation-churny. User: "if something needs to be special cased I'd prefer to fix
the need for special casing first" (echoed from the typed-array round) -- i.e. give `Array<T>` real
unsigned support rather than hack bigint's representation around the gap.

## What changed

**Part A (towasm.ts) -- real `u32` element kind for `Array<T>`:**
- `wasmElement` gained `'u32'` alongside `i16/i32/i64/f32/f64/ref`.
- `arrayElemKind` now recognizes `wasmTypeOf(...)==='u32'` (previously fell through to `'ref'`, which would
  have wrongly boxed unsigned ints as GC anyrefs).
- `builtinArrayOwners.u32` added (7th entry, physical index 6, right after `ref`) --
  `builtinOwner('Array<u32>', TS.ArrayType(TS.RefType('u32')), 'Array', TS.RefType('u32'), 6, 'u32')`,
  same shape as the existing 5 `Array<T>` instantiations.
- The physical-storage registration loop (`for (const kind of Object.keys(builtinArrayOwners))`) now maps
  `kind==='u32'` to real storage `'i32'` (matching `toValType`'s existing `u32->i32` convention) instead of
  an invalid cast straight to `NumericType`.

**Part B (lib/bigint.ts) -- migrated off `Uint32Array`:**
- Every `Uint32Array` annotation -> `u32[]`; every `as unknown as Uint32Array` -> `as unknown as u32[]`
  (`as`/`as unknown as X` is a pure no-op passthrough in this compiler, so this is a mechanical rename).
- `builtinTypes.bigint.wtype`: `{ ref: 'Uint32Array' }` -> `{ arr: 'u32' }`. `T.BIGINT` is
  `TS.RefType('bigint')`, which hits `wasmTypeOf`'s very first fast path by name, so every `this`/`bigint`-
  typed value picks this up automatically; `owner` (BigInt's own method dispatch) is unaffected.
- Allocation: originally planned to use the existing `Array.alloc<T>` intrinsic bigint's own methods
  already use internally -- **this plan was wrong, caught empirically** (see bugs below); ended up building
  real `new Array<T>(n)` support instead and using that.

## Real bugs found + fixed (all via actual execution, matching this project's established discipline --
## every one of these would have shipped silently wrong or thrown, not been caught by tsc)

1. **`Array.alloc<T>(n)` is only reachable from *inside* `Array<T>`'s own methods, not general calling
   code.** Planned to have `bigint.ts` call `Array.alloc<u32>(n)` directly (the same intrinsic `Array<T>`'s
   own public `constructor(n)` wraps) -- threw `unknown method 'alloc'`. Root cause: namespace-style static
   calls (`Array.alloc(...)`, `Math.sqrt(...)`) resolve their owner via
   `builtinTypes[obj.name]?.owner ?? (ctx.owner?.decl.name === obj.name ? ctx.owner : undefined)`
   (towasm.ts, both `case 'member'` static-field reads and `case 'call'`) -- `Array` has no `builtinTypes`
   entry, so this only resolves when `ctx.owner` (whichever method is *currently being compiled*) is itself
   one of `Array<T>`'s own instantiations. `new Array<T>(...)` construction itself was previously completely
   unimplemented (`case 'new'` had no branch for `Array`, and `ensureClass('Array')` throws on `typeParams`
   before ever reaching a constructor). Fixed by adding a small dedicated `case 'new'` branch for `Array`
   (same shape as the existing `ArrayBuffer`/`String` branches) that resolves the element kind directly from
   the `new Array<T>(...)` call's own explicit type argument and emits `array.new_default` on that owner's
   typeIndex -- no `ctx.owner` dependency at all.
2. **`coerceTop` had no `i32`/`u32` -> `i64` conversion path.** `bigMulMag`'s `__towasm_mulWide(a[i], b[j])`
   (params declared `[i64,i64]`) now receives genuine `u32`-tagged limb reads (previously -- per an old,
   now-corrected comment -- `Uint32Array.get` apparently widened to a wider type before reaching this call).
   Threw `cannot convert "u32" to "i64"`. Fixed by adding `i64.extend_i32_s`/`i64.extend_i32_u` cases,
   mirroring the existing `f64`->`i32`/`u32`/`i64` conversions right above.
3. **The "generate bigint from a scalar" coercion was hardcoded to `{arr:'i32'}`.** A pre-existing
   `coerceTop` special case (building a 1- or 2-limb array from a bare `i32`/`i64` value, e.g. implicit
   int->bigint promotion) checked `wasmTypeEq(want, {arr:'i32'})` and used `builtinArrayOwners.i32` --
   stale from when `bigint` used to be backed by `Array<i32>` (predates this session, per the user's own
   recollection). Now that `bigint`'s `wtype` is `{arr:'u32'}` (a *different*, newly-distinct physical array
   kind from `i32`'s), this needed retargeting to `{arr:'u32'}`/`builtinArrayOwners.u32` to match wherever
   `bigint`'s representation actually points, not a fixed literal.
4. **General, not `u32`-specific: `ctx.local`/`declareLocal` compare repeat local declarations by `!==`
   (referential identity), and `{arr: kind}` objects were constructed as fresh literals at ~16 separate call
   sites.** Two `array[i] = ...`/`array[i] += ...` statements on the *same plain array variable* within one
   function threw `local '$obj' redeclared with different type` -- pre-existing bug (not caused by adding
   `u32`), just never previously hit because no existing test assigned into the same plain-array variable
   twice in one function (typed arrays dodge this via `classWtype`'s already-memoized cache; plain
   `{arr:...}` arrays had no equivalent). Fixed the general way: a new module-level `ARR_WTYPE: Record<
   wasmElement, WasmType>` memoization table (one shared object per element kind, exact same pattern as
   `classWtype`), with every `{ arr: X }` construction site (~16 of them) switched to `ARR_WTYPE[X]`.

## Verification

`npx tsc --noEmit -p examples/tsconfig.json` clean. `npx tsx test/test-towasm.ts`: 161/161 (same stopping
point as always -- the pre-existing, unrelated `PI_HALF`/`reducePi2` issue). Re-ran every existing
`assistant/probe-big*.ts` script (add/sub/mul/div/mod/compare/shl/shrs/shru, signed and unsigned, small and
>2^53-magnitude) -- all match real `BigInt` semantics exactly; one probe (`probe-bigshift.ts`'s `shruNeg`)
had a wrong hand-written "expected" comment from before this session (assumed 2 limbs for `-1n` when
`bigTrim` actually collapses it to 1) -- corrected the comment, not a real regression, verified by reasoning
through `bigTrim`'s exact trim condition. New probe (deleted after use) directly exercised plain `u32[]`
arrays independent of bigint (unsigned compare, arithmetic, compound assignment, `.length`) -- all correct.
Structural check: a bigint-only compiled module declares **no** `(memory ...)` section at all -- concrete
evidence the GC-array switch actually dropped the linear-memory allocator dependency for bigint, not just a
claim.
