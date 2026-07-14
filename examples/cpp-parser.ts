import {
	Rule, Rules, RRules, List, termOneOf, makeParser, terminal, WithPrec
} from '../src/tison';
import {
	IDENT, TYPE_NAME, INT_LITERAL, STRING_LITERAL,
	PREC,
	type Ctx,
	type Expr, type Statement, type Declarator, type DeclarationSpecifiers,
	type TypeSpecifier, type TypeName, type StructMember, type StructSpecifier, type ParamOrVariadic,
	type Definition, type Block, type Pointer, type Initializer,
	specifier_qualifier_list, type_specifier, type_qualifier, struct_or_union_specifier, struct_declaration, struct_declarator, struct_declarator_list, struct_body,
	declarator, direct_declarator, pointer, parameter_declaration, parameter_type_list, type_name, abstract_declarator,
	declaration_specifiers, storage_class_specifier, declaration, enum_specifier, enumerator_list, init_declarator, initializer_list, for_statement,
	primary_expression, postfix_expression, assignment_expression, expression, argument_expression_list, constant_expression,
	BUILTIN_TYPE,
	statement, compound_statement, external_definition, function_definition, translation_unit,
} from './c-parser';

// ===================================================================
//  C++14 Parser -- an extension of c-parser
// ===================================================================
//
// Extends the plain-C grammar in c-parser.ts toward full C++14 (to the
// extent an SLR(1)+lexer-hack architecture allows). Coverage on top of C:
//
//   Types & declarations:
//     - `class`/`struct`/`union` with access specifiers, single/multiple
//       inheritance (with per-base `virtual`/access), `final` on the class
//       head; struct/union/enum/class names all auto-register as usable
//       bare type names (C++ semantics), eagerly enough for self-reference
//       inside their own bodies.
//     - references (`T&`), rvalue references (`T&&`), in named, abstract,
//       and parameter declarators; unnamed (abstract) parameters.
//     - C++11 `auto` as a real placeholder type (the legacy C storage-class
//       reading is removed from this grammar): `auto x = ...`, `auto& r`,
//       generic lambdas (`[](auto x){}`), return-type deduction
//       (`auto f() {...}`), trailing return types (`auto f() -> T {...}`).
//     - `decltype(expr)` / `decltype(auto)`, `bool`, `wchar_t`,
//       `char16_t`, `char32_t`.
//     - scoped enums (`enum class`/`enum struct`), enum-base clauses
//       (`enum E : unsigned {...}`), opaque enum declarations.
//     - `constexpr`/`inline`/`thread_local` declaration specifiers (and
//       stacking two storage-class-like specifiers, e.g. `static constexpr`).
//     - `using` alias declarations (`using X = T;`, registered as a type
//       name eagerly) incl. alias templates; `using` declarations and
//       directives at namespace, class, and statement scope.
//     - namespaces (named/anonymous/`inline`), `extern "C"` (single decl
//       and block forms), `static_assert`.
//     - member arrays / pointer / reference members, non-static data member
//       initializers (`int x = 5;`), bitfields (from C).
//
//   Classes:
//     - inline member functions with `const`/`noexcept`/`override`/`final`
//       qualifiers in any standard order, pure-virtual (`= 0`),
//       `= default`, `= delete`, and bodyless declarations (`void f();`).
//     - constructors (member-init lists, delegating ctors, `explicit`,
//       `= default`/`= delete`/declaration-only), destructors (incl.
//       `virtual`), `static`/`virtual`/`mutable`/`friend`/`inline`/
//       `constexpr` member modifiers (as a modifier list, so
//       `static constexpr` etc. compose).
//     - out-of-class member definitions: `T Foo::method() const {...}`,
//       `Foo::Foo(...) : x(1) {...}`, `Foo::~Foo() {...}`, operators.
//     - operator overloading: member, free, and out-of-class operator
//       functions for all standard binary/unary/assignment operators plus
//       `()`, `[]`, `->`; conversion operators (`operator bool() const`).
//     - member type aliases (`using X = T;`) and member templates.
//
//   Expressions:
//     - `this`/`true`/`false`/`nullptr`, `new`/`delete` (incl. `new T[n]`,
//       `new T(...)`, `new T{...}`), lambdas (captures with defaults,
//       init-captures, `mutable`, trailing return, generic via `auto`).
//     - `static_cast`/`dynamic_cast`/`reinterpret_cast`/`const_cast`
//       (with `>>`-splitting-aware template-depth tracking), `typeid`,
//       `alignof`, `sizeof...`.
//     - qualified names: `ns::name`, `Class::member`, `Enum::VALUE`,
//       chained `a::b::c` -- disambiguated *lexically* from qualified
//       types via the TYPE_SCOPE terminal (see below).
//     - C++14 literals: hex (missing even from the C grammar), binary
//       (`0b101`), digit separators (`1'000'000`), `ull`-style suffixes,
//       exponent-only floats (`1e5`), leading-dot floats (`.5`), string/char
//       prefixes (`u8`/`u`/`U`/`L`), raw strings (`R"(...)"`, with
//       arbitrary delimiters via a regex backreference).
//     - braced init in declarations (`T x{1, 2};`, non-empty lists only)
//       and `return {…};`.
//
//   Statements: range-based `for`, `try`/`catch`/`throw` (incl.
//     `catch (...)`), `using` at block scope.
//
//   Templates:
//     - type parameters (`typename`/`class`, packs, defaults), non-type
//       parameters (`template<int N>`), on classes, functions, variables
//       (C++14 variable templates), aliases, and class members.
//     - use-site generics `Box<int>` with nested `>>` splitting, pack
//       expansion args, non-type args (`array<int, 5>` -- literal/name
//       arguments directly, anything more complex parenthesized, mirroring
//       the standard's own `>`-in-template-args parenthesization rule),
//       qualified generics (`std::vector<int>`), explicit and partial
//       specialization heads (`template<> class Box<int*>`).
//
// The TYPE_SCOPE lexer trick: the classic typedef lexer hack is extended
// one step -- a registered type/namespace name whose next token is `::`
// lexes as TYPE_SCOPE instead of TYPE_NAME. That makes `Foo::bar()`
// (expression) vs `Foo::Inner x;` (declaration) an ordinary LR decision on
// the *third* token's kind (IDENT vs TYPE_NAME) instead of an unresolvable
// reduce-reduce tie, and is what lets qualified types, out-of-class member
// definitions, and qualified expressions coexist. Namespace names are
// registered the moment `namespace X` is seen, class/struct/union/enum
// names the moment their head is seen (before `{`), template parameters at
// the parameter itself, and alias names at the `=` of `using X = ...`.
//
// Known simplifications/omissions (beyond "parses but doesn't validate"):
//   - Names from *external* headers (`std::string s;`) aren't magically
//     types: nothing is preprocessed or looked up. Seed them via
//     `cppParser.parse(code, knownTypes)` (`std`, being a namespace prefix,
//     only needs itself seeded for `std::vector<int>` etc. to work, since
//     a generic after a scope prefix accepts a plain identifier).
//   - Template parameters/type registrations are *not scoped* -- once a
//     name is a type it stays one for the rest of the input (same
//     deliberate shortcut as before, now applied to more constructs).
//   - No preprocessor (directives are skipped as comments, as in C).
//   - `override`/`final` are real keywords here, not contextual ones --
//     using them as identifiers breaks.
//   - Attributes (`[[...]]`) and `alignas(...)` are *skipped* lexically,
//     not represented in the AST.
//   - No `Box<a < b>`-style unparenthesized comparisons in non-type
//     template arguments (the standard also forbids these); non-type args
//     beyond a literal/name/`sizeof` need parens.
//   - No user-defined literals, no ref-qualified methods (`void f() &`),
//     no placement new, no `operator""`/`->*`/comma-in-declarator edge
//     cases, no function-pointer *members* (function-pointer locals,
//     params and globals still work via C's declarator grammar), no
//     `template` disambiguator, no out-of-class definitions of *template*
//     class members, no `::x` global-scope qualifier, no
//     `Box<int>::iterator` (scope after a template-id), no adjacent
//     string-literal concatenation (also missing from the C grammar).
//   - Functional casts work for registered names (`T(x)`) but not builtin
//     types (`int(x)` -- write `(int)x`); cv-qualifiers on pointer levels
//     (`char* const`) parse but are discarded (C's Pointer AST has no slot).
//   - `goto`/labels can't use registered type names as label names.

// ===================================================================
//  AST types
// ===================================================================

export type AccessSpecifier = 'public' | 'private' | 'protected';

// A variadic function parameter pack (`Args... args`, `Args&&... args`, or unnamed `Args...`) -- a third member of
// `ParamOrVariadic` alongside c-parser.ts's own `ParameterDeclaration`/`{ type: 'variadic' }`.
export interface PackParameter			{ type: 'parameter'; specifiers: DeclarationSpecifiers; name?: string; byRef?: boolean; rvalueRef?: boolean; pack: true; }

export interface AccessLabel			{ type: 'access_label'; access: AccessSpecifier; }
export interface MemberInitializer		{ name: string; arguments: Expr[]; }

// The suffix of a member function past its parameter list: cv/noexcept/virt-specifiers plus how it ends
// (a body, a bare declaration `;`, pure-virtual `= 0;`, `= default;`, or `= delete;`).
export interface MethodTail {
	isConst?: boolean; noexcept?: boolean; override?: boolean; final?: boolean;
	body?: Block; declarationOnly?: boolean; pure?: boolean; defaulted?: boolean; deleted?: boolean;
}
// How a constructor ends: an optional member-initializer list plus body, or `= default;`/`= delete;`/declaration-only.
export interface CtorTail				{ initializerList?: MemberInitializer[]; body?: Block; declarationOnly?: boolean; defaulted?: boolean; deleted?: boolean; }

export type MemberMod = 'static' | 'virtual' | 'inline' | 'constexpr' | 'explicit' | 'friend' | 'mutable';

