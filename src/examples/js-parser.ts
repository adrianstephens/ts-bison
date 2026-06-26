import { tison, Rule, Rules, terminal, EOF, termOneOf, Forward, List, type GrammarSpec } from '../tison';

// ===================================================================
//  JavaScript Parser using tison
// ===================================================================
//
// Scope: full statement set, full expression precedence chain, function
// declarations/expressions/arrow functions, generators (function*/yield),
// async/await, classes (incl. extends, static/async/generator/computed
// members, fields, get/set -- not static blocks or private #names),
// var/let/const, destructuring (declarations, for-loops, parameters, with
// defaults/rest/nesting), object/array literals (incl. ES5 getter/setter,
// shorthand properties/methods, computed keys, holes), regex and template
// literals (incl. tagged templates), spread/rest, optional chaining,
// exponentiation, nullish coalescing, modules (import/export), with,
// debugger, labeled statements. get/set are only recognized as such inside
// object-literal property assignments -- elsewhere they're not treated as
// identifiers (a known simplification). 'async'/'await'/'yield'/'static'/
// 'get'/'set'/etc. are all treated as fully reserved words rather than the
// real spec's contextual keywords (another deliberate simplification).
//
// This grammar is the proving ground for tison's general-purpose lexer
// extension points (see src/tison.ts -- none of them know anything about
// JavaScript, ASI, or semicolons; the policy below is entirely local to
// this file):
//   - Terminal.lex: a single callback, invoked once a terminal's
//     pattern has matched, that can accept the match, reject it (so a
//     shorter match from a different terminal wins instead), or
//     reclassify it as a different terminal. REGEX_LITERAL uses this to
//     reject itself when the previous token shows a '/' here must be
//     division, not the start of a regex. A whitespace/newline skip
//     terminal uses the same hook (with `peekNext` to look past itself)
//     to reclassify a run of whitespace into a semicolon -- this is how
//     ECMAScript's "restricted productions" are implemented below, with
//     zero ASI-specific concepts in tison itself.
//   - GrammarSpec.recover: a single error-recovery callback -- if the
//     real lookahead has no action, it's given the state's valid actions
//     and the offending token, and can substitute a different token to
//     retry with. This covers ASI's other half: inserting `;` only when
//     the real token would otherwise fail to parse.

// --- Terminals ---

export const IDENT		= terminal('identifier', /[a-zA-Z_$][a-zA-Z0-9_$]*/);
export const NUMBER		= terminal('number', /0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?|0[oO][0-7](?:_?[0-7])*n?|0[bB][01](?:_?[01])*n?|[0-9](?:_?[0-9])*n|(?:[0-9](?:_?[0-9])*\.(?:[0-9](?:_?[0-9])*)?|\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*)(?:[eE][-+]?[0-9]+)?/);
export const STRING		= terminal('string', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/);
const ASSIGN_OP		= /(?:>>>|<<|>>|[+\-*/%&^|])?=/;

// Automatic Semicolon Insertion
const RESTRICTED_AFTER	= new Set(['return', 'throw', 'break', 'continue', 'yield']);
const RESTRICTED_BEFORE = new Set(['++', '--']);

// Restricted productions: reclassify a run of whitespace into a semicolon (unconditionally -- even though the real token would otherwise have parsed fine) when it contains a line terminator right after return/throw/break/continue, or right before postfix ++/--.
const WS = terminal('ws',
	/\s+/,
	lex => {
		if (!lex.text.includes('\n'))
			return WS;
		if (lex.prev && RESTRICTED_AFTER.has(lex.prev.name))
			return ';';
		const next = lex.peekNext();
		if (next && RESTRICTED_BEFORE.has(next.type.name))
			return ';';
		//const next = /\s*.*/.exec(peekText());
		//if (next && RESTRICTED_BEFORE.has(next[1]))
		//	return ';';
		return WS;
	}
);

// A '/' starts a regex literal unless the previous token could itself end an expression (identifier, number, string, ')', ']', '++', '--', or a literal keyword-value) -- in which case '/' has to be division.
const regexDisallowedAfter = new Set([
	IDENT.name, NUMBER.name, STRING.name,
	')', ']', '++', '--', 'this', 'true', 'false', 'null'
]);

const REGEX_LITERAL = terminal('regex',
	/\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-zA-Z]*/,
	({ prev }) => (!prev || !regexDisallowedAfter.has(prev.name)) ? REGEX_LITERAL : undefined
);


export const VAR_KEYWORDS = ['var', 'let', 'const'] as const;

// --- AST types ---

export interface Identifier	{ type: 'identifier'; name: string; }
export type Literal =
	| { type: 'literal'; value: number | string | boolean | null }
	| { type: 'regex'; pattern: string; flags: string }
	| { type: 'bigint'; value: string };	// because bigint can't round-trip through JSON.stringify

export interface TemplatePart { str: string; exp?: Expr; }
export interface ObjectProperty { key: string | { computed: Expr }; value: Expr; kind: 'init' | 'get' | 'set'; }

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
export interface ParamList { params: Param[]; rest?: string; }

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
	| { type: 'new'; callee: Expr; arguments: Expr[] }
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
	| { type: 'function_decl'; name: string; params: Param[]; rest?: string; body: Statement[]; generator?: boolean; async?: boolean; returnType?: unknown; typeParams?: unknown[] }
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

export const varKeywords = termOneOf(VAR_KEYWORDS);

// Two parallel chains exist above shift_expression: the normal one (allows 'in' as a relational operator) and a "NoIn" one (excludes it), mirroring ECMA-262's own duplication
// It's needed because `for (x in y)` and `for (x; ...)` would otherwise be ambiguous as to whether 'in' continues a RelationalExpression or marks the for-in separator.
// NoIn variants are used only inside for-loop headers.
function binaryChain(lower: Rules<Expr>, ops: string[], prec: string, kind: 'binary' | 'logical' = 'binary') {
	return Rules<Expr>(self => [
		Rule([lower] as const, $ => $[0]),
		Rule([self, termOneOf(ops), lower] as const, $ =>	({ type: kind, operator: $[1], left: $[0], right: $[2] } as const), prec)
	]);
}

// Single-quoted strings are re-quoted to double quotes so JSON.parse can unescape them the same way as already-double-quoted ones -- STRING's own pattern accepts either.
export const unquoteString = (s: string) => JSON.parse(s.replace(/^'|'$/g, '"')) as string;

