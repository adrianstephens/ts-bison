import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Literal } from '../common';
import { Expr, BindingTarget, Key, Rest } from './js-parser';
import { Type } from './ts-parser';
import { isProgram, isType, isJsStatement, guard, hasMod, isTsDeclaration } from './walker';

export const VOID		= TS.RefType('void');

// ===================================================================
//  Type Guards
// ===================================================================

const isBindingTarget	= guard<BindingTarget>(['object_pattern', 'array_pattern']);

const DefaultOptions = {
	newline: 	'\n',
	indent: 	'  ',
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
		case 'binary':				return BINARY_PREC[expr.operator] ?? expr.operator.endsWith('=') ? 2 : 0;
		case 'as':
		case 'satisfies':return 11;
		case 'unary':				return 16;
		case 'unary_post':			return 17;
		default:					return 18;
	}
}

function withParens(x: string, parens = true)	{
	return parens ? '(' + x + ')' : x;
}
function arrowParens(body: string) {
	return withParens(body, body.startsWith('{'));
}
function optional(enable: any) {
	return enable ? '?' : '';
}
function aSync(enable: any) {
	return enable ? 'async ' : '';
}

// Parsing merges `{foo: 1}` and `{'foo': 1}` into the same plain-string `key`, so regenerating always-bare
// breaks any key that isn't a valid identifier on its own (e.g. `'filter-out': ...`).
function isValidIdentifier(s: string) { return /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u.test(s); }
function isLogicalOp(op: string) { return op === '&&' || op === '||' || op === '??'; } 
function isAssignOp(op: string) { return !(op in BINARY_PREC) && op.endsWith('='); }

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

export class TSoutput {
	opts;
	newline = '\n';

	constructor(opts: Options = {}) {
		this.opts = {...DefaultOptions, ...opts};
		this.newline = '\n';
	}

	indented(f: () => string) {
		const prev = this.newline;
		this.newline += this.opts.indent;
		const r = f();
		this.newline = prev;
		return r;
	}
	curlyIndented(f: () => string) {
		return '{' + this.indented(() => this.newline + f()) + this.newline + '}';
	}

	toCode(ast: JS.Program<unknown> | TS.Program | TS.Statement | Type | Expr) {
		if (isProgram(ast))
			return ast.body.map(s => this.statementToCode(s as TS.Statement)).join(this.opts.newline);
		if (isType(ast))
			return this.typeToCode(ast);
		if (isJsStatement(ast) || isTsDeclaration(ast))
			return this.statementToCode(ast);
		if (isBindingTarget(ast))
			return this.bindingTargetToCode(ast);
		return this.exprToCode(ast);
	}

	indentBlock(stmts: (TS.Statement|JS.Statement<any>)[]): string {
		return this.curlyIndented(() => stmts.map(s => this.statementToCode(s)).join(this.newline));
	}
	dependentCode(stmt: JS.Statement<any>): string {
		if (stmt.type !== 'block')
			return this.indented(()=> this.newline + this.statementToCode(stmt));
		return this.indentBlock(stmt.body);
	}


	// ===================================================================
	//  Types
	// ===================================================================

	// `minPrec`: the precedence tier required of `type` here -- if lower, it gets parens. Defaults to 0 (never wraps),
	// right for the many call sites that sit in an unrestricted `type` position (annotations, generic args, delimited lists, ...).
	typeToCode(type: Type, minPrec = 0): string {
		return withParens(this.typeToCodeBody(type), typePrecedence(type) < minPrec);
	}