export interface ConstructorMember		extends CtorTail { type: 'constructor'; name: string; parameters: ParamOrVariadic[]; modifiers?: MemberMod[]; }
export interface DestructorMember		extends MethodTail { type: 'destructor'; name: string; modifiers?: MemberMod[]; }
export interface MethodMember			extends MethodTail { type: 'method'; specifiers: DeclarationSpecifiers; declarator: Declarator; modifiers?: MemberMod[]; }
export interface ConversionMember		extends MethodTail { type: 'conversion'; target: TypeName; modifiers?: MemberMod[]; }
export interface UsingDeclMember		{ type: 'using_decl'; scope: string[]; name: string; }
export interface CppStructMember		extends StructMember { modifiers?: MemberMod[]; }
export interface MemberTemplate		{ type: 'member_template'; params: TemplateParam[]; declaration: ClassMember; }

export type ClassMember = CppStructMember | AccessLabel | ConstructorMember | DestructorMember | MethodMember | ConversionMember | UsingDeclMember | UsingAlias | MemberTemplate;

export interface BaseSpecifier			{ access?: AccessSpecifier; virtual?: boolean; name: string; args?: TemplateArg[]; }
export interface ClassSpecifier		{ type: 'class' | 'struct' | 'union'; name?: string; final?: boolean; bases?: BaseSpecifier[]; members?: ClassMember[]; }
export interface CppEnumSpecifier		{ type: 'enum'; name?: string; scoped?: boolean; base?: TypeSpecifier[]; enumerators?: { name: string; value?: Expr }[]; }

// Reference declarators (`T&`, `T&&`) -- the only new shapes added to C's `Declarator` union.
export type CppDeclarator = Declarator | { type: 'reference'; to: Declarator } | { type: 'rvalue_reference'; to: Declarator };

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
	| { type: 'new'; typeName: TypeSpecifier; arguments?: Expr[]; size?: Expr; braced?: boolean }
	| { type: 'delete'; operand: Expr; array?: boolean }
	| { type: 'pack_expansion'; operand: Expr }
	| { type: 'sizeof_pack'; name: string }
	| { type: 'cpp_cast'; kind: string; target: TypeName; expression: Expr }
	| { type: 'typeid'; expression?: Expr; target?: TypeName }
	| { type: 'alignof'; target: TypeName }
	| { type: 'functional_cast'; target: string; arguments: Expr[] }
	| LambdaExpr;

// `templateDepth` counts currently-open `Box<...>` generic-type-argument lists -- see the `>>`/`>>=`
// lexer patch in "Wire it up" for why. Its presence is also what marks a parse context as C++ for the
// shared IDENT lexer callback (so the TYPE_SCOPE reclassification never fires for plain cParser runs).
export interface CppCtx extends Ctx { templateDepth: number; }

export interface CatchClause			{ paramType?: TypeName; paramName?: string; byRef?: boolean; body: Block; }
export interface UsingDirective		{ type: 'using_namespace'; name: string; }
export interface UsingAlias			{ type: 'using_alias'; name: string; target: TypeName; }
export interface NamespaceDecl			{ type: 'namespace'; name?: string; inline?: boolean; definitions: CppDefinition[]; }
export interface LinkageSpec			{ type: 'linkage'; language: string; definitions: CppDefinition[]; }
export interface StaticAssert			{ type: 'static_assert'; condition: Expr; message: string; }
export interface TemplateParam			{ name: string; pack?: boolean; nonType?: DeclarationSpecifiers; default?: TypeName | Expr; }
export interface TemplateDecl			{ type: 'template'; params: TemplateParam[]; declaration: Definition | ClassSpecifier | UsingAlias; }

// A type argument at a generic *use* site (`Box<int>`) -- `pack` marks a pack-expansion argument (`Tuple<Args...>`),
// `value` is a TypeName for type arguments or an Expr for non-type ones (`array<int, 5>`).
export interface TemplateArg			{ value: TypeName | Expr; pack?: boolean; }
export interface GenericType			{ type: 'generic'; name: string; args: TemplateArg[]; }
export interface QualifiedType			{ type: 'qualified_type'; parts: string[]; dependent?: boolean; }
export interface DecltypeSpecifier		{ type: 'decltype'; expression?: Expr; auto?: boolean; }

export interface OutOfClassMethod		{ type: 'method_def'; specifiers?: DeclarationSpecifiers; scope: string[]; name: string; parameters: ParamOrVariadic[]; tail: MethodTail; }
export interface OutOfClassCtor		{ type: 'constructor_def'; scope: string[]; name: string; parameters: ParamOrVariadic[]; tail: CtorTail; }
export interface OutOfClassDtor		{ type: 'destructor_def'; scope: string[]; name: string; tail: MethodTail; }
export interface OperatorDef			{ type: 'operator_def'; specifiers: DeclarationSpecifiers; scope?: string[]; operator: string; parameters: ParamOrVariadic[]; tail: MethodTail; }
export interface StaticMemberDef		{ type: 'static_member_def'; specifiers: DeclarationSpecifiers; scope: string[]; name: string; initializer?: Expr; }

export type CppStatement =
	| { type: 'throw'; argument?: Expr }
	| { type: 'try'; body: Block; handlers: CatchClause[] }
	| { type: 'range_for'; specifiers: DeclarationSpecifiers; declarator: Declarator; range: Expr; body: Statement | CppStatement }
	| StaticAssert
	| UsingDirective
	| UsingAlias
	| UsingDeclMember;

export type CppDefinition = Definition | NamespaceDecl | LinkageSpec | UsingDirective | UsingDeclMember | UsingAlias | TemplateDecl | StaticAssert
	| OutOfClassMethod | OutOfClassCtor | OutOfClassDtor | OperatorDef | StaticMemberDef;
export interface CppProgram { type: 'translation_unit'; definitions: CppDefinition[]; }

// ===================================================================
//  The TYPE_SCOPE lexer hack
// ===================================================================
//
// One step past c-parser.ts's typedef hack: a registered name *followed by `::`* lexes as TYPE_SCOPE
// rather than TYPE_NAME. Every qualified construct below keys off it, which is what keeps qualified
// expressions (`Foo::bar()`) and qualified types (`Foo::Inner x;`) from ever competing to reduce the
// same tokens -- the decision moves into the lexer, where the one token of context (`::` next) is
// cheap, instead of the SLR tables, where it would be a reduce-reduce tie.
//
// Gated on `ctx.templateDepth !== undefined` so that reassigning the *shared* IDENT terminal's callback
// here can't change plain cParser's behavior -- its parse contexts never carry that field.
export const TYPE_SCOPE = terminal('TYPE_SCOPE');

// Destructures `match`/`remaining` out of the lex-context param in the body rather than the parameter list
// itself (`({ match, remaining }, ctx) => ...`) -- a destructured *first* arrow parameter followed by a typed
// second one is a known tison grammar gap: `object_pattern`'s typed-parameter rule is unreachable from an
// arrow's ambiguous `(` position due to LR state-merging with plain object-literal expressions (a "missing
// transition" the table never records as a conflict, so it can't be fixed with a precedence/fork tag).
IDENT.callback = (lex, ctx: Ctx & Partial<CppCtx>) => {
	const { match, remaining } = lex;
	return ctx.typedefNames.has(match)
		? (ctx.templateDepth !== undefined && /^\s*::/.test(remaining) ? TYPE_SCOPE : TYPE_NAME)
		: IDENT;
};

// `A::B::` -- one or more TYPE_SCOPE'd names, each consuming its own `::`. The building block of every
// qualified construct (types, expressions, out-of-class definitions, using-declarations).
const scope_prefix = RRules<string[]>(self => [
	Rule([TYPE_SCOPE, '::'] as const,			$ => [$[0]]),
	Rule([self, TYPE_SCOPE, '::'] as const,	$ => [...$[0], $[1]]),
]);

// ===================================================================
//  Helpers
// ===================================================================

// A name that might already have been registered as a type (a previously declared class/namespace, or a
// template parameter) -- accepts any spelling the lexer hands back. Used everywhere a *reference* to
// such a name is expected -- never for the name being freshly introduced (that's always a plain IDENT).
const type_ident = Rules<string>(
	Rule([IDENT] as const,		$ => $[0]),
	Rule([TYPE_NAME] as const,	$ => $[0]),
	Rule([TYPE_SCOPE] as const,	$ => $[0]),
);

// `A::B::C`, for `using` declarations only -- never reachable from expression position, so it can't
// compete with the (separately handled, see below) qualified-name expressions.
const using_path = List(type_ident, '::');

// Removes rules from a shared c-parser.ts Rules array. Safe because c-parser's own tables were already
// built (eagerly, at its module top level) by the time this module runs -- mutation here only affects
// the grammar this file builds.
function removeRules(rules: unknown[], pred: (rhs: unknown[]) => boolean) {
	for (let i = rules.length - 1; i >= 0; i--) {
		const rhs = (rules[i] as { rhs?: unknown[] }).rhs;
		if (rhs && pred(rhs))
			rules.splice(i, 1);
	}
}

// ===================================================================
//  C++14 literals
// ===================================================================
//
// All pushed straight onto primary_expression; each competes with C's own narrower literal terminals
// purely by longest-match in the lexer (e.g. `0x1F` is INT `0` + IDENT `x1F` to the C lexer, but the
// 4-char hex match wins here). The digit-separator patterns require at least one `'` so they can never
// tie with C's plain INT_LITERAL on the same length.

const INT_SUFFIX = /(?:[uU](?:ll?|LL?)?|(?:ll?|LL?)[uU]?)?/.source;
const HEX_LITERAL		= new RegExp('0[xX][0-9a-fA-F]+(?:\'[0-9a-fA-F]+)*' + INT_SUFFIX);
const BIN_LITERAL		= new RegExp('0[bB][01]+(?:\'[01]+)*' + INT_SUFFIX);
const SEP_INT_LITERAL	= new RegExp('[0-9]+(?:\'[0-9]+)+' + INT_SUFFIX);
const LL_INT_LITERAL	= new RegExp('[0-9]+(?:[uU](?:ll|LL)|(?:ll|LL)[uU]?|[uU]ll?)');	// `ll`/`ull` suffixes C's single-letter suffix pattern can't reach
const EXP_FLOAT_LITERAL	= /[0-9]+(?:'[0-9]+)*(?:\.[0-9']*)?[eE][-+]?[0-9]+[fFlL]?/;			// exponent without a decimal point (`1e5`)
const DOT_FLOAT_LITERAL	= /\.[0-9]+(?:[eE][-+]?[0-9]+)?[fFlL]?/;							// leading-dot floats (`.5`)

