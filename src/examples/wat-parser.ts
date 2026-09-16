import * as path from 'path';
import { Rules, makeRule, List, MaybeList, Maybe, OneOf, Forward, termOneOf } from '../tison';
import { makeCachedParser } from '../tableCache';
import {
	Instr, HeapType, ValType, Local, GlobalType, TableType, SubType, FuncSig, CompType, FieldType, StorageType, ParamType,
	WasmModule, Limits, Import as WasmImport, CatchClause,
	ROOT_OPS, FB_OPS, FC_OPS, SIMD_OPS, THREAD_OPS
} from '@isopodlabs/binary_libs/wasm';
import { AnyMxRecord } from 'dns';

// ===================================================================
//  WAT (WebAssembly Text Format) Parser
// ===================================================================
// Macros are parsed with the *same* grammar as everything else -- a macro body is just a func body, so `$a`/`$b` inside it already parse as ordinary local references
// Expansion is a semantic substitution over the resulting (already-typed) Instr[] AST at each call site, not a text/syntax pass:
// - a reference to a declared param is replaced by the caller's own (already-parsed) argument subtree
// - a reference to a local the macro declares for itself is renamed to a fresh name per expansion (hygiene), so two calls to the same macro in one function can't collide
// Nested macro calls resolve for free: parsing is bottom-up, so a macro call inside another macro's own body is already fully expanded by the
// time that outer macro's own `(macro ...)` definition reduces -- nothing stored in the macro table ever contains an unexpanded call.

// A call site `(NAME arg...)` where NAME isn't a registered macro is instead treated as an implicit `call`: `($f a b)` === `(call $f a b)`.

// ===================================================================
//  WAT-only types (not in wasm.ts binary layer)
// ===================================================================

export type { Instr, ValType, GlobalType, TableType };
export { ROOT_OPS };

type index = string | number

// The abstract heap type names `heap_type` accepts alongside a `$name`/number index (see `ref_type`
// below) -- a raw `$name` isn't a real `HeapType`/`SubType.supertypes` entry until `WasmModule.resolve()`
// looks it up once the whole module is assembled, same as any other named reference in this file (a
// local/global/func/etc id). No parallel "pending" type for it here -- see the `as X` casts below,
// same escape hatch already used for `WatInstr` (this file doesn't own resolution any more; wasm.ts does).
const ABSTRACT_HEAP_NAMES = new Set(['func', 'extern', 'any', 'eq', 'i31', 'struct', 'array', 'none', 'noextern', 'nofunc', 'exn', 'noexn']);

type MemType	= Limits;
type FuncType	= FuncSig & { typeIndex?: index};
interface Imp		{ module: string, name: string };

// A type-parametric local's declared type, before `instantiateAsmBody` substitutes it for a real numeric type.
// Every switch arm can declare locals so `WatLocal.type` has to admit this alongside a real `ValType`
export interface AsmTypeParam { typeParam: string }
export type WatLocal = Omit<Local, 'type'> & { type: ValType | AsmTypeParam };
export type WatInstr = Instr | SwitchPlaceholder | ({ op: '__local'} & WatLocal);

// A `switch` whose key names a macro parameter can't be resolved at parse time (the macro body is fully reduced before it's ever stored in ctx.macros, long before any call site picks an argument)
// -- it's left as this placeholder for expandCall's substInstr to resolve per call, once the parameter is actually bound to a caller-supplied $tag. See the `switch` rule below.
export interface SwitchArm			{ values: index[]; body: WatInstr[] }
export interface SwitchPlaceholder	{ op: '__switch'; key: string; arms: SwitchArm[] }

interface Field<T extends string, V> {
	type:		T;
	id?:		string;
	export?:	string[];
	import?:	Imp;
	value:		V;
}
type Func		= Field<'func', FuncType> & { locals: WatLocal[]; body: WatInstr[] }
type Table		= Field<'table', TableType>
type Memory		= Field<'memory', MemType>
type Global		= Field<'global', GlobalType> & { init: Instr[] }
type Tag		= Field<'tag', FuncType>

interface Export	{ type: 'export'; name: string; kind: 'func' | 'table' | 'memory' | 'global' | 'tag'; index: index }
interface Import	{ type: 'import'; module: string; name: string; desc: Func | Table | Memory | Global | Tag }
interface Elem		{ type: 'elem'; id?: string; table?: index; offset?: Instr[]; init: index[] }
interface Data		{ type: 'data'; id?: string; memory?: index; offset?: Instr[]; init: Uint8Array }
interface Type		{ type: 'type'; id?: string; desc: SubType }

type ModuleField =	{ type: 'start'; func: index } | Func | Table | Memory | Global | Tag | Export | Import | Elem | Data | Type;
interface Module	{ id?: string; fields: ModuleField[] }

// ===================================================================
//  Grammar
// ===================================================================

interface MacroDef { params: string[]; body: WatInstr[] }

function expandMacro(ctx: ParseCtx, macro: MacroDef, args: WatInstr[][]): WatInstr[] {
	if (args.length !== macro.params.length)
		throw new Error(`expects ${macro.params.length} argument(s), got ${args.length}`);

	const paramSubst	= new Map(macro.params.map((p, i) => [p, args[i]]));
	const renames		= new Map<string, string>;

	const substInstr = (i: any): WatInstr[] => {
		if (i.op === '__local' && i.id) {
			const newid = `${i.id}__${++ctx.macroUid}`;
			renames.set(i.id, newid);
			return {...i, id: newid };
		}

		if (typeof i.localIndex === 'string') {
			if (paramSubst.has(i.localIndex)) {
				if (i.op !== 'local.get')
					throw new Error(`can't ${i.op} parameter '${i.localIndex}' -- parameters are read-only expressions`);
				return paramSubst.get(i.localIndex)!;
			}
			if (renames.has(i.localIndex))
				return [{ ...i, localIndex: renames.get(i.localIndex) }];
		}
		switch (i.op) {
			case 'block': case 'loop':
				return [{ ...i, body: i.body.flatMap(substInstr) }];
			case 'if':
				return [{ ...i, then: i.then.flatMap(substInstr), else: i.else && i.else.flatMap(substInstr) }];
			case '__switch': {
				// A switch key names one of *this* macro's own parameters: resolve it against the
				// argument bound at this call site. That argument must itself be a bare `$tag` (the
				// same shorthand `local.get $x` uses for "read local $x") -- a computed expression
				// has no tag to switch on.
				const arg = paramSubst.get(i.key);
				if (!arg || arg.length !== 1 || arg[0].op !== 'local.get' || typeof arg[0].localIndex !== 'string')
					throw new Error(`switch key '${i.key}' isn't a parameter bound to a bare $tag argument at this call site`);
				const tag = arg[0].localIndex;
				for (const arm of i.arms) {
					if (arm.values.includes(tag))
						return arm.body.flatMap(substInstr);
				}
				throw new Error(`switch '${i.key}' -- no arm matches '${tag}'`);
			}
			default:
				return [i];
		}
	};
	return macro.body.flatMap(substInstr);
}


