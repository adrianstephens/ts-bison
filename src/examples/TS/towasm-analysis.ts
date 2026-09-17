// AST queries over names and free variables -- the closure-capture analysis, and the small predicates
// the lowering asks about an expression's shape. Kept out of `towasm.ts` because none of it knows about
// wasm: every function here answers a question about the TypeScript AST.
//
// `collectCapturedMutables` is the substantive one: which of a body's own bindings a nested closure both
// captures and assigns, i.e. the locals that must become shared heap holders rather than plain wasm
// locals. The rest are shape predicates (`isPurePath`, `exprMentionsName`, `assignsToThis`) and name
// collection (`ownBoundNames`/`collectFreeVars`/`namesSelfAsValue`).

import { walkerB } from './walker';
import { bindingNames } from './type-utils';
import * as JS from './js-parser';
import type { Expr, BindingTarget } from './js-parser';
import type { Stmt, Type } from './ts-parser';

// `as` is a pure pass-through in codegen (`case 'as'` just compiles `e.expression`), but `checkerTypeOf` still honors the
// asserted type -- any codegen-facing type/owner lookup must unwrap it first or it sees a fictional type, losing method/owner dispatch.
function unwrapAs(e: Expr): Expr {
	while (e.type === 'as')
		e = e.expression;
	return e;
}

// An identifier, `this`, or a non-optional member/index chain of one: reading it again has no side effect and
// names the same storage both times. A literal is pure only as an INDEX -- a literal BASE (`/re/.lastIndex`) can be a fresh object each read.
function isPurePath(e: Expr): boolean {
	switch (e.type) {
		case 'identifier':
		case 'this':	return true;
		case 'member':	return !e.optional && isPurePath(e.object);
		// `typeof value !== 'object'` keeps out a regex (fresh each read) and a template's arbitrary sub-expressions.
		case 'index':	return !e.optional && isPurePath(e.object) && (isPurePath(e.index) || (e.index.type === 'literal' && typeof e.index.value !== 'object'));
		default:		return false;
	}
}

// Whether expression tree `e` references identifier `name` anywhere, not descending into a nested
// arrow/function's own body (closure boundary) -- same idiom as the named-function self-reference
// check a few hundred lines down (`e.type === 'identifier' && e.name === selfName`).
function exprMentionsName(name: string, e: Expr): boolean {
	return walkerB(undefined, (ex, process) =>
		ex.type === 'identifier' && ex.name === name ? true
		: (ex.type === 'arrow' || ex.type === 'function') ? false
		: process(ex)).expression(e);
}

// Whether `body` assigns to `this` anywhere -- real TS never allows this, so it has exactly one meaning
// here: "this method replaces its own receiver's physical value" (a wasm-GC array/struct can't resize in place). Detected structurally -- any method on any class doing this gets the same treatment, not a hardcoded list.
function assignsToThis(body: Stmt[]): boolean {
	return walkerB(undefined, (e, process) => e.type === 'assign' && !e.operator && e.target.type === 'this' ? true : process(e)).statements(body);
}


// For error messages only.
function describeBinding(t: BindingTarget): string {
	return typeof t === 'string' ? t : t.type === 'array_pattern' ? '[...]' : '{...}';
}

// ===================================================================
//  Closures -- free-variable analysis
// ===================================================================

function paramNames(params: JS.Param<Type>[], rest?: JS.Rest<Type>): string[] {
	const names = params.flatMap(p => bindingNames(p.key));
	return rest ? [...names, ...bindingNames(rest.key)] : names;
}

// Every name body binds directly (own params + var_decls), not descending into nested arrow/function bodies.
function ownBoundNames(names: string[], body: Stmt[] | Expr, selfName?: string): Set<string> {
	const bound = new Set(names);
	if (selfName)
		bound.add(selfName);
	// A `for`'s own `init` (e.g. `for (let i = ...)`) reaches this same `var_decl` case too -- walker.ts
	// routes it through the real statement walk, not just a bare declarator walk, so no separate case is
	// needed here to keep a closure's own loop variable from being mistaken for a free (captured) one.
	walkerB(
		(s, process) => {
			// A nested `function_decl` binds its own name in the enclosing scope (like a `var_decl`
			// would), but its body is a separate closure boundary -- its own params/locals/further-nested
			// declarations must not leak into `bound` here, same reasoning as the `arrow`/`function` stop below.
			if (s.type === 'function_decl') {
				bound.add(s.name);
				return false;
			}
			if (s.type === 'var_decl') {
				for (const d of s.declarations)
					bindingNames(d.name).forEach(n => bound.add(n));
			}
			return process(s);
		},
		(e, process) => (e.type === 'arrow' || e.type === 'function') ? false : process(e)
	).body(body);
	return bound;
}

