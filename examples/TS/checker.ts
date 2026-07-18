/* eslint-disable @typescript-eslint/no-unused-expressions */
import * as TS from './ts-parser';
import * as JS from './js-parser';
import { hasMod, isTsDeclaration } from './walker';
import * as T from './type-utils';

type Type = TS.Type;
type Expr = JS.Expr;
type Scope = T.Scope;
const Scope = T.Scope;

// ===================================================================
//  TStypeCheck -- structural type checking of a parsed TS AST
// ===================================================================
//
// Resolves the program's own declarations into structural types, synthesizes a type for every expression, and reports assignability violations.
// Deliberately partial; every gap errs lenient (no diagnostic) rather than risking a false positive. Keep this list current.
//
// Missing / deliberately lenient (most now also surfaced as a `SEVERITY.GAP` diagnostic where the code actually
// hits the gap, not just silently accepted -- see `gap`/`checkAssignable` below):
//  - generic inference: structural argument-matching only -- no bidirectional/contravariant or `this`/contextual inference (largest gap source)
//  - narrowing: identifiers/dotted paths only, no CFG, no reassignment invalidation
//  - overload resolution only fires when exactly one candidate's arity/argument types fit¹
//  - keyof/mapped/indexed-access: resolved only for literal keys;
//  - conditional: resolved only when non-distributive and concrete (no `infer`)
//
// ¹ No candidate fitting stays fully lenient rather than diagnosing against a "best guess" -- tried the
//   guess, reverted it: it turned pre-existing generic-inference imprecision (bullet above) into false
//   positives wherever a heavily-generic overloaded builder (e.g. this project's own grammar-rule helpers)
//   gets called with arguments this checker can't infer precisely enough to match any candidate.


