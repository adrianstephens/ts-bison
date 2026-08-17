/* eslint-disable @typescript-eslint/no-unused-expressions */
import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Literal } from '../common';
import { hasMod, isTsDeclaration, walkB } from './walker';
import * as T from './type-utils';

type Type = TS.Type;
type Expr = JS.Expr;
type Scope = T.Scope;
const Scope = T.Scope;

// ===================================================================
//  statement utils
// ===================================================================

// A body with zero `return`s normally infers `void` -- but if every path ends in `throw`, real TS infers `never`
// instead, which (unlike `void`) is assignable to any declared return type. Not a full CFG.
function alwaysThrows(stmt: JS.Statement<any> | undefined): boolean {
	if (!stmt)
		return false;
	switch (stmt.type) {
		case 'throw':	return true;
		case 'block':	return stmt.body.length > 0 && alwaysThrows(stmt.body[stmt.body.length - 1]);
		case 'if':		return !!stmt.alternate && alwaysThrows(stmt.consequent) && alwaysThrows(stmt.alternate);
		case 'try':		return (!stmt.handlerBody || alwaysThrows(stmt.handlerBody[stmt.handlerBody.length - 1])) && alwaysThrows(stmt.block[stmt.block.length - 1]);
		default:		return false;
	}
}

// A declared callback param is routinely a union (lib.d.ts's `((value: T) => R) | undefined | null` style for nullable
// callbacks, e.g. `Promise.then`) -- dig through it to find the function/constructor alternative.
function resolveFnMember(t: Type, scope: Scope): TS.CallSig | undefined {
	const r = T.resolveOwn(t, scope);
	if (r.type === 'function' || r.type === 'constructor')
		return r;
	if (r.type === 'union') {
		for (const m of r.types) {
			const f = resolveFnMember(m, scope);
			if (f)
				return f;
		}
	}
	return undefined;
}

// Contextual parameter typing: an unannotated arrow/function (`x => x.foo`, whether a call argument, an object-literal
// property value, or the RHS of a typed `var_decl`/`satisfies`) would otherwise type its own params as `any`. Fills
// in whichever of `params` lack their own annotation from `expected`'s matching declared param type -- mutates the
// AST node in place, so it must run before the caller's own `checkFunctionBody`/`typeOf` walks those params.
function applyContextualParams(params: JS.Param<Type>[], expected: Type | undefined, scope: Scope) {
	const sig = expected && resolveFnMember(expected, scope);
	if (sig) {
		params.forEach((p, j) => {
			if (!p.typeAnnotation && sig.params[j]?.typeAnnotation)
				p.typeAnnotation = sig.params[j].typeAnnotation;
		});
	}
}

// Whether `e` is a link in an *active* optional chain -- either `e` itself is a real `?.`/`?.[`/`?.(`
// step, or it continues one further out (`a?.b.c`: `.c` isn't itself optional, but its own object `a?.b`
// is, so real TS still short-circuits `.c` when `a` is nullish, same chain). Recurses through the
// receiver position only (`member`/`index`'s `object`, `call`'s `callee`) -- a chain can't restart once
// broken by anything else (a binary op, a parenthesized sub-expression losing its own `optional` marker,
// etc), matching real TS's own "optional chaining is contiguous" rule.
// Exported: `towasm.ts`'s own codegen needs the exact same "is this link part of a live chain" test (its
// own equivalent of the checker's `T.nonNullable`-before-lookup use here) -- one shared implementation,
// not two that could silently drift apart on what counts as "still the same chain".
export function isOptionalChainLink(e: Expr): boolean {
	if (e.type === 'member' || e.type === 'index')
		return !!e.optional || isOptionalChainLink(e.object);
	if (e.type === 'call')
		return !!e.optional || isOptionalChainLink(e.callee);
	return false;
}

// Conservative "this statement never falls through" -- powers guard-clause narrowing
function alwaysExits(stmt: JS.Statement<any>): boolean {
	switch (stmt.type) {
		case 'return':
		case 'throw':
		case 'continue':
		case 'break':
			return true;
		case 'block':
			return stmt.body.length > 0 && alwaysExits(stmt.body[stmt.body.length - 1]);
		case 'if':
			return !!stmt.alternate && alwaysExits(stmt.consequent) && alwaysExits(stmt.alternate);
		default:
			return false;
	}
}

// ===================================================================
//  TStypeCheck -- structural type checking of a parsed TS AST
// ===================================================================
// Deliberately partial -- every gap errs lenient (no diagnostic, often surfaced instead as a `SEVERITY.GAP`) rather than risking a false positive.
// Known gaps: 
//  - generic inference is structural-argument-matching only (no bidirectional/contravariant/contextual)
//  - narrowing covers identifiers/dotted paths only (no CFG/reassignment invalidation)
//  - overload resolution needs exactly one arity+type fit (no best-guess)
//  - keyof/mapped/indexed-access resolve only for literal keys
//  - conditional types resolve only when non-distributive and concrete (no `infer`)


const COMPARISON_OPS 	= new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>=', 'in', 'instanceof']);
const LOGICAL_OPS		= new Set(['&&', '||', '??']);
const SINGLE_ELEMENT_ITERABLES = new Set(['Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Generator', 'Iterable', 'IterableIterator', 'Iterator']);

const TYPED_ARRAY_RANGES: Record<string, T.NumRange> = {
	Int8Array:			{ base: 'number', min: -0x80, 					max: 0x7f, 					integer: true },
	Uint8Array:			{ base: 'number', min: 0, 						max: 0xff, 					integer: true },
	Uint8ClampedArray:	{ base: 'number', min: 0, 						max: 0xff, 					integer: true },
	Int16Array:			{ base: 'number', min: -0x8000, 				max: 0x7fff, 				integer: true },
	Uint16Array:		{ base: 'number', min: 0, 						max: 0xffff, 				integer: true },
	Int32Array:			{ base: 'number', min: -0x80000000, 			max: 0xffffffff, 			integer: true },
	Uint32Array:		{ base: 'number', min: 0, 						max: 0xffffffff, 			integer: true },
	Float32Array:		{ base: 'number', min: 0, 						max: 0xff, 					integer: false },
	Float64Array:		{ base: 'number', min: 0, 						max: 0xff, 					integer: false },
	BigInt64Array:		{ base: 'bigint', min: -0x8000000000000000n, 	max: 0x7fffffffffffffffn, 	integer: true },
	BigUint64Array:		{ base: 'bigint', min: 0n, 						max: 0xffffffffffffffffn, 	integer: true },
};

export const SEVERITY = {
	GAP:		0,	// known missing functionality (see the header's own gap list) -- not a judgment call, just a reminder
	WARNING:	1,
	ERROR:		2,
} as const;
export type SEVERITY = (typeof SEVERITY)[keyof typeof SEVERITY];

type Diagnostics = (severity: SEVERITY, pos: JS.Location, strings: TemplateStringsArray, ...values: any[])=>void;


function narrowMath(func: string, params: TS.Param[]): Type | undefined {
	switch (func) {
		case 'random':
			return T.rangeToType({ base: 'number', min: 0, max: 1, integer: false });
		case 'max': {
			const all = params.map(p => T.toRange(p?.typeAnnotation));
			return all.every(i => !!i) ? T.rangeToType(T.rangeMax(all)) : undefined;
		}
		case 'min': {
			const all = params.map(p => T.toRange(p?.typeAnnotation));
			return all.every(i => !!i) ? T.rangeToType(T.rangeMin(all)) : undefined;
		}
	}

	const mr = T.toRange(params[0]?.typeAnnotation);
	if (mr) {
		switch (func) {
			case 'abs':
			case 'sqrt':	//> 0
			case 'exp':		return T.rangeToType({ ...mr, min: 0 });

			case 'ceil':
			case 'floor':
			case 'round':	return T.rangeToType({ ...mr, integer: true });

			case 'acos':	return T.rangeToType({ ...mr, min: 0, max: Math.PI });
			case 'asin':
			case 'atan':	return T.rangeToType({ ...mr, min: -Math.PI / 2, max: Math.PI / 2 });
			case 'atan2':	return T.rangeToType({ ...mr, min: -Math.PI, max: Math.PI });

			case 'cos':
			case 'sin':		return T.rangeToType({ ...mr, min: -1, max: 1 });

	//		case 'pow':
	//		case 'tan':
		}
	}
}

// `instance` is `new C(...)`/`this`'s type; `value` is the class binding's type (construct sig ∩ static members).
// `scope`: the class's declaring scope, stamped onto every result `ref` so a member resolved elsewhere still uses it.
// Field-init inference below always calls `typeOf` muted (no `err`) -- checker.ts's only caller of this (`hoist`, `checkStmt`'s
// `class_decl`, `typeOf`'s own `'class'` case) all want that, matching old code's `runMuted` wrap around every one of them.
function classShapes(c: TS.Class, scope: Scope): { instance: Type; value: Type } {
	const members:			TS.TypeMember[] = [];
	const staticMembers:	TS.TypeMember[] = [];
	const ctorMembers:		TS.ClassMethod[] = [];
	// Fields needing lazy inference (below) get their getter installed only *after* this function's own `stampScope`
	// call at the bottom -- that call already walks every member's `typeAnnotation` once, and installing the getter
	// before it would make *that* walk the "first read", forcing inference right here (still mid-`hoist`, before
	// later-in-file declarations like `__asm` are hoisted) instead of at whatever later, real, post-hoist read asks.
	const pendingFieldInit: { prop: TS.TypeMember; init: Expr }[] = [];

	for (const m of c.body) {
		if (m.type === 'index_signature') {
			members.push(TS.TypeIndex(m.paramName, m.paramType, m.typeAnnotation));
			continue;
		}
		if (!('key' in m) || typeof m.key !== 'string')
			continue;

		const list = hasMod(m, 'static') ? staticMembers : members;
		switch (m.type) {
			case 'field': {
				// No annotation falls back to inferring the initializer's own *widened* type, matching real TS' own field-inference.
				// Anything else (a call, `new`, ...) is queued into `pendingFieldInit`, resolved once the whole shape (and `hoist`'s later declarations
				const lit = m.typeAnnotation ? undefined : T.literalTypeOf(m.value);
				if (m.typeAnnotation || lit || !m.value) {
					list.push(TS.TypeProperty(m.key, (m.typeAnnotation as Type) ?? (lit && T.widenLiterals(lit)) ?? T.ANY, m.modifiers));
				} else {
					const prop = TS.TypeProperty(m.key, T.ANY, m.modifiers);
					pendingFieldInit.push({ prop, init: m.value });
					list.push(prop);
				}
				break;
			}
			case 'method':
				if (m.key === 'constructor') {
					ctorMembers.push(m);
					// A parameter-property modifier is anything but the unrelated `'optional'` tag.
					for (const p of m.params)
						if (p.modifiers?.some(x => x !== 'optional') && typeof p.key === 'string')
							members.push(TS.TypeProperty(p.key, p.typeAnnotation ?? T.literalTypeOf(p.default) ?? T.ANY, m.modifiers));
				} else {
					list.push(TS.TypeMethod(m.key, T.withScope(T.FixSig(m, T.ANY), scope), m.modifiers));
				}
				break;
			case 'get':
				list.push(TS.TypeProperty(m.key, m.returnType ?? T.ANY));
				break;
			case 'set':
				if (!list.some(x => x.type === 'property' && x.key === m.key))
					list.push(TS.TypeProperty(m.key, m.params[0]?.typeAnnotation ?? T.ANY));
				break;
		}
	}
	const obj = TS.ObjectType(members);
	// a base the checker can't model (mixin call, namespace member, imported class) leaves the instance unsealed; likewise an inherited constructor accepts any arguments.
	// Own members come first: lookupMember's first match implements override precedence
	const superType: Type | undefined =
			c.superClass?.type === 'identifier' ? TS.RefType(c.superClass.name)
		:	c.superClass?.type === 'instantiation' && c.superClass.expression.type === 'identifier' ? TS.RefType(c.superClass.expression.name, c.superClass.typeArgs as Type[])
		:	c.superClass ? T.ANY : undefined;
	const instance = superType ? TS.IntersectionType([obj, superType]) : obj;
	// The named ref carries its own type params back as its own typeArgs (`Box<T>` -> `new(...): Box<T>`) -- without this,
	// a bare `RefType(c.name)` never mentions `T`, so `new Box<number>(...)` produced a `Box` with no type args at all.
	const ctorReturn = c.name ? TS.RefType(c.name, c.typeParams?.map(p => TS.RefType(p.name))) : instance;
	const makeCtorSig = (params: TS.Params) => T.withScope(TS.CallSig(params, ctorReturn, c.typeParams), scope);
	// >1 real constructor body: a genuine overload set, same multi-signature shape `lookupMember` builds
	// for same-named methods and `hoist` builds for free-function overloads -- `case 'new'`'s existing
	// arity+type-fit resolution (via `T.collectMembers`'s `'construct'`-member filter) already handles it.
	const ctor: Type = ctorMembers.length > 1
		? TS.ObjectType(ctorMembers.map(m => TS.TypeConstruct(makeCtorSig(T.FixParams(m)))))
		: { type: 'constructor', ...makeCtorSig(ctorMembers.length ? T.FixParams(ctorMembers[0]) : {params: [], rest: c.superClass ? JS.Rest('args', TS.ArrayType(T.ANY)) : undefined}) };
	const value = staticMembers.length ? TS.IntersectionType([ctor, TS.ObjectType(staticMembers)]) : ctor;
	T.stampScope(instance, scope);
	T.stampScope(value, scope);

	// Installed only now, *after* the walks above -- a self-memoizing lazy getter
	for (const { prop, init } of pendingFieldInit) {
		let resolving = false;
		Object.defineProperty(prop, 'typeAnnotation', {
			configurable: true,
			enumerable: true,
			get(): Type {
				if (resolving)
					return T.ANY;
				resolving = true;
				const t = T.stampScope(T.widenLiterals(typeOf(init, scope) ?? T.ANY), scope);
				Object.defineProperty(prop, 'typeAnnotation', { value: t, writable: true, enumerable: true, configurable: true });
				return t;
			},
		});
	}
	return { instance, value };
}

