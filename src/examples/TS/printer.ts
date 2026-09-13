import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Module, Literal, hasMod } from '../common';
import { isJsStatement, isTsDeclaration } from './walker';

type Type	= TS.Type;
type Expr	= JS.Expr;
const VOID	= TS.RefType('void');

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

export function printer(opts1: Options = {}) {
	const 	opts		= {...DefaultOptions, ...opts1};
	let		newline		= opts.newline;
	const	colon		= opts.spaceAfterColon ? ': ' : ':';
	const	comma		= opts.spaceAfterComma ? ', ' : ',';

	const	printing = new Set<Type>();
	let		typeSpent = 0;


	function statements(stmts: readonly TS.Stmt[]): string {
		return stmts.map(s => statement(s)).join(opts.newline);
	}

	function module(m: Module<TS.Stmt>): string {
		return statements(m.body);
	}

	// ===================================================================
	//  Helpers
	// ===================================================================

	function operator(op: string) {
		return opts.spaceAroundOps ? ' ' + op + ' ' : op;
	}

	function indented(f: () => string) {
		const prev = newline;
		newline += opts.indent;
		const r = f();
		newline = prev;
		return r;
	}
	function curlyIndented(f: () => string, flat = false) {
		if (flat) {
			const prev = newline;
			newline = ' ';
			const r = '{ ' + f() + ' }';
			newline = prev;
			return r;
		}
		return '{' + indented(() => newline + f()) + newline + '}';
	}
	
	function decorators(list?: Expr[]): string {
		return list ? list.map(d => '@' + expression(d) + newline).join('') : '';
	}

	function typeAnnotation(t?: Type) {
		return maybe(t, t => colon + type(t));
	}

	function bindingTarget(target: JS.BindingTarget): string {
		if (typeof target === 'string')
			return target;
		if (target.type === 'object_pattern') {
			const parts = target.properties.map(p =>
				memberKey(p.key) + ':' + bindingTarget(p.value) + maybe(p.default, def => ' = ' + expression(def, 2))
			);
			if (target.rest)
				parts.push('...' + target.rest);
			return '{ ' + parts.join(comma) + ' }';
		}
		if (target.type === 'array_pattern') {
			const parts = target.elements.map(e => maybe(e,
				e => bindingTarget(e.target) + maybe(e.default, def => ' = ' + expression(def, 2))
			));
			if (target.rest)
				parts.push('...' + target.rest);
			return '[' + parts.join(comma) + ']';
		}
		return String(target);
	}
	// `params.join(', ') + (rest ? ', ...' + rest : '')` looks right but leaves a stray leading comma for a rest-only list (e.g. `(...alts)`).
	function paramList(params: JS.Param<any>[], rest?: JS.Rest<any>): string {
		const parts = params.map(param => {
			// `'optional'` renders as a trailing `?`, not a prefix keyword like the rest (`public`/`readonly`/...).
			const prefix = param.modifiers?.filter(m => m !== 'optional');
			return	decorators(param.decorators)
				+	(prefix?.length ? prefix.join(' ') + ' ' : '')
				+	bindingTarget(param.key)
				+	optional(hasMod(param, 'optional'))
				+	typeAnnotation(param.typeAnnotation as Type)
				+	maybe(param.default, def => ' = ' + expression(def, 2));
		});
		if (rest)
			parts.push('...' + bindingTarget(rest.key) + typeAnnotation(rest.typeAnnotation as Type));
		return withParens(parts.join(comma) );
	}

	// ===================================================================
	//  Types
	// ===================================================================

	function typeArgs(typeArgs?: Type[]) {
		return maybe(typeArgs, typeArgs => '<' + typeArgs.map(t => type(t)).join(comma) + '>');
	}

	function typeParams(typeParams?: TS.TypeParam[]) {
		return maybe(typeParams, typeParams => ('<' + typeParams.map(param =>
			poss(param.const, 'const ') + param.name
		+	maybe(param.constraint, constraint => ' extends ' + type(constraint))
		+	maybe(param.default, def => ' = ' + type(def))
		).join(comma) + '>'));
	}

	function params(params: TS.Params): string {
		const a = params.params.map(p => p.key + optional(hasMod(p, 'optional')) + typeAnnotation(p.typeAnnotation));
		if (params.rest)
			a.push('...' + bindingTarget(params.rest.key) + typeAnnotation(params.rest?.typeAnnotation));
		return withParens(a.join(comma));
	}

	function typeMemberBody(members: TS.TypeMember[]): string {
		if (members.length === 0)
			return '{}';
		return curlyIndented(() => members.map(m => typeMember(m)).join(';' + newline));
	}

	function typeMember(m: TS.TypeMember): string {
		switch (m.type) {
			case 'property':
				return readonly(hasMod(m, 'readonly'))
					+ typeMemberName(m.key)
					+ optional(hasMod(m, 'optional'))
					+ typeAnnotation(m.typeAnnotation);

			case 'method':
				return typeMemberName(m.key)
					+ optional(hasMod(m, 'optional'))
					+ typeParams(m.typeParams)
					+ params(m)
					+ typeAnnotation(m.returnType);

			case 'index':
				return '[' + m.paramName + typeAnnotation(m.paramType) + ']' + typeAnnotation(m.typeAnnotation);

			case 'call':
				return typeParams(m.typeParams)
					+ params(m)
					+ typeAnnotation(m.returnType ?? VOID);

			case 'construct':
				return 'new ' + typeParams(m.typeParams)
					+ params(m)
					+ typeAnnotation(m.returnType ?? VOID);

			default:
				throw new Error(`Unknown member kind: ${(m as any).kind}`);
		}
	}

	// `minPrec`: the precedence tier required of `type` here -- if lower, it gets parens. Defaults to 0 (never wraps),
	// right for the many call sites that sit in an unrestricted `type` position (annotations, generic args, delimited lists, ...).
	function type(type: Type, minPrec = 0): string {
		if (printing.has(type))
			return '<circular>';
		if (typeSpent > opts.typeBudget)
			return '...';
		printing.add(type);
		try {
			const r = withParens(typeBody(type), typePrecedence(type) < minPrec);
			typeSpent += r.length;
			return r;
		} finally {
			printing.delete(type);
		}
	}

	function tupleElement(t: TS.TupleElement) {
		return t.type === 'spread'	? '...' + maybe(t.label, label => label + colon) + type(t.argument)
			: t.type === 'optional' ? type(t.element) + '?'
			: t.type === 'labeled'	? t.label + optional(t.optional) + typeAnnotation(t.element)
			: type(t);
	}

	function typeBody(t: Type): string {
		switch (t.type) {
			case 'ref':
				return t.name + typeArgs(t.typeArgs);

			case 'literal':
				return literal(t, t => type(t));

			// Not real TS syntax -- narrowing-only. A degenerate (min === max) range is how a bigint literal is
			// represented (`Literal` has no bigint value of its own), and prints back out as one (`10n`); anything
			// else only ever reaches here via a diagnostic message, so a readable pseudo-type is enough.
			case 'range':
				return t.min !== undefined && t.min === t.max
					? String(t.min) + (t.base === 'bigint' ? 'n' : '')
					: t.base + '[' + (t.min ?? '-Infinity') + '..' + (t.max ?? 'Infinity') + ']' + (t.integer ? ' (int)' : '');

			case 'this':
				return 'this';

			case 'array':
				return readonly(t.readonly) + type(t.element, 4) + '[]';

			case 'tuple':
				return readonly(t.readonly) + '[' + t.elements.map(t => tupleElement(t)).join(comma) + ']';

			case 'union':
				return t.types.map(t => type(t, 2)).join(' | ');

			case 'intersection':
				return t.types.map(t => type(t, 3)).join(' & ');

			case 'function':
				return typeParams(t.typeParams) + params(t) + ' => ' + type(t.returnType ?? VOID);

			case 'constructor':
				return poss(t.abstract, 'abstract ') + 'new '
					+ typeParams(t.typeParams)
					+ params(t) + ' => ' + type(t.returnType ?? VOID);

			case 'object':
				return typeMemberBody(t.members);

			case 'keyof':
				return 'keyof ' + type(t.argument, 4);

			case 'typeof':
				return 'typeof ' + t.name;

			case 'indexed_access':
				return type(t.object, 4) + '[' + type(t.index) + ']';

			case 'conditional':
				return type(t.checkType, 1) + ' extends ' + type(t.extendsType, 1)
					+ operator('?') + type(t.trueType)
					+ operator(':') + type(t.falseType);

			case 'infer':
				return 'infer ' + t.name + maybe(t.constraint, constraint => ' extends ' + type(constraint));

			case 'mapped':
				return curlyIndented(() =>
					(hasMod(t, 'readonly') ? 'readonly ' : hasMod(t, '-readonly') ? '-readonly ' : '')
					+ '['
					+ t.keyName + ' in ' + type(t.constraint)
					+ maybe(t.nameType, nameType => ' as ' + type(nameType))
					+ ']'
					+ (hasMod(t, 'optional') ? '?' : hasMod(t, '-optional') ? '-?' : '')
					+ typeAnnotation(t.valueType)
				);

			case 'predicate':
				return poss(t.asserts, 'asserts ') + t.paramName + maybe(t.assertedType, t => ' is ' + type(t));

			case 'import':
				return 'import(' + quoteString(t.source) + ')' + maybe(t.name, name => '.' + name) + typeArgs(t.typeArgs);

			default:
				throw new Error(`Unknown type: ${(t as any).type}`);
		}
	}

	// ===================================================================
	//  Statements
	// ===================================================================

	function indentBlock(stmts: TS.Stmt[]): string {
		return curlyIndented(() => stmts.map(s => statement(s)).join(newline));
	}
	function dependentCode(stmt: TS.Stmt): string {
		if (stmt.type !== 'block')
			return indented(()=> newline + statement(stmt));
		return indentBlock(stmt.body);
	}
	function varDecls(x: {kind: JS.DeclarationKind, declarations: JS.Var<any>[]}) {
		return x.kind + ' ' + x.declarations.map(decl =>
			bindingTarget(decl.name)
			+ poss(decl.definite, '!')
			+ typeAnnotation(decl.typeAnnotation as Type)
			+ maybe(decl.init, init => ' = ' + expression(init, 2))
		).join(comma);
	}

	function statement(stmt: TS.Stmt): string {
		switch (stmt.type) {
			case 'type_alias_decl':
				return 'type ' + stmt.name
					+ typeParams(stmt.typeParams)
					+ ' = ' + type(stmt.value) + ';';

			case 'interface_decl':
				return 'interface ' + stmt.name
					+ typeParams(stmt.typeParams)
					+ maybe(stmt.extendsClause, ext => ' extends ' + ext.map(t => type(t)).join(comma))
					+ ' ' + typeMemberBody(stmt.body);

			case 'enum_decl':
				return declare(stmt.ambient)
					+ poss(stmt.const, 'const ')
					+ 'enum ' + stmt.name + ' ' + curlyIndented(()=>stmt.members.map(m =>
					 	m.name + maybe(m.init, init => ' = ' + expression(init, 2))
					).join(newline));

			case 'namespace_decl':
				if (stmt.ambient)
					return 'declare namespace ' + stmt.name + ';';
				return 'namespace ' + stmt.name + ' ' + indentBlock(stmt.body);

			case 'block':
				return indentBlock(stmt.body);

			case 'var_decl':
				return declare(stmt.ambient) + varDecls(stmt) + ';';

			case 'expression': {
				// Real JS forbids an ExpressionStatement from starting with `{` -- a destructuring reassignment (`{a, b} = f()`) is exactly 
				const code = expression(stmt.expression);
				return withParens(code, code.startsWith('{')) + ';';
			}

			case 'empty':
				return ';';

			case 'if':
				return 'if (' + expression(stmt.test) + ') '
					+ dependentCode(stmt.consequent)
					+ maybe(stmt.alternate, alt => ' else ' + dependentCode(alt));

			case 'do_while':
				return 'do ' + dependentCode(stmt.body) + ' while (' + expression(stmt.test) + ');';

			case 'while':
				return 'while (' + expression(stmt.test) + ') ' + dependentCode(stmt.body);

			case 'for':
				return 'for ' + poss(stmt.kind === 'of await', 'await ') + withParens(
					maybe(stmt.init, init => (init.type === 'var_decl'
						? varDecls(init)
						: expression(init)
					))
					+ (stmt.kind === 'normal'
						? '; ' + maybe(stmt.test, test => expression(test)) + '; ' + maybe(stmt.update, update => expression(update))
						: ' ' + (stmt.kind === 'of await' ? 'of' : stmt.kind) + ' ' + expression(stmt.right)
					)
				 ) + ' ' + dependentCode(stmt.body);

			case 'continue':
				return 'continue' + maybe(stmt.label, label => ' ' + label) + ';';

			case 'break':
				return 'break' + maybe(stmt.label, label => ' ' + label) + ';';

			case 'return':
				return 'return' + maybe(stmt.argument, arg => ' ' + expression(arg)) + ';';

			case 'with':
				return 'with (' + expression(stmt.argument) + ') ' + dependentCode(stmt.body);

			case 'labeled':
				return stmt.label + colon + statement(stmt.body);

			case 'switch':
				return 'switch (' + expression(stmt.discriminant) + ') ' + curlyIndented(() => stmt.cases.map(c =>
					(c.test ? 'case ' + expression(c.test) : 'default') + ':' + indented(()=> newline + c.consequent.map(s => statement(s)).join(newline))
				).join(newline));

			case 'throw':
				return 'throw ' + expression(stmt.argument) + ';';

			case 'try':
				return 'try ' + indentBlock(stmt.body)
					+ stmt.handlers.map(h => ' catch' + maybe(h.param, param => ' (' + bindingTarget(param) + ')') + ' ' + indentBlock(h.body)).join('')
					+ maybe(stmt.finalizer, final => ' finally ' + indentBlock(final));

			case 'debugger':
				return 'debugger;';

			case 'function_decl':
				return declare(stmt.ambient)
					+ (aSync(hasMod(stmt, 'async')) + 'function ' + generator(hasMod(stmt, 'generator')) + stmt.name)
					+ typeParams(stmt.typeParams as TS.TypeParam[])
					+ paramList(stmt.params, stmt.rest)
					+ typeAnnotation(stmt.returnType as Type)
					+ (stmt.body ? ' ' + indentBlock(stmt.body) : ';');

			case 'import':
				if (!stmt.default && !stmt.namespace && !stmt.specifiers?.length)
					return 'import ' + quoteString(stmt.source) + ';';

				return 'import ' + typeOnly(stmt.typeOnly)
					+	maybe(stmt.default, def => def + ((stmt.namespace || stmt.specifiers?.length) ? ', ' : ''))
					+ 	(stmt.namespace
							? '* as ' + stmt.namespace
							: maybe(stmt.specifiers?.length, () => curlyIndented(() => 
								stmt.specifiers!.map(s => typeOnly(s.typeOnly) + s.imported + maybe(s.local !== s.imported, () => ' as ' + s.local)).join(comma)
							, true))
						)
					+	' from ' + quoteString(stmt.source) + ';';

			case 'export':
				if (stmt.default)
					return 'export default ' + (isJsStatement(stmt.default) || isTsDeclaration(stmt.default) ? statement(stmt.default) : expression(stmt.default));

				return 'export ' + typeOnly(stmt.typeOnly)
					+ (stmt.specifiers
						? curlyIndented(() => stmt.specifiers!.map(s => typeOnly(s.typeOnly) + s.local + maybe(s.exported !== s.local, ()=> ' as ' + s.exported)).join(comma))
						: ('*' + maybe(stmt.namespace, ns => 'as ' + ns + ' '))
					) + maybe(stmt.source, source => ' from ' + quoteString(source));

			case 'export_decl':
				return 'export ' + statement(stmt.declaration);

			case 'class_decl':
				return decorators(stmt.decorators)
					+ declare(stmt.ambient)
					+ poss(stmt.abstract, 'abstract ')
					+ 'class ' + stmt.name
					+ typeParams(stmt.typeParams as TS.TypeParam[])
					+ maybe(stmt.superClass, sup => ' extends ' + expression(sup, 18))
					+ maybe(stmt.implements, imp => ' implements ' + imp.map(t => type(t)).join(comma))
					+ ' ' + curlyIndented(() => stmt.body.map(m => classMember(m as TS.ClassMember)).join(newline));

			default:
				throw new Error(`Unknown statement: ${(stmt as any).type}`);
		}
	}

	// ===================================================================
	//  Classes
	// ===================================================================

	function classMethod(member: TS.ClassMethod): string {
		return	aSync(hasMod(member, 'async'))
			+ 	generator(hasMod(member, 'generator'))
			+ 	memberKey(member.key)
			+ 	optional(hasMod(member, 'optional'))
			+ 	typeParams(member.typeParams as TS.TypeParam[])
			+ 	paramList(member.params, member.rest)
			+ 	(member.key === 'constructor' ? '' : typeAnnotation(member.returnType as Type))
			+ 	' ' + maybe(member.body, body => indentBlock(body));
	}

	function classMember(member: TS.ClassMember): string {
		if (member.type === 'static_block')
			return '  static ' + indentBlock(member.body);

		// `'optional'` renders as a trailing `?`, not a prefix keyword like the rest (`public`/`static`/...).
		const memberPrefix = member.modifiers?.filter(m => m !== 'optional' && m !== 'definite' && m !== 'generator');
		const result = decorators(member.type !== 'index_signature' ? member.decorators : undefined)
			+ maybe(memberPrefix?.length, () => memberPrefix!.join(' ') + ' ');

		switch (member.type) {
			case 'field':
				return	result
					+	memberKey(member.key)
					+	(hasMod(member, 'optional') ? '?' : hasMod(member, 'definite') ? '!' : '')
					+	typeAnnotation(member.typeAnnotation)
					+	maybe(member.value, val => ' = ' + expression(val, 2))
					+	';';

			case 'method':	return result + generator(hasMod(member, 'generator')) + classMethod(member);
			case 'get':		return result + 'get ' + classMethod(member);
			case 'set':		return result + 'set ' + classMethod(member);
			case 'index_signature':
				return	result + '[' + member.paramName
					+	typeAnnotation(member.paramType) + ']'
					+	typeAnnotation(member.typeAnnotation) + ';';
		}
	}

	function memberKey(key: JS.Key<any>): string {
		return typeof key === 'string'
			? isValidIdentifier(key) ? key : quoteString(key)
			: '[' + expression(key.computed, 2) + ']';
	}
	// ===================================================================
	//  Expressions
	// ===================================================================

	// `print`: how a substitution prints -- an expression's, or (a template literal TYPE) a type's; the node kinds overlap (`conditional`).
	function templateParts(parts: JS.TemplatePart<any>[], print: (x: any) => string = x => expression(x)): string {
		return '`' + parts.map(p => p.str + maybe(p.exp, exp => '${' + print(exp) + '}')).join('') + '`';
	}

	function literal(expr: Literal<any>, print?: (x: any) => string) {
		switch (typeof expr.value) {
			case 'string':
				return quoteString(expr.value);

			case 'bigint':
				return expr.value.toString() + 'n';

			case 'object':
				return  expr.value === null ? 'null'
					: expr.value instanceof RegExp	? '/' + expr.value.source + '/' + (expr.value.flags || '')
					: Array.isArray(expr.value)		?  templateParts(expr.value, print)
					: '?';
			default:
				return String(expr.value);
		}
	}

	// `minPrec`: the precedence tier required of `expr` here -- if lower, it gets parens. Defaults to 0 (never wraps), right for statement-level callers.
	function expression(expr: Expr, minPrec = 0): string {
		return withParens(exprBody(expr), exprPrecedence(expr) < minPrec);
	}

	function exprBody(expr: Expr): string {
		switch (expr.type) {
			case 'identifier':
				return expr.name;

			case 'literal':
				return literal(expr);

			case 'this':
				return 'this';

			case 'super':
				return 'super';

			case 'array':
				// Elements use `assignment_expression` in the grammar (array_literal's `element_list`),
				// so minPrec=2 keeps a literal comma/sequence element from being misread as two elements.
				return '[' + expr.elements.map((e: Expr | undefined) => maybe(e, e => expression(e, 2))).join(comma) + ']';

			case 'object':
				return curlyIndented(() => expr.properties.map(p => {
					switch (p.type) {
						case 'spread':		return '...' + expression(p.operand, 2);
						case 'get':			return 'get ' + memberKey(p.key) + '() ' + indentBlock(p.body!);
						case 'set':			return 'set ' + memberKey(p.key) + paramList(p.params, p.rest) + ' ' + indentBlock(p.body!);
						case 'method':		return aSync(hasMod(p, 'async')) + generator(hasMod(p, 'generator')) + memberKey(p.key) + paramList(p.params, p.rest) + ' ' + indentBlock(p.body!);
						case 'field':		return memberKey(p.key) + colon + expression(p.value!, 2);
					}
				}).join(',' + newline));

			case 'function':
				return aSync(hasMod(expr, 'async'))
					+ 'function' + generator(hasMod(expr, 'generator')) + maybe(expr.name, name => ' ' + name)
					+ typeParams(expr.typeParams as TS.TypeParam[])
					+ paramList(expr.params, expr.rest)
					+ typeAnnotation(expr.returnType as Type)
					+ ' ' + indentBlock(expr.body!);

			case 'member':
				return expression(expr.object, 18) + (expr.optional ? '?.' : '.') + expr.property;

			case 'index':
				// `property` uses the full `expression` production (allows comma) per the grammar's `'[' expression ']'` -- no wrapping needed.
				return expression(expr.object, 18) + poss(expr.optional, '?.') + '[' + expression(expr.index) + ']';

			case 'call':
				return expression(expr.callee, 18)
					+ typeArgs(expr.typeArgs as Type[])
					+ poss(expr.optional, '?.')
					+ withParens(expr.arguments.map((a: Expr) => expression(a, 2)).join(comma));

			case 'new':
				return 'new ' + expression(expr.callee, 18)
					+ typeArgs(expr.typeArgs as Type[])
					+ withParens(expr.arguments.map((a: Expr) => expression(a, 2)).join(comma) );

			// Binds like a prefix unary, so it shares their operand tier.
			case 'await':
				return 'await ' + expression(expr.operand, 16);

			case 'unary':
				// Operand is `unary_expression` (self) in the grammar -- same tier, so chained unaries
				// (`!!x`, `typeof typeof x`) don't need parens, but anything looser (e.g. `-(a + b)`) does.
				return expr.operator + poss(!!expr.operator.match(/\w+/), ' ') + expression(expr.operand, 16);

			case 'unary_post':
				return expression(expr.operand, 18) + expr.operator;

			// Right-associative and the loosest thing there is: the target re-emits at the
			// left-hand-side tier the grammar demands, the value at assignment's own tier.
			case 'assign':
				return expression(expr.target, 18) + operator((expr.operator ?? '') + '=') + expression(expr.value, 2);

			case 'binary': {
				const op	= expr.operator;
				const prec	= BINARY_PREC[op] ?? 0;
				return withParens(expression(expr.left, op === '**' ? 16 : prec), needsNullishParens(op, expr.left) || needsAsIntersectionParens(op, expr.left))
					+ operator(op)
					+ withParens(expression(expr.right, op === '**' ? 15 : prec + 1), needsNullishParens(op, expr.right));
			}

			case 'conditional':
				// `test` is parsed as `nullish_expression` (tier 4); `consequent`/`alternate` are full
				// `assignment_expression` (tier 2, i.e. anything but a bare sequence) -- see conditional_expression.
				return expression(expr.test, 4) + operator('?') + expression(expr.consequent, 2) + operator(':') + expression(expr.alternate, 2);

			case 'sequence':
				return expr.expressions.map((e: Expr) => expression(e, 2)).join(comma);

			case 'spread':
				return '...' + expression(expr.operand, 2);

			case 'tagged_template':
				return expression(expr.tag, 18) + templateParts(expr.quasi);

			case 'arrow': {
				return aSync(hasMod(expr, 'async'))
					+ typeParams(expr.typeParams as TS.TypeParam[])
					+ (!expr.typeParams && !expr.returnType && expr.params.length === 1 && !expr.rest && typeof expr.params[0].key === 'string'
						? expr.params[0].key
						: paramList(expr.params, expr.rest)
					)
					+ typeAnnotation(expr.returnType as Type)
					+ ' => '
					+ (Array.isArray(expr.body)
						? indentBlock(expr.body)
						: arrowParens(expression(expr.body, 2))	// Body is `assignment_expression` (tier 2) -- but an object literal body additionally needs parens regardless of precedence, or `{` would be read as the arrow's block body instead (the same ambiguity real TS. requires `() => ({})` for).
					);
			}

			case 'yield':
				return 'yield' + generator(expr.delegate) + maybe(expr.operand, op => ' ' + expression(op, 2));

			case 'class':
				return 'class' + maybe(expr.name, name => ' ' + name)
					+ typeParams(expr.typeParams as TS.TypeParam[])
					+ maybe(expr.superClass, sup => ' extends ' + expression(sup, 18))
					+ maybe(expr.implements, imp => ' implements ' + imp.map(t => type(t as Type)).join(comma))
					+ ' ' + curlyIndented(() => (expr.body as TS.ClassMember[]).map(m => classMember(m)).join(newline));

			case 'as':
				return expression(expr.expression, 11) + ' as ' + type(expr.typeAnnotation as Type);

			case 'satisfies':
				return expression(expr.expression, 11) + ' satisfies ' + type(expr.typeAnnotation as Type);

			case 'instantiation':
				return expression(expr.expression, 18) + typeArgs(expr.typeArgs as Type[]);

			default:
				return String(expr);
		}
	}

	return {
		statement,
		expression,
		type,
		typeMember,
		classMember,
		module,
		statements,
		bindingTarget,
		memberKey,
		tupleElement
	};

}
