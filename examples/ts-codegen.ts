import { TSType, TSTypeParam, TSParam, TSTypeMember, TSDeclaration, TSStatement, TSProgram, TSMappedType } from './ts-parser';
import { Expr, Statement, ClassMember, VarDeclarator, BindingTarget, Param, TemplatePart } from './js-parser';


// ===================================================================
//  Type Guards
// ===================================================================

function guard<R>(types: string[]) {
	const set = new Set(types);
	return (node: any): node is R => node && typeof node === 'object' && 'type' in node && set.has(node.type);
}

const stmts = ['block', 'var', 'expression', 'empty', 'if', 'do_while', 'while', 'for', 'for_in', 'continue', 'break', 'return', 'with', 'labeled', 'switch', 'throw', 'try', 'debugger', 'function_decl', 'import', 'export_named', 'export_all', 'export_default', 'export_decl', 'class_decl'];

const isProgram 		= guard<TSProgram>(['program']);
const isType 			= guard<TSType>(['ref', 'literal', 'template_literal', 'this', 'array', 'tuple', 'union', 'intersection', 'function', 'constructor', 'object', 'parenthesized', 'keyof', 'readonly', 'typeof', 'indexed_access', 'conditional', 'infer', 'mapped', 'predicate']);
const isTsDeclaration 	= guard<TSDeclaration>(['type_alias_decl', 'interface_decl', 'enum_decl']);
const isTsStatement 	= guard<TSStatement>(['declare', ...stmts]);
const isJsStatement 	= guard<Statement>(stmts);

/**
 * Converts a TypeScript AST back to valid TypeScript code.
 */
export function tsToCode(ast: TSProgram | TSStatement | TSType | Expr): string {
	if (isProgram(ast))
		return ast.body.map(stmt => statementToCode(stmt)).join('\n');
	if (isType(ast))
		return typeToCode(ast);
	if (isTsDeclaration(ast))
		return declarationToCode(ast);
	if (isTsStatement(ast))
		return statementToCode(ast);
	return exprToCode(ast as Expr);
}


// ===================================================================
//  Types
// ===================================================================

function typeToCode(type: TSType): string {
	switch (type.type) {
		case 'ref': {
			let result = type.name;
			if (type.typeArgs)
				result += '<' + type.typeArgs.map(t => typeToCode(t)).join(', ') + '>';
			return result;
		}

		case 'literal':
			if (type.value === null)
				return 'null';
			if (typeof type.value === 'string')
				return JSON.stringify(type.value);
			return String(type.value);

		case 'template_literal':
			return '`' + type.parts.map(p => p.str + (p.exp ? '${' + typeToCode(p.exp) + '}' : '')).join('') + '`';

		case 'this':
			return 'this';

		case 'array':
			return typeToCode(type.element) + '[]';

		case 'tuple':
			return '[' + type.elements.map(t => t.type === 'spread' ? '...' + typeToCode(t.argument) : typeToCode(t)).join(', ') + ']';

		case 'union':
			return type.types.map(t => typeToCode(t)).join(' | ');

		case 'intersection':
			return type.types.map(t => typeToCode(t)).join(' & ');

		case 'function':
			return (type.typeParams ? '<' + type.typeParams.map(p => typeParamToCode(p)).join(', ') + '>' : '')
				+ '(' + type.params.map(p => paramToCode(p)).join(', ') + ') => ' + typeToCode(type.returnType);

		case 'constructor':
			return (type.abstract ? 'abstract ' : '') + 'new ' + (type.typeParams ? '<' + type.typeParams.map(p => typeParamToCode(p)).join(', ') + '>' : '')
				+ '(' + type.params.map(p => paramToCode(p)).join(', ') + ') => ' + typeToCode(type.returnType);

		case 'object':
			return typeMemberBodyToCode(type.members);

		case 'parenthesized':
			return '(' + typeToCode(type.inner) + ')';

		case 'keyof':
			return 'keyof ' + typeToCode(type.argument);

		case 'readonly':
			return 'readonly ' + typeToCode(type.argument);

		case 'typeof':
			return 'typeof ' + type.name;

		case 'indexed_access':
			return typeToCode(type.object) + '[' + typeToCode(type.index) + ']';

		case 'conditional':
			return typeToCode(type.checkType) + ' extends ' + typeToCode(type.extendsType) +
				' ? ' + typeToCode(type.trueType) +
				' : ' + typeToCode(type.falseType);

		case 'infer':
			return 'infer ' + type.name + (type.constraint ? ' extends ' + typeToCode(type.constraint) : '');

		case 'mapped':
			return mappedTypeToCode(type);

		case 'predicate':
			return type.paramName + ' is ' + typeToCode(type.assertedType);

		default: {
			const _never: never = type;
			throw new Error(`Unknown type: ${(_never as any).type}`);
		}
	}
}

