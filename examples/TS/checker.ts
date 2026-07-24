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

export const SEVERITY = {
	GAP:		0,	// known missing functionality (see the header's own gap list) -- not a judgment call, just a reminder
	WARNING:	1,
	ERROR:		2,
} as const;
export type SEVERITY = (typeof SEVERITY)[keyof typeof SEVERITY];

type Diagnostics = (severity: SEVERITY, pos: JS.Location, strings: TemplateStringsArray, ...values: any[])=>void;

// The engine behind `TStypeCheck`, also reused by `TStoDecl` (with `report` off) for its scope resolution and expression-type synthesis.
// `mute` suppresses diagnostics while typing speculatively (lazy return-type inference re-walks bodies the reporting pass also visits).
export function makeChecker(diag: Diagnostics) {
	let muted = 0;
	// Set by `checkFunctionBody` while walking a generator body; `case 'yield'` pushes each yielded type here,
	// same as `returns` does for `return` statements, so an undeclared generator's return infers as `Generator<Y>`.
	let yieldCollector: Type[] | undefined;

	const makeErr = (sev: SEVERITY) => (pos: JS.Location) => (strings: TemplateStringsArray, ...values: any[]) => {
		if (!muted)
			diag(sev, pos, strings, ...values);
	};

	const gap		= makeErr(SEVERITY.GAP);
	const warning	= makeErr(SEVERITY.WARNING);
	const error		= makeErr(SEVERITY.ERROR);

	const runMuted	= <T,>(fn: () => T): T => {
		try {
			++muted;
			return fn();
		} finally {
			--muted;
		}
	};

	// Tries `T.isAssignable` strict then lax; a GAP means strict failed only due to an opaque type (keyof/conditional/infer/mapped).
	// Every real assignability check should go through this, not `T.isAssignable` directly. `dstScope` resolves `dst`'s own structure.
	const checkAssignable = (src: Type, dst: Type, scope: Scope, pos: JS.Location, dstScope: Scope = scope): boolean => {
		if (T.isAssignable(src, dst, scope, dstScope, true))
			return true;
		const lax = T.isAssignable(src, dst, scope, dstScope, false);
		if (lax)
			gap(pos)`Assignability of '${src}' to '${dst}' could not be fully verified ('keyof'/conditional/'infer'/mapped types aren't evaluated)`;
		return lax;
	};

	// ---- control-flow narrowing -----------------------------------------------------------------


	// Refines `name`'s binding to the members `keep` accepts (`name` may be a dotted path key). `keep` returns `true` (keep),
	// `false` (exclude), or a `Type` (replace with a narrower version) -- the last splits a compound member (see `narrowByDiscriminant`).
	const narrowValue = (scope: Scope, name: string, keep: (m: Type) => boolean | Type, t = scope.value(name)): Scope => {
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
	};


	// Narrows `m` by a discriminant-property equality test, recursing into `m`'s structure to split a compound member down
	// to its matching sub-variant(s) rather than keep/discard it whole. Return contract matches `Scope.narrowValue`'s `keep`.
	const narrowByDiscriminant = (m: Type, prop: string, scope: Scope, keepMatch: boolean, target: unknown, depth = 6): boolean | Type => {
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
	};
	

	// Narrows `name` to `target`: union members are filtered by assignability; a non-union binding (or any binding, for an opaque `any` target)
	// is replaced outright when the guard holds. `name` may be a dotted path key.
	const narrowTo = (scope: Scope, name: string, target: Type, sense: boolean, t = scope.value(name)): Scope => {
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
	};
	
	// Returns a scope refined by `test` holding (sense=true) or failing (sense=false). Covers truthiness, `!`, `&&`/`||`, typeof, null/undefined
	// comparisons, discriminant-property comparisons, instanceof, `in`, and user-defined type predicates.
	const narrow = (test: Expr, scope: Scope, sense: boolean): Scope => {
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
									return m.type === 'ref' && m.name === 'boolean' && typeof r.value === 'boolean'
										? Literal(keepMatch ? r.value : !r.value)
										: true;
								});
							// x.prop === literal (discriminated union): `narrowByDiscriminant` splits a compound member to its matching
							// sub-variant(s) instead of keeping/discarding it whole; `l.object` may itself be a dotted path.
							if (l.type === 'member' && r.type === 'literal') {
								const s = narrowKey(l.object, m => narrowByDiscriminant(m, l.property, scope, keepMatch, r.value));
								if (s)
									return s;
							}
						}
	
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
		return runMuted(() => recurse(test, scope, sense));
	};

	// TS 5.5+ "inferred type predicates": a function whose single return path is itself a type guard (`x => x != null`) gets an inferred `x is T`
	// return, by asking `narrow()` what it'd do with that expression. Only an expression body or single-`return` block is supported.
	const inferredPredicate = (fn: TS.CallSig, body: JS.Statement<any>[] | Expr, scope: Scope): Type | undefined => {
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
	};


	// A fresh object literal assigned to a fully-known object type may not introduce unknown keys
	const checkExcessProps = (lit: Expr, target: Type, scope: Scope, pos: JS.Location, targetScope: Scope = scope) => {
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
				error(pos)` Object literal may only specify known properties, and '${p.key}' does not exist in type '${target}'`;
	};

	// ---- declaration hoisting / namespace resolution ------------------------------------------

	const hoist = (stmts: TS.Statement[], scope: Scope) => {
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
					const { instance, value } = T.classShapes(stmt as TS.Class, scope);
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
							runMuted(() => checkFunctionBody(t, d.body, scope, hasMod(d, 'async')));
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
	};

	const hoistVar = (scope: Scope, d: JS.VarDeclarator<Type>, widen: boolean, typeAnnotation = d.typeAnnotation) => {
		if (typeof d.name === 'string') {
			const init = d.init && !typeAnnotation ? typeOf(d.init, scope) : undefined;
			// A bare (no-typeArgs) ref's own `declScope` wins over the ambient `scope` here -- this bakes the result in once rather than
			// re-resolving lazily, so it must resolve in the declaring module now, before a generic ref's own type args get lost.
			scope.addValue(d.name, typeAnnotation?.type === 'ref' && !typeAnnotation.typeArgs && typeAnnotation.declScope
				? T.resolve(typeAnnotation.declScope as Scope, typeAnnotation)
				: typeAnnotation ? T.resolve(scope, typeAnnotation) : init ? (widen ? T.widenLiterals(init) : init) : T.ANY);
			// TS 4.4 aliased conditions: a `const`'s initializer stays true for its whole lifetime, so narrowing the const
			// also narrows through what its initializer itself would narrow (`narrow()`'s `case 'identifier'` reads this).
			if (!widen && d.init)
				scope.addAlias(d);
		} else {
			T.bindingNames(d.name).forEach(n => scope.addValue(n, T.ANY));
		}
	};

	// Resolves what a `namespace X { ... }` block or module body exposes, as a genuine `Scope` (not a flattened `Type`) since `NS.Foo` can appear
	// in a type position too. `isAlias` marks `export = X` (`.d.ts`-only), where the whole namespace collapses to `X`'s own value.
	const exportScope = (body: TS.Statement[], parent: Scope): { scope: Scope; value: Type; isAlias: boolean } => runMuted(() => {
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
	});


	// ---- lazy return-type inference -------------------------------------------------------------

	// Instantiates `sig` against `argTs`, substituting type params through params/return type. Pure -- doesn't validate (see `argsFit`).
	// `restElementTs`: a spread argument's element type(s), since `argTs` leaves a spread position `undefined` (arity unknown statically).
	const instantiate = (sig: TS.CallSig, argTs: (Type | undefined)[], typeArgs: Type[] | undefined, scope: Scope, pos: JS.Location, restElementTs?: Type[], expected?: Type): TS.CallSig => {
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
						if (!p.default && params.some((prm, i) => argTs[i] && prm.typeAnnotation && T.mentionsTypeParam(prm.typeAnnotation, p.name)))
							gap(pos)`Type parameter '${p.name}' could not be inferred from the arguments; assumed '${map.get(p.name)}'`;
					}
				});
			}
			params		= params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteType(p.typeAnnotation, map) } : p);
			returnType	= T.substituteType(returnType, map);
		}
		// `declScope` travels with the result -- e.g. into `argsFit`, which only ever sees this instantiated object, never `sig` itself.
		return { params, rest: sig.rest, returnType, declScope: sig.declScope };
	};

	// ---- expressions ----------------------------------------------------------------------------

	// `expected`: the contextual type this expression is checked against, when known -- lets a generic call whose type params aren't
	// determined by its arguments (`new Promise<T>(...)`) infer them from where the result is going, like TS's own contextual typing.
	const typeOf = (e: Expr, scope: Scope, widen = true, expected?: Type): Type => {
		const maybeWidenLiterals = widen ? T.widenLiterals : (t: Type) => t;
		const pos = (e as any).pos;
		switch (e.type) {
			case 'literal':
				if (Array.isArray(e.value)) {
					e.value.forEach(p => p.exp && typeOf(p.exp, scope));
					return T.STRING;
				}
				switch (typeof e.value) {
					case 'string':
					case 'number':
					case 'boolean':	return Literal(e.value);
					case 'bigint':	return T.BIGINT;
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
							const t = T.resolveOwn(typeOf(el.operand, scope), scope);
							elems.push(t.type === 'array' ? t.element : T.ANY);
						} else {
							elems.push(maybeWidenLiterals(typeOf(el, scope)));
						}
					}
				}
				return TS.ArrayType(elems.length ? T.combineTypes(elems) : T.ANY);
			}
			case 'object': {
				const members: TS.TypeMember[] = [];
				for (const p of e.properties) {
					if (p.type === 'spread') {
						typeOf(p.operand, scope);
						return T.ANY;		// spread makes the shape unknowable here
					}
					// A `satisfies`/annotated-`var_decl` `expected` type propagates member-by-member: an unannotated arrow/method
					// value (`{read: (pe, data) => ...}`) otherwise types its own params as `any`, same gap `applyContextualParams`
					// already closes for call arguments.
					const expectedMember = expected && typeof p.key === 'string' ? T.lookupMember(expected, p.key, scope) : undefined;
					switch (p.type) {
						case 'method':
							applyContextualParams(p.params, expectedMember, scope);
							checkFunctionBody(p, p.body, scope, hasMod(p, 'async'), false, false);
							if (typeof p.key === 'string')
								members.push(TS.TypeMethod(p.key, T.FixSig(p, T.ANY)));
							break;
						case 'generator':
							applyContextualParams(p.params, expectedMember, scope);
							checkFunctionBody(p, p.body, scope, hasMod(p, 'async'), true, true);
							if (typeof p.key === 'string')
								members.push(TS.TypeMethod(p.key, T.FixSig(p, T.ANY)));
							break;
						case 'get':
							checkFunctionBody(p, p.body, scope, false, false, false);
							members.push(TS.TypeProperty(p.key, p.returnType as Type ?? T.ANY));
							break;
						case 'set':
							checkFunctionBody(p, p.body, scope, false, false, false);
							break;
						case 'field': {
							const _t = typeOf(p.value!, scope, true, expectedMember);
							if (typeof p.key === 'string')
								members.push(TS.TypeProperty(p.key, maybeWidenLiterals(_t)));
							break;
						}
					}
				}
				return TS.ObjectType(members);
			}

			case 'function': {
				applyContextualParams(e.params, expected, scope);
				checkFunctionBody(e, e.body, scope, hasMod(e, 'async'), hasMod(e, 'generator'), hasMod(e, 'generator'));
				return TS.FunctionType(T.FixSig(e, T.ANY, e.returnType as Type | undefined));
			}

			case 'arrow': {
				applyContextualParams(e.params, expected, scope);
				checkFunctionBody(e, e.body, scope, hasMod(e, 'async'), false, false);
				return TS.FunctionType(T.FixSig(e, T.ANY, e.returnType as Type | undefined));
			}

			case 'member': {
				const key		= T.pathKey(e);
				const refined	= key && scope.value(key);	// dotted keys live only in narrowings
				if (refined)
					return refined;
				const objT	= typeOf(e.object, scope);
				const t		= T.lookupMember(objT, e.property, scope);
				if (!muted && !t && !e.optional && T.sealed(objT, scope))
					error(pos)`Property '${e.property}' does not exist on type '${objT}'`;
				if (!t)
					return T.ANY;
				// `lookupMember` returns an optional property's type unwidened (callers needing "is this optional" use `memberOptional`);
				// a plain read here must still see the `| undefined` an optional field or `?.` actually allows.
				return (e.optional || T.memberOptional(objT, e.property, scope)) ? T.combineTypes([t, T.UNDEFINED]) : t;
			}
			case 'index': {
				const objT = T.resolve(scope, typeOf(e.object, scope));
				typeOf(e.property, scope);
				if (objT.type === 'array')
					return objT.element;
				if (objT.type === 'tuple' && T.isLiteral(e.property, 'number')) {
					const el = objT.elements[e.property.value];
					if (!muted && !el)
						error(pos)`Tuple type '${objT}' has no element at index ${e.property.value}`;
					return (el && T.tupleElementType(el)) ?? T.ANY;
				}
				if (T.isLiteral(e.property, 'string')) {
					const t = T.lookupMember(objT, e.property.value, scope);
					if (!muted && !t && T.sealed(objT, scope))
						error(pos)`Property '${e.property.value}' does not exist on type '${objT}'`;
					if (!t)
						return T.ANY;
					return T.memberOptional(objT, e.property.value, scope) ? T.combineTypes([t, T.UNDEFINED]) : t;
				}
				return T.ANY;
			}

			case 'call':
			case 'new': {
				const calleeT	= T.resolveOwn(typeOf(e.callee, scope), scope);
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
									resolvedTypes.push(arg && arg.type !== 'spread' ? typeOf(arg, scope) : T.UNDEFINED);
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
						if (!muted)
							error(pos)`Type '${calleeT}' is not callable in '${e}'`;
						return T.ANY;
					}
				}

				// Overload resolution: first arity+type fit wins, computed without contextual param typing (which signature to type a
				// callback's params from isn't known yet). No fit stays lenient rather than guessing -- tried that, caused false positives.
				if (overloads) {
					const hasSpread = e.arguments.some(a => a.type === 'spread');
					sig = runMuted(() => {
						const trialArgTs = e.arguments.map(a => a.type === 'spread' ? undefined : typeOf(a, scope));
						return overloads!.find(c => T.argsFit(instantiate(c, trialArgTs, typeArgs, scope, pos), trialArgTs, scope, hasSpread));
					});
				}
				if (overloads && !sig)
					warning(pos)`No overload of '${e.callee}' matches this call; arguments left unchecked`;

				// Contextual parameter typing: an unannotated callback argument (`arr.map(x => x.foo)`) would otherwise type its own params as `any`.
				// Fills them in here from the matching declared (pre-substitution) param type -- mutates the AST node; must run before `argTs` below, which triggers `checkFunctionBody` on each argument.
				if (sig) {
					const declScope	= T.declScopeOf(sig, scope);

					// First pass, non-callback arguments only (reused below in `argTs`, so nothing gets double-typed/reported): infers a type
					// param from a sibling argument (`arr.reduce((acc, x) => ..., seed)`'s `U` from `seed`) before typing the callback itself.
					const preArgTs = e.arguments.map(a => a.type === 'function' || a.type === 'arrow' || a.type === 'spread' ? undefined : typeOf(a, scope));
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
						if (a.type !== 'function' && a.type !== 'arrow')
							return;
						const declared		= sig.params[i]?.typeAnnotation;
						const substituted	= declared && preMap?.size ? T.substituteType(declared, preMap) : declared;
						applyContextualParams(a.params, substituted, scope);
					});

					const restElementTs: Type[] = [];
					const argTs = e.arguments.map((a, i) => {
						if (a.type === 'function' || a.type === 'arrow')
							return typeOf(a, scope);
						if (a.type !== 'spread')
							return preArgTs[i];
						const t		= T.resolveOwn(typeOf(a.operand, scope), scope);
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

					const { params, returnType } = instantiate(sig, argTs, typeArgs, scope, pos, restElementTs, expected);
					if (!muted && !argTs.some(t => t === undefined)) {	// no spread args
						const required	= params.filter(p => !hasMod(p, 'optional')).length;
						const max		= sig.rest ? Infinity : params.length;
						if (argTs.length < required || argTs.length > max)
							error(pos)`Expected ${required === max ? required : required + '-' + (max === Infinity ? 'more' : max)} arguments, but got ${argTs.length} in '${e}'`;
						argTs.forEach((t, i) => {
							const p = params[i];
							if (t && p && p.typeAnnotation) {
								// an optional parameter also accepts undefined
								if (!checkAssignable(t, hasMod(p, 'optional') ? TS.UnionType([p.typeAnnotation, T.UNDEFINED]) : p.typeAnnotation, scope, pos, declScope))
									error(pos)`Argument of type '${t}' is not assignable to parameter '${p.key}: ${p.typeAnnotation}' in '${e}'`;
								else
									checkExcessProps(e.arguments[i], p.typeAnnotation, scope, pos, declScope);
							}
						});
					}
					// A predicate return is only special to `narrow()`'s dedicated `case 'call'`; as a plain value it's `boolean` (or `void`
					// if asserting) -- without this, the raw predicate type would leak into whatever consumes this expression next.
					return returnType && returnType.type === 'predicate' ? (returnType.asserts ? T.VOID : T.BOOLEAN) : returnType!;
				}
				return e.type === 'new' && e.callee.type === 'identifier' ? TS.RefType(e.callee.name, typeArgs) : T.ANY;
			}

			// `expr<T,U>` (TS 4.7+): pins a generic function/constructor's type params without calling it. An overloaded callee keeps every
			// arity-compatible signature instantiated (still overloaded); anything else stays `ANY`, same leniency as an uncallable `case 'call'`.
			case 'instantiation': {
				const calleeT	= T.resolveOwn(typeOf(e.expression, scope), scope);
				// Same reasoning as the 'call'/'new' case above -- these type args are raw AST, never stamped.
				const typeArgs	= (e.typeArgs as Type[] | undefined)?.map(t => T.stampScope(t, scope));
				const fnPart	= (calleeT.type === 'intersection' ? calleeT.types.map(p => T.resolveOwn(p, scope)) : [calleeT])
					.find(p => p.type === 'function' || p.type === 'constructor');
				if (fnPart)
					return { type: fnPart.type, ...instantiate(fnPart, [], typeArgs, scope, pos) };
				if (calleeT.type === 'object') {
					const calls = calleeT.members.filter(m => m.type === 'call' || m.type === 'construct');
					if (calls.length)
						return TS.ObjectType(calls.map(m => TS.TypeMember(m.type, instantiate(m, [], typeArgs, scope, pos))));
				}
				return T.ANY;
			}

			case 'unary': {
				const argT = typeOf(e.operand, scope);
				switch (e.operator) {
					case '!':		return T.BOOLEAN;
					case 'typeof':	return T.STRING;
					case 'void':	return T.UNDEFINED;
					case 'delete':	return T.BOOLEAN;
					case '-':
					case '+':
					case '~':		return T.isAny(T.resolveOwn(argT, scope)) ? T.ANY : T.isBigint(argT, scope) ? T.BIGINT : T.NUMBER;
					case '++':
					case '--':
						if (!muted && !T.isNumberLike(argT, scope))
							error(pos)`Operand of '${e.operator}' must be numeric, got '${argT}' in '${e}'`;
						return T.isAny(T.resolveOwn(argT, scope)) ? T.ANY : T.isBigint(argT, scope) ? T.BIGINT : T.NUMBER;
					case 'await':	return T.awaitType(argT, scope);
					default:		return argT;
				}
			}
			case 'unary_post': {
				const argT = typeOf(e.operand, scope);
				if (e.operator === '!') {
					const t = T.resolveOwn(argT, scope);
					if (t.type === 'union') {
						const parts = t.types.filter(x => !T.isNullish(x, scope));
						return parts.length ? T.combineTypes(parts) : t;
					}
					return T.isNullish(t, scope) ? T.NEVER : t;
				}
				if (!muted && !T.isNumberLike(argT, scope))
					error(pos)`Operand of '${e.operator}' must be numeric, got '${argT}' in '${e}'`;
				return T.isAny(T.resolveOwn(argT, scope)) ? T.ANY : T.isBigint(argT, scope) ? T.BIGINT : T.NUMBER;
			}

			case 'binary': {
				let lt = typeOf(e.left, scope);

				if (LOGICAL_OPS.has(e.operator)) {
					const rt	= typeOf(e.right, e.operator === '&&' ? narrow(e.left, scope, true) : e.operator === '||' ? narrow(e.left, scope, false) : scope);
					const r		= T.resolveOwn(widen ? T.widenLiterals(lt, true) : lt, scope);
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
						widen ? T.widenLiterals(rt, true) : rt,
					]);
				}
				const rt = typeOf(e.right, scope);
				if (COMPARISON_OPS.has(e.operator))
					return T.BOOLEAN;

				if (e.operator.endsWith('=')) {
					// Assignments are judged against the declaration-site type, not any active narrowing -- a dotted target goes through
					// `lookupMember` on the object's own type, not `typeOf` (which would consult the narrowings map instead).
					if (!muted) {
						if (e.left.type === 'identifier') {
							lt = scope.declared(e.left.name) || lt;
						} else if (e.left.type === 'member') {
							const objT = typeOf(e.left.object, scope);
							lt = T.lookupMember(objT, e.left.property, scope) || lt;
							lt = T.memberOptional(objT, e.left.property, scope) ? T.combineTypes([lt, T.UNDEFINED]) : lt;
						}

						if (e.operator === '=') {
							if (!checkAssignable(rt, lt, scope, pos)) {
								error(pos)`Type '${rt}' is not assignable to type '${lt}' in '${e.left} = ...'`;
							} else {
								checkExcessProps(e.right, lt, scope, pos);
								// Later statements see the assigned type, not the wider declared one. `pathKey`, not just an identifier: a
								// dotted target narrows the same way a bare name does, via the same narrowings map.
								const key = T.pathKey(e.left);
								if (key)
									scope.addNarrowing(key, maybeWidenLiterals(rt));
							}
						} else if (e.operator === '??=' || e.operator === '||=' || e.operator === '&&=') {
							const key = T.pathKey(e.left);
							if (key) {
								// `x ??= y` leaves x holding its non-nullish members or y (and likewise for ||= / &&=)
								const r		= T.resolveOwn(lt, scope);
								const other = T.isOther(e.operator[0]);

								scope.addNarrowing(key, T.combineTypes([
									...(r.type === 'union' ? r.types : [r]).filter(m => !other(T.resolveOwn(m, scope), scope)),
									maybeWidenLiterals(rt),
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
				if (!muted) {
					if (!T.isNumberLike(lt, scope))
						error(pos)`Operand of '${e.operator}' must be numeric, got '${lt}' in '${e.left}'`;
					if (!T.isNumberLike(rt, scope))
						error(pos)`Operand of '${e.operator}' must be numeric, got '${rt}' in '${e.right}'`;
				}
				return	T.isAny(T.resolveOwn(lt, scope)) || T.isAny(T.resolveOwn(rt, scope))	? T.ANY
					:	T.isBigint(lt, scope) || T.isBigint(rt, scope)				? T.BIGINT
					:	T.NUMBER;
			}

			case 'conditional':
				typeOf(e.test, scope);
				return T.combineTypes([typeOf(e.consequent, narrow(e.test, scope, true), widen, expected), typeOf(e.alternate, narrow(e.test, scope, false), widen, expected)]);

			case 'sequence':
				return e.expressions.map(x => typeOf(x, scope)).pop() ?? T.ANY;

			case 'spread':
				return typeOf(e.operand, scope);

			case 'tagged_template': {
				const t = T.resolveOwn(typeOf(e.tag, scope), scope);
				e.quasi.forEach(p => p.exp && typeOf(p.exp, scope));
				return t.type === 'function' ? t.returnType ?? T.ANY : T.ANY;
			}
			case 'yield': {
				const argT = e.operand ? typeOf(e.operand, scope) : T.VOID;
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
				const { instance, value } = T.classShapes(e2, scope);
				checkClassMembers(e.name, e2.body, instance, value, scope);
				return value;
			}
			case 'as': {
				const anno = e.typeAnnotation as Type;
				return anno.type === 'ref' && anno.name === 'const' ? typeOf(e.expression, scope, false) : anno;
			}
			case 'satisfies': {
				const anno = e.typeAnnotation as Type;
				const t = typeOf(e.expression, scope, widen, anno);
				if (!muted) {
					if (!checkAssignable(t, anno, scope, pos))
						error(pos)`Type '${t}' does not satisfy the expected type '${anno}'`;
					else
						checkExcessProps(e.expression, anno, scope, pos);
				}
				return t;
			}
			default:
				return T.ANY;
		}
	};

	// ---- functions / classes / statements -------------------------------------------------------

	const checkFunctionBody = (fnj: JS.CallSig<any>, body: JS.Statement<any>[] | Expr | undefined, scope: Scope, async: boolean, skipReturn?: boolean, generator?: boolean) => {
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
		if (expected && muted)
			return;

		const inner = new Scope(scope);
		for (const p of fn.params) {
			const anno = p.typeAnnotation;
			if (!muted && p.default) {
				const dt = typeOf(p.default, inner);
				if (anno && !checkAssignable(dt, anno, inner, (p as any).pos))
					error((p as any).pos)`Default value of type '${dt}' is not assignable to parameter type '${anno}'`;
			}
			if (typeof p.key === 'string')
				inner.addValue(p.key, anno ? (hasMod(p, 'optional') && !p.default ? T.combineTypes([anno, T.UNDEFINED]) : anno) : T.literalTypeOf(p.default) ?? T.ANY);
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
						const t = typeOf(argument, scope, false, expected);
						if (!checkAssignable(T.unwrapIfAsync(t, scope, async), expected, scope, (argument as any).pos))
							error((argument as any).pos)`Type '${t}' is not assignable to declared return type '${expected}'`;
						else
							checkExcessProps(argument, expected, scope, (argument as any).pos);
					}
				});
			} else {
				const	returns: Type[] = [];
				let		yields: Type[] | undefined;
				const	_outer = yieldCollector;
				yieldCollector = generator ? [] : undefined;
				try {
					checkBlock(body, inner, (argument: Expr|undefined, scope: Scope): void => {
						returns.push(argument ? T.widenLiterals(typeOf(argument, scope)) : T.VOID);
					});
				} finally {
					yields = yieldCollector;
					yieldCollector	= _outer;
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
			const t = typeOf(body, inner, true, expected);
			if (expected) {
				if (!checkAssignable(T.unwrapIfAsync(t, inner, async), expected, inner, (body as any).pos))
					error((body as any).pos)`Type '${t}' is not assignable to declared return type '${expected}'`;
			} else if (!isPredicate) {
				const widened = T.widenLiterals(t);
				fn.returnType = T.wrapReturnIfAsync((T.isBoolean(widened) && inferredPredicate(fn, body, inner)) || widened, inner, async);
			}
		}
	};

	const checkClassMembers = (name: string | undefined, body: TS.ClassMember[], instance: Type, classValue: Type, scope: Scope) => {
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
						const t = typeOf(m.value, inner);
						if (m.typeAnnotation && !checkAssignable(t, m.typeAnnotation, inner, (m as any).pos))
							error((m as any).pos)`Type '${t}' is not assignable to type '${m.typeAnnotation}'`;
						else if (m.typeAnnotation)
							checkExcessProps(m.value, m.typeAnnotation, inner, (m as any).pos);
					}
					break;
				case 'method':
					checkFunctionBody(m, m.body, inner, hasMod(m, 'async'), m.key === 'constructor', false);
					break;
				case 'generator':
					checkFunctionBody(m, m.body, inner, hasMod(m, 'async'), true, true);
					break;
				case 'get':
					checkFunctionBody(m, m.body, inner, false, false, false);
					break;
				case 'set':
					checkFunctionBody(m, m.body, inner, false, true, false);
					break;
				case 'static_block':
					checkBlock(m.body, new Scope(inner));
					break;
			}
		}
	};

	// Every leaf of an if/else chain (or a block's final statement) assigns the same variable:
	// yields the assigned expressions so the post-if type can merge the branches
	const assignRights = (st: TS.Statement, name?: string): { name: string; rights: Expr[] } | undefined => {
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
	};

	const checkBlock = (stmts: TS.Statement[], scope: Scope, onReturn?: (argument: Expr|undefined, scope: Scope)=>void) => {
		hoist(stmts, scope);
		for (const s of stmts) {
			checkStmt(s, scope, onReturn);

			if (s.type === 'if') {
				if (!s.alternate && alwaysExits(s.consequent)) {
					// guard clause (`if (!ok) return;`): the rest of the block sees the negated narrowing
					scope = narrow(s.test, scope, false);
				} else {
					// `if (x === undefined) x = e;` and full if/else chains assigning x:
					// afterwards x holds one branch's value or another's
					const a = s.alternate ? assignRights(s) : assignRights(s.consequent);
					if (a) {
						runMuted(() => {
							const parts = a.rights.map(r => T.widenLiterals(typeOf(r, scope)));
							if (!s.alternate) {
								const other = narrow(s.test, scope, false).value(a.name);
								if (other)
									parts.push(other);
							}
							scope = new Scope(scope);
							scope.addNarrowing(a.name, T.combineTypes(parts));
						});
					}
				}
			}
		}
	};


	const checkStmt = (stmt: TS.Statement, scope: Scope, onReturn?: (argument: Expr|undefined, scope: Scope)=>void): void => {
		switch (stmt.type) {
			case 'var_decl':
				if (!muted) {
					const pos = (stmt as any).pos;
					for (const d of stmt.declarations) {
						if (d.typeAnnotation && d.init) {
							const anno = d.typeAnnotation as Type;
							const init = typeOf(d.init, scope, true, anno);
							if (!init)
								checkExcessProps(d.init, anno, scope, pos);
							else if (!checkAssignable(init, anno, scope, pos))
								error(pos)`Type '${init}' is not assignable to type '${anno}' in declaration of '${d.name}'`;
						}
						hoistVar(scope, d, stmt.kind !== 'const');
					}
				}
				break;
			case 'expression':
				typeOf(stmt.expression, scope);
				break;
			case 'block':
				checkBlock(stmt.body, new Scope(scope), onReturn);
				break;
			case 'if':
				typeOf(stmt.test, scope);
				checkStmt(stmt.consequent, new Scope(narrow(stmt.test, scope, true)), onReturn);
				if (stmt.alternate)
					checkStmt(stmt.alternate, new Scope(narrow(stmt.test, scope, false)), onReturn);
				break;
			case 'while':
			case 'do_while':
				typeOf(stmt.test, scope);
				checkStmt(stmt.body, new Scope(stmt.type === 'while' ? narrow(stmt.test, scope, true) : scope), onReturn);
				break;
			case 'for': {
				const inner = new Scope(scope);
				if (stmt.kind === 'normal') {
					if (stmt.init) {
						if (stmt.init.type === 'var_decl')
							checkStmt(stmt.init, inner);
						else
							typeOf(stmt.init, inner);
					}
					if (stmt.test)
						typeOf(stmt.test, inner);
					if (stmt.update)
						typeOf(stmt.update, inner);
					checkStmt(stmt.body, stmt.test ? narrow(stmt.test, inner, true) : inner, onReturn);
				} else {
					const rightT = T.resolveOwn(typeOf(stmt.right, inner), inner);
					const elemT = stmt.kind === 'in' ? T.STRING
						: rightT.type === 'array' ? rightT.element
						: T.isString(rightT) ? T.STRING
						: T.ANY;
					if (stmt.init.type === 'var_decl') {
						for (const d of stmt.init.declarations)
							hoistVar(inner, d, true, (d.typeAnnotation as Type) ?? elemT);
					} else {
						typeOf(stmt.init, inner);
					}
					checkStmt(stmt.body, inner, onReturn);
				}
				break;
			}
			case 'return':
				onReturn?.(stmt.argument, scope);
				break;
			case 'switch': {
				typeOf(stmt.discriminant, scope);
				// A `case` with no body falls through to the next -- reuse `if`'s discriminated-union narrowing by synthesizing that binary
				// test per case, OR-ing fallthrough cases together. A bare `default` needs "none of the others" narrowing, unmodeled -- body stays unnarrowed.
				let pending: Expr[] = [];
				for (const c of stmt.cases) {
					if (c.test) {
						typeOf(c.test, scope);
						pending.push({ type: 'binary', operator: '===', left: stmt.discriminant, right: c.test });
					}
					if (c.consequent.length || !c.test) {
						const test = pending.reduce<Expr | undefined>((acc, t) => acc ? { type: 'binary', operator: '||', left: acc, right: t } : t, undefined);
						checkBlock(c.consequent, new Scope(test ? narrow(test, scope, true) : scope), onReturn);
						pending = [];
					}
				}
				break;
			}
			case 'throw':
			case 'with':
				typeOf(stmt.argument, scope);
				if (stmt.type === 'with')
					checkStmt(stmt.body, scope, onReturn);
				break;
			case 'try':
				checkBlock(stmt.block, new Scope(scope), onReturn);
				if (stmt.handlerBody) {
					const inner = new Scope(scope);
					if (stmt.handlerParam)
						inner.addValue(stmt.handlerParam, T.ANY);
					checkBlock(stmt.handlerBody, inner, onReturn);
				}
				if (stmt.finalizer)
					checkBlock(stmt.finalizer, new Scope(scope), onReturn);
				break;
			case 'labeled':
				checkStmt(stmt.body, scope, onReturn);
				break;
			case 'function_decl':
				if (stmt.body)
					checkFunctionBody(stmt, stmt.body, scope, hasMod(stmt, 'async'), hasMod(stmt, 'generator'), hasMod(stmt, 'generator'));
				break;
			case 'class_decl': {
				const c = stmt as TS.Class;
				const { instance, value } = T.classShapes(c, scope);
				checkClassMembers(stmt.name, c.body, instance, value, scope);
				break;
			}
			case 'export_decl':
				checkStmt(stmt.declaration, scope, onReturn);
				break;
			case 'export':
				if (stmt.default) {
					if (isTsDeclaration(stmt.default))
						checkStmt(stmt.default, scope, onReturn);
					else
						typeOf(stmt.default, scope);
				}
				break;
			case 'namespace_decl':
				checkBlock(stmt.body, new Scope(scope));
				break;

			// type_alias_decl / interface_decl / enum_decl / import / export /
			// empty / debugger / continue / break: declaration-only or nothing to check (hoist saw them)
		}
	};

	return {
		typeOf, exportScope,

		checkBlock: (stmts: TS.Statement[], scope: Scope, muted = false) => {
			return muted ? runMuted(()=>checkBlock(stmts, scope)) : checkBlock(stmts, scope);
		},

		inferReturn: (fnj: JS.CallSig<any>, body: JS.Statement<any>[], outer: Scope): Type => {
			if (fnj.returnType)
				return fnj.returnType as Type;
			const sig = { ...fnj } as TS.CallSig;
			runMuted(() => checkFunctionBody(sig, body, outer, false));
			return sig.returnType ?? T.VOID;
		}
	};
}
