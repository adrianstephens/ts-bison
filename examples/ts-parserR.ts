import { makeParser, Rule, RuleR, Rules, RRules, Forward, List, OneOf, terminal, forceFork, WithPrec } from '../src/tison';
import {
	IDENT, NUMBER, STRING, unquoteString,
	jsRules, jsSkip, jsRecover,
	program, parameter, parameter_clause, formal_parameter_list, relational_expression, member_expression, call_expression, left_hand_side_expression, arguments_,
	arrow_function, arrow_body,
	variable_declaration, variable_declaration_noin, variable_statement,
	function_expression, function_declaration, function_body,
	class_member_body, class_member, class_member_name, class_declaration, class_expression, class_body,
	statement, export_declaration, assignment_expression,
	type Expr, type Statement,
} from './js-parserR';

// ===================================================================
//  TypeScript Parser -- an extension of js-parser
// ===================================================================
//
// Known simplifications/omissions:
//   - 'type'/'interface'/'enum'/'implements'/'keyof'/'readonly'/'public'/'private'/'protected'/'abstract'/'as'/'satisfies'/'declare' are not fully contextual only
//   - Arrow functions support typed parameters (`(x: T) => ...`, including a single bare `x: T => ...` with no parens) and a typed return  (`(x: T): U => ...`), via `parameter_clause` directly
//     -- but not generics (`<T>(x: T) => ...`), which nothing here adds.
//     Untyped arrow  params still go through the older route, reinterpreting an already-parsed plain `expression` (see js-parser's `exprToParams`),
//     Both routes share the same `(` prefix as a plain parenthesized expression and, for the bare `x: T => ...` form, the same leading identifier as any other expression
//     -- both are genuinely ambiguous one token in (e.g. `x: T` could be that arrow's parameter, or `x` could just be an identifier with `:` meaning something else entirely,
//     like a ternary's separator) and need `prec: 'forceFork'` to force GLR to explore both rather than silently committing to one.
//   - Class generics never extend onto the superclass (`class Foo<T> extends Bar<T>`):
//     the superclass is still just a plain expression (`left_hand_side_expression`), so `Bar<T>` there would be misread as two relational comparisons,
//     same ambiguity real TypeScript resolves with semantic, not syntactic, lookahead.
//   - No template literal types, no decorators, no `declare namespace`/declare module` (only ambient var/function/class/enum)
//   - no abstract *members* combined with generics
//   - no private `#name` members
//   - Mapped types have no `as`-clause key remapping (`[K in T as U]`) and no `+`/`-` modifier-removal forms (`-readonly`/`-?`).
//   - Index signatures (`[key: string]: T`) and call signatures (bare  `(...): T`) are not supported in `set` (a setter's "return type" is always `void`, so there'd be nothing meaningful to record).
//   - Generic type parameters are not combined with `abstract` classes (kept to the bare/extends/implements shapes to avoid doubling that list again) or
//     with generator methods (kept to plain/async methods, for the same reason).

// --- AST types ---

export interface TSTypeParam { name: string; constraint?: TSType; default?: TSType; }
export interface TSParam { name: string; optional?: boolean; rest?: boolean; typeAnnotation?: TSType; }

export type TSTypeMember =
	| { kind: 'property'; name: string; optional?: boolean; readonly?: boolean; typeAnnotation: TSType }
	| { kind: 'method'; name: string; optional?: boolean; params: TSParam[]; returnType?: TSType }
	| { kind: 'index'; paramName: string; paramType: TSType; typeAnnotation: TSType }
	| { kind: 'call'; params: TSParam[]; returnType?: TSType };

// No `as`-clause key remapping (`[K in T as U]`) -- a known simplification.
export interface TSMappedType { keyName: string; constraint: TSType; valueType: TSType; readonly?: boolean; optional?: boolean; }

export type TSType =
	| { type: 'ref'; name: string; typeArgs?: TSType[] }
	| { type: 'literal'; value: string | number | boolean | null }
	| { type: 'this' }
	| { type: 'array'; element: TSType }
	| { type: 'tuple'; elements: TSType[] }
	| { type: 'union'; types: TSType[] }
	| { type: 'intersection'; types: TSType[] }
	| { type: 'function'; params: TSParam[]; returnType: TSType }
	| { type: 'object'; members: TSTypeMember[] }
	| { type: 'parenthesized'; inner: TSType }
	| { type: 'keyof'; argument: TSType }
	| { type: 'readonly'; argument: TSType }
	| { type: 'typeof'; name: string }
	| { type: 'indexed_access'; object: TSType; index: TSType }
	| { type: 'conditional'; checkType: TSType; extendsType: TSType; trueType: TSType; falseType: TSType }
	| { type: 'infer'; name: string }
	| ({ type: 'mapped' } & TSMappedType)
	| { type: 'predicate'; paramName: string; assertedType: TSType };

export interface TSEnumMember { name: string; init?: Expr; }

export type TSDeclaration =
	| { type: 'interface_decl'; name: string; typeParams?: TSTypeParam[]; extendsClause?: TSType[]; body: TSTypeMember[] }
	| { type: 'type_alias_decl'; name: string; typeParams?: TSTypeParam[]; value: TSType }
	| { type: 'enum_decl'; name: string; const?: boolean; members: TSEnumMember[] };

// `declare var/function/class/enum ...` 
// -- TypeScript also allows `declare namespace`/`declare module`, neither of which this file supports at all.
export interface TSAmbientDeclaration { type: 'declare'; declaration: Statement | TSDeclaration; }

export type TSStatement = Statement | TSDeclaration | TSAmbientDeclaration;
export interface TSProgram { type: 'program'; body: TSStatement[]; }

// ===================================================================
//  Type grammar
// ===================================================================

const type = Rules<TSType>(
	RuleR(Forward<TSType>(()=>conditional_type)),
);

const type_list = List(type, ',');

