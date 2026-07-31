import * as TS from './ts-parser';
import * as JS from './js-parser';
import * as T from './type-utils';
import { Literal } from '../common';
import { makeChecker } from './checker';
import * as wasm from '@isopodlabs/binary_libs/wasm';

// Non-callback String/Array/Uint8Array methods -- see towasm-prelude.ts.
import { LIB_AST } from './towasm-lib';

// ===================================================================
//  TStoWasm -- TS-AST-to-wasm backend for a narrow static subset
// ===================================================================
//
// Scope:
//  - top-level `function`s: explicit number/boolean/class/array params & return type, no generics/
//    rest/default/destructured params
//  - top-level `class`es: number/boolean fields only, exactly one constructor, methods, no inheritance/
//    static/getters-setters/generics
//  - statements: block, var_decl, expression, if, while, return, for, for...of
//  - expressions: literal, identifier, this, member, binary, unary, conditional, call, `new`, `=`
//    assignment, array literal, index
//  - arrays: `number[]`/`boolean[]`/`string`/`Uint8Array` as four monomorphized fixed-length wasm-GC
//    array types (no generics/resizing/other methods beyond the prelude below); indexing and `for...of`
//    don't support `string` (real `str[i]` yields a 1-char string, not a code unit)
//  - non-callback Array/String methods (`indexOf`/`slice`/...) via a self-hosted prelude -- see
//    towasm-prelude.ts; `map`/`filter`/etc. need closures, out of scope
//  - not attempted at all: closures, `any`, generics, inheritance, async/generators
//
// Every unsupported construct throws rather than silently mis-emitting. Assumes `ast` already passed
// `TStypeCheck` (same contract as `TStoJS`/`TStoDecl`) -- reuses its stamped `ast.scope` for type
// *inference* only (unannotated locals, conditional result types, `obj.field`'s class); everything else
// follows deterministically from syntax. Emits a `binary-libs` `wasm.WasmModule` (structured object)
// directly, no WAT text stage.
//
// Classes: one wasm-GC `struct` per class (all fields mutable) plus one function per ctor/method with
// `this` as an explicit first param -- no inheritance means every call site's target is statically
// known, always a plain `call`. A ctor is `struct.new_default` (zero-init) into a `this` local, the
// body runs as ordinary statements, then returns `this` -- why fields must be number/boolean, not
// another class: a non-null ref field has no zero value to default-init with (object-typed *params*
// are fine). Class names are reserved eagerly (a method can reference its own class by name before
// resolution); everything else -- functions, classes, the prelude -- registers lazily on first
// reachable use via `ensureFunc`/`ensureClass`/`emitBuiltinCall` and the worklist they feed, so an
// unreached function/class gets no index, no body, and no validation.

type Expr			= JS.Expr;
type Type			= TS.Type;
type Statement		= TS.Statement;
type FunctionDecl	= Extract<TS.Statement, { type: 'function_decl' }>;
type MethodMember	= JS.Method<Type>;
type Scope			= T.Scope;
const Scope			= T.Scope;

// `'void'` is only ever legitimate as a function/method's declared *result* -- never a param, local,
// or field (`paramWasmType`/`ensureClass`'s field check/`var_decl` all reject it explicitly).
type TYPE 		= 'f64' | 'i32' | 'i16' | 'i8';
type WasmType	= 'f64' | 'i32' | 'void' | { ref: string } | { arr: TYPE } | { const: number|boolean|string };

function wasmTypeEq(a: WasmType, b: WasmType): boolean {
	if (typeof a === 'string' || typeof b === 'string')
		return a === b;
	if ('ref' in a && 'ref' in b)
		return a.ref === b.ref;
	if ('arr' in a && 'arr' in b)
		return a.arr === b.arr;
	return false;
}

interface FuncSig					{ params: WasmType[]; result: WasmType }
interface FuncInfo extends FuncSig	{ funcIndex: number; typeIndex: number, body?: wasm.FuncBody }
interface Inline extends FuncSig	{ inline: wasm.Instr[] }
type Inline2 = (args: (WasmType|undefined)[], ctx: FuncCtx)=>Inline

// Anything a `.method(...)` call can dispatch against: a real user class (`this` a wasm-GC struct ref)
// or a "builtin class" (`this` an array/string `WasmType` directly, see `arrayBoxOwners`) -- neither
// has inheritance/virtual dispatch, so a resolved method is always a plain direct `call`.
interface MethodOwner {
	name:			string;
	thisType:		WasmType;
	thisTsType:		Type;
	methodDecls:	Map<string, MethodMember>;
	methods:		Map<string, FuncInfo>;
	// Hand-built (no TS source possible, e.g. `StringBox.charAt` needs raw `array.get_u`) -- checked by
	// `emitMethodCall` before `methodDecls`, and spliced directly into the caller with no `call` at all.
	inlineMethods?:	Record<string, Inline>;
}

interface ClassInfo extends MethodOwner {
	decl:			TS.Class;
	fields:			{ name: string; wtype: WasmType }[];
	fieldIndex:		Map<string, number>;
	resolved:		boolean;
	ctorDecl?:		MethodMember;
	ctor?:			FuncInfo;
}

interface Local {
	wtype: WasmType, index: number;
}

class FuncCtx {
	locals	= new Map<string, Local>();
	out:	wasm.Instr[]	= [];

	// Set (only for a constructor body) once `this` is declared -- `emitStmt`'s `'return'` case checks
	// this first, since a ctor's `return;` means "return `this`", not "coerce `ctx.result` via `emitAs`"
	// -- and needs to apply at any nesting depth, not just to the body's own top-level statements.
	ctorThis?: Local;

	constructor(public scope: Scope, public result: WasmType) {}

	declare(name: string, wtype: WasmType): Local {
		if (this.locals.has(name))
			throw new Error(`towasm: local '${name}' redeclared (shadowing is not supported)`);
		const l: Local = { wtype, index: this.locals.size};
		this.locals.set(name, l);
		return l;
	}

	// Also registers `name` with the checker's `scope` -- needed by any later `wtypeOf`/`classOf` lookup.
	declareValue(name: string, wtype: WasmType, tsType: Type): Local {
		this.scope.addValue(name, tsType);
		return this.declare(name, wtype);
	}

	declareParams(params: JS.Param<Type>[], wtypes: WasmType[]) {
		params.forEach((p, i) => this.declareValue(p.key as string, wtypes[i], p.typeAnnotation!));
	}

	lookup(name: string): Local {
		const l = this.locals.get(name);
		if (!l)
			throw new Error(`towasm: unresolved identifier '${name}' (only locals/params are supported)`);
		return l;
	}

	swapOut(out: wasm.Instr[] = []) {
		const old	= this.out;
		this.out	= out;
		return old;
	}

	emit(...instr: wasm.Instr[]) {
		this.out.push(...instr);
	}

	toFuncBody(numParams: number, toValType: (t: WasmType) => wasm.ValType): wasm.FuncBody {
		return { locals: Array.from(this.locals.values()).slice(numParams).map(l => ({ count: 1, type: toValType(l.wtype) })), body: this.out };
	}
}


