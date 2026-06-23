import { tison, Rule, Rules, terminal, virtualTerminal, reOneOf } from '../src/tison';

// ===================================================================
//  C Parser Grammar using tison
// ===================================================================

// --- Terminals (RegExps are auto-named by source text) ---
// IDENT is wrapped via terminal() (instead of a bare RegExp) so we can attach a `lex` hook to it:
// the classic C "lexer hack" for resolving the typedef-name ambiguity (`foo * bar;` -- pointer declaration or multiply?)
// by checking a symbol table of names seen in `typedef` declarations so far.
const typedefNames = new Set<string>();
// Set by declaration_specifiers as soon as it's reduced (well before the declarator names are parsed), so init_declarator can register each name
// immediately -- registering any later (e.g. once the whole `declaration` including its trailing ';' has reduced) is too late: by then the LALR
// parser has already had to peek one token past the ';' to decide to reduce, and that's the very token that needed reclassifying.
let pendingTypedef = false;

const TYPE_NAME			= virtualTerminal('TYPE_NAME');
const IDENT 			= terminal(/[a-zA-Z_][a-zA-Z0-9_]*/, ({ text }) => typedefNames.has(text) ? TYPE_NAME : IDENT);

const INT_LITERAL 		= /[0-9]+(?:[uU]|[lL]|[uU][lL]|[lL][uU])?/;
const FLOAT_LITERAL 	= /[0-9]+\.[0-9]*(?:[eE][-+]?[0-9]+)?[fFlL]?/;
const STRING_LITERAL 	= /"(?:[^"\\]|\\.)*"/;
const CHAR_LITERAL 		= /'(?:[^'\\]|\\.)*'/;
const PREPROCESSOR 		= /#[^\n]*/;

const BUILTIN_TYPE		= ['int', 'float', 'double', 'void', 'char', 'short', 'long', 'signed', 'unsigned'];

// --- Precedence Levels (lowest to highest) ---
const PREC_LEVELS = {
	assignment:		'right',
	logicalOr:		'left',
	logicalAnd:		'left',
	bitwiseOr:		'left',
	bitwiseXor:		'left',
	bitwiseAnd:		'left',
	equality:		'left',
	relational:		'left',
	additive:		'left',
	multiplicative:	'left',
	cast:			'right',
	unary:			'right',
} as const;

// ===================================================================
//  AST Types -- one per non-terminal group (or shared where alts agree)
// ===================================================================

type TypeQualifier	= 'const' | 'volatile';
type StorageClass	= 'typedef' | 'extern' | 'static';

interface PrimitiveType		{ type: 'type'; name: string; }
interface StructMember		{ type: 'struct_member'; typeSpecifiers: DeclSpecItem[]; declarators: StructDeclarator[]; }
interface StructSpecifier	{ type: 'struct' | 'union'; name?: string; members: StructMember[]; }
interface Enumerator		{ name: string; value?: Expr; }
interface EnumSpecifier		{ type: 'enum'; name?: string; enumerators: Enumerator[]; }
type TypeSpecifier			= PrimitiveType | StructSpecifier | EnumSpecifier;

interface StructDeclarator	{ name?: string; type?: 'bitfield'; width?: Expr; }

type DeclSpecItem			= TypeSpecifier | TypeQualifier;
type DeclarationSpecifiers	= (DeclSpecItem | StorageClass)[];

interface Declaration		{ type: 'declaration'; specifiers: DeclarationSpecifiers; initDeclarators?: InitDeclarator[]; }

type Pointer				= { level: number }[];

type Declarator =
	| { type: 'identifier'; name: string }
	| { type: 'function'; name: Declarator; parameters: ParamOrVariadic[] }
	| { type: 'array'; element: Declarator; size: TypeSpecifier | Expr };

type InitDeclarator			= Declarator | { pointer?: Pointer; declarator: Declarator; initializer?: Expr };

interface ParameterDeclaration	{ type: 'parameter'; specifiers: DeclarationSpecifiers; declarator?: Declarator; }
type ParamOrVariadic = ParameterDeclaration | { type: 'variadic' };

interface FunctionDef		{ type: 'function_def'; specifiers: DeclarationSpecifiers; declarator: Declarator; body: Block; }
type Definition				= Declaration | FunctionDef;
interface TranslationUnit	{ type: 'translation_unit'; definitions: Definition[]; }

