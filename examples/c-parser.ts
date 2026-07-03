import { makeParser, Rule, Rules, RRules, terminal, termOneOf, List, Forward } from '../src/tison';

// ===================================================================
//  C Parser Grammar using tison
// ===================================================================

// --- Terminals (RegExps are auto-named by source text) ---

export interface Ctx {
	// IDENT is wrapped via terminal() (instead of a bare RegExp) so we can attach a `lex` hook to it:
	// the classic C "lexer hack" for resolving the typedef-name ambiguity (`foo * bar;` -- pointer declaration or multiply?)
	// by checking a symbol table of names seen in `typedef` declarations so far.
	typedefNames:	Set<string>;
	// Set by declaration_specifiers as soon as it's reduced (well before the declarator names are parsed), so init_declarator can register each name
	// immediately -- registering any later (e.g. once the whole `declaration` including its trailing ';' has reduced) is too late: by then the LALR
	// parser has already had to peek one token past the ';' to decide to reduce, and that's the very token that needed reclassifying.
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

export type TypeQualifier	= 'const' | 'volatile';
export type StorageClass	= 'typedef' | 'extern' | 'static' | 'auto' | 'register';

export interface PrimitiveType		{ type: 'type'; name: string; }
export interface StructMember		{ type: 'struct_member'; typeSpecifiers: DeclSpecItem[]; declarators: StructDeclarator[]; }
// `members` is absent for a tag-only reference (`struct Point p;`, naming a struct/union defined elsewhere) -- present (even if empty) for a definition (`struct Point { ... } p;`).
export interface StructSpecifier	{ type: 'struct' | 'union'; name?: string; members?: StructMember[]; }
export interface Enumerator			{ name: string; value?: Expr; }
// Same tag-only-vs-definition distinction as StructSpecifier above.
export interface EnumSpecifier		{ type: 'enum'; name?: string; enumerators?: Enumerator[]; }
export type TypeSpecifier			= PrimitiveType | StructSpecifier | EnumSpecifier;

export interface StructDeclarator	{ name?: string; type?: 'bitfield'; width?: Expr; }

export type DeclSpecItem			= TypeSpecifier | TypeQualifier;
export type DeclarationSpecifiers	= (DeclSpecItem | StorageClass)[];

export interface Declaration		{ type: 'declaration'; specifiers: DeclarationSpecifiers; initDeclarators?: InitDeclarator[]; }

export type Pointer					= { level: number }[];

export type Declarator =
	| { type: 'identifier'; name: string }
	| { type: 'function'; name: Declarator; parameters: ParamOrVariadic[] }
	// `size` is absent for `int arr[]` (incomplete-array form, also used for unsized array parameters like `void f(int arr[])`).
	| { type: 'array'; element: Declarator; size?: TypeSpecifier | Expr }
	// `to` lets a pointer wrap a parenthesized sub-declarator, which is what makes function-pointer declarators (`int (*fp)(int)`) expressible: the parens are what let a pointer bind to the *name*, not to the function type as a whole
	| { type: 'pointer'; pointer: Pointer; to: Declarator };

// An abstract declarator -- the same shapes as Declarator (pointer/array/function, plus grouping), but never bottoming out in a name:
// every level is optional since "nothing more" is itself a valid abstract declarator (e.g. plain `int *` has a pointer with no further `to`).
export type AbstractDeclarator =
	| { type: 'pointer'; pointer: Pointer; to?: AbstractDeclarator }
	| { type: 'function'; name?: AbstractDeclarator; parameters: ParamOrVariadic[] }
	| { type: 'array'; element?: AbstractDeclarator; size?: TypeSpecifier | Expr };

// A type-name for casts/sizeof: specifiers plus an optional abstract declarator (pointers, arrays, functions, and combinations
// -- the same vocabulary as a real declarator, just never naming anything).
export interface TypeName			{ specifiers: DeclSpecItem[]; declarator?: AbstractDeclarator; }

// Initializers permissively allow a brace list anywhere an initializer can go (mirroring real C's `initializer-list`); designated initializers
// (`.field = x`, `[i] = x`) aren't supported -- a known simplification.
export type Initializer			= Expr | { type: 'initializer_list'; elements: Initializer[] };
export type InitDeclarator			= Declarator | { declarator: Declarator; initializer: Initializer };

export interface ParameterDeclaration	{ type: 'parameter'; specifiers: DeclarationSpecifiers; declarator?: Declarator; }
export type ParamOrVariadic = ParameterDeclaration | { type: 'variadic' };

export interface FunctionDef		{ type: 'function_def'; specifiers: DeclarationSpecifiers; declarator: Declarator; body: Block; }
export type Definition				= Declaration | FunctionDef;
export interface TranslationUnit	{ type: 'translation_unit'; definitions: Definition[]; }

export interface Block				{ type: 'block'; statements: Statement[]; }
export interface ForClauses		{ init: Expr | Declaration; condition?: Expr; update?: Expr; }

export type Statement =
	| Block
	| Declaration
	| { type: 'if'; condition: Expr; then: Statement }
	| { type: 'if_else'; condition: Expr; then: Statement; else: Statement }
	| { type: 'while'; condition: Expr; body: Statement }
	| { type: 'do_while'; body: Statement; condition: Expr }
	| { type: 'for'; init: Expr | Declaration; condition?: Expr; update?: Expr; body: Statement }
	| { type: 'switch'; condition: Expr; body: Statement }
	| { type: 'case'; value: Expr; body: Statement }
	| { type: 'default'; body: Statement }
	| { type: 'break' }
	| { type: 'continue' }
	| { type: 'return'; expression?: Expr }
	| { type: 'goto'; label: string }
	| { type: 'labeled'; label: string; body: Statement }
	| { type: 'empty_statement' }
	| Expr;

export type Expr =
	| { type: 'identifier'; name: string }
	| { type: 'literal'; value: number }
	| { type: 'string_literal'; value: string }
	| { type: 'char_literal'; value: string }
	| { type: 'post_increment'; operand: Expr }
	| { type: 'post_decrement'; operand: Expr }
	| { type: 'subscript'; array: Expr; index: Expr }
	| { type: 'member_access'; object: Expr; member: string }
	| { type: 'pointer_member'; object: Expr; member: string }
	| { type: 'function_call'; function: Expr; arguments: Expr[] }
	| { type: 'unary_op'; operator: string; operand: Expr }
	| { type: 'dereference'; operand: Expr }
	| { type: 'address_of'; operand: Expr }
	| { type: 'pre_increment'; operand: Expr }
	| { type: 'pre_decrement'; operand: Expr }
	| { type: 'cast'; type1: TypeName; expression: Expr }
	| { type: 'binary_op'; operator: string; left: Expr; right: Expr }
	| { type: 'assign'; left: Expr; right: Expr; operator: string }
	| { type: 'conditional'; test: Expr; consequent: Expr; alternate: Expr }
	| { type: 'comma'; left: Expr; right: Expr }
	| { type: 'sizeof'; operand: Expr }
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
//
// Declared bottom-up (leaf non-terminals first) so each rule can reference an already-declared group BY OBJECT (typed, no cast needed) instead of by name (untyped string, needs `as`).
// Every self-recursive rule, and exactly one edge per genuine cycle (chosen as whichever single rule sacrifices the fewest alternatives), necessarily stays a string -- see the comments below.

export const
fwd_type_name = Forward<TypeName>(()=>type_name),

// assignment_expression covers every precedence level except the comma operator -- kept separate from `expression` specifically so a comma here always means "next list item"
// (function arguments, declarator lists, initializers, ...) and never accidentally absorbs into a comma-expression; only the dedicated parenthesized-expression and subscript positions reach for full `expression` instead
assignment_expression = RRules<Expr>(self => [
	Rule([Forward<Expr>(()=>postfix_expression)],		$ => $[0]),
	Rule(['+', self] as const, 							$ => ({ type: 'unary_op',		operator: '+', operand: $[1] } as const), PREC.unary),
	Rule(['-', self] as const, 							$ => ({ type: 'unary_op',		operator: '-', operand: $[1] } as const), PREC.unary),
	Rule(['!', self] as const, 							$ => ({ type: 'unary_op',		operator: '!', operand: $[1] } as const), PREC.unary),
	Rule(['~', self] as const, 							$ => ({ type: 'unary_op',		operator: '~', operand: $[1] } as const), PREC.unary),
	Rule(['*', self] as const, 							$ => ({ type: 'dereference',	operand: $[1] } as const), PREC.unary),
	Rule(['&', self] as const, 							$ => ({ type: 'address_of',		operand: $[1] } as const), PREC.unary),
	Rule(['++', self] as const, 						$ => ({ type: 'pre_increment',	operand: $[1] } as const), PREC.unary),
	Rule(['--', self] as const, 						$ => ({ type: 'pre_decrement',	operand: $[1] } as const), PREC.unary),
	Rule(['sizeof', self] as const, 					$ => ({ type: 'sizeof', 		operand: $[1] } as const), PREC.unary),
	// 'type_name' stays a string: it's declared later (it needs specifier_qualifier_list, which itself needs constant_expression --
	// part of this same expression chain), the same kind of cycle the original cast rule already cut this way with 'type_specifier'.
	Rule(['sizeof', '(', fwd_type_name, ')'] as const,	$ => ({ type: 'sizeof_type',	operand: $[2] as TypeName } as const), PREC.unary),
	Rule(['(', fwd_type_name, ')', self] as const, 		$ => ({ type: 'cast',			type1: $[1] as TypeName, expression: $[3] }), PREC.cast),
	Rule([self, '*',  self] as const, 					$ => ({ type: 'binary_op', 		operator: '*', left: $[0], right: $[2]}), PREC.multiplicative),
	Rule([self, '/',  self] as const, 					$ => ({ type: 'binary_op', 		operator: '/', left: $[0], right: $[2]}), PREC.multiplicative),
	Rule([self, '%',  self] as const, 					$ => ({ type: 'binary_op', 		operator: '%', left: $[0], right: $[2]}), PREC.multiplicative),
	Rule([self, '+',  self] as const,					$ => ({ type: 'binary_op', 		operator: '+', left: $[0], right: $[2] }), PREC.additive),
	Rule([self, '-',  self] as const,					$ => ({ type: 'binary_op', 		operator: '-', left: $[0], right: $[2] }), PREC.additive),
	Rule([self, '<<', self] as const, 					$ => ({ type: 'binary_op', 		operator: '<<', left: $[0], right: $[2] }), PREC.shift),
	Rule([self, '>>', self] as const, 					$ => ({ type: 'binary_op', 		operator: '>>', left: $[0], right: $[2] }), PREC.shift),
	Rule([self, '<',  self] as const, 					$ => ({ type: 'binary_op', 		operator: '<', left: $[0], right: $[2] }), PREC.relational),
	Rule([self, '>',  self] as const, 					$ => ({ type: 'binary_op', 		operator: '>', left: $[0], right: $[2] }), PREC.relational),
	Rule([self, '<=', self] as const, 					$ => ({ type: 'binary_op', 		operator: '<=', left: $[0], right: $[2] }), PREC.relational),
	Rule([self, '>=', self] as const, 					$ => ({ type: 'binary_op', 		operator: '>=', left: $[0], right: $[2] }), PREC.relational),
	Rule([self, '==', self] as const, 					$ => ({ type: 'binary_op', 		operator: '==', left: $[0], right: $[2] }), PREC.equality),
	Rule([self, '!=', self] as const, 					$ => ({ type: 'binary_op', 		operator: '!=', left: $[0], right: $[2] }), PREC.equality),
	Rule([self, '&',  self] as const, 					$ => ({ type: 'binary_op', 		operator: '&', left: $[0], right: $[2] }), PREC.bitwiseAnd),
	Rule([self, '^',  self] as const, 					$ => ({ type: 'binary_op', 		operator: '^', left: $[0], right: $[2] }), PREC.bitwiseXor),
	Rule([self, '|',  self] as const, 					$ => ({ type: 'binary_op', 		operator: '|', left: $[0], right: $[2] }), PREC.bitwiseOr),
	Rule([self, '&&', self] as const, 					$ => ({ type: 'binary_op', 		operator: '&&', left: $[0], right: $[2] }), PREC.logicalAnd),
	Rule([self, '||', self] as const,					$ => ({ type: 'binary_op', 		operator: '||', left: $[0], right: $[2] }), PREC.logicalOr),
	Rule([self, '?', self, ':', self] as const,			$ => ({ type: 'conditional',	test: $[0], consequent: $[2], alternate: $[4] }), PREC.conditional),
	Rule([self, '=',  self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '=' }), PREC.assignment),
	Rule([self, '+=', self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '+=' }), PREC.assignment),
	Rule([self, '-=', self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '-=' }), PREC.assignment),
	Rule([self, '*=', self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '*=' }), PREC.assignment),
	Rule([self, '/=', self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '/=' }), PREC.assignment),
	Rule([self, '%=', self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '%=' }), PREC.assignment),
	Rule([self, '&=', self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '&=' }), PREC.assignment),
	Rule([self, '|=', self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '|=' }), PREC.assignment),
	Rule([self, '^=', self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '^=' }), PREC.assignment),
	Rule([self, '<<=', self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '<<=' }), PREC.assignment),
	Rule([self, '>>=', self] as const, 					$ => ({ type: 'assign', left: $[0], right: $[2], operator: '>>=' }), PREC.assignment),
]),

