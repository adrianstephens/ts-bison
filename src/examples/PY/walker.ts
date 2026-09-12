import * as PY from './py-parser';
import { Module } from '../common';
import * as W from '../walker';
import {mapObject, mapArrayA, mapDefined, makeProcess, makeProcessB} from '../walker';

// ===================================================================
//  Type guards
// ===================================================================
// Python's AST has only two node domains -- statements and expressions -- so this walker is a
// trimmed-down version of TS/walker.ts (no separate Type / declarator domains). The `guard` helper
// and the `walk` / `walkB` machinery are otherwise the same shape.

export function guard<R>(types: string[]) {
	const set = new Set(types);
	return (node: any): node is R => node && typeof node === 'object' && 'type' in node && set.has(node.type);
}

const exprTags = [
	'identifier', 'literal', 'imaginary', 'ellipsis', 'unary', 'binary', 'compare', 'conditional', 'lambda',
	'namedexpr', 'spread', 'member', 'index', 'slice', 'call', 'tuple', 'list', 'set', 'dict',
	'genexp', 'listcomp', 'setcomp', 'dictcomp', 'await', 'yield', 'fstring',
];
const stmtTags = [
	'expression', 'assign', 'augassign', 'annassign', 'return', 'pass', 'break', 'continue', 'throw',
	'global', 'nonlocal', 'del', 'assert', 'import', 'importfrom', 'if', 'while', 'for', 'with',
	'try', 'funcdef', 'classdef',
];

export const isModule	= guard<Module<PY.Stmt>>(['module']);
export const isExpr		= guard<PY.Expr>(exprTags);
// `for` / `if` are also comprehension-clause tags -- those never appear as standalone nodes (only
// inside a comprehension's `gens`), so they're walked inline and left out of `stmtTags`.
export const isStmt		= guard<PY.Stmt>(stmtTags);

type Expr = PY.Expr;
type Stmt = PY.Stmt;
export interface Kinds { statement: Stmt; expression: Expr }

// ===================================================================
//  Constant folding
// ===================================================================
// Best-effort: returns `undefined` for anything it can't fold to a Python-faithful value (mixed
// types, division by zero, non-integer bit ops, matrix multiply, ...). Bitwise / shift use BigInt
// so they don't silently wrap at 32 bits the way raw JS operators would.

export function calcUnary(op: PY.unaryOps, x: unknown) {
	switch (op) {
		case '!':	return !x;
		case '+':	return typeof x === 'number' || typeof x === 'bigint' ? x : undefined;
		case '-':	return typeof x === 'number' ? -x : typeof x === 'bigint' ? -x : undefined;
		case '~':	return typeof x === 'bigint' ? ~x : Number.isInteger(x) ? ~(x as number) : undefined;
	}
}

function asBig(x: unknown): bigint | undefined {
	return typeof x === 'bigint' ? x : Number.isInteger(x) ? BigInt(x as number) : undefined;
}
const backToNum = (n: bigint) => n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;

export function calcBinary(op: PY.binaryOps, a: unknown, b: unknown): unknown {
	// `and`/`or` yield an operand (not a bool) in Python -- JS `&&`/`||` do the same.
	if (op === '&&')
		return a && b;
	if (op === '||')
		return a || b;

	if (op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>') {
		const x = asBig(a), y = asBig(b);
		if (x === undefined || y === undefined || ((op === '<<' || op === '>>') && y < 0n))
			return undefined;
		switch (op) {
			case '&':	return backToNum(x & y);
			case '|':	return backToNum(x | y);
			case '^':	return backToNum(x ^ y);
			case '<<':	return backToNum(x << y);
			case '>>':	return backToNum(x >> y);
		}
	}

	if (op === '+' && typeof a === 'string' && typeof b === 'string')
		return a + b;
	if (op === '*' && ((typeof a === 'string' && Number.isInteger(b)) || (typeof b === 'string' && Number.isInteger(a)))) {
		const [s, n] = typeof a === 'string' ? [a, b as number] : [b as string, a as number];
		return n > 0 ? s.repeat(n) : '';
	}

	const x = typeof a === 'bigint' ? Number(a) : a, y = typeof b === 'bigint' ? Number(b) : b;
	if (typeof x !== 'number' || typeof y !== 'number')
		return undefined;
	switch (op) {
		case '+':	return x + y;
		case '-':	return x - y;
		case '*':	return x * y;
		case '/':	return y === 0 ? undefined : x / y;						// Python `/` is always float
		case '//':	return y === 0 ? undefined : Math.floor(x / y);			// floor division
		case '%':	return y === 0 ? undefined : ((x % y) + y) % y;			// result takes the sign of `y`
		case '**':	return (x === 0 && y < 0) ? undefined : x ** y;
	}
}

// ===================================================================
//  walk -- immutable transform
// ===================================================================

export interface Walker extends W.Walker<Kinds> {
	statements:	(x: readonly Stmt[]) => Stmt[];
	module:		<M extends Module<Stmt>>(x: M) => M;
}
type OnAST<U>	= W.OnAST<U, Walker>;

