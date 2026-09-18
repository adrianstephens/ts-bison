---
name: tison-precedence-resolution
description: How rule precedence actually resolves shift/reduce in tison, the object-vs-named bug fixed at 87a809b, and the OneOf defect still open.
metadata:
  type: project
  modified: 2026-09-17
---

`setAction` (lalr.ts) resolves a shift/reduce conflict by comparing the REDUCE rule's `prec.level`
against the SHIFT rule's — the rule that would shift the lookahead, **not** the lookahead terminal
(tison has no terminal-precedence table; yacc does). Order of checks: `fork` → level → `assoc` of the
SHIFT rule → GLR. If either precedence is missing it takes a **default shift**, which the code itself
flags as "the classic source of wrong-parse, no-error bugs".

## Two ways a precedence goes missing. One is fixed, one is NOT.

**FIXED at `87a809b`** — `WithPrec(rule, PREC.relational)` passes the object from `spec.precedence`,
which has `assoc` but no `level`; only the by-name entries built in `core.ts` get one. Objects were
passed through unresolved, so every comparison was `undefined > undefined` and ordering degraded to
associativity alone. Now keyed by identity as well as by name. **If you add a precedence mechanism,
keep both spellings resolving to the same entry.**

**STILL OPEN** — an operator spelled `OneOf(['+','-'])` becomes an anonymous NONTERMINAL (`OneOf` is
`Rules(...)`; `termOneOf` is a single `Terminal`). The rule that shifts the operator is then
`anon -> '+'`, which has no precedence, so `shiftPrec` is undefined and the default-shift branch fires
— losing precedence AND associativity. In cpp-parser this is every `OneOf`-spelled group
(`* / %`, `+ -`, `<< >>`, `< > <= >=`, `== !=`):

    a * b + c   ->  a * (b + c)      a - b - c  ->  a - (b - c)
    a < b == c  ->  a < (b == c)     a + b < c + d -> a + (b < (c + d))

while literal-spelled operators (`&& || | & ^ ?:`) are correct since the fix.

**Do not "fix" this with `termOneOf`** — the user rejected it (it has caused problems, and in C++ `<`
is the template-open literal with `templateDepth` tracking, while `*`/`+`/`-` double as deref/unary).
The fix has to make the enclosing rule's precedence reach the shift decision through a single-terminal
nonterminal, or give terminals their own precedence.

## Probe

`assistant/cpp-prec-probe.ts` prints a table of expected-vs-actual parses for the cases above — the
fastest way to see the state of this. `parser.tables.conflicts` lists every resolution with its reason
(`shift (default, no prec info; loses reduce of rule N: ...)` is the one to grep for).

## How it was found

Writing `assistant/cpp-backend.ts`, a throwaway C++→wasm backend over the neutral layer, and getting
wrong answers from `?:`. Worth remembering as a method: a second front-end exercises the grammar
differently from the test suite, which had no case pinning cross-operator precedence.

Related: [[tison-project]], [[tison-debugging-technique]].
