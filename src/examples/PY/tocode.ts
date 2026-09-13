import * as PY from './py-parser';
import { Module } from '../common';
import { Kinds } from './walker';
import { Printer } from '../walker';

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

export class Output implements Printer<Kinds> {
	opts;
	newline = '\n';
	comma	= ', ';

	constructor(opts: Options = {}) {
		this.opts	= {...DefaultOptions, ...opts};
		this.newline	= this.opts.newline;
		this.comma	= this.opts.spaceAfterComma ? ', ' : ',';
	}

	statements(stmts: readonly Stmt[]): string {
		return stmts.map(s => this.statement(s)).join(this.newline);
	}

	module(m: Module<Stmt>): string {
		return this.statements(m.body);
	}

	// ===================================================================
	//  Helpers
	// ===================================================================

	private op(o: string) { return this.opts.spaceAroundOps ? ' ' + o + ' ' : o; }

	indented(f: () => string) {
		const prev = this.newline;
		this.newline += this.opts.indent;
		const r = f();
		this.newline = prev;
		return r;
	}

	// A `:` header followed by an indented block of statements (Python's suite).
	private suite(body: Stmt[]): string {
		return ':' + this.indented(() => body.map(s => this.newline + this.statement(s)).join(''));
	}

	// `else` / `elif` tail. A lone `if` in the `orelse` prints back as `elif` -- CPython's own
	// unparser makes the same (irreversible either way) choice.
	private elseChain(alternate?: Stmt[]): string {
		if (!alternate || alternate.length === 0)
			return '';
		if (alternate.length === 1 && alternate[0].type === 'if') {
			const e = alternate[0];
			return this.newline + 'elif ' + this.expression(e.test) + this.suite(e.consequent) + this.elseChain(e.alternate);
		}
		return this.newline + 'else' + this.suite(alternate);
	}
	private elseClause(orelse?: Stmt[]): string {
		return orelse?.length ? this.newline + 'else' + this.suite(orelse) : '';
	}

	// ===================================================================
	//  Statements
	// ===================================================================

	private decorators(list: Expr[]): string {
		return list.map(d => '@' + this.expression(d) + this.newline).join('');
	}

	statement(s: Stmt): string {
		switch (s.type) {
			case 'expression':		return this.exprList(s.expression);
			case 'assign':			return s.targets.map(t => this.exprList(t) + ' = ').join('') + this.exprList(s.value);
			case 'augassign':		return this.exprList(s.target) + ' ' + s.op + ' ' + this.exprList(s.value);
			case 'annassign':		return this.expression(s.target) + ': ' + this.expression(s.annotation) + maybe(s.value, v => ' = ' + this.exprList(v));
			case 'return':			return 'return' + maybe(s.argument, v => ' ' + this.exprList(v));
			case 'pass':			return 'pass';
			case 'break':			return 'break';
			case 'continue':		return 'continue';
			case 'throw':			return 'raise' + maybe(s.argument, e => ' ' + this.expression(e) + maybe(s.cause, c => ' from ' + this.expression(c)));
			case 'global':			return 'global ' + s.names.join(this.comma);
			case 'nonlocal':		return 'nonlocal ' + s.names.join(this.comma);
			case 'del':				return 'del ' + this.exprList(s.targets);
			case 'assert':			return 'assert ' + this.expression(s.test) + maybe(s.msg, m => this.comma + this.expression(m));
			case 'import':			return 'import ' + s.names.map(a => a.name + maybe(a.asname, n => ' as ' + n)).join(this.comma);
			case 'importfrom':		return 'from ' + '.'.repeat(s.level) + (s.module ?? '') + ' import '
				+ (s.names === '*' ? '*' : s.names.map(a => a.name + maybe(a.asname, n => ' as ' + n)).join(this.comma));
			case 'if':				return 'if ' + this.expression(s.test) + this.suite(s.consequent) + this.elseChain(s.alternate);
			case 'while':			return 'while ' + this.expression(s.test) + this.suite(s.body) + this.elseClause(s.orelse);
			case 'for':				return (s.is_async ? 'async ' : '') + 'for ' + this.exprList(s.target) + ' in ' + this.exprList(s.iter)
				+ this.suite(s.body) + this.elseClause(s.orelse);
			case 'with':			return (s.is_async ? 'async ' : '') + 'with '
				+ s.items.map(w => this.expression(w.context) + maybe(w.optional_vars, v => ' as ' + this.expression(v))).join(this.comma)
				+ this.suite(s.body);
			case 'try':				return 'try' + this.suite(s.body)
				+ s.handlers.map(h => this.newline + 'except' + (h.star ? '*' : '')
					+ maybe(h.type, t => ' ' + this.expression(t)) + maybe(h.param, n => ' as ' + n) + this.suite(h.body)).join('')
				+ this.elseClause(s.orelse)
				+ (s.finalizer.length ? this.newline + 'finally' + this.suite(s.finalizer) : '');
			case 'funcdef':			return this.decorators(s.decorators) + (s.is_async ? 'async ' : '') + 'def ' + s.name
				+ '(' + this.params(s.params) + ')' + maybe(s.returns, r => ' -> ' + this.expression(r)) + this.suite(s.body);
			case 'classdef':		return this.decorators(s.decorators) + 'class ' + s.name
				+ (s.bases.length ? '(' + s.bases.map(a => this.arg(a)).join(this.comma) + ')' : '') + this.suite(s.body);
		}
	}

