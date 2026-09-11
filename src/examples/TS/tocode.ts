import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Module, Literal, hasMod } from '../common';
import { isModule, isType, isJsStatement, guard, isTsDeclaration } from './walker';

type Type	= TS.Type;
type Expr	= JS.Expr;
const VOID	= TS.RefType('void');

// ===================================================================
//  Type Guards
// ===================================================================

const isBindingTarget	= guard<JS.BindingTarget>(['object_pattern', 'array_pattern']);

const DefaultOptions = {
	newline: 			'\n',
	indent: 			'  ',
	spaceAroundOps:		true,
	spaceAfterColon:	true,
	spaceAfterComma:	true,
	// Characters of type text to print before eliding the rest as `...`: a diagnostic shows only a prefix, and a type
	// built from shared subtrees can print exponentially larger than it is.
	typeBudget:			Infinity,
};

export type Options = Partial<typeof DefaultOptions>;

// ===================================================================
//  Expressions
// ===================================================================
//
// Precedence-aware printing: this grammar's binary/unary/etc. nodes don't carry an explicit "parenthesized" wrapper,
// so regenerating *valid* code requires recomputing, from each node's own operator/type, whether its children need parens reinserted.

// Mirrors js-parser.ts's own `binaryChain` precedence levels exactly (multiplicative -> ... -> nullish),
// numbered so a higher number binds tighter; 'as'/'satisfies' sit at the same tier as relational operators, matching where ts-parser.ts pushes them onto `relational_expression`.
const BINARY_PREC: Record<string, number> = {
	'**': 15,
	'*': 14, '/': 14, '%': 14,
	'+': 13, '-': 13,
	'<<': 12, '>>': 12, '>>>': 12,
	'<': 11, '>': 11, '<=': 11, '>=': 11, 'instanceof': 11, 'in': 11,
	'==': 10, '!=': 10, '===': 10, '!==': 10,
	'&': 9,
	'^': 8,
	'|': 7,
	'&&': 6,
	'||': 5,
	'??': 4,
};

function exprPrecedence(expr: Expr): number {
	switch (expr.type) {
		case 'sequence':			return 1;
		case 'yield':
		case 'arrow':				return 2;
		case 'conditional':			return 3;
		case 'assign':				return 2;
		// NOTE: `??` binds tighter than `?:`, so this reads `(BINARY_PREC[op] ?? endsWith) ? 2 : 0` --
		// i.e. every operator WITH a precedence entry reports 2, not its own precedence. That
		// over-parenthesises, and the expected strings in test-vsdg encode the result. Left exactly as
		// it was rather than fixed here, so this change stays about the `assign` node alone.
		case 'binary':				return BINARY_PREC[expr.operator] ?? expr.operator.endsWith('=') ? 2 : 0;
		case 'as':
		case 'satisfies':return 11;
		case 'await':
		case 'unary':				return 16;
		case 'unary_post':			return 17;
		default:					return 18;
	}
}

function withParens(x: string, parens = true)	{ return parens ? '(' + x + ')' : x; }
function arrowParens(body: string)				{ return withParens(body, body.startsWith('{')); }
function poss(enable: boolean|undefined, s: string)	{ return enable ? s : ''; }
function optional(enable?: boolean) 			{ return poss(enable, '?'); }
function generator(enable?: boolean) 			{ return poss(enable, '*'); }
function aSync(enable?: boolean) 				{ return poss(enable, 'async '); }
function readonly(enable?: boolean)				{ return poss(enable, 'readonly '); }
function declare(enable?: boolean)				{ return poss(enable, 'declare '); }
function typeOnly(enable?: boolean)				{ return poss(enable, 'type '); }

function maybe<T>(value: T, fn: (value: NonNullable<T>) => string)	{ return value ? fn(value as NonNullable<T>) : ''; }

// Parsing merges `{foo: 1}` and `{'foo': 1}` into the same plain-string `key`, so regenerating always-bare
// breaks any key that isn't a valid identifier on its own (e.g. `'filter-out': ...`).
function isValidIdentifier(s: string) { return /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u.test(s); }
function isLogicalOp(op: string) { return op === '&&' || op === '||' || op === '??'; } 

function needsNullishParens(parentOp: string, child: Expr): boolean {
	const childOp = child.type === 'binary' && isLogicalOp(child.operator) ? child.operator : undefined;
	return (parentOp === '??' && (childOp === '&&' || childOp === '||'))
		|| ((parentOp === '&&' || parentOp === '||') && childOp === '??');
}