// The comma operator's own level, kept out of assignment_expression -- this is what plain `expression` means in real C:
// parenthesized sub-expressions and array subscripts allow a comma operator, but argument lists, initializers, and declarator lists must not.
expression = RRules<Expr>(self => [
	Rule([assignment_expression] as const, 				$ => $[0]),
	Rule([self, ',', assignment_expression] as const, 	$ => ({ type: 'comma', left: $[0], right: $[2] } as const), PREC.comma),
]),

argument_expression_list = List(assignment_expression, ','),

// === Constant Expression (for switch cases, array/bitfield sizes) ===
// Real C narrows this to conditional-expression (excludes both assignment and comma); using assignment_expression is a pragmatic middle ground
constant_expression = Rules(
	Rule([assignment_expression] as const, 									$ => $[0]),
),

primary_expression = Rules(
	Rule([IDENT] as const, 													$ => ({ type: 'identifier', name: $[0] } as const)),
	Rule([INT_LITERAL] as const,											$ => ({ type: 'literal', value: parseInt($[0], 10) } as const)),
	Rule([FLOAT_LITERAL] as const, 											$ => ({ type: 'literal', value: parseFloat($[0]) } as const)),
	Rule([STRING_LITERAL] as const, 										$ => ({ type: 'string_literal', value: $[0] } as const)),
	Rule([CHAR_LITERAL] as const, 											$ => ({ type: 'char_literal', value: $[0] } as const)),
	Rule(['(', expression, ')'] as const, 									$ => $[1]),
),