// --- Generic calls: `foo<T>(...)` ---
//
// Unlike the statement-level generics above (interface/class/function headers), a call's `<...>`
// sits in expression position, where `relational_expression`'s own `<`/`>` chain is also live --
// `foo<T>(x)` and `foo < T > (x)` (two chained comparisons against a parenthesized `x`) are
// genuinely ambiguous to a context-free grammar, the same ambiguity real TypeScript itself only
// resolves with the type checker, not the parser. Routing it through tison's GLR fork engine (one
// fork per reading) would work semantically, but every single ordinary `<` in the file -- the
// overwhelmingly common case -- would also fork, and forks compound at *every* nested `<` inside
// the speculative branch before either one fails; on a real source file that's a combinatorial
// blow-up, not a curiosity.
//
// So this is resolved in the lexer instead, the same trick REGEX_LITERAL/WS use in js-parser.ts:
// a dedicated terminal for this specific '<' character that scans the raw upcoming text (via
// `remaining`, before any tokenizing) for a balanced run of plausible type-argument syntax
// (identifiers, `.`, `,`, nested `<>`/`[]`/`{}`, `:`/`;` for inline object-type members,
// whitespace -- no operators, no parens) immediately followed by '('. If that scan fails, `lex`
// rejects the match and the plain `<` terminal (the same one `relational_expression`'s own
// comparison chain shifts on) wins instead, so plain `a < b` stays exactly as cheap as it always was.
// Known simplification: a type argument containing a function type (`Foo<(x: T) => void>(...)`)
// or another call/parenthesized expression won't be recognized, since `(`/`)` aren't in the
// allowed set -- narrowing the heuristic was judged a smaller risk than widening it into more
// false positives against real comparison chains.
const GENERIC_CALL_SCAN_LIMIT = 200;
function looksLikeGenericCallArgs(textAfterLt: string): boolean {
	let depth = 1;
	// `braceDepth` gates `;` separately from the rest of the allowed-character class: it's only
	// plausible as an inline object-type member separator (`{ a: A; b: B }`), never as a bare
	// top-level statement separator -- without this, the scan could cross a real `;` further down
	// the file and stumble onto some unrelated `>(` that only looks like this generic call's close.
	let braceDepth = 0;
	for (let i = 0; i < textAfterLt.length && i < GENERIC_CALL_SCAN_LIMIT; i++) {
		const c = textAfterLt[i];
		if (c === '<') {
			depth++;
		} else if (c === '>') {
			if (--depth === 0)
				return /^\s*\(/.test(textAfterLt.slice(i + 1));
		} else if (c === '{') {
			braceDepth++;
		} else if (c === '}') {
			if (--braceDepth < 0)
				return false;
		} else if (c === ';') {
			if (braceDepth === 0)
				return false;
		} else if (!/[A-Za-z0-9_$.,\s[\]:]/.test(c)) {
			return false;
		}
	}
	return false;
}
// Matched via `\x3c` rather than a plain `/</` so its `.pattern.source` ("\x3c") sorts ahead of
// the plain `<` terminal's own source ("<") on the tokenizer's length-tie pattern-source
// comparison (see the tie-break comment above) -- both match exactly one '<' character; this only
// changes which one the tokenizer offers its `lex` hook first when both are valid in the current
// parser state, so this terminal's scan gets a chance to run/reject before the no-`lex` plain `<`
// terminal auto-accepts. (Type-position generics -- `type_parameters`, `primary_type`'s
// `IDENT '<' type_list '>'` -- don't need any of this: they're never reachable from expression
// position, so the plain `<` is never actually a competing candidate there.)
const genericCallOpen = terminal('<call-generics>', /\x3c/,
	({ remaining }) => looksLikeGenericCallArgs(remaining.slice(1)) ? genericCallOpen : undefined
);
const call_type_arguments = Rules<TSType[]>(
	RuleR(genericCallOpen, type_list, '>',		$ => $[1]),
);

const type_parameter = Rules<TSTypeParam>(
	RuleR(IDENT,								$ => ({ name: $[0] })),
	RuleR(IDENT, 'extends', type,				$ => ({ name: $[0], constraint: $[2] })),
	RuleR(IDENT, '=', type,						$ => ({ name: $[0], default: $[2] })),
	RuleR(IDENT, 'extends', type, '=', type,	$ => ({ name: $[0], constraint: $[2], default: $[4] })),
);
const type_parameter_list = List(type_parameter, ',');
const type_parameters = Rules<TSTypeParam[]>(
	RuleR('<', type_parameter_list, '>',		$ => $[1]),
);

// --- Simplified parameter list, for function types and call/method signatures (no defaults, no destructuring -- a known simplification) ---

const ts_param = Rules<TSParam>(
	RuleR(IDENT,							$ => ({ name: $[0] })),
	RuleR(IDENT, '?',						$ => ({ name: $[0], optional: true })),
	RuleR(IDENT, ':', type,					$ => ({ name: $[0], typeAnnotation: $[2] })),
	RuleR(IDENT, '?', ':', type,			$ => ({ name: $[0], optional: true, typeAnnotation: $[3] })),
	RuleR('...', IDENT,						$ => ({ name: $[1], rest: true })),
	RuleR('...', IDENT, ':', type,			$ => ({ name: $[1], rest: true, typeAnnotation: $[3] })),
);
const ts_param_list = List(ts_param, ',');
const ts_param_list_opt = Rules<TSParam[]>(
	RuleR(				() => []),
	RuleR(ts_param_list),
);

// --- Object type literal / interface body members ---

const type_member = Rules<TSTypeMember>(
	RuleR(IDENT, ':', type,										$ => ({ kind: 'property', name: $[0], typeAnnotation: $[2] })),
	RuleR(IDENT, '?', ':', type,								$ => ({ kind: 'property', name: $[0], optional: true, typeAnnotation: $[3] })),
	RuleR('readonly', IDENT, ':', type,							$ => ({ kind: 'property', name: $[1], readonly: true, typeAnnotation: $[3] })),
	RuleR('readonly', IDENT, '?', ':', type,					$ => ({ kind: 'property', name: $[1], readonly: true, optional: true, typeAnnotation: $[4] })),
	RuleR(IDENT, '(', ts_param_list_opt, ')',					$ => ({ kind: 'method', name: $[0], params: $[2] })),
	RuleR(IDENT, '(', ts_param_list_opt, ')', ':', type,		$ => ({ kind: 'method', name: $[0], params: $[2], returnType: $[5] })),
	RuleR(IDENT, '?', '(', ts_param_list_opt, ')',				$ => ({ kind: 'method', name: $[0], optional: true, params: $[3] })),
	RuleR(IDENT, '?', '(', ts_param_list_opt, ')', ':', type,	$ => ({ kind: 'method', name: $[0], optional: true, params: $[3], returnType: $[6] })),
	RuleR('[', IDENT, ':', type, ']', ':', type,				$ => ({ kind: 'index', paramName: $[1], paramType: $[3], typeAnnotation: $[6] })),
	RuleR('(', ts_param_list_opt, ')', ':', type,				$ => ({ kind: 'call', params: $[1], returnType: $[4] })),
);
// `;`-separated, with an optional trailing `;` -- this grammar doesn't also accept `,` as a member separator (real TypeScript allows either), a known simplification.
const type_member_list = List(type_member, ';');
const type_member_body = Rules<TSTypeMember[]>(
	RuleR('{', '}',							() => []),
	RuleR('{', type_member_list, '}',		$ => $[1]),
	RuleR('{', type_member_list, ';', '}',	$ => $[1]),
);

// --- Type expression precedence chain: primary -> postfix array -> keyof -> intersection -> union ---

function parseTypeNumber(text: string): number {
	return parseFloat(text.replace(/_/g, ''));
}

// `{ [K in T]: U }`, with an optional `readonly` prefix and `?` optional-modifier suffix. No
// `+`/`-` modifier-removal forms (`-readonly`/`-?`) and no `as`-clause key remapping
// (`[K in T as U]`) -- known simplifications, same spirit as this file's other omissions.
// Shares its `{ [` opening with `type_member`'s index signature (`{ [key: string]: T }`) --
// they diverge cleanly one token later, on `in` vs `:`, so there's no real ambiguity for the
// LALR table to resolve, just two alternatives reachable from the same prefix.
const mapped_type = Rules<TSType>(
	RuleR('{', '[', IDENT, 'in', type, ']', ':', type, '}',						$ => ({ type: 'mapped', keyName: $[2], constraint: $[4], valueType: $[7] })),
	RuleR('{', '[', IDENT, 'in', type, ']', '?', ':', type, '}',				$ => ({ type: 'mapped', keyName: $[2], constraint: $[4], optional: true, valueType: $[8] })),
	RuleR('{', 'readonly', '[', IDENT, 'in', type, ']', ':', type, '}',			$ => ({ type: 'mapped', keyName: $[3], constraint: $[5], readonly: true, valueType: $[8] })),
	RuleR('{', 'readonly', '[', IDENT, 'in', type, ']', '?', ':', type, '}',	$ => ({ type: 'mapped', keyName: $[3], constraint: $[5], readonly: true, optional: true, valueType: $[9] })),
);

const primary_type = Rules<TSType>(
	RuleR(IDENT,										$ => ({ type: 'ref', name: $[0] })),
	RuleR(IDENT, '<', type_list, '>',					$ => ({ type: 'ref', name: $[0], typeArgs: $[2] })),
	RuleR('this',										_ => ({ type: 'this' })),
	RuleR('null',										_ => ({ type: 'literal', value: null })),
	RuleR('true',										_ => ({ type: 'literal', value: true })),
	RuleR('false',										_ => ({ type: 'literal', value: false })),
	RuleR(STRING,										$ => ({ type: 'literal', value: unquoteString($[0]) })),
	RuleR(NUMBER,										$ => ({ type: 'literal', value: parseTypeNumber($[0]) })),
	RuleR('typeof', IDENT,								$ => ({ type: 'typeof', name: $[1] })),
	// `infer` only makes sense inside a conditional type's `extends` operand in real TypeScript, but enforcing that is a checker-level restriction there too, not a grammar one
	// -- allowing it as an ordinary primary type everywhere is simpler and parses every real use of it.
	RuleR('infer', IDENT,								$ => ({ type: 'infer', name: $[1] })),
	RuleR('(', type, ')',								$ => ({ type: 'parenthesized', inner: $[1] })),
	RuleR('[', ']',										_ => ({ type: 'tuple', elements: [] })),
	RuleR('[', type_list, ']',							$ => ({ type: 'tuple', elements: $[1] })),
	RuleR(type_member_body,								$ => ({ type: 'object', members: $[0] })),
	RuleR(mapped_type),
	RuleR('(', ts_param_list_opt, ')', '=>', type,		$ => ({ type: 'function', params: $[1], returnType: $[4] })),
);
// Postfix `[]`/`[K]`: left-recursive so `T[][]`/`T[K][J]` stack correctly.
// The empty- and type-filled bracket forms don't conflict -- they diverge on the very next token (`]` vs. a type-start token),
// the same one-token lookahead distinction `array_literal`'s elisions and ordinary elements already rely on in js-parser.ts.
const array_type = RRules<TSType>(self => [
	RuleR(primary_type),
	RuleR(self, '[', ']',				$ => ({ type: 'array', element: $[0] })),
	RuleR(self, '[', type, ']',			$ => ({ type: 'indexed_access', object: $[0], index: $[2] })),
]);
const unary_type = Rules<TSType>(
	RuleR(array_type),
	RuleR('keyof', array_type,			$ => ({ type: 'keyof', argument: $[1] })),
	// `readonly` only ever prefixes an array (`readonly T[]`) or tuple (`readonly [string, number]`) type -- both are `array_type` alternatives already,
	// so reusing it here (rather than `fwd_type`) rejects `readonly` in front of anything else, matching real TypeScript.
	RuleR('readonly', array_type,		$ => ({ type: 'readonly', argument: $[1] })),
);
// `&`/`|` reuse `List` directly: each level is just a separated list of the level below, flattened into a `TSType[]` and only wrapped in a union/intersection node when there's more than one member
// -- no precedence declarations are needed since (as in js-parser.ts's own binary chain) each level is its own nonterminal, so the grammar structure alone keeps '&' and '|' from ever competing for the same reduction.
const intersection_list = List(unary_type, '&');
const intersection_type = Rules<TSType>(
	RuleR(intersection_list, 			$ => $[0].length === 1 ? $[0][0] : ({ type: 'intersection', types: $[0] })),
	// A leading `&` before the first member is purely stylistic (common for multi-line declarations) and carries no meaning of its own.
	RuleR('&', intersection_list,		$ => $[1].length === 1 ? $[1][0] : ({ type: 'intersection', types: $[1] })),
);
const union_list = List(intersection_type, '|');
const union_type = Rules<TSType>(
	RuleR(union_list,					$ => $[0].length === 1 ? $[0][0] : ({ type: 'union', types: $[0] })),
	// Same leading-separator allowance as intersection_type's `&`, one level up.
	RuleR('|', union_list,				$ => $[1].length === 1 ? $[1][0] : ({ type: 'union', types: $[1] })),
);
// Conditional types: `CheckType extends ExtendsType ? TrueType : FalseType`.
// The check/extends operands are restricted to `union_type` (not the full conditional grammar) to avoid recursive ambiguity around nested `?`/`:`
// -- the same reason real TypeScript's own grammar restricts them to NoConditionalType.
// True/false branches are the full `fwd_type`, so chains like `T extends A ? X : T extends B ? Y : Z` thread through the false branch like a chained `?:`.
const conditional_type = Rules<TSType>(
	RuleR(union_type),
	RuleR(union_type, 'extends', union_type, '?', type, ':', type,	$ => ({ type: 'conditional', checkType: $[0], extendsType: $[2], trueType: $[4], falseType: $[6] })),
);

const return_type = Rules<TSType>(
	RuleR(type),
	RuleR(IDENT, 'is', type,			$ => ({ type: 'predicate', paramName: $[0], assertedType: $[2] })),
);

// ===================================================================
//  Declarations: `type`, `interface`, `enum`
// ===================================================================

const type_alias_declaration = Rules<TSDeclaration>(
	RuleR('type', IDENT, '=', type, ';',					$ => ({ type: 'type_alias_decl', name: $[1], value: $[3] })),
	RuleR('type', IDENT, type_parameters, '=', type, ';',	$ => ({ type: 'type_alias_decl', name: $[1], typeParams: $[2], value: $[4] })),
);

const extends_clause = Rules<TSType[]>(
	RuleR('extends', type_list, $ => $[1]),
);
const interface_declaration = Rules<TSDeclaration>(
	RuleR('interface', IDENT, type_member_body,										$ => ({ type: 'interface_decl', name: $[1], body: $[2] })),
	RuleR('interface', IDENT, type_parameters, type_member_body,					$ => ({ type: 'interface_decl', name: $[1], typeParams: $[2], body: $[3] })),
	RuleR('interface', IDENT, extends_clause, type_member_body,						$ => ({ type: 'interface_decl', name: $[1], extendsClause: $[2], body: $[3] })),
	RuleR('interface', IDENT, type_parameters, extends_clause, type_member_body,	$ => ({ type: 'interface_decl', name: $[1], typeParams: $[2], extendsClause: $[3], body: $[4] })),
);

const enum_member = Rules<TSEnumMember>(
	RuleR(IDENT,									$ => ({ name: $[0] })),
	RuleR(IDENT, '=', assignment_expression,		$ => ({ name: $[0], init: $[2] })),
	RuleR(STRING,									$ => ({ name: unquoteString($[0]) })),
	RuleR(STRING, '=', assignment_expression,		$ => ({ name: unquoteString($[0]), init: $[2] })),
);
const enum_member_list = List(enum_member, ',');
const enum_declaration = Rules<TSDeclaration>(
	RuleR('enum', IDENT, '{', '}',									$ => ({ type: 'enum_decl', name: $[1], members: [] })),
	RuleR('enum', IDENT, '{', enum_member_list, '}',				$ => ({ type: 'enum_decl', name: $[1], members: $[3] })),
	RuleR('enum', IDENT, '{', enum_member_list, ',', '}',			$ => ({ type: 'enum_decl', name: $[1], members: $[3] })),
	RuleR('const', 'enum', IDENT, '{', '}',							$ => ({ type: 'enum_decl', name: $[2], const: true, members: [] } )),
	RuleR('const', 'enum', IDENT, '{', enum_member_list, '}',		$ => ({ type: 'enum_decl', name: $[2], const: true, members: $[4] })),
	RuleR('const', 'enum', IDENT, '{', enum_member_list, ',', '}',	$ => ({ type: 'enum_decl', name: $[2], const: true, members: $[4] })),
);

// `declare function` can't reuse `function_declaration` as-is: an ambient function has no body at all
const declare_function = Rules<Statement>(
	RuleR('function', IDENT, parameter_clause, ';',						$ => ({ type: 'function_decl', name: $[1], ...$[2] })),
	RuleR('function', IDENT, parameter_clause, ':', return_type, ';',	$ => ({ type: 'function_decl', name: $[1], ...$[2], returnType: $[4] })),
	// Generic overload signatures (`function foo<T>(x: T): T;`) -- same bodyless shape as above,
	// just with type parameters. Bodyless `declare_function` is reused rather than added to
	// `function_declaration` itself for the same reason as the ambient case below: this is the one
	// place a function declaration can omit its body at all.
	RuleR('function', IDENT, type_parameters, parameter_clause, ';',					$ => ({ type: 'function_decl', name: $[1], ...$[3], typeParams: $[2] })),
	RuleR('function', IDENT, type_parameters, parameter_clause, ':', return_type, ';',	$ => ({ type: 'function_decl', name: $[1], ...$[3], typeParams: $[2], returnType: $[5] })),
);

// Extend `statement` (reachable from both block bodies and, via `module_item`'s own `[statement]` rule, the top level) so these
// declarations work in either place, exactly like the rest of TypeScript's declarations. `statement`'s static element type is the closed `Statement`
// union from js-parser.ts; widening it to also produce `TSDeclaration` needs one cast at the array level (the runtime array is untouched by the
// cast -- it's the same array `module_item`/`program` already read from).
const tsStatement = statement as unknown as Rules<TSStatement>;
tsStatement.push(
	RuleR(interface_declaration),
	RuleR(type_alias_declaration),
	RuleR(enum_declaration),

// `declare_function` doubles as a plain (non-ambient) overload signature
// -- real TypeScript lets `function foo<T>(x: T): T;` stand alone, preceding a same-named implementation elsewhere;
// this grammar doesn't check that the names/signatures actually line up with a later implementation, the same spirit as its other syntax-only simplifications.
	RuleR(declare_function),

	RuleR('declare', variable_statement,	$ => ({ type: 'declare', declaration: $[1] })),
	RuleR('declare', function_declaration,	$ => ({ type: 'declare', declaration: $[1] })),
	RuleR('declare', declare_function,		$ => ({ type: 'declare', declaration: $[1] })),
	RuleR('declare', class_declaration,		$ => ({ type: 'declare', declaration: $[1] })),
	RuleR('declare', enum_declaration,		$ => ({ type: 'declare', declaration: $[1] })),
);

const tsExportDeclaration = export_declaration as unknown as Rules<TSStatement>;
tsExportDeclaration.push(
	RuleR('export', interface_declaration,	$ => $[1]),
	RuleR('export', type_alias_declaration,	$ => $[1]),
	RuleR('export', enum_declaration,		$ => $[1]),
	// js-parser.ts's own `Rule(['export', function_declaration], ...)` doesn't cover this -- `declare_function`'s bodyless overload-signature shape is a separate nonterminal (see above)
	RuleR('export', declare_function,		$ => ({ type: 'export_decl', declaration: $[1] })),
);

// ===================================================================
//  Typed parameters (function/method/constructor)
// ===================================================================
//
// `parameter` is shared by every parameter list in js-parser.ts (function expressions/declarations, object-literal shorthand methods, class methods/constructors) via `parameter_clause`/`formal_parameter_list`
// -- extending it once here adds typed (and, for constructors, modifier-carrying "parameter property") parameters everywhere at once.

const param_modifier_list = List(OneOf(['public', 'private', 'protected', 'readonly']));

parameter.push(
	// `(a ? b : c)` and `(a?) => ...` (a typed-arrow-candidate's bare optional parameter) are
	// genuinely ambiguous right after shifting `a`: the table can't tell, from one token of
	// lookahead, whether `?` starts a ternary or marks `a` optional -- and since arrow_function's
	// `parameter_clause`-based rule shares the same `(` as a plain parenthesized expression, this
	// rule's `IDENT '?'` shift-reduce-conflicts with `primary_expression -> identifier` reducing
	// toward the ternary, silently defaulting to shift (i.e. always "optional param") without
	// `forceFork`. Marking it `'fork'` instead explores both and keeps whichever one parses.
	WithPrec(RuleR(IDENT, '?', 									$ => ({ target: $[0], optional: true })), forceFork),
	RuleR(IDENT, ':', type,										$ => ({ target: $[0], typeAnnotation: $[2] })),
	RuleR(IDENT, '?', ':', type,								$ => ({ target: $[0], optional: true, typeAnnotation: $[3] })),
	RuleR(IDENT, ':', type, '=', assignment_expression,			$ => ({ target: $[0], typeAnnotation: $[2], default: $[4] })),
	// Parameter properties (`constructor(public x: number)`): valid anywhere a parameter is, not just inside a constructor -- this syntax-only grammar doesn't check that, a known simplification.
	RuleR(param_modifier_list, IDENT,							$ => ({ target: $[1], modifiers: $[0] })),
	RuleR(param_modifier_list, IDENT, ':', type,				$ => ({ target: $[1], modifiers: $[0], typeAnnotation: $[3] })),
	RuleR(param_modifier_list, IDENT, '?', ':', type,			$ => ({ target: $[1], optional: true, modifiers: $[0], typeAnnotation: $[4] })),
);

// `parameter_clause` embeds its own `'...' IDENT` rest-parameter forms directly (rather than going
// through `parameter`, which only ever handles non-rest parameters), so typed rest parameters
// (`...args: T[]`) need their own variants pushed here too, mirroring js-parser.ts's untyped ones.
parameter_clause.push(
	RuleR('(', '...', IDENT, ':', type, ')',								$ => ({ params: [], rest: $[2], restType: $[4] })),
	RuleR('(', formal_parameter_list, ',', '...', IDENT, ':', type, ')',	$ => ({ params: $[1], rest: $[4], restType: $[6] })),
);

// ===================================================================
//  Return types & generics on function/method declarations & expressions
// ===================================================================
//
// Mirrors js-parser.ts's own `function_expression`/`function_declaration`/`class_member_body` shapes,
// just with `<T>` and/or `: Type` inserted before the parameter list and/or the body's `{`.
// Arrow functions are deliberately not extended this way -- see the header comment.
// The `<T>` insertions reuse `type_parameters` exactly as-is -- the same machinery already proven to disambiguate `<`/`>` correctly for classes/interfaces/type aliases above,
// so there's no new ambiguity risk here, just more alternatives of an already-working shape.

// `restType: $[N].restType` alongside `params`/`rest` -- a typed rest parameter's type (set by `parameter_clause`'s typed-rest pushes above)
// would otherwise silently be dropped here, the one piece `params`/`rest` alone don't carry.
function_expression.push(
	RuleR('function', parameter_clause, ':', type, '{', function_body, '}',							$ => ({ type: 'function', params: $[1].params, rest: $[1].rest, restType: $[1].restType, body: $[5], returnType: $[3] })),
	RuleR('function', IDENT, parameter_clause, ':', type, '{', function_body, '}',					$ => ({ type: 'function', name: $[1], params: $[2].params, rest: $[2].rest, restType: $[2].restType, body: $[6], returnType: $[4] })),
	RuleR('async', 'function', parameter_clause, ':', type, '{', function_body, '}',				$ => ({ type: 'function', params: $[2].params, rest: $[2].rest, restType: $[2].restType, body: $[6], async: true, returnType: $[4] })),
	RuleR('async', 'function', IDENT, parameter_clause, ':', type, '{', function_body, '}',			$ => ({ type: 'function', name: $[2], params: $[3].params, rest: $[3].rest, restType: $[3].restType, body: $[7], async: true, returnType: $[5] })),
	// Generics (anonymous/named, with/without a return type -- not combined with `async`, see header comment).
	RuleR('function', type_parameters, parameter_clause, '{', function_body, '}',					$ => ({ type: 'function', params: $[2].params, rest: $[2].rest, restType: $[2].restType, body: $[4], typeParams: $[1] })),
	RuleR('function', type_parameters, parameter_clause, ':', type, '{', function_body, '}',		$ => ({ type: 'function', params: $[2].params, rest: $[2].rest, restType: $[2].restType, body: $[6], typeParams: $[1], returnType: $[4] })),
	RuleR('function', IDENT, type_parameters, parameter_clause, '{', function_body, '}',			$ => ({ type: 'function', name: $[1], params: $[3].params, rest: $[3].rest, restType: $[3].restType, body: $[5], typeParams: $[2] })),
	RuleR('function', IDENT, type_parameters, parameter_clause, ':', type, '{', function_body, '}', $ => ({ type: 'function', name: $[1], params: $[3].params, rest: $[3].rest, restType: $[3].restType, body: $[7], typeParams: $[2], returnType: $[5] })),
);
function_declaration.push(
	RuleR('function', IDENT, parameter_clause, ':', return_type, '{', function_body, '}',			$ => ({ type: 'function_decl', name: $[1], params: $[2].params, rest: $[2].rest, restType: $[2].restType, body: $[6], returnType: $[4] })),
	RuleR('async', 'function', IDENT, parameter_clause, ':', return_type, '{', function_body, '}',	$ => ({ type: 'function_decl', name: $[2], params: $[3].params, rest: $[3].rest, restType: $[3].restType, body: $[7], async: true, returnType: $[5] })),
	// Generics (with/without a return type, plain or `async`).
	RuleR('function', IDENT, type_parameters, parameter_clause, '{', function_body, '}',			$ => ({ type: 'function_decl', name: $[1], params: $[3].params, rest: $[3].rest, restType: $[3].restType, body: $[5], typeParams: $[2] })),
	RuleR('function', IDENT, type_parameters, parameter_clause, ':', return_type, '{', function_body, '}', $ => ({ type: 'function_decl', name: $[1], params: $[3].params, rest: $[3].rest, restType: $[3].restType, body: $[7], typeParams: $[2], returnType: $[5] })),
	RuleR('async', 'function', IDENT, type_parameters, parameter_clause, '{', function_body, '}',	$ => ({ type: 'function_decl', name: $[2], params: $[4].params, rest: $[4].rest, restType: $[4].restType, body: $[6], typeParams: $[3], async: true })),
	RuleR('async', 'function', IDENT, type_parameters, parameter_clause, ':', return_type, '{', function_body, '}', $ => ({ type: 'function_decl', name: $[2], params: $[4].params, rest: $[4].rest, restType: $[4].restType, body: $[8], typeParams: $[3], async: true, returnType: $[6] })),
);

class_member_body.push(
	// Return types -- plain and async methods (already had this), plus generator/async-generator methods and the `get` accessor (the `set` accessor's "return type" would always just be `void`,
	// so it's skipped, same as js-parser.ts's own get/set asymmetry: `get`'s shape already differs from `set`'s by having no parameter).
	// `restType: $[N].restType` alongside `params`/`rest`, same reasoning as function_expression/function_declaration above.
	RuleR(class_member_name, parameter_clause, ':', type, '{', function_body, '}',					$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: $[1].params, rest: $[1].rest, restType: $[1].restType, body: $[5], returnType: $[3] } })),
	RuleR('async', class_member_name, parameter_clause, ':', type, '{', function_body, '}',			$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, restType: $[2].restType, body: $[6], async: true, returnType: $[4] } })),
	RuleR('*', class_member_name, parameter_clause, ':', type, '{', function_body, '}',				$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, restType: $[2].restType, body: $[6], generator: true, returnType: $[4] } })),
	RuleR('async', '*', class_member_name, parameter_clause, ':', type, '{', function_body, '}',	$ => ({ type: 'method', kind: 'method', key: $[2] as string | { computed: Expr }, value: { type: 'function', params: $[3].params, rest: $[3].rest, restType: $[3].restType, body: $[7], generator: true, async: true, returnType: $[5] } })),
	RuleR('get', class_member_name, '(', ')', ':', type, '{', function_body, '}',					$ => ({ type: 'method', kind: 'get', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: [], body: $[7], returnType: $[5] } })),
	// Generics (with/without a return type, plain or `async`).
	RuleR(class_member_name, type_parameters, parameter_clause, '{', function_body, '}',			$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, restType: $[2].restType, body: $[4], typeParams: $[1] } })),
	RuleR(class_member_name, type_parameters, parameter_clause, ':', type, '{', function_body, '}', $ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, restType: $[2].restType, body: $[6], typeParams: $[1], returnType: $[4] } })),
	RuleR('async', class_member_name, type_parameters, parameter_clause, '{', function_body, '}',	$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[3].params, rest: $[3].rest, restType: $[3].restType, body: $[5], typeParams: $[2], async: true } })),
	RuleR('async', class_member_name, type_parameters, parameter_clause, ':', type, '{', function_body, '}', $ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[3].params, rest: $[3].rest, restType: $[3].restType, body: $[7], typeParams: $[2], async: true, returnType: $[5] } })),
	// Optional methods (`foo?() {}`).
	RuleR(class_member_name, '?', parameter_clause, '{', function_body, '}',						$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, restType: $[2].restType, body: $[4] }, optional: true })),
	// Typed fields, optional fields, definite-assignment assertion (`x!: number;`).
	RuleR(class_member_name, ':', type, ';',														$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, typeAnnotation: $[2] })),
	RuleR(class_member_name, ':', type, '=', assignment_expression, ';',							$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, typeAnnotation: $[2], value: $[4] })),
	RuleR(class_member_name, '?', ':', type, ';',													$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, optional: true, typeAnnotation: $[3] })),
	RuleR(class_member_name, '?', ':', type, '=', assignment_expression, ';',						$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, optional: true, typeAnnotation: $[3], value: $[5] })),
	RuleR(class_member_name, '!', ':', type, ';',													$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, typeAnnotation: $[3], definite: true })),
);