// `widenLiterals` first: a conditional's combined type (`true | boolean`) doesn't collapse to a bare
// `boolean` ref otherwise, since `combineTypes` dedupes by printed form, not subsumption.
function wasmTypeOf(t: Type, global: Scope): WasmType | undefined {
	const w = T.widenLiterals(T.resolve(global, t));
	if (w.type === 'ref') {
		switch (w.name) {
			case 'void':	return 'void';
			case 'boolean':	return 'i32';
			case 'number':	return 'f64';
			// `String` (capital): the checker has no declared `String` type to resolve `new String(...)`
			// against, so it falls back to a bare `TS.RefType('String')` (see checker.ts's `'new'` case)
			// -- same treatment as lowercase `string` is correct here, since this compiler has no
			// primitive-vs-boxed distinction and rejects string `===` entirely, so nothing could tell them apart.
			case 'string':
			case 'String':	return { arr: 'i16' };
			case 'Uint8Array':	return { arr: 'i8' };
			case 'Array':
			case 'ReadonlyArray': {
				const elemT = w.typeArgs?.[0];
				if (elemT) {
					const we = wasmTypeOf(T.resolve(global, elemT), global);
					if (we === 'i32' || we === 'f64')
						return { arr: we };
				}
				return undefined;
			}
		}
	}

	if (w.type === 'array') {
		const we = wasmTypeOf(w.element, global);
		if (we === 'i32' || we === 'f64')
			return { arr: we };
		return undefined;
	}

	return undefined;
}

// The element type an indexed read of a (non-string) array kind produces -- `checker.typeOf` only
// infers this for literal `T[]`, giving `any` for `Uint8Array`, so it's stated directly instead.
function indexElementType(kind: 'f64' | 'i32' | 'i8'): Type {
	return kind === 'i32' ? T.BOOLEAN : T.NUMBER;
}

// Same idea for a method-call result: the checker gives `any` for every `string`/`Uint8Array` method
// call (`sealed()` is always false for `ref` types), so this answers from the dispatch table instead.
function methodResultType(kind: 'f64' | 'i32' | 'i16' | 'i8', method: string): Type | undefined {
	if (method === 'indexOf' || method === 'lastIndexOf' || method === 'charCodeAt')
		return T.NUMBER;
	if (method === 'includes' || method === 'startsWith' || method === 'endsWith')
		return T.BOOLEAN;
	if (kind === 'i16')
		return ['slice', 'trim', 'toUpperCase', 'toLowerCase', 'repeat', 'concat', 'charAt'].includes(method) ? T.STRING : undefined;
	if (!['slice', 'reverse', 'concat', 'fill'].includes(method))
		return undefined;
	return kind === 'f64' ? TS.ArrayType(T.NUMBER) : kind === 'i32' ? TS.ArrayType(T.BOOLEAN) : TS.RefType('Uint8Array');
}

const ARRAY: Record<TYPE, {index: number, methods: Map<string, MethodMember>}> = {
	f64:	{index: 0, methods: new Map}, 
	i32:	{index: 1, methods: new Map}, 
	i16:	{index: 2, methods: new Map}, 
	i8:		{index: 3, methods: new Map}, 
} as const;

type Builtin = FunctionDecl | Inline2
const builtins: Record<string, Builtin> = {
	'Math.sqrt':	() => ({params: ['f64'], result: 'f64',		inline: [{op: 'f64.sqrt'}]}),
	'Math.abs':		() => ({params: ['f64'], result: 'f64',		inline: [{op: 'f64.abs'}]}),
	'Math.floor':	() => ({params: ['f64'], result: 'f64',		inline: [{op: 'f64.floor'}]}),
	'Math.ceil':	() => ({params: ['f64'], result: 'f64',		inline: [{op: 'f64.ceil'}]}),
	'Math.min':		() => ({params: ['f64', 'f64'], result: 'f64',	inline: [{op: 'f64.min'}]}),
	'Math.max':		() => ({params: ['f64', 'f64'], result: 'f64',	inline: [{op: 'f64.max'}]}),

	__towasm_arr_f64_alloc:		() => ({params: ['i32'], result: { arr: 'f64' }, inline: [{op: 'array.new_default', typeIndex: ARRAY.f64.index }]}),
	__towasm_arr_i32_alloc:		() => ({params: ['i32'], result: { arr: 'i32' }, inline: [{op: 'array.new_default', typeIndex: ARRAY.i32.index }]}),
	__towasm_arr_i8_alloc:		() => ({params: ['i32'], result: { arr: 'i8' } , inline: [{op: 'array.new_default', typeIndex: ARRAY.i8.index }]}),

	__towasm_str_alloc:			() => ({params: ['i32'], result: { arr: 'i16' }, inline: [{op: 'array.new_default', typeIndex: ARRAY.i16.index }]}),
	__towasm_str_setChar:		() => ({params: [{ arr: 'i16' }, 'i32', 'i32'], result: 'void', inline: [{ op: 'array.set', typeIndex: ARRAY.i16.index }]}),
	__towasm_str_copy:			() => ({params: [{ arr: 'i16' }, 'i32', { arr: 'i16' }, 'i32', 'i32'], result: 'void', inline: [
		{ op: 'array.copy', dst: ARRAY.i16.index, src: ARRAY.i16.index },
	]}),
	// Arithmetic/comparison operators -- always `f64,f64`, no persistent integer type means there's n)o
	// other kind to disambiguate by (unlike equality below, or the array/string methods above).
	'+':	() => ({params: ['f64', 'f64'], result: 'f64', inline: [{op: 'f64.add'}]}),
	'-':	() => ({params: ['f64', 'f64'], result: 'f64', inline: [{op: 'f64.sub'}]}),
	'*':	() => ({params: ['f64', 'f64'], result: 'f64', inline: [{op: 'f64.mul'}]}),
	'/':	() => ({params: ['f64', 'f64'], result: 'f64', inline: [{op: 'f64.div'}]}),
	'<':	() => ({params: ['f64', 'f64'], result: 'i32', inline: [{op: 'f64.lt'}]}),
	'>':	() => ({params: ['f64', 'f64'], result: 'i32', inline: [{op: 'f64.gt'}]}),
	'<=':	() => ({params: ['f64', 'f64'], result: 'i32', inline: [{op: 'f64.le'}]}),
	'>=':	() => ({params: ['f64', 'f64'], result: 'i32', inline: [{op: 'f64.ge'}]}),

	// Bitwise/shift -- always `i32,i32`, same reasoning. Shift amounts don't need masking mod 32
	// separately -- wasm's own `shl`/`shr_s`/`shr_u` already do that per spec.
	'&':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [{op: 'i32.and'}]}),
	'|':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [{op: 'i32.or'}]}),
	'^':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [{op: 'i32.xor'}]}),
	'<<':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [{op: 'i32.shl'}]}),
	'>>':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [{op: 'i32.shr_s'}]}),
	'>>>':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [{op: 'i32.shr_u'}]}),

	'===':		args => args[0] && typeof args[0] !== 'string'
		? {params: [args[0], args[0]], result: 'i32', inline: [{op: 'ref.eq'}]}
		:  args[0] === 'i32'
		? {params: ['i32', 'i32'], result: 'i32', inline: [{op: 'i32.eq'}]}
		: {params: ['f64', 'f64'], result: 'i32', inline: [{op: 'f64.eq'}]},
	'==':		args => args[0] === 'i32'
		? {params: ['i32', 'i32'], result: 'i32', inline: [{op: 'i32.eq'}]}
		: {params: ['f64', 'f64'], result: 'i32', inline: [{op: 'f64.eq'}]},

	'!==':		args => args[0] && typeof args[0] !== 'string'
		? {params: [args[0], args[0]], result: 'i32', inline: [{op: 'ref.eq'}, {op: 'i32.eqz'}]}
		: args[0] === 'i32'
		? {params: ['i32', 'i32'], result: 'i32', inline: [{op: 'i32.ne'}]}
		: {params: ['f64', 'f64'], result: 'i32', inline: [{op: 'f64.ne'}]},
	'!=':		args => args[0] === 'i32'
		? {params: ['i32', 'i32'], result: 'i32', inline: [{op: 'i32.ne'}]}
		: {params: ['f64', 'f64'], result: 'i32', inline: [{op: 'f64.ne'}]},

	...Object.fromEntries(LIB_AST.filter(n => n.type === 'function_decl').map(decl => [decl.name, decl]))
};