// Recursively collects free variables into `free`. A nested closure's bound names merge into `bound`
// before recursing, so a level-2 capture of a level-0 variable transitively appears in level-1's set.
function collectFreeVars(bound: Set<string>, body: Stmt[] | Expr, free: Set<string>) {
	walkerB(
		(s, process) => {
			// Mirrors the `arrow`/`function` expression handling below, but for a nested function
			// *declaration* statement -- its own name is already bound (see `ownBoundNames`), so this only
			// needs to stop descent and collect its body's free vars under its own (merged) bound set.
			if (s.type === 'function_decl') {
				collectClosureFreeVars(bound, s, s.name, free);
				return false;
			}
			return process(s);
		},
		(e, process) => {
			if (e.type === 'identifier') {
				if (!bound.has(e.name))
					free.add(e.name);
				return false;
			}
			if (e.type === 'this') {
				if (!bound.has('this'))
					free.add('this');
				return false;
			}
			if (e.type === 'arrow' || e.type === 'function') {
				collectClosureFreeVars(bound, e, e.type === 'function' ? e.name : undefined, free);
				return false;
			}
			return process(e);
		}
	).body(body);
}

// Whether a nested function's body names it other than as the callee of a direct self-call: a value use, or any mention
// inside a closure within it (a capture). Such a body needs its own name bound (`emitClosureLiteral`).
function namesSelfAsValue(body: Stmt[] | Expr, name: string): boolean {
	let found = false;
	const inClosure = (fn: Parameters<typeof collectClosureFreeVars>[1], self: string | undefined) => {
		const free = new Set<string>();
		collectClosureFreeVars(new Set(), fn, self, free);
		return free.has(name);
	};
	walkerB(
		(st, process) => {
			if (found)
				return false;
			if (st.type === 'function_decl') {
				found = inClosure(st, st.name);
				return false;
			}
			return process(st);
		},
		(e, process) => {
			if (found)
				return false;
			if (e.type === 'identifier') {
				found = e.name === name;
				return false;
			}
			if (e.type === 'arrow' || e.type === 'function') {
				found = inClosure(e, e.type === 'function' ? e.name : undefined);
				return false;
			}
			if (e.type === 'call' && e.callee.type === 'identifier' && e.callee.name === name) {
				found = e.arguments.some(a => namesSelfAsValue(a as Expr, name));
				return false;
			}
			return process(e);
		}
	).body(body);
	return found;
}

// A closure's free variables: its body's and its parameter defaults', since a default runs inside the callee.
function collectClosureFreeVars(outer: Set<string>, fn: { params: JS.Param<Type>[]; rest?: JS.Rest<Type>; body?: Stmt[] | Expr }, selfName: string | undefined, free: Set<string>) {
	const body = fn.body ?? [];
	const bound = new Set([...outer, ...ownBoundNames(paramNames(fn.params, fn.rest), body, selfName)]);
	collectFreeVars(bound, body, free);
	for (const p of fn.params)
		if (p.default)
			collectFreeVars(bound, p.default, free);
}

