import { makeParser, Rules, makeRule, List, MaybeList, Maybe, OneOf, Forward } from '../tison';
import { Instr, ValType, Local, GlobalType, TableType, SubType, WasmModule, Limits, Import as WasmImport } from '@isopodlabs/binary_libs/wasm';
import { ROOT_OPS, FB_OPS, FC_OPS, SIMD_OPS, THREAD_OPS, equalFuncSig } from '@isopodlabs/binary_libs/wasm';

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

// wasm.ts Limits is inlined into MemType/TableType; expose a plain shape for WAT
//interface Limits	{ min: number; max?: number }
//interface MemType	{ min: number; max?: number }
type MemType	= Limits;
interface FuncType	{ params: {id?: string; type: ValType}[]; results: ValType[] }
interface TypeUse	{ typeIndex?: index; params: {id?: string; type: ValType}[]; results: ValType[] };
interface Imp		{ module: string, name: string };

// A type-parametric local's declared type, before `instantiateAsmBody` substitutes it for a real numeric type
// -- `$T` is the one recognized placeholder name (a fixed, documented convention, the same `$T` a typed-op reference elsewhere uses; not a general named-type-parameter system,
// nothing in this codebase needs more than one).
// Every switch arm can declare locals so `WatLocal.type` has to admit this alongside a real `ValType`
// -- a func/macro's own locals only ever construct the real-`ValType` half; this placeholder only ever originates from a switch arm, and only ever survives to `toWasm` if that arm's `$T` is never instantiated (a real authoring error
// `toWasm` itself catches, see its own comment).
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
type Func	= Field<'func', TypeUse> & { locals: WatLocal[]; body: WatInstr[] }
type Table	= Field<'table', TableType>
type Memory	= Field<'memory', MemType>
type Global	= Field<'global', GlobalType> & { init: Instr[] }

interface Export	{ type: 'export'; name: string; kind: 'func' | 'table' | 'memory' | 'global'; index: index }
interface Import	{ type: 'import'; module: string; name: string; desc: Func | Table | Memory | Global }
interface Elem		{ type: 'elem'; id?: string; table?: index; offset?: Instr[]; init: index[] }
interface Data		{ type: 'data'; id?: string; memory?: index; offset?: Instr[]; init: Uint8Array }

type ModuleField =
	| { type: 'type'; id?: string; functype: FuncType }
	| Func | Table | Memory | Global | Export | Import | Elem | Data
	| { type: 'start'; func: index };
interface Module	{ id?: string; fields: ModuleField[] }

// ===================================================================
//  Grammar
// ===================================================================

interface MacroDef { params: string[]; body: WatInstr[] }

class ParseCtx {
	macros			= new Map<string, MacroDef>;
	literalText		= new WeakMap<object, string>;
	macroUid		= 0;
	data			= new Uint8Array(0);
	dataStrings		= new Map<string, number>;
	// External, caller-supplied conditional-assembly symbols for `switch` (e.g. target/feature
	// flags) -- keyed and valued the same $-prefixed way a `switch` key and its arm tags are
	// written in source, so a resolved define slots into arm.values.includes(...) unchanged.
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