// Static initialization blocks (`static { ... }`)
// -- pushed onto `class_member` directly (not `class_member_body`) since the shape doesn't fit the "static" + ordinary-member wrapping the modifiers push below already does: there's no member-name/key here at all.
class_member.push(
	RuleR('static', '{', function_body, '}', $ => ({ type: 'static_block', body: $[2] })),
);

// Member modifiers (`public`/`private`/`protected`/`readonly`/`abstract`), any number of them, optionally combined with `static`.
// Pushed onto `class_member` (not `class_member_body`) so they apply uniformly to every member shape -- including the ones just added above -- without duplicating each shape once per modifier combination.
const class_member_modifier_list = List(OneOf(['public', 'private', 'protected', 'readonly', 'abstract']));

class_member.push(
	RuleR(class_member_modifier_list, class_member_body,			$ => ({ ...$[1], modifiers: $[0] })),
	RuleR(class_member_modifier_list, 'static', class_member_body,	$ => ({ ...$[2], modifiers: $[0], static: true })),
);

// ===================================================================
//  Typed variable declarations
// ===================================================================

variable_declaration.push(
	RuleR(IDENT, ':', type,								$ => ({ name: $[0], typeAnnotation: $[2] })),
	RuleR(IDENT, ':', type, '=', assignment_expression,	$ => ({ name: $[0], typeAnnotation: $[2], init: $[4] })),
	// Definite-assignment assertion (`let x!: number;`).
	RuleR(IDENT, '!', ':', type,						$ => ({ name: $[0], typeAnnotation: $[3], definite: true })),
);
variable_declaration_noin.push(
	RuleR(IDENT, ':', type,								$ => ({ name: $[0], typeAnnotation: $[2] })),
	RuleR(IDENT, ':', type, '=', assignment_expression,	$ => ({ name: $[0], typeAnnotation: $[2], init: $[4] })),
);

