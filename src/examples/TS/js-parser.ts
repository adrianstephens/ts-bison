import * as path from 'path';
import { type RecoveryCallback, type MergeValues, type Token, type LALRParser, type TermLike, makeRule, Rules, terminal, Manual, makeParser, Forward, List, Maybe, OneOf, ForceFork, WithPrec } from '../../tison';
import { makeCachedParser } from '../../tableCache';
import { Literal, Identifier, Unary, UnaryPost, Binary, Assign, Await } from '../common';
import * as Common from '../common';

// ===================================================================
//  JavaScript Parser using tison
// ===================================================================
//
// Known simplifications/omissions:
//   - 'async'/'await'/'yield'/'static'/'get'/'set'/etc. are not fully contextual only
//   - Rest in any destructuring pattern (function params, array, object) is always a bare identifier, never a nested pattern (e.g. `function f(...[a, b]) {}` doesn't parse here).

// ===================================================================
//  AST
// ===================================================================

export type unaryOps		= '+'|'-'|'~'|'!'|'++'|'--'|'delete'|'void'|'typeof';

export const CompareOps		= ['<', '>', '<=', '>=', '==', '!=', '===', '!=='] as const;
export const AssignableOps	= ['+', '-', '*', '**', '/', '%', '&', '|', '^', '<<', '>>', '>>>', '&&', '||', '??'] as const;

export type compareOps		= (typeof CompareOps)[number];
export type assignableOps	= (typeof AssignableOps)[number];
export type assignOps		= '='|`${assignableOps}=`;
// Deliberately excludes `assignOps`: an assignment is a `Common.Assign` node, not a `Binary` whose
// operator happens to end in `=`. That is what makes "forgot an operator from the set" impossible.
export type binaryOps		= assignableOps | compareOps|'instanceof'|'in'

export const JSUnary		= Unary<Expr, unaryOps>;
export const JSBinary		= Binary<Expr, binaryOps>;

export interface TemplatePart<T> { str: string; exp?: T; }

export type Key<T = any>	= string | { computed: Expr<T> };
export type BindingTarget	= string | ObjectPattern | ArrayPattern;

export interface ObjectPatternProperty		{ key: Key; value: BindingTarget; default?: Expr; }
export interface ObjectPattern				{ type: 'object_pattern'; properties: ObjectPatternProperty[]; rest?: string; }
export function  ObjectPattern(properties: ObjectPatternProperty[], rest?: string): ObjectPattern { return { type: 'object_pattern', properties, rest }; }

export interface ArrayPatternElement		{ target: BindingTarget; default?: Expr; }
export interface ArrayPattern 				{ type: 'array_pattern'; elements: (ArrayPatternElement | undefined)[]; rest?: BindingTarget; }
export function  ArrayPattern(elements: (ArrayPatternElement | undefined)[], rest?: BindingTarget): ArrayPattern { return { type: 'array_pattern', elements, rest }; }

export type      ArrayLit<T>				= Common.Sequence<Expr<T> | undefined, 'array'>;
export function  ArrayLit<T>(elements: readonly (Expr<T> | undefined)[]): ArrayLit<T>	{ return { type: 'array', elements}; }

export interface TypeParam<T> 				{ name: string; constraint?: T; default?: T; const?: boolean; }
export interface Rest<T>					{ key: BindingTarget; typeAnnotation?: T; }
export function  Rest<T>(key: BindingTarget, typeAnnotation?: T): Rest<T> { return {key, typeAnnotation}; }
export interface Param<T>					{ key: BindingTarget; default?: Expr<T>; typeAnnotation?: T; modifiers?: string[]; decorators?: Expr[] }
export function  Param<T>(key: BindingTarget, typeAnnotation?: T, modifiers?: string[]): Param<T> { return { key, typeAnnotation, modifiers }; }
export interface Params<T>					{ params: Param<T>[]; rest?: Rest<T>; }
export function  Params<T>(params: Param<T>[], rest?: Rest<T>) : Params<T> { return {params, rest }; }
export interface CallSig<T> extends Params<T> { typeParams?: TypeParam<T>[]; returnType?: T; declScope?: unknown; scope?: unknown; pure?: boolean }

export type CallSigParams<T> =
	|	[CallSig<T>]
	|	[Params<T>]
	|	[Params<T>, T|undefined]
	|	[Params<T>, T|undefined, TypeParam<T>[]|undefined]
	|	[Param<T>[]]
	|	[Param<T>[], T|undefined]
	|	[Param<T>[], T|undefined, TypeParam<T>[]|undefined]

export function CallSig<T>(...args: CallSigParams<T>) : CallSig<T> {
	if (Array.isArray(args[0]))
		return { params: args[0], returnType: args[1] as T, typeParams: args[2] as TypeParam<T>[] };
	return args.length > 1
		? { ...args[0], returnType: args[1] as T, typeParams: args[2] as TypeParam<T>[] }
		: args[0];
}

export interface KeyMods<T>	{ key: Key<T>, modifiers?: string[] };
export type      Spread<T>	= Common.Spread<Expr<T>>;
export function  Spread<T>(operand: Expr<T>): Spread<T> { return { type: 'spread', operand }; }

export interface FunctionExpr<T> extends CallSig<T> { type: 'function'; name?: string; body?: Stmt<T>[]; modifiers?: string[] }
export function  FunctionExpr<T>(sig: CallSig<T>, body: Stmt<T>[], more?: Partial<FunctionExpr<T>>): FunctionExpr<T> { return { type: 'function', body, ...sig, ...more}; }

export interface Arrow<T> extends CallSig<T> { type: 'arrow'; body: Expr | Stmt<T>[]; modifiers?: string[] }
export function  Arrow<T>(sig: CallSig<T>, body: Expr | Stmt<T>[], more?: Partial<Arrow<T>>): Arrow<T> { return { body, ...sig, ...more, type: 'arrow'}; }

export interface Method<T> extends CallSig<T> { type: 'method' | 'get' | 'set'; key: Key<T>; body?: Stmt<T>[], modifiers?: string[] }
export function  Method<T>(type: 'method' | 'get' | 'set', key: Key<T>, sig: CallSig<T>, body?: Stmt<T>[], modifiers?: string[]): Method<T> { return { type, key, body, modifiers, ...sig }; }
export interface Field<T> { type: 'field'; key: Key<T>; value?: Expr; typeAnnotation?: T; modifiers?: string[] }
export function  Field<T>(key: Key<T>, value?: Expr<T>, typeAnnotation?: T, modifiers?: string[]): Field<T> { return { type: 'field', key, value, typeAnnotation, modifiers }; }

export type ObjectProperty<T> = Method<T> | Field<T> | Spread<T>;
export interface ObjectExpr<T>	{ type: 'object'; properties: readonly ObjectProperty<T>[] }
export function  ObjectExpr<T>(properties: readonly ObjectProperty<T>[]): ObjectExpr<T> { return {type: 'object', properties }; }

export type ClassMember<T>	= Method<T> | Field<T> | { type: 'static_block'; body: Stmt<T>[] }
export interface Class<T = unknown, M = ClassMember<T>> { name?: string; superClass?: Expr<T>; body: M[]; typeParams?: TypeParam<T>[]; implements?: T[]; abstract?: boolean; decorators?: Expr[] };

export interface Call<T = unknown> extends Common.Call<Expr<T>> { optional?: boolean; typeArgs?: T[] }
export function  Call<T>(callee: Expr<T>, args: Expr<T>[], optional?: boolean, typeArgs?: T[]): Call<T> { return {type: 'call', callee, arguments: args, optional, typeArgs}; }
export interface Member<T> extends Common.Member<Expr<T>> { optional?: boolean }
export function  Member<T>(object: Expr<T>, property: string, optional?: boolean) : Member<T> { return { type: 'member', object, property, optional }; }
export interface Index<T> extends Common.Index<Expr<T>> { optional?: boolean }
export function  Index<T>(object: Expr<T>, index: Expr<T>, optional?: boolean): Index<T> { return { type: 'index', object, index, optional }; }

// for JSX
export interface Attribute<T>	{ name?: string; value?: Expr<T> }
export interface Element<T>		{ type: 'jsx'; name: string; attributes: Attribute<T>[]; children: Expr<T>[] }

export type Expr<T = any> =
	| Literal<number | bigint | string | boolean | null | RegExp | TemplatePart<Expr>[]>
	| ArrayLit<T>
	| FunctionExpr<T>
	| Arrow<T>
	| Identifier
	| Unary<Expr<T>, unaryOps>
	| UnaryPost<Expr<T>, unaryOps>
	| Binary<Expr<T>, binaryOps>
	| ObjectExpr<T>
	| Spread<T>
	| Call<T>
	| Common.Conditional<Expr<T>>
	| { type: 'this' }
	| { type: 'super' }
	| Member<T>
	| Index<T>
	| { type: 'new';	callee: Expr<T>; arguments: Expr<T>[]; typeArgs?: T[] }
	| { type: 'sequence'; expressions: Expr<T>[] }
	| { type: 'tagged_template'; tag: Expr<T>; quasi: TemplatePart<Expr<T>>[] }
	| Common.Assign<Expr<T>, assignableOps>
	| Common.Await<Expr<T>>
	| Common.Yield<Expr<T>> & { delegate?: boolean }
	| { type: 'class'; } & Class
	// for TS
	| { type: 'as';				expression: Expr<T>; typeAnnotation: T }
	| { type: 'satisfies';		expression: Expr<T>; typeAnnotation: T }
	| { type: 'instantiation';	expression: Expr<T>; typeArgs: T[] }
	// for JSX
	| Element<T>

// Rebuilds the flattened `"Symbol.iterator"`-style string back into a real `Expr` for a computed member name -- a general expression isn't an option,
// since real TypeScript restricts a computed interface/type-literal key to a `unique symbol` reference anyway.
export function dottedNameToExpr(name: string): Expr {
	const parts = name.split('.');
	return parts.slice(1).reduce<Expr>((object, property) => Member(object, property), Identifier(parts[0]));
}

export function ExprToDottedName(e: Expr): string {
	return	e.type === 'member' ? ExprToDottedName(e.object) + '.' + e.property
		:	e.type === 'identifier' ? e.name
		:	'??';
}

export interface FunctionDecl<T>	extends CallSig<T> { type: 'function_decl'; name: string; body?: Stmt<T>[]; modifiers?: string[]; ambient?: boolean };
export function  FunctionDecl<T>(name: string, sig: CallSig<T>, body?: Stmt<T>[], more?: Partial<FunctionDecl<T>>): FunctionDecl<T> { return { type: 'function_decl', name, body, ...sig, ...more}; }

export interface ClassDecl<T> extends Class<T> { type: 'class_decl'; name: string; ambient?: boolean; }

