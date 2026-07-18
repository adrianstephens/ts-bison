/* eslint-disable @typescript-eslint/consistent-type-definitions */
import { makeParser, makeRule, Rules, terminal, Forward, List, OneOf, ForceFork, type GrammarSpec, type Token, WithPrec } from '../../src/tison';

// ===================================================================
//  JavaScript Parser using tison
// ===================================================================
//
// Known simplifications/omissions:
//   - private `#name` members.
//   - Dynamic `import()` and `import.meta`.
//   - 'async'/'await'/'yield'/'static'/'get'/'set'/etc. are not fully contextual only
//   - Rest in any destructuring pattern (function params, array, object) is always a bare identifier, never a nested pattern (e.g. `function f(...[a, b]) {}` doesn't parse here).

// ===================================================================
//  AST
// ===================================================================

export type unaryOps	= '++'|'--'|'delete'|'void'|'typeof'|'+'|'-'|'~'|'!'|'await';
export type binaryOps	= '+'|'-'|'*'|'/'|'%'|'**'|'&'|'|'|'^'|'<<'|'>>'|'>>>'
						| '&&'|'||'|'??'
						|'<'|'>'|'<='|'>='|'instanceof'|'in'|'=='|'!='|'==='|'!=='
						|'='|'+='|'-='|'*='|'/='|'%='|'&='|'|='|'^='|'<<='|'>>='|'>>>='
						|'&&='|'||='|'??='

export interface TemplatePart { str: string; exp?: Expr; }
export type Literal = { type: 'literal'; value: number | bigint | string | boolean | null | RegExp | TemplatePart[] }
export function Literal<T extends number | bigint | string | boolean | null | RegExp | TemplatePart[]>(value: T) { return { type: 'literal', value } as const; }

export type Key = string | { computed: Expr };

export type ObjectProperty =
	| { key: Key; value: Expr; kind: 'init' }
	| { key: Key; value: FunctionExpr; kind: 'get' | 'set' }
	| { kind: 'spread'; argument: Expr };
export function ObjectProperty(key: Key, value: Expr): ObjectProperty;
export function ObjectProperty(key: Key, value: FunctionExpr, kind: 'get' | 'set'): ObjectProperty;
export function ObjectProperty(key: Key, value: Expr, kind?: any): ObjectProperty { return { key, value, kind: kind ?? 'init' }; }

export type BindingTarget = string | ObjectPattern | ArrayPattern;

export interface ObjectPatternProperty		{ key: string; value: BindingTarget; default?: Expr; }
export interface ObjectPattern				{ type: 'object_pattern'; properties: ObjectPatternProperty[]; rest?: string; }
export function  ObjectPattern(properties: ObjectPatternProperty[], rest?: string): ObjectPattern { return { type: 'object_pattern', properties, rest }; }

export interface ArrayPatternElement		{ target: BindingTarget; default?: Expr; }
export interface ArrayPattern 				{ type: 'array_pattern'; elements: (ArrayPatternElement | undefined)[]; rest?: string; }
export function  ArrayPattern(elements: (ArrayPatternElement | undefined)[], rest?: string): ArrayPattern { return { type: 'array_pattern', elements, rest }; }

export interface Rest<T = unknown>			{ key: BindingTarget; typeAnnotation?: T; }
export function  Rest<T>(key: BindingTarget, typeAnnotation?: T): Rest<T> { return {key, typeAnnotation}; }
export interface Param<T = unknown>			{ key: BindingTarget; default?: Expr; typeAnnotation?: T; modifiers?: string[] }
export function  Param<T>(key: BindingTarget, typeAnnotation?: T, modifiers?: string[]): Param<T> { return { key, typeAnnotation, modifiers }; }
export interface Params<T = unknown>		{ params: Param<T>[]; rest?: Rest<T>; }
export interface CallSig<T = unknown, U = unknown>	extends Params<T> { typeParams?: U[]; returnType?: T; }

// `rest` deliberately never appears as a bare positional argument here (only nested inside a `Params`/`CallSig` object) -- a
// prior version accepted `(params, rest, returnType, typeParams)` too, disambiguated by sniffing whether the 2nd argument had
// a `.key` property at runtime. That's fragile for any *forwarding* call (spreading an existing signature's own `.rest`, which
// is legitimately `undefined` most of the time) -- `undefined` in that slot is indistinguishable from "this call omitted rest
// entirely", so it could silently shift `returnType`/`typeParams` by one position. Dispatch now depends only on
// `Array.isArray(args[0])` and `args.length`, never on the shape of a later argument -- to specify `rest`, construct a `Params`
// object (`{params, rest}`) as the first argument instead of passing a bare array.
export type CallSigParams<T, U> =
	|	[CallSig<T, U>]
	|	[Params<T>]
	|	[Params<T>, T|undefined]
	|	[Params<T>, T|undefined, U[]|undefined]
	|	[Param<T>[]]
	|	[Param<T>[], T|undefined]
	|	[Param<T>[], T|undefined, U[]|undefined]
export function CallSig<T, U>(...args: CallSigParams<T, U>) : CallSig<T, U> {
	if (Array.isArray(args[0]))
		return { params: args[0], returnType: args[1] as T, typeParams: args[2] as U[] };
	return args.length > 1
		? { ...args[0], returnType: args[1] as T, typeParams: args[2] as U[] }
		: args[0];
}


export interface ArrayLit { type: 'array'; elements: readonly (Expr | undefined)[] }
export function  ArrayLit(elements: readonly (Expr | undefined)[]): ArrayLit	{ return { type: 'array', elements}; }

export interface FunctionExpr<T = unknown, U = unknown> extends CallSig<T, U> { type: 'function'; name?: string; body?: Statement[]; modifiers?: string[] }
export function  FunctionExpr<T, U>(sig: CallSig<T, U>, body: Statement[], more?: Partial<FunctionExpr<T>>): FunctionExpr<T> { return { type: 'function', body, ...sig, ...more}; }

export interface Arrow<T = unknown> extends CallSig<T> { type: 'arrow'; body: Expr | Statement[]; modifiers?: string[] }
export function  Arrow<T>(sig: CallSig<T>, body: Expr | Statement[], more?: Partial<Arrow<T>>): Arrow<T> { return { body, ...sig, ...more, type: 'arrow'}; }

export interface ObjectExpr	{ type: 'object'; properties: readonly ObjectProperty[] }
export function  ObjectExpr(properties: readonly ObjectProperty[]): ObjectExpr { return {type: 'object', properties }; }

export interface Class<T = unknown, U = unknown> { name?: string; superClass?: Expr; body: ClassMember<T, U>[]; typeParams?: U[]; implementsClause?: T[]; abstract?: boolean };

export type Expr =
	| Literal
	| ArrayLit
	| FunctionExpr
	| Arrow
	| { type: 'identifier'; name: string; }
	| { type: 'unary'; operator: unaryOps; argument: Expr }
	| { type: 'unary_post'; operator: unaryOps; argument: Expr }
	| { type: 'binary'; operator: binaryOps; left: Expr; right: Expr }
	| { type: 'conditional'; test: Expr; consequent: Expr; alternate: Expr }
	| { type: 'this' }
	| ObjectExpr
	| { type: 'member'; object: Expr; property: string; optional?: boolean }
	| { type: 'index'; object: Expr; property: Expr; optional?: boolean }
	| { type: 'call'; callee: Expr; arguments: Expr[]; optional?: boolean; typeArgs?: unknown[] }
	| { type: 'new'; callee: Expr; arguments: Expr[]; typeArgs?: unknown[] }
	| { type: 'sequence'; expressions: Expr[] }
	| { type: 'spread'; argument: Expr }
	| { type: 'tagged_template'; tag: Expr; quasi: TemplatePart[] }
	| { type: 'yield'; argument?: Expr; delegate?: boolean }
	| { type: 'class'; } & Class
	| { type: 'as_expression'; expression: Expr; typeAnnotation: unknown }
	| { type: 'satisfies_expression'; expression: Expr; typeAnnotation: unknown }
	| { type: 'instantiation'; expression: Expr; typeArgs: unknown[] }


