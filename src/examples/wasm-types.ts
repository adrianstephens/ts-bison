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
import { Location } from './common';

const I				= wasm.I;

type ScalarI	= 'i32' | 'i64' | 'f32' | 'f64'
type Scalar		= ScalarI | 'u32' | 'u64'
type ElementI	= ScalarI | 'i8' | 'i16' | 'ref';
type Element	= ElementI | 'u8' | 'u16' | 'u32' | 'u64';
// The PHYSICAL shape of a closure: what wasm needs to call it, and nothing about the language that produced it. `FuncSig` extends this with the binding data only argument-binding reads.
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

// If `wtype` is a boxed nullable primitive (see `Types.nullable`/`Types.box`), its underlying
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

export class TSWError {
	msg:	string;
	pos?:	Location;
	scope:	string[] = [];
	// The module `pos` is in, set where `pos` is (`inModule`): a position alone can't say which reached file it's in.
	module?: string;
	constructor(err: string|TSWError, node?: any, ...scope: string[]) {
		if (err instanceof TSWError) {
			this.msg	= err.msg;
			this.pos		= err.pos ?? node?.pos;
			this.module		= err.module;
			this.scope		= [...err.scope, ...scope];
		} else {
			this.msg	= err;
			this.pos		= node?.pos;
			this.scope		= scope;
		}
	}
	inModule(module: string): TSWError {
		if (this.pos && !this.module)
			this.module = module;
		return this;
	}
	get message() {
		return `tsw:${this.pos ? ` (${this.pos.line}:${this.pos.col})` : ''}${this.scope.map(i => ` in ${i}`).join('')} ${this.msg}`;
	}
}


// A body compiled later from the worklist, outside its declaration's own catch: names it, and falls back to its position and module for an error raised on a synthesized node that has none.
export function withCatchAt(item: ()=>void, node: unknown, module: string, ...scopes: string[]) {
	return () => {
		try {
			item();
		} catch (e) {
			throw new TSWError(e as any, node, ...scopes).inModule(module);
		}
	};
}

export function withCatch(item: ()=>void, ...scopes: string[]) {
	return () => {
		try {
			item();
		} catch (e) {
			throw new TSWError(e as any, undefined, ...scopes);
		}
	};
}

export interface Local {
	wtype:			Type;
	index:			number;
	holderInner?:	Type;
}

export interface ClosureEnv {
	envLocal:		Local;
	envTypeIndex:	number;
	fields:			Map<string, Local>
};

// Pushed by `case 'try'` while compiling a `try`/`catch` that has a `finally` -- `emitBreak`/
// `emitContinue` check this first (innermost guard): real JS semantics require `finally` to run
// before either actually completes, so one whose real target lies outside this specific
// `try`/`finally`'s own span stashes an action code and branches to the shared landing point
// instead of exiting directly. Popped before that landing point's own re-dispatch code is built, so
// a `br` built there targets the next-outer guard (or ordinary behavior once none remain) --
// composes for nested `try`/`finally` without any extra bookkeeping. `return`'s own equivalent
// redirect is a temporary `ctx.onReturn` swap instead (see `case 'try'`), not part of this guard --
// unlike a loop/switch target, there's only ever one "current" return meaning at a time, no stack needed.
export interface FinallyGuard {
	actionLocal:				Local;
	breakTargetsLenAtEntry:		number;
	continueTargetsLenAtEntry:	number;
	landingDepth:				number
};


// A method-bearing struct: a real class, a synthesized object shape, or a builtin operator's owner. Only the
// physical facts live here. What a method DECLARES (`decl`, `methodDecls`, the TS type it was checked
// against) stays with the language -- and so must `declScope`, because `Scope` belongs to type-utils, which
// imports this module.
export class ClassInfo {
	// `optional` is set only for an object shape's own `key?: T` member; a real class field is never optional.
	fields:			{ name: string; wtype: Type; optional?: boolean }[] = [];
	fieldIndex		= new Map<string, number>();
	getterNames?:	Set<string>;
	setterNames?:	Set<string>;
	homeModule?:	string;
	// This class's own real physical `this`-type -- `thisWtype` is only unset while that constructor is still
	// being compiled, and `{ref: name}` is the safe answer then.
	thisWtype?:		Type;
	// `fields`/`fieldIndex` are pre-seeded with the superclass's own, in order, so wasm-GC's ordered-prefix
	// field-subtyping holds automatically.
	superClass?:	ClassInfo;

	// `typeIndex` is -1 while this class has no struct type: one is allocated once `fields` is populated, and a
	// constructor that returns a scalar never gets one at all.
	constructor(public name: string, public typeIndex: number) {}

	get thisType(): Type {
		return this.thisWtype ?? { ref: this.name };
	}

