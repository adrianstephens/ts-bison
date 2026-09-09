---
name: tison-manual-terminal-primitive
description: "Manual() + Parser.parsePrefix() in tison.ts -- a hand-parsed 'island' terminal + prefix-parse escape hatch, entirely outside the LALR table. CLOSED: wired to real member/parameter decorators in js-parser.ts, verified end-to-end incl. full official corpus (2376->2326 threw, 49 fixed, 0 regressions)."
metadata:
  type: project
  originSessionId: 2026-08-22
  modified: 2026-08-23T23:55:17.067Z
---

Built as a direct response to [[tison_official_ts_test_suite]] item 15 / [[tison_debugging_technique]]'s
"sixth"/"seventh class" LALR state-sharing fragility (member/parameter decorators corrupting unrelated ASI
recovery via LALR core-merging, and a failed engine-level fix attempt for it). The idea discussed with the
user: rather than keep fighting the grammar engine's constraints for constructs that are hard to add without
disturbing shared states, add a real escape hatch that bypasses the LALR table entirely for one construct.

**What was added to `tison/src/tison.ts` (2026-08-22), verified in isolation, not yet used anywhere real:**
- `Token<T = string>` widened from a string-only `.value` to generic — matches the `Terminal<T>` generic
  that already existed but nothing in the codebase actually used for a non-string payload. Also gained an
  optional `consumed?: number` field. Purely additive; every existing bare `Token`/`Terminal` usage still
  means `Token<string>`/`Terminal<any>` by default, unchanged.
- `TerminalCallback<T, C>` threaded the same `T` through its `Token<T> | Terminal<T> | ...` return union;
  `Terminal<T>`'s own `callback` field now typed `TerminalCallback<T>` instead of the untyped default.
- `nextToken`'s callback-result branch (`src/tison.ts` ~line 807): when a callback's returned `Token` has
  `.consumed` set, the lexer now advances past `match + input.slice(after.offset, after.offset + consumed)`
  instead of just `match` — previously a callback could only *look ahead* (via `next()`, non-destructively)
  but never actually consume more than its own regex match.
- `Manual<T>(name, trigger, fn)`: a new public helper (`src/tison.ts`, right after `terminal()`) — `trigger`
  is a small, unambiguous sigil regex (e.g. `/@/`) that only decides *whether* this terminal fires at a
  position; `fn(remaining, ctx)` gets the raw text from right after that trigger and does its own parsing
  however it likes (regex, a hand-rolled scanner, even calling a second `Parser` instance), returning
  `{value, consumed}`. Internally just `new Terminal<T>(name, trigger, callback)` with a self-referencing
  closure so the returned `Token.type` is the `Manual()` terminal itself, resolvable by identity in a normal
  grammar rule (`Rule([Manual(...), ...], ...)`) exactly like any other terminal.

**Why this matters for the LALR fragility specifically**: a `Manual()` terminal occupies exactly one slot in
whatever rule references it — it never adds a new alternative that *reaches* an existing, already-overloaded
nonterminal (like `class_member_body`/`parameter`) from a new grammar position, which is the precise
mechanism behind every LALR state-sharing bug found this session. Grammar states elsewhere are structurally
incapable of being disturbed by a `Manual()` addition, by construction — not by careful testing.

**Verification (isolated throwaway grammar, `assistant/manual-terminal-prototype.ts`, not part of any real
grammar)**: a `Manual()` terminal triggered by `@`, hand-scanning a decorator's optional `(...)` argument
list with real balanced-paren counting (not just a flat regex) into a typed, non-string `{name, args}`
payload object. Confirmed: (1) simple no-arg case, (2) flat args, (3) *nested* parens inside args — proving
the hand-scanner isn't limited to what a single regex could express, (4) a newline inside the manually-
consumed span still advances `line`/`col` correctly for tokens shifted afterward (checked via `$.pos` on
the trailing `IDENT`'s reduce, landing on the right line). Full fast-suite regression after landing the
`tison.ts` engine changes (before adding any real consumer): `tsc -p test --noEmit` clean, `test-js-parser.ts`
byte-identical to baseline, `test-tison.ts`/`test-cpp-parser.ts`/`test-c-parser.ts`/`test-wat-parser.ts`/
`test-preprocessor.ts`/`test-wat-macro.ts` all clean.

**`Parser.parsePrefix()` — the prefix-parse gap closed (2026-08-23), same session, prompted by the user
directly questioning whether "no prefix mode" really meant what it sounded like.** The user's framing was
exactly right and caught an imprecision in how this was first described: it's not that there's no concept of
a prefix, it's that `$end`/EOF is hard-wired to the *physical* end of the fed string (`GrammarBuilder` always
augments every grammar with `$accept -> start $end`, and `nextToken` only ever produces `$end` once the raw
input string is truly exhausted) — there was no way for a sub-parser to signal "my own grammar is done" short
of the caller happening to feed it exactly the right number of characters in advance, which is circular (you
don't know the boundary until you've parsed up to it).