// ---- checker -----------------------------------------------------------------


export function makeErr(diag: Diagnostics) {
	return (sev: SEVERITY, pos: JS.Location) => (strings: TemplateStringsArray, ...values: any[]) => {
		diag(sev, pos, strings, ...values);
	};
}
type Err = ReturnType<typeof makeErr>;

// ---- control-flow narrowing -----------------------------------------------------------------


// Refines `name`'s binding to the members `keep` accepts (`name` may be a dotted path key). `keep` returns `true` (keep),
// `false` (exclude), or a `Type` (replace with a narrower version) -- the last splits a compound member (see `narrowByDiscriminant`).
function narrowValue(scope: Scope, name: string, keep: (m: Type) => boolean | Type, t = scope.value(name)): Scope {
	const r = t && T.resolveOwn(t, scope);
	if (!r || T.isAny(r))
		return scope;
	if (r.type !== 'union') {
		const k = keep(r);
		if (k !== true) {
			const s = new Scope(scope);
			s.addNarrowing(name, k === false ? TS.RefType('never') : k);
			return s;
		}
		return scope;
	}
	// A union member may resolve to a further nested union -- flatten before filtering, so a discriminant matching only part
	// of a compound member filters at the right granularity. Each candidate keeps its own *original* (unresolved) form
	// alongside the resolved one used only to evaluate `keep` -- a member kept as-is (`k === true`) is pushed by its
	// original ref, not the fully-expanded structural shape, so e.g. a generic `PolynomialN<number>` union member survives
	// narrowing as that clean ref instead of losing the identity later generic inference (`complexBound<T>`) needs.
	const candidates = r.types.flatMap(m => {
		const resolved = T.resolveOwn(m, scope);
		return resolved.type === 'union' ? resolved.types.map(rt => ({ resolved: rt, orig: rt })) : [{ resolved, orig: m }];
	});
	const parts: Type[] = [];
	let changed = false;
	for (const { resolved, orig } of candidates) {
		const k = keep(resolved);
		if (k !== false)
			parts.push(k === true ? orig : k);
		if (k !== true)
			changed = true;
	}
	if (changed) {
		// `parts.length === 0`: every member excluded -- narrows to `never`, needed so disjunctive `||`/`&&` narrowing can tell
		// "excludes everything" apart from "didn't narrow at all". A returned `Type` replaces a member with a narrower version.
		const s = new Scope(scope);
		s.addNarrowing(name, parts.length ? T.combineTypes(parts) : TS.RefType('never'));
		return s;
	}
	return scope;
}

// Narrows `m` by a discriminant-property equality test, recursing into `m`'s structure to split a compound member down
// to its matching sub-variant(s) rather than keep/discard it whole. Return contract matches `narrowValue`'s `keep`.
function narrowByDiscriminant(m: Type, prop: string, scope: Scope, keepMatch: boolean, target: unknown, depth = 6): boolean | Type {
	if (depth < 0) {
		T.hitDepthLimit('narrowByDiscriminant');
		return true;	// can't determine within budget: lenient, same as an unresolvable discriminant below
	}
	const r = T.resolveOwn(m, scope);
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
		return !changed ? true : parts.length ? T.combineTypes(parts) : false;
	}
	const pt = T.lookupMember(r, prop, scope);
	const rp = pt && T.resolve(scope, pt);
	if (!rp)
		return true;	// unresolvable discriminant: lenient, matching `lookupMember`'s/`resolve`'s own established leniency
	if (rp.type === 'literal')
		return (rp.value === target) === keepMatch;
	// The discriminant property is itself a union of literals declared directly on one interface (not a nested alias) --
	// `r` isn't a union to split, so only whether the whole of it can be excluded/kept without ambiguity.
	return rp.type !== 'union' || !rp.types.every(x => x.type === 'literal')
		|| (keepMatch ? rp.types.some(x => x.value === target) : rp.types.some(x => x.value !== target));
}

// Narrows `name` to `target`: union members are filtered by assignability; a non-union binding (or any binding, for an opaque `any` target)
// is replaced outright when the guard holds. `name` may be a dotted path key.
function narrowTo(scope: Scope, name: string, target: Type, sense: boolean, t = scope.value(name)): Scope {
	const r = t && T.resolveOwn(t, scope);
	if (!r || T.isAny(r))
		return scope;
	if (r.type === 'union' && !T.isAny(target))
		return narrowValue(scope, name, m => T.isAssignable(m, target, scope) === sense, t);
	if (!sense)
		return scope;
	const s = new Scope(scope);
	s.addNarrowing(name, target);
	return s;
}

