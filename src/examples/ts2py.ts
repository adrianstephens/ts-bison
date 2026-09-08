// PoC: TypeScript AST -> Python AST -> Python source.
// Marked [=] where the converged shapes let a node pass through unchanged or with only a retag,
// and [~] where a real language difference needed actual work.
import * as TS from './TS/ts-parser';
import * as JS from './TS/js-parser';
import * as PY from './PY/py-parser';
import * as C from './CPP/c-parser';
import * as CPP from './CPP/cpp-parser';
import { Output, Options } from './PY/tocode';
import { Output as TSOutput, Options as TSOptions } from './TS/tocode';
import { Output as CPPOutput, Options as CPPOptions } from './CPP/tocode';
import { isExpr as isCppExprNode, isPackParameter as isCppPackParameter } from './CPP/walker';
import { bodyOf, Identifier, Literal, Unary, UnaryPost, Binary, Call, Member, Index, Conditional, Spread, Sequence, Assign, Await, Yield, ExprStmt, Return, Throw, If, While, DoWhile } from './common';

type PE = PY.Expr;
type PS = PY.Stmt;

const unsupported = (what: string): never => { throw new Error(`ts2py: ${what} has no Python equivalent`); };

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
// [~] operator spelling
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
	'&&':	'and',
	'||':	'or',
};

const UNARY: Partial<Record<JS.unaryOps, PY.unaryOps>> = {
	'-':	'-',
	'+':	'+',
	'~':	'~',
	'!':	'not'
};


const pos		= (value: PE): PY.Arg => ({ kind: 'pos', value });
const compare	= (op: PY.compareOps, left: PE, right: PE): PY.Compare => ({ type: 'compare', left, ops: [op], comparators: [right] });
const call		= (fn: string, ...args: PE[]): PE => Call<PE, PY.Arg>(Identifier(fn), args.map(pos));

export function expr(e: TS.Expr): PE {
	switch (e.type) {
		// [=] identical shapes -- these are the payoff
		case 'identifier':	return e.name === 'undefined' ? Literal(null) : e;
		case 'literal':		return	Array.isArray(e.value)			? fstring(e.value)
								:	e.value instanceof RegExp		? unsupported('regex literal')
								:	Literal(typeof e.value === 'bigint' ? Number(e.value) : e.value);
		case 'member':		return Member(expr(e.object), e.property);
		case 'index':		return Index(expr(e.object), expr(e.index));
		case 'conditional':	return Conditional(expr(e.test), expr(e.consequent), expr(e.alternate));
		case 'spread':		return Spread(expr(e.operand));
		// [~] `yield* x` and `yield from x` are the same idea spelled with a flag vs a field
		case 'yield':		return e.delegate
			?	{ type: 'yield', from: e.operand ? expr(e.operand) : unsupported('`yield*` with no operand') }
			:	Yield(e.operand && expr(e.operand));

		// [=] retag only
		case 'array':		return Sequence('list', e.elements.map(x => x ? expr(x) : Literal(null)));

		// [~] Arg wrapper: Python call arguments carry a kind (pos/kw/star/dstar)
		case 'call': {
			const args = e.arguments.map(a => a.type === 'spread' ? { kind: 'star' as const, value: expr(a.operand) } : pos(expr(a)));
			// a bare `super(...)` is the base constructor; `super.m(...)` a base method -- both take `self`
			return	e.callee.type === 'super'											? Call<PE, PY.Arg>(Member(base(), '__init__'), [pos(Identifier('self')), ...args])
				:	e.callee.type === 'member' && e.callee.object.type === 'super'		? Call<PE, PY.Arg>(Member(base(), e.callee.property), [pos(Identifier('self')), ...args])
				:	Call<PE, PY.Arg>(expr(e.callee), args);
		}
		case 'new':			return Call<PE, PY.Arg>(expr(e.callee), e.arguments.map(a => pos(expr(a))));

		case 'await':		return Await(expr(e.operand));
		case 'unary': {
			const op = UNARY[e.operator];
			return	e.operator === 'typeof'	? call('type', expr(e.operand))
				:	op						? Unary(op, expr(e.operand))
				:	unsupported(`unary '${e.operator}'`);
		}

		case 'binary': {
			const cmp = COMPARE[e.operator], bin = BINARY[e.operator];
			return	cmp							? compare(cmp, expr(e.left), expr(e.right))
				:	bin							? Binary(bin, expr(e.left), expr(e.right))
				:	e.operator === '??'			? Conditional(compare('is not', expr(e.left), Literal(null)), expr(e.left), expr(e.right))
				:	e.operator === 'instanceof'	? call('isinstance', expr(e.left), expr(e.right))
				:	unsupported(`binary '${e.operator}'`);
		}

		// [~] object literal -> dict
		case 'object':		return {
			type:	'dict',
			keys:	e.properties.map(p => p.type === 'field' ? keyExpr(p.key) : unsupported('method in an object literal')),
			values:	e.properties.map(p => p.type === 'field' && p.value ? expr(p.value) : Literal(null)),
		};

		// [~] only the expression-bodied form maps; a statement body needs a named def
		case 'arrow':		return Array.isArray(e.body)
			?	unsupported('arrow with a statement body (in expression position)')
			:	{ type: 'lambda', params: e.params.map(param), body: expr(e.body) };

		case 'this':		return Identifier('self');
		// [~] `super.m()` -> `Base.m(self)`; needs the enclosing class, so it's threaded through
		case 'super':		return base();
		case 'sequence':	return unsupported('comma expression');
		// [~] Python has no general assignment-expression (`:=` is far narrower) -- statements only
		case 'assign':		return unsupported('assignment used as an expression');
		// [=] TS-only wrappers just unwrap
		case 'as':
		case 'satisfies':
		case 'instantiation':	return expr(e.expression);
		default:				return unsupported(`expression '${e.type}'`);
	}
}

const base		= () => Identifier(superName ?? unsupported('`super` outside a derived class'));
// [~] template literal -> f-string
const fstring	= (parts: JS.TemplatePart<TS.Expr>[]): PY.FStringLit =>
	({ type: 'fstring', parts: parts.map(p => ({ text: p.str, field: p.exp && { expr: expr(p.exp) } })) });

const keyExpr	= (k: JS.Key): PE					=> typeof k === 'string' ? Literal(k) : expr(k.computed);
const keyName	= (k: JS.Key): string				=> typeof k !== 'string' ? unsupported('computed member name') : k === 'constructor' ? '__init__' : k;
const bindName	= (b: JS.BindingTarget): string 	=> typeof b === 'string' ? b : unsupported('destructuring');
const param		= (p: JS.Param<TS.Type>): PY.Param	=> ({ name: bindName(p.key), default: p.default && expr(p.default) });

// [~] JS assignment is an EXPRESSION, Python's is a statement -- that difference is real and stays.
// What the `assign` node removed is the operator archaeology: the base operator (`+` for `+=`) is
// stored, so this reuses the ordinary BINARY table instead of a second compound-operator one.
function exprStmt(e: TS.Expr): PS {
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
	return op && op !== 'and' && op !== 'or'
		? { type: 'augassign', target: expr(e.target), op: op + '=', value: expr(e.value) }
		: unsupported(`compound assignment '${e.operator}='`);
}

// [=] bodyOf is what makes this one line instead of a block/single-statement branch
const body		= (b: TS.Stmt | readonly TS.Stmt[] | undefined): PS[] => nonEmpty(bodyOf(b).flatMap(stmt));
// Python has no empty suite -- `pass` is the placeholder wherever a body would otherwise be blank.
const nonEmpty	= (body: PS[]): PS[] => body.length ? body : [{ type: 'pass' }];
const orelse	= (b: TS.Stmt | readonly TS.Stmt[] | undefined): PS[] => b === undefined ? [] : body(b);

const isVarDecl	= (x: JS.ForInit<TS.Type>): x is JS.VarDecl<TS.Type> => x.type === 'var_decl';
const forTarget	= (init: JS.ForInit<TS.Type>): PE => isVarDecl(init) ? Identifier(bindName(init.declarations[0].name)) : expr(init);

export function stmt(s: TS.Stmt): PS[] {
	switch (s.type) {
		case 'block':		return bodyOf(s).flatMap(stmt);		// [=] splice
		case 'empty':		return [{ type: 'pass' }];
		case 'expression':	return [exprStmt(s.expression)];
		case 'return':		return [Return(s.argument && expr(s.argument))];	// [=]
		case 'throw':		return [Throw(expr(s.argument))];				// [=]
		case 'break':		return [{ type: 'break' }];
		case 'continue':	return [{ type: 'continue' }];

		// [=] same field names now; only the body arity differs, and bodyOf absorbs that
		case 'if':			return [{ type: 'if', test: expr(s.test), consequent: body(s.consequent), alternate: orelse(s.alternate) }];
		case 'while':		return [{ type: 'while', test: expr(s.test), body: body(s.body), orelse: [] }];

		// [~] no C-style for in Python: init; while test: body; update
		case 'for':			return	s.kind === 'of' || s.kind === 'in'	?	[{
				type:		'for',
				target:		forTarget(s.init),
				iter:		expr(s.right),
				body:		body(s.body),
				orelse:		[],
				is_async:	false }
			] :	s.kind === 'normal' 	?	[
				...(s.init ? isVarDecl(s.init) ? stmt(s.init) : [exprStmt(s.init)] : []),
				{
					type:	'while',
					test:	s.test ? expr(s.test) : Literal(true),
					body:	[...body(s.body), ...(s.update ? [exprStmt(s.update)] : [])],
					orelse:	[],
				},
			] :	unsupported(`for kind '${s.kind}'`);

		// [~] do-while -> while True with a trailing guard
		case 'do_while':	return [{
				type:	'while',
				test:	Literal(true),
				body:	[...body(s.body), { type: 'if', test: Unary('not', expr(s.test)), consequent: [{ type: 'break' }], alternate: [] }],
				orelse:	[],
			}];

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
		default:			return unsupported(`statement '${s.type}'`);
	}
}

// [~] `self` has to be threaded in explicitly -- Python methods take it, JS ones don't
function classMember(m: TS.ClassMember): PS[] {
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
		default:		return unsupported(`class member '${m.type}'`);
	}
}

// [~] type annotations are a whole separate AST domain; only the simplest refs carry over
const PYTYPE: Record<string, string> = { number: 'float', string: 'str', boolean: 'bool', void: 'None', any: 'object', unknown: 'object' };
const typeExpr = (t: TS.Type): PE =>
		t.type === 'ref'	? Identifier(PYTYPE[t.name] ?? t.name)
	:	t.type === 'array'	? Index(Identifier('list'), typeExpr(t.element))
	:	Identifier('object');

export function ts2py(source: string, opts?: Options): string {
	return new Output(opts).toCode(TS.parse(source).body.flatMap(stmt));
}

// ===================================================================
//  PoC: Python AST -> TypeScript AST -> TypeScript source.
//  Same [=]/[~] convention as the section above; `pyUnsupported` plays the same role as `unsupported`.
// ===================================================================

type TE  = TS.Expr;
type TS_ = TS.Stmt;

