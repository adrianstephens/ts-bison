import * as C from './c-parser';
import * as CPP from './cpp-parser';

type Definition		= CPP.Definition;
type Statement		= CPP.Statement;
type Expr			= CPP.Expr;
type ClassMember		= CPP.ClassMember;
type Declarator		= CPP.Declarator;
type AbstractDeclarator	= CPP.AbstractDeclarator;
type TypeName		= CPP.TypeName;
type TypeSpecifier	= CPP.TypeSpecifier;
type TypeSpecifierExt	= CPP.TypeSpecifierExt;
type DeclSpec		= CPP.DeclSpec;
type ParamDecl		= CPP.ParamDecl;
type InitDeclarator	= C.InitDeclarator<Declarator>;
type Block			= C.Block<Declarator, TypeSpecifierExt>;
// The `declaration`/`typedef` tags, widened -- cpp's `Definition`/`Statement` unions inline these rather than
// exporting them under their own names, so name the widened instantiations locally.
type Declaration		= C.Declaration<Declarator, TypeSpecifierExt>;
type TypedefDecl		= C.TypedefDecl<Declarator, TypeSpecifierExt>;

// ===================================================================
//  Type Guards
// ===================================================================

export function guard<R>(types: string[]) {
	const set = new Set(types);
	return (node: any): node is R => node && typeof node === 'object' && 'type' in node && set.has(node.type);
}

const definitionTags	= ['declaration', 'typedef', 'function_def', 'namespace', 'linkage', 'using_namespace', 'using_decl', 'using_alias', 'template', 'static_assert', 'method_def', 'constructor_def', 'destructor_def', 'operator_def', 'static_member_def'];
const statementOnlyTags = ['block', 'if', 'while', 'do_while', 'for', 'switch', 'case', 'default', 'break', 'continue', 'return', 'goto', 'labeled', 'empty', 'throw', 'try', 'range_for'];
const exprTags			= ['identifier', 'literal', 'char_literal', 'unary', 'unary_post', 'binary', 'conditional', 'subscript', 'member_access', 'pointer_member', 'function_call', 'cast', 'sizeof_type', 'this', 'null_literal', 'qualified', 'new', 'delete', 'pack_expansion', 'sizeof_pack', 'cpp_cast', 'typeid', 'alignof', 'functional_cast', 'lambda'];
const classMemberTags	= ['struct_member', 'member_typedef', 'access_label', 'constructor', 'destructor', 'method', 'conversion', 'using_decl', 'using_alias', 'member_template'];
const declaratorTags	= ['identifier', 'pointer', 'array', 'function', 'reference', 'rvalue_reference'];
const packParamTags	= ['parameter']; // both ParameterDecl and PackParameter use this tag; distinguished by `pack`

export const isTranslationUnit	= guard<C.TranslationUnit>(['translation_unit']);
export const isDefinition		= guard<Definition>(definitionTags);
export const isStatementOnly	= guard<Statement>(statementOnlyTags);
export const isExpr				= guard<Expr>(exprTags);
export const isClassMember		= guard<ClassMember>(classMemberTags);
export const isDeclarator		= guard<Declarator | AbstractDeclarator>(declaratorTags);
export const isPackParameter	= (p: ParamDecl): p is CPP.PackParameter => !!packParamTags.includes(p.type) && 'pack' in p && !!p.pack;

export function hasMod(e: {modifiers?: string[]}, m: string) {
	return e.modifiers?.includes(m) ?? false;
}
export function dropMod(e: {modifiers?: string[]}, m: string) {
	if (e.modifiers?.includes(m))
		e.modifiers = e.modifiers.filter(i => i != m);
}

//-----------------------------------------------------------------------------
// walk
//-----------------------------------------------------------------------------

interface Process<U> {
	<T extends U>(x: T, recall?: false): T;
	<T extends U>(x?: T, recall?: boolean): T | undefined;
}
type OnAST<U>		= (x: U, process: Process<U>) => U | undefined;

