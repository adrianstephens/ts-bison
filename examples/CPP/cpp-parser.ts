import {
	makeRule, Rules, List, OneOf, termOneOf, makeParser, terminal, WithPrec, removeRules, ForceFork
} from '../../src/tison';
import { preprocess, PreprocessOptions } from './preprocessor';
import { Literal, Identifier } from '../common';
import * as C from './c-parser';

// ===================================================================
//  C++14 Parser -- an extension of c-parser
// ===================================================================
//
// Extends the plain-C grammar in c-parser.ts toward full C++14 (to the extent an SLR(1)+lexer-hack
// architecture allows).
//
// Known simplifications/omissions (beyond "parses but doesn't validate"):
//   - Names from external headers aren't magically types -- nothing is preprocessed or looked up; seed them via `cppParser.parse(code, knownTypes)`.
//   - Type registrations aren't scoped -- once a name is a type it stays one for the rest of the input.
//   - No preprocessor (directives skipped as comments); attributes/`alignas` skipped lexically.
//   - No user-defined literals, ref-qualified methods, placement new, `template` disambiguator,
//     out-of-class definitions of template class members, `::x` global qualifier, `Box<int>::iterator`,
//     or adjacent string-literal concatenation.
//   - Functional casts work for registered names (`T(x)`) but not builtin types; cv-qualifiers on pointer levels parse but are discarded.
//   - `override`/`final` are real keywords, not contextual; `goto` labels can't reuse type names.

// ===================================================================
//  AST types
// ===================================================================

export type AccessSpecifier = 'public' | 'private' | 'protected';

// A variadic function parameter pack (`Args... args`, `Args&&... args`, or unnamed `Args...`) -- pushed onto
// c-parser.ts's `parameter_declaration` alongside its own plain `ParameterDecl` (a `C.ParamList.params` element,
// distinct from the trailing `...` ellipsis, which is `ParamList.variadic`).
export interface PackParameter			{ type: 'parameter'; specifiers: C.DeclarationSpecifiers; name?: string; byRef?: boolean; rvalueRef?: boolean; pack: true; }

export interface AccessLabel			{ type: 'access_label'; access: AccessSpecifier; }
export interface MemberInitializer		{ name: string; arguments: C.Expr[]; }

// The suffix of a member function past its parameter list: cv/noexcept/virt-specifiers plus how it ends
// (a body, a bare declaration `;`, pure-virtual `= 0;`, `= default;`, or `= delete;`).
export interface MethodTail {
	isConst?: boolean; noexcept?: boolean; override?: boolean; final?: boolean;
	body?: C.Block; declarationOnly?: boolean; pure?: boolean; defaulted?: boolean; deleted?: boolean;
}
// How a constructor ends: an optional member-initializer list plus body, or `= default;`/`= delete;`/declaration-only.
export interface CtorTail				{ initializerList?: MemberInitializer[]; body?: C.Block; declarationOnly?: boolean; defaulted?: boolean; deleted?: boolean; }

const MemberMod = ['static', 'virtual', 'inline', 'constexpr', 'explicit', 'friend', 'mutable'] as const;
export type MemberMod = typeof MemberMod[number];

export interface ConstructorMember		extends CtorTail, C.ParamList { type: 'constructor'; name: string; modifiers?: MemberMod[]; }
export interface DestructorMember		extends MethodTail { type: 'destructor'; name: string; modifiers?: MemberMod[]; }
export interface MethodMember			extends MethodTail { type: 'method'; specifiers: C.DeclarationSpecifiers; declarator: C.Declarator; modifiers?: MemberMod[]; }
export interface ConversionMember		extends MethodTail { type: 'conversion'; target: C.TypeName; modifiers?: MemberMod[]; }
export interface UsingDeclMember		{ type: 'using_decl'; scope: string[]; name: string; }

// C's own StructDeclarator is bitfield/bare-name only; C++ struct/unknown-type fields also carry a full declarator (pointers, arrays, references) plus an optional initializer.
export interface DeclaratorField		{ declarator: Declarator; initializer?: C.Expr; }
export type StructDeclarator			= C.StructDeclarator | DeclaratorField;

export interface StructMember			extends C.StructMember<StructDeclarator> { modifiers?: MemberMod[]; }
export function StructMember(typeSpecifiers: C.DeclSpecItem[], declarators: StructDeclarator[], modifiers?: MemberMod[]): StructMember { return { type: 'struct_member', typeSpecifiers, declarators, modifiers}; }
export interface MemberTemplate			{ type: 'member_template'; params: TemplateParam[]; declaration: ClassMember; }

export type ClassMember = StructMember | AccessLabel | ConstructorMember | DestructorMember | MethodMember | ConversionMember | UsingDeclMember | UsingAlias | MemberTemplate;

export interface BaseSpecifier			{ access?: AccessSpecifier; virtual?: boolean; name: string; args?: TemplateArg[]; }
export interface ClassSpecifier			{ type: 'class' | 'struct' | 'union'; name?: string; final?: boolean; bases?: BaseSpecifier[]; body?: ClassMember[]; }
export interface CppEnumSpecifier		{ type: 'enum'; name?: string; scoped?: boolean; base?: C.TypeSpecifier[]; members?: C.Enumerator[]; }

export type Declarator = C.Declarator
	| { type: 'reference'; to: C.Declarator }
	| { type: 'rvalue_reference'; to: C.Declarator };

export interface LambdaCapture { name?: string; byRef?: boolean; init?: C.Expr; thisCapture?: boolean; defaultCapture?: '=' | '&'; }
export interface LambdaExpr extends C.ParamList { type: 'lambda'; captures: LambdaCapture[]; returnType?: C.TypeName; mutable?: boolean; body: C.Block; }

export type Expr = C.Expr
	| { type: 'this' }
	| Literal<boolean>
	| { type: 'null_literal' }
	| { type: 'qualified'; parts: string[] }
	| { type: 'new'; typeName: C.TypeSpecifier; arguments?: C.Expr[]; size?: C.Expr; braced?: boolean; placement?: C.Expr[] }
	| { type: 'delete'; operand: C.Expr; array?: boolean }
	| { type: 'pack_expansion'; operand: C.Expr }
	| { type: 'sizeof_pack'; name: string }
	| { type: 'cpp_cast'; kind: string; target: C.TypeName; expression: C.Expr }
	| { type: 'typeid'; expression?: C.Expr; target?: C.TypeName }
	| { type: 'alignof'; target: C.TypeName }
	| { type: 'functional_cast'; target: string; arguments: C.Expr[] }
	| LambdaExpr;

// Counts currently-open `Box<...>` generic-arg lists (for `>>` splitting, see "Wire it up" below). Its presence
// also gates the shared IDENT callback into C++ mode, so TYPE_SCOPE reclassification never fires for plain cParser.
export interface CppCtx extends C.Ctx { templateDepth: number; }

export interface CatchClause			{ paramType?: C.TypeName; paramName?: string; byRef?: boolean; body: C.Block; }
export interface UsingDirective			{ type: 'using_namespace'; name: string; }
export interface UsingAlias				{ type: 'using_alias'; name: string; target: C.TypeName; }
export interface NamespaceDecl			{ type: 'namespace'; name?: string; inline?: boolean; body: Definition[]; }
export interface LinkageSpec			{ type: 'linkage'; language: string; body: Definition[]; }
export interface StaticAssert			{ type: 'static_assert'; condition: C.Expr; message: string; }
export interface TemplateParam			{ name: string; pack?: boolean; nonType?: C.DeclarationSpecifiers; default?: C.TypeName | C.Expr; }
export interface TemplateDecl			{ type: 'template'; params: TemplateParam[]; declaration: C.Definition | ClassSpecifier | UsingAlias; }

// A type argument at a generic *use* site (`Box<int>`) -- `pack` marks a pack-expansion argument (`Tuple<Args...>`),
// `value` is a TypeName for type arguments or an Expr for non-type ones (`array<int, 5>`).
export interface TemplateArg			{ value: C.TypeName | C.Expr; pack?: boolean; }
export interface GenericType			{ type: 'generic'; name: string; args: TemplateArg[]; }
export interface QualifiedType			{ type: 'qualified_type'; parts: string[]; dependent?: boolean; }
export interface DecltypeSpecifier		{ type: 'decltype'; expression?: C.Expr; auto?: boolean; }

export interface OutOfClassMethod		extends C.ParamList { type: 'method_def'; specifiers?: C.DeclarationSpecifiers; pointer?: C.Levels; scope: string[]; name: string; tail: MethodTail; }
export interface OutOfClassCtor			extends C.ParamList { type: 'constructor_def'; scope: string[]; name: string; tail: CtorTail; }
export interface OutOfClassDtor			{ type: 'destructor_def'; scope: string[]; name: string; tail: MethodTail; }
export interface OperatorDef			extends C.ParamList { type: 'operator_def'; specifiers: C.DeclarationSpecifiers; scope?: string[]; operator: string; tail: MethodTail; }
export interface StaticMemberDef		{ type: 'static_member_def'; specifiers: C.DeclarationSpecifiers; pointer?: C.Levels; scope: string[]; name: string; initializer?: C.Expr; ctorArgs?: C.Expr[]; }

export type Statement = C.Statement
	| { type: 'throw'; argument?: C.Expr }
	| { type: 'try'; body: C.Block; handlers: CatchClause[] }
	| { type: 'range_for'; specifiers: C.DeclarationSpecifiers; declarator: C.Declarator; range: C.Expr; body: Statement }
	| StaticAssert
	| UsingDirective
	| UsingAlias
	| UsingDeclMember;

export type Definition = C.Definition
	| NamespaceDecl
	| LinkageSpec
	| UsingDirective
	| UsingDeclMember
	| UsingAlias
	| TemplateDecl
	| StaticAssert
	| OutOfClassMethod
	| OutOfClassCtor
	| OutOfClassDtor
	| OperatorDef
	| StaticMemberDef;

// ===================================================================
//  The TYPE_SCOPE lexer hack
// ===================================================================
// One step past c-parser.ts's typedef hack: a name followed by `::` lexes as TYPE_SCOPE, not TYPE_NAME, turning
// `Foo::bar()` vs `Foo::Inner x;` into a plain lexer decision -- gated on `ctx.templateDepth` so plain C is unaffected.
export const TYPE_SCOPE = terminal('TYPE_SCOPE');

// Opens an explicit-template-argument call (`get_leb128<uint32>(file)`) -- decided lexically since forks lex
// with the pre-fork ctx, so a templateDepth-mutating fork can't make `>>` splitting branch-dependent.
export const TEMPLATE_FN = terminal('TEMPLATE_FN');
// `<args>(` is a call; `<args>` right before `)` `,` is a template-id used as a value (`vput(tput<T>)`)
// -- as comparisons those would leave `>` with no right operand, so the template reading is safe.
const TEMPLATE_CALL_RE = /^\s*<[^;{}<>]*>\s*[(),]/;

// Destructures `match`/`remaining` in the body, not the parameter list: a destructured first arrow param followed
// by a typed second is a known tison grammar gap -- unreachable due to LR state-merging with object literals.
C.IDENT.callback = (lex, ctx: CppCtx) => {
	const { match, remaining } = lex;
	// `name::` is a scope whether or not `name` was registered -- in C++ nothing else can precede `::`,
	// and real code qualifies with names declared only in (unresolved) headers all the time.
	if (ctx.templateDepth !== undefined && /^\s*::(?!:)/.test(remaining))
		return TYPE_SCOPE;
	if (!ctx.typedefNames.has(match))
		return ctx.templateDepth !== undefined && TEMPLATE_CALL_RE.test(remaining) ? TEMPLATE_FN : C.IDENT;
	// A member name after `.`/`->` is never a type, whatever it collides with (`fSymb->type`), but it
	// may still be an explicit-template-arg call (`file.get<uint32>()`) -- `<...>(`` decides.
	if (ctx.templateDepth !== undefined && (lex.prev?.type.name === '.' || lex.prev?.type.name === '->'))
		return TEMPLATE_CALL_RE.test(remaining) ? TEMPLATE_FN : C.IDENT;
	// After a completed type or declarator lead-in (`* & && >`), a registered name followed by `, ; )` is
	// a declarator name or plain variable either way -- never another specifier (`int token, x;`).
	const prevName = lex.prev?.type.name;
	if (ctx.templateDepth !== undefined
			&& prevName !== undefined
			&& (prevName === 'TYPE_NAME' || ['*', '&', '&&', '>'].includes(prevName) || (C.BUILTIN_TYPE as readonly string[]).includes(prevName))
			&& /^\s*[,;)]/.test(remaining))
		return C.IDENT;
	// A registered name can still head an explicit-template-arg call (`C::as<float>()` where `as` also
	// names a type somewhere) -- `<...>(` never reads as comparison-then-parenthesis.
	if (ctx.templateDepth !== undefined && TEMPLATE_CALL_RE.test(remaining))
		return TEMPLATE_FN;
	// Shadowing demotion: C++ lets a variable share a class's name (`class file` + `char *file`), so a registered
	// name before anything no *type* can precede (member access, assignment, comparison, subscript) is really a variable.
	if (ctx.templateDepth !== undefined && (
			/^\s*(?:\.(?!\.)|->|\+\+|--|<<=?|>>=|!=|<=|>=|==|[-+*/%&|^]=|=(?!=)|[-+/%^?](?!=)|\|\|?(?!=)|:(?!:))/.test(remaining)
			|| (/^\s*\[/.test(remaining) && lex.prev?.type.name !== 'new')))
		return C.IDENT;
	return C.TYPE_NAME;
};

