/* eslint-disable @typescript-eslint/no-this-alias */
import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Expr, BindingTarget } from './js-parser';
import { Type } from './ts-parser';
import { TSwalk, mapObjectVoid, hasMod } from './walker';

// ===================================================================
//  Type utilities
// ===================================================================

const PRIMITIVES	= new Set(['any', 'unknown', 'never', 'void', 'number', 'string', 'boolean', 'bigint', 'symbol', 'object', 'undefined', 'null']);
const SINGLE_ELEMENT_ITERABLES = new Set(['Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Generator', 'Iterable', 'IterableIterator', 'Iterator']);
const OPAQUE		= new Set(['keyof', 'indexed_access', 'conditional', 'infer', 'mapped', 'this', 'predicate']);
// The subset of `OPAQUE` that's a genuinely unevaluated computation, as opposed to `this`/`predicate` (opaque by design, not a gap).
// In `strict` mode below, either side being one of these fails the comparison instead of auto-passing it.
const OPAQUE_GAP	= new Set(['keyof', 'indexed_access', 'conditional', 'infer', 'mapped']);

// Per-function counts of how many times a structural recursion's own depth budget (`resolve`/`lookupMember`/`isAssignable`/...,
// each independently bounded against genuine cycles -- self-referential types, mutually-recursive aliases) was actually
// exhausted, as opposed to just defensively present. None of these recursions carry a source position to report a real
// per-occurrence diagnostic against (they're structural `Type`-to-`Type` operations, not tied to a specific AST node) --
// `takeDepthExhaustion` reads and clears the tally so a caller (`TStypeCheckAsync`) can fold it into one summary GAP
// diagnostic per check instead.
const depthExhaustion = new Map<string, number>();

function hitDepthLimit(fn: string): void {
	depthExhaustion.set(fn, (depthExhaustion.get(fn) ?? 0) + 1);
}

export function takeDepthExhaustion(): Map<string, number> {
	try {
		return new Map(depthExhaustion);
	} finally {
		depthExhaustion.clear();
	}
}

export const NUMBER		= TS.RefType('number');
export const STRING		= TS.RefType('string');
export const BOOLEAN	= TS.RefType('boolean');
export const BIGINT		= TS.RefType('bigint');
export const REGEXP		= TS.RefType('RegExp');
export const ANY		= TS.RefType('any');
export const VOID		= TS.RefType('void');
export const UNDEFINED	= TS.RefType('undefined');
export const NEVER		= TS.RefType('never');
export const UNKNOWN	= TS.RefType('unknown');
export const NUMERIC	= TS.UnionType([NUMBER, BIGINT]);

export function withScope(sig: TS.CallSig, scope: Scope): TS.CallSig {
	sig.declScope = scope;
	return sig;
}

export function bindingNames(t: BindingTarget): string[] {
	return typeof t === 'string' ? [t]
		: t.type === 'object_pattern' ? [...t.properties.flatMap(p => bindingNames(p.value)), ...(t.rest ? [t.rest] : [])]
		: [...t.elements.flatMap(e => e ? bindingNames(e.target) : []), ...(t.rest ? [t.rest] : [])];
}

export function typeKey(t: Type) {
	return JSON.stringify(t, (k, v) => k === 'pos' || k === 'declScope' ? undefined : v);
}


// De-dupes structurally-identical types (by JSON shape) and folds what's left into a `union`
export function combineTypes(types: Type[]): Type {
	const seen = new Set<string>();
	const unique: Type[] = [];
	const add = (t: Type) => {
		if (t.type === 'union') {
			t.types.forEach(add);
		} else {
			const key = typeKey(t);
			if (!seen.has(key)) {
				seen.add(key);
				unique.push(t);
			}
		}
	};
	types.forEach(add);
	return unique.length === 1 ? unique[0] : TS.UnionType(unique);
}

export function intersectTypes(types: Type[]): Type {
	const seen = new Set<string>();
	const unique: Type[] = [];
	const add = (t: Type) => {
		if (t.type === 'intersection') {
			t.types.forEach(add);
		} else {
			const key = typeKey(t);
			if (!seen.has(key)) {
				seen.add(key);
				unique.push(t);
			}
		}
	};
	types.forEach(add);
	return unique.length === 1 ? unique[0] : TS.IntersectionType(unique);
}


export function flattenIntersection(t: Type, scope: Scope): Type[] {
	const r = resolveOwn(t, scope);
	return r.type === 'intersection' ? r.types.flatMap(t => flattenIntersection(t, scope)) : [r];
}

export function collectMembers(t: Type, scope: Scope): TS.TypeMember[] {
	const r = resolveOwn(t, scope);
	return r.type === 'object' ? r.members : r.type === 'intersection' ? r.types.flatMap(t => collectMembers(t, scope)) : [];
}

export function makeNullish(type: Type) {
	if (type.type === 'ref') {
		switch (type.name) {
			case 'bigint':
			case 'number':	return JS.Literal(0);
			case 'boolean':	return JS.Literal(false);
			case 'string':	return JS.Literal('');
		}
	}
	return type;
}

// A `ref`'s own `declScope` (see `stampScope`), when stamped, wins over `scope` -- same reasoning as `lookupMember`'s
// identical check: a value reached through a cross-module union member (e.g. one of `Expr`'s own variants, declared in
// a different file than whatever's asking) carries its declaring scope on the ref itself, since the *ambient* `scope`
// here may never have had that name in scope at all -- `scope.resolve` alone would just silently fail to expand it.

export function ownScope(t: Type, scope: Scope) {
	return t.type === 'ref' && t.declScope ? (t.declScope as Scope) : scope;
}
export function resolveOwn(t: Type, scope: Scope): Type {
	return ownScope(t, scope).resolve(t);
}

export function isNullish(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return	r.type === 'literal'	? r.value === null
		:	r.type === 'ref'		? r.name === 'undefined' || r.name === 'null' || r.name === 'void'
		:	r.type === 'union'		? r.types.every(t => isNullish(t, scope))
		:	false;
}

export function isFalsy(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return	r.type === 'literal'	? !r.value
		:	r.type === 'ref'		? r.name === 'undefined' || r.name === 'null' || r.name === 'void'
		:	r.type === 'union'		? r.types.every(t => isFalsy(t, scope))
		:	false;
}

export function isTruthy(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return	r.type === 'literal'		? !!r.value
		:	r.type === 'union'			? r.types.every(m => isTruthy(m, scope))
		:	r.type === 'intersection'	? r.types.some(m => isTruthy(m, scope))
		:	['object', 'array', 'tuple', 'function', 'constructor'].includes(r.type);
}

export function isOther(op: string) {
	return op === '?' ? isNullish : op === '|' ? isFalsy : isTruthy;
}

export function isAny(t: Type)		{ return t.type === 'ref' && (t.name === 'any' || t.name === 'unknown'); }
export function isBoolean(t: Type)	{ return t.type === 'ref' && t.name === 'boolean'; }
export function isString(t: Type)	{ return t.type === 'ref' && t.name === 'string'; }
export function isKeyable(t: Type)	{ return t.type === 'ref' && (t.name === 'string' || t.name === 'number' || t.name === 'symbol'); }
export function isLiteral(t: Type, type: string)	{ return t.type === 'literal' && typeof t.value === type; }

/*
export function isType(t: Type, name: string, scope: Scope): boolean {
	const r = scope.resolve(t);
	return r.type === 'ref'		? r.name === name
		: r.type === 'literal'	? typeof r.value === name
		: r.type === 'union'	? r.types.every(m => isType(m, name, scope))
		: false;
}
*/

export function isBigint(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return r.type === 'ref'		? r.name === 'bigint'
		: r.type === 'literal'	? typeof r.value === 'bigint'
		: r.type === 'union'	? r.types.every(m => isBigint(m, scope))
		: false;
};

// Inferred unions over-approximate, so only complain when no member could be numeric
export function isNumberLike(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return r.type === 'union' ? r.types.some(m => isAssignable(m, NUMERIC, scope)) : isAssignable(r, NUMERIC, scope);
}

export function isStringLike(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return r.type === 'template_literal'
		|| isString(t)
		|| isLiteral(t, 'string')
		|| (r.type === 'union' && r.types.some(t => isStringLike(t, scope)));
}

export function widenLiterals(t: Type, keepBoolean = false): Type {
	return	t.type === 'literal' && t.value !== null && (!keepBoolean || typeof t.value !== 'boolean') ? TS.RefType(typeof t.value)
		:	t.type === 'union' ? combineTypes(t.types.map(m => widenLiterals(m, keepBoolean)))
		:	t;
}

// Replaces type-parameter references with their instantiating arguments (`Foo<string>` -> Foo's body with T := string)
export function substituteType(t: Type, map: Map<string, Type>): Type {
	return TSwalk(t, undefined, undefined, (x, process) =>
		x.type === 'ref' && !x.typeArgs && map.has(x.name) ? map.get(x.name) : process(x)
	) ?? t;
}