// ===================================================================
//  Class generics & `implements`
// ===================================================================

const implements_clause = Rules<TSType[]>(
	RuleR('implements', type_list, $ => $[1]),
);

class_declaration.push(
	RuleR('class', IDENT, type_parameters, class_body,															$ => ({ type: 'class_decl', name: $[1], typeParams: $[2], body: $[3] })),
	RuleR('class', IDENT, type_parameters, 'extends', left_hand_side_expression, class_body,					$ => ({ type: 'class_decl', name: $[1], typeParams: $[2], superClass: $[4], body: $[5] })),
	RuleR('class', IDENT, implements_clause, class_body,														$ => ({ type: 'class_decl', name: $[1], implementsClause: $[2], body: $[3] })),
	RuleR('class', IDENT, type_parameters, implements_clause, class_body,										$ => ({ type: 'class_decl', name: $[1], typeParams: $[2], implementsClause: $[3], body: $[4] })),
	RuleR('class', IDENT, 'extends', left_hand_side_expression, implements_clause, class_body,					$ => ({ type: 'class_decl', name: $[1], superClass: $[3], implementsClause: $[4], body: $[5] })),
	RuleR('class', IDENT, type_parameters, 'extends', left_hand_side_expression, implements_clause, class_body,	$ => ({ type: 'class_decl', name: $[1], typeParams: $[2], superClass: $[4], implementsClause: $[5], body: $[6] })),
);
class_expression.push(
	RuleR('class', IDENT, type_parameters, class_body,															$ => ({ type: 'class', name: $[1], typeParams: $[2], body: $[3] })),
	RuleR('class', IDENT, implements_clause, class_body,														$ => ({ type: 'class', name: $[1], implementsClause: $[2], body: $[3] })),
	RuleR('class', IDENT, type_parameters, implements_clause, class_body,										$ => ({ type: 'class', name: $[1], typeParams: $[2], implementsClause: $[3], body: $[4] })),
	RuleR('class', IDENT, 'extends', left_hand_side_expression, implements_clause, class_body,					$ => ({ type: 'class', name: $[1], superClass: $[3], implementsClause: $[4], body: $[5] })),
);