// Returns a scope refined by `test` holding (sense=true) or failing (sense=false). Covers truthiness, `!`, `&&`/`||`, typeof, null/undefined
// comparisons, discriminant-property comparisons, instanceof, `in`, and user-defined type predicates.
function narrow(test: Expr, scope: Scope, sense: boolean): Scope {
	const aliasing = new Set<string>();
	const recurse = (test: Expr, scope: Scope, sense: boolean): Scope => {
		const truthy: (m: Type) => boolean = sense ? m => !T.isFalsy(m, scope) : m => !T.isTruthy(m, scope);
		const narrowKey = (target: Expr, keep: (m: Type) => boolean | Type) => {
			const key = T.pathKey(target);
			return key ? narrowValue(scope, key, keep, scope.value(key) ?? typeOf(target, scope)) : undefined;
		};

		switch (test.type) {
			case 'unary':
				return test.operator === '!' ? recurse(test.operand, scope, !sense) : scope;
			case 'unary_post'://only for '!'?
				return recurse(test.operand, scope, sense);
			case 'identifier': {
				const s		= narrowValue(scope, test.name, truthy);
				const alias = aliasing.has(test.name) ? undefined : scope.alias(test.name);
				if (!alias)
					return s;
				aliasing.add(test.name);
				try {
					return recurse(alias, s, sense);
				} finally {
					aliasing.delete(test.name);
				}
			}
			// Truthiness-narrows a dotted property path (`if (icon.color)`), keyed by the whole path -- no alias-following, since `scope.alias`
			// only tracks plain-identifier `const` initializers, not member chains.
			case 'member': {
				// `x?.y` truthy also implies `x` itself is non-nullish -- a nullish `x` would make the whole optional-chain
				// expression evaluate to `undefined`, which is falsy. Only sound for the truthy branch: `!x?.y` doesn't pin `x`
				// down at all (it could be nullish, or defined with a falsy `y`). Narrowed first so the composite-path
				// narrowing below builds on top of it, rather than the two ending up as unrelated sibling scopes.
				const base = test.optional && sense ? narrowKey(test.object, m => !T.isNullish(m, scope)) : undefined;
				const key	= T.pathKey(test);
				return (key ? narrowValue(base ?? scope, key, truthy, scope.value(key) ?? typeOf(test, scope)) : base) ?? scope;
			}
			case 'binary': {
				// `if ((x = e))` narrows x by truthiness
				if (test.operator === '=' && test.left.type === 'identifier')
					return narrowValue(scope, test.left.name, truthy);

				// `a && b`'s true branch / `a || b`'s false branch: both conjuncts hold (or both fail),
				// so each narrowing applies on top of the other -- sequential/conjunctive narrowing.
				if ((test.operator === '&&' && sense) || (test.operator === '||' && !sense))
					return recurse(test.right, recurse(test.left, scope, sense), sense);
				// `a || b`'s true branch: only *one* disjunct is known to hold, but a variable BOTH sides narrow (`typeof icon === 'string' ||
				// icon instanceof Uri`) can be narrowed to the union of what each side alone would narrow it to (disjunctive/union narrowing).
				if ((test.operator === '||' && sense) || (test.operator === '&&' && !sense)) {
					const left = recurse(test.left, scope, sense), right = recurse(test.right, scope, sense);
					// Bail only when *neither* side narrows -- `left === scope` alone is ambiguous between "this disjunct is
					// vacuously true" and "this disjunct is unreachable", which `narrowValue`'s never-narrowing now distinguishes.
					if (left === scope && right === scope)
						return scope;
					const names = left.narrowedNames(scope);
					for (const name of right.narrowedNames(scope))
						names.add(name);
					let s = scope;
					for (const name of names) {
						const lt = left.value(name), rt = right.value(name);
						if (lt && rt) {
							s = new Scope(s);
							s.addNarrowing(name, T.combineTypes([lt, rt]));
						}
					}
					return s;
				}
				const eq = test.operator === '===' || test.operator === '==';
				if (eq || test.operator === '!==' || test.operator === '!=') {
					const keepMatch	= eq === sense;		// keep the members that match the compared value
					const loose		= test.operator === '==' || test.operator === '!=';
					for (const [l, r] of [[test.left, test.right], [test.right, test.left]] as const) {
						// typeof x === 'kind' (x may be a dotted path, e.g. `typeof options.layer === 'number'`)
						if (l.type === 'unary' && l.operator === 'typeof' && T.isLiteral(r, 'string')) {
							const kind = r.value;
							const s = narrowKey(l.operand, m => {
								const n = T.typeofName(m);
								return n === undefined || (n === kind) === keepMatch;
							});
							if (s)
								return s;
						}
						// x === null / undefined  (loose == matches both) -- `pathKey`, not just a bare identifier: `l` may be a
						// dotted path (`v.offset !== undefined`), same generalization the discriminant branch below already needs.
						if (T.isLiteral(r, 'null') || r.type === 'identifier' && r.name === 'undefined') {
							const matches: (m: Type) => boolean
								= loose					? m => T.isNullish(m, scope)
								: r.type === 'literal'	? m => T.isLiteral(m, 'null')
								: m => m.type === 'ref' && (m.name === 'undefined' || m.name === 'void');
							const s = narrowKey(l, m => matches(m) === keepMatch);
							if (s)
								return s;
						}
						// x === literal: literal members must match; non-literal members might
						if (l.type === 'identifier' && r.type === 'literal' && r.value !== null)
							return narrowValue(scope, l.name, m => {
								if (m.type === 'literal')
									return (m.value === r.value) === keepMatch;
								// `boolean` has exactly two inhabitants -- real TS narrows it as `true | false`, so `x === false`
								// narrows the other branch down to literal `true` instead of leaving `boolean` unsplit.
								if (m.type === 'ref' && m.name === 'boolean' && typeof r.value === 'boolean')
									return Literal(keepMatch ? r.value : !r.value);
								// A plain (or already range-narrowed) number/bigint pins down to exactly `r.value` on the matching
								// branch -- intersected with whatever's already known, so an equality that contradicts an
								// earlier bound (`x > 10` then `x === 3`) correctly narrows to `never`, not just `3`.
								// The excluding branch can only special-case "was already pinned to this exact value".
								if (typeof r.value === 'number' || typeof r.value === 'bigint') {
									const mr = T.toRange(m);
									if (mr && mr.base === typeof r.value) {
										if (keepMatch) {
											const merged = T.rangeIntersect(mr, { base: mr.base, min: r.value, max: r.value, integer: typeof r.value === 'bigint' || Number.isInteger(r.value) });
											return merged ? T.rangeToType(merged) : false;
										}
										return mr.min !== undefined && mr.min === mr.max && mr.min === r.value ? false : true;
									}
								}
								return true;
							});
						// x.prop === literal (discriminated union): `narrowByDiscriminant` splits a compound member to its matching
						// sub-variant(s) instead of keeping/discarding it whole; `l.object` may itself be a dotted path.
						if (l.type === 'member' && r.type === 'literal') {
							const s = narrowKey(l.object, m => narrowByDiscriminant(m, l.property, scope, keepMatch, r.value));
							if (s)
								return s;
						}
					}

				} else if (test.operator === '<' || test.operator === '<=' || test.operator === '>' || test.operator === '>=') {
					// Normalize to "A cmp B" with cmp always '<'/'<=' by swapping operands for '>'/'>='. Which side then
					// gets the upper vs. lower bound depends only on `sense` (the false branch asserts the logical
					// negation -- same direction, flipped strictness: `!(A<B)` is `A>=B`), so `upperOnA = sense`;
					// whether that bound is inclusive or exclusive depends on the operator and `sense` together.
					const swap			= test.operator === '>' || test.operator === '>=';
					const A				= swap ? test.right : test.left;
					const B				= swap ? test.left : test.right;
					const strict		= (swap ? test.operator === '>' : test.operator === '<') === sense;
					const upperOnA		= sense;

					const applyBound = (base: Scope, target: Expr, other: T.NumRange | undefined, isUpper: boolean): Scope => {
						const key = T.pathKey(target);
						if (!key || !other)
							return base;
						const bound = isUpper ? other.max : other.min;
						if (bound === undefined)
							return base;

						return narrowValue(base, key, m => {
							const mr = T.toRange(m);
							if (!mr || mr.base !== other.base)
								return true;
							const merged = T.rangeClamp(mr, bound, isUpper, strict);
							return !merged ? false : T.rangeToType(merged);
						}, base.value(key) ?? typeOf(target, base));
					};

					return applyBound(
						applyBound(scope, A, T.toRange(T.resolveOwn(typeOf(B, scope), scope)), upperOnA),
						B, T.toRange(T.resolveOwn(typeOf(A, scope), scope)), !upperOnA
					);

				} else if (test.operator === 'instanceof') {
					const key = T.pathKey(test.left);
					if (key) {
						const cur = scope.value(key) ?? typeOf(test.left, scope);
						return test.right.type === 'identifier' && scope.type(test.right.name)
							? narrowTo(scope, key, TS.RefType(test.right.name), sense, cur)
							// unknown class: trust the guard, stop tracking the binding
							: sense ? narrowTo(scope, key, T.ANY, sense, cur) : scope;
					}

				} else if (test.operator === 'in' && T.isLiteral(test.left, 'string') && test.right.type === 'identifier') {
					const prop = test.left.value, key = test.right.name;
					const t = scope.value(key);
					const r = t && T.resolveOwn(t, scope);
					// tsc's "unlisted property narrowing": `in` on a sealed object type that doesn't declare `prop` still narrows -- the truthy
					// branch gets `prop` synthesized as `unknown` rather than erroring, e.g. `if ('length' in a) a.length`.
					if (sense && r && T.sealed(r, scope) && !T.lookupMember(r, prop, scope)) {
						const s = new Scope(scope);
						s.addNarrowing(key, TS.IntersectionType([r, TS.ObjectType([TS.TypeProperty(prop, T.UNKNOWN)])]));
						return s;
					}
					return narrowValue(scope, key, m => !T.sealed(m, scope) || !!T.lookupMember(m, prop, scope) === sense, t);
				}
				return scope;
			}
			case 'call': {
				// `Number.isInteger(x)`/`Number.isSafeInteger(x)`: not a real type-guard signature this checker models,
				// but common enough (and valuable enough for range narrowing) to special-case directly, before the
				// generic "unknown callee" fallback below would otherwise widen `x` to `any` on the mere possibility
				// that some arbitrary opaque callee might be a guard.
				if (test.callee.type === 'member' && test.callee.object.type === 'identifier' && test.callee.object.name === 'Number'
					&& (test.callee.property === 'isInteger' || test.callee.property === 'isSafeInteger') && test.arguments.length === 1
				) {
					const key = T.pathKey(test.arguments[0]);
					if (key) {
						return narrowValue(scope, key, m => {
							const mr = T.toRange(m);
							if (!mr || mr.base !== 'number')
								return true;
							// The false branch can only exclude "known-integer" -- a non-integer range still might
							// contain integers, so it's left unnarrowed rather than guessed at.
							return sense ? T.rangeToType({ ...mr, integer: true }) : mr.integer ? false : true;
						}, scope.value(key) ?? typeOf(test.arguments[0], scope));
					}
				}
				// user-defined type guards: `f(x)` with `x is T` narrows x; `o.m()` with `this is T` narrows o
				const calleeT = T.resolve(scope, typeOf(test.callee, scope));
				if (T.isAny(calleeT)) {
					// unknown callee (usually an imported helper) could be a type guard: stop tracking the bindings it was given
					let s = scope;
					for (const a of test.arguments) {
						if (a.type === 'identifier' && s.value(a.name)) {
							s = new Scope(s);
							s.addNarrowing(a.name, T.ANY);
						}
					}
					return s;
				}
				// An overloaded type guard (a user interface declaring `is<U extends C>(...): this is X<U>` for more than one
				// constraint) resolves to an `object` with several `call` members, not a bare `function` -- and when the
				// receiver (`poly` in `poly.is(...)`) is itself still a union, `lookupMember`'s own union case combines each
				// branch's own overload set into a union of such objects. Deliberately asymmetric with the object fallback
				// below (which alone is predicate-filtered): a bare `function` match wins unconditionally, matching the
				// pre-existing, already-verified-safe behavior for the common (non-overloaded) case.
				const parts = T.flattenIntersection(calleeT, scope);
				const asObjectCallSigs = (t: Type): TS.CallSig[] => {
					const r = T.resolveOwn(t, scope);
					return r.type === 'object' ? r.members.filter((m): m is Extract<TS.TypeMember, { type: 'call' }> => m.type === 'call') : [];
				};
				const sig = parts.find((p): p is Extract<Type, { type: 'function' }> => p.type === 'function')
					?? parts.flatMap(p => p.type === 'union' ? p.types.flatMap(asObjectCallSigs) : asObjectCallSigs(p))
						.find(m => m.returnType?.type === 'predicate' && (m.rest || m.params.length === test.arguments.length));
				const ret = sig?.returnType;
				if (ret && ret.type === 'predicate' && ret.assertedType && !ret.asserts) {
					const arg = ret.paramName === 'this'
						? (test.callee.type === 'member' ? test.callee.object : undefined)
						: test.arguments[sig.params.findIndex(p => p.key === ret.paramName)];
					const key = arg && T.pathKey(arg);
					if (key) {
						let target = ret.assertedType;
						if (sig.typeParams?.length) {
							const map	= new Map<string, Type>();
							const names = new Map(sig.typeParams.map(p => [p.name, p] as const));
							test.arguments.forEach((a, i) => {
								const p = sig.params[i];
								if (a.type !== 'spread' && p?.typeAnnotation)
									T.inferTypeArgs(p.typeAnnotation, typeOf(a, scope), names, map, scope);
							});
							// An uninferred type param must not leave a dangling `{type:'ref', name:'T'}` in `target`, or every other assignability
							// check (which treats an unresolvable ref as "unrelated") would silently narrow the guard to nothing at all.
							sig.typeParams.forEach(p => { if (!map.has(p.name)) map.set(p.name, p.constraint ?? p.default ?? T.ANY); });
							target = T.substituteType(target, map);
						}
						return narrowTo(scope, key, target, sense, scope.value(key) ?? typeOf(arg, scope));
					}
				}
				return scope;
			}
			default:
				return scope;
		}
	};
	// `narrow` never reports diagnostics -- it re-walks (sub)expressions `typeOf` already checked in the normal pass,
	// purely to compute narrowed scopes; muted once here rather than at each internal `typeOf`-reaching branch.
	return recurse(test, scope, sense);
}

// TS 5.5+ "inferred type predicates": a function whose single return path is itself a type guard (`x => x != null`) gets an inferred `x is T`
// return, by asking `narrow()` what it'd do with that expression. Only an expression body or single-`return` block is supported.
function inferredPredicate(fn: TS.CallSig, body: JS.Statement<any>[] | Expr, scope: Scope): Type | undefined {
	const p = fn.params[0];
	if (!p || typeof p.key !== 'string')
		return undefined;
	const test = !Array.isArray(body) ? body
		: body.length === 1 && body[0].type === 'return' ? body[0].argument
		: undefined;
	if (!test)
		return undefined;
	const paramT = (p.typeAnnotation as Type | undefined) ?? T.ANY;
	const inner = new Scope(scope);
	inner.addValue(p.key, paramT);
	const narrowed = narrow(test, inner, true).value(p.key);
	return narrowed && narrowed !== paramT ? TS.Predicate(p.key, narrowed) : undefined;
}


// Tries `T.isAssignable` strict then lax; a GAP means strict failed only due to an opaque type (keyof/conditional/infer/mapped).
// Every real assignability check should go through this, not `T.isAssignable` directly. `dstScope` resolves `dst`'s own structure.
function checkAssignable(src: Type, dst: Type, scope: Scope, pos: JS.Location, dstScope: Scope, err: Err): boolean {
	if (T.isAssignable(src, dst, scope, dstScope, true))
		return true;
	const lax = T.isAssignable(src, dst, scope, dstScope, false);
	if (lax)
		err(SEVERITY.GAP, pos)`Assignability of '${src}' to '${dst}' could not be fully verified ('keyof'/conditional/'infer'/mapped types aren't evaluated)`;
	return lax;
};

// A fresh object literal assigned to a fully-known object type may not introduce unknown keys
function checkExcessProps(lit: Expr, target: Type, scope: Scope, pos: JS.Location, targetScope: Scope, err: Err) {
	if (lit.type !== 'object')
		return;
	const r = T.resolveOwn(target, targetScope);
	const targets = (r.type === 'intersection' ? r.types.map(t => T.resolveOwn(t, targetScope)) : [r])
		.filter(t => t.type === 'object');
	if (targets.length !== (r.type === 'intersection' ? r.types.length : 1) || targets.some(t => t.members.some(m => m.type === 'index')))
		return;		// partially-unknown target or index signature: anything goes
	if (lit.properties.some(p => p.type === 'spread' || typeof p.key !== 'string'))
		return;		// spread/computed keys: shape is open
	for (const p of lit.properties)
		if (p.type !== 'spread' && typeof p.key === 'string' && !targets.some(t => t.members.some(m => (m.type === 'property' || m.type === 'method') && m.key === p.key)))
			err(SEVERITY.ERROR, pos)` Object literal may only specify known properties, and '${p.key}' does not exist in type '${target}'`;
}

// ---- declaration hoisting / namespace resolution ------------------------------------------

