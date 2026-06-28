import {
	Rule, Rules, List, termOneOf, GrammarBuilder,
	runParser, nextToken,
	type GrammarSpec, type Parser, type LexState, type ActionEntry, type Token, type Terminal, type LexContext,
} from '../src/tison';
import {
	IDENT, TYPE_NAME,
	PREC_LEVELS,
	type Ctx,
	type Expr, type Statement, type Declarator, type DeclarationSpecifiers, type Declaration,
	type TypeSpecifier, type TypeName, type StructMember, type StructSpecifier, type ParamOrVariadic,
	type Definition, type Block,
	specifier_qualifier_list, type_specifier, struct_or_union_specifier, struct_declaration, struct_declarator_list, struct_body,
	declarator, direct_declarator, pointer, parameter_declaration, parameter_type_list, type_name,
	declaration_specifiers, declaration,
	primary_expression, assignment_expression, expression, argument_expression_list,
	statement, compound_statement, external_definition, function_definition, translation_unit,
} from './c-parser';

// ===================================================================
//  C++ Parser -- an extension of c-parser
// ===================================================================
//
// Adds, on top of the plain-C grammar in c-parser.ts: `class` (with access
// specifiers, single/multiple inheritance, inline member functions,
// constructors/destructors with member-initializer lists, `static`/
// `virtual` members), references (`T&`), `new`/`delete`, `this`/`true`/
// `false`/`nullptr`, the `::` scope-resolution operator, `namespace`/
// `using`, `try`/`catch`/`throw`, lambda expressions, and templates
// (including variadic templates -- parameter packs, pack expansion,
// `sizeof...`) on both class/function *definitions* and on type *use sites*
// (`Box<int>`, `Tuple<int, double, char>`, nested `vector<vector<int>>`).
//
// Like ts-parser.ts does for js-parser.ts, this works almost entirely by
// *mutating* (via `.push`) the Rules arrays c-parser.ts exports, then
// letting this file's own new nonterminals get auto-discovered into the
// same grammar by virtue of being referenced (by object) from those pushed
// rules. No part of c-parser.ts's own rules are removed or rewritten.
//
// `cppParser` doesn't use the `tison()` convenience entry point directly --
// see "Wire it up" below for why (the `>>`-splitting fix for nested generics
// needs a handle on the built grammar's terminals that `tison()` doesn't
// expose).
//
// Known simplifications/omissions:
//   - Member functions are inline-only: there's no out-of-class
//     `RetType ClassName::method() { ... }` definition form, so every
//     method body must live inside the class body itself.
//   - Bare `struct` keeps plain C semantics (a struct's tag name still
//     needs the `struct` prefix at every use site, exactly as in
//     c-parser.ts) -- only `class`-defined names are auto-registered as
//     usable bare type names afterwards, the same lexer-hack trick
//     c-parser.ts already uses for `typedef`.
//   - Template parameters are *not* scoped: `template<typename T> ...`
//     permanently registers `T` as a recognized type name (via the same
//     typedef-name lexer hack) for the rest of the input, rather than only
//     within that one declaration -- a deliberate shortcut to let `T x;`
//     parse inside the template body at all.
//   - Generic type arguments (`Box<int>`) are type-only -- no non-type
//     (`array<int, 5>`) or template-template arguments, and the generic
//     name itself must already be a recognized type (same restriction as
//     `base_specifier` etc. elsewhere in this file) -- no
//     `SomeAlias<T> x;` where `SomeAlias` was never itself declared as a
//     type. Base classes also still can't be generic (`: public Base<T>`).
//   - Lambdas: no implicit return-type deduction beyond what `compound_statement`
//     already gives for free (single/multi-statement bodies are both
//     accepted, but nothing inspects `return` statements to infer a type --
//     callers needing the return type must write a trailing `-> T`), no
//     C++14 generic lambdas (`[](auto x){...}` -- `auto` isn't accepted as
//     a parameter type, since it's already a *storage-class* keyword in
//     c-parser.ts's C grammar and overloading it again risked the same
//     reduce-reduce hazards documented throughout this file).
//   - No operator overloading, no `constexpr`/`noexcept`, no range-based
//     `for`, no exception specifications, no template specialization, no
//     multiple-inheritance diamond/virtual-base distinctions beyond
//     recording each base's own `virtual` flag, no forwarding references
//     (`Args&&...`) -- only `Args...`/`Args&...` parameter packs.
//   - `friend` is not supported at all.
//   - `explicit` is accepted nowhere (not needed by any rule below).

// ===================================================================
//  AST types
// ===================================================================

export type AccessSpecifier = 'public' | 'private' | 'protected';

