import * as C from './c-parser';
import * as CPP from './cpp-parser';
import { isTranslationUnit, isDefinition, isStatementOnly, isExpr, isClassMember, isDeclarator, isPackParameter } from './walker';

type Definition			= CPP.Definition;
type Statement			= CPP.Statement;
type Expr				= CPP.Expr;
type ClassMember		= CPP.ClassMember;
type Declarator			= CPP.Declarator;
type AbstractDeclarator	= CPP.AbstractDeclarator;
type TypeSpec			= CPP.TypeSpecifier;
type TypeSpecifierExt	= CPP.TypeSpecifierExt;
type TypeName			= CPP.TypeName;
type DeclSpec			= CPP.DeclSpec;
type ParamDecl			= CPP.ParamDecl;
type Block				= C.Block<Declarator, TypeSpecifierExt>;
// The `declaration`/`typedef` tags, widened -- cpp's `Definition`/`Statement` unions inline these rather than
// exporting them under their own names (see walker.ts's identical note).
type Declaration			= C.Declaration<Declarator, TypeSpecifierExt>;
type TypedefDecl			= C.TypedefDecl<Declarator, TypeSpecifierExt>;
type DeclarationSpec		= CPP.DeclarationSpec;

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
	'=':2, '+=':2, '-=':2, '*=':2, '/=':2, '%=':2, '&=':2, '|=':2, '^=':2, '<<=':2, '>>=':2, '&&=':2, '||=':2,
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

function isAssignOp(op: string) {
	return op === '=' || (op.endsWith('=') && !['==', '!=', '<=', '>='].includes(op));
}

