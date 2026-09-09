---
name: tison-official-ts-test-suite
description: "tison/test/test-ts-official.ts — parser corpus run against the real TypeScript compiler's own tests; current numbers, the working method, and the harness traps."
metadata: 
  node_type: memory
  type: project
  originSessionId: e1e31c24-8d38-47f3-aa27-e8c84bc6b664
  modified: 2026-09-04T18:24:36.394Z
---

`tison/test/test-ts-official.ts` walks `tests/cases/compiler` + `tests/cases/conformance` from a
local TypeScript checkout at `/Volumes/DevSSD/dev/github/TypeScript` (this machine only, not in the
repo), splitting each file on its `// @Filename:` markers (~22% of the corpus) so each virtual
sub-file is parsed on its own. Non-asserting smoke test: tallies GAP/WARNING/ERROR and logs throws,
doesn't fail the run. `fourslash`/`project`/`projects`/`transpile`/`unittests` are excluded — DSL
formats, not source.

**Bucketed by tsc's own verdict (2026-09-09).** `ts-corpus.ts` `expectsErrorsSet()` reads
`tests/baselines/reference/*.errors.txt` — a test with such a baseline is one tsc rejects; no
baseline ⇒ tsc compiles it clean (basenames are globally unique, dir is flat). The run now prints two
rows, `tsc-clean` and `tsc-errors`. **Only `tsc-clean` matters** — an ERROR or throw there is our
checker rejecting code tsc accepts. `tsc-errors` (we don't try to match tsc's rejections) is noise.
At 2026-09-09: of 1519 throws, **1004 are on tsc-errors files** — not worth investigating. `tsc-clean`
= 516 threw + 877 ERROR = **1392 real false positives**, dumped sorted to
`assistant/corpus-false-positives.txt`. `corpus-errdump.ts` and `corpus-ab.sh` are both restricted to
this bucket now; `corpus-ab.sh` gates on `tsc-clean` threw/GAP/ERROR + the false-positive count, and
needs this commit on *both* sides (old base output format → PARSE-FAILED).

**Progress: 13,527 virtual files. 2,936 threw at baseline (2026-08-21) → 1,508 (run55, 2026-08-25) →
1,519 (2026-09-04).** ~51 numbered items landed. Per-item detail is derivable from git; the full log
is at `../memory-archive/tison_official_ts_test_suite.md`.

**The harness was silently dead for 79 commits (2026-08-29 `5b6b3dc` → 2026-09-04 `28bd378`.)**
`5b6b3dc` removed `TypeContext` from type-utils without updating this test's `checkBlock` call, so the
lib preload threw and every file counted as failing: `13527 files tested, 13527 threw`. Because the
harness catches per-file exceptions and tallies them, **a totally broken harness is indistinguishable
from a catastrophic parser regression** — the output reads as data. When it was fixed the real number
was 1,519, i.e. essentially unchanged; nothing had regressed, only the measurement had died.

**There is now a fast gate: `npm run gate`** (`test/test-ts-corpus-gate.ts`). Parses the whole corpus
in ~10s and fails if failures rise above the committed baseline in
`test/ts-corpus-gate-baseline.json` (currently 1565 — parse-only, no checker, so it differs from the
1,519 above). `--list` shows offenders, `--update` re-baselines. Run it before committing parser work;
it catches in seconds what took two commits and a codegen survey to notice last time.

**Two things this suite still needs:**
- **A denominator.** Partly addressed by the tsc-clean/tsc-errors split above (2/3 of throws are on
  files tsc rejects too). The residual `tsc-clean` throws still mix real gaps with
  deliberately-invalid-but-unbaselined fixtures and the known-excluded list is still growing.
- **A stronger oracle.** "Did it throw" missed item 48's `3.e5` misparsing as `(3.).e5`, caught only by
  dumping the AST. A round-trip check (parse → tocode → reparse → compare) over a sample would cover
  that class.

**Priority, stated by the user (2026-08-24):** parse all *legitimate, modern* code. Weigh "would real
current code ever hit this" before chasing a cluster. A deliberately-invalid or legacy-only fixture is
a reason to add it to `assistant/ts-official-known-excluded.txt` and move on, not to pursue TSC
parity. Angle-bracket type assertions were DROPPED entirely on this basis (~130+ files).

**Method that works:** cluster the failures by message signature first — identical-looking messages
across many files usually share one root cause, and fixing that unlocks the whole cluster. This has
paid off repeatedly. Verify each fix two ways: a targeted canary of every new *and* pre-existing
shape, plus a full corpus diff in **both** directions (fixed and newly-broken).

**Harness traps, all found the hard way — check these before blaming the parser:**

- 7 corpus files are **UTF-16 with a BOM**; reading as `'utf8'` silently mangles them. BOM-sniff.
- `splitTestFile` left a **leading newline** on every virtual sub-file, breaking a shebang's
  `^#!`-anchored regex.
- **`sed` before `grep` can silently drop lines** when binary-content files leak raw bytes into
  printed error messages. Diff carefully.
- A whitespace-only harness change needs a **path + embedded-name diff**, not the line/col-sensitive
  normalized one.
- **"No errors.txt" is not proof of zero diagnostics** — cross-check the `.js` baseline too. One
  corpus baseline (`propertyAccessNumericLiterals.ts`) is itself stale/inconsistent.
- A fix can be invisible to "did it throw" and still be wrong — item 48 caught `3.e5` misparsing as
  `(3.).e5` only by dumping the AST.

**Known open / deliberately deferred:** index-signature-after-ASI; `export = <arbitrary expr>` (a
tree-shaking correctness risk); `await` as an identifier outside `async` (documented "not fully
contextual" gap); `import type from './a'` and `declare` as a binding name — both need multi-token
lookahead, judged not worth it for narrow cases.
