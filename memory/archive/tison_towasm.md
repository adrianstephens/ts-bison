---
name: tison-towasm
description: "examples/TS/towasm.ts (TStoWasm) -- TS-AST-to-wasm backend for a large and still-growing TS subset (wasm-GC classes w/ inheritance/generics/statics, real closures, generators, async/await, growable arrays, and more); emits a binary-libs wasm.WasmModule directly, no WAT text. The file's own top-of-file comment is the authoritative current gap list -- don't infer capabilities from this memory's history"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-03T18:19:17.553Z
  originSessionId: f04273b7-1564-4fa5-9495-83f91e965b72
---

## What it is

`tison/examples/TS/towasm.ts`, `export function TStoWasm(ast: TS.Program): wasm.WasmModule` (the `wasm.WasmModule` type is [[binary_wasm_module]], `@isopodlabs/binary_libs`'s own wasm reader/writer).

**STOP -- do not trust the capability description that used to be here.** This paragraph originally
(2026-07-27) described towasm.ts's very first, genuinely narrow subset -- "no generics/rest/default/
destructured params, no inheritance/static/getters-setters, no closures/`any`/async" -- and every single
item in that list was added over the following weeks (real generics, inheritance, statics, getters/
setters, closures, generators, async/await/Promise, growable arrays, and far more; see this file's own
dated sections below, chronological, oldest first). Re-summarizing "current capabilities" here each
session is a losing game -- it goes stale again immediately. **The one authoritative, current, exhaustive
list of what's actually unsupported is towasm.ts's own top-of-file comment** (read the real file, not this
memory) -- everything not listed there is fully supported, per that comment's own stated convention.
Similarly, don't trust any specific "N tests passing" count mentioned anywhere below as *current* --
each is a snapshot tied to its own dated section; check `test/test-towasm.ts`'s real line count or run the
suite for the actual current number.

Every unsupported construct throws (`towasm: ...`) rather than mis-emitting -- that part's still accurate
and permanent. Test: `tison/test/test-towasm.ts` -- compiles via `mod.toBytes()` and asserts on real
execution via Node's native `WebAssembly` (and, as of 2026-08-18, verified to also run correctly under a
real standalone runtime, `wasmtime` -- see that date's own section).

## Array/string/Uint8Array addition (2026-07-27)

Four concrete monomorphized wasm-GC array types, no generics/nesting: `number[]`/`Array<number>` (f64 elements), `boolean[]`/`Array<boolean>` (i32), `string` (packed i16, UTF-16 code units), `Uint8Array` (packed i8) -- all fixed-length (wasm-GC arrays can't resize). `WasmType` gained a 4th variant `{arr: 'f64'|'i32'|'i16'|'i8'}` alongside `'f64'|'i32'|{ref}`; a parallel `arrayTypeIndex` map (like `structTypeIndex`) is populated unconditionally for all 4 kinds up front in the index-space pass (keeps the existing clean "register everything, then build every body" two-phase structure -- no lazy mid-body registration, which would have required growing already-sized `mod.functionTypes`/`mod.code` arrays).

**In scope:** literals (`[1,2,3]`, string literals, no-interpolation template literals), `new Uint8Array(n)` / `new Uint8Array([...])`, indexing read+write (`arr[i]`/`arr[i]=x`) for `number[]`/`boolean[]`/`Uint8Array` **only** -- not `string`, see below), `.length` (all four, `array.len` + `f64.convert_i32_u`), string `+` concatenation (hand-built `__str_concat` helper: `array.new_default` sized to combined length + two `array.copy`s, function-index-space key `'#str_concat'`, always registered like the array types), `===`/`!==`/`==`/`!=` between two ref-typed operands (arrays/Uint8Array/**class instances**) lowering to `ref.eq` (incidental fix-forward: this path previously fell through to `f64.eq` regardless of operand type, already silently wrong for classes before arrays existed to expose the gap wider), classic `for` and `for...of` (desugared into synthetic `block`/`var_decl`/`while` AST nodes and handed back to `emitStmt` itself -- no new instruction-emission path).

**Deliberately dropped mid-implementation (plan said all 4 kinds indexable, revised after checking real semantics):** indexing (`arr[i]`) and `for...of` do **not** support `string` -- real JS `str[i]` returns a 1-character *string*, not a code unit, and building that correctly (fresh 1-element array alloc per read) wasn't worth it for this pass; `string` still gets literals/`.length`/`+`. Also: this checker's `'index'` case (`checker.ts`) only infers a proper indexed-element type for literal `T[]` -- indexing `Uint8Array`/`Array<T>` types as `any` there. Rather than rely on that, `arrayKindOf`+`indexElementType` compute the element type directly from the already-known wasm kind, used both for unannotated `const x = bytes[i]` (in the `var_decl` case) and for the `for...of` loop variable (which real TS syntax never lets you annotate anyway).

**Explicitly out of scope, noted as follow-up:** resizing methods (`push`/`pop`/etc. -- real growth needs a struct-wrapped vector with doubling, wasm-GC arrays alone can't resize), other Array/String methods, template-literal interpolation, array/string-typed class fields (same "no defaultable zero value for a non-null ref" restriction as class-typed fields already had), and passing/returning arrays/strings across the JS/wasm host boundary (no marshaling glue exists anywhere in tison/binary-libs for reading a wasm-GC ref back into a real JS value -- confirmed via research, still true after this change; every export still returns a plain number, matching the pre-existing contract).

Hidden desugaring temp names use a `#`-prefix (`` `#for${n}$arr` ``, and the `'#str_concat'` function key) -- `#` can never start a real parseable local/function name (only valid as `this.#field`), so no collision detection is needed, same trick as `ctorKey`/`methodKey`'s `#` separator.

## Lazy/worklist-driven registration (2026-07-27, later same day)

Replaced the eager "register every function/class signature+index up front, then build every body"
two-pass structure with on-demand registration: `ensureFunc(name)`/`ensureClass(name)` (in `TStoWasm`,
"Program lowering" section) register a signature+function-index (and, for classes, struct type +
ctor/method indices) *the first time something reachable actually calls/constructs it*, then push its
body onto a `worklist` queue instead of building it inline. Seeded with every exported (`ast.body`)
function; drained after seeding. `__str_concat` gets its own `ensureStrConcat()` (simpler: it's
hand-built `wasm.Instr`, never calls anything else, so no need to queue it -- builds immediately).
Array-kind types (`ARRAY_KINDS`) stay eagerly/unconditionally registered -- just 4 fixed entries, not
worth the complexity. Confirmed via `mod.code!.length`: a trivial program now compiles to 1 function
(not ~39 -- the whole always-included prelude, previously baked into every module regardless of use);
one `array.indexOf` call pulls in exactly 2.

Design conversation before implementing (worth remembering the reasoning, not just the result): the
worry was mutual recursion needing 3-state visited-tracking, but that's wrong -- registering a
signature only reads a function's *declared* param/return types (never its body), so it's inherently
non-recursive and safe to memoize with a single check (`funcIndex.has`/`info.ctor` truthy). What
actually needs deferring is *body-building* (which does recurse through `emitStmt`/`emitExpr`, which is
what discovers further callees) -- hence a worklist: register+enqueue on discovery, drain later, no
stack-depth-tied-to-call-graph risk, no ordering coupling between "discovered" and "built".

Real behavior change, deliberately chosen (user picked "pure laziness" over "validate everything, emit
only what's reachable" when asked): an unreachable function/class with a genuine bug (e.g. missing
return type, missing constructor) no longer throws at compile time -- it's simply never processed.
Only code actually reached from an exported function gets validated at all now.

Classes still need their *names* reserved eagerly for all classes (cheap, name-only, unchanged from the
old two-pass rationale) -- a method's own signature can reference a not-yet-`ensureClass`'d sibling
class by name, and `T.isRefOf`/`classes.has()` only needs the key to exist, not the full resolved
`ClassInfo` -- so this doesn't reintroduce the eager-everything problem, just keeps the one genuinely
cheap part eager while the expensive part (field/method resolution, struct type, body-building) is lazy.

This session also fixed two bugs surfaced while chasing this down, both the user's own in-progress
edits, not this refactor's fault: (1) a missing-braces bug in the `ARRAY_KINDS` registration loop that
silently dropped the `f64` array type and collided its index with `i32` (`if (types.length !=
ARRAY_KINDS[kind])` had no braces, so the comment lines in between made the real gated statement --
`types.push(...)` -- look unconditional); (2) the new `builtins` dispatch table (replacing the old
hand-written `__towasm_str_alloc`/`__towasm_str_setChar`/etc. intrinsic cases) double-applied
`i32.trunc_f64_s` to `i32`-typed args, since the generic per-arg conversion loop and each entry's own
hardcoded `body` both independently truncated -- fixed by dropping the now-redundant leading trunc from
each `body`, and also corrected `result: { ref: 'i16' }` (wrong shape, `ref` means "class named X") to
`{ arr: '<own kind>' }` on all five entries (dead/unused today, but wrong data left as a landmine).
Also chased what looked like a `binary-libs` two-armed-`if` encoding bug down to a real one (confirmed
via a from-scratch raw `wasm.WasmModule` repro bypassing `towasm.ts` entirely) -- the user fixed it
directly in `binary-libs/src/wasm.ts` (0x04 'if' now reuses `Block`'s own read-until-`end_block` +
split-on-`else_marker` scheme instead of a separate hand-rolled reader) while this was in progress.

## Transient-`i32` values + real bitwise/shift ops (2026-07-28)

Follow-on design conversation (starting from "what happens with `a[i] = a[1] + 1` on a `Uint8Array`")
led to: no persistent integer TS type (rejected as "imposing an artificial rule" -- there's no clean way
to *declare* something is an integer here), but `emitExpr` now returns the actual `WasmType` it left on
the stack, which can be narrower than what `wasmTypeOf` would say for `e`'s static TS type. Concretely:
`Uint8Array` reads (`array.get_u`) and `charCodeAt` stay `i32` instead of eagerly `f64.convert_i32_u`-
widening; new `emitAs(e, ctx, want)` emits then converts only if what came back doesn't already match
`want` (`f64`->`i32` via the *saturating* `i32.trunc_sat_f64_s`, not the trapping `i32.trunc_f64_s` used
elsewhere for index/length truncation -- clamps `NaN`/out-of-range instead of crashing the whole module,
which is what a `Uint8Array` write used to do for those inputs; doesn't replicate JS's true modulo-2^32
`ToInt32` wraparound for huge finite floats, a known accepted gap). Every consumer that needs a specific
representation (arithmetic/comparison operands, assignment targets, call arguments, `return`) now goes
through `emitAs` instead of raw `emitExpr` -- this turned into a real sweep (function-call args, method-
call args, ctor args, `local.set`/`struct.set`/`array.set` targets, `return` needed a new `FuncCtx.result`
field it didn't have before). Real bitwise/shift operators added for the first time (`&`/`|`/`^`/`<<`/
`>>`/`>>>`/unary `~`) -- i32-native regardless of operand's declared type (matches JS's `ToInt32`-then-op
semantics), returning `i32` untouched rather than eagerly widening back, so a chain like
`(a[0] << 4) | a[1]` (both `Uint8Array` reads) does zero `f64` round-trips.

Also folded `MATH_INTRINSICS` (previously its own hand-written dispatch branch) into the same `builtins`
table the `__towasm_*` alloc/setChar intrinsics already used, keyed `'Math.sqrt'` etc. -- one shared
`emitBuiltinCall` helper now handles both entry points (`Math.foo(...)` member calls and bare
`__towasm_*` identifier calls), each arg coerced via `emitAs` to its declared param type first.

Editing note: mid-refactor, large multi-hundred-line `Edit` calls against this file kept failing to
match even byte-identical `old_string` content (confirmed via `od -c`, not a whitespace issue) --
splitting into smaller edits (or `sed -i` for pure deletions) worked every time. Unclear root cause;
worth defaulting to smaller edits on this file rather than re-diagnosing it again next time.

## Non-callback String/Array/Uint8Array method prelude (2026-07-27)

`map`/`filter`/`reduce`/`forEach`/`some`/`every`/`sort` still unsupported (need closures/first-class
functions -- towasm has no `call_ref`/`call_indirect` at all, separate larger prerequisite). Everything
else (`indexOf`/`lastIndexOf`/`includes`/`slice`/`reverse`/`concat`/`fill` on `number[]`/`boolean[]`/
`Uint8Array`; `indexOf`/`lastIndexOf`/`includes`/`startsWith`/`endsWith`/`slice`/`trim`/`toUpperCase`/
`toLowerCase`/`repeat`/`concat`/`charAt`/`charCodeAt` on `string`) is implemented as a **self-hosted
prelude**: ordinary TS source (`PRELUDE_SRC` + the method/arity tables, all in the new sibling file
`examples/TS/towasm-prelude.ts` -- split out on request so the "library" reads as its own thing, one
parameterized template for the 3 numeric/byte kinds + a hand-written `string` section) parsed once per
`TStoWasm` call and folded into the same function-index-space/body-building passes as the user's own
top-level functions (`allFuncBody = [...TS.make().parse(PRELUDE_SRC).body, ...ast.body]`, used everywhere
except the exports loop, which stays `ast.body`-only). No second `TStypeCheck`/`Scope` needed for the prelude -- `wasmTypeOf`'s
`T.resolve(global,...)` only ever resolves bare primitive/array/`Uint8Array` types there, which is a
no-op regardless of which top-level `Scope` object is passed in (primitives short-circuit; `Uint8Array`/
`Array` aren't declared in *either* scope) -- confirmed via research before implementing, not assumed.

Two gaps plain TS source can't express, filled by ~7 small hand-built intrinsics (same style as
`Math.*`/`__str_concat`): allocating a fresh zero-filled buffer of *runtime-computed* length for the
three kinds that don't have `Uint8Array`'s `new Uint8Array(n)` equivalent (`__towasm_str_alloc`/
`__towasm_arr_f64_alloc`/`__towasm_arr_i32_alloc`, bare-call dispatch), and writing into a `string`
buffer element-by-element since `arr[i]=x` is deliberately rejected for `string` at the language level
(`__towasm_str_setChar`, ditto) -- plus `charAt`/`charCodeAt` themselves as 2-3 instruction member-call
intrinsics (also finally the idiomatic way to read a string character, instead of reopening bracket
indexing on `string`, which real JS gives different semantics than a code-unit array anyway).

Key gotcha found by testing (not review, again): confirmed via research first that `TStypeCheck` does
**zero argument validation** on any `string`/`Uint8Array` method call at all (both are `ref` types, never
`T.sealed()`'s `'object', so even a fictitious method with wrong arity passes as `any`) -- so towasm's own
dispatch code validates arg counts itself. Separately: an *unannotated* `const b = a.slice(...)` failed
with "unsupported type" the same way the earlier Uint8Array-index gap did, because `checker.typeOf` on
*any* method call is `any` too -- fixed the same way ([[tison_towasm]]'s existing `indexElementType`
pattern), via a new `methodResultType(kind, methodName)` that answers from the already-known dispatch
table instead of asking the checker. Also found (via the `boolean[]`/`Uint8Array` method bodies actually
exercising `arr[i] === x` for the first time): `===`/`==` between two booleans was already silently wrong
before any of this array work existed -- `BINARY_INSTR` unconditionally mapped it to `f64.eq`, but
booleans are `i32` on the stack; nothing in the pre-existing test suite ever compared two booleans with
`===` to expose it. Fixed alongside (checks for `kind === 'i32'` first, emits `i32.eq`/`i32.ne`).

**Emits a structured `wasm.WasmModule` directly, not WAT text.** Original spike went through WAT text + an external assembler (first `wabt`, then `binaryen` -- see below for why both were rejected in turn); once `@isopodlabs/binary_libs/wasm` existed as a first-party writer, the natural conclusion was to skip the text stage entirely -- this subset's instruction set is fully self-controlled (never parses arbitrary external wasm), so there was never a real need for a *parser*, only an assembler, and now that's in-house too. `emitExpr`/`emitStmt` build `wasm.Instr[]` arrays directly (nested for block/loop/if bodies) instead of pushing indented text lines -- locals/labels/fields are referenced by plain numeric index throughout (the binary format has no symbol table), not `$name`. This deleted the whole `Emitter` class (indent/fork/absorb/region/ifElse text machinery) and the per-`while` label-id counter (`ctx.nextLabel`) -- structural nesting alone gives correct branch depths, no generated names needed at all.

One new bit of bookkeeping this required: every constructor/method/top-level function shares *one* flat function index space (a binary-format requirement, not a design choice) -- assigned in one pass after `collectSigs`/`collectClasses` (struct types first, then one func-type + one function index per ctor/method/function, in that order), so every body-builder can just look its callees up by name instead of computing anything.

## Classes, via wasm-GC (unchanged reasoning from the WAT-text version)

Each class -> one wasm-GC `struct` type (all fields `mut`) + one function per constructor/method with `this` as an explicit first param. No inheritance means every call site's target class is statically known -- always a plain direct `call`, never `call_ref`/`ref.cast`. A constructor lowers to `Class_new(...) -> (ref $Class)`: `struct.new_default` (zero-init) into a `this` local, run the constructor body as ordinary statements (`this.field = x` -> `struct.set`), return `this`. This is *why* fields are restricted to `number`/`boolean` only, never another class: a non-null `(ref $Other)` field has no zero value `struct.new_default` could fill it with (object-typed *params*/*returns* are fine, just not *fields*).

Two-pass class collection was necessary, not just tidy: a method's own signature can reference its enclosing class by name (`distanceTo(other: Point): number` inside `Point`), so `wasmTypeOf` needs every class *name* registered (pass 1: empty placeholders) before any class's fields/methods/constructor are actually type-checked (pass 2: fills each in for real) -- unlike top-level functions, where only *calls* need to be forward-resolved, not the signature shape itself.

`struct.set` (unlike `local.tee`) has no variant that also leaves the assigned value on the stack, so field assignment (`obj.field = expr`) couldn't keep `emitExpr`'s "every case leaves exactly one value" invariant the way identifier assignment does. Fixed by splitting assignment lowering into a dedicated `emitAssign`, called directly from the `expression`-statement case -- field assignment is statement-only in this slice (throws if nested as a sub-expression); identifier assignment still works both ways (`local.set` at statement level via `emitAssign`, `local.tee` when nested via `emitExpr`).

## `/simplify` cleanup pass (2026-07-28)

User asked for a redundancy/simplification pass once the array/string/prelude/transient-i32 work above
was all working end-to-end (78 checks passing). Ran the standard 4-parallel-agent `/simplify` review
(reuse/simplification/efficiency/altitude) against full file content (untracked, no git diff baseline),
applied a curated low-risk subset directly, tested after each: deleted dead code (commented dispatch
block, stale toggle comment, stale two-pass file-header description rewritten for the current lazy
design); removed the `arrayTypeIndex` Map (exact duplicate of `ARRAY_KINDS`, replaced ~8 call sites with
direct `ARRAY_KINDS[kind]` reads); dropped the dead `key` param from `registerFunc` + now-unused
`ctorKey`/`methodKey`; unified `classOf`/`arrayKindOf` on a shared `wtypeOf` helper; merged `emitExpr`'s
`'identifier'`/`'this'` cases; collapsed `emitBuiltinCall`'s 3-shape `Builtin` union (dropped the
`JS.FunctionDecl<Type>` branch that duplicated `ensureFunc`, and the `...PRELUDE_AST` spread into
`builtins`) down to 2 shapes, falling back to `ensureFunc(name)` internally when a name isn't a
hand-built entry -- this let the plain-identifier call site in `emitExpr` collapse from its own
`if (name in builtins) ... else ensureFunc(...)` branching to just always calling `emitBuiltinCall`;
added `FuncCtx.declareValue` (declare + `scope.addValue` in one call, used at all 3 sites that needed
both); merged `classDeclByName` into the `classes` placeholder map (`ClassInfo` now carries its own
`decl`, reserved at the same eager-name-reservation point classes were already reserved at); made
`MethodInfo extends FuncInfo` (was a hand-duplicated near-identical interface); extracted
`emitArrayElements` (hole/spread-rejection + per-element `emitAs` + `array.new_fixed`), shared by the
`[1,2,3]` array-literal case and `new Uint8Array([...])`'s literal-argument form (previously duplicated
almost verbatim with a different error message on the Uint8Array side -- unified, no test depended on
the old wording).

