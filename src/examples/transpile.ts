// PoC: TypeScript AST -> Python AST -> Python source.
// Marked [=] where the converged shapes let a node pass through unchanged or with only a retag,
// and [~] where a real language difference needed actual work.
import * as TS from './TS/ts-parser';
import * as JS from './TS/js-parser';
import * as PY from './PY/py-parser';
import * as C from './CPP/c-parser';
import * as CPP from './CPP/cpp-parser';
import { Output as PYOutput, Options as PYOptions } from './PY/tocode';
import { Output as TSOutput, Options as TSOptions } from './TS/tocode';
import { Output as CPPOutput, Options as CPPOptions } from './CPP/tocode';
import { isExpr as isCppExprNode, isPackParameter as isCppPackParameter } from './CPP/walker';
import { Module, bodyOf, Identifier, Literal, Unary, UnaryPost, Binary, Call, Member, Index, Conditional, Spread, Sequence, Assign, Await, Yield, ExprStmt, Return, Throw, If, While, DoWhile } from './common';

const pyUnsupported		= (what: string): never => { throw new Error(`transpile: ${what} has no Python equivalent`); };
const tsUnsupported		= (what: string): never => { throw new Error(`transpile: ${what} has no TypeScript equivalent`); };
const cppUnsupported	= (what: string): never => { throw new Error(`transpile: ${what} has no C++ equivalent`); };

function reverse<X extends string, Y extends string>(map: Partial<Record<X, Y>>) {
	const rev: Record<Y, X> = {} as any;
	for (const k in map)
		rev[map[k]!] = k;
	return rev;
}

// ===================================================================
//  PoC: TypeScript AST -> Python AST -> TypeScript source.
// ===================================================================
// [=] both parsers spell every one of these operators the same way now (py-parser stores
// `and`/`or`/`not` as `&&`/`||`/`!`); the map's job is just to say which ops carry across.
const BINARY: Partial<Record<JS.binaryOps, PY.binaryOps>> = {
	'+':	'+',
	'-':	'-',
	'*':	'*',
	'/':	'/',
	'%':	'%',
	'**':	'**',
	'&':	'&',
	'|':	'|',
	'^':	'^',
	'<<':	'<<',
	'>>':	'>>',
	'&&':	'&&',
	'||':	'||',
};

const UNARY: Partial<Record<JS.unaryOps, PY.unaryOps>> = {
	'-':	'-',
	'+':	'+',
	'~':	'~',
	'!':	'!'
};

const isJSVarDecl	= (x: JS.ForInit<TS.Type>): x is JS.VarDecl<TS.Type> => x.type === 'var_decl';

function TS2PY(ts: Module<TS.Stmt>) {
	// [~] the one piece of context the translation needs: Python's `super().__init__` / explicit-base
	// call has no direct JS counterpart, so the enclosing class's base name is threaded down.
	let superName: string | undefined;

	// [~] JS folds comparison into Binary; Python needs a Compare node (chained or not).
	const COMPARE: Partial<Record<JS.binaryOps, PY.compareOps>> = {
		'<':	'<',
		'>':	'>',
		'<=':	'<=',
		'>=':	'>=',
		'==':	'==',
		'===':	'==',
		'!=':	'!=',
		'!==':	'!=',
		'in':	'in',
	};

	const pos		= (value: PY.Expr): PY.Arg => ({ kind: 'pos', value });
	const compare	= (op: PY.compareOps, left: PY.Expr, right: PY.Expr): PY.Compare => ({ type: 'compare', left, ops: [op], comparators: [right] });
	const call		= (fn: string, ...args: PY.Expr[]): PY.Expr => Call<PY.Expr, PY.Arg>(Identifier(fn), args.map(pos));

	const base		= () => Identifier(superName ?? pyUnsupported('`super` outside a derived class'));

	const bindName	= (b: JS.BindingTarget): string 	=> typeof b === 'string' ? b : pyUnsupported('destructuring');
	const keyExpr	= (k: JS.Key): PY.Expr				=> typeof k === 'string' ? Literal(k) : expr(k.computed);
	const keyName	= (k: JS.Key): string				=> typeof k !== 'string' ? pyUnsupported('computed member name') : k === 'constructor' ? '__init__' : k;
	const param		= (p: JS.Param<TS.Type>): PY.Param	=> ({ name: bindName(p.key), default: p.default && expr(p.default) });

	// [=] bodyOf is what makes this one line instead of a block/single-statement branch
	const body		= (b: TS.Stmt | readonly TS.Stmt[] | undefined): PY.Stmt[] => nonEmpty(bodyOf(b).flatMap(stmt));
	// Python has no empty suite -- `pass` is the placeholder wherever a body would otherwise be blank.
	const nonEmpty	= (body: PY.Stmt[]): PY.Stmt[] => body.length ? body : [{ type: 'pass' }];
	const orelse	= (b: TS.Stmt | readonly TS.Stmt[] | undefined): PY.Stmt[] => b === undefined ? [] : body(b);

	const forTarget	= (init: JS.ForInit<TS.Type>): PY.Expr => isJSVarDecl(init) ? Identifier(bindName(init.declarations[0].name)) : expr(init);

	// [~] type annotations are a whole separate AST domain; only the simplest refs carry over
	const PYTYPE: Record<string, string> = { number: 'float', string: 'str', boolean: 'bool', void: 'None', any: 'object', unknown: 'object' };
	const typeExpr = (t: TS.Type): PY.Expr =>
			t.type === 'ref'	? Identifier(PYTYPE[t.name] ?? t.name)
		:	t.type === 'array'	? Index(Identifier('list'), typeExpr(t.element))
		:	Identifier('object');


	function expr(e: TS.Expr): PY.Expr {
		switch (e.type) {
			// [=] identical shapes -- these are the payoff
			case 'identifier':	return e.name === 'undefined' ? Literal(null) : e;
			case 'literal':		return	Array.isArray(e.value)			? Literal(e.value.map(p => ({ text: p.str, field: p.exp && { expr: expr(p.exp) } })))
									:	e.value instanceof RegExp		? pyUnsupported('regex literal')
									:	Literal(typeof e.value === 'bigint' ? Number(e.value) : e.value);
			case 'member':		return Member(expr(e.object), e.property);
			case 'index':		return Index(expr(e.object), expr(e.index));
			case 'conditional':	return Conditional(expr(e.test), expr(e.consequent), expr(e.alternate));
			case 'spread':		return Spread(expr(e.operand));
			// [~] `yield* x` and `yield from x` are the same idea spelled with a flag vs a field
			case 'yield':		return e.delegate
				?	{ type: 'yield', from: e.operand ? expr(e.operand) : pyUnsupported('`yield*` with no operand') }
				:	Yield(e.operand && expr(e.operand));

			// [=] retag only
			case 'array':		return Sequence('list', e.elements.map(x => x ? expr(x) : Literal(null)));

			// [~] Arg wrapper: Python call arguments carry a kind (pos/kw/star/dstar)
			case 'call': {
				const args = e.arguments.map(a => a.type === 'spread' ? { kind: 'star' as const, value: expr(a.operand) } : pos(expr(a)));
				// a bare `super(...)` is the base constructor; `super.m(...)` a base method -- both take `self`
				return	e.callee.type === 'super'										? Call(Member(base(), '__init__'), [pos(Identifier('self')), ...args])
					:	e.callee.type === 'member' && e.callee.object.type === 'super'	? Call(Member(base(), e.callee.property), [pos(Identifier('self')), ...args])
					:	Call(expr(e.callee), args);
			}
			case 'new':			return Call(expr(e.callee), e.arguments.map(a => pos(expr(a))));

			case 'await':		return Await(expr(e.operand));
			case 'unary': {
				const op = UNARY[e.operator];
				return	e.operator === 'typeof'	? call('type', expr(e.operand))
					:	op						? Unary(op, expr(e.operand))
					:	pyUnsupported(`unary '${e.operator}'`);
			}

			case 'binary': {
				const cmp = COMPARE[e.operator], bin = BINARY[e.operator];
				return	cmp							? compare(cmp, expr(e.left), expr(e.right))
					:	bin							? Binary(bin, expr(e.left), expr(e.right))
					:	e.operator === '??'			? Conditional(compare('is not', expr(e.left), Literal(null)), expr(e.left), expr(e.right))
					:	e.operator === 'instanceof'	? call('isinstance', expr(e.left), expr(e.right))
					:	pyUnsupported(`binary '${e.operator}'`);
			}

			// [~] object literal -> dict
			case 'object':		return {
				type:	'dict',
				keys:	e.properties.map(p => p.type === 'field' ? keyExpr(p.key) : pyUnsupported('method in an object literal')),
				values:	e.properties.map(p => p.type === 'field' && p.value ? expr(p.value) : Literal(null)),
			};

			// [~] only the expression-bodied form maps; a statement body needs a named def
			case 'arrow':		return Array.isArray(e.body)
				?	pyUnsupported('arrow with a statement body (in expression position)')
				:	{ type: 'lambda', params: e.params.map(param), body: expr(e.body) };

			case 'this':		return Identifier('self');
			// [~] `super.m()` -> `Base.m(self)`; needs the enclosing class, so it's threaded through
			case 'super':		return base();
			case 'sequence':	return pyUnsupported('comma expression');
			// [~] Python has no general assignment-expression (`:=` is far narrower) -- statements only
			case 'assign':		return pyUnsupported('assignment used as an expression');
			// [=] TS-only wrappers just unwrap
			case 'as':
			case 'satisfies':
			case 'instantiation':	return expr(e.expression);
			default:				return pyUnsupported(`expression '${e.type}'`);
		}
	}

	// [~] JS assignment is an EXPRESSION, Python's is a statement -- that difference is real and stays.
	// What the `assign` node removed is the operator archaeology: the base operator (`+` for `+=`) is
	// stored, so this reuses the ordinary BINARY table instead of a second compound-operator one.
	function exprStmt(e: TS.Expr): PY.Stmt {
		// [~] `i++` / `++i` are expressions in JS but have no Python form at all; in STATEMENT position
		// they are exactly `i += 1`, which is the only place this accepts them.
		if ((e.type === 'unary' || e.type === 'unary_post') && (e.operator === '++' || e.operator === '--'))
			return { type: 'augassign', target: expr(e.operand), op: e.operator === '++' ? '+=' : '-=', value: Literal(1) };
		if (e.type !== 'assign')
			return ExprStmt(expr(e));
		if (!e.operator)
			return { type: 'assign', targets: [expr(e.target)], value: expr(e.value) };
		const op = BINARY[e.operator];
		// `&&=`/`||=`/`??=` short-circuit, so they are NOT `x = x and y` -- left unsupported rather than wrong
		return op && op !== '&&' && op !== '||'
			? { type: 'augassign', target: expr(e.target), op: op + '=', value: expr(e.value) }
			: pyUnsupported(`compound assignment '${e.operator}='`);
	}

	function stmt(s: TS.Stmt): PY.Stmt[] {
		switch (s.type) {
			case 'block':		return bodyOf(s).flatMap(stmt);		// [=] splice
			case 'empty':		return [{ type: 'pass' }];
			case 'expression':	return [exprStmt(s.expression)];
			case 'return':		return [Return(s.argument && expr(s.argument))];	// [=]
			case 'throw':		return [Throw(expr(s.argument))];					// [=]
			case 'break':		return [{ type: 'break' }];
			case 'continue':	return [{ type: 'continue' }];

			// [=] same field names now; only the body arity differs, and bodyOf absorbs that
			case 'if':			return [If(expr(s.test), body(s.consequent), orelse(s.alternate))];
			case 'while':		return [While(expr(s.test), body(s.body))];

			// [~] no C-style for in Python: init; while test: body; update
			case 'for':			return	s.kind === 'of' || s.kind === 'in'	? [{
					type:		'for',
					target:		forTarget(s.init),
					iter:		expr(s.right),
					body:		body(s.body),
					orelse:		[],
					is_async:	false }
				] :	s.kind === 'normal' ? [
					...(s.init ? isJSVarDecl(s.init) ? stmt(s.init) : [exprStmt(s.init)] : []),
					While(s.test ? expr(s.test) : Literal(true),[...body(s.body), ...(s.update ? [exprStmt(s.update)] : [])]),
				] :	pyUnsupported(`for kind '${s.kind}'`);

			// [~] do-while -> while True with a trailing guard
			case 'do_while':	return [While(Literal(true), [...body(s.body), If(Unary('!', expr(s.test)), [{ type: 'break' }], [])])];

			// [=] try converged in an earlier commit: same body/handlers[]/finalizer
			case 'try':			return [{
				type:		'try',
				body:		body(s.body),
				orelse:		[],
				finalizer:	orelse(s.finalizer),
				// [~] JS `catch (e)` is untyped; Python needs a class before `as`, and `except as e:` is not valid syntax -- so an untyped catch has to become `except Exception as e`.
				handlers:	s.handlers.map(h => ({
					star:	false,
					param:	h.param === undefined ? undefined : bindName(h.param),
					type:	h.param === undefined ? undefined : Identifier('Exception'),
					body:	body(h.body),
				})),
			}];

			// [~] declarations -> assignment (Python has no let/const)
			case 'var_decl':	return s.declarations.map(d => d.typeAnnotation
					?	{ type: 'annassign', target: Identifier(bindName(d.name)), annotation: typeExpr(d.typeAnnotation), value: d.init && expr(d.init) }
					:	{ type: 'assign', targets: [Identifier(bindName(d.name))], value: d.init ? expr(d.init) : Literal(null) }
				);

			case 'function_decl':	return [{
					type:		'funcdef',
					name:		s.name,
					params:		s.params.map(param),
					returns:	s.returnType && typeExpr(s.returnType),
					body:		body(s.body),
					decorators:	[],
					is_async:	!!s.modifiers?.includes('async'),
				}];

			case 'class_decl': {
				const saved = superName;
				superName	= s.superClass?.type === 'identifier' ? s.superClass.name : undefined;
				const members = s.body.flatMap(classMember);
				superName	= saved;
				return [{
					type:		'classdef',
					name:		s.name,
					bases:		s.superClass ? [pos(expr(s.superClass))] : [],
					body:		nonEmpty(members),
					decorators:	[],
				}];
			}

			case 'export_decl':	return stmt(s.declaration);		// [~] Python has no export
			default:			return pyUnsupported(`statement '${s.type}'`);
		}
	}

	// [~] `self` has to be threaded in explicitly -- Python methods take it, JS ones don't
	function classMember(m: TS.ClassMember): PY.Stmt[] {
		switch (m.type) {
			case 'method':
			case 'get':
			case 'set':		return [{
				type:		'funcdef',
				name:		keyName(m.key),
				params:		[{ name: 'self' }, ...m.params.map(param)],
				returns:	m.returnType && typeExpr(m.returnType),
				body:		body(m.body),
				decorators:	m.type === 'get' ? [Identifier('property')] : [],
				is_async:	!!m.modifiers?.includes('async'),
			}];
			case 'field':	return [{ type: 'assign', targets: [Identifier(keyName(m.key))], value: m.value ? expr(m.value) : Literal(null) }];
			default:		return pyUnsupported(`class member '${m.type}'`);
		}
	}

	return ts.body.flatMap(stmt);
}