function mappedTypeToCode(mt: TSMappedType): string {
	let result = '{ ';
	if (mt.readonly)
		result += 'readonly ';
	result += '[' + mt.keyName + ' in ' + typeToCode(mt.constraint);
	if (mt.nameType)
		result += ' as ' + typeToCode(mt.nameType);
	result += ']';
	if (mt.optional)
		result += '?';
	result += ': ' + typeToCode(mt.valueType) + ' }';
	return result;
}

function typeMemberBodyToCode(members: TSTypeMember[]): string {
	if (members.length === 0)
		return '{}';
	return '{ ' + members.map(m => typeMemberToCode(m)).join('; ') + ' }';
}

function typeMemberToCode(member: TSTypeMember): string {
	switch (member.kind) {
		case 'property': {
			let result = '';
			if (member.readonly)
				result += 'readonly ';
			result += member.name;
			if (member.optional)
				result += '?';
			result += ': ' + typeToCode(member.typeAnnotation);
			return result;
		}

		case 'method': {
			let result = member.name;
			if (member.optional)
				result += '?';
			if (member.typeParams)
				result += '<' + member.typeParams.map(p => typeParamToCode(p)).join(', ') + '>';
			result += '(' + member.params.map(p => paramToCode(p)).join(', ') + ')';
			if (member.returnType)
				result += ': ' + typeToCode(member.returnType);
			return result;
		}

		case 'index':
			return '[' + member.paramName + ': ' + typeToCode(member.paramType) + ']: ' + typeToCode(member.typeAnnotation);

		case 'call':
			return '(' + member.params.map(p => paramToCode(p)).join(', ') + '): ' + (member.returnType ? typeToCode(member.returnType) : 'void');

		default: {
			const _never: never = member;
			throw new Error(`Unknown member kind: ${(_never as any).kind}`);
		}
	}
}

// ===================================================================
//  Type Parameters and Parameters
// ===================================================================

function typeParamToCode(param: TSTypeParam): string {
	let result = param.name;
	if (param.constraint)
		result += ' extends ' + typeToCode(param.constraint);
	if (param.default)
		result += ' = ' + typeToCode(param.default);
	return result;
}

function paramToCode(param: TSParam): string {
	let result = '';
	if (param.rest)
		result += '...';
	result += param.name;
	if (param.optional)
		result += '?';
	if (param.typeAnnotation)
		result += ': ' + typeToCode(param.typeAnnotation);
	return result;
}

// ===================================================================
//  Declarations
// ===================================================================

function declarationToCode(decl: TSDeclaration): string {
	switch (decl.type) {
		case 'type_alias_decl':
			return typeAliasDeclToCode(decl);

		case 'interface_decl':
			return interfaceDeclToCode(decl);

		case 'enum_decl':
			return enumDeclToCode(decl);

		default: {
			const _never: never = decl;
			throw new Error(`Unknown declaration: ${(_never as any).type}`);
		}
	}
}

function typeAliasDeclToCode(decl: Extract<TSDeclaration, { type: 'type_alias_decl' }>): string {
	let result = 'type ' + decl.name;
	if (decl.typeParams)
		result += '<' + decl.typeParams.map(p => typeParamToCode(p)).join(', ') + '>';
	result += ' = ' + typeToCode(decl.value) + ';';
	return result;
}

function interfaceDeclToCode(decl: Extract<TSDeclaration, { type: 'interface_decl' }>): string {
	let result = 'interface ' + decl.name;
	if (decl.typeParams)
		result += '<' + decl.typeParams.map(p => typeParamToCode(p)).join(', ') + '>';
	if (decl.extendsClause)
		result += ' extends ' + decl.extendsClause.map(t => typeToCode(t)).join(', ');
	result += ' ' + typeMemberBodyToCode(decl.body);
	return result;
}