const stripSep = (s: string) => s.replace(/'/g, '').replace(/[uUlL]+$/, '');

// String/char prefixes and raw strings. The raw-string pattern uses a backreference (`\1`) to match the
// arbitrary user-chosen delimiter, which regexes famously "can't do" -- except JS regexes have had
// backreferences all along.
const PREFIXED_STRING	= /(?:u8|[uUL])"(?:[^"\\]|\\.)*"/;
const RAW_STRING		= /(?:u8|[uUL])?R"([^ ()\\\t\n]*)\(([^]*?)\)\1"/;
const PREFIXED_CHAR		= /(?:u8|[uUL])'(?:[^'\\]|\\.)*'/;

const primaryExpressionCast = primary_expression as unknown as Rules<Expr | CppExpr>;
primaryExpressionCast.push(
	Rule([HEX_LITERAL] as const,		$ => ({ type: 'literal', value: parseInt(stripSep($[0]).slice(2), 16) } as unknown as Expr)),
	Rule([BIN_LITERAL] as const,		$ => ({ type: 'literal', value: parseInt(stripSep($[0]).slice(2), 2) } as unknown as Expr)),
	Rule([SEP_INT_LITERAL] as const,	$ => ({ type: 'literal', value: parseInt(stripSep($[0]), 10) } as unknown as Expr)),
	Rule([LL_INT_LITERAL] as const,		$ => ({ type: 'literal', value: parseInt(stripSep($[0]), 10) } as unknown as Expr)),
	Rule([EXP_FLOAT_LITERAL] as const,	$ => ({ type: 'literal', value: parseFloat(stripSep($[0])) } as unknown as Expr)),
	Rule([DOT_FLOAT_LITERAL] as const,	$ => ({ type: 'literal', value: parseFloat($[0]) } as unknown as Expr)),
	Rule([PREFIXED_STRING] as const,	$ => ({ type: 'string_literal', value: $[0] } as unknown as Expr)),
	Rule([RAW_STRING] as const,			$ => ({ type: 'string_literal', value: $[0] } as unknown as Expr)),
	Rule([PREFIXED_CHAR] as const,		$ => ({ type: 'char_literal', value: $[0] } as unknown as Expr)),
);

// ===================================================================
//  Gaps in the C grammar that C++ code trips over constantly
// ===================================================================

// C's specifier_qualifier_list can only *trail* with qualifiers (`int const`); C++ style leads with them
// (`const char*`, `catch (const int& e)`, `const auto&`). A right-recursive leading alternative fixes
// every one of those at once.
(specifier_qualifier_list as unknown as Rules<unknown[]>).push(
	Rule([type_qualifier, specifier_qualifier_list] as const,	$ => [$[0], ...$[1]]),
);

// Zero-argument calls (`g()`) -- C's postfix_expression only had the argument_expression_list form, and
// that list (like every List here) is non-empty.
(postfix_expression as unknown as Rules<Expr | CppExpr>).push(
	Rule([postfix_expression, '(', ')'] as const,	$ => ({ type: 'function_call', function: $[0] as Expr, arguments: [] } as const)),
);

// `for (;;)` and friends: C's for-clause rules all demand a leading expression or declaration, so every
// empty-slot combination (`;;`, `;cond;`, `init;;step`, ...) needs its own shape. A `declaration` clause
// consumes its own first `;`, hence the shorter decl-led shapes.
(for_statement as unknown as Rules<unknown>).push(
	Rule([';', ';'] as const,											() => ({ init: undefined })),
	Rule([';', ';', expression] as const,								$ => ({ init: undefined, update: $[2] })),
	Rule([';', expression, ';'] as const,								$ => ({ init: undefined, condition: $[1] })),
	Rule([';', expression, ';', expression] as const,					$ => ({ init: undefined, condition: $[1], update: $[3] })),
	Rule([expression, ';', ';'] as const,								$ => ({ init: $[0] })),
	Rule([expression, ';', ';', expression] as const,					$ => ({ init: $[0], update: $[3] })),
	Rule([expression, ';', expression, ';'] as const,					$ => ({ init: $[0], condition: $[2] })),
	Rule([declaration, ';'] as const,									$ => ({ init: $[0] })),
	Rule([declaration, ';', expression] as const,						$ => ({ init: $[0], update: $[2] })),
	Rule([declaration, expression, ';'] as const,						$ => ({ init: $[0], condition: $[1] })),
);

// cv-qualified pointer levels (`const char* const* p`). The qualifier is accepted and discarded --
// C's Pointer AST shape has nowhere to hang it, and widening that is a c-parser.ts change.
(pointer as unknown as Rules<Pointer>).push(
	Rule(['*', type_qualifier] as const,			() => [{ level: 1 }]),
	Rule(['*', type_qualifier, pointer] as const,	$ => [{ level: $[2].length + 1 }, ...$[2]]),
);

// Functional casts (`T(3.14)`, `T()`) -- the ctor-call-shaped counterpart of C's `(T)x`. Only for
// registered names: TYPE_NAME in expression position is otherwise inert, so this steals nothing.
primaryExpressionCast.push(
	Rule([TYPE_NAME, '(', argument_expression_list, ')'] as const,	$ => ({ type: 'functional_cast', target: $[0], arguments: $[2] } as unknown as CppExpr)),
	Rule([TYPE_NAME, '(', ')'] as const,							$ => ({ type: 'functional_cast', target: $[0], arguments: [] } as unknown as CppExpr)),
);

// ===================================================================
//  `auto` as a real type / new type specifiers
// ===================================================================

// C++11 repurposed `auto` from a (useless) storage class into a placeholder *type*. Doing the same here
// -- removing C's storage-class reading entirely rather than keeping both -- is what avoids the bare
// keyword ever completing two different one-token reductions at once (the reduce-reduce hazard the old
// bolted-on `auto x = ...` rules existed to dodge). With `auto` an ordinary type_specifier, deduced
// variables, `auto&`/`auto*` declarators, generic lambda parameters, and `auto f() {...}` return-type
// deduction all fall out of the existing C declaration machinery for free.
removeRules(storage_class_specifier as unknown[], rhs => rhs.length === 1 && rhs[0] === 'auto');

const CPP_SIMPLE_TYPE = termOneOf(['auto', 'bool', 'wchar_t', 'char16_t', 'char32_t'] as const);

const typeSpecifierCast = type_specifier as unknown as Rules<TypeSpecifier | GenericType | QualifiedType | DecltypeSpecifier>;
typeSpecifierCast.push(
	Rule([CPP_SIMPLE_TYPE] as const,					$ => ({ type: 'type', name: $[0] } as const)),
	Rule(['decltype', '(', expression, ')'] as const,	$ => ({ type: 'decltype', expression: $[2] } as const)),
	Rule(['decltype', '(', 'auto', ')'] as const,		() => ({ type: 'decltype', auto: true } as const)),
);

// New C++ declaration specifiers. `constexpr` et al. ride the same storage-class slot C already threads
// through declaration_specifiers everywhere.
(storage_class_specifier as unknown as Rules<string>).push(
	Rule(['inline'] as const,		() => 'inline'),
	Rule(['constexpr'] as const,	() => 'constexpr'),
	Rule(['thread_local'] as const,	() => 'thread_local'),
);

// C's declaration_specifiers allows at most one storage-class-like specifier; C++ regularly stacks two
// (`static constexpr int x`). Two is enough in practice -- three-deep stacks are vanishingly rare.
(declaration_specifiers as unknown as Rules<DeclarationSpecifiers>).push(
	Rule([storage_class_specifier, storage_class_specifier, specifier_qualifier_list] as const,
		($, ctx: Ctx) => { ctx.pendingTypedef = $[0] === 'typedef' || $[1] === 'typedef'; return [$[0], $[1], ...$[2]] as DeclarationSpecifiers; }),
);

// ===================================================================
//  References (`T&`, `T&&`, `T*&`)
// ===================================================================

const declaratorCast = declarator as unknown as Rules<CppDeclarator>;
declaratorCast.push(
	Rule(['&', direct_declarator] as const,				$ => ({ type: 'reference', to: $[1] } as const)),
	Rule([pointer, '&', direct_declarator] as const,	$ => ({ type: 'reference', to: { type: 'pointer', pointer: $[0], to: $[2] } } as const)),
	Rule(['&&', direct_declarator] as const,			$ => ({ type: 'rvalue_reference', to: $[1] } as const)),
	Rule([pointer, '&&', direct_declarator] as const,	$ => ({ type: 'rvalue_reference', to: { type: 'pointer', pointer: $[0], to: $[2] } } as const)),
);

// Abstract reference declarators, so `int&`/`int&&` work as bare type-names (casts, template args,
// unnamed parameters). Pushed as new alternatives rather than routed through direct_abstract_declarator
// -- a reference is always outermost, so it doesn't need to compose the way pointers do.
(abstract_declarator as unknown as Rules<unknown>).push(
	Rule(['&'] as const,			() => ({ type: 'reference' } as const)),
	Rule(['&&'] as const,			() => ({ type: 'rvalue_reference' } as const)),
	Rule([pointer, '&'] as const,	$ => ({ type: 'reference', to: { type: 'pointer', pointer: $[0] } } as const)),
	Rule([pointer, '&&'] as const,	$ => ({ type: 'rvalue_reference', to: { type: 'pointer', pointer: $[0] } } as const)),
);

// ===================================================================
//  Parameters: defaults, abstract (unnamed), variadic packs
// ===================================================================

