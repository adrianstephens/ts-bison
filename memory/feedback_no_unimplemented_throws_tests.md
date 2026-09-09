---
name: feedback-no-unimplemented-throws-tests
description: "Don't write/keep tests whose only point is \"this unimplemented feature throws\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c2e69915-5131-4028-bab6-a72ffab7a920
  modified: 2026-08-01T01:10:53.008Z
---

Don't add or keep a test whose entire purpose is asserting that an unimplemented feature throws
(e.g. "push() is rejected (no resizing methods)", "'for...in' is rejected", "new String(number) is
rejected (no general stringification)"). Applied 2026-07-31 to [[tison_towasm]]'s test-towasm.ts: removed
4 such `checkThrows` cases (push/string-index-read/string-by-value-equality/for-in), each one testing
absence of a feature rather than correctness of one that exists.

**Why:** these tests don't guard a real invariant — if the feature ever gets implemented, the test just
starts failing and has to be deleted anyway; until then it's pinning a gap, not a behavior. Low value,
adds noise.

**How to apply:** keep `checkThrows`-style tests that validate a *real, permanent* enforced behavior —
arg-count/arity validation (a real safety-net mechanism, since the general checker doesn't check these
calls at all), void-handling rules, the `TStypeCheck`-gate contract itself, and similar. The distinguishing
question: is this throw a deliberate, permanent part of the design (worth protecting from regression), or
just "we haven't built this yet" (not worth a test until it's built)?
