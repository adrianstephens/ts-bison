---
name: tison_towasm_exceptions_design
description: "Verified design + empirical runtime facts for implementing try/catch/throw/finally across binary-libs/src/wasm.ts and tison/src/examples/TS/towasm.ts, targeting the exnref/try_table wasm proposal -- supersedes tison_towasm_exceptions_prereq_research's legacy-proposal recommendation"
metadata: 
  node_type: memory
  type: project
  originSessionId: fb0b1e0a-9cc5-4c79-8eda-25bd75ff0a14
  modified: 2026-08-19T00:54:49.309Z
---

Session 2026-08-18: designed exception handling for [[tison_towasm]] in EnterPlanMode, approved plan
at `/Users/adrianstephens/.claude/plans/federated-puzzling-yeti.md`. Supersedes
[[tison_towasm_exceptions_prereq_research]]'s "target legacy EH" recommendation -- mid-session another
agent independently started the binary-libs/wat-parser.ts prerequisite targeting the newer, standardized
exnref/`try_table` proposal (Wasm 3.0) instead, and the user chose to keep that rather than revert.

## Decision: exnref/try_table proposal, not legacy try/catch/rethrow/delegate

Both were empirically tested this session (hand-built wasm modules through real `WebAssembly.validate`/
`Instance`/exported-function calls on this repo's `node`, v23.1.0/V8 12.9 -- not just encoding checks):

- **Legacy** (tag section + `try`0x06/`catch`0x07/`throw`0x08/`rethrow`0x09/`delegate`0x18/`catch_all`0x19,
  inline-handler catch bodies): works with **zero flags** on this Node.
- **New/exnref** (`try_table`0x1F + `throw`0x08/`throw_ref`0x0A, branch-target catch clauses via
  `catch`/`catch_ref`/`catch_all`/`catch_all_ref`): needs `--experimental-wasm-exnref` (off by default,
  confirmed via `node --v8-options` and a live `CompileError: Invalid opcode 0x1f`). **Fix: call
  `v8.setFlagsFromString('--experimental-wasm-exnref')` once before the first `WebAssembly.Module` compile
  in the process -- confirmed sufficient, no CLI flag needed.** Add this one line near the top of both
  `binary-libs/test/test-wasm.ts` and `tison/test/test-towasm.ts`.

Kept the new proposal: standards-track, matches the branch-target dispatch shape to `towasm.ts`'s own
existing `switch` idiom better than legacy's inline-handler shape, and the flag gap is a one-line fix, not
a real limitation.

## What was already implemented (by the other agent, this session, before this plan)

`binary-libs/src/wasm.ts`: `TagType`/`TagSection` (section id 13, correctly placed between `memory`(5) and
`global`(6) in `WasmModule.write()` -- verified empirically that section *order* matters, not the numeric
id, same precedent as `dataCount`(12) sitting between `elem`(9)/`code`(10)), `EXPORT_KIND` gains `'tag'`,
new instructions `throw`(0x08)/`throw_ref`(0x0A)/`try_table`(0x1F) + `CatchClause`/`Catch` helpers
(catch/catch_ref/catch_all/catch_all_ref), WAT pretty-printer support. `tison/src/examples/wat-parser.ts`:
matching textual syntax (`tag` module field, `try_table`, `throw`, `throw_ref`, catch-clause forms). Not
yet done at that point: any test coverage, and all of `towasm.ts`'s own consumption (the actual compiler
feature) -- both covered by the plan.

## Empirically verified mechanics (all confirmed by real execution, not just validate)

- Tag section + `try_table` + `throw`/`catch`(tag,label) + a real GC-struct payload delivered through the
  tag's `(anyref)->()` param type, `ref.cast` back to the concrete type on the catch side: works.
- `catch_all_ref` + `throw_ref`: catching *any* exception as an opaque `exnref` and later re-raising the
  *same* one -- this is `finally`'s mechanism (no legacy `rethrow`/`delegate` needed).
