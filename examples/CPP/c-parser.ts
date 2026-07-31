import { makeParser, makeRule, Rules, terminal, OneOf, List, Forward, WithPrec } from '../../src/tison';
import { preprocess, PreprocessOptions } from './preprocessor';
import { Literal, Identifier, Unary, UnaryPost, Binary } from '../common';

// ===================================================================
//  C Parser Grammar using tison
// ===================================================================

// --- Terminals (RegExps are auto-named by source text) ---

export interface Ctx {
	// Classic C lexer hack: resolves typedef-name ambiguity (`foo * bar;` -- decl or multiply?) via this
	// symbol table of names seen in `typedef` declarations so far.
	typedefNames:	Set<string>;
	// Set the moment declaration_specifiers reduces, before declarator names parse -- registering later is too late:
	// LALR has already peeked past the `;` to decide that reduce, the very token needing reclassification.
	pendingTypedef: boolean;
}


export const TYPE_NAME		= terminal('TYPE_NAME');
export const IDENT			= terminal('identifier', /[a-zA-Z_][a-zA-Z0-9_]*/, ({match: text}, ctx: Ctx ) => ctx.typedefNames.has(text) ? TYPE_NAME : IDENT);

export const INT_LITERAL 	= /[0-9]+(?:[uU]|[lL]|[uU][lL]|[lL][uU])?/;
export const FLOAT_LITERAL 	= /[0-9]+\.[0-9]*(?:[eE][-+]?[0-9]+)?[fFlL]?/;
export const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/;
export const CHAR_LITERAL 	= /'(?:[^'\\]|\\.)*'/;

export const BUILTIN_TYPE	= ['int', 'float', 'double', 'void', 'char', 'short', 'long', 'signed', 'unsigned'] as const;

// --- Precedence Levels (lowest to highest) ---
export const PREC = {
	comma:			{assoc: 'left'},
	assignment:		{assoc: 'right'},
	conditional:	{assoc: 'right'},
	logicalOr:		{assoc: 'left'},
	logicalAnd:		{assoc: 'left'},
	bitwiseOr:		{assoc: 'left'},
	bitwiseXor:		{assoc: 'left'},
	bitwiseAnd:		{assoc: 'left'},
	equality:		{assoc: 'left'},
	relational:		{assoc: 'left'},
	shift:			{assoc: 'left'},
	additive:		{assoc: 'left'},
	multiplicative:	{assoc: 'left'},
	cast:			{assoc: 'right'},
	unary:			{assoc: 'right'},
} as const;

// ===================================================================
//  AST Types -- one per non-terminal group (or shared where alts agree)
// ===================================================================
export type unaryOps	= '++'|'--'|'+'|'-'|'~'|'!'|'&'|'*'|'sizeof';
export type binaryOps	= ','|'+'|'-'|'*'|'/'|'%'|'**'|'&'|'|'|'^'|'<<'|'>>'|'>>'
						| '&&'|'||'
						|'<'|'>'|'<='|'>='|'=='|'!='
						|'='|'+='|'-='|'*='|'/='|'%='|'&='|'|='|'^='|'<<='|'>>='
						|'&&='|'||='

export type TypeQualifier	= 'const' | 'volatile';
// `typedef` is recognized by the same terminal as these (see `storage_class_specifier`), but it isn't a storage
// class at all -- it changes what KIND of declaration this is (a type alias, not a variable/function), so it's
// promoted to its own `TypedefDecl` node (see `declaration`'s action) rather than living here.
export type StorageClass	= 'extern' | 'static' | 'auto' | 'register';

export interface RefType			{ type: 'ref'; name: string; }
export function  RefType(name: string): RefType { return { type: 'ref', name }; }

// `X`: the type-specifier extension seam -- defaults to `never` (plain C), cpp instantiates it with
// `ClassSpecifier | CppEnumSpecifier | GenericType | QualifiedType | DecltypeSpecifier` so those flow through
// every `specifiers.type` position without a cast, the same way js-parser.ts's `Expr<T>`/`Param<T>` let
// ts-parser.ts plug in its own `Type`.
export type TypeSpecifier<X = never>	= RefType | StructSpecifier | EnumSpecifier | X;
// Multiple builtin keywords (`unsigned long long int`) spell ONE type, not several -- merged into a single
// RefType with a combined name (see `combineTypeSpecifier`) rather than collected as separate array entries.
export interface DeclSpec<X = never>	{ type: TypeSpecifier<X>; const?: boolean; volatile?: boolean; }
export interface DeclarationSpec<X = never> extends DeclSpec<X> { storageClass?: StorageClass[]; }