// A variadic function parameter pack (`Args... args`, or unnamed `Args...`) -- a third member of
// `ParamOrVariadic` alongside c-parser.ts's own `ParameterDeclaration`/`{ type: 'variadic' }`.
export interface PackParameter			{ type: 'parameter'; specifiers: DeclarationSpecifiers; name?: string; byRef?: boolean; pack: true; }

export interface AccessLabel			{ type: 'access_label'; access: AccessSpecifier; }
export interface MemberInitializer		{ name: string; arguments: Expr[]; }
export interface ConstructorMember		{ type: 'constructor'; name: string; parameters: ParamOrVariadic[]; initializerList?: MemberInitializer[]; body: Block; }
export interface DestructorMember		{ type: 'destructor'; name: string; body: Block; virtual?: boolean; }
export interface MethodMember			{ type: 'method'; specifiers: DeclarationSpecifiers; declarator: Declarator; body: Block; isConst?: boolean; virtual?: boolean; static?: boolean; }
export interface UsingDeclMember		{ type: 'using_decl'; scope: string[]; name: string; }
export interface CppStructMember		extends StructMember { static?: boolean; }

export type ClassMember = CppStructMember | AccessLabel | ConstructorMember | DestructorMember | MethodMember | UsingDeclMember;

export interface BaseSpecifier			{ access?: AccessSpecifier; virtual?: boolean; name: string; }
export interface ClassSpecifier		{ type: 'class'; name?: string; bases?: BaseSpecifier[]; members?: ClassMember[]; }

// A reference declarator (`T&`) -- the only new shape added to C's `Declarator` union.
export type CppDeclarator = Declarator | { type: 'reference'; to: Declarator };

export interface LambdaCapture { name?: string; byRef?: boolean; init?: Expr; thisCapture?: boolean; defaultCapture?: '=' | '&'; }
export interface LambdaExpr {
	type: 'lambda'; captures: LambdaCapture[]; params: ParamOrVariadic[];
	returnType?: TypeName; mutable?: boolean; body: Block;
}

export type CppExpr =
	| { type: 'this' }
	| { type: 'bool_literal'; value: boolean }
	| { type: 'null_literal' }
	| { type: 'qualified'; parts: string[] }
	| { type: 'new'; typeName: TypeSpecifier; arguments?: Expr[]; size?: Expr }
	| { type: 'delete'; operand: Expr; array?: boolean }
	| { type: 'pack_expansion'; operand: Expr }
	| { type: 'sizeof_pack'; name: string }
	| LambdaExpr;

// `templateDepth` counts currently-open `Box<...>` generic-type-argument lists -- see the `>>`/`>>=`
// lexer patch in "Wire it up" for why.
export interface CppCtx extends Ctx { templateDepth: number; }

export interface CatchClause			{ paramType?: TypeName; paramName?: string; body: Block; }
export interface UsingDirective		{ type: 'using_namespace'; name: string; }
export interface NamespaceDecl			{ type: 'namespace'; name?: string; definitions: CppDefinition[]; }
export interface TemplateParam			{ name: string; pack?: boolean; }
export interface TemplateDecl			{ type: 'template'; params: TemplateParam[]; declaration: Definition | ClassSpecifier; }

// A type argument at a generic *use* site (`Box<int>`) -- `pack` marks a pack-expansion argument (`Tuple<Args...>`).
export interface TemplateArg			{ value: TypeName; pack?: boolean; }
export interface GenericType			{ type: 'generic'; name: string; args: TemplateArg[]; }

export type CppStatement =
	| { type: 'throw'; argument?: Expr }
	| { type: 'try'; body: Block; handlers: CatchClause[] }
	| UsingDirective
	| UsingDeclMember;

export type CppDefinition = Definition | NamespaceDecl | UsingDirective | UsingDeclMember | TemplateDecl;
export interface CppProgram { type: 'translation_unit'; definitions: CppDefinition[]; }

// ===================================================================
//  Helpers
// ===================================================================

// A name that might already have been registered as a type (a previously
// declared class, or a template parameter) -- accepts either spelling the
// lexer hands back. Used everywhere a *reference* to such a name is
// expected (base-class names, constructor/destructor names, member-
// initializer targets, scoped/qualified names) -- never for the name being
// freshly introduced (that's always a plain IDENT).
const type_ident = Rules<string>(
	Rule([IDENT] as const,		$ => $[0]),
	Rule([TYPE_NAME] as const,	$ => $[0]),
);

// `A::B::C`, for `using` declarations only -- never reachable from expression position, so it can't
// compete with primary_expression's own (separately handled, see below) qualified-name continuation.
const using_path = List(type_ident, '::');

// ===================================================================
//  References (`T&`, `T*&`)
// ===================================================================

const declaratorCast = declarator as unknown as Rules<CppDeclarator>;
declaratorCast.push(
	Rule(['&', direct_declarator] as const,			$ => ({ type: 'reference', to: $[1] } as const)),
	Rule([pointer, '&', direct_declarator] as const,	$ => ({ type: 'reference', to: { type: 'pointer', pointer: $[0], to: $[2] } } as const)),
);