// `keyof`'s member-name collection: an object's own property/method names, an intersection's union of its parts', a union's *intersection* of its
// parts' (matching real TS). Anything else (array/tuple numeric keys, an unresolved ref) isn't modeled -- `undefined` keeps `keyof` opaque.
function objectKeyNames(t: Type, scope: Scope, depth: number): string[] | undefined {
	if (depth >= 0) {
		if (t.type === 'object')
			return t.members.map(m => (m.kind === 'property' || m.kind === 'method') && typeof m.name === 'string' ? m.name : undefined).filter(m => m !== undefined);
		if (t.type === 'intersection' || t.type === 'union') {
			const parts = t.types.map(p => objectKeyNames(scope.resolve(p, depth - 1), scope, depth - 1));
			if (parts.every(p => !!p))
				return t.type === 'intersection' ? [...new Set(parts.flat())] : parts[0].filter(k => parts.every(p => p.includes(k)));
		}
	}
	return undefined;
}

// Whether `name` occurs somewhere `inferTypeArgs` would actually have descended into -- used below to tell "no argument could ever
// have determined this" (tsc also falls back silently, no diagnostic) apart from "an argument that should have pinned it down
// didn't" (a real gap in our own inference). Deliberately mirrors `inferTypeArgs`'s own recursion shape rather than a blanket
// "appears anywhere" walk: a mention reachable only through a position `inferTypeArgs` never structurally inverts (`keyof O`'s `O`
// from a plain `string` argument, an indexed-access's index, a mapped type's constraint, a conditional's check/extends) could never
// actually be inferred -- by us or by real tsc -- so flagging those as a GAP would be a false alarm, not a real one.
export function mentionsTypeParam(t: Type, name: string): boolean {
	switch (t.type) {
		case 'ref':				return t.typeArgs ? t.typeArgs.some(a => mentionsTypeParam(a, name)) : t.name === name;
		case 'array':			return mentionsTypeParam(t.element, name);
		case 'tuple':			return t.elements.some(e => { const el = tupleElementType(e); return !!el && mentionsTypeParam(el, name); });
		case 'intersection':
		case 'union':			return t.types.some(x => mentionsTypeParam(x, name));
		case 'conditional':		return mentionsTypeParam(t.trueType, name) || mentionsTypeParam(t.falseType, name);
		case 'function':
		case 'constructor':		return t.params.some(p => p.typeAnnotation && mentionsTypeParam(p.typeAnnotation as Type, name)) || (!!t.returnType && mentionsTypeParam(t.returnType, name));
		case 'object':			return t.members.some(m => (m.kind === 'property' && mentionsTypeParam(m.typeAnnotation, name)) || (m.kind === 'method' && !!m.returnType && mentionsTypeParam(m.returnType, name)));
		case 'predicate':		return !!t.assertedType && mentionsTypeParam(t.assertedType, name);
		case 'parenthesized':	return mentionsTypeParam(t.inner, name);
		case 'readonly':		return mentionsTypeParam(t.argument, name);
		// `keyof`/`indexed_access`/`mapped`/`typeof`/`this`/`template_literal`/`infer`: not positions `inferTypeArgs` inverts.
		default:				return false;
	}
}

// Depth-first existence check over every position a `Type` can nest another `Type` -- a real short-circuit (stops the whole
// walk, not just further matching, on the first hit), and no CPS/mapper indirection to route through since this never
// transforms anything. Mirrors `TSwalk`'s own `_Type`/`_TypeMember` field lists for parity, but as a plain recursive
// predicate -- `TSwalk` itself is built around the mutate/rebuild case (`stampScope`/`substituteType`), which existence
// checks don't need.
export function typeSome(t: Type, match: (x: Type) => boolean): boolean {
	if (match(t))
		return true;
	const some = (x: Type | undefined): boolean => !!x && typeSome(x, match);
	const someSig = (sig: TS.CallSig): boolean =>
		sig.params.some(p => some(p.typeAnnotation as Type)) || some(sig.rest?.typeAnnotation as Type) || some(sig.returnType)
		|| !!sig.typeParams?.some(p => some(p.constraint) || some(p.default));
	switch (t.type) {
		case 'ref':
		case 'typeof':
		case 'import':				return !!t.typeArgs?.some(some);
		case 'template_literal':	return t.parts.some(p => some(p.exp));
		case 'array':				return some(t.element);
		case 'tuple':				return t.elements.some(e => some(tupleElementType(e)));
		case 'union':
		case 'intersection':		return t.types.some(some);
		case 'function':
		case 'constructor':		return someSig(t);
		case 'object':				return t.members.some(m =>
			m.kind === 'property' ? some(m.typeAnnotation)
			: m.kind === 'index' ? some(m.paramType) || some(m.typeAnnotation)
			: someSig(m));
		case 'parenthesized':		return some(t.inner);
		case 'keyof':
		case 'readonly':			return some(t.argument);
		case 'indexed_access':		return some(t.object) || some(t.index);
		case 'conditional':			return some(t.checkType) || some(t.extendsType) || some(t.trueType) || some(t.falseType);
		case 'infer':				return some(t.constraint);
		case 'mapped':				return some(t.constraint) || some(t.nameType) || some(t.valueType);
		case 'predicate':			return some(t.assertedType);
		// 'literal'/'this': no nested Type position.
		default:					return false;
	}
}

// Whether a conditional's `extendsType` binds an `infer` anywhere.
function containsInfer(t: Type): boolean {
	return typeSome(t, x => x.type === 'infer');
}

// Structurally matches `pattern` (a conditional's `extendsType`, containing `infer` nodes) against `actual` (the resolved check type),
// binding each `infer X` into `out`. Three-valued like `conditionalExtends`: `false` only once shapes are known to conflict outright, `undefined`
// when there's not enough information either way (an unresolved ref, an unhandled node shape) -- both leave the conditional opaque, not guessed.
// Subtrees with no `infer` inside them bottom out into ordinary `isAssignable`, so this only needs its own case for the handful of node kinds
// (ref/array/tuple/function/object/union) that can actually carry `infer` somewhere beneath them.
function matchInfer(pattern: Type, actual: Type, scope: Scope, out: Map<string, Type>, depth = 6): boolean | undefined {
	if (depth < 0) {
		hitDepthLimit('matchInfer');
		return undefined;
	}
	if (pattern.type === 'parenthesized')
		return matchInfer(pattern.inner, actual, scope, out, depth - 1);
	if (pattern.type === 'readonly')
		return matchInfer(pattern.argument, actual, scope, out, depth - 1);
	if (pattern.type === 'infer') {
		if (!out.has(pattern.name))
			out.set(pattern.name, actual);
		return !pattern.constraint || isAssignable(actual, pattern.constraint, scope);
	}
	if (!containsInfer(pattern))
		return isAssignable(actual, pattern, scope);

	const a = scope.resolve(actual, depth - 1);
	if (pattern.type === 'ref' && pattern.typeArgs) {
		// Check the *unresolved* `actual` for a same-named ref first -- `scope.resolve` would eagerly expand a real named
		// type (e.g. lib.d.ts's `Promise<T>`) into its full structural body, losing the "named `Promise<number>`" identity
		// this needs; only fall back to the resolved form (`a`) for the case where `actual` itself was an alias needing one unwrap.
		const named = actual.type === 'ref' && actual.typeArgs && actual.name === pattern.name ? actual
			: a.type === 'ref' && a.typeArgs && a.name === pattern.name ? a
			: undefined;
		if (!named)
			return undefined;	// unresolved/differently-named: not confidently "doesn't extend" either
		return pattern.typeArgs.length === named.typeArgs!.length
			&& pattern.typeArgs.every((p, i) => matchInfer(p, named.typeArgs![i], scope, out, depth - 1) !== false)
			|| undefined;
	}
	if (pattern.type === 'array')
		return a.type === 'array' ? matchInfer(pattern.element, a.element, scope, out, depth - 1)
			: a.type === 'tuple' ? a.elements.every(e => { const t = tupleElementType(e); return t && matchInfer(pattern.element, t, scope, out, depth - 1) !== false; }) || undefined
			: false;
	if (pattern.type === 'tuple') {
		if (a.type !== 'tuple')
			return undefined;
		// A trailing `...infer Rest` (or `...unknown[]`) only has to line up against whatever's left after the fixed leading elements match --
		// unlike the fixed-length case below, `a` may have *more* elements than `pattern`'s leading portion.
		const last = pattern.elements.at(-1);
		if (last?.type === 'spread') {
			const lead = pattern.elements.slice(0, -1);
			if (a.elements.length < lead.length)
				return false;
			if (!lead.every((p, i) => { const at = tupleElementType(a.elements[i]), pt = tupleElementType(p); return !at || !pt || matchInfer(pt, at, scope, out, depth - 1) !== false; }))
				return false;
			if (!containsInfer(last.argument))
				return true;
			const rest = a.elements.slice(lead.length).map(tupleElementType);
			return rest.every((t): t is Type => !!t) && matchInfer(last.argument, TS.ArrayType(combineTypes(rest)), scope, out, depth - 1) !== false || undefined;
		}
		return a.elements.length === pattern.elements.length
			&& a.elements.every((e, i) => { const at = tupleElementType(e), pt = tupleElementType(pattern.elements[i]); return !at || !pt || matchInfer(pt, at, scope, out, depth - 1) !== false; })
			|| undefined;
	}
	if (pattern.type === 'function' || pattern.type === 'constructor')
		return a.type !== pattern.type ? false
			: pattern.returnType && a.returnType ? matchInfer(pattern.returnType, a.returnType, scope, out, depth - 1)
			: undefined;
	if (pattern.type === 'union') {
		// non-distributive: `infer` inside a pattern-side union is rare and real TS's handling here is itself subtle -- best-effort only.
		for (const p of pattern.types) {
			if (matchInfer(p, actual, scope, out, depth - 1))
				return true;
		}
		return undefined;
	}
	if (pattern.type === 'object') {
		if (a.type !== 'object' && a.type !== 'intersection')
			return undefined;
		for (const m of pattern.members) {
			if (m.kind !== 'property' || typeof m.name !== 'string' || !containsInfer(m.typeAnnotation))
				continue;
			// `lookupMember` gets its own fresh budget, not `matchInfer`'s remaining `depth` -- its own nominal-unfolding
			// budget is unrelated to how deep this structural pattern-match already is (same reasoning as `lookupMember`'s
			// own `resolve()` call, and `isAssignable`'s per-member `lookupMember` call).
			const t = lookupMember(a, m.name, scope);
			if (!t)
				return m.optional ? undefined : false;
			if (matchInfer(m.typeAnnotation, t, scope, out, depth - 1) === false)
				return false;
		}
		return true;
	}
	return undefined;
}

