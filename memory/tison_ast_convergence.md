---
name: tison-ast-convergence
description: tison examples/ — the three parser ASTs (js/ts, py, c/cpp) were converged onto shared node shapes in common.ts; records the two verification traps and why the Statement[] change was dropped
metadata:
  type: project
---

2026-09-03: converged the AST vocabularies of `src/examples/TS/js-parser.ts`, `PY/py-parser.ts` and
`CPP/c-parser.ts`+`cpp-parser.ts` onto generic shapes declared once in `src/examples/common.ts`
(Call/Member/Index/Conditional/Spread/Sequence/Handler/Try + ExprStmt/Return/Throw, each generic in
its expression type; parsers alias or `extends` them). Also uniform `pos` stamping via
`common.stampPos`, and `bodyOf`/`withBody` accessors. See [[tison-project]].

**Two verification traps, both bit during this work:**

1. **tison's `Rule` typing does NOT excess-property-check an action's result.** Renaming an AST
   field and its interface produces *zero* tsc errors at the grammar rules that still build the old
   field name — the parser silently keeps emitting the stale key while consumers read the new one.
   Caught only by a parse→print→parse round-trip. For ANY AST field rename here, tsc is not
   sufficient; round-trip every renamed construct.

2. **`test-ts-parser.ts` ends with `testDir(path.join(__dirname,'../..'), '.ts')`** — it type-checks
   every `.ts` file in the whole `packages/` workspace, *including files you are editing* (it does
   skip `assistant/`, `hidden/`, `node_modules/` and dotfiles). It goes through `testAsync`, which
   uses a **ModuleLoader** — so it checks across the module graph. A standalone
   `TStypeCheck(prog, T.makeGlobal())` probe will NOT reproduce its counts; to attribute a delta you
   need `TStypeCheckAsync(prog, loader, lib)` per file, A/B'd against a `git worktree` at the old
   commit. Its
   `GAP:`/`WARNING:`/`ERROR:` totals therefore move with your own source and are NOT a regression
   metric mid-refactor. The stable signals are: tsc error count, each suite's pass/fail, `ERROR`/
   `WARNING` (GAP = "checker doesn't implement this yet"), and test-cpp-parser's failed-file count
   (744 pre-existing at the time).

**Deliberately NOT done — control-flow bodies as `Statement[]`.** Proposed, approved, then dropped
after seeing the real code. js/c put ONE statement in an if/while/for slot (a `block` when braced);
py uses an array. Converting js/c to arrays would touch ~330 sites in towasm/vsdg/checker AND
destroy the braced/un-braced distinction `tocode`'s `dependentCode` reads — to buy uniformity only
in the control-flow skeleton, a small fraction of towasm. `bodyOf`/`withBody` give a shared pass the
same read/write uniformity with no AST change. Same views-not-representations move as
`declaratorName`. If this is ever revisited, the bracing fidelity needs a `braced?` hint on the
nodes or every un-braced body re-prints with braces (large expected-output churn in
test-vsdg/test-towasm).

**js-parser's `X` seam (2026-09-03, later the same day):** `JS.Statement<T, X = never>` — same idiom
as c-parser's `Statement<D, X>` — with `TS.Statement = JS.Statement<Type, Declaration>`. Before it,
every TS consumer holding the wider `TS.Statement` had to cast to build a block/if/loop
(`as JS.Statement<any>[]`); statement-typed casts went 38 → 12, vsdg 22 → 2. Deliberate residual:
bodies reached through `Declaration<T>` (function_decl/method bodies) stay narrow, because threading
`X` further would drag it through `Expr<T>` (a function EXPRESSION is an expression). `common.Block<S>`
is generic in the STATEMENT type, not a dialect's annotation type — that genericity is the point.

**`StateMachineToAST` in transform.ts has NO callers anywhere in the repo** — nothing exercises it,
so any change to it must be A/B'd by hand against the previous version (casts erase under
`ts-node --transpile-only`, so an old copy of the file runs fine against a new parser).

**Body slots: why they stay per-language (settled 2026-09-03, after exploring and rejecting two
alternatives).** `if`/`while`/`for` bodies are ONE statement in js/c-parser (a `Block` when the
source delimited it) and a statement LIST in py-parser. Do NOT try to make them the same
representation:

* Braces are **semantically significant in JS/C** — `if (x) { let y = 1; }` creates a scope and
  `if (x) let y = 1;` is illegal, so the un-braced form is not universal and the block node must
  exist. It carries the scope, not the punctuation.
* Braces are **NOT semantically significant in Python** — there is no block scope; `if x: y = 1`
  and the indented form are identical, and the indented form is universal. Discarding which form the
  source used loses only formatting. (py-parser does discard it; that is correct, not a gap.)
* Therefore a `braced?: boolean` flag is wrong on both sides: meaningless data in Python, duplicated
  structure in JS/C. An "always wrap in Block" scheme needs that flag, so it's out too.
* Python's inline form can hold MULTIPLE statements (`if x: y = 1; z = 2`), so Python can't adopt
  JS/C's "one statement, maybe a block" slot either.

What WAS missing was a shared *interface*, not a shared representation: `common.If<E, B>` /
`While` / `DoWhile` / `Labeled` take the body slot as a type parameter (`If<Expr, Statement>` for
js/c, `If<Expr, Stmt[]>` for py). One declaration, zero representation change, zero churn.
`bodyOf`/`withBody` read and write any of them.

Measurement worth remembering: switching js-parser's body slots to `Block<S>` produced only **4**
type errors, not the ~330 the `Statement[]` variant would — because a `Block` IS a `Statement` while
an array is not. Don't reuse the array-variant cost estimate to argue about a Block-variant.

Also note `Arrow.body: Expr | Statement[]` (JS) / `Lambda.body: Expr` (PY) / C++ lambda's
statements-only body — arrow/lambda bodies are a DIFFERENT thing that shares the word "body" and
the three languages don't agree; leave them per-language.

**Node-per-concept beats operator-string inspection (2026-09-03).** Two splits, same diagnosis: a
construct that is an EFFECT was encoded as an operator on a computation node, so every consumer
peeled it back out.

* `await` was a `Unary` operator (one grammar production covered all prefix ops). Now
  `Common.Await<E>`; `Common.Yield<E>` too, and py-parser's `value` field renamed to `operand`.
* Assignment was a `Binary` whose operator ended in `=`. Now `Common.Assign<E, O>` with the BASE
  operator stored (`+=` -> `operator: '+'`), and `binaryOps` no longer contains `assignOps` at all,
  so a Binary CANNOT be an assignment.

The assignment one fixed a live silent miscompilation: three hand-rolled `ASSIGN_OPS` sets (towasm,
vsdg, tocode's `endsWith('=')` heuristic) had drifted from the grammar's own `AssignableOps`, and
vsdg's was missing `&&=`/`||=`/`**=`, so `x &&= 2` was treated as pure and OPTIMISED AWAY. Lesson:
knowledge *derived* from the AST (which ops mean what) must be single-sourced or given a tag; the
shapes being converged doesn't help if the classification is re-typed by hand in each consumer.

**LIVE BUG, deliberately not fixed:** `TS/tocode.ts` `exprPrecedence`'s binary case reads
`BINARY_PREC[op] ?? op.endsWith('=') ? 2 : 0` — `??` binds tighter than `?:`, so EVERY operator with
a precedence entry reports 2 instead of its own precedence, over-parenthesising output
(`(i % 2) === 0`). test-vsdg's expected strings encode the buggy output, so fixing it churns them.
Commented in place.

**Refinement to the GAP/WARNING/ERROR caveat:** those counters type-check tison's own source with
tison's own checker, so DELETING code lowers them. A drop is not necessarily an improvement — diff
the message TEXT (line numbers shift and make a line-keyed diff useless), e.g.
`... | grep -E '^  [0-9]+:[0-9]+ - ' | sed 's/^[0-9]*:[0-9]* - //' | sort | uniq -c`.

**Gate used:** `tison/assistant/ast-gate.sh` (gitignored) — tsc for src/examples and test/, then
js/ts/py/c parser suites, towasm, vsdg, and the cpp corpus count.

**Known pre-existing gaps found while probing, all unrelated and left alone:** plain `c-parser` has
no zero-argument *call* rule (`f()` as an expression doesn't parse; only cpp-parser adds it);
`CPP/tocode.ts` has no case for cpp's `decl_condition` (`if (int v = x)`); `catch (...)` isn't in the
C++ grammar; tison's own TS parser can't parse `Rules<Alias[] | '*'>` in `py-parser.ts`.