export function walk(
	onStatement?:	OnAST<Stmt>,
	onExpression?:	OnAST<Expr>,
): Walker {

	const param			= (p: PY.Param): PY.Param => mapObject(p, {annotation: mapExpression, default: mapExpression});
	const arg   		= (a: PY.Arg): PY.Arg => mapObject(a, {value: mapExpressionA});

	const compClause	= (c: PY.CompClause): PY.CompClause =>
		c.type === 'for'	? mapObject(c, {target: mapExpressionA, iter: mapExpressionA})
							: mapObject(c, {test: mapExpressionA});

	const withItem		= (w: PY.WithItem): PY.WithItem => mapObject(w, {context: mapExpressionA, optional_vars: mapExpression});
	const handler  		= (h: PY.ExceptHandler): PY.ExceptHandler => mapObject(h, {type: mapExpression, body: mapStmts});

	const expression = (e: Expr): Expr => {
		switch (e.type) {
			case 'unary':				return mapObject(e, {operand: mapExpressionA});
			case 'spread':				return mapObject(e, {operand: mapExpressionA});
			case 'await':				return mapObject(e, {operand: mapExpressionA});
			case 'binary':				return mapObject(e, {left: mapExpressionA, right: mapExpressionA});
			case 'compare':				return mapObject(e, {left: mapExpressionA, comparators: mapArrayA(mapExpressionA)});
			case 'conditional':			return mapObject(e, {test: mapExpressionA, consequent: mapExpressionA, alternate: mapExpressionA});
			case 'lambda':				return mapObject(e, {params: mapArrayA(param), body: mapExpressionA});
			case 'namedexpr':			return mapObject(e, {value: mapExpressionA});
			case 'member':				return mapObject(e, {object: mapExpressionA});
			case 'index':				return mapObject(e, {object: mapExpressionA, index: mapExpressionA});
			case 'slice':				return mapObject(e, {lower: mapExpression, upper: mapExpression, step: mapExpression});
			case 'call':				return mapObject(e, {callee: mapExpressionA, arguments: mapArrayA(arg)});
			case 'tuple':
			case 'list':
			case 'set':					return mapObject(e, {elements: mapArrayA(mapExpressionA)});
			case 'dict':				return mapObject(e, {
				keys:	ks => ks.map(k => k === null ? null : mapExpressionA(k)),
				values:	mapArrayA(mapExpressionA),
			});
			case 'genexp':
			case 'listcomp':
			case 'setcomp':				return mapObject(e, {elt: mapExpressionA, gens: mapArrayA(compClause)});
			case 'dictcomp':			return mapObject(e, {key: mapExpressionA, value: mapExpressionA, gens: mapArrayA(compClause)});
			case 'yield':				return mapObject(e, {operand: mapExpression, from: mapExpression});
			case 'literal':				return mapObject(e, {
				value: v => Array.isArray(v) ? v.map(p => 
					p.field ? {...p, field: mapObject(p.field, {expr: mapExpressionA, spec: mapArrayA(s => typeof s === 'string' ? s : mapExpressionA(s))})} : p
				) : v
			});
			// identifier / literal / imaginary / ellipsis -- no nested AST
			default:					return e;
		}
	};

	const statement = (s: Stmt): Stmt => {
		switch (s.type) {
			case 'expression':			return mapObject(s, {expression: mapExpressionA});
			case 'assign':				return mapObject(s, {targets: mapArrayA(mapExpressionA), value: mapExpressionA});
			case 'augassign':			return mapObject(s, {target: mapExpressionA, value: mapExpressionA});
			case 'annassign':			return mapObject(s, {target: mapExpressionA, annotation: mapExpressionA, value: mapExpression});
			case 'return':				return mapObject(s, {argument: mapExpression});
			case 'throw':				return mapObject(s, {argument: mapExpression, cause: mapExpression});
			case 'del':					return mapObject(s, {targets: mapExpressionA});
			case 'assert':				return mapObject(s, {test: mapExpressionA, msg: mapExpression});
			case 'if':					return mapObject(s, {test: mapExpressionA, consequent: mapStmts, alternate: mapStmts});
			case 'while':				return mapObject(s, {test: mapExpressionA, body: mapStmts, orelse: mapStmts});
			case 'for':					return mapObject(s, {target: mapExpressionA, iter: mapExpressionA, body: mapStmts, orelse: mapStmts});
			case 'with':				return mapObject(s, {items: mapArrayA(withItem), body: mapStmts});
			case 'try':					return mapObject(s, {body: mapStmts, handlers: mapArrayA(handler), orelse: mapStmts, finalizer: mapStmts});
			case 'funcdef':				return mapObject(s, {
				params:		mapArrayA(param),
				returns:	mapExpression,
				decorators:	mapArrayA(mapExpressionA),
				body:		mapStmts,
			});
			case 'classdef':			return mapObject(s, {bases: mapArrayA(arg), decorators: mapArrayA(mapExpressionA), body: mapStmts});
			// pass / break / continue / global / nonlocal / import / importfrom -- no nested Expr / Stmt
			default:					return s;
		}
	};

	const recurse: Walker = {
		statement:	x => mapStatement(x),
		expression:	x => mapExpression(x),
		statements:	x => mapStmts(x),
		module:		x => ({...x, body: mapStmts(x.body)}),
	};

	const mapStatement		= makeProcess(statement, onStatement, recurse, true);
	const mapExpression		= makeProcess(expression, onExpression, recurse);
	const mapExpressionA	= mapDefined(mapExpression);
	const mapStmts			= mapArrayA(mapStatement);

	return recurse;
}