// ===================================================================
//  Helpers
// ===================================================================

const Rule = makeRule<CppCtx>();

// `A::B::` -- one or more TYPE_SCOPE'd names, each consuming its own `::`. The building block of every
// qualified construct (types, expressions, out-of-class definitions, using-declarations).
const scope_prefix = Rules<string[]>(self => [
	Rule([TYPE_SCOPE, '::'],			$ => [$[0]]),
	Rule([self, TYPE_SCOPE, '::'],		$ => [...$[0], $[1]]),
]);

// A name that may already be registered as a type (class/namespace/template param) -- accepts any lexer spelling.
// Used only where a *reference* to such a name is expected, never for a freshly-introduced name (always plain IDENT).
const type_ident = Rules<string>(
	Rule([C.IDENT],		$ => $[0]),
	Rule([C.TYPE_NAME],	$ => $[0]),
	Rule([TYPE_SCOPE],	$ => $[0]),
);

// `A::B::C`, for `using` declarations only -- never reachable from expression position, so it can't
// compete with the (separately handled, see below) qualified-name expressions.
const using_path = List(type_ident, '::');


// ===================================================================
//  C++14 literals
// ===================================================================
// Pushed onto primary_expression; each wins over C's narrower literals purely by longest-match lexing
// (e.g. `0x1F` beats C's INT `0` + IDENT `x1F`). Digit-separator patterns require a `'` so they never tie on length.

const INT_SUFFIX = /(?:[uU](?:ll?|LL?)?|(?:ll?|LL?)[uU]?)?/.source;
const HEX_LITERAL		= new RegExp('0[xX][0-9a-fA-F]+(?:\'[0-9a-fA-F]+)*' + INT_SUFFIX);
const BIN_LITERAL		= new RegExp('0[bB][01]+(?:\'[01]+)*' + INT_SUFFIX);
const SEP_INT_LITERAL	= new RegExp('[0-9]+(?:\'[0-9]+)+' + INT_SUFFIX);
const LL_INT_LITERAL	= new RegExp('[0-9]+(?:[uU](?:ll|LL)|(?:ll|LL)[uU]?|[uU]ll?)');	// `ll`/`ull` suffixes C's single-letter suffix pattern can't reach
const EXP_FLOAT_LITERAL	= /[0-9]+(?:'[0-9]+)*(?:\.[0-9']*)?[eE][-+]?[0-9]+[fFlL]?/;			// exponent without a decimal point (`1e5`)
const DOT_FLOAT_LITERAL	= /\.[0-9]+(?:[eE][-+]?[0-9]+)?[fFlL]?/;							// leading-dot floats (`.5`)

const stripSep = (s: string) => s.replace(/'/g, '').replace(/[uUlL]+$/, '');

// String/char prefixes and raw strings. The raw-string pattern uses a regex backreference (`\1`) to match
// the arbitrary user-chosen delimiter -- something regexes "can't do", except JS regexes always could.
const PREFIXED_STRING	= /(?:u8|[uUL])"(?:[^"\\]|\\.)*"/;
const RAW_STRING		= /(?:u8|[uUL])?R"([^ ()\\\t\n]*)\(([^]*?)\)\1"/;
const PREFIXED_CHAR		= /(?:u8|[uUL])'(?:[^'\\]|\\.)*'/;

// ===================================================================
//  Gaps in the C grammar that C++ code trips over constantly
// ===================================================================

const primary_expression	= C.primary_expression as unknown as Rules<Expr>;
const assignment_expression = C.assignment_expression as unknown as Rules<Expr>;
const struct_declaration	= C.struct_declaration as unknown as Rules<C.StructMember | ClassMember>;

primary_expression.push(
	Rule([HEX_LITERAL],			$ => Literal(parseInt(stripSep($[0]).slice(2), 16))),
	Rule([BIN_LITERAL],			$ => Literal(parseInt(stripSep($[0]).slice(2), 2))),
	Rule([SEP_INT_LITERAL],		$ => Literal(parseInt(stripSep($[0]), 10))),
	Rule([LL_INT_LITERAL],		$ => Literal(parseInt(stripSep($[0]), 10))),
	Rule([EXP_FLOAT_LITERAL],	$ => Literal(parseFloat(stripSep($[0])))),
	Rule([DOT_FLOAT_LITERAL],	$ => Literal(parseFloat($[0]))),
	Rule([PREFIXED_STRING],		$ => Literal($[0])),
	Rule([RAW_STRING],			$ => Literal($[0])),
	Rule([PREFIXED_CHAR],		$ => ({ type: 'char_literal', value: $[0] })),
);


// Shadowing tolerance, grammar side (see the lexer demotion above for the token side): where the next token
// can't disambiguate (`f(a, size)`), let a registered name still read as an expression operand or declarator name.
primary_expression.push(
	// ForceFork: in condition/argument positions a lone registered name is one-token-ambiguous with a
	// declaration's specifier list (`if (errors)` vs `if (int x = ...`), same as js-parser's primary ident.
	ForceFork(Rule([C.TYPE_NAME],	$ => Identifier($[0]))),
);

// Adjacent string-literal concatenation (`printf(TAG ": failed\n")` after macro expansion) -- the IDENT-led form
// tolerates macros defined in an unresolvable header, since an identifier right before a string is never anything else.
const string_concat = Rules<string>(self => [
	Rule([C.STRING_LITERAL, C.STRING_LITERAL],	$ => $[0].slice(0, -1) + $[1].slice(1)),
	Rule([C.IDENT, C.STRING_LITERAL],			$ => $[1]),
	Rule([self, C.STRING_LITERAL],				$ => $[0].slice(0, -1) + $[1].slice(1)),
]);
primary_expression.push(
	Rule([string_concat],						$ => ({ type: 'literal', value: $[0] } as const)),
);
C.direct_declarator.push(
	// ForceFork: in `int token, x;` (with `token` also registered) this reduce ties with
	// `type_specifier -> TYPE_NAME` and earlier-rule-wins picks the specifier, dying at the ','.
	ForceFork(Rule([C.TYPE_NAME],				$ => Identifier($[0]))),
);

// C's specifier_qualifier_list can only *trail* with qualifiers (`int const`); C++ style leads with them
// (`const char*`, `const auto&`). A right-recursive leading alternative fixes all of those at once.
C.specifier_qualifier_list.push(
	Rule([C.type_qualifier, C.specifier_qualifier_list],	$ => [$[0], ...$[1]]),
);

// Unknown-type parameters (`f(CgStruct *Cg)`): a parameter list holds only declarations, so `IDENT * IDENT` can't
// be an expression there. Bare `IDENT` alone stays an expression (`int x(a);` keeps its most-vexing-parse reading).
C.parameter_declaration.push(
	Rule([C.IDENT, C.pointer, C.IDENT],	$ => ({ type: 'parameter', specifiers: [C.RefType($[0])], declarator: C.Pointer($[1], Identifier($[2])) } as const)),
	Rule([C.IDENT, C.pointer],			$ => ({ type: 'parameter', specifiers: [C.RefType($[0])], declarator: C.Pointer($[1], Identifier('')) } as const)),
	Rule([C.IDENT, '&', C.IDENT],		$ => ({ type: 'parameter', specifiers: [C.RefType($[0])], declarator: { type: 'reference', to: Identifier($[2]) } as unknown as C.Declarator } as const)),
	Rule([C.IDENT, C.IDENT],			$ => ({ type: 'parameter', specifiers: [C.RefType($[0])], declarator: Identifier($[1]) } as const)),
);

// Unknown-type members/globals (`FILE *fd;`): at member/external scope `IDENT * IDENT ;` can't be an expression,
// so this narrow shape is safe. Statement scope is excluded -- there `A * b;` is genuinely ambiguous with multiplication.
const unknown_type_field = Rules<StructMember>(
	Rule([C.IDENT, C.pointer, C.IDENT, ';'],		$ => StructMember([C.RefType($[0])], [{ declarator: C.Pointer($[1], Identifier($[2])) }])),
	Rule([C.IDENT, C.pointer, C.TYPE_NAME, ';'],	$ => StructMember([C.RefType($[0])], [{ declarator: C.Pointer($[1], Identifier($[2])) }])),
);
struct_declaration.push(
	unknown_type_field,
);

// Casts through unknown pointer types (`(MemoryPoolCleanup*)fn`). ForceFork: after `( IDENT` the `*` is
// one-token-ambiguous with multiplication. `*`s are spelled inline, not via `pointer`, so the fork tag reaches this rule.
assignment_expression.push(
	ForceFork(Rule(['(', C.IDENT, '*', ')', C.assignment_expression],		$ => ({ type: 'cast', type1: { specifiers: [C.RefType($[1])], declarator: C.Pointer([1], undefined) }, expression: $[4] } as const))),
	ForceFork(Rule(['(', C.IDENT, '*', '*', ')', C.assignment_expression],	$ => ({ type: 'cast', type1: { specifiers: [C.RefType($[1])], declarator: C.Pointer([2], undefined) }, expression: $[5] } as const))),
);

// Constructor-style init (`int x(5);`): an unregistered identifier inside the parens reads as an argument, matching
// what such code usually means. Spelled at direct_declarator level so the parens' contents (params vs args) decide.
(C.init_declarator as unknown as Rules<unknown>).push(
	Rule([C.direct_declarator, '(', C.argument_expression_list, ')'],				$ => ({ declarator: $[0], ctorArgs: $[2] })),
	Rule([C.pointer, C.direct_declarator, '(', C.argument_expression_list, ')'],	$ => ({ declarator: C.Pointer($[0], $[1]), ctorArgs: $[3] })),
);

// Zero-argument calls (`g()`) -- C's postfix_expression only had the argument_expression_list form, and that list (like every List here) is non-empty.
(C.postfix_expression as unknown as Rules<Expr>).push(
	Rule([C.postfix_expression, '(', ')'],	$ => ({ type: 'function_call', function: $[0], arguments: [] } as const)),
);


// `for (;;)` and friends: C's for-clause rules all demand a leading expression or declaration, so every empty-slot
// combination needs its own shape (a `declaration` clause already consumes its own first `;`, hence the shorter forms).
C.for_statement.push(
	Rule([';', ';'],											_ => ({ init: undefined })),
	Rule([';', ';', C.expression],								$ => ({ init: undefined, update: $[2] })),
	Rule([';', C.expression, ';'],								$ => ({ init: undefined, condition: $[1] })),
	Rule([';', C.expression, ';', C.expression],				$ => ({ init: undefined, condition: $[1], update: $[3] })),
	Rule([C.expression, ';', ';'],								$ => ({ init: $[0] })),
	Rule([C.expression, ';', ';', C.expression],				$ => ({ init: $[0], update: $[3] })),
	Rule([C.expression, ';', C.expression, ';'],				$ => ({ init: $[0], condition: $[2] })),
	Rule([C.declaration, ';'],									$ => ({ init: $[0] })),
	Rule([C.declaration, ';', C.expression],					$ => ({ init: $[0], update: $[2] })),
	Rule([C.declaration, C.expression, ';'],					$ => ({ init: $[0], condition: $[1] })),
);

