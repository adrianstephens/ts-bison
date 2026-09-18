---
name: tison-conformance-sweeps
description: "Semantics-first method for tison: per-lib-area differential conformance sweeps in difftest are the gate; ten groups exist, six are green, and every remaining divergence is listed with its repro."
metadata:
  node_type: memory
  type: project
  originSessionId: b3f17fe0-e4c2-48e4-8dae-3996e8d1069c
  modified: 2026-09-07T22:46:44.517Z
---

Adopted 2026-09-07, after the user reframed the goal: **self-hosting was only ever pressure; the real
goal is "compiler"** — semantic correctness against TypeScript. Every bug found before this was
*created* under self-hosting pressure, because constructs were implemented only as deep as backend.ts's
own source exercised them. So **semantic conformance is the gate now**, not the survey.

**The method**: pick one lib area, write a `conform/<area>` difftest group covering every method and
every edge the spec pins down exactly (empty inputs, negatives, reversed ranges, NaN, -0, out of
range, the found/missing answers), run it, and fix what it turns up **as semantics, not as sites**.
The reference answer is computed automatically — difftest transpiles and runs the same source under
real TypeScript — so a case only has to be *interesting*, never *pre-answered*.

Groups, at `3a6a94f` (all in `assistant/difftest.ts`, gitignored) — 2100 cases, 2076 agreeing:

| group | cases | state |
|---|---|---|
| `conform/array` | 54 | green |
| `conform/string` | 52 | green |
| `conform/number` | 67 | green (Number + Math) |
| `conform/map` | 39 | green — passed first try, the only one that did |
| `conform/regexp` | 46 | green |
| `conform/coerce` | 57 | green |
| `conform/lang` | 64 | 1 divergence (`var` shares one binding across a loop; we give `let` semantics) |
| `conform/typedarray` | 68 | 63/68 — 2 divergences (f32/f64 elements), 3 unsupported |
| `conform/bigint` | 65 | 63/65 — 0 divergences, 2 unsupported (see below) |
| `conform/async` | 56 | 41/56 — 11 divergences (one cause) + 4 unsupported |