// ===================================================================
//  `auto` type-deduced variable declarations (`auto x = expr;`)
// ===================================================================
//
// `auto` is *only* a legacy storage-class keyword in c-parser.ts's C grammar (`storage_class_specifier`),
// which never appears alone -- `declaration_specifiers` always still needs an actual type alongside it.
// Reusing that path for C++11+ `auto` (a placeholder *type*, never combined with a real one) isn't safe:
// pushing `auto` onto `type_specifier` too would make the bare keyword complete two different one-token
// reductions at once (storage-class vs type) with no further lookahead to pick between them -- exactly
// the reduce-reduce hazard documented throughout this file. Instead, these are pushed directly onto
// `declaration` as their own self-contained alternatives, always shaped `'auto' <declarator-ish> '=' ...`
// -- after shifting `auto`, the existing storage-class path is only ever *completed* (a plain reduce) when
// the lookahead is a real type-starting token, never a bare IDENT/'&'/'*', so this is the same safe
// shift-vs-reduce split used elsewhere (see `method_declarator`, `generic_type_open`), not a fresh ambiguity.
const declarationCast = declaration as unknown as Rules<Declaration>;
declarationCast.push(
	Rule(['auto', IDENT, '=', assignment_expression, ';'] as const,
		$ => ({ type: 'declaration', specifiers: [{ type: 'type', name: 'auto' }], initDeclarators: [{ declarator: { type: 'identifier', name: $[1] }, initializer: $[3] }] } as unknown as Declaration)),
	Rule(['auto', '&', IDENT, '=', assignment_expression, ';'] as const,
		$ => ({ type: 'declaration', specifiers: [{ type: 'type', name: 'auto' }], initDeclarators: [{ declarator: { type: 'reference', to: { type: 'identifier', name: $[2] } }, initializer: $[4] }] } as unknown as Declaration)),
	Rule(['auto', '*', IDENT, '=', assignment_expression, ';'] as const,
		$ => ({ type: 'declaration', specifiers: [{ type: 'type', name: 'auto' }], initDeclarators: [{ declarator: { type: 'pointer', pointer: [{ level: 1 }], to: { type: 'identifier', name: $[2] } }, initializer: $[4] }] } as unknown as Declaration)),
);

// ===================================================================
//  Default parameter values / variadic parameter packs
// ===================================================================

const parameterDeclarationCast = parameter_declaration as unknown as Rules<ParamOrVariadic>;
parameterDeclarationCast.push(
	Rule([declaration_specifiers, declarator, '=', assignment_expression] as const,	$ => ({ type: 'parameter', specifiers: $[0], declarator: $[1] as Declarator, default: $[3] } as const)),
	Rule([declaration_specifiers, '=', assignment_expression] as const,				$ => ({ type: 'parameter', specifiers: $[0], default: $[2] } as const)),

	// Variadic function parameter packs (`Args... args`, `Args&... args`, or an unnamed `Args...`) -- the
	// declaration-side half of variadic templates. No `Args&&...` forwarding references (see header comment).
	Rule([declaration_specifiers, '...', IDENT] as const,			$ => ({ type: 'parameter', specifiers: $[0], name: $[2], pack: true } as const)),
	Rule([declaration_specifiers, '&', '...', IDENT] as const,		$ => ({ type: 'parameter', specifiers: $[0], name: $[3], byRef: true, pack: true } as const)),
	Rule([declaration_specifiers, '...'] as const,					$ => ({ type: 'parameter', specifiers: $[0], pack: true } as const)),
);

// ===================================================================
//  this / true / false / nullptr / qualified names
// ===================================================================

function qualifiedParts(e: Expr | CppExpr): string[] | undefined {
	return (e as any).type === 'qualified' ? (e as any).parts as string[]
		: (e as any).type === 'identifier' ? [(e as any).name as string]
		: undefined;
}

const primaryExpressionCast = primary_expression as unknown as Rules<Expr | CppExpr>;
primaryExpressionCast.push(
	Rule(['this'] as const,		() => ({ type: 'this' } as const)),
	Rule(['true'] as const,		() => ({ type: 'bool_literal', value: true } as const)),
	Rule(['false'] as const,	() => ({ type: 'bool_literal', value: false } as const)),
	Rule(['nullptr'] as const,	() => ({ type: 'null_literal' } as const)),
	// `A::B::C` -- a left-recursive *continuation* of an already-reduced primary_expression (the same
	// shift-based shape postfix_expression's own '.'/'->' continuations use), not a fresh alternative
	// competing to reduce a bare IDENT -- that alternative shape is what caused a genuine reduce-reduce
	// conflict against primary_expression's own pre-existing `[IDENT]` rule (SLR(1) can't use the
	// lookahead -- whether `::` follows -- to pick between two *completed* reductions of the same IDENT).
	Rule([primary_expression, '::', type_ident] as const, $ => ({ type: 'qualified', parts: [...(qualifiedParts($[0]) ?? []), $[2]] } as const)),
);