class ParseCtx {
	macros			= new Map<string, MacroDef>;
	literalText		= new WeakMap<object, string>;
	macroUid		= 0;
	data			= new Uint8Array(0);
	dataStrings		= new Map<string, number>;
	defines			= new Map<string, string|number>();

	constructor(defines?: Record<string, string|number>) {
		if (defines)
			for (const k in defines)
				this.defines.set('$'+ k, typeof defines[k] === 'string' ? '$' + defines[k] : defines[k]);
	}

	lookup(id: string) {
		const x = this.defines.get(id);
		if (x === 'undefined')
			return id;
		return x;
	}

	addData(data: Uint8Array, align = 1): number {
		const adjust = this.data.byteLength % align;
		const offset = this.data.byteLength + (adjust ? align - adjust : 0);
		const total	= offset + data.byteLength;
		if (this.data.buffer.byteLength < total) {
			const buffer = new Uint8Array(Math.max(this.data.buffer.byteLength * 2, total));
			this.data.set(buffer, 0);
			this.data = buffer.subarray(0, total);
		}
		data.set(this.data, offset);
		return offset;
	}

	internString(value: string): number {
		const existing = this.dataStrings.get(value);
		if (existing !== undefined)
			return existing;
		const offset = this.addData(new TextEncoder().encode(value + '\0'));
		this.dataStrings.set(value, offset);
		return offset;
	}
}

const Rule = makeRule<ParseCtx>();

// --- Terminals ---

const ID		= /\$[a-zA-Z0-9!#$%&'*+\-./:<=>?@\\^_`|~]*/;
const NAT		= /0x[0-9a-fA-F]+|[0-9]+/;
const INT		= /[+-]?(?:0x[0-9a-fA-F]+|[0-9]+)/;
const FLOAT		= /[+-]?(?:inf|nan(?::0x[0-9a-fA-F]+)?|[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|0x[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?[0-9]+)?)/;
// Same shape as FLOAT, but requires an actual decimal point/exponent/inf/nan marker -- unlike
// FLOAT, it can never match a bare integer. Used only for the literal-instr shortcut below: that
// rule needs its own terminal disjoint from NAT's, because a terminal that *overlaps* NAT (as
// FLOAT does, since "3" matches both) can pick the wrong one for a token whose type only turns
// out to matter several reduces later -- see the shortcut rule's own comment for why.
const FLOAT_ONLY = /[+-]?(?:inf|nan(?::0x[0-9a-fA-F]+)?|[0-9]+(?:\.[0-9]*(?:[eE][+-]?[0-9]+)?|[eE][+-]?[0-9]+)|0x[0-9a-fA-F]+(?:\.[0-9a-fA-F]*(?:[pP][+-]?[0-9]+)?|[pP][+-]?[0-9]+))/;
const STRING	= /"(?:[^"\\]|\\.)*"/;

const id  		= Rules(Rule([ID],  	$ => $[0]));
const nat 		= Rules(Rule([NAT], 	$ => parseInt($[0], $[0].startsWith('0x') ? 16 : 10)));
const str 		= Rules(Rule([STRING], 	$ => JSON.parse($[0]) as string));	// JSON.parse returns any; recover the real type
const maybe_id	= Maybe(id);
// `TYPEINDEX("T[]")` -- a type index named by a TYPE rather than by a `$name` or a literal. The text is
// opaque here: this parser knows nothing about TypeScript types, and deliberately keeps it that way (see
// `toWasm`'s own note on leaving every `$name` for a later pass). It lowers to a sentinel string that the
// embedder resolves afterwards, exactly as `$name`s are resolved afterwards -- `ID` always starts with
// `$`, so a `type:`-prefixed string can never collide with a real name, and if one ever escapes
// unresolved it fails loudly as an unknown name rather than silently meaning something else.
const TYPE_EXPR_PREFIX = 'type:';
const idx		= Rules<index>(
	Rule(['TYPEINDEX', '(', str, ')'], $ => TYPE_EXPR_PREFIX + $[2]),
	Rule([ID],  	($, ctx) => ctx.defines.get($[0]) ?? $[0]),
	nat
);

const heap_type = Rules<HeapType>(
	Rule([OneOf([...ABSTRACT_HEAP_NAMES])], $ => $[0] as HeapType),
	Rule([idx], $ => $[0] as HeapType),
);

const ref_type	= Rules<ValType>(
	Rule(['(', 'ref', heap_type, ')'],			$ => ({ ref: $[2], nullable: false })),
	Rule(['(', 'ref', 'null', heap_type, ')'],	$ => ({ ref: $[3], nullable: true })),
	Rule(['exnref'],		() => ({ ref: 'exn',		nullable: true })),
	Rule(['anyref'],		() => ({ ref: 'any',		nullable: true })),
	Rule(['eqref'],			() => ({ ref: 'eq',			nullable: true })),
//	Rule(['dataref'],		() => ({ ref: 'data',		nullable: true })),
	Rule(['arrayref'],		() => ({ ref: 'array',		nullable: true })),
	Rule(['funcref'],		() => ({ ref: 'func',		nullable: true })),
	Rule(['externref'],		() => ({ ref: 'extern',		nullable: true })),
	Rule(['nullref'],		() => ({ ref: 'none',		nullable: true })),
	Rule(['nullfuncref'],	() => ({ ref: 'nofunc',		nullable: true })),
	Rule(['nullexternref'],	() => ({ ref: 'noextern',	nullable: true })),
	Rule(['i31ref'],		() => ({ ref: 'i31',		nullable: false }))
);
const val_type	= Rules<ValType>(
	OneOf(['i32', 'i64', 'f32', 'f64', 'v128']),
	ref_type,
);


const param = Rules<ParamType>(
	Rule(['(', 'param', val_type, ')'],		$ => ({ type: $[2], id: undefined })),
	Rule(['(', 'param', id, val_type, ')'],	$ => ({ id: $[2], type: $[3] })),
);
const result = Rules<ValType>(
	Rule(['(', 'result', val_type, ')'],		$ => $[2])
);

const func_type = Rules<FuncType>(
	Rule([Maybe(Rules(Rule(['(', 'type', idx, ')'], $ => $[2]))), MaybeList(param), MaybeList(result)],	$ => ({ typeIdx: $[0], params: $[1], results: $[2] })),
);

const limits = Rules<Limits>(
	Rule([nat],			$ => ({ min: $[0] })),
	Rule([nat, nat],	$ => ({ min: $[0], max: $[1] })),
);

const global_type = Rules<GlobalType>(
	Rule([val_type],						$ => ({ type: $[0], mut: false })),
	Rule(['(', 'mut', val_type, ')'],	$ => ({ type: $[2], mut: true })),
);

const table_type = Rules<TableType>(
	Rule([limits, ref_type],				$ => ({ reftype: $[1], limits: $[0] } as TableType)),
);


// --- Instructions ---

function parseIntImm(s: string) { return parseInt(s, s.startsWith('0x') || s.startsWith('-0x') ? 16 : 10); }
function checkLabel(open: string | undefined, close: string | undefined) {
	if (close !== undefined && close !== open)
		throw new Error(`label mismatch: '${open ?? '(none)'}' vs '${close}'`);
	return open;
}