// cv-qualified pointer levels (`const char* const* p`). The qualifier is accepted and discarded --
// C's Pointer AST shape has nowhere to hang it, and widening that is a c-parser.ts change.
C.pointer.push(
	Rule(['*', C.type_qualifier],				_ => [1]),
	Rule(['*', C.type_qualifier, C.pointer],	$ => [$[2].length + 1, ...$[2]]),
);

// Functional casts (`T(3.14)`, `T()`) -- the ctor-call-shaped counterpart of C's `(T)x`. Only for
// registered names: TYPE_NAME in expression position is otherwise inert, so this steals nothing.
primary_expression.push(
	Rule([C.TYPE_NAME, '(', C.argument_expression_list, ')'],	$ => ({ type: 'functional_cast', target: $[0], arguments: $[2] })),
	Rule([C.TYPE_NAME, '(', ')'],								$ => ({ type: 'functional_cast', target: $[0], arguments: [] })),
);

// ===================================================================
//  `auto` as a real type / new type specifiers
// ===================================================================

// C++11 repurposed `auto` from a storage class into a placeholder type -- removed entirely here (not kept alongside)
// so the keyword never completes two different one-token reductions at once, avoiding a reduce-reduce hazard.
removeRules(C.storage_class_specifier, rhs => rhs.length === 1 && rhs[0] === 'auto');

const CPP_SIMPLE_TYPE = termOneOf(['auto', 'bool', 'wchar_t', 'char16_t', 'char32_t']);

const type_specifier = C.type_specifier as unknown as Rules<C.TypeSpecifier | GenericType | QualifiedType | DecltypeSpecifier>;
type_specifier.push(
	Rule([CPP_SIMPLE_TYPE],						$ => C.RefType($[0])),
	Rule(['decltype', '(', C.expression, ')'],	$ => ({ type: 'decltype', expression: $[2] } as const)),
	Rule(['decltype', '(', 'auto', ')'],		_ => ({ type: 'decltype', auto: true } as const)),
);

// New C++ declaration specifiers. `constexpr` et al. ride the same storage-class slot C already threads
// through declaration_specifiers everywhere.
(C.storage_class_specifier as unknown as Rules<string>).push(
	Rule(['inline'],		_ => 'inline'),
	Rule(['constexpr'],		_ => 'constexpr'),
	Rule(['thread_local'],	_ => 'thread_local'),
);

// C's declaration_specifiers allows at most one storage-class-like specifier; C++ regularly stacks two
// (`static constexpr int x`). Two is enough in practice -- three-deep stacks are vanishingly rare.
C.declaration_specifiers.push(
	Rule([C.storage_class_specifier, C.storage_class_specifier, C.specifier_qualifier_list],	($, ctx) => { ctx.pendingTypedef = $[0] === 'typedef' || $[1] === 'typedef'; return [$[0], $[1], ...$[2]]; }),
);

// ===================================================================
//  References (`T&`, `T&&`, `T*&`)
// ===================================================================

const declarator = C.declarator as unknown as Rules<Declarator>;
declarator.push(
	Rule(['&', C.direct_declarator],				$ => ({ type: 'reference', to: $[1] } as const)),
	Rule([C.pointer, '&', C.direct_declarator],		$ => ({ type: 'reference', to: C.Pointer($[0], $[2])} as const)),
	Rule(['&&', C.direct_declarator],				$ => ({ type: 'rvalue_reference', to: $[1] } as const)),
	Rule([C.pointer, '&&', C.direct_declarator],	$ => ({ type: 'rvalue_reference', to: C.Pointer($[0], $[2]) } as const)),
);

// Abstract reference declarators, so `int&`/`int&&` work as bare type-names (casts, template args, unnamed params).
// Pushed as new alternatives rather than through direct_abstract_declarator -- a reference is always outermost.
(C.abstract_declarator as unknown as Rules<unknown>).push(
	Rule(['&'],				_ => ({ type: 'reference' } as const)),
	Rule(['&&'],			_ => ({ type: 'rvalue_reference' } as const)),
	Rule([C.pointer, '&'],	$ => ({ type: 'reference', to: C.Pointer($[0], undefined) } as const)),
	Rule([C.pointer, '&&'],	$ => ({ type: 'rvalue_reference', to: C.Pointer($[0], undefined) } as const)),
);

// ===================================================================
//  Parameters: defaults, abstract (unnamed), variadic packs
// ===================================================================

const parameter_declaration = C.parameter_declaration;
parameter_declaration.push(
	Rule([C.declaration_specifiers, C.declarator, '=', C.assignment_expression],	$ => ({ type: 'parameter', specifiers: $[0], declarator: $[1], default: $[3] } as const)),
	Rule([C.declaration_specifiers, '=', C.assignment_expression],					$ => ({ type: 'parameter', specifiers: $[0], default: $[2] } as const)),

	// Unnamed-but-shaped parameters (`void f(int*)`, `void f(const Foo&)`) -- missing even from the C
	// grammar, which only had fully-named or bare-specifier parameters.
	Rule([C.declaration_specifiers, C.abstract_declarator],	$ => ({ type: 'parameter', specifiers: $[0], declarator: $[1] as C.Declarator} as const)),

	// Variadic function parameter packs -- the declaration-side half of variadic templates, now including
	// forwarding references (`Args&&... args`).
	Rule([C.declaration_specifiers, '...', C.IDENT],		$ => ({ type: 'parameter', specifiers: $[0], name: $[2], pack: true } as const)),
	Rule([C.declaration_specifiers, '&', '...', C.IDENT],	$ => ({ type: 'parameter', specifiers: $[0], name: $[3], byRef: true, pack: true } as const)),
	Rule([C.declaration_specifiers, '&&', '...', C.IDENT],	$ => ({ type: 'parameter', specifiers: $[0], name: $[3], rvalueRef: true, pack: true } as const)),
	Rule([C.declaration_specifiers, '...'],					$ => ({ type: 'parameter', specifiers: $[0], pack: true } as const)),
	Rule([C.declaration_specifiers, '&', '...'],			$ => ({ type: 'parameter', specifiers: $[0], byRef: true, pack: true } as const)),
	Rule([C.declaration_specifiers, '&&', '...'],			$ => ({ type: 'parameter', specifiers: $[0], rvalueRef: true, pack: true } as const)),
);

// ===================================================================
//  this / true / false / nullptr / qualified names
// ===================================================================

function qualifiedParts(e: Expr): string[] | undefined {
	return (e as any).type === 'qualified' ? (e as any).parts as string[]
		: (e as any).type === 'identifier' ? [(e as any).name as string]
		: undefined;
}

primary_expression.push(
	Rule(['this'],									_ => ({ type: 'this' } as const)),
	Rule(['true'],									_ => Literal(true)),
	Rule(['false'],									_ => Literal(false)),
	Rule(['nullptr'],								_ => ({ type: 'null_literal' } as const)),
	// `A::B::C` rooted at an *unregistered* name -- a left-recursive continuation of an already-reduced
	// primary_expression (not a fresh alternative), since a competing shape here caused a real reduce-reduce conflict.
	Rule([C.primary_expression, '::', type_ident],	$ => ({ type: 'qualified', parts: [...(qualifiedParts($[0]) ?? []), $[2]] } as const)),
	// `Foo::bar`, `Enum::VALUE` rooted at a *registered* name -- TYPE_SCOPE (see above) keeps this from colliding with
	// the qualified-*type* rules: the third token's kind (IDENT here, TYPE_NAME there) is the whole decision.
	Rule([scope_prefix, C.IDENT],					$ => ({ type: 'qualified', parts: [...$[0], $[1]] } as const)),
	// ...except when the member name itself shadows a registered type (`Scope::list` as an argument).
	// That's a genuine reduce-reduce tie with the qualified-type rules, so let GLR try both.
	ForceFork(Rule([scope_prefix, C.TYPE_NAME],		$ => ({ type: 'qualified', parts: [...$[0], $[1]] } as const))),
);

// ===================================================================
//  Lambda expressions
// ===================================================================

const capture = Rules<LambdaCapture>(
	Rule(['this'],										_ => ({ thisCapture: true } as const)),
	Rule(['&'],											_ => ({ defaultCapture: '&' } as const)),
	Rule(['='],											_ => ({ defaultCapture: '=' } as const)),
	Rule([C.IDENT],										$ => ({ name: $[0] } as const)),
	Rule(['&', C.IDENT],								$ => ({ name: $[1], byRef: true } as const)),
	Rule([C.IDENT, '=', C.assignment_expression],		$ => ({ name: $[0], init: $[2] } as const)),
	Rule(['&', C.IDENT, '=', C.assignment_expression],	$ => ({ name: $[1], byRef: true, init: $[3] } as const)),
);
const capture_list = List(capture, ',');
const capture_list_opt = Rules<LambdaCapture[]>(
	Rule([],					_ => []),
	capture_list,
);
const lambda_params_opt = Rules<C.ParamList>(
	Rule([],					_ => ({ params: [] })),
	C.parameter_type_list,
);

// Pushed onto primary_expression -- '[' is never a *first* token of primary_expression otherwise, so this is a new
// entry point, not a competing reduction. Generic lambdas need no extra rules: `auto` is already an ordinary type_specifier.
primary_expression.push(
	Rule(['[', capture_list_opt, ']', C.compound_statement],															$ => ({ type: 'lambda', captures: $[1], params: [], body: $[3] } as const)),
	Rule(['[', capture_list_opt, ']', '(', lambda_params_opt, ')', C.compound_statement],								$ => ({ type: 'lambda', captures: $[1], ...$[4], body: $[6] } as const)),
	Rule(['[', capture_list_opt, ']', '(', lambda_params_opt, ')', 'mutable', C.compound_statement],					$ => ({ type: 'lambda', captures: $[1], ...$[4], mutable: true, body: $[7] } as const)),
	Rule(['[', capture_list_opt, ']', '(', lambda_params_opt, ')', '->', C.type_name, C.compound_statement],			$ => ({ type: 'lambda', captures: $[1], ...$[4], returnType: $[7], body: $[8] } as const)),
	Rule(['[', capture_list_opt, ']', '(', lambda_params_opt, ')', 'mutable', '->', C.type_name, C.compound_statement],	$ => ({ type: 'lambda', captures: $[1], ...$[4], mutable: true, returnType: $[8], body: $[9] } as const)),
);

// ===================================================================
//  new / delete
// ===================================================================

assignment_expression.push(
	WithPrec(Rule(['new', C.type_specifier],										$ => ({ type: 'new', typeName: $[1] } as const)), 'unary'),
	WithPrec(Rule(['new', C.type_specifier, '(', ')'],								$ => ({ type: 'new', typeName: $[1], arguments: [] } as const)), 'unary'),
	WithPrec(Rule(['new', C.type_specifier, '(', C.argument_expression_list, ')'],	$ => ({ type: 'new', typeName: $[1], arguments: $[3] } as const)), 'unary'),
	WithPrec(Rule(['new', C.type_specifier, '{', C.argument_expression_list, '}'],	$ => ({ type: 'new', typeName: $[1], arguments: $[3], braced: true } as const)), 'unary'),
	WithPrec(Rule(['new', C.type_specifier, '[', C.expression, ']'],				$ => ({ type: 'new', typeName: $[1], size: $[3] } as const)), 'unary'),
	// Placement new (`new(pool) T(args)`) -- the `(` right after `new` can't start a type_specifier, so
	// these never compete with the ordinary forms.
	WithPrec(Rule(['new', '(', C.argument_expression_list, ')', C.type_specifier],	$ => ({ type: 'new', placement: $[2], typeName: $[4] } as const)), 'unary'),
	WithPrec(Rule(['new', '(', C.argument_expression_list, ')', C.type_specifier, '(', ')'],								$ => ({ type: 'new', placement: $[2], typeName: $[4], arguments: [] } as const)), 'unary'),
	WithPrec(Rule(['new', '(', C.argument_expression_list, ')', C.type_specifier, '(', C.argument_expression_list, ')'],	$ => ({ type: 'new', placement: $[2], typeName: $[4], arguments: $[6] } as const)), 'unary'),
	WithPrec(Rule(['new', '(', C.argument_expression_list, ')', C.type_specifier, '[', C.expression, ']'],					$ => ({ type: 'new', placement: $[2], typeName: $[4], size: $[6] } as const)), 'unary'),
	WithPrec(Rule(['delete', C.assignment_expression],								$ => ({ type: 'delete', operand: $[1] } as const)), 'unary'),
	WithPrec(Rule(['delete', '[', ']', C.assignment_expression],					$ => ({ type: 'delete', operand: $[3], array: true } as const)), 'unary'),

	// Pack expansion (`args...`) -- a left-recursive postfix continuation (same shape as the `::` continuation
	// above), since unlike most unary operators this one trails its operand rather than leading it.
	Rule([C.assignment_expression, '...'],											$ => ({ type: 'pack_expansion', operand: $[0] } as const)),
	// `sizeof...(Args)` -- the pack-count counterpart of plain `sizeof`/`sizeof(Type)`, which c-parser.ts
	// already has at this same level.
	WithPrec(Rule(['sizeof', '...', '(', type_ident, ')'],							$ => ({ type: 'sizeof_pack', name: $[3] } as const)), 'unary'),
);