// A struct/enum specifier, or a named-type reference, can't combine with anything else in valid C, so it's just
// kept (permissively overwriting on conflict -- this parser doesn't validate). Two builtin-keyword RefTypes
// concatenate into one, since that's genuinely one type spelled with multiple words.
export function combineTypeSpecifier<X>(prev: TypeSpecifier<X>, next: TypeSpecifier<X>): TypeSpecifier<X> {
	return (prev as RefType).type === 'ref' && (next as RefType).type === 'ref' ? RefType(`${(prev as RefType).name} ${(next as RefType).name}`) : next;
}

export interface StructDeclarator	{ name?: string; type?: 'bitfield'; width?: Expr; }
export interface StructMember<D = StructDeclarator, X = never>		{ type: 'struct_member'; specifiers: DeclSpec<X>; declarators: D[]; }
export function StructMember<D, X = never> (specifiers: DeclSpec<X>, declarators: D[]): StructMember<D, X> { return { type: 'struct_member', specifiers, declarators}; }
// `body` is absent for a tag-only reference (`struct Point p;`, naming a struct/union defined elsewhere) -- present (even if empty) for a definition (`struct Point { ... } p;`).
export interface StructSpecifier	{ type: 'struct' | 'union'; name?: string; body?: StructMember[]; }

export interface Enumerator			{ name: string; init?: Expr; }
// Same tag-only-vs-definition distinction as StructSpecifier above.
export interface EnumSpecifier		{ type: 'enum'; name?: string; members?: Enumerator[]; }

export interface Declaration<D = Declarator, X = never>		{ type: 'declaration'; specifiers: DeclarationSpec<X>; initDeclarators?: InitDeclarator<D>[]; }
// `typedef int foo, *foo_ptr;` -- a distinct declaration kind (declares type aliases, not variables), not a
// `Declaration` tagged with a `typedef` storage class. `declarators` reuses `InitDeclarator` (rather than a
// bare `Declarator[]`) purely to share `init_declarator_list`'s grammar production; typedefs never actually
// carry an initializer.
export interface TypedefDecl<D = Declarator, X = never>		{ type: 'typedef'; specifiers: DeclSpec<X>; declarators: InitDeclarator<D>[]; }

// One qualifier set per `*`, outermost (leftmost in source) first -- `int * const * volatile p` is
// `[['const'], ['volatile']]` (the outer pointer is `const`, the inner one `volatile`).
export type Levels					= TypeQualifier[][];
export interface Pointer<T>			{ type: 'pointer'; qualifiers?: TypeQualifier[]; to: T }
// One node per `*`, matching how ArrayDecl/FunctionDecl each nest one level per node. Builds innermost-out
// (last element of `levels` wraps `to` directly, first element ends up outermost). The intermediate wraps
// are genuinely `Pointer<T>` again (T's own recursive union already allows that); TS just can't express
// "wrapped levels.length times" for a runtime-dynamic count, hence the single cast at the end.
export function  Pointer<T>(levels: Levels, to: T): Pointer<T> {
	let result: unknown = to;
	for (let i = levels.length; i-- > 0;) {
		const qualifiers = levels[i];
		result = { type: 'pointer', qualifiers: qualifiers.length ? qualifiers : undefined, to: result };
	}
	return result as Pointer<T>;
}

// `size` uses the plain (never-extended) TypeSpecifier even under cpp -- the `[type_specifier]` array-size
// form this covers is an obscure, barely-exercised grammar path (see direct_abstract_declarator), not worth
// threading the `X` seam through the whole declarator system for.
export interface ArrayDecl<T>		{ type: 'array'; element: T; size?: TypeSpecifier | Expr };
export function  ArrayDecl<T>(element: T, size?: TypeSpecifier | Expr): ArrayDecl<T>	{ return { type: 'array', element, size }; };

// `P`: the parameter-shape extension seam -- defaults to `ParameterDecl` (plain C), cpp instantiates it with
// its own `ParameterDecl | PackParameter` union so default-valued and variadic-pack parameters flow through
// a function declarator's own `params` without a cast.
export interface FunctionDecl<T, P = ParameterDecl> extends ParamList<P> { type: 'function'; name: T; }
export function  FunctionDecl<T, P = ParameterDecl>(name: T, params: P[], variadic?: boolean): FunctionDecl<T, P> { return { type: 'function', name, params, variadic}; }

