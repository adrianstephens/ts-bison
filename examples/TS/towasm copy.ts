import * as fs from 'fs';
import * as path from 'path';
import * as TS from './ts-parser';
import * as JS from './js-parser';
import * as T from './type-utils';
import { Literal, Binary } from '../common';
import { makeChecker } from './checker';
import { walk, walkB, hasMod } from './walker';
import * as wasm from '@isopodlabs/binary_libs/wasm';
import * as WAT from '../wat-parser';

// TStoWasm -- TS-AST-to-wasm backend for a narrow static subset.
// Assumes ast already passed TStypeCheck. Emits a wasm.WasmModule directly (no WAT stage).
// Unsupported: generics, inheritance, async/await, exceptions, closures with captures-shared-back,
// arrays of objects, nullable numbers, most Array/String/Math methods. Every unsupported construct throws.

type Expr			= JS.Expr;
type Type			= TS.Type;
type Statement		= TS.Statement;
type BindingTarget	= JS.BindingTarget;
type FunctionDecl	= JS.FunctionDecl<Type>;
type MethodMember	= JS.Method<Type>;
type Scope			= T.Scope;
const Scope			= T.Scope;

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);

const I = wasm.I;

// lib files concatenated into one flat declaration list; order doesn't matter for LIB_DECL_MAP.
const LIB_DIR		= path.join(__dirname, 'lib');
const LIB_AST		= ['lib.d.ts', 'number.ts', 'bigint.ts', 'string.ts', 'array.ts', 'typedarray.ts'].flatMap(f => TS.parse(fs.readFileSync(path.join(LIB_DIR, f), 'utf8')).body);
const LIB_EXPORTS	= LIB_AST.filter(n => n.type === 'export_decl').map(n =>n.declaration);
const LIB_DECLS		= [
	...[...LIB_EXPORTS, ...LIB_AST].filter(n => n.type === 'function_decl' || n.type === 'class_decl'),
	...[...LIB_EXPORTS, ...LIB_AST].filter(n => n.type === 'var_decl').flatMap(d => d.declarations.map(d => ({type: 'var_decl', ...d} as const)))
];

const LIB_DECL_MAP = new Map(LIB_DECLS.map(i => [i.name, i]));

// `void` is only valid as a function result, never a param/local/field.
type wasmElement	= 'i16' | 'i32' | 'i64' | 'f32' | 'f64' | 'u32' | 'ref';
// `u32` is not a real wasm type -- tracks "unsigned i32" so coerceTop picks convert_i32_u vs _s.
// `nullable` only applies to ref/arr. `{closure}` = 2-field {code,env} struct. `{typeIndex}` = internal resolved ref.
type WasmType		= 'i32' | 'u32' | 'i64' | 'f32' | 'f64' | 'void'
	| { ref: string; nullable?: boolean }
	| { arr: wasmElement; nullable?: boolean }
	| { closure: FuncSig; nullable?: boolean }
	| { typeIndex: number; nullable?: boolean };

// Shared singletons -- ctx.local compares WasmType by object identity (not structural equality).
// Two separate array writes in one function would throw "redeclared with different type" without these.
const ARR_WTYPE: Record<wasmElement, WasmType> = {
	i16: { arr: 'i16' }, i32: { arr: 'i32' }, i64: { arr: 'i64' }, f32: { arr: 'f32' },
	f64: { arr: 'f64' }, u32: { arr: 'u32' }, ref: { arr: 'ref' },
};

// Shared singleton for the same identity-comparison reason as ARR_WTYPE.
const REF_ANY: WasmType = { ref: 'any' };

function wasmTypeEq(a: WasmType, b: WasmType): boolean {
	if (typeof a === 'string' || typeof b === 'string')
		return a === b;
	if ('ref' in a && 'ref' in b)
		return a.ref === b.ref && !a.nullable === !b.nullable;
	if ('arr' in a && 'arr' in b)
		return a.arr === b.arr && !a.nullable === !b.nullable;
	if ('typeIndex' in a && 'typeIndex' in b)
		return a.typeIndex === b.typeIndex && !a.nullable === !b.nullable;
	if ('closure' in a && 'closure' in b)
		return !a.nullable === !b.nullable && funcSigEq(a.closure, b.closure);
	return false;
}

// Structural equality -- two independently-obtained FuncSigs for the same TS type must compare equal.
function funcSigEq(a: FuncSig, b: FuncSig): boolean {
	return a.params.length === b.params.length && wasmTypeEq(a.result, b.result) && a.params.every((p, i) => wasmTypeEq(p, b.params[i]));
}

interface FuncSig					{ params: WasmType[]; result: WasmType }
// reassignsThis: body assigns to `this` -- compiled with an extra wasm result (updated this), consumed by every call site.
interface FuncInfo extends FuncSig	{ funcIndex: number; typeIndex: number, body?: wasm.FuncBody; defaults?: (Expr | undefined)[]; hasRest?: boolean; reassignsThis?: boolean }
interface Inline extends FuncSig	{ inline: wasm.Instr[] }
interface MethodDelegate 			{ owner: MethodOwner; method: string }

interface ClosureTypeInfo			{ funcTypeIndex: number; structTypeIndex: number }

type Builtin<T = Inline | MethodDelegate | FunctionDecl> = (args: OperandInfo[], ctx: FuncCtx) => T

interface MethodOwner {
	decl:			TS.Class;
	name:			string;
	thisTsType:		Type;
	typeIndex:		number;
	methodDecls:	Map<string, MethodMember>;
	inlineMethods?:	Map<string, Builtin<Inline>>;
	// Accessor names -- underlying decl lives under accessorKey('get'|'set', name) in methodDecls/inlineMethods.
	getterNames?:	Set<string>;
	setterNames?:	Set<string>;
}

interface ClassInfo extends MethodOwner {
	fields:			{ name: string; wtype: WasmType }[];
	fieldIndex:		Map<string, number>;
	ctor?:			FuncInfo;
	// This class's own real physical `this`-type: `{ref: name}` for an ordinary struct-backed class, or
	// whatever its own constructor's `return` expression actually compiles to (see `ensureCtor`'s
	// explicit-return branch, driven by `ctorReturnsValue`) -- never guessed from the class's name.
	// `undefined` only for the brief window while that very constructor is being compiled (`ownerThisType`
	// falls back to `{ref: name}` then -- always safe, since only a *static* method can be compiled during
	// that window, and a static method's own `this`-type is computed but never actually used).
	thisWtype?:		WasmType;
}

interface Local {
	wtype: WasmType, index: number;
}

class FuncCtx {
	locals	= new Map<string, Local>();
	out:	wasm.Instr[]	= [];
	ctorThis?: Local;
	// depth counts open block/loop/if labels; breakTargets/continueTargets record depth at each label
	// so `br(depth - target)` gives the correct relative index from any nesting depth.
	depth = 0;
	breakTargets: number[] = [];
	continueTargets: number[] = [];
	// Set when this FuncCtx is a closure body -- captured names have no real local, reads/writes go
	// through struct.get/set on envLocal.
	closureEnv?: { envLocal: Local; envTypeIndex: number; fields: Map<string, { index: number; wtype: WasmType }> };
	// Set while compiling a reassignsThis method -- every return also pushes the current `this`.
	appendThisOnReturn = false;

	constructor(public scope: Scope, public result: WasmType, public owner?: MethodOwner) {}

	local(name: string, wtype: WasmType): number {
		const prev = this.locals.get(name);
		if (prev) {
			if (prev.wtype !== wtype)
				throw new Error(`towasm: local '${name}' redeclared with different type`);
			return prev.index;
		}
		const index = this.locals.size;
		this.locals.set(name, { wtype, index});
		return index;
	}

	declareLocal(name: string, wtype: WasmType): Local {
		if (this.locals.has(name))
			throw new Error(`towasm: local '${name}' redeclared (shadowing is not supported)`);
		const local = { wtype, index: this.locals.size};
		this.locals.set(name, local);
		return local;
	}

	declareValue(name: string, wtype: WasmType, tsType: Type): Local {
		this.scope.addValue(name, tsType);
		return this.declareLocal(name, wtype);
	}

	// No real wasm local -- storage is a closureEnv struct field.
	declareCaptured(name: string, tsType: Type) {
		this.scope.addValue(name, tsType);
	}

	resolvesName(name: string): boolean {
		return this.locals.has(name) || !!this.closureEnv?.fields.has(name);
	}

	// Destructured params get a hidden #param$<i> local; returns var_decl stmts to bind the real names.
	declareParams(params: JS.Param<Type>[], wtypes: WasmType[]): JS.Statement<Type>[] {
		const pending: JS.Statement<Type>[] = [];
		params.forEach((p, i) => {
			if (typeof p.key === 'string') {
				this.declareValue(p.key, wtypes[i], p.typeAnnotation!);
			} else {
				const tmpName = `#param$${i}`;
				this.declareValue(tmpName, wtypes[i], p.typeAnnotation!);
				pending.push(...patternBindings(p.key, { type: 'identifier', name: tmpName }));
			}
		});
		return pending;
	}