// `abstract class ...` -- only the bare/extends/implements/extends+implements shapes
// (no generics combined with `abstract`, and declarations only, not expressions -- `abstract class {}` as an expression isn't valid TS anyway).
// A plain scope cut to keep this from doubling the list above, not a grammar-ambiguity workaround
class_declaration.push(
	RuleR('abstract', 'class', IDENT, class_body,																$ => ({ type: 'class_decl', name: $[2], body: $[3], abstract: true })),
	RuleR('abstract', 'class', IDENT, 'extends', left_hand_side_expression, class_body,							$ => ({ type: 'class_decl', name: $[2], superClass: $[4], body: $[5], abstract: true })),
	RuleR('abstract', 'class', IDENT, implements_clause, class_body,											$ => ({ type: 'class_decl', name: $[2], implementsClause: $[3], body: $[4], abstract: true })),
	RuleR('abstract', 'class', IDENT, 'extends', left_hand_side_expression, implements_clause, class_body,		$ => ({ type: 'class_decl', name: $[2], superClass: $[4], implementsClause: $[5], body: $[6], abstract: true })),
);

// ===================================================================
//  `expr as Type` / `expr satisfies Type` / `expr!` (non-null assertion)
// ===================================================================

// Pushed onto `relational_expression` -- the same level real TypeScript's own grammar places `AsExpression` at (above additive/shift, beside the other relational operators),
// so e.g. `a + b as T` parses as `(a + b) as T`.
relational_expression.push(
	RuleR(relational_expression, 'as', type,					$ => ({ type: 'as_expression', expression: $[0], typeAnnotation: $[2] })),
	RuleR(relational_expression, 'satisfies', type,				$ => ({ type: 'satisfies_expression', expression: $[0], typeAnnotation: $[2] })),
);