const fwd_parameter_clause		= () => parameter_clause;
const fwd_assignment_expression	= Forward<Expr>(() => assignment_expression);
const fwd_function_body 		= Forward<Statement[]>(() => function_body);
const fwd_statement				= Forward<Statement>(() => statement);
const fwd_expression			= Forward<Expr>(() => expression);

// --- Primary / member / call / new chain ---

// `elision`: a run of N commas with nothing between them, i.e. N holes -- shared by array literals and array patterns.
// A *single* trailing comma after a real element (the existing `'[', element_list, ',', ']'` shape below) is just a separator and creates no hole, matching real JS;
// an elision only starts counting from the *next* comma onward.
const elision = Rules<number>(self => [
	Rule([','] as const, 		() => 1),
	Rule([self, ','] as const,	$ => ($[0] as number) + 1),
]);
const holes = (n: number) => Array<undefined>(n).fill(undefined);

const element_list = Rules<(Expr | undefined)[]>(self => [
	Rule([fwd_assignment_expression] as const, 								$ => [$[0]]),
	Rule([elision, fwd_assignment_expression] as const, 					$ => [...holes($[0] as number), $[1]]),
	Rule([self, ',', fwd_assignment_expression] as const, 					$ => [...$[0], $[2]]),
	Rule([self, ',', elision, fwd_assignment_expression] as const, 			$ => [...$[0], ...holes($[2] as number), $[3]]),
	Rule(['...', fwd_assignment_expression] as const, 						$ => [{ type: 'spread', argument: $[1] } as const]),
	Rule([elision, '...', fwd_assignment_expression] as const, 				$ => [...holes($[0] as number), { type: 'spread', argument: $[2] } as const]),
	Rule([self, ',', '...', fwd_assignment_expression] as const, 			$ => [...$[0], { type: 'spread', argument: $[3] } as const]),
	Rule([self, ',', elision, '...', fwd_assignment_expression] as const,	$ => [...$[0], ...holes($[2] as number), { type: 'spread', argument: $[4] } as const]),
]);
const array_literal = Rules(
	Rule(['[', ']'] as const, 												() => ({ type: 'array', elements: [] } as const)),
	Rule(['[', elision, ']'] as const, 										$ => ({ type: 'array', elements: holes($[1]) } as const)),
	Rule(['[', element_list, ']'] as const, 								$ => ({ type: 'array', elements: $[1] } as const)),
	Rule(['[', element_list, ',', ']'] as const, 							$ => ({ type: 'array', elements: $[1] } as const)),
	Rule(['[', element_list, ',', elision, ']'] as const, 					$ => ({ type: 'array', elements: [...$[1], ...holes($[3] as number)] } as const)),
);

const property_name = Rules(
	Rule([IDENT] as const, $ => $[0]),
	Rule([STRING] as const, $ => unquoteString($[0])),
	Rule([NUMBER] as const, $ => $[0]),
);
const property_assignment = Rules<ObjectProperty>(
	Rule([property_name, ':', fwd_assignment_expression] as const, 									$ => ({ key: $[0], value: $[2], kind: 'init' } as const)),
	Rule(['get', property_name, '(', ')', '{', fwd_function_body, '}'] as const, 					$ => ({ key: $[1], value: { type: 'function', params: [], body: $[5] }, kind: 'get' } as const)),
	Rule(['set', property_name, '(', IDENT, ')', '{', fwd_function_body, '}'] as const, 			$ => ({ key: $[1], value: { type: 'function', params: [$[3]], body: $[6] }, kind: 'set' } as const)),
	// Shorthand property: `{x}` is `{x: x}`.
	Rule([IDENT] as const, 																			$ => ({ key: $[0], value: { type: 'identifier', name: $[0] }, kind: 'init' } as const)),
	// `{x = 1}` is never valid as a *real* object literal (only inside a destructuring target) -- accepted here anyway, permissively, purely so arrow-function parameters can be parsed as a plain object literal and reinterpreted as a pattern afterward (see `exprToBindingTarget` below).
	// A real object literal with this shape only arises if that reinterpretation is never attempted, which this grammar doesn't catch.
	Rule([IDENT, '=', fwd_assignment_expression] as const, 											$ => ({ key: $[0], value: { type: 'assign', operator: '=', left: { type: 'identifier', name: $[0] }, right: $[2] }, kind: 'init' } as const)),
	// Shorthand method: `{foo() {...}}` is `{foo: function() {...}}`.
	Rule([property_name, fwd_parameter_clause, '{', fwd_function_body, '}'] as const, 				$ => ({ key: $[0], value: { type: 'function', params: $[1].params, rest: $[1].rest, body: $[3] }, kind: 'init' } as const)),
	// Generator method: `{*foo() {...}}` is `{foo: function*() {...}}`.
	Rule(['*', property_name, fwd_parameter_clause, '{', fwd_function_body, '}'] as const, 			$ => ({ key: $[1], value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], generator: true }, kind: 'init' } as const)),
	// Async method: `{async foo() {...}}` is `{foo: async function() {...}}`.
	Rule(['async', property_name, fwd_parameter_clause, '{', fwd_function_body, '}'] as const, 		$ => ({ key: $[1], value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], async: true }, kind: 'init' } as const)),
	Rule(['async', '*', property_name, fwd_parameter_clause, '{', fwd_function_body, '}'] as const, $ => ({ key: $[2], value: { type: 'function', params: $[3].params, rest: $[3].rest, body: $[5], generator: true, async: true }, kind: 'init' } as const)),
	// Computed key: `{[expr]: value}` -- only supported for the plain key:value form, not get/set/shorthand-method.
	Rule(['[', fwd_assignment_expression, ']', ':', fwd_assignment_expression] as const, 			$ => ({ key: { computed: $[1] }, value: $[4], kind: 'init' } as const)),
);
const property_list = List(property_assignment, ',');

const object_literal = Rules(
	Rule(['{', '}'] as const, 						() => ({ type: 'object', properties: [] as ObjectProperty[] } as const)),
	Rule(['{', property_list, '}'] as const, 		$ => ({ type: 'object', properties: $[1] } as const)),
	Rule(['{', property_list, ',', '}'] as const, 	$ => ({ type: 'object', properties: $[1] } as const)),
);

// --- Destructuring binding patterns ---
// Only reachable from contexts that are unambiguously a binding position (right after 'var'/'let'/'const', or inside a parameter list) -- never
// from general expression position, so there's no grammar conflict with object_literal/array_literal despite the shared '{'/'[' tokens.