// ===================================================================
//  C++ casts / typeid / alignof / static_assert
// ===================================================================

// `static_cast<vector<int>>(x)` has the same trailing-`>>` problem as nested generics, so the cast's own `<`
// maintains templateDepth too -- bumped on open, dropped on close, so `a >> b` inside the parens still lexes as shift.
const cast_open = Rules<string>(
	Rule([termOneOf(['static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast']), '<'],	($, ctx) => { ctx.templateDepth++; return $[0]; }),
);
const cast_close = Rules<{ kind: string; target: C.TypeName }>(
	Rule([cast_open, C.type_name, '>'],			($, ctx) => { ctx.templateDepth--; return { kind: $[0], target: $[1] }; }),
);

primary_expression.push(
	Rule([cast_close, '(', C.expression, ')'],	$ => ({ type: 'cpp_cast', ...$[0], expression: $[2] } as const)),
	// Same TYPE_NAME-vs-expression split sizeof already relies on: a bare registered type can only be the
	// type_name alternative, anything expression-shaped only the expression one.
	Rule(['typeid', '(', C.expression, ')'],	$ => ({ type: 'typeid', expression: $[2] } as const)),
	Rule(['typeid', '(', C.type_name, ')'],		$ => ({ type: 'typeid', target: $[2] } as const)),
);
assignment_expression.push(
	WithPrec(Rule(['alignof', '(', C.type_name, ')'],	$ => ({ type: 'alignof', target: $[2] } as const)), 'unary'),
);

const static_assert_decl = Rules<StaticAssert>(
	Rule(['static_assert', '(', C.assignment_expression, ',', C.STRING_LITERAL, ')', ';'],	$ => ({ type: 'static_assert', condition: $[2], message: $[4] } as const)),
);

// ===================================================================
//  Qualified and generic types
// ===================================================================
// `ctx.templateDepth` counts how many generic-type-argument lists are open; needed so `vector<vector<int>>` doesn't
// lex its trailing `>>` as a single right-shift token (see the `>>`/`>>=` lexer patch in "Wire it up" below).

// Reduces the moment `TYPE_NAME '<'` is seen so depth increments before any nested `<...>` is lexed. Kept as a
// separate nonterminal from type_specifier: a TYPE_SCOPE shift there would beat the reduce an out-of-class def needs.
const generic_type_open = Rules<string>(
	Rule([C.TYPE_NAME, '<'],							($, ctx) => { ctx.templateDepth++; return $[0]; }),
);
const scoped_generic_open = Rules<string>(
	Rule([scope_prefix, C.TYPE_NAME, '<'],				($, ctx) => { ctx.templateDepth++; return [...$[0], $[1]].join('::'); }),
	Rule([scope_prefix, C.IDENT, '<'],					($, ctx) => { ctx.templateDepth++; return [...$[0], $[1]].join('::'); }),
);
// IDENT-rooted variant for base clauses ONLY -- in expression-reachable positions `IDENT <` must stay a
// comparison, so this must never be spliced anywhere general.
const base_generic_open = Rules<string>(
	Rule([C.IDENT, '<'],								($, ctx) => { ctx.templateDepth++; return $[0]; }),
);

// Explicit-template-argument calls, free and member (`get_leb128<uint32>(file)`). TEMPLATE_FN comes from the lexer,
// so `a < b` comparisons never reach these rules; the open-nonterminals bump templateDepth before args are lexed.
const template_fn_open = Rules<string>(
	Rule([TEMPLATE_FN, '<'],							($, ctx) => { ctx.templateDepth++; return $[0]; }),
);
const member_template_fn_open = Rules<{ object: unknown; member: string; arrow?: boolean }>(
	Rule([C.postfix_expression, '.', TEMPLATE_FN, '<'],	($, ctx) => { ctx.templateDepth++; return { object: $[0], member: $[2] }; }),
	Rule([C.postfix_expression, '->', TEMPLATE_FN, '<'],($, ctx) => { ctx.templateDepth++; return { object: $[0], member: $[2], arrow: true }; }),
);

// Non-type template args (`array<int, 5>`) -- deliberately not full constant_expression: relationals here would put
// `>` shifts in competition with the closing `>` reduce. A literal/name/sizeof plus a parenthesized escape hatch covers real usage.
const const_arg = Rules<C.Expr>(
	Rule([C.INT_LITERAL],					$ => ({ type: 'literal', value: parseInt($[0], 10) })),
	Rule([C.IDENT],							$ => Identifier($[0])),
	Rule(['true'],							_ => Literal(true) as unknown as C.Expr),
	Rule(['false'],							_ => Literal(false) as unknown as C.Expr),
	Rule(['-', C.INT_LITERAL],				$ => ({ type: 'literal', value: -parseInt($[1], 10) })),
	Rule(['sizeof', '(', C.type_name, ')'],	$ => ({ type: 'sizeof_type', operand: $[2] })),
	Rule(['(', C.expression, ')'],			$ => $[1]),
	// Qualified names with an unregistered tail (`SEI::buffering_period` as a template argument).
	Rule([scope_prefix, C.IDENT],			$ => ({ type: 'qualified', parts: [...$[0], $[1]] } as unknown as C.Expr)),
	// Member-pointer constants (`T_checktype<S, &U::top_expr>` -- the SFINAE detection idiom).
	Rule(['&', scope_prefix, C.IDENT],		$ => ({ type: 'member_pointer_const', parts: [...$[1], $[2]] } as unknown as C.Expr)),
	Rule(['&', scope_prefix, C.TYPE_NAME],	$ => ({ type: 'member_pointer_const', parts: [...$[1], $[2]] } as unknown as C.Expr)),
);

const template_argument = Rules<TemplateArg>(
	Rule([C.type_name],				$ => ({ value: $[0] } as const)),
	Rule([C.type_name, '...'],		$ => ({ value: $[0], pack: true } as const)),
	Rule([const_arg],				$ => ({ value: $[0] } as const)),
);
const template_argument_list = List(template_argument, ',');

(C.postfix_expression as unknown as Rules<Expr>).push(
	Rule([template_fn_open, template_argument_list, '>', '(', ')'],										($, ctx) => { ctx.templateDepth--; return { type: 'function_call', function: { type: 'template_ref', name: $[0], args: $[1] } as unknown as C.Expr, arguments: [] } as const; }),
	Rule([template_fn_open, template_argument_list, '>', '(', C.argument_expression_list, ')'],			($, ctx) => { ctx.templateDepth--; return { type: 'function_call', function: { type: 'template_ref', name: $[0], args: $[1] } as unknown as C.Expr, arguments: $[4] } as const; }),
	Rule([member_template_fn_open, template_argument_list, '>', '(', ')'],								($, ctx) => { ctx.templateDepth--; return { type: 'function_call', function: { type: 'member_template_ref', ...$[0], args: $[1] } as unknown as C.Expr, arguments: [] } as const; }),
	Rule([member_template_fn_open, template_argument_list, '>', '(', C.argument_expression_list, ')'],	($, ctx) => { ctx.templateDepth--; return { type: 'function_call', function: { type: 'member_template_ref', ...$[0], args: $[1] } as unknown as C.Expr, arguments: $[4] } as const; }),
	// Template-id as a plain value (`vput(tput<T>)` -- a pointer to a specialization, no call).
	Rule([template_fn_open, template_argument_list, '>'],												($, ctx) => { ctx.templateDepth--; return { type: 'template_ref', name: $[0], args: $[1] } as unknown as C.Expr; }),
	// Static member of a template-id in expression position (`T_same<A, B>::value`).
	Rule([generic_type_open, template_argument_list, '>', '::', C.IDENT],								($, ctx) => { ctx.templateDepth--; return { type: 'qualified', parts: [`${$[0]}<>`, $[4]] } as unknown as C.Expr; }),
);

// `TYPE_NAME '<'` (shift) vs the plain `[TYPE_NAME]` alt on `type_specifier` (reduce) is an ordinary shift/reduce
// choice on the next token, resolved to shift -- the same safe shape used throughout this file.
type_specifier.push(
	Rule([generic_type_open, template_argument_list, '>'],									($, ctx) => { ctx.templateDepth--; return { type: 'generic', name: $[0], args: $[1] } as const; }),
	// `typename T::type` -- the dependent-name escape hatch, safe on type_specifier since it leads with
	// its own keyword.
	Rule(['typename', scope_prefix, type_ident],											$ => ({ type: 'qualified_type', parts: [...$[1], $[2]], dependent: true } as const)),
	// `typename T_if<b, T, F>::type` -- the scope is itself a template-id, beyond scope_prefix's reach.
	Rule(['typename', generic_type_open, template_argument_list, '>', '::', type_ident],	($, ctx) => { ctx.templateDepth--; return { type: 'qualified_type', parts: [`${$[1]}<>`, $[5]], dependent: true } as unknown as QualifiedType; }),
);

// Qualified types (`Foo::Inner x;`) and scoped generics (`std::vector<int>`), as specifier_qualifier_list *starters*
// -- see the scoped_generic_open comment above for why they must not be type_specifier alternatives.
(C.specifier_qualifier_list as unknown as Rules<unknown[]>).push(
	Rule([scope_prefix, C.TYPE_NAME],									$ => [{ type: 'qualified_type', parts: [...$[0], $[1]] }]),
	Rule([scoped_generic_open, template_argument_list, '>'],			($, ctx) => { ctx.templateDepth--; return [{ type: 'generic', name: $[0], args: $[1] }]; }),
);

// ===================================================================
//  Class/struct/union/enum heads
// ===================================================================
// Every head reduces the moment `keyword IDENT` is seen, before '{' is even shifted, so the type's own name is
// already registered by the time its body parses (self-referential `struct Node { Node* next; };`).

const class_head = Rules<string>(
	Rule(['class', C.IDENT],												($, ctx) => { ctx.typedefNames.add($[1]); return $[1]; }),
	Rule(['class', C.TYPE_NAME],											$ => $[1]),
	// Specialization heads (`template<> class Box<int>` / partial `template<class T> class Box<T*>`) -- the generic
	// machinery already tracks templateDepth, and a partial specialization's `T*` is just a type_name with an abstract declarator.
	Rule(['class', generic_type_open, template_argument_list, '>'],			($, ctx) => { ctx.templateDepth--; return $[1]; }),
);

const struct_head = Rules<{ kind: 'struct' | 'union'; name: string }>(
	Rule(['struct', C.IDENT],												($, ctx) => { ctx.typedefNames.add($[1]); return { kind: 'struct', name: $[1] } as const; }),
	Rule(['struct', C.TYPE_NAME],											$ => ({ kind: 'struct', name: $[1] } as const)),
	Rule(['union', C.IDENT],												($, ctx) => { ctx.typedefNames.add($[1]); return { kind: 'union', name: $[1] } as const; }),
	Rule(['union', C.TYPE_NAME],											$ => ({ kind: 'union', name: $[1] } as const)),
	// Specialization heads (`template<> struct ISO_def<int> : ... {}`) -- mirrors class_head's variant,
	// plus an IDENT-rooted form for primary templates known only from unresolved headers.
	Rule(['struct', generic_type_open, template_argument_list, '>'],		($, ctx) => { ctx.templateDepth--; return { kind: 'struct', name: $[1] } as const; }),
	Rule(['struct', base_generic_open, template_argument_list, '>'],		($, ctx) => { ctx.templateDepth--; ctx.typedefNames.add($[1]); return { kind: 'struct', name: $[1] } as const; }),
	// Scoped specializations (`template<> struct SEI::T<SEI::buffering_period> {...}`).
	Rule(['struct', scoped_generic_open, template_argument_list, '>'],		($, ctx) => { ctx.templateDepth--; return { kind: 'struct', name: $[1] } as const; }),
);