export function ts2py(source: string, opts?: PYOptions): string {
	return new PYOutput(opts).statements(TS2PY(TS.parse(source)));
}

// ===================================================================
//  PoC: Python AST -> TypeScript AST -> TypeScript source.
//  Same [=]/[~] convention as the section above; `pyUnsupported` plays the same role as `unsupported`.
// ===================================================================

const isPYSuperCall = (e: PY.Expr): boolean => e.type === 'call' && e.callee.type === 'identifier' && e.callee.name === 'super' && e.arguments.length === 0;
const PY_BINARY = reverse(BINARY);
const PY_UNARY = reverse(UNARY);

// [~] `let` scoping: TypeScript needs one declaration before every use; Python has none. This tracks
// names already declared in the CURRENT function/module scope so only the FIRST assignment becomes a
// `let`, later ones a plain assignment -- known gap: it doesn't hoist across nested blocks, so a name
// whose only assignment sits inside an `if`/`for` and is read after it will still miscompile.
class PYScopes {
	scopes = [new Set()];
	declare(name: string): boolean {
		const scope = this.scopes.at(-1)!;
		return scope.has(name) ? false : (scope.add(name), true);
	};

	push(names: string[]) {
		this.scopes.push(new Set(names));
	}
	pop() { this.scopes.pop(); }
}

