/* eslint-disable @typescript-eslint/no-unused-expressions */
import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Literal, hasMod, Location, getPos } from '../common';
import { isTsDeclaration, walker, walkerB } from './walker';
import * as T from './type-utils';
import { printer } from './printer';

export const SEVERITY = {
	GAP:		0,	// known missing functionality (see the header's own gap list) -- not a judgment call, just a reminder
	WARNING:	1,
	ERROR:		2,
} as const;
export type SEVERITY = (typeof SEVERITY)[keyof typeof SEVERITY];
export type Err = (sev: SEVERITY, pos: Location) => (strings: TemplateStringsArray, ...values: (string | number | undefined)[]) => void;
// A fresh printer per interpolated value: `typeBudget` is spent per `Output` instance, never reset.
const show = () => printer({ typeBudget: 4096 });

type Type		= TS.Type;
type Expr		= TS.Expr;
type Stmt		= TS.Stmt;
type Scope		= T.Scope;
const Scope		= T.Scope;

// ===================================================================
//  TStypeCheck -- structural type checking of a parsed TS AST
// ===================================================================
// Partial. An unmodeled case reports `SEVERITY.GAP`; the old silent-`any` leniency is being removed (memory/tison_workaround_inventory.md), never extended.
// Known gaps: 
//  - generic inference is structural-argument-matching only (no bidirectional/contravariant/contextual)
//  - narrowing covers identifiers/dotted paths only (no CFG/reassignment invalidation)
//  - overload resolution needs exactly one arity+type fit (no best-guess)
//  - keyof/mapped/indexed-access resolve only for literal keys
//  - conditional types resolve only when non-distributive and concrete (no `infer`)


const COMPARISON_OPS 	= new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>=', 'in', 'instanceof']);
const LOGICAL_OPS		= new Set(['&&', '||', '??']);

const TYPED_ARRAY_RANGES = new Map<string, T.NumRange>([
	['Int8Array',			{ base: 'number', min: -0x80, 					max: 0x7f, 					integer: true }],
	['Uint8Array',			{ base: 'number', min: 0, 						max: 0xff, 					integer: true }],
	['Uint8ClampedArray',	{ base: 'number', min: 0, 						max: 0xff, 					integer: true }],
	['Int16Array',			{ base: 'number', min: -0x8000, 				max: 0x7fff, 				integer: true }],
	['Uint16Array',			{ base: 'number', min: 0, 						max: 0xffff, 				integer: true }],
	['Int32Array',			{ base: 'number', min: -0x80000000, 			max: 0xffffffff, 			integer: true }],
	['Uint32Array',			{ base: 'number', min: 0, 						max: 0xffffffff, 			integer: true }],
	['Float32Array',		{ base: 'number', min: 0, 						max: 0xff, 					integer: false }],
	['Float64Array',		{ base: 'number', min: 0, 						max: 0xff, 					integer: false }],
	['BigInt64Array',		{ base: 'bigint', min: -0x8000000000000000n, 	max: 0x7fffffffffffffffn, 	integer: true }],
	['BigUint64Array',		{ base: 'bigint', min: 0n, 						max: 0xffffffffffffffffn, 	integer: true }],
]);

// ===================================================================
//  statement utils
// ===================================================================

// A body with zero `return`s normally infers `void` -- but if every path ends in `throw`, real TS infers `never`
// instead, which (unlike `void`) is assignable to any declared return type. Not a full CFG.
function alwaysThrows(stmt: Stmt | undefined): boolean {
	if (!stmt)
		return false;
	switch (stmt.type) {
		case 'throw':	return true;
		case 'block':	return stmt.body.length > 0 && alwaysThrows(stmt.body[stmt.body.length - 1]);
		case 'if':		return !!stmt.alternate && alwaysThrows(stmt.consequent) && alwaysThrows(stmt.alternate);
		case 'try':		return stmt.handlers.every(h => alwaysThrows(h.body[h.body.length - 1])) && alwaysThrows(stmt.body[stmt.body.length - 1]);
		default:		return false;
	}
}

// Control never reaches the statement after this switch through a clause: none `break`s out, and the last clause exits
// (return/throw/continue). Falling out of the switch then means no case matched.
function clausesNeverFallOut(stmt: Stmt & { type: 'switch' }): boolean {
	const exitsPast = (s: Stmt): boolean => s.type === 'return' || s.type === 'throw' || s.type === 'continue'
		|| (s.type === 'block' && s.body.length > 0 && exitsPast(s.body[s.body.length - 1]))
		|| (s.type === 'if' && !!s.alternate && exitsPast(s.consequent) && exitsPast(s.alternate));
	// A `break` inside a nested loop or switch targets that, not this switch; any other one (labelled too) leaves it.
	const breaksOut = (s: Stmt): boolean => {
		switch (s.type) {
			case 'break':		return true;
			case 'block':		return s.body.some(breaksOut);
			case 'if':			return breaksOut(s.consequent) || (!!s.alternate && breaksOut(s.alternate));
			case 'try':			return s.body.some(breaksOut) || s.handlers.some(h => h.body.some(breaksOut)) || !!s.finalizer?.some(breaksOut);
			case 'labeled':		return breaksOut(s.body);
			default:			return false;
		}
	};
	const last = stmt.cases[stmt.cases.length - 1];
	return !!last?.consequent.length && exitsPast(last.consequent[last.consequent.length - 1]) && !stmt.cases.some(c => c.consequent.some(breaksOut));
}

// The test under which no case of `stmt` matched: every case test negated, ANDed; undefined without cases.
function noCaseMatched(stmt: Stmt & { type: 'switch' }): Expr | undefined {
	return stmt.cases.flatMap(c => c.test ? [{ type: 'unary', operator: '!', operand: { type: 'binary', operator: '===', left: stmt.discriminant, right: c.test } } as Expr] : [])
		.reduce<Expr | undefined>((acc, t) => acc ? { type: 'binary', operator: '&&', left: acc, right: t } : t, undefined);
}

