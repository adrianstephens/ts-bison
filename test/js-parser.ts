import { tison, Rule, Rules, terminal, EOF, reOneOf } from '../src/tison';

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
//   - SoftTerminal.lex: a single callback, invoked once a terminal's
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

const IDENT		= /[a-zA-Z_$][a-zA-Z0-9_$]*/;
// Covers hex/octal/binary integers, '_' digit separators (1_000), and a
// trailing BigInt 'n' suffix (only on integers -- not on floats/exponents,
// matching the real restriction). The 'n'-suffixed decimal alternative is
// tried before the plain one so e.g. "10n" can't be misread as "10" leaving
// a stray "n" identifier behind.
const NUMBER		= /0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?|0[oO][0-7](?:_?[0-7])*n?|0[bB][01](?:_?[01])*n?|[0-9](?:_?[0-9])*n|(?:[0-9](?:_?[0-9])*\.(?:[0-9](?:_?[0-9])*)?|\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*)(?:[eE][-+]?[0-9]+)?/;
const STRING		= /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/;
// Combines every assignment operator (=, +=, -=, *=, /=, %=, &=, ^=, |=, <<=, >>=, >>>=)
// into one terminal; the matched text doubles as the AST's `operator` value.
const ASSIGN_OP		= /(?:>>>|<<|>>|[+\-*/%&^|])?=/;

// A '/' starts a regex literal unless the previous token could itself end an
// expression (identifier, number, string, ')', ']', '++', '--', or a literal
// keyword-value) -- in which case '/' has to be division. Terminal names for
// pattern-based terminals are the regex source text; literal-sugar terminals
// (plain strings used directly in a rule's rhs) are named by their escaped
// source plus an implicit trailing word-boundary when the literal ends in a
// word character, mirroring tison's own internal literalPattern() exactly
// (escaping *and* the boundary suffix both need to match, or names here
// would silently fail to find the terminal tison actually interned).
const escapeLit = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/\w/.test(s[s.length - 1]) ? '(?!\\w)' : '');
const regexDisallowedAfter = new Set([
	IDENT.source, NUMBER.source, STRING.source,
	escapeLit(')'), escapeLit(']'), escapeLit('++'), escapeLit('--'),
	escapeLit('this'), escapeLit('true'), escapeLit('false'), escapeLit('null'),
]);
const REGEX_LITERAL = terminal(
	/\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-zA-Z]*/,
	({ prev }) => (!prev || !regexDisallowedAfter.has(prev.name)) ? REGEX_LITERAL : undefined
);

// 'var'/'let'/'const' share identical declarator syntax -- only the kept-around `kind` differs semantically (var is function-scoped, let/const are
// block-scoped, const additionally forbids reassignment) -- none of which a syntax-only parser needs to enforce, so one grammar shape covers all three.
const VAR_KEYWORDS = ['var', 'let', 'const'] as const;

// --- AST types ---

interface Identifier	{ type: 'identifier'; name: string; }
type Literal =
	| { type: 'literal'; value: number | string | boolean | null }
	| { type: 'regex'; pattern: string; flags: string }
	// BigInt's own value is kept as digit text, not a native bigint -- a native
	// bigint can't round-trip through JSON.stringify (used by this file's own
	// test() helper), and ESTree-style ASTs hit the same problem the same way.
	| { type: 'bigint'; value: string };

interface TemplatePart { str: string; exp?: Expr; }
interface ObjectProperty { key: string | { computed: Expr }; value: Expr; kind: 'init' | 'get' | 'set'; }

// Destructuring binding targets, shared by variable declarations, for-loop
// left-hand sides, and function parameters. A plain identifier is just a
// string (matching this file's existing convention of not wrapping simple
// names in their own node) -- only object/array patterns get a `type` tag.
type BindingTarget = string | ObjectPattern | ArrayPattern;
interface ObjectPatternProperty { key: string; value: BindingTarget; default?: Expr; }
interface ObjectPattern { type: 'object_pattern'; properties: ObjectPatternProperty[]; rest?: string; }
interface ArrayPatternElement { target: BindingTarget; default?: Expr; }
// `undefined` entries are holes (elisions), e.g. the gaps in `[a, , b]`.
interface ArrayPattern { type: 'array_pattern'; elements: (ArrayPatternElement | undefined)[]; rest?: string; }

type Param = string | { target: BindingTarget; default?: Expr };

type Expr =
	| Identifier
	| Literal
	| { type: 'this' }
	// `undefined` entries are holes (elisions), e.g. the gaps in `[1, , 3]`.
	| { type: 'array'; elements: (Expr | undefined)[] }
	| { type: 'object'; properties: ObjectProperty[] }
	// `rest` is the trailing `...name` parameter, if any (always last, though this syntax-only grammar doesn't enforce that it can't appear earlier).
	| { type: 'function'; name?: string; params: Param[]; rest?: string; body: Statement[]; generator?: boolean; async?: boolean }
	| { type: 'member'; object: Expr; property: string; optional?: boolean }
	| { type: 'index'; object: Expr; property: Expr; optional?: boolean }
	| { type: 'call'; callee: Expr; arguments: Expr[]; optional?: boolean }
	| { type: 'new'; callee: Expr; arguments: Expr[] }
	| { type: 'unary'; operator: string; argument: Expr; prefix: boolean }
	| { type: 'update'; operator: string; argument: Expr; prefix: boolean }
	| { type: 'binary'; operator: string; left: Expr; right: Expr }
	| { type: 'logical'; operator: string; left: Expr; right: Expr }
	| { type: 'assign'; operator: string; left: Expr; right: Expr }
	| { type: 'conditional'; test: Expr; consequent: Expr; alternate: Expr }
	| { type: 'sequence'; expressions: Expr[] }
	// `...x` inside an array literal or a call's argument list.
	| { type: 'spread'; argument: Expr }
	| { type: 'tagged_template'; tag: Expr; quasi: TemplatePart[] }
	| { type: 'arrow'; params: Param[]; rest?: string; body: Expr | Statement[]; async?: boolean }
	// `delegate` is `yield*`; this grammar doesn't enforce that `yield` only
	// appears inside a generator body, same as other non-syntactic
	// restrictions elsewhere here.
	| { type: 'yield'; argument?: Expr; delegate?: boolean }
	| { type: 'class'; name?: string; superClass?: Expr; body: ClassMember[] }
	| { type: 'await'; argument: Expr };

interface VarDeclarator { name: BindingTarget; init?: Expr; }
interface SwitchCase { test?: Expr; consequent: Statement[]; }

type DeclarationKind = typeof VAR_KEYWORDS[number];
type ForInit = Expr | { type: 'var'; kind: DeclarationKind; declarations: VarDeclarator[] };

interface ImportSpecifier { imported: string; local: string; }
interface ExportSpecifier { local: string; exported: string; }

// Static initialization blocks (`static { ... }`) and private (`#name`)
// members aren't supported -- a known simplification.
type ClassMember =
	| { type: 'method'; static?: boolean; kind: 'method' | 'get' | 'set'; key: string | { computed: Expr }; value: Expr }
	// `value` is the method's own function expression, which already carries
	// `async`/`generator` -- not duplicated here.
	| { type: 'field'; static?: boolean; key: string | { computed: Expr }; value?: Expr };

type Statement =
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
	| { type: 'function_decl'; name: string; params: Param[]; rest?: string; body: Statement[]; generator?: boolean; async?: boolean }
	| { type: 'import'; default?: string; namespace?: string; specifiers?: ImportSpecifier[]; source: string }
	| { type: 'export_named'; specifiers: ExportSpecifier[]; source?: string }
	| { type: 'export_all'; source: string; exported?: string }
	| { type: 'export_default'; declaration: Expr | Statement }
	| { type: 'export_decl'; declaration: Statement }
	| { type: 'class_decl'; name: string; superClass?: Expr; body: ClassMember[] };

interface Program { type: 'program'; body: Statement[]; }

// ===================================================================
//  Grammar
// ===================================================================
//
// Two parallel chains exist above shift_expression: the normal one (allows
// 'in' as a relational operator) and a "NoIn" one (excludes it), mirroring
// ECMA-262's own duplication -- it's needed because `for (x in y)` and
// `for (x; ...)` would otherwise be ambiguous as to whether 'in' continues a
// RelationalExpression or marks the for-in separator. NoIn variants are used
// only inside for-loop headers.

// `name` must be this group's own (self-recursive) name, as a string -- a
// const can't reference its own binding while it's still being initialized,
// so a left-recursive `[name, op, lower]` (continuing a chain of this same
// precedence level, e.g. `a + b + c` as `(a + b) + c`) has no choice but to
// spell its own name out. Using `lower` on both sides instead, as this used
// to, only ever accepts exactly one operator at this level (`a + b` parses,
// `a + b + c` doesn't: nothing reduces `a + b` back down to something this
// rule's left side accepts again).
function binaryChain(name: string, lower: string, ops: string[], prec: string, kind: 'binary' | 'logical' = 'binary') {
	return Rules<Expr>(
		Rule([lower] as const, $ => $[0] as Expr),
		Rule([name, reOneOf(ops), lower] as const, $ =>	({ type: kind, operator: $[1], left: $[0] as Expr, right: $[2] as Expr } as const), prec)
//		...ops.map(op => Rule([name, op, lower] as const, $ =>
//			({ type: kind, operator: op, left: $[0] as Expr, right: $[2] as Expr } as const), prec)),
	);
}

// Single-quoted strings are re-quoted to double quotes so JSON.parse can
// unescape them the same way as already-double-quoted ones -- STRING's own
// pattern accepts either.
const unquoteString = (s: string) => JSON.parse(s.replace(/^'|'$/g, '"')) as string;

// --- Primary / member / call / new chain ---

// `elision`: a run of N commas with nothing between them, i.e. N holes --
// shared by array literals and array patterns. A *single* trailing comma
// after a real element (the existing `'[', element_list, ',', ']'` shape
// below) is just a separator and creates no hole, matching real JS; an
// elision only starts counting from the *next* comma onward.
const elision = Rules<number>(
	Rule([','] as const, () => 1),
	Rule(['elision', ','] as const, $ => ($[0] as number) + 1),
);
const holes = (n: number) => Array<undefined>(n).fill(undefined);

