---
name: tison-typedarray-linear-memory
description: "towasm.ts: Uint8Array/Int32Array/Uint32Array/ArrayBuffer rearchitected from wasm-GC arrays to real linear-memory views with genuine cross-view aliasing (2026-08-07); round 2 generalized indexing itself into a new class get(i)/set(i,v) dispatch mechanism; round 3 replaced the fragile exact-string asm-text swap with a defines-resolved (switch $elem ...) -- same mechanism $this already used"
metadata:
  type: project
  originSessionId: 888c0914-2616-44d9-97e8-90264c57a251
  modified: 2026-08-08T03:29:28.807Z
---

User flagged that typed-array semantics were "quite wrong": each `Uint8Array`/`Int32Array`/`Uint32Array`
was its own independent wasm-GC `array` object, so real JS's core typed-array property -- multiple views
aliasing the *same* bytes (`new Uint8Array(buf)`, `.subarray()`, writes visible across views) -- was
structurally impossible. Fixed by giving them a real backing store.

## Design chosen (two explicit user decisions along the way)

1. **Linear memory, not a GC `array(i8)` backing buffer.** User picked this over the GC-array alternative
   (which would've needed manual multi-byte load/store via shift/or on an i8 array) specifically to get
   real byte-addressable aliasing cheaply via wasm's native `i32.load`/`store` family.
2. **Standalone implementation, not a generalized `elemKind`/`Array<T>` storage kind.** towasm's whole
   array/string/bigint system is built on one generic `Array<T>` class (`lib/array.ts`) whose method
   bodies are asm-text templates (`array.new_default $this`, `array.copy $this $this`) monomorphized per
   physical GC-array kind (`elemKind`, see `builtinArrayOwners`/`makeAsmBuiltin`). Extending that
   mechanism to a *second* physical storage kind (linear-memory view) was the "proper" option but meant
   touching the core dispatch machinery every other array/string type also depends on. User chose the
   smaller, lower-risk fork: typed arrays get their own hand-written implementation, sharing one
   implementation *across the 3 kinds* (not through `Array<T>`) -- see `TA_METHODS` below.

## Physical layout (towasm.ts)

- `ARRAYBUFFER_TYPE_INDEX`/`TYPEDARRAY_VIEW_TYPE_INDEX` (6, 7): two new wasm-GC struct types, registered
  unconditionally right after `builtinArrayOwners`'s existing 6 array types -- same "index N == Nth
  `registerType` call" convention `builtinArrayOwners` itself already relied on (0-6 are hardcoded to
  match iteration order).
  - `ArrayBuffer` struct: `{offset: i32, byteLength: i32}` (`ARRAYBUFFER_OFFSET_FIELD`/`_BYTELENGTH_FIELD`).
  - View struct: `{buffer: ref ArrayBuffer, byteOffset: i32, length: i32 (elements), base: i32}`
    (`VIEW_BUFFER_FIELD`/`_BYTEOFFSET_FIELD`/`_LENGTH_FIELD`/`_BASE_FIELD`). `base` = `buffer.offset +
    byteOffset`, precomputed once at construction so every element read/write is one `struct.get` off the
    view + `index*elemSize` + `load`/`store`, not a `buffer` detour every time (the hot path).
  - Shared physically by `Uint8Array`/`Int32Array`/`Uint32Array` (one struct type, like the old GC-array
    scheme shared `{arr:'i32'}` between `Int32Array`/`Uint32Array`/`boolean[]`) -- disambiguated the same
    established way: `typedArrayKindOf(e, ctx)` reads the real checker `Type`, never reverse-decodes the
    physical `WasmType`. `TYPED_ARRAY_ELEM: Record<TypedArrayKind, {size, load, store, wtype}>` is the
    per-kind config (`Uint32Array`'s `wtype` is `'u32'`, matching the existing u32 tagging convention).
  - `bigint`'s own `wtype` had to move from its old private `{arr:'i32'}` to the SAME `TYPEDARRAY_VIEW_WTYPE`
    -- `lib/bigint.ts` literally *is* `Uint32Array` under the hood (`as unknown as Uint32Array` limb-array
    casts throughout), not just a consumer of it, so its representation must track Uint32Array's exactly.
    Missing this produced `towasm: internal: cannot convert {"arr":"i32"} to {"typeIndex":7}`.
- **`WasmType` needed no new variant** -- reused the existing `{typeIndex: number}` union member (already
  there for closure-literal internals) instead of inventing a name-based `{ref:'ArrayBuffer'}` slot.
- **Referential-equality gotcha**: `ctx.local`/`ctx.declareLocal` compare a repeat declaration's `WasmType`
  by `!==` (object identity), not structurally -- a fresh `{ typeIndex: N }` literal at each call site (2
  calls to `new Uint8Array([...])` in one function, say) throws "redeclared with different type" even
  though the shapes are identical. Fixed by hoisting two module-level singletons, `ARRAYBUFFER_WTYPE`/
  `TYPEDARRAY_VIEW_WTYPE`, and using those everywhere instead of inline object literals -- required at
  every `ctx.local`/`ctx.declareValue` call site, not required (though harmless to still do, for
  consistency) at plain return-value positions.
- **Allocator**: lazy (`ensureMemory`, only declares `mod.memories`/a `$heapPtr` mutable i32 global if the
  program actually allocates), pure bump allocator with `memory.grow`-on-demand (no free -- this compiler
  targets whole-program batch runs, not long-running processes; freshly-grown pages are spec-guaranteed
  zero, so every allocation is zero-initialized for free, matching real JS's own `ArrayBuffer`/typed-array
  guarantee). `emitAlloc(ctx, pushSize)` is the shared primitive everything else builds on.

## Constructor forms (`case 'new'`), all 4 of real JS's

`new Uint8Array(n)` (fresh buffer), `new Uint8Array([...])` (fresh buffer, pre-filled, elements stored via
a real store loop -- no `array.new_fixed` equivalent for linear memory), `new Uint8Array(existingBuffer)`
(whole-buffer view, real aliasing), `new Uint8Array(buffer, byteOffset[, length])` (sub-view, real
aliasing) -- disambiguated at the `args[0]` level via `isArrayBufferExpr` (checks the real checker `Type`
name, same discipline as everything else here). `emitNewView`/`emitNewArrayBufferOfSize` are the shared
builders.

## Non-callback `Array<T>` methods lost by going standalone -- reimplemented once, shared across kinds

Going standalone meant `indexOf`/`lastIndexOf`/`includes`/`reverse`/`slice`/`fill`/`concat` (all tested
against `Uint8Array` in the existing suite -- initially missed, caused a real regression from 161->97
passing tests before being caught and fixed) no longer come free from `Array<T>`.

**First cut (reverted after user pushback): hand-built TS AST directly in towasm.ts.** Worked, but the
user pointed out this wasn't in the spirit of "share Array's *pattern*" -- these types have no real
class/interface declaration and no generics exist to write one canonical version the normal way, but
that's a reason to mirror `builtinOwner`'s own answer to the same problem (`Array<T>`'s `subs`-based type
substitution), not to bypass real source files entirely.

**Final design**: `lib/typedarray.ts`, real TS source, each method written once against `Uint8Array` as
the canonical instantiation (`typedArrayIndexOf(self: Uint8Array, x: number): number`, etc. -- algorithms
copied close to verbatim from `lib/array.ts`'s own `Array<T>` methods, including the same "large-sentinel
default clamped to length" trick for `slice`/`fill`'s omitted `start`/`end`, since a real default param
must still be a plain literal). `ensureTypedArrayMethod(kind, name)` in towasm.ts looks up the canonical
`FunctionDecl` via `LIB_DECL_MAP`, and for `Int32Array`/`Uint32Array` produces the per-kind variant via
`walk(canonical, undefined, onExpression, onType)`: substitute every `Uint8Array` identifier/ref-type
occurrence for the target kind -- both `self`/return type annotations (`onType`) *and* the
`new Uint8Array(...)` allocation calls inside `slice`/`concat` (`onExpression`, needed since these aren't
generic-type substitutions but literal-identifier ones). Then compiles exactly like `ensureFunc` does for
any ordinary top-level function (`ctx.declareParams`, `emitStmt` the real body, register/memoize per
`(kind, name)` in `funcs`) -- no synthetic AST, no new low-level codegen. Call-site dispatch got much
simpler too: since `slice`/`fill`'s optional params are now *real* default params on the lib declaration,
the ordinary `fillDefaultArgs` helper (same one every other call already uses) handles them -- no
per-method default-filling logic needed at the call site at all.

Checker.ts also needed a small, easy-to-miss fix: these methods' *return types* (`indexOf`->number,
`slice`->same kind, etc.) needed an explicit special-case at the top of the shared `case 'call': case
'new':` block (keyed off `TYPED_ARRAY_RANGES`), because `const b = a.slice(...)` (no annotation) needs
`checker.typeOf` to actually resolve a concrete type -- being merely *assignment-compatible* (the generic
`any` fallback) isn't enough for un-annotated inference, even though it silently "worked" for `subarray`
in isolation until tested this way.