	// The field-table invariant lives with the table: a name that would redeclare an inherited field is an
	// error rather than a silent second slot. What a declared type RESOLVES to stays the caller's job.
	addField(name: string, wtype: Type, optional = false): void {
		if (this.fieldIndex.has(name))
			throw `field '${name}' redeclares an inherited field -- not supported`;
		this.fieldIndex.set(name, this.fields.length);
		this.fields.push({ name, wtype, optional });
	}

	isBaseOf(cls: ClassInfo | undefined): boolean {
		while (cls) {
			// By identity too: a shared object shape is reachable under more than one key.
			if (cls.name === this.name || cls === this)
				return true;
			cls = cls.superClass;
		}
		return false;
	}

}

export class FunctionContext {
	// Declarations (`declareLocal`/`declareValue`, and `local`'s scratch temps), in declaration order. A name may appear
	// more than once (a closed sibling scope's declaration, or a live nested shadow) -- `lookup` scans
	// from the end and skips closed entries, so a still-open outer binding resurfaces once an inner one closes.
	// `pinned`: belongs to the FUNCTION, not to whatever block happened to be open when it was declared,
	// so `closeScope` leaves it alone. Only `this` in a constructor needs it -- see `materializeThis`.
	declared:	{ name: string; local: Local; closed: boolean; pinned?: boolean }[] = [];
	// Watermarks (`declared.length` at open time) for each currently open lexical block -- see `openScope`.
	scopeStack: number[] = [];
	// One entry per real wasm local index (params included); a slot's type is fixed for the whole function,
	// so `freeSlots` (keyed by `wasmTypeKey`) only ever offers back a same-typed index for reuse.
	slotTypes:	Type[] = [];
	freeSlots	= new Map<string, number[]>();
	out:		wasm.Instr[]	= [];
	ctorThis?:	Local;

	// Set only while a struct-collecting constructor (see `ensureCtor`) gathers field values into scratch
	// locals ahead of `struct.new` -- lets `this.field` resolve to the field's own local, for a field already
	// collected, before a real `this` exists. Cleared the moment `ctorThis` is set.
	ctorFields?: Map<string, Local>;

	depth = 0;
	breakTargets:		number[] = [];
	continueTargets:	number[] = [];

	// Set when this FuncCtx is a closure body -- captured names have no real local, reads/writes go through struct.get/set on envLocal.
	closureEnv?:		ClosureEnv;
	
	// `collectCapturedMutables(ownBody)`, computed on first use -- see `needsHolder`.
	holderNames?:		Set<string>;

	// Unset for an ordinary function/method/arrow -- `case 'return'` falls back to `plainReturn` in that case. See `ReturnHandler`'s own comment for who sets this and why.
	finallyGuards:		FinallyGuard[] = [];

	constructor(public name: string) {}

	lookup(name: string): Local | undefined {
		for (let i = this.declared.length - 1; i >= 0; i--) {
			const d = this.declared[i];
			if (!d.closed && d.name === name)
				return d.local;
		}
		return undefined;
	}

	private allocLocal(wtype: Type): number {
		const free = this.freeSlots.get(wasmTypeKey(wtype));
		return free?.length ? free.pop()! : this.slotTypes.push(wtype) - 1;
	}
	private freeLocal(wtype: Type, index: number) {
		const key	= wasmTypeKey(wtype);
		const free	= this.freeSlots.get(key);
		if (free)
			free.push(index);
		else
			this.freeSlots.set(key, [index]);
	}

	// more WAT labels with no `break`/`continue` targets of their own
	enterLabel(n = 1)		{ return this.depth += n; }
	exitLabel(n = 1)		{ this.depth -= n; }

	// A loop or switch's enclosing block -- what `break` (with no label) branches to.
	enterBreakTarget()		{ this.breakTargets.push(++this.depth); }
	exitBreakTarget()		{ this.breakTargets.pop(); this.depth--; }

	// A loop's own restart point -- what `continue` branches to.
	enterContinueTarget()	{ this.continueTargets.push(++this.depth); }
	exitContinueTarget()	{ this.continueTargets.pop(); this.depth--; }

	// Opens a new lexical scope
	openScope() {
		this.scopeStack.push(this.declared.length);
		return this;
	}

	// Closes the innermost open scope: every declaration made since its `openScope` becomes invisible to
	// `lookup` and its wasm slot goes back on the free list for a same-typed declaration to reuse.
	closeScope() {
		const mark = this.scopeStack.pop();
		if (mark === undefined)
			throw 'unbalanced scope close';
		for (let i = mark; i < this.declared.length; i++) {
			const d = this.declared[i];
			if (!d.closed && !d.pinned) {
				d.closed = true;
				this.freeLocal(d.local.wtype, d.local.index);
			}
		}
		return this;
	}

	inScope(fn: (ctx: FunctionContext)=>void) {
		this.openScope();
		fn(this);
		this.closeScope();
	}