function PY2TS(py: Module<PY.Stmt>) {

	//const PY_COMPARE1 = reverse(COMPARE);
	const COMPARE: Partial<Record<PY.compareOps, JS.compareOps>> = {
		'<':	'<',
		'>':	'>',
		'<=':	'<=',
		'>=':	'>=',
		'==':	'===',
		'!=':	'!==',
		'<>':	'!==',
		'is':	'===',
		'is not': '!==',
	};
	const TYPE: Record<string, string> = {
		float:	'number',
		int:	'number',
		str:	'string',
		bool:	'boolean',
		object:	'unknown',
		Any:	'unknown'
	};


	// [~] Python's `self` is just a convention (an ordinary first parameter), not a keyword like JS's `this`
	// -- the enclosing (non-static) method's own name for it is threaded through so a reference to it converts.
	let self: string | undefined;
	const scope = new PYScopes;

	function args(args: PY.Arg[]): TS.Expr[] {
		return args.map(a => a.kind === 'star' ? Spread(expr(a.value)) : a.kind === 'pos' ? expr(a.value) : tsUnsupported(`'${a.kind}' argument`));
	}

	function compareTerm(op: PY.compareOps, left: TS.Expr, right: TS.Expr): TS.Expr {
		if (op === 'not in')
			return Unary('!', Binary('in', left, right));
		if (op === 'in')
			return Binary('in', left, right);
		const m = COMPARE[op];
		return m ? Binary(m, left, right) : tsUnsupported(`comparison '${op}'`);
	}

	function key(k: PY.Expr): JS.Key {
		return k.type === 'literal' && typeof k.value === 'string' ? k.value : { computed: expr(k) };
	}

	function typeExpr(t: PY.Expr): TS.Type {
		if (t.type === 'literal' && t.value === null)
			return { type: 'ref', name: 'null' };
		if (t.type === 'identifier')
			return { type: 'ref', name: TYPE[t.name] ?? t.name };
		if (t.type === 'index') {
			const base = t.object.type === 'identifier' ? t.object.name : undefined;
			const args = t.index.type === 'tuple' ? t.index.elements : [t.index];
			if (base === 'List' || base === 'list')
				return { type: 'array', element: typeExpr(args[0]) };
			if (base === 'Optional')
				return { type: 'union', types: [typeExpr(args[0]), { type: 'ref', name: 'null' }] };
			if (base)
				return { type: 'ref', name: base, typeArgs: args.map(typeExpr) };
		}
		if (t.type === 'binary' && t.operator === '|')
			return { type: 'union', types: [typeExpr(t.left), typeExpr(t.right)] };
		return { type: 'ref', name: 'unknown' };
	}

	function param(p: PY.Param): JS.Param<TS.Type> {
		if (p.kind && p.kind !== 'normal')
			tsUnsupported("'*'/'**'/'/' parameter");
		return { key: p.name ?? tsUnsupported('bare parameter separator'), typeAnnotation: p.annotation && typeExpr(p.annotation), default: p.default && expr(p.default) };
	}

	function expr(e: PY.Expr): TS.Expr {
		switch (e.type) {
			// [=] identical shapes
			case 'identifier':	return e.name === self ? { type: 'this' } : e;
			case 'literal':
				if (!Array.isArray(e.value))
					return Literal(e.value);
				// [~] f-string -> template literal; format spec (`:.2f` etc.) and `!r`/`=` self-documenting forms are dropped
				return Literal(e.value.map(p => ({ str: p.text, exp: p.field && expr(p.field.expr) })));

			case 'member':		return Member(expr(e.object), e.property);
			case 'conditional':	return Conditional(expr(e.test), expr(e.consequent), expr(e.alternate));
			case 'spread':		return Spread(expr(e.operand));
			case 'await':		return Await(expr(e.operand));

			case 'imaginary':	return tsUnsupported('imaginary literal');
			case 'ellipsis':	return tsUnsupported('`...` literal');

			case 'unary': {
				const op = PY_UNARY[e.operator];
				return op ? Unary(op, expr(e.operand)) : tsUnsupported(`unary '${e.operator}'`);
			}
			// [~] Python has no `//`; `Math.floor(a / b)` is the closest direct equivalent
			case 'binary': {
				const op = PY_BINARY[e.operator];
				return	op					? Binary(op, expr(e.left), expr(e.right))
					:	e.operator === '//'	? Call(Member(Identifier('Math'), 'floor'), [Binary('/', expr(e.left), expr(e.right))])
					:	tsUnsupported(`binary '${e.operator}'`);
			}
			// [~] chained comparison has no direct TS form -- desugars to an `&&` chain of pairwise comparisons
			case 'compare': {
				let left = expr(e.left), result: TS.Expr | undefined;
				e.ops.forEach((op, i) => {
					const right = expr(e.comparators[i]);
					result = result ? Binary('&&', result, compareTerm(op, left, right)) : compareTerm(op, left, right);
					left = right;
				});
				return result!;
			}
			case 'lambda':		return JS.Arrow(JS.CallSig(e.params.map(param)), expr(e.body));
			// [~] Python's walrus is the one case of TS's more general assignment EXPRESSION
			case 'namedexpr':	return Assign(Identifier(e.target), expr(e.value));

			case 'index':
				if (e.index.type === 'slice' || e.index.type === 'tuple')
					return tsUnsupported('slice subscript');
				return Index(expr(e.object), expr(e.index));
			case 'slice':		return tsUnsupported('slice expression (outside a subscript)');

			// [~] `super().__init__(...)` / `super().m(...)` -> TS's `super(...)` / `super.m(...)`
			case 'call': {
				if (e.callee.type === 'member' && isPYSuperCall(e.callee.object))
					return e.callee.property === '__init__'
						?	Call({ type: 'super' } as TS.Expr, args(e.arguments))
						:	Call(Member({ type: 'super' } as TS.Expr, e.callee.property), args(e.arguments));
				if (isPYSuperCall(e))
					return tsUnsupported('bare `super()` (only `super().x(...)` translates)');
				return Call(expr(e.callee), args(e.arguments));
			}

			// [~] Python's tuple has no TS counterpart -- an array is the closest fit (and often is one, at the call site)
			case 'tuple':
			case 'list':		return JS.ArrayLit(e.elements.map(expr));
			case 'set':			return { type: 'new', callee: Identifier('Set'), arguments: [JS.ArrayLit(e.elements.map(expr))] };
			case 'dict':		return JS.ObjectExpr(e.keys.map((k, i) => k === null ? tsUnsupported('dict unpacking (`**x`)') : JS.Field(key(k), expr(e.values[i]))));

			case 'genexp':
			case 'listcomp':
			case 'setcomp':
			case 'dictcomp':	return tsUnsupported(`comprehension ('${e.type}')`);

			// [~] `yield from x` (delegation) <-> `yield* x` (same idea, spelled with a flag vs a field)
			case 'yield':		return { type: 'yield', operand: e.from ? expr(e.from) : e.operand && expr(e.operand), delegate: !!e.from };

			default:			return tsUnsupported(`expression '${(e as PY.Expr).type}'`);
		}
	}

	const body  = (b: readonly PY.Stmt[]) => b.flatMap(stmt);
	const block = (b: readonly PY.Stmt[]) => JS.Block(...body(b));

	// [~] N Python `except` clauses have no direct TS counterpart (one untyped `catch`) -- desugars to a
	// single `catch (e)` holding an `instanceof` if/else-if chain, re-throwing `e` if nothing matches.
	function pyTry(s: PY.TryStmt): TS.Stmt {
		if (s.orelse.length)
			tsUnsupported('`try ... else`');
		const finalizer = s.finalizer.length ? body(s.finalizer) : undefined;
		if (s.handlers.length === 0)
			return { type: 'try', body: body(s.body), handlers: [], finalizer } as TS.Stmt;
		const param = 'e';
		const catchAll = s.handlers.find(h => !h.type);
		const typed = s.handlers.filter(h => h.type);
		const bind = (h: PY.ExceptHandler, body: TS.Stmt[]): TS.Stmt[] => h.param && h.param !== param ? [JS.VarDecl('let', JS.Var(h.param, Identifier(param))), ...body] : body;
		let chain: TS.Stmt = catchAll ? JS.Block(...bind(catchAll, body(catchAll.body))) : JS.Block({ type: 'throw', argument: Identifier(param) } as TS.Stmt);
		for (let i = typed.length; i-- > 0;) {
			const h = typed[i];
			chain = If(Binary('instanceof', Identifier(param), expr(h.type!)), JS.Block(...bind(h, body(h.body))), chain);
		}
		return { type: 'try', body: body(s.body), handlers: [{ param, body: [chain] }], finalizer } as TS.Stmt;
	}

	// [~] `self` is dropped explicitly here -- Python methods declare it, TS ones don't
	function pyClassMember(m: PY.Stmt): TS.ClassMember[] {
		switch (m.type) {
			case 'pass':	return [];
			case 'funcdef': {
				const isStatic	= m.decorators.some(d => d.type === 'identifier' && d.name === 'staticmethod');
				const isGetter	= m.decorators.some(d => d.type === 'identifier' && d.name === 'property');
				const isSetter	= m.decorators.some(d => d.type === 'member' && d.property === 'setter');
				if (m.decorators.some(d => d.type === 'identifier' && d.name === 'classmethod'))
					tsUnsupported('@classmethod');
				if (m.decorators.length > (isStatic || isGetter || isSetter ? 1 : 0))
					tsUnsupported('decorator');
				const params = (isStatic ? m.params : m.params.slice(1)).map(param);
				scope.push(params.map(p => typeof p.key === 'string' ? p.key : undefined).filter((n): n is string => !!n));
				const savedSelf = self;
				self = isStatic ? undefined : m.params[0]?.name;
				const body1 = body(m.body);
				self = savedSelf;
				scope.pop();
				return [{
					type:		isGetter ? 'get' : isSetter ? 'set' : 'method',
					key:		m.name === '__init__' ? 'constructor' : m.name,
					params,
					returnType:	m.returns && typeExpr(m.returns),
					body: body1,
					modifiers:	isStatic ? ['static'] : undefined,
				} as TS.ClassMember];
			}
			case 'assign':
				return m.targets.length === 1 && m.targets[0].type === 'identifier'
					? [JS.Field(m.targets[0].name, expr(m.value))]
					: tsUnsupported('complex class-body assignment');
			case 'annassign':
				return m.target.type === 'identifier'
					? [JS.Field(m.target.name, m.value && expr(m.value), typeExpr(m.annotation))]
					: tsUnsupported('complex annotated field');
			default:		return tsUnsupported(`class member '${m.type}'`);
		}
	}

	function stmt(s: PY.Stmt): TS.Stmt[] {
		switch (s.type) {
			case 'expression':	return [ExprStmt(expr(s.expression))];
			case 'return':		return [Return(s.argument && expr(s.argument))];
			case 'pass':		return [];
			case 'break':		return [{ type: 'break' }];
			case 'continue':	return [{ type: 'continue' }];
			// [~] `raise Foo(...)` calls the exception class; JS/TS needs an explicit `new` there
			case 'throw': {
				if (!s.argument)
					return tsUnsupported('bare `raise` (re-raise)');
				const arg = expr(s.argument);
				return [{ type: 'throw', argument: arg.type === 'call' ? { type: 'new', callee: arg.callee, arguments: arg.arguments } : arg } as TS.Stmt];
			}

			// [~] first assignment of a name -> `let`; later ones are a plain assignment (see `pyDeclare`)
			case 'assign': {
				if (s.targets.length !== 1)
					return tsUnsupported('chained assignment (`a = b = c`)');
				const target = s.targets[0];
				return target.type === 'identifier' && scope.declare(target.name)
					?	[JS.VarDecl('let', JS.Var(target.name, expr(s.value)))]
					:	[ExprStmt(Assign(expr(target), expr(s.value)))];
			}
			case 'augassign': {
				const op = PY_BINARY[s.op.slice(0, -1) as PY.binaryOps];
				return op && op !== '&&' && op !== '||'
					?	[ExprStmt(Assign(expr(s.target), expr(s.value), op as JS.assignableOps))]
					:	tsUnsupported(`compound assignment '${s.op}='`);
			}
			case 'annassign': {
				if (s.target.type !== 'identifier')
					return tsUnsupported('annotated assignment to a non-identifier');
				scope.declare(s.target.name);
				return [JS.VarDecl('let', JS.Var(s.target.name, s.value && expr(s.value), typeExpr(s.annotation)))];
			}

			case 'global':
			case 'nonlocal':	return tsUnsupported(`'${s.type}' declaration`);
			// [~] `del` only has a TS equivalent for a property/element -- `delete x` on a plain local isn't legal TS
			case 'del':
				return s.targets.type === 'member' || s.targets.type === 'index'
					?	[ExprStmt(Unary('delete', expr(s.targets)))]
					:	tsUnsupported('`del` of a plain name');
			// [~] Python's `assert` -> `if (!test) throw new Error(msg)`
			case 'assert':
				return [If(Unary('!', expr(s.test)), JS.Block({ type: 'throw', argument: { type: 'new', callee: Identifier('Error'), arguments: s.msg ? [expr(s.msg)] : [] }}))];
			case 'import':
			case 'importfrom':	return tsUnsupported(`'${s.type}' (module systems differ too much to translate)`);

			case 'if':			return [If(expr(s.test), block(s.consequent), s.alternate?.length ? block(s.alternate) : undefined)];
			case 'while':		return s.orelse?.length ? tsUnsupported('`while ... else`') : [While(expr(s.test), block(s.body))];
			// [~] Python's `for` is always a for-of; a tuple-unpacking target has no single-binding TS equivalent
			case 'for':
				if (s.orelse.length)
					return tsUnsupported('`for ... else`');
				if (s.target.type !== 'identifier')
					return tsUnsupported('destructuring `for` target');
				return [{ type: 'for', kind: 'of', init: JS.VarDecl('let', JS.Var(s.target.name)), right: expr(s.iter), body: block(s.body) }];
			case 'with':		return tsUnsupported('`with` statement (no direct RAII equivalent)');
			case 'try':			return [pyTry(s)];

			case 'funcdef': {
				if (s.decorators.length)
					return tsUnsupported('function decorator');
				scope.push(s.params.map(p => p.name).filter((n): n is string => !!n));
				const body1 = body(s.body);
				scope.pop();
				return [{
					type:		'function_decl',
					name:		s.name,
					params:		s.params.map(param),
					returnType:	s.returns && typeExpr(s.returns),
					body: body1,
					modifiers:	s.is_async ? ['async'] : undefined,
				} as TS.Stmt];
			}
			case 'classdef': {
				if (s.bases.length > 1)
					return tsUnsupported('multiple base classes');
				if (s.decorators.length)
					return tsUnsupported('class decorator');
				const superClass = s.bases[0] && expr(s.bases[0].value);
				scope.push([]);
				const body = s.body.flatMap(pyClassMember);
				scope.pop();
				return [{ type: 'class_decl', name: s.name, superClass, body } as TS.Stmt];
			}
			default:			return tsUnsupported(`statement '${(s as PY.Stmt).type}'`);
		}
	}
	return py.body.flatMap(stmt);
}

export function py2ts(source: string, opts?: TSOptions): string {
	return new TSOutput(opts).statements(PY2TS(PY.parse(source)));
}

// ===================================================================
//  PoC: C++ AST -> TypeScript AST -> TypeScript source.
//  Templates, multiple inheritance, raw pointers/references, and out-of-class member definitions are
//  out of scope (`cppUnsupported`) -- this covers the same "ordinary class + control flow" subset the
//  other two directions do.
// ===================================================================