const pyUnsupported = (what: string): never => { throw new Error(`py2ts: ${what} has no TypeScript equivalent`); };

const PY_COMPARE: Partial<Record<PY.compareOps, JS.compareOps>> = {
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
const PY_BINARY: Partial<Record<PY.binaryOps, JS.binaryOps>> = {
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
	'and':	'&&',
	'or':	'||',
};
const PY_UNARY: Partial<Record<PY.unaryOps, JS.unaryOps>> = {
	'+':	'+',
	'-':	'-',
	'~':	'~',
	'not':	'!',
};

// [~] `let` scoping: TypeScript needs one declaration before every use; Python has none. This tracks
// names already declared in the CURRENT function/module scope so only the FIRST assignment becomes a
// `let`, later ones a plain assignment -- known gap: it doesn't hoist across nested blocks, so a name
// whose only assignment sits inside an `if`/`for` and is read after it will still miscompile.
let pyScope: Set<string>[] = [new Set()];
const pyDeclare = (name: string): boolean => {
	const scope = pyScope[pyScope.length - 1];
	return scope.has(name) ? false : (scope.add(name), true);
};

// [~] Python's `self` is just a convention (an ordinary first parameter), not a keyword like JS's `this`
// -- the enclosing (non-static) method's own name for it is threaded through so a reference to it converts.
let pySelfName: string | undefined;

const isSuperCall = (e: PY.Expr): boolean => e.type === 'call' && e.callee.type === 'identifier' && e.callee.name === 'super' && e.arguments.length === 0;

function pyArgs(args: PY.Arg[]): TE[] {
	return args.map(a => a.kind === 'star' ? Spread(pyExpr(a.value)) : a.kind === 'pos' ? pyExpr(a.value) : pyUnsupported(`'${a.kind}' argument`));
}

function pyCompareTerm(op: PY.compareOps, left: TE, right: TE): TE {
	if (op === 'not in')
		return Unary('!', Binary('in', left, right));
	if (op === 'in')
		return Binary('in', left, right);
	const m = PY_COMPARE[op];
	return m ? Binary(m, left, right) : pyUnsupported(`comparison '${op}'`);
}

function pyKey(k: PY.Expr): JS.Key {
	return k.type === 'literal' && typeof k.value === 'string' ? k.value : { computed: pyExpr(k) };
}

const PY_TSTYPE: Record<string, string> = { float: 'number', int: 'number', str: 'string', bool: 'boolean', object: 'unknown', Any: 'unknown' };
function pyTypeExpr(t: PY.Expr): TS.Type {
	if (t.type === 'literal' && t.value === null)
		return { type: 'ref', name: 'null' };
	if (t.type === 'identifier')
		return { type: 'ref', name: PY_TSTYPE[t.name] ?? t.name };
	if (t.type === 'index') {
		const base = t.object.type === 'identifier' ? t.object.name : undefined;
		const args = t.index.type === 'tuple' ? t.index.elements : [t.index];
		if (base === 'List' || base === 'list')
			return { type: 'array', element: pyTypeExpr(args[0]) };
		if (base === 'Optional')
			return { type: 'union', types: [pyTypeExpr(args[0]), { type: 'ref', name: 'null' }] };
		if (base)
			return { type: 'ref', name: base, typeArgs: args.map(pyTypeExpr) };
	}
	if (t.type === 'binary' && t.operator === '|')
		return { type: 'union', types: [pyTypeExpr(t.left), pyTypeExpr(t.right)] };
	return { type: 'ref', name: 'unknown' };
}

function pyParam(p: PY.Param): JS.Param<TS.Type> {
	if (p.kind && p.kind !== 'normal')
		pyUnsupported("'*'/'**'/'/' parameter");
	return { key: p.name ?? pyUnsupported('bare parameter separator'), typeAnnotation: p.annotation && pyTypeExpr(p.annotation), default: p.default && pyExpr(p.default) };
}

export function pyExpr(e: PY.Expr): TE {
	switch (e.type) {
		// [=] identical shapes
		case 'identifier':	return e.name === pySelfName ? { type: 'this' } : e;
		case 'literal':		return Literal(e.value);
		case 'member':		return Member(pyExpr(e.object), e.property);
		case 'conditional':	return Conditional(pyExpr(e.test), pyExpr(e.consequent), pyExpr(e.alternate));
		case 'spread':		return Spread(pyExpr(e.operand));
		case 'await':		return Await(pyExpr(e.operand));

		case 'imaginary':	return pyUnsupported('imaginary literal');
		case 'ellipsis':	return pyUnsupported('`...` literal');

		case 'unary': {
			const op = PY_UNARY[e.operator];
			return op ? Unary(op, pyExpr(e.operand)) : pyUnsupported(`unary '${e.operator}'`);
		}
		// [~] Python has no `//`; `Math.floor(a / b)` is the closest direct equivalent
		case 'binary': {
			const op = PY_BINARY[e.operator];
			return	op					? Binary(op, pyExpr(e.left), pyExpr(e.right))
				:	e.operator === '//'	? Call(Member(Identifier('Math'), 'floor'), [Binary('/', pyExpr(e.left), pyExpr(e.right))])
				:	pyUnsupported(`binary '${e.operator}'`);
		}
		// [~] chained comparison has no direct TS form -- desugars to an `&&` chain of pairwise comparisons
		case 'compare': {
			let left = pyExpr(e.left), result: TE | undefined;
			e.ops.forEach((op, i) => {
				const right = pyExpr(e.comparators[i]);
				result = result ? Binary('&&', result, pyCompareTerm(op, left, right)) : pyCompareTerm(op, left, right);
				left = right;
			});
			return result!;
		}
		case 'lambda':		return JS.Arrow(JS.CallSig(e.params.map(pyParam)), pyExpr(e.body));
		// [~] Python's walrus is the one case of TS's more general assignment EXPRESSION
		case 'namedexpr':	return Assign(Identifier(e.target), pyExpr(e.value));

		case 'index':
			if (e.index.type === 'slice' || e.index.type === 'tuple')
				return pyUnsupported('slice subscript');
			return Index(pyExpr(e.object), pyExpr(e.index));
		case 'slice':		return pyUnsupported('slice expression (outside a subscript)');

		// [~] `super().__init__(...)` / `super().m(...)` -> TS's `super(...)` / `super.m(...)`
		case 'call': {
			if (e.callee.type === 'member' && isSuperCall(e.callee.object))
				return e.callee.property === '__init__'
					?	Call({ type: 'super' } as TE, pyArgs(e.arguments))
					:	Call(Member({ type: 'super' } as TE, e.callee.property), pyArgs(e.arguments));
			if (isSuperCall(e))
				return pyUnsupported('bare `super()` (only `super().x(...)` translates)');
			return Call(pyExpr(e.callee), pyArgs(e.arguments));
		}

		// [~] Python's tuple has no TS counterpart -- an array is the closest fit (and often is one, at the call site)
		case 'tuple':
		case 'list':		return JS.ArrayLit(e.elements.map(pyExpr));
		case 'set':			return { type: 'new', callee: Identifier('Set'), arguments: [JS.ArrayLit(e.elements.map(pyExpr))] };
		case 'dict':		return JS.ObjectExpr(e.keys.map((k, i) => k === null ? pyUnsupported('dict unpacking (`**x`)') : JS.Field(pyKey(k), pyExpr(e.values[i]))));

		case 'genexp':
		case 'listcomp':
		case 'setcomp':
		case 'dictcomp':	return pyUnsupported(`comprehension ('${e.type}')`);

		// [~] `yield from x` (delegation) <-> `yield* x` (same idea, spelled with a flag vs a field)
		case 'yield':		return { type: 'yield', operand: e.from ? pyExpr(e.from) : e.operand && pyExpr(e.operand), delegate: !!e.from };

		// [~] f-string -> template literal; format spec (`:.2f` etc.) and `!r`/`=` self-documenting forms are dropped
		case 'fstring':		return Literal(e.parts.map(p => ({ str: p.text, exp: p.field && pyExpr(p.field.expr) }))) as TE;

		default:			return pyUnsupported(`expression '${(e as PY.Expr).type}'`);
	}
}

const pyBody  = (b: readonly PY.Stmt[]): TS_[] => b.flatMap(pyStmt);
const pyBlock = (b: readonly PY.Stmt[]): TS_ => JS.Block(...pyBody(b));

// [~] N Python `except` clauses have no direct TS counterpart (one untyped `catch`) -- desugars to a
// single `catch (e)` holding an `instanceof` if/else-if chain, re-throwing `e` if nothing matches.
function pyTry(s: PY.TryStmt): TS_ {
	if (s.orelse.length)
		pyUnsupported('`try ... else`');
	const finalizer = s.finalizer.length ? pyBody(s.finalizer) : undefined;
	if (s.handlers.length === 0)
		return { type: 'try', body: pyBody(s.body), handlers: [], finalizer } as TS_;
	const param = 'e';
	const catchAll = s.handlers.find(h => !h.type);
	const typed = s.handlers.filter(h => h.type);
	const bind = (h: PY.ExceptHandler, body: TS_[]): TS_[] => h.param && h.param !== param ? [JS.VarDecl('let', JS.Var(h.param, Identifier(param))), ...body] : body;
	let chain: TS_ = catchAll ? JS.Block(...bind(catchAll, pyBody(catchAll.body))) : JS.Block({ type: 'throw', argument: Identifier(param) } as TS_);
	for (let i = typed.length; i-- > 0;) {
		const h = typed[i];
		chain = { type: 'if', test: Binary('instanceof', Identifier(param), pyExpr(h.type!)), consequent: JS.Block(...bind(h, pyBody(h.body))), alternate: chain };
	}
	return { type: 'try', body: pyBody(s.body), handlers: [{ param, body: [chain] }], finalizer } as TS_;
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
				pyUnsupported('@classmethod');
			if (m.decorators.length > (isStatic || isGetter || isSetter ? 1 : 0))
				pyUnsupported('decorator');
			const params = (isStatic ? m.params : m.params.slice(1)).map(pyParam);
			pyScope.push(new Set(params.map(p => typeof p.key === 'string' ? p.key : undefined).filter((n): n is string => !!n)));
			const savedSelf = pySelfName;
			pySelfName = isStatic ? undefined : m.params[0]?.name;
			const body = pyBody(m.body);
			pySelfName = savedSelf;
			pyScope.pop();
			return [{
				type:		isGetter ? 'get' : isSetter ? 'set' : 'method',
				key:		m.name === '__init__' ? 'constructor' : m.name,
				params,
				returnType:	m.returns && pyTypeExpr(m.returns),
				body,
				modifiers:	isStatic ? ['static'] : undefined,
			} as TS.ClassMember];
		}
		case 'assign':
			return m.targets.length === 1 && m.targets[0].type === 'identifier'
				? [JS.Field(m.targets[0].name, pyExpr(m.value))]
				: pyUnsupported('complex class-body assignment');
		case 'annassign':
			return m.target.type === 'identifier'
				? [JS.Field(m.target.name, m.value && pyExpr(m.value), pyTypeExpr(m.annotation))]
				: pyUnsupported('complex annotated field');
		default:		return pyUnsupported(`class member '${m.type}'`);
	}
}

