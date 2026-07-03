import { makeParser, Rule, RuleR, WithPrec, Rules, RRules, terminal, Forward, List, OneOf, type GrammarSpec } from '../src/tison';

// ===================================================================
//  JavaScript Parser using tison
// ===================================================================
//
// Known simplifications/omissions:
//   - Class static initialization blocks (`static { ... }`) and private `#name` members.
//   - `&&=`/`||=`/`??=` (logical assignment operators).
//   - Dynamic `import()` and `import.meta`.
//   - 'async'/'await'/'yield'/'static'/'get'/'set'/etc. are not fully contextual only
//   - Rest in any destructuring pattern (function params, array, object) is always a bare
//     identifier, never a nested pattern (e.g. `function f(...[a, b]) {}` doesn't parse here).

// --- Terminals ---

export const IDENT		= terminal('identifier', /[a-zA-Z_$][a-zA-Z0-9_$]*/);
export const NUMBER		= terminal('number', /0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?|0[oO][0-7](?:_?[0-7])*n?|0[bB][01](?:_?[01])*n?|[0-9](?:_?[0-9])*n|(?:[0-9](?:_?[0-9])*\.(?:[0-9](?:_?[0-9])*)?|\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*)(?:[eE][-+]?[0-9]+)?/);
export const STRING		= terminal('string', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/);
const ASSIGN_OP		= /(?:>>>|<<|>>|[+\-*/%&^|])?=/;

// Automatic Semicolon Insertion
// Restricted productions: reclassify a run of whitespace into a semicolon (unconditionally -- even though the real token would otherwise have parsed fine) when it contains a line terminator right after return/throw/break/continue, or right before postfix ++/--.
const RESTRICTED_AFTER	= new Set(['return', 'throw', 'break', 'continue', 'yield']);
const RESTRICTED_BEFORE = new Set(['++', '--']);
const WS = terminal('ws',
	/\s+/,
	lex => {
		if (lex.match.includes('\n')) {
			if (lex.prev && RESTRICTED_AFTER.has(lex.prev.type.name))
				return ';';
			const next = lex.next();
			if (next ? RESTRICTED_BEFORE.has(next.type.name) : lex.remaining.startsWith('--') || lex.remaining.startsWith('++'))
				return ';';
		}
		return WS;
	}
);

// A '/' starts a regex literal unless the previous token could it296 end an expression (identifier, number, string, ')', ']', '++', '--', or a literal keyword-value) -- in which case '/' has to be division.
const regexDisallowedAfter = new Set([
	IDENT.name, NUMBER.name, STRING.name,
	')', ']', '++', '--', 'this', 'true', 'false', 'null'
]);

const REGEX_LITERAL = terminal('regex',
	/\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-zA-Z]*/,
	lex => (!lex.prev || !regexDisallowedAfter.has(lex.prev.type.name)) ? REGEX_LITERAL : undefined
);


export const VAR_KEYWORDS = ['var', 'let', 'const'];

// --- AST types ---

export interface Identifier	{ type: 'identifier'; name: string; }
export type Literal =
	| { type: 'literal'; value: number | string | boolean | null }
	| { type: 'regex'; pattern: string; flags: string }
	| { type: 'bigint'; value: string };	// because bigint can't round-trip through JSON.stringify

export interface TemplatePart { str: string; exp?: Expr; }
export type ObjectProperty =
	| { key: string | { computed: Expr }; value: Expr; kind: 'init' | 'get' | 'set' }
	| { kind: 'spread'; argument: Expr };	// `{...obj}` -- object spread (ES2018).

// Destructuring binding targets, shared by variable declarations, for-loop left-hand sides, and function parameters.
// A plain identifier is just a string (matching this file's existing convention of not wrapping simple names in their own node) -- only object/array patterns get a `type` tag.
export type BindingTarget = string | ObjectPattern | ArrayPattern;
export interface ObjectPatternProperty { key: string; value: BindingTarget; default?: Expr; }
export interface ObjectPattern { type: 'object_pattern'; properties: ObjectPatternProperty[]; rest?: string; }
export interface ArrayPatternElement { target: BindingTarget; default?: Expr; }
// `undefined` entries are holes (elisions), e.g. the gaps in `[a, , b]`.
export interface ArrayPattern { type: 'array_pattern'; elements: (ArrayPatternElement | undefined)[]; rest?: string; }

// `typeAnnotation`/`optional` are untyped (`unknown`) extension points that
// this file itself never sets -- they exist purely so a grammar extension
// (e.g. a TypeScript layer adding `: Type` and `?` to parameters) can attach
// its own richer type there via rule actions pushed onto the exported
// `parameter` array, without this file needing to know anything about types.
export type Param = string | { target: BindingTarget; default?: Expr; typeAnnotation?: unknown; optional?: boolean; modifiers?: string[] };
export interface ParamList { params: Param[]; rest?: string; restType?: unknown; }

// `returnType`/`typeParams` (on 'function'/'arrow') and the 'as_expression'/'non_null' variants are the same kind of untyped extension point as
// Param's, above -- only a grammar extension that adds its own type-expression rules ever populates/produces them; the base JS grammar below never does.
export type Expr =
	| Identifier
	| Literal
	| { type: 'this' }
	| { type: 'array'; elements: readonly (Expr | undefined)[] }	// `undefined` entries are holes (elisions), e.g. the gaps in `[1, , 3]`.
	| { type: 'object'; properties: readonly ObjectProperty[] }
	// `rest` is the trailing `...name` parameter, if any (always last, though this syntax-only grammar doesn't enforce that it can't appear earlier).
	| { type: 'function'; name?: string; params: Param[]; rest?: string; body: Statement[]; generator?: boolean; async?: boolean; returnType?: unknown; typeParams?: unknown[] }
	| { type: 'member'; object: Expr; property: string; optional?: boolean }
	| { type: 'index'; object: Expr; property: Expr; optional?: boolean }
	| { type: 'call'; callee: Expr; arguments: Expr[]; optional?: boolean; typeArgs?: unknown[] }
	| { type: 'new'; callee: Expr; arguments: Expr[]; typeArgs?: unknown[] }
	| { type: 'unary'; operator: string; argument: Expr; prefix: boolean }
	| { type: 'update'; operator: string; argument: Expr; prefix: boolean }
	| { type: 'binary'; operator: string; left: Expr; right: Expr }
	| { type: 'logical'; operator: string; left: Expr; right: Expr }
	| { type: 'assign'; operator: string; left: Expr; right: Expr }
	| { type: 'conditional'; test: Expr; consequent: Expr; alternate: Expr }
	| { type: 'sequence'; expressions: Expr[] }
	| { type: 'spread'; argument: Expr }	// `...x` inside an array literal or a call's argument list.
	| { type: 'tagged_template'; tag: Expr; quasi: TemplatePart[] }
	| { type: 'arrow'; params: Param[]; rest?: string; body: Expr | Statement[]; async?: boolean; returnType?: unknown; typeParams?: unknown[] }
	| { type: 'yield'; argument?: Expr; delegate?: boolean }	// `delegate` is `yield*`; this grammar doesn't enforce that `yield` only appears inside a generator body
	| { type: 'class'; name?: string; superClass?: Expr; body: ClassMember[]; typeParams?: unknown[]; implementsClause?: unknown[]; abstract?: boolean }
	| { type: 'await'; argument: Expr }
	| { type: 'as_expression'; expression: Expr; typeAnnotation: unknown }
	| { type: 'satisfies_expression'; expression: Expr; typeAnnotation: unknown }
	| { type: 'non_null'; expression: Expr };

export interface VarDeclarator { name: BindingTarget; init?: Expr; typeAnnotation?: unknown; definite?: boolean; }
export interface SwitchCase { test?: Expr; consequent: Statement[]; }

export type DeclarationKind = typeof VAR_KEYWORDS[number];
export type ForInit = Expr | { type: 'var'; kind: DeclarationKind; declarations: VarDeclarator[] };

export interface ImportSpecifier { imported: string; local: string; }
export interface ExportSpecifier { local: string; exported: string; }

// Private (`#name`) members aren't supported -- a known simplification.
// `modifiers` (e.g. TypeScript's public/private/protected/readonly) is another untyped extension point, populated only by a grammar extension.
// `static_block` is also only ever produced by a grammar extension (e.g. ts-parser.ts pushes it onto `class_member`) -- this file's own `class_member_body`/`class_member` never shift the '{' that would start one.
export type ClassMember =
	| { type: 'method'; static?: boolean; kind: 'method' | 'get' | 'set'; key: string | { computed: Expr }; value: Expr; modifiers?: string[]; optional?: boolean }
	| { type: 'field'; static?: boolean; key: string | { computed: Expr }; value?: Expr; modifiers?: string[]; optional?: boolean; typeAnnotation?: unknown; definite?: boolean }
	| { type: 'static_block'; body: Statement[] };

