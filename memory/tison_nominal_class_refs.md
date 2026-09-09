---
name: tison-nominal-class-refs
description: "tison rule (bfd0aeb): T.resolve keeps a ref naming a real class nominal; the four consumers that need a member list call T.resolveMembers. Replaced eight per-site guards."
metadata:
  type: project
---

**The rule (`bfd0aeb`, 2026-09-08)**: `T.resolve`'s `case 'ref'` returns the ref unchanged when
`ns.decl(name)` is a `class_decl`. This compiler dispatches on a class by NAME (`ownerFor`,
`ensureClass`, `ensureClassRef`); an expanded member list has no name left.

**The opt-out is `T.resolveMembers(t, scope, depth)`** — resolves, then expands one level if a ref
survived. Members it yields keep their own nominal refs. Exactly four call sites, all of them
reading a *structure* rather than a name:

- `lookupMember` — the member's own type
- `memberOptionalState` — whether that member is optional
- checker `case 'index'` — element / tuple / index-signature / named-key
- `typeofName` — `typeof` is a question about the structure

**Add a `resolveMembers` call, not a new guard**, when a consumer starts seeing a bare `ref` where
it wants `.members`. That is the whole point of the inversion.

**Interfaces and aliases still expand.** Keeping *every* ref nominal costs 6 real errors, all a
consumer doing member lookup or arity checking on an interface ref (`Property 'randomBytes' does
not exist on type 'Crypto'`, `Expected 3 arguments, but got 2`). The class-only line is exactly the
boundary between "consumers resolve by name" and "consumers expect a structural shape".

**What it replaced**: eight independent per-site guards against the same expansion, each with its
own comment, two of them recording that a general fix "already-regressed once when tried" —
`resolve`'s own `case 'array'`, `unionMembers`' raw-`t` return, `inferTypeArgs`' named preference,
`narrow`'s original-ref push, `hoistVar`'s `stopAtPseudoType` (+ a `stopAtClassRef` that lived one
commit), `flattenOwners`' raw-first `ownerFor`, towasm's `var_decl` narrowed-scope guard. The seven
that remain are no-ops for classes now and still carry interfaces/aliases.

**Measured** (all four instruments, `bfd0aeb` vs `303f7fd`): official TS suite ERROR **3799 ->
3331** with threw/GAP/WARNING identical; whole-workspace ERROR 238 -> 226; corpus gate 1565 =
baseline; difftest 2087/2100 unchanged; test-towasm green. Baselined with an in-place toggle —
see [[feedback_baseline_in_real_tree]].

Also in that commit: `combineTypes` drops `never` (a union's identity element). A `Stream | never`
out of a branch merge made `ownerFor` answer nothing at all; `unionMembers` already had the rule.

Prerequisite context: [[tison_towasm_self_hosting_plan]], [[tison_towasm]].