// `R`: the declarator-shape extension seam -- defaults to `never` (plain C), cpp instantiates it with
// `Reference | RvalueReference` so `int &x`/`int &&x` flow through every declarator position without a cast
// (mirrors js-parser.ts's `Expr<T>` pattern: the recursive positions re-supply the same `<R, P>` pair, and `R`
// itself is a plain union member alongside the built-in wrapper shapes).
export type Declarator<R = never, P = ParameterDecl> =
	| Identifier
	| FunctionDecl<Declarator<R, P>, P>
	| ArrayDecl<Declarator<R, P>>		// `size` is absent for `int arr[]` (incomplete-array form, also used for unsized array parameters like `void f(int arr[])`).
	| Pointer<Declarator<R, P>>			// `to` lets a pointer wrap a parenthesized sub-declarator, which is what makes function-pointer declarators (`int (*fp)(int)`) expressible: the parens are what let a pointer bind to the *name*, not to the function type as a whole
	| R;

// An abstract declarator -- the same shapes as Declarator (pointer/array/function, plus grouping), but never bottoming out in a name:
// every level is optional since "nothing more" is itself a valid abstract declarator (e.g. plain `int *` has a pointer with no further `to`).
export type AbstractDeclarator<R = never, P = ParameterDecl> = undefined
	| Pointer<AbstractDeclarator<R, P> | undefined>
	| FunctionDecl<AbstractDeclarator<R, P> | undefined, P>
	| ArrayDecl<AbstractDeclarator<R, P> | undefined>
	| R;

// A type-name for casts/sizeof: specifiers plus an optional abstract declarator (pointers, arrays, functions, and combinations
// -- the same vocabulary as a real declarator, just never naming anything).
export interface TypeName<D = AbstractDeclarator, X = never>			{ specifiers: DeclSpec<X>; declarator?: D; }

// Initializers permissively allow a brace list anywhere an initializer can go (mirroring real C's `initializer-list`); designated initializers
// (`.field = x`, `[i] = x`) aren't supported -- a known simplification.
export type Initializer				= Expr | { type: 'initializer_list'; elements: Initializer[] };
export type InitDeclarator<D = Declarator>	= D | { declarator: D; initializer: Initializer };

// `Declarator`'s own default for `P` is (bare) `ParameterDecl`, so `ParameterDecl`'s default for `D` can't
// also be (bare) `Declarator` -- TS can't resolve two type-parameter defaults that each depend on the other's
// default. `PlainDeclarator` is a concrete (non-generic) recursive alias that breaks the cycle: it's
// structurally identical to `Declarator<never, ParameterDecl>` (same shape, same fixed point), just spelled
// via explicit type arguments instead of another default.
export type PlainDeclarator = Identifier | FunctionDecl<PlainDeclarator> | ArrayDecl<PlainDeclarator> | Pointer<PlainDeclarator>;

export interface ParameterDecl<D = PlainDeclarator, X = never>		{ type: 'parameter'; specifiers: DeclarationSpec<X>; declarator?: D; }
export function  ParameterDecl<D = PlainDeclarator, X = never>(specifiers: DeclarationSpec<X>, declarator?: D): ParameterDecl<D, X> { return {type: 'parameter', specifiers, declarator}; }
// The result shape of a parameter-type-list: a `...` trailing ellipsis is a boolean flag here rather than a
// sentinel mixed into the array, mirroring JS/TS's `Params<T> = {params, rest?}` split.
export interface ParamList<P = ParameterDecl>		{ params: P[]; variadic?: boolean; }

export interface FunctionDef<D = Declarator, X = never>		{ type: 'function_def'; specifiers: DeclarationSpec<X>; declarator: D; body: Block<D, X>; }
export type Definition<D = Declarator, X = never>				= Declaration<D, X> | TypedefDecl<D, X> | FunctionDef<D, X>;
export interface TranslationUnit<D = Declarator, X = never>	{ type: 'translation_unit'; body: Definition<D, X>[]; }

export interface Block<D = Declarator, X = never>				{ type: 'block'; body: Statement<D, X>[]; }
export interface ForClauses<D = Declarator, X = never>			{ init: Expr | Declaration<D, X> | TypedefDecl<D, X> | undefined; condition?: Expr; update?: Expr; }

export type Statement<D = Declarator, X = never> =
	| Block<D, X>
	| Declaration<D, X>
	| TypedefDecl<D, X>
	| { type: 'if'; condition: Expr; then: Statement<D, X>; else?: Statement<D, X> }
	| { type: 'while'; condition: Expr; body: Statement<D, X> }
	| { type: 'do_while'; body: Statement<D, X>; condition: Expr }
	| { type: 'for'; body: Statement<D, X> } & ForClauses<D, X>
	| { type: 'switch'; condition: Expr; body: Statement<D, X> }
	| { type: 'case'; value: Expr; body: Statement<D, X> }
	| { type: 'default'; body: Statement<D, X> }
	| { type: 'break' }
	| { type: 'continue' }
	| { type: 'return'; expression?: Expr }
	| { type: 'goto'; label: string }
	| { type: 'labeled'; label: string; body: Statement<D, X> }
	| { type: 'empty' }
	| Expr;