const memarg_offset	= Rules<number>(Rule([/offset=[0-9]+/], $ => parseInt($[0].split('=')[1])));
const memarg_align	= Rules<number>(Rule([/align=[0-9]+/],  $ => parseInt($[0].split('=')[1])));

const instrs	= Rules<WatInstr[]>(Rule([MaybeList(Forward<WatInstr[]>(() => instr))], $ => $[0].flat()));

// WAT only supports the valtype form inline; typeIndex form uses typeuse. Zero, one, or several
// `(result t)` clauses can appear; `toWasm`'s `resolveBlockType` turns the accumulated array into
// the real (binary-level) `BlockType`: 0 results -> void, 1 -> that valtype directly, 2+ -> a
// synthesized/deduped anonymous func type referenced by index (the only way wasm's binary format
// can express a multi-value blocktype -- there's no direct "list of results" encoding for it).
// A bare `Maybe(blocktype)` ahead of the body's own instr list can't be disambiguated by this parser
// generator on 1-token lookahead once blocktype is genuinely omitted and the first body instr is
// itself folded (confirmed by direct testing) -- so `(result t)` clauses are folded into the same
// merged item list as the body instrs instead, same trick `func_body_item` uses to merge header
// items and instrs, and (for `try_table`) catch clauses too.
type BlockItem = { blockType: ValType[] } | { instrs: WatInstr[] };
const block_item = Rules<BlockItem>(
	Rule(['(', 'result', List(val_type), ')'],			$ => ({ blockType: $[2] })),
	Rule([Forward<WatInstr[]>(() => instr)],			$ => ({ instrs: $[0] })),
);
const block_body = Rules<{ blockType: ValType[]; body: WatInstr[] }>(
	Rule([MaybeList(block_item)], $ => {
		const blockType: ValType[] = [];
		const body: WatInstr[] = [];
		for (const item of $[0]) {
			if ('blockType' in item)
				blockType.push(...item.blockType);
			else
				body.push(...item.instrs);
		}
		return { blockType, body };
	}),
);

// `try_table`'s catch clauses (exception-handling proposal): each names a branch target (`idx`, resolved the
// same way a `br`'s label is), tag-typed ones also name the tag whose payload they deliver.
const catch_clause = Rules<CatchClause>(
	Rule(['(', 'catch', idx, idx, ')'],			$ => ({ op: 'catch', tagIndex: $[2], label: $[3] })),
	Rule(['(', 'catch_ref', idx, idx, ')'],		$ => ({ op: 'catch_ref', tagIndex: $[2], label: $[3] })),
	Rule(['(', 'catch_all', idx, ')'],			$ => ({ op: 'catch_all', label: $[2] })),
	Rule(['(', 'catch_all_ref', idx, ')'],		$ => ({ op: 'catch_all_ref', label: $[2] })),
);

type TryTableItem = BlockItem | { catch: CatchClause };
const try_table_item = Rules<TryTableItem>(
	block_item,
	Rule([catch_clause],								$ => ({ catch: $[0] })),
);
const try_table_body = Rules<{ blockType: ValType[]; catches: CatchClause[]; body: WatInstr[] }>(
	Rule([MaybeList(try_table_item)], $ => {
		const blockType: ValType[] = [];
		const catches: CatchClause[] = [];
		const body: WatInstr[] = [];
		for (const item of $[0]) {
			if ('blockType' in item)
				blockType.push(...item.blockType);
			else if ('catch' in item)
				catches.push(item.catch);
			else
				body.push(...item.instrs);
		}
		return { blockType, catches, body };
	}),
);

