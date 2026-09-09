---
name: tison-towasm-capabilities
description: "towasm.ts — index of closed capability work (what exists and the one durable lesson from each), consolidating 13 former per-feature memories."
metadata: 
  node_type: memory
  type: project
  originSessionId: e1e31c24-8d38-47f3-aa27-e8c84bc6b664
  modified: 2026-09-04T18:23:43.196Z
---

Closed capability work in `towasm.ts` and the checker, one entry each. **The live gap list is
towasm.ts's own header comment** ([[tison-towasm]]) — this file records only the lessons that aren't
recoverable from the code. Full per-feature originals are in `../memory-archive/`.

**Codegen capabilities, all CLOSED:**

- **Generic classes + get/set accessors** — real type-param substitution and `typeKey`-based
  monomorphization; `Array<T>` was then migrated off its hand-enumerated `builtinOwner` special-casing
  onto it. *Lesson*: `thisTsType` must ALWAYS be `RefType(name, typeArgs)`, never array-type-special-
  cased. Three follow-on bugs shared one root cause — code resolving a class's WasmType/owner without
  checking `arrayKind`.
- **Indexing generalized** — `a[i]` / `a[i]=v` route through any class's own `get(i)`/`set(i,v)`,
  rather than being array syntax. String migrated the same way (non-generic, fixed `i16` elemKind).
- **Typed arrays as real linear-memory views** — `Uint8Array`/`Int32Array`/`Uint32Array`/`ArrayBuffer`
  with genuine cross-view aliasing, not wasm-GC arrays.
- **`Array<T>` has a real u32 element kind**; bigint's limbs moved off linear-memory `Uint32Array`
  (never freed) onto a real GC-reclaimed `u32[]`.
- **Self-reassigning methods** (`assignsToThis`/`reassignsThis`) via a real wasm multi-value result.
  `Array<T>.push/pop/shift/unshift` are just the first bodies to use it. *Lesson*: this is the
  structural mechanism that replaced name-matching — see [[feedback-no-name-special-casing]].
- **`switch`**, plus break/continue rewritten from hardcoded `br(1)`/`br(0)` onto a real depth-tracking
  stack (which fixed a genuine `for-of` `continue` infinite loop).
- **try/catch/throw/finally** on exnref/try_table, including inside generators/async/constructors and
  `reassignsThis` methods. Only remaining boundary is suspend-inside-try, which is a separate
  permanent async-scope boundary, not a gap in exceptions.
- **Nullable primitives** (`number|null`, `boolean|null`) — closed the last "Types:" gap; found and
  fixed 5 real bugs on the way.
- **Inline asm** — a bare `__asm<[P],R>('...')(args)` works anywhere an expression is allowed.
- **Lazy type registration** — `ensureArrayType(kind)` replaced 7 pre-registered fixed-index array
  types; eventually everything unified onto `ensureClass` alone. *Lesson*: this is the pattern to
  extend when adding a new builtin, not a new eager table.
- **`Object.defineProperty`** via a synthesized extension subclass. *Lesson*: wasm-GC needs a struct
  `final:false` before it can ever be subtyped, and `everExtended` is populated by an early
  whole-program scan — a *synthesized* subclass has no source `extends` clause, so it must patch
  `final` retroactively (safe: `types` stays mutable until `toBytes()`).

**Checker fixes with blast radius bigger than their bug report — the pattern worth remembering:**

- **`T.resolve()` scope-leak** (`f2ecac7`): `case 'ref'` reassigned the shared `scope` *parameter*,
  so the enclosing call's resolving-set cleanup ran against the wrong `Scope`, permanently poisoning
  the circular-resolution guard. Fixing it made **15 previously-silently-skipped tests pass**.
  Traced with a `WeakMap` debug-id scheme tagging distinct `Type`/`Scope` identities — pure
  object-identity aliasing, invisible in any structural dump.
- **Muted `hoistVar`**: `checkStmt`'s `var_decl` case gated `hoistVar` behind the same `if (!muted)`
  as its diagnostics, so any module-level `const`/`let` checked under a muted `checkBlock` silently
  resolved to `any` everywhere later.
- **`declScope` in `resolve()`**: reverted 3+ times historically; root-caused, permanently enabled.
- **`checker.scopeOfStmt`** exposes narrowing-aware per-statement scope to codegen via an untyped AST
  stamp, no new checker state ([[feedback-no-checker-state]]). *Lesson, load-bearing*: `stmtScope`
  must be consulted **only when the baseline `ctx.scope` type is already a union**. An ungated version
  regressed the suite 457→349 — a lib generic body's stamp reflects its unresolved template, and
  synthetic towasm-only identifiers (`#switch$N`, `#for$N$arr`) were never stamped at all.

The recurring shape across all four: a fix that looks narrow unmasks a pile of unrelated-looking
failures. That is the signal to look for, not an anomaly — see [[tison-towasm-self-hosting-plan]].

## Closed 2026-09-04 (namespace/alias/array-extension round)

- **an array carrying extra properties** (`90bdacc`): `arrayPartOf` -- `T[] & {props}`,
  `interface X extends Array<T>`, `TemplateStringsArray`, `RegExpMatchArray`. Physically the array;
  extra properties get no slot (reading one is an honest `unknown field`). `typeOf` and `ownerFor` both
  route through it. `TemplateStringsArray` added to `lib/lib.d.ts`.
- **namespace-qualified classes and values** (`18af73c`, `64ef598`): `new NS.Cls(...)`, `c: NS.Cls` as a
  type (`ensureClassRef` splits the dotted name and resolves the leaf in the NAMESPACE's scope, only
  when it really is a class there), `NS.someConst` reads (`lazyGlobalFor` takes a scope), and
  `const X = C` / `const X = NS.C` / `const X = F<A,B>` as compile-time aliases.
