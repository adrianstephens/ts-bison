---
name: tison_wat_parser_exceptions
description: "tison/src/examples/wat-parser.ts: added WAT-text support for exception-handling (tag/throw/throw_ref/try_table+catch family) on top of binary-libs' wasm.ts support; found+fixed a real tison LALR(1) generator limitation (optional-blocktype + folded-first-body-instr, affected block/loop/if too, now fixed everywhere) and a real binary-libs wasm.ts BlockType encoding bug (multi-value {typeIndex} case silently corrupted on write); also generalized to real multi-value blocktypes"
metadata: 
  node_type: memory
  type: project
  originSessionId: 10e20a31-6bd9-4194-ba01-94754bc25ee1
  modified: 2026-08-18T23:47:47.844Z
---

Added 2026-08-18, directly after [[binary_wasm_module]]'s exception-handling work in binary-libs, at the
user's request to extend the same support into `tison/src/examples/wat-parser.ts` (the WAT-text
parser/assembler used for `__asm` inline blocks -- see [[tison_towasm_inline_asm]] -- and standalone
`.wat` compilation). Verified end-to-end against real `wasmtime` (not just self-round-trip): WAT source
with a declared `(tag ...)`, `throw`, and `try_table` with `catch`/`catch_all` parsed, compiled via
`toWasm`, and executed correctly under `wasmtime run`, delivering the thrown payload back out.

## What was added

- `Tag` module-field type (mirrors `Table`/`Memory`/`Global`, value = same `TypeUse` shape `Func` uses --
  tag payload = params, results always empty per spec, not hand-validated here).