// ===================================================================
//  Lambda expressions
// ===================================================================

const capture = Rules<LambdaCapture>(
	Rule(['this'] as const,									() => ({ thisCapture: true } as const)),
	Rule(['&'] as const,										() => ({ defaultCapture: '&' } as const)),
	Rule(['='] as const,										() => ({ defaultCapture: '=' } as const)),
	Rule([IDENT] as const,									$ => ({ name: $[0] } as const)),
	Rule(['&', IDENT] as const,								$ => ({ name: $[1], byRef: true } as const)),
	Rule([IDENT, '=', assignment_expression] as const,		$ => ({ name: $[0], init: $[2] } as const)),
	Rule(['&', IDENT, '=', assignment_expression] as const,	$ => ({ name: $[1], byRef: true, init: $[3] } as const)),
);
const capture_list = List(capture, ',');
const capture_list_opt = Rules<LambdaCapture[]>(
	Rule([] as const,				() => []),
	Rule([capture_list] as const,	$ => $[0]),
);
const lambda_params_opt = Rules<ParamOrVariadic[]>(
	Rule([] as const,						() => []),
	Rule([parameter_type_list] as const,	$ => $[0] as ParamOrVariadic[]),
);

// Pushed onto primary_expression (not a dedicated nonterminal kept separate) -- '[' is otherwise never a
// *first* token of primary_expression (postfix_expression's own '[' is a continuation, reached only after
// a primary_expression already exists), so there's no risk of repeating the IDENT-vs-IDENT reduce-reduce
// hazard documented above: this introduces a brand new entry point, not a competing reduction of one already in use.
primaryExpressionCast.push(
	Rule(['[', capture_list_opt, ']', compound_statement] as const,
		$ => ({ type: 'lambda', captures: $[1], params: [], body: $[3] as Block } as const)),
	Rule(['[', capture_list_opt, ']', '(', lambda_params_opt, ')', compound_statement] as const,
		$ => ({ type: 'lambda', captures: $[1], params: $[4], body: $[6] as Block } as const)),
	Rule(['[', capture_list_opt, ']', '(', lambda_params_opt, ')', 'mutable', compound_statement] as const,
		$ => ({ type: 'lambda', captures: $[1], params: $[4], mutable: true, body: $[7] as Block } as const)),
	Rule(['[', capture_list_opt, ']', '(', lambda_params_opt, ')', '->', type_name, compound_statement] as const,
		$ => ({ type: 'lambda', captures: $[1], params: $[4], returnType: $[7] as TypeName, body: $[8] as Block } as const)),
	Rule(['[', capture_list_opt, ']', '(', lambda_params_opt, ')', 'mutable', '->', type_name, compound_statement] as const,
		$ => ({ type: 'lambda', captures: $[1], params: $[4], mutable: true, returnType: $[8] as TypeName, body: $[9] as Block } as const)),
);

// ===================================================================
//  new / delete
// ===================================================================

const assignmentExpressionCast = assignment_expression as unknown as Rules<Expr | CppExpr>;
assignmentExpressionCast.push(
	Rule(['new', type_specifier] as const,											$ => ({ type: 'new', typeName: $[1] } as const), 'unary'),
	Rule(['new', type_specifier, '(', argument_expression_list, ')'] as const,		$ => ({ type: 'new', typeName: $[1], arguments: $[3] } as const), 'unary'),
	Rule(['new', type_specifier, '[', expression, ']'] as const,					$ => ({ type: 'new', typeName: $[1], size: $[3] } as const), 'unary'),
	Rule(['delete', assignment_expression] as const,								$ => ({ type: 'delete', operand: $[1] } as const), 'unary'),
	Rule(['delete', '[', ']', assignment_expression] as const,						$ => ({ type: 'delete', operand: $[3], array: true } as const), 'unary'),

	// Pack expansion (`args...`, e.g. inside a call's argument list, `print(args...)`) -- a left-recursive
	// postfix continuation (same shift-based shape as the `::` continuation above), since unlike most unary
	// operators this one trails its operand rather than leading it.
	Rule([assignment_expression, '...'] as const,									$ => ({ type: 'pack_expansion', operand: $[0] } as const)),
	// `sizeof...(Args)` -- the pack-count counterpart of plain `sizeof`/`sizeof(Type)`, which c-parser.ts
	// already has at this same level.
	Rule(['sizeof', '...', '(', type_ident, ')'] as const,							$ => ({ type: 'sizeof_pack', name: $[3] } as const), 'unary'),
);