	private typeToCodeBody(type: Type): string {
		switch (type.type) {
			case 'ref':
				return type.name + this.typeArgsToCode(type.typeArgs);

			case 'literal':
				return this.literalToCode(type);

			case 'this':
				return 'this';

			case 'array':
				return (type.readonly ? 'readonly ' : '') + this.typeToCode(type.element, 4) + '[]';

			case 'tuple':
				return (type.readonly ? 'readonly ' : '') + '[' + type.elements.map(t => t.type === 'spread' ? '...' + (t.label ? t.label + ': ' : '') + this.typeToCode(t.argument)
					: t.type === 'optional' ? this.typeToCode(t.element) + '?'
					: t.type === 'labeled' ? t.label + optional(t.optional) + ': ' + this.typeToCode(t.element)
					: this.typeToCode(t)).join(', ') + ']';

			case 'union':
				return type.types.map(t => this.typeToCode(t, 2)).join(' | ');

			case 'intersection':
				return type.types.map(t => this.typeToCode(t, 3)).join(' & ');

			case 'function':
				return this.typeParamsToCode(type.typeParams) + this.paramsToCode(type) + ' => ' + this.typeToCode(type.returnType ?? VOID);

			case 'constructor':
				return (type.abstract ? 'abstract ' : '') + 'new '
					+ this.typeParamsToCode(type.typeParams)
					+ this.paramsToCode(type) + ' => ' + this.typeToCode(type.returnType ?? VOID);

			case 'object':
				return this.typeMemberBodyToCode(type.members);

			case 'keyof':
				return 'keyof ' + this.typeToCode(type.argument, 4);

			case 'typeof':
				return 'typeof ' + type.name;

			case 'indexed_access':
				return this.typeToCode(type.object, 4) + '[' + this.typeToCode(type.index) + ']';

			case 'conditional':
				return this.typeToCode(type.checkType, 1) + ' extends ' + this.typeToCode(type.extendsType, 1)
					+ ' ? ' + this.typeToCode(type.trueType)
					+ ' : ' + this.typeToCode(type.falseType);

			case 'infer':
				return 'infer ' + type.name + (type.constraint ? ' extends ' + this.typeToCode(type.constraint) : '');

			case 'mapped':
				return '{ '
					+  (hasMod(type, 'readonly') ? 'readonly ' : hasMod(type, '-readonly') ? '-readonly ' : '')
					+ '['
					+ type.keyName + ' in ' + this.typeToCode(type.constraint)
					+ (type.nameType ? ' as ' + this.typeToCode(type.nameType) : '')
					+ ']'
					+ (hasMod(type, 'optional') ? '?' : hasMod(type, '-optional') ? '-?' : '')
					+ ': ' + this.typeToCode(type.valueType) + ' }';

			case 'predicate':
				return (type.asserts ? 'asserts ' : '') + type.paramName + (type.assertedType ? ' is ' + this.typeToCode(type.assertedType) : '');

			case 'import':
				return 'import(' + (type.source ? JSON.stringify(type.source) : '') + (type.name ? ', ' + type.name : '') + ')';

			default:
				throw new Error(`Unknown type: ${(type as any).type}`);
		}
	}

	typeAnnotationToCode(type?: Type) {
		return type ? (': ' + this.typeToCode(type)) : '';
	}

	typeMemberBodyToCode(members: TS.TypeMember[]): string {
		if (members.length === 0)
			return '{}';
		return this.curlyIndented(() => members.map(m => this.typeMemberToCode(m)).join(';' + this.newline));
	}

	// A computed member name is always the restricted `IDENT ('.' IDENT)*` shape ts-parser.ts's `type_member_computed_name` builds, never a
	// general expression -- so this doesn't need the full (instance-method) `exprToCode`.
	static computedTypeMemberKeyToCode(e: Expr): string {
		return e.type === 'member' ? this.computedTypeMemberKeyToCode(e.object) + '.' + e.property : e.type === 'identifier' ? e.name : '??';
	}

	static typeMemberNameToCode(key: Key<Type>): string {
		return typeof key === 'string' ? (isValidIdentifier(key) ? key : JSON.stringify(key)) : '[' + this.computedTypeMemberKeyToCode(key.computed) + ']';
	}

	typeMemberToCode(member: TS.TypeMember): string {
		switch (member.type) {
			case 'property':
				return (hasMod(member, 'readonly') ? 'readonly ' : '')
					+	TSoutput.typeMemberNameToCode(member.key)
					+	optional(hasMod(member, 'optional'))
					+	': ' + this.typeToCode(member.typeAnnotation);

			case 'method':
				return TSoutput.typeMemberNameToCode(member.key)
					+ optional(hasMod(member, 'optional'))
					+ this.typeParamsToCode(member.typeParams)
					+ this.paramsToCode(member)
					+ this.typeAnnotationToCode(member.returnType);

			case 'index':
				return '[' + member.paramName + ': ' + this.typeToCode(member.paramType) + ']: ' + this.typeToCode(member.typeAnnotation);

			case 'call':
				return this.typeParamsToCode(member.typeParams)
					+ this.paramsToCode(member)
					+ this.typeAnnotationToCode(member.returnType ?? VOID);

			case 'construct':
				return 'new ' + this.typeParamsToCode(member.typeParams)
					+ this.paramsToCode(member)
					+ this.typeAnnotationToCode(member.returnType ?? VOID);

			default:
				throw new Error(`Unknown member kind: ${(member as any).kind}`);
		}
	}