function hoist(stmts: TS.Statement[], scope: Scope) {
	const fnGroups = new Map<string, JS.FunctionDecl<any>[]>();

	// `interface`/`type` declarations get their own pass first: a `declare var X: Y` resolves `Y` eagerly below, so every
	// cross-file augmentation of `Y` (lib.d.ts splits interfaces across multiple files) must already be merged by then.
	for (let stmt of stmts) {
		if (stmt.type === 'export_decl')
			stmt = stmt.declaration;
		if (stmt.type === 'type_alias_decl') {
			scope.addType(stmt.name, T.stampScope(stmt.value, scope), stmt.typeParams);
		} else if (stmt.type === 'interface_decl') {
			const obj = T.stampScope(TS.ObjectType(stmt.body), scope);
			// own members first: lookupMember's first match implements override precedence
			scope.mergeType(stmt.name, stmt.extendsClause?.length ? TS.IntersectionType([obj, ...stmt.extendsClause.map(e => T.stampScope(e, scope))]) : obj, stmt.typeParams);
		}
	}
	for (let stmt of stmts) {
		if (stmt.type === 'export_decl')
			stmt = stmt.declaration;
		switch (stmt.type) {
			case 'function_decl':
				fnGroups.set(stmt.name, [...(fnGroups.get(stmt.name) ?? []), stmt]);
				break;
			case 'class_decl': {
				// `stmt` reassigned twice above (unwrap `while`, then a guard `if`) -- beyond this checker's own narrowing, so the cast below is a real gap, not a type error.
				const { instance, value } = classShapes(stmt as TS.Class, scope);
				scope.mergeType(stmt.name, instance, stmt.typeParams as TS.TypeParam[]);
				scope.addValue(stmt.name, value);
				break;
			}
			case 'enum_decl': {
				let next = 0;
				const memberTypes = stmt.members.map((m): Type => !m.init ? Literal(next++)
					: T.isLiteral(m.init, 'number') ? Literal((next = m.init.value + 1, m.init.value))
					: T.isLiteral(m.init, 'string') ? Literal(m.init.value)
					: T.NUMBER
				);
				scope.addType(stmt.name, T.combineTypes(memberTypes));
				scope.addValue(stmt.name, TS.ObjectType(stmt.members.map((m, i) => TS.TypeProperty(m.name, memberTypes[i]))));
				break;
			}
			case 'namespace_decl': {
				const { scope: ns, value } = exportScope(stmt.body, scope);
				// A type-only namespace (empty value type) merged onto a same-named const/class here would clobber that name's real value with a
				// sealed empty object before the sequential 'var_decl' walk assigns it, breaking an earlier-declared class's eager forward reference.
				if (!(value.type === 'object' && value.members.length === 0))
					scope.addValue(stmt.name, value);
				scope.addNamespace(stmt.name, ns);
				break;
			}
			case 'import':
				// `TStypeCheckAsync`'s import resolution already resolves these into `scope`'s *parent`, not `scope` itself -- this always
				// materializes an own-map entry (preferring `value()` over the `any` fallback), so a `scope`-own-map-only reader still sees it.
				if (stmt.default)
					scope.addValue(stmt.default, scope.value(stmt.default) ?? T.ANY);
				if (stmt.namespace)
					scope.addValue(stmt.namespace, scope.value(stmt.namespace) ?? T.ANY);
				stmt.specifiers?.forEach(s => scope.addValue(s.local, scope.value(s.local) ?? T.ANY));
				break;
			case 'var_decl':
				// Only a `declare const/let/var` reaches here -- a plain top-level one is deliberately *not* hoisted, since real `let`/`const`
				// observe a temporal dead zone (`checkStmt`'s sequential case catches that). An ambient declaration has no such ordering.
				if (stmt.ambient)
					stmt.declarations.forEach(d => hoistVar(scope, d, stmt.kind !== 'const'));
				break;
			//'type_alias_decl' 'interface_decl':	// handled in the pass above
		}
	}
	// several same-named declarations are overloads: the bodyless signatures are the public face,
	// exposed as an object type with one call member each; a single declaration stays a plain function
	for (const [name, decls] of fnGroups) {
		const sigs		= decls.filter(d => !d.body);
		const chosen	= sigs.length ? sigs : decls;
		if (chosen.length > 1) {
			// `declScope`/`stampSig`: each overload's own param/return types resolve in *this* module's scope, not whichever module calls it.
			scope.addValue(name, TS.ObjectType(chosen.map(d => TS.TypeCall(T.stampSig(T.withScope(T.FixSig(d, T.ANY), scope), scope)))));
		} else {
			const d = chosen[0];
			const t = TS.FunctionType(T.stampSig(T.withScope(T.FixSig(d, T.ANY), scope), scope));
			if (!d.returnType && d.body) {
				// `t.returnType` is a self-memoizing accessor: first read infers it (muted) and replaces itself with a plain value.
				// `resolving` guards a recursive read (the body calling itself) into seeing `ANY` instead of re-entering.
				let resolving = false;
				Object.defineProperty(t, 'returnType', {
					configurable: true,
					enumerable: true,
					get(): Type {
						if (resolving)
							return T.ANY;
						resolving = true;
						checkFunctionBody(t, d.body, scope, hasMod(d, 'async'));
						return t.returnType ?? T.ANY;
					},
					set(value: Type | undefined) {
						// Stamped here (rather than at the read site) so it happens exactly once, regardless of who first triggers inference.
						if (value)
							T.stampScope(value, scope);
						Object.defineProperty(t, 'returnType', { value, writable: true, configurable: true, enumerable: true });
					},
				});


			}
			scope.addValue(name, t);
		}
	}
}

function hoistVar(scope: Scope, d: JS.Var<Type>, widen: boolean, typeAnnotation = d.typeAnnotation, err?: Err) {
	if (typeof d.name === 'string') {
		// A wasm-level pseudo-type annotation (`i32`/etc, see `T.WASM_PSEUDO_TYPES`) must survive
		// resolution intact -- every real consumer (towasm.ts's `builtinTypes`) matches it *by name*,
		// ahead of ordinary alias-unwrapping; resolving it here (to `number`, its real declared alias
		// target) would bake that into `scope` permanently, losing the name for every later read of this
		// variable (found via a top-level `let heap: i32 = 0;` being silently treated as `f64`
		// throughout). Scoped to just this one call site, not `resolve` globally -- unwrapping still has
		// to happen everywhere else (e.g. so an `i32` and a `number` branch of a ternary still unify).
		const stopAtPseudoType = typeAnnotation?.type === 'ref' && !typeAnnotation.typeArgs && T.WASM_PSEUDO_TYPES.has(typeAnnotation.name);
		// A bare (no-typeArgs) ref's own `declScope` wins over the ambient `scope` here -- this bakes the result in once rather than
		// re-resolving lazily, so it must resolve in the declaring module now, before a generic ref's own type args get lost.
		scope.addValue(d.name, typeAnnotation?.type === 'ref' && !typeAnnotation.typeArgs && typeAnnotation.declScope
			? T.resolve(typeAnnotation.declScope as Scope, typeAnnotation, undefined, stopAtPseudoType)
			: typeAnnotation ? T.resolve(scope, typeAnnotation, undefined, stopAtPseudoType)
			: d.init ? typeOf(d.init, scope, widen, undefined, undefined, err) : T.ANY);
		// TS 4.4 aliased conditions: a `const`'s initializer stays true for its whole lifetime, so narrowing the const
		// also narrows through what its initializer itself would narrow (`narrow()`'s `case 'identifier'` reads this).
		if (!widen && d.init)
			scope.addAlias(d);
	} else {
		T.bindingNames(d.name).forEach(n => scope.addValue(n, T.ANY));
	}
}

// Resolves what a `namespace X { ... }` block or module body exposes, as a genuine `Scope` (not a flattened `Type`) since `NS.Foo` can appear
// in a type position too. `isAlias` marks `export = X` (`.d.ts`-only), where the whole namespace collapses to `X`'s own value.
export function exportScope(body: TS.Statement[], parent: Scope): { scope: Scope; value: Type; isAlias: boolean } {
	// `hoist` + `hoistVars` (not full `checkBlock`): only top-level declaration *types* are needed, not a full check of a body checked separately.
	const inner = new Scope(parent);
	hoist(body, inner);

	// Infers top-level `var`/`const`/`let` types only -- muted, since this just resolves what a module *exposes*; its own real (unmuted)
	// check happens when it's the direct entry point. Without muting, every importer would re-diagnose the same exports from scratch (no cross-run cache).
	for (let stmt of body) {
		if (stmt.type === 'export_decl')
			stmt = stmt.declaration;
		if (stmt.type === 'var_decl')
			stmt.declarations.forEach(d => hoistVar(inner, d, stmt.kind !== 'const'));
	}

	const assign = body.find(s => s.type === 'export_assignment');
	if (assign) {
		return {
			scope: inner.namespace(assign.expr) ?? new Scope(),
			value: inner.value(assign.expr) ?? T.ANY,
			isAlias: true,
		};
	}

	const scope = new Scope();
	// Parent-chain-aware (`inner.value`, not `inner.values.get`): an imported name may have resolved straight into `inner`'s parent
	// rather than `inner` itself (`hoist`'s `case 'import'` fallback only fires when nothing already resolved it), so an own-map-only read would miss it.

	if (body.some(s => s.type === 'export_decl' || s.type === 'export')) {
		for (const stmt of body) {
			if (stmt.type === 'export_decl') {
				const decl = stmt.declaration;
				if (decl.type === 'var_decl') {
					for (const d of decl.declarations) {
						if (typeof d.name === 'string')
							scope.copy(inner, d.name, d.name);
					}
				} else if ('name' in decl) {
					scope.copy(inner, decl.name, decl.name);
				}
			} else if (stmt.type === 'export' && !stmt.source && stmt.specifiers) {
				for (const spec of stmt.specifiers)
					scope.copy(inner, spec.local, spec.exported);
				
			} else if (stmt.type === 'export' && stmt.default) {
				const d = stmt.default;
				// A declaration default export is already hoisted under its own name -- just alias 'default' to it.
				if (isTsDeclaration(d)) {
					if ('name' in d)
						scope.copy(inner, d.name, 'default');
				} else if (d.type === 'identifier') {
					// `export default someIdentifier` may carry a same-named type too (`export type rational = ...; export default rational;`)
					// -- `scope.copy` picks up type/namespace alongside the value, unlike a value-only `addValue`.
					scope.copy(inner, d.name, 'default');
				} else {
					// Any other expression default (`export default foo() + 1`, `export default {...}`) is never
					// hoisted under a name of its own, so resolve it directly here instead -- no type to carry over.
					const v = typeOf(d, inner);
					if (v)
						scope.addValue('default', v);
				}
			}
		}
	} else {
		// Ambient `.d.ts` convention: a body with no `export` keyword anywhere implicitly exports every top-level declaration.
		scope.copyAll(inner);
	}
	return { scope, value: scope.toObject(), isAlias: false };
}

// ---- lazy return-type inference -------------------------------------------------------------

// Instantiates `sig` against `argTs`, substituting type params through params/return type. Pure -- doesn't validate (see `argsFit`).
// `restElementTs`: a spread argument's element type(s), since `argTs` leaves a spread position `undefined` (arity unknown statically).
function instantiate(sig: TS.CallSig, argTs: (Type | undefined)[], typeArgs: Type[] | undefined, scope: Scope, pos: JS.Location, restElementTs?: Type[], expected?: Type, err?: Err): TS.CallSig {
	let returnType	= sig.returnType ?? T.ANY;
	let params		= sig.params;

	if (sig.typeParams?.length) {
		const map = new Map<string, Type>();
		if (typeArgs) {
			sig.typeParams.forEach((p, i) => map.set(p.name, typeArgs[i] ?? p.default ?? T.ANY));
		} else {
			const names		= new Map(sig.typeParams.map(p => [p.name, p] as const));
			const declScope	= T.declScopeOf(sig, scope);
			argTs.forEach((t, i) => {
				const p = params[i];
				if (t && p?.typeAnnotation)
					T.inferTypeArgs(p.typeAnnotation, t, names, map, scope, 0, declScope);
			});
			if (sig.rest?.typeAnnotation && restElementTs?.length) {
				const t		= sig.rest.typeAnnotation;
				const elem	= t.type === 'array' ? t.element : t;
				restElementTs.forEach(t => T.inferTypeArgs(elem, t, names, map, scope, 0, declScope));
			}
			// Same reasoning as the `preMap` pass above: whatever's still unbound after arguments, try the call's own contextual
			// expected type before falling back to a default/constraint/`any` guess below.
			if (expected && sig.returnType)
				T.inferTypeArgs(sig.returnType, expected, names, map, scope, 0, declScope);
			sig.typeParams.forEach(p => {
				if (!map.has(p.name)) {
					map.set(p.name, p.default ?? p.constraint ?? T.ANY);
					// A declared default is a correct, unremarkable fallback (real TS does it silently too) -- only worth flagging when
					// some supplied argument's type actually mentions `p.name` and still couldn't pin it down.
					if (err && !p.default && params.some((prm, i) => argTs[i] && prm.typeAnnotation && T.mentionsTypeParam(prm.typeAnnotation, p.name)))
						err(SEVERITY.GAP, pos)`Type parameter '${p.name}' could not be inferred from the arguments; assumed '${map.get(p.name)}'`;
				}
			});
		}
		params		= params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteType(p.typeAnnotation, map) } : p);
		returnType	= T.substituteType(returnType, map);
	}
	// `declScope` travels with the result -- e.g. into `argsFit`, which only ever sees this instantiated object, never `sig` itself.
	return { params, rest: sig.rest, returnType, declScope: sig.declScope };
}

// ---- expressions ----------------------------------------------------------------------------