function CPP2TS(cpp: Module<CPP.Definition>) {

	// [~] tison's GLR engine forks on a genuine ambiguity (e.g. `T(x)` as a call vs. a functional-style
	// cast) and, when neither branch dies, leaves BOTH survivors behind as an array instead of one node --
	// picking the first is a pragmatic default, not a real disambiguation.
	const first = <T,>(x: T | T[]): T => Array.isArray(x) ? x[0] : x;

	function declaratorName(d: CPP.Declarator): string {
		switch (d.type) {
			case 'identifier':	return d.name;
			case 'function':	return declaratorName(d.name);
			case 'array':		return declaratorName(d.element);
			case 'pointer':		return declaratorName(d.to);
			case 'reference':
			case 'rvalue_reference':	return declaratorName(d.to);
		}
	}

	const CPP_TSTYPE: Record<string, string> = { int: 'number', short: 'number', long: 'number', float: 'number', double: 'number', bool: 'boolean', void: 'void', char: 'string', 'std::string': 'string', string: 'string', auto: 'unknown' };

	function cppTypeSpecToTs(t: CPP.TypeSpecifier): TS.Type {
		if (t.type === 'ref')
			return { type: 'ref', name: CPP_TSTYPE[t.name.trim()] ?? t.name.trim() };
		// [~] `std::vector<T>` is the one generic worth a first-class TS shape; anything else keeps its name as a generic reference
		if (t.type === 'generic')
			return t.name.replace(/^std::/, '') === 'vector' && t.args.length === 1
				?	{ type: 'array', element: cppTemplateArgToTs(t.args[0]) }
				:	{ type: 'ref', name: t.name, typeArgs: t.args.map(cppTemplateArgToTs) };
		return tsUnsupported(`type specifier '${t.type}'`);
	}
	function cppTemplateArgToTs(a: CPP.TemplateArg): TS.Type {
		return 'specifiers' in a.value ? cppTypeNameToTs(a.value) : tsUnsupported('non-type template argument');
	}
	function cppTypeNameToTs(t: CPP.TypeName): TS.Type {
		return cppAbstractDeclToTs(t.declarator, t.specifiers.type);
	}
	function cppAbstractDeclToTs(d: CPP.AbstractDeclarator | undefined, base: CPP.TypeSpecifier): TS.Type {
		if (!d)
			return cppTypeSpecToTs(base);
		switch (d.type) {
			case 'reference':
			case 'rvalue_reference':	return cppAbstractDeclToTs(d.to, base);
			// [~] `char*` is the one raw-pointer shape treated as meaningful (a C string) -- any other pointer has no TS equivalent
			case 'pointer':				return base.type === 'ref' && base.name.trim() === 'char' && !d.to ? { type: 'ref', name: 'string' } : tsUnsupported('pointer type');
			case 'array':				return { type: 'array', element: cppAbstractDeclToTs(d.element, base) };
			case 'function':			return tsUnsupported('function-pointer type');
		}
	}
	// Same idea as `cppAbstractDeclToTs`, but walking a real (named) Declarator instead of an abstract one.
	function cppDeclaratorToTsType(d: CPP.Declarator, base: CPP.TypeSpecifier): TS.Type {
		switch (d.type) {
			case 'identifier':			return cppTypeSpecToTs(base);
			case 'reference':
			case 'rvalue_reference':	return cppDeclaratorToTsType(d.to, base);
			case 'pointer':				return base.type === 'ref' && base.name.trim() === 'char' && d.to.type === 'identifier' ? { type: 'ref', name: 'string' } : tsUnsupported('pointer variable');
			case 'array':				return { type: 'array', element: cppDeclaratorToTsType(d.element, base) };
			case 'function':			return tsUnsupported('function-pointer declarator');
		}
	}

	function cppParamToTs(p: CPP.ParamDecl): JS.Param<TS.Type> {
		if (isCppPackParameter(p))
			return tsUnsupported('variadic template parameter pack');
		if (!p.declarator)
			return tsUnsupported('unnamed parameter');
		return { key: declaratorName(p.declarator), typeAnnotation: cppDeclaratorToTsType(p.declarator, p.specifiers.type), default: p.default && expr(p.default) };
	}
	function cppParamNames(params: CPP.ParamDecl[]): string[] {
		return params.flatMap(p => isCppPackParameter(p) ? (p.name ? [p.name] : []) : p.declarator ? [declaratorName(p.declarator)] : []);
	}

	// [~] a parameter or local variable shadows a same-named member -- `cppLocals` tracks what's currently
	// shadowed within the enclosing function/method so `cppExpr`'s identifier case doesn't over-rewrite.
	let cppLocals = new Set<string>();
	function withCppLocals<T>(names: string[], fn: () => T): T {
		const saved = cppLocals;
		cppLocals = new Set(names);
		const result = fn();
		cppLocals = saved;
		return result;
	}

	function cppInitializerToTs(i: C.Initializer<CPP.Expr>): TS.Expr {
		return isCppExprNode(i) ? expr(i) : JS.ArrayLit(i.elements.map(cppInitializerToTs));
	}
	function cppInitDeclaratorToVar(id: C.InitDeclarator<CPP.Declarator, CPP.Expr>, specifiers: CPP.DeclarationSpec): JS.Var<TS.Type> {
		const declarator = 'declarator' in id ? id.declarator : id;
		return {
			name:			declaratorName(declarator),
			typeAnnotation:	cppDeclaratorToTsType(declarator, specifiers.type),
			init:			'declarator' in id ? cppInitializerToTs(id.initializer) : undefined,
		};
	}

	function expr(e: CPP.Expr): TS.Expr {
		e = first(e);
		switch (e.type) {
			// [~] a bare name that's one of the enclosing class's own members needs an explicit `this.`
			// (unless a parameter/local of the same name shadows it, per `cppLocals`)
			case 'identifier':		return cppMemberNames.has(e.name) && !cppLocals.has(e.name) ? Member({ type: 'this' } as TS.Expr, e.name) : e;
			case 'literal':			return Literal(e.value);
			case 'char_literal':	return Literal(e.value);
			case 'null_literal':	return Literal(null);
			case 'this':			return { type: 'this' };
			case 'conditional':		return Conditional(expr(e.test), expr(e.consequent), expr(e.alternate));
			case 'index':			return Index(expr(e.object), expr(e.index));
			case 'member':			return Member(expr(e.object), e.property);
			// `->` dereferences first in C++; TS has no pointers to dereference, so it collapses onto plain `.`
			case 'pointer_member':	return Member(expr(e.object), e.property);
			case 'call':			return Call(expr(e.callee), e.arguments.map(expr));
			case 'spread':			return Spread(expr(e.operand));

			case 'unary': {
				const op = e.operator;
				return	op === '++' || op === '--' || op === '+' || op === '-' || op === '~' || op === '!'	? Unary(op, expr(e.operand))
					:	op === '&'	? tsUnsupported('address-of (`&x`)')
					:	op === '*'	? tsUnsupported('pointer dereference (`*x`)')
					:	tsUnsupported('`sizeof`');
			}
			case 'unary_post':	return UnaryPost(e.operator as '++' | '--', expr(e.operand));

			case 'binary': {
				const op = e.operator;
				return op === ','
					? { type: 'sequence', expressions: [expr(e.left), expr(e.right)] }
					: Binary(op as JS.binaryOps, expr(e.left), expr(e.right));
			}
			// [=] both languages now model assignment as its own node -- same shape, just a narrower operator union
			case 'assign':			return Assign(expr(e.target), expr(e.value), e.operator as JS.assignableOps | undefined);

			case 'cast':			return { type: 'as', expression: expr(e.expression), typeAnnotation: cppTypeNameToTs(e.typeAnnotation) };
			case 'cpp_cast':		return { type: 'as', expression: expr(e.expression), typeAnnotation: cppTypeNameToTs(e.target) };
			case 'functional_cast':	return Call(Identifier(e.target), e.arguments.map(expr));
			case 'sizeof_type':		return tsUnsupported('`sizeof`');
			case 'sizeof_pack':		return tsUnsupported('`sizeof...`');
			case 'typeid':
			case 'alignof':			return tsUnsupported(`'${e.type}'`);
			case 'delete':			return tsUnsupported('`delete` (TS is garbage-collected)');

			case 'qualified':		return e.parts.slice(1).reduce<TS.Expr>((o, p) => Member(o, p), Identifier(e.parts[0]));
			case 'new': {
				if (e.placement?.length)
					return tsUnsupported('placement `new`');
				if (e.size)
					return { type: 'new', callee: Identifier('Array'), arguments: [expr(e.size)] };
				return {
					type:		'new',
					callee:		Identifier(e.typeName.type === 'ref' || e.typeName.type === 'generic' ? e.typeName.name : tsUnsupported(`'new' of a '${e.typeName.type}' type`)),
					arguments:	(e.arguments ?? []).map(expr),
				};
			}
			// [~] a lambda's own body is a real statement list either way -- TS's arrow accepts one directly
			case 'lambda':			return { type: 'arrow', params: e.params.map(cppParamToTs), body: withCppLocals(cppParamNames(e.params), () => e.body.body.flatMap(stmt)) } as TS.Expr;

			default:				return tsUnsupported(`expression '${(e as CPP.Expr).type}'`);
		}
	}

	const cppBlockOf = (s: CPP.Stmt): TS.Stmt => JS.Block(...bodyOf(s).flatMap(stmt));

	function cppForToTs(s: CPP.Stmt & { type: 'for' }): TS.Stmt {
		const initClause = s.init;
		let init: JS.ForInit<TS.Type> | undefined;
		if (initClause) {
			if (initClause.type === 'declaration')
				init = { type: 'var_decl', kind: 'let', declarations: (initClause.initDeclarators ?? []).map(id => cppInitDeclaratorToVar(id, initClause.specifiers)) };
			else if (initClause.type === 'typedef')
				return tsUnsupported('`typedef` in a `for` init');
			else
				init = expr(initClause);
		}
		return { type: 'for', kind: 'normal', init, test: s.test && expr(s.test), update: s.update && expr(s.update), body: cppBlockOf(s.body) };
	}

	// [~] C's `switch` is a flat statement list with `case`/`default` LABELS (fall-through is just "no
	// `break`"); TS groups consecutive statements under each case explicitly, so this re-groups them.
	function cppSwitchToTs(s: CPP.Stmt & { type: 'switch' }): TS.Stmt {
		const cases: { test?: TS.Expr; consequent: TS.Stmt[] }[] = [];
		for (const st of bodyOf(s.body)) {
			if (st.type === 'case' || st.type === 'default')
				cases.push({ test: st.type === 'case' ? expr(st.test) : undefined, consequent: stmt(st.body) });
			else if (cases.length)
				cases[cases.length - 1].consequent.push(...stmt(st));
			else
				tsUnsupported('statement before the first `case`/`default`');
		}
		return { type: 'switch', discriminant: expr(s.discriminant), cases };
	}

	// [~] N C++ `catch` clauses have no direct TS counterpart (one untyped `catch`) -- same `instanceof`
	// if/else-if desugaring as `pyTry` above.
	function cppTryToTs(s: CPP.Stmt & { type: 'try' }): TS.Stmt {
		const body = bodyOf(s.body).flatMap(stmt);
		if (s.handlers.length === 0)
			return { type: 'try', body, handlers: [], finalizer: undefined } as TS.Stmt;
		const param = 'e';
		const catchAll = s.handlers.find(h => !h.type);
		const typed = s.handlers.filter(h => h.type);
		const bind = (h: CPP.CatchClause, b: TS.Stmt[]): TS.Stmt[] => h.param && h.param !== param ? [{ type: 'var_decl', kind: 'let', declarations: [{ name: h.param, init: Identifier(param) }] } as TS.Stmt, ...b] : b;
		let chain: TS.Stmt = catchAll ? JS.Block(...bind(catchAll, bodyOf(catchAll.body).flatMap(stmt))) : JS.Block({ type: 'throw', argument: Identifier(param) } as TS.Stmt);
		for (let i = typed.length; i-- > 0;) {
			const h = typed[i];
			const typeSpec = h.type!.specifiers.type;
			chain = If(
				Binary('instanceof', Identifier(param), Identifier(typeSpec.type === 'ref' ? typeSpec.name : tsUnsupported('non-simple exception type'))),
				JS.Block(...bind(h, bodyOf(h.body).flatMap(stmt))),
				chain,
			);
		}
		return { type: 'try', body, handlers: [{ param, body: [chain] }], finalizer: undefined } as TS.Stmt;
	}

	function stmt(s: CPP.Stmt): TS.Stmt[] {
		s = first(s);
		switch (s.type) {
			case 'block':		return s.body.flatMap(stmt);
			case 'declaration': {
				if (!s.initDeclarators)
					return [];
				const declarations = s.initDeclarators.map(id => cppInitDeclaratorToVar(id, s.specifiers));
				declarations.forEach(v => cppLocals.add(v.name as string));
				return [{ type: 'var_decl', kind: 'let', declarations } as TS.Stmt];
			}
			case 'typedef':		return tsUnsupported('local `typedef`');
			case 'if':			return [If(expr(s.test), cppBlockOf(s.consequent), s.alternate && cppBlockOf(s.alternate))];
			case 'while':		return [While(expr(s.test), cppBlockOf(s.body))];
			case 'do_while':	return [DoWhile(cppBlockOf(s.body), expr(s.test))];
			case 'for':			return [cppForToTs(s)];
			case 'switch':		return [cppSwitchToTs(s)];
			case 'case':
			case 'default':		return tsUnsupported(`'${s.type}' outside a switch`);
			case 'break':		return [{ type: 'break' }];
			case 'continue':	return [{ type: 'continue' }];
			case 'return':		return [Return(s.argument && expr(s.argument))];
			case 'goto':		return tsUnsupported('`goto`');
			case 'labeled':		return [{ type: 'labeled', label: s.label, body: cppBlockOf(s.body) }];
			case 'empty':		return [{ type: 'empty' }];
			case 'expression':	return [ExprStmt(expr(s.expression))];
			// [~] `throw Foo(...)` calls the exception class; TS needs an explicit `new` there
			case 'throw': {
				if (!s.argument)
					return tsUnsupported('bare `throw;` (re-throw)');
				const arg = expr(s.argument);
				return [{ type: 'throw', argument: arg.type === 'call' ? { type: 'new', callee: arg.callee, arguments: arg.arguments } : arg } as TS.Stmt];
			}
			case 'try':			return [cppTryToTs(s)];
			// [~] Python's `for` is always a for-of; so is C++'s range-for -- both land on the same TS shape
			case 'range_for':	return [{ type: 'for', kind: 'of', init: { type: 'var_decl', kind: 'let', declarations: [{ name: declaratorName(s.declarator) }] }, right: expr(s.range), body: cppBlockOf(s.body) }];
			case 'static_assert':	return tsUnsupported('`static_assert`');
			// no TS meaning either way -- dropped rather than flagged unsupported
			case 'using_namespace':
			case 'using_decl':		return [];
			case 'using_alias':		return [{ type: 'type_alias_decl', name: s.name, value: cppTypeNameToTs(s.target) } as TS.Stmt];
			default:				return tsUnsupported(`statement '${(s as CPP.Stmt).type}'`);
		}
	}

	function cppMemberBody(m: CPP.MethodTail | CPP.CtorTail): TS.Stmt[] {
		return m.body ? m.body.body.flatMap(stmt) : tsUnsupported('member with no body (`= default`/`= delete`/declaration-only)');
	}

	// [~] a C++ member-initializer list has no TS equivalent -- the base-class entry becomes the
	// mandatory leading `super(...)` call, and any field entry becomes a `this.field = ...` assignment.
	function cppCtorBody(m: CPP.ConstructorMember, baseName: string | undefined): TS.Stmt[] {
		return withCppLocals(cppParamNames(m.params), () => {
			const body = cppMemberBody(m);
			const baseInit = m.initializerList?.find(mi => mi.name === baseName);
			const fieldInits = (m.initializerList ?? []).filter(mi => mi.name !== baseName).map(mi => ExprStmt(Assign<TS.Expr, JS.assignableOps>(
				Member({ type: 'this' } as TS.Expr, mi.name),
				mi.arguments.length === 1 ? expr(mi.arguments[0]) : tsUnsupported('multi-argument member initializer'),
			)));
			const superCall = baseName ? [ExprStmt(Call({ type: 'super' } as TS.Expr, (baseInit?.arguments ?? []).map(expr)))] : [];
			return [...superCall, ...fieldInits, ...body];
		});
	}

	// [~] C++ lets a method reference its own fields/methods by bare name; TS always needs `this.` --
	// `cppMemberNames` (the enclosing class's own member names) is what lets an identifier get rewritten.
	let cppMemberNames = new Set<string>();

	function cppMemberNamesOf(m: CPP.ClassMember): string[] {
		m = first(m);
		switch (m.type) {
			case 'method':			return m.declarator.type === 'function' ? [declaratorName(m.declarator.name)] : [];
			case 'struct_member':	return m.declarators.flatMap(d => 'declarator' in d ? [declaratorName(d.declarator)] : d.name ? [d.name] : []);
			default:				return [];
		}
	}

	// [~] visibility (`public`/`private`/`protected`) has no TS class-member equivalent modeled here -- labels are dropped
	function classMember(m: CPP.ClassMember, baseName: string | undefined): TS.ClassMember[] {
		m = first(m);
		switch (m.type) {
			case 'access_label':	return [];
			case 'constructor':		return [{ type: 'method', key: 'constructor', params: m.params.map(cppParamToTs), body: cppCtorBody(m, baseName) } as TS.ClassMember];
			case 'destructor':		return tsUnsupported('destructor');
			case 'method': {
				const decl = m.declarator;
				if (decl.type !== 'function')
					return tsUnsupported('method returning a pointer/array (complex declarator)');
				return [{
					type:		'method',
					key:		declaratorName(decl.name),
					params:		decl.params.map(cppParamToTs),
					returnType:	cppDeclaratorToTsType(decl.name, m.specifiers.type),
					body:		withCppLocals(cppParamNames(decl.params), () => cppMemberBody(m)),
					modifiers:	m.modifiers?.includes('static') ? ['static'] : undefined,
				} as TS.ClassMember];
			}
			case 'conversion':		return tsUnsupported('conversion operator');
			case 'using_decl':
			case 'using_alias':		return tsUnsupported(`'${m.type}' class member`);
			case 'member_template':	return tsUnsupported('member template');
			case 'struct_member': {
				if (m.declarators.length !== 1)
					return tsUnsupported('multi-name field declaration');
				const fd = m.declarators[0];
				if (!('declarator' in fd))
					return tsUnsupported('bitfield');
				return [JS.Field(declaratorName(fd.declarator), fd.initializer && expr(fd.initializer), cppDeclaratorToTsType(fd.declarator, m.specifiers.type), m.modifiers?.includes('static') ? ['static'] : undefined)];
			}
			default:				return tsUnsupported(`class member '${(m as CPP.ClassMember).type}'`);
		}
	}

	function cppClassToTs(c: CPP.ClassSpecifier): TS.Stmt {
		if (!c.name)
			return tsUnsupported('anonymous class/struct');
		if ((c.bases?.length ?? 0) > 1)
			return tsUnsupported('multiple base classes');
		const baseName = c.bases?.[0]?.name;
		const members = c.body ?? [];
		const savedMembers = cppMemberNames;
		cppMemberNames = new Set(members.flatMap(cppMemberNamesOf));
		const body = members.flatMap(m => classMember(m, baseName));
		cppMemberNames = savedMembers;
		return {
			type:		'class_decl',
			name:		c.name,
			superClass:	baseName && Identifier(baseName),
			body,
		} as TS.Stmt;
	}

	function cppEnumToTs(e: CPP.CppEnumSpecifier): TS.Stmt {
		return e.name
			? { type: 'enum_decl', name: e.name, members: (e.members ?? []).map(m => ({ name: m.name, init: m.init && expr(m.init) })) } as TS.Stmt
			: tsUnsupported('anonymous enum');
	}

	function definition(d: CPP.Definition): TS.Stmt[] {
		d = first(d);
		switch (d.type) {
			case 'declaration': {
				const t = d.specifiers.type;
				if ((t.type === 'class' || t.type === 'struct') && !d.initDeclarators)
					return [cppClassToTs(t)];
				if (t.type === 'union')
					return tsUnsupported('union');
				if (t.type === 'enum')
					return [cppEnumToTs(t)];
				return !d.initDeclarators ? [] : [{ type: 'var_decl', kind: 'let', declarations: d.initDeclarators.map(id => cppInitDeclaratorToVar(id, d.specifiers)) } as TS.Stmt];
			}
			case 'typedef': {
				if (d.declarators.length !== 1)
					return tsUnsupported('multi-name `typedef`');
				const decl = d.declarators[0];
				const declarator = 'declarator' in decl ? decl.declarator : decl;
				return [{ type: 'type_alias_decl', name: declaratorName(declarator), value: cppDeclaratorToTsType(declarator, d.specifiers.type) } as TS.Stmt];
			}
			case 'function_def':
				return d.declarator.type !== 'function' ? tsUnsupported('function returning a pointer/array (complex declarator)') : [{
					type:		'function_decl',
					name:		declaratorName(d.declarator.name),
					params:		d.declarator.params.map(cppParamToTs),
					returnType:	cppTypeSpecToTs(d.specifiers.type),
					body:		withCppLocals(cppParamNames(d.declarator.params), () => d.body.body.flatMap(stmt)),
				} as TS.Stmt];
			// [~] a namespace/`extern "C"` block has no TS counterpart -- flattened into its enclosing scope
			case 'namespace':
			case 'linkage':			return d.body.flatMap(definition);
			case 'using_alias':		return [{ type: 'type_alias_decl', name: d.name, value: cppTypeNameToTs(d.target) } as TS.Stmt];
			case 'using_namespace':
			case 'using_decl':		return [];
			case 'template':		return tsUnsupported('template (generics are out of scope)');
			case 'static_assert':	return tsUnsupported('`static_assert`');
			case 'method_def':
			case 'constructor_def':
			case 'destructor_def':
			case 'operator_def':
			case 'static_member_def':	return tsUnsupported(`out-of-class '${d.type}'`);
			default:				return tsUnsupported(`definition '${(d as CPP.Definition).type}'`);
		}
	}
	return cpp.body.flatMap(definition);
}