// A few rules below still need `as Instr`: where the op comes from a OneOf(...) with more than 25 values (tsc limit)
const plain_instr = Rules<WatInstr>(
	Rule(['block', maybe_id, block_body, 'end', maybe_id],			$ => ({ op: 'block', blockType: $[2].blockType, body: $[2].body, label: checkLabel($[1], $[4]) })),
	Rule(['loop', maybe_id, block_body, 'end', maybe_id],			$ => ({ op: 'loop', blockType: $[2].blockType, body: $[2].body, label: checkLabel($[1], $[4]) })),
	Rule(['if', maybe_id, block_body, 'end', maybe_id],				$ => ({ op: 'if', blockType: $[2].blockType, then: $[2].body, label: checkLabel($[1], $[4]) })),

	Rule(['if', maybe_id, block_body, 'else', instrs, 'end', maybe_id],	$ => ({ op: 'if', blockType: $[2].blockType, then: $[2].body, else: $[4], label: checkLabel($[1], $[6]) })),

	Rule(['try_table', maybe_id, try_table_body, 'end', maybe_id],
		$ => ({ op: 'try_table', blockType: $[2].blockType, catches: $[2].catches, body: $[2].body, label: checkLabel($[1], $[4]) })),
	Rule(['throw', idx],											$ => ({ op: 'throw', tagIndex: $[1] })),
	Rule(['throw_ref'],												_ => ({ op: 'throw_ref' })),

	Rule(['br_table', List(idx)],									$ => ({ op: 'br_table', labels: $[1].slice(0, -1), default: $[1].at(-1)! })),
	Rule(['call_indirect', func_type],								$ => ({ op: 'call_indirect', typeIndex: $[1].typeIndex ?? 0, tableIndex: 0 })),

	Rule(['memory.size'],											_ => ({ op: 'memory.size', imm: 0 })),
	Rule(['memory.grow'],											_ => ({ op: 'memory.grow', imm: 0 })),
	Rule(['select', MaybeList(result)], 							$ => ($[1].length ? { op: 'select', imm: $[1] } : { op: 'select' })),

	// Numeric constants: imm field	
	Rule(['i32.const', INT],										$ => ({ op: 'i32.const', imm: parseIntImm($[1]) })),
	Rule(['i64.const', INT],										$ => ({ op: 'i64.const', imm: BigInt(parseIntImm($[1])) })),
	Rule(['f32.const', FLOAT],										$ => ({ op: 'f32.const', imm: parseFloat($[1]) })),
	Rule(['f64.const', FLOAT],										$ => ({ op: 'f64.const', imm: parseFloat($[1]) })),

	Rule([termOneOf(Object.values(ROOT_OPS.NONE))],					$ => ({ op: $[0] } as WatInstr)),
	Rule([termOneOf(Object.values(ROOT_OPS.INDEX.LOCAL)), idx],		$ => ({ op: $[0], localIndex: $[1] })),
	Rule([termOneOf(Object.values(ROOT_OPS.INDEX.GLOBAL)), idx],	$ => ({ op: $[0], globalIndex: $[1] })),
	Rule([termOneOf(Object.values(ROOT_OPS.INDEX.TABLE)), idx],		$ => ({ op: $[0], tableIndex: $[1] })),
	Rule([termOneOf(Object.values(ROOT_OPS.INDEX.FUNC)), idx],		$ => ({ op: $[0], funcIndex: $[1] })),
	Rule([termOneOf(Object.values(ROOT_OPS.INDEX.LABEL)), idx],		$ => ({ op: $[0], label: $[1] })),

	Rule([termOneOf(Object.values(ROOT_OPS.MEM)), Maybe(memarg_offset), Maybe(memarg_align)], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0 })),

	// 0xFC-prefixed
	Rule([termOneOf(Object.values(FC_OPS.NONE))],					$ => ({ op: $[0] })),
	Rule(['data.drop', idx],										$ => ({ op: $[0], dataIndex: $[1] })),
	Rule(['elem.drop', idx],										$ => ({ op: $[0], elemIndex: $[1] })),
	Rule([termOneOf(Object.values(FC_OPS.INDEX.TABLE)), idx],		$ => ({ op: $[0], tableIndex: $[1] })),
	Rule([termOneOf(Object.values(FC_OPS.INDEX2)), idx, idx],		$ => ({ op: $[0], seg: $[1], target: $[2] })),

	// 0xFB-prefixed (GC)	
	Rule([termOneOf(Object.values(FB_OPS.NONE))],					$ => ({ op: $[0] })),
	Rule([termOneOf(Object.values(FB_OPS.TYPE)), idx],				$ => ({ op: $[0], typeIndex: $[1] })),
	Rule([termOneOf(Object.values(FB_OPS.TYPE_FIELD)), idx, nat],	$ =>({ op: $[0], typeIndex: $[1], field: $[2] })),
	Rule([termOneOf(Object.values(FB_OPS.TYPE_N)), idx, nat], 		$ => ({ op: $[0], typeIndex: $[1], n: $[2] })),
	Rule([termOneOf(Object.values(FB_OPS.TYPE_SEG.DATA)), idx, idx], $ => ({ op: $[0], typeIndex: $[1], dataIndex: $[2] })),
	Rule([termOneOf(Object.values(FB_OPS.TYPE_SEG.ELEM)), idx, idx], $ => ({ op: $[0], typeIndex: $[1], elemIndex: $[2] })),
	Rule([termOneOf(Object.values(FB_OPS.TYPE2)), idx, idx],		$ => ({ op: $[0], dst: $[1], src: $[2] })),
	Rule(['ref.null', heap_type],									$ => ({ op: 'ref.null', typeIndex: $[1] } as WatInstr)),
	Rule(['ref.test', '(', 'ref', 'null', heap_type, ')'],			$ => ({ op: 'ref.test', typeIndex: $[4], nullable: true } as WatInstr)),
	Rule(['ref.test', '(', 'ref', heap_type, ')'],					$ => ({ op: 'ref.test', typeIndex: $[3] } as WatInstr)),
	Rule(['ref.cast', '(', 'ref', 'null', heap_type, ')'],			$ => ({ op: 'ref.cast', typeIndex: $[4], nullable: true } as WatInstr)),
	Rule(['ref.cast', '(', 'ref', heap_type, ')'],					$ => ({ op: 'ref.cast', typeIndex: $[3] } as WatInstr)),
	// `flags` packs both operand types' nullability into one byte (bit 0 = `from`, bit 1 = `to`) --
	// see wasm.ts's own `toWAT` serializer for `br_on_cast(_fail)`, which decodes it the same way.
	// `ref_type`'s grammar only ever produces the `{ref,nullable}` shape (never a bare num/vec type) --
	// this narrows what its broader `ValType` return type admits, same escape hatch as `as WatInstr`.
	Rule(['br_on_cast', idx, ref_type, ref_type],					$ => { const [from, to] = [$[2], $[3]] as { ref: HeapType; nullable: boolean }[]; return { op: 'br_on_cast', label: $[1], flags: (from.nullable ? 1 : 0) | (to.nullable ? 2 : 0), from: from.ref, to: to.ref } as WatInstr; }),
	Rule(['br_on_cast_fail', idx, ref_type, ref_type],				$ => { const [from, to] = [$[2], $[3]] as { ref: HeapType; nullable: boolean }[]; return { op: 'br_on_cast_fail', label: $[1], flags: (from.nullable ? 1 : 0) | (to.nullable ? 2 : 0), from: from.ref, to: to.ref } as WatInstr; }),

	// 0xFD-prefixed (SIMD)
	Rule([termOneOf(Object.values(SIMD_OPS.NONE))], 				$ => ({ op: $[0] } as WatInstr)),
	Rule([termOneOf(Object.values(SIMD_OPS.MEM)), Maybe(memarg_offset), Maybe(memarg_align)], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0 })),
	Rule([termOneOf(Object.values(SIMD_OPS.LANE)), nat],			$ => ({ op: $[0], lane: $[1] })),
	Rule([termOneOf(Object.values(SIMD_OPS.LANEMEM)), Maybe(memarg_offset), Maybe(memarg_align), nat], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0, lane: $[3] })),

	// 0xFE-prefixed (threads)
	Rule([termOneOf(Object.values(THREAD_OPS.MEM)), Maybe(memarg_offset), Maybe(memarg_align)], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0 } as WatInstr)),
	Rule(['atomic.fence'], _ => ({ op: 'atomic.fence' })),
);

const local = Rules<WatLocal>(
	Rule(['(', 'local', val_type, ')'],			$ => ({ id: undefined, count: 1, type: $[2] })),
	Rule(['(', 'local', id, val_type, ')'],		$ => ({ id: $[2], count: 1, type: $[3] })),
	Rule(['(', 'local', id, id, ')'],			$ => ({ id: $[2], count: 1, type: { typeParam: $[3] } })),
);

function collectAsmItems(items: readonly WatInstr[][]): { locals: WatLocal[]; body: WatInstr[] } {
	const locals:	WatLocal[] = [];
	const body:		WatInstr[] = [];
	for (const group of items) {
		for (const item of group) {
			if (item.op === '__local')
				locals.push({ id: item.id, count: item.count, type: item.type });
			else
				body.push(item);
		}
	}
	return { locals, body };
}