// `expected`: the contextual type this expression is checked against, when known -- lets a generic call whose type params aren't
// determined by its arguments (`new Promise<T>(...)`) infer them from where the result is going, like TS's own contextual typing.
export function typeOf(e: Expr, scope: Scope, widen = true, expected?: Type, yieldCollector?: Type[], err?: Err): Type {
	// `recurse` always computes `e`'s *precise* type -- widening is never threaded through the walk, only applied once,
	// at the very bottom, to whatever this whole call ultimately produces. `expected` still defaults afresh per call
	// (matching the old code's bare `typeOf(sub, scope)` self-calls, which never forwarded the caller's own `expected`
	// into an unrelated sub-expression) -- only the single bootstrap call at the bottom passes the real one through.
	const recurse = (e: Expr, expected?: Type): Type => {
		const pos = (e as any).pos;
		switch (e.type) {
			case 'literal':
				if (Array.isArray(e.value)) {
					e.value.forEach(p => p.exp && recurse(p.exp));
					return T.STRING;
				}
				switch (typeof e.value) {
					case 'string':
					case 'boolean':	return Literal(e.value);
					case 'number':	return TS.RangeType('number', e.value, e.value, e.value === (e.value | 0));
					case 'bigint':	return TS.RangeType('bigint', e.value, e.value);
					case 'object':	return e.value === null ? Literal(e.value) : T.REGEXP;
				}
				break;

			case 'this':		return scope.value('this') ?? T.ANY;
			case 'identifier':	return scope.value(e.name) ?? T.ANY;

			case 'array': {
				const elems: Type[] = [];
				for (const el of e.elements) {
					if (el) {
						if (el.type === 'spread') {
							const t = T.resolveOwn(recurse(el.operand), scope);
							elems.push(t.type === 'array' ? t.element : T.ANY);
						} else {
							elems.push(recurse(el));
						}
					}
				}
				return TS.ArrayType(elems.length ? T.combineTypes(elems) : T.ANY);
			}
			case 'object': {
				const members: TS.TypeMember[] = [];
				// A later property overrides an earlier one with the same key -- real JS object-literal semantics,
				// and what lets a spread's own members participate (`{...X, key: override}` or `{key, ...X}`).
				const byKey = new Map<string, number>();
				const push = (m: TS.TypeMember) => {
					if ('key' in m && typeof m.key === 'string') {
						const i = byKey.get(m.key);
						if (i !== undefined) { members[i] = m; return; }
						byKey.set(m.key, members.length);
					}
					members.push(m);
				};
				for (const p of e.properties) {
					if (p.type === 'spread') {
						const t = T.resolveOwn(recurse(p.operand), scope);
						if (t.type !== 'object')
							return T.ANY;	// not a determinable object shape -- shape unknowable here, as before
						t.members.forEach(push);
						continue;
					}
					// A `satisfies`/annotated-`var_decl` `expected` type propagates member-by-member: an unannotated arrow/method
					// value (`{read: (pe, data) => ...}`) otherwise types its own params as `any`, same gap `applyContextualParams`
					// already closes for call arguments.
					const expectedMember = expected && typeof p.key === 'string' ? T.lookupMember(expected, p.key, scope) : undefined;
					switch (p.type) {
						case 'method':
							applyContextualParams(p.params, expectedMember, scope);
							checkFunctionBody(p, p.body, scope, hasMod(p, 'async'), hasMod(p, 'generator'), hasMod(p, 'generator'), err);
							if (typeof p.key === 'string')
								push(TS.TypeMethod(p.key, T.FixSig(p, T.ANY)));
							break;
						case 'get':
							checkFunctionBody(p, p.body, scope, false, false, false, err);
							push(TS.TypeProperty(p.key, p.returnType as Type ?? T.ANY));
							break;
						case 'set':
							checkFunctionBody(p, p.body, scope, false, false, false, err);
							break;
						case 'field': {
							const _t = typeOf(p.value!, scope, true, expectedMember, yieldCollector, err);
							if (typeof p.key === 'string')
								push(TS.TypeProperty(p.key, _t));
							break;
						}
					}
				}
				return TS.ObjectType(members);
			}

			case 'function':
				applyContextualParams(e.params, expected, scope);
				checkFunctionBody(e, e.body, scope, hasMod(e, 'async'), hasMod(e, 'generator'), hasMod(e, 'generator'), err);
				return TS.FunctionType(T.FixSig(e, T.ANY, e.returnType as Type | undefined));

			case 'arrow':
				applyContextualParams(e.params, expected, scope);
				checkFunctionBody(e, e.body, scope, hasMod(e, 'async'), false, false, err);
				return TS.FunctionType(T.FixSig(e, T.ANY, e.returnType as Type | undefined));

			case 'member': {
				const key		= T.pathKey(e);
				const refined	= key && scope.value(key);	// dotted keys live only in narrowings
				if (refined)
					return refined;
				const objT	= recurse(e.object);
				// `Uint8Array`/`Int32Array`/`Uint32Array`/etc are aliases to `TypedArray<T>` (`lib.d.ts`) --
				// checked here by name, on the *unresolved* `objT`, before `T.resolve` expands the alias into
				// `TypedArray<T>`'s own merged (real class + ambient interface, `lib/typedarray.ts`'s own
				// header comment) shape: `T.resolve` doesn't flatten an intersection, so a resolved check here
				// would never match at all, same reason `i32`/`u8`/etc are checked by name before resolving.
				if (objT.type === 'ref' && !objT.typeArgs && objT.name in TYPED_ARRAY_RANGES) {
					// Bounded, not bare `number` -- a loop comparing against these should stay `i32` in
					// towasm.ts rather than promoting to `f64` (see `numericPairWtype`, which requires
					// both operands already `i32`).
					if (e.property === 'length' || e.property === 'byteOffset' || e.property === 'byteLength')
						return TS.RangeType('number', 0, 0x7fffffff, true);
					if (e.property === 'buffer')
						return TS.RefType('ArrayBuffer');
				}
				// `chained`, not a bare `e.optional` -- `a?.b.c`'s `.c` isn't itself an `?.` step, but it
				// continues one (`a?.b` is), so real TS still short-circuits it when `a` is nullish. Using
				// only `e.optional` here (the original bug) left `objT` as the *full* `Inner | undefined`
				// for a chain-continuation's own lookup -- `lookupMember`'s union case requires *every*
				// member to have the property, and `undefined` never does, so it silently fell back to `any`
				// for the whole rest of the chain (see `isOptionalChainLink`'s own comment).
				const chained = isOptionalChainLink(e);
				const resolvedObjT = T.resolve(scope, chained ? T.nonNullable(objT, scope) : objT);
				if (resolvedObjT.type === 'ref' && resolvedObjT.name === 'ArrayBuffer' && e.property === 'byteLength')
					return TS.RangeType('number', 0, 0x7fffffff, true);
				// `?.` (direct or chained) only ever looks the property up on the non-nullish part of `objT`
				// -- `lookupMember`'s own union case requires *every* member to have it (a bare
				// `null`/`undefined` member never does), so an unguarded `T.lookupMember(objT, ...)` here
				// would always miss and fall back to `any` the moment `objT` includes either. A genuinely
				// non-chained access keeps the full (possibly nullish) `objT` -- real TS itself only allows
				// that when it's already known non-nullish, so leaving it as-is is what lets the
				// `sealed`/`err` check below still flag `x.y` on a possibly-null `x` (dropping nullish
				// members here unconditionally would silently accept it).
				const t		= T.lookupMember(chained ? T.nonNullable(objT, scope) : objT, e.property, scope);
				if (err && !t && !e.optional && T.sealed(objT, scope))
					err(SEVERITY.ERROR, pos)`Property '${e.property}' does not exist on type '${objT}'`;
				if (!t)
					return T.ANY;
				// `lookupMember` returns an optional property's type unwidened (callers needing "is this optional" use `memberOptional`);
				// a plain read here must still see the `| undefined` a chained (direct or continued) optional access actually allows.
				return (chained || T.memberOptional(objT, e.property, scope)) ? T.combineTypes([t, T.UNDEFINED]) : t;
			}
			case 'index': {
				const rawObjT = recurse(e.object);
				// `chained`, not a bare `e.optional` -- see `case 'member'`'s own comment on `isOptionalChainLink`;
				// same "a chain continuation isn't itself `?.` but still short-circuits" reasoning applies here.
				const chained = isOptionalChainLink(e);
				// Checked by name on the *unresolved* type, same reason `case 'member'`'s own `TYPED_ARRAY_RANGES`
				// check above is -- `T.resolve` below expands a typed-array alias into `TypedArray<T>`'s merged
				// (real class + ambient interface) shape, an intersection it never flattens, so a resolved check
				// would never match.
				if (rawObjT.type === 'ref' && !rawObjT.typeArgs && rawObjT.name in TYPED_ARRAY_RANGES)
					return chained ? T.combineTypes([T.rangeToType(TYPED_ARRAY_RANGES[rawObjT.name]), T.UNDEFINED]) : T.rangeToType(TYPED_ARRAY_RANGES[rawObjT.name]);
				// Same reasoning as `case 'member'`'s own `T.nonNullable` use just above: `?.` (direct or
				// chained) only ever indexes the non-nullish part of `objT` -- left as the full (possibly
				// nullish) union, none of the branches below (`'array'`/`'tuple'`/index-signature/named-key)
				// would ever match at all, since `T.resolve` never collapses a union on its own, and every
				// one would silently fall through to the bare `T.ANY` at the end.
				const objT = T.resolve(scope, chained ? T.nonNullable(rawObjT, scope) : rawObjT);
				recurse(e.property);
				const wrap = (t: Type) => chained ? T.combineTypes([t, T.UNDEFINED]) : t;
				if (objT.type === 'array')
					return wrap(objT.element);
				if (objT.type === 'tuple' && T.isLiteral(e.property, 'number')) {
					const el = objT.elements[e.property.value];
					if (err && !el)
						err(SEVERITY.ERROR, pos)`Tuple type '${objT}' has no element at index ${e.property.value}`;
					const t = el && T.tupleElementType(el);
					return t ? wrap(t) : T.ANY;
				}
				// A declared `[i: number]: T` index signature (real lib.d.ts typed arrays once `TStypeCheckAsync`
				// loads one, `Record<number, T>`-shaped types, etc) -- `indexSignatureOf` also searches every
				// part of an intersection (e.g. `TypedArray<T>`'s own merged interface+class shape, reached
				// through `this` inside its own method bodies with no alias name left to special-case by).
				// Not a fallback from something more precise -- for a computed/non-literal numeric key there's
				// no possible *named* property to prefer over it, so this is the only thing that can type
				// `obj[i]` against an object-shaped (or intersection) type at all.
				if (!T.isLiteral(e.property, 'string')) {
					const idxT = T.indexSignatureOf(objT, scope);
					if (idxT)
						return wrap(idxT);
				}
				if (T.isLiteral(e.property, 'string')) {
					const t = T.lookupMember(objT, e.property.value, scope);
					if (err && !t && T.sealed(objT, scope))
						err(SEVERITY.ERROR, pos)`Property '${e.property.value}' does not exist on type '${objT}'`;
					if (!t)
						return T.ANY;
					return (chained || T.memberOptional(objT, e.property.value, scope)) ? T.combineTypes([t, T.UNDEFINED]) : t;
				}
				return T.ANY;
			}

			case 'call':
			case 'new': {
				// `a.indexOf(...)`/`a.slice(...)`/etc on a typed array -- likely redundant now that
				// `TypedArray<T>` (`lib/typedarray.ts`) declares real methods for all of these, reached via
				// the ordinary `case 'member'`/`lookupMember` path below regardless (`lookupMember` already
				// searches every part of a merged intersection), but left as a harmless, explicit fallback.
				// Checked by name on the *unresolved* type -- same reason `TYPED_ARRAY_RANGES`'s other checks
				// above are: `T.resolve` would expand the alias into an intersection this never matches.
				if (e.type === 'call' && e.callee.type === 'member') {
					const objT = recurse(e.callee.object);
					if (objT.type === 'ref' && !objT.typeArgs && objT.name in TYPED_ARRAY_RANGES) {
						switch (e.callee.property) {
							case 'indexOf': case 'lastIndexOf':	return TS.RangeType('number', -1, 0x7fffffff, true);
							case 'includes':						return T.BOOLEAN;
							case 'reverse': case 'slice': case 'concat': case 'fill': case 'subarray':
								return TS.RefType(objT.name);
						}
					}
				}
				// `obj?.method(...)` (or a chain continuing one further out, `obj?.a.method(...)` --
				// `isOptionalChainLink`, same reasoning as `case 'member'`'s own use of it): `e.callee`
				// (`obj?.method`) already resolved to `MethodType | undefined` (the `'member'` case's own
				// optional-wrapping, correct for reading it as a plain value) -- but *calling* it needs the
				// real, non-nullish method signature to resolve against (an unstripped `| undefined` union
				// isn't `'function'`/`'constructor'`-shaped, so signature lookup below would just fail and
				// fall back to `any`). The call's own short-circuit-to-`undefined` is instead reattached to
				// the result once, right before the final `return`.
				const calleeOptional = e.callee.type === 'member' && isOptionalChainLink(e.callee);
				const calleeT	= T.resolveOwn(calleeOptional ? T.nonNullable(recurse(e.callee), scope) : recurse(e.callee), scope);
				// Explicit call-site type args (`f<Foo>(...)`) are raw AST, never stamped like a declaration's own annotations --
				// unstamped, a ref substituted into the callee's generic body would resolve against the callee's scope, not the caller's.
				let typeArgs	= (e.typeArgs as Type[] | undefined)?.map(t => T.stampScope(t, scope));
				// `new Promise((resolve, reject) => {...})` with no explicit `<T>`: real TS infers `T` by finding calls to
				// `resolve` within the executor's own body and unioning their argument types -- ordinary structural/argument
				// inference can't do this, since `resolve`'s own declared type (`(value: T | PromiseLike<T>) => void`) is
				// itself contravariant in the very `T` being solved for, not derivable by matching argument shapes.
				if (!typeArgs && e.type === 'new' && e.callee.type === 'identifier' && e.callee.name === 'Promise' && e.arguments.length === 1) {
					const executor = e.arguments[0];
					if (executor.type === 'function' || executor.type === 'arrow') {
						const resolveParam = executor.params[0];
						if (resolveParam && typeof resolveParam.key === 'string') {
							const resolveName = resolveParam.key;
							const resolvedTypes: Type[] = [];
							walkB(executor.body as JS.Statement<any>[] | Expr, undefined, (x, process) => {
								if (x.type === 'call' && x.callee.type === 'identifier' && x.callee.name === resolveName) {
									const arg = x.arguments[0];
									resolvedTypes.push(arg && arg.type !== 'spread' ? recurse(arg) : T.UNDEFINED);
								}
								return process(x);
							});
							typeArgs = [resolvedTypes.length ? T.combineTypes(resolvedTypes) : T.VOID];
						}
					}
				}

				let overloads: TS.CallSig[] | undefined;
				let sig: TS.CallSig|undefined = (calleeT.type === 'intersection' ? calleeT.types.map(p => T.resolveOwn(p, scope)) : [calleeT])
					.find(p => p.type === 'function' || p.type === 'constructor');
				if (!sig) {
					// `new` prefers a construct signature, a plain call a bare call signature -- each falls back to the other when its preferred
					// kind is absent (real TS wouldn't allow that cross-fallback), matching this checker's existing leniency.
					const members 		= T.collectMembers(calleeT, scope);
					const constructs	= members.filter(m => m.type === 'construct');
					const callSigs		= members.filter(m => m.type === 'call');
					const own			= e.type === 'new' ? constructs : callSigs;
					const calls			= own.length ? own : (e.type === 'new' ? callSigs : constructs);
					if (calls.length === 1) {
						sig = calls[0];
					} else if (calls.length > 1) {
						overloads = calls;		// resolved below, once argument types are known
					} else if (T.sealed(calleeT, scope)) {
						if (err)
							err(SEVERITY.ERROR, pos)`Type '${calleeT}' is not callable in '${e}'`;
						return T.ANY;
					}
				}

				// Overload resolution: first arity+type fit wins, computed without contextual param typing (which signature to type a
				// callback's params from isn't known yet). No fit stays lenient rather than guessing -- tried that, caused false positives.
				if (overloads) {
					const hasSpread = e.arguments.some(a => a.type === 'spread');
					// Muted (`err` explicitly `undefined`, not `recurse`'s ambient one) and precise (`widen: false`): only *trying*
					// candidate overloads here, not committing to one -- matches old code's `runMuted` wrap around this whole block
					// (walking a rejected/not-yet-chosen candidate's arguments, e.g. a callback's body, must never report diagnostics
					// for a signature that isn't picked), and must see the same precise per-argument types the final `argTs`/
					// `preArgTs` below do -- a widened trial type can make a structurally narrow overload (e.g. `Symbol.split`-shaped)
					// look like it fits when the real (literal) argument wouldn't, picking the wrong candidate before the real one
					// is even tried.
					const trialArgTs = e.arguments.map(a => a.type === 'spread' ? undefined : typeOf(a, scope, false, undefined, yieldCollector, undefined));
					sig = overloads!.find(c => T.argsFit(instantiate(c, trialArgTs, typeArgs, scope, pos), trialArgTs, scope, hasSpread));
				}
				if (overloads && !sig && err)
					err(SEVERITY.WARNING, pos)`No overload of '${e.callee}' matches this call; arguments left unchecked`;

				// Contextual parameter typing: an unannotated callback argument (`arr.map(x => x.foo)`) would otherwise type its own params as `any`.
				// Fills them in here from the matching declared (pre-substitution) param type -- mutates the AST node; must run before `argTs` below, which triggers `checkFunctionBody` on each argument.
				if (sig) {
					const declScope	= T.declScopeOf(sig, scope);

					// First pass, non-callback arguments only (reused below in `argTs`, so nothing gets double-typed/reported): infers a type
					// param from a sibling argument (`arr.reduce((acc, x) => ..., seed)`'s `U` from `seed`) before typing the callback itself.
					const preArgTs = e.arguments.map(a => a.type === 'function' || a.type === 'arrow' || a.type === 'spread' ? undefined : recurse(a));
					let preMap: Map<string, Type> | undefined;
					if (sig.typeParams?.length) {
						const names		= new Map(sig.typeParams.map(p => [p.name, p] as const));
						preMap = new Map<string, Type>();
						preArgTs.forEach((t, i) => {
							const p = sig!.params[i];
							if (t && p?.typeAnnotation)
								T.inferTypeArgs(p.typeAnnotation, t, names, preMap!, scope, 0, declScope);
						});
						// A param not pinned down by a sibling argument may still come from where the whole call's result is going
						// (`new Promise<T>((resolve) => ...)`'s `T` -- no argument gives it, only the declared type of the assignment target).
						if (expected && sig.returnType)
							T.inferTypeArgs(sig.returnType, expected, names, preMap, scope, 0, declScope);
					}

					e.arguments.forEach((a, i) => {
						if (a.type === 'function' || a.type === 'arrow') {
							const declared	= sig.params[i]?.typeAnnotation;
							applyContextualParams(a.params, declared && preMap?.size ? T.substituteType(declared, preMap) : declared, scope);
						}
					});

					const restElementTs: Type[] = [];
					const argTs = e.arguments.map((a, i) => {
						if (a.type === 'function' || a.type === 'arrow')
							return recurse(a);
						if (a.type !== 'spread')
							return preArgTs[i];
						const t		= T.resolveOwn(recurse(a.operand), scope);
						const el	= t.type === 'array' ? t.element
									: t.type === 'tuple' ? T.combineTypes(t.elements.map(el => T.tupleElementType(el)).filter(x => !!x))
									: undefined;
						if (el)
							restElementTs.push(el);
						return undefined;
					});

					// A rest-only signature called with plain positional args leaves those past `sig.params.length` unmatched by the
					// per-param inference loop -- feed them into the same rest-element inference a real spread would use.
					e.arguments.forEach((a, i) => {
						if (a.type !== 'spread' && i >= sig!.params.length && argTs[i])
							restElementTs.push(argTs[i] as Type);
					});

					const { params, returnType } = instantiate(sig, argTs, typeArgs, scope, pos, restElementTs, expected, err);
					if (err && !argTs.some(t => t === undefined)) {	// no spread args
						const required	= params.filter(p => !hasMod(p, 'optional')).length;
						const max		= sig.rest ? Infinity : params.length;
						if (argTs.length < required || argTs.length > max)
							err(SEVERITY.ERROR, pos)`Expected ${required === max ? required : required + '-' + (max === Infinity ? 'more' : max)} arguments, but got ${argTs.length} in '${e}'`;
						argTs.forEach((t, i) => {
							const p = params[i];
							if (t && p && p.typeAnnotation) {
								// an optional parameter also accepts undefined
								if (!checkAssignable(t, hasMod(p, 'optional') ? TS.UnionType([p.typeAnnotation, T.UNDEFINED]) : p.typeAnnotation, scope, pos, declScope, err))
									err(SEVERITY.ERROR, pos)`Argument of type '${t}' is not assignable to parameter '${p.key}: ${p.typeAnnotation}' in '${e}'`;
								else
									checkExcessProps(e.arguments[i], p.typeAnnotation, scope, pos, declScope, err);
							}
						});
					}

					if (e.callee.type === 'member' && e.callee.object.type === 'identifier' && e.callee.object.name === 'Math')
						return narrowMath(e.callee.property, params) ?? returnType!;

					// A predicate return is only special to `narrow()`'s dedicated `case 'call'`; as a plain value it's `boolean` (or `void`
					// if asserting) -- without this, the raw predicate type would leak into whatever consumes this expression next.
					const result = returnType && returnType.type === 'predicate' ? (returnType.asserts ? T.VOID : T.BOOLEAN) : returnType!;
					return calleeOptional ? T.combineTypes([result, T.UNDEFINED]) : result;
				}
				return e.type === 'new' && e.callee.type === 'identifier' ? TS.RefType(e.callee.name, typeArgs) : T.ANY;
			}

			// `expr<T,U>` (TS 4.7+): pins a generic function/constructor's type params without calling it. An overloaded callee keeps every
			// arity-compatible signature instantiated (still overloaded); anything else stays `ANY`, same leniency as an uncallable `case 'call'`.
			case 'instantiation': {
				const calleeT	= T.resolveOwn(recurse(e.expression), scope);
				// Same reasoning as the 'call'/'new' case above -- these type args are raw AST, never stamped.
				const typeArgs	= (e.typeArgs as Type[] | undefined)?.map(t => T.stampScope(t, scope));
				const fnPart	= (calleeT.type === 'intersection' ? calleeT.types.map(p => T.resolveOwn(p, scope)) : [calleeT])
					.find(p => p.type === 'function' || p.type === 'constructor');
				if (fnPart)
					return { type: fnPart.type, ...instantiate(fnPart, [], typeArgs, scope, pos, undefined, undefined, err) };
				if (calleeT.type === 'object') {
					const calls = calleeT.members.filter(m => m.type === 'call' || m.type === 'construct');
					if (calls.length)
						return TS.ObjectType(calls.map(m => TS.TypeMember(m.type, instantiate(m, [], typeArgs, scope, pos, undefined, undefined, err))));
				}
				return T.ANY;
			}

			case 'unary': {
				const argT = recurse(e.operand);
				switch (e.operator) {
					case '!':		return T.BOOLEAN;
					case 'typeof':	return T.STRING;
					case 'void':	return T.UNDEFINED;
					case 'delete':	return T.BOOLEAN;
					case '-': {
						const r = T.resolveOwn(argT, scope);
						if (T.isAny(r))
							return T.ANY;
						const nr = T.toRange(r);
						return nr ? T.rangeToType(T.rangeNeg(nr)) : T.isBigint(r, scope) ? T.BIGINT : T.NUMBER;
					}
					case '+':
					case '~':		return T.isAny(T.resolveOwn(argT, scope)) ? T.ANY : T.isBigint(argT, scope) ? T.BIGINT : T.NUMBER;
					case '++':
					case '--':
						if (err && !T.isNumberLike(argT, scope))
							err(SEVERITY.ERROR, pos)`Operand of '${e.operator}' must be numeric, got '${argT}' in '${e}'`;
						return T.isAny(T.resolveOwn(argT, scope)) ? T.ANY : T.isBigint(argT, scope) ? T.BIGINT : T.NUMBER;
					case 'await':	return T.awaitType(argT, scope);
					default:		return argT;
				}
			}
			case 'unary_post': {
				const argT = recurse(e.operand);
				if (e.operator === '!') {
					const t = T.resolveOwn(argT, scope);
					if (t.type === 'union') {
						const parts = t.types.filter(x => !T.isNullish(x, scope));
						return parts.length ? T.combineTypes(parts) : t;
					}
					return T.isNullish(t, scope) ? T.NEVER : t;
				}
				if (err && !T.isNumberLike(argT, scope))
					err(SEVERITY.ERROR, pos)`Operand of '${e.operator}' must be numeric, got '${argT}' in '${e}'`;
				return T.isAny(T.resolveOwn(argT, scope)) ? T.ANY : T.isBigint(argT, scope) ? T.BIGINT : T.NUMBER;
			}

			case 'binary': {
				let lt = recurse(e.left);

				if (LOGICAL_OPS.has(e.operator)) {
					// Precise throughout (`lt`/`rt` unwidened): a fresh literal's own value determines `other`/`makeNullish`
					// far more exactly than its widened form would (`5 && b` can see `5` is unconditionally truthy and drop
					// the falsy branch entirely; widened to `number` it couldn't). `typeOf`'s own final wrap widens the whole
					// combined result once, if the caller wants that -- there's nothing left for this case to decide itself.
					const rt	= typeOf(e.right, e.operator === '&&' ? narrow(e.left, scope, true) : e.operator === '||' ? narrow(e.left, scope, false) : scope, false, undefined, yieldCollector, err);
					const r		= T.resolveOwn(lt, scope);
					const other = T.isOther(e.operator[0]);

					return T.combineTypes([
						...(r.type === 'union' ? r.types : [r]).map(m => {
							const p = T.resolveOwn(m, scope);
							if (other(p, scope))
								return undefined;
							// a plain boolean only survives `||` as true, `&&` as false
							if (e.operator !== '??' && T.isBoolean(p))
								return Literal(e.operator === '||');
							// `&&`'s false path narrows a plain string/number to its one falsy literal (`""`/`0`) -- `||`'s truthy path has no
							// single such value (any non-empty string, any non-zero number), so only `&&` narrows here.
							if (e.operator === '&&')
								return T.makeNullish(p);
							return m;
						}).filter(t => !!t),
						rt,
					]);
				}
				const rt = recurse(e.right);
				if (COMPARISON_OPS.has(e.operator))
					return T.BOOLEAN;

				if (e.operator.endsWith('=')) {
					// Assignments are judged against the declaration-site type, not any active narrowing -- a dotted target goes through
					// `lookupMember` on the object's own type, not `typeOf` (which would consult the narrowings map instead).
					if (err) {
						if (e.left.type === 'identifier') {
							lt = scope.declared(e.left.name) || lt;
						} else if (e.left.type === 'member') {
							const objT = recurse(e.left.object);
							lt = T.lookupMember(objT, e.left.property, scope) || lt;
							lt = T.memberOptional(objT, e.left.property, scope) ? T.combineTypes([lt, T.UNDEFINED]) : lt;
						} else if (e.left.type === 'index') {
							// A typed-array write accepts any real `number` (silently truncated/wrapped via the
							// element's own real JS coercion, never a type error) -- unlike a read, so the narrow
							// element range `typeOf`'s 'index' case gives typed-array reads doesn't apply here.
							// Checked by name, unresolved, same reason `typeOf`'s own 'index' case checks it that way.
							const objT = recurse(e.left.object);
							if (objT.type === 'ref' && !objT.typeArgs && objT.name in TYPED_ARRAY_RANGES)
								lt = T.NUMBER;
						}

						if (e.operator === '=') {
							if (!checkAssignable(rt, lt, scope, pos, scope, err)) {
								err(SEVERITY.ERROR, pos)`Type '${rt}' is not assignable to type '${lt}' in '${e.left} = ...'`;
							} else {
								checkExcessProps(e.right, lt, scope, pos, scope, err);
								// Later statements see the assigned type, not the wider declared one. `pathKey`, not just an identifier: a
								// dotted target narrows the same way a bare name does, via the same narrowings map.
								const key = T.pathKey(e.left);
								if (key)
									// Always widens for the narrowed-forward type, regardless of this call's own `widen` (a side effect
									// on `scope`, not part of the return value) -- matches plain JS assignment semantics: `x = 5` narrows
									// `x` to `number` from here on, not literal `5`, whether or not *this* expression's own answer is widened.
									scope.addNarrowing(key, T.widenLiterals(rt));
							}
						} else if (e.operator === '??=' || e.operator === '||=' || e.operator === '&&=') {
							const key = T.pathKey(e.left);
							if (key) {
								// `x ??= y` leaves x holding its non-nullish members or y (and likewise for ||= / &&=)
								const r		= T.resolveOwn(lt, scope);
								const other = T.isOther(e.operator[0]);

								scope.addNarrowing(key, T.combineTypes([
									...(r.type === 'union' ? r.types : [r]).filter(m => !other(T.resolveOwn(m, scope), scope)),
									T.widenLiterals(rt),
								]));
							}
						}
					}
					return rt;
				}

				if (e.operator === '+') {
					if (T.isStringLike(lt, scope) || T.isStringLike(rt, scope))
						return T.STRING;
					if (T.isAny(T.resolveOwn(lt, scope)) || T.isAny(T.resolveOwn(rt, scope)))
						return T.ANY;		// could be string concatenation
				}
				if (err) {
					if (!T.isNumberLike(lt, scope))
						err(SEVERITY.ERROR, pos)`Operand of '${e.operator}' must be numeric, got '${lt}' in '${e.left}'`;
					if (!T.isNumberLike(rt, scope))
						err(SEVERITY.ERROR, pos)`Operand of '${e.operator}' must be numeric, got '${rt}' in '${e.right}'`;
				}
				if (T.isAny(T.resolveOwn(lt, scope)) || T.isAny(T.resolveOwn(rt, scope)))
					return T.ANY;

				// Interval arithmetic keeps a bounded result bounded (`x + 1` for a range-narrowed `x`), instead of always
				// collapsing back to the base `number`/`bigint` -- falls through to the old plain-type result whenever
				// either operand isn't numeric-range-shaped, or the operator isn't one of these four.
				const lr = T.toRange(T.resolveOwn(lt, scope)), rr = T.toRange(T.resolveOwn(rt, scope));
				const combined = lr && rr && (
					e.operator === '&' || e.operator === '|' || e.operator === '^' || e.operator === '<<' || e.operator === '>>' ? T.rangeLogic(lr, rr)
					: e.operator === '>>>' ? {base: lr.base, integer: true, min: 0, max: 0xffffffff } satisfies T.NumRange
					: e.operator === '+' ? T.rangeAdd(lr, rr)
					: e.operator === '-' ? T.rangeSub(lr, rr)
					: e.operator === '*' ? T.rangeMul(lr, rr)
					: e.operator === '/' ? T.rangeDiv(lr, rr)
					: undefined
				);
				return combined ? T.rangeToType(combined) : T.isBigint(lt, scope) || T.isBigint(rt, scope) ? T.BIGINT : T.NUMBER;
			}

			case 'conditional':
				recurse(e.test);
				// Precise per branch (`widen: false`) -- `typeOf`'s own final wrap widens the combined result once, if
				// the caller wants that, same reasoning as the logical-operator case above.
				return T.combineTypes([
					typeOf(e.consequent, narrow(e.test, scope, true), false, expected, yieldCollector, err),
					typeOf(e.alternate, narrow(e.test, scope, false), false, expected, yieldCollector, err)
				]);

			case 'sequence':
				return e.expressions.map(x => recurse(x)).pop() ?? T.ANY;

			case 'spread':
				return recurse(e.operand);

			case 'tagged_template': {
				const t = T.resolveOwn(recurse(e.tag), scope);
				e.quasi.forEach(p => p.exp && recurse(p.exp));
				return t.type === 'function' ? t.returnType ?? T.ANY : T.ANY;
			}
			case 'yield': {
				const argT = e.operand ? recurse(e.operand) : T.VOID;
				if (yieldCollector) {
					if (e.delegate) {
						const r		= T.resolveOwn(argT, scope);
						yieldCollector.push(r.type === 'array' ? r.element
							: r.type === 'tuple' ? T.combineTypes(r.elements.map(e => T.tupleElementType(e)).filter((e): e is Type => !!e))
							: r.type === 'ref' && r.typeArgs?.length && SINGLE_ELEMENT_ITERABLES.has(r.name) ? r.typeArgs[0]
							: T.ANY
						);
					} else {
						yieldCollector.push(T.widenLiterals(argT));
					}
				}
				return T.ANY;
			}

			case 'class': {
				const e2 = e as TS.Class;
				const { instance, value } = classShapes(e2, scope);
				checkClassMembers(e.name, e2.body, instance, value, scope, err);
				return value;
			}
			case 'as': {
				const anno = e.typeAnnotation as Type;
				// `T.freeze`: any assertion's result is exempt from `widenLiterals`, permanently -- both branches (an
				// explicit `as const`, or a plain `as T` returning `T` itself) get it, since a plain type assertion
				// never auto-widens either, matching real TS. Survives being embedded in a later-widened container
				// (`[1, x as const]`) or passed through `satisfies`/a comma/a spread, unlike a shape-based check on
				// `e` itself would (that only ever sees the *top-level* expression `typeOf` was originally called on).
				return T.freeze(anno.type === 'ref' && anno.name === 'const' ? recurse(e.expression) : anno);
			}
			case 'satisfies': {
				const anno = e.typeAnnotation as Type;
				const t = recurse(e.expression, anno);
				if (err) {
					if (!checkAssignable(t, anno, scope, pos, scope, err))
						err(SEVERITY.ERROR, pos)`Type '${t}' does not satisfy the expected type '${anno}'`;
					else
						checkExcessProps(e.expression, anno, scope, pos, scope, err);
				}
				return t;
			}
			default:
				return T.ANY;
		}
	};
	// Applied once, uniformly, to whatever `recurse` computed -- not scattered through individual switch cases (a bare
	// literal expression's own case never widens on its own, matching `as const`'s need to see the precise type deeper
	// in the walk). No exemption needed for an assertion's own result here: `'as'` already freezes it (`T.freeze`),
	// and `widenLiterals` itself leaves a frozen leaf untouched, at any nesting depth -- including one embedded inside
	// a container this call goes on to widen (`[1, x as const]`), which a check on `e` itself here never could reach.
	const result = recurse(e, expected);
	return widen ? T.widenLiterals(result) : result;
}

