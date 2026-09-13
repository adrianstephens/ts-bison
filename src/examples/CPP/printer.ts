import * as C from './c-parser';
import * as CPP from './cpp-parser';
import { Module } from '../common';
import { isExpr, isDeclarator, isPackParameter } from './walker';

type Definition			= CPP.Definition;
type Stmt				= CPP.Stmt;
type Expr				= CPP.Expr;
type ClassMember		= CPP.ClassMember;
type Declarator			= CPP.Declarator;
type AbstractDeclarator	= CPP.AbstractDeclarator;
type TypeSpec			= CPP.TypeSpecifier;
type TypeSpecifierExt	= CPP.TypeSpecifierExt;
type TypeName			= CPP.TypeName;
type DeclSpec			= CPP.DeclSpec;
type ParamDecl			= CPP.ParamDecl;
type Block				= C.Block<Declarator, TypeSpecifierExt, Expr, Stmt>;
// The `declaration`/`typedef` tags, widened -- cpp's `Definition`/`Statement` unions inline these rather than
// exporting them under their own names (see walker.ts's identical note).
type Declaration		= C.Declaration<Declarator, TypeSpecifierExt, Expr>;
type TypedefDecl		= C.TypedefDecl<Declarator, TypeSpecifierExt, Expr>;
type DeclarationSpec	= CPP.DeclarationSpec;

const DefaultOptions = {
	newline: 			'\n',
	indent: 			'  ',
	spaceAroundOps:		true,
	spaceAfterComma:	true,
};

export type Options = Partial<typeof DefaultOptions>;

// ===================================================================
//  Expression precedence
// ===================================================================
//
// Numbered from c-parser.ts's own exported `PREC` (comma < assignment < conditional < logicalOr < ... <
// unary, lowest to highest -- that's the authoritative source, not re-derived), extended with a postfix tier
// (subscript/member/call, binds tighter than unary) and a primary tier (identifiers, literals, and
// self-delimited cpp forms like `sizeof(T)`/`static_cast<T>(x)` that never need extra parens).

const BINARY_PREC: Record<string, number> = {
	',':	1,
	'||':	4,
	'&&':	5,
	'|':	6,
	'^':	7,
	'&':	8,
	'==':9, '!=':9,
	'<':10, '>':10, '<=':10, '>=':10,
	'<<':11, '>>':11,
	'+':12, '-':12,
	'*':13, '/':13, '%':13,
};
const CONDITIONAL_PREC	= 3;
const LOGICAL_OR_PREC	= 4;
const CAST_PREC			= 14;
const UNARY_PREC		= 15;
const POSTFIX_PREC		= 16;
const PRIMARY_PREC		= 17;
const ASSIGN_PREC		= 2;	// what function args / initializers / default values are parsed as (excludes bare comma)

function exprPrecedence(e: Expr): number {
	switch (e.type) {
		case 'binary':			return BINARY_PREC[e.operator] ?? 0;
		case 'assign':			return ASSIGN_PREC;
		case 'conditional':		return CONDITIONAL_PREC;
		case 'cast':			return CAST_PREC;
		case 'unary':
		case 'sizeof_type':
		case 'sizeof_pack':
		case 'new':
		case 'delete':
		case 'spread':			return UNARY_PREC;
		case 'unary_post':
		case 'index':
		case 'member':
		case 'pointer_member':
		case 'call':
		case 'cpp_cast':
		case 'functional_cast':
		case 'typeid':
		case 'alignof':			return POSTFIX_PREC;
		default:				return PRIMARY_PREC; // identifier / literal / char_literal / this / null_literal / qualified / lambda
	}
}

function withParens(x: string, parens = true)			{ return parens ? '(' + x + ')' : x; }
function poss(enable: boolean | undefined, s: string)	{ return enable ? s : ''; }
function maybe<T>(value: T, fn: (value: NonNullable<T>) => string)	{ return value ? fn(value as NonNullable<T>) : ''; }