export const binding_pattern = Rules<ObjectPattern | ArrayPattern>(
	Rule([Forward<ObjectPattern>(()=>object_pattern)] as const,	$ => $[0]),
	Rule([Forward<ArrayPattern>(()=>array_pattern)] as const,	$ => $[0]),
);
export const binding_target = Rules<BindingTarget>(
	Rule([IDENT] as const,				$ => $[0]),
	...binding_pattern,
);

const object_pattern_property = Rules(
	// Shorthand: `{a}` or `{a = 1}`, binding directly to a same-named local.
	Rule([IDENT] as const, 															$ => ({ key: $[0], value: $[0] } as const)),
	Rule([IDENT, '=', fwd_assignment_expression] as const, 							$ => ({ key: $[0], value: $[0], default: $[2] } as const)),
	// Renamed/nested: `{a: b}`, `{a: b = 1}`, `{a: {b}}`, etc.
	Rule([IDENT, ':', binding_target] as const, 									$ => ({ key: $[0], value: $[2] } as const)),
	Rule([IDENT, ':', binding_target, '=', fwd_assignment_expression] as const, 	$ => ({ key: $[0], value: $[2], default: $[4] } as const)),
);
const object_pattern_property_list = List(object_pattern_property, ',');
const object_pattern = Rules<ObjectPattern>(
	Rule(['{', '}'] as const, 														() => ({ type: 'object_pattern', properties: [] } as const)),
	Rule(['{', object_pattern_property_list, '}'] as const, 						$ => ({ type: 'object_pattern', properties: $[1] } as const)),
	Rule(['{', object_pattern_property_list, ',', '}'] as const, 					$ => ({ type: 'object_pattern', properties: $[1] } as const)),
	Rule(['{', '...', IDENT, '}'] as const, 										$ => ({ type: 'object_pattern', properties: [], rest: $[2] } as const)),
	Rule(['{', object_pattern_property_list, ',', '...', IDENT, '}'] as const, 		$ => ({ type: 'object_pattern', properties: $[1], rest: $[4] } as const)),
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
const array_pattern = Rules<ArrayPattern>(
	Rule(['[', ']'] as const, 														() => ({ type: 'array_pattern', elements: [] as undefined[]} as const)),
	Rule(['[', elision, ']'] as const, 												$ => ({ type: 'array_pattern', elements: holes($[1]) } as const)),
	Rule(['[', array_pattern_element_list, ']'] as const, 							$ => ({ type: 'array_pattern', elements: $[1] } as const)),
	Rule(['[', array_pattern_element_list, ',', ']'] as const, 						$ => ({ type: 'array_pattern', elements: $[1] } as const)),
	Rule(['[', array_pattern_element_list, ',', elision, ']'] as const, 			$ => ({ type: 'array_pattern', elements: [...$[1], ...holes($[3] as number)] } as const)),
	Rule(['[', '...', IDENT, ']'] as const, 										$ => ({ type: 'array_pattern', elements: [] as undefined[], rest: $[2] } as const)),
	Rule(['[', array_pattern_element_list, ',', '...', IDENT, ']'] as const, 		$ => ({ type: 'array_pattern', elements: $[1], rest: $[4] } as const)),
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
		case 'object':		return {
			type: 'object_pattern',
			properties: e.properties.map(p => {
				if (typeof p.key !== 'string')
					throw new SyntaxError('Invalid destructuring target: computed key');
				return p.value.type === 'assign'
					? { key: p.key, value: exprToBindingTarget(p.value.left), default: p.value.right }
					: { key: p.key, value: exprToBindingTarget(p.value) };
			}),
		};
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
	Rule([/(?:[^`$]|\\\$(?!\{))*(?=\$\{)/, '${', fwd_expression, '}'] as const,	$ => ({ str: $[0], exp: $[2] })),
	Rule([/(?:[^`$]|\\\$(?!\{))*(?=`)/] as const, 									$ => ({ str: $[0] })),
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

export const primary_expression = Rules(
	Rule(['this'] as const, 					() => ({ type: 'this' } as const)),
	Rule([IDENT] as const,						$ => ({ type: 'identifier', name: $[0] } as const)),
	Rule([NUMBER] as const, 					$ => parseNumber($[0])),
	Rule([STRING] as const, 					$ => ({ type: 'literal', value: unquoteString($[0]) } as const)),
	Rule([REGEX_LITERAL] as const,				$ => { const m = /^\/(.*)\/([a-zA-Z]*)$/.exec($[0])!; return { type: 'regex', pattern: m[1], flags: m[2] } as const; }),
	Rule(['true'] as const, 					() => ({ type: 'literal', value: true } as const)),
	Rule(['false'] as const,					() => ({ type: 'literal', value: false } as const)),
	Rule(['null'] as const,						() => ({ type: 'literal', value: null } as const)),
	Rule([array_literal] as const,				$ => $[0]),
	Rule([object_literal] as const,				$ => $[0]),
	Rule(['(', fwd_expression, ')'] as const, 	$ => $[1]),
	Rule(['`', template_literal_parts, '`'],	$ => ({ type: 'literal', value: $[1] } as Expr))
);

// A single parameter: a bare name, a name with a default, or a destructured (optionally defaulted) target. Plain identifiers stay bare strings, same convention as elsewhere in this file -- only the richer forms wrap.
export const parameter = Rules<Param>(
	Rule([IDENT] as const,											$ => $[0]),
	Rule([IDENT, '=', fwd_assignment_expression] as const,			$ => ({ target: $[0], default: $[2] })),
	Rule([object_pattern] as const,									$ => ({ target: $[0] } as const)),
	Rule([object_pattern, '=', fwd_assignment_expression] as const,	$ => ({ target: $[0], default: $[2] })),
	Rule([array_pattern] as const,									$ => ({ target: $[0] } as const)),
	Rule([array_pattern, '=', fwd_assignment_expression] as const,	$ => ({ target: $[0], default: $[2] })),
);
export const formal_parameter_list = List(parameter, ',');

// A full `(...)` parameter clause, with an optional trailing `...rest`.
// Shared by function expressions/declarations and object-literal shorthand methods, so rest-parameter support lands in all three at once.
// Rest itself stays a bare identifier (a known simplification -- the real spec also allows a destructuring pattern there).
export const parameter_clause = Rules<ParamList>(
	Rule(['(', ')'] as const, 											() => ({ params: [] } as const)),
	Rule(['(', formal_parameter_list, ')'] as const, 					$ => ({ params: $[1] } as const)),
	Rule(['(', '...', IDENT, ')'] as const, 							$ => ({ params: [], rest: $[2] } as const)),
	Rule(['(', formal_parameter_list, ',', '...', IDENT, ')'] as const, $ => ({ params: $[1], rest: $[4] } as const)),
);
export const function_expression = Rules(
	Rule(['function', parameter_clause, '{', fwd_function_body, '}'] as const, 						$ => ({ type: 'function', params: $[1].params, rest: $[1].rest, body: $[3] } as const)),
	Rule(['function', IDENT, parameter_clause, '{', fwd_function_body, '}'] as const, 				$ => ({ type: 'function', name: $[1], params: $[2].params, rest: $[2].rest, body: $[4] } as const)),
	Rule(['function', '*', parameter_clause, '{', fwd_function_body, '}'] as const, 				$ => ({ type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], generator: true } as const)),
	Rule(['function', '*', IDENT, parameter_clause, '{', fwd_function_body, '}'] as const, 			$ => ({ type: 'function', name: $[2], params: $[3].params, rest: $[3].rest, body: $[5], generator: true } as const)),
	Rule(['async', 'function', parameter_clause, '{', fwd_function_body, '}'] as const, 			$ => ({ type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], async: true } as const)),
	Rule(['async', 'function', IDENT, parameter_clause, '{', fwd_function_body, '}'] as const, 		$ => ({ type: 'function', name: $[2], params: $[3].params, rest: $[3].rest, body: $[5], async: true } as const)),
	Rule(['async', 'function', '*', parameter_clause, '{', fwd_function_body, '}'] as const, 		$ => ({ type: 'function', params: $[3].params, rest: $[3].rest, body: $[5], generator: true, async: true } as const)),
	Rule(['async', 'function', '*', IDENT, parameter_clause, '{', fwd_function_body, '}'] as const, $ => ({ type: 'function', name: $[3], params: $[4].params, rest: $[4].rest, body: $[6], generator: true, async: true } as const))
);

export const member_expression = Rules<Expr>(self => [
	Rule([primary_expression] as const, 									$ => $[0]),
	Rule([function_expression] as const, 									$ => $[0]),
	Rule([Forward(()=>class_expression)] as const,							$ => $[0] as Expr),
	Rule([self, '.', IDENT] as const, 										$ => ({ type: 'member', object: $[0], property: $[2] } as const)),
	Rule([self, '[', fwd_expression, ']'] as const, 						$ => ({ type: 'index', object: $[0], property: $[2] } as const)),
	Rule(['new', self, ()=>arguments_] as const, 							$ => ({ type: 'new', callee: $[1], arguments: $[2] as Expr[] } as const)),
]);
const new_expression = Rules<Expr>(self => [
	Rule([member_expression] as const, 										$ => $[0]),
	Rule(['new', self] as const, 											$ => ({ type: 'new', callee: $[1], arguments: [] } as const)),
]);
const argument_list = Rules<Expr[]>(self => [
	Rule([fwd_assignment_expression] as const, 								$ => [$[0]]),
	Rule([self, ',', fwd_assignment_expression] as const, 					$ => [...($[0]), $[2]]),
	Rule(['...', fwd_assignment_expression] as const, 						$ => [{ type: 'spread', argument: $[1] } as const]),
	Rule([self, ',', '...', fwd_assignment_expression] as const, 			$ => [...($[0]), { type: 'spread', argument: $[3] } as const]),
]);
export const arguments_ = Rules(
	Rule(['(', ')'] as const, 												() => []),
	Rule(['(', argument_list, ')'] as const, 								$ => $[1] as Expr[]),
);
export const call_expression = Rules<Expr>(self => [
	Rule([member_expression, arguments_] as const, 							$ => ({ type: 'call', callee: $[0], arguments: $[1] } as const)),
	Rule([self, arguments_] as const, 										$ => ({ type: 'call', callee: $[0], arguments: $[1] } as const)),
	Rule([self, '.', IDENT] as const, 										$ => ({ type: 'member', object: $[0], property: $[2] } as const)),
	Rule([self, '[', fwd_expression, ']'] as const, 						$ => ({ type: 'index', object: $[0], property: $[2] } as const)),
	// Tagged template: `tag\`...\`` is structurally a call, just with a
	// template literal instead of a parenthesized argument list.
	Rule([member_expression, '`', template_literal_parts, '`'] as const, 	$ => ({ type: 'tagged_template', tag: $[0], quasi: $[2] } as const)),
	Rule([self, '`', template_literal_parts, '`'] as const,					$ => ({ type: 'tagged_template', tag: $[0], quasi: $[2] } as const)),
	// Optional chaining: each `?.` step only marks itself optional -- this/ syntax-only grammar doesn't track or enforce the real short-circuiting
	// semantics (the rest of a chain skipping evaluation once one step is/ nullish), same as other non-syntactic restrictions elsewhere here.
	Rule([member_expression, '?.', IDENT] as const, 						$ => ({ type: 'member', object: $[0], property: $[2], optional: true } as const)),
	Rule([self, '?.', IDENT] as const, 										$ => ({ type: 'member', object: $[0], property: $[2], optional: true } as const)),
	Rule([member_expression, '?.', '[', fwd_expression, ']'] as const, 		$ => ({ type: 'index', object: $[0], property: $[3], optional: true } as const)),
	Rule([self, '?.', '[', fwd_expression, ']'] as const, 					$ => ({ type: 'index', object: $[0], property: $[3], optional: true } as const)),
	Rule([member_expression, '?.', arguments_] as const, 					$ => ({ type: 'call', callee: $[0], arguments: $[2], optional: true } as const)),
	Rule([self, '?.', arguments_] as const, 								$ => ({ type: 'call', callee: $[0], arguments: $[2], optional: true } as const)),
]);
export const left_hand_side_expression = Rules(
	Rule([new_expression] as const, $ => $[0]),
	Rule([call_expression] as const, $ => $[0]),
);

// --- Unary / update / binary precedence chain ---
// Postfix ++/-- doesn't need to worry about the "no line terminator before
// ++/--" restricted production here: WS's `lex` callback (see below)
// already reclassifies the preceding whitespace into a semicolon at the
// lexer level before either token ever reaches the parser.

const postfix_expression = Rules(
	Rule([left_hand_side_expression] as const, 			$ => $[0]),
	Rule([left_hand_side_expression, '++'] as const,	$ => ({ type: 'update', operator: '++', argument: $[0], prefix: false } as const)),
	Rule([left_hand_side_expression, '--'] as const,	$ => ({ type: 'update', operator: '--', argument: $[0], prefix: false } as const)),
);
const unary_expression = Rules<Expr>(self => [
	Rule([postfix_expression] as const, $ => $[0]),
	Rule(['delete', self] as const, 	$ => ({ type: 'unary', operator: 'delete', argument: $[1], prefix: true } as const)),
	Rule(['void', self] as const, 		$ => ({ type: 'unary', operator: 'void', argument: $[1], prefix: true } as const)),
	Rule(['typeof', self] as const, 	$ => ({ type: 'unary', operator: 'typeof', argument: $[1], prefix: true } as const)),
	// Unlike `yield`, `await` always requires an operand -- no ASI/restricted production handling needed, same as `typeof`/`void`/`delete` above.
	// This grammar doesn't enforce that `await` only appears inside an async function, same as other non-syntactic restrictions elsewhere here.
	Rule(['await', self] as const, 		$ => ({ type: 'await', argument: $[1] } as const)),
	Rule(['++', self] as const, 		$ => ({ type: 'update', operator: '++', argument: $[1], prefix: true } as const)),
	Rule(['--', self] as const, 		$ => ({ type: 'update', operator: '--', argument: $[1], prefix: true } as const)),
	Rule(['+', self] as const, 			$ => ({ type: 'unary', operator: '+', argument: $[1], prefix: true } as const)),
	Rule(['-', self] as const, 			$ => ({ type: 'unary', operator: '-', argument: $[1], prefix: true } as const)),
	Rule(['~', self] as const, 			$ => ({ type: 'unary', operator: '~', argument: $[1], prefix: true } as const)),
	Rule(['!', self] as const, 			$ => ({ type: 'unary', operator: '!', argument: $[1], prefix: true } as const)),
]);

// Right-associative: 2 ** 3 ** 2 === 2 ** (3 ** 2). Spelled as a dedicated
// self-recursion on the right (rather than binaryChain's left-recursion)
// since right-associativity needs the recursive reference on the other side.
const exponentiation_expression = Rules<Expr>(self => [
	Rule([unary_expression] as const, $ => $[0]),
	Rule([unary_expression, '**', self] as const, $ => ({ type: 'binary', operator: '**', left: $[0], right: $[2] } as const), 'exponentiation'),
]);

const multiplicative_expression		= binaryChain(exponentiation_expression,	['*', '/', '%'], 							'multiplicative');
const additive_expression			= binaryChain(multiplicative_expression,	['+', '-'], 								'additive');
const shift_expression				= binaryChain(additive_expression,			['<<', '>>', '>>>'], 						'shift');

export const relational_expression			= binaryChain(shift_expression,				['<', '>', '<=', '>=', 'instanceof', 'in'], 'relational');
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

const conditional_expression = Rules(
	Rule([nullish_expression] as const, $ => $[0]),
	Rule([nullish_expression, '?', fwd_assignment_expression, ':', fwd_assignment_expression] as const, $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] } as const)),
);
const conditional_expression_noin = Rules(
	Rule([nullish_expression_noin] as const, $ => $[0]),
	Rule([nullish_expression_noin, '?', fwd_assignment_expression, ':', Forward<Expr>(()=>assignment_expression_noin)] as const, $ => ({ type: 'conditional', test: $[0], consequent: $[2], alternate: $[4] } as const)),
);

// `'(' expression ')'` here is the *same* parse primary_expression's own parenthesized-expression rule produces
// -- the grammar doesn't try to predict an arrow function inside the parens at all (see exprToParams above);
// it only diverges from a plain parenthesized expression on the `=>` lookahead that follows the closing `)`, which is an ordinary, conflict-free one-token decision for an LR parser.
//
// Arrow functions aren't offered from assignment_expression_noin: they'd only matter inside a for-loop header's init/test/update clauses, where nobody realistically writes one, so that duplication isn't worth it here.
export const arrow_body = Rules<Expr | Statement[]>(
	Rule(['{', '}'] as const, 										() => [] as Statement[]),
	Rule(['{', Forward(()=>statement_list), '}'] as const, 			$ => $[1] as Statement[]),
	Rule([fwd_assignment_expression] as const, 						$ => $[0]),
);
export const arrow_function = Rules<Expr>(
	Rule([IDENT, '=>', arrow_body] as const, 												$ => ({ type: 'arrow', params: [$[0]], body: $[2] } as const)),
	Rule(['(', ')', '=>', arrow_body] as const, 											$ => ({ type: 'arrow', params: [], body: $[3] } as const)),
	Rule(['(', '...', IDENT, ')', '=>', arrow_body] as const, 								$ => ({ type: 'arrow', params: [], rest: $[2], body: $[5] } as const)),
	Rule(['(', fwd_expression, ')', '=>', arrow_body] as const, 							$ => ({ type: 'arrow', params: exprToParams($[1]), body: $[4] } as const)),
	Rule(['(', fwd_expression, ',', '...', IDENT, ')', '=>', arrow_body] as const, 			$ => ({ type: 'arrow', params: exprToParams($[1]), rest: $[4], body: $[7] } as const)),
	Rule(['async', IDENT, '=>', arrow_body] as const, 										$ => ({ type: 'arrow', params: [$[1]], body: $[3], async: true } as const)),
	Rule(['async', '(', ')', '=>', arrow_body] as const, 									$ => ({ type: 'arrow', params: [], body: $[4], async: true } as const)),
	Rule(['async', '(', '...', IDENT, ')', '=>', arrow_body] as const, 						$ => ({ type: 'arrow', params: [], rest: $[3], body: $[6], async: true } as const)),
	Rule(['async', '(', fwd_expression, ')', '=>', arrow_body] as const, 					$ => ({ type: 'arrow', params: exprToParams($[2]), body: $[5], async: true } as const)),
	Rule(['async', '(', fwd_expression, ',', '...', IDENT, ')', '=>', arrow_body] as const,	$ => ({ type: 'arrow', params: exprToParams($[2]), rest: $[5], body: $[8], async: true } as const)),
);

// `yield` with no argument relies on the same restricted-production/ASI
// machinery as `return` (see RESTRICTED_AFTER below) to stop a following
// token from being swallowed as its argument across a line break.
const yield_expression = Rules(
	Rule(['yield'] as const, 										() => ({ type: 'yield' } as const)),
	Rule(['yield', fwd_assignment_expression] as const, 			$ => ({ type: 'yield', argument: $[1] } as const)),
	Rule(['yield', '*', fwd_assignment_expression] as const, 		$ => ({ type: 'yield', argument: $[2], delegate: true } as const)),
);

export const assignment_expression = Rules<Expr>(self => [
	Rule([left_hand_side_expression, ASSIGN_OP, self] as const, 	$ => ({ type: 'assign', operator: $[1], left: $[0], right: $[2] } as const)),
	Rule([conditional_expression] as const, 						$ => $[0]),
	Rule([arrow_function] as const, 								$ => $[0]),
	Rule([yield_expression] as const, 								$ => $[0]),
]);
export const assignment_expression_noin = Rules<Expr>(self => [
	Rule([left_hand_side_expression, ASSIGN_OP, self] as const, 	$ => ({ type: 'assign', operator: $[1], left: $[0], right: $[2] } as const)),
	Rule([conditional_expression_noin] as const,					$ => $[0]),
]);

const expression = Rules<Expr>(self => [
	Rule([assignment_expression] as const,							$ => $[0]),
	Rule([self, ',', assignment_expression] as const,				$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] } as const))
]);
const expression_noin = Rules<Expr>(self => [
	Rule([assignment_expression_noin] as const,						$ => $[0]),
	Rule([self, ',', assignment_expression_noin] as const,			$ => ({ type: 'sequence', expressions: $[0].type === 'sequence' ? [...$[0].expressions, $[2]] : [$[0], $[2]] }))
]);