	lookup(name: string): Local {
		const local = this.locals.get(name);
		if (!local)
			throw new Error(`towasm: unresolved identifier '${name}' (only locals/params are supported)`);
		return local;
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

// null parses as a literal; undefined is a real identifier -- both need ref.null with a heap type.
function isNullLiteral(e: Expr): boolean {
	return (e.type === 'literal' && e.value === null) || (e.type === 'identifier' && e.name === 'undefined');
}

// For error messages only.
function describeBinding(t: BindingTarget): string {
	return typeof t === 'string' ? t : t.type === 'array_pattern' ? '[...]' : '{...}';
}

// Desugars a destructuring BindingTarget into flat var_decls reading off valueExpr (must be side-effect-free).
function patternBindings(target: BindingTarget, valueExpr: Expr): JS.Statement<Type>[] {
	if (typeof target === 'string')
		return [JS.VarDecl('const', JS.Var(target, valueExpr))];

	if (target.type === 'array_pattern') {
		if (target.rest)
			throw new Error("towasm: a rest element ('...') in a destructuring pattern is not supported");
		return target.elements.flatMap((el, i) => {
			if (!el)
				return [];
			if (el.default)
				throw new Error('towasm: a default value in a destructuring pattern is not supported');
			return patternBindings(el.target, JS.Index(valueExpr, Literal(i)));
		});
	}

	if (target.rest)
		throw new Error("towasm: a rest property ('...') in a destructuring pattern is not supported");
	return target.properties.flatMap(prop => {
		if (prop.default)
			throw new Error('towasm: a default value in a destructuring pattern is not supported');
		return patternBindings(prop.value, JS.Member(valueExpr, prop.key));
	});
}

// ===================================================================
//  Closures -- free-variable analysis
// ===================================================================

function paramNames(params: JS.Param<Type>[]): string[] {
	return params.flatMap(p => T.bindingNames(p.key));
}

// Every name body binds directly (own params + var_decls), not descending into nested arrow/function bodies.
function ownBoundNames(names: string[], body: Statement[] | Expr, selfName?: string): Set<string> {
	const bound = new Set(names);
	if (selfName)
		bound.add(selfName);
	walkB(body as JS.Statement<any>[] | Expr,
		(s, process) => {
			if (s.type === 'var_decl') {
				for (const d of s.declarations)
					T.bindingNames(d.name).forEach(n => bound.add(n));
			}
			return process(s);
		},
		(e, process) => (e.type === 'arrow' || e.type === 'function') ? false : process(e)
	);
	return bound;
}

// Recursively collects free variables into `free`. A nested closure's bound names merge into `bound`
// before recursing, so a level-2 capture of a level-0 variable transitively appears in level-1's set.
function collectFreeVars(bound: Set<string>, body: Statement[] | Expr, free: Set<string>) {
	walkB(body as JS.Statement<any>[] | Expr,
		(s, process) => process(s),
		(e, process) => {
			if (e.type === 'identifier') {
				if (!bound.has(e.name))
					free.add(e.name);
				return false;
			}
			if (e.type === 'this') {
				if (!bound.has('this'))
					free.add('this');
				return false;
			}
			if (e.type === 'arrow' || e.type === 'function') {
				const nestedBody = e.body ?? [];
				collectFreeVars(new Set([...bound, ...ownBoundNames(paramNames(e.params), nestedBody, e.type === 'function' ? e.name : undefined)]), nestedBody, free);
				return false;
			}
			return process(e);
		}
	);
}

// The WasmType a name has in ctx -- real local or closureEnv field.
function resolvedWtype(ctx: FuncCtx, name: string): WasmType {
	return ctx.closureEnv?.fields.get(name)?.wtype ?? ctx.lookup(name).wtype;
}


// The wasmElement kind for a T[]/Array<T>/ReadonlyArray<T> element type.
function arrayElemKind(elemType: Type, global: Scope): 'f64' | 'i32' | 'u32' | 'ref' | undefined {
	const we = wasmTypeOf(elemType, global);
	return we === 'i32' || we === 'f64' || we === 'u32' ? we : 'ref';
}

// Picks the tightest integer wasm type for a known range: i32, u32, or f64.
function intWasmType(min: number, max: number): WasmType {
	if (min >= -0x80000000 && max <= 0x7fffffff)
		return 'i32';
	if (min >= 0 && max <= 0xffffffff)
		return 'u32';
	return 'f64';
}

// Checks builtinTypes before T.resolve to avoid expanding a hoisted class name and losing it.
function wasmTypeOf(t: Type, global: Scope): WasmType | undefined {
	if (t.type === 'ref' && !t.typeArgs && t.name in builtinTypes)
		return builtinTypes[t.name].wtype;
	if (t.type === 'range' && t.base === 'number')
		return t.integer && t.min !== undefined && t.max !== undefined ? intWasmType(t.min as number, t.max as number) : 'f64';
	// rangeToType collapses a single-value range to a Literal -- needs the same bounds check or it widens to f64.
	if (t.type === 'literal' && typeof t.value === 'number')
		return Number.isInteger(t.value) ? intWasmType(t.value, t.value) : 'f64';

	// Resolve each union member first so alias duplicates collapse before arrayElemKind.
	const w = T.widenLiterals(t.type === 'union' ? T.combineTypes(t.types.map(m => T.resolve(global, m))) : T.resolve(global, t));
	if (w.type === 'array') {
		const we = arrayElemKind(w.element, global);
		return we ? ARR_WTYPE[we] : undefined;
	}

	if (w.type === 'ref') {
		switch (w.name) {
			case 'Array':
			case 'ReadonlyArray': {
				const we = arrayElemKind(w.typeArgs![0], global);
				return we ? ARR_WTYPE[we] : undefined;
			}
		}
		return builtinTypes[w.name]?.wtype;
	}

	return undefined;
}

// Stable structural key for memoizing closure-type registration by TS function signature.
function wasmTypeKey(w: WasmType): string {
	if (typeof w === 'string')
		return w;
	if ('ref' in w)
		return `ref:${w.ref}:${!!w.nullable}`;
	if ('arr' in w)
		return `arr:${w.arr}:${!!w.nullable}`;
	if ('closure' in w)
		return `(${w.closure.params.map(wasmTypeKey).join(',')})=>${wasmTypeKey(w.closure.result)}:${!!w.nullable}`;
	if ('typeIndex' in w)
		return `typeIndex:${w.typeIndex}:${!!w.nullable}`;
	return '?';
}

// All four numeric wasm types, in "widen to me first" preference order when an operand's own type has no
// real instruction -- f64 first, since widening i32/i64/f32 up to it is exact or an already-accepted tradeoff.
const NUMERIC_TYPES = ['f64', 'f32', 'i64', 'i32'] as const;
type NumericType = typeof NUMERIC_TYPES[number];

// WatInstr and wasm.Instr only differ on block/loop/if -- none of which flat inline-asm can contain.
function assertFlatInstrs(instrs: WAT.WatInstr[], asm: string): wasm.Instr[] {
	return instrs.map(i => {
		if (i.op === 'block' || i.op === 'loop' || i.op === 'if')
			throw new Error(`inline asm '${asm}': '${i.op}' (control flow) is not supported in inline asm`);
		if (i.op === '__switch')
			throw new Error(`inline asm '${asm}': switch '${i.key}' is unresolved -- not a ctx.defines entry, and inline asm has no enclosing macro call to bind it to a $tag argument`);
		// A `$T.<suffix>` reference with no enclosing `(switch $T ...)` to declare its supported types
		// (`WAT.isTypeGeneric` said so, or `instantiateAsmBody` should already have substituted it away) --
		// either way a real authoring error, not a type this body happens to support.
		if (i.op === 'local.get' && typeof i.localIndex === 'string' && i.localIndex.startsWith('$T.'))
			throw new Error(`inline asm '${asm}': '${i.localIndex}' needs an enclosing '(switch $T ...)' declaring which types it's for`);
		return i;
	});
}

function isAsm(e?: Expr) {
	return e?.type === 'call' && e.callee.type === 'identifier' && e.callee.name === '__asm';
}

function makeAsmBuiltin(key: string, value: Expr | undefined, builtin: string, index: number, elemKind?: wasmElement, elemDefine?: TypedArrayTag): Builtin<Inline> | undefined {
	try {
		const	call	= value as JS.Call<Type>;
		let		asm		= (call.arguments[0] as Literal<string | JS.TemplatePart<Expr>[]>).value;

		if (typeof asm !== 'string') {
			if (Array.isArray(asm)) {
				if (asm.some(p => p.exp !== undefined))
					throw new Error('inline asm: template-literal interpolation is not supported, only a plain static string');
				asm = asm.map(p => p.str).join('');
			} else {
				throw new Error('inline asm: expected a string literal');
			}
		}

		const parsed = WAT.parseAsmBody(asm, elemDefine ? {'this': index, elem: elemDefine} : {'this': index});

		// A param/result type that isn't a plain wasm-level primitive is either this owner's own array type
		// (`T[]`, e.g. `Array<T>.alloc`'s result) or a single element of it (bare `T`, e.g. `Array<T>.get`'s
		// result) -- `elemKind` (the real `wasmElement` this owner's *physical storage* was built under) is
		// authoritative for both, and deliberately checked *before* the literal-name switch below: `T`
		// substituting to a real TS name like `string` (`Array<string>`) doesn't mean the element is
		// physically a `{arr:'i16'}` string value -- every non-scalar element kind is physically boxed as
		// `{ref:'any'}` (this compiler's one generic-ref array type), regardless of what name `T` reads as.
		// Trusting the literal name here for a bare `T` (as this used to) leaves the asm's declared result
		// type narrower than what `array.get`/`array.set` actually produce/expect at the wasm level -- found
		// via a real `array.get`-returns-anyref-but-local expects-a-concrete-ref wasm validation failure.
		const resolveType = (t: Type): WasmType | undefined => {
			if (t.type === 'ref') {
				switch (t.name) {
					case 'i32': case 'i64': case 'f32': case 'f64': case 'u32': return t.name;
					case 'void': return 'void';
				}
			}
			if (elemKind !== undefined)
				return t.type === 'array' ? ARR_WTYPE[elemKind] : elemKind === 'i16' ? ARR_WTYPE.i16 : elemKind === 'ref' ? { ref: 'any' } : elemKind;

			if (t.type === 'ref') {
				switch (t.name) {
					case 'number':	return 'f64';
					case 'boolean':	return 'i32';
					case 'string':	return ARR_WTYPE.i16;
				}
			}
			return undefined;
		};

		// Resolves named scratch locals in an asm body to real function-local indices via ctx.local.
		const resolveAsmLocals = (instrs: wasm.Instr[], locals: WAT.WatLocal[], ctx: FuncCtx, asm: string): wasm.Instr[] => {
			if (!locals.length)
				return instrs;
			const indices = new Map(locals.map(l => {
				if (!l.id)
					throw new Error(`inline asm '${asm}': an anonymous local can't be referenced by name`);
				if (l.type === 'i32' || l.type === 'i64' || l.type === 'f32' || l.type === 'f64')
					return [l.id, ctx.local(l.id, l.type)];
				throw new Error(`inline asm '${asm}': unsupported local type '${JSON.stringify(l.type)}'`);
			}));
			return instrs.map(i => {
				if ('localIndex' in i && typeof i.localIndex === 'string') {
					const index = indices.get(i.localIndex);
					if (index === undefined)
						throw new Error(`inline asm '${asm}': undeclared local '${i.localIndex}'`);
					return { ...i, localIndex: index };
				}
				return i;
			});
		};

		if (!WAT.isTypeGeneric(parsed)) {
			const body = {
				locals: parsed.locals.map(l => {
					if (typeof l.type === 'object' && 'typeParam' in l.type)
						throw new Error(`inline asm '${asm}': '(local ${l.id ?? ''} $${l.type.typeParam})' needs a '$T'-generic asm`);
					return { id: l.id, count: l.count, type: l.type };
				}),
				body: assertFlatInstrs(parsed.body, asm)
			};
			const [paramsTuple, resultType] = call.typeArgs ?? [];
			const params = paramsTuple?.type === 'tuple' ? paramsTuple.elements.map(te => {
				const wt = T.tupleElementType(te) && resolveType(T.tupleElementType(te)!);
				if (!wt)
					throw new Error(`unsupported inline-asm param type '${JSON.stringify(te)}'`);
				return wt;
			}) : [];
			const result = resultType ? resolveType(resultType) : 'void';
			if (!result)
				throw new Error(`unsupported inline-asm result type '${JSON.stringify(resultType)}'`);
			return (_args, ctx) => ({ params, result, inline: resolveAsmLocals(body.body, body.locals, ctx, asm) });
		}

		const arms = parsed.body.find((i): i is WAT.SwitchPlaceholder => i.op === '__switch' && i.key === '$T')!.arms;
		const variants: Partial<Record<NumericType, { locals: WAT.WatLocal[]; body: wasm.Instr[] }>> = {};

		for (const t of new Set(arms.flatMap(a => a.values).filter(a => typeof a === 'string').map(a => a.slice(1) as NumericType))) {
			const inst = WAT.instantiateAsmBody(parsed, t);
			if (!inst)
				throw new Error(`inline asm '${asm}': switch arm '(${arms.find(a => a.values.includes(`$${t}`))!.values.join(' ')})' claims '${t}' but its own body doesn't resolve for it`);
			variants[t] = { locals: inst.locals, body: assertFlatInstrs(inst.body, asm) };
		}
		if (!Object.keys(variants).length)
			throw new Error(`inline asm '${asm}': switch '$T' has no arms`);

		const paramCount = call.typeArgs?.[0]?.type === 'tuple' ? call.typeArgs[0].elements.length : 0;

		return (args, ctx) => {
			// The operand's own type already has a direct variant, shared by every operand -- no conversion needed (e.g. an `f32` reaching `Math.sqrt` gets `f32.sqrt`, not widened to f64).
			let t = args[0]?.wtype;
			// No asm arm is ever written for `u32` (it's not a real wasm value type falls through to the generic widen-to-`NUMERIC_TYPES` path below like any other type without a direct variant
			if (!(typeof t === 'string' && t !== 'void' && t !== 'u32' && args.length === paramCount && args.every(a => a.wtype === t))) {
				// Otherwise (including the empty-args probe call) widen to whichever supported type comes first in `NUMERIC_TYPES`
				// -- declaring that as `params` is what makes the caller's own `emitAs` emit the real conversion; this only ever picks the target type, never converts itself.
				t = NUMERIC_TYPES.find(nt => variants[nt]);
				if (!t)
					throw new Error(`towasm: '${builtin}.${key}': no numeric type supports this operation`);
			}
			const parsed = variants[t]!;
			return { params: Array(paramCount).fill(t), result: t, inline: resolveAsmLocals(parsed.body, parsed.locals, ctx, asm) };
		};
	} catch (e) {
		console.warn(`towasm: skipping inline asm '${builtin}.${key}': ${(e as Error).message}`);
		return undefined;
	}
}

// A `get`/`set` accessor's `methodDecls`/`inlineMethods`/`funcs` key -- mangled apart from a plain same-
// named method (real TS never allows both on one class anyway) so a getter and a setter for the same
// property name can coexist as two distinct entries instead of overwriting each other in the same map.
function accessorKey(kind: 'get' | 'set', name: string): string {
	return `${kind}:${name}`;
}

// Two shapes recognize as the same kind of intrinsic: a field whose value directly `__asm(...)`s, or a
// static-method-with-its-own-`<T>` wrapper (see `asmMethodBody`) -- `asmMethodKeys` marks the latter so
// the caller can exclude it from `methodDecls`, same as a field never appears there either. Shared by
// `builtinOwner` (Array/String/Number/Boolean/BigInt/Math) and `ensureClass` (any other class, e.g.
// `lib/typedarray.ts`'s `Uint8Array.get`/`set` -- see that file's own header comment) -- an ordinary class
// gets exactly the same "a method whose one statement forwards straight to `__asm`" intrinsic support any
// builtin already had, not a typed-array-specific mechanism.
function scanInlineMethods(decl: TS.Class, builtin: string, index: number, elemKind?: wasmElement, elemDefine?: TypedArrayTag) {
	const inlineDecls: { key: string; value: Expr }[] = [];
	const asmMethodKeys = new Set<string>();
	for (const m of decl.body) {
		if (m.type === 'field' && typeof m.key === 'string' && isAsm(m.value)) {
			inlineDecls.push({ key: m.key, value: m.value! });
		} else if ((m.type === 'method' || m.type === 'get' || m.type === 'set') && typeof m.key === 'string') {
			if (m.body?.length !== 1)
				continue;
			const stmt = m.body[0];
			if (stmt.type !== 'return' || !stmt.argument || stmt.argument.type !== 'call')
				continue;
			const outer = stmt.argument;
			if (!isAsm(outer.callee))
				continue;
			const paramNames = m.params.map(p => typeof p.key === 'string' ? p.key : undefined);
			const argNames = outer.arguments.map(a => a.type === 'identifier' ? a.name : undefined);
			if (paramNames.length === argNames.length && paramNames.every((p, i) => p !== undefined && p === argNames[i])) {
				// A getter/setter is keyed apart from an ordinary same-named method (`accessorKey('get',x)`
				// vs plain `x`) -- `ensureClass`/`case 'member'`/`emitAssignTarget` all look it up the same
				// mangled way, so a getter and a setter for the same property name can coexist, and a
				// getter is never mistaken for a zero-arg *method* named the same as some other member.
				const key = m.type === 'get' || m.type === 'set' ? accessorKey(m.type, m.key) : m.key;
				inlineDecls.push({ key, value: outer.callee });
				asmMethodKeys.add(key);
			}
		}
	}

	const inlineMethods = new Map<string, Builtin<Inline>>();
	for (const i of inlineDecls) {
		const builtinFn = makeAsmBuiltin(i.key, i.value, builtin, index, elemKind, elemDefine);
		if (builtinFn)
			inlineMethods.set(i.key, builtinFn);
	}
	return { inlineMethods, asmMethodKeys };
}

// Substitutes a generic class's own single type parameter (`PARAM`) for `subs` throughout its decl --
// shared by `builtinOwner` (Array/etc's hand-enumerated instantiations) and `ensureClass`'s general
// generic-class support. `thisTsType`, when given, additionally substitutes a `T[]`-shaped member type for
// the *whole* instantiation's own type -- specific to `Array<T>`'s own physical shape (it *is* a `T[]`, so
// e.g. `alloc<T>(n): T[]` means "this instantiation itself"), not a general generic-class concern, so
// ordinary callers simply omit it.
function substituteClassTypeParam(decl: JS.ClassDecl<Type>, PARAM: string, subs: Type, thisTsType?: Type): JS.ClassDecl<Type> {
	return walk(decl, undefined, undefined, (t, process) =>
		thisTsType !== undefined && t.type === 'array' && t.element.type === 'ref' && t.element.name === PARAM	? thisTsType
		: t.type === 'ref' && t.name === PARAM																	? subs
		: process(t)
	)!;
}

function builtinOwner(name: string, thisTsType: Type, builtin: string, subs?: Type, index = -1, elemKind?: wasmElement): MethodOwner | undefined {
	let decl = LIB_DECL_MAP.get(builtin);
	if (!decl || decl.type !== 'class_decl')
		return;

	if (subs) {
		const PARAM = decl.typeParams?.[0]?.name;
		if (PARAM)
			decl = substituteClassTypeParam(decl, PARAM, subs, thisTsType);
	}
	const { inlineMethods, asmMethodKeys } = scanInlineMethods(decl, builtin, index, elemKind);

	const methodDecls = decl.body.filter(m => m.type === 'method' && typeof m.key === 'string' && !asmMethodKeys.has(m.key)) as MethodMember[];
	return { name, decl, thisTsType, typeIndex: index,
		methodDecls:	new Map(methodDecls.map(m => [m.key as string, m])),
		inlineMethods,
	};
}
const builtinOwners = {
	f64:	builtinOwner('Number', T.NUMBER,	'Number'),
	i32:	builtinOwner('Boolean', T.BOOLEAN,	'Boolean'),
};
// A placeholder `MethodOwner` for a slot whose only real remaining purpose is its physical `typeIndex`
// (see `builtinArrayOwners` below) -- `decl`/`thisTsType`/`methodDecls` are never actually consulted for
// these, `Array<T>`'s own real generic instantiation (`ensureClass('Array', typeArgs)`) supplies those now.
function placeholderArrayTypeIndex(index: number): MethodOwner {
	return { name: `#array$${index}`, decl: LIB_DECL_MAP.get('Array') as JS.ClassDecl<Type>, thisTsType: T.UNKNOWN, typeIndex: index, methodDecls: new Map() };
}
const builtinArrayOwners: Record<wasmElement, MethodOwner> = {
	// `String`'s own instantiation no longer builds a `MethodOwner` here either (see `i32` etc below) --
	// it's a real (non-generic) `ensureClass('String')` instantiation now, see its own `thisWtype`.
	i16:	placeholderArrayTypeIndex(0),
	// `Array<T>`'s own instantiations no longer build a `MethodOwner` here -- they're real generic
	// instantiations now (`ensureClass('Array', typeArgs)`, see its own `thisWtype`), sharing these same
	// physical wasm-GC array typeIndices (registered once, in the loop further down, by iteration order --
	// these numbers must stay in sync with that order) rather than each getting a redundant, separately-
	// hand-built `MethodOwner` the way they used to.
	i32:	placeholderArrayTypeIndex(1),
	i64:	placeholderArrayTypeIndex(2),
	f32:	placeholderArrayTypeIndex(3),
	f64:	placeholderArrayTypeIndex(4),
	ref:	placeholderArrayTypeIndex(5),
	u32:	placeholderArrayTypeIndex(6),
} as const;

// `Uint8Array`/`Int32Array`/`Uint32Array` are real views over linear memory (an `ArrayBuffer`), not GC
// arrays -- unlike every other array kind above, so they don't go through `builtinArrayOwners`'s
// `Array<T>`-monomorphization/asm-template machinery at all. They're real classes declared in
// `lib/typedarray.ts` (fields, `get`/`set`, and the non-callback `Array<T>` methods they'd otherwise have
// lost), resolved through the ordinary `ensureClass`/`plainLibClassNames` path -- see `TYPED_ARRAY_ALIASES`
// for how `Int32Array`/`Uint32Array` get their own struct from `Uint8Array`'s one canonical declaration.
const builtinTypes: Record<string, { wtype: WasmType; owner?: MethodOwner }> = {
	void:		{ wtype: 'void' },
	boolean:	{ wtype: 'i32', 			owner: builtinOwners.i32 },
	Boolean:	{ wtype: 'i32', 			owner: builtinOwners.i32 },
	number:		{ wtype: 'f64', 			owner: builtinOwners.f64 },
	Number:		{ wtype: 'f64', 			owner: builtinOwners.f64 },
	// No `.owner` here (unlike `boolean`/`number`/`bigint`/etc just above) -- `String` is a real
	// `ensureClass`-resolved instantiation now, not a module-level `builtinOwner` one, so it can't be built
	// until `TStoWasm` actually runs; `ownerFor`'s own fast path resolves it dynamically instead (see there).
	string:		{ wtype: ARR_WTYPE.i16 },
	String:		{ wtype: ARR_WTYPE.i16 },
	bigint:		{ wtype: ARR_WTYPE.u32,	owner: builtinOwner('BigInt', T.BIGINT, 'BigInt') },
	Math:		{ wtype: 'void',			owner: builtinOwner('Math', T.VOID, 'Math') },
	// Pseudo-types from `lib.d.ts` (`declare type i32 = number`, etc) -- real wasm value types, used to
	// declare a class field/method whose actual storage isn't the usual `number`->`f64`/etc mapping (see
	// `lib/typedarray.ts`'s `Uint8Array.get`/`set`/its own fields). Matched here, ahead of `T.resolve`'s
	// alias-unwrapping (`wasmTypeOf`'s very first check), the same way any other builtin name is.
	i32: { wtype: 'i32' }, i64: { wtype: 'i64' }, f32: { wtype: 'f32' }, f64: { wtype: 'f64' }, u32: { wtype: 'u32' },
};

// `Int32Array`/`Uint32Array` are real classes too, but not authored twice -- they're `Uint8Array`'s own
// declaration (`lib/typedarray.ts`), name-substituted (`ensureClass`), same "one canonical declaration,
// N physical instantiations" idea `builtinOwner`'s own `subs` substitution already uses for `Array<T>`,
// just keyed off a literal name instead of a generic type parameter (there's neither a real generic here
// nor a shared struct type -- each gets its own, identically-shaped one). `elem` is the one thing `get`/
// `set` themselves can't get from name substitution (it picks a real instruction sequence, not a type) --
// passed down as one more `WAT.parseAsmBody` `defines` entry alongside `this` (see `makeAsmBuiltin`), the
// same per-instantiation-constant mechanism `$this` already uses, so `lib/typedarray.ts`'s `get`/`set`
// asm text needs no per-kind copy at all (see its own header comment).
type TypedArrayTag = 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'i64' | 'u64' | 'f32' | 'f64';
const TYPED_ARRAY_ALIASES: Record<string, { canonical: string, elem: TypedArrayTag; elemSize: number }> = {
	Int8Array:			{ canonical: 'Uint8Array', elem: 'u8', elemSize: 1 },
	Uint8Array:			{ canonical: 'Uint8Array', elem: 'u8', elemSize: 1 },
	Uint8ClampedArray:	{ canonical: 'Uint8Array', elem: 'u8', elemSize: 1 },
	Int16Array:			{ canonical: 'Uint8Array', elem: 'u16', elemSize: 2 },
	Uint16Array:		{ canonical: 'Uint8Array', elem: 'u16', elemSize: 2 },
	Int32Array:			{ canonical: 'Uint8Array', elem: 'i32', elemSize: 4 },
	Uint32Array:		{ canonical: 'Uint8Array', elem: 'u32', elemSize: 4 },
	Float32Array:		{ canonical: 'Uint8Array', elem: 'f32', elemSize: 4 },
	Float64Array:		{ canonical: 'Uint8Array', elem: 'f64', elemSize: 4 },
	BigInt64Array:		{ canonical: 'Uint8Array', elem: 'i64', elemSize: 8 },
	BigUint64Array:		{ canonical: 'Uint8Array', elem: 'u64', elemSize: 8 },

};

// A plain lib-internal class not already one of the scalar/string builtins above.
const plainLibClassNames = {
	has: (name: string) => !(name in builtinTypes)
		&& (LIB_DECL_MAP.get(name)?.type === 'class_decl' || name in TYPED_ARRAY_ALIASES),
};

// The wasm numeric type a 2-operand op should run in -- widened across *both* operands, not just the
// left one. Picking off `args[0]` alone (the previous behaviour) let an i32-typed left operand (e.g. the
// integer literal `1`) force the whole op into i32, silently truncating a genuinely fractional right
// operand (`1 + someFloat`, `1 < someFloat`) down to an integer before the op ever ran -- real JS `number`
// arithmetic is always double-precision, so i32 is only a safe fast path when *every* operand is one.
function numericPairWtype(a: OperandInfo, b: OperandInfo): 'i32' | 'i64' | 'f64' {
	if (a.wtype === 'i64' || b.wtype === 'i64')
		return 'i64';
	if (a.wtype === 'i32' && b.wtype === 'i32')
		return 'i32';
	return 'f64';
}

// bigint/string equality checked by owner, not physical shape -- {arr:'i16'} could mean something else later.
// string checked by name (fresh ensureClass per compile); bigint by identity (stable module-level object).
function equalityInline(args: OperandInfo[], negate: boolean): Inline | MethodDelegate {
	if (args[0].owner === builtinTypes.bigint.owner)
		return { owner: builtinTypes.bigint.owner!, method: negate ? 'ne' : 'eq' };
	if (args[0].owner?.name === 'String')
		throw new Error("towasm: string equality (by value) is not supported in this pass -- only reference types (arrays/Uint8Array/class instances) support '=='/'==='");
	const t = args[0].wtype;
	if (t && typeof t !== 'string')
		return { params: [t, t], result: 'i32', inline: negate ? [I.ref.eq, I.i32.eqz] : [I.ref.eq] };
	return numericPairWtype(args[0], args[1]) === 'i32'
		? { params: ['i32', 'i32'], result: 'i32', inline: [negate ? I.i32.ne : I.i32.eq] }
		: { params: ['f64', 'f64'], result: 'i32', inline: [negate ? I.f64.ne : I.f64.eq] };
}

function arithInline(args: OperandInfo[], f64instr: wasm.Instr[], i32instr: wasm.Instr[], i64instr: wasm.Instr[], boolResult: boolean): Inline {
	const t = numericPairWtype(args[0], args[1]);
	return t === 'i32'
		? { params: ['i32', 'i32'], result: 'i32', inline: i32instr }
		: t === 'i64'
		? { params: ['i64', 'i64'], result: boolResult ? 'i32' : 'i64', inline: i64instr }
		: { params: ['f64', 'f64'], result: boolResult ? 'i32' : 'f64', inline: f64instr };
}
function arithInline1(args: OperandInfo[], f64instr: wasm.Instr[], i32instr: wasm.Instr[], i64instr: wasm.Instr[]): Inline {
	return args[0].wtype === 'i32'
		? { params: ['i32'], result: 'i32', inline: i32instr }
		: args[0].wtype === 'i64'
		? { params: ['i64'], result: 'i64', inline: i64instr }
		: { params: ['f64'], result: 'f64', inline: f64instr };
}

// Per-operand info for builtin dispatch -- wtype for kind-polymorphic dispatch, owner for identity dispatch.
interface OperandInfo { wtype: WasmType | undefined; owner: MethodOwner | undefined }

function bigintAware(method: string, fallback: (args: OperandInfo[], ctx: FuncCtx) => Inline | MethodDelegate | FunctionDecl): Builtin {
	return (args, ctx) => args[0].owner === builtinTypes.bigint.owner ? { owner: builtinTypes.bigint.owner!, method } : fallback(args, ctx);
}

// Looks up a top-level const X = __asm<P,R>('...') entry by name and resolves it eagerly.
function libAsmBuiltin(name: string): Builtin<Inline> {
	const info = LIB_DECL_MAP.get(name);
	if (info?.type !== 'var_decl' || !isAsm(info.init))
		throw new Error(`towasm: internal: '${name}' isn't defined as inline asm in towasm-lib.ts`);
	const builtin = makeAsmBuiltin(name, info.init, name, -1);
	if (!builtin)
		throw new Error(`towasm: internal: inline asm '${name}' failed to resolve`);
	return builtin;
}

// Every entry is a real callable -- a plain lib function (`bigFromNumber` etc) hands back its own
// `FunctionDecl`, not a raw decl value; callers discriminate the return shape (see `emitCall`).
// `Math.abs`/`Array.alloc`/etc aren't listed here -- they're registered into each owner's own
// `inlineMethods` by `builtinOwner` instead (see `makeAsmBuiltin`).
const builtins: Record<string, Builtin> = {
	// Unary `-` on a `bigint` would delegate to a `BigInt.neg` method, mirroring `<`/`>`/etc's `bigintAware`
	// wrapping -- no such method exists yet (`BigInt` is unsigned-only), so this throws a clear "unknown
	// method 'neg'" instead of a confusing WasmType-coercion error.
	// `i32`/`i64`'s own `inline` here is never actually used -- `emitExpr`'s `'unary'` case special-cases
	// `-` on an integer type, emitting a real `0 - operand` (the zero spliced in *before* the already-
	// emitted operand, via `swapOut`) instead of appending trailing instructions after it, since a plain
	// trailing `[const(0), sub]` would compute `operand - 0`, not `0 - operand`. `f64.neg` is a true
	// unary op with no such ordering issue, so it's unaffected.
	'prefix-':	bigintAware('neg', args => arithInline1(args, [I.f64.neg], [], [])),
	'prefix+':	() => ({params: ['f64'], result: 'f64', inline: []}),
	'prefix!':	() => ({params: ['i32'], result: 'i32', inline: [I.i32.eqz]}),
	'prefix~':	() => ({params: ['i32'], result: 'i32', inline: [I.i32.const(-1), I.i32.xor]}),

	// `+`'s own dispatch, not `arithInline` directly -- `bigint`/`string` operands delegate to their own
	// `add`/`concat` method (checked by owner -- see `equalityInline`'s comment on why `string` is checked
	// by name, `bigint` by identity). `args[0].owner` itself (not a `builtinTypes` lookup) is already the
	// right, current owner to delegate to.
	'+':	bigintAware('add', args => {
		if (args[0].owner?.name === 'String')
			return { owner: args[0].owner!, method: 'concat' };
		return arithInline(args, [I.f64.add], [I.i32.add], [I.i64.add], false);
	}),
	'-':	bigintAware('sub', args => arithInline(args, [I.f64.sub], [I.i32.sub], [I.i64.sub], false)),
	'*':	bigintAware('mul', args => arithInline(args, [I.f64.mul], [I.i32.mul], [I.i64.mul], false)),
	// Not `arithInline` -- unlike `+`/`-`/`*`, `i32.div_s` doesn't just risk overflow on in-range integer
	// operands, it's flatly the wrong operation for real JS `number` division (truncating, and traps on a
	// zero divisor instead of giving `NaN`/`Infinity`). `number` division is always float division, full stop.
	'/':	bigintAware('div', () => ({ params: ['f64', 'f64'], result: 'f64', inline: [I.f64.div] })),
	// Not `arithInline` -- `__towasm_mod` is itself a `$T`-generic asm builtin, dispatching i32/i64's native
	// `rem_s` vs float's long-hand `x - trunc(x/y)*y` internally, so it needs no per-kind arrays here.
	'%':	bigintAware('mod', libAsmBuiltin('__towasm_mod')),
	'<':	bigintAware('lt', args => arithInline(args, [I.f64.lt], [I.i32.lt_s], [I.i64.lt_s], true)),
	'>':	bigintAware('gt', args => arithInline(args, [I.f64.gt], [I.i32.gt_s], [I.i64.gt_s], true)),
	'<=':	bigintAware('le', args => arithInline(args, [I.f64.le], [I.i32.le_s], [I.i64.le_s], true)),
	'>=':	bigintAware('ge', args => arithInline(args, [I.f64.ge], [I.i32.ge_s], [I.i64.ge_s], true)),

	// Bitwise/shift -- always `i32,i32`, same reasoning. Shift amounts don't need masking mod 32
	// separately -- wasm's own `shl`/`shr_s`/`shr_u` already do that per spec.
	'&':	bigintAware('and', 	() => ({params: ['i32', 'i32'], result: 'i32', inline: [I.i32.and]})),
	'|':	bigintAware('or', 	() => ({params: ['i32', 'i32'], result: 'i32', inline: [I.i32.or]})),
	'^':	bigintAware('xor', 	() => ({params: ['i32', 'i32'], result: 'i32', inline: [I.i32.xor]})),
	'<<':	bigintAware('shl', 	() => ({params: ['i32', 'i32'], result: 'i32', inline: [I.i32.shl]})),
	'>>':	bigintAware('shrs', () => ({params: ['i32', 'i32'], result: 'i32', inline: [I.i32.shr_s]})),
	// `result: 'u32'`, not `'i32'` -- `>>>` is the one JS bitwise op whose result is unsigned by spec
	// (`ToUint32`, never `ToInt32`), so it needs `convert_i32_u` if it's ever widened to `f64`.
	'>>>':	bigintAware('shru', () => ({params: ['i32', 'i32'], result: 'u32', inline: [I.i32.shr_u]})),

	'===':	args => equalityInline(args, false),
	'==':	args => equalityInline(args, false),
	'!==':	args => equalityInline(args, true),
	'!=':	args => equalityInline(args, true),

	...Object.fromEntries(LIB_DECLS.filter(d => d.type === 'function_decl').map(d => [d.name, () => d])),
	...Object.fromEntries(LIB_DECLS.filter(d => d.type === 'var_decl').map(d => {
		if (isAsm(d.init)) {
			const name = d.name as string;
			const builtin = makeAsmBuiltin(name, d.init, name, -1);
			return builtin && [name, builtin] as const;
		}
	}).filter(e => !!e)),

	'console.log':	args => args[0].wtype === 'i32'
						? { params: ['i32'], result: 'void', inline: [I.call(1)] }
						: { params: ['f64'], result: 'void', inline: [I.call(0)] },
};

interface AssignTarget { wtype: WasmType; old?: number; write(tee: boolean): number }

export function TStoWasm(ast: TS.Program): wasm.WasmModule {
	const global = ast.scope as Scope;
	if (!global)
		throw new Error('towasm: ast must be checked (TStypeCheck/TStypeCheckAsync) before TStoWasm');

	// `global` knows nothing about the lib's own internal plain classes (`StringParser`, ...), since
	// `LIB_AST` is compiled separately -- without hoisting them here, a chain like `this.str.charCodeAt(...)`
	// inside `StringParser` would resolve to `any` and this file's `typeOf` couldn't map that to a `WasmType`.
	// `String`/`Number`/`Math` are hoisted despite their own leaner ambient stubs in `type-utils.ts`, since
	// the general checker needs their real methods to resolve return types (e.g. `x.toString()`'s auto-
	// boxing); `Array`/`Boolean` stay excluded since a richer real ambient `Array` already exists and
	// `Boolean` has no lib methods at all.
	const checker			= makeChecker(() => {});
	const libGlobal			= new Scope(global);

	const classes			= new Map<string, ClassInfo>();
	// User-declared *generic* top-level classes -- unlike ordinary (non-generic) ones, these can't be
	// eagerly seeded into `classes` under their bare name (there's no single physical representation for
	// `Box<T>` alone, only for each concrete instantiation `Box<number>`/`Box<boolean>`/etc), so `ensureClass`
	// and `resolveGenericClassRef` (below) look here instead, the user-class equivalent of `LIB_DECL_MAP`.
	const userGenericClassDecls = new Map<string, JS.ClassDecl<Type>>();
	const funcs				= new Map<string, FuncInfo>();
	const closureWasmTypes	= new Map<string, WasmType>();	// The `{closure: FuncSig}` wrapper object itself, memoized per signature
	const resolving			= new Set<string>();			// Classes currently mid-`ensureClass`
	const types: wasm.SubType[] = [];
	const functionDeclByName = new Map<string, FunctionDecl>();
	const worklist: (()=>void)[] = [];
	// Every closure literal reached during compilation, in discovery order -- unlike `funcs`/`classes` these
	// have no name to key a map by, so a flat array plus the final-assembly placement loop is simplest.
	const closureLiterals: FuncInfo[] = [];
	const closureTypes		= new Map<string, ClosureTypeInfo>();
	let data				= new Uint8Array(0);
	const strings			= new Map<string, number>;
	// `ArrayBuffer`/typed-array views' backing store -- a bump-allocated linear memory, lazily declared
	// (`ensureMemory`) only if the program actually allocates one; unlike every other heap value here
	// (a real wasm-GC object), this memory is never collected -- fine for what this compiler targets
	// (whole-program batch runs), not a general-purpose allocator.
	const globals: NonNullable<wasm.WasmModule['globals']> = [];
	let heapPtrGlobal = -1;

	let forTempCounter			= 0;
	let destructureTempCounter	= 0;
	let optionalTempCounter 	= 0;
	let closureCallTempCounter	= 0;
	let switchTempCounter		= 0;
	let nextFunc				= 0;
	let envBaseTypeIndex: number | undefined;

	function registerType(type: wasm.SubType) {
		const typeIndex = types.length;
		types.push(type);
		return typeIndex;
	}

	function ensureMemory(): number {
		if (heapPtrGlobal === -1)
			heapPtrGlobal = globals.push({ type: { type: 'i32', mut: true }, init: [I.i32.const(0)] }) - 1;
		return heapPtrGlobal;
	}

	// Bump-allocates `pushSize()` bytes of zero-initialized linear memory, leaving the new allocation's
	// own byte offset on the stack. `memory.grow`'s freshly-grown pages are zero per the wasm spec, and
	// this never reuses a byte once handed out, so every allocation is zero-initialized for free, same
	// guarantee real JS gives `new ArrayBuffer(n)`/`new Uint8Array(n)`.
	function emitAlloc(ctx: FuncCtx, pushSize: () => void): void {
		const heap = ensureMemory();
		const size = ctx.local('$allocSize', 'i32');
		const ret  = ctx.local('$allocRet', 'i32');
		pushSize();
		ctx.emit(
			I.local.set(size),
			I.global.get(heap), I.local.set(ret),
			I.local.get(ret), I.local.get(size), I.i32.add, I.global.set(heap),
			// Grow by just enough whole pages (64KiB) to cover the new heap pointer, if it now exceeds
			// the memory's current size.
			I.global.get(heap), I.memory.size(0), I.i32.const(16), I.i32.shl, I.i32.gt_u,
			I.if(undefined, [
				I.global.get(heap), I.memory.size(0), I.i32.const(16), I.i32.shl, I.i32.sub,
				I.i32.const(65535), I.i32.add, I.i32.const(16), I.i32.shr_u,
				I.memory.grow(0), I.drop,
			]),
			I.local.get(ret),
		);
	}

	// `{ref: name}`, not `{typeIndex: N}` -- `wasmTypeEq`'s `ref` branch compares `.ref` by string, so a
	// fresh `{ref: name}` object always compares equal to `typeOf`'s own (independently constructed)
	// `{ref: name}` for the same class; a `{typeIndex}` never does (`wasmTypeEq` never unifies the two
	// variants), which is what broke coercion between a value built here and the same class read back
	// through the ordinary checker-driven path. `ctx.local`/`ctx.declareValue` separately compare a
	// repeat declaration's `WasmType` by reference (`!==`), not `wasmTypeEq` -- a fresh literal at each
	// call site would trip that the moment a class-typed scratch local (`$taBuf`, ...) gets reused across
	// two constructions in one function, so this same singleton is also what keeps those referentially
	// stable.
	const classWtypeCache = new Map<string, WasmType>();
	function classWtype(name: string): WasmType {
		let w = classWtypeCache.get(name);
		if (!w)
			classWtypeCache.set(name, w = { ref: name });
		return w;
	}

	// Allocates a fresh `ArrayBuffer` of `pushByteLen()` bytes, leaving its ref on the stack. Field order
	// (`offset`, `byteLength`) comes straight from `lib/typedarray.ts`'s own declared field order --
	// `ensureClass`, not a hardcoded index, same as every other class field in this file.
	function emitNewArrayBufferOfSize(ctx: FuncCtx, pushByteLen: () => void): void {
		const byteLen = ctx.local('$abLen', 'i32');
		pushByteLen();
		ctx.emit(I.local.set(byteLen));
		emitAlloc(ctx, () => ctx.emit(I.local.get(byteLen)));
		ctx.emit(I.local.get(byteLen), I.struct.new(ensureClass('ArrayBuffer')!.typeIndex));
	}

	// Builds a `kind` view struct (`buffer`, `byteOffset`, `length`, `byteLength`, `base` -- see
	// `lib/typedarray.ts`) over `pushBuffer()`, at `pushByteOffset()` (an existing `ArrayBuffer` and byte
	// offset -- real aliasing when `pushBuffer` re-reads a value the caller already holds elsewhere, e.g.
	// `new Uint8Array(existingBuffer, ...)`). `pushLength` gets the two just-materialized locals (buffer,
	// byteOffset) in case it needs to compute a default element count from `buffer.byteLength - byteOffset`.
	// Each `pushX` runs exactly once.
	function emitNewTypedArrayView(ctx: FuncCtx, kind: string, elemSize: number, pushBuffer: () => void, pushByteOffset: () => void, pushLength: (bufLocal: number, byteOffLocal: number) => void): WasmType {
		const bufCls = ensureClass('ArrayBuffer')!;
		const bufLocal = ctx.local('$taBuf', classWtype('ArrayBuffer'));
		const offLocal = ctx.local('$taByteOff', 'i32');
		const lenLocal = ctx.local('$taLen', 'i32');
		pushBuffer();
		ctx.emit(I.local.set(bufLocal));
		pushByteOffset();
		ctx.emit(I.local.set(offLocal));
		pushLength(bufLocal, offLocal);
		ctx.emit(I.local.set(lenLocal));
		ctx.emit(
			I.local.get(bufLocal), I.local.get(offLocal), I.local.get(lenLocal),
			I.local.get(lenLocal), I.i32.const(elemSize), I.i32.mul,
			I.local.get(bufLocal), I.struct.get(bufCls.typeIndex, bufCls.fieldIndex.get('offset')!),
			I.local.get(offLocal), I.i32.add,
			I.struct.new(ensureClass(kind)!.typeIndex),
		);
		return classWtype(kind);
	}

	function registerFuncType(params: wasm.ValType[], result: wasm.ValType | undefined) {
		return registerType({ final: true, supertypes: [], type: { kind: 'func', params, results: result !== undefined ? [result] : [] } });
	}
	function registerFuncAtType(typeIndex: number) {
		return { funcIndex: nextFunc++, typeIndex };
	}
	function registerFunc(params: wasm.ValType[], result: wasm.ValType | undefined) {
		return registerFuncAtType(registerFuncType(params, result));
	}

	function addData(newdata: Uint8Array, align = 1): number {
		const adjust = data.byteLength % align;
		const offset = data.byteLength + (adjust ? align - adjust : 0);
		const total	= offset + newdata.byteLength;
		
		if (data.buffer.byteLength < total) {
			const buffer = new Uint8Array(Math.max(data.buffer.byteLength * 2, total));
			buffer.set(data, 0);
			data = buffer.subarray(0, total);
		}
		data = new Uint8Array(data.buffer, 0, total);
		data.set(newdata, offset);
		return offset;
	}

	function internString(value: string): number {
		const existing = strings.get(value);
		if (existing !== undefined)
			return existing;
		// UTF-16LE, not `TextEncoder`'s UTF-8 -- `emitStringConst` builds the real `i16`-element array
		// straight from these bytes via `array.new_data`, so they need to already be one little-endian
		// 16-bit code unit per array element (matching `charCodeAt`), not UTF-8's variable-width bytes.
		const bytes = new Uint8Array(value.length * 2);
		const view = new DataView(bytes.buffer);
		for (let i = 0; i < value.length; i++)
			view.setUint16(i * 2, value.charCodeAt(i), true);
		const offset = addData(bytes, 2);
		strings.set(value, offset);
		return offset;
	}


	// Zero-field, non-`final` (subtypeable) struct -- the common supertype every closure literal's concrete
	// env struct declares itself a subtype of. wasm-GC width-subtyping requires the supertype's fields as a
	// prefix, vacuously true with zero fields; also directly usable as the env value for a no-capture literal.
	function ensureEnvBase(): number {
		return envBaseTypeIndex ??= registerType({ final: false, supertypes: [], type: { kind: 'struct', fields: [] } });
	}

	// Checks this program's own `classes` first, then falls back to `wasmTypeOf` for everything else.
	// `'T | null'`/`'T | undefined'` is handled here, once, ahead of both: strip nullish members, recurse
	// on what's left, then mark it `nullable` -- only `ref`/`arr` can carry that flag, so a nullable
	// number/boolean throws rather than silently dropping the nullability.
	// A possibly-generic class `ref` (`Foo<X>`, including `Array<X>`/`ReadonlyArray<X>` -- their physical
	// representation as a wasm-GC *array* rather than a struct is `ensureClass`'s own concern, derived from
	// their own constructor, see `ClassInfo.thisWtype`), resolved (and monomorphized/cached, via
	// `ensureClass`) to its `ClassInfo` --
	// shared by `typeOf` (needs the resulting `WasmType`) and `ownerFor` (needs the `MethodOwner`), which
	// otherwise only ever look up an *already-known* bare class name. `t` must be the original, unresolved
	// type node (a real `ref` with its own `typeArgs`, not `T.resolve`'s expanded form, which discards the
	// class name entirely).
	function resolveGenericClassRef(t: Type): ClassInfo | undefined {
		if (t.type === 'ref' && t.typeArgs?.length) {
			const decl = LIB_DECL_MAP.get(t.name) ?? userGenericClassDecls.get(t.name);
			if (decl?.type === 'class_decl' && decl.typeParams?.length)
				return ensureClass(t.name, t.typeArgs);
		}
		return undefined;
	}

	function typeOf(t: Type): WasmType | undefined {
		const generic = resolveGenericClassRef(t);
		if (generic)
			return ownerThisType(generic);
		const resolved = T.resolve(global, t);
		if (resolved.type === 'union') {
			const nonNullish = resolved.types.filter(m => !T.isNullish(m, global));
			if (nonNullish.length < resolved.types.length && nonNullish.length > 0) {
				const base = typeOf(nonNullish.length === 1 ? nonNullish[0] : TS.UnionType(nonNullish));
				if (!base)
					return undefined;
				if (typeof base === 'string')
					throw new Error("towasm: a nullable number/boolean ('T | null'/'T | undefined') is not supported -- only nullable object types (classes/arrays/strings) are, since a raw number/boolean has no null representation without boxing");
				return { ...base, nullable: true };
			}
		}
		if (resolved.type === 'function')
			return closureFuncSigType(resolved);
		// `T.isRefOf(t, classes)`: an *already-cached* class (any class ref seen once already resolves here
		// on every later reference, generic or not -- `String` specifically is non-generic, so it never
		// goes through `resolveGenericClassRef` above at all, only ever through this path). Same
		// `ownerThisType` delegation as the generic branch above, for the same reason: an array-backed
		// class's real `WasmType` is `{arr:kind}`, not the generic `{ref:name}` -- found via `new String(s)`'s
		// result type still wrongly claiming `{ref:'String'}` once some earlier statement in the same compile
		// had already resolved `String` once (before that, `wasmTypeOf`'s own fast path happened to give the
		// right answer by a different route, masking this).
		if (t.type === 'ref') {
			const cls = classes.get(t.name);
			if (cls)
				return ownerThisType(cls);
			if (plainLibClassNames.has(t.name))
				return { ref: t.name };
		}
		return wasmTypeOf(t, global);
	}

	// Builds (and memoizes) the `{closure: FuncSig}` `WasmType` for a TS function type
	function closureFuncSigType(t: TS.FunctionType): WasmType {
		if (t.typeParams?.length)
			throw new Error('towasm: a generic function type is not supported');
		if (t.rest)
			throw new Error('towasm: a function type with a rest parameter is not supported');
		const params = t.params.map(p => {
			if (p.default)
				throw new Error(`towasm: function type parameter '${describeBinding(p.key)}' cannot have a default value`);
			if (p.modifiers?.includes('optional'))
				throw new Error(`towasm: function type parameter '${describeBinding(p.key)}' cannot be optional`);
			const wt = p.typeAnnotation && typeOf(p.typeAnnotation as Type);
			if (!wt || wt === 'void')
				throw new Error(`towasm: function type parameter '${describeBinding(p.key)}' needs an explicit number/boolean/object type`);
			return wt;
		});
		const result = t.returnType ? typeOf(t.returnType as Type) : 'void';
		if (!result)
			throw new Error('towasm: a function type has an unsupported return type');
		const key = `(${params.map(wasmTypeKey).join(',')})=>${wasmTypeKey(result)}`;
		let wt = closureWasmTypes.get(key);
		if (!wt)
			closureWasmTypes.set(key, wt = { closure: { params, result } });
		return wt;
	}

	// `this`'s `WasmType`. A real `ClassInfo` carries its own already-resolved `thisWtype` directly (see that
	// field's own comment -- struct-backed or array-backed, never guessed from its name); a builtin
	// (non-class) owner has no such field, so it derives one from `thisTsType` the ordinary way.
	function ownerThisType(owner: MethodOwner): WasmType {
		const wt = 'fields' in owner ? (owner as ClassInfo).thisWtype ?? { ref: owner.name } : typeOf(owner.thisTsType);
		if (!wt)
			throw new Error(`towasm: internal: '${owner.name}' has no representable this-type`);
		return wt;
	}

	// The `WasmType` a value expression resolves to -- `classOf`/`arrayKindOf` below are thin discriminating views over this one (previously identical) checker walk.
	function wtypeOf(e: Expr, ctx: FuncCtx): WasmType | undefined {
		return typeOf(checker.typeOf(e, ctx.scope));
	}

	// The class a value expression resolves to, or `undefined` if it isn't one. Goes through `ownerOf`
	// (the checker *type*, not `wtypeOf`'s already-collapsed `WasmType`) rather than checking `'ref' in wt`
	// itself -- an array-backed class (`Array<T>`, see `ClassInfo.thisWtype`) has a real `ClassInfo` behind
	// it too, but its `WasmType` is `{arr:kind}`, not `{ref:name}`, and reverse-mapping a `WasmType` back to
	// "which class" is exactly the anti-pattern this compiler avoids elsewhere (`ownerFor`'s own comment).
	// Narrowed to `ClassInfo` structurally (`'fields' in owner`) since not every `MethodOwner` is one
	// (`Number`/`String`/etc's builtin owners have no fields to look up at all).
	function classOf(e: Expr, ctx: FuncCtx): ClassInfo | undefined {
		const owner = ownerOf(e, ctx);
		return owner && 'fields' in owner ? owner as ClassInfo : undefined;
	}

	// `cls.name`'s own `get(i)`/`set(i,v)` -- real index syntax (`a[i]`/`a[i]=v`) dispatched generically to
	// any class using this convention (typed-array views are just the one user of it -- see
	// `lib/typedarray.ts`), whether `name` is inline-asm (probed with `[]`, same as `operandInfo`'s own
	// empty-args probe -- `get`/`set` are always fixed, non-`$T`, so the probe args don't matter) or a
	// plain declared method.
	function methodSig(cls: ClassInfo, name: string, ctx: FuncCtx): { params: WasmType[]; result: WasmType } | undefined {
		const inline = cls.inlineMethods?.get(name);
		if (inline) {
			const b = inline([], ctx);
			return { params: b.params, result: b.result };
		}
		return ensureMethod(cls, name);
	}

	// The array-kind (`{arr}`) a value expression resolves to, or `undefined` if it isn't one.
	function arrayKindOf(e: Expr, ctx: FuncCtx): wasmElement | undefined {
		const wt = wtypeOf(e, ctx);
		return wt && typeof wt !== 'string' && 'arr' in wt ? wt.arr : undefined;
	}

	// The `WasmType`/`MethodOwner` a builtin-operator operand actually resolves to -- `wtypeOf`/`ownerOf`
	// alone can't see an indexed read's element kind (the checker gives `any` there), so `arithInline`/etc
	// would otherwise silently fall back to `f64` for e.g. `intArr[i] + intArr[j]`.
	function operandInfo(e: Expr, ctx: FuncCtx): OperandInfo {
		if (e.type === 'index') {
			// A class's own `get(i)` (typed-array element reads, or any other class using the same
			// convention) -- probed the same way `makeAsmBuiltin`'s own empty-args call does, since `get`
			// is always fixed (non-`$T`) here and its result doesn't depend on the (nonexistent) arguments.
			const getInline = classOf(e.object, ctx)?.inlineMethods?.get('get');
			if (getInline)
				return { wtype: getInline([], ctx).result, owner: undefined };
			const kind = arrayKindOf(e.object, ctx);
			if (kind === 'f64' || kind === 'i32' || kind === 'u32')
				return { wtype: kind, owner: undefined };
		}
		const t = checker.typeOf(e, ctx.scope);
		return { wtype: typeOf(t), owner: ownerFor(t) };
	}

	// The `MethodOwner` a static `Type` dispatches method calls against -- derived directly from the `Type` itself, never by reverse-decoding an already-collapsed `WasmType`
	function ownerFor(t: Type): MethodOwner | undefined {
		// Same fast path `wasmTypeOf` needs, for the same reason -- a hoisted `builtinTypes` name would
		// otherwise fully expand via its own `declScope` before reaching the `w.type === 'ref'` check below.
		// `string`/`String` specifically: no `.owner` on their `builtinTypes` entries (it's a real
		// `ensureClass('String')` instantiation, can't be built until `TStoWasm` itself is running, so it
		// was never a module-level value to begin with -- see `builtinTypes`'s own comment).
		if (t.type === 'ref' && !t.typeArgs && t.name in builtinTypes) {
			if (t.name === 'string' || t.name === 'String')
				return ensureClass('String');
			return builtinTypes[t.name].owner;
		}
		const generic = resolveGenericClassRef(t);
		if (generic)
			return generic;
		if (T.isRefOf(t, classes))
			return ensureClass(t.name);
		const w = T.widenLiterals(T.resolve(global, t));
		// `obj?.method(...)`'s receiver is nullable by construction -- strip `null`/`undefined` before
		// dispatching; there's no "owner of `null`", only "owner of the non-nullish part `?.` already guarded".
		if (w.type === 'union') {
			const nonNullish = T.nonNullable(w, global);
			return nonNullish !== w ? ownerFor(nonNullish) : undefined;
		}
		// `T[]`/`Array<T>`/`ReadonlyArray<T>` all resolve to `Array`'s own (real, `ensureClass`-monomorphized)
		// methods -- `ReadonlyArray` has no separate declaration anywhere in lib source, it's a checker-only
		// "readonly view" of the exact same structural shape (see type-utils.ts's own `normalizeArray`),
		// so it maps to `Array`'s decl by name here rather than needing one of its own.
		if (w.type === 'array')
			return ensureClass('Array', [w.element]);
		if (w.type === 'ref') {
			switch (w.name) {
				case 'Array':
				case 'ReadonlyArray':
					return ensureClass('Array', w.typeArgs);
				// Reached for a `string`-typed value the fast path above missed -- e.g. an unannotated
				// `const s = "hello"` types as the bare *literal* `"hello"` until `T.widenLiterals` (just
				// above) widens it to `string`, so the fast path's `t.type === 'ref'` check (on the
				// original, unwidened `t`) never even ran. Found via `s.charCodeAt(0)` throwing `unknown
				// method` -- `s.length` looked fine only because it was silently going through the
				// pre-existing `arrayKindOf` fallback instead of this (then-broken) path.
				case 'string':
				case 'String':
					return ensureClass('String');
			}
			// A plain lib class not yet reached through `T.isRefOf(t, classes)` above -- e.g. a function
			// parameter typed `Uint8Array` with no `new Uint8Array(...)` call anywhere earlier in this
			// compile to have lazily populated `classes` already.
			return builtinTypes[w.name]?.owner ?? (plainLibClassNames.has(w.name) ? ensureClass(w.name) : undefined);
		}
		return undefined;
	}

	// The owner for a *namespace-style* reference -- a bare identifier used as a static-field/static-method
	// receiver (`Math.sqrt`, `Array.alloc`, `String.fromCharCode`), not a value expression, so it goes
	// through `checker.typeOf`/`ownerFor` no better than `ownerFor`'s own literal-widening trick already
	// gets `s.charCodeAt(0)` (a value) there -- `String` used bare like this never gets a "real" value type
	// from the checker at all. `String` specifically needs its own check here for the same reason `ownerFor`
	// needs one: no `.owner` on `builtinTypes.String` (a real `ensureClass('String')` instantiation, not a
	// module-level value).
	function namespaceOwner(name: string, ctx: FuncCtx): MethodOwner | undefined {
		return builtinTypes[name]?.owner
			?? (name === 'String' ? ensureClass('String') : undefined)
			?? (ctx.owner?.decl.name === name ? ctx.owner : undefined);
	}

	// Field access stays `classOf`-only (arrays/scalars have no fields), but method-call dispatch is
	// otherwise identical across real classes, array kinds, and scalar box kinds -- all handled by `ownerFor` above.
	function ownerOf(e: Expr, ctx: FuncCtx): MethodOwner | undefined {
		return ownerFor(checker.typeOf(e, ctx.scope));
	}

	// Populated by the "index space" pass below, before any body is built -- a class ref's `WasmType`
	// only carries its *name*, but the binary format needs the struct's numeric type index.
	function toValType(w: WasmType): wasm.ValType {
		if (w === 'void')
			throw new Error('towasm: internal: void has no value representation');
		if (w === 'u32')
			return 'i32';
		if (typeof w === 'string')
			return w;
		if ('ref' in w) {
			// `any` is wasm's own abstract heap type (a real `wasm.HeapType` string, not a type-section
			// index) -- previously only ever produced transiently and coerced away before reaching here
			// (`coerceTop`'s `got.ref === 'any'` case); a real local declared `{ref:'any'}` (e.g. `Array<T>`
			// mutating methods' own scratch for a popped/shifted ref-kind element) needs this to actually
			// resolve, instead of `ensureClass` treating "any" as an unknown user class name.
			if (w.ref === 'any')
				return { ref: 'any', nullable: !!w.nullable };
			// Lazy the same way every other class use is -- a not-yet-reached class still needs a real
			// `typeIndex` right now, not the stale `-1` `classes` seeded it with.
			const cls = ensureClass(w.ref);
			if (!cls)
				throw new Error(`towasm: internal: unresolved class '${w.ref}'`);
			return { ref: cls.typeIndex, nullable: !!w.nullable };
		}
		if ('closure' in w)
			return { ref: ensureClosureType(w.closure).structTypeIndex, nullable: !!w.nullable };
		if ('typeIndex' in w)
			return { ref: w.typeIndex, nullable: !!w.nullable };
		return { ref: builtinArrayOwners[w.arr].typeIndex, nullable: !!w.nullable };
	}

	// The heap type a `ref.null` needs -- just `toValType`'s `.ref`, unwrapped from the `wasm.ValType` shape.
	function heapTypeIndexOf(w: WasmType): wasm.HeapType {
		const vt = toValType(w);
		if (typeof vt === 'string' || !('ref' in vt))
			throw new Error('towasm: internal: expected a reference type');
		return vt.ref;
	}

	// A non-`void` function/method/closure body doesn't necessarily end in a plain top-level `return` --
	// `if`/`while`/`switch` all compile to a `void`-typed wasm block wrapping their own branches (even when
	// *every* branch inside unconditionally returns), so a body that ends with one of those, with nothing
	// after it, leaves wasm's own trailing-fallthrough check unsatisfied: reaching that block's `end` is
	// "reachable" from the validator's perspective (a block's declared type applies at its `end` regardless
	// of whether everything inside it happened to be dead code), and a `void` block leaves 0 values where the
	// function needs 1+. This compiler doesn't do full "does every path return" control-flow analysis to
	// avoid it -- instead, `unreachable` appended after the body is always safe (dead code whenever a real
	// return already covers every path -- unreachable code satisfies any leftover result-type requirement
	// trivially, the same reasoning that makes `return`-inside-a-nested-block work at all) and never changes
	// behavior for a body that does terminate correctly. `ensureCtor` already does the equivalent for
	// constructors unconditionally (`I.local.get(ctorThis)` + `I.return`); this generalizes the same idea to
	// `ensureFunc`/`ensureMethod`/closure literals. Found via `switch`-as-a-function's-last-statement (every
	// case returns) -- but `if`/`else` has the identical gap, confirmed with an isolated repro, so this is a
	// general fix, not a `switch`-specific one.
	function emitTrailingUnreachable(ctx: FuncCtx, result: WasmType): void {
		if (result !== 'void')
			ctx.emit(I.unreachable);
	}



	// Fills in trailing arguments a call site omitted, from each missing param's own literal default
	function fillDefaultArgs(label: string, params: WasmType[], defaults: (Expr | undefined)[] | undefined, args: Expr[]): Expr[] {
		if (args.length === params.length)
			return args;
		if (args.length > params.length || !defaults)
			throw new Error(`towasm: '${label}' takes exactly ${params.length} argument(s)`);
		const missing = defaults.slice(args.length);
		if (missing.some(d => !d))
			throw new Error(`towasm: '${label}' takes exactly ${params.length} argument(s)`);
		return [...args, ...missing as Expr[]];
	}

	// Emits a call's arguments, shared by `emitCall`/`emitMethodCall`. When the callee has a rest param
	// (`hasRest`, `...items: T[]`), its trailing call-site arguments -- however many there are, always a
	// compile-time-known count in this subset, same reasoning an array literal's own element count already
	// uses -- are bundled into one real array via `emitArrayElements` (which itself already handles a spread
	// among them, e.g. `arr.push(...other)`), instead of a fixed one-argument-per-param match.
	function emitCallArgs(label: string, params: WasmType[], defaults: (Expr | undefined)[] | undefined, hasRest: boolean, args: Expr[], ctx: FuncCtx): void {
		if (!hasRest) {
			fillDefaultArgs(label, params, defaults, args).forEach((a, i) => emitAs(a, ctx, params[i]));
			return;
		}
		const fixedCount = params.length - 1;
		if (args.length < fixedCount)
			throw new Error(`towasm: '${label}' needs at least ${fixedCount} argument(s)`);
		args.slice(0, fixedCount).forEach((a, i) => emitAs(a, ctx, params[i]));
		const restArrWtype = params[fixedCount];
		if (typeof restArrWtype === 'string' || !('arr' in restArrWtype))
			throw new Error(`towasm: internal: '${label}' rest param has a non-array type`);
		const kind = restArrWtype.arr;
		if (kind === 'i16')
			throw new Error(`towasm: '${label}' rest param: a 'string[]' element is not supported`);
		emitArrayElements(args.slice(fixedCount), ctx, kind === 'ref' ? REF_ANY : kind, kind, builtinArrayOwners[kind].typeIndex);
	}

	// ===================================================================
	//  Expression lowering -- every case leaves exactly one value on the stack
	// ===================================================================

	function emitStringConst(s: string, ctx: FuncCtx): void {
		// `array.new_data`'s two `i32` stack operands are a byte offset and an *element* count (not a
		// byte count) into the module's one shared passive data segment (index 0 -- see `mod.datas`) --
		// `internString`'s return value is already that byte offset, and `s.length` is already a UTF-16
		// code-unit count, so both need no conversion.
		ctx.emit(I.i32.const(internString(s)), I.i32.const(s.length), I.array.new_data(builtinArrayOwners.i16.typeIndex, 0));
	}

	function coerceTop(got: WasmType, ctx: FuncCtx, want: WasmType): void {
		if (wasmTypeEq(got, want))
			return;

		// `u32`/`i32` are the same physical wasm value (real wasm has no distinct unsigned value type) --
		// `u32` only exists so `coerceTop` itself always knows which conversion direction (`_s` vs `_u`) a
		// value needs, instead of every producer having to remember to convert eagerly at its own call site.
		if ((got === 'u32' && want === 'i32') || (got === 'i32' && want === 'u32'))
			return;

		if (typeof got !== 'string') {
			if ('ref' in got && got.ref === 'any') {
				if (typeof want !== 'string' && ('ref' in want || 'arr' in want || 'closure' in want || 'typeIndex' in want))
					ctx.emit(I.ref.cast(heapTypeIndexOf(want)));
				return;
			}

			// The opposite direction: any concrete class ref is already a valid `anyref` value in real wasm
			// (structural subtyping), so no instruction is needed to *widen* to `any` -- only `ref.as_non_null`
			// if narrowing nullability at the same time. Found via writing a concrete class instance into a
			// ref-kind `Array<T>` slot (`arr[i] = new Foo(...)`), previously an unconditional "cannot convert"
			// throw -- this was the missing other half of the `got.ref === 'any'` case just above.
			if ('ref' in got && typeof want !== 'string' && 'ref' in want && want.ref === 'any') {
				if (got.nullable && !want.nullable)
					ctx.emit(I.ref.as_non_null);
				return;
			}

		// Nullable<->non-null, same underlying ref/array kind
			if (typeof want !== 'string') {
				const gotKind	= 'ref' in got ? got.ref : 'arr' in got ? got.arr : undefined;
				const wantKind	= 'ref' in want ? want.ref : 'arr' in want ? want.arr : undefined;
				if (gotKind !== undefined && gotKind === wantKind) {
					if (got.nullable && !want.nullable)
						ctx.emit(I.ref.as_non_null);
					return;
				}
			}
		}

		if (got === 'f64') {
			switch (want) {
				// Truncation direction doesn't care about the target's signedness -- `u32` wants exactly the
				// same bit pattern `i32` would get here, only the *other* direction (`want === 'f64'` below)
				// depends on which sign the bits should be read back as.
				case 'i32':
				case 'u32': ctx.emit(I.i64.trunc_sat_f64_s, I.i32.wrap_i64); return;
				case 'i64': ctx.emit(I.i64.trunc_sat_f64_s); return;
			}
		}
		if (want === 'f64') {
			switch (got) {
				case 'i32':	ctx.emit(I.f64.convert_i32_s); return;
				case 'u32':	ctx.emit(I.f64.convert_i32_u); return;
				case 'i64': ctx.emit(I.f64.convert_i64_s); return;
				case 'f32':	ctx.emit(I.f64.promote_f32); return;
			}
		}
		// Sign matters for the *widening* direction (unlike the `f64`->`i32`/`u32` truncation above, which
		// reads the same bits either way) -- needed e.g. for `bigint.ts`'s `__towasm_mulWide(a[i], b[j])`,
		// whose `i64` params force each `u32` limb read to widen here rather than at its own call site.
		if (want === 'i64') {
			switch (got) {
				case 'i32': ctx.emit(I.i64.extend_i32_s); return;
				case 'u32': ctx.emit(I.i64.extend_i32_u); return;
			}
		}
		// generate bigint -- `bigint`'s own physical representation (`builtinTypes.bigint.wtype`), currently
		// `{arr:'u32'}` (a real `u32[]`, see `lib/bigint.ts`), not a fixed `{arr:'i32'}` -- this must track
		// whatever that is, the same way `bigint`'s `wtype` itself does.
		if (wasmTypeEq(want, ARR_WTYPE.u32)) {
			if (got === 'i32' || got === 'u32') {
				ctx.emit(I.array.new_fixed(builtinArrayOwners.u32.typeIndex, 1));
				return;
			}
			if (got === 'i64') {
				const tmp64 = ctx.local('$tmp64', 'i64');
				ctx.emit(
					I.local.tee(tmp64),
					I.i64.const(0xffffffffn),
					I.i64.and,
					I.i32.wrap_i64,
					I.local.get(tmp64),
					I.i64.const(32n),
					I.i64.shr_u,
					I.i32.wrap_i64,
					I.array.new_fixed(builtinArrayOwners.u32.typeIndex, 2)
				);
				return;
			}
		}
		throw new Error(`towasm: internal: cannot convert ${JSON.stringify(got)} to ${JSON.stringify(want)}`);
	}

	function emitAs(e: Expr, ctx: FuncCtx, want: WasmType): void {
		// `null`/`undefined` alone (`emitExpr` has no target type to pick a heap type from) -- only legal
		// into a nullable slot, same restriction `typeOf`'s union handling already enforces.
		if (isNullLiteral(e)) {
			if (typeof want === 'string' || !want.nullable)
				throw new Error("towasm: 'null'/'undefined' is only supported where a nullable object type (class/array/string) is expected");
			ctx.emit(I.ref.null(heapTypeIndexOf(want)));
			return;
		}
		coerceTop(emitExpr(e, ctx, want), ctx, want);
	}

	// Every `if`/`while`/`?:`/`&&`/`||` test used to just `emitAs(test, ctx, 'i32')`
	function emitTruthy(e: Expr, ctx: FuncCtx): void {
		switch (emitExpr(e, ctx)) {
			case 'i32': return;
			case 'f64': ctx.emit(I.f64.const(0), I.f64.ne); return;
			case 'f32': ctx.emit(I.f32.const(0), I.f32.ne); return;
			case 'i64': ctx.emit(I.i64.const(0n), I.i64.ne); return;
			default: throw new Error('towasm: this value cannot be used as a boolean condition');
		}
	}

	// Shared by every optional (`?.`) lowering: `objLocal` has already been evaluated once into a scratch
	// local by the caller (a chain's base expression must never be re-evaluated) -- this adds the null
	// branch, running `readCore` only when non-null.
	function emitOptionalGuard(ctx: FuncCtx, objLocal: Local, resultWtype: WasmType, readCore: () => void): WasmType {
		ctx.emit(I.local.get(objLocal.index), I.ref.is_null);
		const old = ctx.swapOut();
		ctx.emit(I.ref.null(heapTypeIndexOf(resultWtype)));
		const _then = ctx.swapOut();
		readCore();
		const _else = ctx.swapOut(old);
		ctx.emit(I.if(toValType(resultWtype), _then, _else));
		return resultWtype;
	}

	// Shared by every optional (`?.`) lowering -- `objectExpr` must only ever be evaluated once, so this
	// materializes it into a scratch local up front and hands that off to `emitOptionalGuard`.
	function emitOptionalAccess(ctx: FuncCtx, objWtype: WasmType, resultWtype: WasmType, readCore: (objLocal: Local) => void): WasmType {
		const objLocal = ctx.declareLocal(`$opt$obj$${optionalTempCounter++}`, objWtype);
		ctx.emit(I.local.set(objLocal.index));
		return emitOptionalGuard(ctx, objLocal, resultWtype, () => readCore(objLocal));
	}

	// Shared by every optional (`?.`) lowering: rejects chaining another access onto an already-optional
	// result (`a?.b.c`, `a?.b?.c`, ...) -- real chaining short-circuits the entire remaining chain, which
	// this pass doesn't track; only a single `?.` step is supported, so anything deeper throws.
	function rejectChainedOptional(inner: Expr): void {
		if ((inner.type === 'member' || inner.type === 'index' || inner.type === 'call') && inner.optional)
			throw new Error("towasm: chaining another access onto an optional ('?.') result (e.g. 'a?.b.c' or 'a?.b?.c') is not supported -- only a single '?.' step is");
	}

	// Shared by every optional (`?.`) lowering: the guarded type is number/boolean-typed, so the optional
	// expression's own type (`T | undefined`) would need a nullable number/boolean -- unsupported.
	function rejectNullablePrimitive(wtype: WasmType, what: string): asserts wtype is { ref: string; nullable?: boolean } | { arr: wasmElement; nullable?: boolean } {
		if (typeof wtype === 'string')
			throw new Error(`towasm: '${what}' is not supported here -- it's number/boolean-typed, and 'T | undefined' needs an object type (no boxing in this subset)`);
	}

	// Shared by the `[1, 2, 3]` array-literal case and `new Uint8Array([...])`'s literal-argument form --
	// both reject holes and coerce every plain element to `want`. A spread element forces the slower
	// `emitArrayElementsWithSpread` path (its length is runtime, not `array.new_fixed`'s compile-time count).
	function emitArrayElements(elements: readonly (Expr | undefined)[], ctx: FuncCtx, want: WasmType, kind: wasmElement, typeIndex: number): void {
		if (elements.some(el => el?.type === 'spread')) {
			emitArrayElementsWithSpread(elements, ctx, want, kind, typeIndex);
			return;
		}
		for (const el of elements) {
			if (!el)
				throw new Error('towasm: array literals with holes are not supported');
			emitAs(el, ctx, want);
		}
		ctx.emit(I.array.new_fixed(typeIndex, elements.length));
	}

	// A `[...]` array literal containing at least one spread element. Every element -- plain or spread -- is
	// evaluated exactly once, in source order, into a scratch local before anything is allocated (an
	// element may have side effects, and a later "fill" pass re-evaluating it would run those twice). The
	// real array is then `array.new_default`-allocated to the true runtime total and filled in a second pass.
	function emitArrayElementsWithSpread(elements: readonly (Expr | undefined)[], ctx: FuncCtx, want: WasmType, kind: wasmElement, typeIndex: number): void {
		type Part = { spread: false; value: Local } | { spread: true; src: Local; len: Local };
		const parts: Part[] = [];

		elements.forEach((el, i) => {
			if (!el)
				throw new Error('towasm: array literals with holes are not supported');
			if (el.type === 'spread') {
				const srcKind = arrayKindOf(el.operand, ctx);
				if (srcKind !== kind)
					throw new Error('towasm: a spread element in an array literal must be an array of the same element type');
				emitAs(el.operand, ctx, ARR_WTYPE[srcKind]);
				const src = ctx.declareLocal(`$spread$src$${i}`, ARR_WTYPE[srcKind]);
				ctx.emit(I.local.set(src.index));
				ctx.emit(I.local.get(src.index), I.array.len);
				const len = ctx.declareLocal(`$spread$len$${i}`, 'i32');
				ctx.emit(I.local.set(len.index));
				parts.push({ spread: true, src, len });
			} else {
				emitAs(el, ctx, want);
				const value = ctx.declareLocal(`$spread$elem$${i}`, want);
				ctx.emit(I.local.set(value.index));
				parts.push({ spread: false, value });
			}
		});

		ctx.emit(I.i32.const(parts.filter(p => !p.spread).length));
		for (const p of parts) {
			if (p.spread)
				ctx.emit(I.local.get(p.len.index), I.i32.add);
		}
		ctx.emit(I.array.new_default(typeIndex));
		const dst = ctx.local('$spread$dst', ARR_WTYPE[kind]);
		ctx.emit(I.local.set(dst));

		const offset = ctx.local('$spread$offset', 'i32');
		ctx.emit(I.i32.const(0), I.local.set(offset));
		for (const p of parts) {
			if (p.spread) {
				ctx.emit(
					I.local.get(dst), I.local.get(offset),
					I.local.get(p.src.index), I.i32.const(0), I.local.get(p.len.index),
					I.array.copy(typeIndex, typeIndex),
				);
				ctx.emit(I.local.get(offset), I.local.get(p.len.index), I.i32.add, I.local.set(offset));
			} else {
				ctx.emit(
					I.local.get(dst), I.local.get(offset), I.local.get(p.value.index),
					I.array.set(typeIndex),
				);
				ctx.emit(I.local.get(offset), I.i32.const(1), I.i32.add, I.local.set(offset));
			}
		}
		ctx.emit(I.local.get(dst));
	}

	function emitInline(name: string, inline: Inline, args: Expr[], ctx: FuncCtx): WasmType {
		if (args.length !== inline.params.length)
			throw new Error(`towasm: '${name}' takes exactly ${inline.params.length} argument(s)`);
		args.forEach((a, i) => emitAs(a, ctx, inline.params[i]));
		ctx.emit(...inline.inline);
		return inline.result;
	}

	// Dispatches every `builtins` entry, coercing args via `emitAs`; falls back to `ensureFunc` for a
	// plain user-declared function not in `builtins` at all.
	function emitCall(name: string, args: Expr[], ctx: FuncCtx): WasmType {
		//if (args.some(a => a.type === 'spread'))
		//	throw new Error('towasm: spread call arguments are not supported');

		let decl;
		const builtin = builtins[name];
		if (builtin) {
			const result = builtin(args.map(a => operandInfo(a, ctx)), ctx);
			if ('inline' in result)
				return emitInline(name, result, args, ctx);
			// Only a binary operator's own `builtins` entry can resolve to a `MethodDelegate` -- a bare call
			// has no receiver, so getting one here is an internal inconsistency, not a user error.
			if ('owner' in result)
				throw new Error(`towasm: internal: '${name}' resolved to a method delegate outside operator dispatch`);

			decl = result;
		} else {
			decl = functionDeclByName.get(name);
			if (!decl)
				throw new Error(`towasm: call to unknown function '${name}'`);
		}

		const info = funcs.get(name) ?? ensureFunc(name, decl);
		if (!info)
			throw new Error(`towasm: call to unknown function '${name}'`);
		emitCallArgs(name, info.params, info.defaults, !!info.hasRest, args, ctx);
		ctx.emit(I.call(info.funcIndex));
		return info.result;
	}

	// Dispatches a `receiver.name(...args)` call against any `MethodOwner` -- `inlineMethods` (checked
	// first) splices its instructions directly into the caller with no `call` at all.
	// `receiver` is `undefined` for a namespace-style call (`Math.sqrt(x)`, `Array.alloc(n)` from inside
	// `Array<T>`'s own methods) -- no real value to push, just a bare name used to look up `owner`.
	function emitMethodCall(owner: MethodOwner, name: string, args: Expr[], ctx: FuncCtx): WasmType {
		const inline = owner.inlineMethods?.get(name);
		if (inline) {
			if (args.some(a => a.type === 'spread'))
				throw new Error('towasm: spread call arguments are not supported');
			return emitInline(name, inline(args.map(a => operandInfo(a, ctx)), ctx), args, ctx);
		}

		const method = ensureMethod(owner, name);
		if (!method)
			throw new Error(`towasm: unknown method '${name}' on ${owner.name}`);
		// A spread argument is only meaningful bundled into a rest param (`arr.push(...other)`) --
		// `emitCallArgs`/`emitArrayElements` already handle that; anywhere else it's still rejected.
		if (!method.hasRest && args.some(a => a.type === 'spread'))
			throw new Error('towasm: spread call arguments are not supported');
		emitCallArgs(name, method.params, method.defaults, !!method.hasRest, args, ctx);
		ctx.emit(I.call(method.funcIndex));
		return method.result;
	}

	// Two separate questions: whether the current value needs reading at all (`'none'` -- only a plain `=`
	// can skip it), and whether it needs preserving afterward for `.old` (`'keep'`, only postfix `++`/`--`,
	// which returns the pre-increment value) or is only needed once to combine immediately (`'discard'`,
	// every compound-assignment op and prefix `++`/`--`) -- `'discard'` skips the extra scratch local `'keep'` needs.
	function emitAssignTarget(target: Expr, ctx: FuncCtx, old: 'none' | 'discard' | 'keep'): AssignTarget {
		// `this = expr` (only ever meaningful inside a `reassignsThis` method, see `assignsToThis`) is just
		// one more named binding to assign to -- `this` parses as its own distinct node (`{type:'this'}`, no
		// `.name`), not an `identifier`, so it needs its own name derivation here, same as `case 'this'`'s
		// own read-side handling already does (`emitExpr`).
		if (target.type === 'identifier' || target.type === 'this') {
			const name = target.type === 'this' ? 'this' : target.name;
			// A captured free variable -- no real local, no `local.tee` to lean on (wasm-GC has no
			// `struct.tee`), so `write` goes through a `$new` scratch local, same shape as `member` below.
			const captured = ctx.closureEnv?.fields.get(name);
			if (captured) {
				const { wtype, index: fieldIdx } = captured;
				const envLocal		= ctx.closureEnv!.envLocal;
				const envTypeIndex	= ctx.closureEnv!.envTypeIndex;

				let savedOld: number | undefined;
				if (old !== 'none') {
					ctx.emit(I.local.get(envLocal.index), I.struct.get(envTypeIndex, fieldIdx));
					if (old === 'keep') {
						savedOld = ctx.local('$old', wtype);
						ctx.emit(I.local.tee(savedOld));
					}
				}
				return {
					wtype, old: savedOld,
					write(tee) {
						const val = ctx.local('$new', wtype);
						ctx.emit(
							I.local.set(val),
							I.local.get(envLocal.index),
							I.local.get(val),
							I.struct.set(envTypeIndex, fieldIdx),
						);
						if (tee)
							ctx.emit(I.local.get(val));
						return val;
					},
				};
			}

			const { wtype, index } = ctx.lookup(name);
			let savedOld: number | undefined;
			if (old !== 'none') {
				ctx.emit(I.local.get(index));
				if (old === 'keep') {
					savedOld = ctx.local('$old', wtype);
					ctx.emit(I.local.tee(savedOld));
				}
			}
			return {
				wtype, old: savedOld,
				write(tee) {
					ctx.emit(tee ? I.local.tee(index) : I.local.set(index));
					return index;
				},
			};

		} else if (target.type === 'member') {
			const cls = classOf(target.object, ctx);

			// A `set` accessor -- checked before the ordinary struct-field write, mirroring the read
			// side's getter-probe in `case 'member'`. Reading the "old" value (compound assignment /
			// postfix `++`/`--`) needs a matching getter -- a setter-only property can't support that.
			if (cls?.setterNames?.has(target.property)) {
				const setSig = methodSig(cls, accessorKey('set', target.property), ctx);
				if (!setSig)
					throw new Error(`towasm: internal: setter '${target.property}' has no signature`);
				const wtype = setSig.params[0];
				const valExpr: Expr = { type: 'identifier', name: '$new' };

				const obj = ctx.local('$obj', emitExpr(target.object, ctx));
				ctx.emit(I.local.set(obj));
				let savedOld: number | undefined;
				if (old !== 'none') {
					if (!cls.getterNames?.has(target.property))
						throw new Error(`towasm: '${target.property}' has no getter -- its old value can't be read for a compound assignment/'++'/'--'`);
					ctx.emit(I.local.get(obj));
					emitMethodCall(cls, accessorKey('get', target.property), [], ctx);
					if (old === 'keep') {
						savedOld = ctx.local('$old', wtype);
						ctx.emit(I.local.tee(savedOld));
					}
				}
				return {
					wtype, old: savedOld,
					write(tee) {
						const val = ctx.local('$new', wtype);
						ctx.emit(I.local.set(val), I.local.get(obj));
						emitMethodCall(cls, accessorKey('set', target.property), [valExpr], ctx);
						if (tee)
							ctx.emit(I.local.get(val));
						return val;
					},
				};
			}

			const fieldIdx	= cls?.fieldIndex.get(target.property);
			if (!cls || fieldIdx === undefined)
				throw new Error(`towasm: unknown field '${target.property}'`);

			const wtype = cls.fields[fieldIdx].wtype;

			const obj = ctx.local('$obj', emitExpr(target.object, ctx));
			ctx.emit(I.local.set(obj));
			let savedOld: number | undefined;
			if (old !== 'none') {
				ctx.emit(I.local.get(obj), I.struct.get(cls.typeIndex, fieldIdx));
				if (old === 'keep') {
					savedOld = ctx.local('$old', wtype);
					ctx.emit(I.local.tee(savedOld));
				}
			}
			return {
				wtype, old: savedOld,
				write(tee) {
					const val = ctx.local('$new', wtype);
					ctx.emit(
						I.local.set(val),
						I.local.get(obj),
						I.local.get(val),
						I.struct.set(cls.typeIndex, fieldIdx),
					);
					if (tee)
						ctx.emit(I.local.get(val));
					return val;
				},
			};
		} else if (target.type == 'index') {
			// Any class with its own `get(i)`/`set(i,v)` (typed-array views, or any other class using the
			// same convention -- see `methodSig`) -- real index syntax dispatched generically, not by name.
			const cls = classOf(target.object, ctx);
			const getSig = cls && methodSig(cls, 'get', ctx);
			if (cls && getSig && methodSig(cls, 'set', ctx)) {
				const obj = ctx.local('$obj', emitExpr(target.object, ctx));
				ctx.emit(I.local.set(obj));
				emitAs(target.property, ctx, getSig.params[0]);
				ctx.emit(I.local.set(ctx.local('$index', getSig.params[0])));
				const idxExpr: Expr = { type: 'identifier', name: '$index' };
				const valExpr: Expr = { type: 'identifier', name: '$new' };

				let savedOld: number | undefined;
				const wtype = getSig.result;
				if (old !== 'none') {
					ctx.emit(I.local.get(obj));
					emitMethodCall(cls, 'get', [idxExpr], ctx);
					if (old === 'keep') {
						savedOld = ctx.local('$old', wtype);
						ctx.emit(I.local.tee(savedOld));
					}
				}
				return {
					wtype, old: savedOld,
					write(tee) {
						const val = ctx.local('$new', wtype);
						ctx.emit(I.local.set(val), I.local.get(obj));
						emitMethodCall(cls, 'set', [idxExpr, valExpr], ctx);
						if (tee)
							ctx.emit(I.local.get(val));
						return val;
					},
				};
			}

			const kind = arrayKindOf(target.object, ctx);
			// `i16` (`string`) rejected same as `case 'index'`'s own read side -- strings are immutable.
			if (!kind || kind === 'i16')
				throw new Error("towasm: this operation is not supported");

			const typeIndex = builtinArrayOwners[kind].typeIndex;
			// Mirrors `case 'index'`'s own read-side result exactly (`kind === 'ref' ? REF_ANY : kind`) -- a
			// ref-kind array's write target is a boxed `any`, not a raw i32 (found via a ref-kind array-write
			// probe: this fell through to the `i32` default before, silently wrong). `REF_ANY`, not a fresh
			// `{ref:'any'}` literal -- `write`'s own `ctx.local('$new', wtype)` below compares repeat
			// declarations by object identity (see `REF_ANY`'s own comment), so two separate ref-kind index
			// writes in one function need the *same* object here, not two structurally-equal ones.
			const wtype: WasmType = kind === 'ref' ? REF_ANY : kind;

			const obj		= ctx.local('$obj', emitExpr(target.object, ctx));
			ctx.emit(I.local.set(obj));
			emitAs(target.property, ctx, 'i32');
			const idx		= ctx.local('$index', 'i32');
			ctx.emit(I.local.set(idx));

			let savedOld: number | undefined;
			if (old !== 'none') {
				ctx.emit(I.local.get(obj), I.local.get(idx));
				ctx.emit(I.array.get(typeIndex));
				if (old === 'keep') {
					savedOld = ctx.local('$old', wtype);
					ctx.emit(I.local.tee(savedOld));
				}
			}
			return {
				wtype, old: savedOld,
				write(tee) {
					// `wtype` (not the earlier `physical`) -- the value on the stack here was already
					// coerced to `wtype` by the caller (`emitAssign`'s `emitAs(right, ctx, target.wtype)`
					// or its compound-op equivalent), so no extra conversion belongs at this call site either.
					const val = ctx.local('$new', wtype);
					ctx.emit(
						I.local.set(val),
						I.local.get(obj),
						I.local.get(idx),
						I.local.get(val),
						I.array.set(typeIndex),
					);
					if (tee)
						ctx.emit(I.local.get(val));
					return val;
				},
			};
		} else {
			throw new Error(`towasm: cannot assign to ${target.type}`);
		}
	}

	// Whether `body` assigns to `this` anywhere -- real TS never allows this (`this` isn't a normal
	// assignable binding), so it has exactly one meaning in this compiler's subset: "this method replaces
	// its own receiver's physical value" (a wasm-GC array/struct can't resize/relocate in place, so
	// `Array<T>.push`/`pop`/`shift`/`unshift` etc need a fresh backing value, not an in-place mutation).
	// Detected structurally from the declared body, like `scanInlineMethods`'s asm-body recognition --
	// *any* method on *any* class that does this gets the same treatment (`ensureMethod`'s `reassignsThis`),
	// not a hardcoded list of names on one specific class.
	function assignsToThis(body: Statement[]): boolean {
		return walkB(body, undefined, (e, process) =>
			e.type === 'binary' && e.operator === '=' && e.left.type === 'this' ? true : process(e));
	}

	// Whether this constructor supplies `this` directly via its own return value (`return <expr>;`, as its
	// own last statement) rather than the ordinary implicit field-collect/`struct.new` construction
	// (`ensureCtor`'s other branch). Only `Array<T>`'s constructor does this today (`return Array._alloc(n)
	// as unknown as Array<T>`), but nothing here names it -- any class whose constructor ends this way gets
	// the same treatment.
	function ctorReturnsValue(body: Statement[]): boolean {
		const last = body[body.length - 1];
		return !!last && last.type === 'return' && !!last.argument;
	}

	// If `body`'s own last statement (already known, via `ctorReturnsValue`, to be `return <expr>;`) is,
	// after stripping any `as` cast (compile-time-only, see `emitExpr`'s own `case 'as'`), a call to one of
	// this same class's own static helpers (`Array._alloc(n)`, a method; `String.alloc(0)`, an asm-valued
	// field -- both shapes checked), returns that helper's own declared return type -- it stands in for the
	// constructor's, generically, with no compilation involved (`ensureClass` explains why none would even
	// be safe here yet).
	function ctorReturnHelper(info: ClassInfo, body: Statement[]): Type | undefined {
		const last = body[body.length - 1];
		if (last.type !== 'return' || !last.argument)
			return undefined;
		let e = last.argument;
		while (e.type === 'as')
			e = e.expression;
		if (e.type !== 'call' || e.callee.type !== 'member' || e.callee.object.type !== 'identifier' || e.callee.object.name !== info.decl.name)
			return undefined;
		const property = e.callee.property;
		const method = info.methodDecls.get(property);
		if (method)
			return method.returnType as Type | undefined;
		const field = info.decl.body.find(m => m.type === 'field' && m.key === property);
		return field?.type === 'field' && isAsm(field.value) ? (field.value as JS.Call<Type>).typeArgs?.[1] : undefined;
	}

	// `want`, when passed, is a hint only -- the caller's own desired type (from `emitAs`), used solely to
	// let a literal pick its physical representation directly instead of picking one arbitrarily and
	// having `coerceTop` immediately convert it back (a pure wasted round-trip for a compile-time-known
	// value). The returned `WasmType` is still always the *actual* physical type left on the stack.
	function emitExpr(e: Expr, ctx: FuncCtx, want?: WasmType): WasmType {
		switch (e.type) {
			case 'literal':
				if (Array.isArray(e.value)) {
					for (const p of e.value)
						emitStringConst(p.str, ctx);
					ctx.emit(I.array.new_fixed(builtinArrayOwners.ref.typeIndex, e.value.length));
					for (const p of e.value) {
						if (p.exp)
							emitAs(p.exp, ctx, 'f64');
					}
					ctx.emit(I.array.new_fixed(builtinArrayOwners.f64.typeIndex, e.value.length - 1));
					const decl = LIB_DECL_MAP.get('stringTemplate');
					if (decl && decl.type === 'function_decl') {
						const info = funcs.get('stringTemplate') ?? ensureFunc('stringTemplate', decl);
						if (info)
							ctx.emit(I.call(info.funcIndex));
					}
					return ARR_WTYPE.i16;
				}
				switch (typeof e.value) {
					case 'number':
						if (want !== 'f64' && e.value === (e.value | 0)) {
							ctx.emit(I.i32.const(e.value));
							return 'i32';
						}
						ctx.emit(I.f64.const(e.value));
						return 'f64';

					case 'boolean':
						ctx.emit(I.i32.const(e.value ? 1 : 0));
						return 'i32';

					case 'string':
						emitStringConst(e.value, ctx);
						return ARR_WTYPE.i16;

					case 'bigint':
						ctx.emit(I.i64.const(e.value));
						return 'i64';

					default:
						throw new Error(`towasm: unsupported literal type '${typeof e.value}'`);
				}

			case 'identifier':
			case 'this': {
				// `NaN`/`Infinity` are real globals, not locals -- constant-fold directly rather than
				// routing through `ctx.lookup`, same as `isNullLiteral`'s `undefined` special-case.
				if (e.type === 'identifier' && e.name === 'NaN') {
					ctx.emit(I.f64.const(NaN));
					return 'f64';
				}
				if (e.type === 'identifier' && e.name === 'Infinity') {
					ctx.emit(I.f64.const(Infinity));
					return 'f64';
				}
				const name = e.type === 'this' ? 'this' : e.name;
				// A captured free variable has no real local of its own -- read via `struct.get` off the
				// cast env local instead. Checked before `ctx.lookup`, since it's never also in `ctx.locals`.
				const captured = ctx.closureEnv?.fields.get(name);
				if (captured) {
					ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index), I.struct.get(ctx.closureEnv!.envTypeIndex, captured.index));
					return captured.wtype;
				}
				const local = ctx.lookup(name);
				ctx.emit(I.local.get(local.index));
				return local.wtype;
			}

			case 'member': {
				rejectChainedOptional(e.object);

				if (e.object.type === 'identifier') {
					const owner = namespaceOwner(e.object.name, ctx);
					if (owner) {
						const f = owner.decl.body.find(m => m.type === 'field' && m.key === e.property && m.modifiers?.includes('static'));
						if (!f || f.type !== 'field' || !f.value)
							throw new Error(`towasm: unknown static field '${owner.name}.${e.property}'`);
						return emitExpr(f.value, ctx);
					}
				}

				// `Uint8Array`/`Int32Array`/`Uint32Array`/`ArrayBuffer`'s `.length`/`.buffer`/`.byteOffset`/
				// `.byteLength` need no special-casing here at all -- they're real fields on real classes
				// (`lib/typedarray.ts`), so the ordinary class-field read below (`classOf`/`fieldIndex`)
				// already handles them, same as any other class's field.

				const cls = classOf(e.object, ctx);

				// A `get` accessor -- checked before both the `.length` special case right below and the
				// ordinary struct-field read, so a real getter (e.g. `Array<T>.length`) takes priority over
				// either. Probed by name the same way `methodSig` already does for index dispatch.
				if (cls?.getterNames?.has(e.property)) {
					if (e.optional)
						throw new Error(`towasm: 'a?.${e.property}' on a getter is not supported`);
					emitExpr(e.object, ctx);
					return emitMethodCall(cls, accessorKey('get', e.property), [], ctx);
				}

				if (e.property === 'length' && arrayKindOf(e.object, ctx)) {
					if (e.optional)
						rejectNullablePrimitive('f64', "a?.length");
					emitExpr(e.object, ctx);
					ctx.emit(I.array.len);
					// Unsigned: `array.len` can in principle exceed i32's signed range, so this needs
					// `convert_i32_u` specifically, not `emitAs`'s generic signed coercion.
					ctx.emit(I.f64.convert_i32_u);
					return 'f64';
				}
				const fieldIdx	= cls?.fieldIndex.get(e.property);
				if (!cls || fieldIdx === undefined)
					throw new Error(`towasm: unknown field '${e.property}'`);
				const fieldWtype = cls.fields[fieldIdx].wtype;

				if (e.optional) {
					rejectNullablePrimitive(fieldWtype, `a?.${e.property}`);
					const objWtype = wtypeOf(e.object, ctx);
					if (!objWtype)
						throw new Error(`towasm: 'a?.${e.property}' has an unsupported object type`);
					emitAs(e.object, ctx, objWtype);
					return emitOptionalAccess(ctx, objWtype, { ...fieldWtype, nullable: true }, objLocal =>
						ctx.emit(I.local.get(objLocal.index), I.struct.get(cls.typeIndex, fieldIdx)));
				}

				// `emitAs`, not a raw `emitExpr` -- `e.object` may itself be a ref-kind array element read
				// (`a[i].field`, `case 'index'` above), whose *physical* value is always boxed `anyref`
				// regardless of its declared class -- `struct.get` needs the real narrowed `(ref cls)` first,
				// or wasm validation rejects it outright (found via `a[0].v` on a ref-kind `Array<T>`: "struct.get
				// expected type (ref null N), found ... anyref"). A no-op when `e.object` is already
				// concretely typed (`coerceTop`'s `wasmTypeEq` short-circuit).
				emitAs(e.object, ctx, { ref: cls.name });
				ctx.emit(I.struct.get(cls.typeIndex, fieldIdx));
				return fieldWtype;
			}

			case 'index': {
				rejectChainedOptional(e.object);
				// An element is always number/boolean-typed (no array-of-refs in this subset), so `a?.[i]`'s
				// result always hits `rejectNullablePrimitive`'s restriction -- throws unconditionally up front.
				if (e.optional)
					rejectNullablePrimitive('f64', 'a?.[i]');
				// Any class with its own `get(i)` (typed-array views, or any other class using the same
				// convention) -- real index syntax dispatched generically, not by name.
				const cls = classOf(e.object, ctx);
				if (cls && methodSig(cls, 'get', ctx)) {
					emitExpr(e.object, ctx);
					return emitMethodCall(cls, 'get', [e.property], ctx);
				}
				const kind = arrayKindOf(e.object, ctx);
				if (!kind || kind === 'i16')
					throw new Error("towasm: indexing is only supported on number[]/boolean[]/Uint8Array/Int32Array/Uint32Array ('string' is immutable and not indexable in this pass)");
				emitExpr(e.object, ctx);
				emitAs(e.property, ctx, 'i32');
				ctx.emit(I.array.get(builtinArrayOwners[kind].typeIndex));
				return kind === 'ref' ? {ref: 'any'} : kind;
			}

			// `as`/`as unknown as X` is compile-time-only in real TS too -- a no-op here: compile the inner
			// expression and pass its actual `WasmType` straight through, ignoring the asserted one entirely.
			case 'as':
				return emitExpr(e.expression, ctx, want);

			// Only ever types as `number[]`/`boolean[]`; `new Uint8Array([...])`/etc above handle typed arrays.
			case 'array': {
				const kind = arrayKindOf(e, ctx);
				if (!kind || kind === 'i16' || kind === 'ref')
					throw new Error('towasm: array literals are only supported for number[]/boolean[]');
				emitArrayElements(e.elements, ctx, kind, kind, builtinArrayOwners[kind].typeIndex);
				return ARR_WTYPE[kind];
			}

			case 'unary': {
				if (e.operator === '++' || e.operator === '--') {
					const target	= emitAssignTarget(e.operand, ctx, 'discard');
					const wtype		= target.wtype;
					if (wtype !== 'i32' && wtype !== 'f64')
						throw new Error("towasm: '++'/'--' is only supported on number/boolean-kind locals");

					ctx.emit(
						I[wtype].const(1),
						I[wtype][e.operator === '++' ? 'add' : 'sub']
					);

					target.write(true);
					return wtype;
				}

				const builtin = builtins['prefix' + e.operator];
				if (builtin) {
					const result = builtin([operandInfo(e.operand, ctx)], ctx);
					// A `'prefix'`-mangled key can never collide with a real function name -- an internal
					// inconsistency, not a user error, same reasoning as `emitCall`'s `'owner' in` check.
					if ('type' in result || 'owner' in result)
						throw new Error(`towasm: internal: 'prefix${e.operator}' resolved to a ${'type' in result ? 'function' : 'method'} delegate outside its own dispatch`);
					if (e.operator === '-' && (result.params[0] === 'i32' || result.params[0] === 'i64')) {
						const wtype = result.params[0];
						const old = ctx.swapOut();
						emitAs(e.operand, ctx, wtype);
						const operand = ctx.swapOut(old);
						if (wtype === 'i32')
							ctx.emit(I.i32.const(0), ...operand, I.i32.sub);
						else
							ctx.emit(I.i64.const(0n), ...operand, I.i64.sub);
						return result.result;
					}
					emitAs(e.operand, ctx, result.params[0]);
					ctx.emit(...result.inline);
					return result.result;
				}
				throw new Error(`towasm: unsupported unary operator '${e.operator}'`);
			}

			case 'unary_post':
				if (e.operator === '!')
					return emitExpr(e.operand, ctx, want);
				if (e.operator === '++' || e.operator === '--') {
					const target	= emitAssignTarget(e.operand, ctx, 'keep');
					const wtype		= target.wtype;
					if (wtype !== 'i32' && wtype !== 'f64')
						throw new Error("towasm: '++'/'--' is only supported on number/boolean-kind locals");

					ctx.emit(
						I[wtype].const(1),
						I[wtype][e.operator === '++' ? 'add' : 'sub']
					);

					target.write(false);
					ctx.emit(I.local.get(target.old!));
					return wtype;
				}
				throw new Error(`towasm: unsupported postfix operator '${e.operator}'`);

			case 'conditional': {
				const wtype = wtypeOf(e, ctx);
				if (!wtype)
					throw new Error('towasm: conditional expression has an unsupported type');
				emitTruthy(e.test, ctx);
				const old = ctx.swapOut();
				emitAs(e.consequent, ctx, wtype);
				const _then = ctx.swapOut();
				emitAs(e.alternate, ctx, wtype);
				const _else = ctx.swapOut(old);
				ctx.emit(I.if(toValType(wtype), _then, _else));
				return wtype;
			}

			case 'new': {
				if (e.callee.type === 'identifier' && e.callee.name === 'ArrayBuffer') {
					if (e.arguments.length !== 1 || e.arguments[0].type === 'spread')
						throw new Error("towasm: 'new ArrayBuffer(...)' needs exactly one argument (a byte length)");
					const byteLenArg = e.arguments[0];
					emitNewArrayBufferOfSize(ctx, () => emitAs(byteLenArg, ctx, 'i32'));
					return classWtype('ArrayBuffer');
				}
				// `Uint8Array`/`Int32Array`/`Uint32Array`: real views over linear memory (`lib/typedarray.ts`),
				// supporting all four of real JS's constructor forms -- a length (own fresh buffer), an
				// array literal (own fresh buffer, pre-filled via each element's real `set(i,v)`), a whole
				// existing `ArrayBuffer` (a real aliasing view -- writes through one view are visible
				// through another over the same bytes), or an explicit `(buffer, byteOffset[, length])`
				// sub-view. Which constructor form applies is a compile-time-only decision (arg count/
				// shape) this narrow subset has no other way to express -- there's no runtime overload
				// resolution here, so this one piece of construction logic stays in towasm.ts itself.
				if (e.callee.type === 'identifier' && e.callee.name in TYPED_ARRAY_ALIASES) {
					const kind = e.callee.name;
					const elemSize = TYPED_ARRAY_ALIASES[kind].elemSize;
					const args = e.arguments;
					if (args.some(a => a.type === 'spread'))
						throw new Error(`towasm: 'new ${kind}(...)' does not support spread arguments`);

					if (args.length === 1 && args[0].type === 'array') {
						const elements = args[0].elements;
						if (elements.some(el => !el))
							throw new Error(`towasm: 'new ${kind}([...])' does not support holes`);
						const n = elements.length;
						const view = emitNewTypedArrayView(ctx, kind, elemSize,
							() => emitNewArrayBufferOfSize(ctx, () => ctx.emit(I.i32.const(n * elemSize))),
							() => ctx.emit(I.i32.const(0)),
							() => ctx.emit(I.i32.const(n)));
						const viewLocal = ctx.local('$taLit', view);
						ctx.emit(I.local.set(viewLocal));
						const cls = ensureClass(kind)!;
						elements.forEach((el, i) => {
							ctx.emit(I.local.get(viewLocal));
							emitMethodCall(cls, 'set', [Literal(i), el as Expr], ctx);
						});
						ctx.emit(I.local.get(viewLocal));
						return view;
					}

					if (args.length >= 1 && args.length <= 3 && T.isRef(checker.typeOf(args[0], ctx.scope), 'ArrayBuffer')) {
						const bufferArg = args[0];
						const byteOffsetArg = args[1];
						const lengthArg = args[2];
						return emitNewTypedArrayView(ctx, kind, elemSize,
							() => emitExpr(bufferArg, ctx),
							byteOffsetArg ? () => emitAs(byteOffsetArg, ctx, 'i32') : () => ctx.emit(I.i32.const(0)),
							lengthArg
								? () => emitAs(lengthArg, ctx, 'i32')
								: (bufLocal, offLocal) => {
									const bufCls = ensureClass('ArrayBuffer')!;
									ctx.emit(I.local.get(bufLocal), I.struct.get(bufCls.typeIndex, bufCls.fieldIndex.get('byteLength')!), I.local.get(offLocal), I.i32.sub);
									if (elemSize !== 1)
										ctx.emit(I.i32.const(elemSize), I.i32.div_u);
								});
					}

					if (args.length === 1) {
						const nLocal = ctx.local('$taLen', 'i32');
						emitAs(args[0], ctx, 'i32');
						ctx.emit(I.local.set(nLocal));
						return emitNewTypedArrayView(ctx, kind, elemSize,
							() => emitNewArrayBufferOfSize(ctx, () => {
								ctx.emit(I.local.get(nLocal));
								if (elemSize !== 1)
									ctx.emit(I.i32.const(elemSize), I.i32.mul);
							}),
							() => ctx.emit(I.i32.const(0)),
							() => ctx.emit(I.local.get(nLocal)));
					}

					throw new Error(`towasm: 'new ${kind}(...)' needs a length, an array literal, or (buffer[, byteOffset[, length]])`);
				}
				if (e.callee.type === 'identifier' && e.callee.name === 'String') {
					if (e.arguments.length === 0) {
						ctx.emit(I.array.new_fixed(builtinArrayOwners.i16.typeIndex, 0));
						return ARR_WTYPE.i16;
					}
					if (e.arguments.length === 1 && ownerOf(e.arguments[0], ctx)?.name === 'String') {
						// Real JS distinguishes a boxed `new String(s)` from the primitive `s` -- this
						// compiler has no such distinction and rejects string `===` entirely, so returning
						// the same value is exact, not approximate.
						return emitExpr(e.arguments[0], ctx);
					}
					throw new Error("towasm: 'new String(...)' only supports zero arguments or one existing string -- stringifying a number/boolean/etc is not supported in this pass");
				}
				// `new Array<T>(n)` -- `Array<T>`'s own real constructor (`lib/array.ts`) explicitly `return`s
				// a freshly-allocated array, so `ensureClass`/`ensureCtor` already compile it like any other
				// class's constructor (see `ctorReturnsValue`) -- no dedicated branch needed here.
				if (e.callee.type !== 'identifier')
					throw new Error(`towasm: 'new' is only supported for a known class, 'Uint8Array', or 'String'`);
				const cls = ensureClass(e.callee.name, e.typeArgs);
				if (!cls)
					throw new Error(`towasm: 'new' is only supported for a known class, 'Uint8Array', or 'String'`);
				const ctor = ensureCtor(cls);
				if (e.arguments.some(a => a.type === 'spread'))
					throw new Error(`towasm: '${e.callee.name}''s constructor takes exactly ${ctor.params.length} (non-spread) argument(s)`);
				const args = fillDefaultArgs(`${e.callee.name}'s constructor`, ctor.params, ctor.defaults, e.arguments);
				args.forEach((a, i) => emitAs(a, ctx, ctor.params[i]));
				ctx.emit(I.call(ctor.funcIndex));
				return cls.thisWtype!;
			}

			case 'call': {
				// A bare `__asm<[Params],Result>('...')(args...)` call, anywhere an expression is allowed --
				// not just as a class member's sole body statement (`scanInlineMethods`'s narrower, pre-scanned
				// recognition). `$this`/element-kind resolve from whatever `ctx.owner` currently is (a class's
				// own typeIndex/physical representation, when compiling one of its methods) -- the same
				// information `scanInlineMethods` threads down as a param, just read live here instead of
				// pre-computed, so this works inside an ordinary top-level function body too (no owner, no
				// `$this` needed unless the asm text actually references it).
				if (e.callee.type === 'call' && isAsm(e.callee)) {
					if (e.arguments.some(a => a.type === 'spread'))
						throw new Error('towasm: inline asm does not support spread call arguments');
					const owner = ctx.owner;
					const ownerCls = owner && 'fields' in owner ? owner as ClassInfo : undefined;
					const builtin = makeAsmBuiltin('<inline>', e.callee, owner?.name ?? '<top-level>', owner?.typeIndex ?? -1,
						ownerCls && typeof ownerCls.thisWtype !== 'string' && ownerCls.thisWtype && 'arr' in ownerCls.thisWtype ? ownerCls.thisWtype.arr : undefined);
					if (!builtin)
						throw new Error('towasm: inline asm failed to resolve (see the console warning above for details)');
					return emitInline('<inline>', builtin(e.arguments.map(a => operandInfo(a, ctx)), ctx), e.arguments, ctx);
				}

				// `obj?.method(...)` -- the `?.` sits on the `member` callee, not the `call` itself. Treated
				// as one guarded operation: `obj` is evaluated once, checked for null, and the whole call
				// only happens in the non-null arm -- restricted to a real user method (`ensureMethod`, not
				// a `Math`/prelude intrinsic whose result type depends on the actual call site).
				if (e.callee.type === 'member' && e.callee.optional) {
					const objExpr = e.callee.object;
					rejectChainedOptional(objExpr);
					const methodName = e.callee.property;
					const objWtype = wtypeOf(objExpr, ctx);
					if (!objWtype || typeof objWtype === 'string')
						throw new Error(`towasm: 'a?.${methodName}(...)' needs an object-typed value on its left`);
					const owner = ownerOf(objExpr, ctx);
					if (!owner)
						throw new Error(`towasm: unknown method '${methodName}'`);
					const method = ensureMethod(owner, methodName);
					if (!method)
						throw new Error(`towasm: 'a?.${methodName}(...)' is not supported -- only a plain user-defined method (not a 'Math'/prelude intrinsic) can be guarded by '?.' in this pass`);
					if (method.result === 'void')
						throw new Error(`towasm: 'a?.${methodName}(...)' is not supported -- '${methodName}' returns 'void', which can't become 'void | undefined'`);
					rejectNullablePrimitive(method.result, `a?.${methodName}(...)`);
					emitAs(objExpr, ctx, objWtype);
					return emitOptionalAccess(ctx, objWtype, { ...method.result, nullable: true }, objLocal => {
						// Receiver pushed directly, skipping `emitMethodCall`'s own `receiver` param. `call`'s
						// param types are exact-matched, so the receiver needs an explicit `ref.as_non_null`
						// here -- always sound, since `readCore` only runs in the already-proven-non-null arm.
						ctx.emit(I.local.get(objLocal.index), I.ref.as_non_null);
						emitMethodCall(owner, methodName, e.arguments, ctx);
					});
				}

				if (e.callee.type === 'member') {
					rejectChainedOptional(e.callee.object);
					const obj = e.callee.object;
					// `indexOf`/`lastIndexOf`/`includes`/`reverse`/`slice`/`fill`/`concat`/`subarray` on a
					// typed array are real class methods now (`lib/typedarray.ts`), so they need no
					// special-casing here at all -- they fall straight through to the ordinary
					// `ownerOf`/`emitMethodCall` dispatch below, same as any other class's methods.
					if (obj.type === 'identifier') {
						const owner = namespaceOwner(obj.name, ctx);
						if (owner)
							return emitMethodCall(owner, e.callee.property, e.arguments, ctx);
						const name = `${obj.name}.${e.callee.property}`;
						if (name in builtins)
							return emitCall(name, e.arguments, ctx);
					}
					const owner = ownerOf(obj, ctx);
					if (!owner)
						throw new Error(`towasm: unknown method '${e.callee.property}'`);
					// A method that reassigns `this` (`ensureMethod`'s `reassignsThis`, see `assignsToThis`)
					// needs its receiver's real physical lvalue, not just its current value -- `emitAssignTarget`
					// (`'keep'`) pushes that value for the call itself *and* sets up the write-back, reusing
					// the exact machinery compound assignment/`++`/`--` already use. The callee itself already
					// arranges to leave its own updated `this` as an extra wasm-level result (see `ensureMethod`/
					// `case 'return'`'s `appendThisOnReturn`); `target.write` consumes exactly that, leaving the
					// method's ordinary declared result underneath as this call expression's own value. A
					// receiver with nothing to write back to (`foo().push(x)`) gets `emitAssignTarget`'s own
					// "cannot assign to X" error, for free.
					if (ensureMethod(owner, e.callee.property)?.reassignsThis) {
						const target = emitAssignTarget(obj, ctx, 'keep');
						const result = emitMethodCall(owner, e.callee.property, e.arguments, ctx);
						target.write(false);
						return result;
					}
					emitExpr(obj, ctx);
					return emitMethodCall(owner, e.callee.property, e.arguments, ctx);
				}
				// A closure value, called directly (`callback(x)`) -- checked via `ctx.resolvesName` (a real
				// local/param/capture), so a local genuinely shadowing a same-named global function correctly
				// takes priority, matching real JS scoping. Restricted to a bare identifier callee for now
				// (not e.g. a closure-typed class field, `obj.field(x)`) -- v1 scope, not a fundamental limit.
				if (e.callee.type === 'identifier' && ctx.resolvesName(e.callee.name)) {
					const calleeWtype = resolvedWtype(ctx, e.callee.name);
					if (typeof calleeWtype !== 'string' && 'closure' in calleeWtype) {
						if (e.arguments.some(a => a.type === 'spread'))
							throw new Error('towasm: spread call arguments are not supported');
						const sig = calleeWtype.closure;
						if (e.arguments.length !== sig.params.length)
							throw new Error(`towasm: closure call needs exactly ${sig.params.length} argument(s)`);
						const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
						emitExpr(e.callee, ctx);
						const scratch = ctx.declareLocal(`$closure$${closureCallTempCounter++}`, calleeWtype);
						ctx.emit(I.local.tee(scratch.index), I.struct.get(structTypeIndex, 1));
						sig.params.forEach((pt, i) => emitAs(e.arguments[i], ctx, pt));
						// The code pointer (funcref) is pushed last -- `call_ref` consumes it off the stack top,
						// after every real argument.
						ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0));
						ctx.emit(I.call_ref(funcTypeIndex));
						return sig.result;
					}
				}

				if (e.callee.type !== 'identifier')
					throw new Error('towasm: only direct calls to named functions, methods, or Math intrinsics are supported');

				return emitCall(e.callee.name, e.arguments, ctx);
			}