// Three-valued: `undefined` is "couldn't fully resolve this" (e.g. an alias not reachable through this `scope`'s import chain) and must not be
// treated as a confirmed `false`, or `conditionalExtends` below would wrongly fall through to the leniency it exists to guard against.
function isLiteralOnly(t: Type, scope: Scope, depth = 6): boolean | undefined {
	if (depth < 0) {
		hitDepthLimit('isLiteralOnly');
		return undefined;
	}
	if (t.type === 'literal')
		return true;
	if (t.type === 'union') {
		const parts = t.types.map(m => isLiteralOnly(resolveOwn(m, scope), scope, depth - 1));
		return parts.some(p => p === false) ? false : parts.every(p => p === true) ? true : undefined;
	}
	return t.type === 'ref' && !PRIMITIVES.has(t.name) ? undefined : false;
}

// Stricter than `isAssignable`: real TS's `extends` says a bare `number` does NOT extend a narrower literal union, unlike ordinary assignability.
// `undefined` propagates `isLiteralOnly`'s "can't safely decide" -- caller must stay opaque, not guess.
function conditionalExtends(check: Type, extendsType: Type, scope: Scope): boolean | undefined {
	if (check.type === 'ref' && PRIMITIVES.has(check.name) && !isAny(check)) {
		const lit = isLiteralOnly(extendsType, scope);
		if (lit !== false)
			return lit === true ? false : undefined;
	}
	return isAssignable(check, extendsType, scope);
}

// An unannotated binding takes its type from a literal initializer (`x = 0n` -> bigint)
export function literalTypeOf(e: Expr | undefined): Type | undefined {
	return e?.type === 'literal' && e.value !== null ? TS.RefType(typeof e.value)
		: undefined;
}

// What `typeof` would report for a value of this type, or undefined when it can't be known statically
export const typeofName = (t: Type): string | undefined => {
	switch (t.type) {
		case 'literal':				return t.value === null ? 'object' : typeof t.value;
		case 'template_literal':	return 'string';
		case 'function':
		case 'constructor':			return 'function';
		case 'array':
		case 'tuple':
		case 'object':				return 'object';
		case 'intersection':		return t.types.some(p => p.type === 'function' || p.type === 'constructor') ? 'function' : 'object';
		case 'ref':
			return ['number', 'string', 'boolean', 'bigint', 'symbol', 'undefined'].includes(t.name) ? t.name
				: t.name === 'null' ? 'object'
				: undefined;
		default:					return undefined;
	}
};


// A spread (`...T`) contributes no single element value; an optional element (`T?`)'s contributed value type is just `T`, consistent with this
// file not modeling "possibly absent" via `| undefined` for optional members elsewhere either.
export function tupleElementType(te: TS.TupleElement): Type | undefined {
	return te.type === 'spread' ? undefined : te.type === 'optional' || te.type === 'labeled' ? te.element : te;
}

// `yield* x`'s delegated element type -- covers the common iterable shapes (arrays/tuples, `Set`, generators); anything
// else (a custom `[Symbol.iterator]`-implementing class) is opaque here, same lenient "unmodeled" fallback as elsewhere.
export function iterableElementType(t: Type, scope: Scope): Type {
	const r = resolveOwn(t, scope);
	if (r.type === 'array')
		return r.element;
	if (r.type === 'tuple')
		return combineTypes(r.elements.map(e => tupleElementType(e)).filter((e): e is Type => !!e));
	if (r.type === 'ref' && r.typeArgs?.length && SINGLE_ELEMENT_ITERABLES.has(r.name))
		return r.typeArgs[0];
	return ANY;
}

// A stable key for narrowing simple property chains (`a.b.c`), sharing the Scope narrowings map
// with plain identifiers (dotted keys can never collide with real bindings)
export function pathKey(e: Expr): string | undefined {
	switch (e.type) {
		case 'identifier':	return e.name;
		case 'this':		return 'this';
		case 'member': {
			const k = pathKey(e.object);
			return k && k + '.' + e.property;
		}
		default:			return undefined;
	}
}

// JS.ParamList to TS.ParamList; a defaulted parameter counts as optional
export function FixParams(params: JS.Params) {
	const result: TS.Params = {
		params: params.params.filter(p => p.key !== 'this').map((p): TS.Param => ({
			key: typeof p.key === 'string' ? p.key : '_',
			modifiers: !!hasMod(p, 'optional') || !!p.default ? ['optional'] : [],
			typeAnnotation: p.typeAnnotation as Type ?? literalTypeOf(p.default),
			default: p.default }
		)),
	};
	if (params.rest)
		result.rest = {key: params.rest.key, typeAnnotation: params.rest.typeAnnotation as Type};
	return result;
}
export function FixSig(params: JS.CallSig, defaultRet?: Type): TS.CallSig {
	return { ...FixParams(params),
		returnType: params.returnType as Type ?? defaultRet,
		typeParams: params.typeParams as TS.TypeParam[]
	};
}

// Just enough built-in array members that element types survive `pop()!` etc.
function arrayMethod(elem: Type, prop: string): Type | undefined {
	// `map`'s result depends on the callback's own return type, not a fixed formula of `elem` -- needs a real generic signature, or it silently
	// falls back to `ANY`, which can then poison a *constrained* generic elsewhere with a confusing error nowhere near the real cause.
	if (prop === 'map')
		return TS.FunctionType([
				JS.Param('callback', TS.FunctionType([JS.Param('v', elem), JS.Param('i', NUMBER), JS.Param('arr', TS.ArrayType(elem))], TS.RefType('U'))),
				JS.Param('thisArg', ANY, ['optional']),
			],
			TS.ArrayType(TS.RefType('U')),
			[{ name: 'U' }]
		);

	// Real `.flat()` is a recursive conditional type keyed off an explicit depth argument; only the common argument-less (depth-1) case is
	// modeled -- unwrap one level of nesting when `elem` is itself an array. An unmodeled explicit depth falls back to the methods below.
	if (prop === 'flat' && elem.type === 'array')
		return { type: 'function', params: [], rest: { key: 'args', typeAnnotation: { type: 'array', element: NUMBER } }, returnType: { type: 'array', element: elem.element } };

	if (prop === 'every' || prop === 'filter' || prop === 'find' || prop === 'findLast') {
		const S = TS.RefType('S');
		return TS.FunctionType(
			[
				JS.Param('predicate', TS.FunctionType(
					[JS.Param('v', elem), JS.Param('i', NUMBER), JS.Param('arr', TS.ArrayType(elem))],
					TS.Predicate('v', S)
				)),
				JS.Param('thisArg', ANY, ['optional']),
			],
			prop === 'every' ? TS.Predicate('this', TS.ArrayType(S)) : prop === 'filter' ? TS.ArrayType(S) : combineTypes([S, UNDEFINED]),
			[{ name: 'S', constraint: elem, default: elem }],
		);
	}
	const ret =	prop === 'pop' || prop === 'shift' ? combineTypes([elem, UNDEFINED])
			:	prop === 'push' || prop === 'unshift' || prop === 'indexOf' || prop === 'lastIndexOf' || prop === 'findIndex' ? NUMBER
			:	prop === 'includes' || prop === 'some' ? BOOLEAN
			:	prop === 'join' ? STRING
			:	prop === 'slice' || prop === 'concat' || prop === 'reverse' || prop === 'flat' ? { type: 'array', element: elem } as Type
			:	undefined;
	return ret && TS.FunctionType({ params: [], rest: JS.Rest('args', TS.ArrayType(ANY)) }, ret);
}

