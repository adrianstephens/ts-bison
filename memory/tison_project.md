---
name: tison-project
description: "tison parser-generator (/Volumes/DevSSD/dev/packages/tison) — architecture facts that cost real effort to establish, and the live working conventions."
metadata: 
  node_type: memory
  type: project
  originSessionId: e1e31c24-8d38-47f3-aa27-e8c84bc6b664
  modified: 2026-09-04T18:22:48.328Z
---

`tison` is the user's own TypeScript parser-generator: you pass a plain TS object describing a
grammar (terminals carry regex patterns, so tison is the lexer too) and get a parser back. Core LR
engine `src/tison.ts`; PEG back end `src/peg.ts` (see [[tison-peg-backend]]). Grammars in
`src/examples/` — TS/, PY/, CPP/, plus shared `common.ts` and `walker.ts`. Tests `test/test-*.ts`.

**Architecture facts worth keeping (each cost real debugging effort):**

- **The table builder is LALR(1) by default** — `buildLALR(g, lalr = true)` in `src/lalr.ts` builds
  the LR(0) automaton, then computes per-state reduce lookaheads by fixed-point propagation over it
  (rather than canonical-LR(1)-then-merge, avoiding that method's state explosion). `lalr: false`
  opts down to plain FOLLOW(lhs)-based SLR(1): weaker, more spurious conflicts, but no correctness
  difference — conflicts still resolve via precedence/GLR either way.
  *This memory previously claimed the engine was SLR(1). That was true when written but stopped being
  true at `54b80fb` (2026-07-14), which added the LALR propagation. Don't reintroduce it.*
- When a shift/reduce conflict has no precedence info, `setAction()` **silently defaults to shift**
  and logs a `kind:'auto'` conflict. This is the proximate cause of most "wrong parse, no error"
  bugs, and the unflagged shift-reduce ones are the dangerous kind. Because LALR merges states with
  identical LR(0) cores, the colliding rule pair is almost never the one you would guess from reading
  the grammar. [[tison-debugging-technique]] has the methods.
- `forceFork`/`assoc:'fork'` works for **both** shift-reduce and reduce-reduce conflicts. If you hit
  a silently-wrong parse and `tables.conflicts` shows `reduce-reduce ... (earlier rule wins)` where
  the losing sibling should have won in context, tagging one side with `forceFork` is the fix.
- `defaultMerge` collapses structurally-equal GLR-converged values (JSON equality) instead of always
  wrapping them in an array. Relevant whenever a new `forceFork` produces a "both branches parse to
  the same thing" convergence rather than the usual "one branch dies downstream".
- **Run tests via `ts-node`, not `tsc` + `node`** — `test-ts-parser.ts` reads source via paths
  relative to `__dirname`; a custom `outDir` breaks that with an unrelated-looking `ENOENT`.
- `src/examples` needs its own tsconfig invocation: **`cd src/examples && tsc -p .`**. See
  [[feedback-tison-examples-needs-own-tsconfig]] — this has bitten more than once.

**Verification recipe for grammar restructuring (reuse it):** capture `tables.conflicts` kind +
per-terminal-auto multiset before/after (states and rule ids renumber, multisets don't lie); load
pre- and post-change parsers in ONE process (scratch copies with imports rewritten to absolute
`src/tison` paths — interning is per-GrammarBuilder so they don't contaminate) and JSON-compare ASTs
over a real-file corpus; then check a targeted construct list. Do NOT `git stash` for baselines
([[feedback-no-git-stash-midsession]]).

**Corpus status lives in files, not here** — `tison/PROGRESS.md` for the real-world `.ts` corpus, and
[[tison-official-ts-test-suite]] for the TypeScript-compiler corpus. Both go stale fast; re-run
rather than trusting any snapshot.

**History**: this file used to carry a ~170KB running log of every grammar gap fixed since 2026-07.
That is derivable from git history and the code; the full original is in
`../memory-archive/tison_project.md` if a specific old decision needs recovering.
