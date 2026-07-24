import { makeParser, Rules, Forward, MaybeList, terminal, ForceFork } from '../../src/tison';
import * as JS from './js-parser';
import { Literal } from '../common';

const Rule = JS.Rule;
const IDENT = JS.IDENT;
// ===================================================================
//  JSX Parser -- an extension of js-parser, composable with ts-parser
// ===================================================================
//
// Unlike ts-parser.ts, this file never imports ts-parser.ts: it only ever pushes onto js-parser.ts's own
// shared expression-chain arrays (`member_expression`/`member_expression_nobrace`), the same array objects
// ts-parser.ts reuses rather than copies. So importing *both* this file and ts-parser.ts (in either order --
// neither imports the other) gives full TSX support for free: parse with `TS.parse`, not this file's own
// `parse`, once both modules have been loaded. This file's own exported `parser`/`parse` is for plain
// JSX-in-JS (no TypeScript) instead.
//
// Known simplifications/omissions:
//   - No generic-component type arguments (`<Foo<T> />`) -- ts-parser.ts has no `<Type>expr` cast syntax
//     either, so there'd be no ambiguity to resolve, but the feature itself isn't implemented here.
//   - The closing tag's own name is parsed but never checked against the opening tag's -- a real mismatch
//     (`<div></span>`) is a semantic error, not a syntax one, out of scope for a syntax-only grammar.
//   - JSX attribute string values don't process backslash escapes (matching the real JSX spec -- unlike a JS
//     string literal, `attr="C:\path"` keeps the backslash literally); a dedicated `JSX_STR` terminal handles
//     this rather than reusing js-parser.ts's own `STR`/`unquoteString`.
//   - Whitespace-only text runs between tags (e.g. the indentation/newline in `<div>\n  <Child/>\n</div>`)
//     are silently discarded by js-parser.ts's own `WS` skip terminal rather than kept as a `jsx_text` node --
//     matches real JSX's own line-trimming for the common (has-a-newline) case, but real JSX preserves a
//     single inter-tag space with no newline (`<div> </div>`) as literal text, which this simplification drops.

// ===================================================================
//  AST
// ===================================================================

// Dotted (`Foo.Bar`) or namespaced (`svg:rect`) -- the grammar keeps the two forms mutually exclusive (like
// the real spec), so a flat string round-trips either shape losslessly (split on `.`/`:` if the parts are
// ever needed back) without carrying a nested structure nothing here actually uses -- same call ts-parser.ts
// already made for its own `dotted_path`, down to reusing its self-recursive concatenation shape verbatim.

export interface JSXAttribute<T>	{ name?: string; value?: Expr<T> }
export function  JSXAttribute<T>(name: string, value?: Expr<T>): JSXAttribute<T>	{ return { name, value }; }
export function  JSXSpreadAttribute<T>(value?: Expr<T>): JSXAttribute<T>			{ return { value }; }

export interface JSXElement<T>		{ type: 'jsx_element'; name?: string; attributes: JSXAttribute<T>[]; children: Expr<T>[] }
export function  JSXElement<T>(name: string, attributes: JSXAttribute<T>[], children: Expr<T>[]): JSXElement<T> {
	return { type: 'jsx_element', name, attributes, children };
}
export function  JSXFragment<T>(children: Expr<T>[]): JSXElement<T> {
	return { type: 'jsx_element', children, attributes: [] };
}

export type Expr<T> = JS.Expr<T> | JSXElement<T>;

// ===================================================================
//  terminals
// ===================================================================

// `jsx_element_or_fragment` is reachable both as a nested child (via `jsx_child`) and as a bare top-level
// expression (pushed onto `member_expression`), so its own completion states end up shared between the two
// call sites -- and LALR's reduce lookaheads are computed *per state*, not per call site, so a lookahead
// that's only meaningful for the nested-child case (e.g. more `jsx-text`/another tag can follow a child)
// leaks into the top-level one too (where, say, only `;` can really follow). That leaked terminal must never
// *win* a same-length tokenizing tie against whatever's actually correct there (`const el = <Foo/>;` broke
// exactly this way -- `;` and a leaked `jsx-text` both matched the trailing `;`, and `jsx-text` won the tie).
// `loseTies` prefixes an optional literal NUL (not a space -- a space is real, legitimate input, e.g. the
// one in `attr = "x"`, and an optional-but-real leading character would get swallowed into the very token
// this is trying to protect): a NUL never appears in real source, so it changes nothing about what a pattern
// can actually match, but its codepoint sorts below every ordinary character, which is exactly what the
// tokenizer's own same-length tie-break compares (`pattern.source` order) -- so a leaked terminal can now only
// win by being strictly *longer* than the alternative, never by sort order.
function loseTies(re: RegExp): RegExp {
	return new RegExp('\u0000?' + re.source, re.flags);
}

