// The language-neutral half of the wasm backend's vocabulary: what a value physically IS once lowered,
// plus the pure helpers that read those representations. Nothing here names a language's AST, its type
// model, or its checker.
//
// `ClosureSig` is the seam that makes that possible: `Type`'s `closure` variant names only the
// PHYSICAL shape, while the binding data that only argument-binding reads (`defaults`/`resolvedParams`/
// `restElem` -- language exprs and types) lives in `FuncSig` in `towasm.ts`, which extends it.
// See `memory/tison_towasm_cross_language_plan.md`.
//
// Deliberately NOT here, though they have no language types in them: `PRIMITIVE_TAGS`, `READONLY_ALIAS`,
// `isNullLiteral`, `nullLiteralKind` and `rawElemKind` are rules about TypeScript's own type *spellings*
// ('string', 'ReadonlyArray', a null literal, a typed-array tag on a declared type), not about
// representations, so they stay on the language side.

import * as wasm from '@isopodlabs/binary_libs/wasm';

type ScalarI	= 'i32' | 'i64' | 'f32' | 'f64'
type Scalar		= ScalarI | 'u32' | 'u64'
type ElementI	= ScalarI | 'i8' | 'i16' | 'ref';
type Element	= ElementI | 'u8' | 'u16' | 'u32' | 'u64';
// The PHYSICAL shape of a closure: what wasm needs to call it, and nothing about the language that
// produced it. `FuncSig` extends this with the binding data only argument-binding reads.
interface ClosureSig	{ params: Type[]; result: Type; hasRest?: boolean }

type Type		= Scalar
	| 'void'	// only valid as a function result, never a param/local/field.
	| { ref:		string; nullable?: boolean }
	| { arr:		ElementI; nullable?: boolean }
	| { closure:	ClosureSig; nullable?: boolean }
	| { typeIndex:	number; nullable?: boolean }
	// A boxed nullable primitive ('number | null'/'boolean | null'): a real class/closure env struct
	// never sets `primKind`, so it's what tells a `typeIndex`-shaped type apart from those -- see
	// `unboxedPrimitive`. Structural, not a side-table, since `registerType`'s memoization could
	// otherwise coincidentally share a type index with an unrelated single-scalar-field struct.
	| { typeIndex:	number; nullable?: boolean; primKind: ScalarI };


// Shared singletons -- ctx.local compares Type by object identity
const ARR_WTYPE: Record<ElementI, Type> = {
	i8: { arr: 'i8' },
	i16: { arr: 'i16' },
	i32: { arr: 'i32' },
	i64: { arr: 'i64' },
	f32: { arr: 'f32' },
	f64: { arr: 'f64' },
	ref: { arr: 'ref' },
};
const REF_ANY:			Type = { ref: 'any' };
const REF_ANY_NULLABLE: Type = { ref: 'any', nullable: true };
const REF_EXN:			Type = { ref: 'exn', nullable: true };

// The plain scalar kind a value acts as for arithmetic/comparison dispatch -- unwraps a boxed
// nullable primitive the same way `coerceTop` does, or passes a bare scalar through unchanged.
// `undefined` for anything else (a real class/array/closure).
function scalarKind(wtype: Type | undefined): Scalar | undefined {
	return typeof wtype === 'string' ? (wtype !== 'void' ? wtype : undefined) : wtype && unboxedPrimitive(wtype)?.kind;
}
function notUnsigned(wtype: Scalar): ScalarI;
function notUnsigned(wtype: Scalar | undefined): ScalarI  | undefined;
function notUnsigned(wtype: Element): ElementI;
function notUnsigned(wtype: string | undefined) {
	return wtype && wtype[0] === 'u' ? `i${wtype.slice(1)}` : wtype;
}
function elementKind(wtype: Type | undefined): ElementI {
	return typeof wtype === 'string' && wtype !== 'void' ? notUnsigned(wtype) : 'ref';
}

// Wasm's own pseudo-type vocabulary: the value types a language's `declare type i32 = number`-style alias
// stands for, so a field/method's storage can be something other than the usual `number`->f64 mapping. The
// NAMES are wasm's, so they are owned here and a language views them (`T.WASM_PSEUDO_TYPES`) rather than
// spelling them a second time.
const PSEUDO_TYPES = ['i8', 'u8', 'i16', 'u16', 'i32', 'i64', 'f32', 'f64', 'u32', 'u64'] as const;
type PseudoType = typeof PSEUDO_TYPES[number];
function isPseudoType(name: string): name is PseudoType { return (PSEUDO_TYPES as readonly string[]).includes(name); }

// The VALUE type a pseudo-type occupies in a slot: wasm has no sub-32-bit value types, so the packed 8/16-bit
// kinds widen (`i8`/`i16` -> i32, `u8`/`u16` -> u32) and every other name is its own value type. Distinct
// from an element's physical STORAGE kind, which keeps `u8` as `u8` -- see `rawElemKind` on the language side.
function pseudoValueType(name: PseudoType): Scalar {
	return name === 'i8' || name === 'i16' ? 'i32'
		: name === 'u8' || name === 'u16' ? 'u32'
		: name;
}

// If `wtype` is a boxed nullable primitive (see `nullableWtype`/`ensureBoxType`), its underlying
// scalar kind and box type index; otherwise `undefined` (a real class/array/closure-env-struct, or
// already a bare scalar). Structural (checks `primKind` on the object itself), not a lookup table --
// `registerType`'s structural memoization means an unrelated single-scalar-field struct (e.g. a
// closure's env struct capturing exactly one `f64`) could otherwise coincidentally share a box's
// type index, which a table keyed by type index alone couldn't tell apart.
function unboxedPrimitive(wtype: Type): { kind: ScalarI; typeIndex: number } | undefined {
	return typeof wtype !== 'string' && 'primKind' in wtype ? { kind: wtype.primKind, typeIndex: wtype.typeIndex } : undefined;
}