const array_literal = Rules<Expr>(
	Rule(['[', ']'] as const, () => ({ type: 'array', elements: [] } as const)),
	Rule(['[', 'elision', ']'] as const, $ => ({ type: 'array', elements: holes($[1] as number) } as const)),
	Rule(['[', 'element_list', ']'] as const, $ => ({ type: 'array', elements: $[1] as (Expr | undefined)[] } as const)),
	Rule(['[', 'element_list', ',', ']'] as const, $ => ({ type: 'array', elements: $[1] as (Expr | undefined)[] } as const)),
	Rule(['[', 'element_list', ',', 'elision', ']'] as const, $ => ({ type: 'array', elements: [...($[1] as (Expr | undefined)[]), ...holes($[3] as number)] } as const)),
);
const element_list = Rules<(Expr | undefined)[]>(
	Rule(['assignment_expression'] as const, $ => [$[0] as Expr]),
	Rule(['elision', 'assignment_expression'] as const, $ => [...holes($[0] as number), $[1] as Expr]),
	Rule(['element_list', ',', 'assignment_expression'] as const, $ => [...($[0] as (Expr | undefined)[]), $[2] as Expr]),
	Rule(['element_list', ',', 'elision', 'assignment_expression'] as const, $ => [...($[0] as (Expr | undefined)[]), ...holes($[2] as number), $[3] as Expr]),
	Rule(['...', 'assignment_expression'] as const, $ => [{ type: 'spread', argument: $[1] as Expr } as const]),
	Rule(['elision', '...', 'assignment_expression'] as const, $ => [...holes($[0] as number), { type: 'spread', argument: $[2] as Expr } as const]),
	Rule(['element_list', ',', '...', 'assignment_expression'] as const, $ => [...($[0] as (Expr | undefined)[]), { type: 'spread', argument: $[3] as Expr } as const]),
	Rule(['element_list', ',', 'elision', '...', 'assignment_expression'] as const, $ => [...($[0] as (Expr | undefined)[]), ...holes($[2] as number), { type: 'spread', argument: $[4] as Expr } as const]),
);

const property_name = Rules<string>(
	Rule([IDENT] as const, $ => $[0]),
	Rule([STRING] as const, $ => unquoteString($[0])),
	Rule([NUMBER] as const, $ => $[0]),
);
const property_assignment = Rules<ObjectProperty>(
	Rule(['property_name', ':', 'assignment_expression'] as const, $ => ({ key: $[0] as string, value: $[2] as Expr, kind: 'init' } as const)),
	Rule(['get', 'property_name', '(', ')', '{', 'function_body', '}'] as const, $ =>
		({ key: $[1] as string, value: { type: 'function', params: [], body: $[5] as Statement[] }, kind: 'get' } as const)),
	Rule(['set', 'property_name', '(', IDENT, ')', '{', 'function_body', '}'] as const, $ =>
		({ key: $[1] as string, value: { type: 'function', params: [$[3] as string], body: $[6] as Statement[] }, kind: 'set' } as const)),
	// Shorthand property: `{x}` is `{x: x}`.
	Rule([IDENT] as const, $ => ({ key: $[0], value: { type: 'identifier', name: $[0] }, kind: 'init' } as const)),
	// `{x = 1}` is never valid as a *real* object literal (only inside a
	// destructuring target) -- accepted here anyway, permissively, purely so
	// arrow-function parameters can be parsed as a plain object literal and
	// reinterpreted as a pattern afterward (see `exprToBindingTarget` below).
	// A real object literal with this shape only arises if that
	// reinterpretation is never attempted, which this grammar doesn't catch.
	Rule([IDENT, '=', 'assignment_expression'] as const, $ =>
		({ key: $[0], value: { type: 'assign', operator: '=', left: { type: 'identifier', name: $[0] }, right: $[2] as Expr }, kind: 'init' } as const)),
	// Shorthand method: `{foo() {...}}` is `{foo: function() {...}}`.
	Rule(['property_name', 'parameter_clause', '{', 'function_body', '}'] as const, $ => {
		const p = $[1] as ParamList;
		return { key: $[0] as string, value: { type: 'function', params: p.params, rest: p.rest, body: $[3] as Statement[] }, kind: 'init' } as const;
	}),
	// Generator method: `{*foo() {...}}` is `{foo: function*() {...}}`.
	Rule(['*', 'property_name', 'parameter_clause', '{', 'function_body', '}'] as const, $ => {
		const p = $[2] as ParamList;
		return { key: $[1] as string, value: { type: 'function', params: p.params, rest: p.rest, body: $[4] as Statement[], generator: true }, kind: 'init' } as const;
	}),
	// Async method: `{async foo() {...}}` is `{foo: async function() {...}}`.
	Rule(['async', 'property_name', 'parameter_clause', '{', 'function_body', '}'] as const, $ => {
		const p = $[2] as ParamList;
		return { key: $[1] as string, value: { type: 'function', params: p.params, rest: p.rest, body: $[4] as Statement[], async: true }, kind: 'init' } as const;
	}),
	Rule(['async', '*', 'property_name', 'parameter_clause', '{', 'function_body', '}'] as const, $ => {
		const p = $[3] as ParamList;
		return { key: $[2] as string, value: { type: 'function', params: p.params, rest: p.rest, body: $[5] as Statement[], generator: true, async: true }, kind: 'init' } as const;
	}),
	// Computed key: `{[expr]: value}` -- only supported for the plain key:value form, not get/set/shorthand-method.
	Rule(['[', 'assignment_expression', ']', ':', 'assignment_expression'] as const, $ =>
		({ key: { computed: $[1] as Expr }, value: $[4] as Expr, kind: 'init' } as const)),
);
const property_list = Rules<ObjectProperty[]>(
	Rule(['property_assignment'] as const, $ => [$[0] as ObjectProperty]),
	Rule(['property_list', ',', 'property_assignment'] as const, $ => [...($[0] as ObjectProperty[]), $[2] as ObjectProperty]),
);
const object_literal = Rules<Expr>(
	Rule(['{', '}'] as const, () => ({ type: 'object', properties: [] } as const)),
	Rule(['{', 'property_list', '}'] as const, $ => ({ type: 'object', properties: $[1] as ObjectProperty[] } as const)),
	Rule(['{', 'property_list', ',', '}'] as const, $ => ({ type: 'object', properties: $[1] as ObjectProperty[] } as const)),
);

// --- Destructuring binding patterns ---
// Only reachable from contexts that are unambiguously a binding position (right after 'var'/'let'/'const', or inside a parameter list) -- never
// from general expression position, so there's no grammar conflict with object_literal/array_literal despite the shared '{'/'[' tokens.

const binding_target = Rules<BindingTarget>(
	Rule([IDENT] as const, $ => $[0]),
	Rule(['object_pattern'] as const, $ => $[0] as ObjectPattern),
	Rule(['array_pattern'] as const, $ => $[0] as ArrayPattern),
);
const binding_pattern = Rules<ObjectPattern | ArrayPattern>(
	Rule(['object_pattern'] as const, $ => $[0] as ObjectPattern),
	Rule(['array_pattern'] as const, $ => $[0] as ArrayPattern),
);

const object_pattern_property = Rules<ObjectPatternProperty>(
	// Shorthand: `{a}` or `{a = 1}`, binding directly to a same-named local.
	Rule([IDENT] as const, $ => ({ key: $[0], value: $[0] } as const)),
	Rule([IDENT, '=', 'assignment_expression'] as const, $ => ({ key: $[0], value: $[0], default: $[2] as Expr } as const)),
	// Renamed/nested: `{a: b}`, `{a: b = 1}`, `{a: {b}}`, etc.
	Rule([IDENT, ':', 'binding_target'] as const, $ => ({ key: $[0], value: $[2] as BindingTarget } as const)),
	Rule([IDENT, ':', 'binding_target', '=', 'assignment_expression'] as const, $ => ({ key: $[0], value: $[2] as BindingTarget, default: $[4] as Expr } as const)),
);
const object_pattern_property_list = Rules<ObjectPatternProperty[]>(
	Rule(['object_pattern_property'] as const, $ => [$[0] as ObjectPatternProperty]),
	Rule(['object_pattern_property_list', ',', 'object_pattern_property'] as const, $ => [...($[0] as ObjectPatternProperty[]), $[2] as ObjectPatternProperty]),
);
const object_pattern = Rules<ObjectPattern>(
	Rule(['{', '}'] as const, () => ({ type: 'object_pattern', properties: [] } as const)),
	Rule(['{', 'object_pattern_property_list', '}'] as const, $ => ({ type: 'object_pattern', properties: $[1] as ObjectPatternProperty[] } as const)),
	Rule(['{', 'object_pattern_property_list', ',', '}'] as const, $ => ({ type: 'object_pattern', properties: $[1] as ObjectPatternProperty[] } as const)),
	Rule(['{', '...', IDENT, '}'] as const, $ => ({ type: 'object_pattern', properties: [], rest: $[2] } as const)),
	Rule(['{', 'object_pattern_property_list', ',', '...', IDENT, '}'] as const, $ => ({ type: 'object_pattern', properties: $[1] as ObjectPatternProperty[], rest: $[4] } as const)),
);