export type Statement =
	| { type: 'block'; body: Statement[] }
	| { type: 'var'; kind: DeclarationKind; declarations: VarDeclarator[] }
	| { type: 'expression'; expression: Expr }
	| { type: 'empty' }
	| { type: 'if'; test: Expr; consequent: Statement; alternate?: Statement }
	| { type: 'do_while'; body: Statement; test: Expr }
	| { type: 'while'; test: Expr; body: Statement }
	| { type: 'for'; init?: ForInit; test?: Expr; update?: Expr; body: Statement }
	| { type: 'for_in'; kind: 'in' | 'of'; left: ForInit; right: Expr; body: Statement }
	| { type: 'continue'; label?: string }
	| { type: 'break'; label?: string }
	| { type: 'return'; argument?: Expr }
	| { type: 'with'; object: Expr; body: Statement }
	| { type: 'labeled'; label: string; body: Statement }
	| { type: 'switch'; discriminant: Expr; cases: SwitchCase[] }
	| { type: 'throw'; argument: Expr }
	| { type: 'try'; block: Statement[]; handlerParam?: string; handlerBody?: Statement[]; finalizer?: Statement[] }
	| { type: 'debugger' }
	// `body` is `undefined` only for a bodyless overload/ambient signature (`function f(): void;`) -- a real
	// implementation's body is always an array, even when empty (`function f() {}` has `body: []`).
	| { type: 'function_decl'; name: string; params: Param[]; rest?: string; body?: Statement[]; generator?: boolean; async?: boolean; returnType?: unknown; typeParams?: unknown[] }
	| { type: 'import'; default?: string; namespace?: string; specifiers?: ImportSpecifier[]; source: string }
	| { type: 'export_named'; specifiers: ExportSpecifier[]; source?: string }
	| { type: 'export_all'; source: string; exported?: string }
	| { type: 'export_default'; declaration: Expr | Statement }
	| { type: 'export_decl'; declaration: Statement }
	| { type: 'class_decl'; name: string; superClass?: Expr; body: ClassMember[]; typeParams?: unknown[]; implementsClause?: unknown[]; abstract?: boolean };

export interface Program { type: 'program'; body: Statement[]; }

// ===================================================================
//  Grammar
// ===================================================================

const varKeywords = OneOf(VAR_KEYWORDS);

// Two parallel chains exist above shift_expression: the normal one (allows 'in' as a relational operator) and a "NoIn" one (excludes it), mirroring ECMA-262's own duplication
// It's needed because `for (x in y)` and `for (x; ...)` would otherwise be ambiguous as to whether 'in' continues a RelationalExpression or marks the for-in separator.
// NoIn variants are used only inside for-loop headers.
function binaryChain(lower: Rules<Expr>, ops: string[], prec: string, kind: 'binary' | 'logical' = 'binary') {
	return RRules<Expr>(self => [
		RuleR(lower),
		WithPrec(RuleR(self, OneOf(ops), lower, $ =>	({ type: kind, operator: $[1], left: $[0], right: $[2] })), prec)
	]);
}

// Same shape as `binaryChain`, but for a "Left"-restricted chain (see `_nobrace` below): only the
// leftmost operand -- the chain's own self-recursion -- needs to stay restricted, since the
// restriction is purely about the very first token of the whole expression. The right operand of
// the operator is never leftmost, so it can (and should) be the ordinary, unrestricted nonterminal.
function binaryChainLeft(lowerLeft: Rules<Expr>, lowerRight: Rules<Expr>, ops: string[], prec: string, kind: 'binary' | 'logical' = 'binary') {
	return RRules<Expr>(self => [
		RuleR(lowerLeft),
		WithPrec(RuleR(self, OneOf(ops), lowerRight, $ => ({ type: kind, operator: $[1], left: $[0], right: $[2] })), prec)
	]);
}

// Single-quoted strings are re-quoted to double quotes so JSON.parse can unescape them the same way as already-double-quoted ones -- STRING's own pattern accepts either.
export const unquoteString = (s: string) => JSON.parse(s.replace(/^'|'$/g, '"')) as string;

const fwd_parameter_clause		= Forward<ParamList>(() => parameter_clause);
const fwd_assignment_expression	= Forward<Expr>(() => assignment_expression);
const fwd_function_body 		= Forward<Statement[]>(() => function_body);
const fwd_statement				= Forward<Statement>(() => statement);
const fwd_expression			= Forward<Expr>(() => expression);

// --- Primary / member / call / new chain ---

// `elision`: a run of N commas with nothing between them, i.e. N holes -- shared by array literals and array patterns.
// A *single* trailing comma after a real element (the existing `'[', element_list, ',', ']'` shape below) is just a separator and creates no hole, matching real JS;
// an elision only starts counting from the *next* comma onward.
const elision = RRules<number>(self => [
	RuleR(',', 			() => 1),
	RuleR(self, ',',	$ => ($[0] as number) + 1),
]);
const holes = (n: number) => Array<undefined>(n).fill(undefined);

const element_list = RRules<(Expr | undefined)[]>(self => [
	RuleR(fwd_assignment_expression, 							$ => [$[0]]),
	RuleR(elision, fwd_assignment_expression, 					$ => [...holes($[0] as number), $[1]]),
	RuleR(self, ',', fwd_assignment_expression, 				$ => [...$[0], $[2]]),
	RuleR(self, ',', elision, fwd_assignment_expression, 		$ => [...$[0], ...holes($[2] as number), $[3]]),
	RuleR('...', fwd_assignment_expression, 					$ => [{ type: 'spread', argument: $[1] }]),
	RuleR(elision, '...', fwd_assignment_expression, 			$ => [...holes($[0] as number), { type: 'spread', argument: $[2] }]),
	RuleR(self, ',', '...', fwd_assignment_expression, 			$ => [...$[0], { type: 'spread', argument: $[3] }]),
	RuleR(self, ',', elision, '...', fwd_assignment_expression,	$ => [...$[0], ...holes($[2] as number), { type: 'spread', argument: $[4] }]),
]);
const array_literal = Rules<Expr>(
	RuleR('[', ']', 											() => ({ type: 'array', elements: [] } as const)),
	RuleR('[', elision, ']', 									$ => ({ type: 'array', elements: holes($[1]) })),
	RuleR('[', element_list, ']', 								$ => ({ type: 'array', elements: $[1] })),
	RuleR('[', element_list, ',', ']', 							$ => ({ type: 'array', elements: $[1] })),
	RuleR('[', element_list, ',', elision, ']', 				$ => ({ type: 'array', elements: [...$[1], ...holes($[3] as number)] })),
);

const property_name = Rules<string>(
	RuleR(IDENT),
	RuleR(STRING, $ => unquoteString($[0])),
	RuleR(NUMBER),
);
const property_assignment = Rules<ObjectProperty>(
	// `IDENT ':' value` goes directly (not through `property_name`) specifically for this rule:
	// `property_name`'s `IDENT` alternative is a *separate* reduction that would otherwise compete
	// with `object_pattern_property`'s own `IDENT ':' binding_target` shift for the same raw IDENT
	// -- an unresolved shift/reduce conflict (object_pattern_property only matters where this exact
	// `{...}` is reached through a path that's also reinterpretable as a destructured parameter
	// elsewhere in the grammar) that the table's default-to-shift resolution would otherwise settle
	// by treating the value as a binding pattern, breaking ordinary values like `{key: a.b}`.
	RuleR(IDENT, ':', fwd_assignment_expression, 											$ => ({ key: $[0], value: $[2], kind: 'init' })),
	RuleR(STRING, ':', fwd_assignment_expression, 											$ => ({ key: unquoteString($[0]), value: $[2], kind: 'init' })),
	RuleR(NUMBER, ':', fwd_assignment_expression, 											$ => ({ key: $[0], value: $[2], kind: 'init' })),
	RuleR('get', property_name, '(', ')', '{', fwd_function_body, '}', 						$ => ({ key: $[1], value: { type: 'function', params: [], body: $[5] }, kind: 'get' })),
	RuleR('set', property_name, '(', IDENT, ')', '{', fwd_function_body, '}', 				$ => ({ key: $[1], value: { type: 'function', params: [$[3]], body: $[6] }, kind: 'set' })),
	// Shorthand property: `{x}` is `{x: x}`.
	RuleR(IDENT, 																			$ => ({ key: $[0], value: { type: 'identifier', name: $[0] }, kind: 'init' })),
	// `{x = 1}` is never valid as a *real* object literal (only inside a destructuring target) -- accepted here anyway, permissively, purely so arrow-function parameters can be parsed as a plain object literal and reinterpreted as a pattern afterward (see `exprToBindingTarget` below).
	// A real object literal with this shape only arises if that reinterpretation is never attempted, which this grammar doesn't catch.
	RuleR(IDENT, '=', fwd_assignment_expression, 											$ => ({ key: $[0], value: { type: 'assign', operator: '=', left: { type: 'identifier', name: $[0] }, right: $[2] }, kind: 'init' })),
	// Shorthand method: `{foo() {...}}` is `{foo: function() {...}}`.
	RuleR(property_name, fwd_parameter_clause, '{', fwd_function_body, '}', 				$ => ({ key: $[0], value: { type: 'function', params: $[1].params, rest: $[1].rest, body: $[3] }, kind: 'init' })),
	// Generator method: `{*foo() {...}}` is `{foo: function*() {...}}`.
	RuleR('*', property_name, fwd_parameter_clause, '{', fwd_function_body, '}', 			$ => ({ key: $[1], value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], generator: true }, kind: 'init' })),
	// Async method: `{async foo() {...}}` is `{foo: async function() {...}}`.
	RuleR('async', property_name, fwd_parameter_clause, '{', fwd_function_body, '}', 		$ => ({ key: $[1], value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], async: true }, kind: 'init' })),
	RuleR('async', '*', property_name, fwd_parameter_clause, '{', fwd_function_body, '}',	$ => ({ key: $[2], value: { type: 'function', params: $[3].params, rest: $[3].rest, body: $[5], generator: true, async: true }, kind: 'init' })),
	// Computed key: `{[expr]: value}` -- only supported for the plain key:value form, not get/set/shorthand-method.
	RuleR('[', fwd_assignment_expression, ']', ':', fwd_assignment_expression, 				$ => ({ key: { computed: $[1] }, value: $[4], kind: 'init' })),
	// Object spread (ES2018): `{...obj}`. `exprToBindingTarget` below turns a *trailing* one back
	// into `ObjectPattern.rest` when this same `{...}` gets reinterpreted as an arrow parameter.
	RuleR('...', fwd_assignment_expression, 												$ => ({ kind: 'spread', argument: $[1] })),
);
const property_list = List(property_assignment, ',');

