import { makeParser, Rules, Rule, List, MaybeList, Maybe, OneOf, Forward } from '../src/tison';
import { Instr, ValType, Local, GlobalType, TableType, SubType, WasmModule, Import as WasmImport } from '@isopodlabs/binary_libs/wasm';
import { ROOT_OPS, FB_OPS, FC_OPS, SIMD_OPS, THREAD_OPS, equalFuncSig } from '@isopodlabs/binary_libs/wasm';

// ===================================================================
//  WAT (WebAssembly Text Format) Parser
// ===================================================================

// --- Terminals ---

const ID		= /\$[a-zA-Z0-9!#$%&'*+\-./:<=>?@\\^_`|~]*/;
const NAT		= /[0-9]+|0x[0-9a-fA-F]+/;
const INT		= /[+-]?(?:[0-9]+|0x[0-9a-fA-F]+)/;
const FLOAT		= /[+-]?(?:inf|nan(?::0x[0-9a-fA-F]+)?|[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|0x[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?[0-9]+)?)/;
const STRING	= /"(?:[^"\\]|\\.)*"/;

// ===================================================================
//  WAT-only types (not in wasm.ts binary layer)
// ===================================================================

export type { Instr, ValType, GlobalType, TableType };

// wasm.ts Limits is inlined into MemType/TableType; expose a plain shape for WAT
interface Limits	{ min: number; max?: number }
interface MemType	{ min: number; max?: number }
interface FuncType	{ params: {id?: string; type: ValType}[]; results: ValType[] }
interface TypeUse	{ typeIndex?: string | number; params: {id?: string; type: ValType}[]; results: ValType[] };
interface Imp		{ module: string, name: string };

interface Field<T extends string, V> {
	type:		T;
	id?:		string;
	export?:	string[];
	import?:	Imp;
	value:		V;
}
type Func	= Field<'func', TypeUse> & { locals: Local[]; body: Instr[] }
type Table	= Field<'table', TableType>
type Memory	= Field<'memory', MemType>
type Global	= Field<'global', GlobalType> & { init: Instr[] }

interface Export	{ type: 'export'; name: string; kind: 'func' | 'table' | 'memory' | 'global'; index: string | number }
interface Import	{ type: 'import'; module: string; name: string; desc: Func | Table | Memory | Global }
interface TypeDef	{ type: 'type'; id?: string; functype: FuncType }
interface Elem		{ type: 'elem'; id?: string; table?: string | number; offset?: Instr[]; init: (string | number)[] }
interface Data		{ type: 'data'; id?: string; memory?: string | number; offset?: Instr[]; init: string }
interface Start		{ type: 'start'; func: string | number }

type ModuleField = TypeDef | Func | Table | Memory | Global | Export | Import | Elem | Data | Start;
interface Module		{ id?: string; fields: ModuleField[] }

// ===================================================================
//  Grammar
// ===================================================================

const id  		= Rules(Rule([ID],  	$ => $[0] as string));
const nat 		= Rules(Rule([NAT], 	$ => parseInt($[0], $[0].startsWith('0x') ? 16 : 10)));
const str 		= Rules(Rule([STRING], 	$ => JSON.parse($[0]) as string));

const maybe_id	= Maybe(id);
const idx		= Rules<string | number>(id, nat);

const valtype	= OneOf(['i32', 'i64', 'f32', 'f64', 'v128', 'funcref', 'externref']) as Rules<ValType>;
const reftype	= OneOf(['funcref', 'externref']) as Rules<ValType>;

const heaptype = Rules(
	Rule([OneOf(['func', 'extern', 'any', 'eq', 'i31', 'struct', 'array', 'none', 'noextern', 'nofunc', 'exn', 'noexn'])], $ => $[0]),
	Rule([idx], $ => $[0]),
);