interface Block				{ type: 'block'; statements: Statement[]; }
interface ForClauses		{ init: Expr | Declaration; condition?: Expr; update?: Expr; }

type Statement =
	| Block
	| Declaration
	| { type: 'if'; condition: Expr; then: Statement }
	| { type: 'if_else'; condition: Expr; then: Statement; else: Statement }
	| { type: 'while'; condition: Expr; body: Statement }
	| { type: 'for'; init: Expr | Declaration; condition?: Expr; update?: Expr; body: Statement }
	| { type: 'switch'; condition: Expr; body: Statement }
	| { type: 'case'; value: Expr; body: Statement }
	| { type: 'default'; body: Statement }
	| { type: 'break' }
	| { type: 'continue' }
	| { type: 'return'; expression?: Expr }
	| { type: 'empty_statement' }
	| Expr;

type Expr =
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
	| { type: 'cast'; type1: TypeSpecifier; expression: Expr }
	| { type: 'binary_op'; operator: string; left: Expr; right: Expr }
	| { type: 'assign'; left: Expr; right: Expr; operator: string };

/** The base identifier a declarator ultimately names, digging through function/array wrappers. */
function declaratorName(d: Declarator): string {
	switch (d.type) {
		case 'identifier':	return d.name;
		case 'function':	return declaratorName(d.name);
		case 'array':		return declaratorName(d.element);
	}
}

// --- Grammar Definition ---
//
// Declared bottom-up (leaf non-terminals first) so each rule can reference an already-declared group BY OBJECT (typed, no cast needed) instead of by name (untyped string, needs `as`).
// Every self-recursive rule, and exactly one edge per genuine cycle (chosen as whichever single rule sacrifices the fewest alternatives), necessarily stays a string -- see the comments below.