const parameterDeclarationCast = parameter_declaration as unknown as Rules<ParamOrVariadic>;
parameterDeclarationCast.push(
	Rule([declaration_specifiers, declarator, '=', assignment_expression] as const,	$ => ({ type: 'parameter', specifiers: $[0], declarator: $[1] as Declarator, default: $[3] } as const)),
	Rule([declaration_specifiers, '=', assignment_expression] as const,				$ => ({ type: 'parameter', specifiers: $[0], default: $[2] } as const)),

	// Unnamed-but-shaped parameters (`void f(int*)`, `void f(const Foo&)`) -- missing even from the C
	// grammar, which only had fully-named or bare-specifier parameters.
	Rule([declaration_specifiers, abstract_declarator] as const,					$ => ({ type: 'parameter', specifiers: $[0], declarator: $[1] as unknown as Declarator } as const)),

	// Variadic function parameter packs -- the declaration-side half of variadic templates, now including
	// forwarding references (`Args&&... args`).
	Rule([declaration_specifiers, '...', IDENT] as const,			$ => ({ type: 'parameter', specifiers: $[0], name: $[2], pack: true } as const)),
	Rule([declaration_specifiers, '&', '...', IDENT] as const,		$ => ({ type: 'parameter', specifiers: $[0], name: $[3], byRef: true, pack: true } as const)),
	Rule([declaration_specifiers, '&&', '...', IDENT] as const,	$ => ({ type: 'parameter', specifiers: $[0], name: $[3], rvalueRef: true, pack: true } as const)),
	Rule([declaration_specifiers, '...'] as const,					$ => ({ type: 'parameter', specifiers: $[0], pack: true } as const)),
	Rule([declaration_specifiers, '&', '...'] as const,				$ => ({ type: 'parameter', specifiers: $[0], byRef: true, pack: true } as const)),
	Rule([declaration_specifiers, '&&', '...'] as const,			$ => ({ type: 'parameter', specifiers: $[0], rvalueRef: true, pack: true } as const)),
);

// ===================================================================
//  this / true / false / nullptr / qualified names
// ===================================================================

function qualifiedParts(e: Expr | CppExpr): string[] | undefined {
	return (e as any).type === 'qualified' ? (e as any).parts as string[]
		: (e as any).type === 'identifier' ? [(e as any).name as string]
		: undefined;
}

primaryExpressionCast.push(
	Rule(['this'] as const,		() => ({ type: 'this' } as const)),
	Rule(['true'] as const,		() => ({ type: 'bool_literal', value: true } as const)),
	Rule(['false'] as const,	() => ({ type: 'bool_literal', value: false } as const)),
	Rule(['nullptr'] as const,	() => ({ type: 'null_literal' } as const)),
	// `A::B::C` rooted at an *unregistered* name (`std::cout` with nothing seeded) -- a left-recursive
	// *continuation* of an already-reduced primary_expression (the same shift-based shape
	// postfix_expression's own '.'/'->' continuations use), not a fresh alternative competing to reduce
	// a bare IDENT -- that alternative shape is what caused a genuine reduce-reduce conflict against
	// primary_expression's own pre-existing `[IDENT]` rule.
	Rule([primary_expression, '::', type_ident] as const,	$ => ({ type: 'qualified', parts: [...(qualifiedParts($[0]) ?? []), $[2]] } as const)),
	// `Foo::bar`, `Color::RED`, `math::sq` rooted at a *registered* name -- TYPE_SCOPE (see above) keeps
	// this from ever colliding with the qualified-*type* rules over the same tokens: the third token's
	// own kind (IDENT here, TYPE_NAME there) is the whole decision.
	Rule([scope_prefix, IDENT] as const,					$ => ({ type: 'qualified', parts: [...$[0], $[1]] } as const)),
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
// C++14 generic lambdas need no rules of their own: `auto` is now an ordinary type_specifier, so
// `[](auto x) {...}` comes through parameter_type_list like any other parameter.
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
	WithPrec(Rule(['new', type_specifier] as const,										$ => ({ type: 'new', typeName: $[1] } as const)), 'unary'),
	WithPrec(Rule(['new', type_specifier, '(', ')'] as const,							$ => ({ type: 'new', typeName: $[1], arguments: [] } as const)), 'unary'),
	WithPrec(Rule(['new', type_specifier, '(', argument_expression_list, ')'] as const,	$ => ({ type: 'new', typeName: $[1], arguments: $[3] } as const)), 'unary'),
	WithPrec(Rule(['new', type_specifier, '{', argument_expression_list, '}'] as const,	$ => ({ type: 'new', typeName: $[1], arguments: $[3], braced: true } as const)), 'unary'),
	WithPrec(Rule(['new', type_specifier, '[', expression, ']'] as const,				$ => ({ type: 'new', typeName: $[1], size: $[3] } as const)), 'unary'),
	WithPrec(Rule(['delete', assignment_expression] as const,							$ => ({ type: 'delete', operand: $[1] } as const)), 'unary'),
	WithPrec(Rule(['delete', '[', ']', assignment_expression] as const,					$ => ({ type: 'delete', operand: $[3], array: true } as const)), 'unary'),

	// Pack expansion (`args...`, e.g. inside a call's argument list, `print(args...)`) -- a left-recursive
	// postfix continuation (same shift-based shape as the `::` continuation above), since unlike most unary
	// operators this one trails its operand rather than leading it.
	Rule([assignment_expression, '...'] as const,										$ => ({ type: 'pack_expansion', operand: $[0] } as const)),
	// `sizeof...(Args)` -- the pack-count counterpart of plain `sizeof`/`sizeof(Type)`, which c-parser.ts
	// already has at this same level.
	WithPrec(Rule(['sizeof', '...', '(', type_ident, ')'] as const,						$ => ({ type: 'sizeof_pack', name: $[3] } as const)), 'unary'),
);

// ===================================================================
//  C++ casts / typeid / alignof / static_assert
// ===================================================================

// `static_cast<vector<int>>(x)` has the same trailing-`>>` problem as nested generics, so the cast's own
// `<` maintains templateDepth too. The open/close split mirrors generic_type_open: depth is bumped the
// moment `<` is seen and dropped the moment `>` closes (as its own eager two-token-ish reduction, with
// only `(` as lookahead), so the *expression* inside the parentheses parses at the outer depth -- a
// plain `a >> b` argument must lex as a genuine right-shift again.
const cast_open = Rules<string>(
	Rule([termOneOf(['static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast'] as const), '<'] as const,
		($, ctx: CppCtx) => { ctx.templateDepth++; return $[0]; }),
);
const cast_close = Rules<{ kind: string; target: TypeName }>(
	Rule([cast_open, type_name, '>'] as const,	($, ctx: CppCtx) => { ctx.templateDepth--; return { kind: $[0], target: $[1] as TypeName }; }),
);

primaryExpressionCast.push(
	Rule([cast_close, '(', expression, ')'] as const,	$ => ({ type: 'cpp_cast', ...$[0], expression: $[2] } as const)),
	// Same TYPE_NAME-vs-expression split sizeof already relies on: a bare registered type can only be the
	// type_name alternative, anything expression-shaped only the expression one.
	Rule(['typeid', '(', expression, ')'] as const,	$ => ({ type: 'typeid', expression: $[2] } as const)),
	Rule(['typeid', '(', type_name, ')'] as const,	$ => ({ type: 'typeid', target: $[2] as TypeName } as const)),
);
assignmentExpressionCast.push(
	WithPrec(Rule(['alignof', '(', type_name, ')'] as const,	$ => ({ type: 'alignof', target: $[2] as TypeName } as const)), 'unary'),
);

const static_assert_decl = Rules<StaticAssert>(
	Rule(['static_assert', '(', assignment_expression, ',', STRING_LITERAL, ')', ';'] as const,
		$ => ({ type: 'static_assert', condition: $[2], message: $[4] } as const)),
);

// ===================================================================
//  Qualified and generic types
// ===================================================================
//
// `ctx.templateDepth` counts how many generic-type-argument lists are currently open; see the `>>`/`>>=`
// lexer patch in "Wire it up" below for why it needs to exist at all (so `vector<vector<int>>` doesn't
// lex its trailing `>>` as a single right-shift token).

// Reduces the moment `TYPE_NAME '<'` is seen (the same eager two-token timing trick the class/struct
// heads use) so the depth counter is incremented *before* anything inside the argument list -- including
// a further nested `<...>` -- gets lexed. The scope-prefixed forms accept a plain IDENT after the `::`
// as well (`std::vector<int>` -- `vector` itself was never registered, only `std`), trading away
// `std::x < y` comparisons on registered prefixes, which real code essentially never writes unparenthesized.
//
// Scoped opens are a SEPARATE nonterminal from the plain one: only the plain form may live on
// type_specifier. A scope_prefix-starting type_specifier alternative would put a TYPE_SCOPE *shift*
// into specifier_qualifier_list's extension state, and that shift beats the declaration_specifiers
// reduce that an out-of-class definition (`int Foo::getX() ...`) needs at exactly that point -- the
// `Foo::` would be absorbed as a second type specifier and the definition could never start. Scoped
// forms are instead pushed onto specifier_qualifier_list itself as list-*starting* alternatives below,
// where no such competition exists (a C++ type can't follow another type specifier anyway).
const generic_type_open = Rules<string>(
	Rule([TYPE_NAME, '<'] as const,							($, ctx: CppCtx) => { ctx.templateDepth++; return $[0]; }),
);
const scoped_generic_open = Rules<string>(
	Rule([scope_prefix, TYPE_NAME, '<'] as const,			($, ctx: CppCtx) => { ctx.templateDepth++; return [...$[0], $[1]].join('::'); }),
	Rule([scope_prefix, IDENT, '<'] as const,				($, ctx: CppCtx) => { ctx.templateDepth++; return [...$[0], $[1]].join('::'); }),
);

// Non-type template arguments (`array<int, 5>`). Deliberately *not* full constant_expression: allowing
// relationals here would put `>` shifts in competition with the argument-list-closing `>` reduce.
// A literal/name/sizeof covers real usage, and the parenthesized escape hatch admits any expression --
// the same trade the standard itself makes (unparenthesized `>` is ill-formed in a template argument).
const const_arg = Rules<Expr>(
	Rule([INT_LITERAL] as const,				$ => ({ type: 'literal', value: parseInt($[0], 10) } as unknown as Expr)),
	Rule([IDENT] as const,						$ => ({ type: 'identifier', name: $[0] } as const)),
	Rule(['true'] as const,						() => ({ type: 'bool_literal', value: true } as unknown as Expr)),
	Rule(['false'] as const,					() => ({ type: 'bool_literal', value: false } as unknown as Expr)),
	Rule(['-', INT_LITERAL] as const,			$ => ({ type: 'literal', value: -parseInt($[1], 10) } as unknown as Expr)),
	Rule(['sizeof', '(', type_name, ')'] as const,	$ => ({ type: 'sizeof_type', operand: $[2] } as unknown as Expr)),
	Rule(['(', expression, ')'] as const,		$ => $[1]),
);