// --- Statements ---

// Destructuring declarations always require an initializer (`const {a};` isn't valid JS, since there'd be nothing to destructure) -- so unlike the plain-identifier alternative, there's no pattern-only rule here
export const variable_declaration = Rules<VarDeclarator>(
	Rule([IDENT] as const, 												$ => ({ name: $[0] } as const)),
	Rule([IDENT, '=', assignment_expression] as const, 					$ => ({ name: $[0], init: $[2] } as const)),
	Rule([binding_pattern, '=', assignment_expression] as const, 		$ => ({ name: $[0], init: $[2] } as const)),
);
const variable_declaration_list = List(variable_declaration, ',');
export const variable_declaration_noin = Rules<VarDeclarator>(
	Rule([IDENT] as const, 												$ => ({ name: $[0] } as const)),
	Rule([IDENT, '=', assignment_expression_noin] as const, 			$ => ({ name: $[0], init: $[2] } as const)),
	Rule([binding_pattern, '=', assignment_expression_noin] as const, 	$ => ({ name: $[0], init: $[2] } as const)),
);
const variable_declaration_list_noin = List(variable_declaration_noin, ',');

export const variable_statement = Rules<Statement>(
	Rule([varKeywords, variable_declaration_list, ';'] as const, $ => ({ type: 'var', kind: $[0], declarations: $[1] } as const))
);