export async function cpp2ts(source: string, opts?: TSOptions, cppOpts?: CPP.Options): Promise<string> {
	const unit = await CPP.parse(source, cppOpts);
	return new TSOutput(opts).statements(CPP2TS(unit));
}

// cpp -> py composes onto the TS AST rather than duplicating another bespoke cpp <-> py mapping:
// `cppDefinition` already produces real `TS.Stmt` nodes in memory, which the original `stmt` (ts2py's
// own TS -> PY converter, at the top of this file) accepts directly -- no text round-trip needed. Its
// coverage is the INTERSECTION of both stages' `unsupported()` sets, not a new union of its own.
export async function cpp2py(source: string, opts?: PYOptions, cppOpts?: CPP.Options): Promise<string> {
	const unit = await CPP.parse(source, cppOpts);
	return new PYOutput(opts).statements(TS2PY({type: 'module', body: CPP2TS(unit)}));
}

// ===================================================================
//  Shared C++-construction infrastructure for the two "-> C++" directions below.
//  TS and Python are both gradually/dynamically typed, so both feed a small common `SimpleType`
//  through the same CPP declarator/param/decl-spec builders -- only the front-end (annotation -> SimpleType)
//  differs per source language.
// ===================================================================

type CBlock = C.Block<CPP.Declarator, CPP.TypeSpecifierExt, CPP.Expr, CPP.Stmt>;

type SimpleType = { kind: 'ref'; name: string } | { kind: 'array'; element: SimpleType };
const SimpleRef	  = (name: string): SimpleType => ({ kind: 'ref', name });
const SimpleArray = (element: SimpleType): SimpleType => ({ kind: 'array', element });

function simpleTypeSpec(t: SimpleType): CPP.TypeSpecifier {
	return t.kind === 'array'
		? { type: 'generic', name: 'std::vector', args: [{ value: { specifiers: { type: simpleTypeSpec(t.element) } } }] }
		: { type: 'ref', name: t.name };
}
const simpleDeclSpec = (t: SimpleType): CPP.DeclarationSpec => ({ type: simpleTypeSpec(t) });