export type DeclarationKind		= 'var' | 'let' | 'const' | 'using' | 'await using';
export interface Var<T>			{ name: BindingTarget; init?: Expr<T>; typeAnnotation?: T; definite?: boolean; }
export function  Var<T>(name: BindingTarget, init?: Expr<T>, typeAnnotation?: T, definite?: boolean): Var<T> { return {name, init, typeAnnotation, definite}; }
export interface VarDecl<T>		{ type: 'var_decl'; kind: DeclarationKind; ambient?: boolean; declarations: Var<T>[] }
export function  VarDecl<T>(kind: DeclarationKind, ...declarations: Var<T>[]): VarDecl<T> { return { type: 'var_decl', kind, declarations }; }
export function  AmbientVarDecl<T>(kind: DeclarationKind, ...declarations: Var<T>[]): VarDecl<T> { return { type: 'var_decl', kind, declarations, ambient: true }; }

export type Declaration<T> = VarDecl<T> | FunctionDecl<T> | ClassDecl<T>;

export interface ExportDecl<T>		{ type: 'export_decl'; declaration: Declaration<T>};
export function  ExportDecl<T>(d: Declaration<T>): ExportDecl<T> { return { type: 'export_decl', declaration: d }; }

export interface ImportSpecifier	{ imported: string; local: string; typeOnly?: boolean; }
export interface ExportSpecifier	{ local: string; exported: string; typeOnly?: boolean; }
export interface Import				{ type: 'import'; specifiers?: ImportSpecifier[]; source:  string; namespace?: string; typeOnly?: boolean; default?: string; attributes?: {key: string, value: string}[] }
export interface Export<T>			{ type: 'export'; specifiers?: ExportSpecifier[]; source?: string; namespace?: string; typeOnly?: boolean; default?: Expr<T>|Declaration<T> }

export function Expression<T>(expression: Expr<T>) { return { type: 'expression', expression } as const; }

export type ForInit<T> = Expr<T> | VarDecl<T>;
export interface SwitchCase<T, S = Stmt<T>> { test?: Expr<T>; consequent: S[]; }
export function SwitchCase<T, S>(test: Expr<T>, ...consequent: S[]) : SwitchCase<T, S> { return { test, consequent }; }
export function Switch<S>(discriminant: Expr, ...cases: SwitchCase<any, S>[]) { return { type: 'switch' as const, discriminant, cases }; }
// The shared statement constructors, re-exported so a consumer building JS statements reaches for
// `JS.Block`/`JS.Return` rather than importing common.ts alongside js-parser.
export const    Block   = Common.Block;
export const    Return  = Common.Return;
export const    Throw   = Common.Throw;
export const    ExprStmt = Common.ExprStmt;
export function For<S>(init: ForInit<any>|undefined, test: Expr|undefined, update: Expr|undefined, body: S) { return { type: 'for' as const, kind: 'normal' as const, init, test, update, body }; }
//export function If<S>(test: Expr, consequent: S, alternate?: S) { return {type: 'if' as const, test, consequent, alternate }; }
//export function While<S>(test: Expr, body: S) { return {type: 'while' as const, test, body }; }
//export function DoWhile<S>(body: S, test: Expr) { return {type: 'do_while' as const, body, test }; }

// `X`: the statement extension seam -- defaults to `never` (plain JS), ts-parser instantiates it with
// its own `Declaration` so a TS-only declaration (`type A = B`, `interface`, `enum`, `namespace`) can
// appear in every NESTED statement position -- a block, an if branch, a loop body, a switch case, a
// try -- without a cast. Mirrors c-parser.ts's own `Statement<D, X>` seam.
//
// Residual narrowness, deliberate: the bodies reached through `Declaration<T>` (a `function_decl`'s
// own body, a class method's) stay `Statement<T>`. Threading `X` that far would drag it through
// `Expr<T>` as well, since a function EXPRESSION is an expression -- far more surface than the
// nesting these consumers actually build.
export type Stmt<T, X = never> = Declaration<T>
	| X
	| Common.Block<Stmt<T, X>>
	| Common.ExprStmt<Expr>
	| { type: 'empty' }
	| Common.If<Expr, Stmt<T, X>>
	| Common.DoWhile<Expr, Stmt<T, X>>
	| Common.While<Expr, Stmt<T, X>>
	| { type: 'for'; kind: 'normal'; init?: ForInit<T>; test?: Expr; update?: Expr; body: Stmt<T, X> }
	| { type: 'for'; kind: 'in' | 'of' | 'of await'; init: ForInit<T>; right: Expr; body: Stmt<T, X> }
	| { type: 'continue'; label?: string }
	| { type: 'break'; label?: string }
	| Common.Return<Expr>
	| { type: 'with'; argument: Expr; body: Stmt<T, X> }
	| Common.Labeled<Stmt<T, X>>
	| { type: 'switch'; discriminant: Expr; cases: SwitchCase<T, Stmt<T, X>>[] }
	| (Common.Throw<Expr> & { argument: Expr })
	| Common.Try<Stmt<T, X>, BindingTarget>
	| { type: 'debugger' }
	| Export<T>
	| ExportDecl<T>
	| Import

// ===================================================================
//  terminals
// ===================================================================

export const reIDENT	= /[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/u;
export const IDENT		= terminal('identifier', reIDENT);
// A private class field/method name (`#x`), always exactly `#` + an ordinary identifier -- unlike `@`, no
// ambiguity with anything else in the grammar (`#` doesn't otherwise appear anywhere but `#!` shebangs,
// already stripped by `skip` before any terminal match is attempted), so this needs no `forceFork`.
export const PRIVATE_NAME	= terminal('private-name', new RegExp('#' + reIDENT.source, 'u'));
// Real TS's scanner tolerates a numeric separator `_` in *any* position within a decimal literal's digit
// runs -- doubled up, straddling the `.`/`e`/sign boundaries, even trailing with nothing after it -- and
// only soft-diagnoses misplacement (TS6188/TS6189) rather than ever failing to tokenize; confirmed exhaustively
// against `parser.numericSeparators.decmialNegative.ts`'s own `.errors.txt` baseline (52 single-fragment cases
// enumerating misplaced separators), every one a single soft diagnostic with no parse-breaking follow-on error.
// A bare trailing `.` (no real fraction digit, e.g. `3.toString()`) only gets absorbed into the number when NOT
// immediately followed by an identifier-start char -- real TS reserves that adjacency for member access
// (`3.toString()` parses as `3 . toString ()`, just diagnosed TS1351; `3. + 1` still eats the dot as usual) --
// UNLESS what follows is actually a valid exponent (`3.e5` is the number `3.0e5`, not `(3.).e5`: `e` looks like
// an identifier-start too, so the exponent shape has to be special-cased ahead of the generic identifier guard).
// This same rule also covers `000.toString()` with no octal-specific casing: a leading-zero digit run has no
// digit after its own trailing dot either, so it stops right at `000` the same way `3` does.
export const NUM		= terminal('number', /0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?|0[oO][0-7](?:_?[0-7])*n?|0[bB][01](?:_?[01])*n?|[0-9](?:_?[0-9])*n|(?:[0-9][0-9_]*\.(?:_*[0-9][0-9_]*|_*(?:(?=[eE][-+]?_*[0-9])|(?![A-Za-z_$])))|\.[0-9][0-9_]*|[0-9][0-9_]*)(?:[eE]_*[-+]?_*[0-9][0-9_]*)?/);
export const STR		= terminal('string', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/);

// `get`/`set`/`async` are contextual keywords, only keywords when what follows still looks like the construct.
function startsPropertyName(next: Token | undefined) {
	return next && (next.type === IDENT || next.type === STR || next.type === NUM || next.type === PRIVATE_NAME || next.type.name === '[');
}
export const GET		= terminal('get',	/get(?!\w)/,	lex => startsPropertyName(lex.next()) ? GET : IDENT);
export const SET		= terminal('set',	/set(?!\w)/,	lex => startsPropertyName(lex.next()) ? SET : IDENT);
export const USING		= terminal('using', /using(?!\w)/,	lex => lex.next()?.type === IDENT ? USING : IDENT);
export const ASYNC		= terminal('async',	/async(?!\w)/,	lex => {
	const next = lex.next();
	return (next && (next.type.name === 'function' || next.type.name === '*' || next.type.name === '(' || next.type.name === '<')) || startsPropertyName(next) ? ASYNC : IDENT;
});
// A class member literally *named* `export` (e.g. `@isopodlabs/registry`'s `export(file: string): Promise<void>`)
// has `(`/`<`/`:`/`?`/`;`/`}`/`!` directly next -- a shape `export`-the-keyword never produces in any of its own
// uses (`export class`, `export { ... }`, `export = expr`, ts-parser.ts's class-member-modifier use, etc). `=` is
// deliberately excluded: `export = expr;` (export-assignment) legitimately has `=` right after `export` too.
// Exported (not local to this file) so ts-parser.ts's class-member-modifier list reuses the exact same terminal
// object instead of letting its own bare `'export'` string auto-intern a second, non-contextual one.
export const EXPORT_KW	= terminal('export', /export(?!\w)/, lex => /^\s*[(<:?;}!]/.test(lex.remaining) ? IDENT : EXPORT_KW);

// Automatic Semicolon Insertion: reclassify a line-terminator-containing run of whitespace into a `;`
// right after return/throw/break/continue/yield, or right before postfix ++/--.
const RESTRICTED_AFTER	= new Set(['return', 'throw', 'break', 'continue', 'yield']);
const RESTRICTED_BEFORE = new Set(['++', '--']);
const RESTRICTED_BEFORE_PREV = new Set([IDENT.name, ']']);

const WS = terminal('ws',
	/\s+/,
	lex => {
		if (lex.match.includes('\n')) {
			if (lex.prev && RESTRICTED_AFTER.has(lex.prev.type.name))
				return ';';
			if (lex.prev && RESTRICTED_BEFORE_PREV.has(lex.prev.type.name)) {
				const r = lex.remaining;
				if (r.startsWith('++') || r.startsWith('--'))
					return ';';
				if (r[0] === '/' && (r[1] === '/' || r[1] === '*')) {
					const next = lex.next();
					if (next && RESTRICTED_BEFORE.has(next.type.name))
						return ';';
				}
			}
		}
		return WS;
	}
);

// A '/' starts a regex literal unless the previous token could itself end an expression.
const regexDisallowedAfter = new Set([
	IDENT.name, NUM.name, STR.name,
	')', ']', '++', '--', 'this', 'true', 'false', 'null'
]);

const REGEX_LITERAL = terminal('regex',
	/\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-zA-Z]*/,
	lex => (!lex.prev || !regexDisallowedAfter.has(lex.prev.type.name)) ? REGEX_LITERAL : undefined
);


// ===================================================================
//  Grammar
// ===================================================================

export const Rule = makeRule<any>(Common.stampPos);

// `=` has no base operator; every other form drops its trailing `=` ONCE, here, so nothing downstream
// has to slice a string to find it again.
const assign = (op: assignOps, target: Expr, value: Expr) =>
	Assign<Expr, assignableOps>(target, value, op === '=' ? undefined : op.slice(0, -1) as assignableOps);