Deliberately skipped (noted, not applied): full `funcs`+`classes` registry unification; a 5-way
`resolveCallee`/`emitCall` dispatch unification across `new`/array-string-method/class-method/plain-
function/builtin call sites (too large a restructure for one pass); reusing `type-utils.ts`'s private
`normalizeArray`/`arrayLikeElement`/`arrayMethod` (would need new cross-file exports); collapsing
`towasm-prelude.ts`'s `ARRAY_METHODS`/`STRING_METHODS`/`METHOD_ARITY` tables into data derived straight
from `PRELUDE_AST`; removing `METHOD_ARITY`'s up-front arity check even though it's technically
redundant with each dispatch site's own count check -- kept deliberately, it gives a clearer error
message than letting a wrong-arity call fall through to a generic one; table-driving
`test-towasm.ts`'s near-duplicate `num*`/`bool*`/`u8*` test blocks. All fixes applied cleanly, no
regressions -- `tsc --noEmit` clean, all 78 `test-towasm.ts` checks still pass after every step, eslint
shows only pre-existing single-use-local/unused-var warnings unrelated to this pass's edits.

**Partially reverted same day, per explicit user preference:** user wanted `PRELUDE_AST` routed back
through `builtins` rather than spliced into `ast.body`/`ensureFunc`'s user-declared-function path --
keeps the prelude conceptually separate from the user's own program (`ast.body` is user-only again).
`Builtin` is back to its original 3-shape union (`JS.FunctionDecl<Type> | {sig,inline} | {sig}&FuncBody`),
`builtins` again spreads `PRELUDE_AST`'s `function_decl`s in by name, and `emitBuiltinCall` branches on
which of the 3 shapes it got (inline / hand-built `FuncBody` like `#str_concat` / prelude `decl`, the
last two registering+queuing like `ensureFunc` does) -- only falling back to `ensureFunc` itself for
names not in `builtins` at all (plain user functions). The `allFuncBody = [...PRELUDE_AST, ...ast.body]`
splice and its use in the `functionDeclByName` loop were removed; that loop is `ast.body`-only again, so
`ensureFunc`/`functionDeclByName` never sees prelude names -- they're only ever reachable through
`builtins`. Net effect kept from the `/simplify` pass: still one shared `emitBuiltinCall` dispatch point
(not three separate call-sites), still no duplicate arity/coercion logic between prelude and hand-built
entries.

## "Builtin-class" unification for array/string methods (2026-07-28, later same day)

User's idea, explored via discussion before implementing: instead of dispatching array/string methods
through mangled flat-namespace `builtins` names (`str_indexOf`, `arrF64_slice`, computed via string-
templating at every call site), generalize the *existing* class-method machinery so `this` doesn't have
to be a wasm-GC struct. New `MethodOwner` interface (`name`, `thisType: WasmType`, `thisTsType: Type`,
`methodDecls`, `methods`, optional `inlineMethods`) factors out everything `ensureMethod` actually needed
from `ClassInfo` -- turned out to be *only* two things: computing `this`'s `wasm.ValType` (already unified
across struct/array via the existing `toValType`) and declaring `this`'s TS type for the checker. Real
classes: `ClassInfo extends MethodOwner`, `thisType`/`thisTsType` set once at eager name-reservation time
(`{ref: name}`/`TS.RefType(name)}`, no lazy resolution needed -- unlike `structTypeIndex`, this never
depended on fields being resolved). Four new *builtin-class* `MethodOwner`s (`arrayBoxOwners`, one per
array kind, `this: {arr: kind}`) sit alongside `classes` but are never registered there and never touch
`structTypeIndex` -- no fields, no constructor (`new Uint8Array(n)` stays separately special-cased).

towasm-prelude.ts rewritten to match: each kind's methods are now a real TS `class` (`ArrF64Box`/
`ArrI32Box`/`ArrI8Box`/`StringBox`) using real implicit `this` (`this.length`, `this[i]`, `this.charCodeAt(i)`,
sibling calls like `this.indexOf(...)`) instead of an explicit first parameter -- TS's own per-class
method namespacing means `indexOf`/`slice`/etc. never need a kind-prefix at all; the mangled names are
gone. `strIsSpace` (an internal helper, not a JS-visible method) stays a plain top-level function outside
any class, still dispatched through the ordinary `emitBuiltinCall`/`ensureFunc` bare-identifier path.
`str_charAt`/`str_charCodeAt` (can't be TS source -- string indexing is rejected at the language level
even inside `StringBox`'s own methods) moved from flat `builtins` entries to `arrayBoxOwners.i16.inlineMethods`,
a new optional `MethodOwner` field checked before `methodDecls`/`ensureMethod`, splicing instructions
directly into the caller with no `call` -- exactly parallel to `emitBuiltinCall`'s own inline-vs-decl split.

New shared `emitMethodCall(owner, name, receiver, args, ctx)` replaces both the old mangled-name array/
string dispatch *and* the separate class-method dispatch code in `emitExpr`'s `'call'` case -- now just
`ownerOf(obj, ctx)` (new: `wtypeOf` -> `ensureClass` for a `ref`, or `arrayBoxOwners[kind]` for an `arr`)
then one `emitMethodCall` call, for either kind of receiver. The `+` string-concat operator lowering also
now goes through `emitMethodCall(arrayBoxOwners.i16, 'concat', ...)` instead of a separate flat-name
`emitBuiltinCall('str_concat', ...)`. Net effect verified empirically (not just type-checked): lazy
per-method registration still holds (an unreached array method still gets no funcIndex/body); arity
mismatches now report the real method name with the correct count (no more `-1`-adjustment hack, since
`FuncSig.params` never included `this` in the first place); "unsupported method" errors got strictly
better (`unknown method 'push' on number[]` vs the old generic "...on array"). All 89 tests
(`test-towasm.ts`) pass unchanged in behavior; `classOf`/`arrayKindOf` still exist separately for field
access/`.length`/indexing/`for...of`/equality-kind-checking, since arrays have no fields and `ownerOf` is
specifically for method-call dispatch.

## Toolchain arc: wabt (no GC) -> binaryen (200x oversized) -> first-party writer

`wabt`'s published npm build has GC compiled *out* entirely (checked directly: `(await wabt()).FEATURES.gc === false`, true even on nightly builds) -- `struct.*`/`(ref $Name)` just fail to parse. Switched to `binaryen` (what AssemblyScript itself uses) -- worked, but needed an ESM-interop workaround (`binaryen` is pure ESM with top-level await; `new Function('s','return import(s)')` forces a real dynamic `import()` bypassing ts-node's CJS rewrite). That worked fine functionally, but the user flagged the actual concern: `binaryen`'s `node_modules` footprint is ~93MB (80MB of unused native CLI binaries, 13MB JS entry) against tison's own ~480KB source -- and it was tison's *first* dependency ever. Confirmed Node's own `WebAssembly.Module` already validates/runs wasm-GC binaries natively with zero flags, meaning `binaryen`/`wabt` were only ever doing the *text-to-binary* step -- which motivated building [[binary_wasm_module]] instead: a real WASM reader/writer as a new format in the user's own `binary-libs` collection, using their `binary` package's declarative spec system. `towasm.ts` now targets that directly; `binaryen` is gone from `tison`'s dependencies (replaced with `@isopodlabs/binary_libs`, linked locally via `npm link`).

## checker.ts integration pattern (unchanged)

Contract matches `TStoJS`/`TStoDecl`: **assumes `ast` already passed `TStypeCheck`/`TStypeCheckAsync`** -- throws immediately if `ast.scope` isn't populated. Uses `makeChecker(()=>{})` purely for its `typeOf(expr, scope)` -- never calls `.checkBlock`. Only two call sites need real inference (an unannotated local's initializer type, a conditional's combined result type); everywhere else (which wasm instruction an operator/call lowers to) is syntax-determined once input is known to type-check.

Gotcha: a conditional's real combined type via `checker.typeOf` is a structural union (`true | boolean`), not a bare `boolean` ref -- `T.combineTypes` dedupes by printed form, not subsumption. Must `T.widenLiterals` before the `isBoolean`/`isRefOf` check. Folded into `wasmTypeOf` itself.

## `ast.scope` stamp -- now on sync `TStypeCheck` too

Building `TStoWasm` surfaced that `TStypeCheckAsync` already stamps its fully-checked scope onto `program.scope`, but sync `TStypeCheck` never did. Fixed: sync `TStypeCheck` (transform.ts) now also does `ast.scope = global` before returning, mirroring the async version.

**Then tried applying the same "reuse `ast.scope`, drop the redundant `checkBlock`" simplification to `TStoDecl` -- reverted, real regression found** (see [[tison_readtype_resolution]]'s note: `PE.ReadDirectory` overload return types collapsed to `any`). `TStoDecl`'s own `checkBlock` pass is load-bearing there, not just redundant. `TStoWasm`'s own use of the stamp is unaffected -- its subset has no classes/overloads to trigger whatever that dependency actually is.

## Major rework (2026-07-31): real lib source, MethodOwner/funcs unification, Uint8Array=Array<T>, walker-based substitution

Supersedes several `2026-07-28` sections above (the old `towasm-prelude.ts` file, `arrayBoxOwners`,
`methods` maps, `{ref:name}`-guessed `thisType` are all gone). Same-day continuation of the
`declare Array<T>`/`Uint8Array`/BigInt/Number work the user originally tried scheduling as a cloud
routine (see [[tison_cloud_agent_deps]]) then did locally instead after the routine produced nothing.

- **`towasm-lib.ts`** replaced `towasm-prelude.ts` entirely: real top-level `class`/`function` TS source
  (not a string-generating file), read via `fs.readFileSync`+`TS.parse` (`LIB_AST`, near the top of
  `towasm.ts`), never `import`ed as a module -- deliberately excluded from `test/tsconfig.json` and
  `eslint.config.mjs` since it isn't standalone-valid TS (`Array<T>`'s `T` is never really bound). `export`
  on a decl marks it as user-reachable (`LIB_EXPORTED`); unexported helpers (`strIsSpace`/`bigTrim`) stay
  callable only from *other* lib functions via a fallback in `emitCall`.
- **`MethodOwner` lost both `.methods` and `.thisType`.** Compiled methods live in the same per-compilation
  `funcs: Map<string,FuncInfo>` plain top-level functions use, keyed `${owner.name}.${name}` (bare JS
  identifiers can't contain `.`, so no collision risk) -- this let `builtinOwners` become a plain
  **module-level singleton** instead of rebuilt per `TStoWasm` call. `thisType` (`WasmType`) is derived on
  demand from `thisTsType` (`Type`, the only stored fact) via a new `ownerThisType()` helper -- a real bug
  was found and fixed where the separately-stored `thisType` drifted from `thisTsType` (`builtinClasses`
  uniformly seeded every builtin owner with `{ref: name}`, wrong for anything but a real struct class; it
  broke `String.concat`'s `this` invisibly, since the *checker*-inference path had its own separate correct
  fallback (`FIXED_BOX_KIND`) papering over it -- only the real codegen path was actually broken).
- **`Uint8Array` is no longer a separate class in `towasm-lib.ts`.** It's `Array<T>`'s shared decls
  monomorphized for `elemKind:'i8'`, exactly like `Array<number>`/`Array<boolean>` -- one `builtinOwner()`
  call per instantiation, `substElemMethods` handles the substitution. `Array<number>`/`Array<boolean>`
  previously shared the *same* owner `.name` (`'Array'`) before this pass, a real second bug (funcs-map
  key collision -- one instantiation would've silently reused the other's wrongly-typed compiled method,
  never actually triggered since nothing exercised both in one compile before this session).
- **`substElem`/`substElemMethods` (the `T`→concrete-type substitution for `Array<T>`) now uses
  `examples/TS/walker.ts`'s general `walk()`** instead of hand-matching two syntactic shapes (bare `T`,
  `T[]`) -- `walk` already knows how to recurse through every `Type`/`Statement` variant, so a shape it
  doesn't special-case just passes through structurally instead of silently keeping an unresolved `T`.
  Substitutes a method's params/returnType *and whole body* (nested var_decls included) once, up front,
  at `builtinOwners`-construction time -- this let `emitStmt`'s `var_decl` case drop all `Array<T>`-aware
  logic entirely (it used to dynamically re-derive `elemKind` from `ctx.locals.get('this')` on every local
  declaration in the entire program, not just inside `Array<T>` methods). The type param's name is read
  from `Array<T>`'s real `typeParams[0].name` in the AST, not assumed to be the literal string `'T'`.
  `ARRAY_ELEM_TYPES: Record<'f64'|'i32'|'i8', {elem,container}>` is the one place stating what `T`/`T[]`
  resolve to per instantiation -- `i8`'s `container` is the nominal `Uint8Array` ref (not `number[]`; real
  JS's `Uint8Array` isn't structurally `number[]` even though elements read back as plain `number`), so
  `substElem`'s walk callback still needs to intercept the whole `T[]` shape before recursing into it,
  not just the leaf `T` ref -- naive leaf-only substitution would produce `number[]` for `i8` too.
- **`emitExpr` gained a real `'as'` case**: `case 'as': return emitExpr(e.expression, ctx);` -- a genuine
  no-op, matching that TS casts are compile-time-only in real TS too. Lets `Array<T>.fill()`'s
  `return this as unknown as T[];` compile as literally written, no `@ts-ignore` workaround needed.
