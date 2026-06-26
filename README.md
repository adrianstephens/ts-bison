# @isopodlabs/tison
[![npm version](https://img.shields.io/npm/v/@isopodlabs/tison.svg)](https://www.npmjs.com/package/@isopodlabs/tison)
[![GitHub stars](https://img.shields.io/github/stars/adrianstephens/ts-bison.svg?style=social)](https://github.com/adrianstephens/ts-bison)
[![License](https://img.shields.io/npm/l/@isopodlabs/tison.svg)](LICENSE.txt)

##  Support My Work  
If you use this package, consider [buying me a cup of tea](https://coff.ee/adrianstephens) to support future updates!  

## Installation

```bash
npm install @isopodlabs/tison
```

## What is tison?

tison is a TypeScript-native parser generator -- analogous to GNU Bison, but instead of writing a `.y` file and running a code-generation step, you pass a plain TypeScript object describing your grammar and get a parser back immediately. There's no separate lexer to write either: terminals carry their own regex patterns, so tison lexes and parses in one pass.

Grammars build SLR(1) tables, with an automatic, low-overhead fallback for the rare construct that's genuinely ambiguous -- see [Handling ambiguity](#handling-ambiguity-glr-on-demand) below.

### Why tison, and not...

There's no shortage of JS/TS parser generators -- tison's particular combination of choices just isn't quite any of theirs:
- **[Jison](https://github.com/zaach/jison)** is the closest precedent (LALR(1), Bison-style precedence, integrated lexer) but is largely unmaintained, and its lexer has nothing like tison's `Terminal.lex`/state-restricted-lexing hooks for context-sensitive tokens.
- **[Chevrotain](https://chevrotain.io/)** is the closest peer for "define the grammar as TS code, no build step" -- but it's a hand-rolled LL(k)/CST-builder under the hood, not LR tables, and ambiguity is handled via explicit backtracking/gates rather than GLR forking.
- **[nearley](https://nearley.js.org/)** also embraces ambiguity (it returns every parse) via Earley parsing, but grammars are `.ne` files compiled to JS, not a TS value you construct and call directly.
- **[Peggy](https://peggyjs.org/)** (the maintained PEG.js fork) is by far the most widely used JS parser generator, but PEG's ordered-choice semantics are a different tool for a different problem shape -- no real notion of ambiguity to resolve.
- **[lezer](https://lezer.codemirror.net/)** is GSS-based like tison's GLR fallback, but built for incremental/editor reparsing (it's CodeMirror 6's parser), and its grammars are still a separate `.grammar` file run through a generator.

tison's niche: SLR(1) tables with GLR forking used only on the specific `(state, token)` pairs that are genuinely ambiguous, a grammar that's a plain TS value rather than a generated file, and a lexer wired directly into the parser's own state (the `allowed`-row trick) instead of a separate phase.

## Usage

```ts
import { tison, Rule, Rules } from '@isopodlabs/tison';

const NUMBER = /[0-9]+(?:\.[0-9]+)?/;

const expr = Rules<number>(
	Rule(['expr', '+', 'expr'] as const, $ => ($[0] as number) + ($[2] as number), 'additive'),
	Rule(['expr', '-', 'expr'] as const, $ => ($[0] as number) - ($[2] as number), 'additive'),
	Rule(['expr', '*', 'expr'] as const, $ => ($[0] as number) * ($[2] as number), 'multiplicative'),
	Rule(['expr', '/', 'expr'] as const, $ => ($[0] as number) / ($[2] as number), 'multiplicative'),
	Rule(['-', 'expr'] as const, $ => -($[1] as number), 'unary'),
	Rule(['(', 'expr', ')'] as const, $ => $[1] as number),
	Rule([NUMBER] as const, $ => parseFloat($[0])),
);

const parser = tison({
	skip: [/\s+/],
	precedence: { additive: 'left', multiplicative: 'left', unary: 'right' },
	start: 'expr',
	rules: { expr },
});

parser.parse('3 + 4 * 5');     // 23
parser.parse('(3 + 4) * 5');   // 35
parser.parse('-3 * 2');        // -6
```

A few things to note:
- **Tokens are just regexes.** Reuse the same `RegExp` (by source text) anywhere it's referenced and tison treats it as one terminal, auto-naming it internally -- no separate token-declaration step.
- **Plain strings in a rule's right-hand side are sugar.** `'+'` instead of `/[+]/`. If the string matches some rule's left-hand side it's a non-terminal reference instead.
- **Precedence belongs to rules, not tokens.** `precedence` declares named levels (lowest to highest); a rule opts in via its third argument to `Rule(...)`, and a shift/reduce conflict is resolved by comparing the reducing rule's level against whichever rule wants to shift instead -- the same model Bison uses.
- **`Rule`/`Rules` are optional, typed sugar.** A rule is just `{ rhs, action?, prec? }`; you can write that object literal directly (see `precedence` above, expressed as a plain `Record<string, 'left'|'right'|'nonassoc'>`). `Rule()` infers each `$[i]`'s type from `rhs`'s shape -- a `RegExp`/`Terminal` element types as `string`, and referencing another rule set by its `const` (rather than by name) carries that rule set's own value type through. A *self*-referential symbol (`'expr'` referring to the same `expr` it's part of, as above) has to be named by string, since the `const` doesn't exist yet at that point -- TypeScript can't infer through that, so those positions come back as `unknown` and need a cast, same as you'd write by hand without `Rule()` at all.

## Core features

- **No build step.** A grammar is a value, not a generated file -- define it, call `tison()`, get a `{ parse, tables }` back.
- **Integrated lexer.** Every terminal is a regex (or a string literal, auto-converted). Longest match wins; ties go to a fixed, deterministic order rather than declaration order, and a literal ending in a word character (e.g. `'in'`) gets an implicit word-boundary so it can never falsely match as a prefix of a longer identifier (`'index'`, `'instanceof'`).
- **Context-sensitive lexing, with zero new concepts in the grammar itself:**
  - `Terminal.lex` -- a callback invoked once a terminal's pattern matches, that can accept the match, reject it (letting a different match win instead), or reclassify it as a different terminal. Built for things like disambiguating `/` (division vs. the start of a regex literal) from the *previous* token, or splicing automatic-semicolon-insertion policy into the token stream from inside the lexer.
  - **State-restricted lexing** -- when several terminals' patterns could all match at the current position, the parser's own current set of valid actions narrows the choice. This is enough to parse template-literal interpolations (`` `${ {a:1}.a} ` ``) correctly with no explicit brace-depth counter anywhere -- the grammar state itself already knows which `}` is which.
- **`GrammarSpec.recover`** -- a single error-recovery hook: if the real lookahead has no action, it's handed the state's valid actions and the offending token, and can substitute a different token to retry with. This is enough to implement ECMAScript-style automatic semicolon insertion as pure userland policy.
- **Precedence and associativity**, Bison-style: named levels, rules opt in, conflicts resolved automatically.

### Handling ambiguity: GLR on demand

Most grammars are unambiguous almost everywhere, with at most a handful of genuinely ambiguous constructs (a dangling `else`, an operator with no declared associativity). tison's parser starts as a plain deterministic LR loop over a flat stack -- the cheapest possible representation -- and only switches to a graph-structured stack (GSS) at the exact `(state, token)` pair the tables report as truly ambiguous, exploring every alternative there via a fork. The moment that fork (and anything it leads to) settles back down to a single surviving derivation, it drops straight back to the flat-stack loop. So a fully unambiguous grammar never allocates a single GSS frame, and an ambiguous grammar only pays for the parts that actually need it.

Where two paths converge on the same parser state, their values are combined with a merge function (`tison(spec, mergeFns)`, keyed by table state) -- by default, into an array of all the surviving interpretations.

## Examples

The package itself ships just the library -- these live in the [repository](https://github.com/adrianstephens/ts-bison)'s `test/` folder, not in the npm package, in increasing order of size:
- [`test-tison.ts`](https://github.com/adrianstephens/ts-bison/blob/main/test/test-tison.ts) -- a minimal arithmetic expression grammar.
- [`c-parser.ts`](https://github.com/adrianstephens/ts-bison/blob/main/test/c-parser.ts) -- a C grammar.
- [`js-parser.ts`](https://github.com/adrianstephens/ts-bison/blob/main/test/js-parser.ts) -- a JavaScript grammar covering the full statement and expression grammar, including destructuring, classes, generators, async/await, modules, and more -- the proving ground for tison's lexer extension points.

## License

This project is licensed under the MIT License.
