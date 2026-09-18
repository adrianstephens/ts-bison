---
name: tison-towasm-cross-language-plan
description: "PLAN, nothing built: separating the TS-specific half of the wasm backend out, starting with a 2-file split along TS-specificity. Scope decisions (all four closed), the MEASURED cut (94/6, so cut at the TYPES not the functions), what can relocate into type-utils/checker (~524–616 lines), which TS files have REAL generic cores (printer layout, guard, state machine), and the 4-step route."
metadata:
  type: project
  modified: 2026-09-17
---

Written 2026-09-16 from the tree at that date (towasm.ts 12,410 lines). **No code has been written for
this** — it is a plan.
Read [[tison-session-handoff]] first for where the live work is; this plan must not silently displace
the self-hosting row.

**Scope was cut back on 2026-09-16 (see §3):** the destination is still §2's seam, but the work that is
actually wanted *now* is separating the TS-specific code out, beginning with a two-file split.
§2 is the design; §3 is the scope; §5 is the route. **The axis is TS-specificity; navigation ease is a
hoped-for by-product and must not be allowed to choose the axis.**

## Baseline — verified green 2026-09-16 at `d40a84d` ("presplit")

| gate | result |
|---|---|
| `npm run examples` (`tsc -b src/examples`) | green |
| `test/test-towasm.ts` | all towasm tests passed (915 checks) |
| `bash assistant/difftest.sh` (from the workspace root) | 2182/2191 agree · 0 disagree · 9 unsupported · 0 bad cases |

Working tree at that point: nothing of the user's in `towasm.ts`, so the move starts clean. **Step 1 has
NOT been started.** The one outstanding Step-0 item is a `selfhost-survey.sh` re-run — the existing table
(Sep 15) predates three landed towasm commits and is the instrument that proves a move is MOVED-only
rather than a behaviour change.

# 1. What "cross-language" actually costs — measured, not guessed

`TStoWasm` is `AST → wasm.WasmModule`, and it assumes a *typed* AST. Three separate things couple it
to the TypeScript front end, and only the first is the obvious one:

| seam | size in towasm.ts | PY/CPP supply it today? |
|---|---|---|
| **AST vocabulary** — `switch`es over `expr.type`/`stmt.type` and literal tag tests | **515** literal `.type` comparisons (467 `===`, 48 `!==`); 143 `case` labels, ~76 of them AST tags; **62 distinct tags**; 9 AST switches | **half**: `common.ts` converged the leaf shapes; PY reuses them for expressions, CPP for control flow. Tags still missing on one side or the other. |
| **Semantic type model** — `type-utils` | `T.` referenced **398×**; `type-utils.ts` is 3,498 lines | **no**: no PY/CPP type model at all. CPP has only a *scalar* fold model (`CPP/walker.ts` `Scalar`) and syntax-level declarators. PY has nothing. |
| **Checker protocol** — resolved types + scope/stamp access | `checkerTypeOf` **51** call sites; plus `narrow`, `candidateFits`, `checkBlock`, `checkHoisted`, `isOptionalChainLink`, and *unwritten* stamp reads (`(stmt as any).scope`, `branch.scope`, `scope.decl(n)?.type`) | **no**: there is no PY/CPP checker. Front-end files with no counterpart: `checker.ts` 3,051, `type-utils.ts` 3,498, `transform.ts` 1,374, `module-loader.ts` 417 (+ `js-parser.ts` 1,271, `jsx-parser.ts` 248, `tsw.ts` 274). |

Consequences worth stating plainly, because they set the order of work:

1. **The AST vocabulary is the small half.** Adding the missing tags is bounded, mechanical work.
2. **The type model is the real gate.** Every valuable thing towasm does — struct layout, monomorphization,
   closure signatures, `any`/union dispatch, virtual tables — is type-directed. A language with no semantic
   types has nothing to lower *from*.
3. **The seam is an undocumented protocol, not just a vocabulary.** `ast.scope` must be a checker `Scope`,
   and codegen then *reads checker stamps off AST nodes*. That contract lives only in the two files'
   heads; nothing names it. Writing it down is the cheapest first deliverable and the only way to judge
   whether a second language can satisfy it.
4. **`towasm.ts` is one closure, not a module.** 109 top-level declarations, then a single
   **10,657-line** `TStoWasm` containing **207 nested functions**. They share state by closure
   capture, so *any* partition is a real refactor: helpers cannot move to another file until the shared
   state is an explicit parameter or a class (`FunctionContext`, already 316 lines, is the natural home).

# 2. Three candidate seams

**A. Extend the switches (polyglot `TStoWasm`).** Add PY/CPP case labels to the 9 switches.
*Reject* — the repo's own rule: name/tag special-casing instead of the structural trigger, and every new
language multiplies every one of the 76 AST case labels. It also makes `TStoWasm`'s name a lie.