**First design considered and rejected**: relax the augmenting rule itself (`$accept -> start`, no trailing
`$end`) so LALR table construction treats completing `start` as accept regardless of lookahead. Rejected
before implementing — LALR(1)'s reduce-vs-accept decision is lookahead-set-driven, and the augmenting item's
lookahead is seeded specifically as `{$end}`; without a real trailing terminal to anchor that seed, the table
would only accept on an actual `$end` token appearing next, not "any real token, whatever it is" — the same
problem in a different place. Would also mean touching `GrammarBuilder`'s core table-construction logic, the
highest-risk, least-isolated part of the engine (see item 15's `relexAt` regression for exactly how badly a
core-engine change can go despite passing every hand-picked canary).

**What was actually built instead — a targeted addition to `runParser` itself, zero changes to table
construction**: a `prefixMode` flag, `PrefixAccepted` exception class, and `Parser.parsePrefix(input, ctx)`
returning `{value, consumed}` instead of throwing when there's unconsumed trailing input.
- Real discovery mid-implementation (debug-printed, not guessed): the very first version checked only
  `row.get(EOF)?.kind === 'accept'` at the point recovery would otherwise trigger — and found that's usually
  the WRONG state. A rule like `member -> IDENT '(' ')' '{' '}'` gates even its OWN final reduce on lookahead
  `$end` (since nothing else can legally follow `start` in a standalone grammar, that reduce's LALR lookahead
  set is exactly `{$end}`) — so hitting "not accept yet" one step early is normal, not a dead end; genuine
  accept can be several chained reduces away from wherever the real (non-`$end`) lookahead first fails to fit.
- **The fix**: when the real lookahead doesn't fit and `row.has($end)`, drive a synthetic `{type: $end, ...}`
  token through the *existing, unmodified* reduce/goto/accept branches (not `recover()` — this isn't error
  recovery, every one of these reduces was always going to happen, just deferred) instead of writing a
  separate simulation function. Each loop iteration naturally re-checks the fresh stack top, so this correctly
  chains through as many reduces as needed on its own. Only two real edits: how `usingRecovery`/`tok` are
  computed (skip the stuck-counter entirely for this path — these are genuine, always-going-to-happen reduces,
  not a recovery loop, so counting them toward `MAX_RECOVERY_AT_SAME_OFFSET` would be wrong and could
  false-trip on a deeply nested real member), and the `accept` branch itself now throws `PrefixAccepted` with
  `(value, realTok.pos.offset)` instead of returning when it was reached via synthetic `$end` (checked via
  `realTok.type !== EOF` — real full-input accept is unaffected, still returns normally). `realTok.pos` (the
  lookahead's *start*) is the correct boundary, not `stream.offset` (which already sits past the peeked,
  not-ours lookahead token) — same "position vs. offset" distinction the `Manual()`/`relexAt` work already
  established this session.

**Verified** (`assistant/parse-prefix-prototype.ts`, throwaway grammar, not real js-parser.ts rules): exact
single match (`.parse`/`.parsePrefix` agree), two members concatenated (`.parse` still throws exactly as
before — confirms zero behavior change to the existing method; `.parsePrefix` stops precisely at the boundary
and returns the untouched remainder), a member followed by unrelated garbage, a multi-line member (confirms
`consumed` is a correct absolute offset, not just line/col), and a genuinely invalid input (still throws
honestly — no silent partial-match of garbage). Full fast-suite regression after landing the `runParser`
changes: `tsc -p test --noEmit` clean, `test-js-parser.ts` byte-identical to baseline, `test-tison.ts`/
`test-cpp-parser.ts`/`test-c-parser.ts`/`test-wat-parser.ts`/`test-preprocessor.ts`/`test-wat-macro.ts` all
clean, `test-wat-literals.ts` shows the same 4 pre-existing (unrelated, wat-parser.ts WIP) failures as always.

