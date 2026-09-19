import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Literal, hasMod } from '../common';
import { Expr } from './js-parser';
import { Type } from './ts-parser';
import {
	ANY, BIGINT, BOOLEAN, INTRINSIC_TYPES, NEVER, NUMBER, REGEXP, SIMPLE_TYPES, STRING, Scope, Semantics, UNDEFINED, UNKNOWN, WASM_PSEUDO_TYPES,
	arrayLikeElement, awaitType, combineTypes, elementTypes, findFunctionType, freshTypeParamName, objectMember, isAny, isBoolean, isLiteral, isNullish,
	isRef, isString, lookupMember, ownScope, paramTypeAt, rangeIncludesZero, resolve, resolveMembers, resolveOwn, substituteThisType,
	typeArgMap, unionMembers, widenLiterals,
} from './type-core';

// TypeScript's view of the shared type model: `type-core` plus the rules JavaScript's runtime adds to it -- truthiness,
// `typeof`, literal typing, the iteration protocol, and the members every value gets without declaring them.
export * from './type-core';

// ===================================================================
//  JavaScript primitives and literals
// ===================================================================

// A Map, not an object: it is indexed by names from source, and `constructor`/`toString` must not find `Object.prototype`'s.
const BOXED_PRIMITIVE = new Map([['string', 'String'], ['number', 'Number'], ['boolean', 'Boolean'], ['bigint', 'BigInt'], ['symbol', 'Symbol']]);

export function isNullLiteral(e: Expr): boolean {
	return nullLiteralKind(e) !== undefined;
}

// Which of the two nullish literals `e` is, if either. They share one physical form here (`ref.null`),
// so only a STRICT comparison ever has to tell them apart, and only statically -- see `case '==='`.
export function nullLiteralKind(e: Expr): 'null' | 'undefined' | undefined {
	return	e.type === 'literal' && e.value === null			? 'null'
		:	e.type === 'identifier' && e.name === 'undefined'	? 'undefined'
		:	undefined;
}

export function literalTypeOf(e: Expr | undefined): Type | undefined {
	if (e?.type === 'literal') {;
		switch (typeof e.value) {
			case 'string':	return STRING;
			case 'boolean':	return BOOLEAN;
			case 'number':	
				return	e.value !== (e.value | 0)						? NUMBER
					:	e.value >= -0x80000000 && e.value <= 0x7fffffff ? TS.RefType('i32')
					:	e.value >= 0 && e.value <= 0xffffffff			? TS.RefType('u32')
					:	NUMBER;
			case 'bigint':
				return	e.value >= -0x8000000000000000n && e.value <= 0x7fffffffffffffffn	? TS.RefType('i64')
					:	e.value >= 0n && e.value <= 0xffffffffffffffffn						? TS.RefType('u64')
					:	BIGINT;
			case 'object':	return e.value === null ? Literal(e.value) : Array.isArray(e.value) ? STRING : REGEXP;
		}
	}
//	return e?.type === 'literal' ? TS.RefType(literalType(e)) : undefined;
}

// ===================================================================
//  Members JavaScript adds: TS_SEMANTICS, and the global scope
// ===================================================================

