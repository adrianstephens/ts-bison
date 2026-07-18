import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Expr, BindingTarget, Key, Rest } from './js-parser';
import { Type } from './ts-parser';
import { isProgram, isType, isTsStatement, guard, hasMod } from './walker';
import { VOID } from './type-utils';

// ===================================================================
//  Type Guards
// ===================================================================

const isBindingTarget	= guard<BindingTarget>(['object_pattern', 'array_pattern']);

interface CodegenOptions {
	indent:	string;
}

// ===================================================================
//  Expressions
// ===================================================================
//
// Precedence-aware printing: most of this grammar's binary/unary/etc. nodes don't carry an explicit "parenthesized" wrapper (unlike Type's own `parenthesized` variant)
// So regenerating *valid* code requires recomputing, from each node's own operator/type, whether its children need parens reinserted.

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
		case 'as_expression':
		case 'satisfies_expression':return 11;
		case 'unary':				return 16;
		case 'unary_post':			return 17;
		default:					return 18;
	}
}

function indentCode(lines: string[], indent: string): string {
	return indent + lines.join('\n' + indent);
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
	return parentOp === '&' && (child?.type === 'as_expression' || child?.type === 'satisfies_expression');
}

// A compound element type needs parens as an array element, or it re-parses with the wrong
// precedence -- `(A | B)[]` printed without them becomes `A | B[]` (only `B` is the element).
const ARRAY_ELEMENT_NEEDS_PARENS = new Set(['union', 'intersection', 'function', 'constructor', 'conditional']);

export class TSoutput {
	opts: CodegenOptions = {
		indent: '  '
	};

	constructor(opts: Partial<CodegenOptions> = {}) {
		this.opts = {...this.opts, ...opts};
	}

	toCode(ast: TS.Program | TS.Statement | Type | Expr) {
		if (isProgram(ast))
			return this.indentBlock(ast.body, '');
		if (isType(ast))
			return this.typeToCode(ast);
		if (isTsStatement(ast))
			return this.statementToCode(ast);
		if (isBindingTarget(ast))
			return this.bindingTargetToCode(ast);
		return this.exprToCode(ast);
	}

	// ===================================================================
	//  Types
	// ===================================================================