const instr = Rules<WatInstr[]>(self => {
	const switch_arm = Rules<SwitchArm>(
		Rule(['(', id, MaybeList(self), ')'],							$ => ({ values: [$[1]], body: $[2].flat() })),
		Rule(['(', '(', MaybeList(id), ')', MaybeList(self), ')'],		$ => ({ values: $[2], body: $[4].flat() })),
	);

	return [
	Rule([plain_instr], $ => [$[0]]),
	Rule([local],		$ => [{op: '__local', ...$[0]}]),

	// Folded (s-expression) form: '(' op operand* ')', where each operand is itself a folded
	// instr. Desugars to the flat postfix sequence: operands (in order), then op. A direct
	// operand that's just a bare-number shortcut gets retyped to match `op`'s own numeric type
	// (e.g. `(i64.add 3 4)` -> i64.const, not i32.const; `(f32.add 3 4)` -> f32.const).
	Rule(['(', plain_instr, MaybeList(self), ')'], ($, ctx) => {
		const op = $[1];
		const prefix = op.op.split('.')[0];
		return [...$[2].map(seq => {
			const text = seq.length === 1 ? ctx.literalText.get(seq[0]) : undefined;
			if (text === undefined)
				return seq;
			const isFloatLit = seq[0].op === 'f64.const';
			switch (prefix) {
				case 'i64':
					if (isFloatLit)
						throw new Error(`float literal '${text}' can't be used as i64 -- it's not an exact integer`);
					return [{ op: 'i64.const', imm: BigInt(text) } as const];
				case 'i32':
					if (isFloatLit)
						throw new Error(`float literal '${text}' can't be used as i32 -- it's not an exact integer`);
					return seq;
				case 'f32':
					return [{ op: 'f32.const', imm: isFloatLit ? (seq[0] as { imm: number }).imm : parseFloat(text) } as const];
				case 'f64':
					return isFloatLit ? seq : [{ op: 'f64.const', imm: parseFloat(text) } as const];
				default:
					return seq;
			}
		}).flat(), op];
	}),

	Rule([NAT], ($, ctx) => {
		const text = $[0];
		const c: Instr = { op: 'i32.const', imm: Number(BigInt(text)) };
		ctx.literalText.set(c, text);
		return [c];
	}),
/*	Rule([FLOAT_ONLY], ($, ctx) => {
		const text = $[0];
		const c: Instr = { op: 'f64.const', imm: parseFloat(text) };
		ctx.literalText.set(c, text);
		return [c];
	}),
*/
	// A bare $id where an instr is expected means "read that local", so
	// `(i32.mul $x $y)` is shorthand for `(i32.mul (local.get $x) (local.get $y))`.
	Rule([id], ($, ctx) => {
		return [{ op: 'local.get', localIndex: ctx.defines.get($[0]) ?? $[0] }];
	}),

	Rule([str], ($, ctx) => [{ op: 'i32.const', imm: ctx.internString($[0]) }]),
	Rule(['STATIC_ARRAY', nat], ($, ctx) => [{ op: 'i32.const', imm: ctx.addData(new Uint8Array($[1])) }]),
	Rule(['STATIC_ARRAY', nat, nat], ($, ctx) => [{ op: 'i32.const', imm: ctx.addData(new Uint8Array($[1]), $[2]) }]),

	// Macro call / implicit call: '(' $name arg* ')'. Any locals the macro declares for itself stay embedded as `__local` markers in the returned WatInstr[]
	// -- expandCall's substInstr only renames them for hygiene, it doesn't strip them out -- so they flow on with the rest of the stream to whichever enclosing collectAsmItems/func_field call ends up hoisting them.
	Rule(['(', id, MaybeList(self), ')'], ($, ctx) => {
		const macro = ctx.macros.get($[1]);
		if (!macro)
			return [...$[2].flat(), { op: 'call', funcIndex: $[1] }];
		try {
			return expandMacro(ctx, macro, $[2]);
		} catch (e) {
			throw new Error(`macro '${$[1]}': ${e}`);
		}
	}),

	Rule(['let', id, val_type], $ => [{ op: '__local', id: $[1], count: 1, type: $[2]}, { op: 'local.set', localIndex: $[1]}]),

	Rule(['(', 'switch', id, MaybeList(switch_arm), ')'], ($, ctx) => {
		const key = $[2];
		const tag = ctx.defines.get(key);
		if (tag === undefined)
			return [{ op: '__switch', key, arms: $[3] }];
		for (const arm of $[3]) {
			if (arm.values.includes(tag))
				return arm.body;
		}
		throw new Error(`switch '${key}': no arm matches '${tag}'`);
	}),
	];
});

// --- Module fields ---

const inline_export = Rules(Rule(['(', 'export', str, ')'],			$ => $[2]));
const inline_import = Rules(Rule(['(', 'import', str, str, ')'],	$ => ({module: $[2], name: $[3]})));

type FuncHeaderItem =
	| { kind: 'export'; name: string }
	| { kind: 'import'; module: string; name: string }
	| { kind: 'type'; typeIdx: index }
	| { kind: 'param'; id?: string; type: ValType }
	| { kind: 'result'; type: ValType }

type FuncBodyItem = FuncHeaderItem | { kind: 'instr'; value: WatInstr[] };

const func_header_item = Rules<FuncHeaderItem>(
	Rule([inline_export],						$ => ({ kind: 'export', name: $[0] })),
	Rule([inline_import],						$ => ({ kind: 'import', ...$[0] })),
	Rule(['(', 'type', idx, ')'],				$ => ({ kind: 'type', typeIdx: $[2] })),
	Rule(['(', 'param', val_type, ')'],			$ => ({ kind: 'param', type: $[2] })),
	Rule(['(', 'param', id, val_type, ')'],		$ => ({ kind: 'param', id: $[2], type: $[3] })),
	Rule(['(', 'result', val_type, ')'],			$ => ({ kind: 'result', type: $[2] })),
);

function collectFuncItems(items: FuncBodyItem[]) {
	const exp: 		string[] = [];
	let imp:		Imp | undefined;
	let typeIndex:	index | undefined;
	const params:	ParamType[] = [];
	const results:	ValType[] = [];
	const instr:	WatInstr[][] = [];

	for (const item of items) {
		switch (item.kind) {
			case 'export':	exp.push(item.name); break;
			case 'import':	imp = { module: item.module, name: item.name }; break;
			case 'type':	typeIndex = item.typeIdx; break;
			case 'param':	params.push({ id: item.id, type: item.type }); break;
			case 'result':	results.push(item.type); break;
			case 'instr':	instr.push(item.value); break;
		}
	}
	return {
		exp,
		imp,
		typeIndex, params, results,
		instr
	};
}


const func_header = Rules(
	Rule([MaybeList(func_header_item)], $ => {
		const {exp, imp, typeIndex, params, results} = collectFuncItems($[0]);
		return {
			export:		exp.length ? exp : undefined,
			import:		imp,
			typeuse:	{ typeIndex, params, results },
		};
	})
);

// A plain MaybeList(func_header_item) followed by `instrs` is ambiguous for an LALR(1) parser:
// both a header item (e.g. `(param ...)`) and a folded instr (e.g. `(i32.mul ...)`) start with
// '(', so at "end of header / start of body" the parser can't decide whether to keep matching
// header items or start on instrs using only one token of lookahead. Folding header items and
// body instrs into a single list sidesteps the ambiguity: there's no more list-to-list boundary,
// just per-item alternatives (disambiguated by the token after '(', same as header items already
// are from each other), so a func body consisting entirely of folded instrs now parses correctly.

// Macro calls are recognized once, on `instr` itself (see the comment by ParseCtx above) -- any
// locals a called macro declares arrive here embedded as `__local` markers in the expanded
// WatInstr[], hoisted out into `locals` below same as a directly-written `(local ...)` would be,
// not through a separate func_body_item alternative.
const func_body_item = Rules<FuncBodyItem>(
	Rule([func_header_item],	$ => $[0]),
	Rule([instr],				$ => ({ kind: 'instr', value: $[0] })),
);

const func_field = Rules<Func>(
	Rule(['(', 'func', maybe_id, MaybeList(func_body_item), ')'], $ => {
		const {exp, imp, typeIndex, params, results, instr} = collectFuncItems($[3]);
		return {
			type: 'func', id: $[2],
			export: exp.length ? exp : undefined,
			import: imp,
			value: { typeIndex, params, results },
			...collectAsmItems(instr)
		};
	}),
);