const statement_list = Rules<Statement[]>(self => [
	Rule([fwd_statement] as const,						$ => [$[0]]),
	Rule([self, fwd_statement] as const,				$ => [...$[0], $[1]]),
]);
const block = Rules<Statement>(
	Rule(['{', '}'] as const,							() => ({ type: 'block', body: [] } as const)),
	Rule(['{', statement_list, '}'] as const,			$ => ({ type: 'block', body: $[1] } as const)),
);

const expression_statement = Rules(
	Rule([expression, ';'] as const,					$ => ({ type: 'expression', expression: $[0] } as const)),
);

const if_statement = Rules(
	Rule(['if', '(', expression, ')', fwd_statement] as const,							$ => ({ type: 'if', test: $[2], consequent: $[4] } as const)),
	Rule(['if', '(', expression, ')', fwd_statement, 'else', fwd_statement] as const,	$ => ({ type: 'if', test: $[2], consequent: $[4], alternate: $[6] } as const)),
);

const for_init = Rules<ForInit>(
	Rule([varKeywords, variable_declaration_list_noin] as const,			$ => ({ type: 'var', kind: $[0], declarations: $[1]} as const)),
	Rule([expression_noin] as const,										$ => $[0]),
);
const for_lhs = Rules<ForInit>(
	Rule([varKeywords, variable_declaration_noin] as const,					$ => ({ type: 'var', kind: $[0], declarations: [$[1]] } as const)),
	// `for (const {a} of arr)` -- a for-in/of binding has no initializer, so (unlike variable_declaration_noin) the pattern stands alone here.
	Rule([varKeywords, binding_pattern] as const,							$ => ({ type: 'var', kind: $[0], declarations: [{ name: $[1] }] } as const)),
	Rule([left_hand_side_expression] as const,								$ => $[0]),
);