	typeToCode(type: Type): string {
		switch (type.type) {
			case 'ref':
				return  type.name + this.typeArgsToCode(type.typeArgs);

			case 'literal':
				return this.literalToCode(type);

			case 'template_literal':
				return '`' + type.parts.map(p => p.str + (p.exp ? '${' + this.typeToCode(p.exp) + '}' : '')).join('') + '`';

			case 'this':
				return 'this';

			case 'array':
				return withParens(this.typeToCode(type.element), ARRAY_ELEMENT_NEEDS_PARENS.has(type.element.type)) + '[]';

			case 'tuple':
				return '[' + type.elements.map(t => t.type === 'spread' ? '...' + (t.label ? t.label + ': ' : '') + this.typeToCode(t.argument)
					: t.type === 'optional' ? this.typeToCode(t.element) + '?'
					: t.type === 'labeled' ? t.label + optional(t.optional) + ': ' + this.typeToCode(t.element)
					: this.typeToCode(t)).join(', ') + ']';

			case 'union':
				return type.types.map(t => this.typeToCode(t)).join(' | ');

			case 'intersection':
				return type.types.map(t => this.typeToCode(t)).join(' & ');

			case 'function':
				return this.typeParamsToCode(type.typeParams) + this.paramsToCode(type) + ' => ' + this.typeToCode(type.returnType ?? VOID);

			case 'constructor':
				return (type.abstract ? 'abstract ' : '') + 'new '
					+ this.typeParamsToCode(type.typeParams)
					+ this.paramsToCode(type) + ' => ' + this.typeToCode(type.returnType ?? VOID);

			case 'object':
				return this.typeMemberBodyToCode(type.members);

			case 'parenthesized':
				return withParens(this.typeToCode(type.inner) );

			case 'keyof':
				return 'keyof ' + this.typeToCode(type.argument);

			case 'readonly':
				return 'readonly ' + this.typeToCode(type.argument);

			case 'typeof':
				return 'typeof ' + type.name;

			case 'indexed_access':
				return this.typeToCode(type.object) + '[' + this.typeToCode(type.index) + ']';

			case 'conditional':
				return this.typeToCode(type.checkType) + ' extends ' + this.typeToCode(type.extendsType)
					+ ' ? ' + this.typeToCode(type.trueType)
					+ ' : ' + this.typeToCode(type.falseType);

			case 'infer':
				return 'infer ' + type.name + (type.constraint ? ' extends ' + this.typeToCode(type.constraint) : '');

			case 'mapped':
				return this.mappedTypeToCode(type);

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

	mappedTypeToCode(mt: TS.MappedType): string {
		return '{ '
			+  (mt.readonly ? 'readonly ' : '')
			+ '[' + mt.keyName + ' in ' + this.typeToCode(mt.constraint)
			+ (mt.nameType ? ' as ' + this.typeToCode(mt.nameType) : '')
			+ ']'
			+ optional(mt.optional)
			+ ': ' + this.typeToCode(mt.valueType) + ' }';
	}

	typeMemberBodyToCode(members: TS.TypeMember[]): string {
		if (members.length === 0)
			return '{}';
		return '{ ' + members.map(m => this.typeMemberToCode(m)).join('; ') + ' }';
	}

	// A computed member name is always the restricted `IDENT ('.' IDENT)*` shape ts-parser.ts's `type_member_computed_name` builds, never a
	// general expression -- so this doesn't need the full (instance-method) `exprToCode`.
	static computedTypeMemberKeyToCode(e: Expr): string {
		return e.type === 'member' ? this.computedTypeMemberKeyToCode(e.object) + '.' + e.property : e.type === 'identifier' ? e.name : '??';
	}

	static typeMemberNameToCode(key: Key): string {
		return typeof key === 'string' ? (isValidIdentifier(key) ? key : JSON.stringify(key)) : '[' + this.computedTypeMemberKeyToCode(key.computed) + ']';
	}

	typeMemberToCode(member: TS.TypeMember): string {
		switch (member.kind) {
			case 'property':
				return (member.readonly ? 'readonly ' : '')
					+	TSoutput.typeMemberNameToCode(member.name)
					+	optional(member.optional)
					+	': ' + this.typeToCode(member.typeAnnotation);

			case 'method':
				return TSoutput.typeMemberNameToCode(member.name)
					+ optional(member.optional)
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
	paramListToCode(params: JS.Param[], rest?: Rest): string {
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

	indentBlock(stmts: TS.Statement[], indent = this.opts.indent): string {
		return indentCode(stmts.map(s => this.statementToCode(s)), indent);
	}
	dependentCode(stmt: TS.Statement): string {
		if (stmt.type !== 'block')
			return '\n' + this.indentBlock([stmt]);
		return '{\n' + this.indentBlock(stmt.body) + '\n}';
	}

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
				return stmt.const ? 'const ' : '' + 'enum ' + stmt.name + ' {\n' + indentCode(stmt.members.map(m =>
					'  ' + m.name + (m.init ? ' = ' + this.exprToCode(m.init, 2) : '')
				), this.opts.indent) + '\n}';

			case 'namespace_decl':
				if (stmt.ambient)
					return 'declare namespace ' + stmt.name + ';';
				return 'namespace ' + stmt.name + ' {\n' + this.indentBlock(stmt.body) + '\n}';

			case 'block':
				return '{\n' + this.indentBlock(stmt.body) + '\n}';

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
				return 'for (' + (stmt.init
					? (stmt.init.type === 'var_decl'
						? this.varDeclsToCode(stmt.init)
						: this.exprToCode(stmt.init)
					) : ''
				) + '; ' + (stmt.test ? this.exprToCode(stmt.test) : '') + '; ' + (stmt.update ? this.exprToCode(stmt.update) : '') + ') '
				 + this.dependentCode(stmt.body);

			case 'for_in':
				return 'for ' + (stmt.kind === 'of await' ? 'await ' : '') + withParens(
					(stmt.init && stmt.init.type === 'var_decl'
						? this.varDeclsToCode(stmt.init)
						: this.exprToCode(stmt.init)
					)
					+ ' ' + (stmt.kind === 'of await' ? 'of' : stmt.kind)
					+ ' ' + this.exprToCode(stmt.right)
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
				return 'switch (' + this.exprToCode(stmt.discriminant) + ') {\n' + indentCode(
					stmt.cases.map(c =>
						(c.test ? 'case ' + this.exprToCode(c.test) : 'default') + ':\n' + this.indentBlock(c.consequent)
					), this.opts.indent)
					+ '\n}';

			case 'throw':
				return 'throw ' + this.exprToCode(stmt.argument) + ';';

			case 'try':
				return 'try {\n' + this.indentBlock(stmt.block) + '\n}'
					+ (stmt.handlerBody ? ' catch' + (stmt.handlerParam ? ' (' + stmt.handlerParam + ')' : '') + ' {\n' + this.indentBlock(stmt.handlerBody) + '\n}' : '')
					+ (stmt.finalizer ? ' finally {\n' + this.indentBlock(stmt.finalizer) + '\n}' : '');

			case 'debugger':
				return 'debugger;';

			case 'function_decl':
				return (stmt.ambient ? 'declare ' : '')
					+ ((hasMod(stmt, 'async') ? 'async ' : '') + 'function ' + (hasMod(stmt, 'generator') ? '*' : '') + stmt.name)
					+ this.typeParamsToCode(stmt.typeParams as TS.TypeParam[])
					+ this.paramListToCode(stmt.params, stmt.rest)
					+ this.typeAnnotationToCode(stmt.returnType as Type)
					+ (stmt.body ? ' {\n' + this.indentBlock(stmt.body) + '\n}' : ';');

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
					+ (stmt.implementsClause ? ' implements ' + (stmt.implementsClause as Type[]).map(t => this.typeToCode(t)).join(', ') : '')
					+ ' {\n' + indentCode(stmt.body.map(m => this.classMemberToCode(m)), this.opts.indent) + '\n}';

			default:
				throw new Error(`Unknown statement: ${(stmt as any).type}`);
		}
	}

	varDeclsToCode(x: {kind: JS.DeclarationKind, declarations: JS.VarDeclarator[]}) {
		return x.kind + ' ' + x.declarations.map(decl =>
			this.bindingTargetToCode(decl.name)
			+ (decl.definite ? '!' : '')
			+ (decl.typeAnnotation ? ': ' + this.typeToCode(decl.typeAnnotation as Type) : '')
			+ (decl.init ? ' = ' + this.exprToCode(decl.init, 2) : '')
		).join(', ');
	}

	classMemberToCode(member: TS.ClassMember): string {
		if (member.type === 'static_block')
			return '  static {\n' + this.indentBlock(member.body, this.opts.indent + this.opts.indent) + '\n  }';

		// `'optional'` renders as a trailing `?`, not a prefix keyword like the rest (`public`/`static`/...).
		const memberPrefix = member.modifiers?.filter(m => m !== 'optional' && m !== 'definite');
		let result = memberPrefix?.length ? memberPrefix.join(' ') + ' ' : '';

		if (member.type === 'field') {
			result	+= this.memberKeyToCode(member.key)
					+ (hasMod(member, 'optional') ? '?' : hasMod(member, 'definite') ? '!' : '')
					+ (member.typeAnnotation ? ': ' + this.typeToCode(member.typeAnnotation as Type) : '')
					+ (member.value ? ' = ' + this.exprToCode(member.value, 2) : '')
					+ ';';

		} else if (member.type === 'method') {
			result	+= (member.kind === 'get' ? 'get ' : member.kind === 'set' ? 'set ' : '')
					+ (hasMod(member, 'async') ? 'async ' : '')
					+ (hasMod(member, 'generator') ? '*' : '')
					+ this.memberKeyToCode(member.key)
					+ optional(hasMod(member, 'optional'))
					+ this.typeParamsToCode(member.typeParams as TS.TypeParam[])
					+ this.paramListToCode(member.params, member.rest)
					+ this.typeAnnotationToCode(member.returnType as Type)
					+ member.body ? ' {\n' + this.indentBlock(member.body!, this.opts.indent + this.opts.indent) + '\n  }' : ';';

/*		} else if (member.type === 'method_signature') {
			result	+= (member.kind ? member.kind + ' ' : '')
					+ this.memberKeyToCode(member.key)
					+ optional(hasMod(member, 'optional'))
					+ this.typeParamsToCode(member.typeParams as TS.TypeParam[])
					+ this.paramListToCode(member.params, member.rest)
					+ this.typeAnnotationToCode(member.returnType as Type)
					+ ';';
*/
		} else if (member.type === 'index_signature') {
			result	+= '[' + member.paramName + ': ' + this.typeToCode(member.paramType) + ']: '
					+ this.typeToCode(member.typeAnnotation) + ';';
		}

		return result;
	}

	memberKeyToCode(key: Key): string {
		return typeof key === 'string'
			? isValidIdentifier(key) ? key : JSON.stringify(key)
			: '[' + this.exprToCode(key.computed, 2) + ']';
	}

	templatePartsToCode(parts: JS.TemplatePart[]): string {
		return '`' + parts.map(p => p.str + (p.exp ? '${' + this.exprToCode(p.exp) + '}' : '')).join('') + '`';
	}

	literalToCode(expr: JS.Literal) {
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
				return '{ ' + expr.properties.map((p: any) => {
					if (p.kind === 'spread')
						return '...' + this.exprToCode(p.argument, 2);
					const key = this.memberKeyToCode(p.key);
					if (p.kind === 'get')
						return 'get ' + key + '() {\n' + this.indentBlock(p.value.body) + '\n}';
					if (p.kind === 'set')
						return 'set ' + key + this.paramListToCode(p.value.params, p.value.rest) + ' {\n' + this.indentBlock(p.value.body) + '\n}';
					return key + ': ' + this.exprToCode(p.value, 2);
				}).join(', ') + ' }';

			case 'function':
				return (hasMod(expr, 'async') ? 'async ' : '')
					+ 'function' + (hasMod(expr, 'generator') ? '*' : '') + (expr.name ? ' ' + expr.name : '')
					+ this.typeParamsToCode(expr.typeParams as TS.TypeParam[])
					+ this.paramListToCode(expr.params, expr.rest)
					+ this.typeAnnotationToCode(expr.returnType as Type)
					+ ' {\n' + this.indentBlock(expr.body!) + '\n}';

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
				return expr.operator + (expr.operator.match(/\w+/) ? ' ' : '') + this.exprToCode(expr.argument, 16);

			case 'unary_post':
				return this.exprToCode(expr.argument, 18) + expr.operator;

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
				return '...' + this.exprToCode(expr.argument, 2);

			case 'tagged_template':
				return this.exprToCode(expr.tag, 18) + this.templatePartsToCode(expr.quasi);

			case 'arrow': {
				return (hasMod(expr, 'async') ? 'async ' : '') + this.typeParamsToCode(expr.typeParams as TS.TypeParam[])
					+ (!expr.typeParams && !expr.returnType && expr.params.length === 1 && !expr.rest && typeof expr.params[0].key === 'string'
						? expr.params[0].key
						: this.paramListToCode(expr.params, expr.rest)
					)
					+ this.typeAnnotationToCode(expr.returnType as Type)
					+ ' => '
					+ (Array.isArray(expr.body)
						? '{\n' + this.indentBlock(expr.body) + '\n}'
						: arrowParens(this.exprToCode(expr.body, 2))	// Body is `assignment_expression` (tier 2) -- but an object literal body additionally needs parens regardless of precedence, or `{` would be read as the arrow's block body instead (the same ambiguity real TS. requires `() => ({})` for).
					);
			}

			case 'yield':
				return 'yield' + (expr.delegate ? '*' : '') + (expr.argument ? ' ' + this.exprToCode(expr.argument, 2) : '');

			case 'class':
				return 'class' + (expr.name ? ' ' + expr.name : '')
					+ this.typeParamsToCode(expr.typeParams as TS.TypeParam[])
					+ (expr.superClass ? ' extends ' + this.exprToCode(expr.superClass, 18) : '')
					+ (expr.implementsClause ? ' implements ' + (expr.implementsClause as Type[]).map(t => this.typeToCode(t)).join(', ') : '')
					+ ' {\n' + (expr.body as TS.ClassMember[]).map(m => this.classMemberToCode(m)).join('\n') + '\n}';

			case 'as_expression':
				return this.exprToCode(expr.expression, 11) + ' as ' + this.typeToCode(expr.typeAnnotation as Type);

			case 'satisfies_expression':
				return this.exprToCode(expr.expression, 11) + ' satisfies ' + this.typeToCode(expr.typeAnnotation as Type);

			case 'instantiation':
				return this.exprToCode(expr.expression, 18) + this.typeArgsToCode(expr.typeArgs as Type[]);

			default:
				return String(expr);
		}
	}
}
