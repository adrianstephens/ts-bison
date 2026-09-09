## Memory

Read [memory/MEMORY.md](memory/MEMORY.md) at the start of work on tison — it indexes the
project's memories (architecture facts, project rules, current self-hosting focus). Record new
tison-specific facts as files in `memory/` and add a one-line pointer to `memory/MEMORY.md`;
never put them in the global auto-memory store.

## Scratch files

Use `assistant/` (gitignored, disposable) for temporary/scratch files. Anything to keep under
source control goes in `test/` or wherever is appropriate — not `assistant/`.
