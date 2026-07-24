/* eslint-disable @typescript-eslint/no-this-alias */
import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Literal } from '../common';
import { Expr, BindingTarget } from './js-parser';
import { Type } from './ts-parser';
import { walk, walkB, hasMod } from './walker';
import { TSoutput } from './tocode';

// ===================================================================
//  Type utilities
// ===================================================================

const PRIMITIVES	= new Set(['any', 'unknown', 'never', 'void', 'number', 'string', 'boolean', 'bigint', 'symbol', 'object', 'undefined', 'null']);
const PRIMITIVES2	= new Set(['never', 'void', 'number', 'string', 'boolean', 'bigint', 'symbol', 'object', 'undefined', 'null']);
const OPAQUE		= new Set(['keyof', 'indexed_access', 'conditional', 'infer', 'mapped', 'this', 'predicate']);

// The subset of `OPAQUE` that's a genuinely unevaluated computation, as opposed to `this`/`predicate` (opaque by design, not a gap).
// In `strict` mode below, either side being one of these fails the comparison instead of auto-passing it.
const OPAQUE_GAP	= new Set(['keyof', 'indexed_access', 'conditional', 'infer', 'mapped']);

const BOXED_PRIMITIVE: Record<string, string> = { string: 'String', number: 'Number', boolean: 'Boolean', bigint: 'BigInt', symbol: 'Symbol' };

// Per-function counts of how many times a recursion's depth budget was actually exhausted (vs. just defensively present).
const depthExhaustion = new Map<string, number>();

export function hitDepthLimit(fn: string): void {
	depthExhaustion.set(fn, (depthExhaustion.get(fn) ?? 0) + 1);
}

export function takeDepthExhaustion(): Map<string, number> {
	try {
		return new Map(depthExhaustion);
	} finally {
		depthExhaustion.clear();
	}
}

const tocode = new TSoutput({newline:'',indent:''});
export function typeKey(t: Type) { return tocode.typeToCode(t); }

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

export function isAny(t: Type)		{ return t.type === 'ref' && (t.name === 'any' || t.name === 'unknown'); }
export function isBoolean(t: Type)	{ return t.type === 'ref' && t.name === 'boolean'; }
export function isString(t: Type)	{ return t.type === 'ref' && t.name === 'string'; }
export function isPrimitive(t: Type) { return t.type === 'ref' && PRIMITIVES2.has(t.name); }
export function isKeyable(t: Type)	{ return t.type === 'ref' && (t.name === 'string' || t.name === 'number' || t.name === 'symbol'); }

interface TypeOfMap {
	string: string;	number: number;	boolean: boolean;
//	bigint: bigint; symbol: symbol; object: object; undefined: undefined; function: undefined;
	bigint: string; symbol: string; object: string; undefined: string; function: string;
	null:		null;
	template:	JS.TemplatePart<Type>[]
}

export function literalType(t: Literal<any>): keyof TypeOfMap {
	return Array.isArray(t.value) ? 'template' : t.value === null ? 'null' : typeof t.value;
}
export function literalTypeOf(e: Expr | undefined): Type | undefined {
	return e?.type === 'literal' ? TS.RefType(literalType(e)) : undefined;
}
export function isLiteral<K extends keyof TypeOfMap>(t: Type|Expr, type: K): t is Literal<TypeOfMap[K]> {
	return t.type === 'literal' && literalType(t) === type;
}

// What `typeof` would report for a value of this type, or undefined when it can't be known statically
export function typeofName(t: Type): string | undefined {
	switch (t.type) {
		case 'literal':				return Array.isArray(t.value) ? 'string' : typeof t.value;
		case 'function':
		case 'constructor':			return 'function';
		case 'array':
		case 'tuple':
		case 'object':				return 'object';
		case 'intersection':		return t.types.some(p => p.type === 'function' || p.type === 'constructor') ? 'function' : 'object';
		case 'ref':					return ['number', 'string', 'boolean', 'bigint', 'symbol', 'undefined'].includes(t.name) ? t.name : t.name === 'null' ? 'object' : undefined;
		default:					return undefined;
	}
}

// A spread (`...T`) contributes no single element value; an optional element (`T?`)'s contributed value type is just `T`, consistent with this
// file not modeling "possibly absent" via `| undefined` for optional members elsewhere either.
export function tupleElementType(te: TS.TupleElement): Type | undefined {
	return te.type === 'spread' ? undefined : te.type === 'optional' || te.type === 'labeled' ? te.element : te;
}

export function bindingNames(t: BindingTarget): string[] {
	return typeof t === 'string' ? [t]
		: t.type === 'object_pattern' ? [...t.properties.flatMap(p => bindingNames(p.value)), ...(t.rest ? [t.rest] : [])]
		: [...t.elements.flatMap(e => e ? bindingNames(e.target) : []), ...(t.rest ? [t.rest] : [])];
}

// De-dupes structurally-identical types and folds what's left into a `union`
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
	if (types.length === 1)
		return types[0];

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

// Merges the `object` parts of an intersection into one flat `object`, keeping any non-object parts alongside it rather than folding them in.
// A key declared by more than one object part becomes the intersection of its own per-part types
// `optional` survives only if every part declaring the key marks it optional, `readonly` if any part does
export function mergeIntersection(t: Type, scope: Scope): Type {
	const r = resolveOwn(t, scope);
	if (r.type !== 'intersection')
		return r;

	const parts = flattenIntersection(r, scope);
	const nonObject:	Type[] = [];
	const otherMembers: TS.TypeMember[] = [];
	const byKey = new Map<string, { types: Type[]; optional: boolean; readonly: boolean }>();

	for (const part of parts) {
		if (part.type === 'object') {
			for (const m of part.members) {
				if (m.type === 'property' && typeof m.key === 'string') {
					const entry = byKey.get(m.key) ?? { types: [], optional: true, readonly: false };
					entry.types.push(m.typeAnnotation);
					entry.optional &&= hasMod(m, 'optional');
					entry.readonly ||= hasMod(m, 'readonly');
					byKey.set(m.key, entry);
				} else {
					otherMembers.push(m);
				}
			}
		} else {
			nonObject.push(part);
		}
	}

	return intersectTypes([TS.ObjectType([
		...[...byKey].map(([key, { types, optional, readonly }]): TS.TypeMember => {
			const modifiers = [...(optional ? ['optional'] : []), ...(readonly ? ['readonly'] : [])];
			return TS.TypeProperty(key, intersectTypes(types), modifiers.length ? modifiers : undefined);
		}),
		...otherMembers,
	]), ...nonObject]);
}

export function collectMembers(t: Type, scope: Scope): TS.TypeMember[] {
	const r = resolveOwn(t, scope);
	return r.type === 'object' ? r.members : r.type === 'intersection' ? r.types.flatMap(t => collectMembers(t, scope)) : [];
}

export function makeNullish(type: Type) {
	if (type.type === 'ref') {
		switch (type.name) {
			case 'bigint':
			case 'number':	return Literal(0);
			case 'boolean':	return Literal(false);
			case 'string':	return Literal('');
		}
	}
	return type;
}

