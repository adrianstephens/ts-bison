---
name: tison-towasm-self-hosting-plan
description: towasm.ts self-hosting roadmap (compile+run its own implementation) -- full plan at ~/.claude/plans/witty-plotting-kernighan.md
metadata: 
  node_type: memory
  type: project
  originSessionId: dd9b34bb-3a6a-434d-b03c-a908764c046d
  modified: 2026-09-04T01:29:58.571Z
---

**CURRENT STATE (2026-09-04) — read this first; the older narrative below is history.**
The "walker.ts compiles clean" milestone was measuring nothing (empty module — see the survey section
at the end of this file). Measured baseline against `5249bff`: **8 of 224 top-level declarations
compile in isolation**; 216 failures reduce to 46 causes, five of which gate ~175. The instrument is
`assistant/selfhost-survey.sh` at the repo root — run it before believing any status claim here, and
work its cause table rather than the plan's file-by-file phases. The full roadmap at
`~/.claude/plans/witty-plotting-kernighan.md` now carries a STATUS CORRECTION block at its top saying
the same; its Phase 2/3/4 sequencing is the wrong cut.

**Goal set 2026-08-19**: make towasm.ts able to compile its own implementation and have the
compiled-to-wasm result actually run as a working compiler (not just "passes the checker without
hitting a gap"). Full roadmap written to `~/.claude/plans/witty-plotting-kernighan.md` — read that
file for the phased plan; this memory just captures the scope decisions and the one hard lesson so
a future session doesn't re-litigate them.

**Scope, decided across the planning conversation (with one reversal)**:
- True bootstrap: the self-hosted image parses raw TS source text itself. This includes `tison.ts`
  (the core LALR/GLR parser-generator engine) and the grammar specs (`ts-parser.ts`/`js-parser.ts`)
  -- NOT treated as a native pre-pass, per explicit user correction mid-plan ("I don't think we
  should avoid tison either"). Only exclusion: `tableCache.ts`'s fs+crypto+zlib disk-caching
  wrapper stays native (an optional perf optimization around the engine, not the engine itself);
  the self-hosted image rebuilds tables fresh each run.
- `binary-libs/src/wasm.ts` (the WasmModule/wasm-byte emitter) is also in scope, needed to actually
  emit real bytes.
- `module-loader.ts` (multi-file resolution) stays out -- orthogonal to a single-entry bootstrap.

**Key lesson (user pushback, keep applying it)**: an early draft proposed flattening
`binary-libs/wasm.ts`'s metaprogramming-heavy table-construction code (`TableBuilder`/`TreeBuilder`/
`insertFactory`/the `I` instruction-factory object, plus `class WasmModule extends bin.Class(WasmSpec)`
-- `bin.Class` is a runtime class factory in `binary/src/sync.ts:234`) into precomputed static data
to dodge the gap. **User rejected this**: the entire point of self-hosting is to drive towasm.ts to
real capability -- rewriting a *dependency's* real source to fit the compiler's current limits
defeats the exercise just as much as simplifying towasm.ts's own source would. Reframed correctly:
these patterns are genuine compile-time metaprogramming over compile-time-constant data, so the
honest fix is a real compiler feature (a general "comptime" constant-evaluator, extending the
existing `foldConstants` pass), not a source rewrite. **Apply this test going forward to any
dependency file pulled into self-hosting scope**: if a construct is hard, ask "is this a real
feature towasm.ts should have" before proposing to change the source being compiled.

**Two features identified as gating/foundational, needed by both the backend AND the parser engine**:
1. General `instanceof` -- transform.ts needs it for user classes; tison.ts needs it against
   **built-in `RegExp`** too, not just user classes (`Terminal`/`NonTerminal`). Design it to cover
   both from the start.
2. `Map`/`Set` self-hosted support -- single biggest pervasive blocker, 76+ uses across the backend
   files, 46 in tison.ts itself. No `lib/map.ts`/`lib/set.ts` exist yet.

**Six-phase structure** (see the plan file for full detail): (1) de-risk spikes -- instanceof design,
comptime-evaluator design, RegExp `.flags`/sticky-lastIndex parity check against the existing
`lib/regexp.ts` self-hosted RegExp (829 lines, already has a real bytecode VM -- likely just needs
verification, not new implementation); (2) backend gap-closing (checker/type-utils/walker/transform/
towasm.ts); (3) engine gap-closing (tison.ts + grammar specs); (4) wasm.ts via the comptime feature;
(5) integration -- self-hosted image compiles its own full dependency set from source text, emits
real wasm, that output still compiles correctly (fixed-point bootstrap check); (6) stretch:
byte-diff native-vs-self-compiled output, self-hosted table caching, module-loader.

**Status as of 2026-08-19**: Phase 1 item 1 (`instanceof`) DONE — smaller than estimated (parsing
and checker narrowing already existed; only codegen was missing), lowers to `I.ref.test(cls.typeIndex)`,
reuses the same shared-rec-group mechanism `ensureVirtualDispatch` already relies on for sibling-class
distinctness, 6 new tests passing, full suite green. towasm.ts's own gap comment updated. **Found,
not fixed**: guarding a caught `any` with `instanceof` doesn't let codegen resolve a field access
inside the narrowed branch (checker narrows correctly, codegen's owner/field lookup doesn't see it) —
real, separate, still open, now Phase 2 item 8.

**Phase 1 item 2 ("comptime evaluator") retired and replaced, wrong model** — see
[[feedback_types_vs_runtime_behavior]]. Corrected design: `binary-libs/wasm.ts`'s hard patterns split
into (a) `extends bin.Class(WasmSpec)` → instantiate the generic factory via existing generic
substitution machinery, splice its returned class in as superclass; (b) the `I` table's construction
→ generic function expressions as values (shared with walker.ts) + genuine dynamic-shape-object
support. Dynamic objects (real hash-backed `{}`/bracket/`for...in`) confirmed with the user as a
first-class feature they want, explicitly NOT routed through Map/Set even once those exist — covers
both `insertFactory` and walker.ts's `mapObject` blocker via one mechanism, no separate
monomorphization path needed up front (that's an optional later optimization, triggered by
call-site literal-ness if ever pursued, not declared-type shape).

**Follow-on scoping win (2026-08-19)**: checked how much of Map/Set + dynamic-objects is actually
new compiler work vs. library work, since `case 'index'`/`emitAssignTarget`'s index-target case
already dispatch `obj[k]`/`obj[k]=v` generically to any class's own `get(key)`/`set(key,value)`
methods (key-type-agnostic — same mechanism `Array`/`Uint8Array` already use). Result: `Map`/`Set`
(real JS never uses bracket syntax, only `.get()/.set()/.has()/.delete()`) is ~100% a `lib/` task,
same style as `lib/regexp.ts`'s bytecode VM. Dynamic objects' bracket read/write is already free via
the existing mechanism; only `delete obj[k]`, `k in obj`, and `for...in` are genuinely new codegen
(confirmed zero handling for any of the three today), each fitting the same established
generic-dispatch-to-conventional-method-name pattern. Much smaller compiler surface than first
scoped — see the plan file's Phase 2 items 1/1b for full detail.

**Phase 1 COMPLETE (2026-08-19)** — all three items done: instanceof, comptime retired+replaced,
RegExp parity (added `sticky`/`.flags` to `lib/regexp.ts`, `exec()` now branches sticky-exact-position
vs global-scan, 4 new tests passing).

**Phase 2 item 1 (`Map`/`Set`) DONE (2026-08-19)** — `lib/map.ts`/`lib/set.ts`, linear-scan (parallel
arrays + `===`, not a real hash table -- legitimate O(n) perf tradeoff, `===` is already correct
per-type in this compiler so key equality needs zero special-casing for string vs ref keys). No
`lib.d.ts` ambient split needed, unlike Array/RegExp. 9 new tests, full suite green.
**Found and fixed 2 real, general, previously-unknown towasm.ts bugs while building this** (both
predate this session, affect any user program, not just Map/Set): (a) empty-array-literal (`[]`)
kind inference only consulted the declared target type for the `'ref'`-widening case, never for a
scalar target -- `const x: number[] = []` failed outright; (b) the `===` `ref.eq` fallback passed a
boxed-`any` array element straight to `ref.eq`, which wasm validation rejects (`eqref` required) --
meant `Array<T>.indexOf`/`.includes`/`.lastIndexOf` (already-shipped, documented-supported) silently
never worked for a class-typed `T`, just never exercised that way before. Full details + fix
locations in the plan file. Deferred (not new to this item): `for...of` over a Map/Set needs the
already-tracked general-iterable gap.

**Side quest, `this`-typed returns, DONE (2026-08-19)** -- surfaced when the user flagged an
undocumented gap I'd silently worked around in lib/map.ts (`): this` declared as `): Map<K,V>`
instead). Fixed for real: (1) `ensureMethod`+`case 'var_decl'`'s bypass both substitute `this` with
the declaring class's own type before codegen sees it; (2) a REAL checker-level gap fixed too --
`checker.ts`'s `case 'call'` never substituted `this` with the receiver's own type at a call site at
all, now does, correctly covariant through a subclass; (3) `coerceTop` gained the missing symmetric
downcast case (only had the free upcast direction before) for the covariance case to actually work;
(4) found and fixed a separate, serious, general, previously-unknown bug this surfaced: a scalar-only
class (`ensureCtor`'s `struct.new_default` shortcut path) silently skipped ALL class-level field
initializers, always leaving them at wasm's zero-default regardless of constructor body -- fixed in
`emitCtorStatements`. New shared utility `T.substituteThisType` (type-utils.ts). 11 new tests, full
suite green. See [[feedback_no_simplifying_deps_for_selfhosting]] -- same "gap flagged, fixed not
worked around" instinct extended to towasm.ts's own gap comment, not just dependency source.

**Side quest 2, default parameter value restricted to a bare literal, DONE (2026-08-19)** -- user
asked directly about an undocumented-gap comment noticed in lib/map.ts (an entries-array convenience
constructor I'd dropped rather than fixed, back when Map/Set were first built). Root-caused: fixed via
a small recursive `isReemittableDefault` check (literal, or array literal of recursively-safe
elements) -- `emitCallArgs` re-emits a default verbatim per omitted call site, so the only real
constraint is "no external name reference," which a literal or array-of-literals both satisfy. 4 new
tests, full suite green. Note: mid-session the user (while I was unavailable due to a session-limit
reset) merged lib/set.ts into lib/map.ts by hand -- towasm.ts's LIB_AST file list updated to match.

Attempted item 3 (generic arrow/function expressions) next and found the real walker.ts blocker is
narrower and different than first scoped: NOT "generic arrow expressions" (those already work
standalone) but specifically (A) "a generic function type" as a stored/returned VALUE's own static
type (`closureFuncSigType` rejects any function type with `typeParams` outright) -- user wants a
real per-bound-instantiation fix if reasonable, not universal anyref-boxing, still in progress; and
(B) a plain named function used as a value AT ALL (not just self-reference -- `helper` passed as an
ordinary callback throws a bare `"unknown"`) -- agreed to do B first, not yet implemented.

**Gap B (function-as-value) DONE (2026-08-19)** -- a plain top-level named function used as a value
(callback/assignment/array element) threw a bare `"unknown"` unconditionally. Fixed via
`ensureFunctionValueWrapper`: one small, shared, zero-capture trampoline per function name (same
`{code,env}` shape `emitClosureLiteral`'s own zero-capture case builds), since an ordinary top-level
function has no `env` param and can't be read as a closure value directly. Confirmed a *nested*
function-as-value (sibling reference, not self-reference) already worked before this fix -- genuinely
new capability was specifically top-level functions. Confirmed the real, still-open, already-precisely
-documented self-reference gap is unaffected. Also cleaned up the bare `throw "unknown"` into a real
`Error`. 5 new tests, full suite green.

**Gap A (generic closure values) DONE (2026-08-19)** -- real bound-substitution, not universal
anyref-boxing, per the user's explicit direction. Fixed both `closureFuncSigType` (a function type
annotation) and `emitClosureLiteral` (the actual arrow/function expression): each type param ->
its own upper bound (`p.constraint ?? T.ANY`, unconstrained falls back to boxed any), reusing
`substituteTypeParams` -- the same mechanism generic function/method instantiation already uses, not
new machinery. Free when bounded (real wasm-GC upcast). **This closes Phase 2 item 3's actual
walker.ts blocker** (both function-as-value and generic closures now fixed and tested in isolation;
walker.ts itself not yet re-attempted end to end). 4 new tests, full suite green.

**Found and fixed a real regression while testing Gap A**, unrelated to Gap A itself: the user's
lib/set.ts->lib/map.ts merge restored a Map/Set `entries`-array convenience constructor that broke on
two separate things: (1) `entries?: [K,V][]` (optional, no `=`) isn't treated as omittable by
`emitCallArgs` -- confirmed also undocumented (asked about directly, same pattern as every other gap
this session), scoped but not fixed (needs synthesizing implicit `undefined` + nullable wtype); (2)
switching to `entries: [K,V][] = []` surfaced a genuinely separate, real gap: **this compiler has no
physical representation for tuple arrays at all** (`entries[i][0]` fails even for a bare standalone
`[number,number][]` local) -- confirmed directly, not assumed. Resolved by dropping Map's `entries`
constructor (back to `constructor() {}`, matching what nothing in this project needs) rather than
pulling in tuple support as a side effect. Set's own `values: T[] = []` has no such problem (plain
array, not a tuple) and was left as-is.

**Tuple array support DONE (2026-08-19)** -- user's own design call (tuples just use the existing
boxed `ref`-kind "everything else" array storage, checker already tracks precise element types) was
exactly right. Fixed `wasmTypeOf`: `'tuple'` -> `ARR_WTYPE.ref`, one line, sufficient for a directly
target-typed tuple immediately. Getting a *nested* tuple literal working (needed for Map's `entries`
constructor) surfaced a real, separate checker gap: array-literal inference never threaded
contextual/expected types to elements at all (object literals already did) -- fixed `case 'array'` in
checker.ts to thread `expected` per-element and shape the literal's own type as a tuple when
contextually one (also a genuine new type-error-detection capability, verified). A third piece:
towasm.ts's own array-literal codegen picks its physical kind via a fresh, uncontextualized checker
call, so the checker fix alone didn't reach it -- generalized the existing "`want` wins" rule instead
of threading TS types through the whole call chain: an array literal now picks ref-kind storage
whenever the context wants ANY boxable-as-any value, not just an explicit `{arr:'ref'}` target
(reasoning: scalar-kind and ref-kind wasm arrays are physically incompatible types, so picking scalar
for something about to be boxed anyway forecloses ever un-boxing it correctly later). 4 new tests,
full suite green. Map's `entries` constructor restored for real (superseding the earlier "dropped it"
resolution). Bare-optional-param-without-default (found along the way, confirmed undocumented too)
still not fixed -- scoped, not attempted.