	// ===================================================================
	//  Sub-shapes
	// ===================================================================

	private params(ps: PY.Param[], lambda = false): string {
		return ps.map(p => {
			switch (p.kind) {
				case 'slash':		return '/';
				case 'stardelim':	return '*';
				case 'star':		return '*' + (p.name ?? '') + maybe(p.annotation, a => ': ' + this.expression(a));
				case 'dstar':		return '**' + p.name + maybe(p.annotation, a => ': ' + this.expression(a));
				default: {
					const eq  = !lambda && p.annotation ? ' = ' : '=';
					return p.name
						+ (!lambda && p.annotation ? ': ' + this.expression(p.annotation) : '')
						+ maybe(p.default, d => eq + this.expression(d));
				}
			}
		}).join(this.comma);
	}

	private arg(a: PY.Arg): string {
		switch (a.kind) {
			case 'kw':		return a.name + '=' + this.expression(a.value, TERNARY);
			case 'star':	return '*' + this.expression(a.value, UNARY);
			case 'dstar':	return '**' + this.expression(a.value, UNARY);
			default:		return this.expression(a.value, TERNARY);
		}
	}

	private comprehension(gens: PY.CompClause[]): string {
		return gens.map(c => c.type === 'for'
			? (c.is_async ? 'async ' : '') + 'for ' + this.exprList(c.target) + ' in ' + this.expression(c.iter, OR)
			: 'if ' + this.expression(c.test, OR)
		).join(' ');
	}

	private sliceStr(e: Expr): string {
		if (e.type === 'slice')
			return maybe(e.lower, l => this.expression(l)) + ':' + maybe(e.upper, u => this.expression(u)) + maybe(e.step, s => ':' + this.expression(s));
		if (e.type === 'tuple')
			return e.elements.map(x => this.sliceStr(x)).join(this.comma);
		return this.expression(e);
	}