const cppBlock = (stmts: CPP.Stmt[]): CBlock => ({ type: 'block', body: stmts });

function cppCtorMember(name: string, params: CPP.ParamDecl[], body: CPP.Stmt[], initializerList?: CPP.MemberInitializer[]): CPP.ConstructorMember {
	return { type: 'constructor', name, params, initializerList, body: cppBlock(body) };
}
function cppMethodMember(name: string, params: CPP.ParamDecl[], returnType: SimpleType, body: CPP.Stmt[], isStatic?: boolean): CPP.MethodMember {
	return {
		type:		'method',
		specifiers:	simpleDeclSpec(returnType),
		declarator:	C.FunctionDecl(Identifier(name), params),
		body:		cppBlock(body),
		modifiers:	isStatic ? ['static'] : undefined,
	};
}
function cppFieldMember(name: string, type: SimpleType, init?: CPP.Expr, isStatic?: boolean): CPP.StructMember {
	return CPP.StructMember(simpleDeclSpec(type), [{ declarator: Identifier(name), initializer: init }], isStatic ? ['static'] : undefined);
}
function cppClassDecl(name: string, baseName: string | undefined, body: CPP.ClassMember[]): CPP.Stmt {
	return { type: 'declaration', specifiers: { type: { type: 'struct', name, bases: baseName ? [{ name: baseName }] : undefined, body } } };
}

// ===================================================================
//  PoC: TypeScript AST -> C++ AST -> C++ source.
// ===================================================================

function TS2CPP(ts: Module<TS.Stmt>) {
	const TS_CPPTYPE: Record<string, string> = { number: 'double',
		string:		'std::string',
		boolean:	'bool',
		void:		'void',
		unknown:	'auto',
		any:		'auto',
		object:		'auto',
		null:		'std::nullptr_t'
	};

	let currentClass:	string | undefined;
	let currentBase:	string | undefined;

	function typeToSimple(t: TS.Type | undefined): SimpleType {
		if (!t)
			return SimpleRef('auto');
		if (t.type === 'ref')
			return SimpleRef(TS_CPPTYPE[t.name] ?? t.name);
		if (t.type === 'array')
			return SimpleArray(typeToSimple(t.element));
		// [~] `T | null`/`T | undefined` -- the closest fit is just `T` (no `std::optional` modeled)
		if (t.type === 'union') {
			const nonNull = t.types.find(x => !(x.type === 'ref' && (x.name === 'null' || x.name === 'undefined')));
			return nonNull ? typeToSimple(nonNull) : SimpleRef('auto');
		}
		return SimpleRef('auto');
	}

	function keyName(k: JS.Key): string {
		return typeof k === 'string' ? k : cppUnsupported('computed member name');
	}
	function param(p: JS.Param<TS.Type>): CPP.ParamDecl {
		if (typeof p.key !== 'string')
			return cppUnsupported('destructuring parameter');
		return { type: 'parameter',	specifiers: simpleDeclSpec(typeToSimple(p.typeAnnotation)), declarator: Identifier(p.key), default: p.default && expr(p.default) };
	}

	function templateToCpp(parts: JS.TemplatePart<TS.Expr>[]): CPP.Expr {
		let result: CPP.Expr | undefined;
		for (const p of parts) {
			if (p.str)
				result = result ? Binary('+', result, Literal(p.str)) : Literal(p.str);
			if (p.exp) {
				const e = expr(p.exp);
				result = result ? Binary('+', result, e) : e;
			}
		}
		return result ?? Literal('');
	}

	function expr(e: TS.Expr): CPP.Expr {
		switch (e.type) {
			// [=] identical shapes
			case 'identifier':
			case 'this':		return e;
			case 'literal':
				return	Array.isArray(e.value)	? templateToCpp(e.value as JS.TemplatePart<TS.Expr>[])
					:	e.value === null		? { type: 'null_literal' }
					:	Literal(typeof e.value === 'bigint' ? Number(e.value) : e.value as number | string | boolean);
			case 'conditional':	return Conditional(expr(e.test), expr(e.consequent), expr(e.alternate));
			case 'index':		return Index(expr(e.object), expr(e.index));
			// [~] `this` is a POINTER in C++ -- a member access off it needs `->`, not `.`
			case 'member':		return e.object.type === 'this' ? { type: 'pointer_member', object: expr(e.object), property: e.property } : Member(expr(e.object), e.property);
			// [~] `super.m(...)` has no `super` keyword in C++ -- it's an explicit qualified call, `Base::m(...)`
			case 'call':
				if (e.callee.type === 'member' && e.callee.object.type === 'super')
					return Call({ type: 'qualified', parts: [currentBase ?? cppUnsupported('`super.m(...)` outside a derived class'), e.callee.property] }, e.arguments.map(expr));
				if (e.callee.type === 'super')
					return cppUnsupported('bare `super(...)` (only as the first statement of a constructor)');
				return Call(expr(e.callee), e.arguments.map(expr));
			case 'spread':		return Spread(expr(e.operand));

			case 'unary': {
				const op = e.operator;
				return	op === '+' || op === '-' || op === '~' || op === '!' || op === '++' || op === '--'	? Unary(op, expr(e.operand))
					:	cppUnsupported(`unary '${op}'`);
			}
			case 'unary_post':	return UnaryPost(e.operator as '++' | '--', expr(e.operand));

			// [~] `===`/`!==` collapse onto C++'s single `==`/`!=`; `>>>`, `??`, `in`, `instanceof` have no equivalent here
			case 'binary': {
				const op = e.operator;
				return	op === '===' || op === '!==' ? Binary(op === '===' ? '==' : '!=', expr(e.left), expr(e.right))
					:	op === '>>>' || op === '??' || op === 'in' || op === 'instanceof'	? cppUnsupported(`'${op}' operator`)
					:	Binary(op as C.binaryOps, expr(e.left), expr(e.right));
			}
			// [=] both languages now model assignment as its own node; only the operator set narrows
			case 'assign': {
				const op = e.operator;
				return	op === '**' || op === '>>>' || op === '??'
					? cppUnsupported(`compound assignment '${op}='`)
					: Assign<CPP.Expr, C.assignableOps>(expr(e.target), expr(e.value), op);
			}

			case 'new':			return e.callee.type === 'identifier'
				?	{ type: 'new', typeName: { type: 'ref', name: e.callee.name }, arguments: e.arguments.map(expr) }
				:	cppUnsupported('`new` with a non-identifier callee');
			case 'sequence':	return e.expressions.map(expr).reduce((acc, x) => Binary(',', acc, x));

			// [=] TS-only wrappers just unwrap
			case 'as':
			case 'satisfies':
			case 'instantiation':	return expr(e.expression);

			default:				return cppUnsupported(`expression '${e.type}'`);
		}
	}

	// [~] an array literal has no general C++ *expression* form (no bare braced-init outside a declaration)
	// -- so it's only accepted as a variable's direct initializer, via this path instead of `tsExprToCpp`.
	function initializerToCpp(e: TS.Expr): C.Initializer<CPP.Expr> {
		return e.type === 'array'
			? { type: 'initializer_list', elements: e.elements.map(x => x ? initializerToCpp(x) : cppUnsupported('sparse array element')) }
			: expr(e);
	}

	const bindName	= (b: JS.BindingTarget): string 	=> typeof b === 'string' ? b : cppUnsupported('destructuring');

	function varToCpp(v: JS.Var<TS.Type>): CPP.Stmt {
		const name = bindName(v.name);
		const type = v.typeAnnotation ? typeToSimple(v.typeAnnotation) : v.init ? SimpleRef('auto') : cppUnsupported('variable with neither a type annotation nor an initializer');
		return { type: 'declaration', specifiers: simpleDeclSpec(type), initDeclarators: [v.init ? { declarator: Identifier(name), initializer: initializerToCpp(v.init) } : Identifier(name)] };
	}

	const block = (b: TS.Stmt | readonly TS.Stmt[] | undefined) => cppBlock(bodyOf(b).flatMap(stmt));


	// [~] `throw new Foo(...)` throws a heap POINTER in JS/TS terms, but C++ exceptions are thrown BY VALUE
	// -- the `new` is dropped so the object is constructed directly.
	function throwArg(e: TS.Expr): CPP.Expr {
		return e.type === 'new' && e.callee.type === 'identifier'
			? Call(Identifier(e.callee.name), e.arguments.map(expr))
			: expr(e);
	}

	function stmt(s: TS.Stmt): CPP.Stmt[] {
		switch (s.type) {
			case 'expression':	return [ExprStmt(expr(s.expression))];
			case 'empty':		return [{ type: 'empty' }];
			case 'return':		return [Return(s.argument && expr(s.argument))];
			case 'break':		return s.label ? cppUnsupported('labeled `break`') : [{ type: 'break' }];
			case 'continue':	return s.label ? cppUnsupported('labeled `continue`') : [{ type: 'continue' }];
			case 'if':			return [If(expr(s.test), block(s.consequent), s.alternate && block(s.alternate))];
			case 'while':		return [While(expr(s.test), block(s.body))];
			case 'do_while':	return [DoWhile(block(s.body), expr(s.test))];

			case 'for':
				if (s.kind === 'normal') {
					const init = !s.init ? undefined : isJSVarDecl(s.init) ? s.init.declarations.map(varToCpp)[0] as unknown as C.Declaration : expr(s.init);
					return [{ type: 'for', init, test: s.test && expr(s.test), update: s.update && expr(s.update), body: block(s.body) }];
				}
				if (!isJSVarDecl(s.init) || s.init.declarations.length !== 1)
					return cppUnsupported('`for`/`for-of` over an existing (non-declared) binding');
				return [{ type: 'range_for', specifiers: simpleDeclSpec(typeToSimple(s.init.declarations[0].typeAnnotation)), declarator: Identifier(bindName(s.init.declarations[0].name)), range: expr(s.right), body: block(s.body) }];

			case 'switch': {
				const body: CPP.Stmt[] = [];
				for (const c of s.cases) {
					const consequent = c.consequent.flatMap(stmt);
					body.push(
						c.test ? { type: 'case', test: expr(c.test), body: consequent[0] ?? { type: 'empty' } } : { type: 'default', body: consequent[0] ?? { type: 'empty' } },
						...consequent.slice(1)
					);
				}
				return [{ type: 'switch', discriminant: expr(s.discriminant), body: cppBlock(body) }];
			}
			case 'try':			{
				// [~] C++ has no `finally` -- the finalizer's statements are duplicated onto every exit path (the
				// try body and each handler), which misses the one case real `finally` covers: an uncaught exception.
				const finalizer = s.finalizer ? s.finalizer.flatMap(stmt) : [];
				return [{
					type:		'try',
					body:		cppBlock([...bodyOf(s.body).flatMap(stmt), ...finalizer]),
					handlers:	s.handlers.map(h => ({
						type:	{ specifiers: { type: { type: 'ref', name: 'std::exception' } } },
						byRef:	true,
						param:	h.param ? bindName(h.param) : 'e',
						body:	cppBlock([...bodyOf(h.body).flatMap(stmt), ...finalizer]),
					})),
				}];
			}
			case 'throw':		return [{ type: 'throw', argument: throwArg(s.argument) }];
			case 'labeled':		return [{ type: 'labeled', label: s.label, body: block(s.body) }];
			case 'var_decl':	return s.declarations.map(varToCpp);
			// [~] a local class is real C++; a local FUNCTION declaration is not (no nested named functions)
			case 'class_decl':	return [classToCpp(s)];
			case 'function_decl':	return cppUnsupported('nested function declaration (C++ has no local named functions)');

			case 'block':
			case 'with':
			case 'debugger':
			case 'import':
			case 'export':
			case 'export_decl':
			default:			return cppUnsupported(`statement '${(s as TS.Stmt).type}'`);
		}
	}

	function classMember(m: TS.ClassMember): CPP.ClassMember[] {
		if (m.type === 'static_block')
			return cppUnsupported('static initialization block');
		if (m.type === 'index_signature')
			return cppUnsupported('index signature');
		const isStatic = m.modifiers?.includes('static');
		if (m.type === 'field')
			return [cppFieldMember(keyName(m.key), typeToSimple(m.typeAnnotation), m.value && expr(m.value), isStatic)];
		// [~] getters/setters have no C++ syntax equivalent modeled here -- emitted as plain named methods
		const name = keyName(m.key);
		if (name !== 'constructor')
			return [cppMethodMember(name, m.params.map(param), typeToSimple(m.returnType), block(m.body).body, isStatic)];

		// [~] a leading bare `super(...)` call is TS's ONLY spelling of what C++ requires in the member-initializer
		// list -- peeled off here (before the rest of the body goes through the ordinary statement path, where a
		// `super(...)` call would otherwise be rejected as an unconvertible expression).
		const stmts = m.body ?? [];
		const first = stmts[0];
		const isSuperCall = !!first && first.type === 'expression' && first.expression.type === 'call' && first.expression.callee.type === 'super';
		return [cppCtorMember(
			currentClass ?? cppUnsupported('constructor outside a class'),
			m.params.map(param),
			block(isSuperCall ? stmts.slice(1) : stmts).body,
			isSuperCall
				? [{ name: currentBase ?? cppUnsupported('`super(...)` outside a derived class'), arguments: (first.expression as TS.Expr & { type: 'call' }).arguments.map(expr) }]
				: undefined
		)];
	}

	function classToCpp(c: TS.Stmt & { type: 'class_decl' }) {
		if (!c.name)
			return cppUnsupported('anonymous class');
		if (c.superClass && c.superClass.type !== 'identifier')
			return cppUnsupported('base class expression (only a plain name converts)');
		const savedClass = currentClass, savedBase = currentBase;
		currentClass = c.name;
		currentBase = c.superClass && (c.superClass as TS.Expr & { type: 'identifier' }).name;
		const decl = cppClassDecl(c.name, currentBase, c.body.flatMap(classMember));
		currentClass = savedClass;
		currentBase = savedBase;
		return decl;
	}

	// [~] a named function or class DECLARATION is real top-level C++; a bare executable statement isn't
	// (there's no "script" scope to run it in) -- so the top level gets its own dispatch rather than reusing
	// `tsStmtToCpp` (which, correctly, refuses a nested `function_decl`).
	function topLevel(s: TS.Stmt): CPP.Definition[] {
		if (s.type === 'function_decl')
			return [{
				type:		'function_def',
				specifiers:	simpleDeclSpec(typeToSimple(s.returnType)),
				declarator:	C.FunctionDecl(Identifier(s.name), s.params.map(param)),
				body:		block(s.body),
			}];
		if (s.type === 'class_decl')
			return [classToCpp(s) as unknown as CPP.Definition];
		if (s.type === 'var_decl')
			return s.declarations.map(v => varToCpp(v) as unknown as CPP.Definition);
		return cppUnsupported(`top-level '${s.type}' (only functions, classes, and variables convert at file scope)`);
	}
	return ts.body.flatMap(topLevel);
}
export function ts2cpp(source: string, opts?: CPPOptions): string {
	return new CPPOutput(opts).module({ type: 'module', body: TS2CPP(TS.parse(source)) });
}