**Known, deliberately-unhandled limitation**: a GLR fork needed at *exactly* the acceptance boundary itself
(as opposed to a fork resolving somewhere in the *middle* of the derivation, which is unaffected and returns
normally either way) isn't supported — `runGlrFork` is a separate function with its own loop, and `prefixMode`
doesn't thread into it. Not expected to matter for the actual target (`class_member_body`/`parameter`, both
self-terminating on unambiguous delimiters), but worth remembering if this gets reused for a grammar shape
where the boundary itself is genuinely ambiguous.

**CLOSED (2026-08-23, same session): wired to the real member/parameter-decorator case in `js-parser.ts`,
verified end-to-end.** See [[tison_decorator_support]] for the full final status — this section is the "how
it was built" record.

**The wiring (`js-parser.ts`, right after `skip` is defined so both `decorator_list` and `skip` already
exist)**: one shared `decoratorListParser` (`makeParser({start: decorator_list, skip})`, reusing the existing,
already-verified-safe class-level decorator grammar rather than hand-rolling a second decorator scanner), plus
two `Manual()` terminals — `DECORATED_PARAMETER` and `DECORATED_MEMBER` — each hand-scanning the `@decorator`
prefix via that shared parser, then finishing the rest via a small once-built sub-parser rooted at a
*snapshot* of the target nonterminal's own undecorated rules (`parameter.slice()` / `class_member.slice()`,
taken before the new alternative is pushed onto the live array), calling `.parsePrefix()` on it and splicing
`{...body, decorators}` together. Each Manual() terminal is then added as a single new alternative —
`parameter.push(Rule([DECORATED_PARAMETER]))`, `class_member.push(Rule([DECORATED_MEMBER]))`.

**One real bug found and fixed during wiring, not anticipated in the design**: build-order dependency between
the two sub-parsers. `classMemberBaseParser`'s table is a *snapshot* taken at the moment `makeParser` runs —
since `class_member_body` reaches `parameter` transitively (via `parameter_clause`), building
`classMemberBaseParser` *before* `parameter.push(Rule([DECORATED_PARAMETER]))` silently produced a sub-parser
whose own copy of the parameter grammar didn't know about parameter decorators at all. Symptom was narrow and
easy to miss: `class C { method(@a x, y) {} }` (parameter decorator, no member decorator) worked fine, but
`class C { @dec method(@a x, y) {} }` (member decorator *wrapping* a decorated parameter) failed with
"Unexpected character '@'" thrown from *inside* the member sub-parser's own `parsePrefix` call — caught via
systematic bisection (isolate member-decorator-alone, param-decorator-alone, then the combination) rather than
guessing. Fixed by reordering: `parameter.push(...)` now runs *before* `classMemberBaseParser` is built, so
its snapshot correctly includes parameter-decorator support.

