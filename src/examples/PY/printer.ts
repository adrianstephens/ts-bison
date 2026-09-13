import * as PY from './py-parser';
import { Module } from '../common';

type Expr = PY.Expr;
type Stmt = PY.Stmt;

const DefaultOptions = {
	newline:			'\n',
	indent:				'    ',
	spaceAroundOps:		true,
	spaceAfterComma:	true,
};
export type Options = Partial<typeof DefaultOptions>;

// ===================================================================
//  Precedence
// ===================================================================
// Python's expression nodes carry no "parenthesised" wrapper, so producing valid source means
// recomputing from each node whether its children need parens. Numbered low -> high, matching the
// language reference's operator table.

const LAMBDA = 1, TERNARY = 2, OR = 3, AND = 4, NOT = 5, COMPARE = 6, BOR = 7;
const BXOR = 8, BAND = 9, SHIFT = 10, ADD = 11, MUL = 12, UNARY = 13, POW = 14, AWAIT = 15, POSTFIX = 16, ATOM = 17;

const BINARY_PREC: Record<string, number> = {
	'||':	OR,
	'&&':	AND,
	'|': 	BOR,
	'^': 	BXOR,
	'&': 	BAND,
	'<<': 	SHIFT,
	'>>': 	SHIFT,
	'+': 	ADD,
	'-': 	ADD,
	'*': 	MUL,
	'/': 	MUL,
	'//': 	MUL,
	'%': 	MUL,
	'@': 	MUL,
	'**': 	POW,
};

function exprPrecedence(e: Expr): number {
	switch (e.type) {
		case 'lambda':
		case 'namedexpr':
		case 'yield':			return LAMBDA;
		case 'conditional':		return TERNARY;
		case 'binary':			return BINARY_PREC[e.operator] ?? ATOM;
		case 'compare':			return COMPARE;
		case 'unary':			return e.operator === '!' ? NOT : UNARY;
		case 'spread':			return UNARY;
		case 'await':			return AWAIT;
		case 'call':
		case 'member':
		case 'index':			return POSTFIX;
		default:				return ATOM;	// identifier / literal / imaginary / ellipsis / tuple / list / set / dict / comprehensions
	}
}

function withParens(s: string, wrap: boolean) { return wrap ? '(' + s + ')' : s; }
function maybe<T>(v: T, f: (v: NonNullable<T>) => string) { return v ? f(v as NonNullable<T>) : ''; }

