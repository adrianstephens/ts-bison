import * as PY from './py-parser';
import { isModule, isStmt } from './walker';

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
	or: 	OR,
	and: 	AND,
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
		case 'unary':			return e.operator === 'not' ? NOT : UNARY;
		case 'spread':			return UNARY;
		case 'await':			return AWAIT;
		case 'call':
		case 'member':
		case 'index':			return POSTFIX;
		default:				return ATOM;	// identifier / literal / imaginary / ellipsis / tuple / list / set / dict / comprehensions / fstring
	}
}

function withParens(s: string, wrap: boolean) { return wrap ? '(' + s + ')' : s; }
function maybe<T>(v: T, f: (v: NonNullable<T>) => string) { return v ? f(v as NonNullable<T>) : ''; }

// Re-quote a string `Literal` value. The parser keeps the *raw* inner text (escapes not processed),
// so this must not re-escape either -- just pick a quote style the raw text doesn't already contain.
function pyStr(v: string): string {
	const single = !v.includes('\n') && (!v.includes('"') ? '"' : !v.includes("'") ? "'" : '');
	return single ? single + v + single
		: !v.includes('"""') ? '"""' + v + '"""'
		: !v.includes("'''") ? "'''" + v + "'''"
		: '"""' + v.replace(/"/g, '\\"') + '"""';
}

export class Output {
	opts;
	newline = '\n';
	comma	= ', ';

	constructor(opts: Options = {}) {
		this.opts	= {...DefaultOptions, ...opts};
		this.newline	= this.opts.newline;
		this.comma	= this.opts.spaceAfterComma ? ', ' : ',';
	}

	toCode(ast: PY.Module | Stmt | Stmt[] | Expr): string {
		if (isModule(ast))
			return ast.body.map(s => this.statement(s)).join(this.newline);
		if (Array.isArray(ast))
			return ast.map(s => this.statement(s)).join(this.newline);
		if (isStmt(ast))
			return this.statement(ast);
		return this.expr(ast);
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
	private elseChain(orelse: Stmt[]): string {
		if (orelse.length === 0)
			return '';
		if (orelse.length === 1 && orelse[0].type === 'if') {
			const e = orelse[0];
			return this.newline + 'elif ' + this.expr(e.test) + this.suite(e.body) + this.elseChain(e.orelse);
		}
		return this.newline + 'else' + this.suite(orelse);
	}
	private elseClause(orelse: Stmt[]): string {
		return orelse.length ? this.newline + 'else' + this.suite(orelse) : '';
	}

	// ===================================================================
	//  Statements
	// ===================================================================

	private decorators(list: Expr[]): string {
		return list.map(d => '@' + this.expr(d) + this.newline).join('');
	}

	statement(s: Stmt): string {
		switch (s.type) {
			case 'expression':		return this.exprList(s.expression);
			case 'assign':			return s.targets.map(t => this.exprList(t) + ' = ').join('') + this.exprList(s.value);
			case 'augassign':		return this.exprList(s.target) + ' ' + s.op + ' ' + this.exprList(s.value);
			case 'annassign':		return this.expr(s.target) + ': ' + this.expr(s.annotation) + maybe(s.value, v => ' = ' + this.exprList(v));
			case 'return':			return 'return' + maybe(s.argument, v => ' ' + this.exprList(v));
			case 'pass':			return 'pass';
			case 'break':			return 'break';
			case 'continue':		return 'continue';
			case 'throw':			return 'raise' + maybe(s.argument, e => ' ' + this.expr(e) + maybe(s.cause, c => ' from ' + this.expr(c)));
			case 'global':			return 'global ' + s.names.join(this.comma);
			case 'nonlocal':		return 'nonlocal ' + s.names.join(this.comma);
			case 'del':				return 'del ' + this.exprList(s.targets);
			case 'assert':			return 'assert ' + this.expr(s.test) + maybe(s.msg, m => this.comma + this.expr(m));
			case 'import':			return 'import ' + s.names.map(a => a.name + maybe(a.asname, n => ' as ' + n)).join(this.comma);
			case 'importfrom':		return 'from ' + '.'.repeat(s.level) + (s.module ?? '') + ' import '
				+ (s.names === '*' ? '*' : s.names.map(a => a.name + maybe(a.asname, n => ' as ' + n)).join(this.comma));
			case 'if':				return 'if ' + this.expr(s.test) + this.suite(s.body) + this.elseChain(s.orelse);
			case 'while':			return 'while ' + this.expr(s.test) + this.suite(s.body) + this.elseClause(s.orelse);
			case 'for':				return (s.is_async ? 'async ' : '') + 'for ' + this.exprList(s.target) + ' in ' + this.exprList(s.iter)
				+ this.suite(s.body) + this.elseClause(s.orelse);
			case 'with':			return (s.is_async ? 'async ' : '') + 'with '
				+ s.items.map(w => this.expr(w.context) + maybe(w.optional_vars, v => ' as ' + this.expr(v))).join(this.comma)
				+ this.suite(s.body);
			case 'try':				return 'try' + this.suite(s.body)
				+ s.handlers.map(h => this.newline + 'except' + (h.star ? '*' : '')
					+ maybe(h.type, t => ' ' + this.expr(t)) + maybe(h.param, n => ' as ' + n) + this.suite(h.body)).join('')
				+ this.elseClause(s.orelse)
				+ (s.finalizer.length ? this.newline + 'finally' + this.suite(s.finalizer) : '');
			case 'funcdef':			return this.decorators(s.decorators) + (s.is_async ? 'async ' : '') + 'def ' + s.name
				+ '(' + this.params(s.params) + ')' + maybe(s.returns, r => ' -> ' + this.expr(r)) + this.suite(s.body);
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
				case 'star':		return '*' + (p.name ?? '');
				case 'dstar':		return '**' + p.name;
				default: {
					const ann = !lambda && p.annotation ? ': ' + this.expr(p.annotation) : '';
					const eq  = !lambda && p.annotation ? ' = ' : '=';
					return p.name + ann + maybe(p.default, d => eq + this.expr(d));
				}
			}
		}).join(this.comma);
	}

	private arg(a: PY.Arg): string {
		switch (a.kind) {
			case 'kw':		return a.name + '=' + this.expr(a.value, TERNARY);
			case 'star':	return '*' + this.expr(a.value, UNARY);
			case 'dstar':	return '**' + this.expr(a.value, UNARY);
			default:		return this.expr(a.value, TERNARY);
		}
	}

	private comprehension(gens: PY.CompClause[]): string {
		return gens.map(c => c.type === 'for'
			? (c.is_async ? 'async ' : '') + 'for ' + this.exprList(c.target) + ' in ' + this.expr(c.iter, OR)
			: 'if ' + this.expr(c.test, OR)
		).join(' ');
	}

	private sliceStr(e: Expr): string {
		if (e.type === 'slice')
			return maybe(e.lower, l => this.expr(l)) + ':' + maybe(e.upper, u => this.expr(u)) + maybe(e.step, s => ':' + this.expr(s));
		if (e.type === 'tuple')
			return e.elements.map(x => this.sliceStr(x)).join(this.comma);
		return this.expr(e);
	}

	private fstring(parts: PY.FStringPart[]): string {
		const body = parts.map(p => p.text + (p.field ? this.fstringField(p.field) : '')).join('');
		const single = !body.includes('\n') && (!body.includes('"') ? '"' : !body.includes("'") ? "'" : '');
		return single ? 'f' + single + body + single
			: !body.includes('"""') ? 'f"""' + body + '"""'
			: !body.includes("'''") ? "f'''" + body + "'''"
			: 'f"""' + body.replace(/"/g, '\\"') + '"""';
	}
	private fstringField(f: PY.FStringField): string {
		const spec = f.spec ? ':' + f.spec.map(s => 'expr' in s ? '{' + this.expr(s.expr) + '}' : s.text).join('') : '';
		return '{' + this.expr(f.expr) + (f.selfDoc ? '=' : '') + maybe(f.conv, c => '!' + c) + spec + '}';
	}

	// Bare (unparenthesised) tuple where the context allows it -- assignment sides, `return`, `del`,
	// `for` targets, expression statements.
	private exprList(e: Expr): string {
		if (e.type === 'tuple')
			return e.elements.length === 0 ? '()'
				: e.elements.map(x => this.expr(x, TERNARY)).join(this.comma) + (e.elements.length === 1 ? ',' : '');
		return this.expr(e);
	}

	// ===================================================================
	//  Expressions
	// ===================================================================

	expr(e: Expr, minPrec = 0): string {
		return withParens(this.exprBody(e), exprPrecedence(e) < minPrec);
	}

	private exprBody(e: Expr): string {
		switch (e.type) {
			case 'identifier':		return e.name;
			case 'literal':
				return e.value === null ? 'None'
					: typeof e.value === 'boolean' ? (e.value ? 'True' : 'False')
					: typeof e.value === 'string' ? pyStr(e.value)
					: String(e.value);
			case 'imaginary':		return String(e.value) + 'j';
			case 'ellipsis':		return '...';
			case 'unary':			return e.operator === 'not' ? 'not ' + this.expr(e.operand, NOT) : e.operator + this.expr(e.operand, UNARY);
			case 'binary': {
				const prec = BINARY_PREC[e.operator] ?? ATOM;
				const rightAssoc = e.operator === '**';
				return this.expr(e.left, rightAssoc ? prec + 1 : prec) + this.op(e.operator) + this.expr(e.right, rightAssoc ? prec : prec + 1);
			}
			case 'compare':			return this.expr(e.left, BOR)
				+ e.ops.map((o, i) => ' ' + o + ' ' + this.expr(e.comparators[i], BOR)).join('');
			case 'conditional':		return this.expr(e.consequent, OR) + ' if ' + this.expr(e.test, OR) + ' else ' + this.expr(e.alternate, TERNARY);
			case 'lambda':			return 'lambda' + (e.params.length ? ' ' + this.params(e.params, true) : '') + ': ' + this.expr(e.body, LAMBDA);
			case 'namedexpr':		return e.target + ' := ' + this.expr(e.value, TERNARY);
			case 'spread':			return '*' + this.expr(e.operand, UNARY);
			case 'member':			return this.expr(e.object, POSTFIX) + '.' + e.property;
			case 'index':			return this.expr(e.object, POSTFIX) + '[' + this.sliceStr(e.index) + ']';
			case 'slice':			return this.sliceStr(e);	// only reached if a bare slice is printed on its own
			case 'call':			return this.expr(e.callee, POSTFIX) + '(' + e.arguments.map(a => this.arg(a)).join(this.comma) + ')';
			case 'tuple':			return e.elements.length === 0 ? '()'
				: '(' + e.elements.map(x => this.expr(x, TERNARY)).join(this.comma) + (e.elements.length === 1 ? ',' : '') + ')';
			case 'list':			return '[' + e.elements.map(x => this.expr(x, TERNARY)).join(this.comma) + ']';
			case 'set':				return e.elements.length === 0 ? 'set()' : '{' + e.elements.map(x => this.expr(x, TERNARY)).join(this.comma) + '}';
			case 'dict':			return '{' + e.keys.map((k, i) => k === null
				? '**' + this.expr(e.values[i], OR)
				: this.expr(k, TERNARY) + ': ' + this.expr(e.values[i], TERNARY)).join(this.comma) + '}';
			case 'genexp':			return '(' + this.expr(e.elt, TERNARY) + ' ' + this.comprehension(e.gens) + ')';
			case 'listcomp':		return '[' + this.expr(e.elt, TERNARY) + ' ' + this.comprehension(e.gens) + ']';
			case 'setcomp':			return '{' + this.expr(e.elt, TERNARY) + ' ' + this.comprehension(e.gens) + '}';
			case 'dictcomp':		return '{' + this.expr(e.key, TERNARY) + ': ' + this.expr(e.value, TERNARY) + ' ' + this.comprehension(e.gens) + '}';
			case 'await':			return 'await ' + this.expr(e.value, AWAIT);
			case 'yield':			return e.from ? 'yield from ' + this.expr(e.from) : e.value ? 'yield ' + this.exprList(e.value) : 'yield';
			case 'fstring':			return this.fstring(e.parts);
		}
	}
}
