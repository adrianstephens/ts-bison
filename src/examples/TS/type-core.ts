/* eslint-disable @typescript-eslint/no-this-alias */
import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Literal, hasMod } from '../common';
import { Expr, BindingTarget } from './js-parser';
import { Type } from './ts-parser';
import { walker, walkerB, WalkerB } from './walker';
import { printer } from './printer';

// The type model shared by every source language, in TypeScript's vocabulary. What a language's runtime adds to it
// comes from the `Semantics` its root `Scope` carries; `type-utils.ts` is TypeScript's.

// ===================================================================
//  Type names and well-known types
// ===================================================================

const _PRIMITIVES		= ['number', 'string', 'symbol', 'boolean', 'bigint', 'undefined', 'object', 'never', 'void', 'null'] as const;
type PRIMITIVES			= (typeof _PRIMITIVES)[number];

class TypeSet<T extends string> {
	set;
	constructor(public values: ReadonlyArray<T>) {
		this.set = new Set<string>(values);
	}
	has(name: string): name is T {
		return this.set.has(name);
	}
	or<U extends string>(other: TypeSet<U>): TypeSet<T | U> {
		return new TypeSet([...this.values, ...other.values]);
	}
}

const KEY_TYPES			= new TypeSet(['number', 'string', 'symbol']);
export const LITERAL_PRIMITIVES	= new TypeSet(['string', 'number', 'boolean', 'bigint']);
export const SIMPLE_TYPES		= new TypeSet(['number', 'string', 'symbol', 'boolean', 'bigint', 'undefined']);
const PRIMITIVE_DOMAINS	= SIMPLE_TYPES.or(new TypeSet(['null']));
const PRIMITIVES		= new TypeSet(_PRIMITIVES);
const TOP_TYPES			= new TypeSet(['any', 'unknown']);
export const INTRINSIC_TYPES	= PRIMITIVES.or(TOP_TYPES);

export const WASM_PSEUDO_TYPES	= new TypeSet(['i8', 'u8', 'i16', 'u16', 'i32', 'i64', 'f32', 'f64', 'u32', 'u64']);

const OPAQUE		= new Set(['keyof', 'indexed_access', 'conditional', 'infer', 'mapped', 'this', 'predicate']);

// The subset of `OPAQUE` that's a genuinely unevaluated computation, as opposed to `this`/`predicate` (opaque by design, not a gap).
// In `strict` mode below, either side being one of these fails the comparison instead of auto-passing it.
const OPAQUE_GAP	= new Set(['keyof', 'indexed_access', 'conditional', 'infer', 'mapped']);

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

// ===================================================================
//  Keys: printed types, expression paths, member and binding names
// ===================================================================

export const tocode = printer({newline:'', indent:'', spaceAfterColon: false, spaceAfterComma: false, spaceAroundOps: false});
export function typeKey(t: Type) { return tocode.type(t); }
export function exprKey(e: Expr) { return tocode.expression(e); }

// A stable key for narrowing simple property chains (`a.b.c`), sharing the Scope narrowings map with plain identifiers (dotted keys can never collide with real bindings)
export function pathKey(e: Expr): string | undefined {
	switch (e.type) {
		case 'identifier':	return e.name;
		case 'this':		return 'this';
		case 'member': {
			const k = pathKey(e.object);
			return k && k + '.' + e.property;
		}
		// A LITERAL index names one fixed element, so `a[0].k` is as stable a path as `a.b.k` and narrows
		// the same way (real TS narrows element access on a literal index too). A COMPUTED one must not:
		// the index expression can evaluate differently between the guard and the read.
		case 'index': {
			const k = pathKey(e.object);
			if (k === undefined || e.index.type !== 'literal')
				return undefined;
			const v = e.index.value;
			return typeof v === 'number' ? `${k}[${v}]` : typeof v === 'string' ? `${k}["${v}"]` : undefined;
		}
		default:			return undefined;
	}
}

// A member key's static name: a string key as written, a literal computed key as its value, and one naming an entity
// (`[Symbol.iterator]`) by that path, spelled as TS prints it. Any other computed key has no static name.
export function memberKey(key: JS.Key<Type>): string | undefined {
	if (typeof key === 'string')
		return key;
	const e = key.computed;
	if (e.type === 'literal' && (typeof e.value === 'string' || typeof e.value === 'number'))
		return String(e.value);
	const path = e.type === 'identifier' || e.type === 'member' ? pathKey(e) : undefined;
	return path && `[${path}]`;
}

export function bindingNames(t: BindingTarget): string[] {
	return typeof t === 'string' ? [t]
		: t.type === 'object_pattern' ? [...t.properties.flatMap(p => bindingNames(p.value)), ...(t.rest ? [t.rest] : [])]
		: [...t.elements.flatMap(e => e ? bindingNames(e.target) : []), ...(t.rest ? bindingNames(t.rest) : [])];
}

// ===================================================================
//  Shallow tests (no resolution)
// ===================================================================

export function isRef<T extends string>(t: Type, name: T): t is TS.RefType<T>							{ return t.type === 'ref' && t.name === name; }
export function isRefOf<T extends string>(t: Type, set: { has: (n: T)=> boolean }): t is TS.RefType<T>	{ return t.type === 'ref' && set.has(t.name as any); }

export function isPrimitive(t: Type){ return t.type === 'ref' && PRIMITIVES.has(t.name); }
export function isKeyable(t: Type)	{ return t.type === 'ref' && KEY_TYPES.has(t.name); }
export function isAny(t: Type)		{ return t.type === 'ref' && TOP_TYPES.has(t.name); }
export function isBoolean(t: Type)	{ return isRef(t, 'boolean'); }
export function isString(t: Type)	{ return isRef(t, 'string'); }

function isNullOrUndefined(t: Type): boolean {
	return t.type === 'literal' ? t.value === null : t.type === 'ref' && (t.name === 'null' || t.name === 'undefined');
}

// ===================================================================
//  Literals and widening
// ===================================================================

interface TypeOfMap {
	string: string;	number: number;	boolean: boolean;
//	bigint: bigint; symbol: symbol; object: object; undefined: undefined; function: undefined;
	bigint: string; symbol: string; object: string; undefined: string; function: string;
	null:		null;
	template:	JS.TemplatePart<Type>[]
}

export function literalType(t: Literal<any>) {
	return Array.isArray(t.value) ? 'string' : t.value === null ? 'null' : typeof t.value;
}
export function isLiteral<K extends keyof TypeOfMap>(t: Type|Expr, type: K): t is Literal<TypeOfMap[K]> {
	return t.type === 'literal' && literalType(t) === type;
}

// A string literal's text, as a property key: a template counts only without substitutions (its parts' text); any other is `undefined`.
export function literalString(t: Type|Expr): string | undefined {
	if (t.type !== 'literal')
		return undefined;
	if (typeof t.value === 'string')
		return t.value;
	if (!Array.isArray(t.value))
		return undefined;
	const parts: readonly JS.TemplatePart<unknown>[] = t.value;
	let text = '';
	for (const p of parts) {
		if (p.exp)
			return undefined;
		text += p.str;
	}
	return text;
}

// The possible values of a pure literal or union of literals (a real discriminant, e.g. `type: 'method'|'get'|'set'`);
// `undefined` for anything wider, meaning "no signal".
export function literalValues(t: Type): unknown[] | undefined {
	return t.type === 'literal' ? [t.value]
		: t.type === 'union' && t.types.every((m): m is Literal<string | number | boolean | null | JS.TemplatePart<Type>[]> => m.type === 'literal') ? t.types.map(m => m.value)
		: undefined;
}

// Deep: also widens literal element/property types nested inside array/object structure (matching real TS, which widens a freshly-
// inferred array/object literal's members too, not just a bare literal expression) -- not just this type's own top-level shape.
// `frozen` leaves (see `common.ts`'s `Literal.frozen`) are left exactly as they are, at any nesting depth -- an `as const`
// value's own literal identity survives being embedded in a container that's itself later widened (`[1, x as const]`).
// `ignoreFrozen`: an `as const` literal's `frozen` flag exists so the *checker* keeps its precise literal
// type (real TS semantics) -- callers computing a *physical* runtime representation instead (e.g.
// backend.ts picking a value's wasm storage kind) have no such use for it: a frozen and non-frozen `'foo'`
// still need the exact same physical representation, so those callers pass `true` to widen through it.
// `shallow`: only the value's own literal (or union of them) widens, not literals nested in an array or object it holds.
// Memoized per type object (and flags): a DAG rewritten once per node, not once per path.
const widenCache = new Map<number, WeakMap<Type, Type>>();
export function widenLiterals(t: Type, keepBoolean = false, ignoreFrozen = false, shallow = false): Type {
	const flags = (keepBoolean ? 1 : 0) | (ignoreFrozen ? 2 : 0) | (shallow ? 4 : 0);
	let cache = widenCache.get(flags);
	if (!cache)
		widenCache.set(flags, cache = new WeakMap());
	let r = cache.get(t);
	if (!r)
		cache.set(t, r = widen(t, keepBoolean, ignoreFrozen, shallow));
	return r;
}
function widen(t: Type, keepBoolean: boolean, ignoreFrozen: boolean, shallow: boolean): Type {
	return	(t.type === 'literal' || t.type === 'range') && t.frozen && !ignoreFrozen ? t
		:	t.type === 'literal' && t.value !== null && (!keepBoolean || typeof t.value !== 'boolean')
			&& (t.fresh || ignoreFrozen || typeof t.value === 'number' || typeof t.value === 'bigint') ? TS.RefType(literalType(t))
		:	t.type === 'range' ? TS.RefType(t.base)
		:	t.type === 'union' ? combineTypes(t.types.map(m => widenLiterals(m, keepBoolean, ignoreFrozen, shallow)))
		:	shallow ? t
		:	t.type === 'array' ? TS.ArrayType(widenLiterals(t.element, keepBoolean, ignoreFrozen), t.readonly)
		:	t.type === 'object' ? TS.ObjectType(t.members.map(m => m.type === 'property' ? TS.TypeProperty(m.key, widenLiterals(m.typeAnnotation, keepBoolean, ignoreFrozen), m.modifiers) : m))
		:	t;
}

// The inverse of `widenLiterals`'s own recursion shape: marks every literal/range leaf within `t` as `frozen`, matching
// an `as const` assertion's real TS semantics -- used once, where `typeOf`'s `'as'` case computes the asserted value.
export function freeze(t: Type): Type {
	return	t.type === 'literal' || t.type === 'range' ? { ...t, frozen: true }
		:	t.type === 'union' ? TS.UnionType(t.types.map(freeze))
		:	t.type === 'array' ? TS.ArrayType(freeze(t.element), t.readonly)
		:	t.type === 'object' ? TS.ObjectType(t.members.map(m => m.type === 'property' ? TS.TypeProperty(m.key, freeze(m.typeAnnotation), m.modifiers) : m))
		:	t;
}

// ===================================================================
//  Numeric ranges
// ===================================================================

// A canonical, base-uniform view of "how much do we know about a number/bigint value" -- consumed/produced by
// `narrow()`'s relational/equality handling in checker.ts. `min`/`max` undefined means unbounded on that side;
// `integer` is always true for `bigint` (every bigint value already is one).
export interface NumRange { base: 'number' | 'bigint'; min?: number | bigint; max?: number | bigint; integer: boolean }

// Reduces any resolved numeric-ish `Type` to a `NumRange`, or `undefined` if `t` isn't one at all.
export function toRange(t?: Type): NumRange | undefined {
	if (t) {
		if (t.type === 'range')
			return { base: t.base, min: t.min, max: t.max, integer: t.base === 'bigint' || !!t.integer };
		if (t.type === 'literal' && typeof t.value === 'number')
			return { base: 'number', min: t.value, max: t.value, integer: Number.isInteger(t.value) };
		if (t.type === 'literal' && typeof t.value === 'bigint')
			return { base: 'bigint', min: t.value, max: t.value, integer: true };
		if (t.type === 'ref' && t.name === 'number')
			return { base: 'number', integer: false };
		if (t.type === 'ref' && t.name === 'bigint')
			return { base: 'bigint', integer: true };
	}
	return undefined;
}

// The inverse of `toRange`: collapses back to the simplest `Type` representing `r` -- a plain `Literal` for an
// exactly-known number, a bare ref when nothing is actually known, or a genuine `RangeType` otherwise (see
// `RangeType`'s own comment for why an exact bigint value stays a degenerate range rather than becoming a `Literal`).
export function rangeToType(r: NumRange): Type;
export function rangeToType(r?: NumRange): Type | undefined;
export function rangeToType(r?: NumRange): Type | undefined {
	if (!r)
		return undefined;
	if (r.base === 'number') {
		return	r.min !== undefined && r.min === r.max ?  Literal(r.min as number)
			:	r.min !== undefined || r.max !== undefined || r.integer ?  TS.RangeType('number', r.min, r.max, r.integer)
			:	NUMBER;
	}
	return	r.min !== undefined || r.max !== undefined ? TS.RangeType('bigint', r.min, r.max)
		:	BIGINT;
}

// Intersects two same-based ranges (e.g. a binding's current range with a new comparison's implied bound);
// `undefined` means the intersection is provably empty (the comparison contradicts what's already known).
export function rangeIntersect(a: NumRange, b: NumRange): NumRange | undefined {
	if (a.base !== b.base)
		return undefined;
	const min = a.min === undefined ? b.min : b.min === undefined ? a.min : a.min > b.min ? a.min : b.min;
	const max = a.max === undefined ? b.max : b.max === undefined ? a.max : a.max < b.max ? a.max : b.max;
	if (min !== undefined && max !== undefined && min > max)
		return undefined;
	return { base: a.base, min, max, integer: a.integer || b.integer };
}

// Widens a range to cover both `a` and `b` -- the union counterpart of `rangeIntersect`. Same-base only.
export function rangeUnion(a: NumRange, b: NumRange): NumRange | undefined {
	if (a.base !== b.base)
		return undefined;
	return {
		base:	a.base,
		min:	a.min === undefined || b.min === undefined ? undefined : a.min < b.min ? a.min : b.min,
		max:	a.max === undefined || b.max === undefined ? undefined : a.max > b.max ? a.max : b.max,
		integer: a.integer && b.integer
	};
}

// Same-typed `number`/`bigint` arithmetic on a `number | bigint`-typed value, without mixing the two at the type level.
function negValue(v: number | bigint): number | bigint { return typeof v === 'bigint' ? -v : -v; }
function addValue(a: number | bigint, b: number | bigint): number | bigint { return typeof a === 'bigint' ? a + BigInt(b) : a + Number(b); }
function subValue(a: number | bigint, b: number | bigint): number | bigint { return typeof a === 'bigint' ? a - BigInt(b) : a - Number(b); }
function mulValue(a: number | bigint, b: number | bigint): number | bigint { return typeof a === 'bigint' ? a * BigInt(b) : a * Number(b); }
function divValue(a: number | bigint, b: number | bigint): number | bigint { return typeof a === 'bigint' ? a / BigInt(b) : a / Number(b); }
function minOfValues(vs: (number | bigint)[]): number | bigint { return vs.reduce((a, b) => a < b ? a : b); }
function maxOfValues(vs: (number | bigint)[]): number | bigint { return vs.reduce((a, b) => a > b ? a : b); }

// The range of `Math.max`/`Math.min` over values in each of `a`: each bound picked across all of them, unbounded if any is.
function rangeExtreme(a: NumRange[], pick: (vs: (number | bigint)[]) => number | bigint): NumRange | undefined {
	const bound = (vs: (number | bigint | undefined)[]) => vs.every(v => v !== undefined) ? pick(vs) : undefined;
	return a.length ? { base: a[0].base, min: bound(a.map(r => r.min)), max: bound(a.map(r => r.max)), integer: a.every(r => r.integer) } : undefined;
}
export function rangeMax(a: NumRange[]) { return rangeExtreme(a, maxOfValues); }
export function rangeMin(a: NumRange[]) { return rangeExtreme(a, minOfValues); }

// Whether `r`'s span provably includes the value `0` -- used to decide truthy/falsy/nullish-adjacent questions for
// a narrowed numeric type the same way a plain `number`/`bigint` ref is decided (both are always presumed to include 0).
export function rangeIncludesZero(r: { min?: number | bigint; max?: number | bigint }): boolean {
	return (r.min === undefined || r.min <= 0) && (r.max === undefined || r.max >= 0);
}

export function rangeClamp(a: NumRange, bound: number|bigint, isUpper: boolean, strict?: boolean): NumRange | undefined {
	if (isUpper) {
		if (strict && a.integer)
			--bound;
		if (a.min !== undefined && a.min > bound)
			return undefined;
		return {...a, max: a.max !== undefined && a.max < bound ? a.max : bound};
	} else {
		if (strict && a.integer)
			++bound;
		if (a.max !== undefined && a.max < bound)
			return undefined;
		return {...a, min: a.min !== undefined && a.min > bound ? a.min : bound};
	}
}

// Interval arithmetic over possibly-unbounded ranges, so `x + 1` for a bounded `x` stays bounded. An unbounded side
// of an operand leaves the result unbounded on that side too: a conservative over-approximation.
export function rangeUnOp(op: JS.unaryOps, a: NumRange): NumRange | undefined {
	const base	= a.base;
	const shift	= (d: number) => ({ base, integer: a.integer,
		min: a.min !== undefined ? addValue(a.min, d) : undefined,
		max: a.max !== undefined ? addValue(a.max, d) : undefined
	});
	switch (op) {
		case '+':	return a;
		case '-':	return {
			base, integer: a.integer,
			min: a.max !== undefined ? negValue(a.max) : undefined,
			max: a.min !== undefined ? negValue(a.min) : undefined
		};
		case '~':	return { base, integer: a.integer};
		case '++':	return shift(1);
		case '--':	return shift(-1);
	}
}

export function rangeBinOp(op: JS.binaryOps, a: NumRange, b: NumRange): NumRange | undefined {
	const base = a.base;
	if (b.base !== base)
		return undefined;

	function add(a: NumRange, b: NumRange): NumRange | undefined {
		return { base, integer: a.integer && b.integer,
			min: a.min !== undefined && b.min !== undefined ? addValue(a.min, b.min) : undefined,
			max: a.max !== undefined && b.max !== undefined ? addValue(a.max, b.max) : undefined };
	}
	function sub(a: NumRange, b: NumRange): NumRange | undefined {
		return { base, integer: a.integer && b.integer,
			min: a.min !== undefined && b.max !== undefined ? subValue(a.min, b.max) : undefined,
			max: a.max !== undefined && b.min !== undefined ? subValue(a.max, b.min) : undefined };
	}
	function mul(a: NumRange, b: NumRange): NumRange | undefined {
		if (a.min === undefined || a.max === undefined || b.min === undefined || b.max === undefined)
			return { base, integer: a.integer && b.integer };
		const corners = [mulValue(a.min, b.min), mulValue(a.min, b.max), mulValue(a.max, b.min), mulValue(a.max, b.max)];
		return { base, integer: a.integer && b.integer, min: minOfValues(corners), max: maxOfValues(corners) };
	}
	function div(a: NumRange, b: NumRange): NumRange | undefined {
		if (a.min === undefined || a.max === undefined || b.min === undefined || b.max === undefined || (b.min <= 0 && b.max >= 0))
			return { base, integer: base === 'bigint' };
		const corners = [divValue(a.min, b.min), divValue(a.min, b.max), divValue(a.max, b.min), divValue(a.max, b.max)];
		return { base, integer: base === 'bigint', min: minOfValues(corners), max: maxOfValues(corners) };
	}

	switch (op) {
		case '+':	return add(a, b);
		case '-':	return sub(a, b);
		case '*':	return mul(a, b);
		case '/':	return div(a, b);
		//case '<':	case '>': case '<=': case '>=':
		//case '==':	case '!=':	case '===': case '!==':
		//	return { base: 'number', integer: true, min: 0, max: 1 };
		case '&':	case '|': case '^': case '<<': case '>>':
			return base === 'number' ? { base, integer: true, min: -0x80000000, max: 0x7fffffff} : {base, integer: true};
		case '>>>':
			return base === 'number' ? { base, integer: true, min: 0, max: 0xffffffff} : {base, integer: true};
	}
}

