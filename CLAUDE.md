## Fix problems; never work around them

This overrides any instinct to "get past" a blocker. Every change must fix the root cause, with the
broadest general mechanism available -- even when that means rewriting a subsystem. The goal is clean,
reliable, fast code that compiles all legal TypeScript.

**What counts as a workaround** (do not write these without stopping first):
- returning `any`/`unknown`/`undefined`/a default for a shape the code does not actually handle;
- muting or dropping a diagnostic, or typing something muted to avoid an error it would expose;
- an early bail, "lenient" branch or `catch {}` that hides a failure instead of handling the case;
- special-casing a name (a method, a function, a file) instead of the structural trigger;
- an `as any` / `as unknown as X` cast that silences a real type mismatch;
- rewriting the source under test (a surveyed file) or weakening a test/instrument to make it pass;
- a partial fix that handles the instance in front of you but not the general case, without saying so.

**When you are about to write one**: stop. Either fix the root cause, or tell the user plainly --
"this is a workaround because X; the proper fix is Y" -- and let them decide. Never present one as a fix.

**Priorities.** Rejecting correct code is worse than accepting incorrect code: a checker false positive
blocks `tsw` outright, a missed error does not. Existing leniency (`any` fallbacks, "lenient" branches)
was scaffolding to let the compiler get further -- it is to be REMOVED, not imitated. Do not extend it,
and do not treat nearby leniency as precedent. When removing one exposes false positives, those are the
real bugs: fix them, do not restore the leniency.

**Every commit message** states the root cause, the general mechanism that fixed it, and any workaround
it introduces or leaves behind (or "none"). A workaround marker in a diff (`workaround`, `lenient`, a new
`?? T.ANY`/`return ANY`, `as any`, `catch {}`) needs an explicit justification there.

**Instruments must not reward silence.** The survey counts "compiles", the corpus A/B counts errors on
tsc-clean files; both improve when a failure turns into `any`. Before claiming progress from either,
check that the change removed a failure rather than hid one (probe the declaration; read the WAT; run it).

## Memory

Read [memory/MEMORY.md](memory/MEMORY.md) at the start of work on tison — it indexes the
project's memories (architecture facts, project rules, current self-hosting focus). Record new
tison-specific facts as files in `memory/` and add a one-line pointer to `memory/MEMORY.md`;
never put them in the global auto-memory store.

## Scratch files

Use `assistant/` (gitignored, disposable) for temporary/scratch files. Anything to keep under
source control goes in `test/` or wherever is appropriate — not `assistant/`.