export function pyStmt(s: PY.Stmt): TS_[] {
	switch (s.type) {
		case 'expression':	return [ExprStmt(pyExpr(s.expression))];
		case 'return':		return [Return(s.argument && pyExpr(s.argument))];
		case 'pass':		return [];
		case 'break':		return [{ type: 'break' }];
		case 'continue':	return [{ type: 'continue' }];
		// [~] `raise Foo(...)` calls the exception class; JS/TS needs an explicit `new` there
		case 'throw': {
			if (!s.argument)
				return pyUnsupported('bare `raise` (re-raise)');
			const arg = pyExpr(s.argument);
			return [{ type: 'throw', argument: arg.type === 'call' ? { type: 'new', callee: arg.callee, arguments: arg.arguments } : arg } as TS_];
		}

		// [~] first assignment of a name -> `let`; later ones are a plain assignment (see `pyDeclare`)
		case 'assign': {
			if (s.targets.length !== 1)
				return pyUnsupported('chained assignment (`a = b = c`)');
			const target = s.targets[0];
			return target.type === 'identifier' && pyDeclare(target.name)
				?	[JS.VarDecl('let', JS.Var(target.name, pyExpr(s.value)))]
				:	[ExprStmt(Assign(pyExpr(target), pyExpr(s.value)))];
		}
		case 'augassign': {
			const op = PY_BINARY[s.op.slice(0, -1) as PY.binaryOps];
			return op && op !== '&&' && op !== '||'
				?	[ExprStmt(Assign(pyExpr(s.target), pyExpr(s.value), op as JS.assignableOps))]
				:	pyUnsupported(`compound assignment '${s.op}='`);
		}
		case 'annassign': {
			if (s.target.type !== 'identifier')
				return pyUnsupported('annotated assignment to a non-identifier');
			pyDeclare(s.target.name);
			return [JS.VarDecl('let', JS.Var(s.target.name, s.value && pyExpr(s.value), pyTypeExpr(s.annotation)))];
		}

		case 'global':
		case 'nonlocal':	return pyUnsupported(`'${s.type}' declaration`);
		// [~] `del` only has a TS equivalent for a property/element -- `delete x` on a plain local isn't legal TS
		case 'del':
			return s.targets.type === 'member' || s.targets.type === 'index'
				?	[ExprStmt(Unary('delete', pyExpr(s.targets)))]
				:	pyUnsupported('`del` of a plain name');
		// [~] Python's `assert` -> `if (!test) throw new Error(msg)`
		case 'assert':
			return [{
				type:		'if',
				test:		Unary('!', pyExpr(s.test)),
				consequent:	JS.Block({ type: 'throw', argument: { type: 'new', callee: Identifier('Error'), arguments: s.msg ? [pyExpr(s.msg)] : [] } } as TS_),
			}];
		case 'import':
		case 'importfrom':	return pyUnsupported(`'${s.type}' (module systems differ too much to translate)`);

		case 'if':			return [{ type: 'if', test: pyExpr(s.test), consequent: pyBlock(s.consequent), alternate: s.alternate.length ? pyBlock(s.alternate) : undefined }];
		case 'while':
			return s.orelse.length ? pyUnsupported('`while ... else`') : [{ type: 'while', test: pyExpr(s.test), body: pyBlock(s.body) }];
		// [~] Python's `for` is always a for-of; a tuple-unpacking target has no single-binding TS equivalent
		case 'for':
			if (s.orelse.length)
				return pyUnsupported('`for ... else`');
			if (s.target.type !== 'identifier')
				return pyUnsupported('destructuring `for` target');
			return [{ type: 'for', kind: 'of', init: JS.VarDecl('let', JS.Var(s.target.name)), right: pyExpr(s.iter), body: pyBlock(s.body) }];
		case 'with':		return pyUnsupported('`with` statement (no direct RAII equivalent)');
		case 'try':			return [pyTry(s)];

		case 'funcdef': {
			if (s.decorators.length)
				return pyUnsupported('function decorator');
			pyScope.push(new Set(s.params.map(p => p.name).filter((n): n is string => !!n)));
			const body = pyBody(s.body);
			pyScope.pop();
			return [{
				type:		'function_decl',
				name:		s.name,
				params:		s.params.map(pyParam),
				returnType:	s.returns && pyTypeExpr(s.returns),
				body,
				modifiers:	s.is_async ? ['async'] : undefined,
			} as TS_];
		}
		case 'classdef': {
			if (s.bases.length > 1)
				return pyUnsupported('multiple base classes');
			if (s.decorators.length)
				return pyUnsupported('class decorator');
			const superClass = s.bases[0] && pyExpr(s.bases[0].value);
			pyScope.push(new Set());
			const body = s.body.flatMap(pyClassMember);
			pyScope.pop();
			return [{ type: 'class_decl', name: s.name, superClass, body } as TS.Stmt];
		}
		default:			return pyUnsupported(`statement '${(s as PY.Stmt).type}'`);
	}
}

export function py2ts(source: string, opts?: TSOptions): string {
	pyScope = [new Set()];
	return new TSOutput(opts).toCode(PY.parse(source).body.flatMap(pyStmt) as TS.Stmt[]);
}

// ===================================================================
//  PoC: C++ AST -> TypeScript AST -> TypeScript source.
//  Templates, multiple inheritance, raw pointers/references, and out-of-class member definitions are
//  out of scope (`cppUnsupported`) -- this covers the same "ordinary class + control flow" subset the
//  other two directions do.
// ===================================================================

const cppUnsupported = (what: string): never => { throw new Error(`cpp2ts: ${what} has no TypeScript equivalent`); };

// [~] tison's GLR engine forks on a genuine ambiguity (e.g. `T(x)` as a call vs. a functional-style
// cast) and, when neither branch dies, leaves BOTH survivors behind as an array instead of one node --
// picking the first is a pragmatic default, not a real disambiguation.
const cppFirst = <T,>(x: T | T[]): T => Array.isArray(x) ? x[0] : x;

function cppDeclaratorName(d: CPP.Declarator): string {
	switch (d.type) {
		case 'identifier':	return d.name;
		case 'function':	return cppDeclaratorName(d.name);
		case 'array':		return cppDeclaratorName(d.element);
		case 'pointer':		return cppDeclaratorName(d.to);
		case 'reference':
		case 'rvalue_reference':	return cppDeclaratorName(d.to);
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
	return cppUnsupported(`type specifier '${t.type}'`);
}
function cppTemplateArgToTs(a: CPP.TemplateArg): TS.Type {
	return 'specifiers' in a.value ? cppTypeNameToTs(a.value) : cppUnsupported('non-type template argument');
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
		case 'pointer':				return base.type === 'ref' && base.name.trim() === 'char' && !d.to ? { type: 'ref', name: 'string' } : cppUnsupported('pointer type');
		case 'array':				return { type: 'array', element: cppAbstractDeclToTs(d.element, base) };
		case 'function':			return cppUnsupported('function-pointer type');
	}
}
// Same idea as `cppAbstractDeclToTs`, but walking a real (named) Declarator instead of an abstract one.
function cppDeclaratorToTsType(d: CPP.Declarator, base: CPP.TypeSpecifier): TS.Type {
	switch (d.type) {
		case 'identifier':			return cppTypeSpecToTs(base);
		case 'reference':
		case 'rvalue_reference':	return cppDeclaratorToTsType(d.to, base);
		case 'pointer':				return base.type === 'ref' && base.name.trim() === 'char' && d.to.type === 'identifier' ? { type: 'ref', name: 'string' } : cppUnsupported('pointer variable');
		case 'array':				return { type: 'array', element: cppDeclaratorToTsType(d.element, base) };
		case 'function':			return cppUnsupported('function-pointer declarator');
	}
}

