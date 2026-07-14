/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-this-alias */
import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Expr, BindingTarget, Key, NameAndType } from './js-parser';
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
const WORD_UNARY_OPS = new Set(['typeof', 'void', 'delete']);

function exprPrecedence(expr: Expr): number {
	switch (expr.type) {
		case 'sequence':			return 1;
		case 'assign':
		case 'yield':
		case 'arrow':				return 2;
		case 'conditional':			return 3;
		case 'binary':
		case 'logical':				return BINARY_PREC[expr.operator] ?? 0;
		case 'as_expression':
		case 'satisfies_expression':return 11;
		case 'await':
		case 'unary':				return 16;
		case 'update':				return expr.prefix ? 16 : 17;
		default:					return 18;
	}
}

function indentCode(lines: string[], indent: string): string {
	return indent + lines.join('\n' + indent);
}

function withParens(x: string, parens = true)	{
	return parens ? '(' + x + ')' : x;
}

// A compound element type needs parens as an array element, or it re-parses with the wrong
// precedence -- `(A | B)[]` printed without them becomes `A | B[]` (only `B` is the element).
const ARRAY_ELEMENT_NEEDS_PARENS = new Set(['union', 'intersection', 'function', 'constructor', 'conditional']);

export class TSoutput {
	opts: CodegenOptions = {
		indent: '  '
	};
	// Parsing merges `{foo: 1}` and `{'foo': 1}` into the same plain-string `key`, so regenerating always-bare
	// breaks any key that isn't a valid identifier on its own (e.g. `'filter-out': ...`).
	static isValidIdentifier(s: string) { return /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u.test(s); }

	static needsNullishParens(parentOp: string, child: any): boolean {
		const childOp = child?.type === 'logical' ? child.operator : undefined;
		return (parentOp === '??' && (childOp === '&&' || childOp === '||'))
			|| ((parentOp === '&&' || parentOp === '||') && childOp === '??');
	}

	static needsAsIntersectionParens(parentOp: string, child: any): boolean {
		return parentOp === '&' && (child?.type === 'as_expression' || child?.type === 'satisfies_expression');
	}

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
				if (type.value === null)
					return 'null';
				if (typeof type.value === 'string')
					return JSON.stringify(type.value);
				return String(type.value);

			case 'template_literal':
				return '`' + type.parts.map(p => p.str + (p.exp ? '${' + this.typeToCode(p.exp) + '}' : '')).join('') + '`';

			case 'this':
				return 'this';

			case 'array':
				return withParens(this.typeToCode(type.element), ARRAY_ELEMENT_NEEDS_PARENS.has(type.element.type)) + '[]';

			case 'tuple':
				return '[' + type.elements.map(t => t.type === 'spread' ? '...' + (t.label ? t.label + ': ' : '') + this.typeToCode(t.argument)
					: t.type === 'optional' ? this.typeToCode(t.element) + '?'
					: t.type === 'labeled' ? t.label + (t.optional ? '?' : '') + ': ' + this.typeToCode(t.element)
					: this.typeToCode(t)).join(', ') + ']';

			case 'union':
				return type.types.map(t => this.typeToCode(t)).join(' | ');

			case 'intersection':
				return type.types.map(t => this.typeToCode(t)).join(' & ');

			case 'function':
				return this.typeParamsToCode(type.typeParams) + this.paramsToCode(type) + ' => ' + this.typeToCode(type.returnType!);