const array_pattern_element = Rules<ArrayPatternElement>(
	Rule(['binding_target'] as const, $ => ({ target: $[0] as BindingTarget } as const)),
	Rule(['binding_target', '=', 'assignment_expression'] as const, $ => ({ target: $[0] as BindingTarget, default: $[2] as Expr } as const)),
);
const array_pattern_element_list = Rules<(ArrayPatternElement | undefined)[]>(
	Rule(['array_pattern_element'] as const, $ => [$[0] as ArrayPatternElement]),
	Rule(['elision', 'array_pattern_element'] as const, $ => [...holes($[0] as number), $[1] as ArrayPatternElement]),
	Rule(['array_pattern_element_list', ',', 'array_pattern_element'] as const, $ => [...($[0] as (ArrayPatternElement | undefined)[]), $[2] as ArrayPatternElement]),
	Rule(['array_pattern_element_list', ',', 'elision', 'array_pattern_element'] as const, $ => [...($[0] as (ArrayPatternElement | undefined)[]), ...holes($[2] as number), $[3] as ArrayPatternElement]),
);
const array_pattern = Rules<ArrayPattern>(
	Rule(['[', ']'] as const, () => ({ type: 'array_pattern', elements: [] } as const)),
	Rule(['[', 'elision', ']'] as const, $ => ({ type: 'array_pattern', elements: holes($[1] as number) } as const)),
	Rule(['[', 'array_pattern_element_list', ']'] as const, $ => ({ type: 'array_pattern', elements: $[1] as (ArrayPatternElement | undefined)[] } as const)),
	Rule(['[', 'array_pattern_element_list', ',', ']'] as const, $ => ({ type: 'array_pattern', elements: $[1] as (ArrayPatternElement | undefined)[] } as const)),
	Rule(['[', 'array_pattern_element_list', ',', 'elision', ']'] as const, $ => ({ type: 'array_pattern', elements: [...($[1] as (ArrayPatternElement | undefined)[]), ...holes($[3] as number)] } as const)),
	Rule(['[', '...', IDENT, ']'] as const, $ => ({ type: 'array_pattern', elements: [], rest: $[2] } as const)),
	Rule(['[', 'array_pattern_element_list', ',', '...', IDENT, ']'] as const, $ => ({ type: 'array_pattern', elements: $[1] as (ArrayPatternElement | undefined)[], rest: $[4] } as const)),
);

// --- Arrow function parameter reinterpretation ---
//
// A parenthesized arrow parameter list looks exactly like a parenthesized
// expression until the `=>` that follows it -- `(a, b)` could be a
// comma-expression or two params, `({a}) ` could be a parenthesized object
// literal or a destructured param. Predicting which one from inside the
// parens would need unbounded lookahead (or true backtracking/GLR), so
// instead the parens are parsed as a perfectly ordinary `expression` (the
// existing `'(', expression, ')'` shape primary_expression already has),
// and only *after* `=>` confirms this was actually a parameter list does
// `exprToParams` reinterpret that already-built expression tree as one.
// This is the same technique real JS engines use for this exact ambiguity.
//
// The one piece `expression` can't already represent on its own is a
// trailing `...rest` (spread isn't valid as a bare expression), so that
// case is spelled out as its own grammar rule below rather than handled
// inside the conversion.
function exprToBindingTarget(e: Expr): BindingTarget {
	if (e.type === 'identifier')
		return e.name;
	if (e.type === 'object')
		return {
			type: 'object_pattern',
			properties: e.properties.map(p => {
				if (typeof p.key !== 'string')
					throw new SyntaxError('Invalid destructuring target: computed key');
				return p.value.type === 'assign'
					? { key: p.key, value: exprToBindingTarget(p.value.left), default: p.value.right }
					: { key: p.key, value: exprToBindingTarget(p.value) };
			}),
		};
	if (e.type === 'array') {
		const last = e.elements[e.elements.length - 1];
		const rest = last?.type === 'spread' ? last.argument : undefined;
		if (rest && rest.type !== 'identifier')
			throw new SyntaxError('Invalid destructuring rest target');
		return {
			type: 'array_pattern',
			elements: (rest ? e.elements.slice(0, -1) : e.elements).map(el => el === undefined ? undefined
				: el.type === 'assign' ? { target: exprToBindingTarget(el.left), default: el.right }
				: { target: exprToBindingTarget(el) }),
			rest: rest?.name,
		};
	}
	throw new SyntaxError(`Invalid destructuring target: ${e.type}`);
}
function exprToParam(e: Expr): Param {
	if (e.type === 'identifier')
		return e.name;
	if (e.type === 'assign' && e.operator === '=')
		return { target: exprToBindingTarget(e.left), default: e.right };
	return { target: exprToBindingTarget(e) };
}
function exprToParams(e: Expr): Param[] {
	return e.type === 'sequence' ? e.expressions.map(exprToParam) : [exprToParam(e)];
}

// Literal text run: anything but a backtick, and any '$' not starting '${' --
// stops at the first '${' or closing backtick either way, so neither
// alternative below can greedily swallow past the other's terminator.
const TEMPLATE_TEXT = '(?:[^`$]|\\$(?!\\{))*';
const template_literal_part = Rules<TemplatePart>(
	Rule([new RegExp(TEMPLATE_TEXT + '(?=\\$\\{)'), '${', 'expression', '}'] as const, $ => ({ str: $[0], exp: $[2] as Expr } as const)),
	Rule([new RegExp(TEMPLATE_TEXT + '(?=`)')] as const, $ => ({ str: $[0] } as const)),
);
const template_literal_parts = Rules<TemplatePart[]>(
	Rule([template_literal_part],	$ => [$[0] as TemplatePart]),
	Rule(['template_literal_parts', template_literal_part],	$ => [...($[0] as TemplatePart[]), $[1] as TemplatePart])
);

// Parses a NUMBER token's text into its runtime value -- shared by
// primary_expression's own number literal and (once added) anywhere else a
// raw number needs the same hex/octal/binary/separator/BigInt handling.
function parseNumber(text: string): Literal {
	if (text.endsWith('n'))
		return { type: 'bigint', value: text.slice(0, -1).replace(/_/g, '') };
	const clean = text.replace(/_/g, '');
	return {
		type: 'literal',
		value: /^0[xX]/.test(clean) ? parseInt(clean, 16)
			: /^0[oO]/.test(clean) ? parseInt(clean.slice(2), 8)
			: /^0[bB]/.test(clean) ? parseInt(clean.slice(2), 2)
			: parseFloat(clean),
	};
}

const primary_expression = Rules<Expr>(
	Rule(['this'] as const, () => ({ type: 'this' } as const)),
	Rule([IDENT] as const, $ => ({ type: 'identifier', name: $[0] } as const)),
	Rule([NUMBER] as const, $ => parseNumber($[0])),
	Rule([STRING] as const, $ => ({ type: 'literal', value: unquoteString($[0]) } as const)),
	Rule([REGEX_LITERAL] as const, $ => { const m = /^\/(.*)\/([a-zA-Z]*)$/.exec($[0])!; return { type: 'regex', pattern: m[1], flags: m[2] } as const; }),
	Rule(['true'] as const, () => ({ type: 'literal', value: true } as const)),
	Rule(['false'] as const, () => ({ type: 'literal', value: false } as const)),
	Rule(['null'] as const, () => ({ type: 'literal', value: null } as const)),
	Rule(['array_literal'] as const, $ => $[0] as Expr),
	Rule(['object_literal'] as const, $ => $[0] as Expr),
	Rule(['(', 'expression', ')'] as const, $ => $[1] as Expr),
	Rule(['`', template_literal_parts, '`'], $ => ({ type: 'literal', value: $[1] } as unknown as Expr))
);

// A single parameter: a bare name, a name with a default, or a destructured
// (optionally defaulted) target. Plain identifiers stay bare strings, same
// convention as elsewhere in this file -- only the richer forms wrap.
const parameter = Rules<Param>(
	Rule([IDENT] as const, $ => $[0]),
	Rule([IDENT, '=', 'assignment_expression'] as const, $ => ({ target: $[0], default: $[2] as Expr } as const)),
	Rule(['object_pattern'] as const, $ => ({ target: $[0] as ObjectPattern } as const)),
	Rule(['object_pattern', '=', 'assignment_expression'] as const, $ => ({ target: $[0] as ObjectPattern, default: $[2] as Expr } as const)),
	Rule(['array_pattern'] as const, $ => ({ target: $[0] as ArrayPattern } as const)),
	Rule(['array_pattern', '=', 'assignment_expression'] as const, $ => ({ target: $[0] as ArrayPattern, default: $[2] as Expr } as const)),
);
const formal_parameter_list = Rules<Param[]>(
	Rule(['parameter'] as const, $ => [$[0] as Param]),
	Rule(['formal_parameter_list', ',', 'parameter'] as const, $ => [...($[0] as Param[]), $[2] as Param]),
);

interface ParamList { params: Param[]; rest?: string; }

// A full `(...)` parameter clause, with an optional trailing `...rest`.
// Shared by function expressions/declarations and object-literal shorthand
// methods, so rest-parameter support lands in all three at once. Rest
// itself stays a bare identifier (a known simplification -- the real spec
// also allows a destructuring pattern there).
const parameter_clause = Rules<ParamList>(
	Rule(['(', ')'] as const, () => ({ params: [] } as const)),
	Rule(['(', 'formal_parameter_list', ')'] as const, $ => ({ params: $[1] as Param[] } as const)),
	Rule(['(', '...', IDENT, ')'] as const, $ => ({ params: [], rest: $[2] } as const)),
	Rule(['(', 'formal_parameter_list', ',', '...', IDENT, ')'] as const, $ => ({ params: $[1] as Param[], rest: $[4] } as const)),
);
const function_expression = Rules<Expr>(
	Rule(['function', parameter_clause, '{', 'function_body', '}'] as const, $ => ({ type: 'function', params: $[1].params, rest: $[1].rest, body: $[3] as Statement[] } as const)),
	Rule(['function', IDENT, parameter_clause, '{', 'function_body', '}'] as const, $ => ({ type: 'function', name: $[1], params: $[2].params, rest: $[2].rest, body: $[4] as Statement[] } as const)),
	Rule(['function', '*', parameter_clause, '{', 'function_body', '}'] as const, $ => ({ type: 'function', params: $[2].params, rest: $[2].rest, body: $[4] as Statement[], generator: true } as const)),
	Rule(['function', '*', IDENT, parameter_clause, '{', 'function_body', '}'] as const, $ => ({ type: 'function', name: $[2], params: $[3].params, rest: $[3].rest, body: $[5] as Statement[], generator: true } as const)),
	Rule(['async', 'function', parameter_clause, '{', 'function_body', '}'] as const, $ => ({ type: 'function', params: $[2].params, rest: $[2].rest, body: $[4] as Statement[], async: true } as const)),
	Rule(['async', 'function', IDENT, parameter_clause, '{', 'function_body', '}'] as const, $ => ({ type: 'function', name: $[2], params: $[3].params, rest: $[3].rest, body: $[5] as Statement[], async: true } as const)),
	Rule(['async', 'function', '*', parameter_clause, '{', 'function_body', '}'] as const, $ => ({ type: 'function', params: $[3].params, rest: $[3].rest, body: $[5] as Statement[], generator: true, async: true } as const)),
	Rule(['async', 'function', '*', IDENT, parameter_clause, '{', 'function_body', '}'] as const, $ => ({ type: 'function', name: $[3], params: $[4].params, rest: $[4].rest, body: $[6] as Statement[], generator: true, async: true } as const))
);

