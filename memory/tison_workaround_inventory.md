---
name: tison-workaround-inventory
description: 2026-09-11 audit of every leniency/any-fallback/cast site in checker, type-utils, transform, towasm -- classified, each with its proper fix and an order
metadata:
  type: project
---

Audit of the workaround markers (see tison/CLAUDE.md "Fix problems; never work around them") plus probes of
tsc-rejected and tsc-precise snippets through `assistant/corpus-one.ts` (lib.esnext.full, same as the corpus).
**Verdict: every site is fixable properly; none needs to stay lenient.** Line numbers are as of 63dab6e.

## A. Not workarounds (TS does the same, or an endorsed convention) -- reword, don't remove
- Implicit `any` for an unannotated param/field/accessor with no initializer or context (checker 256-302,
  2099-2121; transform 1153-1202). Circular inference -> `any` (checker 338, 912 = TS 7022/7023; could emit those).
- Unresolved import -> `any` (checker 872-875), diagnosed at transform.ts:733. `any` operands propagate (1797, 1922, 1930).
- Depth-limit bails (`hitDepthLimit`, 11 sites): bounded budget, reported -- TS has 2589 for the same.
- towasm generic erasure (`p.constraint ?? T.ANY`, 2306/4768/4977/7701/7726): a codegen strategy, but it must
  erase to ONE layout per generic shape. Done for interfaces in 5a78c51: `ownsLayout` keys by layout, so a scalar argument
  keeps its own struct (the Params<number> vs Params<any> trap) and a reference argument erases.
- towasm's 45 `... not supported` throws: honest refusals, the header's gap list. Not silent.
- `(x as any).pos` / `.scope` / `.contextualType` stamps: untyped stamping is the endorsed convention
  ([[feedback-no-checker-state]]). Cleanup only: `getPos()` (common.ts:39) already exists for pos; add one
  `scopeOf`/`stampScope` accessor pair so the cast lives in one place.
- checker.ts:25's header ("every gap errs lenient") states the old policy -- rewrite it.

## B. Missing modeling -> silent `any` (hides errors AND forces towasm onto boxed/dynamic paths)
Probe results: silent unless noted.
1. **DONE a229210** (`T.iterationTypes`, `T.memberKey`). **Iteration protocol.** No general iterated-type; `yield*` (checker 1970-1973) uses a NAME list
   (`SINGLE_ELEMENT_ITERABLES`). `for (x of map.keys())` -> any; `yield* [1]` then for-of -> any;
   `new Set([1,2])` fails to infer T (GAP), so `[...set]`/`const [a] = set` are any. Fix: one
   `iteratedType(t)` via `[Symbol.iterator]().next()`'s IteratorResult, used by for-of, spread, array
   destructuring, `yield*`, and Iterable<T> inference. = self-hosting NEXT #5.
2. **Indexed access with a non-literal key** (checker 1498, 1501): `o[k]` with `k: "a"|"b"` -> any. Fix: key
   type's literal members -> union of member types; `keyof T` -> `T[K]`; plain string without an index
   signature -> TS 7053.
3. **Definite member absence.** `lookupMember` returns undefined for both "absent" and "can't tell", and
   `sealed()` (type-utils 1928) is true only for object/intersection, so `"abc".nope`, `u.nope` on
   `string|number`, calling an uncallable non-object all type `any` silently (checker 1436-1438, 1495-1498,
   1600-1603; type-utils 2093). Fix: three-valued lookup; primitives (via boxed), literals, unions (every
   member), class refs and functions are sealed.
4. **DONE f6ed5bb.** **Tagged templates** (checker 1963) only handle a bare function type: an overloaded tag -> any. Fix: route
   through the call path with `(TemplateStringsArray, ...exprs)`.
5. **DONE 3a99a0e.** **`yield` result** is always any (1979); `checkStmt` overwrites an annotated generator's
   `decl.returnType` with N forced to any. towasm dodges it twice (7904-7911 reads the hoisted snapshot;
   7951-7957 passes N separately). Fix: `yield` types as the declared TNext; never overwrite an annotated
   return type; delete both towasm dodges.
6. **DONE** (verified 2026-09-11, probe assistant/tsc-probe/s1.ts): `o.constructor` gives `Function`, as tsc does.
7. **Uninferrable type param** -> `default ?? constraint ?? any`, sometimes without even a GAP
   (`declare function g<T>(): T; g().foo` silent). TS >= 3.5 infers `unknown` (checker 1180). Do after B1.
8. `typeOf`'s `default: return T.ANY` (2006) -> exhaustive `never` switch; instantiation expression on a
   non-callable (1783) -> TS 2635.