call_expression.push(
	// Pushed onto `call_expression` -- the same nonterminal js-parser.ts's own `.`/`[]`/`?.` continuations live on, so `foo!.bar`, `foo!()`, etc. keep chaining through call_expression's existing self-recursive rules.
	RuleR(member_expression, '!',								$ => ({ type: 'non_null', expression: $[0] })),
	RuleR(call_expression, '!',									$ => ({ type: 'non_null', expression: $[0] })),
	// Generic call: `foo<T>(...)` -- see `call_type_arguments` above for how its opening '<' is disambiguated from a relational comparison purely in the lexer, with no grammar ambiguity here.
	RuleR(member_expression, call_type_arguments, arguments_,	$ => ({ type: 'call', callee: $[0], arguments: $[2] as Expr[], typeArgs: $[1] })),
	RuleR(call_expression, call_type_arguments, arguments_,		$ => ({ type: 'call', callee: $[0], arguments: $[2] as Expr[], typeArgs: $[1] })),
);

// Generic `new`: `new Foo<T>(...)` -- js-parser.ts's own `new` rule (on member_expression) has no type-arguments slot,
// so this is pushed on as its own alternative rather than threaded through it.
member_expression.push(
	RuleR('new', member_expression, call_type_arguments, arguments_, $ => ({ type: 'new', callee: $[1], arguments: $[3] as Expr[], typeArgs: $[2] })),
);