const
// --- Expression chain (innermost precedence first) ---
/*
unary_expression = Rules(
	{ rhs: ['postfix_expression'], 											action: $ => $[0] as Expr },
	{ rhs: ['+', 'unary_expression'], 										action: $ => ({ type: 'unary_op',		operator: '+', operand: $[1] as Expr } as const), prec: 'unary' },
	{ rhs: ['-', 'unary_expression'], 										action: $ => ({ type: 'unary_op',		operator: '-', operand: $[1] as Expr } as const), prec: 'unary' },
	{ rhs: ['!', 'unary_expression'], 										action: $ => ({ type: 'unary_op',		operator: '!', operand: $[1] as Expr } as const), prec: 'unary' },
	{ rhs: ['~', 'unary_expression'], 										action: $ => ({ type: 'unary_op',		operator: '~', operand: $[1] as Expr } as const), prec: 'unary' },
	{ rhs: ['*', 'unary_expression'], 										action: $ => ({ type: 'dereference',	operand: $[1] as Expr } as const), prec: 'unary' },
	{ rhs: ['&', 'unary_expression'], 										action: $ => ({ type: 'address_of',		operand: $[1] as Expr } as const), prec: 'unary' },
	{ rhs: ['++', 'unary_expression'], 										action: $ => ({ type: 'pre_increment',	operand: $[1] as Expr } as const), prec: 'unary' },
	{ rhs: ['--', 'unary_expression'], 										action: $ => ({ type: 'pre_decrement',	operand: $[1] as Expr } as const), prec: 'unary' },
),

// cast_expression -> type_specifier stays a string: it's the single cheapest
// edge to cut in the type_specifier <-> expression-chain cycle (cast_expression
// is type_specifier's only consumer from this side).
cast_expression = Rules(
	Rule([unary_expression] as const, 										$ => $[0]),
	Rule(['(', 'type_specifier', ')', 'cast_expression'] as const, 			$ => ({ type: 'cast', type1: $[1] as TypeSpecifier, expression: $[3] as Expr } as const), 'cast'),
),

multiplicative_expression = Rules(
	Rule([cast_expression] as const, 										$ => $[0]),
	Rule(['multiplicative_expression', '*', cast_expression] as const, 		$ => ({ type: 'binary_op', operator: '*', left: $[0] as Expr, right: $[2] } as const), 'multiplicative'),
	Rule(['multiplicative_expression', '/', cast_expression] as const, 		$ => ({ type: 'binary_op', operator: '/', left: $[0] as Expr, right: $[2] } as const), 'multiplicative'),
	Rule(['multiplicative_expression', '%', cast_expression] as const, 		$ => ({ type: 'binary_op', operator: '%', left: $[0] as Expr, right: $[2] } as const), 'multiplicative'),
),

additive_expression = Rules(
	Rule([multiplicative_expression] as const, 								$ => $[0]),
	Rule(['additive_expression', '+', multiplicative_expression] as const,	$ => ({ type: 'binary_op', operator: '+', left: $[0] as Expr, right: $[2] } as const), 'additive'),
	Rule(['additive_expression', '-', multiplicative_expression] as const,	$ => ({ type: 'binary_op', operator: '-', left: $[0] as Expr, right: $[2] } as const), 'additive'),
),

relational_expression = Rules(
	Rule([additive_expression] as const, 									$ => $[0]),
	Rule(['relational_expression', '<', additive_expression] as const, 		$ => ({ type: 'binary_op', operator: '<', left: $[0] as Expr, right: $[2] } as const), 'relational'),
	Rule(['relational_expression', '>', additive_expression] as const, 		$ => ({ type: 'binary_op', operator: '>', left: $[0] as Expr, right: $[2] } as const), 'relational'),
	Rule(['relational_expression', '<=', additive_expression] as const, 	$ => ({ type: 'binary_op', operator: '<=', left: $[0] as Expr, right: $[2] } as const), 'relational'),
	Rule(['relational_expression', '>=', additive_expression] as const, 	$ => ({ type: 'binary_op', operator: '>=', left: $[0] as Expr, right: $[2] } as const), 'relational'),
),

equality_expression = Rules(
	Rule([relational_expression] as const, 									$ => $[0]),
	Rule(['equality_expression', '==', relational_expression] as const, 	$ => ({ type: 'binary_op', operator: '==', left: $[0] as Expr, right: $[2] } as const), 'equality'),
	Rule(['equality_expression', '!=', relational_expression] as const, 	$ => ({ type: 'binary_op', operator: '!=', left: $[0] as Expr, right: $[2] } as const), 'equality'),
),

logical_and_expression = Rules(
	Rule([equality_expression] as const, 									$ => $[0]),
	Rule(['logical_and_expression', '&&', equality_expression] as const, 	$ => ({ type: 'binary_op', operator: '&&', left: $[0] as Expr, right: $[2] } as const), 'logicalAnd'),
),

logical_or_expression = Rules(
	Rule([logical_and_expression] as const, 								$ => $[0]),
	Rule(['logical_or_expression', '||', logical_and_expression] as const,	$ => ({ type: 'binary_op', operator: '||', left: $[0] as Expr, right: $[2] } as const), 'logicalOr'),
),

assignment_expression = Rules(
	Rule([unary_expression, '=', 'assignment_expression'] as const, 		$ => ({ type: 'assign', left: $[0], right: $[2] as Expr, operator: '=' } as const), 'assignment'),
	Rule([unary_expression, '+=', 'assignment_expression'] as const, 		$ => ({ type: 'assign', left: $[0], right: $[2] as Expr, operator: '+=' } as const), 'assignment'),
	Rule([unary_expression, '-=', 'assignment_expression'] as const, 		$ => ({ type: 'assign', left: $[0], right: $[2] as Expr, operator: '-=' } as const), 'assignment'),
	Rule([unary_expression, '*=', 'assignment_expression'] as const, 		$ => ({ type: 'assign', left: $[0], right: $[2] as Expr, operator: '*=' } as const), 'assignment'),
	Rule([unary_expression, '/=', 'assignment_expression'] as const, 		$ => ({ type: 'assign', left: $[0], right: $[2] as Expr, operator: '/=' } as const), 'assignment'),
	Rule([logical_or_expression] as const, 									$ => $[0]),
),

expression = Rules(
	Rule([assignment_expression] as const, 									$ => $[0]),
),
*/
expression = Rules<Expr>(
	Rule(['postfix_expression'], 											$ => $[0] as Expr),
	Rule(['+', 'expression'], 												$ => ({ type: 'unary_op',		operator: '+', operand: $[1] as Expr } as const), 'unary'),
	Rule(['-', 'expression'], 												$ => ({ type: 'unary_op',		operator: '-', operand: $[1] as Expr } as const), 'unary'),
	Rule(['!', 'expression'], 												$ => ({ type: 'unary_op',		operator: '!', operand: $[1] as Expr } as const), 'unary'),
	Rule(['~', 'expression'], 												$ => ({ type: 'unary_op',		operator: '~', operand: $[1] as Expr } as const), 'unary'),
	Rule(['*', 'expression'], 												$ => ({ type: 'dereference',	operand: $[1] as Expr } as const), 'unary'),
	Rule(['&', 'expression'], 												$ => ({ type: 'address_of',		operand: $[1] as Expr } as const), 'unary'),
	Rule(['++', 'expression'], 												$ => ({ type: 'pre_increment',	operand: $[1] as Expr } as const), 'unary'),
	Rule(['--', 'expression'], 												$ => ({ type: 'pre_decrement',	operand: $[1] as Expr } as const), 'unary'),
	Rule(['(', 'type_specifier', ')', 'expression'], 						$ => ({ type: 'cast', type1: $[1] as TypeSpecifier, expression: $[3] as Expr }), 'cast'),
	Rule(['expression', '*',  'expression'], 								$ => ({ type: 'binary_op', operator: '*', left: $[0] as Expr, right: $[2] as Expr}), 'multiplicative'),
	Rule(['expression', '/',  'expression'], 								$ => ({ type: 'binary_op', operator: '/', left: $[0] as Expr, right: $[2] as Expr}), 'multiplicative'),
	Rule(['expression', '%',  'expression'], 								$ => ({ type: 'binary_op', operator: '%', left: $[0] as Expr, right: $[2] as Expr}), 'multiplicative'),
	Rule(['expression', '+',  'expression'],								$ => ({ type: 'binary_op', operator: '+', left: $[0] as Expr, right: $[2] as Expr }), 'additive'),
	Rule(['expression', '-',  'expression'],								$ => ({ type: 'binary_op', operator: '-', left: $[0] as Expr, right: $[2] as Expr }), 'additive'),
	Rule(['expression', '<',  'expression'], 								$ => ({ type: 'binary_op', operator: '<', left: $[0] as Expr, right: $[2] as Expr }), 'relational'),
	Rule(['expression', '>',  'expression'], 								$ => ({ type: 'binary_op', operator: '>', left: $[0] as Expr, right: $[2] as Expr }), 'relational'),
	Rule(['expression', '<=', 'expression'], 								$ => ({ type: 'binary_op', operator: '<=', left: $[0] as Expr, right: $[2] as Expr }), 'relational'),
	Rule(['expression', '>=', 'expression'], 								$ => ({ type: 'binary_op', operator: '>=', left: $[0] as Expr, right: $[2] as Expr }), 'relational'),
	Rule(['expression', '==', 'expression'], 								$ => ({ type: 'binary_op', operator: '==', left: $[0] as Expr, right: $[2] as Expr }), 'equality'),
	Rule(['expression', '!=', 'expression'], 								$ => ({ type: 'binary_op', operator: '!=', left: $[0] as Expr, right: $[2] as Expr }), 'equality'),
	Rule(['expression', '&&', 'expression'], 								$ => ({ type: 'binary_op', operator: '&&', left: $[0] as Expr, right: $[2] as Expr }), 'logicalAnd'),
	Rule(['expression', '||', 'expression'],								$ => ({ type: 'binary_op', operator: '||', left: $[0] as Expr, right: $[2] as Expr }), 'logicalOr'),
	Rule(['expression', '=',  'expression'], 								$ => ({ type: 'assign', left: $[0] as Expr, right: $[2] as Expr, operator: '=' }), 'assignment'),
	Rule(['expression', '+=', 'expression'], 								$ => ({ type: 'assign', left: $[0] as Expr, right: $[2] as Expr, operator: '+=' }), 'assignment'),
	Rule(['expression', '-=', 'expression'], 								$ => ({ type: 'assign', left: $[0] as Expr, right: $[2] as Expr, operator: '-=' }), 'assignment'),
	Rule(['expression', '*=', 'expression'], 								$ => ({ type: 'assign', left: $[0] as Expr, right: $[2] as Expr, operator: '*=' }), 'assignment'),
	Rule(['expression', '/=', 'expression'], 								$ => ({ type: 'assign', left: $[0] as Expr, right: $[2] as Expr, operator: '/=' }), 'assignment'),
),