// ===================================================================
//  Building unions and intersections
// ===================================================================

// `types` with every nested union (or intersection) spread into its members, as written -- nothing is resolved.
export function flatParts(types: readonly Type[], kind: 'union' | 'intersection'): Type[] {
	return types.flatMap(t => (t.type === 'union' || t.type === 'intersection') && t.type === kind ? flatParts(t.types, kind) : [t]);
}

// The first of `types` with each `key`.
function dedupe(types: Type[], key: (t: Type) => unknown): Type[] {
	const seen = new Set<unknown>();
	return types.filter(t => {
		const k = key(t);
		return !seen.has(k) && !!seen.add(k);
	});
}

// De-dupes structurally-identical types and folds what's left into a `union`
export function combineTypes(types: Type[]): Type {
	const seen = new Map<string, number>();
	const unique: Type[] = [];
	// `never` is a union's identity element: nothing inhabits it, and left in it makes the union unanswerable to every
	// consumer asking "one owner or many". Same rule `unionMembers` applies when it flattens.
	for (const t of flatParts(types, 'union').filter(t => !isRef(t, 'never'))) {
		const key = typeKey(t);
		const at = seen.get(key);
		if (at === undefined) {
			seen.set(key, unique.length);
			unique.push(t);
		} else if (t.type === 'literal' && t.fresh) {
			unique[at] = t;	// a fresh twin is kept: it widens, as TS keeps the fresh one
		}
	}
	// TS's removeRedundantLiteralTypes: a literal (or one of this checker's ranges) whose primitive is a member adds nothing.
	const primitives = new Set<string>(unique.flatMap(t => t.type === 'ref' && !t.typeArgs && LITERAL_PRIMITIVES.has(t.name) ? [t.name] : []));
	if (primitives.size) {
		const redundant = (t: Type) => t.type === 'literal' ? t.value !== null && primitives.has(literalType(t)) : t.type === 'range' && primitives.has(t.base);
		for (let i = unique.length; i--; )
			if (redundant(unique[i]))
				unique.splice(i, 1);
	}
	// TS's union reduction: `any` absorbs every member, `unknown` every member but `any`.
	return	unique.some(t => isRef(t, 'any')) ? ANY
		:	unique.some(t => isRef(t, 'unknown')) ? UNKNOWN
		:	!unique.length ? NEVER : unique.length === 1 ? unique[0] : TS.UnionType(unique);
}

// The reductions an instantiation owes a rebuilt union or intersection -- members flattened, `never` dropped from a union,
// `any` absorbing either, `unknown` a union and leaving an intersection -- without `combineTypes`'s structural dedupe, whose
// `typeKey` per member costs as much as the types are large.
function reduceInstantiated(t: TS.UnionType | TS.IntersectionType): Type {
	const flat = flatParts(t.types, t.type);
	if (flat.some(m => isRef(m, 'any')))
		return ANY;
	// Nothing inhabits `never`, so an intersection holding one IS `never` -- as TS reduces it at construction, which is what makes
	// a phantom parameter (`type ActionType<P> = string & { hack?: P & never }`) infer nothing for `P` instead of `X & never`.
	if (t.type === 'intersection' && flat.some(m => isRef(m, 'never')))
		return NEVER;
	const kept = t.type === 'union'
		? (flat.some(m => isRef(m, 'unknown')) ? [UNKNOWN] : flat.filter(m => !isRef(m, 'never')))
		: flat.filter(m => !isRef(m, 'unknown'));
	return !kept.length ? (t.type === 'union' ? NEVER : UNKNOWN) : kept.length === 1 ? kept[0]
		: kept.length === t.types.length && kept.every((m, i) => m === t.types[i]) ? t
		: t.type === 'union' ? TS.UnionType(kept) : TS.IntersectionType(kept);
}

export function optional(type:Type, optional?: boolean) {
	return optional ? combineTypes([type, UNDEFINED]) : type;
}

export function intersectTypes(types: Type[]): Type {
	if (types.length === 1)
		return types[0];
	const unique = dedupe(flatParts(types, 'intersection'), typeKey);
	// TS's intersection reduction: `any` absorbs every member.
	return unique.some(t => isRef(t, 'any')) ? ANY : unique.length === 1 ? unique[0] : TS.IntersectionType(unique);
}

// Declaration merging's own intersect: parts flattened and deduped by IDENTITY only. `intersectTypes`' structural
// dedupe walks each part with `typeKey`, which forces a class's lazily inferred field types mid-`hoist` -- before the
// rest of the block is bound, so `charCodeAt = __asm<[i32], i32>(...)` memoized `any`. Real TS merges declarations
// without resolving their members at all.
export function joinTypes(types: Type[]): Type {
	const parts = dedupe(flatParts(types, 'intersection'), t => t);
	return parts.length === 1 ? parts[0] : TS.IntersectionType(parts);
}

// Merges the `object` parts of an intersection into one flat `object`, keeping any non-object parts alongside it rather than folding them in.
// A key declared by more than one object part becomes the intersection of its own per-part types
// `optional` survives only if every part declaring the key marks it optional, `readonly` if any part does
export function mergeIntersection(t: Type): Type {
	if (t.type !== 'intersection')
		return t;

	const nonObject:	Type[] = [];
	const otherMembers: TS.TypeMember[] = [];
	const byKey = new Map<string, { types: Type[]; optional: boolean; readonly: boolean }>();

	for (const part of flatParts([t], 'intersection')) {
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

// ===================================================================
//  Declaring scopes of types
// ===================================================================

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

// Tags every `ref`/signature reachable from `t` with `scope`, mutating in place (`mapObjectVoid`, freshly-built nodes only).
// Skips one that already carries a scope, so re-stamping an already-tagged structure is a no-op. Delegates traversal to `walk`.
// `exclude`: names that must NOT be stamped even though otherwise eligible -- see `stampSig`'s own use, where a nested
// function's own type-parameter names are bound (not free) and must stay resolvable in whatever scope later actually
// registers them, not permanently baked to the hoisting pass's outer scope.
export function stampScope<T extends Type>(t: T, scope: Scope, exclude?: Set<string>): T {
	walkerB(undefined, undefined,
		searchOnce((x: Type, process: (x: Type) => boolean) => {
			// Primitives resolve the same everywhere -- stamping them would only add dead weight and dedup-key noise for no gain.
			if (x.type === 'ref') {
				if (!x.declScope && !INTRINSIC_TYPES.has(x.name) && !exclude?.has(x.name))
					x.declScope = scope;
			} else if (x.type === 'typeof') {
				// A `typeof X` query names a VALUE, so it needs its declaring scope for exactly the reason a
				// `ref` does -- `type Options = Partial<typeof DefaultOptions>` exported from one module
				// resolves its members in the importer's scope, where `DefaultOptions` (a plain
				// non-exported const) is not a name at all.
				x.declScope ??= scope;
			} else if (x.type === 'function' || x.type === 'constructor') {
				x.declScope ??= scope;
			}
			return process(x);
		}),
		searchOnce((m: TS.TypeMember | TS.ClassMember, process: (x: TS.TypeMember | TS.ClassMember) => boolean) => {
			if (m.type === 'method' || m.type === 'call' || m.type === 'construct')
				m.declScope ??= scope;
			return process(m);
		})
	).type(t);
	return t;
}

// Stamps a `CallSig`-shaped object's own params/rest/return type -- for callers stamping a freshly-built signature directly
// (a bare `TS.CallSig`, e.g. a hoisted free function's, isn't itself a `Type` node, so `stampScope`/`walk` alone can't take it).
export function stampSig<T extends TS.CallSig>(sig: T, scope: Scope): T {
	// Also tags the signature itself (see `withScope`) -- a bare interface/type-literal method has no other declScope
	// source (unlike a hoisted free function/class method, which already gets one before `stampSig` ever sees it).
	sig.declScope ??= scope;
	// This signature's own type parameters are excluded from stamping below -- they're bound within the signature, not
	// free names resolved against the hoisting pass's outer scope. A hoisted *nested* function (one whose own body-check
	// scope, which registers these names via `addTypeParam`, doesn't exist yet at hoist time) would otherwise have every
	// reference to its own `T` permanently stamped with the *enclosing* function's scope -- `declScope`'s "first stamp
	// wins, skip if already tagged" semantics then shadow the nested function's own registration forever, so its own `T`
	// silently resolves as the *outer* function's `T` throughout its whole body. A real, previously-latent scope-leakage
	// bug, invisible before type parameters were ever registered at all (either name was equally unresolvable, so which
	// scope you asked never mattered) -- exposed once `checkFunctionBody` started registering them for real.
	const ownTypeParams = sig.typeParams?.length ? new Set(sig.typeParams.map(p => p.name)) : undefined;
	sig.params.forEach(p => p.typeAnnotation && stampScope(p.typeAnnotation as Type, scope, ownTypeParams));
	if (sig.rest?.typeAnnotation)
		stampScope(sig.rest.typeAnnotation as Type, scope, ownTypeParams);
	if (sig.returnType)
		stampScope(sig.returnType, scope, ownTypeParams);
	// A type param's own `constraint`/`default` need it too -- otherwise `inferTypeArgs`'s `isLiteralOnly(tp.constraint, ...)`
	// check (does this constraint restrict to a union of literals?) can't resolve a constraint declared in this module but
	// invisible from the caller's own scope, and silently widens a literal argument that should have stayed narrow.
	// Still excludes `ownTypeParams`: an F-bounded constraint (`T extends hasop<'x', T>`) refers to its own bound `T`.
	sig.typeParams?.forEach(p => {
		if (p.constraint)
			stampScope(p.constraint as Type, scope, ownTypeParams);
		if (p.default)
			stampScope(p.default as Type, scope, ownTypeParams);
	});
	return sig;
}

// ===================================================================
//  Substitution and type-parameter hygiene
// ===================================================================

// A type is a DAG -- one subtree reached through many parents -- so a walk over it visits each node once, or its cost
// is the number of paths, exponential in how deeply generic instantiations nest. For a search, a node seen before is no hit.
function searchOnce<X extends object, P, R>(on: (x: X, process: P, recurse: R) => boolean) {
	const seen = new Set<X>();
	return (x: X, process: P, recurse: R) => {
		if (seen.has(x))
			return false;
		seen.add(x);
		return on(x, process, recurse);
	};
}
// For a rewrite, a node seen before maps to what it mapped to, which also keeps the shared subtree shared in the result.
function rewriteOnce<X extends object, P, R>(on: (x: X, process: P, recurse: R) => X | undefined) {
	const done = new Map<X, X | undefined>();
	return (x: X, process: P, recurse: R) => {
		if (!done.has(x))
			done.set(x, on(x, process, recurse));
		return done.get(x);
	};
}

// A synthetic type-parameter name: the apostrophe can never appear in a real identifier, so it collides with nothing in scope.
let freshTypeParamId = 0;
export function freshTypeParamName(base: string) { return `${base}'${freshTypeParamId++}`; }

// `sig` with every type in it -- parameters, rest, return, its own type parameters' bounds -- mapped through `f`.
function mapSigTypes<S extends TS.CallSig>(sig: S, f: (t: Type) => Type): S {
	return {
		...sig,
		params:		sig.params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: f(p.typeAnnotation) } : p),
		rest:		sig.rest?.typeAnnotation ? { ...sig.rest, typeAnnotation: f(sig.rest.typeAnnotation) } : sig.rest,
		returnType:	sig.returnType && f(sig.returnType),
		typeParams:	sig.typeParams?.map(p => ({ ...p, constraint: p.constraint && f(p.constraint), default: p.default && f(p.default) })),
	};
}

// A nested signature's own type parameter (`Array<T>.map<U>`'s `U`) would capture a same-named one in a value substituted into it
// (`T := U[]` from a caller's own `U`). Alpha-renames each such bound parameter first, so the outer substitution is capture-free.
function avoidCapture<S extends TS.CallSig>(sig: S, map: Map<string, Type>): S {
	if (!sig.typeParams?.length)
		return sig;
	const values = [...map.values()];
	const rename = new Map(sig.typeParams.filter(p => values.some(v => mentionsTypeParam(v, p.name))).map(p => [p.name, freshTypeParamName(p.name)] as const));
	if (!rename.size)
		return sig;
	const renameRefs	= new Map([...rename].map(([from, to]) => [from, TS.RefType(to)] as const));
	const renamed		= mapSigTypes(sig, t => substituteType(t, renameRefs));
	return { ...renamed, typeParams: renamed.typeParams?.map(p => ({ ...p, name: rename.get(p.name) ?? p.name })) };
}

// A mapped type's key is a binder too: `Partial<{p: P}>` substitutes a type naming the caller's own `P` under `[P in keyof T]`,
// which then captured it (`P[]` became `"p"[]`). Also what keeps an outer same-named substitution out of the body.
function renameMappedKey(m: TS.MappedType): TS.MappedType {
	const keyName	= freshTypeParamName(m.keyName);
	const rename	= new Map([[m.keyName, TS.RefType(keyName)]]);
	return { ...m, keyName, valueType: substituteType(m.valueType, rename), nameType: m.nameType && substituteType(m.nameType, rename) };
}

// Chained generic method calls (a builder returning `TableBuilder<T & X>`, called repeatedly) each
// substitute the *previous* call's own already-substituted return type back in as `T` -- without sharing,
// every step embeds a full fresh copy of everything before it, so the resulting type's own node count
// (not just how often it gets walked) doubles per chained call: confirmed empirically, a 20-call chain
// produced 2^19 distinct 'ref' nodes for the same class, all genuinely different objects (a `WeakSet`
// scan found zero repeats), so no amount of memoizing *readers* of the type (`resolve`, `lookupMember`)
// can fix this -- the type itself has to stop duplicating. Reference-keyed per binding, not structural:
// map values here are typically other structurally-shared types by the time this cache has been warm for
// a while, so identity is enough, and it avoids the stringification cost a `typeKey`-based key would add
// on every call (tried first; it relocated the exponential cost into printing instead of removing it).
const substituteTypeCache = new WeakMap<Type, Map<string, WeakMap<Type, Type>>>();

// A signature's own type parameters SHADOW the same outer names (`class G<T> { foo<T>(t: X<T>) }`: G's T never reaches foo's).
// Undefined when nothing is shadowed; otherwise `sig` with only the outer names it doesn't redeclare substituted.
function substituteShadowed<S extends TS.CallSig>(sig: S, map: Map<string, Type>): S | undefined {
	const own = sig.typeParams;
	if (!own?.some(p => map.has(p.name)))
		return undefined;
	const outer = new Map([...map].filter(([name]) => !own.some(p => p.name === name)));
	return outer.size ? mapSigTypes(sig, t => substituteType(t, outer)) : sig;
}

// TS's rule for a missing type argument: a parameter's DEFAULT may name the parameters before it (`Call<E, A = E>` in common.ts),
// so each default is instantiated with the arguments already chosen -- otherwise the bare parameter escapes into the member types.
export function typeArgMap(typeParams: readonly TS.TypeParam[], typeArgs: readonly Type[] | undefined, fallback: Type = ANY): Map<string, Type> {
	const map = new Map<string, Type>();
	typeParams.forEach((p, i) => map.set(p.name, typeArgs?.[i] ?? (p.default ? substituteType(p.default, map) : fallback)));
	return map;
}

// Replaces type-parameter references with their instantiating arguments (`Foo<string>` -> Foo's body with T := string).
export function substituteType(t: Type, map: Map<string, Type>): Type {
	if (map.size === 1) {
		const [[name, arg]] = map;
		let byName = substituteTypeCache.get(t);
		if (!byName)
			substituteTypeCache.set(t, byName = new Map());
		let byArg = byName.get(name);
		if (!byArg)
			byName.set(name, byArg = new WeakMap());
		const cached = byArg.get(arg);
		if (cached)
			return cached;
		const result = uncached();
		byArg.set(arg, result);
		return result;
	}
	return uncached();

	function uncached(): Type {
		return walker(undefined, undefined,
			rewriteOnce((x: Type, process: <T extends Type>(x: T) => T) => {
				if (x.type === 'ref' && !x.typeArgs && map.has(x.name))
					return map.get(x.name);
				if (x.type === 'function' || x.type === 'constructor') {
					x = { ...x, ...avoidCapture(x, map) };
					const shadowed = substituteShadowed(x, map);
					if (shadowed)
						return shadowed;
				}
				if (x.type === 'mapped') {
					const key = x.keyName;
					if (map.has(key) || [...map.values()].some(v => mentionsTypeParam(v, key)))
						x = renameMappedKey(x);
				}
				// A rebuilt union or intersection is reduced as TS reduces an instantiated one: `T & U` at `{}` and `any` is `any`.
				const r = process(x);
				return r.type === 'union' || r.type === 'intersection' ? reduceInstantiated(r) : r;
			}),
			// An interface/class method's own generic signature (`Array<T>.map<U>`) is a `TypeMember` node
			// (`method`/`call`/`construct`), not a `Type` one -- `avoidCapture` needs the same treatment here,
			// or a method's own type parameter only gets capture-avoidance when it's reachable through a bare
			// `function`/`constructor` type, missing every interface/class member signature (the common case).
			rewriteOnce((m: TS.TypeMember, process: <T extends TS.TypeMember>(x: T) => T) => {
				if (m.type === 'method' || m.type === 'call' || m.type === 'construct') {
					m = { ...m, ...avoidCapture(m, map) };
					const shadowed = substituteShadowed(m, map);
					if (shadowed)
						return shadowed;
				}
				return process(m);
			})
		).type(t) ?? t;
	}
}

// Each type parameter at its constraint (`unconstrained` when it has none). A constraint may name a sibling in either
// direction (`<K extends keyof T, T>`); constraints are acyclic, so n-1 passes settle them.
export function constraintMap(typeParams: readonly TS.TypeParam[], unconstrained: Type = UNKNOWN): Map<string, Type> {
	const map = new Map(typeParams.map(p => [p.name, p.constraint ?? unconstrained] as const));
	for (let i = 1; i < map.size; i++)
		map.forEach((t, name) => map.set(name, substituteType(t, map)));
	return map;
}

// `sig` with its own type parameters replaced per `map`, no longer generic.
export function instantiateSig<S extends TS.CallSig>(sig: S, map: Map<string, Type>): S {
	return { ...mapSigTypes(sig, t => substituteType(t, map)), typeParams: undefined };
}

// TS's `getBaseSignature`: `sig`'s own type parameters replaced by their constraints, so none escapes its binder.
export function baseSignature<S extends TS.CallSig>(sig: S, unconstrained: Type = UNKNOWN): S {
	return sig.typeParams?.length ? instantiateSig(sig, constraintMap(sig.typeParams, unconstrained)) : sig;
}

// Whether a node of `kind` occurs anywhere in `t`.
function containsKind(t: Type, kind: Type['type']): boolean {
	return walkerB(undefined, undefined, searchOnce((x: Type, process: (x: Type) => boolean) => x.type === kind || process(x))).type(t);
}

// Replaces a `this` type node with `thisType`, the concrete class ref codegen needs up front. A walk rebuilds every node, so a type
// with no `this` is returned as the same object, keeping every identity-keyed cache downstream (`resolve`, `lookupMember`) warm.
export function substituteThisType(t: Type, thisType: Type): Type {
	return containsKind(t, 'this') ? walker(undefined, undefined, rewriteOnce((x: Type, process: <T extends Type>(x: T) => T) =>
		x.type === 'this' ? thisType : process(x)
	)).type(t) ?? t : t;
}