export type Expr =
	| Identifier
	| Literal<number|string>
	| { type: 'char_literal'; value: string }
	| Unary<Expr, unaryOps>
	| UnaryPost<Expr, unaryOps>
	| Binary<Expr, binaryOps>
	| { type: 'conditional'; test: Expr; consequent: Expr; alternate: Expr }
	| { type: 'subscript'; array: Expr; index: Expr }
	| { type: 'member_access'; object: Expr; member: string }
	| { type: 'pointer_member'; object: Expr; member: string }
	| { type: 'function_call'; function: Expr; arguments: Expr[] }
	| { type: 'cast'; type1: TypeName; expression: Expr }
	| { type: 'sizeof_type'; operand: TypeName };

/** The base identifier a declarator ultimately names, digging through function/array/pointer wrappers. */
export function declaratorName(d: Declarator): string {
	switch (d.type) {
		case 'identifier':	return d.name;
		case 'function':	return declaratorName(d.name);
		case 'array':		return declaratorName(d.element);
		case 'pointer':		return declaratorName(d.to);
	}
}

// --- Grammar Definition ---

const Rule = makeRule<Ctx>();

const ASSIGN_OP = OneOf(['+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '&&=', '||=', '=']);

// Declared bottom-up (leaf non-terminals first) so each rule can reference an already-declared group BY OBJECT (typed, no cast needed) instead of by name (untyped string, needs `as`).
// Every self-recursive rule, and exactly one edge per genuine cycle (chosen as whichever single rule sacrifices the fewest alternatives), necessarily stays a string -- see the comments below.

export const
fwd_type_name = Forward<TypeName>(()=>type_name),

// assignment_expression covers every precedence level except the comma operator -- kept separate from `expression` specifically so a comma here always means "next list item"
// (function arguments, declarator lists, initializers, ...) and never accidentally absorbs into a comma-expression; only the dedicated parenthesized-expression and subscript positions reach for full `expression` instead
assignment_expression = Rules<Expr>(self => [
	Forward<Expr>(()=>postfix_expression),
	WithPrec(Rule([OneOf(['+', '-', '!', '~', '*', '&', '++', '--']), self], 	$ => Unary('+', $[1])), PREC.unary),
	// 'sizeof' spelled standalone, NOT inside the OneOf group: the sizeof_type rule below also spells it
	// standalone, and a OneOf-vs-literal tie starves whichever loses (`sizeof(expr)` never parsed).
	WithPrec(Rule(['sizeof', self], 							$ => ({ type: 'unary',			operator: 'sizeof', operand: $[1] } as const)), 	PREC.unary),
	// 'type_name' stays a string: it's declared later (it needs specifier_qualifier_list, which itself needs constant_expression --
	// part of this same expression chain), the same kind of cycle the original cast rule already cut this way with 'type_specifier'.
	WithPrec(Rule(['sizeof', '(', fwd_type_name, ')'],			$ => ({ type: 'sizeof_type',	operand: $[2] } as const)), 			PREC.unary),
	WithPrec(Rule(['(', fwd_type_name, ')', self], 				$ => ({ type: 'cast',			type1: $[1], expression: $[3] })), 		PREC.cast),
	WithPrec(Rule([self, OneOf(['*','/','%']),  self], 			$ => Binary($[1],	$[0], $[2])), 		PREC.multiplicative),
	WithPrec(Rule([self, OneOf(['+', '-']),  self],				$ => Binary($[1],	$[0], $[2])), 		PREC.additive),
	WithPrec(Rule([self, OneOf(['<<', '>>']), self], 			$ => Binary($[1],	$[0], $[2])), 		PREC.shift),
	WithPrec(Rule([self, OneOf(['<','>','<=','>=']),  self], 	$ => Binary($[1],	$[0], $[2])), 		PREC.relational),
	WithPrec(Rule([self, OneOf(['==', '!=']), self], 			$ => Binary($[1],	$[0], $[2])), 		PREC.equality),
	WithPrec(Rule([self, '&',  self], 							$ => Binary('&',	$[0], $[2])), 		PREC.bitwiseAnd),
	WithPrec(Rule([self, '^',  self], 							$ => Binary('^',	$[0], $[2])), 		PREC.bitwiseXor),
	WithPrec(Rule([self, '|',  self], 							$ => Binary('|',	$[0], $[2])), 		PREC.bitwiseOr),
	WithPrec(Rule([self, '&&', self], 							$ => Binary('&&',	$[0], $[2])), 		PREC.logicalAnd),
	WithPrec(Rule([self, '||', self],							$ => Binary('||',	$[0], $[2])), 		PREC.logicalOr),
	WithPrec(Rule([self, '?', self, ':', self],					$ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] })), 	PREC.conditional),
	WithPrec(Rule([self, ASSIGN_OP,  self], 					$ => Binary($[1],	$[0], $[2])), 		PREC.assignment),
]),