**Unrelated bug this surfaced, not mine**: mid-refactor, `numFill` (and every other `Array<T>.fill`
caller) started failing with a wrong-arg-count error. Root cause: the user had independently added a new
`private static fill<T>(dst, dstStart, src, srcStart, len): void` (raw `array.fill $this` GC-instruction
wrapper) to `lib/array.ts`, right after `alloc`/`copy` -- same name as the real instance method
`fill(x, start?, end?)` further down. `builtinOwner`'s intrinsic scan keys `inlineMethods`/`asmMethodKeys`
by name only, so the static intrinsic silently shadowed the real method (`decl.body.filter(m =>
!asmMethodKeys.has(m.key))` excludes *both* same-named members, not just the matched one). Confirmed via
direct `builtinOwner` instrumentation, not guessing -- `owner.inlineMethods.keys()` for `Array<number>`
came back `['alloc', 'copy', 'fill']`. Fixed, at the user's direction, by renaming the new static helper
to `fillRange` (unused so far -- their own in-progress work, not wired up yet).

## `.subarray(start?, end?)`

Real *view* (no copy, no alloc) -- clamped/saturating indices via `emitClampU32` (i32 has no min/max
instruction; `select`'s `[val1, val2, cond] -> val1 if cond else val2` is the idiomatic substitute -- get
the val1/val2 push order backwards and the clamp silently inverts, see next section).