function makeProcess<U>(parts: (x: U) => U, on?: OnAST<U>, always = false) {
	if (on) {
		function process<T extends U>(t: T, recall?: false): T;
		function process<T extends U>(t?: T, recall?: boolean): T | undefined;
		function process<T extends U>(t?: T, recall?: boolean): T | undefined {
			return !t ? undefined : recall ? redo(t) : parts(t) as T;
		}
		const redo = <T extends U>(t?: T) => t ? on(t, process) as T | undefined : undefined;
		return redo;
	}
	return always	? <T extends U>(t?: T) => t ? parts(t) as T : undefined
					: <T extends U>(t?: T) => t;
}

function mapArray<T>(map: (x: T) => T | undefined) {
	return (x: readonly T[]): T[] | undefined => {
		const result = x.map(map).filter(i => i !== undefined);
		return result.length > 0 ? result : undefined;
	};
}
function mapArrayA<T>(map: (x: T) => T | undefined) {
	return (x: readonly T[]): T[] => x.map(map).filter(i => i !== undefined);
}

function mapDefined<T>(map: (x: T) => T | undefined) {
	return (x: T) => notUndefined(map(x));
}

function notUndefined<T>(x: T | undefined): T {
	if (x === undefined)
		throw new Error('mapor returned undefined');
	return x;
}

type NodeMap<N>		= Partial<{[K in keyof N]: (x: Exclude<N[K], undefined>) => Exclude<N[K], undefined> | undefined}>

function mapObject<N extends Record<string, any>>(node: N, fields: NodeMap<N>): N {
	const r = {...node};
	for (const f in fields) {
		const k = f as keyof N;
		if (node[k] !== undefined) {
			const ret = fields[k]?.(node[k]);
			if (ret !== undefined)
				r[k] = ret;
			else
				delete r[k];
		}
	}
	return r;
}