			case 'binary': {
				const op = e.operator;
				if (ASSIGN_OPS.has(op))
					return emitAssign(e, ctx, true);

				if (op === '&&') {
					emitTruthy(e.left, ctx);
					const old = ctx.swapOut();
					emitTruthy(e.right, ctx);
					const _right = ctx.swapOut(old);
					ctx.emit(I.if('i32', _right, [I.i32.const(0)]));
					return 'i32';
				}
				if (op === '||') {
					emitTruthy(e.left, ctx);
					const old = ctx.swapOut();
					emitTruthy(e.right, ctx);
					const _right = ctx.swapOut(old);
					ctx.emit(I.if('i32', [I.i32.const(1)], _right));
					return 'i32';
				}
				// `x === null`/`x !== undefined`/etc -- checked ahead of `equalityInline`, which picks its
				// comparison kind from the left operand's `WasmType` alone; a bare null literal has none, so
				// `null === x` would otherwise silently fall back to `f64`. Also the more direct lowering
				// either way: a real `ref.is_null` check, not `ref.eq` against a synthesized null.
				if (op === '===' || op === '!==' || op === '==' || op === '!=') {
					const leftIsNull	= isNullLiteral(e.left);
					const rightIsNull	= isNullLiteral(e.right);
					if (leftIsNull || rightIsNull) {
						const negate = op === '!==' || op === '!=';
						if (leftIsNull && rightIsNull) {
							// `null === null`/`null === undefined` -- always true, no value to check.
							ctx.emit(I.i32.const(negate ? 0 : 1));
							return 'i32';
						}
						const valueExpr	= leftIsNull ? e.right : e.left;
						const wt		= wtypeOf(valueExpr, ctx);
						if (!wt || typeof wt === 'string' || !wt.nullable)
							throw new Error("towasm: comparing to 'null'/'undefined' needs a nullable object-typed value on the other side");
						emitAs(valueExpr, ctx, wt);
						ctx.emit(I.ref.is_null);
						if (negate)
							ctx.emit(I.i32.eqz);
						return 'i32';
					}
				}
				// `a ?? b` -- `a`'s combined-with-`b` type drives the `if`'s result; `a` itself must actually
				// be nullable (real TS itself flags the "b could never run" case, not this pass).
				if (op === '??') {
					const wtype = wtypeOf(e, ctx);
					if (!wtype)
						throw new Error("towasm: '??' has an unsupported result type");
					const leftWtype = wtypeOf(e.left, ctx);
					if (!leftWtype || typeof leftWtype === 'string' || !leftWtype.nullable)
						throw new Error("towasm: '??' needs a nullable object-typed value on its left (the right side is only evaluated when the left is null/undefined)");
					emitAs(e.left, ctx, leftWtype);
					const leftLocal = ctx.declareLocal(`$nullish$left$${optionalTempCounter++}`, leftWtype);
					ctx.emit(I.local.set(leftLocal.index));
					ctx.emit(I.local.get(leftLocal.index), I.ref.is_null);
					const old = ctx.swapOut();
					emitAs(e.right, ctx, wtype);
					const _then = ctx.swapOut();
					ctx.emit(I.local.get(leftLocal.index));
					coerceTop(leftWtype, ctx, wtype);
					const _else = ctx.swapOut(old);
					ctx.emit(I.if(toValType(wtype), _then, _else));
					return wtype;
				}
				const builtin = builtins[op];
				if (!builtin)
					throw new Error(`towasm: unsupported binary operator '${op}'`);
				if (e.left.type === 'literal' && e.right.type === 'literal') {
					// Constant-folding -- the builtin's `inline` is a concrete `WasmType`, not a delegate.
				}
				const inline = builtin([operandInfo(e.left, ctx), operandInfo(e.right, ctx)], ctx);
				if ('type' in inline)
					throw new Error(`towasm: internal: '${op}' resolved to a function delegate outside its own dispatch`);
				if ('owner' in inline) {
					emitExpr(e.left, ctx);
					return emitMethodCall(inline.owner, inline.method, [e.right], ctx);
				}
				emitAs(e.left, ctx, inline.params[0]);
				emitAs(e.right, ctx, inline.params[1]);
				ctx.emit(...inline.inline);
				return inline.result;
			}