export function withScope<T extends {declScope?: any}>(t: T, scope: Scope): T {
	t.declScope = scope;
	return t;
}
export function declScopeOf<T extends {declScope?: any}>(t: T, scope: Scope) {
	return (t.declScope as Scope) ?? scope;
}
export function ownScope(t: Type, scope: Scope) {
	return t.type === 'ref' ? declScopeOf(t, scope) : scope;
}
export function resolveOwn(t: Type, scope: Scope): Type {
	return resolve(ownScope(t, scope), t);
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
	return isString(t)
		|| isLiteral(t, 'string')
		|| isLiteral(t, 'template')
		|| (r.type === 'union' && r.types.some(t => isStringLike(t, scope)));
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

export function widenLiterals(t: Type, keepBoolean = false): Type {
	return	t.type === 'literal' && t.value !== null && (!keepBoolean || typeof t.value !== 'boolean') ? TS.RefType(typeof t.value)
		:	t.type === 'union' ? combineTypes(t.types.map(m => widenLiterals(m, keepBoolean)))
		:	t;
}

// Replaces type-parameter references with their instantiating arguments (`Foo<string>` -> Foo's body with T := string)
export function substituteType(t: Type, map: Map<string, Type>): Type {
	return walk(t, undefined, undefined, (x, process) =>
		x.type === 'ref' && !x.typeArgs && map.has(x.name) ? map.get(x.name) : process(x)
	) ?? t;
}

// Whether `name` occurs somewhere `inferTypeArgs` would actually descend into -- tells "no argument could ever determine
// this" apart from "an argument should have but didn't" (a real gap). Mirrors `inferTypeArgs`'s recursion shape, not a blanket walk.
export function mentionsTypeParam(t: Type, name: string): boolean {
	return walkB(t, undefined, undefined, (t, process) => {
		switch (t.type) {
			case 'ref':				return t.typeArgs ? process(t) : t.name === name;
			case 'function':
			case 'constructor':		return t.params.some(p => process(p.typeAnnotation, true)) || process(t.returnType, true);
			case 'object':			return t.members.some(m =>
				m.type === 'property' ? process(m.typeAnnotation, true)
				: m.type === 'method' ? process(m.returnType, true)
				: false
			);
			case 'conditional':		return process(t.trueType, true) || process(t.falseType, true);
			case 'array': case 'tuple': case 'intersection': case 'union': case 'predicate':
				return process(t);
			// `keyof`/`indexed_access`/`mapped`/`typeof`/`this`/`template_literal`/`infer`: not positions `inferTypeArgs` inverts.
			default:				return false;
		}
	});
}

function containsInfer(t: Type): boolean {
	return walkB(t, undefined, undefined, (x, process) => x.type === 'infer' || process(x));
}

// Structurally matches `pattern` (an `extendsType` containing `infer` nodes) against `actual`, binding each `infer X` into `out`.
// Three-valued like `conditionalExtends`: `false` only on outright conflict, `undefined` when unresolvable -- never guessed.
function matchInfer(pattern: Type, actual: Type, scope: Scope, out: Map<string, Type>, depth = 6): boolean | undefined {
	if (depth < 0) {
		hitDepthLimit('matchInfer');
		return undefined;
	}
	if (pattern.type === 'infer') {
		if (!out.has(pattern.name))
			out.set(pattern.name, actual);
		return !pattern.constraint || isAssignable(actual, pattern.constraint, scope);
	}
	if (!containsInfer(pattern))
		return isAssignable(actual, pattern, scope);

	const a = normalizeArray(resolve(scope, actual, depth - 1));
	if (pattern.type === 'ref' && pattern.typeArgs) {
		if (pattern.name === 'ReadonlyArray') {
			const patternEl = pattern.typeArgs[0];
			if (a.type === 'ref' && a.name === 'Array' && a.typeArgs?.length)
				return matchInfer(patternEl, a.typeArgs[0], scope, out, depth - 1);
			if (a.type === 'tuple')
				return a.elements.every(e => { const t = tupleElementType(e); return !t || matchInfer(patternEl, t, scope, out, depth - 1) !== false; }) || undefined;
		} else if (pattern.name === 'Array' && a.type === 'tuple' && pattern.typeArgs.length === 1) {
			const patternEl = pattern.typeArgs[0];
			return a.elements.every(e => { const t = tupleElementType(e); return !t || matchInfer(patternEl, t, scope, out, depth - 1) !== false; }) || undefined;
		}
		// Checks the *unresolved* `actual` for a same-named ref first -- `scope.resolve` would eagerly expand it, losing the
		// "named `Promise<number>`" identity this needs; only falls back to the resolved form for an alias needing one unwrap.
		const named = actual.type === 'ref' && actual.typeArgs && actual.name === pattern.name ? actual
			: a.type === 'ref' && a.typeArgs && a.name === pattern.name ? a
			: undefined;
		if (!named)
			return undefined;	// unresolved/differently-named: not confidently "doesn't extend" either
		return pattern.typeArgs.length === named.typeArgs!.length
			&& pattern.typeArgs.every((p, i) => matchInfer(p, named.typeArgs![i], scope, out, depth - 1) !== false)
			|| undefined;
	}
	if (pattern.type === 'array') {
		// `a` was normalized to `Array<T>`/`ReadonlyArray<T>` above -- no longer `'array'` itself -- so this reads its element
		// back out through `arrayLikeElement` instead of `a.element` directly.
		const ael = arrayLikeElement(a);
		return ael !== undefined ? matchInfer(pattern.element, ael, scope, out, depth - 1)
			: a.type === 'tuple' ? a.elements.every(e => {
				const t = tupleElementType(e);
				return t && matchInfer(pattern.element, t, scope, out, depth - 1) !== false;
			}) || undefined
			: false;
	}
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
			if (!lead.every((p, i) => {
				const at = tupleElementType(a.elements[i]), pt = tupleElementType(p);
				return !at || !pt || matchInfer(pt, at, scope, out, depth - 1) !== false;
			}))
				return false;
			if (!containsInfer(last.argument))
				return true;
			const rest = a.elements.slice(lead.length).map(tupleElementType);
			return rest.every((t): t is Type => !!t) && matchInfer(last.argument, TS.ArrayType(combineTypes(rest)), scope, out, depth - 1) !== false || undefined;
		}
		return a.elements.length === pattern.elements.length
			&& a.elements.every((e, i) => {
				const at = tupleElementType(e), pt = tupleElementType(pattern.elements[i]);
				return !at || !pt || matchInfer(pt, at, scope, out, depth - 1) !== false;
			})
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
			if (m.type !== 'property' || typeof m.key !== 'string' || !containsInfer(m.typeAnnotation))
				continue;
			// `lookupMember` gets its own fresh budget, not `matchInfer`'s remaining `depth` -- unrelated recursions, same
			// reasoning as `lookupMember`'s own `resolve()` call and `isAssignable`'s per-member `lookupMember` call.
			const t = lookupMember(a, m.key, scope);
			if (!t)
				return hasMod(m, 'optional') ? undefined : false;
			if (matchInfer(m.typeAnnotation, t, scope, out, depth - 1) === false)
				return false;
		}
		return true;
	}
	return undefined;
}

// JS.ParamList to TS.ParamList; a defaulted parameter counts as optional
export function FixParams(params: JS.Params<any>): TS.Params {
	return {
		params: params.params.filter(p => p.key !== 'this').map((p): TS.Param => ({
			key:			typeof p.key === 'string' ? p.key : '_',
			modifiers:		!!hasMod(p, 'optional') || !!p.default ? ['optional'] : [],
			typeAnnotation: p.typeAnnotation as Type ?? literalTypeOf(p.default),
			default:		p.default
		})),
		rest: params.rest as JS.Rest<Type>
	};
}
// `declaredReturnType`: the function/arrow's own explicit annotation, captured *before* `checkFunctionBody` runs and overwrites
// `params.returnType` with a body-inferred type for its own internal checking -- wrong for this value's type as seen externally.
export function FixSig(params: JS.CallSig<any>, defaultRet?: Type, declaredReturnType?: Type): TS.CallSig {
	return { ...FixParams(params),
		returnType: declaredReturnType ?? params.returnType as Type ?? defaultRet,
		typeParams: params.typeParams as TS.TypeParam[]
	};
}