function wasmTypeEq(a: Type, b: Type): boolean {
	if (typeof a === 'string' || typeof b === 'string')
		return a === b;
	if ('ref' in a && 'ref' in b)
		return a.ref === b.ref && !a.nullable === !b.nullable;
	if ('arr' in a && 'arr' in b)
		return a.arr === b.arr && !a.nullable === !b.nullable;
	if ('typeIndex' in a && 'typeIndex' in b)
		return a.typeIndex === b.typeIndex && !a.nullable === !b.nullable;
	if ('closure' in a && 'closure' in b)
		return !a.nullable === !b.nullable
			&& a.closure.params.length === b.closure.params.length
			&& wasmTypeEq(a.closure.result, b.closure.result)
			&& a.closure.params.every((p, i) => wasmTypeEq(p, b.closure.params[i]))
			&& !a.closure.hasRest === !b.closure.hasRest;

	return false;
}
// Picks the tightest integer wasm type for a known range: i32, u32, or f64.
function intWasmType(min: number, max: number): Type {
	if (min >= -0x80000000 && max <= 0x7fffffff)
		return 'i32';
	if (min >= 0 && max <= 0xffffffff)
		return 'u32';
	return 'f64';
}

// Stable structural key for memoizing closure-type registration by TS function signature.
function wasmTypeKey(w: Type): string {
	if (typeof w === 'string')
		return w;
	if ('ref' in w)
		return `ref:${w.ref}:${!!w.nullable}`;
	if ('arr' in w)
		return `arr:${w.arr}:${!!w.nullable}`;
	if ('closure' in w)
		return `(${w.closure.params.map(wasmTypeKey).join(',')})=>${wasmTypeKey(w.closure.result)}:${!!w.nullable}`;
	if ('typeIndex' in w)
		return `typeIndex:${w.typeIndex}:${!!w.nullable}`;
	return '?';
}

// The one shared `Type` a union of >=2 members' own physical representations collapses to --
// `typeOf`'s own 'union' case, and `ensureUnionIndexDispatch`'s own per-member `get(i)` result
// (`case 'member'`'s sibling `ensureUnionFieldDispatch` instead goes through the checker's own
// `T.lookupMember`, since a named property's type unions cleanly there; indexing has no such
// checker-side precision for a union receiver yet, so this compares physical wtypes directly, same
// as before that fix existed). Members that already physically agree stay exactly as they are (a
// degenerate union like `IteratorResult<Y,R>.value: Y | R` monomorphized with `Y`/`R` both `number`
// must stay a plain `f64`, not box as `any` just because a union with >1 syntactic member showed up).
// Members that only differ by a wasm-pseudo-type-vs-real-type spelling of the same scalar (`i32` vs
// `number`/`f64` -- the top-of-file `WASM_PSEUDO_TYPES` comment's own ternary example, also hit by
// `Uint8Array.length: i32` vs `Array<T>.length: number`) widen to the one canonical `f64`. Anything
// else (class vs. class, scalar vs. struct/array, ...) boxes as `any`, the same physical
// representation this compiler already gives every other "could be one of several shapes" value.
function combineUnionWtypes(wtypes: readonly Type[]): Type {
	if (new Set(wtypes.map(w => wasmTypeKey(w))).size === 1)
		return wtypes[0];
	if (wtypes.every(w => scalarKind(w) !== undefined))
		return 'f64';
	return REF_ANY;
}

function storageTypeKey(v: wasm.StorageType): string {
	return typeof v === 'string' ? v : `ref:${v.ref}:${v.nullable}`;
}
function wTypeKey(type: wasm.SubType): string|undefined {
	const comp = 'type' in type ? type.type : type;
	return comp.kind === 'func' ? `func(${comp.params.map(p => storageTypeKey(p.type)).join(',')})=>(${comp.results.map(storageTypeKey).join(',')})`
		: comp.kind === 'array' ? `array(${storageTypeKey(comp.field.type)}:${comp.field.mut})`
		// Field MUTABILITY is part of a struct's identity in wasm, exactly as it already is for an array
		// above -- omitting it silently merged two genuinely different types. It bit as soon as a scalar
		// holder (`ensureHolderType`, one mutable f64 field) appeared: identical to the immutable `f64` BOX
		// (`ensureBoxType`) under the old key, so a holder became a box and `ref.test` for `typeof x ===
		// 'number'` started matching holders too. `final`/`supertypes` likewise: a subtype is not its base.
		: comp.kind === 'struct' ? `struct(${comp.fields.map(f => `${storageTypeKey(f.type)}:${f.mut}`).join(',')})${'final' in type && type.final ? ':final' : ''}${'supertypes' in type && type.supertypes.length ? ':<' + type.supertypes.join(',') : ''}`
		: undefined;
}

// A function value's own properties that its closure struct stores, by field index (after `code` and `env`).
const CLOSURE_FIELDS = new Map([['length', 2]]);

export {
	ScalarI, Scalar, ElementI, Element, ClosureSig, Type,
	PSEUDO_TYPES, PseudoType, isPseudoType, pseudoValueType,
	ARR_WTYPE, REF_ANY, REF_ANY_NULLABLE, REF_EXN,
	scalarKind, notUnsigned, elementKind, unboxedPrimitive, wasmTypeEq, intWasmType,
	wasmTypeKey, combineUnionWtypes, storageTypeKey, wTypeKey, CLOSURE_FIELDS,
};