## C. Accepting incorrect code (lower priority: a false positive blocks tsw, a miss does not)
Each removal will expose false positives -- those are the real bugs; fix them, never restore the leniency.
Order smallest-first, each with `corpus-ab.sh` and a per-file ERR diff.
1. Widened source into a literal target (type-utils 2043, 2050): `const x: "a" = str` and
   `` `a${number}` = str `` accepted. ROOT CAUSE FOUND: the var_decl check types its initializer WIDENED
   (`typeOf1` -> widen=true), so even a variable declared `{ kind: "b" }` reads as `{ kind: string }` and
   the leniency is what keeps that passing. Fix both together: checks use the precise init type, then
   return false here.
2. **DONE 830dc66** (the unconditional half). A plain call on a construct-only value is now TS2348. Its leniency was
   masking a LIB gap -- `Array(n)`/`RegExp(src, flags)` without `new` -- fixed in the same commit with
   `interface ArrayConstructor`/`RegExpConstructor` + ambient vars (the `TypedArrayConstructor` shape). STILL OPEN: the
   `new`-on-a-call-signature direction, which TS reports as TS7009, an implicit-any diagnostic gated on `noImplicitAny`
   (untracked here) that still evaluates to `any`. Enforcing it unconditionally cost 56 corpus false positives
   (measured), so it needs `noImplicitAny` tracking first, not a stricter rule.
   FOUND WHILE DOING IT -- towasm codegen gap: `new Array<number>(3)` compiles, `Array<number>(3)` does NOT
   ("internal: cannot convert arr:ref:false to arr:f64:false"), because the CALL path does not specialise a generic
   class constructor the way the construct path does. Pre-existing in kind (generic erasure, section A) but newly
   REACHABLE now that a call signature exists; JS specifies `Array(n)` and `new Array(n)` as identical, so the fix is
   to route a plain call on a constructor-backed lib value through the construct path. Affects only files that do not
   compile yet (js-parser 372, towasm 1274, wasm 1187, core 81); probes assistant/tsc-probe/s4.ts and s5.ts.
3. Overload no-fit -> WARNING, args unchecked (1628). TS 2769; needs exact overload resolution first.
   (Overloaded class members no longer expose their implementation, 3f23a8a, so this now fires where TS errs.)
4. **METHODS DONE c8c8fbc** -- compared as their function type, each overload in turn; a missing one counts
   against a sealed source as a missing property does. It hid a lot: `string` satisfied `any[]`. Removing it
   cost five fixes first (ba05b5d, ad475ae, c843304 and, before them, 70f0a53, ed85749) and ended at
   +25 true positives / -11 false positives on the corpus. STILL OPEN: call/index members (2087), function
   params (2070), missing returns (2069): `(x: number) => x` into `(x: string) => number` is accepted.
   Fix: function-typed props contravariant.
5. **MOSTLY DONE 86ea3d8** (class refs compared by members; truly unresolved names still pass; a type-parameter
   DESTINATION is still checked through its constraint -- TS keeps T opaque; variadicTuples1 lost 5 real errors).
   isAssignable passes any unresolved/nominal ref (1995-1996, 2080, 2123, 2132): unrelated classes
   `const x: A = new B()` accepted. Fix: classes compare structurally (+ private/protected nominality);
   an unresolvable name is a TS 2304 at its reference, so no downstream leniency is needed.
6. narrowByDiscriminant keeps a member on an unresolvable discriminant (599, 617) -- falls out of B3.