function enumDeclToCode(decl: Extract<TSDeclaration, { type: 'enum_decl' }>): string {
	let result = '';
	if (decl.const)
		result += 'const ';
	result += 'enum ' + decl.name + ' {\n';
	result += decl.members.map(m => {
		let line = '  ' + m.name;
		if (m.init)
			line += ' = ' + exprToCode(m.init, 2);
		return line;
	}).join(',\n');
	result += '\n}';
	return result;
}

// ===================================================================
//  Statements
// ===================================================================

function statementToCode(stmt: TSStatement): string {
	const node = stmt as any;

	// TypeScript-specific declarations
	if (node.type === 'type_alias_decl' || node.type === 'interface_decl' || node.type === 'enum_decl')
		return declarationToCode(node as TSDeclaration);

	// Ambient declarations
	if (node.type === 'declare') {
		const decl = node.declaration;
		return isTsDeclaration(decl)
			? 'declare ' + declarationToCode(decl)
			: 'declare ' + jsStatementToCode(decl as Statement);
	}

	// Fall back to JS statement handling
	if (isJsStatement(node))
		return jsStatementToCode(node as Statement);

	// Fallback for unknown types
	throw new Error(`Unknown statement type: ${node.type}`);
}

function dependentCode(stmt: TSStatement): string {
	if (stmt.type !== 'block')
		return '\n' + indentBlock([stmt], '  ');
	return '{\n' + indentBlock(stmt.body, '  ') + '\n}';
}


function indentBlock(stmts: TSStatement[], indent: string): string {
	return stmts.map(s => indent + statementToCode(s).split('\n').join('\n' + indent)).join('\n');
}

function jsStatementToCode(stmt: Statement): string {
	switch (stmt.type) {
		case 'block':
			return '{\n' + indentBlock(stmt.body, '  ') + '\n}';

		case 'var':
			return stmt.kind + ' ' + stmt.declarations.map(d => varDeclToCode(d)).join(', ') + ';';

		case 'expression':
			return exprToCode(stmt.expression) + ';';

		case 'empty':
			return ';';

		case 'if':
			return 'if (' + exprToCode(stmt.test) + ') ' + dependentCode(stmt.consequent) +
				(stmt.alternate ? ' else ' + dependentCode(stmt.alternate) : '');

		case 'do_while':
			return 'do ' + dependentCode(stmt.body) + ' while (' + exprToCode(stmt.test) + ');';

		case 'while':
			return 'while (' + exprToCode(stmt.test) + ') ' + dependentCode(stmt.body);

		case 'for': {
			let result = 'for (';
			if (stmt.init) {
				if (typeof stmt.init === 'object' && 'type' in stmt.init && (stmt.init as any).type === 'var') {
					const varInit = stmt.init as any;
					result += varInit.kind + ' ' + varInit.declarations.map((d: VarDeclarator) => varDeclToCode(d)).join(', ');
				} else {
					result += exprToCode(stmt.init as Expr);
				}
			}
			result += '; ' + (stmt.test ? exprToCode(stmt.test) : '') + '; ' + (stmt.update ? exprToCode(stmt.update) : '') + ') ';
			result += dependentCode(stmt.body);
			return result;
		}

		case 'for_in':
			return 'for (' +
				(typeof stmt.left === 'object' && 'type' in stmt.left && (stmt.left as any).type === 'var'
					? ((stmt.left as any).kind + ' ' + (stmt.left as any).declarations.map((d: VarDeclarator) => varDeclToCode(d)).join(', '))
					: exprToCode(stmt.left as Expr)) +
				' ' + stmt.kind + ' ' + exprToCode(stmt.right) + ') ' + dependentCode(stmt.body);

		case 'continue':
			return 'continue' + (stmt.label ? ' ' + stmt.label : '') + ';';

		case 'break':
			return 'break' + (stmt.label ? ' ' + stmt.label : '') + ';';

		case 'return':
			return 'return' + (stmt.argument ? ' ' + exprToCode(stmt.argument) : '') + ';';

		case 'with':
			return 'with (' + exprToCode(stmt.object) + ') ' + dependentCode(stmt.body);

		case 'labeled':
			return stmt.label + ': ' + statementToCode(stmt.body);

		case 'switch':
			return 'switch (' + exprToCode(stmt.discriminant) + ') {\n' +
				stmt.cases.map(c =>
					(c.test ? '  case ' + exprToCode(c.test) : '  default') + ':\n' +
					indentBlock(c.consequent, '    ')
				).join('\n') + '\n}';

		case 'throw':
			return 'throw ' + exprToCode(stmt.argument) + ';';

		case 'try': {
			let result = 'try {\n' + indentBlock(stmt.block, '  ') + '\n}';
			if (stmt.handlerBody)
				result += ' catch (' + (stmt.handlerParam || 'e') + ') {\n' + indentBlock(stmt.handlerBody, '  ') + '\n}';
			if (stmt.finalizer)
				result += ' finally {\n' + indentBlock(stmt.finalizer, '  ') + '\n}';
			return result;
		}

		case 'debugger':
			return 'debugger;';

		case 'function_decl':
			return functionDeclToCode(stmt);

		case 'import':
			return importToCode(stmt);

		case 'export_named':
			return 'export { ' + stmt.specifiers.map(s => s.local + (s.exported !== s.local ? ' as ' + s.exported : '')).join(', ') +
				(stmt.source ? ' } from ' + JSON.stringify(stmt.source) : ' }') + ';';

		case 'export_all':
			return 'export * ' + (stmt.exported ? 'as ' + stmt.exported + ' ' : '') + 'from ' + JSON.stringify(stmt.source) + ';';

		case 'export_default':
			return 'export default ' + (isJsStatement(stmt.declaration) ? jsStatementToCode(stmt.declaration) : exprToCode(stmt.declaration)) + ';';

		case 'export_decl':
			return 'export ' + jsStatementToCode(stmt.declaration);

		case 'class_decl':
			return classDeclToCode(stmt);

		default: {
			const _never: never = stmt;
			throw new Error(`Unknown statement: ${(_never as any).type}`);
		}
	}
}

