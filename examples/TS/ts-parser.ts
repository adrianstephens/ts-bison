import { makeParser, Rules, Forward, Maybe, List, MaybeList, OneOf, terminal, ForceFork } from '../../src/tison';
import * as JS from './js-parser';
import { IDENT, NUM, STR, unquoteString, Rule } from './js-parser';

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

export interface TypeParam { name: string; constraint?: Type; default?: Type; const?: boolean; }
export type Param			= JS.Param<Type>;
export type Params			= JS.Params<Type>;
// `declScope`: the scope this signature's own param/return types (not its arguments') should resolve names in -- its declaring module's, not
// whichever module calls it. `unknown` (not `Scope`) to avoid a circular import; checker.ts/type-utils.ts cast it back. See `checker.ts`'s `deferReturnType`/`declScope` handling for why this matters.
export type CallSig			= JS.CallSig<Type, TypeParam> & { declScope?: unknown };
export const CallSig		= JS.CallSig<Type, TypeParam>;

function TypeParam(name: string, constraint?: Type, def?: Type, cnst?: boolean): TypeParam { return { name, constraint, default: def, const: cnst }; }

// `declScope`: same reasoning as `CallSig`'s own field above -- a bare ref extracted from another module's signature (a method's
// return type, a free function's inferred return) and handed back as a standalone value carries no scope of its own otherwise;
// `stampScope` (type-utils.ts) tags every ref reachable from a cross-module member/signature with its declaring scope once,
// at the point it's built, so `Scope.resolve()` can use it instead of whichever scope happens to be resolving the value later.
export interface RefType { type: 'ref'; name: string; typeArgs?: Type[]; declScope?: unknown }
export function  RefType(name: string, typeArgs?: Type[] ): RefType { return { type: 'ref', name, typeArgs }; }

export interface UnionType { type: 'union'; types: Type[] }
export function  UnionType(types: Type[]): UnionType { return { type: 'union', types }; }

export interface IntersectionType { type: 'intersection'; types: Type[] }
export function  IntersectionType(types: Type[]): IntersectionType { return { type: 'intersection', types }; }

export interface FunctionType extends CallSig { type: 'function'; }
export function  FunctionType(...args: JS.CallSigParams<Type, TypeParam>): FunctionType { return {type: 'function', ...CallSig(...args) }; }

export interface ConstructorType extends CallSig { type: 'constructor'; abstract?: boolean }

export type TypeMember =
	| { kind: 'property'; name: JS.Key; optional?: boolean; readonly?: boolean; typeAnnotation: Type }
	| { kind: 'method'; name: JS.Key; optional?: boolean } & CallSig
	| { kind: 'index'; paramName: string; paramType: Type; typeAnnotation: Type; readonly?: boolean }
	| { kind: 'call' } & CallSig
	| { kind: 'construct' } & CallSig
export function TypeMember(kind: 'call'|'construct', sig: CallSig): TypeMember { return { kind, ...sig }; }
export function TypeProperty(name: JS.Key, typeAnnotation: Type, optional?: boolean, readonly?: boolean): TypeMember { return { kind: 'property', name, typeAnnotation, optional, readonly}; }
export function TypeMethod(name: JS.Key, sig: CallSig, optional?: boolean): TypeMember { return { kind: 'method', name, ...sig, optional }; }
export function TypeIndex(paramName: string, paramType: Type, typeAnnotation: Type, readonly?: boolean): TypeMember { return { kind: 'index', paramName, paramType, typeAnnotation, readonly }; }
export function TypeCall(sig: CallSig)		{ return TypeMember('call', sig); }
export function TypeConstruct(sig: CallSig)	{ return TypeMember('construct', sig); }

export interface MappedType { keyName: string; constraint: Type; nameType?: Type; valueType: Type; readonly?: boolean; optional?: boolean; }

export interface TemplatePart { str: string; exp?: Type; }
export type TupleElement = Type
 	| { type: 'spread'; argument: Type; label?: string }
	| { type: 'optional'; element: Type }
	| { type: 'labeled'; label: string; element: Type; optional?: boolean };

export interface ObjectType	{ type: 'object'; members: TypeMember[] }
export function  ObjectType(members: TypeMember[]): ObjectType { return {type: 'object', members }; }

export interface ArrayType { type: 'array'; element: Type }
export function  ArrayType(element: Type): ArrayType { return {type: 'array', element}; }

export interface Predicate { type: 'predicate'; paramName: string; assertedType?: Type; asserts?: boolean }
export function  Predicate(paramName: string, assertedType?: Type, asserts?: boolean): Predicate { return {type: 'predicate', paramName, assertedType, asserts }; }

export type Type =
	| RefType
	| { type: 'literal'; value: string | number | boolean | null }
	| { type: 'template_literal'; parts: TemplatePart[] }
	| { type: 'this' }
	| ArrayType
	| { type: 'tuple'; elements: TupleElement[] }
	| UnionType
	| IntersectionType
	| FunctionType
	| ConstructorType
	| ObjectType
	| { type: 'parenthesized'; inner: Type }
	| { type: 'keyof'; argument: Type }
	| { type: 'readonly'; argument: Type }
	| { type: 'typeof'; name: string; source?: string; typeArgs?: Type[] }
	| { type: 'indexed_access'; object: Type; index: Type }
	| { type: 'conditional'; checkType: Type; extendsType: Type; trueType: Type; falseType: Type }
	| { type: 'infer'; name: string; constraint?: Type }
	| { type: 'mapped' } & MappedType
	| { type: 'predicate'; paramName: string; assertedType?: Type; asserts?: boolean }
	| { type: 'import'; source: string; name?: string; typeArgs?: Type[] };


export interface EnumMember { name: string; init?: JS.Expr; }

