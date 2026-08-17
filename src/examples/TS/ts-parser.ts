import * as path from 'path';
import { Rules, Forward, Maybe, List, MaybeList, OneOf, terminal, ForceFork } from '../../tison';
import { makeCachedParser } from '../../tableCache';
import * as JS from './js-parser';
import { IDENT, NUM, STR, unquoteString, Rule } from './js-parser';
import { Literal, UnaryPost, mergeMods } from '../common';

// ===================================================================
//  TypeScript Parser -- an extension of js-parser
// ===================================================================
//
// Known simplifications/omissions:
//   - 'type'/'interface'/'enum'/'implements'/'keyof'/'public'/'private'/'protected'/'abstract'/'as'/'satisfies'/'declare' are not fully contextual only
//     ('readonly' is -- it falls back to a plain identifier when immediately followed by `?`/`:`, the one shape a real modifier can never produce)
//   - No `as`-clause key remapping (`[K in T as U]`)
//   - No decorators
//   - No private `#name` members
//   - Index signatures (`[key: string]: T`) and call signatures (bare `(...): T`) are not supported in `set` (a setter's "return type" is always `void`, so there'd be nothing meaningful to record).

// ===================================================================
//  AST
// ===================================================================

export type		Key			= JS.Key<Type>;
export type		Expr		= JS.Expr<Type>;
export type		Param		= JS.Param<Type>;
export type		Params		= JS.Params<Type>;
export type		CallSig		= JS.CallSig<Type>;
export const	CallSig		= JS.CallSig<Type>;
export type		Class		= JS.Class<Type, ClassMember>;
export type		TypeParam	= JS.TypeParam<Type>;
export function TypeParam(name: string, constraint?: Type, cnst?: boolean): TypeParam { return { name, constraint, const: cnst }; }

export interface RefType<T extends string = string> { type: 'ref'; name: T; typeArgs?: Type[]; declScope?: unknown }
export function  RefType<T extends string>(name: T, typeArgs?: Type[] ): RefType<T> { return { type: 'ref', name, typeArgs }; }

export interface UnionType { type: 'union'; types: Type[] }
export function  UnionType(types: Type[]): UnionType { return { type: 'union', types }; }

export interface IntersectionType { type: 'intersection'; types: Type[] }
export function  IntersectionType(types: Type[]): IntersectionType { return { type: 'intersection', types }; }

export interface FunctionType extends CallSig { type: 'function'; }
export function  FunctionType(...args: JS.CallSigParams<Type>): FunctionType { return {type: 'function', ...CallSig(...args) }; }

export interface ConstructorType extends CallSig { type: 'constructor'; abstract?: boolean }

// A control-flow-narrowed `number`/`bigint`: bounds are inclusive, `undefined` on either side means unbounded there.
// Not writable in source syntax -- only ever produced internally by narrowing (see `type-utils.ts`'s `toRange`/`rangeToType`).
// A `bigint` has no `Literal` node of its own (see `Type` below), so an exact bigint value is represented as a
// degenerate range (`min === max`); `tocode.ts` prints that case back out as a real bigint literal (e.g. `10n`).
// `frozen`: see `common.ts`'s `Literal.frozen` -- same purpose, for a `bigint`'s degenerate-range literal form.
export interface RangeType { type: 'range'; base: 'number' | 'bigint'; min?: number | bigint; max?: number | bigint; integer?: boolean; frozen?: boolean }
export function  RangeType(base: 'number' | 'bigint', min?: number | bigint, max?: number | bigint, integer?: boolean): RangeType { return { type: 'range', base, min, max, integer }; }

export type TypeMember =
	| { type: 'property'; key: Key; typeAnnotation: Type, modifiers?: string[] }
	| { type: 'method'; key: Key; modifiers?: string[] } & CallSig
	| { type: 'index'; paramName: string; paramType: Type; typeAnnotation: Type; modifiers?: string[] }
	| { type: 'call' } & CallSig
	| { type: 'construct' } & CallSig
export function TypeMember(type: 'call'|'construct', sig: CallSig): TypeMember { return { type, ...sig }; }
export function TypeProperty(key: Key, typeAnnotation: Type, modifiers?: string[]): TypeMember { return { type: 'property', key, typeAnnotation, modifiers }; }
export function TypeMethod(key: Key, sig: CallSig, modifiers?: string[]): TypeMember { return { type: 'method', key, ...sig, modifiers }; }
export function TypeIndex(paramName: string, paramType: Type, typeAnnotation: Type, modifiers?: string[]): TypeMember { return { type: 'index', paramName, paramType, typeAnnotation, modifiers }; }
export function TypeCall(sig: CallSig)		{ return TypeMember('call', sig); }
export function TypeConstruct(sig: CallSig)	{ return TypeMember('construct', sig); }

export interface MappedType { type: 'mapped'; keyName: string; constraint: Type; nameType?: Type; valueType: Type; modifiers?: string[]; }
export function  MappedType(keyName: string, constraint: Type, nameType: Type|undefined, valueType: Type, modifiers?: string[]): MappedType { return { type: 'mapped', keyName, constraint, nameType, valueType, modifiers }; }

export type TupleElement = Type
 	| { type: 'spread'; argument: Type; label?: string }
	| { type: 'optional'; element: Type }
	| { type: 'labeled'; label: string; element: Type; optional?: boolean };

export interface ObjectType	{ type: 'object'; members: TypeMember[] }
export function  ObjectType(members: TypeMember[]): ObjectType { return {type: 'object', members }; }

export interface ArrayType { type: 'array'; element: Type; readonly?: boolean }
export function  ArrayType(element: Type, readonly?: boolean): ArrayType { return {type: 'array', element, readonly}; }

export interface Predicate { type: 'predicate'; paramName: string; assertedType?: Type; asserts?: boolean }
export function  Predicate(paramName: string, assertedType?: Type, asserts?: boolean): Predicate { return {type: 'predicate', paramName, assertedType, asserts }; }

export type Type =
	| RefType
	| Literal<string | number | boolean | null | JS.TemplatePart<Type>[]>
	| RangeType
	| ArrayType
	| UnionType
	| IntersectionType
	| FunctionType
	| ConstructorType
	| ObjectType
	| MappedType
	| { type: 'this' }
	| { type: 'tuple'; elements: TupleElement[]; readonly?: boolean }
	| { type: 'keyof'; argument: Type }
	| { type: 'typeof'; name: string; source?: string; typeArgs?: Type[] }
	| { type: 'indexed_access'; object: Type; index: Type }
	| { type: 'conditional'; checkType: Type; extendsType: Type; trueType: Type; falseType: Type }
	| { type: 'infer'; name: string; constraint?: Type }
	| { type: 'predicate'; paramName: string; assertedType?: Type; asserts?: boolean }
	| { type: 'import'; source: string; name?: string; typeArgs?: Type[] };