const param = Rules<{id?: string; type: ValType}>(
	Rule(['(', 'param', valtype, ')'],		$ => ({ type: $[2] } as const)),
	Rule(['(', 'param', id, valtype, ')'],	$ => ({ id: $[2], type: $[3] } as const)),
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

const memarg_offset	= Rules<number>(Rule([/offset=[0-9]+/], $ => parseInt(($[0] as string).split('=')[1])));
const memarg_align	= Rules<number>(Rule([/align=[0-9]+/],  $ => parseInt(($[0] as string).split('=')[1])));

const fwd_instr	= Forward<Instr>(() => instr);
const instrs	= MaybeList(fwd_instr);

// blocktype -> wasm BlockType: undefined | ValType | {typeIndex}
// WAT only supports the valtype form inline; typeIndex form uses typeuse
const blocktype = Maybe(Rules<ValType>(
	Rule(['(', 'result', valtype, ')'], $ => $[2]),
));

const instr = Rules<Instr>(
	// Block structures: imm=BlockType, body=Instr[], body2=Instr[] (else branch)
	Rule(['block', maybe_id, blocktype, instrs, 'end', maybe_id],							$ => ({ op: 'block', blockType: $[2], body: $[3], label: checkLabel($[1], $[5]) })),
	Rule(['loop', maybe_id, blocktype, instrs, 'end', maybe_id],							$ => ({ op: 'loop', blockType: $[2], body: $[3], label: checkLabel($[1], $[5]) })),
	Rule(['if', maybe_id, blocktype, instrs, 'end', maybe_id],								$ => ({ op: 'if', blockType: $[2], then: $[3], label: checkLabel($[1], $[5]) })),
	Rule(['if', maybe_id, blocktype, instrs, 'else', maybe_id, instrs, 'end', maybe_id],	$ => ({ op: 'if', blockType: $[2], then: $[3], else: $[6], label: checkLabel($[1], $[8]) })),

	Rule(['br_table', List(idx)],		$ => ({ op: 'br_table', labels: ($[1] as (string|number)[]).slice(0, -1), default: ($[1] as (string|number)[]).at(-1)! })),
	Rule(['call_indirect', typeuse],	$ => ({ op: 'call_indirect', typeIndex: $[1].typeIndex ?? 0, tableIndex: 0 })),

	Rule(['memory.size'],				_ => ({ op: 'memory.size', imm: 0 })),
	Rule(['memory.grow'],				_ => ({ op: 'memory.grow', imm: 0 })),
	Rule(['select', MaybeList(result)], $ => ($[1].length ? { op: 'select.t', imm: $[1] } : { op: 'select' })),

	// Numeric constants: imm field
	Rule(['i32.const', INT],			$ => ({ op: 'i32.const', imm: parseIntImm($[1]) })),
	Rule(['i64.const', INT],			$ => ({ op: 'i64.const', imm: BigInt(parseIntImm($[1])) })),
	Rule(['f32.const', FLOAT],			$ => ({ op: 'f32.const', imm: parseFloat($[1]) })),
	Rule(['f64.const', FLOAT],			$ => ({ op: 'f64.const', imm: parseFloat($[1]) })),

	Rule([OneOf(Object.values(ROOT_OPS.NONE))],				$ => ({ op: $[0] } as Instr)),
	Rule([OneOf(Object.values(ROOT_OPS.INDEX)), idx],		$ => ({ op: $[0], index: $[1] })),
	Rule([OneOf(Object.values(ROOT_OPS.MEM)), Maybe(memarg_offset), Maybe(memarg_align)], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0 })),

	// 0xFC-prefixed
	Rule([OneOf(Object.values(FC_OPS.NONE))],				$ => ({ op: $[0] })),
	Rule([OneOf(Object.values(FC_OPS.INDEX)), idx],			$ => ({ op: $[0], index: $[1] })),
	Rule([OneOf(Object.values(FC_OPS.INDEX2)), idx, idx],	$ => ({ op: $[0], seg: $[1], target: $[2] })),

	// 0xFB-prefixed (GC)
	Rule([OneOf(Object.values(FB_OPS.NONE))],				$ => ({ op: $[0] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE)), idx],			$ => ({ op: $[0], typeIndex: $[1] })),
	Rule([OneOf(Object.values(FB_OPS.ARRAY_NOTYPE)), idx],	$ => ({ op: $[0], typeIndex: $[1] })),
	Rule([OneOf(Object.values(FB_OPS.ONETYPE_NOIDX)), idx],	$ => ({ op: $[0], typeIndex: $[1] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE_FIELD)), idx, nat],$ =>({ op: $[0], typeIndex: $[1], field: $[2] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE_N)), idx, nat], 	$ => ({ op: $[0], typeIndex: $[1], n: $[2] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE_SEG)), idx, idx], $ => ({ op: $[0], typeIndex: $[1], segIndex: $[2] })),
	Rule([OneOf(Object.values(FB_OPS.TYPE2)), idx, idx],	$ => ({ op: $[0], dst: $[1], src: $[2] })),
	Rule(['ref.test', '(', 'ref', 'null', heaptype, ')'],	$ => ({ op: 'ref.test.nullable', typeIndex: $[4] } as Instr)),
	Rule(['ref.test', '(', 'ref', heaptype, ')'],			$ => ({ op: 'ref.test',          typeIndex: $[3] } as Instr)),
	Rule(['ref.cast', '(', 'ref', 'null', heaptype, ')'],	$ => ({ op: 'ref.cast.nullable', typeIndex: $[4] } as Instr)),
	Rule(['ref.cast', '(', 'ref', heaptype, ')'],			$ => ({ op: 'ref.cast',          typeIndex: $[3] } as Instr)),

	// 0xFD-prefixed (SIMD)
	Rule([OneOf(Object.values(SIMD_OPS.NONE))], 			$ => ({ op: $[0] } as Instr)),
	Rule([OneOf(Object.values(SIMD_OPS.MEM)), Maybe(memarg_offset), Maybe(memarg_align)], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0 })),
	Rule([OneOf(Object.values(SIMD_OPS.LANE)), nat],		$ => ({ op: $[0], lane: $[1] })),
	Rule([OneOf(Object.values(SIMD_OPS.LANEMEM)), Maybe(memarg_offset), Maybe(memarg_align), nat], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0, lane: $[3] })),

	// 0xFE-prefixed (threads)
	Rule([OneOf(Object.values(THREAD_OPS.MEM)), Maybe(memarg_offset), Maybe(memarg_align)], $ => ({ op: $[0], offset: $[1] ?? 0, align: $[2] ?? 0 } as Instr)),
	Rule(['atomic.fence'], _ => ({ op: 'atomic.fence' })),

	// Folded (s-expression) form
	Rule(['(', fwd_instr, ')'], $ => $[1]),
);


