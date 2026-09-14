---
name: tison-array-identity
description: "BLOCKER for self-hosting: `Array<T>` IS the bare wasm array, so `push` reassigns the binding and every ALIAS of the array silently keeps the old value"
metadata:
  node_type: memory
  type: project
---

`Array<T>` is compiled as the bare wasm-GC array itself (`lib/array.ts`: `length` is `array.len`,
`__get` is `array.get $this`), so capacity IS length and a mutator cannot grow it in place. `push`/
`pop`/`shift`/`unshift` therefore allocate a new array and the CALL SITE writes it back to the
receiver's lvalue ([[tison-towasm-capabilities]]'s `reassignsThis`, archived design memory
`tison_towasm_array_mutators`). That is only correct when the receiver's binding is the array's ONLY
reference. JS array identity is shared, so every alias diverges, silently:

| shape | JS | towasm (2026-09-14) |
|---|---|---|
| `const b = a; b.push(1); a.length` | 1 | **0** |
| `function add(v: number[]) { v.push(1) } add(a); a.length` | 1 | **0** |
| `const f = () => { a.push(1) }; f(); a.length` | 1 | **0** |
| `box.items.push(1); box.items.length` | 1 | 1 (a field IS the shared location) |

**This blocks the self-hosting goal outright**, independently of every row in the cause table. towasm.ts's
own `const worklist: (()=>void)[] = []` (towasm.ts:1857) is pushed 15 times from nested functions; the
reduced shape returns 0 where node returns 306, i.e. a self-compiled towasm would emit nothing at all.
207 `.push(` sites across the target set.

**Proper fix (not started):** give a growable array a stable identity — represent `Array<T>` as a struct
`{ data: (array (mut T)), len: i32 }`, so a mutator replaces `data`/`len` IN PLACE and every alias sees it.
Also makes `push` amortized O(1) (it is O(n) per call today) and retires `reassignsThis` for arrays.
Blast radius is concentrated but real: ~100 sites in towasm.ts (`ARR_WTYPE` 25, `ensureArrayType` 30,
`'arr' in` 22, the `array.*` emitters) plus most of `lib/array.ts` (366 lines). Strings share the wasm
array form but are immutable, so they can stay bare; typed arrays are already structs over linear memory.

Found 2026-09-14 while clearing the cause table's top row (35f5b83): the void-return throw had been
accidentally MASKING this for `forEach(x => out.push(x))`, which now compiles and answers wrongly.
