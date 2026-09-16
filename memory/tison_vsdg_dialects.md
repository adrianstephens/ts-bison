---
name: tison-vsdg-dialects
description: "src/examples/vsdg.ts is the language-neutral VSDG core; TS/vsdg.ts and PY/vsdg.ts are per-language dialects. The seam, the shape stamps, the verbatim-fallback rule, and the pre-existing bugs the split surfaced"
metadata:
  type: project
---

2026-09-14: made the VSDG middle end applicable to the Python AST (C++ still to come). Split by
**impedance, not size** — one file per language plus the core:

| file | lines | role |
|---|---|---|
| `src/examples/vsdg.ts` | ~2190 | language-neutral: `RawNode`/`INode`, `Scope`/`ScopeMu`, `VSDG`, `buildLoop`, `mergeState`/`reconcileVariables`, `Optimize` (fold/CSE/dead-branch), `BlockTree`, `applyGlobalCodeMotion` + the seam interfaces the core NAMES (`Recurse`/`Dialect`/`Emitter`) |
| `src/examples/TS/vsdg.ts` | ~1305 | `TSDialect`/`TSBuilder`/`TSEmitter` + this language's `BuildVSDG`/`Optimize`/`applyGlobalCodeMotion`/`BuildProgram` |
| `src/examples/PY/vsdg.ts` | ~1020 | the same three classes + the same four entry points, for Python |
| `src/examples/CPP/vsdg.ts` | ~640 | the same three classes + the same four entry points, for C++ -- see [[tison-vsdg-cpp]] (its top level is DEFINITIONS, not statements) |

Generics are `<E, S, T>` (expr, stmt, type annotation, destructuring binding target). A language
supplies THREE objects, **one job each** — the split is by core PHASE, not by language concern,
which is exactly why it reads as confusing at first:

- `Dialect` — **FACTS only**: `identifierName`/`identifier`/`literal`/`isTrueLiteral`/`exprKey`/
  `stmtKey`/`isCSEUnsafe`/`foldable`/`foldValue`/`isCalleeEdge`. No walker, no lowering, no
  reconstruction. It is now passed EXPLICITLY to the free passes (`optimize(graph, dialect)`,
  `optimizeStructuralCSE(graph, dialect, protectedIds)`) instead of being carried by the graph —
  `VSDG` is a plain `Map` again, and `BlockTree`/`RawNode`/`applyGlobalCodeMotion` are non-generic.
- LOWERING — this language's own `walkerB` + `lowerStatement`/`lowerExpression`, and **NO INTERFACE**
  (deleted 2026-09-15). It appeared in no type position the core names, so it only restated the
  language's own walker API. The language wires the callbacks into its walker, drives it from its own
  `BuildVSDG`, and hands the core a `Recurse`. The callbacks are methods on each language's
  `VSDGBuilder` subclass, whose base supplies the primitives they call
  (`makeNode`/`connectEnd`/`rebindVar`/`buildLoop`/`walkBranch`/`mergeState`/`reconcileVariables`/
  `buildFunctionBody`/`lowerVerbatim`). One builder per run — it holds the scopes and the
  expression/name maps.
- `Emitter` — **RECONSTRUCTION**: `rebuildPayload`/`emitNamedSlot`/`rebuildFunctionDecl` plus the
  language's own printer. One instance per `BuildProgram` call, holding its own `names`/
  `nodeVariableNames`. `emitLocalStatements` calls `buildExpr` (NOT `rebuildPayload`) for the
  effect/function-expression slot: a function-expression's payload is the language's own `expr`, which
  `buildExpr` already hands back, so no language needs that case — its absence is why PY printed `None`
  for a lambda (2026-09-16, fixed by the core change). Because the three parsers converge on common.ts,
  the CORE implements every
  constructor whose shape is shared (`makeIf`/`makeWhile`/`makeDoWhile`/`makeReturn`/`makeBreak`/
  `makeContinue`/`makeExpressionStmt`/`makeConditional`/`makeNot`/`isBreakStmt`); a language overrides
  only where its own representation differs (js/c/py body slots, py's deliberately UNSPELLED empty
  `else:`, switch, try, temp decls). `makeBlock` is the adapter turning a statement ARRAY into this
  language's body slot; `undefined` means "no body at all".
  Handing a `Common.If` back as `S` needs ONE assertion (`admit`/`admitExpr`) and cannot avoid it: a
  union is a supertype of its members, but the compiler knows only a type parameter's CONSTRAINT, and
  a constraint is a lower bound, never an upper. `S extends { type: string }` is what lets
  `isBreakStmt` read `stmt.type` with no cast at all.

  Two regressions found while making those constructors concrete (both fixed; recorded so they don't
  come back): `makeBlock` must handle `undefined` (an absent `else`) or every if/while without one
  crashes inside `BuildProgram`; and `Common.DoWhile` takes `(body, test)` -- backwards, it throws
  INSIDE the printer, which leaves the printer's shared indent state elevated and makes ~14 LATER
  cases fail with spurious indentation (a cascade that looks like many unrelated bugs).

