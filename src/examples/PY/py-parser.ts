import * as path from 'path';
import { terminal, OneOf, List, MaybeList, Forward, Rules, makeRule, Terminal, type RecoveryCallback } from '../../tison';
import { makeCachedParser } from '../../tableCache';
import { Literal, Identifier, Unary, Binary, stampPos } from '../common';
import type * as Common from '../common';

// ===================================================================
//  Python 3 parser using tison
// ===================================================================
//
// The off-side rule (significant indentation) is handled entirely in the
// lexer -- no separate tokenisation pass:
//
//   * `WS` matches a run of whitespace containing a newline (plus any
//     following blank / comment-only lines). Its callback suppresses the
//     newline inside brackets or after a `\` continuation (exactly like
//     js-parser.ts's ASI), otherwise reclassifies itself to `NEWLINE` and
//     records, against the indentation stack, whether an `INDENT` or some
//     number of `DEDENT`s is now owed.
//
//   * `INDENT` / `DEDENT` / `SEP` are zero-width terminals that pay that
//     debt down. The grammar shapes every block body (and the module) as
//     `stmt (SEP stmt)*`, so they only ever compete in a slot where no
//     real token is valid -- their empty match then wins uncontested.
//     `elif` / `else` / `except` / `finally` are the exception: they can
//     follow an outdented block *and* have length, so each is a terminal
//     that rejects its own match while `DEDENT`s are still owed.
//
//   * `recover` synthesises the last statement's `NEWLINE` and one
//     `DEDENT` per still-open block at EOF (the lexer loop never runs at
//     offset === length).
//
// Leaf expression nodes are the shared `../common` shapes (`Identifier`, `Literal`, `Unary`,
// `Binary`) -- the same vocabulary c-parser.ts and js-parser.ts emit -- so a single walker /
// analysis / codegen pass can span all three. `and`/`or` are nested `Binary`; only chained
// comparison keeps a Python-specific `Compare` node (CPython's AST does the same).
//
// Known simplifications:
//   * `match`/`case`/`type` are ordinary identifiers (no soft keywords).
//   * targets / argument ordering are not validated (permissive).
//   * string `Literal`s carry raw concatenated inner text, not the unescaped value (c-parser.ts
//     takes the same shortcut); string/bytes prefix is dropped.
//   * `with (a, b):` (no `as`) parses as one tuple context manager, not two (CPython 3.10+).
//   * f-strings parse `{...}` fields as real expressions (see `fstringOpen`/`fstringText` etc.),
//     but a literal `\` immediately before `{`/`}` always suppresses that field (`rf"C:\{x}"` is
//     one literal-text part) even in a raw string, where real CPython still starts a field there
//     -- raw only changes escape *values*, not brace recognition; not worth the doubled terminal
//     count (raw × non-raw × 4 quote styles) for this one adjacency.

// ===================================================================
//  Lexer
// ===================================================================

export interface Ctx {
	parenDepth:		number;		// () [] {} nesting -- newlines inside are non-logical
	indents:		number[];	// indentation stack, always starts [0]; maintained solely by WS
	owedIndent:		boolean;	// WS saw a deeper line -- the INDENT terminal still owes one token
	owedDedents:	number;		// ...or a shallower line -- this many DEDENT tokens still owed
}

export function newCtx(): Ctx {
	return { parenDepth: 0, indents: [0], owedIndent: false, owedDedents: 0 };
}

// Produced only by `WS`'s callback, never lexed directly (no pattern) -- same trick as
// c-parser.ts's TYPE_NAME.
export const NEWLINE = terminal('NEWLINE');

function measure(indent: string): number {
	let col = 0;
	for (const c of indent)
		col += c === '\t' ? 8 - (col % 8) : c === '\r' ? 0 : 1;
	return col;
}

