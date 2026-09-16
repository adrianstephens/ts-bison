---
name: tison-shape-key-collision
description: RESOLVED (f0d019c) -- object shapes were keyed by bare interface name, so same-named interfaces in different modules shared one wasm struct
metadata:
  type: project
---

`ensureObjectShape` keys a shape `name<args>` with no module in it, so two modules that declare the
same interface name share one struct: common.ts's `Member`/`Index`/`Call` against js-parser's own
`Member`/`Index`/`Call` (which add `optional?`), plus `Binary`, `Conditional`, `Literal`, `Unary`,
`UnaryPost`. Whichever is built first wins; a literal for the other is then checked against its
fields (`object literal for 'Member<any>' has unknown property 'optional'`).

Latent until a namespace-qualified base resolves at all — see [[tison-namespace-qualified-interface]].

**Why detection is not enough:** keeping the bare key for the first declaration and giving later ones
a suffix fails, because `ensureClass` is also asked by KEY (`want.ref`), where no declaration can be
named, and because a function's result wtype bakes in whichever key was current when it was lowered.
**Resolved in f0d019c:** the key is qualified by declaring module for every shape outside the entry module
(`moduleBodies` maps module -> scope), so no two declarations can share one, with a guard in
`ensureClass` so a bare-key hit from another declaration does not short-circuit. Regression test: `two modules declaring the same interface name keep their own shapes` (needs a REFERENCE type argument, or the key never collapses to `<any>`).