	expandCall(name: string, args: WatInstr[][]): WatInstr[] {
		const macro = this.macros.get(name);
		if (!macro)
			return [...args.flat(), { op: 'call', funcIndex: name }];

		if (args.length !== macro.params.length)
			throw new Error(`macro '${name}' expects ${macro.params.length} argument(s), got ${args.length}`);

		const paramSubst	= new Map(macro.params.map((p, i) => [p, args[i]]));
		// Only named locals need renaming -- an anonymous `(local i32)` has no name a body reference
		// could collide with, and is left as-is in the locals list below either way.
		const renames		= new Map<string, string>;

		const substInstr = (i: any): WatInstr[] => {
			if (i.op === '__local' && i.id) {
				const newid = `${i.id}__${++this.macroUid}`;
				renames.set(i.id, newid);
				return {...i, id: newid };
			}

			if (typeof i.localIndex === 'string') {
				if (paramSubst.has(i.localIndex)) {
					if (i.op !== 'local.get')
						throw new Error(`macro '${name}': can't ${i.op} parameter '${i.localIndex}' -- parameters are read-only expressions`);
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
						throw new Error(`macro '${name}': switch key '${i.key}' isn't a parameter bound to a bare $tag argument at this call site`);
					const tag = arg[0].localIndex;
					for (const arm of i.arms) {
						if (arm.values.includes(tag))
							return arm.body.flatMap(substInstr);
					}
					throw new Error(`macro '${name}': switch '${i.key}' -- no arm matches '${tag}'`);
				}
				default:
					return [i];
			}
		};
		return macro.body.flatMap(substInstr);
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
const idx		= Rules<index>(
	Rule([ID],  	($, ctx) => ctx.defines.get($[0]) ?? $[0]),
	nat
);

// funcref/externref aren't ValType values on their own -- ValType's reference-type case is the
// object shape { ref: HeapType, nullable: boolean } (see wasm.ts's VALTYPE_SWITCH); a bare string
// here would fall through the binary encoder's discriminator (which only special-cases
// i32/i64/f32/f64 for the string branch) and silently encode as v128.
const reftype	= Rules<ValType>(
	Rule(['funcref'],	(): ValType => ({ ref: 'func', nullable: true })),
	Rule(['externref'],	(): ValType => ({ ref: 'extern', nullable: true })),
);
const valtype	= Rules<ValType>(
	OneOf(['i32', 'i64', 'f32', 'f64', 'v128']),
	reftype,
);

const heaptype = Rules(
	Rule([OneOf(['func', 'extern', 'any', 'eq', 'i31', 'struct', 'array', 'none', 'noextern', 'nofunc', 'exn', 'noexn'])], $ => $[0]),
	Rule([idx], $ => $[0]),
);

const param = Rules<{id?: string; type: ValType}>(
	Rule(['(', 'param', valtype, ')'],		$ => ({ type: $[2] })),
	Rule(['(', 'param', id, valtype, ')'],	$ => ({ id: $[2], type: $[3] })),
);
const result = Rules<ValType>(
	Rule(['(', 'result', valtype, ')'],		$ => $[2])
);

const functype = Rules<FuncType>(
	Rule(['(', 'func', MaybeList(param), MaybeList(result), ')'],	$ => ({ params: $[2], results: $[3] })),
);

const limits = Rules<Limits>(
	Rule([nat],			$ => ({ min: $[0] })),
	Rule([nat, nat],	$ => ({ min: $[0], max: $[1] })),
);

// wasm.ts GlobalType = { type: ValType, mut: boolean }
const globaltype = Rules<GlobalType>(
	Rule([valtype],						$ => ({ type: $[0], mut: false })),
	Rule(['(', 'mut', valtype, ')'],	$ => ({ type: $[2], mut: true })),
);

// wasm.ts TableType = { reftype: ValType, limits: { min, max? } }
const tabletype = Rules<TableType>(
	Rule([limits, reftype],				$ => ({ reftype: $[1], limits: $[0] })),
);

const typeuse = Rules<TypeUse>(
	Rule([Maybe(Rules(Rule(['(', 'type', idx, ')'], $ => $[2]))), MaybeList(param), MaybeList(result)],	$ => ({ typeIdx: $[0], params: $[1], results: $[2] })),
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

// WAT only supports the valtype form inline; typeIndex form uses typeuse
const blocktype = Maybe(Rules<ValType>(
	Rule(['(', 'result', valtype, ')'], $ => $[2]),
));

// A few rules below still need `as Instr`: where the op comes from a OneOf(...) with more than 25 values (tsc limit)
const plain_instr = Rules<Instr>(
	Rule(['block', maybe_id, blocktype, instrs, 'end', maybe_id],	$ => ({ op: 'block', blockType: $[2], body: $[3], label: checkLabel($[1], $[5]) })),
	Rule(['loop', maybe_id, blocktype, instrs, 'end', maybe_id],	$ => ({ op: 'loop', blockType: $[2], body: $[3], label: checkLabel($[1], $[5]) })),
	Rule(['if', maybe_id, blocktype, instrs, 'end', maybe_id],		$ => ({ op: 'if', blockType: $[2], then: $[3], label: checkLabel($[1], $[5]) })),

	Rule(['if', maybe_id, blocktype, instrs, 'else', instrs, 'end', maybe_id],	$ => ({ op: 'if', blockType: $[2], then: $[3], else: $[5], label: checkLabel($[1], $[7]) })),

	Rule(['br_table', List(idx)],							$ => ({ op: 'br_table', labels: $[1].slice(0, -1), default: $[1].at(-1)! })),
	Rule(['call_indirect', typeuse],						$ => ({ op: 'call_indirect', typeIndex: $[1].typeIndex ?? 0, tableIndex: 0 })),

	Rule(['memory.size'],									_ => ({ op: 'memory.size', imm: 0 })),
	Rule(['memory.grow'],									_ => ({ op: 'memory.grow', imm: 0 })),
	Rule(['select', MaybeList(result)], 					$ => ($[1].length ? { op: 'select', imm: $[1] } : { op: 'select' })),

	// Numeric constants: imm field
	Rule(['i32.const', INT],								$ => ({ op: 'i32.const', imm: parseIntImm($[1]) })),
	Rule(['i64.const', INT],								$ => ({ op: 'i64.const', imm: BigInt(parseIntImm($[1])) })),
	Rule(['f32.const', FLOAT],								$ => ({ op: 'f32.const', imm: parseFloat($[1]) })),
	Rule(['f64.const', FLOAT],								$ => ({ op: 'f64.const', imm: parseFloat($[1]) })),

	Rule([OneOf(Object.values(ROOT_OPS.NONE))],				$ => ({ op: $[0] } as Instr)),
	Rule([OneOf(Object.values(ROOT_OPS.INDEX.LOCAL)), idx],	$ => ({ op: $[0], localIndex: $[1] })),
	Rule([OneOf(Object.values(ROOT_OPS.INDEX.GLOBAL)), idx],$ => ({ op: $[0], globalIndex: $[1] })),
	Rule([OneOf(Object.values(ROOT_OPS.INDEX.TABLE)), idx],	$ => ({ op: $[0], tableIndex: $[1] })),
	Rule([OneOf(Object.values(ROOT_OPS.INDEX.FUNC)), idx],	$ => ({ op: $[0], funcIndex: $[1] })),
	Rule([OneOf(Object.values(ROOT_OPS.INDEX.LABEL)), idx],	$ => ({ op: $[0], label: $[1] })),

	Rule([OneOf(Object.values(ROOT_OPS.MEM)), Maybe(memarg_offset), Maybe(memarg_align)], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0 })),

	// 0xFC-prefixed
	Rule([OneOf(Object.values(FC_OPS.NONE))],				$ => ({ op: $[0] })),
	Rule(['data.drop', idx],								$ => ({ op: $[0], dataIndex: $[1] })),
	Rule(['elem.drop', idx],								$ => ({ op: $[0], elemIndex: $[1] })),
	Rule([OneOf(Object.values(FC_OPS.INDEX.TABLE)), idx],	$ => ({ op: $[0], tableIndex: $[1] })),
	Rule([OneOf(Object.values(FC_OPS.INDEX2)), idx, idx],	$ => ({ op: $[0], seg: $[1], target: $[2] })),

	// 0xFB-prefixed (GC)
	Rule([OneOf(Object.values(FB_OPS.NONE))],				$ => ({ op: $[0] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE)), idx],			$ => ({ op: $[0], typeIndex: $[1] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE_FIELD)), idx, nat],$ =>({ op: $[0], typeIndex: $[1], field: $[2] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE_N)), idx, nat], 	$ => ({ op: $[0], typeIndex: $[1], n: $[2] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE_SEG.DATA)), idx, idx], $ => ({ op: $[0], typeIndex: $[1], dataIndex: $[2] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE_SEG.ELEM)), idx, idx], $ => ({ op: $[0], typeIndex: $[1], elemIndex: $[2] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE2)), idx, idx],	$ => ({ op: $[0], dst: $[1], src: $[2] })),
	Rule(['ref.test', '(', 'ref', 'null', heaptype, ')'],	$ => ({ op: 'ref.test', typeIndex: $[4], nullable: true } as Instr)),
	Rule(['ref.test', '(', 'ref', heaptype, ')'],			$ => ({ op: 'ref.test', typeIndex: $[3] } as Instr)),
	Rule(['ref.cast', '(', 'ref', 'null', heaptype, ')'],	$ => ({ op: 'ref.cast', typeIndex: $[4], nullable: true } as Instr)),
	Rule(['ref.cast', '(', 'ref', heaptype, ')'],			$ => ({ op: 'ref.cast', typeIndex: $[3] } as Instr)),

	// 0xFD-prefixed (SIMD)
	Rule([OneOf(Object.values(SIMD_OPS.NONE))], 			$ => ({ op: $[0] } as Instr)),
	Rule([OneOf(Object.values(SIMD_OPS.MEM)), Maybe(memarg_offset), Maybe(memarg_align)], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0 })),
	Rule([OneOf(Object.values(SIMD_OPS.LANE)), nat],		$ => ({ op: $[0], lane: $[1] })),
	Rule([OneOf(Object.values(SIMD_OPS.LANEMEM)), Maybe(memarg_offset), Maybe(memarg_align), nat], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0, lane: $[3] })),

	// 0xFE-prefixed (threads)
	Rule([OneOf(Object.values(THREAD_OPS.MEM)), Maybe(memarg_offset), Maybe(memarg_align)], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0 } as Instr)),
	Rule(['atomic.fence'], _ => ({ op: 'atomic.fence' })),
);