**Verified**: canary (`var a=1\nvar b=2`) unaffected; member decorators (bare, with `static`, stacked,
with call-args, on fields); parameter decorators (bare, with defaults, multiple per parameter list, mixed
decorated/undecorated params in the same list); member+parameter decorators combined on the same method;
class-level+member decorators combined — all produce correct ASTs with decorators attached in the right
place, confirmed via direct JSON output, not just "doesn't throw." Full fast-suite regression: `tsc -p test
--noEmit` clean, `test-js-parser.ts` byte-identical to baseline, `test-tison.ts`/`test-cpp-parser.ts`/
`test-c-parser.ts`/`test-wat-parser.ts`/`test-preprocessor.ts`/`test-wat-macro.ts` all clean. **Full official
corpus (the real test, per item 15's lesson): 2,376 → 2,326 threw, exactly 49 files fixed, zero newly
failing** — diffed the full failure-list, not just the count, to confirm; the newly-fixed files are all
genuinely decorator-shaped (`decoratorMetadataForMethodWithNoReturnTypeAnnotation01.ts`,
`decoratorOnClassAccessor1.ts`, `decoratorChecksFunctionBodies.ts`, etc.), nothing unrelated moved.

**Known cost, not addressed**: the three sub-parser tables (`decoratorListParser`, `parameterBaseParser`,
`classMemberBaseParser`) are built via plain `makeParser`, not `makeCachedParser` — each transitively reaches
nearly the whole expression/statement grammar (parameter defaults and method bodies can contain arbitrary
expressions), so building all three from scratch on every module load adds real one-time cost (`js-parser.ts`
module load measured ~1–1.6s including this, vs. ~63ms for `tison.ts` alone) that a cache would eliminate.
Not addressed since nothing in this session's actual usage (test suites, the official-corpus harness) is
sensitive to it, but worth revisiting if `js-parser.ts` ever ends up on a process-startup-latency-sensitive
path.

Both this file's mechanism and [[tison_decorator_support]]'s status are now fully up to date and closed —
the LALR state-sharing fragility chain that started with "sixth class" is resolved for its original target,
via a structural workaround rather than the engine-level fix (item 15) that was tried and reverted.

**Real bug found and fixed the same "continue" session, one pass later (2026-08-23) — see
[[tison_official_ts_test_suite]] item 25 for the full writeup.** The three sub-parsers this mechanism
depends on (`decoratorListParser`, `parameterBaseParser`, `classMemberBaseParser`) were originally built
*eagerly*, at `js-parser.ts`'s own module-load time — a real design mistake, not caught by any verification
done when this was first built, because `ts-parser.ts` extends the exact same live `parameter`/`class_member`
arrays (typed fields, typed setter params, `as`/`satisfies`, call-generics, ...) from its *own* module-level
code, which only runs after `js-parser.ts` has already finished loading and had already snapshotted+built
those tables. Every decorated member/parameter that also carried a TS-specific shape (essentially: had a
type annotation) silently lost that shape entirely — invisible to every canary test run at the time, since a
decorated-and-typed construct looks identical to a decorated-and-untyped one in every way except the type
itself being present, and none of the original verification used typed examples.

**Fix**: converted all three from eager `const x = makeParser(...)` to a lazy `lazyParser(startFn, skip)`
helper — both the array snapshot (`.slice()`) and the actual `makeParser` table-build are deferred to first
real use (first `.parsePrefix()` call from inside a `Manual()` callback), not module load. Real parsing can
only happen after every module the caller imports has finished its own top-level code, so by the time these
fire, whichever grammar module is actually in use (`ts-parser.ts` or plain `js-parser.ts`) has already
applied all its extensions to the live arrays being snapshotted.

**Lesson for next use of this primitive**: any sub-parser built by snapshotting a live, `.push()`-extensible
array (the entire point of this pattern — reusing an existing nonterminal's rules without duplicating them)
must be built *lazily*, deferred past module load, whenever ANY other module might extend that array later.
Building eagerly is only safe if the array is guaranteed fully-formed by the time the snapshot is taken —
true only for a nonterminal that nothing downstream ever extends, which is not a safe assumption to make
about a shared, exported `Rules<T>` array in this codebase without checking first.

**Second real bug found, later still (2026-08-23) — see [[tison_official_ts_test_suite]] item 44 for the full
writeup.** `lazyParser`'s `makeParser({ start: start(), skip })` call omitted `recover`/`merge`, which the
*main* parser's own `make()` always passes. `GrammarSpec.recover` silently defaults to no ASI recovery at
all when omitted, so every sub-parser built through this primitive structurally could not do ASI — a
decorated class member/parameter with no trailing terminator (e.g. `class C { @dec y: any }`, relying on the
following `}` the way the outer parser's own class-body context always can) required an explicit `;` the
undecorated form never needed. Fixed by threading `recover, merge` into `lazyParser`'s `makeParser` call
(safe as a forward reference — see item 44 for why). **Lesson, layered on the one above**: a sub-parser built
via this primitive needs to match the *main* parser's full `GrammarSpec`, not just `start`/`skip` — a partial
`GrammarSpec` silently drops behavior (ASI here) rather than erroring, so a new use of this primitive should
diff its `makeParser(...)` call against `make()`'s own field-by-field, not just supply what "look required."