// Which array kind each `towasm-prelude.ts` "builtin class" provides methods for -- populates
// `ARRAY[kind].methods` with pure decl data, shared read-only across every `TStoWasm` call (unlike
// `arrayBoxOwners`'s own per-compilation `methods` map inside `TStoWasm`, built fresh each call).
const LIB_BOX_KIND: Record<string, TYPE> = {
	ArrF64Box: 'f64', ArrI32Box: 'i32', ArrI8Box: 'i8', String: 'i16',
};
for (const n of LIB_AST) {
	if (n.type === 'class_decl' && n.name in LIB_BOX_KIND) {
		const decls = ARRAY[LIB_BOX_KIND[n.name]].methods;
		for (const m of n.body) {
			if (m.type === 'method' && typeof m.key === 'string')
				decls.set(m.key, m);
		}
	}
}


export function TStoWasm(ast: TS.Program): wasm.WasmModule {
	const global = ast.scope as Scope;
	if (!global)
		throw new Error('towasm: ast must be checked (TStypeCheck/TStypeCheckAsync) before TStoWasm');

	// Never calls `.checkBlock` -- `global` is already fully populated (that's what the check above
	// guarantees); `typeOf` just reads whatever `Scope` it's handed, so a fresh muted checker works fine.
	const checker			= makeChecker(() => {});
	const classes			= new Map<string, ClassInfo>();
	const funcs				= new Map<string, FuncInfo>();
	const structTypeIndex	= new Map<string, number>();

	// One "builtin class" per array kind -- `this` is the array/string `WasmType` itself, never a
	// wasm-GC struct, so unlike `classes` these need no lazy resolution (`thisType`/`thisTsType` are
	// known immediately) and never touch `structTypeIndex`. Built fresh on every `TStoWasm` call --
	// `methods` fills up with per-compilation `FuncInfo` (real function indices into *this* module's
	// index space), so a module-level singleton here would leak stale/wrong indices into every
	// compilation after the first. `methodDecls` is the one part safe to share -- read-only decl data,
	// same object as `ARRAY[kind].methods` above, populated once at module load.
	const arrayBoxOwners: Record<TYPE, MethodOwner> = {
		f64: { name: 'number[]', thisType: { arr: 'f64' },		thisTsType: TS.ArrayType(T.NUMBER),		methodDecls: ARRAY.f64.methods, methods: new Map() },
		i32: { name: 'boolean[]', thisType: { arr: 'i32' },		thisTsType: TS.ArrayType(T.BOOLEAN),	methodDecls: ARRAY.i32.methods, methods: new Map() },
		i8:  { name: 'Uint8Array',  thisType: { arr: 'i8' },	thisTsType: TS.RefType('Uint8Array'),	methodDecls: ARRAY.i8.methods,  methods: new Map() },
		i16: { name: 'string', thisType: { arr: 'i16' },		thisTsType: T.STRING,					methodDecls: ARRAY.i16.methods, methods: new Map(),
			// Both need a raw `array.get_u` -- string indexing is disallowed at the language level, so
			// there's no TS-expressible way to do these (see towasm-prelude.ts's header comment).
			inlineMethods: {
				charCodeAt: { params: ['i32'], result: 'i32', inline: [{ op: 'array.get_u', typeIndex: ARRAY.i16.index }] },
				charAt: { params: ['i32'], result: { arr: 'i16' }, inline: [
					{ op: 'array.get_u', typeIndex: ARRAY.i16.index },
					{ op: 'array.new_fixed', typeIndex: ARRAY.i16.index, n: 1 },
				]},
			},
		},
	};

	// Suffix for hidden `for...of` temp names -- `#` can't start a real local's name (only `this.#foo`),
	// so these can't collide with a real parse, no collision detection needed.
	let forTempCounter = 0;

	// Checks this program's own `classes` first, then falls back to `wasmTypeOf` for everything else.
	function typeOf(t: Type): WasmType | undefined {
		return T.isRefOf(t, classes) ? { ref: t.name } : wasmTypeOf(t, global);
	}

	// The `WasmType` a value expression resolves to -- `classOf`/`arrayKindOf` below are thin
	// discriminating views over this one (previously identical) checker walk.
	function wtypeOf(e: Expr, ctx: FuncCtx): WasmType | undefined {
		return typeOf(checker.typeOf(e, ctx.scope));
	}

	// The class a value expression resolves to, or `undefined` if it isn't one -- shared by member-read,
	// member-assign, and method-call lowering.
	function classOf(e: Expr, ctx: FuncCtx): ClassInfo | undefined {
		const wt = wtypeOf(e, ctx);
		return wt && typeof wt !== 'string' && 'ref' in wt ? ensureClass(wt.ref) : undefined;
	}

	// The array-kind (`{arr}`) a value expression resolves to, or `undefined` if it isn't one.
	function arrayKindOf(e: Expr, ctx: FuncCtx): 'f64' | 'i32' | 'i16' | 'i8' | undefined {
		const wt = wtypeOf(e, ctx);
		return wt && typeof wt !== 'string' && 'arr' in wt ? wt.arr : undefined;
	}

	// The `MethodOwner` a value expression dispatches method calls against -- a real class or one of the
	// four builtin-class array kinds, whichever `wtypeOf` resolves to. Field access stays `classOf`-only
	// (arrays have no fields), but method-call dispatch is otherwise identical for both.
	function ownerOf(e: Expr, ctx: FuncCtx): MethodOwner | undefined {
		const wt = wtypeOf(e, ctx);
		if (!wt || typeof wt === 'string' || 'const' in wt)
			return undefined;
		return 'ref' in wt ? ensureClass(wt.ref) : arrayBoxOwners[wt.arr];
	}

	// Populated by the "index space" pass below, before any body is built -- a class ref's `WasmType`
	// only carries its *name*, but the binary format needs the struct's numeric type index.
	function toValType(w: WasmType): wasm.ValType {
		if (w === 'void')
			throw new Error('towasm: internal: void has no value representation');
		if (typeof w === 'string')
			return w;
		if ('const' in w) {
			switch (typeof w.const) {
				case 'number':	return 'f64';
				case 'boolean':	return 'i32';
				case 'string':	return {ref: ARRAY.i16.index, nullable: false};
			}
		}
		if ('ref' in w)
			return { ref: structTypeIndex.get(w.ref)!, nullable: false };
		return { ref: ARRAY[w.arr].index, nullable: false };
	}

	// A function's *result* -- unlike a param, local, or field -- can legitimately be `'void'`: the
	// wasm func type just has zero results, rather than `toValType` throwing on an unconvertible type.
	function toResultType(w: WasmType): wasm.ValType | undefined {
		return w === 'void' ? undefined : toValType(w);
	}

	function paramWasmType(owner: string, key: string, p: JS.Param<Type>): WasmType {
		if (p.default)
			throw new Error(`towasm: default parameters in '${owner}' are not supported`);
		if (typeof p.key !== 'string')
			throw new Error(`towasm: destructured parameters in '${owner}' are not supported`);
		const wt = p.typeAnnotation && typeOf(p.typeAnnotation);
		if (!wt)
			throw new Error(`towasm: '${owner}' param '${key}' needs an explicit type`);
		if (wt === 'void')
			throw new Error(`towasm: '${owner}' param '${key}' cannot be 'void'`);
		return wt;
	}

	// ===================================================================
	//  Expression lowering -- every case leaves exactly one value on the stack
	// ===================================================================

	// Packed array/struct field values are always pushed as i32, truncated on write regardless of the
	// field's declared storage width -- so a `string` (packed i16) is one `i32.const` per code unit.
	function emitStringConst(s: string, ctx: FuncCtx): void {
		for (let i = 0; i < s.length; i++)
			ctx.emit({ op: 'i32.const', imm: s.charCodeAt(i) });
		ctx.emit({ op: 'array.new_fixed', typeIndex: ARRAY.i16.index, n: s.length });
	}

	// `emitExpr` can return a narrower `WasmType` than `e`'s static type (e.g. `Uint8Array` reads stay
	// `i32`) -- converts only if `want` differs. `f64`->`i32` saturates rather than traps on NaN/overflow.
	function emitAs(e: Expr, ctx: FuncCtx, want: WasmType): void {
		const got = emitExpr(e, ctx);
		if (wasmTypeEq(got, want))
			return;
		if (got === 'f64' && want === 'i32') {
			ctx.emit({ op: 'i32.trunc_sat_f64_s' });
			return;
		}
		if (got === 'i32' && want === 'f64') {
			ctx.emit({ op: 'f64.convert_i32_s' });
			return;
		}
		throw new Error(`towasm: internal: cannot convert ${JSON.stringify(got)} to ${JSON.stringify(want)}`);
	}

	// Shared by the `[1, 2, 3]` array-literal case and `new Uint8Array([...])`'s literal-argument form --
	// both reject holes/spreads and coerce every element to `want` before building a fixed-length array.
	function emitArrayElements(elements: readonly (Expr | undefined)[], ctx: FuncCtx, want: WasmType, typeIndex: number): void {
		for (const el of elements) {
			if (!el)
				throw new Error('towasm: array literals with holes are not supported');
			if (el.type === 'spread')
				throw new Error('towasm: spread in array literals is not supported');
			emitAs(el, ctx, want);
		}
		ctx.emit({ op: 'array.new_fixed', typeIndex, n: elements.length });
	}

	// Dispatches every `builtins` entry, coercing args via `emitAs`; falls back to `ensureFunc` for a
	// plain user-declared function not in `builtins` at all.
	function emitCall(name: string, args: Expr[], ctx: FuncCtx): WasmType {
		if (args.some(a => a.type === 'spread'))
			throw new Error('towasm: spread call arguments are not supported');

		const builtin = builtins[name];
		if (builtin && typeof builtin === 'function') {
			const inline = builtin(args.map(a => wtypeOf(a, ctx)), ctx);
			if (args.length !== inline.params.length)
				throw new Error(`towasm: '${name}' takes exactly ${inline.params.length} argument(s)`);
			args.forEach((a, i) => emitAs(a, ctx, inline.params[i]));
			ctx.emit(...inline.inline);
			return inline.result;
		}

		let info = funcs.get(name);
		if (!info) {
			if (builtin) {
				info = ensureFunc(name, builtin);
			} else {
				const decl = functionDeclByName.get(name);
				if (decl)
					info = ensureFunc(name, decl);
			}
			if (!info)
				throw new Error(`towasm: call to unknown function '${name}'`);
		}

		if (args.length !== info.params.length)
			throw new Error(`towasm: '${name}' takes exactly ${info.params.length} argument(s)`);
		args.forEach((a, i) => emitAs(a, ctx, info!.params[i]));
		ctx.emit({ op: 'call', index: info.funcIndex });
		return info.result;
	}

	// Dispatches a `receiver.name(...args)` call against any `MethodOwner` (a real class or a builtin-
	// class array kind) -- shared by the member-call case below and the `+` string-concat special case.
	// `inlineMethods` (checked first) splices its instructions directly into the caller with no `call`
	// at all, exactly like `emitBuiltinCall`'s own inline entries.
	function emitMethodCall(owner: MethodOwner, name: string, receiver: Expr, args: Expr[], ctx: FuncCtx): WasmType {
		if (args.some(a => a.type === 'spread'))
			throw new Error('towasm: spread call arguments are not supported');

		const inline = owner.inlineMethods?.[name];
		if (inline) {
			if (args.length !== inline.params.length)
				throw new Error(`towasm: '${name}' takes exactly ${inline.params.length} argument(s)`);
			emitExpr(receiver, ctx);
			args.forEach((a, i) => emitAs(a, ctx, inline.params[i]));
			ctx.emit(...inline.inline);
			return inline.result;
		}

		const method = ensureMethod(owner, name);
		if (!method)
			throw new Error(`towasm: unknown method '${name}' on ${owner.name}`);
		if (args.length !== method.params.length)
			throw new Error(`towasm: '${name}' takes exactly ${method.params.length} argument(s)`);
		emitExpr(receiver, ctx);
		args.forEach((a, i) => emitAs(a, ctx, method.params[i]));
		ctx.emit({ op: 'call', index: method.funcIndex });
		return method.result;
	}

	function emitExpr(e: Expr, ctx: FuncCtx): WasmType {
		switch (e.type) {
			case 'literal':
				if (typeof e.value === 'number') {
					if (e.value === (e.value | 0)) {
						ctx.emit({ op: 'i32.const', imm: e.value });
						return 'i32';
					}
					ctx.emit({ op: 'f64.const', imm: e.value });
					return 'f64';
				}
				if (typeof e.value === 'boolean') {
					ctx.emit({ op: 'i32.const', imm: e.value ? 1 : 0 });
					return 'i32';
				}
				if (typeof e.value === 'string') {
					emitStringConst(e.value, ctx);
					return { arr: 'i16' };
				}
				if (Array.isArray(e.value) && e.value.every(p => p.exp === undefined)) {
					// A template literal with no interpolations (`` `abc` ``) is just a string in disguise.
					emitStringConst(e.value.map(p => p.str).join(''), ctx);
					return { arr: 'i16' };
				}
				throw new Error(`towasm: unsupported literal type '${typeof e.value}'`);

			case 'identifier':
			case 'this': {
				const local = ctx.lookup(e.type === 'this' ? 'this' : e.name);
				ctx.emit({ op: 'local.get', index: local.index });
				return local.wtype;
			}

			case 'member': {
				if (e.property === 'length' && arrayKindOf(e.object, ctx)) {
					emitExpr(e.object, ctx);
					ctx.emit({ op: 'array.len' });
					// Unsigned: `array.len` can in principle exceed i32's signed range, so this needs
					// `convert_i32_u` specifically, not `emitAs`'s generic signed coercion.
					ctx.emit({ op: 'f64.convert_i32_u' });
					return 'f64';
				}
				const cls = classOf(e.object, ctx);
				const fieldIdx = cls?.fieldIndex.get(e.property);
				if (!cls || fieldIdx === undefined)
					throw new Error(`towasm: unknown field '${e.property}'`);
				emitExpr(e.object, ctx);
				ctx.emit({ op: 'struct.get', typeIndex: structTypeIndex.get(cls.name)!, field: fieldIdx });
				return cls.fields[fieldIdx].wtype;
			}

			// Read-only, `number[]`/`boolean[]`/`Uint8Array` only -- not `string` (real `str[i]` yields a
			// 1-char string, not a code unit).
			case 'index': {
				const kind = arrayKindOf(e.object, ctx);
				if (!kind || kind === 'i16')
					throw new Error("towasm: indexing is only supported on number[]/boolean[]/Uint8Array ('string' is immutable and not indexable in this pass)");
				const typeIndex = ARRAY[kind].index;
				emitExpr(e.object, ctx);
				emitAs(e.property, ctx, 'i32');
				if (kind === 'i8') {
					ctx.emit({ op: 'array.get_u', typeIndex });
					return 'i32'; // transient, see `emitAs`
				}
				ctx.emit({ op: 'array.get', typeIndex });
				return kind;
			}

			// Only ever types as `number[]`/`boolean[]`; `new Uint8Array([...])` below handles i8.
			case 'array': {
				const kind = arrayKindOf(e, ctx);
				if (!kind || kind === 'i16' || kind === 'i8')
					throw new Error('towasm: array literals are only supported for number[]/boolean[]');
				emitArrayElements(e.elements, ctx, kind, ARRAY[kind].index);
				return { arr: kind };
			}

			case 'unary':
				if (e.operator === '-') {
					emitAs(e.operand, ctx, 'f64');
					ctx.emit({ op: 'f64.neg' });
					return 'f64';
				}
				if (e.operator === '!') {
					emitAs(e.operand, ctx, 'i32');
					ctx.emit({ op: 'i32.eqz' });
					return 'i32';
				}
				if (e.operator === '~') {
					// No dedicated "bitwise not" in wasm -- `x ^ -1` is the standard idiom.
					emitAs(e.operand, ctx, 'i32');
					ctx.emit({ op: 'i32.const', imm: -1 });
					ctx.emit({ op: 'i32.xor' });
					return 'i32';
				}
				throw new Error(`towasm: unsupported unary operator '${e.operator}'`);

			case 'conditional': {
				const wtype = wtypeOf(e, ctx);
				if (!wtype)
					throw new Error('towasm: conditional expression has an unsupported type');
				emitAs(e.test, ctx, 'i32');
				const old = ctx.swapOut();
				emitAs(e.consequent, ctx, wtype);
				const _then = ctx.swapOut();
				emitAs(e.alternate, ctx, wtype);
				const _else = ctx.swapOut(old);
				ctx.emit({ op: 'if', blockType: toValType(wtype), then: _then, else: _else });
				return wtype;
			}

			case 'new': {
				if (e.callee.type === 'identifier' && e.callee.name === 'Uint8Array') {
					const typeIndex = ARRAY.i8.index;
					if (e.arguments.length !== 1)
						throw new Error("towasm: 'new Uint8Array(...)' needs exactly one argument (a length, or an array literal)");
					const arg = e.arguments[0];
					if (arg.type === 'spread')
						throw new Error('towasm: spread arguments are not supported');
					if (arg.type === 'array') {
						emitArrayElements(arg.elements, ctx, 'i32', typeIndex);
					} else {
						emitAs(arg, ctx, 'i32');
						ctx.emit({ op: 'array.new_default', typeIndex });
					}
					return { arr: 'i8' };
				}
				if (e.callee.type === 'identifier' && e.callee.name === 'String') {
					if (e.arguments.length === 0) {
						ctx.emit({ op: 'array.new_fixed', typeIndex: ARRAY.i16.index, n: 0 });
						return { arr: 'i16' };
					}
					if (e.arguments.length === 1 && arrayKindOf(e.arguments[0], ctx) === 'i16') {
						// Real JS distinguishes a boxed `new String(s)` from the primitive `s`
						// (`new String(s) === s` is `false`) -- this compiler has no such distinction
						// (both are just `i16` arrays) and rejects string `===` entirely, so the
						// difference is unobservable; returning the same value is exact, not approximate.
						return emitExpr(e.arguments[0], ctx);
					}
					throw new Error("towasm: 'new String(...)' only supports zero arguments or one existing string -- stringifying a number/boolean/etc is not supported in this pass");
				}
				if (e.callee.type !== 'identifier')
					throw new Error(`towasm: 'new' is only supported for a known class, 'Uint8Array', or 'String'`);
				const cls = ensureClass(e.callee.name);
				if (!cls)
					throw new Error(`towasm: 'new' is only supported for a known class, 'Uint8Array', or 'String'`);
				const ctor = ensureCtor(cls);
				if (e.arguments.length !== ctor.params.length || e.arguments.some(a => a.type === 'spread'))
					throw new Error(`towasm: '${e.callee.name}''s constructor takes exactly ${ctor.params.length} (non-spread) argument(s)`);
				e.arguments.forEach((a, i) => emitAs(a, ctx, ctor.params[i]));
				ctx.emit({ op: 'call', index: ctor.funcIndex });
				return { ref: e.callee.name };
			}

			case 'call': {
				if (e.callee.type === 'member') {
					const obj = e.callee.object;
					if (obj.type === 'identifier' && obj.name === 'Math')
						return emitCall(`Math.${e.callee.property}`, e.arguments, ctx);

					const owner = ownerOf(obj, ctx);
					if (!owner)
						throw new Error(`towasm: unknown method '${e.callee.property}'`);
					return emitMethodCall(owner, e.callee.property, obj, e.arguments, ctx);
				}
				if (e.callee.type !== 'identifier')
					throw new Error('towasm: only direct calls to named functions, methods, or Math intrinsics are supported');

				return emitCall(e.callee.name, e.arguments, ctx);
			}

			case 'binary': {
				const op = e.operator;
				if (op === '=') {
					// Field assignment (`obj.field = expr`) is statement-only -- see `emitAssign` -- since unlike
					// `local.tee`, `struct.set` has no variant that also leaves the assigned value on the stack.
					if (e.left.type !== 'identifier')
						throw new Error("towasm: assignment can only be used as its own statement unless the target is a plain identifier");
					const local = ctx.lookup(e.left.name);
					emitAs(e.right, ctx, local.wtype);
					ctx.emit({ op: 'local.tee', index: local.index });
					return local.wtype;
				}
				if (op === '&&') {
					emitAs(e.left, ctx, 'i32');
					const old = ctx.swapOut();
					emitAs(e.right, ctx, 'i32');
					const _right = ctx.swapOut(old);
					ctx.emit({ op: 'if', blockType: 'i32', then: _right, else: [{ op: 'i32.const', imm: 0 }] });
					return 'i32';
				}
				if (op === '||') {
					emitAs(e.left, ctx, 'i32');
					const old = ctx.swapOut();
					emitAs(e.right, ctx, 'i32');
					const _right = ctx.swapOut(old);
					ctx.emit({ op: 'if', blockType: 'i32', then: [{ op: 'i32.const', imm: 1 }], else: _right });
					return 'i32';
				}
				if (op === '+' && arrayKindOf(e.left, ctx) === 'i16') {
					if (arrayKindOf(e.right, ctx) !== 'i16')
						throw new Error("towasm: string '+' requires both operands to be strings");
					return emitMethodCall(arrayBoxOwners.i16, 'concat', e.left, [e.right], ctx);
				}
				/*
				if (op === '===' || op === '!==' || op === '==' || op === '!=') {
					const kind = wtypeOf(e.left, ctx);
					const op2 = op === '===' ? '==' : op === '!==' ? '!=' : op;

					// Booleans are `i32` on the stack, not `f64` -- dispatched by kind, same idea as an
					// array/string method dispatching by `arrayKindOf` (see the `builtins` comment above).
					if (kind === 'i32')
						return emitCall(`${op2}.i32`, [e.left, e.right], ctx);

					if (kind && typeof kind !== 'string') {
						if ('arr' in kind && kind.arr === 'i16')
							throw new Error("towasm: string equality (by value) is not supported in this pass -- only reference types (arrays/Uint8Array/class instances) support '=='/'==='");
						// Class instances and non-string arrays: JS object/array equality is reference
						// identity for all four spellings -- `ref.eq` can't join `builtins` (no "any ref"
						// `WasmType` to declare a signature with), so this stays direct emission.
						emitExpr(e.left, ctx);
						emitExpr(e.right, ctx);
						ctx.emit({ op: 'ref.eq' });
						if (op2 === '!=')
							ctx.emit({ op: 'i32.eqz' });
						return 'i32';
					}
					return emitCall(`${op2}.f64`, [e.left, e.right], ctx);
				}*/
				// Every remaining operator is single-kind (no persistent integer type means arithmetic/
				// comparison is always `f64`; bitwise is always `i32`), so the raw symbol is already an
				// unambiguous `builtins` key -- not dispatched through `emitBuiltinCall` itself so an
				// unsupported operator gets a clear message instead of "unknown function".
				const builtin = builtins[op];
				if (!builtin || typeof builtin !== 'function')
					throw new Error(`towasm: unsupported binary operator '${op}'`);
				const inline = builtin([wtypeOf(e.left, ctx), wtypeOf(e.right, ctx)], ctx);
				emitAs(e.left, ctx, inline.params[0]);
				emitAs(e.right, ctx, inline.params[1]);
				ctx.emit(...inline.inline);
				return inline.result;
			}

			default:
				throw new Error(`towasm: unsupported expression '${e.type}'`);
		}
	}

	// Split from `emitExpr`'s binary `'='` case because `struct.set` can't also yield the assigned value
	// the way `local.tee` does -- field assignment can only ever be a statement, not a sub-expression.
	function emitAssign(left: Expr, right: Expr, ctx: FuncCtx): void {
		if (left.type === 'identifier') {
			const local = ctx.lookup(left.name);
			emitAs(right, ctx, local.wtype);
			ctx.emit({ op: 'local.set', index: local.index });
			return;
		}
		if (left.type === 'member') {
			const cls = classOf(left.object, ctx);
			const fieldIdx = cls?.fieldIndex.get(left.property);
			if (!cls || fieldIdx === undefined)
				throw new Error(`towasm: unknown field '${left.property}'`);
			emitExpr(left.object, ctx);
			emitAs(right, ctx, cls.fields[fieldIdx].wtype);
			ctx.emit({ op: 'struct.set', typeIndex: structTypeIndex.get(cls.name)!, field: fieldIdx });
			return;
		}
		if (left.type === 'index') {
			const kind = arrayKindOf(left.object, ctx);
			if (!kind || kind === 'i16')
				throw new Error("towasm: index assignment is only supported on number[]/boolean[]/Uint8Array ('string' is immutable)");
			emitExpr(left.object, ctx);
			emitAs(left.property, ctx, 'i32');
			emitAs(right, ctx, kind === 'f64' ? 'f64' : 'i32');
			ctx.emit({ op: 'array.set', typeIndex: ARRAY[kind].index });
			return;
		}
		throw new Error('towasm: unsupported assignment target');
	}

	// ===================================================================
	//  Statement lowering
	// ===================================================================

	function emitStmt(s: Statement, ctx: FuncCtx): void {
		switch (s.type) {
			case 'block':
				s.body.forEach(st => emitStmt(st, ctx));
				return;

			case 'var_decl':
				for (const d of s.declarations) {
					if (typeof d.name !== 'string')
						throw new Error('towasm: destructured declarations are not supported');
					if (!d.init)
						throw new Error(`towasm: local '${d.name}' needs an initializer`);
					// Type computed before emitting the init, so the init can be emitted via `emitAs`
					// straight into the local's declared representation, no separate coercion after.
					const indexKind = d.init.type === 'index' ? arrayKindOf(d.init.object, ctx) : undefined;
					const methodKind = d.init.type === 'call' && d.init.callee.type === 'member' ? arrayKindOf(d.init.callee.object, ctx) : undefined;
					const tsType = d.typeAnnotation
						?? (indexKind && indexKind !== 'i16' ? indexElementType(indexKind) : undefined)
						?? (methodKind && d.init.type === 'call' && d.init.callee.type === 'member' ? methodResultType(methodKind, d.init.callee.property) : undefined)
						?? checker.typeOf(d.init, ctx.scope);
					const wtype = typeOf(tsType);
					if (!wtype) {
						// Let the actual lowering throw its own more specific error first (e.g. indexing a
						// `string`) -- only fall back to this generic message if it didn't.
						emitExpr(d.init, ctx);
						throw new Error(`towasm: local '${d.name}' has an unsupported type`);
					}
					if (wtype === 'void')
						throw new Error(`towasm: local '${d.name}' cannot have type 'void'`);
					emitAs(d.init, ctx, wtype);
					const local = ctx.declareValue(d.name, wtype, tsType);
					ctx.emit({ op: 'local.set', index: local.index });
				}
				return;

			case 'expression':
				if (s.expression.type === 'binary' && s.expression.operator === '=') {
					emitAssign(s.expression.left, s.expression.right, ctx);
				} else {
					// A non-`void` expression leaves one value on the stack -- statement position needs
					// it balanced back to zero. `void` (only ever a builtins call, e.g. `array.set`'s
					// effect) already leaves nothing, so there's nothing to drop.
					if (emitExpr(s.expression, ctx) !== 'void')
						ctx.emit({ op: 'drop' });
				}
				return;

			case 'if': {
				emitExpr(s.test, ctx);
				const old = ctx.swapOut();
				emitStmt(s.consequent, ctx);
				if (s.alternate) {
					const _then = ctx.swapOut();
					emitStmt(s.alternate, ctx);
					const _else = ctx.swapOut(old);
					ctx.emit({ op: 'if', blockType: undefined, then: _then, else: _else });
				} else {
					const _then = ctx.swapOut(old);
					ctx.emit({ op: 'if', blockType: undefined, then: _then });
				}
				return;
			}

			case 'while': {
				// A `block` wrapping a `loop`: branching to the loop (label 0) re-enters it ("continue"),
				// branching to the block (label 1) exits it ("break") -- standard structured-control idiom.
				const old = ctx.swapOut();
				emitExpr(s.test, ctx);
				ctx.emit({ op: 'i32.eqz' });
				ctx.emit({ op: 'br_if', index: 1 });
				emitStmt(s.body, ctx);
				ctx.emit({ op: 'br', index: 0 });
				const _cont = ctx.swapOut(old);
				ctx.emit({ op: 'block', blockType: undefined, body: [{ op: 'loop', imm: undefined, body: _cont }] });
				return;
			}

			case 'return':
				if (ctx.ctorThis) {
					if (s.argument)
						throw new Error('towasm: a constructor cannot return a value');
					ctx.emit({ op: 'local.get', index: ctx.ctorThis.index });
				} else {
					if (ctx.result === 'void' && s.argument)
						throw new Error("towasm: a 'void' function cannot return a value");
					if (s.argument)
						emitAs(s.argument, ctx, ctx.result);
				}
				ctx.emit({ op: 'return' });
				return;

			// Both `for` shapes desugar into synthetic `block`/`var_decl`/`while` nodes and recurse into
			// `emitStmt` itself, rather than adding a second instruction-emission path alongside `while`'s.
			case 'for': {
				if (s.kind === 'normal') {
					const initStmt: Statement | undefined = s.init === undefined ? undefined
						: s.init.type === 'var_decl' ? s.init : { type: 'expression', expression: s.init };
					emitStmt({
						type: 'block',
						body: [
							...(initStmt ? [initStmt] : []),
							{
								type: 'while',
								test: s.test ?? Literal(true),
								body: {
									type: 'block',
									body: [s.body, ...(s.update ? [{ type: 'expression' as const, expression: s.update }] : [])],
								},
							},
						],
					}, ctx);
					return;
				}

				if (s.kind !== 'of')
					throw new Error(`towasm: 'for...${s.kind}' is not supported`);
				if (s.init.type !== 'var_decl' || s.init.declarations.length !== 1 || typeof s.init.declarations[0].name !== 'string')
					throw new Error("towasm: 'for...of' loop variable must be a single plain identifier declaration");

				const kind = arrayKindOf(s.right, ctx);
				if (!kind || kind === 'i16')
					throw new Error("towasm: 'for...of' is only supported over number[]/boolean[]/Uint8Array (not 'string' -- see the 'index' case)");

				const n			= forTempCounter++;
				const arrId: Expr = { type: 'identifier', name: `#for${n}$arr` };
				const idxId: Expr = { type: 'identifier', name: `#for${n}$i` };

				emitStmt({
					type: 'block',
					body: [
						JS.VarDecl('const', JS.Var(arrId.name, s.right)),
						JS.VarDecl('let', JS.Var(idxId.name, Literal(0))),
						{
							type: 'while',
							test: JS.JSBinary('<', idxId, JS.Member(arrId, 'length')),
							body: {
								type: 'block',
								body: [
									JS.VarDecl('const', JS.Var(s.init.declarations[0].name, JS.Index(arrId, idxId), indexElementType(kind))),
									s.body,
									{ type: 'expression', expression: JS.JSBinary('=', idxId, JS.JSBinary('+', idxId, Literal(1))) },
								],
							},
						},
					],
				}, ctx);
				return;
			}

			default:
				throw new Error(`towasm: unsupported statement '${s.type}'`);
		}
	}

	// ===================================================================
	//  Program lowering
	// ===================================================================

	// Struct/func types + one function index per ctor/method/function share the binary format's flat
	// numbering. Array-kind types register unconditionally (just 4 fixed entries); everything else
	// (classes, functions, the prelude) registers -- and validates -- lazily on first reachable use,
	// via `ensureFunc`/`ensureClass`/`emitBuiltinCall` and the worklist below.
	const types: wasm.SubType[] = [];
	const functionDeclByName = new Map<string, FunctionDecl>();
	const worklist: (()=>void)[] = [];

	// Pushed in the order `ARRAY`' own values declare -- that record *is* the index-to-kind map.
	for (const kind of ['f64', 'i32', 'i16', 'i8'] as const) {
		// All mutable at the wasm level, even `i16` (`string`) -- `__towasm_str_setChar`'s `array.set`
		// needs to write into it; "strings are immutable" is enforced by never emitting `set` from
		// ordinary user-level TS code, only from that one hand-built intrinsic.
		types.push({ final: true, supertypes: [], type: { kind: 'array', field: { type: kind, mut: true } } });
	}

	let nextFunc = 0;
	function registerFunc(params: wasm.ValType[], result: wasm.ValType | undefined) {
		const typeIndex = types.length;
		types.push({ final: true, supertypes: [], type: { kind: 'func', params, results: result !== undefined ? [result] : [] } });
		return { funcIndex: nextFunc++, typeIndex };
	}

	function ensureFunc(name: string, decl: FunctionDecl): FuncInfo | undefined {
		if (decl.typeParams?.length)
			throw new Error(`towasm: generic function '${name}' is not supported`);
		if (decl.rest)
			throw new Error(`towasm: rest parameters in '${name}' are not supported`);

		// No annotation at all defaults to `void` (matching real TS's own inference for a function that
		// never returns a value) -- but an annotation that's present and just doesn't resolve is still a
		// real error, not silently `void` too.
		const result = decl.returnType ? typeOf(decl.returnType as Type) : 'void';
		if (!result)
			throw new Error(`towasm: '${name}' has an unsupported return type`);
		const params = decl.params.map(p => paramWasmType(name, p.key as string, p));
		const {funcIndex, typeIndex} = registerFunc(params.map(toValType), toResultType(result));
		const info: FuncInfo = {params, result, funcIndex, typeIndex};
		funcs.set(name, info);
		worklist.push(() => {
			const ctx	= new FuncCtx(new Scope(global), result);
			ctx.declareParams(decl.params, params);
			decl.body!.forEach(st => emitStmt(st, ctx));
			info.body = ctx.toFuncBody(params.length, toValType);
		});
		return info;
	}

	// Resolves fields and the struct type eagerly (every use of the class needs the full field list at
	// once), but only *collects* method/ctor decls -- building each one is deferred to `ensureMethod`/
	// `ensureCtor` below, the same lazy-on-first-use treatment `ensureFunc` gives top-level functions.
	function ensureClass(name: string): ClassInfo | undefined {
		const info = classes.get(name);
		if (!info || info.resolved)
			return info;
		const decl = info.decl;
		if (decl.typeParams?.length)
			throw new Error(`towasm: generic class '${name}' is not supported`);
		if (decl.superClass)
			throw new Error(`towasm: inheritance ('${name} extends ...') is not supported`);
		if (decl.abstract)
			throw new Error(`towasm: abstract class '${name}' is not supported`);

		for (const m of decl.body) {
			if (m.type === 'field') {
				if (typeof m.key !== 'string')
					throw new Error(`towasm: computed field names in '${name}' are not supported`);
				if (m.modifiers?.includes('static'))
					throw new Error(`towasm: static members ('${name}.${m.key}') are not supported`);
				if (m.value)
					throw new Error(`towasm: field initializers ('${name}.${m.key}') are not supported -- set them in the constructor`);
				const wt = m.typeAnnotation && typeOf(m.typeAnnotation as Type);
				if (!wt || wt === 'void' || typeof wt !== 'string')
					throw new Error(`towasm: field '${name}.${m.key}' needs an explicit number/boolean type (a class-typed field isn't -- struct.new_default has no zero value for a non-null reference)`);
				info.fieldIndex.set(m.key, info.fields.length);
				info.fields.push({ name: m.key, wtype: wt });

			} else if (m.type === 'method') {
				// A computed name can't be stored as a decl key -- and can never be called via `.name()`
				// syntax either, so it's simply never reachable, no need to throw.
				if (typeof m.key !== 'string')
					continue;
				if (m.key === 'constructor')
					info.ctorDecl = m;
				else
					info.methodDecls.set(m.key, m);

			} else {
				throw new Error(`towasm: unsupported class member kind '${m.type}' in '${name}'`);
			}
		}

		structTypeIndex.set(name, types.length);
		types.push({ final: true, supertypes: [], type: { kind: 'struct', fields: info.fields.map(f => ({ type: toValType(f.wtype), mut: true })) } });
		info.resolved = true;
		return info;
	}

	// Lazy the same way `ensureFunc` is: an unreached class is never `new`'d, so its ctor never needs
	// validating/registering/building.
	function ensureCtor(cls: ClassInfo): FuncInfo {
		if (cls.ctor)
			return cls.ctor;
		const ctor = cls.ctorDecl;
		if (!ctor)
			throw new Error(`towasm: class '${cls.name}' needs an explicit constructor`);
		if (ctor.params.some(p => p.modifiers?.some(x => x !== 'optional')))
			throw new Error(`towasm: parameter properties in '${cls.name}''s constructor are not supported -- declare fields explicitly and assign them in the body`);
		const params = ctor.params.map(p => paramWasmType(`${cls.name}'s constructor`, p.key as string, p));
		const {funcIndex, typeIndex} = registerFunc(params.map(toValType), toValType(cls.thisType));
		const info: FuncInfo = { params, result: cls.thisType, funcIndex, typeIndex };
		cls.ctor = info;
		worklist.push(() => {
			const ctx		= new FuncCtx(new Scope(global), cls.thisType);
			// `this` isn't a *parameter* here (unlike in a method) -- it's a local, materialized partway
			// through the body by `struct.new_default`, so it's declared after the real ctor params.
			ctx.declareParams(ctor.params, params);
			const thisLocal = ctx.declareValue('this', cls.thisType, cls.thisTsType);
			ctx.ctorThis = thisLocal;

			ctx.emit(
				{ op: 'struct.new_default', typeIndex: structTypeIndex.get(cls.name)! },
				{ op: 'local.set', index: thisLocal.index },
			);
			ctor.body!.forEach(st => emitStmt(st, ctx));
			ctx.emit(
				{ op: 'local.get', index: thisLocal.index },
				{ op: 'return' }
			);

			info.body = ctx.toFuncBody(ctor.params.length, toValType);
		});
		return info;
	}

	// Lazy the same way `ensureFunc` is: a method never called from reachable code is never validated,
	// registered, or built. Generalized over `MethodOwner` -- identical for a real class and a builtin-
	// class array kind, since both just need a `this` `WasmType`/`Type` and a decl to lower.
	function ensureMethod(owner: MethodOwner, name: string): FuncInfo | undefined {
		const existing = owner.methods.get(name);
		if (existing)
			return existing;
		const decl = owner.methodDecls.get(name);
		if (!decl)
			return undefined;
		if (decl.modifiers?.includes('static'))
			throw new Error(`towasm: static members ('${owner.name}.${name}') are not supported`);
		if (decl.typeParams?.length)
			throw new Error(`towasm: generic methods ('${owner.name}.${name}') are not supported`);
		if (decl.rest)
			throw new Error(`towasm: rest parameters in '${owner.name}.${name}' are not supported`);
		if (!decl.body)
			throw new Error(`towasm: '${owner.name}.${name}' needs a body (overload signatures are not supported)`);
		// See `ensureFunc`'s comment: no annotation defaults to `void`, but an unresolvable one still throws.
		const result = decl.returnType ? typeOf(decl.returnType as Type) : 'void';
		if (!result)
			throw new Error(`towasm: '${owner.name}.${name}' has an unsupported return type`);
		const params = decl.params.map(p => paramWasmType(`${owner.name}.${name}`, p.key as string, p));
		const {funcIndex, typeIndex} = registerFunc([toValType(owner.thisType), ...params.map(toValType)], toResultType(result));
		const info: FuncInfo = { params, result, funcIndex, typeIndex };
		owner.methods.set(name, info);
		worklist.push(() => {
			const ctx	= new FuncCtx(new Scope(global), result);
			ctx.declareValue('this', owner.thisType, owner.thisTsType);
			ctx.declareParams(decl.params, params);
			decl.body!.forEach(st => emitStmt(st, ctx));
			info.body = ctx.toFuncBody(1 + decl.params.length, toValType);
		});
		return info;
	}

	// Seed with every exported (real, user-level top-level) function and reserve every class name eagerly
	for (const s of ast.body) {
		if (s.type === 'function_decl' && s.body) {
			functionDeclByName.set(s.name, s);
		} else if (s.type === 'class_decl') {
			classes.set(s.name, {
				name: 		s.name,
				thisType:	{ ref: s.name },
				thisTsType:	TS.RefType(s.name),
				decl:		s,
				fields: 	[],
				fieldIndex: new Map(),
				resolved:	false,
				methodDecls: new Map(),
				methods:	new Map()
			});
		}
	}
	for (const f of functionDeclByName)
		ensureFunc(f[0], f[1]);

	while (worklist.length)
		worklist.shift()!();

	// ---- assemble the module ----
	const functionTypes	= new Array<number>(nextFunc);
	const code			= new Array<wasm.FuncBody>(nextFunc);
	function place(info: FuncInfo) {
		functionTypes[info.funcIndex]	= info.typeIndex;
		code[info.funcIndex]			= info.body!;
	}
	for (const info of funcs.values())
		place(info);
	// Class ctors/methods live on `ClassInfo`, not in `funcs` -- placed independently here, since a class
	// can be reached only through its methods (ctor unbuilt) or only through `new` (methods unbuilt).
	for (const c of classes.values()) {
		if (c.ctor)
			place(c.ctor);
		for (const m of c.methods.values())
			place(m);
	}
	// Builtin-class (array/string) methods -- same reasoning, minus the ctor case (arrays have none).
	for (const owner of Object.values(arrayBoxOwners))
		for (const m of owner.methods.values())
			place(m);

	const mod			= new wasm.WasmModule();
	mod.types			= { types, groupSizes: types.map(() => 1) };
	mod.functionTypes	= functionTypes;
	mod.code			= code;

	// Only top-level functions are exported -- class ctors/methods are reachable through them.
	for (const s of ast.body) {
		if (s.type === 'function_decl' && s.body)
			(mod.exports??=[]).push({ name: s.name, kind: 'func', index: funcs.get(s.name)!.funcIndex });
	}

	return mod;
}