	emitBreak() {
		const guard = this.finallyGuards.at(-1);
		if (guard && this.breakTargets.length <= guard.breakTargetsLenAtEntry)
			this.emit(I.i32.const(2), I.local.set(guard.actionLocal.index), I.br(this.depth - guard.landingDepth));
		else
			this.emit(I.br(this.depth - this.breakTargets.at(-1)!));
	}
	emitContinue() {
		const guard = this.finallyGuards.at(-1);
		if (guard && this.continueTargets.length <= guard.continueTargetsLenAtEntry)
			this.emit(I.i32.const(3), I.local.set(guard.actionLocal.index), I.br(this.depth - guard.landingDepth));
		else
			this.emit(I.br(this.depth - this.continueTargets.at(-1)!));
	}
	// a still-visible same-name entry is reused rather than rejected
	temp(name: string, wtype: Type): number {
		const prev = this.lookup(name);
		if (prev) {
			// Structurally, as the name itself was built (`scratchName` keys by `wasmTypeKey`): two equal types
			// need not be one object -- a fresh `Types.nullable(REF_ANY)` and the `REF_ANY_NULLABLE` constant.
			if (wasmTypeKey(prev.wtype) !== wasmTypeKey(wtype))
				throw `local '${name}' redeclared with different type`;
			return prev.index;
		}
		const index = this.allocLocal(wtype);
		this.declared.push({ name, local: { wtype, index}, closed: false });
		return index;
	}

	declareLocal(name: string, wtype: Type, pinned = false): Local {
		const scopeStart = this.scopeStack.at(-1) ?? 0;
		for (let i = this.declared.length - 1; i >= scopeStart; i--) {
			const d = this.declared[i];
			if (!d.closed && d.name === name)
				throw `local '${name}' redeclared (shadowing within the same scope is not supported)`;
		}
		const local = {wtype, index: this.allocLocal(wtype)};
		this.declared.push({ name, local, closed: false, pinned });
		return local;
	}

	resolvesName(name: string): boolean {
		return this.lookup(name) !== undefined || !!this.closureEnv?.fields.has(name);
	}

	// The WasmType a name's real, logical VALUE has -- real local/closureEnv field, or (see `Local`'s own
	// comment) a forward-holder's own inner type once unboxed. This is what any ordinary consumer of a
	// name's type wants (e.g. deciding how to *call* it) -- `rawWtype`, below, is the one exception.
	resolvedWtype(name: string): Type | undefined {
		const captured = this.closureEnv?.fields.get(name);
		if (captured)
			return captured.holderInner ?? captured.wtype;
		const local = this.lookup(name);
		return local?.holderInner ?? local?.wtype;
	}
	// The WasmType a name's own physical STORAGE slot has -- a forward-holder's own boxed type, never
	// unboxed. Only ever needed by `emitClosureLiteral`'s own env-capture step: capturing a forward-
	// holder's real (shared, mutable) storage into an outer closure's env is the one place that needs the
	// holder ITSELF, not the value it currently (or eventually) holds.
	rawWtype(name: string): Type | undefined {
		return this.closureEnv?.fields.get(name)?.wtype ?? this.lookup(name)?.wtype;
	}

	// Reads a name's own storage slot: a captured name lives in `closureEnv`, everything else in a local.
	rawSlot(name: string) {
		const captured = this.closureEnv?.fields.get(name);
		if (captured) {
			this.emit(I.local.get(this.closureEnv!.envLocal.index), I.struct.get(this.closureEnv!.envTypeIndex, captured.index));
			return;
		}
		this.emit(I.local.get(this.lookup(name)!.index));
	}

	// A holder's field is nullable because it must be allocatable empty, but `holderInner` is the logical
	// non-null type, so the read unwraps -- sound because the filling declaration always runs first.
	emitHolderRead(holderType: number, inner: Type) {
		this.emit(I.struct.get(holderType, 0));
		if (typeof inner !== 'string' && !inner.nullable)
			this.emit(I.ref.as_non_null);
	}

	swapOut(out: wasm.Instr[] = []) {
		const _old	= this.out;
		this.out	= out;
		return _old;
	}

	emit(...instr: (wasm.Instr|wasm.Instr[])[]) {
		this.out.push(...instr.flat());
	}

	toFuncBody(numParams: number, toValType: (t: Type) => wasm.ValType): wasm.FuncBody & {id: string} {
		return { id: this.name.replace(/[^a-zA-Z0-9_]/g, '_'), locals: this.slotTypes.slice(numParams).map(t => ({ count: 1, type: toValType(t) })), body: this.out };
	}
	// A non-`void` body doesn't necessarily end in a top-level `return` -- `if`/`while`/`switch` compile to a `void`-typed block wrapping their branches, leaving wasm's trailing-fallthrough check unsatisfied.
	// No full "does every path return" analysis to avoid it -- a trailing `unreachable` is always safe (dead code whenever a real return already covers every path).
	emitTrailingUnreachable(result: Type): void {
		if (result !== 'void')
			this.emit(I.unreachable);
	}
	
}


