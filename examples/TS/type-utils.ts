/* eslint-disable @typescript-eslint/no-unused-expressions */
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
export const NUMBER:		Type	= { type: 'ref', name: 'number' };
export const STRING:		Type	= { type: 'ref', name: 'string' };
export const BOOLEAN:		Type	= { type: 'ref', name: 'boolean' };
export const BIGINT:		Type	= { type: 'ref', name: 'bigint' };
export const REGEXP:		Type	= { type: 'ref', name: 'RegExp' };
export const ANY:			Type	= { type: 'ref', name: 'any' };
export const VOID:			Type	= { type: 'ref', name: 'void' };
export const UNDEFINED:		Type	= { type: 'ref', name: 'undefined' };
export const NUMERIC:		Type	= { type: 'union', types: [NUMBER, BIGINT] };

export function bindingNames(t: BindingTarget): string[] {
	return typeof t === 'string' ? [t]
		: t.type === 'object_pattern' ? [...t.properties.flatMap(p => bindingNames(p.value)), ...(t.rest ? [t.rest] : [])]
		: [...t.elements.flatMap(e => e ? bindingNames(e.target) : []), ...(t.rest ? [t.rest] : [])];
}

// De-dupes structurally-identical types (by JSON shape) and folds what's left into a `union` -- shared by every inference case that combines
// several possible types into one (multiple `return`s, a ternary's branches, an array literal's elements, `||`/`??`/`&&`'s operands).
export function combineTypes(types: Type[]): Type {
	const seen = new Set<string>();
	const unique: Type[] = [];
	const add = (t: Type) => {
		if (t.type === 'union') {
			t.types.forEach(add);
		} else {
			// Every AST-derived type node carries its own source `pos` -- structurally identical types from different
			// source locations (e.g. two separate `Polynomial<number>` results merged into one union) would otherwise
			// never dedupe, since their `pos` fields differ even though the *type* itself doesn't.
			const key = JSON.stringify(t, (k, v) => k === 'pos' ? undefined : v);
			if (!seen.has(key)) {
				seen.add(key);
				unique.push(t);
			}
		}
	};
	types.forEach(add);
	return unique.length === 1 ? unique[0] : { type: 'union', types: unique };
}

export function isNullishType(type: Type) {
	return	type.type === 'literal'	? type.value === null
		:	type.type === 'ref'		? (type.name === 'undefined' || type.name === 'null' || type.name === 'void')
		:	false;
}

export function isFalsyType(t: Type) 	{ return isNullishType(t) || (t.type === 'literal' && !t.value); }
export function isTruthyType(t: Type)	{ return (t.type === 'literal' && !!t.value) || ['object', 'array', 'tuple', 'function', 'constructor'].includes(t.type); }
export function isAny(t: Type)			{ return t.type === 'ref' && (t.name === 'any' || t.name === 'unknown'); }

export function widenLiterals(t: Type): Type {
	return	t.type === 'literal' && t.value !== null ? { type: 'ref', name: typeof t.value }
		:	t.type === 'union' ? combineTypes(t.types.map(widenLiterals))
		:	t;
}

