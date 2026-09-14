---
name: tison-type-vs-representation
description: "towasm: a TS type and its wasm REPRESENTATION are many-to-one and must stay separable -- `number` is usually `f64` but may be `i32`/`u32`, and `Node[]`/`Foo[]` share ONE physical array type"
metadata:
  node_type: memory
  type: project
---

**Do not force type and representation together.** `number` is canonically `f64` but may be `i32`,
`u32`, `i64`… depending on where it lives; `u32[]` is a `number[]` whose elements are i32-backed.
Conversely one representation serves many types: `Node[]` and `Foo[]` are both `{arr:'ref'}`.

The vocabulary already separates them: `TYPED_ARRAY_TAGS` (`i8`/`u8`/`i32`/`u32`/`f64`…) are
REPRESENTATION names usable in type position, while `number`/`string`/a class name are TYPE names that
get a representation derived from them. Anything asking "how is this stored" must read the tag when
there is one and only fall back to resolving the type — `typeOf(u8)` widens to `u32`, so resolving a
tag AS a type silently loses the packing (this produced an i32-element `ArrayBuffer`, 2026-09-14).

**Where this is load-bearing:** `ensureClass('Array', [Node])` and `('Array', [Foo])` are two distinct
`ClassInfo`s (separate method instantiations) that resolve to ONE physical type index. What collapses
them is the constructor-returnType mechanism: `typeOf(Array<T>)` answers with a representation, and
`info.typeIndex` follows from that rather than from the instantiation key (`genericKey`/`typeKey`,
which keeps tag arguments verbatim but is otherwise keyed by type).

So **retiring that mechanism for `Array` would give one struct per element TYPE** — `Node[]` and
`Foo[]` becoming distinct wasm types with identical layout, and a `Node[]` no longer flowing into an
`any[]` slot. If it is retired (see [[tison-array-identity]]'s next step), `Array`'s physical
instantiation must first be keyed on the element REPRESENTATION, which the tag machinery already
allows — then one struct per kind falls out and the declared `data` field can build it.