function varDeclToCode(decl: VarDeclarator): string {
	let result = bindingTargetToCode(decl.name);
	const declAny = decl as any;
	if (declAny.typeAnnotation)
		result += ': ' + typeToCode(declAny.typeAnnotation);
	if (declAny.definite)
		result = result.replace(/:/, '!:');
	if (decl.init)
		result += ' = ' + exprToCode(decl.init, 2);
	return result;
}

function functionDeclToCode(decl: Extract<Statement, { type: 'function_decl' }>): string {
	let result = '';
	if (decl.async)
		result += 'async ';
	result += 'function ' + (decl.generator ? '*' : '') + decl.name;
	const declAny = decl as any;
	if (declAny.typeParams)
		result += '<' + (declAny.typeParams as TSTypeParam[]).map(p => typeParamToCode(p)).join(', ') + '>';
	result += '(' + paramListToCode(decl.params, decl.rest, declAny.restType) + ')';
	if (declAny.returnType)
		result += ': ' + typeToCode(declAny.returnType);
	// `body` is `undefined` for a bodyless overload/ambient signature (see js-parser.ts's
	// `function_decl` variant) -- those end in `;` instead of a `{ ... }` block.
	result += decl.body ? ' {\n' + indentBlock(decl.body, '  ') + '\n}' : ';';
	return result;
}

function classDeclToCode(decl: Extract<Statement, { type: 'class_decl' }>): string {
	let result = '';
	if (decl.abstract)
		result += 'abstract ';
	result += 'class ' + decl.name;
	const declAny = decl as any;
	if (declAny.typeParams)
		result += '<' + (declAny.typeParams as TSTypeParam[]).map(p => typeParamToCode(p)).join(', ') + '>';
	if (decl.superClass)
		result += ' extends ' + exprToCode(decl.superClass, 18);
	if (declAny.implementsClause)
		result += ' implements ' + (declAny.implementsClause as TSType[]).map(t => typeToCode(t)).join(', ');
	result += ' {\n' + decl.body.map(m => classMemberToCode(m)).join('\n') + '\n}';
	return result;
}