**The WALKER belongs to the language's lowering half — not to `Dialect`, and not to the core's
builder**: "how the AST nests" and "what each tag lowers to" are one phase. Two earlier shapes were
wrong and are recorded here so they don't come back — `Dialect.walk(ast, onStmt, onExpr, begin)` (a
`begin` continuation whose only job was to hand the recurse back: the tell that the dialect was doing
the core's job) and then `Dialect.walkerB(onStatement, onExpression)` (correct direction of data,
wrong owner — it put a lowering concern on the facts object). FINAL SHAPE: `VSDGBuilder` has **no
abstract members at all**; and `run(ast, walker)` takes the
walker as a PARAMETER — which is what lets the base stay fully concrete. `BuildVSDG` is therefore
`const builder = new TSBuilder(); builder.walkerB().statements(ast); return builder.finish();` — the
walker is never stored on the builder at all: the primitives that need it lazily
(`buildLoop`/`buildFunctionBody`/`buildClass`) take it as a parameter, so a builder is built from
nothing but a `Dialect` and never points back at the walker driving it. `run(ast, walker)` is GONE:

**Why the lowering half has NO interface while `Emitter`'s members stay `abstract`** — asked twice; the
second answer deleted the interface. The direction-of-control point stands (`Emitter`'s abstract
members are genuine template-method steps: `emitChain`/`emitControlNode`/`emitLocalStatements` are
CONCRETE algorithms that call `this.makeIf(…)`/`this.rebuildPayload(…)` at fixed points. The lowering
hooks are the OPPOSITE: `lowerStatement` DRIVES `makeNode`/`connectEnd`/`buildLoop` in an order it
chooses, so it is a *client* of the primitives, not a step of an algorithm they run). But direction
alone did not justify a SEAM interface: `Lowering` was named in no type position the core uses -- the
core only ever takes a `Recurse` -- so it was a restatement of each language's own walker API, checked
nowhere that mattered (the handler signatures are already checked where `walkerB()` hands them to
`makeWalkerB`). THE TEST for anything belonging in `vsdg.ts`: is it named in a type position the CORE
uses? `Dialect` ✓ (`optimize`/`foldConstants`/CSE/`VSDGBuilder`/`Emitter`), `Recurse` ✓ (every
primitive), `Emitter` ✓ (the core's own `emit*` call its abstract members), `Lowering` ✗ — deleted.
`abstract` on `VSDGBuilder` is a marker only (don't look for overrides).

`Recurse` is the narrowed walker shape the core and every handler need — and, now that the callbacks
are plain methods, the only place the driver/handler split is written down: `recurse.statement(s)`
DRIVES a subtree by COMPOSING a language's `lowerStatement` with its grammar's descent, so the two are
never the same function. The `OnStatementB`/`OnExpressionB` type aliases are GONE, and so are the
declared handler signatures: `makeWalkerB`'s own `OnASTB` parameter type states the callback shape, and
a language's `walkerB()` is what compiler-checks that its handlers fit.

Terminology, now enforced in the core: "dialect" means the `Dialect` object; the implementation of
all three halves is "the language". See [[tison-vsdg-node-type]] for the node model itself.

**Destructured params are the language's own business** (2026-09-15). `ParamSlot` is
`{ name: string } | { token: unknown, desugar: (tempName: string) => void }`: the core allocates the
hidden temp and its entry port, and the SLOT carries the step that finishes binding it. A closure
rather than a `Dialect` method because finishing a pattern WALKS statements — that is lowering, and
`Dialect` answers facts only (`Dialect.desugarPattern` is deleted). For the same reason the function
node's `destructuredParams` is now `Map<unknown, string>`, keyed by whatever token the language used
(js/ts passes the pattern itself, so its printer can still swap the temp name into the signature).
That removed the core's last real use of `B`: it still appears in every node/scope signature but no
longer means anything, and is waiting to be swept.

**Shape STAMPS are the idiom that keeps the core language-free** (same as the pre-existing
`switchInternal`/`scopeAnchorId`/`capturedRead`): `plainAssign` (a mutation whose port 0 is the
never-read old value — replaces inspecting `expr.type === 'assign'`), `freshTarget` (an lvalue
address that must always rebuild — replaces `member`/index introspection), `suppressed` (see
verbatim fallback). `isVestigialEdge` stays a `RawNode` method with no dialect reference.

**Literal-ness is a dialect FACT, not a stamp** (`isConst`/`constValue`/`isLiteralNode` deleted).
`Dialect.literalValue(e)` is the inverse of `Dialect.literal(value)` — the ONE thing that decides
whether the core may fold/CSE/inline a node — and the core asks it through ONE helper,
`isLiteral(dialect, node)`, a TYPE PREDICATE (`node is NodeOf<E,S,T,'floating'>`). That is what keeps
the tag test written once: a guarded caller reads `node.expr` directly, rather than a second helper
re-testing `node.type` just to reach the payload. The node's own `expr` is therefore the single source
of truth, so the in-place fold can no longer leave a stamp out of sync. Exclusions live in ONE named place per language, with the reason: CPP
answers undefined for `'a'`/`nullptr`/`sizeof(T)`, PY for f-strings (a literal WITH interpolation
holes) and answers its own `imaginary` form. A distinct 'literal' TAG was considered and rejected: it
doesn't remove the information (it relocates it into the variant payload) yet forces the fold to
mutate the discriminant (or rebuild + rewire, breaking the node identity edges/CSE rely on) and adds
a `case 'literal'` to every switch over node types. Invariant: `literalValue(literal(v)) === v`.

**Two core additions C++ folding forced** (2026-09-15). (1) `Dialect.truthy(value)`: the free
`truthy(v) { return !!v }` in `foldDeadBranches` was the core assuming every language's falsiness —
but a value that carries a TYPE is an object, and `!!object` is always true, so `if (0)` would have
collapsed onto the true branch. (2) `Literal.raw` (optional, on the shared interface): a C++ literal's
suffix IS its type (`1u` ≠ `1`), and the printer now prints a source literal's own spelling, which also
fixed suffixed literals round-tripping as plain decimal. A fold's VALUE is opaque to the core
(`unknown` in/out through `literalValue`/`foldValue`/`literal`), which is what lets C++'s typed scalar
travel inside it without the core knowing. Adding the optional second parameter to `Literal(value, raw)`
broke one `Array.map(Literal)` call site in `TS/type-utils.ts` (map's index arrived as `raw`) — fixed
by wrapping it.

**`switch` is SHARED, and that is what keeps it correct** (2026-09-16): `VSDGBuilder.buildSwitch`
(protected) owns the whole cascade -- discriminant wrapper, per-case match flags, the `__hit` flag, the
per-case SCOPE, the state gammas, and the `break_scope` wiring -- and a language supplies only its own
spelling of the scaffolding via `SwitchSyntax<E, S, T>`: `local(value, name)`, `comparison(discName,
test)` (`===` vs `==`), `condition(hit, match, others)`, and `setHit(hit)`. TS's block was ~110 lines
and CPP's ~85; each is now ~15. Each helper's NAME is built at its own `local` call out of the id its
own node is about to get (`makeNode` spells ids tag+counter), borrowed WITHOUT consuming an id; the core
then reads the name back off the returned node and binds it with `bindVar` -- a NEW primitive, not
`rebindVar`, because nothing is being re-bound and the node already carries its name (`rebindVar`'s
name-write was the one part of a declaration's `rebindVar(name, node, true)` that duplicated what
`local` had just done). The number is therefore per-helper, NOT one suffix shared by a switch's three
helpers: `__disc_6`/`__match0_10`/`__hit_13`, each its own node's number (re-pinned in both suites; the
`__disc` numbers were unchanged, only `__match*`/`__hit` moved). It only has to be unique per switch --
the helpers are declared in the switch's ENCLOSING scope, so two switches there would collide on a fixed
name (measured with a two-sibling-switch probe) -- and borrowing the counter rather than using `freshId`
leaves every later node's id alone. `local` must never spell an empty `name` (`name !== undefined` is
what every reader tests, so `''` claims to be a name and prints an unnamed `let`). The three dialects'
own declaration sites (TS var_decl / C++ initDeclarator / PY first-assignment) now use `bindVar(node)`
too -- they were already the same shape (node named at construction, then `rebindVar(name, node, true)`).
`rebindVar`'s `isDeclaration` flag survives for the two sites that need it: PY's walrus (a nameless
`mutation` node) and C++'s assignment-that-declares (`auto x = 1`). Deliberately NOT for TS's `import`
bindings, which create a *never-bound* name on purpose (`bindImport` calls `scope.create` +
`threadMutation` by hand): `bindVar` would set `bound`, and `slotName` would then make the emitter print
a spurious `let x;` for it.
Two reasons it had to be the
core's, both measured rather than assumed: the per-case scope (TS CRASHED on `case 1: let y = 1;` with
the same `undefined.boundName` CPP did -- a declaration in a case otherwise reaches the branch merge),
and the naming scheme (deriving helper names from each node's OWN id instead shifted every pinned
expectation). `SwitchSyntax` is named in a type position the core uses (a `buildSwitch` parameter),
which is the test this file's interfaces have to pass. TS pins both directions of the scope in
`test-vsdg.ts` (`switch: a declaration inside a case is scoped to that case`, and the shadowing one).

