---
name: feedback-no-name-special-casing
description: "In backend.ts, dispatching on a hardcoded method/function name (e.g. \"if methodName is one of push/pop/shift/unshift\") is unacceptable even as a working first cut -- always find the structural/shape-based trigger instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 888c0914-2616-44d9-97e8-90264c57a251
  modified: 2026-08-08T23:03:23.393Z
---

User's own words: "having to special-case 'push', 'pop', etc is taking us in the wrong direction - it should
be an absolutely last resort. We must find a general mechanism that will work for any similar situations
(cleanly and efficiently)." This came *after* I'd already shipped a working, tested, tsc-clean implementation
that special-cased exactly those four names in `case 'call'` — being correct and verified was not enough; the
mechanism itself was the problem. See [[tison_towasm_array_mutators]] for the full before/after (round 1:
~100-line hand-rolled per-method-name codegen; round 2: a structural `assignsToThis`/`reassignsThis` trigger
+ real wasm multi-value results, ~10 lines at the call site, reusing `emitAssignTarget`/`emitMethodCall`
as-is, works for any class/method automatically).

**Why:** this matches the file's own established convention throughout (`scanInlineMethods`'s asm-body
recognition, `methodSig`'s get/set-by-probe dispatch, `namespaceOwner`) — every existing "special" behavior in
backend.ts is triggered by recognizing a *shape* in the declared TS source, never by a hardcoded name/owner
list. A name-based special case is a smell specifically *in this file* even when it works, because the whole
multi-session project arc here is "remove special-casing from backend.ts" (see memory index) — new
special-casing is directly counter to the standing goal, not a neutral tradeoff.

**How to apply:** before writing `if (name === 'foo' || name === 'bar' || ...)` (or `owner.name === 'X'`) in
backend.ts, stop and ask: what *shape* in the source (an assignment to `this`, a body that's just one
`__asm(...)` call, an empty-args-callable `get`/`set` pair) actually distinguishes the cases that need special
handling from the ones that don't? Build the detector around that shape so it generalizes to classes/methods
that don't exist yet, even if that means more up-front machinery (e.g. real multi-value wasm functions) than
the name-list shortcut would have needed. If genuinely no shape-based trigger exists and a name check is
unavoidable, say so explicitly and ask before implementing, rather than shipping the special case first.