// Whether `name` occurs somewhere `inferTypeArgs` would actually descend into -- tells "no argument could ever determine
// this" apart from "an argument should have but didn't" (a real gap). Mirrors `inferTypeArgs`'s recursion shape, not a blanket walk.
const mentionsCache = new WeakMap<Type, Map<string, boolean>>();
export function mentionsTypeParam(t: Type, name: string): boolean {
	let byName = mentionsCache.get(t);
	if (!byName)
		mentionsCache.set(t, byName = new Map());
	let r = byName.get(name);
	if (r === undefined)
		byName.set(name, r = mentions(t, name));
	return r;
}
function mentions(t: Type, name: string): boolean {
	return walkerB(undefined, undefined, searchOnce((t: Type, process: (x: Type) => boolean, recurse: WalkerB) => {
		switch (t.type) {
			case 'ref':				return t.typeArgs ? process(t) : t.name === name;
			case 'function':
			case 'constructor':		return t.params.some(p => recurse.type(p.typeAnnotation)) || recurse.type(t.returnType);
			case 'object':			return t.members.some(m =>
				m.type === 'property' ? recurse.type(m.typeAnnotation)
				: m.type === 'method' ? recurse.type(m.returnType)
				: false
			);
			case 'conditional':		return recurse.type(t.trueType) || recurse.type(t.falseType);
			case 'array': case 'tuple': case 'intersection': case 'union': case 'predicate':
				return process(t);
			// `keyof`/`indexed_access`/`mapped`/`typeof`/`this`/`template_literal`/`infer`: not positions `inferTypeArgs` inverts.
			default:				return false;
		}
	})).type(t);
}

// A declared type's body with `typeArgs` substituted for its parameters (their defaults where missing).
function instantiateEntry(entry: TypeEntry, typeArgs: readonly Type[] | undefined): Type {
	return entry.typeParams?.length ? substituteType(entry.type, typeArgMap(entry.typeParams, typeArgs)) : entry.type;
}

// Expands a `ref` one level into its declared body (substituting type args), without recursing further:
// named refs nested inside it stay names rather than getting eagerly flattened too.
export function expandRefOnce(scope: Scope, t: Type): Type {
	if (t.type !== 'ref')
		return t;
	const entry = ownScope(t, scope).lookupType(t.name);
	return entry ? instantiateEntry(entry, t.typeArgs) : t;
}

// ===================================================================
//  Resolution
// ===================================================================

// Does this ref name a real `class`? `resolve` keeps such a ref nominal (see its own `case 'ref'`), so
// every consumer that used to be handed a class's expanded structural shape now meets the ref instead.
export function isClassRef(t: Type, scope: Scope): boolean {
	if (t.type !== 'ref' || INTRINSIC_TYPES.has(t.name))
		return false;
	const [ns, name] = declScopeOf(t, scope).qualified(t.name);
	return ns?.decl(name)?.type === 'class_decl';
}

// Whether `t` derives from a genuinely uninstantiated type parameter (never registered in `scope`) rather than just being
// structurally complex. `indexed_access` passes the question through to its inner position.
function isAbstract(t: Type, scope: Scope): boolean {
	switch (t.type) {
		// A CLASS ref is the opposite of abstract -- it is a fully concrete named type. It only reaches
		// here at all because `resolve` stopped expanding it; calling it abstract made a conditional
		// (`T extends number | rational ? ...`) refuse to pick a branch and union both instead.
		// A DOTTED name is never a type parameter -- those are always bare. `scope.type` doesn't split on
		// '.', so a namespace-qualified type (`TS.Stmt`) looked unbound and every conditional over one
		// stayed deferred: `Extract<TS.Stmt, {type:'module_decl'}>` resolved to `never` despite `TS.Stmt`
		// resolving perfectly well to its 33 members.
		// Looked up where `resolve` looks it up, in the ref's own `declScope`: a stamped member of an imported union
		// (`EnumDecl` in `Stmt & {type:'switch'}`) is unknown to the ambient scope, and treating it as unbound kept it unreduced.
		case 'ref': {
			const home = declScopeOf(t, scope);
			return !t.typeArgs && !t.name.includes('.') && !INTRINSIC_TYPES.has(t.name) && !isClassRef(t, home) && (!home.type(t.name) || !!home.type(t.name)?.isTypeParam);
		}
		case 'indexed_access':	return isAbstract(t.object, scope) || isAbstract(t.index, scope);
		default:				return false;
	}
}

// Does `t` mention an unbound type parameter anywhere reachable? `isAbstract` only answers for a bare
// ref; a conditional's decidability also depends on one buried in an object member or a type argument
// (`{type: T}`, `Node<T>`). Exported for `instantiate`, which uses it to tell a real inference result
// from one that is still carrying an OUTER call's unsolved parameters.
export function mentionsAbstract(t: Type, scope: Scope, depth = 4): boolean {
	if (depth < 0)
		return false;
	if (isAbstract(t, scope))
		return true;
	switch (t.type) {
		case 'union': case 'intersection':	return t.types.some(m => mentionsAbstract(m, scope, depth - 1));
		case 'array':						return mentionsAbstract(t.element, scope, depth - 1);
		case 'tuple':						return t.elements.some(e => { const el = tupleElementType(e); return !!el && mentionsAbstract(el, scope, depth - 1); });
		case 'ref':							return (t.typeArgs ?? []).some(a => mentionsAbstract(a, scope, depth - 1));
		case 'object':						return t.members.some(m => (m.type === 'property' || m.type === 'index') && mentionsAbstract(m.typeAnnotation, scope, depth - 1));
		default:							return false;
	}
}