**Body slots are `S[]`, not `S`.** The core's `makeIf`/`makeWhile`/`makeDoWhile` take statement
ARRAYS; js/c wrap in `Block` (which is where the braced/un-braced distinction lives) and py needs
the array as-is. Do not reintroduce a `makeBlock` on the core's surface — that would force a fake
block node on Python.

**THE VERBATIM FALLBACK RULE — an unmodelled statement must go through `lowerVerbatim(s, walk)`,
never `process(s)` alone.** `process(s)` lowers a construct's insides but never anchors the
construct, so it VANISHES and its body runs unconditionally; and even anchored, its insides were
scheduled at `block_entry` and printed a second time outside it. `lowerVerbatim` descends (so
bindings the text mentions keep a reader) while stamping everything it creates `suppressed`, then
anchors the statement as one opaque step, restoring `end`/`exited`/`brokeOut` first.
This fixed FOUR live miscompiles that predate the split and existed in the TS path:
`try { g(); } finally { h(); }` → `g(); h();`; `for await (const x of y) { g(x); }` →
`const x; g(x);`; `L: { g(); }` → `g()` printed twice; same for `with`. Behaviour of unmodelled
constructs is now "prints verbatim, exactly once".

**Four more pre-existing core bugs, all surfaced by the PY work:**
- `collectProtectedNodeIds` did `new Set<NodeId>(graph.root)` — a NodeId is a string, so that was a
  set of its CHARACTERS and the root was never protected. Now `[graph.root]`. `foldDeadBranches`
  additionally MOVES `graph.root` to the winning branch's tail when it removes a root gamma
  (refusing to fold it was the alternative; moving keeps the optimisation).
