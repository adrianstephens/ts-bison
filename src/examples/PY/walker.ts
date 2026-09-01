import * as PY from './py-parser';

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
	'identifier', 'literal', 'imaginary', 'ellipsis', 'unary', 'binary', 'compare', 'ifexp', 'lambda',
	'namedexpr', 'starred', 'attr', 'subscript', 'slice', 'call', 'tuple', 'list', 'set', 'dict',
	'genexp', 'listcomp', 'setcomp', 'dictcomp', 'await', 'yield', 'fstring',
];
const stmtTags = [
	'expr', 'assign', 'augassign', 'annassign', 'return', 'pass', 'break', 'continue', 'raise',
	'global', 'nonlocal', 'del', 'assert', 'import', 'importfrom', 'if', 'while', 'for', 'with',
	'try', 'funcdef', 'classdef',
];

export const isModule	= guard<PY.Module>(['module']);
export const isExpr		= guard<PY.Expr>(exprTags);
// `for` / `if` are also comprehension-clause tags -- those never appear as standalone nodes (only
// inside a comprehension's `gens`), so they're walked inline and left out of `stmtTags`.
export const isStmt		= guard<PY.Stmt>(stmtTags);

type Expr = PY.Expr;
type Stmt = PY.Stmt;
export type Walkable = Stmt | Expr | PY.Module | Stmt[];

// ===================================================================
//  Constant folding
// ===================================================================
// Best-effort: returns `undefined` for anything it can't fold to a Python-faithful value (mixed
// types, division by zero, non-integer bit ops, matrix multiply, ...). Bitwise / shift use BigInt
// so they don't silently wrap at 32 bits the way raw JS operators would.