// Conservative "this statement never falls through" -- powers guard-clause narrowing
function alwaysExits(stmt: Stmt): boolean {
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

// Control never reaches the end of a function body ending with `stmt`: every path returns or throws (TS's unreachable end point,
// which alone adds an implicit `undefined` return).
function endsFunction(stmt: Stmt | undefined): boolean {
	if (!stmt)
		return false;
	switch (stmt.type) {
		case 'return':
		case 'throw':	return true;
		case 'block':	return endsFunction(stmt.body[stmt.body.length - 1]);
		case 'if':		return !!stmt.alternate && endsFunction(stmt.consequent) && endsFunction(stmt.alternate);
		case 'try':		return !!stmt.finalizer && endsFunction(stmt.finalizer[stmt.finalizer.length - 1])
							|| endsFunction(stmt.body[stmt.body.length - 1]) && stmt.handlers.every(h => endsFunction(h.body[h.body.length - 1]));
		case 'switch':	return stmt.cases.some(c => !c.test) && clausesNeverFallOut(stmt);
		default:		return false;
	}
}

// Conservative "this statement never falls through" -- powers guard-clause narrowing
function alwaysReturns(stmt: JS.Stmt<any> | undefined): boolean {
	if (!stmt)
		return false;
	switch (stmt.type) {
		case 'return':
			return true;
		case 'block':
			return stmt.body.length > 0 && alwaysReturns(stmt.body[stmt.body.length - 1]);
		case 'if':
			return !!stmt.alternate && alwaysReturns(stmt.consequent) && alwaysReturns(stmt.alternate);
		default:
			return false;
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

// A CONST CONTEXT travels as the expected type (`as const`'s own annotation), which keeps it cache-safe:
// `recurseCache` keys on (node, expected), so a node seen both inside and outside one cannot poison either.
// TS's const context, standing in for the contextual type `inner` it replaces: a literal keeps its literal type, and an array
// literal is a tuple -- readonly unless `inner` itself asks for a mutable array (TS's checkArrayLiteral). Each element and
// property passes on the part of `inner` it stands in: `{ args: [] } as const` against `{ args: Expr[] }` is mutable.
const constContext = (inner?: Type): TS.RefType => TS.RefType('const', inner ? [inner] : undefined);
const isConstContext = (t: Type | undefined): t is TS.RefType => t?.type === 'ref' && t.name === 'const' && (t.typeArgs?.length ?? 0) <= 1;
// The context a const context gives an element or property value: its own part of `inner` where TS's isConstContext reaches the
// value (a literal, array or object literal), none past anything else -- a conditional's branches, a call's result are ordinary.
const constContextOf = (e: Expr, inner: Type | undefined): Type | undefined => e.type === 'literal' || e.type === 'array' || e.type === 'object' ? constContext(inner) : undefined;
const hasMutableArrayLike = (t: Type, scope: Scope) => T.unionMembers(t, scope).some(m => {
	const r = T.resolveOwn(m, scope);
	return (r.type === 'array' || r.type === 'tuple') && !r.readonly || T.isRef(r, 'Array');
});
// What an array-like contextual type gives position `i`: a tuple's element there, an array's element type.
const positionContext = (t: Type, i: number, scope: Scope): Type | undefined => {
	const parts = T.unionMembers(t, scope).flatMap(m => {
		const r = T.resolveOwn(m, scope);
		const el = r.type === 'tuple' ? T.tupleElementType(r.elements[i]) : r.type === 'array' ? r.element
			: r.type === 'ref' && (r.name === 'Array' || r.name === 'ReadonlyArray') ? r.typeArgs?.[0] : undefined;
		return el ? [el] : [];
	});
	return parts.length ? T.combineTypes(parts) : undefined;
};


// Contextual parameter typing: an unannotated arrow/function (`x => x.foo`, whether a call argument, an object-literal
// property value, or the RHS of a typed `var_decl`/`satisfies`) would otherwise type its own params as `any`. Fills
// in whichever of `params` lack their own annotation from `expected`'s matching declared param type -- mutates the
// AST node in place, so it must run before the caller's own `checkFunctionBody`/`typeOf` walks those params.
// A contextual return type is only worth handing to a body when it carries STRUCTURE -- that is the
// whole mechanism (an array literal against a tuple becomes a tuple). A bare `ref` carries none: it is
// either an unsolved type parameter of the very call being inferred (`after<V, R>`'s own `R`, which
// says nothing about the body and measurably perturbed inference when threaded through) or a name the
// body's own expression resolves perfectly well without.
function shapedHint(t: Type | undefined, scope: Scope): Type | undefined {
	return t && T.resolveOwn(t, scope).type !== 'ref' ? t : undefined;
}

// TS's getReferenceCandidate: an assignment narrows as what it assigns to (`(x = next()) !== null`), a comma as its last operand.
function referenceOf(e: Expr): Expr {
	return	e.type === 'assign' && (!e.operator || e.operator === '??' || e.operator === '&&' || e.operator === '||') ? referenceOf(e.target)
		:	e.type === 'sequence' ? referenceOf(e.expressions[e.expressions.length - 1])
		:	e;
}

// The member and index reads that are assignment targets, read as declared rather than narrowed: an assignment is judged
// against the declaration (`x['o'] = true` after `x['o'] === false`), also through a destructuring target's leaves.
const assignmentTargets = new WeakSet<Expr>();
function markAssignmentTargets(e: Expr | undefined) {
	if (!e)
		return;
	if (e.type === 'member' || e.type === 'index')
		assignmentTargets.add(e);
	else if (e.type === 'array')
		e.elements.forEach(el => markAssignmentTargets(el?.type === 'spread' ? el.operand : el));
	else if (e.type === 'object')
		e.properties.forEach(p => markAssignmentTargets(p.type === 'spread' ? p.operand : p.type === 'field' ? p.value : undefined));
	else if (e.type === 'assign')
		markAssignmentTargets(e.target);
}

// A callback with an unannotated parameter takes its parameter types from its context (TS's `isContextSensitive`).
function isContextSensitive(a: Expr): a is Expr & { type: 'function' | 'arrow' } {
	return (a.type === 'function' || a.type === 'arrow') && a.params.some(p => !p.typeAnnotation);
}
// What a context-sensitive callback fits as before its context is chosen: any function (TS's `anyFunctionType`).
const ANY_FUNCTION = TS.FunctionType({ params: [], rest: JS.Rest('args', TS.ArrayType(T.ANY)) }, T.ANY);

// A parameter type that is, or through a union may be, an array of TUPLES (Map's `entries?: readonly (readonly [K, V])[] | null`).
function tupleShaped(t: Type, scope: Scope): boolean {
	return T.unionMembers(t, scope).some(m => {
		const r = T.resolveOwn(m, scope);
		const el = r.type === 'tuple' ? r : r.type === 'array' ? r.element : !T.isAny(r) && T.iterationTypes(m, scope)?.yield;
		return !!el && T.resolveOwn(el, scope).type === 'tuple';
	});
}

// The context a non-callback argument is typed in against `sig`'s parameter `declared`: ONE rule for the overload trial and the
// final pass, since a callback nested in the argument keeps the first context it is typed in (`new Map(xs.map(x => [a, b]))`).
function argContext(a: Expr, declared: Type | undefined, sig: TS.CallSig, scope: Scope): Type | undefined {
	if (!declared)
		return undefined;
	// A `const` type parameter (TS 5.0) infers from its argument AS IF it were written `as const`.
	// Its constraint is the contextual type the const context stands in for: `const R extends readonly X[]` is readonly.
	const constParam = declared.type === 'ref' && !declared.typeArgs ? sig.typeParams?.find(p => p.name === declared.name && p.const) : undefined;
	if (constParam)
		return constContext(constParam.constraint);
	// A GENERIC parameter still gives its tuple SHAPE to an array literal or a call (its type params land only as inert per-position
	// hints, so `[[k, v]]` and `xs.map(x => [a, b])` become tuples), and itself to an `as const` argument, which reads only mutability.
	const generic	= !!sig.typeParams?.some(p => T.mentionsTypeParam(declared, p.name));
	const constArg	= a.type === 'as' && isConstContext(a.typeAnnotation);
	return !generic || constArg || ((a.type === 'array' || a.type === 'call') && tupleShaped(declared, scope)) ? declared : undefined;
}

// Which overload a call resolves to: the first whose signature `candidateFits` accepts. `label` is for the
// diagnostic only -- `decls` may be an inherited set, so the callee's own name would often be wrong.
export function resolveOverload(label: string, decls: JS.Method<Type>[], args: Expr[], scope: Scope, typeArgs?: Type[]): JS.Method<Type> {
	if (decls.length === 1)
		return decls[0];
	if (args.some(a => a.type === 'spread'))
		throw `spread arguments are not supported in a call to overloaded '${label}'`;
	const found = decls.find(d => d.body && candidateFits(T.FixSig(d, T.ANY), args, scope, typeArgs));
	if (!found)
		throw `no overload of '${label}' matches this call`;
	return found;
}

// Whether `args` fit candidate `c` as TS's overload resolution asks (checkExpressionWithContextualType): each argument typed
// against the candidate's OWN parameter, since a literal's type depends on it (`new Map([['', true]])` fits only as tuples).
export function candidateFits(c: TS.CallSig, args: Expr[], scope: Scope, typeArgs?: Type[], typedIn = args.map(() => new Map<Type | undefined, Type>()), yieldCollector?: Type[], pos: Location = { line: 0, col: 0 }): boolean {
	const paramAt = (i: number) => c.params[i]?.typeAnnotation ?? (c.rest?.typeAnnotation && T.restArgType(c.rest.typeAnnotation, i - c.params.length, scope));
	// A callback fits as any function (the chosen candidate fixes its parameters later); every other argument gets the final pass's
	// own context (`argContext`). Muted and unwidened, typed once per distinct context (`typedIn`).
	const ts = args.map((a, i) => {
		if (a.type === 'spread' || isContextSensitive(a))
			return undefined;
		const ctx	= argContext(a, paramAt(i), c, scope);
		let t = typedIn[i].get(ctx);
		if (!t)
			typedIn[i].set(ctx, t = typeOf(a, scope, false, ctx, yieldCollector, undefined));
		return t;
	});
	return T.argsFit(instantiate(c, ts, typeArgs, scope, pos), args.map((a, i) => isContextSensitive(a) ? ANY_FUNCTION : ts[i]), scope, args.some(a => a.type === 'spread'));
}

// Returns the contextual signature it resolved, so a caller can also take its RETURN type -- an
// unannotated callback needs that to type its own body (`xs.map(x => [a, b])` against a `[K, V][]`
// parameter), not just its parameters.
function applyContextualParams(params: JS.Param<Type>[], expected: Type | undefined, scope: Scope) {
	const sig = expected && resolveFnMember(expected, scope);
	if (sig) {
		// Past the declared fixed parameters it is the REST that covers them, so its ELEMENT is the
		// contextual type -- `(_, a, b) => ...` against `(substring: string, ...args: any[]) => string`,
		// which is every `String.replace` callback. Written shape first: resolving `Array<T>` expands it
		// to the class's own object shape and loses the element.
		const restAnn	= sig.rest?.typeAnnotation;
		const asArray	= (t: Type | undefined) => t && t.type === 'array' ? t.element
			: t && t.type === 'ref' && t.name === 'Array' && t.typeArgs?.length === 1 ? t.typeArgs[0] : undefined;
		const restElem	= asArray(restAnn) ?? asArray(restAnn && T.resolveOwn(restAnn, scope));
		params.forEach((p, j) => {
			if (!p.typeAnnotation)
				p.typeAnnotation = sig.params[j]?.typeAnnotation ?? restElem;
		});
	}
	return sig || undefined;
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

// `instance`	is `new C(...)`/`this`'s type;
// `value`		is the class binding's type (construct sig ∩ static members).
// `scope`:		the class's declaring scope, stamped onto every result `ref` so a member resolved elsewhere still uses it.
// Makes an unannotated body's `sig.returnType` a self-memoizing accessor: the first read infers it (muted, `infer`) and replaces
// itself with the plain value, recorded on `decl` too -- the real declaration a compiler reads. While inferring it reads as absent
// (so inference sees nothing declared); a recursive call's reader falls back to `any`, as TS types such a recursion.
function lazyReturnType(sig: TS.CallSig, decl: { returnType?: Type }, scope: Scope, infer: () => void, fold = (t: Type) => t) {
	let resolving = false;
	Object.defineProperty(sig, 'returnType', {
		configurable: true,
		enumerable: true,
		get(): Type | undefined {
			if (resolving)
				return undefined;
			resolving = true;
			infer();
			return sig.returnType ?? T.ANY;
		},
		// Stamped here, not at the read site, so it happens exactly once whoever triggers inference.
		set(value: Type | undefined) {
			if (value)
				T.stampScope(value = fold(value), scope);
			Object.defineProperty(sig, 'returnType', { value, writable: true, configurable: true, enumerable: true });
			decl.returnType = value;
		},
	});
}

// The scopes a class's member bodies are checked in: instance members see `this` as the instance and the class's type params, static ones the constructor.
function classBodyScopes(c: TS.Class, scope: Scope, instance: Type, value: Type, superType?: Type): { inst: Scope; stat: Scope } {
	// A generic class's instance scope is flagged (`Scope.isGenericTemplate`): its method bodies are one template shared by every instantiation.
	const inst = new Scope(scope, !!c.typeParams?.length);
	// The polymorphic `this` type, so `return this` infers `this` and each call substitutes its receiver (TS's fluent `this`).
	// Its class prefers the named entry: declaration merging can extend it beyond this declaration's shape.
	inst.addValue('this', { type: 'this', of: c.name && scope.type(c.name) ? { type: 'ref', name: c.name } : instance });
	// `addTypeParam`, as `checkFunctionBody` registers its own: an unregistered `K` stays opaque to every member read through it.
	for (const p of c.typeParams ?? [])
		inst.addTypeParam(p.name, p.constraint ?? T.ANY);
	// `typeof C` when named, as TS types it: the structural value holds this very member, so a static `return this` would make a cyclic type.
	const stat = new Scope(scope);
	stat.addValue('this', c.name && scope.value(c.name) ? { type: 'typeof', name: c.name } : value);
	// `super`: the base's instance side in an instance member, its static side in a static one. `super(...)` invokes the base
	// CONSTRUCTOR instead, so the static side is bound for it too, under a key no identifier can spell.
	if (superType) {
		const staticSide: Type = superType.type === 'ref' && scope.value(superType.name) ? { type: 'typeof', name: superType.name } : T.ANY;
		inst.addValue('super', superType);
		inst.addValue('super()', staticSide);
		stat.addValue('super', staticSide);
	}
	inst.flowBoundary = stat.flowBoundary = isClassDecl(c);
	return { inst, stat };
}

const isClassDecl = (c: TS.Class) => 'type' in c && c.type === 'class_decl';

function flowContainer(scope: Scope): Scope {
	const s = new Scope(scope);
	s.flowBoundary = true;
	return s;
}

// A non-arrow function's body: its own `this`, which TS types `any` absent a `this:` parameter (ts-parser drops those), never the
// enclosing method's. An arrow keeps the enclosing `this`, so it does not come through here.
function ownThis(scope: Scope): Scope {
	scope.addValue('this', T.ANY);
	return scope;
}

function classShapes(c: TS.Class, scope: Scope): { instance: Type; value: Type; superType?: Type } {
	const members:			TS.TypeMember[] = [];
	const staticMembers:	TS.TypeMember[] = [];
	const ctorMembers:		TS.ClassMethod[] = [];

	// Fields needing lazy inference (below) get their getter installed only *after* this function's own `stampScope`
	// call at the bottom -- that call already walks every member's `typeAnnotation` once, and installing the getter
	// before it would make *that* walk the "first read", forcing inference right here (still mid-`hoist`, before
	// later-in-file declarations like `__asm` are hoisted) instead of at whatever later, real, post-hoist read asks.
	const pendingFieldInit: { prop: TS.TypeMember; init: Expr | Expr[]; inner?: Scope }[] = [];
	// Fields with neither an annotation nor an initializer: their type lives only in the constructor's own
	// `this.x = ...`, which can't be read here because the constructor may come later in `c.body`. Resolved
	// once the loop below has seen every member (`ctorMembers`), through the same lazy getter.
	const pendingCtorInit: { prop: TS.TypeMember; key: string }[] = [];
	// Unannotated method/getter bodies: their return types are inferred lazily, like a hoisted function's (`lazyReturnType`).
	const pendingReturns: { sig: TS.CallSig; decl: TS.ClassMethod }[] = [];

	// A member with overload signatures (bodyless) hides its implementation's own signature, as TS does: only the overloads are callable.
	const overloaded = new Set(c.body.flatMap(m => m.type === 'method' && !m.body ? [T.memberKey(m.key)] : []));
	for (const m of c.body) {
		if (m.type === 'index_signature') {
			members.push(TS.TypeIndex(m.paramName, m.paramType, m.typeAnnotation));
			continue;
		}
		if (m.type === 'method' && m.body && m.key !== 'constructor' && overloaded.has(T.memberKey(m.key)))
			continue;
		const key = 'key' in m && T.memberKey(m.key);
		if (key === undefined || key === false)
			continue;

		const list = hasMod(m, 'static') ? staticMembers : members;
		switch (m.type) {
			case 'field': {
				// No annotation falls back to inferring the initializer's own *widened* type, matching real TS' own field-inference.
				// Anything else (a call, `new`, ...) is queued into `pendingFieldInit`, resolved once the whole shape (and `hoist`'s later declarations
				const lit = m.typeAnnotation ? undefined : T.literalTypeOf(m.value);
				if (!m.typeAnnotation && !m.value && !hasMod(m, 'static')) {
					// `x;` -- real TS infers such a field from the assignments its own constructor makes to it.
					const prop = TS.TypeProperty(m.key, T.ANY, m.modifiers);
					pendingCtorInit.push({ prop, key });
					list.push(prop);
				} else if (m.typeAnnotation || lit || !m.value) {
					list.push(TS.TypeProperty(m.key, m.typeAnnotation ?? (lit && T.widenLiterals(lit)) ?? T.ANY, m.modifiers));
				} else {
					const prop = TS.TypeProperty(m.key, T.ANY, m.modifiers);
					pendingFieldInit.push({ prop, init: m.value });
					list.push(prop);
				}
				break;
			}
			case 'method':
				if (m.key === 'constructor') {
					// An overloaded constructor's implementation still declares its parameter properties, but not a signature.
					if (!(m.body && overloaded.has('constructor')))
						ctorMembers.push(m);
					// A parameter-property modifier is anything but the unrelated `'optional'` tag.
					for (const p of m.params)
						if (p.modifiers?.some(x => x !== 'optional') && typeof p.key === 'string')
							// The PARAMETER's own modifiers, not the constructor's -- `public b?: P` declares an
							// optional property; a default makes it always-assigned, so not optional then.
							members.push(TS.TypeProperty(p.key, p.typeAnnotation ?? T.literalTypeOf(p.default) ?? T.ANY, p.default ? p.modifiers.filter(x => x !== 'optional') : p.modifiers));
				} else {
					const member = TS.TypeMethod(m.key, T.withScope(T.FixSig(m, T.ANY), scope), m.modifiers);
					list.push(member);
					if (!m.returnType && m.body)
						pendingReturns.push({ sig: member, decl: m });
				}
				break;
			case 'get': {
				const prop = TS.TypeProperty(m.key, m.returnType ?? T.ANY);
				list.push(prop);
				if (!m.returnType && m.body) {
					const sig = T.FixSig(m, T.ANY);
					pendingReturns.push({ sig, decl: m });
					Object.defineProperty(prop, 'typeAnnotation', { get: () => sig.returnType, configurable: true, enumerable: true });
				}
				break;
			}
			case 'set':
				if (!list.some(x => x.type === 'property' && T.memberKey(x.key) === key))
					list.push(TS.TypeProperty(m.key, m.params[0]?.typeAnnotation ?? T.ANY));
				break;
		}
	}
	// Every `this.<key> = <expr>` written directly in a constructor body. Only top-level statements of the
	// body, not a nested closure's own assignments -- real TS looks wider, but this covers the shape that
	// actually declares a field's type, without inferring from a callback that runs who-knows-when.
	for (const { prop, key } of pendingCtorInit) {
		for (const ctor of c.body.filter((m): m is TS.ClassMethod => m.type === 'method' && m.key === 'constructor' && !!m.body)) {
			const inits = (ctor.body ?? []).flatMap(st =>
				st.type === 'expression' && st.expression.type === 'assign' && !st.expression.operator
				&& st.expression.target.type === 'member' && st.expression.target.object.type === 'this' && st.expression.target.property === key
					? [st.expression.value] : []);
			if (!inits.length)
				continue;
			// `this.p = o` names the CONSTRUCTOR's own parameter, which the class scope has never heard of --
			// resolved there it types as `any`, silently defeating the whole inference.
			const inner = new Scope(scope);
			inner.flowBoundary = isClassDecl(c);
			for (const p of T.FixParams(ctor).params)
				if (typeof p.key === 'string')
					inner.addValue(p.key, p.typeAnnotation ?? T.ANY);
			pendingFieldInit.push({ prop, init: inits, inner });
		}
	}

	const obj = TS.ObjectType(members);
	// a base the checker can't model (mixin call, namespace member, imported class) leaves the instance unsealed; likewise an inherited constructor accepts any arguments.
	// Own members come first: lookupMember's first match implements override precedence
	const superType: Type | undefined =
			c.superClass?.type === 'identifier' ? TS.RefType(c.superClass.name)
		:	c.superClass?.type === 'instantiation' && c.superClass.expression.type === 'identifier' ? TS.RefType(c.superClass.expression.name, c.superClass.typeArgs)
		:	c.superClass ? T.ANY : undefined;
	const instance		= superType ? TS.IntersectionType([obj, superType]) : obj;
	// The named ref carries its own type params back as its own typeArgs (`Box<T>` -> `new(...): Box<T>`) -- without this,
	// a bare `RefType(c.name)` never mentions `T`, so `new Box<number>(...)` produced a `Box` with no type args at all.
	const ctorReturn	= c.name ? TS.RefType(c.name, c.typeParams?.map(p => TS.RefType(p.name))) : instance;
	const makeCtorSig	= (params: TS.Params) => T.withScope(TS.CallSig(params, ctorReturn, c.typeParams), scope);
	// >1 real constructor body: a genuine overload set, same multi-signature shape `lookupMember` builds
	// for same-named methods and `hoist` builds for free-function overloads -- `case 'new'`'s existing
	// arity+type-fit resolution (via `T.collectMembers`'s `'construct'`-member filter) already handles it.
	const ctor: Type = ctorMembers.length > 1
		? TS.ObjectType(ctorMembers.map(m => TS.TypeConstruct(makeCtorSig(T.FixParams(m)))))
		: { type: 'constructor', ...makeCtorSig(ctorMembers.length ? T.FixParams(ctorMembers[0]) : {params: [], rest: c.superClass ? JS.Rest('args', TS.ArrayType(T.ANY)) : undefined}) };
	const value		= staticMembers.length ? TS.IntersectionType([ctor, TS.ObjectType(staticMembers)]) : ctor;
	T.stampScope(instance, scope);
	T.stampScope(value, scope);

	// A member's inferred type naming its own class's shape (`static make() { return A; }`) names it as TS does (`typeof A`, `A`):
	// the shape holds that very member, so embedding the shape itself would make the type cyclic.
	const selfRefs = (t: Type): Type => {
		const name = c.name;
		if (!name || !walkerB(undefined, undefined, (x, process) => x === value || x === instance || process(x)).type(t))
			return t;
		return walker(undefined, undefined, (x, process) => x === value ? { type: 'typeof', name } : x === instance ? ctorReturn : process(x)).type(t) ?? t;
	};

	// Installed only now, *after* the walks above -- a self-memoizing lazy getter
	for (const { prop, init, inner } of pendingFieldInit) {
		const initScope = inner ?? (isClassDecl(c) ? flowContainer(scope) : scope);
		let resolving = false;
		Object.defineProperty(prop, 'typeAnnotation', {
			configurable:	true,
			enumerable:		true,
			get(): Type {
				if (resolving)
					return T.ANY;
				resolving = true;
				const raw = Array.isArray(init)
					? T.combineTypes(init.map(e => typeOf(e, initScope) ?? T.ANY))
					: typeOf(init, initScope) ?? T.ANY;
				const t = T.stampScope(T.widenNullish(T.widenLiterals(selfRefs(raw)), scope), scope);
				Object.defineProperty(prop, 'typeAnnotation', { value: t, writable: true, enumerable: true, configurable: true });
				return t;
			},
		});
	}
	let bodyScopes: { inst: Scope; stat: Scope } | undefined;
	for (const { sig, decl } of pendingReturns) {
		lazyReturnType(sig, decl, scope, () => {
			bodyScopes ??= classBodyScopes(c, scope, instance, value, superType);
			const generator = hasMod(decl, 'generator');
			checkFunctionBody(sig, decl.body, hasMod(decl, 'static') ? bodyScopes.stat : bodyScopes.inst, hasMod(decl, 'async'), generator, generator);
		}, selfRefs);
	}
	return { instance, value, superType };
}

// ---- control-flow narrowing -----------------------------------------------------------------


// Returns a scope refined by `test` holding (sense=true) or failing (sense=false). Covers truthiness, `!`, `&&`/`||`, typeof, null/undefined
// comparisons, discriminant-property comparisons, instanceof, `in`, and user-defined type predicates.
// Exported for towasm: only `ctx.stmtScope` carries narrowing into codegen, and an unstamped branch
// (`stampBranch`) still needs re-deriving. Pure, so it reaches the same scope either way.

// Depth of the `narrow()` calls currently on the stack -- transient, restored by its own `finally`, never
// inspected across operations. `narrow` evaluates `typeOf` on a test's operands (~13 sites), so without
// this a test containing a nested `&&`/ternary would reach `stampBranch` from inside a SPECULATIVE walk:
// `narrow`'s own disjunctive case passes the UNnarrowed scope to `recurse(test.right, ...)`, and `??=`'s
// first win would freeze that wrong answer permanently.
let narrowing = 0;

// A ternary's or `&&`/`||`'s own branch scope, stamped on the BRANCH node -- the sub-statement narrowing
// `(stmt as any).scope` cannot reach, since no statement boundary exists inside an expression. Untyped,
// matching `pos` and the existing statement stamp: a formal field on a member of a discriminated union
// this large breaks `keyof`-sensitive generic tooling.
//
// `isGenericTemplate`, matching `checkFunctionBody`'s `noStamp`: a generic class's method body is ONE
// template shared by every instantiation, so a stamp taken while its type params are still opaque would
// block (`??=` first-wins) the per-instantiation scope codegen actually needs.
function stampBranch(branch: Expr, branchScope: Scope, scope: Scope) {
	if (!narrowing && branchScope !== scope && !scope.isGenericTemplate())
		(branch as any).scope ??= branchScope;
}

// Whether any of `names` is written anywhere in `body`: an assignment, or `++`/`--` on either side.
function writesAny(body: JS.Stmt<any>[] | Expr, names: Set<string>): boolean {
	let found = false;
	walkerB(undefined, (x: any, process: (x: any) => boolean) => {
		if ((x.type === 'assign' && x.target.type === 'identifier' && names.has(x.target.name))
			|| ((x.type === 'unary' || x.type === 'unary_post') && (x.operator === '++' || x.operator === '--') && x.operand.type === 'identifier' && names.has(x.operand.name)))
			found = true;
		return found || process(x);
	}).body(body);
	return found;
}


// A statement that ASSIGNS a narrowed name rewrites the very scope it was stamped with (`case 'assign'`'s
// own `scope.addNarrowing`), so a later reader of that stamp -- towasm compiling the right-hand side --
// saw the POST-assignment type: `stmt = stmt.declaration` lost the narrowing that made `.declaration`
// legal at all. The stamp keeps the state at the START of the statement; the narrowing still reaches
// every statement after it, as JS assignment semantics require.
function stampedScope(s: Stmt, scope: Scope): Scope {
	const narrowed = scope.narrowedNames();
	if (!narrowed.size || !writesAny([s] as JS.Stmt<any>[], narrowed))
		return scope;
	const frozen = new Scope(scope);
	for (const name of narrowed) {
		const t = scope.value(name);
		if (t)
			frozen.addNarrowing(name, t);
	}
	return frozen;
}
// A name destructured from a union narrows as its source path (`kind` as `x.kind`), so the rest of `x` narrows with it.
function throughSources(e: Expr, scope: Scope): Expr {
	if (e.type === 'identifier')
		return scope.source(e.name) ?? e;
	const out: any = { ...e };
	for (const k of ['left', 'right', 'operand', 'object', 'expression'])
		if (out[k] && typeof out[k] === 'object' && 'type' in out[k])
			out[k] = throughSources(out[k], scope);
	if (Array.isArray(out.arguments))
		out.arguments = out.arguments.map((a: any) => a && a.type !== 'spread' ? throughSources(a, scope) : a);
	return out;
}

// A string literal's value, or a template literal's with no substitutions (`` `number` ``).
function staticText(e: Expr): string | undefined {
	return e.type !== 'literal' ? undefined
		: typeof e.value === 'string' ? e.value
		: Array.isArray(e.value) && e.value.every(p => !p.exp) ? e.value.map(p => p.str).join('')
		: undefined;
}

// `e` (holding when `sense`) as "`typeof operand` is not `kind`", or undefined.
function typeofExclusion(e: Expr, sense: boolean): { operand: Expr; kind: string } | undefined {
	if (e.type !== 'binary' || !['===', '==', '!==', '!='].includes(e.operator))
		return undefined;
	const [t, k] = e.left.type === 'unary' && e.left.operator === 'typeof' ? [e.left, e.right] : [e.right, e.left];
	const kind = staticText(k);
	return (e.operator === '===' || e.operator === '==') !== sense && t.type === 'unary' && t.operator === 'typeof' && kind !== undefined ? { operand: t.operand, kind } : undefined;
}

// Every result `typeof` can give for a value of `m`: a non-primitive `object` may be a function. Undefined when unknown.
function typeofNames(m: Type, scope: Scope): string[] | undefined {
	const name = T.typeofName(m, scope);
	return name ? [name] : T.isRef(T.resolveOwn(m, scope), 'object') ? ['object', 'function'] : undefined;
}

// What survives of member `m` once `typeof` is known to be among `kinds` (`inside`) or outside them: kept whole, dropped, or
// -- an `object` split by 'function' -- refined to its `Function` part. Unknown members are kept.
function narrowByTypeof(m: Type, kinds: Set<string>, inside: boolean, scope: Scope): boolean | Type {
	const names = typeofNames(m, scope);
	const left = names?.filter(n => kinds.has(n) === inside);
	return !names || left!.length === names.length ? true : !left!.length ? false : left!.includes('function') ? TS.RefType('Function') : true;
}

export function narrow(test: Expr, scope: Scope, sense: boolean): Scope {
	const aliasing = new Set<string>();
	++narrowing;
	try {
		return recurse(scope.hasSources() ? throughSources(test, scope) : test, scope, sense);
	} finally {
		--narrowing;
	}

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
		// A union member may resolve to a further nested union, possibly several aliases deep (e.g. a registered type
		// parameter's own constraint, `builtinNumber | Pick<ops<T,S>,'mag'>`, where `builtinNumber` itself is `number |
		// bigint`) -- flatten recursively before filtering, not just one level, so a discriminant matching only part of
		// a compound, multiply-aliased member still filters at the right granularity instead of `typeofName` seeing an
		// still-unresolved ref (ambiguous, so trivially "kept") and never actually narrowing at all. Each candidate keeps
		// its own *original* (unresolved) form alongside the resolved one used only to evaluate `keep` -- a member kept
		// as-is (`k === true`) is pushed by its original ref, not the fully-expanded structural shape, so e.g. a generic
		// `PolynomialN<number>` union member survives narrowing as that clean ref instead of losing the identity later
		// generic inference (`complexBound<T>`) needs.
		const flatten = (m: Type): { resolved: Type; orig: Type }[] => {
			const resolved = T.resolveOwn(m, scope);
			return resolved.type === 'union' ? resolved.types.flatMap(flatten) : [{ resolved, orig: m }];
		};
		const candidates = r.types.flatMap(flatten);
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


	// Narrows `name` to `target`: union members are filtered by assignability; a non-union binding (or any binding, for an opaque `any` target)
	// is replaced outright when the guard holds. `name` may be a dotted path key.
	function narrowTo(scope: Scope, name: string, target: Type, sense: boolean, t = scope.value(name)): Scope {
		const r = t && T.resolveOwn(t, scope);
		if (!r || T.isAny(r))
			return scope;
		// Already strictly narrower than the guard (`C extends A` guarded by `x is A`): TS's getNarrowedType keeps it.
		// A NULLISH member is never "narrower": `undefined` is assignable to everything under non-strict rules, and a guard's
		// true branch says the value is not nullish anyway -- it takes the target below, as every unrelated member does.
		const narrower = (m: Type) => !T.isAny(target) && !T.isNullish(m, scope) && T.isAssignable(m, target, scope) && !T.isAssignable(target, m, scope);
		// A matching member narrows to `target` itself (same as the non-union case below), not to its own
		// wider original shape -- the whole point of a type guard is to say more than the union member's
		// declared type alone does (e.g. `Literal<TypeOfMap[K]>` pinning `.value` past a real AST literal
		// node's own wide `value` union). A plain boolean `keep` would silently discard that.
		// A member WIDER than the target (`Lit<string | number>` guarded to `Lit<string>`) narrows to it too, as in TS.
		if (r.type === 'union' && !T.isAny(target))
			// Excluding a member (the false branch) takes the EXACT relation: a widened `string` counting as a `"never"` (isAssignable's
			// lenient widened-source rule) dropped `RefType` from `isRef(src, 'never')`'s else branch and left `src` as `never`.
			return narrowValue(scope, name, sense
				? m => narrower(m) ? m : T.isAssignable(m, target, scope) || T.isAssignable(target, m, scope) ? target : false
				: m => !T.isAssignable(m, target, scope, scope, false, 10, true), t);
		if (!sense || narrower(r))
			return scope;
		const s = new Scope(scope);
		s.addNarrowing(name, target);
		return s;
	}


	function nonNullChainRoots(e: Expr, scope: Scope): Scope {
		for (let x: Expr = e; x.type === 'member' || x.type === 'index' || x.type === 'call'; x = x.type === 'call' ? x.callee : x.object) {
			const root = x.optional ? (x.type === 'call' ? x.callee : x.object) : undefined;
			const key = root && T.pathKey(root);
			if (key)
				scope = narrowValue(scope, key, m => !T.isNullish(m, scope), scope.value(key) ?? typeOf(root!, scope, false));
		}
		return scope;
	}

	function recurse(test: Expr, scope: Scope, sense: boolean): Scope {
		// A truthy optional chain (`a?.b.c(x)`) has every object before a `?.` in it non-nullish: a nullish one short-circuits the
		// whole chain to `undefined`. Only the truthy branch knows it -- `!a?.b` holds for a nullish `a` as well.
		if (sense && (test.type === 'member' || test.type === 'index' || test.type === 'call'))
			scope = nonNullChainRoots(test, scope);
		const truthy: (m: Type) => boolean = sense ? m => !T.isFalsy(m, scope) : m => !T.isTruthy(m, scope);
		const narrowKey = (target: Expr, keep: (m: Type) => boolean | Type, base = scope) => {
			const key = T.pathKey(referenceOf(target));
			return key ? narrowValue(base, key, keep, base.value(key) ?? typeOf(target, base, false)) : undefined;
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
				const key	= T.pathKey(test);
				return key ? narrowValue(scope, key, truthy, scope.value(key) ?? typeOf(test, scope, false)) : scope;
			}
			// `if ((x = e))` narrows x by truthiness
			case 'assign':
			case 'sequence':
				return narrowKey(test, truthy) ?? scope;

			case 'binary': {
				// `a && b`'s true branch / `a || b`'s false branch: both conjuncts hold (or both fail),
				// so each narrowing applies on top of the other -- sequential/conjunctive narrowing.
				if ((test.operator === '&&' && sense) || (test.operator === '||' && !sense)) {
					// A conjunction's `typeof` exclusions on one reference apply TOGETHER, as TS narrows `switch (typeof x)`: an
					// `object` is gone only once both 'object' and 'function' are excluded, which neither exclusion alone can say.
					const parts: [Expr, boolean][] = [];
					const flatten = (e: Expr, s: boolean): void => {
						if (e.type === 'binary' && ((e.operator === '&&' && s) || (e.operator === '||' && !s))) {
							flatten(e.left, s);
							flatten(e.right, s);
						} else if (e.type === 'unary' && e.operator === '!') {
							flatten(e.operand, !s);
						} else {
							parts.push([e, s]);
						}
					};
					flatten(test, sense);
					const excluded = new Map<string, { operand: Expr; kinds: Set<string> }>();
					const unrelated = parts.filter(([e, s]) => {
						const x = typeofExclusion(e, s);
						const key = x && T.pathKey(referenceOf(x.operand));
						if (!x || !key)
							return true;
						const group = excluded.get(key) ?? { operand: x.operand, kinds: new Set<string>() };
						group.kinds.add(x.kind);
						excluded.set(key, group);
						return false;
					});
					let narrowed = scope;
					for (const { operand, kinds } of excluded.values())
						narrowed = narrowKey(operand, m => narrowByTypeof(m, kinds, false, scope), narrowed) ?? narrowed;
					for (const [e, s] of unrelated)
						narrowed = recurse(e, narrowed, s);
					return narrowed;
				}
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
					// The compared value when it is one unit type: a literal, or a name typed as one (`Kind.A`, a `const k = 'a'`) -- TS narrows by either.
					const unitOf = (x: Expr): { value: string | number | bigint | boolean } | undefined => {
						const text = staticText(x);
						const t = x.type === 'literal' ? x : T.pathKey(x) !== undefined ? T.resolveOwn(typeOf(x, scope, false), scope) : undefined;
						return text !== undefined ? { value: text }
							: t?.type === 'literal' && t.value !== null && !Array.isArray(t.value) ? { value: t.value as string | number | bigint | boolean } : undefined;
					};
					// A comparand typed as a union of unit literals (`kind: 'call' | 'construct'`) matches any of them. TS narrows by it on the
					// matching branch only: the other holds for every member but the one value the comparand turned out to be.
					const literalUnionOf = (x: Expr): Set<unknown> | undefined => {
						const t = T.pathKey(x) !== undefined ? T.resolveOwn(typeOf(x, scope, false), scope) : undefined;
						const parts = t?.type === 'union' ? t.types.map(u => T.resolveOwn(u, scope)) : undefined;
						return parts?.every(u => u.type === 'literal' && u.value !== null && !Array.isArray(u.value)) ? new Set(parts.map(u => (u as { value: unknown }).value)) : undefined;
					};
					for (const [l, r] of [[test.left, test.right], [test.right, test.left]] as const) {
						const unit = unitOf(r);
						const units = unit ? new Set<unknown>([unit.value]) : keepMatch ? literalUnionOf(r) : undefined;
						// An optional chain equal to a non-nullish value (`ns?.decl(k)?.type === 'class_decl'`) did not short-circuit, so every
						// object before a `?.` in it is non-nullish -- only on the matching branch, as with a truthy chain.
						if (units && keepMatch && (l.type === 'member' || l.type === 'index' || l.type === 'call'))
							scope = nonNullChainRoots(l, scope);
						// typeof x === 'kind' (x may be a dotted path, e.g. `typeof options.layer === 'number'`)
						const text = staticText(r);
						if (l.type === 'unary' && l.operator === 'typeof' && text !== undefined) {
							const kinds = new Set([text]);
							const s = narrowKey(l.operand, m => narrowByTypeof(m, kinds, keepMatch, scope));
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
						// Which members of the compared reference's own type survive: literal members must match; non-literal members might.
						const unitKeep = unit && ((raw: Type): boolean | Type => {
							const m = T.resolveOwn(raw, scope);
								if (m.type === 'literal')
									return (m.value === unit.value) === keepMatch;
								// `boolean` has exactly two inhabitants -- real TS narrows it as `true | false`, so `x === false`
								// narrows the other branch down to literal `true` instead of leaving `boolean` unsplit.
								if (m.type === 'ref' && m.name === 'boolean' && typeof unit.value === 'boolean')
									return Literal(keepMatch ? unit.value : !unit.value);
								// A plain (or already range-narrowed) number/bigint pins down to exactly `r.value` on the matching
								// branch -- intersected with whatever's already known, so an equality that contradicts an
								// earlier bound (`x > 10` then `x === 3`) correctly narrows to `never`, not just `3`.
								// The excluding branch can only special-case "was already pinned to this exact value".
								const v = unit.value;
								if (typeof v === 'number' || typeof v === 'bigint') {
									const mr = T.toRange(m);
									if (mr && mr.base === typeof v) {
										if (keepMatch) {
											const merged = T.rangeIntersect(mr, { base: mr.base, min: v, max: v, integer: typeof v === 'bigint' || Number.isInteger(v) });
											return merged ? T.rangeToType(merged) : false;
										}
										return mr.min !== undefined && mr.min === mr.max && mr.min === v ? false : true;
									}
								}
								// TS's areTypesComparable: on the matching branch a member the value is comparable with neither way (an object
								// shape against a string) cannot be it.
								// In this checker's own representation: a numeric unit is a one-value range, as a numeric literal types.
								const lit: Type = typeof v === 'number' ? TS.RangeType('number', v, v, Number.isInteger(v)) : typeof v === 'bigint' ? TS.RangeType('bigint', v, v) : Literal(v);
								return !keepMatch || T.isAssignable(lit, m, scope) || T.isAssignable(m, lit, scope);
							});
						if (l.type === 'identifier' && unitKeep)
							return narrowValue(scope, l.name, unitKeep);
						// x.prop === literal (discriminated union): `narrowByDiscriminant` splits a compound member to its matching
						// sub-variant(s) instead of keeping/discarding it whole; `l.object` may itself be a dotted path.
						// `x[0] === literal` discriminates too -- a tuple's position, or an interface's numeric key.
						const discKey = l.type === 'member' ? l.property
							: l.type === 'index' ? (T.isLiteral(l.index, 'number') ? String(l.index.value) : T.literalString(l.index))
							: undefined;
						if ((l.type === 'member' || l.type === 'index') && discKey !== undefined && units) {
							// `x?.prop === literal` truly holding also implies `x` itself is non-nullish -- a nullish `x` would
							// short-circuit the whole expression to `undefined`, which a non-nullish literal can never equal.
							// Only sound when this branch asserts the equality actually held (`keepMatch`): the excluding branch
							// (`x?.prop !== literal`) is satisfied by a nullish `x` just as well, so no such inference there.

							const prop = discKey;
							const targets = units;

							// Narrows `m` by a discriminant-property equality test, recursing into `m`'s structure to split a compound member down
							// to its matching sub-variant(s) rather than keep/discard it whole.
							function narrowByDiscriminant(m: Type, depth = 6): boolean | Type {
								if (depth < 0) {
									scope.hitDepthLimit('narrowByDiscriminant');
									return true;	// can't determine within budget: lenient, same as an unresolvable discriminant below
								}
								const r = T.resolveOwn(m, scope);
								if (r.type === 'union') {
									const parts: Type[] = [];
									let changed = false;
									for (const x of r.types) {
										const k = narrowByDiscriminant(x, depth - 1);
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
									return targets.has(rp.value) === keepMatch;
								// The discriminant property is itself a union of literals declared directly on one interface (not a nested alias) --
								// `r` isn't a union to split, so only whether the whole of it can be excluded/kept without ambiguity.
								return rp.type !== 'union' || !rp.types.every(x => x.type === 'literal')
									|| (keepMatch ? rp.types.some(x => targets.has(x.value)) : rp.types.some(x => !targets.has(x.value)));
							}

							const s = narrowKey(l.object, narrowByDiscriminant, keepMatch && l.optional ? narrowKey(l.object, m => !T.isNullish(m, scope)) : scope);
							// The compared path is itself a reference TS narrows too (`value.type` over a `Partial<...>` no discriminant can split).
							const key = T.pathKey(l);
							if (key && unitKeep) {
								const base = s ?? scope;
								return narrowValue(base, key, unitKeep, base.value(key) ?? typeOf(l, base, false));
							}
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
						}, base.value(key) ?? typeOf(target, base, false));
					};

					return applyBound(
						applyBound(scope, A, T.toRange(T.resolveOwn(typeOf(B, scope), scope)), upperOnA),
						B, T.toRange(T.resolveOwn(typeOf(A, scope), scope)), !upperOnA
					);

				} else if (test.operator === 'instanceof') {
					const key = T.pathKey(test.left);
					if (key) {
						const cur = scope.value(key) ?? typeOf(test.left, scope, false);
						return test.right.type === 'identifier' && scope.type(test.right.name)
							? narrowTo(scope, key, TS.RefType(test.right.name), sense, cur)
							// unknown class: trust the guard, stop tracking the binding
							: sense ? narrowTo(scope, key, T.ANY, sense, cur) : scope;
					}

				} else if (test.operator === 'in' && T.literalString(test.left) !== undefined && test.right.type === 'identifier') {
					const prop = T.literalString(test.left)!, key = test.right.name;
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
						}, scope.value(key) ?? typeOf(test.arguments[0], scope, false));
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
				const asObjectCallSigs = (t: Type): TS.CallSig[] => {
					const r = T.resolveOwn(t, scope);
					return r.type === 'object' ? r.members.filter((m): m is Extract<TS.TypeMember, { type: 'call' }> => m.type === 'call') : [];
				};
				const parts = T.flattenIntersection(calleeT, scope);
				const sig	= parts.find((p): p is Extract<Type, { type: 'function' }> => p.type === 'function')
						?? parts.flatMap(p => p.type === 'union' ? p.types.flatMap(asObjectCallSigs) : asObjectCallSigs(p))
						.find(m => m.returnType?.type === 'predicate' && (m.rest || m.params.length === test.arguments.length));
				const ret	= sig?.returnType;
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
								// Unwidened, as a call's own arguments are: `isLiteral(t, 'string')`'s `K` is the literal `'string'`.
								if (a.type !== 'spread' && p?.typeAnnotation)
									T.inferTypeArgs(p.typeAnnotation, typeOf(a, scope, false), names, map, scope);
							});
							// An uninferred type param must not leave a dangling `{type:'ref', name:'T'}` in `target`, or every other assignability
							// check (which treats an unresolvable ref as "unrelated") would silently narrow the guard to nothing at all.
							sig.typeParams.forEach(p => { if (!map.has(p.name)) map.set(p.name, p.constraint ?? p.default ?? T.ANY); });
							target = T.substituteType(target, map);
						}
						return narrowTo(scope, key, target, sense, scope.value(key) ?? typeOf(arg, scope, false));
					}
				}
				return scope;
			}
			default:
				return scope;
		}
	}
}