const template_argument = Rules<TemplateArg>(
	Rule([type_name] as const,				$ => ({ value: $[0] as TypeName } as const)),
	Rule([type_name, '...'] as const,		$ => ({ value: $[0] as TypeName, pack: true } as const)),
	Rule([const_arg] as const,				$ => ({ value: $[0] } as const)),
);
const template_argument_list = List(template_argument, ',');

// `TYPE_NAME '<'` (shift) vs the plain `[TYPE_NAME]` alt already on `type_specifier` (reduce) is an
// ordinary shift/reduce choice on the very next token, resolved to shift -- the same safe shape used
// throughout this file.
typeSpecifierCast.push(
	Rule([generic_type_open, template_argument_list, '>'] as const,
		($, ctx: CppCtx) => { ctx.templateDepth--; return { type: 'generic', name: $[0], args: $[1] } as const; }),
	// `typename T::type` -- the dependent-name escape hatch, safe on type_specifier since it leads with
	// its own keyword.
	Rule(['typename', scope_prefix, type_ident] as const,	$ => ({ type: 'qualified_type', parts: [...$[1], $[2]], dependent: true } as const)),
);

// Qualified types (`Foo::Inner x;` -- Inner itself registered, automatic for in-file nested types) and
// scoped generics (`std::vector<int>`), as specifier_qualifier_list *starters* -- see the
// scoped_generic_open comment for why they must not be type_specifier alternatives.
(specifier_qualifier_list as unknown as Rules<unknown[]>).push(
	Rule([scope_prefix, TYPE_NAME] as const,	$ => [{ type: 'qualified_type', parts: [...$[0], $[1]] } as QualifiedType]),
	Rule([scoped_generic_open, template_argument_list, '>'] as const,
		($, ctx: CppCtx) => { ctx.templateDepth--; return [{ type: 'generic', name: $[0], args: $[1] } as GenericType]; }),
);

// ===================================================================
//  Class/struct/union/enum heads
// ===================================================================
//
// Every head reduces the moment `keyword IDENT` is seen -- i.e. *before* '{' (and everything inside the
// body) is even shifted -- so the type's own name is already registered by the time its body parses
// (self-referential `struct Node { Node* next; };`), the same timing trick c-parser.ts's own
// `pendingTypedef` relies on for `typedef`. The TYPE_NAME alternatives cover redeclarations and
// definitions-after-forward-declarations, where the name is already registered.

const class_head = Rules<string>(
	Rule(['class', IDENT] as const,		($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return $[1]; }),
	Rule(['class', TYPE_NAME] as const,	$ => $[1]),
	// Specialization heads (`template<> class Box<int>` / partial `template<class T> class Box<T*>`) --
	// the generic machinery already tracks templateDepth, and a partial specialization's `T*` argument is
	// just a type_name with an abstract declarator.
	Rule(['class', generic_type_open, template_argument_list, '>'] as const,
		($, ctx: CppCtx) => { ctx.templateDepth--; return $[1]; }),
);

const struct_head = Rules<{ kind: 'struct' | 'union'; name: string }>(
	Rule(['struct', IDENT] as const,		($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return { kind: 'struct', name: $[1] } as const; }),
	Rule(['struct', TYPE_NAME] as const,	$ => ({ kind: 'struct', name: $[1] } as const)),
	Rule(['union', IDENT] as const,			($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return { kind: 'union', name: $[1] } as const; }),
	Rule(['union', TYPE_NAME] as const,		$ => ({ kind: 'union', name: $[1] } as const)),
);

// C's own named struct/union rules (both the monolithic `'struct' IDENT '{' ... '}'` definitions and the
// tag-only references) are *replaced* by head-based ones: the monolithic shape shifts '{' before any
// reduction can run, which is exactly too late to register the name for uses inside the body.
removeRules(struct_or_union_specifier as unknown[], rhs => (rhs[0] === 'struct' || rhs[0] === 'union') && rhs[1] === IDENT);

const base_specifier = Rules<BaseSpecifier>(
	Rule([type_ident] as const,															$ => ({ name: $[0] } as const)),
	Rule([termOneOf(['public', 'private', 'protected'] as const), type_ident] as const,	$ => ({ access: $[0], name: $[1] } as const)),
	Rule(['virtual', type_ident] as const,												$ => ({ virtual: true, name: $[1] } as const)),
	Rule(['virtual', termOneOf(['public', 'private', 'protected'] as const), type_ident] as const, $ => ({ virtual: true, access: $[1], name: $[2] } as const)),
	// Generic bases (`: public Base<T>`).
	Rule([generic_type_open, template_argument_list, '>'] as const,						($, ctx: CppCtx) => { ctx.templateDepth--; return { name: $[0], args: $[1] } as const; }),
	Rule([termOneOf(['public', 'private', 'protected'] as const), generic_type_open, template_argument_list, '>'] as const,
		($, ctx: CppCtx) => { ctx.templateDepth--; return { access: $[0], name: $[1], args: $[2] } as const; }),
);
const base_list = List(base_specifier, ',');
const base_clause = Rules<BaseSpecifier[]>(
	Rule([':', base_list] as const, $ => $[1]),
);

// A shared "everything after the name" tail for class/struct/union: [final?] [bases?] { members? }.
// Absent entirely for tag-only references.
interface ClassBody { final?: boolean; bases?: BaseSpecifier[]; members: ClassMember[]; }
const class_body_rules: Rules<ClassBody> = [];
for (const fin of [false, true]) {
	for (const based of [false, true]) {
		const prefix = [...(fin ? ['final'] : []), ...(based ? [base_clause] : [])];
		class_body_rules.push(
			Rule([...prefix, '{', '}'] as any,				($: any[]) => ({ final: fin || undefined, bases: based ? $[fin ? 1 : 0] : undefined, members: [] } as ClassBody)),
			Rule([...prefix, '{', struct_body, '}'] as any,	($: any[]) => ({ final: fin || undefined, bases: based ? $[fin ? 1 : 0] : undefined, members: $[prefix.length + 1] as ClassMember[] } as ClassBody)),
		);
	}
}
const class_body = Rules<ClassBody>(...class_body_rules);

const structOrUnionSpecifierCast = struct_or_union_specifier as unknown as Rules<StructSpecifier | ClassSpecifier>;
structOrUnionSpecifierCast.push(
	// class: tag-only, with-body, anonymous.
	Rule([class_head] as const,					$ => ({ type: 'class', name: $[0] } as const)),
	Rule([class_head, class_body] as const,		$ => ({ type: 'class', name: $[0], ...$[1] } as const)),
	Rule(['class', '{', '}'] as const,			() => ({ type: 'class', members: [] } as const)),
	Rule(['class', '{', struct_body, '}'] as const,	$ => ({ type: 'class', members: $[2] as ClassMember[] } as const)),
	// struct/union: same shapes, now with registration + C++ bodies (bases, members) via the shared tail.
	Rule([struct_head] as const,				$ => ({ type: $[0].kind, name: $[0].name } as const)),
	Rule([struct_head, class_body] as const,	$ => ({ type: $[0].kind, name: $[0].name, ...$[1] } as const)),
);

// ===================================================================
//  Enums: scoped, based, opaque
// ===================================================================

// Same replace-with-eager-head treatment as struct above -- `enum Color {RED}; Color c;` needs Color
// registered before the token after `}` is lexed, which only head-time registration achieves.
removeRules(enum_specifier as unknown[], rhs => rhs[0] === 'enum' && rhs[1] === IDENT);

const enum_head = Rules<{ name: string; scoped?: boolean }>(
	Rule(['enum', IDENT] as const,			($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return { name: $[1] } as const; }),
	Rule(['enum', TYPE_NAME] as const,		$ => ({ name: $[1] } as const)),
	Rule(['enum', termOneOf(['class', 'struct'] as const), IDENT] as const,		($, ctx: Ctx) => { ctx.typedefNames.add($[2]); return { name: $[2], scoped: true } as const; }),
	Rule(['enum', termOneOf(['class', 'struct'] as const), TYPE_NAME] as const,	$ => ({ name: $[2], scoped: true } as const)),
);

const enum_base = Rules<TypeSpecifier[]>(
	Rule([':', specifier_qualifier_list] as const, $ => $[1] as TypeSpecifier[]),
);

(enum_specifier as unknown as Rules<CppEnumSpecifier>).push(
	Rule([enum_head] as const,											$ => ({ type: 'enum', ...$[0] } as const)),	// tag reference or opaque declaration
	Rule([enum_head, enum_base] as const,								$ => ({ type: 'enum', ...$[0], base: $[1] } as const)),
	Rule([enum_head, '{', enumerator_list, '}'] as const,				$ => ({ type: 'enum', ...$[0], enumerators: $[2] } as const)),
	Rule([enum_head, '{', enumerator_list, ',', '}'] as const,			$ => ({ type: 'enum', ...$[0], enumerators: $[2] } as const)),
	Rule([enum_head, enum_base, '{', enumerator_list, '}'] as const,	$ => ({ type: 'enum', ...$[0], base: $[1], enumerators: $[3] } as const)),
	Rule([enum_head, enum_base, '{', enumerator_list, ',', '}'] as const,	$ => ({ type: 'enum', ...$[0], base: $[1], enumerators: $[3] } as const)),
);

// ===================================================================
//  Class members
// ===================================================================