interface ModuleDecl { type: 'module_decl'; name: string; body: Declaration[]; ambient?: boolean }
function  ModuleDecl(name: string, body: Declaration[]): ModuleDecl { return { type: 'module_decl', name, body}; }
interface NamespaceDecl { type: 'namespace_decl'; name: string; body: Statement[]; ambient?: boolean }
function  NamespaceDecl(name: string, body: Statement[], ambient?: boolean): NamespaceDecl { return { type: 'namespace_decl', name, body, ambient }; }
interface EnumDecl { type: 'enum_decl'; name: string; const?: boolean; members: EnumMember[]; ambient?: boolean }

export type MaybeAmbient = JS.Declaration
	| EnumDecl
	| NamespaceDecl
	| ModuleDecl

export type Declaration = MaybeAmbient
	| { type: 'interface_decl'; name: string; typeParams?: TypeParam[]; extendsClause?: Type[]; body: TypeMember[] }
	| { type: 'type_alias_decl'; name: string; typeParams?: TypeParam[]; value: Type }
	| { type: 'export_assignment'; expr: string }

function Declare<T extends {ambient?: boolean}>(d: T) { d.ambient = true; return d as unknown as JS.Declaration;; }

//type ClassMethodSignature = { type: 'method_signature'; key: JS.Key; modifiers?: string[]; kind?: 'get' | 'set' } & CallSig;

export type ClassMember = JS.ClassMember
//	| ClassMethodSignature
	| { type: 'index_signature'; paramName: string; paramType: Type; typeAnnotation: Type; modifiers?: string[] };

export type Statement = JS.Statement | Declaration;
export interface Program { type: 'program'; body: Statement[]; }

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
	Rule([Forward(()=>conditional_type)] as const),
);

const type_list = List(type, ',');

// Tuple elements specifically, not `type_list` -- generic type args and extends/implements clauses accept neither a bare `...T` spread nor `T?`.
const tuple_element = Rules<Type | { type: 'spread'; argument: Type; label?: string } | { type: 'optional'; element: Type } | { type: 'labeled'; label: string; element: Type; optional?: boolean }>(
	type,
	Rule(['...', type] as const, 											$ => ({ type: 'spread', argument: $[1] } as const)),
	Rule([type, '?'] as const, 												$ => ({ type: 'optional', element: $[0] } as const)),
	Rule([IDENT, ':', type] as const,										$ => ({ type: 'labeled', label: $[0], element: $[2] } as const)),
	// Genuinely ambiguous one token past LALR(1): right after `IDENT '?'`, a plain optional element and a labeled-optional element look identical until
	// the token after the `?` (`:` vs `,`/`]`). `forceFork` makes GLR explore both instead of losing one silently.
	ForceFork(Rule([IDENT, '?', ':', type] as const,						$ => ({ type: 'labeled', label: $[0], element: $[3], optional: true } as const))),
	Rule(['...', IDENT, ':', type] as const,								$ => ({ type: 'spread', argument: $[3], label: $[1] } as const)),
);