export type ClassMember0<T = unknown, U = unknown> =
	| { type: 'method'; kind?: 'get' | 'set'; key: Key; body?: Statement[], modifiers?: string[] } & CallSig<T, U>
	| { type: 'field'; key: Key; value?: Expr; modifiers?: string[]; typeAnnotation?: T; }
export type ClassMember<T = unknown, U = unknown> = ClassMember0<T, U> | { type: 'static_block'; body: Statement[] }

export interface FunctionDecl<T = unknown, U = unknown>	extends CallSig<T, U> { type: 'function_decl'; name: string; body?: Statement[]; modifiers?: string[]; ambient?: boolean };
export function  FunctionDecl<T, U>(name: string, sig: CallSig<T, U>, body?: Statement[], more?: Partial<FunctionDecl<T>>): FunctionDecl { return { type: 'function_decl', name, body, ...sig, ...more}; }

export interface ClassDecl<T = unknown, U = unknown> extends Class<T, U> { type: 'class_decl'; name: string; ambient?: boolean; }

export interface VarDeclarator<T = unknown> { name: BindingTarget; init?: Expr; typeAnnotation?: T; definite?: boolean; }
export type DeclarationKind			= 'var' | 'let' | 'const' | 'using' | 'await using';
export interface VarDecl<T = unknown>	{ type: 'var_decl'; kind: DeclarationKind; ambient?: boolean; declarations: VarDeclarator<T>[] }
export function  VarDecl<T>(kind: DeclarationKind, ...declarations: VarDeclarator<T>[]): VarDecl<T> { return { type: 'var_decl', kind, declarations }; }

export type Declaration = VarDecl | FunctionDecl | ClassDecl;

export interface ExportDecl { type: 'export_decl'; declaration: Declaration};
export function  ExportDecl(d: Declaration ): ExportDecl { return { type: 'export_decl', declaration: d }; }

export interface ImportSpecifier { imported: string; local: string; typeOnly?: boolean; }
export interface ExportSpecifier { local: string; exported: string; typeOnly?: boolean; }

export interface Import { type: 'import'; specifiers?: ImportSpecifier[]; source:  string; namespace?: string; typeOnly?: boolean; default?: string }
export interface Export { type: 'export'; specifiers?: ExportSpecifier[]; source?: string; namespace?: string; typeOnly?: boolean; default?: Expr|Declaration }

export type ForInit = Expr | VarDecl;
export interface SwitchCase { test?: Expr; consequent: Statement[]; }

export type Statement = Declaration
	| { type: 'block'; body: Statement[] }
	| { type: 'expression'; expression: Expr }
	| { type: 'empty' }
	| { type: 'if'; test: Expr; consequent: Statement; alternate?: Statement }
	| { type: 'do_while'; body: Statement; test: Expr }
	| { type: 'while'; test: Expr; body: Statement }
	| { type: 'for'; init?: ForInit; test?: Expr; update?: Expr; body: Statement }
	| { type: 'for_in'; kind: 'normal' | 'in' | 'of' | 'of await'; init: ForInit; right: Expr; body: Statement }
	| { type: 'continue'; label?: string }
	| { type: 'break'; label?: string }
	| { type: 'return'; argument?: Expr }
	| { type: 'with'; argument: Expr; body: Statement }
	| { type: 'labeled'; label: string; body: Statement }
	| { type: 'switch'; discriminant: Expr; cases: SwitchCase[] }
	| { type: 'throw'; argument: Expr }
	| { type: 'try'; block: Statement[]; handlerParam?: string; handlerBody?: Statement[]; finalizer?: Statement[] }
	| { type: 'debugger' }
	| Export
	| ExportDecl
	| Import

export interface Program { type: 'program'; body: Statement[]; }


// ===================================================================
//  terminals
// ===================================================================

export const reIDENT	= /[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/u;
export const IDENT		= terminal('identifier', reIDENT);
export const NUM		= terminal('number', /0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?|0[oO][0-7](?:_?[0-7])*n?|0[bB][01](?:_?[01])*n?|[0-9](?:_?[0-9])*n|(?:[0-9](?:_?[0-9])*\.(?:[0-9](?:_?[0-9])*)?|\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*)(?:[eE][-+]?[0-9]+)?/);
export const STR		= terminal('string', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/);

// `get`/`set`/`async` are contextual keywords, only keywords when what follows still looks like the construct.
function startsPropertyName(next: Token | undefined) {
	return next && (next.type === IDENT || next.type === STR || next.type === NUM || next.type.name === '[');
}
export const GET		= terminal('get',	/get(?!\w)/,	lex => startsPropertyName(lex.next()) ? GET : IDENT);
export const SET		= terminal('set',	/set(?!\w)/,	lex => startsPropertyName(lex.next()) ? SET : IDENT);
export const USING		= terminal('using', /using(?!\w)/,	lex => lex.next()?.type === IDENT ? USING : IDENT);
export const ASYNC		= terminal('async',	/async(?!\w)/,	lex => {
	const next = lex.next();
	return (next && (next.type.name === 'function' || next.type.name === '*' || next.type.name === '(' || next.type.name === '<')) || startsPropertyName(next) ? ASYNC : IDENT;
});

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

export interface Location { line: number, col: number };

export const Rule = makeRule<any>(<T>(t: T, $: any) =>
	typeof t === 'object' ? Object.assign(t as object, {pos: {line: $.pos.line, col: $.pos.col }}) : t
);

const ASSIGN_OP = OneOf(['+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '??=', '&&=', '||=', '=']);
const UNARY_OP	= OneOf(['await', '++', '--', 'delete', 'void', 'typeof', '+', '-', '~', '!']);


// Mirrors ECMA-262's own In/NoIn duplication above shift_expression: `for (x in y)` vs `for (x; ...)`
// would otherwise be ambiguous over whether 'in' continues a RelationalExpression or marks the for-in separator.
function binaryChain(lower: Rules<Expr>, ops: binaryOps[], prec: string) {
	return Rules<Expr>(self => [
		lower,
		WithPrec(Rule([self, OneOf(ops), lower] as const, $ =>	({ type: 'binary', operator: $[1], left: $[0], right: $[2] } as const)), prec)
	]);
}

// Same as `binaryChain`, but only the chain's own left-recursion needs to stay NoBrace-restricted.
function binaryChainLeft(lowerLeft: Rules<Expr>, lowerRight: Rules<Expr>, ops: binaryOps[], prec: string) {
	return Rules<Expr>(self => [
		lowerLeft,
		WithPrec(Rule([self, OneOf(ops), lowerRight] as const, $ => ({ type: 'binary', operator: $[1], left: $[0], right: $[2] }) as const), prec)
	]);
}

// Hand-decoded rather than round-tripped through `JSON.parse`: JSON's escape set is a strict subset of JS's, so valid JS strings like `'\0'` threw there.
export const unquoteString = (s: string) => s.slice(1, -1).replace(
	/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|\r\n|\n|(.))/g,
	(_, hex, ubrace, u4, ch) =>
		hex !== undefined ? String.fromCharCode(parseInt(hex, 16))
		: ubrace !== undefined || u4 !== undefined ? String.fromCodePoint(parseInt(ubrace ?? u4, 16))
		: ch === undefined ? ''
		: ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch === 'b' ? '\b' : ch === 'f' ? '\f' : ch === 'v' ? '\v' : ch === '0' ? '\0'
		: ch
);

const fwd_assignment_expression	= Forward<Expr>(() => assignment_expression);

const expression = Rules<Expr>(self => [
	fwd_assignment_expression,
	Rule([self, ',', fwd_assignment_expression] as const,				$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] } as const))
]);