postfix_expression = RRules<Expr>(self => [
	Rule([primary_expression] as const, 									$ => $[0]),
	Rule([self, '++'] as const,												$ => ({ type: 'post_increment', operand: $[0] } as const), PREC.unary),
	Rule([self, '--'] as const,												$ => ({ type: 'post_decrement',	operand: $[0] } as const), PREC.unary),
	Rule([self, '[', expression, ']'] as const, 							$ => ({ type: 'subscript',	array: $[0], index: $[2] } as const)),
	Rule([self, '.', IDENT] as const,										$ => ({ type: 'member_access',	object: $[0], member: $[2] } as const)),
	Rule([self, '->', IDENT] as const, 										$ => ({ type: 'pointer_member', object: $[0], member: $[2] } as const)),
	Rule([self, '(', argument_expression_list, ')'] as const,				$ => ({ type: 'function_call', function: $[0], arguments: $[2] } as const)),
]),

type_qualifier = Rules(
	Rule([termOneOf(['const', 'volatile'] as const)],						$ => $[0]),
),

struct_declarator = Rules<StructDeclarator>(
	Rule([IDENT], 															$ => ({ name: $[0] })),
	Rule([':', constant_expression] as const, 								$ => ({ type: 'bitfield', width: $[1] })),
	Rule([IDENT, ':', constant_expression] as const, 						$ => ({ name: $[0], type: 'bitfield', width: $[2] })),
),