export function walk<T extends C.TranslationUnit | Definition | Statement | Expr | ClassMember | Statement[] | Definition[] | ClassMember[]>(ast: T,
	onDefinition?:	OnAST<Definition>,
	onStatement?:	OnAST<Statement>,
	onExpression?:	OnAST<Expr>,
	onClassMember?:	OnAST<ClassMember>,
): T | undefined {

	// ---- shared leaves (declarators, type-names, specifiers) ----
	// C's declarator/type-name system has no TS analogue -- there's no separate "Type" AST, so these are
	// walked inline wherever a specifiers/declarator field appears, the same way TS's walker inlines BindingTarget.
	// `Declarator` and `AbstractDeclarator` are structurally close (pointer/array/function wrapping) but differ
	// in whether they bottom out at `Identifier` or `undefined`, so they need two distinctly-typed mappers --
	// a single function returning their union isn't assignable back into either one specifically.

	const declarator = (d: Declarator): Declarator => {
		switch (d.type) {
			case 'identifier':			return d;
			case 'pointer':
			case 'reference':
			case 'rvalue_reference':	return mapObject(d, {to: declarator});
			case 'array':				return mapObject(d, {element: declarator, size: arraySize});
			case 'function':			return mapObject(d, {name: declarator, params: mapArrayA(paramDecl)});
		}
	};
	const abstractDeclarator = (d: AbstractDeclarator): AbstractDeclarator => {
		if (!d)
			return d;
		switch (d.type) {
			case 'pointer':
			case 'reference':
			case 'rvalue_reference':	return mapObject(d, {to: abstractDeclarator});
			case 'array':				return mapObject(d, {element: abstractDeclarator, size: arraySize});
			case 'function':			return mapObject(d, {name: abstractDeclarator, params: mapArrayA(paramDecl)});
		}
	};
	// `ArrayDecl.size` deliberately stays typed against C's plain (never-extended) TypeSpecifier -- see
	// c-parser.ts's comment on `ArrayDecl` (the `[type_specifier]` array-size form is obscure enough that
	// threading the cpp extension seam through the whole declarator system for it isn't worth it). Walking it
	// with the wide `typeSpecifier` mapper is still correct behavior; only the field's *declared* type is narrower.
	const arraySize = (s: C.TypeSpecifier | C.Expr): C.TypeSpecifier | C.Expr | undefined =>
		isExpr(s) ? mapExpression(s as Expr) as unknown as C.Expr : typeSpecifier(s as TypeSpecifier) as unknown as C.TypeSpecifier;

	const typeSpecifier = (t: TypeSpecifier): TypeSpecifier => {
		switch (t.type) {
			case 'struct':
			case 'union':
			case 'class':	return mapObject(t, {bases: mapArray(baseSpecifier), body: mapArrayA(mapClassMemberA)});
			case 'enum':	return mapObject(t, {base: typeSpecifier, members: mapArrayA(enumerator)});
			default:		return t; // 'ref', and cpp's GenericType/QualifiedType/DecltypeSpecifier (structurally opaque here)
		}
	};

	const enumerator = (e: C.Enumerator): C.Enumerator => mapObject(e, {init: mapExpression});

	const declSpec = <S extends DeclSpec>(s: S): S => mapObject(s, {type: typeSpecifier} as NodeMap<S>);

	const typeName = (t: TypeName): TypeName => mapObject(t, {specifiers: declSpec, declarator: abstractDeclarator});
	// C's plain `cast`/`sizeof_type` Expr variants keep C's narrow (never-extended) TypeName -- see the `Expr`
	// comment on `cast`/`sizeof_type` above.
	const narrowTypeName = (t: C.TypeName): C.TypeName => typeName(t as TypeName) as unknown as C.TypeName;

	const typeNameOrExpr = (v: TypeName | Expr): TypeName | Expr | undefined => isExpr(v) ? mapExpression(v as Expr) : typeName(v as TypeName);

	const paramDecl = (p: ParamDecl): ParamDecl =>
		isPackParameter(p) ? p : mapObject(p, {specifiers: declSpec, declarator, default: mapExpression});

	const initDeclarator = (d: InitDeclarator): InitDeclarator =>
		isDeclarator(d) ? declarator(d as Declarator)
			: mapObject(d, {declarator, initializer});

	const initializer = (i: C.Initializer): C.Initializer =>
		isExpr(i) ? mapExpression(i as Expr) as C.Initializer
			: mapObject(i, {elements: mapArrayA(initializer)});

	const memberInitializer = (m: CPP.MemberInitializer): CPP.MemberInitializer => mapObject(m, {arguments: mapArrayA(mapExpressionA)});

	const templateArg = (a: CPP.TemplateArg): CPP.TemplateArg => mapObject(a, {value: typeNameOrExpr});
	const templateParam = (p: CPP.TemplateParam): CPP.TemplateParam => mapObject(p, {
		nonType: declSpec,
		default: typeNameOrExpr,
	});
	const baseSpecifier = (b: CPP.BaseSpecifier): CPP.BaseSpecifier => mapObject(b, {args: mapArray(templateArg)});

	const catchClause = (c: CPP.CatchClause): CPP.CatchClause => mapObject(c, {paramType: typeName, body});

	// A struct/class member's own declarators, and cpp's DeclaratorField (declarator + optional initializer).
	const structDeclarator = (d: CPP.StructDeclarator): CPP.StructDeclarator =>
		'declarator' in d ? mapObject(d, {declarator, initializer: mapExpression})
			: mapObject(d, {width: mapExpression});

	const body = (b: Block) => mapObject(b, {body: mapArrayA(mapStatementA)});

	// ---- expressions ----

	const expression = (e: Expr): Expr => {
		switch (e.type) {
			case 'unary':
			case 'unary_post':			return mapObject(e, {operand: mapExpressionA});
			case 'binary':				return mapObject(e, {left: mapExpressionA, right: mapExpressionA});
			case 'conditional':			return mapObject(e, {test: mapExpressionA, consequent: mapExpressionA, alternate: mapExpressionA});
			case 'subscript':			return mapObject(e, {array: mapExpressionA, index: mapExpressionA});
			case 'member_access':
			case 'pointer_member':		return mapObject(e, {object: mapExpressionA});
			case 'function_call':		return mapObject(e, {function: mapExpressionA, arguments: mapArrayA(mapExpressionA)});
			// `cast`/`sizeof_type` come from C's plain Expr (see cpp-parser.ts's `Expr` comment on why it isn't
			// widened) -- their TypeName stays narrow accordingly.
			case 'cast':				return mapObject(e, {type1: narrowTypeName, expression: mapExpressionA});
			case 'sizeof_type':			return mapObject(e, {operand: narrowTypeName});
			// cpp
			case 'new':					return mapObject(e, {typeName: typeSpecifier, arguments: mapArray(mapExpressionA), size: mapExpression, placement: mapArray(mapExpressionA)});
			case 'delete':				return mapObject(e, {operand: mapExpressionA});
			case 'pack_expansion':		return mapObject(e, {operand: mapExpressionA});
			case 'cpp_cast':				return mapObject(e, {target: typeName, expression: mapExpressionA});
			case 'typeid':				return mapObject(e, {expression: mapExpression, target: typeName});
			case 'alignof':				return mapObject(e, {target: typeName});
			case 'functional_cast':		return mapObject(e, {arguments: mapArrayA(mapExpressionA)});
			case 'lambda':				return mapObject(e, {
				captures:	mapArrayA((c: CPP.LambdaCapture) => mapObject(c, {init: mapExpression})),
				params:		mapArrayA(paramDecl),
				returnType:	typeName,
				body,
			});
			// identifier / literal / char_literal / this / null_literal / qualified / sizeof_pack -- no nested AST.
			default:					return e;
		}
	};

	// ---- statements / definitions (share the declaration/typedef branch) ----

	const declarationLike = <S extends Declaration | TypedefDecl>(d: S): S =>
		mapObject(d, {
			specifiers:		declSpec,
			initDeclarators: mapArray(initDeclarator),
			declarators:	mapArray(initDeclarator),
		} as NodeMap<S>);

	// `template<...> declaration` -- a class/struct/union head, a using-alias, or any other Definition variant.
	const templateDeclaration = (x: Definition | CPP.ClassSpecifier | CPP.UsingAlias): Definition | CPP.ClassSpecifier | CPP.UsingAlias | undefined => {
		switch (x.type) {
			case 'class':
			case 'struct':
			case 'union':	return classSpecifier(x);
			case 'using_alias': return mapObject(x, {target: typeName});
			default:		return mapDefinition(x);
		}
	};

	const definitionExtra = (d: Definition): Definition => {
		switch (d.type) {
			case 'declaration':
			case 'typedef':				return declarationLike(d);
			case 'function_def':			return mapObject(d, {specifiers: declSpec, declarator, body});
			// cpp
			case 'namespace':
			case 'linkage':				return mapObject(d, {body: mapArrayA(mapDefinitionA)});
			case 'using_namespace':
			case 'using_decl':			return d;
			case 'using_alias':			return mapObject(d, {target: typeName});
			case 'template':				return mapObject(d, {
				params:		mapArrayA(templateParam),
				declaration: templateDeclaration,
			});
			case 'static_assert':		return mapObject(d, {condition: mapExpressionA});
			case 'method_def':
			case 'operator_def':			return mapObject(d, {
				specifiers:	declSpec,
				params:		mapArrayA(paramDecl),
				tail:		methodTail,
			});
			case 'constructor_def':		return mapObject(d, {params: mapArrayA(paramDecl), tail: ctorTail});
			case 'destructor_def':		return mapObject(d, {tail: methodTail});
			case 'static_member_def':	return mapObject(d, {specifiers: declSpec, initializer: mapExpression, ctorArgs: mapArray(mapExpressionA)});
			default:					return d;
		}
	};

	const methodTail = (t: CPP.MethodTail): CPP.MethodTail => mapObject(t, {body});
	const ctorTail = (t: CPP.CtorTail): CPP.CtorTail => mapObject(t, {initializerList: mapArray(memberInitializer), body});

	const statementExtra = (s: Statement): Statement => {
		switch (s.type) {
			case 'declaration':
			case 'typedef':				return declarationLike(s);
			case 'block':				return mapObject(s, {body: mapArrayA(mapStatementA)});
			case 'if':					return mapObject(s, {condition: mapExpressionA, then: mapStatementA, else: mapStatement});
			case 'while':
			case 'do_while':				return mapObject(s, {condition: mapExpressionA, body: mapStatementA});
			case 'for':					return mapObject(s, {
				// `ForClauses.init`'s `Expr` component is C's plain (never-extended) Expr too -- same residual
				// narrowness as `ArrayDecl.size` above.
				init:		(i: C.Expr | Declaration | TypedefDecl): C.Expr | Declaration | TypedefDecl | undefined =>
					isExpr(i) ? mapExpression(i as Expr) as unknown as C.Expr : declarationLike(i),
				condition:	mapExpression,
				update:		mapExpression,
				body:		mapStatementA,
			});
			case 'switch':				return mapObject(s, {condition: mapExpressionA, body: mapStatementA});
			case 'case':					return mapObject(s, {value: mapExpressionA, body: mapStatementA});
			case 'default':				return mapObject(s, {body: mapStatementA});
			case 'return':				return mapObject(s, {expression: mapExpression});
			case 'labeled':				return mapObject(s, {body: mapStatementA});
			// cpp
			case 'throw':				return mapObject(s, {argument: mapExpression});
			case 'try':					return mapObject(s, {body, handlers: mapArrayA(catchClause)});
			case 'range_for':			return mapObject(s, {specifiers: declSpec, declarator, range: mapExpressionA, body: mapStatementA});
			case 'static_assert':		return mapObject(s, {condition: mapExpressionA});
			case 'using_alias':			return mapObject(s, {target: typeName});
			case 'using_namespace':
			case 'using_decl':			return s;
			// break / continue / goto / empty -- no nested AST.
			default:					return isExpr(s) ? expression(s) as Statement : s;
		}
	};

	// ---- class members (cpp) ----

	const classSpecifier = (c: CPP.ClassSpecifier): CPP.ClassSpecifier => mapObject(c, {bases: mapArray(baseSpecifier), body: mapArrayA(mapClassMemberA)});

	const classMember = (m: ClassMember | {type: 'member_typedef'; specifiers: DeclSpec; declarators: CPP.StructDeclarator[]}): ClassMember => {
		switch (m.type) {
			case 'struct_member':		return mapObject(m, {specifiers: declSpec, declarators: mapArrayA(structDeclarator)});
			case 'member_typedef':		return mapObject(m, {specifiers: declSpec, declarators: mapArrayA(structDeclarator)}) as unknown as ClassMember;
			case 'access_label':		return m;
			case 'constructor':			return mapObject(m, {params: mapArrayA(paramDecl), initializerList: mapArray(memberInitializer), body});
			case 'destructor':			return mapObject(m, {body});
			case 'method':				return mapObject(m, {specifiers: declSpec, declarator, body});
			case 'conversion':			return mapObject(m, {target: typeName, body});
			case 'using_decl':			return m;
			case 'using_alias':			return mapObject(m, {target: typeName});
			case 'member_template':		return mapObject(m, {params: mapArrayA(templateParam), declaration: classMemberU});
			default:					return m;
		}
	};
	const classMemberU = (m: ClassMember) => classMember(m);

	const mapStatement		= makeProcess(statementExtra, onStatement, true);
	const mapDefinition		= makeProcess(definitionExtra, onDefinition, true);
	const mapExpression		= makeProcess(expression, onExpression);
	const mapClassMember	= makeProcess(classMember as (x: ClassMember) => ClassMember, onClassMember, true);

	const mapExpressionA	= mapDefined(mapExpression);
	const mapStatementA		= mapDefined(mapStatement);
	const mapDefinitionA	= mapDefined(mapDefinition);
	const mapClassMemberA	= mapDefined(mapClassMember);

	if (Array.isArray(ast)) {
		if (ast.length === 0)
			return ast as T;
		const first = ast[0];
		if (isClassMember(first))
			return mapArray(mapClassMember)(ast as ClassMember[]) as T;
		if (isDefinition(first) && !isStatementOnly(first))
			return mapArray(mapDefinition)(ast as Definition[]) as T;
		return mapArray(mapStatement)(ast as Statement[]) as T;
	}
	if (isTranslationUnit(ast))
		return {...ast, body: mapArray(mapDefinition)(ast.body) ?? []} as T;
	if (isClassMember(ast))
		return mapClassMember(ast as ClassMember) as T;
	if (isDefinition(ast) && !isStatementOnly(ast))
		return mapDefinition(ast as Definition) as T;
	if (isStatementOnly(ast) || isDefinition(ast))
		return mapStatement(ast as Statement) as T;
	return mapExpression(ast as Expr) as T;
}