// C's own named struct/union rules are *replaced* by head-based ones: the monolithic shape shifts '{' before any
// reduction can run, too late to register the name for uses inside the body.
removeRules(C.struct_or_union_specifier, rhs => (rhs[0] === 'struct' || rhs[0] === 'union') && rhs[1] === C.IDENT);

const base_specifier = Rules<BaseSpecifier>(
	Rule([type_ident],																				$ => ({ name: $[0] } as const)),
	Rule([termOneOf(['public', 'private', 'protected']), type_ident],								$ => ({ access: $[0], name: $[1] } as const)),
	Rule(['virtual', type_ident],																	$ => ({ virtual: true, name: $[1] } as const)),
	Rule(['virtual', termOneOf(['public', 'private', 'protected']), type_ident], 					$ => ({ virtual: true, access: $[1], name: $[2] } as const)),
	// Generic bases (`: public Base<T>`).
	Rule([generic_type_open, template_argument_list, '>'],											($, ctx) => { ctx.templateDepth--; return { name: $[0], args: $[1] } as const; }),
	Rule([termOneOf(['public', 'private', 'protected']), generic_type_open, template_argument_list, '>'],	($, ctx) => { ctx.templateDepth--; return { access: $[0], name: $[1], args: $[2] } as const; }),
	// Generic bases rooted at an *unregistered* name (`: buffered_accum<X, char, 512>`, declared only in
	// an unresolved header). Safe: a base clause holds no expressions, so `IDENT <` can only open args.
	Rule([base_generic_open, template_argument_list, '>'],											($, ctx) => { ctx.templateDepth--; return { name: $[0], args: $[1] } as const; }),
	Rule([termOneOf(['public', 'private', 'protected']), base_generic_open, template_argument_list, '>'],	($, ctx) => { ctx.templateDepth--; return { access: $[0], name: $[1], args: $[2] } as const; }),
	// Qualified bases (`: public Imf::IStream`).
	Rule([scope_prefix, type_ident],																$ => ({ name: [...$[0], $[1]].join('::') } as const)),
	Rule([termOneOf(['public', 'private', 'protected']), scope_prefix, type_ident],					$ => ({ access: $[0], name: [...$[1], $[2]].join('::') } as const)),
	Rule(['virtual', termOneOf(['public', 'private', 'protected']), scope_prefix, type_ident],		$ => ({ virtual: true, access: $[1], name: [...$[2], $[3]].join('::') } as const)),
);
const base_list = List(base_specifier, ',');
const base_clause = Rules<BaseSpecifier[]>(
	Rule([':', base_list], $ => $[1]),
);

// A shared "everything after the name" tail for class/struct/union: [final?] [bases?] { body? }.
// Absent entirely for tag-only references.
interface ClassBody { final?: boolean; bases?: BaseSpecifier[]; body: ClassMember[]; }
const class_body_rules: Rules<ClassBody> = [];
for (const fin of [false, true]) {
	for (const based of [false, true]) {
		const prefix = [...(fin ? ['final'] : []), ...(based ? [base_clause] : [])];
		class_body_rules.push(
			Rule([...prefix, '{', '}'] as any,					($: any[]) => ({ final: fin || undefined, bases: based ? $[fin ? 1 : 0] : undefined, body: [] })),
			Rule([...prefix, '{', C.struct_body, '}'] as any,	($: any[]) => ({ final: fin || undefined, bases: based ? $[fin ? 1 : 0] : undefined, body: $[prefix.length + 1] })),
		);
	}
}
const class_body = Rules<ClassBody>(...class_body_rules);

const struct_or_union_specifier = C.struct_or_union_specifier as unknown as Rules<C.StructSpecifier | ClassSpecifier>;
struct_or_union_specifier.push(
	// class: tag-only, with-body, anonymous.
	Rule([class_head],							$ => ({ type: 'class', name: $[0] } as const)),
	Rule([class_head, class_body],				$ => ({ type: 'class', name: $[0], ...$[1] } as const)),
	Rule(['class', '{', '}'],					_ => ({ type: 'class', body: [] } as const)),
	Rule(['class', '{', C.struct_body, '}'],	$ => ({ type: 'class', body: $[2] } as const)),
	// struct/union: same shapes, now with registration + C++ bodies (bases, members) via the shared tail.
	Rule([struct_head],							$ => ({ type: $[0].kind, name: $[0].name } as const)),
	Rule([struct_head, class_body],				$ => ({ type: $[0].kind, name: $[0].name, ...$[1] } as const)),
);

// ===================================================================
//  Enums: scoped, based, opaque
// ===================================================================

// Same replace-with-eager-head treatment as struct above -- `enum Color {RED}; Color c;` needs Color
// registered before the token after `}` is lexed, which only head-time registration achieves.
removeRules(C.enum_specifier, rhs => rhs[0] === 'enum' && rhs[1] === C.IDENT);

const enum_head = Rules<{ name: string; scoped?: boolean }>(
	Rule(['enum', C.IDENT],										($, ctx) => { ctx.typedefNames.add($[1]); return { name: $[1] } as const; }),
	Rule(['enum', C.TYPE_NAME],									$ => ({ name: $[1] } as const)),
	Rule(['enum', termOneOf(['class', 'struct']), C.IDENT],		($, ctx) => { ctx.typedefNames.add($[2]); return { name: $[2], scoped: true } as const; }),
	Rule(['enum', termOneOf(['class', 'struct']), C.TYPE_NAME],	$ => ({ name: $[2], scoped: true } as const)),
);

const enum_base = Rules<C.TypeSpecifier[]>(
	Rule([':', C.specifier_qualifier_list], $ => $[1] as C.TypeSpecifier[]),
);

(C.enum_specifier as unknown as Rules<CppEnumSpecifier>).push(
	Rule([enum_head],												$ => ({ type: 'enum', ...$[0] } as const)),	// tag reference or opaque declaration
	Rule([enum_head, enum_base],									$ => ({ type: 'enum', ...$[0], base: $[1] } as const)),
	Rule([enum_head, '{', C.enumerator_list, '}'],					$ => ({ type: 'enum', ...$[0], members: $[2] } as const)),
	Rule([enum_head, '{', C.enumerator_list, ',', '}'],				$ => ({ type: 'enum', ...$[0], members: $[2] } as const)),
	Rule([enum_head, enum_base, '{', C.enumerator_list, '}'],		$ => ({ type: 'enum', ...$[0], base: $[1], members: $[3] } as const)),
	Rule([enum_head, enum_base, '{', C.enumerator_list, ',', '}'],	$ => ({ type: 'enum', ...$[0], base: $[1], members: $[3] } as const)),
);

// ===================================================================
//  Class members
// ===================================================================

// A method's name+params, inlined as `IDENT '(' ... ')'` rather than through the shared declarator chain (which
// also completes on a bare IDENT for plain fields) -- keeps '(' next an ordinary shift/reduce choice, not a reduce-reduce tie.
const method_declarator = Rules<{ name: string } & C.ParamList>(
	Rule([C.IDENT, '(', ')'],								$ => ({ name: $[0], params: [] } as const)),
	Rule([C.IDENT, '(', C.parameter_type_list, ')'],		$ => ({ name: $[0], ...$[2] } as const)),
	// Shadowed method names (`size_t size() const`): after the specifiers a TYPE_NAME here can only be
	// the method's name. Inline (not via a shared name nonterminal) -- see the type_ident lesson above.
	Rule([C.TYPE_NAME, '(', ')'],							$ => ({ name: $[0], params: [] } as const)),
	Rule([C.TYPE_NAME, '(', C.parameter_type_list, ')'],	$ => ({ name: $[0], ...$[2] } as const)),
);
const method_signature = Rules<Declarator>(
	Rule([method_declarator],					$ => C.FunctionDecl(Identifier($[0].name), $[0].params, $[0].variadic)),
	Rule([C.pointer, method_declarator],		$ => C.Pointer($[0], { type: 'function', name: Identifier($[1].name), params: $[1].params, variadic: $[1].variadic })),
	// Reference-to-pointer returns (`static T * &head() {...}`).
	Rule([C.pointer, '&', method_declarator],	$ => ({ type: 'reference', to: C.Pointer($[0], { type: 'function', name: Identifier($[2].name), params: $[2].params, variadic: $[2].variadic }) } as unknown as Declarator)),
	Rule(['&', method_declarator],				$ => ({ type: 'reference', to: { type: 'function', name: Identifier($[1].name), params: $[1].params, variadic: $[1].variadic } } as const)),
	Rule(['&&', method_declarator],				$ => ({ type: 'rvalue_reference', to: { type: 'function', name: Identifier($[1].name), params: $[1].params, variadic: $[1].variadic } } as const)),
);

// Everything that can legally follow a member function's `)`: cv/noexcept/virt-specifiers in standard order, ending
// in a body, `;`, `= 0;`, `= default;`, or `= delete;`. Generated as the full cross product -- SLR-safe since each added token is a plain shift.
const method_tail_rules: Rules<MethodTail> = [];
for (const isConst of [false, true]) {
	for (const noex of [false, true, 'throw']) {
		for (const virt of [undefined, 'override', 'final']) {
			const prefix: unknown[] = [...(isConst ? ['const'] : []), ...(noex === 'throw' ? ['throw', '(', ')'] : noex ? ['noexcept'] : []), ...(virt ? [virt] : [])];
			const flags: MethodTail = { isConst: isConst || undefined, noexcept: !!noex || undefined, override: virt === 'override' || undefined, final: virt === 'final' || undefined };
			method_tail_rules.push(
				Rule([...prefix, C.compound_statement] as any,		($: any[]) => ({ ...flags, body: $[$.length - 1] })),
				Rule([...prefix, ';'] as any,						_ => ({ ...flags, declarationOnly: true })),
				Rule([...prefix, '=', C.INT_LITERAL, ';'] as any,	_ => ({ ...flags, pure: true })),
				Rule([...prefix, '=', 'default', ';'] as any,		_ => ({ ...flags, defaulted: true })),
				Rule([...prefix, '=', 'delete', ';'] as any,		_ => ({ ...flags, deleted: true })),
			);
		}
	}
}
const method_tail = Rules<MethodTail>(...method_tail_rules);

const member_initializer = Rules<MemberInitializer>(
	Rule([type_ident, '(', ')'],								$ => ({ name: $[0], arguments: [] } as const)),
	Rule([type_ident, '(', C.argument_expression_list, ')'],	$ => ({ name: $[0], arguments: $[2] } as const)),
);
const member_initializer_list = List(member_initializer, ',');

// How a constructor ends -- member-initializer list + body, plain body, or the `= default`/`= delete`/
// declaration-only forms shared with methods.
const ctor_tail = Rules<CtorTail>(
	Rule([C.compound_statement],								$ => ({ body: $[0] } as const)),
	Rule([':', member_initializer_list, C.compound_statement],	$ => ({ initializerList: $[1], body: $[2] } as const)),
	Rule([';'],													_ => ({ declarationOnly: true } as const)),
	Rule(['=', 'default', ';'],									_ => ({ defaulted: true } as const)),
	Rule(['=', 'delete', ';'],									_ => ({ deleted: true } as const)),
	// Legacy dynamic-exception-spec (`X() throw() : a(0) {}`).
	Rule(['throw', '(', ')', C.compound_statement],				$ => ({ body: $[3] } as const)),
	Rule(['throw', '(', ')', ':', member_initializer_list, C.compound_statement], $ => ({ initializerList: $[4], body: $[5] } as const)),
	Rule(['throw', '(', ')', ';'],								_ => ({ declarationOnly: true } as const)),
);

// Leading member modifiers (`static`, `virtual`, ...) as a real list, not a single termOneOf terminal: a combined
// pattern would tie with the standalone keyword terminals on match length, starving one grammar path entirely.
const member_mods = List(OneOf(MemberMod));