const table_field = Rules<Table>(
	Rule(['(', 'table', maybe_id, inline_export, table_type, ')'],	$ => ({ type: 'table', id: $[2], export: [$[3]], value: $[4] })),
	Rule(['(', 'table', maybe_id, inline_import, table_type, ')'],	$ => ({ type: 'table', id: $[2], import: $[3], value: $[4] })),
	Rule(['(', 'table', maybe_id, table_type, ')'], 					$ => ({ type: 'table', id: $[2], value: $[3] })),
);

const memory_field = Rules<Memory>(
	Rule(['(', 'memory', maybe_id, inline_export, limits, ')'],		$ => ({ type: 'memory', id: $[2], export: [$[3]], value: $[4] })),
	Rule(['(', 'memory', maybe_id, inline_import, limits, ')'],		$ => ({ type: 'memory', id: $[2], import: $[3], value: $[4] })),
	Rule(['(', 'memory', maybe_id, limits, ')'], 					$ => ({ type: 'memory', id: $[2], value: $[3] })),
);

// Reuses `func_header` (export/import/type/param/result as one flat item list, same trick
// `func_header`'s own doc comment explains) rather than typeuse+inline_export/inline_import as
// separate alternatives -- those all start with '(' too, and typeuse's own leading `(type idx)`
// is itself optional, so distinguishing them needs more than the LALR(1) lookahead this parser
// generator has; `func_header_item`'s flat-list-of-alternatives shape sidesteps it entirely.
// Results are always empty for a real tag, but that's a validator concern, not hand-checked here.
const tag_field = Rules<Tag>(
	Rule(['(', 'tag', maybe_id, func_header, ')'], $ => ({ type: 'tag', id: $[2], export: $[3].export, import: $[3].import, value: $[3].typeuse })),
);

// Global init exprs and elem/data offset exprs are wasm "constant expressions": no locals, and no
// switch left unresolved, are ever valid there -- there's no enclosing function for a local to
// belong to, and no enclosing macro call for a switch keyed on a macro parameter to resolve against
// (see the `switch` rule's own comment). Requiring both to already be gone rules out the two
// synthetic WAT-only markers -- unlike a func body (see `Func.body`), which still has to defer an
// unresolved switch all the way to `toWasm` (a switch there might yet resolve via an enclosing macro
// call). Still returns `WatInstr[]`, not `Instr[]`: `toWasm`'s `resolveInstrs` (index-name resolution,
// and for block/loop/if/try_table, the pre-resolution `ValType[]` blockType -- see `WatInstr`'s own
// comment) still needs to run on these, same as any other body.
function assertResolved(items: WatInstr[], where: string): Instr[] {
	for (const i of items) {
		if (i.op === '__local')
			throw new Error(`${where}: can't use a macro or switch arm that declares its own local ('${i.id ?? '(anonymous)'}') here -- only func/macro bodies can hold locals`);
		if (i.op === '__switch')
			throw new Error(`${where}: switch '${i.key}' is unresolved -- not a ctx.defines entry, and a constant expression has no enclosing macro call to bind it to a $tag argument`);
	}
	return items as Instr[];
}

const global_field = Rules<Global>(
	Rule(['(', 'global', maybe_id, inline_export, global_type, instrs, ')'], $	=> ({ type: 'global', id: $[2], export: [$[3]], value: $[4], init: assertResolved($[5], 'global') })),
	Rule(['(', 'global', maybe_id, inline_import, global_type, ')'],			$	=> ({ type: 'global', id: $[2], import: $[3], value: $[4], init: [] })),
	Rule(['(', 'global', maybe_id, global_type, instrs, ')'],				$	=> ({ type: 'global', id: $[2], value: $[3], init: assertResolved($[4], 'global') })),
);

const export_field = Rules<Export>(
	Rule(['(', 'export', str, '(', OneOf(['func', 'table', 'memory', 'global', 'tag']), idx, ')', ')'], $ => ({ type: 'export', name: $[2], kind: $[4], index: $[5] })),
);

const import_desc = Rules<Func | Table | Memory | Global | Tag>(
	Rule(['(', 'func',   maybe_id, func_header, ')'],				$ => ({ type: 'func',	id: $[2], value: $[3].typeuse, locals: [], body: [] })),
	Rule(['(', 'table',  maybe_id, table_type,  ')'],				$ => ({ type: 'table',	id: $[2], value: $[3] })),
	Rule(['(', 'memory', maybe_id, limits,     ')'],				$ => ({ type: 'memory', id: $[2], value: $[3] })),
	Rule(['(', 'global', maybe_id, global_type, ')'],				$ => ({ type: 'global', id: $[2], value: $[3], init: [] })),
	Rule(['(', 'tag',    maybe_id, func_header, ')'],				$ => ({ type: 'tag',	id: $[2], value: $[3].typeuse })),
);

// Both alternatives require their own wrapping parens (`(offset ...)` or bare `(...)`, never a
// naked instr with no parens at all) precisely so this can never sit directly against whatever
// follows it in elem_field/data_field (a MaybeList(idx) or MaybeList(str)) with nothing to mark
// where the offset ends -- a bare, unparenthesized single instr here (e.g. `i32.add` with no
// operands, since ROOT_OPS.NONE ops don't grab trailing tokens without folded parens) would
// desugar `(elem $t i32.add 5 6)` into offset=[i32.add], init=[5,6], with "5 6" silently
// swallowed as elem's own index list rather than i32.add's operands -- syntactically legal,
// semantically nonsense, and exactly the kind of position that forced NAT into the follow set of
// every instr-ending state in the grammar (see the retyping/shortcut rules above).
const offset_expr = Rules<Instr[]>(
	Rule(['(', 'offset', instrs, ')'],	$ => assertResolved($[2], 'offset')),
	Rule(['(', instr, ')'],				$ => assertResolved($[1], 'offset')),
);

const elem_field = Rules<Elem>(
	Rule(['(', 'elem', maybe_id, '(', 'table', idx, ')', offset_expr, ref_type, MaybeList(idx), ')'],	$ => ({ type: 'elem', id: $[2], table: $[5], offset: $[7], init: $[9] })),
	Rule(['(', 'elem', maybe_id, offset_expr, MaybeList(idx), ')'],										$ => ({ type: 'elem', id: $[2], offset: $[3], init: $[4] })),
	Rule(['(', 'elem', maybe_id, MaybeList(idx), ')'],													$ => ({ type: 'elem', id: $[2], init: $[3] })),
);

const data_field = Rules<Data>(
	Rule(['(', 'data', maybe_id, '(', 'memory', idx, ')', offset_expr, MaybeList(str), ')'],			$ => ({ type: 'data', id: $[2], memory: $[5], offset: $[7], init: new TextEncoder().encode($[8].join('')) })),
	Rule(['(', 'data', maybe_id, offset_expr, MaybeList(str), ')'],										$ => ({ type: 'data', id: $[2], offset: $[3], init: new TextEncoder().encode($[4].join('')) })),
	Rule(['(', 'data', maybe_id, MaybeList(str), ')'],													$ => ({ type: 'data', id: $[2], init: new TextEncoder().encode($[3].join('')) })),
);