function classMemberToCode(member: ClassMember): string {
	if (member.type === 'static_block')
		return '  static {\n' + indentBlock(member.body, '    ') + '\n  }';

	let result = '  ';
	if (member.modifiers)
		result += member.modifiers.join(' ') + ' ';
	if (member.static)
		result += 'static ';

	if (member.type === 'field') {
		result += memberKeyToCode(member.key);
		if (member.optional)
			result += '?';
		const memberAny = member as any;
		if (memberAny.typeAnnotation)
			result += ': ' + typeToCode(memberAny.typeAnnotation);
		if (memberAny.definite)
			result = result.replace(/:/, '!:');
		if (member.value)
			result += ' = ' + exprToCode(member.value, 2);
		result += ';';
	} else if (member.type === 'method') {
		if (member.kind === 'get')
			result += 'get ';
		if (member.kind === 'set')
			result += 'set ';
		const fn = member.value as Expr & { type: 'function' };
		if (fn.generator)
			result += '*';
		result += memberKeyToCode(member.key);
		if (member.optional)
			result += '?';
		const fnAny = fn as any;
		if (fnAny.typeParams)
			result += '<' + (fnAny.typeParams as TSTypeParam[]).map(p => typeParamToCode(p)).join(', ') + '>';
		result += '(' + paramListToCode(fn.params, fn.rest, fnAny.restType) + ')';
		if (fnAny.returnType)
			result += ': ' + typeToCode(fnAny.returnType);
		result += ' {\n' + indentBlock(fn.body, '    ') + '\n  }';
	} else if (member.type === 'method_signature') {
		result += memberKeyToCode(member.key);
		if (member.optional)
			result += '?';
		if (member.typeParams)
			result += '<' + (member.typeParams as TSTypeParam[]).map(p => typeParamToCode(p)).join(', ') + '>';
		result += '(' + paramListToCode(member.params, member.rest) + ')';
		if (member.returnType)
			result += ': ' + typeToCode(member.returnType as TSType);
		result += ';';
	}

	return result;
}

// Parsing merges `{foo: 1}` and `{'foo': 1}` into the same plain-string `key`, losing whether the source
// actually quoted it -- fine semantically (they mean the same thing), but regenerating always-bare breaks
// any key that isn't a valid identifier on its own (e.g. `'filter-out': ...`, found in a real file: a
// bare `filter-out` output isn't even a single valid token, let alone an identifier).
const isValidIdentifier = (s: string) => /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u.test(s);
function memberKeyToCode(key: string | { computed: Expr }): string {
	if (typeof key === 'string')
		return isValidIdentifier(key) ? key : JSON.stringify(key);
	return '[' + exprToCode(key.computed, 2) + ']';
}

function importToCode(stmt: Extract<Statement, { type: 'import' }>): string {
	let result = 'import ';
	if (stmt.default)
		result += stmt.default;
	if (stmt.default && (stmt.namespace || stmt.specifiers?.length))
		result += ', ';
	if (stmt.namespace)
		result += '* as ' + stmt.namespace;
	if ((stmt.namespace || stmt.default) && stmt.specifiers?.length)
		result += ', ';
	if (stmt.specifiers?.length)
		result += '{ ' + stmt.specifiers.map(s => s.imported + (s.local !== s.imported ? ' as ' + s.local : '')).join(', ') + ' }';
	result += ' from ' + JSON.stringify(stmt.source) + ';';
	return result;
}

// ===================================================================
//  Expressions
// ===================================================================
//
// Precedence-aware printing: most of this grammar's binary/unary/etc.
// nodes don't carry an explicit "parenthesized" wrapper (unlike TSType's
// own `parenthesized` variant) -- `'(' expression ')'` just returns the
// inner expression directly (see js-parser.ts's `primary_expression`).
// So regenerating *valid* code requires recomputing, from each node's own
// operator/type, whether its children need parens reinserted -- e.g.
// `(foo as Bar).baz` would come back out as the semantically different
// `foo as Bar.baz` if we just concatenated child output unconditionally.
// `exprPrecedence`/`exprToCode`'s `minPrec` implement exactly the
// "precedence climbing" a parser itself would do, just in reverse.

// Mirrors js-parser.ts's own `binaryChain` precedence levels exactly (multiplicative -> ... -> nullish),
// numbered so a higher number binds tighter; 'as'/'satisfies' sit at the same tier as relational
// operators, matching where ts-parser.ts pushes them onto `relational_expression`.
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

// Precedence tier of `expr`'s own root operator -- used by callers (via `exprToCode`'s `minPrec`)
// to decide whether `expr` needs wrapping in parens to survive being re-embedded as a child.
// Tier 18 (the default) covers every "primary"/LeftHandSideExpression-tier node (identifiers,
// literals, member/call/new/index chains, etc.) that never needs parens just to be nested.
function exprPrecedence(expr: any): number {
	switch (expr.type) {
		case 'sequence':			return 1;
		case 'assign':
		case 'yield':
		case 'arrow':				return 2;
		case 'conditional':			return 3;
		case 'binary':
		case 'logical':				return BINARY_PREC[expr.operator] ?? 0;
		case 'as_expression':
		case 'satisfies_expression':	return 11;
		case 'await':
		case 'unary':				return 16;
		case 'update':				return expr.prefix ? 16 : 17;
		default:					return 18;
	}
}