// ===================================================================
//  Classes: header, bases, members
// ===================================================================

// Reduces the moment `class IDENT` is seen -- i.e. *before* '{' (and
// everything inside the body) is even shifted -- so the class's own name is
// already a recognized type by the time its body parses, the same timing
// trick c-parser.ts's own `pendingTypedef` relies on for `typedef`.
const class_head = Rules<string>(
	Rule(['class', IDENT] as const, ($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return $[1]; }),
);

const base_specifier = Rules<BaseSpecifier>(
	Rule([type_ident] as const,															$ => ({ name: $[0] } as const)),
	Rule([termOneOf(['public', 'private', 'protected'] as const), type_ident] as const,	$ => ({ access: $[0], name: $[1] } as const)),
	Rule(['virtual', type_ident] as const,													$ => ({ virtual: true, name: $[1] } as const)),
	Rule(['virtual', termOneOf(['public', 'private', 'protected'] as const), type_ident] as const, $ => ({ virtual: true, access: $[1], name: $[2] } as const)),
);
const base_list = List(base_specifier, ',');
const base_clause = Rules<BaseSpecifier[]>(
	Rule([':', base_list] as const, $ => $[1]),
);

// A method's name+params, inlined as `IDENT '(' ... ')'` (rather than routed through the shared
// `declarator`/`direct_declarator` chain, which also completes on a *bare* IDENT alone for plain
// fields via `struct_declarator`). Inlining keeps the IDENT-then-'(' shape a single multi-symbol
// rule, so the parser only ever faces an ordinary shift/reduce choice ('(' next -> shift, keep
// building a method; anything else -> reduce the bare IDENT as a plain field name instead) rather
// than a genuine reduce-reduce tie between two completed one-token rules, which is what happened
// (and which tison's SLR(1) tables can't disambiguate via lookahead) when this went through `declarator`.
const method_declarator = Rules<{ name: string; parameters: ParamOrVariadic[] }>(
	Rule([IDENT, '(', ')'] as const,							$ => ({ name: $[0], parameters: [] } as const)),
	Rule([IDENT, '(', parameter_type_list, ')'] as const,	$ => ({ name: $[0], parameters: $[2] as ParamOrVariadic[] } as const)),
);
const method_signature = Rules<CppDeclarator>(
	Rule([method_declarator] as const,
		$ => ({ type: 'function', name: { type: 'identifier', name: $[0].name }, parameters: $[0].parameters } as const)),
	Rule([pointer, method_declarator] as const,
		$ => ({ type: 'pointer', pointer: $[0], to: { type: 'function', name: { type: 'identifier', name: $[1].name }, parameters: $[1].parameters } } as const)),
	Rule(['&', method_declarator] as const,
		$ => ({ type: 'reference', to: { type: 'function', name: { type: 'identifier', name: $[1].name }, parameters: $[1].parameters } } as const)),
);

const member_initializer = Rules<MemberInitializer>(
	Rule([type_ident, '(', ')'] as const,							$ => ({ name: $[0], arguments: [] } as const)),
	Rule([type_ident, '(', argument_expression_list, ')'] as const, $ => ({ name: $[0], arguments: $[2] } as const)),
);
const member_initializer_list = List(member_initializer, ',');