const object_literal = Rules<Expr>(
	RuleR('{', '}', 					_ => ({ type: 'object', properties: [] as ObjectProperty[] })),
	RuleR('{', property_list, '}', 		$ => ({ type: 'object', properties: $[1] })),
	RuleR('{', property_list, ',', '}', $ => ({ type: 'object', properties: $[1] })),
);

// --- Destructuring binding patterns ---
// Only reachable from contexts that are unambiguously a binding position (right after 'var'/'let'/'const', or inside a parameter list) -- never
// from general expression position, so there's no grammar conflict with object_literal/array_literal despite the shared '{'/'[' tokens.

export const binding_pattern = Rules<ObjectPattern | ArrayPattern>(
	RuleR(Forward<ObjectPattern>(()=>object_pattern)),
	RuleR(Forward<ArrayPattern>(()=>array_pattern)),
);
export const binding_target = Rules<BindingTarget>(
	RuleR(IDENT),
	...binding_pattern,
);

const object_pattern_property = Rules<ObjectPatternProperty>(
	// Shorthand: `{a}` or `{a = 1}`, binding directly to a same-named local.
	RuleR(IDENT, 														$ => ({ key: $[0], value: $[0] })),
	RuleR(IDENT, '=', fwd_assignment_expression, 						$ => ({ key: $[0], value: $[0], default: $[2] })),
	// Renamed/nested: `{a: b}`, `{a: b = 1}`, `{a: {b}}`, etc.
	RuleR(IDENT, ':', binding_target, 									$ => ({ key: $[0], value: $[2] })),
	RuleR(IDENT, ':', binding_target, '=', fwd_assignment_expression, 	$ => ({ key: $[0], value: $[2], default: $[4] })),
);
const object_pattern_property_list = List(object_pattern_property, ',');
const object_pattern = Rules<ObjectPattern>(
	RuleR('{', '}', 													_ => ({ type: 'object_pattern', properties: [] })),
	RuleR('{', object_pattern_property_list, '}', 						$ => ({ type: 'object_pattern', properties: $[1] })),
	RuleR('{', object_pattern_property_list, ',', '}', 					$ => ({ type: 'object_pattern', properties: $[1] })),
	RuleR('{', '...', IDENT, '}', 										$ => ({ type: 'object_pattern', properties: [], rest: $[2] })),
	RuleR('{', object_pattern_property_list, ',', '...', IDENT, '}', 	$ => ({ type: 'object_pattern', properties: $[1], rest: $[4] })),
);

const array_pattern_element = Rules<ArrayPatternElement>(
	RuleR(binding_target, 												$ => ({ target: $[0] })),
	RuleR(binding_target, '=', fwd_assignment_expression,				$ => ({ target: $[0], default: $[2] })),
);
const array_pattern_element_list = RRules<(ArrayPatternElement | undefined)[]>(self => [
	RuleR(array_pattern_element,										$ => [$[0]]),
	RuleR(elision, array_pattern_element,								$ => [...holes($[0]), $[1]]),
	RuleR(self, ',', array_pattern_element,								$ => [...$[0], $[2]]),
	RuleR(self, ',', elision, array_pattern_element, 					$ => [...$[0], ...holes($[2]), $[3]]),
]);
const array_pattern = Rules<ArrayPattern>(
	RuleR('[', ']', 													_ => ({ type: 'array_pattern', elements: [] as undefined[]})),
	RuleR('[', elision, ']', 											$ => ({ type: 'array_pattern', elements: holes($[1]) })),
	RuleR('[', array_pattern_element_list, ']', 						$ => ({ type: 'array_pattern', elements: $[1] })),
	RuleR('[', array_pattern_element_list, ',', ']', 					$ => ({ type: 'array_pattern', elements: $[1] })),
	RuleR('[', array_pattern_element_list, ',', elision, ']', 			$ => ({ type: 'array_pattern', elements: [...$[1], ...holes($[3] as number)] })),
	RuleR('[', '...', IDENT, ']', 										$ => ({ type: 'array_pattern', elements: [] as undefined[], rest: $[2] })),
	RuleR('[', array_pattern_element_list, ',', '...', IDENT, ']', 		$ => ({ type: 'array_pattern', elements: $[1], rest: $[4] })),
);

// --- Arrow function parameter reinterpretation ---
//
// A parenthesized arrow parameter list looks exactly like a parenthesized expression until the `=>` that follows it
// `(a, b)` could be a comma-expression or two params,
// `({a}) ` could be a parenthesized object literal or a destructured param
// Predicting which one from inside the parens would need unbounded lookahead (or true backtracking/GLR), so instead the parens are parsed as a perfectly ordinary `expression`
// (the existing `'(', expression, ')'` shape primary_expression already has), and only *after* `=>` confirms this was actually a parameter list does `exprToParams` reinterpret that already-built expression tree as one.
// This is the same technique real JS engines use for this exact ambiguity.
//
// The one piece `expression` can't already represent on its own is a trailing `...rest` (spread isn't valid as a bare expression), so that case is spelled out as its own grammar rule below rather than handled inside the conversion.

