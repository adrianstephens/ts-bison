## Rename ledger — old names in older memories

Rename freely; **do not rewrite the historical changelogs**, just add a line here. Older entries (and commit
titles) keep the old name, and this resolves them. `assistant/memory-refs.ts` lists names in `memory/` that
no longer exist in the tree — run it after a rename and fix what is LIVE; historical mentions stay.

| was | is now | when |
|---|---|---|
| `TS/towasm.ts` | `TS/backend.ts` | `ed2d662` |
| `TS/towasm-analysis.ts` | folded into `TS/backend.ts` | `307aa89` |
| `TS/towasm-types.ts`, `TS/towasm-asm.ts`, `tocode.ts` | folded away / renamed (`tocode.ts` → `printer.ts`) | earlier |
| `wasm-types.ts` | `wasm-codegen.ts` | `a69d68a` |
| `wasm-asm.ts` | folded into `wasm-codegen.ts` | `deb2d18` |
| `TSWError` → `WasmError` | `W.Error` (the module is imported as `W`) | `efe46bd`, then the user's pass |
| `WasmScalar`/`WasmType`/`WasmElementI` | `Scalar`/`Type`/`ElementI` | the user's pass |
| `ARR_WTYPE` | `ARRAY` | the user's pass |
| `wasmTypeEq`, `wasmTypeKey`, `intWasmType`, `combineUnionWtypes` | `typeEq`, `typeKey`, `intType`, `combineUnion` | the user's pass |
| `typeofHeapType(tag, types)` | `Types.heapType(tag)` | `b858045` |
| `PRIMITIVE_TAGS` | `T.LITERAL_PRIMITIVES` | type-utils regroup, 2026-09-18 |
| `T.restElementTypes` | `T.elementTypes` (spreads now contribute their element) | type-utils regroup, 2026-09-18 |
| `containsInfer`/`containsThis` | `containsKind(t, kind)` | type-utils regroup, 2026-09-18 |
| backend-only helpers in type-utils (`substituteClassTypeParam` … `arrayPartOf`) | unexported functions in `backend.ts` | type-utils regroup, 2026-09-18 |
| most of `type-utils.ts` | `TS/type-core.ts` (type-utils re-exports it); `arrayMember`/`objectPrototypeMember`/`callablePrototypeMember` → `TS_SEMANTICS` | type-core split, 2026-09-18 |

The module dropped its `wasm`/`Wasm` prefixes throughout: the file is already named `wasm-codegen.ts` and
is imported as `W`, so `W.Type` beats `WT.WasmType`.

## Project rules