// `struct_declaration` is C's "one member declaration" production -- widening it here is what lets class bodies mix
// plain fields (already handled by c-parser.ts's own rule) with access labels, methods, constructors, destructors, and using-declarations.
const structDeclarationCast = struct_declaration as unknown as Rules<StructMember | ClassMember>;
structDeclarationCast.push(
	Rule([termOneOf(['public', 'private', 'protected'] as const), ':'] as const,	$ => ({ type: 'access_label', access: $[0] } as const)),

	Rule(['static', specifier_qualifier_list, method_signature, compound_statement] as const,	$ => ({ type: 'method', specifiers: $[1], declarator: $[2] as Declarator, body: $[3] as Block, static: true } as const)),
	Rule(['virtual', specifier_qualifier_list, method_signature, compound_statement] as const,	$ => ({ type: 'method', specifiers: $[1], declarator: $[2] as Declarator, body: $[3] as Block, virtual: true } as const)),
	Rule(['virtual', specifier_qualifier_list, method_signature, 'const', compound_statement] as const, $ => ({ type: 'method', specifiers: $[1], declarator: $[2] as Declarator, body: $[4] as Block, virtual: true, isConst: true } as const)),
	Rule([specifier_qualifier_list, method_signature, compound_statement] as const,				$ => ({ type: 'method', specifiers: $[0], declarator: $[1] as Declarator, body: $[2] as Block } as const)),
	Rule([specifier_qualifier_list, method_signature, 'const', compound_statement] as const,		$ => ({ type: 'method', specifiers: $[0], declarator: $[1] as Declarator, body: $[3] as Block, isConst: true } as const)),

	Rule([type_ident, '(', ')', compound_statement] as const,											$ => ({ type: 'constructor', name: $[0], parameters: [], body: $[3] as Block } as const)),
	Rule([type_ident, '(', parameter_type_list, ')', compound_statement] as const,						$ => ({ type: 'constructor', name: $[0], parameters: $[2] as ParamOrVariadic[], body: $[4] as Block } as const)),
	Rule([type_ident, '(', ')', ':', member_initializer_list, compound_statement] as const,				$ => ({ type: 'constructor', name: $[0], parameters: [], initializerList: $[4], body: $[5] as Block } as const)),
	Rule([type_ident, '(', parameter_type_list, ')', ':', member_initializer_list, compound_statement] as const, $ => ({ type: 'constructor', name: $[0], parameters: $[2] as ParamOrVariadic[], initializerList: $[5], body: $[6] as Block } as const)),

	Rule(['~', type_ident, '(', ')', compound_statement] as const,				$ => ({ type: 'destructor', name: $[1], body: $[4] as Block } as const)),
	Rule(['virtual', '~', type_ident, '(', ')', compound_statement] as const,	$ => ({ type: 'destructor', name: $[2], body: $[5] as Block, virtual: true } as const)),

	Rule(['using', using_path, ';'] as const,	$ => ({ type: 'using_decl', scope: $[1].slice(0, -1), name: $[1][$[1].length - 1] } as const)),

	// Static data member -- no in-class initializer (real C++ only allows that for `static const`/`constexpr` members anyway), a known simplification.
	Rule(['static', specifier_qualifier_list, struct_declarator_list, ';'] as const, $ => ({ type: 'struct_member', typeSpecifiers: $[1], declarators: $[2], static: true } as const)),
);

const typeSpecifierCast = type_specifier as unknown as Rules<TypeSpecifier | GenericType>;
typeSpecifierCast.push(
	Rule(['bool'] as const, () => ({ type: 'type', name: 'bool' } as const)),
);

// ===================================================================
//  Generic type instantiation (`Box<int>`, `Tuple<int, double, char>`,
//  nested `vector<vector<int>>`) -- the use-site half of variadic templates.
// ===================================================================
//
// `ctx.templateDepth` counts how many of these are currently open; see the
// `>>`/`>>=` lexer patch in "Wire it up" below for why it needs to exist at
// all (so `vector<vector<int>>` doesn't lex its trailing `>>` as a single
// right-shift token).

// Reduces the moment `TYPE_NAME '<'` is seen (the same eager two-token
// timing trick `class_head` uses) so the depth counter is incremented
// *before* anything inside the argument list -- including a further nested
// `<...>` -- gets lexed.
const generic_type_open = Rules<string>(
	Rule([TYPE_NAME, '<'] as const, ($, ctx: CppCtx) => { ctx.templateDepth++; return $[0]; }),
);
const template_argument = Rules<TemplateArg>(
	Rule([type_name] as const,				$ => ({ value: $[0] as TypeName } as const)),
	Rule([type_name, '...'] as const,		$ => ({ value: $[0] as TypeName, pack: true } as const)),
);
const template_argument_list = List(template_argument, ',');

// `TYPE_NAME '<'` (shift) vs the plain `[TYPE_NAME]` alt already on `type_specifier` (reduce) is an
// ordinary shift/reduce choice on the very next token ('<' -> shift and keep building a generic type;
// anything else -> reduce the bare type name), not a reduce-reduce tie -- the same safe shape
// `method_declarator` uses above, so this needs no special handling to resolve correctly.
typeSpecifierCast.push(
	Rule([generic_type_open, template_argument_list, '>'] as const,
		($, ctx: CppCtx) => { ctx.templateDepth--; return { type: 'generic', name: $[0], args: $[1] } as const; }),
);

// `struct_or_union_specifier` is C's "struct-or-union header+body" production -- adding 'class' alternatives here is what lets `type_specifier` (which already references this array) accept classes for free.
const structOrUnionSpecifierCast = struct_or_union_specifier as unknown as Rules<StructSpecifier | ClassSpecifier>;
structOrUnionSpecifierCast.push(
	Rule([class_head] as const,											$ => ({ type: 'class', name: $[0] } as const)),
	// A truly empty body (`class Foo {};`) -- c-parser.ts's own `struct_body` has no alternative for this
	// (every one of its alts needs at least a stray ';' or a non-empty `struct_declaration_list`), so it's
	// handled directly here instead of by widening that shared production.
	Rule([class_head, '{', '}'] as const,									$ => ({ type: 'class', name: $[0], members: [] } as const)),
	Rule([class_head, '{', struct_body, '}'] as const,					$ => ({ type: 'class', name: $[0], members: $[2] as ClassMember[] } as const)),
	Rule([class_head, base_clause, '{', '}'] as const,						$ => ({ type: 'class', name: $[0], bases: $[1], members: [] } as const)),
	Rule([class_head, base_clause, '{', struct_body, '}'] as const,		$ => ({ type: 'class', name: $[0], bases: $[1], members: $[3] as ClassMember[] } as const)),
	Rule(['class', '{', '}'] as const,										() => ({ type: 'class', members: [] } as const)),
	Rule(['class', '{', struct_body, '}'] as const,						$ => ({ type: 'class', members: $[2] as ClassMember[] } as const)),
);