- `buildEffectExpr`'s `case 'unary'` was dead code left over from when `await` was a `Unary`; now
  `case 'await'`, so an await's operand is no longer discarded at print time.
- A consumer that is itself `suppressed` cannot recompute a value inline (`needsTemp` now forces
  materialisation), or `x = 1; assert x > 0` printed `assert x > 0` with `x` undeclared.
- `resolveNode` returns the bare name for a node that is `suppressed` AND `bound` (`slotName(node)`): a name
  rebound inside a verbatim statement is defined only by that statement's text.

Also: `except` gained `handlerTypeNodeId` (a side channel like `switchDiscriminantId`, added to
`collectProtectedNodeIds`) and `makeTry` takes a `{param, type, body}` handler object — js's
`catch (e)` matches nothing, Python's `except E:` must keep E or it degrades to a bare `except:`.
GetNode's `throw "missing node"` became a real `Error` naming the id (a bare string has no stack).

**Diagnosis technique that paid off: the differential probe.** `assistant/probe-vsdg-ts.ts` and
`assistant/probe-vsdg-py.ts` push the SAME shape through both dialects; the verbatim-fallback bugs
only became visible once a Python construct (`with`) hit what TS happened not to test. Keep them.

**Python-specific lowering:** assignment is a statement, so a `mutation` rebuilds via
`rebuildMutationStatement` and a value form only exists as `(x := v)`; the core's `var` tag = "the
declaration of a name" and `mutation` = "rebinds one" — Python spells both the same, so the choice
comes from `scope.get(name) === undefined`, and `declKind` is `'assign'`/`'annotate'` (a bare
`let x;` has no Python form). `for x in it:` has no exit CONDITION (exhaustion raises), so it
becomes a per-loop-sentinel iterator loop (`__miss1 = object(); __it1 = iter(it); while True:
__r1 = next(__it1, __miss1); if __r1 is __miss1: break; ...`) — deliberately NOT a try/except,
because the target would then be bound in only one of the handler's two branches and no merge can
reconcile a one-sided name. `compare` folds via its own `calcCompare` (narrow: mixed-kind operands
are left alone because Python orders them differently from JS, and `1 < 'a'` RAISES). A bare
literal statement is a docstring/directive, not dead arithmetic, so it prints verbatim.

