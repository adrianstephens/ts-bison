---
name: feedback-towasm-symbol-index
description: Build a one-off symbol index before hunting through backend.ts — it was named in 575 separate read/grep/sed calls over 8 sessions.
metadata:
  node_type: memory
  type: feedback
  modified: 2026-09-16
---

Before working a row that means finding several functions in `src/examples/TS/backend.ts`
(12,410 lines, and the most-read file in the repo by 3x), build a symbol index once:

```sh
grep -n "^\tfunction \|^\tconst \|^function \|^export " tison/src/examples/TS/backend.ts \
  > tison/assistant/towasm-index.txt
```

then grep that file for a name instead of scanning the source. Same for checker.ts (3,051) and
type-utils.ts (3,498) when a row spans them.

**Why:** measured over 8 sessions (2026-09-16), backend.ts was named in 575 separate read/grep/sed
calls — 575 turns spent locating things rather than changing them. Each lookup is a round trip, and
turn count is what dominates token cost. Much of it is re-derivation: after a compaction the file
layout learned earlier in the session is gone and gets re-grepped from scratch.

**How to apply:** the index is one-shot scratch — delete it when the row is committed, and rebuild
it next time rather than trusting a stale one (line numbers move under every edit). Do not read the
index wholesale into context; grep it. For the same reason, anchor edits on unique surrounding text
rather than line numbers.

Related: [[feedback-two-tier-gates]], [[tison-towasm]], [[tison-towasm-self-hosting-plan]].