argument_expression_list = Rules(
	Rule([expression] as const, 									$ => [$[0]]),
	Rule(['argument_expression_list', ',', expression] as const, $ => [...($[0] as Expr[]), $[2]]),
),

// === Constant Expression (for switch cases, array sizes) ===
constant_expression = Rules(
	Rule([expression] as const, 									$ => $[0]),
),

// primary_expression/postfix_expression are declared down here (rather than
// right after unary_expression) specifically so 'expression' and
// 'argument_expression_list' -- both needed by postfix_expression -- are
// already available; the only cost is unary_expression's own reference to
// postfix_expression, which now has to stay a string instead.
primary_expression = Rules(
	Rule([IDENT] as const, 													$ => ({ type: 'identifier', name: $[0] } as const)),
	Rule([INT_LITERAL] as const,											$ => ({ type: 'literal', value: parseInt($[0], 10) } as const)),
	Rule([FLOAT_LITERAL] as const, 											$ => ({ type: 'literal', value: parseFloat($[0]) } as const)),
	Rule([STRING_LITERAL] as const, 										$ => ({ type: 'string_literal', value: $[0] } as const)),
	Rule([CHAR_LITERAL] as const, 											$ => ({ type: 'char_literal', value: $[0] } as const)),
	Rule(['(', expression, ')'] as const, 									$ => $[1]),
),

