---
name: tison-nested-array-element-kind
description: "towasm.ts: a nested array's inner arrays keep their DECLARED element kind, not 'ref' — and `Array<any>` methods still lose it (open bug)"
metadata:
  node_type: memory
  type: project
---

For `number[][]`, the outer array is ref-kind (one boxed `anyref` slot per element), but the inner
arrays stored there keep their own **declared** element kind — a real `(array (mut f64))` — and every
read casts back down to it. The rule: whatever constructs the inner value must honour the declared
element type, because the read side casts to it.

`objectArrayKind` and `classOfForIndexing` each carry a DISABLED ref-collapse override (commented out
2026-08-28, e5c556d) that would have made every value read out of a ref-kind element 'ref'. Their
header comments described that dead code as live fact — corrected 2026-09-14; if you re-enable either,
the comments are what to update first.

Verified 2026-09-14 while fixing `(a[i] ??= []).push(x)` (commits e879edc/362bfc7/66878d8): an empty
inner literal ignored the contextual element type and built a boxed-any array, so `const a: number[][]
= [[], []]; a[0].length` trapped with "illegal cast" while `[[1],[2]]` worked. Fixed in `case 'array'`.

**Still open, same root, different path:** `const a: number[][] = []; a.push([]); a[0].length` still
traps. `Array<T>`'s methods are monomorphized at `T = any` for every non-scalar element, so `push`'s
rest-arg contextual type is `any`, not `number[]`, and the argument literal builds boxed-any storage
the read then can't cast. Fixing it means carrying the receiver's declared element type into argument
contextual typing across that monomorphization — not a `case 'array'` change.

Related: [[tison-towasm-capabilities]], [[tison-towasm-self-hosting-plan]].