// Tries `T.isAssignable` strict then lax; a GAP means strict failed only due to an opaque type (keyof/conditional/infer/mapped).
// Every real assignability check should go through this, not `T.isAssignable` directly. `dstScope` resolves `dst`'s own structure.
function checkAssignable(src: Type, dst: Type, scope: Scope, pos: Location, dstScope: Scope, err: Err): boolean {
	if (T.isAssignable(src, dst, scope, dstScope, true))
		return true;
	const lax = T.isAssignable(src, dst, scope, dstScope, false);
	// The same type, written the same way, is assignable to itself however opaque it is (`Record<K, M[K]>`).
	if (lax && (src === dst || T.typeKey(src) === T.typeKey(dst)))
		return true;
	if (lax)
		err(SEVERITY.GAP, pos)`Assignability of '${show().type(src)}' to '${show().type(dst)}' could not be fully verified ('keyof'/conditional/'infer'/mapped types aren't evaluated)`;
	return lax;
};

// A fresh object literal assigned to a fully-known object type may not introduce unknown keys
function checkExcessProps(lit: Expr, target: Type, pos: Location, targetScope: Scope, err: Err) {
	if (lit.type !== 'object')
		return;

	const r			= T.resolveOwn(target, targetScope);
	const targets	= (r.type === 'intersection' ? r.types.map(t => T.resolveOwn(t, targetScope)) : [r]).filter(t => t.type === 'object');
	if (targets.length !== (r.type === 'intersection' ? r.types.length : 1) || targets.some(t => t.members.some(m => m.type === 'index')))
		return;		// partially-unknown target or index signature: anything goes

	if (lit.properties.some(p => p.type === 'spread' || typeof p.key !== 'string'))
		return;		// spread/computed keys: shape is open

	for (const p of lit.properties)
		if (p.type !== 'spread' && typeof p.key === 'string' && !targets.some(t => t.members.some(m => (m.type === 'property' || m.type === 'method') && m.key === p.key)))
			err(SEVERITY.ERROR, pos)` Object literal may only specify known properties, and '${show().memberKey(p.key)}' does not exist in type '${show().type(target)}'`;
}

// ---- declaration hoisting / namespace resolution ------------------------------------------

function hoist(stmts: Stmt[], scope: Scope) {
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
			// Inherited parts FIRST, own members LAST -- the concreteness order `mergeType` also uses, and
			// what `lookupMember`'s and `collectMembers`' reversal turns into a working member override.
			scope.mergeType(stmt.name, stmt.extendsClause?.length ? T.intersectTypes([...stmt.extendsClause.map(e => T.stampScope(e, scope)), obj]) : obj, stmt.typeParams, true);
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
				// `mergeValue`, matching `mergeType` directly above: a primitive wrapper is declared twice
				// on purpose (see `Scope.mergeValue`), and overwriting lost the ambient call signature.
				scope.mergeValue(stmt.name, value);
				scope.addDecl(stmt.name, stmt);
				break;
			}
			case 'enum_decl': {
				let next = 0;
				const memberTypes = stmt.members.map((m): Type => !m.init ? Literal(next++)
					: T.isLiteral(m.init, 'number') ? Literal((next = m.init.value + 1, m.init.value))
					: T.literalString(m.init) !== undefined ? { ...Literal(T.literalString(m.init)!), fresh: true }
					: T.isLiteral(m.init, 'string') ? T.STRING
					: T.NUMBER
				);
				scope.addType(stmt.name, T.combineTypes(memberTypes));
				scope.addValue(stmt.name, TS.ObjectType(stmt.members.map((m, i) => TS.TypeProperty(m.name, memberTypes[i]))));
				// Each member is a type too (`kind: Kind.A`), reached as a dotted name through the enum's own namespace; merged declarations share it.
				const members = scope.ownNamespace(stmt.name) ?? new Scope(scope);
				stmt.members.forEach((m, i) => members.addType(m.name, memberTypes[i]));
				scope.addNamespace(stmt.name, members);
				break;
			}
			case 'namespace_decl': {
				// Same-named blocks MERGE (lib.es5's `namespace Intl` holds `NumberFormat`; later lib files add to it): a
				// later block sees the earlier one's names, and its own members merge into it, augmentations last.
				const prior = scope.ownNamespace(stmt.name);
				const { scope: block, inner, alias } = exportScope(stmt.body, prior ?? scope, undefined, prior && namespaceInner.get(prior));
				if (prior)
					prior.copyAll(block);
				else
					namespaceInner.set(block, inner);
				const ns	= prior ?? block;
				const value = alias ?? ns.toObject();
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
		}
	}

	// several same-named declarations are overloads: if there are any bodyless functions, their signatures are the public face,
	// exposed as an object type with one call member each; a single declaration stays a plain function
	for (const [name, decls] of fnGroups) {
		const sigs		= decls.filter(d => !d.body);
		const chosen	= sigs.length ? sigs : decls;
		if (chosen.length > 1) {
			// `declScope`/`stampSig`: each overload's own param/return types resolve in *this* module's scope, not whichever module calls it.
			scope.addValue(name, TS.ObjectType(chosen.map(d => TS.TypeCall(T.stampSig(T.withScope(T.FixSig(d, T.ANY), scope), scope)))));
			// The real, compilable implementation (the one non-bodyless declaration a real overload group
			// always has) -- there's no single decl a bodyless *signature* alone could resolve to.
			const impl = decls.find(d => d.body);
			if (impl) {
				// The IMPLEMENTATION's own annotations resolve in this module too -- only the signatures above were
				// stamped, so a consumer reading the decl (towasm's `resolveParams`) looked an imported param type
				// up in its own module instead, and had no wasm type for it.
				impl.params.forEach(p => p.typeAnnotation && T.stampScope(p.typeAnnotation, scope));
				if (impl.returnType)
					T.stampScope(impl.returnType, scope);
				scope.addDecl(name, impl);
			}
		} else {
			const d = chosen[0];
			const t = TS.FunctionType(T.stampSig(T.withScope(T.FixSig(d, T.ANY), scope), scope));
			if (!d.returnType && d.body)
				lazyReturnType(t, d, scope, () => checkFunctionBody(t, d.body, ownThis(flowContainer(scope)), hasMod(d, 'async'), hasMod(d, 'generator'), hasMod(d, 'generator')));
			scope.addValue(name, t);
			scope.addDecl(name, d);
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
			: d.init ? T.widenNullish(typeOf(d.init, scope, widen, undefined, undefined, err), scope) : T.ANY);
		// TS 4.4 aliased conditions: a `const`'s initializer stays true for its whole lifetime, so narrowing the const
		// also narrows through what its initializer itself would narrow (`narrow()`'s `case 'identifier'` reads this).
		if (!widen && d.init)
			scope.addAlias(d);
		// TS's assignment narrowing: a union-typed `const` reads as the declared members its initializer can be (`const e: E = E.ONE`
		// is `E.ONE`). Only for `const` -- narrowings are never invalidated by reassignment, so a `let` would stay narrowed wrongly.
		if (!widen && d.init && typeAnnotation) {
			const declared = T.unionMembers(typeAnnotation, scope);
			const init = declared.length > 1 ? T.unionMembers(typeOf(d.init, scope, false, typeAnnotation), scope) : [];
			const kept = declared.filter(m => init.some(i => T.isAssignable(i, m, scope)));
			if (kept.length && kept.length < declared.length)
				scope.addNarrowing(d.name, T.combineTypes(kept));
		}
	} else {
		const t = typeAnnotation ?? (d.init && T.widenNullish(typeOf(d.init, scope, widen, undefined, undefined, err), scope));
		if (t)
			bindPattern(scope, d.name, t, d.init, !widen, err);
		else
			T.bindingNames(d.name).forEach(n => scope.addValue(n, T.ANY));
	}
}