// `Object.prototype`'s members, for object types that don't declare their own override -- `hasOwnProperty`/`isPrototypeOf`/
// `propertyIsEnumerable` take `ANY` (not the real `PropertyKey`) to stay lenient rather than modeling a `string|number|symbol` union.
function objectPrototypeMember(prop: string): Type | undefined {
	return	prop === 'toString' || prop === 'toLocaleString'	? TS.FunctionType([], STRING)
		:	prop === 'valueOf'									? TS.FunctionType([], ANY)
		:	prop === 'hasOwnProperty' || prop === 'isPrototypeOf' || prop === 'propertyIsEnumerable' ? TS.FunctionType([JS.Param('v', ANY)], BOOLEAN)
		:	undefined;
}

// `skipObjectFallback`: an intersection part must not resolve `Object.prototype` members on its own, or the "first match wins" search would
// stop before reaching a later part's real declaration (e.g. a superclass). Only set by `case 'intersection'`'s own recursive per-part search.
export function lookupMember(t: Type, prop: string, scope: Scope, depth = 10, skipObjectFallback = false): Type | undefined {
	if (depth < 0) {
		hitDepthLimit('lookupMember');
		return ANY;
	}
	// A bare `ref` stamped with its own `declScope` (see `stampScope`) resolves there instead of in `scope` -- the caller's scope chain
	// may have its own, unrelated same-named type (e.g. DOM's `Element` shadowing a class also named `Element`) once a wide enough lib
	// is loaded; `resolve()` itself deliberately stays unaware of `declScope` (see the dated note on its own ref-branch) -- this is the
	// one narrow, bounded place that consults it, not a pervasive/recursive one.
	t = t.type === 'ref' && t.declScope ? (t.declScope as Scope).resolve(t) : scope.resolve(t);
	if (prop === 'length' && (t.type === 'array' || t.type === 'tuple' || isString(t)))
		return NUMBER;
	if (prop === 'constructor')
		return ANY;		// every object has one; its shape isn't modeled

	switch (t.type) {
		case 'array':
			return arrayMethod(t.element, prop);

		 case 'tuple':
			return arrayMethod(combineTypes(t.elements.map(tupleElementType).filter((x): x is Type => !!x)), prop);

		case 'object': {
			const ms = t.members.filter(m => (m.kind === 'property' || m.kind === 'method') && m.name === prop);
			if (ms.length > 1) {
				// Real overloads (every member here must be a same-named `method`) group into one multi-signature callable,
				// the same shape `hoist` builds for free-function overloads, so `typeOf`'s call/new handling resolves both identically.
				return ms.every(m => m.kind === 'method')
					? TS.ObjectType(ms.map((m): TS.TypeMember => ({ kind: 'call', params: m.params, rest: m.rest, returnType: m.returnType ?? ANY, typeParams: m.typeParams, declScope: m.declScope })))
					: ANY;
			}
			const m = ms[0];
			if (m?.kind === 'property')
				return m.typeAnnotation;
			if (m?.kind === 'method')
				// NOT the 4-positional-arg form -- `CallSig`'s runtime overload dispatch tells "3-arg, no rest" apart from "4-arg,
				// rest present" by checking whether the 2nd argument has a `.key` property, so a genuinely `undefined` `m.rest` (the
				// common no-rest-param case) makes it misread this as the 3-arg form, silently shifting `m.returnType` into the
				// `typeParams` slot and dropping `m.typeParams` entirely. The single-object form is unambiguous (dispatches on
				// `'params' in args[0]`), regardless of whether `rest`/`typeParams` are present. `declScope` carried through too --
				// this class's own method, consulted from a different module, still resolves its declared param/return types here.
				return { type: 'function', params: m.params, rest: m.rest, returnType: m.returnType ?? ANY, typeParams: m.typeParams, declScope: m.declScope };
			// Both of these are *fallbacks*, tried only once no member is explicitly named `prop` -- skipped entirely on a per-part
			// intersection lookup (`skipObjectFallback`), so a `Record<string, X> & { realMethod(): Y }`-shaped intersection (an
			// `Object.assign(someRecord, { realMethod... })` idiom) doesn't let the `Record` part's index signature shadow the
			// other part's real, explicitly-named member -- the intersection case below only consults an index signature itself
			// as its own last resort, after every part has already been checked for a real member.
			if (skipObjectFallback)
				return undefined;
			// `Object.prototype`'s own members are checked after the index signature, so a type that declares its own override
			// (e.g. a custom `toString(x?: string): string`) still wins.
			return t.members.find(m => m.kind === 'index')?.typeAnnotation ?? objectPrototypeMember(prop);
		}
		case 'intersection': {
			const matches: Type[] = [];
			for (const part of t.types) {
				const m = lookupMember(part, prop, scope, depth - 1, true);
				if (m)
					matches.push(m);
			}
			// Every part searched, including inherited ones, and none declared `prop` as a real member -- an index signature on any
			// part still legitimately covers this key (real TS also lets a `Record<string, X> & {...}` intersection's index signature
			// answer for a name none of the other parts declare), tried before falling back to `Object.prototype`.
			if (!matches.length) {
				if (skipObjectFallback)
					return undefined;
				for (const part of t.types) {
					const r = resolveOwn(part, scope);
					const idx = r.type === 'object' ? r.members.find(m => m.kind === 'index') : undefined;
					if (idx)
						return idx.typeAnnotation;
				}
				return objectPrototypeMember(prop);
			}
			if (matches.length === 1)
				return matches[0];
			// Declaration merging (`ArrayConstructor.from` split across `lib.es2015.core.d.ts`/`lib.es2015.iterable.d.ts`, each
			// part's own interface fragment) is the common reason more than one part declares the same-named `prop` -- most of
			// the time every fragment redeclares the *identical* type (structurally, ignoring `pos`/`declScope`), so dedupe first:
			// collapses right back to the `matches.length === 1` case above and keeps every existing single-declaration behavior
			// (including real TS's own multi-file merging quirks, e.g. DOM's `HTMLElement`/`Element`/`Node` chain) untouched.
			const distinctKey = (m: Type) => JSON.stringify(m, (k, v) => k === 'pos' || k === 'declScope' ? undefined : v);
			const distinct = [...new Map(matches.map(m => [distinctKey(m), m])).values()];
			if (distinct.length === 1)
				return distinct[0];
			// More than one part declaring a *genuinely different* same-named method is real TS's own cross-file overload-merging
			// shape -- combine into one multi-signature overload set, same as the `object` case's own handling of several
			// same-named `method` members within a single interface. Each match is itself either a single signature (`function`,
			// one declaration of `prop`) or an already-merged multi-signature set (`object` of `call` members, when *one* part
			// alone had several overloads of `prop`) -- flatten both shapes into one combined list.
			const sigs: TS.CallSig[] = [];
			let allSigs = true;
			for (const m of distinct) {
				if (m.type === 'function') {
					sigs.push(m);
				} else if (m.type === 'object' && m.members.length && m.members.every((mem): mem is TS.TypeMember & { kind: 'call' } => mem.kind === 'call')) {
					sigs.push(...m.members);
				} else {
					allSigs = false;
					break;
				}
			}
			if (allSigs)
				return TS.ObjectType(sigs.map((s): TS.TypeMember => ({ kind: 'call', params: s.params, rest: s.rest, returnType: s.returnType, typeParams: s.typeParams })));
			// Anything else -- a plain property/value genuinely narrowed by more than one part at once (e.g. a self-referential
			// alias intersected with a discriminant literal, `SomeUnion & { kind: 'x' }`'s own `kind`) -- really does need every
			// part's constraint applied together, not just the first: unlike class-inheritance override (a subclass part legitimately
			// shadows a base part), `&`'s parts have no such order.
			return TS.IntersectionType(distinct);
		}
		case 'union': {
			const parts = t.types.map(p => lookupMember(p, prop, scope, depth - 1));
			return parts.every(p => !!p) ? combineTypes(parts as Type[]) : undefined;
		}
		default:
			return undefined;
	}
}