const BLANK_TAIL = /^[ \t\f]*(?:#[^\n]*)?$/;

const WS = terminal('ws',
	/[ \t\f]*\r?\n(?:[ \t\f]*(?:#[^\n]*)?\r?\n)*[ \t\f]*/,
	(lex, ctx: Ctx) => {
		// implicit continuation inside brackets, and leading blank lines before any token
		if (ctx.parenDepth > 0 || !lex.prev)
			return WS;
		// a comment-only final line with no newline after it: skip, don't end the logical line here
		if (lex.remaining !== '' && BLANK_TAIL.test(lex.remaining))
			return WS;
		const col = measure(/[^\n]*$/.exec(lex.match)![0]);
		if (col > ctx.indents[ctx.indents.length - 1]) {
			ctx.indents.push(col);
			ctx.owedIndent = true;
		} else {
			let n = 0;
			while (col < ctx.indents[ctx.indents.length - 1]) {
				ctx.indents.pop();
				n++;
			}
			// a column matching no stack level is an IndentationError in CPython; realign permissively
			if (col > ctx.indents[ctx.indents.length - 1])
				ctx.indents[ctx.indents.length - 1] = col;
			ctx.owedDedents = n;
		}
		return NEWLINE;
	}
);

// Zero-width, indentation-driven. `/(?:)/` always matches empty; the callback is the real gate,
// paying down the INDENT / DEDENT debt WS recorded. Every block body and the module are shaped
// `stmt (SEP stmt)*`, so these only ever compete in a slot where no real token is valid.
const EMPTY = /(?:)/;

export const INDENT = terminal('INDENT', EMPTY, (_lex, ctx: Ctx) => {
	if (ctx.owedIndent) {
		ctx.owedIndent = false;
		return INDENT;
	}
	return undefined;
});

export const DEDENT = terminal('DEDENT', EMPTY, (_lex, ctx: Ctx) => {
	if (ctx.owedDedents > 0) {
		ctx.owedDedents--;
		return DEDENT;
	}
	return undefined;
});

// Statement separator at an unchanged indentation level (INDENT / DEDENT's complement).
export const SEP = terminal('SEP', EMPTY, (_lex, ctx: Ctx) =>
	!ctx.owedIndent && ctx.owedDedents === 0 ? SEP : undefined
);

// `elif` / `else` / `except` / `finally` have length, so in the lexer they out-compete the
// zero-width DEDENT that must precede them when they sit at the end of an outdented block. Each
// rejects its own match while DEDENTs are still owed, letting the DEDENT terminal take the slot;
// once the debt clears (the right nesting level is reached) the keyword lexes normally and
// attaches to the construct at that level.
function dedentGuardedKeyword(name: string): Terminal {
	const t = terminal(name, new RegExp(name + '\\b'), (_lex, ctx: Ctx) => ctx.owedDedents > 0 ? undefined : t);
	return t;
}
const ELIF = dedentGuardedKeyword('elif');
const ELSE = dedentGuardedKeyword('else');
const EXCEPT = dedentGuardedKeyword('except');
const FINALLY = dedentGuardedKeyword('finally');

function bracket(ch: string, delta: number): Terminal {
	const t = terminal(ch, new RegExp('\\' + ch), (_lex, ctx: Ctx) => {
		ctx.parenDepth = Math.max(0, ctx.parenDepth + delta);
		return t;
	});
	return t;
}
const oparen = bracket('(', +1), cparen = bracket(')', -1);
const obrack = bracket('[', +1), cbrack = bracket(']', -1);
const obrace = bracket('{', +1), cbrace = bracket('}', -1);

export const NAME	= terminal('NAME', /[A-Za-z_]\w*/);
export const NUMBER	= terminal('NUMBER', /0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:\d(?:_?\d)*\.?(?:\d(?:_?\d)*)?|\.\d(?:_?\d)*)(?:[eE][-+]?\d(?:_?\d)*)?[jJ]?/);
// `f`/`F` deliberately excluded here (unlike a plain `r`/`b`/`u` prefix) -- f-strings are split
// into their own terminals below so `{...}` interpolations parse as real expressions.
export const STRING	= terminal('STRING', /(?:[rRbBuU]|[rR][bB]|[bB][rR])?(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^\\'\n])*'|"(?:\\.|[^\\"\n])*")/);

// --- f-strings: prefix+quote opens a real sub-grammar (text runs + `{expr[=][!conv][:spec]}`
// fields) instead of one opaque token, one dedicated terminal family per quote style (triple
// binds longer so it always wins over the single-quote form at the same position). Nested `{`/`}`
// reuse the ordinary `obrace`/`cbrace` bracket terminals -- an interpolation is a real expression
// context, so `f"{ {1: 2}[1] }"` (a dict literal inside a field) tracks paren-depth correctly too.
function fstringOpen(name: string, q: string) { return terminal(name, new RegExp(`(?:[fF][rR]?|[rR][fF])${q}`)); }
function fstringClose(name: string, q: string) { return terminal(name, new RegExp(q)); }
// Runs to (but not including) an unescaped `{` (interpolation) or the closing quote; `{{`/`}}` are
// literal-brace escapes. Triple-quoted text may contain raw newlines and lone `'`/`"`.
function fstringText(name: string, close: string) {
	return terminal(name, new RegExp(`(?:\\\\.|\\{\\{|\\}\\}|(?!${close}|\\{(?!\\{))[\\s\\S])*`));
}
// No need to exclude the triple case here: `f'''` is 4 chars, `f'` only 2 -- longest match wins.
const FOPEN_SQ		= fstringOpen('f\'',	'\'');
const FOPEN_DQ		= fstringOpen('f"',		'"');
const FOPEN_SQ3		= fstringOpen('f\'\'\'', '\'\'\'');
const FOPEN_DQ3		= fstringOpen('f"""',	'"""');
const FCLOSE_SQ		= fstringClose('\'',	'\'');
const FCLOSE_DQ		= fstringClose('"',		'"');
const FCLOSE_SQ3	= fstringClose('\'\'\'', '\'\'\'');
const FCLOSE_DQ3	= fstringClose('"""',	'"""');
const FTEXT_SQ		= fstringText('ftext\'',	'[\'\\n]');
const FTEXT_DQ		= fstringText('ftext"',	'["\\n]');
const FTEXT_SQ3		= fstringText('ftext\'\'\'', '\'\'\'');
const FTEXT_DQ3		= fstringText('ftext"""',	'"""');
// A nested replacement field's own format spec (e.g. the `{width}` in `f"{x:{width}}"`) is plain
// text up to the next brace -- delimiter-independent, since format specs don't carry a Python
// quote of their own.
const FSPEC_TEXT	= terminal('fspec', /[^{}]*/);
const BANG			= terminal('!', /!/);

// ===================================================================
//  AST
// ===================================================================

// Leaf expression nodes are the shared shapes from `../common` -- the same ones c-parser.ts and
// js-parser.ts build -- so cross-language tooling sees one vocabulary:
//   `Identifier`  { type:'identifier', name }
//   `Literal<T>`  { type:'literal', value }   -- numbers, strings (raw, not unescaped), True/False/None
//   `Unary`       { type:'unary', operator, operand }
//   `Binary`      { type:'binary', operator, left, right }   -- includes `and`/`or`, nested left-assoc
// Chained comparison genuinely has no `Binary` form, so `Compare` stays its own node (CPython's AST
// likewise never emits a comparison as a plain binary op).
export type unaryOps	= '+' | '-' | '~' | 'not';
export type binaryOps	=
	| '+' | '-' | '*' | '/' | '//' | '%' | '@' | '**'
	| '&' | '|' | '^' | '<<' | '>>'
	| 'and' | 'or';
export type compareOps	= '<' | '>' | '<=' | '>=' | '==' | '!=' | '<>' | 'in' | 'not in' | 'is' | 'is not';

export interface Imaginary	{ type: 'imaginary'; value: number }
export interface Ellipsis	{ type: 'ellipsis' }
export interface Compare		{ type: 'compare'; left: Expr; ops: compareOps[]; comparators: Expr[] }
export type      Conditional	= Common.Conditional<Expr>;
export interface Lambda		{ type: 'lambda'; params: Param[]; body: Expr }
export interface NamedExpr	{ type: 'namedexpr'; target: string; value: Expr }
export type      Spread		= Common.Spread<Expr>;
export type      Member		= Common.Member<Expr>;
// `index` holds the whole `[...]` payload: a plain expression, a `SliceExpr`, or a `tuple` of either.
export type      Index		= Common.Index<Expr>;
export interface SliceExpr	{ type: 'slice'; lower?: Expr; upper?: Expr; step?: Expr }
export type      Call		= Common.Call<Expr, Arg>;
export type      Tuple		= Common.Sequence<Expr, 'tuple'>;
export type      ListLit	= Common.Sequence<Expr, 'list'>;
export type      SetLit		= Common.Sequence<Expr, 'set'>;
export interface DictLit	{ type: 'dict'; keys: (Expr | null)[]; values: Expr[] }
export interface Comprehension	{ type: 'for'; target: Expr; iter: Expr; is_async: boolean }
export interface CompIf			{ type: 'if'; test: Expr }
export type CompClause			= Comprehension | CompIf;
export interface GeneratorExp	{ type: 'genexp'; elt: Expr; gens: CompClause[] }
export interface ListComp		{ type: 'listcomp'; elt: Expr; gens: CompClause[] }
export interface SetComp			{ type: 'setcomp'; elt: Expr; gens: CompClause[] }
export interface DictComp		{ type: 'dictcomp'; key: Expr; value: Expr; gens: CompClause[] }
export interface Await			{ type: 'await'; value: Expr }
export interface YieldExpr		{ type: 'yield'; value?: Expr; from?: Expr }

// A `{expr[=][!conv][:spec]}` field inside an f-string. `spec`'s own text/nested-field parts
// mirror `FStringPart` one level down (`f"{x:{width}}"`'s spec is `[{text:''},{expr:width}]`) --
// real Python allows recursion here too, but a nested field's own `!conv`/`:spec`/`=` are dropped
// (CPython's own grammar barely exercises that either).
export interface FStringField	{ expr: Expr; selfDoc?: boolean; conv?: string; spec?: FStringSpecPart[] }
export type FStringSpecPart	= { text: string } | { expr: Expr };
export interface FStringPart	{ text: string; field?: FStringField }
export interface FStringLit	{ type: 'fstring'; parts: FStringPart[] }

export type Expr =
	| Identifier
	| Literal<number | bigint | string | boolean | null>
	| Imaginary | Ellipsis
	| Unary<Expr, unaryOps>
	| Binary<Expr, binaryOps>
	| Compare | Conditional | Lambda | NamedExpr
	| Spread | Member | Index | SliceExpr | Call | Tuple | ListLit | SetLit | DictLit
	| GeneratorExp | ListComp | SetComp | DictComp | Await | YieldExpr | FStringLit;

export interface Arg { kind: 'pos' | 'kw' | 'star' | 'dstar'; name?: string; value: Expr }

export interface Param { name?: string; annotation?: Expr; default?: Expr; kind?: 'normal' | 'star' | 'dstar' | 'slash' | 'stardelim' }

export interface Alias { name: string; asname?: string }

export type Stmt =
	| Common.ExprStmt<Expr>
	| { type: 'assign'; targets: Expr[]; value: Expr }
	| { type: 'augassign'; target: Expr; op: string; value: Expr }
	| { type: 'annassign'; target: Expr; annotation: Expr; value?: Expr }
	| Common.Return<Expr>
	| { type: 'pass' } | { type: 'break' } | { type: 'continue' }
	| Common.Throw<Expr> & { cause?: Expr }
	| { type: 'global'; names: string[] } | { type: 'nonlocal'; names: string[] }
	| { type: 'del'; targets: Expr }
	| { type: 'assert'; test: Expr; msg?: Expr }
	| { type: 'import'; names: Alias[] }
	| { type: 'importfrom'; module?: string; level: number; names: Alias[] | '*' }
	| { type: 'if'; test: Expr; body: Stmt[]; orelse: Stmt[] }
	| { type: 'while'; test: Expr; body: Stmt[]; orelse: Stmt[] }
	| { type: 'for'; target: Expr; iter: Expr; body: Stmt[]; orelse: Stmt[]; is_async: boolean }
	| { type: 'with'; items: WithItem[]; body: Stmt[]; is_async: boolean }
	| TryStmt
	| { type: 'funcdef'; name: string; params: Param[]; returns?: Expr; body: Stmt[]; decorators: Expr[]; is_async: boolean }
	| { type: 'classdef'; name: string; bases: Arg[]; body: Stmt[]; decorators: Expr[] };

export interface WithItem { context: Expr; optional_vars?: Expr }
export interface ExceptHandler extends Common.Handler<Stmt, string> { star: boolean; type?: Expr }
// `orelse` is the `else:` clause -- Python-only, so `Try` is extended rather than aliased.
export interface TryStmt extends Common.Try<Stmt, string> { handlers: ExceptHandler[]; orelse: Stmt[]; finalizer: Stmt[] }

export interface Module { type: 'module'; body: Stmt[] }

interface DictEntry { key: Expr | null; value: Expr }
interface CommaList { items: Expr[]; trailing: boolean }
interface AssignRhs { targets: Expr[]; value: Expr }
interface CompContent { comp: CompClause[] | null; list: CommaList }

// --- AST helpers ---

const PyUnary	= Unary<Expr, unaryOps>;
const PyBinary	= Binary<Expr, binaryOps>;

// `a < b < c` -> one `Compare` with all the ops; a lone `a < b` is still a `Compare` (single-op),
// matching CPython -- a C/analysis backend desugars either the same way.
function compare(left: Expr, op: compareOps, right: Expr): Compare {
	return left.type === 'compare'
		? { type: 'compare', left: left.left, ops: [...left.ops, op], comparators: [...left.comparators, right] }
		: { type: 'compare', left, ops: [op], comparators: [right] };
}

// Numbers -> `Literal<number|bigint>` (or `Imaginary` for a `j` suffix); strings -> `Literal<string>`
// carrying the concatenated *raw* inner text (escapes not processed -- same shortcut c-parser.ts takes).
function pyNumber(raw: string): Literal<number | bigint> | Imaginary {
	const t = raw.replace(/_/g, '');
	if (/[jJ]$/.test(t))
		return { type: 'imaginary', value: parseFloat(t.slice(0, -1)) };
	if (/^0[xX]/.test(t))
		return Literal(bigOrNum(parseInt(t.slice(2), 16), t));
	if (/^0[oO]/.test(t))
		return Literal(bigOrNum(parseInt(t.slice(2), 8), t));
	if (/^0[bB]/.test(t))
		return Literal(bigOrNum(parseInt(t.slice(2), 2), t));
	if (/[.eE]/.test(t))
		return Literal(parseFloat(t));
	return Literal(bigOrNum(parseInt(t, 10), t));
}
const bigOrNum = (n: number, lit: string): number | bigint => Number.isSafeInteger(n) ? n : BigInt(lit);

function pyString(parts: string[]): Literal<string> {
	return Literal(parts.map(p => {
		const m = /^[A-Za-z]*('''|"""|'|")([\s\S]*)\1$/.exec(p);
		return m ? m[2] : p;
	}).join(''));
}

const tupleOrSingle = (c: CommaList): Expr => c.items.length === 1 && !c.trailing ? c.items[0] : { type: 'tuple', elements: c.items };

// A generic `a (, a)* [,]` comma list that records whether a trailing comma was present (so a
// single element with no comma stays itself rather than becoming a 1-tuple).
function commaList(item: Rules<Expr>) {
	return Rules<CommaList>(self => [
		Rule([item, ','],			$ => ({ items: [$[0]], trailing: true })),
		Rule([item, ',', item],		$ => ({ items: [$[0], $[2]], trailing: false })),
		Rule([self, ',', item],		$ => ({ items: [...($[0] as CommaList).items, $[2]], trailing: false })),
		Rule([self, ','],			$ => ({ ...($[0] as CommaList), trailing: true })),
	]);
}

// A factory, not a shared rule: `fstring_field` sits right before each delimiter's own closing
// quote or continuing text run, so if all four delimiters shared one rule OBJECT here, its
// reduce's LALR lookahead would be the *union* of all four delimiters' follow terminals -- the
// lexer, handed that combined `allowed` set the instant `}` is shifted, would try every quote
// style's text/close terminal at once and (wrongly) take whichever matches the most characters
// (a triple-quote text terminal, say, cheerfully consuming straight through a single-quote's
// closing `"` since it only excludes `'''`). A fresh rule instance per delimiter keeps each
// reduce's lookahead delimiter-specific.
function fstringField() {
	return Rules<FStringField>(
		Rule([obrace, fwd_test, fstring_eq_opt, fstring_conv_opt, fstring_spec_opt, cbrace],
			$ => ({ expr: $[1], selfDoc: $[2] || undefined, conv: $[3], spec: $[4] })),
	);
}

// A text run + its optional trailing interpolation, repeated -- same shape as
// js-parser.ts's `template_literal_part`/`_parts`, just per f-string quote style (`FTEXT`
// already excludes that style's own closing sequence, see `fstringText` above).
function fstringParts(FTEXT: Terminal) {
	return List<FStringPart>(Rules<FStringPart>(
		Rule([FTEXT, fstringField()],	$ => ({ text: $[0], field: $[1] })),
		Rule([FTEXT],					$ => ({ text: $[0] })),
	));
}

// ===================================================================
//  Grammar
// ===================================================================

const Rule = makeRule<Ctx>(stampPos);

const AUGASSIGN = OneOf(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '>>=', '<<=', '&=', '^=', '|=', '@=']);

// Declared bottom-up so a rule can reference an already-declared group by object (typed); genuine
// cycles are cut with `Forward` (one edge per cycle), same as c-parser.ts.
export const
fwd_test			= Forward<Expr>(() => test),
fwd_testlist		= Forward<Expr>(() => testlist),
fwd_yield			= Forward<YieldExpr>(() => yield_expr),
fwd_arglist			= Forward<Arg[]>(() => arglist),
fwd_subscriptlist	= Forward<Expr>(() => subscriptlist),
fwd_comp_for		= Forward<CompClause[]>(() => comp_for),
fwd_testlist_comp	= Forward<CompContent>(() => testlist_comp),
fwd_dictorset		= Forward<Expr>(() => dictorsetmaker),
fwd_stmt			= Forward<Stmt[]>(() => stmt),

comp_op = Rules<compareOps>(
	Rule([OneOf(['<', '>', '==', '>=', '<=', '!=', '<>'])],	$ => $[0]),
	Rule(['in'],											() => 'in'),
	Rule(['not', 'in'],										() => 'not in'),
	Rule(['is'],											() => 'is'),
	Rule(['is', 'not'],										() => 'is not'),
),

// `lambda` parameters: like `param` but never annotated and never parenthesised.
lambda_param = Rules<Param>(
	Rule([NAME],						$ => ({ name: $[0] })),
	Rule([NAME, '=', fwd_test],			$ => ({ name: $[0], default: $[2] })),
	Rule(['*', NAME],					$ => ({ name: $[1], kind: 'star' })),
	Rule(['*'],							() => ({ kind: 'stardelim' })),
	Rule(['**', NAME],					$ => ({ name: $[1], kind: 'dstar' })),
),
lambda_params = List<Param>(lambda_param, ','),

lambdef = Rules<Expr>(
	Rule(['lambda', ':', fwd_test],					$ => ({ type: 'lambda', params: [], body: $[2] })),
	Rule(['lambda', lambda_params, ':', fwd_test],	$ => ({ type: 'lambda', params: $[1], body: $[3] })),
),

string_list = List<string>(Rules(Rule([STRING], $ => $[0]))),

// --- f-string interpolation fields: `{expr[=][!conv][:spec]}` ---
fstring_eq_opt = Rules<boolean>(
	Rule([],					() => false),
	Rule(['='],					() => true),
),
fstring_conv_opt = Rules<string | undefined>(
	Rule([],					() => undefined),
	Rule([BANG, NAME],			$ => $[1]),
),
fstring_spec_part = Rules<FStringSpecPart>(
	Rule([FSPEC_TEXT],			$ => ({ text: $[0] })),
	Rule([obrace, fwd_test, cbrace],	$ => ({ expr: $[1] })),
),
fstring_spec_opt = Rules<FStringSpecPart[] | undefined>(
	Rule([],					() => undefined),
	Rule([':', MaybeList(fstring_spec_part)],	$ => $[1]),
),

atom = Rules<Expr>(
	// `True`/`False`/`None` are folded in here rather than given their own string terminals: an
	// upper-case-initial keyword loses tison's longest-match tie-break to the `NAME` regex (its
	// pattern sorts before the keyword's), so they'd otherwise lex as plain identifiers.
	Rule([NAME],					$ => $[0] === 'True' ? Literal(true) : $[0] === 'False' ? Literal(false) : $[0] === 'None' ? Literal(null) : Identifier($[0])),
	Rule([NUMBER],					$ => pyNumber($[0])),
	Rule([string_list],				$ => pyString($[0])),
	Rule(['...'],					() => ({ type: 'ellipsis' } as const)),
	Rule([oparen, cparen],			() => ({ type: 'tuple', elements: [] })),
	Rule([oparen, fwd_yield, cparen],			$ => $[1]),
	Rule([oparen, fwd_testlist_comp, cparen],	$ => {
		const { comp, list } = $[1];
		return comp ? { type: 'genexp', elt: list.items[0], gens: comp } : tupleOrSingle(list);
	}),
	Rule([obrack, cbrack],			() => ({ type: 'list', elements: [] })),
	Rule([obrack, fwd_testlist_comp, cbrack],	$ => {
		const { comp, list } = $[1];
		return comp ? { type: 'listcomp', elt: list.items[0], gens: comp } : { type: 'list', elements: list.items };
	}),
	Rule([obrace, cbrace],			() => ({ type: 'dict', keys: [], values: [] })),
	Rule([obrace, fwd_dictorset, cbrace],		$ => $[1]),
	Rule([FOPEN_SQ, fstringParts(FTEXT_SQ), FCLOSE_SQ],		$ => ({ type: 'fstring', parts: $[1] })),
	Rule([FOPEN_DQ, fstringParts(FTEXT_DQ), FCLOSE_DQ],		$ => ({ type: 'fstring', parts: $[1] })),
	Rule([FOPEN_SQ3, fstringParts(FTEXT_SQ3), FCLOSE_SQ3],		$ => ({ type: 'fstring', parts: $[1] })),
	Rule([FOPEN_DQ3, fstringParts(FTEXT_DQ3), FCLOSE_DQ3],		$ => ({ type: 'fstring', parts: $[1] })),
),

// The expression grammar is a precedence *cascade* -- one nonterminal per level, each referencing
// the level above -- rather than one `Rules` block leaning on `WithPrec`. Cross-level precedence is
// then purely structural, and each `self OP higher` rule is left-associative for free (the right
// operand is a *different* nonterminal that can't absorb the next same-level operator). This is the
// shape js-parser.ts's `binaryChain` uses; the single-block-plus-`WithPrec` alternative silently
// produces right-associative, wrongly-nested trees when the operator sits behind an `OneOf`.

// trailers: call / subscript / attribute, left-recursive
atom_expr = Rules<Expr>(self => [
	atom,
	Rule([self, oparen, cparen],					$ => ({ type: 'call', callee: $[0], arguments: [] })),
	Rule([self, oparen, fwd_arglist, cparen],		$ => ({ type: 'call', callee: $[0], arguments: $[2] })),
	Rule([self, obrack, fwd_subscriptlist, cbrack],	$ => ({ type: 'index', object: $[0], index: $[2] })),
	Rule([self, '.', NAME],							$ => ({ type: 'member', object: $[0], property: $[2] })),
]),
await_expr = Rules<Expr>(
	atom_expr,
	Rule(['await', atom_expr],		$ => ({ type: 'await', value: $[1] })),
),
// `factor` (unary +/-/~) and `power` (**) are mutually recursive, exactly as in CPython's grammar:
// `factor: ('+'|'-'|'~') factor | power` and `power: await_expr ['**' factor]`. This gives
// `-2 ** 2 == -(2 ** 2)` and `2 ** -3 == 2 ** (-3)`.
factor = Rules<Expr>(self => [
	Forward<Expr>(() => power),
	Rule([OneOf(['+', '-', '~']), self],	$ => PyUnary($[0], $[1])),
]),
power = Rules<Expr>(
	await_expr,
	Rule([await_expr, '**', factor],		$ => PyBinary('**', $[0], $[2])),
),
term = Rules<Expr>(self => [
	factor,
	Rule([self, OneOf(['*', '/', '//', '%', '@']), factor],	$ => PyBinary($[1], $[0], $[2])),
]),
arith_expr = Rules<Expr>(self => [
	term,
	Rule([self, OneOf(['+', '-']), term],	$ => PyBinary($[1], $[0], $[2])),
]),
shift_expr = Rules<Expr>(self => [
	arith_expr,
	Rule([self, OneOf(['<<', '>>']), arith_expr],	$ => PyBinary($[1], $[0], $[2])),
]),
band_expr = Rules<Expr>(self => [
	shift_expr,
	Rule([self, '&', shift_expr],	$ => PyBinary('&', $[0], $[2])),
]),
bxor_expr = Rules<Expr>(self => [
	band_expr,
	Rule([self, '^', band_expr],	$ => PyBinary('^', $[0], $[2])),
]),
// `expr_bitor` is CPython's `expr` -- the bitwise-or level. `for`/`del`/`with ... as` targets and
// `*x` use it, deliberately below comparison so the `in` in `for x in xs` is never taken as the
// `in` comparison operator.
expr_bitor = Rules<Expr>(self => [
	bxor_expr,
	Rule([self, '|', bxor_expr],	$ => PyBinary('|', $[0], $[2])),
]),
comparison = Rules<Expr>(self => [
	expr_bitor,
	Rule([self, comp_op, expr_bitor],	$ => compare($[0], $[1], $[2])),
]),
not_test = Rules<Expr>(self => [
	comparison,
	Rule(['not', self],		$ => PyUnary('not', $[1])),
]),
and_test = Rules<Expr>(self => [
	not_test,
	Rule([self, 'and', not_test],	$ => PyBinary('and', $[0], $[2])),
]),
// `or_test` is the top of the cascade -- it stops short of the ternary and `lambda` (which `test`
// adds) so `x for x in xs if cond` stays unambiguous.
or_test = Rules<Expr>(self => [
	and_test,
	Rule([self, 'or', and_test],	$ => PyBinary('or', $[0], $[2])),
]),

test = Rules<Expr>(self => [
	or_test,
	Rule([or_test, 'if', or_test, ELSE, self],	$ => ({ type: 'conditional', test: $[2], consequent: $[0], alternate: $[4] })),
	lambdef,
]),

namedexpr_test = Rules<Expr>(
	test,
	Rule([NAME, ':=', test],		$ => ({ type: 'namedexpr', target: $[0], value: $[2] })),
),

star_expr = Rules<Expr>(
	Rule(['*', expr_bitor],			$ => ({ type: 'spread', operand: $[1] })),
),

// yield / yield from -- only valid inside parens or as an expression statement / assignment RHS.
yield_expr = Rules<YieldExpr>(
	Rule(['yield'],					() => ({ type: 'yield' })),
	Rule(['yield', fwd_testlist],	$ => ({ type: 'yield', value: $[1] })),
	Rule(['yield', 'from', test],	$ => ({ type: 'yield', from: $[2] })),
),

// --- comma-separated lists (tuple building) ---

testlist = Rules<Expr>(
	Rule([test],					$ => $[0]),
	Rule([commaList(test)],			$ => tupleOrSingle($[0])),
),

exprlist_item = Rules<Expr>(Rule([expr_bitor], $ => $[0]), Rule([star_expr], $ => $[0])),
exprlist = Rules<Expr>(
	Rule([exprlist_item],			$ => $[0]),
	Rule([commaList(exprlist_item)],	$ => tupleOrSingle($[0])),
),

// `testlist_star_expr` -- statement-level list allowing `*x` and `NAME := x`.
tse_item = Rules<Expr>(namedexpr_test, star_expr),
testlist_star_expr = Rules<Expr>(
	Rule([tse_item],				$ => $[0]),
	Rule([commaList(tse_item)],		$ => tupleOrSingle($[0])),
),

// --- `(...)` / `[...]` contents: plain list, or a comprehension ---

testlist_comp = Rules<CompContent>(
	Rule([tse_item, fwd_comp_for],	$ => ({ comp: $[1], list: { items: [$[0]], trailing: false } })),
	Rule([tse_item],				$ => ({ comp: null, list: { items: [$[0]], trailing: false } })),
	Rule([commaList(tse_item)],		$ => ({ comp: null, list: $[0] })),
),

comp_if_tail = Rules<CompClause[]>(self => [
	Rule([],								() => []),
	Rule(['if', or_test, self],				$ => [{ type: 'if', test: $[1] }, ...($[2] as CompClause[])]),
	Rule([fwd_comp_for],					$ => $[0]),
]),
comp_for = Rules<CompClause[]>(
	Rule(['for', exprlist, 'in', or_test, comp_if_tail],			$ => [{ type: 'for', target: $[1], iter: $[3], is_async: false }, ...$[4]]),
	Rule(['async', 'for', exprlist, 'in', or_test, comp_if_tail],	$ => [{ type: 'for', target: $[2], iter: $[4], is_async: true }, ...$[5]]),
),

// --- `{...}` contents: dict / set / dict-comp / set-comp ---

dict_item = Rules<DictEntry>(
	Rule([test, ':', test],			$ => ({ key: $[0], value: $[2] })),
	Rule(['**', or_test],			$ => ({ key: null, value: $[1] })),
),
dict_more = Rules<DictEntry[]>(self => [
	Rule([],						() => []),
	Rule([','],						() => []),
	Rule([',', dict_item, self],	$ => [$[1], ...($[2] as DictEntry[])]),
]),
set_more = Rules<Expr[]>(self => [
	Rule([],						() => []),
	Rule([','],						() => []),
	Rule([',', tse_item, self],		$ => [$[1], ...($[2] as Expr[])]),
]),
dictorsetmaker = Rules<Expr>(
	Rule([dict_item, fwd_comp_for],	$ => ({ type: 'dictcomp', key: $[0].key!, value: $[0].value, gens: $[1] })),
	Rule([dict_item, dict_more],		$ => {
		const entries = [$[0], ...$[1]];
		return { type: 'dict', keys: entries.map(e => e.key), values: entries.map(e => e.value) };
	}),
	Rule([tse_item, fwd_comp_for],	$ => ({ type: 'setcomp', elt: $[0], gens: $[1] })),
	Rule([tse_item, set_more],		$ => ({ type: 'set', elements: [$[0], ...$[1]] })),
),

// --- call arguments ---

argument = Rules<Arg>(
	Rule([test],					$ => ({ kind: 'pos', value: $[0] })),
	Rule([NAME, ':=', test],		$ => ({ kind: 'pos', value: { type: 'namedexpr', target: $[0], value: $[2] } })),
	Rule([NAME, '=', test],			$ => ({ kind: 'kw', name: $[0], value: $[2] })),
	Rule(['*', test],				$ => ({ kind: 'star', value: $[1] })),
	Rule(['**', test],				$ => ({ kind: 'dstar', value: $[1] })),
),
arglist_plain = List<Arg>(argument, ',', true),
arglist = Rules<Arg[]>(
	Rule([test, fwd_comp_for],		$ => [{ kind: 'pos', value: { type: 'genexp', elt: $[0], gens: $[1] } }]),
	Rule([arglist_plain],			$ => $[0]),
),

// --- subscripts / slices ---

subscript = Rules<Expr>(
	Rule([test],							$ => $[0]),
	Rule([':'],								() => ({ type: 'slice' })),
	Rule([test, ':'],						$ => ({ type: 'slice', lower: $[0] })),
	Rule([':', test],						$ => ({ type: 'slice', upper: $[1] })),
	Rule([test, ':', test],					$ => ({ type: 'slice', lower: $[0], upper: $[2] })),
	Rule([':', ':', test],					$ => ({ type: 'slice', step: $[2] })),
	Rule([test, ':', ':', test],			$ => ({ type: 'slice', lower: $[0], step: $[3] })),
	Rule([':', test, ':', test],			$ => ({ type: 'slice', upper: $[1], step: $[3] })),
	Rule([test, ':', test, ':', test],		$ => ({ type: 'slice', lower: $[0], upper: $[2], step: $[4] })),
	Rule([test, ':', ':'],					$ => ({ type: 'slice', lower: $[0] })),
	Rule([':', test, ':'],					$ => ({ type: 'slice', upper: $[1] })),
	Rule([test, ':', test, ':'],			$ => ({ type: 'slice', lower: $[0], upper: $[2] })),
	Rule([':', ':'],						() => ({ type: 'slice' })),
),
subscriptlist = Rules<Expr>(
	Rule([subscript],						$ => $[0]),
	Rule([commaList(subscript as Rules<Expr>)],	$ => ({ type: 'tuple', elements: $[0].items })),
),

// ===================================================================
//  Statements
// ===================================================================

param = Rules<Param>(
	Rule([NAME],							$ => ({ name: $[0] })),
	Rule([NAME, ':', test],					$ => ({ name: $[0], annotation: $[2] })),
	Rule([NAME, '=', test],					$ => ({ name: $[0], default: $[2] })),
	Rule([NAME, ':', test, '=', test],		$ => ({ name: $[0], annotation: $[2], default: $[4] })),
	Rule(['*', NAME],						$ => ({ name: $[1], kind: 'star' })),
	Rule(['*', NAME, ':', test],			$ => ({ name: $[1], annotation: $[3], kind: 'star' })),
	Rule(['*'],								() => ({ kind: 'stardelim' })),
	Rule(['**', NAME],						$ => ({ name: $[1], kind: 'dstar' })),
	Rule(['**', NAME, ':', test],			$ => ({ name: $[1], annotation: $[3], kind: 'dstar' })),
	Rule(['/'],								() => ({ kind: 'slash' })),
),
paramlist = List<Param>(param, ',', true),
parameters = Rules<Param[]>(
	Rule([oparen, cparen],					() => []),
	Rule([oparen, paramlist, cparen],		$ => $[1]),
),

dotted_name = Rules<string>(self => [
	Rule([NAME],					$ => $[0]),
	Rule([self, '.', NAME],			$ => `${$[0]}.${$[2]}`),
]),
import_as_name = Rules<Alias>(
	Rule([NAME],					$ => ({ name: $[0] })),
	Rule([NAME, 'as', NAME],		$ => ({ name: $[0], asname: $[2] })),
),
dotted_as_name = Rules<Alias>(
	Rule([dotted_name],				$ => ({ name: $[0] })),
	Rule([dotted_name, 'as', NAME],	$ => ({ name: $[0], asname: $[2] })),
),
dotted_as_names	= List<Alias>(dotted_as_name, ','),
import_as_names	= List<Alias>(import_as_name, ',', true),
import_dots = Rules<number>(self => [
	Rule(['.'],						() => 1),
	Rule(['...'],					() => 3),
	Rule([self, '.'],				$ => ($[0] as number) + 1),
	Rule([self, '...'],				$ => ($[0] as number) + 3),
]),
import_from_targets = Rules<Alias[] | '*'>(
	Rule(['*'],								() => '*' as const),
	Rule([import_as_names],					$ => $[0]),
	Rule([oparen, import_as_names, cparen],	$ => $[1]),
),

name_list = List<string>(Rules(Rule([NAME], $ => $[0])), ','),

// value side of `=` chains: `a = b = c` -> targets [a, b], value c
assign_rhs = Rules<AssignRhs>(self => [
	Rule([fwd_yield],								$ => ({ targets: [], value: $[0] })),
	Rule([testlist_star_expr],						$ => ({ targets: [], value: $[0] })),
	Rule([testlist_star_expr, '=', self],			$ => ({ targets: [$[0], ...($[2] as AssignRhs).targets], value: ($[2] as AssignRhs).value })),
]),
assign_rhs_v = Rules<Expr>(Rule([fwd_yield], $ => $[0]), Rule([fwd_testlist], $ => $[0])),

small_stmt = Rules<Stmt>(
	Rule([testlist_star_expr],								$ => ({ type: 'expression', expression: $[0] })),
	Rule([fwd_yield],										$ => ({ type: 'expression', expression: $[0] })),
	Rule([testlist_star_expr, AUGASSIGN, assign_rhs_v],		$ => ({ type: 'augassign', target: $[0], op: $[1] as string, value: $[2] })),
	Rule([testlist_star_expr, ':', test],					$ => ({ type: 'annassign', target: $[0], annotation: $[2] })),
	Rule([testlist_star_expr, ':', test, '=', test],		$ => ({ type: 'annassign', target: $[0], annotation: $[2], value: $[4] })),
	Rule([testlist_star_expr, '=', assign_rhs],				$ => ({ type: 'assign', targets: [$[0], ...$[2].targets], value: $[2].value })),
	Rule(['pass'],											() => ({ type: 'pass' })),
	Rule(['break'],											() => ({ type: 'break' })),
	Rule(['continue'],										() => ({ type: 'continue' })),
	Rule(['return'],										() => ({ type: 'return' })),
	Rule(['return', testlist_star_expr],					$ => ({ type: 'return', argument: $[1] })),
	Rule(['raise'],											() => ({ type: 'throw' })),
	Rule(['raise', test],									$ => ({ type: 'throw', argument: $[1] })),
	Rule(['raise', test, 'from', test],						$ => ({ type: 'throw', argument: $[1], cause: $[3] })),
	Rule(['global', name_list],								$ => ({ type: 'global', names: $[1] })),
	Rule(['nonlocal', name_list],							$ => ({ type: 'nonlocal', names: $[1] })),
	Rule(['del', exprlist],									$ => ({ type: 'del', targets: $[1] })),
	Rule(['assert', test],									$ => ({ type: 'assert', test: $[1] })),
	Rule(['assert', test, ',', test],						$ => ({ type: 'assert', test: $[1], msg: $[3] })),
	Rule(['import', dotted_as_names],						$ => ({ type: 'import', names: $[1] })),
	Rule(['from', dotted_name, 'import', import_from_targets],		$ => ({ type: 'importfrom', module: $[1], level: 0, names: $[3] })),
	Rule(['from', import_dots, 'import', import_from_targets],		$ => ({ type: 'importfrom', level: $[1], names: $[3] })),
	Rule(['from', import_dots, dotted_name, 'import', import_from_targets],	$ => ({ type: 'importfrom', module: $[2], level: $[1], names: $[4] })),
),

small_stmts = List<Stmt>(small_stmt, ';'),
simple_stmt = Rules<Stmt[]>(
	Rule([small_stmts, NEWLINE],		$ => $[0]),
	Rule([small_stmts, ';', NEWLINE],	$ => $[0]),
),

// --- suite (block body) ---

// The `stmt (SEP stmt)*` shape is what makes the zero-width SEP / DEDENT terminals viable: after a
// complete stmt the only valid tokens are SEP (another stmt at this level) or DEDENT (block ends) --
// no real token competes for that position, so the empty match always wins.
stmts = Rules<Stmt[]>(self => [
	Rule([fwd_stmt],				$ => $[0]),
	Rule([self, SEP, fwd_stmt],		$ => [...($[0] as Stmt[]), ...$[2]]),
]),
suite = Rules<Stmt[]>(
	simple_stmt,
	Rule([NEWLINE, INDENT, stmts, DEDENT],	$ => $[2]),
),

// --- compound statements ---

else_opt = Rules<Stmt[]>(
	Rule([],						() => []),
	Rule([ELSE, ':', suite],		$ => $[2]),
),
if_tail = Rules<Stmt[]>(self => [
	Rule([],								() => []),
	Rule([ELIF, namedexpr_test, ':', suite, self],	$ => [{ type: 'if', test: $[1], body: $[3], orelse: $[4] as Stmt[] }]),
	Rule([ELSE, ':', suite],				$ => $[2]),
]),
if_stmt = Rules<Stmt>(
	Rule(['if', namedexpr_test, ':', suite, if_tail],	$ => ({ type: 'if', test: $[1], body: $[3], orelse: $[4] })),
),
while_stmt = Rules<Stmt>(
	Rule(['while', namedexpr_test, ':', suite, else_opt],	$ => ({ type: 'while', test: $[1], body: $[3], orelse: $[4] })),
),
for_stmt = Rules<Stmt>(
	Rule(['for', exprlist, 'in', testlist, ':', suite, else_opt],	$ => ({ type: 'for', target: $[1], iter: $[3], body: $[5], orelse: $[6], is_async: false })),
),

except_clause = Rules<ExceptHandler>(
	Rule([EXCEPT, ':', suite],					$ => ({ star: false, body: $[2] })),
	Rule([EXCEPT, test, ':', suite],				$ => ({ star: false, type: $[1], body: $[3] })),
	Rule([EXCEPT, test, 'as', NAME, ':', suite],	$ => ({ star: false, type: $[1], param: $[3], body: $[5] })),
	Rule([EXCEPT, '*', test, ':', suite],			$ => ({ star: true, type: $[2], body: $[4] })),
	Rule([EXCEPT, '*', test, 'as', NAME, ':', suite],	$ => ({ star: true, type: $[2], param: $[4], body: $[6] })),
),
except_clauses = List<ExceptHandler>(except_clause),
finally_opt = Rules<Stmt[]>(
	Rule([],							() => []),
	Rule([FINALLY, ':', suite],		$ => $[2]),
),
try_stmt = Rules<Stmt>(
	Rule(['try', ':', suite, except_clauses, else_opt, finally_opt],	$ => ({ type: 'try', body: $[2], handlers: $[3], orelse: $[4], finalizer: $[5] })),
	Rule(['try', ':', suite, FINALLY, ':', suite],					$ => ({ type: 'try', body: $[2], handlers: [], orelse: [], finalizer: $[5] })),
),

with_item = Rules<WithItem>(
	Rule([test],						$ => ({ context: $[0] })),
	Rule([test, 'as', expr_bitor],		$ => ({ context: $[0], optional_vars: $[2] })),
),
with_items = List<WithItem>(with_item, ','),
// The 3.10 parenthesised form (`with (a as b, c as d):`) is genuinely ambiguous with a
// parenthesised-expression context manager in one token of lookahead -- CPython resolves it with
// PEG backtracking. Here tison's on-demand GLR forks at `with (` and the wrong branch dies at the
// first `as` (or both branches merge harmlessly when there is no `as`).
with_stmt = Rules<Stmt>(
	Rule(['with', with_items, ':', suite],						$ => ({ type: 'with', items: $[1], body: $[3], is_async: false })),
	Rule(['with', oparen, with_items, cparen, ':', suite],		$ => ({ type: 'with', items: $[2], body: $[5], is_async: false })),
	Rule(['with', oparen, with_items, ',', cparen, ':', suite],	$ => ({ type: 'with', items: $[2], body: $[6], is_async: false })),
),

funcdef = Rules<Stmt>(
	Rule(['def', NAME, parameters, ':', suite],					$ => ({ type: 'funcdef', name: $[1], params: $[2], body: $[4], decorators: [], is_async: false })),
	Rule(['def', NAME, parameters, '->', test, ':', suite],		$ => ({ type: 'funcdef', name: $[1], params: $[2], returns: $[4], body: $[6], decorators: [], is_async: false })),
),
classdef = Rules<Stmt>(
	Rule(['class', NAME, ':', suite],					$ => ({ type: 'classdef', name: $[1], bases: [], body: $[3], decorators: [] })),
	Rule(['class', NAME, oparen, cparen, ':', suite],	$ => ({ type: 'classdef', name: $[1], bases: [], body: $[5], decorators: [] })),
	Rule(['class', NAME, oparen, arglist, cparen, ':', suite],	$ => ({ type: 'classdef', name: $[1], bases: $[3], body: $[6], decorators: [] })),
),

decorator = Rules<Expr>(Rule(['@', namedexpr_test, NEWLINE], $ => $[1])),
decorators = List<Expr>(decorator),
async_body = Rules<Stmt>(funcdef, for_stmt, with_stmt),
decorated = Rules<Stmt>(
	Rule([decorators, funcdef],				$ => ({ ...($[1] as Stmt & { decorators: Expr[] }), decorators: $[0] })),
	Rule([decorators, classdef],			$ => ({ ...($[1] as Stmt & { decorators: Expr[] }), decorators: $[0] })),
	Rule([decorators, 'async', funcdef],	$ => ({ ...($[2] as Stmt & { decorators: Expr[]; is_async: boolean }), decorators: $[0], is_async: true })),
),
async_stmt = Rules<Stmt>(
	Rule(['async', async_body],		$ => ({ ...($[1] as Stmt & { is_async: boolean }), is_async: true })),
),

compound_stmt = Rules<Stmt>(
	if_stmt, while_stmt, for_stmt, try_stmt, with_stmt, funcdef, classdef, decorated, async_stmt,
),

stmt = Rules<Stmt[]>(
	simple_stmt,
	Rule([compound_stmt],			$ => [$[0]]),
),

file_input = Rules<Module>(
	Rule([],						() => ({ type: 'module', body: [] })),
	Rule([stmts],					$ => ({ type: 'module', body: $[0] })),
);

// ===================================================================
//  Wire it up
// ===================================================================

// At EOF the lexer loop never runs (offset === length), so the last statement's `NEWLINE` and one
// `DEDENT` per still-open block are synthesised here, driven purely by what the stuck state accepts.
const recover: RecoveryCallback = (lex, row) => {
	if (lex.remaining === '') {
		const want = (n: string) => [...row.keys()].find(t => t.name === n);
		return want('NEWLINE') ?? want('DEDENT');
	}
};

export const skip = [/[ \t\f]+/, /#[^\n]*/, /\\\r?\n/, WS];

export const rules = {
	atom, atom_expr, await_expr, factor, power, term, arith_expr, shift_expr,
	band_expr, bxor_expr, expr_bitor, comparison, not_test, and_test, or_test,
	test, namedexpr_test, testlist, exprlist, testlist_star_expr,
	comp_op, lambdef, yield_expr, star_expr,
	testlist_comp, comp_for, comp_if_tail, dictorsetmaker,
	argument, arglist, subscript, subscriptlist,
	param, paramlist, parameters,
	dotted_name, import_as_name, dotted_as_name, import_from_targets,
	small_stmt, simple_stmt, assign_rhs,
	stmts, suite, stmt, compound_stmt,
	if_stmt, while_stmt, for_stmt, try_stmt, with_stmt, funcdef, classdef, decorated, async_stmt,
	except_clause, with_item,
	file_input,
};

export const parser = makeCachedParser({
	skip,
	recover,
	start: file_input,
	rules,
}, path.join(__dirname, '../../../.tables-cache/py-parser.json.gz'));

export function parse(code: string): Module {
	return parser.parse(code, newCtx());
}