**B. A `Language<E,S,T>` interface over the AST (grow today's alias layer).** `type Expr = TS.Expr` →
a real object per language. *Reject as the primary seam*: it would be ~300 members (all of `type-utils`'
algebra plus every checker query), and it forces each language to implement *TypeScript's* type system to
answer questions the backend doesn't actually ask. Keep a *small* version of it for tag-level facts.

**C. Two seams, split by impedance — recommended.** Same move the VSDG already made, and the same test
the VSDG's header uses ("is it named in a type position the CORE uses?"):

- a **`TypeOracle`** — facts only, ~15 members, answering exactly what language-free codegen needs:
  primitive kind, struct shape + field list, array element kind, class hierarchy + method table, call
  signature, union members, nullability, literal value, and "what is the declared type of this node".
  The TS implementation *is* today's `T.` + checker; nothing new is invented for TS.
- a **`Wasm IR`** — a small, **target-shaped, fully lowered** statement/expression IR: locals, reads,
  writes, calls already classified (direct / method / closure / imported-runtime), operators already
  resolved to wasm ops, control flow (if / loop / switch / try / suspend boundary), constructions
  (struct / array / closure), coercions (numeric conversion, boxing, to-string), tagged with `ShapeId`s
  into the oracle. Each language writes `AST → IR` **and** `its types → oracle facts`; the language-free
  half writes `IR → wasm` and never sees a source tag, so it can never grow a per-language case.

Why C wins: the per-language obligation becomes "lower your AST to a small IR and answer 15 facts",
not "implement TS's type system"; it matches the proven idiom in this repo; and the boundary is
*checkable* (§5, step 2).

# 3. Scope decisions (2026-09-16), and the measured cut

**The VSDG is out of scope.** The user's model: an independent optimisation pass that may or may not run
before type checking and compilation — *not* a phase the backend consumes. If things happen to converge
later, take advantage of it then; do not design for it. So no relaxed-VSDG option, and §2's IR sits
beside it rather than on it. (For the record, the reasons it is not usable as a backend input today: it is
syntax-preserving *by design* — `passthru`/`verbatim`/`suppressed` give up on a construct and pass it
through opaquely, which a backend cannot tolerate; types are not first-class, the entire type vocabulary
being one optional `typeAnnotation?: T` on `var`; payloads *are* the surface AST; and nothing consumes it —
`towasm.ts` imports it **0 times**.)

**`lib` is per language.** `TS/lib/**` (15 files), `LIB_DIR`/`LIB_FILES`/`LIB_AST`/`LIB_DECLS`/
`LIB_DECL_MAP`/`LIB_AMBIENT_MODULES`/`hostImportsIn`/`makeLibScope` all travel with the TS half. A future
language brings its own stdlib surface over the same wasm-level runtime. This also settles the `LIB_AST`
eager-parse-at-module-load question: it stays where the language is.

**No second backend language is being built now.** The near-term goal is *separating the TS-specific code
out* — **TS-specificity is the first axis to cut along**, settled 2026-09-16 — and splitting `towasm.ts` into
two files is part of doing that. Navigation ease is expected to fall out of it, but it is not the driver and
must not be allowed to choose the axis. §2's `TypeOracle`/IR is the destination, not this pass.

## The measured cut: the TS-vs-neutral axis does NOT give a usable 2-way split

Computed mechanically over all 323 declarations (109 top-level + 214 nested), a declaration counting as
CORE (language-neutral) iff its body names none of `TS.`/`JS.`/`T.`/`checkerTypeOf`/`narrow`/
`candidateFits`/`Type`/`Expr`/`Stmt`/a quoted AST tag:

| | declarations | lines | % of file |
|---|---|---|---|
| **CORE by rule** | ≈110 | **≈705** (855 with the 9 helpers embedded in TS parents) | **5.7%** |
| **TS** | ≈220 | **≈11,705** | **94.3%** |

Four findings that decide the route:

1. **The rule cuts through inseparable clusters, so it is not a cut line.** It puts `toValType` in CORE and
   its only data source `ensureClass` in TS; `emitStringConst` in CORE and its only caller `emitExpr` in TS;
   `emitHolderRead` + `ensureHolderType` in CORE and their only callers in TS. CORE comes out as ~49 tiny
   disjoint blocks, median 6 lines. Nothing resembling "module assembly" is in it: `mod` is created at
   11393 and populated entirely at 12022–12407, all TS by rule.
2. **The drag is the TYPE MODEL, not the functions** — §1's verdict again, now with names. The pivot is
   `FunctionContext` (535; TS by rule, yet taken as a *parameter* by 14 CORE members): count it as TS and
   CORE collapses to ~30 declarations / ~180 lines; split it into a codegen-only part and a TS part and the
   function cut becomes clean. The other drag is the shape of `ClassInfo` (469), then
   `FuncSig`/`ResolvedParam`/`FuncInfo`/`ClosureTypeInfo` (418–426, 498) — mechanically CORE, but every one
   carries `Expr`/`Type`/`ClassInfo` in its *shape* — then 4 rules into the builtin/inline-asm registry
   (`numericOpInline` → `builtins`; `methodSig` → `inlineMethods`; `getterWtype`/`setterWtype` → `typeOf`).
3. **Two facts make the split more favourable than the 94/6 suggests, and both are decisive.** (a) **The
   checker boundary is entirely inside TS declarations** — not one rule-CORE declaration calls
   `checkerTypeOf`/`narrow`/`candidateFits`; the only top-level checker uses are `collectRangeWidenings`
   (1598–1660) and `makeLibScope` (1729), both already TS. (b) **The dependency is one-way, TS → CORE**:
   `mod`, `funcs`, `globals`, `closureLiterals` and `lazyGlobals` are pure TS-side sinks with **0** CORE
   references, and nothing in the core calls back into the front end except through 6 named callbacks.
4. **The state object the split needs is small.** 16 data members (10 mutable: `types`, `typeMap`,
   `nextFunc`, `tags`, `exceptionTagIndex`, `strings`, `data`, `closureTypes`, `classes`, `adoptingDecls`;
   4 read-only) + 6 injected callbacks — because **38 of the 62 locals `TStoWasm` captures are never touched
   by any CORE declaration**. The closure-capture hazard is real but bounded; it is not a reason to avoid
   the split.

**Consequence for the plan:** build the 2-file split by moving the *types* across the line first
(`FunctionContext`, then `ClassInfo`/`FuncSig`/`ResolvedParam`), not by moving the leaf functions the rule
picks out.

## The pivot, resolved: the neutral side is bigger than 6% once the SHAPES are neutral

Reading `FunctionContext` (535–853) and the shared structs (418–533) member by member changes the estimate,
because the taint is a *few fields*, not the substance:

`FunctionContext` splits **≈250 neutral / ≈60 TS**. Neutral: `declared`, `scopeStack`, `slotTypes`,
`freeSlots`, `out`, `ctorThis`, `ctorFields`, `depth`, `breakTargets`, `continueTargets`, `closureEnv`,
`finallyGuards`, `holderNames`, `name`, `homeModule`, and every method (`lookup`, `allocLocal`/`freeLocal`,
`enter`/`exitLabel`, `enter`/`exitBreakTarget`, `enter`/`exitContinueTarget`, `openScope`/`closeScope`/
`inScope`, `temp`, `emitBreak`/`emitContinue` — the last two only touch guards and targets). TS: the three
constructor params (`scope: Scope`, `onReturn: ReturnHandler`, `owner?: ClassInfo`) plus
`contextualReturn`, `stmtScope`/`typeScope`, `selfCall`, `widenedTypes`, `ownBody`, `initializing`.

**The idiom that keeps the neutral side concrete — a base interface plus a language subtype, never a
type parameter.** This is already how the parsers do it (`JS.Statement<T, X>`, `C.Statement<D, X>`):

| shared type | neutral part (the core names only this) | TS part (extra fields on the subtype) |
|---|---|---|
| `ClassInfo` | `name`, `typeIndex`, `fields`/`fieldIndex`, `thisWtype`, `superClass`, `getterNames`/`setterNames`, `funcs` | `decl: TS.Class`, `thisTsType: Type`, `methodDecls: Map<string, MethodMember[]>`, `inlineMethods: Map<string, Builtin<Inline>>`, `declScope`, `homeModule` |
| `FuncSig` / `FuncInfo` / `Inline` / `ClosureTypeInfo` | `params: WasmType[]`, `result`, `hasRest`, `funcIndex`, `typeIndex`, `body`, `reassignsThis` | `defaults: (Expr\|undefined)[]`, `resolvedParams`, `restElem` |
| `ResolvedParam` | `wtype: WasmType` (all `toParams`/`toParams2`/`ensureClosureType` read) | `key: BindingTarget`, `tsType: Type`, `calleeDefault: {value, tsType}` |
| `Local` / `ClosureEnv` / `FinallyGuard` | already fully neutral | — |
| `FunctionContext` | `class FuncCtx` (as above) | `class FunctionContext extends FuncCtx` adds the fields *and* the three constructor params |

Rules this gives the split, and they are checkable: the neutral module may not name a type parameter that
carries a language payload, may not use `any`/`unknown` for a payload, and may not cast. Where neutral code
must *construct* one of these, it calls a factory the language supplies (part of the 6 callbacks), rather
than growing a generic. Where neutral code needs a TS fact, it goes through one of the 6 callbacks.

With the shapes neutral, the **`Core*` set of §3.2 largely comes across too**: `toValType`,
`heapTypeIndexOf`, `ensureHolderType`, `isSubclassOf`, `storageKindOf`, `isPositional`,
`methodSig`, `adoptingDecl`, `getterWtype`/`setterWtype`, `coerceUnionArm`, `numericOpInline`,
`ensureClosureType`, `toParams2`, `moduleFilename`, `resolveDecl`, `needsHolder`, `place` — each either
neutral as written or neutral once one call is a callback. Corrected estimate for the neutral half:
**≈1,500–2,500 lines (~15–20% of the file)**, not 705, and — the part that matters — a boundary that can
actually be *drawn* rather than a sieve.

## Relocation: what can leave `towasm.ts` for the TS files it already has

Measured 2026-09-16 over the candidate declarations, reading each body. **~524 lines move as-is or after a
one-parameter refactor (4.2% of the file); ~616 with the companions and the two borderline cases.**

| destination | lines | what | what the refactor is |
|---|---|---|---|
| `type-utils.ts` | **326** (272 as-is) | the free-variable cluster (`paramNames`/`ownBoundNames`/`collectFreeVars`/`namesSelfAsValue`, **plus** the four companions `assignsToThis`/`collectClosureFreeVars`/`collectCapturedMutables`/`noteAssignExpr`, which cannot be split up) — 98; `isNullLiteral`/`nullLiteralKind`/`TupleT`/`jsLength`/`unwrapAs`/`isPurePath`/`exprMentionsName`/`describeBinding`/`parseTypeExpr`/`substituteClassTypeParam`/`substituteTypeParams`/`genericKey` — 72; `indexSignatureValueType`/`literalValues`/`primitivePart`/`alwaysTruthy`/`backToDeclaredMembers`/`resolveObjectType`/`shapeIdentity` — 102; `restElementTypes`/`arrayPartOf`/`unionShapes` — 54 | thread `scope` where it closed over `global` (3 fns); export the private `T.arrayLikeElement` |
| `checker.ts` | **198** | `collectRangeWidenings` (88), `staticGuard` (26), `narrowedValueTypeOf` (14), `iteratesByProtocol` (11), `narrowedTypeOf` (7), `makeLibScope` (11), `inferTypeArgMap` (41) | take `{scope, stmtScope}` or an injected `typeOf` instead of `ctx: FunctionContext`; `makeLibScope` takes `LIB_AST` as a parameter; `inferTypeArgMap` takes `global` |

**The import graph is the whole constraint, and it is one-directional: `type-utils` imports `TS`, `JS`,
`common`, `walker`, `printer` and does NOT import `checker`; `checker` imports `type-utils`.** So nothing that
calls `checkerTypeOf`/`narrow`/`candidateFits` may go to `type-utils` — it would create a cycle — and that
single test routes all seven checker-bound declarations to `checker.ts`. **This corrects a premise of §1 and
§2:** `TS.`/`JS.` AST nodes and `common` are *not* blockers for `type-utils` (it already imports all three),
and `Scope` is *defined* there. The real blockers are `WasmType`/`wasm.*`/`WAT`, `ClassInfo`/`MethodOwner`,
`FuncSig`/`ResolvedParam`/`Local`, `FunctionContext`, and the codegen registries (`classes`, `types`,
`openShapes`, `moduleBodies`, `adoptingDecls`).

**The rule this gives, and it is the same divider as type-vs-representation:** *a declaration belongs to the
type layer iff its values, its answer and its decisions are TS `Type`s/signatures — no `WasmType`/`ClassInfo`/
`FunctionContext` in its signature or body — and it does not call the checker; anything that **answers with a
representation** (a `WasmType`, a `ClassInfo`, an index, an instruction) is codegen, however type-flavoured
its reasoning.* `wasmTypeOf` reasons purely about TS types yet is unmoveable because its output domain is a
representation. Note the constraint that made this look bigger than it is: the 6 checker-bound candidates
thread `ctx: FunctionContext` and **only ask about narrowed TS types** — they move once `{scope, stmtScope}`
is passed instead of the whole codegen context — whereas `wtypeOf`, `arrayKindOf`, `objectArrayKind`,
`operandInfo`, `ownerOf`, `storageKindOf` thread the same `ctx` *and answer with a representation*, so they
stay. `FunctionContext` drags by exactly three fields (`scope`, `stmtScope`, `contextualReturn`).

**The biggest single find is a duplication, not a relocation: `inferTypeArgMap` (8806, 41 lines) is a
re-implementation of the checker's own inference policy** (`instantiate` at 1563 + `T.Inference`, including
the `expected`/`returnType` contextual step and the deferred contravariant second pass). Moving it to
`checker.ts` is not a move — it deletes the duplicate.