function needsAsIntersectionParens(parentOp: string, child: Expr): boolean {
	return parentOp === '&' && (child?.type === 'as' || child?.type === 'satisfies');
}

// Mirrors ts-parser.ts's own type-expression precedence chain (primary -> postfix array -> keyof/readonly -> intersection
// -> union -> conditional), numbered so a higher number binds tighter. `function`/`constructor` rank with `conditional`
// despite being grammatically `primary_type` alternatives: their return type is greedy (`return_type` = full `type`), so
// nesting one inside any tighter context re-parses wrong unless parenthesized -- e.g. `(() => A) & B` printed bare as
// `() => A & B` becomes one function type returning `A & B`, not an intersection.
function typePrecedence(type: Type): number {
	switch (type.type) {
		case 'conditional':
		case 'function':
		case 'constructor':	return 0;
		case 'union':		return 1;
		case 'intersection':return 2;
		case 'keyof':		return 3;
		// `readonly` binds looser than the postfix `[]`/tuple-literal shapes it flags, same as `keyof` -- a readonly array/tuple
		// used where its own precedence tier is required (e.g. as another array's element) still needs parens.
		case 'array':		return type.readonly ? 3 : 4;
		case 'tuple':		return type.readonly ? 3 : 5;
		case 'indexed_access':return 4;
		default:			return 5;
	}
}

// A double-quoted JS string literal, replacing `JSON.stringify` -- this compiler's own lib has no
// `JSON`, and quoting a string is all these call sites ever wanted from it. Same escape set JSON uses
// (quote, backslash, the C0 controls), which is exactly what a JS string literal needs.
// `charCodeAt`/`slice` rather than `for...of` or `s[i]`: iterating or indexing a string are both
// listed towasm gaps, and this file is a self-hosting target.
export function quoteString(s: string): string {
	let out = '"';
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		out +=	c === 34 ? '\\"'
			:	c === 92 ? '\\\\'
			:	c === 10 ? '\\n'
			:	c === 13 ? '\\r'
			:	c === 9  ? '\\t'
			:	c === 8  ? '\\b'
			:	c === 12 ? '\\f'
			:	c < 32   ? '\\u00' + (c < 16 ? '0' : '') + c.toString(16)
			:	s.slice(i, i + 1);
	}
	return out + '"';
}

function typeMemberName(key: JS.Key<Type>): string {
	return typeof key === 'string'
		? (isValidIdentifier(key) ? key : quoteString(key))
		: '[' + JS.ExprToDottedName(key.computed) + ']';
}

export class Output {
	opts;
	newline = '\n';
	colon	= ': ';
	comma	= ', ';
	// A function inferred to (directly or indirectly) return its own type -- e.g. `function f() { return f; }` --
	// is a real, uncaught checker gap (no cycle detection during inference yet), so a genuinely cyclic Type object
	// can reach here. Printing it is diagnostic-only, so a placeholder beats an unbounded recursive stack overflow.
	private printing = new Set<Type>();
	private typeSpent = 0;

	constructor(opts: Options = {}) {
		this.opts		= {...DefaultOptions, ...opts};
		this.newline	= '\n';
		this.colon		= this.opts.spaceAfterColon ? ': ' : ':';
		this.comma		= this.opts.spaceAfterComma ? ', ' : ',';
	}

	toCode(ast: Module<any> | TS.Stmt | Type | Expr | TS.Stmt[]) {
		if (Array.isArray(ast))
			return ast.map(s => this.statement(s)).join(this.opts.newline);
		if (isModule(ast))
			return ast.body.map(s => this.statement(s as TS.Stmt)).join(this.opts.newline);
		if (isType(ast))
			return this.type(ast);
		if (isJsStatement(ast) || isTsDeclaration(ast))
			return this.statement(ast);
		if (isBindingTarget(ast))
			return this.bindingTarget(ast);
		return this.expr(ast);
	}

	// ===================================================================
	//  Helpers
	// ===================================================================

	operator(op: string) {
		return this.opts.spaceAroundOps ? ' ' + op + ' ' : op;
	}