// Operator overloading. The operator-symbol terminal only ever competes in the lexer *after* the
// `operator` keyword (state-driven lexing), so it can't steal `+` etc. from expression states.
const overloadable_op = termOneOf([
	'+', '-', '*', '/', '%', '^', '&', '|', '~', '!', '=', '<', '>',
	'+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=', '<<', '>>', '>>=', '<<=',
	'==', '!=', '<=', '>=', '&&', '||', '++', '--', ',', '->',
]);
const operator_id = Rules<string>(
	Rule(['operator', overloadable_op],		$ => $[1]),
	Rule(['operator', '(', ')'],			_ => '()'),
	Rule(['operator', '[', ']'],			_ => '[]'),
	Rule(['operator', 'new'],				_ => 'new'),
	Rule(['operator', 'delete'],			_ => 'delete'),
	Rule(['operator', 'new', '[', ']'],		_ => 'new[]'),
	Rule(['operator', 'delete', '[', ']'],	_ => 'delete[]'),
);
const operator_declarator = Rules<{ name: string } & C.ParamList>(
	Rule([operator_id, '(', ')'],							$ => ({ name: $[0], params: [] } as const)),
	Rule([operator_id, '(', C.parameter_type_list, ')'],	$ => ({ name: $[0], ...$[2] } as const)),
);
// Pointer/reference-returning operator functions (`V& operator+=(...)`) -- the same leading-decorator
// shapes method_signature has.
const operator_signature = Rules<{ name: string } & C.ParamList>(
	operator_declarator,
	Rule([C.pointer, operator_declarator],	$ => $[1]),
	Rule(['&', operator_declarator],		$ => $[1]),
	Rule(['&&', operator_declarator],		$ => $[1]),
);

// Member type aliases and using-declarations, shared with namespace scope below.
const using_alias_head = Rules<string>(
	// Registered at the `=` -- before the aliased type is even parsed -- for the same
	// next-token-already-lexed reason as every other eager head in this file.
	Rule(['using', C.IDENT, '='],		($, ctx) => { ctx.typedefNames.add($[1]); return $[1]; }),
	Rule(['using', C.TYPE_NAME, '='],	$ => $[1]),
);
const using_alias = Rules<UsingAlias>(
	Rule([using_alias_head, C.type_name, ';'], $ => ({ type: 'using_alias', name: $[0], target: $[1] } as const)),
);

// Fields beyond C's bare-IDENT struct_declarator: pointers, references, arrays, member initializers. Generated as
// shapes rather than the full declarator chain -- one that could derive a *function* declarator would tie with method_declarator.
const field_shapes: Rules<unknown> = [];
for (const lead of [[], [C.pointer], ['&']] as unknown[][]) {
	for (const arr of [false, true]) {
		const decor = (name: string, $: any[]): any => {
			let d: any = { type: 'identifier', name };
			if (arr)
				d = { type: 'array', element: d, size: $[lead.length + 2] };
			if (lead.length)
				d = lead[0] === '&' ? { type: 'reference', to: d } : C.Pointer($[0], d);
			return d;
		};
		// TYPE_NAME as well as IDENT: field names legally shadow registered class names (`char *str;`).
		for (const nameT of [C.IDENT, C.TYPE_NAME]) {
			const shape: unknown[] = [...lead, nameT, ...(arr ? ['[', C.constant_expression, ']'] : [])];
			field_shapes.push(
				Rule([...shape] as any,									($: any[]) => ({ declarator: decor($[lead.length], $) })),
				Rule([...shape, '=', C.assignment_expression] as any,	($: any[]) => ({ declarator: decor($[lead.length], $), initializer: $[$.length - 1] })),
			);
		}
	}
}
// C's own `[IDENT]` alternative is subsumed by the plain shape above (which also carries the NSDMI
// variant); the bitfield alternatives stay.
removeRules(C.struct_declarator, rhs => rhs.length === 1 && rhs[0] === C.IDENT);
(C.struct_declarator as unknown as Rules<unknown>).push(...field_shapes);

// Function-pointer members (`void (*fn)(void*);`, `HAL* (*CreateHAL)(CG*);`). The `( *` can't start a
// method (methods start with a name), so this never competes with method_declarator.
for (const nameT of [C.IDENT, C.TYPE_NAME]) {
	for (const lead of [[], [C.pointer]] as unknown[][]) {
		const n = lead.length;
		(C.struct_declarator as unknown as Rules<unknown>).push(
			Rule([...lead, '(', '*', nameT, ')', '(', ')'] as any,							($: any[]) => ({ declarator: { type: 'function', name: C.Pointer([1], Identifier($[n + 2])), params: [], returnPointer: n ? $[0] : undefined } })),
			Rule([...lead, '(', '*', nameT, ')', '(', C.parameter_type_list, ')'] as any,	($: any[]) => ({ declarator: { type: 'function', name: C.Pointer([1], Identifier($[n + 2])), ...$[n + 5], returnPointer: n ? $[0] : undefined } })),
		);
	}
}

// `struct_declaration` is C's "one member declaration" production -- widening it here is what lets class
// bodies mix plain fields (already handled by c-parser.ts's own rule) with everything else.

// Member typedefs (`typedef T type;`) -- after `typedef` there's no method ambiguity, so the general
// struct_declarator_list is safe here; every declared name registers as a type.
const declNames = (d: unknown): string[] => {
	if (typeof d !== 'object' || d === null)
		return [];
	const o = d as Record<string, unknown>;
	return o.type === 'identifier' ? [o.name as string] : Object.values(o).flatMap(declNames);
};
struct_declaration.push(
	Rule(['typedef', C.specifier_qualifier_list, C.struct_declarator_list, ';'],	($, ctx) => {
		for (const name of declNames($[2]))
			ctx.typedefNames.add(name);
		return { type: 'member_typedef', specifiers: $[1], declarators: $[2] } as unknown as ClassMember;
	}),
);

// Fn-ptr members with a single TYPE_NAME return (`Blob (*vopen)(...)`) -- spelled inline because the in-class ctor's
// own `TYPE_NAME (` shift otherwise beats the spec_qual reduce the struct_declarator shapes depend on.
for (const nameT of [C.IDENT, C.TYPE_NAME]) {
	struct_declaration.push(
		Rule([C.TYPE_NAME, '(', '*', nameT, ')', '(', ')', ';'] as any,							($: any[]) => StructMember([C.RefType($[0])], [{ declarator: C.FunctionDecl(C.Pointer([1], Identifier($[3])), []) }])),
		Rule([C.TYPE_NAME, '(', '*', nameT, ')', '(', C.parameter_type_list, ')', ';'] as any,	($: any[]) => StructMember([C.RefType($[0])], [{ declarator: C.FunctionDecl(C.Pointer([1], Identifier($[3])), $[6].params, $[6].variadic) }])),
	);
}
struct_declaration.push(
	Rule([termOneOf(['public', 'private', 'protected']), ':'],	$ => ({ type: 'access_label', access: $[0] } as const)),

	// Methods: plain and modifier-prefixed. All the const/noexcept/override/final/=default/... variation
	// lives in method_tail.
	Rule([C.specifier_qualifier_list, method_signature, method_tail],					$ => ({ type: 'method', specifiers: $[0], declarator: $[1] as C.Declarator, ...$[2] } as const)),
	Rule([member_mods, C.specifier_qualifier_list, method_signature, method_tail],		$ => ({ type: 'method', specifiers: $[1], declarator: $[2] as C.Declarator, ...$[3], modifiers: $[0] } as const)),

	// Operators and conversion operators.
	Rule([C.specifier_qualifier_list, operator_signature, method_tail],					$ => ({ type: 'method', specifiers: $[0], declarator: { type: 'function', name: Identifier('operator' + $[1].name), params: $[1].params, variadic: $[1].variadic }, ...$[2] } as const)),
	Rule([member_mods, C.specifier_qualifier_list, operator_signature, method_tail],	$ => ({ type: 'method', specifiers: $[1], declarator: { type: 'function', name: Identifier('operator' + $[2].name), params: $[2].params, variadic: $[2].variadic }, ...$[3], modifiers: $[0] } as const)),
	Rule(['operator', C.specifier_qualifier_list, '(', ')', method_tail],				$ => ({ type: 'conversion', target: { specifiers: $[1] }, ...$[4] } as const)),
	Rule(['operator', C.specifier_qualifier_list, C.pointer, '(', ')', method_tail],	$ => ({ type: 'conversion', target: { specifiers: $[1], declarator: C.Pointer($[2], undefined) }, ...$[5] } as const)),

	// Constructors: name spelled as raw TYPE_NAME, not type_ident, so name-then-'(' stays an ordinary shift/reduce
	// choice. Through type_ident it becomes a reduce-reduce tie with type_specifier that silently flipped with rule order (`Foo f;` broke).
	Rule([C.TYPE_NAME, '(', ')', ctor_tail],											$ => ({ type: 'constructor', name: $[0], params: [], ...$[3] } as const)),
	Rule([C.TYPE_NAME, '(', C.parameter_type_list, ')', ctor_tail],						$ => ({ type: 'constructor', name: $[0], ...$[2], ...$[4] } as const)),
	Rule([member_mods, C.TYPE_NAME, '(', ')', ctor_tail],								$ => ({ type: 'constructor', name: $[1], params: [], ...$[4], modifiers: $[0] } as const)),
	Rule([member_mods, C.TYPE_NAME, '(', C.parameter_type_list, ')', ctor_tail],		$ => ({ type: 'constructor', name: $[1], ...$[3], ...$[5], modifiers: $[0] } as const)),

	// Destructors (method_tail permissively allows a few things a destructor can't really have -- `const`
	// -- which is fine for a parser that doesn't validate).
	Rule(['~', type_ident, '(', ')', method_tail],										$ => ({ type: 'destructor', name: $[1], ...$[4] } as const)),
	Rule(['virtual', '~', type_ident, '(', ')', method_tail],							$ => ({ type: 'destructor', name: $[2], ...$[5], modifiers: ['virtual'] } as const)),

	// Modifier-prefixed data members (`static const int x = 5;`, `mutable int cache;`); initializers come
	// via the widened struct_declarator shapes.
	Rule([member_mods, C.specifier_qualifier_list, C.struct_declarator_list, ';'],		$ => StructMember($[1], $[2], $[0])),
	// `friend class Foo;` and similar -- a specifier with no declarators at all.
	Rule([member_mods, C.specifier_qualifier_list, ';'],								$ => StructMember($[1], [], $[0])),
	// Nested type definitions as members (`class Inner {...};`, `enum class E {...};`) -- also a
	// declarator-less specifier, just without a leading modifier.
	Rule([C.specifier_qualifier_list, ';'],												$ => StructMember($[0], [])),

	Rule(['using', using_path, ';'],													$ => ({ type: 'using_decl', scope: $[1].slice(0, -1), name: $[1][$[1].length - 1] } as const)),
	using_alias,
);

// ===================================================================
//  Namespaces / using / linkage
// ===================================================================

const external_definition = C.external_definition as unknown as Rules<Definition>;

// Registering the namespace name is what turns `math::square(2)` (or `std::vector`, if `std` is seeded)
// into TYPE_SCOPE-rooted qualified names.
const namespace_head = Rules<string>(
	Rule(['namespace', C.IDENT],		($, ctx) => { ctx.typedefNames.add($[1]); return $[1]; }),
	Rule(['namespace', C.TYPE_NAME],	$ => $[1]),
);

const namespace_body = List(external_definition);
const namespace_decl = Rules<NamespaceDecl>(
	Rule([namespace_head, '{', '}'],							$ => ({ type: 'namespace', name: $[0], body: [] } as const)),
	Rule([namespace_head, '{', namespace_body, '}'],			$ => ({ type: 'namespace', name: $[0], body: $[2] } as const)),
	Rule(['namespace', '{', '}'],								_ => ({ type: 'namespace', body: [] } as const)),
	Rule(['namespace', '{', namespace_body, '}'],				$ => ({ type: 'namespace', body: $[2] } as const)),
	Rule(['inline', namespace_head, '{', namespace_body, '}'],	$ => ({ type: 'namespace', name: $[1], inline: true, body: $[3] } as const)),
	Rule(['inline', namespace_head, '{', '}'],					$ => ({ type: 'namespace', name: $[1], inline: true, body: [] } as const)),
);