**PRUNED by the file-splitting rule (§6), 2026-09-16 — the table above is a catalogue, not a work list.**
The rule's test is *does separating this have a reason*, and for most of these the honest answer is no:
`collectRangeWidenings` (choosing a local's i32/u32/f64) and the `ownerFor`/`arrayKindOf`-style helpers are
codegen *policy* that consumes type facts — they read like type algebra but belong with the codegen. The same
holds for `staticGuard`/`iteratesByProtocol`/`narrowedTypeOf`/`narrowedValueTypeOf`, which are queries about
codegen's own `stmtScope`. So they stay. **What survives, and why:**

- **`inferTypeArgMap`'s duplication** — the reason is two implementations of one policy, not file size.
  This is a real compiler change (it can change which instantiation a generic call picks), so it wants its
  own session and the full gate set rather than a tidying pass.
- **`makeLibScope`** — a checker *setup* call (`checkBlock`) exported for `tsw.ts`; it takes `LIB_AST` as a
  parameter and moves, with one caller to update.
- The rest of the table is evidence for *why* the neutral cut sits where it does, and should not be acted on
  without a new reason.

**Traps recorded so they are not "fixed" into bugs:**
- `alwaysTruthy` (4279) vs `T.isTruthy` (1964) — the *same question* with deliberately *different answers*,
  because a boxed `any` slot may hold `Stmt | undefined`. Never fold them together.
- `primitivePart`'s `PRIMITIVE_TAGS` (231) is `{string,number,boolean,bigint}` but `T.SIMPLE_TYPES` (33) adds
  `symbol,undefined` — unifying them changes behaviour on `symbol`.
- `elementKindOfType`'s first half duplicates the *private* `T.arrayLikeElement`; `literalValues` overlaps
  the private `constituents`/`unitOf`; `shapeKey`/`layoutArgKey` are deliberately weaker keys than `T.typeKey`
  (names-only / layout-only) — five key functions over three vocabularies, do not merge.
- `indexSignatureValueType` vs `T.indexSignatureOf`, and `arrayPartOf` vs `T.arrayUnionAsArray`, are
  complementary because codegen needs the **unresolved, as-written** view that `T.resolve` destroys (a `u8`
  tag vs `number`; a tag vs a class name). Not duplicates; the resolution difference is load-bearing.

## Generic cores in the TS files — which are real

A core is real only if a **second user exists**. Measured against PY and CPP:

| candidate | lines | second user | verdict |
|---|---|---|---|
| **`printer` layout skeleton** → `src/examples/layout.ts` | **≈60–80 out of 3 files** | **certain — 2 exist, byte-identical** | **Do it.** `indented` is the same 5 lines in `TS/printer.ts` 171, `PY/printer.ts` 98, `CPP/printer.ts` 113; `withParens`/`poss`/`maybe`/`operator` likewise; the `Options` keys match. Drags nothing (strings + options). Two bonuses: it is the one place to fix the shared-`newline` state leak that made a `DoWhile` arg-order bug cascade into ~14 later failures, and `Printer<K>` already exists at `walker.ts:6` with **zero implementations** — a ready-made contract. Must NOT absorb precedence tables, operator tables or node cases. |
| **`guard<R>(types)`** → `walker.ts` | 5 | **certain — 1 exists, byte-identical** (`CPP/walker.ts:29` vs `TS/walker.ts:11`) | Do it with the above. |
| **`buildStateMachine`** → `src/examples/statemachine.ts` | **≈226** | none today, but PY already parses `await`/`yield`/`yield from`/`is_async` | Worth doing **as separation, not as reuse** (the stated goal). It is genuinely neutral: it builds only its own `StateMachineSegment[]`, never an AST, and its whole AST surface is ~4 facts + `common.bodyOf`/`withBody` + a `walkerB`. `StateMachineToAST` (70 lines, builds a JS AST, **no callers anywhere**) stays behind. |
| diagnostics (`SEVERITY`/`Err`/`Diagnostic`/`makeDiagnostic`) | ≈39 | none | **Only with a second checker** — and it drags the TS printer, since `show()` holds one. |
| `Inference` (`type-utils` 2718–2793) | 76 neutral + ~280 per-language | none | **Blocked, not work.** Best *shape* in `type-utils.ts` — it is a candidate-set bookkeeper with one tag test — but a generic core with one possible user, and §4's PEP-484 route for PY rejects "each language implements TS's type system". |
| `Scope` (`type-utils` 3253–3447) | ≈21 of 195 | none | **Do not extract.** Its storage is generic; every rule it answers is TS's (`globalSpace` script augmentation, `strictNullChecks` inheritance, the 4.4 alias and 4.6 destructured-union narrowing tables), and `toObject()` reconstructs a `TS.TypeMember`. |
| `bindingNames`, `pathKey`, `withScope`/`declScopeOf`/`ownScope` | 5 / 26 / 23 | none | Leave; neutral-*shaped*, so a future front end need not re-derive them. |

Already correct, and the model for what "done" looks like: `stampPos`/`getPos`/`Location` (4 parsers) and
`Dialect.exprKey`/`stmtKey` (3 dialects). Note `vsdg.ts`'s `Dialect.foldable`/`foldValue` already *is* the
neutral constant-folding seam for the four per-language arithmetic models, so there is nothing to extract
there. `transpile.ts` is the inverse case: `makeProcess`/`mapObject`/`mapArray` exist for AST-to-AST
rewriting and its four translators do not use them, but its real duplication (two type-name maps, one
context triple) is too small to justify a framework — leave it.

**One thing nobody owns:** the wasm pseudo-type names are declared three times —
`WASM_PSEUDO_TYPES` (`type-utils` 43), `TYPED_ARRAY_TAGS` (`towasm` 230), and `checker.ts`'s
`stopAtPseudoType` guard (1325), which exists purely so `i32` stays unresolvable-by-name for towasm's
`builtinTypes`. Same 10 names, three sites, and `T.literalTypeOf` already types integer literals as
`RefType('i32')`. Give it one owner as part of Step 2.

## The blocker — RESOLVED 2026-09-16, and the neutral module is now unblocked

Extraction #1 was first attempted as planned — `wasm-codegen.ts` with a thin neutral `ClosureSig` that
`FuncSig` would extend — and **failed**: `WasmType` and `FuncSig` are mutually recursive and `FuncSig`
carried TS types, so a thin payload produced 12 errors across 2 producer sites and 6 readers, two of them
*object literals* constructing the payload.

The user's suggestion fixed it: **`FuncSig` keeps only the language-neutral shape and the language owns the
rest.** Implemented as:

- `ClosureSig { params: WasmType[]; result: WasmType; hasRest? }` — the PHYSICAL shape. `WasmType.closure`
names only this.
- `FuncSig extends ClosureSig` adds `defaults`/`resolvedParams`/`restElem` (TS exprs and TS types).
- `towasm.ts` keeps those **beside** each payload rather than in it: `closureBindings`, a
  `WeakMap<ClosureSig, FuncSig>`, with every closure wtype built by one `closureWtype(sig)` (5 producer
  sites: `typeOf`'s 'function' case, `typeOf`'s all-call-members object case, `emitClosureLiteral` ×2,
  `emitFunctionValue`) and read back through `closureSigOf(w)`, which **throws** on a miss so a payload
  assembled some other way can't masquerade as "no defaults".
- **Keyed by object IDENTITY, not physical shape** — deliberately. `ensureClosureType` already memoizes by
  shape, and `typeOf`'s own comment says two same-shaped signatures legitimately differ in `resolvedParams`
  (`(x?: Stmt) => boolean` vs `(x?: Stmt[]) => boolean`), so a shape-keyed store would answer with the wrong
  one. This is why the store is not simply the existing `ClosureTypeInfo`.

Gates: build clean, test-towasm all green, difftest **2182/2191 · 0 disagree** — identical to baseline.
**`WasmType` + `ClosureSig` + the pure helpers are now self-contained and language-free**, so the neutral
module §3 wanted is available as a pure move: `src/examples/wasm-codegen.ts` can take `WasmScalarI`…`WasmType`,
`ClosureSig`, `TYPED_ARRAY_TAGS`, `ARR_WTYPE`/`REF_*`, `CLOSURE_FIELDS` and the 10 helpers, while
`TS/towasm-codegen.ts` keeps `FuncSig`/`ResolvedParam`/`Global`/`TupleT`/`jsLength` and the semantically
front-end `PRIMITIVE_TAGS`/`READONLY_ALIAS`/`isNullLiteral`/`nullLiteralKind`/`rawElemKind`. Splitting the
import in `towasm.ts` between the two modules is what makes the boundary visible in the module graph.

**Still a prerequisite, still not done:** `emitCallArgs` takes a signature's four parts rather than the
signature, so 11 call sites spell out a sig's fields. That is now only duplication, not a blocker.

**Step 1 COMPLETE 2026-09-16 — the neutral module exists.** `src/examples/wasm-codegen.ts` (166 lines) holds
`WasmScalarI`…`WasmType`, `ClosureSig`, `TYPED_ARRAY_TAGS`, `ARR_WTYPE`/`REF_*`, `CLOSURE_FIELDS` and the 10
helpers — with **no language types in it**, checked by the compiler. `TS/towasm-codegen.ts` (244 → 99 lines)
keeps `FuncSig`/`ResolvedParam`/`Global`/`TupleT`/`jsLength` and the rules about TypeScript's type
*spellings* (`PRIMITIVE_TAGS`, `READONLY_ALIAS`, `isNullLiteral`, `nullLiteralKind`, `rawElemKind`), and
imports `WasmType`/`ClosureSig` from the neutral module — one direction only. `TS/towasm.ts` 12,411 →
12,210. The boundary is now visible in the module graph: towasm.ts has one import from each side.
Gates: build clean, test-towasm green, difftest **2182/2191 · 0 disagree** — identical to baseline.

**Remaining, handed to the user:** the `WT` prefix conversion (`WasmType` → `WT.Type`). A TypeScript
namespace import requires every use to be qualified, so this is **459 reference sites** for the neutral
module plus ~100 for the TS-side one — i.e. a find-and-replace-per-identifier pass in the editor (one
regex per exported name), not something the one-literal-at-a-time edit tools can do efficiently. The names
are unchanged deliberately, so that pass is a clean symbol rename with nothing else moving underneath it.

# 4. Per-language static-subset contract (deferred — needed only when a language is added)

The backend's value is that it is *narrow and loud*. Each front end must state what it accepts, and
refuse the rest rather than guessing:

| language | contract | consequence |
|---|---|---|
| **TS** | already "passed `TStypeCheck`"; contract unchanged | the reference implementation |
| **C++** | declared types (already in the source) + class layout + overload resolution; templates limited to what the oracle models | needs a *resolution* pass, not inference — smaller than TS's job, though ADL/overloads/templates stay hard |
| **Python** | **PEP 484 annotations required** on everything reaching a wasm-visible construct | dynamic typing gives the backend nothing; inference is not the answer, *annotations are the interface*. Unannotated → refuse, never `any` |

That PY row is the load-bearing one: it converts "write a Python type checker" into "read the annotations
and check them", which is what makes PY reachable at all.

# 5. Revised route

**Step 0 — commit the tree, then re-baseline.** Non-negotiable before a 12k-line move: `git status` shows
`src/examples/TS/towasm.ts` **itself** modified, plus ~28 other files, and `assistant/selfhost-survey.md`
(Sep 15) predates HEAD's three landed towasm commits. Commit, then `bash assistant/selfhost-survey.sh` from
the workspace root, and record the table so the move's delta is readable as *MOVED* only.

**Step 1 — the backend's type vocabulary and state shapes: DONE 2026-09-16, landed TS-side.**
`TS/towasm-codegen.ts` (244 lines) now holds `WasmScalar`…`wTypeKey` with their helpers, `FuncSig`/
`FullSig`/`FuncInfo`/`Inline`/`ClosureTypeInfo`/`TupleT`/`CLOSURE_FIELDS`/`jsLength`, and
`Local`/`Global`/`ResolvedParam`/`ClosureEnv`/`FinallyGuard`. `towasm.ts` went 12,411 → **12,186**
lines. It is **not** the neutral module §3 originally proposed — see the blocker above; the type model
is pinned to the TS half by the closure payload. Stayed behind deliberately: `wasmTypeOf` (reads
`builtinTypes`), and `MethodDelegate`/`OperandInfo`/`Builtin`/`MethodOwner`/`ClassInfo`/`ReturnHandler`
(they need `ClassInfo` or `FunctionContext`, a later chunk with the same one-directional-import shape).
Gates: build clean, test-towasm all green, difftest **2182/2191 · 0 disagree** — identical to baseline.

**Step 1b — REVERSED 2026-09-17 (`307aa89`), the user's call.** `towasm-analysis.ts` is folded back into
`towasm.ts`. The split was drawn on "knows nothing about wasm", but the axis that earns a file is
CROSS-LANGUAGE REUSE, and wasm-free is not the same thing: those 12 functions query the TypeScript AST, so
they belong to the TS component. **TS/towasm.ts IS the TS component and is ONE file; `wasm-codegen.ts`
(+`wasm-asm.ts`) is the generic one.** Do not re-propose splitting `towasm.ts` for navigability — size is
not an axis. Historical record of the original move follows.

~~Step 1b — the analysis cluster DONE 2026-09-16.~~ `TS/towasm-analysis.ts` (260 lines) took the 12
name/free-variable functions (`unwrapAs`, `isPurePath`, `exprMentionsName`, `assignsToThis`,
`describeBinding`, `paramNames`, `ownBoundNames`, `collectFreeVars`, `namesSelfAsValue`,
`collectClosureFreeVars`, `collectCapturedMutables`, `noteAssignExpr`) — pure AST queries, no wasm concepts.
They were MOVED with a **named** import, which is why no call site changed: worth remembering as the rule
of thumb, because a namespace import would have cost ~30 qualification edits to save 12 import names.
**It is a PER-LANGUAGE component, not a neutral one** (stated explicitly 2026-09-17, because the phrase "no
wasm concepts" invited the opposite reading): every function answers a question about the TypeScript/JS-parser
AST, so each language's backend needs its own. "No wasm concepts" means it does not belong *inside*
`towasm.ts`, not that it belongs in the examples root.

**`TS/towasm-codegen.ts` was created and then FOLDED BACK the same day — see the rule below.** Its
~99 declarations (the `FuncSig` family, `Local`/`Global`/`ResolvedParam`/`ClosureEnv`/`FinallyGuard`,
`TYPED_ARRAY_TAGS`/`PRIMITIVE_TAGS`/`READONLY_ALIAS`/`isNullLiteral`/`nullLiteralKind`/`rawElemKind`) are
types for ONE consumer, and splitting them from the code that uses them bought nothing.
`TS/towasm.ts` 12,411 → **12,063** (12,411 at session start). Gates: build clean, test-towasm green, difftest
**2182/2191 · 0 disagree** — identical to baseline.

**`towasm-builtins.ts` is DROPPED as a target.** Builtins are anticipated to be language-specific and to live
*in* the language-specific code generation — so by the rule below they stay in `towasm.ts`.
**`wasm-asm.ts` is the component split the plan keeps, and it is the NEUTRAL half that moves.** The earlier
wording here — "a component the per-language half uses" — was ambiguous and was read as "belongs to one
language" (2026-09-17). It meant that each language *uses the single* module: the island is the one channel
every language needs (§6: "every language needs a spelling of it"), so its machinery is the most clearly
*shared* component in the backend, and only its spelling is per-language.

**The test for a component's axis, settled 2026-09-17** (the same test as for the whole file): a component is
neutral iff it only ever manipulates neutral representations (WAT/wasm instructions) and *asks* the language
for every source-language type question, through a host. What stays per-language is the spelling (`__asm`
recognition, declared type syntax, what a `TYPEINDEX` names) and the type→representation answers. Applied
here: the asm machinery is neutral (it is `src/examples/wasm-asm.ts`); `towasm-analysis.ts` is NOT (its
answers are about the TS/JS-parser AST — see Step 1b above).

**LANDED 2026-09-17 — the asm machinery is neutral, in the examples root.** `src/examples/wasm-asm.ts` (162
code lines) holds the island: `assertFlatInstrs`, `expandTypeSwitch`, `resolveAsmLocals`,
`resolveTypeExprs`, the three-shape dispatch, and nothing that reasons about a type. It imports only `wasm`,
`wat-parser` and `wasm-codegen`, and nothing from the language half at all — not even types: `Inline` in
`towasm.ts` is structurally the `AsmInline` it returns. `WAT.TYPEINDEX_MACRO` is exported so the
"is this a generic asm" test names the macro structurally rather than copying its spelling.

**The seam is a concrete base interface, never a type parameter** (§3's idiom, and the correction that
matters most). `AsmDecl extends WT.ClosureSig` adds exactly one thing: `typeIndex(text)`. The language lowers
its declared signature and hands over representations; no `Type`, no `TA`, no `unknown`, no callback bag
crosses. A `$T`-switched body needs no signature at all, and `PreparedAsm` distinguishes that case from the
two that do instead of taking an optional argument the caller could get wrong. An earlier cut of this work
was generic over the language's type (`AsmTypes<TA>` + a 6-member adapter) — that is the idiom §3 rules out,
and it was *larger* (280 code lines against 272) as well as forced.

**What is per-language is the SPELLING plus its type answers, and it is back in the single TS module** (§6's
rule: one consumer and no enforcement earns no module — the first cut's `TS/towasm-asm.ts` is deleted). The
`Inline \`__asm\`` section in `towasm.ts` is 110 code lines: `isAsm`/`isAsmMethod` and the call reading
(~25), `asmDeclaredType` (~20, the declared-type lowering), and `declFor` (~45: substitution, the
open-parameter argument override, the `TYPEINDEX` map — all of it about TypeScript's generics), plus the
dispatch (~8). There is no edge back into `towasm.ts` at all.

**The packed-kind rule and the pseudo-type NAMES moved to the neutral vocabulary.** `wasm-codegen.ts` now owns
`PSEUDO_TYPES`/`isPseudoType`/`pseudoValueType` (`i8`/`i16` -> i32, `u8`/`u16` -> u32 — wasm has no
sub-32-bit value types), and `type-utils.ts`'s `WASM_PSEUDO_TYPES` is derived from it, so the plan's
"declared three times" pseudo-type names have one owner. That deleted a hand-written name switch from the TS
half. Three other improvements fell out of the work: the `(I[type] as any)[oper] as WAT.WatInstr` lookup is
now one documented downcast (`object` → `Record<string, Instr | builder>`) and REJECTS a builder entry
instead of pushing a function as an instruction (a late NaN becomes an early "arm doesn't resolve");
`Array(n).fill(t)`, a silent `any[]`, is `Array.from({length: n}, () => t)`; and the `rawElemKind` host
parameter is gone, since the declared-type mapping sits beside it.

**`asmDeclaredType` is now ~20 lines and is NOT a duplicate of `typeOf`/`wasmTypeOf`:** `builtinTypes`
(towasm.ts 774) holds only `i32/i64/f32/f64/u32`, and `T.resolve` deliberately leaves the pseudo-type names
unresolved, so `typeOf(RefType('i8'))` is `undefined` while an asm signature declaring `i8` means `i32` (the
neutral helper above answers that part now). Deleting the rest means teaching the GENERAL mapper the
pseudo-type spellings — a general codegen change, difftest-gated, not part of this axis.

Remaining: the survey's TARGETS now include `wasm-codegen.ts`/`wasm-asm.ts`/`towasm-analysis.ts` (they were
invisible to the work queue, so a declaration moved out of a surveyed file read as progress when it was a
scope change). The remaining downcast's proper fix is a keyed accessor exported beside `I` in `wasm.ts`.

**Step 2 — relocate into the TS files that already exist (§3).** This is the user's insight and it is the
cheapest part of the whole plan, because it needs no new module and no boundary decision: ~326 lines to
`type-utils.ts`, ~198 to `checker.ts`, each behind a one-parameter refactor. Three things to fold in rather
than treat as extras, since they are the same edit: (a) `inferTypeArgMap`'s move deletes a duplicate of the
checker's own inference policy; (b) give the wasm pseudo-type names one owner instead of three; (c) record
the `alwaysTruthy`/`T.isTruthy` and `PRIMITIVE_TAGS`/`SIMPLE_TYPES` traps in the commit message so a later
tidy-up does not "fix" them.

**Step 2 COMPLETE 2026-09-17 — both surviving items, in two commits.** `cd1001f`: `makeLibScope` now
lives in `checker.ts` as `makeLibScope(libAst)`, with `towasm.ts` exporting `LIB_AST`; the `TYPED_ARRAY_TAGS`
duplicate of `WASM_PSEUDO_TYPES` is gone (one owner). The "one caller" estimate was wrong — **24**
(tsw.ts, test-towasm.ts, and 23 gitignored `assistant/` instruments all pass `LIB_AST` now);
`assistant/corpus-ab.sh` also had to be fixed to build its base worktree, or its base run always died on the
gitignored `dist/`. `64dab09`: `instantiate`'s map-building core is the exported `inferTypeArgMap` in
`checker.ts`, and `towasm.ts`'s `inferCallTypeArgs` adapts codegen's arguments to it — the duplicate and its
already-drifted contextual step are deleted. Gates identical throughout: difftest 2182/2191 · 0 disagree;
corpus-ab all buckets +0; self-host survey 103/324, no regressions, the two moved functions now probeable.

**Step 3 — extract the three real generic cores (§3).** `src/examples/layout.ts` (the printer skeleton,
≈60–80 lines out of three files, plus `Printer<K>` finally given an implementation), `guard<R>` into
`walker.ts`, and `buildStateMachine` into `src/examples/statemachine.ts`. These are independent of towasm and
can land in any order; they are the only extractions with a *proven* second user. Leave `Inference`, `Scope`
and the diagnostics apparatus alone — each has exactly one possible user today, and a core with one user is
not a core.

**The boundary is enforced by imports, not by a lint rule** (true of every step here; stated once). No custom
eslint rule is needed: a neutral module imports only `common.ts`/`wasm-codegen.ts`/`wasm`/`wat-parser` and its
own submodules, and the language module imports *it*, never the reverse. That makes the separation a property
of the module graph, checked by the compiler, with no judgement to drift. The one rule to write down (in the
neutral module's header) is the §3 divider: **ask about types freely; answering with a representation is
codegen.**

**Step 4 — neutralise the shared SHAPES (the pivot, now specified in §3).** In order:

1. `Local`/`ClosureEnv`/`FinallyGuard` are already neutral — move them with the first extraction.
2. Split `FuncSig`/`FuncInfo`/`Inline`/`ClosureTypeInfo`/`MethodDelegate`/`OperandInfo`/`ResolvedParam` into
a neutral base + a TS subtype carrying `defaults`/`resolvedParams`/`restElem`/`key`/`tsType`/`calleeDefault`.
3. Split `ClassInfo` the same way (§3's table), keeping the method table (`funcs`) on the neutral side and
`decl`/`thisTsType`/`methodDecls`/`inlineMethods`/`declScope`/`homeModule` on the TS side, keyed by the same
class key.
4. Split `FunctionContext` into `class FuncCtx` (neutral, ≈250 lines: the whole local/slot/scope/label
machinery) + `class FunctionContext extends FuncCtx` (TS, ≈60 lines: `scope`, `onReturn`, `owner`,
`contextualReturn`, `stmtScope`/`typeScope`, `selfCall`, `widenedTypes`, `ownBody`, `initializing`).
Typing the neutral members' parameter as `ctx: FuncCtx` is what *enforces* the boundary — a neutral member
that reaches for a TS field stops compiling.

Do this **before** moving any function body: it is what converts the sieve of §3 into a line.

**Step 5 — REJECTED 2026-09-17 by the user: "I also don't want TSEmitter".** The `TStoWasm`-body-to-class
conversion is not going to happen, so every "blocked until Step 5" note elsewhere means "not happening",
not "later" — including the ~128 functions the hoist survey leaves blocked on `typeOf`/`emitAs`/`coerceTop`/
`owner*`/`ensure*`, and splitting `emitExpr` (1,630 lines) or `emitStmt` (654). They stay inside the closure.
The neutral layer is what it is now.

**The user's reason, and it refutes the paragraph below directly:** the `TSEmitter` subclass would have been
~90% of towasm.ts, so the split buys nothing. Step 5's own estimate agrees — **1,500–2,500 neutral against
10,000+ TS** — it just read that as "the lopsidedness is the point". It is not: a 90/10 cut leaves you two
files, the big one still unnavigable and the small one no more reusable than a module would have been.

**And the outcome was reached WITHOUT the class conversion.** `wasm-codegen.ts` (837) + `wasm-asm.ts` (227)
is ~1,064 neutral lines today, harvested as plain functions and as methods on `FunctionContext`/`Types`/
`ClassInfo`/`DataSection`/`TagSection` — already most of the 1,500–2,500 the base class was supposed to
yield. So the class conversion was never what produced the neutral layer; it would only have relabelled the
TS residue. Do not revive it on the argument that it "unlocks" the neutral half.

Note this rejects the SPLIT, not methods: moving an individual function onto `FunctionContext`, `Types` or
`ClassInfo` when it is genuinely neutral is exactly what has been happening and stays right.

Original text follows for the reasoning only.

~~Step 5 — the real 2-way split.~~ Convert `TStoWasm`'s body to a class — base = module-level state + the
emission algorithm, subclass = TS dispatch and type lowering — which is exactly the `Emitter`/`TSEmitter`
shape the VSDG already proved, with §3.4's 16-member context as the base's state. Expect roughly
**1,500–2,500 neutral / 10,000+ TS**: honest two files, and deliberately *not* two equal halves — the axis is
TS-specificity, so the lopsidedness is the point rather than a defect. Navigation benefit should be treated
as a hoped-for side effect, per the axis decision in §3.

**Step 6+ — the seam proper, only if a second language is still wanted:** §2's `TypeOracle`, then the IR,
then one vertical slice plus a cross-language differential instrument modelled on `difftest.sh`.

**Step numbering fixed 2026-09-17:** Steps 3 and 4 each appeared twice (the generic-core extraction and the
shape neutralisation were both "Step 3"; the imports rule and the 2-way split were both "Step 4"). The order
above is the intended one: 3 (independent extractions) → 4 (neutral shapes, the pivot) → 5 (the split, whose
enforcement is the imports rule) → 6+ (the seam).

# 6. Refuse these (they are the workarounds this plan exists to avoid)

**The file-splitting rule (settled 2026-09-16 by the user), which governs every step here:**
**don't split files without a reason.** A module earns its existence either by having (or anticipating)
**more than one consumer**, or by **enforcing** something that would otherwise be a convention. So:

- **TS-specific types and TS-specific code generation stay in the same file.** They are firmly tied
  together; a vocabulary bucket whose only consumer is the file next door is indirection, and was folded
  back (`towasm-codegen.ts`, created and removed the same day).
- **`src/examples/wasm-codegen.ts` stays**, because it is not a bucket *for* `towasm.ts` — it is the
  language-neutral vocabulary, expected to serve the common code generation *and* each per-language one,
  and it enforces that nothing in it names a language type (the compiler rejects it).
- **Builtins stay in the language's code generation** (anticipated to be language-specific).
- A cohesive *component* is the subtler case: the reason to separate it is that it is a component other parts
  use, not that it is small — and **the axis for a component is the same as for the whole file** (§5's test,
  settled 2026-09-17). The asm machinery is neutral, so it is ONE module in the examples root that each
  language uses; the AST analysis is per-language, so it stays in `TS/`. "Every language uses it" and "every
  language owns a copy" are opposite conclusions from the same fact, which is exactly the ambiguity that put
  `towasm-asm.ts` in `TS/` for a day.

- Adding PY/CPP case labels to the existing 9 switches (option A).
- An unmodeled construct silently lowered as `any`/default instead of refused.
- A per-language name special-case anywhere in the language-free half.
- Weakening `test-towasm.ts` output expectations to accommodate a second language — a new language is
  additive; the TS path's bytes must not move.
- Treating the VSDG's `passthru` as the escape hatch for unmodeled constructs in the backend path.
  The principled channel is the existing **inline-asm island** (`__asm`/`$T`, whose body is literally WAT
  text): "I can't model this" is spelled *in the source language*, at the source, visibly — not as an
  opaque node the backend quietly accepts. Every language needs a spelling of it; that is a feature, not a gap.

# 7. Decisions — all four closed

1. ~~Relaxed VSDG, or an IR beside it?~~ **CLOSED (2026-09-16): the VSDG is an unrelated optimisation
   pass.** If convergence happens, take it then.
2. ~~Before or after the current self-hosting row?~~ **CLOSED 2026-09-16 — the structural work lands first,
   in four separately-committed stages (Steps 0–3), then self-hosting resumes.** The reasoning: every later
   row is worked *in this file*, so removing ~1,500 lines and three whole clusters from it makes all of them
   cheaper, while deferring just moves the same cost downstream; the work is now pure and independently
   gated rather than a big-bang, so the usual argument for deferring does not apply; and part of it *is*
   self-hosting work (`inferTypeArgMap`'s move deletes a duplicate of the checker's own inference policy, and
   `checker.ts` is a survey target at 0). The safety comes from Step 0 — commit, re-baseline once, then one
   commit per destination with a re-run, so no row's attribution is ever in doubt. If a self-hosting row must
   interleave, the natural boundary is after Step 1: it is pure extraction with no closure work.
3. ~~Shared `lib`, or per language?~~ **CLOSED: per language.**
4. ~~Is a second backend language the goal?~~ **CLOSED: not now.** The goal at this point is separating the
   TS-specific code out, and splitting the file in two for navigation is part of doing that. §2's
   `TypeOracle`/IR stays on the shelf as the destination; steps 1–4 are worth doing regardless, since they
   are the same work viewed as hygiene instead of as porting.

Related: [[tison-towasm]], [[tison-vsdg-dialects]], [[tison-vsdg-node-type]], [[tison-ast-convergence]],
[[tison-towasm-self-hosting-plan]], [[tison-session-handoff]].