// A method's name+params, inlined as `IDENT '(' ... ')'` (rather than routed through the shared
// `declarator`/`direct_declarator` chain, which also completes on a *bare* IDENT alone for plain
// fields via `struct_declarator`). Inlining keeps the IDENT-then-'(' shape a single multi-symbol
// rule, so the parser only ever faces an ordinary shift/reduce choice ('(' next -> shift, keep
// building a method; anything else -> reduce the bare IDENT as a plain field name instead) rather
// than a genuine reduce-reduce tie between two completed one-token rules.
const method_declarator = Rules<{ name: string; parameters: ParamOrVariadic[] }>(
	Rule([IDENT, '(', ')'] as const,							$ => ({ name: $[0], parameters: [] } as const)),
	Rule([IDENT, '(', parameter_type_list, ')'] as const,		$ => ({ name: $[0], parameters: $[2] as ParamOrVariadic[] } as const)),
);
const method_signature = Rules<CppDeclarator>(
	Rule([method_declarator] as const,
		$ => ({ type: 'function', name: { type: 'identifier', name: $[0].name }, parameters: $[0].parameters } as const)),
	Rule([pointer, method_declarator] as const,
		$ => ({ type: 'pointer', pointer: $[0], to: { type: 'function', name: { type: 'identifier', name: $[1].name }, parameters: $[1].parameters } } as const)),
	Rule(['&', method_declarator] as const,
		$ => ({ type: 'reference', to: { type: 'function', name: { type: 'identifier', name: $[1].name }, parameters: $[1].parameters } } as const)),
	Rule(['&&', method_declarator] as const,
		$ => ({ type: 'rvalue_reference', to: { type: 'function', name: { type: 'identifier', name: $[1].name }, parameters: $[1].parameters } } as const)),
);

// Everything that can legally follow a member function's `)`: cv/noexcept/virt-specifiers in standard
// order, ending in a body, a bare `;` declaration, `= 0;`, `= default;`, or `= delete;`. Generated as
// the full cross product -- factoring the *suffix* this way is SLR-safe (each added token is a plain
// shift; the hazardous direction is competing *prefixes*), and 60 generated rules beat 60 hand-written ones.
const method_tail_rules: Rules<MethodTail> = [];
for (const isConst of [false, true]) {
	for (const noex of [false, true]) {
		for (const virt of [undefined, 'override', 'final'] as const) {
			const prefix: unknown[] = [...(isConst ? ['const'] : []), ...(noex ? ['noexcept'] : []), ...(virt ? [virt] : [])];
			const flags: MethodTail = { isConst: isConst || undefined, noexcept: noex || undefined, override: virt === 'override' || undefined, final: virt === 'final' || undefined };
			method_tail_rules.push(
				Rule([...prefix, compound_statement] as any,	($: any[]) => ({ ...flags, body: $[$.length - 1] as Block })),
				Rule([...prefix, ';'] as any,					() => ({ ...flags, declarationOnly: true })),
				Rule([...prefix, '=', INT_LITERAL, ';'] as any,	() => ({ ...flags, pure: true })),
				Rule([...prefix, '=', 'default', ';'] as any,	() => ({ ...flags, defaulted: true })),
				Rule([...prefix, '=', 'delete', ';'] as any,	() => ({ ...flags, deleted: true })),
			);
		}
	}
}
const method_tail = Rules<MethodTail>(...method_tail_rules);

const member_initializer = Rules<MemberInitializer>(
	Rule([type_ident, '(', ')'] as const,							$ => ({ name: $[0], arguments: [] } as const)),
	Rule([type_ident, '(', argument_expression_list, ')'] as const,	$ => ({ name: $[0], arguments: $[2] } as const)),
);
const member_initializer_list = List(member_initializer, ',');

// How a constructor ends -- member-initializer list + body, plain body, or the `= default`/`= delete`/
// declaration-only forms shared with methods.
const ctor_tail = Rules<CtorTail>(
	Rule([compound_statement] as const,									$ => ({ body: $[0] as Block } as const)),
	Rule([':', member_initializer_list, compound_statement] as const,	$ => ({ initializerList: $[1], body: $[2] as Block } as const)),
	Rule([';'] as const,												() => ({ declarationOnly: true } as const)),
	Rule(['=', 'default', ';'] as const,								() => ({ defaulted: true } as const)),
	Rule(['=', 'delete', ';'] as const,									() => ({ deleted: true } as const)),
);

// Leading member modifiers (`static`, `virtual`, `explicit`, ... in any combination) as a real list --
// after any one of these keywords, the only tokens that can follow are another modifier, `~` (a virtual
// destructor -- kept as a shift against this reduce), or the start of a type, so the list reduces
// cleanly one token ahead of the member itself. A nonterminal over the individual keyword literals, NOT
// a single termOneOf terminal: a combined `static|virtual|...` pattern would tie with the standalone
// `virtual`/`static` keyword terminals in the lexer on the same match length, and whichever won the
// tiebreak would starve the other's grammar path entirely.
const member_mod = Rules<MemberMod>(
	Rule(['static'] as const,		() => 'static'),
	Rule(['virtual'] as const,		() => 'virtual'),
	Rule(['inline'] as const,		() => 'inline'),
	Rule(['constexpr'] as const,	() => 'constexpr'),
	Rule(['explicit'] as const,		() => 'explicit'),
	Rule(['friend'] as const,		() => 'friend'),
	Rule(['mutable'] as const,		() => 'mutable'),
);
const member_mods = List(member_mod) as unknown as Rules<MemberMod[]>;

// Operator overloading. The operator-symbol terminal only ever competes in the lexer *after* the
// `operator` keyword (state-driven lexing), so it can't steal `+` etc. from expression states.
const overloadable_op = termOneOf([
	'+', '-', '*', '/', '%', '^', '&', '|', '~', '!', '=', '<', '>',
	'+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=', '<<', '>>', '>>=', '<<=',
	'==', '!=', '<=', '>=', '&&', '||', '++', '--', ',', '->',
] as const);
const operator_id = Rules<string>(
	Rule(['operator', overloadable_op] as const,	$ => $[1]),
	Rule(['operator', '(', ')'] as const,			() => '()'),
	Rule(['operator', '[', ']'] as const,			() => '[]'),
	Rule(['operator', 'new'] as const,				() => 'new'),
	Rule(['operator', 'delete'] as const,			() => 'delete'),
);
const operator_declarator = Rules<{ name: string; parameters: ParamOrVariadic[] }>(
	Rule([operator_id, '(', ')'] as const,							$ => ({ name: $[0], parameters: [] } as const)),
	Rule([operator_id, '(', parameter_type_list, ')'] as const,		$ => ({ name: $[0], parameters: $[2] as ParamOrVariadic[] } as const)),
);
// Pointer/reference-returning operator functions (`V& operator+=(...)`) -- the same leading-decorator
// shapes method_signature has.
const operator_signature = Rules<{ name: string; parameters: ParamOrVariadic[] }>(
	Rule([operator_declarator] as const,			$ => $[0]),
	Rule([pointer, operator_declarator] as const,	$ => $[1]),
	Rule(['&', operator_declarator] as const,		$ => $[1]),
	Rule(['&&', operator_declarator] as const,		$ => $[1]),
);

// Member type aliases and using-declarations, shared with namespace scope below.
const using_alias_head = Rules<string>(
	// Registered at the `=` -- before the aliased type is even parsed -- for the same
	// next-token-already-lexed reason as every other eager head in this file.
	Rule(['using', IDENT, '='] as const,		($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return $[1]; }),
	Rule(['using', TYPE_NAME, '='] as const,	$ => $[1]),
);
const using_alias = Rules<UsingAlias>(
	Rule([using_alias_head, type_name, ';'] as const, $ => ({ type: 'using_alias', name: $[0], target: $[1] as TypeName } as const)),
);

// Fields beyond C's bare-IDENT struct_declarator: pointers, references, arrays, and non-static data
// member initializers (`int x = 5;`). Generated as shapes rather than routed through the full
// `declarator` chain -- a struct_declarator that could derive a *function* declarator would complete on
// exactly the same tokens as method_declarator, a reduce-reduce tie; these shapes deliberately can't.
const field_shapes: Rules<unknown> = [];
for (const lead of [[], [pointer], ['&']] as unknown[][]) {
	for (const arr of [false, true]) {
		const decor = (name: string, $: any[]): any => {
			let d: any = { type: 'identifier', name };
			if (arr)
				d = { type: 'array', element: d, size: $[lead.length + 2] };
			if (lead.length)
				d = lead[0] === '&' ? { type: 'reference', to: d } : { type: 'pointer', pointer: $[0] as Pointer, to: d };
			return d;
		};
		const shape: unknown[] = [...lead, IDENT, ...(arr ? ['[', constant_expression, ']'] : [])];
		field_shapes.push(
			Rule([...shape] as any,										($: any[]) => ({ declarator: decor($[lead.length], $) })),
			Rule([...shape, '=', assignment_expression] as any,			($: any[]) => ({ declarator: decor($[lead.length], $), initializer: $[$.length - 1] })),
		);
	}
}
// C's own `[IDENT]` alternative is subsumed by the plain shape above (which also carries the NSDMI
// variant); the bitfield alternatives stay.
removeRules(struct_declarator as unknown[], rhs => rhs.length === 1 && rhs[0] === IDENT);
(struct_declarator as unknown as Rules<unknown>).push(...field_shapes);