// The comma operator's own level, kept out of assignment_expression -- this is what plain `expression` means in real C:
// parenthesized sub-expressions and array subscripts allow a comma operator, but argument lists, initializers, and declarator lists must not.
expression = Rules<Expr>(self => [
	assignment_expression,
	WithPrec(Rule([self, ',', assignment_expression], 			$ => Binary(',', $[0], $[2])), PREC.comma),
]),

argument_expression_list = List(assignment_expression, ','),

// === Constant Expression (for switch cases, array/bitfield sizes) ===
// Real C narrows this to conditional-expression (excludes both assignment and comma); using assignment_expression is a pragmatic middle ground
constant_expression = Rules(
	assignment_expression,
),

primary_expression = Rules(
	Rule([IDENT], 												$ => Identifier($[0])),
	Rule([INT_LITERAL],											$ => Literal(parseInt($[0], 10))),
	Rule([FLOAT_LITERAL], 										$ => Literal(parseFloat($[0]))),
	Rule([STRING_LITERAL], 										$ => Literal($[0])),
	Rule([CHAR_LITERAL], 										$ => ({ type: 'char_literal', value: $[0] } as const)),
	Rule(['(', expression, ')'], 								$ => $[1]),
),

postfix_expression = Rules<Expr>(self => [
	primary_expression,
	WithPrec(Rule([self, '++'],									$ => ({ type: 'unary_post', operator: $[1], operand: $[0] } as const)), PREC.unary),
	WithPrec(Rule([self, '--'],									$ => ({ type: 'unary_post',	operator: $[1], operand: $[0] } as const)), PREC.unary),
	Rule([self, '[', expression, ']'], 							$ => ({ type: 'subscript',	array: $[0], index: $[2] } as const)),
	Rule([self, '.', IDENT],									$ => ({ type: 'member_access',	object: $[0], member: $[2] } as const)),
	Rule([self, '->', IDENT], 									$ => ({ type: 'pointer_member', object: $[0], member: $[2] } as const)),
	Rule([self, '(', argument_expression_list, ')'],			$ => ({ type: 'function_call', function: $[0], arguments: $[2] } as const)),
]),

type_qualifier = OneOf(['const', 'volatile']),

struct_declarator = Rules<StructDeclarator>(
	Rule([IDENT], 												$ => ({ name: $[0] })),
	Rule([':', constant_expression], 							$ => ({ type: 'bitfield', width: $[1] })),
	Rule([IDENT, ':', constant_expression], 					$ => ({ name: $[0], type: 'bitfield', width: $[2] })),
),

struct_declarator_list = List(struct_declarator, ','),

// struct_declaration -> specifier_qualifier_list stays a string: cheapest cut in the type_specifier <-> struct/enum cycle (struct_declaration is specifier_qualifier_list's only consumer from this side).
struct_declaration = Rules(
	Rule([Forward<DeclSpec>(()=>specifier_qualifier_list), struct_declarator_list, ';'], $ => StructMember($[0], $[1])),
),

struct_declaration_list = List(struct_declaration),

struct_body = Rules(
	struct_declaration_list,
	Rule([';'], 												_ => []),
	Rule([struct_declaration_list, ';'],	 					$ => $[0]),
),

struct_or_union_specifier = Rules<StructSpecifier>(
	Rule(['struct', IDENT, '{', struct_body, '}'], 				$ => ({ type: 'struct', name: $[1], body: $[3] } as const)),
	Rule(['struct', '{', struct_body, '}'], 					$ => ({ type: 'struct', body: $[2] } as const)),
	Rule(['union', IDENT, '{', struct_body, '}'], 				$ => ({ type: 'union', name: $[1], body: $[3] } as const)),
	Rule(['union', '{', struct_body, '}'], 						$ => ({ type: 'union', body: $[2] } as const)),
	// Tag-only reference to a struct/union defined elsewhere -- distinguished from the definition forms above purely by whether '{' follows IDENT, an ordinary one-token-lookahead decision.
	Rule(['struct', IDENT], 									$ => ({ type: 'struct', name: $[1] as string } as const)),
	Rule(['union', IDENT], 										$ => ({ type: 'union', name: $[1] as string } as const)),
),