postfix_expression = Rules(
	Rule([primary_expression] as const, 									$ => $[0]),
	{ rhs: ['postfix_expression', '++'], 									action: $ => ({ type: 'post_increment', operand: $[0] as Expr } as const), prec: 'unary' },
	{ rhs: ['postfix_expression', '--'], 									action: $ => ({ type: 'post_decrement',	operand: $[0] as Expr } as const), prec: 'unary' },
	Rule(['postfix_expression', '[', expression, ']'] as const, 			$ => ({ type: 'subscript',	array: $[0] as Expr, index: $[2] } as const)),
	Rule(['postfix_expression', '.', IDENT] as const,						$ => ({ type: 'member_access',	object: $[0] as Expr, member: $[2] } as const)),
	Rule(['postfix_expression', '->', IDENT] as const, 						$ => ({ type: 'pointer_member', object: $[0] as Expr, member: $[2] } as const)),
	Rule(['postfix_expression', '(', argument_expression_list, ')'] as const, $ => ({ type: 'function_call', function: $[0] as Expr, arguments: $[2] } as const)),
),

// --- Type system: struct/union/enum/type_specifier ---
//type_qualifier = Rules(
//	{ rhs: ['const'], 														action: () => 'const' as const},
//	{ rhs: ['volatile'], 													action: () => 'volatile' as const},
//),
type_qualifier = Rules(
	{ rhs: [/const|volatile/],												action: $ => $[0] as 'const'|'volatile'},
),

struct_declarator = Rules<StructDeclarator>(
	Rule([IDENT], 															$ => ({ name: $[0] })),
	Rule([':', constant_expression] as const, 								$ => ({ type: 'bitfield', width: $[1] })),
	Rule([IDENT, ':', constant_expression] as const, 						$ => ({ name: $[0], type: 'bitfield', width: $[2] })),
),

struct_declarator_list = Rules(
	Rule([struct_declarator] as const, 										$ => [$[0]]),
	Rule(['struct_declarator_list', ',', struct_declarator] as const, 		$ => [...($[0] as StructDeclarator[]), $[2]]),
),

// struct_declaration -> specifier_qualifier_list stays a string: cheapest cut in the type_specifier <-> struct/enum cycle (struct_declaration is specifier_qualifier_list's only consumer from this side).
struct_declaration = Rules(
	Rule(['specifier_qualifier_list', struct_declarator_list, ';'] as const, $ => ({ type: 'struct_member', typeSpecifiers: $[0] as DeclSpecItem[], declarators: $[1] } as const)),
),

struct_declaration_list = Rules(
	Rule([struct_declaration] as const, 									$ => [$[0]]),
	Rule(['struct_declaration_list', struct_declaration] as const, 			$ => [...($[0] as StructMember[]), $[1]]),
),

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
),

enumerator = Rules(
	Rule([IDENT, '=', constant_expression] as const, 						$ => ({ name: $[0], value: $[2] })),
	Rule([IDENT], 															$ => ({ name: $[0] })),
),

enumerator_list = Rules(
	Rule([enumerator] as const, 											$ => [$[0]]),
	Rule(['enumerator_list', ',', enumerator] as const, 					$ => [...($[0] as Enumerator[]), $[2]]),
),