// `struct_declaration` is C's "one member declaration" production -- widening it here is what lets class
// bodies mix plain fields (already handled by c-parser.ts's own rule) with everything else.
const structDeclarationCast = struct_declaration as unknown as Rules<StructMember | ClassMember>;
structDeclarationCast.push(
	Rule([termOneOf(['public', 'private', 'protected'] as const), ':'] as const,	$ => ({ type: 'access_label', access: $[0] } as const)),

	// Methods: plain and modifier-prefixed. All the const/noexcept/override/final/=default/... variation
	// lives in method_tail.
	Rule([specifier_qualifier_list, method_signature, method_tail] as const,				$ => ({ type: 'method', specifiers: $[0], declarator: $[1] as Declarator, ...$[2] } as const)),
	Rule([member_mods, specifier_qualifier_list, method_signature, method_tail] as const,	$ => ({ type: 'method', specifiers: $[1], declarator: $[2] as Declarator, ...$[3], modifiers: $[0] } as const)),

	// Operators and conversion operators.
	Rule([specifier_qualifier_list, operator_signature, method_tail] as const,				$ => ({ type: 'method', specifiers: $[0], declarator: { type: 'function', name: { type: 'identifier', name: 'operator' + $[1].name }, parameters: $[1].parameters }, ...$[2] } as const)),
	Rule([member_mods, specifier_qualifier_list, operator_signature, method_tail] as const,	$ => ({ type: 'method', specifiers: $[1], declarator: { type: 'function', name: { type: 'identifier', name: 'operator' + $[2].name }, parameters: $[2].parameters }, ...$[3], modifiers: $[0] } as const)),
	Rule(['operator', specifier_qualifier_list, '(', ')', method_tail] as const,				$ => ({ type: 'conversion', target: { specifiers: $[1] } as TypeName, ...$[4] } as const)),
	Rule(['operator', specifier_qualifier_list, pointer, '(', ')', method_tail] as const,	$ => ({ type: 'conversion', target: { specifiers: $[1], declarator: { type: 'pointer', pointer: $[2] } } as TypeName, ...$[5] } as const)),

	// Constructors: plain and modifier-prefixed (`explicit`, `constexpr`, ...). The name is spelled as a
	// raw TYPE_NAME (the class's own name is always registered by its head, so that's what the lexer
	// hands back), NOT as type_ident: keeping the name-then-'(' inside a single multi-symbol rule makes
	// this an ordinary shift/reduce choice ('(' next -> shift, keep building a constructor; an IDENT or
	// anything else next -> reduce the TYPE_NAME as the member's *type* instead). Routed through
	// type_ident it becomes a reduce-reduce tie between type_ident and type_specifier over the same
	// completed TYPE_NAME -- one whose earlier-rule-wins resolution silently flips with rule traversal
	// order (it did: `Foo f;` members broke while the ctor kept working).
	Rule([TYPE_NAME, '(', ')', ctor_tail] as const,												$ => ({ type: 'constructor', name: $[0], parameters: [], ...$[3] } as const)),
	Rule([TYPE_NAME, '(', parameter_type_list, ')', ctor_tail] as const,						$ => ({ type: 'constructor', name: $[0], parameters: $[2] as ParamOrVariadic[], ...$[4] } as const)),
	Rule([member_mods, TYPE_NAME, '(', ')', ctor_tail] as const,								$ => ({ type: 'constructor', name: $[1], parameters: [], ...$[4], modifiers: $[0] } as const)),
	Rule([member_mods, TYPE_NAME, '(', parameter_type_list, ')', ctor_tail] as const,			$ => ({ type: 'constructor', name: $[1], parameters: $[3] as ParamOrVariadic[], ...$[5], modifiers: $[0] } as const)),

	// Destructors (method_tail permissively allows a few things a destructor can't really have -- `const`
	// -- which is fine for a parser that doesn't validate).
	Rule(['~', type_ident, '(', ')', method_tail] as const,				$ => ({ type: 'destructor', name: $[1], ...$[4] } as const)),
	Rule(['virtual', '~', type_ident, '(', ')', method_tail] as const,	$ => ({ type: 'destructor', name: $[2], ...$[5], modifiers: ['virtual'] } as const)),

	// Modifier-prefixed data members (`static const int x = 5;`, `mutable int cache;`); initializers come
	// via the widened struct_declarator shapes.
	Rule([member_mods, specifier_qualifier_list, struct_declarator_list, ';'] as const,	$ => ({ type: 'struct_member', typeSpecifiers: $[1], declarators: $[2], modifiers: $[0] } as const)),
	// `friend class Foo;` and similar -- a specifier with no declarators at all.
	Rule([member_mods, specifier_qualifier_list, ';'] as const,							$ => ({ type: 'struct_member', typeSpecifiers: $[1], declarators: [], modifiers: $[0] } as const)),
	// Nested type definitions as members (`class Inner {...};`, `enum class E {...};`) -- also a
	// declarator-less specifier, just without a leading modifier.
	Rule([specifier_qualifier_list, ';'] as const,										$ => ({ type: 'struct_member', typeSpecifiers: $[0], declarators: [] } as const)),

	Rule(['using', using_path, ';'] as const,	$ => ({ type: 'using_decl', scope: $[1].slice(0, -1), name: $[1][$[1].length - 1] } as const)),
	Rule([using_alias] as const,				$ => $[0]),
);

// ===================================================================
//  Namespaces / using / linkage
// ===================================================================

const externalDefinitionCast = external_definition as unknown as Rules<CppDefinition>;

// Registering the namespace name is what turns `math::square(2)` (or `std::vector`, if `std` is seeded)
// into TYPE_SCOPE-rooted qualified names.
const namespace_head = Rules<string>(
	Rule(['namespace', IDENT] as const,		($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return $[1]; }),
	Rule(['namespace', TYPE_NAME] as const,	$ => $[1]),
);

const namespace_body = List(externalDefinitionCast);
const namespace_decl = Rules<NamespaceDecl>(
	Rule([namespace_head, '{', '}'] as const,					$ => ({ type: 'namespace', name: $[0], definitions: [] } as const)),
	Rule([namespace_head, '{', namespace_body, '}'] as const,	$ => ({ type: 'namespace', name: $[0], definitions: $[2] } as const)),
	Rule(['namespace', '{', '}'] as const,						() => ({ type: 'namespace', definitions: [] } as const)),
	Rule(['namespace', '{', namespace_body, '}'] as const,		$ => ({ type: 'namespace', definitions: $[2] } as const)),
	Rule(['inline', namespace_head, '{', namespace_body, '}'] as const, $ => ({ type: 'namespace', name: $[1], inline: true, definitions: $[3] } as const)),
	Rule(['inline', namespace_head, '{', '}'] as const,			$ => ({ type: 'namespace', name: $[1], inline: true, definitions: [] } as const)),
);

const using_directive = Rules<UsingDirective>(
	Rule(['using', 'namespace', type_ident, ';'] as const, $ => ({ type: 'using_namespace', name: $[2] } as const)),
);
const using_decl_top = Rules<UsingDeclMember>(
	Rule(['using', using_path, ';'] as const, $ => ({ type: 'using_decl', scope: $[1].slice(0, -1), name: $[1][$[1].length - 1] } as const)),
);

// `extern "C"` -- the STRING_LITERAL lookahead is what keeps this from ever competing with plain
// `extern` as a storage class (a string can't start a specifier list).
const linkage_spec = Rules<LinkageSpec>(
	Rule(['extern', STRING_LITERAL, '{', namespace_body, '}'] as const,	$ => ({ type: 'linkage', language: $[1], definitions: $[3] } as const)),
	Rule(['extern', STRING_LITERAL, '{', '}'] as const,					$ => ({ type: 'linkage', language: $[1], definitions: [] } as const)),
	Rule(['extern', STRING_LITERAL, external_definition] as const,		$ => ({ type: 'linkage', language: $[1], definitions: [$[2]] } as const)),
);

externalDefinitionCast.push(
	Rule([namespace_decl] as const,		$ => $[0]),
	Rule([using_directive] as const,	$ => $[0]),
	Rule([using_decl_top] as const,		$ => $[0]),
	Rule([using_alias] as const,		$ => $[0]),
	Rule([linkage_spec] as const,		$ => $[0]),
	Rule([static_assert_decl] as const,	$ => $[0]),
);

// ===================================================================
//  Out-of-class member definitions
// ===================================================================
//
// `T Foo::method() {...}` -- possible at all only because of TYPE_SCOPE: `Foo` here lexes as TYPE_SCOPE
// (it's registered and `::` follows), so it can never be absorbed as a *second* type specifier into the
// preceding specifier list, which is what would happen (shift always beats the needed reduce) if the
// qualifier were spelled TYPE_NAME. The ctor form needs no return type and identifies itself purely
// lexically: `Foo::Foo(` has TYPE_NAME after the `::` (registered, not followed by `::`), while a method
// name is a plain IDENT.

externalDefinitionCast.push(
	Rule([declaration_specifiers, scope_prefix, IDENT, '(', ')', method_tail] as const,
		$ => ({ type: 'method_def', specifiers: $[0], scope: $[1], name: $[2], parameters: [], tail: $[5] } as const)),
	Rule([declaration_specifiers, scope_prefix, IDENT, '(', parameter_type_list, ')', method_tail] as const,
		$ => ({ type: 'method_def', specifiers: $[0], scope: $[1], name: $[2], parameters: $[4] as ParamOrVariadic[], tail: $[6] } as const)),
	Rule([scope_prefix, TYPE_NAME, '(', ')', ctor_tail] as const,
		$ => ({ type: 'constructor_def', scope: $[0], name: $[1], parameters: [], tail: $[4] } as const)),
	Rule([scope_prefix, TYPE_NAME, '(', parameter_type_list, ')', ctor_tail] as const,
		$ => ({ type: 'constructor_def', scope: $[0], name: $[1], parameters: $[3] as ParamOrVariadic[], tail: $[5] } as const)),
	Rule([scope_prefix, '~', type_ident, '(', ')', method_tail] as const,
		$ => ({ type: 'destructor_def', scope: $[0], name: $[2], tail: $[5] } as const)),
	Rule([declaration_specifiers, scope_prefix, operator_signature, method_tail] as const,
		$ => ({ type: 'operator_def', specifiers: $[0], scope: $[1], operator: $[2].name, parameters: $[2].parameters, tail: $[3] } as const)),
	// Free (non-member) operator functions.
	Rule([declaration_specifiers, operator_signature, method_tail] as const,
		$ => ({ type: 'operator_def', specifiers: $[0], operator: $[1].name, parameters: $[1].parameters, tail: $[2] } as const)),
	// Out-of-class static data member definitions (`int C::count = 0;`).
	Rule([declaration_specifiers, scope_prefix, IDENT, '=', assignment_expression, ';'] as const,
		$ => ({ type: 'static_member_def', specifiers: $[0], scope: $[1], name: $[2], initializer: $[4] } as const)),
	Rule([declaration_specifiers, scope_prefix, IDENT, ';'] as const,
		$ => ({ type: 'static_member_def', specifiers: $[0], scope: $[1], name: $[2] } as const)),
);