// What iterating `t` yields and returns. A non-iterable is TS 2488 and then `any`, as in TS; a GAP rather than an error while `t` isn't fully known.
function iterationOrReport(t: Type, scope: Scope, pos: Location, err?: Err, async = false): T.IterationTypes {
	const it = T.iterationTypes(t, scope, async);
	if (!it && err)
		err(T.sealed(t, scope) ? SEVERITY.ERROR : SEVERITY.GAP, pos)`Type '${show().type(t)}' must have a '[Symbol.iterator]()' method that returns an iterator`;
	return it ?? { yield: T.ANY, return: T.ANY, next: T.ANY };
}

// A union context narrowed to the members an object literal's literal-valued properties can match (TS's discriminateContextualType);
// the whole union when none or all survive.
function discriminateContext(t: Type, lit: Expr & { type: 'object' }, scope: Scope): Type {
	const members = T.unionMembers(t, scope);
	if (members.length < 2)
		return t;
	const literals = lit.properties.flatMap(p => p.type === 'field' && typeof p.key === 'string' && p.value?.type === 'literal' && !Array.isArray(p.value.value) ? [[p.key, p.value.value] as const] : []);
	const kept = members.filter(m => literals.every(([key, value]) => {
		const pt = T.lookupMember(m, key, scope);
		const units = pt && T.unionMembers(pt, scope).map(u => T.resolveOwn(u, scope));
		return !units || !units.every(u => u.type === 'literal') || units.some(u => u.type === 'literal' && u.value === value);
	}));
	return kept.length && kept.length < members.length ? T.combineTypes(kept) : t;
}

// A property's contextual type: its type in each member of the context that has it (TS: a union context maps over its members).
function contextualMember(t: Type, key: string, scope: Scope): Type | undefined {
	const parts = T.unionMembers(t, scope).flatMap(m => { const p = T.lookupMember(m, key, scope); return p ? [p] : []; });
	return parts.length ? T.combineTypes(parts) : undefined;
}

// Whether a contextual type asks for literals: one of its members is a literal (an enum member, a literal union), so a fresh
// literal checked against it keeps its literal type instead of widening.
function contextKeepsLiteral(t: Type, scope: Scope): boolean {
	return T.unionMembers(t, scope).some(m => T.resolveOwn(m, scope).type === 'literal');
}

// A fresh value's type widened as TS widens one: fully with no context; with one, its parts were already typed against their own
// contexts, so only a top-level literal the context does not ask for widens (an inferred return, an object literal's property).
function widenForContext(t: Type, context: Type | undefined, scope: Scope): Type {
	return !context ? T.widenLiterals(t) : contextKeepsLiteral(context, scope) ? t : T.widenLiterals(t, false, false, true);
}

// The element context an iterable contextual type gives an array literal: what its iterable members yield (`any` gives none).
function iteratedContext(t: Type, scope: Scope): Type | undefined {
	const yields = T.unionMembers(t, scope).flatMap(m => {
		const it = !T.isAny(T.resolveOwn(m, scope)) && T.iterationTypes(m, scope);
		return it ? [it.yield] : [];
	});
	return yields.length ? T.combineTypes(yields) : undefined;
}

// Each name a destructuring pattern binds gets its own part of `t`: a tuple position, an array element, a member --
// narrowed where the source path is (`const { bar } = aFoo` after `if (aFoo.bar)`). A `const` destructured from a
// UNION at a stable path is recorded as that path (`scope.addSource`), so narrowing one name narrows the others (TS 4.6).
function bindPattern(scope: Scope, target: JS.BindingTarget, t: Type, source?: Expr, constant = false, err?: Err) {
	if (typeof target === 'string') {
		scope.addValue(target, t);
		return;
	}
	const r			= T.resolve(scope, t);
	const narrowed	= (e: Expr | undefined) => { const k = e && T.pathKey(e); return k ? scope.value(k) : undefined; };
	const correlate	= constant && r.type === 'union' && !!source && T.pathKey(source) !== undefined;
	if (target.type === 'array_pattern') {
		// Each member answers for itself, as TS destructures a union: a tuple's own position, anything else its iterated element.
		// Iterated once per member, so a non-iterable one is reported once, not once per position.
		const members	= T.unionMembers(r, scope).map(m => T.resolveOwn(m, scope));
		const elems		= members.map(m => m.type === 'tuple' ? undefined : iterationOrReport(m, scope, getPos(target)!, err).yield);
		const at		= (i: number) => T.combineTypes(members.map((m, j) => m.type === 'tuple' ? T.tupleElementType(m.elements[i]) ?? T.ANY : elems[j]!));
		const restOf	= (m: Type, j: number) => m.type === 'tuple' ? T.combineTypes(m.elements.slice(target.elements.length).map(el => T.tupleElementType(el) ?? T.ANY)) : elems[j]!;
		target.elements.forEach((el, i) => {
			const sub	= el && source ? { type: 'index', object: source, index: { type: 'literal', value: i } } as Expr : undefined;
			const et	= el && (narrowed(sub) ?? at(i));
			if (el)
				bindPattern(scope, el.target, el.default ? T.nonNullable(et!, scope) : et!, sub, constant, err);
		});
		if (target.rest)
			bindPattern(scope, target.rest, TS.ArrayType(T.combineTypes(members.map(restOf))), undefined, false, err);
	} else {
		for (const p of target.properties) {
			const sub	= typeof p.key === 'string' && source ? { type: 'member', object: source, property: p.key } as Expr : undefined;
			const m		= narrowed(sub)
				?? (typeof p.key === 'string' ? T.optional(T.lookupMember(r, p.key, scope) ?? T.ANY, T.memberOptional(r, p.key, scope)) : T.ANY);
			bindPattern(scope, p.value, p.default ? T.nonNullable(m, scope) : m, sub, constant, err);
			if (correlate && sub && typeof p.value === 'string' && !p.default)
				scope.addSource(p.value, sub);
		}
		if (target.rest)
			scope.addValue(target.rest, T.ANY);
	}
}

// Resolves what a `namespace X { ... }` block or module body exposes, as a genuine `Scope` (not a flattened `Type`) since `NS.Foo` can appear
// in a type position too. A caller needing the value-position `Type` calls `scope.toObject()` itself, at the point it needs one -- a snapshot
// taken here would go stale against anything the caller adds afterwards (transform.ts's `export ... from` re-export loop does exactly that).
// `alias` is set only for `export = X` (`.d.ts`-only), where the namespace collapses to `X`'s own value instead of its scope's shape.
// `__filename`/`__dirname` are not globals: CommonJS injects them PER MODULE, via the module wrapper
// (`(function (exports, require, module, __filename, __dirname) {...})`), each derived from that module's
// own resolved file. So they are bound into the module's own scope, never the lib scope -- a global would
// give every module the same answer, which is exactly what they are not. Only the two this compiler can
// actually supply; `require`/`module`/`exports` are deliberately still unbound.
export function bindModuleNames(filename: string | undefined, scope: Scope) {
	if (filename) {
		scope.addValue('__filename', T.STRING);
		scope.addValue('__dirname', T.STRING);
	}
}

// A namespace's export view -> the scope its blocks hoist into, so a later same-named block merges into the first.
const namespaceInner = new WeakMap<Scope, Scope>();

export function exportScope(body: Stmt[], parent: Scope, filename?: string, into?: Scope): { scope: Scope; inner: Scope; alias?: Type } {
	// `hoist` + `hoistVars` (not full `checkBlock`): only top-level declaration *types* are needed, not a full check of a body checked separately.
	// `into`: an earlier same-named namespace block's scope -- declarations MERGE there, so its own references see augmentations.
	const inner = into ?? new Scope(parent);
	hoist(body, inner);
	// `inner` is RETURNED, not stamped on the body array: an imported module's INTERNAL scope is
	// otherwise built here and thrown away, and towasm needs it to resolve a name declared in the module
	// it is compiling. The caller puts it on the module record. `scope` below is the export-only VIEW.
	bindModuleNames(filename, inner);

	// Infers top-level `var`/`const`/`let` types only -- muted, since this just resolves what a module *exposes*; its own real (unmuted)
	// check happens when it's the direct entry point. Without muting, every importer would re-diagnose the same exports from scratch (no cross-run cache).
	for (let stmt of body) {
		if (stmt.type === 'export_decl')
			stmt = stmt.declaration;
		if (stmt.type === 'var_decl') {
			const varStmt = stmt;
			stmt.declarations.forEach(d => {
				hoistVar(inner, d, varStmt.kind !== 'const');
				// Lets a consumer that needs the real initializer (not just its derived type) -- e.g. towasm.ts
				// lazily initializing a cross-module `const X = someFactory(...)` on first use -- reach it via
				// the same `declScope`/`Scope.decl` mechanism a function/class declaration already does.
				if (typeof d.name === 'string')
					inner.addDecl(d.name, varStmt);
			});
		}
	}

	const assign = body.find(s => s.type === 'export_assignment');
	if (assign) {
		return {
			inner,
			scope: inner.namespace(assign.expr) ?? new Scope(),
			alias: inner.value(assign.expr) ?? T.ANY,
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
	return { scope, inner };
}

// ---- lazy return-type inference -------------------------------------------------------------

// Instantiates `sig` against `argTs`, substituting type params through params/return type. Pure -- doesn't validate (see `argsFit`).
// `restElementTs`: a spread argument's element type(s), since `argTs` leaves a spread position `undefined` (arity unknown statically).
// What the call's destination implies settles a parameter no argument spoke for -- before any callback's own return is heard,
// since an unannotated callback returns whatever shape its body made (`Rule([...], $ => ({...}))` needs the array's element
// type). A hint still naming the call's own placeholders only fills in if nothing else does.
function settleFromReturn(inference: T.Inference, scope: Scope) {
	for (const name of inference.names.keys()) {
		const hint = inference.returnHint(name);
		if (hint && !inference.fromCandidates(name) && !T.mentionsAbstract(hint, scope))
			inference.fix(name, hint);
	}
}

// The type-argument map a generic call instantiates with: the explicit args outright, else TS's own
// inference (`T.Inference`) over the argument types, with the contextual result type settling what the
// arguments left open and the deferred callback-return candidates replayed last. Exported because
// `towasm.ts`'s monomorphization needs the same answer -- it used to re-implement exactly this policy.
// `restElementTs`: a spread argument's element type(s), since `argTs` leaves a spread position `undefined`.
// `inference`: the call site's own, already fed its arguments and callbacks in TS's order (see `case 'call'`);
// a bare trial (an overload fit, an instantiation expression) infers from `argTs` here.
export function inferTypeArgMap(sig: TS.CallSig, argTs: (Type | undefined)[], typeArgs: Type[] | undefined, scope: Scope, restElementTs?: Type[], expected?: Type, inference?: T.Inference, err?: Err, pos?: Location): Map<string, Type> {
	const map = new Map<string, Type>();
	if (!sig.typeParams?.length)
		return map;
	if (typeArgs) {
		sig.typeParams.forEach((p, i) => map.set(p.name, typeArgs[i] ?? p.default ?? T.ANY));
		return map;
	}
	// A callback's own return, when the callback wasn't typed in order by the call site: heard only after the destination.
	const deferred: T.Deferred[] = [];
	if (!inference) {
		inference = new T.Inference(sig.typeParams, scope, T.declScopeOf(sig, scope));
		argTs.forEach((t, i) => {
			const p = sig.params[i];
			if (t && p?.typeAnnotation)
				inference!.infer(p.typeAnnotation, t, deferred);
		});
		if (expected && sig.returnType)
			inference.inferReturn(sig.returnType, expected);
		settleFromReturn(inference, scope);
	}
	// Rest arguments are ONE candidate, as TS's synthesized array of them: `new Array(false, 1, 'x')` is `T = boolean | number | string`.
	if (sig.rest?.typeAnnotation && restElementTs?.length) {
		const t = sig.rest.typeAnnotation;
		inference.infer(t.type === 'array' ? t.element : t, T.combineTypes(restElementTs), deferred);
	}
	for (const { paramT, argT, contra } of deferred)
		inference.infer(paramT, argT, undefined, contra);
	const inferred = inference.current();
	sig.typeParams.forEach(p => {
		const t = inferred.get(p.name);
		if (t && !inference!.wasDefaulted(p.name)) {
			map.set(p.name, t);
			return;
		}
		const assumed = t ?? p.default ?? p.constraint ?? T.ANY;
		map.set(p.name, assumed);
		// A declared default is a correct, unremarkable fallback (real TS does it silently too) -- only worth flagging when
		// some supplied argument's type actually mentions `p.name` and still couldn't pin it down.
		if (err && pos && !p.default && sig.params.some((prm, i) => argTs[i] && prm.typeAnnotation && T.mentionsTypeParam(prm.typeAnnotation, p.name)))
			err(SEVERITY.GAP, pos)`Type parameter '${p.name}' could not be inferred from the arguments; assumed '${show().type(assumed)}'`;
	});
	return map;
}

// Instantiates `sig` against `argTs`, substituting type params through params/return type. Pure -- doesn't validate (see `argsFit`).
function instantiate(sig: TS.CallSig, argTs: (Type | undefined)[], typeArgs: Type[] | undefined, scope: Scope, pos: Location, restElementTs?: Type[], expected?: Type, err?: Err, inference?: T.Inference): TS.CallSig {
	let returnType	= sig.returnType ?? T.ANY;
	let params		= sig.params;
	let rest		= sig.rest;

	if (sig.typeParams?.length) {
		const map	= inferTypeArgMap(sig, argTs, typeArgs, scope, restElementTs, expected, inference, err, pos);
		params		= params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteType(p.typeAnnotation, map) } : p);
		rest		= rest?.typeAnnotation ? { ...rest, typeAnnotation: T.substituteType(rest.typeAnnotation, map) } : rest;
		returnType	= T.substituteType(returnType, map);
	}
	// `declScope` travels with the result -- e.g. into `argsFit`, which only ever sees this instantiated object, never `sig` itself.
	return { params, rest, returnType, declScope: sig.declScope };
}

// ---- expressions ----------------------------------------------------------------------------

// `widen: false` gives an expression's precise type -- what an assignability check compares, as TS checks a fresh literal.
type typeOf = (e: Expr, scope: Scope, expected?: Type, widen?: boolean)=>Type;
export function typeOf1(err?: Err): typeOf {
	return (e, scope, expected, widen = true) => typeOf(e, scope, widen, expected, undefined, err);
}