const member_expression = Rules<Expr>(
	Rule(['primary_expression'] as const, $ => $[0] as Expr),
	Rule(['function_expression'] as const, $ => $[0] as Expr),
	Rule(['class_expression'] as const, $ => $[0] as Expr),
	Rule(['member_expression', '.', IDENT] as const, $ => ({ type: 'member', object: $[0] as Expr, property: $[2] } as const)),
	Rule(['member_expression', '[', 'expression', ']'] as const, $ => ({ type: 'index', object: $[0] as Expr, property: $[2] as Expr } as const)),
	Rule(['new', 'member_expression', 'arguments_'] as const, $ => ({ type: 'new', callee: $[1] as Expr, arguments: $[2] as Expr[] } as const)),
);
const new_expression = Rules<Expr>(
	Rule(['member_expression'] as const, $ => $[0] as Expr),
	Rule(['new', 'new_expression'] as const, $ => ({ type: 'new', callee: $[1] as Expr, arguments: [] } as const)),
);
const arguments_ = Rules<Expr[]>(
	Rule(['(', ')'] as const, () => []),
	Rule(['(', 'argument_list', ')'] as const, $ => $[1] as Expr[]),
);
const argument_list = Rules<Expr[]>(
	Rule(['assignment_expression'] as const, $ => [$[0] as Expr]),
	Rule(['argument_list', ',', 'assignment_expression'] as const, $ => [...($[0] as Expr[]), $[2] as Expr]),
	Rule(['...', 'assignment_expression'] as const, $ => [{ type: 'spread', argument: $[1] as Expr } as const]),
	Rule(['argument_list', ',', '...', 'assignment_expression'] as const, $ => [...($[0] as Expr[]), { type: 'spread', argument: $[3] as Expr } as const]),
);
const call_expression = Rules<Expr>(
	Rule(['member_expression', 'arguments_'] as const, $ => ({ type: 'call', callee: $[0] as Expr, arguments: $[1] as Expr[] } as const)),
	Rule(['call_expression', 'arguments_'] as const, $ => ({ type: 'call', callee: $[0] as Expr, arguments: $[1] as Expr[] } as const)),
	Rule(['call_expression', '.', IDENT] as const, $ => ({ type: 'member', object: $[0] as Expr, property: $[2] } as const)),
	Rule(['call_expression', '[', 'expression', ']'] as const, $ => ({ type: 'index', object: $[0] as Expr, property: $[2] as Expr } as const)),
	// Tagged template: `tag\`...\`` is structurally a call, just with a
	// template literal instead of a parenthesized argument list.
	Rule(['member_expression', '`', 'template_literal_parts', '`'] as const, $ => ({ type: 'tagged_template', tag: $[0] as Expr, quasi: $[2] as TemplatePart[] } as const)),
	Rule(['call_expression', '`', 'template_literal_parts', '`'] as const, $ => ({ type: 'tagged_template', tag: $[0] as Expr, quasi: $[2] as TemplatePart[] } as const)),
	// Optional chaining: each `?.` step only marks itself optional -- this
	// syntax-only grammar doesn't track or enforce the real short-circuiting
	// semantics (the rest of a chain skipping evaluation once one step is
	// nullish), same as other non-syntactic restrictions elsewhere here.
	Rule(['member_expression', '?.', IDENT] as const, $ => ({ type: 'member', object: $[0] as Expr, property: $[2], optional: true } as const)),
	Rule(['call_expression', '?.', IDENT] as const, $ => ({ type: 'member', object: $[0] as Expr, property: $[2], optional: true } as const)),
	Rule(['member_expression', '?.', '[', 'expression', ']'] as const, $ => ({ type: 'index', object: $[0] as Expr, property: $[3] as Expr, optional: true } as const)),
	Rule(['call_expression', '?.', '[', 'expression', ']'] as const, $ => ({ type: 'index', object: $[0] as Expr, property: $[3] as Expr, optional: true } as const)),
	Rule(['member_expression', '?.', 'arguments_'] as const, $ => ({ type: 'call', callee: $[0] as Expr, arguments: $[2] as Expr[], optional: true } as const)),
	Rule(['call_expression', '?.', 'arguments_'] as const, $ => ({ type: 'call', callee: $[0] as Expr, arguments: $[2] as Expr[], optional: true } as const)),
);
const left_hand_side_expression = Rules<Expr>(
	Rule(['new_expression'] as const, $ => $[0] as Expr),
	Rule(['call_expression'] as const, $ => $[0] as Expr),
);

// --- Unary / update / binary precedence chain ---
// Postfix ++/-- doesn't need to worry about the "no line terminator before
// ++/--" restricted production here: WS's `lex` callback (see below)
// already reclassifies the preceding whitespace into a semicolon at the
// lexer level before either token ever reaches the parser.

const postfix_expression = Rules<Expr>(
	Rule(['left_hand_side_expression'] as const, $ => $[0] as Expr),
	Rule(['left_hand_side_expression', '++'] as const, $ => ({ type: 'update', operator: '++', argument: $[0] as Expr, prefix: false } as const)),
	Rule(['left_hand_side_expression', '--'] as const, $ => ({ type: 'update', operator: '--', argument: $[0] as Expr, prefix: false } as const)),
);
const unary_expression = Rules<Expr>(
	Rule(['postfix_expression'] as const, $ => $[0] as Expr),
	Rule(['delete', 'unary_expression'] as const, $ => ({ type: 'unary', operator: 'delete', argument: $[1] as Expr, prefix: true } as const)),
	Rule(['void', 'unary_expression'] as const, $ => ({ type: 'unary', operator: 'void', argument: $[1] as Expr, prefix: true } as const)),
	Rule(['typeof', 'unary_expression'] as const, $ => ({ type: 'unary', operator: 'typeof', argument: $[1] as Expr, prefix: true } as const)),
	// Unlike `yield`, `await` always requires an operand -- no ASI/restricted
	// production handling needed, same as `typeof`/`void`/`delete` above. This
	// grammar doesn't enforce that `await` only appears inside an async
	// function, same as other non-syntactic restrictions elsewhere here.
	Rule(['await', 'unary_expression'] as const, $ => ({ type: 'await', argument: $[1] as Expr } as const)),
	Rule(['++', 'unary_expression'] as const, $ => ({ type: 'update', operator: '++', argument: $[1] as Expr, prefix: true } as const)),
	Rule(['--', 'unary_expression'] as const, $ => ({ type: 'update', operator: '--', argument: $[1] as Expr, prefix: true } as const)),
	Rule(['+', 'unary_expression'] as const, $ => ({ type: 'unary', operator: '+', argument: $[1] as Expr, prefix: true } as const)),
	Rule(['-', 'unary_expression'] as const, $ => ({ type: 'unary', operator: '-', argument: $[1] as Expr, prefix: true } as const)),
	Rule(['~', 'unary_expression'] as const, $ => ({ type: 'unary', operator: '~', argument: $[1] as Expr, prefix: true } as const)),
	Rule(['!', 'unary_expression'] as const, $ => ({ type: 'unary', operator: '!', argument: $[1] as Expr, prefix: true } as const)),
);

// Right-associative: 2 ** 3 ** 2 === 2 ** (3 ** 2). Spelled as a dedicated
// self-recursion on the right (rather than binaryChain's left-recursion)
// since right-associativity needs the recursive reference on the other side.
const exponentiation_expression = Rules<Expr>(
	Rule(['unary_expression'] as const, $ => $[0] as Expr),
	Rule(['unary_expression', '**', 'exponentiation_expression'] as const, $ =>
		({ type: 'binary', operator: '**', left: $[0] as Expr, right: $[2] as Expr } as const), 'exponentiation'),
);

const multiplicative_expression		= binaryChain('multiplicative_expression', 'exponentiation_expression', ['*', '/', '%'], 'multiplicative');
const additive_expression			= binaryChain('additive_expression', 'multiplicative_expression', ['+', '-'], 'additive');
const shift_expression				= binaryChain('shift_expression', 'additive_expression', ['<<', '>>', '>>>'], 'shift');

const relational_expression			= binaryChain('relational_expression', 'shift_expression', ['<', '>', '<=', '>=', 'instanceof', 'in'], 'relational');
const equality_expression			= binaryChain('equality_expression', 'relational_expression', ['==', '!=', '===', '!=='], 'equality');
const bitwise_and_expression		= binaryChain('bitwise_and_expression', 'equality_expression', ['&'], 'bitwiseAnd');
const bitwise_xor_expression		= binaryChain('bitwise_xor_expression', 'bitwise_and_expression', ['^'], 'bitwiseXor');
const bitwise_or_expression			= binaryChain('bitwise_or_expression', 'bitwise_xor_expression', ['|'], 'bitwiseOr');
const logical_and_expression		= binaryChain('logical_and_expression', 'bitwise_or_expression', ['&&'], 'logicalAnd', 'logical');
const logical_or_expression			= binaryChain('logical_or_expression', 'logical_and_expression', ['||'], 'logicalOr', 'logical');

const relational_expression_noin	= binaryChain('relational_expression_noin', 'shift_expression', ['<', '>', '<=', '>=', 'instanceof'], 'relational');
const equality_expression_noin		= binaryChain('equality_expression_noin', 'relational_expression_noin', ['==', '!=', '===', '!=='], 'equality');
const bitwise_and_expression_noin	= binaryChain('bitwise_and_expression_noin', 'equality_expression_noin', ['&'], 'bitwiseAnd');
const bitwise_xor_expression_noin	= binaryChain('bitwise_xor_expression_noin', 'bitwise_and_expression_noin', ['^'], 'bitwiseXor');
const bitwise_or_expression_noin	= binaryChain('bitwise_or_expression_noin', 'bitwise_xor_expression_noin', ['|'], 'bitwiseOr');
const logical_and_expression_noin	= binaryChain('logical_and_expression_noin', 'bitwise_or_expression_noin', ['&&'], 'logicalAnd', 'logical');
const logical_or_expression_noin	= binaryChain('logical_or_expression_noin', 'logical_and_expression_noin', ['||'], 'logicalOr', 'logical');