- **Partial `BigInt`** (unsigned, base-65536 limb arithmetic over a new `Int32Array` type -- reuses the
  existing `i32` wasm array kind verbatim, no 5th array kind invented): `bigFromNumber`/`bigToNumber`/
  `bigCompare`/`bigAdd` only, no sub/mul/div. Plain functions, not a class -- `ensureClass`'s field check
  requires `number`/`boolean` fields only, no zero value to default-init a non-null array ref field with.
  Partial `Number.isInteger`/`isNaN`/`sign` too, dispatched via a small `NUMBER_STATIC` alias map (a bare
  function can't literally be named `Number.isInteger`).
- **Debugging lesson**: mid-session, `towasm.ts`'s content appeared to change out from under active edits
  (`builtinOwners` shape, owner `.name`s) with no corresponding tool call. Root cause was mundane, not a
  bug or a rogue process: the user was hand-editing the same file live in the same VSCode window. `ps aux`
  showing multiple `claude` CLI processes against the same `--add-dir` was a red herring (leftover/orphaned
  processes from an earlier session reconnect after a Mac reboot, unrelated) -- don't over-index on process
  lists when a file's content shifts unexpectedly; ask the user first, they may just be editing it too.
- Verification pattern used throughout: `npx tsc -p test/tsconfig.json --noEmit | grep -i towasm` (expect
  empty), `ts-node test/test-towasm.ts` (expect "all towasm tests passed", `grep -iE "^FAIL|not ok"`
  empty), `npx eslint examples/TS/towasm.ts test/test-towasm.ts` (stable baseline: 7 single-use-local
  warnings in towasm.ts + 4 in test-towasm.ts, 0 errors -- any new warning/error is a real regression).

## WasmType->Type reverse-mapping fix + real `bigint`/`BigInt` support (2026-07-31, later same day)

Supersedes this file's own "Partial `BigInt`" bullet above (free `bigCompare`/`bigAdd` functions over
`Int32Array` are gone). User's own architectural observation drove this: "just because something is a
`{arr:'i32'}` on the runtime stack shouldn't dictate that it is an `Array<boolean>`" -- correctly spotted
that `ownerOf`/`declTypeOf` were reverse-decoding an already-collapsed `WasmType` back into a `Type`/
`MethodOwner`, which is lossy the moment two distinct TS types share one physical representation
(`Int32Array` and `boolean[]` already both compiled to `{arr:'i32'}` -- a real latent bug: nothing had
ever called a method on an `Int32Array`-typed value yet, but the moment something did, it would've
silently gotten `Array<boolean>`'s methods).

**The fix, general, not bigint-specific:** never reverse-map `WasmType -> Type/Owner`. Only ever map
`Type -> WasmType` forward (a legitimate many-to-one narrowing -- that's just what compiling to a smaller
runtime representation means). Concretely:
- `FIXED_BOX_KIND` (name -> `WasmType`) became **`FIXED_BOX`** (name -> `{wtype, owner?}`), one table
  instead of two, so a representation and its owner can't drift apart independently.
- New `ownerFor(t: Type): MethodOwner | undefined` mirrors `wasmTypeOf`'s own name-based switch structure
  but returns the `MethodOwner` directly from the `Type`'s name, instead of `ownerOf` deriving a `WasmType`
  first and then guessing an owner back from it. `ownerOf(e, ctx)` is now just
  `ownerFor(checker.typeOf(e, ctx.scope))`.
- `declTypeOf` (`WasmType -> Type` reverse guess) is **deleted entirely**. `methodCallResult` now reads a
  method's real declared return `Type` straight off its decl (`owner.methodDecls.get(name)?.returnType`)
  instead of reverse-mapping its compiled `WasmType` result. The two hand-built `inlineMethods`
  (`String.charCodeAt`/`charAt`, no real decl to read a return type from) carry an explicit
  `resultTsType: Type` field alongside their `WasmType` result for the same reason.
- Same anti-pattern, found a second place: `emitStmt`'s `var_decl` case was guessing an indexed read's
  element type as `T.BOOLEAN` for *any* `i32`-kind array (`indexKind === 'i32' ? T.BOOLEAN : T.NUMBER`) --
  wrong for a real `Int32Array`/`Uint32Array` read (elements are `number`). Replaced with `elementTypeOf(t:
  Type)`, which derives the real element type from the indexed object's actual static `Type` (same
  name-based switch shape as `ownerFor`/`wasmTypeOf`), not its physical kind.
- Net effect: nothing in the compiler infers TS-level identity from a runtime `WasmType` tag anymore.