const using_directive = Rules<UsingDirective>(
	Rule(['using', 'namespace', using_path, ';'], $ => ({ type: 'using_namespace', name: $[2].join('::') } as const)),
);
const using_decl_top = Rules<UsingDeclMember>(
	Rule(['using', using_path, ';'], $ => ({ type: 'using_decl', scope: $[1].slice(0, -1), name: $[1][$[1].length - 1] } as const)),
);

// `extern "C"` -- the STRING_LITERAL lookahead is what keeps this from ever competing with plain
// `extern` as a storage class (a string can't start a specifier list).
const linkage_spec = Rules<LinkageSpec>(
	Rule(['extern', C.STRING_LITERAL, '{', namespace_body, '}'],	$ => ({ type: 'linkage', language: $[1], body: $[3] } as const)),
	Rule(['extern', C.STRING_LITERAL, '{', '}'],					$ => ({ type: 'linkage', language: $[1], body: [] } as const)),
	Rule(['extern', C.STRING_LITERAL, C.external_definition],		$ => ({ type: 'linkage', language: $[1], body: [$[2]] } as const)),
);

external_definition.push(
	namespace_decl,
	using_directive,
	using_decl_top,
	using_alias,
	linkage_spec,
	static_assert_decl,
);

// ===================================================================
//  Out-of-class member definitions
// ===================================================================
// `T Foo::method() {...}` works only via TYPE_SCOPE: `Foo` lexes as TYPE_SCOPE so it can't be absorbed as a second
// type specifier. The ctor form needs no return type -- `Foo::Foo(` has TYPE_NAME after `::`, a method name is plain IDENT.

// A shared nonterminal (rather than pushing each rule straight into external_definition) so templates
// can prefix these too (`template<int A> void ChaCha20::round(...) {...}`).
const out_of_class_def = Rules<Definition>(
	Rule([C.declaration_specifiers, scope_prefix, C.IDENT, '(', ')', method_tail],							$ => ({ type: 'method_def', specifiers: $[0], scope: $[1], name: $[2], params: [], tail: $[5] } as const)),
	Rule([C.declaration_specifiers, scope_prefix, C.IDENT, '(', C.parameter_type_list, ')', method_tail],	$ => ({ type: 'method_def', specifiers: $[0], scope: $[1], name: $[2], ...$[4], tail: $[6] } as const)),
	Rule([scope_prefix, C.TYPE_NAME, '(', ')', ctor_tail],													$ => ({ type: 'constructor_def', scope: $[0], name: $[1], params: [], tail: $[4] } as const)),
	Rule([scope_prefix, C.TYPE_NAME, '(', C.parameter_type_list, ')', ctor_tail],							$ => ({ type: 'constructor_def', scope: $[0], name: $[1], ...$[3], tail: $[5] } as const)),
	// IDENT variants: the class was never registered (declared only in an unresolved header), so the
	// name after `::` can't lex as TYPE_NAME. `Foo::Foo(` is still unambiguously a ctor at this scope.
	Rule([scope_prefix, C.IDENT, '(', ')', ctor_tail],														$ => ({ type: 'constructor_def', scope: $[0], name: $[1], params: [], tail: $[4] } as const)),
	Rule([scope_prefix, C.IDENT, '(', C.parameter_type_list, ')', ctor_tail],								$ => ({ type: 'constructor_def', scope: $[0], name: $[1], ...$[3], tail: $[5] } as const)),
	Rule([scope_prefix, '~', type_ident, '(', ')', method_tail],											$ => ({ type: 'destructor_def', scope: $[0], name: $[2], tail: $[5] } as const)),
	Rule([C.declaration_specifiers, scope_prefix, operator_signature, method_tail],							$ => ({ type: 'operator_def', specifiers: $[0], scope: $[1], operator: $[2].name, params: $[2].params, variadic: $[2].variadic, tail: $[3] } as const)),
	// Free (non-member) operator functions.
	Rule([C.declaration_specifiers, operator_signature, method_tail],										$ => ({ type: 'operator_def', specifiers: $[0], operator: $[1].name, params: $[1].params, variadic: $[1].variadic, tail: $[2] } as const)),
	// Out-of-class static data member definitions (`int C::count = 0;`).
	Rule([C.declaration_specifiers, scope_prefix, C.IDENT, '=', C.assignment_expression, ';'],				$ => ({ type: 'static_member_def', specifiers: $[0], scope: $[1], name: $[2], initializer: $[4] } as const)),
	Rule([C.declaration_specifiers, scope_prefix, C.IDENT, ';'],											$ => ({ type: 'static_member_def', specifiers: $[0], scope: $[1], name: $[2] } as const)),
	// Pointer return/member types (`void **C::f() {...}`, `Scope *Scope::list = 0;`) -- the pointer can't
	// live in declaration_specifiers, so it needs its own slot before the qualifier.
	Rule([C.declaration_specifiers, C.pointer, scope_prefix, C.IDENT, '(', ')', method_tail],				$ => ({ type: 'method_def', specifiers: $[0], pointer: $[1], scope: $[2], name: $[3], params: [], tail: $[6] } as const)),
	Rule([C.declaration_specifiers, C.pointer, scope_prefix, C.IDENT, '(', C.parameter_type_list, ')', method_tail],	$ => ({ type: 'method_def', specifiers: $[0], pointer: $[1], scope: $[2], name: $[3], ...$[5], tail: $[7] } as const)),
	Rule([C.declaration_specifiers, C.pointer, scope_prefix, C.IDENT, '=', C.assignment_expression, ';'],	$ => ({ type: 'static_member_def', specifiers: $[0], pointer: $[1], scope: $[2], name: $[3], initializer: $[5] } as const)),
	Rule([C.declaration_specifiers, C.pointer, scope_prefix, C.IDENT, ';'],									$ => ({ type: 'static_member_def', specifiers: $[0], pointer: $[1], scope: $[2], name: $[3] } as const)),
	Rule([C.declaration_specifiers, C.pointer, scope_prefix, operator_signature, method_tail],				$ => ({ type: 'operator_def', specifiers: $[0], scope: $[2], operator: $[3].name, params: $[3].params, variadic: $[3].variadic, tail: $[4] } as const)),
	// Reference returns (`float& C::f() {...}`) -- mirrors the pointer variants above.
	Rule([C.declaration_specifiers, '&', scope_prefix, C.IDENT, '(', ')', method_tail],						$ => ({ type: 'method_def', specifiers: $[0], reference: true, scope: $[2], name: $[3], params: [], tail: $[6] } as unknown as OutOfClassMethod)),
	Rule([C.declaration_specifiers, '&', scope_prefix, C.IDENT, '(', C.parameter_type_list, ')', method_tail], $ => ({ type: 'method_def', specifiers: $[0], reference: true, scope: $[2], name: $[3], ...$[5], tail: $[7] } as unknown as OutOfClassMethod)),
	// Explicit specializations of member templates (`template<> inline float& C::as<float>() {...}`) --
	// the name lexes as TEMPLATE_FN (followed by `<...>(`), so reuse template_fn_open's depth machinery.
	Rule([C.declaration_specifiers, scope_prefix, template_fn_open, template_argument_list, '>', '(', ')', method_tail],								($, ctx) => { ctx.templateDepth--; return { type: 'method_def', specifiers: $[0], scope: $[1], name: $[2], nameArgs: $[3], params: [], tail: $[7] } as unknown as OutOfClassMethod; }),
	Rule([C.declaration_specifiers, scope_prefix, template_fn_open, template_argument_list, '>', '(', C.parameter_type_list, ')', method_tail],			($, ctx) => { ctx.templateDepth--; return { type: 'method_def', specifiers: $[0], scope: $[1], name: $[2], nameArgs: $[3], ...$[6], tail: $[8] } as unknown as OutOfClassMethod; }),
	Rule([C.declaration_specifiers, '&', scope_prefix, template_fn_open, template_argument_list, '>', '(', ')', method_tail],							($, ctx) => { ctx.templateDepth--; return { type: 'method_def', specifiers: $[0], reference: true, scope: $[2], name: $[3], nameArgs: $[4], params: [], tail: $[8] } as unknown as OutOfClassMethod; }),
	Rule([C.declaration_specifiers, '&', scope_prefix, template_fn_open, template_argument_list, '>', '(', C.parameter_type_list, ')', method_tail],	($, ctx) => { ctx.templateDepth--; return { type: 'method_def', specifiers: $[0], reference: true, scope: $[2], name: $[3], nameArgs: $[4], ...$[7], tail: $[9] } as unknown as OutOfClassMethod; }),
	// Ctor-style static member init (`const C_type C_types::dummy(C_type::UNKNOWN);`).
	Rule([C.declaration_specifiers, scope_prefix, C.IDENT, '(', C.argument_expression_list, ')', ';'],			$ => ({ type: 'static_member_def', specifiers: $[0], scope: $[1], name: $[2], ctorArgs: $[4] } as const)),
	// Shadowed method names (`bool HashTable::Match(...)` with `Match` also registered as a type).
	Rule([C.declaration_specifiers, scope_prefix, C.TYPE_NAME, '(', ')', method_tail],							$ => ({ type: 'method_def', specifiers: $[0], scope: $[1], name: $[2], params: [], tail: $[5] } as const)),
	Rule([C.declaration_specifiers, scope_prefix, C.TYPE_NAME, '(', C.parameter_type_list, ')', method_tail],	$ => ({ type: 'method_def', specifiers: $[0], scope: $[1], name: $[2], ...$[4], tail: $[6] } as const)),
	Rule([C.declaration_specifiers, C.pointer, scope_prefix, C.TYPE_NAME, '(', ')', method_tail],				$ => ({ type: 'method_def', specifiers: $[0], pointer: $[1], scope: $[2], name: $[3], params: [], tail: $[6] } as const)),
	Rule([C.declaration_specifiers, C.pointer, scope_prefix, C.TYPE_NAME, '(', C.parameter_type_list, ')', method_tail], $ => ({ type: 'method_def', specifiers: $[0], pointer: $[1], scope: $[2], name: $[3], ...$[5], tail: $[7] } as const)),
);
external_definition.push(
	out_of_class_def,
	// Unknown-type globals (`lheap *instance;`): storage classes spelled directly, not via declaration_specifiers --
	// the general form never gets IDENT into the post-specifier state's lookahead (an LALR merged-state gap).
	Rule([unknown_type_field], $ => $[0] as unknown as Definition),
	Rule([C.storage_class_specifier, unknown_type_field],										$ => ({ ...($[1] as object), specifiers: [$[0]] }) as unknown as Definition),
	Rule([C.storage_class_specifier, C.storage_class_specifier, unknown_type_field],			$ => ({ ...($[2] as object), specifiers: [$[0], $[1]] }) as unknown as Definition),
);

// Trailing return types on ordinary functions (`auto f(int) -> int {...}`). The `->` can only be this rule here: nothing else follows a completed declarator with `->`.
(C.function_definition as unknown as Rules<unknown>).push(
	Rule([C.declaration_specifiers, C.declarator, '->', C.type_name, C.compound_statement],		$ => ({ type: 'function_def', specifiers: $[0], declarator: $[1], returnType: $[3], body: $[4] } as const)),
);

// ===================================================================
//  Templates
// ===================================================================

// Registering each parameter as a type name the moment it's parsed (not scoped) is what lets `T` be used as an
// ordinary type inside the templated body. TYPE_NAME alternatives cover a name reused across two templates.
const builtin_type_list = List(Rules<string>(Rule([termOneOf(C.BUILTIN_TYPE)], $ => $[0])));
const nontype_param_type = Rules<C.DeclarationSpecifiers>(
	Rule([builtin_type_list],	$ => $[0].map(name => C.RefType(name))),
	Rule([CPP_SIMPLE_TYPE],		$ => [C.RefType($[0])]),
	Rule([C.TYPE_NAME],			$ => [C.RefType($[0])]),
);