	indented(f: () => string) {
		const prev = this.newline;
		this.newline += this.opts.indent;
		const r = f();
		this.newline = prev;
		return r;
	}
	curlyIndented(f: () => string, flat = false) {
		if (flat) {
			const prev = this.newline;
			this.newline = ' ';
			const r = '{ ' + f() + ' }';
			this.newline = prev;
			return r;
		}
		return '{' + this.indented(() => this.newline + f()) + this.newline + '}';
	}
	
	private decorators(list?: Expr[]): string {
		return list ? list.map(d => '@' + this.expr(d) + this.newline).join('') : '';
	}

	typeAnnotation(type?: Type) {
		return maybe(type, type => this.colon + this.type(type));
	}

	bindingTarget(target: JS.BindingTarget): string {
		if (typeof target === 'string')
			return target;
		if (target.type === 'object_pattern') {
			const parts = target.properties.map(p =>
				this.memberKey(p.key) + ':' + this.bindingTarget(p.value) + maybe(p.default, def => ' = ' + this.expr(def, 2))
			);
			if (target.rest)
				parts.push('...' + target.rest);
			return '{ ' + parts.join(this.comma) + ' }';
		}
		if (target.type === 'array_pattern') {
			const parts = target.elements.map(e => maybe(e,
				e => this.bindingTarget(e.target) + maybe(e.default, def => ' = ' + this.expr(def, 2))
			));
			if (target.rest)
				parts.push('...' + target.rest);
			return '[' + parts.join(this.comma) + ']';
		}
		return String(target);
	}
	// `params.join(', ') + (rest ? ', ...' + rest : '')` looks right but leaves a stray leading comma for a rest-only list (e.g. `(...alts)`).
	paramList(params: JS.Param<any>[], rest?: JS.Rest<any>): string {
		const parts = params.map(param => {
			// `'optional'` renders as a trailing `?`, not a prefix keyword like the rest (`public`/`readonly`/...).
			const prefix = param.modifiers?.filter(m => m !== 'optional');
			return	this.decorators(param.decorators)
				+	(prefix?.length ? prefix.join(' ') + ' ' : '')
				+	this.bindingTarget(param.key)
				+	optional(hasMod(param, 'optional'))
				+	this.typeAnnotation(param.typeAnnotation as Type)
				+	maybe(param.default, def => ' = ' + this.expr(def, 2));
		});
		if (rest)
			parts.push('...' + this.bindingTarget(rest.key) + this.typeAnnotation(rest.typeAnnotation as Type));
		return withParens(parts.join(this.comma) );
	}

	// ===================================================================
	//  Types
	// ===================================================================

	typeArgs(typeArgs?: Type[]) {
		return maybe(typeArgs, typeArgs => '<' + typeArgs.map(t => this.type(t)).join(this.comma) + '>');
	}

	typeParams(typeParams?: TS.TypeParam[]) {
		return maybe(typeParams, typeParams => ('<' + typeParams.map(param =>
			poss(param.const, 'const ') + param.name
		+	maybe(param.constraint, constraint => ' extends ' + this.type(constraint))
		+	maybe(param.default, def => ' = ' + this.type(def))
		).join(this.comma) + '>'));
	}

	params(params: TS.Params): string {
		const a = params.params.map(p => p.key + optional(hasMod(p, 'optional')) + this.typeAnnotation(p.typeAnnotation));
		if (params.rest)
			a.push('...' + this.bindingTarget(params.rest.key) + this.typeAnnotation(params.rest?.typeAnnotation));
		return withParens(a.join(this.comma));
	}

	typeMemberBody(members: TS.TypeMember[]): string {
		if (members.length === 0)
			return '{}';
		return this.curlyIndented(() => members.map(m => {
			switch (m.type) {
				case 'property':
					return readonly(hasMod(m, 'readonly'))
						+ typeMemberName(m.key)
						+ optional(hasMod(m, 'optional'))
						+ this.typeAnnotation(m.typeAnnotation);

				case 'method':
					return typeMemberName(m.key)
						+ optional(hasMod(m, 'optional'))
						+ this.typeParams(m.typeParams)
						+ this.params(m)
						+ this.typeAnnotation(m.returnType);

				case 'index':
					return '[' + m.paramName + this.typeAnnotation(m.paramType) + ']' + this.typeAnnotation(m.typeAnnotation);

				case 'call':
					return this.typeParams(m.typeParams)
						+ this.params(m)
						+ this.typeAnnotation(m.returnType ?? VOID);

				case 'construct':
					return 'new ' + this.typeParams(m.typeParams)
						+ this.params(m)
						+ this.typeAnnotation(m.returnType ?? VOID);

				default:
					throw new Error(`Unknown member kind: ${(m as any).kind}`);
			}
		}).join(';' + this.newline));
	}