export const statement_list = List(Forward<Statement>(() => statement));
export const function_body = Rules(
	Rule([], 			() => []),
	statement_list
);

// `elision`: a run of N commas with nothing between them, i.e. N holes. A single trailing comma after a
// real element is just a separator, not a hole -- counting only starts from the *next* comma onward.
const elision = Rules<number>(self => [
	Rule([','] as const, 		() => 1),
	Rule([self, ','] as const,	$ => $[0] + 1),
]);
const holes = (n: number) => Array<undefined>(n).fill(undefined);

// --- Destructuring binding patterns ---
// ts-parser.ts's typed-arrow extension reaches a bare `identifier` here from expression position too -- a genuine reduce-reduce ambiguity against
// `primary_expression`'s own identifier that needs `forceFork` to resolve via GLR.
export const binding_pattern = Rules<ObjectPattern | ArrayPattern>(
	Rule([Forward<ObjectPattern>(()=>object_pattern)] as const),
	Rule([Forward<ArrayPattern>(()=>array_pattern)] as const),
);
export const binding_target = Rules<BindingTarget>(
	ForceFork(Rule([IDENT] as const, $ => $[0])),
	...binding_pattern,
);

const object_pattern_property = Rules(
	Rule([IDENT] as const, 															$ => ({ key: $[0], value: $[0] } as const)),
	Rule([IDENT, '=', fwd_assignment_expression] as const, 							$ => ({ key: $[0], value: $[0], default: $[2] } as const)),
	Rule([IDENT, ':', binding_target] as const, 									$ => ({ key: $[0], value: $[2] } as const)),
	Rule([IDENT, ':', binding_target, '=', fwd_assignment_expression] as const, 	$ => ({ key: $[0], value: $[2], default: $[4] } as const)),
);
const object_pattern_property_list = List(object_pattern_property, ',', true);
export const object_pattern = Rules(
	Rule(['{', '}'] as const, 														_ => ObjectPattern([])),
	Rule(['{', object_pattern_property_list, '}'] as const, 						$ => ObjectPattern($[1])),
	Rule(['{', '...', IDENT, '}'] as const, 										$ => ObjectPattern([], $[2])),
	Rule(['{', object_pattern_property_list, ',', '...', IDENT, '}'] as const, 		$ => ObjectPattern($[1], $[4])),
);

const array_pattern_element = Rules(
	Rule([binding_target] as const, 												$ => ({ target: $[0] } as const)),
	Rule([binding_target, '=', fwd_assignment_expression] as const,					$ => ({ target: $[0], default: $[2] } as const)),
);
const array_pattern_element_list = Rules<(ArrayPatternElement | undefined)[]>(self => [
	Rule([array_pattern_element] as const,											$ => [$[0]]),
	Rule([elision, array_pattern_element] as const,									$ => [...holes($[0]), $[1]]),
	Rule([self, ',', array_pattern_element] as const,								$ => [...$[0], $[2]]),
	Rule([self, ',', elision, array_pattern_element] as const, 						$ => [...$[0], ...holes($[2]), $[3]]),
]);
export const array_pattern = Rules(
	Rule(['[', ']'] as const, 														_ => ArrayPattern([])),
	Rule(['[', elision, ']'] as const, 												$ => ArrayPattern(holes($[1]))),
	Rule(['[', array_pattern_element_list, ']'] as const, 							$ => ArrayPattern($[1])),
	Rule(['[', array_pattern_element_list, ',', ']'] as const, 						$ => ArrayPattern($[1])),
	Rule(['[', array_pattern_element_list, ',', elision, ']'] as const, 			$ => ArrayPattern([...$[1], ...holes($[3])] )),
	Rule(['[', '...', IDENT, ']'] as const, 										$ => ArrayPattern([], $[2])),
	Rule(['[', array_pattern_element_list, ',', '...', IDENT, ']'] as const, 		$ => ArrayPattern($[1], $[4])),
);

// A name in a binding position; extension point ts-parser.ts populates. A rest binding can itself be destructured
// (`function f(...[a, b]) {}` is legal JS), so `key` covers the same `BindingTarget` union as any other binding target.
export const binding_name = Rules<{ key: BindingTarget }>(
	Rule([IDENT] as const,						$ => ({ key: $[0] } as const)),
	Rule([array_pattern] as const,				$ => ({ key: $[0] } as const)),
	Rule([object_pattern] as const,				$ => ({ key: $[0] } as const)),
);

// `forceFork` on both: right after a bare identifier in a position also reachable as a plain expression, reducing here vs. `primary_expression -> identifier` is a genuine one-token ambiguity needing GLR.
export const optional_binding_name = Rules<{key: string, modifiers?: string[]}> (
	ForceFork(Rule([IDENT] as const, 			$ => ({ key: $[0] } as const))),
	ForceFork(Rule([IDENT, '?'] as const, 		$ => ({ key: $[0], modifiers: ['optional'] } as const))),
);

// Default values use `ASSIGN_OP`, not bare `'='` -- ts-parser.ts's typed-arrow rule makes this `(` reachable from plain expression position too, so a
// separate `'='` terminal would win the lexer tie-break and silently break every `(x = y)`, instead of staying a resolvable shift-reduce conflict.
export const parameter = Rules<Param>(
	optional_binding_name,
	ForceFork(Rule([optional_binding_name, '=', fwd_assignment_expression] as const,	$ => ({ ...$[0], default: $[2] } as const))),
	Rule([object_pattern] as const,											$ => ({ key: $[0] } as const)),
	Rule([object_pattern, '=', fwd_assignment_expression] as const,	$ => ({ key: $[0], default: $[2] })),
	Rule([array_pattern] as const,											$ => ({ key: $[0] } as const)),
	Rule([array_pattern, '=', fwd_assignment_expression] as const,	$ => ({ key: $[0], default: $[2] })),
);

// Hand-written, not `List`/`MaybeList` -- that combinator left the state after "formal_parameter_list ','" missing the '...'/')' continuations
// (LALR "missing transition" from state merging; see tison_debugging_technique memory). Self-contained recursion avoids the collision.
const formal_parameter_list = Rules<Param[]>(self => [
	Rule([parameter] as const,				$ => [$[0]]),
	Rule([self, ',', parameter] as const,	$ => [...$[0], $[2]]),
]);

export const parameter_clause0 = Rules<Params>(
	Rule(['(', ')'] as const, 													() => ({ params: [] } as const)),
	Rule(['(', formal_parameter_list, ')'] as const, 							$ => ({ params: $[1] } as const)),
	Rule(['(', formal_parameter_list, ',', ')'] as const, 						$ => ({ params: $[1] } as const)),
	Rule(['(', '...', binding_name, ')'] as const,								$ => ({ params: [], rest: $[2] } as const)),
	Rule(['(', formal_parameter_list, ',', '...', binding_name, ')'] as const,	$ => ({ params: $[1], rest: $[4] } as const)),
);

// extension point for typescript
export const parameter_clause = Rules<CallSig>(
	parameter_clause0
);

// --- Primary / member / call / new chain ---