const ASSIGN_OP = OneOf(['+=', '-=', '*=', '**=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '??=', '&&=', '||=', '=']);
const UNARY_OP	= OneOf(['++', '--', 'delete', 'void', 'typeof', '+', '-', '~', '!']);


// Mirrors ECMA-262's own In/NoIn duplication above shift_expression: `for (x in y)` vs `for (x; ...)`
// would otherwise be ambiguous over whether 'in' continues a RelationalExpression or marks the for-in separator.
function binaryChain(lower: Rules<Expr>, ops: binaryOps[], prec: string) {
	return Rules<Expr>(self => [
		lower,
		WithPrec(Rule([self, OneOf(ops), lower], $ =>	Binary($[1], $[0], $[2])), prec)
	]);
}

// Same as `binaryChain`, but only the chain's own left-recursion needs to stay NoBrace-restricted.
function binaryChainLeft(lowerLeft: Rules<Expr>, lowerRight: Rules<Expr>, ops: binaryOps[], prec: string) {
	return Rules<Expr>(self => [
		lowerLeft,
		WithPrec(Rule([self, OneOf(ops), lowerRight], $ => Binary($[1], $[0], $[2])), prec)
	]);
}

// `\u{...}` takes an unbounded run of hex digits, so its value can exceed the max code point (0x10FFFF)
// -- real source for this (deliberately invalid, testing tsc's own diagnostic) exists in the wild, and
// `String.fromCodePoint` throws a native RangeError rather than returning anything for it. This is called
// from plain grammar-action code with no error-reporting path available, so the replacement character
// stands in, same as a real decoder falls back to for any other unrepresentable input.
const codePoint = (n: number) => n >= 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : '�';

// Hand-decoded rather than round-tripped through `JSON.parse`: JSON's escape set is a strict subset of JS's, so valid JS strings like `'\0'` threw there.
export const unescapeString = (s: string) => s.replace(
	/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|\r\n|\n|(.))/g,
	(_, hex, ubrace, u4, ch) =>
		hex !== undefined ? String.fromCharCode(parseInt(hex, 16))
		: ubrace !== undefined || u4 !== undefined ? codePoint(parseInt(ubrace ?? u4, 16))
		: ch === undefined ? ''
		: ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch === 'b' ? '\b' : ch === 'f' ? '\f' : ch === 'v' ? '\v' : ch === '0' ? '\0'
		: ch
);
export const unquoteString = (s: string) => unescapeString(s.slice(1, -1));

const fwd_assignment_expression	= Forward<Expr>(() => assignment_expression);

const expression = Rules<Expr>(self => [
	fwd_assignment_expression,
	Rule([self, ',', fwd_assignment_expression],				$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] } as const))
]);


export const statement_list = List(Forward<Stmt<any>>(() => statement));
export const function_body = Rules(
	Rule([], 			_ => []),
	statement_list
);

// `elision`: a run of N commas with nothing between them, i.e. N holes. A single trailing comma after a
// real element is just a separator, not a hole -- counting only starts from the *next* comma onward.
const elision = Rules<number>(self => [
	Rule([','], 		_ => 1),
	Rule([self, ','],	$ => $[0] + 1),
]);
const holes = (n: number) => Array<undefined>(n).fill(undefined);

// --- Destructuring binding patterns ---
// ts-parser.ts's typed-arrow extension reaches a bare `identifier` here from expression position too -- a genuine reduce-reduce ambiguity against
// `primary_expression`'s own identifier that needs `forceFork` to resolve via GLR.
export const binding_pattern = Rules<ObjectPattern | ArrayPattern>(
	Rule([Forward<ObjectPattern>(()=>object_pattern)]),
	Rule([Forward<ArrayPattern>(()=>array_pattern)]),
);
export const binding_target = Rules<BindingTarget>(
	ForceFork(Rule([IDENT], $ => $[0])),
	...binding_pattern,
);

const object_pattern_property = Rules<ObjectPatternProperty>(
	// `forceFork`: a bare `identifier` here is a genuine reduce-reduce tie with `property_assignment`'s own
	// bare-`identifier` shorthand (an arrow's `(` is also reachable as a plain expression, so `{a}` is
	// ambiguous between a destructuring shorthand and an object-literal shorthand until something past this
	// single token disambiguates) -- same shape as `binding_target`'s own `ForceFork(Rule([IDENT], ...))`
	// just above. Recorded as `kind:'reduce-reduce', resolution:'earlier rule wins'` when unfixed (verified
	// via a direct, uncached `makeParser` build -- `tables.conflicts` is NOT populated on a table loaded
	// from `.tables-cache/*.json.gz`, so checking a cached parser's `conflicts` always looks empty).
	ForceFork(Rule([IDENT], 											$ => ({ key: $[0], value: $[0] } as const))),
	Rule([IDENT, '=', fwd_assignment_expression], 						$ => ({ key: $[0], value: $[0], default: $[2] } as const)),
	Rule([IDENT, ':', binding_target], 									$ => ({ key: $[0], value: $[2] } as const)),
	Rule([IDENT, ':', binding_target, '=', fwd_assignment_expression], 	$ => ({ key: $[0], value: $[2], default: $[4] } as const)),
	// String/number key (`{0: a}`, `{"x": a}`) -- reuses `property_name_quoted` rather than raw STR/NUM,
	// same shared-state LALR(1) lookahead disambiguation `property_assignment`'s own STR/NUM key rule
	// already relies on (see `property_name_quoted`'s own comment) -- raw STR/NUM here instead created new,
	// un-forceForked states that collided with plain object-literal parsing in arrow-vs-paren-expression
	// position (`({"1": "one"})` misparsed as a pattern). No bare shorthand: `{0}`/`{"x"}` alone isn't valid
	// destructuring syntax, only a bareword identifier can shorthand.
	Rule([Forward<string>(() => property_name_quoted), ':', binding_target],										$ => ({ key: $[0], value: $[2] } as const)),
	Rule([Forward<string>(() => property_name_quoted), ':', binding_target, '=', fwd_assignment_expression],		$ => ({ key: $[0], value: $[2], default: $[4] } as const)),
	// Computed key (`{[expr]: binding}`) -- same `{computed: Expr}` key shape `property_assignment`'s own
	// computed-key rule already uses for object *literals*, just missing here on the pattern side.
	Rule(['[', fwd_assignment_expression, ']', ':', binding_target],										$ => ({ key: { computed: $[1] }, value: $[4] } as const)),
	Rule(['[', fwd_assignment_expression, ']', ':', binding_target, '=', fwd_assignment_expression],	$ => ({ key: { computed: $[1] }, value: $[4], default: $[6] } as const)),
);
const object_pattern_property_list = List(object_pattern_property, ',', true);
// KNOWN GAP: `({...x})` (a lone spread) fails to parse anywhere, ambiguous with this rule's own `'{' '...' IDENT
// '}'` rest-binding. Unlike the analogous empty-`{}` case below, `ForceFork` doesn't fix it: the resulting GLR
// merge can't tell "becomes a pattern" from "just a value" without seeing `=>`, and picking a side broke the more
// common `({...x}) => ...` destructuring param. Workaround: `({...x, y: 1})` (another property) parses fine.
export const object_pattern = Rules(
	Rule(['{', '}'], 													_ => ObjectPattern([])),
	Rule(['{', object_pattern_property_list, '}'], 						$ => ObjectPattern($[1])),
	Rule(['{', '...', IDENT, '}'], 										$ => ObjectPattern([], $[2])),
	Rule(['{', object_pattern_property_list, ',', '...', IDENT, '}'], 	$ => ObjectPattern($[1], $[4])),
);

const array_pattern_element = Rules(
	Rule([binding_target], 												$ => ({ target: $[0] } as const)),
	Rule([binding_target, '=', fwd_assignment_expression],				$ => ({ target: $[0], default: $[2] } as const)),
);
const array_pattern_element_list = Rules<(ArrayPatternElement | undefined)[]>(self => [
	Rule([array_pattern_element],										$ => [$[0]]),
	Rule([elision, array_pattern_element],								$ => [...holes($[0]), $[1]]),
	Rule([self, ',', array_pattern_element],							$ => [...$[0], $[2]]),
	Rule([self, ',', elision, array_pattern_element], 					$ => [...$[0], ...holes($[2]), $[3]]),
]);
export const array_pattern = Rules(
	Rule(['[', ']'], 													_ => ArrayPattern([])),
	Rule(['[', elision, ']'], 											$ => ArrayPattern(holes($[1]))),
	Rule(['[', array_pattern_element_list, ']'], 						$ => ArrayPattern($[1])),
	Rule(['[', array_pattern_element_list, ',', ']'], 					$ => ArrayPattern($[1])),
	Rule(['[', array_pattern_element_list, ',', elision, ']'], 			$ => ArrayPattern([...$[1], ...holes($[3])] )),
	// The rest target can itself be destructured (`[...{0: a, b}] = arr`, `[...[a, b]] = arr`) -- real JS
	// semantics allow this for *array* rest (unlike object rest, which is always a plain identifier).
	// `binding_name` already carries this exact `BindingTarget` union (used for function-parameter rest,
	// see its own comment), just reused here instead of hardcoding `IDENT`.
	Rule(['[', '...', Forward<{key: BindingTarget}>(() => binding_name), ']'], 										$ => ArrayPattern([], $[2].key)),
	Rule(['[', array_pattern_element_list, ',', '...', Forward<{key: BindingTarget}>(() => binding_name), ']'], 	$ => ArrayPattern($[1], $[4].key)),
);

// A name in a binding position; extension point ts-parser.ts populates. A rest binding can itself be destructured
// (`function f(...[a, b]) {}` is legal JS), so `key` covers the same `BindingTarget` union as any other binding target.
export const binding_name = Rules<{ key: BindingTarget }>(
	Rule([IDENT],						$ => ({ key: $[0] } as const)),
	Rule([array_pattern],				$ => ({ key: $[0] } as const)),
	Rule([object_pattern],				$ => ({ key: $[0] } as const)),
);

// `forceFork` on both: right after a bare identifier in a position also reachable as a plain expression, reducing here vs. `primary_expression -> identifier` is a genuine one-token ambiguity needing GLR.
export const optional_binding_name = Rules<{key: string, modifiers?: string[]}> (
	ForceFork(Rule([IDENT], 			$ => ({ key: $[0] } as const))),
	ForceFork(Rule([IDENT, '?'], 		$ => ({ key: $[0], modifiers: ['optional'] } as const))),
);

// Default values use `ASSIGN_OP`, not bare `'='` -- ts-parser.ts's typed-arrow rule makes this `(` reachable from plain expression position too, so a
// separate `'='` terminal would win the lexer tie-break and silently break every `(x = y)`, instead of staying a resolvable shift-reduce conflict.
export const parameter = Rules<Param<any>>(
	optional_binding_name,
	ForceFork(Rule([optional_binding_name, '=', fwd_assignment_expression],	$ => ({ ...$[0], default: $[2] } as const))),
	Rule([object_pattern],													$ => Param($[0])),
	Rule([object_pattern, '=', fwd_assignment_expression],					$ => Common.withDefault(Param($[0]), $[2])),
	Rule([array_pattern],													$ => Param($[0])),
	Rule([array_pattern, '=', fwd_assignment_expression],					$ => Common.withDefault(Param($[0]), $[2])),
	// Parameter decorators (`method(@dec x) {}`) are wired up near the bottom of the file (see `DECORATED_PARAMETER`),
	// once `decorator_list`/`skip` both exist -- via `Manual()`, not a direct rule reaching this widely-shared
	// nonterminal from a new position (that shape corrupts unrelated ASI recovery via LALR state-sharing, see
	// tison_debugging_technique memory "sixth class").
);

