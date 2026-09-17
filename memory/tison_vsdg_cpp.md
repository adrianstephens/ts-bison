---
name: tison-vsdg-cpp
description: "src/examples/CPP/vsdg.ts -- the C++ half of the language-neutral VSDG: the widened top level (Definition vs Stmt), what is modelled vs verbatim, and the C++-specific bugs and limits found"
metadata:
  type: project
---

2026-09-14: first slice of the C++ dialect. dialect + builder + emitter + pipeline, 15 exact-output
cases in `test/test-vsdg-cpp.ts`, gate green (48 TS + 28 PY + 15 CPP). `CPP.parse` is ASYNC (the
preprocessor's include resolver), so this suite's harness is async -- the only harness difference.

2026-09-15: constant FOLDING added (31 CPP cases; 48 TS + 28 PY + 31 CPP otherwise green). It needs a
TYPE MODEL, which in turn needed a literal's own spelling to survive the parser and the printer -- see
its own section below, along with the two pre-existing expression-grammar bugs found on the way.

2026-09-16: two correctness bugs fixed (35 CPP cases now): a declaration elided while a surviving store
named it, and a lambda body leaking into the enclosing function. Both are in the "Bugs found" list.

2026-09-16 (later): switch lowered (41 CPP cases). See its own section below for what C++ needed and
what is still open.

## The one structural difference: the top level is DEFINITIONS

`CPP.Definition` (function_def/namespace/template/out-of-class member defs/...) is NOT a subset of
`CPP.Stmt`, so this language's `S` is the widened `TopLevel = Definition | Stmt`. `Emitter.build()` and
`emitChain` then hand back a MIXED top-level list, and a caller printing it must dispatch per item --
that's why `CPP/vsdg.ts` exports `isDefinition(item)`: the printer has separate `definition` and
`statement` entry points and can't infer which one an item needs.

The walker keeps definitions and statements apart (`Kinds`), so `walkerB()` bridges them. Only the tags
that CANNOT be a statement go to `w.definition` (`DEFINITION_ONLY` = function_def/namespace/linkage/
template/method_def/operator_def/constructor_def/destructor_def/static_member_def); everything else --
including `declaration`/`typedef`/`using`/`static_assert`, which are in BOTH unions -- goes to
`w.statement`.

**The widened `S` also resolved the blocker that made C++ look hard**: `VSDGBuilder.run(ast: readonly S[])`
used to assume a statement array at top level. With the walk start owned by `BuildVSDG` (see
[[tison-vsdg-dialects]]), the builder never sees the top-level array at all.

## C++-specific lowering decisions

- `T` (the type annotation) is the whole `CPP.DeclarationSpec`, so a declaration prints itself
  (`int x = 1;`, storage class included). C++ has no declKind: a `var` node WITH a typeAnnotation
  prints a declaration, one WITHOUT prints a plain `x = 1;` (a name a verbatim statement declared, or a
  global) -- a type can never be invented on this AST, unlike every other dialect.
- `makeTempDecl` uses `auto`: C++ has no keyword-less declaration form.
- An assignment is an EXPRESSION and a mutation either way (`lowerAssign`), used by both the statement
  and expression paths. A name never seen declared, or not local to the current function, gets
  forcedPrint -- a store to a global is observable.
- `a->b` IS modelled: the core's member node gained a `pointerMember?: boolean` stamp (exactly the
  precedent TS's own `optional` set). Everything else unmodelled becomes an EFFECT (ordered, printed
  verbatim, never assumed pure): `new`/`delete`/lambdas/`functional_cast`/`cpp_cast`/`typeid`/
  `alignof`/`++`/`--`. `++`/`--` are the one exception to that list's "nothing is modelled": the
  expression still stays opaque (see the section at the end), but the NAME it rewrites IS re-bound,
  because an unmodelled mutation that leaves the name alone lets CSE merge reads across it.
- A declaration is only modelled when every declarator is a plain INITIALISED NAME. `int *p = ...` (a
  pointer declarator needs its own type rewrite) and `int x;` (nothing to bind, but still must print)
  stay verbatim.
- A function_def with any parameter DEFAULT stays verbatim: the default lives only in the signature's
  verbatim text, so a name it mentions would look unread and be elided.
