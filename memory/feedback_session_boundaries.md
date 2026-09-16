---
name: feedback-session-boundaries
description: The user asks "should you continue or should I start fresh?" — give a real recommendation, default to fresh after a committed fix, and update the handoff note before saying so.
metadata:
  node_type: memory
  type: feedback
  modified: 2026-09-16
---

The user routinely asks whether to continue the session or start a new one. Answer with an actual
recommendation and one line of reasoning — not "either is fine".

**Default: start fresh, once a fix is committed and [[tison-session-handoff]] is current.** A survey
row is the natural boundary.

**Say continue when** there is uncommitted work mid-fix, or the next step depends on something
learned this session that is not written down anywhere. If it is the second case and writing it down
is cheap, write it down and restart instead.

**Strong signal to restart:** the session has already compacted. The cheap context is gone, the
layout knowledge that made lookups fast went with it, and continuing pays the re-derivation cost
repeatedly rather than once.

**Before recommending fresh**, in this order: land the commit, rewrite the dated section of the
handoff note, and make sure nothing is parked in the tree that the note does not describe (no stash
is available here — see the no-tree-rewrites rule).

**Why:** context grows monotonically within a session and every turn resends it, so a session's cost
scales roughly with the square of its turn count. Measured over 8 sessions in this workspace
(2026-09-16), three sessions of ~5000 responses each were 93% of all content; the other five
totalled ~1000. A cold start costs perhaps 20–50k tokens of re-derivation, against carrying 100k+
of context through another thousand turns. It is not close — which is why the handoff note is worth
maintaining at all.

Related: [[tison-session-handoff]], [[feedback-two-tier-gates]], [[feedback-towasm-symbol-index]].