- **Non-obvious gotcha, cost real trial-and-error to find:** a block used purely as a `catch`/
  `catch_all_ref` branch target needs an explicit `unreachable` (or other stack-polymorphic instruction) as
  the literal last instruction in *its own* sequence, whenever the wrapped `try_table`'s normal-fallthrough
  edge is never actually taken (i.e. whenever the try body's success path exits early via an explicit `br`
  instead -- the normal case once there's a "what happens after a successful try" continuation). Without
  it: `CompileError: expected N elements on the stack for fallthru, found 0` -- because the validator still
  type-checks the block's *declared* result against what `try_table` produces on its own dead fallthrough
  edge, regardless of real reachability. See the plan file's Phase 1 code shape for the fix in context.

## Design highlights (full detail in the plan file)

- One project-wide tag, type `(anyref)->()` (JS `catch(e)` is untyped/catches everything -- no reason for
  more than one tag). `throw`/`catch` value marshalling reuses `towasm.ts`'s existing `coerceTop`/`emitAs`/
  `ensureBoxType` any-boxing machinery (towasm.ts:1591-1652) -- zero new boxing design needed.
  `checker.ts` already fully types `try`/`throw`/`catch` (confirmed in [[tison_towasm_exceptions_prereq_research]]).
- Catch dispatch = two nested blocks (`$after` outer landing point, `$catchLand` inner = the catch clause's
  own branch target), success path inside `try_table` ends with an explicit `br $after` skipping the
  handler -- structurally the same "shared landing block, arms branch past siblings" idiom `towasm.ts`'s
  own `switch` already uses.
- `finally` (+ any break/continue/return crossing it) uses **one unified mechanism**, not two: because
  `try_table` dispatch is branch-based, every exit (normal, caught, uncaught via `catch_all_ref`+
  `throw_ref`, or an escaping break/continue/return) can funnel through one shared landing block that runs
  `<finally>` once then re-dispatches on a recorded action code -- this is a direct simplification from
  `try_table`'s shape versus what a legacy-proposal design would have needed (two separate phases: a
  finally-body-duplicated-twice fast path, plus a separate action-variable path only for escaping exits).
  Guard the cheap (no-dispatch) path with a structural helper mirroring `containsOwnBreakOrContinue`
  (transform.ts:392-403, extended to also flag `return`).
- `try`/`await`/`yield` suspend-crossing stays out of scope for v1, for free: `flattenStateMachine`'s
  `isFlattenable` (transform.ts:485-489) already excludes `'try'`, already rejects with a clear error.

## Progress

- **Phase 0 (binary-libs prerequisite): CLOSED.** Done by the other agent before this plan even started
  (confirmed via direct coordination mid-session) -- tag section, throw/throw_ref/try_table + full catch
  family, multi-value blocktypes, verified against real wasmtime, 0 lint errors. towasm.ts was untouched
  except one line (`assertFlatInstrs` also rejects `try_table` in inline asm, same as block/loop/if).