// Just enough built-in array members that element types survive `pop()!` etc.
function arrayMethod(elem: Type, prop: string): Type | undefined {
	// `map`'s result depends on the callback's own return type, not a fixed formula of `elem` -- needs a real generic signature, or it silently
	// falls back to `ANY`, which can then poison a *constrained* generic elsewhere with a confusing error nowhere near the real cause.
	// The type param's own name is freshly generated per call (not the literal `'U'`) -- `elem` may itself already mention an ambient `U`
	// (e.g. calling `.map()` on `U[][]` inside a method whose own type parameter happens to be named `U` too), and a hand-built signature
	// like this one is constructed directly rather than through `substituteType`, so `avoidCapture`'s own collision handling never sees it;
	// a hardcoded name here would let that unrelated ambient `U` silently capture this signature's own, genuinely different `U`, corrupting
	// per-call generic inference (`inferTypeArgs`'s purely name-based matching can't tell them apart once both are spelled the same).
	if (prop === 'map') {
		const U = TS.RefType(freshTypeParamName('U'));
		return TS.FunctionType([
				JS.Param('callback', TS.FunctionType([
					JS.Param('v', elem),
					JS.Param('i', NUMBER),
					JS.Param('arr', TS.ArrayType(elem))
				], U)),
				JS.Param('thisArg', ANY, ['optional']),
			],
			TS.ArrayType(U),
			[{ name: U.name }]
		);
	}

	// Real `.flat()` is a recursive conditional type keyed off an explicit depth argument; only the common argument-less (depth-1) case is
	// modeled -- unwrap one level of nesting when `elem` is itself an array. An unmodeled explicit depth falls back to the methods below.
	if (prop === 'flat' && elem.type === 'array')
		return { type: 'function', params: [], rest: { key: 'args', typeAnnotation: { type: 'array', element: NUMBER } }, returnType: { type: 'array', element: elem.element } };

	// TS's own three overloads, exactly: no seed (the accumulator is the element type), a seed of the element type, a seed of U.
	// Freshly-named per call, same reasoning as `map`'s own `U` above.
	if (prop === 'reduce' || prop === 'reduceRight') {
		const U		= TS.RefType(freshTypeParamName('U'));
		const cb	= (acc: Type) => JS.Param('callback', TS.FunctionType([JS.Param('acc', acc), JS.Param('v', elem), JS.Param('i', NUMBER), JS.Param('arr', TS.ArrayType(elem))], acc));
		return TS.ObjectType([
			TS.TypeCall(TS.CallSig({ params: [cb(elem)] }, elem)),
			TS.TypeCall(TS.CallSig({ params: [cb(elem), JS.Param('initialValue', elem)] }, elem)),
			TS.TypeCall(TS.CallSig({ params: [cb(U), JS.Param('initialValue', U)] }, U, [{ name: U.name }])),
		]);
	}

	// Collapsed into one rest-based signature: this checker's overload picker always fails whenever any argument is a spread
	// (`arr.splice(i, n, ...items)`), so a real 2-overload `splice` would otherwise never match a spread call at all.
	if (prop === 'splice')
		return TS.FunctionType(
			{ params: [JS.Param('start', NUMBER), JS.Param('deleteCount', NUMBER, ['optional'])], rest: JS.Rest('items', TS.ArrayType(elem)) },
			TS.ArrayType(elem)
		);

	// Freshly-named per call, same reasoning as `map`'s own `U` above.
	if (prop === 'every' || prop === 'filter' || prop === 'find' || prop === 'findLast') {
		const S = TS.RefType(freshTypeParamName('S'));
		return TS.FunctionType(
			[
				JS.Param('predicate', TS.FunctionType(
					[JS.Param('v', elem), JS.Param('i', NUMBER), JS.Param('arr', TS.ArrayType(elem))],
					TS.Predicate('v', S)
				)),
				JS.Param('thisArg', ANY, ['optional']),
			],
			prop === 'every' ? TS.Predicate('this', TS.ArrayType(S)) : prop === 'filter' ? TS.ArrayType(S) : combineTypes([S, UNDEFINED]),
			[{ name: S.name, constraint: elem, default: elem }],
		);
	}
	return undefined;
}

// Everything else `interface Array<T>` declares for real; only the RETURN type is refined here, over that
// declaration's own parameters. This used to synthesise a whole `(...args: any[]) => ret` signature, which
// threw away every parameter type -- so an unannotated callback (`a.some(x => x > 0)`, `a.findIndex(...)`)
// got no contextual typing at all and only died much later, in codegen, as "closure parameter needs an
// explicit type".
function arrayMethodReturn(elem: Type, prop: string): Type | undefined {
	return	prop === 'pop' || prop === 'shift' ? combineTypes([elem, UNDEFINED])
			// Bounded (not bare `number`) so a loop comparing against these stays in `i32` instead of
			// promoting to `f64` -- see `backend.ts`'s `numericPairWtype`, which requires both operands
			// already `i32`. `0x7fffffff`, not `0xffffffff`, so `intWasmType` picks `i32` not `u32`.
			:	prop === 'push' || prop === 'unshift' ? TS.RangeType('number', 0, 0x7fffffff, true)
			:	prop === 'indexOf' || prop === 'lastIndexOf' || prop === 'findIndex' ? TS.RangeType('number', -1, 0x7fffffff, true)
			:	prop === 'includes' || prop === 'some' ? BOOLEAN
			:	prop === 'join' ? STRING
			:	prop === 'slice' || prop === 'concat' || prop === 'reverse' || prop === 'flat' ? { type: 'array', element: elem } as Type
			:	undefined;
}