enumerator = Rules(
	Rule([IDENT, '=', constant_expression], 					$ => ({ name: $[0], init: $[2] })),
	Rule([IDENT], 												$ => ({ name: $[0] })),
	// TYPE_NAME variants: enumerator names may collide with registered type names (`enum { BASE, RUN }`
	// with a `BASE` class known from elsewhere).
	Rule([TYPE_NAME, '=', constant_expression], 				$ => ({ name: $[0], init: $[2] })),
	Rule([TYPE_NAME], 											$ => ({ name: $[0] })),
),

enumerator_list = List(enumerator, ','),

enum_specifier = Rules<EnumSpecifier>(
	Rule(['enum', IDENT, '{', enumerator_list, '}'], 			$ => ({ type: 'enum', name: $[1], members: $[3] } as const)),
	Rule(['enum', '{', enumerator_list, '}'], 					$ => ({ type: 'enum', members: $[2] } as const)),
	// C99 allows a trailing comma after the last enumerator.
	Rule(['enum', IDENT, '{', enumerator_list, ',', '}'], 		$ => ({ type: 'enum', name: $[1], members: $[3] } as const)),
	Rule(['enum', '{', enumerator_list, ',', '}'], 				$ => ({ type: 'enum', members: $[2] } as const)),
	// Tag-only reference, same as struct/union above.
	Rule(['enum', IDENT], 										$ => ({ type: 'enum', name: $[1] as string } as const)),
),

type_specifier = Rules<TypeSpecifier>(
	Rule([OneOf(BUILTIN_TYPE)],									$ => RefType($[0])),
	struct_or_union_specifier,
	enum_specifier,
	Rule([TYPE_NAME], 											$ => RefType($[0])),
),

specifier_qualifier_list = Rules<DeclSpec>(self => [
	Rule([type_specifier], 										$ => ({ type: $[0] })),
	Rule([self, type_specifier], 								$ => ({ ...$[0], type: combineTypeSpecifier($[0].type, $[1]) })),
	Rule([self, type_qualifier], 								$ => ({ ...$[0], [$[1]]: true })),
]),

// --- Declarators / declarations ---
storage_class_specifier = OneOf(['typedef', 'extern', 'static', 'auto', 'register']),

declaration_specifiers = Rules<DeclarationSpec>(
	Rule([specifier_qualifier_list], 							($, ctx) => { ctx.pendingTypedef = false; return { ...$[0] }; }),
	Rule([specifier_qualifier_list, storage_class_specifier], 	($, ctx) => {
		ctx.pendingTypedef = $[1] === 'typedef';
		return $[1] === 'typedef' ? { ...$[0] } : { ...$[0], storageClass: [$[1]] };
	}),
	Rule([storage_class_specifier, specifier_qualifier_list], 	($, ctx) => {
		ctx.pendingTypedef = $[0] === 'typedef';
		return $[0] === 'typedef' ? { ...$[1] } : { ...$[1], storageClass: [$[0]] };
	}),
),

pointer = Rules<Levels>(self => [
	Rule(['*'], 												_ => [[]]),
	Rule(['*', type_qualifier], 								$ => [[$[1]]]),
	Rule(['*', self],											$ => [[], ...$[1]]),
	Rule(['*', type_qualifier, self], 							$ => [[$[1]], ...$[2]]),
]),
fwd_parameter_type_list = Forward<ParamList>(() => parameter_type_list),
// Mirrors declarator but for abstract (nameless) declarators -- `*`, `[5]`, `(int)`, `(*)(int)`, etc.
// `'(' ')'` never conflicts with the grouping rule `'(' abstract_declarator ')'` since abstract_declarator can't derive empty.
direct_abstract_declarator = Rules<AbstractDeclarator>(self => [
	Rule(['(', Forward<AbstractDeclarator>(() => abstract_declarator), ')'], $ => $[1]),
	Rule(['(', ')'], 											_ => FunctionDecl(undefined, [])),
	Rule(['(', fwd_parameter_type_list, ')'], 					$ => FunctionDecl(undefined, $[1].params, $[1].variadic)),
	Rule([self, '(', ')'], 										$ => FunctionDecl($[0], [])),
	Rule([self, '(', fwd_parameter_type_list, ')'],				$ => FunctionDecl($[0], $[2].params, $[2].variadic)),
	Rule(['[', ']'], 											_ => ArrayDecl(undefined)),
	Rule(['[', type_specifier, ']'], 							$ => ArrayDecl(undefined, $[1])),
	Rule(['[', constant_expression, ']'], 						$ => ArrayDecl(undefined, $[1])),
	Rule([self, '[', ']'], 										$ => ArrayDecl($[0])),
	Rule([self, '[', type_specifier, ']'], 						$ => ArrayDecl($[0], $[2])),
	Rule([self, '[', constant_expression, ']'],					$ => ArrayDecl($[0], $[2])),
]),
abstract_declarator = Rules<AbstractDeclarator>(
	Rule([pointer], 											$ => Pointer($[0], undefined)),
	direct_abstract_declarator,
	Rule([pointer, direct_abstract_declarator], 				$ => Pointer($[0], $[1])),
),