const expression_opt = Rules(
	Rule([] as const,			() => undefined),
	Rule([expression] as const, $ => $[0]),
);

const iteration_statement = Rules<Statement>(
	Rule(['do', fwd_statement, 'while', '(', expression, ')', ';'] as const, 							$ => ({ type: 'do_while', body: $[1], test: $[4] } as const)),
	Rule(['while', '(', expression, ')', fwd_statement] as const, 										$ => ({ type: 'while', test: $[2], body: $[4] } as const)),
	Rule(['for', '(', ';', expression_opt, ';', expression_opt, ')', fwd_statement] as const, 			$ => ({ type: 'for', test: $[3], update: $[5], body: $[7] } as const)),
	Rule(['for', '(', for_init, ';', expression_opt, ';', expression_opt, ')', fwd_statement] as const, $ => ({ type: 'for', init: $[2], test: $[4], update: $[6], body: $[8] } as const)),
	Rule(['for', '(', for_lhs, 'in', expression, ')', fwd_statement] as const, 							$ => ({ type: 'for_in', kind: 'in', left: $[2], right: $[4], body: $[6] } as const)),
	// 'of' takes an AssignmentExpression for the iterable (not a full Expression), same as the spec -- avoids the same comma-vs-separator ambiguity 'in' sidesteps via the NoIn chain.
	Rule(['for', '(', for_lhs, 'of', assignment_expression, ')', fwd_statement] as const, 				$ => ({ type: 'for_in', kind: 'of', left: $[2], right: $[4], body: $[6] } as const)),
);

const continue_statement = Rules(
	Rule(['continue', ';'] as const,			() => ({ type: 'continue' } as const)),
	Rule(['continue', IDENT, ';'] as const,		$ => ({ type: 'continue', label: $[1] } as const)),
);
const break_statement = Rules(
	Rule(['break', ';'] as const,				() => ({ type: 'break' } as const)),
	Rule(['break', IDENT, ';'] as const,		$ => ({ type: 'break', label: $[1] } as const)),
);
const return_statement = Rules(
	Rule(['return', ';'] as const,				() => ({ type: 'return' } as const)),
	Rule(['return', expression, ';'] as const,	$ => ({ type: 'return', argument: $[1] } as const)),
);
const with_statement = Rules(
	Rule(['with', '(', expression, ')', fwd_statement] as const, $ => ({ type: 'with', object: $[2], body: $[4] } as const)),
);
const labelled_statement = Rules(
	Rule([IDENT, ':', fwd_statement] as const,	$ => ({ type: 'labeled', label: $[0], body: $[2] } as const)),
);