**Deliberate Python gaps** (each prints verbatim, see the rule above): `with`, `del`, `assert`,
`global`/`nonlocal`, loop `else:` clauses, multiple `except` clauses, `try/else`, class bases beyond
the first, decorators, a comprehension's own loop structure, parameter defaults. C++ is not started:
its declarator/type-specifier system has no counterpart in either existing dialect.

**Gate: `tison/assistant/vsdg-check.sh`** — `npm run examples` (see below), tsc on src/examples,
vsdg-only tsc on test/, then `test-vsdg` (50 cases, must stay BYTE-IDENTICAL — they are the TS path's
invariant), `test-vsdg-py` (28) and `test-vsdg-cpp` (41).

**The gate BUILDS FIRST, and must**: ALL the suites import `../dist` (the project-wide convention —
see [[tison-project]]: the suite tests the built package, and `test/tsconfig.json` type-checks against
`dist/**/*.d.ts`; `dist/` is gitignored, `outDir` is `../../dist/examples`). Without a build they
silently test whatever was emitted last, and a green suite then means nothing — it cost a round of "my
fix didn't work" while the probes in `assistant/`, which import `../src`, showed it working. The build
is `tsc -b src/examples`, which emits despite unrelated tsc errors elsewhere (the towasm ones).
`test/` has PRE-EXISTING tsc errors elsewhere (test-cpp-parser's
`parser.tables`, test-py-parser importing `walk`/`walkB` which are now `walkerB`; its 19 failures
are all `walk is not a function`), so the gate greps for vsdg only and must not test tsc's exit
status through a pipe (`... | grep | head` tests head's status).

**FIXED 2026-09-16 — postfix `x++`'s old-value snapshot could be scheduled AFTER the increment.** The
snapshot (`unary_post_old`) is a pure value whose only real consumer is the enclosing expression, and
GCM sinks a value down to its consumer's block -- which can sit past the state-chain point where the
increment runs. So `g(i++)` could read the NEW value, and a postfix in a loop body always did
(`i++; var t0 = i; g(t0);`); the mutation marker only *floors* the snapshot, it never caps it. Fix:
the dialect's own postfix lowering wires the snapshot INTO the increment as a scheduling-only
consumer edge (`connectValue(oldNode, 0, node, 1)`; TS is the only dialect with a postfix lowering --
CPP/PY never create a `unary_post`), and the core splits the two questions that were conflated:
`RawNode.isVestigialEdge` calls that port vestigial, so it is never a value read and an UNUSED snapshot
still materialises nothing, while `scheduleLate`'s own `isSchedulingRelevant` switch keeps counting it,
so it still pins the snapshot above the increment -- the same "real edge, not a value" split `theta`
port 1 already had. Separately, TS's `rebuildPayload` `unary_post_old` case now uses `resolveOperand`
rather than `resolveTarget`: the snapshot must share the target's own materialised read, or a member
target is evaluated twice (`var t0 = o.count; var t1 = o.count;`) instead of once. All five postfix
shapes are now pinned in the suite (bare statement, value, loop, member statement, member value).

**OPEN, PRE-EXISTING, and NOT switch-specific** (found 2026-09-16 while scoping switch's cases):
two SIBLING scopes each declaring the SAME name print the second declaration as a bare ASSIGNMENT.
`if (x) { let y = h(1); g(y, y); } else { let y = h(2); g(y, y); }` prints `y = h(2);` in the else
branch, with no `let` — and two sibling `while` loops do it too, so it is the reconstruction's flat
name table (a name is remembered as bound once ANY earlier declaration claimed it), not anything
about per-case scopes. It only shows up when the value can't inline (read twice, or impure), and the
result still parses; it silently retargets the second binding at the first one's, or at a global.
Worth fixing in the printer/reconstruction, not by re-nesting scopes per dialect.

**The empty-`if` husk, FIXED 2026-09-16** (core: `emitControlNode`'s gamma branch -- found through CPP's
`++`, but never `++`-specific): a branch pair whose only content is the value it merges -- `if (c) r =
g(x); else r = h(y);` -- reconstructs that value at the value's own consumer (`return c ? g(x) : h(y);`, or
for CPP `return c ? r = g(x) : (r = h(y));`), leaving NEITHER arm a statement of its own: the mutations
behind a merged value hang off the VALUE edge, not the state chain the arms are walked from. The
anchoring `if` printed regardless, an empty `if (c) { } else { }` above a merged value that already
prints the same condition. It now drops -- UNLESS the condition is not a pure subgraph, since a condition
like `g()` is what forced a structural gamma in the first place and prints NOWHERE else, so dropping the
`if` there would drop the call (`isPureSubgraph` is the guard; that husk stays, keeping the call in its
condition). Before/after both dialects in `assistant/ifelse-shape-probe.ts`; pinned in both suites
(test-vsdg "if: a branch pair with no statements of its own prints no empty husk", test-vsdg-cpp x2).

**FIXED 2026-09-16 (core, both dialects) -- the first of the two holes the husk work exposed:** an IMPURE
condition whose value is MERGED across the branches printed TWICE -- once as the surviving husk's
condition, once inside the merged value (`if (g(c)) { } else { } return g(c) ? h(x) : h(y);`, and CPP's
`if (g()) { } else { } return g() ? ...`). Cause: `valueConsumers`'s "port 0 of a control node is a state
edge" rule is wrong for the per-variable merges, whose port 0 IS the condition they print -- the call saw
ONE counted reader, deferred to it, and each condition site then inlined the payload. Now vc counts that
port, so the call materialises (`auto t0 = g();` / `var t0 = g(c);`) and every site reads `t0`. The husk
then drops too: with the condition materialised, nothing is lost by dropping the empty `if`, so the husk
guard accepts `nodeVariableNames.has(conditionId)` as well as a pure condition. FIXING IT EXPOSED A
SECOND HOLE: `buildConditional`'s `cond ? x : x` -> `x` collapse then dropped the condition entirely where
the arms resolved equal -- `if (g()) a = i++; else a = i++; return a;` in TS became a bare `return i;` with
the call gone. That collapse is now guarded on `isPureSubgraph(condition)`, so the condition keeps its one
printed place (the odd-looking-but-correct `return g() ? i : i;`).

**FIXED 2026-09-16 (core) -- the second hole:** a DEAD name's mutation used to take its effectful RHS with
it, `if` or no `if`: `int f(int x) { int r = 0; r = g(x); return 0; }` printed `int r = 0; return 0;` and
the call to `g` was gone. A declaration's initialiser never had the hole (`int r = g(x);` keeps `g(x);`),
which is the tell: the effect branch of `emitLocalStatements` defers a single-consumer effect to that
consumer, and an inlinable slot is printed NOWHERE -- so the effect has to be able to look through it.
`surfacesValue` follows the chain of inlinable slots down to whatever actually prints (with a cycle
guard); the deferral uses that live count, and a non-deferred effect with no live consumer prints as a
bare statement instead of naming a temp nothing reads. Side effect worth having: an unmodelled mutation
inside a dead branch now prints as well (`if (g()) { i++; } else { i++; }`). That is the safe default -- an
`operator[]`/`operator++` behind a member target, and any call, can do anything -- and the exception is
what the DIALECT can prove: CPP's `++`/`--` on a plain name claims `mutatesBindingId` ("nothing but this
rewrite"; see tison_vsdg_cpp.md), and the same branch with those drops both increments.

All of it is pinned in both suites: TS `if: an impure condition of a merged value runs once`, `if: a dead
store still evaluates its right-hand side`, `if: an identical merge keeps an impure condition`; CPP the
first two plus `a dead store still evaluates its right-hand side`, `... and so does a dead store in each
arm of an if` and `a dead branch still runs its unmodelled mutation`.

**Divergence worth knowing** (same session): the per-case scope means a declaration in one case is
NOT visible to a later case, where real JS has ONE block scope for the whole switch body
(`case 2: g(y)` after `case 1: let y = 1` is legal JS, and is a TDZ error only on the path that
enters at case 2). The builder now drops that declaration entirely on the case-1 path instead of
initialising it. Both versions are a runtime error on the enter-at-case-2 path, so nothing that
WORKED regressed, but the two paths were not previously distinguishable and now differ.