// Real TS rejects mixing '??' directly with '&&'/'||' without explicit parens (a SyntaxError,
// not just a precedence question) -- this grammar doesn't enforce that restriction when parsing
// (see nullish_expression's own comment in js-parser.ts), so a child built that way needs parens
// reinserted here even though the two operators' precedence tiers don't otherwise call for it.
function needsNullishParens(parentOp: string, child: any): boolean {
	const childOp = child?.type === 'logical' ? child.operator : undefined;
	return (parentOp === '??' && (childOp === '&&' || childOp === '||'))
		|| ((parentOp === '&&' || parentOp === '||') && childOp === '??');
}

// `&` is also TypeScript's intersection-type combinator, and `as`/`satisfies`'s type operand is parsed
// via the full `type` grammar (which happily consumes `T & U` as one intersection type) -- so an
// `as`/`satisfies` expression as the *left* operand of a `&` needs parens, or re-parsing greedily
// extends its type operand into the `&` instead of treating it as this binary expression's own operator,
// changing the meaning (e.g. `(x as bigint) & (m - 1n)` would come back out as `x as bigint & m - 1n`,
// silently reparsing as `(x as (bigint & m)) - 1n`). Only the left side is at risk: precedence already
// forces the right side into its own nested node (parenthesized independently if it needs it), so its
// type operand's own greediness can't reach across into a sibling `&` the way the left side's can.
function needsAsIntersectionParens(parentOp: string, child: any): boolean {
	return parentOp === '&' && (child?.type === 'as_expression' || child?.type === 'satisfies_expression');
}

function templatePartsToCode(parts: TemplatePart[]): string {
	return '`' + parts.map(p => p.str + (p.exp ? '${' + exprToCode(p.exp) + '}' : '')).join('') + '`';
}

// `minPrec`: the precedence tier required of `expr` in the position it's being embedded into --
// if `expr`'s own tier is lower, it gets wrapped in parens. Defaults to 0 (never wraps), the right
// choice for top-level/statement-level callers where any expression is already valid as-is.
export function exprToCode(expr: Expr, minPrec = 0): string {
	if (!expr || typeof expr !== 'object')
		return String(expr);
	const code = exprToCodeBody(expr as any);
	return exprPrecedence(expr as any) < minPrec ? '(' + code + ')' : code;
}

