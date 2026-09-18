import * as TS from '../TS/ts-parser';
import { Type } from '../TS/ts-parser';
import { ANY, BIGINT, BOOLEAN, NUMBER, STRING, UNDEFINED, Scope, Semantics, combineTypes, objectMember } from '../TS/type-core';

// Python's view of the shared type model: `type-core`, spelled in TypeScript's vocabulary, plus what Python's runtime adds.
// A stub: it fixes the spelling and the `Semantics` a Python root scope carries. The rest is listed at the end.
export * from '../TS/type-core';

// ===================================================================
//  Python's types, as the shared vocabulary spells them
// ===================================================================

// `int` is arbitrary precision, so a `bigint`; `None` is what a bare `return` gives, so `undefined`. `object` is spelled
// `Object`, since `object` is already an intrinsic type here. Any other class keeps its own name, as a nominal ref.
const SCALARS = new Map<string, Type>([['int', BIGINT], ['float', NUMBER], ['bool', BOOLEAN], ['str', STRING], ['None', UNDEFINED], ['Any', ANY], ['object', TS.RefType('Object')]]);

// A Python annotation `name[args]`, as a shared type; undefined for a name that is not a builtin (a class or alias).
// A bare generic (`list`) has `Any` arguments, as PEP 484 defines it.
export function builtinType(name: string, args: Type[] = []): Type | undefined {
	switch (name) {
		case 'list':		return TS.ArrayType(args[0] ?? ANY);
		case 'tuple':		return { type: 'tuple', elements: args };
		case 'dict':		return TS.RefType('Map', [args[0] ?? ANY, args[1] ?? ANY]);
		case 'set':			return TS.RefType('Set', [args[0] ?? ANY]);
		case 'Optional':	return combineTypes([args[0] ?? ANY, UNDEFINED]);
		case 'Union':		return combineTypes(args);
		case 'Awaitable':
		case 'Coroutine':	return TS.RefType('Promise', [args.at(-1) ?? ANY]);
		default:			return SCALARS.get(name);
	}
}

// ===================================================================
//  Members Python adds: PY_SEMANTICS, and the global scope
// ===================================================================

// A Python primitive IS an instance of its builtin class, so there is no wrapper: `'x'.upper()` is `str`'s method.
const BUILTIN_CLASS = new Map([['string', 'str'], ['bigint', 'int'], ['number', 'float'], ['boolean', 'bool']]);

export const PY_SEMANTICS: Semantics = {
	boxed:			name => BUILTIN_CLASS.get(name),
	// Every value is an `object` (spelled `Object`); a function's own members (`__name__`, `__call__`) come first.
	apparentMember:	objectMember,
	// Nothing is typed more precisely than Python's lib declares it.
	refinedMember:	() => undefined,
};

// The root scope of a Python program. Its builtins (`object`, `str`, `len`...) will come from Python's lib, not yet written.
export function makeGlobal(): Scope {
	const global = new Scope(PY_SEMANTICS);
	global.addValue('None', UNDEFINED);
	return global;
}

// Still to write, as Python's counterparts of `TS/type-utils.ts`: truthiness (empty containers and `__bool__`/`__len__`), `isinstance`
// narrowing, literal typing, iteration through `__iter__`, and keyword arguments -- which `TS.CallSig` cannot yet express.