// ===================================================================
//  PoC: Python AST -> C++ AST -> C++ source.
//  Unlike ts2cpp, C++ genuinely supports multiple typed `catch` clauses, so `try`/`except` maps
//  directly instead of needing the `instanceof` if/else-if desugaring `pyTry` (py2ts) uses.
// ===================================================================
function PY2CPP(py: Module<PY.Stmt>) {

	const PY_CPPTYPE: Record<string, string> = {
		float:	'double',
		int:	'int',
		str:	'std::string',
		bool:	'bool',
		object:	'auto',
		Any:	'auto'
	};

	let currentClass:	string | undefined;
	let currentBase:	string | undefined;
	let self: string | undefined;
	const scope = new PYScopes;

	function typeToSimple(t: PY.Expr | undefined): SimpleType {
		if (!t)
			return SimpleRef('auto');
		if (t.type === 'literal' && t.value === null)
			return SimpleRef('void');
		if (t.type === 'identifier')
			return SimpleRef(PY_CPPTYPE[t.name] ?? t.name);
		if (t.type === 'index') {
			const base = t.object.type === 'identifier' ? t.object.name : undefined;
			const args = t.index.type === 'tuple' ? t.index.elements : [t.index];
			if (base === 'List' || base === 'list')
				return SimpleArray(typeToSimple(args[0]));
			if (base === 'Optional')
				return typeToSimple(args[0]);
		}
		if (t.type === 'binary' && t.operator === '|')
			return typeToSimple(t.left);
		return SimpleRef('auto');
	}

	function param(p: PY.Param): CPP.ParamDecl {
		if (p.kind && p.kind !== 'normal')
			return cppUnsupported("'*'/'**'/'/' parameter");
		return { type: 'parameter', specifiers: simpleDeclSpec(typeToSimple(p.annotation)), declarator: Identifier(p.name ?? cppUnsupported('bare parameter separator')), default: p.default && expr(p.default) };
	}

	function args(args: PY.Arg[]): CPP.Expr[] {
		return args.map(a => a.kind === 'star' ? Spread(expr(a.value)) : a.kind === 'pos' ? expr(a.value) : cppUnsupported(`'${a.kind}' argument`));
	}

	function expr(e: PY.Expr): CPP.Expr {
		switch (e.type) {
			// [~] a bare `self` reference converts to `this` (a POINTER in C++, hence `pointer_member` for `.` access below)
			case 'identifier':	return e.name === self ? { type: 'this' } : e;
			case 'literal':
				if (Array.isArray(e.value)) {
					let result: CPP.Expr | undefined;
					for (const p of e.value) {
						if (p.text)
							result = result ? Binary('+', result, Literal(p.text)) : Literal(p.text);
						if (p.field) {
							const e = expr(p.field.expr);
							result = result ? Binary('+', result, e) : e;
						}
					}
					return result ?? Literal('');
				}
				return e.value === null ? { type: 'null_literal' } : Literal(typeof e.value === 'bigint' ? Number(e.value) : e.value as number | string | boolean);
			case 'imaginary':	return cppUnsupported('imaginary literal');
			case 'ellipsis':	return cppUnsupported('`...` literal');
			case 'conditional':	return Conditional(expr(e.test), expr(e.consequent), expr(e.alternate));
			case 'spread':		return Spread(expr(e.operand));
			case 'namedexpr':	return Assign<CPP.Expr, C.assignableOps>(Identifier(e.target), expr(e.value));

			case 'unary': {
				const op = e.operator;
				return	op === '+' || op === '-' || op === '~' || op === '!'	? Unary(op, expr(e.operand))
					:	cppUnsupported(`unary '${op}'`);
			}
			// [~] Python has no `//`/`@`; a floor-div/matrix-mul call would need a real numeric library, so left unsupported
			case 'binary': {
				const op = e.operator;
				return	op === '//' || op === '@'	? cppUnsupported(`'${op}' operator`)
					:	Binary(op as C.binaryOps, expr(e.left), expr(e.right));
			}
			// [~] a chained comparison (`a < b < c`) has no single-expression C++ form without a temporary this level can't introduce
			case 'compare': {
				if (e.ops.length !== 1)
					return cppUnsupported('chained comparison (`a < b < c`)');
				const op = e.ops[0] === '<>' ? '!=' : e.ops[0];
				return	op === '<' || op === '>' || op === '<=' || op === '>=' || op === '==' || op === '!='
					?	Binary(op, expr(e.left), expr(e.comparators[0]))
					:	cppUnsupported(`comparison '${e.ops[0]}'`);
			}

			case 'index':
				if (e.index.type === 'slice' || e.index.type === 'tuple')
					return cppUnsupported('slice subscript');
				return Index(expr(e.object), expr(e.index));
			case 'slice':		return cppUnsupported('slice expression (outside a subscript)');

			case 'member':
				return e.object.type === 'identifier' && e.object.name === self
					?	{ type: 'pointer_member', object: expr(e.object), property: e.property }
					:	Member(expr(e.object), e.property);

			// [~] `super().__init__(...)` only converts as a constructor's leading statement (see `pyClassMemberToCpp`);
			// `super().m(...)` becomes an explicit qualified call, `Base::m(...)` (C++ has no `super` keyword)
			case 'call': {
				if (e.callee.type === 'member' && isPYSuperCall(e.callee.object))
					return e.callee.property === '__init__'
						?	cppUnsupported("`super().__init__(...)` only converts as a constructor's first statement")
						:	{ type: 'call', callee: { type: 'qualified', parts: [currentBase ?? cppUnsupported('`super()` outside a derived class'), e.callee.property] }, arguments: args(e.arguments) };
				if (isPYSuperCall(e))
					return cppUnsupported('bare `super()`');
				return { type: 'call', callee: expr(e.callee), arguments: args(e.arguments) };
			}

			case 'lambda':
				return {
					type:		'lambda',
					captures:	[{ defaultCapture: '&' }],
					params:		e.params.map(param),
					body:		cppBlock([{ type: 'return', argument: expr(e.body) }]),
				};

			case 'tuple':
			case 'list':
			case 'set':
			case 'dict':			return cppUnsupported(`'${e.type}' literal used as an expression (only as a variable's direct initializer)`);
			case 'genexp':
			case 'listcomp':
			case 'setcomp':
			case 'dictcomp':		return cppUnsupported(`comprehension ('${e.type}')`);
			case 'await':
			case 'yield':			return cppUnsupported(`'${e.type}' (no direct C++ coroutine equivalent modeled)`);

			default:				return cppUnsupported(`expression '${(e as PY.Expr).type}'`);
		}
	}

	// [~] mirrors `tsInitializerToCpp` -- a list/tuple literal has no general C++ *expression* form, only a
	// variable's direct (braced) initializer.
	function initializerToCpp(e: PY.Expr): C.Initializer<CPP.Expr> {
		return e.type === 'list' || e.type === 'tuple'
			? { type: 'initializer_list', elements: e.elements.map(initializerToCpp) }
			: expr(e);
	}

	function varDeclToCpp(name: string, type: SimpleType, init?: C.Initializer<CPP.Expr>): CPP.Stmt {
		return { type: 'declaration', specifiers: simpleDeclSpec(type), initDeclarators: [init !== undefined ? { declarator: Identifier(name), initializer: init } : Identifier(name)] };
	}

	// [~] N Python `except` clauses map DIRECTLY onto N C++ `catch` clauses (unlike py2ts's single-catch
	// TS/JS target) -- no `instanceof` desugaring needed here.
	function tryToCpp(s: PY.TryStmt): CPP.Stmt {
		if (s.orelse.length)
			cppUnsupported('`try ... else`');
		const finalizer = s.finalizer.length ? s.finalizer.flatMap(stmt) : [];
		return { type: 'try', body: cppBlock([...s.body.flatMap(stmt), ...finalizer]),
			handlers: s.handlers.map(h => ({
			type:	{ specifiers: { type: { type: 'ref', name: h.type ? (h.type.type === 'identifier' ? h.type.name : cppUnsupported('non-simple exception type')) : 'std::exception' } } },
			byRef:	true,
			param:	h.param ?? 'e',
			body:	cppBlock([...h.body.flatMap(stmt), ...finalizer]),
		}))};
	}

	function stmt(s: PY.Stmt): CPP.Stmt[] {
		switch (s.type) {
			case 'expression':	return [ExprStmt(expr(s.expression))];
			case 'return':		return [Return(s.argument && expr(s.argument))];
			case 'pass':		return [];
			case 'break':		return [{ type: 'break' }];
			case 'continue':	return [{ type: 'continue' }];
			case 'throw':		return [{ type: 'throw', argument: s.argument ? expr(s.argument) : cppUnsupported('bare `raise` (re-raise)') }];

			// [~] first assignment of a name declares it (`auto`); later ones are a plain assignment (see `pyCppDeclare`) --
			// same known gap as py2ts's `pyDeclare`: doesn't hoist across nested blocks.
			case 'assign': {
				if (s.targets.length !== 1)
					return cppUnsupported('chained assignment (`a = b = c`)');
				const target = s.targets[0];
				return target.type === 'identifier' && scope.declare(target.name)
					?	[varDeclToCpp(target.name, SimpleRef('auto'), initializerToCpp(s.value))]
					:	[ExprStmt(Assign<CPP.Expr, C.assignableOps>(expr(target), expr(s.value)))];
			}
			case 'augassign': {
				const op = s.op.slice(0, -1);
				return ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'].includes(op)
					?	[ExprStmt(Assign<CPP.Expr, C.assignableOps>(expr(s.target), expr(s.value), op as C.assignableOps))]
					:	cppUnsupported(`compound assignment '${s.op}'`);
			}
			case 'annassign': {
				if (s.target.type !== 'identifier')
					return cppUnsupported('annotated assignment to a non-identifier');
				scope.declare(s.target.name);
				return [varDeclToCpp(s.target.name, typeToSimple(s.annotation), s.value && initializerToCpp(s.value))];
			}

			case 'global':
			case 'nonlocal':	return cppUnsupported(`'${s.type}' declaration`);
			case 'del':			return cppUnsupported('`del` (C++ objects have no dynamic attribute/member deletion)');
			// [~] Python's `assert` -> `if (!test) throw std::runtime_error(msg);`
			case 'assert':
				return [If(Unary('!', expr(s.test)), cppBlock([{ type: 'throw', argument: { type: 'call', callee: Identifier('std::runtime_error'), arguments: [s.msg ? expr(s.msg) : Literal('assertion failed')] } }]))];
			case 'import':
			case 'importfrom':	return cppUnsupported(`'${s.type}' (module systems differ too much to translate)`);

			case 'if':			return [If(expr(s.test), cppBlock(s.consequent.flatMap(stmt)), s.alternate?.length ? cppBlock(s.alternate.flatMap(stmt)) : undefined)];
			case 'while':		return s.orelse?.length ? cppUnsupported('`while ... else`') : [While(expr(s.test), cppBlock(s.body.flatMap(stmt)))];
			// [~] Python's `for` is always a for-of; C++'s range-for is the direct match
			case 'for':
				if (s.orelse.length)
					return cppUnsupported('`for ... else`');
				if (s.target.type !== 'identifier')
					return cppUnsupported('destructuring `for` target');
				return [{ type: 'range_for', specifiers: simpleDeclSpec(SimpleRef('auto')), declarator: Identifier(s.target.name), range: expr(s.iter), body: cppBlock(s.body.flatMap(stmt)) }];
			case 'with':		return cppUnsupported('`with` statement (no direct RAII equivalent modeled)');
			case 'try':			return [tryToCpp(s)];

			case 'classdef':	return [classToCpp(s)];
			case 'funcdef':		return cppUnsupported('nested function declaration (C++ has no local named functions)');
			default:			return cppUnsupported(`statement '${(s as PY.Stmt).type}'`);
		}
	}

	// A leading `super().__init__(...)` is Python's only spelling of a C++ member-initializer-list entry --
	// same peeling `tsClassMemberToCpp` does for TS's leading `super(...)` call.
	function superInitArgs(s: PY.Stmt): PY.Expr[] | undefined {
		if (s.type !== 'expression' || s.expression.type !== 'call')
			return undefined;
		const call = s.expression;
		if (call.callee.type !== 'member' || call.callee.property !== '__init__' || !isPYSuperCall(call.callee.object))
			return undefined;
		return call.arguments.map(a => a.kind === 'pos' ? a.value : cppUnsupported("non-positional argument to 'super().__init__(...)'"));
	}

	function classMember(m: PY.Stmt): CPP.ClassMember[] {
		switch (m.type) {
			case 'pass':	return [];
			case 'funcdef': {
				const isStatic = m.decorators.some(d => d.type === 'identifier' && d.name === 'staticmethod');
				if (m.decorators.some(d => d.type === 'identifier' && (d.name === 'classmethod' || d.name === 'property')) || m.decorators.some(d => d.type === 'member' && d.property === 'setter'))
					cppUnsupported('@classmethod/@property/@x.setter (no C++ syntax equivalent modeled)');
				if (m.decorators.length > (isStatic ? 1 : 0))
					cppUnsupported('decorator');
				const pyParams	= isStatic ? m.params : m.params.slice(1);
				const params	= pyParams.map(param);
				scope.push(pyParams.map(p => p.name).filter((n): n is string => !!n));
				const savedSelf = self;
				self = isStatic ? undefined : m.params[0]?.name;

				if (m.name === '__init__') {
					const superArgs = m.body[0] && superInitArgs(m.body[0]);
					const initializerList = superArgs ? [{ name: currentBase ?? cppUnsupported("'super().__init__(...)' outside a derived class"), arguments: superArgs.map(expr) }] : undefined;
					const body = (superArgs ? m.body.slice(1) : m.body).flatMap(stmt);
					self = savedSelf;
					scope.pop();
					return [cppCtorMember(currentClass ?? cppUnsupported('constructor outside a class'), params, body, initializerList)];
				}
				const body = m.body.flatMap(stmt);
				self = savedSelf;
				scope.pop();
				return [cppMethodMember(m.name, params, typeToSimple(m.returns), body, isStatic)];
			}
			case 'assign':
				return m.targets.length === 1 && m.targets[0].type === 'identifier'
					? [cppFieldMember(m.targets[0].name, SimpleRef('auto'), expr(m.value))]
					: cppUnsupported('complex class-body assignment');
			case 'annassign':
				return m.target.type === 'identifier'
					? [cppFieldMember(m.target.name, typeToSimple(m.annotation), m.value && expr(m.value))]
					: cppUnsupported('complex annotated field');
			default:
				return cppUnsupported(`class member '${m.type}'`);
		}
	}

	// Unlike TS/JS, a C++ `struct` has no dynamic fields -- unlike a class-level `name: int` (which already
	// becomes a `struct_member` via `pyClassMemberToCpp`'s `annassign` case), `self.name = ...` assigned only
	// inside `__init__` declares nothing there, so those need synthesizing here or the struct won't compile.
	function inferFieldType(value: PY.Expr, params: PY.Param[]): SimpleType {
		if (value.type === 'identifier') {
			const p = params.find(p => p.name === value.name);
			if (p?.annotation)
				return typeToSimple(p.annotation);
		}
		if (value.type === 'literal') {
			if (typeof value.value === 'boolean')
				return SimpleRef('bool');
			if (typeof value.value === 'string')
				return SimpleRef('std::string');
			if (typeof value.value === 'number' || typeof value.value === 'bigint')
				return SimpleRef(Number.isInteger(value.value) ? 'int' : 'double');
		}
		return cppUnsupported(`cannot infer a C++ type for a field initialized from a '${value.type}' -- add a class-level annotation (e.g. \`name: int\`) instead`);
	}
	function selfFieldsFromInit(init: PY.Stmt & { type: 'funcdef' }, skip: ReadonlySet<string>): CPP.StructMember[] {
		const selfName = init.params[0]?.name;
		const seen = new Set<string>();
		const fields: CPP.StructMember[] = [];
		for (const s of init.body) {
			if (s.type !== 'assign' || s.targets.length !== 1)
				continue;
			const t = s.targets[0];
			if (t.type === 'member' && t.object.type === 'identifier' && t.object.name === selfName && !seen.has(t.property) && !skip.has(t.property)) {
				seen.add(t.property);
				fields.push(cppFieldMember(t.property, inferFieldType(s.value, init.params)));
			}
		}
		return fields;
	}

	function classToCpp(s: PY.Stmt & { type: 'classdef' }): CPP.Stmt {
		if (s.bases.length > 1)
			return cppUnsupported('multiple base classes');
		const baseArg = s.bases[0];
		if (baseArg && baseArg.value.type !== 'identifier')
			return cppUnsupported('base class expression (only a plain name converts)');
		const savedClass = currentClass, savedBase = currentBase;
		currentClass = s.name;
		currentBase = baseArg ? (baseArg.value as PY.Expr & { type: 'identifier' }).name : undefined;
		scope.push([]);
		const explicitFields = new Set(s.body.flatMap(m =>
			m.type === 'assign' && m.targets[0]?.type === 'identifier' ? [m.targets[0].name]
			: m.type === 'annassign' && m.target.type === 'identifier' ? [m.target.name]
			: []));
		const init = s.body.find((m): m is PY.Stmt & { type: 'funcdef' } => m.type === 'funcdef' && m.name === '__init__');
		const inferredFields = init ? selfFieldsFromInit(init, explicitFields) : [];
		const body = [...inferredFields, ...s.body.flatMap(classMember)];
		scope.pop();
		const decl = cppClassDecl(s.name, currentBase, body);
		currentClass = savedClass;
		currentBase = savedBase;
		return decl;
	}

	// [~] same split as ts2cpp's `tsTopLevel` -- a top-level `def`/`class`/assignment is real C++ file
	// scope; a bare executable statement isn't.
	function topLevel(s: PY.Stmt): CPP.Definition[] {
		if (s.type === 'funcdef') {
			if (s.decorators.length)
				return cppUnsupported('function decorator');
			scope.push(s.params.map(p => p.name).filter((n): n is string => !!n));
			const body = cppBlock(s.body.flatMap(stmt));
			scope.pop();
			return [{
				type:		'function_def',
				specifiers:	simpleDeclSpec(typeToSimple(s.returns)),
				declarator:	C.FunctionDecl(Identifier(s.name), s.params.map(param)),
				body,
			} as unknown as CPP.Definition];
		}
		if (s.type === 'classdef')
			return [classToCpp(s) as unknown as CPP.Definition];
		if (s.type === 'assign' || s.type === 'annassign')
			return stmt(s) as unknown as CPP.Definition[];
		return cppUnsupported(`top-level '${s.type}' (only functions, classes, and variables convert at file scope)`);
	}
	return py.body.flatMap(topLevel);
}

export function py2cpp(source: string, opts?: CPPOptions): string {
	return new CPPOutput(opts).module({ type: 'module', body: PY2CPP(PY.parse(source)) });
}
