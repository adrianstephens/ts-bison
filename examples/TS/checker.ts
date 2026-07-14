/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-this-alias */
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
// Deliberately partial; every gap errs lenient (no diagnostic) rather than risking a false positive:
//  - no module resolution: imported names (and unrecognized globals) type as `any`
//  - generic calls are instantiated by first-match structural inference from the argument types
//    (no union sources, no contravariant callback-parameter inference); generic type *references*
//    (`Foo<Bar>`) are substituted properly
//  - control-flow narrowing covers the common guards -- truthiness, `!`, `&&`/`||`, `typeof`,
//    null/undefined comparisons, discriminant properties, `instanceof`, `in`, and guard-clause early
//    exits -- on plain identifiers only; assignments don't invalidate an active narrowing
//  - fresh object literals get excess-property checks against fully-known object targets
//  - no declaration merging, no overload resolution
//  - keyof/conditional/mapped/indexed-access types are opaque (assignable to/from anything)


const COMPARISON_OPS 	= new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>=', 'in', 'instanceof']);
type Diagnostics = (strings: TemplateStringsArray, pos: JS.Location, ...values: any[])=>void;

//type PositiveInteger<T extends number> = `${T}` extends '0' | `-${any}` | `${any}.${any}` ? never : T

// The engine behind `TStypeCheck`, also reused by `TStoDecl` (with `report` off) for its scope
// resolution and expression-type synthesis. `mute` suppresses diagnostics while typing speculatively
// (lazy return-type inference re-walks bodies the reporting pass also visits).
export function makeChecker(error: Diagnostics) {
	const runMuted	= <T,>(fn: () => T): T => {
		const _old = error;
		error = () => {};
		try { return fn(); } finally { error = _old; }
	};

	const silentType = (e: Expr, scope: Scope): Type => runMuted(() => typeOf(e, scope));

	// ---- control-flow narrowing -----------------------------------------------------------------

	// Returns a scope refined by `test` holding (sense=true) or failing (sense=false). Covers truthiness, `!`, `&&`/`||`, typeof, null/undefined
	// comparisons, discriminant-property comparisons, instanceof, `in`, and user-defined type predicates.
	const aliasing = new Set<string>();
	const narrow = (test: Expr, scope: Scope, sense: boolean): Scope => {
		switch (test.type) {
			case 'unary':
				return test.operator === '!' ? narrow(test.argument, scope, !sense) : scope;
			case 'logical': {
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
				return scope;
			}
			case 'assign':
				// `if ((x = e))` narrows x by truthiness
				return test.operator === '=' && test.left.type === 'identifier'
					? scope.narrowValue(test.left.name, m => sense ? !T.isFalsyType(m) : !T.isTruthyType(m))
					: scope;
			case 'identifier': {
				const s = scope.narrowValue(test.name, m => sense ? !T.isFalsyType(m) : !T.isTruthyType(m));
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
				return key ? scope.narrowValue(key, m => sense ? !T.isFalsyType(m) : !T.isTruthyType(m), scope.value(key) ?? silentType(test, scope)) : scope;
			}
			case 'non_null':
				return narrow(test.expression, scope, sense);
			case 'binary': {
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
							const matches = (m: Type) => loose ? T.isNullishType(m)
								: r.type === 'literal' ? m.type === 'literal' && m.value === null
								: m.type === 'ref' && (m.name === 'undefined' || m.name === 'void');
							return scope.narrowValue(l.name, m => matches(m) === keepMatch);
						}
						// x === literal: literal members must match; non-literal members might
						if (l.type === 'identifier' && r.type === 'literal' && r.value !== null) {
							const v = r.value;
							return scope.narrowValue(l.name, m => m.type !== 'literal' || (m.value === v) === keepMatch);
						}
						// x.prop === literal  (discriminated union)
						if (l.type === 'member' && l.object.type === 'identifier' && r.type === 'literal') {
							const v = r.value, prop = l.property;
							return scope.narrowValue(l.object.name, m => {
								const pt = T.lookupMember(m, prop, scope);
								const rp = pt && scope.resolve(pt);
								return !rp || rp.type !== 'literal' || (rp.value === v) === keepMatch;
							});
						}
					}
					return scope;
				}
				if (test.operator === 'instanceof') {
					const key = T.pathKey(test.left);
					if (!key)
						return scope;
					const cur = scope.value(key) ?? silentType(test.left, scope);
					return test.right.type === 'identifier' && scope.typeEntry(test.right.name)
						? scope.narrowTo(key, { type: 'ref', name: test.right.name }, sense, cur)
						// unknown class: trust the guard, stop tracking the binding
						: sense ? scope.narrowTo(key, T.ANY, sense, cur) : scope;
				}
				if (test.operator === 'in' && test.left.type === 'literal' && typeof test.left.value === 'string' && test.right.type === 'identifier') {
					const prop = test.left.value, key = test.right.name;
					const t = scope.value(key);
					const r = t && scope.resolve(t);
					// tsc's "unlisted property narrowing": `in` on a sealed object type that doesn't declare `prop` still narrows -- the truthy
					// branch gets `prop` synthesized as `unknown` rather than erroring, e.g. `if ('length' in a) a.length`.
					if (sense && r && T.sealed(r, scope) && !T.lookupMember(r, prop, scope)) {
						const s = new Scope(scope);
						s.addNarrowing(key, { type: 'intersection', types: [r, { type: 'object', members: [{ kind: 'property', name: prop, typeAnnotation: { type: 'ref', name: 'unknown' } }] }] });
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
						// unknown callee (usually an imported helper) could be a type guard:
						// stop tracking the bindings it was given
						let s = scope;
						for (const a of test.arguments) {
							if (a.type === 'identifier' && s.value(a.name)) {
								s = new Scope(s);
								s.addNarrowing(a.name, T.ANY);
							}
						}
						return s;
					}
					const sig = (calleeT.type === 'intersection' ? calleeT.types.map(p => scope.resolve(p)) : [calleeT]).find(p => p.type === 'function');
					const ret = sig?.returnType;
					if (!sig || !ret || ret.type !== 'predicate' || !ret.assertedType || ret.asserts)
						return scope;
					const arg = ret.paramName === 'this'
						? (test.callee.type === 'member' ? test.callee.object : undefined)
						: test.arguments[sig.params.findIndex(p => p.key === ret.paramName)];
					const key = arg && T.pathKey(arg);
					if (!key)
						return scope;
					let target = ret.assertedType;
					if (sig.typeParams?.length) {
						const map = new Map<string, Type>();
						const names = new Map(sig.typeParams.map(p => [p.name, p] as const));
						test.arguments.forEach((a, i) => { const p = sig.params[i]; if (a.type !== 'spread' && p?.typeAnnotation) inferTypeArgs(p.typeAnnotation, typeOf(a, scope), names, map, scope); });
						// An uninferred type param must not leave a dangling `{type:'ref', name:'T'}` in `target`, or every other assignability
						// check (which treats an unresolvable ref as "unrelated") would silently narrow the guard to nothing at all.
						sig.typeParams.forEach(p => { if (!map.has(p.name)) map.set(p.name, p.constraint ?? p.default ?? T.ANY); });
						target = T.substituteType(target, map);
					}
					return scope.narrowTo(key, target, sense, scope.value(key) ?? typeOf(arg, scope));
				});
			}
			default:
				return scope;
		}
	};

	// TS 5.5+ "inferred type predicates": a function with no declared return type, whose single return path
	// is itself (structurally) a type guard on its first parameter -- `x => x != null`, `x => !!x`,
	// `x => x instanceof Foo`, `x => x.kind === 'a'` -- gets an inferred `x is T` return type instead of a
	// plain `boolean`, by just asking `narrow()` what it would do with that same expression as an `if` test.
	// Only the shapes real TS infers over are supported: an expression body, or a block body whose only
	// statement is `return <expr>`; multiple statements/return paths are left unmodeled (this checker has
	// no CFG/reassignment tracking to check they'd all agree, and neither does keeping it this simple hurt --
	// worst case a real predicate goes undetected, never a false one).
	const isBoolean = (t: Type) => t.type === 'ref' && t.name === 'boolean';
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
		inner.values.set(p.key, paramT);
		const narrowed = runMuted(() => narrow(test, inner, true)).value(p.key);
		return narrowed && narrowed !== paramT ? { type: 'predicate', paramName: p.key, assertedType: narrowed } : undefined;
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
	const checkExcessProps = (lit: Expr, target: Type, scope: Scope, pos: JS.Location) => {
		if (lit.type !== 'object')
			return;
		const r = scope.resolve(target);
		const targets = (r.type === 'intersection' ? r.types.map(t => scope.resolve(t)) : [r])
			.filter(t => t.type === 'object');
		if (targets.length !== (r.type === 'intersection' ? r.types.length : 1) || targets.some(t => t.members.some(m => m.kind === 'index')))
			return;		// partially-unknown target or index signature: anything goes
		if (lit.properties.some(p => p.kind === 'spread' || typeof p.key !== 'string'))
			return;		// spread/computed keys: shape is open
		for (const p of lit.properties)
			if (p.kind !== 'spread' && typeof p.key === 'string' && !targets.some(t => t.members.some(m => (m.kind === 'property' || m.kind === 'method') && m.name === p.key)))
				error`${pos} Object literal may only specify known properties, and '${p.key}' does not exist in type '${target}'`;
	};

	// Infers a generic call's type arguments by matching each parameter's declared type against the
	// corresponding argument's type (structural positions only; first binding wins). `tparams` maps each name to
	// its own declaration so a `keyof`-constrained (or explicitly `const`) parameter can keep the argument's exact
	// literal instead of widening it -- `K extends keyof X` can only ever hold one of X's specific property-name
	// literals, so widening to `string` (the ordinary default, right for a plain unconstrained `T`) would produce
	// a K that can no longer satisfy its own constraint, and silently breaks anything built structurally from it
	// (e.g. a mapped type `{[P in K]: ...}` keyed by K).
	const inferTypeArgs = (paramT: Type, argT: Type, tparams: ReadonlyMap<string, TS.TypeParam>, out: Map<string, Type>, scope: Scope, depth = 0): void => {
		if (depth > 6)
			return;
		if (paramT.type === 'ref' && !paramT.typeArgs && tparams.has(paramT.name)) {
			if (!out.has(paramT.name)) {
				const tp = tparams.get(paramT.name)!;
				out.set(paramT.name, tp.const || tp.constraint?.type === 'keyof' ? argT : T.widenLiterals(argT));
			}
			return;
		}
		const a = scope.resolve(argT);
		if (paramT.type === 'array') {
			if (a.type === 'array')
				inferTypeArgs(paramT.element, a.element, tparams, out, scope, depth + 1);
			else if (a.type === 'tuple')
				a.elements.forEach(el => { const t = T.tupleElementType(el); if (t) inferTypeArgs(paramT.type === 'array' ? paramT.element : T.ANY, t, tparams, out, scope, depth + 1); });
			// e.g. an argument built from `x ?? y` where both branches independently resolve to compatible-but-not-deduplicated array types
			// (`number[] | number[]`) -- distribute over the union rather than giving up (the first member to actually match wins, per `out`'s guard).
			else if (a.type === 'union')
				a.types.forEach(m => inferTypeArgs(paramT, m, tparams, out, scope, depth + 1));
		} else if (paramT.type === 'ref' && paramT.typeArgs) {
			if (paramT.name === 'Array' && paramT.typeArgs.length === 1 && a.type === 'array') {
				inferTypeArgs(paramT.typeArgs[0], a.element, tparams, out, scope, depth + 1);
			} else {
				// Prefer the argument's own (unresolved) named type over its fully-expanded structural shape -- `resolve()` eagerly substitutes a
				// generic ref's type params into its body, losing the "this was Polynomial<number>" name/typeArgs identity `paramT` needs to match.
				const named = argT.type === 'ref' && argT.typeArgs && argT.name === paramT.name ? argT
					: a.type === 'ref' && a.typeArgs && a.name === paramT.name ? a
					: undefined;
				if (named)
					paramT.typeArgs.forEach((p, i) => { const t = named.typeArgs![i]; if (t) inferTypeArgs(p, t, tparams, out, scope, depth + 1); });
			}
		} else if (paramT.type === 'function' || paramT.type === 'constructor') {
			if (a.type === paramT.type) {
				paramT.params.forEach((p, i) => { const q = a.params[i]; if (p.typeAnnotation && q?.typeAnnotation) inferTypeArgs(p.typeAnnotation, q.typeAnnotation, tparams, out, scope, depth + 1); });
				inferTypeArgs(paramT.returnType!, a.returnType!, tparams, out, scope, depth + 1);
			}
		} else if (paramT.type === 'object') {
			for (const m of paramT.members)
				if (m.kind === 'property' && typeof m.name === 'string') {
					const t = T.lookupMember(a, m.name, scope);
					if (t)
						inferTypeArgs(m.typeAnnotation, t, tparams, out, scope, depth + 1);
				}
		} else if (paramT.type === 'predicate') {
			// Only an argument that's *itself* an inferred/declared predicate carries a usable asserted type
			// (e.g. `.filter`'s modeled `(v) => v is S` matched against a callback whose own `checkFunctionBody`-
			// inferred return type came out as `v is <narrowed>`) -- a plain `boolean` callback leaves `S`
			// uninferred, same as any other argument that doesn't structurally match its declared shape.
			if (a.type === 'predicate' && paramT.assertedType && a.assertedType)
				inferTypeArgs(paramT.assertedType, a.assertedType, tparams, out, scope, depth + 1);
		} else if (paramT.type === 'union') {
			// The common, unambiguous shape: `T` itself is a bare member (`T | undefined`).
			const tps = paramT.types.filter(t => t.type === 'ref' && tparams.has(t.name));
			if (tps.length === 1) {
				inferTypeArgs(tps[0], argT, tparams, out, scope, depth + 1);
			} else {
				// Otherwise `T` may be embedded in exactly one alternative (e.g. a type guard's `(new (...args) => T) | ((...args) => T)`).
				// Try every alternative against the same argument; only the structurally-compatible one infers anything, so trying all is safe.
				for (const t of paramT.types)
					inferTypeArgs(t, argT, tparams, out, scope, depth + 1);
			}
		}
	};

	// ---- declaration hoisting / namespace resolution ------------------------------------------

	const hoist = (stmts: TS.Statement[], scope: Scope) => {
		const fnGroups = new Map<string, JS.FunctionDecl[]>();
		// declaration merging: a later class/interface of the same name augments the earlier one
		const mergeType = (name: string, typeParams: TS.TypeParam[] | undefined, type: Type) => {
			const prev = scope.types.get(name);
			scope.types.set(name, prev ? { typeParams: prev.typeParams ?? typeParams, type: { type: 'intersection', types: [prev.type, type] } } : { typeParams, type });
		};
		for (let stmt of stmts) {
			// `export declare class X {}` double-wraps (`export_decl` around `declare` around the real declaration) -- a single unwrap used to leave
			// a bare `declare` node the switch below never matches, silently dropping every `export declare ...` member (common in `.d.ts` files).
			let ambient = false;
			while (stmt.type === 'export_decl' || stmt.type === 'declare') {
				if (stmt.type === 'declare')
					ambient = true;
				stmt = stmt.declaration as TS.Statement;
			}
			if (stmt.type === 'export' && stmt.default) {
				if (!isTsDeclaration(stmt.default))
					continue;
				stmt = stmt.default;
			}
			switch (stmt.type) {
				case 'function_decl':
					fnGroups.set(stmt.name, [...(fnGroups.get(stmt.name) ?? []), stmt]);
					break;
				case 'class_decl': {
					// `stmt` reassigned twice above (an unwrap `while` loop, then a guard-clause `if`) -- real narrowing through both is
					// beyond what this checker's assignment/loop tracking models, so it still sees the pre-loop union here; the runtime
					// value is genuinely a `class_decl` per the `switch`, so this is a real narrowing gap, not a real type error.
					const { instance, value } = T.classShapes(stmt as JS.ClassDecl);
					mergeType(stmt.name, stmt.typeParams as TS.TypeParam[] | undefined, instance);
					scope.values.set(stmt.name, value);
					break;
				}
				case 'type_alias_decl':
					scope.types.set(stmt.name, { typeParams: stmt.typeParams, type: stmt.value });
					break;
				case 'interface_decl': {
					const obj: Type = { type: 'object', members: stmt.body };
					// own members first: lookupMember's first match implements override precedence
					mergeType(stmt.name, stmt.typeParams, stmt.extendsClause?.length ? { type: 'intersection', types: [obj, ...stmt.extendsClause] } : obj);
					break;
				}
				case 'enum_decl': {
					let next = 0;
					const memberTypes = stmt.members.map((m): Type =>
						m.init?.type === 'literal' && typeof m.init.value === 'number' ? { type: 'literal', value: (next = m.init.value + 1, m.init.value) }
						: m.init?.type === 'literal' && typeof m.init.value === 'string' ? { type: 'literal', value: m.init.value }
						: m.init ? T.NUMBER
						: { type: 'literal', value: next++ });
					scope.types.set(stmt.name, { type: T.combineTypes(memberTypes) });
					scope.values.set(stmt.name, { type: 'object', members: stmt.members.map((m, i): TS.TypeMember => ({ kind: 'property', name: m.name, typeAnnotation: memberTypes[i] })) });
					break;
				}
				case 'namespace_decl': {
					const { scope: ns, value } = exportScope(stmt.body, scope);
					// A type-only namespace (empty value type) merged onto a same-named const/class here would clobber that name's real value with a
					// sealed empty object before the sequential 'var' walk assigns it, breaking an earlier-declared class's eager forward reference.
					if (!(value.type === 'object' && value.members.length === 0))
						scope.values.set(stmt.name, value);
					scope.addNamespace(stmt.name, ns);
					break;
				}
				case 'import':
					// `TStypeCheckAsync`'s own import resolution already resolves real types for these names before hoist runs, but into
					// `scope`'s *parent* (`exportScope` hoists into a fresh child of the scope real resolution actually populated) -- so this
					// always materializes an own-map entry (preferring the parent-chain-aware `value()` over the `any` fallback), rather than
					// conditionally skipping, since callers that only read `scope`'s own map directly (e.g. `exportScope`'s ambient-convention
					// enumeration) would otherwise never see a name that resolution placed on a parent instead of here.
					if (stmt.default)
						scope.values.set(stmt.default, scope.value(stmt.default) ?? T.ANY);
					if (stmt.namespace)
						scope.values.set(stmt.namespace, scope.value(stmt.namespace) ?? T.ANY);
					stmt.specifiers?.forEach(s => scope.values.set(s.local, scope.value(s.local) ?? T.ANY));
					break;
				case 'var':
					// Only a `declare const/let/var` reaches here -- a plain top-level `var`/`let`/`const` is deliberately *not* hoisted (unlike
					// every other declaration kind above): real `let`/`const` observe a temporal dead zone, so forward-referencing one is a genuine
					// error this checker should be able to catch, not paper over by pre-populating it here (`checkStmt`'s own sequential 'var' case
					// handles those, in textual order, instead). An ambient declaration has no such ordering -- it isn't "executed", it just
					// asserts the binding exists globally -- so unlike its non-ambient counterpart, it needs to be forward-visible the same way
					// `declare function`/`declare class` already are above.
					if (ambient)
						hoistVars1(scope, stmt.declarations, stmt.kind !== 'const');
					break;
			}
		}
		// several same-named declarations are overloads: the bodyless signatures are the public face,
		// exposed as an object type with one call member each; a single declaration stays a plain function
		for (const [name, decls] of fnGroups) {
			const sigs		= decls.filter(d => !d.body);
			const chosen	= sigs.length ? sigs : decls;
			if (chosen.length > 1) {
				scope.values.set(name, { type: 'object', members: chosen.map((d): TS.TypeMember => ({ kind: 'call', ...T.fnSigParamsReturn(d, T.ANY) })) });
			} else {
				const d = chosen[0];
				const t = { type: 'function', ...T.fnSigParamsReturn(d, T.ANY) } as const;
				if (!d.returnType && d.body)
					fnBodies.set(t, { body: d.body, scope });
				scope.values.set(name, t);
			}
		}
	};

	const hoistVars1 = (scope: Scope, declarations: JS.VarDeclarator[], widen: boolean) => {
		for (const d of declarations) {
			// Resolve a `ref` annotation *now*, against this scope -- a `Type` has no scope of its own, so leaving it as a bare `{type:'ref', name}`
			// would defer resolution to whatever scope is active when a later, unrelated importing file looks it up and shadows the real one.
			if (typeof d.name === 'string') {
				const init = d.init && typeOf(d.init, scope);
				scope.values.set(d.name, d.typeAnnotation ? scope.resolve(d.typeAnnotation as Type) : init ? (widen ? T.widenLiterals(init) : init) : T.ANY);
			} else {
				T.bindingNames(d.name).forEach(n => scope.values.set(n, T.ANY));
			}
		}
	};


	// Infers types for top-level `var`/`const`/`let` only -- runs muted, just to resolve what a namespace/imported module *exposes*, not to check
	// it. Using the full `checkBlock` here used to mean eagerly checking every class's method bodies just to learn an unrelated const's type.
	const hoistVars = (stmts: TS.Statement[], scope: Scope) => {
		for (let stmt of stmts) {
			while (stmt.type === 'export_decl' || stmt.type === 'declare')
				stmt = stmt.declaration as TS.Statement;
			if (stmt.type === 'var')
				hoistVars1(scope, stmt.declarations, stmt.kind !== 'const');
		}
	};

	// Resolves what a `namespace X { ... }` block or a whole module body exposes, shared by `hoist`'s `namespace_decl` case and cross-file
	// module resolution. A namespace isn't just a value shape (an object type of its members) -- it's also its own type-namespace (`NS.Foo`
	// can appear in a type position), so the result is a genuine `Scope`, not a flattened `Type`: `scope`'s `.values`/`.types`/nested
	// namespaces hold exactly the exported bindings, keyed by their *public* (possibly renamed) name, with no `parent` -- a member access off
	// the namespace (`NS.foo`, or a type reference `NS.Foo`) must resolve within its own exported surface only, never fall through to the
	// enclosing lexical scope the way a bare declaration lookup would. `value` is what the namespace itself types as when used as a value
	// (ordinarily just `scope.toObject()`); `isAlias` marks the `export = X` (`.d.ts` re-export) convention, where the whole namespace
	// collapses to `X`'s own value and `value` diverges from `scope`'s member shape (nested-namespace type members of `X` aren't forwarded --
	// rare, `.d.ts`-only construct).
	const exportScope = (body: TS.Statement[], parent: Scope): { scope: Scope; value: Type; isAlias: boolean } => {
		// `hoist` + `hoistVars` (not full `checkBlock`): only top-level declaration *types* are needed, not a full check of a body checked separately.
		const inner = new Scope(parent);
		hoist(body, inner);
		hoistVars(body, inner);

		const assign = body.find(s => s.type === 'export_assignment');
		if (assign) {
			return {
				scope: inner.namespace(assign.expr) ?? new Scope(),
				value: inner.value(assign.expr) ?? T.ANY,
				isAlias: true,
			};
		}

		const scope = new Scope();
		// Parent-chain-aware (`inner.value`, not `inner.values.get`): an imported name legitimately declared in `body` may have been
		// resolved straight into `inner`'s parent (`hoist`'s own `case 'import'` fallback only fires when nothing already resolved it,
		// per its own comment) rather than duplicated onto `inner` itself, so an own-map-only read would miss it.
		const copy = (local: string, pub: string) => {
			const v = inner.value(local);
			if (v)
				scope.values.set(pub, v);
			const te = inner.typeEntry(local);
			if (te)
				scope.types.set(pub, te);
			const ns = inner.namespace(local);
			if (ns)
				scope.addNamespace(pub, ns);
		};

		if (body.some(s => s.type === 'export_decl' || s.type === 'export')) {
			for (const stmt of body) {
				if (stmt.type === 'export_decl') {
					const decl = T.unwrapDeclare(stmt.declaration);
					if (decl.type === 'var') {
						for (const d of decl.declarations) {
							if (typeof d.name === 'string')
								copy(d.name, d.name);
						}
					} else if ('name' in decl) {
						copy(decl.name, decl.name);
					}
				} else if (stmt.type === 'export' && !stmt.source && stmt.specifiers) {
					for (const spec of stmt.specifiers)
						copy(spec.local, spec.exported);
				}
			}
		} else {
			// Ambient `.d.ts` convention: a body with no `export` keyword anywhere implicitly exports every top-level declaration.
			for (const name of new Set([...inner.values.keys(), ...inner.types.keys()]))
				copy(name, name);
		}
		return { scope, value: scope.toObject(), isAlias: false };
	};


	// ---- lazy return-type inference -------------------------------------------------------------

	// Bodies of unannotated hoisted functions, keyed by their synthesized signature; the return type is inferred (and memoized onto the signature) only when a call or `TStoDecl` actually needs it.
	// `sig` already carries `params`/`rest` (in the exact shape `checkFunctionBody` wants), so nothing beyond `body`/`scope` needs capturing separately here.
	const fnBodies = new Map<TS.CallSig, { body: JS.Statement[]; scope: Scope }>();

	// `checkFunctionBody` infers and memoizes a return type onto a signature whenever called with no declared one -- `callReturn` just triggers that
	// walk for a lazily-registered body, muted (this is speculative, triggered by an unrelated call site, not a real check of `sig`'s declaration).
	const callReturn = (sig: TS.CallSig): Type => {
		const info = fnBodies.get(sig);
		if (info) {
			fnBodies.delete(sig);	// breaks recursion: a recursive call sees the placeholder `any`
			runMuted(() => checkFunctionBody(sig, info.body, info.scope));
		}
		return sig.returnType ?? T.ANY;
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
				return { type: 'literal', value: e.value };

			case 'bigint':		return T.BIGINT;
			case 'regex':		return T.REGEXP;
			case 'this':		return scope.value('this') ?? T.ANY;
			case 'identifier':	return scope.value(e.name) ?? T.ANY;

			case 'array': {
				const elems: Type[] = [];
				for (const el of e.elements) {
					if (!el)
						continue;
					if (el.type === 'spread') {
						const t = scope.resolve(typeOf(el.argument, scope));
						elems.push(t.type === 'array' ? t.element : T.ANY);
					} else {
						elems.push(maybeWidenLiterals(typeOf(el, scope)));
					}
				}
				return { type: 'array', element: elems.length ? T.combineTypes(elems) : T.ANY };
			}
			case 'object': {
				const members: TS.TypeMember[] = [];
				for (const p of e.properties) {
					if (p.kind === 'spread') {
						typeOf(p.argument, scope);
						return T.ANY;		// spread makes the shape unknowable here
					}
					if (typeof p.key !== 'string') {
						typeOf(p.value, scope);
						continue;
					}
					if (p.kind === 'get' || p.kind === 'set') {
						const fn = p.value;
						checkFunctionBody(fn, fn.body, scope, hasMod(fn, 'async'));
						if (p.kind === 'get')
							members.push({ kind: 'property', name: p.key, typeAnnotation: (fn.returnType as Type) ?? T.ANY });
					} else {
						// widen: object literal properties are mutable, so `{ sign: 0 }` has sign: number
						members.push({ kind: 'property', name: p.key, typeAnnotation: maybeWidenLiterals(typeOf(p.value, scope)) });
					}
				}
				return TS.ObjectType(members);
			}

			case 'function':
			case 'arrow': {
				checkFunctionBody(e, e.body, scope, hasMod(e, 'async'), e.type === 'function' && hasMod(e, 'generator'));
				return { type: 'function', ...T.fnSigParamsReturn(e, T.ANY) };
			}

			case 'member': {
				const key		= T.pathKey(e);
				const refined	= key && scope.value(key);	// dotted keys live only in narrowings
				if (refined)
					return refined;
				const objT = typeOf(e.object, scope);
				const t = T.lookupMember(objT, e.property, scope);
				if (!t && !e.optional && T.sealed(objT, scope))
					error`${pos}Property '${e.property}' does not exist on type '${objT}'`;
				return t ?? T.ANY;
			}
			case 'index': {
				const objT = scope.resolve(typeOf(e.object, scope));
				typeOf(e.property, scope);
				if (objT.type === 'array')
					return objT.element;
				if (objT.type === 'tuple' && e.property.type === 'literal' && typeof e.property.value === 'number') {
					const el = objT.elements[e.property.value];
					if (!el)
						error`${pos}Tuple type '${objT}' has no element at index ${e.property.value}`;
					return (el && T.tupleElementType(el)) ?? T.ANY;
				}
				if (e.property.type === 'literal' && typeof e.property.value === 'string') {
					const t = T.lookupMember(objT, e.property.value, scope);
					if (!t && T.sealed(objT, scope))
						error`${pos}Property '${e.property.value}' does not exist on type '${objT}'`;
					return t ?? T.ANY;
				}
				return T.ANY;
			}

			case 'call':
			case 'new': {
				const calleeT = scope.resolve(typeOf(e.callee, scope));

				let sig: TS.CallSig | undefined;
				const fnPart = (calleeT.type === 'intersection' ? calleeT.types.map(p => scope.resolve(p)) : [calleeT])
					.find(p => p.type === 'function' || p.type === 'constructor');
				if (fnPart) {
					sig = fnPart;
				} else if (calleeT.type === 'object') {
					// `new` prefers a construct signature, a plain call a bare call signature -- each falls back to the other when its preferred
					// kind is absent (real TS wouldn't allow that cross-fallback), matching this checker's existing leniency.
					const constructs = calleeT.members.filter(m => m.kind === 'construct');
					const callSigs = calleeT.members.filter(m => m.kind === 'call');
					const own = e.type === 'new' ? constructs : callSigs;
					const calls = own.length ? own : (e.type === 'new' ? callSigs : constructs);
					if (calls.length === 1) {
						sig = calls[0];		// several = overloads: not resolved, stay lenient
					} else if (!calls.length && T.sealed(calleeT, scope)) {
						error`${pos}Type '${calleeT}' is not callable in '${e}'`;
						return T.ANY;
					}
				}

				// Contextual parameter typing: an unannotated callback argument (`arr.map(x => x.foo)`) would otherwise
				// type its own parameters as `any` -- `checkFunctionBody` only ever looks at a parameter's own
				// `typeAnnotation`, with no notion of "how is this function being used". Filling that in here, from the
				// matching declared parameter's own (pre-generic-substitution) function type -- e.g. `.map`'s modeled
				// signature already knows its callback's parameter is the array's element type, with `U` only appearing
				// in the *return* position -- covers the common case without needing full bidirectional inference (a
				// declared parameter type that itself still references an *outer*, not-yet-inferred type parameter
				// just stays an unresolved ref, same lenient fallback as before this existed). Mutates the argument's
				// own AST node before it's ever type-checked, same as how a lazily-inferred return type gets written
				// back onto its own signature elsewhere in this file -- must run before `argTs` below, which is what
				// actually triggers `checkFunctionBody` on each argument.
				if (sig) {
					e.arguments.forEach((a, i) => {
						if (a.type !== 'function' && a.type !== 'arrow')
							return;
						const declared = sig!.params[i]?.typeAnnotation;
						const expected = declared && scope.resolve(declared as Type);
						if (expected && (expected.type === 'function' || expected.type === 'constructor')) {
							a.params.forEach((p, j) => {
								if (!p.typeAnnotation && expected.params[j]?.typeAnnotation)
									p.typeAnnotation = expected.params[j].typeAnnotation;
							});
						}
					});
				}

				const argTs = e.arguments.map(a => a.type === 'spread' ? (typeOf(a.argument, scope), undefined) : typeOf(a, scope));

				if (sig) {
					let params = sig.params;
					let retT = callReturn(sig);
					if (sig.typeParams?.length) {
						// instantiate the call: explicit type arguments, or inference from the argument types
						const map = new Map<string, Type>();
						if (e.typeArgs) {
							sig.typeParams.forEach((p, i) => map.set(p.name, (e.typeArgs as Type[])[i] ?? p.default ?? T.ANY));
						} else {
							const names = new Map(sig.typeParams.map(p => [p.name, p] as const));
							argTs.forEach((t, i) => { const p = params[i]; if (t && p?.typeAnnotation) inferTypeArgs(p.typeAnnotation, t, names, map, scope); });
							sig.typeParams.forEach(p => { if (!map.has(p.name)) map.set(p.name, p.constraint ?? p.default ?? T.ANY); });
						}
						params = params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteType(p.typeAnnotation, map) } : p);
						retT = T.substituteType(retT, map);
					}
					if (!argTs.some(t => t === undefined)) {	// no spread args
						const required = params.filter(p => !hasMod(p, 'optional')).length;
						const max = sig.rest ? Infinity : params.length;
						if (argTs.length < required || argTs.length > max)
							error`${pos}Expected ${required === max ? required : required + '-' + (max === Infinity ? 'more' : max)} arguments, but got ${argTs.length} in '${e}'`;
						argTs.forEach((t, i) => {
							const p = params[i];
							if (t && p && p.typeAnnotation) {
								// an optional parameter also accepts undefined
								if (!T.isAssignable(t, hasMod(p, 'optional') ? { type: 'union', types: [p.typeAnnotation, T.UNDEFINED] } : p.typeAnnotation, scope))
									error`${pos}Argument of type '${t}' is not assignable to parameter '${p.key}: ${p.typeAnnotation}' in '${e}'`;
								else
									checkExcessProps(e.arguments[i], p.typeAnnotation, scope, pos);
							}
						});
					}
					return retT;
				}
				return e.type === 'new' && e.callee.type === 'identifier' ? { type: 'ref', name: e.callee.name, typeArgs: e.typeArgs as Type[] | undefined } : T.ANY;
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
					case '~':		return T.isAny(scope.resolve(argT)) ? T.ANY : T.isBigint(argT, scope) ? T.BIGINT : T.NUMBER;
					default:		return argT;
				}
			}
			case 'update': {
				const t = typeOf(e.argument, scope);
				if (!T.isNumberLike(t, scope))
					error`${pos}Operand of '${e.operator}' must be numeric, got '${t}' in '${e}'`;
				return T.isAny(scope.resolve(t)) ? T.ANY : T.isBigint(t, scope) ? T.BIGINT : T.NUMBER;
			}
			case 'binary': {
				const lt = typeOf(e.left, scope), rt = typeOf(e.right, scope);
				if (COMPARISON_OPS.has(e.operator))
					return T.BOOLEAN;
				if (e.operator === '+') {
					const stringish = (t: Type): boolean => {
						const r = scope.resolve(t);
						return r.type === 'template_literal'
							|| (r.type === 'ref' && r.name === 'string')
							|| (r.type === 'literal' && typeof r.value === 'string')
							|| (r.type === 'union' && r.types.some(stringish));
					};
					if (stringish(lt) || stringish(rt))
						return T.STRING;
					if (T.isAny(scope.resolve(lt)) || T.isAny(scope.resolve(rt)))
						return T.ANY;		// could be string concatenation
				}
				for (const [t, side] of [[lt, e.left], [rt, e.right]] as const) {
					if (!T.isNumberLike(t, scope))
						error`${pos}Operand of '${e.operator}' must be numeric, got '${t}' in '${side}'`;
				}
				// An `any` operand means the result's bigint-vs-number split genuinely isn't known -- defaulting to `number` would wrongly reject a real bigint use.
				if (T.isAny(scope.resolve(lt)) || T.isAny(scope.resolve(rt)))
					return T.ANY;
				return T.isBigint(lt, scope) || T.isBigint(rt, scope) ? T.BIGINT : T.NUMBER;
			}
			case 'logical': {
				// `??` never yields the left side's nullish members, `||` never its falsy ones, `&&` never its
				// truthy ones. Widening keeps boolean literals: they encode which way a `&&`/`||` resolved
				const softWiden = (t: Type): Type =>
					t.type === 'literal' && typeof t.value !== 'boolean' ? maybeWidenLiterals(t)
					: t.type === 'union' ? T.combineTypes(t.types.map(softWiden))
					: t;
				const r = scope.resolve(softWiden(typeOf(e.left, scope)));
				return T.combineTypes([
					...(r.type === 'union' ? r.types : [r]).flatMap((m): Type[] => {
						const p = scope.resolve(m);
						if (e.operator === '??' ? T.isNullishType(p) : e.operator === '||' ? T.isFalsyType(p) : T.isTruthyType(p))
							return [];
						// a plain boolean only survives `||` as true, `&&` as false
						if (e.operator !== '??' && p.type === 'ref' && p.name === 'boolean')
							return [{ type: 'literal', value: e.operator === '||' }];
						// `&&`'s false path narrows a plain string/number to its one falsy literal (`""`/`0`) -- `||`'s truthy path has no
						// single such value (any non-empty string, any non-zero number), so only `&&` narrows here.
						if (e.operator === '&&' && p.type === 'ref' && (p.name === 'string' || p.name === 'number'))
							return [{ type: 'literal', value: p.name === 'string' ? '' : 0 }];
						return [m];
					}),
					softWiden(typeOf(e.right, e.operator === '&&' ? narrow(e.left, scope, true) : e.operator === '||' ? narrow(e.left, scope, false) : scope)),
				]);
			}

			case 'assign': {
				// assignments are judged against the declaration-site type, not any active narrowing -- for a dotted member
				// target (`this.handle = ...`) that means going through `lookupMember` on the object's own type, not `typeOf`
				// on the member expression itself, which would consult the dotted-path narrowings map first (e.g. a preceding
				// `if (this.handle)` guard narrows reads of `this.handle` to exclude `null`, but the assignment target itself
				// must still accept `null`, since that's what the field is actually declared as);
				// an optional property also accepts undefined
				const lt0	= e.left.type === 'identifier' ? (scope.declared(e.left.name) || typeOf(e.left, scope))
					: e.left.type === 'member' ? (T.lookupMember(typeOf(e.left.object, scope), e.left.property, scope) || typeOf(e.left, scope))
					: typeOf(e.left, scope);
				const lt	= e.left.type === 'member' && T.memberOptional(silentType(e.left.object, scope), e.left.property, scope) ? T.combineTypes([lt0, T.UNDEFINED]) : lt0;
				const rt	= typeOf(e.right, scope);
				if (e.operator === '=') {
					if (!T.isAssignable(rt, lt, scope)) {
						error`${pos}Type '${rt}' is not assignable to type '${lt}' in '${e.left} = ...'`;
					} else {
						checkExcessProps(e.right, lt, scope, pos);
						// later statements see the assigned type, not the (possibly wider) declared one
						if (e.left.type === 'identifier' && scope.declared(e.left.name))
							scope.addNarrowing(e.left.name, maybeWidenLiterals(rt));
					}
				} else if ((e.operator === '??=' || e.operator === '||=' || e.operator === '&&=') && e.left.type === 'identifier' && scope.declared(e.left.name)) {
					// `x ??= y` leaves x holding its non-nullish members or y (and likewise for ||= / &&=)
					const r = scope.resolve(lt);
					scope.addNarrowing(e.left.name, T.combineTypes([
						...(r.type === 'union' ? r.types : [r]).filter(m => {
							const p = scope.resolve(m);
							return e.operator === '??=' ? !T.isNullishType(p) : e.operator === '||=' ? !T.isFalsyType(p) : !T.isTruthyType(p);
						}),
						maybeWidenLiterals(rt),
					]));
				}
				return rt;
			}

			case 'conditional':
				typeOf(e.test, scope);
				return T.combineTypes([typeOf(e.consequent, narrow(e.test, scope, true)), typeOf(e.alternate, narrow(e.test, scope, false))]);

			case 'sequence':
				return e.expressions.map(x => typeOf(x, scope)).pop() ?? T.ANY;

			case 'spread':
				return typeOf(e.argument, scope);

			case 'tagged_template': {
				const t = scope.resolve(typeOf(e.tag, scope));
				e.quasi.forEach(p => p.exp && typeOf(p.exp, scope));
				return t.type === 'function' ? t.returnType! : T.ANY;
			}
			case 'yield':
				if (e.argument)
					typeOf(e.argument, scope);
				return T.ANY;

			case 'await': {
				const t = scope.resolve(typeOf(e.argument, scope));
				return t.type === 'ref' && t.name === 'Promise' && t.typeArgs?.length ? t.typeArgs[0] : t;
			}
			case 'class': {
				const { instance, value } = T.classShapes(e);
				checkClassMembers(e.name, e.body as TS.ClassMember[], instance, value, scope);
				return value;
			}
			case 'as_expression':
			case 'satisfies_expression': {
				const anno = e.typeAnnotation as Type;
				// `as const` suppresses the normal literal-widening `typeOf` does everywhere else (a bare
				// `'x'` would otherwise widen to `string` immediately, e.g. `['x','y'] as const` needs each
				// element to stay its own literal type) -- `satisfies` never suppresses widening, it only
				// checks assignability against `anno` on top of the expression's normally-widened type.
				const isConstAssertion = e.type === 'as_expression' && anno.type === 'ref' && anno.name === 'const';
				const t = typeOf(e.expression, scope, !isConstAssertion);
				if (e.type === 'satisfies_expression') {
					if (!T.isAssignable(t, anno, scope))
						error`${pos}Type '${t}' does not satisfy the expected type '${anno}'`;
					else
						checkExcessProps(e.expression, anno, scope, pos);
					return t;
				}
				return isConstAssertion ? t : anno;	// `as const`: keep the expression's own (unwidened) type
			}
			case 'non_null': {
				const t = scope.resolve(typeOf(e.expression, scope));
				if (t.type === 'union') {
					const parts = t.types.filter(x => !T.isNullishType(x));
					return parts.length ? T.combineTypes(parts) : t;
				}
				return t;
			}
			default:
				return T.ANY;
		}
	};

	// ---- functions / classes / statements -------------------------------------------------------

	const checkFunctionBody = (fnj: JS.CallSig, body: JS.Statement[] | Expr | undefined, scope: Scope, async?: boolean, skipReturn?: boolean) => {
		const fn = fnj as TS.CallSig;
		if (!body)
			return;
		const inner = new Scope(scope);
		for (const p of fn.params) {
			const anno = p.typeAnnotation;
			if (p.default) {
				const dt = typeOf(p.default, inner);
				if (anno && !T.isAssignable(dt, anno, inner))
					error`${(p as any).pos}Default value of type '${dt}' is not assignable to parameter type '${anno}'`;
			}
			if (typeof p.key === 'string')
				inner.values.set(p.key, anno ? (hasMod(p, 'optional') && !p.default ? T.combineTypes([anno, T.UNDEFINED]) : anno) : T.literalTypeOf(p.default) ?? T.ANY);
			else
				T.bindingNames(p.key).forEach(n => inner.values.set(n, T.ANY));
		}
		if (fn.rest)
			inner.values.set(fn.rest.key, (fn.rest.typeAnnotation as Type | undefined) ?? T.ANY);

		let expected = fn.returnType;
		if (expected && async) {
			const r = inner.resolve(expected);
			expected = r.type === 'ref' && r.name === 'Promise' ? r.typeArgs?.[0] ?? T.ANY : expected;
		}
		// A declared type predicate (`x is T`) is never checked against the body's own (boolean) return value, same as
		// `any` -- but unlike `any`, it must not be *inferred over* either: the body's boolean return type is not a
		// better answer than the predicate the signature already declares, so `fn.returnType` stays untouched below.
		const isPredicate = expected?.type === 'predicate';
		if (skipReturn || (expected && T.isAny(expected)) || isPredicate)
			expected = undefined;

		if (Array.isArray(body)) {
			if (expected) {
				checkBlock(body, inner, (argument: Expr|undefined, scope: Scope): void => {
					if (argument) {
						const t = typeOf(argument, scope, false);
						if (!T.isAssignable(t, expected, scope))
							error`${(argument as any).pos}Type '${t}' is not assignable to declared return type '${expected}'`;
						else
							checkExcessProps(argument, expected, scope, (argument as any).pos);
					}
				});
			} else {
				const returns: Type[] = [];
				checkBlock(body, inner, (argument: Expr|undefined, scope: Scope): void => {
					returns.push(argument ? T.widenLiterals(typeOf(argument, scope)) : T.VOID);
				});
				if (!isPredicate) {
					const combined = returns.length ? T.combineTypes(returns) : T.VOID;
					fn.returnType = (isBoolean(combined) && inferredPredicate(fn, body, inner)) || combined;
				}

			}
		} else {
			const t = typeOf(body, inner);
			if (expected && !T.isAssignable(t, expected, inner)) {
				error`${(body as any).pos}Type '${t}' is not assignable to declared return type '${expected}'`;
			} else if (!expected && !isPredicate) {
				const widened = T.widenLiterals(t);
				fn.returnType = (isBoolean(widened) && inferredPredicate(fn, body, inner)) || widened;
			}
		}
	};

	const checkClassMembers = (name: string | undefined, body: TS.ClassMember[], instance: Type, classValue: Type, scope: Scope) => {
		const instScope = new Scope(scope);
		// prefer the named entry: declaration merging can extend it beyond this declaration's shape
		instScope.values.set('this', name && scope.typeEntry(name) ? { type: 'ref', name } : instance);
		const statScope = new Scope(scope);
		statScope.values.set('this', classValue);
		for (const m of body) {
			const inner = m.type === 'static_block' || ('modifiers' in m && hasMod(m, 'static')) ? statScope : instScope;
			if (m.type === 'field') {
				if (m.value) {
					const t = typeOf(m.value, inner);
					if (m.typeAnnotation && !T.isAssignable(t, m.typeAnnotation as Type, inner))
						error`${(m as any).pos}Type '${t}' is not assignable to type '${m.typeAnnotation as Type}'`;
					else if (m.typeAnnotation)
						checkExcessProps(m.value, m.typeAnnotation as Type, inner, (m as any).pos);
				}
			} else if (m.type === 'method') {
				const fn = m.value;
				checkFunctionBody(fn, fn.body, inner, hasMod(fn, 'async'), hasMod(fn, 'generator') || m.kind === 'set' || m.key === 'constructor');
			} else if (m.type === 'static_block') {
				checkBlock(m.body, new Scope(inner));
			}
		}
	};

	// Every leaf of an if/else chain (or a block's final statement) assigns the same variable:
	// yields the assigned expressions so the post-if type can merge the branches
	const assignRights = (st: TS.Statement, name?: string): { name: string; rights: Expr[] } | undefined => {
		if (st.type === 'expression' && st.expression.type === 'assign' && st.expression.operator === '=' && st.expression.left.type === 'identifier' && (!name || st.expression.left.name === name))
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
		const pos = (stmt as any).pos;
		switch (stmt.type) {
			case 'var':
				for (const d of stmt.declarations) {
					const anno = d.typeAnnotation as Type;
					const init = d.init && typeOf(d.init, scope);
					if (anno && init && !T.isAssignable(init, anno, scope))
						error`${pos}Type '${init}' is not assignable to type '${anno}' in declaration of '${d.name}'`;
					else if (anno && d.init)
						checkExcessProps(d.init, anno, scope, pos);
					if (typeof d.name === 'string') {
						scope.values.set(d.name, anno ?? (init ? (stmt.kind === 'const' ? init : T.widenLiterals(init)) : T.ANY));
						if (stmt.kind === 'const' && d.init)
							scope.addAlias(d);
					} else {
						T.bindingNames(d.name).forEach(n => scope.values.set(n, T.ANY));
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
				if (stmt.init) {
					if (stmt.init.type === 'var')
						checkStmt(stmt.init, inner);
					else
						typeOf(stmt.init, inner);
				}
				if (stmt.test)
					typeOf(stmt.test, inner);
				if (stmt.update)
					typeOf(stmt.update, inner);
				checkStmt(stmt.body, inner, onReturn);
				break;
			}
			case 'for_in': {
				const inner = new Scope(scope);
				const rightT = inner.resolve(typeOf(stmt.right, inner));
				const elemT = stmt.kind === 'in' ? T.STRING
					: rightT.type === 'array' ? rightT.element
					: rightT.type === 'ref' && rightT.name === 'string' ? T.STRING
					: T.ANY;
				if (stmt.left.type === 'var') {
					for (const d of stmt.left.declarations)
						if (typeof d.name === 'string')
							inner.values.set(d.name, (d.typeAnnotation as Type | undefined) ?? elemT);
						else
							T.bindingNames(d.name).forEach(n => inner.values.set(n, T.ANY));
				} else {
					typeOf(stmt.left, inner);
				}
				checkStmt(stmt.body, inner, onReturn);
				break;
			}
			case 'return':
				onReturn?.(stmt.argument, scope);
				break;
			case 'switch': {
				typeOf(stmt.discriminant, scope);
				// A `case` with no body falls through to the next -- `x.prop === literal` (discriminated union) narrowing
				// already exists for `if`; reuse it here by synthesizing that same binary test per case, OR-ing together
				// every fallthrough case sharing this block's body. A bare `default` (no test, nothing pending) would need
				// "none of the other cases' values" narrowing, which isn't modeled -- its body stays checked unnarrowed.
				let pending: Expr[] = [];
				for (const c of stmt.cases) {
					if (c.test) {
						typeOf(c.test, scope);
						pending.push({ type: 'binary', operator: '===', left: stmt.discriminant, right: c.test });
					}
					if (c.consequent.length || !c.test) {
						const test = pending.reduce<Expr | undefined>((acc, t) => acc ? { type: 'logical', operator: '||', left: acc, right: t } : t, undefined);
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
						inner.values.set(stmt.handlerParam, T.ANY);
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
					checkFunctionBody(stmt, stmt.body, scope, hasMod(stmt, 'async'), hasMod(stmt, 'generator'));
				break;
			case 'class_decl': {
				const { instance, value } = T.classShapes(stmt);
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

			// declare / type_alias_decl / interface_decl / enum_decl / import / export /
			// empty / debugger / continue / break: declaration-only or nothing to check (hoist saw them)
		}
	};

	const global = new Scope();
	for (const [n, r] of [['BigInt', T.BIGINT], ['Number', T.NUMBER], ['String', T.STRING], ['Boolean', T.BOOLEAN]] as const)
		global.values.set(n, { type: 'function', params: [{ key: 'value', modifiers: ['optional'], typeAnnotation: T.ANY }], returnType: r });

	global.values.set('undefined', T.UNDEFINED);
	global.values.set('NaN', T.NUMBER);
	global.values.set('Infinity', T.NUMBER);
	global.values.set('Array', TS.ObjectType([
		// `Array(n)`/`Array<T>(n)`/`new Array(n)`: the constructor call itself, not a static method.
		{ kind: 'call', typeParams: [{ name: 'T' }], params: [{ key: 'arrayLength', modifiers: ['optional'], typeAnnotation: T.NUMBER }], returnType: { type: 'array', element: { type: 'ref', name: 'T' } } },
		{ kind: 'property', name: 'prototype', typeAnnotation: T.ANY },
		{
			kind: 'method', name: 'from', typeParams: [{ name: 'T' }],
			params: [
				{ key: 'arrayLike', typeAnnotation: T.ANY },
				{ key: 'mapfn', modifiers: ['optional'], typeAnnotation: { type: 'function', params: [{ key: 'v', typeAnnotation: T.ANY }, { key: 'k', typeAnnotation: T.NUMBER }], returnType: { type: 'ref', name: 'T' } } },
				{ key: 'thisArg', modifiers: ['optional'], typeAnnotation: T.ANY },
			],
			returnType: { type: 'array', element: { type: 'ref', name: 'T' } },
		},
		// A plain `boolean` return would lose `Array.isArray`'s narrowing power (`if (Array.isArray(x))` needs `x is any[]` to narrow `x`).
		{ kind: 'method', name: 'isArray', params: [{ key: 'a', typeAnnotation: T.ANY }], returnType: { type: 'predicate', paramName: 'a', assertedType: { type: 'array', element: T.ANY } } },
		{
			kind: 'method', name: 'of', typeParams: [{ name: 'T' }], params: [],
			rest: { key: 'items', typeAnnotation: { type: 'ref', name: 'T' } },
			returnType: { type: 'array', element: { type: 'ref', name: 'T' } },
		},
	]));

	return {
		global, typeOf, checkBlock, exportScope,

		inferReturn: (fnj: JS.Function, outer: Scope): Type => {
			const sig = { ...fnj } as TS.CallSig;
			runMuted(() => checkFunctionBody(sig, fnj.body, outer));
			return sig.returnType ?? T.VOID;
		}
	};
}