// Replaces type-parameter references with their instantiating arguments (`Foo<string>` -> Foo's body with T := string)
export function substituteType(t: Type, map: Map<string, Type>): Type {
	return TSwalk(t, undefined, undefined, (x, process) =>
		x.type === 'ref' && !x.typeArgs && map.has(x.name) ? map.get(x.name) : process(x)
	) ?? t;
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

	// Expands a `ref` to its structural declaration, substituting type args (primitives/unresolvable names pass through unchanged).
	// Bare generic refs (`Function`) always substitute the same default args, so caching the result on the entry (see `TypeEntry.defaultSubstitution`)
	// keeps repeated resolutions of the same entry `===`-identical -- `isAssignable`'s reference-equality fast path needs that to terminate
	// self-referential types.
	resolve(t: Type, depth = 0): Type {
		if (depth > 10)
			return ANY;
		if (t.type === 'parenthesized')
			return this.resolve(t.inner, depth + 1);
		if (t.type === 'readonly')
			return this.resolve(t.argument, depth + 1);
		if (t.type === 'mapped' && !t.nameType) {
			// A mapped type's members are only knowable once its key constraint resolves to something concrete -- one member
			// per literal (or per member of a union of literals); anything else (a bare `string`, an unresolved type
			// parameter) stays opaque, same as before this case existed. `nameType` (the `as` key-remapping clause, e.g.
			// `[P in K as \`get${P}\`]`) isn't handled -- bail out rather than expand under the wrong (un-remapped) names.
			const constraint = this.resolve(t.constraint, depth + 1);
			const keys = constraint.type === 'literal' && typeof constraint.value === 'string' ? [constraint.value]
				: constraint.type === 'union' && constraint.types.every(m => m.type === 'literal' && typeof m.value === 'string') ? constraint.types.map(m => (m as { value: string }).value)
				: undefined;
			if (keys) {
				return this.resolve({ type: 'object', members: keys.map((key): TS.TypeMember => ({
					kind: 'property',
					name: key,
					optional: t.optional,
					readonly: t.readonly,
					typeAnnotation: substituteType(t.valueType, new Map([[t.keyName, { type: 'literal', value: key }]])),
				})) }, depth + 1);
			}
		}
		if (t.type === 'indexed_access') {
			// `T[K]` (commonly paired with a mapped type's own `{[P in K]: T[P]}` value position): resolvable the same
			// way -- only when the index resolves to a literal (or union of literals), by looking up each corresponding
			// member on the object type and combining the results; anything else stays opaque.
			const index = this.resolve(t.index, depth + 1);
			const keys = index.type === 'literal' && typeof index.value === 'string' ? [index.value]
				: index.type === 'union' && index.types.every(m => m.type === 'literal' && typeof m.value === 'string') ? index.types.map(m => (m as { value: string }).value)
				: undefined;
			if (keys) {
				const object = this.resolve(t.object, depth + 1);
				const parts = keys.map(key => lookupMember(object, key, this, depth + 1));
				if (parts.every((p): p is Type => !!p))
					return this.resolve(combineTypes(parts), depth + 1);
			}
		}
		if (t.type === 'typeof') {
			const parts = t.name.split('.');
			let v: Type | undefined = this.value(parts[0]);
			for (let i = 1; v && i < parts.length; i++)
				v = lookupMember(v!, parts[i], this);
			return v ? this.resolve(v, depth + 1) : ANY;
		}
		if (t.type === 'ref' && !PRIMITIVES.has(t.name)) {
			// A dotted type ref (`NS.Foo`) names a type nested inside a namespace, not a plain declaration -- `typeEntry` only ever holds
			// bare names, so route through the namespace's own (parent-less) scope instead. An unresolvable prefix stays lenient (falls
			// through to the plain lookup below, which also won't match a dotted key, and the ref is returned as-is).
			const dot = t.name.indexOf('.');
			if (dot >= 0) {
				const ns = this.namespace(t.name.slice(0, dot));
				return ns ? ns.resolve({ ...t, name: t.name.slice(dot + 1) }, depth + 1) : t;
			}
			const entry = this.typeEntry(t.name);
			if (entry) {
				if (!entry.typeParams?.length)
					return this.resolve(entry.type, depth + 1);
				if (!t.typeArgs) {
					entry.defaultSubstitution ??= substituteType(entry.type, new Map(entry.typeParams.map(p => [p.name, p.default ?? ANY])));
					return this.resolve(entry.defaultSubstitution, depth + 1);
				}
				return this.resolve(substituteType(entry.type, new Map(entry.typeParams.map((p, i) => [p.name, t.typeArgs?.[i] ?? p.default ?? ANY]))), depth + 1);
			}
		}
		return t;
	}

	// Refines `name`'s binding to the union members `keep` accepts; anything non-union (or a filter
	// that would empty the union) narrows nothing. `name` may be a dotted path key
	narrowValue(name: string, keep: (m: Type) => boolean, t = this.value(name)): Scope {
		const r = t && this.resolve(t);
		if (r?.type === 'union') {
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
export function fnSigParams(params: JS.ParamList) {
	const result: TS.ParamList = {
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
export function fnSigParamsReturn(params: JS.CallSig, defaultRet?: Type): TS.CallSig {
	return { ...fnSigParams(params),
		returnType: params.returnType as Type ?? defaultRet,
		typeParams: params.typeParams as TS.TypeParam[]
	};
}

// Just enough built-in array members that element types survive `pop()!` etc.
// (`find`/`filter` are left unmodeled: their results depend on type-guard callbacks)
function arrayMethod(elem: Type, prop: string): Type | undefined {
	// `map`'s result depends on the callback's own return type, not a fixed formula of `elem` -- needs a real generic signature (unlike the
	// fixed-return-type methods below), or its result silently falls back to `ANY`, which can then poison a *constrained* generic elsewhere
	// that can't infer anything useful from an `ANY` argument and falls back to its own constraint (a confusing error nowhere near the real cause).
	if (prop === 'map')
		return {
			type: 'function', typeParams: [{ name: 'U' }],
			params: [
				{ key: 'callback', typeAnnotation: { type: 'function', params: [{ key: 'v', typeAnnotation: elem }, { key: 'i', typeAnnotation: NUMBER }, { key: 'arr', typeAnnotation: { type: 'array', element: elem } }], returnType: { type: 'ref', name: 'U' } } },
				{ key: 'thisArg', modifiers: ['optional'], typeAnnotation: ANY },
			],
			returnType: { type: 'array', element: { type: 'ref', name: 'U' } },
		};
	// Real `.flat()` is a recursive conditional type keyed off an explicit depth argument; only the common, argument-less
	// (depth-1) case is modeled here -- unwrap one level of nesting when `elem` is itself structurally an array, else a
	// no-op (flattening an already-flat array just returns it unchanged, same as real TS). An unmodeled explicit depth
	// falls back to the fixed-return-type methods below, `ANY`-tolerant like everything else this checker doesn't model.
	if (prop === 'flat' && elem.type === 'array')
		return { type: 'function', params: [], rest: { key: 'args', typeAnnotation: { type: 'array', element: NUMBER } }, returnType: { type: 'array', element: elem.element } };
	// `every`/`filter`/`find`/`findLast`: real generic signatures, so a callback that's itself an "inferred
	// type predicate" (see `inferredPredicate` in checker.ts -- `x => x != null`, `x => x instanceof Foo`,
	// etc.) narrows the result through the same generic-inference machinery `.map`'s `U` uses, exactly like
	// real TS 5.5+. A plain (non-predicate) boolean callback leaves `S` uninferred, which falls back to its
	// own `constraint`/`default` -- both set to `elem` -- reproducing the old fixed-shape behavior.
	if (prop === 'every' || prop === 'filter' || prop === 'find' || prop === 'findLast') {
		const S: Type = { type: 'ref', name: 'S' };
		return {
			type: 'function', typeParams: [{ name: 'S', constraint: elem, default: elem }],
			params: [
				{ key: 'predicate', typeAnnotation: {
					type: 'function',
					params: [{ key: 'v', typeAnnotation: elem }, { key: 'i', typeAnnotation: NUMBER }, { key: 'arr', typeAnnotation: { type: 'array', element: elem } }],
					returnType: { type: 'predicate', paramName: 'v', assertedType: S },
				} },
				{ key: 'thisArg', modifiers: ['optional'], typeAnnotation: ANY },
			],
			returnType:
				prop === 'every' ? { type: 'predicate', paramName: 'this', assertedType: { type: 'array', element: S } }
				: prop === 'filter' ? { type: 'array', element: S }
				: combineTypes([S, UNDEFINED]),
		};
	}
	const ret =
		prop === 'pop' || prop === 'shift' ? combineTypes([elem, UNDEFINED])
		: prop === 'push' || prop === 'unshift' || prop === 'indexOf' || prop === 'lastIndexOf' || prop === 'findIndex' ? NUMBER
		: prop === 'includes' || prop === 'some' ? BOOLEAN
		: prop === 'join' ? STRING
		: prop === 'slice' || prop === 'concat' || prop === 'reverse' || prop === 'flat' ? { type: 'array', element: elem } as Type
		: undefined;
	return ret && { type: 'function', params: [], rest: { key: 'args', typeAnnotation: { type: 'array', element: ANY } }, returnType: ret };
}

// `Object.prototype`'s members, for object types that don't declare their own override -- `hasOwnProperty`/`isPrototypeOf`/
// `propertyIsEnumerable` take `ANY` (not the real `PropertyKey`) to stay lenient rather than modeling a `string|number|symbol` union.
function objectPrototypeMember(prop: string): Type | undefined {
	return	prop === 'toString' || prop === 'toLocaleString' ? { type: 'function', params: [], returnType: STRING }
		:	prop === 'valueOf' ? { type: 'function', params: [], returnType: ANY }
		:	prop === 'hasOwnProperty' || prop === 'isPrototypeOf' || prop === 'propertyIsEnumerable' ? { type: 'function', params: [{ key: 'v', typeAnnotation: ANY }], returnType: BOOLEAN }
		:	undefined;
}

// `skipObjectFallback`: an intersection member representing "this class/interface's own declared shape" (as opposed to the
// intersection as a whole, e.g. a class extending a superclass is `{ownMembers} & {superClassRef}`) must NOT resolve
// `Object.prototype` members on its own -- that would make `case 'intersection'`'s "first part with a match wins" search
// stop at the (fallback-satisfied) own-members part before ever reaching the superclass part with the real declaration.
// Only set by `case 'intersection'` for its own recursive per-part search; every other caller leaves it at the default
// (fallback enabled), including the top-level call for a part-less object and each independent member of a union.
export function lookupMember(t: Type, prop: string, scope: Scope, depth = 0, skipObjectFallback = false): Type | undefined {
	if (depth > 10)
		return ANY;
	t = scope.resolve(t, depth);
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
			if (ms.length > 1)
				return ANY;		// overloads: not resolved, stay lenient
			const m = ms[0];
			return	m?.kind === 'property' ? m.typeAnnotation
				:	m?.kind === 'method' ? { type: 'function', params: m.params, rest: m.rest, returnType: m.returnType ?? ANY, typeParams: m.typeParams }
				:	t.members.find(m => m.kind === 'index')?.typeAnnotation
				// `Object.prototype`'s own members -- implicitly present on every object-shaped value in real TS (inherited from
				// the global `Object` interface) regardless of what the value's own declared shape lists; checked last, so a
				// type that declares its own override (e.g. a custom `toString(x?: string): string`) still wins.
				?? (skipObjectFallback ? undefined : objectPrototypeMember(prop));
		}
		case 'intersection':
			for (const part of t.types) {
				const m = lookupMember(part, prop, scope, depth + 1, true);
				if (m)
					return m;
			}
			// Every part searched, including inherited ones, and none declared `prop` -- now it's safe to fall back.
			return skipObjectFallback ? undefined : objectPrototypeMember(prop);
		case 'union': {
			const parts = t.types.map(p => lookupMember(p, prop, scope, depth + 1));
			return parts.every(p => !!p) ? combineTypes(parts as Type[]) : undefined;
		}
		default:
			return undefined;
	}
}

// A shape is "sealed" when a missing member is genuinely an error (an object type we fully know),
// as opposed to a ref/primitive/array whose built-in members this checker doesn't model.
export function sealed(t: Type, scope: Scope, depth = 0): boolean {
	if (depth > 6)
		return false;
	t = scope.resolve(t);
	return t.type === 'object' || (t.type === 'intersection' && t.types.every(p => sealed(p, scope, depth + 1)));
}

const OPAQUE = new Set(['keyof', 'indexed_access', 'conditional', 'infer', 'mapped', 'this', 'predicate']);

export function isAssignable(src: Type, dst: Type, scope: Scope, depth = 0): boolean {
	if (depth > 10)
		return true;
	if (src.type === 'ref' && dst.type === 'ref' && src.name === dst.name) {
		const sa = src.typeArgs ?? [], da = dst.typeArgs ?? [];
		if (sa.length === da.length && sa.every((a, i) => isAssignable(a, da[i], scope, depth + 1)))
			return true;	// same named type, pairwise-compatible arguments: skip the structural comparison
	}
	src = scope.resolve(src, depth);
	dst = scope.resolve(dst, depth);
	// same node (common once `resolve`'s default-substitution cache is in play, e.g. two paths into
	// the same self-referential union both bottoming out at the identical cached instance): trivially assignable.
	if (src === dst)
		return true;

	if (isAny(src) || isAny(dst) || (src.type === 'ref' && src.name === 'never'))
		return true;
	if (src.type === 'ref' && !PRIMITIVES.has(src.name))
		return true;		// unresolved named source (import/global/type parameter): lenient
	if (OPAQUE.has(src.type) || OPAQUE.has(dst.type))
		return true;

	if (src.type === 'union')
		return src.types.every(t => isAssignable(t, dst, scope, depth + 1));
	if (dst.type === 'union')
		// the identity test makes a narrowed union (whose members are the original alias's own nodes) trivially assignable back to it
		return dst.types.some(t => t === src || isAssignable(src, t, scope, depth + 1));
	if (dst.type === 'intersection')
		return dst.types.every(t => isAssignable(src, t, scope, depth + 1));
	if (src.type === 'intersection' && dst.type !== 'object')
		return src.types.some(t => isAssignable(t, dst, scope, depth + 1));

	if (dst.type === 'literal')
		return src.type === 'literal' ? src.value === dst.value
			: src.type === 'ref' && dst.value !== null && src.name === typeof dst.value;	// widened source: lenient
	if (src.type === 'literal')
		return dst.type === 'ref' && (!PRIMITIVES.has(dst.name) || dst.name === (src.value === null ? 'null' : typeof src.value));
	if (src.type === 'template_literal' || dst.type === 'template_literal')
		return (src.type === 'template_literal' || src.type === 'ref' && src.name === 'string')
			&& (dst.type === 'template_literal' || dst.type === 'ref' && dst.name === 'string');

	if (dst.type === 'array')
		return src.type === 'array' ? isAssignable(src.element, dst.element, scope, depth + 1)
			: src.type === 'tuple' && src.elements.every(e => { const t = tupleElementType(e); return !t || isAssignable(t, dst.element, scope, depth + 1); });
	if (dst.type === 'tuple') {
		if (src.type === 'array')	// an inferred array literal has lost its element positions: compare loosely
			return dst.elements.every(el => { const t = tupleElementType(el); return !t || isAssignable(src.element, t, scope, depth + 1) || isAssignable(t, src.element, scope, depth + 1); });
		if (src.type !== 'tuple')
			return false;
		return src.elements.length >= dst.elements.filter(e => !(e.type === 'optional' || e.type === 'spread' || (e.type === 'labeled' && e.optional))).length
			&& src.elements.every((e, i) => {
				const st = tupleElementType(e), dt = dst.type === 'tuple' && dst.elements[i] ? tupleElementType(dst.elements[i]) : undefined;
				return !st || !dt || isAssignable(st, dt, scope, depth + 1);
			});
	}

	if (dst.type === 'function' || dst.type === 'constructor') {
		if (src.type !== dst.type)
			return src.type === 'object' && src.members.some(m => m.kind === (dst.type === 'constructor' ? 'construct' : 'call'));
		// parameters deliberately unchecked (bivariance noise); returns covariant, void-dst absorbs anything
		return dst.returnType!.type === 'ref' && dst.returnType.name === 'void'
			|| isAssignable(src.returnType!, dst.returnType!, scope, depth + 1);
	}

	if (dst.type === 'object') {
		if (src.type !== 'object' && src.type !== 'intersection')
			return src.type === 'ref' && !PRIMITIVES.has(src.name)		// unresolved nominal: lenient
				|| src.type === 'function' || src.type === 'constructor' || src.type === 'array' || src.type === 'tuple'
					? dst.members.every(m => m.kind !== 'property' || m.optional)
					: false;
		return dst.members.every(m => {
			if (m.kind !== 'property' || typeof m.name !== 'string')
				return true;		// methods/call/index/computed: lenient
			const got = lookupMember(src, m.name, scope, depth + 1);
			// an optional property also accepts undefined; absence only counts against a sealed source
			return got ? isAssignable(got, m.optional ? { type: 'union', types: [m.typeAnnotation, UNDEFINED] } : m.typeAnnotation, scope, depth + 1)
				: !!m.optional || !sealed(src, scope) || isAssignable(UNDEFINED, m.typeAnnotation, scope, depth + 1);
		});
	}

	if (dst.type === 'ref') {
		if (dst.name === 'object')
			return !(src.type === 'ref' && PRIMITIVES.has(src.name)) || src.name === 'object' || src.name === 'null';
		if (dst.name === 'void')
			return src.type === 'ref' && (src.name === 'void' || src.name === 'undefined');
		if (src.type === 'ref') {
			if (src.name === dst.name)
				return !dst.typeArgs || !src.typeArgs || src.typeArgs.length !== dst.typeArgs.length
					|| src.typeArgs.every((a, i) => isAssignable(a, dst.typeArgs![i], scope, depth + 1));
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

export function memberOptional(t: Type, prop: string, scope: Scope, depth = 0): boolean {
	t = scope.resolve(t, depth);
	return t.type === 'object' ? t.members.some(m => (m.kind === 'property' || m.kind === 'method') && m.name === prop && m.optional)
		: t.type === 'intersection' && depth < 6 && t.types.some(p => memberOptional(p, prop, scope, depth + 1));
}

// `instance` is the type of `new C(...)`/`this`; `value` is the class binding's own type (construct signature intersected with static members).
// Pure function of its arguments, no checker state, so callers inside `makeChecker` can call it regardless of where they're defined in that closure.
export function classShapes(c: JS.Class): { instance: Type; value: Type } {
	const members:			TS.TypeMember[] = [];
	const staticMembers:	TS.TypeMember[] = [];
	let ctorParams:			TS.ParamList | undefined;

	for (const m of c.body as TS.ClassMember[]) {
		if (!('key' in m) || typeof m.key !== 'string') {
			if (m.type === 'index_signature')
				members.push({ kind: 'index', paramName: m.paramName, paramType: m.paramType, typeAnnotation: m.typeAnnotation });
			continue;
		}
		const list = 'modifiers' in m && hasMod(m, 'static') ? staticMembers : members;
		if (m.type === 'field') {
			list.push({ kind: 'property', name: m.key, optional: hasMod(m, 'optional'), typeAnnotation: (m.typeAnnotation as Type) ?? ANY });
		} else if (m.type === 'method') {
			const fn = m.value;
			if (m.key === 'constructor') {
				ctorParams = fnSigParams(fn);
				// A parameter-property modifier is anything but the unrelated `'optional'` tag.
				for (const p of fn.params)
					if (p.modifiers?.some(x => x !== 'optional') && typeof p.key === 'string')
						members.push({ kind: 'property', name: p.key, typeAnnotation: (p.typeAnnotation as Type) ?? literalTypeOf(p.default) ?? ANY });
			} else if (m.kind === 'get') {
				list.push({ kind: 'property', name: m.key, typeAnnotation: (fn.returnType as Type) ?? ANY });
			} else if (m.kind === 'set') {
				if (!list.some(x => x.kind === 'property' && x.name === m.key))
					list.push({ kind: 'property', name: m.key, typeAnnotation: (fn.params[0]?.typeAnnotation as Type) ?? ANY });
			} else {
				list.push({ kind: 'method', name: m.key, optional: hasMod(m, 'optional'), ...fnSigParamsReturn(fn) });
			}
		} else if (m.type === 'method_signature') {
			if (m.key === 'constructor') {
				// A bodyless `constructor(...);` signature -- the only form an ambient/`.d.ts` class
				// body ever uses -- mirrors the real-`method` branch's constructor handling above.
				ctorParams = fnSigParams(m);
			} else if (m.kind === 'get') {
				list.push({ kind: 'property', name: m.key, typeAnnotation: (m.returnType as Type) ?? ANY });
			} else if (m.kind === 'set') {
				if (!list.some(x => x.kind === 'property' && x.name === m.key))
					list.push({ kind: 'property', name: m.key, typeAnnotation: (m.params[0]?.typeAnnotation as Type) ?? ANY });
			} else {
				list.push({ kind: 'method', name: m.key, optional: hasMod(m, 'optional'), ...fnSigParamsReturn(m) });
			}
		}
	}
	const obj = TS.ObjectType(members);
	// a base the checker can't model (mixin call, namespace member, imported class) leaves the instance unsealed; likewise an inherited constructor accepts any arguments.
	// Own members come first: lookupMember's first match implements override precedence
	const instance: Type = c.superClass ? { type: 'intersection', types: [obj, c.superClass.type === 'identifier' ? { type: 'ref', name: c.superClass.name } : ANY] } : obj;
	if (!ctorParams)
		ctorParams = {params: [], rest: c.superClass ? {key: 'args', typeAnnotation: { type: 'array', element: ANY }} : undefined};
	const ctor:		Type = { type: 'constructor', ...ctorParams, returnType: c.name ? { type: 'ref', name: c.name } : instance, typeParams: c.typeParams as TS.TypeParam[] | undefined };
	return { instance, value: staticMembers.length ? { type: 'intersection', types: [ctor, { type: 'object', members: staticMembers }] } : ctor };
}