- [no name special-casing in backend.ts](feedback_no_name_special_casing.md) — find the structural trigger, never hardcode a method/function name
- [keep the checker stateless](feedback_no_checker_state.md) — prefer untyped AST-node stamping over new checker state
- [don't simplify deps for self-hosting](feedback_no_simplifying_deps_for_selfhosting.md) — hard constructs need a real compiler feature
- [src/examples needs its own tsconfig](feedback_tison_examples_needs_own_tsconfig.md) — RECURRED 2×: always spell out `cd src/examples && tsc -p .`
- [no JSON.stringify on AST/Type](feedback_no_json_stringify_ast.md) — bigints throw; print with `T.typeKey` / `T.exprKey` / `T.stmtKey`
- [no unimplemented-throws tests](feedback_no_unimplemented_throws_tests.md) — `checkThrows` is for permanent enforced behavior only
- [SESSION HANDOFF](tison_session_handoff.md) — **read this at cold start**, before the 2233-line plan: live row state, what's deliberately unfixed, what the user hasn't decided
- [harness portability](tison_harness_portability.md) — for running tison under a DIFFERENT agent harness: cwd, gate order, the acceptance numbers at `ec2a21f`, which instruments gate by EXIT CODE (difftest and vsdg-check do; the survey is a probe to be read), and what does not travel (the transcript)
- [session boundaries](feedback_session_boundaries.md) — when the user asks "continue or start fresh?", recommend; default fresh after a committed fix, always after a compaction
- [two-tier gates](feedback_two_tier_gates.md) — fast gates while iterating, full set once before the commit; measured 10.1 gate runs per commit. **`test-towasm.ts` reads `dist/` — `npm run examples` first**
- [index backend.ts before hunting](feedback_towasm_symbol_index.md) — one-off `grep -n` symbol index; the file was named in 575 separate read/grep calls over 8 sessions
- **Scratch and instruments live in `tison/assistant/`** (2026-09-14, d8f407c; the workspace root is not a project). Older memories write instrument paths as `assistant/…` — read those as `tison/assistant/…`. They are still RUN from the workspace root, where `node_modules` is: `bash tison/assistant/selfhost-survey.sh`. Generated markdown gets `.md`, not `.txt`.
- [cloud-agent deps](tison_cloud_agent_deps.md) — no devDependencies on purpose; a standalone clone needs `npm install --no-save` first

## Semantic conformance (current method)

- [conformance sweeps](tison_conformance_sweeps.md) — **start here for new work**: per-lib-area differential sweeps are the gate now, not the survey; 10 groups, 6 green, remaining divergences listed
- [workaround inventory](tison_workaround_inventory.md) — 2026-09-11 audit: every `any`-fallback/leniency/cast site classified (TS-matching / silent-`any` modeling gap / accepts-bad-code / towasm), each with its proper fix and an order. All fixable
- [corpus error dump](tison_corpus_errdump.md) — per-ERROR corpus A/B; `corpus-ab.sh` totals hide a false-positive-for-true-positive trade

## Engine and parsers

- [tison project](tison_project.md) — **start here**: architecture facts (LALR(1) by default, silent shift-default), forceFork, the grammar-restructuring verification recipe
- [table cache](tison_table_cache.md) — `.tables-cache/*.tables`: binary, no JSON, keyed by grammar-source mtimes + a grammar digest; ts-parser/cpp-parser must list the second module
- [debugging technique](tison_debugging_technique.md) — root-cause wrong-parses via table/state dumps; turning a missing transition into a forkable conflict
- [PEG back end](tison_peg_backend.md) — src/peg.ts over the same GrammarSpec; design limits, and why reusing an LR grammar as a PEG is a real porting job
- [Manual() terminal primitive](tison_manual_terminal_primitive.md) — hand-parsed-island escape hatch + `Parser.parsePrefix()`
- [decorator support](tison_decorator_support.md) — CLOSED: class/member/parameter decorators
- [official TS test suite](tison_official_ts_test_suite.md) — corpus run vs real tsc tests; 2936→1519 threw. **`npm run gate` is the fast pre-commit ratchet.** Harness was silently dead for 79 commits — read the traps
- [AST convergence](tison_ast_convergence.md) — 3 parser ASTs converged onto common.ts shapes
- [py-parser](tison_py_parser.md) — off-side rule done purely in the lexer
- [jsx-parser](tison_jsx_parser.md) — LALR reduce-lookahead leaks + JSX-vs-generic-arrow ambiguity
- [wat-parser exceptions](tison_wat_parser_exceptions.md) — exceptions + multi-value blocktypes, verified vs wasmtime

## TS-to-wasm compiler

- [type-core / Semantics split](tison_type_core_semantics.md) — `type-core.ts` is language-neutral (TS vocabulary), `type-utils.ts` is JS's layer; a root `Scope` carries its language's `Semantics`; Python imports type-core only
- [type vs representation](tison_type_vs_representation.md) — many-to-one and must stay separable; tags name representations, and it is what lets `Node[]`/`Foo[]` share one physical array type
- [array identity — RESOLVED](tison_array_identity.md) — `Array<T>` owns a `RawArray` field; the compiler knows only `RawArray`; the traps hit, the pre-existing bugs found, and why struct merging wasn't built
- [towasm](tison_towasm.md) — **the authoritative gap list is backend.ts's own header comment**; this covers design invariants
- [comment pass tooling](tison_comment_pass_tooling.md) — rewriting backend.ts comments safely: edits anchored to ORIGINAL lines + a printer-based code-identity gate; never analyse the file with a bare `ts.createScanner` (template bug)
- [CROSS-LANGUAGE PLAN](tison_towasm_cross_language_plan.md) — **the plan, plus the file-splitting rule that governs it**: separating the TS-specific half of the wasm backend. MEASURED cut is **94/6**, so cut at the TYPES not the functions; `src/examples/wasm-codegen.ts` (neutral, compiler-enforced) is the deliverable; **don't split without a reason — TS types + TS codegen stay together** (settles builtins / `towasm-types.ts`; **a component's axis is the file's axis** — the asm machinery is neutral (folded into `wasm-codegen.ts` at `deb2d18`), the AST analysis is per-language); the relocation list into `type-utils`/`checker`; the four closed scope decisions. Working tables: `assistant/towasm-split-inventory.md`
- [module records](tison_module_records.md) — a module is `TS.Module` (body+scope+filename), not a bare `Stmt[]`; run all FOUR tsconfigs
- [nested array element kind](tison_nested_array_element_kind.md) — inner arrays keep their DECLARED kind (`objectArrayKind`'s comment lies); `a.push([])` into `number[][]` still traps
- [towasm capabilities](tison_towasm_capabilities.md) — index of closed feature work + the checker fixes whose blast radius exceeded their bug report
- [difftest cross-module cases](tison_difftest_cross_module.md) — `addModule`/`addCross` + `--only`; the only instrument that sees cross-module bugs
- [self-hosting instruments](tison_towasm_self_hosting_plan.md) — `difftest.sh` (differential codegen, green = gate), `selfhost-survey.sh` (now reports declarations MOVED, not just compiled), `corpus-ab.sh` (checker A/B in one command)
- [SELF-HOSTING PLAN](tison_towasm_self_hosting_plan.md) — **current focus**: the goal is towasm compiling its OWN source unmodified (never adapt a surveyed file). Run `tison/assistant/selfhost-survey.sh` from the workspace root, work its cause table. At 2026-09-14: **100/343 compile in isolation, 254 failures from 99 causes**; printer.ts (ex-tocode.ts) COMPLETE, checker.ts and backend.ts still at 0. Earlier, at 2026-09-11 end (59/278): `find` + `Parser<any>` rows closed; next rows object-literal alias (25) / null-literal target (22) / `JSON.parse` in tableCache (20); imported modules are now CHECKED (were only hoisted); survey TARGETS include core.ts. `===` on a boxed `any` was IDENTITY until `ensureAnyStrictEq`. Never survey with an A/B toggle left in a surveyed file (backend.ts is one) The survey was NONDETERMINISTIC before `935a4e1` (import-cycle race) — re-run a probe 3-5x before trusting a delta. Read the MOVED delta and the REGRESSED line, never the flat total
- [checker perf debugging](tison_checker_perf_debugging.md) — `--prof` misled twice; macOS `sample <pid>` was right both times
- [interface inheritance](tison_interface_inheritance.md) — `extends` IS an intersection; last part = most concrete, and all four consumers must read it backwards
- [closure-param causes](tison_closure_param_causes.md) — the survey's `closure parameter 'X'` rows are THREE unrelated blockers, not one; read before working that row
- [unbound type param row](tison_unbound_type_param_row.md) — **RESOLVED**: the ~109-decl `T'367` row was `inferTypeArgs` leaking a generic argument's own type param; fixed with `baseSignature` (TS's `getBaseSignature`). Also the stack-trace technique that found it
- [checker inference](tison_checker_inference.md) — distributive conditionals, contextual callback returns, const contexts, template literal expansion, and probe traps (literal leniency, silent `any` members)
- [nominal class refs](tison_nominal_class_refs.md) — **`resolve` keeps class refs nominal; `resolveMembers` is the opt-out** (4 sites); replaced 8 per-site guards
- [scope stamping](tison_scope_stamping.md) — how checker scopes reach towasm (statement/branch stamps); **don't "fix" `narrowedTypeOf`**; why block-node scopes were measured and declined
- [checker narrowing plan](tison_checker_narrowing_plan.md) — user plans integer/range narrowing in the checker (not started as of 2026-07-31)
- [ReadType resolution](tison_readtype_resolution.md) — OPEN: opt's spurious `_` key; the reverted fix regressed other fields
- [C++ back end](tison_cpp_backend.md) — `CPP/backend.ts` (379 lines) over the neutral `wasm-codegen.ts`; **the neutrality gate**, keep `test-cpp-backend.ts` green. Written without changing one neutral line; found the `emitIf` depth trap and a real tison precedence bug
- [vsdg dialects](tison_vsdg_dialects.md) — **the VSDG is language-neutral now**: `src/examples/vsdg.ts` core + `TS/vsdg.ts` + `PY/vsdg.ts` + `CPP/vsdg.ts`; the verbatim-fallback rule, the shape stamps, and the SIX pre-existing bugs the split surfaced
- [vsdg C++ dialect](tison_vsdg_cpp.md) — the widened top level (`Definition | Stmt`), what's modelled vs verbatim, and the C++-specific bugs/limits found (incl. a shared verbatim-reader bug TS/PY still have)
- [vsdg node type](tison_vsdg_node_type.md) — RawNode & INode discriminated union; gate = `assistant/vsdg-check.sh` (48 TS + 28 PY + 15 CPP cases)

- [object shapes keyed by bare name](tison_shape_key_collision.md) — same-named interfaces in two modules share one struct; qualify by module
---

*`archive/` holds full originals of the four largest memories (~650KB of dated per-fix changelog,
derivable from git), compressed to current-state summaries above on 2026-09-04.*

*Migrated out of the global auto-memory store (`~/.claude/projects/-Volumes-DevSSD-dev-packages/memory/`)
on 2026-09-09 so tison's memories travel with the tison repo.*
- [precedence resolution](tison_precedence_resolution.md) — rule-vs-rule prec, the object-vs-named bug fixed at `87a809b`, and the **OneOf default-shift defect still open** (don't fix it with termOneOf)