// --- Module fields ---

const inline_export = Rules(Rule(['(', 'export', str, ')'],			$ => $[2]));
const inline_import = Rules(Rule(['(', 'import', str, str, ')'],	$ => ({module: $[2], name: $[3]} as const)));

type FuncHeaderItem =
	| { kind: 'export'; name: string }
	| { kind: 'import'; module: string; name: string }
	| { kind: 'type'; typeIdx: string | number }
	| { kind: 'param'; id?: string; type: ValType }
	| { kind: 'result'; type: ValType }
	| { kind: 'local'; id?: string; count: number; type: ValType };

const func_header_item = Rules<FuncHeaderItem>(
	Rule([inline_export],						$ => ({ kind: 'export', name: $[0] })),
	Rule([inline_import],						$ => ({ kind: 'import', ...$[0] })),
	Rule(['(', 'type', idx, ')'],				$ => ({ kind: 'type', typeIdx: $[2] })),
	Rule(['(', 'param', valtype, ')'],			$ => ({ kind: 'param', type: $[2] })),
	Rule(['(', 'param', id, valtype, ')'],		$ => ({ kind: 'param', id: $[2], type: $[3] })),
	Rule(['(', 'result', valtype, ')'],			$ => ({ kind: 'result', type: $[2] })),
	Rule(['(', 'local', valtype, ')'],			$ => ({ kind: 'local', count: 1, type: $[2] })),
	Rule(['(', 'local', id, valtype, ')'],		$ => ({ kind: 'local', id: $[2], count: 1, type: $[3] })),
);

const func_header = Rules(
	Rule([MaybeList(func_header_item)], $ => {
		const exports: string[] = [];
		let imp: Imp | undefined;
		let typeIndex: string | number | undefined;
		const params: { id?: string; type: ValType }[] = [];
		const results: ValType[] = [];
		const locals: Local[] = [];

		for (const item of $[0]) {
			switch (item.kind) {
				case 'export':	exports.push(item.name); break;
				case 'import':	imp = {module: item.module, name: item.name}; break;
				case 'type':	typeIndex = item.typeIdx; break;
				case 'param':	params.push({ id: item.id, type: item.type }); break;
				case 'result':	results.push(item.type); break;
				case 'local':	locals.push({ id: item.id, count: item.count, type: item.type } as any); break;
			}
		}
		return {
			export:		exports.length ? exports : undefined,
			import:		imp,
			typeuse:	{ typeIndex, params, results },
			locals,
		};
	})
);