// Narrows `m` by a discriminant-property equality test (`m.prop === value`, `keepMatch` says whether equal or unequal members
// survive) -- unlike `lookupMember`, which only *reads* a property's type, this recurses into `m`'s own structure to actually
// split it: a compound member whose discriminant is itself a union of several possibilities (e.g. `JSDeclaration`, wrapping
// `VarDecl | FunctionDecl | ClassDecl`) gets reduced to just the matching sub-variant(s) combined, not kept or discarded whole.
// Returns `true` (keep `m` unchanged), `false` (exclude `m`), or a replacement `Type` -- see `Scope.narrowValue`'s `keep` contract.
export function narrowByDiscriminant(m: Type, prop: string, scope: Scope, keepMatch: boolean, target: unknown, depth = 6): boolean | Type {
	if (depth < 0) {
		hitDepthLimit('narrowByDiscriminant');
		return true;	// can't determine within budget: lenient, same as an unresolvable discriminant below
	}
	const r = resolveOwn(m, scope);
	if (r.type === 'union') {
		const parts: Type[] = [];
		let changed = false;
		for (const x of r.types) {
			const k = narrowByDiscriminant(x, prop, scope, keepMatch, target, depth - 1);
			if (k !== false)
				parts.push(k === true ? x : k);
			if (k !== true)
				changed = true;
		}
		if (!changed)
			return true;
		return parts.length ? combineTypes(parts) : false;
	}
	const pt = lookupMember(r, prop, scope);
	const rp = pt && scope.resolve(pt);
	// Not a plain literal (opaque, or -- shouldn't normally happen once fully recursed through every union level above --
	// still a compound union itself): can't determine which way this leaf should go. Lenient, matching `lookupMember`'s and
	// `resolve`'s own established "unresolvable stays uncommitted" leniency elsewhere.
	return !rp || rp.type !== 'literal' || (rp.value === target) === keepMatch;
}

// A shape is "sealed" when a missing member is genuinely an error (an object type we fully know),
// as opposed to a ref/primitive/array whose built-in members this checker doesn't model.
export function sealed(t: Type, scope: Scope, depth = 6): boolean {
	if (depth < 0) {
		hitDepthLimit('sealed');
		return false;
	}
	t = resolveOwn(t, scope);
	return t.type === 'object' || (t.type === 'intersection' && t.types.every(p => sealed(p, scope, depth - 1)));
}

// `dstScope` resolves names in `dst`'s own structure, distinct from `scope` (which resolves `src`'s) -- they're the same scope almost always
// (hence the default), but a `dst` originating from another module's own signature (a namespace-imported overload's declared param type, e.g.
// `bin.as`'s `adapter0<T,D>`) declares its own names in *that* module's scope. Every recursive call below passes each value's own origin scope
// through, not just its parameter position -- see the tuple/array-widening branch for the one place a value's role flips between calls.
export function isAssignable(src: Type, dst: Type, scope: Scope, dstScope: Scope = scope, strict = false, depth = 10): boolean {
	function recurse(src: Type, dst: Type, depth: number): boolean {
		if (depth < 0) {
			hitDepthLimit('isAssignable');
			return true;
		}
		// `resolve()` only strips a *top-level* `parenthesized` wrapper -- one buried inside a union/intersection member
		// (`(A & B) | undefined`, a common explicit-parens return-type annotation) reaches here unresolved on every
		// recursive step below, since those re-dispatch straight to `recurse` on each member, not back through `resolve()`.
		if (src.type === 'parenthesized')
			return recurse(src.inner, dst, depth);
		if (dst.type === 'parenthesized')
			return recurse(src, dst.inner, depth);
		if (src.type === 'ref' && dst.type === 'ref' && src.name === dst.name) {
			const sa = src.typeArgs ?? [], da = dst.typeArgs ?? [];
			if (sa.length === da.length && sa.every((a, i) => recurse(a, da[i], depth - 1)))
				return true;	// same named type, pairwise-compatible arguments: skip the structural comparison
		}
		// `T[]`/`readonly T[]` sugar and the named `Array<T>`/`ReadonlyArray<T>` ref are the same type -- caught here, before the
		// generic `resolve()` below expands the ref into `Array<T>`'s own structural (index-signature) interface body, which the
		// `dst.type === 'array'` branch further down doesn't recognize as array-shaped.
		if (dst.type === 'array' && src.type === 'ref' && (src.name === 'Array' || src.name === 'ReadonlyArray') && src.typeArgs?.length)
			return recurse(src.typeArgs[0], dst.element, depth - 1);
		// `resolve()` gets a fresh budget here rather than inheriting `depth` -- see the comment on the same pattern in `lookupMember`.
		// NOT `resolveOwn` here, deliberately -- tried, reverted three times now. The `narrowValue`/`narrowByDiscriminant` splitting
		// fix (see those) closed one layer of the accidental-leniency problem described in earlier revert attempts (git history/PR
		// notes), but re-enabling this still regresses the self-check on a *different* set of sites (`ForInit`-shaped unions,
		// `checker.ts`'s `expected = undefined` flow, even a fresh gap in this file's own new ternary-narrowing). Each retry has
		// found a real, fixable, but distinct gap -- there isn't yet a point where the well runs dry, so treat this as still
		// actively unsafe rather than "one more fix away". Revisit if the remaining self-check errors get root-caused individually.
		src = scope.resolve(src);
		dst = dstScope.resolve(dst);
		// same node (common once `resolve`'s default-substitution cache is in play, e.g. two paths into
		// the same self-referential union both bottoming out at the identical cached instance): trivially assignable.
		if (src === dst)
			return true;

		if (isAny(src) || isAny(dst) || (src.type === 'ref' && src.name === 'never'))
			return true;
		if (src.type === 'ref' && !PRIMITIVES.has(src.name))
			return true;		// unresolved named source (import/global/type parameter): lenient
		if (OPAQUE.has(src.type) || OPAQUE.has(dst.type)) {
			if (strict) {
				if (OPAQUE_GAP.has(src.type) || OPAQUE_GAP.has(dst.type))
					return false;
			}
			return true;
		}
		if (src.type === 'union')
			return src.types.every(t => recurse(t, dst, depth - 1));
		if (dst.type === 'union')
			// the identity test makes a narrowed union (whose members are the original alias's own nodes) trivially assignable back to it
			return dst.types.some(t => t === src || recurse(src, t, depth - 1));
		if (dst.type === 'intersection')
			return dst.types.every(t => recurse(src, t, depth - 1));
		if (src.type === 'intersection' && dst.type !== 'object')
			return src.types.some(t => recurse(t, dst, depth - 1));

		if (dst.type === 'literal')
			return src.type === 'literal' ? src.value === dst.value
				: src.type === 'ref' && dst.value !== null && src.name === typeof dst.value;	// widened source: lenient
		if (src.type === 'literal')
			return dst.type === 'ref' && (!PRIMITIVES.has(dst.name) || dst.name === (src.value === null ? 'null' : typeof src.value));
		if (src.type === 'template_literal' || dst.type === 'template_literal')
			return (src.type === 'template_literal' || isString(src))
				&& (dst.type === 'template_literal' || isString(dst));

		if (dst.type === 'array')
			return src.type === 'array'
				? recurse(src.element, dst.element, depth - 1)
				: src.type === 'tuple' && src.elements.every(e => { const t = tupleElementType(e); return !t || recurse(t, dst.element, depth - 1); });
		if (dst.type === 'tuple') {
			if (src.type === 'array')	// an inferred array literal has lost its element positions: compare loosely, either direction
				return dst.elements.every(el => { const t = tupleElementType(el); return !t || recurse(src.element, t, depth - 1) || recurse(t, src.element, depth - 1); });
			if (src.type !== 'tuple')
				return false;
			return src.elements.length >= dst.elements.filter(e => !(e.type === 'optional' || e.type === 'spread' || (e.type === 'labeled' && e.optional))).length
				&& src.elements.every((e, i) => {
					const st = tupleElementType(e), dt = dst.type === 'tuple' && dst.elements[i] ? tupleElementType(dst.elements[i]) : undefined;
					return !st || !dt || recurse(st, dt, depth - 1);
				});
		}

		if (dst.type === 'function' || dst.type === 'constructor') {
			if (src.type !== dst.type)
				return src.type === 'object' && src.members.some(m => m.kind === (dst.type === 'constructor' ? 'construct' : 'call'));
			if (!dst.returnType || !src.returnType)
				return true;	// missing return type (e.g. an unmodeled class method): lenient
			// parameters deliberately unchecked (bivariance noise); returns covariant, void-dst absorbs anything
			return dst.returnType.type === 'ref' && dst.returnType.name === 'void'
				|| recurse(src.returnType, dst.returnType, depth - 1);
		}

		if (dst.type === 'object') {
			// `array`/`tuple` go through the same per-member `lookupMember` path as `object`/`intersection` below (not the blanket
			// "no required members" fallback) -- `lookupMember` already models real array members (`.length`, `arrayMethod`'s `.map`/
			// `.push`/...), which a bare-fallback would otherwise reject wholesale (e.g. an array assigned to `Iterable<T>`/`ArrayLike<T>`).
			if (src.type !== 'object' && src.type !== 'intersection' && src.type !== 'array' && src.type !== 'tuple')
				return src.type === 'ref' && !PRIMITIVES.has(src.name)		// unresolved nominal: lenient
					// a bare function/constructor has no properties *or* methods of its own -- required members of either kind rule it out
					|| src.type === 'function' || src.type === 'constructor'
						? dst.members.every(m => (m.kind !== 'property' && m.kind !== 'method') || m.optional)
						: false;
			return dst.members.every(m => {
				if (m.kind !== 'property' || typeof m.name !== 'string')
					return true;		// methods/call/index/computed: lenient
				// `lookupMember` gets its own fresh budget, not `recurse`'s remaining `depth` -- same reasoning as
				// `lookupMember`'s own `resolve()` call.
				const got = lookupMember(src, m.name, scope);
				// an optional property also accepts undefined; absence only counts against a sealed source
				return got ? recurse(got,
					m.optional ? TS.UnionType([m.typeAnnotation, UNDEFINED]) : m.typeAnnotation, depth - 1) : !!m.optional || !sealed(src, scope) || recurse(UNDEFINED, m.typeAnnotation,
					depth - 1
				);
			});
		}

		if (dst.type === 'ref') {
			if (dst.name === 'object')
				return !(src.type === 'ref' && PRIMITIVES.has(src.name)) || src.name === 'object' || src.name === 'null';
			if (dst.name === 'void')
				return src.type === 'ref' && (src.name === 'void' || src.name === 'undefined');
			if (src.type === 'ref') {
				if (src.name === dst.name)
					return !dst.typeArgs || !src.typeArgs || src.typeArgs.length !== dst.typeArgs.length || src.typeArgs.every((a, i) => recurse(a, dst.typeArgs![i], depth - 1));
				if (src.name === 'void' && dst.name === 'undefined')
					return true;	// this checker's own bare-`return` inference produces `void`
				return !(PRIMITIVES.has(src.name) && PRIMITIVES.has(dst.name));	// distinct primitives: no; unresolved names: lenient
			}
			return !PRIMITIVES.has(dst.name);	// structural value into unresolved named type: lenient
		}
		if (src.type === 'ref')
			return !PRIMITIVES.has(src.name);

		return src.type === dst.type;
	}
	return recurse(src, dst, depth);
}