			// Closures: a captured arrow/function-expression literal compiles to a 2-field `{code, env}`
			// wasm-GC struct (see `ensureClosureType`) -- building it here, at the literal's own source
			// location, is "closure creation"; `emitExpr`'s `'call'` case handles *using* the result. v1
			// restrictions (see this file's header comment) are all explicit throws, never silent misbehavior.
			case 'arrow':
			case 'function': {
				if (e.modifiers?.includes('async'))
					throw new Error('towasm: an async arrow/function expression is not supported');
				if (e.modifiers?.includes('generator'))
					throw new Error('towasm: a generator function expression is not supported');
				if (e.typeParams?.length)
					throw new Error('towasm: a generic arrow/function expression is not supported');
				if (e.rest)
					throw new Error('towasm: a rest parameter in an arrow/function expression is not supported');

				const body: Statement[] | Expr = e.type === 'arrow' ? e.body : (e.body ?? []);
				const selfName = e.type === 'function' ? e.name : undefined;
				if (selfName && walkB(body, undefined, (e, process) => e.type === 'identifier' && e.name === selfName ? true : process(e)))
					throw new Error(`towasm: a named function expression referencing its own name ('${selfName}') is not supported`);

				const params = e.params.map(p => {
					if (p.default)
						throw new Error(`towasm: closure parameter '${describeBinding(p.key)}' cannot have a default value`);
					if (p.modifiers?.includes('optional'))
						throw new Error(`towasm: closure parameter '${describeBinding(p.key)}' cannot be optional`);
					const wt = p.typeAnnotation && typeOf(p.typeAnnotation as Type);
					if (!wt || wt === 'void')
						throw new Error(`towasm: closure parameter '${describeBinding(p.key)}' needs an explicit number/boolean/object type`);
					return wt;
				});
				const result = e.returnType ? typeOf(e.returnType as Type) : 'void';
				if (!result)
					throw new Error('towasm: closure has an unsupported return type');

				const free = new Set<string>();
				collectFreeVars(ownBoundNames(paramNames(e.params), body, selfName), body, free);

				if (e.type === 'function' && free.has('this'))
					throw new Error("towasm: 'this' inside a function expression is not supported -- only an arrow function's lexical 'this' is");
				for (const name of free) {
					if (!ctx.resolvesName(name))
						throw new Error(`towasm: unresolved identifier '${name}'`);
				}

				// This literal's own concrete env struct type -- zero captures just reuses `$envBase`
				// directly (no distinct type, no cast needed in the compiled body either).
				const envBase = ensureEnvBase();
				const capturedNames = [...free];
				const fields = capturedNames.length ? new Map<string, { index: number; wtype: WasmType }>() : undefined;
				let envTypeIndex = envBase;
				if (fields) {
					envTypeIndex = registerType({ final: true, supertypes: [envBase], type: { kind: 'struct', fields: capturedNames.map((name, i) => {
						const wt = resolvedWtype(ctx, name);
						fields.set(name, { index: i, wtype: wt });
						return { type: toValType(wt), mut: true };
					}) } });
				}

				const sig: FuncSig = { params, result };
				const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
				const { funcIndex, typeIndex } = registerFuncAtType(funcTypeIndex);
				const info: FuncInfo = { params, result, funcIndex, typeIndex };
				closureLiterals.push(info);

				worklist.push(() => {
					const fnCtx = new FuncCtx(new Scope(libGlobal), result);
					// Env param first (real wasm param index 0), then this literal's own real params --
					// `toFuncBody`'s `numParams` below assumes the first `1 + params.length` declared
					// locals are the real wasm params, in that order.
					const envParam	= fnCtx.declareLocal('#envParam', { typeIndex: envBase, nullable: false });
					const pending	= fnCtx.declareParams(e.params, params);
					// The cast-down env local (or, with no captures, just the param itself) is declared after the real params, so it's a genuine local, not mistaken for one more wasm param.
					let envLocal	= envParam;
					if (fields) {
						envLocal = fnCtx.declareLocal('#env', { typeIndex: envTypeIndex, nullable: false });
						fnCtx.emit(I.local.get(envParam.index), I.ref.cast(envTypeIndex), I.local.set(envLocal.index));
					}
					fnCtx.closureEnv = { envLocal, envTypeIndex, fields: fields ?? new Map() };
					for (const name of capturedNames) {
						const tsType = ctx.scope.value(name);
						if (tsType)
							fnCtx.declareCaptured(name, tsType);
					}
					pending.forEach(st => emitStmt(st, fnCtx));
					if (Array.isArray(body)) {
						body.forEach(st => emitStmt(st, fnCtx));
						emitTrailingUnreachable(fnCtx, result);
					} else {
						emitStmt({ type: 'return', argument: body }, fnCtx);
					}
					info.body = fnCtx.toFuncBody(1 + params.length, toValType);
				});

				// Creation site: `struct.new` pops fields in declaration order (first-declared pushed first/
				// deepest -- see `ensureClosureType`'s `[code, env]` order), so the code pointer goes on the
				// stack before the env struct. Each captured value is read via the identifier-read case
				// above, so a capture-of-a-capture resolves the same way a plain local does.
				ctx.emit(I.ref.func(funcIndex));
				for (const name of capturedNames)
					emitExpr(name === 'this' ? { type: 'this' } : { type: 'identifier', name }, ctx);
				ctx.emit(fields ? I.struct.new(envTypeIndex) : I.struct.new_default(envBase));
				ctx.emit(I.struct.new(structTypeIndex));
				return { closure: sig };
			}