**Dynamic objects (item 1b) DONE (2026-08-19)** -- real `{}`/bracket/`delete`/`in`/`for...in` syntax,
physically backed by `Map<string,V>`'s own hash table under the hood (`indexSignatureValueType`
recognizes a structural `{[k:string]:V}` type, routes `typeOf`/`ownerFor` to `ensureClass('Map',
[string,V])`) -- not routed through Map/Set syntax in the source being compiled, per the user's
earlier explicit call. Bracket read/write free as predicted. Object-literal construction, delete/in/
for-in all landed as scoped in the plan. **Found a real, general, previously-unknown bug along the
way**: `emitAssignTarget`'s index-write callback assumed the storage call leaves nothing on the stack
(true for every prior `void`-returning `set(i,v)`) but `Map.set()` returns `this` for chaining --
needed an explicit drop, a genuine stack-imbalance bug, not dynamic-object-specific, just never
exercised by a non-void `set` before. 7 new tests including one mirroring wasm.ts's real
`insertFactory` shape directly, full suite green. Gap comment updated (for-in scoped, new delete/in
line). `binary-libs/wasm.ts`'s `insertFactory` blocker now fully closed. **Caught and corrected an
overclaim on review**: walker.ts's `mapObject` blocker is NOT fully closed by this -- `fields:
NodeMap<N>` is a mapped type over `keyof N`, structurally different from the plain index signature
this fix handles; still needs the separately-scoped monomorphization approach, not attempted.

**mapObject/keyof/type-param-registration investigation, CLOSED (2026-08-20/21)** -- started from the
user asking why `walker.ts`'s `mapObject` comment treated a mapped type as needing special handling
when it's physically the same as a dynamic object. Real gap found: composing `Partial`/`Record`/
`keyof` over a mapped type never resolved (fixed in `type-utils.ts`'s `resolve()`, `indexed_access`/
`keyof` cases), and `keyof <bounded type param>` never resolved to its constraint because a
function's own type parameters were never registered into any scope at all (`checkFunctionBody` now
calls a new `Scope.addTypeParam`, using the constraint as a real resolvable upper-bound; `isAbstract`
gained a `TypeEntry.isTypeParam` flag so a registered-but-still-abstract param keeps deferring
conditional types correctly). Per [[tison_declscope_investigation]]'s known fragility, this was
verified via full backup/revert/restore against the whole-workspace sweep (`test-ts-parser.ts`), not
assumed safe. **Registering type params exposed four separate, real, previously-latent bugs** (this
class of change makes a previously-always-opaque, always-leniently-tolerated type param real and
resolvable, which stops masking whatever was underneath) -- all four root-caused via a real corpus
file's regression, not guessed, and all four fixed:
1. `narrowValue` (checker.ts) only flattened one level of nested union -- a type param's constraint
   chain (`builtinNumber | Pick<...>`, itself `number|bigint`) stayed opaque to `typeof`-narrowing.
   Fixed by making the candidate-flattening recursive.
2. `stampSig` (type-utils.ts, used by `hoist()`'s pre-pass for nested function declarations) stamped
   a hoisted function's *entire* signature -- including references to its own type parameters --
   with the *enclosing* scope, before the function got its own body-check scope; `declScope`'s
   set-once semantics then permanently shadowed a nested function's own `T` with the outer function's
   same-named `T`. Fixed by excluding a signature's own type-param names from the stamp.
3. `preArgTs` (checker.ts's `case 'call'`) never threaded a matching declared param type as `expected`
   into a non-callback call argument at all -- a literal argument (`heap.push([1, arr])` against a
   tuple param) silently inferred as a plain, wider array and failed assignability for real. Fixed by
   threading `sig.params[i]?.typeAnnotation` as `expected`, skipped when it still mentions one of the
   callee's own not-yet-inferred type params (avoids the chicken-and-egg with `preMap`, built from
   this same pass).
4. Real generic-substitution capture: `Array<T>.map<U>`/`.reduce<U>`/`.every|filter|find|findLast<S>`
   (`arrayMethod` in type-utils.ts) are hand-built signatures using the *literal* names `'U'`/`'S'`,
   constructed directly rather than through `substituteType` -- calling `.map()` on a `U[][]` inside a
   method whose *own* type param also happens to be named `U` let the substituted-in ambient `U`
   silently capture `map`'s own, unrelated `U`, corrupting `inferTypeArgs`'s purely name-based
   matching. Fixed two ways: (a) `arrayMethod` now generates a fresh, guaranteed-unique name per call
   (`freshTypeParamName`, an apostrophe suffix no real identifier can ever contain) instead of the
   hardcoded literal; (b) general capture-avoidance added to `substituteType` itself (`avoidCapture`,
   wired into both the `Type`-node and `TypeMember`-node walk callbacks) for the general case of any
   nested signature's own type param colliding with a substituted-in value -- (a) was the fix that
   actually mattered for the observed bug, (b) is real, tested-effective general hygiene kept for
   future cases sourced from real (not hand-built) generic interfaces.
Confirmed via the full whole-workspace sweep: true baseline GAP:1122/WARNING:278/ERROR:160; after all
four fixes, GAP:1068 (-54, more things resolve concretely instead of gapping out)/WARNING:278 (flat)/
ERROR:163 (+3, all three from one single remaining file, see below) -- a net improvement everywhere
else in the entire monorepo. `test-towasm.ts`/`test-tison.ts`/eslint all still clean.
**One regression deliberately deferred, not fixed**: `maths/src/vector.ts:594`, `return r;` where `r:
C|undefined` is assigned a `C` value in every branch of a preceding `if/else` -- real TS would narrow
this away, but this checker's `case 'if'` never merges branch-end narrowing back into the scope used
for subsequent statements at all (no post-if flow-merge exists, period). This was ALWAYS a real gap;
it was masked because an unresolved, opaque type param was always leniently treated as assignable
from `undefined`, and `C` only stopped being opaque once type params started being registered.
Implementing real flow-merge narrowing is a substantially bigger, more architectural feature than any
of the four fixes above (same risk class as the historically-fragile changes) -- user's explicit
call: land the four fixes, defer this one, document it here rather than take it on now.

**Item 4 (`for...in`, the mapped-type half) DONE (2026-08-21)** -- correcting the "NOT fully closed"
note above: `walker.ts`'s own `mapObject` blocker (`fields: NodeMap<N>`, `Partial<{[K in keyof N]:
F}>`) is now reached by the same `Map`-backed dynamic-object codegen as a plain index signature.
Verified end to end (`for (const f in fields) total += fields[f]` over `Partial<Record<string,
number>>` sums correctly through real wasm), 2 new tests, full suite green. Three more real bugs
found and fixed to get here (same "registering things for real exposes latent gaps" pattern as the
section above, but this time in towasm.ts's own codegen, not the checker):
1. `resolve()`'s `indexed_access`-over-`'mapped'` case (added earlier this same investigation, see
   above) checked `object.type === 'mapped'` *after* a full `resolve()` call -- but `resolve()`'s own
   `'mapped'` case *already* collapses a keyable-constraint mapped type (`Record<string,T>`-shaped,
   exactly what `Partial`/`NodeMap<N>` reduce to) into a plain index-signature object before ever
   returning, so the check never fired for exactly the common case. Fixed by peeling through `ref`
   aliases only (`expandRefOnce`, looped) to detect `'mapped'` *before* letting that collapse happen.
2. A homomorphic mapped value's own `T[P]` composition, once `P`'s constraint reduces to a bare
   `string` (not a literal), needed a genuinely new case: `resolve()`'s `indexed_access` handling only
   ever matched a literal (or union-of-literals) index against an object's members -- `Record<string,
   number>[string]` (a non-literal index matching an index *signature's* own key type) fell through to
   opaque. Added: when the resolved object has an index signature whose key type the index is
   assignable to, return that signature's own value type -- real TS gives exactly this.
3. `resolve()` had **no `'array'` case in its switch at all** -- an array's own `.element` was never
   resolved recursively, ever, at any call site, before this investigation (a second, independent gap
   from the same missing-recursion family as `narrowValue`'s one-level union-flatten bug earlier).
   Added one, but it took two follow-on regressions to get right, both real, both fixed: (a) a wasm
   pseudo-type element (`i8[]`/etc, `declare type i8 = number` in lib.d.ts) must survive unresolved --
   `WASM_PSEUDO_TYPES` (previously only 5 of the real 10 declared pseudo-types) widened to all 10, plus
   an explicit guard in the new case; (b) the element resolution must always pass `stopAtRef` regardless
   of the outer call's own value -- a named class/interface element (`Animal[]`) must stay a clean ref,
   never expanded into its structural shape, or `ownerFor`'s own class-dispatch lookup (`animals[0]
   .sound()`) loses the name it dispatches by entirely. Both found via the *existing* test suite
   actually regressing (`Uint8Array` literal construction, class-array method dispatch) -- not
   hypothetical, real zero-regression bar enforced throughout.

**New feature: closure covariant-return coercion, DONE (2026-08-21)** -- found while pushing `NodeMap
<N>`'s own function-valued mapped type (`Partial<...>`'s `?`-optional widens every value with `|
undefined`) toward actually compiling: a closure literal whose own concrete return is narrower than
the slot it's assigned into (`(x:number)=>number` fitting `(x:number)=>number|undefined`, real TS
covariant-return assignability) has no in-place fix -- unlike a scalar, a closure's own compiled wasm
function signature is fixed forever at its own `funcTypeIndex`. Added `ensureClosureCoercionWrapper`
(towasm.ts): one shared trampoline per (source signature, wanted result) pair -- takes the original
closure wrapped in a small dedicated one-field env struct (a real subtype of `envBase`; the {code,env}
pair itself is *not* one, so it can't be used as an env directly), forwards every argument unchanged
via `call_ref`, coerces just the return through the existing `coerceTop`. Wired into `coerceTop` itself
as a new "both sides are closures, params match, only result differs" branch. 1 new test, full suite
green.

**New feature: dynamic-object spread (`{...other, k: v}`), DONE (2026-08-21)** -- also found pushing
towards a real `mapObject` (`const r = {...node}`). The `Map`-backed object-literal construction path
previously only handled plain `key: value` properties (chained via `set`'s own `this`-return); a
spread needs a real loop (copy every key the spread argument currently holds via `.keys()`/`.get()`),
so the map instance under construction needs a real local to reference repeatedly instead of the
stack-chaining trick. Falls back to the original chained-call path when no spread is present (zero
risk to the already-tested no-spread case). Reuses the same `for (const k of x.keys()) ...` AST-
synthesis idiom `case 'for'`'s own `'in'`-kind desugaring already established. 2 new tests (including
copying entries then adding one), full suite green.

**Also fixed in passing**: the last remaining `JSON.stringify` call in towasm.ts's own source
(`resolveAsmLocals`'s error message for an unsupported inline-asm local type) reworded to avoid it --
Phase 2 item 7 (JSON.stringify reword) is now fully done, 0 remaining call sites.

Whole-workspace sweep re-confirmed after all of the above: GAP:1065, WARNING:285 (the +7 vs. the
1068/278/163 checkpoint above is a new, unrelated, untracked file the user added mid-session --
`test/test-ts-official.ts`, an official-TS-suite test harness -- hitting a real, pre-existing, entirely
unrelated GLR parser ambiguity-explosion limit parsing `transform.ts`'s own source; confirmed by its
absence from the earlier sweep and by the warning-line-diff showing zero change to any file this
session actually touched), ERROR:163 (unchanged). `test-towasm.ts` (410 tests, 3 new this round),
`test-tison.ts`, eslint (0 errors) all still clean.

**Still open, walker.ts's `mapObject` itself, not yet fully compiling end to end**: pushing the *exact*
real construct (`mapObject<N extends Record<string,any>>(node: N, fields: NodeMap<N>): N { const r =
{...node}; ...}`) surfaced one more real, deeper, separate issue past the three above -- inside a
generic function's own body, `{...node}`'s own contextual target type resolves using `N`'s *declared
bound* (`Record<string,any>`, giving `Map<string,any>`) while `node` itself (the same type param `N`,
read directly off its own parameter) resolves to the *call site's real argument type* (`Record<string,
number>`, giving `Map<string,number>`) -- a genuine inconsistency in which substitution towasm.ts's own
generic-function monomorphization applies to different expressions within the very same function body.
This is a different, more foundational category than the fixes above (about generic-function
compilation consistency generally, not scoped to mapObject or dynamic objects) -- user's explicit call:
land everything above, defer this one, document it here rather than take it on now.

**`Object.entries` + the `makeLibScope` muted-check trade-off, CLOSED (2026-08-21)** -- user's design
brief: implement `Object.entries` (more prevalent than spread), reuse it as a general `for...of`
fallback later, fix for-loop-init destructuring, defer the extended/subclassed-receiver case, prefer
`lib/*.ts` source over hand-built intrinsics. Landed:
- for-of destructuring fix: `case 'of'`'s loop-variable check rejected any non-plain-identifier
  pattern for no real reason -- `JS.Var`'s `BindingTarget` and the existing `case 'var_decl'` handling
  already support patterns generically. One-line fix.
- `emitObjectEntries` (towasm.ts) + `declare var Object: { entries<T>(x): [string,any][] }` (lib.d.ts,
  matching the existing `Math`/ambient-namespace idiom) -- dispatches to a Map-backed object's real
  `.entries()`, or synthesizes a tuple-array literal from a *sealed* (never-subclassed) struct's own
  fields; throws a clear "not supported yet" for an extended class (deferred per instruction, needs
  the receiver's real runtime type).
- `defaultsWithImplicitUndefined` (towasm.ts): separate real gap found on the way -- `emitCallArgs`
  never treated a bare `optional` modifier (no `=` default) as omittable, breaking `Array<T>.map`'s own
  `thisArg?: any`. Synthesizes an implicit `undefined` default for any optional-but-defaultless param.
- The actual blocker, root-caused not guessed: `Map.entries()`'s own `.map()` callback never got
  contextual param typing (`k`'s type stayed unannotated), because `makeLibScope()`'s one-time muted
  `checkBlock(LIB_AST, libScope)` call hit `checkFunctionBody`'s early-return (`if (expected && !err)
  return;`) for any lib method with a declared return type -- skipping the body walk entirely, so
  `applyContextualParams`'s side effect (fills in an unannotated callback param from the call's own
  contextual signature) never ran. This is the exact trade-off `makeLibScope`'s own comment already
  documented as tried-and-reverted: unmuting fixed narrowing-dependent bodies (`String.split`) but broke
  every generic lib class method (`Array<T>.reverse`/`.fill`), since the stamp left on `fn.scope`/
  `(stmt as any).scope` was the *template's* own, with `T` unresolved, and `??=` first-wins then
  permanently blocked the real per-instantiation scope (`ctx.scope`) from ever being used instead.
  User's call when asked: "investigate the muted-check trade-off now," not just land the sealed-struct
  case and defer the Map path.
- **Real fix**: decoupled "walk the body" from "stamp the scope" instead of treating them as one
  choice. New `Scope.isGenericTemplate()` (type-utils.ts) -- set on a generic class's own `instScope`
  in `checkClassMembers` (flagged whenever the class itself declares type params). `checkFunctionBody`
  computes a `noStamp` flag (`!!expected && !err && scope.isGenericTemplate()`) and threads it as a new
  trailing param through `checkBlock`/`checkStmt` (every other caller leaves it `undefined`, unaffected)
  -- when true, `checkStmt` skips its `(stmt as any).scope ??=` stamp but still fully walks the body
  (so `applyContextualParams` still fires). `fn.scope`'s own stamp is guarded by the same `noStamp`
  value, not a bare `scope.isGenericTemplate()` check directly -- **this distinction mattered in
  practice**: a first attempt gated purely on `isGenericTemplate()` and broke `Array<T>`'s own
  constructor (`skipReturn` always forces `expected` falsy for a constructor, so it was never part of
  the risky case at all, but it's still checked under the same generic-flagged `instScope` -- a bare
  scope-level check caught it by accident, crashing on `m.scope` being unexpectedly unset elsewhere in
  towasm.ts). The precise, narrower condition (muted + declared-return + generic, computed once in
  `checkFunctionBody` and threaded explicitly rather than re-derived from scope alone) fixed both: real
  bug gone (`Map.entries()`, `Set.entries()` both now type correctly) and zero regression to
  constructors/String/other generic methods.
- **Second, unrelated real gap found immediately after**: even with `k` correctly typed, the arrow
  `(k,i) => [k, this.values_[i]]` (2 params) failed coercion into `Array<K>.map`'s real 3-param
  callback signature (`value, index, array`) -- entirely ordinary JS (`arr.map(x => x*2)` never
  declaring `index`/`array` either), but `coerceTop`'s existing closure-coercion wrapper (built earlier
  this session for covariant-*return* mismatches only) required exact param-count equality. Generalized
  `ensureClosureCoercionWrapper` to accept a full `wantSig` (not just `wantResult`): the trampoline now
  declares `wantSig`'s full arity but only forwards the leading `gotSig.params.length` args to the
  original closure, silently dropping the rest -- same as real JS never binding a callback's
  undeclared trailing params. `coerceTop`'s guard widened from `===` to `<=` on param count (still
  requires the shared leading params to match exactly; a real mismatch or `got` wanting *more* params
  than `want` offers still throws).
- Verified via `test-towasm.ts` (410 tests, full green), `test-tison.ts` (clean), eslint (0 errors, only
  pre-existing warnings), and the whole-workspace sweep (`test-ts-parser.ts`): GAP 1065->1059 (-6,
  improvement), WARNING 285->284 (-1), ERROR 163->163 (flat) -- net improvement, zero regressions, same
  verify-before-trusting discipline [[tison_declscope_investigation]] established.
- Still outstanding per the original design brief: wiring `Object.entries` into `for...of`/`for...in` as
  a general fallback "wherever there isn't a more efficient way" -- not started, was explicitly deferred
  until `Object.entries` itself (including the Map path) worked end to end, which it now does.
- Found in passing, NOT fixed: `constructor(public x: number, ...) {}` parameter-property syntax
  silently skips field-assignment codegen entirely (uses `struct.new_default`, fields stay zero) --
  real, general, pre-existing, separate from everything above. Flagged, not yet fixed.

**Parameter-property constructor bug + `for...in`→`Object.entries` wiring, DONE (2026-08-21)** --
both flagged as remaining items above, now closed:
- **Parameter properties silently unassigned on the scalar-only ctor path, fixed.** Confirmed via a
  minimal repro first (`class Point { constructor(public x: number, public y: number) {} }` gave `0`
  for `p.x*10+p.y`, expected `34`): `ensureCtor`'s `struct.new_default` fast path (any all-scalar-field
  class) never assigned a parameter property at all -- there's no `this.x = x` statement anywhere in
  the constructor's own body for TS to find (real TS synthesizes that assignment itself), so unlike the
  object-typed-field path (which already had its own correct `setField` loop over `ctor.params`), the
  scalar fast path's `emitCtorStatements` only ever handled declared field initializers (`= 99`), never
  parameter properties. Fixed by threading `ctor.params`/`superCtor.params` into `emitCtorStatements`
  (new required param) and adding `emitParamPropertyInits`, called *before* `emitOwnFieldInits` at both
  existing call sites (top-level and post-`super()`) -- verified against real TS's own emit order
  (parameter properties assigned first, *then* field initializers, even though a field's `= value` is
  textually declared above the constructor -- confirmed via a `y = this.x + 1` field initializer
  depending on a param property, matters when one references the other). 3 new tests (scalar-only,
  mixed with an ordinary field initializer, inherited via `super()`), full suite green (413 tests).
  **The "field initializer reads a sibling field mid-collection" issue flagged here turned out to
  already be fixed, CLOSED (2026-08-21)**: re-tested after the `setField`-unification work below and it
  now works (`y = this.x + 1` where `x` is a param property collected earlier) -- `case 'member'`'s own
  pre-existing `ctx.ctorFields`-aware shortcut (reads an already-collected field's own scratch local
  directly, never needing a real `this` at all) combined with the param-property-before-field-init
  ordering fix above was already sufficient. 1 new permanent test added.
- **`for...in` now falls back to `Object.entries` for a sealed (never-subclassed) class/object-shape**,
  closing the gap-list line that previously said "for-in over anything but a dynamic object" outright.
  `case 'in'` still takes the existing efficient `.keys()` path when available (Map-backed/dynamic
  object, unchanged); otherwise desugars to `for (const [k] of Object.entries(obj)) body`, pulling just
  the key out of each pair via ordinary array-destructuring in the loop variable (this session's earlier
  for-of-destructuring fix) -- deliberately reuses `emitObjectEntries`'s own dispatch rather than
  re-deriving the sealed/extended check, so an extended class gets the same "not supported yet" error
  for free. 4 new tests (sealed-struct key count, dynamic-object path unchanged, plus 2 direct
  `Object.entries` tests that had never actually been landed in the real suite before -- the original
  Object.entries work earlier this session was only ever verified via now-deleted scratch scripts) plus
  1 `checkThrows` test for the extended-class rejection, full suite green (418 tests total).
  **`for...of` over Map/Set as a general iterable is explicitly NOT done** -- real design fork noticed
  but not resolved: Map's own `for...of` yields `[k,v]` pairs, Set's yields plain values, and picking the
  right one needs a *structural* signal (not a literal `'Map'`/`'Set'` name check, forbidden per
  [[feedback_no_name_special_casing]]) to distinguish them generically. Left for a future session with
  that design question in scope, not attempted under time pressure here.
- Whole-workspace sweep after both fixes: GAP 1080 (flat), WARNING 308->307 (-1), ERROR 167 (flat) --
  net neutral-to-improved, zero regressions. `test-towasm.ts` (418 tests), `test-tison.ts`, eslint (0
  errors, only pre-existing warnings) all clean.

**Cross-session coordination note (2026-08-21)**: a second Claude session (`packages-e5`) worked the
parsing-engine side (Phase 3: tison.ts/js-parser.ts/ts-parser.ts) concurrently in the same working tree
this session. Landed, independently verified: a real ASI-recovery bug (`js-parser.ts`'s `recover`
checked `lex.remaining.startsWith('}')`, but the lexer has already advanced past the failing token by
recovery time, so that check could never actually fire for its own documented case -- fixed by
threading the real failing token through the recovery call chain, `RecoveryLexPosition.token`), fixed
5 `\u{...}` codepoint-overflow crashes, and a setter-parameter-destructuring gap (3 separate hardcoded
bare-IDENT spots in `ts-parser.ts` never accepted `set foo({a,b}: T)`). Impact on the official-
TypeScript-tests corpus (a separate, much larger corpus than this monorepo, `test/test-ts-official.ts`):
2895->2606 crashes from the ASI fix alone. Division of labor going forward: `packages-e5` owns
tison.ts/js-parser.ts/ts-parser.ts, this session owns checker.ts/type-utils.ts/towasm.ts -- each pings
before touching the other's files, given we share one working tree, not separate worktrees. One real,
well-characterized parser bug remains open in `packages-e5`'s queue (not this session's): an arrow
function with a destructured+typed parameter (`({a,b}: Foo) => a`) fails while the equivalent plain
`function` doesn't -- confirmed a genuine LALR "missing transition" (`tables.conflicts` empty, so
`forceFork` can't resolve it), explains the still-open `wasm.ts`/`MsBuild.ts`/`transform.ts` (both
copies) sweep failures; paused pending `packages-e5`'s own next-priority decision, not a dead end.

**`emitCtorStatements`/`setField` unification, DONE (2026-08-21)** -- the user's own refactor (adding a
`setField: (field, value) => void` callback param to `emitCtorStatements`, shared by both the scalar
(`struct.new_default`) and object-typed (collect-then-`struct.new`) constructor paths, replacing two
separate ad-hoc implementations) exposed a real gap the user flagged directly: nothing stopped `this`
from being used (read, method-called, returned) before it actually exists on the collect-then-construct
path. Closed with two general, single-choke-point guards, not scattered special-casing:
- `case 'this'` (`emitExpr`): throws a clear error whenever `ctx.ctorFields` is still set at the point
  `this` would otherwise resolve to a value -- reading an *already-collected* field still bypasses this
  entirely (`case 'member'`'s own pre-existing shortcut returns before ever evaluating `this` as an
  expression), so only a genuinely-too-early use (an uncollected field, a method call, `this` passed/
  returned/captured as a value) ever reaches this guard.
- `case 'return'`: same reasoning -- a `return` (bare or valued) implicitly needs `this` to exist too
  (`ctx.onReturn` is still the generic `plainReturn(thisWtype)` handler mid-collection, which would
  otherwise either emit invalid wasm for a bare return or try to coerce an arbitrary value into the
  class's own struct type), caught here for the same clear message instead.
Also restored the historically-supported pattern (an explicit `this.field = value` statement written in
the constructor body, not just a param property or field initializer) that the user's unification had
silently dropped: `emitCtorStatements`'s own loop now recognizes this exact shape (gated on
`cls.fieldIndex.has(...)`, so an accessor write like `this.someSetter = x` still falls through to
ordinary codegen, correctly caught by the `this`-guard above if attempted too early) and routes it
through `setField`. `setField`'s own object-typed implementation gained an "already constructed"
fallback (`!ctx.ctorFields` -> ordinary field-write codegen) so a genuine reassignment after every field
is already collected still works, not just the first-ever assignment. Fixed a regression in an existing
test this surfaced (`"a bare 'return' before every object-typed field is assigned is rejected"`) and
confirmed the "field initializer reads an already-collected sibling field" case flagged just above is
now fully closed too (see its own updated note). 3 new tests, full suite green (421 tests). Also
simplified `emitObjectEntries`'s own outer-array codegen while reviewing this area (user's own catch,
not a bug): it synthesized an `Expr` array-literal just to route through `emitAs`/`case 'array'`'s own
`arrayKindOf`/`want` inference, even though the outer kind (`ref`, always -- a `[string,T]` tuple per
field, boxed regardless of `T`) was already known outright -- now calls `emitArrayElements` directly for
that outer level; each inner tuple still stays a real `Expr` node so it reuses the ordinary per-element
`emitAs` coercion `emitArrayElements`'s own ordinary loop already provides, not duplicated by hand.

**Phase 2 item 8 (caught-`any`-narrowing scope-threading fix) -- investigated, NOT attempted, real risk
found (2026-08-21).** The gap: `if (e instanceof C) { e.field }` on an `any`-typed `e` (e.g. a caught
exception) narrows correctly in the checker, but codegen's owner/field resolution (`ownerOf` ->
`checkerTypeOf(unwrapAs(e), ctx.scope)`) always uses `ctx.scope` -- towasm's own, separately-tracked,
per-*function* (not per-statement) scope, which never reflects any flow-sensitive narrowing. The
checker DOES stamp a real, narrowing-aware scope per statement (`(stmt as any).scope`, the same
mechanism [[tison_declscope_investigation]]'s 6th entry and this file's own muted-lib-check fix both
already lean on) -- the obvious-looking fix is to have `emitStmt` temporarily swap `ctx.scope` to
`(stmt as any).scope` for the duration of each statement, letting every owner/field-resolution call site
pick up narrowing for free, generically, instead of only the one spot (`case 'var_decl'`'s own inference
fallback) that already manually does this.
**Real, unresolved risk found before implementing**: `(stmt as any).scope` is stamped ONCE, whenever a
function/method's body is FIRST for-real (`err`-set) checked -- and for ANY generic function/method
(not just a lib one; this applies to an ordinary user-defined `function identity<T>(x:T):T{...}` just as
much), that first-and-only check happens with the type param still abstract/unresolved (checker.ts never
re-checks a generic body per call-site -- `substituteClassTypeParam`/`ensureGenericFunc`'s later
per-instantiation substitution is a purely towasm-internal AST rewrite, confirmed earlier this session,
that never re-invokes the checker at all). So a blanket swap would make EVERY generic function/method's
body compilation regress to the template's own unresolved-type-param scope instead of `ctx.scope`'s
correct, per-instantiation-substituted one -- not a narrow, lib-only concern like the muted-check fix
was; this would hit any real user generic function. My own earlier `Scope.isGenericTemplate()`/`noStamp`
fix doesn't cover this at all (it only gates the *muted* early-return path, and only for a class's own
`instScope` -- a top-level generic function is never muted, since real user code always checks with
`err` set, so it was never in scope for that fix). A real fix needs something narrower: e.g., consulting
only the checker scope's own *narrowing* layer (never its base declared-value layer) as an overlay on
top of `ctx.scope`, not a wholesale replacement -- `Scope` has no API to enumerate just the narrowings
between two scopes today, so this needs new, careful scope-chain machinery, in the same fragility class
[[tison_declscope_investigation]] warns about. **Deliberately not attempted under time pressure** --
parking with this specific risk documented so a future attempt doesn't have to rediscover it.

**Phase 2 item 9 (object literals w/o nominal target type) -- root cause found, one real fix landed,
dominant pattern requires a bigger feature (2026-08-21).** Delegated an Explore agent to find concrete
real sites across the self-hosting target files (not hypothetical ones) before touching anything.
Found the gap is not "16 scattered sites" (the plan's own earlier estimate) but three structurally
different sub-problems, wildly different in size and difficulty:
1. **Dominant, ~hundreds of sites**: an unannotated arrow/function expression whose body is a bare
   object literal, passed as a callback to a generic higher-order function (`Rule([...], $ => ({type:
   'spread', ...}))` in ts-parser.ts/js-parser.ts, `.group()/.one()` in binary-libs/wasm.ts, `.map()`
   callbacks in tison.ts) -- concentrated overwhelmingly in ts-parser.ts (~99 sites)/js-parser.ts (~98)/
   binary-libs/wasm.ts (~61). **Real, root-caused, FIXED**: `emitClosureLiteral` computed its own return
   wtype purely from `e.returnType`, ignoring the call site's own expected closure signature (`want`)
   entirely -- for an unannotated closure, `e.returnType` is whatever *structural, anonymous* type the
   checker's own inference back-fills (real, but no nominal identity for `typeOf` to turn into a wasm
   struct), so `case 'object'` always rejected the body ("needs a known target type") even when the
   caller's own declared callback signature already named the exact concrete shape wanted. Fixed by
   threading `want` into `emitClosureLiteral` (new param, only the one `case 'arrow'`/`case 'function'`
   call site in `emitExpr` needed updating) and preferring `want.closure.result` when present -- safe for
   an explicitly-annotated closure too, since the checker already verified assignability, so the two
   physical wtypes are equivalent there anyway. 2 new tests, full suite green (423 tests).
   **But this fix does NOT close the dominant `Rule(...)`-family pattern itself** -- confirmed via a
   direct, minimal, deliberately-isolated repro (`makeRule<T>(action: () => T): T` called inside
   `const rules: Expr[] = [makeRule(() => ({kind:'spread', ...}))]`, mirroring `Rules<Expr>([Rule(...),
   ...])`'s real shape): `T` there is pinned only by the *outer array literal's own declared element
   type*, which needs real bidirectional/contextual generic inference -- this checker's own documented,
   deliberate limitation ("generic inference is structural-argument-matching only (no bidirectional/
   contravariant/contextual)", checker.ts's own top comment). Without that, the checker still infers `T`
   purely structurally from the callback's own return value (the SAME anonymous-type problem my fix
   doesn't reach, since `want` itself is derived from that same non-nominal inferred `T`). **This is a
   genuinely bigger, separate checker feature** (real bidirectional/contextual generic inference), not a
   codegen tweak -- deliberately not attempted, flagged for explicit design discussion before starting.
2. **9 sites, transform.ts's `flattenStateMachine`/`define`**: bare object-literal call arguments whose
   declared parameter type is a *discriminated union* (`SegmentNext`, a 4-arm union; `Statement`, a large
   union) rather than a plain alias -- no single nominal shape exists for `ensureObjectShape` to resolve
   to even in principle. Needs real discriminated-union object-literal support (match against one arm by
   its discriminant field), a distinct, separate feature from (1). Not attempted.
3. **~77 sites, walker.ts's `mapObject(node, fields)` calls**: `fields`'s declared type (`NodeMap<N>`, a
   homomorphic mapped type over a generic) is per-call-site structurally different, never a plain alias
   either -- this is the SAME already-known, already-deferred generic-function-monomorphization-
   consistency gap from earlier this session (see above), not new information, just confirms its scope
   overlaps this gap-list line too.
Given (1)'s fix doesn't reach the dominant pattern, and (2)/(3) are genuinely separate bigger features,
item 9 as originally scoped ("real code hygiene, thread an existing want further") turned out to only be
true for a minority of real sites -- most of the volume needs actual new checker/codegen capability.

**Real, unresolved performance pathology found while verifying the above, NOT a deadlock, NOT yet
root-caused (2026-08-21).** Re-running the whole-workspace sweep after landing item 9's fix, the sweep
appeared to hang processing `binary-libs/src/wasm.ts` (the same file `packages-e5`, the parallel session
working the parsing-engine side, had JUST gotten past its own parser gap on). Investigated thoroughly
before concluding anything -- initial CPU/state checks on what turned out to be a *parent* process showed
a genuine 0%-CPU idle wait (state "S", `kevent`), which looked exactly like a deadlock in
`module-loader.ts`'s async import-resolution machinery (a real, known-fragile area, see
[[tison_declscope_investigation]]'s own circular-import handling). Added temporary tracing (`resolveImport`
/`makeScope`/`ModuleLoader.get`/`NodeModules.get`, all reverted after) confirmed every real module
resolution for `@isopodlabs/binary`'s own dependency graph completes cleanly and quickly -- the trace
shows `checkBlock` (the actual, synchronous type-check) being *entered*, with nothing after. Checking
process state again (correcting for the earlier parent/child PID confusion -- `npx`/`tsx` spawns a
child, and the *child* was the one actually running) showed the REAL worker process at 98-99% CPU,
climbing continuously (6, then 16+ minutes of accumulated CPU time and still rising) before I killed it --
genuinely computing the whole time, not stuck. This matches the same *shape* of finding `packages-e5`
already reported for its own parser-side `MAX_TOTAL_WORK` investigation (large real functions needing far
more resolution steps than expected, time flat/proportional rather than exploding) -- but here on the
*checker* side, and the scale is far worse: minutes, not milliseconds, for one file, with no confirmed
upper bound. Given `binary/src/sync.ts`'s own "elaborate generic/mapped/conditional types" were already
flagged in this plan's own Grounded Findings section (`TableBuilder<T>`, `bin.Class(WasmSpec)`, etc.) as
genuine compile-time metaprogramming -- the leading hypothesis, not yet confirmed, is a missing
memoization somewhere in `resolve()`/`substituteType`'s own repeated-generic-instantiation handling,
causing polynomial-or-worse (possibly exponential) blowup against this specific dependency's real type
complexity, rather than a true infinite loop. **Not root-caused, not fixed, no fix attempted** -- would
need a real CPU profile (`--cpu-prof` or the inspector's own profiler, not `sample`/`ps`, which only
confirmed "real work is happening" but not *where*) to find the actual hot path before touching anything.
Deliberately stopped rather than let it keep running unbounded or guess at a fix.

**Bidirectional/contextual generic inference for a callback's own return type, DONE (2026-08-21/22)** --
the item-9 follow-on the user explicitly asked to pursue. Turned out to be two separate, layered fixes,
not one:
1. **checker.ts/type-utils.ts (the checker's own inference, used for diagnostics/narrowing)**: NOT a new
   feature -- `instantiate()` already had a contextual step (`expected` vs `sig.returnType`), just as a
   low-priority fallback for whatever's still unbound *after* argument-matching. The real bug: a generic
   callback parameter's own return-position inference (`T.inferTypeArgs`'s `function`/`constructor` case,
   matching `paramT.returnType` against the *argument's own already-inferred* return type) ran eagerly,
   during that same argument-matching pass -- so it won the "first-bound-wins" race (`out`'s own guard)
   before the contextual step ever got a turn, binding `T` to the callback's own anonymous, non-nominal
   structural inference instead of the real, concrete contextual type. Fixed via a `deferred` list: the
   `function`/`constructor` case now queues its return-type inference instead of running it immediately
   when a `deferred` param is passed; `instantiate()` builds one, threads it through the argument loop,
   then replays it *after* the contextual step. Ordinary direct-param inference (`identity<T>(x:T)`,
   never queued at all) is completely unaffected -- verified explicitly, it must keep winning over a
   *wider* contextual type, unlike the callback-return case where contextual should win.
2. **towasm.ts (a wholly separate, parallel generic-instantiation mechanism for actual codegen)**: reuses
   the same `T.inferTypeArgs` (so gets fix 1 too), but had **no contextual step at all** -- a documented,
   known gap in `inferTypeArgMap`'s own comment. This is why fix 1 alone didn't resolve the real,
   observed failure: `TStypeCheck` never reported an error in the first place (checker-side leniency
   masked it), so the actual, user-visible failure was 100% in this separate codegen path. Fixed by
   adding `ctx.contextualReturn` (`FunctionContext`, new field) -- a one-shot hint, not a general
   "expected type" threaded through every expression: seeded only by the few producers with a real TS
   type on hand (`case 'var_decl'`'s own `tsType`; `case 'array'`'s own per-element loop, resolving
   `ctx.contextualReturn`'s own `.element`, reset around *each* element via `emitArrayElements`'s new
   `elementTsType` param -- confirmed multiple elements each get it correctly, not just the first),
   consumed and immediately cleared by `case 'call'` (so it can never leak into that same call's own
   arguments), threaded through `emitCall`/`ensureGenericFunc`/`inferTypeArgMap` to the exact same
   `deferred`-based contextual step fix 1 added.
   **Confirmed still genuinely incomplete for the actual dominant real-world pattern**: the real
   `Rule([...], $ => ({...}))` sites resolve `T` to a real *union* type now (e.g. `SpreadExpr |
   OtherExpr`), correctly -- but then fail differently, on a separate, deeper, already-known gap: towasm's
   own generic monomorphization has no wasm struct representation for a union-typed type argument at all
   (same root as item 9's 2nd/3rd sub-problems, discriminated unions). Verified this fix's own real,
   narrower target (a generic callback resolving to one concrete, single class/object-shape) works
   end-to-end; the union case is out of scope here, not silently claimed as fixed.
   4 new tests in test-towasm.ts, full suite green (426 tests). Verification: test-towasm.ts, test-tison.ts,
   eslint (0 errors), plus a corrected whole-workspace parse+typecheck sweep (the *entire* `binary-libs`
   directory excluded from that one run specifically, to route around the still-unresolved wasm.ts
   performance pathology above -- not a regression check on that file, a deliberate exclusion) -- no new
   crashes anywhere in the rest of the monorepo, `MsBuild.ts`/`transform.ts` (packages-e5's own recent
   fixes) confirmed still clean, only the 2 pre-existing, already-known parser-side `test-tison.ts`
   failures remain (packages-e5's lane, unrelated).

**Union-of-object-shapes field access, DONE (2026-08-22)** -- the natural next step after landing
contextual generic inference: once `T` correctly resolves to a real union (e.g. `SpreadExpr |
OtherExpr`), there was still no wasm representation for "a value that's genuinely one of several
different object shapes" at all -- not for generics, not even for a plain, non-generic union-typed
local. Fixed:
- `typeOf`'s own union case gained a second branch (after the existing nullable-collapse one): a union
  of >=2 members that are all real, *struct-backed* classes/object-shapes boxes as `any` (`REF_ANY`) --
  the same physical representation this compiler already uses for an unconstrained generic or a caught
  exception, not new machinery.
- `case 'member'`, when `classOf` can't resolve one single owner, now falls back to a new
  `ensureUnionFieldDispatch`: a `ref.test`/`ref.cast` cascade over the union's own *exact, bounded*
  member set (via a new `unionClassMembers` helper) -- deliberately not `ensureAnyDispatch`'s "every
  class ever reached" global scan, which would be both too broad and unable to distinguish two
  same-named-but-differently-typed fields on unrelated classes.
- **A real regression found and fixed before landing**: the first cut of the union-detection check used
  `ownerFor(member)` alone to decide "is every member representable" -- but `ownerFor('number')` also
  succeeds (via `builtinTypeOwner`, the *scalar*-boxing owner used elsewhere for dynamic dispatch on
  `number`/`boolean`), which has no real heap type (`typeIndex === -1`) to `ref.test` against. This
  wrongly boxed `IteratorResult<Y,R>.value: Y | R` (monomorphized with `Y`/`R` both `number`, a
  degenerate `number | number` union) as `any` instead of a plain `f64`, breaking every generator using
  `try`/`finally` with a wasm validation error ("uninitialized non-defaultable local") -- caught by the
  full test-towasm.ts suite (426 passing tests suddenly showed 1 failure) before this ever got
  considered "done," root-caused via bisection (temporarily disabling each new code path one at a time,
  narrowest first) rather than guessed at. Fixed with a new shared `unionStructOwners` helper, requiring
  `typeIndex !== -1` (a real struct) on every member, used by both `typeOf`'s own check and
  `unionClassMembers`. 2 new regression tests specifically pin this (the fix, and the exact
  IteratorResult-shaped case that regressed), full suite green (428 tests).
- **Confirmed, deliberately not fixed**: the full `Rule([...], $ => ({...}))` pattern *still* doesn't
  compile end-to-end -- `T` now correctly resolves to the real union and field access on it now works,
  but building the *object literal itself* (`{kind:'spread', ...}`) still fails: `case 'object'` has no
  way to know which union member a given literal is meant to build as (a discriminated-union object-
  literal construction gap -- matching item 9's sub-problem #2, `transform.ts`'s 9 sites, same root
  cause). This is now confirmed as the one remaining piece for the dominant real-world pattern; not
  attempted here.
- Also found in passing, NOT fixed, unrelated to unions: a *nested* function declaration referencing a
  *top-level class* by name (`new A(...)` inside a `function pick() {...}` nested in another function)
  fails with "unresolved identifier 'A'" -- a real, separate, pre-existing gap in
  `emitClosureLiteral`'s/`collectFreeVars`'s own free-variable resolution (a class name apparently isn't
  recognized as an always-resolvable global the way a top-level function's own name is).

**Discriminated-union object literal construction, DONE (2026-08-22) -- closes the dominant `Rule(...)`
pattern end to end.** The very last piece: even with `T` correctly resolving to a real union and field
access on it working, `case 'object'` still had no way to know *which* union member a bare `{...}`
literal should build as when `want` is `REF_ANY` (a real union target) rather than one single class.
Fixed via a new `matchObjectShape`: a last-resort structural match against every reachable,
struct-backed class (same "every class ever discovered" scan `findAnyDispatchCandidates` already uses
for method dispatch, just picking a *shape* instead of a *method*) -- a candidate qualifies only when
its own field set exactly matches the literal's own property names (no missing, no extra); when more
than one candidate's field set matches (the real, common discriminated-union shape -- e.g. `SpreadExpr`/
`OtherExpr` both `{kind, value}`), a further check narrows by discriminant: a property whose own literal
value matches exactly one candidate's own literal-typed field declaration, but not another's. A
genuinely ambiguous literal (same field set, no discriminant at all) is correctly rejected, not
silently guessed at.
**One real snag found and fixed while landing this**: the discriminant check's first cut looked up a
candidate's own field type via `cls.decl.body.find(...)` -- works for a real `class`, but an
object-shape type alias (`type X = {...}`, not a real class) *never* populates `.decl.body` at all
(`ensureObjectShape`'s own comment: `decl: { name, body: [] }`, deliberately empty) -- its own field
types live only on the original structural type. Fixed with a new `fieldDeclaredType` helper that falls
back to re-resolving `global.type(cls.name)` structurally, the same way `ensureObjectShape` itself
originally derived the field types when building `cls` in the first place. Caught via direct testing
(the discriminant check silently found zero matches for every candidate) before landing, not assumed.
4 new tests (the full end-to-end `Rule(...)` pattern, a direct non-generic discriminated literal,
confirmed genuine ambiguity is still rejected), full suite green (431 tests). Verified: test-towasm.ts,
test-tison.ts, eslint (0 errors) all clean.

**This closes the loop the whole "object literal has no known target type" investigation started
from** -- the dominant, ~hundreds-of-sites `Rule([...], $ => ({...}))` pattern in ts-parser.ts/
js-parser.ts/binary-libs/wasm.ts now compiles end to end: contextual generic inference resolves `T` to
the real union from the surrounding array literal's own declared element type, field access on the
union dispatches correctly, and the object literal itself picks the right union member structurally.
Not yet attempted: actually re-running these real, in-the-wild source files through the pipeline to
confirm the pattern holds up outside a minimal repro (blocked on `binary-libs/src/wasm.ts`'s own
still-unresolved performance pathology for that specific file; ts-parser.ts/js-parser.ts themselves
aren't blocked by that and could be tried directly).

**`binary-libs/src/wasm.ts` type-check performance pathology -- CLOSED (2026-08-23).** The file that
hung for 16+ hours now type-checks in **844ms**, verified end to end (full 431/431 test-towasm.ts
suite green, plus a full-workspace `test-ts-parser.ts` sweep completing cleanly where it previously
never returned). Root-caused via careful bisection, not guesswork -- see the process notes below since
the wrong hypothesis (`TableBuilder`/`FlattenOps`, this plan's own earlier "Grounded Findings" guess)
was disproven with hard data before the real cause was found.

- **Real root cause**: `checker.ts`'s `typeOf`'s own local `recurse` closure has no memoization.
  `case 'new'`/`case 'call'` independently compute both `recurse(e.callee.object)` *and*
  `recurse(e.callee)` -- the latter, being a `member` expression, internally recomputes the exact same
  `e.object` type again from scratch via `case 'member'`'s own `recurse(e.object)`. For a chain of N
  calls (`a.m1().m2()...mN()`, `binary-libs/wasm.ts`'s real `TreeBuilder`-based `I0` construction has
  N=48), this compounds into a binary recursion tree: evaluating call N re-triggers two full
  evaluations of "everything up through call N-1", each of which re-triggers two more, giving O(2^N)
  total node evaluations of what is structurally the same expression. Confirmed empirically before
  guessing at a fix: a `WeakSet` scan proved 524,288 supposedly-redundant `TreeBuilder` ref resolutions
  at a 20-call chain were all genuinely distinct objects (ruling out "just add a cache to the reader"),
  and a real stack trace (`new Error().stack`, not `--prof`, see below) pinned the duplication to
  `checker.ts:1189` vs `checker.ts:1208`.
- **Fix**: memoize `recurse` itself, keyed by `(node, expected)`, scoped to one `typeOf` call (a fresh
  `Map` per invocation -- can't leak across separate checks). Safe because `recurse`'s own side effects
  (diagnostics, `yieldCollector` pushes) are exact duplicates on a second visit to the identical node --
  confirmed by checking that the diagnostic-count drop this caused (55→33 on the bisected repro) was
  100% duplicate messages at *identical* line:col locations, not lost coverage at different ones.
- **Two smaller, independent, also-real wins found en route** (kept, both verified separately not to
  regress anything): `lookupMember` (type-utils.ts) had no memoization at all -- a specific `(type,
  prop)` pair was being re-derived tens of millions of times in the original wasm.ts profile (13% of
  all profiler ticks, ~14x the next-largest function) purely because nothing cached it; fixed via a
  `WeakMap<Type, WeakMap<Scope, ...>>` cache. Separately, `NodeModules.get()` (module-loader.ts) never
  cached a *negative* directory-walk-up result -- from a directory with no reachable `node_modules`
  (e.g. a scratch dir), every lookup re-walked the whole chain from scratch; fixed by caching every
  directory visited during a walk, not just the one where it resolves. `resolve()` and `substituteType()`
  (type-utils.ts) also got small reference-keyed caches -- real, verified-safe, but turned out *not* to
  be what fixed the exponential blowup (see process notes).
- **Process notes, worth re-reading before assuming a similar hang is "the same bug" next time**:
  `--prof`'s V8 log-based profiler gave actively misleading data twice in this investigation (once
  attributing 78% of ticks to an unrelated V8-internal metrics-recorder C++ symbol, once making a
  4-line trivial file look dominated by `node::fs::Access` when a live `sample <pid>` trace on the
  *same* hang showed clean, unrelated deep JIT recursion) -- macOS `sample <pid> <secs> -file <out>`
  gave the real, correct call stack both times `--prof` didn't. Also: a large chunk of the apparent
  "wildly inconsistent timing, unrelated to code content" earlier in this investigation was later traced
  to a *second*, real bug (the `NodeModules` one above) plus probable resource contention from a
  concurrently-running corpus-test sweep on the same machine -- worth checking `ps aux` for other heavy
  node processes before trusting a timing measurement that doesn't match expectations.

**Pre-threading cleanup item, tracked not yet done (raised 2026-08-23, user's own framing):**
"once it can compile itself we can throw off the shackles of javascript's single-threadedness" --
i.e. once self-hosting reaches the point of actually running the compiler under real parallelism (wasm
threads with shared memory, not Node's `Worker` threads which already get isolated heaps for free),
module-level mutable global state becomes a genuine data race, not just a style nit. The three caches
added by the wasm.ts perf fix above (`lookupMemberCache`/`resolveCache`/`substituteTypeCache` in
type-utils.ts, all module-level `WeakMap`s) are exactly this shape -- safe today only because Node's
single JS thread with run-to-completion semantics makes concurrent mutation impossible, not because
they're actually designed for concurrency. **Not the only offenders**: `libScopeCache`,
`importScopeCache`, `NodeModules.found`/`notFound` (module-loader.ts), and the pre-existing `resolving`
cycle-guard `Set` in type-utils.ts share the same shape and weren't touched this session.
**`depthExhaustion`/`takeDepthExhaustion()` is *not* a good precedent to follow here, despite looking
like one** (its own "explicitly drained per check" pattern looks like the right idea) -- the user's own
correction: it's really a temporary debug diagnostic, not a model for real cache lifecycle management.
**Decided approach**: don't refactor piecemeal as new caches get added -- when self-hosting actually
reaches a threading model decision, do one deliberate pass threading an explicit per-invocation context
object through `type-utils.ts`'s exported surface (resolve/lookupMember/substituteType/isAssignable and
whatever else has accreted global state by then), covering all of it at once rather than half-fixing as
you go.

Ready to continue: Phase 2 items 5 (await in try/finally), 6 (nested closures capturing outer free
vars), 8 (caught-any narrowing scope-threading fix -- real risk found, not yet attempted, see above),
transform.ts's own 9 discriminated-union sites (SegmentNext/Statement, a large union rather than a
small closed one -- `matchObjectShape` should already cover this in principle, worth confirming against
the real file) all still open, plus the vector.ts flow-merge gap, the generic-function-
monomorphization-consistency gap (mapObject, ~77 sites, same root), `for...of` over a general iterable
(Map/Set) needing a structural Map-vs-Set signal, the nested-function-referencing-top-level-class bug
found in passing, and -- now that the wasm.ts performance pathology is closed -- actually re-running
ts-parser.ts/js-parser.ts/binary-libs/wasm.ts's real discriminated-union `Rule([...], $ => ({...}))`
sites through the pipeline (previously blocked on this exact perf issue for the wasm.ts file
specifically) is unblocked and worth doing. Full roadmap + phase detail:
`~/.claude/plans/witty-plotting-kernighan.md`.

Related: [[tison_towasm]] (gap-list history this plan builds on), [[tison_project]],
[[feedback_prefer_extending_existing_mechanism]] (generic-factory-instantiation reuses this pattern),
[[feedback_types_vs_runtime_behavior]] (the lesson that retired the comptime idea),
[[tison_declscope_investigation]] (the fragility precedent this investigation deliberately verified
against via full corpus sweeps rather than assumed safe).

**First real-file pipeline run, DONE + partial (2026-08-24)** -- with the wasm.ts perf pathology
closed, ran the actual checker (`TStypeCheck`/`TStypeCheckAsync` via `ModuleLoader`, same pattern as
`test/test-ts-parser.ts`'s `testAsync`) against the real, in-the-wild `ts-parser.ts`/`js-parser.ts`/
`binary-libs/src/wasm.ts` for the first time (not minimal repros) -- these are the files carrying the
dominant `Rule([...], $ => ({...}))` discriminated-union pattern this session's earlier work (union
field access, discriminated-union object-literal construction, contextual generic inference) was built
to eventually reach. `ts-parser.ts`/`js-parser.ts` checked clean (only expected `fs`/`crypto`/`zlib`
warnings from `tableCache.ts`, out of scope per this plan). `wasm.ts` initially threw one real ERROR.

**Gap found+fixed: checker.ts's post-`if` narrowing-merge used the wrong scope.** `checkBlock`'s
`assignRights` (predicts a variable's type after an `if`/`if-else` that reassigns it, by re-evaluating
each branch's RHS a second time) re-evaluated using the **pre-`if`, unnarrowed** scope instead of each
branch's own narrowed scope -- so `if (arg instanceof Uint8Array) arg = new bin.stream(arg);`
(wasm.ts:803) spuriously errored on the merge pass even though the first, ordinary evaluation of the
same `if` had already narrowed fine. Fixed by threading `scope` through `assignRights`, narrowing at
each `if`/`if-else` recursion via `narrow(st.test, scope, true/false)`. **Bonus**: same fix retroactively
resolved 3 pre-existing real errors in an unrelated package, `symbolic/src/symbolic.ts` (confirmed in
isolation, 5->2 errors, remaining 2 unrelated). wasm.ts now: 0 ERROR (the fixed spot downgraded to an
already-documented GAP, `Partial<WasmModuleData>`'s keyof/conditional/infer/mapped-type limitation).
3 new tests.

**Found, deliberately NOT fixed (real, separate, pre-existing)**: a generic type-guard
(`T.isLiteral<K extends keyof TypeOfMap>(t,type:K): t is Literal<TypeOfMap[K]>`) narrows via its `call`
case without ever substituting `K` -- a narrowed value's field resolves to the union of ALL
`TypeOfMap` value types instead of just the requested one. Confirmed pre-existing (reproduces on
unmodified checker.ts, just newly *reached* by the fix above), confirmed real `tsc` does not flag the
original code (false positive here only). Genuinely separate mechanism from the merge-scope fix --
documented, not touched.

**Pushed on to real `TStoWasm` codegen (not just checker) on the same three files -- two more real,
general gaps found+fixed, then hit a genuine structural wall:**
1. Bare/explicit generic-interface reference as a codegen target: `ensureObjectShape` resolved a
   generic interface's raw (still-generic) decl directly instead of through `resolve()`'s own type-arg
   defaulting, and `ensureClass`'s dispatch dropped a ref's own `typeArgs`. Fixed both; a widening
   regressed `Partial<T>`'s mapped-type fallback, fixed by making `ensureObjectShape` gracefully decline
   on an index-signature member instead of throwing.
2. A top-level `interface` declaration crashed codegen outright merely by coexisting with real code
   (`type_alias_decl` was in towasm.ts's statement skip-list, `interface_decl` wasn't) -- one-line fix.
3 new tests (437 total, full suite green).

**Structural wall hit and deliberately stopped at (real, substantial, separate feature, not a gap
tweak)**: `tsw.ts`'s `TStoWasm` entry point (`compile()`) has **no multi-file/import-resolution support
at all** -- it type-checks via the synchronous `TStypeCheck(program, libScope)`, no `ModuleLoader`, so
any real `import` across these files is left entirely unresolved for codegen's purposes (the checker
tolerates this leniently, no ERROR, but codegen needs a real concrete shape and can't build one).
`ts-parser.ts` genuinely needs `js-parser.ts` (`TypeParam` is a local alias for `JS.TypeParam<Type>`);
`js-parser.ts` itself imports `tison.ts`/`tableCache.ts`/`common.ts`. Blocks all three target files
identically for real codegen (not checking) -- this is genuinely multi-file-aware codegen, a substantial
new feature, not attempted. **This is now the next concrete blocker for Phase 5 integration** (the plan
already scoped `module-loader.ts` itself as out-of-scope for the *self-hosted image*, but `TStoWasm`
needing SOME real import-resolution to codegen multi-file input at all, even just for *this native*
verification pass, is a distinct, newly-concrete need the plan hadn't previously pinned down this
precisely).

Verification: `test-towasm.ts` 437/437 green, `test-tison.ts` clean, `tsc --noEmit` clean, eslint 0
errors, whole-workspace sweep GAP 1188->1189/WARNING 592->592/ERROR 231->230 (the exact -1 ERROR/+1 GAP
matching the wasm.ts:803 fix, per-file diff confirmed no other regression).

**Shared-working-tree note**: a different, concurrently-running session was actively editing
`ts-parser.ts` (a `<call-generics>` lookahead regex fix, unrelated) during this run -- confirmed not
this session's own change. `git status` shows `ts-parser.ts` modified from that other session, still
uncommitted alongside this session's own changes to checker.ts/towasm.ts/test-towasm.ts.
(The user committed all of the above as `e032741` shortly after, mid-session, unprompted.)

**Follow-on session (2026-08-24): root-caused+fixed the generic-type-guard narrowing gap, found+fixed
a real infinite-loop bug in module resolution, and did the `tsw.ts` import fix.**

**Gap found+fixed: `narrowTo`'s union branch discarded the type-guard's own narrower asserted type.**
`checker.ts:367-378` -- when narrowing a UNION-typed value via a user-defined type predicate or
`instanceof` (both go through `narrowTo`), the union branch used a plain-boolean `keep` callback
(`m => T.isAssignable(m, target, scope) === sense`), which only ever *filters* union members, never
*replaces* one -- so a matching member kept its own, WIDER original declared shape instead of narrowing
to `target` (the predicate's actual asserted type), even though the non-union branch two lines below
already does exactly that (`s.addNarrowing(name, target)`) unconditionally. Concretely: the min11 repro
(`T.isLiteral<K extends keyof TypeOfMap>(t,type:K): t is Literal<TypeOfMap[K]>`, `T.isLiteral(m.init,
'number') ? m.init.value : 0`) reported `m.init.value`'s type as `number | bigint | string | boolean |
null | RegExp | Temp...` -- NOT "every property of TypeOfMap" as first guessed, but literally the real
`TS.Literal` AST node's own wide `value` field union, since narrowing kept THAT (the matched original
union member) unchanged instead of the much narrower `Literal<TypeOfMap['number']>` the guard actually
asserts. K-substitution itself was already correct (`inferTypeArgs` already special-cases a
`keyof`-constrained type param to stay literal, not widen) -- confirmed by reading, not assumed.
**Fix**: `m => T.isAssignable(m, target, scope) === sense ? (sense ? target : true) : false` -- only
changes the "match + sense=true" case from `true` (keep) to `target` (replace), matching the sibling
non-union branch's existing behavior exactly; the other three truth-table cases are unchanged.
**Impact, whole-workspace sweep**: ERROR 230->194 (-36, general -- affects ANY user-defined type-guard
or `instanceof` narrowing a union anywhere in the whole monorepo, not just this one case), GAP 1189->1211
(some former false-ERRORs downgraded to honest "can't fully verify keyof/indexed-access" GAPs rather than
fully resolving -- correct, not a regression), WARNING 592 (flat). Diffed the full before/after ERROR-line
set: zero new distinct error messages except one (see below), confirmed genuinely separate. `test-towasm.ts`
(437, unaffected -- no test exercises this exact path) + `test-tison.ts` + `tsc --noEmit` + eslint all clean.

**Found, deliberately NOT fixed (real, separate, newly-*reached*-not-caused-by-the-fix-above,
narrow/self-contained)**: negating a `?.`-guarded discriminant conjunction (`typeAnnotation?.type
==='ref' && !typeAnnotation.typeArgs && typeAnnotation.declScope ? UseIt(typeAnnotation) : typeAnnotation
? UseItAgain(typeAnnotation) : ...`) loses a union member when the TRUE branch also *uses* the narrowed
value in a real call -- the ELSE branch's own, entirely separate `typeAnnotation ? ...` truthy-check then
sees `typeAnnotation`'s type as `RefType | undefined` (a real union member, `OtherType`, is missing
entirely -- not just "still too wide", genuinely lossy). Confirmed via a minimal, isolated repro
(`assistant/repro-dir/min16.ts`/`min21.ts`) that reproduces byte-for-byte identically on fully unmodified
checker.ts (git-diff-verified, not the fix above) -- this session's fix just happens to let checker.ts's
OWN self-check reach this line (823) for the first time by removing 36 *other* false errors upstream in
the same file. Likely mechanism (not fully traced): the `&&`/`?.`-negation "disjunctive union-of-each-
side's-narrowing" combine logic (checker.ts:428-452, especially the `test.operator==='&&' && !sense`
branch and its `T.combineTypes([lt,rt])` call) drops a member somewhere when one side's own narrowing
result is itself derived from a nested `&&`. Only shows up in checker.ts's own self-check in the whole
monorepo sweep (one distinct new ERROR message). Per this plan's own established practice (see the
vector.ts flow-merge gap, the mapObject monomorphization gap): documented precisely, not chased further
under time pressure -- the user had already redirected to the `tsw.ts` import work.

**Real, separate bug found+fixed: `NodeModules`'s parent-walk can self-reference and infinite-loop on a
relative root.** `module-loader.ts`'s `NodeModules.get()` (static) walks up from a root directory
looking for the nearest ancestor with a real `node_modules` dir; `NodeModules.prototype.get(mod)`, on a
failed package lookup, delegates to `NodeModules.get(path.dirname(this.root))` for the next ancestor UP.
Node's `path.dirname('.')` returns `'.'` again (a fixed point, unlike an absolute path, which always
makes monotonic progress toward `'/'`) -- so if a `ModuleLoader` is ever constructed with a *relative*
root (ordinary CLI usage: `new ModuleLoader(path.dirname(someRelativeArgvPath), ...)`), the walk can land
on a `NodeModules` instance whose own `root === '.'`, whose "next ancestor" query resolves (via the
static `found` cache) back to *itself* -- `this.parent === this`. Since a FAILED module lookup is never
cached (`nm.imported` only ever stores success), this becomes a genuine, silent, ever-running infinite
loop for any package that never resolves (e.g. `fs`/`crypto`/`zlib`, which `tableCache.ts` deliberately
imports and which this project's own harnesses always expect to fail). Root-caused via direct instrumentation
(temporary counters/stack traces in `tryLoadFile`/`ModuleLoader.get`/`NodeModules.get`, all reverted after)
after `sample <pid>` showed near-100% time in `Builtins_PromiseRejectReactionJob`->`Error.captureStackTrace`
-- confirmed a genuine spin, not real work, and confirmed reproducible on an absolute path being FAST
(1097ms) vs. a relative one HANGING (5+ minutes, killed) for the byte-identical check. **Fix**: `root =
path.resolve(root)` at the top of the static `NodeModules.get()` -- single point, normalizes every caller
(the original external root AND the recursive parent-walk's own `path.dirname(this.root)`) permanently,
since once any root is absolute every subsequent `path.dirname` strictly shortens toward `/` with no other
fixed point. Not caused by anything in this session's own other changes -- confirmed on fully unmodified
module-loader.ts first. Directly relevant to (and would have silently bitten) the `tsw.ts` CLI work below,
since a CLI naturally takes relative input paths.

**`tsw.ts` import fix, DONE (partial, as scoped) -- checking now real-multi-file-aware; codegen's own
separate multi-file gap confirmed to fail loudly, not silently.** Per the user's own direct observation
that `transform.ts`'s `TStypeCheckAsync` (not the synchronous `TStypeCheck`) already does real
`ModuleLoader`-backed import resolution (same as `test-ts-parser.ts`'s own `testAsync`) -- `tsw.ts`'s
`compile()` switched to it, matching that established pattern exactly (`FixOptions`/`applyPragmas`/`new
ModuleLoader(path.dirname(filein), options)`). **Confirmed NOT sufficient by itself to close the earlier-
found "structural wall"**: `TStoWasm`'s own seeding (`towasm.ts:6031`, `collectNames(ast.body)`) only
ever walks the SINGLE entry `Program`'s own top-level statements to populate `functionDeclByName`/
`classes` -- `TStypeCheckAsync` gives the checker a real *type* for an imported symbol (e.g. `ts-parser.ts`'s
`TypeParam = JS.TypeParam<Type>`), enough to check calls into it, but never hands `TStoWasm` the callee's
own AST body to actually compile. Real multi-file codegen (seeding from every module the loader resolved,
PLUS resolving namespace-import-qualified calls like `JS.foo(...)` back to the declaring file's own AST --
confirmed this is not just "seed more declarations", since `collectNames`'s identifier walk collects the
bare `JS` binding name, not `foo`, for exactly this shape) is real, substantial, separate follow-on work,
not attempted here. Verified instead that the now-real checking step doesn't change the *failure mode* for
this gap: `ts-parser.ts`/`js-parser.ts` check cleanly (as before), and compiling `ts-parser.ts` via the
real CLI now fails with a clear, single-line error (`towasm: object-shape type 'RefType.declScope' needs
an explicit number/boolean/object type`) -- not a crash, not a hang, not a silent miscompile. Verified: a
plain single-file program (`add`/`main`) still compiles and runs correctly via the CLI, with BOTH an
absolute and a relative input path (exercising the `NodeModules` fix above for real, in the actual CLI
path, not just a scratch harness). `test-towasm.ts` (437, unaffected), `test-tison.ts`, `tsc --noEmit`,
eslint (0 errors, only pre-existing-pattern warnings) all clean.

**Next concrete step, unchanged from before**: real multi-file codegen for `TStoWasm` -- now precisely
scoped as needing BOTH (a) seeding declarations from every loader-resolved module, not just the entry
file, AND (b) resolving a namespace-import-qualified call/reference back to the right module's own AST,
since bare-name collection alone doesn't reach it. The checker.ts self-narrowing gap documented above is
unrelated, smaller, and independently available to pick up whenever convenient.

**New workflow, 2026-08-24: a standing background sub-agent now owns checker.ts/type-utils.ts bug-fixing**,
spawned specifically so it can run in parallel with the main self-hosting integration work; the
orchestrating session hands it newly-found bugs via follow-up messages rather than fixing each one inline
and interrupting the main thread. Same verification discipline as this whole plan (root-cause via a real
minimal repro under `assistant/repro-dir/`, confirm-on-unmodified-file before attributing a "new" error to
your own change, full `test-towasm.ts`+`test-tison.ts`+`tsc --noEmit`+eslint clean, whole-workspace sweep
for anything narrowing/inference-related, no `git commit`). Orchestrator verifies its reports independently
(re-running the repro + suites itself, and diffing the agent's own tool-call transcript against `git
status` when a diff looks unexpectedly large) before trusting them, same as any other subagent handoff.

**Checker-bug-agent round 1, DONE (2026-08-24) -- fixed the `?.`-discriminant-negation union-member-loss
bug** (the one documented above as "found, deliberately NOT fixed"). Real root cause, more precise than
the orchestrator's own hypothesis (which guessed the `&&`/`||` negation-combine logic at checker.ts:428-452
directly): the actual bug was in `narrow()`'s discriminant-EQUALITY branch itself (`x.prop === literal`,
the `l.type==='member' && r.type==='literal'` case) -- it narrowed the base object purely by the
discriminant test, with NO account for `?.` optional chaining. For `x?.prop === literal` to genuinely hold,
`x` itself must be non-nullish first (a nullish `x` short-circuits to `undefined`, which can never `===` a
real literal) -- missing this let the branch's own "unresolvable discriminant: stay lenient" fallback also
leniently keep `undefined` in the TRUE-branch's result (since `undefined` has no `.prop` to check against),
contaminating the type that flowed into the outer `&&`-negation's union-combine for the ELSE branch -- so
the bug's user-visible SYMPTOM was in the negation-combine logic (matching the orchestrator's hypothesis),
but its actual CAUSE was one level of expression deeper, in the base branch being negated. Fixed by giving
`narrowKey` an optional `base` scope param (default `scope`, so every other call site is unaffected); the
discriminant branch, only when computing the "equality holds" branch (`keepMatch`) of an OPTIONAL access
(`l.optional`), first narrows `l.object` to exclude nullish, then layers the discriminant narrowing on top.
**Bonus, unrelated pre-existing bug fixed to even get verification running**: `rangeUnOp` (type-utils.ts)
never implemented `'++'`/`'--'` (only `'+'`/`'-'`/`'~'`) -- `++x`/`--x` on a range-narrowed number silently
returned `undefined`, hard-crashing `widenLiterals` and blocking the whole-workspace sweep outright.
Confirmed pre-existing (reproduces identically on unmodified checker.ts too) before fixing forward: added
proper cases mirroring `rangeBinOp`'s `add`/`sub` (shift both bounds by 1, preserve `integer`).
2 new tests in `test-towasm.ts` (a type-check-only `checkTypeChecks` helper, since the actual repro's
union-of-interfaces-with-optional-receiver shape hits several unrelated pre-existing towasm.ts *backend*
gaps out of scope here -- the original bug and a `!==` negative-control both covered). Verified (both by
the sub-agent and independently re-verified by the orchestrator): `test-towasm.ts` 439/439, `test-tison.ts`
clean, `tsc --noEmit` clean, eslint 0 errors, whole-workspace sweep ERROR 195->188 (-6, six matching
"... | undefined not assignable" messages including the real-world `T.resolve(typeAnnotation.declScope as
Scope, typeAnnotation)` instance from earlier in this same session, zero new distinct error text).

**Correction to the note above**: the large, unattributed `checker.ts`/`transform.ts` restructuring was the
USER's own direct hand-edits (made while this session's agents were idle/running), not the concurrent
parser-lane session -- confirmed by the user directly. Not a multi-agent overlap risk after all; the
sub-agent's tool-call transcript correctly showed it never touched those files, which is what flagged this
in the first place, just misattributed to the wrong party. Still worth remembering in general: an
unexpectedly large diff in a shared, uncommitted working tree can come from the user's own concurrent
work, not just another session -- check both before assuming either.

**All of this session's verified work committed, 2026-08-24** (per [[feedback_auto_commit_verified]],
a real standing preference discovered mid-session via another session's own memory write): `be759ff`
(NodeModules relative-root infinite-loop fix), `33c9d76` (multi-file codegen for TStoWasm), `dcc7fa4`
(checker.ts `?.`-discriminant-negation fix, bundled with the user's own concurrent checker.ts/type-utils.ts
edits per their explicit choice when asked), `55f329f` (see below). `checker.ts`'s and `type-utils.ts`'s
diffs turned out to span far more than either targeted fix -- confirmed via each sub-agent's own
tool-call transcript that it only touched what it reported, so the rest was the user's own direct,
concurrent hand-editing of those same files (real, ongoing, not this plan's concern) -- asked the user
directly rather than guess how to split it; they chose one combined commit.

**Multi-file codegen for `TStoWasm`, DONE for the core case (2026-08-24)** -- built and landed exactly
as scoped: `module-loader.ts`'s new `collectModules(entryBody, loader)` (walks every `import` reachable
from the entry via the same warm `ModuleLoader` a preceding `TStypeCheckAsync` already resolved against,
returning every other module's own body + its own namespace-import bindings) and `towasm.ts`'s new
`homeKey`/`resolveDecl`/`resolvesGlobally` (threaded through every `functionDeclByName`/`funcs`/
`functionValueWrappers` lookup) together close both precisely-scoped sub-problems: seeding declarations
from every resolved module, and resolving a namespace-qualified call (`NS.foo(...)`) back to the
declaring module. Verified end to end: a real 2-file program (`import * as H from './helperFile'; H.helper
(...)`) compiles via the real `tsw.ts` CLI and runs correctly under `wasmtime`. 3 new permanent tests.
**3 general, unrelated bugs found+fixed along the way** (all needed just to get real multi-file programs
compiling, not multi-file-specific themselves): a closure nested in a function couldn't reference a
sibling top-level function by bare name (free-var resolution only knew locals/captures); `unknown`-typed
fields/locals had no wasm representation at all (only `any` did); object-shape literal construction had
no handling for a declared-optional (`key?: T`) member.
**Real `ts-parser.ts` progress**: compiling it via the CLI now gets **past every cross-module resolution
concern entirely** -- no more "unresolved identifier" for any `JS.foo(...)`-style call -- landing on a
new, clean, single-line error: `towasm: object-shape type 'Literal.value' needs an explicit
number/boolean/object type`. Root cause, deliberately NOT fixed (real design question, not a mechanical
gap): `Literal<string | number | boolean | null | JS.TemplatePart<Type>[]>` is a *heterogeneous* union
(scalars mixed with an array/object shape) -- `typeOf`'s union-boxing only boxes as `any` when EVERY
member is struct-backed (`unionStructOwners`), a deliberate guard against a real, previously-regression-
prone degenerate case (`number | number`, see the 2026-08-22 IteratorResult regression earlier in this
file) -- relaxing it needs a real design decision distinguishing "genuinely degenerate single-physical-
type union" from "real box-as-any union," not just loosening the check.
**Also found, not yet reached**: plain named cross-file imports (`import { Rules, Forward, ... } from
'../../tison'`, used extensively alongside namespace imports in `ts-parser.ts`/`js-parser.ts`) aren't
handled -- only `import * as NS` is; a bare `Rules(...)` call would currently throw "call to unknown
function". And once codegen reaches into a non-entry module's own body, real (unrelated) pre-existing
type errors exist there (`js-parser.ts`: `Object.defineProperty`, `String.fromCodePoint`, a
`BigInt`/`bigint` literal mismatch) that were previously invisible -- `exportScope`'s own muted-check
design only ever derives a non-entry module's exported *types*, never fully checks its internal bodies,
so codegen can now reach a never-checked, genuinely-broken function body from another module. Not caused
by this session, but newly *consequential* now that codegen actually reaches cross-module bodies.

**Real, separate bug found+fixed while verifying the above: a genuine towasm.ts compile error had been
invisible all session (2026-08-24).** The user flagged directly (from their own IDE) that `towasm.ts`
itself failed to compile -- `ensureObjectShape`'s local `fields` array (feeding the exact optional-field
construction fix above) was typed `{ name: string; wtype: WasmType }[]`, but the loop pushes `{ name,
wtype, optional }`, and the array flows straight into `ClassInfo.fields` (which already declares
`optional?: boolean`) -- a real excess-property violation under real `tsc`. **Root cause of why this went
uncaught**: `npx tsc --noEmit -p .` from the tison package root was run repeatedly all session (by this
orchestrating session directly, and via both spawned sub-agents' verification steps) believing it verified
every `checker.ts`/`towasm.ts`/`module-loader.ts`/`tsw.ts` edit -- but the root `tsconfig.json`'s `include`
is `["src/*.ts"]` (non-recursive), so it silently checks NOTHING under `src/examples/TS/` at all, always
reporting clean regardless of real errors there. **This is a recurrence of an already-documented memory**
([[feedback_tison_examples_needs_own_tsconfig]], first caught 2026-08-20) -- the memory existing wasn't
sufficient, since neither this session's own verification steps nor either sub-agent's prompt spelled out
the correct path explicitly. Fixed forward (widened the local array's type annotation to match
`ClassInfo.fields`), committed as `55f329f`, verified against BOTH correctly-scoped configs
(`src/examples/tsconfig.json` and `test/tsconfig.json`) plus the full test suite, all clean. **Going
forward in this plan: any tsc verification step, in this session or a spawned agent's prompt, must spell
out `cd tison/src/examples && npx tsc --noEmit -p .` explicitly** -- never an unqualified "run tsc" or
`npx tsc --noEmit -p .` with an implied/root directory.

**Named cross-file imports, DONE (2026-08-24)** -- `import { helper } from './helperFile'` (as opposed to
`import * as NS`), the other precisely-scoped gap flagged when multi-file codegen first landed. User
confirmed directly this was surprising ("they used to work") -- verified via git history (`tsw.ts` only
ever had 3 commits total before this session, none pre-dating any multi-file support; the exact
`'call to unknown function'` error string never changed across `towasm.ts`'s whole history) that
`TStoWasm` genuinely never had ANY cross-file resolution before this session -- what the user recalled
working was almost certainly `TStoJS`/`TStoDecl` output or direct Node/tsx execution of the TS-subset
source, neither of which needs real compile-time linking the way wasm codegen (one flat module, no
dynamic loading) does. Landed by extending the exact same mechanism namespace imports used:
`collectModules` (module-loader.ts) also returns `namedImports` (canonical -> local name -> {module,
name}), and three towasm.ts resolution points (`emitCall`, the identifier-fallback for function-as-value,
`resolvesGlobally`'s closure-capture check) consult it on a failed local lookup. 2 new tests (direct call,
aliased value-use), both verified running under real wasmtime. Compiling the real `ts-parser.ts` now gets
past ALL import concerns (namespace + named) with zero new regressions -- same already-known blocker as
before. Committed as `c25cb7b`.

**Heterogeneous-union boxing, DONE (2026-08-24) -- closes the `Literal.value` blocker; also fixed a real
crash reaching a new one.** User's own explicit call: "I don't see an alternative to fixing it and then
fixing any regressions it causes." `typeOf`'s union case (towasm.ts) previously boxed as `REF_ANY` only
when EVERY non-nullish member had a real struct-backed `ClassInfo` owner (`unionStructOwners`) --
deliberately, guarding the 2026-08-22 `IteratorResult<number,number>` degenerate-union regression (should
stay plain `f64`, not box). A genuinely heterogeneous union (scalars mixed with a struct/array, e.g.
`Literal<string|number|boolean|null|TemplatePart[]>.value`) failed that all-or-nothing gate and had NO
representation at all. **Fix**: reframed the real question as "do all members' own recursive `typeOf`
reduce to the same physical `WasmType`" (via `wasmTypeKey`) -- same value stays unboxed if so (correctly
covers the degenerate case), box as `REF_ANY` when they genuinely differ, regardless of *why* (scalar vs
scalar, class vs class, or scalar vs struct/array -- one principled rule, not a special case for this
union). `unionStructOwners` itself untouched, confirmed still load-bearing for a separate question
(`unionClassMembers`/`ensureUnionFieldDispatch`'s "which classes can a union member-access dispatch to").
Regression guard verified first (rebuilt the `IteratorResult` repro, confirmed still unboxed) before
touching anything.
**Real crash found+fixed while verifying against the actual target file**: pushing this against
`ts-parser.ts` hit `RangeError: Maximum call stack size exceeded`, not a clean error -- root-caused via a
real stack trace to `ensureObjectShape` having NO reentrance guard for a self-/mutually-referential
object-shape type, unlike `ensureClass` (which already has one, `resolving: Set<string>`, throwing a clear
"field cycle... not supported"). `ts-parser.ts`'s own `Type` union genuinely IS self-referential (reachable
through `ArrayType.element: Type`). Confirmed the class-side limitation is pre-existing/already-accepted
(a plain self-referential linked-list class already throws the same error on unmodified code, not new).
Fixed by giving `ensureObjectShape` the exact same guard `ensureClass` already has -- parity, not a new
capability; turns an unbounded crash into the same clean, existing error message.
2 new tests (heterogeneous union with real runtime execution, self-referential shape rejected cleanly via
`checkThrows`), full suite green (446/446). Committed as `38b8af1`.

**Next real blocker for `ts-parser.ts`, found and precisely characterized, deliberately NOT attempted --
genuinely architectural.** Past `Literal.value` cleanly now; immediately hits `towasm: object-shape type
'ArrayType' has a field cycle (directly or indirectly has a field of its own type) -- not supported`. This
is NOT a bug -- it's the same class-cycle limitation just documented above, newly reached because a
self-referential *object-shape* (not class) is being built for the first time, and `ArrayType { element:
Type }` (nested arrays, `number[][]`) is a completely ordinary, legitimate recursive type. **Why it's hard,
not just missing**: both `ensureClass` and `ensureObjectShape` need every field's concrete `WasmType`/
`typeIndex` resolved BEFORE the containing struct's own type is registered -- structurally incompatible
with a field being (or transitively containing) the same type being built. wasm-GC itself supports
mutually-recursive struct types natively via rec groups, so this IS representable in principle; supporting
it for real means restructuring `addType`'s own allocation order (pre-allocate the outer type's own index
BEFORE recursing into field types, so a self-reference can forward-reference it) -- a change to core,
shared type-registration machinery used by EVERY class and object-shape in the file, not a contained fix.
**Flagged as likely THE next real blocker for `ts-parser.ts`** specifically (self-referential AST-node-
shaped unions -- `Type`, `Statement`, etc. -- are exactly what a real parser/AST needs constantly), worth
scoping as its own deliberate piece of work, not picked up piecemeal under time pressure. All work this
round independently verified by the orchestrating session (re-ran every repro, both correctly-scoped tsc
configs, full suite) before trusting the sub-agent's own report, matching this whole plan's established
discipline.

**Self-referential struct/class support, DONE for real now (2026-08-24) -- landed via a genuine
multi-round collaboration (user hand-wrote the initial fix, orchestrator + sub-agent found and closed 3
more real bugs it exposed), committed as `83ba81a` on top of the earlier `55f329f`/`c25cb7b`/`38b8af1`.**
Final mechanism: `ensureClass`/`ensureObjectShape` register the `ClassInfo` with a real `typeIndex`
placeholder BEFORE resolving any field's own type, so a reentrant call for the same class (triggered by a
self-referential field) finds `typeIndex` already real and short-circuits instead of recursing into the
same field-processing pass again -- real content patched into `types[idx]` once fields are known. Two
structural complications, both correctly handled: (a) non-generic top-level classes are pre-seeded into
`classes` eagerly elsewhere in `TStoWasm`, so the short-circuit must stay keyed on `typeIndex !== -1`, not
mere map presence (unlike `ensureObjectShape`, which has no pre-seeding); (b) a class with an
explicit-return constructor must NEVER get a struct placeholder at all (a self-referential field could end
up pointing at an orphaned struct nothing constructs) -- resolved via a cheap pre-scan of the constructor's
own body (just AST inspection, no field-type resolution, no recursion risk) BEFORE deciding whether to
allocate anything.

**Two more real bugs found closing this out, both from real multi-level-inheritance/generator cases, not
guessed**: (1) the rec-group split rule (from an earlier session, meant to protect a real host-imported
func type like WASI's `fd_write` from external canonicalization) was too broad -- it split at EVERY func
type, which broke a legitimate internal forward-reference the self-ref fix now needs (two structs
referencing each other around an ordinary closure's func type, registered mid-field-resolution) --
narrowed to only host-imported func types. (2) `ensureClass` resolved a class's own superclass AFTER
allocating its own struct placeholder -- for `C extends B extends A`, that gives REVERSED typeIndexes
(C<B<A) with `supertypes` forward-referencing a HIGHER index, which wasmtime rejects outright (unlike an
ordinary field reference, a struct's declared supertype can't forward-reference at all) -- fixed by
resolving the superclass BEFORE allocating the class's own placeholder.

**Also closed, real + pre-existing, found via the user's own test**: `x[0][1]` for `x: number[][]` crashed
with "illegal cast" at runtime. Root cause one layer deeper than first diagnosed: `number[]` structurally
aliases `Array<T>`, so indexing dispatches through `Array<T>`'s own generic `.get()` method, not raw array
indexing -- a nested array literal embedded in an outer ref-kind array always gets boxed-`any` element
storage (per this file's existing "about to be boxed -> ref-kind" rule), but the WRONG method
instantiation (`Array<number>` instead of `Array<any>`) was being selected based on the value's *declared*
type instead of its actual physical representation. Fixed with a narrowly-scoped `classOfForIndexing`
helper (only reroutes for the built-in `Array` when the container is itself ref-kind), wired into every
indexing call site (read/write/`.length`).

Both self-referential class and self-referential object-shape verified end-to-end under real wasmtime
(linked-list sum, tree sum), including combined with real inheritance. `ts-parser.ts` real-file progress
preserved (still the already-known `MappedType.constraint` blocker next, no regression). 450 total tests,
full suite green. Verified independently by the orchestrating session before committing (both fix rounds),
matching this whole plan's established discipline throughout.

**`MappedType.constraint` blocker CLOSED (2026-08-24, committed `f61aec4`).** Root cause: `typeOf`'s union
case required EVERY member to individually resolve to a real `WasmType` before it would even consider
boxing as `REF_ANY` -- one unresolvable member (common in a large, many-membered union like `Type` itself)
made the WHOLE field unrepresentable rather than falling back to `any`, even though "a member that can't be
pinned down to one shape" is exactly the situation any-boxing exists for. Fixed: box as `any` whenever
members DON'T all resolve to the identical `WasmType`, including the case where some don't resolve at all.
The degenerate same-physical-type regression guard (`IteratorResult<number,number>.value`) is unaffected,
still covered by its own existing test. 450 tests, full suite green, both correctly-scoped tsc clean.

**New real blocker found immediately after, NOT attempted -- genuine design question, not a bug.**
`towasm: exported function 'RefType' is generic -- a generic function has no single fixed signature to
export`. This is a DELIBERATE existing check (not new), but newly *reached* because `ts-parser.ts` is being
compiled as the entry file and it `export`s a generic function. The real issue: `TStoWasm` currently treats
every TS-level `export` as a WASM-level export (must have one concrete signature, gets pushed into
`mod.exports`) -- correct for a standalone PROGRAM's own entry points (`main`/`test`-style functions meant
to be invoked from outside wasm), but wrong for a LIBRARY module like `ts-parser.ts` (never invoked
directly -- its `export`s just need to be visible to OTHER .ts files at compile time, which the multi-file
codegen's `namedImports`/`namespaceImports` mechanism already handles internally, with no need for a
wasm-level export at all). Needs a real design decision: what should "export" mean when the compile target
is a library vs. a program (e.g., only wasm-export symbols the ENTRY module itself exports, not everything
transitively compiled in -- or a way to mark "this is a library compile, skip wasm-level exports
entirely"). Deliberately not attempted under severe end-of-session budget constraints (2026-08-24) -- flag
for explicit discussion before the next attempt at pushing `ts-parser.ts` further.

**User's own large hand-edit, 2026-08-24 20:00 -> 2026-08-28 01:09 (commits `a116288`/`07828da`,
untouched by any session), verified clean by this session (2026-08-28), not designed by any agent.**
Two things landed:
1. **`TypeContext` state-threading refactor** (checker.ts/type-utils.ts/towasm.ts) -- converts what were
   module-level mutable caches (`resolving`, `resolveCache`, `depthExhaustion`, etc.) into a real
   `T.TypeContext` class instance, explicitly constructed (`new T.TypeContext`) and threaded as an
   explicit param through nearly every exported function (`checkBlock`, `typeOf`, `resolve`,
   `substituteType`, `wasmTypeOf`, ...). This is exactly the "one deliberate pass" the plan's own
   pre-threading-cleanup note (2026-08-23, above) had scoped and deferred -- now done, unprompted, by the
   user directly. Coherent and complete, not partial -- consistent with [[feedback_no_checker_state]].
   `transform.ts` also had `flattenStateMachine` renamed to `BuildStateMachine`, and `CompilerOptions`/
   `scanPragmas`/`applyPragmas` moved out to `tsw.ts` (which now owns the full CLI option-default
   composition, `ModuleOptionsDefault`/`JSX.OptionsDefault`/`OutputOptionsDefault`).
2. **`walker.ts`**: gained a `recurse` callback threaded into `walk`/`walkB`'s own hooks (lets a
   statement-level hook cross into the expression/type domain via the same shape-based dispatch `walk`
   itself uses), and `calcUnary`/`calcBinary` constant-folding helpers were hoisted here (now shared by
   `transform.ts`, dedup'd out of its own local copies). Real bug fix: `mapObject`'s `{...node}` spread
   was silently dropping the non-enumerable `pos` stamp -- now explicitly re-`defineProperty`'d.
   **The `mapObject`/`NodeMap<N>` generic-monomorphization gap itself (item 9's 3rd sub-problem,
   ~77 walker.ts call sites, same root as the discriminated-union work) is UNTOUCHED by this refactor**
   -- still open, not resolved.
3. **`vsdg.ts` (new, 1026 lines) is NOT part of the self-hosting critical path** -- user confirmed
   directly (2026-08-28): "just some exploration of potential optimisation strategies once the compiler
   is working." Confirmed unwired (zero references from any other file, including `tsw.ts`). A
   sea-of-nodes/Click-style-global-code-motion prototype (`BuildVSDG`/`optimize`/`applyGlobalCodeMotion`),
   itself extracted+reshaped from code that briefly lived inline in `transform.ts`. Early-stage: several
   statement/expression kinds fall through to a bare `console.log('not handling ...')`, one class fully
   commented out. Treat as background/deferred exploration, not a blocker or a dependency of anything --
   don't route self-hosting work through it.

**Verification + one real gap found+fixed by this session (2026-08-28), before resuming plan work:**
`cd tison/src/examples && npx tsc --noEmit -p .` clean; `cd tison/test && npx tsc --noEmit -p .` initially
failed -- `test-ts-official.ts:23`'s `checkBlock(lib!.body, global)` call was never updated for the new
`TypeContext` param (the whole-workspace-sweep harness isn't part of `src/examples`' own tsconfig, so the
user's own refactor pass had no reason to reach it). Fixed (`checkBlock(lib!.body, global, new
T.TypeContext)`), committed as `800adcb`. Full suite re-verified after: `test-towasm.ts` all green,
`test-tison.ts` clean (exit 0), eslint 0 errors (only pre-existing-pattern `no-single-use-local`/
unused-var warnings, including in the now-present `vsdg.ts`). Plan resumes from the still-open items
listed just above this note (generic-function-export design question is the most immediately concrete
one) plus the never-resolved `mapObject`/`NodeMap` monomorphization gap.

**Generic-export design question, CLOSED (2026-08-28, user's own explicit call): skip silently, no new
mode.** A generic export just doesn't become a wasm-level export; non-generic exports still are.
Reasoning: cross-file references already resolve internally via the multi-file codegen's own
`namedImports`/`namespaceImports` mechanism, no wasm-level export needed at all -- and self-hosting's real
entry point will be a driver importing `ts-parser.ts` as a library anyway, so this case recurs there too
regardless. **Turned out already half-implemented**: `towasm.ts:6395`'s own code already had `continue`
in place of the old `throw` (the user's own recent edit, done ahead of asking) -- only the explanatory
comment above it still described the old throw-based behavior. Comment reconciled, committed `71a4160`.

**Anonymous inline object-type return position, DONE (2026-08-28) -- but scoped narrower than a first
attempt, after that attempt caused two real regressions.** Pushing `ts-parser.ts` through the real CLI
past the export fix hit a new, precisely-characterized gap: `make()`'s own inferred return type is
`Parser<Program>` (`tison.ts`'s own `interface Parser<T,C=any> { parse(...): T; parsePrefix(...): {
value: T; consumed: number }; tables: ParseTables }`) -- `parsePrefix`'s return position is a genuinely
anonymous inline object type (`{value: T; consumed: number}`, never named via `interface`/`type X =
...`), which `typeOf`'s existing 'object' case had NO representation for at all (only ever handled the
index-signature/dynamic-Map-object shape, `indexSignatureValueType`). Root-caused via a minimal, isolated
repro under `assistant/repro-dir/` (not guessed) down to exactly this shape.
**First attempt (reverted): a general `typeOf`/`ownerFor` fallback** -- new `ensureAnonObjectShape`
(shares `ensureObjectShape`'s struct-building core via extracted `buildObjectShape`), keyed by the
resolved type's own rendered structural text (`T.typeKey`), wired as a fallback in BOTH `typeOf`'s and
`ownerFor`'s top-level `case 'object'`. **Caused two real regressions**, both caught by the full
`test-towasm.ts` suite before landing (never assumed safe): (1) a `Point` class read back through `??`'s
own union-combine (`T.combineTypes([Point,Point])`) apparently loses its `ref` wrapper upstream in the
checker layer itself, arriving at `ownerFor` as a bare structural 'object' type indistinguishable from a
genuinely anonymous one -- a `t.type==='object'` guard (checking the *pre-resolve* param, not the
post-resolve result) fixed this specific case; (2) a plain, deliberately-unannotated object literal
(`const p = {x:1,y:2}`) is *supposed* to be rejected (existing, deliberate design policy -- object-literal
target-type inference was intentionally scoped OUT, see the "object literal with no known target type is
rejected" test) -- `case 'var_decl'`'s own no-annotation inference fallback (`T.literalTypeOf(d.init)`)
produces a type that's ALSO genuinely, structurally 'object' from the start (not via losing a ref), so the
`t.type==='object'` guard doesn't distinguish "declared anonymous type annotation" from "unannotated
literal's own inferred structural shape" -- and the whole point of that design policy is to reject exactly
the latter. No clean node-shape signal was found to separate the two once flattened to the same `Type`
AST shape.
**Final, landed fix: scoped to exactly the one call site that actually needed it** -- `typeOf`'s own
`case 'function'` (a function/method TYPE's return-type resolution, used both for a real function-typed
value/param/field and, via `ensureObjectShape`'s own `addField`, for an interface method member) now tries
`ensureAnonObjectShape` only when its own `func.returnType` doesn't otherwise resolve. This position is
safe because nothing upstream of it strips a name off a *declared* return-type annotation -- unlike
`ownerFor`'s general dispatch (reached from many places, some already past a lossy resolve) or a value's
own *inferred* type (deliberately excluded from structural typing by policy). `typeOf`'s and `ownerFor`'s
general `case 'object'` fallbacks were fully reverted back to only the index-signature/Map case. Verified:
full `test-towasm.ts` (447/447) + `test-tison.ts` + both correctly-scoped `tsc --noEmit` + eslint (0
errors) all green, both regressions confirmed gone via their own isolated repros. Committed `22919c1`.
**Confirmed NOT sufficient to get `ts-parser.ts` compiling further** -- deliberately not chased same
session, see next paragraph.

**Next real blocker for `ts-parser.ts`, found and precisely characterized, NOT attempted (2026-08-28) --
likely a multi-file type-visibility gap, not a codegen representation gap this time.** Past the anonymous-
return-type fix, `make()`'s own return type STILL fails ("`'make' has an unsupported return type`"), but
for a different, deeper reason: `ensureObjectShape('Parser', ...)`'s own early-exit (`if
(!global.type(name)) return undefined;`) is what's firing -- confirmed by elimination (no throw
propagates, meaning nothing inside the interface's own member-building ever ran at all). `Parser<T,C>` is
declared in `src/tison.ts` (outside `src/examples/TS/` entirely); `ts-parser.ts` itself never imports the
name `Parser` at all -- only `makeCachedParser` (the function, from `src/tableCache.ts`, itself importing
`Parser` from `./tison`), with `Parser<Program>` only ever reaching `make()`'s own type through checker
inference on that function's return type. Real TS resolves this fine (a type never needs to be explicitly
imported to be *used* via inference); this compiler's own `global.type(name)` lookup for CODEGEN purposes
appears to only walk the entry module's own lexically-visible/imported scope chain, never a transitively-
inferred-but-unimported external type's home module. **Not yet root-caused past this description** --
whether the real gap is in `collectModules`/`global`'s own construction (multi-file codegen not
registering every resolved module's types into one shared lookup) or something narrower is unconfirmed.
Flagged precisely for the next session/attempt, not guessed at further under this session's own time
budget -- matches this plan's established practice of stopping at a genuinely new, deeper wall rather than
patching around it blind.

**Cross-module type-visibility gap, ROOT-CAUSED + FIXED (2026-08-28), same session, user asked to
continue.** Confirmed precisely via an isolated two-file repro (`assistant/repro-dir/multifile/`:
`lib.ts` declares `interface Box<T>`, `main.ts` imports only the FUNCTION `makeBox` from it, never `Box`
by name -- `main()`'s own `.value` field access on `make().value` failed "unknown field 'value'",
reproducing the shape exactly). Traced with a temporary debug print on `ownerOf`'s own `checkerTypeOf`
result: the checker DOES correctly resolve+stamp a cross-module `RefType`'s own `declScope` (confirmed
present in the printed AST -- `checker.ts`'s/`type-utils.ts`'s existing `withScope`/`declScopeOf`
mechanism, already used elsewhere for exactly this, e.g. a class method's own signature resolving via a
different module's scope) -- but `ensureClass`/`ensureObjectShape` (towasm.ts) never consulted it at all,
always resolving a bare `name` against the single fixed `global` (the entry module's own checked scope),
which naturally has no entry for a type only ever reached *transitively* (inferred off an imported
function's own return type) without being explicitly imported by name itself. **Fix**: threaded an
optional `declScope?: Scope` param through both functions (defaults to `global`, every existing same-
module caller unaffected), consulted at the two real call sites that had an actual `RefType.declScope` to
pass (`typeOf`'s and `ownerFor`'s own `t.type === 'ref'` fast paths). `TC.resolve(global, t)` calls
elsewhere were confirmed NOT needing the same fix -- `resolve()` itself already honors `t.declScope`
internally regardless of what `scope` arg is passed. Verified: the isolated repro now compiles+runs
correctly under wasmtime; full suite (447 tests) + `test-tison.ts` + both tsc configs + eslint all green.
Committed `4e98641` (bundled with the optional-param fix below, landed together).

**Optional params in a function TYPE / closure literal, ROOT-CAUSED + FIXED (2026-08-28), same session.**
Pushing `ts-parser.ts` past the declScope fix hit `tsw: in make in . function type parameter 'ctx' cannot
be optional` -- `tison.ts`'s real `Parser<T,C=any>` interface declares `parse(input: string, ctx?: C): T`,
a bare `?` optional param (no `=` default) in a function TYPE position, which `typeOf`'s `case 'function'`
hard-threw on unconditionally (never implemented, not a deliberate policy -- unlike the earlier object-
literal-target-type restriction). **Insight that unlocked the fix**: a wasm `call_ref` always supplies a
real value for every physical param slot regardless of TS-level optionality -- optionality only ever
matters for whether a *caller* may omit the argument, which this compiler already solves generally for
ordinary named functions (`defaultsWithImplicitUndefined`, synthesizing a real `{type:'identifier',
name:'undefined'}` default expression for a bare-optional trailing param, reused by `emitCallArgs`'s own
existing arity-shortfall handling). Fixed by (1) no longer throwing, boxing the param's own wtype nullable
(`nullableWtype`) so the synthesized `undefined` default is a valid value through `call_ref`; (2) adding
`defaults?: (Expr|undefined)[]` to `FuncSig` itself, computed once via the same
`defaultsWithImplicitUndefined` helper and folded into the closure-type memoization key (needed: a
genuinely-nullable-but-*required* param and a truly-*optional* one can share an identical physical
`WasmType` while differing on real call-site omittability, so the physical signature alone isn't a safe
cache key); (3) threading `sig.defaults` (previously always `undefined`) into the three closure-call
sites that dispatch through a static closure TYPE (struct-field/bare-identifier/indexed-element calls).
**A second, separate throw hit immediately after** (`emitClosureLiteral`'s own, older, identical
restriction on a real arrow/function EXPRESSION's own optional param) -- fixed the same way, but simpler:
no separate `defaults` needed at THIS level at all, since nothing ever calls a closure literal's own
compiled function directly while omitting an argument -- the caller-side omission is entirely handled by
whoever dispatches through the field/variable's own declared TYPE (already fixed above). A real `=` default
value is still correctly rejected in both positions (needs a source expression a bare function TYPE has no
room to write) -- unaffected, only the bare-`?`-no-default case changed. Verified via an isolated repro
(`assistant/repro-dir/optparam2.ts`, an interface+generic-factory+omitted-arg call) compiling and producing
correct `call_ref` codegen (a synthesized `ref.null` for the omitted arg) -- confirmed a SEPARATE,
unrelated, pre-existing gap along the way (a nullable/boxed-`any` value used directly as a boolean
condition throws "this value cannot be used as a boolean condition") and simplified the repro to avoid it
rather than chase a third gap in the same pass. Full suite green (447 tests + test-tison.ts + both tsc +
eslint). Committed `4e98641`.

**Regex-literal codegen, ROOT-CAUSED + FIXED (2026-08-28), same session -- and a real, separate,
pre-existing `lib/regexp.ts` bug found while verifying it, NOT fixed.** Past the optional-param fix,
`ts-parser.ts`'s own `const READONLY = terminal('readonly', /readonly(?!\w)/, ...)` hit `tsw: unsupported
literal type 'object'` -- a `/pattern/flags` literal's own `.value` is a real, native JS `RegExp` object
(the parser's `REGEX_LITERAL` rule constructs it directly; `type-utils.ts`'s own `literalTypeOf` already
types this shape as `REGEXP` correctly), but `case 'literal'`'s codegen switch (on `typeof e.value`) never
had a case for `'object'` at all -- despite `lib/regexp.ts` (829 lines, a full self-hosted bytecode-VM
`RegExp` class) already existing and already reachable via an *explicit* `new RegExp(source, flags)` call.
**Fixed** by desugaring a regex literal to exactly that -- a synthesized `{type:'new', callee:
{type:'identifier',name:'RegExp'}, arguments:[Literal(source),Literal(flags)]}` node, recursively emitted
through `case 'new'`'s own existing generic `ensureClass`/`ensureCtor` dispatch (no new construction logic
duplicated). **Verified end-to-end under real wasmtime** (not just "compiles") -- a plain non-lookahead
pattern (`/readonly/`) matches correctly. **Testing the exact real pattern from ts-parser.ts
(`/readonly(?!\w)/`, negative lookahead) surfaced a real, separate, pre-existing bug**: `.test('readonly
')` (should be `true` -- a space is a non-word char, satisfying the lookahead) returns `false`. Confirmed
NOT caused by the new literal-codegen path -- reproduced identically via a hand-written `new
RegExp('readonly(?!\\w)', '')` call (the OLD, already-existing construction path, never touched this
session) hitting the exact same wrong result. This is `lib/regexp.ts`'s own bytecode VM getting a negative
lookahead `(?!...)` wrong -- confirmed via real JS (`node -e`) that `true`/`false` is the correct answer,
and via a no-lookahead control pattern (`/readonly/`, correct `1`/true) that the engine's basic matching is
fine, isolating the bug specifically to lookahead handling. **Not root-caused past this, not fixed** --
this is the exact "needs verification, not new implementation" spike this plan's own Phase 1 flagged for
`lib/regexp.ts` early on, now concretely found to have a real gap (not just an unverified-but-fine
assumption). A natural next investigation, but a genuinely separate one (bytecode-VM debugging, not
compiler-codegen work) -- flagged here rather than chased further in the same pass. Regex-literal-
construction fix itself fully verified (isolated repro + full 447-test suite + `test-tison.ts` + both tsc
configs + eslint, all green) and committed independently (`40f39de`) precisely so it doesn't get tangled
up with the still-open VM bug.

**`ts-parser.ts` real-CLI progress this session, in order**: generic-export skip (reconciled a stale
comment only, code already did this) -> anonymous function-type return position -> cross-module declScope
-> optional function-type/closure-literal params -> regex-literal construction -> cross-module unannotated-
return-type inference. Regex lookahead bug (see above) offloaded to a background sub-agent so codegen work
could continue in parallel, per the user's own explicit call.

**Cross-module unannotated-function return-type inference, ROOT-CAUSED + FIXED (2026-08-28), continuing
past the regex-literal fix while the lookahead-bug sub-agent ran in parallel.** `tsw: in make in . 'make'
has an unsupported return type` recurred for `terminal(...)` (tison.ts's own unannotated `export function
terminal(...) { return new Terminal<string>(...); }`, called from `ts-parser.ts`'s `READONLY` terminal
declaration) -- same *symptom* class as the earlier `Parser<Program>` blocker, but confirmed via an
isolated 2-file repro (`assistant/repro-dir/multifile2/`) to be a **different, deeper root cause**: a
non-entry module's `FunctionDecl` (the real AST node `functionDeclByName`/`compileFunc` hold and compile
from directly) never gets its checker-inferred return type back-filled onto itself at all -- inference for
an unannotated function only ever happens on a **throwaway synthetic clone** `hoist()` builds for the
declaring module's own scope value entry (`checker.ts`'s `exportScope`->`hoist()`, a lazy, self-memoizing
`Object.defineProperty(t, 'returnType', {get(){...infer once...}, set(){...stamp once...}})` accessor on
`t = TS.FunctionType(...)`, a FRESH object built via `T.FixSig(d, T.ANY)` -- never the same object as `d`
itself). **Fix**: `compileFunc`, when `!decl.returnType`, now falls back to `global.value(name)` -- proven
safe and correct (not a guess) via a debug trace confirming this literally returns the same already-
inferred, already-correctly-`declScope`-stamped function type, whenever `name` is imported directly into
the entry module (the checker had to trigger+cache that exact lazy accessor already, to type-check the
call site that made compiling this function necessary in the first place). Explicitly scoped/documented as
narrower than fully general (doesn't help a function only ever reached *indirectly* through another non-
entry module, not the entry's own direct import list -- no case currently exercises that, not attempted).
Verified: 2 isolated repros (class-returning + void/scalar-returning) correct under real wasmtime, full
suite green (447 + test-tison.ts + both tsc + eslint). Committed `faa351a`.

**Two new, SUBSTANTIALLY BIGGER architecture gaps found immediately after -- NOT attempted, flagged for
explicit scoping discussion, matching this plan's established practice for a genuine design question
rather than a local bug (2026-08-28):**

1. **Non-entry classes get no module-scoped treatment at all -- already self-documented, not new, but now
   concretely confirmed reachable.** `TStoWasm`'s own top-level seeding loop has an explicit comment:
   "Only *functions* are seeded across every module this way -- a non-entry module's own classes/scalar
   globals aren't yet given the module-scoped treatment `ensureClass`/`ensureGlobal` would need... stays
   entry-only, exactly as before multi-file support existed." Confirmed via the same 2-file repro
   (`multifile2/lib.ts`'s `class Box`, once its constructor-calling function's return type resolved via
   the fix above): `new Box(...)` fails "class 'Box' needs an explicit constructor" -- `ensureClass('Box')`
   finds nothing in `LIB_DECL_MAP`/`userGenericClassDecls` (neither ever registers a non-entry class),
   falls through to `ensureObjectShape`'s generic structural-shape fallback (which this session's earlier
   declScope fix made newly *reachable* for this case too), silently misrepresenting a REAL class as a
   bare data shape with no methods -- **confirmed NOT a regression from anything this session did**: reverted
   just the return-type fix and confirmed the SAME repro already failed differently (`cannot convert void
   to ref:Box`) even before it, i.e. multi-module classes were never reachable/working either way. Building
   real support needs the same `homeKey`-based per-module registration functions already have, extended to
   classes -- a real, substantial feature (also needs to resolve the class-name-collision risk across
   modules that per-module keying, unlike the current single flat `classes`/`userGenericClassDecls` maps,
   would introduce).
2. **A top-level `const X = someFactory(...)` in a non-entry module, later CALLED as a function
   (`Rule([...], ...)`), has no support at all -- and this is not a rare pattern, it's PERVASIVE.**
   `tsw: (211:41) call to unknown function 'Rule'` -- `js-parser.ts:295`'s `export const Rule =
   makeRule<any>(<T>(t,$) => {...})` (a curried rule-builder factory call, NOT an `arrow`/`function`
   literal) is called at dozens of sites throughout `js-parser.ts`/`ts-parser.ts` (`Rule([...], ...)`),
   the SAME declarative-DSL idiom this whole grammar-spec pair is built from. Root-caused precisely:
   `emitCall`'s dispatch only ever checks `functionDeclByName` (populated only for a `const` whose own
   initializer syntax IS an `arrow`/`function` literal -- `Rule`'s own initializer is a `call` expression,
   the RESULT of calling `makeRule`, so it's never registered there at all) or `funcs`/`builtins` --
   nothing here reaches a bare cross-module identifier resolving to an arbitrary closure-typed VALUE.
   Confirmed via a quick `grep` sweep that this `const X = factoryCall(...)` shape is the DOMINANT
   top-level declaration style across `js-parser.ts` (`terminal(...)`, `Rules(...)`, `OneOf(...)`,
   `List(...)`, `Forward(...)`, and `Rule` itself, dozens of names). **This is genuinely bigger than a
   codegen representation gap**: even once a call site can correctly identify "`Rule` is a closure-typed
   cross-module value, dispatch via `call_ref`" (the SAME general mechanism already built for a bare-
   identifier closure call, just needing cross-module reach), `Rule`'s own VALUE still has to be
   *computed once, at real program-init time*, by actually running `makeRule<any>(...)`'s own call --
   i.e. genuine cross-module top-level *side-effecting* initialization order, comparable in scope to a
   real wasm module's own `start`-function composition extended across every loaded file, not just the
   entry's own top-level statements (today's seeding loop only promotes a *compile-time-foldable-literal*
   `const` from the ENTRY module into a real wasm global -- `Rule`'s own initializer is neither foldable
   nor entry-scoped).
Given (1) is already-known/self-documented and (2) is large, pervasive, and load-bearing for the actual
grammar-spec files (not a one-off), both are flagged here for an explicit scoping conversation with the
user before either is attempted -- deliberately not guessed at or partially patched under this session's
own momentum, matching the same discipline as the earlier "library vs program export" design question.

**Gap 1 (non-entry classes) CLOSED for real, via a genuinely better design than what was scoped above --
the user's own architectural insight, not mine (2026-08-28, same session).** Asked to scope gap 1, the user
pushed back on the "extend `homeModule`/`homeKey` string-mangling to classes too" plan: the checker already
resolves any name via real scope chains to type-check it, so needing `homeModule` at all is an artifact of
towasm.ts's own flat, name-keyed maps -- not something cross-module resolution inherently requires. Checked
this precisely: `Scope` (type-utils.ts) really does only ever store a name's *derived* `Type`/`TypeEntry`,
never the originating `FunctionDecl`/`ClassDecl` statement -- `declScope` (this session's earlier fix)
lets you re-enter the right *scope*, but from there you can only ask "what's the Type here," never "what
declaration." Landed the fix the user converged on:
1. **`Scope` gained a `decls: Map<string, TS.Statement>`** (type-utils.ts) -- `Scope.decl(name)` walks the
   same parent chain as `value()`/`type()`; `Scope.addDecl` stamps it; `Scope.copy` carries it through
   import/re-export resolution alongside the existing value/namespace copy. `hoist()` (checker.ts) calls
   `addDecl` for both `class_decl` and (single- and overload-group, picking the real implementation) 
   `function_decl`. Purely additive on its own, zero behavior change -- verified green, committed alone
   first (`236d36a`), separately from wiring it in, per the user's own explicit "decls first" sequencing.
2. **`ensureClass`** now tries `declScope?.decl(name)` as a third fallback alongside `LIB_DECL_MAP`/
   `userGenericClassDecls`, landing on the REAL class declaration (fields/constructor/methods) instead of
   `ensureObjectShape`'s structural-shape-only fallback (which has no representation for methods at all --
   exactly what produced the earlier "class needs an explicit constructor" symptom). Reuses 100% of
   `ensureClass`'s own existing field/method/superclass-building logic underneath, no duplication.
3. **`compileFunc`** now ALSO recovers its own declaring module's scope (`checkedType.declScope` -- the
   exact same `global.value(name)` lookup already used for the cross-module return-type fallback) and
   roots the compiled function body's own `FunctionContext` scope there instead of always `libGlobal`.
   This is the piece that makes `new Box(...)` *inside* a non-entry function's own body resolve `Box` at
   all -- without it, `ctx.scope`'s chain never reaches the declaring module regardless of what `ensureClass`
   itself can look up, since `case 'new'` only had a bare `e.callee.name` to work with, no scope. `case
   'new'` now threads `ctx.scope` into `ensureClass` accordingly. Same reachability limitation as the
   return-type fallback (only when the function's own name is directly reachable via `global` -- doesn't
   help a function only ever called indirectly through another non-entry module) -- documented, not
   pursued further this session.
Verified end to end under real wasmtime: a class declared *and* constructed entirely within a non-entry
module (`assistant/repro-dir/multifile2/`), reached only through an imported factory function the entry
never names the class of at all, now compiles and runs correctly (`42`). Full suite green throughout
(447 tests + `test-tison.ts` + both tsc configs + eslint).
**Bundled into the same final commit (`2484b0e`) with the user's own concurrent hand-edit to the same
file** (`case 'call'`'s member/super/identifier dispatch consolidated, a shared `withCatch()` wrapper added
for worklist-callback error scoping, the literal-handling switch reordered) -- confirmed directly with the
user this was their own pre-existing work sitting uncommitted in the shared tree, not a conflict, and they
asked for it in the same commit. Re-verified the full suite against the combined state before committing,
per [[tison_declscope_investigation]]'s "don't assume, verify" precedent for unattributed large diffs.

**Gap 2 (`Rule = makeRule(...)`, cross-module lazy-initialized const values) -- landed for the common case,
one real deeper sub-problem found and precisely characterized, not yet fixed (2026-08-28, same session,
user asked to continue after a background sub-agent closed the regex-lookahead bug in parallel).**

**Design decision confirmed with the user**: "lazy" meant compile-time reachability (don't compile/
instantiate anything nothing references, matching the existing `worklist` philosophy every function/class
already gets) -- NOT runtime-deferred-execution semantics for their own sake. Initially over-built toward
the latter before this was clarified; the user's own correction: "if it solves problems the runtime
laziness is fine -- I didn't want you to have to add additional support for something we don't need." The
landed design (checked-once-per-access via a real nullable global + wrapper function) satisfies BOTH: an
unreferenced const compiles to nothing at all (the actual ask), and the per-access check happens to also
solve cross-module initialization ordering for free (each access recursively triggers its own
dependencies' init on first touch -- no separate topological sort needed, confirmed correct rather than
guessed, and deliberately NOT built as a separate eager/ordered-init mechanism instead, since nothing
requires it).

**Implementation**: `checker.ts`'s `hoist()`/`exportScope` var_decl loop (which already infers a top-level
const's *type*, muted) now also calls `Scope.addDecl` for it -- the SAME `decls` mechanism landed for gap 1,
just extended to `var_decl`, giving a consumer the real declarator via `declScope`, not just its type.
`towasm.ts`'s new `ensureLazyGlobal(name, homeModule, d, declScope)`: registers a real mutable nullable
global (`ensureGlobal`, starts null) plus a wrapper function built via HAND-EMITTED instructions
(`global.get`/`ref.is_null`/`if`/`global.set`), not the usual AST-synthesis desugaring idiom this file
mostly uses elsewhere -- deliberately, because `wtypeOf`/`checkerTypeOf` (checker-based type re-derivation,
used throughout ordinary codegen) has no way to see a synthetic slot name that was never real source the
checker ever type-checked; only the real initializer expression (`d.init`) goes through the ordinary,
checker-aware `emitAs`. Wired into `case 'call'`'s bare-identifier dispatch, as a new branch alongside the
existing self-call/closure-value/named-function ones -- resolves via `ctx.scope.decl(name)` (the SAME
scope-chain mechanism, already correctly rooted per gap 1's `homeScope` fix). New `stmtHomeModule` map
(populated in the existing per-module seeding loop, `Map<TS.Statement, string>`) recovers a found
`var_decl`'s real declaring module -- needed because the CALLING context's own `ctx.homeModule` is often a
*different* module than where the referenced value is actually declared (confirmed the hard way: an early
version passed `ctx.homeModule` directly, silently resolving nested calls inside the initializer against
the wrong module).

**Real bug found+fixed while landing this**: the "assemble the module" step (`TStoWasm`'s own tail end)
only ever collected `FuncInfo` bodies from the `funcs` map into `mod.code`/`mod.functionTypes` (via a
shared `place()` helper, also used for `closureLiterals`) -- never from this new `ensureLazyGlobal` cache,
leaving a real HOLE in the function-body array at the wrapper's own index. This corrupted the wasm binary
(`wasmtime`: "unexpected end-of-file") even though `mod.toWAT()`'s own text printer rendered a plausible-
looking module with the wrapper's function index simply missing from the listing -- caught by actually
running the compiled output under wasmtime, not just reading the WAT text, matching this plan's own
established "verify end-to-end, not just compiles" discipline. Fixed by adding `lazyGlobals.values()` to
the same `place()` loop.

**Verified end to end under real wasmtime** (three isolated repros under `assistant/repro-dir/lazy/`): a
plain single cross-module call, a nested-call-as-argument (matching `Rules<Type>(Rule([...]))`'s real
shape), and a call-three-times test proving the factory runs exactly once (a closure's own captured counter
incrementing 1,2,3 across three calls -- would read 1,1,1 if re-initialized per call). Full suite green
throughout (447 + `test-tison.ts` + both tsc + eslint). Committed `62aa09a`.

**Found, NOT fixed -- a real, separate, deeper sub-problem, root-caused precisely via direct tracing (not
guessed).** Pushing the real `ts-parser.ts` past this still fails at the identical `Rule([Forward(()=>
conditional_type)])` call site: `Rule`'s own checker-inferred type (`declScope.value('Rule')`) isn't a
single `'function'`-shaped `Type` at all -- it's a structural `'object'` type with TWO `'call'` members
(`makeRule`'s own declared, genuinely-overloaded return type: one signature for `Rule(rhs)`, another for
`Rule(rhs, action)`). `typeOf` has no representation for "this value, callable either of two ways" -- a
wasm closure has exactly one physical signature, period. Confirmed via direct debug tracing (temporarily
added, fully removed before committing) that `ensureLazyGlobal`'s own `typeOf(checkedType)` call is
precisely where this returns `undefined`, correctly falling through to the pre-existing "unknown function"
error rather than miscompiling. **Real fix direction, not yet attempted**: the underlying JS value is a
single, real, non-overloaded function at runtime (TS overloads are purely a type-checking fiction layered
over one real implementation -- `makeRule`'s own body presumably has one arrow function with an optional
second param) -- the right fix likely needs finding THAT concrete shape (e.g., inferring the type from
`makeRule`'s own return STATEMENT's real expression, not trusting its declared, overloaded signature) rather
than teaching `typeOf` to somehow represent multi-signature dispatch as a physical value, which real wasm
can't do at all. Not scoped further this session -- next thing to pick up.

**Session 2026-09-03: first attempt at "call walk() concretely on a real AST input" (the plan's own
last-noted next step) -- two real, general, previously-unknown bugs found and fixed; one further real
runtime bug found and precisely characterized, NOT fixed.**

Built a harness first: `scratch-compile-helper.ts` (used throughout this plan's history) only calls the
SYNC, single-file `TStypeCheck` -- it silently gives every import a `T.ANY` value and NO type binding at
all (see `checker.ts`'s `hoist()` `case 'import'` comment: "a fallback... only materializes an own-map
entry"), so it can never really exercise cross-file self-hosting. Wrote `assistant/selfhost-compile.ts`
instead: the real async path (`TStypeCheckAsync` + `ModuleLoader` + `collectModules`), rooted at the
entry file's own real directory (no tmpdir copy) so it can import the REAL `tison/src/examples/TS/*.ts`
files directly. Test entry: `assistant/selfhost-walk-min.ts` -- a local `const field: ClassMember = {type:
'field', key:'x', ...}` (real `ts-parser.ts`'s own `ClassMember` union type, imported by name), to exercise
building a REAL AST-node-shaped value for the first time via cross-module import.

1. **Frozen-literal / physical-storage-widening bug, FIXED.** `addField` threw `''type' needs an
   explicit number/boolean/object type'` building ANY struct for a real AST-node interface at all (every
   one has a literal-string `type` discriminant field per `js-parser.ts`'s own `interface Field<T> { type:
   'field'; ... }` idiom) -- `wasmTypeOf` widens a literal type via `T.widenLiterals` before picking a
   physical kind, but `widenLiterals`'s own `frozen` flag (real `as const` semantics, meant for the
   CHECKER's type reasoning) blocked that widening even when frozen, and a discriminant field built via
   `matchObjectShapeByType`/`ensureAnonObjectShape` reads `frozen` off values the checker had already
   marked that way. **Fix**: `widenLiterals` gained a 3rd param `ignoreFrozen` (default `false`, fully
   additive -- every existing call site, all in checker.ts's own real inference, is unaffected); towasm.ts's
   own 3 physical-representation-computing call sites (`wasmTypeOf`, `ownerFor`, the array-like-element
   lookup in `case 'var_decl'`) now pass `true` -- a frozen and non-frozen `'foo'` need the identical
   physical storage, `frozen` only ever matters for the checker keeping the narrow TYPE around.
2. **`ownerFor`'s union-case only ever handled the nullable-collapse shape, FIXED.** Past bug 1, hit
   `'unknown field 'type''` resolving `field.type` -- `case 'member'`'s own union-dispatch fallback
   (`ensureUnionFieldDispatch`, already built for a real union of struct-backed classes) does
   `t.types.map(ownerFor)` on ts-parser.ts's own `ClassMember = JS.ClassMember<Type> | {index_signature}`
   -- but `JS.ClassMember<Type>` (a re-exported cross-module generic alias) itself resolves to a FURTHER,
   nested union (`Method<Type>|Field<Type>|{static_block}`) that `T.resolve` never expands (confirmed:
   `resolve()` has no `'union'` case in its own switch at all -- by design, every OTHER caller that needs
   recursive union handling, e.g. `typeOf`'s own union-case, does it itself). `ownerFor`'s own `'union'`
   case only ever tried `T.nonNullable` (strip null/undefined down to one member) and returned `undefined`
   for any other multi-member union, so the nested member came back with no owner and the whole dispatch
   set failed. **Fix, general, not `ClassMember`-specific**: new `flattenOwners(t, scope)` -- tries
   `ownerFor(t)` DIRECTLY first (preserving `ownerFor`'s own `t.type==='ref'` fast path, which needs the
   RAW, un-resolved ref to keep a real class's nominal identity -- pre-resolving unconditionally was tried
   first and caused a real regression, see below), and only once that fails does it `T.resolve` and, if
   THAT reveals a further union, recurse into each of ITS members the same way. `case 'member'`'s own
   union-dispatch fallback now calls `flattenOwners` per top-level member instead of a bare `ownerFor`.
   Also added a real `'intersection'` case to `ownerFor`'s own switch (previously totally absent, not even
   commented out like `typeOf`'s own dead one) -- `Method<T> extends CallSig<T>` resolves to a genuine
   intersection, not an `'object'`; flattens+resolves every part via `T.flattenIntersection` (handles a
   still-unresolved-ref part like `CallSig<T>` itself, unlike `mergeIntersection`'s own internal flatten,
   which only unwraps nested intersections, never resolves a ref) then merges via `T.mergeIntersection`
   and routes the flat object through the same `matchObjectShapeByType` fallback the plain `'object'` case
   already uses.
   **Real regression caught and fixed before landing**: a first version of `flattenOwners` called
   `T.resolve` UNCONDITIONALLY before ever trying `ownerFor` -- broke the existing, working `A | B` (two
   real classes) union-dispatch test (`'union field dispatch: a direct...'`, crashed the whole suite runner
   with `unknown field 'value''`), because resolving a real class ref down to its bare structural shape
   BEFORE `ownerFor` sees it bypasses `ownerFor`'s own name-based fast path entirely, landing on
   `matchObjectShapeByType`'s anonymous-shape path instead of the class's own real, already-built struct --
   caught by running the full `test-towasm.ts` suite after the fix (458 tests), not assumed safe. The
   corrected version (try `ownerFor(t)` raw first, only resolve-and-recurse on failure) is a pure
   extension: identical behavior for every case that worked before, only reaches the new code path when the
   old one already returned `undefined`. Full suite re-verified green after the fix (458/458), `test-tison.ts`
   clean, eslint 0 errors (only pre-existing single-use-local warnings).
3. **Found, NOT fixed -- a third, distinct, real runtime bug, precisely characterized.** With both fixes
   above, `selfhost-walk-min.ts` now COMPILES (no more thrown TSWError) but the compiled wasm's `main`
   traps with a bare `unreachable` at runtime -- the `ref.test`/`ref.cast` dispatch cascade
   `ensureUnionFieldDispatch` builds never matches the actual runtime value. Working theory, NOT yet
   confirmed by tracing: the struct type built for the LITERAL construction path (`{type:'field',
   key:'x',...}` assigned to a `ClassMember`-typed local, going through `case 'object'`'s own
   `matchObjectShapeByType`-driven construction) may not be IDENTITY-equal to the struct type
   `flattenOwners`'s OWN, separately-triggered `matchObjectShapeByType` call builds for `Field<Type>`'s
   shape -- if `ensureAnonObjectShape`'s memoization keys on object IDENTITY of the resolved `Type` node
   rather than a structural key, two call sites reaching "the same" shape via different resolution paths
   (through the literal's own contextual target-type resolution vs. through this union-flattening path)
   could get two DIFFERENT `ClassInfo`/struct types for what's semantically one shape -- exactly the kind
   of mismatch that makes every `ref.test` in the cascade fail and fall through to the trap. Not traced
   further this session (would need instrumenting `ensureAnonObjectShape`'s own cache-key computation and
   comparing `typeIndex` between the two paths directly). **Next concrete step for whoever picks this up.**

Scratch harness files kept as real, reusable tools for next time (not deleted): `assistant/
selfhost-compile.ts` (the real multi-file compile+run harness -- prefer this over
`scratch-compile-helper.ts`/`verify-real-file.ts` for anything touching real cross-file imports),
`assistant/selfhost-walk-min.ts` (the minimal repro below, now passing).

**Same session, continued (2026-09-03): bug 3 (the runtime `unreachable` trap) root-caused and FIXED --
four more real, general, previously-unknown bugs, all found chasing the same struct-identity-mismatch
symptom to ground.** `assistant/selfhost-walk-min.ts` now compiles AND runs correctly under real
`WebAssembly.Instance` (`main() => 11`, a `ClassMember`-typed `field`/`method` local each round-tripping
through real union-field-dispatch). Verified via `test-towasm.ts` (458/458), `test-tison.ts`, eslint (0
errors, only pre-existing warnings) after every fix, and again at the end. All four bugs live in
`towasm.ts` only (no `type-utils.ts` changes this round). In the order found:

1. **`ownerFor`'s own `T.widenLiterals(..., ignoreFrozen: true)` call (added last round) widened an
   OBJECT type's own MEMBERS too, corrupting a discriminant field.** `widenLiterals`'s recursive
   `'object'` case widens every property's own declared type -- correct for a VALUE's inferred type
   (real TS: an unannotated `let`/`const` widens), but `ownerFor` was calling it on a resolved TYPE
   (an interface's own declared shape, e.g. `{type:'static_block';body:...}`), where a discriminant
   field's own literal (`'static_block'`) must never be widened at all -- annotations aren't
   "inferred," they're already authoritative. Fixed: `ownerFor` now resolves first and only widens when
   the result ISN'T `'object'` (scalar/array/union/ref cases still widen exactly as before).
2. **The literal-vs-declared-type discriminant tiebreak (in `matchObjectShape`/`matchObjectShapeByType`)
   only ever checked `declType.type === 'literal'`, missing the common union-of-literals case.** A real
   discriminated union with 3+ arms sharing one field (`Method`'s own `type: 'method'|'get'|'set'`)
   never disqualifies a wrong candidate this way -- `declType.type` is `'union'`, not `'literal'`, so
   the old check treated it as "no signal," letting `FunctionExpr`/`Arrow` (coincidentally also
   `{type, body}`-shaped once my earlier optional-tolerant candidate relaxation let more name-matching
   candidates through) survive the tiebreak alongside `static_block`. Fixed: new shared `literalValues(t)`
   helper (a real literal OR a union where every member is a literal -> the set of possible values, else
   `undefined` = no signal) used symmetrically in both functions' tiebreaks (and in
   `matchContextualUnionMember`, which already used its own now-redundant local copy -- deleted, both
   share the one function).
3. **`fieldDeclaredType`'s own name-based fallback (`global.type(cls.name)`) silently returns nothing for
   ANY class built via the generic-interface path, because `cls.name` there is a composite cache key
   (`"Field<Type>"`, `"FunctionExpr<any>"`), never a real, globally-resolvable type name.** This made
   every discriminant tiebreak against such a class see `got=undefined` ("no signal") regardless of the
   class's real declared type -- the tiebreak from bug 2 still couldn't disqualify `FunctionExpr`/`Arrow`
   even once it understood unions-of-literals, because it could never SEE their real `type` field at
   all. Root-caused precisely via direct tracing (not guessed) before fixing. Fixed generally:
   `fieldDeclaredType` now resolves `cls.thisTsType` (the one field every such class already carries its
   own real, resolvable type through -- a `RefType(name, typeArgs)` for a named interface, or the literal
   object type itself for a genuinely anonymous shape) via the shared `resolveObjectType` helper, instead
   of re-deriving anything from `cls.name`.
4. **`cls.thisTsType`'s own `RefType(name, typeArgs)` (built by `ensureObjectShape`) carried no
   `declScope`, so bug 3's fix still failed for any interface NOT visible from the entry module's own
   `global` scope directly (`FunctionExpr` -- self-hosting's whole point is compiling code full of names
   the entry never imports by name itself).** Fixed: stamps the ref with the same `scope` (`declScope ??
   global`) `ensureObjectShape` itself already resolved `name` through, before storing it as `thisTsType`.
5. **The deepest, actually-causal bug: `matchContextualUnionMember`'s own literal-construction path
   discarded a matched member's NOMINAL identity before building it, so a value constructed from a
   literal and the SAME interface's owner resolved via dispatch could land on two DIFFERENT physical
   structs for what's semantically one type.** Its `flatten()` helper only ever kept each member's fully
   RESOLVED, name-stripped object shape (needed for the discriminant tiebreak) -- once a unique match was
   found, it built the class via `matchObjectShapeByType(resolvedShape)` alone, never trying `ownerFor`'s
   own name-based fast path on the RAW, still-nominal type first. This is the EXACT lesson `flattenOwners`
   (dispatch side, landed earlier this session) already had to learn and document -- just never applied
   symmetrically to the construction side. Concretely: whichever side (constructing `method: ClassMember
   = {...}`, or dispatching `x.type` later) happened to reach `Method<Type>` FIRST determined whether it
   got the real, name-keyed struct (`ensureObjectShape`, typeIndex 2) or a merely-structurally-identical
   anonymous one (`ensureAnonObjectShape`, a different typeIndex) -- exactly the mismatch that made every
   `ref.test` in `ensureUnionFieldDispatch`'s cascade fail. Fixed: `flatten()` now keeps each member's own
   RAW type alongside its resolved shape; once a unique match is found, tries `ownerFor(raw)` first (same
   priority order `flattenOwners` already uses), falling back to `matchObjectShapeByType(resolvedShape)`
   only if that fails (the genuinely-anonymous-shape case, e.g. `static_block`, has no name for `ownerFor`
   to succeed on anyway).
6. **Found and fixed in passing, same root shape as #3-4, while chasing the truly last mismatch
   (`Method<Type>` missing `params`/etc after bug 5's fix made both sides finally agree on ONE class):
   `ensureObjectShape`'s own local intersection-flattening (`collectMembers`) silently dropped any
   intersection PART that was still an unresolved ref (`CallSig<T>` itself, before `Method<T> extends
   CallSig<T>` expands) instead of resolving it -- unlike `T.flattenIntersection`'s own `resolveOwn`-based
   version.** `Method<Type>`'s REAL struct (as actually built) had only its own 4 directly-declared fields
   (`type`/`key`/`body`/`modifiers`), silently missing every one CallSig contributes (`params`/`rest`/
   `typeParams`/`returnType`/...) -- never caught before because nothing had ever tried to construct a
   real `Method`-shaped value and then read one of CallSig's own fields back off it. Fixed: `ensureObjectShape`
   now calls the shared `resolveObjectType` helper directly instead of its own weaker, bespoke version.

**Net effect**: `assistant/selfhost-walk-min.ts` (a `ClassMember`-typed union with 4 real interface/anon
members, discriminant-matched construction, `ensureUnionFieldDispatch` reading `.type` back off two of
them) now compiles and runs correctly end to end -- the first real AST-node-shaped value this compiler
has ever constructed AND dispatched on, self-consistently, across two independent resolution paths.

**Session continued, user asked to proceed with `assistant/selfhost-walk-full.ts` (2026-09-03): three
more real bugs found and fixed, chasing the "`null`/`undefined` needs a nullable type" error through
successive layers to the real `walk()` call.** Each fix moved the error forward to a new, distinct one --
verified via `test-towasm.ts` (458/458), `test-tison.ts`, eslint (0 errors) after every fix. `checker.ts`'s
own hunk is committed alone (isolated via a hand-built patch + `git apply --cached`, since concurrent
unrelated WIP -- a new `alwaysReturns` guard-clause narrowing feature -- shares that file); `towasm.ts`'s
changes are entirely mine this round.

1. **`resolveParam` (an ordinary top-level function's own param list -- `walk`'s own `onStatement?:
   OnAST<...>` etc, distinct from the closure-VALUE-type version `closureFuncSigType`/line ~1727 already
   fixed a while back) never gave a bare-optional (no default) param a nullable physical slot.** Calling
   `walk(cls, undefined, undefined, undefined, undefined, callback)` -- explicit `undefined` for every
   optional trailing param, exactly how `walk()`'s own real call sites throughout the codebase use it --
   threw. Fixed: mirrors `closureFuncSigType`'s own exact pattern (`!p.default && hasMod(p,'optional') ?
   nullableWtype(boxed) : boxed`), including its choice to nullable-box even a SCALAR optional param (not
   `addField`'s narrower scalar-exempt version from earlier this session -- a function-call boundary needs
   real "was this omitted" distinguishability the way a struct field's own zero-default doesn't).
2. **A namespace-qualified type ref (`TS.Statement`, from walker.ts's own `import * as TS from
   './ts-parser'`) inside a NESTED closure's own param annotation (`const mapStatementC = (stmt:
   TS.Statement) => ...`, inside `walk`'s body) reached codegen with no `declScope` stamped at all.**
   Root-caused precisely (multiple rounds of targeted tracing, not guessed): the CHECKER's own inference
   for `mapStatementC`'s type (`checker.ts`'s `typeOf`, called from `case 'var_decl'` to learn the
   unannotated const's type) builds a fresh function-type wrapper reusing the arrow's own param nodes
   VERBATIM -- but nothing had ever run a REAL (non-muted) check pass over `walk`'s own body statements at
   all (matching the ALREADY-documented `makeLibScope`-muted-check class of gap, but for an ordinary
   user/library MODULE function this time, not a lib method), so no per-statement stamping mechanism ever
   touched this specific param's own type node. **Fix, general, in the ONE shared entry point every towasm.ts
   consumer of `checkerTypeOf` goes through**: `checker.ts`'s exported `typeOf` now stamps its own RESULT
   with `scope` (the exact scope `e` was inferred under -- provably correct, not a guess) right before
   returning, via `T.stampScope`'s existing "skip if already tagged" no-op-safe mutation. Verified this
   doesn't regress the whole-workspace sweep in any way that matters: `test-ts-parser.ts`'s own GAP/WARNING/
   ERROR counts moved GAP 785->786 (+1, informational "explicitly unsupported" count, not a diagnosed
   defect), WARNING/ERROR both unchanged (300/148) -- not chased down to the exact single file, given ERROR
   count (the real regression signal) stayed flat; flagged here rather than hidden. Also added a matching,
   narrower stamp directly in `emitClosureLiteral` itself (stamps a closure literal's own params/returnType
   with `ctx.scope` right at entry) as a second, redundant safety net for whichever code path reaches a
   closure's own types first -- harmless given `stampScope`'s own idempotence, not proven strictly necessary
   once the checker.ts fix landed, kept as low-risk defense in depth.
3. **`compileFunc`'s own declaring-module-scope recovery (`global.value(name)`, the exact mechanism fix
   \#2 above depends on to root a compiled body's `ctx.scope` at the right module) silently failed for
   ANY generic function instantiation.** `walk<T extends Walkable>` IS generic -- `ensureGenericFunc` calls
   `compileFunc(key, substitutedDecl, homeModule)` where `key` is its OWN mangled per-instantiation cache
   key (`genericKey(...)`), never a real name `global.value()` could find anything under -- so `homeScope`
   was ALWAYS `undefined` for `walk` specifically, falling back to `libGlobal` (no 'TS' namespace visible),
   which is WHY fix \#2 alone didn't reach `walk`'s own body at all until this was ALSO fixed. Root-caused
   via direct tracing (a temporary `name==='walk'` debug check that never fired -- confirming `compileFunc`
   was never even invoked under that literal name). Fixed: new `compileFunc(name, decl, homeModule,
   realName = name)` param, `ensureGenericFunc`'s own call site passes its own real, un-mangled `name`
   explicitly; every other (non-generic) caller is unaffected, `realName` defaults to `name` unchanged.

**Session continued, user proceeded past `"unresolved identifier 'mapStatement'"` (2026-09-03): a real,
substantial new feature (forward-referenced/mutually-recursive local closures) built and landed, plus one
more real dotted-ref resolution gap fixed -- both verified via `test-towasm.ts` (458/458), `test-tison.ts`,
eslint (0 errors) after every change.**

**Forward-cell mechanism, DONE.** Root cause confirmed precisely before designing anything: `mapStatementC`
(`const mapStatementC = (stmt: TS.Statement) => mapStatement(stmt) ...`) references `mapStatement`, a
SIBLING `const` declared several statements LATER in `walk()`'s own body. Real JS/TS allows this (the
reference is only ever actually READ once `mapStatementC` is later CALLED, well after every sibling has
initialized) -- but this compiler's existing closure-capture model **copies the captured name's CURRENT
value into the closure's own env struct AT CREATION time** (confirmed by reading `emitClosureLiteral`'s own
capture-emit code directly, not assumed) -- so capturing a sibling that hasn't been assigned yet would
either throw (no local exists) or, if merely pre-declared, capture a stale/empty snapshot with no way to
receive the real value once the sibling's own var_decl eventually runs. This needed a genuine feature, not a
local patch -- **the user's own steer, mid-investigation, mattered directly**: asked whether missing locals
could be generated "when a closure is being created" rather than via a whole-block pre-scan, which is
exactly the on-demand trigger point landed (`emitClosureLiteral`'s own free-var check, not a separate pass
over the enclosing block).
- **Design**: a forward-referenced name gets a real, shared, mutable **one-field "cell" struct**
  (`ensureCellType`, wrapping `nullableWtype(wt)` so it can start empty) instead of a plain local --
  generated lazily, right where `emitClosureLiteral`'s own free-var loop first needs it (`ensureForwardCell`),
  found via a shallow scan of `ctx.ownBody` (the enclosing function's own top-level statement list, new
  field alongside the already-existing `widenedTypes`/`definePropertyTargets`, same "populated once at
  compile-entry" pattern, added at all 5 real call sites) for a `var_decl` declaring that name -- `ctx.scope`
  itself (towasm's own, incrementally built as statements compile, unlike the checker's) doesn't know about
  a not-yet-reached sibling either, so this can't just ask the checker.
- The closure's own env-capture step (`emitClosureLiteral`) must capture the CELL ITSELF (so a later write
  through it stays visible), never the value it holds right now -- a new `rawWtype`/`emitRawSlot` pair
  (bypassing the ordinary, UNBOXING identifier-read path) handles this; `resolvedWtype` itself now unboxes
  (`cellInner`, a new optional field on `Local`/`ClosureEnv.fields`) for every ORDINARY consumer (an
  identifier read, or `case 'call'`'s bare-callee dispatch, which needs the real closure type to call
  through).
- The sibling's own real var_decl, once reached, must WRITE THROUGH the existing cell rather than shadow it
  with a second, independent local -- found the hard way that the check for an existing cell has to run
  AFTER the initializer compiles, not before: a SELF-referencing case (`mapBindingTarget`, a genuinely
  separate real bug hit immediately after `mapStatementC`/`mapStatement` worked -- `const mapBindingTarget =
  (t) => { ...mapBindingTarget(...)... }`, calling its own not-yet-declared name from inside its own body)
  only creates its own cell WHILE its initializer (the arrow literal) is being compiled, so checking
  beforehand always saw "no cell yet" and threw "redeclared" once the post-hoc declareValue collided with
  the cell `ensureForwardCell` had just created mid-compile. Fixed by compiling the initializer into the
  stack first, THEN checking for a cell, using a scratch local to reorder onto `struct.set`'s own
  ref-then-value stack convention.
- Confirmed via direct testing that `mapStatement`'s own capture now resolves through the shared cell (no
  more "unresolved identifier"), and `mapBindingTarget`'s self-recursive capture compiles cleanly too.

**Real dotted-ref resolution gap, CLOSED.** Immediately after, hit `"function type parameter 'p' needs an
explicit number/boolean/object type"` for `mapTypeParam`'s own `(p: TS.TypeParam) => ...`. Root-caused via
direct tracing (not guessed): `TS.TypeParam` (a namespace-qualified ref, `import * as TS from '...'`)
resolves correctly all the way down to a plain 'object' shape (confirmed: `T.resolve` itself handles the
dotted lookup fine, already fixed for this in an earlier session) -- but `typeOf`'s own post-switch fallback
had `if (t.type === 'ref') { try ensureClass(t.name, ...) } else if (resolved.type === 'object') { try
matchObjectShapeByType(...) }` -- an **`else if`**, mutually exclusive with the first branch. `ensureClass`
only ever resolves a BARE name (`scope.type(name)`'s own lookup never splits on '.'), so it silently fails
for ANY dotted ref regardless of whether the underlying shape is otherwise perfectly resolvable -- and
because it's an `else if`, the structural `matchObjectShapeByType` fallback that WOULD have worked never
even got a chance to run. This is why `mapStatementC`'s own `TS.Statement` "worked" once declScope was
fixed (a `Statement` resolves to a `'union'`, handled inside the switch's own separate `'union'` case, never
reaching this particular fallback at all) while `TS.TypeParam` (resolving directly to a plain object, no
union involved) hit this exact gap. **Fixed**: changed the `else if` to a second, independent `if` -- tried
whenever `ensureClass` didn't succeed, regardless of whether `t` was originally a `ref` at all.

**Next, found but not chased further this session**: past both fixes, `assistant/selfhost-walk-full.ts` now
hits the SAME "needs an explicit number/boolean/object type" throw for a DIFFERENT param, `rest: JS.Rest<T>`
(from `mapSig.rest`'s own arrow) -- this time confirmed (via a temporary "candidates > 1" trace) to be the
ALREADY-DOCUMENTED, pre-existing `matchObjectShapeByType`/`matchObjectShape` landmine from the `a250961`
commit's own note: candidate matching picks a nominal shape by field NAME set alone, never by field TYPE,
and `Rest<T>`'s tiny `{key, typeAnnotation}` shape has no discriminant field at all to disambiguate multiple
same-named-field candidates with -- genuinely ambiguous as currently designed, not a quick fix. This is a
real, separate, larger investigation (field-type-aware candidate matching, or context-driven resolution
threaded from the call site the way `matchContextualUnionMember` already does for a literal expression) --
flagged here rather than guessed at further. A narrower, separate, already-noticed gap from earlier
session still open too: a nested object literal with no `type` discriminant of its own (`{key: 'v'}`, a
bare `Param` inside a `params: [...]` array element) doesn't see `ctx.contextualReturn` narrowed to the
array's own element type at that position.

**Overloaded-value representation, DONE for real (2026-08-28, same session, continued after user discussion)
-- a genuinely general mechanism, not a `Rule`-specific detection.** User pushed back directly on the
narrower fix direction above ("trace through the factory's own return statement to find the real bodied
overload"): *"it seems safer to fully handle overload sets rather than detect if we can avoid them for some
cases."* Confirmed via a short back-and-forth (the user asking "does towasm also need real overload
dispatch?" and "will that always be true?") that the right framing is: a NAMED function-declaration GROUP
genuinely has multiple real bodies and already gets real per-call-site dispatch (`resolveOverload`, used for
constructors) -- but a plain VALUE (like `Rule`) never has a second physical implementation; TS overloads
are always a type-checking-only fiction over ONE real function, confirmed concretely by reading `makeRule`'s
own body in `tison.ts` (a nested `rule` overload group erasing to `(rhs, action?) => {...}`, one real
implementation, one optional trailing param) -- but that specific collapsibility ("differs only by an
optional trailing param") won't always hold for every overload set (a genuinely divergent per-position TYPE
would need boxing-to-`any` instead), so the fix needed to be the GENERAL merge algorithm, not a shortcut
that happens to work for this one case.
**Landed**: `closureSigParts(sig: TS.CallSig)` -- `case 'function'`'s own signature-building (generic
substitution, optional-param nullable-boxing, anon-return-type handling) extracted into a reusable function,
since a `TS.TypeCall` member is exactly `CallSig`-shaped (`TypeCall()`'s own constructor just wraps one with
`{type:'call', ...sig}`). `mergeOverloadSigs` merges N of these (one per overload) into ONE physical
signature, position by position: a param present in EVERY overload keeps its own type (boxed `any` only if
it genuinely varies in kind); one missing from only SOME becomes optional/nullable (the common, `Rule`-
matching shape). Wired into `typeOf`'s own `'object'` case (alongside the pre-existing index-signature/Map
handling), gated on every member being a `'call'` signature, and REQUIRES every overload to individually
resolve or the whole merge is skipped -- an honest fall-through to whatever error already exists, never a
partial or silently-wrong merge (matching this file's own "throws a clear error rather than silently
miscompiling" header philosophy). Verified: full suite green (447 + `test-tison.ts` + both tsc + eslint), zero
regressions. Committed `a7e7da7`.

**Confirmed reached and functioning correctly against the real `Rule` case, but three more separate,
deeper prerequisites surfaced pushing past it -- none attempted, each precisely characterized via direct,
isolated repros:**
1. **Closure PARAMETER coercion, not just covariant RETURN coercion.** `Action<T,C,A>` (tison.ts, `Rule`'s
   own `action` param type) has a generic PARAMETER position too (`values: WithTextPos<A>`), not just a
   generic return -- once merged/boxed, the callback slot's own param becomes `REF_ANY`, but a concrete
   closure literal passed at a real call site (e.g. `(r: number) => r*10`) has a concrete `f64` param, and
   the existing `ensureClosureCoercionWrapper` (session history: "closure covariant-return coercion") only
   ever coerces the RESULT side, never a PARAMETER. Reproduced in isolation (a same-shape minimal repro, a
   generic `action: (r: R) => T` callback param where BOTH `R`/`T` are unconstrained): `internal: cannot
   convert (f64)=>ref:any to (ref:any)=>ref:any`.
2. **`compileFunc`'s cross-module return-type recovery (this session's earlier fix) only ever checks
   `global` (the entry's own scope), never an indirect caller's.** A function called only *indirectly* --
   from within another non-entry module's own code (e.g. `Thing`'s own lazy-global wrapper, itself rooted at
   `lib.ts`'s scope, calling `makeThing()` which is never imported by the entry directly) -- still silently
   defaults to `'void'`. Reproduced in isolation: `internal: cannot convert void to (closure type)`, while
   compiling the calling wrapper itself. Same root shape as the fix already landed, just needs the fallback
   to consult the ACTUAL calling scope, not always `global`.
3. **Entry-level plain `const` with a non-foldable, non-arrow/function initializer is only usable within
   `__toplevel` itself, never from another function.** `__toplevel`'s own direct statement walk compiles such
   a `const` as an ordinary LOCAL inside `__toplevel`'s own stack frame (never promoted to a real wasm
   global, since neither existing seeding branch -- arrow/function promotion, foldable-literal promotion --
   applies) -- so any OTHER function reading that name later hits `unresolved identifier`. Reproduced in
   isolation early in this same investigation (`const result = Add(41); ... return result;` from `main()`).
   Not new territory conceptually (`ensureLazyGlobal`, landed this session, is almost the right shape for
   this too -- an entry-level const could plausibly reuse the exact same mechanism instead of `__toplevel`'s
   own separate, narrower promotion logic), but not attempted.
Given the session's already covered substantial, real ground (7 distinct blockers landed and verified this
session alone) and each of these three is its own separately-scoped problem, none attempted further --
flagged here precisely rather than guessed at, matching this plan's own established discipline throughout.

**Prerequisite #2 (cross-module return-type recovery) SUPERSEDED by a genuinely better fix, the user's own
idea (2026-08-28, same session, continued).** User asked directly: "can we use the new Scope decls to avoid
return-type recovery?" -- traced through together: type-checking `const Thing = makeThing<any>();` (ANY
module's own const declarator, via `hoistVar`'s own `typeOf(d.init, ...)` call) ALREADY has to read
`makeThing`'s own `t.returnType` to know what `Thing` itself infers to -- true for literally any function
ever called anywhere in the real, type-checked program, regardless of which module the call lives in. So
`hoist()`'s lazy accessor's own SETTER now ALSO stamps the inferred value onto the REAL declaration `d`
(`d.returnType = value`, alongside the existing stamp onto the throwaway synthetic clone `t`) -- reachable
via `Scope.decl`, the exact object `functionDeclByName` already holds. This generally supersedes the
narrower `compileFunc` fallback landed earlier this session (which only worked when the entry itself
imported the name directly) -- confirmed SAFE for a generic function too before landing (`t`'s own
`typeParams` already come from `d.typeParams` via `FixSig`, so the inferred type represents the function's
own template-level shape regardless of which caller triggers it first, consistent with what an explicit
annotation on `d` would already mean -- checked precisely, not assumed, given this project's own history of
exactly this class of stamp-order fragility). Verified fixed via the `makeThing`/`Thing` isolated repro
(previously: `internal: cannot convert void to (closure type)`, now compiles past that point entirely).

**Two more real, separate, small bugs found immediately after, chasing the SAME repro further -- both
fixed, both general, neither overload-specific:**
- `emitStmt`'s `case 'function_decl'` compiled every `function_decl` statement unconditionally, including a
  bodyless OVERLOAD SIGNATURE (`hoist()`'s own top-level handling already knows to skip these) -- two or
  more signatures sharing a name each tried declaring their own same-named local, hitting the "redeclared"
  guard meant for real shadowing. Fixed: skip when `!s.body`.
- `emitClosureLiteral`'s free-variable validation treated `undefined`/`NaN`/`Infinity` as ordinary names
  needing local/global resolution, when they're always-valid identifiers `case 'identifier'`/`isNullLiteral`
  already handle directly regardless of lexical scope -- any of the three used inside a NESTED closure
  (`extra !== undefined`, inside `makeRule`'s own real `rule` implementation) threw `unresolved identifier`
  unconditionally before this. Fixed: excluded from the free-var resolvability check.
All three landed together (small, each needed to reach the next), verified: full suite green (447 +
`test-tison.ts` + both tsc + eslint), both earlier confirmed repros (lazy-global, non-entry-class) re-
verified correct under wasmtime. Committed `7fe159e`.

**Investigation continued past this, one more real, general, pre-existing gap found -- NOT fixed, precisely
characterized via direct debug tracing.** Pushing the SAME repro (an overload group differing by a scalar
`extra?: number`, not a callback) further: `comparing to 'null'/'undefined' needs a nullable object-typed
value on the other side`, for `extra !== undefined` INSIDE `thing`'s own real (bodied) implementation.
Root-caused precisely (temporary debug trace, removed before committing): `wtypeOf('extra', ctx)` -- the
CHECKER-based lookup `case '!=='`'s own null-comparison handling uses to decide whether the OTHER side is
nullable -- returns a bare `'f64'`, not a nullable/boxed type, even though the PHYSICAL slot for an optional
param IS correctly nullable (this session's earlier `emitClosureLiteral`/function-type fixes already ensure
that part). **This is a genuine mismatch between the checker's own type for an optional param and its real
physical representation**: this checker apparently tracks "optional" as a separate declaration MODIFIER
(`p.modifiers?.includes('optional')`), never folding it into the param's own TYPE as an implicit `| undefined`
union member the way real TS does -- so `checkerTypeOf`/`wtypeOf` on a bare read of the param name never sees
the nullability at all. **Confirmed general, not overload-specific**: this would affect ANY optional param
compared against `null`/`undefined` inside its own function body, anywhere in the language, not just this
merged-overload scenario -- a real, previously-undiscovered gap, found only because this investigation
pushed a real optional-param body (`makeRule`'s own real `rule` implementation) through the compiler for the
first time. Not attempted -- likely needs `checker.ts`'s own param-type registration (`checkFunctionBody`
or wherever a param's own `scope.addValue` happens) to widen an optional param's registered type with
`| undefined`, matching how a REAL union-typed field's nullability already flows through `typeOf`'s existing
union case correctly. Flagged as the next concrete step in this chain, not guessed at further this session.

## Whole-set survey (2026-09-04) — measured baseline + the 5 causes that gate everything

Built `assistant/selfhost-survey.ts` (non-blocking, whole-set, one worker process per file; needs
process isolation — a single process OOMs re-checking towasm.ts once per declaration). It collects
ALL checker errors instead of aborting on the first, then probes each top-level declaration in
isolation (export just that one, un-export the rest — only exported non-generic top-level functions
are eagerly compiled by TStoWasm), and counts emitted functions minus the always-present
`__toplevel`. Outputs `assistant/selfhost-survey.md` + `.json` + per-file JSON in
`assistant/selfhost-survey/`.

**Measured baseline: 8/224 top-level declarations compile in isolation; 85 more are generic and not
measurable at all without a concrete driver.** All 8 are in tison.ts.

**"walker.ts compiles clean end-to-end" was measuring nothing** — `src/examples/walker.ts` (70 lines,
7 declarations, all generic) emits an EMPTY module (`__toplevel` only, zero user functions), because
towasm is demand-driven and nothing instantiates them. Note there are TWO walkers:
`src/examples/walker.ts` (70 lines, the shared primitives, the one the plan's milestone refers to)
and `src/examples/TS/walker.ts` (650 lines). Don't conflate them.

**Raw cluster counts overcount** — the same module-level declaration fails in every probe of its
file. Deduped: 216 codegen failures → 46 distinct messages, and 5 causes account for ~175:

1. **`WeakMap` is missing from the self-hosted lib entirely** (no `lib/weakmap.ts`, not in `lib.d.ts`)
   — 48 probes across type-utils/checker/towasm/transform. `T.Scope.resolveCache` is a
   `WeakMap<Type,[Type|undefined,Type|undefined]>` field, so EVERY file touching a `Scope` dies.
   Cheapest large sweep available.
2. **No generic-argument inference from constructor arguments** — `new Set(['a','b'])` throws
   `class 'Set' needs 1 explicit type argument(s)`. 46 probes (type-utils 45, tison 1). Real feature.
3+4. **`closureSigParts` (towasm.ts:1780) is ONE choke point for 64 probes across 5 files** — both
   `a function type has an unsupported return type` (:1961) and `function type parameter 'X' needs an
   explicit number/boolean/object type` (:1799) come from it. It lowers function *types* (not
   declarations) and can't handle the shapes these files use. Highest-leverage single site found.
5. **`emitStmt` has no `case 'empty'`** (a stray `;`, `js-parser.ts:1035` produces `{type:'empty'}`)
   — a one-line fix that unblocks 13/13 probed declarations in js-parser.ts.

**Two files are each blocked entirely by exactly one gap**: ts-parser.ts (903 lines, 22/22 probes) by
cause 4; js-parser.ts (1267 lines, 13/13) by cause 5.

**Also confirmed by direct probe, NOT in towasm.ts's own gap list**: a module-level `const` holding
anything but a scalar can't be referenced from any function — `const A=[1,2,3]; function f(){return
A.length}` → `unresolved identifier 'A'`. Same for `new Map(...)`. `ensureLazyGlobal` (towasm.ts:1642)
only fires when the global is *called*, not read as a value. Every target file is built around
module-level tables (towasm 9, wasm.ts 25, js-parser 5).

**Test-suite blind spot**: all 418 `check(` calls in test-towasm.ts compile a self-contained snippet of
exported functions with all state local. Not one has module-level aggregate state — exactly the shape
that dominates the target set. The suite can be fully green and say nothing about it.

**Scope correction**: binary-libs/src/wasm.ts uses 26 distinct `bin.*` entry points, so the whole
`binary` package (~4.7k lines) is a transitive requirement the plan never scoped. Target set is ~27k
lines, not ~22k.

**How to proceed (agreed workflow)**: work the deduped cause list top-down, re-run the survey after
each fix, and treat the table diff as the unit of progress. A fix that moves one row by one is
evidence you fixed a symptom, not a cause — pull the cluster's sibling sites from the JSON first and
require them all to go away. Also fix the member-lookup diagnostic (a missing `Array.flatMap` reports
as `Type '{k,v}' is not callable`, naming the ELEMENT type, because lookup falls through to the
numeric index signature) — that message is actively disguising clusters.
