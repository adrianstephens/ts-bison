/* eslint-disable @typescript-eslint/no-this-alias */
import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Expr, BindingTarget } from './js-parser';
import { Type } from './ts-parser';
import { TSwalk, hasMod } from './walker';

// ===================================================================
//  Type utilities
// ===================================================================

const PRIMITIVES = new Set(['any', 'unknown', 'never', 'void', 'number', 'string', 'boolean', 'bigint', 'symbol', 'object', 'undefined', 'null']);
export const NUMBER		= TS.RefType('number');
export const STRING		= TS.RefType('string');
export const BOOLEAN	= TS.RefType('boolean');
export const BIGINT		= TS.RefType('bigint');
export const REGEXP		= TS.RefType('RegExp');
export const ANY		= TS.RefType('any');
export const VOID		= TS.RefType('void');
export const UNDEFINED	= TS.RefType('undefined');
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

// De-dupes structurally-identical types (by JSON shape) and folds what's left into a `union`
export function combineTypes(types: Type[]): Type {
	const seen = new Set<string>();
	const unique: Type[] = [];
	const add = (t: Type) => {
		if (t.type === 'union') {
			t.types.forEach(add);
		} else {
			const key = JSON.stringify(t, (k, v) => k === 'pos' ? undefined : v);
			if (!seen.has(key)) {
				seen.add(key);
				unique.push(t);
			}
		}
	};
	types.forEach(add);
	return unique.length === 1 ? unique[0] : TS.UnionType(unique);
}

export function isNullish(type: Type) {
	return	type.type === 'literal'	? type.value === null
		:	type.type === 'ref'		? (type.name === 'undefined' || type.name === 'null' || type.name === 'void')
		:	false;
}

export function isFalsy(t: Type) 	{ return isNullish(t) || (t.type === 'literal' && !t.value); }
export function isTruthy(t: Type)	{ return (t.type === 'literal' && !!t.value) || ['object', 'array', 'tuple', 'function', 'constructor'].includes(t.type); }
export function isAny(t: Type)		{ return t.type === 'ref' && (t.name === 'any' || t.name === 'unknown'); }
export function isBoolean(t: Type)	{ return t.type === 'ref' && t.name === 'boolean'; }

export function widenLiterals(t: Type): Type {
	return	t.type === 'literal' && t.value !== null ? { type: 'ref', name: typeof t.value }
		:	t.type === 'union' ? combineTypes(t.types.map(widenLiterals))
		:	t;
}
// `??` never yields the left side's nullish members, `||` never its falsy ones, `&&` never its
// truthy ones. Widening keeps boolean literals: they encode which way a `&&`/`||` resolved
export function softWiden(t: Type): Type {
	return	t.type === 'literal' && typeof t.value !== 'boolean' ? widenLiterals(t)
		:	t.type === 'union' ? combineTypes(t.types.map(softWiden))
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
	if (depth < 0)
		return undefined;
	if (t.type === 'object')
		return t.members.filter((m): m is TS.TypeMember & { name: string } => (m.kind === 'property' || m.kind === 'method') && typeof m.name === 'string').map(m => m.name);
	if (t.type === 'intersection' || t.type === 'union') {
		const parts = t.types.map(p => objectKeyNames(scope.resolve(p, depth - 1), scope, depth - 1));
		if (!parts.every((p): p is string[] => !!p))
			return undefined;
		return t.type === 'intersection' ? [...new Set(parts.flat())] : parts[0].filter(k => parts.every(p => p.includes(k)));
	}
	return undefined;
}

// Whether a conditional's `extendsType` binds an `infer` anywhere.
function containsInfer(t: Type): boolean {
	let found = false;
	TSwalk(t, undefined, undefined, (x, process) => {
		if (x.type === 'infer')
			found = true;
		return process(x);
	});
	return found;
}