function cppParamToTs(p: CPP.ParamDecl): JS.Param<TS.Type> {
	if (isCppPackParameter(p))
		return cppUnsupported('variadic template parameter pack');
	if (!p.declarator)
		return cppUnsupported('unnamed parameter');
	return { key: cppDeclaratorName(p.declarator), typeAnnotation: cppDeclaratorToTsType(p.declarator, p.specifiers.type), default: p.default && cppExpr(p.default) };
}
function cppParamNames(params: CPP.ParamDecl[]): string[] {
	return params.flatMap(p => isCppPackParameter(p) ? (p.name ? [p.name] : []) : p.declarator ? [cppDeclaratorName(p.declarator)] : []);
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

function cppInitializerToTs(i: C.Initializer<CPP.Expr>): TE {
	return isCppExprNode(i) ? cppExpr(i) : JS.ArrayLit(i.elements.map(cppInitializerToTs));
}
function cppInitDeclaratorToVar(id: C.InitDeclarator<CPP.Declarator, CPP.Expr>, specifiers: CPP.DeclarationSpec): JS.Var<TS.Type> {
	const declarator = 'declarator' in id ? id.declarator : id;
	return {
		name:			cppDeclaratorName(declarator),
		typeAnnotation:	cppDeclaratorToTsType(declarator, specifiers.type),
		init:			'declarator' in id ? cppInitializerToTs(id.initializer) : undefined,
	};
}

export function cppExpr(e: CPP.Expr): TE {
	e = cppFirst(e);
	switch (e.type) {
		// [~] a bare name that's one of the enclosing class's own members needs an explicit `this.`
		// (unless a parameter/local of the same name shadows it, per `cppLocals`)
		case 'identifier':		return cppMemberNames.has(e.name) && !cppLocals.has(e.name) ? Member({ type: 'this' } as TE, e.name) : e;
		case 'literal':			return Literal(e.value);
		case 'char_literal':	return Literal(e.value);
		case 'null_literal':	return Literal(null);
		case 'this':			return { type: 'this' };
		case 'conditional':		return Conditional(cppExpr(e.test), cppExpr(e.consequent), cppExpr(e.alternate));
		case 'index':			return Index(cppExpr(e.object), cppExpr(e.index));
		case 'member':			return Member(cppExpr(e.object), e.property);
		// `->` dereferences first in C++; TS has no pointers to dereference, so it collapses onto plain `.`
		case 'pointer_member':	return Member(cppExpr(e.object), e.property);
		case 'call':			return Call(cppExpr(e.callee), e.arguments.map(cppExpr));
		case 'spread':			return Spread(cppExpr(e.operand));

		case 'unary': {
			const op = e.operator;
			return	op === '++' || op === '--' || op === '+' || op === '-' || op === '~' || op === '!'	? Unary(op, cppExpr(e.operand))
				:	op === '&'	? cppUnsupported('address-of (`&x`)')
				:	op === '*'	? cppUnsupported('pointer dereference (`*x`)')
				:	cppUnsupported('`sizeof`');
		}
		case 'unary_post':	return UnaryPost(e.operator as '++' | '--', cppExpr(e.operand));

		case 'binary': {
			const op = e.operator;
			return op === ',' ? { type: 'sequence', expressions: [cppExpr(e.left), cppExpr(e.right)] } : Binary(op as JS.binaryOps, cppExpr(e.left), cppExpr(e.right));
		}
		// [=] both languages now model assignment as its own node -- same shape, just a narrower operator union
		case 'assign':		return Assign(cppExpr(e.target), cppExpr(e.value), e.operator as JS.assignableOps | undefined);

		case 'cast':			return { type: 'as', expression: cppExpr(e.expression), typeAnnotation: cppTypeNameToTs(e.typeAnnotation) };
		case 'cpp_cast':		return { type: 'as', expression: cppExpr(e.expression), typeAnnotation: cppTypeNameToTs(e.target) };
		case 'functional_cast':	return Call(Identifier(e.target), e.arguments.map(cppExpr));
		case 'sizeof_type':		return cppUnsupported('`sizeof`');
		case 'sizeof_pack':		return cppUnsupported('`sizeof...`');
		case 'typeid':
		case 'alignof':			return cppUnsupported(`'${e.type}'`);
		case 'delete':			return cppUnsupported('`delete` (TS is garbage-collected)');

		case 'qualified':		return e.parts.slice(1).reduce<TE>((o, p) => Member(o, p), Identifier(e.parts[0]));
		case 'new': {
			if (e.placement?.length)
				return cppUnsupported('placement `new`');
			if (e.size)
				return { type: 'new', callee: Identifier('Array'), arguments: [cppExpr(e.size)] };
			return {
				type:		'new',
				callee:		Identifier(e.typeName.type === 'ref' || e.typeName.type === 'generic' ? e.typeName.name : cppUnsupported(`'new' of a '${e.typeName.type}' type`)),
				arguments:	(e.arguments ?? []).map(cppExpr),
			};
		}
		// [~] a lambda's own body is a real statement list either way -- TS's arrow accepts one directly
		case 'lambda':			return { type: 'arrow', params: e.params.map(cppParamToTs), body: withCppLocals(cppParamNames(e.params), () => e.body.body.flatMap(cppStmt)) } as TE;

		default:				return cppUnsupported(`expression '${(e as CPP.Expr).type}'`);
	}
}

const cppBlockOf = (s: CPP.Stmt): TS_ => JS.Block(...bodyOf(s).flatMap(cppStmt));

function cppForToTs(s: CPP.Stmt & { type: 'for' }): TS_ {
	const initClause = s.init;
	let init: JS.ForInit<TS.Type> | undefined;
	if (initClause) {
		if (initClause.type === 'declaration')
			init = { type: 'var_decl', kind: 'let', declarations: (initClause.initDeclarators ?? []).map(id => cppInitDeclaratorToVar(id, initClause.specifiers)) };
		else if (initClause.type === 'typedef')
			return cppUnsupported('`typedef` in a `for` init');
		else
			init = cppExpr(initClause);
	}
	return { type: 'for', kind: 'normal', init, test: s.test && cppExpr(s.test), update: s.update && cppExpr(s.update), body: cppBlockOf(s.body) };
}

// [~] C's `switch` is a flat statement list with `case`/`default` LABELS (fall-through is just "no
// `break`"); TS groups consecutive statements under each case explicitly, so this re-groups them.
function cppSwitchToTs(s: CPP.Stmt & { type: 'switch' }): TS_ {
	const cases: { test?: TE; consequent: TS_[] }[] = [];
	for (const st of bodyOf(s.body)) {
		if (st.type === 'case' || st.type === 'default')
			cases.push({ test: st.type === 'case' ? cppExpr(st.test) : undefined, consequent: cppStmt(st.body) });
		else if (cases.length)
			cases[cases.length - 1].consequent.push(...cppStmt(st));
		else
			cppUnsupported('statement before the first `case`/`default`');
	}
	return { type: 'switch', discriminant: cppExpr(s.discriminant), cases };
}

// [~] N C++ `catch` clauses have no direct TS counterpart (one untyped `catch`) -- same `instanceof`
// if/else-if desugaring as `pyTry` above.
function cppTryToTs(s: CPP.Stmt & { type: 'try' }): TS_ {
	const body = bodyOf(s.body).flatMap(cppStmt);
	if (s.handlers.length === 0)
		return { type: 'try', body, handlers: [], finalizer: undefined } as TS_;
	const param = 'e';
	const catchAll = s.handlers.find(h => !h.type);
	const typed = s.handlers.filter(h => h.type);
	const bind = (h: CPP.CatchClause, b: TS_[]): TS_[] => h.param && h.param !== param ? [{ type: 'var_decl', kind: 'let', declarations: [{ name: h.param, init: Identifier(param) }] } as TS_, ...b] : b;
	let chain: TS_ = catchAll ? JS.Block(...bind(catchAll, bodyOf(catchAll.body).flatMap(cppStmt))) : JS.Block({ type: 'throw', argument: Identifier(param) } as TS_);
	for (let i = typed.length; i-- > 0;) {
		const h = typed[i];
		const typeSpec = h.type!.specifiers.type;
		chain = {
			type:		'if',
			test:		Binary('instanceof', Identifier(param), Identifier(typeSpec.type === 'ref' ? typeSpec.name : cppUnsupported('non-simple exception type'))),
			consequent:	JS.Block(...bind(h, bodyOf(h.body).flatMap(cppStmt))),
			alternate:	chain,
		};
	}
	return { type: 'try', body, handlers: [{ param, body: [chain] }], finalizer: undefined } as TS_;
}

export function cppStmt(s: CPP.Stmt): TS_[] {
	s = cppFirst(s);
	switch (s.type) {
		case 'block':		return s.body.flatMap(cppStmt);
		case 'declaration': {
			if (!s.initDeclarators)
				return [];
			const declarations = s.initDeclarators.map(id => cppInitDeclaratorToVar(id, s.specifiers));
			declarations.forEach(v => cppLocals.add(v.name as string));
			return [{ type: 'var_decl', kind: 'let', declarations } as TS_];
		}
		case 'typedef':		return cppUnsupported('local `typedef`');
		case 'if':			return [{ type: 'if', test: cppExpr(s.test), consequent: cppBlockOf(s.consequent), alternate: s.alternate && cppBlockOf(s.alternate) }];
		case 'while':		return [{ type: 'while', test: cppExpr(s.test), body: cppBlockOf(s.body) }];
		case 'do_while':	return [DoWhile(cppBlockOf(s.body), cppExpr(s.test))];
		case 'for':			return [cppForToTs(s)];
		case 'switch':		return [cppSwitchToTs(s)];
		case 'case':
		case 'default':		return cppUnsupported(`'${s.type}' outside a switch`);
		case 'break':		return [{ type: 'break' }];
		case 'continue':	return [{ type: 'continue' }];
		case 'return':		return [Return(s.argument && cppExpr(s.argument))];
		case 'goto':		return cppUnsupported('`goto`');
		case 'labeled':		return [{ type: 'labeled', label: s.label, body: cppBlockOf(s.body) }];
		case 'empty':		return [{ type: 'empty' }];
		case 'expression':	return [ExprStmt(cppExpr(s.expression))];
		// [~] `throw Foo(...)` calls the exception class; TS needs an explicit `new` there
		case 'throw': {
			if (!s.argument)
				return cppUnsupported('bare `throw;` (re-throw)');
			const arg = cppExpr(s.argument);
			return [{ type: 'throw', argument: arg.type === 'call' ? { type: 'new', callee: arg.callee, arguments: arg.arguments } : arg } as TS_];
		}
		case 'try':			return [cppTryToTs(s)];
		// [~] Python's `for` is always a for-of; so is C++'s range-for -- both land on the same TS shape
		case 'range_for':	return [{ type: 'for', kind: 'of', init: { type: 'var_decl', kind: 'let', declarations: [{ name: cppDeclaratorName(s.declarator) }] }, right: cppExpr(s.range), body: cppBlockOf(s.body) }];
		case 'static_assert':	return cppUnsupported('`static_assert`');
		// no TS meaning either way -- dropped rather than flagged unsupported
		case 'using_namespace':
		case 'using_decl':		return [];
		case 'using_alias':		return [{ type: 'type_alias_decl', name: s.name, value: cppTypeNameToTs(s.target) } as TS_];
		default:				return cppUnsupported(`statement '${(s as CPP.Stmt).type}'`);
	}
}

function cppMemberBody(m: CPP.MethodTail | CPP.CtorTail): TS_[] {
	return m.body ? m.body.body.flatMap(cppStmt) : cppUnsupported('member with no body (`= default`/`= delete`/declaration-only)');
}

// [~] a C++ member-initializer list has no TS equivalent -- the base-class entry becomes the
// mandatory leading `super(...)` call, and any field entry becomes a `this.field = ...` assignment.
function cppCtorBody(m: CPP.ConstructorMember, baseName: string | undefined): TS_[] {
	return withCppLocals(cppParamNames(m.params), () => {
		const body = cppMemberBody(m);
		const baseInit = m.initializerList?.find(mi => mi.name === baseName);
		const fieldInits = (m.initializerList ?? []).filter(mi => mi.name !== baseName).map(mi => ExprStmt(Assign<TE, JS.assignableOps>(
			Member({ type: 'this' } as TE, mi.name),
			mi.arguments.length === 1 ? cppExpr(mi.arguments[0]) : cppUnsupported('multi-argument member initializer'),
		)));
		const superCall = baseName ? [ExprStmt(Call({ type: 'super' } as TE, (baseInit?.arguments ?? []).map(cppExpr)))] : [];
		return [...superCall, ...fieldInits, ...body];
	});
}

// [~] C++ lets a method reference its own fields/methods by bare name; TS always needs `this.` --
// `cppMemberNames` (the enclosing class's own member names) is what lets an identifier get rewritten.
let cppMemberNames = new Set<string>();

function cppMemberNamesOf(m: CPP.ClassMember): string[] {
	m = cppFirst(m);
	switch (m.type) {
		case 'method':			return m.declarator.type === 'function' ? [cppDeclaratorName(m.declarator.name)] : [];
		case 'struct_member':	return m.declarators.flatMap(d => 'declarator' in d ? [cppDeclaratorName(d.declarator)] : d.name ? [d.name] : []);
		default:				return [];
	}
}

// [~] visibility (`public`/`private`/`protected`) has no TS class-member equivalent modeled here -- labels are dropped
function cppClassMember(m: CPP.ClassMember, baseName: string | undefined): TS.ClassMember[] {
	m = cppFirst(m);
	switch (m.type) {
		case 'access_label':	return [];
		case 'constructor':		return [{ type: 'method', key: 'constructor', params: m.params.map(cppParamToTs), body: cppCtorBody(m, baseName) } as TS.ClassMember];
		case 'destructor':		return cppUnsupported('destructor');
		case 'method': {
			const decl = m.declarator;
			if (decl.type !== 'function')
				return cppUnsupported('method returning a pointer/array (complex declarator)');
			return [{
				type:		'method',
				key:		cppDeclaratorName(decl.name),
				params:		decl.params.map(cppParamToTs),
				returnType:	cppDeclaratorToTsType(decl.name, m.specifiers.type),
				body:		withCppLocals(cppParamNames(decl.params), () => cppMemberBody(m)),
				modifiers:	m.modifiers?.includes('static') ? ['static'] : undefined,
			} as TS.ClassMember];
		}
		case 'conversion':		return cppUnsupported('conversion operator');
		case 'using_decl':
		case 'using_alias':		return cppUnsupported(`'${m.type}' class member`);
		case 'member_template':	return cppUnsupported('member template');
		case 'struct_member': {
			if (m.declarators.length !== 1)
				return cppUnsupported('multi-name field declaration');
			const fd = m.declarators[0];
			if (!('declarator' in fd))
				return cppUnsupported('bitfield');
			return [JS.Field(cppDeclaratorName(fd.declarator), fd.initializer && cppExpr(fd.initializer), cppDeclaratorToTsType(fd.declarator, m.specifiers.type), m.modifiers?.includes('static') ? ['static'] : undefined)];
		}
		default:				return cppUnsupported(`class member '${(m as CPP.ClassMember).type}'`);
	}
}

function cppClassToTs(c: CPP.ClassSpecifier): TS_ {
	if (!c.name)
		return cppUnsupported('anonymous class/struct');
	if ((c.bases?.length ?? 0) > 1)
		return cppUnsupported('multiple base classes');
	const baseName = c.bases?.[0]?.name;
	const members = c.body ?? [];
	const savedMembers = cppMemberNames;
	cppMemberNames = new Set(members.flatMap(cppMemberNamesOf));
	const body = members.flatMap(m => cppClassMember(m, baseName));
	cppMemberNames = savedMembers;
	return {
		type:		'class_decl',
		name:		c.name,
		superClass:	baseName && Identifier(baseName),
		body,
	} as TS_;
}

function cppEnumToTs(e: CPP.CppEnumSpecifier): TS_ {
	return e.name
		? { type: 'enum_decl', name: e.name, members: (e.members ?? []).map(m => ({ name: m.name, init: m.init && cppExpr(m.init) })) } as TS_
		: cppUnsupported('anonymous enum');
}

export function cppDefinition(d: CPP.Definition): TS_[] {
	d = cppFirst(d);
	switch (d.type) {
		case 'declaration': {
			const t = d.specifiers.type;
			if ((t.type === 'class' || t.type === 'struct') && !d.initDeclarators)
				return [cppClassToTs(t)];
			if (t.type === 'union')
				return cppUnsupported('union');
			if (t.type === 'enum')
				return [cppEnumToTs(t)];
			return !d.initDeclarators ? [] : [{ type: 'var_decl', kind: 'let', declarations: d.initDeclarators.map(id => cppInitDeclaratorToVar(id, d.specifiers)) } as TS_];
		}
		case 'typedef': {
			if (d.declarators.length !== 1)
				return cppUnsupported('multi-name `typedef`');
			const decl = d.declarators[0];
			const declarator = 'declarator' in decl ? decl.declarator : decl;
			return [{ type: 'type_alias_decl', name: cppDeclaratorName(declarator), value: cppDeclaratorToTsType(declarator, d.specifiers.type) } as TS_];
		}
		case 'function_def':
			return d.declarator.type !== 'function' ? cppUnsupported('function returning a pointer/array (complex declarator)') : [{
				type:		'function_decl',
				name:		cppDeclaratorName(d.declarator.name),
				params:		d.declarator.params.map(cppParamToTs),
				returnType:	cppTypeSpecToTs(d.specifiers.type),
				body:		withCppLocals(cppParamNames(d.declarator.params), () => d.body.body.flatMap(cppStmt)),
			} as TS_];
		// [~] a namespace/`extern "C"` block has no TS counterpart -- flattened into its enclosing scope
		case 'namespace':
		case 'linkage':			return d.body.flatMap(cppDefinition);
		case 'using_alias':		return [{ type: 'type_alias_decl', name: d.name, value: cppTypeNameToTs(d.target) } as TS_];
		case 'using_namespace':
		case 'using_decl':		return [];
		case 'template':		return cppUnsupported('template (generics are out of scope)');
		case 'static_assert':	return cppUnsupported('`static_assert`');
		case 'method_def':
		case 'constructor_def':
		case 'destructor_def':
		case 'operator_def':
		case 'static_member_def':	return cppUnsupported(`out-of-class '${d.type}'`);
		default:				return cppUnsupported(`definition '${(d as CPP.Definition).type}'`);
	}
}

export async function cpp2ts(source: string, opts?: TSOptions, cppOpts?: CPP.Options): Promise<string> {
	const unit = await CPP.parse(source, cppOpts);
	return new TSOutput(opts).toCode(unit.body.flatMap(cppDefinition) as TS.Stmt[]);
}

// cpp -> py composes onto the TS AST rather than duplicating another bespoke cpp <-> py mapping:
// `cppDefinition` already produces real `TS.Stmt` nodes in memory, which the original `stmt` (ts2py's
// own TS -> PY converter, at the top of this file) accepts directly -- no text round-trip needed. Its
// coverage is the INTERSECTION of both stages' `unsupported()` sets, not a new union of its own.
export async function cpp2py(source: string, opts?: Options, cppOpts?: CPP.Options): Promise<string> {
	const unit = await CPP.parse(source, cppOpts);
	const tsStmts = unit.body.flatMap(cppDefinition) as TS.Stmt[];
	return new Output(opts).toCode(tsStmts.flatMap(stmt));
}

// ===================================================================
//  Shared C++-construction infrastructure for the two "-> C++" directions below.
//  TS and Python are both gradually/dynamically typed, so both feed a small common `SimpleType`
//  through the same CPP declarator/param/decl-spec builders -- only the front-end (annotation -> SimpleType)
//  differs per source language.
// ===================================================================

type CE = CPP.Expr;
type CS = CPP.Stmt;
type CBlock = C.Block<CPP.Declarator, CPP.TypeSpecifierExt, CPP.Expr, CPP.Stmt>;

const toCppUnsupported = (what: string): never => { throw new Error(`->cpp: ${what} has no C++ equivalent`); };

type SimpleType = { kind: 'ref'; name: string } | { kind: 'array'; element: SimpleType };
const SimpleRef	  = (name: string): SimpleType => ({ kind: 'ref', name });
const SimpleArray = (element: SimpleType): SimpleType => ({ kind: 'array', element });

function simpleTypeSpec(t: SimpleType): CPP.TypeSpecifier {
	return t.kind === 'array'
		? { type: 'generic', name: 'std::vector', args: [{ value: { specifiers: { type: simpleTypeSpec(t.element) } } }] }
		: { type: 'ref', name: t.name };
}
const simpleDeclSpec = (t: SimpleType): CPP.DeclarationSpec => ({ type: simpleTypeSpec(t) });

// [~] a class body generated here is always `struct` (all-public) -- neither source language's own
// visibility model (TS's `private`/`public` modifiers, Python's leading-underscore convention) is tracked
let currentCppClassName: string | undefined;
// threaded alongside the class name -- `super(...)`/`super.m(...)` need the base class's actual name
let currentCppBaseName: string | undefined;

const cppBlock = (stmts: CS[]): CBlock => ({ type: 'block', body: stmts });

function cppCtorMember(name: string, params: CPP.ParamDecl[], body: CS[], initializerList?: CPP.MemberInitializer[]): CPP.ConstructorMember {
	return { type: 'constructor', name, params, initializerList, body: cppBlock(body) };
}
function cppMethodMember(name: string, params: CPP.ParamDecl[], returnType: SimpleType, body: CS[], isStatic?: boolean): CPP.MethodMember {
	return {
		type:		'method',
		specifiers:	simpleDeclSpec(returnType),
		declarator:	C.FunctionDecl(Identifier(name), params),
		body:		cppBlock(body),
		modifiers:	isStatic ? ['static'] : undefined,
	};
}
function cppFieldMember(name: string, type: SimpleType, init?: CE, isStatic?: boolean): CPP.StructMember {
	return { type: 'struct_member', specifiers: simpleDeclSpec(type), declarators: [{ declarator: Identifier(name), initializer: init }], modifiers: isStatic ? ['static'] : undefined };
}
function cppClassDecl(name: string, baseName: string | undefined, body: CPP.ClassMember[]): CS {
	return { type: 'declaration', specifiers: { type: { type: 'struct', name, bases: baseName ? [{ name: baseName }] : undefined, body } } };
}

// ===================================================================
//  PoC: TypeScript AST -> C++ AST -> C++ source.
// ===================================================================

const TS_CPPTYPE: Record<string, string> = { number: 'double', string: 'std::string', boolean: 'bool', void: 'void', unknown: 'auto', any: 'auto', object: 'auto', null: 'std::nullptr_t' };
function tsTypeToSimple(t: TS.Type | undefined): SimpleType {
	if (!t)
		return SimpleRef('auto');
	if (t.type === 'ref')
		return SimpleRef(TS_CPPTYPE[t.name] ?? t.name);
	if (t.type === 'array')
		return SimpleArray(tsTypeToSimple(t.element));
	// [~] `T | null`/`T | undefined` -- the closest fit is just `T` (no `std::optional` modeled)
	if (t.type === 'union') {
		const nonNull = t.types.find(x => !(x.type === 'ref' && (x.name === 'null' || x.name === 'undefined')));
		return nonNull ? tsTypeToSimple(nonNull) : SimpleRef('auto');
	}
	return SimpleRef('auto');
}

function tsKeyName(k: JS.Key): string {
	return typeof k === 'string' ? k : toCppUnsupported('computed member name');
}
function tsParamToCpp(p: JS.Param<TS.Type>): CPP.ParamDecl {
	if (typeof p.key !== 'string')
		return toCppUnsupported('destructuring parameter');
	return { type: 'parameter', specifiers: simpleDeclSpec(tsTypeToSimple(p.typeAnnotation)), declarator: Identifier(p.key), default: p.default && tsExprToCpp(p.default) };
}

function tsTemplateToCpp(parts: JS.TemplatePart<TS.Expr>[]): CE {
	let result: CE | undefined;
	for (const p of parts) {
		if (p.str)
			result = result ? Binary('+', result, Literal(p.str)) : Literal(p.str);
		if (p.exp) {
			const e = tsExprToCpp(p.exp);
			result = result ? Binary('+', result, e) : e;
		}
	}
	return result ?? Literal('');
}

export function tsExprToCpp(e: TS.Expr): CE {
	switch (e.type) {
		// [=] identical shapes
		case 'identifier':
		case 'this':		return e;
		case 'literal':
			if (Array.isArray(e.value))
				return tsTemplateToCpp(e.value as JS.TemplatePart<TS.Expr>[]);
			return e.value === null ? { type: 'null_literal' } : Literal(typeof e.value === 'bigint' ? Number(e.value) : e.value as number | string | boolean);
		case 'conditional':	return Conditional(tsExprToCpp(e.test), tsExprToCpp(e.consequent), tsExprToCpp(e.alternate));
		case 'index':		return Index(tsExprToCpp(e.object), tsExprToCpp(e.index));
		// [~] `this` is a POINTER in C++ -- a member access off it needs `->`, not `.`
		case 'member':		return e.object.type === 'this' ? { type: 'pointer_member', object: tsExprToCpp(e.object), property: e.property } : Member(tsExprToCpp(e.object), e.property);
		// [~] `super.m(...)` has no `super` keyword in C++ -- it's an explicit qualified call, `Base::m(...)`
		case 'call':
			if (e.callee.type === 'member' && e.callee.object.type === 'super')
				return {
					type:		'call',
					callee:		{ type: 'qualified', parts: [currentCppBaseName ?? toCppUnsupported('`super.m(...)` outside a derived class'), e.callee.property] },
					arguments:	e.arguments.map(tsExprToCpp),
				};
			if (e.callee.type === 'super')
				return toCppUnsupported('bare `super(...)` (only as the first statement of a constructor)');
			return { type: 'call', callee: tsExprToCpp(e.callee), arguments: e.arguments.map(tsExprToCpp) };
		case 'spread':		return Spread(tsExprToCpp(e.operand));

		case 'unary': {
			const op = e.operator;
			return	op === '+' || op === '-' || op === '~' || op === '!' || op === '++' || op === '--'	? Unary(op, tsExprToCpp(e.operand))
				:	toCppUnsupported(`unary '${op}'`);
		}
		case 'unary_post':	return UnaryPost(e.operator as '++' | '--', tsExprToCpp(e.operand));

		// [~] `===`/`!==` collapse onto C++'s single `==`/`!=`; `>>>`, `??`, `in`, `instanceof` have no equivalent here
		case 'binary': {
			const op = e.operator;
			return	op === '===' || op === '!=='	? Binary(op === '===' ? '==' : '!=', tsExprToCpp(e.left), tsExprToCpp(e.right))
				:	op === '>>>' || op === '??' || op === 'in' || op === 'instanceof'	? toCppUnsupported(`'${op}' operator`)
				:	Binary(op as C.binaryOps, tsExprToCpp(e.left), tsExprToCpp(e.right));
		}
		// [=] both languages now model assignment as its own node; only the operator set narrows
		case 'assign': {
			const op = e.operator;
			return	op === '**' || op === '>>>' || op === '??'	? toCppUnsupported(`compound assignment '${op}='`)
				:	Assign<CE, C.assignableOps>(tsExprToCpp(e.target), tsExprToCpp(e.value), op);
		}

		case 'new':			return e.callee.type === 'identifier'
			?	{ type: 'new', typeName: { type: 'ref', name: e.callee.name }, arguments: e.arguments.map(tsExprToCpp) }
			:	toCppUnsupported('`new` with a non-identifier callee');
		case 'sequence':	return e.expressions.map(tsExprToCpp).reduce((acc, x) => Binary(',', acc, x));

		// [=] TS-only wrappers just unwrap
		case 'as':
		case 'satisfies':
		case 'instantiation':	return tsExprToCpp(e.expression);

		default:				return toCppUnsupported(`expression '${e.type}'`);
	}
}

// [~] an array literal has no general C++ *expression* form (no bare braced-init outside a declaration)
// -- so it's only accepted as a variable's direct initializer, via this path instead of `tsExprToCpp`.
function tsInitializerToCpp(e: TS.Expr): C.Initializer<CPP.Expr> {
	return e.type === 'array'
		? { type: 'initializer_list', elements: e.elements.map(x => x ? tsInitializerToCpp(x) : toCppUnsupported('sparse array element')) }
		: tsExprToCpp(e);
}

function tsVarToCpp(v: JS.Var<TS.Type>): CS {
	const name = bindName(v.name);
	const type = v.typeAnnotation ? tsTypeToSimple(v.typeAnnotation) : v.init ? SimpleRef('auto') : toCppUnsupported('variable with neither a type annotation nor an initializer');
	return { type: 'declaration', specifiers: simpleDeclSpec(type), initDeclarators: [v.init ? { declarator: Identifier(name), initializer: tsInitializerToCpp(v.init) } : Identifier(name)] };
}

const tsBlockOf = (b: TS.Stmt | readonly TS.Stmt[] | undefined): CBlock => cppBlock(bodyOf(b).flatMap(tsStmtToCpp));

function tsSwitchToCpp(s: TS.Stmt & { type: 'switch' }): CS {
	const body: CS[] = [];
	for (const c of s.cases) {
		const consequent = c.consequent.flatMap(tsStmtToCpp);
		const head: CS = c.test ? { type: 'case', test: tsExprToCpp(c.test), body: consequent[0] ?? { type: 'empty' } } : { type: 'default', body: consequent[0] ?? { type: 'empty' } };
		body.push(head, ...consequent.slice(1));
	}
	return { type: 'switch', discriminant: tsExprToCpp(s.discriminant), body: cppBlock(body) };
}

// [~] C++ has no `finally` -- the finalizer's statements are duplicated onto every exit path (the
// try body and each handler), which misses the one case real `finally` covers: an uncaught exception.
function tsTryToCpp(s: TS.Stmt & { type: 'try' }): CS {
	const finalizer = s.finalizer ? s.finalizer.flatMap(tsStmtToCpp) : [];
	return {
		type:		'try',
		body:		cppBlock([...bodyOf(s.body).flatMap(tsStmtToCpp), ...finalizer]),
		handlers:	s.handlers.map(h => ({
			type:	{ specifiers: { type: { type: 'ref', name: 'std::exception' } } },
			byRef:	true,
			param:	h.param ? bindName(h.param) : 'e',
			body:	cppBlock([...bodyOf(h.body).flatMap(tsStmtToCpp), ...finalizer]),
		})),
	};
}

// [~] `throw new Foo(...)` throws a heap POINTER in JS/TS terms, but C++ exceptions are thrown BY VALUE
// -- the `new` is dropped so the object is constructed directly.
function tsThrowArg(e: TS.Expr): CE {
	return e.type === 'new' && e.callee.type === 'identifier'
		? { type: 'call', callee: Identifier(e.callee.name), arguments: e.arguments.map(tsExprToCpp) }
		: tsExprToCpp(e);
}

export function tsStmtToCpp(s: TS.Stmt): CS[] {
	switch (s.type) {
		case 'expression':	return [{ type: 'expression', expression: tsExprToCpp(s.expression) }];
		case 'empty':		return [{ type: 'empty' }];
		case 'return':		return [Return(s.argument && tsExprToCpp(s.argument))];
		case 'break':		return s.label ? toCppUnsupported('labeled `break`') : [{ type: 'break' }];
		case 'continue':	return s.label ? toCppUnsupported('labeled `continue`') : [{ type: 'continue' }];
		case 'if':			return [{ type: 'if', test: tsExprToCpp(s.test), consequent: tsBlockOf(s.consequent), alternate: s.alternate && tsBlockOf(s.alternate) }];
		case 'while':		return [{ type: 'while', test: tsExprToCpp(s.test), body: tsBlockOf(s.body) }];
		case 'do_while':	return [DoWhile(tsBlockOf(s.body), tsExprToCpp(s.test))];

		case 'for':
			if (s.kind === 'normal') {
				const init = !s.init ? undefined : isVarDecl(s.init) ? s.init.declarations.map(tsVarToCpp)[0] as unknown as C.Declaration : tsExprToCpp(s.init);
				return [{ type: 'for', init, test: s.test && tsExprToCpp(s.test), update: s.update && tsExprToCpp(s.update), body: tsBlockOf(s.body) }];
			}
			if (!isVarDecl(s.init) || s.init.declarations.length !== 1)
				return toCppUnsupported('`for`/`for-of` over an existing (non-declared) binding');
			return [{ type: 'range_for', specifiers: simpleDeclSpec(tsTypeToSimple(s.init.declarations[0].typeAnnotation)), declarator: Identifier(bindName(s.init.declarations[0].name)), range: tsExprToCpp(s.right), body: tsBlockOf(s.body) }];

		case 'switch':		return [tsSwitchToCpp(s)];
		case 'try':			return [tsTryToCpp(s)];
		case 'throw':		return [{ type: 'throw', argument: tsThrowArg(s.argument) }];
		case 'labeled':		return [{ type: 'labeled', label: s.label, body: tsBlockOf(s.body) }];
		case 'var_decl':	return s.declarations.map(tsVarToCpp);
		// [~] a local class is real C++; a local FUNCTION declaration is not (no nested named functions)
		case 'class_decl':	return [tsClassToCpp(s)];
		case 'function_decl':	return toCppUnsupported('nested function declaration (C++ has no local named functions)');

		case 'block':
		case 'with':
		case 'debugger':
		case 'import':
		case 'export':
		case 'export_decl':	return toCppUnsupported(`statement '${s.type}'`);
		default:				return toCppUnsupported(`statement '${(s as TS.Stmt).type}'`);
	}
}

function tsClassMemberToCpp(m: TS.ClassMember): CPP.ClassMember[] {
	if (m.type === 'static_block')
		return toCppUnsupported('static initialization block');
	if (m.type === 'index_signature')
		return toCppUnsupported('index signature');
	const isStatic = m.modifiers?.includes('static');
	if (m.type === 'field')
		return [cppFieldMember(tsKeyName(m.key), tsTypeToSimple(m.typeAnnotation), m.value && tsExprToCpp(m.value), isStatic)];
	// [~] getters/setters have no C++ syntax equivalent modeled here -- emitted as plain named methods
	const name = tsKeyName(m.key);
	if (name !== 'constructor')
		return [cppMethodMember(name, m.params.map(tsParamToCpp), tsTypeToSimple(m.returnType), tsBlockOf(m.body).body, isStatic)];

	// [~] a leading bare `super(...)` call is TS's ONLY spelling of what C++ requires in the member-initializer
	// list -- peeled off here (before the rest of the body goes through the ordinary statement path, where a
	// `super(...)` call would otherwise be rejected as an unconvertible expression).
	const stmts = m.body ?? [];
	const first = stmts[0];
	const isSuperCall = !!first && first.type === 'expression' && first.expression.type === 'call' && first.expression.callee.type === 'super';
	const initializerList: CPP.MemberInitializer[] | undefined = isSuperCall
		? [{ name: currentCppBaseName ?? toCppUnsupported('`super(...)` outside a derived class'), arguments: (first.expression as TS.Expr & { type: 'call' }).arguments.map(tsExprToCpp) }]
		: undefined;
	return [cppCtorMember(currentCppClassName ?? toCppUnsupported('constructor outside a class'), m.params.map(tsParamToCpp), tsBlockOf(isSuperCall ? stmts.slice(1) : stmts).body, initializerList)];
}

function tsClassToCpp(c: TS.Stmt & { type: 'class_decl' }): CS {
	if (!c.name)
		return toCppUnsupported('anonymous class');
	if (c.superClass && c.superClass.type !== 'identifier')
		return toCppUnsupported('base class expression (only a plain name converts)');
	const savedClass = currentCppClassName, savedBase = currentCppBaseName;
	currentCppClassName = c.name;
	currentCppBaseName = c.superClass && (c.superClass as TS.Expr & { type: 'identifier' }).name;
	const body = c.body.flatMap(tsClassMemberToCpp);
	const decl = cppClassDecl(c.name, currentCppBaseName, body);
	currentCppClassName = savedClass;
	currentCppBaseName = savedBase;
	return decl;
}

// [~] a named function or class DECLARATION is real top-level C++; a bare executable statement isn't
// (there's no "script" scope to run it in) -- so the top level gets its own dispatch rather than reusing
// `tsStmtToCpp` (which, correctly, refuses a nested `function_decl`).
function tsTopLevel(s: TS.Stmt): CPP.Definition[] {
	if (s.type === 'function_decl')
		return [{
			type:		'function_def',
			specifiers:	simpleDeclSpec(tsTypeToSimple(s.returnType)),
			declarator:	C.FunctionDecl(Identifier(s.name), s.params.map(tsParamToCpp)),
			body:		tsBlockOf(s.body),
		} as unknown as CPP.Definition];
	if (s.type === 'class_decl')
		return [tsClassToCpp(s) as unknown as CPP.Definition];
	if (s.type === 'var_decl')
		return s.declarations.map(v => tsVarToCpp(v) as unknown as CPP.Definition);
	return toCppUnsupported(`top-level '${s.type}' (only functions, classes, and variables convert at file scope)`);
}

export function ts2cpp(source: string, opts?: CPPOptions): string {
	currentCppClassName = undefined;
	return new CPPOutput(opts).toCode({ type: 'translation_unit', body: TS.parse(source).body.flatMap(tsTopLevel) } as unknown as C.TranslationUnit);
}

// ===================================================================
//  PoC: Python AST -> C++ AST -> C++ source.
//  Unlike ts2cpp, C++ genuinely supports multiple typed `catch` clauses, so `try`/`except` maps
//  directly instead of needing the `instanceof` if/else-if desugaring `pyTry` (py2ts) uses.
// ===================================================================

const PY_CPPTYPE: Record<string, string> = { float: 'double', int: 'int', str: 'std::string', bool: 'bool', object: 'auto', Any: 'auto' };
function pyTypeToSimple(t: PY.Expr | undefined): SimpleType {
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
			return SimpleArray(pyTypeToSimple(args[0]));
		if (base === 'Optional')
			return pyTypeToSimple(args[0]);
	}
	if (t.type === 'binary' && t.operator === '|')
		return pyTypeToSimple(t.left);
	return SimpleRef('auto');
}