function exprToBindingTarget(e: Expr): BindingTarget {
	switch (e.type) {
		case 'identifier':	return e.name;
		case 'object': {
			// A trailing spread becomes `rest` (must be a plain identifier, same restriction as array's);
			// a spread anywhere else, or `key`/`value` on a spread entry, is never a valid pattern.
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
					return p.value.type === 'assign'
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
					: el.type === 'assign' ? { target: exprToBindingTarget(el.left), default: el.right }
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
	return	e.type === 'identifier' ?  e.name
		:	e.type === 'assign' && e.operator === '=' ? { target: exprToBindingTarget(e.left), default: e.right }
		:	{ target: exprToBindingTarget(e) };
}
function exprToParams(e: Expr): Param[] {
	return e.type === 'sequence' ? e.expressions.map(exprToParam) : [exprToParam(e)];
}

const template_literal_part = Rules<TemplatePart>(
	RuleR(/(?:[^`$]|\\\$(?!\{))*(?=\$\{)/, '${', fwd_expression, '}',	$ => ({ str: $[0], exp: $[2] })),
	RuleR(/(?:[^`$]|\\\$(?!\{))*(?=`)/, 								$ => ({ str: $[0] })),
);
const template_literal_parts = List(template_literal_part);

// Parses a NUMBER token's text into its runtime value -- shared by primary_expression's own number literal and (once added) anywhere else a raw number needs the same hex/octal/binary/separator/BigInt handling
function parseNumber(text: string): Literal {
	if (text.endsWith('n'))
		return { type: 'bigint', value: text.slice(0, -1).replace(/_/g, '') };
	const clean = text.replace(/_/g, '');
	return {
		type: 'literal',
		value:	/^0[xX]/.test(clean) ? parseInt(clean, 16)
			:	/^0[oO]/.test(clean) ? parseInt(clean.slice(2), 8)
			:	/^0[bB]/.test(clean) ? parseInt(clean.slice(2), 2)
			:	parseFloat(clean),
	};
}

export const primary_expression = Rules<Expr>(
	RuleR('this', 					_ => ({ type: 'this' })),
	RuleR(IDENT,					$ => ({ type: 'identifier', name: $[0] })),
	RuleR(NUMBER, 					$ => parseNumber($[0])),
	RuleR(STRING, 					$ => ({ type: 'literal', value: unquoteString($[0]) })),
	RuleR(REGEX_LITERAL,			$ => { const m = /^\/(.*)\/([a-zA-Z]*)$/.exec($[0])!; return { type: 'regex', pattern: m[1], flags: m[2] }; }),
	RuleR('true', 					_ => ({ type: 'literal', value: true })),
	RuleR('false',					_ => ({ type: 'literal', value: false })),
	RuleR('null',					_ => ({ type: 'literal', value: null })),
	RuleR(array_literal),
	RuleR(object_literal),
	RuleR('(', fwd_expression, ')', $ => $[1]),
	Rule(['`', template_literal_parts, '`'],	$ => ({ type: 'literal', value: $[1] } as Expr))
);

// A single parameter: a bare name, a name with a default, or a destructured (optionally defaulted) target. Plain identifiers stay bare strings, same convention as elsewhere in this file -- only the richer forms wrap.
export const parameter = Rules<Param>(
	RuleR(IDENT),
	RuleR(IDENT, '=', fwd_assignment_expression,			$ => ({ target: $[0], default: $[2] })),
	RuleR(object_pattern,									$ => ({ target: $[0] })),
	RuleR(object_pattern, '=', fwd_assignment_expression,	$ => ({ target: $[0], default: $[2] })),
	RuleR(array_pattern,									$ => ({ target: $[0] })),
	RuleR(array_pattern, '=', fwd_assignment_expression,	$ => ({ target: $[0], default: $[2] })),
);
export const formal_parameter_list = List(parameter, ',');

// A full `(...)` parameter clause, with an optional trailing `...rest`.
// Shared by function expressions/declarations and object-literal shorthand methods, so rest-parameter support lands in all three at once.
// Rest itself stays a bare identifier (a known simplification -- the real spec also allows a destructuring pattern there).
export const parameter_clause = Rules<ParamList>(
	RuleR('(', ')', 											_ => ({ params: [] })),
	RuleR('(', formal_parameter_list, ')', 						$ => ({ params: $[1] })),
	// Trailing comma after the last (non-rest) parameter -- real JS/TS allows it; a rest parameter
	// can't take one (`(...x,)` isn't valid there either), so this is only the non-rest forms.
	RuleR('(', formal_parameter_list, ',', ')', 				$ => ({ params: $[1] })),
	RuleR('(', '...', IDENT, ')', 								$ => ({ params: [], rest: $[2] })),
	RuleR('(', formal_parameter_list, ',', '...', IDENT, ')',	$ => ({ params: $[1], rest: $[4] })),
);
export const function_expression = Rules<Expr>(
	RuleR('function', parameter_clause, '{', fwd_function_body, '}', 						$ => ({ type: 'function', params: $[1].params, rest: $[1].rest, body: $[3] })),
	RuleR('function', IDENT, parameter_clause, '{', fwd_function_body, '}', 				$ => ({ type: 'function', name: $[1], params: $[2].params, rest: $[2].rest, body: $[4] })),
	RuleR('function', '*', parameter_clause, '{', fwd_function_body, '}', 					$ => ({ type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], generator: true })),
	RuleR('function', '*', IDENT, parameter_clause, '{', fwd_function_body, '}', 			$ => ({ type: 'function', name: $[2], params: $[3].params, rest: $[3].rest, body: $[5], generator: true })),
	RuleR('async', 'function', parameter_clause, '{', fwd_function_body, '}', 				$ => ({ type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], async: true })),
	RuleR('async', 'function', IDENT, parameter_clause, '{', fwd_function_body, '}', 		$ => ({ type: 'function', name: $[2], params: $[3].params, rest: $[3].rest, body: $[5], async: true })),
	RuleR('async', 'function', '*', parameter_clause, '{', fwd_function_body, '}', 			$ => ({ type: 'function', params: $[3].params, rest: $[3].rest, body: $[5], generator: true, async: true })),
	RuleR('async', 'function', '*', IDENT, parameter_clause, '{', fwd_function_body, '}',	$ => ({ type: 'function', name: $[3], params: $[4].params, rest: $[4].rest, body: $[6], generator: true, async: true }))
);

export const member_expression = RRules<Expr>(self => [
	RuleR(primary_expression),
	RuleR(function_expression),
	RuleR(Forward<Expr>(()=>class_expression)),
	RuleR(self, '.', IDENT, 									$ => ({ type: 'member', object: $[0], property: $[2] })),
	RuleR(self, '[', fwd_expression, ']', 						$ => ({ type: 'index', object: $[0], property: $[2] })),
	RuleR('new', self, ()=>arguments_, 							$ => ({ type: 'new', callee: $[1], arguments: $[2] as Expr[] })),
]);
const new_expression = RRules<Expr>(self => [
	RuleR(member_expression),
	RuleR('new', self, 											$ => ({ type: 'new', callee: $[1], arguments: [] })),
]);
const argument_list = RRules<Expr[]>(self => [
	RuleR(fwd_assignment_expression, 							$ => [$[0]]),
	RuleR(self, ',', fwd_assignment_expression, 				$ => [...($[0]), $[2]]),
	RuleR('...', fwd_assignment_expression, 					$ => [{ type: 'spread', argument: $[1] }]),
	RuleR(self, ',', '...', fwd_assignment_expression, 			$ => [...($[0]), { type: 'spread', argument: $[3] }]),
]);
export const arguments_ = Rules<Expr[]>(
	RuleR('(', ')', 											() => []),
	RuleR('(', argument_list, ')', 								$ => $[1]),
	// Trailing comma after the last argument -- real JS allows it (a spread argument can take one too).
	RuleR('(', argument_list, ',', ')', 						$ => $[1]),
);
export const call_expression = RRules<Expr>(self => [
	RuleR(member_expression, arguments_, 						$ => ({ type: 'call', callee: $[0], arguments: $[1] })),
	RuleR(self, arguments_, 									$ => ({ type: 'call', callee: $[0], arguments: $[1] })),
	RuleR(self, '.', IDENT, 									$ => ({ type: 'member', object: $[0], property: $[2] })),
	RuleR(self, '[', fwd_expression, ']', 						$ => ({ type: 'index', object: $[0], property: $[2] })),
	// Tagged template: `tag\`...\`` is structurally a call, just with a
	// template literal instead of a parenthesized argument list.
	RuleR(member_expression, '`', template_literal_parts, '`', 	$ => ({ type: 'tagged_template', tag: $[0], quasi: $[2] })),
	RuleR(self, '`', template_literal_parts, '`',				$ => ({ type: 'tagged_template', tag: $[0], quasi: $[2] })),
	// Optional chaining: each `?.` step only marks itself optional -- this/ syntax-only grammar doesn't track or enforce the real short-circuiting
	// semantics (the rest of a chain skipping evaluation once one step is/ nullish), same as other non-syntactic restrictions elsewhere here.
	RuleR(member_expression, '?.', IDENT, 						$ => ({ type: 'member', object: $[0], property: $[2], optional: true })),
	RuleR(self, '?.', IDENT, 									$ => ({ type: 'member', object: $[0], property: $[2], optional: true })),
	RuleR(member_expression, '?.', '[', fwd_expression, ']', 	$ => ({ type: 'index', object: $[0], property: $[3], optional: true })),
	RuleR(self, '?.', '[', fwd_expression, ']', 				$ => ({ type: 'index', object: $[0], property: $[3], optional: true })),
	RuleR(member_expression, '?.', arguments_, 					$ => ({ type: 'call', callee: $[0], arguments: $[2], optional: true })),
	RuleR(self, '?.', arguments_, 								$ => ({ type: 'call', callee: $[0], arguments: $[2], optional: true })),
]);
export const left_hand_side_expression = Rules<Expr>(
	RuleR(new_expression),
	RuleR(call_expression),
);

// --- Unary / update / binary precedence chain ---
// Postfix ++/-- doesn't need to worry about the "no line terminator before
// ++/--" restricted production here: WS's `lex` callback (see below)
// already reclassifies the preceding whitespace into a semicolon at the
// lexer level before either token ever reaches the parser.

const postfix_expression = Rules<Expr>(
	RuleR(left_hand_side_expression),
	RuleR(left_hand_side_expression, '++',	$ => ({ type: 'update', operator: '++', argument: $[0], prefix: false })),
	RuleR(left_hand_side_expression, '--',	$ => ({ type: 'update', operator: '--', argument: $[0], prefix: false })),
);
const unary_expression = RRules<Expr>(self => [
	RuleR(postfix_expression),
	RuleR('delete', self, 	$ => ({ type: 'unary', operator: 'delete', argument: $[1], prefix: true })),
	RuleR('void', self, 	$ => ({ type: 'unary', operator: 'void', argument: $[1], prefix: true })),
	RuleR('typeof', self, 	$ => ({ type: 'unary', operator: 'typeof', argument: $[1], prefix: true })),
	// Unlike `yield`, `await` always requires an operand -- no ASI/restricted production handling needed, same as `typeof`/`void`/`delete` above.
	// This grammar doesn't enforce that `await` only appears inside an async function, same as other non-syntactic restrictions elsewhere here.
	RuleR('await', self, 	$ => ({ type: 'await', argument: $[1] })),
	RuleR('++', self, 		$ => ({ type: 'update', operator: '++', argument: $[1], prefix: true })),
	RuleR('--', self, 		$ => ({ type: 'update', operator: '--', argument: $[1], prefix: true })),
	RuleR('+', self, 		$ => ({ type: 'unary', operator: '+', argument: $[1], prefix: true })),
	RuleR('-', self, 		$ => ({ type: 'unary', operator: '-', argument: $[1], prefix: true })),
	RuleR('~', self, 		$ => ({ type: 'unary', operator: '~', argument: $[1], prefix: true })),
	RuleR('!', self, 		$ => ({ type: 'unary', operator: '!', argument: $[1], prefix: true })),
]);

// Right-associative: 2 ** 3 ** 2 === 2 ** (3 ** 2). Spelled as a dedicated
// self-recursion on the right (rather than binaryChain's left-recursion)
// since right-associativity needs the recursive reference on the other side.
const exponentiation_expression = RRules<Expr>(self => [
	RuleR(unary_expression),
	WithPrec(RuleR(unary_expression, '**', self, $ => ({ type: 'binary', operator: '**', left: $[0], right: $[2] })), 'exponentiation'),
]);

const multiplicative_expression		= binaryChain(exponentiation_expression,	['*', '/', '%'], 							'multiplicative');
const additive_expression			= binaryChain(multiplicative_expression,	['+', '-'], 								'additive');
const shift_expression				= binaryChain(additive_expression,			['<<', '>>', '>>>'], 						'shift');

export const relational_expression	= binaryChain(shift_expression,				['<', '>', '<=', '>=', 'instanceof', 'in'], 'relational');
const equality_expression			= binaryChain(relational_expression,		['==', '!=', '===', '!=='], 				'equality');
const bitwise_and_expression		= binaryChain(equality_expression,			['&'], 										'bitwiseAnd');
const bitwise_xor_expression		= binaryChain(bitwise_and_expression,		['^'], 										'bitwiseXor');
const bitwise_or_expression			= binaryChain(bitwise_xor_expression,		['|'], 										'bitwiseOr');
const logical_and_expression		= binaryChain(bitwise_or_expression,		['&&'], 									'logicalAnd',	'logical');
const logical_or_expression			= binaryChain(logical_and_expression,		['||'], 									'logicalOr',	'logical');

const relational_expression_noin	= binaryChain(shift_expression,				['<', '>', '<=', '>=', 'instanceof'], 		'relational');
const equality_expression_noin		= binaryChain(relational_expression_noin,	['==', '!=', '===', '!=='], 				'equality');
const bitwise_and_expression_noin	= binaryChain(equality_expression_noin,		['&'], 										'bitwiseAnd');
const bitwise_xor_expression_noin	= binaryChain(bitwise_and_expression_noin,	['^'], 										'bitwiseXor');
const bitwise_or_expression_noin	= binaryChain(bitwise_xor_expression_noin,	['|'], 										'bitwiseOr');
const logical_and_expression_noin	= binaryChain(bitwise_or_expression_noin,	['&&'], 									'logicalAnd',	'logical');
const logical_or_expression_noin	= binaryChain(logical_and_expression_noin,	['||'], 									'logicalOr',	'logical');

// Own precedence level, above logical-or -- the real spec additionally forbids mixing '??' with '||'/'&&' at the same level without parens, but this grammar doesn't enforce that restriction
const nullish_expression			= binaryChain(logical_or_expression,		['??'], 									'nullish',		'logical');
const nullish_expression_noin		= binaryChain(logical_or_expression_noin,	['??'], 									'nullish',		'logical');

const conditional_expression = Rules<Expr>(
	RuleR(nullish_expression),
	RuleR(nullish_expression, '?', fwd_assignment_expression, ':', fwd_assignment_expression, $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] })),
);
const conditional_expression_noin = Rules<Expr>(
	RuleR(nullish_expression_noin),
	RuleR(nullish_expression_noin, '?', fwd_assignment_expression, ':', Forward<Expr>(()=>assignment_expression_noin), $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] })),
);