	// `minPrec`: the precedence tier required of `type` here -- if lower, it gets parens. Defaults to 0 (never wraps),
	// right for the many call sites that sit in an unrestricted `type` position (annotations, generic args, delimited lists, ...).
	type(type: Type, minPrec = 0): string {
		if (this.printing.has(type))
			return '<circular>';
		if (this.typeSpent > this.opts.typeBudget)
			return '...';
		this.printing.add(type);
		try {
			const r = withParens(this.typeBody(type), typePrecedence(type) < minPrec);
			this.typeSpent += r.length;
			return r;
		} finally {
			this.printing.delete(type);
		}
	}

	tupleElement(t: TS.TupleElement) {
		return t.type === 'spread'	? '...' + maybe(t.label, label => label + this.colon) + this.type(t.argument)
			: t.type === 'optional' ? this.type(t.element) + '?'
			: t.type === 'labeled'	? t.label + optional(t.optional) + this.typeAnnotation(t.element)
			: this.type(t);
	}

	private typeBody(type: Type): string {
		switch (type.type) {
			case 'ref':
				return type.name + this.typeArgs(type.typeArgs);

			case 'literal':
				return this.literal(type, t => this.type(t));

			// Not real TS syntax -- narrowing-only. A degenerate (min === max) range is how a bigint literal is
			// represented (`Literal` has no bigint value of its own), and prints back out as one (`10n`); anything
			// else only ever reaches here via a diagnostic message, so a readable pseudo-type is enough.
			case 'range':
				return type.min !== undefined && type.min === type.max
					? String(type.min) + (type.base === 'bigint' ? 'n' : '')
					: type.base + '[' + (type.min ?? '-Infinity') + '..' + (type.max ?? 'Infinity') + ']' + (type.integer ? ' (int)' : '');

			case 'this':
				return 'this';

			case 'array':
				return readonly(type.readonly) + this.type(type.element, 4) + '[]';

			case 'tuple':
				return readonly(type.readonly) + '[' + type.elements.map(t => this.tupleElement(t)).join(this.comma) + ']';

			case 'union':
				return type.types.map(t => this.type(t, 2)).join(' | ');

			case 'intersection':
				return type.types.map(t => this.type(t, 3)).join(' & ');

			case 'function':
				return this.typeParams(type.typeParams) + this.params(type) + ' => ' + this.type(type.returnType ?? VOID);

			case 'constructor':
				return poss(type.abstract, 'abstract ') + 'new '
					+ this.typeParams(type.typeParams)
					+ this.params(type) + ' => ' + this.type(type.returnType ?? VOID);

			case 'object':
				return this.typeMemberBody(type.members);

			case 'keyof':
				return 'keyof ' + this.type(type.argument, 4);

			case 'typeof':
				return 'typeof ' + type.name;

			case 'indexed_access':
				return this.type(type.object, 4) + '[' + this.type(type.index) + ']';

			case 'conditional':
				return this.type(type.checkType, 1) + ' extends ' + this.type(type.extendsType, 1)
					+ this.operator('?') + this.type(type.trueType)
					+ this.operator(':') + this.type(type.falseType);

			case 'infer':
				return 'infer ' + type.name + maybe(type.constraint, constraint => ' extends ' + this.type(constraint));

			case 'mapped':
				return this.curlyIndented(() =>
					(hasMod(type, 'readonly') ? 'readonly ' : hasMod(type, '-readonly') ? '-readonly ' : '')
					+ '['
					+ type.keyName + ' in ' + this.type(type.constraint)
					+ maybe(type.nameType, nameType => ' as ' + this.type(nameType))
					+ ']'
					+ (hasMod(type, 'optional') ? '?' : hasMod(type, '-optional') ? '-?' : '')
					+ this.typeAnnotation(type.valueType)
				);

			case 'predicate':
				return poss(type.asserts, 'asserts ') + type.paramName + maybe(type.assertedType, type => ' is ' + this.type(type));

			case 'import':
				return 'import(' + maybe(type.source, source => quoteString(source)) + maybe(type.name, name => this.comma + name) + ')';

			default:
				throw new Error(`Unknown type: ${(type as any).type}`);
		}
	}

