import { tison, Rule, Rules, Forward, List, termOneOf, terminal } from '../tison';
import {
	IDENT, NUMBER, STRING, unquoteString,
	jsRules, jsSkip, jsRecover, varKeywords,
	program, parameter, parameter_clause, relational_expression, member_expression, call_expression, left_hand_side_expression, arguments_,
	arrow_function, arrow_body,
	variable_declaration, variable_declaration_noin, variable_statement,
	function_expression, function_declaration, function_body,
	class_member_body, class_member, class_member_name, class_declaration, class_expression, class_body,
	statement, export_declaration, assignment_expression,
	type Expr, type Statement,
} from './js-parser';

// ===================================================================
//  TypeScript Parser -- an extension of js-parser
// ===================================================================
//
// Adds, on top of the plain-JS grammar in js-parser.ts: type annotations on
// variable declarations/parameters/class fields/function & method return
// types, `interface`/`type`/`enum` declarations (and their `export` forms),
// `declare` ambient statements, class/function/method generics (`<T>`) and
// `implements`, `abstract` classes, static initialization blocks,
// parameter-property modifiers (`public`/`private`/`protected`/`readonly`
// on constructor parameters), field/method modifiers (same four, plus
// `abstract`, combined with `static`), indexed-access types (`T[K]`),
// `expr as Type`/`expr satisfies Type`, and `expr!` non-null assertions.
//
// This is done almost entirely by *mutating* (via `.push`) the Rules arrays
// js-parser.ts exports, then auto-discovering this file's own new
// nonterminals (referenced directly, never by name) into the same grammar
// -- the technique the base file's own header comment invites: "a grammar
// extension... can attach its own richer type [to Param/Expr/etc.]... via
// rule actions pushed onto the exported... array[s]". No part of
// js-parser.ts's own rules are removed or rewritten, only added to.
//
// Known simplifications/omissions (beyond the ones already listed in
// js-parser.ts's own header comment, which still apply):
//   - 'type'/'interface'/'enum'/'implements'/'keyof'/'readonly'/'public'/
//     'private'/'protected'/'abstract'/'as'/'satisfies'/'declare' are
//     treated as fully reserved words, not real TypeScript's contextual
//     keywords -- the same deliberate simplification js-parser.ts already
//     makes for 'async'/'await'/'get'/'set'/etc. (e.g. `type` can no longer
//     be used as an ordinary identifier).
//   - Arrow functions gain no type syntax at all (no typed params, no
//     return type, no generics): their parameter lists are parsed by
//     reinterpreting an already-parsed plain `expression` (see js-parser's
//     `exprToParams`), which has no room for a `:` that isn't valid
//     expression syntax. Teaching arrow functions to recognize typed
//     parameters would mean a second, `parameter_clause`-shaped path
//     sharing the same `(` prefix as that reinterpretation trick, which
//     risks a genuine reduce/reduce ambiguity between "parenthesized
//     expression" and "parameter list" -- not worth the risk here.
//   - Class generics never extend onto the superclass (`class Foo<T>
//     extends Bar<T>`): the superclass is still just a plain expression
//     (`left_hand_side_expression`), so `Bar<T>` there would be misread as
//     two relational comparisons, same ambiguity real TypeScript resolves
//     with semantic, not syntactic, lookahead.
//   - No conditional/mapped types, no template literal types, no
//     decorators, no `declare namespace`/`declare module` (only ambient
//     var/function/class/enum), no abstract *members* combined with
//     generics, no private `#name` members (already excluded by
//     js-parser.ts itself).
//   - Index signatures (`[key: string]: T`) and call signatures (bare
//     `(...): T`) are supported in object-type literals/interfaces. Method
//     return types in *classes* cover plain/async/generator/
//     async-generator methods and `get` accessors, but not `set` (a
//     setter's "return type" is always `void`, so there'd be nothing
//     meaningful to record).
//   - Generic type parameters (`<T>`) are added to classes, interfaces,
//     type aliases, functions, function expressions, and methods --
//     reusing the same `type_parameters` machinery throughout, since it's
//     already proven to disambiguate `<`/`>` correctly. Not combined with
//     `abstract` classes (kept to the bare/extends/implements shapes to
//     avoid doubling that list again) or with generator methods (kept to
//     plain/async methods, for the same reason).

// --- AST types ---

export interface TSTypeParam { name: string; constraint?: TSType; default?: TSType; }
export interface TSParam { name: string; optional?: boolean; rest?: boolean; typeAnnotation?: TSType; }

export type TSTypeMember =
	| { kind: 'property'; name: string; optional?: boolean; readonly?: boolean; typeAnnotation: TSType }
	| { kind: 'method'; name: string; optional?: boolean; params: TSParam[]; returnType?: TSType }
	| { kind: 'index'; paramName: string; paramType: TSType; typeAnnotation: TSType }
	| { kind: 'call'; params: TSParam[]; returnType?: TSType };

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
	| { type: 'typeof'; name: string }
	| { type: 'indexed_access'; object: TSType; index: TSType };

export interface TSEnumMember { name: string; init?: Expr; }

export type TSDeclaration =
	| { type: 'interface_decl'; name: string; typeParams?: TSTypeParam[]; extendsClause?: TSType[]; body: TSTypeMember[] }
	| { type: 'type_alias_decl'; name: string; typeParams?: TSTypeParam[]; value: TSType }
	| { type: 'enum_decl'; name: string; const?: boolean; members: TSEnumMember[] };

