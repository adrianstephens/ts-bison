---
name: tison-codegen-processobject-typecheck-gap
description: "A TypeScript generic-inference gap in the codegen layer's object-field-mapping helper let a real field-name typo (target vs key) compile silently for months; documents the fix and the general lesson (file since renamed, see top note)."
metadata:
  type: project
  originSessionId: fcd30430-e308-43a7-8c5e-ab07ddc98836
  modified: 2026-08-18T02:27:51.032Z
---

**STALE FILE REFERENCE (confirmed 2026-08-18): `examples/ts-codegen.ts` no longer exists.** It was split
into `tocode.ts` (rendering)/`checker.ts` (type checking)/`transform.ts` (`TStoJS`/`TStoDecl`/
`TStypeCheck`)/`type-utils.ts` (`Type`/`Scope`/`isAssignable`/etc) at some point after this memory was
written. The specific helper below (`processObject`) is now `mapObject` in `walker.ts`, and `TSwalk` is
now `walk`/`walkB`, also in `walker.ts`. The bug/fix narrative and the general lesson at the bottom are
still worth reading, but re-verify `mapObject`'s current signature in `walker.ts` before citing it as fact
-- don't assume it's unchanged since this was written.

`examples/ts-codegen.ts`'s `processObject<N, F>(node: N, fields: F)` helper (used throughout `TSwalk`/`TStoJS`/`TStoDecl`) originally inferred `fields`'s shape as its own free generic `F extends Partial<{[K in keyof N]: ...}>`, then checked `F extends` that constraint. This is a constraint-satisfaction check, not contextual typing, and TypeScript's excess-property check only reliably fires during contextual typing.

**The gap was worse than "generics skip excess-property checks" (the usual folklore):** empirically, an object literal with an invalid key was actually still caught IF every key was invalid — but a literal mixing one *valid* key with one invalid key silently passed. Verified via minimal repros (`declare const p: Param; processObject(p, {target: fn})` errors; `(p: Param) => processObject(p, {target: fn1, default: fn2})` — wrapped in a function parameter, mixed valid+invalid keys — did not).

**Fix:** stop inferring the fields-shape as its own generic parameter. Write the parameter's type directly in terms of `N` (already resolved from the first argument): `fields: Partial<{[K in keyof N]: (x: Exclude<N[K], undefined>) => Exclude<N[K], undefined> | undefined}>`, no separate `F`. This restores real contextual typing of the object literal argument, and the excess-property check fires correctly in all cases (all-invalid, mixed, all-valid).

**What it caught:** `processParam` (used by every `function`/`arrow`/`function_decl` case in `TSwalk`) had `target: processBindingTarget` where `Param`'s actual field is `key`. This silently no-op'd — `processObject`'s runtime loop only touches fields present on the actual object (`node[k] !== undefined`), so a `target` key it iterates over never matches anything real. Net effect: a destructured parameter's default expression (e.g. `({a = foo() as any}) => ...`) never got recursively processed by `TStoJS`/`TStoDecl`, so an `as any` (or any other TS-only construct) buried in a destructuring default survived untouched in "plain JS" output. Fixed to `key: processBindingTarget`; verified the `as any` is now stripped correctly. Full corpus/suite re-verification showed this was the *only* site the gap had actually bitten (all other `processObject` call sites in the file were already using correct field names).

**General lesson for any future `processObject`-shaped helper (in this codebase or elsewhere):** if a generic wrapper function accepts an object literal whose keys are meant to be validated against another already-resolved generic parameter, don't infer the literal's shape as its own separate constrained generic — write its parameter type directly as the mapped/constrained type expression itself, parameterized only by the already-resolved type. Otherwise excess/misspelled keys can compile silently, and only when *some* other key in the same literal happens to be valid.
