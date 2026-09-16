---
name: tison-decorator-support
description: "Decorator (@dec) grammar support in tison's js-parser.ts/ts-parser.ts — CLOSED: class-level, member, and parameter decorators all supported. Member/parameter went through a real LALR state-sharing fragility, an engine-level fix that was tried and reverted, then a structural workaround (Manual()+parsePrefix()) that actually shipped."
metadata:
  type: project
  originSessionId: 2026-08-22
  modified: 2026-08-23T03:37:05.206Z
---

Added while triaging the "long tail" of failures in [[tison_official_ts_test_suite]]'s official-TypeScript-tests
harness — `@`-triggered failures were the single largest cluster (340 of ~2,600 remaining failures), and
tison had zero decorator grammar at all beforehand (`ts-parser.ts` even had a header comment listing "No
decorators" as a known gap).

**What's supported (`src/examples/TS/js-parser.ts`):**
- `decorator = Rules<Expr>(Rule(['@', left_hand_side_expression], ...))` — deliberately permissive (accepts
  the full `left_hand_side_expression`, not real TS's narrower "identifier/member/call chain only, no
  `new`/literals" restriction), matching this grammar's usual stance of erring permissive where exactness
  isn't load-bearing for parsing.
- `decorator_list` — one-or-more, no separator (`@a @b class C {}` is whitespace/newline-delimited).
- Wired onto `class_declaration` and `class_expression` directly (`@dec class C {}`,
  `var v = @dec class C {}`), and separately onto `module_item` for the `export`/`export default` case
  (`@dec()\nexport class C {}`, `@dec()\nexport default class C {}`) — decorators always precede
  `export`, never sit between `export` and `class`, so this needed its own rule rather than relying on
  `class_declaration`'s own decorator alternative (which only covers the undecorated-export case).
  `Class<T>` (and therefore `ClassDecl`/`ClassExpr`) gained an optional `decorators?: Expr[]` field.

**What's deliberately NOT supported, and why (this is the load-bearing finding, worth reading in full
before attempting either)**: member decorators (`class C { @dec method() {} }`, `@dec x: T;`,
`@dec static y: any;`) and parameter decorators (`method(@dec x) {}`). Both were implemented, both parsed
decorator syntax correctly in isolation, and **both silently broke ASI recovery for ordinary
`var`/`let` statements completely unrelated to any class or decorator** — e.g. `var a = 1\nvar b = 2`
(no semicolons, relying on ASI) started throwing `Unexpected character 'b'... Expected: [operators]`,
because the second line's `var` got contextually mis-lexed as a plain `identifier` instead of the `VAR`
keyword, throwing off everything downstream.

**Root mechanism (confirmed via bisection + `tables.lr0States`/`tables.conflicts` dumps, not fully
traced to the exact merge point — see [[tison_debugging_technique]]'s catalog entry for the reusable
lesson)**: tison's lexer is contextual/candidate-restricted (`stream.next(tables.action[state])` only
tries terminals valid in the *current* LALR state) and lexes a token exactly once, then reduces through
however many grammar levels are needed without re-lexing. `class_member_body`'s field-assignment shape
(`class_member_name '=' assignment_expression ';'`) is structurally identical to an ordinary variable
declarator (`identifier '=' assignment_expression`), so — even in the pre-decorator grammar — states built
from that shape were *already* shared with statement-level parsing via LALR core-merging. Adding a new
rule that reaches `class_member_body` (or the widely-shared `parameter` nonterminal) from a *new* grammar
position, even when correct in isolation, shifted where that sharing lands: at some state reached mid-way
through an *unrelated* ASI-recovery reduce-cascade (for the `var`/`var` case, right after shifting the
first declarator's initializer), `VAR` stopped being a valid candidate in the lexer's allowed set at that
point, so the second `var` fell back to being lexed as a bare `identifier` — and once misclassified, no
amount of later, correct-context reduction can undo it (the token was already fixed at lex time).

**Both wiring shapes were tried for member decorators and both broke it identically** — a
self-referencing `Rule([decorator_list, Forward(() => class_member)], ...)` (recurses through the whole
`class_member`, including the `static`/`;` cases) and a non-recursive pair referencing the leaf
`class_member_body` twice (once bare, once after `'static'`) instead. Confirms the fragility is about
*reaching `class_member_body`/`parameter` from a new position at all*, not about self-reference
specifically — ruling out the obvious "avoid recursion" fix.

**Why this was scoped down rather than fully root-caused**: doing so would need the full state-merge
mechanism traced to the exact colliding item (the "fourth class" technique in
[[tison_debugging_technique]] — dump `tables.lr0States` for the specific states before/after the change
and diff their item sets), which is a real, bounded, but nontrivial investigation on its own, and this
session had already spent significant effort getting this far. Class-level decorators alone (confirmed
safe, zero regressions across `test-js-parser.ts`/`test-tison.ts`/`test-cpp-parser.ts`/whole-workspace
`test-ts-parser.ts`) already cover real value — likely a meaningful fraction of the 340 `@`-triggered
official-test failures are single-decorator-per-class patterns (`@Component`, `@Injectable`-style).
Member/parameter decorators remain a real, well-characterized, but open gap for a dedicated future session.

**Debugging technique note for next time**: `TS.make()`/`JS.make()`'s cached tables
(`.tables-cache/*.tables`, gitignored) never carry real `conflicts` data — `SerializedTables` doesn't
round-trip it. To inspect real conflicts or `lr0States`, add a temporary `makeDebug()` export calling
`makeParser(spec)` directly (bypassing `makeCachedParser`), same technique used earlier this session for
the arrow-function reduce-reduce fix — **remove it again before finishing**, it's diagnostic-only.

**Confirmed later the same session: the "widen an existing shared nonterminal's own alternatives in place,
don't add a new rule that reaches it from outside" mitigation actually works.** Private class field support
(`#field`) hit the exact same shape of risk — `class_member_name` is the same kind of already-overloaded,
class-body-adjacent nonterminal `class_member_body` is — but adding `PRIVATE_NAME` as a sibling alternative
directly on `class_member_name` (rather than a wrapper rule referencing it from a new position, the shape
that broke ASI for decorators) caused zero regressions, verified by testing the exact `var a = 1\nvar b = 2`
canary immediately after each incremental grammar change, not just at the end. See
[[tison_official_ts_test_suite]] item 14 for the full private-fields writeup.

**A later session (2026-08-22) explored a real engine-level fix for the underlying fragility (`relexAt`,
re-lexing a stale lookahead token under the current, wider LALR state right before recovery) and got as far
as re-enabling this exact `class_member` self-referencing rule to test it — small-scale canaries
(`var a=1\nvar b=2`, `class C { @dec method(){} }`) both passed. Corpus-scale verification then found the
fix caused a real, large regression (+213 net crashes) from an entirely different angle — nothing to do with
decorators at all, see [[tison_official_ts_test_suite]] item 15 for the full mechanism and two real bugs
found along the way. Both `relexAt` and this re-enabled rule were reverted.**

**CLOSED (2026-08-23, same session): member and parameter decorators are now fully supported, via a
structural workaround rather than the reverted engine fix.** Prompted by the user asking whether tison could
grow a "back-door" to manually parse around LALR's constraints instead of continuing to fight the grammar
engine directly. Full mechanism (the new `Manual()` terminal primitive + `Parser.parsePrefix()`, both in
`tison.ts`) is documented in [[tison_manual_terminal_primitive]] — summary: each decorated
member/parameter is parsed by a single new, grammar-invisible terminal whose callback hand-scans the
`@decorator...` prefix via a small reused sub-parser (`decorator_list`, the same grammar class-level
decorators already use), then finishes the rest via another sub-parser rooted at a *snapshot* of
`class_member`'s/`parameter`'s own undecorated rules — entirely outside the main grammar's LALR table, so it
structurally cannot revisit the state-sharing fragility above (no new rule ever reaches `class_member_body`/
`parameter` from a new position in the *main* automaton).

**Verified**: the ASI canary and every existing test stay byte-identical; all decorator shapes (bare, static,
stacked, with call-args, on fields, on parameters, mixed decorated/undecorated params, member+parameter
decorators combined, class+member decorators combined) produce correct ASTs. **Full official corpus: 2,376 →
2,326 threw, exactly 49 files fixed (all genuinely decorator-shaped), zero newly failing** — the full
failure-list was diffed, not just the count. One real bug was found and fixed during wiring (a sub-parser
table build-order dependency — see [[tison_manual_terminal_primitive]] for the exact mechanism), caught by
testing the member+parameter-decorator *combination*, not either alone.

Class-level, member, and parameter decorators (`@dec class C {}`, `class C { @dec method() {} }`,
`method(@dec x) {}`, and every combination) are now all real, tested, shipped features — the "deliberately
NOT supported" framing above is historical context for *why* this was hard, not the current status.