// A hyphenated JSX name (`data-foo`/`aria-label`/`my-element`) -- unlike a plain JS identifier, which can't
// contain a `-` at all. Requires *at least one* hyphen (rather than allowing zero, which is what real JSX
// itself does) so this terminal never matches anything js-parser.ts's own `IDENT` could also match: with
// ts-parser.ts loaded, a generic arrow function (`<T>(x: T) => x`) is reachable from the very same
// expression-start position as a JSX element, and if both a hyphen-less `jsx-name` and `IDENT` could match
// the same plain identifier there, one has to silently win a lexer tie -- but this is a genuine grammar
// ambiguity (only later tokens tell them apart), not a lexer one, so it needs GLR to explore both, which
// requires both sides to shift the *same* token. `jsx_name_token` below is JSX's own actual name production;
// it takes the hyphen-less case from plain `IDENT` instead, so a bare `<div` shifts identically either way.
const JSX_NAME = terminal('jsx-name', loseTies(/[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*-[$\u200C\u200D\p{ID_Continue}-]*/u));

// The name production every JSX name/attribute-name position actually uses -- see `JSX_NAME`'s own comment
// above. `ForceFork` on the `IDENT` alternative: with ts-parser.ts loaded, a bare `<identifier` is genuinely
// ambiguous one token past LALR(1) between starting a JSX element and starting a generic arrow function's
// `<T>` type-parameter list (both reduce the same shifted `IDENT` here, to a `type_parameter` or a JSX name
// respectively) -- resolved only by what comes *after* (`>(` for the generic arrow vs anything else for JSX),
// so GLR needs to explore both instead of committing to whichever reduce happens to run first.
const jsx_name_token = Rules<string>(
	ForceFork(Rule([IDENT])),
	Rule([JSX_NAME]),
);

// Real JSX attribute string values don't process backslash escapes at all -- only the matching quote terminates them.
const JSX_STR = terminal('jsx-string', loseTies(/"[^"]*"|'[^']*'/));

// Stops at `<`/`{`/`}`, the only structurally significant characters inside JSX children; a bare `>` is left
// legal inside text, matching real-world (Babel) leniency over the spec.
const JSX_TEXT = terminal('jsx-text', loseTies(/[^<{}]+/));

// ===================================================================
//  Grammar
// ===================================================================

const jsx_namespaced_name = Rules<string>(
	Rule([jsx_name_token, ':', jsx_name_token],	$ => $[0] + ':' + $[2]),
);

// Element/component names can be dotted (`<Foo.Bar/>`, a member access on some outer binding) but never
// namespaced; namespaced names (`<svg:rect/>`) can never be dotted -- the two forms are mutually exclusive in
// the real spec, so they're kept as separate rules rather than one combined production. Shaped just like
// ts-parser.ts's own `dotted_path` (self-recursive concatenation into one flat string).
const jsx_member_name = Rules<string>(self => [
	jsx_name_token,
	Rule([self, '.', jsx_name_token],	$ => $[0] + '.' + $[2]),
]);

const jsx_element_name = Rules(
	jsx_namespaced_name,
	jsx_member_name,
);

const jsx_attribute_name = Rules<string>(
	jsx_name_token,
	jsx_namespaced_name,
);

// Reuses js-parser.ts's own `assignment_expression` array directly (not a copy) -- if ts-parser.ts is also
// loaded, its own pushes onto that same array (`as`/`satisfies`/generic instantiation, etc.) apply here too.
const assignment_expression = JS.assignment_expression as Rules<Expr<any>>;
const fwd_jsx_element = Forward<JSXElement<any>>(() => jsx_element);

const jsx_attribute_value = Rules<Expr<any>>(
	Rule([JSX_STR],							$ => Literal($[0].slice(1, -1))),
	Rule(['{', assignment_expression, '}'],	$ => $[1]),
	fwd_jsx_element,
);

const jsx_attribute = Rules<JSXAttribute<any>>(
	Rule([jsx_attribute_name],								$ => JSXAttribute($[0])),
	Rule([jsx_attribute_name, '=', jsx_attribute_value],	$ => JSXAttribute($[0], $[2])),
	Rule(['{', '...', assignment_expression, '}'],			$ => JSXSpreadAttribute($[2])),
);
const jsx_attributes = MaybeList(jsx_attribute);

const jsx_child = Rules<Expr<any>>(
	Rule([JSX_TEXT],						$ => Literal($[0])),
	Rule(['{', '}'],						_ => Literal(null)),
	Rule(['{', assignment_expression, '}'],	$ => $[1]),
	fwd_jsx_element,
);

// `jsx_element` is reachable from three call sites:
// 		- as a nested child (via `jsx_child`),
// 		- as an attribute value (via `jsx_attribute_value`),
//  	- as a bare top-level expression (pushed directly onto js-parser.ts's `member_expression`).
// LALR computes reduce lookaheads *per automaton state*, not per call site, and since all three call sites reduce through the exact same rule objects, their
// completion states end up shared -- so a lookahead that's only meaningful for the nested-child call site (e.g. more text, or another tag, can follow a child)
// leaks into the top-level call site too, where nothing JSX-flavored can legitimately follow at all.

function makeElement<T>(jsx_child: Rules<Expr<T>>) {
	const opening_element = Rules(
		Rule(['<', jsx_element_name, jsx_attributes, '>'],		$ => ({ name: $[1], attributes: $[2] } as const)),
	);
	const closing_element = Rules(
		Rule(['<', '/', jsx_element_name, '>'],					$ => $[2]),
	);
	const children = Rules<Expr<T>[]>(self => [
		ForceFork(Rule([], 										_ => [])),
		Rule([jsx_child],										$ => [$[0]]),
		Rule([self, jsx_child],									$ => [...$[0], $[1]]),
	]);
	return Rules<JSXElement<T>>(
		Rule(['<', jsx_element_name, jsx_attributes, '/', '>'],	$ => JSXElement($[1], $[2], [])),
		Rule(['<', '>', children, '<', '/', '>'],				$ => JSXFragment($[2])),
		Rule([opening_element, children, closing_element],		$ => JSXElement($[0].name, $[0].attributes, $[1])),
	);
}

// The nested/attribute-value copy -- `jsx_child` (and through it, `jsx_attribute_value`) recurses into this
// one's `jsx_element_or_fragment` via `Forward`, since it's declared (right above) before this call.
const jsx_element = makeElement(jsx_child);

// ===================================================================
//  Wire it up
// ===================================================================

// A fresh, separate copy so the top-level call site's completion states don't inherit the nested one's JSX-flavored follow-lookaheads.
// Its own nested children still recurse through the *shared* `jsx_child`/`nested` copy above -- only the outermost element/fragment differs.
const jsx_toplevel_element = makeElement(jsx_child);

export function add() {
	if (!JS.member_expression.includes(jsx_toplevel_element as Rules<any>)) {
		JS.member_expression.push(jsx_toplevel_element as Rules<any>);
		JS.member_expression_nobrace.push(jsx_toplevel_element as Rules<any>);
	}
}

function arrayRemove<T>(arr: T[], item: T) {
	for (let i = 0; i < arr.length; i++) {
		if (arr[i] === item) {
			arr.splice(i, 1);
			break;
		}
	}
	return arr;
}
export function remove() {
	arrayRemove(JS.member_expression, jsx_toplevel_element as Rules<any>);
	arrayRemove(JS.member_expression_nobrace, jsx_toplevel_element as Rules<any>);
}
/*
JS.member_expression.push(jsx_toplevel_element as Rules<any>);
JS.member_expression_nobrace.push(jsx_toplevel_element as Rules<any>);

export const parser = makeParser({
	skip:		JS.skip,
	recover:	JS.recover,
	merge:		JS.merge,
	start:		JS.program,
	// these are only needed for debugging
	rules: {
		...JS.rules,
		jsx_element_name,
		jsx_attribute_name,
		jsx_attribute_value,
		jsx_attribute,
		jsx_attributes,
		jsx_child,
		jsx_element,
		jsx_toplevel_element,
	}
});

export const parse = (input: string) => parser.parse(input) as JS.Program<unknown>;
*/