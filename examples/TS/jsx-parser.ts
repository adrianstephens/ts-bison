import { Rules, Forward, MaybeList, terminal, ForceFork } from '../../src/tison';
import * as JS from './js-parser';
import { Literal, Identifier } from '../common';
import { CompilerOptions1 } from './transform';
import { walk } from './walker';

const Rule = JS.Rule;
const IDENT = JS.IDENT;
// ===================================================================
//  JSX Parser -- an extension of js-parser, composable with ts-parser
// ===================================================================
//
// Never imports ts-parser.ts -- it only pushes onto js-parser.ts's own shared `member_expression`/
// `member_expression_nobrace` arrays, which ts-parser.ts reuses rather than copies. So importing both this
// file and ts-parser.ts gives full TSX support via `TS.parse`; this file's own `parse` is plain JSX-in-JS only.
//
// Known simplifications:
//   - No generic-component type args (`<Foo<T> />`) -- unimplemented (no ambiguity to resolve since
//     ts-parser.ts has no `<Type>expr` cast syntax either).
//   - Closing tag name isn't checked against the opening tag's (a semantic, not syntax, concern).
//   - JSX attribute strings don't process backslash escapes, matching the real spec (`JSX_STR` terminal,
//     not js-parser.ts's `STR`).
//   - Whitespace-only text between tags is discarded via `WS` skip rather than kept as `jsx_text` -- drops
//     real JSX's preservation of a single inter-tag space with no newline.

// ===================================================================
//  AST
// ===================================================================

export interface Attribute<T>	{ name?: string; value?: Expr<T> }
export function  Attribute<T>(name: string, value?: Expr<T>): Attribute<T>	{ return { name, value }; }
export function  SpreadAttribute<T>(value?: Expr<T>): Attribute<T>			{ return { value }; }

export interface Element<T>		{ type: 'jsx'; name: string; attributes: Attribute<T>[]; children: Expr<T>[] }
export function  Element<T>(name: string, attributes: Attribute<T>[], children: Expr<T>[]): Element<T> {
	return { type: 'jsx', name, attributes, children };
}

export type Expr<T = any> = JS.Expr<T> | Element<T>;

// ===================================================================
//  terminals
// ===================================================================

// Prefixes an optional NUL (never real input, sorts lowest) so a leaked-lookahead terminal (see `jsx` below)
// can only win a same-length tokenizing tie by matching strictly longer, never by sort order.
function loseTies(re: RegExp): RegExp {
	return new RegExp('\u0000?' + re.source, re.flags);
}

// Requires >=1 hyphen (real JSX allows zero) so it never collides with `IDENT` -- the hyphen-less case is
// handled by `jsx_name_token`'s own `IDENT` alternative below, letting GLR fork on one shared token instead of a lexer tie.
const JSX_NAME = terminal('jsx-name', loseTies(/[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*-[$\u200C\u200D\p{ID_Continue}-]*/u));

// `ForceFork` on `IDENT`: with ts-parser.ts loaded, `<identifier` is ambiguous past LALR(1) between a JSX
// element and a generic arrow's `<T>` list -- resolved only by what follows (`>(` vs anything else), so GLR must explore both.
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

// Dotted (`<Foo.Bar/>`) and namespaced (`<svg:rect/>`) names are mutually exclusive in the real spec, so
// they're kept as separate rules; shaped like ts-parser.ts's own `dotted_path` (self-recursive concatenation into one flat string).
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
const fwd_jsx_element = Forward<Element<any>>(() => jsx);

const jsx_attribute_value = Rules<Expr<any>>(
	Rule([JSX_STR],							$ => Literal($[0].slice(1, -1))),
	Rule(['{', assignment_expression, '}'],	$ => $[1]),
	fwd_jsx_element,
);

const jsx_attribute = Rules<Attribute<any>>(
	Rule([jsx_attribute_name],								$ => Attribute($[0])),
	Rule([jsx_attribute_name, '=', jsx_attribute_value],	$ => Attribute($[0], $[2])),
	Rule(['{', '...', assignment_expression, '}'],			$ => SpreadAttribute($[2])),
);
const jsx_attributes = MaybeList(jsx_attribute);

const jsx_child = Rules<Expr<any>>(
	Rule([JSX_TEXT],						$ => Literal($[0])),
	Rule(['{', '}'],						_ => Literal(null)),
	Rule(['{', assignment_expression, '}'],	$ => $[1]),
	fwd_jsx_element,
);

// `jsx` is reachable as a nested child, an attribute value, and a bare top-level expression; LALR computes
// lookaheads per automaton state, not per call site, so nested-child-only lookaheads leak into the top-level completion state too.

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
	return Rules<Element<T>>(
		Rule(['<', jsx_element_name, jsx_attributes, '/', '>'],	$ => Element($[1], $[2], [])),
		Rule(['<', '>', children, '<', '/', '>'],				$ => Element('Fragment', [], $[2])),
		Rule([opening_element, children, closing_element],		$ => Element($[0].name, $[0].attributes, $[1])),
	);
}