export function wrapType(t: Type, names: Set<string>, name: string) {
	return t.type === 'ref' && names.has(t.name) ? t : TS.RefType(name, [t]);
}

// Peels through plain ref aliases (`type Response<T> = Promise<T['body']>`, a common wrapper idiom) one substitution at a time,
// looking for a literal `Promise<X>` ref -- unlike `scope.resolve`, which would blow straight through into Promise's own
// (declaration-merged, structural) body and lose the "this was a Promise" identity every await/return-flattening site needs.
export function asPromiseRef(t: Type, scope: Scope, depth = 6): TS.RefType | undefined {
	if (depth < 0) {
		hitDepthLimit('asPromiseRef');
		return undefined;
	}
	if (t.type !== 'ref')
		return undefined;
	if (t.name === 'Promise')
		return t.typeArgs?.length ? t : undefined;
	const entry = ownScope(t, scope).type(t.name);
	return entry && asPromiseRef(entry.typeParams?.length
		? substituteType(entry.type, new Map(entry.typeParams.map((p, i) => [p.name, t.typeArgs?.[i] ?? p.default ?? ANY])))
		: entry.type, scope, depth - 1
	);
}

// `Awaited<T>`: distributes over a union (a call signature declared/inferred as `string | Promise<string>`, or a ternary
// mixing an awaited and a plain branch) -- each member is awaited on its own, not the union as a whole, which is never
// itself a literal `Promise<X>` ref for `asPromiseRef` to match.
export function awaitType(t: Type, scope: Scope): Type {
	const r = resolveOwn(t, scope);
	if (r.type === 'union')
		return combineTypes(r.types.map(x => awaitType(x, scope)));
	const p = asPromiseRef(t, scope);
	return p ? p.typeArgs![0] : r;
}

export function unwrapIfAsync(t: Type, scope: Scope, async: boolean|undefined): Type {
	return async ? awaitType(t, scope) : t;
}

export function wrapReturnIfAsync(t: Type, scope: Scope, async: boolean|undefined): Type {
	return !async || asPromiseRef(t, scope) ? t : TS.RefType('Promise', [t]);
}

export function memberOptional(t: Type, prop: string, scope: Scope, depth = 6): boolean {
	t = resolveOwn(t, scope);
	if (t.type === 'object')
		return t.members.some(m => (m.kind === 'property' || m.kind === 'method') && m.name === prop && m.optional);
	if (t.type !== 'intersection')
		return false;
	if (depth <= 0) {
		hitDepthLimit('memberOptional');
		return false;
	}
	return t.types.some(p => memberOptional(p, prop, scope, depth - 1));
}

// Tags every `ref` (and every `function`/`constructor`/method/call/construct signature) reachable from `t` with `scope`
// (mutates in place via `mapObjectVoid`, matching `withScope`'s own convention -- these are freshly-built nodes at the point
// every caller uses this, never shared/cached ones) -- skips a ref/signature that already carries a (necessarily more
// specific) scope from a previous stamp, so re-stamping an already-tagged shared structure is a no-op. Delegates the actual
// tree-shape traversal to `TSwalk` rather than hand-rolling it a second time here.
export function stampScope<T extends Type>(t: T, scope: Scope) {
	return TSwalk(t, undefined, undefined,
		(x, process) => {
			// Primitives resolve the same everywhere (`Scope.resolve()`'s own ref-branch skips them via the same guard) --
			// stamping them would only add dead weight (and dedup-key noise `combineTypes` has to filter back out) for no
			// behavioral gain.
			if (x.type === 'ref') {
				if (!x.declScope && !PRIMITIVES.has(x.name))
					x.declScope = scope;
			} else if (x.type === 'function' || x.type === 'constructor') {
				x.declScope ??= scope;
			}
			return process(x);
		},
		(m, process) => {
			if (m.kind === 'method' || m.kind === 'call' || m.kind === 'construct')
				m.declScope ??= scope;
			return process(m);
		},
		mapObjectVoid
	) ?? t;
}

// Stamps a `CallSig`-shaped object's own params/rest/return type -- for callers stamping a freshly-built signature directly
// (a bare `TS.CallSig`, e.g. a hoisted free function's, isn't itself a `Type` node, so `stampScope`/`TSwalk` alone can't take it).
export function stampSig<T extends TS.CallSig>(sig: T, scope: Scope): T {
	// Also tags the signature itself (see `withScope`) -- a bare interface/type-literal method has no other declScope
	// source (unlike a hoisted free function/class method, which already gets one before `stampSig` ever sees it).
	sig.declScope ??= scope;
	sig.params.forEach(p => p.typeAnnotation && stampScope(p.typeAnnotation as Type, scope));
	if (sig.rest?.typeAnnotation)
		stampScope(sig.rest.typeAnnotation as Type, scope);
	if (sig.returnType)
		stampScope(sig.returnType, scope);
	return sig;
}

// `instance` is the type of `new C(...)`/`this`; `value` is the class binding's own type (construct signature intersected with static members).
// `scope`: this class's own declaring scope -- stamped (see `stampScope`) onto every `ref` in the result, so a member's type,
// once extracted and consulted from a different module later, still resolves bare same-module names (including the class's
// own, for a self-referential member) against the scope that actually declares them, not whichever scope is doing the resolving.
export function classShapes(c: JS.Class, scope: Scope): { instance: Type; value: Type } {
	const members:			TS.TypeMember[] = [];
	const staticMembers:	TS.TypeMember[] = [];
	let ctorParams:			TS.Params | undefined;

	for (const m of c.body as TS.ClassMember[]) {
		if (!('key' in m) || typeof m.key !== 'string') {
			if (m.type === 'index_signature')
				members.push(TS.TypeIndex(m.paramName, m.paramType, m.typeAnnotation));
			continue;
		}
		const list = 'modifiers' in m && hasMod(m, 'static') ? staticMembers : members;
		if (m.type === 'field') {
			list.push(TS.TypeProperty(m.key, (m.typeAnnotation as Type) ?? ANY, hasMod(m, 'optional')));
		} else if (m.type === 'method') {
			if (m.key === 'constructor') {
				ctorParams = FixParams(m);
				// A parameter-property modifier is anything but the unrelated `'optional'` tag.
				for (const p of m.params)
					if (p.modifiers?.some(x => x !== 'optional') && typeof p.key === 'string')
						members.push(TS.TypeProperty(p.key, (p.typeAnnotation as Type) ?? literalTypeOf(p.default) ?? ANY, hasMod(p, 'optional')));
			} else if (m.kind === 'get') {
				list.push({ kind: 'property', name: m.key, typeAnnotation: (m.returnType as Type) ?? ANY });
			} else if (m.kind === 'set') {
				if (!list.some(x => x.kind === 'property' && x.name === m.key))
					list.push(TS.TypeProperty(m.key, (m.params[0]?.typeAnnotation as Type) ?? ANY));
			} else {
				list.push(TS.TypeMethod(m.key, withScope(FixSig(m, ANY), scope), hasMod(m, 'optional')));
			}
		}/* else if (m.type === 'method_signature') {
			if (m.key === 'constructor') {
				// A bodyless `constructor(...);` signature -- the only form an ambient/`.d.ts` class
				// body ever uses -- mirrors the real-`method` branch's constructor handling above.
				ctorParams = FixParams(m);
			} else if (m.kind === 'get') {
				list.push(TS.TypeProperty(m.key, (m.returnType as Type) ?? ANY));
			} else if (m.kind === 'set') {
				if (!list.some(x => x.kind === 'property' && x.name === m.key))
					list.push(TS.TypeProperty(m.key, (m.params[0]?.typeAnnotation as Type) ?? ANY));
			} else {
				list.push(TS.TypeMethod(m.key, withScope(FixSig(m, ANY), scope), hasMod(m, 'optional')));
			}
		}*/
	}
	const obj = TS.ObjectType(members);
	// a base the checker can't model (mixin call, namespace member, imported class) leaves the instance unsealed; likewise an inherited constructor accepts any arguments.
	// Own members come first: lookupMember's first match implements override precedence
	const superType: Type | undefined =
		c.superClass?.type === 'identifier' ? TS.RefType(c.superClass.name)
		: c.superClass?.type === 'instantiation' && c.superClass.expression.type === 'identifier' ? TS.RefType(c.superClass.expression.name, c.superClass.typeArgs as Type[])
		: c.superClass ? ANY : undefined;
	const instance: Type = superType ? TS.IntersectionType([obj, superType]) : obj;
	if (!ctorParams)
		ctorParams = {params: [], rest: c.superClass ? JS.Rest('args', TS.ArrayType(ANY)) : undefined};
	const ctor:		Type = {
		type: 'constructor',
		...withScope(TS.CallSig(ctorParams, c.name ? TS.RefType(c.name) : instance, c.typeParams as TS.TypeParam[]), scope)
	};
	const value = staticMembers.length ? TS.IntersectionType([ctor, TS.ObjectType(staticMembers)]) : ctor;
	stampScope(instance, scope);
	stampScope(value, scope);
	return { instance, value };
}