// `X[i]`, reduced ONE step to the element it names when `X` is a tuple or array -- the element itself left exactly
// as written, so a named ref inside stays a ref. Anything else is returned untouched.
function oneStepIndexed(t: Type, scope: Scope): Type {
	if (t.type !== 'indexed_access')
		return t;
	const obj = resolveOwn(t.object, scope);
	const idx = resolveOwn(t.index, scope);
	if (obj.type === 'tuple' && idx.type === 'literal' && typeof idx.value === 'number')
		return (obj.elements[idx.value] && tupleElementType(obj.elements[idx.value])) || t;
	if (obj.type === 'array' && isNumberLike(idx, scope))
		return obj.element;
	return t;
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

// The text each member of a template interpolation contributes, or undefined when some member isn't a finite literal.
function templateTexts(t: Type, scope: Scope): string[] | undefined {
	const out: string[] = [];
	for (const m of unionMembers(t, scope).map(m => resolve(scope, m))) {
		if (m.type === 'literal' && !Array.isArray(m.value))
			out.push(String(m.value));
		else if (m.type === 'range' && m.min !== undefined && m.min === m.max)
			out.push(String(m.min));
		else if (isRef(m, 'boolean'))
			out.push('false', 'true');
		else if (isRef(m, 'null') || isRef(m, 'undefined'))
			out.push(isRef(m, 'null') ? 'null' : 'undefined');
		else
			return undefined;
	}
	return out;
}

// A template literal type whose interpolations are all finite is the union of its cross product -- what gives a mapped
// type over `${E}${E}` real keys. tsc refuses past 100,000 members; this leaves such a type unexpanded instead.
function expandTemplate(parts: JS.TemplatePart<Type>[], scope: Scope): Type | undefined {
	let acc = [''];
	for (const p of parts) {
		const texts = p.exp ? templateTexts(p.exp, scope) : [''];
		if (!texts || acc.length * texts.length > 100000)
			return undefined;
		acc = acc.flatMap(a => texts.map(x => a + p.str + x));
	}
	return combineTypes(acc.map(x => Literal(x)));
}

// A regex matching every string an unexpanded template literal type denotes; an interpolation it can't pin down matches anything.
function templatePattern(parts: JS.TemplatePart<Type>[], scope: Scope): string {
	const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const part = (t: Type): string => {
		const texts = templateTexts(t, scope);
		if (texts)
			return `(?:${texts.map(esc).join('|')})`;
		const r = resolve(scope, t);
		return isRef(r, 'number') ? '(?:[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?|NaN|-?Infinity)'
			: isRef(r, 'bigint') ? '-?\\d+'
			: r.type === 'literal' && Array.isArray(r.value) ? `(?:${templatePattern(r.value, scope)})`
			: '[\\s\\S]*';
	};
	return parts.map(p => esc(p.str) + (p.exp ? part(p.exp) : '')).join('');
}

// The disjoint domain of a resolved intersection member (TS's DisjointDomains, `void` counted as `undefined`), 'structural'
// for an object type, undefined when unknown (a type parameter, an unresolved name).
type Domain = PRIMITIVES | 'structural' | undefined;
function domainOf(r: Type, scope: Scope): Domain {
	switch (r.type) {
		case 'literal':	return literalType(r) as Domain;
		case 'range':	return r.base;
		case 'object': case 'array': case 'tuple': case 'function': case 'constructor':
			return 'structural';
		case 'ref':		return r.name === 'void' ? 'undefined' : PRIMITIVES.has(r.name) ? r.name : isClassRef(r, scope) ? 'structural' : undefined;
		default:		return undefined;
	}
}

type Unit = string | number | bigint | boolean;
const unitOf = (r: Type): Unit | undefined => r.type === 'literal' && !Array.isArray(r.value) && r.value !== null ? r.value
	: r.type === 'range' && r.min !== undefined && r.min === r.max ? r.min : undefined;

// TS's intersection normalization (getIntersectionType): it distributes over a union member (`NonNullable<A | B>` is `A | B`);
// `unknown`, a `{}` beside an object type and a primitive beside its own unit literal drop out; disjoint domains, a nullish member
// beside an object type, distinct unit literals or conflicting literal discriminants make it `never`. Undefined when nothing
// reduces. Members are kept as written (refs keep their names); one mentioning a type parameter stays opaque, as TS defers it.
function reduceIntersection(t: TS.IntersectionType, scope: Scope, depth: number): Type | undefined {
	const raw: Type[] = [], res: Type[] = [];
	// `d`: depth left at each nesting level; once spent a member stays as written, never meeting `resolve`'s bail to `any`.
	const add = (p: Type, d: number) => {
		const r = d < 0 || isAbstract(p, scope) ? p : resolve(scope, p, d);
		if (r.type === 'intersection') {
			r.types.forEach(q => add(q, d - 1));
		} else {
			raw.push(p);
			res.push(r);
		}
	};
	t.types.forEach(p => add(p, depth - 1));
	// `any`/`unknown` must be the part AS WRITTEN: `resolve` answers `any`/`unknown` when it gives up (a deferred
	// conditional, a depth bail), and discarding such a part would turn "couldn't evaluate" into a reduction.
	if (res.some((r, i) => isRef(r, 'any') && isRef(raw[i], 'any')))
		return ANY;
	if (res.some(r => isRef(r, 'never')))
		return NEVER;

	const u = res.findIndex(r => r.type === 'union');
	if (u >= 0) {
		const lists = res.map((r, i) => r.type !== 'union' ? [raw[i]] : r === raw[i] ? r.types : unionMembers(raw[i], scope));
		if (lists.reduce((n, l) => n * l.length, 1) > 100000)
			return undefined;	// tsc refuses such a type as too complex to represent
		return combineTypes(lists[u].map(m => {
			const each = TS.IntersectionType(raw.map((p, i) => i === u ? m : p));
			return reduceIntersection(each, scope, depth - 1) ?? each;
		}));
	}

	const doms	= res.map(r => domainOf(r, scope));
	const prims	= new Set(doms.filter(d => d && d !== 'structural'));
	if (prims.size > 1 || ((prims.has('undefined') || prims.has('null')) && doms.includes('structural') && scope.strictNullChecks()))
		return NEVER;
	const units		= res.map(unitOf);
	const values	= new Set(units.filter(v => v !== undefined));
	if (values.size > 1)
		return NEVER;

	// A literal discriminant two object members both declare, read as written: resolving property types here would expand
	// recursive types (`OwnerList<U> extends List<List<U>>`) and force a class's lazily inferred fields.
	const objects = res.filter((r): r is TS.ObjectType => r.type === 'object');
	if (objects.length > 1) {
		const declared = new Map<string, number>();
		for (const o of objects)
			for (const m of o.members)
				if (m.type === 'property' && typeof m.key === 'string')
					declared.set(m.key, (declared.get(m.key) ?? 0) + 1);
		const written = (a: Type): Unit[] | undefined => {
			const vals: Unit[] = [];
			for (const m of a.type === 'union' ? a.types : [a]) {
				const v = unitOf(m);
				if (v === undefined)
					return undefined;
				vals.push(v);
			}
			return vals;
		};
		const shared = new Map<string, Unit[]>();
		for (const o of objects) {
			for (const m of o.members) {
				if (m.type !== 'property' || typeof m.key !== 'string' || declared.get(m.key)! < 2 || m.modifiers?.includes('optional'))
					continue;
				const vals = written(m.typeAnnotation);
				if (!vals)
					continue;
				const prev	= shared.get(m.key);
				const both	= prev ? prev.filter(v => vals.includes(v)) : vals;
				if (!both.length)
					return NEVER;
				shared.set(m.key, both);
			}
		}
	}

	const isEmpty		= (r: Type) => r.type === 'object' && !r.members.length;
	const hasObject		= res.some((r, i) => doms[i] === 'structural' && !isEmpty(r));
	const unitDomain	= values.size ? domainOf(res[units.findIndex(v => v !== undefined)], scope) : undefined;
	const kept			= raw.filter((_, i) => !(isRef(raw[i], 'unknown') || (hasObject && isEmpty(res[i])) || (unitDomain && units[i] === undefined && res[i].type === 'ref' && doms[i] === unitDomain)));

	return kept.length === raw.length ? undefined : !kept.length ? UNKNOWN : kept.length === 1 ? kept[0] : TS.IntersectionType(kept);
}

// How many times `resolve` has run out of depth: a result produced while one did depends on the caller's depth, not on the type.
let depthBails = 0;

export function resolve(scope: Scope, t: Type, depth = 10, stopAtRef = false): Type {
	const idx = stopAtRef ? 1 : 0;
	const slot = scope.resolveCache?.get(t);
	if (slot?.[idx] !== undefined)
		return slot[idx];

	if (scope.resolving?.has(t)) {
		scope.hitDepthLimit('Scope.resolve(circular)');
		// Stays opaque rather than returning `ANY` like the `depth` bail below: `ANY` would silently *pass* every
		// assignability check involving a circular type instead of reporting the honest "couldn't verify" gap.
		return t;
	}

	if (depth < 0) {
		scope.hitDepthLimit('Scope.resolve');
		depthBails++;
		return ANY;
	}

	(scope.resolving ??= new Set).add(t);
	const bails		= depthBails;
	const result	= uncached();
	scope.resolving.delete(t);
	if (depthBails !== bails)
		return result;

	const entry = (scope.resolveCache ??= new WeakMap).get(t) ?? [undefined, undefined];
	entry[idx]	= result;
	scope.resolveCache.set(t, entry);
	return result;

	function uncached(): Type {
		switch (t.type) {
			// A polymorphic `this` that knows its class resolves as that class; a declared `: this` has no class and stays opaque.
			case 'this':
				return t.of ? resolve(scope, t.of, depth - 1, stopAtRef) : t;

			case 'literal':
				return Array.isArray(t.value) ? expandTemplate(t.value, scope) ?? t : t;

			// An array's own element never got resolved recursively at all before this case existed -- e.g. `Record<string,
			// number>['string']`-shaped indexed access (a mapped type's homomorphic value collapsing down to a plain
			// index-signature's own value type, per `case 'indexed_access'` above) stayed opaque forever once tucked
			// inside a `V[]` field, even though resolving it *directly* already worked -- backend.ts's own generic-array-
			// element-kind lookup (`ownerFor`'s `w.type === 'array'` case) never got a chance to see the real, concrete
			// element type as a result, silently defaulting a scalar array field to boxed/`any` storage instead.
			case 'array': {
				// A wasm pseudo-type element (`i8[]`/etc, see `WASM_PSEUDO_TYPES`'s own comment) must survive resolution
				// intact, same reason `hoistVar`'s own `stopAtPseudoType` guard exists -- backend.ts's `wasmTypeOf` matches
				// `WASM_PSEUDO_TYPES` names directly off `t.element`, never through `resolve`'s own alias-unwrapping;
				// resolving `i8` down to its declared `number` alias here would silently pick the wrong physical element
				// kind for a typed-array-backed field/local (a real, observed regression -- `Uint8Array`'s own literal-
				// argument constructor picked `f64` storage for what should stay `i8`).
				if (t.element.type === 'ref' && !t.element.typeArgs && WASM_PSEUDO_TYPES.has(t.element.name))
					return t;
				// Always `stopAtRef` here, regardless of the outer call's own value -- the element is a nested part of
				// the *array* type, not the value resolution ultimately returns, so a named class/interface/alias element
				// (`Animal[]`) must stay that clean ref, not get fully expanded into its own structural member list: many
				// callers (`ownerFor`'s own class-dispatch lookup, chief among them) need the element's real *name* to
				// resolve a method call on an array element (`animals[0].sound()`) -- an expanded structural shape has no
				// name left to dispatch by at all. Only `indexed_access`/`mapped`/`keyof`/etc *composition* need real
				// resolution through to a concrete shape; a plain named element type never does.
				const element = resolve(scope, t.element, depth - 1, true);
				return element === t.element ? t : TS.ArrayType(element, t.readonly);
			}
			case 'mapped': {
				// Members are only knowable once the key constraint resolves to a literal (or union of literals); anything else stays opaque.
				// `keyof T & U`-shaped constraints (restricting a homomorphic key set further, e.g. to `string | number`)
				// aren't a single case `resolve()` reduces on its own -- pick whichever intersection member resolves to a
				// literal/union-of-literals as the effective key set. Doesn't verify the *other* members don't further
				// exclude some of those literals (true for the common "restrict to string|number" idiom, where every
				// `keyof T` result already qualifies) -- same best-effort spirit as the rest of this function.
				// Every string-literal key a constraint denotes, resolving as it descends: `resolve` reduces a
				// union but leaves its MEMBERS alone, so `WasmScalarI | 'i8' | 'ref'` arrives with one
				// member still an alias to a further union and a flat `every(isLiteral)` test fails on it.
				const literalKeys = (x: Type) => {
					const parts = unionMembers(x, scope).map(m => resolve(scope, m)).map(m => isLiteral(m, 'string') && !Array.isArray(m.value) ? m.value : undefined);
					return parts.length && parts.every((p): p is string => p !== undefined) ? parts : undefined;
				};
				// A HOMOMORPHIC mapped type over an ARRAY or TUPLE maps its ELEMENTS and keeps its
				// array/tuple-ness -- real TS's own rule. `{[K in keyof T]: F<T[K]>}` with `T = string[]`
				// is `F<string>[]`, never an object keyed by numeric indices, so the literal-keys path
				// below can never answer it and the whole mapped type stayed opaque. That is how tison's
				// own `ValuesOf<readonly GrammarSym[]>` -- and with it every grammar `Action`'s parameter
				// -- ended up with no representation at all.
				if (!t.nameType && t.constraint.type === 'keyof') {
					const src = resolve(scope, t.constraint.argument, depth - 1);
					// `T[K]` is what the value type actually reads, so `K` binds to the INDEX: `number` for
					// an array (every position has the same element type), each position's own literal for
					// a tuple.
					const atKey = (k: Type) => resolve(scope, substituteType(t.valueType, new Map([[t.keyName, k]])), depth - 1, stopAtRef);
					if (src.type === 'array')
						return TS.ArrayType(atKey(NUMBER), src.readonly);
					if (src.type === 'tuple')
						return { type: 'tuple', elements: src.elements.map((el, i) => tupleElementType(el) ? atKey(Literal(i)) : el) };
				}
				const constraintParts	= t.constraint.type === 'intersection' ? t.constraint.types : [t.constraint];
				const resolvedParts	= constraintParts.map(m => resolve(scope, m, depth - 1));
				const constraint	= resolvedParts.find(m => literalKeys(m)) ?? resolvedParts[0];
				const keys			= literalKeys(constraint);
				if (keys) {
					// Homomorphic case (`[P in keyof T]`): each synthesized property starts from *that* key's own modifiers on `T`,
					const keyofArg		= constraintParts.find(m => m.type === 'keyof')?.argument;
					const source		= keyofArg ? resolve(scope, keyofArg, depth - 1) : undefined;
					const modifiersFor	= (key: string) => source?.type === 'object'
						? mapMemberModifiers(findTypeMember(source.members, key)?.modifiers, t.modifiers)
						: t.modifiers;

					if (t.nameType) {
						// `as` key-remapping clause: each candidate key's own *output* name (or omission, via `never`) is
						// determined by evaluating `nameType` with that key substituted in -- unlike the plain case below,
						// a key can vanish entirely or rename itself, so this can't just reuse each input key unconditionally.
						// If any candidate's output key can't be pinned down to a literal (or `never`), stay opaque on the
						// whole mapped type rather than guess -- same caution as everywhere else in this function.
						const entries: TS.TypeMember[] = [];
						for (const key of keys) {
							const named = resolve(scope, substituteType(t.nameType, new Map([[t.keyName, Literal(key)]])), depth - 1);
							if (named.type === 'ref' && named.name === 'never')
								continue;
							if (!isLiteral(named, 'string') && !isLiteral(named, 'number'))
								return t;
							entries.push(TS.TypeProperty(String(named.value), substituteType(t.valueType, new Map([[t.keyName, Literal(key)]])), modifiersFor(key)));
						}
						return resolve(scope, TS.ObjectType(entries), depth - 1, stopAtRef);
					}

					return resolve(scope, TS.ObjectType(keys.map(key => TS.TypeProperty(
						key,
						substituteType(t.valueType, new Map([[t.keyName, Literal(key)]])),
						modifiersFor(key)
					))), depth - 1, stopAtRef);
				}
				// `Record<string,T>`-shaped mapped types, the most common non-literal-key shape -- modeled as an index signature
				// rather than staying opaque; a homomorphic `valueType` referencing its own key substitutes the constraint in.
				// (`nameType` isn't handled here -- a non-literal key can't be individually remapped/omitted, so this shape
				// stays opaque if the mapped type has an `as` clause.)
				if (!t.nameType && (isKeyable(constraint) || (constraint.type === 'union' && constraint.types.every(isKeyable)))) {
					return resolve(scope, TS.ObjectType([
						TS.TypeIndex('key', constraint, substituteType(t.valueType, new Map([[t.keyName, constraint]])), t.modifiers)
					]), depth - 1, stopAtRef);
				}
				break;
			}

			case 'indexed_access': {
				// `T[K]`: resolvable when the index resolves to a literal (or union of literals), by looking up
				// each corresponding member -- or when it is the `number` TYPE, the standard "element type of
				// this array" idiom (`typeof LIB_DECLS[number]`), which means every position at once.
				const index = resolve(scope, t.index);
				// `T[number]` means every position at once: an array's element, or a tuple's elements unioned. A numeric literal
				// into a tuple (the `FlatArray` idiom) reads one position, which the string-keyed lookups below have no notion of.
				if (isRef(index, 'number') || isLiteral(index, 'number')) {
					const object	= resolve(scope, t.object);
					const read		= object.type === 'array' ? object.element
						: object.type !== 'tuple' ? undefined
						: isLiteral(index, 'number') ? tupleReadType(object, index.value, scope) ?? ANY
						: combineTypes(elementTypes(object, scope));
					if (read)
						return resolve(scope, read, undefined, stopAtRef);
				}
				// A mapped type's own value, for *any* index expression (not just a resolvable literal) --
				// `{[K in C]: V}[X]` is just `V` with `K := X` substituted throughout, by construction,
				// regardless of whether `X` itself ever resolves to something concrete. This is what lets
				// `Partial<T>` (`{[P in keyof T]?: T[P]}`) compose correctly when `T` is *itself* another
				// mapped type (e.g. `Partial<{[K in keyof N]: V}>`, walker.ts's own `NodeMap<N>` idiom) --
				// without it, `T[P]` stays opaque and the whole homomorphic-mapped-type-over-another-
				// mapped-type shape never resolves to anything codegen (or further checking) can use.
				// Peels through `ref` aliases only (`expandRefOnce`, looped) rather than a full `resolve()` --
				// a keyable-constraint mapped type (`Record<string,T>`-shaped) reduces itself into a plain
				// index-signature object one case up in this same switch, so a full resolve here would
				// already have collapsed it before this check ever saw `'mapped'`, permanently missing this
				// composition for exactly the common case (`Partial<Record<string,T>>` and the like).
				let peeled = t.object;
				for (let i = 0; i < depth && peeled.type === 'ref' && !INTRINSIC_TYPES.has(peeled.name); i++)
					peeled = expandRefOnce(scope, peeled);

				if (peeled.type === 'mapped')
					return resolve(scope, substituteType(peeled.valueType, new Map([[peeled.keyName, t.index]])), depth - 1, stopAtRef);

				const object	= resolve(scope, t.object, depth - 1);
				const indexKeys	= (index.type === 'union' ? index.types : [index]).map(m => literalString(m));
				const keys		= indexKeys.every(k => k !== undefined) ? indexKeys as string[] : undefined;
				if (keys) {
					// An OPTIONAL property's own `T['k']` includes `undefined`, as TS gives it -- `lookupMember` answers with the
					// declared type alone, so a `S['kind']` annotation read back a required type its own reads never have.
					const parts = keys.map(key => {
						const m = lookupMember(object, key, scope);
						return m && optional(m, memberOptional(object, key, scope));
					});
					if (parts.every(p => !!p))
						return resolve(scope, combineTypes(parts), depth - 1, stopAtRef);
				}
				// `T[K]` where `T` has an index signature and `K` isn't a literal but matches the signature's own
				// key type (e.g. `Record<string,V>[string]`, the shape a mapped type's own homomorphic `T[P]`
				// value reduces to once `P`'s constraint is a bare `keyof N`-derived `string`, not a specific
				// property name) -- real TS gives the index signature's own value type here, same as a literal
				// key lookup would if a matching property actually existed.
				if (object.type === 'object') {
					const idx = indexMembers(object.members).find(m => isAssignable(index, m.paramType, scope));
					if (idx)
						return resolve(scope, idx.typeAnnotation, depth - 1, stopAtRef);
				}
				break;
			}
			case 'keyof': {
				// `keyof any` is an intrinsic, equal to every legal property-key type -- checked on the raw argument, not `resolve()`'s
				// output, since `resolve` also returns `ANY` as a "gave up" sentinel once its depth budget runs out, not just for real `any`.
				if (isAny(t.argument))
					return TS.UnionType([TS.RefType('string'), TS.RefType('number'), TS.RefType('symbol')]);
				const arg = resolve(scope, t.argument, depth - 1);
				// A mapped type's own keys ARE its constraint, by construction -- `keyof {[K in C]: V}` is
				// just `C` itself (the same "homomorphic mapped type" collapse real TS performs), composing
				// with `indexed_access`'s own mapped-type case above so `Partial<{[K in C]: V}>` (itself a
				// mapped type wrapping another one) still resolves correctly rather than staying opaque.
				if (arg.type === 'mapped')
					return resolve(scope, arg.constraint, depth - 1, stopAtRef);
				// An object made purely of an index signature has no enumerable literal keys -- `keyof` of it is just the index's own
				// key type (real TS: `keyof Record<string,T>` is `string`, not `never`), distinct from the finite-keys case below.
				if (arg.type === 'object' && arg.members.length && arg.members.every(m => m.type === 'index'))
					return resolve(scope, combineTypes(arg.members.map(m => m.paramType)), depth - 1, stopAtRef);
				// Paired with `indexed_access` above, resolves the common `(typeof Round)[keyof typeof Round]` const-object-as-enum idiom end to end.

				const objectKeyNames = (t: Type, scope: Scope, depth: number): string[] | undefined => {
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
				};
				const keys = objectKeyNames(arg, scope, depth - 1);
				if (keys)
					return resolve(scope, combineTypes(keys.map(k => Literal(k))), depth - 1, stopAtRef);
				break;
			}
			case 'conditional': {
				// Only once `checkType` is concrete -- real TS also defers a conditional type until its naked check type is instantiated.
				const check = resolve(scope, t.checkType, depth - 1);
				// An INDEXED ACCESS carries no identity worth keeping raw, and raw it matches nothing: a mapped type over a
				// tuple instantiates `ElemValue<[Box<number>, ':'][0]>`, which must see `Box<number>`.
				const checkType = oneStepIndexed(t.checkType, scope);
				if (!isAny(check) && !isAbstract(check, scope)) {
					if (containsKind(t.extendsType, 'infer')) {
						const bindings = new Map<string, Type>();
						// Not the already-resolved `check` -- resolving would eagerly expand a named type, losing the identity
						// `matchInfer`'s `ref`-typeArgs case needs to match `Promise<infer R>`. Gets its own fresh budget, not `resolve`'s `depth`.
						const r = matchInfer(t.extendsType, checkType, scope, bindings);
						if (r !== undefined)
							return resolve(scope, r ? substituteType(t.trueType, bindings) : t.falseType, depth - 1, stopAtRef);
					} else {
						// Stricter than `isAssignable`: real TS's `extends` says a bare `number` does NOT extend a narrower literal union, unlike ordinary assignability.
						// `undefined` propagates `isLiteralOnly`'s "can't safely decide" -- caller must stay opaque, not guess.
						const extendsType = resolve(scope, t.extendsType, depth - 1);
						const lit = isPrimitive(check) ? isLiteralOnly(extendsType, scope) : false;
						// `t.checkType`, not the already-resolved `check` -- same reasoning as the `infer` branch above: eagerly resolving loses
						// the ref identity `isAssignable`'s same-name fast path needs to confirm "does this class extend itself" cheaply.
						if (lit !== undefined)
							return resolve(scope, lit || !isAssignable(checkType, extendsType, scope) ? t.falseType : t.trueType, depth - 1, stopAtRef);
					}
				} else if (!containsKind(t.extendsType, 'infer')) {
					// `checkType` is a genuinely abstract, unbound type param -- any real instantiation picks exactly one branch, never a
					// blend, so unioning both is a safe over-approximation (skipped when `extendsType` has `infer`, which needs real bindings).
					return resolve(scope, combineTypes([t.trueType, t.falseType]), depth - 1, stopAtRef);
				}
				break;
			}
			case 'typeof': {
				// The query's own `declScope` wins over the ambient one, exactly as `case 'ref'` below does
				// and for the same reason -- the name it queries is a VALUE in its own declaring module.
				const qScope = declScopeOf(t, scope);
				const parts = t.name.split('.');
				let v		= qScope.value(parts[0]);
				for (let i = 1; v && i < parts.length; i++)
					v = lookupMember(v, parts[i], qScope);
				return v ? resolve(qScope, v, depth - 1, stopAtRef) : ANY;
			}
			case 'intersection': {
				const reduced = reduceIntersection(t, scope, depth);
				return reduced ? resolve(scope, reduced, depth - 1, stopAtRef) : t;
			}

			case 'ref':
				if (stopAtRef)
					return t;
				if (!INTRINSIC_TYPES.has(t.name)) {
					// A ref's own `declScope` wins over the ambient `scope` for lookup -- kept local, not
					// reassigned onto `scope` (which `uncached`'s closure shares with `resolve`'s own resolving-set bookkeeping below; reassigning it here used to leak that set onto the wrong scope).
					const refScope		= declScopeOf(t, scope);
					const [ns, name]	= refScope.qualified(t.name);
					if (!ns)
						return t;

					// A ref naming a real CLASS keeps its nominal identity, exactly as `case 'array'` above
					// keeps a named element: this compiler dispatches on a class by NAME (`ownerFor`,
					// `ensureClass`), and an expanded member list has no name left. A consumer that wants
					// the MEMBERS asks for them: `resolveMembers`.
					if (isClassRef(t, refScope))
						return t;
					const entry = ns.type(name);
					if (entry) {
						if (!entry.typeParams?.length)
							return resolve(ns, entry.type, depth - 1, stopAtRef);
						if (!t.typeArgs) {
							entry.defaultSubstitution ??= substituteType(entry.type, typeArgMap(entry.typeParams, undefined));
							return resolve(ns, entry.defaultSubstitution, depth - 1, stopAtRef);
						}
						const tparams	= entry.typeParams;
						const args		= [...typeArgMap(tparams, t.typeArgs).values()];
						const subst		= (as: Type[]) => resolve(ns, substituteType(entry.type, new Map(tparams.map((p, i) => [p.name, as[i]]))), depth - 1, stopAtRef);
						// A conditional alias whose CHECK TYPE is a naked type parameter DISTRIBUTES over a
						// union argument: `Extract<A | B, U>` is `(A extends U ? A : never) | (B extends U ?
						// B : never)`. Tested as a whole instead, the union isn't assignable to the `extends`
						// operand at all, so `Extract`/`Exclude` silently collapsed -- and a member read off
						// one came back `any`. Distributing HERE, not at the conditional itself, because each
						// arm must see the MEMBER substituted for `T` in its branches too, and by the time a
						// conditional node exists that substitution has already happened.
						const check = entry.type.type === 'conditional' ? entry.type.checkType : undefined;
						const naked = check?.type === 'ref' && !check.typeArgs ? tparams.findIndex(p => p.name === check.name) : -1;
						// ...but only once every argument is CONCRETE. An unbound type parameter anywhere
						// leaves the conditional undecidable, and real TS defers it rather than guessing:
						// distributing `realRoot<T>` over `T`'s own constraint invents a union the call site
						// never had, and deciding `Extract<INode, {type: T}>` per member against an abstract
						// `T` matches everything. Both were real false positives.
						if (naked >= 0 && !args.some(a => mentionsAbstract(a, ns))) {
							const members = unionMembers(args[naked], ns);
							if (!members.length)
								return NEVER;	// `Extract<never, X>` is `never`
							if (members.length > 1)
								return combineTypes(members.map(m => subst(args.map((a, i) => i === naked ? m : a))));
						}
						return subst(args);
					}
				}
				break;

		}
		return t;
	}
}

export function resolveOwn(t: Type, scope: Scope): Type {
	return resolve(ownScope(t, scope), t);
}

// The one direction `resolve` deliberately will not go: expanding a named class into its structural
// member list. Every other consumer dispatches on a class by NAME and needs the ref kept intact, so
// this is opt-in -- ask for it only where the MEMBERS are what you actually want (`lookupMember`).
// Expands exactly one level: the members it yields keep their own nominal refs.
export function resolveMembers(t: Type, scope: Scope, depth = 10): Type {
	const r = resolveOwn(t, scope);
	if (r.type !== 'ref' || INTRINSIC_TYPES.has(r.name))
		return r;
	const [ns, name]	= declScopeOf(r, scope).qualified(r.name);
	const entry			= ns?.type(name);
	return ns && entry ? resolve(ns, instantiateEntry(entry, r.typeArgs), depth - 1) : r;
}

// Every member a union could actually BE, resolved and flattened. `resolve` reduces the union itself but
// leaves its MEMBERS alone, and a member can resolve to a further nested union (`type AB = A | B;` used
// in `AB | C`), so a bare `resolved.types` walk silently misses aliases. `never` members are dropped:
// nothing inhabits one, so it can never be the runtime value, and treating it as an unanswerable member
// makes the whole union unanswerable.
//
// That pair -- unresolved members and `never` -- broke four separate places in one session (the `in`
// type test, union field access, union method dispatch, and a mapped type's key constraint), each
// rediscovered independently. Reach for this instead of walking `.types` directly. A non-union returns
// itself, so a caller that doesn't care whether it has a union needs no special case.
export function unionMembers(t: Type, scope: Scope, depth = 8): Type[] {
	const r = resolve(scope, t);
	if (r.type === 'union' && depth > 0)
		return r.types.flatMap(m => unionMembers(m, scope, depth - 1));
	// The RAW `t`, never the resolved `r`: resolving is only how nesting is DISCOVERED. A consumer that
	// matches on nominal identity -- `ownerFor`'s own `ref` fast path, which needs a real class's name and
	// type args -- must still be handed the reference it was given, not the bare structural shape
	// resolving expands it into. (Handing it the resolved form made every `ref.test` arm miss and traps
	// replaced real dispatches.) A consumer wanting the resolved form resolves the member itself.
	return isRef(r, 'never') ? [] : [t];
}

export function flattenIntersection(t: Type, scope: Scope): Type[] {
	const r = resolveOwn(t, scope);
	return r.type === 'intersection' ? r.types.flatMap(t => flattenIntersection(t, scope)) : [r];
}

// Resolves any `Type` down to a real flat `ObjectType`, if possible: an intersection's parts (possibly unresolved refs,
// `CallSig<T>`) are flattened and merged into one, so every caller agrees on one flat shape for a given declared type.
export function resolveObjectType(t: Type, scope: Scope): TS.ObjectType | undefined {
	const w = resolve(scope, t);
	if (w.type === 'object')
		return w;
	if (w.type === 'intersection') {
		const merged = mergeIntersection(TS.IntersectionType(flattenIntersection(w, scope)));
		return merged.type === 'object' ? merged : undefined;
	}
	return undefined;
}

// Every object shape a type expands to as a union member, each beside its own RAW member type. A consumer matching on
// nominal identity must be handed the raw member -- `raw` still names a real interface, which an owner lookup resolves
// by NAME to the one class the dispatch side builds too, where the name-stripped shape alone would build a structural twin.
export function objectShapes(t: Type, scope: Scope): { raw: Type; objT: TS.ObjectType }[] {
	return unionMembers(t, scope).flatMap(raw => {
		const objT = resolveObjectType(raw, scope);
		return objT ? [{ raw, objT }] : [];
	});
}

// The object shape two types share field-wise, each field widened to their union.
export function unionShapes(a: Type, b: Type, scope: Scope): TS.ObjectType | undefined {
	const ra = resolveObjectType(a, scope), rb = resolveObjectType(b, scope);
	if (!ra || !rb)
		return undefined;
	const other = new Map(rb.members.flatMap(m => m.type === 'property' && typeof m.key === 'string' ? [[m.key, m.typeAnnotation] as const] : []));
	return TS.ObjectType(ra.members.map(m => m.type === 'property' && typeof m.key === 'string' && other.has(m.key)
		? { ...m, typeAnnotation: combineTypes([m.typeAnnotation, other.get(m.key)!]) }
		: m));
}

// LEVEL-ORDER (real TS orders inherited call signatures by inheritance depth, and resolution here is
// "first fit wins"): depth-first buries a derived signature behind a SIBLING base's inherited catch-all.
export function collectMembers(t: Type, scope: Scope): TS.TypeMember[] {
	const out: TS.TypeMember[] = [];
	const seen = new Set<Type>();
	for (let level = [t]; level.length; ) {
		const next: Type[] = [];
		for (const p of level) {
			if (seen.has(p))
				continue;
			seen.add(p);
			const r = resolveMembers(p, scope);
			if (r.type === 'object')
				out.push(...r.members);
			else if (r.type === 'intersection')
				next.push(...[...r.types].reverse());
		}
		level = next;
	}
	return out;
}

// ===================================================================
//  Arrays, tuples and rest parameters
// ===================================================================

// `T[]` really is `Array<T>` (a `readonly: true` one `ReadonlyArray<T>`) -- turns the structural `'array'` node into the real named
// ref wherever it's compared, instead of bridging two representations at every call site.
function normalizeArray(t: Type): Type {
	return t.type === 'array' ? TS.RefType(t.readonly ? 'ReadonlyArray' : 'Array', [t.element]) : t;
}
// The element type of an array: a `T[]` node, or an `Array<T>`/`ReadonlyArray<T>` ref (what `normalizeArray` makes of one).
export function arrayLikeElement(t: Type): Type | undefined {
	return t.type === 'array' ? t.element
		: t.type === 'ref' && (t.name === 'Array' || t.name === 'ReadonlyArray') && t.typeArgs?.length ? t.typeArgs[0]
		: undefined;
}

// A spread (`...T`) contributes no single element value; an optional element (`T?`)'s contributed value type is just `T`, consistent with this
// file not modeling "possibly absent" via `| undefined` for optional members elsewhere either.
// `te` is undefined when a literal has more elements than the tuple type it's contextually checked
// against (e.g. `[1, 2, 3]` against an expected `[number, number]`) -- those extra positions just get
// no contextual type, same as an untyped array literal's elements would.
export function tupleElementType(te: TS.TupleElement | undefined): Type | undefined {
	return !te || te.type === 'spread' ? undefined : te.type === 'optional' || te.type === 'labeled' ? te.element : te;
}

// A READ of position `i` (TS's getIndexedAccessType): an optional element may be absent, so it reads `T | undefined`; a position a
// rest spread covers reads the spread's element or any fixed one after it; no type at all past a fixed-length tuple's end.
export function tupleReadType(t: Extract<Type, { type: 'tuple' }>, i: number, scope: Scope): Type | undefined {
	const spreadAt = t.elements.findIndex(e => e.type === 'spread');
	if (spreadAt >= 0 && i >= spreadAt)
		return combineTypes(elementTypes({ ...t, elements: t.elements.slice(spreadAt) }, scope));
	const el = t.elements[i];
	if (!el)
		return undefined;
	const v = tupleElementType(el)!;
	return el.type === 'optional' || (el.type === 'labeled' && el.optional) ? combineTypes([v, UNDEFINED]) : v;
}

// The declared type of the argument sitting at REST position `k`. Usually just the rest's own element,
// but a TUPLE rest names each position separately -- and a UNION of the two shapes names a callback in
// only ONE arm (`Rules<T>(...alts: [(self: () => Rules<T>) => Rules<T>] | Rules<T>)`), so every arm that
// can answer contributes and `resolveFnMember` picks the function out of the combined result.
export function restArgType(rest: Type, k: number, scope: Scope, depth = 4): Type | undefined {
	const r = resolveOwn(rest, scope);
	const element = arrayLikeElement(r);
	if (element)
		return element;
	if (r.type === 'tuple') {
		const el = r.elements[k];
		return !el ? undefined
			: el.type === 'labeled' || el.type === 'optional' ? el.element
			: el.type === 'spread' ? restArgType(el.argument, 0, scope, depth - 1)
			: el;
	}
	if (r.type === 'union' && depth > 0) {
		const parts = r.types.map(t => restArgType(t, k, scope, depth - 1)).filter((t): t is Type => !!t);
		return parts.length ? combineTypes(parts) : undefined;
	}
	return undefined;
}

// Every value an array, a tuple (a spread contributing what it spreads) or a union of them can hold.
// A rest parameter is physically always one array, whose element these combine into.
export function elementTypes(t: Type, scope: Scope, depth = 4): Type[] {
	const r			= resolveOwn(t, scope);
	const element	= arrayLikeElement(r);
	return element ? [element]
		: r.type === 'tuple' ? r.elements.flatMap(e => e.type === 'spread' ? elementTypes(e.argument, scope, depth - 1) : tupleElementType(e) ?? [])
		: r.type === 'union' && depth > 0 ? r.types.flatMap(m => elementTypes(m, scope, depth - 1))
		: [];
}

// A union of arrays/tuples as ONE array of the combined element type -- what real TS (5.2+) calls a
// method on when the union's own signatures don't merge (`(Ty[] | Lit[]).map`).
export function arrayUnionAsArray(t: Type, scope: Scope): TS.ArrayType | undefined {
	const r = resolve(scope, t);
	if (r.type !== 'union')
		return undefined;
	const members = r.types.map(m => resolve(scope, m));
	return members.every(m => m.type === 'array' || m.type === 'tuple')
		? TS.ArrayType(combineTypes(members.flatMap(m => elementTypes(m, scope))), members.some(m => !!m.readonly))
		: undefined;
}

// ===================================================================
//  Member lookup
// ===================================================================

// The `property`/`method` member (the only kinds carrying `modifiers`) named `key` in `members`, if any.
function findTypeMember(members: TS.TypeMember[], key: string): TS.TypeMember & { modifiers?: string[] } | undefined {
	return members.find(m => (m.type === 'property' || m.type === 'method') && memberKey(m.key) === key);
}

type IndexMember = Extract<TS.TypeMember, { type: 'index' }>;
function indexMembers(members: TS.TypeMember[]): IndexMember[] {
	return members.filter((m): m is IndexMember => m.type === 'index');
}

// A property name that is an array index (`'0'`, `'12'`), as a numeric index signature or a tuple position covers.
function isIndexKey(prop: string): boolean {
	return /^(0|[1-9]\d*)$/.test(prop);
}

// The declared value type of a numeric index signature (`[i: number]: T`) reachable from `t` -- searches
// every part of an intersection (declaration merging's usual shape, e.g. an ambient interface merged with
// a real implementing class, see `lib/typedarray.ts`'s own header comment), not just a bare object, since
// `resolve` never flattens one into the other. Shared by `lookupMember`'s own intersection fallback below
// and `checker.ts`'s `case 'index'` (a computed, non-string key has no *named* member to look up at all,
// only ever a numeric index signature).
export function indexSignatureOf(t: Type, scope: Scope, depth = 6): Type | undefined {
	if (depth < 0)
		return undefined;
	const r = resolveOwn(t, scope);
	if (r.type === 'object')
		return indexMembers(r.members).find(m => isNumberLike(m.paramType, scope))?.typeAnnotation;
	if (r.type === 'intersection') {
		// Last part first, as every producer of an intersection here puts the more concrete declaration
		// last: `NodeListOf<T>`'s `[index: number]: T` must beat the `Node` it inherits from `NodeList`.
		for (const part of [...r.types].reverse()) {
			const found = indexSignatureOf(part, scope, depth - 1);
			if (found)
				return found;
		}
	}
	return undefined;
}

// The index signature among `members` that covers key `prop`: a numeric one only a numeric-looking key (it is the more
// specific, as TS requires), a string one every key. A numeric signature must not answer `'push'` for `String`'s `[i: number]`.
function indexSignatureFor(members: TS.TypeMember[], prop: string, scope: Scope): Type | undefined {
	const indexes = indexMembers(members);
	// A well-known symbol key (`memberKey`'s `[Symbol.iterator]`) is covered only by a `symbol` index signature, never a string one.
	if (prop.startsWith('[Symbol.'))
		return indexes.find(m => unionMembers(m.paramType, scope).some(p => isRef(resolveOwn(p, scope), 'symbol')))?.typeAnnotation;
	return ((isIndexKey(prop) && indexes.find(m => isNumberLike(m.paramType, scope))) || indexes.find(m => !isNumberLike(m.paramType, scope)))?.typeAnnotation;
}

// Cached on (t, prop) alone, ignoring `depth`: every real call starts at the default, and depth only gates the truncation bail.
// `skipObjectFallback`: an intersection part must not resolve `Object.prototype` members on its own, or the "first match wins"
// search would stop before reaching a later part's real declaration (e.g. a superclass). Only `case 'intersection'` sets it.
export function lookupMember(t: Type, prop: string, scope: Scope, depth = 10, skipObjectFallback = false): Type | undefined {
	const key	= skipObjectFallback ? prop + '\0skip' : prop;
	let keyMap	= scope.lookupMemberCache?.get(t);
	if (!keyMap)
		(scope.lookupMemberCache ??= new WeakMap).set(t, keyMap = new Map());
	if (keyMap.has(key))
		return keyMap.get(key);

	const result = uncached();

	keyMap.set(key, result);
	return result;

	function uncached(): Type | undefined {
		if (depth < 0) {
			scope.hitDepthLimit('lookupMember');
			return ANY;
		}
		// A bare `ref` stamped with its own `declScope` resolves there instead of in `scope` -- the caller's chain may shadow it (e.g. DOM's `Element`).
		t = resolveMembers(t, scope, depth);
		// A LITERAL type has the members of the primitive it is a literal of. Without this, a method call
		// on a literal receiver -- `'a,b'.split(/,/)`, `(255).toString(16)` -- typed as `any`, and towasm
		// only got away with it because a `var_decl` has a separate path that reads the declared return
		// type straight off the class; the same call used inline (`'a,b'.split(/,/)[0]`) had no type at all.
		if (t.type === 'literal')
			t = widenLiterals(t);
		const refined = scope.semantics.refinedMember(t, prop, scope, depth);
		if (refined)
			return refined;

		switch (t.type) {
			// An array's members are its lib's `Array<T>`'s.
			case 'array':
				return lookupMember(TS.RefType('Array', [t.element]), prop, scope, depth - 1);

			case 'tuple': {
				// A tuple's positions are real properties (`'0'`, `'1'`, ...), which is what lets a union of tuples be indexed and discriminated.
				const at = isIndexKey(prop) && !t.elements.slice(0, +prop).some(el => el.type === 'spread') ? tupleElementType(t.elements[+prop]) : undefined;
				return at ?? lookupMember(TS.RefType('Array', [combineTypes(elementTypes(t, scope))]), prop, scope, depth - 1);
			}

			case 'object': {
				const ms = t.members.filter(m => (m.type === 'property' || m.type === 'method') && memberKey(m.key) === prop);
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
				// A *numeric* index signature (`[i: number]: T`) only covers a numeric-looking key (real TS/JS array-index
				// semantics) -- unguarded, it used to match *any* named lookup at all (`'byteLength'` on a plain `[i:number]:u8`
				// class read the element type back as if `byteLength` were itself an element), which then let e.g. a plain
				// `number[]` (itself index-signature-shaped) structurally satisfy a class it shares no real members with,
				// silently misrouting overload resolution (`isAssignable`'s own `dst.type === 'object'` case). A *string*
				// index signature is untouched -- it always did (and still does) cover every named key, correctly.
				// A numeric key prefers the numeric signature, which real TS requires to be the more specific of the two.
				return indexSignatureFor(t.members, prop, scope)
					?? scope.semantics.apparentMember(prop, t.members.some(m => m.type === 'call' || m.type === 'construct'), scope);
			}
			case 'function':
			case 'constructor':
				return scope.semantics.apparentMember(prop, true, scope);
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
					for (const part of [...t.types].reverse()) {
						const r = resolveOwn(part, scope);
						const idx = r.type === 'object' ? indexSignatureFor(r.members, prop, scope) : undefined;
						if (idx)
							return idx;
					}
					return scope.semantics.apparentMember(prop, false, scope);
				}
				if (matches.length === 1)
					return matches[0];
				// Declaration merging is the common reason more than one part declares `prop`, usually with the *identical* type --
				// dedupe first, which collapses back to the `matches.length === 1` case and keeps single-declaration behavior untouched.
				// A wasm pseudo-type (`i32`/etc, see `WASM_PSEUDO_TYPES`) keys as its real alias target `number` here -- an ambient
				// interface merged with a towasm-internal class implementing it (e.g. `TypedArray`/`lib/typedarray.ts`) commonly
				// redeclares the same member once each way (`number` vs `i32`), which are the *same* declared type, not a genuine
				// conflict; `hoist`'s own pre-pass always processes interfaces before classes, so `matches`' later (class) entry -
				// the physically-precise one backend.ts itself needs - is what survives this `Map`'s last-write-wins dedup.
				const dedupKey = (m: Type) => typeKey(m.type === 'ref' && !m.typeArgs && WASM_PSEUDO_TYPES.has(m.name) ? NUMBER : m);
				const distinct = [...new Map(matches.map(m => [dedupKey(m), m])).values()];
				if (distinct.length === 1)
					return distinct[0];
				// Genuinely different same-named methods across parts is real TS's cross-file overload-merging shape -- combine into
				// one multi-signature set, same as the `object` case; flatten each match's own single-or-already-merged shape first.
				// Reversed (interface-before-class per `hoist`'s pass ordering above): overload resolution's "first arity+type
				// fit wins" (checker.ts's `case 'call'`) must try the concrete class's own signature before an ambiguously-fitting
				// ambient interface stub -- same "most concrete wins" precedent as the dedup path just above.
				const sigs: TS.CallSig[] = [];
				let allSigs = true;
				for (const m of [...distinct].reverse()) {
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
				// constraint applied together -- unlike class-inheritance override, `&`'s parts have no such order. A part made of unit
				// types (`kind: Kind` under an extending `kind: Kind.A`) reduces the whole to its units every part admits, as TS does.
				const units = distinct.map(m => unionMembers(m, scope)).find(ms => ms.every(u => resolveOwn(u, scope).type === 'literal'));
				return units ? combineTypes(units.filter(u => distinct.every(p => isAssignable(u, p, scope)))) : TS.IntersectionType(distinct);
			}
			case 'union': {
				const parts = t.types.map(p => lookupMember(p, prop, scope, depth - 1));
				return parts.every(p => !!p) ? combineTypes(parts as Type[]) : undefined;
			}
			// A primitive value auto-boxes for member access (`"x".toUpperCase()`) -- delegates to its boxed lib interface, same
			// idea as `array` delegating to `Array<T>` above.
			case 'ref': {
				const boxed = scope.semantics.boxed(t.name);
				return boxed ? lookupMember(TS.RefType(boxed), prop, scope, depth - 1) : undefined;
			}
			default:
				return undefined;
		}
	}
}