function exprToCodeBody(exprAny: any): string {
	switch (exprAny.type) {
		case 'identifier':
			return exprAny.name;

		case 'literal':
			// An *untagged* template literal: js-parser.ts's own primary_expression parses
			// `` `...` `` as `{ type: 'literal', value: <TemplatePart[]> }` (no separate node type) --
			// `value` here is the part array, not one of the scalar literal types.
			if (Array.isArray(exprAny.value))
				return templatePartsToCode(exprAny.value);
			if (exprAny.value === null)
				return 'null';
			if (typeof exprAny.value === 'string')
				return JSON.stringify(exprAny.value);
			return String(exprAny.value);

		case 'regex':
			return '/' + exprAny.pattern + '/' + (exprAny.flags || '');

		case 'bigint':
			return exprAny.value + 'n';

		case 'this':
			return 'this';

		case 'array':
			// Elements use `assignment_expression` in the grammar (array_literal's `element_list`),
			// so minPrec=2 keeps a literal comma/sequence element from being misread as two elements.
			return '[' + exprAny.elements.map((e: Expr | undefined) => e ? exprToCode(e, 2) : '').join(', ') + ']';

		case 'object':
			return '{ ' + exprAny.properties.map((p: any) => {
				if (p.kind === 'spread')
					return '...' + exprToCode(p.argument, 2);
				const key = memberKeyToCode(p.key);
				if (p.kind === 'get')
					return 'get ' + key + '() {\n' + indentBlock(p.value.body, '  ') + '\n}';
				if (p.kind === 'set')
					return 'set ' + key + '(' + p.value.params.map((q: Param) => paramToCodeJs(q)).join(', ') + ') {\n' + indentBlock(p.value.body, '  ') + '\n}';
				return key + ': ' + exprToCode(p.value, 2);
			}).join(', ') + ' }';

		case 'function': {
			let result = '';
			if (exprAny.async)
				result += 'async ';
			result += 'function' + (exprAny.generator ? '*' : '') + (exprAny.name ? ' ' + exprAny.name : '');
			if (exprAny.typeParams)
				result += '<' + (exprAny.typeParams as TSTypeParam[]).map((p: TSTypeParam) => typeParamToCode(p)).join(', ') + '>';
			result += '(' + paramListToCode(exprAny.params, exprAny.rest, exprAny.restType) + ')';
			if (exprAny.returnType)
				result += ': ' + typeToCode(exprAny.returnType);
			result += ' {\n' + indentBlock(exprAny.body, '  ') + '\n}';
			return result;
		}

		case 'member':
			return exprToCode(exprAny.object, 18) + (exprAny.optional ? '?.' : '.') + exprAny.property;

		case 'index':
			// `property` uses the full `expression` production (allows comma) per the grammar's `'[' expression ']'` -- no wrapping needed.
			return exprToCode(exprAny.object, 18) + (exprAny.optional ? '?.' : '') + '[' + exprToCode(exprAny.property) + ']';

		case 'call': {
			let result = exprToCode(exprAny.callee, 18);
			if (exprAny.typeArgs)
				result += '<' + exprAny.typeArgs.map((t: TSType) => typeToCode(t)).join(', ') + '>';
			result += (exprAny.optional ? '?.(' : '(') + exprAny.arguments.map((a: Expr) => exprToCode(a, 2)).join(', ') + ')';
			return result;
		}

		case 'new': {
			let result = 'new ' + exprToCode(exprAny.callee, 18);
			if (exprAny.typeArgs)
				result += '<' + exprAny.typeArgs.map((t: TSType) => typeToCode(t)).join(', ') + '>';
			result += '(' + exprAny.arguments.map((a: Expr) => exprToCode(a, 2)).join(', ') + ')';
			return result;
		}

		case 'unary':
			// Operand is `unary_expression` (self) in the grammar -- same tier, so chained unaries
			// (`!!x`, `typeof typeof x`) don't need parens, but anything looser (e.g. `-(a + b)`) does.
			return exprAny.operator + (WORD_UNARY_OPS.has(exprAny.operator) ? ' ' : '') + exprToCode(exprAny.argument, 16);

		case 'update':
			// Prefix `++`/`--`'s operand is `unary_expression` (tier 16); postfix's is restricted to
			// `left_hand_side_expression` (tier 18) -- see postfix_expression/unary_expression in js-parser.ts.
			return exprAny.prefix
				? exprAny.operator + exprToCode(exprAny.argument, 16)
				: exprToCode(exprAny.argument, 18) + exprAny.operator;

		case 'binary':
		case 'logical': {
			const op = exprAny.operator;
			const prec = BINARY_PREC[op] ?? 0;
			// '**' is right-associative and its left operand is restricted to `unary_expression` (it
			// can't itself be another '**' on the left) -- every other chain here is left-associative.
			let left = exprToCode(exprAny.left, op === '**' ? 16 : prec);
			let right = exprToCode(exprAny.right, op === '**' ? 15 : prec + 1);
			if (needsNullishParens(op, exprAny.left) || needsAsIntersectionParens(op, exprAny.left))
				left = '(' + left + ')';
			if (needsNullishParens(op, exprAny.right))
				right = '(' + right + ')';
			return left + ' ' + op + ' ' + right;
		}

		case 'assign':
			return exprToCode(exprAny.left, 18) + ' ' + exprAny.operator + ' ' + exprToCode(exprAny.right, 2);

		case 'conditional':
			// `test` is parsed as `nullish_expression` (tier 4); `consequent`/`alternate` are full
			// `assignment_expression` (tier 2, i.e. anything but a bare sequence) -- see conditional_expression.
			return exprToCode(exprAny.test, 4) + ' ? ' + exprToCode(exprAny.consequent, 2) + ' : ' + exprToCode(exprAny.alternate, 2);

		case 'sequence':
			return exprAny.expressions.map((e: Expr) => exprToCode(e, 2)).join(', ');

		case 'spread':
			return '...' + exprToCode(exprAny.argument, 2);

		case 'tagged_template':
			return exprToCode(exprAny.tag, 18) + templatePartsToCode(exprAny.quasi);

		case 'arrow': {
			let result = '';
			if (exprAny.async)
				result += 'async ';
			if (exprAny.params.length === 1 && !exprAny.rest && typeof exprAny.params[0] === 'string' && !exprAny.returnType) {
				result += exprAny.params[0];
			} else {
				result += '(' + paramListToCode(exprAny.params, exprAny.rest, exprAny.restType) + ')';
			}
			if (exprAny.returnType)
				result += ': ' + typeToCode(exprAny.returnType);
			result += ' => ';
			if (Array.isArray(exprAny.body)) {
				result += '{\n' + indentBlock(exprAny.body, '  ') + '\n}';
			} else {
				// Body is `assignment_expression` (tier 2) -- but an object literal body additionally
				// needs parens regardless of precedence, or `{` would be read as the arrow's block
				// body instead (the same ambiguity real TS requires `() => ({})` for).
				const body = exprToCode(exprAny.body, 2);
				result += body.startsWith('{') ? '(' + body + ')' : body;
			}
			return result;
		}

		case 'yield':
			return 'yield' + (exprAny.delegate ? '*' : '') + (exprAny.argument ? ' ' + exprToCode(exprAny.argument, 2) : '');

		case 'await':
			return 'await ' + exprToCode(exprAny.argument, 16);

		case 'class': {
			let result = 'class' + (exprAny.name ? ' ' + exprAny.name : '');
			if (exprAny.typeParams)
				result += '<' + (exprAny.typeParams as TSTypeParam[]).map(p => typeParamToCode(p)).join(', ') + '>';
			if (exprAny.superClass)
				result += ' extends ' + exprToCode(exprAny.superClass, 18);
			if (exprAny.implementsClause)
				result += ' implements ' + (exprAny.implementsClause as TSType[]).map(t => typeToCode(t)).join(', ');
			result += ' {\n' + exprAny.body.map((m: ClassMember) => classMemberToCode(m)).join('\n') + '\n}';
			return result;
		}

		case 'as_expression':
			return exprToCode(exprAny.expression, 11) + ' as ' + typeToCode(exprAny.typeAnnotation);

		case 'satisfies_expression':
			return exprToCode(exprAny.expression, 11) + ' satisfies ' + typeToCode(exprAny.typeAnnotation);

		case 'non_null':
			return exprToCode(exprAny.expression, 18) + '!';

		default:
			return String(exprAny);
	}
}