const local = Rules<WatLocal>(
	Rule(['(', 'local', valtype, ')'],			$ => ({ id: undefined, count: 1, type: $[2] })),
	Rule(['(', 'local', id, valtype, ')'],		$ => ({ id: $[2], count: 1, type: $[3] })),
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
	Rule(['(', id, MaybeList(self), ')'], ($, ctx) => ctx.expandCall($[1], $[2])),

	Rule(['let', id, valtype], $ => [{ op: '__local', id: $[1], count: 1, type: $[2]}, { op: 'local.set', localIndex: $[1]}]),

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
	Rule(['(', 'param', valtype, ')'],			$ => ({ kind: 'param', type: $[2] })),
	Rule(['(', 'param', id, valtype, ')'],		$ => ({ kind: 'param', id: $[2], type: $[3] })),
	Rule(['(', 'result', valtype, ')'],			$ => ({ kind: 'result', type: $[2] })),
);

function collectFuncItems(items: FuncBodyItem[]) {
	const exp: 		string[] = [];
	let imp:		Imp | undefined;
	let typeIndex:	index | undefined;
	const params:	{ id?: string; type: ValType }[] = [];
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
	Rule(['(', 'table', maybe_id, inline_export, tabletype, ')'],	$ => ({ type: 'table', id: $[2], export: [$[3]], value: $[4] })),
	Rule(['(', 'table', maybe_id, inline_import, tabletype, ')'],	$ => ({ type: 'table', id: $[2], import: $[3], value: $[4] })),
	Rule(['(', 'table', maybe_id, tabletype, ')'], 					$ => ({ type: 'table', id: $[2], value: $[3] })),
);