**Real `bigint`/`class BigInt` built on top of this fix**, per explicit user request ("define a class
BigInt in towasm-lib.ts, which would implement all the BigInt methods and operators") plus a critical
correction mid-design: real TS's `bigint` is a genuine, deliberately-supported primitive in the shared
checker (`T.BIGINT`, `T.isBigint`, real `+`/comparison support in `checker.ts`) -- not the `Int32Array`-
typed workaround originally sketched, and not the sync-checker "unresolved name: lenient" leniency found
(and explicitly flagged by the user as non-representative of real, fully-checked code) earlier in this
investigation.
- `bigint`'s `FIXED_BOX` entry: `{ wtype: { arr: 'i32' }, owner: BigIntOwner }` -- physically identical
  storage to `Int32Array`/`Uint32Array`/`boolean[]`'s `{arr:'i32'}`, but zero ambiguity risk now that
  ownership is resolved by `Type` name (`ownerFor`), never by reverse-decoding the shared tag.
- `class BigInt` in towasm-lib.ts (real methods, not free functions): `add(b): bigint`, `compare(b):
  number` (-1/0/1 by magnitude), plus `lt`/`gt`/`le`/`ge`/`eq`/`ne` (each a one-line wrapper around
  `compare`, since real `bigint` has no `.compare()` surface of its own -- only operators). `bigFromNumber`/
  `bigToNumber` stay free functions (real bigint has no `.fromNumber`/`.toNumber` either).
- **Operator wiring**: new `BIGINT_OPS: Record<string,string>` (`+`->`add`, `<`->`lt`, etc.), checked in
  `emitExpr`'s `'binary'` case *before* `builtins[op]`'s generic kind-only dispatch: `if (bigintMethod &&
  ownerOf(e.left, ctx) === BigIntOwner) return emitMethodCall(BigIntOwner, bigintMethod, e.left, [e.right],
  ctx);`. This is deliberately *not* threaded through `arithInline`/`plusInline`'s existing `WasmType`-only
  signature (`Inline2`) -- those only ever see the physical kind, which can't distinguish `bigint` from
  `Int32Array`/`boolean[]` on its own; the real static `Type` (via `ownerOf`) is what makes the dispatch
  point unambiguous, checked once, right where `emitExpr` still has the actual expression in hand.
- **Known real gap, not yet hit in practice**: operator dispatch depends on the general checker actually
  inferring the operand's `bigint` type -- but `bigFromNumber`/etc are invisible to the general checker
  (never declared anywhere it can see, same gap `Uint8Array`/`String`'s methods already have). Chaining a
  call straight through an operator (`bigFromNumber(a) + bigFromNumber(b)`) silently resolves to `any` and
  falls through to plain `f64`/`i32` arithmetic, throwing a WasmType-mismatch error rather than doing
  BigInt math -- confirmed by hitting it directly while writing the test suite. Fixed by using explicit
  `bigint`-annotated locals first (`const a: bigint = bigFromNumber(x); ... a + b`), which is also just the
  realistic way a real user would write it. Test suite (`test-towasm.ts`) follows this pattern throughout.
- **`this`/params inside `BigInt`'s methods have no index signature or `.length` of their own** -- each
  method casts to a genuine `Uint32Array` local first (`const av: Uint32Array = this as unknown as
  Uint32Array;`), reusing the already-built `'as'`-cast no-op, rather than declaring `[i:number]:number;
  length=0;` directly on `BigInt` the way `Array<T>` does. User's own design call, arrived at via two
  narrower options first floated (a hand-built `.limbs` struct field -- rejected as premature, would
  require inventing builtin-structs-with-ref-fields, a wholly new capability with no other consumer; a
  cosmetic `.limbs` property alias special-cased in `emitExpr` -- superseded once the user pointed out the
  existing `as`-cast mechanism already does this with zero new towasm.ts code). `Uint32Array` is a new
  `FIXED_BOX`/`'new'`-case entry, third name sharing the exact same `{arr:'i32'}` physical kind (alongside
  `Int32Array`/`boolean[]`) -- wasm has no separate signed/unsigned storage for a full i32 element, so this
  needed no new physical array kind, just another name in the by-name dispatch tables.
- Verified with a real end-to-end run (`WebAssembly.Instance`, not just `tsc`): `bigint + bigint`, `<`,
  `===` on values built via `bigFromNumber`/read back via `bigToNumber` all produce correct runtime results
  across a limb boundary (70000+5=70005, carries correctly at 65536).
- **Known real gap in the general checker, hit by the user's own in-progress signed-bigint edit (not
  fixed, they paused that work)**: a conditional expression's own branch typing has no workaround for the
  "checker gives `any` for indexing into a `ref`-typed array" gap the way `operandKind`/`elementTypeOf`
  already do for binary-operator operands and `var_decl` initializers -- `(i < nb ? b[i] : bt)` (a ternary
  with an indexed-read branch, inside `bigAdd`) poisons the whole ternary's inferred type to `any`, which
  `wasmTypeOf` can't resolve, throwing "conditional expression has an unsupported type" from `emitExpr`'s
  `'conditional'` case. Worth a `conditionalOperandKind`-style fix (mirroring `operandKind`) if resumed.
  Separately (also unverified/unfixed, found by inspection only): `bigTrim`'s trimmed-vs-unchanged check
  looked inverted (`if (n !== a.length) return a;` where the working version had `n === a.length`) at the
  point this was last read -- flagged to the user, not touched, since they were mid-edit.

## Real constructors for builtin (non-struct) owners + `++`/`--` (2026-07-31, later same day)

User's own idea: `new Uint8Array(n)`/`new Int32Array(n)`/`new Uint32Array(n)` were all hand-special-cased
directly in `emitExpr`'s `'new'` case (raw `array.new_default`), while `Array<T>`'s own instantiations had
no `new` path at all. Added a second constructor mechanism alongside `ensureCtor` (real classes,
`struct.new_default` + body): **`ensureBuiltinCtor`** -- for an owner with no struct to default-init, the
body itself must construct and `return` the value directly (no implicit `this`). `Array<T>` gained a real
`constructor(n: number) { return __towasm_arr_alloc(n) as unknown as T[]; }` in towasm-lib.ts, substituted
per instantiation exactly like its other methods (`substElemMethods`/`substElemMember`/`substElemType`
refactored to expose per-member substitution, reused for the lone ctor decl too) -- this alone gives
`Uint8Array`'s length-only `new` form a real constructor for free, with zero extra towasm-lib.ts code.
`Int32Array`/`Uint32Array` still have no owner (see the `WasmType->Type` fix above), so their `new` form
keeps the old raw-allocation fallback -- `emitExpr`'s `'new'` case checks `FIXED_BOX[name]?.owner?.ctorDecl`
first, falls back only if absent. `new X([...])` (array-literal argument) deliberately stays hardcoded
alongside this (user's explicit choice) -- a single-signature ctor can't express "length or array literal"
without overloading, which this compiler doesn't support, and dropping that shape would be a real
regression (tested, working functionality).

`ensureBuiltinCtor` is memoized via `funcs.set('${owner.name}.constructor', info)` -- **not** a `.ctor`
field on `MethodOwner` (tried first, real bug: nothing ever calls `place()` on it, so the compiled
function's body never lands in the module's `code`/`functionTypes` arrays, "reached end while decoding
signature index" from `WebAssembly.Module` at instantiation). `ClassInfo.ctor` (real classes) keeps its own
dedicated placement loop, since a real ctor is *only* reachable via `new`, never through `funcs`-keyed
lookup the way a method/builtin-ctor is -- the two are genuinely different placement mechanisms, not
interchangeable. `__towasm_arr_alloc` (used by `Array<T>`'s methods *and* now its ctor) used to derive its
target kind from `ctx.locals.get('this')?.wtype` -- broke immediately for the ctor (no `this` declared,
nothing to construct *into*). Fixed by switching to `ctx.result` instead, which is always the same target
kind for every caller (a method returning `T[]`, or the ctor whose own result *is* the value) -- more
general than a `this`-specific special case, not just a workaround.

**`++`/`--`** (prefix `{type:'unary', operator:'++'|'--'}` and postfix `{type:'unary_post', operator}`,
distinct AST node types, both from `examples/common.ts`): new `emitIncDec(operand, ctx, delta, prefix)`,
identifiers only (member/index targets hit the same "`struct.set` has no `local.tee`-equivalent" limitation
`emitAssign` already has -- would need a scratch local for the receiver, not attempted). Prefix:
`local.get` old, add/sub 1, `local.tee` (stores + leaves new value in one op). Postfix: `local.get` old
*twice* (one kept as the result, one consumed by the add), `local.set` the new value -- wasm has no stack
`dup`, so this is the standard idiom. Works automatically as a bare statement (`x++;`, via the existing
`'expression'` statement case) and as a `for` loop's update clause, with no changes needed there -- both
already just call `emitExpr` on whatever expression they're given.

Verification pattern: isolated `test/t_scratch_*.ts` (deleted after) for each feature before touching the
real suite, since the suite itself was blocked partway through by the user's own in-progress signed-bigint
edit (see above) -- confirmed the blocker was pre-existing/unrelated by running with `grep -E "^ok -
|^FAIL|^Error:"` and checking every check through `i32Compare()` (the last one before the BigInt block)
still passed, including all new `++`/`--` and constructor checks. (The user then resolved the signed-bigint
blocker themselves; full suite green shortly after.)

Test suite pruned same day, per explicit user feedback (see [[feedback_no_unimplemented_throws_tests]]):
removed 4 `checkThrows` cases whose only point was "this unimplemented feature throws" (`push()`,
`for...in`, string indexing-read, string by-value `===`) -- kept arity-check/void-handling/type-check-gate
`checkThrows` cases, which validate real permanent behavior, not absence of a feature.

## Unary operators unified into `builtins` (2026-07-31, later same day)

User's own design question, then own implementation (concurrent edit, found while investigating): `-`/`!`/
`~` moved from a hardcoded if-chain in `emitExpr`'s `'unary'` case into the *same* `builtins` dispatch
table binary operators already use (`'prefix-'`/`'prefix+'`/`'prefix!'`/`'prefix~'` keys) -- avoids a name
collision with binary `-` via a `'prefix'` string-prefix on the key, one shared `Builtin`/`Inline` dispatch
shape for both. `++`/`--` deliberately do **not** join this table -- structurally they can't: `Inline`'s
shape (fixed params/result/instructions) has no way to carry "which local index to read-modify-write";
`emitIncDec` needs the raw `Expr` for that, same reason binary `'='` (assignment) is special-cased in
`emitExpr` *before* consulting `builtins[op]` rather than living in the table itself.

Found and fixed a real bug in the new table while reviewing it: `'prefix+'` (unary `+`, a real op --
`unaryOps` includes it, previously simply unsupported/threw) was copy-pasted to `f64.neg`, identical to
`'prefix-'` -- silently *negated* instead of being the numeric-coercion no-op real JS's unary `+` actually
is. Fixed to `inline: []` (an empty instruction list -- `emitAs` already coerces the operand to `f64`,
nothing further needed). Verified directly (`+5 === 5`, `+(-3) === -3`), not just type-checked.

## `OperandInfo` -- `builtins` dispatch gets the real owner, not just the physical kind (2026-07-31, later)

User's own follow-up complaint after the `WasmType->Type` fix and the unary-ops-into-`builtins` move above:
`builtins` entries (`arithInline`/`equalityInline`/the `'+'`/comparison entries) still only ever received
`(WasmType|undefined)[]` per operand -- so they *still* couldn't dispatch on `bigint` themselves, which is
exactly why `BIGINT_OPS` had to exist as a separate special-cased pre-check in `emitExpr`'s `'binary'` case
*before* ever consulting `builtins[op]`, rather than a real part of the table. Fixed by giving every
`Builtin` function both pieces at once: new `interface OperandInfo { wtype: WasmType|undefined; owner:
MethodOwner|undefined }`, `Builtin`'s signature changed from `(args: (WasmType|undefined)[], ...)` to
`(args: OperandInfo[], ...)`. `operandKind` (used to special-case an indexed read's element kind, since the
checker gives `any` there) renamed/extended to `operandInfo`, now also resolving `.owner` via `ownerFor`
from the exact same `Type` -- an indexed read's `.owner` is always `undefined` (a transient scalar has no
owner identity). All 3 call sites updated (`emitCall`'s bare-call dispatch, `emitExpr`'s unary and binary
cases).

This let `BIGINT_OPS` and its whole pre-check block in `emitExpr`'s `'binary'` case be **deleted entirely**
-- `bigint` dispatch now lives inside the table itself, alongside string's, via the same mechanism:
`equalityInline` checks `args[0].owner === BigIntOwner` first (delegates to `.eq`/`.ne`); `'+'`'s own entry
checks `.owner === BigIntOwner` (delegates to `.add`) then `.owner === StringOwner` (delegates to
`.concat`, now checked by real owner identity instead of the old `t.arr === 'i16'` physical-kind check);
new `bigintAware(method, fallback)` wraps `<`/`>`/`<=`/`>=`'s existing `arithInline`-based builders with the
same owner check before falling back to plain kind dispatch. `-`/`*`/`/` stay untouched -- `BigInt` has no
subtract/multiply/divide (documented scope: add/compare only), nothing to delegate to. Also applied to
unary `'prefix-'`, wrapped with `bigintAware('neg', ...)` even though `BigInt` has no `neg` method yet
(unsigned-only, blocked on the paused signed-support work) -- purely so a stray `-someBigint` throws a
clear "unknown method 'neg' on BigInt" from `ensureMethod` instead of a confusing WasmType-coercion error
from `emitAs`. `!`/`~`/unary `+` were *not* wrapped -- no plausible/planned `BigInt` method for any of them
(would need `isZero`/real bitwise-on-magnitude semantics, never discussed), unlike `neg` which is a direct,
near-certain consequence of the signed-support work already in flight.

**Real bug found and fixed while doing this** (pre-existing, unrelated to this specific change, surfaced by
running the suite after touching every `builtins` call site): `emitCall`'s bare-call dispatch had lost its
`typeof builtin === 'function'` guard at some point (concurrent user edit) -- `builtins` isn't purely
dispatch functions, its tail spreads in `LIB_DECLS`'s raw `FunctionDecl` AST nodes directly
(`...Object.fromEntries([...LIB_DECLS].filter(d.type==='function_decl'&&LIB_EXPORTED.has(name)))`, e.g.
`bigFromNumber`) for `ensureFunc` to compile properly -- calling one of those AS a dispatch function
(`builtin(args...)`) crashed with `TypeError: builtin is not a function` the moment a plain lib function
got called by name (first hit while re-verifying the `OperandInfo` change, but not caused by it). First
fixed by restoring the guard + `Builtin`'s `FunctionDecl | (...)` union -- then superseded (see below).

**Superseded within the hour, per explicit user request** ("builtins should *only* hold functions, surely
we can wrap this single case in a function?"): `emitCall`'s `ensureFunc` machinery is per-`TStoWasm`-
invocation state (`funcs`/`worklist`), so the module-level `builtins` table can't literally close over it --
but the *entries* can still all be real functions if the wrapper just returns its own `FunctionDecl` as
data instead of being one. `Builtin`'s return type became `Inline | MethodDelegate | FunctionDecl`; the
`LIB_DECLS` spread wraps each decl as `() => d` instead of storing `d` bare
(`.filter(...).map(([name, d]) => [name, () => d])`). New `emitPlainCall(name, decl, args, ctx)` factors out
the shared `funcs.get(name) ?? ensureFunc(name, decl)` + arg-coercion + `call`-emission sequence, used both
by a `builtins` entry that resolved to a `FunctionDecl` and the unexported-lib-helper fallback (previously
near-duplicated across two branches of `emitCall`) -- net simplification, not just type-purity. All 3
`Builtin`-calling sites now discriminate the *return value* (`'type' in result` for `FunctionDecl`, `'owner'
in result` for `MethodDelegate`) instead of `typeof` on the *table entry* before calling it -- every entry
is unconditionally callable now, no more pre-invocation type check needed anywhere.

**Investigated (not just asserted) why `tsc` caught none of this originally** -- user was bothered that
narrowing `Builtin` away from `FunctionDecl` produced zero diagnostics despite the object-literal spread
still contributing raw `FunctionDecl` values. Isolated with a minimal repro (`assistant/t_scratch_*.ts`,
deleted after): a spread checked *alone* against a typed `Record<string, Fn>` target correctly errors
(`Type '{n:number}' is not assignable to 'Fn'`) -- but the *identical* spread, once mixed with an ordinary
own-property in the same object literal (`{ real: () => {}, ...spread }` -- exactly `builtins`' shape), sits
completely unchecked against the index signature, with or without a preceding `.filter()` in the pipeline.
A genuine, confirmed TypeScript spread-checking gap (object literal + spread + other own properties), not
a project-specific mistake -- and the concrete argument for the "only ever store real callables" redesign:
the type checker can silently miss this whole class of bug, so the reliable fix removes the possibility
rather than annotating more carefully.

## `makeLibScope()` + lib-aware `TStypeCheck`/`TStoWasm` threading (2026-08-14/15) -- CLOSED, `methodOwner` special-case confirmed still needed

Architectural gap found: `checker.typeOf` (called from `towasm.ts`'s codegen, incl. via
`checker.scopeOfStmt`) couldn't resolve *lib-declared* classes' methods at all (`String.toUpperCase()`,
`RegExpMatch.group()`), because the scope it walked never had lib declarations as an ancestor -- only
`ownerOf`'s special-cased `methodOwner` bypass (reading a method's return type straight off the class
decl) covered this. User's own diagnosis + explicit direction ("no - go for it!"): thread a single,
shared lib-aware scope through both `TStypeCheck`/`TStypeCheckAsync` (as `libScope`, ancestor of
`global`) and `TStoWasm` (reads it back off `ast.scope`), so a scope built this way sees lib
declarations naturally. New exported `makeLibScope(): Scope` in towasm.ts builds this once
(`new Scope(T.makeGlobal())` + `checker.checkBlock(LIB_AST, libScope, true)`); `tsw.ts`/
`test-towasm.ts` each call it once and pass to `TStypeCheck`.

**This part landed clean, 271/271, and does fix general lib-method resolution** for non-generic
call-sites (`ownerFor` now tries `ensureClass(t.name, t.typeArgs)` on the raw ref before `T.resolve`'s
full expansion -- needed because a name with *both* a real class and a separate ambient `interface`
sharing it, same pattern as `String`/`TypedArray`, merges into an untraceable `intersection` once
`global` can see both).

**Then tried removing `var_decl`'s `methodOwner` special-case entirely** (the ORIGINAL motivating
question -- "is it still needed now?"), relying on the now-lib-aware `checker.typeOf(d.init,
stmtScope)` alone. Isolated probes all passed (`String.toUpperCase()`, `RegExpMatch.group()`,
narrowing-after-`break`-in-`while`, even a hand-copied mirror of `String.split`'s exact structure) --
but the **full suite failed deep in**, `String.split`'s `m.groupStart(0)`/`m.groupEnd(0)` (after a
narrowing `if (m === null) { push; break; }`) resolving to `any`. Root cause, found via targeted
`console.error` instrumentation (isolated probes never caught it because they only called `TStoWasm`,
never `mod.toBytes()`+instantiate -- a wrong-type codegen doesn't throw a JS exception on its own, only
wasm validation catches it, so every earlier "OK" probe result was silently meaningless for this bug):
`checker.scopeOfStmt(s)` returned `undefined` for these statements -- `checkFunctionBody`'s `if
(expected && muted) return;` (checker.ts) skips a method/function's own body walk entirely under
`muted` whenever its return type is already declared, and `makeLibScope()`'s `checkBlock(LIB_AST,
libScope, true)` runs the *entire* lib pass muted, so no lib method with an explicit return type ever
got its body statements scope-stamped at all.

**Tried the "obvious" fix -- un-mute `makeLibScope()`'s checkBlock** (its diag sink is already a no-op,
so muting buys nothing directly there). This *does* fix `String.split`'s narrowing -- but simultaneously
**breaks every GENERIC lib class method** (`Array<T>.reverse`/`.fill`/`.slice`/...): the stamp it now
leaves reflects the template's own *unresolved* `T`, and `(stmt as any).scope ??= scope`'s first-wins
semantics then permanently blocks the real, per-instantiation substituted scope (`ctx.scope`, built
fresh per monomorphized instantiation via `substElemMethods`) from ever overriding it. Confirmed via the
same instrumentation: `const tmp = this[i];` inside `Array<T>.reverse()`'s generic template resolves
`this`'s type via the now-present stamp to `Array<T>` with `T` still a bare unresolved type-param ref,
so the indexed-element type becomes `T` itself (unresolvable, boxes to `any`) instead of the
instantiation's real `number`/`boolean`/etc -- a *different* WASM validation failure, earlier in the
suite (`Array<number>_reverse`) than the one just fixed.

**No fix found that satisfies both** narrowing-dependent AND generic-instantiation-dependent lib bodies
through the same one-time stamp mechanism -- they need genuinely different scopes (the real, narrowed
checker scope vs. the real, substituted-per-instantiation codegen scope) and `checker.scopeOfStmt`'s
single untyped per-statement stamp can only ever hold one. **Reverted both changes**: `makeLibScope()`
back to muted, `methodOwner`'s special-case in `var_decl` restored verbatim -- back to the last
known-good, fully verified 271/271 state. The `makeLibScope`/lib-aware-`TStypeCheck`/`TStoWasm`
threading itself (the part that DOES work) was kept.

**Verdict on the original question: `methodOwner` is genuinely still needed**, not just historically
cautious -- it exists specifically to sidestep this exact narrowing-vs-generic-substitution tension for
method-call return types, and no amount of lib-scope-awareness removes that need. If this is revisited,
a real fix would need `checker.scopeOfStmt` (or its stamping) to be substitution-aware -- e.g. stamping
per-instantiation rather than once per template, or a second, generic-aware scope-lookup path codegen
could fall back to -- not just choosing which existing scope wins.

**Lesson on the isolated-probe methodology** (documented, since this cost real time twice in one
session): a `tryCompile`-style probe that only calls `TStoWasm(program)` and never `mod.toBytes()` +
`WebAssembly.Module`/`instantiate` **cannot catch a wrong-WasmType codegen bug** -- it silently reports
"OK" for genuinely broken output. Any probe meant to validate codegen correctness (not just "doesn't
throw a JS exception") must instantiate the module, matching `test-towasm.ts`'s own `compile()` helper.

## Real class inheritance (2026-08-16/17, same broad session) -- the big one

User asked how to implement inheritance without losing today's static-dispatch benefits; landed the full
feature same session after "agreed - please implement": `extends`, `super(...)`, `super.method()`, and
real virtual dispatch through a base-typed reference. 271→283 real checks (8 new), full green, plus many
throwaway probes along the way (all deleted after).

**Grammar/AST first, not a name-matching hack**: `super` was parsing as a bare `{type:'identifier',
name:'super'}` (not reserved at all) -- gave it a real `{type:'super'}` node instead (`js-parser.ts`,
mirroring `{type:'this'}`'s own existing `Rule(['this'], ...)` precedent exactly), propagated through
`walker.ts`'s two switches (`mapExpression`/`walkB`) and `tocode.ts`'s `exprBody`. Zero grammar/LALR
fallout -- confirmed via `test-js-parser.ts` (prints `class Bar extends Foo { ... super(1); ... }`
correctly) and the full towasm suite. A separate, unrelated `tison-regexp` (a different package's own
frozen copy) GLR-explosion parse failure surfaced while sweeping the whole workspace via
`test-ts-parser.ts` -- verified (commented the new grammar rule out, re-ran) it reproduces identically
with `super` disabled, so pre-existing and unrelated; not investigated further.

**Design (as proposed, landed close to plan)**:
- **Layout**: `ClassInfo.superClass?: ClassInfo`. `ensureClass` resolves the superclass *before* its own
  members, seeds `fields`/`fieldIndex` from it first (wasm-GC struct subtyping needs the supertype's
  fields as an exact ordered prefix), then its own `addField` calls append after -- `addField` now throws
  on redeclaring an inherited name (silent index-clobbering otherwise). The struct type's own `final` flag
  is `!everExtended.has(name)` and `supertypes: [superClass.typeIndex]` -- both driven by a **new
  whole-program precompute**, `directSubclasses`/`everExtended` (every `class ... extends X` in the whole
  program -- lib + user, generic + not -- scanned once, right after the eager class-seeding loop, kept
  eager/textual specifically so it's complete *before* any lazy per-class `ensureClass` resolution begins).
- **Constructors**: new `emitCtorStatements(stmts, cls, ctx)` walks a ctor body statement-by-statement,
  same as a plain `forEach(emitStmt)`, except a `super(...)` call is *inlined*: binds the base ctor's own
  param names via ordinary synthetic `var_decl`s (reusing the existing local-declaration path verbatim,
  destructured-param desugaring included) in a nested `openScope`/`closeScope`, then recurses into the
  base ctor's own body against the *same* `this` (there's only ever one physical allocation for the whole
  hierarchy -- "calling super" means "run its init logic", not "allocate a separate base object").
  Recurses naturally for a multi-level chain. Wired into the plain `struct.new_default` path only --
  the "collect real values then `struct.new`" path (object-typed fields) and the "constructor `return`s a
  value" path (array/scalar-backed classes) both throw a clear, scoped-out error when combined with
  `extends`, rather than being taught the same inheritance-awareness (documented gap, not attempted).
- **Non-overridden method calls**: `ensureMethod`'s `!decls` case now delegates to `owner.superClass`
  instead of returning `undefined` -- resolves to (and shares `funcs`' cache with) the ancestor's own
  compiled function under *its own* key, never recompiled under the descendant's name. Sound and free:
  wasm-GC struct subtyping makes `(ref Derived)` directly callable wherever `(ref Base)` is declared, no
  cast -- confirmed by extending `coerceTop` with a new `isSubclassOf`-gated branch (an upcast between two
  *different* ref names needed a case `coerceTop` never had before; the only real wiring surprise in the
  whole build).
- **`super.method(...)`**: new dedicated branch in `emitExpr`'s `case 'call'`, checked before the ordinary
  member-call path. Always resolves against `ctx.owner.superClass` via the *same* `emitMethodCall`, with a
  new `bypassVirtual` param forcing it past the virtual-dispatch check below -- by definition `super.x()`
  is never virtual, regardless of whether `x` is overridden elsewhere.
- **Virtual dispatch**: new `hasDeclaredOverride(className, methodName)` (memoized, walks `directSubclasses`
  transitively -- whole-program-text-complete, so safe to ask *before* all classes are lazily discovered)
  decides per call site, in `emitMethodCall`, whether to route through a real dispatch cascade instead of
  the plain path -- the overwhelming majority of calls (anything with no override anywhere reachable) stay
  exactly as cheap as without inheritance at all, the original design goal. `ensureVirtualDispatch`
  generalizes `ensureAnyDispatch`'s existing shape (reserve a funcIndex immediately, build the real cascade
  body once `lateWorklist` guarantees the final reachable-class set) to a real receiver type and real
  method arguments (not just `any`/zero-arg) -- candidates from `collectOverridingCandidates`, most-derived
  first (by walking each candidate's own `superClass` chain depth), falling through to `ensureMethod(owner,
  ...)`'s own (possibly further-inherited) implementation as the final arm.

**The one real, deep bug, found by testing not review**: the *first* cascade implementation used
`ref.test`/`ref.cast` against each candidate's own struct type, exactly like `ensureAnyDispatch` already
does. A sibling-class test (`Dog`/`Cat`, both `extends Animal`, neither adding fields of its own) failed:
`animals[2]` (a real `Cat`) ran `Dog`'s override. Root cause, confirmed via raw WAT inspection and a direct
reproduction (not assumed): wasm-GC **canonicalizes two structurally-identical struct types** (same
supertype, same field list) **into one runtime type**, even declared as separate type-section entries --
`ref.test`/`ref.cast` genuinely cannot tell `Dog` and `Cat` apart once their own field lists happen to
match. This is a *latent, pre-existing* vulnerability in `ensureAnyDispatch` too (never triggered there,
since nothing had yet exercised two same-shaped classes together) -- flagged to the user, not fixed there,
since the fix's scope belongs to whoever's actually hitting it and this session's task was inheritance.

**First fix attempt (round 1, later superseded -- kept here for the reasoning trail): real per-instance
runtime data instead of the wasm type system.** A hidden `#classId` `i32` field (only for a hierarchy's
*root* class, inherited by every descendant at the same index for free). Round 1 of *that* stored a flat,
arbitrary per-class integer and compared by exact equality -- broke a *different*, equally real case:
`Puppy extends Dog` (no override of its own) must still match *Dog's* cascade arm, which an exact-ID test
can never do. Round 2 fixed that with a classic **pre-order/post-order interval encoding** of the class
tree (`typeIdRanges`, one DFS over `directSubclasses`) -- "X is-a Y" reduces to one interval-containment
check. This version worked (283/283) but added a real per-instance field plus the whole DFS/interval
machinery.

**The actual fix, found by asking "is it really wasm itself doing this, or towasm's own registerType?"**
(the user's own question, verified rather than re-asserted): confirmed empirically that neither
`registerType` (structs are deliberately never deduped there, unlike func/array) nor `binary_libs`'s
writer merge anything -- `towasm.ts` was already explicitly emitting every type as its own **singleton rec
group** (`mod.types = { types, groupSizes: types.map(() => 1) }`, found at the point of chasing this down).
wasm-GC's actual canonicalization rule: two types are structurally compared *across* separate rec groups
regardless of shape, but a type's canonical identity *within* a group includes its position in that group
-- confirmed with a minimal, isolated raw-`wasm.WasmModule` repro (two `sub final $Animal (struct)` types,
otherwise identical, real vs canonicalized `ref.test` behavior toggled purely by `groupSizes`: `[1,1,1]`
merges them, `[3,1,1]` (all three in one shared group) keeps them distinct). Landed as one line:
`mod.types = { types, groupSizes: types.length ? [types.length] : [] }` -- **one shared rec group for
every type the module ever registers**, not just classes. This requires no reordering and no index
remapping (a rec group only needs to be a *contiguous run*, and `types[]`'s own append order already
satisfies that trivially when the group is everything), and it's monotonic -- grouping can only ever *add*
distinguishing power (position-in-group breaks a coincidental shape tie), never cause two already-distinct
types to collide. This let the entire `#classId`/`typeIdRanges`/interval mechanism be deleted outright --
`ensureVirtualDispatch`'s cascade is back to plain `ref.test`/`ref.cast`, matching `ensureAnyDispatch`'s
own original shape exactly, and **`ensureAnyDispatch`'s own latent version of the same bug is fixed too**,
for free, since the grouping change is module-wide, not scoped to virtual dispatch. Verified against the
full 283-check suite (including the dedicated `siblingsDistinct` regression test) with zero regressions.

## Gap comment restructured to a nested list (2026-08-17)

User's own ask: the top-of-file gap comment had grown into dense multi-gap paragraphs per category,
some of which also described what *does* work (redundant once "unlisted = supported" is the stated rule).
Restructured to a strict two-level list -- one `- Category:` heading, one gap per nested item underneath,
each either a whole missing construct or just the unsupported edge of an otherwise-working one, no "this
part is fine" call-outs left anywhere. Worth maintaining this shape going forward: add one line, not a
run-on clause, when a new gap is found; delete the item outright (don't leave a "now supported" note) once
closed.

## Expressions gap items closed (2026-08-16/17, same broad session) -- 283→298

User picked the "Expressions" category's remaining items to finish. Three landed cleanly by reusing
existing machinery; the fourth (object literals) was scoped narrow by design, discussed and agreed before
starting (matching the file's now-established pattern of sizing a gap honestly before committing).

- **Comma/sequence operator** (`(a, b, c)`): new `case 'sequence'` in `emitExpr` -- every expression but
  the last runs through `emitStmt`'s own existing `'void'`-then-`I.drop` idiom, verbatim; only the last
  respects `want`. No new mechanism at all.
- **Array literal holes** (`[1, , 3]`): new `emitDefaultValue(want, ctx)` (a scalar's own zero, or
  `ref.null` for a nullable ref/array/closure element -- throws for a non-nullable ref element, same "no
  defaultable zero for a non-null ref" restriction object-typed class fields already have) wired into both
  `emitArrayElements` branches (plain `array.new_fixed` and the spread-materializing path) in place of the
  old unconditional "holes are not supported" throw.
- **Tagged templates**: new `case 'tagged_template'` synthesizes the exact call real JS itself desugars
  this to (`tag(strings, ...values)`, via `JS.Call`+`JS.ArrayLit`+`Literal`) and re-enters `emitExpr`,
  reusing the ordinary call-resolution path (`case 'call'`) wholesale -- arg-count/type coercion, and
  "tag is a class method" support, come free from `emitCallArgs`/existing dispatch, no parallel
  implementation. `.raw` isn't modeled (a plain `string[]`, not real `TemplateStringsArray`, is what a tag
  function must be typed against). **Real bug found by testing, not review**: the synthesized strings
  array first came up one element short whenever the template ended right after a `${...}` (no trailing
  text) -- `e.quasi` (the parser's own quasi-part list) doesn't include a trailing empty-string part in
  that case either, a gap the *existing* untagged-template code in `case 'literal'` already knew to pad
  for (`hasTrailingLiteral`) -- my first pass didn't reuse that logic; fixed by applying the identical pad.
- **Object literals (narrow scope, by design)**: only supported when the literal's target type is a plain,
  non-generic `type X = { ...properties }` alias -- from a var_decl/param/field/return annotation, or
  anywhere else a concrete `want` threads through `emitAs`. New `ensureObjectShape(name)` resolves such an
  alias (via `global.type(name)`, `T.resolve`, requiring every member be a plain `'property'`, no
  methods/index/call signatures) into a **real, minimal `ClassInfo`** -- no methods, no constructor, no
  superclass, just `fields`/`fieldIndex`/`typeIndex` -- cached in the *same* `classes` map real classes
  use (a name can't be both a `class_decl` and a type alias, so no key collision) and wired into
  `ensureClass`'s existing alias-fallback chain right alongside `resolveClassAlias`. This is what makes
  `case 'object'` in `emitExpr` (new) able to reuse `classOf`/field-access codegen completely unchanged --
  it just needs `want` to already be `{ref: name}` resolving through `ensureClass`, throws a clear "needs a
  known target type" error otherwise. Fields push in the *shape's own declared order* (`struct.new` needs
  every value up front, in a fixed order), looked up from the literal's own properties by name, since real
  TS allows any written order. General structural inference/subtyping (no named target, or a target whose
  shape differs from the literal's) is explicitly out of scope -- documented as the gap comment's own
  remaining item under 'Expressions', not silently missing.
- Verified via real WASM execution throughout (shorthand properties, out-of-order fields, object literals
  as call arguments/return values, a tag that's a class method, holes combined with a spread element, a
  hole in a nullable-ref-element array) plus two permanent negative tests (`checkThrows`) confirming a
  missing-target-type object literal is rejected with a clear error. Suite 283→298, full green.

## Generic top-level functions (2026-08-16) -- first slice of the gap comment's "generic functions/methods"

User asked what it'd take to implement the gap comment's generic-function/method items; landed the
smallest self-contained slice (generic top-level `function`/const-bound-arrow declarations, called by
name) same session, 271/271 + 7 new real-execution test cases, no regressions.

**Design, reusing existing machinery wherever it already existed:**
- Inference reuses `type-utils.ts`'s own `T.inferTypeArgs`/`T.substituteType` -- the exact checker-grade
  machinery `checker.ts`'s own `instantiate()` (its lazy-return-type-inference engine) already uses for
  this same purpose. No new inference logic invented.
- New `substituteTypeParams<N>(node, map: ReadonlyMap<string,Type>)` generalizes the existing
  `substituteClassTypeParam` (one name, re-invoked once per class type param) to N substitutions in one
  `walk` pass -- kept as a separate function, not a refactor of the class path (which has its own
  `thisTsType`-array special case, `Array<T>`-specific, not worth entangling).
- New `ensureGenericFunc(name, decl, args, typeArgs, ctx)` mirrors `ensureClass`'s own composite-key
  caching shape (`identity<number>`) -- the one real difference from a class reference (`Box<number>`,
  always explicit at the use site) is that a function's type args are usually left *implicit*, inferred
  from arguments; explicit call-site type args (`identity<number>(5)`, `Call<T>.typeArgs` already existed
  in the parser/checker, just never read by towasm.ts before) are honored too.
- `emitCall` gained a `typeArgs?: Type[]` param (threaded from `e.typeArgs` at its one real call site) and
  now dispatches `decl?.typeParams?.length ? ensureGenericFunc(...) : funcs.get(name) ?? compileFunc(...)`.

**Real bug found while testing, not designing:** a separate, pre-existing eager-compilation loop --
`for (const f of functionDeclByName) compileFunc(f[0], f[1]);`, right before draining `worklist` -- calls
`compileFunc` directly on *every* top-level function regardless of whether anything ever calls it,
completely bypassing `emitCall`'s new generic dispatch. Every test failed with `compileFunc`'s own
"generic function is not supported" throw until this was found (all 7 hand-written probes initially "OK"
until instantiated -- caught immediately here since the probe script instantiated real wasm from the
start, unlike the string.ts investigation earlier the same session). Fixed by skipping generic entries in
that loop (`if (!f[1].typeParams?.length)`), same treatment `userGenericClassDecls` already gets kept out
of the eagerly-seeded `classes` map for the identical reason -- a generic template has no single physical
function/class to eagerly compile, only concrete instantiations do, built on demand.

**Deliberately out of scope for this slice** (per the original "what would it take" breakdown, agreed
before starting): no contextual/expected-return-type inference (checker.ts's `instantiate` also has this,
via its own `expected` param -- towasm's codegen has no comparable "expected type" threaded through a call
expression yet; an unconstrainable-from-arguments type param just falls to `default`/`constraint`/`any`,
same as the checker's own final fallback); no generic arrow/function *expressions* used as first-class
closure values (only a `const` bound directly to a generic arrow/function at the top level works, since
that's promoted into the same `functionDeclByName`-by-name path as an ordinary `function` declaration --
incidental, not separately implemented); no generic *methods* (the harder next slice -- needs the class's
own already-resolved substitution AND the method's own additional type params composed together, not just
one map).

## Two follow-on fixes, same session: static methods on generic classes + exported-only eager compile

User's own observations, both correct, both landed same session (271/271 + new real-execution probes):

**Static methods on generic classes couldn't be called at all.** `Box.describe()` (a `static` method,
called via the bare class name, no instantiation in sight) threw "class 'Box' needs 1 explicit type
argument(s)" -- `namespaceOwner`'s `ensureClass(name)` call had no type args to give it, and `ensureClass`
requires them unconditionally for any generic class. Real TS forbids a static member from ever referencing
its own class's type parameters, so *which* type argument gets used structurally can't matter for a static
lookup -- fixed via new `staticTypeArgsFor(name)`, filling every type param with `T.ANY` (always resolves
to `REF_ANY`, so even some unrelated field/member that happens to mention the type param still resolves
without failing) instead of throwing. Cached under the ordinary composite key (`Box<any>`) `ensureClass`
already uses -- no new cache, no risk of colliding with a real instantiation's own resolution (a real
`Box<number>`/`Box<boolean>` keys and resolves completely independently, verified directly: static + two
differently-typed real instances of the same generic class, same module, same test).

**The eager top-level-function-compile loop ignored reachability entirely**, contradicting this file's own
established "only code actually reached from an exported function gets processed" design (already true for
classes/generic instantiations) -- `for (const f of functionDeclByName) compileFunc(...)` unconditionally
compiled *every* top-level function, exported or not, generic-skip from the same-session fix above aside.
User asked "perhaps only exported functions should be unconditionally compiled?" -- correct: the exports-
list-building loop further down is the only real reason anything needs pre-populating `funcs` eagerly at
all (`funcs.get(name)!.funcIndex`), and only for names it's about to actually export. Fixed by computing
`exportedNames` once (new shared `exportedFuncNames(s)` helper, reused by both this loop and the pre-
existing exports-list loop, which duplicated the same classification inline before) and eager-compiling
only those; everything else now waits for `emitCall`'s own lazy `funcs.get(name) ?? compileFunc(...)`
discovery, same as it always claimed to. Also added a real, specific error for the one new edge case this
unblocks: exporting a *generic* function directly (no fixed signature to give a wasm export) now throws
"a generic function has no single fixed signature to export" instead of a confusing non-null-assertion
crash inside the exports-list loop. Verified: an unreachable non-exported function with a genuine internal
bug (a real object literal, unsupported) no longer blocks compiling an unrelated exported function that
never calls it.

## Generic methods (2026-08-16, same session) -- closes the gap comment's remaining generics item

Landed same session as the two follow-on fixes above, 271/271 + 5 new real-execution tests (incl. one that
also exercises `mod.toWAT()`, not just the binary path). `ensureMethod` gained an optional `typeArgs?:
Type[]` param (threaded from `e.typeArgs` at the 4 real user-call sites inside `emitExpr`'s `case 'call'`
-- every other `ensureMethod`/`emitMethodCall` call site is an accessor/index/operator dispatch, never
independently generic, so those default to `undefined` unchanged) and, when `decl.typeParams?.length`
(the method's *own* type params, e.g. `class Box<T> { combine<U>(other: U): T {...} }` -- `decl` here is
already `owner.methodDecls`' own copy, so the class's own `T` is already concrete by this point), resolves
and substitutes them before the `funcs` cache lookup, composite-keying on top of `owner`'s own already-
instantiated name (`Box<number>.combine<boolean>`) the same way `ensureGenericFunc` keys a bare function
name.

Shared `inferTypeArgMap` (extracted from what was `ensureGenericFunc`'s own inline logic) is now the one
inference implementation both generic functions and generic methods go through -- explicit call-site type
args win outright, otherwise `T.inferTypeArgs` per param, falling back to `default`/`constraint`/`any`.

One real design wrinkle `ensureGenericFunc` never hit: a `MethodMember` (`JS.Method<Type>`) isn't one of
`walk`'s own root node types (only `Program | Statement | Expr | Type | Statement[]`), so `substituteTypeParams`
can't be called on the whole method decl in one shot the way a `FunctionDecl` (a real `Statement`) can.
Fixed by substituting the signature piecewise -- `T.substituteType` per param/rest/return-type annotation,
exactly matching how checker.ts's own `instantiate()` substitutes a signature -- and only the body (a
plain `Statement[]`, which `walk` *does* accept directly) through `substituteTypeParams`.

Verified composing both substitutions genuinely works (not just each independently): a generic method on a
*generic* class, instantiated with two different class-level type args in the same module, called with
its own additional inferred method-level type arg -- correct result both times, no cache collision between
`Box<number>.combine<...>` and a same-named method on a different instantiation.

## Chained optional access ('a?.b.c') + a real checker.ts bug it was hiding behind (2026-08-16, same session)

User asked to verify (not yet fix) whether the gap comment's "only one `?.` step" claim was still accurate.
It was (`rejectChainedOptional`, unchanged all session) -- but `o?.inner.v ?? -1` hit a *different* error
first ("'??' has an unsupported result type"), before ever reaching the chaining throw. Root-caused: a real
checker.ts bug, not a towasm.ts gap. `checker.typeOf(o?.inner.v)` (2-step: `.inner` is `?.`, `.v` is a plain
continuation) returned `any` instead of `number | undefined` -- traced to `case 'member'`'s `objT` (the
computed type of `o?.inner`, correctly `Inner | undefined`) being passed *whole* to `T.lookupMember` for the
`.v` lookup whenever `e.optional` was false, even though `e`'s own object was itself an optional result.
`lookupMember`'s union case requires *every* member to have the property; `undefined` never does; silent
`any` fallback.

**Fixed at the root**: new `isOptionalChainLink(e)` (checker.ts, exported for towasm.ts's own reuse) --
true when `e` itself is a real `?.`/`?.[`/`?.(` step, OR it continues one further out (recurses through
`member`/`index`'s `object`, `call`'s `callee`). Replaced every bare `e.optional` check in `case
'member'`/`case 'index'`/`calleeOptional` (the `case 'call'` `obj?.method(...)` handling) with `chained =
isOptionalChainLink(e)` -- both for "strip nullish before `lookupMember`" and for "wrap the result in `|
undefined`". Same one-line root cause as `String.split`'s narrowing bug from earlier this session (a
structurally-adjacent lookup silently degrading to `any`/`undefined` instead of failing loud) -- worth
grepping for `if (!t) return T.ANY;`-shaped fallbacks near any *other* bare `e.optional` check if this class
of bug resurfaces elsewhere.

**Then closed the towasm.ts gap too**, once the checker gave it correct types to work with: same
`isOptionalChainLink` (imported from checker.ts, not reimplemented) replaces every bare `e.optional` check
gating `emitOptionalAccess` in `case 'member'`/`case 'index'`/the `case 'call'` method-dispatch branch.
`rejectChainedOptional` deleted (zero remaining callers -- every site that used to call it now either
handles the chain or is provably unreachable). No new "flatten the whole chain into one guard" machinery
needed: `emitAs(e.object, ctx, objWtype)` already recurses into `e.object` (itself possibly *another* chain
link), so each link just gets its own independent null check on whatever came before -- N nested `if`s
instead of one flat guard, but observably identical to a real single short-circuit (no side effect runs
twice, each link's object is materialized into its own scratch local exactly once). Simpler to get right
than flattening, and this file already leans "correct first" over "most compact" elsewhere.

Verified with real WASM execution across every shape in one pass: 2-step non-optional continuation
(`a?.b.c`), 2-step both-optional (`a?.b?.c`), 3-step (`a?.b.c.d`), a chain continuing through a method call
and through an index access, each with both the null and non-null branch actually exercised (not just
"compiles") -- 12/12. Converted the old suite's `checkThrows("chaining... is rejected")` test into 4 real
positive checks (per [[feedback_no_unimplemented_throws_tests]], now that the feature ships) -- suite
271→275 (4 new real checks, 1 stale throw-test removed), full green. Remaining, deliberately unchanged:
chaining onto a *getter* still throws (a separate, narrower gap, not part of this fix), a guarded method
call must still be a plain user method (not `Math`/intrinsic) and can't return `void`.

## Nested function declarations (2026-08-17)

User asked "what would support entail?" after hitting `towasm: unsupported statement 'function_decl'`
from a test fixture that nested a helper `function` inside another function's body (a `function_decl`
used as a *statement*, distinct from a top-level one and from `case 'arrow'/'function'` *expression*
closures, which already worked). Sized it, then implemented the agreed "narrow version": self-recursion
supported, hoisting explicitly out of scope (only callable from below its own declaration point in the
same block, like a `let`/`const` would be).

Confirmed most of the machinery already existed and only needed extraction + wiring, not new design:
the `{code, env}` wasm-GC closure struct built by `case 'arrow'/'function'` (towasm.ts, now factored out
into a shared `emitClosureLiteral(e, ctx, isArrow, selfName, allowSelfCall)`), plus `case 'call'`'s
pre-existing bare-identifier-closure branch (a named local of `{closure}` type called via `call_ref`)
already handled "call a locally-bound closure by name" generically. New `case 'function_decl'` in
`emitStmt` just calls the shared helper and binds the result to a named local the same way `var_decl`
would.

The one genuinely new piece: self-recursion. A closure can't capture itself as a struct field (the
struct doesn't exist yet while it's being built), so instead of routing a recursive call through the
env struct, `FuncCtx` gained `selfCall?: { name, funcIndex, params, result, hasRest }` -- set only for
`function_decl` (never for named function *expressions*, which still forbid self-reference exactly as
before). A call to `selfCall.name` from inside the function's own body resolves to a direct, statically
-known `call funcIndex` (reusing the same env local), not a `call_ref` -- cheaper than the general
closure-call path and sidesteps the chicken-and-egg struct-patching alternative entirely.

Also fixed a real, necessary correctness gap in the free-variable analysis: `ownBoundNames`/
`collectFreeVars` (used by every closure, not just the new statement form) previously only treated
`arrow`/`function` *expressions* as closure boundaries when walking a body -- a nested `function_decl`
*statement* fell through with no boundary at all, so an enclosing closure's free-var scan would have
wrongly descended into a nested function's own body and misattributed its params/locals as free/bound
in the wrong scope. Both helpers now special-case `s.type === 'function_decl'` (bind its name, stop
descent, recurse under its own merged bound set) mirroring the existing expression-boundary handling
exactly.

Checker required zero changes -- `hoist()` (checker.ts) already fully hoists+type-checks every
`function_decl` generically for any block-shaped scope via `checkBlock`, including nested ones and
recursive self-reference; only towasm.ts's codegen lacked support.

5 new permanent tests in test-towasm.ts (`basic`, `capturesOuter`, `recursive`,
`recursiveWithCapture`, and a `checkThrows` for the no-hoisting restriction) -- all verified against
real WASM execution first via a throwaway probe, predictions matched exactly, then made permanent.
Suite 298→303, full green. Gap comment's "Functions" category gained two narrow items: calling above
the declaration point (no hoisting) and referencing itself as a value rather than calling it directly
(only `name(...)` inside its own body works, e.g. not returning/reassigning itself -- hits the same
generic `throw "unknown"` unresolved-identifier fallback every other truly-unresolved name would).

## Async/await + generators -- design plan approved, checkpoint 1 landed (2026-08-17)

The last big gap-comment category ("Async": async/await, Promises, generators) -- sized via a full
plan-mode pass (agreed plan saved at `~/.claude/plans/golden-baking-pelican.md`), user picked the
ambitious-but-correct scope for both (real suspend/resume generators, real internal microtask
scheduler for async), not the cheaper eager/sugar alternatives, since both need the same underlying
mechanism anyway. Two user-directed design corrections during planning, both kept: (1) the
CFG-flattening pass belongs in `transform.ts` (general, backend-agnostic AST transform, same as
`foldConstants`), not `towasm.ts`; (2) the generator instance should be a real *nominal* lib class,
not a bespoke native struct+intrinsic-dispatch path.

**Checker needs zero changes** (confirmed by reading, not assumed) -- `checkFunctionBody` already
infers `Generator<Y,R,N>`/wraps `Promise<T>`, purely nominally (no real `interface
Promise`/`Generator` needs to exist). **One real pre-existing checker quirk found the hard way**:
`checkStmt`'s own `case 'function_decl'` calls `checkFunctionBody(..., hasMod(stmt,'generator'),
hasMod(stmt,'generator'), err)` -- passing the SAME `hasMod(...,'generator')` for both the 5th
(`skipReturn`) and 6th (`generator`) params. `skipReturn=true` forces `expected=undefined`
regardless of the user's own explicit declared return type, so `checkFunctionBody`'s inference
branch always overwrites `decl.returnType` in place with `N` hardcoded to `T.ANY` -- but this
mutation happens on the same shared AST node returned by `hoist()`'s OWN earlier, separate
`scope.addValue(name, t)` snapshot (used by every *call-site* type query, e.g. `checkerTypeOf`),
which is NOT re-derived afterward. Net effect: `decl.returnType.typeArgs[2]` (read directly) and
what a call site resolves for the same function's return type *disagree* -- the declared `N` stays
intact for callers, but becomes `any` if you read the FunctionDecl's own mutated node. Fixed on the
towasm.ts side (checker.ts intentionally untouched, out of scope): `compileGeneratorFunc` resolves
`Y,R,N` via `(global.value(name) as TS.FunctionType).returnType`, the exact same scope-lookup path a
real call site uses, instead of `decl.returnType` -- keeps class-identity (composite generic cache
key) consistent with what every caller of the generator function sees.

**Design, once built**: a `function*` compiles to two real wasm functions -- the exported name
itself (never runs the body; just builds a fresh frame, state=0, and returns `new
Generator(stepClosure)`, matching real JS's own "nothing runs before the first `.next()`"), and a
separate resumable "step" function with *exactly* the shape an ordinary arrow/function-expression
closure already has (`{code, env}`, `ensureClosureType`) -- the env doubles as the *frame* (v1: just
a `state: i32` field, `supertypes:[ensureEnvBase()]` matching a real closure env's own subtyping
requirement). `Generator<Y,R,N>`/`IteratorResult<Y,R>` (new `lib/generator.ts`) are ordinary generic
lib classes, not anything native -- `IteratorResult` as a real class (not an anonymous `{value,
done}` object type) specifically to avoid needing to generalize `ensureObjectShape`'s narrow
non-generic restriction. `Generator`'s `.next(v)` calling its own closure-typed `step` FIELD taught
`emitMethodCall` a genuinely new, general capability: calling a closure through a class field (not
just a bare identifier local, `case 'call'`'s pre-existing path) -- checked right where `ensureMethod`
would otherwise throw "unknown method", falls back to a field lookup + the same call_ref dance.

**The resumable step function's own dispatch** (`emitGeneratorDispatch`) directly generalizes `case
'switch'`'s existing nested-block/`br_table` cascade (innermost = state 0) from "jump to case i" to
"jump to resume state i", plus one extra outermost block (id === segments.length) as the "already
done" landing point -- reached once `state` is pinned there by either the natural-completion arm or
an explicit `return` (which is the SAME shape, factored via a new `FuncCtx.generatorFrame` field
checked first in `case 'return'`, exactly mirroring the pre-existing `appendThisOnReturn`/`ctorThis`
special-casing precedent). A real generator-past-completion call correctly resets `value` to the
type's default (`emitDefaultValue`, reused unchanged from the array-literal-holes work) with
`done:true` forever after, matching real JS semantics (confirmed by testing, not assumed -- my first
test draft wrongly expected the *original* return value to persist, caught immediately by running
it). Checkpoint 1 deliberately narrow: `flattenStateMachine` (transform.ts) only splits a *flat*
top-level statement list at `yield`/`await` boundaries recognized in statement position (bare
expression statement, `return await x`, single-declarator `const v = yield x`) -- a suspend point
anywhere else (nested in `if`/`while`/`for`, or embedded in a larger expression) throws a clear "not
yet supported" via a generic `containsSuspend` walk (stops at nested closure boundaries, same
reasoning as `ownBoundNames`/`collectFreeVars`). No params, no locals live across a yield, no
captures yet either -- next checkpoint's job, same as the frame only ever holding `state` right now.

2 new permanent tests (a real yield/yield/return generator run through 4 `.next()` calls including
one past completion, and the nested-yield rejection) -- suite 303→305, full green. Verified via the
same real-WASM-execution discipline as every other feature. Gap comment left untouched deliberately
(plan's own step 5: update it once, at the end, after later checkpoints land -- not yet accurate to
call "generators" a flat unsupported bullet anymore, but not worth a half-finished rewrite mid-way).
Known deferred/unverified edge: a generator with an inferred/declared `void` return type (`R=void`)
was avoided in both checkpoint-1 tests (risk: `IteratorResult<Y,R>`'s `value: Y|R` field becomes a
`number|void`-shaped union, untested territory for `typeOf`'s union handling) -- not yet confirmed
either way, flagged for whichever checkpoint first needs it.

## Checkpoint 2: control flow + local hoisting, merged (2026-08-17, same session)

Real, load-bearing scope discovery mid-checkpoint: "yield inside a loop" is nearly useless without
also hoisting the loop's own counter/accumulator into the frame -- `for (let i=0;i<3;i++) yield i;`
needs `i` to survive every suspend, which the plan's own checkpoint 3 ("locals/captures") was going
to handle separately. Merged the two rather than shipping a control-flow skeleton that couldn't
express any realistic loop; real closures (capturing from an *enclosing* function) and params stayed
deferred, since those are more self-contained additions once whole-function hoisting exists.

**transform.ts's `flattenStateMachine` fully rewritten** (checkpoint 1's version only split a flat
top-level list). New `SegmentNext` union: `'goto'`/`'branch'` (real jumps, not structured wasm
nesting -- a *resumed* call has none of the original call's block/loop context left) alongside the
existing `'suspend'`, plus `'complete'` (checkpoint 1's synthetic "done" block, now a first-class
segment the flattener itself reserves and defines, not something towasm.ts bolted on after). A new
`Builder` (`reserve()`/`define()`) lets a branch's own 'then'/'else' or a loop head reference a
forward id before its content exists. Processes each statement list **backward** (`flattenList`) --
by the time a statement's own lowering runs, everything textually after it in the same list is
already built, so "what happens next" is always a concrete, already-known id, never a forward
reference needing a later patch. `if`/`while`/`do_while`/`for` (normal only) each get their own
lowering (`flattenControlFlow`) built on this; a nested bare `{...}` block recurses through the same
`flattenList`. `containsOwnBreakOrContinue` (stops at a nested loop/switch's own scope, same
reasoning as `case 'switch'`'s scoping) rejects `break`/`continue` crossing a yield-containing loop
as a clean, deferred "not yet supported" -- the original wasm block/loop nesting a real break/continue
`br` would need doesn't survive being flattened into state transitions, and building the "convert
break/continue into a goto to the loop's own break/continue target segment" version wasn't attempted
this round. New `collectHoistedLocals` -- every plain-identifier (not destructured) `var_decl` name
anywhere in the body, paired with its declaring statement (for that statement's own checker-stamped
scope, needed later) -- stops at a nested closure boundary. Conservative: hoists every declared local,
not just ones actually live across a suspend (no liveness analysis) -- simple and correct, a local
that never crosses a yield just costs an unused frame field.

**towasm.ts's `emitGeneratorDispatch` rewritten**: the whole n-block dispatch cascade (unchanged
shape from checkpoint 1, still directly generalizing `case 'switch'`'s own lowering) now sits inside
one more outer `loop` -- a `'goto'`/`'branch'` arm writes the new state then `br`s back to the loop
head (redispatch), reusing the exact `ctx.depth`-relative-offset pattern `case 'continue'` already
uses for its own break/continue targets (a local `loopMark`, not `ctx.breakTargets`/`continueTargets`
-- deliberately kept separate from real user break/continue bookkeeping, different abstraction level).
`'complete'` is now just one more segment's own arm (same code as checkpoint 1's synthetic block),
reached however many segments actually route a `goto`/branch to it.

**`compileGeneratorFunc`**: builds the frame's extra fields from `collectHoistedLocals`, wires
`fnCtx.closureEnv` with them *before* compiling the body -- `case 'identifier'`/`emitAssignTarget`
already route a `closureEnv.fields` entry through `struct.get`/`struct.set` unchanged (the exact same
mechanism a real closure capture already uses); `case 'var_decl'` gained the one new branch needed:
when its own name is already a frame field, *write* to it instead of calling `declareValue`
(allocating a real wasm local). Kept "no params" as-is (deferred to checkpoint 3, same as real
closures) to bound scope.

**Three real bugs, found by running, not review:**
1. **Wrong entry state.** `flattenStateMachine` reserves `completeId` *first* (id 0) for a natural
   reason (needs it before flattening the body, to thread through as every "falls off the end"
   target) -- but the frame's initial state comes from `struct.new_default`'s implicit zero, which
   then pointed straight at the "done" segment instead of the real body entry whenever the entry
   wasn't *also* id 0. Fixed by adding `entryId` to `StateMachine`'s own return value and having the
   outer wrapper function explicitly write it into the fresh frame's state field, never relying on
   the implicit zero.
2. **Hoisted field type disagreed with its own write.** Computing each hoisted local's frame-field
   type via `checkerTypeOf` alone (default-widened, e.g. `number`→f64) diverged from what `case
   'var_decl'`'s *own* real fallback chain (`typeAnnotation ?? widenedTypes.get(d) ?? T.literalTypeOf
   (d.init)`) picks when it actually compiles the write -- a small integer literal like `let i = 0`
   defaults to the *narrower* `i32` there, corrupting the very first assignment into an f64-typed
   field (`WebAssembly.Module(): struct.set expected type f64, found i32.const`). An ordinary
   (non-hoisted) local never hits this, because its own declaration and every later read/write all go
   through the *same* self-consistent wasm local slot -- only splitting the type decision into two
   separate computations (frame field vs. actual write) could disagree. Fixed by mirroring `case
   'var_decl'`'s exact fallback chain for the frame-field computation too (including reusing one
   shared `collectRangeWidenings(decl.body!, libGlobal)` call for both), so field and write always
   agree *by construction* -- which of i32/f64 wins doesn't matter (`emitAs`/`coerceTop` widen at every
   *use* site regardless, e.g. `yield i` against a `number`-typed generator), only that they agree.
   Along the way, confirmed `collectRangeWidenings` itself doesn't track `++`/`--` as a "touch" at all
   (only `=`/compound-assign) -- a real, narrower pre-existing gap, not touched (ordinary locals never
   need it to matter; noted here in case it resurfaces).
3. **Not a towasm bug**: two new tests' own `Generator<number, void, number>` declarations were
   fine, but returning `g.next(0).value` directly as a plain `number` from the outer test function
   failed *type-checking* (`number | void` not assignable to `number`) -- confirmed a generator's `R`
   is *always* re-inferred by the checker from actual `return` statements (`skipReturn` forced true
   for every generator, same mechanism behind the earlier `N`-forced-to-`any` finding), so a body with
   no `return` gets `R=void` regardless of what's declared, making `IteratorResult.value` a real
   `Y|void` union. Fixed the tests (`.done ? 1 : 0` instead of `.value`), not towasm.ts.

4 new permanent tests (a `for` loop with its own hoisted counter, `break`/`continue`-crossing-yield
rejection, yield-embedded-in-an-expression rejection, `if`/`else` with and without an alternate, and
a `while` with an accumulator *alongside* the loop counter -- two hoisted locals, not just one) plus
converting checkpoint 1's now-obsolete "nested yield is rejected" test into the real `for`-loop
positive test above. Suite 305→309, full green.

## Checkpoint 3a: generator params + two-way `.next(v)` (2026-08-17, same session)

Two more pieces bundled from the plan's own checkpoint 3, both landed; "real closures" (a generator
capturing an *enclosing function's* own free variables, not just top-level names) deliberately
deferred separately -- see below.

**Params**: `compileGeneratorFunc`'s "no params" throw lifted; each param validated plain-identifier/
no-default/non-optional (same narrow scope as everywhere else params get restricted in this file),
resolved via the existing `resolveParam` (already used by `compileFunc`, no new type-resolution logic
needed -- params always have an explicit annotation in this compiler, unlike a hoisted local's
literal-narrowing ambiguity). Given frame fields exactly like a hoisted local (same `localFields` map,
so `case 'identifier'`/`emitAssignTarget`/`case 'var_decl'` all already handle them for free) --
`collectHoistedLocals`'s own separate walk just skips a name already claimed by a param. The outer
wrapper (`name(...)`) now has real wasm params (`registerFunc(toParams2(params), ...)`,
`ctx.declareParams(params)`) and copies each one from its own local into the matching frame field
right after `struct.new_default`, same idea as the already-existing explicit `entryId` write.

**Two-way `.next(v)`**: `SegmentNext`'s `'suspend'.resultVar` (`const v = yield x;`) was already
threaded through the flattener since checkpoint 1, just rejected on the towasm.ts side. `v` needed no
new hoisting logic either -- `collectHoistedLocals`'s generic `var_decl` walk already picks it up
(the declarator is a real one in the source, just with a `yield` initializer). The one new piece:
`emitGeneratorDispatch` builds a `sentBindings: Map<resumeSegmentId, frameFieldIndex>` (a suspending
segment's own `resultVar` lives on *its* `next`, but the write has to happen on the *resume* side --
a segment doesn't know its own incoming bindings otherwise, so this reverse map is built once up
front) and, right before running a resume segment's own `stmts`, writes the step function's own
`#sent` wasm param into that field.

**Two real bugs, both from the same root cause** (checker's `N` forced to `T.ANY` for *every*
generator, not just where `decl.returnType` itself is read -- see checkpoint 1's own finding): a
`const v = yield x;` declarator's frame-field type was being computed via `checkerTypeOf(d.init,
scope)` same as any other hoisted local, but `d.init` here is a bare `yield` *expression*, whose
checker-computed type is *always* `any` (mirroring the forced-`N`-any behavior), not the real,
resolved `N` the generator actually declared -- produced an `anyref` field being written an `f64`
sent value (`struct.set expected type (ref any), found f64`). Fixed by special-casing `d.init.type
=== 'yield'` in the hoisted-field-type fallback chain to use the already-resolved `N` directly,
skipping `checkerTypeOf` for that one case -- safe because the *actual* write (the `sentBindings`
mechanism above, using `#sent`'s own `nWtype`-typed param) never goes through `case 'var_decl'` at
all for a suspend-boundary declarator, so there's no separate "real write" computation it could
disagree with the way a hoisted local's literal-narrowing could (checkpoint 2's bug 2).

2 new permanent tests (real parameters read across every suspend in a `while` loop, and two-way
`const v = yield x;` binding across three `.next()` calls). Suite 309→311, full green.

**Deferred, not attempted**: a generator nested inside another function/closure, capturing *that*
function's own local variables (as opposed to top-level names, which already work today --
`compileGeneratorFunc`'s own `fnCtx` scope chains up through `libGlobal` same as any top-level
function). Would need free-variable capture (`collectFreeVars`, the same mechanism
`emitClosureLiteral` already uses) merged into the frame alongside params/hoisted locals, plus
`emitClosureLiteral` itself taught to route a `hasMod(e,'generator')` literal into a
`compileGeneratorFunc`-equivalent path instead of its current explicit throw. Real, non-trivial
overlap between the two mechanisms that would be worth actually unifying rather than duplicating, not
attempted this round given the value/effort tradeoff versus checkpoints 4/5 (a nested-generator
capturing enclosing locals is a comparatively rare pattern; top-level generators cover the common case
today).

## Checkpoint 4a: async/await core landed (2026-08-17/18, same session)

`compileAsyncFunc`/`emitAsyncDispatch` -- reuses the exact same frame/`flattenStateMachine`/loop+block
dispatch machinery generators use, but driven completely differently: a generator waits for an
external `.next()` call to run any code at all; an async function's body runs *immediately*,
synchronously, up to its first real suspend or its own completion, and nothing external ever "asks"
it to resume -- a suspended `await` instead registers a continuation via `Promise.then()`, so whichever
other compiled code eventually calls `.resolve()` on the awaited promise is what re-enters the step
function next. Consequences that shaped the design: the step function needs no `IteratorResult`-shaped
result at all (`void` -- nothing ever reads one) and needs no generic `{code,env}` closure-literal
shape either (nothing ever calls it *through* a stored closure value -- both callers, the outer
wrapper's one-shot kickoff and every `await`-site trampoline, always call its own real `funcIndex`
directly) -- so the frame is simply the step function's first real param, no `envBase`/`ref.cast`
indirection needed the way a generator's own step function requires.

**New `lib/promise.ts`**: `Promise<T>` with `resolve`/`then` as real public methods (not the standard
executor-callback constructor -- `resolve` being callable directly is all this codegen itself ever
needs, since it always resolves its own result Promise directly, never through a captured closure).
Constructor takes an `initial: T` -- there's no generic "default T" expressible in source for an
unconstrained type param, and every field needs a real assignment somewhere in the constructor
(confirmed: `struct.new_default` alone isn't just permissive defaulting, the compiler requires every
constructor to assign every field or throws) -- `initial`'s own value is thrown away the moment
`resolve()` first runs for real.

**Two-way sent-value threading generalizes cleanly from a generator's fixed `N`**: since an async
function's resumed value type varies *per await site* (whatever that specific `Promise<T>` happens to
be, not one fixed type for the whole function the way a generator's `.next(v: N)` is), the step
function's own `#sent` param is `anyref` uniformly, boxed/unboxed per site. Boxing (a settled value ->
`anyref`, inside a trampoline) and unboxing (`#sent` back to the frame field's real type, at a resume
site) both needed a real, general fix to `coerceTop` itself, not one-off code: (1) `'closure' in got`
was missing from the ref/arr "already valid anyref, widen for free" branch -- a closure struct is a
real wasm-GC struct too (surfaced storing a `(value:T)=>void` closure into `Array<...>`, e.g.
`Promise`'s own `callbacks` list); (2) narrowing anyref back down to a *bare scalar* had no
implementation at all before now (silently did nothing) -- added, reusing the exact box shape a
scalar->any box already uses (`ensureBoxType`) so the two sides agree by construction.

**Trampolines**: one per distinct awaited element type per async function (memoized by
`wasmTypeKey`), built via the same `ensureClosureType` every ordinary closure literal already uses --
env = the frame itself directly (a real subtype of `$envBase`, so no wrapping needed), body just
unboxes (`coerceTop`) and forwards into `stepFuncIndex` directly. `.then()` on an *already-settled*
promise invokes its callback synchronously, so a trampoline can call back into `stepFuncIndex`
*reentrantly*, before the `.then()` call that triggered it has itself returned -- confirmed safe by
construction (this arm's own code always ends in `return` immediately after the `.then()` call, so the
reentrant call's work is never redone) and by testing (an already-settled await resumes correctly).

**Four real bugs found by running, none by review:**
1. A method-call closure read straight off an array element (`cbs[i](value)`) isn't supported (only a
   bare identifier or a class field is) -- `resolve()`'s own callback-firing loop needed to bind
   `cbs[i]` to a local first. Not a towasm.ts fix -- a `lib/promise.ts` authoring fix, working within
   the existing (real, documented) limitation rather than lifting it.
2. `struct.new_default` on the frame fails outright the moment *any* field is a non-nullable
   object type (e.g. a `Promise<T>`-typed param) -- wasm-GC requires every field of a defaulted struct
   be defaultable, and a non-null ref never is. Fixed generally, not by throwing: both
   `compileGeneratorFunc` and `compileAsyncFunc`'s frame construction now build the frame via one real
   `struct.new` (every field's actual value pushed in declared order -- a param's real value from the
   wrapper's own local, a not-yet-initialized hoisted local's value from `emitDefaultValue`, which
   itself still throws its own clear error for a non-nullable-ref hoisted local specifically -- that
   narrower case deliberately not solved this round) instead of `struct.new_default` + later
   `struct.set`s. Retroactively simplified `compileGeneratorFunc`'s own construction site too (one
   `struct.new` instead of a scratch local + N `struct.set`s).
3. The two `coerceTop` gaps above (closure->any widening, any->scalar narrowing).
4. **The subtlest one**: the synchronous (non-Promise) `await` fast path writes its `resultVar`
   directly, inline, *before* transitioning state -- but the generic `sentBindings` reverse-lookup
   (built once, upfront, from every 'suspend' segment's own `resultVar`) didn't distinguish that from a
   real Promise suspension's resume, so the resume segment's own code *also* tried to overwrite the
   same field from `#sent` -- silently clobbering the just-written correct value with whatever `#sent`
   happened to hold from a previous, unrelated call (confirmed via a real test: `await` on a plain
   `number` read back `0` instead of the actual value). Fixed by gating `sentBindings`'s own
   construction on `T.asPromiseRef(...)` too, matching the same check `emitNext`'s 'suspend' handling
   itself uses to choose the fast path in the first place -- the two must agree, not just each look
   locally reasonable.

4 new permanent tests (await on an already-settled Promise -- exercises the synchronous `.then()`-fires-
immediately path and the reentrant-call safety above; await on a not-yet-settled Promise, resolved
*after* the async call returns -- exercises a real suspend/later-resume; two sequential awaits in one
function; awaiting a non-Promise value). Suite 311→315, full green. Verified with real WASM execution
throughout, same discipline as every other feature this session.

**Not yet attempted**: `Promise.all`/`race`/`any`/`allSettled`, `for await...of`, generic async
functions, an async function nested in an enclosing closure (same deferred shape as generator
checkpoint 3b), `try`/`catch` around `await` (blocked on the pre-existing, separate exceptions gap).
The gap comment itself hasn't been updated yet either (plan's own step 5, still pending) -- it still
lists async/await/Promises as a flat unsupported bullet, no longer accurate.

**Follow-up dedup (same session, user-requested)**: `compileGeneratorFunc`/`compileAsyncFunc` and
`emitGeneratorDispatch`/`emitAsyncDispatch` had gone in duplicating a lot of near-identical structure
during the checkpoint-4 rush. Extracted three shared pieces, all via plain callbacks/params (no class,
no shared mutable state): `resolveResumableParams(kind, decl)` (param validation, identical either
way bar wording), `buildFrameFields(kind, decl, params, widenedTypes, resumeValueType?)` (state+param+
hoisted-local field map -- `resumeValueType` is the one real behavioral fork, generator's own `N`
override for `const v = yield x;`, which async never passes), and `emitResumableDispatch(...,
onSegmentStart, onSuspend, onComplete)` (the whole loop+block+`br_table` dispatch skeleton -- 'goto'/
'branch' are handled inside it directly since they're byte-for-byte identical either way; 'suspend'/
'complete' are always-return callbacks, no shared fallthrough case needed). Real payoff isn't line
count (the extracted helpers have their own overhead) -- it's that the trickiest, most bug-prone part
of this whole feature (the dispatch skeleton, source of 3 of the session's real bugs) now has exactly
one implementation instead of two that could silently drift apart. Suite stayed 315/315 throughout,
confirming the refactor is behavior-preserving.

## Checkpoint 4b: `Promise.all` landed, plus 3 unrelated gaps found along the way (2026-08-18)

`static all<U>(promises: Promise<U>[]): Promise<U[]>` added to `lib/promise.ts` -- ordinary compiled
TS, no native code: a real `Array<U>` accumulator, resolves the returned `Promise<U[]>` once every
input has settled (order-independent), rejection not modeled (matching the rest of the file). One
real implementation subtlety: `remaining` (the countdown) is a *single-element `Array<number>`*, not a
plain captured local -- a captured variable snapshots by value at each closure's own creation time (an
already-known, documented limitation), so decrementing it inside one of the `promises.length` `.then()`
callbacks would be invisible to the others; mutating an *array element* instead writes through the one
shared heap object every closure alike captured a reference to, which does propagate. `idx` (bound
fresh each loop iteration) needs no such trick -- it's read-only inside its own closure.

**User caught a real simplification**: the hand-written index loop in `resolve()`'s own callback-firing
(`for (let i = 0; i < cbs.length; i++) { const cb = cbs[i]; cb(value); }`, written that way specifically
to work around "calling a closure read straight off an array element in one expression isn't
supported") -- asked "any reason not to use for...of?" Verified and switched: `for (const cb of
this.callbacks) cb(value);` already desugars to the identical index-read-into-a-real-local shape
(`for-of` over a plain array was established working earlier this session), so it sidesteps the exact
same limitation for free, more idiomatically. No downside found; suite stayed green after switching.

**Three real, general bugs found chasing this, none actually about `Promise.all` itself:**
1. **Static generic method type-param name collision.** `Promise.all<T>(...)` (matching the class's
   own `T`) compiled to a call whose *return type* came back `Promise<any[]>` instead of
   `Promise<number[]>`, even with the type argument passed explicitly at the call site --
   `staticTypeArgsFor` (towasm.ts) deliberately fills a static member's *own* class-instantiation with
   `T.ANY` for every one of the class's type params (correct: real TS forbids a static from
   referencing the class's own T at all) -- but when the *method's own* separate generic type param
   happens to share that same name, its substitution collides with the class's own `T.ANY` filler
   somewhere in the shared generic-method machinery. Root cause not tracked down further (would mean
   digging into shared generic-method substitution code, real risk for a static-only edge case) --
   worked around by simply naming the method's own type param `U` instead of `T`, which fixed it
   completely. A real, standing gap for any *other* static generic method that happens to reuse its
   own class's type-param name -- not documented in the gap comment yet (arguably belongs there).
2. **A top-level `let`/`const` with a negative-literal initializer never becomes a real wasm global.**
   `let output: number = -1;` throws `"unresolved identifier 'output'"` from *any* function that
   references it (not async/generator-specific -- confirmed via a from-scratch repro with no
   suspend/closure involved at all). Root cause: the eager top-level-global-registration scan
   (`TStoWasm`, the loop building `promotedConsts`) only recognizes a *bare* `d.init.type ===
   'literal'` node as "a compile-time constant" -- `-1` parses as `unary(-, literal(1))`, not a bare
   literal, so it's silently skipped by that scan, and nothing else ever registers it (the *only*
   other path that populates `globals`, `case 'identifier'`'s own lazy fallback, is gated behind
   `LIB_DECL_MAP` -- built-in library globals only, never a user declaration). A real, general,
   previously-unknown gap, found purely incidentally while debugging an unrelated `Promise.all` test
   failure -- worked around in the test itself (a `0`/`999` sentinel instead of `-1`/`999`), not fixed.
3. **A real closure referencing a top-level global throws "unresolved identifier."** `array.forEach(x
   => someGlobal += x)`-style code doesn't work: `emitClosureLiteral`'s own free-variable validation
   (`collectFreeVars` finds the global name as "free", then checks `ctx.resolvesName(name)`) never
   consults `globals` at all -- only real locals and captured fields. Note this is *not* the
   already-documented "closures capture by value, mutations don't propagate to the enclosing scope"
   limitation -- this is a stricter, earlier failure: referencing a *global* from inside a closure
   literal doesn't even compile, full stop, regardless of read vs. write. Writing to a global from
   *inside* an async/generator step function's own body already works fine (confirmed repeatedly this
   session) -- this gap is specific to a real, separate closure *literal* (arrow/function expression).
   Worked around in the `Promise.all` test by using a bare `await` (no `.then()` closure) instead.

1 new permanent test (`Promise.all` resolving only once all three inputs settle, order-independent,
verified via a bare `await` + a global side-channel to sidestep gaps 2 and 3 above). Suite 315→316,
full green. None of the three gaps above were fixed -- all real, all worth carrying forward, none
touched given the risk/effort of digging into shared substitution/closure-capture machinery this late
in an already-very-large session.

## Checkpoint 5 + two of the three gaps above actually fixed (2026-08-18, later same session)

User explicitly asked to fix-or-document gap 2 (negative-literal globals) and the array-index-call
limitation, plus "any other things like that" -- folded into checkpoint 5 (the gap-comment update)
since it's the same task.

**Gap 2 (negative-literal top-level globals) -- fixed for real, not worked around.** The eager
global-registration scan now runs each initializer through `foldConstants` (already imported, already
`case 'switch'`'s own jump-table-detection idiom) before checking `.type === 'literal'`, so `-1`
(`unary(-, literal(1))`) and any other foldable expression is recognized as a compile-time constant.
Verified via probe, then via the full suite, then via a new permanent test (`negGlobal`, `-1 * 958 ===
-958`).

**Array-index closure calls (`arr[i](x)`) -- fixed for the common case (inline function types).** New
branch in `emitExpr`'s `case 'call'`, right before the final "only direct calls to named
functions..." throw: `e.callee.type === 'index'` resolves the callee's `WasmType` via `wtypeOf`
(generalizing the existing bare-identifier closure-call path from a name-based lookup to an
arbitrary-expression-based one), and if it's a closure type, emits the same
`emitAs`-then-`struct.get`/`call_ref` sequence the identifier and member-callee cases already use.
Verified via a permanent test (`indexCall`, two array elements of inline closure type, called
directly at different indices, summed).

**Found in the process, NOT fixed, a narrower sub-gap of the same feature**: the array-index-call fix
does *not* work when the array's element type is a named type alias to a function type (`type Fn = ()
=> number; arr: Fn[]`) rather than an inline one (`arr: (() => number)[]`) -- `wtypeOf`'s
`checkerTypeOf(...)` returns an unresolved `{type:'ref', name:'Fn', declScope:{...}}` in this
position, and `typeOf`'s `T.resolve(global, t)` never expands it to the underlying function type,
even though `t.declScope` is present. Ruled out "aliased function types can never resolve" as the
cause first (a plain `const f: Fn = () => 42; f();` compiles and runs fine -- same alias, different
position) -- so the bug is specific to whatever makes the array-element-type ref's `declScope` wrong
or unusable, not a blanket alias limitation. Likely mechanism (not confirmed by tracing the actual
call site, given the known fragility of this exact area -- see
[[tison_declscope_investigation]]'s "3-time-reverted" history): `stampScope` (type-utils.ts) skips any
`ref` that already carries a `declScope`, mutating in place -- if the `Fn` ref node reused from the
`Array<Fn>` type-args list gets stamped once, early, under the wrong (too-narrow) scope during some
earlier generic-instantiation/substitution pass, it stays stuck with that wrong scope permanently,
even though the *same syntactic alias* used directly in a var-decl's type annotation never goes
through that path and resolves correctly via the ambient scope instead. Deliberately not attempted as
a real fix this session, given the declScope area's documented history of subtle regressions -- 
documented as a narrow, precise gap-comment bullet instead (bind the array element to a local first,
e.g. via `for...of`, which already takes the working bare-identifier path).

**Also added to the gap comment** (found earlier this session, previously only in code comments, not
the gap comment): closures can't reference a top-level global directly (`emitClosureLiteral`'s
free-variable check never consults `globals`); a static generic method whose own type param shares its
class's type-param name (worked around in `Promise.all` by naming it `U`); a non-nullable ref/array/
closure-typed local hoisted into a generator/async frame without a real initial value before its first
suspend point (`emitDefaultValue`'s own throw). The stale flat "Async: async/await, Promises,
generators -- all unsupported" bullet was replaced with the real, now-narrow list of deferred edges
(`yield*`, `.return()`/`.throw()`, for-of/for-await-of over an iterable, `Promise.race`/`any`/
`allSettled`, the executor form, generic async/generator functions, an async/generator function nested
in an enclosing closure -- checkpoint 3b, still deferred).

**`Promise.all`'s `const idx = i;` confirmed unnecessary, simplified.** User asked directly whether it
was working around something or whether capturing `i` straight would work. Verified via a real-execution
probe (three closures created inside a `for (let i...)` loop, each directly capturing `i` with no
intermediate `const`, called back in reverse order) -- returned the correct distinct per-iteration
values, confirming this compiler's closures already snapshot a loop variable by value at each closure's
own creation time, i.e. real per-iteration `let` semantics, with no shared-mutable-slot bug the way
plain JS `var` would have. Simplified `lib/promise.ts`'s `Promise.all` to capture `i` directly
(`values[i] = v` inside the `.then()` callback, no `const idx = i;` line) -- comment updated to explain
why `i` needs no indirection while `remaining` still does (a captured *variable* snapshots by value,
a mutated *array element* writes through the one shared heap object every closure captured a reference
to).

Full permanent suite: 316 → 318 (two new tests, `negGlobal` and `indexCall`), all green, verified via
the established scratch-copy pattern (`cp test/test-towasm.ts src/examples/test-towasm-scratch.ts`,
fix imports, `tsc -b src/examples --force`, run, delete scratch files + `dist/` outputs) both before
and after the `Promise.all` simplification.

**Mid-session drive-by question, answered, not implemented**: user asked whether WASI exports could be
used to build real asynchrony for `Promise`/async underneath, or exposed via the test harness. Answer
given (not built): plain WASI Preview 1 imports (`poll_oneoff`, `clock_time_get`, etc.) are
synchronous/blocking from the wasm module's own perspective -- a call to them doesn't return control to
the host and resume later, it just blocks the calling thread, so they don't compose with the
suspend/resume model this session's `Promise`/async is built on (would need the still-unstable
stack-switching proposal). The better fit, if ever built: `towasm.ts` already has a real host-import
mechanism (`declare module 'name' {...}` + `LIB_HOST_IMPORTS`, used for existing lib features) -- a
genuinely async-shaped host import (a `setTimeout`-equivalent the JS test harness calls back into an
exported resume function later) would slot into the existing `.then()`/frame-resume machinery for
free. Real WASI Preview 2 async (component model) would compose properly but is a much bigger lift --
a different module/toolchain shape than the single raw wasm module this compiler targets today. Not
acted on further; purely an answered question.

## User's own operator-dispatch refactor broke 3 things -- all found+fixed same session (2026-08-18, later)

User had been hand-refactoring `towasm.ts`'s binary/compound-assignment operator dispatch concurrently
(moving `+`/`-`/`*`/`/`/`%`/comparisons/bitwise/shift out of the old `builtins`-table+`Inline`-returning-
function indirection into a direct inline `switch(method)` in `emitExpr`'s `case 'binary'`, plus new
`WasmScalar`/`WasmScalar0`/`f32` support) and asked "it looks like I broke something in refactoring
operator handling; can you check?" -- found and fixed 3 real regressions, all verified via the full
318-test suite (no regressions) plus targeted probes:
1. **`===`/`!==` on two class instances crashed** (`Point === Point`) -- the old `equalityInline`'s
   `ref.eq` fallback for non-scalar operands never got ported into the new inline dispatch. Fixed by
   adding it back -- then, per user's own explicit request, **moved into the earlier null-comparison
   case block** (`case '===': case '!==': ...`) rather than living inside `default:`'s generic numeric
   switch, since it's conceptually the same category of special-casing. This required a real fix, not
   just a move: `BigInt`'s own `.eq()`/`.compare()` value-equality method must still win over raw
   `ref.eq` structural identity (two distinct-but-equal `BigInt` heap allocations aren't `ref.eq`), so
   the moved check gained a `hasOwnerOp` negative guard (checks `owner.methodDecls?.get(method)`/
   `'compare'` first, without duplicating `default:`'s own dispatch logic) -- caught by a real suite
   failure (`bigEq()`) after the naive move, not by review.
2. **Every compound-assignment operator was completely broken** (`+=`/`-=`/`*=`/`/=`/`%=`/bitwise/
   shift) -- `emitAssign` still looked operators up in the `builtins` table, but the refactor deleted
   every arithmetic/bitwise/comparison entry from it. Fixed via a new `numericOpInline(method, t, ctx)`
   (inside `TStoWasm`, not module-level, so it can declare scratch locals) producing the same `Inline`
   shape `emitAssign`'s existing `coerceTop`+`emitAs`+`ctx.emit`+`coerceTop` structure already expects
   -- necessary because compound assignment reads its target's current value once via
   `emitAssignTarget` and can't re-evaluate `left` through `emitAs` a second time the way the plain
   binary case does.
3. **Plain `/` division was broken for the common (non-i32-context) case** -- the new `case 'div':`
   only handled `want === 'i32'` (an incomplete, half-built integer-division fast path whose own `f64`
   branch even called the wrong-width `i32.trunc_f32_s` on an f64 value) -- ordinary float division fell
   through to "unsupported binary operator '/'". Fixed by making `/` unconditionally float division
   again, matching this file's own established, deliberate design (`[[tison_towasm_2026-08-07_fixes]]`:
   "`/` always-f64, 0/0 no longer traps") -- `i32.div_s` traps on division by zero, which would silently
   reintroduce that exact previously-fixed bug for any `a/0` that happened to want an i32 result.

**User's own follow-up, `%` (mod)**: pointed out mid-fix that `__towasm_mod` (a `lib/number.ts` `__asm<[...]>('...')`-based WAT-text builtin, `i32/i64` -> native `rem_s`, `f32/f64` -> hand-built `x -
trunc(x/y)*y`) no longer fit now that every other operator is a direct native `ctx.emit(...)` in
TypeScript -- "it should be inlined like the other operators". Removed `__towasm_mod` from
`lib/number.ts` and the now-dead `libAsmBuiltin` helper entirely; added `modInstrs(t, ctx)` (inside
`TStoWasm`, same reason as `numericOpInline`) reproducing the exact same instruction sequence natively,
used by both the plain binary case and `numericOpInline`'s own `'mod'` entry.

**A tried-and-reverted `i32.div_s` fast path** (user asked "is there a way to intercept the trap?" for
div-by-zero, then "I suppose I'd prefer the always-f64 approach" once told a branch/guard was the only
option): implemented an `i32`-native fast path for `/` when `want === 'i32'` and both operands are
already `i32`, guarded against the div-by-zero trap via a real `if`/`else` (wasm has no way to catch a
trap at all -- not even via the exception-handling proposal, which only catches thrown exceptions, never
traps) -- verified CORRECT (truncates toward zero matching `ToInt32`, never traps on zero) via a
synthetic probe, but then found via a *second*, more realistic probe (`Uint8Array` arithmetic, the
motivating case) that it **never actually fires** for that case: `a[i]` on a `Uint8Array` desugars to a
`.get()` method call, and `operandInfo` (used only for *operator-dispatch operand typing*, separate from
the real value-producing codegen) reported its type via the checker (`number`/`f64`), not the narrower
transient `i32` the codegen genuinely leaves on the stack -- so `t` never came out `'i32'` there. Given
the guard/locals weren't "free" and the one case that would've paid off didn't reach it anyway, reverted
`/` back to plain, simple, always-correct float division per the user's own preference.

## `operandInfo`'s `'index'` case fixed to prefer the real `get(i)` method signature over the checker's type (2026-08-18, same day)

Direct follow-on from the reverted div-fast-path investigation above: user asked "what is the nature of
the operandInfo gap?" (explicitly ruling out any hardcoded per-type special-casing) -- root-caused
precisely, not guessed: `case 'index'`'s own real codegen (`emitExpr`) already prioritizes
`classOf(e.object, ctx)` + `methodSig(cls, 'get', ctx)` **unconditionally, first** -- any class with its
own `get(i)` method (typed-array views, or any other class using the same general convention) is
authoritative for what physically gets produced, the checker's type never consulted for this at all.
`operandInfo` had the *opposite* priority (checker type first, `classOf(...).inlineMethods?.get('get')`
only as a last-resort fallback when the checker returned `any`) -- and that fallback was itself stale,
checking only `inlineMethods` (the old `__asm`-based-intrinsic convention), not `methodSig`'s fuller
`ensureMethod` path that covers `TypedArray<T>.get`'s current *real, compiled* form (post the
2026-08-07 linear-memory rearchitecture). Separately investigated *why* the checker resolves
`Uint8Array`'s index type to `number` at all rather than `any` (user asked "is it from the indexing
signature?"): traced to `checker.ts`'s own `TYPED_ARRAY_RANGES` name-keyed table (`case 'index'`,
matched by literal `rawObjT.name` *before* any structural resolution), giving real narrowed numeric
*ranges* (`0..255` for `Uint8Array`, etc.) -- a deliberate project-specific enhancement over real
TypeScript (whose own `lib.d.ts` never narrows typed-array reads this way). `TypedArray<T>`'s own real
declared index signature (`typedarray.ts:56`, `[i: i32]: number;` -- genuinely active, unlike the
*commented-out* copy on the ambient `lib.d.ts` interface) exists and makes `a[i]` valid syntax, but the
name-table intercepts before it's ever consulted.

**Fix**: `operandInfo`'s `'index'` case now computes `owner` from the checker (a genuinely TS-level
question with no physical substitute) but `wtype` from `classOf`+`methodSig` first (mirroring
`case 'index'`'s own exact priority), falling back to `arrayKindOf` (raw array physical kind) and only
then the checker's type (for a ref-kind element -- a class/`string` -- which has no narrower physical
form anyway) -- the now-fully-subsumed `getInline`/`inlineMethods`-only fallback deleted entirely.
Verified via a real probe: `a[0] + a[1]` on a `Uint8Array` now compiles to a plain `i32.add` on the two
`get()` call results with exactly one `f64.convert_i32_s` at the function's own return boundary, instead
of converting each operand separately -- confirmed correct (200+3=203) and the full 318-test suite still
green. Generalizes to every operator (`-`/`*`/`<`/`===`/etc), not just `/`, and isn't keyed to any
specific class name.

**User's own follow-up design idea, investigated and shelved (not implemented)**: replace
`TYPED_ARRAY_RANGES`'s name-keyed table by making `i8`/`u8`/`i16`/etc real range-typed global-scope
declarations (via `Scope.addType`, which *can* hold a programmatically-constructed `RangeType` even
though `RangeType` itself is explicitly "not writable in source syntax" -- confirmed via its own
ts-parser.ts comment) instead of the current plain `declare type i32 = number;` aliases, then change
`TypedArray<T>`'s own index signature from `[i: i32]: number;` to `[i: i32]: T;` so ordinary generic
substitution (already general, already working for `indexSignatureOf`'s intersection-aware resolution)
would report the right range per instantiation with zero name-based special-casing anywhere. **Real,
serious blast-radius problem found before implementing**: `isAssignable`'s own `range`-typed-destination
check requires the *source* to also carry known bounds (`toRange` on a bare `number` gives
`{base:'number', integer:false}` with no `min`/`max`, which fails `sr.min !== undefined && ...`) -- so
making `i32`/`u8`/etc real bounded ranges *globally* would break assignability at every one of the
hundreds of existing call sites across nearly the whole lib codebase (`console.ts`/`bigint.ts`/
`array.ts`/`number.ts`/`lib.d.ts`/`regexp.ts`/`string.ts`/`typedarray.ts`) that currently pass a plain,
unranged `number` into an `i32`/`u8`-typed param -- not just the narrow `TypedArray<T>` case it was
meant to fix. User: "it was just a thought, and it doesn't seem we need it right now" -- shelved, not
implemented, `TYPED_ARRAY_RANGES` left as-is.

## Small gap closed to wrap up the session: `coerceTop`'s f64->i32/u32 saturation bug (2026-08-18, later)

Found earlier the same session while probing the (reverted) div-fast-path work, fixed at the user's
explicit ask ("are there any small(ish) gaps that can be closed?") before stopping for the day.
`coerceTop`'s `got === 'f64'` -> `want === 'i32'`/`'u32'` case went through `i64.trunc_sat_f64_s` +
`i32.wrap_i64` (an i64 intermediate) instead of the native `i32.trunc_sat_f64_s`/`_u` instructions that
already exist in `@isopodlabs/binary_libs/wasm`'s own opcode table -- saturating to i64's range *then*
wrapping to i32 discards the saturation for anything outside i32's own range (`+Infinity` saturated to
`i64::MAX` wraps to `-1`, a value with no sensible relationship to the input at all). Fixed by using the
direct native instructions. `NaN` already correctly saturated to `0` (unaffected either way -- matches
real JS's `ToInt32`/`ToUint32`); `±Infinity` now saturates to `i32::MAX`/`MIN` (a real, well-defined,
never-trapping improvement over `-1`, but -- corrected the fix's own first-draft comment, which wrongly
claimed full JS-matching here -- still not bit-perfect JS, since real `ToInt32` gives `0` for *every*
non-finite input, not a saturated bound). This numeric-coercion imprecision (both this non-finite case
and the pre-existing huge-finite-float modulo-2^32-wraparound one) had never actually been added to the
file's own top-of-file gap list despite the "every gap is documented here" convention -- added a new
"Numbers:" category with one combined bullet for both. 3 new permanent tests (`+Infinity`/`-Infinity`/
`NaN` each coerced to i32 via `|0`, confirming non-trapping, not asserting a specific JS-matching value).
Suite 318 -> 321, full green.

## Real cross-runtime portability bug found+fixed via hands-on execution: wasmtime rejects console.log-using modules (2026-08-18, later same day)

Long design conversation (async/timers/threads/standalone-runtime scenarios, all discussion-only, nothing
implemented) ended with the user asking to actually try compiling+running a real 'hello world' via
`tsw.ts` (the project's own CLI wrapper around `TStoWasm`, previously never run end-to-end this session).
Wrote `assistant/hello.ts` (`console.log("Hello, world!")`), compiled via `tsw`, ran it two ways:

- **Node's built-in `node:wasi`**: worked immediately, real `fd_write`-based stdout output (not a
  mocked/spied console) -- confirms `console.log`'s WASI-import codegen is genuinely correct.
- **`wasmtime`** (a real standalone runtime, happened to already be installed): **rejected the module
  outright** -- `incompatible import type for 'wasi_snapshot_preview1::fd_write'`, despite the printed
  signatures on both sides looking identical.

Root-caused, not guessed: traced directly to the "one shared rec group for every type" design from
earlier this session (`[[tison_towasm]]`'s own 2026-08-16 section -- fixed a real `ref.test`/`ref.cast`
bug where two structurally-identical sibling struct types canonicalized into one runtime type). That fix
is correct for struct/array types, but has a real side effect on **func types**: per the actual wasm-GC
spec, canonical type equality considers a type's *whole rec group*, not just its own flat shape -- so
`fd_write`'s import type, bundled as member #0 of one big group containing every unrelated class/array/
closure type, is a genuinely *different* type from the host's own (implicitly singleton) `fd_write` type,
even though the flat signature prints identically. Node's WASI/V8 import-matching path is evidently more
lenient than the spec strictly requires here (masked the bug entirely, both in ad-hoc testing and in the
322-test permanent suite, which only ever runs via plain Node `WebAssembly.Instantiate`); `wasmtime`
enforces the real rule.

**Fix**: `func`-kind types no longer join the shared struct/array rec group at all -- each gets its own
singleton group instead. Sound because `ref.test`/`ref.cast` (the actual reason struct/array types need
shared-group protection) is never applied to a bare func type in this compiler -- a closure wraps its
func type inside a real *struct*, and it's the struct that's `ref.test`ed, never the func type itself. A
singleton group's own canonical form, per spec, is just its own flat shape, so keeping func types isolated
is what lets them correctly match an externally-declared type of the same signature. Implemented as a
run-length scan over the already-built `types[]` array (no reordering, no index remapping needed) --
`SubType`'s own union shape (`CompType | {supertypes, type: CompType, final}`) needed a small
`compTypeOf(t)` helper to read `.kind` either way, since `registerType` always builds the wrapped form but
the type itself doesn't statically guarantee that.

Verified end-to-end, not just re-run through the existing suite: recompiled `hello.ts`, reran under both
Node's `node:wasi` (still works) and `wasmtime run --invoke main hello.wasm` (**now also works**, real
"Hello, world!" printed). New permanent structural test added (`TStoWasm` called directly, not through
`compile()`, to inspect `mod.types.groupSizes`/`types` and assert no `func`-kind type ever lands in a
multi-member group) -- catches a regression of this exact bug without needing `wasmtime` itself as a test
dependency, since Node's own engine doesn't enforce the rule that broke it. Suite 321 -> 322, full green.
`assistant/hello.ts`/`hello.wasm`/`run-wasi.mjs` left in place (not one-off probes -- reusable for further
hands-on runtime-execution checks).

## Self-hosting plan resumed: four real gaps closed, `walker.ts` itself now compiles clean (2026-09-02/03)

Full detail lives in the self-hosting plan doc itself (`~/.claude/plans/witty-plotting-kernighan.md`,
"Session addendum" section) -- this is a pointer + the load-bearing lessons, not a full retelling.

**Trigger**: `tsw` crashed on `dwg/src/crc16.ts` (4 unrelated real bugs, fixed first, commits
`3288458`/`a1b6308`, see the plan doc). That led back into the self-hosting plan itself: attempting to
compile the real `src/examples/walker.ts` (a shared `mapObject`/`mapArray`/`walkB` primitives file,
factored out of TS/PY/CPP's own walkers -- committed as its own isolated hunk, `20b062d`, surgically
separated from a concurrent session's own unrelated, interleaved edits to `checker.ts`/`tocode.ts`/
`transform.ts`/`vsdg.ts` in the same working tree throughout).

**Object.defineProperty -- CLOSED, `99385d2`.** `mapObject`'s own `Object.defineProperty(r, 'pos',
{value: pos, enumerable: false, ...})` (carrying a copy's source position without it being part of the
copy's visible shape) had no representation at all. Built the agreed general mechanism: a synthesized
subclass (`ensureClassExtension`) carrying either real optional fields (statically-enumerable keys) or
one `Map<string,any>` "and others" catch-all field (dynamic keys) -- explicitly not a hardcoded `pos`
field, per the user's own direction ("the plan exists to push what the compiler can handle, not to
end-host one file"). Two real implementation snags: (1) wasm-GC's `final:false`-before-subtyping
requirement needed a *retroactive* patch (`ensureClassExtension` flips an already-finalized struct's
`final` flag back to `false` in-place -- safe since `types[]` stays a plain mutable array until final
serialization) beyond the lazy `ensureGenericFunc` hook, since a base class can get referenced/finalized
by ordinary code before the extending function is ever called; (2) the *write* target's real class is
physically extended but its *checker*-level TS type never reflects that (no real TS syntax for it), so
both the write side (`emitObjectDefineProperty`) and a `case 'member'` read-side fallback resolve via
`ctx.lookup` (the physical local) instead of the checker type.

**Anonymous object-literal shape -- CLOSED, `a250961`.** `matchObjectShape`/`matchObjectShapeByType`
(the structural fallbacks behind `case 'object'`'s own `want`-resolution) only ever matched against
*declared* interfaces/classes -- a bare `const mapSig = {a: ..., b: ...}` (never named via `interface`/
`type X = ...`, exactly `walker.ts`'s own `mapSig`/`mapSigU`) had no target to construct against at all.
Both now fall back to `ensureAnonObjectShape` (already used for a function type's own inline return
position) on zero declared candidates, synthesizing the shape from the checker's own inferred type.
Found-but-not-fixed along the way: `matchObjectShape`'s candidate filter picks by field-*name* set only,
never field *type* -- two shapes sharing field names but differing field types can collide. Flagged, not
touched.

**`T.resolve()`'s `scope.resolving` leak -- CLOSED, `f2ecac7`, type-utils.ts (not towasm.ts itself).**
Root cause of a `switch (m.type)` on a two-interface union throwing `"unknown field 'type'"`. `resolve()`'s
`case 'ref':` reassigned its own `scope` *parameter* to the ref's `declScope` for the lookup -- but
`uncached()` is a closure sharing that binding with `resolve()`'s own resolving-set/cache bookkeeping, so
the enclosing call's cleanup (`scope.resolving.delete(t)`) silently ran against the *wrong* `Scope`
object, permanently leaking a "still resolving" entry onto the real caller's scope. Every later resolve of
that exact type under that exact scope then hit the circular-resolution guard and got back the bare
unresolved ref forever. Fixed by keeping the ref's `declScope` as a local (`refScope`), never reassigning
the shared `scope` param. **Blast radius bigger than the bug report**: 15 previously-silently-*skipped*
tests started passing (every `Uint8Array`/`Int32Array`/`Map` method test, masked behind this same leak via
their own lib type declarations) plus one previously-*failing* test fixed, zero new failures. Traced via a
`WeakMap`-based debug-id scheme tagging distinct `Type`/`Scope` object identities -- the bug is pure
object-identity aliasing, invisible in any JSON/structural dump of the types alone.

**Discriminated-union narrowing inside a `switch` case -- CLOSED, `557ceca`.** With the scope-leak fixed,
`switch (m.type) { case 'm1': return m.a; }` still threw `"'Member2' has no field 'a'"` -- `case
'member'`/`case 'index'`'s own union-dispatch fallback resolved the receiver's type via `ctx.scope` alone
(the function's one static, un-narrowed scope), never consulting the checker's own per-statement narrowed
stamp (`(stmt as any).scope`, `checkStmt`'s `??=`) the way `case 'var_decl'` already did for a narrower,
single-purpose case. Added `FunctionContext.stmtScope` (updated per-statement in `emitStmt`) and
`narrowedTypeOf()` -- **critically gated to consult `stmtScope` only when the receiver's *baseline*
(`ctx.scope`) type is already a union**, not blanket-preferred whenever set. A first, ungated version
regressed the suite hard (457->349 passing): a lib generic method/constructor body's own checker stamp
reflects its *unresolved template* (`TypedArray`/`Array`/`Map` missing their own type args), and a
synthetic towasm-only identifier (`#switch$N`/`#destructure$N`/`#for$N$arr`/...) the checker never stamped
resolves as bare `any` under the stamped scope (it's only ever registered into `ctx.scope`). Two narrower
retry heuristics (retry-on-`any`, then retry-on-still-generic-ref) each fixed some regressions and missed
others (one instructive miss: a plain `Array<number>` local's *stamped* type came back a fully
*structurally*-resolved intersection -- losing the nominal `ref` `ownerFor`'s fast path needs -- where
`ctx.scope` kept the clean nominal form) before landing on the gate that actually matches the fix's real
scope: only the union case needs this at all.

**Net effect**: `src/examples/walker.ts` now compiles clean end-to-end through `towasm.ts`. Regression
suite grew from 322 (last entry above) through several intermediate counts to **458**, byte-identical to
each prior verified baseline plus new tests, at every commit in this run. **Still open** (see the plan
doc's own next-step note): nothing currently known blocks calling `walk()` concretely on a real,
non-trivial `TS.ClassMember`/`TS.TypeMember`-shaped input -- untried as of this entry.