// Hand-written, not `List`/`MaybeList` -- that combinator left the state after "formal_parameter_list ','" missing the '...'/')' continuations
// (LALR "missing transition" from state merging; see tison_debugging_technique memory). Self-contained recursion avoids the collision.
const formal_parameter_list = Rules<Param<any>[]>(self => [
	Rule([parameter],				$ => [$[0]]),
	Rule([self, ',', parameter],	$ => [...$[0], $[2]]),
]);

export const parameter_clause0 = Rules<Params<any>>(
	Rule(['(', ')'], 													_ => Params([])),
	Rule(['(', formal_parameter_list, ')'], 							$ => Params($[1])),
	Rule(['(', formal_parameter_list, ',', ')'], 						$ => Params($[1])),
	Rule(['(', '...', binding_name, ')'],								$ => Params([], $[2])),
	Rule(['(', formal_parameter_list, ',', '...', binding_name, ')'],	$ => Params($[1], $[4])),
);

// extension point for typescript
export const parameter_clause = Rules<CallSig<any>>(
	parameter_clause0
);

// --- Primary / member / call / new chain ---

const element_list = Rules<(Expr | undefined)[]>(self => [
	Rule([fwd_assignment_expression], 								$ => [$[0]]),
	Rule([elision, fwd_assignment_expression], 						$ => [...holes($[0]), $[1]]),
	Rule([self, ',', fwd_assignment_expression], 					$ => [...$[0], $[2]]),
	Rule([self, ',', elision, fwd_assignment_expression], 			$ => [...$[0], ...holes($[2]), $[3]]),
	Rule(['...', fwd_assignment_expression], 						$ => [Spread($[1])]),
	Rule([elision, '...', fwd_assignment_expression], 				$ => [...holes($[0]), Spread($[2])]),
	Rule([self, ',', '...', fwd_assignment_expression], 			$ => [...$[0], Spread($[3])]),
	Rule([self, ',', elision, '...', fwd_assignment_expression],	$ => [...$[0], ...holes($[2]), Spread($[4])]),
]);

const array_literal = Rules(
	Rule(['[', ']'], 												_ => ArrayLit([])),
	Rule(['[', elision, ']'], 										$ => ArrayLit(holes($[1]))),
	Rule(['[', element_list, ']'], 									$ => ArrayLit($[1])),
	Rule(['[', element_list, ',', ']'], 							$ => ArrayLit($[1])),
	Rule(['[', element_list, ',', elision, ']'], 					$ => ArrayLit([...$[1], ...holes($[3])])),
);

// STRING/NUMBER key, deliberately without IDENT -- reused by `property_name` just below (which adds
// IDENT back on top; safe there). NOT reused directly by `property_assignment`'s own STRING/NUMBER `key:
// value` rules below -- relies on LALR(1)'s per-state lookaheads to disambiguate the shared states; SLR(1)
// (`lalr: false`) would need `property_assignment` to go back to its own direct STRING/NUMBER matches.
const property_name_quoted = Rules(
	Rule([STR], $ => unquoteString($[0])),
	Rule([NUM]),
);
export const property_name = Rules(
	Rule([IDENT]),
	Rule([STR], $ => unquoteString($[0])),
	Rule([NUM]),
);
// Like `property_name`, but also allows a computed key (`[expr]`).
export const property_name_computed = Rules<string | { computed: Expr<any> }>(
	property_name,
	Rule(['[', fwd_assignment_expression, ']'], $ => ({ computed: $[1] } as const)),
	// `get`/`set` (both `class_member_body`'s and `property_assignment`'s) name their accessor via this
	// nonterminal, not `class_member_name` (which already carries `PRIVATE_NAME`, see its own comment) --
	// widened here the same way, so `get #x()`/`set #x(v)` parse. Technically over-permissive for a plain
	// object literal (real JS has no private names outside a class), matching this grammar's usual stance of
	// erring permissive where the exactness isn't load-bearing for parsing.
	Rule([PRIVATE_NAME]),
);
export const property_assignment = Rules<ObjectProperty<any>>(
	// `IDENT ':' value` goes directly (not through `property_name`), since `property_name`'s own IDENT
	// reduction would shift/reduce-conflict with `object_pattern_property`'s `IDENT ':' binding_target`.
	Rule([IDENT, ':', fwd_assignment_expression], 											$ => Field($[0], $[2])),
	Rule([property_name_quoted, ':', fwd_assignment_expression], 							$ => Field($[0], $[2])),
	Rule([GET, property_name_computed, '(', ')', '{', function_body, '}'], 					$ => Method('get', $[1], {params: []}, $[5])),
	Rule([SET, property_name_computed, '(', IDENT, ')', '{', function_body, '}'], 			$ => Method('set', $[1], {params: [{key: $[3]}]}, $[6])),
	Rule([IDENT], 																			$ => Field($[0], Identifier($[0]))),
	// `{x = 1}` is never valid as a *real* object literal -- accepted anyway, permissively, purely so arrow
	// parameters can be parsed as a plain object literal and reinterpreted as a pattern (`exprToBindingTarget` below).
	Rule([IDENT, '=', fwd_assignment_expression], 											$ => Field($[0], Assign<Expr, assignableOps>(Identifier($[0]), $[2]))),
	Rule([property_name_computed, parameter_clause, '{', function_body, '}'], 				$ => Method('method', $[0], $[1], $[3])),
	Rule(['*', property_name_computed, parameter_clause, '{', function_body, '}'], 			$ => Method('method', $[1], $[2], $[4], ['generator'])),
	Rule([ASYNC, property_name_computed, parameter_clause, '{', function_body, '}'], 		$ => Method('method', $[1], $[2], $[4], ['async'])),
	Rule([ASYNC, '*', property_name_computed, parameter_clause, '{', function_body, '}'],	$ => Method('method', $[2], $[3], $[5], ['async', 'generator'])),
	Rule(['[', fwd_assignment_expression, ']', ':', fwd_assignment_expression], 			$ => Field({ computed: $[1] }, $[4])),
	Rule(['...', fwd_assignment_expression], 												$ => Spread($[1])),
);

const object_literal = Rules(
	Rule(['{', List(property_assignment, ',', true), '}'], 								$ => ObjectExpr($[1])),
	// Empty `{}` as its own direct alternative: ts-parser.ts's typed-arrow rule makes `{}` also reachable as `object_pattern`'s own `'{' '}'` in the same
	// merged state (LALR "missing transition"; see tison_debugging_technique memory). `forceFork` makes it a resolvable reduce-reduce conflict (`() => ({})`).
	ForceFork(Rule(['{', '}'], 															_ => ObjectExpr([]))),
);

// --- Arrow function parameter reinterpretation ---
// `(a, b)` is ambiguous with a parenthesized expression until the `=>` that follows -- parsed as an
// ordinary `expression` and `exprToParams` reinterprets the tree once `=>` is seen.

function exprToBindingTarget(e: Expr): BindingTarget {
	switch (e.type) {
		case 'identifier':
			return e.name;

		case 'object': {
			const last = e.properties[e.properties.length - 1];
			const rest = last?.type === 'spread' ? last.operand : undefined;
			if (rest && rest.type !== 'identifier')
				throw new SyntaxError('Invalid destructuring rest target');
			return ObjectPattern(
				(rest ? e.properties.slice(0, -1) : e.properties).map(p => {
					if (p.type === 'spread')
						throw new SyntaxError('Invalid destructuring target: spread must be last');
					if (p.type !== 'field')
						throw new SyntaxError('Invalid destructuring target: function');
					// `{a = 1}` parses its default as a real `assign` node (see `property_assignment`)
					return p.value!.type === 'assign'
						? { key: p.key, value: exprToBindingTarget(p.value.target), default: p.value.value }
						: { key: p.key, value: exprToBindingTarget(p.value!) };
				}),
				rest?.name
			);
		}
		case 'array': {
			const last = e.elements[e.elements.length - 1];
			const rest = last?.type === 'spread' ? last.operand : undefined;
			if (rest && rest.type !== 'identifier')
				throw new SyntaxError('Invalid destructuring rest target');
			return ArrayPattern(
				(rest ? e.elements.slice(0, -1) : e.elements).map(el =>
					  el === undefined ? undefined
					: el.type === 'assign' ? { target: exprToBindingTarget(el.target), default: el.value }
					: { target: exprToBindingTarget(el) }
				),
				rest?.name
			);
		}
		default:
			throw new SyntaxError(`Invalid destructuring target: ${e.type}`);
	}
}
function exprToParam(e: Expr): Param<any> {
	return	e.type === 'identifier'						? { key: e.name }
		:	e.type === 'assign' && !e.operator			? { key: exprToBindingTarget(e.target), default: e.value }
		:	{ key: exprToBindingTarget(e) };
}
function exprToParams(e: Expr): Param<any>[] {
	return e.type === 'sequence' ? e.expressions.map(exprToParam) : [exprToParam(e)];
}