// `(macro NAME (param $a $b ...) body...)`: not a real module field (produces nothing in the
// output), just registers into ctx.macros as a side effect and disappears. Its body is parsed
// with the same func_body_item list a func uses, so `(local ...)` declarations inside a macro
// work the same way they do in a func body.
const macro_params = Maybe(Rules<string[]>(Rule(['(', 'param', MaybeList(id), ')'], $ => $[2])));

const macro_field = Rules<undefined>(
	Rule(['(', 'macro', id, macro_params, MaybeList(func_body_item), ')'], ($, ctx) => {
		const body: WatInstr[] = [];
		for (const item of $[4]) {
			if (item.kind === 'instr')
				body.push(...item.value);
			else
				throw new Error(`macro '${$[2]}': '${item.kind}' isn't meaningful inside a macro body`);
		}
		ctx.macros.set($[2], { params: $[3] ?? [], body });
		return undefined;
	}),
);

const storage_type = Rules<StorageType>(
	OneOf(['i8', 'i16']),
	val_type,
);

const field_type = Rules<FieldType>(
	Rule(['(', 'field', maybe_id, storage_type, ')'],						$ => ({ type: $[3], mut: false })),
	Rule(['(', 'field', maybe_id, '(', 'mut', storage_type, ')', ')'],	$ => ({ type: $[5], mut: true })),
);

// A plain `MaybeList(param), MaybeList(result)` sequence -- as `func_type` uses inline -- runs into a
// state-merging conflict once it's wrapped in its own `( func ... )`: that prefix is shared with
// `func_field`'s and `import_desc`'s own `(func ...)` alternatives, and the merged LALR state can't
// keep the "still matching params" vs "params done, now matching results" transition straight (an
// empty param list followed directly by a result silently failed to parse). Folding both into one
// per-item-tagged list, the same trick `func_header_item`/`collectFuncItems` use, sidesteps it.
type ParamOrResult = { kind: 'param'; id?: string; type: ValType } | { kind: 'result'; type: ValType };

const param_or_result = Rules<ParamOrResult>(
	Rule(['(', 'param', val_type, ')'],		$ => ({ kind: 'param', type: $[2] })),
	Rule(['(', 'param', id, val_type, ')'],	$ => ({ kind: 'param', id: $[2], type: $[3] })),
	Rule(['(', 'result', val_type, ')'],		$ => ({ kind: 'result', type: $[2] })),
);

const comp_type = Rules<CompType>(
	Rule(['(', 'func', MaybeList(param_or_result), ')'],	$ => {
		const params: ParamType[] = [];
		const results: ValType[] = [];
		for (const item of $[2]) {
			if (item.kind === 'param')
				params.push({ id: item.id, type: item.type });
			else
				results.push(item.type);
		}
		return { kind: 'func', params, results };
	}),
	Rule(['(', 'struct', MaybeList(field_type), ')'],				$ => ({ kind: 'struct', fields: $[2] })),
	Rule(['(', 'array', field_type, ')'],							$ => ({ kind: 'array', field: $[2] })),
);

// `sub`'s supertype list is left as raw `idx` (name-or-number) here, and the whole thing cast to the
// real `SubType` -- both it and any named/self-referencing heap type nested in `comp_type` only get
// resolved in `WasmModule.resolve()`, once every `(type ...)` in the module is assembled.
const sub_type = Rules<SubType>(
	Rule(['(', 'sub', 'final', MaybeList(idx), comp_type, ')'],	$ => ({ supertypes: $[3], type: $[4], final: true } as SubType)),
	Rule(['(', 'sub', MaybeList(idx), comp_type, ')'],				$ => ({ supertypes: $[2], type: $[3], final: false } as SubType)),
	comp_type,
);

const module_field = Rules<ModuleField | undefined>(
	Rule(['(', 'type', maybe_id, sub_type, ')'],		$ => ({ type: 'type', id: $[2], desc: $[3] })),
	func_field,
	table_field,
	memory_field,
	global_field,
	tag_field,
	export_field,
	Rule(['(', 'import', str, str, import_desc, ')'],	$ => ({ type: 'import', module: $[2], name: $[3], desc: $[4] })),
	elem_field,
	data_field,
	Rule(['(', 'start', idx, ')'], 						$ => ({ type: 'start', func: $[2] })),
	macro_field,
);

// Filters out macro definitions (never real fields, see macro_field), then drains any interned
// string literals into a synthesized data segment -- and a synthesized default memory too, if
// the module didn't declare its own, since a data segment needs one to target.
function definedFields($: (ModuleField | undefined)[], ctx: ParseCtx): ModuleField[] {
	const fields = $.filter((f): f is ModuleField => f !== undefined);
	if (ctx.data) {
		if (!fields.some(f => f.type === 'memory'))
			fields.push({ type: 'memory', value: { min: 1 } });
		fields.push({ type: 'data', offset: [{ op: 'i32.const', imm: 0 }], init: ctx.data });
	}
	return fields;
}

const SKIP = [/\s+/, /;;[^\n]*/, /\(;[^]*?;\)/];

export const parser = makeCachedParser({
	skip: SKIP,
	start: Rules<Module>(
		Rule(['(', 'module', maybe_id, MaybeList(module_field), ')'],	($, ctx) => ({ id: $[2], fields: definedFields($[3], ctx) })),
		Rule([MaybeList(module_field)],									($, ctx) => ({ fields: definedFields($[0], ctx) })),
	)
}, {}, {
	sources:	__filename,
	cachePath:	path.join(__dirname, '../../.tables-cache/wat-parser.tables'),
});

export function parseWat(src: string, defines?: Record<string, string|number>): Module {
	return parser.parse(src, new ParseCtx(defines));
}

//-----------------------------------------------------------------------------
//	inline parser
//-----------------------------------------------------------------------------

// A second parser, for callers that only have a bare instruction sequence, not a whole module.
// Shares every rule this transitively depends on with the main grammar.
//
// Doesn't run `toWasm`'s own `resolveInstr` pass (block/loop/if label resolution, local name->index
// resolution) -- there's no enclosing module/func here for any of that to resolve against. Callers
// that need a real `Instr[]` are on the hook for known-flat snippets themselves (no `block`/`loop`/`if`,
// the only instr shapes `WatInstr` and `Instr` differ on -- `collectAsmItems` above already hoists
// every `(local ...)` out of `.body` into `.locals`, so `__local` markers never survive into it), and
// for resolving `WatLocal.id` to a real index themselves (see towasm.ts's `resolveAsmLocals`).

export interface ParsedAsmBody { locals: WatLocal[]; body: WatInstr[] }

const asmBodyParser = makeCachedParser({
	skip: SKIP,
	start: Rules<ParsedAsmBody>(
		Rule([MaybeList(instr)], $ => collectAsmItems($[0])),
	)
}, {}, {
	sources:	__filename,
	cachePath:	path.join(__dirname, '../../.tables-cache/wat-parser-asm.tables'),
});

export const TYPE_EXPR = TYPE_EXPR_PREFIX;

export function parseAsmBody(src: string, defines?: Record<string, string|number>) {
	return asmBodyParser.parse(src, new ParseCtx(defines));
}

//-----------------------------------------------------------------------------
//	toWasm
//-----------------------------------------------------------------------------