// ---- functions / classes / statements -------------------------------------------------------

function checkFunctionBody(fnj: JS.CallSig<any>, body: JS.Statement<any>[] | Expr | undefined, scope: Scope, async: boolean, skipReturn?: boolean, generator?: boolean, err?: Err) {
	const fn = fnj as TS.CallSig;
	if (!body)
		return;

	let expected = fn.returnType;
	if (expected && async) {
		const p = T.asPromiseRef(expected, scope);
		expected = p ? p.typeArgs![0] : expected;
	}
	// A declared type predicate (`x is T`) is never checked against the body's boolean return, same as `any` -- but unlike `any`, it must
	// not be *inferred over* either: the declared predicate is never a worse answer, so `fn.returnType` stays untouched below.
	const isPredicate = expected?.type === 'predicate';
	if (skipReturn || (expected && T.isAny(expected)) || isPredicate)
		expected = undefined;

	// Already fully known and this walk is only an unrelated call's speculative (muted) side effect -- this declaration
	// gets a real, unmuted pass whenever it's directly checked, so nothing here needs to backstop that.
	if (expected && !err)
		return;

	const inner = new Scope(scope);
	// First (real, unmuted) check wins: `narrow`'s speculative re-walks always run under `muted` and only ever
	// reach this same node *after* the real pass already checked it (e.g. `case 'if'` checks `stmt.test` before
	// narrowing it), so `??=` can never let a narrowed/speculative scope clobber the real one.
	fn.scope ??= inner;
	for (const p of fn.params) {
		const anno = p.typeAnnotation;
		// Computed unconditionally (not just `!muted`) so it's available below for a defaulted,
		// unannotated param's own type too -- `typeOf`'s own diagnostics are already self-gated by
		// the ambient `muted` counter, so only the explicit assignability check+report needs the guard.
		const dt = p.default && typeOf(p.default, inner, true, undefined, undefined, err);
		if (err && dt && anno && !checkAssignable(dt, anno, inner, (p as any).pos, inner, err))
			err(SEVERITY.ERROR, (p as any).pos)`Default value of type '${dt}' is not assignable to parameter type '${anno}'`;
		if (typeof p.key === 'string')
			inner.addValue(p.key, anno ? (hasMod(p, 'optional') && !p.default ? T.combineTypes([anno, T.UNDEFINED]) : anno) : dt ?? T.ANY);
		else
			T.bindingNames(p.key).forEach(n => inner.addValue(n, T.ANY));
	}
	if (fn.rest) {
		if (typeof fn.rest.key === 'string')
			inner.addValue(fn.rest.key, (fn.rest.typeAnnotation as Type | undefined) ?? T.ANY);
		else
			T.bindingNames(fn.rest.key).forEach(n => inner.addValue(n, T.ANY));
	}

	if (Array.isArray(body)) {
		if (expected) {
			checkBlock(body, inner, (argument: Expr|undefined, scope: Scope): void => {
				if (argument) {
					const t = typeOf(argument, scope, false, expected, undefined, err);
					if (err) {
						if (!checkAssignable(T.unwrapIfAsync(t, scope, async), expected, scope, (argument as any).pos, scope, err))
							err(SEVERITY.ERROR, (argument as any).pos)`Type '${t}' is not assignable to declared return type '${expected}'`;
						else
							checkExcessProps(argument, expected, scope, (argument as any).pos, scope, err);
					}
				}
			}, undefined, err);
		} else {
			const	returns: Type[] = [];
			let		yields: Type[] | undefined;
			const yieldCollector = generator ? [] : undefined;
			try {
				checkBlock(body, inner, (argument: Expr|undefined, scope: Scope): void => {
					returns.push(argument ? typeOf(argument, scope, true, undefined, undefined, err) : T.VOID);
				}, yieldCollector, err);
			} finally {
				yields = yieldCollector;
			}
			if (!isPredicate) {
				if (generator) {
					fn.returnType = TS.RefType('Generator', [
						yields!.length ? T.combineTypes(yields!) : T.NEVER,
						returns.length ? T.combineTypes(returns) : T.VOID,
						T.ANY,
					]);
				} else {
					const combined = returns.length ? T.combineTypes(returns) : (alwaysThrows(body[body.length - 1]) ? T.NEVER : T.VOID);
					fn.returnType = T.wrapReturnIfAsync((T.isBoolean(combined) && inferredPredicate(fn, body, inner)) || combined, inner, async);
				}
			}

		}
	} else {
		// Precise (unwidened): `expected` may itself be a narrow/literal declared return type (rare, but real), so the
		// assignability check below must see `body`'s exact inferred type, not a pre-widened one -- only the *inference*
		// branch (no declared type to check against) widens, and only there.
		const t = typeOf(body, inner, false, expected, undefined, err);
		if (expected) {
			if (err && !checkAssignable(T.unwrapIfAsync(t, inner, async), expected, inner, (body as any).pos, inner, err))
				err(SEVERITY.ERROR, (body as any).pos)`Type '${t}' is not assignable to declared return type '${expected}'`;
		} else if (!isPredicate) {
			const widened = T.widenLiterals(t);
			fn.returnType = T.wrapReturnIfAsync((T.isBoolean(widened) && inferredPredicate(fn, body, inner)) || widened, inner, async);
		}
	}
}