// A bare `$` only stops the match when starting `${` -- anywhere else (a real case that broke this once)
// it's ordinary text, same as real JS/TS.
const template_literal_part = Rules<TemplatePart<Expr>>(
	Rule([/(?:[^`$\\]|\\[\s\S]|\$(?!\{))*(?=\$\{)/, '${', expression, '}'],	$ => ({ str: unescapeString($[0]), exp: $[2] })),
	Rule([/(?:[^`$\\]|\\[\s\S]|\$(?!\{))*(?=`)/], 							$ => ({ str: unescapeString($[0]) })),
);
const template_literal_parts = List(template_literal_part);

function parseNumber(text: string): Literal<number|bigint> {
	if (text.endsWith('n'))
		return Literal(BigInt(text.slice(0, -1).replace(/_/g, '')));
	const clean = text.replace(/_/g, '');
	return Literal(
			/^0[xX]/.test(clean) ? parseInt(clean, 16)
		:	/^0[oO]/.test(clean) ? parseInt(clean.slice(2), 8)
		:	/^0[bB]/.test(clean) ? parseInt(clean.slice(2), 2)
		:	parseFloat(clean)
	);
}

// Shared by `primary_expression` and its NoBrace mirror below; only the `{`-led object-literal alternative
// differs, spliced in at its original position (not appended) so relative reduce-reduce rule order is preserved.
const primaryRules = (objectLiteral?: Rules<Expr>): Rules<Expr> => [
	Rule(['this'], 								_ => ({ type: 'this' } as const)),
	Rule(['super'], 							_ => ({ type: 'super' } as const)),
	Rule([IDENT],								$ => Identifier($[0])),
	Rule([NUM], 								$ => parseNumber($[0])),
	Rule([STR], 								$ => Literal(unquoteString($[0]))),
	Rule([REGEX_LITERAL],						$ => { const m = /^\/(.*)\/([a-zA-Z]*)$/.exec($[0])!; return Literal(new RegExp(m[1], m[2])); }),
	Rule(['true'], 								_ => Literal(true)),
	Rule(['false'],								_ => Literal(false)),
	Rule(['null'],								_ => Literal(null)),
	array_literal,
	...(objectLiteral ? [objectLiteral] : []),
	Rule(['(', expression, ')'], 				$ => $[1]),
	Rule(['`', template_literal_parts, '`'],	$ => Literal($[1])),
];
export const primary_expression = primaryRules(object_literal);

export const function_expression = Rules(
	Rule(['function', parameter_clause, '{', function_body, '}'], 						$ => FunctionExpr($[1], $[3])),
	Rule(['function', IDENT, parameter_clause, '{', function_body, '}'], 				$ => FunctionExpr($[2], $[4], {name: $[1]})),
	Rule(['function', '*', parameter_clause, '{', function_body, '}'], 					$ => FunctionExpr($[2], $[4], {modifiers: ['generator'] })),
	Rule(['function', '*', IDENT, parameter_clause, '{', function_body, '}'], 			$ => FunctionExpr($[3], $[5], {name: $[2], modifiers: ['generator'] })),
	Rule([ASYNC, 'function', parameter_clause, '{', function_body, '}'], 				$ => FunctionExpr($[2], $[4], {modifiers: ['async'] } as const)),
	Rule([ASYNC, 'function', IDENT, parameter_clause, '{', function_body, '}'], 		$ => FunctionExpr($[3], $[5], {name: $[2], modifiers: ['async'] })),
	Rule([ASYNC, 'function', '*', parameter_clause, '{', function_body, '}'], 			$ => FunctionExpr($[3], $[5], {modifiers: ['async', 'generator'] })),
	Rule([ASYNC, 'function', '*', IDENT, parameter_clause, '{', function_body, '}'],	$ => FunctionExpr($[4], $[6], {name: $[3], modifiers: ['async', 'generator'] }))
);

export const member_expression = Rules<Expr>(self => [
	primary_expression,
	function_expression,
	Rule([Forward<Expr>(()=>class_expression)]),
	Rule([self, '.', IDENT], 									$ => Member($[0], $[2])),
	// `.` followed by `#name` (`this.#x`) -- reads as an ordinary member access; the `#` is carried verbatim
	// in the property string, no separate AST shape needed for parsing.
	Rule([self, '.', PRIVATE_NAME], 							$ => Member($[0], $[2])),
	Rule([self, '[', expression, ']'], 							$ => Index($[0], $[2])),
	Rule(['new', self, ()=>arguments_], 						$ => ({ type: 'new', callee: $[1], arguments: $[2] } as const)),
	// Dynamic `import(...)`/`import.meta` -- `import` on its own is never a valid expression (only ever followed by `(` or `.meta`),
	// so these are direct alternatives here rather than going through `primary_expression`.
	// Reuses the ordinary `Call`/`Member` shapes (with a synthetic `import` identifier as callee/object) instead of a dedicated AST node, so no downstream consumer needs a new case to avoid crashing on it
	Rule(['import', ()=>arguments_], 							$ => Call(Identifier('import'), $[1])),
	Rule(['import', '.', 'meta'], 								_ => Member(Identifier('import'), 'meta')),
]);
const new_expression = Rules<Expr>(self => [
	member_expression,
	Rule(['new', self], 										$ => ({ type: 'new', callee: $[1], arguments: [] } as const)),
]);
const argument_list = Rules<Expr[]>(self => [
	Rule([fwd_assignment_expression], 							$ => [$[0]]),
	Rule([self, ',', fwd_assignment_expression], 				$ => [...($[0]), $[2]]),
	Rule(['...', fwd_assignment_expression], 					$ => [Spread($[1])]),
	Rule([self, ',', '...', fwd_assignment_expression], 		$ => [...($[0]), Spread($[3])]),
	Rule([self, ','], 											$ => $[0]),
]);
export const arguments_ = Rules(
	Rule(['(', ')'], 											_ => []),
	Rule(['(', argument_list, ')'], 							$ => $[1]),
);
// The full postfix-continuation set, parameterized over the member-expression chain that seeds it -- built once for the ordinary chain and once for the
// NoBrace mirror below, so they can't drift apart. Optional chaining only marks each `?.` step, doesn't enforce real short-circuiting semantics.
const callChainRules = (member: Rules<Expr>, self: () => Rules<Expr>): Rules<Expr> => [
	Rule([member, arguments_], 									$ => Call($[0], $[1])),
	Rule([self, arguments_], 									$ => Call($[0], $[1])),
	Rule([self, '.', IDENT], 									$ => Member($[0], $[2])),
	Rule([self, '.', PRIVATE_NAME], 							$ => Member($[0], $[2])),
	Rule([self, '[', expression, ']'], 							$ => Index($[0], $[2])),
	Rule([member, '`', template_literal_parts, '`'], 			$ => ({ type: 'tagged_template', tag: $[0], quasi: $[2] } as const)),
	Rule([self, '`', template_literal_parts, '`'],				$ => ({ type: 'tagged_template', tag: $[0], quasi: $[2] } as const)),
	Rule([member, '?.', IDENT], 								$ => Member($[0], $[2], true)),
	Rule([self, '?.', IDENT], 									$ => Member($[0], $[2], true)),
	Rule([member, '?.', PRIVATE_NAME], 							$ => Member($[0], $[2], true)),
	Rule([self, '?.', PRIVATE_NAME], 							$ => Member($[0], $[2], true)),
	Rule([member, '?.', '[', expression, ']'], 					$ => Index($[0], $[3], true)),
	Rule([self, '?.', '[', expression, ']'], 					$ => Index($[0], $[3], true)),
	Rule([member, '?.', arguments_], 							$ => Call($[0], $[2], true)),
	Rule([self, '?.', arguments_], 								$ => Call($[0], $[2], true)),
];
export const call_expression = Rules<Expr>(self => callChainRules(member_expression, self));
export const left_hand_side_expression = Rules(
	new_expression,
	call_expression,
);

// --- Unary / update / binary precedence chain ---
// Postfix ++/-- doesn't need its own "no line terminator before ++/--" check: WS's `lex` callback above already reclassifies that whitespace into a `;`.
const postfix_expression = Rules(
	left_hand_side_expression,
	Rule([left_hand_side_expression, '++'],	$ => UnaryPost('++', $[0])),
	Rule([left_hand_side_expression, '--'],	$ => UnaryPost('--', $[0])),
);
const unary_expression = Rules<Expr>(self => [
	postfix_expression,
	Rule([UNARY_OP, self], 			$ => Unary($[0], $[1])),
	// `await` binds exactly like a prefix unary, but it suspends rather than computing -- its own node,
	// alongside `yield`, so no consumer has to peel it back out of the unary path.
	Rule(['await', self], 			$ => Await($[1])),
]);

// Right-associative: 2 ** 3 ** 2 === 2 ** (3 ** 2). Spelled as a dedicated self-recursion on the right (rather than binaryChain's left-recursion)
// since right-associativity needs the recursive reference on the other side.
const exponentiation_expression		= Rules<Expr>(self => [
	unary_expression,
	WithPrec(Rule([unary_expression, '**', self], $ => Binary('**', $[0], $[2])), 'exponentiation'),
]);

const multiplicative_expression		= binaryChain(exponentiation_expression,	['*', '/', '%'], 							'multiplicative');
const additive_expression			= binaryChain(multiplicative_expression,	['+', '-'], 								'additive');
const shift_expression				= binaryChain(additive_expression,			['<<', '>>', '>>>'], 						'shift');

export const relational_expression	= binaryChain(shift_expression,				['<', '>', '<=', '>=', 'instanceof', 'in'], 'relational');
// The ergonomic private-field brand check (`#x in obj`) -- a bare `#name` is otherwise never a valid
// expression on its own in real JS, only ever as this one operator's left operand, so this doesn't widen
// `primary_expression`/`member_expression` at all, just gives `relational_expression` its own direct
// alternative at the same precedence tier `binaryChain` already built the rest of the chain at.
relational_expression.push(
	WithPrec(Rule([PRIVATE_NAME, 'in', shift_expression], $ => Binary('in', Identifier($[0]), $[2])), 'relational'),
);
const equality_expression			= binaryChain(relational_expression,		['==', '!=', '===', '!=='], 				'equality');
const bitwise_and_expression		= binaryChain(equality_expression,			['&'], 										'bitwiseAnd');
const bitwise_xor_expression		= binaryChain(bitwise_and_expression,		['^'], 										'bitwiseXor');
const bitwise_or_expression			= binaryChain(bitwise_xor_expression,		['|'], 										'bitwiseOr');
const logical_and_expression		= binaryChain(bitwise_or_expression,		['&&'], 									'logicalAnd');
const logical_or_expression			= binaryChain(logical_and_expression,		['||'], 									'logicalOr');

export const relational_expression_noin	= binaryChain(shift_expression,				['<', '>', '<=', '>=', 'instanceof'], 		'relational');
const equality_expression_noin		= binaryChain(relational_expression_noin,	['==', '!=', '===', '!=='], 				'equality');
const bitwise_and_expression_noin	= binaryChain(equality_expression_noin,		['&'], 										'bitwiseAnd');
const bitwise_xor_expression_noin	= binaryChain(bitwise_and_expression_noin,	['^'], 										'bitwiseXor');
const bitwise_or_expression_noin	= binaryChain(bitwise_xor_expression_noin,	['|'], 										'bitwiseOr');
const logical_and_expression_noin	= binaryChain(bitwise_or_expression_noin,	['&&'], 									'logicalAnd');
const logical_or_expression_noin	= binaryChain(logical_and_expression_noin,	['||'], 									'logicalOr');

const nullish_expression			= binaryChain(logical_or_expression,		['??'], 									'nullish');
const nullish_expression_noin		= binaryChain(logical_or_expression_noin,	['??'], 									'nullish');

const conditional_expression = Rules(
	nullish_expression,
	Rule([nullish_expression, '?', fwd_assignment_expression, ':', fwd_assignment_expression], $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] } as const)),
);
const conditional_expression_noin = Rules(
	nullish_expression_noin,
	Rule([nullish_expression_noin, '?', fwd_assignment_expression, ':', Forward<Expr>(()=>assignment_expression_noin)], $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] } as const)),
);

// The concise (non-block) form must not start with `{`: real JS always treats `x => { ... }` as a block, never an implicit object-literal return.
// `_nobrace` avoids the resulting ambiguity with a bare object-literal expression body, same technique `expression_statement` uses.
export const arrow_body = Rules<Expr | Stmt<any>[]>(
	Rule(['{', function_body, '}'], 											$ => $[1]),
	Forward<Expr>(() => assignment_expression_nobrace),
);
// A plain, untyped `(a, b)` is genuinely ambiguous between this rule's own `expression`-then-reinterpret path and
// `parameter_clause`'s direct one -- both parse it, and GLR's default merge (no explicit winner) would otherwise
// keep *both* as a 2-element array instead of one `Arrow`. `WithMerge`, on all three overlapping alternatives (so
// it applies whichever side the fork happens to process second): arbitrarily keep the earlier-registered candidate
// -- safe because the two are only ever ambiguous when they'd produce an equivalent, untyped param list anyway
// (typed/destructured/defaulted params only ever parse via one side or the other, never both, so never fork here).
export const sync_arrow_function = Rules(
	Rule([IDENT, '=>', arrow_body], 											$ => Arrow(Params([{key: $[0]}]), $[2])),
	Rule(['(', expression, ')', '=>', arrow_body], 								$ => Arrow(Params(exprToParams($[1])), $[4])),
	Rule(['(', expression, ',', '...', binding_name, ')', '=>', arrow_body], 	$ => Arrow(Params(exprToParams($[1]), $[4]), $[7])),
	Rule([parameter_clause, '=>', arrow_body], 									$ => Arrow($[0], $[2])),
);