const func_field = Rules<Func>(
	Rule(['(', 'func', maybe_id, func_header, instrs, ')'], $ => {
		const h = $[3];
		return { type: 'func', id: $[2], export: h.export, import: h.import, value: h.typeuse, locals: h.locals, body: $[4] };
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

const global_field = Rules<Global>(
	Rule(['(', 'global', maybe_id, inline_export, globaltype, instrs, ')'], $ => ({ type: 'global', id: $[2], export: [$[3]], value: $[4], init: $[5] })),
	Rule(['(', 'global', maybe_id, inline_import, globaltype, ')'],	$ => ({ type: 'global', id: $[2], import: $[3], value: $[4], init: [] })),
	Rule(['(', 'global', maybe_id, globaltype, instrs, ')'],		$ => ({ type: 'global', id: $[2], value: $[3], init: $[4] })),
);

const export_field = Rules<Export>(
	Rule(['(', 'export', str, '(', OneOf(['func', 'table', 'memory', 'global']), ')'], $ => ({ type: 'export', name: $[2], kind: $[4], index: $[5] })),
);

const import_desc = Rules<Func | Table | Memory | Global>(
	Rule(['(', 'func',   maybe_id, func_header, ')'],				$ => ({ type: 'func',	id: $[2], value: $[3].typeuse, locals: [], body: [] })),
	Rule(['(', 'table',  maybe_id, tabletype,  ')'],				$ => ({ type: 'table',	id: $[2], value: $[3] })),
	Rule(['(', 'memory', maybe_id, limits,     ')'],				$ => ({ type: 'memory', id: $[2], value: $[3] })),
	Rule(['(', 'global', maybe_id, globaltype, ')'],				$ => ({ type: 'global', id: $[2], value: $[3], init: [] })),
);

const offset_expr = Rules<Instr[]>(
	Rule(['(', 'offset', instrs, ')'], $ => $[2]),
	Rule([fwd_instr], $ => [$[0]]),
);

const elem_field = Rules<Elem>(
	Rule(['(', 'elem', maybe_id, '(', 'table', idx, ')', offset_expr, reftype, MaybeList(idx), ')'],	$ => ({ type: 'elem', id: $[2], table: $[5], offset: $[7], init: $[9] } as Elem)),
	Rule(['(', 'elem', maybe_id, offset_expr, MaybeList(idx), ')'],										$ => ({ type: 'elem', id: $[2], offset: $[3], init: $[4] } as Elem)),
	Rule(['(', 'elem', maybe_id, MaybeList(idx), ')'],													$ => ({ type: 'elem', id: $[2], init: $[3] } as Elem)),
);

const data_field = Rules<Data>(
	Rule(['(', 'data', maybe_id, '(', 'memory', idx, ')', offset_expr, MaybeList(str), ')'],			$ => ({ type: 'data', id: $[2], memory: $[5], offset: $[7], init: ($[8] as string[]).join('') })),
	Rule(['(', 'data', maybe_id, offset_expr, MaybeList(str), ')'],										$ => ({ type: 'data', id: $[2], offset: $[3], init: ($[4] as string[]).join('') })),
	Rule(['(', 'data', maybe_id, MaybeList(str), ')'],													$ => ({ type: 'data', id: $[2], init: ($[3] as string[]).join('') })),
);

const module_field = Rules<ModuleField>(
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
);

const module = Rules<Module>(
	Rule(['(', 'module', maybe_id, MaybeList(module_field), ')'],	$ => ({ id: $[2], fields: $[3] })),
	Rule([MaybeList(module_field)],									$ => ({ fields: $[0] })),
);

export const watParser = makeParser({
	skip: [/\s+/, /;;[^\n]*/, /\(;[^]*?;\)/],
	start: module,
	rules: { watModule: module },
});

export function parse(wat: string): WasmModule {
	const mod	= watParser.parse(wat);
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
		res(v: any, d = 0) {
			return typeof v === 'number' ? v : (v && this.ids[v] !== undefined ? this.ids[v] : (v ? parseInt(String(v).replace(/^\$/, '')) || d : d));
		}
	}
	class Table2<T extends Func|Table|Memory|Global> extends IDTable {
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
	const funcs		= new Table2<Func>;
	const tables	= new Table2<Table>;
	const memories	= new Table2<Memory>;
	const globals	= new Table2<Global>;
	const typesList: SubType[] = [];

	const allTables = {
		func:	funcs,
		table:	tables,
		memory:	memories,
		global:	globals,
	} as const;

	const resLabel = (v: any, stk: (string | undefined)[]) => {
		if (typeof v === 'number')
			return v;
		const i = stk.lastIndexOf(v);
		return i >= 0 ? stk.length - 1 - i : (v ? parseInt(String(v).replace(/^\$/, '')) || 0 : 0);
	};

	function getTypeIdx(tu: TypeUse): number {
		if (tu.typeIndex !== undefined)
			return types.res(tu.typeIndex);
		const sig = {kind: 'func', params: tu.params.map(p => p.type), results: tu.results} as const;
		let idx = typesList.findIndex(t => 'kind' in t && t.kind === 'func' && equalFuncSig(t, sig));
		if (idx < 0) {
			idx = typesList.length;
			typesList.push(sig);
		}
		return idx;
	}

	function resolveInstr(i: Instr, locals: IDTable, stk: (string | undefined)[]): Instr {
		const op = i.op;
		switch (op) {
			case 'block': case 'loop': case 'if': {
				const nStk = [...stk, (i as any).label];
				const blockType = typeof i.blockType === 'object' && 'typeIndex' in i.blockType ? { typeIndex: types.res(i.blockType.typeIndex) } : i.blockType;
				return op === 'if'
					? {...i, blockType, then: resolveInstrs(i.then as Instr[], locals, nStk), else: resolveInstrs(i.else as Instr[], locals, nStk)}
					: {...i, blockType, body: resolveInstrs(i.body as Instr[], locals, nStk)};
			}
			case 'br_table':		return {...i, labels: i.labels.map(l => resLabel(l, stk)), default: resLabel(i.default, stk) } as Instr;
			case 'call_indirect':	return {...i, typeIndex: types.res(i.typeIndex), tableIndex: tables.res(i.tableIndex) } as Instr;
			case 'br_on_cast':
			case 'br_on_cast_fail':	return {...i, label: resLabel(i.label, stk), from: types.res(i.from), to: types.res(i.to) };
			case 'memory.init':		return {...i, seg: datas.res(i.seg), target: memories.res(i.target)};
			case 'memory.copy':
			case 'memory.fill':		return {...i, seg: memories.res(i.seg), target: memories.res(i.target)};
			case 'table.init':		return {...i, seg: elems.res(i.seg), target: tables.res(i.target)};
			case 'table.copy':		return {...i, seg: tables.res(i.seg), target: tables.res(i.target)};
			case 'data.drop':		return {...i, index: datas.res(i.index)};
			case 'elem.drop':		return {...i, index: elems.res(i.index)};

			default: {
				const resI = { ...i };
				if ('index' in resI) {
					resI.index = /^(local\.|param)/.test(op)		? locals.res(resI.index)
						: /^global\./.test(op)						? globals.res(resI.index)
						: /^(call|return_call|ref\.func)$/.test(op)	? funcs.res(resI.index)
						: /^br/.test(op)							? resLabel(resI.index, stk)
						: tables.res(resI.index);
				}
				if ('typeIndex' in resI)
					resI.typeIndex = types.res(resI.typeIndex);
				if ('dst' in resI)
					resI.dst = types.res(resI.dst);
				if ('src' in resI)
					resI.src = types.res(resI.src);
				if ('segIndex' in resI)
					resI.segIndex = (op.includes('data') ? datas : elems).res(resI.segIndex);

				return resI;
			}
		}
	}

	function resolveInstrs(instrs: Instr[], locals = new IDTable, stk: (string | undefined)[] = []) {
		return instrs.map(i => resolveInstr(i, locals, stk));
	}

	for (const f of mod.fields) {
		if (f.type === 'type') {
			const idx = typesList.length;
			typesList.push({ kind: 'func', params: f.functype.params.map(p => p.type), results: f.functype.results });
			if (f.id)
				types.ids[f.id] = idx;
		}
	}

	for (const f of mod.fields) {
		switch (f.type) {
			case 'import': {
				switch (f.desc.type) {
					case 'func':	funcs.addImp(f,		{ kind: 'func',		typeIndex: getTypeIdx(f.desc.value) }); break;
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
	wmod.functionTypes	= funcs.entries.map(f => getTypeIdx(f.value));
	wmod.tables			= tables.entries.map(t => t.value);
	wmod.memories		= memories.entries.map(m => m.value);
	wmod.globals		= globals.entries.map(g => ({ type: g.value, init: resolveInstrs(g.init) }));
	wmod.imports		= imports;
	wmod.code			= funcs.entries.map(f => {
		const locals = new IDTable;
		f.value.params.forEach(p => locals.add(p.id));
		f.locals.forEach(l => locals.add((l as any).id, l.count));
		return { locals: f.locals.map(l => ({ count: l.count, type: l.type })), body: resolveInstrs(f.body, locals) };
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
					? { mode: 'active', table: tables.res(f.table), offset: resolveInstrs(f.offset), reftype: { ref: 'func', nullable: true }, funcIndices }
					: { mode: 'passive', reftype: { ref: 'func', nullable: true }, funcIndices }
				);
				break;
			}
			case 'data': {
				const bytes = new TextEncoder().encode(f.init);
				const memory = memories.res(f.memory);
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