	// ===================================================================
	//  Parameters
	// ===================================================================

	typeArgsToCode(typeArgs?: Type[]) {
		return typeArgs ? ('<' + typeArgs.map(t => this.typeToCode(t)).join(', ') + '>') : '';
	}

	typeParamsToCode(typeParams?: TS.TypeParam[]) {
		return typeParams ? ('<' + typeParams.map(param =>
			(param.const ? 'const ' : '') + param.name
		+	(param.constraint ? ' extends ' + this.typeToCode(param.constraint) : '')
		+	(param.default ? ' = ' + this.typeToCode(param.default) : '')
		).join(', ') + '>') : '';
	}

	paramsToCode(params: TS.Params): string {
		const a = params.params.map(p => p.key + optional(hasMod(p, 'optional')) + this.typeAnnotationToCode(p.typeAnnotation));
		if (params.rest)
			a.push('...' + this.bindingTargetToCode(params.rest.key) + this.typeAnnotationToCode(params.rest?.typeAnnotation));
		return withParens(a.join(', '));
	}

	bindingTargetToCode(target: BindingTarget): string {
		if (typeof target === 'string')
			return target;
		if (target.type === 'object_pattern') {
			const parts = target.properties.map(p =>
				p.key + ':' + this.bindingTargetToCode(p.value) + (p.default ? ' = ' + this.exprToCode(p.default, 2) : '')
			);
			if (target.rest)
				parts.push('...' + target.rest);
			return '{ ' + parts.join(', ') + ' }';
		}
		if (target.type === 'array_pattern') {
			const parts = target.elements.map(e =>
				e ? this.bindingTargetToCode(e.target) + (e.default ? ' = ' + this.exprToCode(e.default, 2) : '') : ''
			);
			if (target.rest)
				parts.push('...' + target.rest);
			return '[' + parts.join(', ') + ']';
		}
		return String(target);
	}
	// `params.join(', ') + (rest ? ', ...' + rest : '')` looks right but leaves a stray leading comma for a rest-only list (e.g. `(...alts)`).
	paramListToCode(params: JS.Param<any>[], rest?: Rest<any>): string {
		const parts = params.map(param => {
			// `'optional'` renders as a trailing `?`, not a prefix keyword like the rest (`public`/`readonly`/...).
			const prefix = param.modifiers?.filter(m => m !== 'optional');
			return (prefix?.length ? prefix.join(' ') + ' ' : '')
				+	this.bindingTargetToCode(param.key)
				+	optional(hasMod(param, 'optional'))
				+	(param.typeAnnotation ? ': ' + this.typeToCode(param.typeAnnotation as Type) : '')
				+	(param.default ? ' = ' + this.exprToCode(param.default, 2) : '');
		});
		if (rest)
			parts.push('...' + this.bindingTargetToCode(rest.key) + (rest.typeAnnotation ? ': ' + this.typeToCode(rest.typeAnnotation as Type) : ''));
		return withParens(parts.join(', ') );
	}


	// ===================================================================
	//  Statements
	// ===================================================================