export const arrow_function = Rules(
	sync_arrow_function,
	Rule([ASYNC, sync_arrow_function], 					$ => { const a = $[1]; return {...a, modifiers: [...(a.modifiers ?? []), 'async'] }; }),
);

const yield_expression = Rules(
	Rule(['yield'], 									_ => ({ type: 'yield' } as const)),
	Rule(['yield', fwd_assignment_expression], 			$ => ({ type: 'yield', operand: $[1] } as const)),
	Rule(['yield', '*', fwd_assignment_expression], 	$ => ({ type: 'yield', operand: $[2], delegate: true } as const)),
);

export const assignment_expression = Rules<Expr<any>>(self => [
	Rule([left_hand_side_expression, ASSIGN_OP, self], 	$ => assign($[1], $[0], $[2])),
	conditional_expression,
	arrow_function,
	yield_expression,
]);
export const assignment_expression_noin = Rules<Expr>(self => [
	Rule([left_hand_side_expression, ASSIGN_OP, self], 	$ => assign($[1], $[0], $[2])),
	conditional_expression_noin,
]);

const expression_noin = Rules<Expr>(self => [
	assignment_expression_noin,
	Rule([self, ',', assignment_expression_noin],		$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] }))
]);

// A second parallel chain, "NoBrace": real ECMAScript forbids `ExpressionStatement` from starting with `{`/`function`/`class` (why `({a: 1})` needs parens).
// Only the leftmost token is restricted (`a + {}` is fine), so only each chain level's left-recursive self-reference routes through NoBrace.
const primary_expression_nobrace = primaryRules();
export const member_expression_nobrace = Rules<Expr>(self => [
	primary_expression_nobrace,
	Rule([self, '.', IDENT], 							$ => Member($[0], $[2])),
	Rule([self, '.', PRIVATE_NAME], 					$ => Member($[0], $[2])),
	Rule([self, '[', expression, ']'], 					$ => Index($[0], $[2])),
	Rule(['new', member_expression, ()=>arguments_],	$ => ({ type: 'new', callee: $[1], arguments: $[2] } as const)),
]);
const new_expression_nobrace = Rules<Expr>(
	member_expression_nobrace,
	Rule(['new', new_expression], 						$ => ({ type: 'new', callee: $[1], arguments: [] } as const)),
);
export const call_expression_nobrace = Rules<Expr>(self => callChainRules(member_expression_nobrace, self));
const left_hand_side_expression_nobrace = Rules(
	new_expression_nobrace,
	call_expression_nobrace,
);
const postfix_expression_nobrace = Rules(
	left_hand_side_expression_nobrace,
	Rule([left_hand_side_expression_nobrace, '++'],		$ => UnaryPost('++', $[0])),
	Rule([left_hand_side_expression_nobrace, '--'],		$ => UnaryPost('--', $[0])),
);
const unary_expression_nobrace = Rules(
	postfix_expression_nobrace,
	Rule([UNARY_OP, unary_expression], 					$ => Unary($[0], $[1])),
	Rule(['await', unary_expression], 					$ => Await($[1])),
);
const exponentiation_expression_nobrace = Rules(
	unary_expression_nobrace,
	WithPrec(Rule([unary_expression_nobrace, '**', exponentiation_expression], $ => Binary('**', $[0], $[2])), 'exponentiation'),
);
const multiplicative_expression_nobrace		= binaryChainLeft(exponentiation_expression_nobrace,	exponentiation_expression,	['*', '/', '%'], 							'multiplicative');
const additive_expression_nobrace			= binaryChainLeft(multiplicative_expression_nobrace,	multiplicative_expression,	['+', '-'], 								'additive');
const shift_expression_nobrace				= binaryChainLeft(additive_expression_nobrace,			additive_expression,		['<<', '>>', '>>>'], 						'shift');
export const relational_expression_nobrace	= binaryChainLeft(shift_expression_nobrace,				shift_expression,			['<', '>', '<=', '>=', 'instanceof', 'in'], 'relational');
const equality_expression_nobrace			= binaryChainLeft(relational_expression_nobrace,		relational_expression,		['==', '!=', '===', '!=='], 				'equality');
const bitwise_and_expression_nobrace		= binaryChainLeft(equality_expression_nobrace,			equality_expression,		['&'], 										'bitwiseAnd');
const bitwise_xor_expression_nobrace		= binaryChainLeft(bitwise_and_expression_nobrace,		bitwise_and_expression,		['^'], 										'bitwiseXor');
const bitwise_or_expression_nobrace			= binaryChainLeft(bitwise_xor_expression_nobrace,		bitwise_xor_expression,		['|'], 										'bitwiseOr');
const logical_and_expression_nobrace		= binaryChainLeft(bitwise_or_expression_nobrace,		bitwise_or_expression,		['&&'], 									'logicalAnd');
const logical_or_expression_nobrace			= binaryChainLeft(logical_and_expression_nobrace,		logical_and_expression,		['||'], 									'logicalOr');
const nullish_expression_nobrace			= binaryChainLeft(logical_or_expression_nobrace,		logical_or_expression,		['??'], 									'nullish');
const conditional_expression_nobrace = Rules(
	nullish_expression_nobrace,
	Rule([nullish_expression_nobrace, '?', assignment_expression, ':', assignment_expression], $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] } as const)),
);
const assignment_expression_nobrace = Rules(
	Rule([left_hand_side_expression_nobrace, ASSIGN_OP, assignment_expression], $ => assign($[1], $[0], $[2])),
	conditional_expression_nobrace,
	arrow_function,
	yield_expression,
);
const expression_nobrace = Rules<Expr>(self => [
	assignment_expression_nobrace,
	Rule([self, ',', assignment_expression],					$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] } as const))
]);

// --- Classes ---

// Real TS restricts a decorator's expression to a subset of LeftHandSideExpression (identifier/member/call chains, no `new`/literals)
// -- accepting the full `left_hand_side_expression` here is deliberately permissive rather than replicating that exact restriction, matching this grammar's usual stance elsewhere.
export const decorator = Rules<Expr>(
	Rule(['@', left_hand_side_expression], $ => $[1]),
);
export const decorator_list = List(decorator);

// A class member's own name, plus optional trailing `?`/`!` -- mirrors `optional_binding_name`, wrapped (not aliased) so pushing `?`/`!` onto this
// doesn't leak into object-literal property names too. Own extension point so every consumer (methods, get/set, fields) gets it for free.
export const class_member_name = Rules<KeyMods<any>>(
	Rule([property_name_computed],	$ => ({ key: $[0] } as const)),
	// Widens the existing `class_member_name` alphabet in place, rather than adding a rule that reaches
	// `class_member_body`/`class_member` from a new position -- that shape (tried for decorators) corrupted
	// unrelated ASI recovery via LALR state-sharing (see tison_debugging_technique memory, "sixth class").
	// `key` just carries the `#`-prefixed text verbatim (`"#test"`), no separate AST shape needed for parsing.
	Rule([PRIVATE_NAME],			$ => ({ key: $[0] } as const)),
);

export const class_member_body = Rules<Method<any> | Field<any>>(
	Rule([class_member_name, parameter_clause, '{', function_body, '}'], 				$ => Method('method', $[0].key, $[1], $[3], $[0].modifiers)),
	Rule(['*', class_member_name, parameter_clause, '{', function_body, '}'], 			$ => Method('method', $[1].key, $[2], $[4], Common.mergeMods($[1].modifiers, ['generator']))),
	Rule([GET, property_name_computed, '(', ')', '{', function_body, '}'], 				$ => Method('get', $[1], {params: []}, $[5])),
	Rule([SET, property_name_computed, '(', IDENT, ')', '{', function_body, '}'], 		$ => Method('set', $[1], {params: [{key: $[3]}]}, $[6])),
	Rule([ASYNC, class_member_name, parameter_clause, '{', function_body, '}'], 		$ => Method('method', $[1].key, $[2], $[4], Common.mergeMods($[1].modifiers, ['async']))),
	Rule([ASYNC, '*', class_member_name, parameter_clause, '{', function_body, '}'],	$ => Method('method', $[2].key, $[3], $[5], Common.mergeMods($[2].modifiers, ['async', 'generator']))),
	Rule([class_member_name, ';'], 														$ => Field($[0].key, undefined, undefined, $[0].modifiers)),
	Rule([class_member_name, '=', assignment_expression, ';'], 							$ => Field($[0].key, $[2], undefined, $[0].modifiers)),
);
export const class_member = Rules<ClassMember<any>|undefined>(
	class_member_body,
	Rule(['static', '{', function_body, '}'],	$ => ({ type: 'static_block', body: $[2] } as const)),
	Rule(['static', class_member_body],			$ => { ($[1].modifiers??=[]).push('static'); return $[1]; }),
	Rule([';'],									_ => undefined),
	// Member decorators (`@dec method() {}`) are wired up near the bottom of the file (see `DECORATED_MEMBER`),
	// once `decorator_list`/`skip` both exist -- via `Manual()`, not a direct rule reaching this widely-shared
	// nonterminal from a new position (that shape corrupts unrelated ASI recovery via LALR state-sharing, see
	// tison_debugging_technique memory "sixth class").
);
export const class_body = Rules(
	Rule(['{', '}'], 							_ => []),
	Rule(['{', List(class_member), '}'], 		$ => $[1].filter(m => m !== undefined)),
);

// The nullable alternative is safe because every class rule routes through this: nothing else can shift `{` in the `class [IDENT] ...` state, so the
// ε-reduce is the state's only action, leaving the silent-default-shift trap no conflict to resolve. `typeParams`/`implements`: ts-parser.ts pushes `<T>`/`implements`.
export const class_heritage = Rules<Partial<ClassDecl<any>>>(
	Rule([],										_ => ({})),
	Rule(['extends', left_hand_side_expression],	$ => ({ superClass: $[1] } as const)),
);
export type ClassExpr<T> = Class<T> & { type: 'class' };
export const class_expression = Rules(
	Rule(['class', class_heritage, class_body], 										$ => ({ type: 'class', ...$[1], body: $[2] } as const)),
	Rule(['class', IDENT, class_heritage, class_body],									$ => ({ type: 'class', name: $[1], ...$[2], body: $[3] } as const)),
	Rule([decorator_list, Forward<ClassExpr<any>>(() => class_expression)], 			$ => ({ ...$[1], decorators: $[0] } as ClassExpr<any>)),
);
export const class_declaration = Rules<ClassDecl<any>>(
	Rule(['class', IDENT, class_heritage, class_body],									$ => ({ type: 'class_decl', name: $[1], ...$[2], body: $[3] } as const)),
	Rule([decorator_list, Forward<ClassDecl<any>>(() => class_declaration)], 			$ => ({ ...$[1], decorators: $[0] })),
);