// Does `argTs` fit `sig` (arity, then every provided argument assignable)?
// The same rule the real per-call diagnostic below enforces, just as a silent predicate -- used to pick the first overload candidate (in declaration order) that actually works.
export function argsFit(sig: TS.CallSig, argTs: (Type | undefined)[], scope: Scope): boolean {
	if (argTs.length < sig.params.filter(p => !hasMod(p, 'optional')).length || (!sig.rest && argTs.length > sig.params.length))
		return false;
	// `sig.declScope`: each param's own declared type resolves names in its *declaring* module's scope, not the caller's (see `isAssignable`'s `dstScope`).
	const dstScope = (sig.declScope as Scope | undefined) ?? scope;
	return argTs.every((t, i) => {
		const p = sig.params[i];
		return !t || !p?.typeAnnotation || isAssignable(t, hasMod(p, 'optional') ? TS.UnionType([p.typeAnnotation, UNDEFINED]) : p.typeAnnotation, scope, dstScope);
	});
};

// `defaultSubstitution`: cached on the entry itself, not a side-table -- it depends only on `typeParams`/`type` (both intrinsic to the entry, never
// `scope`), so caching it here lets the value outlive and be shared across checker instances instead of recomputing fresh in each one's own cache.
export interface TypeEntry { typeParams?: TS.TypeParam[]; type: Type; defaultSubstitution?: Type }

export class Scope {
	private values		= new Map<string, Type>();
	private types		= new Map<string, TypeEntry>();
	private narrowings?:	Map<string, Type>;	// control-flow refinements, consulted before declarations
	private aliases?:		Map<string, Expr>;	// const initializers -- narrowing a const also narrows through its initializer (TS 4.4 aliased conditions)
	namespaces?:	Map<string, Scope>;	// nested namespace/module scopes, keyed by their bound name -- consulted by `resolve` for a dotted type ref (`NS.Foo`)

	constructor(public parent?: Scope) {}

	value(name: string): Type | undefined			{ return this.narrowings?.get(name) ?? this.values.get(name) ?? this.parent?.value(name); }
	type(name: string): TypeEntry | undefined		{ return this.types.get(name) ?? this.parent?.type(name); }
	// The declaration-site type, ignoring narrowings -- what an assignment must satisfy
	declared(name: string): Type | undefined		{ return this.values.get(name) ?? this.parent?.declared(name); }
	alias(name: string): Expr | undefined			{ return this.aliases?.get(name) ?? (this.values.has(name) ? undefined : this.parent?.alias(name)); }
	namespace(name: string): Scope | undefined		{ return this.namespaces?.get(name) ?? this.parent?.namespace(name); }

	addValue(name: string, type: Type)				{ this.values.set(name, type); }
	addType(name: string, type: Type, typeParams?: TS.TypeParam[])	{ this.types.set(name, {type, typeParams}); }
	addNarrowing(name: string, t: Type)				{ (this.narrowings ??= new Map()).set(name, t); }
	addAlias(d: JS.VarDeclarator)					{ (this.aliases ??= new Map()).set(d.name, d.init); }
	addNamespace(name: string, s: Scope)			{ (this.namespaces ??= new Map()).set(name, s); }

	mergeType(name: string, type: Type, typeParams: TS.TypeParam[] | undefined) {
		return this.mergeTypeEntry(name, {type, typeParams});
	}
	private mergeTypeEntry(name: string, te: TypeEntry) {
		const prev = this.types.get(name);
		this.types.set(name, prev ? { typeParams: prev.typeParams ?? te.typeParams, type: intersectTypes([prev.type, te.type]) } : te);
	};

	// Every name narrowed anywhere between this scope and `base` (exclusive); used to combine two independently-narrowed branches of a `||`/`&&` test.
	narrowedNames(base: Scope): Set<string> {
		const names = new Set<string>();
		for (let s: Scope | undefined = this; s && s !== base; s = s.parent)
			for (const name of s.narrowings?.keys() ?? [])
				names.add(name);
		return names;
	}

	copy(from: Scope, local: string, pub: string, typeOnly = false) {
		if (!typeOnly) {
			const v = from.value(local);
			if (v)
				this.values.set(pub, v);
			const ns = from.namespace(local);
			if (ns)
				this.addNamespace(pub, ns);
		}
		const te = from.type(local);
		if (te)
			this.mergeTypeEntry(pub, te);
	}
	copyAll(from: Scope, typeOnly = false) {
		for (const name of new Set([...from.values.keys(), ...from.types.keys()]))
			this.copy(from, name, name, typeOnly);
	}