- **start-function non-events** (`18af73c`, `64ef598`, `dfaea3c`): `isAliasInit` -- the start function no
  longer evaluates a const that merely renames a class, a cross-module binding, or a generic
  declaration, nor a bare `export {...}` statement. See [[tison-towasm-self-hosting-plan]] for why this
  was worth 40+ blocked declarations.
- **namespace-qualified calls resolve through `Scope`** (`397f1a8`): `Scope.namespace(NS).decl(name)` +
  `stmtHomeModule` replaced towasm's separate `namespaceImports` map and its `collectModules` producer.

- **cross-module class resolution** (`1e19d1b`, `a2bd106`): a `typeof X` type query carries its declaring
  scope, and `ClassInfo` carries its declaring scope + home module (used by the field loop, `ensureCtor`
  and `ensureMethod`). Together these make an IMPORTED class with un-annotated fields and a
  `Partial<typeof Defaults>` option bag compile and run.
- **a top-level const's initializer runs once** (`09875b5`): it ran twice -- start function and lazy
  wrapper. Real correctness bug, not just a codegen inefficiency.
- **unary `!` and truthiness** (`7489b54`, `8662b40`, `8639006`): `!` routes through `emitTruthy` (was
  scalar-only, and truncated `!0.5` to `!0`); NaN is falsy (`abs(x) > 0`); a boxed `any` slot whose
  checker type is all objects/arrays/functions is a null test (`alwaysTruthy`), `never` members skipped;
  a real wasm array slot likewise, `arr:i16` excepted (strings share it).
- **`typeof x === 'lit'`** (`f453ed3`): a type test, three ways -- static tag, null test, or `ref.test`
  on a boxed `any` (number/boolean/string/bigint, plus `function` via the closure base added in
  `0b38d15`). Never on a non-`any` slot: `number` and `boolean` share `f64`, so a test there would be a
  wrong answer. Bare `typeof x` as a value works only when the tag is static.
- **closure base type** (`0b38d15`): every closure value struct declares `{(ref func), (ref $envBase)}`
  as its supertype -- covariant immutable-field subtyping. Makes "is this a function" a single
  `ref.test`.

## CLOSED: closures capture a binding, not a value (`f33ebd0`)

`let n = 1; const f = () => n + 1; n = 4; f()` gave 2; the counter idiom left `n` at 0. Found by
`difftest.sh`'s language matrix. `ensureForwardCell` already built the right thing (a shared heap cell,
captured by reference) but only fired for a name used BEFORE its declaration ran; `collectCapturedMutables`
now cells any local a nested closure captures and something assigns.

**Three traps worth keeping:**
- A `for (let i = ...)` binding is **per-iteration**, so capture-by-value was already correct there and a
  shared cell is actively WRONG -- `Promise.all`'s own `promises[i].then(v => { values[i] = v; })` wrote
  past the end of `values`, and the whole towasm suite died on it. Excluded. Still open: a body that
  reassigns the variable mid-iteration needs a fresh cell per pass.
- `ensureCellType` boxed a scalar via `nullableWtype`, so `cellInner` described the box, not the value.
  Only reference cells had ever existed.
- **`wTypeKey` left field MUTABILITY out of a struct's identity** (arrays already had it), so a mutable
  scalar cell and the immutable scalar BOX deduped to one type -- which would also make `ref.test` for
  `typeof x === 'number'` match cells. `final`/`supertypes` folded in too. Latent, general bug.

**Debugging note**: the failure looked like cross-test contamination for a long while (one cell created
in module A, a trap in module B) -- it wasn't. The trap module simply came later in the same run and the
printed WAT of the PREVIOUS module was what the stack trace appeared to point at. Reproduce the failing
case ALONE before assuming shared state.

## OPEN, STRUCTURAL: codegen does not see the checker's narrowing

towasm asks `checkerTypeOf(e, ctx.scope)` where `ctx.scope` is ITS OWN scope, so it only ever sees a
name's DECLARED type. Every narrowing-dependent access has therefore been worked around individually
rather than fixed: `58d301b` (drop union members lacking the field), the `'++'/'--' on a nullable
primitive` refusal, `typeof s === 'function' ? s(4)` still failing with "call to unknown function 's'".

**Feasibility probed 2026-09-05 and REVERTED.** What it established:

- The mechanism is there and clean: `narrow(test, scope, sense)` in checker.ts is pure, returns a
  refined `Scope`, and is called by the checker at exactly the points codegen needs (`if`, ternary,
  `&&`/`||`). Exporting it and swapping `ctx.scope` around branch bodies is ~15 lines.
- With that wired in, **difftest stayed 1196/1211 and the corpus gate stayed at baseline** -- the common
  paths are fine.
- It broke one real test, and that is the actual cost: **the checker's narrowed types have shapes
  codegen's physical mapping doesn't handle**. `"k" in obj` narrows a dynamic object to
  `{[k:string]:V} & {k:unknown}`, and the index signature stops being findable. Two targeted attempts
  (look through intersection parts in `indexSignatureValueType`; check it before merging in `ownerFor`/
  `typeOf`) did not land -- so this needs a real pass over the type->physical mapping, not a patch.
- Design hazard to know first: `ctx.scope` does DOUBLE DUTY -- checker types AND `declareValue`'s
  registration of locals. `lookup` reads `ctx.declared` (a separate list), so swapping the scope is safe
  for locals, but a name declared inside a narrowed branch loses its checker-visible type afterwards.

Worth doing -- it is the root under several worked-around symptoms -- but budget it as a project.
