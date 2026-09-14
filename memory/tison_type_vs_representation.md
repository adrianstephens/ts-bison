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

**History, and a prediction that did not hold:** before 014ac83, `ensureClass('Array', [Node])` and
`('Array', [Foo])` shared one physical type, because the constructor-returnType mechanism answered with a
representation. 014ac83 made `Array` an ordinary class, so they are now distinct structs. This note used to
predict that would stop a `Node[]` flowing into an `any[]` slot. It did not: an `any` receiver dispatches
dynamically and never meets a `ref.cast`. Struct merging stays a tool to reach for on evidence only -- see
[[tison-array-identity]].