// A type-name for casts/sizeof: specifiers plus an optional abstract declarator -- pointers, arrays, functions, and combinations
type_name = Rules<TypeName>(
	Rule([specifier_qualifier_list], 							$ => ({ specifiers: $[0] } as const)),
	Rule([specifier_qualifier_list, abstract_declarator], 		$ => ({ specifiers: $[0], declarator: $[1] } as const)),
),

// direct_declarator -> parameter_type_list stays a string: cheapest cut in the direct_declarator/parameter_declaration
// cycle (a function declarator's own parameter list is the only edge crossing back into it).
direct_declarator = Rules<Declarator>(self => [
	Rule([IDENT],												$ => Identifier($[0])),
	// Grouping -- lets a pointer attach to a *name* rather than the surrounding function/array type, so `int (*fp)(int)`
	// parses as "fp is a pointer to a function", not "fp is a function returning a pointer".
	Rule(['(', Forward<Declarator>(()=>declarator), ')'], 		$ => $[1]),
	Rule([self, '(', ')'],										$ => FunctionDecl($[0], [])),
	Rule([self, '(', fwd_parameter_type_list, ')'],				$ => FunctionDecl($[0], $[2].params, $[2].variadic)),
	Rule([self, '[', type_specifier, ']'], 						$ => ArrayDecl($[0], $[2])),
	Rule([self, '[', constant_expression, ']'], 				$ => ArrayDecl($[0], $[2])),
	// Incomplete array form: `int arr[];`, also used for unsized array parameters (`void f(int arr[])`).
	Rule([self, '[', ']'], 										$ => ArrayDecl($[0])),
]),

// A leading pointer lives here (not just at init_declarator) so it composes with the grouping rule above for function
// pointers, and so parameter declarators -- which go through 'declarator' directly -- can have pointer types too.
declarator = Rules<Declarator>(
	direct_declarator,
	Rule([pointer, direct_declarator], 							$ => Pointer($[0], $[1])),
),

parameter_declaration = Rules(
	Rule([declaration_specifiers, declarator], 					$ => ParameterDecl($[0], $[1])),
	Rule([declaration_specifiers], 								$ => ParameterDecl($[0])),
),
parameter_list = List(parameter_declaration, ','),
parameter_type_list = Rules<ParamList>(
	Rule([parameter_list], 										$ => ({ params: $[0] })),
	Rule([parameter_list, ',', '...'], 							$ => ({ params: $[0], variadic: true })),
),

// initializer_list -> initializer stays a string: the cheapest cut in their mutual cycle (initializer's only consumer of initializer_list is its own brace-list case, vs. initializer_list needing initializer for every element)
initializer_list = List(Forward<Initializer>(() => initializer), ','),
initializer = Rules<Initializer>(
	assignment_expression,
	Rule(['{', '}'], 											_ => ({ type: 'initializer_list', elements: [] } as const)),
	Rule(['{', initializer_list, '}'], 							$ => ({ type: 'initializer_list', elements: $[1] } as const)),
	Rule(['{', initializer_list, ',', '}'], 					$ => ({ type: 'initializer_list', elements: $[1] } as const)),
),

// Pointers are now handled by 'declarator' itself (see above), so this simplifies to just the plain-or-initialized cases.
init_declarator = Rules<InitDeclarator>(
	Rule([declarator], 											($, ctx) => { const d = $[0]; if (ctx.pendingTypedef) ctx.typedefNames.add(declaratorName(d)); return d; }),
	Rule([declarator, '=', initializer], 						($, ctx) => { const d = $[0]; if (ctx.pendingTypedef) ctx.typedefNames.add(declaratorName(d)); return { declarator: d, initializer: $[2] }; }),
),
init_declarator_list = List(init_declarator, ','),

declaration = Rules<Declaration | TypedefDecl>(
	Rule([declaration_specifiers, ';'], 						($, ctx) => ctx.pendingTypedef
		? ({ type: 'typedef', specifiers: $[0], declarators: [] } as const)
		: ({ type: 'declaration', specifiers: $[0] } as const)),
	Rule([declaration_specifiers, init_declarator_list, ';'], 	($, ctx) => ctx.pendingTypedef
		? ({ type: 'typedef', specifiers: $[0], declarators: $[1] } as const)
		: ({ type: 'declaration', specifiers: $[0], initDeclarators: $[1] } as const)),
),

