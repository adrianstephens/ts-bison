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
1. **Iteration protocol.** No general iterated-type; `yield*` (checker 1970-1973) uses a NAME list
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
4. **Tagged templates** (checker 1963) only handle a bare function type: an overloaded tag -> any. Fix: route
   through the call path with `(TemplateStringsArray, ...exprs)`.
5. **`yield` result** is always any (1979); `checkStmt` overwrites an annotated generator's
   `decl.returnType` with N forced to any. towasm dodges it twice (7904-7911 reads the hoisted snapshot;
   7951-7957 passes N separately). Fix: `yield` types as the declared TNext; never overwrite an annotated
   return type; delete both towasm dodges.
6. **`constructor`** -> any by name (type-utils 1803-1804). Fix: delete; lib's `Object.constructor: Function` answers.
7. **Uninferrable type param** -> `default ?? constraint ?? any`, sometimes without even a GAP
   (`declare function g<T>(): T; g().foo` silent). TS >= 3.5 infers `unknown` (checker 1180). Do after B1.
8. `typeOf`'s `default: return T.ANY` (2006) -> exhaustive `never` switch; instantiation expression on a
   non-callable (1783) -> TS 2635.

## C. Accepting incorrect code (lower priority: a false positive blocks tsw, a miss does not)
Each removal will expose false positives -- those are the real bugs; fix them, never restore the leniency.
Order smallest-first, each with `corpus-ab.sh` and a per-file ERR diff.
1. Widened source into a literal target (type-utils 2043, 2050): `const x: "a" = str` and
   `` `a${number}` = str `` accepted. Return false; FPs expose literal-widening precision bugs.
2. Construct-only value called (checker 1597-1599): `C()` accepted. TS 2348.
3. Overload no-fit -> WARNING, args unchecked (1628). TS 2769; needs exact overload resolution first.
4. isAssignable skips methods/call/index members (2087), function params (2070), missing returns (2069):
   `{ f() { return "x" } }` into `{ f(): number }` and `(x: number) => x` into `(x: string) => number`
   accepted. Fix: methods as function types (method bivariance), function-typed props contravariant.
5. isAssignable passes any unresolved/nominal ref (1995-1996, 2080, 2123, 2132): unrelated classes
   `const x: A = new B()` accepted. Fix: classes compare structurally (+ private/protected nominality);
   an unresolvable name is a TS 2304 at its reference, so no downstream leniency is needed.
6. narrowByDiscriminant keeps a member on an unresolvable discriminant (599, 617) -- falls out of B3.

## D. towasm-specific
1. `resolveOverload` (towasm 8347) re-resolves overloads itself, with an exact-match tie-break justified by
   `ArrayBuffer -> number[]` being assignable -- the checker now rejects that. Fix: the checker stamps its
   chosen signature on the call node (like `contextualType`); towasm reads it. One source of truth.
2. `as unknown as` casts (2141, 2880, 8881, 9910) and `new TSWError(e as any, ...)` (catch var): widen the
   helper/TSWError parameter types instead ([[feedback_avoid_unsafe_casts]] in the global store).

## Order
B1 -> D1 -> B5 -> B3 -> B2 -> B4/B6/B8 -> B7 -> C1..C5 -> A cleanup. B before C because B's `any`s both hide
errors and cost towasm typed codegen; C only accepts bad code. Interleave with the corpus false positives
(1203 files), which outrank all of this by the priority rule.