// ===================================================================
//  arrow functions
// ===================================================================
arrow_function.push(
	// Same genuine ambiguity as `parameter`'s bare `IDENT '?'` rule (see the `forceFork` comment there):
	// right after a bare identifier, seeing ':' doesn't yet say whether this is a/ single-param typed arrow (`x: number => ...`) or just `identifier` reducing to continue as
	// part of a larger expression where ':' means something else entirely (e.g. a ternary's separator, as in `(a ? b : c)`'s `b`). Needs `forceFork` for the same reason.
	WithPrec(RuleR(IDENT,  ':', type, '=>', arrow_body, 			$ => ({ type: 'arrow', params: [$[0]], body: $[4], returnType: $[2] })), forceFork),
	RuleR(parameter_clause, '=>', arrow_body, 						$ => ({ type: 'arrow', ...$[0], body: $[2] } as Expr)),
	RuleR(parameter_clause, ':', type, '=>', arrow_body, 			$ => ({ type: 'arrow', ...$[0], body: $[4], returnType: $[2] } as Expr)),
	RuleR('async', IDENT, '=>', arrow_body, 						$ => ({ type: 'arrow', params: [$[1]], body: $[3], async: true })),
	RuleR('async', IDENT, ':', type, '=>', arrow_body, 				$ => ({ type: 'arrow', params: [$[1]], body: $[5], returnType: $[3], async: true })),
	RuleR('async', parameter_clause, '=>', arrow_body, 				$ => ({ type: 'arrow', ...$[1], body: $[3], async: true })),
	RuleR('async', parameter_clause, ':', type, '=>', arrow_body, 	$ => ({ type: 'arrow', ...$[1], body: $[5], returnType: $[3], async: true })),
);

// ===================================================================
//  Wire it up
// ===================================================================

export const tsParser = makeParser({
	skip: jsSkip,
	recover: jsRecover,
	start: program,
	rules: {
		...jsRules,
		type_list,
		call_type_arguments,
		type_parameter,
		type_parameter_list,
		type_parameters,
		ts_param,
		ts_param_list,
		ts_param_list_opt,
		type_member,
		type_member_list,
		type_member_body,
		primary_type,
		array_type,
		unary_type,
		intersection_list,
		intersection_type,
		union_list,
		union_type,
		ts_type: type,
		type_alias_declaration,
		extends_clause,
		interface_declaration,
		enum_member,
		enum_member_list,
		enum_declaration,
		tsStatement,
		declare_function,
		tsExportDeclaration,
		param_modifier_list,
		class_member_modifier_list,
		implements_clause,
	}
});

export const parseTS = (input: string) => tsParser.parse(input) as TSProgram;

