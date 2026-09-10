---
name: tison-peg-backend
description: tison/src/peg.ts — PEG back end over the same GrammarSpec as the LR one; design decisions, limits, and which example grammars survive the switch
metadata:
  type: project
---

Added 2026-09-04 (tison commit `1e8e513`). `makePegParser(spec, options?)` in `tison/src/peg.ts`
reads the *same* `GrammarSpec` value `makeParser` takes, as a PEG: packrat recursive descent,
alternatives as ordered choice.

**2026-09-10: the `tison.ts`↔`peg.ts`/`lalr.ts` cycle this used to describe is gone.** The shared
foundation (grammar spec types, lexer, `GrammarBuilder`) moved out of `tison.ts` into `src/core.ts`,
which has zero imports of its own. `lalr.ts` and `peg.ts` now import from `./core` instead of
`./tison`; `tison.ts` is just the barrel (`export * from './core'/'./lalr'/'./peg'`) and remains the
package entry point (`main: dist/tison.js`). Every other consumer (`tableCache.ts`, `rrule.ts`,
`examples/*`, tests) still imports from `./tison`/`../tison` unchanged, since the barrel re-exports
the full combined API. If you add a fourth module that both `core.ts` and a back end need, put it
in `core.ts` too rather than reintroducing a back-import into `tison.ts`.

Design calls made, with the reasoning that isn't in the code:

- **Direct left recursion only**, via seed growing + precedence climbing driven by the spec's own
  `precedence` levels (`trailingMinPrec`/`levelOf` in peg.ts). This is what makes the README's
  `expr '+' expr` grammar parse identically under both back ends. Full Warth-style indirect left
  recursion was considered and rejected as a research-sized, known-fragile detour; indirect cycles
  are found statically (left-corner graph + Tarjan SCC) and reported instead.
- **Epsilon alternatives are silently moved last** in PEG mode only. `Maybe()` is written
  epsilon-first for LR; taken literally as an ordered choice it would always match nothing. There
  is no grammar where a leading bare-ε alternative is intended, so this is safe, and it makes
  existing `Maybe`/`MaybeList` uses work unchanged.
- **Two lexing modes.** `'maxmunch'` (default) reuses tison's own `nextToken` with *all* terminals
  as candidates — identical tokenization to LR minus the `allowed`-row state restriction, which is
  the one lexer feature with no PEG counterpart. `'direct'` matches only the wanted terminal
  (true scannerless PEG); that's what `Not(KEYWORD)` guards are for.
- `And()`/`Not()` are the only new grammar surface; `buildTables` throws on them.

**Survey of the shipped grammars** (done by monkey-patching `makeCachedParser`/`makeParser` to
capture specs, then running `pegDiagnostics`): wat/py/js/ts-parser analyse with 0 errors; c-parser
and cpp-parser each have one indirect left-recursive cycle. But "0 errors" ≠ usable — all of them
have dozens of `warning:` shadowed alternatives, because alternative order is meaningless to LR and
decisive under PEG. Confirmed empirically: js-parser's PEG build parses
`function f(a, b) { return a + b; }` fine but fails `var x = 1 + 2 * 3;` at the `=`, because a
bare-declarator alternative precedes the initializer one. py-parser mis-lexes at token 1 (its
off-side-rule lexer leans on the LR `allowed` set). So reusing an LR grammar as a PEG is a real
porting job, not a flag flip — `pegDiagnostics` exists to size that job.

See also [[tison-project]], [[tison-debugging-technique]].
