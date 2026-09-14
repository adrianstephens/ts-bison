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
- The compiler never names `Array`. A literal builds raw storage; `coerceTop` boxes/unwraps STRUCTURALLY
  ("a class owning exactly one field of this type"); `emitAs` boxes a raw array before it is erased into a
  non-raw slot -- the last point it has a single reference.
- Rawness is NAMED (`RawArray<T>`), never inferred from the element: `u32[]` IS `Array<u32>`.
- `Array.isArray` is `instanceof ArrayBase`, a field-less supertype of every instantiation.

**Traps hit on the way (each cost a round):**
- Deferring the box past erasure ("box on read if still raw") is unsound: each lazy box is a new identity,
  so two readers of one `any` get two arrays. Asked by the user and answered.
- Fixing erasure FLIPS `isArray`: raw storage in `any` was what made `ref.test (ref array)` answer true.
- A type that merely RESOLVES to an array (alias, `N[K]`) must map like the `T[]` spelling, or it falls to
  the module-level `wasmTypeOf`, which still answers raw storage.
- Every "is it an array?" test (`'arr' in w`) had to become "does it OWN storage?" (`storageKindOf`).

**Predicted but did not happen:** distinct structs per instantiation (`Array<string>` vs `Array<any>`) did
not break views through `any` -- an `any` receiver dispatches dynamically and never meets a `ref.cast`.
Struct merging (the user's suggestion) was therefore NOT built; reach for it only on evidence.

**Pre-existing bugs found, not fixed:** a nullable primitive box is unboxed on its way into `any`
(`const x: any = m` with `m = undefined` traps, HEAD too); dynamic dispatch on `any` cannot call a rest
method (`(y as T[]).push(x)`, HEAD too); `Array.isArray(5n)` was true (now false).

**Instruments:** `assistant/suite-all.py` runs test-towasm.ts non-aborting, listing every failing block with
its line. `assistant/probe-block.py <root> <N>` runs one block and prints its source, its error and, for a
wasm trap, the trapping function's WAT. Follow-on: amortized `push` needs a separate `len` field, and every
`array.len` bounds check would then have to route through it. See [[tison-type-vs-representation]].