- **Phase 1 (basic try/catch in towasm.ts): CLOSED, same session.** Added `ensureExceptionTag()` (lazy,
  memoized via the existing `registerFuncType`/`registerType` cache, mirroring `ensureBoxType`'s exact
  precedent) plus `case 'throw':`/`case 'try':` in `emitStmt`'s switch (towasm.ts, right before
  `case 'function_decl'`/`default`). `mod.tags` assigned conditionally near `mod.datas`/`mod.elements`
  (only when actually used). Gap comment (towasm.ts:19) narrowed from "exceptions (try/catch/throw/
  finally)" to just "'finally'".
  - **Confirmed for free, no extra code needed:** `break`/`continue`/`return` crossing a `try`/`catch`
    with no `finally` present just works, because `ctx.enterLabel()`/`exitLabel()` around the two new
    wrapping blocks is the *same* general depth-relative `br` mechanism every other nesting construct in
    the file already uses -- a real `br`/`return` naturally passes through real wasm block boundaries.
    Verified by a real test (`breaksFromTry`/`returnsFromTry` in test-towasm.ts) before trusting it.
  - **`e as SomeClass` inside a catch handler does NOT narrow for field access** -- found while writing
    tests, NOT a bug in this feature: `unwrapAs` (towasm.ts:631-635, pre-existing, used by `ownerOf`/
    `classOf`) deliberately discards an `as` cast's asserted type for any codegen-facing owner/field
    lookup ("must unwrap it first or it sees a fictional type"), and this compiler has no `instanceof`
    at all (grepped, zero hits) -- so there is currently no way to narrow a caught `any` down to a
    concrete class for field access. Pre-existing, general, orthogonal gap, not a regression from this
    work; dropped that one test rather than working around it (per [[feedback_no_unimplemented_throws_tests]]-adjacent
    reasoning -- this isn't "test that it throws," it's "don't test something out of scope at all").
  - Tests added to `tison/test/test-towasm.ts` (needs `v8.setFlagsFromString('--experimental-wasm-exnref')`
    at the top, added there): no-throw path, caught-value round-trip, no-binding `catch {}`, nested
    try/catch with rethrow, `return` inside `try`, `break` inside `try` crossing an enclosing `while`, and
    an uncaught throw surfacing as a real `WebAssembly.Exception` to the JS caller. All pass. Both
    `tison`/`binary-libs` lint clean (0 errors; the file's pre-existing `custom/no-single-use-local`
    warning fires on the new code too, same as it already does throughout the rest of the file's own
    `swapOut`-based block-building idiom -- not a real issue).
  - Run tests: `cd tison/test && ts-node -P tsconfig.json --transpile-only test-towasm.ts` (no `tsx`
    installed in this repo; `ts-node` lives at the workspace root's `node_modules/.bin`). Rebuild
    binary-libs first (`cd binary-libs && npm run build`) if `src/wasm.ts` changed since the last build --
    tison resolves `@isopodlabs/binary_libs/wasm` to binary-libs' `dist/wasm.js`, not its `src/`.
- **Phase 2 (finally, unified mechanism): CLOSED, same session.** `try`/`catch`/`finally` is now fully
  supported (except generator/async/constructor context, explicitly rejected -- see below). Dropped the
  "cheap path" idea from the plan file (duplicate `<finally>` inline when nothing escapes) -- always uses
  the unified action-code mechanism uniformly, since `return` inside `try` (needing the full mechanism
  regardless) is actually the *common* real-world case, not a rare edge; two lowering strategies would
  have been more code for no real benefit.
  - **Design actually built:** one shared `$land`/`$catchAllLand`/`$after` block nest (3 levels) wraps
    the existing Phase-1 `$catchLand`+`try_table(A)` shape. `<A>`'s own throws are exhaustively caught by
    the ordinary tag-catch alone (this compiler only ever throws via its one project-wide tag, so no
    `catch_all_ref` needed there) -- but the *catch handler* (`B`) gets its own **separate, sibling**
    `try_table` with `catch_all_ref`, since nothing else guarantees B's own throws are caught before
    `finally` must run. `ctx.finallyGuards` (new `FuncCtx` stack field) is checked first by
    `case 'return'`/`case 'break'`/`case 'continue'`: a guarded exit stashes its payload into one
    action/exn/retval local triple (reused per-function via `ctx.temp`, not per-`try` -- safe because
    unwinding is always strictly sequential, never concurrent) and `br`s to the landing point; unguarded
    exits (or ones whose real target is a loop opened *inside* the `try`) compile normally. After
    `<finally>` runs exactly once, an if-chain re-dispatches by recursively calling `emitStmt` on a
    *synthesized* statement (`{type:'return'/'break'/'continue', ...}`) -- reuses every existing
    generatorFrame/asyncFrame/ctorThis/depth-math edge case in `case 'return'`/`case 'break'`/
    `case 'continue'` for free, and correctly cascades through a next-*outer* guard for nested
    `try`/`finally` (the guard is popped before the landing code is built). A `return`/`throw`/`break`/
    `continue` written *directly inside* `finally` needs zero special-casing either -- it just executes
    normally at that point (guard already popped), correctly overriding whatever action was pending,
    exactly matching real JS semantics for free.
  - **Three real bugs found and fixed via the actual test suite (compile-time or wasm-validation errors,
    not silent):** (1) the break/continn-redispatch arms were originally emitted *unconditionally* for
    every `finally`, even one with no enclosing loop at all -- `case 'break'`/`case 'continue'` correctly
    rejected the impossible synthesized statement; fixed by gating each arm on
    `guard.breakTargetsLenAtEntry > 0` / `continueTargetsLenAtEntry > 0` (return/exception arms are always
    safe, never gated). (2) `REF_EXN` needs `nullable: true` -- `catch_all_ref`'s real delivered type is
    `exnref` = `(ref null exn)`, not `(ref exn)`; a non-nullable declaration got a real wasm type
    mismatch. (3) the catch-param binding (`local.set`/`drop` consuming `$catchLand`'s delivered value)
    was originally placed *inside* the catch handler's own new `try_table(B)` wrapper -- a `try_table`'s
    body doesn't inherit values left on the outer stack unless declared as real params (none of these
    are), so it must run *before* `try_table(B)` starts, not as its first instructions ("not enough
    arguments on the stack for local.set"). (4) **the subtlest one**: the `dispatch()` helper wraps each
    arm in a real wasm `if`, which -- like `block`/`loop`/`try_table` -- adds its own nesting level, but
    the code never called `ctx.enterLabel()`/`exitLabel()` around building the arm's body. Invisible for
    a *plain* redispatched break/continue/return (no depth-relative `br` inside them), but a **nested**
    `try`/`finally`'s own redispatch code *is* itself full of depth-relative `br`s -- computed one level
    too shallow, caught by wasm validation on the *nested-`try`* test specifically (`nestedFinally`),
    which is exactly why testing genuinely nested cases mattered here, not just flat ones.
  - Tests added to `test-towasm.ts`: finally-only normal path, catch+finally normal/caught paths, return
    keeping its own value through finally, finally overriding a pending return, break/continue crossing
    finally (observed via per-iteration `console.log`, not just the final value), nested try/finally
    (console-log ordering: inner finally, then outer catch, then outer finally), catch-handler-itself-
    throws (confirms `try_table(B)`'s own safety net), and an uncaught throw still running finally first.
    All pass on real execution. 341 checks total in the suite, 0 failures, 0 lint errors.
  - Gap comment (towasm.ts) updated: removed the old blanket "'finally'" gap entry, replaced with the
    narrow real one ("'try'/'finally' inside a generator/async function, a constructor, or a
    'reassignsThis' method"), and added a new, previously-undocumented gap found while testing Phase 1
    (unrelated to finally): `e as SomeClass` doesn't narrow for codegen-facing field/method lookup on an
    `any`-typed value (`unwrapAs` deliberately discards the asserted type; this compiler has no
    `instanceof` at all) -- there is currently no way to narrow a caught `any` down to a concrete class.

## Phase 3 (generator/async/constructor/reassignsThis + finally): CLOSED, same session

The user asked to close the last documented gap. Turned out to need almost no new mechanism -- just
making the *existing* redirect correctly reconstruct whatever `case 'return'` itself would have done in
each context, instead of always assuming a plain `ctx.result`-typed wasm return:

- New `returnValueWtype(ctx)` helper mirrors `case 'return'`'s own dispatch: `ctx.generatorFrame.rWtype`/
  `ctx.asyncFrame.rWtype` when set, `undefined` for `ctx.ctorThis` (a constructor's return never carries a
  value) or a `void` function, `ctx.result` otherwise. `case 'try'`'s guard creation uses this for the
  stashed-return local's type instead of always `ctx.result`.
- `case 'return'`'s guarded-interception branch now stashes using `guard.returnValueLocal.wtype` (falls
  back to `emitDefaultValue` for a bare `return;` in generator/async context, matching the unguarded
  branch's own "else emitDefaultValue" precedent) -- and throws the *same* "constructor cannot return a
  value" / "void function cannot return a value" errors the unguarded path would, at the interception
  site, rather than silently swallowing an invalid case.
- Removed the upfront `ctx.generatorFrame || ctx.asyncFrame || ctx.ctorThis || ctx.appendThisOnReturn`
  bail-out entirely -- once the stash uses the right type, the redispatch's recursive `case 'return'` call
  (guard already popped by then) reconstructs the real generator IteratorResult / async Promise resolution
  / appended-`this` shape itself, from nothing more than a synthetic identifier read of the stashed local.
  `appendThisOnReturn` specifically needed *zero* extra code -- it only ever affects the real return
  instruction sequence, which only exists at the redispatch site.
- **All four combinations passed their real-execution tests on the first attempt** (no bugs found this
  round, unlike Phase 2) -- generator with `try{return}finally{console.log}` (checked via the real
  `.next()`/`IteratorResult` protocol), async with the same (checked via the established
  output-global-set-inside-the-function convention this file's other async tests already use, chained
  through a second `await` to force the value through the real Promise-resolution path), a constructor
  with an early bare `return;` inside `try`/`finally` (checked via two instances, one taking each branch),
  and a `reassignsThis` method (`this = ...;`, this compiler's own extension for Array<T>-style mutators --
  real source at `lib/array.ts`, needs `@ts-expect-error` even in a lib file) with a `finally` that mutates
  `this` *after* the return value was already fixed -- confirmed the subtle real-JS-correct distinction:
  the return value stays fixed at the original `return this.n;` (6), but the *appended* `this` (used to
  update the caller's own receiver variable) reflects `finally`'s later mutation (106) -- these are
  genuinely different values in the test, so this wasn't a coincidental pass.
- Gap comment fully closed: removed the generator/async/constructor/reassignsThis exclusion entirely.
  Rewrote the Control-flow gap entry to be just the pre-existing suspend-inside-`try` boundary (unrelated,
  untouched). Also caught and fixed a second, unrelated **now-stale** gap-comment line while in there:
  the Async section's "rejection/'.catch' (no try/catch exists yet either...)" parenthetical was left over
  from before this session -- corrected to explain the real remaining reason (this compiler's `Promise<T>`
  has no rejected state modeled at all, and the suspend-inside-`try` boundary would block the natural
  `try { await p } catch` shape regardless).

## Status: exception handling in towasm.ts is now fully complete

try/catch/throw/finally work everywhere, verified by real execution, with only the pre-existing (unrelated,
untouched) suspend-point-inside-`try` boundary remaining, itself explained in the gap comment. Nothing
further planned on this feature unless the user asks for that boundary specifically or for labeled
break/continue (a separate, pre-existing gap).