// ===================================================================
//  walkB -- boolean short-circuit search
// ===================================================================

export interface WalkerB extends W.WalkerB<Kinds> {
	statements:	(x: readonly Stmt[]) => boolean;
}
type OnASTB<U>	= W.OnASTB<U, WalkerB>;

export function walkB(
	onStatement?:	OnASTB<Stmt>,
	onExpression?:	OnASTB<Expr>,
): WalkerB {

	const param 		= (p: PY.Param) => walkExpression(p.annotation) || walkExpression(p.default);
	const arg   		= (a: PY.Arg) => walkExpression(a.value);
	const compClause	= (c: PY.CompClause) => c.type === 'for' ? walkExpression(c.target) || walkExpression(c.iter) : walkExpression(c.test);
	const withItem 		= (w: PY.WithItem) => walkExpression(w.context) || walkExpression(w.optional_vars);
	const handler		= (h: PY.ExceptHandler) => walkExpression(h.type) || h.body.some(walkStatement);

	const expression = (e: Expr): boolean => {
		switch (e.type) {
			case 'literal':				return Array.isArray(e.value) && e.value.some(p => !!p.field && (walkExpression(p.field.expr) || !!p.field.spec?.some(s => typeof s !== 'string' && walkExpression(s))));
			case 'unary':				return walkExpression(e.operand);
			case 'spread':				return walkExpression(e.operand);
			case 'await':				return walkExpression(e.operand);
			case 'binary':				return walkExpression(e.left) || walkExpression(e.right);
			case 'compare':				return walkExpression(e.left) || e.comparators.some(walkExpression);
			case 'conditional':			return walkExpression(e.test) || walkExpression(e.consequent) || walkExpression(e.alternate);
			case 'lambda':				return e.params.some(param) || walkExpression(e.body);
			case 'namedexpr':			return walkExpression(e.value);
			case 'member':				return walkExpression(e.object);
			case 'index':				return walkExpression(e.object) || walkExpression(e.index);
			case 'slice':				return walkExpression(e.lower) || walkExpression(e.upper) || walkExpression(e.step);
			case 'call':				return walkExpression(e.callee) || e.arguments.some(arg);
			case 'tuple':
			case 'list':
			case 'set':					return e.elements.some(walkExpression);
			case 'dict':				return e.keys.some(k => k !== null && walkExpression(k)) || e.values.some(walkExpression);
			case 'genexp':
			case 'listcomp':
			case 'setcomp':				return walkExpression(e.elt) || e.gens.some(compClause);
			case 'dictcomp':			return walkExpression(e.key) || walkExpression(e.value) || e.gens.some(compClause);
			case 'yield':				return walkExpression(e.operand) || walkExpression(e.from);
			default:					return false;
		}
	};

	const statement = (s: Stmt): boolean => {
		switch (s.type) {
			case 'expression':			return walkExpression(s.expression);
			case 'assign':				return s.targets.some(walkExpression) || walkExpression(s.value);
			case 'augassign':			return walkExpression(s.target) || walkExpression(s.value);
			case 'annassign':			return walkExpression(s.target) || walkExpression(s.annotation) || walkExpression(s.value);
			case 'return':				return walkExpression(s.argument);
			case 'throw':				return walkExpression(s.argument) || walkExpression(s.cause);
			case 'del':					return walkExpression(s.targets);
			case 'assert':				return walkExpression(s.test) || walkExpression(s.msg);
			case 'if':					return walkExpression(s.test) || s.consequent.some(walkStatement) || !!s.alternate?.some(walkStatement);
			case 'while':				return walkExpression(s.test) || s.body.some(walkStatement) || !!s.orelse?.some(walkStatement);
			case 'for':					return walkExpression(s.target) || walkExpression(s.iter) || s.body.some(walkStatement) || s.orelse.some(walkStatement);
			case 'with':				return s.items.some(withItem) || s.body.some(walkStatement);
			case 'try':					return s.body.some(walkStatement) || s.handlers.some(handler) || s.orelse.some(walkStatement) || s.finalizer.some(walkStatement);
			case 'funcdef':				return s.params.some(param) || walkExpression(s.returns) || s.decorators.some(walkExpression) || s.body.some(walkStatement);
			case 'classdef':			return s.bases.some(arg) || s.decorators.some(walkExpression) || s.body.some(walkStatement);
			default:					return false;
		}
	};

	const recurse: WalkerB = {
		statement:	x => walkStatement(x),
		expression:	x => walkExpression(x),
		statements:	x => x.some(walkStatement),
	};

	const walkStatement		= makeProcessB(statement, onStatement, recurse, true);
	const walkExpression	= makeProcessB(expression, onExpression, recurse);

	return recurse;
}