	// ===================================================================
	//  Statements
	// ===================================================================

	indentBlock(stmts: TS.Stmt[]): string {
		return this.curlyIndented(() => stmts.map(s => this.statement(s)).join(this.newline));
	}
	dependentCode(stmt: TS.Stmt): string {
		if (stmt.type !== 'block')
			return this.indented(()=> this.newline + this.statement(stmt));
		return this.indentBlock(stmt.body);
	}
	varDecls(x: {kind: JS.DeclarationKind, declarations: JS.Var<any>[]}) {
		return x.kind + ' ' + x.declarations.map(decl =>
			this.bindingTarget(decl.name)
			+ poss(decl.definite, '!')
			+ this.typeAnnotation(decl.typeAnnotation as Type)
			+ maybe(decl.init, init => ' = ' + this.expr(init, 2))
		).join(this.comma);
	}

	statement(stmt: TS.Stmt): string {
		switch (stmt.type) {
			case 'type_alias_decl':
				return 'type ' + stmt.name
					+ this.typeParams(stmt.typeParams)
					+ ' = ' + this.type(stmt.value) + ';';

			case 'interface_decl':
				return 'interface ' + stmt.name
					+ this.typeParams(stmt.typeParams)
					+ maybe(stmt.extendsClause, ext => ' extends ' + ext.map(t => this.type(t)).join(this.comma))
					+ ' ' + this.typeMemberBody(stmt.body);

			case 'enum_decl':
				return declare(stmt.ambient)
					+ poss(stmt.const, 'const ')
					+ 'enum ' + stmt.name + ' ' + this.curlyIndented(()=>stmt.members.map(m =>
					 	m.name + maybe(m.init, init => ' = ' + this.expr(init, 2))
					).join(this.newline));

			case 'namespace_decl':
				if (stmt.ambient)
					return 'declare namespace ' + stmt.name + ';';
				return 'namespace ' + stmt.name + ' ' + this.indentBlock(stmt.body);

			case 'block':
				return this.indentBlock(stmt.body);

			case 'var_decl':
				return declare(stmt.ambient) + this.varDecls(stmt) + ';';

			case 'expression': {
				// Real JS forbids an ExpressionStatement from starting with `{` -- a destructuring reassignment (`{a, b} = f()`) is exactly this.
				const code = this.expr(stmt.expression);
				return withParens(code, code.startsWith('{')) + ';';
			}

			case 'empty':
				return ';';

			case 'if':
				return 'if (' + this.expr(stmt.test) + ') '
					+ this.dependentCode(stmt.consequent)
					+ maybe(stmt.alternate, alt => ' else ' + this.dependentCode(alt));

			case 'do_while':
				return 'do ' + this.dependentCode(stmt.body) + ' while (' + this.expr(stmt.test) + ');';

			case 'while':
				return 'while (' + this.expr(stmt.test) + ') ' + this.dependentCode(stmt.body);

			case 'for':
				return 'for ' + poss(stmt.kind === 'of await', 'await ') + withParens(
					maybe(stmt.init, init => (init.type === 'var_decl'
						? this.varDecls(init)
						: this.expr(init)
					))
					+ (stmt.kind === 'normal'
						? '; ' + maybe(stmt.test, test => this.expr(test)) + '; ' + maybe(stmt.update, update => this.expr(update))
						: ' ' + (stmt.kind === 'of await' ? 'of' : stmt.kind) + ' ' + this.expr(stmt.right)
					)
				 ) + ' ' + this.dependentCode(stmt.body);

			case 'continue':
				return 'continue' + maybe(stmt.label, label => ' ' + label) + ';';

			case 'break':
				return 'break' + maybe(stmt.label, label => ' ' + label) + ';';

			case 'return':
				return 'return' + maybe(stmt.argument, arg => ' ' + this.expr(arg)) + ';';

			case 'with':
				return 'with (' + this.expr(stmt.argument) + ') ' + this.dependentCode(stmt.body);

			case 'labeled':
				return stmt.label + this.colon + this.statement(stmt.body);

			case 'switch':
				return 'switch (' + this.expr(stmt.discriminant) + ') ' + this.curlyIndented(() => stmt.cases.map(c =>
					(c.test ? 'case ' + this.expr(c.test) : 'default') + ':' + this.indented(()=> this.newline + c.consequent.map(s => this.statement(s)).join(this.newline))
				).join(this.newline));

			case 'throw':
				return 'throw ' + this.expr(stmt.argument) + ';';

			case 'try':
				return 'try ' + this.indentBlock(stmt.body)
					+ stmt.handlers.map(h => ' catch' + maybe(h.param, param => ' (' + this.bindingTarget(param) + ')') + ' ' + this.indentBlock(h.body)).join('')
					+ maybe(stmt.finalizer, final => ' finally ' + this.indentBlock(final));

			case 'debugger':
				return 'debugger;';

			case 'function_decl':
				return declare(stmt.ambient)
					+ (aSync(hasMod(stmt, 'async')) + 'function ' + generator(hasMod(stmt, 'generator')) + stmt.name)
					+ this.typeParams(stmt.typeParams as TS.TypeParam[])
					+ this.paramList(stmt.params, stmt.rest)
					+ this.typeAnnotation(stmt.returnType as Type)
					+ (stmt.body ? ' ' + this.indentBlock(stmt.body) : ';');

			case 'import':
				if (!stmt.default && !stmt.namespace && !stmt.specifiers?.length)
					return 'import ' + quoteString(stmt.source) + ';';

				return 'import ' + typeOnly(stmt.typeOnly)
					+	maybe(stmt.default, def => def + ((stmt.namespace || stmt.specifiers?.length) ? ', ' : ''))
					+ 	(stmt.namespace
							? '* as ' + stmt.namespace
							: maybe(stmt.specifiers?.length, () => this.curlyIndented(() => 
								stmt.specifiers!.map(s => typeOnly(s.typeOnly) + s.imported + maybe(s.local !== s.imported, () => ' as ' + s.local)).join(this.comma)
							, true))
						)
					+	' from ' + quoteString(stmt.source) + ';';

			case 'export':
				if (stmt.default)
					return 'export default ' + this.toCode(stmt.default);

				return 'export ' + typeOnly(stmt.typeOnly)
					+ (stmt.specifiers
						? this.curlyIndented(() => stmt.specifiers!.map(s => typeOnly(s.typeOnly) + s.local + maybe(s.exported !== s.local, ()=> ' as ' + s.exported)).join(this.comma))
						: ('*' + maybe(stmt.namespace, ns => 'as ' + ns + ' '))
					) + maybe(stmt.source, source => ' from ' + quoteString(source));

			case 'export_decl':
				return 'export ' + this.statement(stmt.declaration);

			case 'class_decl':
				return this.decorators(stmt.decorators)
					+ declare(stmt.ambient)
					+ poss(stmt.abstract, 'abstract ')
					+ 'class ' + stmt.name
					+ this.typeParams(stmt.typeParams as TS.TypeParam[])
					+ maybe(stmt.superClass, sup => ' extends ' + this.expr(sup, 18))
					+ maybe(stmt.implements, imp => ' implements ' + imp.map(t => this.type(t)).join(this.comma))
					+ ' ' + this.curlyIndented(() => stmt.body.map(m => this.classMember(m as TS.ClassMember)).join(this.newline));

			default:
				throw new Error(`Unknown statement: ${(stmt as any).type}`);
		}
	}