struct_declarator_list = List(struct_declarator, ','),

// struct_declaration -> specifier_qualifier_list stays a string: cheapest cut in the type_specifier <-> struct/enum cycle (struct_declaration is specifier_qualifier_list's only consumer from this side).
struct_declaration = Rules(
	Rule([Forward<DeclSpecItem[]>(()=>specifier_qualifier_list), struct_declarator_list, ';'] as const, $ => ({ type: 'struct_member', typeSpecifiers: $[0], declarators: $[1] } as const)),
),

struct_declaration_list = List(struct_declaration),

struct_body = Rules(
	Rule([struct_declaration_list] as const, 								$ => $[0]),
	Rule([';'] as const, 													() => []),
	Rule([struct_declaration_list, ';'] as const,	 						$ => $[0]),
),

struct_or_union_specifier = Rules<StructSpecifier>(
	Rule(['struct', IDENT, '{', struct_body, '}'] as const, 				$ => ({ type: 'struct', name: $[1], members: $[3] } as const)),
	Rule(['struct', '{', struct_body, '}'] as const, 						$ => ({ type: 'struct', members: $[2] } as const)),
	Rule(['union', IDENT, '{', struct_body, '}'] as const, 					$ => ({ type: 'union', name: $[1], members: $[3] } as const)),
	Rule(['union', '{', struct_body, '}'] as const, 						$ => ({ type: 'union', members: $[2] } as const)),
	// Tag-only reference to a struct/union defined elsewhere -- distinguished from the definition forms above purely by whether '{' follows IDENT, an ordinary one-token-lookahead decision.
	{ rhs: ['struct', IDENT], 												action: $ => ({ type: 'struct', name: $[1] as string } as const) },
	{ rhs: ['union', IDENT], 												action: $ => ({ type: 'union', name: $[1] as string } as const) },
),