// --- Statements ---

export const function_declaration = Rules(
	Rule(['function', IDENT, parameter_clause, '{', function_body, '}'], 				$ => FunctionDecl($[1], $[2], $[4])),
	Rule(['function', '*', IDENT, parameter_clause, '{', function_body, '}'], 			$ => FunctionDecl($[2], $[3], $[5], { modifiers: ['generator'] })),
	Rule([ASYNC, 'function', IDENT, parameter_clause, '{', function_body, '}'], 		$ => FunctionDecl($[2], $[3], $[5], { modifiers: ['async'] })),
	Rule([ASYNC, 'function', '*', IDENT, parameter_clause, '{', function_body, '}'],	$ => FunctionDecl($[3], $[4], $[6], { modifiers: ['async', 'generator'] }))
);

// Reuses `optional_binding_name` rather than its own "just IDENT" nonterminal: an identically-shaped sibling would collide via state-merging, making a
// bare `'='` here and `parameter`'s own `ASSIGN_OP` compete in the same merged state (and `'='` always wins the lexer tie-break, silently breaking typed defaults).
export const variable_declaration = Rules<Var<any>>(
	Rule([optional_binding_name], 									$ => ({ name: $[0].key, ...$[0] } as const)),
	Rule([optional_binding_name, '=', assignment_expression], 		$ => ({ name: $[0].key, ...$[0], init: $[2] } as const)),
	Rule([binding_pattern, '=', assignment_expression], 			$ => ({ name: $[0], init: $[2] } as const)),
);
const variable_declaration_list = List(variable_declaration, ',');
export const variable_declaration_noin = Rules<Var<any>>(
	Rule([optional_binding_name], 									$ => ({ name: $[0].key, ...$[0] } as const)),
	Rule([optional_binding_name, '=', assignment_expression_noin],	$ => ({ name: $[0].key, ...$[0], init: $[2] } as const)),
	Rule([binding_pattern, '=', assignment_expression_noin], 		$ => ({ name: $[0], init: $[2] } as const)),
);
const variable_declaration_list_noin = List(variable_declaration_noin, ',');

const varKeywords = OneOf(['var', 'let', 'const']);

export const variable_decl_statement = Rules(
	Rule([varKeywords, variable_declaration_list, ';'], 		$ => VarDecl($[0], ...$[1])),
);

const variable_statement = Rules(
	variable_decl_statement,
	Rule([USING, variable_declaration_list, ';'], 				$ => VarDecl('using', ...$[1])),
	Rule(['await', USING, variable_declaration_list, ';'], 		$ => VarDecl('await using', ...$[2])),
);

// Deliberately not collapsed to `'{' function_body '}'` like arrow/try/catch/finally: a statement block's `{` is reachable right after `IDENT ':'`, where a TS
// typed-arrow object-type-literal shares the state -- the empty block must stay a *shift* of `}` there, or `foo: {}` (a labelled empty block) stops parsing.
const block = Rules<Stmt<any>>(
	Rule(['{', '}'],											_ => ({ type: 'block', body: [] } as const)),
	Rule(['{', statement_list, '}'],							$ => ({ type: 'block', body: $[1] } as const)),
);

const for_init = Rules<ForInit<any>>(
	Rule([varKeywords, variable_declaration_list_noin],			$ => VarDecl($[0], ...$[1])),
	expression_noin,
);
const for_lhs = Rules<ForInit<any>>(
	Rule([varKeywords, variable_declaration_noin],				$ => VarDecl($[0], $[1])),
	Rule([varKeywords, binding_pattern],						$ => VarDecl($[0], { name: $[1] })),
	left_hand_side_expression,
);

const expression_opt = Rules(
	Rule([],			_ => undefined),
	expression,
);

const case_clause = Rules<SwitchCase<any>>(
	Rule(['case', expression, ':'], 				$ => ({ test: $[1], consequent: [] } as const)),
	Rule(['case', expression, ':', statement_list], $ => ({ test: $[1], consequent: $[3] } as const)),
	Rule(['default', ':'], 							_ => ({ consequent: [] } as const)),
	Rule(['default', ':', statement_list], 			$ => ({ consequent: $[2] } as const)),
);

export const catch_ = Rules<{ param?: BindingTarget; body: Stmt<any>[] }>(
	Rule(['catch', '(', optional_binding_name, ')', '{', function_body, '}'],	$ => ({ param: $[2].key, body: $[5] } as const)),
	// A destructured catch parameter -- no `forceFork` needed, same reasoning as `variable_declaration`'s own pattern alternative: `catch`'s `(`
	// is never also reachable as a plain expression, so there's no ambiguity to resolve.
	Rule(['catch', '(', binding_pattern, ')', '{', function_body, '}'],			$ => ({ param: $[2], body: $[5] } as const)),
	Rule(['catch', '{', function_body, '}'],									$ => ({ body: $[2] } as const)),
);
const finally_ = Rules(
	Rule(['finally', '{', function_body, '}'],	$ => $[2]),
);
const try_block = Rules(
	Rule(['try', '{', function_body, '}'],		$ => $[2]),
);

export const statement = Rules<Stmt<any>>(self => [
	block,
	variable_statement,
	Rule([';'], 								_ => ({ type: 'empty' } as const)),
	Rule([expression_nobrace, ';'],				$ => ({ type: 'expression', expression: $[0] } as const)),
	Rule([IDENT, ':', self],					$ => ({ type: 'labeled', label: $[0], body: $[2] } as const)),

	Rule(['continue', ';'],						_ => ({ type: 'continue' } as const)),
	Rule(['continue', IDENT, ';'],				$ => ({ type: 'continue', label: $[1] } as const)),
	Rule(['break', ';'],						_ => ({ type: 'break' } as const)),
	Rule(['break', IDENT, ';'],					$ => ({ type: 'break', label: $[1] } as const)),
	Rule(['return', ';'],						_ => ({ type: 'return' } as const)),
	Rule(['return', expression, ';'],			$ => ({ type: 'return', argument: $[1] } as const)),
	Rule(['with', '(', expression, ')', self],	$ => ({ type: 'with', argument: $[2], body: $[4] } as const)),
	Rule(['debugger', ';'], 					_ => ({ type: 'debugger' } as const)),

	Rule(['if', '(', expression, ')', self],											$ => ({ type: 'if', test: $[2], consequent: $[4] } as const)),
	Rule(['if', '(', expression, ')', self, 'else', self],								$ => ({ type: 'if', test: $[2], consequent: $[4], alternate: $[6] } as const)),
	Rule(['do', self, 'while', '(', expression, ')', ';'], 								$ => ({ type: 'do_while', body: $[1], test: $[4] } as const)),
	Rule(['while', '(', expression, ')', self], 										$ => ({ type: 'while', test: $[2], body: $[4] } as const)),
	Rule(['for', '(', ';', expression_opt, ';', expression_opt, ')', self], 			$ => ({ type: 'for', kind: 'normal', test: $[3], update: $[5], body: $[7] } as const)),
	Rule(['for', '(', for_init, ';', expression_opt, ';', expression_opt, ')', self],	$ => ({ type: 'for', kind: 'normal', init: $[2], test: $[4], update: $[6], body: $[8] } as const)),
	Rule(['for', '(', for_lhs, 'in', expression, ')', self], 							$ => ({ type: 'for', kind: 'in', init: $[2], right: $[4], body: $[6] } as const)),
	Rule(['for', '(', for_lhs, 'of', assignment_expression, ')', self], 				$ => ({ type: 'for', kind: 'of', init: $[2], right: $[4], body: $[6] } as const)),
	Rule(['for', 'await', '(', for_lhs, 'of', assignment_expression, ')', self], 		$ => ({ type: 'for', kind: 'of await', init: $[3], right: $[5], body: $[7] } as const)),
	Rule(['switch', '(', expression, ')', '{', '}'],									$ => ({ type: 'switch', discriminant: $[2], cases: [] } as const)),
	Rule(['switch', '(', expression, ')', '{', List(case_clause), '}'],					$ => ({ type: 'switch', discriminant: $[2], cases: $[5] } as const)),

	Rule(['throw', expression, ';'],		$ => ({ type: 'throw', argument: $[1] } as const)),
	Rule([try_block, catch_], 				$ => ({ type: 'try', body: $[0], handlers: [$[1]] } as const)),
	Rule([try_block, finally_], 			$ => ({ type: 'try', body: $[0], handlers: [], finalizer: $[1] } as const)),
	Rule([try_block, catch_, finally_], 	$ => ({ type: 'try', body: $[0], handlers: [$[1]], finalizer: $[2] } as const)),

	function_declaration,
	class_declaration,
]);

// --- Modules ---
// import/export are only reachable from `module_item`, not `statement` -- the real spec restricts them to a Program's top level.
export const import_specifier = Rules(
	Rule([IDENT], 							$ => ({ imported: $[0], local: $[0] } as const)),
	Rule([IDENT, 'as', IDENT],				$ => ({ imported: $[0], local: $[2] } as const)),
	// Arbitrary module namespace identifier names (ES2022): the external name can be any string, always
	// aliased to a real local identifier (you can't have a binding literally named e.g. `"0n"`).
	Rule([STR, 'as', IDENT],				$ => ({ imported: unquoteString($[0]), local: $[2] } as const)),
);
export const named_imports = Rules(
	Rule(['{', '}'], 										_ => []),
	Rule(['{', List(import_specifier, ',', true), '}'], 	$ => $[1]),
);

// Import attributes (`import x from "y" with { type: "json" }`, ES2025 -- supersedes the older `assert {...}` form,
// syntactically identical here so both are accepted under the same `'with'` keyword). Key is `property_name` (IDENT or STR), matching real syntax allowing either `type: "json"` or `"type": "json"`.
const import_attribute = Rules<{ key: string; value: string }>(
	Rule([property_name, ':', STR], $ => ({ key: $[0], value: unquoteString($[2]) } as const)),
);
const import_attributes = Rules<{ key: string; value: string }[]>(
	Rule(['with', '{', '}'], 									_ => []),
	Rule(['with', '{', List(import_attribute, ',', true), '}'],	$ => $[2]),
);
export const import_declaration = Rules<Stmt<any>>(
	Rule([STR, Maybe(import_attributes), ';'], 											$ => ({ type: 'import', source: unquoteString($[0]), attributes: $[1] } as const)),
	Rule([IDENT, 'from', STR, Maybe(import_attributes), ';'], 							$ => ({ type: 'import', default: $[0], source: unquoteString($[2]), attributes: $[3] } as const)),
	Rule(['*', 'as', IDENT, 'from', STR, Maybe(import_attributes), ';'], 				$ => ({ type: 'import', namespace: $[2], source: unquoteString($[4]), attributes: $[5] } as const)),
	Rule([named_imports, 'from', STR, Maybe(import_attributes), ';'], 					$ => ({ type: 'import', specifiers: $[0], source: unquoteString($[2]), attributes: $[3] } as const)),
	Rule([IDENT, ',', named_imports, 'from', STR, Maybe(import_attributes), ';'], 		$ => ({ type: 'import', default: $[0], specifiers: $[2], source: unquoteString($[4]), attributes: $[5] } as const)),
	Rule([IDENT, ',', '*', 'as', IDENT, 'from', STR, Maybe(import_attributes), ';'],	$ => ({ type: 'import', default: $[0], namespace: $[4], source: unquoteString($[6]), attributes: $[7] } as const)),
);