// --- Statements ---
// NOTE: 'declaration' already consumes its own trailing ';', so the declaration-based alternatives must not require a second one.
for_statement = Rules<ForClauses>(
	Rule([expression, ';'], 									$ => ({ init: $[0], condition: undefined, update: undefined })),
	Rule([expression, ';', expression], 						$ => ({ init: $[0], condition: $[2], update: undefined })),
	Rule([expression, ';', expression, ';', expression], 		$ => ({ init: $[0], condition: $[2], update: $[4] })),
	Rule([declaration, expression], 							$ => ({ init: $[0], condition: $[1], update: undefined })),
	Rule([declaration, expression, ';', expression], 			$ => ({ init: $[0], condition: $[1], update: $[3] })),
),

// statement -> compound_statement stays a string: cheapest cut in the statement <-> compound_statement <-> statement_list cycle
// (it's 1 of statement's 13 alternatives, vs. 2 uses on statement_list's side).
statement = Rules<Statement>(self => [
	Forward<Block>(()=>compound_statement),
	declaration,
	Rule(['if', '(', expression, ')', self], 					$ => ({ type: 'if', condition: $[2], then: $[4] })),
	Rule(['if', '(', expression, ')', self, 'else', self], 		$ => ({ type: 'if', condition: $[2], then: $[4], else: $[6] })),
	Rule(['while', '(', expression, ')', self], 				$ => ({ type: 'while', condition: $[2], body: $[4] })),
	Rule(['do', self, 'while', '(', expression, ')', ';'], 		$ => ({ type: 'do_while', body: $[1], condition: $[4] })),
	Rule(['for', '(', for_statement, ')', self], 				$ => ({ type: 'for', ...$[2], body: $[4] })),
	Rule(['switch', '(', expression, ')', self], 				$ => ({ type: 'switch', condition: $[2], body: $[4] })),
	Rule(['case', constant_expression, ':', self], 				$ => ({ type: 'case', value: $[1], body: $[3] })),
	Rule(['default', ':', self], 								$ => ({ type: 'default', body: $[2] })),
	Rule(['break', ';'], 										_ => ({ type: 'break' })),
	Rule(['continue', ';'], 									_ => ({ type: 'continue' })),
	Rule(['return', expression, ';'], 							$ => ({ type: 'return', expression: $[1] })),
	Rule(['return', ';'], 										_ => ({ type: 'return' })),
	Rule(['goto', IDENT, ';'], 									$ => ({ type: 'goto', label: $[1] })),
	Rule([IDENT, ':', self], 									$ => ({ type: 'labeled', label: $[0], body: $[2] })),
	Rule([';'],													_ => ({ type: 'empty' } as const)),
	Rule([expression, ';'], 									$ => $[0]),
]),

compound_statement = Rules<Block>(
	Rule(['{', List(statement), '}'], 							$ => ({ type: 'block', body: $[1] })),
	Rule(['{', '}'], 											_ => ({ type: 'block', body: [] })),
),

// --- Top level ---
function_definition = Rules(
	Rule([declaration_specifiers, declarator, compound_statement], $ => ({ type: 'function_def', specifiers: $[0], declarator: $[1], body: $[2] } as const)),
),

external_definition = Rules<Definition>(
	declaration,
	Rule([function_definition], 								$ => $[0]),
),

translation_unit = Rules<TranslationUnit>(self => [
	Rule([external_definition], 								$ => ({ type: 'translation_unit', body: [$[0]] })),
	Rule([self, external_definition], 							$ => ({ ...$[0], body: [...$[0].body, $[1]] })),
]);

const parser = makeParser({
	skip: [/\s+/, /\/\/[^\n]*/, /\/\*[^]*?\*\//],
	// IDENT must be lexed even where only TYPE_NAME is grammatically valid: it's the only terminal whose pattern
	// matches the text, and its callback is what reclassifies a known typedef name into the pattern-less TYPE_NAME.
	terminals: [IDENT],
	precedence: PREC,
	start: translation_unit,
	rules: {translation_unit}
});

export const cParser = {
	...parser,
	// source runs through the preprocessor first; `options` supplies -D defines and an #include resolver
	parse: async (code: string, options?: PreprocessOptions) => {
		return parser.parse(await preprocess(code, options), {
			pendingTypedef: false,
			typedefNames: new Set<string>(),
		});
	}
};
