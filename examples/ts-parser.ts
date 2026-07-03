import { makeParser, Rule, Rules, RRules, Forward, List, OneOf, terminal, forceFork } from '../src/tison';
import {
	IDENT, NUMBER, STRING, unquoteString,
	jsRules, jsSkip, jsRecover,
	program, parameter, parameter_clause, formal_parameter_list, relational_expression, member_expression, call_expression, left_hand_side_expression, arguments_,
	relational_expression_nobrace, member_expression_nobrace, call_expression_nobrace,
	arrow_function, arrow_body,
	variable_declaration, variable_declaration_noin, variable_statement,
	function_expression, function_declaration, function_body,
	class_member_body, class_member, class_member_name, class_declaration, class_expression, class_body,
	statement, export_declaration, assignment_expression,
	property_name, property_assignment, catch_, statement_list,
	type Expr, type Statement,
} from './js-parser';

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
//   - Index signatures (`[key: string]: T`) and call signatures (bare  `(...): T`) are not supported in `set` (a setter's "return type" is always `void`, so there'd be nothing meaningful to record).
//   - Generic type parameters are not combined with `abstract` classes (kept to the bare/extends/implements shapes to avoid doubling that list again) or
//     with generator methods (kept to plain/async methods, for the same reason).

// --- AST types ---

export interface TSTypeParam { name: string; constraint?: TSType; default?: TSType; }
export interface TSParam { name: string; optional?: boolean; rest?: boolean; typeAnnotation?: TSType; }

export type TSTypeMember =
	| { kind: 'property'; name: string; optional?: boolean; readonly?: boolean; typeAnnotation: TSType }
	| { kind: 'method'; name: string; optional?: boolean; params: TSParam[]; returnType?: TSType; typeParams?: TSTypeParam[] }
	| { kind: 'index'; paramName: string; paramType: TSType; typeAnnotation: TSType }
	| { kind: 'call'; params: TSParam[]; returnType?: TSType };

// No `as`-clause key remapping (`[K in T as U]`) -- a known simplification.
export interface TSMappedType { keyName: string; constraint: TSType; nameType?: TSType; valueType: TSType; readonly?: boolean; optional?: boolean; }

// Same shape as js-parser.ts's own `TemplatePart`, just with a `TSType` interpolation instead of an `Expr` one.
export interface TSTemplatePart { str: string; exp?: TSType; }

export type TSType =
	| { type: 'ref'; name: string; typeArgs?: TSType[] }
	| { type: 'literal'; value: string | number | boolean | null }
	| { type: 'template_literal'; parts: TSTemplatePart[] }
	| { type: 'this' }
	| { type: 'array'; element: TSType }
	// A tuple element may be a spread (`[...T, X]`, variadic tuple types) alongside plain types --
	// same shape `Expr`'s array-literal elements already use for `[...x]`. Named tuple elements
	// (`[first: string, ...rest: number[]]`) aren't supported, a separate feature from spread.
	| { type: 'tuple'; elements: (TSType | { type: 'spread'; argument: TSType })[] }
	| { type: 'union'; types: TSType[] }
	| { type: 'intersection'; types: TSType[] }
	| { type: 'function'; params: TSParam[]; returnType: TSType; typeParams?: TSTypeParam[] }
	| { type: 'constructor'; params: TSParam[]; returnType: TSType; typeParams?: TSTypeParam[]; abstract?: boolean }
	| { type: 'object'; members: TSTypeMember[] }
	| { type: 'parenthesized'; inner: TSType }
	| { type: 'keyof'; argument: TSType }
	| { type: 'readonly'; argument: TSType }
	| { type: 'typeof'; name: string }
	| { type: 'indexed_access'; object: TSType; index: TSType }
	| { type: 'conditional'; checkType: TSType; extendsType: TSType; trueType: TSType; falseType: TSType }
	| { type: 'infer'; name: string; constraint?: TSType }
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
	Rule([Forward(()=>conditional_type)] as const),
);

const type_list = List(type, ',');

// Tuple elements specifically (not `type_list`, which is also used for generic type arguments and
// `extends`/`implements` clauses -- neither of those accepts a bare `...T` spread, only tuple types do).
const tuple_element = Rules<TSType | { type: 'spread'; argument: TSType }>(
	type,
	Rule(['...', type] as const, $ => ({ type: 'spread', argument: $[1] } as const)),
);
const tuple_element_list = List(tuple_element, ',');