const template_param = Rules<TemplateParam>(
	Rule(['typename', C.IDENT],							($, ctx) => { ctx.typedefNames.add($[1]); return { name: $[1] }; }),
	Rule(['class', C.IDENT],							($, ctx) => { ctx.typedefNames.add($[1]); return { name: $[1] }; }),
	Rule(['typename', C.TYPE_NAME],						$ => ({ name: $[1] } as const)),
	Rule(['class', C.TYPE_NAME],						$ => ({ name: $[1] } as const)),
	// Template parameter packs (`typename... Ts` / `class... Ts`) -- the declaration-side counterpart of
	// `Args... args` function parameter packs, and what lets `Tuple<Args...>` be written as a type argument.
	Rule(['typename', '...', C.IDENT],					($, ctx) => { ctx.typedefNames.add($[2]); return { name: $[2], pack: true }; }),
	Rule(['class', '...', C.IDENT],						($, ctx) => { ctx.typedefNames.add($[2]); return { name: $[2], pack: true }; }),
	Rule(['typename', '...', C.TYPE_NAME],				$ => ({ name: $[2], pack: true } as const)),
	Rule(['class', '...', C.TYPE_NAME],					$ => ({ name: $[2], pack: true } as const)),
	// Default type arguments (`template<class T = int>`).
	Rule(['typename', C.IDENT, '=', C.type_name],		($, ctx) => { ctx.typedefNames.add($[1]); return { name: $[1], default: $[3] }; }),
	Rule(['class', C.IDENT, '=', C.type_name],			($, ctx) => { ctx.typedefNames.add($[1]); return { name: $[1], default: $[3] }; }),
	Rule(['typename', C.TYPE_NAME, '=', C.type_name],	$ => ({ name: $[1], default: $[3] } as const)),
	Rule(['class', C.TYPE_NAME, '=', C.type_name],		$ => ({ name: $[1], default: $[3] } as const)),
	// Non-type params (`template<int N>`): the name is a value, not registered as a type. Uses a restricted
	// nontype_param_type, not full specifier_qualifier_list -- pulling that in ties with `class T` params (reduce-reduce on `>`/`,`).
	Rule([nontype_param_type, C.IDENT],					$ => ({ name: $[1], nonType: $[0] } as const)),
	Rule([nontype_param_type, C.IDENT, '=', C.assignment_expression],	$ => ({ name: $[1], nonType: $[0], default: $[3] } as const)),
	// TYPE_NAME variants: non-type parameter names can collide with registered names (`template<int B>`).
	Rule([nontype_param_type, C.TYPE_NAME],				$ => ({ name: $[1], nonType: $[0] } as const)),
	Rule([nontype_param_type, C.TYPE_NAME, '=', C.assignment_expression],	$ => ({ name: $[1], nonType: $[0], default: $[3] } as const)),
	// Unnamed non-type parameters (`template<typename T, T> struct T_checktype;`).
	Rule([nontype_param_type],							$ => ({ name: '', nonType: $[0] } as const)),
);
const template_param_list = List(template_param, ',');

// `template <...>` heads, shared by every templated form. The empty variant is explicit specialization.
const template_head = Rules<TemplateParam[]>(
	Rule(['template', '<', template_param_list, '>'],	$ => $[2]),
	Rule(['template', '<', '>'],						_ => []),
);

external_definition.push(
	Rule([template_head, C.struct_or_union_specifier, ';'],		$ => ({ type: 'template', params: $[0], declaration: $[1] as unknown as ClassSpecifier } as const)),
	Rule([template_head, C.function_definition],				$ => ({ type: 'template', params: $[0], declaration: $[1] as unknown as C.Definition } as const)),
	// C++14 variable templates (`template<class T> constexpr T pi = T(3.14159);`) -- and, since
	// `declaration` is general, templated typedefs and function *declarations* too.
	Rule([template_head, C.declaration],						$ => ({ type: 'template', params: $[0], declaration: $[1] as C.Definition } as const)),
	// Alias templates (`template<class T> using Vec = vector<T>;`).
	Rule([template_head, using_alias],							$ => ({ type: 'template', params: $[0], declaration: $[1] } as unknown as TemplateDecl)),
	// Templated out-of-class member definitions (`template<int A> void ChaCha20::round(...) {...}`).
	Rule([template_head, out_of_class_def],						$ => ({ type: 'template', params: $[0], declaration: $[1] as C.Definition } as const)),
);

// Member templates (`template<class U> void set(U x) {...}` inside a class body).
struct_declaration.push(
	Rule([template_head, C.specifier_qualifier_list, method_signature, method_tail],				$ => ({ type: 'member_template', params: $[0], declaration: { type: 'method', specifiers: $[1], declarator: $[2] as C.Declarator, ...$[3] } } as const)),
	// With leading modifiers (`template<typename T> static void tput(...) {...}`).
	Rule([template_head, member_mods, C.specifier_qualifier_list, method_signature, method_tail],	$ => ({ type: 'member_template', params: $[0], declaration: { type: 'method', specifiers: $[2], declarator: $[3] as C.Declarator, modifiers: $[1], ...$[4] } } as unknown as MemberTemplate)),
	// Templated conversion operators (`template<typename T> operator T*() const {...}`).
	Rule([template_head, 'operator', C.specifier_qualifier_list, '(', ')', method_tail],			$ => ({ type: 'member_template', params: $[0], declaration: { type: 'conversion', target: { specifiers: $[2] }, ...$[5] } } as unknown as MemberTemplate)),
	Rule([template_head, 'operator', C.specifier_qualifier_list, C.pointer, '(', ')', method_tail],	$ => ({ type: 'member_template', params: $[0], declaration: { type: 'conversion', target: { specifiers: $[2], declarator: C.Pointer($[3], undefined) }, ...$[6] } } as unknown as MemberTemplate)),
	// Templated in-class constructors (`template<typename T> Outputter(T *t) : vput(tput<T>) {}`).
	Rule([template_head, C.TYPE_NAME, '(', ')', ctor_tail],											$ => ({ type: 'member_template', params: $[0], declaration: { type: 'constructor', name: $[1], params: [], ...$[4] } } as unknown as MemberTemplate)),
	Rule([template_head, C.TYPE_NAME, '(', C.parameter_type_list, ')', ctor_tail],					$ => ({ type: 'member_template', params: $[0], declaration: { type: 'constructor', name: $[1], ...$[3], ...$[5] } } as unknown as MemberTemplate)),
);

// ===================================================================
//  Statements: try/catch/throw, range-for, braced init, using
// ===================================================================

const catch_clause = Rules<CatchClause>(
	Rule(['catch', '(', C.specifier_qualifier_list, C.IDENT, ')', C.compound_statement],			$ => ({ paramType: { specifiers: $[2] }, paramName: $[3], body: $[5] } as const)),
	Rule(['catch', '(', C.specifier_qualifier_list, '&', C.IDENT, ')', C.compound_statement],		$ => ({ paramType: { specifiers: $[2] }, paramName: $[4], byRef: true, body: $[6] } as const)),
	Rule(['catch', '(', C.specifier_qualifier_list, '&&', C.IDENT, ')', C.compound_statement],		$ => ({ paramType: { specifiers: $[2] }, paramName: $[4], byRef: true, body: $[6] } as const)),
	Rule(['catch', '(', C.specifier_qualifier_list, ')', C.compound_statement],						$ => ({ paramType: { specifiers: $[2] }, body: $[4] } as const)),
	Rule(['catch', '(', C.specifier_qualifier_list, '&', ')', C.compound_statement],				$ => ({ paramType: { specifiers: $[2] }, byRef: true, body: $[5] } as const)),
	Rule(['catch', '(', '...', ')', C.compound_statement],											$ => ({ body: $[4] } as const)),
);
const catch_clause_list = List(catch_clause);

const try_statement = Rules<Statement>(
	Rule(['try', C.compound_statement, catch_clause_list], $ => ({ type: 'try', body: $[1], handlers: $[2] } as const)),
);
const throw_statement = Rules<Statement>(
	Rule(['throw', C.expression, ';'],	$ => ({ type: 'throw', argument: $[1] } as const)),
	Rule(['throw', ';'],				_ => ({ type: 'throw' } as const)),
);

const statement = C.statement as unknown as Rules<Statement>;
statement.push(
	try_statement,
	throw_statement,
	using_directive,
	using_decl_top,
	using_alias,
	static_assert_decl,
	// Range-based for. The `:` never competes with the classic for-clauses: after the declarator, a
	// classic for's declaration is looking for `=`/`,`/`;`, none of which is `:`.
	Rule(['for', '(', C.declaration_specifiers, C.declarator, ':', C.expression, ')', C.statement],		$ => ({ type: 'range_for', specifiers: $[2], declarator: $[3], range: $[5], body: $[7] })),
	// `return {...};` list-initialized returns.
	Rule(['return', '{', C.initializer_list, '}', ';'],													$ => ({ type: 'return', expression: { type: 'initializer_list', elements: $[2] } as unknown as C.Expr } as const)),
	// Condition declarations (`if (int exp = f())`, `while (int c = next())`).
	Rule(['if', '(', C.declaration_specifiers, C.declarator, '=', C.assignment_expression, ')', C.statement],						$ => ({ type: 'if', condition: { type: 'decl_condition', specifiers: $[2], declarator: $[3], initializer: $[5] } as unknown as C.Expr, then: $[7] } as const)),
	Rule(['if', '(', C.declaration_specifiers, C.declarator, '=', C.assignment_expression, ')', C.statement, 'else', C.statement],	$ => ({ type: 'if', condition: { type: 'decl_condition', specifiers: $[2], declarator: $[3], initializer: $[5] } as unknown as C.Expr, then: $[7], else: $[9] } as const)),
	Rule(['while', '(', C.declaration_specifiers, C.declarator, '=', C.assignment_expression, ')', C.statement],					$ => ({ type: 'while', condition: { type: 'decl_condition', specifiers: $[2], declarator: $[3], initializer: $[5] } as unknown as C.Expr, body: $[7] } as const)),
);

// Braced direct-init (`T x{1, 2};`) -- non-empty lists only: an empty `{}` would tie with an empty function *body*
// against C's compound_statement (`int f() {}` must keep parsing as a function definition).
C.init_declarator.push(
	Rule([C.declarator, '{', C.initializer_list, '}'],		$ => ({ declarator: $[0], initializer: { type: 'initializer_list', elements: $[2] } as const })),
);

// ===================================================================
//  Wire it up
// ===================================================================
// `>>`/`>>=` need a context-sensitive lexer hook: when templateDepth > 0, reject the multi-char match so `>` closes
// one generic level at a time. Named exactly `>>`/`>>=` so c-parser.ts's bare-string rule references resolve to these objects.
const RIGHT_SHIFT			= terminal('>>',  />>/,		(_, ctx: CppCtx) => ctx.templateDepth > 0 ? undefined : RIGHT_SHIFT);
const RIGHT_SHIFT_ASSIGN	= terminal('>>=', />>=/,	(_, ctx: CppCtx) => ctx.templateDepth > 0 ? undefined : RIGHT_SHIFT_ASSIGN);

export const parser = makeParser({
	// On top of C's skips: attributes (`[[nodiscard]]`), `alignas(...)`, and MS calling-convention attributes are
	// recognized and discarded at the lexer level -- valid input parses but they leave no trace in the AST.
	skip: [/\s+/, /\/\/[^\n]*/, /\/\*[^]*?\*\//, /\[\[[^]*?\]\]/, /alignas\s*\([^()]*\)/, /__(?:stdcall|cdecl|fastcall|thiscall|forceinline)(?!\w)/, /__declspec\s*\([^()]*\)/],
	// IDENT must be lexed even where only TYPE_NAME/TYPE_SCOPE are valid (see c-parser.ts's `terminals: [IDENT]`) --
	// it's the only terminal whose pattern matches the text, and its callback reclassifies registered names.
	terminals: [C.IDENT, TYPE_SCOPE, TEMPLATE_FN, RIGHT_SHIFT, RIGHT_SHIFT_ASSIGN],
	precedence: C.PREC,
	start: C.translation_unit,
	rules: { translation_unit: C.translation_unit },
	// each GLR branch mutates its own ctx (typedef registration, templateDepth); a dying branch's
	// mutations no longer leak into the survivor
	forkCtx: (ctx: CppCtx) => ({...ctx, typedefNames: new Set(ctx.typedefNames)}),
});

export interface Options extends PreprocessOptions {
	knownTypes?: Iterable<string>;
}

export const parse = async (code: string, options?: Options) => parser.parse(await preprocess(code, options), {
	pendingTypedef: false,
	typedefNames: new Set<string>(options?.knownTypes),
	templateDepth: 0,
});