const case_clause = Rules<SwitchCase>(
	Rule(['case', expression, ':'] as const, 					$ => ({ test: $[1], consequent: [] } as const)),
	Rule(['case', expression, ':', statement_list] as const, 	$ => ({ test: $[1], consequent: $[3] } as const)),
	Rule(['default', ':'] as const, 							() => ({ consequent: [] } as const)),
	Rule(['default', ':', statement_list] as const, 			$ => ({ consequent: $[2] } as const)),
);
const case_clauses = List(case_clause);
const switch_statement = Rules<Statement>(
	Rule(['switch', '(', expression, ')', '{', '}'] as const,				$ => ({ type: 'switch', discriminant: $[2], cases: [] } as const)),
	Rule(['switch', '(', expression, ')', '{', case_clauses, '}'] as const,	$ => ({ type: 'switch', discriminant: $[2], cases: $[5] } as const)),
);

const throw_statement = Rules(
	Rule(['throw', expression, ';'] as const,				$ => ({ type: 'throw', argument: $[1] } as const)),
);
const catch_ = Rules(
	Rule(['catch', '(', IDENT, ')', '{', '}'] as const, 				$ => ({ param: $[2], body: [] as Statement[]} as const)),
	Rule(['catch', '(', IDENT, ')', '{', statement_list, '}'] as const, $ => ({ param: $[2], body: $[5] } as const)),
);
const finally_ = Rules(
	Rule(['finally', '{', '}'] as const,					() => []),
	Rule(['finally', '{', statement_list, '}'] as const,	$ => $[2]),
);
const try_block = Rules(
	Rule(['try', '{', '}'] as const,						() => []),
	Rule(['try', '{', statement_list, '}'] as const,		$ => $[2]),
);
const try_statement = Rules<Statement>(
	Rule([try_block, catch_] as const, 						$ => ({ type: 'try', block: $[0], handlerParam: $[1].param, handlerBody: $[1].body } as const)),
	Rule([try_block, finally_] as const, 					$ => ({ type: 'try', block: $[0], finalizer: $[1] } as const)),
	Rule([try_block, catch_, finally_] as const, 			$ => ({ type: 'try', block: $[0], handlerParam: $[1].param, handlerBody: $[1].body, finalizer: $[2] } as const)),
);

export const function_declaration = Rules(
	Rule(['function', IDENT, parameter_clause, '{', fwd_function_body, '}'] as const, 				$ => ({ type: 'function_decl', name: $[1], params: $[2].params, rest: $[2].rest, body: $[4] } as const)),
	Rule(['function', '*', IDENT, parameter_clause, '{', fwd_function_body, '}'] as const, 			$ => ({ type: 'function_decl', name: $[2], params: $[3].params, rest: $[3].rest, body: $[5], generator: true } as const)),
	Rule(['async', 'function', IDENT, parameter_clause, '{', fwd_function_body, '}'] as const, 		$ => ({ type: 'function_decl', name: $[2], params: $[3].params, rest: $[3].rest, body: $[5], async: true } as const)),
	Rule(['async', 'function', '*', IDENT, parameter_clause, '{', fwd_function_body, '}'] as const, $ => ({ type: 'function_decl', name: $[3], params: $[4].params, rest: $[4].rest, body: $[6], generator: true, async: true } as const))
);
export const function_body = Rules(
	Rule([] as const, 				() => []),
	Rule([statement_list] as const,	$ => $[0]),
);

// --- Classes ---
// Static initialization blocks and private (`#name`) members aren't supported -- a known simplification.

export const class_member_name = Rules<string | { computed: Expr }>(
	Rule([property_name] as const,						$ => $[0]),
	Rule(['[', assignment_expression, ']'] as const,	$ => ({ computed: $[1] } as const)),
);
// Static-ness is split out from the member shape itself (rather than duplicating every method/field alternative once with 'static' and once without), so the combinatorics stay linear instead of doubling.
export const class_member_body = Rules<ClassMember>(
	Rule([class_member_name, parameter_clause, '{', function_body, '}'] as const, 				$ => ({ type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: $[1].params, rest: $[1].rest, body: $[3] } } as const)),
	Rule(['*', class_member_name, parameter_clause, '{', function_body, '}'] as const, 			$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], generator: true } } as const)),
	Rule(['get', class_member_name, '(', ')', '{', function_body, '}'] as const, 				$ => ({ type: 'method', kind: 'get', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: [], body: $[5] } } as const)),
	Rule(['set', class_member_name, '(', IDENT, ')', '{', function_body, '}'] as const, 		$ => ({ type: 'method', kind: 'set', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: [$[3] as string], body: $[6] } } as const)),
	Rule(['async', class_member_name, parameter_clause, '{', function_body, '}'] as const, 		$ => ({ type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: $[2].params, rest: $[2].rest, body: $[4], async: true } } as const)),
	Rule(['async', '*', class_member_name, parameter_clause, '{', function_body, '}'] as const, $ => ({ type: 'method', kind: 'method', key: $[2] as string | { computed: Expr }, value: { type: 'function', params: $[3].params, rest: $[3].rest, body: $[5], generator: true, async: true } } as const)),
	Rule([class_member_name, ';'] as const, 													$ => ({ type: 'field', key: $[0] as string | { computed: Expr } } as const)),
	Rule([class_member_name, '=', assignment_expression, ';'] as const, 						$ => ({ type: 'field', key: $[0] as string | { computed: Expr }, value: $[2] } as const)),
);
export const class_member = Rules(
	Rule([class_member_body] as const,					$ => $[0]),
	Rule(['static', class_member_body] as const,		$ => ({ ...$[1], static: true } as const)),
);
const class_member_list = List(class_member);
export const class_body = Rules(
	Rule(['{', '}'] as const, 							() => []),
	Rule(['{', class_member_list, '}'] as const, 		$ => $[1]),
);
export const class_expression = Rules(
	Rule(['class', class_body] as const, 													$ => ({ type: 'class', body: $[1] } as const)),
	Rule(['class', IDENT, class_body] as const, 											$ => ({ type: 'class', name: $[1], body: $[2] } as const)),
	Rule(['class', 'extends', left_hand_side_expression, class_body] as const, 				$ => ({ type: 'class', superClass: $[2], body: $[3] } as const)),
	Rule(['class', IDENT, 'extends', left_hand_side_expression, class_body] as const, 		$ => ({ type: 'class', name: $[1], superClass: $[3], body: $[4] } as const)),
);
export const class_declaration = Rules(
	Rule(['class', IDENT, class_body] as const, 											$ => ({ type: 'class_decl', name: $[1], body: $[2] } as const)),
	Rule(['class', IDENT, 'extends', left_hand_side_expression, class_body] as const, 		$ => ({ type: 'class_decl', name: $[1], superClass: $[3], body: $[4] } as const)),
);