- A parameter's name comes from `declaratorName`, which digs through pointer/array/reference wrappers,
  so `int *p` binds `p`. (c-parser's own `declaratorName` is typed against ITS narrower declarator, so
  the dig is spelled again locally.)
- **NO CONSTANT FOLDING when there's no type to fold in**: a literal whose type its own spelling can't
  pin down (`long double`, a string literal, `nullptr`, `sizeof`), or an operation whose result C++
  leaves undefined or unspellable, still refuses. See the folding section below.

## Constant folding (added 2026-09-15)

C++ arithmetic is defined in terms of a TYPE, and the only type information this AST has is a literal's
own SUFFIX. So `Literal` gained an optional `raw` (the source spelling): `c-parser` keeps it
(`Literal(parseInt($[0], 10), $[0])`), `CPP/printer.ts`'s `literal()` prints it verbatim, and
`cppDialect.literalValue` reads the type back out of it. Two consequences worth knowing: a suffixed
literal now ROUND-TRIPS (`unsigned u = 1u;` used to print as `1`, and still would if `raw` is dropped),
and `exprKey` (printer-based) no longer keys `1u` and `1` alike.

- `Scalar = { kind, value }` is what travels between a fold's operands and its result, so a fold OF a
  fold still knows its type: kinds are the 6 integer types + float/double + bool. `Dialect.literal`,
  `literalValue` and `truthy` all speak it; nothing else in the core sees it (`unknown` in, `unknown`
  out) -- which is exactly why the type could be carried at all.
- The model lives in `CPP/walker.ts` beside the walker (as TS/PY keep `calcUnary`/`calcBinary` there),
  exported as `Scalar`/`calcBinary`/`calcUnary`/`scalarFor`/`spellScalar`; `CPP/vsdg.ts` imports them
  for the dialect, and its own header points there rather than duplicating the rationale.
- Integer work is done in BigInt (js's `<<`/`>>>`/`&` coerce through int32, so `1 << 31` and
  `4294967295 & 1` would be silently wrong). Narrowing to a width is `BigInt.asUintN`/`asIntN`, which
  IS C++'s conversion (and `asIntN(bits, v) === v` is the "fits a signed type" test). BigInt's own
  bitwise operators are two's complement at UNBOUNDED width, so `v & (2^bits - 1n)` is the same thing
  -- verified identical across 8/32/64-bit and boundary values, not assumed. Either way the point is
  that a NUMBER `&` could not express it.
- Both operands are CONVERTED to the common type before anything is computed, which is what makes
  `0u - 1 < 1u` false -- a JS folder says true.
- A signed result that doesn't fit the type is UB, so it is REFUSED (no wrap); unsigned wraps by
  definition. `/` `%` by zero and `INT_MIN / -1` refused; `%` and bitwise/shift on a float refused;
  `1 << 31` refused (signed overflow); shifts >= the width refused; `||`/`&&` return a BOOL, not an
  operand (js's `1 && 2` is 2); a float result keeps a `.` (`3.0`, never `3`, or it would come back as
  an int literal) and rounds through `Math.fround` for `float`. A result past 2^53 is refused (a JS
  number is what gets printed): `~0ull` has no spelling this can produce.
- LP64 assumed (long = 64-bit); Windows' LLP64 differs and no spelling distinguishes them.
- A `?:` on a constant test is NOT folded: the core's protocol folds an operator over all-literal
  operands, and a conditional's branches needn't be literals. Folding it means dropping the losing
  side's subgraph, which the gamma path (`foldDeadBranches`) does and a `floating` node has no
  equivalent of. The core gained `Dialect.truthy(value)` for the constant-condition case, replacing a
  free `truthy(v) { return !!v }` whose comment claimed all four languages agreed about falsiness.

## Expression-GRAMMAR bugs found while doing the above (both PRE-EXISTING, in c-parser)

1. **FIXED**: the unary rule built every prefix operator as `'+'` (`Unary('+', $[1])` -- the matched
   operator was captured as `$[0]` and discarded), so `-x`/`!x`/`~x`/`*p`/`&x`/`++x` all parsed AND
   printed as `+operand`. This is why folding under a prefix operator was meaningless before.