	// ===================================================================
	//  Classes
	// ===================================================================

	classMethod(member: TS.ClassMethod): string {
		return	aSync(hasMod(member, 'async'))
			+ 	generator(hasMod(member, 'generator'))
			+ 	this.memberKey(member.key)
			+ 	optional(hasMod(member, 'optional'))
			+ 	this.typeParams(member.typeParams as TS.TypeParam[])
			+ 	this.paramList(member.params, member.rest)
			+ 	(member.key === 'constructor' ? '' : this.typeAnnotation(member.returnType as Type))
			+ 	' ' + maybe(member.body, body => this.indentBlock(body));
	}

	classMember(member: TS.ClassMember): string {
		if (member.type === 'static_block')
			return '  static ' + this.indentBlock(member.body);

		// `'optional'` renders as a trailing `?`, not a prefix keyword like the rest (`public`/`static`/...).
		const memberPrefix = member.modifiers?.filter(m => m !== 'optional' && m !== 'definite' && m !== 'generator');
		const result = this.decorators(member.type !== 'index_signature' ? member.decorators : undefined)
			+ maybe(memberPrefix?.length, () => memberPrefix!.join(' ') + ' ');

		switch (member.type) {
			case 'field':
				return	result
					+	this.memberKey(member.key)
					+	(hasMod(member, 'optional') ? '?' : hasMod(member, 'definite') ? '!' : '')
					+	this.typeAnnotation(member.typeAnnotation)
					+	maybe(member.value, val => ' = ' + this.expr(val, 2))
					+	';';

			case 'method':	return result + generator(hasMod(member, 'generator')) + this.classMethod(member);
			case 'get':		return result + 'get ' + this.classMethod(member);
			case 'set':		return result + 'set ' + this.classMethod(member);
			case 'index_signature':
				return	result + '[' + member.paramName
					+	this.typeAnnotation(member.paramType) + ']'
					+	this.typeAnnotation(member.typeAnnotation) + ';';
		}
	}