// Structurally matches `pattern` (a conditional's `extendsType`, containing `infer` nodes) against `actual` (the resolved check type),
// binding each `infer X` into `out`. Three-valued like `conditionalExtends`: `false` only once shapes are known to conflict outright, `undefined`
// when there's not enough information either way (an unresolved ref, an unhandled node shape) -- both leave the conditional opaque, not guessed.
// Subtrees with no `infer` inside them bottom out into ordinary `isAssignable`, so this only needs its own case for the handful of node kinds
// (ref/array/tuple/function/object/union) that can actually carry `infer` somewhere beneath them.
function matchInfer(pattern: Type, actual: Type, scope: Scope, out: Map<string, Type>, depth = 6): boolean | undefined {
	if (depth < 0)
		return undefined;
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
			: a.type === 'tuple' ? a.elements.every(e => { const t = tupleElementType(e); return t !== undefined && matchInfer(pattern.element, t, scope, out, depth - 1) !== false; }) || undefined
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
			const t = lookupMember(a, m.name, scope, depth - 1);
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
	if (depth < 0)
		return undefined;
	if (t.type === 'literal')
		return true;
	if (t.type === 'union') {
		const parts = t.types.map(m => isLiteralOnly(scope.resolve(m), scope, depth - 1));
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
	return e?.type === 'literal' && e.value !== null ? { type: 'ref', name: typeof e.value }
		: e?.type === 'bigint' ? BIGINT
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

const SINGLE_ELEMENT_ITERABLES = new Set(['Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Generator', 'Iterable', 'IterableIterator', 'Iterator']);

// `yield* x`'s delegated element type -- covers the common iterable shapes (arrays/tuples, `Set`, generators); anything
// else (a custom `[Symbol.iterator]`-implementing class) is opaque here, same lenient "unmodeled" fallback as elsewhere.
export function iterableElementType(t: Type, scope: Scope): Type {
	const r = scope.resolve(t);
	if (r.type === 'array')
		return r.element;
	if (r.type === 'tuple')
		return combineTypes(r.elements.map(e => tupleElementType(e)).filter((e): e is Type => !!e));
	if (r.type === 'ref' && r.typeArgs?.length && SINGLE_ELEMENT_ITERABLES.has(r.name))
		return r.typeArgs[0];
	return ANY;
}

// `export declare X` parses as `export_decl` wrapping a `declare` node wrapping the real declaration -- unwrap that inner layer too, or a
// `declare`d export (common in real `.d.ts` files) is invisible here. `Declare` needs a cast: it isn't in `TS.Declaration`'s declared union.
export const unwrapDeclare = (d: TS.Declaration): TS.Declaration =>
	(d as unknown as TS.Statement).type === 'declare' ? (d as unknown as TS.Declare).declaration : d;

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

// `defaultSubstitution`: cached on the entry itself, not a side-table -- it depends only on `typeParams`/`type` (both intrinsic to the entry, never
// `scope`), so caching it here lets the value outlive and be shared across checker instances instead of recomputing fresh in each one's own cache.
export interface TypeEntry { typeParams?: TS.TypeParam[]; type: Type; defaultSubstitution?: Type }

export class Scope {
	values		= new Map<string, Type>();
	types		= new Map<string, TypeEntry>();
	private narrowings?:	Map<string, Type>;	// control-flow refinements, consulted before declarations
	private aliases?:		Map<string, Expr>;	// const initializers -- narrowing a const also narrows through its initializer (TS 4.4 aliased conditions)
	namespaces?:	Map<string, Scope>;	// nested namespace/module scopes, keyed by their bound name -- consulted by `resolve` for a dotted type ref (`NS.Foo`)

	constructor(public parent?: Scope) {}

	value(name: string): Type | undefined			{ return this.narrowings?.get(name) ?? this.values.get(name) ?? this.parent?.value(name); }
	typeEntry(name: string): TypeEntry | undefined	{ return this.types.get(name) ?? this.parent?.typeEntry(name); }
	// The declaration-site type, ignoring narrowings -- what an assignment must satisfy
	declared(name: string): Type | undefined		{ return this.values.get(name) ?? this.parent?.declared(name); }
	alias(name: string): Expr | undefined			{ return this.aliases?.get(name) ?? (this.values.has(name) ? undefined : this.parent?.alias(name)); }
	namespace(name: string): Scope | undefined		{ return this.namespaces?.get(name) ?? this.parent?.namespace(name); }

	addNarrowing(name: string, t: Type)				{ (this.narrowings ??= new Map()).set(name, t); }
	addAlias(d: JS.VarDeclarator)					{ (this.aliases ??= new Map()).set(d.name, d.init); }
	addNamespace(name: string, s: Scope)			{ (this.namespaces ??= new Map()).set(name, s); }

	// Every name narrowed anywhere between this scope and `base` (exclusive); used to combine two independently-narrowed branches of a `||`/`&&` test.
	narrowedNames(base: Scope): Set<string> {
		const names = new Set<string>();
		for (let s: Scope | undefined = this; s && s !== base; s = s.parent)
			for (const name of s.narrowings?.keys() ?? [])
				names.add(name);
		return names;
	}

	// Expands a `ref` to its structural declaration, substituting type args (primitives/unresolvable names pass through unchanged). Bare generic
	// refs cache their default substitution on the entry, keeping repeats `===`-identical -- `isAssignable`'s fast path needs that to terminate self-referential types.
	resolve(t: Type, depth = 10): Type {
		if (depth < 0)
			return ANY;
		if (t.type === 'parenthesized')
			return this.resolve(t.inner, depth - 1);
		if (t.type === 'readonly')
			return this.resolve(t.argument, depth - 1);
		if (t.type === 'mapped' && !t.nameType) {
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
			const isKeyable = (x: Type): boolean => x.type === 'ref' && (x.name === 'string' || x.name === 'number' || x.name === 'symbol');
			if (isKeyable(constraint) || (constraint.type === 'union' && constraint.types.every(isKeyable))) {
				return this.resolve(TS.ObjectType([
					TS.TypeIndex('key', constraint, substituteType(t.valueType, new Map([[t.keyName, constraint]])), t.readonly)
				]), depth - 1);
			}
		}
		if (t.type === 'indexed_access') {
			// `T[K]`: resolvable only when the index resolves to a literal (or union of literals), by looking up each corresponding member.
			const index = this.resolve(t.index, depth - 1);
			const keys = index.type === 'literal' && typeof index.value === 'string' ? [index.value]
				: index.type === 'union' && index.types.every(m => m.type === 'literal' && typeof m.value === 'string') ? index.types.map(m => (m as { value: string }).value)
				: undefined;
			if (keys) {
				const object = this.resolve(t.object, depth - 1);
				const parts = keys.map(key => lookupMember(object, key, this, depth - 1));
				if (parts.every((p): p is Type => !!p))
					return this.resolve(combineTypes(parts), depth - 1);
			}
		}
		if (t.type === 'keyof') {
			// `keyof any` is an intrinsic (real TS special-cases it too, not a structural lookup) equal to every legal property-key
			// type -- without this, comparing against it always fell into the generic opaque-`keyof` GAP, even though it's actually
			// the single most common `keyof` position in real code (index-signature-style helper constraints, `Record`-like generics).
			// Checked on the *raw* argument, not `resolve()`'s output -- `resolve` also returns `ANY` as a generic "gave up" sentinel
			// once its recursion budget (`depth`) runs out on an unrelated, unrolled chain, which must not be mistaken for real `any`.
			if (isAny(t.argument))
				return TS.UnionType([{ type: 'ref', name: 'string' }, { type: 'ref', name: 'number' }, { type: 'ref', name: 'symbol' }]);
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
		}
		if (t.type === 'conditional') {
			// Only once `checkType` is concrete -- real TS also defers a conditional type until its naked check type is instantiated.
			const check = this.resolve(t.checkType, depth - 1);
			if (!isAny(check) && !(check.type === 'ref' && !PRIMITIVES.has(check.name) && !this.typeEntry(check.name))) {
				if (containsInfer(t.extendsType)) {
					const bindings = new Map<string, Type>();
					// `t.checkType`, not the already-resolved `check` -- resolving a real named type (e.g. lib.d.ts's own `Promise<T>`)
					// eagerly expands it to its full structural body, losing the "named `Promise<number>`" identity `matchInfer`'s
					// `ref`-typeArgs case needs to match against `Promise<infer R>` (same pitfall `inferTypeArgs` already works around).
					const r = matchInfer(t.extendsType, t.checkType, this, bindings, depth - 1);
					if (r !== undefined)
						return this.resolve(r ? substituteType(t.trueType, bindings) : t.falseType, depth - 1);
				} else {
					const r = conditionalExtends(check, this.resolve(t.extendsType, depth - 1), this);
					if (r !== undefined)
						return this.resolve(r ? t.trueType : t.falseType, depth - 1);
				}
			}
		}
		if (t.type === 'typeof') {
			const parts = t.name.split('.');
			let v: Type | undefined = this.value(parts[0]);
			for (let i = 1; v && i < parts.length; i++)
				v = lookupMember(v!, parts[i], this);
			return v ? this.resolve(v, depth - 1) : ANY;
		}
		if (t.type === 'ref' && !PRIMITIVES.has(t.name)) {
			// A dotted type ref (`NS.Foo`) isn't a plain declaration -- `typeEntry` only holds bare names, so route through the namespace's own scope.
			// An unresolvable prefix stays lenient (falls through to the plain lookup below, which also won't match a dotted key).
			const dot = t.name.indexOf('.');
			if (dot >= 0) {
				const ns = this.namespace(t.name.slice(0, dot));
				return ns ? ns.resolve({ ...t, name: t.name.slice(dot + 1) }, depth - 1) : t;
			}
			const entry = this.typeEntry(t.name);
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
		return t;
	}

	// Refines `name`'s binding to the union members `keep` accepts; anything non-union (or a filter
	// that would empty the union) narrows nothing. `name` may be a dotted path key
	narrowValue(name: string, keep: (m: Type) => boolean, t = this.value(name)): Scope {
		const r = t && this.resolve(t);
		if (!r || isAny(r))
			return this;
		if (r.type === 'union') {
			// A member may resolve to a further (type-alias-nested) union -- flatten fully before filtering, so a discriminant matching only
			// part of a compound member (`instanceof Uri` against `IconType0 | ThemeIcon`) filters at the right granularity, not the whole member.
			const flat		= combineTypes(r.types.map(m => this.resolve(m)));
			const flatTypes = flat.type === 'union' ? flat.types : [flat];
			const parts		= flatTypes.filter(keep);
			if (parts.length && parts.length < flatTypes.length) {
				const s = new Scope(this);
				s.addNarrowing(name, combineTypes(parts));
				return s;
			}
		} else if (!keep(r)) {
			// Non-union binding whose one and only type the guard rejects outright (e.g. `if (x)` where `x`'s whole
			// declared type is `undefined`) -- the branch is provably unreachable, same as real TS's `never` narrowing.
			const s = new Scope(this);
			s.addNarrowing(name, TS.RefType('never'));
			return s;
		}
		return this;
	}

	// Narrows `name` to `target`: union members are filtered by assignability; a non-union binding (or any binding, for an opaque `any` target)
	// is replaced outright when the guard holds. `name` may be a dotted path key.
	narrowTo(name: string, target: Type, sense: boolean, t = this.value(name)): Scope {
		const r = t && this.resolve(t);
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
	// `every`/`filter`/`find`/`findLast`: real generic signatures, so a callback that's itself an "inferred type predicate" (see `inferredPredicate`
	// in checker.ts) narrows the result, exactly like real TS 5.5+. A plain boolean callback leaves `S` uninferred, falling back to `elem`.
	if (prop === 'every' || prop === 'filter' || prop === 'find' || prop === 'findLast') {
		const S: Type = { type: 'ref', name: 'S' };
		return TS.FunctionType(
			[
				JS.Param('predicate', TS.FunctionType(
					[JS.Param('v', elem), JS.Param('i', NUMBER), JS.Param('arr', TS.ArrayType(elem))],
					TS.Predicate('v', S)
				)),
				JS.Param('thisArg', ANY, ['optional']),
			],
				prop === 'every' ? TS.Predicate('this', TS.ArrayType(S))
				: prop === 'filter' ? TS.ArrayType(S)
				: combineTypes([S, UNDEFINED]),
			[{ name: 'S', constraint: elem, default: elem }],
		);
	}
	const ret =
		prop === 'pop' || prop === 'shift' ? combineTypes([elem, UNDEFINED])
		: prop === 'push' || prop === 'unshift' || prop === 'indexOf' || prop === 'lastIndexOf' || prop === 'findIndex' ? NUMBER
		: prop === 'includes' || prop === 'some' ? BOOLEAN
		: prop === 'join' ? STRING
		: prop === 'slice' || prop === 'concat' || prop === 'reverse' || prop === 'flat' ? { type: 'array', element: elem } as Type
		: undefined;
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
	if (depth < 0)
		return ANY;
	// `resolve()` gets a fresh budget here, not `depth` -- its own nominal-unfolding budget is unrelated to how deep this structural
	// comparison already is. Sharing it let a several-level `extends` chain exhaust the budget and silently resolve to `any`, hiding real members.
	t = scope.resolve(t);
	if (prop === 'length' && (t.type === 'array' || t.type === 'tuple' || (t.type === 'ref' && t.name === 'string')))
		return NUMBER;
	if (prop === 'constructor')
		return ANY;		// every object has one; its shape isn't modeled
	if (t.type === 'array' || t.type === 'tuple') {
		const m = arrayMethod(t.type === 'array' ? t.element : combineTypes(t.elements.map(tupleElementType).filter((x): x is Type => !!x)), prop);
		if (m)
			return m;
	}
	switch (t.type) {
		case 'object': {
			const ms = t.members.filter(m => (m.kind === 'property' || m.kind === 'method') && m.name === prop);
			if (ms.length > 1) {
				// Real overloads (every member here must be a same-named `method`) group into one multi-signature callable,
				// the same shape `hoist` builds for free-function overloads, so `typeOf`'s call/new handling resolves both identically.
				return ms.every(m => m.kind === 'method')
					? TS.ObjectType(ms.map((m): TS.TypeMember => ({ kind: 'call', params: m.params, rest: m.rest, returnType: m.returnType ?? ANY, typeParams: m.typeParams })))
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
				// `'params' in args[0]`), regardless of whether `rest`/`typeParams` are present.
				return TS.FunctionType({ params: m.params, rest: m.rest, returnType: m.returnType ?? ANY, typeParams: m.typeParams });
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
					const r = scope.resolve(part, depth - 1);
					const idx = r.type === 'object' ? r.members.find(m => m.kind === 'index') : undefined;
					if (idx)
						return idx.typeAnnotation;
				}
				return objectPrototypeMember(prop);
			}
			if (matches.length === 1)
				return matches[0];
			// More than one part declaring the same-named method is real TS's own cross-file declaration-merging shape
			// (e.g. `ArrayConstructor.from` split across `lib.es2015.core.d.ts`/`lib.es2015.iterable.d.ts`, modeled here
			// as an intersection of each file's own interface) -- combine into one multi-signature overload set, same
			// as the `object` case's own handling of several same-named `method` members within a single interface.
			// Each match is itself either a single signature (`function`, one declaration of `prop`) or an already-merged
			// multi-signature set (`object` of `call` members, when *one* part alone had several overloads of `prop`) --
			// flatten both shapes into one combined list. Anything else (a plain property, or a genuine structural
			// intersection with mismatched member kinds) keeps "first match wins", the right call for class-inheritance
			// override, and safer when kinds don't line up.
			const sigs: TS.CallSig[] = [];
			for (const m of matches) {
				if (m.type === 'function')
					sigs.push(m);
				else if (m.type === 'object' && m.members.length && m.members.every((mem): mem is TS.TypeMember & { kind: 'call' } => mem.kind === 'call'))
					sigs.push(...m.members);
				else
					return matches[0];
			}
			return TS.ObjectType(sigs.map((s): TS.TypeMember => ({ kind: 'call', params: s.params, rest: s.rest, returnType: s.returnType, typeParams: s.typeParams })));
		}
		case 'union': {
			const parts = t.types.map(p => lookupMember(p, prop, scope, depth - 1));
			return parts.every(p => !!p) ? combineTypes(parts as Type[]) : undefined;
		}
		default:
			return undefined;
	}
}

// A shape is "sealed" when a missing member is genuinely an error (an object type we fully know),
// as opposed to a ref/primitive/array whose built-in members this checker doesn't model.
export function sealed(t: Type, scope: Scope, depth = 6): boolean {
	if (depth < 0)
		return false;
	t = scope.resolve(t);
	return t.type === 'object' || (t.type === 'intersection' && t.types.every(p => sealed(p, scope, depth - 1)));
}

const OPAQUE = new Set(['keyof', 'indexed_access', 'conditional', 'infer', 'mapped', 'this', 'predicate']);

// The subset of `OPAQUE` that's a genuinely unevaluated computation, as opposed to `this`/`predicate` (opaque by design, not a gap).
// In `strict` mode below, either side being one of these fails the comparison instead of auto-passing it.
const OPAQUE_GAP = new Set(['keyof', 'indexed_access', 'conditional', 'infer', 'mapped']);

// `dstScope` resolves names in `dst`'s own structure, distinct from `scope` (which resolves `src`'s) -- they're the same scope almost always
// (hence the default), but a `dst` originating from another module's own signature (a namespace-imported overload's declared param type, e.g.
// `bin.as`'s `adapter0<T,D>`) declares its own names in *that* module's scope. Every recursive call below passes each value's own origin scope
// through, not just its parameter position -- see the tuple/array-widening branch for the one place a value's role flips between calls.
export function isAssignable(src: Type, dst: Type, scope: Scope, dstScope: Scope = scope, strict = false, depth = 10): boolean {
	function recurse(src: Type, dst: Type, depth: number): boolean {
		if (depth < 0)
			return true;
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
			return (src.type === 'template_literal' || src.type === 'ref' && src.name === 'string')
				&& (dst.type === 'template_literal' || dst.type === 'ref' && dst.name === 'string');

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
				const got = lookupMember(src, m.name, scope, depth - 1);
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

export function isBigint(t: Type, scope: Scope): boolean {
	const r = scope.resolve(t);
	return r.type === 'ref' && r.name === 'bigint' || r.type === 'literal' && typeof r.value === 'bigint'
		|| r.type === 'union' && r.types.every(m => isBigint(m, scope));
};

// Inferred unions over-approximate, so only complain when no member could be numeric
export function isNumberLike(t: Type, scope: Scope): boolean {
	const r = scope.resolve(t);
	return r.type === 'union' ? r.types.some(m => isAssignable(m, NUMERIC, scope)) : isAssignable(r, NUMERIC, scope);
}

export function memberOptional(t: Type, prop: string, scope: Scope, depth = 6): boolean {
	t = scope.resolve(t);
	return t.type === 'object' ? t.members.some(m => (m.kind === 'property' || m.kind === 'method') && m.name === prop && m.optional)
		: t.type === 'intersection' && depth > 0 && t.types.some(p => memberOptional(p, prop, scope, depth - 1));
}

// `instance` is the type of `new C(...)`/`this`; `value` is the class binding's own type (construct signature intersected with static members).
// Pure function of its arguments, no checker state, so callers inside `makeChecker` can call it regardless of where they're defined in that closure.
export function classShapes(c: JS.Class): { instance: Type; value: Type } {
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
			const fn = m.value;
			if (m.key === 'constructor') {
				ctorParams = FixParams(fn);
				// A parameter-property modifier is anything but the unrelated `'optional'` tag.
				for (const p of fn.params)
					if (p.modifiers?.some(x => x !== 'optional') && typeof p.key === 'string')
						members.push(TS.TypeProperty(p.key, (p.typeAnnotation as Type) ?? literalTypeOf(p.default) ?? ANY, hasMod(p, 'optional')));
			} else if (m.kind === 'get') {
				list.push({ kind: 'property', name: m.key, typeAnnotation: (fn.returnType as Type) ?? ANY });
			} else if (m.kind === 'set') {
				if (!list.some(x => x.kind === 'property' && x.name === m.key))
					list.push(TS.TypeProperty(m.key, (fn.params[0]?.typeAnnotation as Type) ?? ANY));
			} else {
				list.push(TS.TypeMethod(m.key, FixSig(fn, ANY), hasMod(m, 'optional')));
			}
		} else if (m.type === 'method_signature') {
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
				list.push(TS.TypeMethod(m.key, FixSig(m, ANY), hasMod(m, 'optional')));
			}
		}
	}
	const obj = TS.ObjectType(members);
	// a base the checker can't model (mixin call, namespace member, imported class) leaves the instance unsealed; likewise an inherited constructor accepts any arguments.
	// Own members come first: lookupMember's first match implements override precedence
	const superType: Type | undefined =
		c.superClass?.type === 'identifier' ? { type: 'ref', name: c.superClass.name }
		: c.superClass?.type === 'instantiation' && c.superClass.expression.type === 'identifier' ? { type: 'ref', name: c.superClass.expression.name, typeArgs: c.superClass.typeArgs as Type[] }
		: c.superClass ? ANY : undefined;
	const instance: Type = superType ? TS.IntersectionType([obj, superType]) : obj;
	if (!ctorParams)
		ctorParams = {params: [], rest: c.superClass ? JS.Rest('args', TS.ArrayType(ANY)) : undefined};
	const ctor:		Type = {
		type: 'constructor',
		...TS.CallSig(ctorParams, c.name ? TS.RefType(c.name) : instance, c.typeParams as TS.TypeParam[])
	};
	return { instance, value: staticMembers.length ? TS.IntersectionType([ctor, TS.ObjectType(staticMembers)]) : ctor };
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


export function wrapType(t: Type, names: Set<string>, name: string) {
	return t.type === 'ref' && names.has(t.name) ? t : { type: 'ref', name, typeArgs: [t] };
}