// Builds a parenthesized-call-style param list, comma-joining the rest parameter in only if
// there's something to put a comma after -- `params.join(', ') + (rest ? ', ...' + rest : '')`
// looks right but breaks for a rest-only list (e.g. `(...alts)`), leaving a stray leading comma.
function paramListToCode(params: Param[], rest?: string, restType?: unknown): string {
	const parts = params.map(p => paramToCodeJs(p));
	if (rest)
		parts.push('...' + rest + (restType ? ': ' + typeToCode(restType as TSType) : ''));
	return parts.join(', ');
}

function paramToCodeJs(param: Param): string {
	if (typeof param === 'string')
		return param;
	const paramAny = param as any;
	let result = '';
	if (paramAny.modifiers)
		result += paramAny.modifiers.join(' ') + ' ';
	if ('target' in param)
		result += bindingTargetToCode(param.target);
	if (paramAny.optional)
		result += '?';
	if (paramAny.typeAnnotation)
		result += ': ' + typeToCode(paramAny.typeAnnotation);
	if (paramAny.default)
		result += ' = ' + exprToCode(paramAny.default, 2);
	return result;
}

function bindingTargetToCode(target: BindingTarget): string {
	if (typeof target === 'string')
		return target;
	if (target.type === 'object_pattern') {
		const parts = target.properties.map(p =>
			p.key + ':' + bindingTargetToCode(p.value) + (p.default ? ' = ' + exprToCode(p.default, 2) : '')
		);
		if (target.rest)
			parts.push('...' + target.rest);
		return '{ ' + parts.join(', ') + ' }';
	}
	if (target.type === 'array_pattern') {
		const parts = target.elements.map(e =>
			e ? bindingTargetToCode(e.target) + (e.default ? ' = ' + exprToCode(e.default, 2) : '') : ''
		);
		if (target.rest)
			parts.push('...' + target.rest);
		return '[' + parts.join(', ') + ']';
	}
	return String(target);
}