	statementToCode(stmt: TS.Statement): string {
		switch (stmt.type) {
			case 'type_alias_decl':
				return 'type ' + stmt.name
					+ this.typeParamsToCode(stmt.typeParams)
					+ ' = ' + this.typeToCode(stmt.value) + ';';

			case 'interface_decl':
				return 'interface ' + stmt.name
					+ this.typeParamsToCode(stmt.typeParams)
					+ (stmt.extendsClause ? ' extends ' + stmt.extendsClause.map(t => this.typeToCode(t)).join(', ') : '')
					+ ' ' + this.typeMemberBodyToCode(stmt.body);

			case 'enum_decl':
				return (stmt.ambient ? 'declare ' : '')
					+ (stmt.const ? 'const ' : '')
					+ 'enum ' + stmt.name + ' ' + this.curlyIndented(()=>stmt.members.map(m =>
					 	m.name + (m.init ? ' = ' + this.exprToCode(m.init, 2) : '')
					).join(this.newline));

			case 'namespace_decl':
				if (stmt.ambient)
					return 'declare namespace ' + stmt.name + ';';
				return 'namespace ' + stmt.name + ' ' + this.indentBlock(stmt.body);

			case 'block':
				return this.indentBlock(stmt.body);

			case 'var_decl':
				return (stmt.ambient ? 'declare ' : '') + this.varDeclsToCode(stmt) + ';';

			case 'expression': {
				// Real JS forbids an ExpressionStatement from starting with `{` -- a destructuring reassignment (`{a, b} = f()`) is exactly this.
				const code = this.exprToCode(stmt.expression);
				return withParens(code, code.startsWith('{')) + ';';
			}

			case 'empty':
				return ';';

			case 'if':
				return 'if (' + this.exprToCode(stmt.test) + ') '
					+ this.dependentCode(stmt.consequent)
					+ (stmt.alternate ? ' else ' + this.dependentCode(stmt.alternate) : '');

			case 'do_while':
				return 'do ' + this.dependentCode(stmt.body) + ' while (' + this.exprToCode(stmt.test) + ');';

			case 'while':
				return 'while (' + this.exprToCode(stmt.test) + ') ' + this.dependentCode(stmt.body);

			case 'for':
				return 'for ' + (stmt.kind === 'of await' ? 'await ' : '') + withParens(
					(stmt.init ? (stmt.init.type === 'var_decl'
						? this.varDeclsToCode(stmt.init)
						: this.exprToCode(stmt.init)
					) : '')
					+ (stmt.kind === 'normal'
						? '; ' + (stmt.test ? this.exprToCode(stmt.test) : '') + '; ' + (stmt.update ? this.exprToCode(stmt.update) : '')
						: ' ' + (stmt.kind === 'of await' ? 'of' : stmt.kind) + ' ' + this.exprToCode(stmt.right)
					)
				 ) + ' ' + this.dependentCode(stmt.body);

			case 'continue':
				return 'continue' + (stmt.label ? ' ' + stmt.label : '') + ';';

			case 'break':
				return 'break' + (stmt.label ? ' ' + stmt.label : '') + ';';

			case 'return':
				return 'return' + (stmt.argument ? ' ' + this.exprToCode(stmt.argument) : '') + ';';

			case 'with':
				return 'with (' + this.exprToCode(stmt.argument) + ') ' + this.dependentCode(stmt.body);

			case 'labeled':
				return stmt.label + ': ' + this.statementToCode(stmt.body);

			case 'switch':
				return 'switch (' + this.exprToCode(stmt.discriminant) + ') ' + this.curlyIndented(() => stmt.cases.map(c =>
					(c.test ? 'case ' + this.exprToCode(c.test) : 'default') + ':' + this.opts.newline + this.indented(()=> c.consequent.map(s => this.statementToCode(s)).join(this.newline))
				).join(this.newline));

			case 'throw':
				return 'throw ' + this.exprToCode(stmt.argument) + ';';

			case 'try':
				return 'try ' + this.indentBlock(stmt.block)
					+ (stmt.handlerBody ? ' catch' + (stmt.handlerParam ? ' (' + stmt.handlerParam + ') ' : ' ') + this.indentBlock(stmt.handlerBody) : '')
					+ (stmt.finalizer ? ' finally ' + this.indentBlock(stmt.finalizer) : '');

			case 'debugger':
				return 'debugger;';

			case 'function_decl':
				return (stmt.ambient ? 'declare ' : '')
					+ (aSync(hasMod(stmt, 'async')) + 'function ' + (hasMod(stmt, 'generator') ? '*' : '') + stmt.name)
					+ this.typeParamsToCode(stmt.typeParams as TS.TypeParam[])
					+ this.paramListToCode(stmt.params, stmt.rest)
					+ this.typeAnnotationToCode(stmt.returnType as Type)
					+ (stmt.body ? ' ' + this.indentBlock(stmt.body) : ';');

			case 'import':
				if (!stmt.default && !stmt.namespace && !stmt.specifiers?.length)
					return 'import ' + JSON.stringify(stmt.source) + ';';

				return 'import ' + (stmt.typeOnly ? 'type ' : '')
					+	(stmt.default ? stmt.default + ((stmt.namespace || stmt.specifiers?.length) ? ', ' : '') : '')
					+ 	(stmt.namespace
							? '* as ' + stmt.namespace
							: stmt.specifiers?.length ? '{ ' + stmt.specifiers.map(s => (s.typeOnly ? 'type ' : '') + s.imported + (s.local !== s.imported ? ' as ' + s.local : '')).join(', ') + ' }' : ''
						)
					+	' from ' + JSON.stringify(stmt.source) + ';';

			case 'export':
				if (stmt.default)
					return 'export default ' + this.toCode(stmt.default);

				return 'export ' + (stmt.typeOnly ? 'type ' : '')
				+ (stmt.specifiers
					? ('{ ' + stmt.specifiers.map(s => (s.typeOnly ? 'type ' : '') + s.local + (s.exported !== s.local ? ' as ' + s.exported : '')).join(', ')	+ ' }')
					: ('*' + (stmt.namespace ? 'as ' + stmt.namespace + ' ' : ''))
				) + (stmt.source ? ' from ' + JSON.stringify(stmt.source) : '');

			case 'export_decl':
				return 'export ' + this.statementToCode(stmt.declaration);

			case 'class_decl':
				return (stmt.ambient ? 'declare ' : '')
					+ (stmt.abstract ? 'abstract ' : '')
					+ 'class ' + stmt.name
					+ this.typeParamsToCode(stmt.typeParams as TS.TypeParam[])
					+ (stmt.superClass ? ' extends ' + this.exprToCode(stmt.superClass, 18) : '')
					+ (stmt.implements ? ' implements ' + (stmt.implements as Type[]).map(t => this.typeToCode(t)).join(', ') : '')
					+ ' ' + this.curlyIndented(() => stmt.body.map(m => this.classMemberToCode(m as TS.ClassMember)).join(this.newline));

			default:
				throw new Error(`Unknown statement: ${(stmt as any).type}`);
		}
	}