// `'(' expression ')'` here is the *same* parse primary_expression's own parenthesized-expression rule produces
// -- the grammar doesn't try to predict an arrow function inside the parens at all (see exprToParams above);
// it only diverges from a plain parenthesized expression on the `=>` lookahead that follows the closing `)`, which is an ordinary, conflict-free one-token decision for an LR parser.
//
// Arrow functions aren't offered from assignment_expression_noin: they'd only matter inside a for-loop header's init/test/update clauses, where nobody realistically writes one, so that duplication isn't worth it here.
export const arrow_body = Rules<Expr | Statement[]>(
	RuleR('{', '}', 										() => [] as Statement[]),
	RuleR('{', Forward(()=>statement_list), '}', 			$ => $[1] as Statement[]),
	RuleR(fwd_assignment_expression),
);
export const arrow_function = Rules<Expr>(
	RuleR(IDENT, '=>', arrow_body, 													$ => ({ type: 'arrow', params: [$[0]], body: $[2] })),
	RuleR('(', ')', '=>', arrow_body, 												$ => ({ type: 'arrow', params: [], body: $[3] })),
	RuleR('(', '...', IDENT, ')', '=>', arrow_body, 								$ => ({ type: 'arrow', params: [], rest: $[2], body: $[5] })),
	RuleR('(', fwd_expression, ')', '=>', arrow_body, 								$ => ({ type: 'arrow', params: exprToParams($[1]), body: $[4] })),
	RuleR('(', fwd_expression, ',', '...', IDENT, ')', '=>', arrow_body, 			$ => ({ type: 'arrow', params: exprToParams($[1]), rest: $[4], body: $[7] })),
	RuleR('async', IDENT, '=>', arrow_body, 										$ => ({ type: 'arrow', params: [$[1]], body: $[3], async: true })),
	RuleR('async', '(', ')', '=>', arrow_body, 										$ => ({ type: 'arrow', params: [], body: $[4], async: true })),
	RuleR('async', '(', '...', IDENT, ')', '=>', arrow_body, 						$ => ({ type: 'arrow', params: [], rest: $[3], body: $[6], async: true })),
	RuleR('async', '(', fwd_expression, ')', '=>', arrow_body, 						$ => ({ type: 'arrow', params: exprToParams($[2]), body: $[5], async: true })),
	RuleR('async', '(', fwd_expression, ',', '...', IDENT, ')', '=>', arrow_body,	$ => ({ type: 'arrow', params: exprToParams($[2]), rest: $[5], body: $[8], async: true })),
);

// `yield` with no argument relies on the same restricted-production/ASI
// machinery as `return` (see RESTRICTED_AFTER below) to stop a following
// token from being swallowed as its argument across a line break.
const yield_expression = Rules<Expr>(
	RuleR('yield', 										_ => ({ type: 'yield' })),
	RuleR('yield', fwd_assignment_expression, 			$ => ({ type: 'yield', argument: $[1] })),
	RuleR('yield', '*', fwd_assignment_expression, 		$ => ({ type: 'yield', argument: $[2], delegate: true })),
);

export const assignment_expression = RRules<Expr>(self => [
	RuleR(left_hand_side_expression, ASSIGN_OP, self, 	$ => ({ type: 'assign', operator: $[1], left: $[0], right: $[2] })),
	RuleR(conditional_expression),
	RuleR(arrow_function),
	RuleR(yield_expression),
]);
export const assignment_expression_noin = RRules<Expr>(self => [
	RuleR(left_hand_side_expression, ASSIGN_OP, self, 	$ => ({ type: 'assign', operator: $[1], left: $[0], right: $[2] })),
	RuleR(conditional_expression_noin),
]);

const expression = RRules<Expr>(self => [
	RuleR(assignment_expression),
	RuleR(self, ',', assignment_expression,				$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] }))
]);
const expression_noin = RRules<Expr>(self => [
	RuleR(assignment_expression_noin),
	RuleR(self, ',', assignment_expression_noin,		$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] }))
]);