enumerator = Rules(
	Rule([IDENT, '=', constant_expression] as const, 						$ => ({ name: $[0], value: $[2] })),
	Rule([IDENT], 															$ => ({ name: $[0] })),
),

enumerator_list = List(enumerator, ','),

enum_specifier = Rules<EnumSpecifier>(
	Rule(['enum', IDENT, '{', enumerator_list, '}'] as const, 				$ => ({ type: 'enum', name: $[1], enumerators: $[3] } as const)),
	Rule(['enum', '{', enumerator_list, '}'] as const, 						$ => ({ type: 'enum', enumerators: $[2] } as const)),
	// Tag-only reference, same as struct/union above.
	{ rhs: ['enum', IDENT], 												action: $ => ({ type: 'enum', name: $[1] as string } as const) },
),

type_specifier = Rules<TypeSpecifier>(
	Rule([termOneOf(BUILTIN_TYPE)],											$ => ({ type: 'type', name: $[0] })),
	Rule([struct_or_union_specifier] as const, 								$ => $[0]),
	Rule([enum_specifier] as const, 										$ => $[0]),
	Rule([TYPE_NAME], 														$ => ({ type: 'type', name: $[0] })),
),

specifier_qualifier_list = RRules<DeclSpecItem[]>(self => [
	Rule([type_specifier] as const, 										$ => [$[0]]),
	Rule([self, type_specifier] as const, 									$ => [...$[0], $[1]]),
	Rule([self, type_qualifier] as const, 									$ => [...$[0], $[1]]),
]),

// --- Declarators / declarations ---
storage_class_specifier = Rules(//<StorageClass>(
	{ rhs: ['typedef'], 													action: () => 'typedef' as const},
	{ rhs: ['extern'], 														action: () => 'extern'  as const},
	{ rhs: ['static'], 														action: () => 'static'  as const},
	{ rhs: ['auto'], 														action: () => 'auto'  as const},
	{ rhs: ['register'], 													action: () => 'register'  as const},
),

declaration_specifiers = Rules(
	Rule([specifier_qualifier_list] as const, 								($, ctx) => { ctx.pendingTypedef = false; return [...($[0])]; }),
	Rule([specifier_qualifier_list, storage_class_specifier] as const, 		($, ctx) => { ctx.pendingTypedef = $[1] === 'typedef'; return [...($[0]), $[1]]; }),
	Rule([storage_class_specifier, specifier_qualifier_list] as const, 		($, ctx) => { ctx.pendingTypedef = $[0] === 'typedef'; return [$[0], ...($[1])]; }),
),