function pyParamToCpp(p: PY.Param): CPP.ParamDecl {
	if (p.kind && p.kind !== 'normal')
		return toCppUnsupported("'*'/'**'/'/' parameter");
	return { type: 'parameter', specifiers: simpleDeclSpec(pyTypeToSimple(p.annotation)), declarator: Identifier(p.name ?? toCppUnsupported('bare parameter separator')), default: p.default && pyExprToCpp(p.default) };
}

// [~] `self` is a plain first parameter in Python, not a keyword -- same threading `pySelfName` does
// for py2ts, kept as its own variable since the two directions can run independently.
let pyCppSelfName: string | undefined;
let pyCppScope: Set<string>[] = [new Set()];
const pyCppDeclare = (name: string): boolean => {
	const scope = pyCppScope[pyCppScope.length - 1];
	return scope.has(name) ? false : (scope.add(name), true);
};

function pyArgsToCpp(args: PY.Arg[]): CE[] {
	return args.map(a => a.kind === 'star' ? Spread(pyExprToCpp(a.value)) : a.kind === 'pos' ? pyExprToCpp(a.value) : toCppUnsupported(`'${a.kind}' argument`));
}

function pyFStringToCpp(parts: PY.FStringPart[]): CE {
	let result: CE | undefined;
	for (const p of parts) {
		if (p.text)
			result = result ? Binary('+', result, Literal(p.text)) : Literal(p.text);
		if (p.field) {
			const e = pyExprToCpp(p.field.expr);
			result = result ? Binary('+', result, e) : e;
		}
	}
	return result ?? Literal('');
}

