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
  erase to ONE layout per generic shape -- see self-hosting NEXT #1 (Params<number> vs Params<any> trap).
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
4. isAssignable skips methods/call/index members (2087), function params (2070), missing returns (2069):
   `{ f() { return "x" } }` into `{ f(): number }` and `(x: number) => x` into `(x: string) => number`
   accepted. Fix: methods as function types (method bivariance), function-typed props contravariant.
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
- var_decl diagnostics land at the next token, not the declaration. Rest ARGUMENTS (`f(...xs)`) are not checked.
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
  (9.7%, 2026-09-05) -> 65/314 (20.7%, 2026-09-11 at dc94612), with `tocode.ts` the first file to compile whole
  (18/18, 29 functions). Checker errors are only a precondition -- 7 of 14 files have zero and still compile nothing.
- A missing lib GLOBAL fails at codegen ("'new' is only supported for a known class"), not at checking, and when it is
  used in a module-level `const` it blocks EVERY declaration in that file. That one shape was the survey's top cause
  (56 declarations, 3 files) and it was two missing classes: `WeakSet` and `SyntaxError` (e7b936f). Check for this
  first when a whole file compiles nothing -- `grep -E "^(const|let) .*new [A-Z]"` over the file finds it in seconds.
  After the fix the top cause blocks 24; next up: `null`/`undefined` where a nullable object type is expected (24),
  ts-parser's `Rule<any>` conversion (22), towasm's unknown method 'parse' (21), object literal needing a known
  target type (17).
- Real tsc for probes: `node_modules/.bin/tsc --ignoreConfig --noEmit --strict --target es2022 file.ts` (TS 6.0.3 refuses
  files alongside a tsconfig otherwise). Check TS semantics this way before modeling them.
- Instruments: the local TypeScript checkout lacks 1339 `.errors.txt` that git tracks, so ~1300 tsc-rejected
  tests count as "clean"; difftest's TS side is transpile-only, so invalid-TS cases slipped in (3 fixed).

## Order
B1 -> D1 -> B5 -> B3 -> B2 -> B4/B6/B8 -> B7 -> C1..C5 -> A cleanup. B before C because B's `any`s both hide
errors and cost towasm typed codegen; C only accepts bad code. Interleave with the corpus false positives
(1203 files), which outrank all of this by the priority rule.