2. **OPEN, pinned in the suite**: `c-parser`'s expression grammar is the single-block-plus-`WithPrec`
   shape `py-parser.ts`'s header explicitly warns against ("silently produces right-associative,
   wrongly-nested trees when the operator sits behind an `OneOf`"). Measured: `-1 + 2` parses as
   `-(1 + 2)` and `10 - 2 - 3` as `10 - (2 - 3)`, so the pipeline prints `-3` and `11` where C++ says `1`
   and `5`. Folding didn't cause this (the mis-tree already
   mis-printed, e.g. `-x + 2` printed as `-(x + 2)`), but it turns a wrong TREE into a wrong CONSTANT.
   The fix is the documented one: a precedence CASCADE (one nonterminal per level, right operand a
   different nonterminal) as `js-parser.ts`'s `binaryChain` does, in both `c-parser.ts` and
   `cpp-parser.ts` (whose `new`/`delete`/`spread` rules are pushed onto the same flat level).
   `test/test-vsdg-cpp.ts`'s two `KNOWN BUG:` cases fail the moment that is fixed.

## switch (added 2026-09-16)

The cascade itself is the CORE's (`VSDGBuilder.buildSwitch`, shared with TS -- see [[tison-vsdg-dialects]]
for why sharing it was not optional); `CPPBuilder` implements `SwitchSyntax` and supplies four one-liners
(`local` = an `auto`-typed hidden var, `comparison` = `==`, `condition`, `setHit` = an identifier-spelled
`true`). C++'s own contributions are:

- **the body is FLAT and must be regrouped**: `case 1: g(); break;` parses as three SIBLINGS, the label
  holding only its own first statement, and a label whose body is another label (`case 1: case 2: g();`)
  chains through it. `switchCasesOf` (= `transpile.ts`'s own `cppSwitchToTs` algorithm) returns undefined
  for what it can't regroup -- a statement before the first label, a second `default:` -- which then stays
  verbatim, as does an empty switch (no case body could break, and the helpers would print for nothing).
- **scaffolding spelled for C++**: `==` not `===`; `true`/`false` as IDENTIFIERS (no boolean literal on this
  AST); every hidden helper is an `auto`-typed local. The discriminant helper does PRINT
  (`auto __disc_5 = x;`), exactly as TS's `let __disc_4 = x;` does.
- **`makeSwitch` wraps a case that DECLARES in its own block** (`case 1: { int y = 1; ... }`): C++ forbids
  jumping past an initialisation into its scope, so the unbraced form is ill-formed for every later case.
  The builder's per-case scope is the same decision seen from the graph side.
- `needsDirectPlacement` (CORE) now treats a var with a **`typeAnnotation`** as a declaration too. C++ var
  nodes deliberately carry NO declKind: `isInlinableVarDecl` reads declKind as "this value may be elided",
  and with it set an assignment's own TARGET resolves to the initializer instead of the name (`0 = 1`).
  The type is what says "real declaration", and this is what keeps a typed declaration placed with its
  state-chain anchor at all.

**STILL OPEN**: a switch whose case bodies are nothing but pure assignments ELIDES entirely into a ternary
(TS does the same -- its own test suite documents it), and C++ then prints the stores as assignment
TARGETS inside it (`... ? v = 1 : v`). The declaration `int v = 0;` does not print, so that output is not
valid C++ (the `if`-shaped equivalent DOES keep it, so it depends on where GCM schedules the
declaration once the switch's own helpers are also in the graph). Candidate fix: make `nodesAt` add
port-2 direct-placement nodes to an anchor's block even when `blockIds` exists, instead of only when it
doesn't.

## Bugs found

1. **SHARED with PY/TS, fixed only in CPP so far**: a name mentioned ONLY as a bare identifier inside
   verbatim text had no graph reader, so its declaration was elided -- `int x = 1; switch (x) {...}`
   printed a switch reading an undeclared `x`. Fix in `lowerExpression`'s 'identifier' case: while
   `this.verbatim`, connect the resolved node to a fresh reading node (inherently `suppressed`, so it
   never prints). TS/PY still have this bug and the same 3-line fix applies -- the earlier verbatim
   tests only ever mentioned names as CALL OPERANDS, which do create edges.
2. **c-parser ambiguity forks**: `S *p = 0;` with an unknown type name forks into a pointer declaration
   and a multiplication, and BOTH readings are returned as a NESTED LIST where a statement is expected.
   They're alternatives, not a sequence: lowering both ran the statement twice. CPP takes the first.
   The printer can't print an alternative list either, so no other consumer handles this shape.
3. **FIXED (2026-09-16)**: a declaration was elided while a surviving store still named it
   (`int x = 1; if (0) { x = 2; } else { x = 3; } return x;` printed `return x = 3;` -- not valid C++).
   `emitNamedSlot` used the core's `hasForcedSibling`, which misses a store that is *inlined into
   whatever reads it* (`return c ? x = 2 : (x = 3);`): such a store is never forcedPrint. Replaced by
   `nameStoredTo(name, id)` -- a declaration survives when any node binds the name OR any 'mutation's
   own payload targets it. The second half is what the constant-condition case needs: folding the
   branch away BYPASSES the gammaValue that held the name, so only the store is left.
   LESSON, tried and reverted: force-printing every store to a name instead. It looks tidier (the
   if/else prints structurally instead of as a ternary) but it REORDERS the store against the read that
   was inlining it, and duplicates it (`x = 3; return x = 3;`) -- `resolveNode` resolves a name only
   once `names` has it, i.e. print order, not build order. Keep the store inlined, keep the declaration.
4. **Lambdas leaked their body into the enclosing function** (FIXED 2026-09-16): the
   unmodelled-expression fallback descends into everything, so `auto g = [](int x) { return h(x); };`
   printed a bare outer `h(x);` -- the body's statements were lowered in the CALLER's scope. Now a
   `case 'lambda'` builds a real function region (`buildFunctionBody` + `entry.expr = e` + `end =
   entry`) and does NOT descend. Two companions: `paramSlotsOf(params)` split out of
   `paramSlots(declarator)` for a lambda's own parameter list, and `readOnly(expr)` -- factored out of
   the verbatim-identifier case -- gives a reader to a name only the lambda's TEXT mentions (a capture
   the body never reads, a parameter default). Without that second piece the fix would have been a
   regression: the old fallback at least walked them.
   PY has the identical leak (`PYBuilder`'s `case 'lambda'` walks `e.body` BEFORE `buildFunctionBody`,
   which re-walks it in the inner region) plus a printer wart on `lambda: (a := 1)`. Its `None` output
   came from the core change in [[tison-vsdg-dialects]].

## Not modelled (verbatim fallback, deliberately)

classes/structs/unions/templates/namespaces/`using`, typedefs, `switch`, `goto`/labels,
`throw`/`try`, range-`for`, initializer lists, non-name declarators (see above).

Try/catch has a REAL SEAM problem, not just an unimplemented case: the core's handler type is an `E`
(an expression) -- `handlerTypeNodeId` resolves through `resolveNode` -- while C++'s `catch (T e) T` is
a `TypeName`, which has no expression form on this AST. Modelling C++ catch needs the seam widened (its
own type parameter, or a `TypeName`-shaped side channel) rather than a hack in the dialect.

## Invariant worth remembering

A parameter node is a `var` with `name` set but NEVER `bound` -- that is what keeps
`emitLocalStatements` from printing a parameter as a named slot (`slotName(node)` is undefined for it), and
`resolveNode`'s no-declKind case
resolves it by name. Verified with a probe (`def f(x): return x + 1` round-trips), because the PY suite
turned out to have NO function-with-parameters case at all.

**`++`/`--`: FIXED 2026-09-16 -- an unmodelled mutation that still re-binds the NAME it rewrites.**
Before, they fell through to the unmodelled-expression fallback, which never re-binds the name, so CSE
merged a read from before the increment with one from after it. Repro (now two suite cases, plus
`assistant/cpp-mutation-cse-probe.ts`): `int f(int i) { g(i * 2); i++; h(i * 2); }` printed
`auto t0 = i * 2; g(t0); i++; h(t0);` -- the shared temp is scheduled at the LCA of its two consumers,
i.e. ABOVE the increment, so `h` got the stale product. Both `i * 2` reads referenced the SAME `var`
node (nothing re-bound `i`), so their structural keys matched. The member form (`s.x * 2`, `s.x++`)
escaped only by luck (each `s.x` reads a separate CSE-skipped `member` node). Controls that stayed
correct: `i = 5` (which CPP DOES model, via `lowerAssign` -> `rebindVar`) and TS (whose `unary_post`
rebinds). So "just fall through" is NOT a safe way to model a mutation in a graph that CSEs.

The fix is `lowerUnmodelledMutation`, reached from `lowerExpression`'s `case 'unary'`/`case 'unary_post'`
for `++`/`--`: the expression stays OPAQUE (an `effect`, printed verbatim, state-chained) and, when the
target is a plain identifier, the name is re-bound to a fresh name-only `var` alias
(`this.scope.set(name, alias)` + `this.threadMutation(alias)`, never `bound`) so its own mutation marker
orders later reads after the increment. The alias prints nothing -- CPP's `emitNamedSlot` returns undefined
for a `var` with no `inputs[0]`. That alias shape is forced: rebinding to the `effect` node itself does
NOT work, because `slotName` is undefined for an `effect`, so every later read would print the whole
`i++` text instead of `i`.

Why the expression stays opaque instead of modelled the way TS does it: for C++ `x++` on a class type is
a real `operator++` call and its value is a COPY of the old one, so TS's materialisation (`auto t0 = x;
x++;`, feeding the consumer from the copy) is only equivalent for scalars, and this pass has no types.
`auto t0 = x++;` -- what the fallback already produces in value position -- is the faithful version. So
CPP will NOT use `unary_post`/`unary_post_old`. Deliberately not done: prefix `++x` COULD be modelled as a
real `mutation` (its value is the post-state, which IS sound), but it would degrade output shape
(`g(++x)` -> `++x; g(x)`) for no correctness gain. The dead `if (c) { } else { }` this section used to end
with is FIXED, in the CORE -- and it was never `++`-specific (`if (c) r = g(x); else r = h(y); return r;`
printed one too). See tison_vsdg_dialects.md's "empty-`if` husk", which also records the two holes fixed
alongside it (an impure condition printed twice; a dead assignment taking its call with it).

**What `++`/`--` CLAIMS, and what that buys (added 2026-09-16):** `lowerUnmodelledMutation` also stamps the
effect node with `mutatesBindingId` -- the alias it just created -- meaning "this does nothing but rewrite
that binding". `name` was not declared as anything in particular here: whether `operator++` is really the
builtin one is a TYPES question this pass cannot answer, so "builtin" is the documented assumption, the
same stand-in as `pure<name>` for calls, and a member/index target claims NOTHING (an `operator[]` behind
it can do anything).

The core uses the stamp for one thing only (`emitLocalStatements`' effect branch): with the value unused
AND no live reader of the binding, the increment is a dead store and drops -- `int f(int i) { i++; return
0; }` prints just `return 0;`, while the same increment on `s.x` still prints. Two traps on the way there,
both worth remembering: (1) live readers must be scanned RAW (`outputs[0]`, skipping only vestigial
edges), NOT through `valueConsumers` -- a loop-carried read arrives on a mu's feedback port, which that
calls scheduling-only, and dropping `for (...; i++)`'s update on that basis is a miscompile (it was,
briefly); (2) the operand read is now a real edge of its own (port 1 of the effect; nothing reads it, the
payload prints verbatim) -- without it a later `i++`'s dependence on an earlier one is INVISIBLE, so the
earlier one looked dead and `i++; auto a = i++; return g(i++) + a;` dropped its first increment.

Boundary, measured (`assistant/cpp-incdec-shapes-probe.ts`): the increment is KEPT whenever the name is
read by anything that prints -- a later `g(i)`, a store (`a = i`), a loop-carried read, or even a VERBATIM
statement's mention of it (`i++; switch (i) {...}`, where the readOnly reader counts) -- and dropped when
its only readers are themselves dead. WART (cosmetic, not a miscompile, pinned as `KNOWN WART`): that
check is per-node rather than transitive, so `i++; i++; return 0;` keeps the FIRST increment -- the second
one reads it, and a reader that is itself dropped still counts as one. Unobservable either way (`i` is
dead), just odd. Twelve live shapes all print verbatim and are now pinned in the suite (loop TEST, ternary
condition, two arguments, two in one expression, member/index targets, prefix, pre-increment value read
later): this is the area where two live miscompiles were found on 2026-09-16 *because* nothing here was
pinned, so it is deliberately over-covered now.