// Own precedence level, above logical-or -- the real spec additionally
// forbids mixing '??' with '||'/'&&' at the same level without parens, but
// this grammar doesn't enforce that restriction (consistent with not
// enforcing other non-syntactic ECMAScript restrictions elsewhere here).
const nullish_expression			= binaryChain('nullish_expression', 'logical_or_expression', ['??'], 'nullish', 'logical');
const nullish_expression_noin		= binaryChain('nullish_expression_noin', 'logical_or_expression_noin', ['??'], 'nullish', 'logical');

const conditional_expression = Rules<Expr>(
	Rule(['nullish_expression'] as const, $ => $[0] as Expr),
	Rule(['nullish_expression', '?', 'assignment_expression', ':', 'assignment_expression'] as const, $ =>
		({ type: 'conditional', test: $[0] as Expr, consequent: $[2] as Expr, alternate: $[4] as Expr } as const)),
);
const conditional_expression_noin = Rules<Expr>(
	Rule(['nullish_expression_noin'] as const, $ => $[0] as Expr),
	Rule(['nullish_expression_noin', '?', 'assignment_expression', ':', 'assignment_expression_noin'] as const, $ =>
		({ type: 'conditional', test: $[0] as Expr, consequent: $[2] as Expr, alternate: $[4] as Expr } as const)),
);

// `'(' expression ')'` here is the *same* parse primary_expression's own
// parenthesized-expression rule produces -- the grammar doesn't try to
// predict an arrow function inside the parens at all (see exprToParams
// above); it only diverges from a plain parenthesized expression on the
// `=>` lookahead that follows the closing `)`, which is an ordinary,
// conflict-free one-token decision for an LR parser.
//
// Arrow functions aren't offered from assignment_expression_noin: they'd
// only matter inside a for-loop header's init/test/update clauses, where
// nobody realistically writes one, so that duplication isn't worth it here.
const arrow_body = Rules<Expr | Statement[]>(
	Rule(['{', '}'] as const, () => [] as Statement[]),
	Rule(['{', 'statement_list', '}'] as const, $ => $[1] as Statement[]),
	Rule(['assignment_expression'] as const, $ => $[0] as Expr),
);
const arrow_function = Rules<Expr>(
	Rule([IDENT, '=>', 'arrow_body'] as const, $ => ({ type: 'arrow', params: [$[0]], body: $[2] as Expr | Statement[] } as const)),
	Rule(['(', ')', '=>', 'arrow_body'] as const, $ => ({ type: 'arrow', params: [], body: $[3] as Expr | Statement[] } as const)),
	Rule(['(', '...', IDENT, ')', '=>', 'arrow_body'] as const, $ => ({ type: 'arrow', params: [], rest: $[2], body: $[5] as Expr | Statement[] } as const)),
	Rule(['(', 'expression', ')', '=>', 'arrow_body'] as const, $ => ({ type: 'arrow', params: exprToParams($[1] as Expr), body: $[4] as Expr | Statement[] } as const)),
	Rule(['(', 'expression', ',', '...', IDENT, ')', '=>', 'arrow_body'] as const, $ => ({ type: 'arrow', params: exprToParams($[1] as Expr), rest: $[4], body: $[7] as Expr | Statement[] } as const)),
	Rule(['async', IDENT, '=>', 'arrow_body'] as const, $ => ({ type: 'arrow', params: [$[1]], body: $[3] as Expr | Statement[], async: true } as const)),
	Rule(['async', '(', ')', '=>', 'arrow_body'] as const, $ => ({ type: 'arrow', params: [], body: $[4] as Expr | Statement[], async: true } as const)),
	Rule(['async', '(', '...', IDENT, ')', '=>', 'arrow_body'] as const, $ => ({ type: 'arrow', params: [], rest: $[3], body: $[6] as Expr | Statement[], async: true } as const)),
	Rule(['async', '(', 'expression', ')', '=>', 'arrow_body'] as const, $ => ({ type: 'arrow', params: exprToParams($[2] as Expr), body: $[5] as Expr | Statement[], async: true } as const)),
	Rule(['async', '(', 'expression', ',', '...', IDENT, ')', '=>', 'arrow_body'] as const, $ => ({ type: 'arrow', params: exprToParams($[2] as Expr), rest: $[5], body: $[8] as Expr | Statement[], async: true } as const)),
);

// `yield` with no argument relies on the same restricted-production/ASI
// machinery as `return` (see RESTRICTED_AFTER below) to stop a following
// token from being swallowed as its argument across a line break.
const yield_expression = Rules<Expr>(
	Rule(['yield'] as const, () => ({ type: 'yield' } as const)),
	Rule(['yield', 'assignment_expression'] as const, $ => ({ type: 'yield', argument: $[1] as Expr } as const)),
	Rule(['yield', '*', 'assignment_expression'] as const, $ => ({ type: 'yield', argument: $[2] as Expr, delegate: true } as const)),
);

const assignment_expression = Rules<Expr>(
	Rule(['left_hand_side_expression', ASSIGN_OP, 'assignment_expression'] as const, $ =>
		({ type: 'assign', operator: $[1], left: $[0] as Expr, right: $[2] as Expr } as const)),
	Rule(['conditional_expression'] as const, $ => $[0] as Expr),
	Rule(['arrow_function'] as const, $ => $[0] as Expr),
	Rule(['yield_expression'] as const, $ => $[0] as Expr),
);
const assignment_expression_noin = Rules<Expr>(
	Rule(['left_hand_side_expression', ASSIGN_OP, 'assignment_expression_noin'] as const, $ =>
		({ type: 'assign', operator: $[1], left: $[0] as Expr, right: $[2] as Expr } as const)),
	Rule(['conditional_expression_noin'] as const, $ => $[0] as Expr),
);

const expression = Rules<Expr>(
	Rule([assignment_expression] as const, $ => $[0]),
	Rule(['expression', ',', assignment_expression] as const, $ => {
		const left = $[0] as Expr;
		return left.type === 'sequence'
			? { type: 'sequence', expressions: [...left.expressions, $[2]] } as const
			: { type: 'sequence', expressions: [left, $[2]] } as const;
	}),
);
const expression_noin = Rules<Expr>(
	Rule([assignment_expression_noin] as const, $ => $[0]),
	Rule(['expression_noin', ',', assignment_expression_noin] as const, $ => {
		const left = $[0] as Expr;
		return left.type === 'sequence'
			? { type: 'sequence', expressions: [...left.expressions, $[2]] } as const
			: { type: 'sequence', expressions: [left, $[2]] } as const;
	}),
);

// --- Statements ---

// Destructuring declarations always require an initializer (`const {a};`
// isn't valid JS, since there'd be nothing to destructure) -- so unlike the
// plain-identifier alternative, there's no pattern-only rule here.
const variable_declaration = Rules<VarDeclarator>(
	Rule([IDENT] as const, $ => ({ name: $[0] } as const)),
	Rule([IDENT, '=', assignment_expression] as const, $ => ({ name: $[0], init: $[2] } as const)),
	Rule(['binding_pattern', '=', assignment_expression] as const, $ => ({ name: $[0] as BindingTarget, init: $[2] } as const)),
);
const variable_declaration_list = Rules<VarDeclarator[]>(
	Rule(['variable_declaration'] as const, $ => [$[0] as VarDeclarator]),
	Rule(['variable_declaration_list', ',', 'variable_declaration'] as const, $ => [...($[0] as VarDeclarator[]), $[2] as VarDeclarator]),
);
const variable_declaration_noin = Rules<VarDeclarator>(
	Rule([IDENT] as const, $ => ({ name: $[0] } as const)),
	Rule([IDENT, '=', assignment_expression_noin] as const, $ => ({ name: $[0], init: $[2] } as const)),
	Rule(['binding_pattern', '=', assignment_expression_noin] as const, $ => ({ name: $[0] as BindingTarget, init: $[2] } as const)),
);
const variable_declaration_list_noin = Rules<VarDeclarator[]>(
	Rule([variable_declaration_noin] as const, $ => [$[0]]),
	Rule(['variable_declaration_list_noin', ',', variable_declaration_noin] as const, $ => [...($[0] as VarDeclarator[]), $[2]]),
);

const variable_statement = Rules<Statement>(
	Rule([reOneOf(VAR_KEYWORDS), variable_declaration_list, ';'] as const, $ => ({ type: 'var', kind: $[0] as typeof VAR_KEYWORDS[number], declarations: $[1] } as const))
//	...VAR_KEYWORDS.map(kw => Rule([kw, 'variable_declaration_list', ';'] as const, $ =>
//		({ type: 'var', kind: kw, declarations: $[1] as VarDeclarator[] } as const))),
);

const statement_list = Rules<Statement[]>(
	Rule(['statement'] as const, $ => [$[0] as Statement]),
	Rule(['statement_list', 'statement'] as const, $ => [...($[0] as Statement[]), $[1] as Statement]),
);
const block = Rules<Statement>(
	Rule(['{', '}'] as const, () => ({ type: 'block', body: [] } as const)),
	Rule(['{', statement_list, '}'] as const, $ => ({ type: 'block', body: $[1] } as const)),
);

const expression_statement = Rules<Statement>(
	Rule([expression, ';'] as const, $ => ({ type: 'expression', expression: $[0] } as const)),
);

const if_statement = Rules<Statement>(
	Rule(['if', '(', expression, ')', 'statement'] as const, $ => ({ type: 'if', test: $[2], consequent: $[4] as Statement } as const)),
	Rule(['if', '(', expression, ')', 'statement', 'else', 'statement'] as const, $ => ({ type: 'if', test: $[2], consequent: $[4] as Statement, alternate: $[6] as Statement } as const)),
);