	memberKey(key: JS.Key<any>): string {
		return typeof key === 'string'
			? isValidIdentifier(key) ? key : quoteString(key)
			: '[' + this.expr(key.computed, 2) + ']';
	}
	// ===================================================================
	//  Expressions
	// ===================================================================

	// `print`: how a substitution prints -- an expression's, or (a template literal TYPE) a type's; the node kinds overlap (`conditional`).
	templateParts(parts: JS.TemplatePart<any>[], print: (x: any) => string = x => this.expr(x)): string {
		return '`' + parts.map(p => p.str + maybe(p.exp, exp => '${' + print(exp) + '}')).join('') + '`';
	}

	literal(expr: Literal<any>, print?: (x: any) => string) {
		switch (typeof expr.value) {
			case 'string':
				return quoteString(expr.value);

			case 'bigint':
				return expr.value.toString() + 'n';

			case 'object':
				return  expr.value === null ? 'null'
					: expr.value instanceof RegExp	? '/' + expr.value.source + '/' + (expr.value.flags || '')
					: Array.isArray(expr.value)		?  this.templateParts(expr.value, print)
					: '?';
			default:
				return String(expr.value);
		}
	}

	// `minPrec`: the precedence tier required of `expr` here -- if lower, it gets parens. Defaults to 0 (never wraps), right for statement-level callers.
	expr(expr: Expr, minPrec = 0): string {
		return withParens(this.exprBody(expr), exprPrecedence(expr) < minPrec);
	}

