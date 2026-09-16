---
name: tison-towasm-cross-language-plan
description: "PLAN ONLY (nothing built): how to make the TS→wasm backend drive the PY and CPP front ends. The measured cost, the three candidate seams, the recommended two-seam split, and the staged route with gates."
metadata:
  type: project
  modified: 2026-09-16
---

Written 2026-09-16 from the tree at that date (towasm.ts 12,410 lines). **No code has been written for
this** — it is a plan, and section 7 lists what has to be decided before any of it starts.
Read [[tison-session-handoff]] first for where the live work is; this plan must not silently displace
the self-hosting row.

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

# 3. Why not just use the existing VSDG?

It is the right *shape* of answer and the wrong *artifact*, today:

- **It is syntax-preserving by design.** `passthru`/`verbatim`/`suppressed` exist so a construct the
  dialect can't model is passed through as opaque text. A backend cannot tolerate an opaque node — that is
  precisely the silent-hole failure mode the project rules forbid.
- **Types are not first-class.** The whole type vocabulary is one optional `typeAnnotation?: T` on the
  `var` variant; the core asks the `Dialect` for 12 *syntax* facts and none about types. Codegen needs
  types everywhere.
- **Payloads are the surface AST** (`floating.expr`, `effect.expr`), so "language-neutral" currently means
  "the core doesn't *look inside*", not "the payload is neutral".
- **Nothing consumes it.** VSDG's only output is source text via `BuildProgram → printer`; no file under
  `src/` imports it except the three dialects, and `towasm.ts` imports it **0 times**. So there is no
  product pressure, and changing it is free of users — which cuts both ways: it is also unproven as a
  backend.

What to reuse from it: the **seam discipline** (facts object vs un-interfaced lowering vs reconstruction),
the **entry-point shape** (`BuildVSDG → Optimize → GCM → Build*`, already identical across the three
dialects), the **shape-stamp idiom** (stamp the fact on the node rather than teaching the core to read a
surface shape), and, later, the optimiser. Decision point in §7.

# 4. Per-language static-subset contract (each language needs one, in its own words)

The backend's value is that it is *narrow and loud*. Each front end must state what it accepts, and
refuse the rest rather than guessing:

| language | contract | consequence |
|---|---|---|
| **TS** | already "passed `TStypeCheck`"; contract unchanged | the reference implementation |
| **C++** | declared types (already in the source) + class layout + overload resolution; templates limited to what the oracle models | needs a *resolution* pass, not inference — smaller than TS's job, though ADL/overloads/templates stay hard |
| **Python** | **PEP 484 annotations required** on everything reaching a wasm-visible construct | dynamic typing gives the backend nothing; inference is not the answer, *annotations are the interface*. Unannotated → refuse, never `any` |

That PY row is the load-bearing one: it converts "write a Python type checker" into "read the annotations
and check them", which is what makes PY reachable at all.

# 5. Staged route (every step gated, TS keeps working throughout)

**Step 1 — write the contract down. No code.** `tison/memory/towasm_seam_contract.md`: (a) the implicit
checker→towasm stamp protocol, (b) the 62-tag vocabulary with a per-language "shared / TS-only / PY-only /
CPP-only" column, (c) the list of type facts codegen actually reads. Plus a `grep`-based count script so
the seam's size is *measurable over time* instead of felt. Zero risk, no behaviour change, no survey
impact. This is the deliverable that turns the question into a number.

**Step 2 — make the boundary a checkable invariant.** Declare `TypeOracle` and the IR types, used by
nothing yet, and add an eslint rule (the custom-rule hook already exists: root `eslint-custom.mjs`, loaded
by `tison/eslint.config.mjs`) forbidding the language-free files from referencing `TS.`/`JS.`/`T.`/`checker`.
Convergence then cannot drift, and the refactor is driven by errors rather than by memory.