			case 'constructor':
				return (type.abstract ? 'abstract ' : '') + 'new '
					+ this.typeParamsToCode(type.typeParams)
					+ this.paramsToCode(type) + ' => ' + this.typeToCode(type.returnType!);

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
				return this.typeToCode(type.checkType) + ' extends ' + this.typeToCode(type.extendsType) +
					' ? ' + this.typeToCode(type.trueType) +
					' : ' + this.typeToCode(type.falseType);

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
		let result = '{ ';
		if (mt.readonly)
			result += 'readonly ';
		result += '[' + mt.keyName + ' in ' + this.typeToCode(mt.constraint);
		if (mt.nameType)
			result += ' as ' + this.typeToCode(mt.nameType);
		result += ']';
		if (mt.optional)
			result += '?';
		result += ': ' + this.typeToCode(mt.valueType) + ' }';
		return result;
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
		return typeof key === 'string' ? (this.isValidIdentifier(key) ? key : JSON.stringify(key)) : '[' + this.computedTypeMemberKeyToCode(key.computed) + ']';
	}

	typeMemberToCode(member: TS.TypeMember): string {
		switch (member.kind) {
			case 'property': {
				let result = '';
				if (member.readonly)
					result += 'readonly ';
				result += TSoutput.typeMemberNameToCode(member.name);
				if (member.optional)
					result += '?';
				result += ': ' + this.typeToCode(member.typeAnnotation);
				return result;
			}

			case 'method': {
				let result = TSoutput.typeMemberNameToCode(member.name);
				if (member.optional)
					result += '?';
				result += this.typeParamsToCode(member.typeParams);
				result += this.paramsToCode(member);
				result += this.typeAnnotationToCode(member.returnType);
				return result;
			}

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
		return typeParams ? ('<' + typeParams.map(param => {
			let result = (param.const ? 'const ' : '') + param.name;
			if (param.constraint)
				result += ' extends ' + this.typeToCode(param.constraint);
			if (param.default)
				result += ' = ' + this.typeToCode(param.default);
			return result;
		}).join(', ') + '>') : '';
	}

	paramsToCode(params: TS.ParamList): string {
		const a = params.params.map(p => p.key + (hasMod(p, 'optional') ? '?' : '') + this.typeAnnotationToCode(p.typeAnnotation));
		if (params.rest)
			a.push('...' + params.rest?.key + this.typeAnnotationToCode(params.rest?.typeAnnotation));
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
	paramListToCode(params: JS.Param[], rest?: NameAndType): string {
		const parts = params.map(param => {
			let result = '';
			// `'optional'` renders as a trailing `?`, not a prefix keyword like the rest (`public`/`readonly`/...).
			const prefix = param.modifiers?.filter(m => m !== 'optional');
			if (prefix?.length)
				result += prefix.join(' ') + ' ';
			result += this.bindingTargetToCode(param.key);
			if (hasMod(param, 'optional'))
				result += '?';
			if (param.typeAnnotation)
				result += ': ' + this.typeToCode(param.typeAnnotation as Type);
			if (param.default)
				result += ' = ' + this.exprToCode(param.default, 2);
			return result;
		});
		if (rest)
			parts.push('...' + rest.key + (rest.typeAnnotation ? ': ' + this.typeToCode(rest.typeAnnotation as Type) : ''));
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

			case 'interface_decl': {
				let result = 'interface ' + stmt.name;
				result += this.typeParamsToCode(stmt.typeParams);
				if (stmt.extendsClause)
					result += ' extends ' + stmt.extendsClause.map(t => this.typeToCode(t)).join(', ');
				result += ' ' + this.typeMemberBodyToCode(stmt.body);
				return result;
			}

			case 'enum_decl':
				return stmt.const ? 'const ' : '' + 'enum ' + stmt.name + ' {\n' + indentCode(stmt.members.map(m =>
					'  ' + m.name + (m.init ? ' = ' + this.exprToCode(m.init, 2) : '')
				), this.opts.indent) + '\n}';

			case 'namespace_decl':
				return 'namespace ' + stmt.name + ' {\n' + this.indentBlock(stmt.body) + '\n}';

			case 'declare':
				return 'declare ' + this.statementToCode(stmt.declaration as TS.Declaration);

			case 'block':
				return '{\n' + this.indentBlock(stmt.body) + '\n}';

			case 'var':
				return this.varDeclsToCode(stmt) + ';';

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
					? (stmt.init.type === 'var'
						? this.varDeclsToCode(stmt.init)
						: this.exprToCode(stmt.init)
					) : ''
				) + '; ' + (stmt.test ? this.exprToCode(stmt.test) : '') + '; ' + (stmt.update ? this.exprToCode(stmt.update) : '') + ') '
				 + this.dependentCode(stmt.body);

			case 'for_in':
				return 'for ' + (stmt.await ? 'await ' : '') + withParens(
					(stmt.left && stmt.left.type === 'var'
						? this.varDeclsToCode(stmt.left)
						: this.exprToCode(stmt.left)) +
					' ' + stmt.kind + ' ' + this.exprToCode(stmt.right)
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

			case 'try': {
				let result = 'try {\n' + this.indentBlock(stmt.block) + '\n}';
				if (stmt.handlerBody)
					result += ' catch' + (stmt.handlerParam ? ' (' + stmt.handlerParam + ')' : '') + ' {\n' + this.indentBlock(stmt.handlerBody) + '\n}';
				if (stmt.finalizer)
					result += ' finally {\n' + this.indentBlock(stmt.finalizer) + '\n}';
				return result;
			}

			case 'debugger':
				return 'debugger;';

			case 'function_decl':
				return ((hasMod(stmt, 'async') ? 'async ' : '') + 'function ' + (hasMod(stmt, 'generator') ? '*' : '') + stmt.name)
					+ this.typeParamsToCode(stmt.typeParams as TS.TypeParam[])
					+ this.paramListToCode(stmt.params, stmt.rest)
					+ this.typeAnnotationToCode(stmt.returnType as Type)
					+ (stmt.body ? ' {\n' + this.indentBlock(stmt.body) + '\n}' : ';');

			case 'import': {
				// Bare side-effect import (`import 'x';`) has no binding at all -- no `from` clause either,
				// unlike every other shape below (which all bind at least one name to the module).
				if (!stmt.default && !stmt.namespace && !stmt.specifiers?.length)
					return 'import ' + JSON.stringify(stmt.source) + ';';
				let result = 'import ' + (stmt.typeOnly ? 'type ' : '');
				if (stmt.default) {
					result += stmt.default;
					if (stmt.namespace || stmt.specifiers?.length)
						result += ', ';
				}
				// `namespace`/`specifiers` are mutually exclusive in real JS -- `else if`, not two independent `if`s, avoids a stray extra comma.
				if (stmt.namespace)
					result += '* as ' + stmt.namespace;
				else if (stmt.specifiers?.length)
					result += '{ ' + stmt.specifiers.map(s => (s.typeOnly ? 'type ' : '') + s.imported + (s.local !== s.imported ? ' as ' + s.local : '')).join(', ') + ' }';
				result += ' from ' + JSON.stringify(stmt.source) + ';';
				return result;
			}

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

			case 'class_decl': {
				let result = stmt.abstract ? 'abstract ' : '';
				result += 'class ' + stmt.name;
				result += this.typeParamsToCode(stmt.typeParams as TS.TypeParam[]);
				if (stmt.superClass)
					result += ' extends ' + this.exprToCode(stmt.superClass, 18);
				if (stmt.implementsClause)
					result += ' implements ' + (stmt.implementsClause as Type[]).map(t => this.typeToCode(t)).join(', ');
				result += ' {\n' + indentCode(stmt.body.map(m => this.classMemberToCode(m)), this.opts.indent) + '\n}';
				return result;
			}

			default:
				throw new Error(`Unknown statement: ${(stmt as any).type}`);
		}
	}

	varDeclsToCode(x: {kind: JS.DeclarationKind, declarations: JS.VarDeclarator[]}) {
		return x.kind + ' ' + x.declarations.map(decl => {
			let result =this.bindingTargetToCode(decl.name);
			if (decl.typeAnnotation)
				result += ': ' + this.typeToCode(decl.typeAnnotation as Type);
			if (decl.definite)
				result = result.replace(/:/, '!:');
			if (decl.init)
				result += ' = ' + this.exprToCode(decl.init, 2);
			return result;
		}).join(', ');
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
			const fn = member.value;
			result	+= (member.kind === 'get' ? 'get ' : member.kind === 'set' ? 'set ' : '')
					+ (hasMod(fn, 'async') ? 'async ' : '')
					+ (hasMod(fn, 'generator') ? '*' : '')
					+ this.memberKeyToCode(member.key)
					+ (hasMod(member, 'optional') ? '?' : '')
					+ this.typeParamsToCode(fn.typeParams as TS.TypeParam[])
					+ this.paramListToCode(fn.params, fn.rest)
					+ this.typeAnnotationToCode(fn.returnType as Type)
					+ ' {\n' + this.indentBlock(fn.body!, this.opts.indent + this.opts.indent) + '\n  }';

		} else if (member.type === 'method_signature') {
			result	+= (member.kind ? member.kind + ' ' : '')
					+ this.memberKeyToCode(member.key)
					+ (hasMod(member, 'optional') ? '?' : '')
					+ this.typeParamsToCode(member.typeParams as TS.TypeParam[])
					+ this.paramListToCode(member.params, member.rest)
					+ this.typeAnnotationToCode(member.returnType as Type)
					+ ';';

		} else if (member.type === 'index_signature') {
			result	+= '[' + member.paramName + ': ' + this.typeToCode(member.paramType) + ']: '
					+ this.typeToCode(member.typeAnnotation) + ';';
		}

		return result;
	}

	memberKeyToCode(key: Key): string {
		if (typeof key === 'string')
			return TSoutput.isValidIdentifier(key) ? key : JSON.stringify(key);
		return '[' + this.exprToCode(key.computed, 2) + ']';
	}

	templatePartsToCode(parts: JS.TemplatePart[]): string {
		return '`' + parts.map(p => p.str + (p.exp ? '${' + this.exprToCode(p.exp) + '}' : '')).join('') + '`';
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
				// An *untagged* template literal: js-parser.ts parses `` `...` `` as `{ type: 'literal', value: <TemplatePart[]> }`, no separate node type.
				if (Array.isArray(expr.value))
					return this.templatePartsToCode(expr.value);
				if (expr.value === null)
					return 'null';
				if (typeof expr.value === 'string')
					return JSON.stringify(expr.value);
				return String(expr.value);

			case 'regex':
				return '/' + expr.pattern + '/' + (expr.flags || '');

			case 'bigint':
				return expr.value + 'n';

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
					+ (expr.optional ? '?.' : '') + withParens(expr.arguments.map((a: Expr) => this.exprToCode(a, 2)).join(', '));

			case 'new':
				return 'new ' + this.exprToCode(expr.callee, 18)
					+ this.typeArgsToCode(expr.typeArgs as Type[])
					+ withParens(expr.arguments.map((a: Expr) => this.exprToCode(a, 2)).join(', ') );

			case 'unary':
				// Operand is `unary_expression` (self) in the grammar -- same tier, so chained unaries
				// (`!!x`, `typeof typeof x`) don't need parens, but anything looser (e.g. `-(a + b)`) does.
				return expr.operator + (WORD_UNARY_OPS.has(expr.operator) ? ' ' : '') + this.exprToCode(expr.argument, 16);

			case 'update':
				// Prefix `++`/`--`'s operand is `unary_expression` (tier 16); postfix's is restricted to
				// `left_hand_side_expression` (tier 18) -- see postfix_expression/unary_expression in js-parser.ts.
				return expr.prefix
					? expr.operator + this.exprToCode(expr.argument, 16)
					: this.exprToCode(expr.argument, 18) + expr.operator;

			case 'binary':
			case 'logical': {
				const op	= expr.operator;
				const prec	= BINARY_PREC[op] ?? 0;
				return withParens(this.exprToCode(expr.left, op === '**' ? 16 : prec), TSoutput.needsNullishParens(op, expr.left) || TSoutput.needsAsIntersectionParens(op, expr.left))
					+ ' ' + op + ' '
					+ withParens(this.exprToCode(expr.right, op === '**' ? 15 : prec + 1), TSoutput.needsNullishParens(op, expr.right));
			}

			case 'assign':
				return this.exprToCode(expr.left, 18) + ' ' + expr.operator + ' ' + this.exprToCode(expr.right, 2);

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
				let result = (hasMod(expr, 'async') ? 'async ' : '') + this.typeParamsToCode(expr.typeParams as TS.TypeParam[])
					+ (!expr.typeParams && !expr.returnType && expr.params.length === 1 && !expr.rest && typeof expr.params[0].key === 'string'
						? expr.params[0].key
						: this.paramListToCode(expr.params, expr.rest)
					)
					+ this.typeAnnotationToCode(expr.returnType as Type)
					+ ' => ';
					
				if (Array.isArray(expr.body)) {
					result += '{\n' + this.indentBlock(expr.body) + '\n}';
				} else {
					// Body is `assignment_expression` (tier 2) -- but an object literal body additionally needs parens regardless of precedence, or `{` would be read as the arrow's block body instead (the same ambiguity real TS. requires `() => ({})` for).
					const body = this.exprToCode(expr.body, 2);
					result += withParens(body, body.startsWith('{'));
				}
				return result;
			}

			case 'yield':
				return 'yield' + (expr.delegate ? '*' : '') + (expr.argument ? ' ' + this.exprToCode(expr.argument, 2) : '');

			case 'await':
				return 'await ' + this.exprToCode(expr.argument, 16);

			case 'class': {
				let result = 'class' + (expr.name ? ' ' + expr.name : '')
					+ this.typeParamsToCode(expr.typeParams as TS.TypeParam[]);
				if (expr.superClass)
					result += ' extends ' + this.exprToCode(expr.superClass, 18);
				if (expr.implementsClause)
					result += ' implements ' + (expr.implementsClause as Type[]).map(t => this.typeToCode(t)).join(', ');
				result += ' {\n' + (expr.body as TS.ClassMember[]).map(m => this.classMemberToCode(m)).join('\n') + '\n}';
				return result;
			}

			case 'as_expression':
				return this.exprToCode(expr.expression, 11) + ' as ' + this.typeToCode(expr.typeAnnotation as Type);

			case 'satisfies_expression':
				return this.exprToCode(expr.expression, 11) + ' satisfies ' + this.typeToCode(expr.typeAnnotation as Type);

			case 'non_null':
				return this.exprToCode(expr.expression, 18) + '!';

			default:
				return String(expr);
		}
	}
}