export function pyExprToCpp(e: PY.Expr): CE {
	switch (e.type) {
		// [~] a bare `self` reference converts to `this` (a POINTER in C++, hence `pointer_member` for `.` access below)
		case 'identifier':	return e.name === pyCppSelfName ? { type: 'this' } : e;
		case 'literal':		return e.value === null ? { type: 'null_literal' } : Literal(typeof e.value === 'bigint' ? Number(e.value) : e.value as number | string | boolean);
		case 'imaginary':	return toCppUnsupported('imaginary literal');
		case 'ellipsis':	return toCppUnsupported('`...` literal');
		case 'conditional':	return Conditional(pyExprToCpp(e.test), pyExprToCpp(e.consequent), pyExprToCpp(e.alternate));
		case 'spread':		return Spread(pyExprToCpp(e.operand));
		case 'namedexpr':	return Assign<CE, C.assignableOps>(Identifier(e.target), pyExprToCpp(e.value));

		case 'unary': {
			const op = e.operator;
			return	op === '+' || op === '-' || op === '~'	? Unary(op, pyExprToCpp(e.operand))
				:	op === 'not'						? Unary('!', pyExprToCpp(e.operand))
				:	toCppUnsupported(`unary '${op}'`);
		}
		// [~] Python has no `//`/`@`; a floor-div/matrix-mul call would need a real numeric library, so left unsupported
		case 'binary': {
			const op = e.operator;
			return	op === 'and'	? Binary('&&', pyExprToCpp(e.left), pyExprToCpp(e.right))
				:	op === 'or'		? Binary('||', pyExprToCpp(e.left), pyExprToCpp(e.right))
				:	op === '//' || op === '@'	? toCppUnsupported(`'${op}' operator`)
				:	Binary(op as C.binaryOps, pyExprToCpp(e.left), pyExprToCpp(e.right));
		}
		// [~] a chained comparison (`a < b < c`) has no single-expression C++ form without a temporary this level can't introduce
		case 'compare': {
			if (e.ops.length !== 1)
				return toCppUnsupported('chained comparison (`a < b < c`)');
			const op = e.ops[0] === '<>' ? '!=' : e.ops[0];
			return	op === '<' || op === '>' || op === '<=' || op === '>=' || op === '==' || op === '!='
				?	Binary(op, pyExprToCpp(e.left), pyExprToCpp(e.comparators[0]))
				:	toCppUnsupported(`comparison '${e.ops[0]}'`);
		}

		case 'index':
			if (e.index.type === 'slice' || e.index.type === 'tuple')
				return toCppUnsupported('slice subscript');
			return Index(pyExprToCpp(e.object), pyExprToCpp(e.index));
		case 'slice':		return toCppUnsupported('slice expression (outside a subscript)');

		case 'member':
			return e.object.type === 'identifier' && e.object.name === pyCppSelfName
				?	{ type: 'pointer_member', object: pyExprToCpp(e.object), property: e.property }
				:	Member(pyExprToCpp(e.object), e.property);

		// [~] `super().__init__(...)` only converts as a constructor's leading statement (see `pyClassMemberToCpp`);
		// `super().m(...)` becomes an explicit qualified call, `Base::m(...)` (C++ has no `super` keyword)
		case 'call': {
			if (e.callee.type === 'member' && isSuperCall(e.callee.object))
				return e.callee.property === '__init__'
					?	toCppUnsupported("`super().__init__(...)` only converts as a constructor's first statement")
					:	{ type: 'call', callee: { type: 'qualified', parts: [currentCppBaseName ?? toCppUnsupported('`super()` outside a derived class'), e.callee.property] }, arguments: pyArgsToCpp(e.arguments) };
			if (isSuperCall(e))
				return toCppUnsupported('bare `super()`');
			return { type: 'call', callee: pyExprToCpp(e.callee), arguments: pyArgsToCpp(e.arguments) };
		}

		case 'lambda':
			return {
				type:		'lambda',
				captures:	[{ defaultCapture: '&' }],
				params:		e.params.map(pyParamToCpp),
				body:		cppBlock([{ type: 'return', argument: pyExprToCpp(e.body) }]),
			};

		case 'tuple':
		case 'list':
		case 'set':
		case 'dict':			return toCppUnsupported(`'${e.type}' literal used as an expression (only as a variable's direct initializer)`);
		case 'genexp':
		case 'listcomp':
		case 'setcomp':
		case 'dictcomp':		return toCppUnsupported(`comprehension ('${e.type}')`);
		case 'await':
		case 'yield':			return toCppUnsupported(`'${e.type}' (no direct C++ coroutine equivalent modeled)`);
		case 'fstring':			return pyFStringToCpp(e.parts);

		default:				return toCppUnsupported(`expression '${(e as PY.Expr).type}'`);
	}
}