const for_init = Rules<ForInit>(
	Rule([reOneOf(VAR_KEYWORDS), variable_declaration_list_noin] as const, $ => ({ type: 'var', kind: $[0] as typeof VAR_KEYWORDS[number], declarations: $[1]} as const)),
	//...VAR_KEYWORDS.map(kw => Rule([kw, 'variable_declaration_list_noin'] as const, $ =>
	//	({ type: 'var', kind: kw, declarations: $[1] as VarDeclarator[] } as const))),
	Rule([expression_noin] as const, $ => $[0]),
);
const for_lhs = Rules<ForInit>(
	Rule([reOneOf(VAR_KEYWORDS), variable_declaration_noin] as const, $ => ({ type: 'var', kind: $[0] as typeof VAR_KEYWORDS[number], declarations: [$[1]] } as const)),
	//...VAR_KEYWORDS.map(kw => Rule([kw, 'variable_declaration_noin'] as const, $ =>
	//	({ type: 'var', kind: kw, declarations: [$[1] as VarDeclarator] as VarDeclarator[] } as const))),
	// `for (const {a} of arr)` -- a for-in/of binding has no initializer, so
	// (unlike variable_declaration_noin) the pattern stands alone here.
	Rule([reOneOf(VAR_KEYWORDS), 'binding_pattern'] as const, $ =>
		({ type: 'var', kind: $[0] as typeof VAR_KEYWORDS[number], declarations: [{ name: $[1] as BindingTarget }] } as const)),
	Rule([left_hand_side_expression] as const, $ => $[0]),
);

const expression_opt = Rules(
	Rule([] as const, () => undefined),
	Rule([expression] as const, $ => $[0]),
);

const iteration_statement = Rules<Statement>(
	Rule(['do', 'statement', 'while', '(', expression, ')', ';'] as const, $ => ({ type: 'do_while', body: $[1] as Statement, test: $[4] } as const)),
	Rule(['while', '(', expression, ')', 'statement'] as const, $ => ({ type: 'while', test: $[2], body: $[4] as Statement } as const)),
	Rule(['for', '(', ';', expression_opt, ';', expression_opt, ')', 'statement'] as const, $ => ({ type: 'for', test: $[3], update: $[5], body: $[7] as Statement } as const)),
	Rule(['for', '(', 'for_init', ';', expression_opt, ';', expression_opt, ')', 'statement'] as const, $ => ({ type: 'for', init: $[2] as ForInit, test: $[4], update: $[6], body: $[8] as Statement } as const)),
	Rule(['for', '(', 'for_lhs', 'in', expression, ')', 'statement'] as const, $ => ({ type: 'for_in', kind: 'in', left: $[2] as ForInit, right: $[4], body: $[6] as Statement } as const)),
	// 'of' takes an AssignmentExpression for the iterable (not a full Expression), same as the spec -- avoids the same comma-vs-separator ambiguity 'in' sidesteps via the NoIn chain.
	Rule(['for', '(', for_lhs, 'of', assignment_expression, ')', 'statement'] as const, $ => ({ type: 'for_in', kind: 'of', left: $[2], right: $[4], body: $[6] as Statement } as const)),
);

const continue_statement = Rules<Statement>(
	Rule(['continue', ';'] as const, () => ({ type: 'continue' } as const)),
	Rule(['continue', IDENT, ';'] as const, $ => ({ type: 'continue', label: $[1] } as const)),
);
const break_statement = Rules<Statement>(
	Rule(['break', ';'] as const, () => ({ type: 'break' } as const)),
	Rule(['break', IDENT, ';'] as const, $ => ({ type: 'break', label: $[1] } as const)),
);
const return_statement = Rules<Statement>(
	Rule(['return', ';'] as const, () => ({ type: 'return' } as const)),
	Rule(['return', expression, ';'] as const, $ => ({ type: 'return', argument: $[1] } as const)),
);
const with_statement = Rules<Statement>(
	Rule(['with', '(', expression, ')', 'statement'] as const, $ => ({ type: 'with', object: $[2], body: $[4] as Statement } as const)),
);
const labelled_statement = Rules<Statement>(
	Rule([IDENT, ':', 'statement'] as const, $ => ({ type: 'labeled', label: $[0], body: $[2] as Statement } as const)),
);

const case_clause = Rules<SwitchCase>(
	Rule(['case', expression, ':'] as const, $ => ({ test: $[1], consequent: [] } as const)),
	Rule(['case', expression, ':', 'statement_list'] as const, $ => ({ test: $[1], consequent: $[3] as Statement[] } as const)),
	Rule(['default', ':'] as const, () => ({ consequent: [] } as const)),
	Rule(['default', ':', 'statement_list'] as const, $ => ({ consequent: $[2] as Statement[] } as const)),
);
const case_clauses = Rules<SwitchCase[]>(
	Rule(['case_clause'] as const, $ => [$[0] as SwitchCase]),
	Rule(['case_clauses', 'case_clause'] as const, $ => [...($[0] as SwitchCase[]), $[1] as SwitchCase]),
);
const switch_statement = Rules<Statement>(
	Rule(['switch', '(', expression, ')', '{', '}'] as const, $ => ({ type: 'switch', discriminant: $[2], cases: [] } as const)),
	Rule(['switch', '(', expression, ')', '{', 'case_clauses', '}'] as const, $ => ({ type: 'switch', discriminant: $[2], cases: $[5] as SwitchCase[] } as const)),
);

const throw_statement = Rules<Statement>(
	Rule(['throw', expression, ';'] as const, $ => ({ type: 'throw', argument: $[1] } as const)),
);
const catch_ = Rules<{ param: string; body: Statement[] }>(
	Rule(['catch', '(', IDENT, ')', '{', '}'] as const, $ => ({ param: $[2], body: [] } as const)),
	Rule(['catch', '(', IDENT, ')', '{', 'statement_list', '}'] as const, $ => ({ param: $[2], body: $[5] as Statement[] } as const)),
);
const finally_ = Rules<Statement[]>(
	Rule(['finally', '{', '}'] as const, () => []),
	Rule(['finally', '{', 'statement_list', '}'] as const, $ => $[2] as Statement[]),
);
const try_block = Rules<Statement[]>(
	Rule(['try', '{', '}'] as const, () => []),
	Rule(['try', '{', 'statement_list', '}'] as const, $ => $[2] as Statement[]),
);
const try_statement = Rules<Statement>(
	Rule(['try_block', 'catch_'] as const, $ => { const c = $[1] as { param: string; body: Statement[] }; return { type: 'try', block: $[0] as Statement[], handlerParam: c.param, handlerBody: c.body } as const; }),
	Rule(['try_block', 'finally_'] as const, $ => ({ type: 'try', block: $[0] as Statement[], finalizer: $[1] as Statement[] } as const)),
	Rule(['try_block', 'catch_', 'finally_'] as const, $ => { const c = $[1] as { param: string; body: Statement[] }; return { type: 'try', block: $[0] as Statement[], handlerParam: c.param, handlerBody: c.body, finalizer: $[2] as Statement[] } as const; }),
);

const function_declaration = Rules<Statement>(
	Rule(['function', IDENT, parameter_clause, '{', 'function_body', '}'] as const, $ => {
		const p = $[2] as ParamList;
		return { type: 'function_decl', name: $[1], params: p.params, rest: p.rest, body: $[4] as Statement[] } as const;
	}),
	Rule(['function', '*', IDENT, parameter_clause, '{', 'function_body', '}'] as const, $ => {
		const p = $[3] as ParamList;
		return { type: 'function_decl', name: $[2], params: p.params, rest: p.rest, body: $[5] as Statement[], generator: true } as const;
	}),
	Rule(['async', 'function', IDENT, parameter_clause, '{', 'function_body', '}'] as const, $ => {
		const p = $[3] as ParamList;
		return { type: 'function_decl', name: $[2], params: p.params, rest: p.rest, body: $[5] as Statement[], async: true } as const;
	}),
	Rule(['async', 'function', '*', IDENT, parameter_clause, '{', 'function_body', '}'] as const, $ => {
		const p = $[4] as ParamList;
		return { type: 'function_decl', name: $[3], params: p.params, rest: p.rest, body: $[6] as Statement[], generator: true, async: true } as const;
	}),
);
const function_body = Rules<Statement[]>(
	Rule([] as const, () => []),
	Rule(['statement_list'] as const, $ => $[0] as Statement[]),
);

// --- Classes ---
// Static initialization blocks and private (`#name`) members aren't
// supported -- a known simplification.