	exprBody(expr: Expr): string {
		switch (expr.type) {
			case 'identifier':
				return expr.name;

			case 'literal':
				return this.literal(expr);

			case 'this':
				return 'this';

			case 'super':
				return 'super';

			case 'array':
				// Elements use `assignment_expression` in the grammar (array_literal's `element_list`),
				// so minPrec=2 keeps a literal comma/sequence element from being misread as two elements.
				return '[' + expr.elements.map((e: Expr | undefined) => maybe(e, e => this.expr(e, 2))).join(this.comma) + ']';

			case 'object':
				return this.curlyIndented(() => expr.properties.map(p => {
					switch (p.type) {
						case 'spread':		return '...' + this.expr(p.operand, 2);
						case 'get':			return 'get ' + this.memberKey(p.key) + '() ' + this.indentBlock(p.body!);
						case 'set':			return 'set ' + this.memberKey(p.key) + this.paramList(p.params, p.rest) + ' ' + this.indentBlock(p.body!);
						case 'method':		return aSync(hasMod(p, 'async')) + generator(hasMod(p, 'generator')) + this.memberKey(p.key) + this.paramList(p.params, p.rest) + ' ' + this.indentBlock(p.body!);
						case 'field':		return this.memberKey(p.key) + this.colon + this.expr(p.value!, 2);
					}
				}).join(',' + this.newline));

			case 'function':
				return aSync(hasMod(expr, 'async'))
					+ 'function' + generator(hasMod(expr, 'generator')) + maybe(expr.name, name => ' ' + name)
					+ this.typeParams(expr.typeParams as TS.TypeParam[])
					+ this.paramList(expr.params, expr.rest)
					+ this.typeAnnotation(expr.returnType as Type)
					+ ' ' + this.indentBlock(expr.body!);

			case 'member':
				return this.expr(expr.object, 18) + (expr.optional ? '?.' : '.') + expr.property;

			case 'index':
				// `property` uses the full `expression` production (allows comma) per the grammar's `'[' expression ']'` -- no wrapping needed.
				return this.expr(expr.object, 18) + poss(expr.optional, '?.') + '[' + this.expr(expr.index) + ']';

			case 'call':
				return this.expr(expr.callee, 18)
					+ this.typeArgs(expr.typeArgs as Type[])
					+ poss(expr.optional, '?.')
					+ withParens(expr.arguments.map((a: Expr) => this.expr(a, 2)).join(this.comma));

			case 'new':
				return 'new ' + this.expr(expr.callee, 18)
					+ this.typeArgs(expr.typeArgs as Type[])
					+ withParens(expr.arguments.map((a: Expr) => this.expr(a, 2)).join(this.comma) );

			// Binds like a prefix unary, so it shares their operand tier.
			case 'await':
				return 'await ' + this.expr(expr.operand, 16);

			case 'unary':
				// Operand is `unary_expression` (self) in the grammar -- same tier, so chained unaries
				// (`!!x`, `typeof typeof x`) don't need parens, but anything looser (e.g. `-(a + b)`) does.
				return expr.operator + poss(!!expr.operator.match(/\w+/), ' ') + this.expr(expr.operand, 16);

			case 'unary_post':
				return this.expr(expr.operand, 18) + expr.operator;

			// Right-associative and the loosest thing there is: the target re-emits at the
			// left-hand-side tier the grammar demands, the value at assignment's own tier.
			case 'assign':
				return this.expr(expr.target, 18) + this.operator((expr.operator ?? '') + '=') + this.expr(expr.value, 2);

			case 'binary': {
				const op	= expr.operator;
				const prec	= BINARY_PREC[op] ?? 0;
				return withParens(this.expr(expr.left, op === '**' ? 16 : prec), needsNullishParens(op, expr.left) || needsAsIntersectionParens(op, expr.left))
					+ this.operator(op)
					+ withParens(this.expr(expr.right, op === '**' ? 15 : prec + 1), needsNullishParens(op, expr.right));
			}

			case 'conditional':
				// `test` is parsed as `nullish_expression` (tier 4); `consequent`/`alternate` are full
				// `assignment_expression` (tier 2, i.e. anything but a bare sequence) -- see conditional_expression.
				return this.expr(expr.test, 4) + this.operator('?') + this.expr(expr.consequent, 2) + this.operator(':') + this.expr(expr.alternate, 2);

			case 'sequence':
				return expr.expressions.map((e: Expr) => this.expr(e, 2)).join(this.comma);

			case 'spread':
				return '...' + this.expr(expr.operand, 2);

			case 'tagged_template':
				return this.expr(expr.tag, 18) + this.templateParts(expr.quasi);

			case 'arrow': {
				return aSync(hasMod(expr, 'async'))
					+ this.typeParams(expr.typeParams as TS.TypeParam[])
					+ (!expr.typeParams && !expr.returnType && expr.params.length === 1 && !expr.rest && typeof expr.params[0].key === 'string'
						? expr.params[0].key
						: this.paramList(expr.params, expr.rest)
					)
					+ this.typeAnnotation(expr.returnType as Type)
					+ ' => '
					+ (Array.isArray(expr.body)
						? this.indentBlock(expr.body)
						: arrowParens(this.expr(expr.body, 2))	// Body is `assignment_expression` (tier 2) -- but an object literal body additionally needs parens regardless of precedence, or `{` would be read as the arrow's block body instead (the same ambiguity real TS. requires `() => ({})` for).
					);
			}

			case 'yield':
				return 'yield' + generator(expr.delegate) + maybe(expr.operand, op => ' ' + this.expr(op, 2));

			case 'class':
				return 'class' + maybe(expr.name, name => ' ' + name)
					+ this.typeParams(expr.typeParams as TS.TypeParam[])
					+ maybe(expr.superClass, sup => ' extends ' + this.expr(sup, 18))
					+ maybe(expr.implements, imp => ' implements ' + imp.map(t => this.type(t as Type)).join(this.comma))
					+ ' ' + this.curlyIndented(() => (expr.body as TS.ClassMember[]).map(m => this.classMember(m)).join(this.newline));

			case 'as':
				return this.expr(expr.expression, 11) + ' as ' + this.type(expr.typeAnnotation as Type);

			case 'satisfies':
				return this.expr(expr.expression, 11) + ' satisfies ' + this.type(expr.typeAnnotation as Type);

			case 'instantiation':
				return this.expr(expr.expression, 18) + this.typeArgs(expr.typeArgs as Type[]);

			default:
				return String(expr);
		}
	}
}