export interface EnumMember { name: string; init?: Expr; }
interface EnumDecl { type: 'enum_decl'; name: string; const?: boolean; members: EnumMember[]; ambient?: boolean }

interface ModuleDecl { type: 'module_decl'; name: string; body: Declaration[]; ambient?: boolean }
function  ModuleDecl(name: string, body: Declaration[]): ModuleDecl { return { type: 'module_decl', name, body}; }

interface NamespaceDecl { type: 'namespace_decl'; name: string; body: Statement[]; ambient?: boolean }
function  NamespaceDecl(name: string, body: Statement[], ambient?: boolean): NamespaceDecl { return { type: 'namespace_decl', name, body, ambient }; }

export type MaybeAmbient = JS.Declaration<Type>
	| EnumDecl
	| NamespaceDecl
	| ModuleDecl

export type Declaration = MaybeAmbient
	| { type: 'interface_decl'; name: string; typeParams?: TypeParam[]; extendsClause?: Type[]; body: TypeMember[] }
	| { type: 'type_alias_decl'; name: string; typeParams?: TypeParam[]; value: Type }
	| { type: 'export_assignment'; expr: string }

function Declare<T extends {ambient?: boolean}>(d: T) { d.ambient = true; return d as unknown as JS.Declaration<any>; }

export type ClassMethod		= JS.Method<Type>
export type ClassMember0	= JS.Method<Type> | JS.Field<Type> | { type: 'index_signature'; paramName: string; paramType: Type; typeAnnotation: Type; modifiers?: string[] };
export type ClassMember		= JS.ClassMember<Type>	| { type: 'index_signature'; paramName: string; paramType: Type; typeAnnotation: Type; modifiers?: string[] };

export type Statement = JS.Statement<Type> | Declaration;
// `scope`: the entry file's own resolved import bindings, stamped on by `TStypeCheckAsync` (like `RefType.declScope`,
// typed `unknown` here to avoid a circular import onto type-utils.ts's `Scope`).
export interface Program { type: 'program'; body: Statement[]; scope?: unknown }

// ===================================================================
//  terminals
// ===================================================================

// `readonly` as a modifier is always followed by another name or `[`; a property literally *named* `readonly` has `?`/`:` directly next instead --
// the one shape a real modifier can never produce, so checking for just that disambiguates without allow-listing every legal follow-token.
const READONLY = terminal('readonly', /readonly(?!\w)/, lex => /^\s*[?:]/.test(lex.remaining) ? IDENT : READONLY);