// `declare var/function/class/enum ...` -- TypeScript also allows `declare
// namespace`/`declare module`, neither of which this file supports at all.
export interface TSAmbientDeclaration { type: 'declare'; declaration: Statement | TSDeclaration; }

export type TSStatement = Statement | TSDeclaration | TSAmbientDeclaration;
export interface TSProgram { type: 'program'; body: TSStatement[]; }

// ===================================================================
//  Type grammar
// ===================================================================

const fwd_type = Forward<TSType>(() => ts_type);

// --- Generics ---

// Opening `<` is deliberately *not* a bare-string literal: js-parser.ts's
// own relational_expression already shifts on a *combined* terminal
// matching any of `<`/`>`/`<=`/`>=`/`instanceof`/`in` as one Terminal object
// (see `binaryChain`'s `termOneOf(ops)`, interned by its `.name` -- the
// joined op list, not by pattern text). A fresh bare-string '<' terminal
// would be a *second*, separate Terminal that also matches the character
// '<', and the lexer's only tie-break between two equally-long candidates
// is an arbitrary pattern-source string comparison -- in practice it
// consistently favoured the combined terminal, so generics could never open
// at all. Calling `termOneOf` again with the exact same name list resolves
// (via tison's name-based terminal lookup) to that *same* shared terminal,
// removing the second candidate entirely.
//
// The closing `>`, however, stays a plain bare-string literal -- sharing
// the combined terminal there too would make opening and closing
// indistinguishable *to the grammar itself* (both would shift the exact
// same Terminal object), so e.g. `Array<string>` would have no way to tell
// "the `>` closes this" from "`string` itself takes its own type
// arguments". A plain '>' does face the same lexer tie-break risk this
// comment opens with, but only at the exact point a generic argument list
// is about to close -- in practice that's never simultaneously a place
// `relational_expression`'s own continuation is live, so the tie never
// actually arises here.
const angleBracket = () => termOneOf(['<', '>', '<=', '>=', 'instanceof', 'in'] as const);