// A member of the global type `name` as the lib declares it.
function globalTypeMember(name: string, prop: string, scope: Scope): Type | undefined {
	const root = scope.root();
	return root.type(name) ? lookupMember(TS.RefType(name), prop, root, 4, true) : undefined;
}

// The shared vocabulary's apparent members, for a language's `apparentMember`: every value's are the global `Object`'s,
// and anything callable has `Function`'s (`apply`/`call`/`bind`, or Python's `__call__`) first.
export function objectMember(prop: string, callable: boolean, scope: Scope): Type | undefined {
	return (callable ? globalTypeMember('Function', prop, scope) : undefined) ?? globalTypeMember('Object', prop, scope);
}

export function memberOptional(t: Type, prop: string, scope: Scope, depth = 6): boolean {
	return memberOptionalState(t, prop, scope, depth) === 'optional';
}

// `undefined` = `prop` isn't declared by this part at all -- only meaningful within an intersection, where a part
// that doesn't mention `prop` imposes no constraint on it and must neither force it required nor count as optional.
function memberOptionalState(t: Type, prop: string, scope: Scope, depth: number): 'optional' | 'required' | undefined {
	t = resolveMembers(t, scope, depth);
	if (t.type === 'object') {
		const m = findTypeMember(t.members, prop);
		return m ? (hasMod(m, 'optional') ? 'optional' : 'required') : undefined;
	}
	if (t.type !== 'intersection' && t.type !== 'union')
		return undefined;
	if (depth <= 0) {
		scope.hitDepthLimit('memberOptional');
		return undefined;
	}
	// A union's read is each member's read, so one member marking `prop` optional makes the whole read possibly undefined.
	if (t.type === 'union') {
		const states = t.types.map(p => memberOptionalState(p, prop, scope, depth - 1));
		return states.includes('optional') ? 'optional' : states.every(s => s === 'required') ? 'required' : undefined;
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

// A shape is "sealed" when a missing member is genuinely an error (an object type we fully know),
// as opposed to a ref/primitive/array whose built-in members this checker doesn't model.
export function sealed(t: Type, scope: Scope, depth = 6): boolean {
	if (depth < 0) {
		scope.hitDepthLimit('sealed');
		return false;
	}
	t = resolveMembers(t, scope);
	return t.type === 'object' || (t.type === 'intersection' && t.types.every(p => sealed(p, scope, depth - 1)));
}

// ===================================================================
//  Signatures
// ===================================================================

// TS's getMinArgumentCount: through the last parameter a call must pass -- not optional (or defaulted), and not accepting `void`.
export function minArgumentCount(sig: TS.Params, scope: Scope): number {
	const own = sig.params.filter(p => p.key !== 'this');
	let n = own.length;
	while (n > 0 && (hasMod(own[n - 1], 'optional') || (own[n - 1].typeAnnotation && unionMembers(resolveOwn(own[n - 1].typeAnnotation!, scope), scope).some(m => m.type === 'ref' && m.name === 'void'))))
		n--;
	return n;
}

// The declared type of argument `i`: its own parameter's, or past them the rest parameter's at that position.
export function paramTypeAt(sig: TS.Params, i: number, scope: Scope): Type | undefined {
	return i < sig.params.length ? sig.params[i].typeAnnotation
		: sig.rest?.typeAnnotation && restArgType(sig.rest.typeAnnotation, i - sig.params.length, scope);
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

// The signatures of `kind` a value of type `t` is invoked through: a function/constructor type, or an object's (and an
// intersection's) call/construct members.
export function signaturesOf(t: Type, kind: 'call' | 'construct', scope: Scope): TS.CallSig[] {
	const r			= resolveOwn(t, scope);
	const fnKind	= kind === 'call' ? 'function' : 'constructor';
	const parts		= r.type === 'intersection' ? r.types.map(p => resolveOwn(p, scope)) : [r];
	return [
		...parts.flatMap(p => p.type === fnKind ? [p as TS.CallSig] : []),
		...collectMembers(r, scope).flatMap(m => m.type === kind ? [m] : []),
	];
}

// A callee's construct signatures as TS resolves them on an intersection (resolveIntersectionTypeMembers): a MIXIN part -- one
// construct signature taking only `...args: any[]` -- adds none of its own, and its instance type joins every other part's result.
export function constructSignatures(t: Type, scope: Scope): TS.CallSig[] {
	const parts: TS.CallSig[][] = [];
	const collect = (x: Type, depth: number): void => {
		const r = resolveOwn(x, scope);
		if (r.type === 'intersection' && depth > 0)
			r.types.forEach(p => collect(p, depth - 1));
		else if (r.type === 'constructor')
			parts.push([r]);
		else if (r.type === 'object' && r.members.some(m => m.type === 'construct'))
			parts.push(r.members.filter((m): m is TS.TypeMember & TS.CallSig => m.type === 'construct'));
	};
	collect(t, 8);
	const isMixin = (sigs: TS.CallSig[]) => {
		const rest = sigs.length === 1 && !sigs[0].params.length && sigs[0].rest?.typeAnnotation;
		const r = rest && resolveOwn(rest, scope);
		return !!r && r.type === 'array' && isAny(r.element);
	};
	const mixin = parts.map(isMixin);
	if (mixin.length && mixin.every(m => m))
		mixin[0] = false;
	const mixed = parts.flatMap((sigs, i) => mixin[i] ? [sigs[0].returnType ?? ANY] : []);
	return parts.flatMap((sigs, i) => mixin[i] ? [] : mixed.length ? sigs.map(s => ({ ...s, returnType: TS.IntersectionType([s.returnType ?? ANY, ...mixed]) })) : sigs);
}

// TS's resolveUnionSignature: invoking a union invokes whichever member the value is, so an argument must suit every
// member and the result is any of their returns. For members with one signature each, none generic; TS stops at about
// the same. The parameters combine pairwise as TS's combineUnionParameters does.
export function unionSignature(t: Type, kind: 'call' | 'construct', scope: Scope): TS.CallSig | undefined {
	const r = resolveOwn(t, scope);
	if (r.type !== 'union')
		return undefined;
	const sigs = r.types.map(m => signaturesOf(m, kind, scope));
	if (sigs.some(s => s.length !== 1 || s[0].typeParams?.length))
		return undefined;
	const each = sigs.map(s => s[0]);
	const combined = each.slice(1).reduce((a, b) => combineUnionParameters(a, b, scope), each[0]);
	return { params: combined.params, rest: combined.rest, returnType: combineTypes(each.map(s => s.returnType ?? ANY)) };
}

// Each position takes the intersection of both signatures' types there (a missing one constrains nothing), and is optional
// only where both allow no argument. The longer one's rest stays a rest; a rest only the shorter has becomes an extra one.
function combineUnionParameters(left: TS.CallSig, right: TS.CallSig, scope: Scope): TS.CallSig {
	const count		= (s: TS.CallSig) => s.params.length + (s.rest ? 1 : 0);
	const required	= (s: TS.CallSig) => s.params.reduce((n, p, i) => hasMod(p, 'optional') ? n : i + 1, 0);
	const typeAt	= (s: TS.CallSig, i: number) => paramTypeAt(s, i, scope);
	const both		= (a: Type | undefined, b: Type | undefined) => !a ? b ?? ANY : !b ? a : intersectTypes([a, b]);
	const [longest, shorter] = count(left) >= count(right) ? [left, right] : [right, left];
	const n			= count(longest);
	const params: TS.Param[] = [];
	let rest: TS.CallSig['rest'];
	for (let i = 0; i < n; i++) {
		const type = both(typeAt(longest, i), typeAt(shorter, i));
		if (longest.rest && i === n - 1)
			rest = JS.Rest(longest.rest.key, TS.ArrayType(type));
		else
			params.push(JS.Param((longest.params[i] ?? shorter.params[i]).key, type, i >= required(longest) && i >= required(shorter) ? ['optional'] : []));
	}
	if (!longest.rest && !!shorter.rest)
		rest = JS.Rest(shorter.rest!.key, TS.ArrayType(typeAt(shorter, n) ?? ANY));
	return { params, rest };
}

// A union of signatures identical up to their own type-parameter names is ONE signature (real TS's
// `getUnionSignatures`). `(readonly T[] | T[]).map` is that shape: each part minted its own fresh `U`.
export function mergeIdenticalSignatures(t: Type): Type {
	if (t.type !== 'union')
		return t;
	const [first, ...rest] = t.types;
	if (first.type !== 'function')
		return t;
	const names	= first.typeParams?.map(p => p.name) ?? [];
	const key	= typeKey(first);
	const same	= (f: Type) => {
		if (f.type !== 'function' || (f.typeParams?.length ?? 0) !== names.length)
			return false;
		const renamed = names.length ? substituteType(f, new Map(f.typeParams!.map((p, i) => [p.name, TS.RefType(names[i])] as const))) as TS.FunctionType : f;
		return typeKey({ ...renamed, typeParams: renamed.typeParams?.map((p, i) => ({ ...p, name: names[i] })) }) === key;
	};
	return rest.every(same) ? first : t;
}

// A callable candidate reachable through any nesting of unions/intersections/overload-objects -- used below to dig
// out `.then`'s own signature regardless of how many lib files' worth of `Promise<T>` declaration merging it took.
export function findFunctionType(t: Type, scope: Scope): TS.CallSig | undefined {
	const r = resolveOwn(t, scope);
	if (r.type === 'function')
		return r;
	if (r.type === 'object')
		return r.members.find(m => m.type === 'call');
	if (r.type === 'union' || r.type === 'intersection') {
		for (const m of r.types) {
			const f = findFunctionType(m, scope);
			if (f)
				return f;
		}
	}
	return undefined;
}

// ===================================================================
//  Type facts: nullishness, numeric and string kinds
// ===================================================================

export function isNullish(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return	r.type === 'literal'	? r.value === null
		:	r.type === 'ref'		? r.name === 'undefined' || r.name === 'null' || r.name === 'void'
		:	r.type === 'union'		? r.types.every(t => isNullish(t, scope))
		:	false;
}

// The non-nullish remainder of `t` -- `t` itself, unchanged, unless it resolves to a union with at least
// one (but not every) nullish member, in which case those members are dropped. Shared by anything
// implementing optional-chaining semantics (`?.`/`??`), which only ever cares about the non-nullish part
// of a value's type -- e.g. `lookupMember`'s own union case requires *every* member to have the property
// looked up, which a bare `null`/`undefined` member never does, so a `?.` member lookup needs this run on
// the object type first (see `checker.ts`'s own `'member'` case) or it always misses, falling back to `any`.
// `strip = false` keeps `t` whole -- unless `strictNullChecks` is off, where no value is ever treated as possibly nullish.
export function nonNullable(t: Type, scope: Scope, strip = true): Type {
	if (!strip && scope.strictNullChecks())
		return t;
	const r = resolveOwn(t, scope);
	if (r.type !== 'union')
		return t;
	// Each member as written unless it hides a nullish itself (`Maybe<X> | undefined`, `Maybe` one alias down): expanding
	// every member made `Type | undefined` the union of `Type`'s members, which no longer matches `Type` itself.
	const kept = r.types.flatMap(m => isNullish(m, scope) ? [] : [nonNullable(m, scope)]);
	return kept.length === 0 || (kept.length === r.types.length && kept.every((k, i) => k === r.types[i])) ? t : combineTypes(kept);
}

// An inferred declaration or return type, as TS widens one without `strictNullChecks`: `null`/`undefined` leave a union and
// alone become `any`. Identity when strict.
export function widenNullish(t: Type, scope: Scope): Type {
	if (scope.strictNullChecks())
		return t;
	const members	= unionMembers(t, scope);
	const kept		= members.filter(m => !isNullOrUndefined(resolveOwn(m, scope)));
	return !kept.length ? ANY : kept.length === members.length ? t : combineTypes(kept);
}

export function isBigint(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return r.type === 'ref'		? r.name === 'bigint'
		: r.type === 'literal'	? typeof r.value === 'bigint'
		: r.type === 'range'	? r.base === 'bigint'
		: r.type === 'union'	? r.types.every(m => isBigint(m, scope))
		: false;
}

// Inferred unions over-approximate, so only complain when no member could be numeric
export function isNumberLike(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return r.type === 'union' ? r.types.some(m => isAssignable(m, NUMERIC, scope)) : isAssignable(r, NUMERIC, scope);
}

export function isStringLike(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return isString(r)
		|| isLiteral(r, 'string')
		|| (r.type === 'union' && r.types.some(t => isStringLike(t, scope)));
}

// Three-valued: `undefined` is "couldn't fully resolve this" (e.g. an alias not reachable through this `scope`'s import chain) and must not be
// treated as a confirmed `false`, or `conditionalExtends` below would wrongly fall through to the leniency it exists to guard against.
function isLiteralOnly(t: Type, scope: Scope, depth = 6): boolean | undefined {
	switch (t.type) {
		case 'literal':	return true;
		// A CLASS is definitively not a literal union -- `undefined` here means "could not look the name
		// up", which stopped being true for classes once `resolve` began keeping them nominal, and left
		// `string extends RegExp` undecidable in `case 'conditional'`.
		case 'ref':		return INTRINSIC_TYPES.has(t.name) || isClassRef(t, scope) ? false : undefined;
		case 'union':
			if (depth >= 0) {
				const parts = t.types.map(m => isLiteralOnly(resolveOwn(m, scope), scope, depth - 1));
				return parts.some(p => p === false) ? false : parts.every(p => p === true) ? true : undefined;
			}
			scope.hitDepthLimit('isLiteralOnly');
			return undefined;
		default:
			return false;
	}
}

// ===================================================================
//  Assignability
// ===================================================================

// An intersection of type parameters, at their constraints and normalized. Undefined when no part is abstract (nothing to gain)
// or the bound came back unchanged, which would make `isAssignable` ask the same question again.
function intersectionConstraint(t: TS.IntersectionType, scope: Scope): Type | undefined {
	if (!t.types.some(p => isAbstract(p, scope)))
		return undefined;
	const bound = resolve(scope, TS.IntersectionType(t.types.map(p => isAbstract(p, scope) ? resolve(scope, p) : p)));
	return bound.type === 'intersection' && bound.types.length === t.types.length && bound.types.every((b, i) => b === t.types[i]) ? undefined : bound;
}

// `t`'s union constituents, resolved, with `boolean` as `true | false`.
function constituents(t: Type, scope: Scope): Type[] {
	return unionMembers(t, scope).flatMap(m => {
		const r = resolveOwn(m, scope);
		return isRef(r, 'boolean') ? [Literal(true), Literal(false)] : [r];
	});
}
const isUnit = (t: Type) => t.type === 'literal' || isRef(t, 'undefined') || isRef(t, 'null');

// `src` once per combination of its discriminant properties' constituents (a property `dst`'s members discriminate on by a
// unit type), as TS relates an object to a discriminated union; undefined when nothing splits or past TS's 25 combinations.
function splitDiscriminants(src: TS.ObjectType | Extract<Type, { type: 'tuple' }>, dst: TS.UnionType, scope: Scope): Type[] | undefined {
	const isDiscriminant = (key: string) => dst.types.some(t => { const p = lookupMember(t, key, scope); return !!p && constituents(p, scope).every(isUnit); });
	// A tuple's positions are its properties (`["a" | "b", 1]` against `["a", number] | ["b", number]`).
	const slots: [key: string, t: Type | undefined][] = src.type === 'tuple'
		? src.elements.map((el, i) => [String(i), el.type === 'spread' ? undefined : tupleElementType(el)])
		: src.members.map(m => [m.type === 'property' && typeof m.key === 'string' ? m.key : '', m.type === 'property' ? m.typeAnnotation : undefined]);
	const splits: { i: number; units: Type[] }[] = [];
	slots.forEach(([key, t], i) => {
		const units = t && key && isDiscriminant(key) ? constituents(t, scope) : [];
		if (units.length > 1)
			splits.push({ i, units });
	});
	if (!splits.length || splits.reduce((n, s) => n * s.units.length, 1) > 25)
		return undefined;
	const variants = splits.reduce<Type[][]>((vs, { i, units }) => vs.flatMap(v => units.map(u => v.map((x, j) => j === i ? u : x))), [slots.map(([, t]) => t ?? ANY)]);
	return variants.map(v => src.type === 'tuple'
		? { ...src, elements: src.elements.map((el, j) => el.type === 'spread' ? el : v[j]) }
		: TS.ObjectType(src.members.map((m, j) => m.type === 'property' ? TS.TypeProperty(m.key, v[j], m.modifiers) : m)));
}

// `dstScope` resolves names in `dst`'s own structure (distinct from `scope`, which resolves `src`'s) -- same scope almost
// always, but differs for a `dst` from another module's signature. Every recursive call passes each value's own origin scope.
// `precise`: TS's subtype relation, for inference's common supertype and a guard's narrowing: none of the C1 leniency (a widened
// source into a literal target, so `string` is not below `"def"`), and `any` is below nothing but itself (`any[]` is not below `string[]`).
export function isAssignable(src: Type, dst: Type, scope: Scope, dstScope: Scope = scope, strict = false, depth = 10, precise = false): boolean {
	const recurse = (src: Type, dst: Type, depth: number): boolean => {
		if (depth < 0) {
			scope.hitDepthLimit('isAssignable');
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
			// A readonly tuple fits only a ReadonlyArray, as a readonly array does.
			if (el)
				return !(src.readonly && isRef(dst, 'Array')) && src.elements.every(e => { const t = tupleElementType(e); return !t || recurse(t, el, depth - 1); });
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
		// An alias that resolves to an array shape (`type Rules<T> = Rule<T>[]`) goes back through the Array-ref comparisons above.
		if (src.type === 'array' || dst.type === 'array')
			return recurse(src, dst, depth - 1);

		if (src === dst || isAny(dst) || (isAny(src) && !precise))
			return true;
		if (isNullOrUndefined(src) && !scope.strictNullChecks())
			return true;

		if (isRef(src, 'never'))
			return true;
		// A class ref `resolve` keeps nominal is compared by its members, on either side (`number[]` is not a `number` just because
		// `Array` is a class in codegen's lib). Only a name with no declaration at all stays unverifiable.
		// ... but NOT while `dst` is still a union or intersection: those decompose below and re-enter this rule per member,
		// and expanding first would drop the ref identity that the by-name `Array`/same-name fast paths above need -- the only
		// way an `Array<X>` source ever matches an `Array<Y>` destination, since `Array` is excluded from the structural path.
		if (src.type === 'ref' && !INTRINSIC_TYPES.has(src.name) && dst.type !== 'union' && dst.type !== 'intersection') {
			const members = resolveMembers(src, scope);
			return members.type === 'ref' || recurse(members, dst, depth - 1);
		}
		// (A primitive source keeps to the primitive rules below: no primitive but its own wrapper satisfies a class. A type
		// parameter destination is opaque -- its constraint is an upper bound for what IT is, not for what fits it.)
		if (dst.type === 'ref' && !INTRINSIC_TYPES.has(dst.name) && dst.name !== 'Array' && dst.name !== 'ReadonlyArray'
			&& !(src.type === 'ref' && INTRINSIC_TYPES.has(src.name)) && !dstScope.type(dst.name)?.isTypeParam) {
			const members = resolveMembers(dst, dstScope);
			if (members.type !== 'ref')
				return recurse(src, members, depth - 1);
		}

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
			// TS's discriminated assignability: `{ kind: A | B, ... }` fits `{ kind: A, ... } | { kind: B, ... }` when each
			// discriminant value, taken alone, fits some member.
			const split = src.type === 'object' || src.type === 'tuple' ? splitDiscriminants(src, dst, scope) : undefined;
			return !!split && split.every(s => dst.types.some(t => recurse(s, t, depth - 1)));
		}

		if (dst.type === 'intersection')
			return dst.types.every(t => recurse(src, t, depth - 1));
		if (src.type === 'intersection' && dst.type !== 'object') {
			if (src.types.some(t => recurse(t, dst, depth - 1)))
				return true;
			// TS's `getBaseConstraintOfType` for an intersection: every part at its own constraint, intersected and normalized
			// (`T & U` with `T extends 1|2` and `U extends 2|3` is `2`). No part-wise match can see a bound only the combination implies.
			const bound = intersectionConstraint(src, scope);
			return !!bound && recurse(bound, dst, depth - 1);
		}

		// A `range` on either side is a narrowed `number`/`bigint`. When `dst` is itself genuinely number/bigint-shaped
		// (another range, or a plain `number`/`bigint` ref), assignability is precise: does the whole span fit (and,
		// for an `integer`-flagged destination, is the integer-ness known)? Otherwise -- an unresolved named type, a
		// structural object, anything `toRange` can't make sense of -- a `range` must be judged exactly like an
		// ordinary un-narrowed `number`/`bigint` would be, so `src` widens back to its plain base and falls through
		// to every check below (unresolved-name leniency, structural comparisons, etc.); short-circuiting to `false`
		// here instead would reject cases a plain `number` src would have passed (e.g. an unresolvable cross-module
		// type alias, which every other primitive src is leniently waved through here).
		if (src.type === 'range' || dst.type === 'range') {
			const sr = toRange(src), dr = toRange(dst);
			if (dr) {
				return !!sr && sr.base === dr.base
					&& (dr.min === undefined || (sr.min !== undefined && sr.min >= dr.min))
					&& (dr.max === undefined || (sr.max !== undefined && sr.max <= dr.max))
					&& (!dr.integer || sr.integer);
			}
			if (sr)
				src = sr.base === 'bigint' ? BIGINT : NUMBER;
		}

		// A template literal type still here didn't expand (see `expandTemplate`): as a target it's a pattern, as a source a `string`.
		if (dst.type === 'literal' && Array.isArray(dst.value)) {
			if (isLiteral(src, 'string') && !Array.isArray(src.value))
				return new RegExp(`^${templatePattern(dst.value, dstScope)}$`).test(src.value);
			return !precise && (isLiteral(src, 'string') || isRef(src, 'string'));	// widened source: lenient (inventory C1)
		}
		if (src.type === 'literal' && Array.isArray(src.value))
			return recurse(STRING, dst, depth - 1);
		if (dst.type === 'literal')
			return src.type === 'literal'
				? src.value === dst.value
				: !precise && src.type === 'ref' && dst.value !== null && src.name === typeof dst.value;	// widened source: lenient (inventory C1)
		// A literal is never an array, and a type parameter is opaque; any other name still here could not be expanded, so stays unverifiable.
		// Against a structural target it boxes as its primitive does: `"def"` satisfies `Object` exactly as `string` does.
		if (src.type === 'literal')
			return dst.type === 'ref' ? (INTRINSIC_TYPES.has(dst.name) ? dst.name === (src.value === null ? 'null' : typeof src.value)
				: dst.name !== 'Array' && dst.name !== 'ReadonlyArray' && !dstScope.type(dst.name)?.isTypeParam)
				: src.value !== null && recurse(TS.RefType(typeof src.value), dst, depth - 1);

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
			// TS's arity rule (compareSignaturesRelated): a source needing more arguments than the target ever passes is not one.
			if (!dst.rest && minArgumentCount(src, scope) > dst.params.filter(p => p.key !== 'this').length)
				return false;
			// Parameters are BIVARIANT, TS's method-parameter rule and its weakest: each pair need only relate one way,
			// but a `(h: Handler) => ...` is no `(value: number) => ...` callback either way.
			const own = (f: typeof src) => f.params.filter(p => p.key !== 'this');
			const srcParams = own(src), dstParams = own(dst);
			if (srcParams.some((p, i) => {
				const s = p.typeAnnotation, d = dstParams[i]?.typeAnnotation;
				return s && d && !recurse(s, d, depth - 1) && !recurse(d, s, depth - 1);
			}))
				return false;
			if (!dst.returnType || !src.returnType)
				return true;	// missing return type (e.g. an unmodeled class method): lenient
			// returns covariant, void-dst absorbs anything
			return dst.returnType.type === 'ref' && dst.returnType.name === 'void'
				|| recurse(src.returnType, dst.returnType, depth - 1);
		}

		if (dst.type === 'object') {
			if (src.type === 'ref') {
				// A primitive auto-boxes for structural checks too, not just member access -- otherwise `string` could never
				// structurally satisfy `Iterable<T>`/`ArrayLike<T>` (e.g. `Array.from(str)`).
				const boxed = scope.semantics.boxed(src.name);
				return boxed ? recurse(TS.RefType(boxed), dst, depth - 1) : !INTRINSIC_TYPES.has(src.name);	// unresolved nominal: lenient
			}
			if (src.type === 'function' || src.type === 'constructor')
				// A function's apparent type is the global `Function` interface, then `Object`'s -- which `lookupMember` already
				// routes to -- so a lambda satisfies `Function` and an interface extending it, and anything else is truly missing.
				return dst.members.every(m => {
					if ((m.type !== 'property' && m.type !== 'method') || hasMod(m, 'optional') || typeof m.key !== 'string')
						return true;
					const got = lookupMember(src, m.key, scope);
					return !!got && (m.type === 'method' || recurse(got, m.typeAnnotation, depth - 1));
				});
			if (src.type === 'object' || src.type === 'intersection' || src.type === 'tuple')
				return dst.members.every(m => {
					if (m.type !== 'property' || typeof m.key !== 'string')
						return true;		// methods/call/index/computed: unchecked (inventory C4)
					// `lookupMember` gets its own fresh budget, not `recurse`'s remaining `depth` -- same reasoning as
					// `lookupMember`'s own `resolve()` call.
					const got = lookupMember(src, m.key, scope);
					// An optional property also accepts undefined. A missing required one is an error even when its type admits
					// `undefined` (TS: "Property is missing") -- absence only counts against a sealed source.
					return got ? recurse(got, hasMod(m, 'optional') ? TS.UnionType([m.typeAnnotation, UNDEFINED]) : m.typeAnnotation, depth - 1)
						: hasMod(m, 'optional') || !sealed(src, scope);
				});
			return false;
		}

		if (dst.type === 'ref') {
			if (dst.name === 'object')
				return !(src.type === 'ref' && INTRINSIC_TYPES.has(src.name)) || src.name === 'object' || src.name === 'null';
			if (dst.name === 'void')
				return src.type === 'ref' && (src.name === 'void' || src.name === 'undefined');
			if (src.type === 'ref') {
				if (src.name === dst.name)
					return !dst.typeArgs || !src.typeArgs || src.typeArgs.length !== dst.typeArgs.length || src.typeArgs.every((a, i) => recurse(a, dst.typeArgs![i], depth - 1));
				if (src.name === 'void' && dst.name === 'undefined')
					return true;	// this checker's own bare-`return` inference produces `void`
				// A PRIMITIVE never satisfies a real CLASS: a `string` is not a `RegExp`, and not an
				// `Array<T>` either (`normalizeArray` turns an array destination into exactly that ref).
				// The leniency below is for a name this checker could not look up AT ALL -- not for a
				// class it knows. Classes only started arriving here as refs once `resolve` began keeping
				// them nominal, so they fell straight through to the lenient `true`, which made
				// `string extends RegExp` undecidable and `string extends R2<number>[]` answer TRUE.
				// The boxed wrapper is the exception, matching the `dst.type === 'object'` case above.
				// Only a primitive with a real wrapper is definitely not a class instance. `undefined`/`null`/`void`/`any`
				// are primitives here too, and this checker is deliberately lenient about those -- rejecting them against a
				// class cost 10 real diagnostics on code tsc accepts.
				const boxedSrc = scope.semantics.boxed(src.name);
				if (boxedSrc && (isClassRef(dst, dstScope) || dst.name === 'Array' || dst.name === 'ReadonlyArray'))
					return boxedSrc === dst.name;
				return !(INTRINSIC_TYPES.has(src.name) && INTRINSIC_TYPES.has(dst.name));	// distinct primitives: no; unresolved names: lenient
			}
			// `Array`/`ReadonlyArray` are well-known structural shapes, not "some unresolved generic" -- a plain
			// object/function (anything reaching here didn't match the tuple/array-ref cases above, which already
			// handle every genuinely array-like `src`) never structurally satisfies one, regardless of the lenient
			// fallback below. Concretely: this is what previously let any spec object wrongly "extend" `readonly
			// unknown[]`, misrouting it into `TupleReadType` and leaking its unbound `infer` names into the output.
			if (dst.name === 'Array' || dst.name === 'ReadonlyArray')
				return false;
			return !INTRINSIC_TYPES.has(dst.name);	// structural value into unresolved named type: lenient
		}

		if (src.type === 'ref')
			return !INTRINSIC_TYPES.has(src.name);

		return src.type === dst.type;
	};
	return recurse(src, dst, depth);
}

// ===================================================================
//  Inference
// ===================================================================

// TS's hasPrimitiveConstraint: a type parameter bounded by a primitive (`T extends string`, a literal union) infers the
// literal itself, unwidened -- `f<T extends string>(x: T): T` called with 'a' is 'a'.
function primitiveConstraint(c: Type | undefined, scope: Scope): boolean {
	return !!c && unionMembers(c, scope).some(m => PRIMITIVE_DOMAINS.has(domainOf(resolveOwn(m, scope), scope) ?? ''));
}

// Structurally matches `pattern` (an `extendsType` containing `infer` nodes) against `actual`, binding each `infer X` into `out`.
// Three-valued like `conditionalExtends`: `false` only on outright conflict, `undefined` when unresolvable -- never guessed.
function matchInfer(pattern: Type, actual: Type, scope: Scope, out: Map<string, Type>, depth = 6): boolean | undefined {
	if (depth < 0) {
		scope.hitDepthLimit('matchInfer');
		return undefined;
	}
	if (pattern.type === 'infer') {
		if (!out.has(pattern.name))
			out.set(pattern.name, actual);
		return !pattern.constraint || isAssignable(actual, pattern.constraint, scope);
	}
	if (!containsKind(pattern, 'infer'))
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
		if (!named) {
			// The pattern's own name may still describe a shape the actual can match: an interface or alias expands
			// (`Term<infer U>` -> `{t: infer U}`), and the structural cases below then decide it properly. A class ref stays
			// nominal through `resolve`, so this cannot loop. Without it a chain like `T extends Term<infer U> ? U : T extends
			// (() => infer U) ? U : never` gave up at the FIRST branch (undecidable) instead of falling to the second.
			const expanded = resolve(scope, pattern, depth - 1);
			if (expanded.type !== 'ref' || expanded.name !== pattern.name)
				return matchInfer(expanded, actual, scope, out, depth - 1);
			// A resolved primitive (`string`, `number`, &c) can never structurally match a generic ref pattern
			// like `PromiseLike<infer R>` -- no type arguments, no generic shape -- so this is a confident `false`,
			// not the usual "differently-named, could still be an unresolved match" `undefined`. A function type is the
			// same answer for the same reason: it has no keyed members, and a class ref (kept nominal by `resolve`, so it
			// never expanded above) is not something a function value is an instance of.
			return isPrimitive(a) || a.type === 'function' || a.type === 'constructor' ? false : undefined;
		}
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
			// `a` itself may contain a spread anywhere in the range being matched here (e.g. `[...T[]]`, the
			// common encoding for "array of unknown length" reaching this branch as a genuine `tuple` rather
			// than tison's own `array` kind, which `normalizeArray` above would already have converted to
			// `Array<T>` and failed the `a.type !== 'tuple'` check before this point) -- unlike `tupleElementType`
			// (which deliberately returns `undefined` for a spread elsewhere, since a spread has no *single*
			// element value), a pattern position lining up against one still needs *some* type to bind its
			// `infer` against, and the spread's own argument is exactly that (matches real TS's inference for
			// `[infer First, ...infer Rest]` against a plain array type).
			const elementTypeAt = (te: TS.TupleElement) => te.type === 'spread' ? te.argument : tupleElementType(te);
			if (!lead.every((p, i) => {
				const at = elementTypeAt(a.elements[i]), pt = tupleElementType(p);
				return !at || !pt || matchInfer(pt, at, scope, out, depth - 1) !== false;
			}))
				return false;
			if (!containsKind(last.argument, 'infer'))
				return true;
			const rest = a.elements.slice(lead.length).map(elementTypeAt);
			return rest.every(t => !!t) && matchInfer(last.argument, TS.ArrayType(combineTypes(rest)), scope, out, depth - 1) !== false || undefined;
		}
		return a.elements.length === pattern.elements.length
			&& a.elements.every((e, i) => {
				const at = tupleElementType(e), pt = tupleElementType(pattern.elements[i]);
				return !at || !pt || matchInfer(pt, at, scope, out, depth - 1) !== false;
			})
			|| undefined;
	}
	if (pattern.type === 'function' || pattern.type === 'constructor') {
		// An overloaded value (`((s: sync._stream) => T) & ((s: async._stream) => Promise<T>)`) is a genuine
		// `intersection` of signatures, not a single one -- matches if *any* overload does, same as a real call
		// picking whichever signature fits.
		if (a.type === 'intersection')
			return a.types.some(m => matchInfer(pattern, m, scope, out, depth - 1) === true) || undefined;
		return a.type !== pattern.type ? false
			: pattern.returnType && a.returnType ? matchInfer(pattern.returnType, a.returnType, scope, out, depth - 1)
			: undefined;
	}

	if (pattern.type === 'union') {
		// non-distributive: `infer` inside a pattern-side union is rare and real TS's handling here is itself subtle -- best-effort only.
		for (const p of pattern.types) {
			if (matchInfer(p, actual, scope, out, depth - 1))
				return true;
		}
		return undefined;
	}
	if (pattern.type === 'object') {
		// `a` may be a plain object/intersection with call/construct signature *members* (`{new(...): infer R}`
		// matched structurally), or itself a bare `constructor`/`function` value (e.g. a class reference used as
		// a spec entry) -- semantically the same thing for matching purposes, so both are checked below.
		const aMembers = a.type === 'object' ? a.members : a.type === 'intersection' ? a.types.flatMap(x => x.type === 'object' ? x.members : []) : undefined;
		for (const m of pattern.members) {
			// `new(...): infer R` / `(...): infer R` -- a call/construct signature, not a keyed property: matched
			// against `a`'s own signature of the same kind, if it has one (a plain data-spec object never does,
			// which correctly fails this branch rather than silently binding nothing, as an unhandled member
			// kind falling through the loop below used to).
			if (m.type === 'call' || m.type === 'construct') {
				if (!m.returnType || !containsKind(m.returnType, 'infer'))
					continue;
				const aReturnType = m.type === 'construct' && a.type === 'constructor' ? a.returnType
					: m.type === 'call' && a.type === 'function' ? a.returnType
					: (aMembers?.find(x => x.type === m.type) as TS.CallSig)?.returnType;
				if (!aReturnType)
					return false;
				if (matchInfer(m.returnType, aReturnType, scope, out, depth - 1) === false)
					return false;
				continue;
			}
			if (m.type !== 'property' || typeof m.key !== 'string' || !containsKind(m.typeAnnotation, 'infer'))
				continue;
			// A function/constructor type HAS no keyed members, so a required property is a confident miss -- same answer the
			// absent-property case below gives. Anything else isn't a shape this can look a property up in at all.
			if (!aMembers)
				return a.type === 'function' || a.type === 'constructor' ? (hasMod(m, 'optional') ? undefined : false) : undefined;
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

// TS's choice among a type parameter's candidates: covariant ones if any -- the object/array-literal ones first pooled into one
// union (`unionObjectAndArrayLiteralCandidates`), then literals of one primitive UNION, otherwise the leftmost candidate every
// later one is a supertype of (`getSupertypeOrUnion`); else the contravariant ones' common subtype.
export function chooseInference(co: Type[], contra: Type[], scope: Scope, fromLiteral: (t: Type) => boolean = () => false): Type | undefined {
	const literals = co.filter(fromLiteral);
	if (literals.length > 1)
		co = [...co.filter(t => !fromLiteral(t)), combineTypes(literals)];
	if (co.length) {
		const members	= co.flatMap(t => unionMembers(t, scope).map(m => resolveOwn(m, scope)));
		const base		= (m: Type) => m.type === 'literal' ? literalType(m) : undefined;
		if (members.every(m => base(m) !== undefined && base(m) === base(members[0])))
			return combineTypes(co);
		// TS's getCommonSupertype: with strictNullChecks, `null`/`undefined` stand aside while the supertype is chosen, then join it.
		const nullish	= scope.strictNullChecks() ? members.filter(m => isNullish(m, scope)) : [];
		const primary	= nullish.length ? co.map(t => combineTypes(unionMembers(t, scope).filter(m => !isNullish(m, scope)))).filter(t => !isRef(t, 'never')) : co;
		const supertype	= primary.length ? primary.reduce((s, t) => s !== t && isAssignable(s, t, scope, scope, false, 10, true) ? t : s) : NEVER;
		return nullish.length ? combineTypes([supertype, ...nullish]) : supertype;
	}
	return contra.length ? contra.reduce((s, t) => s !== t && isAssignable(t, s, scope, scope, false, 10, true) ? t : s) : undefined;
}

// The parameter types of every signature `t` offers a callback (a function, a call member, each member of a union).
function callbackParamTypes(t: Type, scope: Scope, depth = 4): Type[] {
	const r = resolveOwn(t, scope);
	const sigParams = (sig: TS.CallSig) => [...sig.params.flatMap(p => p.typeAnnotation ? [p.typeAnnotation] : []), ...sig.rest?.typeAnnotation ? [sig.rest.typeAnnotation] : []];
	return r.type === 'function' || r.type === 'constructor' ? sigParams(r)
		: r.type === 'object' ? r.members.flatMap(m => m.type === 'call' ? sigParams(m) : [])
		: r.type === 'union' && depth > 0 ? r.types.flatMap(m => callbackParamTypes(m, scope, depth - 1))
		: [];
}

// TS's inference context for one generic call: each type parameter's candidates, covariant and contravariant apart; what
// the call's destination implies (lowest priority); and the parameters FIXED -- read to give a callback its context --
// whose later candidates are ignored.
export class Inference {
	readonly names:				ReadonlyMap<string, TS.TypeParam>;
	private readonly co			= new Map<string, Type[]>();
	private readonly contra		= new Map<string, Type[]>();
	private readonly fixed		= new Map<string, Type>();
	private readonly fromReturn	= new Map<string, Type>();
	private readonly defaulted	= new Set<string>();
	private readonly literal	= new Set<Type>();		// candidates inferred from an object/array literal argument
	private feedingLiteral		= false;

	constructor(typeParams: readonly TS.TypeParam[], readonly scope: Scope, readonly declScope: Scope) {
		this.names = new Map(typeParams.map(p => [p.name, p]));
	}
	// `inferTypeArgs` skips a name this reports: only a fixed one takes no more candidates.
	has(name: string): boolean	{ return this.fixed.has(name); }
	// Every candidate comes from the CALLER's side (an argument, the expected result, a callback's annotation) but is substituted into
	// the callee's own types and resolved there, so it carries the caller's scope (`Fields<S.Pt>`, where the callee has no `S`).
	add(name: string, t: Type, contra: boolean) {
		stampScope(t, this.scope);
		// Only a candidate that is itself an object/array literal's type pools (TS's isObjectOrArrayLiteralType), not a primitive inside one.
		if (this.feedingLiteral && (t.type === 'object' || t.type === 'array' || t.type === 'tuple'))
			this.literal.add(t);
		const pool = contra ? this.contra : this.co;
		pool.set(name, [...pool.get(name) ?? [], t]);
	}
	// A callback's return is matched on a fresh depth budget: queued on `deferred` when the caller orders them itself, else
	// replayed now -- one level: deeper ones share its budget, since each level multiplies through overload sets (`Promise.then`).
	infer(paramT: Type, argT: Type, deferred?: Deferred[], contra = false, replays = 1) {
		const own: Deferred[] = [];
		inferTypeArgs(paramT, argT, this.names, this, this.scope, this.declScope, deferred ?? (replays > 0 ? own : undefined), contra);
		for (const d of own)
			this.infer(d.paramT, d.argT, undefined, d.contra, replays - 1);
	}
	// An argument written as an object/array literal: what it gives is a literal candidate, pooled into one union when chosen.
	inferFromLiteral(paramT: Type, argT: Type) {
		this.feedingLiteral = true;
		this.infer(paramT, argT);
		this.feedingLiteral = false;
	}
	// What the call's result must be (`expected` against the signature's return type): used only where nothing else speaks.
	inferReturn(returnType: Type, expected: Type) {
		const m = new Map<string, Type>();
		inferTypeArgs(returnType, expected, this.names, m, this.scope, this.declScope);
		m.forEach((t, name) => this.fromReturn.has(name) || this.fromReturn.set(name, stampScope(t, this.scope)));
	}
	fix(name: string, t: Type)	{ this.fixed.set(name, t); }
	fromCandidates(name: string): Type | undefined {
		return this.fixed.get(name) ?? chooseInference(this.co.get(name) ?? [], this.contra.get(name) ?? [], this.scope, t => this.literal.has(t));
	}
	inferred(name: string): Type | undefined	{ return this.fromCandidates(name) ?? this.fromReturn.get(name); }
	returnHint(name: string): Type | undefined	{ return this.fromReturn.get(name); }
	current(): Map<string, Type> {
		const map = new Map<string, Type>();
		for (const name of this.names.keys()) {
			const t = this.inferred(name);
			if (t)
				map.set(name, t);
		}
		return map;
	}
	// Fixed with nothing inferred: the parameter's default, else its constraint, else `any` -- the call reports it as a GAP.
	wasDefaulted(name: string): boolean	{ return this.defaulted.has(name); }
	// `declared` as a callback's context: every parameter its own parameter types mention is FIXED at its current inference.
	contextFor(declared: Type): Type {
		const params = callbackParamTypes(declared, this.declScope);
		for (const [name, tp] of this.names) {
			if (this.fixed.has(name) || !params.some(p => mentionsTypeParam(p, name)))
				continue;
			const t = this.inferred(name);
			if (!t)
				this.defaulted.add(name);
			this.fixed.set(name, t ?? tp.default ?? tp.constraint ?? ANY);
		}
		const map = this.current();
		return map.size ? substituteType(declared, map) : declared;
	}
}

// Infers a generic call's type args by structurally matching each param's declared type against the argument's (first binding wins).
// `declScope` resolves `paramT`'s own names (the signature's declaring module); `scope` resolves `argT`'s (the call site's).
// `deferred`: when given, a callback-shaped param's own *return*-position inference (the one case that
// depends on the argument's own already-inferred type rather than its declared one -- see the
// `function`/`constructor` case below) is queued here instead of running immediately, so a caller
// (`instantiate()`) can replay it after a more reliable source (the call's own contextual `expected`
// type) has had first crack at the same type param. Every other case (a plain, non-callback param
// position) is unaffected and keeps today's immediate, first-wins behavior regardless -- omitting
// `deferred` (every caller except `instantiate()`) reproduces the exact old behavior throughout.
export interface Deferred { paramT: Type; argT: Type; contra?: boolean }
export function inferTypeArgs(paramT: Type, argT: Type, tparams: ReadonlyMap<string, TS.TypeParam>, out: Map<string, Type> | Inference, scope: Scope, declScope: Scope = scope, deferred?: Deferred[], contraStart = false): void {
	let pooled: Map<string, Type[]> | undefined;
	// Flipped at each callback parameter position: what a type parameter learns there is a contravariant candidate.
	let contra = contraStart;
	return recurse(paramT, argT, 6);

	function found(name: string, t: Type) {
		if (pooled)
			pooled.set(name, [...pooled.get(name) ?? [], t]);
		else if (out instanceof Inference)
			out.add(name, t, contra);
		else
			out.set(name, t);
	}
	function flipped(inner: () => void) {
		contra = !contra;
		inner();
		contra = !contra;
	}

	function recurse(paramT: Type, argT: Type, depth: number) {
		if (depth < 0)
			return;
		if (paramT.type === 'ref' && !paramT.typeArgs && tparams.has(paramT.name)) {
			// A member naming one of the callee's own type parameters that is no type parameter at the call site can only have
			// leaked in through context (an empty `[]` typed against the unsolved `U[]`): as in TS, a parameter never infers from itself.
			const leaked	= (m: Type) => m.type === 'ref' && !m.typeArgs && tparams.has(m.name) && !scope.type(m.name)?.isTypeParam;
			const members	= argT.type === 'union' ? argT.types : [argT];
			const own		= members.filter(m => !leaked(m));
			if (!own.length)
				return;
			const src		= own.length === members.length ? argT : combineTypes(own);
			if (!out.has(paramT.name)) {
				const tp = tparams.get(paramT.name)!;
				// Widening a literal argument (`'string'` -> `string`) is the usual default, but not when the type param's constraint is
				// itself a union of literals (`K extends 'string' | 'number'`) -- the widened form would fall outside the constraint.
				found(paramT.name, tp.const || tp.constraint?.type === 'keyof' || primitiveConstraint(tp.constraint, scope) ? src : widenLiterals(src));
			}
			return;
		}
		const a = resolveOwn(argT, scope);
		if (paramT.type === 'array') {
			if (a.type === 'array') {
				recurse(paramT.element, a.element, depth - 1);
			} else if (a.type === 'tuple') {
				// Every element is a candidate, unioned -- `readonly T[]` from `['a', 'b'] as const` is `'a' | 'b'`, not the first alone.
				const outer = pooled;
				pooled = new Map();
				elementTypes(a, scope).forEach(t => recurse(paramT.element, t, depth - 1));
				const got = pooled;
				pooled = outer;
				got.forEach((ts, name) => found(name, combineTypes(ts)));
			// e.g. an argument built from `x ?? y` where both branches independently resolve to compatible-but-not-deduplicated array types
			// (`number[] | number[]`) -- distribute over the union rather than giving up (the first member to actually match wins, per `out`'s guard).
			} else if (a.type === 'union') {
				a.types.forEach(m => recurse(paramT, m, depth - 1));
			}
		} else if (paramT.type === 'ref' && paramT.typeArgs) {
			// A generic alias unfolded one level (`paramT.name` is declared in `declScope`, not `scope`).
			const entry		= declScope.type(paramT.name);
			const unfold	= () => instantiateEntry(entry!, paramT.typeArgs);
			const sameName	= argT.type === 'ref' && argT.name === paramT.name;
			if (paramT.name === 'Array' && paramT.typeArgs.length === 1 && a.type === 'array') {
				recurse(paramT.typeArgs[0], a.element, depth - 1);
			} else if (paramT.name === 'PromiseLike' && paramT.typeArgs.length === 1 && (argT.type === 'union' ? argT.types : [argT]).some(m => asPromiseRef(m, scope))) {
				// `.then`'s 2nd alternative: the callback's return may be a union with only *some* members Promise-shaped (e.g.
				// `Font | FontGroup | Promise<Font> | undefined`) -- `awaitType` distributes over the union, unwrapping just those.
				// Checked on `argT`, not the resolved `a`: `resolveOwn` would expand a bare `Promise<X>` into its structural
				// body, losing the ref identity `asPromiseRef` needs.
				recurse(paramT.typeArgs[0], awaitType(argT, scope), depth - 1);
			} else if (!sameName && entry?.typeParams?.length && entry.type.type === 'union') {
				// An alias is transparent, as in TS: `MaybePromise<D>` IS `D | Promise<D>`, so a union argument meets a union target and a
				// bare `D` takes what the other members don't account for, whole -- not one candidate per argument member.
				recurse(unfold(), argT, depth - 1);
			} else if (a.type === 'union' && !sameName) {
				// `Rule<T>` against `Rule2<CallSig> = Rule<CallSig> | Rules<CallSig> | ...`: each member is a candidate, as in TS.
				a.types.forEach(m => recurse(paramT, m, depth - 1));
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
							recurse(p, t, depth - 1);
					});
				} else {
					// A generic alias wrapping `T` (e.g. `Testable<T> = T extends primitive ? T : T & Equal<T>`) -- unfold one level and recurse,
					// so whichever case below actually contains `T` gets a chance to match.
					if (entry?.typeParams?.length)
						recurse(unfold(), argT, depth - 1);
				}
			}
		} else if (paramT.type === 'tuple') {
			// `[K, V]` as a parameter type inferred NOTHING before this case existed, so every entries-style
			// constructor (`Map`/`Set`'s own `[K, V][]`) came out `<any, any>` -- and towasm then rejected it
			// outright ("class 'Map' needs 2 explicit type argument(s)"), blocking 30 declarations.
			if (a.type === 'tuple') {
				paramT.elements.forEach((el, i) => {
					const p = tupleElementType(el), q = tupleElementType(a.elements[i]);
					if (p && q)
						recurse(p, q, depth - 1);
				});
			} else if (a.type === 'union') {
				a.types.forEach(m => recurse(paramT, m, depth - 1));
			}

		} else if (paramT.type === 'intersection') {
			// Same reasoning as `union` below: `T` may be embedded in just one part -- trying every part is safe, only the matching one infers anything.
			for (const p of paramT.types)
				recurse(p, argT, depth - 1);

		} else if (paramT.type === 'conditional') {
			// Which branch `T` is in depends on `checkType extends extendsType`, not knowable here since `T` may itself be `checkType` -- try both.
			recurse(paramT.trueType, argT, depth - 1);
			recurse(paramT.falseType, argT, depth - 1);

		} else if (paramT.type === 'function' || paramT.type === 'constructor') {
			// A callable value built via `Object.assign(fn, {...})` (e.g. `rational`) comes out as an intersection, not a bare
			// `'function'`/`'constructor'` node -- `flattenIntersection` finds the actual callable part, as `narrow()` also does.
			const callable = flattenIntersection(a, scope).find(p => p.type === paramT.type) as typeof paramT;
			if (callable) {
				const fn = baseSignature(callable);
				flipped(() => paramT.params.forEach((p, i) => {
					const q = fn.params[i];
					if (p.typeAnnotation && q?.typeAnnotation)
						recurse(p.typeAnnotation, q.typeAnnotation, depth - 1);
				}));
				// The one case `deferred` exists for: `fn.returnType` is the *argument's own*, independently
				// inferred return type -- for a generic callback literal (`() => ({...})`) with no declared
				// return-type annotation, that's whatever anonymous, non-nominal structural shape the checker's
				// own inference happened to produce from its body, not necessarily what the call actually wants.
				// Queuing it lets a more reliable source (the whole call's own contextual `expected` type,
				// matched against the outer signature's `returnType` in `instantiate()`) bind the type param
				// first when it can; `out`'s own first-wins guard (`ref` case, above) then makes replaying this
				// afterward a safe no-op wherever contextual typing already succeeded.
				if (paramT.returnType && fn.returnType) {
					if (deferred)
						deferred.push({ paramT: paramT.returnType, argT: fn.returnType, contra });
					else
						recurse(paramT.returnType, fn.returnType, depth - 1);
				}
			}
		} else if (paramT.type === 'object') {
			for (const m of paramT.members) {
				const key = (m.type === 'property' || m.type === 'method') ? memberKey(m.key) : undefined;
				if (key === undefined)
					continue;
				if (m.type === 'property') {
					const t = lookupMember(a, key, scope);
					if (t)
						recurse(m.typeAnnotation, t, depth - 1);
				} else if (m.type === 'method') {
					// Same shape as `function`/`constructor` above -- `adapter0<T,D>`-style interfaces often carry `T`/`D` only in a method's own signature.
					const member = lookupMember(a, key, scope);
					if (member?.type === 'function') {
						const t = baseSignature(member);
						flipped(() => m.params.forEach((p, i) => {
							const q = t.params[i];
							if (p.typeAnnotation && q?.typeAnnotation)
								recurse(p.typeAnnotation, q.typeAnnotation, depth - 1);
						}));
						if (m.returnType) {
							if (deferred)
								deferred.push({ paramT: m.returnType, argT: t.returnType ?? ANY, contra });
							else
								recurse(m.returnType, t.returnType ?? ANY, depth - 1);
						}
					}
				}
			}
		} else if (paramT.type === 'predicate') {
			// Only an argument that's *itself* an inferred/declared predicate carries a usable asserted type (e.g. `.filter`'s `(v) => v is S`
			// matched against a callback whose own inferred return came out `v is <narrowed>`) -- a plain `boolean` callback leaves `S` uninferred.
			if (a.type === 'predicate' && paramT.assertedType && a.assertedType)
				recurse(paramT.assertedType, a.assertedType, depth - 1);

		} else if (paramT.type === 'union') {
			// A bare `T` alternative matches the whole argument too coarsely when a more structural alternative (`TypeT<K>`) could
			// drill into K's position instead -- so non-bare alternatives are tried first; bare ones only fill in what's still unbound.
			const isBare = (t: Type) => t.type === 'ref' && !t.typeArgs && tparams.has(t.name);
			const concrete = paramT.types.filter(t => !isBare(t));
			for (const t of concrete)
				recurse(t, argT, depth - 1);
			const bare = paramT.types.filter(isBare);
			if (bare.length) {
				// A bare alternative stands for what the CONCRETE ones do not already account for:
				// `T | undefined` against `number | undefined` infers `T = number`, not the whole union.
				// Real TS does exactly this; without it `unbox<T>(b: {value: T | undefined}): T` came back
				// as `number | undefined` and every use of its result was then rejected.
				const keys		= new Set(concrete.map(c => typeKey(resolveOwn(c, scope))));
				if (a.type === 'union') {
					const rest		= a.types.filter(m => !keys.has(typeKey(resolveOwn(m, scope))));
					const narrowed	= rest.length && rest.length < a.types.length ? (rest.length === 1 ? rest[0] : TS.UnionType(rest)) : argT;
					for (const t of bare)
						recurse(t, narrowed, depth - 1);
				} else {
					for (const t of bare)
						recurse(t, argT, depth - 1);
				}
			}
		}
	}
}