// Just enough built-in array members that element types survive `pop()!` etc.
function arrayMethod(elem: Type, prop: string): Type | undefined {
	// `map`'s result depends on the callback's own return type, not a fixed formula of `elem` -- needs a real generic signature, or it silently
	// falls back to `ANY`, which can then poison a *constrained* generic elsewhere with a confusing error nowhere near the real cause.
	if (prop === 'map')
		return TS.FunctionType([
				JS.Param('callback', TS.FunctionType([
					JS.Param('v', elem),
					JS.Param('i', NUMBER),
					JS.Param('arr', TS.ArrayType(elem))
				], TS.RefType('U'))),
				JS.Param('thisArg', ANY, ['optional']),
			],
			TS.ArrayType(TS.RefType('U')),
			[{ name: 'U' }]
		);

	// Real `.flat()` is a recursive conditional type keyed off an explicit depth argument; only the common argument-less (depth-1) case is
	// modeled -- unwrap one level of nesting when `elem` is itself an array. An unmodeled explicit depth falls back to the methods below.
	if (prop === 'flat' && elem.type === 'array')
		return { type: 'function', params: [], rest: { key: 'args', typeAnnotation: { type: 'array', element: NUMBER } }, returnType: { type: 'array', element: elem.element } };

	// Real overloads (bare 1-arg form defaults the accumulator to `elem`, seeded 2-arg form to `initialValue`'s own type) collapse
	// into one signature with `initialValue` optional and `U` defaulting to `elem` -- an approximation, not exact for every case.
	if (prop === 'reduce' || prop === 'reduceRight') {
		const U = TS.RefType('U');
		return TS.FunctionType(
			[
				JS.Param('callback', TS.FunctionType([
					JS.Param('acc', U),
					JS.Param('v', elem),
					JS.Param('i', NUMBER),
					JS.Param('arr', TS.ArrayType(elem))
				], U)),
				JS.Param('initialValue', U, ['optional']),
			],
			U,
			[{ name: 'U', default: elem }]
		);
	}

	// Collapsed into one rest-based signature: this checker's overload picker always fails whenever any argument is a spread
	// (`arr.splice(i, n, ...items)`), so a real 2-overload `splice` would otherwise never match a spread call at all.
	if (prop === 'splice')
		return TS.FunctionType(
			{ params: [JS.Param('start', NUMBER), JS.Param('deleteCount', NUMBER, ['optional'])], rest: JS.Rest('items', TS.ArrayType(elem)) },
			TS.ArrayType(elem)
		);

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
	// A bare `ref` stamped with its own `declScope` resolves there instead of in `scope` -- the caller's chain may shadow it
	// (e.g. DOM's `Element`). `resolve()` itself stays unaware of `declScope`; this is the one bounded place that consults it.
	t = resolveOwn(t, scope);
	if (prop === 'length' && (t.type === 'array' || t.type === 'tuple' || isString(t)))
		return NUMBER;
	if (prop === 'constructor')
		return ANY;		// every object has one; its shape isn't modeled

	switch (t.type) {
		// `arrayMethod` first: for `filter`/`find`/`findLast`/`every` it's genuinely more precise than the real 2-overload lib.es5
		// interface, whose type-guard-predicate overload always wins overload selection here even for a plain boolean callback.
		case 'array':
			return arrayMethod(t.element, prop) ?? lookupMember(TS.RefType('Array', [t.element]), prop, scope, depth - 1);

		 case 'tuple': {
			const elem = combineTypes(t.elements.map(tupleElementType).filter((x): x is Type => !!x));
			return arrayMethod(elem, prop) ?? lookupMember(TS.RefType('Array', [elem]), prop, scope, depth - 1);
		 }

		case 'object': {
			const ms = t.members.filter(m => (m.type === 'property' || m.type === 'method') && m.key === prop);
			if (ms.length > 1) {
				// Real overloads (every member here must be a same-named `method`) group into one multi-signature callable,
				// the same shape `hoist` builds for free-function overloads, so `typeOf`'s call/new handling resolves both identically.
				return ms.every(m => m.type === 'method')
					? TS.ObjectType(ms.map((m): TS.TypeMember => TS.TypeCall(withScope(TS.CallSig({params: m.params, rest: m.rest}, m.returnType ?? ANY, m.typeParams), m.declScope as Scope))))
					: ANY;
			}
			const m = ms[0];
			if (m?.type === 'property')
				return m.typeAnnotation;
			if (m?.type === 'method')
				// `declScope` carried through: this class's own method, consulted from a different module, still resolves
				// its declared param/return types via that scope.
				return withScope(TS.FunctionType(JS.Params(m.params, m.rest), m.returnType ?? ANY, m.typeParams), m.declScope as Scope);
			// Both are fallbacks, tried only once no member is named `prop` -- skipped on a per-part intersection lookup so a
			// `Record<string,X> & {realMethod(){}}` intersection's index signature can't shadow the other part's real member.
			if (skipObjectFallback)
				return undefined;
			// `Object.prototype`'s own members are checked after the index signature, so a type that declares its own override
			// (e.g. a custom `toString(x?: string): string`) still wins.
			return t.members.find(m => m.type === 'index')?.typeAnnotation ?? objectPrototypeMember(prop);
		}
		case 'intersection': {
			const matches: Type[] = [];
			for (const part of t.types) {
				const m = lookupMember(part, prop, scope, depth - 1, true);
				if (m)
					matches.push(m);
			}
			// No part declared `prop` as a real member -- an index signature on any part still legitimately covers this key
			// (real TS does too), tried before falling back to `Object.prototype`.
			if (!matches.length) {
				if (skipObjectFallback)
					return undefined;
				for (const part of t.types) {
					const r = resolveOwn(part, scope);
					const idx = r.type === 'object' ? r.members.find(m => m.type === 'index') : undefined;
					if (idx)
						return idx.typeAnnotation;
				}
				return objectPrototypeMember(prop);
			}
			if (matches.length === 1)
				return matches[0];
			// Declaration merging is the common reason more than one part declares `prop`, usually with the *identical* type --
			// dedupe first, which collapses back to the `matches.length === 1` case and keeps single-declaration behavior untouched.
			const distinct = [...new Map(matches.map(m => [typeKey(m), m])).values()];
			if (distinct.length === 1)
				return distinct[0];
			// Genuinely different same-named methods across parts is real TS's cross-file overload-merging shape -- combine into
			// one multi-signature set, same as the `object` case; flatten each match's own single-or-already-merged shape first.
			const sigs: TS.CallSig[] = [];
			let allSigs = true;
			for (const m of distinct) {
				if (m.type === 'function') {
					sigs.push(m);
				} else if (m.type === 'object' && m.members.length && m.members.every(mem => mem.type === 'call')) {
					sigs.push(...m.members);
				} else {
					allSigs = false;
					break;
				}
			}
			if (allSigs)
				return TS.ObjectType(sigs.map((s): TS.TypeMember => ({ type: 'call', params: s.params, rest: s.rest, returnType: s.returnType, typeParams: s.typeParams })));
			// A plain property narrowed by more than one part at once (`SomeUnion & {kind:'x'}`'s own `kind`) needs every part's
			// constraint applied together -- unlike class-inheritance override, `&`'s parts have no such order.
			return TS.IntersectionType(distinct);
		}
		case 'union': {
			const parts = t.types.map(p => lookupMember(p, prop, scope, depth - 1));
			return parts.every(p => !!p) ? combineTypes(parts as Type[]) : undefined;
		}
		// A primitive value auto-boxes for member access (`"x".toUpperCase()`) -- delegates to its boxed lib.es5 interface, same
		// idea as `array` delegating to `Array<T>` above.
		case 'ref': {
			const boxed = BOXED_PRIMITIVE[t.name];
			return boxed ? lookupMember(TS.RefType(boxed), prop, scope, depth - 1) : undefined;
		}
		default:
			return undefined;
	}
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

// `T[]` really is `Array<T>` (a `readonly: true` one `ReadonlyArray<T>`) -- turns the structural `'array'` node into the real named
// ref wherever it's compared, instead of bridging two representations at every call site.
function normalizeArray(t: Type): Type {
	return t.type === 'array' ? TS.RefType(t.readonly ? 'ReadonlyArray' : 'Array', [t.element]) : t;
}
// The element type of an `Array<T>`/`ReadonlyArray<T>` ref (after `normalizeArray`, a real array value's type always arrives this way).
function arrayLikeElement(t: Type): Type | undefined {
	return t.type === 'ref' && (t.name === 'Array' || t.name === 'ReadonlyArray') && t.typeArgs?.length ? t.typeArgs[0] : undefined;
}

// `dstScope` resolves names in `dst`'s own structure (distinct from `scope`, which resolves `src`'s) -- same scope almost
// always, but differs for a `dst` from another module's signature. Every recursive call passes each value's own origin scope.
export function isAssignable(src: Type, dst: Type, scope: Scope, dstScope: Scope = scope, strict = false, depth = 10): boolean {
	function recurse(src: Type, dst: Type, depth: number): boolean {
		if (depth < 0) {
			hitDepthLimit('isAssignable');
			return true;
		}
		src = normalizeArray(src);
		dst = normalizeArray(dst);

		// `Array<T>`/`ReadonlyArray<T>` matched by name -- `Array` -> `ReadonlyArray` is the one real, one-directional variance. Checked
		// before the same-name fast path below, which can't see `T` (the real lib.es5 interface's `T`-members are all methods).
		if (src.type === 'ref' && dst.type === 'ref' && (src.name === 'Array' || src.name === 'ReadonlyArray') && (dst.name === 'Array' || dst.name === 'ReadonlyArray')) {
			if (src.name === 'ReadonlyArray' && dst.name === 'Array')
				return false;
			const sa = src.typeArgs ?? [], da = dst.typeArgs ?? [];
			return sa.length !== da.length || sa.every((a, i) => recurse(a, da[i], depth - 1));
		}

		if (src.type === 'ref' && dst.type === 'ref' && src.name === dst.name) {
			const sa = src.typeArgs ?? [], da = dst.typeArgs ?? [];
			if (sa.length === da.length && sa.every((a, i) => recurse(a, da[i], depth - 1)))
				return true;	// same named type, pairwise-compatible arguments: skip the structural comparison
		}

		// A tuple has no name of its own to match by, so its cross-comparison against an array-like ref stays structural --
		// same leniency the old dedicated `dst.type === 'array'` branch had, just keyed off the ref's type arg instead of `.element`.
		if (src.type === 'tuple') {
			const el = arrayLikeElement(dst);
			if (el)
				return src.elements.every(e => { const t = tupleElementType(e); return !t || recurse(t, el, depth - 1); });
		}
		if (dst.type === 'tuple') {
			// an inferred array literal has lost its element positions: compare loosely, either direction
			const el = arrayLikeElement(src);
			if (el)
				return dst.elements.every(e => { const t = tupleElementType(e); return !t || recurse(el, t, depth - 1) || recurse(t, el, depth - 1); });
		}

		// The global lib `Function` interface -- every function/constructor value satisfies it structurally, but this checker's own
		// `'function'`/`'constructor'` nodes don't carry `Function.prototype`'s members, so the structural check below would reject it.
		if (dst.type === 'ref' && dst.name === 'Function' && (src.type === 'function' || src.type === 'constructor'))
			return true;

		// Opportunistic early attempt, before the unconditional `resolve()` calls below destroy `src`'s ref identity: if `dst` is
		// already a union, try each member against `src` as-is first, so a same-name fast path can fire (`rational extends number | rational`).
		if (dst.type === 'union' && dst.types.some(t => t === src || recurse(src, t, depth - 1)))
			return true;

		// `resolve()` gets a fresh budget here, not `depth` -- see `lookupMember`'s identical pattern.
		// NOT `resolveOwn`: `src.type === 'intersection'` checks each part individually, never the combined shape -- known gap, unfixed.
		src = resolve(scope, src);
		dst = resolve(dstScope, dst);

		if (src === dst || isAny(src) || isAny(dst))
			return true;

		if (src.type === 'ref' && (src.name === 'never' || !PRIMITIVES.has(src.name)))
			return true;		// unresolved named source (import/global/type parameter): lenient

		if (OPAQUE.has(src.type) || OPAQUE.has(dst.type))
			return !strict || (!OPAQUE_GAP.has(src.type) && !OPAQUE_GAP.has(dst.type));

		if (src.type === 'union')
			return src.types.every(t => recurse(t, dst, depth - 1));
		if (dst.type === 'union') {
			// the identity test makes a narrowed union (whose members are the original alias's own nodes) trivially assignable back to it
			if (dst.types.some(t => t === src || recurse(src, t, depth - 1)))
				return true;
			// A union hiding inside `src` behind an intersection (`(A|B) & C`) isn't visible to the identity test above, which narrows
			// `dst` to one candidate first -- fall back to trying each of `src`'s parts against the full, unnarrowed `dst` union.
			if (src.type === 'intersection' && src.types.some(t => recurse(t, dst, depth - 1)))
				return true;
			return false;
		}

		if (dst.type === 'intersection')
			return dst.types.every(t => recurse(src, t, depth - 1));
		if (src.type === 'intersection' && dst.type !== 'object')
			return src.types.some(t => recurse(t, dst, depth - 1));

		if (dst.type === 'literal')
			return src.type === 'literal'
				? src.value === dst.value	// TODO: check template_literal equality
				: src.type === 'ref' && dst.value !== null && src.name === typeof dst.value;	// widened source: lenient
		if (src.type === 'literal')
			return dst.type === 'ref' && (!PRIMITIVES.has(dst.name) || dst.name === (src.value === null ? 'null' : typeof src.value));
//		if (src.type === 'template_literal' || dst.type === 'template_literal')
//			return (src.type === 'template_literal' || isString(src))
//				&& (dst.type === 'template_literal' || isString(dst));

		// `dst`/`src` can no longer be `'array'` here -- `normalizeArray` plus `resolve()` above already expanded that into the real
		// lib.es5 structural body. Only tuple-vs-tuple is left to handle structurally.
		if (dst.type === 'tuple') {
			return src.type === 'tuple'
				&& src.elements.length >= dst.elements.filter(e => !(e.type === 'optional' || e.type === 'spread' || (e.type === 'labeled' && e.optional))).length
				&& src.elements.every((e, i) => {
					const st = tupleElementType(e), dt = dst.type === 'tuple' && dst.elements[i] ? tupleElementType(dst.elements[i]) : undefined;
					return !st || !dt || recurse(st, dt, depth - 1);
				});
		}

		if (dst.type === 'function' || dst.type === 'constructor') {
			if (src.type !== dst.type)
				return src.type === 'object' && src.members.some(m => m.type === (dst.type === 'constructor' ? 'construct' : 'call'));
			if (!dst.returnType || !src.returnType)
				return true;	// missing return type (e.g. an unmodeled class method): lenient
			// parameters deliberately unchecked (bivariance noise); returns covariant, void-dst absorbs anything
			return dst.returnType.type === 'ref' && dst.returnType.name === 'void'
				|| recurse(src.returnType, dst.returnType, depth - 1);
		}

		if (dst.type === 'object') {
			if (src.type === 'ref') {
				// A primitive auto-boxes for structural checks too, not just member access -- otherwise `string` could never
				// structurally satisfy `Iterable<T>`/`ArrayLike<T>` (e.g. `Array.from(str)`).
				const boxed = BOXED_PRIMITIVE[src.name];
				return boxed ? recurse(TS.RefType(boxed), dst, depth - 1) : !PRIMITIVES.has(src.name);	// unresolved nominal: lenient
			}
			if (src.type === 'function' || src.type === 'constructor')
				return  dst.members.every(m => (m.type !== 'property' && m.type !== 'method') || hasMod(m, 'optional'));
			if (src.type === 'object' || src.type === 'intersection' || src.type === 'tuple')
				return dst.members.every(m => {
					if (m.type !== 'property' || typeof m.key !== 'string')
						return true;		// methods/call/index/computed: lenient
					// `lookupMember` gets its own fresh budget, not `recurse`'s remaining `depth` -- same reasoning as
					// `lookupMember`'s own `resolve()` call.
					const got = lookupMember(src, m.key, scope);
					// an optional property also accepts undefined; absence only counts against a sealed source
					return got ? recurse(got,
						hasMod(m, 'optional') ? TS.UnionType([m.typeAnnotation, UNDEFINED]) : m.typeAnnotation, depth - 1) : hasMod(m, 'optional') || !sealed(src, scope) || recurse(UNDEFINED, m.typeAnnotation,
						depth - 1
					);
				});
			return false;
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


// Infers a generic call's type args by structurally matching each param's declared type against the argument's (first binding wins).
// `declScope` resolves `paramT`'s own names (the signature's declaring module); `scope` resolves `argT`'s (the call site's).
export function inferTypeArgs(paramT: Type, argT: Type, tparams: ReadonlyMap<string, TS.TypeParam>, out: Map<string, Type>, scope: Scope, depth = 0, declScope: Scope = scope): void {
	if (depth > 6)
		return;
	if (paramT.type === 'ref' && !paramT.typeArgs && tparams.has(paramT.name)) {
		if (!out.has(paramT.name)) {
			const tp = tparams.get(paramT.name)!;
			// Widening a literal argument (`'string'` -> `string`) is the usual default, but not when the type param's constraint is
			// itself a union of literals (`K extends 'string' | 'number'`) -- the widened form would fall outside the constraint.
			out.set(paramT.name, tp.const || tp.constraint?.type === 'keyof' || (!!tp.constraint && isLiteralOnly(resolveOwn(tp.constraint, scope), scope) === true) ? argT : widenLiterals(argT));
		}
		return;
	}
	const a = resolveOwn(argT, scope);
	if (paramT.type === 'array') {
		if (a.type === 'array') {
			inferTypeArgs(paramT.element, a.element, tparams, out, scope, depth + 1, declScope);
		} else if (a.type === 'tuple') {
			a.elements.forEach(el => {
				const t = tupleElementType(el);
				if (t)
					inferTypeArgs(paramT.type === 'array' ? paramT.element : ANY, t, tparams, out, scope, depth + 1, declScope);
			});
		// e.g. an argument built from `x ?? y` where both branches independently resolve to compatible-but-not-deduplicated array types
		// (`number[] | number[]`) -- distribute over the union rather than giving up (the first member to actually match wins, per `out`'s guard).
		} else if (a.type === 'union') {
			a.types.forEach(m => inferTypeArgs(paramT, m, tparams, out, scope, depth + 1, declScope));
		}
	} else if (paramT.type === 'ref' && paramT.typeArgs) {
		if (paramT.name === 'Array' && paramT.typeArgs.length === 1 && a.type === 'array') {
			inferTypeArgs(paramT.typeArgs[0], a.element, tparams, out, scope, depth + 1, declScope);
		} else if (paramT.name === 'PromiseLike' && paramT.typeArgs.length === 1 && (argT.type === 'union' ? argT.types : [argT]).some(m => asPromiseRef(m, scope))) {
			// `.then`'s 2nd alternative: the callback's return may be a union with only *some* members Promise-shaped (e.g.
			// `Font | FontGroup | Promise<Font> | undefined`) -- `awaitType` distributes over the union, unwrapping just those.
			// Checked on `argT`, not the resolved `a`: `resolveOwn` would expand a bare `Promise<X>` into its structural
			// body, losing the ref identity `asPromiseRef` needs.
			inferTypeArgs(paramT.typeArgs[0], awaitType(argT, scope), tparams, out, scope, depth + 1, declScope);
		} else {
			// Prefer the argument's own (unresolved) named type over its fully-expanded structural shape -- `resolve()` eagerly substitutes a
			// generic ref's type params into its body, losing the "this was Polynomial<number>" name/typeArgs identity `paramT` needs to match.
			const named = argT.type === 'ref' && argT.typeArgs && argT.name === paramT.name ? argT
				: a.type === 'ref' && a.typeArgs && a.name === paramT.name ? a
				: undefined;
			if (named) {
				paramT.typeArgs.forEach((p, i) => {
					const t = named.typeArgs![i];
					if (t)
						inferTypeArgs(p, t, tparams, out, scope, depth + 1, declScope);
				});
			} else {
				// A generic alias wrapping `T` (e.g. `Testable<T> = T extends primitive ? T : T & Equal<T>`) -- unfold one level and recurse,
				// so whichever case below actually contains `T` gets a chance to match. `paramT.name` is declared in `declScope`, not `scope`.
				const entry = declScope.type(paramT.name);
				if (entry?.typeParams?.length)
					inferTypeArgs(substituteType(entry.type, new Map(entry.typeParams.map((p, i) => [p.name, paramT.typeArgs![i] ?? p.default ?? ANY]))), argT, tparams, out, scope, depth + 1, declScope);
			}
		}
	} else if (paramT.type === 'intersection') {
		// Same reasoning as `union` below: `T` may be embedded in just one part -- trying every part is safe, only the matching one infers anything.
		for (const p of paramT.types)
			inferTypeArgs(p, argT, tparams, out, scope, depth + 1, declScope);

	} else if (paramT.type === 'conditional') {
		// Which branch `T` is in depends on `checkType extends extendsType`, not knowable here since `T` may itself be `checkType` -- try both.
		inferTypeArgs(paramT.trueType, argT, tparams, out, scope, depth + 1, declScope);
		inferTypeArgs(paramT.falseType, argT, tparams, out, scope, depth + 1, declScope);

	} else if (paramT.type === 'function' || paramT.type === 'constructor') {
		// A callable value built via `Object.assign(fn, {...})` (e.g. `rational`) comes out as an intersection, not a bare
		// `'function'`/`'constructor'` node -- `flattenIntersection` finds the actual callable part, as `narrow()` also does.
		const fn = flattenIntersection(a, scope).find((p): p is typeof paramT => p.type === paramT.type);
		if (fn) {
			paramT.params.forEach((p, i) => {
				const q = fn.params[i];
				if (p.typeAnnotation && q?.typeAnnotation)
					inferTypeArgs(p.typeAnnotation, q.typeAnnotation, tparams, out, scope, depth + 1, declScope);
			});
			if (paramT.returnType && fn.returnType)
				inferTypeArgs(paramT.returnType, fn.returnType, tparams, out, scope, depth + 1, declScope);
		}
	} else if (paramT.type === 'object') {
		for (const m of paramT.members) {
			if ((m.type !== 'property' && m.type !== 'method') || typeof m.key !== 'string')
				continue;
			if (m.type === 'property') {
				const t = lookupMember(a, m.key, scope);
				if (t)
					inferTypeArgs(m.typeAnnotation, t, tparams, out, scope, depth + 1, declScope);
			} else if (m.type === 'method') {
				// Same shape as `function`/`constructor` above -- `adapter0<T,D>`-style interfaces often carry `T`/`D` only in a method's own signature.
				const t = lookupMember(a, m.key, scope);
				if (t?.type === 'function') {
					m.params.forEach((p, i) => {
						const q = t.params[i];
						if (p.typeAnnotation && q?.typeAnnotation)
							inferTypeArgs(p.typeAnnotation, q.typeAnnotation, tparams, out, scope, depth + 1, declScope);
					});
					if (m.returnType)
						inferTypeArgs(m.returnType, t.returnType ?? ANY, tparams, out, scope, depth + 1, declScope);
				}
			}
		}
	} else if (paramT.type === 'predicate') {
		// Only an argument that's *itself* an inferred/declared predicate carries a usable asserted type (e.g. `.filter`'s `(v) => v is S`
		// matched against a callback whose own inferred return came out `v is <narrowed>`) -- a plain `boolean` callback leaves `S` uninferred.
		if (a.type === 'predicate' && paramT.assertedType && a.assertedType)
			inferTypeArgs(paramT.assertedType, a.assertedType, tparams, out, scope, depth + 1, declScope);

	} else if (paramT.type === 'union') {
		// A bare `T` alternative matches the whole argument too coarsely when a more structural alternative (`TypeT<K>`) could
		// drill into K's position instead -- so non-bare alternatives are tried first; bare ones only fill in what's still unbound.
		const isBare = (t: Type) => t.type === 'ref' && !t.typeArgs && tparams.has(t.name);
		for (const t of paramT.types)
			if (!isBare(t))
				inferTypeArgs(t, argT, tparams, out, scope, depth + 1, declScope);
		for (const t of paramT.types)
			if (isBare(t))
				inferTypeArgs(t, argT, tparams, out, scope, depth + 1, declScope);
	}
}

export function wrapType(t: Type, names: Set<string>, name: string) {
	return t.type === 'ref' && names.has(t.name) ? t : TS.RefType(name, [t]);
}

// Peels through plain ref aliases one substitution at a time, looking for a literal `Promise<X>` ref -- unlike
// `scope.resolve`, which would expand straight into Promise's structural body and lose the "this was a Promise" identity.
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

// A callable candidate reachable through any nesting of unions/intersections/overload-objects -- used below to dig
// out `.then`'s own signature regardless of how many lib files' worth of `Promise<T>` declaration merging it took.
function findFunctionType(t: Type, scope: Scope): TS.CallSig | undefined {
	const r = resolveOwn(t, scope);
	if (r.type === 'function')
		return r;
	if (r.type === 'object')
		return r.members.find((m): m is Extract<TS.TypeMember, { type: 'call' }> => m.type === 'call');
	if (r.type === 'union' || r.type === 'intersection') {
		for (const m of r.types) {
			const f = findFunctionType(m, scope);
			if (f)
				return f;
		}
	}
	return undefined;
}

// `Awaited<T>` distributes over a union (e.g. `string | Promise<string>`) -- each member is awaited on its own, since
// the union as a whole is never itself a literal `Promise<X>` ref for `asPromiseRef` to match.
export function awaitType(t: Type, scope: Scope): Type {
	const r = resolveOwn(t, scope);
	if (r.type === 'union')
		return combineTypes(r.types.map(x => awaitType(x, scope)));
	const p = asPromiseRef(t, scope);
	if (p)
		return p.typeArgs![0];
	// `Promise<T>`'s own interface is routinely split across multiple lib files (`lib.es5.d.ts`'s `.then`/`.catch`,
	// `lib.es2018.promise.d.ts`'s `.finally`) -- once ref identity is lost, a genuine Promise value structurally
	// resolves to an *intersection* of those pieces, not a bare object, which `asPromiseRef` alone can't recognize.
	// Fall back to reading `T` straight off `.then`'s own `onfulfilled` parameter, present in every such split.
	if (r.type === 'object' || r.type === 'intersection') {
		const onfulfilled = findFunctionType(lookupMember(r, 'then', scope) ?? ANY, scope)?.params[0]?.typeAnnotation;
		const value = onfulfilled && findFunctionType(onfulfilled, scope)?.params[0]?.typeAnnotation;
		if (value)
			return value;
	}
	return r;
}

export function unwrapIfAsync(t: Type, scope: Scope, async: boolean|undefined): Type {
	return async ? awaitType(t, scope) : t;
}

export function wrapReturnIfAsync(t: Type, scope: Scope, async: boolean|undefined): Type {
	return !async || asPromiseRef(t, scope) ? t : TS.RefType('Promise', [t]);
}

// The `property`/`method` member (the only kinds carrying `modifiers`) named `key` in `members`, if any.
function findTypeMember(members: TS.TypeMember[], key: string): TS.TypeMember & { modifiers?: string[] } | undefined {
	return members.find(m => (m.type === 'property' || m.type === 'method') && m.key === key);
}

export function memberOptional(t: Type, prop: string, scope: Scope, depth = 6): boolean {
	return memberOptionalState(t, prop, scope, depth) === 'optional';
}

// `undefined` = `prop` isn't declared by this part at all -- only meaningful within an intersection, where a part
// that doesn't mention `prop` imposes no constraint on it and must neither force it required nor count as optional.
function memberOptionalState(t: Type, prop: string, scope: Scope, depth: number): 'optional' | 'required' | undefined {
	t = resolveOwn(t, scope);
	if (t.type === 'object') {
		const m = findTypeMember(t.members, prop);
		return m ? (hasMod(m, 'optional') ? 'optional' : 'required') : undefined;
	}
	if (t.type !== 'intersection')
		return undefined;
	if (depth <= 0) {
		hitDepthLimit('memberOptional');
		return undefined;
	}
	// `prop` is optional in `A & B` only if every part that declares it marks it optional -- one part requiring it
	// makes the combined type require it too, matching `lookupMember`'s own intersection case.
	let anyOptional = false;
	for (const p of t.types) {
		const s = memberOptionalState(p, prop, scope, depth - 1);
		if (s === 'required')
			return 'required';
		anyOptional ||= s === 'optional';
	}
	return anyOptional ? 'optional' : undefined;
}

// Tags every `ref`/signature reachable from `t` with `scope`, mutating in place (`mapObjectVoid`, freshly-built nodes only).
// Skips one that already carries a scope, so re-stamping an already-tagged structure is a no-op. Delegates traversal to `walk`.
export function stampScope<T extends Type>(t: T, scope: Scope): T {
	walkB(t, undefined, undefined,
		(x, process) => {
			// Primitives resolve the same everywhere -- stamping them would only add dead weight and dedup-key noise for no gain.
			if (x.type === 'ref') {
				if (!x.declScope && !PRIMITIVES.has(x.name))
					x.declScope = scope;
			} else if (x.type === 'function' || x.type === 'constructor') {
				x.declScope ??= scope;
			}
			return process(x);
		},
		(m, process) => {
			if (m.type === 'method' || m.type === 'call' || m.type === 'construct')
				m.declScope ??= scope;
			return process(m);
		}
	);
	return t;
}

// Stamps a `CallSig`-shaped object's own params/rest/return type -- for callers stamping a freshly-built signature directly
// (a bare `TS.CallSig`, e.g. a hoisted free function's, isn't itself a `Type` node, so `stampScope`/`walk` alone can't take it).
export function stampSig<T extends TS.CallSig>(sig: T, scope: Scope): T {
	// Also tags the signature itself (see `withScope`) -- a bare interface/type-literal method has no other declScope
	// source (unlike a hoisted free function/class method, which already gets one before `stampSig` ever sees it).
	sig.declScope ??= scope;
	sig.params.forEach(p => p.typeAnnotation && stampScope(p.typeAnnotation as Type, scope));
	if (sig.rest?.typeAnnotation)
		stampScope(sig.rest.typeAnnotation as Type, scope);
	if (sig.returnType)
		stampScope(sig.returnType, scope);
	// A type param's own `constraint`/`default` need it too -- otherwise `inferTypeArgs`'s `isLiteralOnly(tp.constraint, ...)`
	// check (does this constraint restrict to a union of literals?) can't resolve a constraint declared in this module but
	// invisible from the caller's own scope, and silently widens a literal argument that should have stayed narrow.
	sig.typeParams?.forEach(p => {
		if (p.constraint)
			stampScope(p.constraint as Type, scope);
		if (p.default)
			stampScope(p.default as Type, scope);
	});
	return sig;
}

// `instance` is `new C(...)`/`this`'s type; `value` is the class binding's type (construct sig ∩ static members).
// `scope`: the class's declaring scope, stamped onto every result `ref` so a member resolved elsewhere still uses it.
export function classShapes(c: TS.Class, scope: Scope): { instance: Type; value: Type } {
	const members:			TS.TypeMember[] = [];
	const staticMembers:	TS.TypeMember[] = [];
	let ctorParams:			TS.Params | undefined;

	for (const m of c.body) {
		if (m.type === 'index_signature') {
			members.push(TS.TypeIndex(m.paramName, m.paramType, m.typeAnnotation));
			continue;
		}
		if (!('key' in m) || typeof m.key !== 'string')
			continue;

		const list = hasMod(m, 'static') ? staticMembers : members;
		switch (m.type) {
			case 'field':
				list.push(TS.TypeProperty(m.key, (m.typeAnnotation as Type) ?? ANY, m.modifiers));
				break;
			case 'method':
				if (m.key === 'constructor') {
					ctorParams = FixParams(m);
					// A parameter-property modifier is anything but the unrelated `'optional'` tag.
					for (const p of m.params)
						if (p.modifiers?.some(x => x !== 'optional') && typeof p.key === 'string')
							members.push(TS.TypeProperty(p.key, p.typeAnnotation ?? literalTypeOf(p.default) ?? ANY, m.modifiers));
				} else {
					list.push(TS.TypeMethod(m.key, withScope(FixSig(m, ANY), scope), m.modifiers));
				}
				break;
			case 'get':
				list.push(TS.TypeProperty(m.key, m.returnType ?? ANY));
				break;
			case 'set':
				if (!list.some(x => x.type === 'property' && x.key === m.key))
					list.push(TS.TypeProperty(m.key, m.params[0]?.typeAnnotation ?? ANY));
				break;
		}
	}
	const obj = TS.ObjectType(members);
	// a base the checker can't model (mixin call, namespace member, imported class) leaves the instance unsealed; likewise an inherited constructor accepts any arguments.
	// Own members come first: lookupMember's first match implements override precedence
	const superType: Type | undefined =
			c.superClass?.type === 'identifier' ? TS.RefType(c.superClass.name)
		:	c.superClass?.type === 'instantiation' && c.superClass.expression.type === 'identifier' ? TS.RefType(c.superClass.expression.name, c.superClass.typeArgs as Type[])
		:	c.superClass ? ANY : undefined;
	const instance = superType ? TS.IntersectionType([obj, superType]) : obj;
	if (!ctorParams)
		ctorParams = {params: [], rest: c.superClass ? JS.Rest('args', TS.ArrayType(ANY)) : undefined};
	// The named ref carries its own type params back as its own typeArgs (`Box<T>` -> `new(...): Box<T>`) -- without this,
	// a bare `RefType(c.name)` never mentions `T`, so `new Box<number>(...)` produced a `Box` with no type args at all.
	const ctor:		Type = {
		type: 'constructor',
		...withScope(TS.CallSig(ctorParams, c.name ? TS.RefType(c.name, c.typeParams?.map(p => TS.RefType(p.name))) : instance, c.typeParams), scope)
	};
	const value = staticMembers.length ? TS.IntersectionType([ctor, TS.ObjectType(staticMembers)]) : ctor;
	stampScope(instance, scope);
	stampScope(value, scope);
	return { instance, value };
}

// Does `argTs` fit `sig` (arity, then every provided argument assignable)? `hasSpread`: a spread argument's real element
// count is unknowable statically, so an upper-bound arity mismatch is waived the same way a `rest` param waives it.
export function argsFit(sig: TS.CallSig, argTs: (Type | undefined)[], scope: Scope, hasSpread = false): boolean {
	if (argTs.length < sig.params.filter(p => !hasMod(p, 'optional')).length || (!sig.rest && !hasSpread && argTs.length > sig.params.length))
		return false;
	// `sig.declScope`: each param's own declared type resolves names in its *declaring* module's scope, not the caller's (see `isAssignable`'s `dstScope`).
	const dstScope = declScopeOf(sig, scope);
	return argTs.every((t, i) => {
		const p = sig.params[i];
		return !t || !p?.typeAnnotation || isAssignable(t, hasMod(p, 'optional') ? TS.UnionType([p.typeAnnotation, UNDEFINED]) : p.typeAnnotation, scope, dstScope);
	});
}

// `keyof`'s member-name collection: an object's own property/method names, an intersection's union of its parts', a union's *intersection* of its
// parts' (matching real TS). Anything else (array/tuple numeric keys, an unresolved ref) isn't modeled -- `undefined` keeps `keyof` opaque.
function objectKeyNames(t: Type, scope: Scope, depth: number): string[] | undefined {
	if (depth >= 0) {
		if (t.type === 'object')
			return t.members.map(m => (m.type === 'property' || m.type === 'method') && typeof m.key === 'string' ? m.key : undefined).filter(m => m !== undefined);
		if (t.type === 'intersection' || t.type === 'union') {
			const parts = t.types.map(p => objectKeyNames(resolve(scope, p, depth - 1), scope, depth - 1));
			if (parts.every(p => !!p))
				return t.type === 'intersection' ? [...new Set(parts.flat())] : parts[0].filter(k => parts.every(p => p.includes(k)));
		}
	}
	return undefined;
}
// Whether `t` derives from a genuinely uninstantiated type parameter (never registered in `scope`) rather than just being
// structurally complex. `indexed_access` passes the question through to its inner position.
function isAbstract(t: Type, scope: Scope): boolean {
	switch (t.type) {
		case 'ref':				return !t.typeArgs && !PRIMITIVES.has(t.name) && !scope.type(t.name);
		case 'indexed_access':	return isAbstract(t.object, scope) || isAbstract(t.index, scope);
		default:				return false;
	}
}

// A homomorphic mapped type's own `readonly`/`-readonly`/`optional`/`-optional` tags override the source member's matching
// tag; anything the mapped type doesn't mention passes the source's own state through unchanged.
function mapMemberModifiers(sourceMods: string[] | undefined, mapMods: string[] | undefined): string[] | undefined {
	const result = new Set(sourceMods);
	for (const tag of ['readonly', 'optional']) {
		if (mapMods?.includes(tag))
			result.add(tag);
		else if (mapMods?.includes('-' + tag))
			result.delete(tag);
	}
	return result.size ? [...result] : undefined;
}

// Expands a `ref` to its structural declaration, substituting type args (primitives/unresolvable names pass through unchanged). Bare generic
// refs cache their default substitution on the entry, keeping repeats `===`-identical -- `isAssignable`'s fast path needs that to terminate self-referential types.
export function resolve(scope: Scope, t: Type, depth = 10): Type {
	if (depth < 0) {
		hitDepthLimit('Scope.resolve');
		return ANY;
	}
	switch (t.type) {
		case 'mapped':
			if (!t.nameType) {
				// Members are only knowable once the key constraint resolves to a literal (or union of literals); anything else stays opaque.
				// `nameType` (the `as` key-remapping clause) isn't handled -- bail out rather than expand under the wrong (un-remapped) names.
				const constraint = resolve(scope, t.constraint, depth - 1);
				const keys		= isLiteral(constraint, 'string') ? [constraint.value]
					: constraint.type === 'union' && constraint.types.every(m => isLiteral(m, 'string')) ? constraint.types.map(m => m.value)
					: undefined;
				if (keys) {
					if (t.constraint.type === 'keyof') {
						// Homomorphic case (`[P in keyof T]`): each synthesized property starts from *that* key's own modifiers on `T`,
						const source = resolve(scope, t.constraint.argument, depth - 1);
						if (source?.type === 'object') {
							return resolve(scope, TS.ObjectType(keys.map(key => TS.TypeProperty(
								key,
								substituteType(t.valueType, new Map([[t.keyName, Literal(key)]])),
								mapMemberModifiers(findTypeMember(source.members, key)?.modifiers, t.modifiers)
							))), depth - 1);
						}
					}
					return resolve(scope, TS.ObjectType(keys.map(key => TS.TypeProperty(
						key,
						substituteType(t.valueType, new Map([[t.keyName, Literal(key)]])),
						t.modifiers
					))), depth - 1);
				}
				// `Record<string,T>`-shaped mapped types, the most common non-literal-key shape -- modeled as an index signature
				// rather than staying opaque; a homomorphic `valueType` referencing its own key substitutes the constraint in.
				if (isKeyable(constraint) || (constraint.type === 'union' && constraint.types.every(isKeyable))) {
					return resolve(scope, TS.ObjectType([
						TS.TypeIndex('key', constraint, substituteType(t.valueType, new Map([[t.keyName, constraint]])), t.modifiers)
					]), depth - 1);
				}
			}
			break;
			
		case 'indexed_access': {
			// `T[K]`: resolvable only when the index resolves to a literal (or union of literals), by looking up each corresponding member.
			const index = resolve(scope, t.index);
			// A numeric literal index into a *tuple* (the `FlatArray` idiom) picks a fixed element positionally -- distinct from the
			// string-keyed lookups below and from `lookupMember`, which has no notion of a numeric tuple position.
			if (isLiteral(index, 'number')) {
				const object = resolve(scope, t.object);
				if (object.type === 'tuple') {
					const el = object.elements[index.value];
					return el ? resolve(scope, tupleElementType(el) ?? ANY) : ANY;
				}
				if (object.type === 'array')
					return resolve(scope, object.element);
			}
			const keys = isLiteral(index, 'string') ? [index.value]
				: index.type === 'union' && index.types.every(m => isLiteral(m, 'string')) ? index.types.map(m => (m as { value: string }).value)
				: undefined;
			if (keys) {
				const object = resolve(scope, t.object, depth - 1);
				const parts = keys.map(key => lookupMember(object, key, scope));
				if (parts.every(p => !!p))
					return resolve(scope, combineTypes(parts), depth - 1);
			}
			break;
		}
		case 'keyof': {
			// `keyof any` is an intrinsic, equal to every legal property-key type -- checked on the raw argument, not `resolve()`'s
			// output, since `resolve` also returns `ANY` as a "gave up" sentinel once its depth budget runs out, not just for real `any`.
			if (isAny(t.argument))
				return TS.UnionType([TS.RefType('string'), TS.RefType('number'), TS.RefType('symbol')]);
			const arg = resolve(scope, t.argument, depth - 1);
			// An object made purely of an index signature has no enumerable literal keys -- `keyof` of it is just the index's own
			// key type (real TS: `keyof Record<string,T>` is `string`, not `never`), distinct from the finite-keys case below.
			if (arg.type === 'object' && arg.members.length && arg.members.every(m => m.type === 'index'))
				return resolve(scope, combineTypes(arg.members.map(m => m.paramType)), depth - 1);
			// Paired with `indexed_access` above, resolves the common `(typeof Round)[keyof typeof Round]` const-object-as-enum idiom end to end.
			const keys = objectKeyNames(arg, scope, depth - 1);
			if (keys)
				return resolve(scope, combineTypes(keys.map(Literal)), depth - 1);
			break;
		}
		case 'conditional': {
			// Only once `checkType` is concrete -- real TS also defers a conditional type until its naked check type is instantiated.
			const check = resolve(scope, t.checkType, depth - 1);
			if (!isAny(check) && !isAbstract(check, scope)) {
				if (containsInfer(t.extendsType)) {
					const bindings = new Map<string, Type>();
					// `t.checkType`, not the already-resolved `check` -- resolving would eagerly expand a named type, losing the identity
					// `matchInfer`'s `ref`-typeArgs case needs to match `Promise<infer R>`. Gets its own fresh budget, not `resolve`'s `depth`.
					const r = matchInfer(t.extendsType, t.checkType, scope, bindings);
					if (r !== undefined)
						return resolve(scope, r ? substituteType(t.trueType, bindings) : t.falseType, depth - 1);
				} else {
					// Stricter than `isAssignable`: real TS's `extends` says a bare `number` does NOT extend a narrower literal union, unlike ordinary assignability.
					// `undefined` propagates `isLiteralOnly`'s "can't safely decide" -- caller must stay opaque, not guess.
					const extendsType = resolve(scope, t.extendsType, depth - 1);
					const lit = isPrimitive(check) ? isLiteralOnly(extendsType, scope) : false;
					// `t.checkType`, not the already-resolved `check` -- same reasoning as `containsInfer` above: eagerly resolving loses
					// the ref identity `isAssignable`'s same-name fast path needs to confirm "does this class extend itself" cheaply.
					if (lit !== undefined)
						return resolve(scope, lit || !isAssignable(t.checkType, extendsType, scope) ? t.falseType : t.trueType, depth - 1);
				}
			} else if (!containsInfer(t.extendsType)) {
				// `checkType` is a genuinely abstract, unbound type param -- any real instantiation picks exactly one branch, never a
				// blend, so unioning both is a safe over-approximation (skipped when `extendsType` has `infer`, which needs real bindings).
				return resolve(scope, combineTypes([t.trueType, t.falseType]), depth - 1);
			}
			break;
		}
		case 'typeof': {
			const parts = t.name.split('.');
			let v		= scope.value(parts[0]);
			for (let i = 1; v && i < parts.length; i++)
				v = lookupMember(v, parts[i], scope);
			return v ? resolve(scope, v, depth - 1) : ANY;
		}
		case 'ref':
			if (!PRIMITIVES.has(t.name)) {
				// A ref's own `declScope` wins over the ambient `scope` -- a cross-module name resolves where it was declared, not wherever it's referenced from
				if (t.declScope)
					scope = t.declScope as Scope;
				const parts	= t.name.split('.');
				const name	= parts.pop()!;
				for (const i of parts) {
					const ns = scope.namespace(i);
					if (!ns)
						return t;
					scope = ns;
				}

				const entry = scope.type(name);
				if (entry) {
					if (!entry.typeParams?.length)
						return resolve(scope, entry.type, depth - 1);
					if (!t.typeArgs) {
						entry.defaultSubstitution ??= substituteType(entry.type, new Map(entry.typeParams.map(p => [p.name, p.default ?? ANY])));
						return resolve(scope, entry.defaultSubstitution, depth - 1);
					}
					return resolve(scope, substituteType(entry.type, new Map(entry.typeParams.map((p, i) => [p.name, t.typeArgs?.[i] ?? p.default ?? ANY]))), depth - 1);
				}
			}
			break;

	}
	return t;
}


export interface TypeEntry { typeParams?: TS.TypeParam[]; type: Type; defaultSubstitution?: Type }

// A stable key for narrowing simple property chains (`a.b.c`), sharing the Scope narrowings map with plain identifiers (dotted keys can never collide with real bindings)
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

export class Scope {
	private values		= new Map<string, Type>();
	private types		= new Map<string, TypeEntry>();
	private narrowings?:	Map<string, Type>;	// control-flow refinements, consulted before declarations
	private aliases?:		Map<string, Expr>;	// const initializers -- narrowing a const also narrows through its initializer (TS 4.4 aliased conditions)
	private namespaces?:	Map<string, Scope>;	// nested namespace/module scopes, keyed by their bound name -- consulted by `resolve` for a dotted type ref (`NS.Foo`)

	constructor(public parent?: Scope) {}

	value(name: string): Type | undefined			{ return this.narrowings?.get(name) ?? this.values.get(name) ?? this.parent?.value(name); }
	type(name: string): TypeEntry | undefined		{ return this.types.get(name) ?? this.parent?.type(name); }
	declared(name: string): Type | undefined		{ return this.values.get(name) ?? this.parent?.declared(name); }
	alias(name: string): Expr | undefined			{ return this.aliases?.get(name) ?? (this.values.has(name) ? undefined : this.parent?.alias(name)); }
	namespace(name: string): Scope | undefined		{ return this.namespaces?.get(name) ?? this.parent?.namespace(name); }
	// Own (non-inherited) namespaces only -- a printer qualifying a cross-module ref walks these one hop at a time,
	// so it needs each hop's own name, not `namespace()`'s already-flattened parent-chain lookup.
	ownNamespaces(): ReadonlyMap<string, Scope>	{ return this.namespaces ?? new Map(); }

	addValue(name: string, type: Type)				{ this.values.set(name, type); }
	addType(name: string, type: Type, typeParams?: TS.TypeParam[])	{ this.types.set(name, {type, typeParams}); }
	addNarrowing(name: string, t: Type)				{ (this.narrowings ??= new Map()).set(name, t); }
	addAlias(d: JS.VarDeclarator<any>)				{ (this.aliases ??= new Map()).set(d.name, d.init); }
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

	toObject() {
		const members: TS.TypeMember[] = [];
		for (const [name, typeAnnotation] of this.values)
			members.push({ type: 'property', key: name, typeAnnotation });
		return TS.ObjectType(members);
	}
}

export function makeGlobal() {
	const global = new Scope();
	for (const [r, n] of Object.entries(BOXED_PRIMITIVE))
		global.addValue(n, TS.FunctionType([JS.Param('value', ANY, ['optional'])], TS.RefType(r)));

	global.addValue('undefined',	UNDEFINED);
	global.addValue('NaN',			NUMBER);
	global.addValue('Infinity',		NUMBER);

	const TT = TS.RefType('T');
	const TP = [TS.TypeParam('T')];
	global.addValue('Array', TS.ObjectType([
		TS.TypeCall(TS.CallSig([JS.Param('arrayLength', NUMBER, ['optional'])], TS.ArrayType(TT), TP)),
		TS.TypeProperty('prototype', ANY),
		TS.TypeMethod('from', 		TS.CallSig(
			[
				JS.Param('arrayLike',	ANY),
				JS.Param('mapfn',		TS.FunctionType([JS.Param('v', ANY), JS.Param('k', NUMBER)], TT), ['optional']),
				JS.Param('thisArg', 	ANY, ['optional']),
			],
			TS.ArrayType(TT),
			TP
		)),
		TS.TypeMethod('isArray',	TS.CallSig([JS.Param('a', ANY)], TS.Predicate('a', TS.ArrayType(ANY)))),
		TS.TypeMethod('of',			TS.CallSig({ params: [], rest: JS.Rest('items', TT) }, TS.ArrayType(TT), TP)),
	]));
/*
	global.addValue('BigInt', TS.ObjectType([
		TS.TypeCall(TS.CallSig([JS.Param('value', TS.UnionType([STRING, NUMBER, BOOLEAN, BIGINT]))], BIGINT)),
		TS.TypeProperty('prototype', ANY),
		TS.TypeMethod('asIntN', 		TS.CallSig(
			[
				JS.Param('bits',	NUMBER),
				JS.Param('int',		BIGINT),
			],
			BIGINT,
		)),
		TS.TypeMethod('asUintN', 		TS.CallSig(
			[
				JS.Param('bits',	NUMBER),
				JS.Param('int',		BIGINT),
			],
			BIGINT,
		)),
	]));
*/
	return global;
}