const memory_field = Rules<Memory>(
	Rule(['(', 'memory', maybe_id, inline_export, limits, ')'],		$ => ({ type: 'memory', id: $[2], export: [$[3]], value: $[4] })),
	Rule(['(', 'memory', maybe_id, inline_import, limits, ')'],		$ => ({ type: 'memory', id: $[2], import: $[3], value: $[4] })),
	Rule(['(', 'memory', maybe_id, limits, ')'], 					$ => ({ type: 'memory', id: $[2], value: $[3] })),
);

// Global init exprs and elem/data offset exprs are wasm "constant expressions": no locals, and no
// switch left unresolved, are ever valid there -- there's no enclosing function for a local to
// belong to, and no enclosing macro call for a switch keyed on a macro parameter to resolve against
// (see the `switch` rule's own comment). Requiring both to already be gone lets these fields hold a
// real `Instr[]` -- unlike a func body (see `Func.body`), which still has to defer an unresolved
// switch all the way to `toWasm` (a switch there might yet resolve via an enclosing macro call).
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
	Rule(['(', 'global', maybe_id, inline_export, globaltype, instrs, ')'], $	=> ({ type: 'global', id: $[2], export: [$[3]], value: $[4], init: assertResolved($[5], 'global') })),
	Rule(['(', 'global', maybe_id, inline_import, globaltype, ')'],			$	=> ({ type: 'global', id: $[2], import: $[3], value: $[4], init: [] })),
	Rule(['(', 'global', maybe_id, globaltype, instrs, ')'],				$	=> ({ type: 'global', id: $[2], value: $[3], init: assertResolved($[4], 'global') })),
);

