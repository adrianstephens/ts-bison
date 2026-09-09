---
name: tison-closure-param-causes
description: "The self-hosting survey's `closure parameter 'X' needs an explicit type` rows are MIS-LABELLED — root-caused 2026-09-09 to three unrelated blockers (a union-tuple rest, an unimplemented lib overload, and rest-to-params binding). Read before working that row."
metadata:
  node_type: memory
  type: project
---

At `57e87b9` the survey's top rows were `closure parameter 'self' needs an explicit number/boolean/
object type` (18 decls, ts-parser.ts/js-parser.ts), `'hex'` (6, js-parser.ts) and `'param 'lex''` (5).
The shared message makes them look like one cause. **They are three different blockers**, and none of
them is "the closure literal cannot type its own parameter".

## What the message actually means

`emitClosureLiteral` (towasm.ts ~4590) throws it when a parameter has no `typeAnnotation`. The
checker's `applyContextualParams` normally back-fills one, so the throw only means **the checker could
not contextually type this callback** — the interesting question is always *why*, never the throw.

Instrument it by printing `want` at the throw: `want=closure,...` means the expected type arrived and
something else is wrong; `want=ref`/`want=arr` means the wrong signature was selected upstream.

## `self` (18) -- a rest parameter typed as a UNION CONTAINING A TUPLE

	export function Rules<T>(...alts: [(self: () => Rules<T>) => Rules<T>] | Rules<T>): Rules<T>;

`want` arrives as `ref` (the `Rules<T>` arm), never the tuple arm's function type, so `self` gets
nothing. Needs contextual typing to pick the tuple member of a union rest parameter and index it
per-argument. NOT fixed.

## CLOSED `e97b848`: `hex` -- it was `String.replace(re, fn)` being unimplemented

	s.replace(/.../g, (_, hex, ubrace, u4, ch) => ...)      // js-parser.ts's `unescapeString`

`want=arr` at the throw: `lib/string.ts` implements only `replace(regexp, replacement: string)`, and
its own comment says "the function-replacer overload real JS also has is out of scope". lib.d.ts
declares both, so the checker is happy and towasm picks the only implemented signature — a string,
which is physically `arr`. **The closure typing is a red herring.** Implementing it is real lib work
and needs the next item first, since the callback takes `(substring, ...groups)`.

## CLOSED `eaeef6b`: a closure literal could not bind params out of a REST

A rest parameter is physically ONE array here, so a literal with more parameters than the callee has
fixed ones cannot match:

	function apply(f: (first: number, ...rest: number[]) => number): number { return f(1, 2, 3); }
	apply((a, b, c) => a + b + c);
	// internal: cannot convert (f64,f64,f64)=>f64 to (f64,arr:f64)=>f64

The literal must compile with the DECLARED physical signature (fixed params + rest array) and bind
each extra parameter from `restArray[k]` in its prologue. Not implemented.

## A prerequisite that is written and REVERTED, and why

Carrying the callee's parameter types into an unannotated literal (a `restElem` on `FuncSig`, always
populating `resolvedParams` in `closureSigParts`, and reading both in `emitClosureLiteral`) is real
and gets the repro above from "needs an explicit type" to the `cannot convert` line — but it unblocks
**zero** declarations alone, so it was not committed. Rebuild it as step 1 of the rest-binding work.

## Two measurement traps this cost a session

- **`probe-decl` and the survey are DIFFERENT INSTRUMENTS.** A declaration's survey cause and its
  `probe-decl` throw can differ at the same commit. Comparing one against the other reads as
  "moved to a new cause" when nothing moved. A/B the SAME instrument across an in-place toggle.
- **A passing new test proves nothing until you run it against the un-fixed tree.** Three tests of
  contextual closure parameters passed with the fix reverted: `applyContextualParams` already handles
  the simple shapes, so they never exercised the change. See [[feedback_baseline_in_real_tree]].

Related: [[tison_towasm_self_hosting_plan]], [[tison_checker_inference]].

## RESOLUTION 2026-09-09 -- two of the three are closed

`eaeef6b` (rest-to-parameters binding + contextual parameter types) and `e97b848` (the
`String.replace` function replacer, plus contextual typing past the fixed params, a closure
literal argument resolving through a UNION parameter, and calling a union member narrowed by
`typeof x === 'function'`) between them **moved 30 declarations**, measured against a correctly
set `selfhost-survey.prev.json`. The `closure parameter 'hex'` and `unknown field 'recover'`
rows are GONE from the cause table entirely; `compiled` stayed at 56/270, as it does through
serial blockers.

**`self` (19) is still open** and is still the top row -- a rest parameter typed as a union
CONTAINING A TUPLE (`Rules<T>(...alts: [(self: () => Rules<T>) => Rules<T>] | Rules<T>)`). The
union machinery `e97b848` added is for a union PARAMETER whose member is a function; this needs
the tuple ARM of a union REST, indexed per argument. Next target.

Two new rows appeared where those declarations landed: `14 | towasm.ts | 'typeAnnotation' needs
an explicit number/boolean/object type` and `4 | js-parser.ts | 'any' (ref:TextPos) cannot be
used as a boolean condition`.