	varDeclsToCode(x: {kind: JS.DeclarationKind, declarations: JS.VarDeclarator<any>[]}) {
		return x.kind + ' ' + x.declarations.map(decl =>
			this.bindingTargetToCode(decl.name)
			+ (decl.definite ? '!' : '')
			+ (decl.typeAnnotation ? ': ' + this.typeToCode(decl.typeAnnotation as Type) : '')
			+ (decl.init ? ' = ' + this.exprToCode(decl.init, 2) : '')
		).join(', ');
	}

	classMethodToCode(member: TS.ClassMethod): string {
		return	aSync(hasMod(member, 'async'))
			+ 	(hasMod(member, 'generator') ? '*' : '')
			+ 	this.memberKeyToCode(member.key)
			+ 	optional(hasMod(member, 'optional'))
			+ 	this.typeParamsToCode(member.typeParams as TS.TypeParam[])
			+ 	this.paramListToCode(member.params, member.rest)
			+ 	this.typeAnnotationToCode(member.returnType as Type)
			+ 	(member.body ? ' ' + this.indentBlock(member.body!) : ';');
	}

	classMemberToCode(member: TS.ClassMember): string {
		if (member.type === 'static_block')
			return '  static ' + this.indentBlock(member.body);

		// `'optional'` renders as a trailing `?`, not a prefix keyword like the rest (`public`/`static`/...).
		const memberPrefix = member.modifiers?.filter(m => m !== 'optional' && m !== 'definite');
		const result = memberPrefix?.length ? memberPrefix.join(' ') + ' ' : '';

		switch (member.type) {
			case 'field':
				return	result
					+	this.memberKeyToCode(member.key)
					+	(hasMod(member, 'optional') ? '?' : hasMod(member, 'definite') ? '!' : '')
					+	(member.typeAnnotation ? ': ' + this.typeToCode(member.typeAnnotation as Type) : '')
					+	(member.value ? ' = ' + this.exprToCode(member.value, 2) : '')
					+	';';

			case 'method':	return result + this.classMethodToCode(member);
			case 'get':		return result + 'get ' + this.classMethodToCode(member);
			case 'set':		return result + 'set ' + this.classMethodToCode(member);
			case 'generator':		return result + '*' + this.classMethodToCode(member);
			case 'index_signature':
				return	result + '[' + member.paramName + ': ' + this.typeToCode(member.paramType) + ']: '
					+	this.typeToCode(member.typeAnnotation) + ';';
		}
	}