	private fstring(parts: PY.FStringPart[]): string {
		const fstringField = (f: PY.FStringField) => '{'
			+ this.expression(f.expr) + (f.selfDoc ? '=' : '') + maybe(f.conv, c => '!' + c)
			+ (f.spec ? ':' + f.spec.map(s => typeof s === 'string' ? s : '{' + this.expression(s) + '}').join('') : '')
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
	private exprList(e: Expr): string {
		if (e.type === 'tuple')
			return e.elements.length === 0 ? '()'
				: e.elements.map(x => this.expression(x, TERNARY)).join(this.comma) + (e.elements.length === 1 ? ',' : '');
		return this.expression(e);
	}

	// ===================================================================
	//  Expressions
	// ===================================================================

	expression(e: Expr, minPrec = 0): string {
		return withParens(this.exprBody(e), exprPrecedence(e) < minPrec);
	}

	private exprBody(e: Expr): string {
		switch (e.type) {
			case 'identifier':		return e.name;
			case 'literal':
				return Array.isArray(e.value) ? this.fstring(e.value)
					: e.value === null ? 'None'
					: typeof e.value === 'boolean' ? (e.value ? 'True' : 'False')
					: typeof e.value === 'string' ? pyStr(e.value)
					: String(e.value);
			case 'imaginary':		return String(e.value) + 'j';
			case 'ellipsis':		return '...';
			case 'unary':			return e.operator === '!' ? 'not ' + this.expression(e.operand, NOT) : e.operator + this.expression(e.operand, UNARY);
			case 'binary': {
				const prec			= BINARY_PREC[e.operator] ?? ATOM;
				const rightAssoc	= e.operator === '**';
				return this.expression(e.left, rightAssoc ? prec + 1 : prec)
					+ (e.operator === '&&' ? ' and ' : e.operator === '||' ? ' or ' : this.op(e.operator))
					+ this.expression(e.right, rightAssoc ? prec : prec + 1);
			}
			case 'compare':			return this.expression(e.left, BOR) + e.ops.map((o, i) => ' ' + o + ' ' + this.expression(e.comparators[i], BOR)).join('');
			case 'conditional':		return this.expression(e.consequent, OR) + ' if ' + this.expression(e.test, OR) + ' else ' + this.expression(e.alternate, TERNARY);
			case 'lambda':			return 'lambda' + (e.params.length ? ' ' + this.params(e.params, true) : '') + ': ' + this.expression(e.body, LAMBDA);
			case 'namedexpr':		return e.target + ' := ' + this.expression(e.value, TERNARY);
			case 'spread':			return '*' + this.expression(e.operand, UNARY);
			case 'member':			return this.expression(e.object, POSTFIX) + '.' + e.property;
			case 'index':			return this.expression(e.object, POSTFIX) + '[' + this.sliceStr(e.index) + ']';
			case 'slice':			return this.sliceStr(e);	// only reached if a bare slice is printed on its own
			case 'call':			return this.expression(e.callee, POSTFIX) + '(' + e.arguments.map(a => this.arg(a)).join(this.comma) + ')';
			case 'tuple':			return e.elements.length === 0 ? '()' : '(' + e.elements.map(x => this.expression(x, TERNARY)).join(this.comma) + (e.elements.length === 1 ? ',' : '') + ')';
			case 'list':			return '[' + e.elements.map(x => this.expression(x, TERNARY)).join(this.comma) + ']';
			case 'set':				return e.elements.length === 0 ? 'set()' : '{' + e.elements.map(x => this.expression(x, TERNARY)).join(this.comma) + '}';
			case 'dict':			return '{' + e.keys.map((k, i) => k === null
				? '**' + this.expression(e.values[i], OR)
				: this.expression(k, TERNARY) + ': ' + this.expression(e.values[i], TERNARY)).join(this.comma) + '}';
			case 'genexp':			return '(' + this.expression(e.elt, TERNARY) + ' ' + this.comprehension(e.gens) + ')';
			case 'listcomp':		return '[' + this.expression(e.elt, TERNARY) + ' ' + this.comprehension(e.gens) + ']';
			case 'setcomp':			return '{' + this.expression(e.elt, TERNARY) + ' ' + this.comprehension(e.gens) + '}';
			case 'dictcomp':		return '{' + this.expression(e.key, TERNARY) + ': ' + this.expression(e.value, TERNARY) + ' ' + this.comprehension(e.gens) + '}';
			case 'await':			return 'await ' + this.expression(e.operand, AWAIT);
			case 'yield':			return e.from ? 'yield from ' + this.expression(e.from) : e.operand ? 'yield ' + this.exprList(e.operand) : 'yield';
		}
	}
}