function checkClassMembers(name: string | undefined, body: TS.ClassMember[], instance: Type, classValue: Type, scope: Scope, err?: Err): Scope {
	const instScope = new Scope(scope);
	// prefer the named entry: declaration merging can extend it beyond this declaration's shape
	instScope.addValue('this', name && scope.type(name) ? { type: 'ref', name } : instance);
	const statScope = new Scope(scope);
	statScope.addValue('this', classValue);
	for (const m of body) {
		const inner = m.type === 'static_block' || ('modifiers' in m && hasMod(m, 'static')) ? statScope : instScope;
		switch (m.type) {
			case 'field':
				if (m.value) {
					const t = typeOf(m.value, inner, true, undefined, undefined, err);
					if (m.typeAnnotation && err) {
						if (!checkAssignable(t, m.typeAnnotation, inner, (m as any).pos, inner, err))
							err(SEVERITY.ERROR, (m as any).pos)`Type '${t}' is not assignable to type '${m.typeAnnotation}'`;
						else
							checkExcessProps(m.value, m.typeAnnotation, inner, (m as any).pos, inner, err);
					}
				}
				break;
			case 'method':
				checkFunctionBody(m, m.body, inner, hasMod(m, 'async'), m.key === 'constructor' || hasMod(m, 'generator'), hasMod(m, 'generator'), err);
				break;
			case 'get':
				checkFunctionBody(m, m.body, inner, false, false, false, err);
				break;
			case 'set':
				checkFunctionBody(m, m.body, inner, false, true, false, err);
				break;
			case 'static_block':
				checkBlock(m.body, new Scope(inner), undefined, undefined, err);
				break;
		}
	}
	return instScope;
}

