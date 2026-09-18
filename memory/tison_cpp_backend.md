---
name: tison-cpp-backend
description: CPP/backend.ts — the partial C++ wasm back end that exists to keep wasm-codegen.ts honest. What it covers, why it is deliberately small, and the trap it found.
metadata:
  type: project
  modified: 2026-09-17
---

`src/examples/CPP/backend.ts` (379 lines, `607896b`) compiles a small C++ subset to wasm over the neutral
`wasm-codegen.ts`. It is not a compiler and is not trying to become one — **its job is to be the thing that
breaks when a "neutral" helper quietly assumes TypeScript.**

## What it covers

Scalar types (`int`/`long`/`short`/`char`/`unsigned*`/`float`/`double`/`bool`/`void`), functions, locals,
`if`/`while`/`break`/`continue`/`return`, the usual arithmetic conversions, direct calls by name, unary
`-`/`!`, and `?:`. Anything else throws `W.Error` rather than miscompiling — pointers, references,
arrays, classes, templates, overloads and the standard library are all out of scope on purpose.

`test/test-cpp-backend.ts` compiles, instantiates and **runs** the output (gcd, recursive fib, an f64
accumulator, i64 past 2^31, nested `?:`, `break` from `while (1)`), plus three out-of-scope constructs that
must throw. Running it matters: two of the bugs below produced valid-looking wasm that hung or answered
wrong, and only execution caught them.

## Why it is worth keeping

It was written **without adding or changing one line of `wasm-codegen.ts`**. `FunctionContext` (locals and
slot reuse via `inScope`, `emitIf`, `emitLoop`, `emitBreak`/`emitContinue`, `toFuncBody`,
`emitTrailingUnreachable`), `Types` and `W.Error` were all consumed as-is. The C++ side is the AST walk
plus `toValType`, passed as a parameter — exactly the seam [[tison-towasm-cross-language-plan]] predicted.

**Do not read 379 vs `TS/backend.ts`'s 9,697 as a measure of anything.** It buys a fraction of the
features. What the gap actually measures is that almost none of the TS back end is wasm: it is `any`-boxing
and runtime dispatch, object shapes, closures, classes, generics, overloads and async/generator lowering.
C++ hands you the types and asks for none of it.

## What it found, within an hour of existing

1. **`emitIf` opens a wasm block and so shifts every enclosing branch depth.** The contract was
   caller-accounts (`TS/backend.ts`'s `case 'if'` did it; nothing else did), and the failure is invisible —
   a `break` inside an `if` targeted the loop's restart instead of its exit and spun forever. Fixed
   properly at `460b781` by making `emitIf`/`emitBlock`/`emitLoop` own their own depths.
2. **A real precedence bug in tison itself** — `?:` bound tighter than every binary operator. See
   [[tison-precedence-resolution]]; half fixed at `87a809b`, the `OneOf` half still open.

That is the argument for keeping it green: a second front end exercises the neutral layer and the grammar
in ways the TS test suite structurally cannot.

Related: [[tison-towasm-cross-language-plan]], [[tison-session-handoff]], [[tison-precedence-resolution]].