// [~] mirrors `tsInitializerToCpp` -- a list/tuple literal has no general C++ *expression* form, only a
// variable's direct (braced) initializer.
function pyInitializerToCpp(e: PY.Expr): C.Initializer<CPP.Expr> {
	return e.type === 'list' || e.type === 'tuple'
		? { type: 'initializer_list', elements: e.elements.map(pyInitializerToCpp) }
		: pyExprToCpp(e);
}

function pyVarDeclToCpp(name: string, type: SimpleType, init?: C.Initializer<CPP.Expr>): CS {
	return { type: 'declaration', specifiers: simpleDeclSpec(type), initDeclarators: [init !== undefined ? { declarator: Identifier(name), initializer: init } : Identifier(name)] };
}

// [~] N Python `except` clauses map DIRECTLY onto N C++ `catch` clauses (unlike py2ts's single-catch
// TS/JS target) -- no `instanceof` desugaring needed here.
function pyTryToCpp(s: PY.TryStmt): CS {
	if (s.orelse.length)
		toCppUnsupported('`try ... else`');
	const finalizer = s.finalizer.length ? s.finalizer.flatMap(pyStmtToCpp) : [];
	const handlers: CPP.CatchClause[] = s.handlers.map(h => ({
		type:	{ specifiers: { type: { type: 'ref', name: h.type ? (h.type.type === 'identifier' ? h.type.name : toCppUnsupported('non-simple exception type')) : 'std::exception' } } },
		byRef:	true,
		param:	h.param ?? 'e',
		body:	cppBlock([...h.body.flatMap(pyStmtToCpp), ...finalizer]),
	}));
	return { type: 'try', body: cppBlock([...s.body.flatMap(pyStmtToCpp), ...finalizer]), handlers };
}