// ===================================================================
//  Promises and async functions
// ===================================================================

// Peels through plain ref aliases one substitution at a time, looking for a literal `Promise<X>` ref -- unlike
// `scope.resolve`, which would expand straight into Promise's structural body and lose the "this was a Promise" identity.
export function asPromiseRef(t: Type, scope: Scope, depth = 6): TS.RefType | undefined {
	if (depth < 0) {
		scope.hitDepthLimit('asPromiseRef');
		return undefined;
	}
	if (t.type !== 'ref')
		return undefined;
	if (t.name === 'Promise')
		return t.typeArgs?.length ? t : undefined;
	const body = expandRefOnce(scope, t);
	return body !== t ? asPromiseRef(body, scope, depth - 1) : undefined;
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

export function wrapReturnIfAsync(t: Type, scope: Scope, async: boolean|undefined): Type {
	return !async || asPromiseRef(t, scope) ? t : TS.RefType('Promise', [t]);
}

export function unwrapIfAsync(t: Type, scope: Scope, async: boolean|undefined): Type {
	return async ? awaitType(t, scope) : t;
}

export function wrapType(t: Type, names: Set<string>, name: string) {
	return t.type === 'ref' && names.has(t.name) ? t : TS.RefType(name, [t]);
}

// ===================================================================
//  Scopes, and the language semantics a root scope carries
// ===================================================================

// `isTypeParam`: registered via `Scope.addTypeParam`, not a real, resolvable type alias -- `isAbstract`'s
// own `'ref'` case treats a flagged entry as still abstract despite having a real `scope.type()` entry
// now (its `type` is only an upper-bound *approximation*, the constraint, not the real, possibly-narrower
// type an actual call site instantiates it with) -- keeps conditional-type deferral (`N extends X ? A :
// B` staying unresolved until `N` is genuinely concrete) working correctly for a bounded, still-abstract
// type parameter, while still letting `keyof`/member-access/etc. resolve *something* useful for it.
export interface TypeEntry	{ typeParams?: TS.TypeParam[]; type: Type; defaultSubstitution?: Type; isTypeParam?: boolean }

// What a source language's runtime adds to this shared type model: the members its values have beyond what their lib
// declares. Carried by a root `Scope`, so two languages can be checked side by side.
export interface Semantics {
	// The interface a primitive's members come from when it is used as an object (`string` -> `String`).
	boxed(primitive: string): string | undefined;
	// A member every object has without declaring it; `callable`: every function, whose own come first.
	apparentMember(prop: string, callable: boolean, scope: Scope): Type | undefined;
	// A member of `t` (already resolved) the language types more precisely than its lib declares; undefined defers to the lib.
	refinedMember(t: Type, prop: string, scope: Scope, depth: number): Type | undefined;
}

export class Scope {
	private values		= new Map<string, Type>();
	private types		= new Map<string, TypeEntry>();
	private narrowings?:	Map<string, Type>;	// control-flow refinements, consulted before declarations
	private aliases?:		Map<string, Expr>;	// const initializers -- narrowing a const also narrows through its initializer (TS 4.4 aliased conditions)
	private sources?:		Map<string, Expr>;	// a const destructured from a union (`const {kind, a} = x`) IS `x.kind`: narrowed and read through it (TS 4.6)
	private namespaces?:	Map<string, Scope>;	// nested namespace/module scopes, keyed by their bound name -- consulted by `resolve` for a dotted type ref (`NS.Foo`)
	// The real `function_decl`/`class_decl` statement a name resolves to, alongside its derived `value`/
	// `type` entries -- a consumer that needs to actually COMPILE a declaration (not just type-check a
	// reference to it) has no other way to get from "this name, in this scope" back to real source: `value`/
	// `type` only ever carry a *derived* `Type`, never a pointer to what produced it. Lets a cross-module
	// consumer resolve via the same scope-chain/`declScope` mechanism already used for types, instead of a
	// separate name-mangling scheme (e.g. backend.ts's own `homeModule`/`homeKey`) reinventing module-scoped
	// lookup on the side.
	private decls?:			Map<string, TS.Stmt>;

	//caches
	resolving?:				Set<Type>;
	resolveCache?: 			WeakMap<Type, [Type | undefined, Type | undefined]>;
	lookupMemberCache?:		WeakMap<Type, Map<string, Type | undefined>>;

	// This scope IS the global declaration space: the top level of a SCRIPT (a file with no top-level
	// import/export). Real TS puts such a file's declarations in the global space, so an `interface` there
	// augments a same-named global one; a module's top level, and any block, is its own space instead.
	globalSpace = false;

	// Set on a function body's own scope: whether it is `async` (an async generator's `yield`/`yield*` await and iterate asynchronously), and for
	// a generator with a declared type what its `yield` must produce and evaluates to.
	functionKind?: { async: boolean; yield?: Type; next?: Type };

	// `false` on a program's scope: `strictNullChecks` off, so `null`/`undefined` belong to every type. Unset inherits; the root is strict.
	nullChecks?: boolean;

	// Where TS's control-flow container stops (a function declaration, a class declaration's members): the enclosing flow's narrowings don't reach in.
	flowBoundary = false;

	readonly parent?:	Scope;
	readonly semantics:	Semantics;

	// A root scope is made from its language's `Semantics`; every other inherits its parent's.
	constructor(outer: Scope | Semantics, private genericTemplate?: boolean) {
		this.parent		= outer instanceof Scope ? outer : undefined;
		this.semantics	= outer instanceof Scope ? outer.semantics : outer;
	}

	enclosingFunction(): Scope['functionKind']		{ return this.functionKind ?? this.parent?.enclosingFunction(); }
	strictNullChecks(): boolean						{ return this.nullChecks ?? this.parent?.strictNullChecks() ?? true; }

	hitDepthLimit(fn: string): void					{ this.parent?.hitDepthLimit(fn); }

	isGenericTemplate(): boolean					{ return !!this.genericTemplate || !!this.parent?.isGenericTemplate(); }

	value(name: string): Type | undefined			{ return this.narrowings?.get(name) ?? this.values.get(name) ?? (this.flowBoundary ? this.parent?.declared(name) : this.parent?.value(name)); }
	type(name: string): TypeEntry | undefined		{ return this.types.get(name) ?? this.parent?.type(name); }
	declared(name: string): Type | undefined		{ return this.values.get(name) ?? this.parent?.declared(name); }
	alias(name: string): Expr | undefined			{ return this.aliases?.get(name) ?? (this.values.has(name) ? undefined : this.parent?.alias(name)); }
	source(name: string): Expr | undefined			{ return this.sources?.get(name) ?? (this.values.has(name) ? undefined : this.parent?.source(name)); }
	hasSources(): boolean							{ return !!this.sources || !!this.parent?.hasSources(); }
	namespace(name: string): Scope | undefined		{ return this.namespaces?.get(name) ?? this.parent?.namespace(name); }
	decl(name: string): TS.Stmt | undefined	{ return this.decls?.get(name) ?? this.parent?.decl(name); }

	// Reverse of a normal ref lookup: a resolved structural type may happen to be *exactly* some declared class/
	// interface/alias's own registered shape (e.g. `infer R` binding to a class reference's instance type, reached
	// through generic inference with no name attached along the way) -- reference-identity matched, walking each
	// scope's own (non-inherited) type map up the parent chain.
	findDeclaredName(target: Type): { name: string; scope: Scope } | undefined {
		for (let s: Scope | undefined = this; s; s = s.parent) {
			for (const [name, entry] of s.types)
				if (entry.type === target)
					return { name, scope: s };
		}
		return undefined;
	}

	// BFS through namespace imports for one whose `.type(leaf)` is *the same object* as `target` -- name-only
	// matching risks false positives from unrelated same-named re-exports.
	findQualifiedPath(leaf: string, target: Type): string[] | undefined {
		const seen = new Set<Scope>([this]);
		let frontier: { scope: Scope; path: string[] }[] = [{ scope: this, path: [] }];
		while (frontier.length) {
			const next: typeof frontier = [];
			for (const { scope, path } of frontier) {
				if (scope.namespaces) {
					for (const [name, ns] of scope.namespaces) {
						if (!seen.has(ns)) {
							seen.add(ns);
							const here = [...path, name];
							if (ns.type(leaf)?.type === target)
								return here;
							next.push({ scope: ns, path: here });
						}
					}
				}
			}
			frontier = next;
		}
		return undefined;
	}

	addValue(name: string, type: Type)				{ this.values.set(name, type); }
	// The value counterpart of `mergeType`, and only against a binding in THIS scope (`values`, not the
	// parent-walking `value()`) -- a class in a user module must never merge with a lib class of the same
	// name. It exists for the primitive wrappers, which TypeScript itself models as two declarations:
	// `class BigInt` supplies `new` and the instance side, `declare var BigInt` the CALL signature that
	// returns `bigint`. Overwriting dropped the call signature entirely.
	mergeValue(name: string, type: Type) {
		const prev = this.values.get(name);
		this.values.set(name, prev ? TS.IntersectionType([type, prev]) : type);
	}
	addType(name: string, type: Type, typeParams?: TS.TypeParam[])	{ this.types.set(name, {type, typeParams}); }
	// See `TypeEntry.isTypeParam`'s own comment -- `constraint` is only an upper-bound approximation, not
	// a real resolvable alias; `isAbstract` treats a flagged entry as still abstract accordingly.
	addTypeParam(name: string, constraint: Type)	{ this.types.set(name, {type: constraint, isTypeParam: true}); }
	addNarrowing(name: string, t: Type)				{ (this.narrowings ??= new Map()).set(name, t); }
	addAlias(d: JS.Var<any>)						{ (this.aliases ??= new Map()).set(d.name, d.init); }
	addSource(name: string, e: Expr)				{ (this.sources ??= new Map()).set(name, e); }
	addNamespace(name: string, s: Scope)			{ (this.namespaces ??= new Map()).set(name, s); }
	ownNamespace(name: string): Scope | undefined	{ return this.namespaces?.get(name); }
	addDecl(name: string, stmt: TS.Stmt)			{ (this.decls ??= new Map()).set(name, stmt); }

	mergeType(name: string, type: Type, typeParams: TS.TypeParam[] | undefined, augment = false) {
		// `augment` (an `interface` declaration) in the GLOBAL declaration space merges with a same-named
		// declaration from an enclosing scope: real TS puts a script's top level in the global space, so
		// `interface Array<T> { slice(): this }` augments the lib's `Array`. Modelled here as a child
		// scope, it silently replaced it instead and every other member's real signature was lost.
		// Gated on `globalSpace` because a local interface genuinely shadows (`localTypes4.ts`: "local
		// types are block scoped"). Inherited part FIRST, same order `mergeTypeEntry` uses: `lookupMember`
		// REVERSES an intersection when merging same-named signatures into one overload set, so this is
		// what actually gets the augmenting declaration tried first.
		const inherited = augment && this.globalSpace && !this.types.has(name) ? this.parent?.type(name) : undefined;
		if (inherited)
			this.types.set(name, { typeParams: typeParams ?? inherited.typeParams, type: joinTypes([inherited.type, type]) });
		else
			this.mergeTypeEntry(name, {type, typeParams});
	}

	private mergeTypeEntry(name: string, te: TypeEntry) {
		const prev = this.types.get(name);
		this.types.set(name, prev ? { typeParams: prev.typeParams ?? te.typeParams, type: joinTypes([prev.type, te.type]) } : te);
	}

	lookupScope(parts: string[]): Scope | undefined {
		let ns: Scope | undefined = this;
		for (const p of parts) {
			ns = ns.namespace(p);
			if (!ns)
				return undefined;
		}
		return ns;
	}

	// A dotted name's namespace scope, beside its last part.
	qualified(name: string): [Scope | undefined, string] {
		const parts	= name.split('.');
		const last	= parts.pop()!;
		return [this.lookupScope(parts), last];
	}

	lookupType(name: string): TypeEntry | undefined {
		const [ns, last] = this.qualified(name);
		return ns?.type(last);
	}

	lookupValue(name: string): TS.Type | undefined {
		const [ns, last] = this.qualified(name);
		return ns?.value(last);
	}

	root(): Scope {
		return this.parent?.root() ?? this;
	}
	

	// Every name narrowed anywhere between this scope and `base` (exclusive); used to combine two independently-narrowed branches of a `||`/`&&` test.
	narrowedNames(base?: Scope): Set<string> {
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
			const d = from.decl(local);
			if (d)
				this.addDecl(pub, d);
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
