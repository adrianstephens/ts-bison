---
name: tison-comment-pass-tooling
description: "how to rewrite towasm.ts comments safely (edit lists anchored to original lines + a printer-based code-identity gate), and the bare-createScanner template trap"
metadata:
  node_type: memory
  type: project
---

A wholesale comment pass over `towasm.ts` must never let an editor reproduce code. Working shape, in
`assistant/towasm-comment-pass.js` (`plan` / `apply` / `verify` / `report` / `reindent`):

- editors return `{start, end, lines}` edits anchored to ORIGINAL line numbers; `apply` validates each
  target is a real comment (comment-only, or one trailing `//`), keeps indentation, and refuses block
  comments / commented-out code / directive comments / the header (18-128) / `// ===` banners, then splices.
- `verify` PROVES the code is unchanged by reprinting both files with
  `ts.createPrinter({removeComments: true})` and requiring byte equality (plus zero parse diagnostics).

**Never analyse this file with a bare `ts.createScanner`.** With `skipTrivia` it cannot scan template
substitutions: it reads the backtick closing `${...}` as a new `TemplateHead` and swallows the code after
it, silently corrupting any token or comment analysis. Comment ranges come from the AST instead
(`getLeadingCommentRanges` / `getTrailingCommentRanges` over `getChildren`).

The 2026-09-17 pass: 449 comment blocks >2 lines -> 274 (all remaining judged load-bearing; the user chose
to let load-bearing blocks exceed the cap), file 11551 -> 10323 lines. A rewrite+audit pair per chunk is
what preserved information -- the audit restored content in all 19 chunks.
