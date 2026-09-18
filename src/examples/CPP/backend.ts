// A partial C++ -> wasm back end, and the first consumer of `wasm-codegen.ts` that is not TypeScript.
// Its reason to exist is to keep that module honest: everything physical here -- locals and their slot
// reuse, the type section, block/loop/if emission, the function body -- comes from the neutral module,
// and what is left is the AST walk plus `toValType`, which is the seam the split was designed around.
//
// SCOPE, deliberately small: scalar types, functions, locals, if/while/break/continue/return, the usual
// arithmetic conversions, direct calls and `?:`. No pointers, references, arrays, classes, templates,
// overloads, or standard library -- an unsupported construct throws `WT.Error` rather than miscompiling.

import * as CPP from './cpp-parser';
import * as C from './c-parser';
import * as W from '../wasm-codegen';
import * as wasm from '@isopodlabs/binary_libs/wasm';

const I = wasm.I;

type Expr	= CPP.Expr;
type Stmt	= C.Stmt<CPP.Declarator, CPP.TypeSpecifierExt, CPP.Expr, CPP.Stmt>;
type FnDef	= CPP.Definition & { type: 'function_def' };
// Every value this back end can produce. Narrower than `WT.Type` on purpose: no ref/array/closure form
// is reachable, so nothing below needs to narrow one away.
type Val	= W.Scalar | 'void';

const SCALARS: Record<string, Val> = {
	'int': 'i32', 'long': 'i64', 'long long': 'i64', 'short': 'i32', 'char': 'i32', 'signed': 'i32',
	'unsigned': 'u32', 'unsigned int': 'u32', 'unsigned long': 'u64', 'unsigned long long': 'u64',
	'float': 'f32', 'double': 'f64', 'bool': 'i32', 'void': 'void',
};

const COMPARISONS = new Set(['==', '!=', '<', '>', '<=', '>=']);

const isFloat	= (t: Val): t is 'f32' | 'f64' => t === 'f32' || t === 'f64';
const isUnsigned = (t: Val) => t === 'u32' || t === 'u64';

function declaredType(spec: C.DeclSpec<CPP.TypeSpecifierExt>): Val {
	if (spec.type.type !== 'ref')
		throw new W.Error(`unsupported type specifier '${spec.type.type}'`);
	const w = SCALARS[spec.type.name];
	if (!w)
		throw new W.Error(`unsupported type '${spec.type.name}'`);
	return w;
}

// The usual arithmetic conversions, cut down to the scalars above: the widest of the two, float winning.
function commonType(a: Val, b: Val): W.Scalar {
	for (const t of ['f64', 'f32', 'u64', 'i64', 'u32'] as const)
		if (a === t || b === t)
			return t;
	return 'i32';
}

function constOf(t: W.Scalar, v: number): wasm.Instr {
	const k = W.notUnsigned(t);
	return	k === 'i32' ? I.i32.const(v)
		:	k === 'i64' ? I.i64.const(BigInt(Math.trunc(v)))
		:	k === 'f32' ? I.f32.const(v)
		:	I.f64.const(v);
}