pointer = RRules<Pointer>(self => [
	Rule(['*'], 															() => [{ level: 1 }]),
	Rule(['*', self] as const,												$ => [{ level: $[1].length + 1 }, ...$[1]]),
]),
fwd_parameter_type_list = Forward<ParamOrVariadic[]>(() => parameter_type_list),
// Mirrors direct_declarator/declarator, but for abstract declarators (no name anywhere) -- e.g. `*`, `[5]`, `(int)`, `(*)(int)`, or combinations.
// 'abstract_declarator' and 'parameter_type_list' stay strings: the former for the grouping rule's forward reference (declared right after this),
// the latter for the same cycle direct_declarator already cuts this way.
//
// `'(' ')'` (function-with-no-params) can't be confused with the grouping rule `'(' abstract_declarator ')'`, since abstract_declarator can never
// derive empty -- it always needs at least a pointer or a direct form, the same way real C's grammar avoids this exact ambiguity.
direct_abstract_declarator = RRules<AbstractDeclarator>(self => [
	Rule(['(', Forward<AbstractDeclarator>(() => abstract_declarator), ')'] as const, $ => $[1]),
	Rule(['(', ')'] as const, 												() => ({ type: 'function', parameters: [] } as const)),
	Rule(['(', fwd_parameter_type_list, ')'] as const, 						$ => ({ type: 'function', parameters: $[1] } as const)),
	Rule([self, '(', ')'] as const, 										$ => ({ type: 'function', name: $[0], parameters: [] } as const)),
	Rule([self, '(', fwd_parameter_type_list, ')'] as const,				$ => ({ type: 'function', name: $[0], parameters: $[2] } as const)),
	Rule(['[', ']'] as const, 												() => ({ type: 'array' } as const)),
	Rule(['[', type_specifier, ']'] as const, 								$ => ({ type: 'array', size: $[1] } as const)),
	Rule(['[', constant_expression, ']'] as const, 							$ => ({ type: 'array', size: $[1] } as const)),
	Rule([self, '[', ']'] as const, 										$ => ({ type: 'array', element: $[0] } as const)),
	Rule([self, '[', type_specifier, ']'] as const, 						$ => ({ type: 'array', element: $[0], size: $[2] } as const)),
	Rule([self, '[', constant_expression, ']'] as const,					$ => ({ type: 'array', element: $[0], size: $[2] } as const)),
]),
abstract_declarator = Rules<AbstractDeclarator>(
	Rule([pointer] as const, 												$ => ({ type: 'pointer', pointer: $[0] as Pointer } as const)),
	Rule([direct_abstract_declarator] as const, 							$ => $[0]),
	Rule([pointer, direct_abstract_declarator] as const, 					$ => ({ type: 'pointer', pointer: $[0] as Pointer, to: $[1] } as const)),
),

// A type-name for casts/sizeof: specifiers plus an optional abstract declarator -- pointers, arrays, functions, and combinations
type_name = Rules<TypeName>(
	Rule([specifier_qualifier_list] as const, 								$ => ({ specifiers: $[0] } as const)),
	Rule([specifier_qualifier_list, abstract_declarator] as const, 			$ => ({ specifiers: $[0], declarator: $[1] } as const)),
),

// direct_declarator -> parameter_type_list stays a string: cheapest cut in the
// direct_declarator <-> parameter_declaration cycle (a function declarator's
// own parameter list is the only edge crossing back into that cycle).
direct_declarator = RRules<Declarator>(self => [
	Rule([IDENT] as const,													$ => ({ type: 'identifier', name: $[0] } as const)),
	// Grouping -- the only way to attach a pointer to a *name* rather than to the surrounding function/array type, which is what makes a function
	// pointer (`int (*fp)(int)`) parse as "fp is a pointer to a function" instead of "fp is a function returning a pointer". 'declarator' stays
	// a string: it's declared below, after this (the classic forward-reference-in-a-cycle situation, same as parameter_type_list above).
	Rule(['(', Forward<Declarator>(()=>declarator), ')'] as const, 			$ => $[1]),
	Rule([self, '(', ')'] as const,											$ => ({ type: 'function', name: $[0], parameters: [] } as const)),
	Rule([self, '(', fwd_parameter_type_list, ')'] as const,				$ => ({ type: 'function', name: $[0], parameters: $[2] } as const)),
	Rule([self, '[', type_specifier, ']'] as const, 						$ => ({ type: 'array', element: $[0], size: $[2] } as const)),
	Rule([self, '[', constant_expression, ']'] as const, 					$ => ({ type: 'array', element: $[0], size: $[2] } as const)),
	// Incomplete array form: `int arr[];`, also used for unsized array parameters (`void f(int arr[])`).
	Rule([self, '[', ']'] as const, 										$ => ({ type: 'array', element: $[0] } as const)),
]),