**Step 3 — hoist the dispatch, TS only, behaviour-identical.** Give the 9 switches one home per language
(`lowerStatement`/`lowerExpression`/`lowerType`), moving the *bodies* unchanged and leaving the helpers
they call shared. This is the split the VSDG made, and it is also a *structured answer* to the open
"splitting towasm.ts into modules" question in the handoff — split by impedance, not by size.
Gate: `npm run examples` then the full `test-towasm.ts` suite + `difftest.sh` byte-identical, and a survey
re-baseline (`selfhost-survey.sh` reports declarations MOVED, which is exactly this delta).
Caveat: towasm.ts is a survey target, so **never leave an A/B toggle in it** (established trap); do this as
a pure move.

**Step 4 — flip the type access to the oracle.** Re-express `wtypeOf`/`resolveObjectType`/`ownerFor`/
`closureSigParts` against `TypeOracle`, with the TS oracle backed by today's `T.` + checker. This is where
the real design work is, and it is independently valuable: it makes towasm's type dependence explicit,
enumerable and testable for the first time.
Gate: `test-towasm.ts` + the wasm type-key coverage; watch `anyleak-probe.sh` — the temptation here is to
answer `any` for a fact the language can't supply, which is the silent-modeling-gap failure.

**Step 5 — one vertical slice in a second language.** Not "C++ support" — one program, all the way to
*instantiated* wasm. Pick the cheapest witness: a C function of arithmetic and a loop, or an
annotation-only Python equivalent. Deliverable: a `tsw`-style driver for that language plus a
**cross-language differential instrument** modelled on `difftest.sh`: compile the same semantics written in
two languages and compare *runtime results*, not text.
Gate: the new instrument green, TS suite unchanged.

**Step 6 — parity survey.** Generalise `selfhost-survey.sh` into a per-construct `construct × language`
support table, so "add C++ classes" is a row with a number, not a vibe. Instruments must not reward
silence: a construct that lowers by emitting `any` must not count as supported.

Only after step 5 should classes/methods/generics/exception handling be attempted per language — they are
each a row of that table.

# 6. Refuse these (they are the workarounds this plan exists to avoid)

- Adding PY/CPP case labels to the existing 9 switches (option A).
- An unmodeled construct silently lowered as `any`/default instead of refused.
- A per-language name special-case anywhere in the language-free half.
- Weakening `test-towasm.ts` output expectations to accommodate a second language — a new language is
  additive; the TS path's bytes must not move.
- Treating the VSDG's `passthru` as the escape hatch for unmodeled constructs in the backend path.
  The principled channel is the existing **inline-asm island** (`__asm`/`$T`, whose body is literally WAT
  text): "I can't model this" is spelled *in the source language*, at the source, visibly — not as an
  opaque node the backend quietly accepts. Every language needs a spelling of it; that is a feature, not a gap.

# 7. Decisions needed before step 3

1. **Does the backend IR become a relaxed VSDG, or sit below it?** Relaxed-VSDG shares the optimiser and
   GCM; a separate IR keeps the source-to-source path untouched. Recommend deciding *after* step 4, when
   the oracle's shape is known — but before step 5, because the IR is what languages lower into.
2. **Does the seam land before or after the current self-hosting row?** Step 3 rewrites the file the survey
   measures. Recommend: land the current row, then step 3 as one pure move with a re-baseline.
3. **Is the `lib/` layer (TS/lib/*.ts, 15 files) shared or re-specified per language?** It is currently
   TS source that towasm compiles, so a C++ or Python program would need its own stdlib surface over the
   same wasm-level runtime. This is a scope decision, not a detail.
4. **Is a second backend language actually the goal**, or is the goal "no TS-specific assumptions in the
   backend" (self-hosting pressure) with PY/CPP merely the *test* that the seam is real? Step 2–4 deliver
   the second reading; step 5–6 the first. The plan is the same either way up to step 4.

Related: [[tison-towasm]], [[tison-vsdg-dialects]], [[tison-vsdg-node-type]], [[tison-ast-convergence]],
[[tison-towasm-self-hosting-plan]], [[tison-session-handoff]].