// Every leaf of an if/else chain (or a block's final statement) assigns the same variable:
// yields the assigned expressions so the post-if type can merge the branches
function assignRights(st: TS.Statement, name?: string): { name: string; rights: Expr[] } | undefined {
	if (st.type === 'expression' && st.expression.type === 'binary' && st.expression.operator === '=' && st.expression.left.type === 'identifier' && (!name || st.expression.left.name === name))
		return { name: st.expression.left.name, rights: [st.expression.right] };
	if (st.type === 'block' && st.body.length) {
		// Not just the last statement: `if (!x) { x = e; bookkeeping(); }` assigns `x` before unrelated further work --
		// scan backward for the last statement that actually assigns `name`, skipping over anything else.
		for (let i = st.body.length - 1; i >= 0; i--) {
			const a = assignRights(st.body[i], name);
			if (a)
				return a;
		}
		return undefined;
	}
	if (st.type === 'if' && st.alternate) {
		const a = assignRights(st.consequent, name);
		const b = a && assignRights(st.alternate, a.name);
		return a && b && { name: a.name, rights: [...a.rights, ...b.rights] };
	}
	return undefined;
}

export function checkBlock(stmts: TS.Statement[], scope: Scope, onReturn?: (argument: Expr|undefined, scope: Scope)=>void, yieldCollector?: Type[], err?: Err) {
	hoist(stmts, scope);
	for (const s of stmts) {
		checkStmt(s, scope, onReturn, yieldCollector, err);

		if (s.type === 'if') {
			if (!s.alternate && alwaysExits(s.consequent)) {
				// guard clause (`if (!ok) return;`): the rest of the block sees the negated narrowing
				scope = narrow(s.test, scope, false);
			} else {
				// `if (x === undefined) x = e;` and full if/else chains assigning x:
				// afterwards x holds one branch's value or another's
				const a = assignRights(s.alternate ? s : s.consequent);
				if (a) {
					const parts = a.rights.map(r => typeOf(r, scope, true, undefined, undefined, err));
					if (!s.alternate) {
						const other = narrow(s.test, scope, false).value(a.name);
						if (other)
							parts.push(other);
					}
					scope = new Scope(scope);
					scope.addNarrowing(a.name, T.combineTypes(parts));
				}
			}
		}
	}
}


function checkStmt(stmt: TS.Statement, scope: Scope, onReturn?: (argument: Expr|undefined, scope: Scope)=>void, yieldCollector?: Type[], err?: Err): void {
	// The real (post-narrowing, where applicable) `Scope` this statement was type-checked under --
	// stamped directly on the node (like `pos`, `CallSig.scope`), not tracked as checker state, so a
	// consumer with no narrowing-aware scope of its own (towasm.ts's codegen, whose own scope tracking
	// never reflects flow narrowing) can read back the same scope the checker concluded for this
	// statement instead of only ever seeing the function-entry scope. Untyped (`any`), not a formal
	// field on `Statement` -- that union is large enough that a shared field added via an intersection
	// broke unrelated generic AST-mapping code elsewhere (`walker.ts`'s `keyof`-based `NodeMap`).
	// `??=`: first (real, unmuted) check wins, same reasoning as `fn.scope ??=` above -- a speculative
	// (muted) re-walk always reaches a given statement only after the real pass already has.
	(stmt as any).scope ??= scope;
	const typeOf1 = (e: Expr, scope: Scope, expected?: Type) => typeOf(e, scope, true, expected, yieldCollector, err);
	const checkBlock1 = (stmts: TS.Statement[], scope: Scope) => checkBlock(stmts, scope, onReturn, yieldCollector, err);

	const recurse = (stmt: TS.Statement, scope: Scope) => checkStmt(stmt, scope, onReturn, yieldCollector, err);

	switch (stmt.type) {
		case 'var_decl': {
			// `hoistVar` (which actually *registers* each declared name's type in `scope`) must run
			// regardless of `muted` -- only the assignability diagnostics below are real "reporting" and
			// should be skipped. These used to share one `if (!muted)` guard, so a plain top-level
			// `const`/`let` (not `stmt.ambient`, so `hoist`'s own pre-pass skips it -- see that function's
			// comment) checked under a muted pass (`checkBlock`'s own `muted` param, e.g. towasm.ts's
			// bundled-lib check) never got registered at all: any later reference to it resolved to `any`
			// as a plain "unknown identifier" fallback, not a real error -- found via `lib/number.ts`'s
			// `export const ieeeFrom = __asm<...>(...)`, whose call result silently became `any` deep
			// inside `Math.log`, well past where the missing registration actually happened.
			// `stmt.ambient`: skip here -- `hoist`'s own pre-pass already registered it, in the same
			// sequential order as every other top-level declaration (so a same-named real `class` later
			// in the file correctly wins, last-declaration-wins). Re-running `hoistVar` here too would
			// re-register it a second time at *this* statement's own position in the sequential walk --
			// earlier than that later class -- silently clobbering the class's binding back to the
			// ambient stub for the rest of this pass (found via `String`: `declare var String` in
			// lib.d.ts plus the real `class String` in string.ts, both bind the name `String`, and the
			// real class's own constructor -- checked *after* this re-clobber -- saw the ambient stub's
			// type when resolving its own self-referential `String.alloc(...)` call).
			const pos = (stmt as any).pos;
			for (const d of stmt.declarations) {
				if (err && d.typeAnnotation && d.init) {
					const anno = d.typeAnnotation as Type;
					const init = typeOf1(d.init, scope, anno);
					if (!init)
						checkExcessProps(d.init, anno, scope, pos, scope, err);
					else if (!checkAssignable(init, anno, scope, pos, scope, err))
						err(SEVERITY.ERROR, pos)`Type '${init}' is not assignable to type '${anno}' in declaration of '${d.name}'`;
				}
				if (!stmt.ambient)
					hoistVar(scope, d, stmt.kind !== 'const', undefined, err);
			}
			break;
		}
		case 'expression':
			typeOf1(stmt.expression, scope);
			break;
		case 'block':
			checkBlock1(stmt.body, new Scope(scope));
			break;
		case 'if':
			typeOf1(stmt.test, scope);
			recurse(stmt.consequent, new Scope(narrow(stmt.test, scope, true)));
			if (stmt.alternate)
				recurse(stmt.alternate, new Scope(narrow(stmt.test, scope, false)));
			break;
		case 'while':
		case 'do_while':
			typeOf1(stmt.test, scope);
			recurse(stmt.body, new Scope(stmt.type === 'while' ? narrow(stmt.test, scope, true) : scope));
			break;
		case 'for': {
			const inner = new Scope(scope);
			if (stmt.kind === 'normal') {
				if (stmt.init) {
					if (stmt.init.type === 'var_decl')
						recurse(stmt.init, inner);
					else
						typeOf1(stmt.init, inner);
				}
				if (stmt.test)
					typeOf1(stmt.test, inner);
				if (stmt.update)
					typeOf1(stmt.update, inner);
				recurse(stmt.body, stmt.test ? narrow(stmt.test, inner, true) : inner);
			} else {
				const rightT = T.resolveOwn(typeOf1(stmt.right, inner), inner);
				const elemT = stmt.kind === 'in' ? T.STRING
					: rightT.type === 'array' ? rightT.element
					: T.isString(rightT) ? T.STRING
					: T.ANY;
				if (stmt.init.type === 'var_decl') {
					for (const d of stmt.init.declarations)
						hoistVar(inner, d, true, (d.typeAnnotation as Type) ?? elemT);
				} else {
					typeOf1(stmt.init, inner);
				}
				recurse(stmt.body, inner);
			}
			break;
		}
		case 'return':
			onReturn?.(stmt.argument, scope);
			break;
		case 'switch': {
			typeOf1(stmt.discriminant, scope);
			// A `case` with no body falls through to the next -- reuse `if`'s discriminated-union narrowing by synthesizing that binary
			// test per case, OR-ing fallthrough cases together. A bare `default` needs "none of the others" narrowing, unmodeled -- body stays unnarrowed.
			let pending: Expr[] = [];
			for (const c of stmt.cases) {
				if (c.test) {
					typeOf1(c.test, scope);
					pending.push({ type: 'binary', operator: '===', left: stmt.discriminant, right: c.test });
				}
				if (c.consequent.length || !c.test) {
					const test = pending.reduce<Expr | undefined>((acc, t) => acc ? { type: 'binary', operator: '||', left: acc, right: t } : t, undefined);
					checkBlock1(c.consequent, new Scope(test ? narrow(test, scope, true) : scope));
					pending = [];
				}
			}
			break;
		}
		case 'throw':
		case 'with':
			typeOf1(stmt.argument, scope);
			if (stmt.type === 'with')
				recurse(stmt.body, scope);
			break;
		case 'try':
			checkBlock1(stmt.block, new Scope(scope));
			if (stmt.handlerBody) {
				const inner = new Scope(scope);
				if (stmt.handlerParam)
					inner.addValue(stmt.handlerParam, T.ANY);
				checkBlock1(stmt.handlerBody, inner);
			}
			if (stmt.finalizer)
				checkBlock1(stmt.finalizer, new Scope(scope));
			break;
		case 'labeled':
			recurse(stmt.body, scope);
			break;
		case 'function_decl':
			if (stmt.body)
				checkFunctionBody(stmt, stmt.body, scope, hasMod(stmt, 'async'), hasMod(stmt, 'generator'), hasMod(stmt, 'generator'), err);
			break;
		case 'class_decl': {
			const c = stmt as TS.Class;
			const { instance, value } = classShapes(c, scope);
			checkClassMembers(stmt.name, c.body, instance, value, scope, err);
			break;
		}
		case 'export_decl':
			recurse(stmt.declaration, scope);
			break;
		case 'export':
			if (stmt.default) {
				if (isTsDeclaration(stmt.default))
					recurse(stmt.default, scope);
				else
					typeOf1(stmt.default, scope);
			}
			break;
		case 'namespace_decl':
			checkBlock1(stmt.body, new Scope(scope));
			break;

		// type_alias_decl / interface_decl / enum_decl / import / export /
		// empty / debugger / continue / break: declaration-only or nothing to check (hoist saw them)
	}
}

export function inferReturn(fnj: JS.CallSig<any>, body: JS.Statement<any>[], outer: Scope): Type {
	if (fnj.returnType)
		return fnj.returnType as Type;
	const sig = { ...fnj } as TS.CallSig;
	checkFunctionBody(sig, body, outer, false);
	return sig.returnType ?? T.VOID;
}