export function calcUnary(op: PY.unaryOps, x: unknown) {
	switch (op) {
		case 'not':	return !x;
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
	if (op === 'and')
		return a && b;
	if (op === 'or')
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

type Recurse	= <T extends Stmt | Expr>(x: T) => T | undefined;
type OnAST<U>	= (x: U, process: <T extends U>(x: T) => T, recurse: Recurse) => U | undefined;

function makeProcess<U>(parts: (x: U) => U, on: OnAST<U> | undefined, recurse: Recurse, always = false) {
	return	on		? <T extends U>(t?: T) => t ? on(t, <T extends U>(t: T) => parts(t) as T, recurse) as T | undefined : undefined
		:	always	? <T extends U>(t?: T) => t ? parts(t) as T : undefined
					: <T extends U>(t?: T) => t;
}

function mapArrayA<T>(map: (x: T) => T | undefined) {
	return (x: readonly T[]): T[] => x.map(map).filter(i => i !== undefined);
}
function mapDefined<T>(map: (x: T) => T | undefined) {
	return (x: T) => {
		const r = map(x);
		if (r === undefined)
			throw new Error('walk: mapper deleted a required node');
		return r;
	};
}

type NodeMap<N> = Partial<{[K in keyof N]: (x: Exclude<N[K], undefined>) => Exclude<N[K], undefined> | undefined}>;

function mapObject<N extends Record<string, any>>(node: N, fields: NodeMap<N>): N {
	const r = {...node};
	for (const f in fields) {
		const k = f as keyof N;
		if (node[k] !== undefined) {
			const ret = fields[k]?.(node[k]);
			if (ret !== undefined)
				r[k] = ret;
			else
				delete r[k];
		}
	}
	return r;
}

export function walk<T extends Walkable>(ast: T,
	onStatement?:	OnAST<Stmt>,
	onExpression?:	OnAST<Expr>,
): T | undefined {

	const param = (p: PY.Param): PY.Param => mapObject(p, {annotation: mapExpression, default: mapExpression});
	const arg   = (a: PY.Arg): PY.Arg => mapObject(a, {value: mapExpressionA});

	const compClause = (c: PY.CompClause): PY.CompClause =>
		c.type === 'for'	? mapObject(c, {target: mapExpressionA, iter: mapExpressionA})
							: mapObject(c, {test: mapExpressionA});

	const withItem = (w: PY.WithItem): PY.WithItem => mapObject(w, {context: mapExpressionA, optional_vars: mapExpression});
	const handler  = (h: PY.ExceptHandler): PY.ExceptHandler => mapObject(h, {type: mapExpression, body: mapStmts});

	const specPart = (s: PY.FStringSpecPart): PY.FStringSpecPart =>
		'expr' in s ? {expr: mapExpressionA(s.expr)} : s;
	const fstringPart = (p: PY.FStringPart): PY.FStringPart =>
		p.field ? {...p, field: mapObject(p.field, {expr: mapExpressionA, spec: mapArrayA(specPart)})} : p;

	const expression = (e: Expr): Expr => {
		switch (e.type) {
			case 'unary':				return mapObject(e, {operand: mapExpressionA});
			case 'starred':
			case 'await':				return mapObject(e, {value: mapExpressionA});
			case 'binary':				return mapObject(e, {left: mapExpressionA, right: mapExpressionA});
			case 'compare':				return mapObject(e, {left: mapExpressionA, comparators: mapArrayA(mapExpressionA)});
			case 'ifexp':				return mapObject(e, {test: mapExpressionA, body: mapExpressionA, orelse: mapExpressionA});
			case 'lambda':				return mapObject(e, {params: mapArrayA(param), body: mapExpressionA});
			case 'namedexpr':			return mapObject(e, {value: mapExpressionA});
			case 'attr':				return mapObject(e, {value: mapExpressionA});
			case 'subscript':			return mapObject(e, {value: mapExpressionA, slice: mapExpressionA});
			case 'slice':				return mapObject(e, {lower: mapExpression, upper: mapExpression, step: mapExpression});
			case 'call':				return mapObject(e, {func: mapExpressionA, args: mapArrayA(arg)});
			case 'tuple':
			case 'list':
			case 'set':					return mapObject(e, {elts: mapArrayA(mapExpressionA)});
			case 'dict':				return mapObject(e, {
				keys:	ks => ks.map(k => k === null ? null : mapExpressionA(k)),
				values:	mapArrayA(mapExpressionA),
			});
			case 'genexp':
			case 'listcomp':
			case 'setcomp':				return mapObject(e, {elt: mapExpressionA, gens: mapArrayA(compClause)});
			case 'dictcomp':			return mapObject(e, {key: mapExpressionA, value: mapExpressionA, gens: mapArrayA(compClause)});
			case 'yield':				return mapObject(e, {value: mapExpression, from: mapExpression});
			case 'fstring':				return mapObject(e, {parts: mapArrayA(fstringPart)});
			// identifier / literal / imaginary / ellipsis -- no nested AST
			default:					return e;
		}
	};

	const statement = (s: Stmt): Stmt => {
		switch (s.type) {
			case 'expr':				return mapObject(s, {value: mapExpressionA});
			case 'assign':				return mapObject(s, {targets: mapArrayA(mapExpressionA), value: mapExpressionA});
			case 'augassign':			return mapObject(s, {target: mapExpressionA, value: mapExpressionA});
			case 'annassign':			return mapObject(s, {target: mapExpressionA, annotation: mapExpressionA, value: mapExpression});
			case 'return':				return mapObject(s, {value: mapExpression});
			case 'raise':				return mapObject(s, {exc: mapExpression, cause: mapExpression});
			case 'del':					return mapObject(s, {targets: mapExpressionA});
			case 'assert':				return mapObject(s, {test: mapExpressionA, msg: mapExpression});
			case 'if':
			case 'while':				return mapObject(s, {test: mapExpressionA, body: mapStmts, orelse: mapStmts} as NodeMap<typeof s>);
			case 'for':					return mapObject(s, {target: mapExpressionA, iter: mapExpressionA, body: mapStmts, orelse: mapStmts});
			case 'with':				return mapObject(s, {items: mapArrayA(withItem), body: mapStmts});
			case 'try':					return mapObject(s, {body: mapStmts, handlers: mapArrayA(handler), orelse: mapStmts, finalbody: mapStmts});
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

	const recurse: Recurse = x => (isStmt(x) ? mapStatement(x) : mapExpression(x)) as typeof x;

	const mapStatement	= makeProcess(statement, onStatement, recurse, true);
	const mapExpression	= makeProcess(expression, onExpression, recurse);
	const mapExpressionA	= mapDefined(mapExpression);
	const mapStmts		= mapArrayA(mapStatement);

	if (isModule(ast))
		return {...ast, body: mapStmts(ast.body)} as T;
	if (Array.isArray(ast))
		return mapStmts(ast) as T;
	return recurse(ast as Stmt | Expr) as T;
}

// ===================================================================
//  walkB -- boolean short-circuit search
// ===================================================================

type RecurseB	= (x: Stmt | Expr | undefined) => boolean;
type OnASTB<U>	= (x: U, process: (x: U) => boolean, recurse: RecurseB) => boolean;

function makeProcessB<U>(parts: (x: U) => boolean, on: OnASTB<U> | undefined, recurse: RecurseB, always = false) {
	return	on		? (t?: U) => t ? on(t, (t: U) => parts(t), recurse) : false
		:	always	? (t?: U) => t ? parts(t) : false
					: (_?: U) => false;
}

export function walkB<T extends Walkable>(ast: T,
	onStatement?:	OnASTB<Stmt>,
	onExpression?:	OnASTB<Expr>,
): boolean {

	const param = (p: PY.Param) => walkExpression(p.annotation) || walkExpression(p.default);
	const arg   = (a: PY.Arg) => walkExpression(a.value);
	const compClause = (c: PY.CompClause) => c.type === 'for' ? walkExpression(c.target) || walkExpression(c.iter) : walkExpression(c.test);
	const withItem = (w: PY.WithItem) => walkExpression(w.context) || walkExpression(w.optional_vars);
	const handler = (h: PY.ExceptHandler) => walkExpression(h.type) || h.body.some(walkStatement);
	const fstringPart = (p: PY.FStringPart) => !!p.field && (walkExpression(p.field.expr) || !!p.field.spec?.some(s => 'expr' in s && walkExpression(s.expr)));

	const expression = (e: Expr): boolean => {
		switch (e.type) {
			case 'unary':				return walkExpression(e.operand);
			case 'starred':
			case 'await':				return walkExpression(e.value);
			case 'binary':				return walkExpression(e.left) || walkExpression(e.right);
			case 'compare':				return walkExpression(e.left) || e.comparators.some(walkExpression);
			case 'ifexp':				return walkExpression(e.test) || walkExpression(e.body) || walkExpression(e.orelse);
			case 'lambda':				return e.params.some(param) || walkExpression(e.body);
			case 'namedexpr':
			case 'attr':				return walkExpression(e.value);
			case 'subscript':			return walkExpression(e.value) || walkExpression(e.slice);
			case 'slice':				return walkExpression(e.lower) || walkExpression(e.upper) || walkExpression(e.step);
			case 'call':				return walkExpression(e.func) || e.args.some(arg);
			case 'tuple':
			case 'list':
			case 'set':					return e.elts.some(walkExpression);
			case 'dict':				return e.keys.some(k => k !== null && walkExpression(k)) || e.values.some(walkExpression);
			case 'genexp':
			case 'listcomp':
			case 'setcomp':				return walkExpression(e.elt) || e.gens.some(compClause);
			case 'dictcomp':			return walkExpression(e.key) || walkExpression(e.value) || e.gens.some(compClause);
			case 'yield':				return walkExpression(e.value) || walkExpression(e.from);
			case 'fstring':				return e.parts.some(fstringPart);
			default:					return false;
		}
	};

	const statement = (s: Stmt): boolean => {
		switch (s.type) {
			case 'expr':				return walkExpression(s.value);
			case 'assign':				return s.targets.some(walkExpression) || walkExpression(s.value);
			case 'augassign':			return walkExpression(s.target) || walkExpression(s.value);
			case 'annassign':			return walkExpression(s.target) || walkExpression(s.annotation) || walkExpression(s.value);
			case 'return':				return walkExpression(s.value);
			case 'raise':				return walkExpression(s.exc) || walkExpression(s.cause);
			case 'del':					return walkExpression(s.targets);
			case 'assert':				return walkExpression(s.test) || walkExpression(s.msg);
			case 'if':
			case 'while':				return walkExpression(s.test) || s.body.some(walkStatement) || s.orelse.some(walkStatement);
			case 'for':					return walkExpression(s.target) || walkExpression(s.iter) || s.body.some(walkStatement) || s.orelse.some(walkStatement);
			case 'with':				return s.items.some(withItem) || s.body.some(walkStatement);
			case 'try':					return s.body.some(walkStatement) || s.handlers.some(handler) || s.orelse.some(walkStatement) || s.finalbody.some(walkStatement);
			case 'funcdef':				return s.params.some(param) || walkExpression(s.returns) || s.decorators.some(walkExpression) || s.body.some(walkStatement);
			case 'classdef':			return s.bases.some(arg) || s.decorators.some(walkExpression) || s.body.some(walkStatement);
			default:					return false;
		}
	};

	const recurse: RecurseB = x => !x ? false : isStmt(x) ? walkStatement(x) : walkExpression(x);

	const walkStatement		= makeProcessB(statement, onStatement, recurse, true);
	const walkExpression	= makeProcessB(expression, onExpression, recurse);

	if (isModule(ast))
		return ast.body.some(walkStatement);
	if (Array.isArray(ast))
		return ast.some(walkStatement);
	return recurse(ast as Stmt | Expr);
}