export const export_specifier = Rules(
	Rule([IDENT],											$ => ({ local: $[0], exported: $[0] } as const)),
	Rule([IDENT, 'as', IDENT],								$ => ({ local: $[0], exported: $[2] } as const)),
	// Same arbitrary module namespace identifier names feature as `import_specifier` above, mirrored -- here the string is the *external* (exported) name instead.
	Rule([IDENT, 'as', STR],								$ => ({ local: $[0], exported: unquoteString($[2]) } as const)),
);
export const named_exports = Rules(
	Rule(['{', '}'],										_ => []),
	Rule(['{', List(export_specifier, ',', true), '}'],		$ => $[1]),
);
export const export_declaration = Rules<Stmt<any>>(
	Rule([named_exports, ';'], 						$ => ({ type: 'export', specifiers: $[0] })),
	Rule([named_exports, 'from', STR, ';'], 		$ => ({ type: 'export', specifiers: $[0], source: unquoteString($[2]) })),
	Rule(['*', 'from', STR, ';'], 					$ => ({ type: 'export', source: unquoteString($[2]) })),
	Rule(['*', 'as', IDENT, 'from', STR, ';'], 		$ => ({ type: 'export', namespace: $[2], source: unquoteString($[4]) })),
	Rule(['default', assignment_expression, ';'], 	$ => ({ type: 'export', default: $[1] })),
	Rule(['default', function_declaration], 		$ => ({ type: 'export', default: $[1] })),
	Rule(['default', class_declaration], 			$ => ({ type: 'export', default: $[1] })),
	Rule([variable_decl_statement], 				$ => ExportDecl($[0])),
	Rule([function_declaration], 					$ => ExportDecl($[0])),
	Rule([class_declaration], 						$ => ExportDecl($[0])),
);

export const module_item = Rules(
	Rule(['import', import_declaration],			$ => $[1]),
	Rule([EXPORT_KW, export_declaration],			$ => $[1]),
	statement,
	// A bare `import(...)` *statement* (no assignment/await/chaining) specifically at module top level -- a real LALR "missing transition" not a resolvable conflict.
	// `import(...)` already works everywhere else -- this state alone, sharing its position with this array's own direct `'import' import_declaration` rule above, doesn't merge in those items.
	// Narrow fix, narrow gap: no further chaining support for a *bare* top-level `import(...)` statement specifically (real code overwhelmingly assigns/awaits/chains it, all of which already work).
	Rule(['import', ()=>arguments_, ';'],			$ => ({ type: 'expression', expression: Call(Identifier('import'), $[1]) } as const)),
	Rule([decorator_list, EXPORT_KW, export_declaration], $ => {
		const decl = $[2];
		return	decl.type === 'export_decl' && decl.declaration.type === 'class_decl' ? { ...decl, declaration: { ...decl.declaration, decorators: $[0] } }
			:	decl.type === 'export' && decl.default && typeof decl.default === 'object' && decl.default.type === 'class_decl' ? { ...decl, default: { ...decl.default, decorators: $[0] } }
			:	decl;
	}),
);

export const program = Rules<Common.Module<Stmt<any>>>(
	Rule([],										_ => ({ type: 'module', body: [] })),
	Rule([List(module_item)],						$ => ({ type: 'module', body: $[0] })),
);

// ===================================================================
//  Wire it up
// ===================================================================

// The line comment's `\n` is optional but still consumed when present, not a lookahead: an ERROR token that doesn't advance the lexer sends `recover`'s
// ASI heuristic into an infinite loop, and a lookahead version made N consecutive comment lines take exponential time (WS's own ASI peek per line).
export const skip = [WS, /\/\/[^\n]*\n?/, /\/\*[^]*?\*\//, /^#![^\n]*\n?/];

// --- Member/parameter decorators, via Manual()+parsePrefix() ---
// Both need a rule that reaches `class_member_body`/`parameter` from a new grammar position to attach to -- exactly the shape that corrupts unrelated ASI recovery via LALR state-sharing when done directly.
// `Manual()` sidesteps this: each decorated alternative below is a single, brand-new terminal in the *main* grammar that nothing else references, so it can't collide with anything
// -- its callback hand-scans the `@decorator...` prefix via a small standalone sub-parser rooted at `decorator_list`, then finishes the rest via another sub-parser rooted at the relevant
// nonterminal's own (undecorated) rules, both built once here, entirely outside the main automaton.
// See tison_manual_terminal_primitive memory for the general mechanism and how it was verified in isolation.
//
// All three are built *lazily* (on first real parse, not at module load) -- `ts-parser.ts` extends
// `decorator`/`class_member`/`parameter` (typed fields, typed params, `as`/`satisfies`, call-generics, ...)
// by pushing onto these same live arrays from its own module-level code, which only runs *after*
// `js-parser.ts` has fully finished loading. An eagerly-built sub-parser table is a permanent snapshot frozen
// at build time -- built at module load, it would silently never see any of `ts-parser.ts`'s additions, so
// every decorated member/parameter with a type annotation would fail (found via the official corpus: a
// decorated field/param with a type behaves identically to an *undecorated* one otherwise, so this was
// invisible to every earlier canary test, only surfacing once real annotated TS code hit the parser).
function lazyParser<T>(start: () => Rules<T>, skip: TermLike[]): LALRParser<T> {
	let built: LALRParser<T> | undefined;
	// `recover`/`merge` are declared later in this module (line ~1200+) but only read here inside `get`, which never runs until the first real `.parse`/`.parsePrefix` call
	// -- well after module load finishes, so the forward reference is safe. Without them, ASI silently didn't work inside e.g. a decorated class
	// member (`class C { @dec y: any }`, no trailing `;`, as the class body's last member) -- this sub-parser
	// has no recovery callback at all, so it required an explicit terminator the outer parser never needs.
	const get = () => built ??= makeParser({ start: start(), skip }, { recover, merge });
	return {
		get tables() { return get().tables; },
		parse: (input, ctx) => get().parse(input, ctx),
		parsePrefix: (input, ctx) => get().parsePrefix(input, ctx),
	};
}
const decoratorListParser = lazyParser(() => decorator_list, skip);
const parameterBaseParser = lazyParser(() => parameter.slice(), skip);

const DECORATED_PARAMETER = Manual<Param<any>>('decorated_parameter', /(?=@)/, (remaining, ctx) => {
	const d = decoratorListParser.parsePrefix(remaining, ctx);
	const m = parameterBaseParser.parsePrefix(remaining.slice(d.consumed), ctx);
	return { value: { ...m.value, decorators: d.value }, consumed: d.consumed + m.consumed };
});
parameter.push(Rule([DECORATED_PARAMETER]));

const classMemberBaseParser = lazyParser(() => class_member.slice(), skip);

const DECORATED_MEMBER = Manual<ClassMember<any> | undefined>('decorated_member', /(?=@)/, (remaining, ctx) => {
	const d = decoratorListParser.parsePrefix(remaining, ctx);
	const m = classMemberBaseParser.parsePrefix(remaining.slice(d.consumed), ctx);
	// A bare `@dec;` (decorator immediately followed by nothing, i.e. the base parse reduced the empty-statement
	// alternative to `undefined`) drops the decorators silently -- same permissive treatment `class_member`'s
	// own `';'` alternative already gives a lone semicolon, not a special diagnostic for a case real TS would
	// reject at the type-checking stage anyway, not the parser.
	return { value: m.value && { ...m.value, decorators: d.value }, consumed: d.consumed + m.consumed };
});
class_member.push(Rule([DECORATED_MEMBER]));

// Error-driven insertion: only when the real token would otherwise fail, and is preceded by a line terminator, or is `}`, or EOF.
// `lex.token` (the failing token itself), not `lex.remaining` (already past it -- a real token always
// advances the lexer before any caller sees it, so by the time recovery runs, `remaining` describes what
// comes AFTER the failing token, never the token's own text; checking it for "is `}`" never matched the
// failing token actually being `}`, only a `}` immediately following it, e.g. doubly-nested `}}`).
export const recover: RecoveryCallback = (lex, row) => {
	// `}` right here can fail two different ways: lexed successfully as `}` but not valid in this state
	// (`lex.token.name === '}'`), or `}` isn't even a candidate this state's lexer tries at all, so it comes
	// back as `$error` instead -- an ERROR token never advances the stream, so `lex.remaining` (unlike for a
	// real, already-consumed failing token) still starts with the literal `}` in that case.
	if ((lex.prev && lex.prev.pos && lex.line > lex.prev.pos.line)
		|| lex.token.name === '}'
		|| (lex.token.name === '$error' && lex.remaining.startsWith('}'))
		|| !lex.remaining
	)
		return [...row.keys()].find(t => t.name === ';');
};
export const merge: MergeValues = left => left;

export const rules = {
	binding_pattern, binding_target,
	parameter, formal_parameter_list, parameter_clause, arguments_, argument_list,
	variable_declaration, variable_declaration_noin,
	variable_statement, function_declaration,
	function_body,
	class_member_name, class_member_body, class_member, class_body, class_heritage, class_expression, class_declaration,
	statement,
	elision,
	element_list,
	array_literal,
	property_name,
	property_assignment,
	object_literal,	object_pattern_property, object_pattern_property_list, object_pattern,
	array_pattern_element, array_pattern_element_list, array_pattern,
	template_literal_part, template_literal_parts,
	arrow_body, sync_arrow_function,
	primary_expression, function_expression, member_expression, call_expression, left_hand_side_expression,
	new_expression, postfix_expression, unary_expression, exponentiation_expression, multiplicative_expression, additive_expression, shift_expression, yield_expression,
	assignment_expression, relational_expression, equality_expression, conditional_expression, expression,
	bitwise_and_expression, bitwise_xor_expression, bitwise_or_expression, logical_and_expression, logical_or_expression, nullish_expression,
	assignment_expression_noin, relational_expression_noin, equality_expression_noin, conditional_expression_noin, expression_noin,
	bitwise_and_expression_noin, bitwise_xor_expression_noin, bitwise_or_expression_noin, logical_and_expression_noin, logical_or_expression_noin, nullish_expression_noin,
	variable_declaration_list, variable_declaration_list_noin,
	statement_list, block, for_init, for_lhs, expression_opt, case_clause, catch_, finally_, try_block,
	import_specifier, named_imports, import_declaration, export_specifier, named_exports, export_declaration,
	module_item, program,
};

export function make() {
	return makeCachedParser({
		skip,
		start: program,
		// these are only needed for debugging
		rules
	}, {
		recover,
		merge,
	},
	path.join(__dirname, '../../../.tables-cache/js-parser.json.gz'));
}

export const parser = make();
export function parse(input: string) {
	return parser.parse(input);
}