// A second parallel chain, "NoBrace", mirroring the NoIn one above but for a different ambiguity:
// real ECMAScript forbids `ExpressionStatement` from starting with `{`/`function`/`class` (that's
// *why* `({a: 1})` needs its parens) precisely because `{` is also `block`'s opening token, and
// `function`/`class` are also `function_declaration`'s/`class_declaration`'s. Without this
// restriction, `{ x = 1; }` is genuinely ambiguous between a block containing an assignment and an
// object literal using shorthand-with-default syntax -- and since both readings stay valid for a
// while (`identifier '=' assignment_expression` parses either way), the table commits to one
// without ever flagging a conflict, only failing several tokens later when they diverge.
//
// Unlike NoIn (where the excluded token can appear anywhere inside a for-loop header), this
// restriction only ever concerns the *leftmost* token of the whole statement -- `a + {}` is fine,
// only `{` *starting* the statement is the problem. So only the chain's own left-recursive
// self-reference needs to route through the NoBrace nonterminal at each level; every right operand
// (after an operator, inside parens/brackets, etc.) is no longer leftmost and stays on the
// ordinary, unrestricted chain. `arrow_function`/`yield_expression` need no NoBrace counterpart at
// all -- neither can ever start with `{`/`function`/`class` in the first place.
const primary_expression_nobrace = Rules<Expr>(
	RuleR('this', 							_ => ({ type: 'this' })),
	RuleR(IDENT,							$ => ({ type: 'identifier', name: $[0] })),
	RuleR(NUMBER, 							$ => parseNumber($[0])),
	RuleR(STRING, 							$ => ({ type: 'literal', value: unquoteString($[0]) })),
	RuleR(REGEX_LITERAL,					$ => { const m = /^\/(.*)\/([a-zA-Z]*)$/.exec($[0])!; return { type: 'regex', pattern: m[1], flags: m[2] }; }),
	RuleR('true', 							_ => ({ type: 'literal', value: true })),
	RuleR('false',							_ => ({ type: 'literal', value: false })),
	RuleR('null',							_ => ({ type: 'literal', value: null })),
	RuleR(array_literal),
	// `object_literal` dropped: `{` starting a statement always means a block.
	RuleR('(', fwd_expression, ')', 		$ => $[1]),
	Rule(['`', template_literal_parts, '`'],$ => ({ type: 'literal', value: $[1] } as Expr))
);
const member_expression_nobrace = RRules<Expr>(self => [
	RuleR(primary_expression_nobrace),
	// `function_expression`/`class_expression` alternatives dropped, same reason as `object_literal` above.
	RuleR(self, '.', IDENT, 									$ => ({ type: 'member', object: $[0], property: $[2] })),
	RuleR(self, '[', fwd_expression, ']', 						$ => ({ type: 'index', object: $[0], property: $[2] })),
	// `new` itself is never ambiguous with `block`/declarations, so everything from here on (including the callee) is the ordinary, unrestricted chain.
	RuleR('new', member_expression, ()=>arguments_, 			$ => ({ type: 'new', callee: $[1], arguments: $[2] as Expr[] })),
]);
const new_expression_nobrace = Rules<Expr>(
	RuleR(member_expression_nobrace),
	RuleR('new', new_expression, 								$ => ({ type: 'new', callee: $[1], arguments: [] })),
);
const call_expression_nobrace = RRules<Expr>(self => [
	RuleR(member_expression_nobrace, arguments_, 						$ => ({ type: 'call', callee: $[0], arguments: $[1] })),
	RuleR(self, arguments_, 											$ => ({ type: 'call', callee: $[0], arguments: $[1] })),
	RuleR(self, '.', IDENT, 											$ => ({ type: 'member', object: $[0], property: $[2] })),
	RuleR(self, '[', fwd_expression, ']', 								$ => ({ type: 'index', object: $[0], property: $[2] })),
	RuleR(member_expression_nobrace, '`', template_literal_parts, '`', 	$ => ({ type: 'tagged_template', tag: $[0], quasi: $[2] })),
	RuleR(self, '`', template_literal_parts, '`',						$ => ({ type: 'tagged_template', tag: $[0], quasi: $[2] })),
	RuleR(member_expression_nobrace, '?.', IDENT, 						$ => ({ type: 'member', object: $[0], property: $[2], optional: true })),
	RuleR(self, '?.', IDENT, 											$ => ({ type: 'member', object: $[0], property: $[2], optional: true })),
	RuleR(member_expression_nobrace, '?.', '[', fwd_expression, ']', 	$ => ({ type: 'index', object: $[0], property: $[3], optional: true })),
	RuleR(self, '?.', '[', fwd_expression, ']', 						$ => ({ type: 'index', object: $[0], property: $[3], optional: true })),
	RuleR(member_expression_nobrace, '?.', arguments_, 					$ => ({ type: 'call', callee: $[0], arguments: $[2], optional: true })),
	RuleR(self, '?.', arguments_, 										$ => ({ type: 'call', callee: $[0], arguments: $[2], optional: true })),
]);
const left_hand_side_expression_nobrace = Rules<Expr>(
	RuleR(new_expression_nobrace),
	RuleR(call_expression_nobrace),
);
const postfix_expression_nobrace = Rules<Expr>(
	RuleR(left_hand_side_expression_nobrace),
	RuleR(left_hand_side_expression_nobrace, '++',	$ => ({ type: 'update', operator: '++', argument: $[0], prefix: false })),
	RuleR(left_hand_side_expression_nobrace, '--',	$ => ({ type: 'update', operator: '--', argument: $[0], prefix: false })),
);
const unary_expression_nobrace = Rules<Expr>(
	// Every prefix alternative starts with a keyword/operator, never `{`/`function`/`class` -- only
	// the bare pass-through (no prefix at all) needs to stay on the NoBrace chain; the operand after
	// any of these prefixes is no longer leftmost, so it's the ordinary `unary_expression`.
	RuleR(postfix_expression_nobrace),
	RuleR('delete', unary_expression, 		$ => ({ type: 'unary', operator: 'delete', argument: $[1], prefix: true })),
	RuleR('void', unary_expression, 		$ => ({ type: 'unary', operator: 'void', argument: $[1], prefix: true })),
	RuleR('typeof', unary_expression, 		$ => ({ type: 'unary', operator: 'typeof', argument: $[1], prefix: true })),
	RuleR('await', unary_expression, 		$ => ({ type: 'await', argument: $[1] })),
	RuleR('++', unary_expression, 			$ => ({ type: 'update', operator: '++', argument: $[1], prefix: true })),
	RuleR('--', unary_expression, 			$ => ({ type: 'update', operator: '--', argument: $[1], prefix: true })),
	RuleR('+', unary_expression, 			$ => ({ type: 'unary', operator: '+', argument: $[1], prefix: true })),
	RuleR('-', unary_expression, 			$ => ({ type: 'unary', operator: '-', argument: $[1], prefix: true })),
	RuleR('~', unary_expression, 			$ => ({ type: 'unary', operator: '~', argument: $[1], prefix: true })),
	RuleR('!', unary_expression, 			$ => ({ type: 'unary', operator: '!', argument: $[1], prefix: true })),
);
const exponentiation_expression_nobrace = Rules<Expr>(
	RuleR(unary_expression_nobrace),
	WithPrec(RuleR(unary_expression_nobrace, '**', exponentiation_expression, $ => ({ type: 'binary', operator: '**', left: $[0], right: $[2] })), 'exponentiation'),
);
const multiplicative_expression_nobrace	= binaryChainLeft(exponentiation_expression_nobrace,	exponentiation_expression,	['*', '/', '%'], 							'multiplicative');
const additive_expression_nobrace		= binaryChainLeft(multiplicative_expression_nobrace,	multiplicative_expression,	['+', '-'], 								'additive');
const shift_expression_nobrace			= binaryChainLeft(additive_expression_nobrace,			additive_expression,		['<<', '>>', '>>>'], 						'shift');
const relational_expression_nobrace		= binaryChainLeft(shift_expression_nobrace,				shift_expression,			['<', '>', '<=', '>=', 'instanceof', 'in'], 'relational');
const equality_expression_nobrace		= binaryChainLeft(relational_expression_nobrace,		relational_expression,		['==', '!=', '===', '!=='], 				'equality');
const bitwise_and_expression_nobrace	= binaryChainLeft(equality_expression_nobrace,			equality_expression,		['&'], 										'bitwiseAnd');
const bitwise_xor_expression_nobrace	= binaryChainLeft(bitwise_and_expression_nobrace,		bitwise_and_expression,		['^'], 										'bitwiseXor');
const bitwise_or_expression_nobrace		= binaryChainLeft(bitwise_xor_expression_nobrace,		bitwise_xor_expression,		['|'], 										'bitwiseOr');
const logical_and_expression_nobrace	= binaryChainLeft(bitwise_or_expression_nobrace,		bitwise_or_expression,		['&&'], 									'logicalAnd',	'logical');
const logical_or_expression_nobrace		= binaryChainLeft(logical_and_expression_nobrace,		logical_and_expression,		['||'], 									'logicalOr',	'logical');
const nullish_expression_nobrace		= binaryChainLeft(logical_or_expression_nobrace,		logical_or_expression,		['??'], 									'nullish',		'logical');
const conditional_expression_nobrace = Rules<Expr>(
	RuleR(nullish_expression_nobrace),
	RuleR(nullish_expression_nobrace, '?', fwd_assignment_expression, ':', fwd_assignment_expression, $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] })),
);
const assignment_expression_nobrace = Rules<Expr>(
	RuleR(left_hand_side_expression_nobrace, ASSIGN_OP, fwd_assignment_expression, $ => ({ type: 'assign', operator: $[1], left: $[0], right: $[2] })),
	RuleR(conditional_expression_nobrace),
	RuleR(arrow_function),
	RuleR(yield_expression),
);
const expression_nobrace = RRules<Expr>(self => [
	RuleR(assignment_expression_nobrace),
	RuleR(self, ',', assignment_expression,				$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] }))
]);

// --- Statements ---

// Destructuring declarations always require an initializer (`const {a};` isn't valid JS, since there'd be nothing to destructure) -- so unlike the plain-identifier alternative, there's no pattern-only rule here
export const variable_declaration = Rules<VarDeclarator>(
	RuleR(IDENT, 											$ => ({ name: $[0] })),
	RuleR(IDENT, '=', assignment_expression, 				$ => ({ name: $[0], init: $[2] })),
	RuleR(binding_pattern, '=', assignment_expression, 		$ => ({ name: $[0], init: $[2] })),
);
const variable_declaration_list = List(variable_declaration, ',');
export const variable_declaration_noin = Rules<VarDeclarator>(
	RuleR(IDENT, 											$ => ({ name: $[0] })),
	RuleR(IDENT, '=', assignment_expression_noin, 			$ => ({ name: $[0], init: $[2] })),
	RuleR(binding_pattern, '=', assignment_expression_noin, $ => ({ name: $[0], init: $[2] })),
);
const variable_declaration_list_noin = List(variable_declaration_noin, ',');