const class_member_name = Rules<string | { computed: Expr }>(
	Rule(['property_name'] as const, $ => $[0] as string),
	Rule(['[', 'assignment_expression', ']'] as const, $ => ({ computed: $[1] as Expr } as const)),
);
// Static-ness is split out from the member shape itself (rather than
// duplicating every method/field alternative once with 'static' and once
// without), so the combinatorics stay linear instead of doubling.
const class_member_body = Rules<ClassMember>(
	Rule(['class_member_name', parameter_clause, '{', 'function_body', '}'] as const, $ => {
		const p = $[1] as ParamList;
		return { type: 'method', kind: 'method', key: $[0] as string | { computed: Expr }, value: { type: 'function', params: p.params, rest: p.rest, body: $[3] as Statement[] } } as const;
	}),
	Rule(['*', 'class_member_name', parameter_clause, '{', 'function_body', '}'] as const, $ => {
		const p = $[2] as ParamList;
		return { type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: p.params, rest: p.rest, body: $[4] as Statement[], generator: true } } as const;
	}),
	Rule(['get', 'class_member_name', '(', ')', '{', 'function_body', '}'] as const, $ =>
		({ type: 'method', kind: 'get', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: [], body: $[5] as Statement[] } } as const)),
	Rule(['set', 'class_member_name', '(', IDENT, ')', '{', 'function_body', '}'] as const, $ =>
		({ type: 'method', kind: 'set', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: [$[3] as string], body: $[6] as Statement[] } } as const)),
	Rule(['async', 'class_member_name', parameter_clause, '{', 'function_body', '}'] as const, $ => {
		const p = $[2] as ParamList;
		return { type: 'method', kind: 'method', key: $[1] as string | { computed: Expr }, value: { type: 'function', params: p.params, rest: p.rest, body: $[4] as Statement[], async: true } } as const;
	}),
	Rule(['async', '*', 'class_member_name', parameter_clause, '{', 'function_body', '}'] as const, $ => {
		const p = $[3] as ParamList;
		return { type: 'method', kind: 'method', key: $[2] as string | { computed: Expr }, value: { type: 'function', params: p.params, rest: p.rest, body: $[5] as Statement[], generator: true, async: true } } as const;
	}),
	Rule(['class_member_name', ';'] as const, $ => ({ type: 'field', key: $[0] as string | { computed: Expr } } as const)),
	Rule(['class_member_name', '=', 'assignment_expression', ';'] as const, $ => ({ type: 'field', key: $[0] as string | { computed: Expr }, value: $[2] as Expr } as const)),
);
const class_member = Rules<ClassMember>(
	Rule(['class_member_body'] as const, $ => $[0] as ClassMember),
	Rule(['static', 'class_member_body'] as const, $ => ({ ...$[1] as ClassMember, static: true } as const)),
);
const class_member_list = Rules<ClassMember[]>(
	Rule(['class_member'] as const, $ => [$[0] as ClassMember]),
	Rule(['class_member_list', 'class_member'] as const, $ => [...($[0] as ClassMember[]), $[1] as ClassMember]),
);
const class_body = Rules<ClassMember[]>(
	Rule(['{', '}'] as const, () => []),
	Rule(['{', 'class_member_list', '}'] as const, $ => $[1] as ClassMember[]),
);
const class_expression = Rules<Expr>(
	Rule(['class', 'class_body'] as const, $ => ({ type: 'class', body: $[1] as ClassMember[] } as const)),
	Rule(['class', IDENT, 'class_body'] as const, $ => ({ type: 'class', name: $[1], body: $[2] as ClassMember[] } as const)),
	Rule(['class', 'extends', 'left_hand_side_expression', 'class_body'] as const, $ => ({ type: 'class', superClass: $[2] as Expr, body: $[3] as ClassMember[] } as const)),
	Rule(['class', IDENT, 'extends', 'left_hand_side_expression', 'class_body'] as const, $ => ({ type: 'class', name: $[1], superClass: $[3] as Expr, body: $[4] as ClassMember[] } as const)),
);
const class_declaration = Rules<Statement>(
	Rule(['class', IDENT, 'class_body'] as const, $ => ({ type: 'class_decl', name: $[1], body: $[2] as ClassMember[] } as const)),
	Rule(['class', IDENT, 'extends', 'left_hand_side_expression', 'class_body'] as const, $ => ({ type: 'class_decl', name: $[1], superClass: $[3] as Expr, body: $[4] as ClassMember[] } as const)),
);

const statement = Rules<Statement>(
	Rule(['block'] as const, $ => $[0] as Statement),
	Rule(['variable_statement'] as const, $ => $[0] as Statement),
	Rule([';'] as const, () => ({ type: 'empty' } as const)),
	Rule(['expression_statement'] as const, $ => $[0] as Statement),
	Rule(['if_statement'] as const, $ => $[0] as Statement),
	Rule(['iteration_statement'] as const, $ => $[0] as Statement),
	Rule(['continue_statement'] as const, $ => $[0] as Statement),
	Rule(['break_statement'] as const, $ => $[0] as Statement),
	Rule(['return_statement'] as const, $ => $[0] as Statement),
	Rule(['with_statement'] as const, $ => $[0] as Statement),
	Rule(['labelled_statement'] as const, $ => $[0] as Statement),
	Rule(['switch_statement'] as const, $ => $[0] as Statement),
	Rule(['throw_statement'] as const, $ => $[0] as Statement),
	Rule(['try_statement'] as const, $ => $[0] as Statement),
	Rule(['debugger', ';'] as const, () => ({ type: 'debugger' } as const)),
	Rule(['function_declaration'] as const, $ => $[0] as Statement),
	Rule(['class_declaration'] as const, $ => $[0] as Statement),
);

// --- Modules ---
// import/export are only reachable from `module_item`, used solely by
// `program`'s own top level below -- they're deliberately not part of
// `statement`, since the real spec restricts them to a Program's top level
// (never inside a block or function body).

const import_specifier = Rules<ImportSpecifier>(
	Rule([IDENT] as const, $ => ({ imported: $[0], local: $[0] } as const)),
	Rule([IDENT, 'as', IDENT] as const, $ => ({ imported: $[0], local: $[2] } as const)),
);
const import_specifier_list = Rules<ImportSpecifier[]>(
	Rule(['import_specifier'] as const, $ => [$[0] as ImportSpecifier]),
	Rule(['import_specifier_list', ',', 'import_specifier'] as const, $ => [...($[0] as ImportSpecifier[]), $[2] as ImportSpecifier]),
);
const named_imports = Rules<ImportSpecifier[]>(
	Rule(['{', '}'] as const, () => []),
	Rule(['{', 'import_specifier_list', '}'] as const, $ => $[1] as ImportSpecifier[]),
	Rule(['{', 'import_specifier_list', ',', '}'] as const, $ => $[1] as ImportSpecifier[]),
);
const import_declaration = Rules<Statement>(
	Rule(['import', STRING, ';'] as const, $ => ({ type: 'import', source: unquoteString($[1]) } as const)),
	Rule(['import', IDENT, 'from', STRING, ';'] as const, $ => ({ type: 'import', default: $[1], source: unquoteString($[3]) } as const)),
	Rule(['import', '*', 'as', IDENT, 'from', STRING, ';'] as const, $ => ({ type: 'import', namespace: $[3], source: unquoteString($[5]) } as const)),
	Rule(['import', 'named_imports', 'from', STRING, ';'] as const, $ => ({ type: 'import', specifiers: $[1] as ImportSpecifier[], source: unquoteString($[3]) } as const)),
	Rule(['import', IDENT, ',', 'named_imports', 'from', STRING, ';'] as const, $ => ({ type: 'import', default: $[1], specifiers: $[3] as ImportSpecifier[], source: unquoteString($[5]) } as const)),
	Rule(['import', IDENT, ',', '*', 'as', IDENT, 'from', STRING, ';'] as const, $ => ({ type: 'import', default: $[1], namespace: $[5], source: unquoteString($[7]) } as const)),
);

const export_specifier = Rules<ExportSpecifier>(
	Rule([IDENT] as const, $ => ({ local: $[0], exported: $[0] } as const)),
	Rule([IDENT, 'as', IDENT] as const, $ => ({ local: $[0], exported: $[2] } as const)),
);
const export_specifier_list = Rules<ExportSpecifier[]>(
	Rule(['export_specifier'] as const, $ => [$[0] as ExportSpecifier]),
	Rule(['export_specifier_list', ',', 'export_specifier'] as const, $ => [...($[0] as ExportSpecifier[]), $[2] as ExportSpecifier]),
);
const named_exports = Rules<ExportSpecifier[]>(
	Rule(['{', '}'] as const, () => []),
	Rule(['{', 'export_specifier_list', '}'] as const, $ => $[1] as ExportSpecifier[]),
	Rule(['{', 'export_specifier_list', ',', '}'] as const, $ => $[1] as ExportSpecifier[]),
);
const export_declaration = Rules<Statement>(
	Rule(['export', 'named_exports', ';'] as const, $ => ({ type: 'export_named', specifiers: $[1] as ExportSpecifier[] } as const)),
	Rule(['export', 'named_exports', 'from', STRING, ';'] as const, $ => ({ type: 'export_named', specifiers: $[1] as ExportSpecifier[], source: unquoteString($[3]) } as const)),
	Rule(['export', '*', 'from', STRING, ';'] as const, $ => ({ type: 'export_all', source: unquoteString($[3]) } as const)),
	Rule(['export', '*', 'as', IDENT, 'from', STRING, ';'] as const, $ => ({ type: 'export_all', exported: $[3], source: unquoteString($[5]) } as const)),
	Rule(['export', 'default', 'assignment_expression', ';'] as const, $ => ({ type: 'export_default', declaration: $[2] as Expr } as const)),
	Rule(['export', 'default', 'function_declaration'] as const, $ => ({ type: 'export_default', declaration: $[2] as Statement } as const)),
	Rule(['export', 'default', 'class_declaration'] as const, $ => ({ type: 'export_default', declaration: $[2] as Statement } as const)),
	Rule(['export', 'variable_statement'] as const, $ => ({ type: 'export_decl', declaration: $[1] as Statement } as const)),
	Rule(['export', 'function_declaration'] as const, $ => ({ type: 'export_decl', declaration: $[1] as Statement } as const)),
	Rule(['export', 'class_declaration'] as const, $ => ({ type: 'export_decl', declaration: $[1] as Statement } as const)),
);

const module_item = Rules<Statement>(
	Rule(['import_declaration'] as const, $ => $[0] as Statement),
	Rule(['export_declaration'] as const, $ => $[0] as Statement),
	Rule(['statement'] as const, $ => $[0] as Statement),
);
const module_item_list = Rules<Statement[]>(
	Rule(['module_item'] as const, $ => [$[0] as Statement]),
	Rule(['module_item_list', 'module_item'] as const, $ => [...($[0] as Statement[]), $[1] as Statement]),
);

const program = Rules<Program>(
	Rule([] as const, () => ({ type: 'program', body: [] } as const)),
	Rule(['module_item_list'] as const, $ => ({ type: 'program', body: $[0] as Statement[] } as const)),
);

// ===================================================================
//  Wire it up
// ===================================================================

// Automatic Semicolon Insertion, expressed entirely as policy on top of tison's two general-purpose hooks (SoftTerminal.lex and GrammarSpec.recover)
// -- tison itself has no notion of any of this.
const RESTRICTED_AFTER = new Set(['return', 'throw', 'break', 'continue', 'yield'].map(escapeLit));
const RESTRICTED_BEFORE = new Set(['++', '--'].map(escapeLit));

// Restricted productions: reclassify a run of whitespace into a semicolon
// (unconditionally -- even though the real token would otherwise have
// parsed fine) when it contains a line terminator right after
// return/throw/break/continue, or right before postfix ++/--.
const WS = terminal(
	/\s+/,
	({ text, prev, peekNext }) => {
		if (!text.includes('\n'))
			return WS;
		if (prev && RESTRICTED_AFTER.has(prev.name))
			return ';';
		const next = peekNext();
		if (next && RESTRICTED_BEFORE.has(next.type.name))
			return ';';
		return WS;
	}
);