// `expected`: the contextual type this expression is checked against, when known -- lets a generic call whose type params aren't
// determined by its arguments (`new Promise<T>(...)`) infer them from where the result is going, like TS's own contextual typing.
export function typeOf(e: Expr, scope: Scope, widen = true, expected?: Type, yieldCollector?: Type[], err?: Err): Type {
	// `recurse` always computes `e`'s *precise* type -- widening is never threaded through the walk, only applied once,
	// at the very bottom, to whatever this whole call ultimately produces -- only the single bootstrap call at the bottom passes the real one through.

	// A chained call's own receiver gets independently re-derived through more than one path (e.g.
	// `case 'new'`/`case 'call'` compute both `recurse(e.callee.object)` directly *and* `recurse(e.callee)`,
	// which -- being a `member` expression -- internally recomputes the very same `e.object` type again from
	// scratch) -- for a chain of N calls this compounds into 2^N total evaluations of the same nodes
	// (confirmed: a 20-call chain produced 2^19 resolutions of one class's own type). Memoized here, per
	// (node, expected) pair and scoped to this one `typeOf` call (a fresh `Map` each invocation, so it can't
	// leak stale results across separate checks) -- safe because `recurse`'s own side effects (diagnostics,
	// `yieldCollector` pushes) are themselves exact duplicates on a second visit to the identical node.
	const recurseCache = new Map<Expr, Map<Type | undefined, Type>>();

	// Applied once, uniformly, to whatever `recurse` computed -- not scattered through individual switch cases (a bare
	// literal expression's own case never widens on its own, matching `as const`'s need to see the precise type deeper
	// in the walk). No exemption needed for an assertion's own result here: `'as'` already freezes it (`T.freeze`),
	// and `widenLiterals` itself leaves a frozen leaf untouched, at any nesting depth -- including one embedded inside
	// a container this call goes on to widen (`[1, x as const]`), which a check on `e` itself here never could reach.
	const result = recurse(e, expected);
	// A freshly-inferred function type (an arrow/function expression's own params reused verbatim, e.g.
	// `T.FixSig`) can otherwise reach a consumer with a bare, never-`declScope`-stamped ref buried in one
	// of its param annotations -- real for any nested closure literal whose own body never separately gets
	// a full (unmuted) check pass of its own (the same class of gap `makeLibScope`'s own comment already
	// documents for a lib method body). `scope` is the exactly-correct fallback (wherever `e` was actually
	// written is literally this same scope), and `T.stampScope`'s own "skip if already tagged" rule makes
	// this a safe no-op for anything a real check pass already stamped.
	T.stampScope(result, scope);
	return widen ? T.widenLiterals(result) : result;

	function recurse(e: Expr, expected?: Type): Type {
		let byExpected = recurseCache.get(e);
		const cached = byExpected?.get(expected);
		if (cached !== undefined)
			return cached;
		const result = recurseUncached(e, expected);
		if (!byExpected)
			recurseCache.set(e, byExpected = new Map());
		byExpected.set(expected, result);
		return result;
	}
	function recurseUncached(e: Expr, expected?: Type): Type {
		const pos = (e as any).pos;
		switch (e.type) {
			case 'literal':
				if (Array.isArray(e.value)) {
					e.value.forEach(p => p.exp && recurse(p.exp));
					return T.STRING;
				}
				switch (typeof e.value) {
					case 'string':
					case 'boolean':	return { ...Literal(e.value), fresh: true };
					case 'number':	return TS.RangeType('number', e.value, e.value, e.value === (e.value | 0));
					case 'bigint':	return TS.RangeType('bigint', e.value, e.value);
					case 'object':	return e.value === null ? Literal(e.value) : T.REGEXP;
				}
				break;

			case 'this':		return scope.value('this') ?? T.ANY;
			case 'super':		return scope.value('super') ?? T.ANY;
			case 'identifier':	{
				// A name destructured from a union is its source path, read in the CURRENT (narrowed) scope.
				const src = scope.source(e.name);
				return src ? recurse(src) : scope.value(e.name) ?? T.ANY;
			}

			case 'array': {
				// Contextual typing, same idea `case 'object'`'s own `expectedMember`/`T.lookupMember`
				// already applies per property -- a tuple-typed `expected` (`[number,number][]`'s own
				// element type, for instance) threads each position's own expected type into that
				// element, and shapes this literal's own inferred type as a tuple too (not just widened
				// to a plain array afterward) -- otherwise a nested tuple literal infers as a plain
				// array regardless of context (real TS: `[1, 2]` alone is `number[]`; contextually
				// tuple-typed, it's `[number, number]`), which is wrong both for later assignability
				// and (via `wasmTypeOf`) for codegen's own physical representation of it.
				// CONST CONTEXT: a READONLY TUPLE whose elements keep their literals and pass the context down. As a plain
				// array, `Rule<T, const R ...>`'s `ValuesOf<R>` has no positions and every `$[i]` is the union of all of them.
				if (isConstContext(expected) && e.elements.every(el => el && el.type !== 'spread'))
				{
					const inner = expected.typeArgs?.[0];
					return { type: 'tuple', readonly: !(inner && hasMutableArrayLike(inner, scope)), elements: e.elements.map((el, i) => T.freeze(recurse(el!, constContextOf(el!, inner && positionContext(inner, i, scope))))) };
				}
				// A union context contributes its one array-like member (Map's `readonly (readonly [K, V])[] | null`).
				const contextual		= expected && T.resolveOwn(expected, scope);
				const arrayLike			= contextual?.type === 'union' ? T.unionMembers(contextual, scope).map(m => T.resolveOwn(m, scope)).filter(m => m.type === 'tuple' || m.type === 'array') : [];
				const resolvedExpected	= arrayLike.length === 1 ? arrayLike[0] : contextual;
				// A context with ANY tuple member makes the literal a tuple, as TS (`TA | TB` both tuples); each position's context
				// is that position across them.
				const tuples			= resolvedExpected?.type === 'tuple' ? [resolvedExpected] : arrayLike.filter((m): m is Type & { type: 'tuple' } => m.type === 'tuple');
				const wantTuple			= tuples.length > 0;
				const positionExpected	= (i: number) => T.combineTypes(tuples.flatMap(t => { const el = T.tupleElementType(t.elements[i]); return el ? [el] : []; }));
				// Otherwise an element's context is what the context iterates to (TS): an `Iterable<T>`'s `T` as much as an array's element.
				const elemExpected		= wantTuple ? undefined : resolvedExpected?.type === 'array' ? resolvedExpected.element : contextual && iteratedContext(contextual, scope);
				const elems: Type[] = [];
				let i = 0;
				for (const el of e.elements) {
					if (el) {
						if (el.type === 'spread')
							elems.push(iterationOrReport(recurse(el.operand), scope, pos, err).yield);
						else
							elems.push(recurse(el, wantTuple ? positionExpected(i) : elemExpected));
					}
					i++;
				}
				if (wantTuple)
					return { type: 'tuple', elements: elems };
				// An EMPTY literal has no elements to infer from, so context is the only information there
				// is: `const a: Spec[] = []` and `specs ?? []` both want `Spec[]`, not `any[]` -- and an
				// `any[]` in a union (`Spec[] | any[]`) leaves member lookup with nothing to offer, which
				// is how a `.map` callback's parameter ended up with no type at all.
				if (!elems.length)
					return resolvedExpected?.type === 'array' ? resolvedExpected : TS.ArrayType(elemExpected ?? T.ANY);
				// LITERAL WIDENING, as real TS does it: `[1, 2, 3]` is `number[]`, not `(1|2|3)[]` -- an
				// array literal is MUTABLE, so keeping the initialiser's literal types made `a[0] = 5` a
				// type error ("Type '5' is not assignable to type '1 | 2 | 3'"). It also leaked into
				// codegen: the element STORAGE already widens (`wasmTypeOf`), so a callback parameter
				// contextually typed from the unwidened element came back `i32` against an `f64` array,
				// and `[1,2,3].map(x => x * 2)` could not compile at all.
				// Skipped when a contextual array type supplied the element type -- that annotation is a
				// deliberate choice and outranks inference. `widenLiterals` keeps a `frozen` leaf as-is, so
				// `[1, 2, 3] as const` still means exactly what it says.
				const elem = T.combineTypes(elems);
				return TS.ArrayType(elemExpected ? elem : T.widenLiterals(elem));
			}

			case 'object': {
				// A union context is first narrowed by this literal's own discriminant values, as TS does (`type: 'inter'` picks Inter).
				const context = expected && discriminateContext(expected, e, scope);
				const members: TS.TypeMember[] = [];
				// A later property overrides an earlier one with the same key -- real JS object-literal semantics,
				// and what lets a spread's own members participate (`{...X, key: override}` or `{key, ...X}`).
				const byKey	= new Map<string, number>();
				const push	= (m: TS.TypeMember) => {
					const key = 'key' in m ? T.memberKey(m.key) : undefined;
					if (key !== undefined) {
						const i = byKey.get(key);
						if (i !== undefined) {
							// A later OPTIONAL property does NOT erase an earlier one: at runtime an absent
							// property leaves the earlier value in place, which is exactly what the
							// `{...defaults, ...opts}` idiom relies on. So the result is either type, and is
							// optional only if both were. An explicit `key: value` is never optional and
							// still overrides outright, as does a required spread member.
							const prev = members[i];
							// Resolved before combining: a mapped type's own member (`Partial<typeof D>['k']`) is an
							// unresolved indexed access, which would union with the earlier `string` instead of
							// collapsing into it. Its `| undefined` is dropped too -- optionality is the
							// modifier, and the absent case is precisely what the earlier member covers.
							members[i] = m.type === 'property' && prev.type === 'property' && hasMod(m, 'optional')
								? TS.TypeProperty(key, T.combineTypes([prev.typeAnnotation, T.nonNullable(T.resolveOwn(m.typeAnnotation, scope), scope)]), hasMod(prev, 'optional') ? ['optional'] : undefined)
								: m;
							return;
						}
						byKey.set(key, members.length);
					}
					members.push(m);
				};
				// An interface that EXTENDS another resolves to an INTERSECTION, never a plain object (ts-parser's
				// `CallSig`, spread by `checkCall`'s own `settle`): each part contributes its members, a later
				// part winning as spreading each in turn would. `undefined` where they aren't determinable.
				const intersectionMembers = (t: Type, depth = 4): TS.TypeMember[] | undefined => {
					if (!depth)
						return undefined;
					const parts = T.flattenIntersection(t, scope).map(x => {
						const r = T.resolveMembers(x, scope);
						return r.type === 'object' ? r.members : r.type === 'intersection' ? intersectionMembers(r, depth - 1) : undefined;
					});
					return parts.every(m => !!m) ? parts.flat() as TS.TypeMember[] : undefined;
				};
				for (const p of e.properties) {
					if (p.type === 'spread') {
						const t		 = T.resolveOwn(recurse(p.operand), scope);
						const members = t.type === 'object' ? t.members : t.type === 'intersection' ? intersectionMembers(t) : undefined;
						if (!members)
							return T.ANY;	// not a determinable object shape -- shape unknowable here, as before
						members.forEach(push);
					} else {
						// A `satisfies`/annotated-`var_decl` `expected` type propagates member-by-member: an unannotated arrow/method
						// value (`{read: (pe, data) => ...}`) otherwise types its own params as `any`, same gap `applyContextualParams`
						// already closes for call arguments.
						const key				= T.memberKey(p.key);
						const expectedMember	= context && key !== undefined ? contextualMember(context, key, scope) : undefined;
						switch (p.type) {
							case 'method':
								applyContextualParams(p.params, expectedMember, scope);
								checkFunctionBody(p, p.body, scope, hasMod(p, 'async'), hasMod(p, 'generator'), hasMod(p, 'generator'), err);
								if (key !== undefined)
									push(TS.TypeMethod(p.key, T.FixSig(p, T.ANY)));
								break;
							case 'get':
								checkFunctionBody(p, p.body, scope, false, false, false, err);
								push(TS.TypeProperty(p.key, p.returnType ?? T.ANY));
								break;
							case 'set':
								checkFunctionBody(p, p.body, scope, false, false, false, err);
								break;
							case 'field': {
								// A literal stays literal where its context expects one (TS's isLiteralOfContextualType): `{ kind: "mod" }` as a `Mod`.
								// A value `as const` reaches is itself in the const context, and does not widen.
								const valueConst = isConstContext(expected) ? constContextOf(p.value!, expected.typeArgs?.[0] && key !== undefined ? contextualMember(expected.typeArgs[0], key, scope) : undefined) : undefined;
								const _t = isConstContext(expected) && valueConst ? typeOf(p.value!, scope, false, valueConst, yieldCollector, err)
									: widenForContext(typeOf(p.value!, scope, false, expectedMember, yieldCollector, err), expectedMember, scope);
								if (key !== undefined)
									push(TS.TypeProperty(p.key, _t));
								break;
							}
						}
					}
				}
				return TS.ObjectType(members);
			}

			case 'function': {
				const csig = applyContextualParams(e.params, expected, scope);
				checkFunctionBody(e, e.body, ownThis(new Scope(scope)), hasMod(e, 'async'), hasMod(e, 'generator'), hasMod(e, 'generator'), err, shapedHint(csig?.returnType, scope));
				return TS.FunctionType(T.FixSig(e, T.ANY, e.returnType));
			}
			case 'arrow': {
				const csig = applyContextualParams(e.params, expected, scope);
				checkFunctionBody(e, e.body, scope, hasMod(e, 'async'), false, false, err, shapedHint(csig?.returnType, scope));
				return TS.FunctionType(T.FixSig(e, T.ANY, e.returnType));
			}

			case 'member': {
				const key		= assignmentTargets.has(e) ? undefined : T.pathKey(e);
				const refined	= key && scope.value(key);	// dotted keys live only in narrowings
				if (refined)
					return refined;
				const objT	= recurse(e.object);
				// `Uint8Array`/`Int32Array`/`Uint32Array`/etc are aliases to `TypedArray<T>` (`lib.d.ts`) --
				// checked here by name, on the *unresolved* `objT`, before `T.resolve` expands the alias into
				// `TypedArray<T>`'s own merged (real class + ambient interface, `lib/typedarray.ts`'s own
				// header comment) shape: `T.resolve` doesn't flatten an intersection, so a resolved check here
				// would never match at all, same reason `i32`/`u8`/etc are checked by name before resolving.
				if (T.isRefOf(objT, TYPED_ARRAY_RANGES) && !objT.typeArgs) {
					// Bounded, not bare `number` -- a loop comparing against these should stay `i32` in towasm.ts rather than promoting to `f64`
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
				const chained		= isOptionalChainLink(e);
				if (T.isRef(T.resolve(scope, T.nonNullable(objT, scope, chained)), 'ArrayBuffer') && e.property === 'byteLength')
					return TS.RangeType('number', 0, 0x7fffffff, true);

				// `?.` (direct or chained) only ever looks the property up on the non-nullish part of `objT`
				// -- `lookupMember`'s own union case requires *every* member to have it (a bare
				// `null`/`undefined` member never does), so an unguarded `T.lookupMember(objT, ...)` here
				// would always miss and fall back to `any` the moment `objT` includes either. A genuinely
				// non-chained access keeps the full (possibly nullish) `objT` -- real TS itself only allows
				// that when it's already known non-nullish, so leaving it as-is is what lets the
				// `sealed`/`err` check below still flag `x.y` on a possibly-null `x` (dropping nullish
				// members here unconditionally would silently accept it).
				const t		= T.lookupMember(T.nonNullable(objT, scope, chained), e.property, scope);
				if (!t) {
					if (err && !e.optional && T.sealed(objT, scope))
						err(SEVERITY.ERROR, pos)`Property '${e.property}' does not exist on type '${show().type(objT)}'`;
					return T.ANY;
				}
				// `lookupMember` returns an optional property's type unwidened (callers needing "is this optional" use `memberOptional`);
				// a plain read here must still see the `| undefined` a chained (direct or continued) optional access actually allows.
				return T.optional(t, chained || T.memberOptional(objT, e.property, scope));
			}
			case 'index': {
				// A literal index is a path (`args[0]`) that narrowing refines, exactly as a member's is.
				const indexKey	= assignmentTargets.has(e) ? undefined : T.pathKey(e);
				const refined	= indexKey && scope.value(indexKey);
				if (refined)
					return refined;
				const rawObjT = recurse(e.object);
				// `chained`, not a bare `e.optional` -- see `case 'member'`'s own comment on `isOptionalChainLink`;
				// same "a chain continuation isn't itself `?.` but still short-circuits" reasoning applies here.
				const chained = isOptionalChainLink(e);
				// Checked by name on the *unresolved* type, same reason `case 'member'`'s own `TYPED_ARRAY_RANGES`
				// check above is -- `T.resolve` below expands a typed-array alias into `TypedArray<T>`'s merged
				// (real class + ambient interface) shape, an intersection it never flattens, so a resolved check
				// would never match.
				if (T.isRefOf(rawObjT, TYPED_ARRAY_RANGES) && !rawObjT.typeArgs)
					return T.optional(T.rangeToType(TYPED_ARRAY_RANGES.get(rawObjT.name)!), chained);
				// Same reasoning as `case 'member'`'s own `T.nonNullable` use just above: `?.` (direct or
				// chained) only ever indexes the non-nullish part of `objT` -- left as the full (possibly
				// nullish) union, none of the branches below (`'array'`/`'tuple'`/index-signature/named-key)
				// would ever match at all, since `T.resolve` never collapses a union on its own, and every
				// one would silently fall through to the bare `T.ANY` at the end.
				// `resolveMembers`: every branch below reads a STRUCTURE off `objT` -- an element type, a
				// tuple, an index signature, a named key -- so this is one of the few places a named class
				// has to give up its nominal identity (`Array<T>` spelled out, chief among them).
				const objT = T.resolveMembers(T.nonNullable(rawObjT, scope, chained), scope);
				recurse(e.index);
				if (objT.type === 'array')
					return T.optional(objT.element, chained);
				// A union of tuples and arrays reads each member's position (TS's getIndexedAccessType): a member too short there, or
				// optional there, reads `undefined` (js-parser.ts `CallSig`'s `args[1]` over `CallSigParams<T>`).
				if (objT.type === 'union' && T.isLiteral(e.index, 'number')) {
					const i			= e.index.value;
					const members	= T.unionMembers(objT, scope).map(m => T.resolveOwn(m, scope));
					if (members.every(m => m.type === 'tuple' || m.type === 'array'))
						return T.optional(T.combineTypes(members.map(m => m.type === 'array' ? m.element : T.tupleReadType(m, i, scope) ?? T.UNDEFINED)), chained);
				}
				// A literal index reads that property of each member: a tuple's position, an interface's `0:` key.
				const atKey = objT.type !== 'tuple' && T.isLiteral(e.index, 'number') && T.lookupMember(objT, String(e.index.value), scope);
				if (atKey)
					return T.optional(atKey, chained);
				const arrayUnion = T.literalString(e.index) === undefined && T.arrayUnionAsArray(objT, scope);
				if (arrayUnion)
					return T.optional(arrayUnion.element, chained);
				// A tuple indexed by a COMPUTED number reads any of its positions, as TS's `T[number]` does -- towasm's own desugared
				// `for...of` indexes its source by a loop variable, and got `any` for every element of a tuple.
				if (objT.type === 'tuple' && !T.isLiteral(e.index, 'number') && T.isNumberLike(recurse(e.index), scope))
					return T.optional(T.combineTypes(objT.elements.map((_, i) => T.tupleReadType(objT, i, scope) ?? T.UNDEFINED)), chained);
				if (objT.type === 'tuple' && T.isLiteral(e.index, 'number')) {
					const t = T.tupleReadType(objT, e.index.value, scope);
					if (err && !t)
						err(SEVERITY.ERROR, pos)`Tuple type '${show().type(objT)}' has no element at index ${e.index.value}`;
					return t ? T.optional(t, chained) : T.ANY;
				}
				// A declared `[i: number]: T` index signature (real lib.d.ts typed arrays once `TStypeCheckAsync`
				// loads one, `Record<number, T>`-shaped types, etc) -- `indexSignatureOf` also searches every
				// part of an intersection (e.g. `TypedArray<T>`'s own merged interface+class shape, reached
				// through `this` inside its own method bodies with no alias name left to special-case by).
				// Not a fallback from something more precise -- for a computed/non-literal numeric key there's
				// no possible *named* property to prefer over it, so this is the only thing that can type
				// `obj[i]` against an object-shaped (or intersection) type at all.
				if (T.literalString(e.index) === undefined) {
					const idxT = T.indexSignatureOf(objT, scope);
					if (idxT)
						return T.optional(idxT, chained);
				}
				const literalKey = T.literalString(e.index);
				if (literalKey !== undefined) {
					const t = T.lookupMember(objT, literalKey, scope);
					if (err && !t && T.sealed(objT, scope))
						err(SEVERITY.ERROR, pos)`Property '${literalKey}' does not exist on type '${show().type(objT)}'`;
					if (!t)
						return T.ANY;
					return T.optional(t, chained || T.memberOptional(objT, literalKey, scope));
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
				// Hoisted out of the `if` below (was `const objT`, block-scoped) so the `this`-typed-return
				// substitution further down can reuse it instead of calling `recurse(e.callee.object)` a
				// second time -- re-evaluating the same receiver expression twice caused a real, observed
				// regression (a duplicate diagnostic on one real corpus file, a genuine wrong-type result on
				// another), root-caused via a real whole-workspace sweep, not assumed.
				// `super(...)` invokes the base CONSTRUCTOR -- `case 'super'` yields the base's instance side, which `super.m` needs --
				// so it resolves through the very path `new` does, against the constructor `classBodyScopes` bound for it.
				const construct = e.type === 'new' || e.callee.type === 'super';
				let calleeObjT: Type | undefined;
				if (e.type === 'call' && e.callee.type === 'member') {
					calleeObjT = recurse(e.callee.object);
					// `super.m()`'s receiver is the DERIVED one: a base method returning `this` yields the current `this`, not the base instance.
					if (e.callee.object.type === 'super')
						calleeObjT = scope.value('this') ?? calleeObjT;
					if (T.isRefOf(calleeObjT, TYPED_ARRAY_RANGES) && !calleeObjT.typeArgs) {
						switch (e.callee.property) {
							case 'indexOf': case 'lastIndexOf':	return TS.RangeType('number', -1, 0x7fffffff, true);
							case 'includes':					return T.BOOLEAN;
							case 'reverse': case 'slice': case 'concat': case 'fill': case 'subarray':
								return TS.RefType(calleeObjT.name);
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
				// `f?.()` puts the optionality on the CALL node itself, not on a member callee, so the
				// nullish strip-and-reattach below never ran for it: `(() => number) | undefined` isn't
				// function-shaped, signature lookup found nothing, and the whole call typed as `any`.
				const calleeOptional = (e.callee.type === 'member' && isOptionalChainLink(e.callee)) || !!(e as { optional?: boolean }).optional;
				let calleeT		= T.mergeIdenticalSignatures(T.resolveOwn(T.nonNullable(e.callee.type === 'super' ? scope.value('super()') ?? T.ANY : recurse(e.callee), scope, calleeOptional), scope));
				if (calleeT.type === 'union' && calleeObjT && e.callee.type === 'member') {
					const arr		= T.arrayUnionAsArray(T.nonNullable(calleeObjT, scope, calleeOptional), scope);
					const method	= arr && T.lookupMember(arr, e.callee.property, scope);
					if (method)
						calleeT = T.resolveOwn(method, scope);
				}
				// Explicit call-site type args (`f<Foo>(...)`) are raw AST, never stamped like a declaration's own annotations --
				// unstamped, a ref substituted into the callee's generic body would resolve against the callee's scope, not the caller's.
				let typeArgs	= e.typeArgs?.map(t => T.stampScope(t, scope));
				// `super(...)` against a generic base is the base constructor instantiated by the EXTENDS clause's own type
				// arguments (`extends A<string>`): those ARE this call's type arguments, so the base's `T` is fixed, not re-inferred.
				if (!typeArgs && e.callee.type === 'super') {
					const base = scope.value('super');
					typeArgs = base?.type === 'ref' ? base.typeArgs : undefined;
				}
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
							walkerB(undefined, (x, process) => {
								if (x.type === 'call' && x.callee.type === 'identifier' && x.callee.name === resolveName) {
									const arg = x.arguments[0];
									resolvedTypes.push(arg && arg.type !== 'spread' ? recurse(arg) : T.UNDEFINED);
								}
								return process(x);
							}).body(executor.body as JS.Stmt<any>[] | Expr);
							typeArgs = [resolvedTypes.length ? T.combineTypes(resolvedTypes) : T.VOID];
						}
					}
				}

				// An `any` callee is called (or constructed) as TS does: the result is `any`, and every argument is still checked.
				if (T.isRef(T.resolveOwn(calleeT, scope), 'any')) {
					for (const a of e.arguments)
						recurse(a.type === 'spread' ? a.operand : a);
					return T.ANY;
				}
				let overloads: TS.CallSig[] | undefined;
				const parts = calleeT.type === 'intersection' ? calleeT.types.map(p => T.resolveOwn(p, scope)) : [calleeT];
				// A bare `constructor` part is NOT taken for a plain call: that would pre-empt the call-vs-construct
				// preference the member scan below implements. A primitive wrapper is exactly that shape -- `class
				// BigInt`'s constructor alongside a `declare var BigInt` whose call signature returns `bigint`, so
				// `BigInt(5)` must type as `bigint`, and its own call signature is found by that scan.
				// `new` on an intersection of constructor types constructs what TS's mixin rule makes of it (`T.constructSignatures`).
				const mixedCtors = construct && calleeT.type === 'intersection' ? T.constructSignatures(calleeT, scope) : [];
				if (mixedCtors.length > 1)
					overloads = mixedCtors;
				let sig: TS.CallSig|undefined = mixedCtors.length === 1 ? mixedCtors[0] : mixedCtors.length ? undefined
					: construct ? parts.find(p => p.type === 'constructor') ?? parts.find(p => p.type === 'function')
					: parts.find(p => p.type === 'function');
				sig ??= overloads ? undefined : T.unionSignature(calleeT, construct ? 'construct' : 'call', scope);
				if (!sig && !overloads) {
					// Each kind takes only its OWN signatures: TS rejects both cross directions -- a plain call on a
					// construct-only value is TS2348, and `new` on a call-only one TS7009 (which still evaluates to `any`).
					const members 		= T.collectMembers(calleeT, scope);
					const constructs	= members.filter(m => m.type === 'construct');
					const callSigs		= members.filter(m => m.type === 'call');
					const own			= construct ? constructs : callSigs;
					// `new` still falls back to a call signature: TS reports that as TS7009, an IMPLICIT-ANY diagnostic that
					// fires only under `noImplicitAny` (which this checker does not track yet) and still evaluates to `any` --
					// erroring unconditionally cost 56 corpus false positives. A plain call on a construct-only value is
					// different: TS2348 is unconditional, so that direction is rejected here.
					const calls			= own.length || !construct ? own : callSigs;
					if (calls.length === 1) {
						sig = calls[0];
					} else if (calls.length > 1) {
						overloads = calls;		// resolved below, once argument types are known
					} else if (!construct && (constructs.length > 0 || parts.some(p => p.type === 'constructor'))) {
						if (err)
							err(SEVERITY.ERROR, pos)`Type '${show().type(calleeT)}' is not callable without 'new' in '${show().expression(e)}'`;
						return T.ANY;
					} else if (T.sealed(calleeT, scope)) {
						if (err)
							err(SEVERITY.ERROR, pos)`Type '${show().type(calleeT)}' is not callable in '${show().expression(e)}'`;
						return T.ANY;
					}
				}

				// Contextual parameter typing: an unannotated callback argument (`arr.map(x => x.foo)`) would otherwise type its own params as `any`.
				// Fills them in here from the matching declared (pre-substitution) param type -- mutates the AST node; must run before `argTs` below,
				// which triggers `checkFunctionBody` on each argument. A `trial` reports nothing, but still FIXES a callback's parameters, as TS does.
				const settle = (sig: TS.CallSig, trial: boolean) => {
					const arg		= (a: Expr, exp?: Type) => trial ? typeOf(a, scope, false, exp, yieldCollector, undefined) : recurse(a, exp);
					const declScope	= T.declScopeOf(sig, scope);

					// First pass, non-callback arguments only (reused below in `argTs`, so nothing gets double-typed/reported): infers a type
					// param from a sibling argument (`arr.reduce((acc, x) => ..., seed)`'s `U` from `seed`) before typing the callback itself.
					// Also threads the matching declared param type through as `expected` -- a literal argument (`heap.push([1, ...])`
					// against `push(item: [number, number[]])`) needs real contextual typing the same way an object/array literal
					// var-decl initializer already gets, or a tuple-typed param silently infers as a plain, wider array instead and
					// fails assignability for real (this was long masked by an unrelated opaque-`this` leniency bug elsewhere, not a
					// coincidence this stayed invisible). Skipped when the declared type still mentions one of *this* signature's own
					// (not yet inferred) type params -- `preMap`, which resolves those, is itself built FROM this very pass below, so
					// it isn't available yet, and threading a still-generic shape as `expected` risks a wrong contextual guess.
					// Past the fixed parameters the REST names the argument -- and where the rest is a tuple
					// (or a union with one), that position's own element is the only thing that names a callback.
					const declaredArg = (i: number) => sig!.params[i]?.typeAnnotation
						?? (sig!.rest?.typeAnnotation && T.restArgType(sig!.rest.typeAnnotation, i - sig!.params.length, scope));
					const preArgTs = e.arguments.map((a, i) => {
						if (a.type === 'function' || a.type === 'arrow' || a.type === 'spread')
							return undefined;
						// The inner call of `new Map(xs.map(x => [a, b]))` reverse-matches its own `U` from the tuple shape -- see `instantiate`'s
						// `fromExpected`, which keeps that placeholder binding from escaping as the answer.
						return arg(a, argContext(a, declaredArg(i), sig!, scope));
					});
					// TS's two passes: every non-callback argument feeds the inference first, then each callback in order -- its
					// context FIXES the type parameters its own parameters read, and its return feeds only the ones still open.
					// Explicit type arguments leave nothing to infer.
					const explicit	= typeArgs && sig.typeParams?.length ? new Map(sig.typeParams.map((p, i) => [p.name, typeArgs![i] ?? p.default ?? T.ANY] as const)) : undefined;
					const inference	= !explicit && sig.typeParams?.length ? new T.Inference(sig.typeParams, scope, declScope) : undefined;
					if (inference) {
						preArgTs.forEach((t, i) => {
							const p = sig!.params[i];
							const a = e.arguments[i];
							if (t && p?.typeAnnotation)
								(a.type === 'object' || a.type === 'array' ? inference.inferFromLiteral : inference.infer).call(inference, p.typeAnnotation, t);
						});
						// A param no argument pins down may come from where the call's result is going (`new Promise<T>((resolve) => ...)`).
						if (expected && sig.returnType)
							inference.inferReturn(sig.returnType, expected);
						settleFromReturn(inference, scope);
					}

					const contextOf = (a: Expr, declared: Type | undefined) => declared && (explicit ? T.substituteType(declared, explicit)
						: !inference ? declared : isContextSensitive(a) ? inference.contextFor(declared) : T.substituteType(declared, inference.current()));
					const typeCallback = (a: Expr & { type: 'function' | 'arrow' }, i: number) => {
						const declared		= declaredArg(i);
						// TS's inferFromAnnotatedParameters: `(t1: D, t2) => ...` against `(t: T, t1: T) => void` fixes `T = D` from `t1`
						// first, so `t2` sees `D`, not `T`'s constraint. (A callback's own `...rest` annotation is not a source yet.)
						const declaredSig	= inference && declared && T.findFunctionType(declared, scope);
						if (declaredSig)
							a.params.forEach((p, k) => {
								const target = declaredSig.params[k]?.typeAnnotation
									?? (declaredSig.rest?.typeAnnotation && T.restArgType(declaredSig.rest.typeAnnotation, k - declaredSig.params.length, scope));
								if (p.typeAnnotation && target)
									inference!.infer(target, p.typeAnnotation);
							});
						const contextual	= contextOf(a, declared);
						applyContextualParams(a.params, contextual, scope);
						// For codegen, which compiles an overload's IMPLEMENTATION and so never sees this. Only once fully
						// determined: the same call is also typed without context, which leaves the signature's own params open.
						const defaults	= new Map(sig!.typeParams?.filter(p => p.default && !inference?.inferred(p.name)).map(p => [p.name, p.default!] as const));
						const settled	= contextual && defaults.size ? T.substituteType(contextual, defaults) : contextual;
						if (!trial && settled && !sig.typeParams?.some(p => T.mentionsTypeParam(settled, p.name)))
							(a as any).contextualType ??= T.stampScope(settled, scope);
						// The same contextual signature handed to the body too: `xs.map(x => [a, b])` against a `[K, V][]`-shaped
						// parameter can only produce a TUPLE if the callback's own return position is contextually typed.
						const t = arg(a, contextual);
						if (inference && declared)
							inference.infer(declared, t);
						return t;
					};
					const annotated = new Map(e.arguments.flatMap((a, i) => (a.type === 'function' || a.type === 'arrow') && !isContextSensitive(a) ? [[i, typeCallback(a, i)] as const] : []));

					const restElementTs: Type[] = [];
					const argTs = e.arguments.map((a, i) => {
						if (a.type === 'function' || a.type === 'arrow')
							return annotated.get(i) ?? typeCallback(a, i);
						if (a.type !== 'spread')
							return preArgTs[i];
						const t		= T.resolveOwn(arg(a.operand), scope);
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
							restElementTs.push(argTs[i]);
					});

					return { ...instantiate(sig, argTs, typeArgs, scope, pos, restElementTs, expected, trial ? undefined : err, inference), declScope, argTs };
				};

				// Overload resolution, TS's two passes. Every candidate is first tried with its context-sensitive callbacks untyped (which
				// candidate types their parameters isn't known yet): they infer nothing and fit as TS's `anyFunctionType` does, anything
				// that accepts a function. A candidate that fits then types them -- FIXING their parameters -- and must still fit with
				// those types, or the next is tried with the callbacks as they now are. No fit at all stays a warning (inventory C3).
				if (overloads) {
					const hasSpread = e.arguments.some(a => a.type === 'spread');
					// A nested call's type depends on its context too: its callback's return is fixed by the first context it is typed in.
					const typedIn		= e.arguments.map(() => new Map<Type | undefined, Type>());
					const fits			= (c: TS.CallSig) => candidateFits(c, e.arguments, scope, typeArgs, typedIn, yieldCollector, pos);
					sig = overloads.find((c, k) => {
						if (!fits(c))
							return false;
						// The last candidate that can fit needs no second pass: resolution settles on it either way.
						if (!e.arguments.some(isContextSensitive) || !overloads!.slice(k + 1).some(fits))
							return true;
						const typed = settle(c, true);
						return T.argsFit(typed, typed.argTs, scope, hasSpread);
					});
				}
				if (overloads && !sig && err)
					err(SEVERITY.WARNING, pos)`No overload of '${show().expression(e.callee)}' matches this call; arguments left unchecked`;

				if (sig) {
					const { declScope, argTs, params, returnType } = settle(sig, false);
					
					// TBD: check if callee if pure

					if (err && !argTs.some(t => t === undefined)) {	// no spread args
						// TS's minimum argument count runs through the last required parameter -- and in an immediately-invoked function
						// expression, an unannotated parameter no argument reaches is optional.
						const iife		= e.type === 'call' && (e.callee.type === 'function' || e.callee.type === 'arrow') ? e.callee : undefined;
						const required	= params.reduce((n, p, i) => hasMod(p, 'optional') || (iife && i >= argTs.length && !iife.params[i]?.typeAnnotation) ? n : i + 1, 0);
						const max		= sig.rest ? Infinity : params.length;
						if (argTs.length < required || argTs.length > max)
							err(SEVERITY.ERROR, pos)`Expected ${required === max ? required : required + '-' + (max === Infinity ? 'more' : max)} arguments, but got ${argTs.length} in '${show().expression(e)}'`;
						argTs.forEach((t, i) => {
							const p = params[i];
							if (t && p && p.typeAnnotation) {
								// an optional parameter also accepts undefined
								if (!checkAssignable(t, hasMod(p, 'optional') ? TS.UnionType([p.typeAnnotation, T.UNDEFINED]) : p.typeAnnotation, scope, pos, declScope, err))
									err(SEVERITY.ERROR, pos)`Argument of type '${show().type(t)}' is not assignable to parameter '${show().bindingTarget(p.key)}: ${show().type(p.typeAnnotation)}' in '${show().expression(e)}'`;
								else
									checkExcessProps(e.arguments[i], p.typeAnnotation, pos, declScope, err);
							}
						});
					}

					if (e.callee.type === 'member' && e.callee.object.type === 'identifier' && e.callee.object.name === 'Math')
						return narrowMath(e.callee.property, params) ?? returnType!;

					// A predicate return is only special to `narrow()`'s dedicated `case 'call'`; as a plain value it's `boolean` (or `void`
					// if asserting) -- without this, the raw predicate type would leak into whatever consumes this expression next.
					const result = returnType && returnType.type === 'predicate' ? (returnType.asserts ? T.VOID : T.BOOLEAN) : returnType!;
					// A `this`-typed return (`sort(): this`) means "whatever the receiver's own type is" at a
					// real call site -- `this` as a type is never eagerly resolved elsewhere (see
					// `T.substituteThisType`'s own comment, `OPAQUE`'s inclusion of `'this'`), so a method
					// call's return needs it substituted in here, using the receiver expression's own type.
					if (e.callee.type === 'super')
						return T.VOID;
					return T.optional(e.callee.type === 'member' ? T.substituteThisType(result, calleeObjT ?? recurse(e.callee.object)) : result, calleeOptional);
				}
				return T.ANY;
			}

			// `expr<T,U>` (TS 4.7+): pins a generic function/constructor's type params without calling it. An overloaded callee keeps every
			// arity-compatible signature instantiated (still overloaded); anything else stays `ANY`, same leniency as an uncallable `case 'call'`.
			case 'instantiation': {
				const calleeT	= T.resolveOwn(recurse(e.expression), scope);
				// Same reasoning as the 'call'/'new' case above -- these type args are raw AST, never stamped.
				const typeArgs	= e.typeArgs.map(t => T.stampScope(t, scope));
				const fnPart	= (calleeT.type === 'intersection' ? calleeT.types.map(p => T.resolveOwn(p, scope)) : [calleeT]).find(p => p.type === 'function' || p.type === 'constructor');
				if (fnPart)
					return { type: fnPart.type, ...instantiate(fnPart, [], typeArgs, scope, pos, undefined, undefined, err) };
				if (calleeT.type === 'object') {
					const calls = calleeT.members.filter(m => m.type === 'call' || m.type === 'construct');
					if (calls.length)
						return TS.ObjectType(calls.map(m => TS.TypeMember(m.type, instantiate(m, [], typeArgs, scope, pos, undefined, undefined, err))));
				}
				return T.ANY;
			}

			case 'await':	return T.awaitType(recurse(e.operand), scope);

			case 'unary': {
				const argT = recurse(e.operand);
				switch (e.operator) {
					case '!':		return T.BOOLEAN;
					case 'typeof':	return T.STRING;
					case 'void':	return T.UNDEFINED;
					case 'delete':	return T.BOOLEAN;
				}
				const r = T.resolveOwn(argT, scope);
				if (T.isAny(r))
					return T.ANY;
				const nr = T.toRange(r);
				if (nr)
					return T.rangeToType(T.rangeUnOp(e.operator, nr)!);
				switch (e.operator) {
					case '++':
					case '--':
						if (err && !T.isNumberLike(r, scope))
							err(SEVERITY.ERROR, pos)`Operand of '${e.operator}' must be numeric, got '${show().type(argT)}' in '${show().expression(e)}'`;
						return T.isBigint(r, scope) ? T.BIGINT : T.NUMBER;
					default:
						return T.isBigint(r, scope) ? T.BIGINT : T.NUMBER;
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
					err(SEVERITY.ERROR, pos)`Operand of '${e.operator}' must be numeric, got '${show().type(argT)}' in '${show().expression(e)}'`;
				return T.isAny(T.resolveOwn(argT, scope)) ? T.ANY : T.isBigint(argT, scope) ? T.BIGINT : T.NUMBER;
			}

			// Sibling of the `await` split: `x = y` is a MUTATION, not a `Binary` whose operator happens to
			// end in `=`. `operator` absent is a plain `=`; present it is the compound form's BASE operator,
			// so nothing here slices a string to recover it.
			case 'assign': {
				markAssignmentTargets(e.target);
				let lt = recurse(e.target);
				// An assignment target's own type contextually types the value being written -- the same
				// `expected` channel a generic call already solves its type params from, and the only thing a
				// bare `new C` on the right has to go on (`scope.cache ??= new WeakMap`). Nullish members are
				// stripped because they defeat inference against a `C<...>`-shaped return without adding
				// anything: an `undefined` right side doesn't need a contextual type, and the assignability
				// check below still judges against the full declared `lt`.
				const rt = recurse(e.value, T.nonNullable(lt, scope));
				// Assignments are judged against the declaration-site type, not any active narrowing -- a dotted target goes through
				// `lookupMember` on the object's own type, not `typeOf` (which would consult the narrowings map instead).
				// A destructuring target (`e.target.type` 'object'/'array', reusing the literal AST shape) has no dedicated pattern
				// checker yet -- `recurse(e.target)` above just runs it as a value expression, so `lt` isn't a real declared type to
				// check `rt` against here. Matches `hoistVar`'s same gap for declaration-site patterns (widens to `any`, no check).

				if (e.target.type === 'member' || e.target.type === 'index') {
					// TBD: mark unpure if assigning to part of a parameter?

				}

				if (err && (e.target.type === 'identifier' || e.target.type === 'member' || e.target.type === 'index')) {
					let expando = false;
					if (e.target.type === 'identifier') {
						lt = scope.declared(e.target.name) || lt;
					} else if (e.target.type === 'member') {
						const objT = recurse(e.target.object);
						// A property assigned to a function declaration, or a `const` holding a function expression, is DECLARED by that
						// assignment (TS's expando, `foo.meta = 1`), not checked against the members `Function`/`Object` lend it.
						const holder = e.target.object.type === 'identifier' ? e.target.object.name : undefined;
						const init = holder !== undefined ? scope.alias(holder) : undefined;
						expando = holder !== undefined && (scope.decl(holder)?.type === 'function_decl' || init?.type === 'function' || init?.type === 'arrow');
						lt = expando ? rt : T.optional(T.lookupMember(objT, e.target.property, scope) || lt, T.memberOptional(objT, e.target.property, scope));
					} else if (e.target.type === 'index') {
						// A typed-array write accepts any real `number` (silently truncated/wrapped via the
						// element's own real JS coercion, never a type error) -- unlike a read, so the narrow
						// element range `typeOf`'s 'index' case gives typed-array reads doesn't apply here.
						// Checked by name, unresolved, same reason `typeOf`'s own 'index' case checks it that way.
						const objT = recurse(e.target.object);
						if (T.isRefOf(objT, TYPED_ARRAY_RANGES) && !objT.typeArgs)
							lt = T.NUMBER;
					}

					if (!e.operator) {
						if (!checkAssignable(rt, lt, scope, pos, scope, err)) {
							err(SEVERITY.ERROR, pos)`Type '${show().type(rt)}' is not assignable to type '${show().type(lt)}' in '${show().expression(e.target)} = ...'`;
						} else {
							checkExcessProps(e.value, lt, pos, scope, err);
							// Later statements see the assigned type, not the wider declared one. `pathKey`, not just an identifier: a
							// dotted target narrows the same way a bare name does, via the same narrowings map.
							// Not an expando: its type is the union of ALL its assignments (not collected yet), so one of them is too narrow.
							const key = T.pathKey(e.target);
							if (key && !expando)
								// Always widens for the narrowed-forward type, regardless of this call's own `widen` (a side effect
								// on `scope`, not part of the return value) -- matches plain JS assignment semantics: `x = 5` narrows
								// `x` to `number` from here on, not literal `5`, whether or not *this* expression's own answer is widened.
								scope.addNarrowing(key, T.widenLiterals(rt));
						}
					} else if (e.operator === '??' || e.operator === '||' || e.operator === '&&') {
						const key = T.pathKey(e.target);
						if (key) {
							// `x ??= y` leaves x holding its non-nullish members or y (and likewise for ||= / &&=)
							const other = T.isOther(e.operator[0]);

							scope.addNarrowing(key, T.combineTypes([
								...T.unionMembers(lt, scope).filter(m => !other(T.resolveOwn(m, scope), scope)),
								T.widenLiterals(rt),
							]));
						}
					}
				}
				return rt;
			}

			case 'binary': {
				const lt = recurse(e.left);

				if (LOGICAL_OPS.has(e.operator)) {
					// Precise throughout (`lt`/`rt` unwidened): a fresh literal's own value determines `other`/`makeNullish`
					// far more exactly than its widened form would (`5 && b` can see `5` is unconditionally truthy and drop
					// the falsy branch entirely; widened to `number` it couldn't). `typeOf`'s own final wrap widens the whole
					// combined result once, if the caller wants that -- there's nothing left for this case to decide itself.
					// `??`'s right operand is contextually typed by the LEFT's own non-nullish type: that is
					// what the whole expression yields, and it is what lets an empty literal on the right
					// take the shape rather than collapsing to `any[]`. `specs ?? []` is `Spec[]`, as real
					// tsc gives -- not `Spec[] | any[]`, whose `.map` then had no callback type to offer,
					// which is how a closure parameter ended up with no representation at all.
					// Only `??`: `&&`/`||` yield a value of either side, so the left is no guide to the right.
					const rightExpected = e.operator === '??' ? T.nonNullable(lt, scope) : undefined;
					const rightScope	= e.operator === '&&' ? narrow(e.left, scope, true) : e.operator === '||' ? narrow(e.left, scope, false) : scope;
					stampBranch(e.right, rightScope, scope);
					const rt	= typeOf(e.right, rightScope, false, rightExpected, yieldCollector, err);
					return T.combineTypes([T.logicalLeftPart(lt, e.operator, scope), rt]);
				}
				const rt = recurse(e.right);
				if (COMPARISON_OPS.has(e.operator))
					return T.BOOLEAN;

				if (e.operator === '+') {
					if (T.isStringLike(lt, scope) || T.isStringLike(rt, scope))
						return T.STRING;
					if (T.isAny(T.resolveOwn(lt, scope)) || T.isAny(T.resolveOwn(rt, scope)))
						return T.ANY;		// could be string concatenation
				}
				if (err) {
					if (!T.isNumberLike(lt, scope))
						err(SEVERITY.ERROR, pos)`Operand of '${e.operator}' must be numeric, got '${show().type(lt)}' in '${show().expression(e.left)}'`;
					if (!T.isNumberLike(rt, scope))
						err(SEVERITY.ERROR, pos)`Operand of '${e.operator}' must be numeric, got '${show().type(rt)}' in '${show().expression(e.right)}'`;
				}
				if (T.isAny(T.resolveOwn(lt, scope)) || T.isAny(T.resolveOwn(rt, scope)))
					return T.ANY;

				// Interval arithmetic keeps a bounded result bounded (`x + 1` for a range-narrowed `x`), instead of always
				// collapsing back to the base `number`/`bigint` -- falls through to the old plain-type result whenever
				// either operand isn't numeric-range-shaped, or the operator isn't one of these four.
				const lr = T.toRange(T.resolveOwn(lt, scope)), rr = T.toRange(T.resolveOwn(rt, scope));
				if (lr && rr ) {
					const nr = T.rangeBinOp(e.operator, lr, rr);
					if (nr)
						return T.rangeToType(nr);
				}
				return T.isBigint(lt, scope) || T.isBigint(rt, scope) ? T.BIGINT : T.NUMBER;
			}

			case 'conditional': {
				recurse(e.test);
				const thenScope = narrow(e.test, scope, true), elseScope = narrow(e.test, scope, false);
				stampBranch(e.consequent, thenScope, scope);
				stampBranch(e.alternate, elseScope, scope);
				// Precise per branch (`widen: false`) -- `typeOf`'s own final wrap widens the combined result once, if
				// the caller wants that, same reasoning as the logical-operator case above.
				return T.combineTypes([
					typeOf(e.consequent, thenScope, false, expected, yieldCollector, err),
					typeOf(e.alternate, elseScope, false, expected, yieldCollector, err)
				]);
			}

			case 'sequence':
				return e.expressions.map(x => recurse(x)).pop() ?? T.ANY;

			case 'spread':
				return recurse(e.operand);

			// TS types a tagged template as the call `tag(strings, ...substitutions)`: overloads, inference and argument checks alike.
			case 'tagged_template': {
				const at = <N extends object>(n: N) => Object.defineProperty(n, 'pos', { value: pos, enumerable: false });
				const strings = at({ type: 'as', expression: at({ type: 'array', elements: [] }), typeAnnotation: TS.RefType('TemplateStringsArray') } as Expr);
				return recurse(at({ type: 'call', callee: e.tag, arguments: [strings, ...e.quasi.flatMap(p => p.exp ? [p.exp] : [])] } as Expr), expected);
			}
			case 'yield': {
				// A declared generator's Y is a plain `yield`'s context, and what is yielded must fit it.
				const fnKind	= scope.enclosingFunction();
				const async		= !!fnKind?.async;
				const argT		= e.operand ? recurse(e.operand, e.delegate ? undefined : fnKind?.yield) : T.UNDEFINED;
				// `yield* x` yields what `x` iterates to and evaluates to what its iterator returns.
				const delegated	= e.delegate ? iterationOrReport(argT, scope, pos, err, async) : undefined;
				const yielded	= delegated ? delegated.yield : T.unwrapIfAsync(argT, scope, async);
				if (err && fnKind?.yield && !checkAssignable(yielded, fnKind.yield, scope, pos, scope, err))
					err(SEVERITY.ERROR, pos)`Type '${show().type(yielded)}' is not assignable to the yielded type '${show().type(fnKind.yield)}'`;
				yieldCollector?.push(delegated ? yielded : T.widenLiterals(yielded));
				// `yield x` evaluates to what `next(v)` is given: the declared N, else `any` (as TS, which flags it under noImplicitAny).
				return delegated ? delegated.return : fnKind?.next ?? T.ANY;
			}

			case 'class':
				return checkClass(e as TS.Class, scope, err);

			case 'as': {
				const anno = e.typeAnnotation;
				// `T.freeze`: any assertion's result is exempt from `widenLiterals`, permanently -- both branches (an
				// explicit `as const`, or a plain `as T` returning `T` itself) get it, since a plain type assertion
				// never auto-widens either, matching real TS. Survives being embedded in a later-widened container
				// (`[1, x as const]`) or passed through `satisfies`/a comma/a spread, unlike a shape-based check on
				// `e` itself would (that only ever sees the *top-level* expression `typeOf` was originally called on).
				return T.freeze(isConstContext(anno) ? recurse(e.expression, constContext(expected)) : anno);
			}
			case 'satisfies': {
				const anno = e.typeAnnotation;
				const t = recurse(e.expression, anno);
				if (err) {
					if (!checkAssignable(t, anno, scope, pos, scope, err))
						err(SEVERITY.ERROR, pos)`Type '${show().type(t)}' does not satisfy the expected type '${show().type(anno)}'`;
					else
						checkExcessProps(e.expression, anno, pos, scope, err);
				}
				return t;
			}
			default:
				return T.ANY;
		}
	}
}

// ---- functions / classes / statements -------------------------------------------------------

// `contextualReturn`: what the CALL SITE wants this function to return, when it declares no return type
// of its own. Purely an inference hint -- it shapes the body's own types (an array literal against a
// tuple becomes a tuple) and never produces an assignability diagnostic, which is what `expected`, the
// DECLARED return type, is for.
function checkFunctionBody(fn: TS.CallSig, body: JS.Stmt<any>[] | Expr | undefined, scope: Scope, async: boolean, skipReturn?: boolean, generator?: boolean, err?: Err, contextualReturn?: Type) {
	if (!body)
		return;

	// A declared return type is never replaced by inference, even one (`any`, a generator's) that checks nothing.
	const declaredReturn = fn.returnType;
	// A declared generator's body is checked against what it iterates: `return x` against its TReturn, `yield`s against Y and N.
	const generatorTypes = generator && declaredReturn ? T.iterationTypes(declaredReturn, scope, async, undefined, true) : undefined;
	let expected = generator ? generatorTypes?.return : declaredReturn;
	if (expected && async && !generator) {
		const p = T.asPromiseRef(expected, scope);
		expected = p ? p.typeArgs![0] : expected;
	}
	// A declared type predicate (`x is T`) is never checked against the body's boolean return, same as `any` -- but unlike `any`, it must
	// not be *inferred over* either: the declared predicate is never a worse answer, so `fn.returnType` stays untouched below.
	const isPredicate = expected?.type === 'predicate';
	if ((skipReturn && !generator) || (expected && T.isAny(expected)) || isPredicate)
		expected = undefined;

	// A muted re-walk of a declared-return-type function is skipped ONLY once it's already been stamped
	// (`fn.scope` set) -- `narrow`'s speculative re-walks always run under `muted` and only ever reach a
	// given node *after* the real pass already checked it, so this is the common case this guard exists
	// for. But a lib method's *one and only* check (`makeLibScope`'s single muted `checkBlock`) would
	// otherwise never walk the body at all, silently skipping `applyContextualParams`'s side effect on an
	// unannotated callback param below (found via `lib/map.ts`'s `entries()`, whose `.map()` callback
	// params never got typed) -- so the very first walk still has to run, even muted.
	// "Already walked" is read off the BODY's stamp: a `function_decl`'s own `.scope` is also its statement
	// stamp, set before this runs, so on its own it made a muted pass skip every top-level function body.
	if (expected && !err && fn.scope && (!Array.isArray(body) || !body.length || (body[0] as any).scope || scope.isGenericTemplate()))
		return;

	const inner = new Scope(scope);
	inner.functionKind = { async, yield: generatorTypes?.yield, next: generatorTypes?.next };
	// `noStamp`: true only for the exact case the early-return above used to swallow entirely -- a muted
	// (no `err`), declared-return-type, first-ever-walked (`fn.scope` unset, or this line wouldn't be
	// reached at all) method belonging to a generic class's own instance scope
	// (`scope.isGenericTemplate()`). Everything else -- a constructor (`skipReturn` always forces
	// `expected` false, so it never qualifies), a real `err`-set check, a non-generic lib method (`String`)
	// -- stamps exactly as it always has.
	//
	// The reason this specific case must NOT stamp: this method body is a shared template, reused across
	// every concrete instantiation via structural substitution rather than re-checked per instantiation --
	// a stamp here would freeze the template's own unresolved type param forever (`??=` first-wins),
	// permanently blocking a later, per-instantiation-correct scope (`ctx.scope` in towasm.ts) from ever
	// being used instead. Leaving it unstamped is safe: every consumer of `fn.scope`/`(stmt as any).scope`
	// already falls back to something instantiation-correct when unset (see `makeLibScope`'s own comment
	// in towasm.ts). The walk itself still has to run either way, muted or not -- `applyContextualParams`'s
	// side effect on an unannotated callback param below doesn't depend on the scope stamp at all.
	// Only where there is nothing declared to check against -- a declared return type is always the
	// better answer, and `expected` alone must keep driving the diagnostics below.
	const inferHint = expected ? undefined : contextualReturn;
	const noStamp = !!expected && !err && scope.isGenericTemplate();
	if (!noStamp)
		fn.scope ??= inner;

	// `??=`, not `=`: the first (real, unmuted) check wins, the same reasoning as `fn.scope ??=` above --
	// a speculative (muted) re-walk always reaches a statement only after the real pass already has, and
	// must not overwrite what that concluded.
	const stamp: (s: Stmt, scope: Scope) => void = noStamp ? _ => {} : (s, scope) => {(s as any).scope ??= stampedScope(s, scope);};

	// The per-STATEMENT stamp is a wrapper this walk either composes or does not (see `stampScopes`),
	// rather than a flag threaded through `checkStmt` and `checkBlock`. `fn.scope` just above is the
	// separate, function-level stamp and still needs the flag itself.
	// Each of this function's own type params gets registered into its body's scope (`addTypeParam`,
	// not `addType` -- see its own comment on why the distinction matters for conditional-type
	// deferral), using its declared constraint (or `any` when unconstrained) as a real, resolvable
	// upper-bound approximation -- `resolve()`'s own `ref` case only ever looks up a real
	// `scope.type()` entry, and a bare, unregistered type-parameter name (e.g. `N` in `function
	// f<N extends X>(...)`) has none, so it stays fully opaque for every reference inside the body
	// (member access, `keyof`, assignability, ...) -- silently *tolerated*, not actually verified,
	// until now.
	for (const p of fn.typeParams ?? [])
		inner.addTypeParam(p.name, p.constraint ?? T.ANY);

	for (const p of fn.params) {
		const anno = p.typeAnnotation;
		// Computed unconditionally (not just `!muted`) so it's available below for a defaulted,
		// unannotated param's own type too -- `typeOf`'s own diagnostics are already self-gated by
		// the ambient `muted` counter, so only the explicit assignability check+report needs the guard.
		// `anno` as the contextual type, which is what real TS does: a default is checked AGAINST the
		// parameter's declared type, and without it an unannotated arrow default (`compareFn: (a: T, b: T)
		// => number = (a, b) => ...`) typed its own params as `any`, so `Array.sort` could not be called
		// without an explicit comparator at all.
		// Checked precise; an unannotated parameter's own type is the widened one, as TS infers it.
		const precise	= p.default && typeOf(p.default, inner, false, anno, undefined, err);
		const dt		= precise && T.widenLiterals(precise);
		if (err && precise && anno && !checkAssignable(precise, anno, inner, (p as any).pos, inner, err))
			err(SEVERITY.ERROR, (p as any).pos)`Default value of type '${show().type(precise)}' is not assignable to parameter type '${show().type(anno)}'`;
		// Written back, as `applyContextualParams` writes a contextual one: the function's own type (`FixParams`) has no
		// scope to type a non-literal default in, so `(s, seen = new Set<string>()) => ...` lost `seen`'s type.
		if (!anno && dt)
			p.typeAnnotation = typeof p.key === 'string' ? T.widenNullish(dt, inner) : dt;
		if (typeof p.key === 'string') {
			inner.addValue(p.key, anno ? T.optional(anno, hasMod(p, 'optional') && !p.default) : dt ? T.widenNullish(dt, inner) : T.ANY);
		} else {
			// The whole argument, under a name no source can spell, is the pattern's source -- so a destructured
			// discriminated union correlates as a `const` one does, unless the body reassigns one of its names.
			const hidden = `#param${fn.params.indexOf(p)}`;
			inner.addValue(hidden, anno ?? dt ?? T.ANY);
			bindPattern(inner, p.key, anno ?? dt ?? T.ANY, { type: 'identifier', name: hidden } as Expr, !writesAny(body, new Set(T.bindingNames(p.key))));
		}
	}
	
	if (fn.rest) {
		if (typeof fn.rest.key === 'string')
			inner.addValue(fn.rest.key, fn.rest.typeAnnotation ?? T.ANY);
		else
			bindPattern(inner, fn.rest.key, fn.rest.typeAnnotation ?? T.ANY);
	}

	// TS 5.5+ "inferred type predicates": a function whose single return path is itself a type guard (`x => x != null`) gets an inferred `x is T`
	// return, by asking `narrow()` what it'd do with that expression. Only an expression body or single-`return` block is supported.
	function inferredPredicate(test: Expr|undefined, result: Type): Type {
		if (test && T.isBoolean(result) && typeof fn.params[0]?.key === 'string') {
			const key		= fn.params[0].key;
			const paramT	= fn.params[0].typeAnnotation ?? T.ANY;
			const inner		= new Scope(scope);
			inner.addValue(key, paramT);
			const narrowed	= narrow(test, inner, true).value(key);
			// TS infers `x is T` only when the function is false exactly when `x` is no `T`: the false branch must narrow the parameter
			// to its declared type less `T`, or a caller's else branch loses members it never ruled out (`t.type === 'ref' && ...`).
			const keys		= (t: Type) => new Set(T.unionMembers(t, inner).map(m => T.typeKey(m)));
			const falseT	= keys(narrow(test, inner, false).value(key) ?? paramT);
			const restT		= narrowed && keys(TS.UnionType(T.unionMembers(paramT, inner).filter(m => !T.isAssignable(m, narrowed, inner, inner, false, 10, true))));
			if (narrowed && narrowed !== paramT && restT && falseT.size === restT.size && [...restT].every(k => falseT.has(k)))
				return TS.Predicate(key, narrowed);
		}
		return result;
	}


	if (Array.isArray(body)) {
		if (expected) {
			checkBlock(body, inner, typeOf1(err), (s, scope, typeOf1, checkStmt1) => {
				stamp(s, scope);
				checkStmt(s, scope, typeOf1, checkStmt1, err);
				if (s.type === 'return' && s.argument) {
					const argument = s.argument;
					const t = typeOf(argument, scope, false, expected, undefined, err);
					if (err) {
						if (!checkAssignable(T.unwrapIfAsync(t, scope, async), expected, scope, (argument as any).pos, scope, err))
							err(SEVERITY.ERROR, (argument as any).pos)`Type '${show().type(t)}' is not assignable to declared return type '${show().type(expected)}'`;
						else
							checkExcessProps(argument, expected, (argument as any).pos, scope, err);
					}
				}
			});

		} else if (isPredicate) {
			checkBlock(body, inner, typeOf1(err), (s, scope, typeOf1, checkStmt1) => {
				stamp(s, scope);
				checkStmt(s, scope, typeOf1, checkStmt1, err);
			});
			

		} else {
			const	returns: {s: (Stmt & {type: 'return'}), type?: Type}[] = [];
			const	yields		= generator ? [] as Type[] : undefined;
			checkBlock(body, inner,
				(e: Expr, scope: Scope, expected?: Type, widen = true) => typeOf(e, scope, widen, expected, yields, err),
				(s, scope, typeOf1, checkStmt1) => {
					stamp(s, scope);
					checkStmt(s, scope, typeOf1, checkStmt1, err);
					if (s.type === 'return')
						returns.push({s, type: s.argument && widenForContext(typeOf(s.argument, scope, false, inferHint, undefined, err), inferHint, scope)});
				}
			);

			const retDef		= returns.map(r => r.type).filter(r => !!r);

			if (retDef.length && (retDef.length < returns.length || !endsFunction(body[body.length - 1]))) {
				retDef.push(T.UNDEFINED);
				/*returns.forEach(r => {
					if (!r.s.argument)
						r.s.argument = Identifier('undefined');
				});
				if (!alwaysReturns(last))
					body.push({type: 'return', argument: Identifier('undefined')});
*/
			}
			const returnType = retDef.length ? T.widenNullish(T.combineTypes(retDef), inner) : alwaysThrows(body[body.length - 1]) ? T.NEVER : T.VOID;

			if (!declaredReturn) {
				fn.returnType = generator
					? TS.RefType(async ? 'AsyncGenerator' : 'Generator', [yields!.length ? T.combineTypes(yields!) : T.NEVER, returnType, T.ANY])
					: T.wrapReturnIfAsync(inferredPredicate(body.length === 1 && body[0].type === 'return' ? body[0].argument : undefined, returnType), inner, async);
			}
		}
	} else {
		// Precise (unwidened): `expected` may itself be a narrow/literal declared return type (rare, but real), so the
		// assignability check below must see `body`'s exact inferred type, not a pre-widened one -- only the *inference*
		// branch (no declared type to check against) widens, and only there.
		// Stamped like a block body's statements, so towasm's closure sees what this saw (a capture narrowed outside it).
		if (!noStamp && !narrowing)
			(body as any).scope ??= inner;
		const t = typeOf(body, inner, false, expected ?? inferHint, undefined, err);
		if (expected) {
			if (err && !checkAssignable(T.unwrapIfAsync(t, inner, async), expected, inner, (body as any).pos, inner, err))
				err(SEVERITY.ERROR, (body as any).pos)`Type '${show().type(t)}' is not assignable to declared return type '${show().type(expected)}'`;
		} else if (!isPredicate && !declaredReturn) {
			fn.returnType = T.wrapReturnIfAsync(inferredPredicate(body, T.widenNullish(widenForContext(t, inferHint, inner), inner)), inner, async);
		}
	}
}
function checkClass(c: TS.Class, scope: Scope, err?: Err) {
	const { instance, value, superType } = classShapes(c, scope);
	const { inst: instScope, stat: statScope } = classBodyScopes(c, scope, instance, value, superType);

	for (const m of c.body) {
		switch (m.type) {
			case 'field':
				if (m.value) {
					const inner = hasMod(m, 'static') ? statScope : instScope;
					const t		= typeOf(m.value, inner, false, m.typeAnnotation, undefined, err);
					if (m.typeAnnotation && err) {
						if (!checkAssignable(t, m.typeAnnotation, inner, (m as any).pos, inner, err))
							err(SEVERITY.ERROR, (m as any).pos)`Type '${show().type(t)}' is not assignable to type '${show().type(m.typeAnnotation)}'`;
						else
							checkExcessProps(m.value, m.typeAnnotation, (m as any).pos, inner, err);
					}
				}
				break;
			case 'method':
				checkFunctionBody(m, m.body, hasMod(m, 'static') ? statScope : instScope, hasMod(m, 'async'), m.key === 'constructor' || hasMod(m, 'generator'), hasMod(m, 'generator'), err);
				break;
			case 'get':
				checkFunctionBody(m, m.body, hasMod(m, 'static') ? statScope : instScope, false, false, false, err);
				break;
			case 'set':
				checkFunctionBody(m, m.body, hasMod(m, 'static') ? statScope : instScope, false, true, false, err);
				break;
			case 'static_block':
				checkBlock(m.body, new Scope(statScope), typeOf1(err), checkStmt1(err));
		}
	}
	return value;
	//return instScope;
}

// Every leaf of an if/else chain (or a block's final statement) assigns the same variable:
// yields the assigned expressions (each tagged with the scope its own branch narrowed down to,
// so a right-hand side that reads back the narrowed test subject -- `arg = new Stream(arg)` --
// gets re-evaluated with that branch's narrowing in effect, not the pre-`if` scope) so the
// post-if type can merge the branches.
function assignRights(st: Stmt, scope: Scope, name?: string): { name: string; rights: { expr: Expr; scope: Scope }[] } | undefined {
	if (st.type === 'expression') {
		// The assignment may sit anywhere in the expression (towasm.ts `bindingIn`'s `c.names.set(name, b = {...})`), which TS's own
		// flow analysis narrows at just the same. Never inside a closure there: that runs later, if at all.
		let found: { name: string; value: Expr } | undefined;
		walkerB(undefined, (e, process) => {
			if (e.type === 'arrow' || e.type === 'function')
				return false;
			if (e.type === 'assign' && !e.operator && e.target.type === 'identifier' && (!name || e.target.name === name))
				found = { name: e.target.name, value: e.value };
			return process(e);
		}).body(st.expression);
		if (found)
			return { name: found.name, rights: [{ expr: found.value, scope }] };
	}

	if (st.type === 'block' && st.body.length) {
		// Not just the last statement: `if (!x) { x = e; bookkeeping(); }` assigns `x` before unrelated further work --
		// scan backward for the last statement that actually assigns `name`, skipping over anything else.
		for (let i = st.body.length - 1; i >= 0; i--) {
			const a = assignRights(st.body[i], scope, name);
			if (a)
				return a;
		}
		return undefined;
	}

	if (st.type === 'if' && st.alternate) {
		// A branch that always exits (throw/return/break) never reaches what follows, so it contributes nothing to the merge.
		const aExits = alwaysExits(st.consequent), bExits = alwaysExits(st.alternate);
		if (aExits || bExits)
			return aExits && bExits ? undefined : aExits ? assignRights(st.alternate, narrow(st.test, scope, false), name) : assignRights(st.consequent, narrow(st.test, scope, true), name);
		const a = assignRights(st.consequent, narrow(st.test, scope, true), name);
		const b = a && assignRights(st.alternate, narrow(st.test, scope, false), a.name);
		return b && { name: a.name, rights: [...a.rights, ...b.rights] };
	}
	return undefined;
}

// `check`: the walk to use, defaulting to the plain scope-stamping one. The only caller that wants
// anything else is `checkFunctionBody`, which composes a return hook and (for the muted first walk of a
// generic method-body template) drops the stamp -- see `stampScopes`/`afterReturn`.
// The ordinary walk: stamp the scope, then check. A caller wanting anything else (a return hook, or no
// stamping) writes its own and calls `checkStmt` from it -- and since `err` is in scope there, the
// wrapper re-supplies it on every entry, which is why `err` need not be part of `checkStmt`'s own type.
export const checkStmt1 = (err?: Err): checkStmt => (s, scope, typeOf, self) => {
	(s as any).scope ??= stampedScope(s, scope);
	checkStmt(s, scope, typeOf, self, err);
};

// A muted, stamping check of statements already HOISTED into `scope` -- an imported module, which `exportScope` only hoists.
export function checkHoisted(stmts: Stmt[], scope: Scope) {
	const check = checkStmt1();
	for (const s of stmts)
		check(s, scope, typeOf1(), check);
}

export function checkBlock(stmts: Stmt[], scope: Scope, typeOf = typeOf1(), checkStmt: checkStmt = checkStmt1()) {
	hoist(stmts, scope);

	for (const s of stmts) {
		checkStmt(s, scope, typeOf, checkStmt);

		switch (s.type) {
			case 'if':
				if (!s.alternate && alwaysExits(s.consequent)) {
					// guard clause (`if (!ok) return;`): the rest of the block sees the negated narrowing
					scope = narrow(s.test, scope, false);
				} else {
					// `if (x === undefined) x = e;` and full if/else chains assigning x:
					// afterwards x holds one branch's value or another's
					const a = s.alternate ? assignRights(s, scope) : assignRights(s.consequent, narrow(s.test, scope, true));
					if (a) {
						const parts = a.rights.map(({ expr, scope: rightScope }) => typeOf(expr, rightScope));
						if (!s.alternate) {
							const other = narrow(s.test, scope, false).value(a.name);
							if (other)
								parts.push(other);
						}
						scope = new Scope(scope);
						scope.addNarrowing(a.name, T.combineTypes(parts));
					}
				}
				break;
			case 'switch': {
				// An exhaustive switch whose every clause exits: the rest of the block runs only when no case matched.
				const none = !s.cases.some(c => !c.test) && clausesNeverFallOut(s) ? noCaseMatched(s) : undefined;
				if (none)
					scope = narrow(none, scope, true);
				break;
			}
		}
	}
}

type checkStmt = (s: Stmt, scope: Scope, typeOf: typeOf, checkStmt: checkStmt)=>void;

export function checkStmt(stmt: Stmt, scope: Scope, typeOf: typeOf, checkStmt: checkStmt, err?: Err): void {

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
				// Like a signature's: a module-private type named by a local (`let c: CacheFile`) must resolve where it was written.
				if (d.typeAnnotation)
					T.stampScope(d.typeAnnotation, scope);
				// A block-scoped name is bound for its whole block, so a closure in its own initializer (`const f = (n): R => f(n - 1)`)
				// reaches it, not a same-named outer binding: as its annotation, else a function expression's written signature, else
				// `any`, as TS types a name read inside its own unannotated initializer. `hoistVar` then binds the real type.
				if (typeof d.name === 'string' && d.init && !stmt.ambient)
					scope.addValue(d.name, d.typeAnnotation ? T.resolve(scope, d.typeAnnotation)
						: d.init.type === 'function' || d.init.type === 'arrow' ? { type: 'function', ...T.FixSig(d.init, T.ANY) } : T.ANY);
				if (err && d.typeAnnotation && d.init) {
					const anno = d.typeAnnotation;
					// Widened until `let` assignment narrowing exists (inventory C1): a precise `let` union read later is only its declared type.
					const init = typeOf(d.init, scope, anno);
					if (!init)
						checkExcessProps(d.init, anno, pos, scope, err);
					else if (!checkAssignable(init, anno, scope, pos, scope, err))
						err(SEVERITY.ERROR, pos)`Type '${show().type(init)}' is not assignable to type '${show().type(anno)}' in declaration of '${show().bindingTarget(d.name)}'`;
				}
				if (!stmt.ambient)
					hoistVar(scope, d, stmt.kind !== 'const', undefined, err);
			}
			break;
		}
		case 'expression':
			typeOf(stmt.expression, scope);
			break;

		case 'block':
			checkBlock(stmt.body, new Scope(scope), typeOf, checkStmt);
			break;

		case 'if':
			typeOf(stmt.test, scope);
			checkStmt(stmt.consequent, new Scope(narrow(stmt.test, scope, true)), typeOf, checkStmt);
			if (stmt.alternate)
				checkStmt(stmt.alternate, new Scope(narrow(stmt.test, scope, false)), typeOf, checkStmt);
			break;

		case 'while':
		case 'do_while':
			typeOf(stmt.test, scope);
			checkStmt(stmt.body, new Scope(stmt.type === 'while' ? narrow(stmt.test, scope, true) : scope), typeOf, checkStmt);
			break;

		case 'for': {
			const inner = new Scope(scope);
			if (stmt.kind === 'normal') {
				if (stmt.init) {
					if (stmt.init.type === 'var_decl')
						checkStmt(stmt.init, inner, typeOf, checkStmt);
					else
						typeOf(stmt.init, inner);
				}
				if (stmt.test)
					typeOf(stmt.test, inner);
				if (stmt.update)
					typeOf(stmt.update, inner);
				checkStmt(stmt.body, stmt.test ? narrow(stmt.test, inner, true) : inner, typeOf, checkStmt);

			} else {
				const elemT = stmt.kind === 'in' ? (typeOf(stmt.right, inner), T.STRING) : iterationOrReport(typeOf(stmt.right, inner), inner, getPos(stmt.right)!, err, stmt.kind === 'of await').yield;
				if (stmt.init.type === 'var_decl') {
					for (const d of stmt.init.declarations)
						hoistVar(inner, d, true, d.typeAnnotation ?? elemT, err);
				} else {
					typeOf(stmt.init, inner);
				}
				checkStmt(stmt.body, inner, typeOf, checkStmt);
			}
			break;
		}
		case 'switch': {
			typeOf(stmt.discriminant, scope);
			// A `case` with no body falls through to the next -- reuse `if`'s discriminated-union narrowing by synthesizing that binary
			// test per case, OR-ing fallthrough cases together. `default` runs when NO case matched: the negation of every test, ANDed.
			const caseTest	= (test: Expr): Expr => ({ type: 'binary', operator: '===', left: stmt.discriminant, right: test });
			const none		= noCaseMatched(stmt);
			const earlier: Expr[] = [];		// every earlier clause's test, negated
			let pending: Expr[] = [];
			for (const c of stmt.cases) {
				if (c.test) {
					typeOf(c.test, scope);
					// A clause is entered when its value matches and no EARLIER clause's did: a repeated `case 'number':` is unreachable.
					pending.push(earlier.reduce<Expr>((acc, t) => ({ type: 'binary', operator: '&&', left: acc, right: t }), caseTest(c.test)));
					earlier.push({ type: 'unary', operator: '!', operand: caseTest(c.test) });
				} else if (none) {
					pending.push(none);
				}
				if (c.consequent.length) {
					const test = pending.reduce<Expr | undefined>((acc, t) => acc ? { type: 'binary', operator: '||', left: acc, right: t } : t, undefined);
					checkBlock(c.consequent, new Scope(test ? narrow(test, scope, true) : scope), typeOf, checkStmt);
					pending = [];
				}
			}
			break;
		}
		case 'throw':
		case 'with':
			typeOf(stmt.argument, scope);
			if (stmt.type === 'with')
				checkStmt(stmt.body, scope, typeOf, checkStmt);
			break;

		case 'try':
			checkBlock(stmt.body, new Scope(scope), typeOf, checkStmt);
			for (const h of stmt.handlers) {
				const inner = new Scope(scope);
				if (h.param) {
					if (typeof h.param === 'string')
						inner.addValue(h.param, T.ANY);
					else
						T.bindingNames(h.param).forEach(n => inner.addValue(n, T.ANY));
				}
				checkBlock(h.body, inner, typeOf, checkStmt);
			}
			if (stmt.finalizer)
				checkBlock(stmt.finalizer, new Scope(scope), typeOf, checkStmt);
			break;

		case 'labeled':
			checkStmt(stmt.body, scope, typeOf, checkStmt);
			break;

		case 'function_decl':
			if (stmt.body)
				checkFunctionBody(stmt, stmt.body, ownThis(flowContainer(scope)), hasMod(stmt, 'async'), hasMod(stmt, 'generator'), hasMod(stmt, 'generator'), err);
			break;

		case 'class_decl':
			checkClass(stmt, scope, err);
			break;

		case 'export_decl':
			checkStmt(stmt.declaration, scope, typeOf, checkStmt);
			break;

		case 'export':
			if (stmt.default) {
				if (isTsDeclaration(stmt.default))
					checkStmt(stmt.default, scope, typeOf, checkStmt);
				else
					typeOf(stmt.default, scope);
			}
			break;

		case 'namespace_decl':
			checkBlock(stmt.body, new Scope(scope), typeOf, checkStmt);
			break;

		// type_alias_decl / interface_decl / enum_decl / import / export /
		// empty / debugger / continue / break: declaration-only or nothing to check (hoist saw them)
	}
}