// Template literal types (`` `prefix${T}suffix` ``): same lexical structure as js-parser.ts's own
// expression-level template literals (see its `template_literal_part`), so this reuses the *exact*
// same two regex terminals -- a string-run stopping right before `${` (lookahead, doesn't consume it)
// and one stopping right before the closing backtick. Since those are anonymous regex literals interned
// by pattern text, writing the same patterns again here resolves to the same shared terminals rather
// than duplicating them; only the interpolated part differs (`type` here instead of an expression).
// Same fix as js-parser.ts's own `template_literal_part` -- a bare `$` not followed by `{` is ordinary text.
const type_template_literal_part = Rules<TSTemplatePart>(
	Rule([/(?:[^`$]|\$(?!\{))*(?=\$\{)/, '${', type, '}'] as const,	$ => ({ str: $[0], exp: $[2] } as const)),
	Rule([/(?:[^`$]|\$(?!\{))*(?=`)/] as const, 						$ => ({ str: $[0] } as const)),
);
const type_template_literal_parts = List(type_template_literal_part);

// --- Generic calls: `foo<T>(...)` ---
//
// Unlike the statement-level generics above, a call's `<...>` sits in expression position, where `relational_expression`'s own `<`/`>` chain is also live
// -- `foo<T>(x)` and `foo < T > (x)` (two chained comparisons against a parenthesized `x`) are genuinely ambiguous to a context-free grammar.
// Routing it through tison's GLR fork engine would work semantically, but every single ordinary `<` in the file would also fork,
// and forks compound at *every* nested `<` inside the speculative branch before either one fails
//
// So this is resolved in the lexer instead, the same trick REGEX_LITERAL/WS use in js-parser.ts:
// a dedicated terminal for this specific '<' character that scans the raw upcoming text (via `remaining`, before any tokenizing) for a balanced run of plausible type-argument syntax
// (identifiers, `.`, `,`, nested `<>`/`[]`/`{}`, `:`/`;` for inline object-type members, whitespace -- no operators, no parens) immediately followed by '('.
// If that scan fails, `lex` rejects the match and the plain `<` terminal wins instead, so plain `a < b` stays exactly as cheap as it always was.
// Known simplification: a type argument containing a function type (`Foo<(x: T) => void>(...)`) or another call/parenthesized expression won't be recognized,
// since `(`/`)` aren't in the allowed set -- narrowing the heuristic was judged a smaller risk than widening it into more false positives against real comparison chains.
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
	Rule([genericCallOpen, type_list, '>'] as const,	$ => $[1]),
);

const type_parameter = Rules<TSTypeParam>(
	Rule([IDENT] as const,								$ => ({ name: $[0] } as const)),
	Rule([IDENT, 'extends', type] as const,				$ => ({ name: $[0], constraint: $[2] } as const)),
	Rule([IDENT, '=', type] as const,					$ => ({ name: $[0], default: $[2] } as const)),
	Rule([IDENT, 'extends', type, '=', type] as const,	$ => ({ name: $[0], constraint: $[2], default: $[4] } as const)),
);
const type_parameter_list = List(type_parameter, ',');
const type_parameters = Rules<TSTypeParam[]>(
	Rule(['<', type_parameter_list, '>'] as const,		$ => $[1]),
);

// --- Simplified parameter list, for function types and call/method signatures (no defaults, no destructuring -- a known simplification) ---

const ts_param = Rules<TSParam>(
	Rule([IDENT] as const,							$ => ({ name: $[0] } as const)),
	Rule([IDENT, '?'] as const,						$ => ({ name: $[0], optional: true } as const)),
	Rule([IDENT, ':', type] as const,				$ => ({ name: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, '?', ':', type] as const,			$ => ({ name: $[0], optional: true, typeAnnotation: $[3] } as const)),
	Rule(['...', IDENT] as const,					$ => ({ name: $[1], rest: true } as const)),
	Rule(['...', IDENT, ':', type] as const,		$ => ({ name: $[1], rest: true, typeAnnotation: $[3] } as const)),
);
const ts_param_list = List(ts_param, ',');
const ts_param_list_opt = Rules<TSParam[]>(
	Rule([] as const,				() => []),
	ts_param_list,
);

// --- Object type literal / interface body members ---

const type_member = Rules<TSTypeMember>(
	Rule([IDENT, ':', type] as const,									$ => ({ kind: 'property', name: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, '?', ':', type] as const,								$ => ({ kind: 'property', name: $[0], optional: true, typeAnnotation: $[3] } as const)),
	Rule(['readonly', IDENT, ':', type] as const,						$ => ({ kind: 'property', name: $[1], readonly: true, typeAnnotation: $[3] } as const)),
	Rule(['readonly', IDENT, '?', ':', type] as const,					$ => ({ kind: 'property', name: $[1], readonly: true, optional: true, typeAnnotation: $[4] } as const)),
	Rule([IDENT, '(', ts_param_list_opt, ')'] as const,					$ => ({ kind: 'method', name: $[0], params: $[2] } as const)),
	Rule([IDENT, '(', ts_param_list_opt, ')', ':', type] as const,		$ => ({ kind: 'method', name: $[0], params: $[2], returnType: $[5] } as const)),
	Rule([IDENT, '?', '(', ts_param_list_opt, ')'] as const,			$ => ({ kind: 'method', name: $[0], optional: true, params: $[3] } as const)),
	Rule([IDENT, '?', '(', ts_param_list_opt, ')', ':', type] as const,	$ => ({ kind: 'method', name: $[0], optional: true, params: $[3], returnType: $[6] } as const)),
	// Generic methods (`read<T extends U>(spec: T): R`) -- mirrors the plain (non-generic) forms above.
	Rule([IDENT, type_parameters, '(', ts_param_list_opt, ')'] as const,				$ => ({ kind: 'method', name: $[0], params: $[3], typeParams: $[1] } as const)),
	Rule([IDENT, type_parameters, '(', ts_param_list_opt, ')', ':', type] as const,	$ => ({ kind: 'method', name: $[0], params: $[3], typeParams: $[1], returnType: $[6] } as const)),
	Rule(['[', IDENT, ':', type, ']', ':', type] as const,				$ => ({ kind: 'index', paramName: $[1], paramType: $[3], typeAnnotation: $[6] } as const)),
	Rule(['(', ts_param_list_opt, ')', ':', type] as const,				$ => ({ kind: 'call', params: $[1], returnType: $[4] } as const)),
);
// `;`-separated, with an optional trailing `;` -- this grammar doesn't also accept `,` as a member separator (real TypeScript allows either), a known simplification.
const type_separator = OneOf([';', ',']);
const type_member_list = List(type_member, type_separator);
const type_member_body = Rules<TSTypeMember[]>(
	Rule(['{', '}'] as const,											() => []),
	Rule(['{', type_member_list, '}'] as const,							$ => $[1]),
	Rule(['{', type_member_list, type_separator, '}'] as const,			$ => $[1]),
);

// --- Type expression precedence chain: primary -> postfix array -> keyof -> intersection -> union ---

function parseTypeNumber(text: string): number {
	return parseFloat(text.replace(/_/g, ''));
}

// `{ [K in T]: U }`, with an optional `readonly` prefix, `?` optional-modifier suffix, and
// `as`-clause key remapping (`[K in T as U]`). No `+`/`-` modifier-removal forms (`-readonly`/
// `-?`) -- known simplification, same spirit as this file's other omissions.
// Shares its `{ [` opening with `type_member`'s index signature (`{ [key: string]: T }`) --
// they diverge cleanly one token later, on `in` vs `:`, so there's no real ambiguity for the
// LALR table to resolve, just two alternatives reachable from the same prefix.
// Closing `}`, with an optional trailing `;`/`,` after the value type (mapped types only ever have
// one member, so unlike `type_member_body` this doesn't need a real list -- just an optional separator).
const mapped_type_end = Rules<undefined>(
	Rule(['}'] as const,					() => undefined),
	Rule([type_separator, '}'] as const,	() => undefined),
);
const mapped_type = Rules<TSType>(
	Rule(['{', '[', IDENT, 'in', type, ']', ':', type, mapped_type_end] as const,								$ => ({ type: 'mapped', keyName: $[2], constraint: $[4], valueType: $[7] } as const)),
	Rule(['{', '[', IDENT, 'in', type, ']', '?', ':', type, mapped_type_end] as const,							$ => ({ type: 'mapped', keyName: $[2], constraint: $[4], optional: true, valueType: $[8] } as const)),
	Rule(['{', 'readonly', '[', IDENT, 'in', type, ']', ':', type, mapped_type_end] as const,					$ => ({ type: 'mapped', keyName: $[3], constraint: $[5], readonly: true, valueType: $[8] } as const)),
	Rule(['{', 'readonly', '[', IDENT, 'in', type, ']', '?', ':', type, mapped_type_end] as const,				$ => ({ type: 'mapped', keyName: $[3], constraint: $[5], readonly: true, optional: true, valueType: $[9] } as const)),
	Rule(['{', '[', IDENT, 'in', type, 'as', type, ']', ':', type, mapped_type_end] as const,					$ => ({ type: 'mapped', keyName: $[2], constraint: $[4], nameType: $[6], valueType: $[9] } as const)),
	Rule(['{', '[', IDENT, 'in', type, 'as', type, ']', '?', ':', type, mapped_type_end] as const,				$ => ({ type: 'mapped', keyName: $[2], constraint: $[4], nameType: $[6], optional: true, valueType: $[10] } as const)),
	Rule(['{', 'readonly', '[', IDENT, 'in', type, 'as', type, ']', ':', type, mapped_type_end] as const,		$ => ({ type: 'mapped', keyName: $[3], constraint: $[5], nameType: $[7], readonly: true, valueType: $[10] } as const)),
	Rule(['{', 'readonly', '[', IDENT, 'in', type, 'as', type, ']', '?', ':', type, mapped_type_end] as const,	$ => ({ type: 'mapped', keyName: $[3], constraint: $[5], nameType: $[7], readonly: true, optional: true, valueType: $[11] } as const)),
);

// A type reference's name, possibly qualified by a namespace (`ts.Declaration`, `A.B.C`)
// -- only the *last* segment can carry type arguments (`A.B<T>` means B is generic, not A), so this only covers the dotted-name chain itself;
// `primary_type`'s `ref` rules attach `<...>` to the result as a whole.
// Flattened into one joined string rather than a nested qualifier structure, matching this file's existing preference for simple shapes
// (e.g. `key: string | { computed: Expr }`) -- codegen just emits it back out verbatim, so nothing downstream needs the segments split out again.
const type_name = RRules<string>(self => [
	Rule([IDENT]),
	Rule([self, '.', IDENT] as const, $ => $[0] + '.' + $[2]),
]);

const primary_type = Rules<TSType>(
	Rule([type_name] as const,									$ => ({ type: 'ref', name: $[0] } as const)),
	Rule([type_name, '<', type_list, '>'] as const,				$ => ({ type: 'ref', name: $[0], typeArgs: $[2] } as const)),
	Rule(['this'] as const,										() => ({ type: 'this' } as const)),
	Rule(['null'] as const,										() => ({ type: 'literal', value: null } as const)),
	Rule(['true'] as const,										() => ({ type: 'literal', value: true } as const)),
	Rule(['false'] as const,									() => ({ type: 'literal', value: false } as const)),
	Rule([STRING] as const,										$ => ({ type: 'literal', value: unquoteString($[0]) } as const)),
	Rule([NUMBER] as const,										$ => ({ type: 'literal', value: parseTypeNumber($[0]) } as const)),
	Rule(['`', type_template_literal_parts, '`'] as const,		$ => ({ type: 'template_literal', parts: $[1] } as const)),
	Rule(['typeof', type_name] as const,						$ => ({ type: 'typeof', name: $[1] } as const)),
	// `infer` only makes sense inside a conditional type's `extends` operand in real TypeScript, but enforcing that is a checker-level restriction there too, not a grammar one
	// -- allowing it as an ordinary primary type everywhere is simpler and parses every real use of it.
	Rule(['infer', IDENT] as const,								$ => ({ type: 'infer', name: $[1] } as const)),
	// `infer X extends C` (TS 4.7+): constrains the inferred variable directly, e.g. in a tuple/array element
	// position (`readonly [infer Head extends Descriptor, ...]`). The constraint is restricted to `union_type`
	// (via `Forward`, since `union_type` is declared later in this file) rather than the full `type` production,
	// same reasoning and same restriction `conditional_type` itself already applies to its own `extends` operand
	// just below -- without it, a nested `?`/`:` inside the constraint is ambiguous with the *outer* conditional's.
	Rule(['infer', IDENT, 'extends', Forward<TSType>(() => union_type)] as const,	$ => ({ type: 'infer', name: $[1], constraint: $[3] } as const)),
	Rule(['(', type, ')'] as const,								$ => ({ type: 'parenthesized', inner: $[1] } as const)),
	Rule(['[', ']'] as const,									() => ({ type: 'tuple', elements: [] } as const)),
	Rule(['[', tuple_element_list, ']'] as const,				$ => ({ type: 'tuple', elements: $[1] } as const)),
	Rule([type_member_body] as const,							$ => ({ type: 'object', members: $[0] } as const)),
	mapped_type,
	Rule(['(', ts_param_list_opt, ')', '=>', type] as const,	$ => ({ type: 'function', params: $[1], returnType: $[4] } as const)),
	Rule([type_parameters, '(', ts_param_list_opt, ')', '=>', type] as const, $ => ({ type: 'function', params: $[2], returnType: $[5], typeParams: $[0] } as const)),
	// Construct signature type (`new (...) => T`), e.g. a generic constraint like `C extends new (...) => any` --
	// same shape as the plain function type above, just `new`-prefixed.
	Rule(['new', '(', ts_param_list_opt, ')', '=>', type] as const, $ => ({ type: 'constructor', params: $[2], returnType: $[5] } as const)),
	Rule(['new', type_parameters, '(', ts_param_list_opt, ')', '=>', type] as const, $ => ({ type: 'constructor', params: $[3], returnType: $[6], typeParams: $[1] } as const)),
	// `abstract new (...) => T` -- a constructor type that also accepts abstract classes (`new` alone requires a concrete, instantiable one).
	Rule(['abstract', 'new', '(', ts_param_list_opt, ')', '=>', type] as const, $ => ({ type: 'constructor', params: $[3], returnType: $[6], abstract: true } as const)),
	Rule(['abstract', 'new', type_parameters, '(', ts_param_list_opt, ')', '=>', type] as const, $ => ({ type: 'constructor', params: $[4], returnType: $[7], typeParams: $[2], abstract: true } as const)),
);
// Postfix `[]`/`[K]`: left-recursive so `T[][]`/`T[K][J]` stack correctly.
// The empty- and type-filled bracket forms don't conflict -- they diverge on the very next token (`]` vs. a type-start token),
// the same one-token lookahead distinction `array_literal`'s elisions and ordinary elements already rely on in js-parser.ts.
const array_type = RRules<TSType>(self => [
	primary_type,
	Rule([self, '[', ']'] as const,				$ => ({ type: 'array', element: $[0] } as const)),
	Rule([self, '[', type, ']'] as const,		$ => ({ type: 'indexed_access', object: $[0], index: $[2] } as const)),
]);
const unary_type = Rules<TSType>(
	array_type,
	Rule(['keyof', array_type] as const,		$ => ({ type: 'keyof', argument: $[1] } as const)),
	// `readonly` only ever prefixes an array (`readonly T[]`) or tuple (`readonly [string, number]`) type -- both are `array_type` alternatives already,
	// so reusing it here (rather than `fwd_type`) rejects `readonly` in front of anything else, matching real TypeScript.
	Rule(['readonly', array_type] as const,		$ => ({ type: 'readonly', argument: $[1] } as const)),
);
// `&`/`|` reuse `List` directly: each level is just a separated list of the level below, flattened into a `TSType[]` and only wrapped in a union/intersection node when there's more than one member
// -- no precedence declarations are needed since (as in js-parser.ts's own binary chain) each level is its own nonterminal, so the grammar structure alone keeps '&' and '|' from ever competing for the same reduction.
const intersection_list = List(unary_type, '&');
const intersection_type = Rules<TSType>(
	Rule([intersection_list] as const, 			$ => $[0].length === 1 ? $[0][0] : ({ type: 'intersection', types: $[0] } as const)),
	// A leading `&` before the first member is purely stylistic (common for multi-line declarations) and carries no meaning of its own.
	Rule(['&', intersection_list] as const,		$ => $[1].length === 1 ? $[1][0] : ({ type: 'intersection', types: $[1] } as const)),
);
const union_list = List(intersection_type, '|');
const union_type = Rules<TSType>(
	Rule([union_list] as const,					$ => $[0].length === 1 ? $[0][0] : ({ type: 'union', types: $[0] } as const)),
	// Same leading-separator allowance as intersection_type's `&`, one level up.
	Rule(['|', union_list] as const,			$ => $[1].length === 1 ? $[1][0] : ({ type: 'union', types: $[1] } as const)),
);
// Conditional types: `CheckType extends ExtendsType ? TrueType : FalseType`.
// The check/extends operands are restricted to `union_type` (not the full conditional grammar) to avoid recursive ambiguity around nested `?`/`:`
// -- the same reason real TypeScript's own grammar restricts them to NoConditionalType.
// True/false branches are the full `fwd_type`, so chains like `T extends A ? X : T extends B ? Y : Z` thread through the false branch like a chained `?:`.
const conditional_type = Rules<TSType>(
	union_type,
	Rule([union_type, 'extends', union_type, '?', type, ':', type] as const,
		$ => ({ type: 'conditional', checkType: $[0], extendsType: $[2], trueType: $[4], falseType: $[6] } as const)),
);

const return_type = Rules<TSType>(
	type,
	Rule([IDENT, 'is', type] as const,			$ => ({ type: 'predicate', paramName: $[0], assertedType: $[2] } as const)),
);

// ===================================================================
//  Declarations: `type`, `interface`, `enum`
// ===================================================================

// `type` is only a keyword right before a `type X = ...` alias declaration
// -- unlike this file's other contextual keywords, it needs an explicit reclassification here (mirroring js-parser.ts's GET/SET/ASYNC)
// Checked against `lex.remaining` directly (not `lex.next()`) -- `next()` re-lexes using the *current* position's own candidate-restricted terminal set (see js-parser.ts's `WS` terminal, which falls back to
// `lex.remaining` for the same reason), which right after `export` doesn't even include IDENT as a candidate
const TYPE = terminal('type', /type(?!\w)/, lex => /^\s*[$_\p{ID_Start}]/u.test(lex.remaining) ? TYPE : IDENT);

const type_alias_declaration = Rules<TSDeclaration>(
	Rule([TYPE, IDENT, '=', type, ';'] as const,					$ => ({ type: 'type_alias_decl', name: $[1], value: $[3] } as const)),
	Rule([TYPE, IDENT, type_parameters, '=', type, ';'] as const,	$ => ({ type: 'type_alias_decl', name: $[1], typeParams: $[2], value: $[4] } as const)),
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
	Rule(['enum', IDENT, '{', '}'] as const,									$ => ({ type: 'enum_decl', name: $[1], members: [] } as const)),
	Rule(['enum', IDENT, '{', enum_member_list, '}'] as const,					$ => ({ type: 'enum_decl', name: $[1], members: $[3] } as const)),
	Rule(['enum', IDENT, '{', enum_member_list, ',', '}'] as const,				$ => ({ type: 'enum_decl', name: $[1], members: $[3] } as const)),
	Rule(['const', 'enum', IDENT, '{', '}'] as const,							$ => ({ type: 'enum_decl', name: $[2], const: true, members: [] } )),
	Rule(['const', 'enum', IDENT, '{', enum_member_list, '}'] as const,			$ => ({ type: 'enum_decl', name: $[2], const: true, members: $[4] })),
	Rule(['const', 'enum', IDENT, '{', enum_member_list, ',', '}'] as const,	$ => ({ type: 'enum_decl', name: $[2], const: true, members: $[4] })),
);

// `declare function` can't reuse `function_declaration` as-is: an ambient function has no body at all
const declare_function = Rules<Statement>(
	Rule(['function', IDENT, parameter_clause, ';'] as const,					$ => ({ type: 'function_decl', name: $[1], ...$[2] } as const)),
	Rule(['function', IDENT, parameter_clause, ':', return_type, ';'] as const,	$ => ({ type: 'function_decl', name: $[1], ...$[2], returnType: $[4] } as const)),
	// Generic overload signatures (`function foo<T>(x: T): T;`) -- same bodyless shape as above, just with type parameters.
	Rule(['function', IDENT, type_parameters, parameter_clause, ';'] as const,						$ => ({ type: 'function_decl', name: $[1], ...$[3], typeParams: $[2] } as const)),
	Rule(['function', IDENT, type_parameters, parameter_clause, ':', return_type, ';'] as const,	$ => ({ type: 'function_decl', name: $[1], ...$[3], typeParams: $[2], returnType: $[5] } as const)),
);

// Extend `statement` (reachable from both block bodies and, via `module_item`'s own `[statement]` rule, the top level) so these
// declarations work in either place, exactly like the rest of TypeScript's declarations. `statement`'s static element type is the closed `Statement`
// union from js-parser.ts; widening it to also produce `TSDeclaration` needs one cast at the array level (the runtime array is untouched by the
// cast -- it's the same array `module_item`/`program` already read from).
const tsStatement = statement as unknown as Rules<TSStatement>;
tsStatement.push(
	interface_declaration,
	type_alias_declaration,
	enum_declaration,

// `declare_function` doubles as a plain (non-ambient) overload signature
// -- real TypeScript lets `function foo<T>(x: T): T;` stand alone, preceding a same-named implementation elsewhere;
// this grammar doesn't check that the names/signatures actually line up with a later implementation, the same spirit as its other syntax-only simplifications.
	declare_function,

	Rule(['declare', variable_statement] as const,		$ => ({ type: 'declare', declaration: $[1] } as const)),
	Rule(['declare', function_declaration] as const,	$ => ({ type: 'declare', declaration: $[1] } as const)),
	Rule(['declare', declare_function] as const,		$ => ({ type: 'declare', declaration: $[1] } as const)),
	Rule(['declare', class_declaration] as const,		$ => ({ type: 'declare', declaration: $[1] } as const)),
	Rule(['declare', enum_declaration] as const,		$ => ({ type: 'declare', declaration: $[1] } as const)),
);

const tsExportDeclaration = export_declaration as unknown as Rules<TSStatement>;
tsExportDeclaration.push(
	Rule(['export', interface_declaration] as const,	$ => $[1]),
	Rule(['export', type_alias_declaration] as const,	$ => $[1]),
	Rule(['export', enum_declaration] as const,			$ => $[1]),
	// js-parser.ts's own `Rule(['export', function_declaration], ...)` doesn't cover this -- `declare_function`'s bodyless overload-signature shape is a separate nonterminal (see above)
	Rule(['export', declare_function] as const,			$ => ({ type: 'export_decl', declaration: $[1] } as const)),
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
	Rule([IDENT, '?'] as const, 										$ => ({ target: $[0], optional: true } as const), forceFork),
	Rule([IDENT, ':', type] as const,									$ => ({ target: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, '?', ':', type] as const,								$ => ({ target: $[0], optional: true, typeAnnotation: $[3] } as const)),
	Rule([IDENT, ':', type, '=', assignment_expression] as const,		$ => ({ target: $[0], typeAnnotation: $[2], default: $[4] } as const)),
	// Parameter properties (`constructor(public x: number)`): valid anywhere a parameter is, not just inside a constructor -- this syntax-only grammar doesn't check that, a known simplification.
	Rule([param_modifier_list, IDENT] as const,							$ => ({ target: $[1], modifiers: $[0] } as const)),
	Rule([param_modifier_list, IDENT, ':', type] as const,				$ => ({ target: $[1], modifiers: $[0], typeAnnotation: $[3] } as const)),
	Rule([param_modifier_list, IDENT, '?', ':', type] as const,			$ => ({ target: $[1], optional: true, modifiers: $[0], typeAnnotation: $[4] } as const)),
	// Untyped, default-valued parameter property (`protected offset = 0`) -- mirrors js-parser.ts's
	// own plain `IDENT '=' assignment_expression` rule, just with modifiers.
	Rule([param_modifier_list, IDENT, '=', assignment_expression] as const,				$ => ({ target: $[1], modifiers: $[0], default: $[3] } as const)),
	Rule([param_modifier_list, IDENT, ':', type, '=', assignment_expression] as const,	$ => ({ target: $[1], modifiers: $[0], typeAnnotation: $[3], default: $[5] } as const)),
);

// `parameter_clause` embeds its own `'...' IDENT` rest-parameter forms directly
// (rather than going through `parameter`, which only ever handles non-rest parameters),
// so typed rest parameters (`...args: T[]`) need their own variants pushed here too, mirroring js-parser.ts's untyped ones.
parameter_clause.push(
	Rule(['(', '...', IDENT, ':', type, ')'] as const,								$ => ({ params: [], rest: $[2], restType: $[4] } as const)),
	Rule(['(', formal_parameter_list, ',', '...', IDENT, ':', type, ')'] as const,	$ => ({ params: $[1], rest: $[4], restType: $[6] } as const)),
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

// The whole `parameter_clause` result is spread (`...$[N]`) rather than its fields spelled out one by one --
// a typed rest parameter's type (`restType`, set by `parameter_clause`'s typed-rest pushes above) was once
// silently dropped by an explicit `params`/`rest` spelling that didn't know about it; the spread can't repeat that.
function_expression.push(
	Rule(['function', parameter_clause, ':', type, '{', function_body, '}'] as const,						$ => ({ type: 'function', ...$[1], body: $[5], returnType: $[3] } as const)),
	Rule(['function', IDENT, parameter_clause, ':', type, '{', function_body, '}'] as const,				$ => ({ type: 'function', name: $[1], ...$[2], body: $[6], returnType: $[4] } as const)),
	Rule(['async', 'function', parameter_clause, ':', type, '{', function_body, '}'] as const,				$ => ({ type: 'function', ...$[2], body: $[6], async: true, returnType: $[4] } as const)),
	Rule(['async', 'function', IDENT, parameter_clause, ':', type, '{', function_body, '}'] as const,		$ => ({ type: 'function', name: $[2], ...$[3], body: $[7], async: true, returnType: $[5] } as const)),
	// Generics (anonymous/named, with/without a return type -- not combined with `async`, see header comment).
	Rule(['function', type_parameters, parameter_clause, '{', function_body, '}'] as const,					$ => ({ type: 'function', ...$[2], body: $[4], typeParams: $[1] } as const)),
	Rule(['function', type_parameters, parameter_clause, ':', type, '{', function_body, '}'] as const,		$ => ({ type: 'function', ...$[2], body: $[6], typeParams: $[1], returnType: $[4] } as const)),
	Rule(['function', IDENT, type_parameters, parameter_clause, '{', function_body, '}'] as const,			$ => ({ type: 'function', name: $[1], ...$[3], body: $[5], typeParams: $[2] } as const)),
	Rule(['function', IDENT, type_parameters, parameter_clause, ':', type, '{', function_body, '}'] as const, $ => ({ type: 'function', name: $[1], ...$[3], body: $[7], typeParams: $[2], returnType: $[5] } as const)),
);
function_declaration.push(
	Rule(['function', IDENT, parameter_clause, ':', return_type, '{', function_body, '}'] as const,			$ => ({ type: 'function_decl', name: $[1], ...$[2], body: $[6], returnType: $[4] } as const)),
	Rule(['async', 'function', IDENT, parameter_clause, ':', return_type, '{', function_body, '}'] as const,$ => ({ type: 'function_decl', name: $[2], ...$[3], body: $[7], async: true, returnType: $[5] } as const)),
	// Generics (with/without a return type, plain or `async`).
	Rule(['function', IDENT, type_parameters, parameter_clause, '{', function_body, '}'] as const,			$ => ({ type: 'function_decl', name: $[1], ...$[3], body: $[5], typeParams: $[2] } as const)),
	Rule(['function', IDENT, type_parameters, parameter_clause, ':', return_type, '{', function_body, '}'] as const, $ => ({ type: 'function_decl', name: $[1], ...$[3], body: $[7], typeParams: $[2], returnType: $[5] } as const)),
	Rule(['async', 'function', IDENT, type_parameters, parameter_clause, '{', function_body, '}'] as const,	$ => ({ type: 'function_decl', name: $[2], ...$[4], body: $[6], typeParams: $[3], async: true } as const)),
	Rule(['async', 'function', IDENT, type_parameters, parameter_clause, ':', return_type, '{', function_body, '}'] as const, $ => ({ type: 'function_decl', name: $[2], ...$[4], body: $[8], typeParams: $[3], async: true, returnType: $[6] } as const)),
);

class_member_body.push(
	// Return types -- plain and async methods (already had this), plus generator/async-generator methods and the `get` accessor (the `set` accessor's "return type" would always just be `void`,
	// so it's skipped, same as js-parser.ts's own get/set asymmetry: `get`'s shape already differs from `set`'s by having no parameter).
	// The `parameter_clause` result is spread whole (`...$[N]`), same reasoning as function_expression/function_declaration above.
	Rule([class_member_name, parameter_clause, ':', type, '{', function_body, '}'] as const,				$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', ...$[1], body: $[5], returnType: $[3] } } as const)),
	Rule(['async', class_member_name, parameter_clause, ':', type, '{', function_body, '}'] as const,		$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', ...$[2], body: $[6], async: true, returnType: $[4] } } as const)),
	Rule(['*', class_member_name, parameter_clause, ':', type, '{', function_body, '}'] as const,			$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', ...$[2], body: $[6], generator: true, returnType: $[4] } } as const)),
	Rule(['async', '*', class_member_name, parameter_clause, ':', type, '{', function_body, '}'] as const,	$ => ({ type: 'method', kind: 'method', key: $[2] as string | { computed: Expr }, value: { type: 'function', ...$[3], body: $[7], generator: true, async: true, returnType: $[5] } } as const)),
	Rule(['get', class_member_name, '(', ')', ':', type, '{', function_body, '}'] as const,					$ => ({ type: 'method', kind: 'get', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: [], body: $[7], returnType: $[5] } } as const)),
	// `set`'s *parameter* type (not a return type -- setters have no return-type position to annotate,
	// which is what the comment above is actually about). js-parser.ts's own `set` rule only accepts a
	// bare untyped `IDENT` parameter; this adds the typed form (`set foo(val: string) { ... }`).
	Rule(['set', class_member_name, '(', IDENT, ':', type, ')', '{', function_body, '}'] as const,			$ => ({ type: 'method', kind: 'set', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: [{ target: $[3], typeAnnotation: $[5] }], body: $[8] } } as const)),
	// Generics (with/without a return type, plain or `async`).
	Rule([class_member_name, type_parameters, parameter_clause, '{', function_body, '}'] as const,			$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', ...$[2], body: $[4], typeParams: $[1] } } as const)),
	Rule([class_member_name, type_parameters, parameter_clause, ':', type, '{', function_body, '}'] as const, $ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', ...$[2], body: $[6], typeParams: $[1], returnType: $[4] } } as const)),
	Rule(['async', class_member_name, type_parameters, parameter_clause, '{', function_body, '}'] as const,	$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', ...$[3], body: $[5], typeParams: $[2], async: true } } as const)),
	Rule(['async', class_member_name, type_parameters, parameter_clause, ':', type, '{', function_body, '}'] as const, $ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', ...$[3], body: $[7], typeParams: $[2], async: true, returnType: $[5] } } as const)),
	// Optional methods (`foo?() {}`).
	Rule([class_member_name, '?', parameter_clause, '{', function_body, '}'] as const,						$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', ...$[2], body: $[4] }, optional: true } as const)),
	// Typed fields, optional fields, definite-assignment assertion (`x!: number;`).
	Rule([class_member_name, ':', type, ';'] as const,														$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, typeAnnotation: $[2] } as const)),
	Rule([class_member_name, ':', type, '=', assignment_expression, ';'] as const,							$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, typeAnnotation: $[2], value: $[4] } as const)),
	Rule([class_member_name, '?', ':', type, ';'] as const,													$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, optional: true, typeAnnotation: $[3] } as const)),
	Rule([class_member_name, '?', ':', type, '=', assignment_expression, ';'] as const,						$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, optional: true, typeAnnotation: $[3], value: $[5] } as const)),
	Rule([class_member_name, '!', ':', type, ';'] as const,													$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, typeAnnotation: $[3], definite: true } as const)),
	// Method overload signatures (`read<T extends TypeReader>(spec: T): Promise<ReadType<T>>;`) -- bodyless,
	// same spirit as `declare_function`'s top-level equivalent below: real TypeScript lets these precede a same-named implementation elsewhere;
	// this grammar doesn't check that the names/signatures actually line up with it, the same syntax-only simplification as `declare_function`'s.
	Rule([class_member_name, parameter_clause, ';'] as const,												$ => ({ type: 'method_signature', key: $[0] as string | { computed: Expr }, ...$[1] } as const)),
	Rule([class_member_name, parameter_clause, ':', type, ';'] as const,									$ => ({ type: 'method_signature', key: $[0] as string | { computed: Expr }, ...$[1], returnType: $[3] } as const)),
	Rule([class_member_name, type_parameters, parameter_clause, ';'] as const,								$ => ({ type: 'method_signature', key: $[0] as string | { computed: Expr }, ...$[2], typeParams: $[1] } as const)),
	Rule([class_member_name, type_parameters, parameter_clause, ':', type, ';'] as const,					$ => ({ type: 'method_signature', key: $[0] as string | { computed: Expr }, ...$[2], typeParams: $[1], returnType: $[4] } as const)),
);

// Return-type-annotated object literal methods (`{ foo(x: number): string { ... } }`) -- mirrors `class_member_body`'s method/async/generator/async-generator/`get`
// set just above (`set` skipped for the same reason: its "return type" is always `void`).
property_assignment.push(
	Rule([property_name, parameter_clause, ':', type, '{', function_body, '}'] as const,					$ => ({ key: $[0], value: { type: 'function', ...$[1], body: $[5], returnType: $[3] }, kind: 'init' } as const)),
	Rule(['async', property_name, parameter_clause, ':', type, '{', function_body, '}'] as const,			$ => ({ key: $[1], value: { type: 'function', ...$[2], body: $[6], async: true, returnType: $[4] }, kind: 'init' } as const)),
	Rule(['*', property_name, parameter_clause, ':', type, '{', function_body, '}'] as const,				$ => ({ key: $[1], value: { type: 'function', ...$[2], body: $[6], generator: true, returnType: $[4] }, kind: 'init' } as const)),
	Rule(['async', '*', property_name, parameter_clause, ':', type, '{', function_body, '}'] as const,		$ => ({ key: $[2], value: { type: 'function', ...$[3], body: $[7], generator: true, async: true, returnType: $[5] }, kind: 'init' } as const)),
	Rule(['get', property_name, '(', ')', ':', type, '{', function_body, '}'] as const,						$ => ({ key: $[1], value: { type: 'function', params: [], body: $[7], returnType: $[5] }, kind: 'get' } as const)),
);

// Static initialization blocks (`static { ... }`)
// -- pushed onto `class_member` directly (not `class_member_body`) since the shape doesn't fit the "static" + ordinary-member wrapping the modifiers push below already does: there's no member-name/key here at all.
class_member.push(
	Rule(['static', '{', function_body, '}'] as const, $ => ({ type: 'static_block', body: $[2] } as const)),
);

// Member modifiers (`public`/`private`/`protected`/`readonly`/`abstract`/`static`), any number of them in any order --
// real TypeScript allows them fairly freely intermixed (`static readonly`, `public static`, even `readonly static`),
// so `static` is folded into the same list rather than pinned to a fixed slot relative to the others (which previously
// only accepted modifiers *before* `static`, rejecting the far more idiomatic `static readonly x` ordering).
// Pushed onto `class_member` (not `class_member_body`) so this applies uniformly to every member shape -- including
// the ones just added above -- without duplicating each shape once per modifier combination.
const class_member_modifier_list = List(OneOf(['public', 'private', 'protected', 'readonly', 'abstract', 'static']));

class_member.push(
	Rule([class_member_modifier_list, class_member_body] as const, $ => {
		const mods = $[0];
		const modifiers = mods.filter(m => m !== 'static');
		return {
			...$[1],
			...(modifiers.length ? { modifiers } : {}),
			...(mods.includes('static') ? { static: true } : {}),
		};
	}),
);

// ===================================================================
//  Typed variable declarations
// ===================================================================

variable_declaration.push(
	Rule([IDENT, ':', type] as const,								$ => ({ name: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, ':', type, '=', assignment_expression] as const,	$ => ({ name: $[0], typeAnnotation: $[2], init: $[4] } as const)),
	Rule([IDENT, '!', ':', type] as const,							$ => ({ name: $[0], typeAnnotation: $[3], definite: true } as const)),
);
variable_declaration_noin.push(
	Rule([IDENT, ':', type] as const,								$ => ({ name: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, ':', type, '=', assignment_expression] as const,	$ => ({ name: $[0], typeAnnotation: $[2], init: $[4] } as const)),
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
	Rule(['class', IDENT, type_parameters, class_body] as const,															$ => ({ type: 'class', name: $[1], typeParams: $[2], body: $[3] } as const)),
	Rule(['class', IDENT, implements_clause, class_body] as const,															$ => ({ type: 'class', name: $[1], implementsClause: $[2], body: $[3] } as const)),
	Rule(['class', IDENT, type_parameters, implements_clause, class_body] as const,											$ => ({ type: 'class', name: $[1], typeParams: $[2], implementsClause: $[3], body: $[4] } as const)),
	Rule(['class', IDENT, 'extends', left_hand_side_expression, implements_clause, class_body] as const,					$ => ({ type: 'class', name: $[1], superClass: $[3], implementsClause: $[4], body: $[5] } as const)),
);

// `abstract class ...` -- only the bare/extends/implements/extends+implements shapes
// (no generics combined with `abstract`, and declarations only, not expressions -- `abstract class {}` as an expression isn't valid TS anyway).
// A plain scope cut to keep this from doubling the list above, not a grammar-ambiguity workaround
class_declaration.push(
	Rule(['abstract', 'class', IDENT, class_body] as const,																	$ => ({ type: 'class_decl', name: $[2], body: $[3], abstract: true } as const)),
	Rule(['abstract', 'class', IDENT, 'extends', left_hand_side_expression, class_body] as const,							$ => ({ type: 'class_decl', name: $[2], superClass: $[4], body: $[5], abstract: true } as const)),
	Rule(['abstract', 'class', IDENT, implements_clause, class_body] as const,												$ => ({ type: 'class_decl', name: $[2], implementsClause: $[3], body: $[4], abstract: true } as const)),
	Rule(['abstract', 'class', IDENT, 'extends', left_hand_side_expression, implements_clause, class_body] as const,		$ => ({ type: 'class_decl', name: $[2], superClass: $[4], implementsClause: $[5], body: $[6], abstract: true } as const)),
);

// ===================================================================
//  `expr as Type` / `expr satisfies Type` / `expr!` (non-null assertion)
// ===================================================================

// Pushed onto `relational_expression` -- the same level real TypeScript's own grammar places `AsExpression` at (above additive/shift, beside the other relational operators),
// so e.g. `a + b as T` parses as `(a + b) as T`.
// satisfies` is a fresh reserved word (no other rule anywhere references it), so it carries none of the collision risk 'as'/'<'/'>' had
// -- it just slots in as one more alternative at the same level.
relational_expression.push(
	Rule([relational_expression, 'as', type] as const,					$ => ({ type: 'as_expression', expression: $[0], typeAnnotation: $[2] } as const)),
	Rule([relational_expression, 'satisfies', type] as const,			$ => ({ type: 'satisfies_expression', expression: $[0], typeAnnotation: $[2] } as const)),
);

call_expression.push(
	// Pushed onto `call_expression` -- the same nonterminal js-parser.ts's own `.`/`[]`/`?.` continuations live on, so `foo!.bar`, `foo!()`, etc. keep chaining through call_expression's existing self-recursive rules.
	Rule([member_expression, '!'] as const,								$ => ({ type: 'non_null', expression: $[0] } as const)),
	Rule([call_expression, '!'] as const,								$ => ({ type: 'non_null', expression: $[0] } as const)),
	// Generic call: `foo<T>(...)` -- see `call_type_arguments` above for how its opening '<' is disambiguated from a relational comparison purely in the lexer, with no grammar ambiguity here.
	Rule([member_expression, call_type_arguments, arguments_] as const,	$ => ({ type: 'call', callee: $[0], arguments: $[2] as Expr[], typeArgs: $[1] } as const)),
	Rule([call_expression, call_type_arguments, arguments_] as const,	$ => ({ type: 'call', callee: $[0], arguments: $[2] as Expr[], typeArgs: $[1] } as const)),
);

// Generic `new`: `new Foo<T>(...)` -- js-parser.ts's own `new` rule (on member_expression) has no type-arguments slot,
// so this is pushed on as its own alternative rather than threaded through it.
member_expression.push(
	Rule(['new', member_expression, call_type_arguments, arguments_] as const, $ => ({ type: 'new', callee: $[1], arguments: $[3] as Expr[], typeArgs: $[2] } as const)),
);

// Mirror the same three extensions above onto js-parser.ts's parallel "_nobrace" expression chain --
// its mechanism for contexts where a leading `{` must never be reinterpreted as an (implicit) object
// literal, e.g. an arrow function's concise (non-block) body: `x => { ... }` is always a block, so
// `arrow_body` routes its non-block alternative through `_nobrace`, not the regular chain. Without
// this, `x => new Map<string, number>()` would fail to parse -- the regular chain's generic-call and
// generic-`new` extensions above weren't reachable from there at all. (`new`'s own callee position
// doesn't need the `_nobrace` treatment itself, same as js-parser.ts's own `new_expression_nobrace`:
// once `new` is shifted, an object-literal-vs-block ambiguity can no longer arise.)
relational_expression_nobrace.push(
	Rule([relational_expression_nobrace, 'as', type] as const,					$ => ({ type: 'as_expression', expression: $[0], typeAnnotation: $[2] } as const)),
	Rule([relational_expression_nobrace, 'satisfies', type] as const,			$ => ({ type: 'satisfies_expression', expression: $[0], typeAnnotation: $[2] } as const)),
);
call_expression_nobrace.push(
	Rule([member_expression_nobrace, '!'] as const,								$ => ({ type: 'non_null', expression: $[0] } as const)),
	Rule([call_expression_nobrace, '!'] as const,								$ => ({ type: 'non_null', expression: $[0] } as const)),
	Rule([member_expression_nobrace, call_type_arguments, arguments_] as const,	$ => ({ type: 'call', callee: $[0], arguments: $[2] as Expr[], typeArgs: $[1] } as const)),
	Rule([call_expression_nobrace, call_type_arguments, arguments_] as const,	$ => ({ type: 'call', callee: $[0], arguments: $[2] as Expr[], typeArgs: $[1] } as const)),
);
member_expression_nobrace.push(
	Rule(['new', member_expression, call_type_arguments, arguments_] as const,	$ => ({ type: 'new', callee: $[1], arguments: $[3] as Expr[], typeArgs: $[2] } as const)),
);

// ===================================================================
//  arrow functions
// ===================================================================
arrow_function.push(
	// Same genuine ambiguity as `parameter`'s bare `IDENT '?'` rule (see the `forceFork` comment there):
	// right after a bare identifier, seeing ':' doesn't yet say whether this is a/ single-param typed arrow (`x: number => ...`) or just `identifier` reducing to continue as
	// part of a larger expression where ':' means something else entirely (e.g. a ternary's separator, as in `(a ? b : c)`'s `b`). Needs `forceFork` for the same reason.
	Rule([IDENT,  ':', type, '=>', arrow_body] as const, 						$ => ({ type: 'arrow', params: [$[0]], body: $[4], returnType: $[2] } as const), forceFork),
	Rule([parameter_clause, '=>', arrow_body] as const, 						$ => ({ type: 'arrow', ...$[0], body: $[2] } as Expr)),
	Rule([parameter_clause, ':', type, '=>', arrow_body] as const, 				$ => ({ type: 'arrow', ...$[0], body: $[4], returnType: $[2] } as Expr)),
	Rule(['async', IDENT, '=>', arrow_body] as const, 							$ => ({ type: 'arrow', params: [$[1]], body: $[3], async: true } as const)),
	Rule(['async', IDENT, ':', type, '=>', arrow_body] as const, 				$ => ({ type: 'arrow', params: [$[1]], body: $[5], returnType: $[3], async: true } as const)),
	Rule(['async', parameter_clause, '=>', arrow_body] as const, 				$ => ({ type: 'arrow', ...$[1], body: $[3], async: true } as const)),
	Rule(['async', parameter_clause, ':', type, '=>', arrow_body] as const, 	$ => ({ type: 'arrow', ...$[1], body: $[5], returnType: $[3], async: true } as const)),
);

// Typed catch binding (`catch (e: any) { ... }`) -- real TypeScript only allows `any`/`unknown` here
// (a caught value's type can never be narrower), but since it's otherwise meaningless to the checker
// this grammar accepts (and discards) any `type`, the same syntax-only simplification as elsewhere.
catch_.push(
	Rule(['catch', '(', IDENT, ':', type, ')', '{', '}'] as const,					$ => ({ param: $[2], body: [] as Statement[] } as const)),
	Rule(['catch', '(', IDENT, ':', type, ')', '{', statement_list, '}'] as const,	$ => ({ param: $[2], body: $[7] } as const)),
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

