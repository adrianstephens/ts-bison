---
name: tison-array-identity
description: "RESOLVED (014ac83): `Array<T>` owns its storage (a `RawArray<T>` field), so a mutator replaces a field every alias shares; the compiler knows only `RawArray` (`{arr}`)"
metadata:
  type: project
---

**Resolved in 014ac83 (2026-09-14).** `Array<T>` compiled to the bare wasm-GC array, so `push` & co.
reallocated and wrote back to the receiver's lvalue only; every alias kept the old array (`const b = a;
b.push(1); a.length` was 0; towasm's own `worklist` stayed empty). Tests: test-towasm.ts "array identity: ...".

**The design (settled with the user, after several rejected intermediate forms):**
- `WasmType`'s `{arr}` means a WASM ARRAY and nothing else -- `RawArray<T>`, a string, an `ArrayBuffer`, a
  bigint's limbs. A `grow` flag and a separate `vec` variant were both tried and rejected.
- `Array<T>` is an ordinary lib class: `private data: RawArray<T>`, ordinary constructors, mutators do
  `this.data = ...`. No `this =`, so arrays no longer touch `assignsToThis`/`reassignsThis`.
- The compiler knows `RawArray` and nothing of `Array`'s layout. A literal builds raw storage; `coerceTop` boxes it by
  calling the wanted class's ADOPTING constructor (its one-parameter `RawArray` overload, `adoptingDecl`; a typed
  array's `ArrayBuffer` ctor qualifies too). There is no unbox. `emitAs` boxes a raw array before it is erased into
  a non-raw slot -- the last point it has a single reference.
- Element access goes through ordinary members: bounds via `length` (`isPositional`: a numeric `__get` and a real
  `length`), a spread reads `length`/index per element (only same-kind raw storage is `array.copy`d), iteration
  follows `[Symbol.iterator]` (lib.d.ts gives arrays none, so they are read by position), for-in calls
  `_indexKeys(length)`. Cost: calls where there were inline instructions (883ec32..6c4b505, 2026-09-14).
- Still representation-level `Array` references: `ensureClass`'s layout-argument collapse (`name === 'Array'`) and
  union dispatch's added `Array<any>` form. The `T[]` -> `Array<T>` mappings are TS's own semantics, not these.
- Rawness is NAMED (`RawArray<T>`), never inferred from the element: `u32[]` IS `Array<u32>`.
- `Array.isArray` is `instanceof ArrayBase`, a field-less supertype of every instantiation -- lib-only now.

**Traps hit on the way (each cost a round):**
- Deferring the box past erasure ("box on read if still raw") is unsound: each lazy box is a new identity,
  so two readers of one `any` get two arrays. Asked by the user and answered.
- Fixing erasure FLIPS `isArray`: raw storage in `any` was what made `ref.test (ref array)` answer true.
- A type that merely RESOLVES to an array (alias, `N[K]`) must map like the `T[]` spelling, or it falls to
  the module-level `wasmTypeOf`, which still answers raw storage.
- Every "is it an array?" test (`'arr' in w`) had to become "what storage does it hold?" (`storageKindOf`).
  Missed twice: the spread helpers `arrayKindOf`/`objectArrayKind` (9deefcb) -- seen only as the survey's spread
  row jumping 3 -> 58. After any representation change, grep every `'arr' in` and diff the survey's cause rows.

**Predicted but did not happen:** distinct structs per instantiation (`Array<string>` vs `Array<any>`) did
not break views through `any` -- an `any` receiver dispatches dynamically and never meets a `ref.cast`.
Struct merging (the user's suggestion) was therefore NOT built; reach for it only on evidence.

**Pre-existing bugs found:** a nullable primitive box was unboxed on its way into `any`, so one holding
null trapped at any `any` local, element or argument -- FIXED 2026-09-14 (a box goes into `any` as-is).
Still open: dynamic dispatch on `any` cannot call a rest method (`(y as T[]).push(x)`, HEAD too).
Also open, verified identical at 4e26dd4: `unknown method 'some'`; the `BigInt` ctor overload; `alwaysThrows`'s
`out` index. (`[0, ...t]` for a number tuple: FIXED a4c85c5 -- the spread converts per element.)
`Array.isArray(5n)` was true; now false.

**Direction (user, 2026-09-14):** boxing is the class's own `RawArray`-adopting constructor, not field knowledge; the user
suggests extending that automatic boxing to bigint and string too. Inlining (in the compiler or a pre-pass) is wanted
eventually -- it is what makes routing element access through ordinary `Array` members cheap again.

**Instruments:** `assistant/suite-all.py` runs test-towasm.ts non-aborting, listing every failing block with
its line. `assistant/probe-block.py <root> <N>` runs one block and prints its source, its error and, for a
wasm trap, the trapping function's WAT. Follow-on: amortized `push` needs a separate `len` field, and every
`array.len` bounds check would then have to route through it. See [[tison-type-vs-representation]].