// Names this body declares that a nested closure captures AND something assigns -- the locals that must
// become shared heap holders rather than plain wasm locals. A closure captures a BINDING in JS, not a
// value: `let n = 1; const f = () => n + 1; n = 4;` must have `f()` see 4, and a write inside the
// closure must be visible outside it (the counter idiom). Copying the value into the env struct gives
// neither. `ensureForwardHolder` already builds exactly the right thing -- and `emitClosureLiteral`
// already captures the HOLDER rather than its contents -- but only ever fired for a name used before its
// own declaration ran, so a local declared before the closure was silently captured by value.
// Deliberately over-approximate: a name assigned anywhere at all (including only inside the closure, or
// only before it is ever captured) is holder-backed, and an outer-scope name reaching the set is harmless
// because the answer is only ever consulted when DECLARING a local of that name here. A needless holder
// costs an allocation and an indirection; a missing one is a wrong answer.
// Not yet applied to a captured+mutated PARAMETER, which has the same problem and no `var_decl` to hang
// the holder off.
function collectCapturedMutables(body: Stmt[]): Set<string> {
	const captured	= new Set<string>();
	const assigned	= new Set<string>();
	// A `for (let i = ...)` binding is PER-ITERATION in JS: every iteration gets a fresh one, so each
	// closure created in the loop captures its own. Copying the value into the env -- what capture already
	// did -- is therefore already right, and one shared holder is actively wrong: every closure would then
	// see the loop's final value. `Promise.all`'s own `promises[i].then(v => { values[i] = v; })` is
	// exactly this, and a shared holder had it writing past the end of `values`.
	// (A body that REASSIGNS the variable after creating the closure still isn't modelled -- that needs a
	// fresh holder per iteration, which is the real general answer.)
	// `var` is the exact opposite and must NOT be listed here: it is function-scoped, so the whole loop
	// shares ONE binding and every closure sees its final value -- the shared holder is the correct answer
	// there, and copying by value gave `for (var i...) fs.push(() => i)` a 0 where JS says 3.
	const perIteration = new Set<string>();
	walkerB(
		(st, process) => {
			// A nested function is a closure boundary: everything free in it is captured from here (or
			// from further out, which is harmless -- an outer name simply isn't one of our locals).
			if (st.type === 'for' && st.init && !Array.isArray(st.init) && st.init.type === 'var_decl' && st.init.kind !== 'var') {
				for (const d of st.init.declarations)
					if (typeof d.name === 'string')
						perIteration.add(d.name);
			}
			if (st.type === 'function_decl') {
				const nested = st.body ?? [];
				collectFreeVars(ownBoundNames(paramNames(st.params, st.rest), nested, st.name), nested, captured);
				walkerB(undefined, (e, p) => { noteAssignExpr(e, assigned); return p(e); }).statements(nested);
				return false;
			}
			return process(st);
		},
		(e, process) => {
			if (e.type === 'arrow' || e.type === 'function') {
				const nested = e.body ?? [];
				collectFreeVars(ownBoundNames(paramNames(e.params, e.rest), nested, e.type === 'function' ? e.name : undefined), nested, captured);
				// ...and assignments INSIDE the closure count too: `() => { n = n + 1; }` is the whole point.
				walkerB(undefined, (x, p) => { noteAssignExpr(x, assigned); return p(x); }).body(nested);
				return false;
			}
			// An object literal's METHOD closes over this scope exactly as an arrow does -- a `defineProperty` accessor
			// (`get() { resolving = true; ... }`) mutates the very locals it closes over, and a copy loses the write.
			if (e.type === 'object')
				for (const m of e.properties)
					if (m.type === 'method' || m.type === 'get' || m.type === 'set') {
						const nested = m.body ?? [];
						collectFreeVars(ownBoundNames(paramNames(m.params, m.rest), nested, undefined), nested, captured);
						walkerB(undefined, (x, p) => { noteAssignExpr(x, assigned); return p(x); }).statements(nested);
					}
			noteAssignExpr(e, assigned);
			return process(e);
		}
	).statements(body);
	return new Set([...captured].filter(n => assigned.has(n) && !perIteration.has(n)));
}

// Every identifier this expression assigns to -- `x = v`, any compound form, and `++`/`--`.
function noteAssignExpr(e: Expr, into: Set<string>) {
	if (e.type === 'assign' && e.target.type === 'identifier')
		into.add(e.target.name);
	else if ((e.type === 'unary' || e.type === 'unary_post') && (e.operator === '++' || e.operator === '--') && e.operand.type === 'identifier')
		into.add(e.operand.name);
}

export {
	unwrapAs, isPurePath, exprMentionsName, assignsToThis, describeBinding,
	paramNames, ownBoundNames, collectFreeVars, namesSelfAsValue,
	collectClosureFreeVars, collectCapturedMutables, noteAssignExpr,
};