const element_list = Rules<(Expr | undefined)[]>(self => [
	Rule([fwd_assignment_expression] as const, 								$ => [$[0]]),
	Rule([elision, fwd_assignment_expression] as const, 					$ => [...holes($[0]), $[1]]),
	Rule([self, ',', fwd_assignment_expression] as const, 					$ => [...$[0], $[2]]),
	Rule([self, ',', elision, fwd_assignment_expression] as const, 			$ => [...$[0], ...holes($[2]), $[3]]),
	Rule(['...', fwd_assignment_expression] as const, 						$ => [{ type: 'spread', argument: $[1] } as const]),
	Rule([elision, '...', fwd_assignment_expression] as const, 				$ => [...holes($[0]), { type: 'spread', argument: $[2] } as const]),
	Rule([self, ',', '...', fwd_assignment_expression] as const, 			$ => [...$[0], { type: 'spread', argument: $[3] } as const]),
	Rule([self, ',', elision, '...', fwd_assignment_expression] as const,	$ => [...$[0], ...holes($[2]), { type: 'spread', argument: $[4] } as const]),
]);

const array_literal = Rules(
	Rule(['[', ']'] as const, 												_ => ArrayLit([])),
	Rule(['[', elision, ']'] as const, 										$ => ArrayLit(holes($[1]))),
	Rule(['[', element_list, ']'] as const, 								$ => ArrayLit($[1])),
	Rule(['[', element_list, ',', ']'] as const, 							$ => ArrayLit($[1])),
	Rule(['[', element_list, ',', elision, ']'] as const, 					$ => ArrayLit([...$[1], ...holes($[3])])),
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
export const property_name_computed = Rules<string | { computed: Expr }>(
	property_name,
	Rule(['[', fwd_assignment_expression, ']'] as const, $ => ({ computed: $[1] } as const)),
);
export const property_assignment = Rules(
	// `IDENT ':' value` goes directly (not through `property_name`), since `property_name`'s own IDENT
	// reduction would shift/reduce-conflict with `object_pattern_property`'s `IDENT ':' binding_target`.
	Rule([IDENT, ':', fwd_assignment_expression] as const, 											$ => ObjectProperty($[0], $[2])),
	Rule([property_name_quoted, ':', fwd_assignment_expression] as const, 							$ => ObjectProperty($[0], $[2])),
	Rule([GET, property_name_computed, '(', ')', '{', function_body, '}'] as const, 				$ => ObjectProperty($[1], FunctionExpr({params: []}, $[5]), 'get')),
	Rule([SET, property_name_computed, '(', IDENT, ')', '{', function_body, '}'] as const, 			$ => ObjectProperty($[1], FunctionExpr({params: [{key: $[3]}]}, $[6]), 'set')),
	Rule([IDENT] as const, 																			$ => ObjectProperty($[0], { type: 'identifier', name: $[0] })),
	// `{x = 1}` is never valid as a *real* object literal -- accepted anyway, permissively, purely so arrow
	// parameters can be parsed as a plain object literal and reinterpreted as a pattern (`exprToBindingTarget` below).
	Rule([IDENT, '=', fwd_assignment_expression] as const, 											$ => ObjectProperty($[0], { type: 'binary', operator: '=', left: { type: 'identifier', name: $[0] }, right: $[2] })),
	Rule([property_name_computed, parameter_clause, '{', function_body, '}'] as const, 				$ => ObjectProperty($[0], FunctionExpr($[1], $[3]))),
	Rule(['*', property_name_computed, parameter_clause, '{', function_body, '}'] as const, 		$ => ObjectProperty($[1], FunctionExpr($[2], $[4], { modifiers: ['generator'] }))),
	Rule([ASYNC, property_name_computed, parameter_clause, '{', function_body, '}'] as const, 		$ => ObjectProperty($[1], FunctionExpr($[2], $[4], { modifiers: ['async'] }))),
	Rule([ASYNC, '*', property_name_computed, parameter_clause, '{', function_body, '}'] as const,	$ => ObjectProperty($[2], FunctionExpr($[3], $[5], { modifiers: ['async', 'generator'] }))),
	Rule(['[', fwd_assignment_expression, ']', ':', fwd_assignment_expression] as const, 			$ => ObjectProperty({ computed: $[1] }, $[4])),
	Rule(['...', fwd_assignment_expression] as const, 												$ => ({ kind: 'spread', argument: $[1] } as const)),
);

const object_literal = Rules(
	Rule(['{', List(property_assignment, ',', true), '}'] as const, 								$ => ObjectExpr($[1])),
	// Empty `{}` as its own direct alternative: ts-parser.ts's typed-arrow rule makes `{}` also reachable as `object_pattern`'s own `'{' '}'` in the same
	// merged state (LALR "missing transition"; see tison_debugging_technique memory). `forceFork` makes it a resolvable reduce-reduce conflict (`() => ({})`).
	ForceFork(Rule(['{', '}'] as const, 															_ => ObjectExpr([]))),
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
			const rest = last?.kind === 'spread' ? last.argument : undefined;
			if (rest && rest.type !== 'identifier')
				throw new SyntaxError('Invalid destructuring rest target');
			return {
				type: 'object_pattern',
				properties: (rest ? e.properties.slice(0, -1) : e.properties).map(p => {
					if (p.kind === 'spread')
						throw new SyntaxError('Invalid destructuring target: spread must be last');
					if (typeof p.key !== 'string')
						throw new SyntaxError('Invalid destructuring target: computed key');
					return p.value.type === 'binary'
						? { key: p.key, value: exprToBindingTarget(p.value.left), default: p.value.right }
						: { key: p.key, value: exprToBindingTarget(p.value) };
				}),
				...(rest ? { rest: rest.name } : {}),
			};
		}
		case 'array': {
			const last = e.elements[e.elements.length - 1];
			const rest = last?.type === 'spread' ? last.argument : undefined;
			if (rest && rest.type !== 'identifier')
				throw new SyntaxError('Invalid destructuring rest target');
			return {
				type: 'array_pattern',
				elements: (rest ? e.elements.slice(0, -1) : e.elements).map(el =>
					  el === undefined ? undefined
					: el.type === 'binary' ? { target: exprToBindingTarget(el.left), default: el.right }
					: { target: exprToBindingTarget(el) }
				),
				rest: rest?.name,
			};
		}
		default:
			throw new SyntaxError(`Invalid destructuring target: ${e.type}`);
	}
}
function exprToParam(e: Expr): Param {
	return	e.type === 'identifier'						? { key: e.name }
		:	e.type === 'binary' && e.operator === '='	? { key: exprToBindingTarget(e.left), default: e.right }
		:	{ key: exprToBindingTarget(e) };
}
function exprToParams(e: Expr): Param[] {
	return e.type === 'sequence' ? e.expressions.map(exprToParam) : [exprToParam(e)];
}