export function inferReturn(fnj: JS.CallSig<any>, body: JS.Stmt<any>[], outer: Scope): Type {
	if (fnj.returnType)
		return fnj.returnType;
	const sig = { ...fnj } as TS.CallSig;
	checkFunctionBody(sig, body, outer, false);
	return sig.returnType ?? T.VOID;
}

// Builds the `Scope` holding every lib declaration `TStoWasm` needs (`String`, `RegExpMatch`, ...). Callers
// pass the *same* returned `Scope` to both `TStypeCheck`/`TStypeCheckAsync` (as `libScope`, so user code is
// checked with lib members already in view -- a scope only sees its own ancestors, so a user program's
// `global` needs the lib scope as an actual ancestor, not a sibling branch) and `TStoWasm` (which needs it
// directly too, e.g. to compile a lib method's own body in isolation from user-declared names). `libAst` is
// the language's own flat lib declaration list (`towasm.ts`'s `LIB_AST`), passed in because this is the
// checker's setup step, not codegen's.
//
// Muted, deliberately (its diag sink is a no-op either way) -- but it no longer skips walking a declared-
// return-type lib method's body outright the way it once did. That used to be an all-or-nothing choice:
// walking+stamping fixed narrowing-dependent bodies (`String.split`'s `m.groupStart(0)`) but broke every
// GENERIC lib class method (`Array<T>.reverse`/`.fill`/...), since the stamp left behind was the template's
// own, with `T` still unresolved, and `??=` first-wins then blocked the real, per-instantiation substituted
// scope from ever overriding it. Resolved at the source instead (`Scope.isGenericTemplate`, this file):
// a generic class's own instance scope is flagged, and `checkFunctionBody`/`checkStmt` skip *just* their
// `fn.scope`/`(stmt as any).scope` stamps under that flag while still performing the walk -- so
// `applyContextualParams`'s param-typing side effect (needed for e.g. `lib/map.ts`'s `entries()`, whose
// `.map()` callback params previously never got typed at all) now runs for every lib method, generic or
// not, while a generic method's body still falls back to `ctx.scope` at codegen time, same as before.
export function makeLibScope(libAst: Stmt[]): Scope {
	const libScope = new Scope;
	// `undefined` is a language built-in, not a lib declaration -- real tsc REFUSES to let a `.d.ts`
	// declare it ("conflicts with built-in global identifier"), so `lib.d.ts` can't carry it beside
	// `NaN`/`Infinity`. `T.makeGlobal` binds it for the checker-only path; this is the wasm path's
	// equivalent. Without it the identifier typed as `any`, so `cond ? x : undefined` came out
	// `number | any` -- no `undefined` left in the union for anything downstream to be nullable by.
	libScope.addValue('undefined', T.UNDEFINED);
	checkBlock(libAst, libScope);
	return libScope;
}