// A leading pointer is handled here now (rather than only at init_declarator, as before), so it composes with the grouping rule above
// for function pointers, and so parameter declarators (which go through 'declarator' directly, not through init_declarator) can have pointer
// types too (`void f(int *x)` -- previously unsupported).
declarator = Rules<Declarator>(
	Rule([direct_declarator] as const, 										$ => $[0]),
	Rule([pointer, direct_declarator] as const, 							$ => ({ type: 'pointer', pointer: $[0], to: $[1] } as const)),
),

parameter_declaration = Rules(
	Rule([declaration_specifiers, declarator] as const, 					$ => ({ type: 'parameter', specifiers: $[0], declarator: $[1] } as const)),
	Rule([declaration_specifiers] as const, 								$ => ({ type: 'parameter', specifiers: $[0] } as const)),
),
parameter_list = List(parameter_declaration, ','),
parameter_type_list = Rules(//<ParamOrVariadic[]>(
	Rule([parameter_list] as const, 										$ => $[0]),
	Rule([parameter_list, ',', '...'] as const, 							$ => [...($[0]), { type: 'variadic' } as const]),
),

// initializer_list -> initializer stays a string: the cheapest cut in their mutual cycle (initializer's only consumer of initializer_list is its own brace-list case, vs. initializer_list needing initializer for every element)
initializer_list = List(Forward<Initializer>(() => initializer), ','),
initializer = Rules<Initializer>(
	Rule([assignment_expression] as const, 									$ => $[0]),
	Rule(['{', '}'] as const, 												() => ({ type: 'initializer_list', elements: [] } as const)),
	Rule(['{', initializer_list, '}'] as const, 							$ => ({ type: 'initializer_list', elements: $[1] } as const)),
	Rule(['{', initializer_list, ',', '}'] as const, 						$ => ({ type: 'initializer_list', elements: $[1] } as const)),
),

// Pointers are now handled by 'declarator' itself (see above), so this simplifies to just the plain-or-initialized cases.
init_declarator = Rules<InitDeclarator>(
	Rule([declarator] as const, 											($, ctx) => { const d = $[0]; if (ctx.pendingTypedef) ctx.typedefNames.add(declaratorName(d)); return d; }),
	Rule([declarator, '=', initializer] as const, 							($, ctx) => { const d = $[0]; if (ctx.pendingTypedef) ctx.typedefNames.add(declaratorName(d)); return { declarator: d, initializer: $[2] }; }),
),
init_declarator_list = List(init_declarator, ','),

declaration = Rules(
	Rule([declaration_specifiers, ';'] as const, 							$ => ({ type: 'declaration', specifiers: $[0] } as const)),
	Rule([declaration_specifiers, init_declarator_list, ';'] as const, 		$ => ({ type: 'declaration', specifiers: $[0], initDeclarators: $[1] } as const)),
),

// --- Statements ---
// NOTE: 'declaration' already consumes its own trailing ';', so the declaration-based alternatives must not require a second one.
for_statement = Rules<ForClauses>(
	Rule([expression, ';'] as const, 										$ => ({ init: $[0], condition: undefined, update: undefined })),
	Rule([expression, ';', expression] as const, 							$ => ({ init: $[0], condition: $[2], update: undefined })),
	Rule([expression, ';', expression, ';', expression] as const, 			$ => ({ init: $[0], condition: $[2], update: $[4] })),
	Rule([declaration, expression] as const, 								$ => ({ init: $[0], condition: $[1], update: undefined })),
	Rule([declaration, expression, ';', expression] as const, 				$ => ({ init: $[0], condition: $[1], update: $[3] })),
),