// Reuses js-parser.ts's own two `template_literal_part` regex terminals verbatim (anonymous regexes are interned by pattern text, so writing the same
// pattern here resolves to the same shared terminal) -- only the interpolated part differs (`type` here instead of an expression).
const type_template_literal_part = Rules(
	Rule([/(?:[^`$\\]|\\.|\$(?!\{))*(?=\$\{)/, '${', type, '}'] as const,	$ => ({ str: $[0], exp: $[2] } as const)),
	Rule([/(?:[^`$\\]|\\.|\$(?!\{))*(?=`)/] as const, 						$ => ({ str: $[0] } as const)),
);
const type_parameter = Rules(
	Rule([IDENT] as const,													$ => ({ name: $[0] } as const)),
	Rule([IDENT, 'extends', type] as const,									$ => ({ name: $[0], constraint: $[2] } as const)),
	Rule([IDENT, '=', type] as const,										$ => ({ name: $[0], default: $[2] } as const)),
	Rule([IDENT, 'extends', type, '=', type] as const,						$ => ({ name: $[0], constraint: $[2], default: $[4] } as const)),
	// TS 5.0 `const` type parameter modifier -- infers the narrowest (literal) type for T instead of widening.
	Rule(['const', IDENT] as const,											$ => ({ name: $[1], const: true } as const)),
	Rule(['const', IDENT, 'extends', type] as const,						$ => ({ name: $[1], constraint: $[3], const: true } as const)),
	Rule(['const', IDENT, '=', type] as const,								$ => ({ name: $[1], default: $[3], const: true } as const)),
	Rule(['const', IDENT, 'extends', type, '=', type] as const,				$ => ({ name: $[1], constraint: $[3], default: $[5], const: true } as const)),
);
const type_parameters = Rules(
	Rule(['<', List(type_parameter, ',', true), '>'] as const,				$ => $[1]),
);
const type_parameters_opt = Maybe(type_parameters);

// --- Object type literal / interface body members ---
// Only the last dotted-path segment can carry type arguments (`A.B<T>` means B is generic, not A), so this only covers the name chain itself;
// flattened to one joined string rather than a nested structure, matching this file's preference for simple shapes -- codegen emits it back out verbatim.
const dotted_path = Rules<string>(self => [
	Rule([IDENT]),
	Rule([self, '.', IDENT] as const, $ => $[0] + '.' + $[2]),
]);

// Rebuilds the flattened `"Symbol.iterator"`-style string back into a real `Expr` for a computed member name -- a general expression isn't an option,
// since real TypeScript restricts a computed interface/type-literal key to a `unique symbol` reference anyway.
function typeNameToExpr(name: string): JS.Expr {
	const parts = name.split('.');
	return parts.slice(1).reduce<JS.Expr>((object, property) => ({ type: 'member', object, property }), { type: 'identifier', name: parts[0] });
}

const type_member_id = Rules<JS.Key>(
	Rule([IDENT]),
	Rule([STR] as const,					$ => unquoteString($[0])),
	Rule([NUM] as const),
	Rule(['[', dotted_path, ']'] as const,	$ => ({ computed: typeNameToExpr($[1]) } as const)),
);

const return_type = Rules(
	type,
	Rule([IDENT, 'is', type] as const,				$ => Predicate($[0], $[2])),
	Rule(['this', 'is', type] as const,				$ => Predicate('this', $[2])),
	// Assertion functions: unlike a plain `x is T` predicate, `asserts` marks a function that
	// throws if the assertion fails; `assertedType` is optional since the bare `asserts x` form asserts only truthiness, no specific type.
	Rule(['asserts', IDENT] as const,				$ => Predicate($[1], undefined, true)),
	Rule(['asserts', IDENT, 'is', type] as const,	$ => Predicate($[1], $[3], true)),
);

const generic_param0 = JS.optional_binding_name;
const generic_param_list0 = Rules<Param[]>(
	// The `this` parameter is dropped, not captured as a real positional `Param`: real TypeScript erases it at every call site, and keeping it in
	// `params` made every consumer of a `this`-typed signature overcount required arguments by one (`mulAffine(this: float2x3, b: T)` needed 2 args).
	Rule(['this', ':', type] as const,												_ => []),
	Rule(['this', ':', type, ',', MaybeList(generic_param0, ',', true)] as const,	$ => $[4]),
	MaybeList(generic_param0, ',', true)
);

const generic_param_list = Rules(
	Rule([generic_param_list0],											$ => ({params: $[0]})),
	Rule([generic_param_list0, '...', IDENT] as const,					$ => ({params: $[0], rest: { key: $[2] }})),
	Rule([generic_param_list0, '...', IDENT, ':', type] as const,		$ => ({params: $[0], rest: { key: $[2], typeAnnotation: $[4] }})),
	// A rest binding can itself be destructured (`(...[value]: [] | [T])`, notably `Iterator.next`'s own real `lib.d.ts` signature).
	Rule([generic_param_list0, '...', JS.array_pattern] as const,					$ => ({params: $[0], rest: { key: $[2] }})),
	Rule([generic_param_list0, '...', JS.array_pattern, ':', type] as const,		$ => ({params: $[0], rest: { key: $[2], typeAnnotation: $[4] }})),
	Rule([generic_param_list0, '...', JS.object_pattern] as const,				$ => ({params: $[0], rest: { key: $[2] }})),
	Rule([generic_param_list0, '...', JS.object_pattern, ':', type] as const,	$ => ({params: $[0], rest: { key: $[2], typeAnnotation: $[4] }})),
);

const generic_params = Rules(
	Rule(['(', generic_param_list, ')'] as const,						$ => $[1]),
	Rule([type_parameters, '(', generic_param_list, ')'] as const,		$ => ({ ...$[2], typeParams: $[0]})),
);

const type_member_params = Rules(
	generic_params,
	Rule([generic_params, ':', return_type] as const,					$ => ({ ...$[0], returnType: $[2]})),
);

const function_type = Rules(
	Rule([generic_params, '=>', return_type] as const,					$ => ({ ...$[0], returnType: $[2]})),
);

const type_member = Rules(
	Rule([type_member_id, ':', type] as const,								$ => TypeProperty($[0], $[2])),
	Rule([type_member_id, '?', ':', type] as const,							$ => TypeProperty($[0], $[3], true)),
	Rule([READONLY, type_member_id, ':', type] as const,					$ => TypeProperty($[1], $[3], undefined, true)),
	Rule([READONLY, type_member_id, '?', ':', type] as const,				$ => TypeProperty($[1], $[4], true, true)),
	Rule([type_member_id, type_member_params] as const,						$ => TypeMethod($[0], $[1])),
	Rule([type_member_id, '?', type_member_params] as const,				$ => TypeMethod($[0], $[2], true)),
	// Bodyless accessor signatures (`get length(): number;`/`set length(v: number);`, common in `.d.ts` interfaces, e.g. lib.dom.d.ts).
	// Modeled as a plain (non-readonly) property rather than a distinct kind -- a lone getter is real TS's own readonly, but marking it
	// readonly here would risk a false-positive "can't assign" error on a get+set pair whose setter is a separate member `lookupMember`'s
	// first-match doesn't see; `JS.GET`/`JS.SET`, not bare string literals, for their `startsPropertyName` disambiguation (see the
	// bareword-keyword-vs-identifier pattern in tison_project memory).
	Rule([JS.GET, type_member_id, '(', ')', ':', type] as const,			$ => TypeProperty($[1], $[5])),
	Rule([JS.SET, type_member_id, '(', IDENT, ':', type, ')'] as const,		$ => TypeProperty($[1], $[5])),
	Rule(['[', dotted_path, ':', type, ']', ':', type] as const,			$ => TypeIndex($[1], $[3], $[6])),
	Rule([READONLY, '[', dotted_path, ':', type, ']', ':', type] as const,	$ => TypeIndex($[2], $[4], $[7], true)),
	Rule([type_member_params] as const,										$ => TypeCall($[0])),
	Rule(['new', type_member_params] as const,								$ => TypeConstruct($[1])),
);
// `;`- or `,`-separated, with an optional trailing separator (folded into the list via `List`'s `trailing` option).
const type_separator	= OneOf([';', ',']);
const type_member_body = Rules(
	Rule(['{', '}'] as const,												_ => []),
	Rule(['{', List(type_member, type_separator, true), '}'] as const,		$ => $[1]),
);

// --- mapped type

// `{ [K in T]: U }`. Shares its `{ [` opening with `type_member`'s index signature -- they diverge cleanly one token later, on `in` vs `:`.
const mapped_type_end = Rules(
	Rule(['}'] as const,									_ => undefined),
	Rule([type_separator, '}'] as const,					_ => undefined),
);
const mapped_key_tail = Rules<{ nameType?: Type }>(
	Rule([']'] as const,									_ => ({})),
	Rule(['as', type, ']'] as const,						$ => ({ nameType: $[1] } as const)),
);
// `-?`/`-readonly` explicitly *remove* the modifier, distinct from a bare `?`/`readonly` which *adds* it -- hence tri-state (add/remove/unmentioned), not a plain boolean.
const mapped_value = Rules<{ optional?: boolean; valueType: Type }>(
	Rule([':', type, mapped_type_end] as const,				$ => ({ valueType: $[1] } as const)),
	Rule(['?', ':', type, mapped_type_end] as const,		$ => ({ optional: true, valueType: $[2] } as const)),
	Rule(['+', '?', ':', type, mapped_type_end] as const,	$ => ({ optional: true, valueType: $[3] } as const)),
	Rule(['-', '?', ':', type, mapped_type_end] as const,	$ => ({ optional: false, valueType: $[3] } as const)),
);
// `+`/`-`-prefixed only -- bare `readonly` gets its own direct rule below (sharing `type_member`'s `READONLY '[' ...` prefix
// shape keeps that shared prefix's state from merging away the `in`-continuation item; see the comment on `mapped_type` itself).
const mapped_readonly = Rules(
	Rule(['+', READONLY] as const,							_ => true),
	Rule(['-', READONLY] as const,							_ => false),
);
const mapped_type = Rules<Type>(
	Rule(['{', '[', IDENT, 'in', type, mapped_key_tail, mapped_value] as const,						$ => ({ type: 'mapped', keyName: $[2], constraint: $[4], ...$[5], ...$[6] } as const)),
	// Bare `readonly` uses the raw `READONLY` terminal directly (not routed through `mapped_readonly`) so this rule's
	// `'[' IDENT 'in'` item shares its shift path with `type_member`'s `READONLY '[' dotted_path` rules instead of losing
	// the `in`-continuation to state-merging once an indirecting nonterminal sits between `READONLY` and `[`.
	Rule(['{', READONLY, '[', IDENT, 'in', type, mapped_key_tail, mapped_value] as const,			$ => ({ type: 'mapped', keyName: $[3], constraint: $[5], ...$[6], readonly: true, ...$[7] } as const)),
	Rule(['{', mapped_readonly, '[', IDENT, 'in', type, mapped_key_tail, mapped_value] as const,	$ => ({ type: 'mapped', keyName: $[3], constraint: $[5], ...$[6], readonly: $[1], ...$[7] } as const)),
);

// --- Type expression precedence chain: primary -> postfix array -> keyof -> intersection -> union -> conditional ---

function parseTypeNumber(text: string): number {
	return parseFloat(text.replace(/_/g, ''));
}
const type_arguments = Rules(
	Rule([] as const,							() => undefined),
	Rule(['<', type_list, '>' ] as const,		$ => $[1]),
);

const primary_type = Rules<Type>(
	Rule([dotted_path, type_arguments] as const,				$ => RefType($[0], $[1])),
	Rule(['unique', 'symbol'] as const,							_ => RefType('unique symbol')),
	Rule(['this'] as const,										_ => ({ type: 'this' } as const)),
	Rule(['null'] as const,										_ => ({ type: 'literal', value: null } as const)),
	Rule(['true'] as const,										_ => ({ type: 'literal', value: true } as const)),
	Rule(['false'] as const,									_ => ({ type: 'literal', value: false } as const)),
	Rule([STR] as const,										$ => ({ type: 'literal', value: unquoteString($[0]) } as const)),
	Rule([NUM] as const,										$ => ({ type: 'literal', value: parseTypeNumber($[0]) } as const)),
	// Negative numeric literal type (`-1`) -- the only place TypeScript allows a unary-minus type at all, so it's a `primary_type` alternative, not a general unary operator.
	Rule(['-', NUM] as const,									$ => ({ type: 'literal', value: -parseTypeNumber($[1]) } as const)),
	Rule(['`', List(type_template_literal_part), '`'] as const,	$ => ({ type: 'template_literal', parts: $[1] } as const)),
	Rule(['typeof', dotted_path, type_arguments] as const,		$ => ({ type: 'typeof', name: $[1], typeArgs: $[2] } as const)),
	Rule(['typeof', 'import', '(', STR, ')'] as const,			$ => ({ type: 'typeof', name: '', source: unquoteString($[3]) } as const)),
	Rule(['typeof', 'import', '(', STR, ')', '.', dotted_path] as const,	$ => ({ type: 'typeof', name: $[6], source: unquoteString($[3]) } as const)),
	Rule(['import', '(', STR, ')'] as const,					$ => ({ type: 'import', source: unquoteString($[2]) } as const)),
	Rule(['import', '(', STR, ')', '.', dotted_path, type_arguments] as const,	$ => ({ type: 'import', source: unquoteString($[2]), name: $[5], typeArgs: $[6] } as const)),
	// `infer` only makes sense inside a conditional type's `extends` operand in real TS, but enforcing that is a checker-level restriction, not a grammar one.
	Rule(['infer', IDENT] as const,								$ => ({ type: 'infer', name: $[1] } as const)),
	// `infer X extends C` (4.7+) constrains the inferred variable directly. Restricted to `union_type`, not the full `type` production, same reason
	// `conditional_type` restricts its own `extends` operand below -- without it, a nested `?`/`:` inside the constraint is ambiguous with the outer conditional's.
	Rule(['infer', IDENT, 'extends', Forward<Type>(() => union_type)] as const,	$ => ({ type: 'infer', name: $[1], constraint: $[3] } as const)),
	Rule(['(', type, ')'] as const,								$ => ({ type: 'parenthesized', inner: $[1] } as const)),
	Rule(['[', ']'] as const,									_ => ({ type: 'tuple', elements: [] } as const)),
	Rule(['[', List(tuple_element, ',', true), ']'] as const,	$ => ({ type: 'tuple', elements: $[1] } as const)),
	Rule([type_member_body] as const,							$ => ObjectType($[0])),
	mapped_type,
	// `return_type`, not plain `type`, since a function type is exactly what a type-guard export like `const isFoo: (x: any) => x is Foo` needs.
	Rule([function_type],										$ => ({ type: 'function', ...$[0] } as const)),
	Rule(['new', function_type] as const,						$ => ({ type: 'constructor', ...$[1] } as const)),
	// A constructor type that also accepts abstract classes (`new` alone requires a concrete, instantiable one).
	Rule(['abstract', 'new', function_type] as const,			$ => ({ type: 'constructor', ...$[2], abstract: true } as const)),
);
// Postfix `[]`/`[K]`, left-recursive so `T[][]`/`T[K][J]` stack correctly.
const array_type = Rules<Type>(self => [
	primary_type,
	Rule([self, '[', ']'] as const,				$ => ({ type: 'array', element: $[0] } as const)),
	Rule([self, '[', type, ']'] as const,		$ => ({ type: 'indexed_access', object: $[0], index: $[2] } as const)),
]);
const unary_type = Rules<Type>(
	array_type,
	Rule(['keyof', array_type] as const,		$ => ({ type: 'keyof', argument: $[1] } as const)),
	// `keyof readonly T[]` -- `keyof`'s operand is `array_type` alone, which doesn't include the `readonly`-prefixed
	// alternative (a peer, not a sub-rule, of `array_type` -- see the comment below), so this combination needs its own path.
	Rule(['keyof', READONLY, array_type] as const,	$ => ({ type: 'keyof', argument: { type: 'readonly', argument: $[2] } } as const)),
	// `readonly` only ever prefixes an array/tuple type -- reusing `array_type` (not `fwd_type`) rejects it in front of anything else, matching real TS.
	Rule([READONLY, array_type] as const,		$ => ({ type: 'readonly', argument: $[1] } as const)),
);
const intersection_list = List(unary_type, '&');
const intersection_type = Rules<Type>(
	Rule([intersection_list] as const, 			$ => $[0].length === 1 ? $[0][0] : IntersectionType($[0])),
	Rule(['&', intersection_list] as const,		$ => $[1].length === 1 ? $[1][0] : IntersectionType($[1])),
);
const union_list = List(intersection_type, '|');
const union_type = Rules<Type>(
	Rule([union_list] as const,					$ => $[0].length === 1 ? $[0][0] : UnionType($[0])),
	Rule(['|', union_list] as const,			$ => $[1].length === 1 ? $[1][0] : UnionType($[1])),
);
// The check/extends operands are restricted to `union_type`, not the full conditional grammar, to avoid recursive ambiguity around nested `?`/`:` --
// same reason real TypeScript's own grammar restricts them to NoConditionalType.
const conditional_type = Rules<Type>(
	union_type,
	Rule([union_type, 'extends', union_type, '?', type, ':', type] as const,	$ => ({ type: 'conditional', checkType: $[0], extendsType: $[2], trueType: $[4], falseType: $[6] } as const)),
);

// ===================================================================
//  Declarations: `type`, `interface`, `enum`, namespace, module
// ===================================================================

const type_alias_declaration = Rules<Declaration>(
	Rule([TYPE, IDENT, type_parameters_opt, '=', type, ';'] as const,	$ => ({ type: 'type_alias_decl', name: $[1], typeParams: $[2], value: $[4] } as const)),
);

const interface_declaration = Rules<Declaration>(
	Rule(['interface', IDENT, type_parameters_opt, type_member_body] as const,							$ => ({ type: 'interface_decl', name: $[1], typeParams: $[2], body: $[3] } as const)),
	Rule(['interface', IDENT, type_parameters_opt, 'extends', type_list, type_member_body] as const,	$ => ({ type: 'interface_decl', name: $[1], typeParams: $[2], extendsClause: $[4], body: $[5] } as const)),
);

const enum_member = Rules<EnumMember>(
	Rule([IDENT] as const,									$ => ({ name: $[0] } as const)),
	Rule([IDENT, '=', JS.assignment_expression] as const,	$ => ({ name: $[0], init: $[2] } as const)),
	Rule([STR] as const,									$ => ({ name: unquoteString($[0]) } as const)),
	Rule([STR, '=', JS.assignment_expression] as const,		$ => ({ name: unquoteString($[0]), init: $[2] } as const)),
);
const enum_body = Rules<EnumMember[]>(
	Rule(['{', '}'] as const,								_ => []),
	Rule(['{', List(enum_member, ',', true), '}'] as const,	$ => $[1]),
);
const enum_declaration = Rules<EnumDecl>(
	Rule(['enum', IDENT, enum_body] as const,			$ => ({ type: 'enum_decl', name: $[1], members: $[2] } as const)),
	Rule(['const', 'enum', IDENT, enum_body] as const,	$ => ({ type: 'enum_decl', name: $[2], const: true, members: $[3] })),
);

const bodyless_function = Rules(
	Rule(['function', IDENT, JS.parameter_clause, ';'] as const,			$ => JS.FunctionDecl($[1], $[2])),
	Rule(['async', 'function', IDENT, JS.parameter_clause, ';'] as const,	$ => JS.FunctionDecl($[2], $[3], undefined, {modifiers: ['async'] })),
);

const module_item  = JS.module_item as unknown as Rules<Declaration>;
const namespace_body	= MaybeList(module_item);
const declared_body		= MaybeList(Forward<Declaration>(()=>declared_body_item));

// can have real declare keyword
const maybe_ambient = Rules<MaybeAmbient>(
	JS.variable_decl_statement,
	JS.class_declaration,
	enum_declaration,
	bodyless_function,
	Rule(['namespace', IDENT, '{', declared_body, '}'] as const,$ => NamespaceDecl($[1], $[3])),
	Rule(['module', IDENT, '{', declared_body, '}'] as const,	$ => NamespaceDecl($[1], $[3])),
	Rule(['module', STR, '{', declared_body, '}'] as const,		$ => ModuleDecl(unquoteString($[1]), $[3])),
);

// can have meaningless declare keyword
const fake_ambient = Rules(
	interface_declaration,
	type_alias_declaration,
);

const declared_body_item = Rules<Declaration>(
	maybe_ambient,
	fake_ambient,
	Rule(['import', JS.import_declaration] as const,			$ => $[1] as Declaration),
	Rule(['export', 'import', JS.import_declaration] as const,	$ => $[2] as Declaration),
	Rule(['export', '=', dotted_path, ';'] as const,			$ => ({ type: 'export_assignment', expr: $[2] } as const)),
	Rule(['export', JS.export_declaration] as const,			$ => $[1] as Declaration),
	Rule(['module', IDENT, '{', declared_body, '}'] as const,	$ => NamespaceDecl($[1], $[3])),
	Rule(['module', STR, ';'] as const,							$ => ModuleDecl(unquoteString($[2]), [])),
	Rule([GLOBAL, '{', declared_body, '}'] as const,			$ => ModuleDecl('global', $[2])),
);

module_item.push(
	Rule(['namespace', IDENT, '{', namespace_body, '}'] as const,	$ => NamespaceDecl($[1], $[3])),
	Rule(['module', IDENT, '{', namespace_body, '}'] as const,		$ => NamespaceDecl($[1], $[3])),
	Rule(['declare', maybe_ambient] as const,					$ => Declare($[1])),
	Rule(['declare', fake_ambient] as const,					$ => $[1]),
	// `export = X;` at the top level of a whole file, not just nested in a `declare module`/`namespace` body (`declared_body_item` covers that).
	Rule(['export', '=', dotted_path, ';'] as const,			$ => ({ type: 'export_assignment', expr: $[2] } as const)),
);

JS.binding_name.push(
    Rule([IDENT, ':', type] as const, $ => ({ key: $[0], typeAnnotation: $[2] } as const)),
);
// Folding an optional `type_parameters` prefix directly into `parameter_clause` (rather than every call site spelling out its own sibling pair) means
// every place that spreads `parameter_clause`'s result picks up generics for free, including js-parser.ts's own base method/function rules.
const parameter_clause0 = JS.parameter_clause0 as Rules<Params>;
const parameter_clause	= JS.parameter_clause as Rules<CallSig>;
parameter_clause.push(
	Rule([parameter_clause0, ':', return_type] as const,					$ => ({ ...$[0], returnType: $[2] } as const)),
	Rule([type_parameters, parameter_clause0] as const,						$ => ({ ...$[1], typeParams: $[0] } as const)),
	Rule([type_parameters, parameter_clause0, ':', return_type] as const,	$ => ({ ...$[1], returnType: $[3], typeParams: $[0] } as const)),
);

JS.import_specifier.push(
	Rule([TYPE, IDENT] as const,				$ => ({ imported: $[1], local: $[1], typeOnly: true } as const)),
	Rule([TYPE, IDENT, 'as', IDENT] as const,	$ => ({ imported: $[1], local: $[3], typeOnly: true } as const)),
);
JS.export_specifier.push(
	Rule([TYPE, IDENT] as const,				$ => ({ local: $[1], exported: $[1], typeOnly: true } as const)),
	Rule([TYPE, IDENT, 'as', IDENT] as const,	$ => ({ local: $[1], exported: $[3], typeOnly: true } as const)),
);
JS.import_declaration.push(
	Rule([TYPE, JS.named_imports, 'from', STR, ';'] as const,	$ => ({ type: 'import', specifiers: $[1], source: unquoteString($[3]), typeOnly: true } as const)),
	Rule([TYPE, '*', 'as', IDENT, 'from', STR, ';'] as const,	$ => ({ type: 'import', namespace: $[3], source: unquoteString($[5]), typeOnly: true } as const)),
	Rule([IDENT, '=', 'require', '(', STR, ')', ';'] as const,	$ => ({ type: 'import', default: $[0], source: unquoteString($[4]) } as const)),
	Rule([IDENT, '=', dotted_path, ';'] as const,				$ => ({ type: 'import', default: $[0], source: $[2] } as const)),
);

(JS.export_declaration as unknown as Rules<Statement>).push(
	Rule([TYPE, JS.named_exports, ';'] as const,				$ => ({ type: 'export', specifiers: $[1], typeOnly: true } as const)),
	Rule([TYPE, JS.named_exports, 'from', STR, ';'] as const,	$ => ({ type: 'export', specifiers: $[1], source: unquoteString($[3]), typeOnly: true } as const)),
	Rule([TYPE, '*', 'from', STR, ';'] as const,				$ => ({ type: 'export', source: unquoteString($[3]), typeOnly: true } as const)),
	Rule([TYPE, '*', 'as', IDENT, 'from', STR, ';'] as const,	$ => ({ type: 'export', namespace: $[3], source: unquoteString($[5]), typeOnly: true } as const)),

	Rule([maybe_ambient] as const,							$ => JS.ExportDecl($[0] as JS.Declaration)),
	Rule(['declare', maybe_ambient] as const,				$ => JS.ExportDecl(Declare($[1]))),
	Rule([fake_ambient] as const,							$ => JS.ExportDecl($[0] as JS.Declaration)),
	Rule(['declare', fake_ambient] as const,				$ => JS.ExportDecl($[1] as JS.Declaration)),
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

function mergeMods(a: string[], b?: string[]): string[] {
	return [...a, ...(b ?? [])];
}
// The typed alternatives go on the shared `JS.optional_binding_name` instead of directly on `parameter`: `parameter`'s base rules already combine
// whatever it resolves to with `ASSIGN_OP`/a default, so `parameter` (and this file's own `param`) picks up typed forms for free.
JS.optional_binding_name.push(
	Rule([IDENT, ':', type] as const,				$ => ({ key: $[0], typeAnnotation: $[2] } as const)),
	Rule([IDENT, '?', ':', type] as const,			$ => ({ key: $[0], modifiers: ['optional'], typeAnnotation: $[3] } as const)),
);
JS.parameter.push(
	// Parameter properties (`constructor(public x: number)`) are accepted anywhere a parameter is, not just in a constructor -- a known simplification.
	Rule([param_modifier_list, JS.optional_binding_name] as const,									$ => ({...$[1], modifiers: mergeMods($[0], $[1].modifiers)})),
	// Typed destructured parameters. `forceFork`: an arrow's `(` is also reachable as a plain expression, so `{a}` as `object_pattern` vs. a plain
	// object literal only resolves once the following `:` is seen, one token past this table's default lookahead.
	ForceFork(Rule([JS.object_pattern, ':', type] as const,											$ => ({ key: $[0], typeAnnotation: $[2] } as const))),
	ForceFork(Rule([JS.object_pattern, ':', type, '=', JS.assignment_expression] as const,			$ => ({ key: $[0], typeAnnotation: $[2], default: $[4] } as const))),
	ForceFork(Rule([JS.array_pattern, ':', type] as const,											$ => ({ key: $[0], typeAnnotation: $[2] } as const))),
	ForceFork(Rule([JS.array_pattern, ':', type, '=', JS.assignment_expression] as const,			$ => ({ key: $[0], typeAnnotation: $[2], default: $[4] } as const))),
	// Default-valued parameter property (`protected offset = 0`). Uses `ASSIGN_OP`, not `'='`, to avoid the lexer tie-break race `ASSIGN_OP` fixes.
	Rule([param_modifier_list, JS.optional_binding_name, '=', JS.assignment_expression] as const,	$ => ({...$[1], modifiers: mergeMods($[0], $[1].modifiers), default: $[3] } as const)),
);

// ===================================================================
//  Return types & generics on function/method declarations & expressions
// ===================================================================
// `parameter_clause`'s optional `type_parameters` prefix means js-parser.ts's own function/method/arrow base rules already parse `<T>` and/or
// `: Type` before the parameter list with no further pushes needed anywhere at all.

JS.property_assignment.push(
	// Return-type-annotated `get` shorthand method; other method shapes fall out of `parameter_clause`'s optional `type_parameters` prefix for free.
	Rule([JS.GET, JS.property_name_computed, '(', ')', ':', return_type, '{', JS.function_body, '}'] as const,	$ => JS.ObjectProperty($[1], { type: 'function', params: [], body: $[7], returnType: $[5] }, 'get')),
);

// `class_member_name` itself now carries `?`/`!` (see its own comment in js-parser.ts), so plain/generator/async method rules already match `foo?(...) {...}` for free.
JS.class_member_name.push(
	Rule([JS.property_name_computed, '?'] as const,	$ => ({ key: $[0], modifiers: ['optional'] } as const)),
	Rule([JS.property_name_computed, '!'] as const,	$ => ({ key: $[0], modifiers: ['definite'] } as const)),
);

JS.class_member_body.push(
	// Return types on get/generator/async-generator methods (`set`'s is always `void`, so it's skipped, mirroring js-parser.ts's own get/set asymmetry).
	Rule([JS.GET, JS.property_name_computed, '(', ')', ':', return_type, '{', JS.function_body, '}'] as const,	$ => ({ type: 'method', kind: 'get', key: $[1], params: [], body: $[7], returnType: $[5] } as const)),
	// `set`'s *parameter* type: js-parser.ts's own `set` rule only accepts a bare untyped `IDENT` parameter.
	Rule([JS.SET, JS.property_name_computed, '(', IDENT, ':', type, ')', '{', JS.function_body, '}'] as const,	$ => ({ type: 'method', kind: 'set', key: $[1], params: [{ key: $[3], typeAnnotation: $[5] }], body: $[8] } as const)),
	Rule([JS.class_member_name, ':', type, ';'] as const,														$ => ({ type: 'field', ...$[0], typeAnnotation: $[2] } as const)),
	Rule([JS.class_member_name, ':', type, '=', JS.assignment_expression, ';'] as const,						$ => ({ type: 'field', ...$[0], typeAnnotation: $[2], value: $[4] } as const)),
);

const class_member_overloads = Rules<JS.ClassMember0<Type, TypeParam>>(
	// Bodyless overload signatures -- this syntax-only grammar doesn't check the names/signatures actually line up with a later implementation.
	Rule([JS.class_member_name, parameter_clause, ';'] as const,							$ => ({ type: 'method', ...$[0], ...$[1] } as const)),
	// Bodyless accessor signatures (`abstract get length(): number;`). `JS.GET`/`JS.SET`, not bare string literals, to keep their `startsPropertyName`
	// disambiguation (see the bareword-keyword-vs-identifier pattern in tison_project memory).
	Rule([JS.GET, JS.property_name_computed, '(', ')', ':', type, ';'] as const,			$ => ({ type: 'method', key: $[1], kind: 'get', params: [], returnType: $[5] } as const)),
	Rule([JS.SET, JS.property_name_computed, '(', IDENT, ':', type, ')', ';'] as const,		$ => ({ type: 'method', key: $[1], kind: 'set', params: [{ key: $[3], typeAnnotation: $[5] }] } as const)),
);

// Any number of member modifiers in any order (`static readonly`, `public static`, etc), pushed onto `class_member` so every member shape gets it.
const class_member_modifier_list = List(OneOf(['public', 'private', 'protected', 'readonly', 'abstract', 'static', 'override']));

(JS.class_member as unknown as Rules<ClassMember>).push(
	Rule(['[', IDENT, ':', type, ']', ':', type, ';'] as const,				$ => ({ type: 'index_signature', paramName: $[1], paramType: $[3], typeAnnotation: $[6] } as const)),
	Rule([class_member_modifier_list, JS.class_member_body] as const,		$ => {
		const modifiers = $[1].modifiers ? [...$[1].modifiers, ...$[0]] : $[0];
		return {...$[1], ...(modifiers.length ? { modifiers } : {}) };
	}),
	Rule([class_member_modifier_list, class_member_overloads] as const,		$ => ({...$[1], ...($[0].length ? { modifiers: $[0] } : {})})),
	// A sole `static` modifier has no LR(0) state retaining the `class_member_overloads` completion (a missing transition from state-merging, not
	// a resolvable conflict -- `forceFork` can't fix this class of bug), so it needs its own direct rule.
	Rule(['static', class_member_overloads] as const,						$ => ({...$[1], modifiers: [...($[1].modifiers ?? []), 'static']} as const)),
	class_member_overloads,
);

// ===================================================================
//  Typed variable declarations
// ===================================================================

JS.variable_declaration.push(
	Rule([IDENT, '!', ':', type] as const,							$ => ({ name: $[0], typeAnnotation: $[3], definite: true } as const)),
);

// ===================================================================
//  Class generics & `implements`
// ===================================================================

const implements_clause = Rules(
	Rule(['implements', type_list] as const, $ => $[1]),
);
// Parsed then discarded -- `Statement`'s `class_decl`/`class` have no slot for a superclass's own instantiation, only its own `typeParams`.
const class_extends_target = Rules(
	JS.left_hand_side_expression,
	Rule([JS.left_hand_side_expression, genericExtendsOpen, type_list, '>'] as const, $ => $[0]),
);

// The `<T>`/`implements` combinations are pushed onto js-parser.ts's shared `class_heritage`, reaching every class shape (declarations, expressions,
// `abstract`) at once instead of enumerating per shape. js-parser.ts's own alternatives already cover the bare and plain-`extends` shapes.
JS.class_heritage.length = 0;
JS.class_heritage.push(
	Rule([type_parameters_opt, Maybe(implements_clause)] as const,									$ => ({ typeParams: $[0], implementsClause: $[1] } as const)),
	Rule([type_parameters_opt, 'extends', class_extends_target, Maybe(implements_clause)] as const,	$ => ({ typeParams: $[0], superClass: $[2], implementsClause: $[3] } as const)),
);

JS.class_declaration.push(
	Rule(['abstract', 'class', IDENT, JS.class_heritage, JS.class_body] as const,	$ => ({ type: 'class_decl', name: $[2], ...$[3], body: $[4], abstract: true } as const)),
);

// ===================================================================
//  `expr as Type` / `expr satisfies Type` / `expr!` (non-null assertion)
// ===================================================================

const call_type_arguments = Rules<Type[]>(
	Rule([genericCallOpen, type_list, '>'] as const,	$ => $[1]),
);

// `as`/`satisfies` go on `relational_expression` (matching real TS precedence, so `a + b as T` parses as `(a + b) as T`); `!`/generic-call go on
// `call_expression`. One loop iteration per chain: the ordinary one and js-parser.ts's "_nobrace" mirror (used where a leading `{` must never be an object literal).
for (const [relational, member, call] of [
	[JS.relational_expression, JS.member_expression, JS.call_expression],
	[JS.relational_expression_nobrace, JS.member_expression_nobrace, JS.call_expression_nobrace],
] as const) {
	relational.push(
		Rule([relational, 'as', type] as const,						$ => ({ type: 'as_expression', expression: $[0], typeAnnotation: $[2] } as const)),
		Rule([relational, 'satisfies', type] as const,				$ => ({ type: 'satisfies_expression', expression: $[0], typeAnnotation: $[2] } as const)),
	);
	call.push(
		Rule([member, '!'] as const,								$ => ({ type: 'unary_post', operator: '!', argument: $[0] } as const)),
		Rule([call, '!'] as const,									$ => ({ type: 'unary_post', operator: '!', argument: $[0] } as const)),
		Rule([member, call_type_arguments, JS.arguments_] as const,	$ => ({ type: 'call', callee: $[0], arguments: $[2], typeArgs: $[1] } as const)),
		Rule([call, call_type_arguments, JS.arguments_] as const,	$ => ({ type: 'call', callee: $[0], arguments: $[2], typeArgs: $[1] } as const)),
		// Bare instantiation expression (TS 4.7+): `expr<T,U>` pins a generic function's type params without calling it.
		Rule([member, call_type_arguments] as const,				$ => ({ type: 'instantiation', expression: $[0], typeArgs: $[1] } as const)),
		Rule([call, call_type_arguments] as const,					$ => ({ type: 'instantiation', expression: $[0], typeArgs: $[1] } as const)),
	);
	// `new`'s callee stays the unrestricted `member_expression` in both chains (once `new` is shifted, an object-literal-vs-block ambiguity can't arise).
	member.push(
		Rule(['new', JS.member_expression, call_type_arguments, JS.arguments_] as const,	$ => ({ type: 'new', callee: $[1], arguments: $[3], typeArgs: $[2] } as const)),
		// Paren-less generic `new` (`new Map<K, V>;`) -- mirrors js-parser.ts's own paren-less plain `new Foo;`.
		Rule(['new', JS.member_expression, call_type_arguments] as const,					$ => ({ type: 'new', callee: $[1], arguments: [], typeArgs: $[2] } as const)),
	);
}

// ===================================================================
//  Wire it up
// ===================================================================

export const parser = makeParser({
	skip: JS.skip,
	recover: JS.recover,
	start: JS.program,
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
});

export const parse = (input: string) => parser.parse(input) as Program;