**Writing the cases parallelises well and the fixing does not.** Three sonnet subagents wrote
`conform/typedarray`, `conform/bigint` and `conform/async` (65+65+56 cases) in one pass each, to a
brief naming the `add(group, name, body, top)` convention, the "body is spliced into `export function
main(): number`" rule, the `HASH`/`h(...)` string comparison, and "declarations go in `top`". All
three landed usable. Roughly half of what a sweep then finds is a checker/towasm bug needing
whole-compiler context, and anything touching the checker needs the [[tison-corpus-errdump]] A/B —
that half is not delegable.

## Remaining known divergences

- **No microtask queue** (11 `conform/async` cases, one cause). `.then` on a settled promise runs its
  callback SYNCHRONOUSLY, and `await` on an already-resolved promise resumes synchronously in the
  same call. Real JS always defers. Documented as intentional in backend.ts's header; it is a real
  feature, not a bug fix. `lib/promise.ts` also has no static `Promise.resolve`, no rejection/`.catch`,
  and `.then` returns `void` (no chaining).
- **`ToInt32` is implemented for the bitwise operators and, through them, typed-array stores.** The
  saturating `coerceTop` conversion remains the deliberate rule for an index or a length.
- **Two limb reads added directly are `i32` arithmetic and WRAP** — the trap `lib/bigint.ts`'s header
  describes, and the cause of its multiply losing a carry. Bind each limb to its own `number` local
  before arithmetic; `toU32` does NOT solve this (tried, reverted, then found the real cause).
- **f32/f64 typed-array elements** don't round-trip fractions — `typedarray.ts`'s byte-composition
  path is `i32`-only, as its own comment says.
- **`var` is compiled with `let` semantics** — one binding per iteration rather than one per loop.
- **`enum` DONE** at `de81f0c`. It is a compile-time declaration: no runtime object, the declaration
  emits nothing, and every member read folds to its constant from an `enumMembers` map the module scan
  builds. Folding straight at the read does NOT work and was tried first — towasm's own scope has no
  knowledge of the enum, so neither `checkerTypeOf(E.B, ctx.scope)` nor the stamped `narrowedTypeOf`
  resolves it to a literal. The collection is what makes the read resolvable at all.
- **An inline `__asm` accessor MUST consume its receiver.** `emitMethodCall` pushes `this` and the
  inline body is expected to take it; every asm accessor written so far is `array.len`
  (Array/String/TypedArray `length`/`byteLength`), which does. One that does not — e.g. a
  `(switch $T ... i32.const 1)` returning a per-instantiation constant — leaves the receiver dangling.
  That VALIDATES for a bare `return x.g;` (wasm's `return` is stack-polymorphic and discards what is
  below) and corrupts the stack the moment the value feeds an expression:
  "f64.add[0] expected type f64, found local.get of type (ref 5)". Verified 2026-09-07 while asking
  whether `TypedArray.BYTES_PER_ELEMENT` could inline: it CAN (the read site becomes a bare
  `i32.const 1`, no call), but not safely, so it stays an ordinary getter calling `elemSize()`. A real
  fix needs the asm's stack effect to be known, which nothing declares today.
- **A generator's `.value` is `Y | R`, and real tsc says so too.** `Generator<number, void, number>`
  makes `g.next(0).value` a `number | void`; returning it as `number` is an error in real TypeScript
  with the IDENTICAL message this checker gives. Four `conform/async` cases were simply invalid TS —
  the cases were fixed with `as number`, not the compiler. Worth remembering: difftest RUNS the
  reference, it does not type-check it, so a case that is a type error still "passes" on that side.
- **`isAssignable(ArrayBuffer, number[])` is `true`** — a one-line repro, and a real checker leniency:
  `ArrayBuffer` has a numeric index signature and `byteLength`, no `length`/`push`, so real TS rejects
  it. It makes towasm's `resolveOverload` (first fit wins) pick `TypedArray`'s
  `constructor(elements: number[])` over `constructor(buffer: ArrayBuffer)`, so
  `new Uint8Array(someBuffer)` dies as "cannot convert arr:i8 to arr:f64" — 5 `conform/typedarray`
  cases. The CHECKER picks the right overload; only towasm's copy of the resolution goes wrong, so
  either tightening `isAssignable` or giving `resolveOverload` a most-specific tie-break would do it.
  Tightening assignability needs the [[tison-corpus-errdump]] A/B. WORKED AROUND at `90443ec` by an
  exact-parameter-match tie-break in `resolveOverload` (towasm-only, no corpus exposure), which closed
  all 5 cases; the underlying leniency is still there.
- `Map`/`Set`'s `keys()`/`values()`/`entries()` return ARRAYS, not iterators. `[...m.keys()]` works on
  both sides; `m.keys().length` does not.
- Still open: `for...of` over a generator (no `Symbol.iterator`); labeled statements; a parameter
  default that CALLS something; `a?.g()` on an anonymous object type; a typed-array read/write out of
  range (JS gives `undefined` / silently ignores); a closure with FEWER params than the callback
  signature when the element type is `any` (`Object.values(o).reduce((a, b) => ...)`).

**The pattern the sweeps keep exposing**: a lib method written to serve one internal caller, correct
for that caller and wrong at every edge JS specifies. `slice` had the identical unclamped-range bug in
`Array`, `String` AND `TypedArray`. `String.substring` was a straight alias for `slice` when it
actually clamps-and-swaps. `Math.round` was wasm's `f64.nearest`, which is half-to-EVEN.
`String.split` pushed the SEPARATOR matches rather than the text between them. `TypedArray.get`
never interpreted its element type at all, so `new Int8Array([200])[0]` read back 200.

**A sweep finds real COMPILER bugs too** — see [[tison-towasm-capabilities]]. The ones no amount of
self-hosting pressure would have surfaced: `lookupMember` had no `literal` case (every method call on
a literal receiver typed as `any`); `'a' + 1` did not compile in either operand order; a class with no
declared constructor had no implicit one; `f?.()` typed as `any` and trapped at runtime; a bare union
alternative inferred the whole union (`T | undefined` vs `number | undefined` gave `T = number |
undefined`, which alone was 8 corpus false positives).

## Gates before committing

- `assistant/difftest.sh` — 0 disagreements outside the list above.
- `npx ts-node -T test/test-towasm.ts` — **must exit 0**; it holds behaviour difftest does not.
- `npm run gate`, `npm run libdecls`.
- **`cd src/examples && npx tsc -p .`** — tison's ROOT `tsconfig.json` **excludes `src/examples`**, so
  `tsc -p .` from `tison/` never type-checks backend.ts, checker.ts, type-utils.ts, transform.ts or
  walker.ts AT ALL. Reporting "tsc clean" from the root is meaningless for every compiler source.
  Separately, `cd src/examples/TS/lib && npx tsc -p .` is the only thing that checks `lib/*.ts`.
- **`npx eslint src/examples/TS --ext .ts`** — 124 pre-existing warnings, so read the ERROR count.
  It catches what tsc cannot, e.g. a `//fall through` marker separated from its `case` by a comment.
- [[tison-corpus-errdump]] A/B for anything touching the checker.