// Trailing return types on ordinary functions (`auto f(int) -> int {...}`). The `->` can only be
// this rule here: nothing else follows a completed declarator with `->`.
(function_definition as unknown as Rules<unknown>).push(
	Rule([declaration_specifiers, declarator, '->', type_name, compound_statement] as const,
		$ => ({ type: 'function_def', specifiers: $[0], declarator: $[1] as Declarator, returnType: $[3] as TypeName, body: $[4] as Block } as const)),
);

// ===================================================================
//  Templates
// ===================================================================

// Registering each parameter as a recognized type name the moment it's parsed (not scoped to just this
// declaration -- see header comment) is what lets `T` be used as an ordinary type inside the templated
// body. The TYPE_NAME alternatives exist because a name re-used across two separate templates is already
// a registered type name by the time the second one is parsed.
const builtin_type_list = List(Rules<string>(Rule([termOneOf(BUILTIN_TYPE)] as const, $ => $[0])));
const nontype_param_type = Rules<DeclarationSpecifiers>(
	Rule([builtin_type_list] as const,	$ => $[0].map(name => ({ type: 'type', name } as const))),
	Rule([CPP_SIMPLE_TYPE] as const,	$ => [{ type: 'type', name: $[0] } as const]),
	Rule([TYPE_NAME] as const,			$ => [{ type: 'type', name: $[0] } as const]),
);

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
	// Default type arguments (`template<class T = int>`).
	Rule(['typename', IDENT, '=', type_name] as const,	($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return { name: $[1], default: $[3] as TypeName }; }),
	Rule(['class', IDENT, '=', type_name] as const,		($, ctx: Ctx) => { ctx.typedefNames.add($[1]); return { name: $[1], default: $[3] as TypeName }; }),
	Rule(['typename', TYPE_NAME, '=', type_name] as const,	$ => ({ name: $[1], default: $[3] as TypeName } as const)),
	Rule(['class', TYPE_NAME, '=', type_name] as const,	$ => ({ name: $[1], default: $[3] as TypeName } as const)),
	// Non-type parameters (`template<int N>`, `template<int N = 4>`). The name is a *value*, not a type,
	// so it deliberately isn't registered. The type is a restricted `nontype_param_type`, NOT the full
	// specifier_qualifier_list: pulling spec_qual in here also pulls in struct_or_union_specifier, whose
	// class_head items then share the post-`class IDENT` state with template_param's own `class T` rule
	// -- a reduce-reduce tie on `>`/`,` that broke every plain `template<class T> class ...` (non-type
	// parameters are integral/enum-ish in real C++ anyway, so nothing of value is lost).
	Rule([nontype_param_type, IDENT] as const,		$ => ({ name: $[1], nonType: $[0] } as const)),
	Rule([nontype_param_type, IDENT, '=', assignment_expression] as const,	$ => ({ name: $[1], nonType: $[0], default: $[3] } as const)),
);
const template_param_list = List(template_param, ',');

// `template <...>` heads, shared by every templated form. The empty variant is explicit specialization.
const template_head = Rules<TemplateParam[]>(
	Rule(['template', '<', template_param_list, '>'] as const,	$ => $[2]),
	Rule(['template', '<', '>'] as const,						() => []),
);

externalDefinitionCast.push(
	Rule([template_head, struct_or_union_specifier, ';'] as const,
		$ => ({ type: 'template', params: $[0], declaration: $[1] as unknown as ClassSpecifier } as const)),
	Rule([template_head, function_definition] as const,
		$ => ({ type: 'template', params: $[0], declaration: $[1] as unknown as Definition } as const)),
	// C++14 variable templates (`template<class T> constexpr T pi = T(3.14159);`) -- and, since
	// `declaration` is general, templated typedefs and function *declarations* too.
	Rule([template_head, declaration] as const,
		$ => ({ type: 'template', params: $[0], declaration: $[1] as Definition } as const)),
	// Alias templates (`template<class T> using Vec = vector<T>;`).
	Rule([template_head, using_alias] as const,
		$ => ({ type: 'template', params: $[0], declaration: $[1] } as unknown as TemplateDecl)),
);

// Member templates (`template<class U> void set(U x) {...}` inside a class body).
structDeclarationCast.push(
	Rule([template_head, specifier_qualifier_list, method_signature, method_tail] as const,
		$ => ({ type: 'member_template', params: $[0], declaration: { type: 'method', specifiers: $[1], declarator: $[2] as Declarator, ...$[3] } } as const)),
);

// ===================================================================
//  Statements: try/catch/throw, range-for, braced init, using
// ===================================================================

const catch_clause = Rules<CatchClause>(
	Rule(['catch', '(', specifier_qualifier_list, IDENT, ')', compound_statement] as const,			$ => ({ paramType: { specifiers: $[2] } as TypeName, paramName: $[3], body: $[5] as Block } as const)),
	Rule(['catch', '(', specifier_qualifier_list, '&', IDENT, ')', compound_statement] as const,		$ => ({ paramType: { specifiers: $[2] } as TypeName, paramName: $[4], byRef: true, body: $[6] as Block } as const)),
	Rule(['catch', '(', specifier_qualifier_list, '&&', IDENT, ')', compound_statement] as const,	$ => ({ paramType: { specifiers: $[2] } as TypeName, paramName: $[4], byRef: true, body: $[6] as Block } as const)),
	Rule(['catch', '(', specifier_qualifier_list, ')', compound_statement] as const,					$ => ({ paramType: { specifiers: $[2] } as TypeName, body: $[4] as Block } as const)),
	Rule(['catch', '(', specifier_qualifier_list, '&', ')', compound_statement] as const,			$ => ({ paramType: { specifiers: $[2] } as TypeName, byRef: true, body: $[5] as Block } as const)),
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
	Rule([using_alias] as const,		$ => $[0] as CppStatement),
	Rule([static_assert_decl] as const,	$ => $[0]),
	// Range-based for. The `:` never competes with the classic for-clauses: after the declarator, a
	// classic for's declaration is looking for `=`/`,`/`;`, none of which is `:`.
	Rule(['for', '(', declaration_specifiers, declarator, ':', expression, ')', statement] as const,
		$ => ({ type: 'range_for', specifiers: $[2], declarator: $[3] as Declarator, range: $[5], body: $[7] } as unknown as CppStatement)),
	// `return {...};` list-initialized returns.
	Rule(['return', '{', initializer_list, '}', ';'] as const,
		$ => ({ type: 'return', expression: { type: 'initializer_list', elements: $[2] } as unknown as Expr } as const)),
);

// Braced direct-init in declarations (`T x{1, 2};`, `vector<int> v{1, 2, 3};`). Non-empty lists only:
// an empty `{}` would complete on exactly the same tokens as an empty function *body*, a reduce-reduce
// tie against C's compound_statement (`int f() {}` must keep parsing as a function definition).
(init_declarator as unknown as Rules<unknown>).push(
	Rule([declarator, '{', initializer_list, '}'] as const,
		$ => ({ declarator: $[0], initializer: { type: 'initializer_list', elements: $[2] } as Initializer })),
);

// ===================================================================
//  Wire it up
// ===================================================================
//
// The right-shift operator `>>` (and `>>=`) needs a *context-sensitive* lexer hook -- when
// `ctx.templateDepth > 0`, reject the 2-/3-char match so the lexer falls back to a plain
// single-char `>` instead, closing one generic-type-argument level at a time. That's exactly what lets
// `vector<vector<int>>` lex its trailing `>>` as two `>` tokens (closing the inner level, then the outer
// one) instead of one right-shift token -- the same problem real C++ had until C++11 standardized this
// splitting behavior.
//
// These have to be named exactly `>>`/`>>=`: c-parser.ts's own right-shift/compound-assignment rules
// reference them as bare string literals (`Rule([self, '>>', self], ...)` in assignment_expression, and
// similarly for '>>='), and terminal interning is by name -- passing these through `terminals` below
// registers them *before* rule traversal reaches those bare strings, so the bare-string references
// resolve to these same callback-bearing objects instead of creating fresh, hook-less ones.
const RIGHT_SHIFT			= terminal('>>',  />>/,	(_, ctx: CppCtx) => ctx.templateDepth > 0 ? undefined : RIGHT_SHIFT);
const RIGHT_SHIFT_ASSIGN	= terminal('>>=', />>=/,	(_, ctx: CppCtx) => ctx.templateDepth > 0 ? undefined : RIGHT_SHIFT_ASSIGN);

const cppParserSpec = makeParser({
	// On top of C's whitespace/preprocessor/comment skips: attributes (`[[nodiscard]]`) and
	// `alignas(...)` are recognized and *discarded* at the lexer level -- valid C++14 input parses, but
	// they leave no trace in the AST.
	skip: [/\s+/, /#[^\n]*/, /\/\/[^\n]*/, /\/\*[^]*?\*\//, /\[\[[^]*?\]\]/, /alignas\s*\([^()]*\)/],
	// IDENT has to be lexed even where only TYPE_NAME/TYPE_SCOPE are grammatically valid (see
	// c-parser.ts's own `terminals: [IDENT]`) -- it's the only terminal whose pattern matches the text,
	// and its callback is what reclassifies registered names.
	terminals: [IDENT, TYPE_SCOPE, RIGHT_SHIFT, RIGHT_SHIFT_ASSIGN],
	precedence: PREC,
	start: translation_unit,
	rules: { translation_unit },
});

export const cppParser = {
	...cppParserSpec,
	// `knownTypes` seeds the registered-name table, standing in for everything #include would have
	// declared -- e.g. ['std', 'string', 'exception'] makes `std::vector<int>`, `std::string s;` and
	// `catch (const exception& e)` parse. Namespace prefixes only need the namespace itself seeded.
	parse: (code: string, knownTypes?: Iterable<string>): CppProgram => {
		return cppParserSpec.parse(code, {
			pendingTypedef: false,
			typedefNames: new Set<string>(knownTypes),
			templateDepth: 0,
		} as CppCtx) as CppProgram;
	},
};