enum_specifier = Rules(
	Rule(['enum', IDENT, '{', enumerator_list, '}'] as const, 				$ => ({ type: 'enum', name: $[1], enumerators: $[3] } as const)),
	Rule(['enum', '{', enumerator_list, '}'] as const, 						$ => ({ type: 'enum', enumerators: $[2] } as const)),
),

type_specifier = Rules<TypeSpecifier>(
	Rule([reOneOf(BUILTIN_TYPE)],											$ => ({ type: 'type', name: $[0] })),
//	{ rhs: ['int'], 														action: () => ({ type: 'type', name: 'int' }) },
//	{ rhs: ['float'], 														action: () => ({ type: 'type', name: 'float' }) },
//	{ rhs: ['double'], 														action: () => ({ type: 'type', name: 'double' }) },
//	{ rhs: ['void'], 														action: () => ({ type: 'type', name: 'void' }) },
//	{ rhs: ['char'], 														action: () => ({ type: 'type', name: 'char' }) },
//	{ rhs: ['short'], 														action: () => ({ type: 'type', name: 'short' }) },
//	{ rhs: ['long'], 														action: () => ({ type: 'type', name: 'long' }) },
//	{ rhs: ['signed'], 														action: () => ({ type: 'type', name: 'signed' }) },
//	{ rhs: ['unsigned'], 													action: () => ({ type: 'type', name: 'unsigned' }) },
	Rule([struct_or_union_specifier] as const, 								$ => $[0]),
	Rule([enum_specifier] as const, 										$ => $[0]),
	Rule([TYPE_NAME], 														$ => ({ type: 'type', name: $[0] })),
),

specifier_qualifier_list = Rules(
	Rule([type_specifier] as const, 										$ => [$[0]]),
	Rule(['specifier_qualifier_list', type_specifier] as const, 			$ => [...($[0] as DeclSpecItem[]), $[1]]),
	Rule(['specifier_qualifier_list', type_qualifier] as const, 			$ => [...($[0] as DeclSpecItem[]), $[1]]),
),

// --- Declarators / declarations ---
storage_class_specifier = Rules(//<StorageClass>(
	{ rhs: ['typedef'], 													action: () => 'typedef' as const},
	{ rhs: ['extern'], 														action: () => 'extern'  as const},
	{ rhs: ['static'], 														action: () => 'static'  as const},
),

declaration_specifiers = Rules(
	Rule([specifier_qualifier_list] as const, 								$ => { pendingTypedef = false; return [...($[0])]; }),
	Rule([specifier_qualifier_list, storage_class_specifier] as const, 		$ => { pendingTypedef = $[1] === 'typedef'; return [...($[0]), $[1]]; }),
	Rule([storage_class_specifier, specifier_qualifier_list] as const, 		$ => { pendingTypedef = $[0] === 'typedef'; return [$[0], ...($[1])]; }),
),

pointer = Rules(//<Pointer>(
	{ rhs: ['*'], 															action: () => [{ level: 1 }] },
	{ rhs: ['*', 'pointer'], 												action: $ => [{ level: ($[1] as Pointer).length + 1 }, ...($[1] as Pointer)] },
),

// direct_declarator -> parameter_type_list stays a string: cheapest cut in the
// direct_declarator <-> parameter_declaration cycle (a function declarator's
// own parameter list is the only edge crossing back into that cycle).
direct_declarator = Rules<Declarator>(
	Rule([IDENT] as const,													$ => ({ type: 'identifier', name: $[0] } as const)),
	Rule(['direct_declarator', '(', ')'] as const,							$ => ({ type: 'function', name: $[0] as Declarator, parameters: [] as ParamOrVariadic[] } as const)),
	Rule(['direct_declarator', '(', 'parameter_type_list', ')'] as const,	$ => ({ type: 'function', name: $[0] as Declarator, parameters: $[2] as ParamOrVariadic[] } as const)),
	Rule(['direct_declarator', '[', type_specifier, ']'] as const, 			$ => ({ type: 'array', element: $[0] as Declarator, size: $[2] } as const)),
	Rule(['direct_declarator', '[', constant_expression, ']'] as const, 	$ => ({ type: 'array', element: $[0] as Declarator, size: $[2] } as const)),
),

declarator = Rules(
	Rule([direct_declarator] as const, 										$ => $[0]),
),

parameter_declaration = Rules(
	Rule([declaration_specifiers, declarator] as const, 					$ => ({ type: 'parameter', specifiers: $[0], declarator: $[1] } as const)),
	Rule([declaration_specifiers] as const, 								$ => ({ type: 'parameter', specifiers: $[0] } as const)),
),