// Re-quote a string `Literal` value. The parser now decodes escapes into the real string (matching
// js-parser.ts's/c-parser.ts's own convention), so this has to re-escape backslashes and whichever
// quote character it picks -- a literal embedded newline is the one thing left un-escaped, since a
// triple-quoted string can hold one directly (picking whichever triple-quote style isn't already present).
function pyStr(v: string): string {
	const esc = v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
	if (!v.includes('\n')) {
		const quote = !esc.includes('"') ? '"' : !esc.includes("'") ? "'" : '"';
		return quote + esc.split(quote).join('\\' + quote) + quote;
	}
	return	!esc.includes('"""')	? '"""' + esc + '"""'
		:	!esc.includes("'''")	? "'''" + esc + "'''"
		:	'"""' + esc.replace(/"/g, '\\"') + '"""';
}

export function printer(opts1: Options = {}) {
	const opts	= {...DefaultOptions, ...opts1};
	let	newline	= opts.newline;
	const  comma	= opts.spaceAfterComma ? ', ' : ',';

	function statements(stmts: readonly Stmt[]): string {
		return stmts.map(s => statement(s)).join(newline);
	}

	function module(m: Module<Stmt>): string {
		return statements(m.body);
	}

	// ===================================================================
	//  Helpers
	// ===================================================================

	function op(o: string) { return opts.spaceAroundOps ? ' ' + o + ' ' : o; }

	function indented(f: () => string) {
		const prev = newline;
		newline += opts.indent;
		const r = f();
		newline = prev;
		return r;
	}

	// A `:` header followed by an indented block of statements (Python's suite).
	function suite(body: Stmt[]): string {
		return ':' + indented(() => body.map(s => newline + statement(s)).join(''));
	}

	// `else` / `elif` tail. A lone `if` in the `orelse` prints back as `elif` -- CPython's own
	// unparser makes the same (irreversible either way) choice.
	function elseChain(alternate?: Stmt[]): string {
		if (!alternate || alternate.length === 0)
			return '';
		if (alternate.length === 1 && alternate[0].type === 'if') {
			const e = alternate[0];
			return newline + 'elif ' + expression(e.test) + suite(e.consequent) + elseChain(e.alternate);
		}
		return newline + 'else' + suite(alternate);
	}
	function elseClause(orelse?: Stmt[]): string {
		return orelse?.length ? newline + 'else' + suite(orelse) : '';
	}

	// ===================================================================
	//  Statements
	// ===================================================================

	function decorators(list: Expr[]): string {
		return list.map(d => '@' + expression(d) + newline).join('');
	}

	function statement(s: Stmt): string {
		switch (s.type) {
			case 'expression':		return exprList(s.expression);
			case 'assign':			return s.targets.map(t => exprList(t) + ' = ').join('') + exprList(s.value);
			case 'augassign':		return exprList(s.target) + ' ' + s.op + ' ' + exprList(s.value);
			case 'annassign':		return expression(s.target) + ': ' + expression(s.annotation) + maybe(s.value, v => ' = ' + exprList(v));
			case 'return':			return 'return' + maybe(s.argument, v => ' ' + exprList(v));
			case 'pass':			return 'pass';
			case 'break':			return 'break';
			case 'continue':		return 'continue';
			case 'throw':			return 'raise' + maybe(s.argument, e => ' ' + expression(e) + maybe(s.cause, c => ' from ' + expression(c)));
			case 'global':			return 'global ' + s.names.join(comma);
			case 'nonlocal':		return 'nonlocal ' + s.names.join(comma);
			case 'del':				return 'del ' + exprList(s.targets);
			case 'assert':			return 'assert ' + expression(s.test) + maybe(s.msg, m => comma + expression(m));
			case 'import':			return 'import ' + s.names.map(a => a.name + maybe(a.asname, n => ' as ' + n)).join(comma);
			case 'importfrom':		return 'from ' + '.'.repeat(s.level) + (s.module ?? '') + ' import '
				+ (s.names === '*' ? '*' : s.names.map(a => a.name + maybe(a.asname, n => ' as ' + n)).join(comma));
			case 'if':				return 'if ' + expression(s.test) + suite(s.consequent) + elseChain(s.alternate);
			case 'while':			return 'while ' + expression(s.test) + suite(s.body) + elseClause(s.orelse);
			case 'for':				return (s.is_async ? 'async ' : '') + 'for ' + exprList(s.target) + ' in ' + exprList(s.iter)
				+ suite(s.body) + elseClause(s.orelse);
			case 'with':			return (s.is_async ? 'async ' : '') + 'with '
				+ s.items.map(w => expression(w.context) + maybe(w.optional_vars, v => ' as ' + expression(v))).join(comma)
				+ suite(s.body);
			case 'try':				return 'try' + suite(s.body)
				+ s.handlers.map(h => newline + 'except' + (h.star ? '*' : '')
					+ maybe(h.type, t => ' ' + expression(t)) + maybe(h.param, n => ' as ' + n) + suite(h.body)).join('')
				+ elseClause(s.orelse)
				+ (s.finalizer.length ? newline + 'finally' + suite(s.finalizer) : '');
			case 'funcdef':			return decorators(s.decorators) + (s.is_async ? 'async ' : '') + 'def ' + s.name
				+ '(' + params(s.params) + ')' + maybe(s.returns, r => ' -> ' + expression(r)) + suite(s.body);
			case 'classdef':		return decorators(s.decorators) + 'class ' + s.name
				+ (s.bases.length ? '(' + s.bases.map(a => arg(a)).join(comma) + ')' : '') + suite(s.body);
		}
	}

	// ===================================================================
	//  Sub-shapes
	// ===================================================================

	function params(ps: PY.Param[], lambda = false): string {
		return ps.map(p => {
			switch (p.kind) {
				case 'slash':		return '/';
				case 'stardelim':	return '*';
				case 'star':		return '*' + (p.name ?? '') + maybe(p.annotation, a => ': ' + expression(a));
				case 'dstar':		return '**' + p.name + maybe(p.annotation, a => ': ' + expression(a));
				default: {
					const eq  = !lambda && p.annotation ? ' = ' : '=';
					return p.name
						+ (!lambda && p.annotation ? ': ' + expression(p.annotation) : '')
						+ maybe(p.default, d => eq + expression(d));
				}
			}
		}).join(comma);
	}

	function arg(a: PY.Arg): string {
		switch (a.kind) {
			case 'kw':		return a.name + '=' + expression(a.value, TERNARY);
			case 'star':	return '*' + expression(a.value, UNARY);
			case 'dstar':	return '**' + expression(a.value, UNARY);
			default:		return expression(a.value, TERNARY);
		}
	}

	function comprehension(gens: PY.CompClause[]): string {
		return gens.map(c => c.type === 'for'
			? (c.is_async ? 'async ' : '') + 'for ' + exprList(c.target) + ' in ' + expression(c.iter, OR)
			: 'if ' + expression(c.test, OR)
		).join(' ');
	}

	function sliceStr(e: Expr): string {
		if (e.type === 'slice')
			return maybe(e.lower, l => expression(l)) + ':' + maybe(e.upper, u => expression(u)) + maybe(e.step, s => ':' + expression(s));
		if (e.type === 'tuple')
			return e.elements.map(x => sliceStr(x)).join(comma);
		return expression(e);
	}

	function fstring(parts: PY.FStringPart[]): string {
		const fstringField = (f: PY.FStringField) => '{'
			+ expression(f.expr) + (f.selfDoc ? '=' : '') + maybe(f.conv, c => '!' + c)
			+ (f.spec ? ':' + f.spec.map(s => typeof s === 'string' ? s : '{' + expression(s) + '}').join('') : '')
			+ '}';
		const body		= parts.map(p => p.text + (p.field ? fstringField(p.field) : '')).join('');
		const single	= !body.includes('\n') && (!body.includes('"') ? '"' : !body.includes("'") ? "'" : '');
		return single ? 'f' + single + body + single
			: !body.includes('"""') ? 'f"""' + body + '"""'
			: !body.includes("'''") ? "f'''" + body + "'''"
			: 'f"""' + body.replace(/"/g, '\\"') + '"""';
	}

	// Bare (unparenthesised) tuple where the context allows it -- assignment sides, `return`, `del`,
	// `for` targets, expression statements.
	function exprList(e: Expr): string {
		if (e.type === 'tuple')
			return e.elements.length === 0 ? '()'
				: e.elements.map(x => expression(x, TERNARY)).join(comma) + (e.elements.length === 1 ? ',' : '');
		return expression(e);
	}

	// ===================================================================
	//  Expressions
	// ===================================================================

	function expression(e: Expr, minPrec = 0): string {
		return withParens(exprBody(e), exprPrecedence(e) < minPrec);
	}

	function exprBody(e: Expr): string {
		switch (e.type) {
			case 'identifier':		return e.name;
			case 'literal':
				return Array.isArray(e.value) ? fstring(e.value)
					: e.value === null ? 'None'
					: typeof e.value === 'boolean' ? (e.value ? 'True' : 'False')
					: typeof e.value === 'string' ? pyStr(e.value)
					: String(e.value);
			case 'imaginary':		return String(e.value) + 'j';
			case 'ellipsis':		return '...';
			case 'unary':			return e.operator === '!' ? 'not ' + expression(e.operand, NOT) : e.operator + expression(e.operand, UNARY);
			case 'binary': {
				const prec			= BINARY_PREC[e.operator] ?? ATOM;
				const rightAssoc	= e.operator === '**';
				return expression(e.left, rightAssoc ? prec + 1 : prec)
					+ (e.operator === '&&' ? ' and ' : e.operator === '||' ? ' or ' : op(e.operator))
					+ expression(e.right, rightAssoc ? prec : prec + 1);
			}
			case 'compare':			return expression(e.left, BOR) + e.ops.map((o, i) => ' ' + o + ' ' + expression(e.comparators[i], BOR)).join('');
			case 'conditional':		return expression(e.consequent, OR) + ' if ' + expression(e.test, OR) + ' else ' + expression(e.alternate, TERNARY);
			case 'lambda':			return 'lambda' + (e.params.length ? ' ' + params(e.params, true) : '') + ': ' + expression(e.body, LAMBDA);
			case 'namedexpr':		return e.target + ' := ' + expression(e.value, TERNARY);
			case 'spread':			return '*' + expression(e.operand, UNARY);
			case 'member':			return expression(e.object, POSTFIX) + '.' + e.property;
			case 'index':			return expression(e.object, POSTFIX) + '[' + sliceStr(e.index) + ']';
			case 'slice':			return sliceStr(e);	// only reached if a bare slice is printed on its own
			case 'call':			return expression(e.callee, POSTFIX) + '(' + e.arguments.map(a => arg(a)).join(comma) + ')';
			case 'tuple':			return e.elements.length === 0 ? '()' : '(' + e.elements.map(x => expression(x, TERNARY)).join(comma) + (e.elements.length === 1 ? ',' : '') + ')';
			case 'list':			return '[' + e.elements.map(x => expression(x, TERNARY)).join(comma) + ']';
			case 'set':				return e.elements.length === 0 ? 'set()' : '{' + e.elements.map(x => expression(x, TERNARY)).join(comma) + '}';
			case 'dict':			return '{' + e.keys.map((k, i) => k === null
				? '**' + expression(e.values[i], OR)
				: expression(k, TERNARY) + ': ' + expression(e.values[i], TERNARY)).join(comma) + '}';
			case 'genexp':			return '(' + expression(e.elt, TERNARY) + ' ' + comprehension(e.gens) + ')';
			case 'listcomp':		return '[' + expression(e.elt, TERNARY) + ' ' + comprehension(e.gens) + ']';
			case 'setcomp':			return '{' + expression(e.elt, TERNARY) + ' ' + comprehension(e.gens) + '}';
			case 'dictcomp':		return '{' + expression(e.key, TERNARY) + ': ' + expression(e.value, TERNARY) + ' ' + comprehension(e.gens) + '}';
			case 'await':			return 'await ' + expression(e.operand, AWAIT);
			case 'yield':			return e.from ? 'yield from ' + expression(e.from) : e.operand ? 'yield ' + exprList(e.operand) : 'yield';
		}
	}
	return {
		module,
		statement,
		expression,
		statements,
	};
}