// A bare `$` only stops the match when starting `${` -- anywhere else (a real case that broke this once)
// it's ordinary text, same as real JS/TS.
const template_literal_part = Rules<TemplatePart>(
	Rule([/(?:[^`$\\]|\\.|\$(?!\{))*(?=\$\{)/, '${', expression, '}'] as const,	$ => ({ str: $[0], exp: $[2] })),
	Rule([/(?:[^`$\\]|\\.|\$(?!\{))*(?=`)/] as const, 								$ => ({ str: $[0] })),
);
const template_literal_parts = List(template_literal_part);

function parseNumber(text: string): Literal {
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
	Rule(['this'] as const, 					_ => ({ type: 'this' } as const)),
	Rule([IDENT] as const,						$ => ({ type: 'identifier', name: $[0] } as const)),
	Rule([NUM] as const, 						$ => parseNumber($[0])),
	Rule([STR] as const, 						$ => Literal(unquoteString($[0]))),
	Rule([REGEX_LITERAL] as const,				$ => { const m = /^\/(.*)\/([a-zA-Z]*)$/.exec($[0])!; return Literal(new RegExp(m[1], m[2])); }),
	Rule(['true'] as const, 					_ => Literal(true)),
	Rule(['false'] as const,					_ => Literal(false)),
	Rule(['null'] as const,						_ => Literal(null)),
	array_literal,
	...(objectLiteral ? [objectLiteral] : []),
	Rule(['(', expression, ')'] as const, 	$ => $[1]),
	Rule(['`', template_literal_parts, '`'],	$ => Literal($[1])),
];
export const primary_expression = primaryRules(object_literal);

export const function_expression = Rules(
	Rule(['function', parameter_clause, '{', function_body, '}'] as const, 						$ => FunctionExpr($[1], $[3])),
	Rule(['function', IDENT, parameter_clause, '{', function_body, '}'] as const, 				$ => FunctionExpr($[2], $[4], {name: $[1]})),
	Rule(['function', '*', parameter_clause, '{', function_body, '}'] as const, 				$ => FunctionExpr($[2], $[4], {modifiers: ['generator'] })),
	Rule(['function', '*', IDENT, parameter_clause, '{', function_body, '}'] as const, 			$ => FunctionExpr($[3], $[5], {name: $[2], modifiers: ['generator'] })),
	Rule([ASYNC, 'function', parameter_clause, '{', function_body, '}'] as const, 				$ => FunctionExpr($[2], $[4], {modifiers: ['async'] } as const)),
	Rule([ASYNC, 'function', IDENT, parameter_clause, '{', function_body, '}'] as const, 		$ => FunctionExpr($[3], $[5], {name: $[2], modifiers: ['async'] })),
	Rule([ASYNC, 'function', '*', parameter_clause, '{', function_body, '}'] as const, 			$ => FunctionExpr($[3], $[5], {modifiers: ['async', 'generator'] })),
	Rule([ASYNC, 'function', '*', IDENT, parameter_clause, '{', function_body, '}'] as const,	$ => FunctionExpr($[4], $[6], {name: $[3], modifiers: ['async', 'generator'] }))
);

export const member_expression = Rules<Expr>(self => [
	primary_expression,
	function_expression,
	Rule([Forward<Expr>(()=>class_expression)] as const),
	Rule([self, '.', IDENT] as const, 										$ => ({ type: 'member', object: $[0], property: $[2] } as const)),
	Rule([self, '[', expression, ']'] as const, 							$ => ({ type: 'index', object: $[0], property: $[2] } as const)),
	Rule(['new', self, ()=>arguments_] as const, 							$ => ({ type: 'new', callee: $[1], arguments: $[2] } as const)),
]);
const new_expression = Rules<Expr>(self => [
	member_expression,
	Rule(['new', self] as const, 											$ => ({ type: 'new', callee: $[1], arguments: [] } as const)),
]);
const argument_list = Rules<Expr[]>(self => [
	Rule([fwd_assignment_expression] as const, 								$ => [$[0]]),
	Rule([self, ',', fwd_assignment_expression] as const, 					$ => [...($[0]), $[2]]),
	Rule(['...', fwd_assignment_expression] as const, 						$ => [{ type: 'spread', argument: $[1] } as const]),
	Rule([self, ',', '...', fwd_assignment_expression] as const, 			$ => [...($[0]), { type: 'spread', argument: $[3] } as const]),
	Rule([self, ','] as const, 												$ => $[0]),
]);
export const arguments_ = Rules(
	Rule(['(', ')'] as const, 												() => []),
	Rule(['(', argument_list, ')'] as const, 								$ => $[1]),
);
// The full postfix-continuation set, parameterized over the member-expression chain that seeds it -- built once for the ordinary chain and once for the
// NoBrace mirror below, so they can't drift apart. Optional chaining only marks each `?.` step, doesn't enforce real short-circuiting semantics.
const callChainRules = (member: Rules<Expr>, self: () => Rules<Expr>): Rules<Expr> => [
	Rule([member, arguments_] as const, 									$ => ({ type: 'call', callee: $[0], arguments: $[1] } as const)),
	Rule([self, arguments_] as const, 										$ => ({ type: 'call', callee: $[0], arguments: $[1] } as const)),
	Rule([self, '.', IDENT] as const, 										$ => ({ type: 'member', object: $[0], property: $[2] } as const)),
	Rule([self, '[', expression, ']'] as const, 							$ => ({ type: 'index', object: $[0], property: $[2] } as const)),
	Rule([member, '`', template_literal_parts, '`'] as const, 				$ => ({ type: 'tagged_template', tag: $[0], quasi: $[2] } as const)),
	Rule([self, '`', template_literal_parts, '`'] as const,					$ => ({ type: 'tagged_template', tag: $[0], quasi: $[2] } as const)),
	Rule([member, '?.', IDENT] as const, 									$ => ({ type: 'member', object: $[0], property: $[2], optional: true } as const)),
	Rule([self, '?.', IDENT] as const, 										$ => ({ type: 'member', object: $[0], property: $[2], optional: true } as const)),
	Rule([member, '?.', '[', expression, ']'] as const, 					$ => ({ type: 'index', object: $[0], property: $[3], optional: true } as const)),
	Rule([self, '?.', '[', expression, ']'] as const, 						$ => ({ type: 'index', object: $[0], property: $[3], optional: true } as const)),
	Rule([member, '?.', arguments_] as const, 								$ => ({ type: 'call', callee: $[0], arguments: $[2], optional: true } as const)),
	Rule([self, '?.', arguments_] as const, 								$ => ({ type: 'call', callee: $[0], arguments: $[2], optional: true } as const)),
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
	Rule([left_hand_side_expression, '++'] as const,	$ => ({type: 'unary_post', operator: '++', argument: $[0]} as const)),
	Rule([left_hand_side_expression, '--'] as const,	$ => ({type: 'unary_post', operator: '--', argument: $[0]} as const)),
);
const unary_expression = Rules<Expr>(self => [
	postfix_expression,
	Rule([UNARY_OP, self] as const, 	$ => ({type: 'unary', operator: $[0], argument: $[1]} as const)),
]);

// Right-associative: 2 ** 3 ** 2 === 2 ** (3 ** 2). Spelled as a dedicated self-recursion on the right (rather than binaryChain's left-recursion)
// since right-associativity needs the recursive reference on the other side.
const exponentiation_expression		= Rules<Expr>(self => [
	unary_expression,
	WithPrec(Rule([unary_expression, '**', self] as const, $ => ({ type: 'binary', operator: '**', left: $[0], right: $[2] } as const)), 'exponentiation'),
]);

const multiplicative_expression		= binaryChain(exponentiation_expression,	['*', '/', '%'], 							'multiplicative');
const additive_expression			= binaryChain(multiplicative_expression,	['+', '-'], 								'additive');
const shift_expression				= binaryChain(additive_expression,			['<<', '>>', '>>>'], 						'shift');

export const relational_expression	= binaryChain(shift_expression,				['<', '>', '<=', '>=', 'instanceof', 'in'], 'relational');
const equality_expression			= binaryChain(relational_expression,		['==', '!=', '===', '!=='], 				'equality');
const bitwise_and_expression		= binaryChain(equality_expression,			['&'], 										'bitwiseAnd');
const bitwise_xor_expression		= binaryChain(bitwise_and_expression,		['^'], 										'bitwiseXor');
const bitwise_or_expression			= binaryChain(bitwise_xor_expression,		['|'], 										'bitwiseOr');
const logical_and_expression		= binaryChain(bitwise_or_expression,		['&&'], 									'logicalAnd');
const logical_or_expression			= binaryChain(logical_and_expression,		['||'], 									'logicalOr');

const relational_expression_noin	= binaryChain(shift_expression,				['<', '>', '<=', '>=', 'instanceof'], 		'relational');
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
	Rule([nullish_expression, '?', fwd_assignment_expression, ':', fwd_assignment_expression] as const, $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] } as const)),
);
const conditional_expression_noin = Rules(
	nullish_expression_noin,
	Rule([nullish_expression_noin, '?', fwd_assignment_expression, ':', Forward<Expr>(()=>assignment_expression_noin)] as const, $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] } as const)),
);

// The concise (non-block) form must not start with `{`: real JS always treats `x => { ... }` as a block, never an implicit object-literal return.
// `_nobrace` avoids the resulting ambiguity with a bare object-literal expression body, same technique `expression_statement` uses.
export const arrow_body = Rules<Expr | Statement[]>(
	Rule(['{', function_body, '}'] as const, 					$ => $[1]),
	Forward<Expr>(() => assignment_expression_nobrace),
);
export const sync_arrow_function = Rules(
	Rule([IDENT, '=>', arrow_body] as const, 												$ => Arrow({params: [{key: $[0]}]}, $[2])),
	Rule(['(', expression, ')', '=>', arrow_body] as const, 							$ => Arrow({params: exprToParams($[1])}, $[4])),
	Rule(['(', expression, ',', '...', binding_name, ')', '=>', arrow_body] as const, 	$ => Arrow({params: exprToParams($[1]), rest: $[4]}, $[7])),
	Rule([parameter_clause, '=>', arrow_body] as const, 									$ => Arrow($[0], $[2])),
);

export const arrow_function = Rules(
	sync_arrow_function,
	Rule([ASYNC, sync_arrow_function] as const, 					$ => { const a = $[1] as Arrow; return {...a, modifiers: [...(a.modifiers ?? []), 'async'] }; }),
);

const yield_expression = Rules(
	Rule(['yield'] as const, 										_ => ({ type: 'yield' } as const)),
	Rule(['yield', fwd_assignment_expression] as const, 			$ => ({ type: 'yield', argument: $[1] } as const)),
	Rule(['yield', '*', fwd_assignment_expression] as const, 		$ => ({ type: 'yield', argument: $[2], delegate: true } as const)),
);

export const assignment_expression = Rules<Expr>(self => [
	Rule([left_hand_side_expression, ASSIGN_OP, self] as const, 	$ => ({ type: 'binary', operator: $[1], left: $[0], right: $[2] } as const)),
	conditional_expression,
	arrow_function,
	yield_expression,
]);
export const assignment_expression_noin = Rules<Expr>(self => [
	Rule([left_hand_side_expression, ASSIGN_OP, self] as const, 	$ => ({ type: 'binary', operator: $[1], left: $[0], right: $[2] } as const)),
	conditional_expression_noin,
]);

//const expression = RRules<Expr>(self => [
//	assignment_expression,
//	Rule([self, ',', assignment_expression] as const,				$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] } as const))
//]);
const expression_noin = Rules<Expr>(self => [
	assignment_expression_noin,
	Rule([self, ',', assignment_expression_noin] as const,			$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] }))
]);

// A second parallel chain, "NoBrace": real ECMAScript forbids `ExpressionStatement` from starting with `{`/`function`/`class` (why `({a: 1})` needs parens).
// Only the leftmost token is restricted (`a + {}` is fine), so only each chain level's left-recursive self-reference routes through NoBrace.
const primary_expression_nobrace = primaryRules();
export const member_expression_nobrace = Rules<Expr>(self => [
	primary_expression_nobrace,
	Rule([self, '.', IDENT] as const, 								$ => ({ type: 'member', object: $[0], property: $[2] } as const)),
	Rule([self, '[', expression, ']'] as const, 				$ => ({ type: 'index', object: $[0], property: $[2] } as const)),
	Rule(['new', member_expression, ()=>arguments_] as const, 		$ => ({ type: 'new', callee: $[1], arguments: $[2] } as const)),
]);
const new_expression_nobrace = Rules<Expr>(
	member_expression_nobrace,
	Rule(['new', new_expression] as const, 							$ => ({ type: 'new', callee: $[1], arguments: [] } as const)),
);
export const call_expression_nobrace = Rules<Expr>(self => callChainRules(member_expression_nobrace, self));
const left_hand_side_expression_nobrace = Rules(
	new_expression_nobrace,
	call_expression_nobrace,
);
const postfix_expression_nobrace = Rules(
	left_hand_side_expression_nobrace,
	Rule([left_hand_side_expression_nobrace, '++'] as const,	$ => ({type: 'unary_post', operator: '++', argument: $[0]} as const)),
	Rule([left_hand_side_expression_nobrace, '--'] as const,	$ => ({type: 'unary_post', operator: '--', argument: $[0]} as const)),
);
const unary_expression_nobrace = Rules(
	postfix_expression_nobrace,
	Rule([UNARY_OP, unary_expression] as const, 	$ => ({type: 'unary', operator: $[0], argument: $[1]} as const)),
);
const exponentiation_expression_nobrace = Rules(
	unary_expression_nobrace,
	WithPrec(Rule([unary_expression_nobrace, '**', exponentiation_expression] as const, $ => ({ type: 'binary', operator: '**', left: $[0], right: $[2] } as const)), 'exponentiation'),
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
	Rule([nullish_expression_nobrace, '?', fwd_assignment_expression, ':', fwd_assignment_expression] as const, $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] } as const)),
);
const assignment_expression_nobrace = Rules(
	Rule([left_hand_side_expression_nobrace, ASSIGN_OP, fwd_assignment_expression] as const, $ => ({ type: 'binary', operator: $[1], left: $[0], right: $[2] } as const)),
	conditional_expression_nobrace,
	arrow_function,
	yield_expression,
);
const expression_nobrace = Rules<Expr>(self => [
	assignment_expression_nobrace,
	Rule([self, ',', assignment_expression] as const,					$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] } as const))
]);

// --- Classes ---
// Static initialization blocks and private (`#name`) members aren't supported -- a known simplification.

// A class member's own name, plus optional trailing `?`/`!` -- mirrors `optional_binding_name`, wrapped (not aliased) so pushing `?`/`!` onto this
// doesn't leak into object-literal property names too. Own extension point so every consumer (methods, get/set, fields) gets it for free.
export const class_member_name = Rules(
	Rule([property_name_computed] as const, $ => ({ key: $[0] } as const)),
);

export const class_member_body = Rules<ClassMember0>(
	Rule([class_member_name, parameter_clause, '{', function_body, '}'] as const, 				$ => ({ type: 'method', ...$[0], ...$[1], body:	$[3] } as const)),
	Rule(['*', class_member_name, parameter_clause, '{', function_body, '}'] as const, 			$ => ({ type: 'method', ...$[1], ...$[2], body: $[4], modifiers: ['generator']} as const)),
	Rule([GET, property_name_computed, '(', ')', '{', function_body, '}'] as const, 			$ => ({ type: 'method', kind: 'get', key: $[1], params: [], body:$[5] } as const)),
	Rule([SET, property_name_computed, '(', IDENT, ')', '{', function_body, '}'] as const, 		$ => ({ type: 'method', kind: 'set', key: $[1], params: [{key: $[3]}], body: $[6] } as const)),
	Rule([ASYNC, class_member_name, parameter_clause, '{', function_body, '}'] as const, 		$ => ({ type: 'method', ...$[1], ...$[2], body: $[4], modifiers: ['async'] } as const)),
	Rule([ASYNC, '*', class_member_name, parameter_clause, '{', function_body, '}'] as const,	$ => ({ type: 'method', ...$[2], ...$[3], body: $[5], modifiers: ['async', 'generator'] } as const)),
	Rule([class_member_name, ';'] as const, 													$ => ({ type: 'field', ...$[0] } as const)),
	Rule([class_member_name, '=', assignment_expression, ';'] as const, 						$ => ({ type: 'field', ...$[0], value: $[2] } as const)),
);
export const class_member = Rules<ClassMember|undefined>(
	class_member_body,
	Rule(['static', '{', function_body, '}'] as const,	$ => ({ type: 'static_block', body: $[2] } as const)),
	Rule(['static', class_member_body] as const,		$ => { ($[1].modifiers??=[]).push('static'); return $[1]; }),
	Rule([';'] as const,								() => undefined),
);
export const class_body = Rules(
	Rule(['{', '}'] as const, 							() => []),
	Rule(['{', List(class_member), '}'] as const, 		$ => $[1].filter(m => m !== undefined)),
);

// The nullable alternative is safe because every class rule routes through this: nothing else can shift `{` in the `class [IDENT] ...` state, so the
// ε-reduce is the state's only action, leaving the silent-default-shift trap no conflict to resolve. `typeParams`/`implementsClause`: ts-parser.ts pushes `<T>`/`implements`.
export const class_heritage = Rules<Partial<ClassDecl>>(
	Rule([] as const,										() => ({})),
	Rule(['extends', left_hand_side_expression] as const,	$ => ({ superClass: $[1] } as const)),
);
export const class_expression = Rules(
	Rule(['class', class_heritage, class_body] as const, 		$ => ({ type: 'class', ...$[1], body: $[2] } as const)),
	Rule(['class', IDENT, class_heritage, class_body] as const, $ => ({ type: 'class', name: $[1], ...$[2], body: $[3] } as const)),
);
export const class_declaration = Rules(
	Rule(['class', IDENT, class_heritage, class_body] as const, $ => ({ type: 'class_decl', name: $[1], ...$[2], body: $[3] } as const)),
);

// --- Statements ---

export const function_declaration = Rules(
	Rule(['function', IDENT, parameter_clause, '{', function_body, '}'] as const, 				$ => FunctionDecl($[1], $[2], $[4])),
	Rule(['function', '*', IDENT, parameter_clause, '{', function_body, '}'] as const, 			$ => FunctionDecl($[2], $[3], $[5], { modifiers: ['generator'] })),
	Rule([ASYNC, 'function', IDENT, parameter_clause, '{', function_body, '}'] as const, 		$ => FunctionDecl($[2], $[3], $[5], { modifiers: ['async'] })),
	Rule([ASYNC, 'function', '*', IDENT, parameter_clause, '{', function_body, '}'] as const,	$ => FunctionDecl($[3], $[4], $[6], { modifiers: ['async', 'generator'] }))
);

// Reuses `optional_binding_name` rather than its own "just IDENT" nonterminal: an identically-shaped sibling would collide via state-merging, making a
// bare `'='` here and `parameter`'s own `ASSIGN_OP` compete in the same merged state (and `'='` always wins the lexer tie-break, silently breaking typed defaults).
export const variable_declaration = Rules<VarDeclarator>(
	Rule([optional_binding_name] as const, 											$ => ({ name: $[0].key, ...$[0] } as const)),
	Rule([optional_binding_name, '=', assignment_expression] as const, 		$ => ({ name: $[0].key, ...$[0], init: $[2] } as const)),
	Rule([binding_pattern, '=', assignment_expression] as const, 					$ => ({ name: $[0], init: $[2] } as const)),
);
const variable_declaration_list = List(variable_declaration, ',');
export const variable_declaration_noin = Rules<VarDeclarator>(
	Rule([optional_binding_name] as const, 											$ => ({ name: $[0].key, ...$[0] } as const)),
	Rule([optional_binding_name, '=', assignment_expression_noin] as const,	$ => ({ name: $[0].key, ...$[0], init: $[2] } as const)),
	Rule([binding_pattern, '=', assignment_expression_noin] as const, 				$ => ({ name: $[0], init: $[2] } as const)),
);
const variable_declaration_list_noin = List(variable_declaration_noin, ',');

const varKeywords = OneOf(['var', 'let', 'const']);

export const variable_decl_statement = Rules(
	Rule([varKeywords, variable_declaration_list, ';'] as const, 		$ => VarDecl($[0], ...$[1])),
);

const variable_statement = Rules(
	variable_decl_statement,
	Rule([USING, variable_declaration_list, ';'] as const, 				$ => VarDecl('using', ...$[1])),
	Rule(['await', USING, variable_declaration_list, ';'] as const, 	$ => VarDecl('await using', ...$[2])),
);

// Deliberately not collapsed to `'{' function_body '}'` like arrow/try/catch/finally: a statement block's `{` is reachable right after `IDENT ':'`, where a TS
// typed-arrow object-type-literal shares the state -- the empty block must stay a *shift* of `}` there, or `foo: {}` (a labelled empty block) stops parsing.
const block = Rules<Statement>(
	Rule(['{', '}'] as const,											() => ({ type: 'block', body: [] } as const)),
	Rule(['{', statement_list, '}'] as const,							$ => ({ type: 'block', body: $[1] } as const)),
);

const for_init = Rules<ForInit>(
	Rule([varKeywords, variable_declaration_list_noin] as const,		$ => VarDecl($[0], ...$[1])),
	expression_noin,
);
const for_lhs = Rules<ForInit>(
	Rule([varKeywords, variable_declaration_noin] as const,				$ => VarDecl($[0], $[1])),
	Rule([varKeywords, binding_pattern] as const,						$ => VarDecl($[0], { name: $[1] })),
	left_hand_side_expression,
);

const expression_opt = Rules(
	Rule([] as const,			() => undefined),
	expression,
);

const case_clause = Rules<SwitchCase>(
	Rule(['case', expression, ':'] as const, 					$ => ({ test: $[1], consequent: [] } as const)),
	Rule(['case', expression, ':', statement_list] as const, 	$ => ({ test: $[1], consequent: $[3] } as const)),
	Rule(['default', ':'] as const, 							() => ({ consequent: [] } as const)),
	Rule(['default', ':', statement_list] as const, 			$ => ({ consequent: $[2] } as const)),
);

export const catch_ = Rules<{ param?: string; body: Statement[] }>(
	Rule(['catch', '(', optional_binding_name, ')', '{', function_body, '}'] as const,	$ => ({ param: $[2].key, body: $[5] } as const)),
	Rule(['catch', '{', function_body, '}'] as const,									$ => ({ body: $[2] } as const)),
);
const finally_ = Rules(
	Rule(['finally', '{', function_body, '}'] as const,	$ => $[2]),
);
const try_block = Rules(
	Rule(['try', '{', function_body, '}'] as const,		$ => $[2]),
);

export const statement = Rules<Statement>(self => [
	block,
	variable_statement,
	Rule([';'] as const, 								_ => ({ type: 'empty' } as const)),
	Rule([expression_nobrace, ';'] as const,			$ => ({ type: 'expression', expression: $[0] } as const)),
	Rule([IDENT, ':', self] as const,					$ => ({ type: 'labeled', label: $[0], body: $[2] } as const)),

	Rule(['continue', ';'] as const,					_ => ({ type: 'continue' } as const)),
	Rule(['continue', IDENT, ';'] as const,				$ => ({ type: 'continue', label: $[1] } as const)),
	Rule(['break', ';'] as const,						_ => ({ type: 'break' } as const)),
	Rule(['break', IDENT, ';'] as const,				$ => ({ type: 'break', label: $[1] } as const)),
	Rule(['return', ';'] as const,						_ => ({ type: 'return' } as const)),
	Rule(['return', expression, ';'] as const,			$ => ({ type: 'return', argument: $[1] } as const)),
	Rule(['with', '(', expression, ')', self] as const,	$ => ({ type: 'with', argument: $[2], body: $[4] } as const)),
	Rule(['debugger', ';'] as const, 					_ => ({ type: 'debugger' } as const)),

	Rule(['if', '(', expression, ')', self] as const,											$ => ({ type: 'if', test: $[2], consequent: $[4] } as const)),
	Rule(['if', '(', expression, ')', self, 'else', self] as const,								$ => ({ type: 'if', test: $[2], consequent: $[4], alternate: $[6] } as const)),
	Rule(['do', self, 'while', '(', expression, ')', ';'] as const, 							$ => ({ type: 'do_while', body: $[1], test: $[4] } as const)),
	Rule(['while', '(', expression, ')', self] as const, 										$ => ({ type: 'while', test: $[2], body: $[4] } as const)),
	Rule(['for', '(', ';', expression_opt, ';', expression_opt, ')', self] as const, 			$ => ({ type: 'for', test: $[3], update: $[5], body: $[7] } as const)),
	Rule(['for', '(', for_init, ';', expression_opt, ';', expression_opt, ')', self] as const,	$ => ({ type: 'for', init: $[2], test: $[4], update: $[6], body: $[8] } as const)),
	Rule(['for', '(', for_lhs, 'in', expression, ')', self] as const, 							$ => ({ type: 'for_in', kind: 'in', init: $[2], right: $[4], body: $[6] } as const)),
	Rule(['for', '(', for_lhs, 'of', assignment_expression, ')', self] as const, 				$ => ({ type: 'for_in', kind: 'of', init: $[2], right: $[4], body: $[6] } as const)),
	Rule(['for', 'await', '(', for_lhs, 'of', assignment_expression, ')', self] as const, 		$ => ({ type: 'for_in', kind: 'of await', init: $[3], right: $[5], body: $[7] } as const)),
	Rule(['switch', '(', expression, ')', '{', '}'] as const,									$ => ({ type: 'switch', discriminant: $[2], cases: [] } as const)),
	Rule(['switch', '(', expression, ')', '{', List(case_clause), '}'] as const,				$ => ({ type: 'switch', discriminant: $[2], cases: $[5] } as const)),

	Rule(['throw', expression, ';'] as const,		$ => ({ type: 'throw', argument: $[1] } as const)),
	Rule([try_block, catch_] as const, 				$ => ({ type: 'try', block: $[0], handlerParam: $[1].param, handlerBody: $[1].body } as const)),
	Rule([try_block, finally_] as const, 			$ => ({ type: 'try', block: $[0], finalizer: $[1] } as const)),
	Rule([try_block, catch_, finally_] as const, 	$ => ({ type: 'try', block: $[0], handlerParam: $[1].param, handlerBody: $[1].body, finalizer: $[2] } as const)),

	function_declaration,
	class_declaration,
]);

// --- Modules ---
// import/export are only reachable from `module_item`, not `statement` -- the real spec restricts them to a Program's top level.
export const import_specifier = Rules(
	Rule([IDENT] as const, 							$ => ({ imported: $[0], local: $[0] } as const)),
	Rule([IDENT, 'as', IDENT] as const,				$ => ({ imported: $[0], local: $[2] } as const)),
);
export const named_imports = Rules(
	Rule(['{', '}'] as const, 											() => []),
	Rule(['{', List(import_specifier, ',', true), '}'] as const, 		$ => $[1]),
);
export const import_declaration = Rules<Statement>(
	Rule([STR, ';'] as const, 											$ => ({ type: 'import', source: unquoteString($[0]) } as const)),
	Rule([IDENT, 'from', STR, ';'] as const, 							$ => ({ type: 'import', default: $[0], source: unquoteString($[2]) } as const)),
	Rule(['*', 'as', IDENT, 'from', STR, ';'] as const, 				$ => ({ type: 'import', namespace: $[2], source: unquoteString($[4]) } as const)),
	Rule([named_imports, 'from', STR, ';'] as const, 					$ => ({ type: 'import', specifiers: $[0], source: unquoteString($[2]) } as const)),
	Rule([IDENT, ',', named_imports, 'from', STR, ';'] as const, 		$ => ({ type: 'import', default: $[0], specifiers: $[2], source: unquoteString($[4]) } as const)),
	Rule([IDENT, ',', '*', 'as', IDENT, 'from', STR, ';'] as const,		$ => ({ type: 'import', default: $[0], namespace: $[4], source: unquoteString($[6]) } as const)),
);

export const export_specifier = Rules(
	Rule([IDENT] as const,												$ => ({ local: $[0], exported: $[0] } as const)),
	Rule([IDENT, 'as', IDENT] as const,									$ => ({ local: $[0], exported: $[2] } as const)),
);
export const named_exports = Rules(
	Rule(['{', '}'] as const,											() => []),
	Rule(['{', List(export_specifier, ',', true), '}'] as const,		$ => $[1]),
);
export const export_declaration = Rules<Statement>(
	Rule([named_exports, ';'] as const, 					$ => ({ type: 'export', specifiers: $[0] })),
	Rule([named_exports, 'from', STR, ';'] as const, 		$ => ({ type: 'export', specifiers: $[0], source: unquoteString($[2]) })),
	Rule(['*', 'from', STR, ';'] as const, 					$ => ({ type: 'export', source: unquoteString($[2]) })),
	Rule(['*', 'as', IDENT, 'from', STR, ';'] as const, 	$ => ({ type: 'export', namespace: $[2], source: unquoteString($[4]) })),
	Rule(['default', assignment_expression, ';'] as const, 	$ => ({ type: 'export', default: $[1] })),
	Rule(['default', function_declaration] as const, 		$ => ({ type: 'export', default: $[1] })),
	Rule(['default', class_declaration] as const, 			$ => ({ type: 'export', default: $[1] })),
	Rule([variable_decl_statement] as const, 				$ => ExportDecl($[0])),
	Rule([function_declaration] as const, 					$ => ExportDecl($[0])),
	Rule([class_declaration] as const, 						$ => ExportDecl($[0])),
);

export const module_item = Rules(
	Rule(['import', import_declaration] as const,	$ => $[1]),
	Rule(['export', export_declaration] as const,	$ => $[1]),
	statement,
);

export const program = Rules<Program>(
	Rule([],									_ => ({ type: 'program', body: [] })),
	Rule([List(module_item)],					$ => ({ type: 'program', body: $[0] })),
);

// ===================================================================
//  Wire it up
// ===================================================================

// The line comment's `\n` is optional but still consumed when present, not a lookahead: an ERROR token that doesn't advance the lexer sends `recover`'s
// ASI heuristic into an infinite loop, and a lookahead version made N consecutive comment lines take exponential time (WS's own ASI peek per line).
export const skip = [WS, /\/\/[^\n]*\n?/, /\/\*[^]*?\*\//, /^#![^\n]*\n?/];

// Error-driven insertion: only when the real token would otherwise fail, and is preceded by a line terminator, or is `}`, or EOF.
export const recover: GrammarSpec['recover'] = (lex, row) => {
	if (!((lex.prev && lex.prev.pos && lex.line > lex.prev.pos.line) || lex.remaining.startsWith('}') || !lex.remaining))
		return undefined;
	return [...row.keys()].find(t => t.name === ';');
};

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

export const parser = makeParser({
	skip,
	recover,
	start: program,
	// these are only needed for debugging
	rules
});