function exprPrecedence(e: Expr): number {
	switch (e.type) {
		case 'binary':			return BINARY_PREC[e.operator] ?? 0;
		case 'conditional':		return CONDITIONAL_PREC;
		case 'cast':			return CAST_PREC;
		case 'unary':
		case 'sizeof_type':
		case 'sizeof_pack':
		case 'new':
		case 'delete':
		case 'pack_expansion':	return UNARY_PREC;
		case 'unary_post':
		case 'subscript':
		case 'member_access':
		case 'pointer_member':
		case 'function_call':
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

export class Output {
	opts;
	newline = '\n';
	comma	= ', ';

	constructor(opts: Options = {}) {
		this.opts		= {...DefaultOptions, ...opts};
		this.newline	= '\n';
		this.comma		= this.opts.spaceAfterComma ? ', ' : ',';
	}

	toCode(ast: C.TranslationUnit | Definition | Statement | Expr | ClassMember): string {
		if (isTranslationUnit(ast))
			return ast.body.map(d => this.definition(d)).join(this.opts.newline);
		if (isClassMember(ast))
			return this.classMember(ast);
		if (isDefinition(ast) && !isStatementOnly(ast))
			return this.definition(ast as Definition);
		if (isStatementOnly(ast) || isDefinition(ast))
			return this.statement(ast as Statement);
		return this.expr(ast as Expr);
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
	curlyIndented(f: () => string) {
		return '{' + this.indented(() => this.newline + f()) + this.newline + '}';
	}

	block(b: Block): string {
		return this.curlyIndented(() => b.body.map(s => this.statement(s)).join(this.newline));
	}
	curlyBlock(defs: Definition[]): string {
		return this.curlyIndented(() => defs.map(d => this.definition(d)).join(this.newline));
	}
	dependentCode(s: Statement): string {
		if (s.type !== 'block')
			return this.indented(() => this.newline + this.statement(s));
		return this.block(s);
	}

	// ===================================================================
	//  Declarators / type-names / specifiers
	// ===================================================================
	// C's declarator system (pointer/array/function wrapping a name) has no TS analogue -- there's no
	// separate "Type" AST to print, so declarators are printed inline wherever a specifiers/declarator
	// pair appears.

	qualifierStr(q?: C.TypeQualifier[]) {
		return q ? q.map(x => x + ' ').join('') : '';
	}
	levelsStr(levels: C.Levels): string {
		return levels.map(q => '*' + this.qualifierStr(q)).join('');
	}

	arraySize(size?: C.TypeSpecifier | Expr): string {
		if (size === undefined)
			return '';
		return isExpr(size) ? this.expr(size as Expr) : this.typeSpecifier(size as C.TypeSpecifier);
	}

	// `groupIfPointer`: set when recursing into a FunctionDecl's `name` or ArrayDecl's `element` -- a
	// Pointer found there must be wrapped in parens so the `(...)`/`[...]` suffix binds to "*name" as a
	// whole (`int (*fp)(int)`), not just to the bare name. A Pointer's own `to` never sets it (`int *f(int)`,
	// a function *returning* a pointer, needs no parens around the star).
	declStr(d: Declarator | AbstractDeclarator, groupIfPointer = false): string {
		if (!d)
			return '';
		switch (d.type) {
			case 'identifier':			return d.name;
			case 'reference':			return '&' + this.declStr(d.to);
			case 'rvalue_reference':	return '&&' + this.declStr(d.to);
			case 'pointer': {
				const inner = '*' + this.qualifierStr(d.qualifiers) + this.declStr(d.to);
				return groupIfPointer ? '(' + inner + ')' : inner;
			}
			case 'array':				return this.declStr(d.element, true) + '[' + this.arraySize(d.size) + ']';
			case 'function':			return this.declStr(d.name, true) + this.paramList(d.params, d.variadic);
		}
	}

	typeSpecifier(t: TypeSpec): string {
		switch (t.type) {
			case 'ref':				return t.name;
			case 'struct':
			case 'union':
			case 'class':				return t.type + maybe(t.name, n => ' ' + n)
				+ poss((t as CPP.ClassSpecifier).final, ' final')
				+ maybe((t as CPP.ClassSpecifier).bases, bases => ' : ' + bases.map(b => this.baseSpecifier(b)).join(this.comma))
				+ (t.body ? ' ' + this.curlyIndented(() => t.body!.map(m => this.classMember(m)).join(this.newline)) : '');
			case 'enum':				return 'enum' + poss((t as CPP.CppEnumSpecifier).scoped, ' class') + maybe(t.name, n => ' ' + n)
				+ maybe((t as CPP.CppEnumSpecifier).base, b => ' : ' + this.typeSpecifier(b))
				+ (t.members ? ' ' + this.curlyIndented(() => t.members!.map(m => m.name + maybe(m.init, e => ' = ' + this.expr(e, ASSIGN_PREC))).join(',' + this.newline)) : '');
			case 'generic':				return t.name + '<' + t.args.map(a => this.templateArg(a)).join(this.comma) + '>';
			case 'qualified_type':		return t.parts.join('::');
			case 'decltype':				return 'decltype(' + (t.auto ? 'auto' : this.expr(t.expression!)) + ')';
			default:					throw new Error(`Unknown type specifier: ${(t as any).type}`);
		}
	}

	// Qualifiers print *after* the type (`int const`, not `const int`) -- c-parser.ts's own base grammar only
	// accepts trailing qualifiers (leading ones are a cpp-only extension), and trailing form parses under both.
	declSpec(s: DeclSpec | DeclarationSpec): string {
		const storage = (s as DeclarationSpec).storageClass;
		return maybe(storage, sc => sc.join(' ') + ' ')
			+ this.typeSpecifier(s.type)
			+ poss(s.const, ' const')
			+ poss(s.volatile, ' volatile');
	}

	typeName(t: TypeName): string {
		const dstr = this.declStr(t.declarator);
		return this.declSpec(t.specifiers) + (dstr ? ' ' + dstr : '');
	}

	baseSpecifier(b: CPP.BaseSpecifier): string {
		return poss(b.virtual, 'virtual ') + maybe(b.access, a => a + ' ') + b.name + maybe(b.args, a => '<' + a.map(t => this.templateArg(t)).join(this.comma) + '>');
	}
	templateArg(a: CPP.TemplateArg): string {
		return (isExpr(a.value) ? this.expr(a.value, ASSIGN_PREC) : this.typeName(a.value)) + poss(a.pack, '...');
	}
	templateParam(p: CPP.TemplateParam): string {
		const val = maybe(p.default, d => ' = ' + (isExpr(d) ? this.expr(d, ASSIGN_PREC) : this.typeName(d)));
		return p.nonType
			? this.declSpec(p.nonType) + poss(p.pack, '...') + ' ' + p.name + val
			: 'typename ' + poss(p.pack, '...') + p.name + val;
	}
	templateBody(decl: Definition | CPP.ClassSpecifier | CPP.UsingAlias): string {
		if (decl.type === 'class' || decl.type === 'struct' || decl.type === 'union')
			return this.typeSpecifier(decl) + ';';
		if (decl.type === 'using_alias')
			return 'using ' + decl.name + ' = ' + this.typeName(decl.target) + ';';
		return this.definition(decl as Definition);
	}

	paramList(params: ParamDecl[], variadic?: boolean): string {
		const parts = params.map(p => this.paramDecl(p));
		if (variadic)
			parts.push('...');
		return '(' + parts.join(this.comma) + ')';
	}
	paramDecl(p: ParamDecl): string {
		if (isPackParameter(p)) {
			const declared = (p.byRef ? '&' : p.rvalueRef ? '&&' : '') + '... ' + (p.name ?? '');
			return this.declSpec(p.specifiers) + ' ' + declared;
		}
		const declared = p.declarator ? this.declStr(p.declarator) : '';
		return this.declSpec(p.specifiers) + (declared ? ' ' + declared : '') + maybe(p.default, d => ' = ' + this.expr(d, ASSIGN_PREC));
	}

	initDeclaratorStr(d: C.InitDeclarator<Declarator>): string {
		return isDeclarator(d) ? this.declStr(d as Declarator)
			: this.declStr(d.declarator) + ' = ' + this.initializerStr(d.initializer);
	}
	initializerStr(i: C.Initializer): string {
		return isExpr(i) ? this.expr(i as Expr, ASSIGN_PREC)
			: '{' + i.elements.map(e => this.initializerStr(e)).join(this.comma) + '}';
	}

	// ===================================================================
	//  Definitions / Statements
	// ===================================================================

	private declarationLike(d: Declaration | TypedefDecl, trailingSemi = true): string {
		const decls = d.type === 'typedef' ? d.declarators : d.initDeclarators;
		return poss(d.type === 'typedef', 'typedef ')
			+ this.declSpec(d.specifiers)
			+ (decls?.length ? ' ' + decls.map(x => this.initDeclaratorStr(x)).join(this.comma) : '')
			+ (trailingSemi ? ';' : '');
	}

	methodTail(t: CPP.MethodTail): string {
		const mods = poss(t.isConst, ' const') + poss(t.noexcept, ' noexcept') + poss(t.override, ' override') + poss(t.final, ' final');
		return mods + (
			t.pure			? ' = 0;'
			: t.defaulted	? ' = default;'
			: t.deleted		? ' = delete;'
			: t.declarationOnly ? ';'
			: ' ' + this.block(t.body!)
		);
	}
	ctorTail(t: CPP.CtorTail): string {
		const init = t.initializerList?.length
			? ' : ' + t.initializerList.map(m => m.name + '(' + m.arguments.map(a => this.expr(a, ASSIGN_PREC)).join(this.comma) + ')').join(this.comma)
			: '';
		return init + (
			t.defaulted		? ' = default;'
			: t.deleted		? ' = delete;'
			: t.declarationOnly ? ';'
			: ' ' + this.block(t.body!)
		);
	}

	definition(d: Definition): string {
		switch (d.type) {
			case 'declaration':
			case 'typedef':				return this.declarationLike(d);
			case 'function_def':		return this.declSpec(d.specifiers) + ' ' + this.declStr(d.declarator) + ' ' + this.block(d.body);
			// cpp
			case 'namespace':			return poss(d.inline, 'inline ') + 'namespace' + maybe(d.name, n => ' ' + n) + ' ' + this.curlyBlock(d.body);
			case 'linkage':				return 'extern ' + JSON.stringify(d.language) + ' ' + this.curlyBlock(d.body);
			case 'using_namespace':		return 'using namespace ' + d.name + ';';
			case 'using_decl':			return 'using ' + [...d.scope, d.name].join('::') + ';';
			case 'using_alias':			return 'using ' + d.name + ' = ' + this.typeName(d.target) + ';';
			case 'template':			return 'template<' + d.params.map(p => this.templateParam(p)).join(this.comma) + '> ' + this.templateBody(d.declaration);
			case 'static_assert':		return 'static_assert(' + this.expr(d.condition) + maybe(d.message, m => this.comma + JSON.stringify(m)) + ');';
			case 'method_def':			return maybe(d.specifiers, s => this.declSpec(s) + ' ') + maybe(d.pointer, this.levelsStr.bind(this)) + d.scope.join('::') + '::' + d.name + this.paramList(d.params, d.variadic) + this.methodTail(d.tail);
			case 'constructor_def':		return d.scope.join('::') + '::' + d.name + this.paramList(d.params, d.variadic) + this.ctorTail(d.tail);
			case 'destructor_def':		return d.scope.join('::') + '::~' + d.name + '()' + this.methodTail(d.tail);
			case 'operator_def':		return this.declSpec(d.specifiers) + ' ' + maybe(d.scope, s => s.join('::') + '::') + 'operator' + d.operator + this.paramList(d.params, d.variadic) + this.methodTail(d.tail);
			case 'static_member_def':	return this.declSpec(d.specifiers) + ' ' + maybe(d.pointer, this.levelsStr.bind(this)) + d.scope.join('::') + '::' + d.name
				+ maybe(d.initializer, e => ' = ' + this.expr(e, ASSIGN_PREC))
				+ maybe(d.ctorArgs, a => '(' + a.map(x => this.expr(x, ASSIGN_PREC)).join(this.comma) + ')')
				+ ';';
			default:					throw new Error(`Unknown definition: ${(d as any).type}`);
		}
	}

	forInitStr(i?: Expr | Declaration | TypedefDecl): string {
		if (!i)
			return '';
		return isExpr(i) ? this.expr(i as Expr) : this.declarationLike(i, false);
	}

	statement(s: Statement): string {
		switch (s.type) {
			case 'declaration':
			case 'typedef':				return this.declarationLike(s);
			case 'block':				return this.block(s);
			case 'if':					return 'if (' + this.expr(s.condition) + ') ' + this.dependentCode(s.then) + maybe(s.else, alt => ' else ' + this.dependentCode(alt));
			case 'while':				return 'while (' + this.expr(s.condition) + ') ' + this.dependentCode(s.body);
			case 'do_while':			return 'do ' + this.dependentCode(s.body) + ' while (' + this.expr(s.condition) + ');';
			case 'for':					return 'for (' + this.forInitStr(s.init) + '; ' + maybe(s.condition, c => this.expr(c)) + '; ' + maybe(s.update, u => this.expr(u)) + ') ' + this.dependentCode(s.body);
			case 'switch':				return 'switch (' + this.expr(s.condition) + ') ' + this.dependentCode(s.body);
			case 'case':				return 'case ' + this.expr(s.value) + ': ' + this.statement(s.body);
			case 'default':				return 'default: ' + this.statement(s.body);
			case 'break':				return 'break;';
			case 'continue':			return 'continue;';
			case 'return':				return 'return' + maybe(s.expression, e => ' ' + this.expr(e)) + ';';
			case 'goto':				return 'goto ' + s.label + ';';
			case 'labeled':				return s.label + ': ' + this.statement(s.body);
			case 'empty':				return ';';
			// cpp
			case 'throw':				return 'throw' + maybe(s.argument, a => ' ' + this.expr(a)) + ';';
			case 'try':					return 'try ' + this.block(s.body) + s.handlers.map(h =>
				' catch (' + maybe(h.paramType, t => this.typeName(t)) + poss(h.byRef, '&') + maybe(h.paramName, n => (h.paramType ? ' ' : '') + n) + ') ' + this.block(h.body)
			).join('');
			case 'range_for':			return 'for (' + this.declSpec(s.specifiers) + ' ' + this.declStr(s.declarator) + ' : ' + this.expr(s.range) + ') ' + this.dependentCode(s.body);
			case 'static_assert':
			case 'using_namespace':
			case 'using_decl':
			case 'using_alias':			return this.definition(s as unknown as Definition);
			default:					return isExpr(s) ? this.expr(s) + ';' : (() => { throw new Error(`Unknown statement: ${(s as any).type}`); })();
		}
	}

	// ===================================================================
	//  Class members (cpp)
	// ===================================================================

	structDeclaratorStr(d: CPP.StructDeclarator): string {
		if ('declarator' in d)
			return this.declStr(d.declarator) + maybe(d.initializer, e => ' = ' + this.expr(e, ASSIGN_PREC));
		return (d.name ?? '') + (d.type === 'bitfield' ? ' : ' + this.expr(d.width!, ASSIGN_PREC) : '');
	}

	classMember(m: ClassMember): string {
		const modifiers = (m as {modifiers?: CPP.MemberMod[]}).modifiers;
		const mods = modifiers?.length ? modifiers.join(' ') + ' ' : '';
		switch (m.type) {
			case 'struct_member':		return mods + this.declSpec(m.specifiers) + ' ' + m.declarators.map(d => this.structDeclaratorStr(d)).join(this.comma) + ';';
			case 'access_label':		return m.access + ':';
			case 'constructor':			return mods + m.name + this.paramList(m.params, m.variadic) + this.ctorTail(m);
			case 'destructor':			return mods + '~' + m.name + '()' + this.methodTail(m);
			case 'method':				return mods + this.declSpec(m.specifiers) + ' ' + this.declStr(m.declarator) + this.methodTail(m);
			case 'conversion':			return mods + 'operator ' + this.typeName(m.target) + '()' + this.methodTail(m);
			case 'using_decl':			return 'using ' + [...m.scope, m.name].join('::') + ';';
			case 'using_alias':			return 'using ' + m.name + ' = ' + this.typeName(m.target) + ';';
			case 'member_template':		return 'template<' + m.params.map(p => this.templateParam(p)).join(this.comma) + '> ' + this.classMember(m.declaration);
			default: {
				// 'member_typedef' -- ad hoc shape (`typedef T type;` inside a class body), not part of the declared ClassMember union.
				const mt = m as unknown as {type: string; specifiers?: C.DeclSpec; declarators?: CPP.StructDeclarator[]};
				if (mt.type === 'member_typedef' && mt.specifiers && mt.declarators)
					return 'typedef ' + this.declSpec(mt.specifiers) + ' ' + mt.declarators.map(d => this.structDeclaratorStr(d)).join(this.comma) + ';';
				throw new Error(`Unknown class member: ${mt.type}`);
			}
		}
	}

	// ===================================================================
	//  Expressions
	// ===================================================================

	literal(e: {value: number | string | boolean}): string {
		switch (typeof e.value) {
			case 'string':	return JSON.stringify(e.value);
			case 'boolean':	return e.value ? 'true' : 'false';
			default:			return String(e.value);
		}
	}

	captureStr(c: CPP.LambdaCapture): string {
		if (c.thisCapture)
			return 'this';
		if (c.defaultCapture)
			return c.defaultCapture;
		return poss(c.byRef, '&') + (c.name ?? '') + maybe(c.init, i => '=' + this.expr(i, ASSIGN_PREC));
	}

	// `minPrec`: the precedence tier required of `e` here -- if lower, it gets parens. Defaults to 0 (never wraps).
	expr(e: Expr, minPrec = 0): string {
		return withParens(this.exprBody(e), exprPrecedence(e) < minPrec);
	}

	private exprBody(e: Expr): string {
		switch (e.type) {
			case 'identifier':			return e.name;
			case 'literal':				return this.literal(e);
			case 'char_literal':		return "'" + e.value + "'";
			case 'unary':				return e.operator + poss(/[a-z]/i.test(e.operator), ' ') + this.expr(e.operand, UNARY_PREC);
			case 'unary_post':			return this.expr(e.operand, POSTFIX_PREC) + e.operator;
			case 'binary': {
				const op = e.operator, prec = BINARY_PREC[op] ?? 0, rightAssoc = isAssignOp(op);
				return this.expr(e.left, rightAssoc ? prec + 1 : prec) + this.operator(op) + this.expr(e.right, rightAssoc ? prec : prec + 1);
			}
			case 'conditional':			return this.expr(e.test, LOGICAL_OR_PREC) + this.operator('?') + this.expr(e.consequent, 0) + this.operator(':') + this.expr(e.alternate, CONDITIONAL_PREC);
			case 'subscript':			return this.expr(e.array, POSTFIX_PREC) + '[' + this.expr(e.index) + ']';
			case 'member_access':		return this.expr(e.object, POSTFIX_PREC) + '.' + e.member;
			case 'pointer_member':		return this.expr(e.object, POSTFIX_PREC) + '->' + e.member;
			case 'function_call':		return this.expr(e.function, POSTFIX_PREC) + '(' + e.arguments.map(a => this.expr(a, ASSIGN_PREC)).join(this.comma) + ')';
			case 'cast':				return '(' + this.typeName(e.type1) + ')' + this.expr(e.expression, UNARY_PREC);
			case 'sizeof_type':			return 'sizeof(' + this.typeName(e.operand) + ')';
			// cpp
			case 'this':				return 'this';
			case 'null_literal':		return 'nullptr';
			case 'qualified':			return e.parts.join('::');
			case 'new':					return 'new ' + this.typeSpecifier(e.typeName)
				+ maybe(e.size, s => '[' + this.expr(s) + ']')
				+ (e.braced ? '{' + (e.arguments ?? []).map(a => this.expr(a, ASSIGN_PREC)).join(this.comma) + '}'
					: e.arguments ? '(' + e.arguments.map(a => this.expr(a, ASSIGN_PREC)).join(this.comma) + ')' : '');
			case 'delete':				return 'delete' + poss(e.array, '[]') + ' ' + this.expr(e.operand, UNARY_PREC);
			case 'pack_expansion':		return this.expr(e.operand) + '...';
			case 'sizeof_pack':			return 'sizeof...(' + e.name + ')';
			case 'cpp_cast':			return e.kind + '<' + this.typeName(e.target) + '>(' + this.expr(e.expression) + ')';
			case 'typeid':				return 'typeid(' + (e.expression ? this.expr(e.expression) : this.typeName(e.target!)) + ')';
			case 'alignof':				return 'alignof(' + this.typeName(e.target) + ')';
			case 'functional_cast':		return e.target + '(' + e.arguments.map(a => this.expr(a, ASSIGN_PREC)).join(this.comma) + ')';
			case 'lambda':				return '[' + e.captures.map(c => this.captureStr(c)).join(this.comma) + ']'
				+ this.paramList(e.params, e.variadic)
				+ poss(e.mutable, ' mutable')
				+ maybe(e.returnType, t => ' -> ' + this.typeName(t))
				+ ' ' + this.block(e.body);
			default:					throw new Error(`Unknown expression: ${(e as any).type}`);
		}
	}
}