//-----------------------------------------------------------------------------
// walkB
//-----------------------------------------------------------------------------

type ProcessB<U>	= <T extends U>(x?: T, recall?: boolean) => boolean;
type OnASTB<U>		= (x: U, process: ProcessB<U>) => boolean;

function makeProcessB<U>(parts: (x: U) => boolean, on?: OnASTB<U>, always = false) {
	if (on) {
		const process	= (t?: U, recall?: boolean) => !t ? false : recall ? redo(t) : parts(t);
		const redo		= (t?: U) => t ? on(t, process) : false;
		return redo;
	}
	return always	? (t?: U) => t ? parts(t) : false
					: (_?: U) => false;
}

export function walkB<T extends C.TranslationUnit | Definition | Statement | Expr | ClassMember | Statement[] | Definition[] | ClassMember[]>(ast: T,
	onDefinition?:	OnASTB<Definition>,
	onStatement?:	OnASTB<Statement>,
	onExpression?:	OnASTB<Expr>,
	onClassMember?:	OnASTB<ClassMember>,
): boolean {

	const walkDeclarator = (d?: Declarator | AbstractDeclarator): boolean => {
		if (!d)
			return false;
		switch (d.type) {
			case 'identifier':			return false;
			case 'pointer':
			case 'reference':
			case 'rvalue_reference':	return walkDeclarator(d.to);
			case 'array':				return walkDeclarator(d.element) || (isExpr(d.size) ? walkExpression(d.size) : walkTypeSpecifier(d.size));
			case 'function':			return walkDeclarator(d.name) || d.params.some(walkParamDecl);
		}
	};

	const walkTypeSpecifier = (t?: TypeSpecifier): boolean => {
		if (!t)
			return false;
		switch (t.type) {
			case 'struct':
			case 'union':
			case 'class':	return !!t.body?.some(walkClassMember);
			case 'enum':	return !!t.members?.some(m => walkExpression(m.init));
			default:		return false;
		}
	};
	const walkDeclSpec = (s?: DeclSpec): boolean => !!s && walkTypeSpecifier(s.type);
	const walkTypeName = (t?: TypeName): boolean => !!t && (walkDeclSpec(t.specifiers) || walkDeclarator(t.declarator));
	const walkParamDecl = (p: ParamDecl): boolean => isPackParameter(p) ? false : walkDeclSpec(p.specifiers) || walkDeclarator(p.declarator) || walkExpression(p.default);
	const walkInitDeclarator = (d: InitDeclarator): boolean => isDeclarator(d) ? walkDeclarator(d as Declarator) : walkDeclarator(d.declarator) || walkInitializer(d.initializer);
	const walkInitializer = (i?: C.Initializer): boolean => !i ? false : isExpr(i) ? walkExpression(i as Expr) : i.elements.some(walkInitializer);
	const walkStructDeclarator = (d: CPP.StructDeclarator): boolean => 'declarator' in d ? walkDeclarator(d.declarator) || walkExpression(d.initializer) : walkExpression(d.width);
	const walkStructMember = (m: CPP.StructMember): boolean => walkDeclSpec(m.specifiers) || m.declarators.some(walkStructDeclarator);
	const walkTemplateArg = (a: CPP.TemplateArg): boolean => isExpr(a.value) ? walkExpression(a.value) : walkTypeName(a.value);
	const walkTemplateParam = (p: CPP.TemplateParam): boolean => walkDeclSpec(p.nonType) || (!!p.default && (isExpr(p.default) ? walkExpression(p.default) : walkTypeName(p.default)));
	const walkBaseSpecifier = (b: CPP.BaseSpecifier): boolean => !!b.args?.some(walkTemplateArg);
	const walkCatchClause = (c: CPP.CatchClause): boolean => walkTypeName(c.paramType) || c.body.body.some(walkStatement);
	const walkMemberInitializer = (m: CPP.MemberInitializer): boolean => m.arguments.some(walkExpression);
	const walkBlock = (b?: Block): boolean => !!b && b.body.some(walkStatement);
	const walkMethodOrCtorTail = (t: CPP.MethodTail | CPP.CtorTail): boolean =>
		'initializerList' in t ? (!!t.initializerList?.some(walkMemberInitializer) || walkBlock(t.body))
			: walkBlock((t as CPP.MethodTail).body);

	const expression = (e: Expr): boolean => {
		switch (e.type) {
			case 'unary':
			case 'unary_post':			return walkExpression(e.operand);
			case 'binary':				return walkExpression(e.left) || walkExpression(e.right);
			case 'conditional':			return walkExpression(e.test) || walkExpression(e.consequent) || walkExpression(e.alternate);
			case 'subscript':			return walkExpression(e.array) || walkExpression(e.index);
			case 'member_access':
			case 'pointer_member':		return walkExpression(e.object);
			case 'function_call':		return walkExpression(e.function) || e.arguments.some(walkExpression);
			case 'cast':				return walkTypeName(e.type1) || walkExpression(e.expression);
			case 'sizeof_type':			return walkTypeName(e.operand);
			// cpp
			case 'new':					return walkTypeSpecifier(e.typeName) || !!e.arguments?.some(walkExpression) || walkExpression(e.size) || !!e.placement?.some(walkExpression);
			case 'delete':				return walkExpression(e.operand);
			case 'pack_expansion':		return walkExpression(e.operand);
			case 'cpp_cast':				return walkTypeName(e.target) || walkExpression(e.expression);
			case 'typeid':				return walkExpression(e.expression) || walkTypeName(e.target);
			case 'alignof':				return walkTypeName(e.target);
			case 'functional_cast':		return e.arguments.some(walkExpression);
			case 'lambda':				return e.captures.some(c => walkExpression(c.init)) || e.params.some(walkParamDecl) || walkTypeName(e.returnType) || walkBlock(e.body);
			default:					return false;
		}
	};

	const declarationLike = (d: Declaration | TypedefDecl): boolean =>
		walkDeclSpec(d.specifiers)
		|| (d.type === 'typedef' ? d.declarators.some(walkInitDeclarator) : !!d.initDeclarators?.some(walkInitDeclarator));

	const definition = (d: Definition): boolean => {
		switch (d.type) {
			case 'declaration':
			case 'typedef':				return declarationLike(d);
			case 'function_def':			return walkDeclSpec(d.specifiers) || walkDeclarator(d.declarator) || walkBlock(d.body);
			// cpp
			case 'namespace':
			case 'linkage':				return d.body.some(walkDefinition);
			case 'using_alias':			return walkTypeName(d.target);
			case 'template':				return d.params.some(walkTemplateParam) || (
				d.declaration.type === 'class' || d.declaration.type === 'struct' || d.declaration.type === 'union'
					? !!d.declaration.bases?.some(walkBaseSpecifier) || !!d.declaration.body?.some(walkClassMember)
					: d.declaration.type === 'using_alias' ? walkTypeName(d.declaration.target)
					: walkDefinition(d.declaration as Definition)
			);
			case 'static_assert':		return walkExpression(d.condition);
			case 'method_def':
			case 'operator_def':			return walkDeclSpec(d.specifiers) || d.params.some(walkParamDecl) || walkMethodOrCtorTail(d.tail);
			case 'constructor_def':		return d.params.some(walkParamDecl) || walkMethodOrCtorTail(d.tail);
			case 'destructor_def':		return walkMethodOrCtorTail(d.tail);
			case 'static_member_def':	return walkDeclSpec(d.specifiers) || walkExpression(d.initializer) || !!d.ctorArgs?.some(walkExpression);
			default:					return false;
		}
	};

	const statement = (s: Statement): boolean => {
		switch (s.type) {
			case 'declaration':
			case 'typedef':				return declarationLike(s);
			case 'block':				return s.body.some(walkStatement);
			case 'if':					return walkExpression(s.condition) || walkStatement(s.then) || (!!s.else && walkStatement(s.else));
			case 'while':
			case 'do_while':				return walkExpression(s.condition) || walkStatement(s.body);
			case 'for':					return (s.init ? (isExpr(s.init) ? walkExpression(s.init) : declarationLike(s.init)) : false)
				|| walkExpression(s.condition) || walkExpression(s.update) || walkStatement(s.body);
			case 'switch':				return walkExpression(s.condition) || walkStatement(s.body);
			case 'case':					return walkExpression(s.value) || walkStatement(s.body);
			case 'default':				return walkStatement(s.body);
			case 'return':				return walkExpression(s.expression);
			case 'labeled':				return walkStatement(s.body);
			// cpp
			case 'throw':				return walkExpression(s.argument);
			case 'try':					return s.body.body.some(walkStatement) || s.handlers.some(walkCatchClause);
			case 'range_for':			return walkDeclSpec(s.specifiers) || walkDeclarator(s.declarator) || walkExpression(s.range) || walkStatement(s.body);
			case 'static_assert':		return walkExpression(s.condition);
			case 'using_alias':			return walkTypeName(s.target);
			default:					return isExpr(s) && expression(s);
		}
	};

	const classMember = (m: ClassMember): boolean => {
		switch (m.type) {
			case 'struct_member':		return walkStructMember(m);
			case 'constructor':			return m.params.some(walkParamDecl) || !!m.initializerList?.some(walkMemberInitializer) || walkBlock(m.body);
			case 'destructor':			return walkBlock(m.body);
			case 'method':				return walkDeclSpec(m.specifiers) || walkDeclarator(m.declarator) || walkBlock(m.body);
			case 'conversion':			return walkTypeName(m.target) || walkBlock(m.body);
			case 'using_alias':			return walkTypeName(m.target);
			case 'member_template':		return m.params.some(walkTemplateParam) || walkClassMember(m.declaration);
			default:					return (m as unknown as {type: 'member_typedef'; specifiers: DeclSpec; declarators: CPP.StructDeclarator[]}).type === 'member_typedef'
				? walkDeclSpec((m as any).specifiers) || (m as any).declarators.some(walkStructDeclarator)
				: false;
		}
	};

	const walkStatement		= makeProcessB(statement, onStatement, true);
	const walkDefinition		= makeProcessB(definition, onDefinition, true);
	const walkExpression	= makeProcessB(expression, onExpression);
	const walkClassMember	= makeProcessB(classMember, onClassMember, true);

	if (Array.isArray(ast)) {
		if (ast.length === 0)
			return false;
		const first = ast[0];
		if (isClassMember(first))
			return (ast as ClassMember[]).some(walkClassMember);
		if (isDefinition(first) && !isStatementOnly(first))
			return (ast as Definition[]).some(walkDefinition);
		return (ast as Statement[]).some(walkStatement);
	}
	if (isTranslationUnit(ast))
		return ast.body.some(walkDefinition);
	if (isClassMember(ast))
		return walkClassMember(ast as ClassMember);
	if (isDefinition(ast) && !isStatementOnly(ast))
		return walkDefinition(ast as Definition);
	if (isStatementOnly(ast) || isDefinition(ast))
		return walkStatement(ast as Statement);
	return walkExpression(ast as Expr);
}
