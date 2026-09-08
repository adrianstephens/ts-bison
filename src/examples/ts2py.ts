// PoC: TypeScript AST -> Python AST -> Python source.
// Marked [=] where the converged shapes let a node pass through unchanged or with only a retag,
// and [~] where a real language difference needed actual work.
import * as TS from './TS/ts-parser';
import * as JS from './TS/js-parser';
import * as PY from './PY/py-parser';
import { Output, Options } from './PY/tocode';
import { bodyOf, Identifier, Literal, Unary, Binary, Call, Member, Index, Conditional, Spread, Sequence, Await, Yield, ExprStmt, Return, Throw, If, While } from './common';

type E = PY.Expr;
type S = PY.Stmt;

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

// Keyed by the compound operator itself rather than derived from BINARY by stripping the `=`, so the
// exclusions are structu`&&=`/`||=` short-circuit (they are NOT `x = x and y`) and `>>>=` has no
// Python form, so simply having no entry is what makes them unsupported.
const AUGASSIGN: Partial<Record<JS.binaryOps, string>> = {
	'+=':	'+=',
	'-=':	'-=',
	'*=':	'*=',
	'/=':	'/=',
	'%=':	'%=',
	'**=':	'**=',
	'&=':	'&=',
	'|=':	'|=',
	'^=':	'^=',
	'<<=':	'<<=',
	'>>=':	'>>=',
};

const pos		= (value: E): PY.Arg => ({ kind: 'pos', value });
const compare	= (op: PY.compareOps, left: E, right: E): PY.Compare => ({ type: 'compare', left, ops: [op], comparators: [right] });
const call		= (fn: string, ...args: E[]): E => Call<E, PY.Arg>(Identifier(fn), args.map(pos));

export function expr(e: TS.Expr): E {
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
			return	e.callee.type === 'super'											? Call<E, PY.Arg>(Member(base(), '__init__'), [pos(Identifier('self')), ...args])
				:	e.callee.type === 'member' && e.callee.object.type === 'super'		? Call<E, PY.Arg>(Member(base(), e.callee.property), [pos(Identifier('self')), ...args])
				:	Call<E, PY.Arg>(expr(e.callee), args);
		}
		case 'new':			return Call<E, PY.Arg>(expr(e.callee), e.arguments.map(a => pos(expr(a))));

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

const keyExpr	= (k: JS.Key): E					=> typeof k === 'string' ? Literal(k) : expr(k.computed);
const keyName	= (k: JS.Key): string				=> typeof k !== 'string' ? unsupported('computed member name') : k === 'constructor' ? '__init__' : k;
const bindName	= (b: JS.BindingTarget): string 	=> typeof b === 'string' ? b : unsupported('destructuring');
const param		= (p: JS.Param<TS.Type>): PY.Param	=> ({ name: bindName(p.key), default: p.default && expr(p.default) });

// [~] JS models assignment as an expression; Python has assign/augassign statements
function exprStmt(e: TS.Expr): S {
	// [~] `i++` / `++i` are expressions in JS but have no Python form at all; in STATEMENT position
	// they are exactly `i += 1`, which is the only place this accepts them.
	if ((e.type === 'unary' || e.type === 'unary_post') && (e.operator === '++' || e.operator === '--'))
		return { type: 'augassign', target: expr(e.operand), op: e.operator === '++' ? '+=' : '-=', value: Literal(1) };
	if (e.type !== 'binary')
		return ExprStmt(expr(e));
	if (e.operator === '=')
		return { type: 'assign', targets: [expr(e.left)], value: expr(e.right) };
	const op = AUGASSIGN[e.operator];
	return op
		? { type: 'augassign', target: expr(e.left), op, value: expr(e.right) }
		: ExprStmt(expr(e));
}

// [=] bodyOf is what makes this one line instead of a block/single-statement branch
const body		= (b: TS.Stmt | readonly TS.Stmt[] | undefined): S[] => nonEmpty(bodyOf(b).flatMap(stmt));
// Python has no empty suite -- `pass` is the placeholder wherever a body would otherwise be blank.
const nonEmpty	= (body: S[]): S[] => body.length ? body : [{ type: 'pass' }];
const orelse	= (b: TS.Stmt | readonly TS.Stmt[] | undefined): S[] => b === undefined ? [] : body(b);

const isVarDecl	= (x: JS.ForInit<TS.Type>): x is JS.VarDecl<TS.Type> => x.type === 'var_decl';
const forTarget	= (init: JS.ForInit<TS.Type>): E => isVarDecl(init) ? Identifier(bindName(init.declarations[0].name)) : expr(init);

export function stmt(s: TS.Stmt): S[] {
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
function classMember(m: TS.ClassMember): S[] {
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
const typeExpr = (t: TS.Type): E =>
		t.type === 'ref'	? Identifier(PYTYPE[t.name] ?? t.name)
	:	t.type === 'array'	? Index(Identifier('list'), typeExpr(t.element))
	:	Identifier('object');

export function ts2py(source: string, opts?: Options): string {
	return new Output(opts).toCode(TS.parse(source).body.flatMap(stmt));
}