const COMPARISON_OPS 	= new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>=', 'in', 'instanceof']);
const LOGICAL_OPS		= new Set(['&&', '||', '??']);

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
	// Set by `checkFunctionBody` while walking a generator's body; `case 'yield'` (in `typeOf`) pushes each
	// yielded expression's type here so an undeclared generator's return type can be inferred as `Generator<Y>`,
	// the same way `returns` accumulates `return` statements for an ordinary function.
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

	const silentType = (e: Expr, scope: Scope): Type => runMuted(() => typeOf(e, scope));

	// `T.isAssignable`, tried strict then lax: a GAP means strict failed only because an opaque type (keyof/conditional/`infer`/mapped) was involved.
	// Every real (diagnostic-producing) assignability check in this file should go through this, not `T.isAssignable` directly. `dstScope` resolves
	// `dst`'s own structure (e.g. a parameter type declared by another module's signature) -- defaults to `scope` when `dst` is locally declared.
	const checkAssignable = (src: Type, dst: Type, scope: Scope, pos: JS.Location, dstScope: Scope = scope): boolean => {
		if (T.isAssignable(src, dst, scope, dstScope, true))
			return true;
		const lax = T.isAssignable(src, dst, scope, dstScope, false);
		if (lax)
			gap(pos)`Assignability of '${src}' to '${dst}' could not be fully verified ('keyof'/conditional/'infer'/mapped types aren't evaluated)`;
		return lax;
	};

	// ---- control-flow narrowing -----------------------------------------------------------------

	// Returns a scope refined by `test` holding (sense=true) or failing (sense=false). Covers truthiness, `!`, `&&`/`||`, typeof, null/undefined
	// comparisons, discriminant-property comparisons, instanceof, `in`, and user-defined type predicates.
	const aliasing = new Set<string>();
	const narrow = (test: Expr, scope: Scope, sense: boolean): Scope => {
		switch (test.type) {
			case 'unary':
				return test.operator === '!' ? narrow(test.argument, scope, !sense) : scope;
			case 'unary_post'://only for '!'?
				return narrow(test.argument, scope, sense);
			case 'identifier': {
				const s = scope.narrowValue(test.name, m => sense ? !T.isFalsy(m, scope) : !T.isTruthy(m, scope));
				const alias = aliasing.has(test.name) ? undefined : scope.alias(test.name);
				if (!alias)
					return s;
				aliasing.add(test.name);
				try {
					return narrow(alias, s, sense);
				} finally {
					aliasing.delete(test.name);
				}
			}
			// Truthiness-narrows a dotted property path (`if (icon.color)`), keyed by the whole path -- no alias-following, since `scope.alias`
			// only tracks plain-identifier `const` initializers, not member chains.
			case 'member': {
				const key = T.pathKey(test);
				return key ? scope.narrowValue(key, m => sense ? !T.isFalsy(m, scope) : !T.isTruthy(m, scope), scope.value(key) ?? silentType(test, scope)) : scope;
			}
			case 'binary': {
				// `if ((x = e))` narrows x by truthiness
				if (test.operator === '=' && test.left.type === 'identifier')
					return scope.narrowValue(test.left.name, m => sense ? !T.isFalsy(m, scope) : !T.isTruthy(m, scope));

				// `a && b`'s true branch / `a || b`'s false branch: both conjuncts hold (or both fail),
				// so each narrowing applies on top of the other -- sequential/conjunctive narrowing.
				if ((test.operator === '&&' && sense) || (test.operator === '||' && !sense))
					return narrow(test.right, narrow(test.left, scope, sense), sense);
				// `a || b`'s true branch: only *one* disjunct is known to hold, but a variable BOTH sides narrow (`typeof icon === 'string' ||
				// icon instanceof Uri`) can be narrowed to the union of what each side alone would narrow it to (disjunctive/union narrowing).
				if ((test.operator === '||' && sense) || (test.operator === '&&' && !sense)) {
					const left = narrow(test.left, scope, sense), right = narrow(test.right, scope, sense);
					if (left === scope || right === scope)
						return scope;	// one side narrowed nothing at all: the union narrows nothing either
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
						if (l.type === 'unary' && l.operator === 'typeof' && r.type === 'literal' && typeof r.value === 'string') {
							const key = T.pathKey(l.argument);
							if (key) {
								const kind = r.value;
								return scope.narrowValue(key, m => {
									const n = T.typeofName(m);
									return n === undefined || (n === kind) === keepMatch;
								}, scope.value(key) ?? silentType(l.argument, scope));
							}
						}
						// x === null / undefined  (loose == matches both)
						if (l.type === 'identifier' && (r.type === 'literal' && r.value === null || r.type === 'identifier' && r.name === 'undefined')) {
							const matches: (m: Type) => boolean
								= loose					? m => T.isNullish(m, scope)
								: r.type === 'literal'	? m => m.type === 'literal' && m.value === null
								: m => m.type === 'ref' && (m.name === 'undefined' || m.name === 'void');
							return scope.narrowValue(l.name, m => matches(m) === keepMatch);
						}
						// x === literal: literal members must match; non-literal members might
						if (l.type === 'identifier' && r.type === 'literal' && r.value !== null)
							return scope.narrowValue(l.name, m => m.type !== 'literal' || (m.value === r.value) === keepMatch);
						// x.prop === literal  (discriminated union) -- `narrowByDiscriminant`, not a plain `lookupMember` read, so a
						// compound member (`MaybeAmbient`, `JSDeclaration`, ...) gets split down to just its matching sub-variant(s)
						// rather than only being keepable-or-discardable whole.
						if (l.type === 'member' && l.object.type === 'identifier' && r.type === 'literal')
							return scope.narrowValue(l.object.name, m => T.narrowByDiscriminant(m, l.property, scope, keepMatch, r.value));
					}

				} else if (test.operator === 'instanceof') {
					const key = T.pathKey(test.left);
					if (key) {
						const cur = scope.value(key) ?? silentType(test.left, scope);
						return test.right.type === 'identifier' && scope.type(test.right.name)
							? scope.narrowTo(key, TS.RefType(test.right.name), sense, cur)
							// unknown class: trust the guard, stop tracking the binding
							: sense ? scope.narrowTo(key, T.ANY, sense, cur) : scope;
					}

				} else if (test.operator === 'in' && test.left.type === 'literal' && typeof test.left.value === 'string' && test.right.type === 'identifier') {
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
					return scope.narrowValue(key, m => !T.sealed(m, scope) || !!T.lookupMember(m, prop, scope) === sense, t);
				}
				return scope;
			}
			case 'call': {
				// user-defined type guards: `f(x)` with `x is T` narrows x; `o.m()` with `this is T` narrows o
				return runMuted(() => {
					const calleeT = scope.resolve(typeOf(test.callee, scope));
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
					const sig = T.flattenIntersection(calleeT, scope).find(p => p.type === 'function');
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
								test.arguments.forEach((a, i) => { const p = sig.params[i]; if (a.type !== 'spread' && p?.typeAnnotation) inferTypeArgs(p.typeAnnotation, typeOf(a, scope), names, map, scope); });
								// An uninferred type param must not leave a dangling `{type:'ref', name:'T'}` in `target`, or every other assignability
								// check (which treats an unresolvable ref as "unrelated") would silently narrow the guard to nothing at all.
								sig.typeParams.forEach(p => { if (!map.has(p.name)) map.set(p.name, p.constraint ?? p.default ?? T.ANY); });
								target = T.substituteType(target, map);
							}
							return scope.narrowTo(key, target, sense, scope.value(key) ?? typeOf(arg, scope));
						}
					}
					return scope;
				});
			}
			default:
				return scope;
		}
	};

	// TS 5.5+ "inferred type predicates": a function whose single return path is itself a type guard (`x => x != null`) gets an inferred `x is T`
	// return, by asking `narrow()` what it'd do with that expression. Only an expression body or single-`return` block is supported.
	const inferredPredicate = (fn: TS.CallSig, body: JS.Statement[] | Expr, scope: Scope): Type | undefined => {
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
		const narrowed = runMuted(() => narrow(test, inner, true)).value(p.key);
		return narrowed && narrowed !== paramT ? TS.Predicate(p.key, narrowed) : undefined;
	};

	// Conservative "this statement never falls through" -- powers guard-clause narrowing
	const alwaysExits = (stmt: JS.Statement): boolean => {
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
	};

	// A fresh object literal assigned to a fully-known object type may not introduce unknown keys
	const checkExcessProps = (lit: Expr, target: Type, scope: Scope, pos: JS.Location, targetScope: Scope = scope) => {
		if (lit.type !== 'object')
			return;
		const r = T.resolveOwn(target, targetScope);
		const targets = (r.type === 'intersection' ? r.types.map(t => T.resolveOwn(t, targetScope)) : [r])
			.filter(t => t.type === 'object');
		if (targets.length !== (r.type === 'intersection' ? r.types.length : 1) || targets.some(t => t.members.some(m => m.kind === 'index')))
			return;		// partially-unknown target or index signature: anything goes
		if (lit.properties.some(p => p.kind === 'spread' || typeof p.key !== 'string'))
			return;		// spread/computed keys: shape is open
		for (const p of lit.properties)
			if (p.kind !== 'spread' && typeof p.key === 'string' && !targets.some(t => t.members.some(m => (m.kind === 'property' || m.kind === 'method') && m.name === p.key)))
				error(pos)` Object literal may only specify known properties, and '${p.key}' does not exist in type '${target}'`;
	};

	// Infers a generic call's type arguments by matching each parameter's declared type against the argument's (structural positions only; first
	// binding wins). A `keyof`-constrained (or `const`) parameter keeps the argument's exact literal instead of widening it (`K extends keyof X` can only hold one specific property name).
	// `declScope` resolves names inside `paramT` itself (the declared signature's own types); `scope` resolves names in `argT` (the call site's).
	// Usually identical, but a signature reached via a namespace import (`bin.as(...)`) declares its own types in *its* module's scope, not the caller's.
	const inferTypeArgs = (paramT: Type, argT: Type, tparams: ReadonlyMap<string, TS.TypeParam>, out: Map<string, Type>, scope: Scope, depth = 0, declScope: Scope = scope): void => {
		if (depth > 6)
			return;
		// A declared function-type parameter is often written parenthesized (`((value: T) => R) | undefined | null`, lib.d.ts's own style for
		// nullable callbacks) -- unwrapped here so the `function`/`constructor` branch below actually matches instead of silently no-oping.
		if (paramT.type === 'parenthesized')
			return inferTypeArgs(paramT.inner, argT, tparams, out, scope, depth, declScope);
		if (paramT.type === 'readonly')
			return inferTypeArgs(paramT.argument, argT, tparams, out, scope, depth, declScope);
		if (paramT.type === 'ref' && !paramT.typeArgs && tparams.has(paramT.name)) {
			if (!out.has(paramT.name)) {
				const tp = tparams.get(paramT.name)!;
				out.set(paramT.name, tp.const || tp.constraint?.type === 'keyof' ? argT : T.widenLiterals(argT));
			}
			return;
		}
		const a = T.resolveOwn(argT, scope);
		if (paramT.type === 'array') {
			if (a.type === 'array')
				inferTypeArgs(paramT.element, a.element, tparams, out, scope, depth + 1, declScope);
			else if (a.type === 'tuple')
				a.elements.forEach(el => { const t = T.tupleElementType(el); if (t) inferTypeArgs(paramT.type === 'array' ? paramT.element : T.ANY, t, tparams, out, scope, depth + 1, declScope); });
			// e.g. an argument built from `x ?? y` where both branches independently resolve to compatible-but-not-deduplicated array types
			// (`number[] | number[]`) -- distribute over the union rather than giving up (the first member to actually match wins, per `out`'s guard).
			else if (a.type === 'union')
				a.types.forEach(m => inferTypeArgs(paramT, m, tparams, out, scope, depth + 1, declScope));
		} else if (paramT.type === 'ref' && paramT.typeArgs) {
			if (paramT.name === 'Array' && paramT.typeArgs.length === 1 && a.type === 'array') {
				inferTypeArgs(paramT.typeArgs[0], a.element, tparams, out, scope, depth + 1, declScope);
			} else if (paramT.name === 'PromiseLike' && paramT.typeArgs.length === 1 && T.asPromiseRef(argT, scope)) {
				// `.then<TResult1>(onfulfilled?: (v: T) => TResult1 | PromiseLike<TResult1>)`'s 2nd alternative -- an async callback's own
				// inferred return is already `Promise<X>`, a different (but Promise-like) name `named` above won't match structurally;
				// unwrap through the same alias-peeling `asPromiseRef` uses for `await`/`return` so `TResult1` binds to `X`, not `Promise<X>`.
				inferTypeArgs(paramT.typeArgs[0], T.asPromiseRef(argT, scope)!.typeArgs![0], tparams, out, scope, depth + 1, declScope);
			} else {
				// Prefer the argument's own (unresolved) named type over its fully-expanded structural shape -- `resolve()` eagerly substitutes a
				// generic ref's type params into its body, losing the "this was Polynomial<number>" name/typeArgs identity `paramT` needs to match.
				const named = argT.type === 'ref' && argT.typeArgs && argT.name === paramT.name ? argT
					: a.type === 'ref' && a.typeArgs && a.name === paramT.name ? a
					: undefined;
				if (named) {
					paramT.typeArgs.forEach((p, i) => { const t = named.typeArgs![i]; if (t) inferTypeArgs(p, t, tparams, out, scope, depth + 1, declScope); });
				} else {
					// A generic alias wrapping `T` (e.g. `Testable<T> = T extends primitive ? T : T & Equal<T>`) -- unfold one level and recurse,
					// so whichever case below actually contains `T` gets a chance to match. `paramT.name` is declared in `declScope`, not `scope`.
					const entry = declScope.type(paramT.name);
					if (entry?.typeParams?.length)
						inferTypeArgs(T.substituteType(entry.type, new Map(entry.typeParams.map((p, i) => [p.name, paramT.typeArgs![i] ?? p.default ?? T.ANY]))), argT, tparams, out, scope, depth + 1, declScope);
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
			if (a.type === paramT.type) {
				paramT.params.forEach((p, i) => { const q = a.params[i]; if (p.typeAnnotation && q?.typeAnnotation) inferTypeArgs(p.typeAnnotation, q.typeAnnotation, tparams, out, scope, depth + 1, declScope); });
				if (paramT.returnType && a.returnType)
					inferTypeArgs(paramT.returnType, a.returnType, tparams, out, scope, depth + 1, declScope);
			}
		} else if (paramT.type === 'object') {
			for (const m of paramT.members) {
				if ((m.kind !== 'property' && m.kind !== 'method') || typeof m.name !== 'string')
					continue;
				if (m.kind === 'property') {
					const t = T.lookupMember(a, m.name, scope);
					if (t)
						inferTypeArgs(m.typeAnnotation, t, tparams, out, scope, depth + 1, declScope);
				} else if (m.kind === 'method') {
					// Same shape as `function`/`constructor` above -- `adapter0<T,D>`-style interfaces often carry `T`/`D` only in a method's own signature.
					const t = T.lookupMember(a, m.name, scope);
					if (t?.type === 'function') {
						m.params.forEach((p, i) => { const q = t.params[i]; if (p.typeAnnotation && q?.typeAnnotation) inferTypeArgs(p.typeAnnotation, q.typeAnnotation, tparams, out, scope, depth + 1, declScope); });
						if (m.returnType)
							inferTypeArgs(m.returnType, t.returnType ?? T.ANY, tparams, out, scope, depth + 1, declScope);
					}
				}
			}
		} else if (paramT.type === 'predicate') {
			// Only an argument that's *itself* an inferred/declared predicate carries a usable asserted type (e.g. `.filter`'s `(v) => v is S`
			// matched against a callback whose own inferred return came out `v is <narrowed>`) -- a plain `boolean` callback leaves `S` uninferred.
			if (a.type === 'predicate' && paramT.assertedType && a.assertedType)
				inferTypeArgs(paramT.assertedType, a.assertedType, tparams, out, scope, depth + 1, declScope);
		} else if (paramT.type === 'union') {
			// A bare `T` alternative (`T | undefined`) matches the *whole* argument, which is too coarse whenever a more structural
			// alternative in the same union (e.g. `TypeT<K>`) could instead drill into K's own position -- so non-bare alternatives are
			// tried first; a bare one (tried last) only contributes if nothing more specific already bound that name (first binding wins).
			const isBare = (t: Type) => t.type === 'ref' && !t.typeArgs && tparams.has(t.name);
			for (const t of paramT.types)
				if (!isBare(t))
					inferTypeArgs(t, argT, tparams, out, scope, depth + 1, declScope);
			for (const t of paramT.types)
				if (isBare(t))
					inferTypeArgs(t, argT, tparams, out, scope, depth + 1, declScope);
		}
	};

	// ---- declaration hoisting / namespace resolution ------------------------------------------

	const hoist = (stmts: TS.Statement[], scope: Scope) => {
		const fnGroups = new Map<string, JS.FunctionDecl[]>();

		// `interface`/`type` first, in their own pass: a `declare var X: Y` (e.g. lib.d.ts's `declare var Array: ArrayConstructor`) resolves
		// `Y` *eagerly* below, so every augmentation of `Y` across however many statements/files were concatenated into `stmts` (lib.d.ts
		// spreads `ArrayConstructor`'s members across `lib.es5.d.ts`, `lib.es2015.core.d.ts`, ...) must already be merged by the time it runs.
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
					const { instance, value } = T.classShapes(stmt as JS.ClassDecl, scope);
					scope.mergeType(stmt.name, instance, stmt.typeParams as TS.TypeParam[]);
					scope.addValue(stmt.name, value);
					break;
				}
				case 'type_alias_decl':
				case 'interface_decl':
					break;	// handled in the pass above
				case 'enum_decl': {
					let next = 0;
					const memberTypes = stmt.members.map((m): Type =>
						m.init?.type === 'literal' && typeof m.init.value === 'number' ? { type: 'literal', value: (next = m.init.value + 1, m.init.value) }
						: m.init?.type === 'literal' && typeof m.init.value === 'string' ? { type: 'literal', value: m.init.value }
						: m.init ? T.NUMBER
						: { type: 'literal', value: next++ });
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
						hoistVarDecl(scope, stmt.declarations, stmt.kind !== 'const');
					break;
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
					// Defines `t.returnType` as a self-memoizing accessor: the first read runs `checkFunctionBody` (muted) to infer it, then
					// replaces itself with a plain value -- every reader (not just `instantiate`) sees the real inferred type, never a stale
					// placeholder. `resolving` guards a recursive read (the body calling itself) into seeing `ANY` rather than re-entering.
					let resolving = false;
					Object.defineProperty(t, 'returnType', {
						configurable: true,
						enumerable: true,
						get(): Type {
							if (resolving)
								return T.ANY;
							resolving = true;
							runMuted(() => checkFunctionBody(t, d.body, scope, false));
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

	const hoistVarDecl = (scope: Scope, declarations: JS.VarDeclarator[], widen: boolean) => {
		for (const d of declarations) {
			const init = d.init && typeOf(d.init, scope);
			if (typeof d.name === 'string') {
				scope.addValue(d.name, d.typeAnnotation ? scope.resolve(d.typeAnnotation as Type) : init ? (widen ? T.widenLiterals(init) : init) : T.ANY);
				// TS 4.4 aliased conditions: a `const`'s initializer stays true for the binding's whole lifetime (unlike
				// `let`/`var`, which can be reassigned), so narrowing the const later also narrows through whatever its
				// initializer expression itself would narrow -- `const entry = tok && row.get(tok.type); if (!entry) ...`
				// narrows `tok` too once `entry` is known truthy. `narrow()`'s `case 'identifier'` reads this.
				if (!widen && d.init)
					scope.addAlias(d);
			} else {
				T.bindingNames(d.name).forEach(n => scope.addValue(n, T.ANY));
			}
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
				hoistVarDecl(inner, stmt.declarations, stmt.kind !== 'const');
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
					// A declaration default export (`export default class Foo {}`) is already registered under its own name by
					// `hoist`'s own unwrap-and-process pass above -- just alias 'default' to that same entry. An expression default
					// (`export default someIdentifier`/`export default 42`) is never hoisted under any name, so resolve it directly
					// here (muted, same lazy top-level inference `exportScope` already does for ordinary `var_decl`s below).
					if (isTsDeclaration(d)) {
						if ('name' in d)
							scope.copy(inner, d.name, 'default');
					} else {
						const v = d.type === 'identifier' ? inner.value(d.name) : typeOf(d, inner);
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

	// `sig.declScope` (see `ts-parser.ts`'s `CallSig`), or `scope` when absent -- an intrinsic (`.map`) or class/interface method never gets one.
	const declScopeOf = (sig: TS.CallSig, scope: Scope) => (sig.declScope as Scope | undefined) ?? scope;

	// Instantiates `sig` against already-computed `argTs` (explicit `typeArgs`, or inference), substituting type params through params/return type.
	// Pure; doesn't validate anything (see `argsFit` for that) -- used both to pick an overload candidate (trial) and, once picked, for real.
	// `restElementTs`: a spread argument's own array-element type(s) (`fn(...arr)`) -- `argTs` deliberately leaves a spread position
	// `undefined` (the call's real arity isn't known statically), so without this a rest-parameter type param (`max<T>(...values: T[])`)
	// could never be inferred from the single most common way of calling it, always falling back to its bare constraint/default.
	const instantiate = (sig: TS.CallSig, argTs: (Type | undefined)[], typeArgs: Type[] | undefined, scope: Scope, pos: JS.Location, restElementTs?: Type[]): TS.CallSig => {
		let returnType	= sig.returnType ?? T.ANY;
		let params		= sig.params;

		if (sig.typeParams?.length) {
			const map = new Map<string, Type>();
			if (typeArgs) {
				sig.typeParams.forEach((p, i) => map.set(p.name, typeArgs[i] ?? p.default ?? T.ANY));
			} else {
				const names		= new Map(sig.typeParams.map(p => [p.name, p] as const));
				const declScope	= declScopeOf(sig, scope);
				argTs.forEach((t, i) => {
					const p = params[i];
					if (t && p?.typeAnnotation)
						inferTypeArgs(p.typeAnnotation, t, names, map, scope, 0, declScope);
				});
				if (sig.rest?.typeAnnotation && restElementTs?.length) {
					const t		= sig.rest.typeAnnotation;
					const elem	= t.type === 'array' ? t.element : t;
					restElementTs.forEach(t => inferTypeArgs(elem, t, names, map, scope, 0, declScope));
				}
				sig.typeParams.forEach(p => {
					if (!map.has(p.name)) {
						map.set(p.name, p.default ?? p.constraint ?? T.ANY);
						// only worth flagging if some *supplied* argument's parameter type actually mentions `p.name` -- otherwise
						// tsc couldn't have inferred it either, and silently falls back the same way we just did, with no diagnostic.
						if (params.some((prm, i) => argTs[i] && prm.typeAnnotation && T.mentionsTypeParam(prm.typeAnnotation, p.name)))
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

	const typeOf = (e: Expr, scope: Scope, widen = true): Type => {
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
					case 'boolean':
						return { type: 'literal', value: e.value };
					case 'bigint':	return T.BIGINT;
					case 'object':	return e.value === null ? { type: 'literal', value: e.value } : T.REGEXP;
				}
				break;

			case 'this':		return scope.value('this') ?? T.ANY;
			case 'identifier':	return scope.value(e.name) ?? T.ANY;

			case 'array': {
				const elems: Type[] = [];
				for (const el of e.elements) {
					if (el) {
						if (el.type === 'spread') {
							const t = T.resolveOwn(typeOf(el.argument, scope), scope);
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
					if (p.kind === 'spread') {
						typeOf(p.argument, scope);
						return T.ANY;		// spread makes the shape unknowable here
					}
					const t = typeOf(p.value, scope);
					if (p.kind === 'get') {
						members.push(TS.TypeProperty(p.key, (t as TS.FunctionType).returnType ?? T.ANY));
					} else if (p.kind !== 'set' && typeof p.key === 'string') {
						// widen: object literal properties are mutable, so `{ sign: 0 }` has sign: number
						members.push(TS.TypeProperty(p.key, maybeWidenLiterals(t)));
					}
				}
				return TS.ObjectType(members);
			}

			case 'function':
				checkFunctionBody(e, e.body, scope, hasMod(e, 'async'), hasMod(e, 'generator'), hasMod(e, 'generator'));
				return TS.FunctionType(T.FixSig(e, T.ANY));

			case 'arrow':
				checkFunctionBody(e, e.body, scope, hasMod(e, 'async'), false, false);
				return TS.FunctionType(T.FixSig(e, T.ANY));

			case 'member': {
				const key		= T.pathKey(e);
				const refined	= key && scope.value(key);	// dotted keys live only in narrowings
				if (refined)
					return refined;
				const objT	= typeOf(e.object, scope);
				const t		= T.lookupMember(objT, e.property, scope);
				if (!muted && !t && !e.optional && T.sealed(objT, scope))
					error(pos)`Property '${e.property}' does not exist on type '${objT}'`;
				return t ?? T.ANY;
			}
			case 'index': {
				const objT = scope.resolve(typeOf(e.object, scope));
				typeOf(e.property, scope);
				if (objT.type === 'array')
					return objT.element;
				if (objT.type === 'tuple' && e.property.type === 'literal' && typeof e.property.value === 'number') {
					const el = objT.elements[e.property.value];
					if (!muted && !el)
						error(pos)`Tuple type '${objT}' has no element at index ${e.property.value}`;
					return (el && T.tupleElementType(el)) ?? T.ANY;
				}
				if (e.property.type === 'literal' && typeof e.property.value === 'string') {
					const t = T.lookupMember(objT, e.property.value, scope);
					if (!muted && !t && T.sealed(objT, scope))
						error(pos)`Property '${e.property.value}' does not exist on type '${objT}'`;
					return t ?? T.ANY;
				}
				return T.ANY;
			}

			case 'call':
			case 'new': {
				const calleeT	= T.resolveOwn(typeOf(e.callee, scope), scope);
				const typeArgs	= e.typeArgs as Type[];

				let overloads: TS.CallSig[] | undefined;
				let sig: TS.CallSig|undefined = (calleeT.type === 'intersection' ? calleeT.types.map(p => T.resolveOwn(p, scope)) : [calleeT])
					.find(p => p.type === 'function' || p.type === 'constructor');
				if (!sig) {
					// `new` prefers a construct signature, a plain call a bare call signature -- each falls back to the other when its preferred
					// kind is absent (real TS wouldn't allow that cross-fallback), matching this checker's existing leniency.
					const members 		= T.collectMembers(calleeT, scope);
					const constructs	= members.filter(m => m.kind === 'construct');
					const callSigs		= members.filter(m => m.kind === 'call');
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

				// Real overload resolution: try each candidate against argument types computed *without* contextual parameter typing (which signature
				// to type a callback's params from isn't known yet) -- first arity+type fit wins. No fit stays fully lenient rather than guessing (tried that, caused false positives). Muted: purely a trial.
				if (overloads && !e.arguments.some(a => a.type === 'spread')) {
					sig = runMuted(() => {
						const trialArgTs = e.arguments.map(a => typeOf(a, scope));
						return overloads!.find(c => T.argsFit(instantiate(c, trialArgTs, typeArgs, scope, pos), trialArgTs, scope));
					});
				}
				if (overloads && !sig)
					warning(pos)`No overload of '${e.callee}' matches this call; arguments left unchecked`;

				// Contextual parameter typing: an unannotated callback argument (`arr.map(x => x.foo)`) would otherwise type its own params as `any`.
				// Fills them in here from the matching declared (pre-substitution) param type -- mutates the AST node; must run before `argTs` below, which triggers `checkFunctionBody` on each argument.
				if (sig) {
					// A declared callback param is routinely a union (lib.d.ts's `((value: T) => R) | undefined | null` style for nullable
					// callbacks, e.g. `Promise.then`) and/or parenthesized -- dig through both to find the function/constructor alternative.
					const resolveFnMember = (t: Type): TS.CallSig | undefined => {
						const r = T.resolveOwn(t, scope);
						if (r.type === 'function' || r.type === 'constructor')
							return r;
						if (r.type === 'union') {
							for (const m of r.types) {
								const f = resolveFnMember(m);
								if (f)
									return f;
							}
						}
						return undefined;
					};
					e.arguments.forEach((a, i) => {
						if (a.type !== 'function' && a.type !== 'arrow')
							return;
						const declared = sig.params[i]?.typeAnnotation;
						const expected = declared && resolveFnMember(declared as Type);
						if (expected) {
							a.params.forEach((p, j) => {
								if (!p.typeAnnotation && expected.params[j]?.typeAnnotation)
									p.typeAnnotation = expected.params[j].typeAnnotation;
							});
						}
					});

					const restElementTs: Type[] = [];
					const argTs = e.arguments.map(a => {
						if (a.type !== 'spread')
							return typeOf(a, scope);
						const t		= T.resolveOwn(typeOf(a.argument, scope), scope);
						const el	= t.type === 'array' ? t.element
									: t.type === 'tuple' ? T.combineTypes(t.elements.map(el => T.tupleElementType(el)).filter((x): x is Type => !!x))
									: undefined;
						if (el)
							restElementTs.push(el);
						return undefined;
					});

					// A rest-only signature (`gcd<T>(...values: T[])`) called with plain positional arguments (`gen.gcd(a, b)`, no spread)
					// leaves those args past `sig.params.length` unmatched by the per-`params[i]` inference loop above (there's no fixed
					// param at that index to pair them with) -- feed them into the same rest-element inference as a real spread would.
					e.arguments.forEach((a, i) => {
						if (a.type !== 'spread' && i >= sig!.params.length && argTs[i])
							restElementTs.push(argTs[i] as Type);
					});

					const { params, returnType } = instantiate(sig, argTs, typeArgs, scope, pos, restElementTs);
					const declScope = declScopeOf(sig, scope);
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
					// A predicate return (`x is T`/`asserts x is T`) is only special to `narrow()`'s own dedicated `case 'call'`, which reads it
					// straight off the callee's signature -- as a plain expression's *value*, a non-asserting predicate is just `boolean`
					// (real `isFoo(x)` returns `boolean`, not `x is T`, wherever it isn't itself the direct test of a narrowing position) and
					// an asserting one returns nothing usable (`void`). Without this, the raw predicate type leaks into whatever consumes this
					// expression's type next (e.g. an outer call's own generic inference), poisoning it with an unrelated `S`/`paramName`.
					return returnType && returnType.type === 'predicate' ? (returnType.asserts ? T.VOID : T.BOOLEAN) : returnType!;
				}
				return e.type === 'new' && e.callee.type === 'identifier' ? TS.RefType(e.callee.name, typeArgs) : T.ANY;
			}

			// `expr<T,U>` (TS 4.7+): pins a generic function/constructor's type params without calling it. An overloaded callee keeps every
			// arity-compatible signature instantiated (still overloaded); anything else stays `ANY`, same leniency as an uncallable `case 'call'`.
			case 'instantiation': {
				const calleeT	= T.resolveOwn(typeOf(e.expression, scope), scope);
				const typeArgs	= e.typeArgs as Type[];
				const fnPart	= (calleeT.type === 'intersection' ? calleeT.types.map(p => T.resolveOwn(p, scope)) : [calleeT])
					.find(p => p.type === 'function' || p.type === 'constructor');
				if (fnPart)
					return { type: fnPart.type, ...instantiate(fnPart, [], typeArgs, scope, pos) };
				if (calleeT.type === 'object') {
					const calls = calleeT.members.filter(m => m.kind === 'call' || m.kind === 'construct');
					if (calls.length)
						return TS.ObjectType(calls.map(m => TS.TypeMember(m.kind, instantiate(m, [], typeArgs, scope, pos))));
				}
				return T.ANY;
			}

			case 'unary': {
				const argT = typeOf(e.argument, scope);
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
				const argT = typeOf(e.argument, scope);
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
								return JS.Literal(e.operator === '||');
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
					// assignments are judged against the declaration-site type, not any active narrowing -- for a dotted member
					// target (`this.handle = ...`) that means going through `lookupMember` on the object's own type, not `typeOf`
					// on the member expression itself, which would consult the dotted-path narrowings map first (e.g. a preceding
					// `if (this.handle)` guard narrows reads of `this.handle` to exclude `null`, but the assignment target itself
					// must still accept `null`, since that's what the field is actually declared as);
					// an optional property also accepts undefined
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
								// later statements see the assigned type, not the (possibly wider) declared one
								if (e.left.type === 'identifier' && scope.declared(e.left.name))
									scope.addNarrowing(e.left.name, maybeWidenLiterals(rt));
							}
						} else if ((e.operator === '??=' || e.operator === '||=' || e.operator === '&&=') && e.left.type === 'identifier' && scope.declared(e.left.name)) {
							// `x ??= y` leaves x holding its non-nullish members or y (and likewise for ||= / &&=)
							const r		= T.resolveOwn(lt, scope);
							const other = T.isOther(e.operator[0]);

							scope.addNarrowing(e.left.name, T.combineTypes([
								...(r.type === 'union' ? r.types : [r]).filter(m => !other(T.resolveOwn(m, scope), scope)),
								maybeWidenLiterals(rt),
							]));
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
				return T.combineTypes([typeOf(e.consequent, narrow(e.test, scope, true)), typeOf(e.alternate, narrow(e.test, scope, false))]);

			case 'sequence':
				return e.expressions.map(x => typeOf(x, scope)).pop() ?? T.ANY;

			case 'spread':
				return typeOf(e.argument, scope);

			case 'tagged_template': {
				const t = T.resolveOwn(typeOf(e.tag, scope), scope);
				e.quasi.forEach(p => p.exp && typeOf(p.exp, scope));
				return t.type === 'function' ? t.returnType ?? T.ANY : T.ANY;
			}
			case 'yield': {
				const argT = e.argument ? typeOf(e.argument, scope) : T.VOID;
				if (yieldCollector)
					yieldCollector.push(e.delegate ? T.iterableElementType(argT, scope) : T.widenLiterals(argT));
				return T.ANY;
			}

			case 'class': {
				const { instance, value } = T.classShapes(e, scope);
				checkClassMembers(e.name, e.body as TS.ClassMember[], instance, value, scope);
				return value;
			}
			case 'as_expression': {
				const anno = e.typeAnnotation as Type;
				return anno.type === 'ref' && anno.name === 'const' ? typeOf(e.expression, scope, false) : anno;
			}
			case 'satisfies_expression': {
				const t = typeOf(e.expression, scope);
				if (!muted) {
					const anno = e.typeAnnotation as Type;
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

	// A body with zero `return` statements normally infers `void` -- but if every path through it ends in a `throw`
	// (the common "placeholder"/"assert unreachable" idiom), real TS infers `never` instead, which -- unlike `void`
	// -- is assignable to any declared return type. Not a full CFG: covers the shapes that idiom actually takes.
	const alwaysThrows = (stmt: JS.Statement | undefined): boolean => {
		if (!stmt)
			return false;
		switch (stmt.type) {
			case 'throw':	return true;
			case 'block':	return stmt.body.length > 0 && alwaysThrows(stmt.body[stmt.body.length - 1]);
			case 'if':		return !!stmt.alternate && alwaysThrows(stmt.consequent) && alwaysThrows(stmt.alternate);
			case 'try':		return (!stmt.handlerBody || alwaysThrows(stmt.handlerBody[stmt.handlerBody.length - 1])) && alwaysThrows(stmt.block[stmt.block.length - 1]);
			default:		return false;
		}
	};

	// ---- functions / classes / statements -------------------------------------------------------

	const checkFunctionBody = (fnj: JS.CallSig, body: JS.Statement[] | Expr | undefined, scope: Scope, async: boolean, skipReturn?: boolean, generator?: boolean) => {
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
						const t = typeOf(argument, scope, false);
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
			const t = typeOf(body, inner);
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
			if (m.type === 'field') {
				if (m.value) {
					const t = typeOf(m.value, inner);
					if (m.typeAnnotation && !checkAssignable(t, m.typeAnnotation as Type, inner, (m as any).pos))
						error((m as any).pos)`Type '${t}' is not assignable to type '${m.typeAnnotation as Type}'`;
					else if (m.typeAnnotation)
						checkExcessProps(m.value, m.typeAnnotation as Type, inner, (m as any).pos);
				}
			} else if (m.type === 'method') {
				checkFunctionBody(m, m.body, inner, hasMod(m, 'async'), hasMod(m, 'generator') || m.kind === 'set' || m.key === 'constructor', hasMod(m, 'generator'));
			} else if (m.type === 'static_block') {
				checkBlock(m.body, new Scope(inner));
			}
		}
	};

	// Every leaf of an if/else chain (or a block's final statement) assigns the same variable:
	// yields the assigned expressions so the post-if type can merge the branches
	const assignRights = (st: TS.Statement, name?: string): { name: string; rights: Expr[] } | undefined => {
		if (st.type === 'expression' && st.expression.type === 'binary' && st.expression.operator === '=' && st.expression.left.type === 'identifier' && (!name || st.expression.left.name === name))
			return { name: st.expression.left.name, rights: [st.expression.right] };
		if (st.type === 'block' && st.body.length)
			return assignRights(st.body[st.body.length - 1], name);
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
						const anno = d.typeAnnotation as Type;
						if (anno) {
							if (d.init) {
								const init = typeOf(d.init, scope);
								if (!init)
									checkExcessProps(d.init, anno, scope, pos);
								else if (!checkAssignable(init, anno, scope, pos))
									error(pos)`Type '${init}' is not assignable to type '${anno}' in declaration of '${d.name}'`;
							}
						}
					}
				}
				hoistVarDecl(scope, stmt.declarations, stmt.kind !== 'const');
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
				// Mirrors `while`/`do_while`'s own test-narrowing -- `for (let m; (m = re.exec(s));)` relies on the same
				// assignment-truthiness narrowing to strip `null` from `m` inside the body.
				checkStmt(stmt.body, stmt.test ? narrow(stmt.test, inner, true) : inner, onReturn);
				break;
			}
			case 'for_in': {
				const inner = new Scope(scope);
				const rightT = T.resolveOwn(typeOf(stmt.right, inner), inner);
				const elemT = stmt.kind === 'in' ? T.STRING
					: rightT.type === 'array' ? rightT.element
					: T.isString(rightT) ? T.STRING
					: T.ANY;
				if (stmt.init.type === 'var_decl') {
					for (const d of stmt.init.declarations)
						if (typeof d.name === 'string')
							inner.addValue(d.name, (d.typeAnnotation as Type | undefined) ?? elemT);
						else
							T.bindingNames(d.name).forEach(n => inner.addValue(n, T.ANY));
				} else {
					typeOf(stmt.init, inner);
				}
				checkStmt(stmt.body, inner, onReturn);
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
				const { instance, value } = T.classShapes(stmt, scope);
				checkClassMembers(stmt.name, stmt.body as TS.ClassMember[], instance, value, scope);
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

	const global = new Scope();
	for (const [n, r] of [['BigInt', T.BIGINT], ['Number', T.NUMBER], ['String', T.STRING], ['Boolean', T.BOOLEAN]] as const)
		global.addValue(n, TS.FunctionType([JS.Param('value', T.ANY, ['optional'])], r));

	global.addValue('undefined',	T.UNDEFINED);
	global.addValue('NaN',		T.NUMBER);
	global.addValue('Infinity',	T.NUMBER);

	const TT = TS.RefType('T');
	global.addValue('Array', TS.ObjectType([
		// `Array(n)`/`Array<T>(n)`/`new Array(n)`: the constructor call itself, not a static method.
		TS.TypeCall(TS.CallSig([JS.Param('arrayLength', T.NUMBER, ['optional'])], TS.ArrayType(TT), [{ name: 'T' }])),
		TS.TypeProperty('prototype', T.ANY),
		TS.TypeMethod('from', 		TS.CallSig(
			[
				JS.Param('arrayLike',	T.ANY),
				JS.Param('mapfn',		TS.FunctionType([JS.Param('v', T.ANY), JS.Param('k', T.NUMBER)], TT), ['optional']),
				JS.Param('thisArg', 	T.ANY, ['optional']),
			],
			TS.ArrayType(TT),
			[{ name: 'T' }]
		)),
		// A plain `boolean` return would lose `Array.isArray`'s narrowing power (`if (Array.isArray(x))` needs `x is any[]` to narrow `x`).
		TS.TypeMethod('isArray',	TS.CallSig([JS.Param('a', T.ANY)], TS.Predicate('a', TS.ArrayType(T.ANY)))),
		TS.TypeMethod('of',			TS.CallSig({ params: [], rest: JS.Rest('items', TT) }, TS.ArrayType(TT), [{ name: 'T' }])),
	]));

	return {
		global, typeOf, exportScope,

		checkBlock: (stmts: TS.Statement[], scope: Scope, muted = false) => {
			return muted ? runMuted(()=>checkBlock(stmts, scope)) : checkBlock(stmts, scope);
		},

		inferReturn: (fnj: JS.CallSig, body: JS.Statement[], outer: Scope): Type => {
			if (fnj.returnType)
				return fnj.returnType as Type;
			const sig = { ...fnj } as TS.CallSig;
			runMuted(() => checkFunctionBody(sig, body, outer, false));
			return sig.returnType ?? T.VOID;
		}
	};
}