// The nested/attribute-value copy -- `jsx_child` (and through it, `jsx_attribute_value`) recurses back into
// this `jsx` via `Forward`, since it's declared before this call.
const jsx = makeElement(jsx_child);

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

//-----------------------------------------------------------------------------
// JSX lowering
//-----------------------------------------------------------------------------

// Lowercase/namespaced (`svg:rect`) names are host elements -> string tag (real JSX rule); anything else is a component reference, evaluated as an expression.
function elementName(name: string): JS.Expr {
	return name.includes(':') || /^[a-z]/.test(name)
		? Literal(name)
		: JS.dottedNameToExpr(name);
}

function attrToFields(attr: Attribute<any>[]) {
	return attr.map(a =>
		a.name === undefined ? JS.Spread(a.value! as JS.Expr) : JS.Field(a.name, a.value as JS.Expr ?? Literal(true))
	);
}

// Lowers JSX to the same calls real tsc's transform emits -- `jsx`/`jsxs` (automatic) or `factory` (classic) --
// and, for automatic, prepends the implicit `jsx-runtime` import tsc synthesizes per file.
export function lower(program: JS.Program, options: CompilerOptions1) {
	const lower: ((jsx: Element<any>)=>JS.Expr) | undefined = 
		options.jsx === 'react-jsx' || options.jsx === 'react-jsxdev' ? jsx => {
			const props = attrToFields(jsx.attributes);
			const func	= jsx.children.length > 1 ? 'jsxs' : 'jsx';
			used[func] = true;
			if (jsx.name === 'Fragment')
				used.Fragment = true;
			return JS.Call(Identifier(func), [
				elementName(jsx.name),
				JS.ObjectExpr([
					...props, JS.Field('children', jsx.children.length === 1
						? jsx.children[0] as JS.Expr
						: JS.ArrayLit(jsx.children as JS.Expr[])
					)
				])
			]);
		} : options.jsx === 'react' ? jsx => {
			const props = attrToFields(jsx.attributes);
			return JS.Call(Identifier(options.jsxFactory), [
				jsx.name === 'Fragment' ? Identifier(options.jsxFragmentFactory) : elementName(jsx.name),
				props.length ? JS.ObjectExpr(props) : Literal(null),
				...jsx.children as JS.Expr[],
			]);
		} :	undefined;

	if (!lower)
		return program;

	const used: Record<string, boolean> = {};

	const lowered = walk(program, undefined, (expr, process) =>
		expr.type === 'jsx' ? lower(process(expr)) : process(expr)
	)!;

	const usedkeys = Object.keys(used);
	if (usedkeys.length) {
		lowered.body = [
			{
				type:		'import',
				specifiers:	usedkeys.map(name => ({ imported: name, local: name })),
				source:		options.jsxImportSource + '/jsx-runtime',
			},
			...lowered.body,
		];
	}
	return lowered;
}