expression_statement = Rules(
	{ rhs: [';'],														   	action: () => ({ type: 'empty_statement' }) },
	Rule([expression, ';'] as const, 										$ => $[0]),
),

// statement -> compound_statement stays a string: cheapest cut in the statement <-> compound_statement <-> statement_list cycle
// (it's 1 of statement's 13 alternatives, vs. 2 uses on statement_list's side).
statement = RRules(self => [
	Rule([Forward<Block>(()=>compound_statement)], 							$ => $[0]),
	Rule([declaration] as const, 											$ => $[0]),
	Rule(['if', '(', expression, ')', self] as const, 						$ => ({ type: 'if', condition: $[2], then: $[4] })),
	Rule(['if', '(', expression, ')', self, 'else', self] as const, 		$ => ({ type: 'if_else', condition: $[2], then: $[4], else: $[6] })),
	Rule(['while', '(', expression, ')', self] as const, 					$ => ({ type: 'while', condition: $[2], body: $[4] })),
	Rule(['do', self, 'while', '(', expression, ')', ';'] as const, 		$ => ({ type: 'do_while', body: $[1], condition: $[4] })),
	Rule(['for', '(', for_statement, ')', self] as const, 					$ => ({ type: 'for', ...($[2]), body: $[4] })),
	Rule(['switch', '(', expression, ')', self] as const, 					$ => ({ type: 'switch', condition: $[2], body: $[4] })),
	Rule(['case', constant_expression, ':', self] as const, 				$ => ({ type: 'case', value: $[1], body: $[3] })),
	{ rhs: ['default', ':', self], 											action: $ => ({ type: 'default', body: $[2] }) },
	{ rhs: ['break', ';'], 													action: () => ({ type: 'break' }) },
	{ rhs: ['continue', ';'], 												action: () => ({ type: 'continue' }) },
	Rule(['return', expression, ';'] as const, 								$ => ({ type: 'return', expression: $[1] })),
	{ rhs: ['return', ';'], 												action: () => ({ type: 'return' }) },
	Rule(['goto', IDENT, ';'] as const, 									$ => ({ type: 'goto', label: $[1] })),
	Rule([IDENT, ':', self] as const, 										$ => ({ type: 'labeled', label: $[0], body: $[2] })),
	Rule([expression_statement] as const, 									$ => $[0]),
]),

compound_statement = Rules(
	Rule(['{', List(statement), '}'] as const, 								$ => ({ type: 'block', statements: $[1] })),
	{ rhs: ['{', '}'], 														action: () => ({ type: 'block', statements: [] }) },
),

// --- Top level ---
function_definition = Rules(
	Rule([declaration_specifiers, declarator, compound_statement] as const, $ => ({ type: 'function_def', specifiers: $[0], declarator: $[1], body: $[2] })),
),

external_definition = Rules<Definition>(
	Rule([declaration] as const, 											$ => $[0]),
	Rule([function_definition] as const, 									$ => $[0] as Definition),
),

translation_unit = RRules<TranslationUnit>(self => [
	Rule([external_definition] as const, 									$ => ({ type: 'translation_unit', definitions: [$[0]] })),
	Rule([self, external_definition] as const, 								$ => ({ ...$[0], definitions: [...$[0].definitions, $[1]] })),
]);

const parser = makeParser({
	skip: [/\s+/, /#[^\n]*/, /\/\/[^\n]*/, /\/\*[^]*?\*\//],
	// IDENT has to be lexed even in states where only TYPE_NAME is grammatically valid (e.g. a
	// parameter's type-specifier position) -- it's the only terminal whose pattern actually
	// matches the text, and its callback is what reclassifies a known typedef name into the
	// pattern-less TYPE_NAME. Without this, TYPE_NAME could never be produced there at all.
	terminals: [IDENT],
	precedence: PREC,
	start: translation_unit,
	//rules
	rules: {translation_unit}
});

export const cParser = {
	...parser,
	parse: (code: string) => {
		return parser.parse(code, {
			pendingTypedef: false,
			typedefNames: new Set<string>(),
		});
	}
};