const type_list = List(fwd_type, ',');
const type_arguments = Rules<TSType[]>(
	Rule([angleBracket(), type_list, '>'] as const,				$ => $[1]),
);

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
// `peekText`, before any tokenizing) for a balanced run of plausible type-argument syntax
// (identifiers, `.`, `,`, nested `<>`/`[]`, whitespace -- no operators, no parens) immediately
// followed by '('. If that scan fails, `lex` rejects the match and the ordinary combined
// `angleBracket` terminal wins instead, so plain `a < b` stays exactly as cheap as it always was.
// Known simplification: a type argument containing a function type (`Foo<(x: T) => void>(...)`)
// or another call/parenthesized expression won't be recognized, since `(`/`)` aren't in the
// allowed set -- narrowing the heuristic was judged a smaller risk than widening it into more
// false positives against real comparison chains.
const GENERIC_CALL_SCAN_LIMIT = 200;
function looksLikeGenericCallArgs(textAfterLt: string): boolean {
	let depth = 1;
	for (let i = 0; i < textAfterLt.length && i < GENERIC_CALL_SCAN_LIMIT; i++) {
		const c = textAfterLt[i];
		if (c === '<') {
			depth++;
		} else if (c === '>') {
			if (--depth === 0)
				return /^\s*\(/.test(textAfterLt.slice(i + 1));
		} else if (!/[A-Za-z0-9_$.,\s[\]]/.test(c)) {
			return false;
		}
	}
	return false;
}
// Matched via `\x3c` rather than a plain `/</` so its `.pattern.source` ("\x3c") sorts ahead of
// `angleBracket`'s own source ("\<|\>|...") on the tokenizer's length-tie pattern-source
// comparison (see the angleBracket comment above for that tie-break rule) -- both match exactly
// one '<' character; this only changes which one the tokenizer offers its `lex` hook first when
// both are valid in the current parser state, so this terminal's scan gets a chance to run/reject
// before the no-`lex` `angleBracket` terminal auto-accepts.
const genericCallOpen = terminal('<call-generics>', /\x3c/,
	({ peekText }) => looksLikeGenericCallArgs(peekText().slice(1)) ? genericCallOpen : undefined
);
const call_type_arguments = Rules<TSType[]>(
	Rule([genericCallOpen, type_list, '>'] as const,				$ => $[1]),
);

const type_parameter = Rules<TSTypeParam>(
	Rule([IDENT] as const,										$ => ({ name: $[0] } as const)),
	Rule([IDENT, 'extends', fwd_type] as const,					$ => ({ name: $[0], constraint: $[2] } as const)),
	Rule([IDENT, '=', fwd_type] as const,						$ => ({ name: $[0], default: $[2] } as const)),
	Rule([IDENT, 'extends', fwd_type, '=', fwd_type] as const,	$ => ({ name: $[0], constraint: $[2], default: $[4] } as const)),
);
const type_parameter_list = List(type_parameter, ',');
const type_parameters = Rules<TSTypeParam[]>(
	Rule([angleBracket(), type_parameter_list, '>'] as const,	$ => $[1]),
);

// --- Simplified parameter list, for function types and call/method signatures (no defaults, no destructuring -- a known simplification) ---

const ts_param = Rules<TSParam>(
	Rule([IDENT] as const,							$ => ({ name: $[0] } as const)),
	Rule([IDENT, '?'] as const,						$ => ({ name: $[0], optional: true } as const)),
	Rule([IDENT, ':', fwd_type] as const,			$ => ({ name: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, '?', ':', fwd_type] as const,		$ => ({ name: $[0], optional: true, typeAnnotation: $[3] } as const)),
	Rule(['...', IDENT] as const,					$ => ({ name: $[1], rest: true } as const)),
	Rule(['...', IDENT, ':', fwd_type] as const,	$ => ({ name: $[1], rest: true, typeAnnotation: $[3] } as const)),
);
const ts_param_list = List(ts_param, ',');
const ts_param_list_opt = Rules<TSParam[]>(
	Rule([] as const,				() => []),
	Rule([ts_param_list] as const,	$ => $[0]),
);

// --- Object type literal / interface body members ---

const type_member = Rules<TSTypeMember>(
	Rule([IDENT, ':', fwd_type] as const,									$ => ({ kind: 'property', name: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, '?', ':', fwd_type] as const,								$ => ({ kind: 'property', name: $[0], optional: true, typeAnnotation: $[3] } as const)),
	Rule(['readonly', IDENT, ':', fwd_type] as const,						$ => ({ kind: 'property', name: $[1], readonly: true, typeAnnotation: $[3] } as const)),
	Rule(['readonly', IDENT, '?', ':', fwd_type] as const,					$ => ({ kind: 'property', name: $[1], readonly: true, optional: true, typeAnnotation: $[4] } as const)),
	Rule([IDENT, '(', ts_param_list_opt, ')'] as const,						$ => ({ kind: 'method', name: $[0], params: $[2] } as const)),
	Rule([IDENT, '(', ts_param_list_opt, ')', ':', fwd_type] as const,		$ => ({ kind: 'method', name: $[0], params: $[2], returnType: $[5] } as const)),
	Rule([IDENT, '?', '(', ts_param_list_opt, ')'] as const,				$ => ({ kind: 'method', name: $[0], optional: true, params: $[3] } as const)),
	Rule([IDENT, '?', '(', ts_param_list_opt, ')', ':', fwd_type] as const,	$ => ({ kind: 'method', name: $[0], optional: true, params: $[3], returnType: $[6] } as const)),
	Rule(['[', IDENT, ':', fwd_type, ']', ':', fwd_type] as const,			$ => ({ kind: 'index', paramName: $[1], paramType: $[3], typeAnnotation: $[6] } as const)),
	Rule(['(', ts_param_list_opt, ')', ':', fwd_type] as const,				$ => ({ kind: 'call', params: $[1], returnType: $[4] } as const)),
);
// `;`-separated, with an optional trailing `;` -- this grammar doesn't also accept `,` as a member separator (real TypeScript allows either), a known simplification.
const type_member_list = List(type_member, ';');
const type_member_body = Rules<TSTypeMember[]>(
	Rule(['{', '}'] as const,							() => []),
	Rule(['{', type_member_list, '}'] as const,			$ => $[1]),
	Rule(['{', type_member_list, ';', '}'] as const,	$ => $[1]),
);

// --- Type expression precedence chain: primary -> postfix array -> keyof -> intersection -> union ---

function parseTypeNumber(text: string): number {
	return parseFloat(text.replace(/_/g, ''));
}

const primary_type = Rules<TSType>(
	Rule([IDENT] as const,										$ => ({ type: 'ref', name: $[0] } as const)),
	Rule([IDENT, type_arguments] as const,						$ => ({ type: 'ref', name: $[0], typeArgs: $[1] } as const)),
	Rule(['this'] as const,										() => ({ type: 'this' } as const)),
	Rule(['null'] as const,										() => ({ type: 'literal', value: null } as const)),
	Rule(['true'] as const,										() => ({ type: 'literal', value: true } as const)),
	Rule(['false'] as const,									() => ({ type: 'literal', value: false } as const)),
	Rule([STRING] as const,										$ => ({ type: 'literal', value: unquoteString($[0]) } as const)),
	Rule([NUMBER] as const,										$ => ({ type: 'literal', value: parseTypeNumber($[0]) } as const)),
	Rule(['typeof', IDENT] as const,							$ => ({ type: 'typeof', name: $[1] } as const)),
	Rule(['(', fwd_type, ')'] as const,							$ => ({ type: 'parenthesized', inner: $[1] } as const)),
	Rule(['[', ']'] as const,									() => ({ type: 'tuple', elements: [] } as const)),
	Rule(['[', type_list, ']'] as const,						$ => ({ type: 'tuple', elements: $[1] } as const)),
	Rule([type_member_body] as const,							$ => ({ type: 'object', members: $[0] } as const)),
	Rule(['(', ts_param_list_opt, ')', '=>', fwd_type] as const,$ => ({ type: 'function', params: $[1], returnType: $[4] } as const)),
);
// Postfix `[]`/`[K]`: left-recursive so `T[][]`/`T[K][J]` stack correctly.
// The empty- and type-filled bracket forms don't conflict -- they diverge on
// the very next token (`]` vs. a type-start token), the same one-token
// lookahead distinction `array_literal`'s elisions and ordinary elements
// already rely on in js-parser.ts.
const array_type = Rules<TSType>(self => [
	Rule([primary_type] as const,				$ => $[0]),
	Rule([self, '[', ']'] as const,				$ => ({ type: 'array', element: $[0] } as const)),
	Rule([self, '[', fwd_type, ']'] as const,	$ => ({ type: 'indexed_access', object: $[0], index: $[2] } as const)),
]);
const unary_type = Rules<TSType>(
	Rule([array_type] as const,				$ => $[0]),
	Rule(['keyof', array_type] as const,	$ => ({ type: 'keyof', argument: $[1] } as const)),
);
// `&`/`|` reuse `List` directly: each level is just a separated list of the level below, flattened into a `TSType[]` and only wrapped in a union/ intersection node when there's more than one member
// -- no precedence declarations are needed since (as in js-parser.ts's own binary chain) each level is its own nonterminal, so the grammar structure alone keeps '&' and '|' from ever competing for the same reduction.
const intersection_list = List(unary_type, '&');
const intersection_type = Rules<TSType>(
	Rule([intersection_list] as const, 		$ => $[0].length === 1 ? $[0][0] : ({ type: 'intersection', types: $[0] } as const)),
);
const union_list = List(intersection_type, '|');
const union_type = Rules<TSType>(
	Rule([union_list] as const,				$ => $[0].length === 1 ? $[0][0] : ({ type: 'union', types: $[0] } as const)),
);
// Named `ts_type`, not `type` -- `type_alias_declaration` below uses the bare string 'type' as the *literal keyword* introducing a type alias, and
// tison resolves a string Sym against nonterminal names before falling back to a literal terminal. A nonterminal actually named `type` would silently
// steal that reference, turning `Rule(['type', IDENT, '=', ...])` into a self-referential (and nonsensical) grammar rule instead of matching the
// keyword -- this is the one name in this file that can't shadow a keyword.
const ts_type = Rules<TSType>(
	Rule([union_type] as const, $ => $[0]),
);

// ===================================================================
//  Declarations: `type`, `interface`, `enum`
// ===================================================================

const type_alias_declaration = Rules<TSDeclaration>(
	Rule(['type', IDENT, '=', fwd_type, ';'] as const,					$ => ({ type: 'type_alias_decl', name: $[1], value: $[3] } as const)),
	Rule(['type', IDENT, type_parameters, '=', fwd_type, ';'] as const,	$ => ({ type: 'type_alias_decl', name: $[1], typeParams: $[2], value: $[4] } as const)),
);

const extends_clause = Rules<TSType[]>(
	Rule(['extends', type_list] as const, $ => $[1]),
);
const interface_declaration = Rules<TSDeclaration>(
	Rule(['interface', IDENT, type_member_body] as const,									$ => ({ type: 'interface_decl', name: $[1], body: $[2] } as const)),
	Rule(['interface', IDENT, type_parameters, type_member_body] as const,					$ => ({ type: 'interface_decl', name: $[1], typeParams: $[2], body: $[3] } as const)),
	Rule(['interface', IDENT, extends_clause, type_member_body] as const,					$ => ({ type: 'interface_decl', name: $[1], extendsClause: $[2], body: $[3] } as const)),
	Rule(['interface', IDENT, type_parameters, extends_clause, type_member_body] as const,	$ => ({ type: 'interface_decl', name: $[1], typeParams: $[2], extendsClause: $[3], body: $[4] } as const)),
);

const enum_member = Rules<TSEnumMember>(
	Rule([IDENT] as const,									$ => ({ name: $[0] } as const)),
	Rule([IDENT, '=', assignment_expression] as const,		$ => ({ name: $[0], init: $[2] } as const)),
	Rule([STRING] as const,									$ => ({ name: unquoteString($[0]) } as const)),
	Rule([STRING, '=', assignment_expression] as const,		$ => ({ name: unquoteString($[0]), init: $[2] } as const)),
);
const enum_member_list = List(enum_member, ',');
const enum_declaration = Rules<TSDeclaration>(
	Rule(['enum', IDENT, '{', '}'] as const,										$ => ({ type: 'enum_decl', name: $[1], members: [] } as const)),
	Rule(['enum', IDENT, '{', enum_member_list, '}'] as const,						$ => ({ type: 'enum_decl', name: $[1], members: $[3] } as const)),
	Rule(['enum', IDENT, '{', enum_member_list, ',', '}'] as const,					$ => ({ type: 'enum_decl', name: $[1], members: $[3] } as const)),
	// Reuses `varKeywords` (the same combined var/let/const terminal js-parser.ts's own `variable_statement` shifts on) rather than a fresh
	// literal 'const' terminal -- two different terminals both matching the text "const" would otherwise leave the lexer to break the tie on
	// pattern-source sort order alone, and `variable_statement`'s shift would always win, so `const enum` would never be reachable. `var enum`/
	// `let enum` are accepted the same permissive way as other non-syntactic restrictions elsewhere in this codebase -- only `const` sets `const: true`.
	Rule([varKeywords, 'enum', IDENT, '{', '}'] as const,							$ => ({ type: 'enum_decl', name: $[2], const: $[0] === 'const', members: [] } as const)),
	Rule([varKeywords, 'enum', IDENT, '{', enum_member_list, '}'] as const,			$ => ({ type: 'enum_decl', name: $[2], const: $[0] === 'const', members: $[4] } as const)),
	Rule([varKeywords, 'enum', IDENT, '{', enum_member_list, ',', '}'] as const,	$ => ({ type: 'enum_decl', name: $[2], const: $[0] === 'const', members: $[4] } as const)),
);

// Extend `statement` (reachable from both block bodies and, via `module_item`'s own `[statement]` rule, the top level) so these
// declarations work in either place, exactly like the rest of TypeScript's declarations. `statement`'s static element type is the closed `Statement`
// union from js-parser.ts; widening it to also produce `TSDeclaration` needs one cast at the array level (the runtime array is untouched by the
// cast -- it's the same array `module_item`/`program` already read from).
const tsStatement = statement as unknown as Rules<TSStatement>;
tsStatement.push(
	Rule([interface_declaration] as const,		$ => $[0]),
	Rule([type_alias_declaration] as const,		$ => $[0]),
	Rule([enum_declaration] as const,			$ => $[0]),
);

// `declare var/let/const/function/class/enum ...` -- real TypeScript also
// allows `declare namespace`/`declare module`, neither of which this file
// supports at all. `declare`/`interface`/`type alias` aren't combined here
// (interfaces and type aliases are already pure type-space declarations
// with no runtime body, so `declare` in front of them is a no-op real
// TypeScript doesn't even allow syntactically).
//
// `declare function` can't reuse `function_declaration` as-is: an ambient
// function has no body at all (`declare function f(x: number): void;`,
// ending in `;`, never `{ ... }`) where `function_declaration`'s every
// shape requires one. `body: []` stands in for "no implementation" -- a
// permissive simplification (same spirit as this file's other
// not-quite-faithful shortcuts) rather than giving `function_decl` an
// optional body just for this one ambient case.
const declare_function = Rules<Statement>(
	Rule(['function', IDENT, parameter_clause, ';'] as const,					$ => ({ type: 'function_decl', name: $[1], ...$[2], body: [] } as const)),
	Rule(['function', IDENT, parameter_clause, ':', fwd_type, ';'] as const,	$ => ({ type: 'function_decl', name: $[1], ...$[2], body: [], returnType: $[4] } as const)),
);
tsStatement.push(
	Rule(['declare', variable_statement] as const,			$ => ({ type: 'declare', declaration: $[1] } as const)),
	Rule(['declare', function_declaration] as const,		$ => ({ type: 'declare', declaration: $[1] } as const)),
	Rule(['declare', declare_function] as const,			$ => ({ type: 'declare', declaration: $[1] } as const)),
	Rule(['declare', class_declaration] as const,			$ => ({ type: 'declare', declaration: $[1] } as const)),
	Rule(['declare', enum_declaration] as const,			$ => ({ type: 'declare', declaration: $[1] } as const)),
);

const tsExportDeclaration = export_declaration as unknown as Rules<TSStatement>;
tsExportDeclaration.push(
	Rule(['export', interface_declaration] as const,	$ => $[1]),
	Rule(['export', type_alias_declaration] as const,	$ => $[1]),
	Rule(['export', enum_declaration] as const,			$ => $[1]),
);

// ===================================================================
//  Typed parameters (function/method/constructor)
// ===================================================================
//
// `parameter` is shared by every parameter list in js-parser.ts (function expressions/declarations, object-literal shorthand methods, class methods/constructors) via `parameter_clause`/`formal_parameter_list` --
// extending it once here adds typed (and, for constructors, modifier-carrying "parameter property") parameters everywhere at once.

const param_modifier = Rules(
	Rule([termOneOf(['public', 'private', 'protected', 'readonly'] as const)] as const, $ => $[0]),
);
const param_modifier_list = List(param_modifier);

parameter.push(
	Rule([IDENT, '?'] as const,												$ => ({ target: $[0], optional: true } as const)),
	Rule([IDENT, ':', fwd_type] as const,									$ => ({ target: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, '?', ':', fwd_type] as const,								$ => ({ target: $[0], optional: true, typeAnnotation: $[3] } as const)),
	Rule([IDENT, ':', fwd_type, '=', assignment_expression] as const,		$ => ({ target: $[0], typeAnnotation: $[2], default: $[4] } as const)),
	// Parameter properties (`constructor(public x: number)`): valid anywhere a parameter is, not just inside a constructor -- this syntax-only grammar doesn't check that, a known simplification.
	Rule([param_modifier_list, IDENT] as const,								$ => ({ target: $[1], modifiers: $[0] } as const)),
	Rule([param_modifier_list, IDENT, ':', fwd_type] as const,				$ => ({ target: $[1], modifiers: $[0], typeAnnotation: $[3] } as const)),
	Rule([param_modifier_list, IDENT, '?', ':', fwd_type] as const,			$ => ({ target: $[1], optional: true, modifiers: $[0], typeAnnotation: $[4] } as const)),
);

// ===================================================================
//  Return types & generics on function/method declarations & expressions
// ===================================================================
//
// Mirrors js-parser.ts's own `function_expression`/`function_declaration`/
// `class_member_body` shapes, just with `<T>` and/or `: Type` inserted
// before the parameter list and/or the body's `{`. Arrow functions are
// deliberately not extended this way -- see the header comment. The
// `<T>` insertions reuse `type_parameters` exactly as-is -- the same
// machinery already proven to disambiguate `<`/`>` correctly for classes/
// interfaces/type aliases above, so there's no new ambiguity risk here,
// just more alternatives of an already-working shape.

function_expression.push(
	Rule(['function', parameter_clause, ':', fwd_type, '{', function_body, '}'] as const,					$ => ({ type: 'function', params: $[1].params, rest: $[1].rest, body: $[5], returnType: $[3] } as const)),
	Rule(['function', IDENT, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const,			$ => ({ type: 'function', name: $[1], params: $[2].params, rest: $[2].rest, body: $[6], returnType: $[4] } as const)),
	Rule(['async', 'function', parameter_clause, ':', fwd_type, '{', function_body, '}'] as const,			$ => ({ type: 'function', params: $[2].params, rest: $[2].rest, body: $[6], async: true, returnType: $[4] } as const)),
	Rule(['async', 'function', IDENT, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const,	$ => ({ type: 'function', name: $[2], params: $[3].params, rest: $[3].rest, body: $[7], async: true, returnType: $[5] } as const)),
	// Generics (anonymous/named, with/without a return type -- not combined with `async`, see header comment).
	Rule(['function', type_parameters, parameter_clause, '{', function_body, '}'] as const,					$ => ({ type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], typeParams: $[1] } as const)),
	Rule(['function', type_parameters, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const,	$ => ({ type: 'function', params: $[2].params, rest: $[2].rest, body: $[6], typeParams: $[1], returnType: $[4] } as const)),
	Rule(['function', IDENT, type_parameters, parameter_clause, '{', function_body, '}'] as const,			$ => ({ type: 'function', name: $[1], params: $[3].params, rest: $[3].rest, body: $[5], typeParams: $[2] } as const)),
	Rule(['function', IDENT, type_parameters, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const, $ => ({ type: 'function', name: $[1], params: $[3].params, rest: $[3].rest, body: $[7], typeParams: $[2], returnType: $[5] } as const)),
);
function_declaration.push(
	Rule(['function', IDENT, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const,			$ => ({ type: 'function_decl', name: $[1], params: $[2].params, rest: $[2].rest, body: $[6], returnType: $[4] } as const)),
	Rule(['async', 'function', IDENT, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const,	$ => ({ type: 'function_decl', name: $[2], params: $[3].params, rest: $[3].rest, body: $[7], async: true, returnType: $[5] } as const)),
	// Generics (with/without a return type, plain or `async`).
	Rule(['function', IDENT, type_parameters, parameter_clause, '{', function_body, '}'] as const,			$ => ({ type: 'function_decl', name: $[1], params: $[3].params, rest: $[3].rest, body: $[5], typeParams: $[2] } as const)),
	Rule(['function', IDENT, type_parameters, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const, $ => ({ type: 'function_decl', name: $[1], params: $[3].params, rest: $[3].rest, body: $[7], typeParams: $[2], returnType: $[5] } as const)),
	Rule(['async', 'function', IDENT, type_parameters, parameter_clause, '{', function_body, '}'] as const,	$ => ({ type: 'function_decl', name: $[2], params: $[4].params, rest: $[4].rest, body: $[6], typeParams: $[3], async: true } as const)),
	Rule(['async', 'function', IDENT, type_parameters, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const, $ => ({ type: 'function_decl', name: $[2], params: $[4].params, rest: $[4].rest, body: $[8], typeParams: $[3], async: true, returnType: $[6] } as const)),
);

class_member_body.push(
	// Return types -- plain and async methods (already had this), plus
	// generator/async-generator methods and the `get` accessor (the `set`
	// accessor's "return type" would always just be `void`, so it's
	// skipped, same as js-parser.ts's own get/set asymmetry: `get`'s
	// shape already differs from `set`'s by having no parameter).
	Rule([class_member_name, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const,			$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: $[1].params, rest: $[1].rest, body: $[5], returnType: $[3] } } as const)),
	Rule(['async', class_member_name, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const,	$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[6], async: true, returnType: $[4] } } as const)),
	Rule(['*', class_member_name, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const,		$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[6], generator: true, returnType: $[4] } } as const)),
	Rule(['async', '*', class_member_name, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const, $ => ({ type: 'method', kind: 'method', key: $[2] as string | { computed: Expr }, value: { type: 'function', params: $[3].params, rest: $[3].rest, body: $[7], generator: true, async: true, returnType: $[5] } } as const)),
	Rule(['get', class_member_name, '(', ')', ':', fwd_type, '{', function_body, '}'] as const,				$ => ({ type: 'method', kind: 'get', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: [], body: $[7], returnType: $[5] } } as const)),
	// Generics (with/without a return type, plain or `async`).
	Rule([class_member_name, type_parameters, parameter_clause, '{', function_body, '}'] as const,			$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], typeParams: $[1] } } as const)),
	Rule([class_member_name, type_parameters, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const, $ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[6], typeParams: $[1], returnType: $[4] } } as const)),
	Rule(['async', class_member_name, type_parameters, parameter_clause, '{', function_body, '}'] as const,	$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[3].params, rest: $[3].rest, body: $[5], typeParams: $[2], async: true } } as const)),
	Rule(['async', class_member_name, type_parameters, parameter_clause, ':', fwd_type, '{', function_body, '}'] as const, $ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[3].params, rest: $[3].rest, body: $[7], typeParams: $[2], async: true, returnType: $[5] } } as const)),
	// Optional methods (`foo?() {}`).
	Rule([class_member_name, '?', parameter_clause, '{', function_body, '}'] as const,						$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[4] }, optional: true } as const)),
	// Typed fields, optional fields, definite-assignment assertion (`x!: number;`).
	Rule([class_member_name, ':', fwd_type, ';'] as const,													$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, typeAnnotation: $[2] } as const)),
	Rule([class_member_name, ':', fwd_type, '=', assignment_expression, ';'] as const,						$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, typeAnnotation: $[2], value: $[4] } as const)),
	Rule([class_member_name, '?', ':', fwd_type, ';'] as const,												$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, optional: true, typeAnnotation: $[3] } as const)),
	Rule([class_member_name, '?', ':', fwd_type, '=', assignment_expression, ';'] as const,					$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, optional: true, typeAnnotation: $[3], value: $[5] } as const)),
	Rule([class_member_name, '!', ':', fwd_type, ';'] as const,												$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, typeAnnotation: $[3], definite: true } as const)),
);