const jsParser = tison({
	skip: [WS, /\/\/[^\n]*/, /\/\*[^]*?\*\//],
	start: 'program',
	// Error-driven insertion: only when the real token would otherwise fail to parse, and is preceded by a line terminator, or is `}`, or EOF --
	// found by name among this state's own valid actions, so tison resolves nothing on our behalf. "Preceded by a line terminator" isn't a
	// special fact tison hands us -- it's just comparing this token's line against the previously-shifted one, the same line numbers every
	// token already carries for error messages.
	recover: (row, tok, prevToken) => {
		const newlineBefore = prevToken && tok.pos && prevToken.pos && tok.pos.line > prevToken.pos.line;
		if (!(newlineBefore || tok.value === '}' || tok.type === EOF))
			return undefined;
		const semi = [...row.keys()].find(t => t.name === ';');
		return semi && { type: semi, value: '' };
	},
	rules: {
		program, module_item, module_item_list,
		import_declaration, import_specifier, import_specifier_list, named_imports,
		export_declaration, export_specifier, export_specifier_list, named_exports,
		statement, statement_list,
		block, variable_statement, expression_statement, if_statement, iteration_statement,
		continue_statement, break_statement, return_statement, with_statement, labelled_statement,
		switch_statement, throw_statement, try_statement, function_declaration, function_body,
		class_declaration, class_expression, class_body, class_member, class_member_body, class_member_list, class_member_name,
		case_clause, case_clauses, try_block, catch_, finally_,
		for_init, for_lhs, expression_opt,
		variable_declaration, variable_declaration_list, variable_declaration_noin, variable_declaration_list_noin,
		expression, expression_noin, assignment_expression, assignment_expression_noin,
		conditional_expression, conditional_expression_noin, arrow_function, arrow_body, yield_expression,
		nullish_expression, logical_or_expression, logical_and_expression, bitwise_or_expression, bitwise_xor_expression, bitwise_and_expression,
		equality_expression, relational_expression,
		nullish_expression_noin, logical_or_expression_noin, logical_and_expression_noin, bitwise_or_expression_noin, bitwise_xor_expression_noin, bitwise_and_expression_noin,
		equality_expression_noin, relational_expression_noin,
		shift_expression, additive_expression, multiplicative_expression, exponentiation_expression,
		unary_expression, postfix_expression,
		left_hand_side_expression, new_expression, call_expression, member_expression, arguments_: arguments_, argument_list,
		function_expression, formal_parameter_list, parameter_clause, parameter,
		primary_expression, array_literal, element_list, object_literal, property_list, property_assignment, property_name,
		template_literal_part, template_literal_parts,
		binding_target, binding_pattern,
		object_pattern, object_pattern_property, object_pattern_property_list,
		array_pattern, array_pattern_element, array_pattern_element_list, elision,
	},
});

export const parseJS = (input: string) => jsParser.parse(input) as Program;

function test(name: string, code: string) {
	try {
		console.log(name);
		console.log(JSON.stringify(parseJS(code), null, 2));
	} catch (e) {
		console.error(`${name} failed:`, e);
	}
}

console.log('Testing JS Parser...\n');

test('template literals', `
var a = \`hello \${1+2} goodbye\`;
`);

// The interpolation's own '}' (closing the nested object literal) and the
// template's '}' (closing the interpolation) are different real tokens here
// -- disambiguated entirely by which grammar state the parser is in when
// each is reached, with no explicit brace-depth counter anywhere.
test('template literals: nested braces', `
var a = \`x = \${ {a: 1}.a } end\`;
`);


test('ASI: omitted semicolons', `
var a = 1
var b = 2
a + b
`);

test('ASI: restricted production (return)', `
function f() {
	return
	1
}
`);

test('ASI: restricted production (postfix ++)', `
var a = 1
var b = 2
a
++b
`);

test('Regex vs divide', `
var x = a / b
var y = /abc/.test(x)
var z = (1 + 2) / 3
`);

test('binaryChain associativity (3+ same-precedence operands)', `
var a = 1 - 2 - 3;
var b = x && y && z || w;
`);

test('for...of', `
for (const item of items) {
	console.log(item);
}
`);

test('exponentiation (right-associative)', `
var a = 2 ** 3 ** 2;
var b = -2 ** 2;
`);

test('nullish coalescing', `
var a = x ?? y ?? z;
var b = x ?? y ? 1 : 2;
`);

test('object literal shorthand / computed keys', `
var obj = {
	x,
	y,
	foo() { return 1; },
	bar(a, b) { return a + b; },
	[key]: value,
};
`);

test('spread in arrays and calls', `
var a = [1, ...rest, 2];
var b = f(1, ...args, 2);
`);

test('rest parameter', `
function f(a, b, ...rest) {
	return rest;
}
var g = function(...all) {
	return all;
};
var obj = {
	method(...args) { return args; },
};
`);

test('numeric literal upgrades', `
var a = 0b1010;
var b = 0o17;
var c = 1_000_000;
var d = 0x1_FF;
var e = 10n;
var f = 123_456n;
`);

test('tagged templates', `
var a = tag\`hello \${name}\`;
var b = obj.method\`plain text\`;
`);

test('optional chaining', `
var a = obj?.prop;
var b = obj?.[key];
var c = obj?.method();
var d = obj?.a?.b?.c;
`);

test('let and const', `
let a = 1;
const b = 2;
let c, d = 4;
for (let i = 0; i < 5; i++) {
	console.log(i);
}
for (const key in obj) {
	console.log(key);
}
`);

test('Program', `
function fib(n) {
	if (n < 2) {
		return n;
	} else {
		return fib(n - 1) + fib(n - 2);
	}
}

var results = [];
for (var i = 0; i < 5; i++) {
	results.push(fib(i));
}

var obj = {
	name: "test",
	get value() { return 42; },
	items: [1, 2, 3],
};

for (var key in obj) {
	console.log(key);
}
`);

test('default parameters', `
function f(a, b = 1, c = a + b) {
	return a + b + c;
}
var g = function(x = 10) { return x; };
`);

test('object destructuring', `
const {a, b} = obj;
let {x: renamed, y = 1, z: zRenamed = 2} = obj2;
const {p, ...restProps} = obj3;
const {nested: {deep}} = obj4;
`);

test('array destructuring', `
const [a, b] = arr;
let [x, y = 1] = arr2;
const [first, ...rest] = arr3;
const [, , third] = arr4;
const [a2, , c2] = arr5;
`);

test('array holes', `
var a = [1, , 3];
var b = [, , 3];
var c = [1, 2, ,];
var d = [,];
var e = [];
`);

test('destructuring in for-of/for-in', `
for (const {key, value} of entries) {
	console.log(key, value);
}
for (const [k, v] of pairs) {
	console.log(k, v);
}
`);

test('destructuring in function params', `
function f({a, b = 1}, [c, d]) {
	return a + b + c + d;
}
var g = function({x: renamed}) { return renamed; };
`);

test('import declarations', `
import 'side-effect-module';
import defaultExport from 'module1';
import { a, b as renamedB } from 'module2';
import * as ns from 'module3';
import defaultExport2, { c, d } from 'module4';
import defaultExport3, * as ns2 from 'module5';
`);

test('export declarations', `
export { a, b as renamedB };
export { c } from 'module1';
export * from 'module2';
export * as ns from 'module3';
export default 42;
export const x = 1;
export function f() { return 1; }
`);

test('arrow functions: basic forms', `
var a = x => x + 1;
var b = () => 1;
var c = (a, b) => a + b;
var d = (a, b) => { return a + b; };
var e = a => b => a + b;
arr.map(x => x * 2);
`);

test('arrow functions: defaults and rest', `
var a = (x, y = 1) => x + y;
var b = (...args) => args;
var c = (x, y, ...rest) => rest;
`);

test('arrow functions: destructured params', `
var a = ({x, y}) => x + y;
var b = ({x, y = 1}) => x + y;
var c = ([x, y]) => x + y;
var d = ([x, ...rest]) => rest;
var e = ({a: {b}}) => b;
`);

// `=> {}` is always an empty block, never an empty object literal --
// returning an object literal from a concise body needs parens, same as
// real JS, to keep it from being read as the start of a block.
test('arrow functions: block vs object literal body', `
var a = () => {};
var b = () => ({});
var c = () => ({ x: 1 });
`);

test('generators', `
function* gen() {
	yield 1;
	yield;
	yield 1 + 2;
	yield* other();
	var x = yield 1;
}
var g = function*() { yield 1; };
var named = function* inner() { yield 1; };
var obj = { *gen() { yield 1; } };
export function* exported() { yield 1; }
`);

test('yield restricted production (ASI)', `
function* gen() {
	yield
	foo()
}
`);

test('classes: basic', `
class Foo {
	constructor(x) {
		this.x = x;
	}
	bar() {
		return this.x;
	}
}
class Bar extends Foo {
	constructor() {
		super(1);
	}
}
var anon = class { method() { return 1; } };
var named = class Named { method() { return 1; } };
`);

test('classes: members', `
class Foo {
	x = 1;
	y;
	static z = 2;
	get value() { return this.x; }
	set value(v) { this.x = v; }
	static get staticValue() { return 1; }
	*gen() { yield 1; }
	static *staticGen() { yield 1; }
	[computedKey]() { return 1; }
	[computedField] = 1;
}
`);

test('classes: export', `
export class Foo {}
export default class Bar {}
export default class {}
`);

test('async functions', `
async function foo() {
	return await bar();
}
var f = async function() { return await bar(); };
var named = async function inner() { return await bar(); };
async function* gen() { yield await bar(); }
export async function exported() { return await bar(); }
`);

test('async arrow functions', `
var a = async x => await bar(x);
var b = async () => await bar();
var c = async (a, b) => await bar(a, b);
var d = async (...args) => await bar(args);
var e = async (a) => { return await bar(a); };
arr.map(async x => await transform(x));
`);

test('async methods', `
var obj = {
	async foo() { return await bar(); },
	async *gen() { yield await bar(); },
};
class Foo {
	async foo() { return await bar(); }
	async *gen() { yield await bar(); }
	static async staticFoo() { return await bar(); }
}
`);

test('await precedence', `
async function f() {
	return await a + await b;
}
`);

console.log('\nAll tests completed!');