export function pyStmtToCpp(s: PY.Stmt): CS[] {
	switch (s.type) {
		case 'expression':	return [{ type: 'expression', expression: pyExprToCpp(s.expression) }];
		case 'return':		return [Return(s.argument && pyExprToCpp(s.argument))];
		case 'pass':		return [];
		case 'break':		return [{ type: 'break' }];
		case 'continue':	return [{ type: 'continue' }];
		case 'throw':		return [{ type: 'throw', argument: s.argument ? pyExprToCpp(s.argument) : toCppUnsupported('bare `raise` (re-raise)') }];

		// [~] first assignment of a name declares it (`auto`); later ones are a plain assignment (see `pyCppDeclare`) --
		// same known gap as py2ts's `pyDeclare`: doesn't hoist across nested blocks.
		case 'assign': {
			if (s.targets.length !== 1)
				return toCppUnsupported('chained assignment (`a = b = c`)');
			const target = s.targets[0];
			return target.type === 'identifier' && pyCppDeclare(target.name)
				?	[pyVarDeclToCpp(target.name, SimpleRef('auto'), pyInitializerToCpp(s.value))]
				:	[{ type: 'expression', expression: Assign<CE, C.assignableOps>(pyExprToCpp(target), pyExprToCpp(s.value)) }];
		}
		case 'augassign': {
			const op = s.op.slice(0, -1);
			return ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'].includes(op)
				?	[{ type: 'expression', expression: Assign<CE, C.assignableOps>(pyExprToCpp(s.target), pyExprToCpp(s.value), op as C.assignableOps) }]
				:	toCppUnsupported(`compound assignment '${s.op}'`);
		}
		case 'annassign': {
			if (s.target.type !== 'identifier')
				return toCppUnsupported('annotated assignment to a non-identifier');
			pyCppDeclare(s.target.name);
			return [pyVarDeclToCpp(s.target.name, pyTypeToSimple(s.annotation), s.value && pyInitializerToCpp(s.value))];
		}

		case 'global':
		case 'nonlocal':	return toCppUnsupported(`'${s.type}' declaration`);
		case 'del':			return toCppUnsupported('`del` (C++ objects have no dynamic attribute/member deletion)');
		// [~] Python's `assert` -> `if (!test) throw std::runtime_error(msg);`
		case 'assert':
			return [{
				type:		'if',
				test:		Unary('!', pyExprToCpp(s.test)),
				consequent:	cppBlock([{ type: 'throw', argument: { type: 'call', callee: Identifier('std::runtime_error'), arguments: [s.msg ? pyExprToCpp(s.msg) : Literal('assertion failed')] } }]),
			}];
		case 'import':
		case 'importfrom':	return toCppUnsupported(`'${s.type}' (module systems differ too much to translate)`);

		case 'if':			return [{ type: 'if', test: pyExprToCpp(s.test), consequent: cppBlock(s.consequent.flatMap(pyStmtToCpp)), alternate: s.alternate.length ? cppBlock(s.alternate.flatMap(pyStmtToCpp)) : undefined }];
		case 'while':		return s.orelse.length ? toCppUnsupported('`while ... else`') : [{ type: 'while', test: pyExprToCpp(s.test), body: cppBlock(s.body.flatMap(pyStmtToCpp)) }];
		// [~] Python's `for` is always a for-of; C++'s range-for is the direct match
		case 'for':
			if (s.orelse.length)
				return toCppUnsupported('`for ... else`');
			if (s.target.type !== 'identifier')
				return toCppUnsupported('destructuring `for` target');
			return [{ type: 'range_for', specifiers: simpleDeclSpec(SimpleRef('auto')), declarator: Identifier(s.target.name), range: pyExprToCpp(s.iter), body: cppBlock(s.body.flatMap(pyStmtToCpp)) }];
		case 'with':		return toCppUnsupported('`with` statement (no direct RAII equivalent modeled)');
		case 'try':			return [pyTryToCpp(s)];

		case 'classdef':	return [pyClassToCpp(s)];
		case 'funcdef':		return toCppUnsupported('nested function declaration (C++ has no local named functions)');
		default:			return toCppUnsupported(`statement '${(s as PY.Stmt).type}'`);
	}
}

// A leading `super().__init__(...)` is Python's only spelling of a C++ member-initializer-list entry --
// same peeling `tsClassMemberToCpp` does for TS's leading `super(...)` call.
function pySuperInitArgs(s: PY.Stmt): PY.Expr[] | undefined {
	if (s.type !== 'expression' || s.expression.type !== 'call')
		return undefined;
	const call = s.expression;
	if (call.callee.type !== 'member' || call.callee.property !== '__init__' || !isSuperCall(call.callee.object))
		return undefined;
	return call.arguments.map(a => a.kind === 'pos' ? a.value : toCppUnsupported("non-positional argument to 'super().__init__(...)'"));
}

function pyClassMemberToCpp(m: PY.Stmt): CPP.ClassMember[] {
	switch (m.type) {
		case 'pass':	return [];
		case 'funcdef': {
			const isStatic = m.decorators.some(d => d.type === 'identifier' && d.name === 'staticmethod');
			if (m.decorators.some(d => d.type === 'identifier' && (d.name === 'classmethod' || d.name === 'property')) || m.decorators.some(d => d.type === 'member' && d.property === 'setter'))
				toCppUnsupported('@classmethod/@property/@x.setter (no C++ syntax equivalent modeled)');
			if (m.decorators.length > (isStatic ? 1 : 0))
				toCppUnsupported('decorator');
			const pyParams = isStatic ? m.params : m.params.slice(1);
			const params = pyParams.map(pyParamToCpp);
			pyCppScope.push(new Set(pyParams.map(p => p.name).filter((n): n is string => !!n)));
			const savedSelf = pyCppSelfName;
			pyCppSelfName = isStatic ? undefined : m.params[0]?.name;

			if (m.name === '__init__') {
				const superArgs = m.body[0] && pySuperInitArgs(m.body[0]);
				const initializerList = superArgs ? [{ name: currentCppBaseName ?? toCppUnsupported("'super().__init__(...)' outside a derived class"), arguments: superArgs.map(pyExprToCpp) }] : undefined;
				const body = (superArgs ? m.body.slice(1) : m.body).flatMap(pyStmtToCpp);
				pyCppSelfName = savedSelf;
				pyCppScope.pop();
				return [cppCtorMember(currentCppClassName ?? toCppUnsupported('constructor outside a class'), params, body, initializerList)];
			}
			const body = m.body.flatMap(pyStmtToCpp);
			pyCppSelfName = savedSelf;
			pyCppScope.pop();
			return [cppMethodMember(m.name, params, pyTypeToSimple(m.returns), body, isStatic)];
		}
		case 'assign':
			return m.targets.length === 1 && m.targets[0].type === 'identifier'
				? [cppFieldMember(m.targets[0].name, SimpleRef('auto'), pyExprToCpp(m.value))]
				: toCppUnsupported('complex class-body assignment');
		case 'annassign':
			return m.target.type === 'identifier'
				? [cppFieldMember(m.target.name, pyTypeToSimple(m.annotation), m.value && pyExprToCpp(m.value))]
				: toCppUnsupported('complex annotated field');
		default:		return toCppUnsupported(`class member '${m.type}'`);
	}
}

// Unlike TS/JS, a C++ `struct` has no dynamic fields -- unlike a class-level `name: int` (which already
// becomes a `struct_member` via `pyClassMemberToCpp`'s `annassign` case), `self.name = ...` assigned only
// inside `__init__` declares nothing there, so those need synthesizing here or the struct won't compile.
function pyInferFieldType(value: PY.Expr, params: PY.Param[]): SimpleType {
	if (value.type === 'identifier') {
		const p = params.find(p => p.name === value.name);
		if (p?.annotation)
			return pyTypeToSimple(p.annotation);
	}
	if (value.type === 'literal') {
		if (typeof value.value === 'boolean')
			return SimpleRef('bool');
		if (typeof value.value === 'string')
			return SimpleRef('std::string');
		if (typeof value.value === 'number' || typeof value.value === 'bigint')
			return SimpleRef(Number.isInteger(value.value) ? 'int' : 'double');
	}
	return toCppUnsupported(`cannot infer a C++ type for a field initialized from a '${value.type}' -- add a class-level annotation (e.g. \`name: int\`) instead`);
}
function pySelfFieldsFromInit(init: PY.Stmt & { type: 'funcdef' }, skip: ReadonlySet<string>): CPP.StructMember[] {
	const selfName = init.params[0]?.name;
	const seen = new Set<string>();
	const fields: CPP.StructMember[] = [];
	for (const s of init.body) {
		if (s.type !== 'assign' || s.targets.length !== 1)
			continue;
		const t = s.targets[0];
		if (t.type === 'member' && t.object.type === 'identifier' && t.object.name === selfName && !seen.has(t.property) && !skip.has(t.property)) {
			seen.add(t.property);
			fields.push(cppFieldMember(t.property, pyInferFieldType(s.value, init.params)));
		}
	}
	return fields;
}

function pyClassToCpp(s: PY.Stmt & { type: 'classdef' }): CS {
	if (s.bases.length > 1)
		return toCppUnsupported('multiple base classes');
	const baseArg = s.bases[0];
	if (baseArg && baseArg.value.type !== 'identifier')
		return toCppUnsupported('base class expression (only a plain name converts)');
	const savedClass = currentCppClassName, savedBase = currentCppBaseName;
	currentCppClassName = s.name;
	currentCppBaseName = baseArg ? (baseArg.value as PY.Expr & { type: 'identifier' }).name : undefined;
	pyCppScope.push(new Set());
	const explicitFields = new Set(s.body.flatMap(m =>
		m.type === 'assign' && m.targets[0]?.type === 'identifier' ? [m.targets[0].name]
		: m.type === 'annassign' && m.target.type === 'identifier' ? [m.target.name]
		: []));
	const init = s.body.find((m): m is PY.Stmt & { type: 'funcdef' } => m.type === 'funcdef' && m.name === '__init__');
	const inferredFields = init ? pySelfFieldsFromInit(init, explicitFields) : [];
	const body = [...inferredFields, ...s.body.flatMap(pyClassMemberToCpp)];
	pyCppScope.pop();
	const decl = cppClassDecl(s.name, currentCppBaseName, body);
	currentCppClassName = savedClass;
	currentCppBaseName = savedBase;
	return decl;
}

// [~] same split as ts2cpp's `tsTopLevel` -- a top-level `def`/`class`/assignment is real C++ file
// scope; a bare executable statement isn't.
function pyTopLevel(s: PY.Stmt): CPP.Definition[] {
	if (s.type === 'funcdef') {
		if (s.decorators.length)
			return toCppUnsupported('function decorator');
		pyCppScope.push(new Set(s.params.map(p => p.name).filter((n): n is string => !!n)));
		const body = cppBlock(s.body.flatMap(pyStmtToCpp));
		pyCppScope.pop();
		return [{
			type:		'function_def',
			specifiers:	simpleDeclSpec(pyTypeToSimple(s.returns)),
			declarator:	C.FunctionDecl(Identifier(s.name), s.params.map(pyParamToCpp)),
			body,
		} as unknown as CPP.Definition];
	}
	if (s.type === 'classdef')
		return [pyClassToCpp(s) as unknown as CPP.Definition];
	if (s.type === 'assign' || s.type === 'annassign')
		return pyStmtToCpp(s) as unknown as CPP.Definition[];
	return toCppUnsupported(`top-level '${s.type}' (only functions, classes, and variables convert at file scope)`);
}

export function py2cpp(source: string, opts?: CPPOptions): string {
	currentCppClassName = undefined;
	currentCppBaseName = undefined;
	pyCppScope = [new Set()];
	return new CPPOutput(opts).toCode({ type: 'translation_unit', body: PY.parse(source).body.flatMap(pyTopLevel) } as unknown as C.TranslationUnit);
}