- Grammar: `(tag ...)` module field, tag import/export descriptors, `'tag'` added to `EXPORT_KIND`-style
  `OneOf`, `exnref` added to `reftype` (needed for `catch_ref`/`catch_all_ref`'s re-pushed exception ref).
- Instructions: `throw`, `throw_ref`, `try_table` with `catch`/`catch_ref`/`catch_all`/`catch_all_ref`
  clauses (own `catch_clause` grammar rule, labels resolved the same way `br`'s label is).
- `toWasm`: a `tags` `Container` (widened `Container<T>`'s generic bound to include `Tag`), tag import/
  entry wiring, `resolveInstr`'s `case 'try_table'` (catches resolve against the *enclosing* label stack,
  matching a `br` written right before `try_table` rather than inside it -- only the body sees the pushed
  label), and a generic `resolveField(resI, 'tagIndex', tags)` added to the default case for `throw`.

## Round 2 (same session, immediately after): generalized to real multi-value blocktypes

User explicitly asked to generalize (not just unblock `catch_ref`): `block`/`loop`/`if`/`try_table` can
now all take 0, 1, or several `(result t)` clauses. Design:
- `WatInstr` (top of file) widens block/loop/if/try_table's `blockType` field to a pre-resolution
  `ValType[]` (`WatBlockInstr`, unioned in via `Exclude<Instr, {op:'block'|'loop'|'if'|'try_table'}>` --
  a real widened type per [[feedback_avoid_unsafe_casts]], not an `as unknown as` cast).
- New shared `block_item`/`block_body` (blockType + instrs merged into one list, no separate leading
  `Maybe`) used by block/loop/if; `try_table_item`/`try_table_body` reuse `block_item` plus catch clauses.
- `toWasm`'s `resolveBlockType(bt: ValType[])`: 0 results -> `undefined` (void), 1 -> that valtype
  directly, 2+ -> synthesize/dedup an anonymous 0-param func type via the already-existing
  `getFuncTypeIdx` and reference it by index -- the *only* way wasm's binary format expresses a
  multi-result blocktype (confirmed against the real spec: `blocktype ::= 0x40 | valtype | s33`, no
  direct "list of valtypes" form -- `wasm.ts`'s existing `BlockType = ValType|undefined|{typeIndex}`
  already modeled this correctly, so no *shape* change was needed there, see next section for what was).
- `resolveInstr`'s parameter type narrowed to `Exclude<WatInstr, SwitchPlaceholder | {op:'__local'}>`
  (the "resolvable" subset) rather than widening `Instr` itself, to keep the return type honestly `Instr`.
- `Global.init`/`Elem.offset`/`Data.offset` (constant-expr fields) and `assertResolved`'s return type
  changed from `Instr[]` to `WatInstr[]` -- they were never actually fully-resolved `Instr[]` (index
  names still unresolved until `toWasm`'s `resolveInstrs` runs on them), that was always a slightly-too-
  narrow type, just never surfaced until `try_table`'s blockType widening made the mismatch load-bearing.
- `backend.ts`'s `assertFlatInstrs` (rejects control-flow ops in flat inline `__asm` bodies) updated to
  also reject `try_table`, matching its existing block/loop/if rejection -- a real gap `tsc` caught
  immediately once `WatInstr` gained the new op.

**Side effect: this also fixed the pre-existing block/loop/if "empty blocktype + folded first body instr"
bug documented below** (merging blockType into the body's own item list, same trick already applied to
`try_table`, was the fix for both problems at once) -- confirmed by direct retest, `(block (i32.add
(i32.const 1) (i32.const 2)) drop end)` now parses correctly.

## Round 2 also found a real, separate bug in binary-libs' wasm.ts: `BlockType`'s multi-value case was silently corrupted on write

Discovered via `wasmtime` rejecting ("invalid value type") a module built from a WAT source with a real
multi-result block, *and* re-decoding the same bytes back into `WasmModule` itself threw ("expected
heaptype, got undefined") -- a genuine round-trip bug, not a wat-parser.ts problem. Root cause: `wasm.ts`'s
`RawType`'s own `number` case *is* the wire encoding for a type-index blocktype (a non-negative S33), but
`BlockType`'s declared TS shape for that case is `{typeIndex: number}`, not a bare number -- and
`BlockType`'s `bin.as(RawType, v => {...})` call supplied no reverse (`from`) function, so `unmake`
defaulted to identity, meaning a `{typeIndex: N}` value got handed straight to `RawType.put` unchanged.
`RawType.put`'s `typeof val === 'object'` branch (meant for `ValType`'s `{ref, nullable}` shape) then
silently misread it: `val.nullable` (undefined) and `val.ref` (undefined) both read as falsy/absent,
writing `-28` then `-64` -- two garbage bytes, the real index totally lost. Never triggered before because
nothing had ever produced a `{typeIndex}` blockType until this session's multi-value work.

**Fix** (`binary-libs/src/wasm.ts`, `BlockType`'s definition): added the missing `from` function --
`v => typeof v === 'object' && v !== null && 'typeIndex' in v ? v.typeIndex : v` -- to unwrap
`{typeIndex}` back to a bare number before `RawType.put`, and the existing `get`-side transform now wraps
a bare positive `RawType` decode result back into `{typeIndex: v}` (previously passed the bare number
straight through as `v as BlockType`, silently violating its own declared type). Verified: hand-built
`{op:'block', blockType:{typeIndex:0}, ...}` module now round-trips byte-identical and **executes
correctly under real `wasmtime`** (returns both block results). Downstream consumers (`toWAT`'s `bt()`
helper, wat-parser.ts's own resolve logic) were already written assuming the correct `{typeIndex}` shape
-- only the binary encode/decode wiring itself was wrong. [[binary_wasm_module]] should get a pointer to
this fix too.

## Round 1 finding: a real tison LALR(1) generator limitation (block/loop/if/try_table) -- CLOSED by round 2

`Maybe(blocktype)` directly followed by a separate `MaybeList(...)` body/item list **cannot** disambiguate
"blocktype omitted, next token starts the body's own folded (-prefixed construct" from "blocktype's own
leading `(`" once blocktype is genuinely absent -- confirmed by direct testing, with `parser.tables.conflicts`
showing **zero** recorded conflicts (so it isn't a classic shift/reduce ambiguity the builder flags; more
likely a state-merging/lookahead-computation gap specific to this generator, not investigated further at
the engine level). Affected `block`/`loop`/`if` too (pre-existing, not new to this session), whenever
blocktype is omitted AND the first body instruction is itself a folded `(op ...)` form -- never exercised
by the existing test corpus, so never caught. Initially fixed only for `try_table` (round 1), **now fixed
for block/loop/if too as a side effect of round 2's generalization** (see above) -- fully closed, no known
remaining instance of this bug in this file.

## Status: no known remaining gaps from this work

Both originally-scoped items (exception-handling support, and the `catch_ref`-motivated multi-value
blocktype gap) are done and verified against real `wasmtime`, including the previously-flagged
`catch_ref`-with-non-empty-payload case (`(block $catch (result i32) (result exnref) ...)`), which now
compiles, instantiates, and runs correctly end-to-end.