const export_field = Rules<Export>(
	Rule(['(', 'export', str, '(', OneOf(['func', 'table', 'memory', 'global']), idx, ')', ')'], $ => ({ type: 'export', name: $[2], kind: $[4], index: $[5] })),
);

const import_desc = Rules<Func | Table | Memory | Global>(
	Rule(['(', 'func',   maybe_id, func_header, ')'],				$ => ({ type: 'func',	id: $[2], value: $[3].typeuse, locals: [], body: [] })),
	Rule(['(', 'table',  maybe_id, tabletype,  ')'],				$ => ({ type: 'table',	id: $[2], value: $[3] })),
	Rule(['(', 'memory', maybe_id, limits,     ')'],				$ => ({ type: 'memory', id: $[2], value: $[3] })),
	Rule(['(', 'global', maybe_id, globaltype, ')'],				$ => ({ type: 'global', id: $[2], value: $[3], init: [] })),
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
	Rule(['(', 'elem', maybe_id, '(', 'table', idx, ')', offset_expr, reftype, MaybeList(idx), ')'],	$ => ({ type: 'elem', id: $[2], table: $[5], offset: $[7], init: $[9] })),
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

const module_field = Rules<ModuleField | undefined>(
	Rule(['(', 'type', maybe_id, functype, ')'],		$ => ({ type: 'type', id: $[2], functype: $[3] })),
	func_field,
	table_field,
	memory_field,
	global_field,
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

export const parser = makeParser({
	skip: SKIP,
	start: Rules<Module>(
		Rule(['(', 'module', maybe_id, MaybeList(module_field), ')'],	($, ctx) => ({ id: $[2], fields: definedFields($[3], ctx) })),
		Rule([MaybeList(module_field)],									($, ctx) => ({ fields: definedFields($[0], ctx) })),
	)
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

const asmBodyParser = makeParser({
	skip: SKIP,
	start: Rules<ParsedAsmBody>(
		Rule([MaybeList(instr)], $ => collectAsmItems($[0])),
	)
});

export function parseAsmBody(src: string, defines?: Record<string, string|number>) {
	return asmBodyParser.parse(src, new ParseCtx(defines));
}

//-----------------------------------------------------------------------------
//	toWasm
//-----------------------------------------------------------------------------

export function toWasm(mod: Module): WasmModule {
	const rawExports: { name: string; kind: 'func' | 'table' | 'memory' | 'global'; index: any }[] = [];
	const imports: WasmImport[] = [];

	class IDTable {
		ids:	Record<string, number> = {};
		num	= 0;
		add(id: string|undefined, count = 1) {
			if (id !== undefined)
				this.ids[id] = this.num;
			this.num += count;
		}
		res(v: any, d?: number) {
			if (v === undefined && d !== undefined)
				return d;
			if (typeof v === 'number')
				return v;
			if (v && this.ids[v] !== undefined)
				return this.ids[v];
			throw new Error(`no such id: ${v}`);
		}
	}
	class Container<T extends Func|Table|Memory|Global> extends IDTable {
		entries:	T[] = [];
		addExp(item: T) {
			item.export?.forEach(e => rawExports.push({ name: e, kind: item.type, index: this.num }));
		}
		addImp(imp: Import, desc: any) {
			const item = imp.desc as T;
			imports.push({ module: imp.module, name: imp.name, desc });
			this.addExp(item);
			this.add(item.id);
		}
		addEntry(item: T) {
			this.entries.push(item);
			this.addExp(item);
			this.add(item.id);
		}
	}

	const types		= new IDTable;
	const elems		= new IDTable;
	const datas		= new IDTable;
	const funcs		= new Container<Func>;
	const tables	= new Container<Table>;
	const memories	= new Container<Memory>;
	const globals	= new Container<Global>;
	const typesList: SubType[] = [];

	const allTables = {
		func:	funcs,
		table:	tables,
		memory:	memories,
		global:	globals,
	};

	function getFuncTypeIdx(tu: TypeUse): number {
		if (tu.typeIndex !== undefined)
			return types.res(tu.typeIndex);
		const sig = {kind: 'func', params: tu.params, results: tu.results, id: ''} as const;
		let idx = typesList.findIndex(t => 'kind' in t && t.kind === 'func' && equalFuncSig(t, sig));
		if (idx < 0) {
			idx = typesList.length;
			typesList.push(sig);
		}
		return idx;
	}

	function resolveField(i: any, name: string, table: {res: (v: any) => number}) {
		if (name in i)
			i[name]	= table.res(i[name]);
	}

	// A `$T`-typed local only ever originates from a switch arm (see `WatLocal`'s own comment) -- one
	// still carrying it here means whatever `switch` produced it was never resolved against a concrete
	// type (only `instantiateAsmBody`, an inline-asm-only pass, ever does that), a real authoring error
	// rather than something to silently pass through to the binary encoder.
	function concreteLocalType(l: WatLocal): ValType {
		if (typeof l.type === 'object' && 'typeParam' in l.type)
			throw new Error(`local '${l.id ?? '(anonymous)'}': uninstantiated '$${l.type.typeParam}' type -- a switch arm's own $T-typed local only resolves via instantiateAsmBody (inline asm), never in a real module`);
		return l.type;
	}

	function resolveInstr(i: Instr, locals: IDTable, stk: (string | undefined)[]): Instr {
		const op		= i.op;
		const labels	= { res: (v: any) => {
			if (typeof v === 'number')
				return v;
			const i = stk.lastIndexOf(v);
			return i >= 0 ? stk.length - 1 - i : (v ? parseInt(String(v).replace(/^\$/, '')) || 0 : 0);
		}};
		switch (op) {
			case 'block': case 'loop': case 'if': {
				const nStk = [...stk, i.label];
				const blockType = typeof i.blockType === 'object' && 'typeIndex' in i.blockType ? { typeIndex: types.res(i.blockType.typeIndex) } : i.blockType;
				return op === 'if'
					? {...i, blockType, then: resolveInstrs(i.then as WatInstr[], locals, nStk), else: i.else && resolveInstrs(i.else as WatInstr[], locals, nStk)}
					: {...i, blockType, body: resolveInstrs(i.body as WatInstr[], locals, nStk)};
			}
			case 'br_table':		return {...i, labels: i.labels.map(l => labels.res(l)), default: labels.res(i.default) };
//			case 'call_indirect':	return {...i, typeIndex: types.res(i.typeIndex), tableIndex: tables.res(i.tableIndex) } as Instr;
			case 'br_on_cast':
			case 'br_on_cast_fail':	return {...i, label: labels.res(i.label), from: types.res(i.from), to: types.res(i.to) };
			case 'memory.init':		return {...i, seg: datas.res(i.seg), target: memories.res(i.target)};
			case 'memory.copy':
			case 'memory.fill':		return {...i, seg: memories.res(i.seg), target: memories.res(i.target)};
			case 'table.init':		return {...i, seg: elems.res(i.seg), target: tables.res(i.target)};
			case 'table.copy':		return {...i, seg: tables.res(i.seg), target: tables.res(i.target)};

			default: {
				const resI = { ...i };
				resolveField(resI, 'localIndex',	locals);
				resolveField(resI, 'globalIndex',	globals);
				resolveField(resI, 'tableIndex',	tables);
				resolveField(resI, 'funcIndex', 	funcs);
				resolveField(resI, 'label',			labels);
				resolveField(resI, 'typeIndex',		types);
				resolveField(resI, 'dst',			types);
				resolveField(resI, 'src',			types);
				resolveField(resI, 'elemIndex',		elems);
				resolveField(resI, 'dataIndex',		datas);
				return resI;
			}
		}
	}

	function resolveInstrs(instrs: WatInstr[], locals = new IDTable, stk: (string | undefined)[] = []): Instr[] {
		const result: Instr[] = [];
		instrs.forEach(i => {
			if (i.op ===  '__switch')
				// Reached only if `switch '${i.key}'` was never resolved: not a known ctx.defines entry
				// at parse time, and not (or not correctly) bound via a macro call's substInstr pass.
				throw new Error(`switch '${i.key}': unresolved -- not a ctx.defines entry, and not inside a macro call binding it to a $tag argument`);
			if (i.op ===  '__local')
				locals.add(i.id, i.count);
			else
				result.push(resolveInstr(i, locals, stk));
		});
		return result;
	}

	for (const f of mod.fields) {
		if (f.type === 'type') {
			const idx = typesList.length;
			typesList.push({ kind: 'func', params: f.functype.params, results: f.functype.results, id: f.id });
			if (f.id)
				types.ids[f.id] = idx;
		}
	}

	for (const f of mod.fields) {
		switch (f.type) {
			case 'import': {
				switch (f.desc.type) {
					case 'func':	funcs.addImp(f,		{ kind: 'func',		typeIndex: getFuncTypeIdx(f.desc.value) }); break;
					case 'table':	tables.addImp(f, 	{ kind: 'table',	type: f.desc.value }); break;
					case 'memory':	memories.addImp(f,	{ kind: 'memory',	type: f.desc.value }); break;
					case 'global':	globals.addImp(f,	{ kind: 'global',	type: f.desc.value }); break;
				}
				break;
			}
			case 'func':	funcs.addEntry(f); break;
			case 'table':	tables.addEntry(f); break;
			case 'memory':	memories.addEntry(f); break;
			case 'global':	globals.addEntry(f); break;

			case 'export':	rawExports.push({ name: f.name, kind: f.kind, index: f.index }); break;
			case 'elem':	elems.add(f.id); break;
			case 'data':	datas.add(f.id); break;
		}
	}

	const wmod	= new WasmModule();
	wmod.functionTypes	= funcs.entries.map(f => getFuncTypeIdx(f.value));
	wmod.tables			= tables.entries.map(t => t.value);
	wmod.memories		= memories.entries.map(m => m.value);
	wmod.globals		= globals.entries.map(g => ({ type: g.value, init: resolveInstrs(g.init), id: g.id }));
	wmod.imports		= imports;
	wmod.code			= funcs.entries.map(f => {
		const locals = new IDTable;
		f.value.params.forEach(p => locals.add(p.id));
		f.locals.forEach(l => locals.add(l.id, l.count));
		return { locals: f.locals.map(l => ({ count: l.count, type: concreteLocalType(l), id: l.id })), body: resolveInstrs(f.body, locals), id: f.id };
	});

	wmod.exports = rawExports.map(e => ({ name: e.name, kind: e.kind, index: allTables[e.kind].res(e.index) }));

	for (const f of mod.fields) {
		switch (f.type) {
			case 'start':
				wmod.start = funcs.res(f.func);
				break;
			case 'elem': {
				const funcIndices = f.init.map(x => funcs.res(x));
				(wmod.elements ??= []).push(f.offset
					? { mode: 'active', table: tables.res(f.table, 0), offset: resolveInstrs(f.offset), reftype: { ref: 'func', nullable: true }, funcIndices }
					: { mode: 'passive', reftype: { ref: 'func', nullable: true }, funcIndices }
				);
				break;
			}
			case 'data': {
				const bytes = f.init;
				const memory = memories.res(f.memory, 0);
				(wmod.datas ??= []).push(f.offset
					? { mode: 'active', ...(memory ? { memory } : {}), offset: resolveInstrs(f.offset), bytes }
					: { mode: 'passive', bytes }
				);
				break;
			}
		}
	}

	if (typesList.length > 0)
		wmod.types = { types: typesList, groupSizes: typesList.map(() => 1) };

	return wmod;
}