// Qualifies a scratch local's name by its own wtype -- a bare fixed name would collide (`FuncCtx.local`
// throws on a same-name-different-type redeclare) once one function writes to two differently-typed targets.
export function scratchName(prefix: string, wtype: Type): string {
	return `${prefix}$${wasmTypeKey(wtype)}`;
}

// The type a short-circuiting operator (`&&`/`||`/`??`) gives both its arms: the caller's, when both it and the
// self-inferred one are object refs -- only then does building at it rather than converting to it matter (invariance).
export function wantedShape(want: Type | undefined, self: Type): Type {
	return typeof want === 'object' && 'ref' in want && typeof self === 'object' && 'ref' in self ? want : self;
}

export function mentionsTypeIndex(t: wasm.SubType, index: number): boolean {
	const comp = 'type' in t ? t.type : t;
	const is = (v: unknown) => typeof v === 'object' && v !== null && 'ref' in v && (v as { ref: unknown }).ref === index;
	return ('supertypes' in t && t.supertypes.includes(index))
		|| (comp.kind === 'struct' ? comp.fields.some(f => is(f.type))
		: comp.kind === 'array' ? is(comp.field.type)
		: comp.kind === 'func' && (comp.params.some(p => is(p.type)) || comp.results.some(is)));
}

export class Types extends Array<wasm.SubType> {
	typeMap			= new Map<string, number>();

	array(kind: ElementI): number		{ return this.register(this.arrayDesc(kind)); }
	hasArray(kind: ElementI): boolean	{ return this.has(this.arrayDesc(kind)); }
	box(kind: ScalarI): number			{ return this.register(this.boxDesc(kind)); }
	hasBox(kind: ScalarI): boolean		{ return this.has(this.boxDesc(kind)); }

	// The nullable form of a representation. A scalar must BOX -- a nullable f64 is a ref to a one-field
	// struct, not a nullable value type, and `u32`/`u64` share their signed twin's box; a reference takes the flag.
	nullable(base: Type): Type {
		if (typeof base !== 'string')
			return { ...base, nullable: true };
		if (base === 'void')
			throw "a nullable 'void' value is not supported -- 'void' has no value representation to box";
		const kind = notUnsigned(base);
		return { typeIndex: this.box(kind), nullable: true, primKind: kind };
	}

	// The common supertype every closure literal's env struct extends: zero fields, non-`final` (wasm-GC
	// width-subtyping needs the supertype's fields as a prefix, which is vacuous here).
	envBase(): number {
		return this.register({ final: false, supertypes: [], type: { kind: 'struct', fields: [] } });
	}

	// Function indices come off the same per-compile counter as the type section, since a func's type is
	// registered first and its index taken second: `func` is the pair every caller wants.
	private nextFunc = 0;
	funcType(params: wasm.ParamType[], results: wasm.ValType[]): number {
		return this.register({ final: true, supertypes: [], type: { kind: 'func', params, results } });
	}
	funcAt(typeIndex: number): { funcIndex: number; typeIndex: number } {
		return { funcIndex: this.nextFunc++, typeIndex };
	}
	func(params: wasm.ParamType[], results: wasm.ValType[]): { funcIndex: number; typeIndex: number } {
		return this.funcAt(this.funcType(params, results));
	}

	private arrayDesc(kind: ElementI): wasm.SubType {
		return { final: true, supertypes: [], type: { kind: 'array', field: { type: kind === 'ref' ? { ref: 'any', nullable: true } : kind, mut: true } } };
	}
	private boxDesc(kind: ScalarI): wasm.SubType {
		return { final: true, supertypes: [], type: { kind: 'struct', fields: [{ type: kind, mut: false }] } };
	}

	get(i: number) { return this[i]; }
	set(i: number, t: wasm.SubType) { this[i] = t; }

	add(type: wasm.SubType): number {
		return this.push(type) - 1;
	}
	// "Does this module already have this array type" WITHOUT creating it: `ensureArrayType` would register one
	// as a side effect, and a speculative candidate scan must not add types nothing uses. An absent type means
	// no value of that kind exists to reach an `any` slot.
	has(desc: wasm.SubType): boolean {
		const key = wTypeKey(desc);
		return key !== undefined && this.typeMap.has(key);
	}

	register(type: wasm.SubType): number {
		const key		= wTypeKey(type);
		const existing	= key !== undefined ? this.typeMap.get(key) : undefined;
		if (existing !== undefined)
			return existing;
		const typeIndex = this.add(type);
		if (key !== undefined)
			this.typeMap.set(key, typeIndex);
		return typeIndex;
	}
	
}