// Static initialization blocks (`static { ... }`) -- pushed onto
// `class_member` directly (not `class_member_body`) since the shape
// doesn't fit the "static" + ordinary-member wrapping the modifiers push
// below already does: there's no member-name/key here at all.
class_member.push(
	Rule(['static', '{', function_body, '}'] as const, $ => ({ type: 'static_block', body: $[2] } as const)),
);

// Member modifiers (`public`/`private`/`protected`/`readonly`/`abstract`), any number of them, optionally combined with `static`.
// Pushed onto `class_member` (not `class_member_body`) so they apply uniformly to every member shape -- including the ones just added above -- without duplicating each shape once per modifier combination.
const class_member_modifier = Rules(
	Rule([termOneOf(['public', 'private', 'protected', 'readonly', 'abstract'] as const)] as const, $ => $[0]),
);
const class_member_modifier_list = List(class_member_modifier);

class_member.push(
	Rule([class_member_modifier_list, class_member_body] as const,				$ => ({ ...$[1], modifiers: $[0] } as const)),
	Rule([class_member_modifier_list, 'static', class_member_body] as const,	$ => ({ ...$[2], modifiers: $[0], static: true } as const)),
);

// ===================================================================
//  Typed variable declarations
// ===================================================================

variable_declaration.push(
	Rule([IDENT, ':', fwd_type] as const,								$ => ({ name: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, ':', fwd_type, '=', assignment_expression] as const,	$ => ({ name: $[0], typeAnnotation: $[2], init: $[4] } as const)),
	// Definite-assignment assertion (`let x!: number;`).
	Rule([IDENT, '!', ':', fwd_type] as const,							$ => ({ name: $[0], typeAnnotation: $[3], definite: true } as const)),
);
variable_declaration_noin.push(
	Rule([IDENT, ':', fwd_type] as const,								$ => ({ name: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, ':', fwd_type, '=', assignment_expression] as const,	$ => ({ name: $[0], typeAnnotation: $[2], init: $[4] } as const)),
);

// ===================================================================
//  Class generics & `implements`
// ===================================================================

const implements_clause = Rules<TSType[]>(
	Rule(['implements', type_list] as const, $ => $[1]),
);

class_declaration.push(
	Rule(['class', IDENT, type_parameters, class_body] as const,															$ => ({ type: 'class_decl', name: $[1], typeParams: $[2], body: $[3] } as const)),
	Rule(['class', IDENT, type_parameters, 'extends', left_hand_side_expression, class_body] as const,						$ => ({ type: 'class_decl', name: $[1], typeParams: $[2], superClass: $[4], body: $[5] } as const)),
	Rule(['class', IDENT, implements_clause, class_body] as const,															$ => ({ type: 'class_decl', name: $[1], implementsClause: $[2], body: $[3] } as const)),
	Rule(['class', IDENT, type_parameters, implements_clause, class_body] as const,											$ => ({ type: 'class_decl', name: $[1], typeParams: $[2], implementsClause: $[3], body: $[4] } as const)),
	Rule(['class', IDENT, 'extends', left_hand_side_expression, implements_clause, class_body] as const,					$ => ({ type: 'class_decl', name: $[1], superClass: $[3], implementsClause: $[4], body: $[5] } as const)),
	Rule(['class', IDENT, type_parameters, 'extends', left_hand_side_expression, implements_clause, class_body] as const,	$ => ({ type: 'class_decl', name: $[1], typeParams: $[2], superClass: $[4], implementsClause: $[5], body: $[6] } as const)),
);
class_expression.push(
	Rule(['class', IDENT, type_parameters, class_body] as const,											$ => ({ type: 'class', name: $[1], typeParams: $[2], body: $[3] } as const)),
	Rule(['class', IDENT, implements_clause, class_body] as const,											$ => ({ type: 'class', name: $[1], implementsClause: $[2], body: $[3] } as const)),
	Rule(['class', IDENT, type_parameters, implements_clause, class_body] as const,							$ => ({ type: 'class', name: $[1], typeParams: $[2], implementsClause: $[3], body: $[4] } as const)),
	Rule(['class', IDENT, 'extends', left_hand_side_expression, implements_clause, class_body] as const,	$ => ({ type: 'class', name: $[1], superClass: $[3], implementsClause: $[4], body: $[5] } as const)),
);

// `abstract class ...` -- only the bare/extends/implements/extends+implements
// shapes (no generics combined with `abstract`, and declarations only, not
// expressions -- `abstract class {}` as an expression isn't valid TS
// anyway). A plain scope cut to keep this from doubling the list above,
// not a grammar-ambiguity workaround: 'abstract' is already a reserved
// word (it's a member modifier elsewhere in this file), so it carries no
// collision risk as a class-level prefix either.
class_declaration.push(
	Rule(['abstract', 'class', IDENT, class_body] as const,																$ => ({ type: 'class_decl', name: $[2], body: $[3], abstract: true } as const)),
	Rule(['abstract', 'class', IDENT, 'extends', left_hand_side_expression, class_body] as const,						$ => ({ type: 'class_decl', name: $[2], superClass: $[4], body: $[5], abstract: true } as const)),
	Rule(['abstract', 'class', IDENT, implements_clause, class_body] as const,											$ => ({ type: 'class_decl', name: $[2], implementsClause: $[3], body: $[4], abstract: true } as const)),
	Rule(['abstract', 'class', IDENT, 'extends', left_hand_side_expression, implements_clause, class_body] as const,	$ => ({ type: 'class_decl', name: $[2], superClass: $[4], implementsClause: $[5], body: $[6], abstract: true } as const)),
);

// ===================================================================
//  `expr as Type` / `expr satisfies Type` / `expr!` (non-null assertion)
// ===================================================================

// Pushed onto `relational_expression` -- the same level real TypeScript's own grammar places `AsExpression` at (above additive/shift, beside the
// other relational operators), so e.g. `a + b as T` parses as `(a + b) as T`.
// Referencing the array itself (rather than the `self` closure `binaryChain` used internally to build it) works the same way: tison
// resolves a Rules array to its NonTerminal by object identity, not by how each individual rule happened to spell the self-reference. `satisfies`
// is a fresh reserved word (no other rule anywhere references it), so it carries none of the collision risk 'as'/'<'/'>' had -- it just slots in
// as one more alternative at the same level.
relational_expression.push(
	Rule([relational_expression, 'as', fwd_type] as const,			$ => ({ type: 'as_expression', expression: $[0], typeAnnotation: $[2] } as const)),
	Rule([relational_expression, 'satisfies', fwd_type] as const,	$ => ({ type: 'satisfies_expression', expression: $[0], typeAnnotation: $[2] } as const)),
);

// Pushed onto `call_expression` -- the same nonterminal js-parser.ts's own `.`/`[]`/`?.` continuations live on, so `foo!.bar`, `foo!()`, etc. keep
// chaining through call_expression's existing self-recursive rules.
call_expression.push(
	Rule([member_expression, '!'] as const,		$ => ({ type: 'non_null', expression: $[0] } as const)),
	Rule([call_expression, '!'] as const,		$ => ({ type: 'non_null', expression: $[0] } as const)),
);

// Generic call: `foo<T>(...)` -- see `call_type_arguments` above for how its opening '<' is
// disambiguated from a relational comparison purely in the lexer, with no grammar ambiguity here.
call_expression.push(
	Rule([member_expression, call_type_arguments, arguments_] as const,	$ => ({ type: 'call', callee: $[0], arguments: $[2] as Expr[], typeArgs: $[1] } as const)),
	Rule([call_expression, call_type_arguments, arguments_] as const,	$ => ({ type: 'call', callee: $[0], arguments: $[2] as Expr[], typeArgs: $[1] } as const)),
);

// ===================================================================
//  arrow functions
// ===================================================================
arrow_function.push(
	Rule([IDENT,  ':', fwd_type, '=>', arrow_body] as const, 						$ => ({ type: 'arrow', params: [$[0]], body: $[4], returnType: $[2] } as const)),
	Rule([parameter_clause, '=>', arrow_body] as const, 							$ => ({ type: 'arrow', ...$[0], body: $[2] } as Expr)),
	Rule([parameter_clause, ':', fwd_type, '=>', arrow_body] as const, 				$ => ({ type: 'arrow', ...$[0], body: $[4], returnType: $[2] } as Expr)),
	Rule(['async', IDENT, '=>', arrow_body] as const, 								$ => ({ type: 'arrow', params: [$[1]], body: $[3], async: true } as const)),
	Rule(['async', IDENT, ':', fwd_type, '=>', arrow_body] as const, 				$ => ({ type: 'arrow', params: [$[1]], body: $[5], returnType: $[3], async: true } as const)),
	Rule(['async', parameter_clause, '=>', arrow_body] as const, 					$ => ({ type: 'arrow', ...$[1], body: $[3], async: true } as const)),
	Rule(['async', parameter_clause, ':', fwd_type, '=>', arrow_body] as const, 	$ => ({ type: 'arrow', ...$[1], body: $[5], returnType: $[3], async: true } as const)),
);

// ===================================================================
//  Wire it up
// ===================================================================

export const tsParser = tison({
	skip: jsSkip,
	recover: jsRecover,
	start: program,
	rules: {
		...jsRules,
		type_list,
		type_arguments,
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
		ts_type,
		type_alias_declaration,
		extends_clause,
		interface_declaration,
		enum_member,
		enum_member_list,
		enum_declaration,
		tsStatement,
		declare_function,
		tsExportDeclaration,
		param_modifier,
		param_modifier_list,
		class_member_modifier,
		class_member_modifier_list,
		implements_clause,
	}
});

export const parseTS = (input: string) => tsParser.parse(input) as TSProgram;