// ===================================================================
//  Namespaces / using
// ===================================================================

const externalDefinitionCast = external_definition as unknown as Rules<CppDefinition>;

const namespace_body = List(externalDefinitionCast);
const namespace_decl = Rules<NamespaceDecl>(
	Rule(['namespace', IDENT, '{', '}'] as const,					$ => ({ type: 'namespace', name: $[1], definitions: [] } as const)),
	Rule(['namespace', IDENT, '{', namespace_body, '}'] as const,	$ => ({ type: 'namespace', name: $[1], definitions: $[3] } as const)),
	Rule(['namespace', '{', '}'] as const,							() => ({ type: 'namespace', definitions: [] } as const)),
	Rule(['namespace', '{', namespace_body, '}'] as const,			$ => ({ type: 'namespace', definitions: $[2] } as const)),
);

const using_directive = Rules<UsingDirective>(
	Rule(['using', 'namespace', type_ident, ';'] as const, $ => ({ type: 'using_namespace', name: $[2] } as const)),
);
const using_decl_top = Rules<UsingDeclMember>(
	Rule(['using', using_path, ';'] as const, $ => ({ type: 'using_decl', scope: $[1].slice(0, -1), name: $[1][$[1].length - 1] } as const)),
);

externalDefinitionCast.push(
	Rule([namespace_decl] as const,	$ => $[0]),
	Rule([using_directive] as const,	$ => $[0]),
	Rule([using_decl_top] as const,	$ => $[0]),
);

// ===================================================================
//  Templates (simplified: `template<typename T>` / `template<class T>`,
//  including variadic `template<typename... Ts>` / `template<class... Ts>`)
// ===================================================================

// Registering each parameter as a recognized type name the moment it's
// parsed (not scoped to just this declaration -- see header comment) is
// what lets `T` be used as an ordinary type inside the templated body. The
// TYPE_NAME alternatives exist because a name re-used across two separate
// templates (e.g. two unrelated `template<class T>`s) is already a
// registered type name by the time the second one is parsed.
const template_param = Rules<TemplateParam>(
	Rule(['typename', IDENT] as const,			($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return { name: $[1] }; }),
	Rule(['class', IDENT] as const,				($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return { name: $[1] }; }),
	Rule(['typename', TYPE_NAME] as const,		$ => ({ name: $[1] } as const)),
	Rule(['class', TYPE_NAME] as const,			$ => ({ name: $[1] } as const)),
	// Template parameter packs (`typename... Ts` / `class... Ts`) -- the declaration-side counterpart of
	// `Args... args` function parameter packs, and what lets `Tuple<Args...>` be written as a type argument.
	Rule(['typename', '...', IDENT] as const,	($, ctx: Ctx) => { ctx.typedefNames.add($[2]); return { name: $[2], pack: true }; }),
	Rule(['class', '...', IDENT] as const,		($, ctx: Ctx) => { ctx.typedefNames.add($[2]); return { name: $[2], pack: true }; }),
	Rule(['typename', '...', TYPE_NAME] as const,	$ => ({ name: $[2], pack: true } as const)),
	Rule(['class', '...', TYPE_NAME] as const,	$ => ({ name: $[2], pack: true } as const)),
);
const template_param_list = List(template_param, ',');

externalDefinitionCast.push(
	Rule(['template', '<', template_param_list, '>', struct_or_union_specifier, ';'] as const,
		$ => ({ type: 'template', params: $[2], declaration: $[4] as unknown as ClassSpecifier } as const)),
	Rule(['template', '<', template_param_list, '>', function_definition] as const,
		$ => ({ type: 'template', params: $[2], declaration: $[4] as unknown as Definition } as const)),
);

// ===================================================================
//  try / catch / throw
// ===================================================================