// Applies `arrayMethodReturn`'s refinement to whatever shape the declaration came back as -- a lone
// `function`, or the multi-signature `object` an overload set groups into.
function withReturnType(t: Type | undefined, ret: Type): Type | undefined {
	if (t?.type === 'function')
		return { ...t, returnType: ret };
	if (t?.type === 'object' && t.members.every(m => m.type === 'call'))
		return TS.ObjectType(t.members.map(m => ({ ...m, returnType: ret })));
	return undefined;
}

// The members of an array, tuple or string this checker models more precisely than `interface Array<T>`/`String` declare.
// `length` is bounded (see `arrayMethodReturn`) on a tuple or string only: a real array's is writable (`a.length = 0`), so
// it must stay assignable from a general `number` -- narrowing it too regressed 7 corpus files.
function refinedMember(t: Type, prop: string, scope: Scope, depth: number): Type | undefined {
	if (prop === 'length')
		return t.type === 'tuple' || isString(t) ? TS.RangeType('number', 0, 0x7fffffff, true) : t.type === 'array' ? NUMBER : undefined;
	if (t.type !== 'array' && t.type !== 'tuple')
		return undefined;
	const elem	= t.type === 'array' ? t.element : combineTypes(elementTypes(t, scope));
	const ret	= arrayMethodReturn(elem, prop);
	// The synthetic fallback survives only for a member `lib.d.ts` doesn't declare at all -- every such name is a gap in `interface Array<T>`.
	return arrayMethod(elem, prop) ?? (ret && (withReturnType(lookupMember(TS.RefType('Array', [elem]), prop, scope, depth - 1), ret)
		?? TS.FunctionType({ params: [], rest: JS.Rest('args', TS.ArrayType(ANY)) }, ret)));
}

export const TS_SEMANTICS: Semantics = {
	boxed:			name => BOXED_PRIMITIVE.get(name),
	apparentMember:	objectMember,
	refinedMember,
};