parameter_list = Rules(
	Rule([parameter_declaration] as const, 									$ => [$[0]]),
	Rule(['parameter_list', ',', parameter_declaration] as const, 			$ => [...($[0] as ParameterDeclaration[]), $[2]]),
),

parameter_type_list = Rules(//<ParamOrVariadic[]>(
	Rule([parameter_list] as const, 										$ => $[0]),
	Rule([parameter_list, ',', '...'] as const, 							$ => [...($[0]), { type: 'variadic' } as const]),
),

init_declarator = Rules<InitDeclarator>(
	Rule([pointer, declarator] as const, 									$ => { const d = $[1]; if (pendingTypedef) typedefNames.add(declaratorName(d)); return { pointer: $[0], declarator: d }; }),
	Rule([declarator] as const, 											$ => { const d = $[0]; if (pendingTypedef) typedefNames.add(declaratorName(d)); return d; }),
	Rule([pointer, declarator, '=', expression] as const, 					$ => { const d = $[1]; if (pendingTypedef) typedefNames.add(declaratorName(d)); return { pointer: $[0], declarator: d, initializer: $[3] }; }),
	Rule([declarator, '=', expression] as const, 							$ => { const d = $[0]; if (pendingTypedef) typedefNames.add(declaratorName(d)); return { declarator: d, initializer: $[2] }; }),
),

init_declarator_list = Rules(
	Rule([init_declarator] as const, 										$ => [$[0]]),
	Rule(['init_declarator_list', ',', init_declarator] as const, 			$ => [...($[0] as InitDeclarator[]), $[2]]),
),

declaration = Rules(
	Rule([declaration_specifiers, ';'] as const, 							$ => ({ type: 'declaration', specifiers: $[0] } as const)),
	Rule([declaration_specifiers, init_declarator_list, ';'] as const, 		$ => ({ type: 'declaration', specifiers: $[0], initDeclarators: $[1] } as const)),
),

// --- Statements ---
// NOTE: 'declaration' already consumes its own trailing ';', so the
// declaration-based alternatives must not require a second one.
for_statement = Rules<ForClauses>(
	Rule([expression, ';'] as const, 										$ => ({ init: $[0], condition: undefined, update: undefined })),
	Rule([expression, ';', expression] as const, 							$ => ({ init: $[0], condition: $[2], update: undefined })),
	Rule([expression, ';', expression, ';', expression] as const, 			$ => ({ init: $[0], condition: $[2], update: $[4] as Expr })),
	Rule([declaration, expression] as const, 								$ => ({ init: $[0], condition: $[1], update: undefined })),
	Rule([declaration, expression, ';', expression] as const, 				$ => ({ init: $[0], condition: $[1], update: $[3] as Expr })),
),

expression_statement = Rules(
	{ rhs: [';'],														   	action: () => ({ type: 'empty_statement' }) },
	Rule([expression, ';'] as const, 										$ => $[0]),
),

// statement -> compound_statement stays a string: cheapest cut in the
// statement <-> compound_statement <-> statement_list cycle (it's 1 of
// statement's 13 alternatives, vs. 2 uses on statement_list's side).
statement = Rules(
	{ rhs: ['compound_statement'], 											action: $ => $[0] as Block },
	Rule([declaration] as const, 											$ => $[0]),
	Rule(['if', '(', expression, ')', 'statement'] as const, 				$ => ({ type: 'if', condition: $[2], then: $[4] })),
	Rule(['if', '(', expression, ')', 'statement', 'else', 'statement'] as const, $ => ({ type: 'if_else', condition: $[2], then: $[4], else: $[6] })),
	Rule(['while', '(', expression, ')', 'statement'] as const, 			$ => ({ type: 'while', condition: $[2], body: $[4] })),
	Rule(['for', '(', for_statement, ')', 'statement'] as const, 			$ => ({ type: 'for', ...($[2]), body: $[4] })),
	Rule(['switch', '(', expression, ')', 'statement'] as const, 			$ => ({ type: 'switch', condition: $[2], body: $[4] })),
	Rule(['case', constant_expression, ':', 'statement'] as const, 			$ => ({ type: 'case', value: $[1], body: $[3] })),
	{ rhs: ['default', ':', 'statement'], 									action: $ => ({ type: 'default', body: $[2] }) },
	{ rhs: ['break', ';'], 													action: () => ({ type: 'break' }) },
	{ rhs: ['continue', ';'], 												action: () => ({ type: 'continue' }) },
	Rule(['return', expression, ';'] as const, 								$ => ({ type: 'return', expression: $[1] })),
	{ rhs: ['return', ';'], 												action: () => ({ type: 'return' }) },
	Rule([expression_statement] as const, 									$ => $[0]),
),