const catch_clause = Rules(
	Rule(['catch', '(', specifier_qualifier_list, IDENT, ')', compound_statement] as const,			$ => ({ paramType: { specifiers: $[2] } as TypeName, paramName: $[3], body: $[5] as Block } as const)),
	Rule(['catch', '(', specifier_qualifier_list, '&', IDENT, ')', compound_statement] as const,		$ => ({ paramType: { specifiers: $[2] } as TypeName, paramName: $[4], body: $[6] as Block } as const)),
	Rule(['catch', '(', specifier_qualifier_list, ')', compound_statement] as const,					$ => ({ paramType: { specifiers: $[2] } as TypeName, body: $[4] as Block } as const)),
	Rule(['catch', '(', '...', ')', compound_statement] as const,									$ => ({ body: $[4] as Block } as const)),
);
const catch_clause_list = List(catch_clause) as unknown as Rules<CatchClause[]>;

const try_statement = Rules<CppStatement>(
	Rule(['try', compound_statement, catch_clause_list] as const, $ => ({ type: 'try', body: $[1] as Block, handlers: $[2] } as const)),
);
const throw_statement = Rules<CppStatement>(
	Rule(['throw', expression, ';'] as const,	$ => ({ type: 'throw', argument: $[1] } as const)),
	Rule(['throw', ';'] as const,				() => ({ type: 'throw' } as const)),
);

const statementCast = statement as unknown as Rules<Statement | CppStatement>;
statementCast.push(
	Rule([try_statement] as const,		$ => $[0]),
	Rule([throw_statement] as const,	$ => $[0]),
	Rule([using_directive] as const,	$ => $[0]),
	Rule([using_decl_top] as const,		$ => $[0]),
);

// ===================================================================
//  Wire it up
// ===================================================================
//
// Not `tison()` directly: the right-shift operator `>>` (and `>>=`) needs a *context-sensitive* lexer
// hook -- when `ctx.templateDepth > 0`, reject the 2-/3-char match so the lexer falls back to a plain
// single-char `>` instead, closing one generic-type-argument level at a time. That's exactly what lets
// `vector<vector<int>>` lex its trailing `>>` as two `>` tokens (closing the inner level, then the outer
// one) instead of one right-shift token -- the same problem real C++ had until C++11 standardized this
// splitting behavior.
//
// The hook has to be attached to whichever single `Terminal` object ends up registered under the name
// `>>` (interning is by name, and c-parser.ts's own right-shift rule -- `Rule([self, '>>', self], ...)`
// in assignment_expression -- already creates one from a bare string literal). `tison()` builds and
// discards its `GrammarBuilder` internally with no way to reach that terminal afterwards, so this
// reimplements `tison()`'s own few lines of plumbing, inserting one extra step in between
// `new GrammarBuilder(spec)` (which is also the point at which every terminal -- including '>>' and
// '>>=', wherever in the grammar they were first referenced -- already exists in `g.terminalsByName`)
// and `g.buildTables()`.

function buildCppParser(spec: GrammarSpec): Parser {
	const g = new GrammarBuilder(spec);

	for (const name of ['>>', '>>='] as const) {
		const term = g.terminalsByName.get(name);
		if (term)
			term.callback = (_, ctx: CppCtx) => ctx.templateDepth > 0 ? undefined : term;
	}

	const tables = g.buildTables();
	const lexEntries = Array.from(g.terminalsByName.values()).filter(t => t.pattern);

	const recover = (row: Map<Terminal, ActionEntry>, tok: Token, prevToken: Token | undefined) => {
		const substitute = spec.recover?.(row, tok, prevToken);
		if (!substitute)
			return undefined;
		const entry = row.get(substitute.type);
		return entry && { entry, tok: substitute };
	};

	const resolveSym = (sym: string | RegExp | Terminal | undefined): Terminal | undefined =>
		typeof sym === 'string'	? g.terminalsByName.get(sym)
		: sym instanceof RegExp	? g.terminalsByName.get(sym.source)
		: sym;

	const createTokenStream = (input: string, ctx: any) => {
		const lexState: LexState = { offset: 0, line: 1, col: 1 };
		let lookahead: Token | undefined;
		return {
			peek: (allowed?: Map<Terminal, ActionEntry>): Token => lookahead ??= nextToken(lexEntries, input, lexState, ctx, resolveSym, allowed),
			peekText: () => input.substring(lexState.offset),
			consume: () => { lookahead = undefined; },
		};
	};

	return {
		tables,
		parse: (input, ctx) => runParser(tables, createTokenStream(input, ctx), ctx, recover, {}),
	};
}

const cppParserSpec = buildCppParser({
	skip: [/\s+/, /#[^\n]*/, /\/\/[^\n]*/, /\/\*[^]*?\*\//],
	precedence: PREC_LEVELS,
	start: translation_unit,
	rules: { translation_unit },
});

export const cppParser = {
	...cppParserSpec,
	parse: (code: string): CppProgram => {
		return cppParserSpec.parse(code, {
			pendingTypedef: false,
			typedefNames: new Set<string>(),
			templateDepth: 0,
		} as CppCtx) as CppProgram;
	},
};