export function makeGlobal() {
	const global = new Scope(TS_SEMANTICS);
	for (const [r, n] of BOXED_PRIMITIVE)
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

// ===================================================================
//  Signatures of JavaScript functions
// ===================================================================

// An un-annotated parameter's type, inferred from its default. Widened, matching both real TS
// (`function f(scale = 10)` declares `scale: number`, not `10`) and towasm's own declaration-side
// `resolveParam`, which infers the same parameter through `checkerTypeOf` -- the two have to agree, or
// a function TYPE built from a declaration lowers to a different physical signature than the
// declaration itself does.
function widenedDefaultType(d: JS.Expr<any> | undefined): Type | undefined {
	const t = d && literalTypeOf(d);
	if (!t)
		return undefined;
	// `literalTypeOf` types an integer literal as the wasm pseudo-type `i32` (`declare type i32 = number`),
	// a storage refinement `widenLiterals` has no reason to touch. In a signature the declared type is
	// plainly `number`, which is also what the declaration side infers -- same collapse `combineTypes`
	// already does when deduplicating union members.
	const w = widenLiterals(t);
	return w.type === 'ref' && !w.typeArgs && WASM_PSEUDO_TYPES.has(w.name) ? NUMBER : w;
}

// TS's getTypeFromBindingPattern: what a destructuring pattern implies about what it destructures. It is the parameter's own type
// where the pattern has a DEFAULT anywhere (`[x = 0, y = 0] = []` is `[(number | undefined)?, ...]`, never the initializer's
// `never[]`); with no default at all the initializer says more (`{a, b} = {a: 1, b: 'x'}` is its own type).
function patternDefaults(target: JS.BindingTarget): boolean {
	return typeof target !== 'string' && (target.type === 'array_pattern'
		? target.elements.some(el => !!el && (!!el.default || patternDefaults(el.target)))
		: target.properties.some(p => !!p.default || patternDefaults(p.value)));
}

// A default makes its slot optional and its type nullable, as TS writes it; a nested pattern says what it implies.
function patternType(target: JS.BindingTarget): Type {
	const implied = (t: JS.BindingTarget, def?: JS.Expr<any>): Type => {
		const base = typeof t !== 'string' ? patternType(t) : widenedDefaultType(def) ?? ANY;
		return def ? combineTypes([base, UNDEFINED]) : base;
	};
	if (typeof target === 'string')
		return ANY;
	return target.type === 'array_pattern'
		? { type: 'tuple', elements: target.elements.map(el => el?.default ? { type: 'optional', element: implied(el.target, el.default) } : el ? implied(el.target) : ANY) }
		: TS.ObjectType(target.properties.flatMap(p => typeof p.key === 'string' ? [TS.TypeProperty(p.key, implied(p.value, p.default), p.default ? ['optional'] : undefined)] : []));
}

// JS.ParamList to TS.ParamList; a defaulted parameter counts as optional
export function FixParams(params: JS.Params<any>): TS.Params {
	return {
		params: params.params.filter(p => p.key !== 'this').map((p): TS.Param => ({
			key:			typeof p.key === 'string' ? p.key : '_',
			modifiers:		hasMod(p, 'optional') || !!p.default ? ['optional'] : [],
			typeAnnotation: p.typeAnnotation as Type ?? (typeof p.key !== 'string' && patternDefaults(p.key) ? patternType(p.key) : widenedDefaultType(p.default)),
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

// ===================================================================
//  typeof and truthiness
// ===================================================================

// What `typeof` would report for a value of this type, or undefined when it can't be known statically --
// which is also the only way to answer `'object'`/`'function'`, neither of which has a single physical
// form for codegen to test for at runtime.
// `scope`: resolve first, and resolve each union member. Omit it to answer from the type exactly as
// given, which is what the checker's own narrowing wants (it applies this per already-split member).
// A constructor parameter with an accessibility or `readonly` modifier also declares the property of that name.
export const isParamProperty = <P extends { modifiers?: string[] }>(p: P): p is P & { modifiers: string[] } => !!p.modifiers?.some(m => m !== 'optional');

export function typeofName(t: Type, scope?: Scope): string | undefined {
	const r = scope ? resolve(scope, t) : t;
	switch (r.type) {
		case 'literal':				return Array.isArray(r.value) ? 'string' : typeof r.value;
		case 'range':				return r.base;
		case 'function':
		case 'constructor':			return 'function';
		case 'array':
		case 'tuple':
		case 'object':				return 'object';
		case 'intersection': {
			// A part that makes the value a PRIMITIVE wins over the object-ish ones -- a branded
			// `string & {brand}` is a string, and `typeof` reports it as one.
			const parts = r.types.map(p => typeofName(p, scope));
			return parts.find(n => n && SIMPLE_TYPES.has(n))
				?? (parts.includes('function') ? 'function' : 'object');
		}
		case 'union': {
			// Every inhabitant must agree. `unionMembers` resolves and flattens, and drops `never` -- see
			// its own comment. Only with a `scope`; without one this stays a shallow, as-given answer.
			const members	= scope ? unionMembers(r, scope) : r.types.filter(m => !isRef(m, 'never'));
			const names		= new Set(members.map(m => typeofName(m, scope)));
			return names.size === 1 && !names.has(undefined) ? [...names][0] : undefined;
		}
		case 'ref': {
			if (SIMPLE_TYPES.has(r.name))
				return r.name;
			if (r.name === 'void' || r.name === 'null')
				return r.name === 'void' ? 'undefined' : 'object';
			// Whatever `resolve` left as a ref names a real class -- `typeof` is a question about the
			// STRUCTURE, so ask for it. Guarded on actually getting one back, or a ref with no entry to
			// expand would recurse on itself.
			const m = scope && resolveMembers(r, scope);
			return m && m.type !== 'ref' ? typeofName(m, scope) : undefined;
		}
		default:					return undefined;
	}
}

export function isFalsy(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return	r.type === 'literal'	? !r.value
		:	r.type === 'ref'		? r.name === 'undefined' || r.name === 'null' || r.name === 'void'
		:	r.type === 'range'		? r.min !== undefined && r.min === r.max && rangeIncludesZero(r)	// the single point 0
		:	r.type === 'union'		? r.types.every(t => isFalsy(t, scope))
		:	false;
}

export function isTruthy(t: Type, scope: Scope): boolean {
	const r = resolveOwn(t, scope);
	return	r.type === 'literal'		? !!r.value
		:	r.type === 'range'			? !rangeIncludesZero(r)
		:	r.type === 'union'			? r.types.every(m => isTruthy(m, scope))
		:	r.type === 'intersection'	? r.types.some(m => isTruthy(m, scope))
		:	r.type === 'ref'			? isObjectRef(r, scope)
		:	['object', 'array', 'tuple', 'function', 'constructor'].includes(r.type);
}

// True when a value of this type is truthy whenever it is non-null -- an object, an array, a tuple, a
// function. Never a `string` (`''` is falsy), a `number` (`0`, `NaN`), a `boolean`, a literal, or a
// genuinely dynamic `any`/type parameter, for all of which truthiness is a property of the VALUE.
// Answered from the CHECKER's type, which is the only thing that still knows a boxed `any` slot holds
// `Stmt | undefined` rather than something that could be `0`.
export function alwaysTruthy(t: Type, scope: Scope): boolean {
	const r = resolve(scope, t);
	switch (r.type) {
		case 'object': case 'array': case 'tuple':	case 'function': case 'constructor':
			return true;
		case 'union':
			// An all-nullish union lands here as `true`, which is still correct: the null test below
			// answers `false` for it, which is what it always is. `T.unionMembers` drops `never` and
			// flattens nested aliases -- see its own comment.
			return unionMembers(r, scope).every(m => isNullish(m, scope) || alwaysTruthy(m, scope));
		case 'intersection':
			// A value satisfying an intersection satisfies every part, so one object-ish part is enough
			// to make it an object -- unless another part makes it a PRIMITIVE (a branded
			// `string & {brand}`), where truthiness is still the primitive's own. An interface that
			// `extends` another resolves to exactly this (`FunctionType` = `{type:'function'} & CallSig`).
			return r.types.some(m => alwaysTruthy(m, scope))
				&& !r.types.some(m => ['ref', 'literal'].includes(resolve(scope, m).type));
		case 'ref':
			// `never` is uninhabited, so no value can BE the falsy one -- vacuously true, and a union
			// member `JS.Stmt<any>` really has (a generic parameter substituted away). Every other `ref`
			// surviving `resolve` is a primitive or an unresolved name, neither decidable here.
			return r.name === 'never';
		default:
			// A literal, `keyof`, a conditional, a type parameter: not decidable here either.
			return false;
	}
}

// A class or interface instance is an object, never falsy -- TS's object type facts. Not an empty shape (`{}`, `Object`),
// which a primitive satisfies, nor anything unresolved.
function isObjectRef(r: TS.RefType, scope: Scope): boolean {
	if (INTRINSIC_TYPES.has(r.name))
		return false;
	const m = resolveMembers(r, scope);
	return m.type === 'object' ? m.members.length > 0 : m.type === 'intersection' && m.types.some(p => p.type === 'object' && p.members.length > 0);
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
	if (type.type === 'range') {
		// A range provably excluding 0 can never take its "one falsy value" -- that branch is unreachable for it.
		if (!rangeIncludesZero(type))
			return NEVER;
		return type.base === 'number' ? Literal(0) : TS.RangeType('bigint', 0n, 0n);
	}
	return type;
}

export function isOther(op: string) {
	return op === '?' ? isNullish : op === '|' ? isFalsy : isTruthy;
}

// What `a && b` / `a || b` / `a ?? b` yields from `a` when it short-circuits: a boolean survives `||` only as true and
// `&&` only as false, and `&&` narrows a string/number to its one falsy literal (`||`'s truthy side has no single value).
export function logicalLeftPart(t: Type, op: string, scope: Scope): Type {
	const other	= isOther(op[0]);
	// A member union nothing is dropped from stays as written: `p.constraint ?? x` is `Type`, not `Type`'s members.
	const part	= (m: Type): Type[] => {
		const p = resolveOwn(m, scope);
		if (p.type === 'union') {
			const kept = p.types.flatMap(part);
			return kept.length === p.types.length && kept.every((k, i) => k === p.types[i]) ? [m] : kept;
		}
		if (other(p, scope))
			return [];
		if (op !== '??' && isBoolean(p))
			return [Literal(op === '||')];
		return [op === '&&' ? makeNullish(p) : m];
	};
	return combineTypes(part(t));
}

// ===================================================================
//  The iteration protocol
// ===================================================================

export interface IterationTypes { yield: Type; return: Type; next: Type }

// The GLOBAL iteration types whose type arguments ARE their iteration types (TS's getIterationTypesOfIterableFast): its own lib
// declares them through the protocol, but a bundled lib may not (towasm's `Generator` has only `next`). A bare Iterator is only a
// generator's return type, never something to iterate.
const ITERABLES		= new Set(['Iterable', 'IterableIterator', 'IteratorObject', 'Generator']);
const ASYNC_ITERABLES	= new Set(['AsyncIterable', 'AsyncIterableIterator', 'AsyncIteratorObject', 'AsyncGenerator']);
function globalIterationTypes(t: Type, scope: Scope, async: boolean, generatorReturn: boolean): IterationTypes | undefined {
	if (t.type !== 'ref' || !((async ? ASYNC_ITERABLES : ITERABLES).has(t.name) || (generatorReturn && t.name === (async ? 'AsyncIterator' : 'Iterator'))))
		return undefined;
	const entry = ownScope(t, scope).lookupType(t.name);
	if (!entry?.typeParams || entry !== scope.root().type(t.name))
		return undefined;
	const [y, r, n] = [...typeArgMap(entry.typeParams, t.typeArgs, UNKNOWN).values()];
	return { yield: y ?? UNKNOWN, return: r ?? ANY, next: n ?? ANY };
}

export function iterationTypes(t: Type, scope: Scope, async = false, depth = 6, generatorReturn = false): IterationTypes | undefined {
	const fast = globalIterationTypes(t, scope, async, generatorReturn);
	if (fast)
		return fast;
	const r = resolveOwn(t, scope);
	if (isAny(r))
		return { yield: ANY, return: ANY, next: ANY };
	if (r.type === 'union' && depth > 0) {
		const parts = r.types.map(m => iterationTypes(m, scope, async, depth - 1));
		return parts.every(p => !!p) ? { yield: combineTypes(parts.map(p => p!.yield)), return: combineTypes(parts.map(p => p!.return)), next: combineTypes(parts.map(p => p!.next)) } : undefined;
	}
	// TS's getIterationTypesOfIterable: a method, iterator or `next` typed `any` iterates as `any`. The member is read through the
	// receiver's own `this`, so `declare [Symbol.iterator]: this["entries"]` reaches the receiver's `entries`.
	const anyIteration	= { yield: ANY, return: ANY, next: ANY };
	const isAnyType		= (x: Type | undefined) => !!x && isAny(resolveOwn(x, scope));
	const protocol = (key: string): IterationTypes | undefined => {
		const method	= lookupMember(t, key, scope);
		if (isAnyType(method))
			return anyIteration;
		const iterator	= findFunctionType(substituteThisType(method ?? NEVER, t), scope)?.returnType;
		if (isAnyType(iterator))
			return anyIteration;
		// An iterator that is itself a global Iterator/Generator reference is read off its type arguments, as TS's
		// getIterationTypesOfIteratorFast does: `next()`'s bundled IteratorResult can't split `value` by `done`.
		const fastIterator	= iterator && globalIterationTypes(substituteThisType(iterator, t), scope, key === '[Symbol.asyncIterator]', true);
		if (fastIterator)
			return fastIterator;
		const nextMember	= iterator && lookupMember(substituteThisType(iterator, t), 'next', scope);
		if (isAnyType(nextMember))
			return anyIteration;
		const nextSig	= nextMember && findFunctionType(nextMember, scope);
		const next		= nextSig?.returnType;
		if (!next)
			return undefined;

		const yields: Type[] = [], returns: Type[] = [];
		for (const m of unionMembers(key === '[Symbol.asyncIterator]' ? awaitType(next, scope) : next, scope)) {
			const done = lookupMember(m, 'done', scope);
			const d = done && resolveOwn(done, scope);
			(d && isLiteral(d, 'boolean') && d.value === true ? returns : yields).push(lookupMember(m, 'value', scope) ?? UNDEFINED);
		}
		// `next`: what `next(v)` accepts, which a generator's `yield` evaluates to -- `next(...[value]: [] | [TNext])` spells it as a rest.
		return { yield: combineTypes(yields), return: combineTypes(returns),
			next: paramTypeAt(nextSig, 0, scope) ?? UNDEFINED };
	};
	if (async) {
		const own = protocol('[Symbol.asyncIterator]');
		if (own)
			return own;
		const sync = iterationTypes(t, scope, false, depth);
		return sync && { ...sync, yield: awaitType(sync.yield, scope) };
	}
	const found = protocol('[Symbol.iterator]');
	if (found)
		return found;
	const direct = arrayLikeElement(r) ?? (r.type === 'tuple' ? combineTypes(elementTypes(r, scope)) : isString(r) ? STRING : undefined);
	return direct && { yield: direct, return: UNDEFINED, next: UNDEFINED };
}