			default:
				throw new Error(`towasm: unsupported expression '${e.type}'`);
		}
	}

	// Handles `=` and every compound operator, for every assignable target -- `tee` says whether the
	// assigned value should be left on the stack afterward (a sub-expression) or not (a bare statement).
	// `member`/`index` targets go through `emitAssignTarget`: unlike `local.tee`, `struct.set`/`array.set`
	// have no variant leaving the value on the stack, so `tee` needs an extra `local.get` off the scratch.
	function emitAssign(e: Binary<Expr, string>, ctx: FuncCtx, tee: boolean): WasmType {
		const { left, right, operator } = e;

		// A compound op reads the current value only to combine it with `right` -- never touches `.old` afterward, so `'discard'`, not `'keep'`
		const target =	emitAssignTarget(left, ctx, operator !== '=' ? 'discard' : 'none');
		const wtype = target.wtype;

		if (operator === '=') {
			emitAs(right, ctx, target.wtype);
		} else {
			const baseOp = operator.slice(0, -1);
			const builtin = builtins[baseOp];
			if (!builtin)
				throw new Error(`towasm: unsupported compound-assignment operator '${baseOp}='`);
			// The owner (identity) comes from the checker's own type for `left`, not a guess off the physical
			// `WasmType` alone -- `{arr:'i16'}` happens to mean "string" today, but pattern-matching on that
			// shape is exactly the fragility `equalityInline`'s owner-based bigint/string checks avoid.
			const inline = builtin([{ wtype, owner: ownerOf(left, ctx) }, operandInfo(right, ctx)], ctx);
			if ('type' in inline)
				throw new Error(`towasm: internal: '${baseOp}=' resolved to a function delegate outside its own dispatch`);
			if ('owner' in inline) {
				emitMethodCall(inline.owner, inline.method, [right], ctx);
			} else {
				coerceTop(wtype, ctx, inline.params[0]);
				emitAs(right, ctx, inline.params[1]);
				ctx.emit(...inline.inline);
				coerceTop(inline.result, ctx, wtype);
			}
		}

		target.write(tee);
		return target.wtype;
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
					if (!d.init)
						throw new Error(`towasm: local '${describeBinding(d.name)}' needs an initializer`);
					if (typeof d.name !== 'string') {
						// Materializes `d.init` into a hidden scratch local once (`#destructure$<n>`), then
						// desugars into plain `var_decl`s reading their own piece back off it.
						const tmpName = `#destructure$${destructureTempCounter++}`;
						emitStmt({ type: 'block', body: [
							JS.VarDecl('const', JS.Var(tmpName, d.init, d.typeAnnotation)),
							...patternBindings(d.name, { type: 'identifier', name: tmpName }),
						] }, ctx);
						continue;
					}
					// Type computed before emitting the init, so the init can be emitted via `emitAs` straight into the local's declared representation
					const {methodOwner, methodName} = d.init.type === 'call' && d.init.callee.type === 'member'
						? {methodOwner: ownerOf(d.init.callee.object, ctx), methodName: d.init.callee.property}
						: {};

					// No `Array<T>` substitution needed -- `substElemMethods` already monomorphized a method's whole body once, up front, so `d.typeAnnotation` is already concrete here.

					let tsType = d.typeAnnotation;
					if (!tsType && d.init.type === 'index') {
						// The real declared element `Type` of an array-like container -- `T[]`/`Array<T>`'s `T` directly, or the fixed element type real TS gives `Uint8Array`/`Int32Array` indexing
						const w = T.widenLiterals(T.resolve(global, checker.typeOf(d.init.object, ctx.scope)));
						if (w.type === 'array') {
							tsType = w.element;
						} else if (w.type === 'ref') {
							switch (w.name) {
								case 'Array':
								case 'ReadonlyArray':	tsType = w.typeArgs?.[0]; break;
								case 'Uint8Array':
								case 'Int32Array':
								case 'Uint32Array':		tsType = T.NUMBER; break;
							}
						}
					}
					if (!tsType && methodOwner)
						tsType = (methodOwner.decl.body.find(m => m.type === 'method' && m.key === methodName) as MethodMember)?.returnType;

					tsType ??= checker.typeOf(d.init, ctx.scope);

					const wtype = typeOf(tsType);
					if (!wtype) {
						// Let the actual lowering throw its own more specific error first (e.g. indexing a `string`) -- only fall back to this generic message if it didn't.
						emitExpr(d.init, ctx);
						throw new Error(`towasm: local '${d.name}' has an unsupported type`);
					}
					if (wtype === 'void')
						throw new Error(`towasm: local '${d.name}' cannot have type 'void'`);
					emitAs(d.init, ctx, wtype);
					ctx.emit(I.local.set(ctx.declareValue(d.name, wtype, tsType).index));
				}
				return;

			case 'expression':
				if (s.expression.type === 'binary' && ASSIGN_OPS.has(s.expression.operator)) {
					emitAssign(s.expression, ctx, false);
				} else {
					if (emitExpr(s.expression, ctx) !== 'void')
						ctx.emit(I.drop);
				}
				return;

			case 'if': {
				emitTruthy(s.test, ctx);
				const old = ctx.swapOut();
				// `then`/`else` share one wasm label (the `if` itself), not two -- one `depth` bump covers
				// both branches, same as real wasm's implicit label semantics.
				ctx.depth++;
				emitStmt(s.consequent, ctx);
				if (s.alternate) {
					const _then = ctx.swapOut();
					emitStmt(s.alternate, ctx);
					const _else = ctx.swapOut(old);
					ctx.depth--;
					ctx.emit(I.if(undefined, _then, _else));
				} else {
					const _then = ctx.swapOut(old);
					ctx.depth--;
					ctx.emit(I.if(undefined, _then));
				}
				return;
			}

			case 'while': {
				// A `block` wrapping a `loop`: branching to the loop re-enters it ("continue"), branching to
				// the block exits it ("break") -- standard structured-control idiom. Relative label depths
				// are computed from `ctx.depth`, not hardcoded, so a `break`/`continue` still resolves
				// correctly even when it sits inside an `if` (or another `switch`) nested in this loop's body.
				const old = ctx.swapOut();
				emitTruthy(s.test, ctx);
				ctx.emit(I.i32.eqz);
				ctx.depth++;
				const breakDepth = ctx.depth;
				ctx.breakTargets.push(breakDepth);
				ctx.depth++;
				const continueDepth = ctx.depth;
				ctx.continueTargets.push(continueDepth);
				ctx.emit(I.br_if(ctx.depth - breakDepth));
				emitStmt(s.body, ctx);
				ctx.emit(I.br(ctx.depth - continueDepth));
				ctx.continueTargets.pop();
				ctx.depth--;
				const _cont = ctx.swapOut(old);
				ctx.breakTargets.pop();
				ctx.depth--;
				ctx.emit(I.block(undefined, [I.loop(undefined, _cont)]));
				return;
			}
			case 'continue':
				if (s.label)
					throw new Error("towasm: labeled 'continue' is not supported");
				if (!ctx.continueTargets.length)
					throw new Error("towasm: 'continue' outside of a loop");
				ctx.emit(I.br(ctx.depth - ctx.continueTargets.at(-1)!));
				return;

			case 'break':
				if (s.label)
					throw new Error("towasm: labeled 'break' is not supported");
				if (!ctx.breakTargets.length)
					throw new Error("towasm: 'break' outside of a loop or switch");
				ctx.emit(I.br(ctx.depth - ctx.breakTargets.at(-1)!));
				return;

			case 'return':
				if (ctx.ctorThis) {
					if (s.argument)
						throw new Error('towasm: a constructor cannot return a value');
					ctx.emit(I.local.get(ctx.ctorThis.index));
				} else {
					if (ctx.result === 'void' && s.argument)
						throw new Error("towasm: a 'void' function cannot return a value");
					if (s.argument)
						emitAs(s.argument, ctx, ctx.result);
				}
				// A `reassignsThis` method's own (possibly just-updated) `this` rides along as one more
				// wasm-level result on every `return` -- see `FuncCtx.appendThisOnReturn`'s own comment.
				if (ctx.appendThisOnReturn)
					ctx.emit(I.local.get(ctx.lookup('this').index));
				ctx.emit(I.return);
				return;

			// `for...of` desugars into a synthetic `block`/`var_decl`/`for` (normal-kind) and recurses into
			// `emitStmt` itself, rather than adding a second instruction-emission path -- `kind: 'normal'`
			// below is the one real implementation both share.
			case 'for': {
				if (s.kind === 'normal') {
					if (s.init)
						emitStmt(s.init.type === 'var_decl' ? s.init : { type: 'expression', expression: s.init }, ctx);

					// A `block` wrapping a `loop`, same idiom as `while` -- except the body gets its own
					// *inner* block, which is the real `continue` target. A plain `while` can safely make
					// "continue" and "restart the loop" the same thing (there's no separate update step), but
					// this desugared C-style `for` has one (`s.update`) that must still run before the next
					// test -- reusing the `loop`'s own restart label for `continue` (as this used to, via a
					// synthetic `while` with `update` appended to its body) would skip straight past it, and
					// `i`/whatever `update` advances would never change: a real infinite loop, found via
					// `continue` inside a `switch` inside a `for...of` never terminating.
					const old = ctx.swapOut();
					emitTruthy(s.test ?? Literal(true), ctx);
					ctx.emit(I.i32.eqz);
					ctx.depth++;
					const breakDepth = ctx.depth;
					ctx.breakTargets.push(breakDepth);
					ctx.depth++;
					ctx.emit(I.br_if(ctx.depth - breakDepth));

					const bodyOld = ctx.swapOut();
					ctx.depth++;
					const continueDepth = ctx.depth;
					ctx.continueTargets.push(continueDepth);
					emitStmt(s.body, ctx);
					ctx.continueTargets.pop();
					ctx.depth--;
					const bodyContent = ctx.swapOut(bodyOld);
					ctx.emit(I.block(undefined, bodyContent));

					if (s.update)
						emitStmt({ type: 'expression', expression: s.update }, ctx);
					ctx.emit(I.br(0));
					ctx.depth--;
					const _cont = ctx.swapOut(old);
					ctx.breakTargets.pop();
					ctx.depth--;
					ctx.emit(I.block(undefined, [I.loop(undefined, _cont)]));
					return;
				}

				if (s.kind !== 'of')
					throw new Error(`towasm: 'for...${s.kind}' is not supported`);
				if (s.init.type !== 'var_decl' || s.init.declarations.length !== 1 || typeof s.init.declarations[0].name !== 'string')
					throw new Error("towasm: 'for...of' loop variable must be a single plain identifier declaration");

				const rightCls = classOf(s.right, ctx);
				const hasGet = !!(rightCls && methodSig(rightCls, 'get', ctx));
				const kind = hasGet ? undefined : arrayKindOf(s.right, ctx);
				if (!hasGet && (!kind || kind === 'i16'))
					throw new Error("towasm: 'for...of' is only supported over number[]/boolean[]/Uint8Array/Int32Array/Uint32Array (not 'string' -- see the 'index' case)");

				const n			= forTempCounter++;
				const arrId: Expr = { type: 'identifier', name: `#for${n}$arr` };
				const idxId: Expr = { type: 'identifier', name: `#for${n}$i` };

				emitStmt({
					type: 'block',
					body: [
						JS.VarDecl('const', JS.Var(arrId.name, s.right)),
						JS.VarDecl('let', JS.Var(idxId.name, Literal(0))),
						{
							type: 'for',
							kind: 'normal',
							test: JS.JSBinary('<', idxId, JS.Member(arrId, 'length')),
							update: JS.JSBinary('=', idxId, JS.JSBinary('+', idxId, Literal(1))),
							body: {
								type: 'block',
								body: [
									JS.VarDecl('const', JS.Var(s.init.declarations[0].name, JS.Index(arrId, idxId), kind === 'i32' ? T.BOOLEAN : T.NUMBER)),
									s.body,
								],
							},
						},
					],
				}, ctx);
				return;
			}

			// Lowers to `n` nested `block`s (`n` = number of cases, innermost = case 0), all wrapped in one
			// outer `block` (the `break` target). The discriminant is compared against each `test` in turn
			// (source order); a match branches straight into that case's own block, landing exactly where its
			// statements begin. No `break` at the end of a case just falls off that block's end, which is
			// nested *inside* the next case's block -- i.e. straight into the next case's statements, same
			// fallthrough real JS gives. `default`'s position in `s.cases` is treated like any other case for
			// fallthrough purposes -- only the "nothing matched" branch target differs (default's own block
			// instead of straight out to `break`).
			case 'switch': {
				const n = s.cases.length;
				if (n === 0) {
					// No cases -- the discriminant is still evaluated once for its side effects, same as real JS.
					emitStmt({ type: 'expression', expression: s.discriminant }, ctx);
					return;
				}

				const discName = `#switch$${switchTempCounter++}`;
				emitStmt(JS.VarDecl('const', JS.Var(discName, s.discriminant)), ctx);
				const discId: Expr = { type: 'identifier', name: discName };
				const defaultIndex = s.cases.findIndex(c => !c.test);

				const old = ctx.swapOut();

				ctx.depth++;
				const breakDepth = ctx.depth;
				ctx.breakTargets.push(breakDepth);
				for (let k = 0; k < n; k++)
					ctx.depth++;
				// Case `k`'s own block sits `n - k` levels inside the outer (`break`) block -- case 0 is
				// innermost (right where the dispatch below lives), case `n - 1` is outermost.
				const caseDepth = (k: number) => breakDepth + n - k;

				for (let i = 0; i < n; i++) {
					const c = s.cases[i];
					if (c.test) {
						emitAs(JS.JSBinary('===', discId, c.test), ctx, 'i32');
						ctx.emit(I.br_if(ctx.depth - caseDepth(i)));
					}
				}
				ctx.emit(I.br(ctx.depth - (defaultIndex >= 0 ? caseDepth(defaultIndex) : breakDepth)));

				let content = ctx.out;
				for (let k = 0; k < n; k++) {
					ctx.depth--;
					ctx.out = [I.block(undefined, content)];
					s.cases[k].consequent.forEach(st => emitStmt(st, ctx));
					content = ctx.out;
				}
				ctx.breakTargets.pop();
				ctx.depth--;
				ctx.out = old;
				ctx.emit(I.block(undefined, content));
				return;
			}

			default:
				throw new Error(`towasm: unsupported statement '${s.type}'`);
		}
	}

	// ===================================================================
	//  Function/Method
	// ===================================================================

	// One shared pair of wasm types per distinct TS function signature (memoized by `wasmTypeKey`, not
	// deduped per literal -- every literal still gets its own concrete env type and `funcIndex`):
	// `funcTypeIndex` is `(ref $envBase, ...sig.params) -> sig.result`, shared so every literal of this
	// signature is callable via one `call_ref`; `structTypeIndex` is the 2-field `{code, env}` value type.
	function ensureClosureType(sig: FuncSig): ClosureTypeInfo {
		const key = `(${sig.params.map(wasmTypeKey).join(',')})=>${wasmTypeKey(sig.result)}`;
		let info = closureTypes.get(key);
		if (!info) {
			const envBase		= ensureEnvBase();
			const funcTypeIndex	= registerFuncType([{ ref: envBase, nullable: false }, ...sig.params.map(toValType)], toResultType(sig.result));
			info = { funcTypeIndex, structTypeIndex: registerType({final: true, supertypes: [], type: { kind: 'struct', fields: [
				{ type: { ref: funcTypeIndex, nullable: false }, mut: false },
				{ type: { ref: envBase, nullable: false }, mut: false },
			] } } ) };
			closureTypes.set(key, info);
		}
		return info;
	}

	function toResultType(w: WasmType): wasm.ValType | undefined {
		return w === 'void' ? undefined : toValType(w);
	}

	function paramWasmType(owner: string, p: JS.Param<Type>): WasmType {
		// A default value is only resolved at each omitted call site (see `fillDefaultArgs`), not evaluated
		// dynamically the way real JS does -- so it must be a plain literal, safe to re-emit verbatim.
		if (p.default && p.default.type !== 'literal')
			throw new Error(`towasm: '${owner}' param '${describeBinding(p.key)}''s default value must be a literal`);
		const wt = p.typeAnnotation && typeOf(p.typeAnnotation);
		if (!wt)
			throw new Error(`towasm: '${owner}' param '${describeBinding(p.key)}' needs an explicit type`);
		if (wt === 'void')
			throw new Error(`towasm: '${owner}' param '${describeBinding(p.key)}' cannot be 'void'`);
		return wt;
	}

	function ensureFunc(name: string, decl: FunctionDecl): FuncInfo | undefined {
		if (decl.typeParams?.length)
			throw new Error(`towasm: generic function '${name}' is not supported`);
		//if (decl.rest)
		//	throw new Error(`towasm: rest parameters in '${name}' are not supported`);

		// No annotation defaults to `void` (matching real TS's inference) -- but an annotation that's
		// present and doesn't resolve is still a real error, not silently `void` too.
		const result = decl.returnType ? typeOf(decl.returnType as Type) : 'void';
		if (!result)
			throw new Error(`towasm: '${name}' has an unsupported return type`);
		const params	= decl.params.map(p => paramWasmType(name, p));
		if (decl.rest?.typeAnnotation)
			params.push(typeOf(decl.rest.typeAnnotation)!);
		const {funcIndex, typeIndex} = registerFunc(params.map(toValType), toResultType(result));
		const info: FuncInfo = {params, result, funcIndex, typeIndex, defaults: decl.params.map(p => p.default), hasRest: !!decl.rest?.typeAnnotation};
		funcs.set(name, info);
		worklist.push(() => {
			const ctx	= new FuncCtx(new Scope(libGlobal), result);
			ctx.declareParams(decl.rest ? [...decl.params, decl.rest] : decl.params, params).forEach(st => emitStmt(st, ctx));
			decl.body!.forEach(st => emitStmt(st, ctx));
			emitTrailingUnreachable(ctx, result);
			info.body = ctx.toFuncBody(params.length, toValType);
			info.body.id = name;
		});
		return info;
	}

	// Resolves fields and the struct type eagerly, but only collects method/ctor decls -- building each is
	// deferred to `ensureMethod`/`ensureCtor`, the same lazy treatment `ensureFunc` gives top-level functions.
	function ensureClass(name: string, typeArgs?: Type[]): ClassInfo | undefined {
		// A real generic instantiation (`Box<number>`) is cached under a composite key, not the bare class
		// name -- two different type arguments are two different physical classes (different field types),
		// same reasoning `builtinOwner`'s own hand-enumerated `Array<boolean>`/`Array<i64>`/etc instantiations
		// already used, just derived instead of hand-written. `typeKey` (already used elsewhere for exactly
		// this kind of structural-type dedup, e.g. `combineTypes`) gives a stable string for the resolved
		// type argument; keying off the *unresolved* class name (not `T.resolve`'s fully-expanded structural
		// form) keeps two different classes with identical field shapes from colliding.
		const key = typeArgs?.length ? `${name}<${typeArgs.map(t => T.typeKey(T.resolve(global, t))).join(',')}>` : name;
		let info = classes.get(key);
		if (!info) {
			// A plain lib-internal class (`StringParser`, ...) -- this is an ordinary struct seeded into
			// the same `classes` map a user class would be, just lazily on first reference.
			// `TYPED_ARRAY_ALIASES`: `name` isn't itself declared anywhere -- it's `Uint8Array`'s own
			// declaration, substituted (own struct, own `get`/`set`/methods, entirely independent of
			// `Uint8Array`'s once built) -- see that table's comment.
			let decl = LIB_DECL_MAP.get(name) ?? userGenericClassDecls.get(name);
			const typedArrayKind = TYPED_ARRAY_ALIASES[name];
			if (!decl && typedArrayKind) {
				const canonical = LIB_DECL_MAP.get(typedArrayKind.canonical);
				if (canonical?.type === 'class_decl') {
					decl = walk(canonical, undefined,
						(e, process) =>
							e.type === 'identifier' && e.name === typedArrayKind.canonical	? { ...e, name }
							: process(e),
						(t, process) =>
							t.type === 'ref' && t.name === typedArrayKind.canonical				? { ...t, name }
							: t.type === 'ref' && t.name === 'i32' && name === 'Uint32Array'	? { ...t, name: 'u32' }
							: process(t)
					) as JS.ClassDecl<Type>;
				}
			}
			if (decl?.type !== 'class_decl')
				return undefined;
			if (decl.typeParams?.length) {
				if (!typeArgs || typeArgs.length !== decl.typeParams.length)
					throw new Error(`towasm: class '${name}' needs ${decl.typeParams.length} explicit type argument(s)`);
				decl.typeParams.forEach((p, i) => decl = substituteClassTypeParam(decl as JS.ClassDecl<Type>, p.name, typeArgs[i]));
			}
			// `thisTsType` is always a real reference to this class -- `new X` always returns an instance of
			// `X`, full stop -- but the *ref itself* must carry the real name and real type arguments
			// (`{name, typeArgs}`), not the mangled composite cache key (`'Array<number>'`) as a bare name:
			// the checker's own `T.resolve` only ever has `name` registered (via the original class
			// declaration), and substitutes `typeArgs` into its declared shape itself -- keyed on the made-up
			// composite string instead, `this.length`/`this[i]` (an ordinary *value* read, not a method call)
			// can't resolve at all (`T.lookupMember` finds nothing, silently falls back to `any`). How an
			// instance is physically *represented* (struct vs. array, and which array kind) is a completely
			// separate, towasm-only fact -- `thisWtype`, set below once this class's own constructor has been
			// examined -- and never influences this one.
			info = { name: key, typeIndex: -1, thisTsType: TS.RefType(name, typeArgs), decl, fields: [], fieldIndex: new Map(), methodDecls: new Map() };
			classes.set(key, info);
		}
		if (info.typeIndex !== -1)
			return info;

		if (resolving.has(key))
			throw new Error(`towasm: class '${key}' has a field cycle (directly or indirectly has a field of its own type) -- not supported`);

		resolving.add(key);
		try {
			const decl = info.decl;
			if (decl.superClass)
				throw new Error(`towasm: inheritance ('${name} extends ...') is not supported`);
			if (decl.abstract)
				throw new Error(`towasm: abstract class '${name}' is not supported`);

			for (const m of decl.body) {
				if (m.type === 'field') {
					if (typeof m.key !== 'string')
						throw new Error(`towasm: computed field names in '${name}' are not supported`);
					// Static fields (`Array.alloc`-style) and instance fields whose value is itself `__asm(...)`
					// (`String.charCodeAt`, an intrinsic written as a bare field, not a method -- see
					// `lib/string.ts`) are both real fields to `scanInlineMethods` (below), not struct storage
					// -- neither needs a type annotation here, and `String` going through this loop for the
					// first time (previously handled by `builtinOwner`, which never validated fields at all)
					// is what surfaced the missing `isAsm` check.
					if (m.modifiers?.includes('static') || isAsm(m.value))
						continue;
//					if (m.value)
//						throw new Error(`towasm: field initializers ('${name}.${m.key}') are not supported -- set them in the constructor`);
					const wt = m.typeAnnotation && typeOf(m.typeAnnotation);
					if (!wt || wt === 'void')
						throw new Error(`towasm: field '${name}.${m.key}' needs an explicit number/boolean/object type`);
					info.fieldIndex.set(m.key, info.fields.length);
					info.fields.push({ name: m.key, wtype: wt });

				} else if (m.type === 'method') {
					// A computed name can't be stored as a decl key -- and can never be called via `.name()`
					// syntax either, so it's simply never reachable, no need to throw.
					if (typeof m.key !== 'string')
						continue;
					info.methodDecls.set(m.key, m);

				} else if (m.type === 'get' || m.type === 'set') {
					if (typeof m.key !== 'string')
						continue;
					info.methodDecls.set(accessorKey(m.type, m.key), m);
					(m.type === 'get' ? (info.getterNames ??= new Set()) : (info.setterNames ??= new Set())).add(m.key);

				} else if (m.type === 'index_signature') {
					// Type-checking-only (e.g. `Array<T>`'s own `[i: number]: T;`) -- real indexing goes
					// through the generic `get`/`set`/array-kind paths (`case 'index'`), never a declared
					// index signature itself, so there's nothing for this pass to do with it.
					continue;

				} else {
					throw new Error(`towasm: unsupported class member kind '${m.type}' in '${name}'`);
				}
			}

			// `Array<T>`/`String` are wasm-GC *arrays*, not structs -- but nothing here is told that by name.
			// `thisTsType` (just set above) never varies with this -- `new X` always returns an instance of
			// `X`. `thisWtype`, this class's own real *physical* representation, is the separate, purely
			// towasm-internal fact that does: a constructor that explicitly `return`s a value
			// (`ctorReturnsValue`) supplies it directly -- specifically, a call to one of this same class's
			// own static helpers (`Array<T>`'s `constructor(n) { return Array._alloc(n) as unknown as
			// Array<T>; }`, `String`'s `constructor() { return String.alloc(0) as unknown as String; }`) --
			// so that helper's own declared return type (already substituted to this concrete instantiation,
			// same as every other member here) says it directly, no compilation needed (and none would even
			// be safe here yet -- `_alloc`/`alloc` only become callable once `scanInlineMethods`, below, has
			// run). Every other class keeps the ordinary struct path -- `this` is a real GC struct.
			const ctorReturn = info.methodDecls.get('constructor')?.body;
			if (ctorReturn && ctorReturnsValue(ctorReturn)) {
				const helperReturnType = ctorReturnHelper(info, ctorReturn);
				const result = helperReturnType && typeOf(helperReturnType);
				if (!result || typeof result === 'string' || !('arr' in result))
					throw new Error(`towasm: '${name}'s constructor returns a value of an unsupported shape for 'this' -- only a call to one of this class's own static helpers, with an array-shaped result, is supported`);
				info.thisWtype = result;
				info.typeIndex = builtinArrayOwners[result.arr].typeIndex;
			} else {
				info.thisWtype = { ref: key };
				info.typeIndex = registerType({ final: true, supertypes: [], type: {
					kind: 'struct',
					fields: info.fields.map(f => ({ type: toValType(f.wtype), mut: true }))
				} });
			}

			// A method whose one statement forwards straight to `__asm` (e.g. `lib/typedarray.ts`'s
			// `get`/`set`) -- same intrinsic recognition `builtinOwner` gives Array/String/etc, now
			// available to any plain class, not just those specially built in. `TYPED_ARRAY_ALIASES[name]
			// ?.elem`: the one piece of non-name-substitutable info `get`/`set` need (see that table's comment).
			// Comes from whatever `thisWtype` actually turned out to be, not a name check either.
			const { inlineMethods, asmMethodKeys } = scanInlineMethods(decl, name, info.typeIndex,
				typeof info.thisWtype !== 'string' && info.thisWtype && 'arr' in info.thisWtype ? info.thisWtype.arr : undefined,
				TYPED_ARRAY_ALIASES[name]?.elem);
			for (const k of asmMethodKeys)
				info.methodDecls.delete(k);
			if (inlineMethods.size)
				info.inlineMethods = inlineMethods;

			return info;

		} finally {
			resolving.delete(key);
		}
	}

	// Lazy the same way `ensureFunc` is: an unreached class is never `new`'d, so its ctor never needs validating/registering/building.
	function ensureCtor(cls: ClassInfo): FuncInfo {
		if (cls.ctor)
			return cls.ctor;
		const ctor = cls.methodDecls.get('constructor');
		if (!ctor)
			throw new Error(`towasm: class '${cls.name}' needs an explicit constructor`);

		const params		= ctor.params.map(p => paramWasmType(`${cls.name}'s constructor`, p));
		const thisWtype		= ownerThisType(cls);
		const {funcIndex, typeIndex} = registerFunc(params.map(toValType), toValType(thisWtype));
		const info: FuncInfo = { params, result: thisWtype, funcIndex, typeIndex, defaults: ctor.params.map(p => p.default) };
		cls.ctor = info;

		worklist.push(() => {
			const ctx		= new FuncCtx(new Scope(libGlobal), thisWtype, cls);
			ctx.declareParams(ctor.params, params).forEach(st => emitStmt(st, ctx));
			// This constructor supplies `this` directly via its own return value (`ctorReturnsValue`) -- e.g.
			// `Array<T>`'s real `constructor(n) { return Array._alloc(n) as unknown as Array<T>; }` -- `cls`'s
			// own `thisWtype`/`typeIndex` (set by `ensureClass`, from this exact same return expression,
			// *before* any constructor is ever compiled) already say so; the compiled body just needs to
			// match, no struct/`this`-local machinery involved at all -- ordinary statement compilation
			// (`emitStmt`'s own `case 'return'`) already does the right thing once `ctx.ctorThis` is unset.
			const explicitReturn = ctorReturnsValue(ctor.body!);

			if (explicitReturn) {
				ctor.body!.forEach(st => emitStmt(st, ctx));

			// Defaultability (what `struct.new_default` needs) is a whole-struct-type property, not per-field --
			// one object-typed field forces the collect-then-`struct.new` path for the whole class.
			} else if (cls.fields.some(f => typeof f.wtype !== 'string')) {
				const remaining	= new Set(cls.fields.map(f => f.name));
				const values	= new Map<string, Local>();

				const setField = (field: string, wtype: WasmType) => {
					const local = ctx.declareLocal(`$field$${field}`, wtype);
					ctx.emit(I.local.set(local.index));
					values.set(field, local);
					remaining.delete(field);
					if (!remaining.size) {
						for (const f of cls.fields)
							ctx.emit(I.local.get(values.get(f.name)!.index));
						ctx.emit(I.struct.new(cls.typeIndex));
						const thisLocal = ctx.declareValue('this', thisWtype, cls.thisTsType);
						ctx.ctorThis = thisLocal;
						ctx.emit(I.local.set(thisLocal.index));
					}
				};

				const initField = (field: string, value: Expr) => {
					const wtype = cls.fields[cls.fieldIndex.get(field)!].wtype;
					emitAs(value, ctx, wtype);
					setField(field, wtype);
				};

				for (const m of cls.decl.body) {
					if (m.type === 'field' && !m.modifiers?.includes('static') && m.value)
						initField(m.key as string, m.value);
				}
				for (const p of ctor.params) {
					if (hasMod(p, 'public')) {
						const loc = ctx.lookup(p.key as string);
						ctx.emit(I.local.get(loc.index));
						setField(p.key as string, loc.wtype);
					}
				}

				for (const st of ctor.body!) {
					if (!remaining.size || st.type === 'var_decl') {
						emitStmt(st, ctx);
						continue;
					}

					if (st.type === 'expression' && st.expression.type === 'binary' && st.expression.operator === '=' && st.expression.left.type === 'member' && st.expression.left.object.type === 'this') {
						const field	 = st.expression.left.property;
						if (remaining.has(field)) {
							initField(field, st.expression.right);
							continue;
						}
					}

					throw new Error(`towasm: '${cls.name}'s constructor must assign every field via a plain 'this.field = value' statement, before any other statement -- it has at least one object-typed field, which needs 'struct.new' (real values up front) instead of 'struct.new_default'`);
				}

				if (remaining.size)
					throw new Error(`towasm: '${cls.name}'s constructor never assigns field(s) ${[...remaining].join(', ')}`);
			} else {
				const thisLocal = ctx.declareValue('this', thisWtype, cls.thisTsType);
				ctx.ctorThis = thisLocal;
				ctx.emit(
					I.struct.new_default(cls.typeIndex),
					I.local.set(thisLocal.index),
				);
				ctor.body!.forEach(st => emitStmt(st, ctx));
			}
			if (!explicitReturn) {
				ctx.emit(
					I.local.get(ctx.ctorThis!.index),
					I.return
				);
			}

			info.body = ctx.toFuncBody(ctor.params.length, toValType);
			info.body.id = cls.name;
		});
		return info;
	}

	function ensureMethod(owner: MethodOwner, name: string): FuncInfo | undefined {
		// Qualified so it can share `funcs` with plain top-level functions (bare identifiers can't contain
		// '.') without colliding.
		const key = `${owner.name}.${name}`;
		const existing = funcs.get(key);
		if (existing)
			return existing;
		const decl = owner.methodDecls.get(name);
		if (!decl)
			return undefined;
		if (decl.typeParams?.length)
			throw new Error(`towasm: generic methods ('${owner.name}.${name}') are not supported`);
		if (!decl.body)
			throw new Error(`towasm: '${owner.name}.${name}' needs a body (overload signatures are not supported)`);

		const result = decl.returnType ? typeOf(decl.returnType as Type) : 'void';
		if (!result)
			throw new Error(`towasm: '${owner.name}.${name}' has an unsupported return type`);

		const params = decl.params.map(p => paramWasmType(`${owner.name}.${name}`, p));
		if (decl.rest?.typeAnnotation)
			params.push(typeOf(decl.rest.typeAnnotation)!);

		const isStatic	= decl.modifiers?.includes('static');
		const thisWtype	= ownerThisType(owner);
		// Real TS never allows assigning to `this` -- a declared body that does anyway (`assignsToThis`) can
		// only mean "this method replaces its own receiver's physical value" (see that function's own
		// comment). Compiled with one extra wasm-level result carrying the method's final `this`, appended by
		// every `return` (`case 'return'`'s `appendThisOnReturn`) -- every call site consumes it and writes it
		// back to the receiver's real lvalue (`case 'call'`).
		const reassignsThis = !isStatic && assignsToThis(decl.body);
		const paramTypes	= [...(isStatic ? [] : [toValType(thisWtype)]), ...params.map(toValType)];
		const {funcIndex, typeIndex} = reassignsThis
			? registerFuncAtType(registerType({ final: true, supertypes: [], type: { kind: 'func', params: paramTypes,
				results: [...(result !== 'void' ? [toValType(result)] : []), toValType(thisWtype)] } }))
			: isStatic
				? registerFunc(params.map(toValType), toResultType(result))
				: registerFunc(paramTypes, toResultType(result));

		const info: FuncInfo = { params, result, funcIndex, typeIndex, defaults: decl.params.map(p => p.default), hasRest: !!decl.rest?.typeAnnotation, reassignsThis };
		funcs.set(key, info);
		worklist.push(() => {
			const ctx	= new FuncCtx(new Scope(libGlobal), result, owner);
			if (!isStatic)
				ctx.declareValue('this', thisWtype, owner.thisTsType);
			if (reassignsThis)
				ctx.appendThisOnReturn = true;
			ctx.declareParams(decl.rest ? [...decl.params, decl.rest] : decl.params, params).forEach(st => emitStmt(st, ctx));
			decl.body!.forEach(st => emitStmt(st, ctx));
			emitTrailingUnreachable(ctx, result);
			info.body = ctx.toFuncBody((isStatic ? 0 : 1) + params.length, toValType);
			info.body.id = `${owner.name}_${name}`;
		});
		return info;
	}


	// ===================================================================
	//  Program lowering
	// ===================================================================

	// `Array` used to be excluded here too, back when `ClassInfo.thisTsType` self-referenced a towasm-only
	// composite key (`'Array<number>'`) that was never a real, checker-resolvable name anyway -- hoisting
	// its real declaration bought nothing. Now that `thisTsType` is always a genuine `{name, typeArgs}` ref
	// (see `ensureClass`), `Array` needs to be hoisted like any other class: `this.length`/`this[i]` inside
	// its own methods resolve through the checker's ordinary generic-substitution member lookup, the same
	// path every other class's `this` already goes through.
	const HOIST_EXCLUDE		= new Set(['Boolean']);
	checker.checkBlock(LIB_AST.filter((s: TS.Statement) => {
		const decl = s.type === 'export_decl' ? s.declaration : s;
		return !(decl.type === 'class_decl' && HOIST_EXCLUDE.has(decl.name));
	}), libGlobal, true);


	const mod		= new wasm.WasmModule();
	mod.imports		= [];

	// Pushed in the order `ARRAY`' own values declare -- that record *is* the index-to-kind map.
	for (const kind of Object.keys(builtinArrayOwners)) {
		// All mutable at the wasm level, even `i16` (`string`) -- "strings are immutable" is enforced by
		// never emitting `set` from ordinary user-level TS code, only from one hand-built intrinsic.
		registerType({ final: true, supertypes: [], type: { kind: 'array', field: { type: kind === 'ref' ? {ref: 'any', nullable: true} : kind === 'u32' ? 'i32' : kind as NumericType, mut: true } } });
	}

	const usesConsoleLog = walkB(ast.body, undefined, (e, process) => e.type === 'call' && e.callee.type === 'member' && e.callee.object.type === 'identifier' && e.callee.object.name === 'console' && e.callee.property === 'log' ? true : process(e));
	if (usesConsoleLog) {
		global.addValue('console', TS.ObjectType([
			TS.TypeMethod('log', TS.CallSig({ params: [], rest: JS.Rest('args', T.ANY) }, T.VOID)),
		]));
		mod.imports.push(
			{ module: 'console', name: 'log', desc: { kind: 'func', typeIndex: registerFunc(['f64'], undefined).typeIndex } },
			{ module: 'console', name: 'log', desc: { kind: 'func', typeIndex: registerFunc(['f32'], undefined).typeIndex } },
		);
	}

	// Seed with every exported (real, user-level top-level) function and reserve every class name eagerly
	for (const s of ast.body) {
		if (s.type === 'function_decl' && s.body) {
			functionDeclByName.set(s.name, s);
		} else if (s.type === 'class_decl') {
			// A generic class has no single physical representation to reserve under its bare name (only
			// each concrete instantiation does) -- recorded in `userGenericClassDecls` instead, the same
			// role `LIB_DECL_MAP` plays for lib-declared generics (see `ensureClass`/`resolveGenericClassRef`).
			if (s.typeParams?.length) {
				userGenericClassDecls.set(s.name, s);
				continue;
			}
			classes.set(s.name, {
				name: 		s.name,
				typeIndex:		-1,
				thisTsType:	TS.RefType(s.name),
				decl:		s,
				fields: 	[],
				fieldIndex: new Map(),
				methodDecls: new Map(),
			});
		}
	}
	for (const f of functionDeclByName)
		ensureFunc(f[0], f[1]);

	while (worklist.length)
		worklist.shift()!();

	// ---- assemble the module ----

	// `functionTypes`/`code` are the wasm Function/Code sections, which list only *local* functions --
	// a real func index includes the imports reserved above, so `place` shifts back down by that count.
	const numImports	= mod.imports.length;
	const numFuncs		= funcs.size;
	mod.functionTypes	= new Array<number>(numFuncs);
	mod.code			= new Array<wasm.FuncBody>(numFuncs);

	function place(info: FuncInfo) {
		mod.functionTypes![info.funcIndex - numImports]	= info.typeIndex;
		mod.code![info.funcIndex - numImports]			= info.body!;
	}

	funcs.forEach((info, name) => {
		if (!name.includes('.')) // skip methods
			place(info);
	});

	for (const info of funcs.values())
		place(info);

	// Only a ctor still lives on `ClassInfo` directly (it never went through `ensureMethod`/`funcs`) -- a
	// class can be reached only through `new` or only through its methods, so this stays separate.
	for (const c of classes.values())
		if (c.ctor)
			place(c.ctor);

	// Closure literals have no name to be reached by, the way `funcs`/`classes` are -- each already pushed
	// its own `FuncInfo` the moment it was first compiled, so placing them is just this flat array.
	for (const info of closureLiterals)
		place(info);

	mod.types			= { types, groupSizes: types.map(() => 1) };
	if (heapPtrGlobal !== -1) {
		mod.memories	= [{ min: 1 }];
		mod.globals		= globals;
	}
	mod.datas			= [{ mode: 'passive', bytes: data }];

	// Every closure literal's own `funcIndex` is taken by `ref.func` at its creation site -- wasm requires
	// any function referenced that way to be "declared" first, which a declarative element segment
	// satisfies without needing an actual table.
	if (closureLiterals.length)
		mod.elements = [{ mode: 'declarative', reftype: { ref: 'func', nullable: true }, funcIndices: closureLiterals.map(info => info.funcIndex) }];

	// Only top-level functions are exported -- class ctors/methods are reachable through them.
	for (const s of ast.body) {
		if (s.type === 'function_decl' && s.body)
			(mod.exports??=[]).push({ name: s.name, kind: 'func', index: funcs.get(s.name)!.funcIndex });
	}

	return mod;
}