## Bugs found + fixed during this work

1. **`select` operand order backwards in the `end < start` saturation check** -- pushed `[end, start, ...,
   cond=(end<start)]` (so a *valid* end quietly got overwritten with `start`, making `subarray`'s length
   silently 0) instead of `[start, end, ..., cond]`. `emitClampU32`'s own two `select`s were correct (verified
   by manual trace) -- only this one inline site had it backwards. Caught by a standalone aliasing/`subarray`
   probe script, not the existing suite (which predates real aliasing and never exercised `subarray`'s length).
2. **Real `@isopodlabs/binary_libs` bug, fixed at source + rebuilt**: `I.select()` called with zero args
   still sets an `imm` *key* (value `undefined`) on the returned instruction object -- normal JS object-
   literal behavior, but the module's opcode discriminator checked `'imm' in v` (key presence) instead of
   whether it held a real value, so `I.select()` could never produce the plain `select` (0x1b) opcode; it
   always picked `select_t` (0x1c), which requires a real `ValType[]`, and the writer crashed on
   `undefined.length`. Fixed in `binary-libs/src/wasm.ts`'s discriminator (`'imm' in v && v.imm ? ... `),
   `npm run build` required after (source vs `dist/` resolution, see [[binary_api_friction_notes]]).

## Round 2: generalized away from towasm.ts, at the user's explicit request

User: "to the maximum extent possible I would like towasm.ts have no knowledge or special-casing of
typedArrays - it should all be defined by the lib source." Pushed further than round 1 -- structure
(fields/methods) already lived in lib source, but indexing (`a[i]`/`a[i]=v`) was still raw address
computation in towasm.ts, and `ArrayBuffer`/the view struct were hand-registered `registerType` calls with
hardcoded field-index constants, not real classes. Asked which to do; user picked the larger option: add
a genuinely new general mechanism (index syntax -> a class's own `get(i)`/`set(i,v)` methods) rather than
leave indexing as bespoke code.

**What's now fully generic (usable by any class, not typed-array-specific):**
- `scanInlineMethods` (extracted from `builtinOwner`'s scan loop) is now also wired into `ensureClass` --
  *any* class can write a method whose one statement forwards straight to `__asm(...)`, and towasm.ts
  splices it inline (no real `call`), not just the handful of specially-built-in owners (Array/String/...).
  This is what makes `Uint8Array.get`/`set` (raw `i32.load8_u`/`store8` via linear memory -- no ordinary TS
  syntax can express that) possible as *plain class methods*.
- `case 'index'`/`emitAssignTarget` in towasm.ts: `a[i]`/`a[i]=v` now dispatch to `classOf(obj).get`/`.set`
  generically (`methodSig` probes either an inline or real method's `{params,result}` uniformly, same
  "empty-args probe" trick `makeAsmBuiltin` already used for its own result-type check). Typed arrays are
  just the one user of this; any future class declaring `get`/`set` the same way gets the same sugar.
- `ArrayBuffer`/`Uint8Array`/`Int32Array`/`Uint32Array` are real classes (`lib/typedarray.ts`), resolved
  through the *ordinary* `ensureClass`/`plainLibClassNames` path -- no `builtinTypes` entries, no hardcoded
  struct-field-index constants (`ensureClass`'s own `fieldIndex` map is the only source of truth now).
  `.length`/`.buffer`/`.byteOffset`/`.byteLength` need zero special-casing in `case 'member'` -- they're
  just real fields, read through the same generic class-field path every other class already used.
  `indexOf`/`lastIndexOf`/`includes`/`reverse`/`slice`/`fill`/`concat`/`subarray` are real methods,
  dispatched through the ordinary `ownerOf`/`emitMethodCall` path -- no `ensureTypedArrayMethod` anymore.
- `i32`/`i64`/`f32`/`f64`/new `u32` pseudo-types (lib.d.ts) are now recognized directly in `builtinTypes`
  (`wasmTypeOf`'s very first check, ahead of `T.resolve`'s alias-unwrapping) -- previously only
  `makeAsmBuiltin`'s own separate `resolveType` recognized them (for `__asm<P,R>`'s type args specifically).
  Now a *plain class field* can be declared `i32`/`u32` too (`lib/typedarray.ts`'s own fields), not just an
  asm signature. (`makeAsmBuiltin`'s `resolveType` still needed its own matching `case 'u32'` added
  separately -- it's a genuinely different function, not reachable through `builtinTypes`.)

**What's still irreducible, and stayed in towasm.ts, deliberately:**
- The linear-memory allocator (`ensureMemory`/`emitAlloc`) -- no TS-source equivalent for "bump a global
  and `memory.grow`".
- `case 'new'`'s 4-form constructor dispatch (length / array-literal / whole-buffer / buffer+offset+length)
  -- inherently a *compile-time* overload resolution off the call site's static arg shape; this subset has
  no runtime `arguments.length`/`typeof` branching to express real overloaded constructors with one body.
- `TYPED_ARRAY_ALIASES`/`TYPED_ARRAY_ELEM_SIZE`: `Uint8Array` is the one canonical class declaration;
  `Int32Array`/`Uint32Array` are built by `ensureClass` walk-substituting its name (and, for `Uint32Array`,
  `i32`->`u32` in type positions) -- mirroring `builtinOwner`'s own `subs` substitution for `Array<T>`,
  just keyed off a literal name since there's no real generic type param here. This is the one piece of
  real typed-array-specific data left in towasm.ts, and it's small/centralized/data-only (see Round 3 for
  how `get`/`set`'s own byte-width difference stopped needing a separate mechanism at all).

## Bugs found this round

1. Forgot to actually wire `scanInlineMethods` into `ensureClass` on the first pass -- `get`/`set` fell
   through to real-method compilation (`ensureMethod`/`emitStmt`), which can't handle a bare `__asm(...)`
   call at all (`isAsm` is only ever consulted by the scan, not by ordinary `case 'call'` codegen) and threw
   `a 'void' function cannot return a value`.
2. `WasmType` representation mismatch: `classWtype` initially cached `{typeIndex: N}` for scratch locals,
   but `typeOf`'s own class-resolution path naturally produces `{ref: name}` elsewhere -- `wasmTypeEq`
   compares by variant key (`'ref' in a && 'ref' in b`, `'typeIndex' in a && ...`) and never unifies the
   two even for the same underlying class, so passing a freshly-`struct.new`'d value into ordinary
   coercion broke with `cannot convert {"typeIndex":10} to {"ref":"Uint8Array"}`. Fixed by caching
   `{ref: name}` instead -- referentially stable (same object reused per name, satisfying `ctx.local`'s
   `!==` guard) *and* structurally matches `typeOf`'s own output.
3. The walk-substitution for `Int32Array`/`Uint32Array` silently reused `Uint8Array`'s 1-byte
   `i32.load8_u`/`store8` asm text verbatim (substitution only touches AST nodes, never a string literal's
   *contents*) -- both kinds physically read/wrote a single byte instead of a 4-byte int, corrupting
   bigint arithmetic downstream (`bigint` *is* `Uint32Array`) with wrong-looking-but-plausible small
   numbers (`12345` -> `57`), not a crash -- the kind of bug that needs real execution to catch, a type
   checker has no way to see it. Fixed via the exact-string-match asm-text swap in point 3 above.
4. `isArrayBufferExpr` broke the moment `ArrayBuffer` became a real declared class: `T.resolve` previously
   left an *undeclared* name's `ref` type alone (nothing to expand it into), but once declared, `T.resolve`
   fully expands it into its structural object shape (`{offset: i32, byteLength: i32}` as an anonymous
   object type) -- the `t.type === 'ref' && t.name === 'ArrayBuffer'` check silently stopped matching.
   Fixed by checking `checker.typeOf(e, ctx.scope)`'s raw (un-resolved) type directly.

## Verification

Full suite: 161/161 (same stopping point as before this work -- the pre-existing, user's-own-in-progress
`PI_HALF`/`reducePi2` issue in `lib/number.ts`, unrelated). Real cross-view aliasing (writing through a
second view over `a.buffer` mutates `a`; writing through `a.subarray(...)` mutates `a`), `ArrayBuffer.
byteLength`, view `.byteOffset`/`.length` all separately verified via a standalone probe script (not part
of the checked-in suite) since the existing tests predate real aliasing and don't exercise it.

## Round 3 (2026-08-07, same day): replaced the exact-string asm-text swap with a real per-instantiation define

User's pushback on round 2's leftover `TYPED_ARRAY_ASM_GET_U8`/`_SET_U8`/`_GET_4B`/`_SET_4B` exact-string
swap: "if towasm.ts is manually cloning, that's an even more extreme special-casing" (than what it
replaced) -- fair, since matching raw asm-text *content* is fragile in a way the rest of the clone (pure
AST `ref`/`identifier` substitution) isn't. Then the reframing question that found the actual fix: "for
Array the typeIndex is passed as `$this` to inline assembly -- is that not enough?"

Investigated `WAT.parseAsmBody`'s `defines` mechanism (`examples/wat-parser.ts`): `$this` isn't special --
`makeAsmBuiltin` just passes `{'this': index}` into an arbitrary `{name: value}` map. Separately,
`(switch $key ...)` resolves its arm **immediately at parse time** whenever `$key` is already in `defines`
(`wat-parser.ts:491-503`) -- the deferred `__switch`-placeholder + `WAT.instantiateAsmBody` path (the
`$T`-generic mechanism `Math.floor` etc use, driven by a *call-site argument's* runtime type, restricted to
real wasm value types i32/i64/f32/f64) only exists for when the key *isn't* known yet at parse time. Typed
arrays' byte-width tag (`u8`/`i32`/`u32`) **is** known up front -- at the exact moment `$this`'s `index` is
known, i.e. whichever kind `ensureClass` is currently building -- so it belongs in `defines` too, not in
the deferred/argument-driven machinery. User explicitly confirmed no need to touch/extend that deferred
path for this ("I'd be happy to lose the string-substitution completely - the switch doesn't need it").

**Fix**: `lib/typedarray.ts`'s `get`/`set` now use `(switch $elem (($u8) ...i32.load8_u...) (($i32 $u32)
...i32.const 4 i32.mul...i32.load...))` -- one canonical asm string, reused verbatim by all three kinds
(`Uint8Array`/`Int32Array`/`Uint32Array` clones alike, since the walk-substitution never needs to touch it
at all anymore). `makeAsmBuiltin`/`scanInlineMethods` gained a new optional `elemDefine?: TypedArrayTag`
parameter threaded down to the `WAT.parseAsmBody(asm, {'this': index, elem: elemDefine})` call --
`TYPED_ARRAY_ALIASES` was extended from a plain name-alias table to `Record<string, {canonical, elem}>` so
`ensureClass` can pass the right tag per kind (including `Uint8Array` itself, `elem: 'u8'`, not just the
two aliased kinds). Zero changes to `WAT.instantiateAsmBody`/`isTypeGeneric`/the deferred `__switch` path.

Net effect: `TYPED_ARRAY_ASM_GET_U8`/`_SET_U8`/`_GET_4B`/`_SET_4B` deleted entirely -- no exact-string
matching left anywhere in towasm.ts for typed arrays. The only remaining typed-array-specific data is the
small `TYPED_ARRAY_ALIASES`/`TYPED_ARRAY_ELEM_SIZE` tables plus `case 'new'`'s compile-time constructor-
form dispatch (unrelated, already discussed as irreducible in round 2). 161/161 tests still pass; a fresh
10-check probe (buffer/subarray aliasing, cross-kind `indexOf`/`slice`/`reverse`/`fill`/`includes`/
`concat`, `ArrayBuffer.byteLength`, view `.byteOffset`, `Uint32Array` unsigned correctness) all passed.

**Lesson for next time**: when a "special case" mechanism (`$this`) already exists and works, check
whether the new problem is really just "one more entry in the same general mechanism" before reaching for
a new one (whole-decl cloning, deferred generic-asm machinery, etc) -- the smallest fix was hiding in a
parameter (`defines`) that already existed for an ostensibly-unrelated purpose.