export const variable_statement = Rules<Statement>(
	RuleR(varKeywords, variable_declaration_list, ';', 		$ => ({ type: 'var', kind: $[0], declarations: $[1] }))
);

const statement_list = RRules<Statement[]>(self => [
	RuleR(fwd_statement,					$ => [$[0]]),
	RuleR(self, fwd_statement,				$ => [...$[0], $[1]]),
]);
const block = Rules<Statement>(
	RuleR('{', '}',							_ => ({ type: 'block', body: [] })),
	RuleR('{', statement_list, '}',			$ => ({ type: 'block', body: $[1] })),
);

const expression_statement = Rules<Statement>(
	RuleR(expression_nobrace, ';',			$ => ({ type: 'expression', expression: $[0] })),
);

const if_statement = Rules<Statement>(
	RuleR('if', '(', expression, ')', fwd_statement,						$ => ({ type: 'if', test: $[2], consequent: $[4] })),
	RuleR('if', '(', expression, ')', fwd_statement, 'else', fwd_statement,	$ => ({ type: 'if', test: $[2], consequent: $[4], alternate: $[6] })),
);

const for_init = Rules<ForInit>(
	RuleR(varKeywords, variable_declaration_list_noin,			$ => ({ type: 'var', kind: $[0], declarations: $[1]})),
	RuleR(expression_noin),
);
const for_lhs = Rules<ForInit>(
	RuleR(varKeywords, variable_declaration_noin,				$ => ({ type: 'var', kind: $[0], declarations: [$[1]] })),
	// `for (const {a} of arr)` -- a for-in/of binding has no initializer, so (unlike variable_declaration_noin) the pattern stands alone here.
	RuleR(varKeywords, binding_pattern,							$ => ({ type: 'var', kind: $[0], declarations: [{ name: $[1] }] })),
	RuleR(left_hand_side_expression),
);

const expression_opt = Rules<Expr | undefined>(
	RuleR(() => undefined),
	RuleR(expression),
);

const iteration_statement = Rules<Statement>(
	RuleR('do', fwd_statement, 'while', '(', expression, ')', ';', 								$ => ({ type: 'do_while', body: $[1], test: $[4] })),
	RuleR('while', '(', expression, ')', fwd_statement, 										$ => ({ type: 'while', test: $[2], body: $[4] })),
	RuleR('for', '(', ';', expression_opt, ';', expression_opt, ')', fwd_statement, 			$ => ({ type: 'for', test: $[3], update: $[5], body: $[7] })),
	RuleR('for', '(', for_init, ';', expression_opt, ';', expression_opt, ')', fwd_statement,	$ => ({ type: 'for', init: $[2], test: $[4], update: $[6], body: $[8] })),
	RuleR('for', '(', for_lhs, 'in', expression, ')', fwd_statement, 							$ => ({ type: 'for_in', kind: 'in', left: $[2], right: $[4], body: $[6] })),
	// 'of' takes an AssignmentExpression for the iterable (not a full Expression), same as the spec -- avoids the same comma-vs-separator ambiguity 'in' sidesteps via the NoIn chain.
	RuleR('for', '(', for_lhs, 'of', assignment_expression, ')', fwd_statement, 				$ => ({ type: 'for_in', kind: 'of', left: $[2], right: $[4], body: $[6] })),
);

const continue_statement = Rules<Statement>(
	RuleR('continue', ';',				_ => ({ type: 'continue' })),
	RuleR('continue', IDENT, ';',		$ => ({ type: 'continue', label: $[1] })),
);
const break_statement = Rules<Statement>(
	RuleR('break', ';',					_ => ({ type: 'break' })),
	RuleR('break', IDENT, ';',			$ => ({ type: 'break', label: $[1] })),
);
const return_statement = Rules<Statement>(
	RuleR('return', ';',				_ => ({ type: 'return' })),
	RuleR('return', expression, ';',	$ => ({ type: 'return', argument: $[1] })),
);
const with_statement = Rules<Statement>(
	RuleR('with', '(', expression, ')', fwd_statement, $ => ({ type: 'with', object: $[2], body: $[4] })),
);
const labelled_statement = Rules<Statement>(
	RuleR(IDENT, ':', fwd_statement,	$ => ({ type: 'labeled', label: $[0], body: $[2] })),
);

const case_clause = Rules<SwitchCase>(
	RuleR('case', expression, ':', 					$ => ({ test: $[1], consequent: [] })),
	RuleR('case', expression, ':', statement_list, 	$ => ({ test: $[1], consequent: $[3] })),
	RuleR('default', ':', 							_ => ({ consequent: [] })),
	RuleR('default', ':', statement_list, 			$ => ({ consequent: $[2] })),
);
const case_clauses = List(case_clause);
const switch_statement = Rules<Statement>(
	RuleR('switch', '(', expression, ')', '{', '}',					$ => ({ type: 'switch', discriminant: $[2], cases: [] })),
	RuleR('switch', '(', expression, ')', '{', case_clauses, '}',	$ => ({ type: 'switch', discriminant: $[2], cases: $[5] })),
);

const throw_statement = Rules<Statement>(
	RuleR('throw', expression, ';',				$ => ({ type: 'throw', argument: $[1] })),
);
const catch_ = Rules<{param: string; body: Statement[]}>(
	RuleR('catch', '(', IDENT, ')', '{', '}', 					$ => ({ param: $[2], body: [] as Statement[]})),
	RuleR('catch', '(', IDENT, ')', '{', statement_list, '}',	$ => ({ param: $[2], body: $[5] })),
);
const finally_ = Rules<Statement[]>(
	RuleR('finally', '{', '}',					() => []),
	RuleR('finally', '{', statement_list, '}',	$ => $[2]),
);
const try_block = Rules<Statement[]>(
	RuleR('try', '{', '}',						() => []),
	RuleR('try', '{', statement_list, '}',		$ => $[2]),
);
const try_statement = Rules<Statement>(
	RuleR(try_block, catch_, 					$ => ({ type: 'try', block: $[0], handlerParam: $[1].param, handlerBody: $[1].body })),
	RuleR(try_block, finally_, 					$ => ({ type: 'try', block: $[0], finalizer: $[1] })),
	RuleR(try_block, catch_, finally_, 			$ => ({ type: 'try', block: $[0], handlerParam: $[1].param, handlerBody: $[1].body, finalizer: $[2] })),
);

export const function_declaration = Rules<Statement>(
	RuleR('function', IDENT, parameter_clause, '{', fwd_function_body, '}', 				$ => ({ type: 'function_decl', name: $[1], params: $[2].params, rest: $[2].rest, body: $[4] })),
	RuleR('function', '*', IDENT, parameter_clause, '{', fwd_function_body, '}', 			$ => ({ type: 'function_decl', name: $[2], params: $[3].params, rest: $[3].rest, body: $[5], generator: true })),
	RuleR('async', 'function', IDENT, parameter_clause, '{', fwd_function_body, '}', 		$ => ({ type: 'function_decl', name: $[2], params: $[3].params, rest: $[3].rest, body: $[5], async: true })),
	RuleR('async', 'function', '*', IDENT, parameter_clause, '{', fwd_function_body, '}',	$ => ({ type: 'function_decl', name: $[3], params: $[4].params, rest: $[4].rest, body: $[6], generator: true, async: true }))
);
export const function_body = Rules<Statement[]>(
	RuleR((_: []) => []),
	RuleR(statement_list),
);

// --- Classes ---
// Static initialization blocks and private (`#name`) members aren't supported -- a known simplification.

export const class_member_name = Rules<string | { computed: Expr }>(
	RuleR(property_name),
	RuleR('[', assignment_expression, ']',	$ => ({ computed: $[1] })),
);
// Static-ness is split out from the member shape itself (rather than duplicating every method/field alternative once with 'static' and once without), so the combinatorics stay linear instead of doubling.
export const class_member_body = Rules<ClassMember>(
	RuleR(class_member_name, parameter_clause, '{', function_body, '}', 			$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: $[1].params, rest: $[1].rest, body: $[3] } })),
	RuleR('*', class_member_name, parameter_clause, '{', function_body, '}', 		$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], generator: true } })),
	RuleR('get', class_member_name, '(', ')', '{', function_body, '}', 				$ => ({ type: 'method', kind: 'get', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: [], body: $[5] } })),
	RuleR('set', class_member_name, '(', IDENT, ')', '{', function_body, '}', 		$ => ({ type: 'method', kind: 'set', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: [$[3] as string], body: $[6] } })),
	RuleR('async', class_member_name, parameter_clause, '{', function_body, '}', 	$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], async: true } })),
	RuleR('async', '*', class_member_name, parameter_clause, '{', function_body, '}', $ => ({ type: 'method', kind: 'method', key: $[2] as string | { computed: Expr }, value: { type: 'function', params: $[3].params, rest: $[3].rest, body: $[5], generator: true, async: true } })),
	RuleR(class_member_name, ';', 													$ => ({ type: 'field', key: $[0] as string | { computed: Expr } })),
	RuleR(class_member_name, '=', assignment_expression, ';', 						$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, value: $[2] })),
);
export const class_member = Rules<ClassMember>(
	RuleR(class_member_body),
	RuleR('static', class_member_body,		$ => ({ ...$[1], static: true })),
);
const class_member_list = List(class_member);
export const class_body = Rules<ClassMember[]>(
	RuleR('{', '}', 						() => []),
	RuleR('{', class_member_list, '}', 		$ => $[1]),
);
export const class_expression = Rules(
	RuleR('class', class_body, 													$ => ({ type: 'class', body: $[1] })),
	RuleR('class', IDENT, class_body, 											$ => ({ type: 'class', name: $[1], body: $[2] })),
	RuleR('class', 'extends', left_hand_side_expression, class_body, 			$ => ({ type: 'class', superClass: $[2], body: $[3] })),
	RuleR('class', IDENT, 'extends', left_hand_side_expression, class_body, 	$ => ({ type: 'class', name: $[1], superClass: $[3], body: $[4] })),
);
export const class_declaration = Rules<Statement>(
	RuleR('class', IDENT, class_body, 											$ => ({ type: 'class_decl', name: $[1], body: $[2] })),
	RuleR('class', IDENT, 'extends', left_hand_side_expression, class_body, 	$ => ({ type: 'class_decl', name: $[1], superClass: $[3], body: $[4] })),
);