	memberKeyToCode(key: Key<any>): string {
		return typeof key === 'string'
			? isValidIdentifier(key) ? key : JSON.stringify(key)
			: '[' + this.exprToCode(key.computed, 2) + ']';
	}

	templatePartsToCode(parts: JS.TemplatePart<any>[]): string {
		return '`' + parts.map(p => p.str + (p.exp ? '${' + this.toCode(p.exp) + '}' : '')).join('') + '`';
	}

	literalToCode(expr: Literal<any>) {
		switch (typeof expr.value) {
			case 'string':
				return JSON.stringify(expr.value);

			case 'bigint':
				return expr.value.toString() + 'n';

			case 'object':
				return  expr.value === null ? 'null'
					: expr.value instanceof RegExp	? '/' + expr.value.source + '/' + (expr.value.flags || '')
					: Array.isArray(expr.value)		?  this.templatePartsToCode(expr.value)
					: '?';
			default:
				return String(expr.value);
		}
	}

	// `minPrec`: the precedence tier required of `expr` here -- if lower, it gets parens. Defaults to 0 (never wraps), right for statement-level callers.
	exprToCode(expr: Expr, minPrec = 0): string {
		return withParens(this.exprToCodeBody(expr), exprPrecedence(expr) < minPrec);
	}

	exprToCodeBody(expr: Expr): string {
		switch (expr.type) {
			case 'identifier':
				return expr.name;

			case 'literal':
				return this.literalToCode(expr);

			case 'this':
				return 'this';

			case 'array':
				// Elements use `assignment_expression` in the grammar (array_literal's `element_list`),
				// so minPrec=2 keeps a literal comma/sequence element from being misread as two elements.
				return '[' + expr.elements.map((e: Expr | undefined) => e ? this.exprToCode(e, 2) : '').join(', ') + ']';

			case 'object':
				return this.curlyIndented(() => expr.properties.map(p => {
					switch (p.type) {
						case 'spread':		return '...' + this.exprToCode(p.operand, 2);
						case 'get':			return 'get ' + this.memberKeyToCode(p.key) + '() ' + this.indentBlock(p.body!);
						case 'set':			return 'set ' + this.memberKeyToCode(p.key) + this.paramListToCode(p.params, p.rest) + ' ' + this.indentBlock(p.body!);
						case 'method':		return aSync(hasMod(p, 'async')) + this.memberKeyToCode(p.key) + this.paramListToCode(p.params, p.rest) + ' ' + this.indentBlock(p.body!);
						case 'generator':	return aSync(hasMod(p, 'async')) + '*' + this.memberKeyToCode(p.key) + this.paramListToCode(p.params, p.rest) + ' ' + this.indentBlock(p.body!);
						case 'field':		return this.memberKeyToCode(p.key) + ': ' + this.exprToCode(p.value!, 2);
					}
				}).join(',' + this.newline));

			case 'function':
				return aSync(hasMod(expr, 'async'))
					+ 'function' + (hasMod(expr, 'generator') ? '*' : '') + (expr.name ? ' ' + expr.name : '')
					+ this.typeParamsToCode(expr.typeParams as TS.TypeParam[])
					+ this.paramListToCode(expr.params, expr.rest)
					+ this.typeAnnotationToCode(expr.returnType as Type)
					+ ' ' + this.indentBlock(expr.body!);

			case 'member':
				return this.exprToCode(expr.object, 18) + (expr.optional ? '?.' : '.') + expr.property;

			case 'index':
				// `property` uses the full `expression` production (allows comma) per the grammar's `'[' expression ']'` -- no wrapping needed.
				return this.exprToCode(expr.object, 18) + (expr.optional ? '?.' : '') + '[' + this.exprToCode(expr.property) + ']';

			case 'call':
				return this.exprToCode(expr.callee, 18)
					+ this.typeArgsToCode(expr.typeArgs as Type[])
					+ (expr.optional ? '?.' : '')
					+ withParens(expr.arguments.map((a: Expr) => this.exprToCode(a, 2)).join(', '));

			case 'new':
				return 'new ' + this.exprToCode(expr.callee, 18)
					+ this.typeArgsToCode(expr.typeArgs as Type[])
					+ withParens(expr.arguments.map((a: Expr) => this.exprToCode(a, 2)).join(', ') );

			case 'unary':
				// Operand is `unary_expression` (self) in the grammar -- same tier, so chained unaries
				// (`!!x`, `typeof typeof x`) don't need parens, but anything looser (e.g. `-(a + b)`) does.
				return expr.operator + (expr.operator.match(/\w+/) ? ' ' : '') + this.exprToCode(expr.operand, 16);

			case 'unary_post':
				return this.exprToCode(expr.operand, 18) + expr.operator;

			case 'binary': {
				const op	= expr.operator;
				const prec	= BINARY_PREC[op] ?? 0;
				return withParens(this.exprToCode(expr.left, op === '**' ? 16 : isAssignOp(op) ? 18 : prec), needsNullishParens(op, expr.left) || needsAsIntersectionParens(op, expr.left))
					+ ' ' + op + ' '
					+ withParens(this.exprToCode(expr.right, op === '**' ? 15 : isAssignOp(op) ? 2 : prec + 1), needsNullishParens(op, expr.right));
			}

			case 'conditional':
				// `test` is parsed as `nullish_expression` (tier 4); `consequent`/`alternate` are full
				// `assignment_expression` (tier 2, i.e. anything but a bare sequence) -- see conditional_expression.
				return this.exprToCode(expr.test, 4) + ' ? ' + this.exprToCode(expr.consequent, 2) + ' : ' + this.exprToCode(expr.alternate, 2);

			case 'sequence':
				return expr.expressions.map((e: Expr) => this.exprToCode(e, 2)).join(', ');

			case 'spread':
				return '...' + this.exprToCode(expr.operand, 2);

			case 'tagged_template':
				return this.exprToCode(expr.tag, 18) + this.templatePartsToCode(expr.quasi);

			case 'arrow': {
				return aSync(hasMod(expr, 'async'))
					+ this.typeParamsToCode(expr.typeParams as TS.TypeParam[])
					+ (!expr.typeParams && !expr.returnType && expr.params.length === 1 && !expr.rest && typeof expr.params[0].key === 'string'
						? expr.params[0].key
						: this.paramListToCode(expr.params, expr.rest)
					)
					+ this.typeAnnotationToCode(expr.returnType as Type)
					+ ' => '
					+ (Array.isArray(expr.body)
						? this.indentBlock(expr.body)
						: arrowParens(this.exprToCode(expr.body, 2))	// Body is `assignment_expression` (tier 2) -- but an object literal body additionally needs parens regardless of precedence, or `{` would be read as the arrow's block body instead (the same ambiguity real TS. requires `() => ({})` for).
					);
			}

			case 'yield':
				return 'yield' + (expr.delegate ? '*' : '') + (expr.operand ? ' ' + this.exprToCode(expr.operand, 2) : '');

			case 'class':
				return 'class' + (expr.name ? ' ' + expr.name : '')
					+ this.typeParamsToCode(expr.typeParams as TS.TypeParam[])
					+ (expr.superClass ? ' extends ' + this.exprToCode(expr.superClass, 18) : '')
					+ (expr.implements ? ' implements ' + (expr.implements as Type[]).map(t => this.typeToCode(t)).join(', ') : '')
					+ ' ' + this.curlyIndented(() => (expr.body as TS.ClassMember[]).map(m => this.classMemberToCode(m)).join(this.newline));

			case 'as':
				return this.exprToCode(expr.expression, 11) + ' as ' + this.typeToCode(expr.typeAnnotation as Type);

			case 'satisfies':
				return this.exprToCode(expr.expression, 11) + ' satisfies ' + this.typeToCode(expr.typeAnnotation as Type);

			case 'instantiation':
				return this.exprToCode(expr.expression, 18) + this.typeArgsToCode(expr.typeArgs as Type[]);

			default:
				return String(expr);
		}
	}
}