	// Expands a `ref` to its structural declaration, substituting type args (primitives/unresolvable names pass through unchanged). Bare generic
	// refs cache their default substitution on the entry, keeping repeats `===`-identical -- `isAssignable`'s fast path needs that to terminate self-referential types.
	resolve(t: Type, depth = 10): Type {
		if (depth < 0) {
			hitDepthLimit('Scope.resolve');
			return ANY;
		}
		switch (t.type) {
			case 'parenthesized':
				return this.resolve(t.inner, depth - 1);
			case 'readonly':
				return this.resolve(t.argument, depth - 1);
			case 'mapped':
				if (!t.nameType) {
					// Members are only knowable once the key constraint resolves to a literal (or union of literals); anything else stays opaque.
					// `nameType` (the `as` key-remapping clause) isn't handled -- bail out rather than expand under the wrong (un-remapped) names.
					const constraint = this.resolve(t.constraint, depth - 1);
					const keys = constraint.type === 'literal' && typeof constraint.value === 'string' ? [constraint.value]
						: constraint.type === 'union' && constraint.types.every(m => m.type === 'literal' && typeof m.value === 'string') ? constraint.types.map(m => (m as { value: string }).value)
						: undefined;
					if (keys) {
						return this.resolve(TS.ObjectType(keys.map(key => TS.TypeProperty(
							key, substituteType(t.valueType, new Map([[t.keyName, { type: 'literal', value: key }]])), t.optional, t.readonly
						))), depth - 1);
					}
					// `Record<string, T>`/`{ [k: string]: T }`-shaped mapped types (real TS's own `Record<K, T>` is itself declared as a mapped
					// type `{ [P in K]: T }`) -- the single most common non-literal-key shape in real code. Modeled as an index signature
					// rather than staying opaque; a homomorphic mapped type's `valueType` referencing its own key name (rare when the
					// constraint isn't a finite literal set) substitutes the constraint itself in, same as the finite-keys branch above.
					if (isKeyable(constraint) || (constraint.type === 'union' && constraint.types.every(isKeyable))) {
						return this.resolve(TS.ObjectType([
							TS.TypeIndex('key', constraint, substituteType(t.valueType, new Map([[t.keyName, constraint]])), t.readonly)
						]), depth - 1);
					}
				}
				break;
			case 'indexed_access': {
				// `T[K]`: resolvable only when the index resolves to a literal (or union of literals), by looking up each corresponding member.
				const index = this.resolve(t.index, depth - 1);
				const keys = index.type === 'literal' && typeof index.value === 'string' ? [index.value]
					: index.type === 'union' && index.types.every(m => m.type === 'literal' && typeof m.value === 'string') ? index.types.map(m => (m as { value: string }).value)
					: undefined;
				if (keys) {
					const object = this.resolve(t.object, depth - 1);
					// `lookupMember` gets its own fresh budget, not `resolve`'s remaining `depth` -- same reasoning as
					// `lookupMember`'s own `resolve()` call.
					const parts = keys.map(key => lookupMember(object, key, this));
					if (parts.every((p): p is Type => !!p))
						return this.resolve(combineTypes(parts), depth - 1);
				}
				break;
			}
			case 'keyof': {
				// `keyof any` is an intrinsic (real TS special-cases it too, not a structural lookup) equal to every legal property-key
				// type -- without this, comparing against it always fell into the generic opaque-`keyof` GAP, even though it's actually
				// the single most common `keyof` position in real code (index-signature-style helper constraints, `Record`-like generics).
				// Checked on the *raw* argument, not `resolve()`'s output -- `resolve` also returns `ANY` as a generic "gave up" sentinel
				// once its recursion budget (`depth`) runs out on an unrelated, unrolled chain, which must not be mistaken for real `any`.
				if (isAny(t.argument))
					return TS.UnionType([TS.RefType('string'), TS.RefType('number'), TS.RefType('symbol')]);
				const arg = this.resolve(t.argument, depth - 1);
				// An object made purely of an index signature (`Record<string, T>`/`{ [k: string]: T }`, now that mapped types over a
				// non-literal key resolve to one) has no enumerable literal keys -- `keyof` of it is simply the index's own key type
				// (real TS: `keyof Record<string, T>` is `string`, not `never`), distinct from the finite-literal-keys case below.
				if (arg.type === 'object' && arg.members.length && arg.members.every(m => m.kind === 'index'))
					return this.resolve(combineTypes(arg.members.map(m => m.paramType)), depth - 1);
				// Paired with `indexed_access` above, resolves the common `(typeof Round)[keyof typeof Round]` const-object-as-enum idiom end to end.
				const keys = objectKeyNames(arg, this, depth - 1);
				if (keys)
					return this.resolve(combineTypes(keys.map((key): Type => ({ type: 'literal', value: key }))), depth - 1);
				break;
			}
			case 'conditional': {
				// Only once `checkType` is concrete -- real TS also defers a conditional type until its naked check type is instantiated.
				const check = this.resolve(t.checkType, depth - 1);
				if (!isAny(check) && !(check.type === 'ref' && !PRIMITIVES.has(check.name) && !this.type(check.name))) {
					if (containsInfer(t.extendsType)) {
						const bindings = new Map<string, Type>();
						// `t.checkType`, not the already-resolved `check` -- resolving a real named type (e.g. lib.d.ts's own `Promise<T>`)
						// eagerly expands it to its full structural body, losing the "named `Promise<number>`" identity `matchInfer`'s
						// `ref`-typeArgs case needs to match against `Promise<infer R>` (same pitfall `inferTypeArgs` already works around).
						// `matchInfer` gets its own fresh budget, not `resolve`'s remaining `depth` -- same reasoning as `lookupMember`'s own `resolve()` call.
						const r = matchInfer(t.extendsType, t.checkType, this, bindings);
						if (r !== undefined)
							return this.resolve(r ? substituteType(t.trueType, bindings) : t.falseType, depth - 1);
					} else {
						const r = conditionalExtends(check, this.resolve(t.extendsType, depth - 1), this);
						if (r !== undefined)
							return this.resolve(r ? t.trueType : t.falseType, depth - 1);
					}
				}
				break;
			}
			case 'typeof': {
				const parts = t.name.split('.');
				let v		= this.value(parts[0]);
				for (let i = 1; v && i < parts.length; i++)
					v = lookupMember(v, parts[i], this);
				return v ? this.resolve(v, depth - 1) : ANY;
			}
			case 'ref':
				if (!PRIMITIVES.has(t.name)) {
					// NOTE: `t.declScope` (see `stampScope`) is deliberately NOT consulted here yet -- see the dated note in
					// tison_project memory ("cross-module member resolution", declScope rollback) for why: wiring it in here
					// (resolving via `t.declScope` in place of `this`) fixed the originally-reported cross-module bug but
					// destabilized self-hosted checking (checker.ts checking itself) via a still-unidentified cache/cycle
					// interaction with `entry.defaultSubstitution`, not fixed by raising the depth budget. Reverted pending
					// a safer, more contained fix (e.g. applied only at `lookupMember`'s entry point, not here).
					// A dotted type ref (`NS.Foo`) isn't a plain declaration -- `typeEntry` only holds bare names, so route through the namespace's own scope.
					// An unresolvable prefix stays lenient (falls through to the plain lookup below, which also won't match a dotted key).
					const dot = t.name.indexOf('.');
					if (dot >= 0) {
						const ns = this.namespace(t.name.slice(0, dot));
						return ns ? ns.resolve({ ...t, name: t.name.slice(dot + 1) }, depth - 1) : t;
					}
					const entry = this.type(t.name);
					if (entry) {
						if (!entry.typeParams?.length)
							return this.resolve(entry.type, depth - 1);
						if (!t.typeArgs) {
							entry.defaultSubstitution ??= substituteType(entry.type, new Map(entry.typeParams.map(p => [p.name, p.default ?? ANY])));
							return this.resolve(entry.defaultSubstitution, depth - 1);
						}
						return this.resolve(substituteType(entry.type, new Map(entry.typeParams.map((p, i) => [p.name, t.typeArgs?.[i] ?? p.default ?? ANY]))), depth - 1);
					}
				}
				break;

		}
		return t;
	}

	// Refines `name`'s binding to the union members `keep` accepts; anything non-union (or a filter that would empty the union)
	// narrows nothing. `name` may be a dotted path key. `keep` may return `true` (member survives unchanged), `false` (member
	// excluded outright), or a `Type` (member survives, replaced by this narrower version of itself) -- the last lets a caller
	// split a *compound* member (one whose own discriminant is itself a union of possibilities, not a single literal) down to
	// just the part(s) that actually match, instead of only being able to keep-or-discard it whole (see `narrowByDiscriminant`).
	narrowValue(name: string, keep: (m: Type) => boolean | Type, t = this.value(name)): Scope {
		const r = t && resolveOwn(t, this);
		if (!r || isAny(r))
			return this;
		if (r.type === 'union') {
			// A member may resolve to a further (type-alias-nested) union -- flatten fully before filtering, so a discriminant matching only
			// part of a compound member (`instanceof Uri` against `IconType0 | ThemeIcon`) filters at the right granularity, not the whole member.
			// `resolveOwn`, not a bare `this.resolve`: a member reached through a cross-module alias (e.g. `ClassMember0`, declared in
			// js-parser.ts, referenced bare from within `ts-parser.ts`'s own `ClassMember` union) carries its declaring scope on the ref
			// itself -- `this` here is whatever scope is doing the narrowing, which may never have had that bare name in scope at all.
			const flat		= combineTypes(r.types.map(m => resolveOwn(m, this)));
			const flatTypes = flat.type === 'union' ? flat.types : [flat];
			const parts: Type[] = [];
			let changed = false;
			for (const m of flatTypes) {
				const k = keep(m);
				if (k !== false)
					parts.push(k === true ? m : k);
				if (k !== true)
					changed = true;
			}
			if (changed && parts.length) {
				const s = new Scope(this);
				s.addNarrowing(name, combineTypes(parts));
				return s;
			}
		} else {
			const k = keep(r);
			if (k !== true) {
				// Non-union binding whose one and only type the guard rejects outright (e.g. `if (x)` where `x`'s whole
				// declared type is `undefined`) -- the branch is provably unreachable, same as real TS's `never` narrowing.
				// A returned `Type` replaces it with that narrower version instead.
				const s = new Scope(this);
				s.addNarrowing(name, k === false ? TS.RefType('never') : k);
				return s;
			}
		}
		return this;
	}

	// Narrows `name` to `target`: union members are filtered by assignability; a non-union binding (or any binding, for an opaque `any` target)
	// is replaced outright when the guard holds. `name` may be a dotted path key.
	narrowTo(name: string, target: Type, sense: boolean, t = this.value(name)): Scope {
		const r = t && resolveOwn(t, this);
		if (!r || isAny(r))
			return this;
		if (r.type === 'union' && !isAny(target))
			return this.narrowValue(name, m => isAssignable(m, target, this) === sense, t);
		if (!sense)
			return this;
		const s = new Scope(this);
		s.addNarrowing(name, target);
		return s;
	}

	toObject() {
		const members: TS.TypeMember[] = [];
		for (const [name, typeAnnotation] of this.values)
			members.push({ kind: 'property', name, typeAnnotation });
		return TS.ObjectType(members);
	}
}