export function printer(opts1: Options = {}) {
	const opts		= {...DefaultOptions, ...opts1};
	const comma		= opts.spaceAfterComma ? ', ' : ',';
	let newline		= opts.newline;

	function definitions(defs: readonly Definition[]): string {
		return defs.map(d => definition(d)).join(opts.newline);
	}

	function module(m: Module<Definition>): string {
		return definitions(m.body);
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
	function curlyIndented(f: () => string) {
		return '{' + indented(() => newline + f()) + newline + '}';
	}

	function block(b: Block): string {
		return curlyIndented(() => b.body.map(s => statement(s)).join(newline));
	}
	function curlyBlock(defs: Definition[]): string {
		return curlyIndented(() => defs.map(d => definition(d)).join(newline));
	}
	function dependentCode(s: Stmt): string {
		if (s.type !== 'block')
			return indented(() => newline + statement(s));
		return block(s);
	}

	// ===================================================================
	//  Declarators / type-names / specifiers
	// ===================================================================
	// C's declarator system (pointer/array/function wrapping a name) has no TS analogue -- there's no
	// separate "Type" AST to print, so declarators are printed inline wherever a specifiers/declarator
	// pair appears.

	function qualifierStr(q?: C.TypeQualifier[]) {
		return q ? q.map(x => x + ' ').join('') : '';
	}
	function levelsStr(levels: C.Levels): string {
		return levels.map(q => '*' + qualifierStr(q)).join('');
	}

	function arraySize(size?: C.TypeSpecifier | Expr): string {
		if (size === undefined)
			return '';
		return isExpr(size) ? expression(size as Expr) : typeSpecifier(size as C.TypeSpecifier);
	}

	// `groupIfPointer`: set when recursing into a FunctionDecl's `name` or ArrayDecl's `element` -- a
	// Pointer found there must be wrapped in parens so the `(...)`/`[...]` suffix binds to "*name" as a
	// whole (`int (*fp)(int)`), not just to the bare name. A Pointer's own `to` never sets it (`int *f(int)`,
	// a function *returning* a pointer, needs no parens around the star).
	function declStr(d: Declarator | AbstractDeclarator, groupIfPointer = false): string {
		if (!d)
			return '';
		switch (d.type) {
			case 'identifier':			return d.name;
			case 'reference':			return '&' + declStr(d.to);
			case 'rvalue_reference':	return '&&' + declStr(d.to);
			case 'pointer': {
				const inner = '*' + qualifierStr(d.qualifiers) + declStr(d.to);
				return groupIfPointer ? '(' + inner + ')' : inner;
			}
			case 'array':				return declStr(d.element, true) + '[' + arraySize(d.size) + ']';
			case 'function':			return declStr(d.name, true) + paramList(d.params, d.variadic);
		}
	}

	function typeSpecifier(t: TypeSpec): string {
		switch (t.type) {
			case 'ref':					return t.name;
			case 'struct':
			case 'union':
			case 'class':				return t.type + maybe(t.name, n => ' ' + n)
				+ poss((t as CPP.ClassSpecifier).final, ' final')
				+ maybe((t as CPP.ClassSpecifier).bases, bases => ' : ' + bases.map(b => baseSpecifier(b)).join(comma))
				+ (t.body ? ' ' + curlyIndented(() => t.body!.map(m => classMember(m)).join(newline)) : '');
			case 'enum':				return 'enum' + poss((t as CPP.CppEnumSpecifier).scoped, ' class') + maybe(t.name, n => ' ' + n)
				+ maybe((t as CPP.CppEnumSpecifier).base, b => ' : ' + typeSpecifier(b))
				+ (t.members ? ' ' + curlyIndented(() => t.members!.map(m => m.name + maybe(m.init, e => ' = ' + expression(e, ASSIGN_PREC))).join(',' + newline)) : '');
			case 'generic':				return t.name + '<' + t.args.map(a => templateArg(a)).join(comma) + '>';
			case 'qualified_type':		return t.parts.join('::');
			case 'decltype':				return 'decltype(' + (t.auto ? 'auto' : expression(t.expression!)) + ')';
			default:					throw new Error(`Unknown type specifier: ${(t as any).type}`);
		}
	}

	// Qualifiers print *after* the type (`int const`, not `const int`) -- c-parser.ts's own base grammar only
	// accepts trailing qualifiers (leading ones are a cpp-only extension), and trailing form parses under both.
	function declSpec(s: DeclSpec | DeclarationSpec): string {
		const storage = (s as DeclarationSpec).storageClass;
		return maybe(storage, sc => sc.join(' ') + ' ')
			+ typeSpecifier(s.type)
			+ poss(s.const, ' const')
			+ poss(s.volatile, ' volatile');
	}

	function typeName(t: TypeName): string {
		const dstr = declStr(t.declarator);
		return declSpec(t.specifiers) + (dstr ? ' ' + dstr : '');
	}

	function baseSpecifier(b: CPP.BaseSpecifier): string {
		return poss(b.virtual, 'virtual ') + maybe(b.access, a => a + ' ') + b.name + maybe(b.args, a => '<' + a.map(t => templateArg(t)).join(comma) + '>');
	}
	function templateArg(a: CPP.TemplateArg): string {
		return (isExpr(a.value) ? expression(a.value, ASSIGN_PREC) : typeName(a.value)) + poss(a.pack, '...');
	}
	function templateParam(p: CPP.TemplateParam): string {
		const val = maybe(p.default, d => ' = ' + (isExpr(d) ? expression(d, ASSIGN_PREC) : typeName(d)));
		return p.nonType
			? declSpec(p.nonType) + poss(p.pack, '...') + ' ' + p.name + val
			: 'typename ' + poss(p.pack, '...') + p.name + val;
	}
	function templateBody(decl: Definition | CPP.ClassSpecifier | CPP.UsingAlias): string {
		if (decl.type === 'class' || decl.type === 'struct' || decl.type === 'union')
			return typeSpecifier(decl) + ';';
		if (decl.type === 'using_alias')
			return 'using ' + decl.name + ' = ' + typeName(decl.target) + ';';
		return definition(decl as Definition);
	}

	function paramList(params: ParamDecl[], variadic?: boolean): string {
		const parts = params.map(p => paramDecl(p));
		if (variadic)
			parts.push('...');
		return '(' + parts.join(comma) + ')';
	}
	function paramDecl(p: ParamDecl): string {
		if (isPackParameter(p)) {
			const declared = (p.byRef ? '&' : p.rvalueRef ? '&&' : '') + '... ' + (p.name ?? '');
			return declSpec(p.specifiers) + ' ' + declared;
		}
		const declared = p.declarator ? declStr(p.declarator) : '';
		return declSpec(p.specifiers) + (declared ? ' ' + declared : '') + maybe(p.default, d => ' = ' + expression(d, ASSIGN_PREC));
	}

	function initDeclaratorStr(d: C.InitDeclarator<Declarator, Expr>): string {
		return isDeclarator(d) ? declStr(d as Declarator)
			: declStr(d.declarator) + ' = ' + initializerStr(d.initializer);
	}
	function initializerStr(i: C.Initializer<Expr>): string {
		return isExpr(i) ? expression(i, ASSIGN_PREC)
			: '{' + i.elements.map(e => initializerStr(e)).join(comma) + '}';
	}

	// ===================================================================
	//  Definitions / Statements
	// ===================================================================

	function declarationLike(d: Declaration | TypedefDecl, trailingSemi = true): string {
		const decls = d.type === 'typedef' ? d.declarators : d.initDeclarators;
		return poss(d.type === 'typedef', 'typedef ')
			+ declSpec(d.specifiers)
			+ (decls?.length ? ' ' + decls.map(x => initDeclaratorStr(x)).join(comma) : '')
			+ (trailingSemi ? ';' : '');
	}

	function methodTail(t: CPP.MethodTail): string {
		const mods = poss(t.isConst, ' const') + poss(t.noexcept, ' noexcept') + poss(t.override, ' override') + poss(t.final, ' final');
		return mods + (
			t.pure			? ' = 0;'
			: t.defaulted	? ' = default;'
			: t.deleted		? ' = delete;'
			: t.declarationOnly ? ';'
			: ' ' + block(t.body!)
		);
	}
	function ctorTail(t: CPP.CtorTail): string {
		const init = t.initializerList?.length
			? ' : ' + t.initializerList.map(m => m.name + '(' + m.arguments.map(a => expression(a, ASSIGN_PREC)).join(comma) + ')').join(comma)
			: '';
		return init + (
			t.defaulted		? ' = default;'
			: t.deleted		? ' = delete;'
			: t.declarationOnly ? ';'
			: ' ' + block(t.body!)
		);
	}

	function definition(d: Definition): string {
		switch (d.type) {
			case 'declaration':
			case 'typedef':				return declarationLike(d);
			case 'function_def':		return declSpec(d.specifiers) + ' ' + declStr(d.declarator) + ' ' + block(d.body);
			// cpp
			case 'namespace':			return poss(d.inline, 'inline ') + 'namespace' + maybe(d.name, n => ' ' + n) + ' ' + curlyBlock(d.body);
			case 'linkage':				return 'extern ' + JSON.stringify(d.language) + ' ' + curlyBlock(d.body);
			case 'using_namespace':		return 'using namespace ' + d.name + ';';
			case 'using_decl':			return 'using ' + [...d.scope, d.name].join('::') + ';';
			case 'using_alias':			return 'using ' + d.name + ' = ' + typeName(d.target) + ';';
			case 'template':			return 'template<' + d.params.map(p => templateParam(p)).join(comma) + '> ' + templateBody(d.declaration);
			case 'static_assert':		return 'static_assert(' + expression(d.condition) + maybe(d.message, m => comma + JSON.stringify(m)) + ');';
			case 'method_def':			return maybe(d.specifiers, s => declSpec(s) + ' ') + maybe(d.pointer, levelsStr) + d.scope.join('::') + '::' + d.name + paramList(d.params, d.variadic) + methodTail(d.tail);
			case 'constructor_def':		return d.scope.join('::') + '::' + d.name + paramList(d.params, d.variadic) + ctorTail(d.tail);
			case 'destructor_def':		return d.scope.join('::') + '::~' + d.name + '()' + methodTail(d.tail);
			case 'operator_def':		return declSpec(d.specifiers) + ' ' + maybe(d.scope, s => s.join('::') + '::') + 'operator' + d.operator + paramList(d.params, d.variadic) + methodTail(d.tail);
			case 'static_member_def':	return declSpec(d.specifiers) + ' ' + maybe(d.pointer, levelsStr) + d.scope.join('::') + '::' + d.name
				+ maybe(d.initializer, e => ' = ' + expression(e, ASSIGN_PREC))
				+ maybe(d.ctorArgs, a => '(' + a.map(x => expression(x, ASSIGN_PREC)).join(comma) + ')')
				+ ';';
			default:					throw new Error(`Unknown definition: ${(d as any).type}`);
		}
	}

	function forInitStr(i?: Expr | Declaration | TypedefDecl): string {
		if (!i)
			return '';
		return isExpr(i) ? expression(i as Expr) : declarationLike(i, false);
	}

	function statement(s: Stmt): string {
		switch (s.type) {
			case 'declaration':
			case 'typedef':				return declarationLike(s);
			case 'block':				return block(s);
			case 'if':					return 'if (' + expression(s.test) + ') ' + dependentCode(s.consequent) + maybe(s.alternate, alt => ' else ' + dependentCode(alt));
			case 'while':				return 'while (' + expression(s.test) + ') ' + dependentCode(s.body);
			case 'do_while':			return 'do ' + dependentCode(s.body) + ' while (' + expression(s.test) + ');';
			case 'for':					return 'for (' + forInitStr(s.init) + '; ' + maybe(s.test, c => expression(c)) + '; ' + maybe(s.update, u => expression(u)) + ') ' + dependentCode(s.body);
			case 'switch':				return 'switch (' + expression(s.discriminant) + ') ' + dependentCode(s.body);
			case 'case':				return 'case ' + expression(s.test) + ': ' + statement(s.body);
			case 'default':				return 'default: ' + statement(s.body);
			case 'break':				return 'break;';
			case 'continue':			return 'continue;';
			case 'return':				return 'return' + maybe(s.argument, e => ' ' + expression(e)) + ';';
			case 'goto':				return 'goto ' + s.label + ';';
			case 'labeled':				return s.label + ': ' + statement(s.body);
			case 'empty':				return ';';
			// cpp
			case 'throw':				return 'throw' + maybe(s.argument, a => ' ' + expression(a)) + ';';
			case 'try':					return 'try ' + block(s.body) + s.handlers.map(h =>
				' catch (' + maybe(h.type, t => typeName(t)) + poss(h.byRef, '&') + maybe(h.param, n => (h.type ? ' ' : '') + n) + ') ' + block(h.body)
			).join('');
			case 'range_for':			return 'for (' + declSpec(s.specifiers) + ' ' + declStr(s.declarator) + ' : ' + expression(s.range) + ') ' + dependentCode(s.body);
			case 'static_assert':
			case 'using_namespace':
			case 'using_decl':
			case 'using_alias':			return definition(s as unknown as Definition);
			case 'expression':			return expression(s.expression) + ';';
			default:					throw new Error(`Unknown statement: ${(s as any).type}`);
		}
	}

	// ===================================================================
	//  Class members (cpp)
	// ===================================================================

	function structDeclaratorStr(d: CPP.StructDeclarator): string {
		if ('declarator' in d)
			return declStr(d.declarator) + maybe(d.initializer, e => ' = ' + expression(e, ASSIGN_PREC));
		return (d.name ?? '') + (d.type === 'bitfield' ? ' : ' + expression(d.width!, ASSIGN_PREC) : '');
	}

	function classMember(m: ClassMember): string {
		const modifiers = (m as {modifiers?: CPP.MemberMod[]}).modifiers;
		const mods = modifiers?.length ? modifiers.join(' ') + ' ' : '';
		switch (m.type) {
			case 'struct_member':		return mods + declSpec(m.specifiers) + ' ' + m.declarators.map(d => structDeclaratorStr(d)).join(comma) + ';';
			case 'access_label':		return m.access + ':';
			case 'constructor':			return mods + m.name + paramList(m.params, m.variadic) + ctorTail(m);
			case 'destructor':			return mods + '~' + m.name + '()' + methodTail(m);
			case 'method':				return mods + declSpec(m.specifiers) + ' ' + declStr(m.declarator) + methodTail(m);
			case 'conversion':			return mods + 'operator ' + typeName(m.target) + '()' + methodTail(m);
			case 'using_decl':			return 'using ' + [...m.scope, m.name].join('::') + ';';
			case 'using_alias':			return 'using ' + m.name + ' = ' + typeName(m.target) + ';';
			case 'member_template':		return 'template<' + m.params.map(p => templateParam(p)).join(comma) + '> ' + classMember(m.declaration);
			default: {
				// 'member_typedef' -- ad hoc shape (`typedef T type;` inside a class body), not part of the declared ClassMember union.
				const mt = m as unknown as {type: string; specifiers?: C.DeclSpec; declarators?: CPP.StructDeclarator[]};
				if (mt.type === 'member_typedef' && mt.specifiers && mt.declarators)
					return 'typedef ' + declSpec(mt.specifiers) + ' ' + mt.declarators.map(d => structDeclaratorStr(d)).join(comma) + ';';
				throw new Error(`Unknown class member: ${mt.type}`);
			}
		}
	}

	// ===================================================================
	//  Expressions
	// ===================================================================

	function literal(e: {value: number | string | boolean}): string {
		switch (typeof e.value) {
			case 'string':	return JSON.stringify(e.value);
			case 'boolean':	return e.value ? 'true' : 'false';
			default:			return String(e.value);
		}
	}

	// The AST holds the real (unescaped) character(s), like `literal`'s string case -- re-escaped via
	// `JSON.stringify` (whose escape set is a subset of C's) and re-quoted single rather than double.
	function charLiteral(value: string): string {
		return "'" + JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'";
	}

	function captureStr(c: CPP.LambdaCapture): string {
		if (c.thisCapture)
			return 'this';
		if (c.defaultCapture)
			return c.defaultCapture;
		return poss(c.byRef, '&') + (c.name ?? '') + maybe(c.init, i => '=' + expression(i, ASSIGN_PREC));
	}

	// `minPrec`: the precedence tier required of `e` here -- if lower, it gets parens. Defaults to 0 (never wraps).
	function expression(e: Expr, minPrec = 0): string {
		return withParens(exprBody(e), exprPrecedence(e) < minPrec);
	}

	function  exprBody(e: Expr): string {
		switch (e.type) {
			case 'identifier':			return e.name;
			case 'literal':				return literal(e);
			case 'char_literal':		return charLiteral(e.value);
			case 'unary':				return e.operator + poss(/[a-z]/i.test(e.operator), ' ') + expression(e.operand, UNARY_PREC);
			case 'unary_post':			return expression(e.operand, POSTFIX_PREC) + e.operator;
			case 'binary': {
				const op = e.operator, prec = BINARY_PREC[op] ?? 0;
				return expression(e.left, prec) + operator(op) + expression(e.right, prec + 1);
			}
			// Right-associative and the loosest thing there is: the target re-emits at the postfix tier
			// the grammar demands, the value at assignment's own tier -- same shape as TS/tocode.ts's own `assign`.
			case 'assign':				return expression(e.target, POSTFIX_PREC) + operator((e.operator ?? '') + '=') + expression(e.value, ASSIGN_PREC);
			case 'conditional':			return expression(e.test, LOGICAL_OR_PREC) + operator('?') + expression(e.consequent, 0) + operator(':') + expression(e.alternate, CONDITIONAL_PREC);
			case 'index':				return expression(e.object, POSTFIX_PREC) + '[' + expression(e.index) + ']';
			case 'member':				return expression(e.object, POSTFIX_PREC) + '.' + e.property;
			case 'pointer_member':		return expression(e.object, POSTFIX_PREC) + '->' + e.property;
			case 'call':				return expression(e.callee, POSTFIX_PREC) + '(' + e.arguments.map(a => expression(a, ASSIGN_PREC)).join(comma) + ')';
			case 'cast':				return '(' + typeName(e.typeAnnotation) + ')' + expression(e.expression, UNARY_PREC);
			case 'sizeof_type':			return 'sizeof(' + typeName(e.operand) + ')';
			// cpp
			case 'this':				return 'this';
			case 'null_literal':		return 'nullptr';
			case 'qualified':			return e.parts.join('::');
			case 'new':					return 'new ' + typeSpecifier(e.typeName)
				+ maybe(e.size, s => '[' + expression(s) + ']')
				+ (e.braced ? '{' + (e.arguments ?? []).map(a => expression(a, ASSIGN_PREC)).join(comma) + '}'
					: e.arguments ? '(' + e.arguments.map(a => expression(a, ASSIGN_PREC)).join(comma) + ')' : '');
			case 'delete':				return 'delete' + poss(e.array, '[]') + ' ' + expression(e.operand, UNARY_PREC);
			case 'spread':				return expression(e.operand) + '...';
			case 'sizeof_pack':			return 'sizeof...(' + e.name + ')';
			case 'cpp_cast':			return e.kind + '<' + typeName(e.target) + '>(' + expression(e.expression) + ')';
			case 'typeid':				return 'typeid(' + (e.expression ? expression(e.expression) : typeName(e.target!)) + ')';
			case 'alignof':				return 'alignof(' + typeName(e.target) + ')';
			case 'functional_cast':		return e.target + '(' + e.arguments.map(a => expression(a, ASSIGN_PREC)).join(comma) + ')';
			case 'lambda':				return '[' + e.captures.map(c => captureStr(c)).join(comma) + ']'
				+ paramList(e.params, e.variadic)
				+ poss(e.mutable, ' mutable')
				+ maybe(e.returnType, t => ' -> ' + typeName(t))
				+ ' ' + block(e.body);
			default:					throw new Error(`Unknown expression: ${(e as any).type}`);
		}
	}

	return {
		statement,
		expression,
		definition,
		classMember,
		module,
	};
}