export const statement = Rules(
	Rule([block] as const, 					$ => $[0]),
	Rule([variable_statement] as const, 	$ => $[0]),
	Rule([';'] as const, 					() => ({ type: 'empty' } as const)),
	Rule([expression_statement] as const, 	$ => $[0]),
	Rule([if_statement] as const, 			$ => $[0]),
	Rule([iteration_statement] as const, 	$ => $[0]),
	Rule([continue_statement] as const, 	$ => $[0]),
	Rule([break_statement] as const, 		$ => $[0]),
	Rule([return_statement] as const, 		$ => $[0]),
	Rule([with_statement] as const, 		$ => $[0]),
	Rule([labelled_statement] as const, 	$ => $[0]),
	Rule([switch_statement] as const, 		$ => $[0]),
	Rule([throw_statement] as const, 		$ => $[0]),
	Rule([try_statement] as const, 			$ => $[0]),
	Rule(['debugger', ';'] as const, 		() => ({ type: 'debugger' } as const)),
	Rule([function_declaration] as const, 	$ => $[0]),
	Rule([class_declaration] as const, 		$ => $[0]),
);

// --- Modules ---
// import/export are only reachable from `module_item`, used solely by `program`'s own top level below -- they're deliberately not part of `statement`, since the real spec restricts them to a Program's top level
const import_specifier = Rules(
	Rule([IDENT] as const, 												$ => ({ imported: $[0], local: $[0] } as const)),
	Rule([IDENT, 'as', IDENT] as const,									$ => ({ imported: $[0], local: $[2] } as const)),
);
const import_specifier_list = List(import_specifier, ',');
const named_imports = Rules(
	Rule(['{', '}'] as const, 											() => []),
	Rule(['{', import_specifier_list, '}'] as const, 					$ => $[1]),
	Rule(['{', import_specifier_list, ',', '}'] as const, 				$ => $[1]),
);
const import_declaration = Rules<Statement>(
	Rule(['import', STRING, ';'] as const, 										$ => ({ type: 'import', source: unquoteString($[1]) } as const)),
	Rule(['import', IDENT, 'from', STRING, ';'] as const, 						$ => ({ type: 'import', default: $[1], source: unquoteString($[3]) } as const)),
	Rule(['import', '*', 'as', IDENT, 'from', STRING, ';'] as const, 			$ => ({ type: 'import', namespace: $[3], source: unquoteString($[5]) } as const)),
	Rule(['import', named_imports, 'from', STRING, ';'] as const, 				$ => ({ type: 'import', specifiers: $[1], source: unquoteString($[3]) } as const)),
	Rule(['import', IDENT, ',', named_imports, 'from', STRING, ';'] as const, 	$ => ({ type: 'import', default: $[1], specifiers: $[3], source: unquoteString($[5]) } as const)),
	Rule(['import', IDENT, ',', '*', 'as', IDENT, 'from', STRING, ';'] as const,$ => ({ type: 'import', default: $[1], namespace: $[5], source: unquoteString($[7]) } as const)),
);

const export_specifier = Rules(
	Rule([IDENT] as const,												$ => ({ local: $[0], exported: $[0] } as const)),
	Rule([IDENT, 'as', IDENT] as const,									$ => ({ local: $[0], exported: $[2] } as const)),
);
const export_specifier_list = List(export_specifier, ',');
const named_exports = Rules(
	Rule(['{', '}'] as const,											() => []),
	Rule(['{', export_specifier_list, '}'] as const,					$ => $[1]),
	Rule(['{', export_specifier_list, ',', '}'] as const,				$ => $[1]),
);
export const export_declaration = Rules<Statement>(
	Rule(['export', named_exports, ';'] as const, 						$ => ({ type: 'export_named', specifiers: $[1] })),
	Rule(['export', named_exports, 'from', STRING, ';'] as const, 		$ => ({ type: 'export_named', specifiers: $[1], source: unquoteString($[3]) })),
	Rule(['export', '*', 'from', STRING, ';'] as const, 				$ => ({ type: 'export_all', source: unquoteString($[3]) })),
	Rule(['export', '*', 'as', IDENT, 'from', STRING, ';'] as const, 	$ => ({ type: 'export_all', exported: $[3], source: unquoteString($[5]) })),
	Rule(['export', 'default', assignment_expression, ';'] as const, 	$ => ({ type: 'export_default', declaration: $[2] })),
	Rule(['export', 'default', function_declaration] as const, 			$ => ({ type: 'export_default', declaration: $[2] })),
	Rule(['export', 'default', class_declaration] as const, 			$ => ({ type: 'export_default', declaration: $[2] })),
	Rule(['export', variable_statement] as const, 						$ => ({ type: 'export_decl', declaration: $[1] })),
	Rule(['export', function_declaration] as const, 					$ => ({ type: 'export_decl', declaration: $[1] })),
	Rule(['export', class_declaration] as const, 						$ => ({ type: 'export_decl', declaration: $[1] })),
);

export const module_item = Rules(
	Rule([import_declaration] as const, 				$ => $[0]),
	Rule([export_declaration] as const, 				$ => $[0]),
	Rule([statement] as const, 							$ => $[0]),
);
const module_item_list = List(module_item);

export const program = Rules<Program>(
	Rule([] as const,									() => ({ type: 'program', body: [] } as const)),
	Rule([module_item_list] as const,					$ => ({ type: 'program', body: $[0] } as const)),
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
export const jsRecover: GrammarSpec['recover'] = (row, tok, prevToken) => {
	const newlineBefore = prevToken && tok.pos && prevToken.pos && tok.pos.line > prevToken.pos.line;
	if (!(newlineBefore || tok.value === '}' || tok.type === EOF))
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

export const jsParser = tison({
	skip: jsSkip,
	recover: jsRecover,
	start: program,
	rules: jsRules
});