export const statement = Rules<Statement>(
	RuleR(block),
	RuleR(variable_statement),
	RuleR(';', 					_ => ({ type: 'empty' })),
	RuleR(expression_statement),
	RuleR(if_statement),
	RuleR(iteration_statement),
	RuleR(continue_statement),
	RuleR(break_statement),
	RuleR(return_statement),
	RuleR(with_statement),
	RuleR(labelled_statement),
	RuleR(switch_statement),
	RuleR(throw_statement),
	RuleR(try_statement),
	RuleR('debugger', ';', 		_ => ({ type: 'debugger' })),
	RuleR(function_declaration),
	RuleR(class_declaration),
);

// --- Modules ---
// import/export are only reachable from `module_item`, used solely by `program`'s own top level below -- they're deliberately not part of `statement`, since the real spec restricts them to a Program's top level
const import_specifier = Rules<ImportSpecifier>(
	RuleR(IDENT, 												$ => ({ imported: $[0], local: $[0] })),
	RuleR(IDENT, 'as', IDENT,									$ => ({ imported: $[0], local: $[2] })),
);
const import_specifier_list = List(import_specifier, ',');
const named_imports = Rules<ImportSpecifier[]>(
	RuleR('{', '}', 											() => []),
	RuleR('{', import_specifier_list, '}', 						$ => $[1]),
	RuleR('{', import_specifier_list, ',', '}', 				$ => $[1]),
);
const import_declaration = Rules<Statement>(
	RuleR('import', STRING, ';', 										$ => ({ type: 'import', source: unquoteString($[1]) })),
	RuleR('import', IDENT, 'from', STRING, ';', 						$ => ({ type: 'import', default: $[1], source: unquoteString($[3]) })),
	RuleR('import', '*', 'as', IDENT, 'from', STRING, ';', 				$ => ({ type: 'import', namespace: $[3], source: unquoteString($[5]) })),
	RuleR('import', named_imports, 'from', STRING, ';', 				$ => ({ type: 'import', specifiers: $[1], source: unquoteString($[3]) })),
	RuleR('import', IDENT, ',', named_imports, 'from', STRING, ';', 	$ => ({ type: 'import', default: $[1], specifiers: $[3], source: unquoteString($[5]) })),
	RuleR('import', IDENT, ',', '*', 'as', IDENT, 'from', STRING, ';',	$ => ({ type: 'import', default: $[1], namespace: $[5], source: unquoteString($[7]) })),
);

const export_specifier = Rules<ExportSpecifier>(
	RuleR(IDENT,											$ => ({ local: $[0], exported: $[0] })),
	RuleR(IDENT, 'as', IDENT,								$ => ({ local: $[0], exported: $[2] })),
);
const export_specifier_list = List(export_specifier, ',');
const named_exports = Rules<ExportSpecifier[]>(
	RuleR('{', '}',											() => []),
	RuleR('{', export_specifier_list, '}',					$ => $[1]),
	RuleR('{', export_specifier_list, ',', '}',				$ => $[1]),
);
export const export_declaration = Rules<Statement>(
	RuleR('export', named_exports, ';', 					$ => ({ type: 'export_named', specifiers: $[1] })),
	RuleR('export', named_exports, 'from', STRING, ';', 	$ => ({ type: 'export_named', specifiers: $[1], source: unquoteString($[3]) })),
	RuleR('export', '*', 'from', STRING, ';', 				$ => ({ type: 'export_all', source: unquoteString($[3]) })),
	RuleR('export', '*', 'as', IDENT, 'from', STRING, ';', 	$ => ({ type: 'export_all', exported: $[3], source: unquoteString($[5]) })),
	RuleR('export', 'default', assignment_expression, ';', 	$ => ({ type: 'export_default', declaration: $[2] })),
	RuleR('export', 'default', function_declaration, 		$ => ({ type: 'export_default', declaration: $[2] })),
	RuleR('export', 'default', class_declaration, 			$ => ({ type: 'export_default', declaration: $[2] })),
	RuleR('export', variable_statement, 					$ => ({ type: 'export_decl', declaration: $[1] })),
	RuleR('export', function_declaration, 					$ => ({ type: 'export_decl', declaration: $[1] })),
	RuleR('export', class_declaration, 						$ => ({ type: 'export_decl', declaration: $[1] })),
);

export const module_item = Rules<Statement>(
	RuleR(import_declaration),
	RuleR(export_declaration),
	RuleR(statement),
);
const module_item_list = List(module_item);

export const program = Rules<Program>(
	RuleR((_: []) => ({ type: 'program', body: [] as Statement[] })),
	RuleR(module_item_list,					$ => ({ type: 'program', body: $[0] })),
);

// ===================================================================
//  Wire it up
// ===================================================================

// Exported as plain data (rather than only baked into `jsParser` below) so a
// grammar extension -- e.g. a TypeScript layer -- can build its *own*
// `tison()` call from `{ ...jsRules, ...tsRules }`, reusing this file's skip
// list and ASI `recover` policy unchanged, while also adding new top-level
// entries and/or mutating (pushing alternatives onto) any of these same
// exported arrays before that call happens.
export const jsSkip = [WS, /\/\/[^\n]*\n/, /\/\*[^]*?\*\//];

// Error-driven insertion: only when the real token would otherwise fail to parse, and is preceded by a line terminator, or is `}`, or EOF --
// found by name among this state's own valid actions, so tison resolves nothing on our behalf. "Preceded by a line terminator" isn't a
// special fact tison hands us -- it's just comparing this token's line against the previously-shifted one, the same line numbers every
// token already carries for error messages.
export const jsRecover: GrammarSpec['recover'] = (lex, row) => {
	const newlineBefore = lex.prev && lex.prev.pos && lex.line > lex.prev.pos.line;
	if (!(newlineBefore || lex.remaining.startsWith('}') || !lex.remaining))
		return undefined;
	const semi = [...row.keys()].find(t => t.name === ';');
	return semi && { type: semi, value: '' };
};

export const jsRules = {

binding_pattern,
binding_target,
primary_expression,
parameter,
formal_parameter_list,
parameter_clause,
function_expression,
member_expression,
arguments_,
call_expression,
left_hand_side_expression,
relational_expression,
arrow_body,
arrow_function,
assignment_expression,
assignment_expression_noin,
variable_declaration,
variable_declaration_noin,
variable_statement,
function_declaration,
function_body,
class_member_name,
class_member_body,
class_member,
class_body,
class_expression,
class_declaration,
statement,
export_declaration,
module_item,
program,

elision,
element_list,
array_literal,
property_name,
property_assignment,
property_list,
object_literal,
object_pattern_property,
object_pattern_property_list,
object_pattern,
array_pattern_element,
array_pattern_element_list,
array_pattern,
template_literal_part,
template_literal_parts,
new_expression,
argument_list,
postfix_expression,
unary_expression,
exponentiation_expression,
multiplicative_expression,
additive_expression,
shift_expression,
equality_expression,
bitwise_and_expression,
bitwise_xor_expression,
bitwise_or_expression,
logical_and_expression,
logical_or_expression,
relational_expression_noin,
equality_expression_noin,
bitwise_and_expression_noin,
bitwise_xor_expression_noin,
bitwise_or_expression_noin,
logical_and_expression_noin,
logical_or_expression_noin,
nullish_expression,
nullish_expression_noin,
conditional_expression,
conditional_expression_noin,
yield_expression,
expression,
expression_noin,
variable_declaration_list,
variable_declaration_list_noin,
statement_list,
block,
expression_statement,
if_statement,
for_init,
for_lhs,
expression_opt,
iteration_statement,
continue_statement,
break_statement,
return_statement,
with_statement,
labelled_statement,
case_clause,
case_clauses,
switch_statement,
throw_statement,
catch_,
finally_,
try_block,
try_statement,
class_member_list,
import_specifier,
import_specifier_list,
named_imports,
import_declaration,
export_specifier,
export_specifier_list,
named_exports,
module_item_list,
};

export const jsParser = makeParser({
	skip: jsSkip,
	recover: jsRecover,
	start: program,
	rules: jsRules
});