// Nothing here resolves a single `$name` any more -- it just lowers the WAT AST into the shape
// `WasmModule.resolve()` expects (real wasm.ts types, `$name`s left wherever an index goes), and lets
// that one call at the end do every bit of name resolution: type-section supertypes/nested heap
// types, table/global value types, per-function locals + bodies, and every constant expression
// (global inits, elem/data offsets) alike -- see its own doc comment in wasm.ts.
export function toWasm(mod: Module): WasmModule {
	const rawExports:	{ name: string; kind: 'func' | 'table' | 'memory' | 'global' | 'tag'; index: index }[] = [];
	const imports:		WasmImport[]	= [];
	const typesList:	SubType[]		= [];

	const own = {
		func:		[] as Func[],
		table:		[] as Table[],
		memory:		[] as Memory[],
		global:		[] as Global[],
		tag:		[] as Tag[],
	};

	// Only used to give an *anonymous* inline `(export ...)` a real numeric index immediately --
	// `resolve()` handles every *named* cross-reference generically once the whole module is
	// assembled, but an anonymous entity has no name for it to look up later. Assumes a kind's
	// imports textually precede its own declarations here, same as every real .wat file already does
	// (and the same assumption this file's lowering has always made).
	const counter = { func: 0, table: 0, memory: 0, global: 0, tag: 0 };
	function declare(kind: keyof typeof counter, item: { id?: string; export?: string[] }) {
		const idx = counter[kind]++;
		item.export?.forEach(e => rawExports.push({ name: e, kind, index: item.id ?? idx }));
	}

	function addImport(f: Import, desc: any) {
		declare(f.desc.type, f.desc);
		imports.push({ module: f.module, name: f.name, desc: {kind: f.desc.type, id: f.desc.id, ...desc}});
	}

	// Explicit `(type $t)` typeuse: left as the raw name/index, resolved later. No explicit type:
	// always push a fresh type-section entry rather than deduping via `wasmGetFuncTypeIdx` -- a
	// function's own param names live only on its own type entry (wasm.ts has nowhere else to keep
	// per-function param names separate from the type they reference), so merging two structurally
	// equal but differently-named signatures would silently lose one function's names.
	function getFuncTypeIdx(tu: FuncType): index {
		return tu.typeIndex !== undefined ? tu.typeIndex : typesList.push({ kind: 'func', params: tu.params, results: tu.results }) - 1;
	}

	// A `$T`-typed local only ever originates from a switch arm (see `WatLocal`'s own comment) -- one
	// still carrying it here means whatever `switch` produced it was never resolved against a concrete
	// type (only `instantiateAsmBody`, an inline-asm-only pass, ever does that), a real authoring error
	// rather than something to silently pass through to the binary encoder.
	function concreteLocalType(local: WatLocal): ValType {
		if (typeof local.type === 'object' && 'typeParam' in local.type)
			throw new Error(`local '${local.id ?? '(anonymous)'}': uninstantiated '$${local.type.typeParam}' type -- a switch arm's own $T-typed local only resolves via instantiateAsmBody (inline asm), never in a real module`);
		return local.type;
	}

	// Strips the two synthetic WAT-only markers out of a func body: `__local` (a macro/switch-arm's
	// own local declaration, discovered mid-body instead of up front, but sharing the same index
	// space as the func's own declared locals -- hoisted into the returned `locals` list so `resolve()`
	// sees it too) and `__switch` (only ever left behind by a truly unresolved conditional-assembly
	// key). Doesn't recurse into block/loop/if/try_table bodies -- neither marker is expected to
	// survive macro expansion nested that deep.
	function stripMarkers(instrs: WatInstr[]): { body: Instr[]; locals: WatLocal[] } {
		const locals: WatLocal[] = [];
		const body: Instr[] = [];
		for (const i of instrs) {
			if (i.op === '__switch')
				throw new Error(`switch '${i.key}': unresolved -- not a ctx.defines entry, and not inside a macro call binding it to a $tag argument`);
			if (i.op === '__local')
				locals.push({ count: i.count, type: i.type, id: i.id });
			else
				body.push(i as Instr);
		}
		return { body, locals };
	}

	for (const f of mod.fields)
		if (f.type === 'type')
			typesList.push({ ...f.desc, id: f.id });

	for (const f of mod.fields) {
		switch (f.type) {
			case 'import':
				switch (f.desc.type) {
					case 'func':	addImport(f, { typeIndex: getFuncTypeIdx(f.desc.value) }); break;
					case 'table':	addImport(f, { type: f.desc.value }); break;
					case 'memory':	addImport(f, { type: f.desc.value }); break;
					case 'global':	addImport(f, { type: f.desc.value }); break;
					case 'tag':		addImport(f, { attribute: 0, typeIndex: getFuncTypeIdx(f.desc.value) }); break;
				}
				break;
			case 'export':	rawExports.push(f); break; //{ name: f.name, kind: f.kind, index: f.index }); break;
			case 'func': case 'table': case 'memory': case 'global': case 'tag':
				declare(f.type, f);
				own[f.type].push(f as any);
				break;
		}
	}

	const wmod	= new WasmModule();
	wmod.imports		= imports;
	wmod.functionTypes	= own.func.map(f => getFuncTypeIdx(f.value)) as number[];
	wmod.tables			= own.table.map(t => ({ ...t.value, id: t.id }));
	wmod.memories		= own.memory.map(m => ({ ...m.value, id: m.id }));
	wmod.globals		= own.global.map(g => ({ type: g.value, init: g.init, id: g.id }));
	wmod.tags			= own.tag.map(t => ({ attribute: 0, typeIndex: getFuncTypeIdx(t.value) as number, id: t.id }));
	wmod.code			= own.func.map(f => {
		const { body, locals: hoisted } = stripMarkers(f.body);
		return {
			locals: [...f.locals, ...hoisted].map(l => ({ count: l.count, type: concreteLocalType(l), id: l.id })),
			body,
			id: f.id,
		};
	});
	wmod.exports = rawExports.map(e => ({ name: e.name, kind: e.kind, index: e.index }));

	for (const f of mod.fields) {
		switch (f.type) {
			case 'start':
				wmod.start = f.func;
				break;
			case 'elem':
				(wmod.elements ??= []).push(f.offset
					? { mode: 'active', table: f.table ?? 0, offset: f.offset, reftype: { ref: 'func', nullable: true }, funcIndices: f.init, id: f.id }
					: { mode: 'passive', reftype: { ref: 'func', nullable: true }, funcIndices: f.init, id: f.id }
				);
				break;
			case 'data':
				// `memory` must be omitted entirely (not just left `undefined`) when absent -- its
				// binary encoding picks the compact "implicit memory 0" wire variant by checking
				// `'memory' in v`, which an explicit `undefined` value would still satisfy.
				(wmod.datas ??= []).push(f.offset
					? { mode: 'active', ...(f.memory !== undefined ? { memory: f.memory } : {}), offset: f.offset, bytes: f.init, id: f.id }
					: { mode: 'passive', bytes: f.init, id: f.id }
				);
				break;
		}
	}

	if (typesList.length > 0)
		wmod.types = { types: typesList, groupSizes: typesList.map(() => 1) };

	wmod.resolve();
	return wmod;
}