statement_list = Rules(
	Rule([statement] as const, 												$ => [$[0]]),
	Rule(['statement_list', statement] as const, 							$ => [...($[0] as Statement[]), $[1]]),
),

compound_statement = Rules(
	Rule(['{', statement_list, '}'] as const, 								$ => ({ type: 'block', statements: $[1] })),
	{ rhs: ['{', '}'], 														action: () => ({ type: 'block', statements: [] }) },
),

// --- Top level ---
function_definition = Rules(
	Rule([declaration_specifiers, declarator, compound_statement] as const, $ => ({ type: 'function_def', specifiers: $[0], declarator: $[1], body: $[2] } as const)),
),

external_definition = Rules<Definition>(
	Rule([declaration] as const, 											$ => $[0]),
	Rule([function_definition] as const, 									$ => $[0] as Definition),
),

translation_unit = Rules(
	Rule([external_definition] as const, 									$ => ({ type: 'translation_unit', definitions: [$[0]] } as const)),
	Rule(['translation_unit', external_definition] as const, 				$ => ({ ...($[0] as TranslationUnit), definitions: [...($[0] as TranslationUnit).definitions, $[1]] } as const)),
);

const cGrammar = tison({
	skip: [/\s+/, PREPROCESSOR, /\/\/[^\n]*/, /\/\*[^]*?\*\//],
	precedence: PREC_LEVELS,
	start: 'translation_unit',
	rules: {
		translation_unit,
		external_definition,
		type_specifier,
		type_qualifier,
		specifier_qualifier_list,
		struct_or_union_specifier,
		struct_body,
		struct_declaration_list,
		struct_declaration,
		struct_declarator_list,
		struct_declarator,
		enum_specifier,
		enumerator_list,
		enumerator,
		declaration,
		declaration_specifiers,
		storage_class_specifier,
		init_declarator_list,
		init_declarator,
		pointer,
		declarator,
		direct_declarator,
		parameter_type_list,
		parameter_list,
		parameter_declaration,
		function_definition,
		compound_statement,
		statement_list,
		statement,
		for_statement,
		expression_statement,
		expression,
/*
		assignment_expression,
		logical_or_expression,
		logical_and_expression,
		equality_expression,
		relational_expression,
		additive_expression,
		multiplicative_expression,
		cast_expression,
		unary_expression,
*/
		postfix_expression,
		argument_expression_list,
		primary_expression,
		constant_expression,
	},
});

// --- Export the parser ---
export const cParser = cGrammar;

function test(name: string, code: string) {
	// Each test is an independent translation unit -- don't let typedef names
	// declared in one leak into the next (cParser/typedefNames are singletons).
	typedefNames.clear();
	pendingTypedef = false;
	try {
		console.log(name);
		console.log(JSON.stringify(cParser.parse(code), null, 2));
	} catch (e) {
		console.error(`${name} failed:`, e);
	}
}


// --- Test the parser ---
console.log('Testing C Parser...\n');

test('ambiguous',`
typedef int foo;
foo * bar;   // declaration of bar as pointer-to-foo or multiplication of foo and bar?
`);

// Test 1: Simple function definition
test('Function Definition', `
int main() {
	return 0;
}
`);

// Test 2: Expression parsing
test('Complex Expression', `
int foo(int a, int b) {
	return a + b * c;
}
`);


// Test 3: If-else statement
test('If else',`
int bar(int x) {
	if (x > 0) {
		return 1;
	} else {
		return -1;
	}
}
`);

// Test 4: Struct definition
test('Struct',`
struct Point {
	int x;
	float y;
};
`);

// Test 5: For loop
test('For', `
int sum(int n) {
	int total = 0;
	for (int i = 0; i < n; i++) {
		total += i;
	}
	return total;
}
`);

// Test 6: chained assignment -- must parse as a = (b = c), not (a = b) = c
test('Chained assignment', `
int main() {
	int a, b, c;
	a = b = c;
}
`);


console.log('\nAll tests completed!');