// `global` is only a keyword directly followed by `{`. Unlike `READONLY`, a bare `Rule(['global', ...])` has no fallback, so SLR's whole-grammar FOLLOW
// set lets that item leak into unrelated states, silently swallowing any identifier actually named `global` elsewhere in the file (a real case hit this).
const GLOBAL = terminal('global', /global(?!\w)/, lex => /^\s*\{/.test(lex.remaining) ? GLOBAL : IDENT);

// `type` is only a keyword right before `type X = ...`, or a `{`/`*` (`import type {...}`/`import type * as ns`) -- checked against `lex.remaining`
// directly, not `lex.next()`, since `next()` re-lexes using the current position's candidate-restricted terminal set (see js-parser.ts's `WS`).
const TYPE = terminal('type', /type(?!\w)/, lex => /^\s*([$_\p{ID_Start}]|[{*])/u.test(lex.remaining) ? TYPE : IDENT);


// --- Generic calls: `foo<T>(...)` ---
// `foo<T>(x)` vs `foo < T > (x)` is genuinely ambiguous to a context-free grammar, and routing it through GLR would fork on every ordinary `<` in the
// file -- resolved in the lexer instead: a dedicated `<` terminal scans upcoming text for balanced type-argument syntax immediately followed by `(`.
const GENERIC_CALL_SCAN_LIMIT = 200;
// `followedBy`: what must follow the matching `>` -- `(` for a call, `{`/`implements` for a class heritage superclass.
function looksLikeBalancedGenericArgs(textAfterLt: string, followedBy: RegExp): boolean {
	let depth = 1;
	// `braceDepth` gates `;` separately: only plausible as an inline object-type member separator, never a bare statement separator, or the scan
	// could cross a real `;` further down the file and stumble onto an unrelated `>(`/`>{`.
	let braceDepth = 0;
	for (let i = 0; i < textAfterLt.length && i < GENERIC_CALL_SCAN_LIMIT; i++) {
		const c = textAfterLt[i];
		if (c === '<') {
			depth++;
		} else if (c === '>') {
			if (--depth === 0)
				return followedBy.test(textAfterLt.slice(i + 1));
		} else if (c === '{') {
			braceDepth++;
		} else if (c === '}') {
			if (--braceDepth < 0)
				return false;
		} else if (c === ';') {
			if (braceDepth === 0)
				return false;
		} else if (!/[A-Za-z0-9_$.,\s[\]():|&?'"-]/.test(c)) {
			return false;
		}
	}
	return false;
}
// `(` covers the ordinary `foo<T>(...)` call; the rest cover a paren-less generic `new` (`new Map<K, V>;`), which has no `(` to look for at all.
// Matched via `\x3c` rather than plain `/</` so its pattern source sorts ahead of the plain `<` terminal's on the tokenizer's length-tie comparison,
// letting this terminal's scan run before the plain `<` auto-accepts. `remaining` is already everything after the matched '<' -- don't `.slice(1)` it again.
const genericCallOpen = terminal('<call-generics>', /\x3c/,
	({ remaining }) => looksLikeBalancedGenericArgs(remaining, /^\s*(\(|[;,)\]}.]|\?\.)/) ? genericCallOpen : undefined
);

// Same idea, own terminal, for a generic superclass reference in `extends` -- reachable only from `class_heritage`'s own extends position, never
// simultaneously with `genericCallOpen`'s call position, so there's no conflict between the two.
const genericExtendsOpen = terminal('<extends-generics>', /\x3c/,
	({ remaining }) => looksLikeBalancedGenericArgs(remaining, /^\s*(\{|implements\b)/) ? genericExtendsOpen : undefined
);

// ===================================================================
//  Type grammar
// ===================================================================

const type = Rules<Type>(
	Rule([Forward(()=>conditional_type)]),
);

const assignment_expression = JS.assignment_expression as Rules<Expr>;
const type_list = List(type, ',');

// Tuple elements specifically, not `type_list` -- generic type args and extends/implements clauses accept neither a bare `...T` spread nor `T?`.
const tuple_element = Rules<Type | { type: 'spread'; argument: Type; label?: string } | { type: 'optional'; element: Type } | { type: 'labeled'; label: string; element: Type; optional?: boolean }>(
	type,
	Rule(['...', type], 											$ => ({ type: 'spread', argument: $[1] } as const)),
	Rule([type, '?'], 												$ => ({ type: 'optional', element: $[0] } as const)),
	Rule([IDENT, ':', type],										$ => ({ type: 'labeled', label: $[0], element: $[2] } as const)),
	// Genuinely ambiguous one token past LALR(1): right after `IDENT '?'`, a plain optional element and a labeled-optional element look identical until
	// the token after the `?` (`:` vs `,`/`]`). `forceFork` makes GLR explore both instead of losing one silently.
	ForceFork(Rule([IDENT, '?', ':', type],							$ => ({ type: 'labeled', label: $[0], element: $[3], optional: true } as const))),
	Rule(['...', IDENT, ':', type],									$ => ({ type: 'spread', argument: $[3], label: $[1] } as const)),
);

// Reuses js-parser.ts's own two `template_literal_part` regex terminals verbatim (anonymous regexes are interned by pattern text, so writing the same
// pattern here resolves to the same shared terminal) -- only the interpolated part differs (`type` here instead of an expression).
const type_template_literal_part = Rules(
	Rule([/(?:[^`$\\]|\\.|\$(?!\{))*(?=\$\{)/, '${', type, '}'],	$ => ({ str: $[0], exp: $[2] } as const)),
	Rule([/(?:[^`$\\]|\\.|\$(?!\{))*(?=`)/], 						$ => ({ str: $[0] } as const)),
);
const type_parameter = Rules<TypeParam>(
	Rule([IDENT],													$ => ({ name: $[0] } as const)),
	Rule([IDENT, 'extends', type],									$ => ({ name: $[0], constraint: $[2] } as const)),
	Rule([IDENT, '=', type],										$ => ({ name: $[0], default: $[2] } as const)),
	Rule([IDENT, 'extends', type, '=', type],						$ => ({ name: $[0], constraint: $[2], default: $[4] } as const)),
	// TS 5.0 `const` type parameter modifier -- infers the narrowest (literal) type for T instead of widening.
	Rule(['const', IDENT],											$ => ({ name: $[1], const: true } as const)),
	Rule(['const', IDENT, 'extends', type],							$ => ({ name: $[1], constraint: $[3], const: true } as const)),
	Rule(['const', IDENT, '=', type],								$ => ({ name: $[1], default: $[3], const: true } as const)),
	Rule(['const', IDENT, 'extends', type, '=', type],				$ => ({ name: $[1], constraint: $[3], default: $[5], const: true } as const)),
);
const type_parameters = Rules(
	Rule(['<', List(type_parameter, ',', true), '>'],				$ => $[1]),
);
const type_parameters_opt = Maybe(type_parameters);

// --- Object type literal / interface body members ---
// Only the last dotted-path segment can carry type arguments (`A.B<T>` means B is generic, not A), so this only covers the name chain itself;
// flattened to one joined string rather than a nested structure, matching this file's preference for simple shapes -- codegen emits it back out verbatim.
const dotted_path = Rules<string>(self => [
	Rule([IDENT]),
	Rule([self, '.', IDENT], $ => $[0] + '.' + $[2]),
]);

const type_member_id = Rules<Key>(
	Rule([IDENT]),
	Rule([STR],								$ => unquoteString($[0])),
	Rule([NUM]),
	Rule(['[', dotted_path, ']'],			$ => ({ computed: JS.dottedNameToExpr($[1]) } as const)),
);

const return_type = Rules(
	type,
	Rule([IDENT, 'is', type],				$ => Predicate($[0], $[2])),
	Rule(['this', 'is', type],				$ => Predicate('this', $[2])),
	// Assertion functions: unlike a plain `x is T` predicate, `asserts` marks a function that
	// throws if the assertion fails; `assertedType` is optional since the bare `asserts x` form asserts only truthiness, no specific type.
	Rule(['asserts', IDENT],				$ => Predicate($[1], undefined, true)),
	Rule(['asserts', IDENT, 'is', type],	$ => Predicate($[1], $[3], true)),
);

const generic_param0 = JS.optional_binding_name;
const generic_param_list0 = Rules<Param[]>(
	// The `this` parameter is dropped, not captured as a real positional `Param`: real TypeScript erases it at every call site, and keeping it in
	// `params` made every consumer of a `this`-typed signature overcount required arguments by one (`mulAffine(this: float2x3, b: T)` needed 2 args).
	Rule(['this', ':', type],												_ => []),
	Rule(['this', ':', type, ',', MaybeList(generic_param0, ',', true)],	$ => $[4]),
	MaybeList(generic_param0, ',', true)
);

const generic_param_list = Rules(
	Rule([generic_param_list0],											$ => ({params: $[0]})),
	Rule([generic_param_list0, '...', IDENT],							$ => ({params: $[0], rest: { key: $[2] }})),
	Rule([generic_param_list0, '...', IDENT, ':', type],				$ => ({params: $[0], rest: { key: $[2], typeAnnotation: $[4] }})),
	// A rest binding can itself be destructured (`(...[value]: [] | [T])`, notably `Iterator.next`'s own real `lib.d.ts` signature).
	Rule([generic_param_list0, '...', JS.array_pattern],				$ => ({params: $[0], rest: { key: $[2] }})),
	Rule([generic_param_list0, '...', JS.array_pattern, ':', type],		$ => ({params: $[0], rest: { key: $[2], typeAnnotation: $[4] }})),
	Rule([generic_param_list0, '...', JS.object_pattern],				$ => ({params: $[0], rest: { key: $[2] }})),
	Rule([generic_param_list0, '...', JS.object_pattern, ':', type],	$ => ({params: $[0], rest: { key: $[2], typeAnnotation: $[4] }})),
);

const generic_params = Rules(
	Rule(['(', generic_param_list, ')'],							$ => $[1]),
	Rule([type_parameters, '(', generic_param_list, ')'],			$ => ({ ...$[2], typeParams: $[0]})),
);

const type_member_params = Rules(
	generic_params,
	Rule([generic_params, ':', return_type],						$ => ({ ...$[0], returnType: $[2]})),
);

const function_type = Rules(
	Rule([generic_params, '=>', return_type],						$ => ({ ...$[0], returnType: $[2]})),
);

const type_member = Rules(
	Rule([type_member_id, ':', type],								$ => TypeProperty($[0], $[2])),
	Rule([type_member_id, '?', ':', type],							$ => TypeProperty($[0], $[3], ['optional'])),
	Rule([READONLY, type_member_id, ':', type],						$ => TypeProperty($[1], $[3], ['readonly'])),
	Rule([READONLY, type_member_id, '?', ':', type],				$ => TypeProperty($[1], $[4], ['optional', 'readonly'])),
	Rule([type_member_id, type_member_params],						$ => TypeMethod($[0], $[1])),
	Rule([type_member_id, '?', type_member_params],					$ => TypeMethod($[0], $[2], ['optional'])),
	// Bodyless accessor signatures (`get length(): number;`/`set length(v: number);`, common in `.d.ts` interfaces, e.g. lib.dom.d.ts).
	// Modeled as a plain (non-readonly) property rather than a distinct kind -- a lone getter is real TS's own readonly, but marking it
	// readonly here would risk a false-positive "can't assign" error on a get+set pair whose setter is a separate member `lookupMember`'s
	// first-match doesn't see; `JS.GET`/`JS.SET`, not bare string literals, for their `startsPropertyName` disambiguation (see the
	// bareword-keyword-vs-identifier pattern in tison_project memory).
	Rule([JS.GET, type_member_id, '(', ')', ':', type],				$ => TypeProperty($[1], $[5])),
	Rule([JS.SET, type_member_id, '(', IDENT, ':', type, ')'],		$ => TypeProperty($[1], $[5])),
	Rule(['[', dotted_path, ':', type, ']', ':', type],				$ => TypeIndex($[1], $[3], $[6])),
	Rule([READONLY, '[', dotted_path, ':', type, ']', ':', type],	$ => TypeIndex($[2], $[4], $[7], ['readonly'])),
	Rule([type_member_params],										$ => TypeCall($[0])),
	Rule(['new', type_member_params],								$ => TypeConstruct($[1])),
);
// `;`- or `,`-separated, with an optional trailing separator (folded into the list via `List`'s `trailing` option).
const type_separator	= OneOf([';', ',']);
const type_member_body = Rules(
	Rule(['{', '}'],												_ => []),
	Rule(['{', List(type_member, type_separator, true), '}'],		$ => $[1]),
);

// --- mapped type

// `{ [K in T]: U }`. Shares its `{ [` opening with `type_member`'s index signature -- they diverge cleanly one token later, on `in` vs `:`.
const mapped_type_end = Rules(
	Rule(['}'],									_ => undefined),
	Rule([type_separator, '}'],					_ => undefined),
);
const mapped_key_tail = Rules(
	Rule([']'],									_ => undefined),
	Rule(['as', type, ']'],						$ => $[1]),
);
// `-?`/`-readonly` explicitly *remove* the modifier, distinct from a bare `?`/`readonly` which *adds* it -- hence tri-state (add/remove/unmentioned), not a plain boolean.
const mapped_value = Rules(
	Rule([':', type, mapped_type_end],			$ => $[1]),
);
const mapped_optional = Rules(
	Rule(['?'],				_ => ['optional']),
	Rule(['+', '?'],		_ => ['optional']),
	Rule(['-', '?'],		_ => ['-optional']),
);
// `+`/`-`-prefixed only -- bare `readonly` gets its own direct rule below (sharing `type_member`'s `READONLY '[' ...` prefix
// shape keeps that shared prefix's state from merging away the `in`-continuation item; see the comment on `mapped_type` itself).
const mapped_readonly = Rules(
	Rule(['+', READONLY],	_ => ['readonly']),
	Rule(['-', READONLY],	_ => ['-readonly']),
);
const mapped_type = Rules<Type>(
	Rule(['{', '[', IDENT, 'in', type, mapped_key_tail, mapped_value],										$ => MappedType($[2], $[4], $[5], $[6])),
	Rule(['{', '[', IDENT, 'in', type, mapped_key_tail, mapped_optional, mapped_value],						$ => MappedType($[2], $[4], $[5], $[7], $[6])),
	// Bare `readonly` uses the raw `READONLY` terminal directly (not routed through `mapped_readonly`) so this rule's
	// `'[' IDENT 'in'` item shares its shift path with `type_member`'s `READONLY '[' dotted_path` rules instead of losing
	// the `in`-continuation to state-merging once an indirecting nonterminal sits between `READONLY` and `[`.
	Rule(['{', READONLY, '[', IDENT, 'in', type, mapped_key_tail, mapped_value],							$ => MappedType($[3], $[5], $[6], $[7], ['readonly'])),
	Rule(['{', READONLY, '[', IDENT, 'in', type, mapped_key_tail, mapped_optional, mapped_value],			$ => MappedType($[3], $[5], $[6], $[8], [...$[7], 'readonly'])),
	Rule(['{', mapped_readonly, '[', IDENT, 'in', type, mapped_key_tail, mapped_value],						$ => MappedType($[3], $[5], $[6], $[7], $[1])),
	Rule(['{', mapped_readonly, '[', IDENT, 'in', type, mapped_key_tail, mapped_optional, mapped_value],	$ => MappedType($[3], $[5], $[6], $[8], [...$[7], ...$[1]])),
);

// --- Type expression precedence chain: primary -> postfix array -> keyof -> intersection -> union -> conditional ---

function parseTypeNumber(text: string): number {
	return parseFloat(text.replace(/_/g, ''));
}
const type_arguments = Rules(
	Rule([],							() => undefined),
	Rule(['<', type_list, '>' ],		$ => $[1]),
);

// Factored out of `primary_type` so `readonly_target` below can reuse the exact same tuple-literal shape without duplicating it.
const tuple_type = Rules<Type>(
	Rule(['[', ']'],									_ => ({ type: 'tuple', elements: [] } as const)),
	Rule(['[', List(tuple_element, ',', true), ']'],	$ => ({ type: 'tuple', elements: $[1] } as const)),
);

const primary_type = Rules<Type>(
	Rule([dotted_path, type_arguments],					$ => RefType($[0], $[1])),
	Rule(['unique', 'symbol'],							_ => RefType('unique symbol')),
	Rule(['this'],										_ => ({ type: 'this' } as const)),
	Rule(['null'],										_ => Literal(null)),
	Rule(['true'],										_ => Literal(true)),
	Rule(['false'],										_ => Literal(false)),
	Rule([STR],											$ => Literal(unquoteString($[0]))),
	Rule([NUM],											$ => Literal(parseTypeNumber($[0]))),
	// Negative numeric literal type (`-1`) -- the only place TypeScript allows a unary-minus type at all, so it's a `primary_type` alternative, not a general unary operator.
	Rule(['-', NUM],									$ => Literal(-parseTypeNumber($[1]))),
	Rule(['`', List(type_template_literal_part), '`'],	$ => Literal($[1])),//({ type: 'template_literal', parts: $[1] } as const)),
	Rule(['typeof', dotted_path, type_arguments],		$ => ({ type: 'typeof', name: $[1], typeArgs: $[2] } as const)),
	Rule(['typeof', 'import', '(', STR, ')'],			$ => ({ type: 'typeof', name: '', source: unquoteString($[3]) } as const)),
	Rule(['typeof', 'import', '(', STR, ')', '.', dotted_path],	$ => ({ type: 'typeof', name: $[6], source: unquoteString($[3]) } as const)),
	Rule(['import', '(', STR, ')'],						$ => ({ type: 'import', source: unquoteString($[2]) } as const)),
	Rule(['import', '(', STR, ')', '.', dotted_path, type_arguments],	$ => ({ type: 'import', source: unquoteString($[2]), name: $[5], typeArgs: $[6] } as const)),
	// `infer` only makes sense inside a conditional type's `extends` operand in real TS, but enforcing that is a checker-level restriction, not a grammar one.
	Rule(['infer', IDENT],								$ => ({ type: 'infer', name: $[1] } as const)),
	// `infer X extends C` (4.7+) constrains the inferred variable directly. Restricted to `union_type`, not the full `type` production, same reason
	// `conditional_type` restricts its own `extends` operand below -- without it, a nested `?`/`:` inside the constraint is ambiguous with the outer conditional's.
	Rule(['infer', IDENT, 'extends', Forward<Type>(() => union_type)],	$ => ({ type: 'infer', name: $[1], constraint: $[3] } as const)),
	// Parens are pure grouping here -- the parse tree already encodes precedence via nesting, so there's nothing to
	// preserve; `tocode.ts`'s `typeToCode` reinserts parens on the way back out based on each node's own precedence.
	Rule(['(', type, ')'],								$ => $[1]),
	tuple_type,
	Rule([type_member_body],							$ => ObjectType($[0])),
	mapped_type,
	// `return_type`, not plain `type`, since a function type is exactly what a type-guard export like `const isFoo: (x: any) => x is Foo` needs.
	Rule([function_type],										$ => ({ type: 'function', ...$[0] } as const)),
	Rule(['new', function_type],						$ => ({ type: 'constructor', ...$[1] } as const)),
	// A constructor type that also accepts abstract classes (`new` alone requires a concrete, instantiable one).
	Rule(['abstract', 'new', function_type],			$ => ({ type: 'constructor', ...$[2], abstract: true } as const)),
);
// Postfix `[]`/`[K]`, left-recursive so `T[][]`/`T[K][J]` stack correctly.
const array_type = Rules<Type>(self => [
	primary_type,
	Rule([self, '[', ']'],					$ => ({ type: 'array', element: $[0] } as const)),
	Rule([self, '[', type, ']'],			$ => ({ type: 'indexed_access', object: $[0], index: $[2] } as const)),
]);

const readonly_target = Rules<Type>(
	Rule([tuple_type],						$ => ({ ...$[0], readonly: true } as const)),
	Rule([array_type, '[', ']'],			$ => ({ type: 'array', element: $[0], readonly: true } as const)),
);
const unary_type = Rules<Type>(
	array_type,
	Rule(['keyof', array_type],					$ => ({ type: 'keyof', argument: $[1] } as const)),
	Rule(['keyof', READONLY, readonly_target],	$ => ({ type: 'keyof', argument: $[2] } as const)),
	Rule([READONLY, readonly_target],			$ => $[1]),
);
const intersection_list = List(unary_type, '&');
const intersection_type = Rules<Type>(
	Rule([intersection_list], 				$ => $[0].length === 1 ? $[0][0] : IntersectionType($[0])),
	Rule(['&', intersection_list],			$ => $[1].length === 1 ? $[1][0] : IntersectionType($[1])),
);
const union_list = List(intersection_type, '|');
const union_type = Rules<Type>(
	Rule([union_list],						$ => $[0].length === 1 ? $[0][0] : UnionType($[0])),
	Rule(['|', union_list],					$ => $[1].length === 1 ? $[1][0] : UnionType($[1])),
);
// The check/extends operands are restricted to `union_type`, not the full conditional grammar, to avoid recursive ambiguity around nested `?`/`:` --
// same reason real TypeScript's own grammar restricts them to NoConditionalType.
const conditional_type = Rules<Type>(
	union_type,
	Rule([union_type, 'extends', union_type, '?', type, ':', type],	$ => ({ type: 'conditional', checkType: $[0], extendsType: $[2], trueType: $[4], falseType: $[6] } as const)),
);

// ===================================================================
//  Declarations: `type`, `interface`, `enum`, namespace, module
// ===================================================================

const type_alias_declaration = Rules<Declaration>(
	Rule([TYPE, IDENT, type_parameters_opt, '=', type, ';'],	$ => ({ type: 'type_alias_decl', name: $[1], typeParams: $[2], value: $[4] } as const)),
);

const interface_declaration = Rules<Declaration>(
	Rule(['interface', IDENT, type_parameters_opt, type_member_body],						$ => ({ type: 'interface_decl', name: $[1], typeParams: $[2], body: $[3] } as const)),
	Rule(['interface', IDENT, type_parameters_opt, 'extends', type_list, type_member_body],	$ => ({ type: 'interface_decl', name: $[1], typeParams: $[2], extendsClause: $[4], body: $[5] } as const)),
);

const enum_member = Rules<EnumMember>(
	Rule([IDENT],									$ => ({ name: $[0] } as const)),
	Rule([IDENT, '=', assignment_expression],		$ => ({ name: $[0], init: $[2] } as const)),
	Rule([STR],										$ => ({ name: unquoteString($[0]) } as const)),
	Rule([STR, '=', assignment_expression],			$ => ({ name: unquoteString($[0]), init: $[2] } as const)),
);
const enum_body = Rules<EnumMember[]>(
	Rule(['{', '}'],								_ => []),
	Rule(['{', List(enum_member, ',', true), '}'],	$ => $[1]),
);
const enum_declaration = Rules<EnumDecl>(
	Rule(['enum', IDENT, enum_body],				$ => ({ type: 'enum_decl', name: $[1], members: $[2] } as const)),
	Rule(['const', 'enum', IDENT, enum_body],		$ => ({ type: 'enum_decl', name: $[2], const: true, members: $[3] })),
);

const bodyless_function = Rules(
	Rule(['function', IDENT, JS.parameter_clause, ';'],				$ => JS.FunctionDecl($[1], $[2])),
	Rule(['async', 'function', IDENT, JS.parameter_clause, ';'],	$ => JS.FunctionDecl($[2], $[3], undefined, {modifiers: ['async'] })),
);

const module_item  		= JS.module_item as unknown as Rules<Declaration>;
const namespace_body	= MaybeList(module_item);
const declared_body		= MaybeList(Forward<Declaration>(()=>declared_body_item));

// A `namespace`/`module` declaration's own shape, parametrized by what its body is allowed to contain. Passing
// `declared_body` (ambient-only, see `maybe_ambient` below) vs `namespace_body` (real implementations allowed,
// the same body plain top-level `namespace X {...}` already uses) is what keeps a `declare namespace` from
// accepting real function/class bodies while a plain `export namespace` still can.
function namespaceOrModule(body: Rules<Declaration[]>) {
	return Rules<MaybeAmbient>(
		Rule(['namespace', IDENT, '{', body, '}'],	$ => NamespaceDecl($[1], $[3])),
		Rule(['module', IDENT, '{', body, '}'],		$ => NamespaceDecl($[1], $[3])),
		Rule(['module', STR, '{', body, '}'],		$ => ModuleDecl(unquoteString($[1]), $[3])),
	);
}
const real_namespace	= namespaceOrModule(namespace_body);
const ambient_namespace	= namespaceOrModule(declared_body);

// Declarations that need no body-context split -- legal (as themselves) either under `declare` or plain `export`.
const ambientable_item = Rules<MaybeAmbient>(
	JS.variable_decl_statement,
	JS.class_declaration,
	enum_declaration,
	bodyless_function,
);

// Reached via `declare` (top-level `declare namespace X {...}`, or any item nested inside one -- nesting stays
// ambient without repeating `declare`, matching real TypeScript). Its own namespace/module alternative recurses
// into `declared_body`, so a real function implementation can never sneak in this way.
const maybe_ambient = Rules<MaybeAmbient>(ambientable_item, ambient_namespace);

// Reached via a plain `export namespace X {...}` / `export module X {...}` (no `declare`). Unlike `maybe_ambient`,
// its namespace/module alternative recurses into `namespace_body`, so ordinary, non-exported helper functions
// with real bodies are legal inside -- e.g. `export namespace X { function helper() { return 1; } } }`.
const exportable_item = Rules<MaybeAmbient>(ambientable_item, real_namespace);

// can have meaningless declare keyword
const fake_ambient = Rules(
	interface_declaration,
	type_alias_declaration,
);

const declared_body_item = Rules<Declaration>(
	maybe_ambient,
	fake_ambient,
	Rule(['import', JS.import_declaration],				$ => $[1] as Declaration),
	Rule(['export', 'import', JS.import_declaration],	$ => $[2] as Declaration),
	Rule(['export', '=', dotted_path, ';'],				$ => ({ type: 'export_assignment', expr: $[2] } as const)),
	// A member exported out of an already-ambient namespace/module stays ambient itself -- reuses
	// `maybe_ambient`/`fake_ambient` directly rather than `JS.export_declaration`, which also carries the
	// *real*-bodied `exportable_item`, only valid for a plain `export` at actual module top level.
	Rule(['export', maybe_ambient],						$ => $[1] as Declaration),
	Rule(['export', fake_ambient],							$ => $[1] as Declaration),
	Rule(['module', IDENT, '{', declared_body, '}'],	$ => NamespaceDecl($[1], $[3])),
	Rule(['module', STR, ';'],							$ => ModuleDecl(unquoteString($[2]), [])),
	Rule([GLOBAL, '{', declared_body, '}'],				$ => ModuleDecl('global', $[2])),
);

module_item.push(
	real_namespace,
	Rule(['declare', maybe_ambient],						$ => Declare($[1])),
	Rule(['declare', fake_ambient],							$ => $[1]),
	// `export = X;` at the top level of a whole file, not just nested in a `declare module`/`namespace` body (`declared_body_item` covers that).
	Rule(['export', '=', dotted_path, ';'],					$ => ({ type: 'export_assignment', expr: $[2] } as const)),
);

JS.binding_name.push(
    Rule([IDENT, ':', type], $ => ({ key: $[0], typeAnnotation: $[2] } as const)),
);
// Folding an optional `type_parameters` prefix directly into `parameter_clause` (rather than every call site spelling out its own sibling pair) means
// every place that spreads `parameter_clause`'s result picks up generics for free, including js-parser.ts's own base method/function rules.
const parameter_clause0 = JS.parameter_clause0 as Rules<Params>;
const parameter_clause	= JS.parameter_clause as Rules<CallSig>;
parameter_clause.push(
	Rule([parameter_clause0, ':', return_type],						$ => ({ ...$[0], returnType: $[2] } as const)),
	Rule([type_parameters, parameter_clause0],						$ => ({ ...$[1], typeParams: $[0] } as const)),
	Rule([type_parameters, parameter_clause0, ':', return_type],	$ => ({ ...$[1], returnType: $[3], typeParams: $[0] } as const)),
);

JS.import_specifier.push(
	Rule([TYPE, IDENT],					$ => ({ imported: $[1], local: $[1], typeOnly: true } as const)),
	Rule([TYPE, IDENT, 'as', IDENT],	$ => ({ imported: $[1], local: $[3], typeOnly: true } as const)),
);
JS.export_specifier.push(
	Rule([TYPE, IDENT],					$ => ({ local: $[1], exported: $[1], typeOnly: true } as const)),
	Rule([TYPE, IDENT, 'as', IDENT],	$ => ({ local: $[1], exported: $[3], typeOnly: true } as const)),
);
JS.import_declaration.push(
	Rule([TYPE, JS.named_imports, 'from', STR, ';'],	$ => ({ type: 'import', specifiers: $[1], source: unquoteString($[3]), typeOnly: true } as const)),
	Rule([TYPE, '*', 'as', IDENT, 'from', STR, ';'],	$ => ({ type: 'import', namespace: $[3], source: unquoteString($[5]), typeOnly: true } as const)),
	Rule([IDENT, '=', 'require', '(', STR, ')', ';'],	$ => ({ type: 'import', default: $[0], source: unquoteString($[4]) } as const)),
	Rule([IDENT, '=', dotted_path, ';'],				$ => ({ type: 'import', default: $[0], source: $[2] } as const)),
);

(JS.export_declaration as unknown as Rules<Statement>).push(
	Rule([TYPE, JS.named_exports, ';'],					$ => ({ type: 'export', specifiers: $[1], typeOnly: true } as const)),
	Rule([TYPE, JS.named_exports, 'from', STR, ';'],	$ => ({ type: 'export', specifiers: $[1], source: unquoteString($[3]), typeOnly: true } as const)),
	Rule([TYPE, '*', 'from', STR, ';'],					$ => ({ type: 'export', source: unquoteString($[3]), typeOnly: true } as const)),
	Rule([TYPE, '*', 'as', IDENT, 'from', STR, ';'],	$ => ({ type: 'export', namespace: $[3], source: unquoteString($[5]), typeOnly: true } as const)),

	Rule([exportable_item],								$ => JS.ExportDecl($[0] as JS.Declaration<any>)),
	Rule(['declare', maybe_ambient],					$ => JS.ExportDecl(Declare($[1]))),
	Rule([fake_ambient],								$ => JS.ExportDecl($[0] as JS.Declaration<any>)),
	Rule(['declare', fake_ambient],						$ => JS.ExportDecl($[1] as JS.Declaration<any>)),
);

(JS.statement as unknown as Rules<Statement>).push(
	interface_declaration,
	type_alias_declaration,
	enum_declaration,
	bodyless_function,
);

// ===================================================================
//  Typed parameters (function/method/constructor)
// ===================================================================
const param_modifier_list = List(OneOf(['public', 'private', 'protected', 'readonly']));

// The typed alternatives go on the shared `JS.optional_binding_name` instead of directly on `parameter`: `parameter`'s base rules already combine
// whatever it resolves to with `ASSIGN_OP`/a default, so `parameter` (and this file's own `param`) picks up typed forms for free.
JS.optional_binding_name.push(
	Rule([IDENT, ':', type],				$ => ({ key: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, '?', ':', type],			$ => ({ key: $[0], modifiers: ['optional'], typeAnnotation: $[3] } as const)),
);
JS.parameter.push(
	// Parameter properties (`constructor(public x: number)`) are accepted anywhere a parameter is, not just in a constructor -- a known simplification.
	Rule([param_modifier_list, JS.optional_binding_name],								$ => ({...$[1], modifiers: mergeMods($[0], $[1].modifiers)})),
	// Typed destructured parameters. `forceFork`: an arrow's `(` is also reachable as a plain expression, so `{a}` as `object_pattern` vs. a plain
	// object literal only resolves once the following `:` is seen, one token past this table's default lookahead.
	ForceFork(Rule([JS.object_pattern, ':', type],										$ => JS.Param($[0], $[2]))),
	ForceFork(Rule([JS.object_pattern, ':', type, '=', assignment_expression],			$ => JS.withDefault(JS.Param($[0], $[2]), $[4]))),
	ForceFork(Rule([JS.array_pattern, ':', type],										$ => JS.Param($[0], $[2]))),
	ForceFork(Rule([JS.array_pattern, ':', type, '=', assignment_expression],			$ => JS.withDefault(JS.Param($[0], $[2]), $[4]))),
	// Default-valued parameter property (`protected offset = 0`). Uses `ASSIGN_OP`, not `'='`, to avoid the lexer tie-break race `ASSIGN_OP` fixes.
	Rule([param_modifier_list, JS.optional_binding_name, '=', assignment_expression],	$ => ({...$[1], modifiers: mergeMods($[0], $[1].modifiers), default: $[3] } as const)),
);

// ===================================================================
//  Return types & generics on function/method declarations & expressions
// ===================================================================
// `parameter_clause`'s optional `type_parameters` prefix means js-parser.ts's own function/method/arrow base rules already parse `<T>` and/or
// `: Type` before the parameter list with no further pushes needed anywhere at all.

JS.property_assignment.push(
	// Return-type-annotated `get` shorthand method; other method shapes fall out of `parameter_clause`'s optional `type_parameters` prefix for free.
	Rule([JS.GET, JS.property_name_computed, '(', ')', ':', return_type, '{', JS.function_body, '}'],	$ => JS.Method('get',$[1], {params: [], returnType: $[5]}, $[7])),
);

// `class_member_name` itself now carries `?`/`!` (see its own comment in js-parser.ts), so plain/generator/async method rules already match `foo?(...) {...}` for free.
JS.class_member_name.push(
	Rule([JS.property_name_computed, '?'],	$ => ({ key: $[0], modifiers: ['optional'] } as const)),
	Rule([JS.property_name_computed, '!'],	$ => ({ key: $[0], modifiers: ['definite'] } as const)),
);

const class_member_body = JS.class_member_body as Rules<ClassMember0>;
class_member_body.push(
	// Return types on get/generator/async-generator methods (`set`'s is always `void`, so it's skipped, mirroring js-parser.ts's own get/set asymmetry).
	Rule([JS.GET, JS.property_name_computed, '(', ')', ':', return_type, '{', JS.function_body, '}'],	$ => JS.Method('get', $[1], {params: [], returnType: $[5]}, $[7])),
	// `set`'s *parameter* type: js-parser.ts's own `set` rule only accepts a bare untyped `IDENT` parameter.
	Rule([JS.SET, JS.property_name_computed, '(', IDENT, ':', type, ')', '{', JS.function_body, '}'],	$ => JS.Method('set', $[1], {params: [{ key: $[3], typeAnnotation: $[5] }]}, $[8])),
	Rule([JS.class_member_name, ':', type, ';'],														$ => JS.Field($[0].key, undefined, $[2], $[0].modifiers)),
	Rule([JS.class_member_name, ':', type, '=', assignment_expression, ';'],							$ => JS.Field($[0].key, $[4], $[2], $[0].modifiers)),
);

const class_member_overloads = Rules<JS.Method<Type>>(
	// Bodyless overload signatures -- this syntax-only grammar doesn't check the names/signatures actually line up with a later implementation.
	Rule([JS.class_member_name, parameter_clause, ';'],							$ => ({ type: 'method', ...$[0], ...$[1] } as const)),
	// Bodyless accessor signatures (`abstract get length(): number;`). `JS.GET`/`JS.SET`, not bare string literals, to keep their `startsPropertyName`
	// disambiguation (see the bareword-keyword-vs-identifier pattern in tison_project memory).
	Rule([JS.GET, JS.property_name_computed, '(', ')', ':', type, ';'],			$ => ({ type: 'get', key: $[1], params: [], returnType: $[5] } as const)),
	Rule([JS.SET, JS.property_name_computed, '(', IDENT, ':', type, ')', ';'],	$ => ({ type: 'set', key: $[1], params: [{ key: $[3], typeAnnotation: $[5] }] } as const)),
);

// Any number of member modifiers in any order (`static readonly`, `public static`, etc), pushed onto `class_member` so every member shape gets it.
const class_member_modifier_list = List(OneOf(['public', 'private', 'protected', 'readonly', 'abstract', 'static', 'override']));

(JS.class_member as unknown as Rules<ClassMember>).push(
	Rule(['[', IDENT, ':', type, ']', ':', type, ';'],				$ => ({ type: 'index_signature', paramName: $[1], paramType: $[3], typeAnnotation: $[6] } as const)),
	Rule([class_member_modifier_list, class_member_body],			$ => {
		const modifiers = $[1].modifiers ? [...$[1].modifiers, ...$[0]] : $[0];
		return {...$[1], ...(modifiers.length ? { modifiers } : {}) };
	}),
	Rule([class_member_modifier_list, class_member_overloads],		$ => ({...$[1], ...($[0].length ? { modifiers: $[0] } : {})})),
	// A sole `static` modifier has no LR(0) state retaining the `class_member_overloads` completion (a missing transition from state-merging, not
	// a resolvable conflict -- `forceFork` can't fix this class of bug), so it needs its own direct rule.
	Rule(['static', class_member_overloads],						$ => ({...$[1], modifiers: [...($[1].modifiers ?? []), 'static']} as const)),
	class_member_overloads,
);

// ===================================================================
//  Typed variable declarations
// ===================================================================

JS.variable_declaration.push(
	Rule([IDENT, '!', ':', type],							$ => ({ name: $[0], typeAnnotation: $[3], definite: true } as const)),
);

// ===================================================================
//  Class generics & `implements`
// ===================================================================

const implements_clause = Rules(
	Rule(['implements', type_list], $ => $[1]),
);
// Parsed then discarded -- `Statement`'s `class_decl`/`class` have no slot for a superclass's own instantiation, only its own `typeParams`.
const class_extends_target = Rules(
	JS.left_hand_side_expression,
	Rule([JS.left_hand_side_expression, genericExtendsOpen, type_list, '>'], $ => $[0]),
);

// The `<T>`/`implements` combinations are pushed onto js-parser.ts's shared `class_heritage`, reaching every class shape (declarations, expressions,
// `abstract`) at once instead of enumerating per shape. js-parser.ts's own alternatives already cover the bare and plain-`extends` shapes.
JS.class_heritage.length = 0;
JS.class_heritage.push(
	Rule([type_parameters_opt, Maybe(implements_clause)],									$ => ({ typeParams: $[0], implements: $[1] } as const)),
	Rule([type_parameters_opt, 'extends', class_extends_target, Maybe(implements_clause)],	$ => ({ typeParams: $[0], superClass: $[2], implements: $[3] } as const)),
);

JS.class_declaration.push(
	Rule(['abstract', 'class', IDENT, JS.class_heritage, JS.class_body],	$ => ({ type: 'class_decl', name: $[2], ...$[3], body: $[4], abstract: true } as const)),
);

// ===================================================================
//  `expr as Type` / `expr satisfies Type` / `expr!` (non-null assertion)
// ===================================================================

const call_type_arguments = Rules<Type[]>(
	Rule([genericCallOpen, type_list, '>'],	$ => $[1]),
);

// `as`/`satisfies` go on `relational_expression` (matching real TS precedence, so `a + b as T` parses as `(a + b) as T`); `!`/generic-call go on
// `call_expression`. One loop iteration per chain: the ordinary one and js-parser.ts's "_nobrace" mirror (used where a leading `{` must never be an object literal).
for (const [relational, member, call] of [
	[JS.relational_expression, JS.member_expression, JS.call_expression],
	[JS.relational_expression_nobrace, JS.member_expression_nobrace, JS.call_expression_nobrace],
]) {
	relational.push(
		Rule([relational, 'as', type],						$ => ({ type: 'as', expression: $[0], typeAnnotation: $[2] } as const)),
		Rule([relational, 'satisfies', type],				$ => ({ type: 'satisfies', expression: $[0], typeAnnotation: $[2] } as const)),
	);
	call.push(
		Rule([member, '!'],									$ => UnaryPost('!', $[0])),
		Rule([call, '!'],									$ => UnaryPost('!', $[0])),
		Rule([member, call_type_arguments, JS.arguments_],	$ => JS.Call($[0], $[2], undefined, $[1])),
		Rule([call, call_type_arguments, JS.arguments_],	$ => JS.Call($[0], $[2], undefined, $[1])),
		// Bare instantiation expression (TS 4.7+): `expr<T,U>` pins a generic function's type params without calling it.
		Rule([member, call_type_arguments],					$ => ({ type: 'instantiation', expression: $[0], typeArgs: $[1] } as const)),
		Rule([call, call_type_arguments],					$ => ({ type: 'instantiation', expression: $[0], typeArgs: $[1] } as const)),
	);
	// `new`'s callee stays the unrestricted `member_expression` in both chains (once `new` is shifted, an object-literal-vs-block ambiguity can't arise).
	member.push(
		Rule(['new', JS.member_expression, call_type_arguments, JS.arguments_],	$ => ({ type: 'new', callee: $[1], arguments: $[3], typeArgs: $[2] } as const)),
		// Paren-less generic `new` (`new Map<K, V>;`) -- mirrors js-parser.ts's own paren-less plain `new Foo;`.
		Rule(['new', JS.member_expression, call_type_arguments],				$ => ({ type: 'new', callee: $[1], arguments: [], typeArgs: $[2] } as const)),
	);
}

// `for(...)`'s init/test/update clauses parse through js-parser.ts's own ECMA-262 In/NoIn split
// (kept separate so a bare `in` isn't ambiguous with `for(x in y)`) -- `relational_expression_noin`
// shares `shift_expression` and everything below it with the ordinary chain above (so `!`/generic-call/
// `new` are already reachable there), but it's its own nonterminal at the relational level, so it needs
// its own `as`/`satisfies` rules or `for (let i = x as T; ...)` can't parse.
JS.relational_expression_noin.push(
	Rule([JS.relational_expression_noin, 'as', type],			$ => ({ type: 'as', expression: $[0], typeAnnotation: $[2] } as const)),
	Rule([JS.relational_expression_noin, 'satisfies', type],	$ => ({ type: 'satisfies', expression: $[0], typeAnnotation: $[2] } as const)),
);

// ===================================================================
//  Wire it up
// ===================================================================


export function make() {
	return makeCachedParser({
		skip:		JS.skip,
		recover:	JS.recover,
		merge:		JS.merge,
		start:		JS.program as Rules<Program>,
		// these are only needed for debugging
		rules: {
			...JS.rules,
			type_list,
			call_type_arguments,
			type_parameter,
			type_parameters,
			type_member,
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
			interface_declaration,
			enum_member,
			enum_body,
			enum_declaration,
			bodyless_function,
			param_modifier_list,
			class_member_modifier_list,
			implements_clause,
		}
	}, path.join(__dirname, '../../../.tables-cache/ts-parser.json.gz'));
}

const parser = make();
export function parse(input: string) {
	return parser.parse(input);
}