## D. towasm-specific
1. **RESOLVED 86ea3d8 differently**: multi-body overloads exist only in towasm's bundled lib, where the checker picks
   AMBIENT signatures with no body, so a chosen-overload stamp cannot apply; the tie-break is gone (first-fit,
   the checker's rule). `resolveOverload` (towasm 8347) re-resolves overloads itself, with an exact-match tie-break justified by
   `ArrayBuffer -> number[]` being assignable -- the checker now rejects that. Fix: the checker stamps its
   chosen signature on the call node (like `contextualType`); towasm reads it. One source of truth.
2. `as unknown as` casts (2141, 2880, 8881, 9910) and `new TSWError(e as any, ...)` (catch var): widen the
   helper/TSWError parameter types instead ([[feedback_avoid_unsafe_casts]] in the global store).

## Found while fixing (2026-09-11, later)
- Missing required property was accepted whenever `undefined` fit its type -- FIXED bf4c532.
- Class methods/getters typed `any` at every call until checked -- FIXED a229210 (`lazyReturnType`).
- strictNullChecks-off mode -- DONE bf4c532. Enum member types, unit narrowing, discriminated
  assignability, const assignment narrowing -- DONE f774537. typeof result sets, clause exclusion -- 27d98c9.
- **DONE e43c96c/227a0c2** (`T.Inference`, shared). **Generic call inference is implemented TWICE** (checker `instantiate`, towasm `inferTypeArgMap`), both
  first-wins. TS: covariant candidates -> common supertype (`getSupertypeOrUnion`: same-base literals
  UNION), contravariant (callback param positions) only when no covariant, and type params FIXED as each
  context-sensitive callback is typed, left to right. Needs ONE shared implementation with polarity.
  Blocks typeParameterFixingWithContextSensitiveArguments(5), unionOfEnumInference.
- `let` assignment narrowing: narrowings are never invalidated by reassignment, so only `const` narrows
  by its initializer. Needs assignment invalidation first.
- `?.` on a `never`/nullish-only receiver reports nothing (TS 2339 on never).
- Object rest in a destructuring pattern binds `any` (bindPattern); an array-literal initializer gets no
  contextual type from its binding pattern (TS's implied type) -> GAPs on `var [x, [y]] = [1, ["a"]]`.
- **Expando declared types**: a function's `f.p = v` declares `p` (94949aa) but the declared type -- the union of
  ALL assignments, object literals normalized (`{x} | {y}` -> `{x, y?: undefined} | {y, x?: undefined}`) -- isn't
  built, so `f.p` reads fall to B3's untyped absence and assignment narrowing is skipped for expandos.
- arrayMethod's `map` model must stay until a type alias union (`Ty | Lit`) is flattened where towasm reads it;
  removing it broke towasm. `reduce` is now TS's real three overloads (6ee71c9).
- var_decl diagnostics land at the next token, not the declaration. Rest ARGUMENTS (`f(...xs)`) are not checked, nor are
  positional arguments filling a rest parameter: `declare function k(...args: number[]): number; k("x")` is clean (2026-09-13).
- **A missing member on a CLASS instance is silently `any`** (2026-09-13): checker.ts `case 'member'` reports only when
  `T.sealed`, which uses `resolveOwn` -- since bfd0aeb kept class refs nominal, a class ref is never sealed. The fix is one
  line (`resolveMembers` in `sealed`), measured with corpus-ab: +44 tsc-clean ERROR, of which ~20 tsc also rejects (baselines
  missing in the checkout) and 24 are real false positives from 8 gaps that must land FIRST: computed `[Symbol.iterator]`
  methods missing from a class's members (6), mixin members (6), `this` in a static member (4), construct signatures on a
  constructor-typed `T` / merged `new()` (3), polymorphic `this` returns (2), guard narrowing to a supertype keeps the
  subtype (1), `this` in a nested `function` (1), `partiallyAnnotatedFunctionInferenceWithTypeParameter` (1, undiagnosed).
  Our own sources gain only backend.ts's `Uint8Array.set` (lib.d.ts lacks it); towasm's lib also needs `[Symbol.iterator]`
  declared on `TypedArray` (test-towasm's for-of over a `Uint8Array` fails without it). Classify with real tsc per LINE, not
  baseline presence: `assistant/corpus-ab.sh` now keeps `corpus-ab/base-false-positives.txt` for the diff.
- **TS's own `MapConstructor` loses a mapped call's types** (2026-09-13, missed inference): `new Map([1, 2].map(x => [String(x),
  x]))` infers `Map<any, any>` against lib.esnext.full, though a declared generic function and a declared overload pair of the same
  shapes both infer `<string, number>` (test-checker `overload trial, final context`). The multi-signature construct type resolves
  differently -- look at `T.unionSignature` pre-empting the overload path in checker.ts `case 'new'`.
- **`super` in an OBJECT LITERAL method reads as `any`** (2026-09-14, lenient): `{ __proto__: b, m() { super.n() } }` --
  `classBodyScopes` binds `super` for classes only, so nothing else has a base to bind. Never a false positive.
  (The class case was fixed in bb60138: `classShapes` hands its base type back, `classBodyScopes` binds the base's
  instance side in instance members and `typeof Base` in static ones plus, under `'super()'`, the constructor
  `super(...)` invokes through the `new` path. `super(...)` is `void`; `super.m()` substitutes the derived `this`;
  the extends clause's type args fix the base's `T`. Five silent corpus acceptances became real diagnostics.)
- **A declared `this:` parameter is dropped by ts-parser** (ts-parser.ts `this` rule, deliberately: TS erases it at every call
  site), so a non-arrow function's own `this` can only be `any` in its body -- TS's rule WITHOUT one, and lenient (never a
  false positive) with one. Keeping it needs a non-positional field on the signature (e.g. `thisType`), not a real `Param`.
- **A class field typed only by its INITIALIZER reads as `any`** (2026-09-13, missed inference, lib.esnext.full):
  `class K { f = 1 } declare const k: K; const q: string = k.f` is clean, though `f: number` errs -- so does the same field
  read through a parameter (`static #n = 1`, `class D extends C { test2 = 1 }`). Both cost a test its discriminating power
  while doing the sealed prerequisites; the tests now annotate. Look at `pendingFieldInit`'s lazy getter firing for a read
  through a REFERENCE to the class rather than inside its own body.
- Self-hosting checker errors on tison's own sources (`assistant/self-errors.sh`): 74 -> 58 after 3f23a8a..9dd31d3, 55 after c10aec6, 38 after the const-context/overload-trial commits, 27 after 0dda90c, 21 after the lib/truthiness commits, 19 after a24a372 and after the freshness batch, 17 after c2fb0c2, 16 after the intersection work (dd1a676).
- Overload resolution is TS's two passes since 81b535b (callbacks untyped, then fixed by the first fitting candidate).
  Type walks are DAG-aware since 0b78c11 (searchOnce/rewriteOnce); any NEW recursive type walk must be too, or nested
  generics go exponential (7z.ts hit 4 GB). Diagnostics print types within a budget (0d84298).
- Return-type inference outranks a callback's return: `f<D>(m: (x) => D): D` with `const r: boolean = f(u => ...)`
  takes D from `boolean` (inferReturn); TS gives the return type the lowest priority.
- Pre-existing, found 2026-09-11: tison/test/test-tison.ts:96 fails to parse (`(_, ctx) => ({...ctx})` in `Rule(...)`).
  (msbuild's Solution.ts crash was a value name used as a type name plus Object.prototype lookups -- fixed 60e35d4/7011a1a.)
- towasm cannot pass a struct of one interface where a parameter expects an object type with optional fields
  ("cannot convert ref:ParsedPath to ref:{ root?: ... }", `path.format(path.parse(x))`).
- towasm lib lacks what tison's sources call: `Object.assign` (TS: `T & U` overloads), `Object.fromEntries`,
  `String.fromCodePoint`, `Uint8Array.set(array, offset)`, `new Map(map)` (Iterable entries).
- A const context is `const<inner>` (ceafbce): `inner` is the contextual type it replaces, and decides whether an array under
  it is readonly (TS's checkArrayLiteral); it reaches only literals/array/object literals, not a conditional's branches.
  Overload trials type each argument against the candidate's own parameter (4cd8e3b), since a nested callback is fixed by the
  first context it is typed in. `as const` object properties are not yet marked readonly.
- Destructuring a union binds each member's own position (7b10acf); an equality with a literal drops members not comparable
  with it (640074a) -- but the literal is not boxed, so `'a'` vs `{ length: number }` is dropped where TS keeps it; an
  inferred return adds `undefined` only when the end is reachable (`endsFunction`, 0dda90c).
- towasm lib's Map/Set/WeakMap values are the classes' own generic constructors, not TS's constructor shapes: TS's
  `MapConstructor` has a non-generic first `new (): Map<any, any>` (and `new Set()` is `Set<unknown>`), which is why
  `(this.aliases ??= new Map()).set(d.name, ...)` passes tsc (type-utils addAlias). An ambient `declare var Map` would merge
  as an intersection whose class `constructor` part `new` picks first -- needs an ambient-first rule for class+var merges.
- towasm: an anonymous object type with overloaded methods cannot be a method receiver ("field 'X' redeclares an inherited
  field" from buildObjectShape); `Object` intrinsics are recognised by name (objectIntrinsic), not by resolution.
  towasm lib.d.ts has no `Iterable`, so TS's `Object.fromEntries` cannot be declared yet.
- towasm lib's `Promise.then(onFulfilled: (value: T) => void): void` returns void and does not chain, so
  `cached = resolveImports(...).then(async ...)` (transform.ts makeScope) is `void`; TS's returns `Promise<TResult1 | TResult2>`.
- `let r = cond ? typeOf(x) : 'void'` (towasm 2386) passes tsc through LET ASSIGNMENT NARROWING -- a let's flow type after its
  declaration is the unwidened initializer type -- not literal freshness (tsc: a fresh 'void' is NOT absorbed by a regular
  one; `let r = c ? t() : 'void'` is `string | undefined`). Literal freshness (widen only literals written as expressions)
  is the root of `[c]` widening a declared `{ type: 'fn' }` (checker 1866/2094).
- Literal freshness is in (see the freshness commit): only literal expressions (and enum members) widen; unions keep the
  fresh twin and drop redundant literals. Inference's supertype choice uses isAssignable's `precise` mode (no C1).
  tsc 6 facts: fresh inference candidates widen and regular ones do not; `f3("abc", fo, fx)` is `string`, not the test's
  comment `"abc" | "def"`.
- Flow containers (c2fb0c2, `Scope.flowBoundary`): a function declaration and a class declaration's members (property
  initializers too) see outer declared types, never narrowings. OPEN, the closure half: an arrow / function expression /
  object-literal method / class-expression member here carries EVERY outer narrowing; tsc 6 carries only a const's, or a
  param's / function-local `let`'s when the closure is past its last assignment (none in a nested function); never a `var`,
  a module-level `let`, or a property path (even `const o; o.p`, readonly or not). Probes: assistant/tsc-probe/{i,j}.ts.
- Numbers have no freshness: a `0` from `n && x`'s falsy part (TS's regular zeroType) or a numeric literal type widens to
  `number` in a `let`, so a later `if (v)` cannot remove it (tsc keeps `0` and drops it). probe assistant/tsc-probe/h.ts.
- Declaration merging must not WALK the merged types (c41ebae): `intersectTypes`' `typeKey` dedupe printed each part,
  forcing a class's lazy field-initializer getters mid-`hoist` -- lib `String.charCodeAt = __asm<[i32], i32>(...)` was
  inferred before `__asm` was bound and memoized `any`. `joinTypes` (flatten + identity dedupe) is the merge-time join.
  Any new eager walk of a class shape during hoisting will reintroduce this class of bug.
- Intersection normalization (TS getIntersectionType) is IN: `domainOf`/`unitOf`/`reduceIntersection` plus `resolve`'s
  `case 'intersection'`. It fixed tocode 497 (`NonNullable<ForInit<Type>>` never became a union, so `init.type ===
  'var_decl'` could not narrow). tsc 6.0.3 rules (probes assistant/tsc-probe/{l,l-neg,p1..p5}.ts): `X & any` is `any`;
  `T & unknown` and `{}` beside an object type drop out; `never` from disjoint domains (`string & number`, `object & string`),
  a nullish member beside an object (`undefined & {}`), distinct units (`'a' & 'b'`) and conflicting literal discriminants
  (`{type:'a'} & {type:'b'}`); `'a' & string` is `'a'`; `{a:string} & {a:number}` is NOT never. TS distributes over a union
  member (how `NonNullable<A|B|undefined>` drops `undefined`) but DISPLAYS the undistributed origin.
- Reductions that DISCARD a part must read the part AS WRITTEN, never as resolved: `resolve` answers `any`/`unknown` when it
  gives up (a deferred conditional `Foo<K>`, a depth bail), and dropping such a part turns "couldn't evaluate" into a
  reduction -- it cost a real corpus FP (excessPropertyCheckingIntersectionWithConditional) before the rule was written.
- Distribution exposed three RELATION gaps, each fixed rather than worked around: an intersection of type parameters relates
  by its own constraint (`intersectionConstraint`, TS's getBaseConstraintOfType: `T & U` with `T extends 1|2`, `U extends 2|3`
  is `2`); a function's apparent type is the global `Function` interface, so a lambda satisfies an interface extending it
  (isAssignable's function-vs-object case now looks members up instead of rejecting any required member); and an intersection
  holding `never` IS `never` at instantiation (`reduceInstantiated`), which is what makes a phantom parameter
  (`type ActionType<P> = string & { hack?: P & never }`) infer nothing for `P` instead of `X & never`.
- ALWAYS re-run the WHOLE `self-errors.sh` after a checker change, never just the file you were fixing: 60d23d4 fixed
  2 errors in type-utils/towasm and silently added NINE in js-parser/ts-parser, and the corpus A/B was neutral
  throughout (the corpus runs against lib.esnext.full, so a towasm-lib-scope regression is invisible to it). Reverted
  in 29fce5d.
- An `Array<X>` source could not reach an `Array<Y>` destination through ANY extra level of recursion: `isAssignable`
  expanded a non-primitive ref source to its members (`resolveMembers`) BEFORE decomposing a union/intersection
  destination, while `Array`/`ReadonlyArray` destinations are excluded from the structural path -- so once the by-name
  Array comparison (which runs before `resolve`) was passed, array-ness was gone for good. Fixed by deferring that
  expansion while `dst` is still a union or intersection, so each member re-enters with the ref intact. This is what
  blocked the optional indexed access (`S['kind']` as `K | undefined` adds exactly one union level): both are in now.
  Only the TOWASM lib scope reproduces it (there `Array` is a real class); test-towasm's `arrayThroughUnion` guards it,
  and test-checker (lib.esnext.full) CANNOT -- a checker-suite case for this passes either way.
- OPEN, blocked (towasm lib `flatMap`): it declares `callback: (...) => U[]` where TS declares `U | readonly U[]`, so
  `xs.flatMap(x => f(x) ?? [])` (self-hosting type-utils 798) is rejected, and U silently infers `any`. Declaring TS's
  form needs union-target inference first: `U | readonly U[]` against `string[]` must infer `U = string` (TS's
  inferToMultipleTypes gives a naked type variable only what the other constituents did not match). A first attempt at
  that rewrite -- per-source `matched` tracking plus source/target cancellation -- cost +8 self-hosting errors, because
  the concrete alternatives must still be tried against the WHOLE argument, and "an inference was made" is too coarse a
  matched signal (it fires for any type parameter, starving the naked one). Also needed: an empty `[]` contextually
  typed by `U | readonly U[]` currently comes back as `readonly U[]`, leaking the callee's own unbound parameter into
  the argument type.
- THE UNIT OF PROGRESS is the survey, not checker errors: `assistant/selfhost-survey.sh` (whole set ~2h, or one file,
  or `--aggregate` to re-render from the per-file JSON in assistant/selfhost-survey/). Its "Causes, ranked by
  declarations unblocked" table IS the work queue; the script's own header says so. Declarations COMPILED: 25/257
  (9.7%, 2026-09-05) -> 68/324 (21.0%, 2026-09-12 clean full run at 3aa8692, 6 minutes), with `tocode.ts` the first file to compile whole
  (18/18, 29 functions). Checker errors are only a precondition -- 7 of 14 files have zero and still compile nothing.
- A missing lib GLOBAL fails at codegen ("'new' is only supported for a known class"), not at checking, and when it is
  used in a module-level `const` it blocks EVERY declaration in that file. That one shape was the survey's top cause
  (56 declarations, 3 files) and it was two missing classes: `WeakSet` and `SyntaxError` (e7b936f). Check for this
  first when a whole file compiles nothing -- `grep -E "^(const|let) .*new [A-Z]"` over the file finds it in seconds.
  After the fix the top cause blocks 24; next up: `null`/`undefined` where a nullable object type is expected (24),
  ts-parser's `Rule<any>` conversion (22), towasm's unknown method 'parse' (21), object literal needing a known
  target type (17).
- The survey's AGGREGATE mixes per-file JSONs of different vintages: `--aggregate` (and every run) re-renders from
  whatever is on disk, so a table can blend this morning's rows with tonight's. Before quoting ANY survey number,
  check `stat -f '%Sm %N' assistant/selfhost-survey/*.json` -- on 2026-09-11 the rows spanned 07:08 to 21:52 while
  the newest fix was 22:34. Only a full clean run licenses a headline figure like "65/314 compiled".
- Slicing (added to the gitignored `assistant/selfhost-survey.ts`, re-apply if lost): `--slice start:count` bounds a
  worker to that many declarations and writes a `.partN.json`; the parent retries a crashed file in slices of 24 and
  merges. That is what makes type-utils measurable at all -- each probe re-checks the whole file, and 113 of them in
  one process exhausts the 8GB heap (the machine has 16GB, so raising it is not an option).
- A REAL MEMORY LEAK, ~140MB per compile -- FOUND AND FIXED 3005d78. `transform.ts`'s process-wide module-scope
  caches (`importScopeCache`, `waitingFor`, `ownScopeSettled`) were strong `Map`s keyed by `LoadedModule`, and only
  one ever deleted. Every compile builds a fresh `ModuleLoader`, so every compile's module `Scope`s -- and through
  them its whole type and AST graph -- stayed live forever. Heap with a forced `global.gc()` between probes: FLAT at
  142 -> 218MB where it previously climbed 142 -> 1294MB. This is why the survey's 8GB worker died on type-utils.
  FINAL SHAPE (2066000, after a first pass made them `WeakMap`s in 3005d78): the three tables are GONE. One
  `ModuleMemo` (`shape`/`own`/`waiting`) is STAMPED on the module record via a single `memoOf` accessor -- the
  convention the same function already uses two lines away (`src.program.scope ??= inner`), with the one cast
  localised there. A memo is keyed by identity, so it lives exactly as long as its module and dies with it; no
  process-wide state is left. REJECTED alternative: `ModuleLoader` instance fields -- package modules are shared
  across loaders (`NodeModules.found` is static) while relative ones are per-loader, so instance fields would tie
  both to the shorter lifetime and make a second loader recompute shapes it already shares.
  REUSE IS PRESERVED, measured both ways (assistant/probe-cache-reuse.ts, three compiles in one process):
    shared loader:  strong 630 -> 0 -> 0ms   weak 678 -> 0 -> 0ms     (full reuse, unchanged)
    fresh loader:   strong 653 -> 400 -> 388ms   weak 647 -> 380 -> 405ms  (partial, unchanged)
  The reason is structural, not incidental: these caches are keyed by OBJECT IDENTITY, so reuse depends on the
  `LoadedModule` surviving -- which means the loader surviving (`ModuleLoader.imported` is per-instance; only
  `NodeModules.found` is static/process-wide). A `WeakMap` drops an entry only once its key is unreachable, and an
  unreachable module can never be handed to `get()` again, so nothing hittable is ever lost. With a fresh loader the
  strong entries were unhittable by construction -- pure retention.
  How it was found, worth repeating for the next leak: bisect with env flags in `assistant/selfhost-survey.ts` --
  DBG_MEM (per-probe heap), DBG_NOCODEGEN, DBG_NOCHECK, DBG_FRESHLIB, DBG_REUSE, DBG_GC. Parse alone was flat,
  parse+check grew, and re-checking ONE cached AST was flat -- which said "checking pins each parsed AST" and pointed
  straight at the module caches. Ruled out on the way: type-utils' own globals are all fine (widenCache is a Map of
  at most 8 flag combinations holding WeakMaps; substituteTypeCache/mentionsCache are WeakMaps; `tocode`'s `printing`
  Set is balanced by try/finally and its typeBudget defaults to Infinity).
- THE SURVEY CAN LIE, and did: `runWorker` logged a one-line note and resolved when a worker crashed, leaving that
  file's PREVIOUS JSON on disk -- and the tables render from disk, so a crashed file's rows read as "nothing changed".
  The type-utils worker crashes (it is the biggest file, 113 probes), so every type-utils row in a survey run after
  2026-09-11 07:08 was that morning's data. FIXED in `assistant/selfhost-survey.ts` -- gitignored, so re-apply if the
  file is lost: a failed worker now overwrites the report with `parseError: 'WORKER CRASHED (not measured)'`, the run
  prints a `## NOT MEASURED` section, and it exits non-zero. Always check for `worker for ... exited` in the output.
  Consequence worth remembering: the `undefined`-takes-the-default fix (48ea34b) DID move `oneStepIndexed` past the
  null/undefined cause -- verified with `probe-one-decl` -- even though the stale table said otherwise.
- THE DOMINANT REMAINING THEME (clean survey 2026-09-12, 68/324 declarations compiled): ONE PHYSICAL REPRESENTATION
  PER SHAPE. towasm derives struct identity from the checker's `T.typeKey`, which is finer-grained than the physical
  layout, so two types that share a layout get two structs and every conversion between them fails. Two families,
  ~72 declarations together -- more than everything else in the queue combined:
    (a) GENERIC INSTANTIATION (~53): `Rule<any>` vs `Rule<{...}>` (ts-parser 22, js-parser 11), `Rest<{...}>` and
        `Rest<any>` vs `Rest<union>` (checker/type-utils 18), `Set<lit|lit>` vs `{...}` (2). This is the erasure
        trap section A already names (Params<number> vs Params<any>): erase to ONE layout per generic shape.
    (b) NARROWED vs DECLARED (19): `{type:"keyof"; argument:Type}` vs `{type:string; argument:Type}` -- an inferred
        type predicate narrows a discriminant to its literal, and the narrowed view keys differently even though the
        value IS an instance of the declared struct. Constraint to respect: backend.ts:3140 documents that object
        shapes must NOT simply be widened, because `matchObjectShapeByType`'s discriminant tiebreak needs the literal
        precision to tell union members apart. TRIED AND INSUFFICIENT: reusing an already-built widened struct in
        `ensureAnonObjectShape` -- the failing pair is not created through that path, so first find where each struct
        IS built (log inside `buildObjectShape`, BEFORE its `const info` object literal, not inside it).
  Attack the identity rule once, generally, rather than the two symptoms separately.
- **FAMILY (a) CLOSED `80ac3c4` -- 77 declarations moved, the largest survey delta this plan has recorded.**
  The rule was: struct identity came from `T.typeKey` (the type's printed TEXT), finer-grained than the
  physical layout, and wasm struct fields are mutable hence INVARIANT -- so separate structs could never
  have been convertible no matter how they were built. Two halves, one rule:
  (i) `ensureObjectShape` (generic interface/alias -- a pure layout, no compiled code of its own) erases
      every type-parameter position to the parameter's constraint (`?? any`) and keys by bare NAME.
  (ii) `ensureClass` already had the rule as `if (name === 'Array')` -- a name special-case of the general
      truth: a type argument earns its own instantiation only when stored UNBOXED (a scalar, or a
      typed-array tag); every reference type is one ref slot and cannot reshape a struct.
  Rows cleared: `Rule<any>`->`Rule<{...}>` 22->0 and 11->0, `Rest<...>` 16->0 and 2->0, "object literal
  needs a known target type" 19->0, plus five singles.
- **FAMILY (b) CLOSED too (`layoutTwin`) -- it WAS the same mistake, one level over.** The erasure could not
  reach it because no generic is involved: all 19 were ONE pair of ANONYMOUS shapes, `{type:"keyof";
  argument:Type}` vs `{type:string; argument:Type}`, byte-identical in layout (`type:arr:i16 argument:ref:any`),
  both built by `ensureAnonObjectShape` (so the older "not created through that path" note was wrong).
  `ensureObjectShape` already had a layout-twin block, but keyed `name#fields-in-order` and applied only to
  generics. Now one helper, `layoutTwin`, used by BOTH shape builders: key = fields SORTED, each by stored wasm
  type, refs canonicalized to their struct; only FINAL, supertype-free shapes (merging into a struct with
  subtypes would make `ref.test` on it accept them); refused if a later type already names the new index
  (`mentionsTypeIndex`). Survey: 19 + 1 moved, all onto `unresolved identifier 'objectKeyNames'`.
- **A merged struct's `thisTsType` is the FIELD-WISE UNION of the merged shapes, not a widening.** Widening
  literals was tried first and broke `matchObjectShape`'s discriminant tiebreak: every single-field
  `{type: <tag>}` shape in the compiler shares one layout, so they all merge, and a struct left carrying ONE
  member's tag (a named-interface twin never got widened) excluded every other tag -- measured on transform.ts
  `BuildStateMachine`, `define(id, [], { type: 'complete' })` -> "object literal needs a known target type".
  The union (`{type: 'this' | 'complete' | ...}`) is sound for every value AND keeps every tag. No
  representable union (`resolveObjectType` fails) -> the merge is refused rather than keeping one member's type.
- **Field ORDER had zero measured cases**: `matchObjectShape`/`matchObjectShapeByType` already match candidates
  by field-name SET, so `{a;b}` into `{b;a}` compiled before `layoutTwin` too (test-towasm `fieldOrder`). The
  sorted key is still right -- it just is not what closed anything.
- **The `ensureClass` merge is restricted to a METHOD-FREE class, and that restriction is measured, not
  cautious.** A method body is compiled against the instantiation it was reached through
  (`substElemMethods`), so merging two instantiations whose methods differ runs code built for one layout
  against the other: a wasm `invalid struct index` in test-towasm plus one difftest disagreement
  (`conform/async/generatorValueUndefinedAfterDone`, wasm 0 vs TS 1). Excluding only the CONSTRUCTOR from
  that test (tried: a constructor just writes the shared layout) reproduces the same disagreement, so a
  constructor is NOT safe to ignore. `name === 'Array'` therefore survives as the one method-bearing class
  whose collapse is known sound; removing it needs the collapse to become authoritative for method
  instantiation too.
- `assistant/probe-one-decl.ts <file> <declName>` compiles ONE declaration the way the survey does (its `variantBody`:
  the whole module compiles, only the target is exported) and prints the error WITH its position -- the survey strips
  positions deliberately, to cluster causes, so this is how you turn a cluster back into a source line.
- OPEN, the next real codegen bug (found this way): type-utils.ts:1460:97
  `constraintParts.find(m => m.type === 'keyof')?.argument` fails with
  "internal: cannot convert ref:{ type:"keyof"; argument:Type }:true to ref:{ type:string; argument:Type }:true".
  A NARROWED object shape (literal discriminant, from an inferred type predicate) and the declared shape it was
  narrowed from become TWO structs, because struct identity is `T.typeKey` and that keeps the literal. At runtime the
  value IS an instance of the declared struct, so the conversion can never succeed. The tension to respect:
  backend.ts:3140 documents that an object shape must NOT simply be widened, because `matchObjectShapeByType`'s
  discriminant tiebreak needs the literal precision to tell union members apart. TRIED AND INSUFFICIENT: having
  `ensureAnonObjectShape` reuse an already-built widened struct on a hit -- the failing pair is not created through
  that path, so find where each struct IS built first (log inside `buildObjectShape`, BEFORE its `const info`
  literal, not inside it).
- Real tsc for probes: `node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2022 file.ts` (TS 6.0.3 refuses
  files alongside a tsconfig otherwise). Check TS semantics this way before modeling them.
- Instruments: the local TypeScript checkout lacks 1339 `.errors.txt` that git tracks, so ~1300 tsc-rejected
  tests count as "clean"; difftest's TS side is transpile-only, so invalid-TS cases slipped in (3 fixed).

## Order
B1 -> D1 -> B5 -> B3 -> B2 -> B4/B6/B8 -> B7 -> C1..C5 -> A cleanup. B before C because B's `any`s both hide
errors and cost towasm typed codegen; C only accepts bad code. Interleave with the corpus false positives
(1203 files), which outrank all of this by the priority rule.