export function CPPtoWasm(module: { body: CPP.Definition[] }): wasm.WasmModule {
	const out	= new wasm.WasmModule();
	const types	= new W.Types;
	const funcs	= new Map<string, { funcIndex: number; typeIndex: number; params: Val[]; result: Val }>();

	// The one answer only the language has, taken as a parameter by every neutral helper that needs it --
	// the `toFuncBody(numParams, toValType)` idiom. A fuller back end would resolve class names here.
	function toValType(w: W.Type): wasm.ValType {
		if (typeof w !== 'string' || w === 'void')
			throw new W.Error('only scalar values are supported');
		return W.notUnsigned(w);
	}

	const toParams	= (ps: Val[]): wasm.ParamType[] => ps.map(p => ({ type: toValType(p) }));
	const toResults	= (r: Val): wasm.ValType[] => r === 'void' ? [] : [toValType(r)];

	// ---- declarations ---------------------------------------------------

	// A C declarator is a spiral; only the `name(params)` shape is handled.
	function functionParts(d: CPP.Declarator) {
		if (d.type !== 'function' || d.name.type !== 'identifier')
			throw new W.Error('only a plain `name(params)` declarator is supported');
		return {
			name:	d.name.name,
			params: d.params.map(p => {
				// A pack shares `type: 'parameter'` with an ordinary one, so `pack` is what tells them apart.
				if ('pack' in p)
					throw new W.Error('a parameter pack is not supported');
				if (!p.declarator || p.declarator.type !== 'identifier')
					throw new W.Error('only plain named parameters are supported');
				return { name: p.declarator.name, wtype: declaredType(p.specifiers) };
			}),
		};
	}

	// Every function is declared before any body compiles, so a call can reach one defined later.
	function declare(def: FnDef) {
		const { name, params }	= functionParts(def.declarator);
		const result			= declaredType(def.specifiers);
		const wtypes			= params.map(p => p.wtype);
		const { funcIndex, typeIndex } = types.func(toParams(wtypes), toResults(result));
		funcs.set(name, { funcIndex, typeIndex, params: wtypes, result });
		return { name, params, result };
	}

	// ---- expressions ----------------------------------------------------

	function convert(got: Val, want: Val, ctx: W.FunctionContext): void {
		if (got === 'void' || want === 'void')
			return;
		const g = W.notUnsigned(got), w = W.notUnsigned(want);
		if (g === w)
			return;
		// The sign is the SOURCE's widening an integer or making it a float, but the DEST's when truncating
		// a float into one -- `f64.convert_i32_s` against `i32.trunc_f64_s`.
		if (g === 'i64' && w === 'i32')
			ctx.emit(I.i32.wrap_i64);
		else if (g === 'i32' && w === 'i64')
			ctx.emit(isUnsigned(got) ? I.i64.extend_i32_u : I.i64.extend_i32_s);
		else if (g === 'f32' && w === 'f64')
			ctx.emit(I.f64.promote_f32);
		else if (g === 'f64' && w === 'f32')
			ctx.emit(I.f32.demote_f64);
		else if (w === 'f32')
			ctx.emit(g === 'i64' ? (isUnsigned(got) ? I.f32.convert_i64_u : I.f32.convert_i64_s) : isUnsigned(got) ? I.f32.convert_i32_u : I.f32.convert_i32_s);
		else if (w === 'f64')
			ctx.emit(g === 'i64' ? (isUnsigned(got) ? I.f64.convert_i64_u : I.f64.convert_i64_s) : isUnsigned(got) ? I.f64.convert_i32_u : I.f64.convert_i32_s);
		else if (w === 'i32')
			ctx.emit(g === 'f32' ? (isUnsigned(want) ? I.i32.trunc_f32_u : I.i32.trunc_f32_s) : isUnsigned(want) ? I.i32.trunc_f64_u : I.i32.trunc_f64_s);
		else
			ctx.emit(g === 'f32' ? (isUnsigned(want) ? I.i64.trunc_f32_u : I.i64.trunc_f32_s) : isUnsigned(want) ? I.i64.trunc_f64_u : I.i64.trunc_f64_s);
	}

	function binaryInstr(op: string, t: W.Scalar): wasm.Instr {
		const k = W.notUnsigned(t);
		const u = isUnsigned(t);
		if (k === 'f32' || k === 'f64') {
			const f = k === 'f32' ? I.f32 : I.f64;
			switch (op) {
				case '+':	return f.add;
				case '-':	return f.sub;
				case '*':	return f.mul;
				case '/':	return f.div;
				case '==':	return f.eq;
				case '!=':	return f.ne;
				case '<':	return f.lt;
				case '>':	return f.gt;
				case '<=':	return f.le;
				case '>=':	return f.ge;
			}
		} else {
			const n = k === 'i32' ? I.i32 : I.i64;
			switch (op) {
				case '+':	return n.add;
				case '-':	return n.sub;
				case '*':	return n.mul;
				case '/':	return u ? n.div_u : n.div_s;
				case '%':	return u ? n.rem_u : n.rem_s;
				case '&':	return n.and;
				case '|':	return n.or;
				case '^':	return n.xor;
				case '<<':	return n.shl;
				case '>>':	return u ? n.shr_u : n.shr_s;
				case '==':	return n.eq;
				case '!=':	return n.ne;
				case '<':	return u ? n.lt_u : n.lt_s;
				case '>':	return u ? n.gt_u : n.gt_s;
				case '<=':	return u ? n.le_u : n.le_s;
				case '>=':	return u ? n.ge_u : n.ge_s;
			}
		}
		throw new W.Error(`unsupported operator '${op}'`);
	}

	// The type an expression WOULD have, without keeping its code: `swapOut` makes the throwaway list free.
	// Crude next to a real checker, but it is what keeps operand conversion honest.
	function typeOf(e: Expr, ctx: W.FunctionContext): Val {
		const saved = ctx.swapOut();
		try {
			return emitExpr(e, ctx);
		} finally {
			ctx.swapOut(saved);
		}
	}

	function emitExpr(e: Expr, ctx: W.FunctionContext, want?: Val): Val {
		switch (e.type) {
			case 'literal': {
				if (typeof e.value !== 'number')
					throw new W.Error('only numeric literals are supported');
				// A float `want` makes an integer literal float, so `double x = 1;` needs no conversion.
				const t = want && isFloat(want) ? want : Number.isInteger(e.value) ? 'i32' : 'f64';
				ctx.emit(constOf(t, e.value));
				return t;
			}

			case 'identifier': {
				const local = ctx.lookup(e.name);
				if (!local)
					throw new W.Error(`unknown identifier '${e.name}'`);
				ctx.emit(I.local.get(local.index));
				return local.wtype as Val;
			}

			case 'binary': {
				const t = commonType(typeOf(e.left, ctx), typeOf(e.right, ctx));
				convert(emitExpr(e.left, ctx, t), t, ctx);
				convert(emitExpr(e.right, ctx, t), t, ctx);
				ctx.emit(binaryInstr(e.operator, t));
				return COMPARISONS.has(e.operator) ? 'i32' : t;
			}

			case 'unary': {
				if (e.operator === '!') {
					truthy(e.operand, ctx);
					ctx.emit(I.i32.eqz);
					return 'i32';
				}
				if (e.operator !== '-')
					throw new W.Error(`unsupported unary '${e.operator}'`);
				const t = commonType(typeOf(e.operand, ctx), 'i32');
				if (isFloat(t)) {
					convert(emitExpr(e.operand, ctx, t), t, ctx);
					ctx.emit(t === 'f32' ? I.f32.neg : I.f64.neg);
					return t;
				}
				// wasm has no integer negate.
				ctx.emit(constOf(t, 0));
				convert(emitExpr(e.operand, ctx, t), t, ctx);
				ctx.emit(binaryInstr('-', t));
				return t;
			}

			case 'assign': {
				if (e.target.type !== 'identifier' || e.operator)
					throw new W.Error('only plain `name = value` assignment is supported');
				const local = ctx.lookup(e.target.name);
				if (!local)
					throw new W.Error(`unknown identifier '${e.target.name}'`);
				const wtype = local.wtype as Val;
				convert(emitExpr(e.value, ctx, wtype), wtype, ctx);
				// `local.tee` leaves the value behind, which is what makes an assignment an expression.
				ctx.emit(I.local.tee(local.index));
				return wtype;
			}

			case 'call': {
				if (e.callee.type !== 'identifier')
					throw new W.Error('only a direct call by name is supported');
				const fn = funcs.get(e.callee.name);
				if (!fn)
					throw new W.Error(`unknown function '${e.callee.name}'`);
				if (fn.params.length !== e.arguments.length)
					throw new W.Error(`'${e.callee.name}' takes ${fn.params.length} arguments, not ${e.arguments.length}`);
				e.arguments.forEach((a, i) => convert(emitExpr(a, ctx, fn.params[i]), fn.params[i], ctx));
				ctx.emit(I.call(fn.funcIndex));
				return fn.result;
			}

			case 'conditional': {
				const t = commonType(typeOf(e.consequent, ctx), typeOf(e.alternate, ctx));
				truthy(e.test, ctx);
				// The neutral `emitIf`: each arm builds into its own list, so neither can run before the test.
				ctx.emitIf(toValType(t),
					() => convert(emitExpr(e.consequent, ctx, t), t, ctx),
					() => convert(emitExpr(e.alternate, ctx, t), t, ctx));
				return t;
			}
		}
		throw new W.Error(`unsupported expression '${e.type}'`);
	}

	function truthy(e: Expr, ctx: W.FunctionContext): void {
		const t = emitExpr(e, ctx);
		if (t === 'void')
			throw new W.Error("a 'void' value has no truth value");
		if (isFloat(t))
			ctx.emit(constOf(t, 0), binaryInstr('!=', t));
		else if (W.notUnsigned(t) === 'i64')
			ctx.emit(I.i64.eqz, I.i32.eqz);
	}

	// ---- statements -----------------------------------------------------

	function emitStmt(s: Stmt, ctx: W.FunctionContext, result: Val): void {
		switch (s.type) {
			case 'empty':
				return;

			case 'block':
				// `inScope` is what returns the block's slots to the free list -- neutral, already correct.
				ctx.inScope(() => s.body.forEach(b => emitStmt(b, ctx, result)));
				return;

			case 'declaration': {
				const wtype = declaredType(s.specifiers);
				if (wtype === 'void')
					throw new W.Error("a local cannot have type 'void'");
				for (const d of s.initDeclarators ?? []) {
					const decl = 'declarator' in d ? d.declarator : d;
					if (decl.type !== 'identifier')
						throw new W.Error('only a plain named declarator is supported');
					const init = 'initializer' in d ? d.initializer : undefined;
					if (init && 'type' in init && init.type === 'initializer_list')
						throw new W.Error('an initializer list is not supported');
					// Declared only after the initializer compiles, so `int x = x;` cannot see itself.
					if (init)
						convert(emitExpr(init as Expr, ctx, wtype), wtype, ctx);
					else
						ctx.emit(constOf(wtype, 0));
					ctx.emit(I.local.set(ctx.declareLocal(decl.name, wtype).index));
				}
				return;
			}

			case 'expression':
				if (emitExpr(s.expression, ctx) !== 'void')
					ctx.emit(I.drop);
				return;

			case 'if':
				truthy(s.test, ctx);
				ctx.emitIf(undefined,
					() => emitStmt(s.consequent, ctx, result),
					s.alternate ? () => emitStmt(s.alternate!, ctx, result) : undefined);
				return;

			case 'while':
				// `emitLoop` owns the block+loop and registers both branch targets, so the body needs no
				// depth bookkeeping: `br_if(1)` leaves the loop, `br(0)` restarts it.
				ctx.emitLoop(() => {
					truthy(s.test, ctx);
					ctx.emit(I.i32.eqz, I.br_if(1));
					emitStmt(s.body, ctx, result);
					ctx.emit(I.br(0));
				});
				return;

			case 'break':
				if (!ctx.breakTargets.length)
					throw new W.Error("'break' outside of a loop");
				ctx.emitBreak();
				return;

			case 'continue':
				if (!ctx.continueTargets.length)
					throw new W.Error("'continue' outside of a loop");
				ctx.emitContinue();
				return;

			case 'return':
				if (s.argument)
					convert(emitExpr(s.argument, ctx, result), result, ctx);
				ctx.emit(I.return);
				return;
		}
		throw new W.Error(`unsupported statement '${s.type}'`);
	}

	// ---- drive ----------------------------------------------------------

	const defs	= module.body.filter((d): d is FnDef => d.type === 'function_def');
	const decls	= defs.map(declare);

	out.code = defs.map((def, i) => {
		const { name, params, result } = decls[i];
		const ctx = new W.FunctionContext(name);
		params.forEach(p => ctx.declareLocal(p.name, p.wtype));
		W.withCatch(() => emitStmt({ type: 'block', body: def.body.body }, ctx, result), name)();
		// Neutral: a non-void body need not end in a top-level `return`, and a trailing `unreachable` is
		// always safe -- it is dead wherever a real return already covers every path.
		ctx.emitTrailingUnreachable(result);
		return ctx.toFuncBody(params.length, toValType);
	});

	out.types			= { types, groupSizes: types.groupSizes(new Set()) };
	out.functionTypes	= decls.map(d => funcs.get(d.name)!.typeIndex);
	out.exports			= decls.map(d => ({ name: d.name, kind: 'func' as const, index: funcs.get(d.name)!.funcIndex }));
	return out;
}
