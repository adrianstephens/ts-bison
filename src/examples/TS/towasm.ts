import * as fs from 'fs';
import * as path from 'path';
import * as TS from './ts-parser';
import * as JS from './js-parser';
import * as T from './type-utils';
import { Literal, hasMod } from '../common';
import { checkBlock, typeOf as checkerTypeOf, isOptionalChainLink, narrow } from './checker';
import { Walkable, walk, walkB } from './walker';
import { Output } from './tocode';
import { foldConstants, BuildStateMachine, collectHoistedLocals, StateMachine, SuspendBoundary, patternBindings } from './transform';
import * as wasm from '@isopodlabs/binary_libs/wasm';
import * as WAT from '../wat-parser';

// TStoWasm -- TS-AST-to-wasm backend for a narrow static subset.
// Assumes ast already passed TStypeCheck. Emits a wasm.WasmModule directly (no WAT stage).
// Every gap below throws a clear error rather than silently miscompiling. Unlisted = fully supported;
// an item under a category is either a whole missing construct or the one unsupported edge of an
// otherwise-working one -- never a description of what does work.
//  - Control flow:
//    - a suspend point ('yield'/'await') directly inside a 'try' -- a separate, permanent scope
//      boundary (see the Async section below), unrelated to try/catch/throw/finally themselves,
//      which are fully supported everywhere else, including inside a generator/async function, a
//      constructor, or a 'reassignsThis' method
//    - labeled break/continue
//    - for-in over an extended (possibly-subclassed) class instance -- a dynamic object (a structural
//      '{[k: string]: V}'-typed value, or a mapped type resolving to that shape, e.g. walker.ts's own
//      'NodeMap<N>') takes the efficient '.keys()' path; any other, *sealed* (never-subclassed) class/
//      object-shape falls back to 'Object.entries', same restriction that has -- the receiver's real
//      runtime type isn't visible here, only its declared one, so a correct key set can't be produced
//    - for-of over a string or a general iterable
//  - Async (real suspend/resume generators and async/await exist -- see 'flattenStateMachine' in
//    transform.ts and 'compileGeneratorFunc'/'compileAsyncFunc' here; this compiler has no
//    host-driven asynchrony at all, so "async" only ever means internal ordering between compiled
//    code, never real external concurrency -- a permanent scope boundary, not a gap):
//    - 'yield*' delegation
//    - '.return()'/'.throw()' on a generator
//    - 'for-of'/'for-await-of' over a generator or other iterable (stays under the general
//      for-of-over-an-iterable gap below; call '.next()' manually instead)
//    - 'Promise.race'/'Promise.any'/'Promise.allSettled' (only 'Promise.all' exists)
//    - the standard 'new Promise((resolve, reject) => ...)' executor form ('resolve' is a plain
//      public method on this compiler's 'Promise<T>' instead)
//    - Promise rejection/'.catch' -- this compiler's 'Promise<T>' has no rejected state at all, so
//      there's nothing yet for a real 'try'/'catch' to observe even where one could otherwise wrap
//      an 'await' (which it still can't -- a suspend point directly inside a 'try' is its own,
//      separate, permanent boundary, listed under Control flow above)
//    - a generic async or generator function
//    - an async function or generator nested inside another closure, capturing that enclosing
//      function's own free variables (its own params/locals are captured into its frame fine --
//      only capturing an *outer* function's variables is unsupported)
//    - a non-nullable object/array/closure-typed local that's hoisted into a generator/async frame
//      (i.e. assigned before its first suspend point) without ever having a real initial value at
//      frame-construction time -- the frame is built via one real 'struct.new', which needs a
//      concrete value for every non-nullable field up front; declare it nullable, or give it a real
//      initial value at declaration, instead
//  - Classes:
//    - 'abstract'
//    - computed field names
//    - a field cycle (a field can't be of its own class's type, directly or indirectly)
//    - an object-typed field anywhere in a hierarchy that also uses 'extends' (needs 'struct.new' with
//      real values up front, instead of 'struct.new_default')
//    - a generic superclass reference's own type args being anything but a plain name/instantiation
//    - extending an array/scalar-backed class (a constructor with its own explicit 'return', e.g.
//      'Array<T>'-style)
//    - a static generic method whose own type parameter shares a name with its class's type parameter
//      (the method's own substitution silently collides with the class's -- give it a differently-named
//      type parameter instead)
//  - Functions:
//    - generic arrow/function expressions
//    - a function expression's own 'this'
//    - a named function expression referencing its own name
//    - a nested function declaration called above its own textual position in the same block (no
//      hoisting -- only callable from below it, same as a 'let'/'const' would be)
//    - a nested function declaration referencing itself as a value rather than calling itself directly
//      (only 'name(...)' inside its own body is supported, not e.g. returning/reassigning it)
//    - a closure literal referencing a top-level 'let'/'const' global directly (only its own enclosing
//      function's locals/params are recognized as capturable free variables -- assign the global to a
//      local first and capture that instead)
//  - Expressions:
//    - an object literal with no statically-known nominal target type (a plain 'type X = {...}' alias
//      from a var_decl/param/field/return annotation, or anywhere else a concrete target type threads
//      through -- see 'ensureObjectShape'; general structural inference/subtyping is not this case) --
//      a structural index-signature target ('{[k: string]: V}') is the one exception, routed to a
//      real dynamic object (see 'indexSignatureValueType')
//    - 'delete'/'in' on anything but a dynamic object's own bracket-indexed property ('delete obj[k]',
//      'k in obj') -- a plain object/class field, or an array element, has no real 'delete' to give
//      either one
//    - a tag function typed against the real 'TemplateStringsArray' specifically, rather than a plain
//      'string[]' ('.raw' isn't modeled)
//    - calling a closure read directly off an array element ('arr[i](x)') when the array's element
//      type is a named type alias to a function type rather than an inline function type (e.g.
//      'type Fn = () => number; arr: Fn[]') -- a checker 'declScope' stamping gap ('stampScope' skips
//      a ref that already carries a scope, so a type-arg node resolved once under the wrong scope
//      during generic instantiation stays stuck with it) leaves the alias unresolved at the call site
//      even though the same alias resolves fine as a plain variable's declared type; bind the element
//      to a local first ('const f = arr[i]; f(x);', which 'for...of' already does for you) instead
//    - narrowing an 'any'-typed value (e.g. a caught 'catch(e)') down to a concrete class for a
//      subsequent field/method access -- 'unwrapAs' deliberately discards an 'as' cast's asserted
//      type for every codegen-facing owner/field lookup, and even guarding with a real 'instanceof'
//      check (which the checker does correctly narrow on) doesn't reach codegen's own owner/field
//      resolution inside the guarded branch -- there is currently no way to narrow a caught 'any'
//      down to a concrete class by either route
//    - writing through an index ('arr[i] = x') on a receiver whose static type is a real union of
//      different struct-backed array-likes (e.g. 'Uint8Array | number[]') -- a *read* ('arr[i]')
//      dispatches per-member same as '.property' access does ('ensureUnionIndexDispatch'/
//      'ensureUnionFieldDispatch'), but there's no write-side equivalent ('set(i,v)' dispatch) yet
//  - Numbers:
//    - an i32/u32-targeted float-to-int coercion (bitwise ops, an explicit i32/u32-typed local, etc.)
//      of a non-finite (NaN/+-Infinity) or huge finite f64 value doesn't replicate real JS's exact
//      'ToInt32'/'ToUint32' (always 0 for a non-finite value, true modulo-2^32 wraparound for a huge
//      finite one) -- saturates to 0/i32::MIN/i32::MAX instead ('coerceTop', 'i32.trunc_sat_f64_s'/'_u')
//      -- well-defined and never trapping, just not bit-perfect for these edge values
//  - Destructuring:
//    - a rest property inside an *object* pattern ('{a, ...rest}' -- needs a genuinely new object type
//      holding an arbitrary 'all fields except these' shape, not modeled yet)
//  - Optional chaining ('?.'):
//    - chaining onto a getter (direct '?.' or continued from an earlier one)
//    - a guarded method call that isn't a plain user method (e.g. a 'Math'/prelude intrinsic)
//    - a guarded method call returning 'void'
//  - Types:
//    - enums
//    - namespaces
//    - decorators
//    - '++'/'--' on a nullable primitive (needs narrowing to non-null first, which codegen has no way
//      to track -- narrow into a local first instead)

type Expr			= TS.Expr;
type Type			= TS.Type;
type Stmt			= TS.Stmt;
type BindingTarget	= JS.BindingTarget;
type FunctionDecl	= JS.FunctionDecl<Type>;
type MethodMember	= JS.Method<Type>;
type Scope			= T.Scope;
const Scope			= T.Scope;
const I				= wasm.I;

const ASSIGN_OPS	= new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '??=']);

const tocode = new Output({newline:'', indent:'', spaceAfterColon: false, spaceAfterComma: false, spaceAroundOps: false});

class TSWError {
	msg:	string;
	pos?:	JS.Location;
	scope:	string[] = [];
	constructor(err: string|TSWError, node?: any, ...scope: string[]) {
		if (err instanceof TSWError) {
			this.msg	= err.msg;
			this.pos		= err.pos ?? node?.pos;
			this.scope		= [...err.scope, ...scope];
		} else {
			this.msg	= err;
			this.pos		= node?.pos;
			this.scope		= scope;
		}
	}
	get message() {
		return `tsw:${this.pos ? ` (${this.pos.line}:${this.pos.col})` : ''}${this.scope.map(i => ` in ${i}`).join('')} ${this.msg}`;
	}
}

// lib files concatenated into one flat declaration list.
const LIB_DIR		= path.join(__dirname, 'lib');
// Globbed, not listed: a hardcoded list fails SILENTLY when a new lib file is forgotten -- the
// declarations simply do not exist, and the first sign is an "unknown class"/"unresolved identifier"
// somewhere unrelated. `readdirSync` order is filesystem-dependent, so it is sorted for a reproducible
// build, with `lib.d.ts` pinned first: it declares the pseudo-types and ambient host modules the rest
// are written against, and reading it first matches how the file is meant to be understood.
// `lib/node/*` is deliberately NOT included -- those are on-demand modules resolved through the loader
// (see `ModuleLoader.nodeBuiltin`), not part of this always-linked flat scope; the `.ts` filter drops
// the `node` directory entry along with `tsconfig.json`.
const LIB_FILES		= ['lib.d.ts', ...fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.ts') && f !== 'lib.d.ts').sort()];
const LIB_AST		= LIB_FILES.flatMap(f => TS.parse(fs.readFileSync(path.join(LIB_DIR, f), 'utf8')).body);
const LIB_EXPORTS	= LIB_AST.filter(n => n.type === 'export_decl').map(n =>n.declaration);
const LIB_DECLS		= [
	...[...LIB_EXPORTS, ...LIB_AST].filter(n => n.type === 'function_decl' || n.type === 'class_decl'),
	...[...LIB_EXPORTS, ...LIB_AST].filter(n => n.type === 'var_decl').flatMap(d => d.declarations.map(decl => ({type: 'var_decl', ambient: d.ambient, kind: d.kind, ...decl} as const)))
];

// An ambient `declare class`/`declare function` stub (`.ambient === true`, no body) exists only for the checker -- codegen must prefer a real same-named implementation.
// `LIB_DECLS`'s own ordering can't guarantee that (an exported real decl sits earlier than a non-exported ambient one), so plain last-wins would pick the ambient stub.
const LIB_DECL_MAP = new Map<string, typeof LIB_DECLS[number]>();
for (const d of LIB_DECLS) {
	const existing = LIB_DECL_MAP.get(d.name as string);
	if (existing && 'ambient' in d && d.ambient && !('ambient' in existing && existing.ambient))
		continue; // a real decl, once registered, is never displaced by a later ambient stub of the same name
	LIB_DECL_MAP.set(d.name as string, d);
}

// A lib file declares a real host (wasm) import with ordinary TS syntax -- `declare module 'name' {...}` plus `import {f} from 'name'` -- instead of a hand-registered one per feature.
// `source` matching an *ambient* `module_decl` (not a filename) discriminates a host import from an ordinary intra-lib one (e.g. regexp.ts's `import { StringParser } from './string'`).
interface HostImport { source: string; name: string; params: Type[]; returnType?: Type }
// The ambient `declare module '...'` blocks are always the LIB's own (`lib.d.ts` is always loaded); only
// the `import` statements naming one have to be looked for per body, so an on-demand `lib/node/*` module
// can declare a host import of its own instead of having to register it in a static lib file.
const LIB_AMBIENT_MODULES = new Map(LIB_AST.filter((n): n is Extract<TS.Stmt, { type: 'module_decl' }> => n.type === 'module_decl' && !!n.ambient).map(n => [n.name, n]));

function hostImportsIn(body: TS.Stmt[]): HostImport[] {
	return body.filter((n): n is JS.Import => n.type === 'import' && LIB_AMBIENT_MODULES.has(n.source)).flatMap(imp => (imp.specifiers ?? []).flatMap(s => {
		const decl = LIB_AMBIENT_MODULES.get(imp.source)!.body.find(d => d.type === 'function_decl' && d.name === s.imported);
		return decl?.type === 'function_decl' ? [{ source: imp.source, name: s.local, params: decl.params.map(p => p.typeAnnotation!), returnType: decl.returnType }] : [];
	}));
}

const LIB_HOST_IMPORTS: HostImport[] = hostImportsIn(LIB_AST);

type WasmScalarI	= 'i32' | 'i64' | 'f32' | 'f64'
type WasmScalar		= WasmScalarI | 'u32' | 'u64'
type WasmElementI	= WasmScalarI | 'i8' | 'i16' | 'ref';
type WasmElement	= WasmElementI | 'u8' | 'u16' | 'u32' | 'u64';
type WasmType		= WasmScalar
	| 'void'	// only valid as a function result, never a param/local/field.
	| { ref:		string; nullable?: boolean }
	| { arr:		WasmElementI; nullable?: boolean }
	| { closure:	FuncSig; nullable?: boolean }
	| { typeIndex:	number; nullable?: boolean }
	// A boxed nullable primitive ('number | null'/'boolean | null'): a real class/closure env struct
	// never sets `primKind`, so it's what tells a `typeIndex`-shaped type apart from those -- see
	// `unboxedPrimitive`. Structural, not a side-table, since `registerType`'s memoization could
	// otherwise coincidentally share a type index with an unrelated single-scalar-field struct.
	| { typeIndex:	number; nullable?: boolean; primKind: WasmScalarI };

const TYPED_ARRAY_TAGS = new Set(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64']);

// Shared singletons -- ctx.local compares WasmType by object identity
const ARR_WTYPE: Record<WasmElementI, WasmType> = {
	i8: { arr: 'i8' },
	i16: { arr: 'i16' },
	i32: { arr: 'i32' },
	i64: { arr: 'i64' },
	f32: { arr: 'f32' },
	f64: { arr: 'f64' },
	ref: { arr: 'ref' },
};
const REF_ANY:			WasmType = { ref: 'any' };
const REF_ANY_NULLABLE: WasmType = { ref: 'any', nullable: true };
const REF_EXN:			WasmType = { ref: 'exn', nullable: true };

// The plain scalar kind a value acts as for arithmetic/comparison dispatch -- unwraps a boxed
// nullable primitive the same way `coerceTop` does, or passes a bare scalar through unchanged.
// `undefined` for anything else (a real class/array/closure).
// None of these has a declaration of its own: a readonly view is a checker-only distinction over the
// very same physical container, which is the treatment `ownerFor` has always given `ReadonlyArray`.
const READONLY_ALIAS: Record<string, string> = { ReadonlyArray: 'Array', ReadonlyMap: 'Map', ReadonlySet: 'Set' };

function scalarKind(wtype: WasmType | undefined): WasmScalar | undefined {
	return typeof wtype === 'string' ? (wtype !== 'void' ? wtype : undefined) : wtype && unboxedPrimitive(wtype)?.kind;
}
function notUnsigned(wtype: WasmScalar): WasmScalarI;
function notUnsigned(wtype: WasmScalar | undefined): WasmScalarI  | undefined;
function notUnsigned(wtype: WasmElement): WasmElementI;
function notUnsigned(wtype: string | undefined) {
	return wtype && wtype[0] === 'u' ? `i${wtype.slice(1)}` : wtype;
}
function elementKind(wtype: WasmType | undefined): WasmElementI {
	return typeof wtype === 'string' && wtype !== 'void' ? notUnsigned(wtype) : 'ref';
}

// If `wtype` is a boxed nullable primitive (see `nullableWtype`/`ensureBoxType`), its underlying
// scalar kind and box type index; otherwise `undefined` (a real class/array/closure-env-struct, or
// already a bare scalar). Structural (checks `primKind` on the object itself), not a lookup table --
// `registerType`'s structural memoization means an unrelated single-scalar-field struct (e.g. a
// closure's env struct capturing exactly one `f64`) could otherwise coincidentally share a box's
// type index, which a table keyed by type index alone couldn't tell apart.
function unboxedPrimitive(wtype: WasmType): { kind: WasmScalarI; typeIndex: number } | undefined {
	return typeof wtype !== 'string' && 'primKind' in wtype ? { kind: wtype.primKind, typeIndex: wtype.typeIndex } : undefined;
}

function wasmTypeEq(a: WasmType, b: WasmType): boolean {
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
function intWasmType(min: number, max: number): WasmType {
	if (min >= -0x80000000 && max <= 0x7fffffff)
		return 'i32';
	if (min >= 0 && max <= 0xffffffff)
		return 'u32';
	return 'f64';
}

// null parses as a literal; undefined is a real identifier -- both need ref.null with a heap type.
function isNullLiteral(e: Expr): boolean {
	return nullLiteralKind(e) !== undefined;
}

// Which of the two nullish literals `e` is, if either. They share one physical form here (`ref.null`),
// so only a STRICT comparison ever has to tell them apart, and only statically -- see `case '==='`.
function nullLiteralKind(e: Expr): 'null' | 'undefined' | undefined {
	return	e.type === 'literal' && e.value === null			? 'null'
		:	e.type === 'identifier' && e.name === 'undefined'	? 'undefined'
		:	undefined;
}

// Checks builtinTypes before T.resolve to avoid expanding a hoisted class name and losing it.
function wasmTypeOf(t: Type, global: Scope): WasmType | undefined {
	if (t.type === 'ref' && !t.typeArgs && t.name in builtinTypes)
		return builtinTypes[t.name].wtype;
	if (t.type === 'range' && t.base === 'number')
		return t.integer && t.min !== undefined && t.max !== undefined ? intWasmType(t.min as number, t.max as number) : 'f64';
	// rangeToType collapses a single-value range to a Literal -- needs the same bounds check or it widens to f64.
	if (t.type === 'literal' && typeof t.value === 'number')
		return Number.isInteger(t.value) ? intWasmType(t.value, t.value) : 'f64';

	// Resolve each union member first so alias duplicates collapse before arrayElemKind.
	const w = T.widenLiterals(t.type === 'union' ? T.combineTypes(t.types.map(m => T.resolve(global, m))) : T.resolve(global, t), false, true);
	if (w.type === 'array' || (w.type === 'ref' && (w.name === 'Array' || w.name === 'ReadonlyArray'))) {
		const elemType = w.type === 'array' ? w.element : w.typeArgs![0];
		const we = elemType.type === 'ref' && !elemType.typeArgs && (elemType.name === 'i8' || elemType.name === 'u8') ? 'i8'
			: elementKind(wasmTypeOf(elemType, global));
		return we ? ARR_WTYPE[we] : undefined;
	}

	// A tuple's own elements can be heterogeneous, so there's no single per-element wasm kind to pick
	// the way a real array's element type gives one -- physically it's just the same boxed-`anyref`
	// "everything else" storage a mixed/`any`-typed array already uses (`ARR_WTYPE.ref`). The checker
	// already fully tracks each element's own precise type (`type-utils.ts`'s own extensive 'tuple'
	// handling); codegen only needed this one physical-representation mapping, nothing else.
	if (w.type === 'tuple')
		return ARR_WTYPE.ref;

	if (w.type === 'ref')
		return builtinTypes[w.name]?.wtype;

	return undefined;
}

// Stable structural key for memoizing closure-type registration by TS function signature.
function wasmTypeKey(w: WasmType): string {
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

// The one shared `WasmType` a union of >=2 members' own physical representations collapses to --
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
function combineUnionWtypes(wtypes: readonly WasmType[]): WasmType {
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
		// cell (`ensureCellType`, one mutable f64 field) appeared: identical to the immutable `f64` BOX
		// (`ensureBoxType`) under the old key, so a cell became a box and `ref.test` for `typeof x ===
		// 'number'` started matching cells too. `final`/`supertypes` likewise: a subtype is not its base.
		: comp.kind === 'struct' ? `struct(${comp.fields.map(f => `${storageTypeKey(f.type)}:${f.mut}`).join(',')})${'final' in type && type.final ? ':final' : ''}${'supertypes' in type && type.supertypes.length ? ':<' + type.supertypes.join(',') : ''}`
		: undefined;
}


// `defaults`: only ever set for a function TYPE with a bare `p?: T` (optional, no `=`) trailing param --
// see `case 'function'`'s own comment. A closure *literal*'s own params can never be optional (a real,
// separate restriction, unaffected), so this stays `undefined` for every other `FuncSig` producer.
// `resolvedParams`: the same params `defaults` came from, before flattening to bare `WasmType`s --
// only actually needed by `emitCallArgs` when a default value itself reads an earlier parameter
// (`resolveParams`'s own comment) rather than standing alone as a literal. Set for a real user
// function/method/constructor, and for a function TYPE that carries defaults of its own -- which one
// can, since a type derived from a declaration (`typeof f`, a method's type) keeps them.
interface FuncSig					{ params: WasmType[]; result: WasmType; hasRest?: boolean; defaults?: (Expr | undefined)[]; resolvedParams?: ResolvedParam[] }
// A signature with `hasRest`/`defaults` definitely settled -- but `resolvedParams` genuinely absent
// when no default needs it, which is what `emitCallArgs` tests, so it stays optional through `Required`.
type FullSig = Required<Omit<FuncSig, 'resolvedParams'>> & Pick<FuncSig, 'resolvedParams'>;
interface FuncInfo extends FuncSig	{ funcIndex: number; typeIndex: number, body?: wasm.FuncBody; reassignsThis?: boolean }
interface Inline extends FuncSig	{ inline: wasm.Instr[] }
interface MethodDelegate 			{ owner: ClassInfo; method: string }
interface ClosureTypeInfo			{ funcTypeIndex: number; structTypeIndex: number }

// Per-operand info for builtin dispatch -- wtype for kind-polymorphic dispatch, owner for identity dispatch.
interface OperandInfo { wtype: WasmType | undefined; owner?: ClassInfo }
// `typeArgs`: the call site's own type arguments, for an inline whose declared types mention the
// METHOD's own type parameters (`Array._alloc<T>(n): T[]`). Class-level defines are baked once per
// instantiation and cannot carry these -- see `makeAsm`'s `$ret`.
type Builtin<T = Inline | MethodDelegate | FunctionDecl> = (args: OperandInfo[], ctx: FunctionContext, typeArgs?: Type[]) => T

// A `get`/`set` accessor's `methodDecls`/`inlineMethods`/`funcs` key, mangled apart from a plain same-named
// method so a getter and a setter for one property can coexist as two entries instead of overwriting each other.
function accessorKey(kind: 'get' | 'set', name: string): string {
	return `${kind}:${name}`;
}

interface MethodOwner {
	decl:			TS.Class;
	name:			string;
	thisTsType:		Type;
	typeIndex:		number;
	methodDecls:	Map<string, MethodMember[]>;
	inlineMethods?:	Map<string, Builtin<Inline>>;
	// Accessor names -- underlying decl lives under accessorKey('get'|'set', name) in methodDecls/inlineMethods.
	getterNames?:	Set<string>;
	setterNames?:	Set<string>;
	// Where this class was DECLARED -- its own module's scope and canonical path. A method or constructor
	// body compiled from another module needs both to resolve the names its own file declares (a
	// non-exported module-level const, a sibling function): the same `homeScope`/`homeModule` pairing
	// `compileFunc` already gives a top-level function. Absent for a lib class and for a synthesized
	// object shape, which have no declaring module of their own.
	declScope?:		Scope;
	homeModule?:	string;
}

interface ClassInfo extends MethodOwner {
	// `optional`: only ever set for an object-shape's own `key?: T` member (`ensureObjectShape`) -- a real
	// class field is never itself optional (TS requires either a declared initializer or assignment in
	// every constructor path), so every other `fields` producer leaves this `undefined`/falsy.
	fields:			{ name: string; wtype: WasmType; optional?: boolean }[];
	fieldIndex:		Map<string, number>;
	// This class's own real physical `this`-type -- `{ref: name}` for an ordinary struct, or whatever its constructor's own `return` compiles to (`ensureCtor`) -- never guessed from the name.
	// `undefined` only while that constructor is still being compiled (`ownerThisType` falls back to `{ref: name}` then, safe since only a static method's own unused this-type can be in flight).
	thisWtype?:		WasmType;
	// Set once, in `ensureClass`, only for a real `extends`. `fields`/`fieldIndex` are pre-seeded with the
	// superclass's own (in order, so wasm-GC struct subtyping's "subtype's fields are the supertype's
	// fields as an ordered prefix, plus its own appended" requirement holds automatically) -- so most code
	// never needs to walk this chain itself; it exists for the few places that specifically care about the
	// *class* hierarchy (constructor `super(...)` inlining, method-resolution delegation, `super.method()`).
	superClass?:	ClassInfo;
}

// `cellInner`: set only for a name `ensureForwardCell` had to promote into a shared, heap-allocated
// "cell" (a real closure/local forward-referenced by an EARLIER sibling closure in the same block,
// e.g. walker.ts's own `mapStatementC` capturing `mapStatement`, declared several statements later) --
// `wtype` itself is then the *cell's* own physical type (what this storage slot really, physically
// is), and `cellInner` is the logical value's own real type once unboxed. Left `undefined` for the
// overwhelmingly common case (an ordinary local/capture, never forward-referenced), where `wtype`
// alone is the whole story, exactly as before.
interface Local			{ wtype: WasmType, index: number; cellInner?: WasmType; }
interface Global extends Local {init: Expr, mut: boolean}

interface ResolvedParam { key: BindingTarget; wtype: WasmType; tsType: Type }

interface ClosureEnv {
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
interface FinallyGuard {
	actionLocal:				Local;
	breakTargetsLenAtEntry:		number;
	continueTargetsLenAtEntry:	number;
	landingDepth:				number
};

// What a plain `return expr;` actually means here -- ordinarily just "coerce `expr` to `ctx.result`
// and emit a wasm `return`" (`plainReturn`, below), but a generator/async function's own resumable
// step function, a constructor, or a `reassignsThis` method each redefine it (IteratorResult
// protocol, Promise resolution, implicit/appended `this`, ...). Set once by whichever compiler
// routine gives 'return' that meaning (`compileGeneratorFunc`, `compileAsyncFunc`, `ensureCtor`,
// `ensureMethod`), checked by `case 'return'` -- and temporarily swapped out by a `case 'try'` guard
// with a `finally`, which needs the *outer* meaning to reconstruct a real return once `finally` has
// run (see `case 'try'`), not a fresh mechanism of its own.
interface ReturnHandler {
	wtype(ctx: FunctionContext): WasmType | undefined;
	emit(ctx: FunctionContext, argument: Expr | undefined): void;
};

class FunctionContext {
	// Declarations (`declareLocal`/`declareValue`, and `local`'s scratch temps), in declaration order. A name may appear
	// more than once (a closed sibling scope's declaration, or a live nested shadow) -- `lookup` scans
	// from the end and skips closed entries, so a still-open outer binding resurfaces once an inner one closes.
	declared:	{ name: string; local: Local; closed: boolean }[] = [];
	// Watermarks (`declared.length` at open time) for each currently open lexical block -- see `openScope`.
	scopeStack: number[] = [];
	// One entry per real wasm local index (params included); a slot's type is fixed for the whole function,
	// so `freeSlots` (keyed by `wasmTypeKey`) only ever offers back a same-typed index for reuse.
	slotTypes:	WasmType[] = [];
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

	// A one-shot hint for the *very next* expression about to be compiled: the enclosing declaration's
	// own real TS type (e.g. a var_decl's `Expr[]`, or one array literal element's own `Expr`), used
	// only to contextually infer a generic call's own type param when its declared signature has no
	// other way to determine it (`case 'call'`, `ensureGenericFunc`/`inferTypeArgMap` -- mirrors
	// checker.ts's own `expected` vs `sig.returnType` contextual step, which this file's own, separate
	// generic-instantiation codegen doesn't otherwise have access to). Set by the few producers that
	// have a real TS type on hand (`case 'var_decl'`, `case 'array'`'s own per-element loop) and always
	// consumed-then-cleared immediately by whoever reads it (`case 'call'`), so it never leaks into an
	// unrelated sub-expression (a call's own arguments, a nested literal, ...) -- not a general
	// "expected type" channel threaded through every expression, deliberately narrow.
	contextualReturn?:	Type;

	// Set when this FuncCtx is a closure body -- captured names have no real local, reads/writes go through struct.get/set on envLocal.
	closureEnv?:		ClosureEnv;
	// Set when this FuncCtx is a nested `function_decl`'s own body that's allowed to call itself by name
	// -- a call to `name` resolves to a direct, statically-known `call funcIndex` (reusing the same env) instead of going through a closure struct,
	// since the struct being constructed can't/ reference itself while it's still being built. See `emitClosureLiteral`'s `allowSelfCall`.
	selfCall?:			FuncInfo;
	
	// Populated once, right after construction, by `collectRangeWidenings` -- a `let`/`var` declarator whose reassignments push its numeric range wider than its own initializer alone gives
	widenedTypes?:		Map<JS.Var<Type>, Type>;
	// Populated once, right after construction, by `collectDefinePropertyTargets` -- the plain local
	// names (not full scope-aware identity like `widenedTypes`, an accepted simplification) ever used
	// as `Object.defineProperty`'s own target argument anywhere later in this same function body, so
	// that specific declarator can allocate its class's own extension subclass instead of the plain
	// base (`ensureClassExtension`'s own comment) -- not every value of that class, only the one
	// actually extended.
	definePropertyTargets?: Map<string, string[] | 'dynamic'>;

	// This function's own top-level statement list (not descending into a nested closure's own body,
	// same boundary `ownBoundNames`/`collectFreeVars` already use) -- set once, right after construction,
	// alongside `widenedTypes`. Consulted only by `ensureForwardCell`, to find a sibling `const`/`let`
	// declared LATER in this same body that an EARLIER closure literal needs to forward-reference.
	ownBody?:			Stmt[];

	// `collectCapturedMutables(ownBody)`, computed on first use -- see `needsCell`.
	cellNames?:			Set<string>;

	// Updated by `emitStmt`'s own entry point, from each statement's own `(stmt as any).scope` checker
	// stamp (`scopeOfStmt`'s comment) -- `scope` itself stays the one static, whole-function scope set at
	// construction, never written through this. Consulted only by the two real union-member-dispatch
	// fallbacks (`case 'member'`/`case 'index'`) that need a receiver's real *narrowed* type (`switch
	// (m.type) { case 'm1': m.a ...}`) -- every other lookup still goes through `scope` directly, since a
	// lib generic method body's own stamp reflects its unresolved template type params, not the concrete
	// per-instantiation substitution `scope` already carries (`case 'var_decl'`'s own longstanding
	// bypass, just above, hit this same tension first).
	stmtScope?: Scope;
	get typeScope(): Scope { return this.stmtScope ?? this.scope; }

	// Unset for an ordinary function/method/arrow -- `case 'return'` falls back to `plainReturn` in
	// that case. See `ReturnHandler`'s own comment for who sets this and why.
	finallyGuards:		FinallyGuard[] = [];

	// Which loaded module (canonical path, `'.'` for the entry program) this function's own top-level
	// declarations live in -- an unqualified identifier inside its body resolves against *that* module's
	// own declarations, never another module's, even a same-named one. See `homeKey`/`resolveDecl`.
	constructor(public name: string, public scope: Scope, public onReturn: ReturnHandler, public owner?: ClassInfo, public homeModule = '.') {}

	lookup(name: string): Local | undefined {
		for (let i = this.declared.length - 1; i >= 0; i--) {
			const d = this.declared[i];
			if (!d.closed && d.name === name)
				return d.local;
		}
		return undefined;
	}

	private allocLocal(wtype: WasmType): number {
		const free = this.freeSlots.get(wasmTypeKey(wtype));
		return free?.length ? free.pop()! : this.slotTypes.push(wtype) - 1;
	}
	private freeLocal(wtype: WasmType, index: number) {
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
			if (!d.closed) {
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
	temp(name: string, wtype: WasmType): number {
		const prev = this.lookup(name);
		if (prev) {
			if (prev.wtype !== wtype)
				throw `local '${name}' redeclared with different type`;
			return prev.index;
		}
		const index = this.allocLocal(wtype);
		this.declared.push({ name, local: { wtype, index}, closed: false });
		return index;
	}

	declareLocal(name: string, wtype: WasmType): Local {
		const scopeStart = this.scopeStack.at(-1) ?? 0;
		for (let i = this.declared.length - 1; i >= scopeStart; i--) {
			const d = this.declared[i];
			if (!d.closed && d.name === name)
				throw `local '${name}' redeclared (shadowing within the same scope is not supported)`;
		}
		const local = {wtype, index: this.allocLocal(wtype)};
		this.declared.push({ name, local, closed: false });
		return local;
	}

	declareValue(name: string, wtype: WasmType, tsType: Type): Local {
		this.scope.addValue(name, tsType);
		return this.declareLocal(name, wtype);
	}

	// No real wasm local -- storage is a closureEnv struct field.
	declareCaptured(name: string, tsType: Type) {
		this.scope.addValue(name, tsType);
	}

	resolvesName(name: string): boolean {
		return this.lookup(name) !== undefined || !!this.closureEnv?.fields.has(name);
	}

	// The WasmType a name's real, logical VALUE has -- real local/closureEnv field, or (see `Local`'s own
	// comment) a forward-cell's own inner type once unboxed. This is what any ordinary consumer of a
	// name's type wants (e.g. deciding how to *call* it) -- `rawWtype`, below, is the one exception.
	resolvedWtype(name: string): WasmType | undefined {
		const captured = this.closureEnv?.fields.get(name);
		if (captured)
			return captured.cellInner ?? captured.wtype;
		const local = this.lookup(name);
		return local?.cellInner ?? local?.wtype;
	}
	// The WasmType a name's own physical STORAGE slot has -- a forward-cell's own boxed type, never
	// unboxed. Only ever needed by `emitClosureLiteral`'s own env-capture step: capturing a forward-
	// cell's real (shared, mutable) storage into an outer closure's env is the one place that needs the
	// cell ITSELF, not the value it currently (or eventually) holds.
	rawWtype(name: string): WasmType | undefined {
		return this.closureEnv?.fields.get(name)?.wtype ?? this.lookup(name)?.wtype;
	}
	// Destructured params get a hidden #param$<i> local; returns var_decl stmts to bind the real names.
	// `tsTypes` -- the caller already resolved each param's effective `Type` (annotation, or inferred
	// from a default) via `paramType`, to pick `wtypes` in the first place; reused here rather than
	// re-deriving it a second time (which would also need a `checker` this top-level class doesn't have).
	declareParams(params: ResolvedParam[]): JS.Stmt<Type>[] {
		const pending: JS.Stmt<Type>[] = [];
		params.forEach((p, i) => {
			if (typeof p.key === 'string') {
				this.declareValue(p.key, p.wtype, p.tsType);
			} else {
				const tmpName = `#param$${i}`;
				this.declareValue(tmpName, p.wtype, p.tsType);
				pending.push(...patternBindings('let', p.key, { type: 'identifier', name: tmpName }));
			}
		});
		return pending;
	}


	swapOut(out: wasm.Instr[] = []) {
		const _old	= this.out;
		this.out	= out;
		return _old;
	}

	emit(...instr: (wasm.Instr|wasm.Instr[])[]) {
		this.out.push(...instr.flat());
	}

	toFuncBody(numParams: number, toValType: (t: WasmType) => wasm.ValType): wasm.FuncBody & {id: string} {
		return { id: this.name, locals: this.slotTypes.slice(numParams).map(t => ({ count: 1, type: toValType(t) })), body: this.out };
	}

	// Shared by emitGeneratorDispatch/emitAsyncDispatch -- the whole "one dispatch + N nested blocks
	// (innermost = segment 0), wrapped in one outer `loop`" skeleton, exactly the shape `case 'switch'`
	// already lowers a real switch statement to, generalized from "jump to case i" to "jump to resume
	// state i". A 'goto'/'branch' transition (identical either way -- write the new state, `br` back to
	// the dispatch instead of relying on structured block nesting, which a *resumed* call has none of)
	// is handled here directly; 'suspend'/'complete' are each caller's own very different semantics, via
	// `onSuspend`/`onComplete` (both always end in a real wasm `return`, so there's no shared fallthrough
	// case to also provide). `onSegmentStart(id)` runs first, before a segment's own statements -- each
	// caller's own resume-side sent-value write-back, which segments need it and how differing enough
	// (a generator's is unconditional; an async function's is gated to a real Promise suspension only,
	// and needs unboxing `#sent` first) that it isn't shared here either.
	emitResumableDispatch(
		machine:		StateMachine,
		setFrame:		(state: number) => void,
		emitTest: 		(test: Expr) => void,
		onSegmentStart: (segmentId: number) => void,
		onSuspend:		(next: SuspendBoundary, resumeId: number, loopMark: number) => void,
		onComplete:		() => void,
	): void {
		const gotoLoop = (depth: number) => this.emit(I.br(this.depth - depth));
		const loopMark = this.enterLabel();

		this.enterLabel(machine.segments.length);
		this.emit(I.br_table(Array.from({ length: machine.segments.length }, (_, i) => i), 0));

		machine.segments.forEach((seg, k) => {
			this.exitLabel();
			this.emit(I.block(undefined, this.swapOut()));
			onSegmentStart(k);
			const next = seg.next;

			switch (next.type) {
				case 'goto':
					setFrame(next.target);
					gotoLoop(loopMark);
					break;

				case 'branch': {
					emitTest(next.test);
					const old = this.swapOut();
					this.enterLabel();
					setFrame(next.then);
					gotoLoop(loopMark);
					const thenInstrs = this.swapOut();
					setFrame(next.else);
					gotoLoop(loopMark);
					this.exitLabel();
					this.emit(I.if(undefined, thenInstrs, this.swapOut(old)));
					break;
				}
				case 'suspend':
					onSuspend(next, next.resumeId, loopMark);
					break;

				case 'complete':
					setFrame(machine.completeId);
					onComplete();
					break;
			}
		});

		this.exitLabel();	// the outer loop's own label
	}

}


// Qualifies a scratch local's name by its own wtype -- a bare fixed name would collide (`FuncCtx.local`
// throws on a same-name-different-type redeclare) once one function writes to two differently-typed targets.
function scratchName(prefix: string, wtype: WasmType): string {
	return `${prefix}$${wasmTypeKey(wtype)}`;
}

// `as` is a pure pass-through in codegen (`case 'as'` just compiles `e.expression`), but `checkerTypeOf`
// still honors the asserted type -- any codegen-facing type/owner lookup must unwrap it first or it sees a fictional type, wrongly losing method/owner dispatch on the real underlying value.
function unwrapAs(e: Expr): Expr {
	while (e.type === 'as')
		e = e.expression;
	return e;
}

// Whether expression tree `e` references identifier `name` anywhere, not descending into a nested
// arrow/function's own body (closure boundary) -- same idiom as the named-function self-reference
// check a few hundred lines down (`e.type === 'identifier' && e.name === selfName`).
function exprMentionsName(name: string, e: Expr): boolean {
	return walkB(e, undefined, (ex, process) =>
		ex.type === 'identifier' && ex.name === name ? true
		: (ex.type === 'arrow' || ex.type === 'function') ? false
		: process(ex));
}

// Whether `body` assigns to `this` anywhere -- real TS never allows this, so it has exactly one meaning
// here: "this method replaces its own receiver's physical value" (a wasm-GC array/struct can't resize in place). Detected structurally -- any method on any class doing this gets the same treatment, not a hardcoded list.
function assignsToThis(body: Stmt[]): boolean {
	return walkB(body, undefined, (e, process) => e.type === 'binary' && e.operator === '=' && e.left.type === 'this' ? true : process(e));
}


// For error messages only.
function describeBinding(t: BindingTarget): string {
	return typeof t === 'string' ? t : t.type === 'array_pattern' ? '[...]' : '{...}';
}

// ===================================================================
//  Closures -- free-variable analysis
// ===================================================================

function paramNames(params: JS.Param<Type>[], rest?: JS.Rest<Type>): string[] {
	const names = params.flatMap(p => T.bindingNames(p.key));
	return rest ? [...names, ...T.bindingNames(rest.key)] : names;
}

// Every name body binds directly (own params + var_decls), not descending into nested arrow/function bodies.
function ownBoundNames(names: string[], body: Stmt[] | Expr, selfName?: string): Set<string> {
	const bound = new Set(names);
	if (selfName)
		bound.add(selfName);
	// A `for`'s own `init` (e.g. `for (let i = ...)`) reaches this same `var_decl` case too -- walker.ts
	// routes it through the real statement walk, not just a bare declarator walk, so no separate case is
	// needed here to keep a closure's own loop variable from being mistaken for a free (captured) one.
	walkB(body,
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
					T.bindingNames(d.name).forEach(n => bound.add(n));
			}
			return process(s);
		},
		(e, process) => (e.type === 'arrow' || e.type === 'function') ? false : process(e)
	);
	return bound;
}

// Recursively collects free variables into `free`. A nested closure's bound names merge into `bound`
// before recursing, so a level-2 capture of a level-0 variable transitively appears in level-1's set.
function collectFreeVars(bound: Set<string>, body: Stmt[] | Expr, free: Set<string>) {
	walkB(body,
		(s, process) => {
			// Mirrors the `arrow`/`function` expression handling below, but for a nested function
			// *declaration* statement -- its own name is already bound (see `ownBoundNames`), so this only
			// needs to stop descent and collect its body's free vars under its own (merged) bound set.
			if (s.type === 'function_decl') {
				const nestedBody = s.body ?? [];
				collectFreeVars(new Set([...bound, ...ownBoundNames(paramNames(s.params, s.rest), nestedBody, s.name)]), nestedBody, free);
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
				const nestedBody = e.body ?? [];
				collectFreeVars(new Set([...bound, ...ownBoundNames(paramNames(e.params, e.rest), nestedBody, e.type === 'function' ? e.name : undefined)]), nestedBody, free);
				return false;
			}
			return process(e);
		}
	);
}

// Names this body declares that a nested closure captures AND something assigns -- the locals that must
// become shared heap cells rather than plain wasm locals. A closure captures a BINDING in JS, not a
// value: `let n = 1; const f = () => n + 1; n = 4;` must have `f()` see 4, and a write inside the
// closure must be visible outside it (the counter idiom). Copying the value into the env struct gives
// neither. `ensureForwardCell` already builds exactly the right thing -- and `emitClosureLiteral`
// already captures the CELL rather than its contents -- but only ever fired for a name used before its
// own declaration ran, so a local declared before the closure was silently captured by value.
// Deliberately over-approximate: a name assigned anywhere at all (including only inside the closure, or
// only before it is ever captured) is celled, and an outer-scope name reaching the set is harmless
// because the answer is only ever consulted when DECLARING a local of that name here. A needless cell
// costs an allocation and an indirection; a missing one is a wrong answer.
// Not yet applied to a captured+mutated PARAMETER, which has the same problem and no `var_decl` to hang
// the cell off.
function collectCapturedMutables(body: Stmt[]): Set<string> {
	const captured	= new Set<string>();
	const assigned	= new Set<string>();
	// A `for (let i = ...)` binding is PER-ITERATION in JS: every iteration gets a fresh one, so each
	// closure created in the loop captures its own. Copying the value into the env -- what capture already
	// did -- is therefore already right, and one shared cell is actively wrong: every closure would then
	// see the loop's final value. `Promise.all`'s own `promises[i].then(v => { values[i] = v; })` is
	// exactly this, and a shared cell had it writing past the end of `values`.
	// (A body that REASSIGNS the variable after creating the closure still isn't modelled -- that needs a
	// fresh cell per iteration, which is the real general answer.)
	const perIteration = new Set<string>();
	walkB(body,
		(st, process) => {
			// A nested function is a closure boundary: everything free in it is captured from here (or
			// from further out, which is harmless -- an outer name simply isn't one of our locals).
			if (st.type === 'for' && st.init && !Array.isArray(st.init) && st.init.type === 'var_decl') {
				for (const d of st.init.declarations)
					if (typeof d.name === 'string')
						perIteration.add(d.name);
			}
			if (st.type === 'function_decl') {
				const nested = st.body ?? [];
				collectFreeVars(ownBoundNames(paramNames(st.params, st.rest), nested, st.name), nested, captured);
				walkB(nested, undefined, (e, p) => { noteAssignExpr(e, assigned); return p(e); });
				return false;
			}
			return process(st);
		},
		(e, process) => {
			if (e.type === 'arrow' || e.type === 'function') {
				const nested = e.body ?? [];
				collectFreeVars(ownBoundNames(paramNames(e.params, e.rest), nested, e.type === 'function' ? e.name : undefined), nested, captured);
				// ...and assignments INSIDE the closure count too: `() => { n = n + 1; }` is the whole point.
				walkB(nested, undefined, (x, p) => { noteAssignExpr(x, assigned); return p(x); });
				return false;
			}
			noteAssignExpr(e, assigned);
			return process(e);
		}
	);
	return new Set([...captured].filter(n => assigned.has(n) && !perIteration.has(n)));
}

// Every identifier this expression assigns to -- `x = v`, any compound form, and `++`/`--`.
function noteAssignExpr(e: Expr, into: Set<string>) {
	if (e.type === 'binary' && ASSIGN_OPS.has(e.operator) && e.left.type === 'identifier')
		into.add(e.left.name);
	else if ((e.type === 'unary' || e.type === 'unary_post') && (e.operator === '++' || e.operator === '--') && e.operand.type === 'identifier')
		into.add(e.operand.name);
}

// ===================================================================
//  Assembly
// ===================================================================

function assertFlatInstrs(instrs: WAT.WatInstr[], asm: string): wasm.Instr[] {
	return instrs.map(i => {
		//if (i.op === 'block' || i.op === 'loop' || i.op === 'if' || i.op === 'try_table')
		//	throw `inline asm '${asm}': '${i.op}' (control flow) is not supported in inline asm`;
		if (i.op === '__switch')
			throw `inline asm '${asm}': switch '${i.key}' is unresolved -- not a ctx.defines entry, and inline asm has no enclosing macro call to bind it to a $tag argument`;
		if (i.op === '__local')
			throw `inline asm '${asm}': local '${i.id}' should already have been hoisted into a separate locals list`;
		// A `$T.<suffix>` reference with no enclosing `(switch $T ...)` declaring its supported types is a
		// real authoring error, not a type this body happens to support.
		if (i.op === 'local.get' && typeof i.localIndex === 'string' && i.localIndex.startsWith('$T.'))
			throw `inline asm '${asm}': '${i.localIndex}' needs an enclosing '(switch $T ...)' declaring which types it's for`;
		return i;
	});
}

function isAsm(e?: Expr): e is JS.Call<Type> {
	return e?.type === 'call' && e.callee.type === 'identifier' && e.callee.name === '__asm';
}

function isAsmMethod(m: JS.Method<Type>): JS.Call<Type> | undefined {
	if (m.body?.[0]?.type === 'return') {
		const outer = m.body[0].argument;
		if (outer?.type === 'call' && isAsm(outer.callee)) {
			const paramNames = m.params.map(p => typeof p.key === 'string' ? p.key : undefined);
			const argNames = outer.arguments.map(a => a.type === 'identifier' ? a.name : undefined);
			if (paramNames.length === argNames.length && paramNames.every((p, i) => p !== undefined && p === argNames[i]))
				return outer.callee;
		}
	}
}

// `typeParams`/`retIndexOf`: only needed by an asm mentioning `$ret` -- the wasm type index of the asm's
// own DECLARED return type, resolved with the call site's type arguments substituted in. A generic static
// (`Array._alloc<T>(n): T[]`) has no `this` to name, and its `T` is the METHOD's, so no class-level define
// can reach it: `array.new_default $this` allocated the enclosing class's array type for every `T` alike.
// `TYPEINDEX("...")`'s payload: a name followed by any number of `[]`, and deliberately no more --
// `resolveType` can only answer for a ref name or an array of one, so the grammar is bounded by what an
// answer exists for, and anything richer would parse only to fail a step later.
function parseTypeExpr(text: string): Type | undefined {
	const m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*((?:\[\s*\]\s*)*)$/.exec(text);
	if (!m)
		return undefined;
	let t: Type = TS.RefType(m[1]);
	for (let i = m[2].split('[').length - 1; i > 0; i--)
		t = TS.ArrayType(t);
	return t;
}

function makeAsm(call: JS.Call<Type>, defines?: Record<string, string|number>, typeParams?: string[], retIndexOf?: (w: WasmType) => number | undefined): Builtin<Inline> {
	let		asm		= (call.arguments[0] as Literal<string | JS.TemplatePart<Expr>[]>).value;

	if (typeof asm !== 'string') {
		if (Array.isArray(asm)) {
			if (asm.some(p => p.exp !== undefined))
				throw 'inline asm: template-literal interpolation is not supported, only a plain static string';
			asm = asm.map(p => p.str).join('');
		} else {
			throw 'inline asm: expected a string literal';
		}
	}

	const resolveType = (t: Type): WasmType | undefined => {
		if (t.type === 'ref') {
			// An OPEN type parameter, unsubstituted because this call site gave no explicit type
			// arguments. `T[]` already falls back to `arr:ref` here for exactly the same reason; a bare
			// `T` had no fallback at all, so `Array._fill(a, i, x, n)` threw instead of letting the
			// caller below replace it with the argument's real physical type (`isOpen`).
			if (typeParams?.includes(t.name))
				return REF_ANY_NULLABLE;
			switch (t.name) {
				case 'i8': case 'i16':	return 'i32';
				case 'u8': case 'u16':	return 'u32';
				case 'i32': case 'i64': case 'f32': case 'f64': case 'u32': case 'void':
					return t.name;
				case 'number':	return 'f64';
				case 'boolean':	return 'i32';
				case 'string':	return ARR_WTYPE.i16;
				case 'any':		return REF_ANY_NULLABLE;
			}
		}
		if (t.type === 'array') {
			if (t.element.type === 'ref' && TYPED_ARRAY_TAGS.has(t.element.name))
				return ARR_WTYPE[notUnsigned(t.element.name as WasmElement)];
			const arr = notUnsigned(scalarKind(resolveType(t.element)));
			if (arr)
				return {arr};
			return ARR_WTYPE.ref;
		}
		return undefined;
	};

	// The asm's own declared param/result types, resolved with `subs` (the call site's type arguments)
	// applied -- for `__asm<[i32], T[]>` that turns `T[]` into a real element kind instead of the
	// `arr:ref` an unsubstituted `T` falls back to.
	const sigFor = (subs?: Map<string, Type>) => {
		const sub = (t: Type) => subs ? T.substituteType(t, subs) : t;
		const [paramsTuple, resultType] = call.typeArgs ?? [];
		const params = paramsTuple?.type === 'tuple' ? paramsTuple.elements.map(te => {
			const el = T.tupleElementType(te);
			const wt = el && resolveType(sub(el));
			if (!wt)
				throw `unsupported inline-asm param type '${tocode.tupleElement(te)}'`;
			return wt;
		}) : [];
		const result = resultType ? resolveType(sub(resultType)) : 'void';
		if (!result)
			throw `unsupported inline-asm result type '${tocode.type(resultType)}'`;
		return { params, result };
	};

	const parsed = WAT.parseAsmBody(asm, defines);

	// Resolves named scratch locals to real local indices via ctx.local
	const resolveAsmLocals = (instrs: wasm.Instr[], locals: WAT.WatLocal[], ctx: FunctionContext, asm: string): wasm.Instr[] => {
		const indices = new Map(locals.map(l => {
			if (!l.id)
				throw `inline asm '${asm}': an anonymous local can't be referenced by name`;
			if (l.type === 'i32' || l.type === 'i64' || l.type === 'f32' || l.type === 'f64')
				return [l.id, ctx.temp(l.id, l.type)];
			throw `inline asm '${asm}': unsupported local type '${typeof l.type === 'string' ? l.type : 'ref'}'`;
		}));
		return instrs.map(i => {
			if ('localIndex' in i && typeof i.localIndex === 'string') {
				const index = indices.get(i.localIndex);
				if (index === undefined)
					throw `inline asm '${asm}': undeclared local '${i.localIndex}'`;
				return { ...i, localIndex: index };
			}
			return i;
		});
	};

	// A `TYPEINDEX("T[]")` operand, resolved AFTER parsing -- the assembler carried the text through
	// opaquely (it knows nothing of TypeScript types, and `toWasm`'s own note keeps it that way), exactly
	// as it leaves a `$name` for a later pass. The sibling of `resolveAsmLocals`, one operand slot over.
	// `subs`: the call site's type arguments, so `T[]` names a different type at each instantiation.
	const resolveTypeExprs = (instrs: wasm.Instr[], known: Map<string, WasmType>): wasm.Instr[] => {
		// Looked up against the SIGNATURE this call settled on, keyed by the type expression itself (not by
		// position). That matters where a type parameter is still open: `_copy(dst, 0, src, 0, n)` passes no
		// type arguments, so `T[]` alone resolves to the `arr:ref` fallback while the signature has already
		// taken `arr:f64` from the argument -- and an `array.copy` whose operand type disagreed with its
		// operands emitted wasm that would not even encode.
		const resolve = (v: unknown): number | undefined => {
			if (typeof v !== 'string' || !v.startsWith(WAT.TYPE_EXPR))
				return undefined;
			const text = v.slice(WAT.TYPE_EXPR.length);
			const pt = parseTypeExpr(text);
			if (!pt)
				throw `inline asm '${asm}': TYPEINDEX("${text}") is not a name-and-'[]' type expression`;
			const wt = known.get(T.typeKey(pt)) ?? resolveType(pt);
			const index = wt && retIndexOf?.(wt);
			if (index === undefined)
				throw `inline asm '${asm}': TYPEINDEX("${text}") has no wasm type index`;
			return index;
		};
		// Every field a type index can land in -- `array.copy` carries two (`dst`/`src`), not `typeIndex`,
		// and missing them left the sentinel string in place to fail much later as a NaN.
		// Narrowed with `in` before each spread, as `resolveAsmLocals` does: spreading the whole `Instr`
		// union without it is "a union type that is too complex to represent".
		return instrs.map(i => {
			if ('typeIndex' in i) {
				const r = resolve(i.typeIndex);
				if (r !== undefined)
					return { ...i, typeIndex: r };
			}
			if ('dst' in i && 'src' in i) {
				const d = resolve(i.dst), sr = resolve(i.src);
				if (d !== undefined || sr !== undefined)
					return { ...i, dst: d ?? i.dst, src: sr ?? i.src };
			}
			return i;
		});
	};

	// A GENERIC method's asm, or any asm naming a type: both its signature and its type operands depend on
	// the call site's type arguments. Real TS forbids a static from referencing its class's type
	// parameters, so `substituteClassTypeParam` leaves a static alone and its `T` stays genuinely open --
	// no class-level define could stand in for it, and `$this` was exactly the wrong answer a static used
	// to settle for. Parsed ONCE: the type operands are resolved afterwards, not baked in at parse time.
	if (typeParams?.length || asm.includes('TYPEINDEX')) {
		const flat = assertFlatInstrs(parsed.body, asm);
		const locals = parsed.locals.map(l => ({ id: l.id, count: l.count, type: l.type as wasm.ValType }));
		return (args, ctx, typeArgs) => {
			const subs = typeParams?.length && typeArgs?.length ? new Map(typeParams.map((n, i) => [n, typeArgs[i]] as const)) : undefined;
			const base = sigFor(subs);
			// No explicit type arguments (`Array._copy(dst, 0, src, 0, n)`), so those type parameters are
			// still open and `resolveType` can only fall back to `arr:ref` for them. The ARGUMENT in such a
			// position already carries the physical type the callee will receive, so use it -- but ONLY
			// there: a closed position (`start: i32`, `val: T` against an `f64` array) still needs its real
			// declared type, or a coercion `emitInline` would have emitted silently disappears.
			const declared = (call.typeArgs?.[0]?.type === 'tuple' ? call.typeArgs[0].elements : []).map(te => T.tupleElementType(te));
			const isOpen = (t: Type | undefined): boolean => !t ? false
				: t.type === 'ref' ? !!typeParams?.includes(t.name)
				: t.type === 'array' ? isOpen(t.element)
				: false;
			const sig = subs || !typeParams?.length ? base
				: { result: base.result, params: base.params.map((w, i) => isOpen(declared[i]) && args[i]?.wtype ? args[i].wtype : w) };
			// Every declared type this call has an answer for, keyed by the type as written.
			const known = new Map<string, WasmType>();
			declared.forEach((t, i) => { if (t) known.set(T.typeKey(t), sig.params[i]); });
			const retType = call.typeArgs?.[1];
			if (retType)
				known.set(T.typeKey(retType), sig.result);
			return { ...sig, inline: resolveAsmLocals(resolveTypeExprs(flat, known), locals, ctx, asm) };
		};
	}


	const sw = parsed.body.find((i): i is WAT.SwitchPlaceholder => i.op === '__switch' && i.key === '$T');
	if (sw) {
		// All four numeric wasm types, in "widen to me first" preference order when an operand's own type has no
		// real instruction -- f64 first, since widening i32/i64/f32 up to it is exact or an already-accepted tradeoff.
		const NUMERIC_TYPES = ['f64', 'f32', 'i64', 'i32'] as const;
		type NumericType = typeof NUMERIC_TYPES[number];
		function isNumericType(t: WasmType | undefined): t is NumericType { return NUMERIC_TYPES.includes(t as NumericType); }

		//generic case
		const variants: Partial<Record<NumericType, { locals: WAT.WatLocal[]; body: wasm.Instr[] }>> = {};

		for (const type of new Set(sw.arms.flatMap(a => a.values).filter(a => typeof a === 'string').map(a => a.slice(1) as NumericType))) {
			const locals:	WAT.WatLocal[] = [];
			const body:		WAT.WatInstr[] = [];

			const addLocals = (ls: WAT.WatLocal[]) => locals.push(...ls.map(l => ({
				id:		l.id,
				count:	l.count,
				type:	typeof l.type === 'object' && 'typeParam' in l.type ? type : l.type,
			})));

			// A `$T`-keyed switch's winning arm can itself declare `$T`-typed locals (embedded as `__local`
			// markers in its own body, same as everywhere else -- switch_arm never splits them out) and
			// further `$T.suffix` references, processed by recursing back into this same walk, exactly as if
			// the arm's own body were the whole generic body.
			function process(items: WAT.WatInstr[]): boolean {
				for (const i of items) {
					if (i.op === '__local') {
						addLocals([i]);
					} else if (i.op === 'local.get' && typeof i.localIndex === 'string' && i.localIndex.startsWith('$T.')) {
						const oper = i.localIndex.slice('$T.'.length);
						if (!(oper in I[type]))
							return false;
						body.push((I[type] as any)[oper] as WAT.WatInstr);
					} else if (i.op === '__switch' && i.key === '$T') {
						const tag = `$${type}`;
						const arm = i.arms.find(a => a.values.includes(tag));
						if (!arm)
							return false;
						if (!process(arm.body))
							return false;
					} else {
						body.push(i);
					}
				}
				return true;
			}

			addLocals(parsed.locals);
			if (!process(parsed.body))
				throw `inline asm '${asm}': switch arm '(${sw.arms.find(a => a.values.includes(`$${type}`))!.values.join(' ')})' claims '${type}' but its own body doesn't resolve for it`;
			variants[type] = { locals, body: assertFlatInstrs(body, asm) };
		}
		if (!Object.keys(variants).length)
			throw `inline asm '${asm}': switch '$T' has no arms`;

		const paramCount = call.typeArgs?.[0]?.type === 'tuple' ? call.typeArgs[0].elements.length : 0;

		return (args, ctx) => {
			let t = args[0]?.wtype;
			if (!isNumericType(t) || !variants[t] || args.length !== paramCount || !args.every(a => a.wtype === t)) {
				t = NUMERIC_TYPES.find(nt => variants[nt]);
				if (!t)
					throw 'no numeric type supports this operation';
			}
			const parsed = variants[t]!;
			return { params: Array(paramCount).fill(t), result: t, inline: resolveAsmLocals(parsed.body, parsed.locals, ctx, asm) };
		};

	} else {
		// A param/result type that isn't a plain wasm primitive is this owner's own array type or one element of it -- `elemKind` (its real physical storage) is authoritative for both, checked *before* the name switch below:
		// a bare `T` substituting to e.g. `string` is still physically boxed `{ref:'any'}` like every other non-scalar element, not a real `{arr:'i16'}`.

		const body = {
			locals: parsed.locals.map(l => {
				if (typeof l.type === 'object' && 'typeParam' in l.type)
					throw `inline asm '${asm}': '(local ${l.id ?? ''} $${l.type.typeParam})' needs a '$T'-generic asm`;
				return { id: l.id, count: l.count, type: l.type };
			}),
			body: assertFlatInstrs(parsed.body, asm)
		};
		const { params, result } = sigFor();
		return (_args, ctx) => ({ params, result, inline: resolveAsmLocals(body.body, body.locals, ctx, asm) });
	}
}

// Substitutes a generic class's own single type parameter (`PARAM`) for `subs` throughout its decl -- shared
// by `builtinOwner` and `ensureClass`. `thisTsType`, when given, also substitutes a `T[]`-shaped member type for the whole instantiation itself -- specific to `Array<T>`'s own shape, ordinary callers omit it.
function substituteClassTypeParam(decl: JS.ClassDecl<Type>, map: ReadonlyMap<string, Type>): JS.ClassDecl<Type> {
	const out = walk(decl, undefined, undefined, (t, process) =>
		t.type === 'ref' && map.has(t.name) ? map.get(t.name) : process(t)
	)!;
	// A STATIC member is restored verbatim: real TS forbids one from referencing its class's type
	// parameters at all ("Static members cannot reference class type parameters"), so substituting into
	// one can only ever corrupt something -- and what it corrupted was a static's OWN type parameter of
	// the same name. `Array<any>`'s `_alloc<T>(n): T[]` was rewritten to `any[]`, so it allocated
	// `arr:ref` whatever it was called with, and `$ret` never had a chance to resolve it.
	// Order is structural, so `out.body[i]` is `decl.body[i]` throughout.
	out.body = out.body.map((m, i) => hasMod(decl.body[i] as { modifiers?: string[] }, 'static') ? decl.body[i] : m);
	return out;
}

// General N-type-param substitution, for a generic top-level function/method's own type params -- unlike
// `substituteClassTypeParam` (one name, re-invoked once per class type param), takes every substitution at
// once via a plain `Map`, one `walk` pass regardless of how many type params `node` has. Also unlike a
// class reference (`Box<number>`, always an explicit type argument at the use site), unifies both the
// explicit-type-args and inferred-from-arguments cases: the caller resolves `map` either way (see
// `ensureGenericFunc`), this just applies it structurally through params/return type/body alike.
function substituteTypeParams<N extends Walkable>(node: N, map: ReadonlyMap<string, Type>): N {
	return walk(node,
		// `checkStmt`'s own `(stmt as any).scope ??= scope` stamp (checker.ts) is a plain, enumerable
		// property set once, during the *original*, unsubstituted (generic-level, `T` still opaque)
		// check of this function's body -- `walk`'s own `mapObject` primitive copies it along verbatim,
		// same reference, onto every rebuilt statement here, still pointing at the stale generic-level
		// scope (where a type parameter like `N` never resolved to the real per-call-site argument
		// type). Stripped here so `stmtScope = (s as any).scope ?? ctx.scope` (towasm.ts's own read of
		// it) correctly falls back to `ctx.scope` -- the *real*, per-instantiation scope this exact
		// monomorphization builds via `declareParams` -- instead of silently re-deriving a type through
		// the substituted body's own values via a scope that never learned about the substitution at
		// all (found via `walker.ts`'s own self-hosting attempt: `{...node}` inside a generic function
		// resolved `node`'s type as the bare, unsubstituted type parameter itself). Trades away
		// whatever flow-narrowing the generic-level check had already computed for this statement --
		// accepted: it could only ever have narrowed the type parameter itself, never the concrete
		// per-instantiation type this compiled body actually needs.
		(s, process) => { const built = process(s); delete (built as any).scope; return built; },
		undefined,
		(t, process) => t.type === 'ref' && map.has(t.name) ? map.get(t.name)! : process(t)
	)!;
}

// `Uint8Array`/`Int32Array`/`Uint32Array` are real generic instantiations of `TypedArray<T>`
// (`lib/typedarray.ts`, reached through `ensureClass`'s alias resolution -- see its own comment), a struct
// wrapping a real GC byte-array `ArrayBuffer`, so they skip `ensureArrayType`'s own monomorphization entirely.
//
// `class` names which real lib class backs a primitive-level type, resolved lazily through `ensureClass`
// (`builtinTypeOwner`) for all of them alike; `Boolean` simply has none (no decl exists at all).
const builtinTypes: Record<string, { wtype: WasmType; class?: string }> = {
	void:		{ wtype: 'void' },
	// No `class` -- `any` has no single owner to dispatch a method call against (`ensureAnyDispatch` handles
	// that dynamically); this entry only gives a genuinely `any`-typed local/param/field a real `WasmType` (`REF_ANY`) so it doesn't fail to compile the moment it's declared.
	any:		{ wtype: REF_ANY },
	// `unknown` has no dedicated physical representation of its own -- same boxed storage as `any` (the
	// checker's own `T.isAny` already treats the two alike), just without `any`'s implicit-assignability
	// laxness on the *checking* side, which doesn't affect codegen at all.
	unknown:	{ wtype: REF_ANY },
	boolean:	{ wtype: 'i32', 			class: 'Boolean' },
	Boolean:	{ wtype: 'i32', 			class: 'Boolean' },
	number:		{ wtype: 'f64', 			class: 'Number' },
	Number:		{ wtype: 'f64', 			class: 'Number' },
	string:		{ wtype: ARR_WTYPE.i16,		class: 'String' },
	String:		{ wtype: ARR_WTYPE.i16,		class: 'String' },
	bigint:		{ wtype: ARR_WTYPE.i32,		class: 'BigInt' },
	// Pseudo-types from `lib.d.ts` (`declare type i32 = number`, etc) -- real wasm value types, for a field/method whose storage isn't the usual `number`->`f64` mapping (see `lib/typedarray.ts`'s `Uint8Array`).
	// `class: 'Number'` because that is exactly what each one is an alias OF: without it a value that
	// happened to get a storage refinement had no method owner at all, so `let i = 0; i.toString()`
	// failed as "unknown method" where `const n: number = 0; n.toString()` worked.
	i32:		{ wtype: 'i32',				class: 'Number' },
	i64:		{ wtype: 'i64',				class: 'Number' },
	f32:		{ wtype: 'f32',				class: 'Number' },
	f64:		{ wtype: 'f64',				class: 'Number' },
	u32:		{ wtype: 'u32',				class: 'Number' },
};

const UNARY_OP_NAMES = {
	'-':	'neg',
	'~':	'not',
	'++':	'inc',
	'--':	'dec',
} as const;
const BINARY_OP_NAMES = {
	'+':	'add',
	'-':	'sub',
	'*':	'mul',
	'/':	'div',
	'%':	'mod',
	'**':	'pow',
	'&':	'and',
	'|':	'or',
	'^':	'xor',
	'<<':	'shl',
	'>>':	'shr_s',
	'>>>':	'shr_u',
	'==':	'eq',
	'===':	'eq',
	'!=':	'ne',
	'!==':	'ne',
	'<':	'lt',
	'>':	'gt',
	'<=':	'le',
	'>=':	'ge',
} as const;

// Every entry is a real callable (a plain lib function hands back its own `FunctionDecl`, see `emitCall`).
// `Math.abs`/`Array.alloc`/etc aren't here -- registered into each owner's own `inlineMethods` instead (`builtinOwner`).
const builtins: Record<string, Builtin> = {
	...Object.fromEntries(LIB_DECLS.filter(d => d.type === 'function_decl').filter(d => d.body).map(d => [d.name, () => d])),
	...Object.fromEntries(LIB_DECLS.filter(d => d.type === 'var_decl').map(d => {
		const name = d.name as string;
		if (isAsm(d.init)) {
			const builtin = makeAsm(d.init, {});
			return builtin && [name, builtin] as const;
		}
	}).filter(e => !!e)),
};

interface AssignTarget { wtype: WasmType; old?: number; write(tee: boolean): number }

function genericKey(name: string, typeParams: readonly TS.TypeParam[], map: Map<string, Type>, scope: Scope) {
	return `${name}<${typeParams.map(p => T.typeKey(T.resolve(scope, map.get(p.name)!))).join(',')}>`;
}

// A `const name = (...) => ...` (or `= function(...) {...}`) at the top level is, for this
// compiler's purposes, exactly as callable-by-name as a real `function` declaration -- it can
// never be reassigned, so there's no dynamic-value story to model, just a named entry point.
// But nothing here recognized that shape at all: it fell through to being compiled as an
// ordinary top-level local (a real closure value assigned into a `__toplevel`-scoped slot),
// invisible to every other top-level function's own `emitCall` lookup (`functionDeclByName`).
// Promoted the same way a `function_decl` already is; `promotedConsts` then keeps the
// `__toplevel` body below from *also* compiling it as a wasted local closure.
function arrowOrFunctionToDecl(name: string, e: JS.Arrow<Type> | JS.FunctionExpr<Type>): FunctionDecl {
	return {
		type: 'function_decl', name,
		params: e.params, rest: e.rest, typeParams: e.typeParams, returnType: e.returnType,
		body: Array.isArray(e.body) ? e.body : e.body !== undefined ? [{ type: 'return', argument: e.body }] : [],
	};
}

interface LocalField { index: number; wtype: WasmType; tsType: Type }

// For every `let`/`var` declarator with no explicit annotation, widens the numeric range beyond
// what its own initializer alone gives, by unioning in every later reassignment provably safe to
// fold in -- `var_decl`'s own codegen otherwise picks a local's wasm storage type purely from its
// initializer, so e.g. `let scale = 1; ...; scale = scale * 4294967296;` inside a loop gets typed
// `i32` and silently wraps at runtime; unioning in every reassignment's own range catches that.
//
// Classification per reassignment:
//  - `x++`/`x--`/`x += <int literal>`/`x -= <int literal>`/`x = x +- <int literal>`: exempt, no
//    range change -- preserves today's accidentally-correct behavior for ordinary loop counters.
//  - self-referential (RHS/compound operand mentions `x`) and inside a loop: give up, mark fully
//    unbounded. Always safe -- f64 exactly represents every integer up to 2^53, so falling back to
//    it never loses correctness, only the narrow-type optimization.
//  - self-referential but not inside a loop (executes at most once, no compounding risk): union in
//    the RHS's own range.
//  - not self-referential (`x = freshExpr`, doesn't mention `x`): always safe to union in,
//    regardless of loop nesting -- no dependency on `x`'s own prior value, so no compounding.
//
// Built on `walkB`, matching `ownBoundNames`/`collectFreeVars`'s own idiom -- every hook here only
// ever relays `process(x)`'s own result, or `false` at a closure boundary, never intentionally
// `true` as a signal (see walkB's own doc comment in walker.ts for why that matters). Scope
// open/close is expressed as "do work, call `process(s)`, do more work with what it returns" --
// `for`'s own init declarator opens via the ordinary `case 'var_decl'` handling below it (walker.ts
// routes a `for`'s `init` through the real statement walk, so that case fires for it same as any
// other `var_decl`), while `case 'for'` itself just bounds the loop variable's scope, same as a
// shared `try`/`catch`/`finally` scope (three separate `Statement[]` fields, not wrapped in their
// own `block` nodes) gets handled with the same mark/close primitive as an ordinary `block`.
//
// One accepted imprecision: a `for`'s `init`/`test`/`update`/`body` are all visited within one
// `process(s)` call, so `loopDepth` can't be incremented for only part of it -- an assignment to
// some *other*, already-open variable sitting in the `init` clause itself (e.g. `for (let i = (x =
// 5); ...)`) is (rarely, harmlessly) treated as "inside the loop" even though `init` only runs
// once. Safe (only causes extra conservative widening, never incorrect narrowing).
//
// Known limitation: does not scan reassignments made from inside a nested closure body (mirrors
// ownBoundNames/collectFreeVars's own closure-boundary stop, needed there for correctness) -- a
// captured `let` mutated only via a closure write keeps today's (possibly too-narrow) behavior.
function collectRangeWidenings(body: Stmt[], scope: Scope): Map<JS.Var<Type>, Type> {
	interface OpenTarget { d: JS.Var<Type>; range?: T.NumRange; touched: boolean }
	const open: OpenTarget[] = [];
	const result = new Map<JS.Var<Type>, Type>();
	let loopDepth = 0;

	const findOpen = (name: string) => {
		for (let i = open.length - 1; i >= 0; i--)
			if (open[i].d.name === name)
				return open[i];
	};
	const contribute = (o: OpenTarget, r: T.NumRange | undefined) => {
		o.touched = true;
		o.range = r && o.range ? T.rangeUnion(o.range, r) : undefined;
	};
	function openDecl(d: JS.Var<Type>) {
		if (typeof d.name !== 'string' || d.typeAnnotation || !d.init)
			return;
		const seed = T.toRange(checkerTypeOf(d.init, scope));
		if (seed && seed.base === 'number')
			open.push({ d, range: seed, touched: false });
	}
	function looped<T>(fn: ()=>T): T {
		loopDepth++;
		const r = fn();
		loopDepth--;
		return r;
	}
	function scoped<T>(fn: ()=>T): T {
		const mark = open.length;
		const r = fn();
		while (open.length > mark) {
			const o = open.pop()!;
			if (o.touched)
				result.set(o.d, o.range ? T.rangeToType(o.range) : T.NUMBER);
		}
		return r;
	}
	// "Small" means it can't itself push a value out of i32 range -- despite the name, this previously only
	// checked `Number.isInteger`, exempting `i = i + 3000000000` (a real out-of-i32-range literal) from
	// widening too, silently overflowing `i`'s wasm local once reassigned.
	const isSmallIntLit = (x: Expr) => x.type === 'literal' && typeof x.value === 'number' && Number.isInteger(x.value) && x.value >= -0x80000000 && x.value <= 0x7fffffff;

	return scoped(() => { walkB(body,
		(s, process) => {
			switch (s.type) {
				case 'block': case 'switch': case 'try':
					return scoped(() => process(s));
				case 'var_decl': {
					const r = process(s); // visits each declarator's own init first
					if (s.kind === 'let' || s.kind === 'var')
						s.declarations.forEach(openDecl); // open AFTER, so init can't self-reference
					return r;
				}
				case 'do_while': case 'while':
					return looped(()=> process(s));
				case 'for':
					return scoped(()=> looped(() => process(s)));
				default:
					return process(s);
			}
		},
		(e, process) => {
			if (e.type === 'arrow' || e.type === 'function')
				return false; // separate FuncCtx, own pre-pass
			if (e.type === 'binary' && ASSIGN_OPS.has(e.operator) && e.left.type === 'identifier') {
				const o = findOpen(e.left.name);
				if (o) {
					const op = e.operator;
					const isExempt = ((op === '+=' || op === '-=') && isSmallIntLit(e.right))
						|| (op === '='
							&& e.right.type === 'binary'
							&& (e.right.operator === '+' || e.right.operator === '-')
							&& e.right.left.type === 'identifier' && e.right.left.name === e.left.name
							&& isSmallIntLit(e.right.right)
						);
					if (!isExempt)
						contribute(o,
							op === '=' ? (loopDepth > 0 && exprMentionsName(e.left.name, e.right) ? undefined : T.toRange(checkerTypeOf(e.right, scope)))
						:	op === '??=' || loopDepth > 0 ? undefined // every other compound op is self-referential by definition
						:	T.toRange(checkerTypeOf({ type: 'binary', operator: op.slice(0, -1), left: e.left, right: e.right } as Expr, scope))
					);
				}
			}
			return process(e);
		}
	); return result; });
}

// `Object.defineProperty(target, key, {value, ...})` -- the one real, general escape hatch for
// dynamically attaching a property to an otherwise fixed-shape value (see `ensureClassExtension`'s
// own comment for how this compiles). Matched structurally (a `call` through `Object.defineProperty`
// by name), not by any special-cased identifier elsewhere -- this is the one and only place that
// shape is recognized.
function isDefinePropertyCall(e: Expr): e is JS.Call<Type> & { callee: JS.Member<Type> } {
	return e.type === 'call' && e.callee.type === 'member' && e.callee.object.type === 'identifier'
		&& e.callee.object.name === 'Object' && e.callee.property === 'defineProperty';
}

// Whole-body presence check only -- used before a generic function's own substituted body ever starts
// compiling, to decide (conservatively, across every one of its own type arguments at once, not
// which specific one) whether `everExtended` needs poking *now*, before any of them could possibly
// get `ensureClass`'d and their own struct type finalized first (`ensureGenericFunc`'s own comment).
function containsDefineProperty(body: Stmt[]): boolean {
	return walkB(body, undefined, (e, process) => isDefinePropertyCall(e) || process(e));
}

// The plain local names (see `FunctionContext.definePropertyTargets`'s own comment on why this is
// name-based, not full scope-aware identity like `collectRangeWidenings`) ever used as
// `Object.defineProperty`'s own target argument anywhere in this function body, together with the
// literal keys ever defineProperty'd onto each -- `'dynamic'` once any one of them isn't a compile-
// time-literal string, since a non-enumerable key set can't be given real, individually-named fields
// at all (`ensureClassExtension`'s own comment).
function collectDefinePropertyTargets(body: Stmt[]): Map<string, string[] | 'dynamic'> {
	const targets = new Map<string, string[] | 'dynamic'>();
	walkB(body, undefined, (e, process) => {
		if (isDefinePropertyCall(e)) {
			const target = e.arguments[0];
			if (target?.type === 'identifier') {
				const existing = targets.get(target.name);
				if (existing !== 'dynamic') {
					const keyExpr = e.arguments[1];
					if (keyExpr?.type === 'literal' && typeof keyExpr.value === 'string') {
						const keys = existing ?? [];
						if (!keys.includes(keyExpr.value))
							keys.push(keyExpr.value);
						targets.set(target.name, keys);
					} else {
						targets.set(target.name, 'dynamic');
					}
				}
			}
		}
		return process(e);
	});
	return targets;
}

// Builds the `Scope` holding every lib declaration `TStoWasm` needs (`String`, `RegExpMatch`, ...),
// rooted in a fresh `T.makeGlobal()`, not in any particular user program's own scope -- callers pass
// the *same* returned `Scope` to both `TStypeCheck`/`TStypeCheckAsync` (as `libScope`, so user code is
// checked with lib members already in view -- a scope only sees its own ancestors, so a user program's
// `global` needs the lib scope as an actual ancestor, not a sibling branch) and `TStoWasm` (which needs
// it directly too, e.g. to compile a lib method's own body in isolation from user-declared names).
// A throwaway `makeChecker` instance here is fine -- `Scope` is plain data, not tied to whichever
// checker instance populated it, so this result is equally usable by any later, separate instance.
// Muted, deliberately (its diag sink is a no-op either way) -- but no longer skips walking a declared-
// return-type lib method's body outright the way it once did. That used to be an all-or-nothing choice:
// walking+stamping fixed narrowing-dependent bodies (`String.split`'s `m.groupStart(0)`) but broke every
// GENERIC lib class method (`Array<T>.reverse`/`.fill`/...), since the stamp left behind was the template's
// own, with `T` still unresolved, and `??=` first-wins then blocked the real, per-instantiation substituted
// scope from ever overriding it. Resolved at the source instead (`Scope.isGenericTemplate`, checker.ts):
// a generic class's own instance scope is flagged, and `checkFunctionBody`/`checkStmt` skip *just* their
// `fn.scope`/`(stmt as any).scope` stamps under that flag while still performing the walk -- so
// `applyContextualParams`'s param-typing side effect (needed for e.g. `lib/map.ts`'s `entries()`, whose
// `.map()` callback params previously never got typed at all) now runs for every lib method, generic or
// not, while a generic method's body still falls back to `ctx.scope` at codegen time, same as before.
// `methodOwner`'s special-case in `var_decl` (below) is still worth keeping regardless -- it reads a
// method's return type directly off the class decl without needing `checkerTypeOf` at all, which remains
// the cheaper path for that one, common shape.
export function makeLibScope(): Scope {
	const libScope = new Scope;
	checkBlock(LIB_AST, libScope);
	return libScope;
}

// `modules`: every other loaded module (canonical path -> its own top-level statements) reachable from
// `ast` -- built by the caller (see `module-loader.ts`'s `collectModules`) via the same `ModuleLoader` the
// checking pass already resolved against, since `TStoWasm` has no loader of its own and no async boundary
// to load one lazily. `namedImports`: for each module (by canonical path, keyed the same way), its own
// plain `import { foo } from '...'` (or `import { foo as bar } from '...'`) bindings -- the *local* name
// maps to `{module, name}`, the target module's own canonical path plus the name it's actually declared
// under there (which may differ from the local alias). An `import * as X from '...'` needs no such map:
// the checker already binds `X` to the target module's own `Scope` (`Scope.addNamespace`), which carries
// both the declarations (`Scope.decl`) and, via `stmtHomeModule`, which module each came from.
// Only top-level *functions* are seeded/resolved across modules this way today -- a cross-module class or
// scalar global reference is still unsupported (throws a clear, unrelated error), a real, separate,
// not-yet-attempted follow-on.
// `onTopLevelError`: when given, a top-level statement that fails to compile is REPORTED through this
// and skipped, instead of failing the whole module. Every top-level statement shares one start function,
// so without it a single unrepresentable module-level `const` takes every other declaration in the file
// down with it -- which is exactly what made the self-hosting survey attribute ~35 declarations to
// whichever module-level statement happened to fail first. Omitted (the CLI's case) it rethrows, since a
// module whose initialisation silently didn't run is not something to hand back without comment.
export function TStoWasm(ast: TS.Program, modules?: Map<string, TS.Stmt[]>, namedImports?: Map<string, Map<string, { module: string; name: string }>>, onTopLevelError?: (e: unknown) => void): wasm.WasmModule {
	const global = ast.scope as Scope;
	if (!global)
		throw new TSWError('ast must be checked (TStypeCheck/TStypeCheckAsync) before TStoWasm');

	// `global` (`ast.scope`) already has every lib declaration (`String`, `RegExpMatch`, ...) reachable
	// via its own ancestor chain, when the caller passed `makeLibScope()`'s result into `TStypeCheck` --
	// same object used here as `libGlobal`, not a bare `libScope` parameter: a lib-only scope would sever
	// that chain and hide every *user* declaration from anything built off it (`ctx.scope`, in particular)
	// -- confirmed real, not just theoretical, this way once (`Point`/`Wrapper` field lookups broke).
	// This also matches the old behavior: `libGlobal` here was never actually isolated from user names
	// either (it was always `new Scope(global)`, i.e. `global` was always its own ancestor too).
	const libGlobal			= global;

	const classes			= new Map<string, ClassInfo>();
	// User-declared *generic* top-level classes can't be eagerly seeded into `classes` under their bare name
	// (no single physical representation for `Box<T>` alone, only each concrete instantiation) -- `ensureClass`/`resolveGenericClassRef` look here instead, the user-class equivalent of `LIB_DECL_MAP`.
	const userGenericClassDecls = new Map<string, JS.ClassDecl<Type>>();

	const funcs				= new Map<string, FuncInfo>();
	const functionDeclByName = new Map<string, FunctionDecl>();
	let nextFunc			= 0;

	// Every module reachable from `ast`, entry included under the same `'.'` canonical `TStypeCheckAsync`'s
	// own `entrySrc` uses -- `functionDeclByName`'s own keys stay bare (unmangled) for the entry module
	// (zero behavior change from before multi-file support existed); a non-entry module's top-level
	// functions are stored under `homeKey(canonical, name)` instead, so a same-named function in two
	// different files never collides in this (or `funcs`') shared cache.
	const moduleBodies			= new Map<string, TS.Stmt[]>([['.', ast.body], ...(modules ?? [])]);
	// That module's own scope: the entry carries it on its `Program`, an imported body gets it stamped by
	// `exportScope` (see `compileFunc`'s own note on why a body needs one at all).
	function moduleScopeOf(homeModule: string): Scope | undefined {
		return homeModule === '.' ? global : (moduleBodies.get(homeModule) as (TS.Stmt[] & { scope?: Scope }) | undefined)?.scope;
	}

	// Where each module really lives: the loader stamps it on an imported body (`collectModules`), and the
	// ENTRY's own comes off the `Program`, which its caller stamps the same way it already stamps `scope`.
	function moduleFilename(homeModule: string): string | undefined {
		return homeModule === '.'
			? (ast as TS.Program & { filename?: string }).filename
			: (moduleBodies.get(homeModule) as (TS.Stmt[] & { filename?: string }) | undefined)?.filename;
	}
	const namedImportsByModule = namedImports ?? new Map<string, Map<string, { module: string; name: string }>>();
	// Recovers a top-level statement's own home module string -- `Scope.decl(name)` (via `declScope`, or via
	// `Scope.namespace` for an `import * as X`) gives back the real declaration object directly, but a
	// declaration alone doesn't say which file it came from, and a plain `var_decl` (unlike a function/class,
	// both already `homeKey`-scoped via `functionDeclByName`/per-module `classes`) has no module-scoped
	// registration at all. Consumers needing to compile a cross-module reference correctly (a
	// namespace-qualified call's own target module, `ensureLazyGlobal`'s own `FunctionContext.homeModule`)
	// pair the two. Populated once, below, in the same pass that already visits every module's own statements.
	const stmtHomeModule		= new Map<TS.Stmt, string>();
	// The entry module's top-level `const`/`let` declarators, by name -- see the `moduleBodies` scan's own
	// comment on why `Scope.decl` can't answer this for the entry module.
	const topLevelVars			= new Map<string, { stmt: TS.Stmt; d: JS.Var<Type> }>();
	// The backing slot of each `ensureLazyGlobal` wrapper, so a WRITE can reach the same storage the
	// wrapper reads. Keyed exactly like `lazyGlobals`.
	const lazyGlobalSlots		= new Map<string, { index: number; wtype: WasmType }>();

	function homeKey(homeModule: string, name: string) {
		return homeModule === '.' ? name : homeModule + '\0' + name;
	}

	// `const f = __asm<[...], R>('...')` declared in a USER module. `builtins` is built once, at module
	// scope, from `LIB_DECLS` -- so the shorthand only ever bound inside `lib/*.ts` proper, and the same
	// declaration in the ENTRY module (never mind an imported one) failed as "call to unknown function".
	// Keyed by module: the binding is that module's own, exactly like a top-level function's.
	const moduleAsmBuiltins = new Map<string, Builtin<Inline>>();
	for (const [moduleId, body] of moduleBodies) {
		for (let s of body) {
			if (s.type === 'export_decl')
				s = s.declaration;
			if (s.type !== 'var_decl')
				continue;
			for (const d of s.declarations) {
				if (typeof d.name === 'string' && isAsm(d.init))
					moduleAsmBuiltins.set(homeKey(moduleId, d.name), makeAsm(d.init, {}));
			}
		}
	}
	// The one place an unqualified (or namespace-resolved) name turns into a `FunctionDecl` -- a lib
	// declaration is always homeModule-independent, checked only after the calling module's own.
	function resolveDecl(homeModule: string, name: string) {
		return functionDeclByName.get(homeKey(homeModule, name)) ?? LIB_DECL_MAP.get(name);
	}
	// True for a name that resolves without ever needing a closure capture slot -- a plain top-level
	// function or a real wasm global, both always reachable from anywhere via the same ordinary
	// `case 'identifier'` fallback chain, regardless of lexical nesting.
	function resolvesGlobally(homeModule: string, name: string): boolean {
		return globals.has(name) || LIB_DECL_MAP.get(name)?.type === 'var_decl' || !!resolveDecl(homeModule, name)
			|| !!namedImportsByModule.get(homeModule)?.has(name)
			// A NAMESPACE import (`import * as TS from './ts-parser'`) binds a compile-time namespace, not a
			// value -- every use is resolved at its own site, so it never needs a capture slot either. Only
			// named imports were listed here, so `TS.parse(...)` inside a callback read as a free variable
			// and threw "unresolved identifier 'TS'".
			|| !!moduleScopeOf(homeModule)?.namespace(name)
			// Same reasoning again for the ENTRY module's own top-level `const`/`let`: it becomes a real
			// global (or an `ensureLazyGlobal` wrapper), so every use resolves at its own site and it never
			// needs a capture slot. `hoist` deliberately doesn't hoist a plain top-level `var_decl` into a
			// scope, so `resolveDecl` above cannot see one -- `topLevelVars` is where they live, and without
			// this a closure referencing one read as a free variable ("unresolved identifier 'LIB_DIR'").
			|| (homeModule === '.' && topLevelVars.has(name));
	}

	const worklist:			(()=>void)[] = [];
	const lateWorklist: 	(()=>void)[] = [];
	const anyDispatchFuncs	= new Map<string, FuncInfo>();
	// `ensureAnyIn`'s own cache -- keyed by the property name alone, since its candidate set is exactly
	// `anyDispatchFuncs`' "every class ever reached" and so depends on nothing else.
	const anyInFuncs		= new Map<string, FuncInfo>();
	// `ensureAnyField`'s own cache -- same "every class ever reached" candidate set as `anyInFuncs`, so the
	// field name alone keys it too.
	const anyFieldFuncs		= new Map<string, FuncInfo>();
	// `ensureUnionFieldDispatch`'s own cache -- keyed by field name + the exact, bounded member set (not
	// "every class ever reached" like `anyDispatchFuncs`), so a real union type's own field access never
	// silently succeeds via some unrelated third class that happens to share the same field name.
	const unionFieldDispatchFuncs = new Map<string, FuncInfo>();
	// `ensureUnionIndexDispatch`'s own cache -- same "keyed by the exact, bounded member set" reasoning as
	// `unionFieldDispatchFuncs`, just for `arr[i]` reads instead of `.property` access.
	const unionIndexDispatchFuncs = new Map<string, FuncInfo>();
	// A plain named function used as a *value* (not a direct call) -- `case 'call'` already resolves
	// `name(...)` straight to `funcs.get(name)`/`compileFunc`, no closure struct involved at all, so
	// this is only ever populated the first time some *other* expression shape needs `name` to behave
	// like an ordinary closure value (passed as a callback, assigned, returned, ...). One shared
	// zero-capture wrapper per function name, not one per use site.
	const functionValueWrappers = new Map<string, FuncInfo>();
	// A closure *value* whose own concrete signature has a narrower/nullable-mismatched result than
	// some slot it's being coerced into (real TS covariant-return assignability, e.g. `(x: number) =>
	// number` fitting `(x: number) => number | undefined`) -- one shared coercing trampoline per
	// (source signature, wanted result) pair, not one per use site. See `ensureClosureCoercionWrapper`.
	const closureCoercionWrappers = new Map<string, { info: FuncInfo; wantStructTypeIndex: number; envTypeIndex: number }>();

	const closureLiterals: FuncInfo[] = [];
	const closureWasmTypes	= new Map<string, WasmType>();	// The `{closure: FuncSig}` wrapper object itself, memoized per signature
	const closureTypes		= new Map<string, ClosureTypeInfo>();
	let closureCallTempCounter	= 0;

	let data				= new Uint8Array(0);
	const strings			= new Map<string, number>;
	const globals			= new Map<string, Global>;
	// `ensureLazyGlobal`'s own wrapper `FuncInfo`s, keyed the same `homeKey` way as `funcs` itself.
	const lazyGlobals		= new Map<string, FuncInfo>;

	let forTempCounter			= 0;
	let destructureTempCounter	= 0;
	let optionalTempCounter 	= 0;
	let switchTempCounter		= 0;
	let defaultArgTempCounter	= 0;

	const types: wasm.SubType[] = [];
	const typeMap			= new Map<string, number>();
	function addType(type: wasm.SubType): number {
		return types.push(type) - 1;
	}
	function registerType(type: wasm.SubType): number {
		const key		= wTypeKey(type);
		const existing	= key !== undefined ? typeMap.get(key) : undefined;
		if (existing !== undefined)
			return existing;
		const typeIndex = addType(type);
		if (key !== undefined)
			typeMap.set(key, typeIndex);
		return typeIndex;
	}

	const arrayTypeDesc = (kind: WasmElementI): wasm.SubType =>
		({ final: true, supertypes: [], type: { kind: 'array', field: { type: kind === 'ref' ? { ref: 'any', nullable: true } : kind, mut: true } } });

	function ensureArrayType(kind: WasmElementI): number {
		return registerType(arrayTypeDesc(kind));
	}

	// "Does this module already have this array type" WITHOUT creating it -- `ensureArrayType` would
	// register one as a side effect, and a candidate scan asking speculative questions must not add types
	// nothing uses. If the type is absent, no value of that kind exists to reach an `any` slot anyway.
	function hasArrayType(kind: WasmElementI): boolean {
		const key = wTypeKey(arrayTypeDesc(kind));
		return key !== undefined && typeMap.has(key);
	}
	function ensureBoxType(kind: WasmScalarI): number {
		return registerType({ final: true, supertypes: [], type: { kind: 'struct', fields: [{ type: kind, mut: false }] } });
	}

	// One project-wide exception tag, `(anyref) -> ()` -- JS/TS `catch(e)` is untyped and catches any thrown value regardless of its real TS type, so there's no reason for more than one tag
	const tags: wasm.TagType[] = [];
	let exceptionTagIndex: number | undefined;
	function ensureExceptionTag(): number {
		if (exceptionTagIndex === undefined)
			exceptionTagIndex = tags.push({ attribute: 0, typeIndex: registerFuncType(toParams([REF_ANY]), []) }) - 1;
		return exceptionTagIndex;
	}

	function nullableWtype(base: WasmType): WasmType {
		if (typeof base !== 'string')
			return { ...base, nullable: true };
		// Every scalar kind, not just `f64`/`i32`: a box is a one-field struct and there is nothing
		// special about the field's type. The restriction meant an `i64` module-level `const` in an
		// imported module had nowhere to live (its `ensureLazyGlobal` slot is a nullable box), which is
		// why `lib/node/fs.ts` had to write its WASI rights masks as functions returning literals.
		// `notUnsigned`: `u32`/`u64` are the same physical value as their signed twins (`coerceTop`
		// treats the pair as identical), so they share one box rather than registering a duplicate type.
		if (base === 'void')
			throw "a nullable 'void' value is not supported -- 'void' has no value representation to box";
		const kind = notUnsigned(base);
		return { typeIndex: ensureBoxType(kind), nullable: true, primKind: kind };
	}

	// A real, shared, mutable one-field struct wrapping `wt` (nullable, so it can start empty) -- used
	// only by `ensureForwardCell` for a name forward-referenced by an earlier sibling closure. Unlike
	// `ensureBoxType` (an immutable, unboxes-a-scalar-into-`anyref` box), this cell's own field is `mut`
	// and can hold any wtype (including an already-reference-typed one, e.g. a closure) -- what makes it
	// a real shared cell is that both the enclosing function's own later write (its var_decl) and every
	// closure that captured a reference to this same struct instance see the identical storage.
	// Memoized by `registerType`'s own structural key, same as any other type here -- one physical cell
	// type per distinct inner wtype, regardless of how many different forward-referenced names share it.
	// The field has to be DEFAULTABLE (`struct.new_default` allocates the cell empty, before the
	// declaration that fills it has run), which for a reference means nullable. A scalar is already
	// defaultable and must stay RAW: `nullableWtype` would box it, and then `cellInner` -- which every
	// read and write of a celled name trusts as the logical type -- would describe the box rather than
	// the value. Only ever reference cells existed until captured mutables started using these.
	function ensureCellType(wt: WasmType): number {
		return registerType({ final: true, supertypes: [], type: { kind: 'struct', fields: [{ type: toValType(typeof wt === 'string' ? wt : nullableWtype(wt)), mut: true }] } });
	}

	// A closure referencing a SIBLING const/let declared LATER in the same enclosing block (mutually-
	// recursive local closures -- e.g. walker.ts's own `mapStatementC` capturing `mapStatement`) has no
	// local for that name yet when `emitClosureLiteral`'s own free-var check runs. Real JS/TS allows
	// this (the reference is only ever actually read once the closure is CALLED, well after every
	// sibling has initialized) -- but the ordinary "copy the CURRENT value into this closure's own env
	// struct at CREATION time" capture (`emitRawSlot`) has no value to copy yet. Generates the missing
	// local right here, on demand (not a whole-block pre-scan), as a real `ensureCellType` cell instead
	// of a plain local: both this closure's own capture (holding a reference to the cell) and the name's
	// own real var_decl (writing into the cell once it runs, `case 'var_decl'`'s own check) end up
	// sharing the exact same storage, so the value becomes visible the moment it's actually assigned --
	// correct regardless of which order the two statements happen to compile in.
	// `ctx.scope` (towasm's own, incrementally-built scope -- unlike the checker's, which already knows
	// every sibling regardless of order) hasn't seen `name` yet either at this point, so its own real
	// type is found the same way `ownBoundNames`/`collectFreeVars` already scope a forward search: a
	// shallow scan of `ctx.ownBody`'s own top-level `var_decl`s (never descending into a nested closure --
	// a DIFFERENT function's own locals are never this function's siblings). Only a plain, single-name
	// declarator is handled (a destructured forward reference is a separate, rarer case, not attempted).
	// Returns `undefined` (leaving the existing "unresolved identifier" throw to fire) for a name that
	// isn't a sibling declaration at all -- a genuinely unresolvable name, not a forward reference.
	function ensureForwardCell(ctx: FunctionContext, name: string): Local | undefined {
		const d = ctx.ownBody?.flatMap(s => s.type === 'var_decl' ? s.declarations : []).find(d => d.name === name);
		if (!d)
			return undefined;
		const tsType = d.typeAnnotation ?? (d.init && checkerTypeOf(d.init, ctx.scope));
		if (!tsType)
			return undefined;
		const wt = typeOf(tsType);
		return wt ? declareCell(ctx, name, wt, tsType) : undefined;
	}

	// Reads a cell's contents, given the cell reference already on the stack. A reference cell's field is
	// nullable because `struct.new_default` has to be able to allocate it empty, but `cellInner` is the
	// logical (non-null) type every consumer works with -- so the read unwraps. Sound by the same
	// contract forward cells already rely on: the declaration that fills the cell always runs before any
	// read of the name can.
	function emitCellRead(cellType: number, inner: WasmType, ctx: FunctionContext) {
		ctx.emit(I.struct.get(cellType, 0));
		if (typeof inner !== 'string' && !inner.nullable)
			ctx.emit(I.ref.as_non_null);
	}

	// Promotes `name` to a shared, heap-allocated one-field cell -- the physical form a captured BINDING
	// needs, so that a write from either side of the capture is seen by the other.
	function declareCell(ctx: FunctionContext, name: string, wt: WasmType, tsType: Type): Local {
		if (process.env.DBGCELL)
			console.error(`CELL ${ctx.name}.${name}`);
		const cellTypeIndex = ensureCellType(wt);
		const local = ctx.declareValue(name, { typeIndex: cellTypeIndex, nullable: false }, tsType);
		local.cellInner = wt;
		ctx.emit(I.struct.new_default(cellTypeIndex), I.local.set(local.index));
		return local;
	}

	// Memoized per function: which of this body's own locals a nested closure captures AND something
	// assigns (`collectCapturedMutables`). Those must be cells, not plain wasm locals.
	function needsCell(ctx: FunctionContext, name: string): boolean {
		// Never at module scope: a top-level binding is already shared by construction (a real wasm global,
		// or `ensureLazyGlobal`'s slot), and every function reads it that way rather than through any
		// capture. Celling one there would leave the global and the cell as two separate storages.
		if (!ctx.ownBody || ctx.ownBody === ast.body)
			return false;
		ctx.cellNames ??= collectCapturedMutables(ctx.ownBody);
		return ctx.cellNames.has(name);
	}

	function toResults(result: WasmType): wasm.ValType[] {
		return result === 'void' ? [] : [toValType(result)];
	}
	function toParams(params: WasmType[]): wasm.ParamType[] {
		return params.map(p => ({ type: toValType(p) }));
	}
	function toParams2(params: ResolvedParam[]): wasm.ParamType[] {
		return params.map((p) => ({ type: toValType(p.wtype), id: typeof p.key === 'string' ? p.key : undefined }));
	}
	function registerFuncType(params: wasm.ParamType[], results: wasm.ValType[]) {
		return registerType({ final: true, supertypes: [], type: { kind: 'func', params, results } });
	}
	function registerFuncAtType(typeIndex: number) {
		return { funcIndex: nextFunc++, typeIndex };
	}
	function registerFunc(params: wasm.ParamType[], results: wasm.ValType[]) {
		return registerFuncAtType(registerFuncType(params, results));
	}
	// Zero-field, non-`final` struct -- the common supertype every closure literal's env struct is a subtype
	// of (wasm-GC width-subtyping needs the supertype's fields as a prefix, vacuous with zero fields); also usable directly as the env value for a no-capture literal.
	// The one supertype every closure value struct declares. Sound by wasm-GC's covariant immutable-field
	// subtyping: a closure's own first field is `(ref $itsFuncType)`, and every func type is a subtype of
	// the abstract `func`. That makes `ref.test (ref $closureBase)` exactly "is this value a function" --
	// nominal, so no unrelated struct can match it however its fields happen to line up.
	function ensureClosureBase(): number {
		return registerType({ final: false, supertypes: [], type: { kind: 'struct', fields: [
			{ type: { ref: 'func', nullable: false }, mut: false },
			{ type: { ref: ensureEnvBase(), nullable: false }, mut: false },
		] } });
	}

	function ensureEnvBase(): number {
		return registerType({ final: false, supertypes: [], type: { kind: 'struct', fields: [] } });
	}

	function builtinTypeOwner(name: string) {
		const bt = builtinTypes[name];
		return bt?.class ? ensureClass(bt.class) : undefined;
	}

	function ensureGlobal(name: string, wtype: WasmType, init: Expr, mut: boolean) {
		if (!globals.has(name))
			globals.set(name, {wtype, index: globals.size, init, mut});
		return globals.get(name)!;
	}

	// A top-level `const X = someFactory(...)` (a real, non-foldable call expression, not a compile-time
	// constant `ensureGlobal` already handles, and not `function_decl`-shaped either -- the pervasive
	// declarative-DSL idiom this whole grammar-spec pair is built from: `export const Rule =
	// makeRule<any>(...)`, `terminal(...)`, `Rules(...)`, ...) has no wasm-level representation at all until
	// something actually calls the factory. Real wasm globals can only be initialized from a compile-time
	// constant, so this can't just become an eagerly-initialized global the way a foldable const does --
	// lazy-on-first-use instead (the user's own explicit call over eager cross-module init ordering): a real
	// mutable, nullable global starts `null`; a tiny wrapper function checks it once per program run,
	// computing and caching the real value on the first call, returning the cached value on every one after.
	// `d`/`declScope`: the declarator and its own declaring scope, both from `Scope.decl`'s new lookup
	// (`hoist()`'s `exportScope` loop stamps `addDecl` for exactly this shape) -- `d.init` is compiled with
	// `declScope` as this wrapper's own home scope, so any name it references (another lazy global, a
	// sibling function) resolves against ITS OWN declaring module, not the caller's.
	function ensureLazyGlobal(name: string, homeModule: string, d: JS.Var<Type>, declScope: Scope): FuncInfo | undefined {
		// `const f = __asm<[...], R>('...')` DECLARES a builtin; it holds no value. A lazy global here makes
		// the wrapper evaluate the initializer -- really trying to CALL `__asm`. Guarded at this level, not
		// in `lazyGlobalFor`, because `case 'call'`'s own closure-valued-const path reaches this directly.
		// `undefined` lets the reference fall through to `moduleAsmBuiltins`, where the binding actually is.
		if (d.init && isAsm(d.init))
			return undefined;
		const key = homeKey(homeModule, name);
		const existing = lazyGlobals.get(key);
		if (existing)
			return existing;

		const checkedType = declScope.value(name);
		// `typeOf` has no answer for a bare anonymous object shape (only a named class, an index signature
		// or an all-call-signature one) -- give it the same synthesized struct an object literal targeting
		// that shape already gets, or a `const D: {a: number} = {...}` has no representation to cache into.
		const resolved = checkedType && T.resolve(global, checkedType);
		const wt = (checkedType && typeOf(checkedType))
			?? (resolved?.type === 'object' ? ownerThisType2(ensureAnonObjectShape(resolved)) : undefined);
		if (!wt || wt === 'void' || !d.init)
			return undefined;
		const slotName = `$lazy$${key}`;
		const g = ensureGlobal(slotName, nullableWtype(wt), { type: 'identifier', name: 'undefined' }, true);
		lazyGlobalSlots.set(key, g);

		const { funcIndex, typeIndex } = registerFunc([], toResults(wt));
		const info: FuncInfo = { params: [], result: wt, funcIndex, typeIndex };
		lazyGlobals.set(key, info);
		worklist.push(withCatch(() => {
			const ctx = new FunctionContext(name, new Scope(declScope), plainReturn(wt), undefined, homeModule);
			// Hand-emitted, not `emitStmt`/AST-synthesized like most of this file's other desugarings --
			// `wtypeOf`/`checkerTypeOf` (used throughout ordinary codegen to re-derive an expression's own
			// static type) can't see `slotName` at all, since it was never real source the checker ever
			// type-checked; only `d.init` itself (real source) goes through the ordinary, checker-aware
			// `emitAs`. `if (slot === null) slot = <init>; return slot!;`
			ctx.emit(I.global.get(g.index), I.ref.is_null);
			const old = ctx.swapOut();
			emitAs(d.init!, ctx, g.wtype);
			ctx.emit(I.global.set(g.index));
			ctx.emit(I.if(undefined, ctx.swapOut(old)));
			// `coerceTop`, not a bare `ref.as_non_null`: `nullableWtype` BOXES a scalar slot, so for an
			// `i32`/`f64` const the slot holds a box while this wrapper's signature promises the scalar.
			ctx.emit(I.global.get(g.index));
			coerceTop(g.wtype, ctx, wt);
			ctx.emit(I.return);
			info.body = ctx.toFuncBody(0, toValType);
		}, name, homeModule));
		return info;
	}

	// A module-level `const`/`let` whose value isn't a wasm compile-time constant (an array, object, string,
	// `new`, or call), resolved to its `ensureLazyGlobal` wrapper AND the slot that wrapper caches into: the
	// wrapper is the only correct way to READ one (it runs the initializer exactly once, on first use), the
	// slot the only way to WRITE one. `Scope.decl` answers for an imported module; `topLevelVars` for the
	// entry module, which `exportScope` never stamps.
	const ownerThisType2 = (cls: ClassInfo | undefined) => cls && ownerThisType(cls);

	// A class REFERENCE written as an expression -- a bare name, or a namespace-qualified one (`T.Scope`,
	// through an `import * as T`) -- resolved to the class's own name plus the scope to look it up in. A
	// qualified reference resolves in the NAMESPACE's own scope, not the caller's, so the class's field and
	// method types resolve against its declaring module and both names land on the same physical class.
	function classRefTarget(e: Expr, scope: Scope, seen?: Set<string>): { name: string; scope: Scope } | undefined {
		if (e.type === 'identifier')
			return scope.decl(e.name)?.type === 'class_decl' ? { name: e.name, scope } : classAliasTarget(e.name, scope, seen);
		if (e.type === 'member' && e.object.type === 'identifier') {
			const ns = scope.namespace(e.object.name);
			if (ns?.decl(e.property)?.type === 'class_decl')
				return { name: e.property, scope: ns };
		}
		return undefined;
	}

	// A top-level `const X = C` / `const X = T.C`. A class has no runtime value here (classes are nominal,
	// never first-class objects), so such a const is a compile-time alias rather than a global to evaluate:
	// `ensureClass` resolves through it to the real declaration and `__toplevel` emits nothing for it.
	// `Scope.decl` answers for an imported module, `topLevelVars` for the entry module (`hoist` deliberately
	// doesn't hoist a plain top-level `var_decl`, so it never reaches a scope) -- the same pair `lazyGlobalFor`
	// uses. `seen` guards a self- or mutually-referential chain (`const A = B; const B = A;`).
	function classAliasTarget(name: string, scope: Scope, seen = new Set<string>()): { name: string; scope: Scope } | undefined {
		if (seen.has(name))
			return undefined;
		seen.add(name);
		const varStmt	= scope.decl(name);
		const d			= varStmt?.type === 'var_decl' ? varStmt.declarations.find(v => v.name === name) : topLevelVars.get(name)?.d;
		return d?.init ? classRefTarget(d.init, scope, seen) : undefined;
	}

	// `scope`: where to resolve `name` -- the reading function's own by default, or an `import * as NS`
	// namespace's own scope for an `NS.name` read, which is the same module-level const reached by its
	// qualified name (`case 'member'`).
	function lazyGlobalFor(name: string, ctx: FunctionContext, scope: Scope = ctx.scope) {
		const varStmt	= scope.decl(name);
		const own		= varStmt?.type === 'var_decl'
			? { stmt: varStmt as TS.Stmt, d: varStmt.declarations.find(d => d.name === name) }
			: scope === ctx.scope ? topLevelVars.get(name) : undefined;
		if (!own?.d)
			return undefined;
		const homeModule	= stmtHomeModule.get(own.stmt) ?? ctx.homeModule;
		const wrapper		= ensureLazyGlobal(name, homeModule, own.d, scope);
		const slot			= lazyGlobalSlots.get(homeKey(homeModule, name));
		return wrapper && slot ? { wrapper, slot } : undefined;
	}

	// A top-level `const` that is only another name for something already declared elsewhere: a class
	// (`const Scope = T.Scope`) or a cross-module binding (`const I = wasm.I`). Such a declaration has no
	// module-init effect of its own -- every read of it resolves through `ensureClass`/`lazyGlobalFor` to
	// the real declaration -- so the start function emits nothing for it. Evaluating it there would instead
	// demand a physical representation for the referenced value in EVERY module that declares such an
	// alias, whether or not anything in it ever reads the name.
	function isAliasInit(e: Expr, scope: Scope): boolean {
		// `const JSBinary = Binary<Expr, binaryOps>` -- naming a generic declaration with explicit type
		// arguments is still just naming it.
		if (e.type === 'instantiation')
			return isAliasInit(e.expression, scope);
		// `const f = __asm<[...], R>('...')` DECLARES a builtin (`moduleAsmBuiltins`); there is no value to
		// evaluate, and the start function trying to call `__asm` is exactly the "unknown function" it got.
		return isAsm(e)
			|| !!classRefTarget(e, scope)
			|| (e.type === 'identifier' && scope.decl(e.name)?.type === 'function_decl')
			|| (e.type === 'member' && e.object.type === 'identifier' && !!scope.namespace(e.object.name));
	}

	function addData(newdata: Uint8Array, align = 1): number {
		const adjust = data.byteLength % align;
		const offset = data.byteLength + (adjust ? align - adjust : 0);
		const total	= offset + newdata.byteLength;
		
		if (data.buffer.byteLength < total) {
			const buffer = new Uint8Array(Math.max(data.buffer.byteLength * 2, total));
			buffer.set(data, 0);
			data = buffer.subarray(0, total);
		}
		data = new Uint8Array(data.buffer, 0, total);
		data.set(newdata, offset);
		return offset;
	}

	function internString(value: string): number {
		const existing = strings.get(value);
		if (existing !== undefined)
			return existing;
		// UTF-16LE, not `TextEncoder`'s UTF-8 -- `emitStringConst` builds the `i16`-element array straight
		// from these bytes via `array.new_data`, so they need to already be one 16-bit code unit each (matching `charCodeAt`).
		const bytes = new Uint8Array(value.length * 2);
		const view = new DataView(bytes.buffer);
		for (let i = 0; i < value.length; i++)
			view.setUint16(i * 2, value.charCodeAt(i), true);
		const offset = addData(bytes, 2);
		strings.set(value, offset);
		return offset;
	}

	function withCatch(item: ()=>void, ...scopes: string[]) {
		return () => {
			try {
				item();
			} catch (e) {
				throw new TSWError(e as any, undefined, ...scopes);
			}
		};
	}

	// Every class declaration in the whole program (lib + user, generic + not), scanned once for a plain
	// named `superClass` reference -- shared by two things that each need "the whole program's inheritance
	// graph" known up front, before any lazy per-class resolution begins: `ensureClass`'s `final` flag
	// (wasm-GC requires a struct type be declared `final: false` to ever be usable as another's
	// `supertypes` entry -- can't be decided lazily/after the fact once a class's own type is registered)
	// and a virtual-dispatch cascade's own candidate set (does ANY class anywhere in the program actually
	// override a given method -- if not, a plain direct call stays correct and optimal, exactly as without
	// inheritance at all). Keyed by the bare declared name (never a generic instantiation's composite key)
	// -- `extends Box`/`extends Box<T>` both reference the same bare name a subclass search needs.
	const directSubclasses	= new Map<string, TS.Class[]>();
	const everExtended		= new Set<string>();

	// A base class name's own real, statically-enumerable `Object.defineProperty` keys (or `'dynamic'`
	// once any of them isn't a literal), accumulated across every declarator anywhere in the program
	// that's ever *actually* allocated as the extended form (populated at each such `var_decl`'s own
	// compile time, once its real resolved class is known -- see `case 'var_decl'`'s own comment).
	// `ensureClassExtension` reads this lazily, the first time this specific base class's own extension
	// is ever needed, keyed the same bare-name way `everExtended` itself is.
	const pendingExtensions = new Map<string, string[] | 'dynamic'>();
	// One synthesized extension subclass per base class name, memoized -- `ensureClassExtension`'s own comment.
	const classExtensions	= new Map<string, ClassInfo>();

	// Whether *any* class textually declared anywhere in the program, transitively extending `className`,
	// declares its own (non-static) `methodName` member -- decided purely from `directSubclasses` (whole-
	// program source text, known complete up front), not from `classes`'s own lazily/incrementally
	// populated instantiation set. This is what a method-call site checks (`emitMethodCall`) to decide
	// whether it needs `ensureVirtualDispatch`'s cascade at all: if nothing overrides `methodName` anywhere
	// reachable from `className`, a plain direct call (`ensureMethod`, walking up to whichever ancestor
	// actually defines it) is already correct and optimal, exactly as without inheritance -- the common
	// case, meant to stay just as cheap as it always was. Memoized: a call site re-asks this for the same
	// `(className, methodName)` pair often (every call to that method, anywhere in the program).
	const declaredOverrideCache = new Map<string, boolean>();
	function hasDeclaredOverride(className: string, methodName: string): boolean {
		const key = `${className}.${methodName}`;
		let cached = declaredOverrideCache.get(key);
		if (cached === undefined) {
			cached = (directSubclasses.get(className) ?? []).some(sub => sub.body.some(m => m.type === 'method' && m.key === methodName && !hasMod(m, 'static')) || hasDeclaredOverride(sub.name!, methodName));
			declaredOverrideCache.set(key, cached);
		}
		return cached;
	}

	// A structural `{[k: string]: V}` index-signature-only object type -- no nominal class of its own,
	// so it gets no owner/physical representation through any of the ordinary paths at all otherwise.
	// Routed to `Map<string, V>` rather than a bespoke backing class: same hash-table storage, and
	// every operation a dynamic object needs (`get`/`set` already free via the generic index-syntax
	// convention `case 'index'` uses for any class -- see its own comment -- plus `delete`/`has`/`keys`
	// for `delete obj[k]`/`k in obj`/`for...in obj`) already exists there. A real user-facing `{}`/
	// bracket/`delete`/`in`/`for...in` stays genuine syntax -- this is purely a shared-implementation
	// choice, invisible to the source being compiled.
	function indexSignatureValueType(w: Type): Type | undefined {
		if (w.type !== 'object' || w.members.length !== 1)
			return undefined;
		const m = w.members[0];
		return m.type === 'index' && m.paramType.type === 'ref' && m.paramType.name === 'string' ? m.typeAnnotation : undefined;
	}

	// The raw {params, result, hasRest, defaults} for one `TS.CallSig`-shaped signature -- shared by a bare
	// function TYPE (`case 'function'`, below) and each individual member of a genuinely overloaded object
	// type (`mergeOverloadSigs`, below): both are the exact same shape (`TS.TypeCall`'s own `TypeCall()`
	// constructor just wraps a `CallSig` with `{type:'call', ...sig}`), so building each overload's own
	// physical signature reuses this identical generic-substitution/optional-param/anon-return-type logic,
	// not a second copy of it. Returns `undefined` only when the return type genuinely can't be represented
	// at all (never silently drops a param -- an unrepresentable param type still throws, same as before).
	function closureSigParts(sig: TS.CallSig): FullSig | undefined {
		// See `emitClosureLiteral`'s own identical comment (this is the type-annotation-side twin of that
		// expression-side case, e.g. a `const redo: <T extends U>(t?: T) => T` binding, or a generic closure
		// passed through a function's own return type) -- same bound substitution, same free-when-bounded
		// reasoning.
		let func = sig;
		if (func.typeParams?.length) {
			const map = new Map(func.typeParams.map(p => [p.name, p.constraint ?? T.ANY]));
			func = { ...func, typeParams: undefined, params: func.params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteType(p.typeAnnotation, map) } : p), returnType: func.returnType && T.substituteType(func.returnType, map) };
		}
		// Naming the whole signature, not just the parameter: one of these reaches a caller from some
		// enclosing declaration's own type, and the parameter name alone rarely says which.
		const sigText = () => T.typeKey({ type: 'function', ...sig } as Type);
		// Names to this parameter's own LEFT, so a default that reads an earlier one (`dstScope = scope`)
		// validates exactly as it does on the declaration side (`resolveParams`).
		const earlier = new Set<string>();
		const params = func.params.map(p => {
			// A default is NOT a reason to reject a function type. `defaultsWithImplicitUndefined` below
			// hands the very same expression to every call site, exactly as a direct call to the real
			// declaration already gets it -- so the only requirement is the one the declaration path
			// (`resolveParam`) already imposes: that the expression can be re-emitted there.
			if (p.default && !isReemittableDefault(p.default, earlier))
				throw `function type parameter '${describeBinding(p.key)}''s default value must be a literal, an array literal of them, or a read of an earlier parameter, in '${sigText()}'`;
			if (typeof p.key === 'string')
				earlier.add(p.key);
			// `void` is real, valid TS here (real TS lets a param/field declare `void`, if uselessly) --
			// there's just no wasm value it can itself represent, so box it as `any` like any other
			// "no meaningful value" position instead of rejecting otherwise-valid source.
			const wt = p.typeAnnotation && typeOf(p.typeAnnotation);
			const boxed = wt === 'void' ? REF_ANY : wt;
			if (!boxed)
				throw `function type parameter '${describeBinding(p.key)}': '${p.typeAnnotation ? T.typeKey(p.typeAnnotation) : '<no annotation>'}' has no representation, in '${sigText()}'`;
			// A bare `p?: T` (optional, no `=`) widens to `T | undefined` for real TS -- give it a
			// nullable physical slot so an omitted trailing arg's synthesized implicit-`undefined`
			// default (`defaultsWithImplicitUndefined`, below) is a valid value through `call_ref`.
			// A defaulted one is the opposite and keeps its plain type: the call site fills the declared
			// default in, so the slot always holds a real value. Same rule `resolveParam` uses for a real
			// function declaration -- and it has to be the same, or the two physical signatures disagree.
			// (The checker marks a defaulted param `optional` too, hence testing `p.default` first.)
			return !p.default && hasMod(p, 'optional') ? nullableWtype(boxed) : boxed;
		});
		const defaults = defaultsWithImplicitUndefined(func.params);
		// Only a default that reads an earlier parameter needs these, and only then does the memo key below
		// have to distinguish parameter NAMES -- the substitution `emitCallArgs` does is by name.
		const resolvedParams = func.params.some(p => p.default && !isReemittableDefault(p.default))
			? func.params.map((p, i) => ({ key: p.key, wtype: params[i], tsType: p.typeAnnotation! }))
			: undefined;
		let hasRest = false;
		if (func.rest?.typeAnnotation) {
			const wt = typeOf(func.rest.typeAnnotation);
			if (!wt || wt === 'void')
				throw "a function type's rest parameter needs an explicit array type";
			params.push(wt);
			hasRest = true;
		}
		let result = func.returnType ? typeOf(func.returnType) : 'void';
		// A function TYPE's return position (as opposed to a value's own inferred type -- `typeOf`'s
		// general 'object' case deliberately doesn't attempt this, see `ensureAnonObjectShape`'s own
		// comment) is a genuine declared-type position: an inline `{value: T; consumed: number}`
		// return annotation, never given a name via `interface`/`type X = ...`, is still real TS and
		// still needs *some* physical representation. Scoped narrowly to exactly this spot (not a
		// general `typeOf` fallback) specifically to avoid colliding with a NAMED type that lost its
		// own `ref` wrapper somewhere upstream (e.g. `T.combineTypes` flattening a union of one
		// nominal class into its bare structural shape) -- that already-regressed once when tried as
		// a general fallback; a function type's own return annotation never has this ambiguity, since
		// nothing upstream of `typeOf` here strips a name off it.
		if (!result && func.returnType) {
			const returnResolved = T.resolve(global, func.returnType);
			if (returnResolved.type === 'object' && !indexSignatureValueType(returnResolved)) {
				const cls = ensureAnonObjectShape(returnResolved);
				result = cls && ownerThisType(cls);
			}
		}
		if (!result)
			return undefined;
		return { params, result, hasRest, defaults, resolvedParams };
	}

	// A genuinely overloaded VALUE type (every member of an object type is a 'call' signature, e.g. real
	// TS's own multi-signature-object representation of an overloaded declaration) -- real TS overloads
	// are a type-checking-only fiction: there is always exactly one real underlying function at runtime, no
	// per-call-site dispatch (unlike a NAMED function-declaration *group*, which `resolveOverload` already
	// handles for real, since there each overload genuinely can share one common implementation body found
	// by name). A plain VALUE has no name to look up multiple declarations by, and no way to have two
	// different physical closures underneath one wasm value either way -- so this merges every overload's
	// own physical signature (each built via `closureSigParts`, above -- same generic-substitution/optional-
	// param handling as a single function type) into ONE, position by position: a param present in every
	// overload keeps its own type (boxed `any` if it genuinely varies in kind across overloads); one
	// missing from some but not all becomes optional/nullable, matching a real omittable trailing arg (the
	// common case -- one overload a strict prefix of another). Confirmed against a real case (js-parser.ts's
	// `Rule`, from tison.ts's `makeRule`): its own local `rule` overload group erases to exactly this shape
	// at runtime -- one implementation, one optional trailing param.
	function mergeOverloadSigs(sigs: FullSig[]): FullSig | undefined {
		if (!sigs.length)
			return undefined;
		const maxParams = Math.max(...sigs.map(s => s.params.length));
		const params: WasmType[] = [];
		const defaults: (Expr | undefined)[] = [];
		for (let i = 0; i < maxParams; i++) {
			const present = sigs.filter(s => s.params.length > i);
			const distinct = new Set(present.map(s => wasmTypeKey(s.params[i])));
			const shared = distinct.size === 1 ? present[0].params[i] : REF_ANY;
			if (present.length < sigs.length) {
				params.push(nullableWtype(shared));
				defaults.push({ type: 'identifier', name: 'undefined' });
			} else {
				params.push(shared);
				defaults.push(undefined);
			}
		}
		const resultKinds = new Set(sigs.map(s => wasmTypeKey(s.result)));
		const result = resultKinds.size === 1 ? sigs[0].result : REF_ANY;
		return { params, result, hasRest: sigs.some(s => s.hasRest), defaults };
	}

	// The array-backed part of an intersection, when it has exactly one physical shape -- an ARRAY carrying
	// extra properties: `TemplateStringsArray` (`ReadonlyArray<string> & {raw}`), tison's `WithTextPos<T> =
	// T & {pos}`, `interface RegExpMatchArray extends Array<string>`. Such a value IS the array physically;
	// the extra properties get no slot, so reading one is an honest `unknown field '...'` rather than a
	// wrong answer, and erasing them is exactly what keeps the value assignable to a plain array parameter
	// with no conversion, the way real TS's own subtyping already allows. Flattened over the RAW parts, not
	// `T.flattenIntersection` -- that resolves each part first, expanding `Array<string>` into the class's
	// own object shape and losing the very thing being looked for. Both `typeOf` and `ownerFor` route
	// through this, so the physical type and the method/field owner can never disagree about such a value.
	function arrayPartOf(t: Type): { part: Type; element: Type } | undefined {
		const parts: Type[] = [];
		const flatten = (x: Type): void => {
			if (x.type === 'intersection')
				x.types.forEach(flatten);
			else
				parts.push(x);
		};
		flatten(t);
		// Matched on the part's own written shape, never through `T.resolve`: with `Array` declared in the
		// lib scope, resolving `Array<string>` expands it to the class's own object shape and loses the very
		// thing being looked for.
		const arrays = parts.flatMap(part => {
			const element = part.type === 'array' ? part.element
				: part.type === 'ref' && part.typeArgs?.length === 1 && (READONLY_ALIAS[part.name] ?? part.name) === 'Array' ? part.typeArgs[0]
				: undefined;
			return element ? [{ part, element }] : [];
		});
		return arrays.length && new Set(arrays.map(a => T.typeKey(a.element))).size === 1 ? arrays[0] : undefined;
	}

	// The `ClassInfo` a type REFERENCE names. A namespace-qualified ref (`T.Scope`, from an `import * as T`)
	// resolves its leaf in the NAMESPACE's own scope -- `ensureClass`'s own lookup never splits on '.', so
	// such a ref otherwise fell through to a structural shape-only stand-in with no constructor or methods,
	// which then collided with the real class built for the same declaration via `new T.Scope(...)`. Scoped
	// to a leaf that really is a CLASS there: an interface or alias reached by a dotted name (`JS.CallSig`)
	// keeps the structural path that already represents it.
	function ensureClassRef(t: TS.RefType): ClassInfo | undefined {
		const dot = t.name.lastIndexOf('.');
		if (dot > 0) {
			const leaf	= t.name.slice(dot + 1);
			const ns	= ((t.declScope as Scope | undefined) ?? global).lookupScope(t.name.slice(0, dot).split('.'));
			if (ns?.decl(leaf)?.type === 'class_decl')
				return ensureClass(leaf, t.typeArgs, ns);
		}
		return ensureClass(t.name, t.typeArgs, t.declScope as Scope | undefined);
	}

	function typeOf(t: Type): WasmType | undefined {
		if (t.type === 'ref' && t.typeArgs?.length) {
			const name = READONLY_ALIAS[t.name] ?? t.name;
			const decl = LIB_DECL_MAP.get(name) ?? userGenericClassDecls.get(name);
			if (decl?.type === 'class_decl' && decl.typeParams?.length) {
				const cls = ensureClass(name, t.typeArgs);
				if (cls)
					return ownerThisType(cls);
			}
		}

		const resolved = T.resolve(global, t);
		switch (resolved.type) {
			case 'object': {
				const vt	= indexSignatureValueType(resolved);
				const cls	= vt && ensureClass('Map', [TS.RefType('string'), vt]);
				if (cls)
					return ownerThisType(cls);
				if (resolved.members.length && resolved.members.every(m => m.type === 'call')) {
					const sigs = resolved.members.map(closureSigParts);
					// Every overload must resolve, or this isn't attempted at all -- a partial merge would
					// silently misrepresent the physical signature rather than honestly falling through to
					// whatever error the caller's own unresolved-type handling already gives.
					if (sigs.every((s): s is FullSig => !!s)) {
						const merged = mergeOverloadSigs(sigs);
						if (merged) {
							const key = `(${merged.params.map(wasmTypeKey).join(',')})=>${wasmTypeKey(merged.result)}${merged.hasRest ? '...' : ''}${merged.defaults.map(d => d ? `?${T.exprKey(d)}` : '.').join('')}`;
							let wt = closureWasmTypes.get(key);
							if (!wt)
								closureWasmTypes.set(key, wt = { closure: merged });
							return wt;
						}
					}
				}
				break;
			}
			// An ARRAY carrying extra properties: `TemplateStringsArray` (`ReadonlyArray<string> & {raw}`),
			// tison's `WithTextPos<T> = T & {pos}`, `interface RegExpMatchArray extends Array<string>`.
			// Physically just the array -- the extra properties get no slot, so reading one is an honest
			// `unknown field '...'` rather than a wrong answer, and erasing them here is exactly what keeps
			// such a value assignable to a plain array parameter with no conversion, the way real TS's own
			// subtyping already allows. `wasmTypeOf`, not `typeOf`: the object parts must not build (and
			// register) anonymous shapes as a side effect of merely asking whether they're array-backed.
			// Falls through to the flatten-and-merge path below when no part is array-backed at all (an
			// interface extending another interface), or when two parts disagree on the element kind.
			case 'intersection': {
				const arr = arrayPartOf(resolved);
				if (arr)
					return wasmTypeOf(TS.ArrayType(arr.element), global);
				break;
			}
			case 'union': {
				const nonNullish = resolved.types.filter(m => !T.isNullish(m, global));
				if (nonNullish.length < resolved.types.length && nonNullish.length > 0) {
					const base = typeOf(nonNullish.length === 1 ? nonNullish[0] : TS.UnionType(nonNullish));
					if (!base)
						return undefined;
					return nullableWtype(base);
				}
				// A real union of >=2 members (not the nullable-collapse case just above) -- the question isn't
				// "is every member struct-backed" (that's `unionStructOwners`'s own, separate concern: *which
				// classes* a union's member-*access* can dispatch to, `case 'member'`'s `ensureUnionFieldDispatch`
				// -- still needs a real `ref.test` target per member, so it stays scoped to struct-backed unions
				// only). Here it's simpler: do every member's own physical representations collapse to the *same*
				// `WasmType` regardless -- a degenerate union like `IteratorResult<Y,R>.value: Y | R`
				// monomorphized with `Y`/`R` both `number` must stay a plain `f64`, not box as `any` just because
				// a union with >1 syntactic member showed up. Only when the members genuinely differ (class vs.
				// class, scalar vs. scalar, or scalar vs. struct/array, e.g. `Literal.value: string | number |
				// boolean | null | TemplatePart[]`) does this box as `any`, the same physical representation this
				// compiler already gives every other "could be one of several different shapes" value (an
				// unconstrained generic, a caught exception).
				if (nonNullish.length > 1) {
					const memberWtypes = nonNullish.map(typeOf);
					// A member with no representation of its own (e.g. a further-nested union hitting this same
					// case, or a genuinely unrepresentable shape) is trivially "not the same physical type as
					// everything else" -- still a real reason to box as `any`, not a reason to give up on the
					// whole union.
					if (!memberWtypes.every((w): w is WasmType => w !== undefined))
						return REF_ANY;
					return combineUnionWtypes(memberWtypes);
				}
				break;
			}
			// A type predicate (`t is Foo`) is a checking-time refinement with no representation of its
			// own: as a plain value it IS a boolean, and an `asserts` one yields nothing at all. Exactly
			// the reduction the checker already applies at a call site whose result is used as a value.
			case 'predicate':
				return resolved.asserts ? 'void' : typeOf(T.BOOLEAN);

			case 'function': {
				// Builds (and memoizes) the `{closure: FuncSig}` `WasmType` for a TS function type
				const parts = closureSigParts(resolved);
				if (!parts)
					throw `a function type has an unsupported return type: '${resolved.returnType ? T.typeKey(resolved.returnType) : 'void'}' in '${T.typeKey(resolved)}'`;
				const { params, result, hasRest, defaults } = parts;
				// `hasRest` folded into the memoization key too -- see `funcSigEq`'s own comment on why it's part
				// of a closure's real type identity, not just incidental metadata. Which *positions* are
				// omittable is folded in too (`defaults.map(...)`) -- two closure types can share an identical
				// physical `WasmType` signature (a genuinely-nullable-but-required param and a truly optional
				// one both widen to the same nullable wtype) while differing on whether a call site may omit
				// the argument, so the physical signature alone isn't a safe cache key here. Each default's
				// own TEXT is part of it as well, not just that a position has one: a call site synthesizes
				// the omitted argument FROM this memoized signature, so `(a, by = 10)` and `(a, by = 10.5)`
				// sharing an entry would silently hand one function the other's default.
				// Parameter NAMES join the key only when a default reads one: `emitCallArgs` substitutes those
				// references by name, so two otherwise-identical signatures whose parameters are named
				// differently must not share an entry. Omitted otherwise, to keep the cache from fragmenting.
				const names = parts.resolvedParams ? `[${parts.resolvedParams.map(p => describeBinding(p.key)).join(',')}]` : '';
				const key = `(${params.map(wasmTypeKey).join(',')})=>${wasmTypeKey(result)}${hasRest ? '...' : ''}${defaults.map(d => d ? `?${T.exprKey(d)}` : '.').join('')}${names}`;
				let wt = closureWasmTypes.get(key);
				if (!wt)
					closureWasmTypes.set(key, wt = { closure: { params, result, hasRest, defaults, resolvedParams: parts.resolvedParams } });
				return wt;
			}
		}
		if (t.type === 'ref') {
			const cls = ensureClassRef(t);
			if (cls)
				return ownerThisType(cls);
		}
		// Tried regardless of whether `t` itself is a `ref` (not an `else if`) -- `ensureClass` only ever
		// resolves a BARE name (`scope.type(name)`'s own lookup never splits on '.'), so a namespace-
		// qualified ref (`TS.TypeParam`, from `import * as TS from '...'`) that already resolves down to a
		// plain 'object' shape would otherwise never reach this fallback at all, real gap only surfaced
		// once self-hosting first needed a dotted ref that resolves straight to an object (not a union,
		// which already goes through this file's own separate 'union' case above). Otherwise unchanged:
		// still only reached when `ensureClass` had no nominal name to resolve by, including a class
		// currently mid-construction resolving its own name (that already returned above, so this never
		// preempts it) -- a generic parameter's own structural bound (`Record<string, any>`), substituted
		// with a real interface-typed argument, is the one case that's actually anonymous by construction
		// (`matchObjectShapeByType`'s own comment).
		// An interface `extends`ing another resolves to a real INTERSECTION rather than an 'object'
		// (`ownerFor`'s own intersection case says the same), so a namespace-qualified ref to one --
		// `JS.CallSig<any>`, which is `{typeParams?; returnType?; ...} & Params<any>` -- reached neither
		// `ensureClass` (dotted name) nor the object branch below, and had no representation at all.
		// Flattened through the shared `resolveObjectType`, so this agrees with `ownerFor` on the shape.
		const flat = resolved.type === 'object' ? resolved : resolved.type === 'intersection' ? resolveObjectType(resolved, global) : undefined;
		if (flat) {
			const shapeMatch = matchObjectShapeByType(flat) ?? ensureAnonObjectShape(flat);
			if (shapeMatch)
				return ownerThisType(shapeMatch);
		}
		return wasmTypeOf(t, global);
	}

	// `this`'s `WasmType`. A real `ClassInfo` carries its own already-resolved `thisWtype` directly (never
	// guessed from its name); a builtin (non-class) owner has no such field, so it derives one from `thisTsType`.
	function ownerThisType(owner: ClassInfo): WasmType {
		return owner.thisWtype ?? { ref: owner.name };
	}

	// The `WasmType` a value expression resolves to -- `classOf`/`arrayKindOf` below are thin discriminating views over this one (previously identical) checker walk.
	// `unwrapAs`: see that function's own comment -- the checker's `typeOf` must see the real (post-`as`) expression, not the asserted one.
	function wtypeOf(e: Expr, ctx: FunctionContext): WasmType | undefined {
		// `narrowedTypeOf`, not `ctx.scope` outright: `ctx.scope` carries no control-flow narrowing, so a
		// read off a receiver narrowed out of `T | undefined` (`if (!r) return; r.min`) had no baseline
		// type at all. See `narrowedTypeOf` for why that stays safe -- it only defers to `stmtScope` where
		// `ctx.scope` has a union or no answer.
		return typeOf(narrowedTypeOf(e, ctx));
	}

	// Like `checkerTypeOf(e, ctx.scope)`, but for a receiver whose *unnarrowed* type is a real union,
	// prefers the enclosing statement's own narrowing-aware `ctx.stmtScope` when it actually narrows that
	// union down (`switch (m.type) { case 'm1': m.a ...}` needs `m`'s narrowed type, which only
	// `stmtScope` has). `ctx.scope`'s own answer is the baseline and wins whenever it isn't a union --
	// `stmtScope`'s own stamped type can otherwise diverge from it in ways that have nothing to do with
	// narrowing (a synthetic, towasm-only identifier the checker never stamped at all resolves as bare
	// `any`; a lib generic method/constructor body's own stamp reflects its *template*, not the concrete
	// per-instantiation substitution `ctx.scope` has; the checker's own internal tracking can otherwise
	// fully structurally resolve a value where `ctx.scope` keeps its clean nominal `ref`) -- none of which
	// this needs to enumerate, since they only ever matter once a union is actually in play.
	function narrowedTypeOf(e: Expr, ctx: FunctionContext): Type {
		const unwrapped = unwrapAs(e);
		const base = checkerTypeOf(unwrapped, ctx.scope);
		// `any` counts as well as a real union: a field read off a NARROWED union receiver (`w.body`
		// inside `if (w.kind === 'w')`) has no baseline type at all, because `ctx.scope` still sees `w` as
		// the whole union, on which `body` doesn't exist. Every divergence the union-only guard was
		// protecting against needs `ctx.scope` to have a real answer, so an `any` baseline can't reach one.
		if (!ctx.stmtScope || !(T.isAny(base) || T.resolve(ctx.scope, base).type === 'union'))
			return base;
		const narrowed = checkerTypeOf(unwrapped, ctx.stmtScope);
		return T.isAny(narrowed) ? base : narrowed;
	}

	// Emit `fn` with `ctx.stmtScope` refined by `test` holding (or failing), for a ternary's or logical
	// operator's own branch. Narrowing only ever reaches codegen through `stmtScope`, and the checker
	// stamps a scope on STATEMENTS only -- so a receiver narrowed by the very expression being emitted
	// (`p ? p.typeArgs![0] : x`) was invisible, and every read through it fell back to `any`. `typeScope`,
	// not `scope`, so a branch inside an already-narrowed statement composes rather than resets.
	function inNarrowed<R>(test: Expr, sense: boolean, ctx: FunctionContext, fn: () => R): R {
		const saved = ctx.stmtScope;
		ctx.stmtScope = narrow(test, ctx.typeScope, sense);
		try {
			return fn();
		} finally {
			ctx.stmtScope = saved;
		}
	}

	// The type arguments for a `new C(...)` that spells none out. Nothing is inferred here -- both sources
	// already exist: the checker solves them from the constructor's own arguments (asked about
	// `new Set(['a'])` it answers `Set<string>`), and `ctx.contextualReturn` -- the same contextual channel
	// array/object literals already read -- carries the surrounding declaration's own declared type, which
	// is all a no-argument `new Map` has to go on. Merged per position, an argument-solved one winning and
	// the contextual one filling an `any`, because for some real call site each is the only one that knows.
	// Learning nothing from either deliberately falls through to `ensureClass`'s own "needs N explicit type
	// argument(s)" throw, rather than silently building an `any`-typed instance.
	function newTypeArgs(name: string, explicit: Type[] | undefined, e: Expr, ctx: FunctionContext): Type[] | undefined {
		if (explicit?.length)
			return explicit;
		// Through a union, because an optional field's own read type is `C<...> | undefined` -- that still
		// contextually types a `new C` written into it.
		const argsFor = (t: Type | undefined): Type[] | undefined =>
			t?.type === 'union'	? t.types.map(argsFor).find(a => a)
			:	t?.type === 'ref' && t.name === name ? t.typeArgs
			:	undefined;
		const solved		= argsFor(checkerTypeOf(e, ctx.scope));
		const contextual	= argsFor(ctx.contextualReturn);
		const merged: Type[] = [];
		for (let i = 0; i < Math.max(solved?.length ?? 0, contextual?.length ?? 0); i++) {
			const s = solved?.[i];
			const pick = s && !T.isAny(s) ? s : contextual?.[i] ?? s;
			if (!pick)
				return explicit;
			merged.push(pick);
		}
		return merged.length && !merged.every(t => T.isAny(t)) ? merged : explicit;
	}

	// A bare object literal with no single resolvable target type at all (`case 'object'`'s own `want`
	// doesn't name one class) -- a last-resort structural match against every reachable, struct-backed
	// class/object-shape (same "every class ever discovered" scan `findAnyDispatchCandidates` already
	// uses for method dispatch, just picking which *shape* a literal is meant to build as instead of
	// which method to call). A candidate qualifies only when its own field set exactly matches the
	// literal's own property names (no missing, no extra); when more than one candidate's field set
	// matches (the real, common "discriminated union" shape -- e.g. `SpreadExpr`/`OtherExpr` both
	// `{kind, value}`), a further check narrows by discriminant: a property whose own literal value
	// matches exactly one candidate's own literal-typed field declaration, but not another's. Found via
	// a generic callback correctly resolving its own type param to a real union (contextual generic
	// inference, this session) and then needing to build one member's own object literal -- deliberately
	// narrow (exact-field-set matching plus literal-value discrimination, not general structural
	// subtyping): covers the real, common discriminated-union shape this is for, nothing broader.
	// `cls`'s own declared type for field `key`, for `matchObjectShape`'s own discriminant check -- a real
	// `class`'s own member lives on `cls.decl.body` directly (`JS.Field`'s `typeAnnotation`), but an
	// object-shape type alias (`type X = {...}`, not a real class) never populates that at all
	// (`ensureObjectShape`'s own comment: `decl: { name, body: [] }`, deliberately empty) -- its own
	// field types live only on the original structural type, re-resolved here the same way
	// `ensureObjectShape` itself already derived them once when building `cls` in the first place.
	function fieldDeclaredType(cls: ClassInfo, key: string): Type | undefined {
		const m = cls.decl.body.find((m): m is JS.Field<Type> => m.type === 'field' && m.key === key);
		if (m)
			return m.typeAnnotation;
		// `cls.name` is often a composite cache key (`Field<Type>`, `FunctionExpr<any>`, ...), never a real,
		// globally-resolvable type name -- `global.type(cls.name)` silently found nothing for any class built
		// this way, real bug (found only once self-hosting first needed to disambiguate among several such
		// generic-interface-shaped candidates). `cls.thisTsType` is the one field every such class already
		// carries its own REAL resolvable type through -- a `RefType(name, typeArgs)` for a named interface
		// (`ensureObjectShape`), or the anonymous object type itself (`ensureAnonObjectShape`) -- so this
		// works uniformly for both, no name-based re-derivation needed at all. `resolveObjectType` (not a
		// bare `T.resolve`/`'object'` check) since a named interface `extends`ing another (`Method<T>
		// extends CallSig<T>`) resolves to a real intersection, not a plain object.
		const resolved = resolveObjectType(cls.thisTsType, global);
		if (resolved) {
			const p = resolved.members.find(p => p.type === 'property' && p.key === key);
			if (p?.type === 'property')
				return p.typeAnnotation;
		}
		return undefined;
	}

	// The set of possible values for a field whose own declared type is a pure literal or union-of-
	// literals (a real discriminant, e.g. a class-member's own `type: 'method'|'get'|'set'`) --
	// `undefined` for anything else (an ordinary `string`/wider field that merely happens to hold a
	// constant-looking value at one particular call site), meaning "no signal, doesn't rule a candidate
	// in or out." Shared by every discriminant-matching tiebreak in this file (`matchObjectShape`/
	// `matchObjectShapeByType`/`matchContextualUnionMember`) -- checking only `declType.type === 'literal'`
	// (as each used to, independently) misses the common case of a *union* of literal tags (any real
	// discriminated union with more than 2 arms sharing one field, e.g. `Method`'s own `'method'|'get'|
	// 'set'`), silently treating a candidate that can *never* hold the value in question as an unconstrained
	// (non-disqualifying) match instead of a definite mismatch.
	function literalValues(t: Type): unknown[] | undefined {
		return t.type === 'literal' ? [t.value]
			: t.type === 'union' && t.types.every((m): m is Literal<string | number | boolean | null | JS.TemplatePart<Type>[]> => m.type === 'literal') ? t.types.map(m => m.value)
			: undefined;
	}

	function matchObjectShape(e: JS.ObjectExpr<Type>, ctx: FunctionContext): ClassInfo | undefined {
		const props = new Map<string, Expr>();
		for (const p of e.properties) {
			if (p.type !== 'field' || typeof p.key !== 'string' || !p.value)
				return undefined;
			props.set(p.key, p.value);
		}
		// A literal may legitimately omit any of a candidate's own *optional* fields (real TS object-literal-
		// against-interface semantics) -- so this isn't an exact field-SET match, it's "the literal names no
		// field the candidate doesn't have, and every field the candidate doesn't get isn't required." The
		// field-construction loop below (`for (const f of owner.fields)`) already fills a missing optional
		// field with its default value; it just never used to be reached for a class with unfilled optionals,
		// since this filter used to require an exact field-count match first.
		// `new Set`: one `ClassInfo` can be reachable under more than one key (a named alias/interface and
		// its structurally identical anonymous shape share one -- see `ensureObjectShape`), and counting it
		// twice made the "exactly one candidate" test below fail for a shape that has exactly one.
		const candidates = [...new Set(classes.values())].filter(cls =>
			cls.typeIndex !== -1 && [...props.keys()].every(k => cls.fieldIndex.has(k)) && cls.fields.every(f => props.has(f.name) || f.optional)
		);
		if (candidates.length === 1)
			return candidates[0];
		// No declared interface/class anywhere has this exact field set -- a genuinely anonymous shape
		// (e.g. `const mapSig = {a: ..., b: ...}`, never named via `interface`/`type X = ...`), same gap
		// `ensureAnonObjectShape` already exists for at a function type's own return position. Reusing it
		// here, keyed the same way, means an identically-shaped anonymous literal elsewhere (or after
		// generic substitution) collapses onto the same physical struct, same as that call site already
		// relies on. Also reached when the discriminant tiebreak below rules out every name-matching
		// candidate (`matches.length === 0`) -- see `matchObjectShapeByType`'s own identical fallback for why.
		const fallback = () => {
			const resolved = T.resolve(ctx.scope, checkerTypeOf(e, ctx.scope));
			return resolved.type === 'object' && !indexSignatureValueType(resolved) ? ensureAnonObjectShape(resolved) : undefined;
		};
		if (candidates.length === 0)
			return fallback();

		const matches = candidates.filter(cls => [...props].every(([key, value]) => {
			if (value.type !== 'literal')
				return true;
			const vals = literalValues(fieldDeclaredType(cls, key) ?? T.ANY);
			return !vals || vals.includes(value.value);
		}));
		return matches.length === 1 ? matches[0] : matches.length === 0 ? fallback() : undefined;
	}

	// `matchObjectShape`'s own type-level counterpart -- used by `typeOf`'s 'object' case when a real
	// object TYPE (not a literal expression) needs a nominal class to represent it, e.g. a generic
	// parameter's own structural bound (`Record<string, any>`) substituted with a real interface-typed
	// argument: `ensureClass`/`ownerFor` only preserve name identity for a `class` ref, never a plain
	// `interface` (a bare `T.resolve` fully, structurally expands it, no exception), so by the time
	// this is reached the interface's own name is already gone -- self-hosting `walker.ts`'s own
	// `mapObject<N extends Record<string, any>>` hit exactly this (`local 'r' has an unsupported type`)
	// the first time an interface-typed value, not a class, flowed through it. Same exact-field-set-
	// then-literal-discriminant matching as the literal-expression version above, just against each
	// candidate's own declared field *types* instead of an expression's actual property *values* --
	// ambiguous or partial (a computed/non-string key, or a non-property member) cases return
	// `undefined`, never a guess.
	function matchObjectShapeByType(t: TS.ObjectType): ClassInfo | undefined {
		const props = new Map<string, Type>();
		for (const m of t.members) {
			if (m.type !== 'property' || typeof m.key !== 'string')
				return undefined;
			props.set(m.key, m.typeAnnotation);
		}
		// See `matchObjectShape`'s own comment -- same optional-field-omission tolerance, not an exact match,
		// and the same `new Set` for the same reason: one `ClassInfo` is reachable under several keys.
		const candidates = [...new Set(classes.values())].filter(cls =>
			cls.typeIndex !== -1 && [...props.keys()].every(k => cls.fieldIndex.has(k)) && cls.fields.every(f => props.has(f.name) || f.optional)
		);
		if (candidates.length === 1)
			return candidates[0];
		// No declared interface/class has this exact field set either -- same genuinely-anonymous-type gap
		// `matchObjectShape`'s own expression-level counterpart falls back to `ensureAnonObjectShape` for
		// (its own comment), reached here e.g. by a bare `const mapSig = {...}`'s own inferred var_decl type
		// (never named via `interface`/`type X = ...`), not just an expression flowing straight through.
		// Also reached when every name-matching candidate is definitively ruled out by its own discriminant
		// (`matches.length === 0` below) -- logically the same "nothing real represents this shape" outcome
		// as finding zero name-matching candidates to begin with, just discovered one step later (found only
		// once self-hosting first needed to disambiguate a shape sharing its field *names* with several
		// unrelated classes, e.g. `{type, body}` matching both `static_block` and `FunctionExpr`/`Arrow`).
		const fallback = () => indexSignatureValueType(t) ? undefined : ensureAnonObjectShape(t);
		if (candidates.length === 0)
			return fallback();

		const matches = candidates.filter(cls => [...props].every(([key, propType]) => {
			const wantVals = literalValues(propType);
			if (!wantVals)
				return true;
			const gotVals = literalValues(fieldDeclaredType(cls, key) ?? T.ANY);
			return !gotVals || gotVals.some(v => wantVals.includes(v));
		}));
		return matches.length === 1 ? matches[0] : matches.length === 0 ? fallback() : undefined;
	}

	// `cls.name`'s own `get(i)`/`set(i,v)` -- real index syntax dispatched generically to any class using
	// this convention (typed-array views are just one user of it), whether inline-asm or a plain declared method.
	function methodSig(cls: ClassInfo, name: string, ctx: FunctionContext): { params: WasmType[]; result: WasmType } | undefined {
		const inline = cls.inlineMethods?.get(name);
		if (inline) {
			const b = inline([], ctx);
			return { params: b.params, result: b.result };
		}
		return ensureMethod(cls, name, [], ctx);
	}

	// The array-kind (`{arr}`) a value expression resolves to, or `undefined` if it isn't one.
	function arrayKindOf(e: Expr, ctx: FunctionContext): WasmElementI | undefined {
		const wt = wtypeOf(e, ctx);
		return wt && typeof wt !== 'string' && 'arr' in wt ? wt.arr : undefined;
	}

	// `arrayKindOf`, but for a value that's *about to be indexed into* (`e[i]`) -- unlike `arrayKindOf`'s
	// own checker-type-driven answer (correct for a genuinely standalone value, e.g. a plain `number[]`
	// local), a value that was itself just read out of a ref-kind array element (`x[0]` where `x:
	// number[][]`) is *always* physically ref-kind too, regardless of what its own declared element type
	// says in isolation: `case 'array'`'s own "want wins" construction rule already boxes a nested array
	// literal's elements as `any` whenever the *outer* container is ref-kind (there's no dedicated
	// "array of real unboxed inner arrays" physical representation in this compiler at all -- 'ref' is
	// the one shared bucket for every non-scalar element, arrays included), so `x[0]`'s real storage is a
	// boxed-any array, never a genuine `(array (mut f64))`, even though a *standalone* `number[]` would
	// normally get exactly that. `arrayKindOf(x[0], ctx)` alone can't see this -- it re-derives `x[0]`'s
	// kind fresh from `number[]`'s own checker type, one level from a scalar base, disagreeing with what
	// `x`'s own (correctly ref-collapsed) `number[][]` type already implied one level up. Recurses through
	// a chain of index expressions (`a[i][j][k]`) so every level after the first ref-kind one stays 'ref'.
	function objectArrayKind(e: Expr, ctx: FunctionContext): WasmElementI | undefined {
		//if (e.type === 'index' && objectArrayKind(e.object, ctx) === 'ref')
		//	return 'ref';
		// `narrowedTypeOf`, not `arrayKindOf`'s plain `ctx.scope` view: a value NARROWED out of
		// `T | undefined` still reads as the whole union there, so a field off it comes back `any` and
		// has no array kind at all. `[...a.rights, ...b.rights]` after `a && b` then failed with "a
		// spread element in an array literal must be an array of the same element type" -- a message
		// about element kinds, for a value whose kind was simply never looked up under the right scope.
		// The same root as the indexing gap `ownerOf` already avoids by going through `narrowedTypeOf`.
		const wt = typeOf(narrowedTypeOf(e, ctx));
		return wt && typeof wt !== 'string' && 'arr' in wt ? wt.arr : undefined;
	}

	// `classOf`, but for a value that's *about to be indexed into* (`e[i]`) via generic class-method
	// dispatch (`Array<T>.get(i)`/`.set(i,v)`, the same mechanism a typed-array view uses) -- a plain
	// array *literal* has no dedicated "array of real unboxed inner arrays" physical representation (see
	// `objectArrayKind`'s own comment): a nested array literal embedded inside an outer ref-kind array
	// always gets boxed-`any` storage, matching the outer container's own "want wins" construction rule,
	// *regardless* of its own declared element type. `classOf(e, ctx)` alone doesn't see this -- it
	// resolves `e`'s *declared* type (`number[]` = `Array<number>`) as if `e` were a genuine, standalone
	// f64-backed array, which real-mismatches against `Array<number>.get(i)`'s own compiled body (its
	// inline `array.get $this` is hardcoded to `Array<number>`'s own f64-array type index) when `e`'s
	// real value is actually a boxed-any array. Only overrides the built-in `Array` class specifically --
	// a real user class has no such dual representation (a `new Foo(...)` instance is always the same
	// physical struct, regardless of context), so this is deliberately narrow, not a general `classOf`
	// change.
	function classOfForIndexing(e: Expr, ctx: FunctionContext): ClassInfo | undefined {
		const cls = ownerOf(e, ctx);
		//if (cls?.decl.name === 'Array' && e.type === 'index' && objectArrayKind(e.object, ctx) === 'ref')
		//	return ensureClass('Array', [T.ANY]);
		return cls;
	}

	// The `WasmType`/`MethodOwner` a builtin-operator operand resolves to -- `wtypeOf`/`ownerOf` alone can't see an indexed read's element kind, so `numericPairWtype`/etc would silently fall back to `f64`.
	function operandInfo(e: Expr, ctx: FunctionContext): OperandInfo {
		if (e.type === 'index') {
			// `owner` (for owner-based operator dispatch -- '+' on a string/bigint element, etc) is a
			// TS-level identity question, so it's resolved through the checker same as any other expression
			// -- but `wtype` (the real physical representation an operand dispatch needs) must match
			// whatever `case 'index'`'s own codegen actually leaves on the stack, at the same priority it
			// uses: a class with its own `get(i)` method (typed-array views, or any other class using the
			// same convention) is authoritative via that method's real signature -- not the checker's
			// declared element type, which is necessarily width-blind (e.g. plain `number` for any of
			// `Uint8Array`'s transiently-`i32` reads) -- with a raw array's own physical element kind as the
			// next fallback, and the checker's type only as the last resort (a ref-kind element -- a class
			// or `string` -- has no narrower physical kind than what the checker already gives it).
			const t		= checkerTypeOf(unwrapAs(e), ctx.scope);
			const owner	= T.isAny(t) ? undefined : ownerFor(t);

			const cls = classOfForIndexing(e.object, ctx);
			const sig = cls && methodSig(cls, 'get', ctx);
			if (cls && sig)
				return { wtype: sig.result, owner };

			const kind = objectArrayKind(e.object, ctx);
			if (kind === 'f64' || kind === 'i32'/* || kind === 'u32'*/)
				return { wtype: kind, owner };
			if (!T.isAny(t))
				return { wtype: typeOf(t), owner };
		}
		const t = checkerTypeOf(unwrapAs(e), ctx.scope);
		return { wtype: typeOf(t), owner: ownerFor(t) };
	}

	// The `MethodOwner` a static `Type` dispatches method calls against -- derived directly from the `Type` itself, never by reverse-decoding an already-collapsed `WasmType`
	function ownerFor(t: Type): ClassInfo | undefined {
		// Same fast path `wasmTypeOf` needs, for the same reason -- a hoisted `builtinTypes` name would
		// otherwise fully expand via its own `declScope` before reaching the `w.type === 'ref'` check below.
		if (t.type === 'ref') {
			if (t.name in builtinTypes)
				return builtinTypeOwner(t.name);
/*
			if (t.typeArgs?.length) {
				const decl = LIB_DECL_MAP.get(name) ?? userGenericClassDecls.get(name);
				if (decl?.type === 'class_decl' && decl.typeParams?.length)
					return ensureClass(name, t.typeArgs);
			}
*/

			// Tries the raw, unresolved reference's own name directly (via `ensureClass`'s own shallow,
			// single-level `resolveClassAlias` lookup and its own `classes` cache check -- this subsumes the
			// old, separate `T.isRefOf(t, classes)`-guarded cache check that used to sit here) before falling
			// to `T.resolve`'s full structural expansion below. Necessary now that `global` sees lib
			// declarations: `T.resolve` no longer just unwraps one alias level (`Uint8Array` -> `TypedArray<u8>`)
			// -- for a name with *both* a real class and a separate ambient `interface` declaration sharing it
			// (`TypedArray`, same dual-declaration pattern as `String`), it fully expands and merges both into
			// an `intersection` type, which no longer carries a traceable class name/typeArgs at all. Safe
			// unconditionally: `ensureClass` returns `undefined`, no throw, for a name that's neither a real
			// class nor a valid alias, so this simply falls through to the existing logic below when it doesn't apply.
			const direct = ensureClassRef(t);
			if (direct)
				return direct;
		}
		// Widening only ever matters for a scalar/array/union/ref shape here (matching `wasmTypeOf`'s own
		// reasoning) -- a real `'object'` shape must NOT be widened: `widenLiterals`'s own recursive object
		// case would widen every member's own declared type too, including a discriminant field
		// (`{type:'static_block';...}`'s own `type` member) down to plain `string`, corrupting the exact
		// literal precision `matchObjectShapeByType`'s own discriminant tiebreak needs to tell union members
		// apart -- a real bug this only surfaced once self-hosting first exercised an object-shaped,
		// non-struct-backed union member (`ownerFor`'s own generic-parameter-bound `'object'` case) this way.
		const resolvedForOwner = T.resolve(global, t);
		const w = resolvedForOwner.type === 'object' ? resolvedForOwner : T.widenLiterals(resolvedForOwner, false, true);
		// `obj?.method(...)`'s receiver is nullable by construction -- strip `null`/`undefined` before
		// dispatching; there's no "owner of `null`", only "owner of the non-nullish part `?.` already guarded".

		switch (w.type) {
			case 'union': {
				const nonNullish = T.nonNullable(w, global);
				return nonNullish !== w ? ownerFor(nonNullish) : undefined;
			}
			case 'array':
				// `T[]`/`Array<T>`/`ReadonlyArray<T>` all resolve to `Array`'s own methods -- `ReadonlyArray` has no
				// separate lib declaration, it's a checker-only "readonly view" of the same structural shape.
				return ensureClass('Array', [w.element]);

			case 'ref':
				if (READONLY_ALIAS[w.name])
					return ensureClass(READONLY_ALIAS[w.name], w.typeArgs);
				if (w.name === 'Array')
					return ensureClass('Array', w.typeArgs);
				// A plain lib class (or alias -- `resolveClassAlias`) not yet reached through the raw-`t.name`
				// `ensureClass` try above -- e.g. a param typed `Uint8Array` with no earlier `new Uint8Array(...)`
				// call in this compile to have lazily populated `classes` already. Safe to call unconditionally: `ensureClass` returns
				// `undefined`, no throw, for a name that's neither. `w.typeArgs` (not just `w.name`) -- now that
				// `global` sees lib type aliases too, `T.resolve` can already expand a bare alias name like
				// `Uint8Array` into its real generic form (`TypedArray<u8>`) by this point, and a generic class
				// needs its type arguments to resolve at all, same as the `Array`/`ReadonlyArray` case just above.
				return builtinTypeOwner(w.name) ?? ensureClass(w.name, w.typeArgs);

			case 'object': {
				const vt = indexSignatureValueType(w);
				if (vt)
					return ensureClass('Map', [TS.RefType('string'), vt]);
				// Genuinely last resort, same guard as `typeOf`'s own -- only reached once `t.type ===
				// 'ref'` has already had its own shot above (a plain class/interface ref, including one
				// still mid-construction resolving its own name, is *never* funneled down here: that
				// early check returns first). A generic parameter's own structural bound substituted with
				// a real interface-typed argument is the one case that's actually anonymous by
				// construction (`matchObjectShapeByType`'s own comment).
				// ...and when nothing declared matches either, synthesize the shape -- the same last resort
				// `matchObjectShape` already applies on the literal side, so a value whose type is a bare
				// anonymous object (an inferred field, a spread result) has an owner to read fields off.
				return matchObjectShapeByType(w) ?? ensureAnonObjectShape(w);
			}
			// An interface `extends`ing another (`Method<T> extends CallSig<T>`) resolves to a real
			// intersection, not an 'object' -- `resolveObjectType` flattens+merges it into one flat object
			// the same way `matchObjectShapeByType` expects.
			case 'intersection': {
				// See `arrayPartOf` -- an array carrying extra properties dispatches against `Array` itself.
				const arr = arrayPartOf(w);
				if (arr)
					return ensureClass('Array', [arr.element]);
				const merged = resolveObjectType(w, global);
				// Same last resort the 'object' case above uses -- synthesize the flattened shape when
				// nothing declared matches it, or a value of such a type has no owner to read fields off.
				return merged && (matchObjectShapeByType(merged) ?? ensureAnonObjectShape(merged));
			}
		}
		return undefined;
	}

	// Resolves any `Type` down to a real flat `ObjectType`, if possible -- a plain `'object'` already is
	// one; an interface `extends`ing another (`Method<T> extends CallSig<T>`) resolves to a genuine
	// `'intersection'` instead, whose own parts can still be unresolved refs (`CallSig<T>`) --
	// `T.flattenIntersection`'s own `resolveOwn` handles that, `T.mergeIntersection` folds the flattened
	// parts into one flat object. Shared by `ownerFor`'s own `'intersection'` case and
	// `matchContextualUnionMember` below, so both always agree on the exact same flat shape (and so the
	// same `T.typeKey`/struct) for a given declared type -- duplicating this merge independently in two
	// places risks the two computing subtly different shapes for what's really the same interface.
	function resolveObjectType(t: Type, scope: Scope): TS.ObjectType | undefined {
		const w = T.resolve(scope, t);
		if (w.type === 'object')
			return w;
		if (w.type === 'intersection') {
			const merged = T.mergeIntersection(TS.IntersectionType(T.flattenIntersection(w, scope)));
			return merged.type === 'object' ? merged : undefined;
		}
		return undefined;
	}

	// An object literal assigned against a real union target (`const m: ClassMember = {type:'field', ...}`)
	// needs to pick the ONE union member the literal actually represents before it can be constructed --
	// `matchObjectShape`'s own candidate scan only ever looks at already-*registered* classes (`classes`),
	// so the very first literal of a given shape (nothing yet triggered building the interface's own
	// "official" struct via `ownerFor`) would otherwise fall to its own `ensureAnonObjectShape` fallback and
	// build a shape from only the literal's own written properties -- a DIFFERENT, narrower struct than
	// what `ownerFor` independently builds for the same interface later (the exact mismatch that made
	// `ensureUnionFieldDispatch`'s `ref.test` cascade trap at runtime, confirmed via a real repro). Uses
	// `ctx.contextualReturn` (the same mechanism `case 'array'`'s own contextual-kind check already relies
	// on) to see the real declared union type, then matches by the literal's own discriminant field
	// value(s) against each member's own declared literal type -- same discriminant-matching idea
	// `matchObjectShape`/`matchObjectShapeByType`'s own multi-candidate tiebreak already uses, just applied
	// before ever falling back to structural-only guessing. Requires at least one literal-valued property
	// to discriminate by and exactly one matching member -- an ambiguous or non-discriminated literal falls
	// through to `matchObjectShape`'s own (unaffected) existing behavior.
	function matchContextualUnionMember(e: JS.ObjectExpr<Type>, ctx: FunctionContext): ClassInfo | undefined {
		if (!ctx.contextualReturn)
			return undefined;
		const props = new Map<string, Expr>();
		for (const p of e.properties) {
			if (p.type !== 'field' || typeof p.key !== 'string' || !p.value)
				return undefined;
			props.set(p.key, p.value);
		}
		if (!props.size)
			return undefined;
		// A union member (e.g. a re-exported cross-module generic alias like `JS.ClassMember<T>`) can itself
		// resolve to a FURTHER union -- flattens all the way down to real object shapes, same recursion
		// `flattenOwners` already needs for the equivalent dispatch-side problem. Keeps each member's own
		// RAW (un-resolved) type alongside its expanded shape -- `raw` still names a real interface
		// (`{ref:'Method',...}`), which `ownerFor` below can resolve by NAME once a unique match is found
		// (the same class `flattenOwners`/`ownerFor` would independently build for the very same member on
		// the dispatch side); using only the resolved, name-stripped shape here would risk building a
		// SEPARATE, merely-structurally-identical anonymous class instead -- a real, confirmed mismatch
		// (`ensureUnionFieldDispatch`'s `ref.test` cascade trapped at runtime) whichever side happened to
		// construct its own class first.
		const flatten = (t: Type): { raw: Type; objT: TS.ObjectType }[] => {
			const resolved = T.resolve(ctx.scope, t);
			if (resolved.type === 'union')
				return resolved.types.filter(m => !T.isNullish(m, ctx.scope)).flatMap(flatten);
			const objT = resolveObjectType(resolved, ctx.scope);
			return objT ? [{ raw: t, objT }] : [];
		};
		const matches = flatten(ctx.contextualReturn).filter(({ objT }) => {
			const fieldNames = new Set(objT.members.filter((m): m is TS.TypeMember & { type: 'property'; key: string } => m.type === 'property' && typeof m.key === 'string').map(m => m.key));
			// The literal must name no field this member doesn't declare (an excess-property-style check --
			// otherwise e.g. `Field`'s own `key`/`typeAnnotation` names would equally "fit" `static_block`,
			// which declares neither); a field this member declares as a real discriminant must have this
			// literal's own value among its possible values -- one with no such signal isn't required to
			// "match" anything.
			return [...props.keys()].every(k => fieldNames.has(k)) && [...props].every(([key, value]) => {
				if (value.type !== 'literal')
					return true;
				const m = objT.members.find(m => m.type === 'property' && m.key === key);
				if (m?.type !== 'property')
					return false;
				const vals = literalValues(m.typeAnnotation);
				return !vals || vals.includes(value.value);
			});
		});
		return matches.length === 1 ? ownerFor(matches[0].raw) ?? matchObjectShapeByType(matches[0].objT) : undefined;
	}

	// A union's own members can themselves resolve to a further union (e.g. a re-exported cross-module
	// alias like `JS.ClassMember<T>` nested inside `ClassMember`'s own definition) -- `T.resolve` only
	// ever expands the outermost type by one level, never recursing into a union's own members (every
	// other caller in this file that needs that, e.g. `typeOf`'s own 'union' case, does the recursion
	// itself). `ownerFor`'s own union-case only ever handles the nullable-collapse shape (stripping
	// `null`/`undefined` down to one remaining member); a genuine multi-member union has no single owner
	// of its own, so this flattens all the way down to concrete owners for a multi-owner dispatch caller
	// (`case 'member'`'s own `ensureUnionFieldDispatch` fallback) instead of forcing it to see one
	// unresolved member and give up.
	function flattenOwners(t: Type, scope: Scope): ClassInfo[] | undefined {
		// Tries `ownerFor(t)` directly first, on the RAW (not pre-resolved) member -- `ownerFor`'s own
		// `t.type === 'ref'` fast path needs the real, nominal ref (a real class's own name/typeArgs/
		// declScope) to keep its identity; pre-resolving here unconditionally would expand a real class
		// down to its bare structural shape before `ownerFor` ever gets a chance to recognize it by name,
		// landing on `matchObjectShapeByType`'s anonymous-shape path instead of the class's own real
		// struct (a real regression, caught by the existing `A | B` union-of-real-classes test). Only
		// once that direct attempt fails does resolving reveal whether `t` is itself a further, nested
		// union (e.g. a re-exported cross-module alias like `JS.ClassMember<T>`) worth flattening.
		const direct = ownerFor(t);
		if (direct)
			return [direct];
		const resolved = T.resolve(scope, t);
		if (resolved.type === 'union') {
			const parts = T.unionMembers(resolved, scope).filter(m => !T.isNullish(m, scope)).map(m => flattenOwners(m, scope));
			return parts.every((p): p is ClassInfo[] => !!p) ? parts.flat() : undefined;
		}
		return undefined;
	}

	// The union members a `u.m(...)` call could dispatch to, or `undefined` when this isn't that shape.
	// Every member must be a struct-backed owner declaring a matching `m` -- a partial answer would be a
	// silent wrong dispatch, so anything less falls through to the caller's own error. Deduped by
	// `typeIndex`: several members can share one physical type, and a repeated `ref.test` arm is dead code
	// the first one already claimed.
	function unionMethodOwners(obj: Expr, name: string, args: Expr[], ctx: FunctionContext): ClassInfo[] | undefined {
		const t = T.resolve(ctx.typeScope, narrowedTypeOf(obj, ctx));
		if (t.type !== 'union')
			return undefined;
		const owners = T.unionMembers(t, ctx.typeScope).filter(m => !T.isNullish(m, ctx.typeScope))
			.flatMap(m => flattenOwners(m, ctx.typeScope) ?? [undefined]);
		if (owners.length < 2 || !owners.every(o => o && o.typeIndex !== -1 && methodSig(o, name, ctx)))
			return undefined;
		const seen = new Set<number>();
		return (owners as ClassInfo[]).filter(o => !seen.has(o.typeIndex) && (seen.add(o.typeIndex), true));
	}

	// A namespace-style reference (`Box.describe()`) never carries real type arguments the way a genuine
	// instantiation (`new Box<number>()`, or a value typed `Box<number>`) does -- and real TS forbids a
	// static member from ever referencing its class's own type parameters in the first place (checker-
	// enforced, trusted here same as everywhere else in this file), so the *choice* of type argument can't
	// matter for whatever static member is actually being looked up. `T.ANY` uniformly fills every type
	// param instead of `ensureClass`'s ordinary "needs N explicit type argument(s)" throw -- always resolves
	// to `REF_ANY`, so even some *other* member's type that happens to mention the type param (the static
	// member itself never does) still resolves without failing. `undefined` for a non-generic class (or any
	// other name `ensureClass` already handles, e.g. a typed-array alias) leaves `ensureClass(name)` exactly
	// as it was.
	function staticTypeArgsFor(name: string): Type[] | undefined {
		const decl = LIB_DECL_MAP.get(name) ?? userGenericClassDecls.get(name);
		return decl?.type === 'class_decl' ? decl.typeParams?.map(() => T.ANY) : undefined;
	}

	// The owner for a *namespace-style* reference (`Math.sqrt`, `Array.alloc`) -- not a value expression, so
	// `ownerFor` (needs a checker `Type`) doesn't apply; `builtinTypeOwner` covers it directly.
	function namespaceOwner(name: string, ctx: FunctionContext) {
		// A self-referential call site (`X.method()`) can match either name a class goes by: a generic
		// instantiation's `name` is the composite cache key while `decl.name` stays plain `Array`; a typed-array alias's `decl.name` stays canonical `Uint8Array` while `name` is the real alias, e.g. `Int32Array`.
		return builtinTypeOwner(name) ?? (ctx.owner && (ctx.owner.decl.name === name || ctx.owner.name === name) ? ctx.owner : undefined)
			?? ensureClass(name, staticTypeArgsFor(name));
	}

	// Field access stays `classOf`-only (arrays/scalars have no fields), but method-call dispatch is
	// otherwise identical across real classes, array kinds, and scalar box kinds -- all handled by `ownerFor` above.
	function ownerOf(e: Expr, ctx: FunctionContext) {
		return ownerFor(narrowedTypeOf(e, ctx));
	}

	// Populated by the "index space" pass below, before any body is built -- a class ref's `WasmType`
	// only carries its *name*, but the binary format needs the struct's numeric type index.
	function toValType(w: WasmType): wasm.ValType {
		if (w === 'void')
			throw 'internal: void has no value representation';
		if (w === 'u32')
			return 'i32';
		if (w === 'u64')
			return 'i64';
		if (typeof w === 'string')
			return w;
		if ('ref' in w) {
			// `any`/`exn` are wasm's own abstract heap types (real strings, not type-section indices) --
			// resolve directly, not have `ensureClass` treat either as an unknown user class name.
			if (w.ref === 'any' || w.ref === 'exn')
				return { ref: w.ref, nullable: !!w.nullable };
			// Lazy like every other class use -- a not-yet-reached class still needs a real `typeIndex` now, not the stale `-1` `classes` seeded it with.
			const cls = ensureClass(w.ref);
			if (!cls)
				throw `internal: unresolved class '${w.ref}'`;
			return { ref: cls.typeIndex, nullable: !!w.nullable };
		}
		if ('closure' in w)
			return { ref: ensureClosureType(w.closure).structTypeIndex, nullable: !!w.nullable };
		if ('typeIndex' in w)
			return { ref: w.typeIndex, nullable: !!w.nullable };
		return { ref: ensureArrayType(w.arr), nullable: !!w.nullable };
	}

	// The heap type a `ref.null` needs -- just `toValType`'s `.ref`, unwrapped from the `wasm.ValType` shape.
	function heapTypeIndexOf(w: WasmType): wasm.HeapType {
		const vt = toValType(w);
		if (typeof vt === 'string' || !('ref' in vt))
			throw 'internal: expected a reference type';
		return vt.ref;
	}

	// ===================================================================
	//  Expression lowering -- every case leaves exactly one value on the stack
	// ===================================================================

	function emitStringConst(s: string, ctx: FunctionContext): void {
		// `array.new_data`'s two `i32` operands are a byte offset and an *element* count into the module's
		// one shared passive data segment -- `internString`'s return value and `s.length` already match both, no conversion needed.
		ctx.emit(I.i32.const(internString(s)), I.i32.const(s.length), I.array.new_data(ensureArrayType('i16'), 0));
	}

	// Whether the real class named `subName` is `baseName` itself or (transitively) extends it -- looked up
	// by name against `classes` (already resolved by the time this is ever asked, since a value of a class
	// ref type can't exist without that class having gone through `ensureClass` first) rather than taking
	// `ClassInfo`s directly, since `coerceTop`'s callers only ever have the bare `WasmType`'s own ref name.
	function isSubclassOf(subName: string, baseName: string): boolean {
		let cls = classes.get(subName);
		while (cls) {
			if (cls.name === baseName)
				return true;
			cls = cls.superClass;
		}
		return false;
	}

	function coerceTop(got: WasmType, ctx: FunctionContext, want: WasmType): void {
		if (wasmTypeEq(got, want))
			return;

		// A closure value whose own concrete signature differs from `want` only in its *result*, or in
		// having *fewer* params than `want` declares (real JS/TS callback convention -- `arr.map(x =>
		// x*2)` ignoring `index`/`array` is entirely ordinary, not a narrower type) -- wrap rather than
		// reject; a real incompatibility in a *shared* param position (or `got` wanting *more* params
		// than `want` offers) still falls through to the "cannot convert" throw below, same as any other
		// genuinely incompatible shape. See `ensureClosureCoercionWrapper`'s own comment.
		if (typeof got !== 'string' && typeof want !== 'string' && 'closure' in got && 'closure' in want) {
			const gotSig = got.closure, wantSig = want.closure;
			// A shared param may DIFFER, so long as adapting it is a reference narrowing the wrapper can do
			// with a cast: `Array<T>`'s methods are compiled at `T = any` for every non-scalar element (one
			// physical `arr:ref` store for all of them), so a callback honestly declared `(x: string)` meets
			// a `(x: any)` slot and has to be adapted, not rejected. Both sides must be REFERENCE types --
			// a scalar mismatch (`f64` caller, `i32` callback) would be a lossy narrowing, and silently
			// truncating an argument is worse than the error it replaces.
			const paramFits = (p: WasmType, i: number) => wasmTypeEq(p, wantSig.params[i])
				|| (typeof p !== 'string' && typeof wantSig.params[i] !== 'string');
			if (gotSig.params.length <= wantSig.params.length && !!gotSig.hasRest === !!wantSig.hasRest
				&& gotSig.params.every(paramFits)) {
				const orig = ctx.temp(`$origClosure$${closureCallTempCounter++}`, got);
				ctx.emit(I.local.set(orig));
				const { info, wantStructTypeIndex, envTypeIndex } = ensureClosureCoercionWrapper(gotSig, wantSig);
				ctx.emit(I.ref.func(info.funcIndex), I.local.get(orig), I.struct.new(envTypeIndex), I.struct.new(wantStructTypeIndex));
				return;
			}
		}

		// `u32`/`i32` are the same physical wasm value -- `u32` only exists so `coerceTop` always knows which
		// conversion direction (`_s` vs `_u`) a value needs, instead of every producer converting eagerly itself.
		if ((got === 'u32' && want === 'i32') || (got === 'i32' && want === 'u32'))
			return;

		// A nullable primitive (`number | null`/`boolean | null`, boxed via `ensureBoxType`) meeting a
		// bare-scalar consumer: unbox unconditionally, trusting the checker already required narrowing
		// (same `ref.as_non_null`-traps-on-null contract `coerceTop` already uses for nullable objects).
		// Reassigning `got` lets every scalar-conversion branch below run unmodified, as if `got` had
		// been bare all along.
		const gotBox = unboxedPrimitive(got);
		if (gotBox) {
			ctx.emit(I.ref.as_non_null, I.struct.get(gotBox.typeIndex, 0));
			got = gotBox.kind;
			if (wasmTypeEq(got, want))
				return;
		}
		// The opposite direction: a bare scalar meeting a nullable-primitive consumer -- widen/convert
		// to the box's own kind first (recursing into this same function), then box it.
		const wantBox = unboxedPrimitive(want);
		if (wantBox && typeof got === 'string') {
			if (got !== wantBox.kind)
				coerceTop(got, ctx, wantBox.kind);
			ctx.emit(I.struct.new(wantBox.typeIndex));
			return;
		}

		// A bare scalar has no heap identity of its own -- unlike ref/array (already a valid `anyref`), a raw
		// `f64`/`i32` needs a real box (`ensureBoxType`) to occupy an `any` slot. `u32` reads as `i32` here, same as everywhere else.
		if ((got === 'f64' || got === 'i32' || got === 'u32') && typeof want !== 'string' && 'ref' in want && want.ref === 'any') {
			ctx.emit(I.struct.new(ensureBoxType(got === 'f64' ? 'f64' : 'i32')));
			return;
		}

		if (typeof got !== 'string') {
			if ('ref' in got && got.ref === 'any') {
				// Narrowing anyref down to a bare scalar (e.g. unboxing an async step function's own
				// `#sent` param, boxed at its trampoline via this same function's own scalar->any branch
				// above) -- unbox via the same box shape a scalar->any box always uses (`ensureBoxType`),
				// then widen/convert further via a recursive call if `want` isn't exactly that box's own
				// kind (e.g. an i32 box read back as `u32`/`i64`).
				if (want === 'f64' || want === 'i32' || want === 'u32' || want === 'i64' || want === 'f32') {
					const boxKind = (want === 'f64' || want === 'f32') ? 'f64' : 'i32';
					ctx.emit(I.ref.cast(ensureBoxType(boxKind)), I.struct.get(ensureBoxType(boxKind), 0));
					if (boxKind !== want)
						coerceTop(boxKind, ctx, want);
					return;
				}
				// `want.nullable`, not the 1-arg default (non-nullable) -- narrowing an `any`/`ref`-kind-array
				// read into a *nullable* target (e.g. a `(number | null)[]` element, physically stored as a
				// shared nullable `anyref` slot) must cast to the nullable form too, or a genuinely-null
				// element traps here instead of surviving to be checked against `null` afterward.
				if (typeof want !== 'string' && ('ref' in want || 'arr' in want || 'closure' in want || 'typeIndex' in want))
					ctx.emit(I.ref.cast(heapTypeIndexOf(want), !!want.nullable));
				return;
			}

			// The opposite direction: any concrete class ref or array/string value is already a valid `anyref`
			// (structural subtyping), so widening to `any` needs no instruction -- only `ref.as_non_null` if also narrowing nullability. `'arr' in got` covers writing a string/array into a ref-kind slot the same way.
			// `'closure' in got` the same again -- a closure's `{code,env}` struct is a real wasm-GC struct
			// too (e.g. storing one into a generic `Array<() => void>`'s `any`-typed backing slot).
			if ((('ref' in got) || ('arr' in got) || ('closure' in got)) && typeof want !== 'string' && 'ref' in want && want.ref === 'any') {
				if (got.nullable && !want.nullable)
					ctx.emit(I.ref.as_non_null);
				return;
			}

		// Nullable<->non-null, same underlying ref/array kind -- or `got` a real subclass of `want`
		// (`super.method()`'s receiver, or any other upcast): wasm-GC struct subtyping (`ensureClass`'s
		// own `supertypes`) already makes the *value* valid wherever `want`'s ref type is declared, with
		// zero instructions -- only nullability might still need narrowing.
			if (typeof want !== 'string') {
				const gotKind	= 'ref' in got ? got.ref : 'arr' in got ? got.arr : undefined;
				const wantKind	= 'ref' in want ? want.ref : 'arr' in want ? want.arr : undefined;
				if (gotKind !== undefined && (gotKind === wantKind || ('ref' in got && wantKind !== undefined && isSubclassOf(gotKind, wantKind)))) {
					if (got.nullable && !want.nullable)
						ctx.emit(I.ref.as_non_null);
					return;
				}
				// The opposite direction: `want` a real subclass of `got` -- a legitimate, trusted downcast
				// (e.g. a `this`-typed method's checker-inferred return type being more specific than what a
				// shared, inherited, non-overridden compiled method itself can know it's returning -- the
				// method body was compiled once, against its own declaring class, but the checker correctly
				// tracks that *this* call's receiver -- and so its result -- is really the more specific
				// subclass). Needs a real `ref.cast`, unlike the free upcast above: the physical value's real
				// runtime type must actually be `want`'s (or a further subclass) here, same trust level as
				// any other narrowing cast in this file.
				if (wantKind !== undefined && 'ref' in want && gotKind !== undefined && isSubclassOf(wantKind, gotKind)) {
					ctx.emit(I.ref.cast(heapTypeIndexOf(want), !!want.nullable));
					return;
				}
			}
		}

		if (got === 'f64') {
			switch (want) {
				// Direct native saturating conversions -- not an `i64.trunc_sat_f64_s` + `i32.wrap_i64`
				// detour (the previous approach): saturating to i64's range *then* wrapping to i32 discards
				// the saturation for any out-of-i32-range input (e.g. `+Infinity` saturated to `i64::MAX`
				// wraps to `-1`, not a sensible value at all) -- defeating the whole point of using a
				// saturating conversion in the first place (never trapping, e.g. on `0/0`). `NaN` still
				// correctly saturates to `0`, matching real JS's `ToInt32`/`ToUint32` -- but `±Infinity`
				// saturates to `i32::MAX`/`MIN`, where real JS gives `0` for every non-finite input alike;
				// this is a narrower version of the same already-accepted gap as a huge *finite* float not
				// replicating `ToInt32`'s true modulo-2^32 wraparound -- well-defined and non-trapping, just
				// not bit-perfect JS.
				case 'i32': ctx.emit(I.i32.trunc_sat_f64_s); return;
				case 'u32': ctx.emit(I.i32.trunc_sat_f64_u); return;
				case 'i64': ctx.emit(I.i64.trunc_sat_f64_s); return;
				case 'f32':	ctx.emit(I.f32.demote_f64); return;
			}
		}
		if (want === 'f64') {
			switch (got) {
				case 'i32':	ctx.emit(I.f64.convert_i32_s); return;
				case 'u32':	ctx.emit(I.f64.convert_i32_u); return;
				case 'i64': ctx.emit(I.f64.convert_i64_s); return;
				case 'f32':	ctx.emit(I.f64.promote_f32); return;
			}
		}
		if (want === 'f32') {
			switch (got) {
				case 'i32':	ctx.emit(I.f32.convert_i32_s); return;
				case 'u32':	ctx.emit(I.f32.convert_i32_u); return;
				case 'i64': ctx.emit(I.f32.convert_i64_s); return;
			}
		}

		if (want === 'i64') {
			switch (got) {
				case 'i32': ctx.emit(I.i64.extend_i32_s); return;
				case 'u32': ctx.emit(I.i64.extend_i32_u); return;
			}
		}
		// generate bigint -- must track `bigint`'s own physical representation (`builtinTypes.bigint.wtype`, currently `{arr:'u32'}`, see `lib/bigint.ts`), not assume a fixed `{arr:'i32'}`.
		// Nullability is ignored: a `bigint | undefined` slot takes the freshly-built array exactly as a
		// plain `bigint` one does, since a non-nullable `(ref array)` is already a subtype of it.
		if (wasmTypeEq(typeof want === 'object' && want.nullable ? { ...want, nullable: false } : want, ARR_WTYPE.i32)) {
			const array = I.array(ensureArrayType('i32'));

			switch (got) {
				case 'i32': case 'u32':
					ctx.emit(array.new(1));
					return;
				case 'i64': {
					const tmp64 = ctx.temp('$tmp64', 'i64');
					ctx.emit(
						I.local.tee(tmp64),
						I.i64.const(0xffffffffn),
						I.i64.and,
						I.i32.wrap_i64,
						I.local.get(tmp64),
						I.i64.const(32n),
						I.i64.shr_u,
						I.i32.wrap_i64,
						array.new(2)
					);
					return;
				}
				case 'f32':
					ctx.emit(I.f64.promote_f32);
					//fall through
				// `bigFromNumber` (lib/bigint.ts) is the real, tested conversion, and calling it is the
				// only way this stays in step with the limb encoding it has to produce. What used to be
				// here was a hand-written exponent walk that was never finished -- it fell out of the
				// switch into the throw below, and it named two differently-typed temps `$exp`, so it
				// could not have run anyway. A mixed `bigint`/`number` comparison, which real TS allows
				// and which `BigInt.toString`'s own `i > 0` loop depends on, therefore never compiled.
				case 'f64': {
					const decl = LIB_DECL_MAP.get('bigFromNumber');
					if (decl && decl.type === 'function_decl') {
						const info = ensureFunc('bigFromNumber', decl);
						if (info) {
							ctx.emit(I.call(info.funcIndex));
							return;
						}
					}
					break;
				}

			}
		}
		throw `internal: cannot convert ${wasmTypeKey(got)} to ${wasmTypeKey(want)}`;
	}

	// `coerceTop`, but for one arm of a union dispatch (`ensureUnionFieldDispatch`/
	// `ensureUnionIndexDispatch`) whose overall `result` boxes as `any` because its *sibling* arms
	// genuinely differ (not this arm's own fault) -- every scalar arm still needs to land in the SAME
	// canonical box kind (`f64`) as every other scalar arm, not each one's own narrower physical storage
	// (`i32`/`u32`/etc, `combineUnionWtypes`'s own comment): boxing `i32` straight to `any` uses an
	// `i32`-kind box (`coerceTop`'s own scalar->any rule), but a caller unboxing a `number`-typed result
	// back out always assumes the `f64`-kind box -- two sibling arms boxing by their own different
	// physical kind would each individually "work" in isolation yet disagree with each other, and the
	// caller's `ref.cast` traps on whichever one didn't match what it assumed. Widening every scalar arm
	// to `f64` first (a real, cheap numeric conversion, not a box) before the actual `coerceTop` to
	// `result` makes every scalar arm agree on one box shape regardless of which member produced it.
	function coerceUnionArm(got: WasmType, ctx: FunctionContext, result: WasmType): void {
		if (typeof result !== 'string' && 'ref' in result && result.ref === 'any' && !result.nullable && got !== 'f64' && scalarKind(got) !== undefined) {
			coerceTop(got, ctx, 'f64');
			got = 'f64';
		}
		coerceTop(got, ctx, result);
	}

	function emitAs(e: Expr, ctx: FunctionContext, want: WasmType): WasmType {
		// `null`/`undefined` alone (`emitExpr` has no target type to pick a heap type from) -- only legal
		// into a nullable slot, same restriction `typeOf`'s union handling already enforces -- except a
		// non-nullable `any` target (see `emitDefaultValue`'s own identical case): that's specifically
		// what a real `void`-typed param/field/local gets boxed to (`void` only ever holds `undefined`
		// in real TS), so `undefined` assigned there is valid, ordinary source, not a `null` misuse --
		// box the same placeholder `emitDefaultValue` would, rather than reject it.
		if (isNullLiteral(e)) {
			if (typeof want !== 'string' && 'ref' in want && want.ref === 'any' && !want.nullable)
				ctx.emit(I.f64.const(0), I.struct.new(ensureBoxType('f64')));
			else if (typeof want === 'string' || !want.nullable)
				throw "'null'/'undefined' is only supported where a nullable object type (class/array/string) is expected";
			else
				ctx.emit(I.ref.null(heapTypeIndexOf(want)));

		} else {
			let got = emitExpr(e, ctx, want);
			// Boxing into `any`: `i32` is this compiler's physical representation for *both* a real `boolean` and
			// a compact-integer `number` -- by the time a bare `'i32'` reaches `coerceTop` that distinction is gone, so it always picked the boolean box. Disambiguated here via the checker's own real type for `e`.
			if (got === 'i32' && typeof want !== 'string' && 'ref' in want && want.ref === 'any' && ownerFor(checkerTypeOf(unwrapAs(e), ctx.scope))?.name !== 'Boolean') {
				ctx.emit(I.f64.convert_i32_s);
				got = 'f64';
			}
			coerceTop(got, ctx, want);
		}
		return want;
	}

	// The heap type a boxed value has when `typeof` would call it `tag` -- only for the tags with exactly
	// one physical form. `'string'` shares `arr:i16` with a real `Int16Array` and `'bigint'` shares
	// `arr:i32` with an `Int32Array`, the same physical ambiguity `emitTruthy` already lives with; the
	// checker's own type settles it whenever it can (`T.typeofName`), and this is the fallback.
	function typeofHeapType(tag: string): number | undefined {
		switch (tag) {
			case 'number':	return ensureBoxType('f64');
			case 'boolean':	return ensureBoxType('i32');
			case 'string':	return ensureArrayType('i16');
			case 'bigint':	return ensureArrayType('i32');
			case 'function':	return ensureClosureBase();
		}
		return undefined;
	}

	// `typeof x === 'lit'` is a runtime TYPE TEST, not a string comparison -- so it never needs a `typeof`
	// string to exist at all. Leaves an `i32` on the stack; returns false (emitting nothing) when the tag
	// has neither a static answer nor a physical form, so the caller falls through to its own error.
	function emitTypeofTest(operand: Expr, tag: string, ctx: FunctionContext): boolean {
		const t		= checkerTypeOf(unwrapAs(operand), ctx.scope);
		const answer = (v: 0 | 1) => {
			// Still evaluated, for its side effects, exactly as an expression statement would.
			if (emitExpr(operand, ctx, 'void') !== 'void')
				ctx.emit(I.drop);
			ctx.emit(I.i32.const(v));
			return true;
		};
		const known = T.typeofName(t, ctx.scope);
		if (known !== undefined)
			return answer(known === tag ? 1 : 0);

		// Nullable, but every NON-null inhabitant shares one tag: `'undefined'` asks exactly "is it null",
		// the matching tag asks exactly "is it not null", and any other tag can never hold.
		const r		= T.resolve(ctx.scope, t);
		const nnTag	= r.type === 'union' ? T.typeofName(TS.UnionType(r.types.filter(m => !T.isNullish(m, ctx.scope))), ctx.scope) : undefined;
		if (tag === 'undefined' || nnTag !== undefined) {
			if (nnTag !== undefined && nnTag !== tag && tag !== 'undefined')
				return answer(0);
			emitAs(operand, ctx, REF_ANY_NULLABLE);
			ctx.emit(I.ref.is_null);
			if (tag !== 'undefined')
				ctx.emit(I.i32.eqz);
			return true;
		}

		// A real runtime test, and only a boxed `any` slot can carry one: two types that share a physical
		// form (`number` and `boolean` are both `f64` here) are indistinguishable at runtime, so anything
		// else would be a WRONG answer rather than an unsupported one.
		const heap = typeofHeapType(tag);
		const w    = wtypeOf(operand, ctx);
		if (!(w && typeof w === 'object' && 'ref' in w && w.ref === 'any'))
			return false;
		if (heap !== undefined) {
			emitAs(operand, ctx, REF_ANY_NULLABLE);
			ctx.emit(I.ref.test(heap));
			return true;
		}
		// `'object'` is the one tag with no physical form of its own -- it is the COMPLEMENT of the ones
		// that have one, so a plain OR of those tests answers it with no branching. `guard()`'s own
		// `typeof node === 'object'` is the shape. A null slot reads as `'undefined'` here (see above), so
		// JS's `typeof null === 'object'` is deliberately not reproduced -- that value cannot be told from
		// a real `undefined` in this representation either way.
		if (tag === 'object') {
			const tmp = ctx.temp(`$typeofobj$${optionalTempCounter++}`, REF_ANY_NULLABLE);
			emitAs(operand, ctx, REF_ANY_NULLABLE);
			ctx.emit(I.local.set(tmp), I.local.get(tmp), I.ref.is_null);
			for (const h of [ensureBoxType('f64'), ensureBoxType('i32'), ensureArrayType('i16'), ensureClosureBase()])
				ctx.emit(I.local.get(tmp), I.ref.test(h), I.i32.or);
			ctx.emit(I.i32.eqz);
			return true;
		}
		return false;
	}

	// True when a value of this type is truthy whenever it is non-null -- an object, an array, a tuple, a
	// function. Never a `string` (`''` is falsy), a `number` (`0`, `NaN`), a `boolean`, a literal, or a
	// genuinely dynamic `any`/type parameter, for all of which truthiness is a property of the VALUE.
	// Answered from the CHECKER's type, which is the only thing that still knows a boxed `any` slot holds
	// `Stmt | undefined` rather than something that could be `0`.
	function alwaysTruthy(t: Type, scope: Scope): boolean {
		const r = T.resolve(scope, t);
		switch (r.type) {
			case 'object':	case 'array':	case 'tuple':
			case 'function':	case 'constructor':
				return true;
			case 'union':
				// An all-nullish union lands here as `true`, which is still correct: the null test below
				// answers `false` for it, which is what it always is. `T.unionMembers` drops `never` and
				// flattens nested aliases -- see its own comment.
				return T.unionMembers(r, scope).every(m => T.isNullish(m, scope) || alwaysTruthy(m, scope));
			case 'intersection':
				// A value satisfying an intersection satisfies every part, so one object-ish part is enough
				// to make it an object -- unless another part makes it a PRIMITIVE (a branded
				// `string & {brand}`), where truthiness is still the primitive's own. An interface that
				// `extends` another resolves to exactly this (`FunctionType` = `{type:'function'} & CallSig`).
				return r.types.some(m => alwaysTruthy(m, scope))
					&& !r.types.some(m => ['ref', 'literal'].includes(T.resolve(scope, m).type));
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

	// Truthiness of a value whose physical slot is a boxed `any`, decided at RUNTIME -- `guard()`'s own
	// `node && typeof node === 'object' && ...` is the shape, and there the checker's type really is `any`,
	// so `alwaysTruthy` can never answer. `ref.test` against the boxes a scalar takes on entering an `any`
	// slot (`coerceTop`) separates the falsy candidates from a real object, which is unconditionally truthy.
	// A `bigint` shares `arr:i32` with `Int32Array` (see `typeofHeapType`) so it reaches the object arm:
	// `0n` in a dynamic slot reads as truthy, the one wrong answer this cascade can give.
	function emitAnyTruthy(got: WasmType, ctx: FunctionContext): void {
		// Always the NULLABLE slot: a non-nullable local is not defaultable, and a null test costs nothing
		// to skip below when `got` already rules null out.
		const tmp		= ctx.temp(`$anytruthy$${optionalTempCounter++}`, REF_ANY_NULLABLE);
		const boxI32	= ensureBoxType('i32');
		const boxF64	= ensureBoxType('f64');
		const str		= ensureArrayType('i16');
		ctx.emit(I.local.set(tmp));

		const arms: (() => void)[][] = [
			// A boxed `i32` is a `boolean` or an `i32`-kind number, and `0` is the falsy one for both.
			[()	=> ctx.emit(I.local.get(tmp), I.ref.test(boxI32)),
			()	=> ctx.emit(I.local.get(tmp), I.ref.cast(boxI32), I.struct.get(boxI32, 0), I.i32.const(0), I.i32.ne)],
			// `abs(x) > 0`, for the same NaN/`-0` reasons the bare-`f64` case above gives.
			[()	=> ctx.emit(I.local.get(tmp), I.ref.test(boxF64)),
			()	=> ctx.emit(I.local.get(tmp), I.ref.cast(boxF64), I.struct.get(boxF64, 0), I.f64.abs, I.f64(0), I.f64.gt)],
			// A string is falsy when EMPTY -- same `arr:i16` test the checker-typed path above makes statically.
			[()	=> ctx.emit(I.local.get(tmp), I.ref.test(str)),
			()	=> ctx.emit(I.local.get(tmp), I.ref.cast(str), I.array.len, I.i32.const(0), I.i32.ne)],
		];
		if (typeof got === 'object' && got.nullable)
			arms.unshift([() => ctx.emit(I.local.get(tmp), I.ref.is_null), () => ctx.emit(I.i32.const(0))]);

		// Nested `if`s, innermost last: everything that matched no box is a real object/array/closure.
		const chain = (i: number): void => {
			if (i === arms.length)
				return ctx.emit(I.i32.const(1));
			arms[i][0]();
			const _old = ctx.swapOut();
			arms[i][1]();
			const _then = ctx.swapOut();
			chain(i + 1);
			ctx.emit(I.if('i32', _then, ctx.swapOut(_old)));
		};
		chain(0);
	}

	function emitTruthy(e: Expr, ctx: FunctionContext): void {
		// In a CONDITION, `a && b` only has to decide the branch -- both readings of it agree there, so this
		// keeps the cheap boolean lowering rather than materialising the operand `case 'binary'` now yields
		// and testing that. It also means neither side needs a representable value type here.
		if (e.type === 'binary' && (e.operator === '&&' || e.operator === '||')) {
			emitTruthy(e.left, ctx);
			const _old = ctx.swapOut();
			inNarrowed(e.left, e.operator === '&&', ctx, () => emitTruthy(e.right, ctx));
			ctx.emit(e.operator === '&&'
				? I.if('i32', ctx.swapOut(_old), [I.i32.const(0)])
				: I.if('i32', [I.i32.const(1)], ctx.swapOut(_old)));
			return;
		}
		emitTruthyOf(emitExpr(e, ctx), checkerTypeOf(unwrapAs(e), ctx.scope), ctx);
	}

	// The truthiness test for a value ALREADY on the stack, of physical type `got` and checker type `t`.
	// Split out of `emitTruthy` so `&&`/`||` can test their left operand after teeing it into a local --
	// re-emitting the expression would evaluate its side effects twice.
	function emitTruthyOf(gotIn: WasmType, t: Type, ctx: FunctionContext): void {
		let got = gotIn;
		// A boxed primitive (`number | undefined`, `boolean | null`) has no truthiness of its own -- unbox
		// it and test the underlying scalar. A NULLABLE one tests for null first and answers falsy, which
		// is what JS says: `r ? a : b` on an omitted optional parameter (`r?: number`) is entirely
		// ordinary, and used to dereference the null box. Same shape the nullable-string case below uses.
		const box = unboxedPrimitive(got);
		if (box) {
			if (typeof got === 'object' && got.nullable) {
				const tmp = ctx.declareLocal(`$numtruthy$${optionalTempCounter++}`, got);
				ctx.emit(I.local.tee(tmp.index), I.ref.is_null);
				const old = ctx.swapOut();
				ctx.emit(I.i32.const(0));
				const _then = ctx.swapOut();
				ctx.emit(I.local.get(tmp.index));
				coerceTop(got, ctx, box.kind);
				emitTruthyOf(box.kind, t, ctx);
				ctx.emit(I.if('i32', _then, ctx.swapOut(old)));
				return;
			}
			coerceTop(got, ctx, box.kind);
			got = box.kind;
		}
		switch (got) {
			case 'u32':
			case 'i32': return;
			case 'u64':
				got = 'i64';
				//fallthrough
			case 'i64': ctx.emit(I[got](0), I[got].ne); return;
			// `abs(x) > 0`, not `x != 0`: NaN is FALSY in JS, but wasm's `ne` is true for an unordered
			// compare, so a bare `x != 0` called it truthy. `abs` keeps NaN NaN and `gt` is false for it,
			// which also collapses `-0` correctly -- and needs no scratch local, unlike `x != 0 && x == x`.
			case 'f64':
			case 'f32': ctx.emit(I[got].abs, I[got](0), I[got].gt); return;
		}
		// A string is falsy when EMPTY, so it tests its own length rather than its reference. A nullable one
		// is falsy when null too, and `array.len` would trap there -- hence the null test first.
		if (T.isStringLike(t, ctx.scope) && typeof got === 'object' && 'arr' in got) {
			if (got.nullable) {
				const tmp = ctx.declareLocal(`$strtruthy$${optionalTempCounter++}`, got);
				ctx.emit(I.local.tee(tmp.index), I.ref.is_null);
				const old = ctx.swapOut();
				ctx.emit(I.i32.const(0));
				const _then = ctx.swapOut();
				ctx.emit(I.local.get(tmp.index), I.ref.as_non_null, I.array.len, I.i32.const(0), I.i32.ne);
				ctx.emit(I.if('i32', _then, ctx.swapOut(old)));
			} else {
				ctx.emit(I.array.len, I.i32.const(0), I.i32.ne);
			}
			return;
		}
		// A real wasm ARRAY slot holds an array whatever the checker's own type degraded to, and an array is
		// truthy -- so this is a null test too. `arr:i16` is the exception: a string shares that exact
		// physical form and `''` is falsy, so that one stays decided from the checker's type, above.
		if (typeof got === 'object' && 'arr' in got && got.arr !== 'i16') {
			if (got.nullable)
				ctx.emit(I.ref.is_null, I.i32.eqz);
			else
				ctx.emit(I.drop, I.i32.const(1));
			return;
		}
		// A real object/array/closure reference is always truthy in JS -- only null/undefined isn't -- so
		// `if (obj)`/`obj ? a : b` is exactly a null test, and a non-nullable one is unconditionally true
		// (the value still has to be evaluated for its side effects, hence the `drop`). A boxed `any` stays
		// excluded: truthiness is a property of the VALUE there (it could be holding `0` or `''`).
		// ...and a boxed `any` slot is that same null test whenever the CHECKER's type says every non-null
		// thing it can hold is an object/array/function (`alwaysTruthy`). `Stmt | undefined` is the common
		// case: the physical type collapsed to `any` because the union's members differ physically, not
		// because the value could be a primitive.
		if (typeof got === 'object' && (!('ref' in got && (got.ref === 'any' || got.ref === 'exn'))
				? !T.isAny(T.resolveOwn(t, ctx.scope))
				: alwaysTruthy(t, ctx.scope))) {
			if (got.nullable)
				ctx.emit(I.ref.is_null, I.i32.eqz);
			else
				ctx.emit(I.drop, I.i32.const(1));
			return;
		}
		// A genuinely dynamic `any` slot -- the checker's type rules nothing out, so decide it at runtime.
		if (typeof got === 'object' && 'ref' in got && got.ref === 'any') {
			emitAnyTruthy(got, ctx);
			return;
		}
		throw `'${T.typeKey(t)}' (${wasmTypeKey(got)}) cannot be used as a boolean condition`;
	}

	// Shared by every optional (`?.`) lowering -- `objectExpr` must only ever be evaluated once, so this
	// materializes it into a scratch local up front and hands that off to `emitOptionalGuard`.
	function emitOptionalAccess(ctx: FunctionContext, objWtype: WasmType, resultWtype: WasmType, readCore: (objLocal: number) => void): WasmType {
		const objLocal = ctx.temp(`$opt$obj$${optionalTempCounter++}`, objWtype);
		ctx.emit(I.local.set(objLocal), I.local.get(objLocal), I.ref.is_null);
		const _old = ctx.swapOut();
		ctx.emit(I.ref.null(heapTypeIndexOf(resultWtype)));
		const _then = ctx.swapOut();
		readCore(objLocal);
		ctx.emit(I.if(toValType(resultWtype), _then, ctx.swapOut(_old)));
		return resultWtype;
	}

	// Pushes `want`'s own zero/default value -- an array-literal hole (`[1, , 3]`) reads back as this,
	// close enough to real JS's own "hole reads as `undefined`" for a fixed-element-kind array (there's no
	// way to represent a genuinely distinct "empty" slot here). A non-nullable ref/array/closure element
	// has no such value at all -- same "no defaultable zero for a non-null ref" restriction an object-typed
	// class field already has (`ensureCtor`'s own `struct.new` vs. `struct.new_default` split).
	function emitDefaultValue(want: WasmType, ctx: FunctionContext): void {
		if (typeof want === 'string') {
			switch (want) {
				case 'f64': ctx.emit(I.f64.const(0)); return;
				case 'f32': ctx.emit(I.f32.const(0)); return;
				case 'i32': case 'u32': ctx.emit(I.i32.const(0)); return;
				case 'i64': ctx.emit(I.i64.const(0n)); return;
			}
		} else if (want.nullable) {
			ctx.emit(I.ref.null(heapTypeIndexOf(want)));
			return;
		} else if ('ref' in want && want.ref === 'any') {
			// A non-nullable `any` slot has no `null` to fall back on -- box an arbitrary placeholder
			// instead (a real boxed value is already a valid `anyref`, no further coercion needed).
			// Reached by a generic type parameter substituted with `any` in place of an otherwise-
			// unrepresentable `void` (see `compileAsyncFunc`'s own comment) -- nothing ever reads this
			// placeholder back meaningfully, only that a real value fills the slot.
			ctx.emit(I.f64.const(0), I.struct.new(ensureBoxType('f64')));
			return;
		}
		throw "an array literal hole needs a nullable or scalar element type";
	}

	// Shared by array literals and `new Uint8Array([...])` -- both coerce every plain element to `want`,
	// a hole (`emitDefaultValue`, above) included. A spread element forces the slower
	// `emitArrayElementsWithSpread` path (runtime length, not `array.new_fixed`'s compile-time count).
	// `elementTsType`: the array's own real TS element type (e.g. `Expr`, from `case 'array'`'s own
	// `ctx.contextualReturn`), when known -- reset as `ctx.contextualReturn` around each individual
	// element's own compilation (see that field's own comment), so a generic call used as an element
	// (`[makeRule(() => ({...}))]`) can contextually infer its own type param from it. `undefined` for
	// anything without a known one (a tuple's own per-position type doesn't come through this path at
	// all, and `new Uint8Array([...])` never has one either) -- every existing call site keeps working
	// unchanged.
	function emitArrayElements(elements: readonly (Expr | undefined)[], ctx: FunctionContext, want: WasmType, kind: WasmElementI, typeIndex: number, elementTsType?: Type): void {
		const emitElement = (el: Expr) => {
			const saved = ctx.contextualReturn;
			ctx.contextualReturn = elementTsType;
			emitAs(el, ctx, want);
			ctx.contextualReturn = saved;
		};
		if (elements.some(el => el?.type === 'spread')) {
			// A `[...]` array literal with at least one spread element. Every element is evaluated exactly once, in
			// source order, into a scratch local before anything is allocated (side effects must not run twice). The real array is then `array.new_default`-allocated to the true runtime total and filled in a second pass.
			type Part = { spread: false; value: number } | { spread: true; src: number; len: number };
			const parts: Part[] = [];

			elements.forEach((el, i) => {
				if (!el) {
					emitDefaultValue(want, ctx);
					const value = ctx.temp(`$spread$elem$${i}`, want);
					ctx.emit(I.local.set(value));
					parts.push({ spread: false, value });
				} else if (el.type === 'spread') {
					const srcKind = objectArrayKind(el.operand, ctx);
					if (srcKind !== kind)
						throw 'a spread element in an array literal must be an array of the same element type';
					emitAs(el.operand, ctx, ARR_WTYPE[srcKind]);
					const src = ctx.temp(`$spread$src$${i}`, ARR_WTYPE[srcKind]);
					const len = ctx.temp(`$spread$len$${i}`, 'i32');
					ctx.emit(I.local.set(src), I.local.get(src), I.array.len, I.local.set(len));
					parts.push({ spread: true, src, len });
				} else {
					emitElement(el);
					const value = ctx.temp(`$spread$elem$${i}`, want);
					ctx.emit(I.local.set(value));
					parts.push({ spread: false, value });
				}
			});

			ctx.emit(I.i32.const(parts.filter(p => !p.spread).length));
			for (const p of parts) {
				if (p.spread)
					ctx.emit(I.local.get(p.len), I.i32.add);
			}
			const dst		= ctx.temp('$spread$dst', ARR_WTYPE[kind]);
			const offset	= ctx.temp('$spread$offset', 'i32');
			ctx.emit(I.array.new_default(typeIndex), I.local.set(dst), I.i32.const(0), I.local.set(offset));

			for (const p of parts) {
				if (p.spread) {
					ctx.emit(
						I.local.get(dst), I.local.get(offset),
						I.local.get(p.src), I.i32.const(0), I.local.get(p.len),
						I.array.copy(typeIndex, typeIndex),
						I.local.get(offset), I.local.get(p.len), I.i32.add, I.local.set(offset)
					);
				} else {
					ctx.emit(
						I.local.get(dst), I.local.get(offset), I.local.get(p.value),
						I.array. set(typeIndex),
						I.local.get(offset), I.i32.const(1), I.i32.add, I.local.set(offset)
					);
				}
			}
			ctx.emit(I.local.get(dst));

		} else {
			for (const el of elements) {
				if (el)
					emitElement(el);
				else
					emitDefaultValue(want, ctx);
			}
			ctx.emit(I.array.new_fixed(typeIndex, elements.length));
		}
	}

	// A `bigint` literal's limbs, in exactly the form `lib/bigint.ts` reads back: little-endian `u32`,
	// TWO'S COMPLEMENT (not sign-magnitude), sign-extended so the top limb's high bit IS the sign, and
	// trimmed the way `bigTrim` trims -- no top limb that merely repeats the sign of the one below it.
	function bigintLimbs(v: bigint): number[] {
		const limbs: number[] = [];
		let x = v;
		if (v >= 0n) {
			while (x > 0n) {
				limbs.push(Number(x & 0xffffffffn));
				x >>= 32n;
			}
			// `0n`, and a value whose top limb would otherwise read as negative, both need a limb of room.
			if (!limbs.length || (limbs[limbs.length - 1] & 0x80000000))
				limbs.push(0);
		} else {
			// `>>` on a negative bigint is arithmetic in JS, so this converges on `-1n`, which is exactly
			// the infinite sign extension the encoding wants.
			while (x < -1n) {
				limbs.push(Number(x & 0xffffffffn));
				x >>= 32n;
			}
			if (!limbs.length || !(limbs[limbs.length - 1] & 0x80000000))
				limbs.push(0xffffffff);
		}
		return limbs;
	}

	function emitInline(name: string, inline: Inline, args: Expr[], ctx: FunctionContext): WasmType {
		if (args.length !== inline.params.length)
			throw `'${name}' takes exactly ${inline.params.length} argument(s)`;
		args.forEach((a, i) => emitAs(a, ctx, inline.params[i]));
		ctx.emit(...inline.inline);
		return inline.result;
	}

	// Emits a call's arguments, shared by every call site (`emitCall`/`emitMethodCall`/`new`/a closure
	// value's own call, etc). A rest param's trailing call-site arguments (a compile-time-known count in
	// this subset) bundle into one array via `emitArrayElements`, instead of a fixed one-argument-per-param
	// match -- and `emitArrayElements` already handles a spread element wholesale (same machinery an array
	// *literal*'s own `[...a, b]` uses), so a spread argument Just Works once it lands in that trailing
	// portion. The one thing this can't do: a spread crossing into the *fixed* portion (`f(...a, b)`) --
	// its length isn't known until runtime, so there's no way to know how many of the fixed params it
	// fills. Every caller used to duplicate (inconsistently, some not at all) an "any spread anywhere is
	// rejected" check of its own; centralized here instead, precisely scoped to what's actually unsupported.
	// A default value that reads an earlier parameter (`b.length`) is re-emitted at the call site just
	// like a plain literal default -- but the *identifier* naming that earlier parameter obviously can't
	// resolve against the call site's own scope (it means something else there, or nothing at all), so
	// every reference to it is rewritten to the scratch local `emitCallArgs` binds that parameter's real
	// value into first. Scoped to exactly the grammar `isReemittableDefault` accepts (identifier, or a
	// non-optional property-read chain off one) -- nothing here needs to handle anything wider.
	function substituteEarlierParamRefs(e: Expr, rename: ReadonlyMap<string, string>): Expr {
		const sub = (x: Expr) => substituteEarlierParamRefs(x, rename);
		switch (e.type) {
			case 'identifier': {
				const to = rename.get(e.name);
				return to ? { ...e, name: to } : e;
			}
			case 'member':		return { ...e, object: sub(e.object) };
			// The operator shapes `isReemittableDefault` accepts must be descended into as well, or the
			// `a` in `b = a * 2` stayed pointing at a name the call site has never heard of.
			case 'binary':		return { ...e, left: sub(e.left), right: sub(e.right) };
			case 'unary':		return { ...e, operand: sub(e.operand) };
			case 'conditional':	return { ...e, test: sub(e.test), consequent: sub(e.consequent), alternate: sub(e.alternate) };
			case 'array':		return { ...e, elements: e.elements.map(el => el && el.type !== 'spread' ? sub(el) : el) };
			default:			return e;
		}
	}

	// A spread argument whose expression has a TUPLE type has a statically known length -- and that is
	// exactly the case real TS allows in a fixed-arity call ("A spread argument must either have a tuple
	// type or be passed to a rest parameter"). Expanded into that many positional index reads, in place,
	// so nothing is reordered and the surrounding argument sequence is untouched. Restricted to an
	// expression that can be re-emitted without side effects (an identifier, or a plain property chain
	// off one), since each element re-evaluates it; anything else still gets the error below.
	function expandTupleSpreads(args: Expr[], ctx: FunctionContext): Expr[] {
		const reemittable = (e: Expr): boolean => e.type === 'identifier' || e.type === 'this'
			|| (e.type === 'member' && !e.optional && reemittable(e.object));
		return args.flatMap(a => {
			if (a.type !== 'spread' || !reemittable(a.operand))
				return [a];
			const t = T.resolve(ctx.typeScope, narrowedTypeOf(a.operand, ctx));
			if (t.type !== 'tuple')
				return [a];
			return t.elements.map((_, i): Expr => ({ type: 'index', object: a.operand, index: Literal(i) } as Expr));
		});
	}

	function emitCallArgs(label: string, params: WasmType[], defaults: (Expr | undefined)[] | undefined, hasRest: boolean, args: Expr[], ctx: FunctionContext, resolvedParams?: ResolvedParam[]): void {
		if (!hasRest) {
			if (args.some(a => a.type === 'spread'))
				args = expandTupleSpreads(args, ctx);
			if (args.some(a => a.type === 'spread'))
				throw `'${label}' takes no rest parameter -- a spread argument has nowhere to expand into`;

			if (args.length !== params.length) {
				if (args.length > params.length || !defaults)
					throw `'${label}' takes exactly ${params.length} argument(s)`;
				const missing = defaults.slice(args.length);
				if (missing.some(d => !d))
					throw `'${label}' takes exactly ${params.length} argument(s)`;

				// A default that isn't a self-contained literal must be reading an earlier parameter
				// (the only other shape `isReemittableDefault` accepts) -- bind every argument (explicit
				// or defaulted) into its own scratch local first, in declaration order, so each default
				// sees its earlier siblings' real, already-computed values exactly once, matching real
				// JS's own left-to-right default-evaluation semantics (never by re-emitting -- and so
				// re-evaluating -- the original argument expression, which could carry a side effect).
				if (missing.some(d => !isReemittableDefault(d!))) {
					if (!resolvedParams)
						throw `internal: '${label}' has a non-literal default with no resolved parameter info`;
					const rename = new Map<string, string>();
					ctx.openScope();
					const locals = resolvedParams.map((p, i) => {
						const a = i < args.length ? args[i] : substituteEarlierParamRefs(missing[i - args.length]!, rename);
						emitAs(a, ctx, params[i]);
						const name = `$default$${defaultArgTempCounter++}`;
						const local = ctx.declareLocal(name, params[i]);
						ctx.scope.addValue(name, p.tsType);
						ctx.emit(I.local.set(local.index));
						if (typeof p.key === 'string')
							rename.set(p.key, name);
						return local;
					});
					locals.forEach(local => ctx.emit(I.local.get(local.index)));
					ctx.closeScope();
					return;
				}

				args = [...args, ...missing as Expr[]];
			}
			args.forEach((a, i) => emitAs(a, ctx, params[i]));
		} else {
			const fixedCount = params.length - 1;
			if (args.length < fixedCount)
				throw `'${label}' needs at least ${fixedCount} argument(s)`;
			const fixedArgs = args.slice(0, fixedCount);
			if (fixedArgs.some(a => a.type === 'spread'))
				throw `'${label}': a spread argument can only appear among the trailing rest arguments -- its length isn't known at compile time, so it can't fill a fixed parameter position`;
			fixedArgs.forEach((a, i) => emitAs(a, ctx, params[i]));
			const restArrWtype = params[fixedCount];
			if (typeof restArrWtype === 'string' || !('arr' in restArrWtype))
				throw `internal: '${label}' rest param has a non-array type`;
			const kind = restArrWtype.arr;
			if (kind === 'i16' || kind === 'i8')
				throw `'${label}' rest param: a 'string[]'/packed-byte-array element is not supported`;
			emitArrayElements(args.slice(fixedCount), ctx, kind === 'ref' ? REF_ANY_NULLABLE : kind, kind, ensureArrayType(kind));
		}
	}

	// Dispatches every `builtins` entry, coercing args via `emitAs`; falls back to `ensureFunc` for a plain user-declared function not in `builtins` at all.
	// `typeArgs`: only ever meaningful for a plain user-declared generic function (`builtins` entries and
	// host imports are never generic) -- an explicit `identity<number>(5)` call-site type argument list, or
	// `undefined` when left implicit (the common case, inferred by `ensureGenericFunc`).
	// `homeModule`: which module's own `functionDeclByName` bucket an unqualified `name` resolves against
	// -- defaults to the calling function's own (`ctx.homeModule`); a namespace-qualified call site
	// (`NS.foo(...)`) passes the *target* module explicitly instead, so `foo` resolves against the
	// declaring file's own top level, not the caller's.
	function emitCall(name: string, args: Expr[], ctx: FunctionContext, typeArgs?: Type[], expected?: Type, homeModule: string = ctx.homeModule): WasmType {
		let decl;
		const builtin = builtins[name] ?? moduleAsmBuiltins.get(homeKey(homeModule, name));
		if (builtin) {
			const result = builtin(args.map(a => operandInfo(a, ctx)), ctx);
			if ('inline' in result)
				return emitInline(name, result, args, ctx);
			// Only a binary operator's own `builtins` entry can resolve to a `MethodDelegate` -- a bare call
			// has no receiver, so getting one here is an internal inconsistency, not a user error.
			if ('owner' in result)
				throw `internal: '${name}' resolved to a method delegate outside operator dispatch`;

			decl = result;
		} else {
			decl = functionDeclByName.get(homeKey(homeModule, name));
			// A pre-seeded host import (`LIB_HOST_IMPORTS`) has no `FunctionDecl` to compile a body from -- a missing `decl` is only a real error when `funcs` doesn't already know the name either.
			if (!decl && !funcs.has(name)) {
				// `name` may be a plain (non-namespace) `import { foo } from '...'` binding local to
				// `homeModule` -- resolve it to the declaring module and retry there, same idea as a
				// namespace-qualified call site's own `nsTarget` redirect (`case 'call'`'s member-callee
				// branch), just reached via a bare identifier instead of `NS.foo(...)`.
				const imported = namedImportsByModule.get(homeModule)?.get(name);
				if (imported && functionDeclByName.has(homeKey(imported.module, imported.name)))
					return emitCall(imported.name, args, ctx, typeArgs, expected, imported.module);
				// `C(...)` where `C` names a CLASS: the primitive wrappers are called without `new`, and
				// their constructors are the conversion (`String`'s is `return s.toString()`). Structural,
				// not a list of names. It is only as correct as the constructor is -- a constructor that
				// IGNORES its argument makes this compute the wrong value silently, which is why the
				// `wrapper/call` difftest cases exist and why each wrapper's constructor has to be real.
				const cls = ensureClass(name, undefined, ctx.scope);
				if (cls) {
					const ctor = ensureCtor(cls, args, ctx);
					emitCallArgs(`${name}'s constructor`, ctor.params, ctor.defaults, !!ctor.hasRest, args, ctx, ctor.resolvedParams);
					ctx.emit(I.call(ctor.funcIndex));
					return cls.thisWtype!;
				}
				throw `call to unknown function '${name}'`;
			}
		}

		// A pre-seeded host import (`LIB_HOST_IMPORTS`) has no `FunctionDecl` and belongs to no module: it is
		// registered under its BARE name, so it must be looked up under that name too. `ensureFunc` keys on
		// `homeKey(homeModule, name)`, which is the identity ONLY for the entry -- from any other module the
		// lookup missed and `compileFunc` then crashed on the absent decl, so no `lib/node/*` function that
		// touches WASI could be compiled at all.
		const info = decl
			? (decl.typeParams?.length
				? ensureGenericFunc(name, decl, args, typeArgs, ctx.scope, expected, homeModule)
				: ensureFunc(name, decl, homeModule))
			: funcs.get(name);
		if (!info)
			throw `call to unknown function '${name}'`;
		emitCallArgs(name, info.params, info.defaults, !!info.hasRest, args, ctx, info.resolvedParams);
		ctx.emit(I.call(info.funcIndex));
		return info.result;
	}

	// Dispatches a `receiver.name(...args)` call against any `MethodOwner` -- `inlineMethods` (checked first) splices its instructions directly into the caller with no `call` at all.
	// `receiver` is `undefined` for a namespace-style call (`Math.sqrt(x)`, `Array.alloc(n)` from inside `Array<T>`'s own methods) -- no real value to push, just a bare name used to look up `owner`.
	// `typeArgs`: an explicit `obj.method<T>(...)` call-site type argument list -- only ever meaningful for
	// a real user method call (an inline/accessor/index/operator dispatch is never independently generic).
	// `bypassVirtual`: set only by `super.method(...)`'s own call site -- by definition never virtual (see
	// that call site's own comment), regardless of whether `owner` has overriding subclasses elsewhere.
	function emitMethodCall(owner: ClassInfo, name: string, args: Expr[], ctx: FunctionContext, typeArgs?: Type[], bypassVirtual?: boolean): WasmType {
		const inline = owner.inlineMethods?.get(name);
		if (inline) {
			if (args.some(a => a.type === 'spread'))
				throw 'spread call arguments are not supported';
			return emitInline(name, inline(args.map(a => operandInfo(a, ctx)), ctx, typeArgs), args, ctx);
		}

		// `owner.decl.name`, not `owner.name` -- `hasDeclaredOverride` (like `directSubclasses` it reads)
		// is keyed by the bare declared name; `owner.name` is a generic instantiation's mangled composite
		// key instead, for a generic class (which `ensureVirtualDispatch` doesn't support -- see its own
		// header comment -- so this condition simply never matches one, rather than needing its own guard).
		const method = !bypassVirtual && !typeArgs && owner.decl.name && hasDeclaredOverride(owner.decl.name, name) ? ensureVirtualDispatch(owner, name, ctx)
			: ensureMethod(owner, name, args, ctx, typeArgs);
		if (!method) {
			// Not a declared method -- a closure-typed *field* called via member syntax ('this.step(v)')
			// is a real, general capability (not specific to generators, which are the first user of it):
			// the receiver is already on the stack, so read the field off it, then the same call_ref dance
			// the bare-identifier closure call already does (`case 'call'`).
			const fieldIndex = owner.fieldIndex.get(name);
			const fieldWtype = fieldIndex !== undefined ? owner.fields[fieldIndex].wtype : undefined;
			if (fieldWtype && typeof fieldWtype !== 'string' && 'closure' in fieldWtype) {
				const sig = fieldWtype.closure;
				const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
				ctx.emit(I.struct.get(owner.typeIndex, fieldIndex!));
				const scratch = ctx.declareLocal(`$closure$${closureCallTempCounter++}`, fieldWtype);
				ctx.emit(I.local.tee(scratch.index), I.struct.get(structTypeIndex, 1));
				emitCallArgs(name, sig.params, sig.defaults, !!sig.hasRest, args, ctx, sig.resolvedParams);
				ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
				return sig.result;
			}
			throw `unknown method '${name}' on ${owner.name}`;
		}
		emitCallArgs(name, method.params, method.defaults, !!method.hasRest, args, ctx, method.resolvedParams);
		ctx.emit(I.call(method.funcIndex));
		return method.result;
	}

	// `Object.entries(x)` -- a known, fixed-identity global intrinsic (`declare var Object: {...}` in
	// lib.d.ts, same category as `Math`, not a name to special-case the way a *user* method name would
	// be), not expressible as ordinary generic TS source at all: what fields exist depends on `x`'s own
	// concrete type at each call site, which only the compiler itself can see. For a `Map`-backed
	// dynamic object, real `entries()` already exists and is already the efficient, correct answer, so
	// this just forwards to it. For a real struct (class or plain object-shape), only the *sealed*
	// case (never subclassed elsewhere, `!everExtended`) is handled for now -- an extended class's own
	// instances may carry more fields at runtime than its static type declares, which would need the
	// same `ref.test` cascade `ensureVirtualDispatch` already uses for virtual method calls; deferred,
	// not attempted here. The sealed case needs no runtime reflection at all: `owner.fields` is a real,
	// compile-time-known list, so this synthesizes a real `[string, any][]` array literal -- one
	// `[fieldName, obj.field]` tuple per declared field -- and hands it to the ordinary array-literal
	// codegen, the same "synthesize AST, reuse existing codegen" idiom already used for spread/for-in.
	function emitObjectEntries(args: Expr[], ctx: FunctionContext): WasmType {
		if (args.length !== 1)
			throw "'Object.entries' takes exactly one argument";
		const arg	= args[0];
		const owner = ownerOf(arg, ctx);
		if (!owner)
			throw "'Object.entries' needs a known object/class type";

		if (owner.decl.name === 'Map') {
			emitAs(arg, ctx, owner.thisWtype!);
			return emitMethodCall(owner, 'entries', [], ctx);
		}
		if (owner.decl.name && everExtended.has(owner.decl.name))
			throw `'Object.entries' on '${owner.name}' isn't supported yet -- '${owner.decl.name}' may be subclassed elsewhere, and a correct result needs the receiver's real runtime type, not just its declared one`;

		const n			= closureCallTempCounter++;
		const objName	= `#objEntries$${n}`;
		const objLocal	= ctx.declareValue(objName, owner.thisWtype!, owner.thisTsType!);
		emitAs(arg, ctx, owner.thisWtype!);
		ctx.emit(I.local.set(objLocal.index));

		// The outer array's own kind is always `ref` (a `[string, T]` tuple per field, boxed regardless
		// of `T`) -- known outright, not inferred, so this calls `emitArrayElements` directly rather than
		// wrapping in an `Expr` and routing through `emitAs`/`case 'array'`'s own `arrayKindOf`/`want`
		// inference, which exists for exactly the cases where the kind *isn't* already known. Each tuple
		// element still stays a real `Expr` (`{type:'array', ...}`) rather than a second direct
		// `emitArrayElements` call: that lets the ordinary per-element `emitAs` this already goes through
		// (inside `emitArrayElements`'s own loop) delegate back to `case 'array'` for it, reusing the same
		// coercion logic every other array literal already relies on instead of duplicating it here.
		emitArrayElements(owner.fields.map((f): Expr => ({
			type: 'array',
			elements: [Literal(f.name), { type: 'member', object: { type: 'identifier', name: objName }, property: f.name }],
		})), ctx, REF_ANY_NULLABLE, 'ref', ensureArrayType('ref'));
		return ARR_WTYPE.ref;
	}

	// `Object.defineProperty(target, key, {value, ...})` -- a known global intrinsic (`isDefinePropertyCall`'s
	// own comment), checked the same way `Object.entries` is, before the generic dispatch paths. Only a
	// plain value descriptor (`{value: ...}`) is supported, never a getter/setter -- a struct field has
	// no live-computation concept at all; `enumerable`/`configurable`/`writable` are accepted but have no
	// observable effect (this compiler has no general struct-field enumeration/reflection to give them
	// one). `target` must be a plain local variable, the same one `collectDefinePropertyTargets`/
	// `case 'var_decl'`'s own extension redirect already required for its declaration to have a real
	// slot to write into at all.
	function emitObjectDefineProperty(args: Expr[], ctx: FunctionContext): WasmType {
		if (args.length !== 3)
			throw "'Object.defineProperty' takes exactly 3 arguments";
		const [targetExpr, keyExpr, descExpr] = args;
		if (targetExpr.type !== 'identifier')
			throw "'Object.defineProperty': the target must be a plain local variable";
		if (keyExpr.type !== 'literal' || typeof keyExpr.value !== 'string')
			throw "'Object.defineProperty' needs a compile-time literal string key";
		const key = keyExpr.value;
		if (descExpr.type !== 'object')
			throw "'Object.defineProperty': the descriptor must be a literal object";
		const valueProp = descExpr.properties.find((p): p is JS.Field<Type> => p.type === 'field' && p.key === 'value');
		if (!valueProp?.value)
			throw "'Object.defineProperty': only a plain value descriptor ({value: ...}) is supported, not an accessor (get/set) descriptor";

		// The target's own *real, physical* class -- not `ownerOf`'s checker-type-based resolution,
		// which only ever sees the plain base class here: `case 'var_decl'`'s own extension redirect
		// changes what this identifier's real wasm local physically is, not its checker-level TS type,
		// which has no way to express that at all.
		const local  = ctx.lookup(targetExpr.name);
		const owner  = local && typeof local.wtype !== 'string' && 'ref' in local.wtype ? ensureClass(local.wtype.ref) : undefined;
		if (!owner)
			throw `'Object.defineProperty': '${targetExpr.name}' needs a known class type`;

		const scratch = ctx.declareLocal(`$defineProperty$${closureCallTempCounter++}`, owner.thisWtype!);
		emitAs(targetExpr, ctx, owner.thisWtype!);
		ctx.emit(I.local.tee(scratch.index));

		const fieldIdx = owner.fieldIndex.get(key);
		if (fieldIdx !== undefined) {
			// Already a real declared field -- inherited from the base, or one of this class's own
			// synthesized extension fields (`ensureClassExtension`'s own comment); both are ordinary
			// struct fields by this point, no distinction needed.
			emitAs(valueProp.value, ctx, owner.fields[fieldIdx].wtype);
			ctx.emit(I.struct.set(owner.typeIndex, fieldIdx));
		} else {
			// The catch-all `Map<string, any>` extension field -- lazily allocated (nullable, see
			// `ensureClassExtension`'s own comment) on first use, then a real `.set(key, value)`, same
			// dynamic-object write a structural `{[k: string]: V}` index-signature target already uses.
			const extIdx = owner.fieldIndex.get('#ext');
			if (extIdx === undefined)
				throw `'Object.defineProperty': '${owner.name}' has no extension slot for '${key}' -- an internal inconsistency (every real defineProperty target should already have one)`;
			const mapCls = ensureClass('Map', [TS.RefType('string'), T.ANY]);
			if (!mapCls)
				throw `internal: 'Map' isn't available for '${owner.name}''s own dynamic extension`;
			ctx.emit(I.local.get(scratch.index), I.struct.get(owner.typeIndex, extIdx), I.ref.is_null);
			const _cond = ctx.swapOut();
			ctx.emit(I.local.get(scratch.index));
			const ctor = ensureCtor(mapCls, [], ctx);
			emitCallArgs(`${mapCls.name}'s constructor`, ctor.params, ctor.defaults, !!ctor.hasRest, [], ctx, ctor.resolvedParams);
			ctx.emit(I.call(ctor.funcIndex), I.struct.set(owner.typeIndex, extIdx));
			const _allocBranch = ctx.swapOut();
			ctx.emit(I.if(undefined, _cond, _allocBranch));
			ctx.emit(I.local.get(scratch.index), I.struct.get(owner.typeIndex, extIdx), I.ref.as_non_null);
			emitMethodCall(mapCls, 'set', [{ type: 'literal', value: key }, valueProp.value], ctx);
			ctx.emit(I.drop);
		}
		ctx.emit(I.local.get(scratch.index));
		return owner.thisWtype!;
	}

	// Two questions: whether the current value needs reading at all (`'none'`, only a plain `=` skips it),
	// and whether it needs preserving for `.old` (`'keep'`, only postfix `++`/`--`) or just combining once (`'discard'`, every compound op and prefix `++`/`--`) -- `'discard'` skips the extra scratch `'keep'` needs.
	function emitAssignTarget(target: Expr, ctx: FunctionContext, old: 'none' | 'discard' | 'keep'): AssignTarget {

		function captureOld(wtype: WasmType, readCore: () => void): number | undefined {
			let savedOld: number | undefined;
			if (old !== 'none') {
				readCore();
				if (old === 'keep') {
					savedOld = ctx.temp(scratchName('$old', wtype), wtype);
					ctx.emit(I.local.tee(savedOld));
				}
			}
			return savedOld;
		}
		function makeWrite(wtype: WasmType, storeCore: (val: number) => void): (tee: boolean) => number {
			return tee => {
				const val = ctx.temp(scratchName('$new', wtype), wtype);
				ctx.emit(I.local.set(val));
				storeCore(val);
				if (tee)
					ctx.emit(I.local.get(val));
				return val;
			};
		}


		// `this = expr` (only meaningful inside a `reassignsThis` method) is just one more named binding --
		// `this` parses as its own `{type:'this'}` node, not an `identifier`, so it needs its own name derivation, same as `case 'this'`'s read side.
		if (target.type === 'identifier' || target.type === 'this') {
			const name = target.type === 'this' ? 'this' : target.name;
			// A captured free variable -- no real local, no `local.tee` to lean on (wasm-GC has no `struct.tee`), so `write` goes through a `$new` scratch local, same shape as `member` below.
			const captured = ctx.closureEnv?.fields.get(name);
			if (captured) {
				const { wtype, index } = captured;
				const envLocal		= ctx.closureEnv!.envLocal;
				const envTypeIndex	= ctx.closureEnv!.envTypeIndex;
				const getField		= () => ctx.emit(I.local.get(envLocal.index), I.struct.get(envTypeIndex, index));
				// A captured CELL holds the binding, not a copy of it, so a write from in here has to go
				// through the cell -- that is the whole reason the capture is a cell (`declareCell`). The
				// env field itself is never rebound.
				if (captured.cellInner) {
					const cellType = (wtype as { typeIndex: number }).typeIndex;
					return {
						wtype: captured.cellInner,
						old: captureOld(captured.cellInner, () => { getField(); emitCellRead(cellType, captured.cellInner!, ctx); }),
						write: makeWrite(captured.cellInner, val => { getField(); ctx.emit(I.local.get(val), I.struct.set(cellType, 0)); }),
					};
				}
				return {
					wtype,
					old: captureOld(wtype, getField),
					write: makeWrite(wtype, val => ctx.emit(I.local.get(envLocal.index), I.local.get(val), I.struct.set(envTypeIndex, index))),
				};
			}

			let loc = ctx.lookup(name);
			const isGlobal = !loc;
			if (!loc)
				loc = globals.get(name);
			if (!loc) {
				// A lazily-initialized module-level value (see `lazyGlobalFor`). The old value must be read
				// through the wrapper, never straight off the slot: until the initializer has run once the
				// slot is still null. The write then goes to that same slot, so the wrapper sees it after.
				const lazy = lazyGlobalFor(name, ctx);
				if (lazy) {
					const wtype = lazy.wrapper.result;
					return {
						wtype,
						old:	captureOld(wtype, () => ctx.emit(I.call(lazy.wrapper.funcIndex))),
						write:	makeWrite(wtype, val => {
							ctx.emit(I.local.get(val));
							coerceTop(wtype, ctx, lazy.slot.wtype);
							ctx.emit(I.global.set(lazy.slot.index));
						}),
					};
				}
				throw `unresolved identifier '${name}'`;
			}
			const { wtype, index } = loc;
			// Same for this function's own celled local (`needsCell`): the wasm local holds the cell, and
			// every read and write of the NAME goes through it, or a closure capturing it sees a stale value.
			if (loc.cellInner) {
				const cellType = (wtype as { typeIndex: number }).typeIndex;
				return {
					wtype: loc.cellInner,
					old: captureOld(loc.cellInner, () => { ctx.emit(I.local.get(index)); emitCellRead(cellType, loc.cellInner!, ctx); }),
					write: makeWrite(loc.cellInner, val => ctx.emit(I.local.get(index), I.local.get(val), I.struct.set(cellType, 0))),
				};
			}
			return {
				wtype,
				old: captureOld(wtype, () => ctx.emit(isGlobal ? I.global.get(index) : I.local.get(index))),
				write(tee) {
					// Wasm has no `global.tee` (`global.set` is void) -- re-`global.get` right after when the
					// caller needs the newly-written value left on the stack too.
					if (isGlobal) {
						ctx.emit(I.global.set(index));
						if (tee)
							ctx.emit(I.global.get(index));
					} else {
						ctx.emit(tee ? I.local.tee(index) : I.local.set(index));
					}
					return index;
				},
			};

		} else if (target.type === 'member') {
			const cls = ownerOf(target.object, ctx);

			// A `set` accessor -- checked before the ordinary struct-field write, mirroring the read side's getter-probe in `case 'member'`
			if (cls?.setterNames?.has(target.property)) {
				const setSig = methodSig(cls, accessorKey('set', target.property), ctx);
				if (!setSig)
					throw `internal: setter '${target.property}' has no signature`;
				const wtype = setSig.params[0];
				const valExpr: Expr = { type: 'identifier', name: scratchName('$new', wtype) };

				// `emitAs`, not a raw `emitExpr` -- `target.object` may itself be a ref-kind array element read, boxed `anyref` regardless of its declared class (same reasoning as the plain struct-field write below).
				const objWtype = cls.thisWtype!;
				const obj = ctx.temp(scratchName('$obj', objWtype), objWtype);
				emitAs(target.object, ctx, objWtype);
				ctx.emit(I.local.set(obj));
				return {
					wtype,
					old: captureOld(wtype, () => {
						if (!cls.getterNames?.has(target.property))
							throw `'${target.property}' has no getter -- its old value can't be read for a compound assignment/'++'/'--'`;
						ctx.emit(I.local.get(obj));
						emitMethodCall(cls, accessorKey('get', target.property), [], ctx);
					}),
					write: makeWrite(wtype, () => {
						ctx.emit(I.local.get(obj));
						emitMethodCall(cls, accessorKey('set', target.property), [valExpr], ctx);
					}),
				};
			}

			const fieldIdx	= cls?.fieldIndex.get(target.property);
			if (!cls || fieldIdx === undefined)
				throw `unknown field '${target.property}'`;

			const wtype = cls.fields[fieldIdx].wtype;

			// `emitAs`, not a raw `emitExpr` -- `target.object` may be a ref-kind array element read, boxed `anyref` -- `struct.set` needs the real narrowed `(ref cls)` first, same as the read-side fix in `case 'member'`.
			const objWtype = cls.thisWtype!;
			const obj = ctx.temp(scratchName('$obj', objWtype), objWtype);
			emitAs(target.object, ctx, objWtype);
			ctx.emit(I.local.set(obj));
			return {
				wtype,
				old:	captureOld(wtype, () => ctx.emit(I.local.get(obj), I.struct.get(cls.typeIndex, fieldIdx))),
				write:	makeWrite(wtype, val => ctx.emit(I.local.get(obj), I.local.get(val), I.struct.set(cls.typeIndex, fieldIdx))),
			};
			
		} else if (target.type == 'index') {
			// Any class with its own `get(i)`/`set(i,v)` (typed-array views, or any other class using the
			// same convention -- see `methodSig`) -- real index syntax dispatched generically, not by name.
			const cls		= classOfForIndexing(target.object, ctx);
			const getSig 	= cls && methodSig(cls, 'get', ctx);
			if (cls && getSig && methodSig(cls, 'set', ctx)) {
				// `emitAs`, not a raw `emitExpr` -- same reasoning as the plain struct-field write path above.
				const objWtype = cls.thisWtype!;
				const obj = ctx.temp(scratchName('$obj', objWtype), objWtype);
				emitAs(target.object, ctx, objWtype);
				ctx.emit(I.local.set(obj));
				emitAs(target.index, ctx, getSig.params[0]);
				const indexName = scratchName('$index', getSig.params[0]);
				ctx.emit(I.local.set(ctx.temp(indexName, getSig.params[0])));
				const idxExpr: Expr = { type: 'identifier', name: indexName };
				const wtype = getSig.result;
				const valExpr: Expr = { type: 'identifier', name: scratchName('$new', wtype) };

				return {
					wtype,
					old: captureOld(wtype, () => {
						ctx.emit(I.local.get(obj));
						emitMethodCall(cls, 'get', [idxExpr], ctx);
					}),
					write: makeWrite(wtype, () => {
						ctx.emit(I.local.get(obj));
						// `storeCore`'s own contract (see `makeWrite`) is to leave nothing on the stack --
						// true for free for a `void`-returning `set(i,v)` (every array-kind class so far),
						// but `Map.set()` (real JS's own convention) returns `this` for chaining, so its
						// result needs an explicit drop here or the whole expression-statement's stack
						// balance is wrong.
						if (emitMethodCall(cls, 'set', [idxExpr, valExpr], ctx) !== 'void')
							ctx.emit(I.drop);
					}),
				};
			}

			const kind = objectArrayKind(target.object, ctx);
			// `i16`/`i8` (`string`/packed-byte storage) rejected same as `case 'index'`'s own read side.
			if (!kind || kind === 'i16' || kind === 'i8')
				throw "this operation is not supported";

			const typeIndex = ensureArrayType(kind);
			// Mirrors `case 'index'`'s own read-side result exactly -- a ref-kind array's write target is a boxed `any`, not a raw i32.
			const wtype		= kind === 'ref' ? REF_ANY_NULLABLE : kind;
			const objWtype	= emitExpr(target.object, ctx);
			const obj		= ctx.temp(scratchName('$obj', objWtype), objWtype);
			ctx.emit(I.local.set(obj));
			emitAs(target.index, ctx, 'i32');
			// Always `i32` (an array index, never anything else) -- unlike `$obj`/`$new`/`$old` here, this one genuinely can't collide across two index writes in the same function, no qualification needed.
			const idx		= ctx.temp('$index', 'i32');
			ctx.emit(I.local.set(idx));

			return {
				wtype,
				old: captureOld(wtype, () => ctx.emit(I.local.get(obj), I.local.get(idx), I.array.get(typeIndex))),
				// `wtype` -- the value on the stack was already coerced to it by the caller (`emitAssign`'s `emitAs(right, ctx, target.wtype)` or its compound-op equivalent), so no extra conversion belongs here.
				write: makeWrite(wtype, val => ctx.emit(I.local.get(obj), I.local.get(idx), I.local.get(val), I.array.set(typeIndex))),
			};
		} else {
			throw `cannot assign to ${target.type}`;
		}
	}

	// Reads `name`'s own physical storage slot (captured field or real local) exactly as-is -- never
	// unboxing a forward-cell, unlike the ordinary identifier-read case (`case 'identifier'`). The one
	// caller that needs this: `emitClosureLiteral`'s own env-capture step, which must capture a forward-
	// cell's real, shared storage itself (so a later write through it, from wherever the name's own
	// var_decl actually runs, stays visible), never a snapshot of whatever it holds right now.
	function emitRawSlot(ctx: FunctionContext, name: string): void {
		const captured = ctx.closureEnv?.fields.get(name);
		if (captured) {
			ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index), I.struct.get(ctx.closureEnv!.envTypeIndex, captured.index));
			return;
		}
		ctx.emit(I.local.get(ctx.lookup(name)!.index));
	}

	// Shared by `case 'arrow'`/`case 'function'` (an expression, `allowSelfCall: false`) and `case
	// 'function_decl'` (a statement nested in another function's body, `allowSelfCall: true`) --
	// builds the `{code, env}` closure struct and leaves it on the stack, returning its `{closure}`
	// wtype. `allowSelfCall` lifts the "can't reference own name" restriction and instead lets calls
	// to `selfName` from inside the body resolve to a direct `call` (see `ctx.selfCall`), since a
	// self-*capture* is impossible -- the struct can't be a field of itself before it exists.
	function emitClosureLiteral(
		e: TS.CallSig & {type: string, name?: string, modifiers?: string[], body?: Stmt[] | Expr },
		ctx: FunctionContext,
		allowSelfCall: boolean,
		want?: WasmType,
	): WasmType {
		if (hasMod(e, 'async'))
			throw 'an async arrow/function expression is not supported';
		if (hasMod(e, 'generator'))
			throw 'a generator function expression is not supported';
		// A closure literal written inside a non-entry module's own function body (e.g. a nested arrow
		// whose own param annotation is never separately re-checked -- `makeLibScope`'s own "muted" comment
		// documents the same class of gap) can reach here with its own param/return type annotations never
		// stamped with a `declScope` at all -- the checker's real per-statement walk is what normally does
		// that, but nothing guarantees it ran for THIS specific nested literal. `ctx.scope` is exactly the
		// right scope regardless (wherever `e` was actually written is `ctx`'s own home module) -- a no-op
		// for anything already stamped (`T.stampScope`'s own "skip if tagged" rule), so safe to call
		// unconditionally right here, before any of this literal's own types are ever asked for a wtype.
		e.params.forEach(p => p.typeAnnotation && T.stampScope(p.typeAnnotation, ctx.scope));
		if (e.returnType)
			T.stampScope(e.returnType, ctx.scope);
		// A generic closure *value* (as opposed to a generic function/method called directly, already
		// monomorphized per call site) is one physical closure that has to work across every call-site
		// instantiation -- not true per-call specialization, but for the overwhelmingly common shape
		// (a type param that only narrows an already-concrete bound, for the *caller's* own type
		// precision, never actually consumed in a param-specific way -- e.g. walker.ts's own
		// `<T extends U>(t?: T) => on(t, process)`) it costs nothing at all: each type param is
		// substituted with its own upper bound (defaulting to `any`/boxed only when unconstrained)
		// throughout params/return type/body alike, via the same structural substitution a generic
		// function/method's own per-instantiation compilation already uses -- since a bounded value is
		// already physically a valid value of its bound (real wasm-GC struct subtyping, the same
		// "upcast is free" fact `coerceTop` already relies on everywhere else), nothing about the
		// compiled body needs to change at all.
		if (e.typeParams?.length) {
			const map = new Map(e.typeParams.map(p => [p.name, p.constraint ?? T.ANY]));
			e = {
				...e,
				typeParams: undefined,
				params: e.params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteType(p.typeAnnotation, map) } : p),
				returnType: e.returnType && T.substituteType(e.returnType, map),
				body: substituteTypeParams(e.body ?? [], map),
			};
		}

		const body	= e.body ?? [];
		if (e.name && !allowSelfCall && walkB(body, undefined, (e, process) => e.type === 'identifier' ? true : process(e)))
			throw `a named function expression referencing its own name ('${e.name}') is not supported`;

		// The call site's own expected closure signature (`want`, when this literal is being compiled
		// directly as a call argument -- `case 'arrow'`/`case 'function'` forward whatever `want` they
		// were given) wins over this literal's own `e.returnType`-derived guess, when it's available:
		// found via `Rule([...], $ => ({type: 'spread', ...}))`-shaped calls (ts-parser.ts/js-parser.ts/
		// binary-libs/wasm.ts, hundreds of real sites) -- an arrow with no explicit return-type annotation
		// still gets *a* `e.returnType` (the checker's own structural/anonymous inference back-filled
		// into the same field real TS itself would have inferred, `checkFunctionBody`'s inference branch),
		// but an anonymous structural object type has no nominal identity for `typeOf` to turn into a real
		// wasm struct -- it degrades to boxed `any`, and `case 'object'` then rejects the body outright
		// ("needs a known target type") even though the caller's own declared callback signature already
		// names the exact concrete shape wanted. Safe even when the arrow *did* have a real, explicit
		// annotation: the checker already verified that's assignable to whatever the caller expects, so
		// the two physical wtypes are equivalent here anyway (this compiler's whole "upcast is free"
		// contract) -- and if a *later*, different use of the same closure value ever wants a genuinely
		// different (but still compatible) signature, `coerceTop`'s own wrapper mechanism still applies.
		const result = (want && typeof want !== 'string' && 'closure' in want ? want.closure.result : undefined) ?? (e.returnType ? typeOf(e.returnType) : 'void');
		if (!result)
			throw 'closure has an unsupported return type';

		const params = e.params.map((p): ResolvedParam => {
			if (p.default)
				throw `closure parameter '${describeBinding(p.key)}' cannot have a default value`;
			// See `closureFuncSigType`'s own identical comment -- box a real but wasm-unrepresentable
			// `void` as `any` rather than reject otherwise-valid source.
			const wt = p.typeAnnotation && typeOf(p.typeAnnotation);
			const boxed = wt === 'void' ? REF_ANY : wt;
			if (!boxed)
				throw `closure parameter '${describeBinding(p.key)}' needs an explicit number/boolean/object type`;
			// A bare `p?: T` param here just needs a nullable physical slot to receive whatever a *caller*
			// passes for an omitted argument -- omission itself is entirely the caller's own concern
			// (`closureFuncSigType`'s `defaults`, built from the field/variable's own declared TYPE, not
			// this literal), since nothing ever calls this literal's own compiled function directly while
			// skipping an argument; `call_ref` always supplies a real value for every physical param.
			return {key: p.key, wtype: hasMod(p, 'optional') ? nullableWtype(boxed) : boxed, tsType: p.typeAnnotation! };
		});
		if (e.rest?.typeAnnotation) {
			const wt = typeOf(e.rest.typeAnnotation);
			if (!wt || wt === 'void')
				throw "a closure's rest parameter needs an explicit array type";
			params.push({key: e.rest.key, wtype: wt, tsType: e.rest.typeAnnotation });
		}

		const free = new Set<string>();
		collectFreeVars(ownBoundNames(paramNames(e.params, e.rest), body, e.name), body, free);

		if (e.type !== 'arrow' && free.has('this'))
			throw "'this' inside a function expression is not supported -- only an arrow function's lexical 'this' is";

		for (const name of free) {
			// `undefined`/`NaN`/`Infinity` are always-valid identifiers `case 'identifier'`'s own codegen
			// (and `isNullLiteral`, for `undefined` specifically) handles directly, regardless of lexical
			// scope -- never real bindings `collectFreeVars` should have treated as needing capture/
			// resolution at all (a real, pre-existing gap: any of the three used inside a nested closure,
			// e.g. `extra !== undefined`, threw here unconditionally before this).
			if (name === 'undefined' || name === 'NaN' || name === 'Infinity')
				continue;
			// Module-scoped, so `resolvesGlobally` can never see them; the read site substitutes a constant.
			if ((name === '__dirname' || name === '__filename') && moduleFilename(ctx.homeModule))
				continue;
			if (!ctx.resolvesName(name) && !resolvesGlobally(ctx.homeModule, name) && !ensureForwardCell(ctx, name))
				throw `unresolved identifier '${name}'`;
		}

		// This literal's own concrete env struct type -- zero captures just reuses `$envBase`
		// directly (no distinct type, no cast needed in the compiled body either). A free name that's
		// globally resolvable (a top-level function, or a real wasm global) needs no capture slot at all
		// -- the compiled body's own ordinary `case 'identifier'` fallback reaches it directly, same as
		// from any other function's body, regardless of this closure's own lexical nesting.
		const envBase		= ensureEnvBase();
		const capturedNames = [...free].filter(name => ctx.resolvesName(name));
		const fields		= capturedNames.length ? new Map<string, { index: number; wtype: WasmType; cellInner?: WasmType }>() : undefined;
		let envTypeIndex	= envBase;
		if (fields) {
			// `rawWtype` (not `resolvedWtype`) -- a forward-cell's own real, physical storage type is
			// exactly what needs capturing here (the SHARED, mutable cell itself, so a later write
			// through it -- from wherever its own var_decl actually runs -- stays visible to this
			// capture); `cellInner`, copied alongside, lets every READ of this captured field later know
			// to unbox it back to the logical value (`case 'identifier'`'s own read path).
			envTypeIndex = addType({ final: true, supertypes: [envBase], type: { kind: 'struct', fields: capturedNames.map((name, i) => {
				const wt = ctx.rawWtype(name)!;
				const cellInner = ctx.closureEnv?.fields.get(name)?.cellInner ?? ctx.lookup(name)?.cellInner;
				fields.set(name, { index: i, wtype: wt, cellInner });
				return { type: toValType(wt), mut: true };
			}) } });
		}

		const sig: FuncSig = { params: params.map(p => p.wtype), result, hasRest: !!e.rest };
		const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
		const { funcIndex, typeIndex }	= registerFuncAtType(funcTypeIndex);
		const info: FuncInfo = { ...sig, funcIndex, typeIndex };
		closureLiterals.push(info);

		worklist.push(withCatch(() => {
			const fnCtx		= new FunctionContext(e.name ?? '<anonymous>', new Scope(libGlobal), plainReturn(result), undefined, ctx.homeModule);
			// Env param first (real wasm param index 0), then this literal's own params -- `toFuncBody`'s `numParams` assumes the first `1 + params.length` declared locals are the real wasm params, in order.
			const envParam	= fnCtx.declareLocal('#envParam', { typeIndex: envBase, nullable: false });
			const pending	= fnCtx.declareParams(params);
			// The cast-down env local (or, with no captures, just the param itself) is declared after the real params, so it's a genuine local, not mistaken for one more wasm param.
			let envLocal	= envParam;
			if (fields) {
				envLocal = fnCtx.declareLocal('#env', { typeIndex: envTypeIndex, nullable: false });
				fnCtx.emit(I.local.get(envParam.index), I.ref.cast(envTypeIndex), I.local.set(envLocal.index));
			}
			fnCtx.closureEnv = { envLocal, envTypeIndex, fields: fields ?? new Map() };
			if (allowSelfCall && e.name)
				fnCtx.selfCall = info;
			for (const name of capturedNames) {
				const tsType = ctx.scope.value(name);
				if (tsType)
					fnCtx.declareCaptured(name, tsType);
			}
			if (Array.isArray(body)) {
				fnCtx.widenedTypes = collectRangeWidenings(body, fnCtx.scope);
				fnCtx.ownBody = body;
			}
			pending.forEach(st => emitStmt(st, fnCtx));
			if (Array.isArray(body)) {
				body.forEach(st => emitStmt(st, fnCtx));
				emitTrailingUnreachable(fnCtx, result);
			} else {
				emitStmt({ type: 'return', argument: body }, fnCtx);
			}
			info.body = fnCtx.toFuncBody(1 + params.length, toValType);
		}));

		// Creation site: `struct.new` pops fields in declaration order (`ensureClosureType`'s `[code,
		// env]`), so the code pointer goes on the stack before the env struct. Each captured value is
		// read raw (`emitRawSlot`, not the ordinary identifier-read case) -- a forward-cell must be
		// captured as the cell itself (see `rawWtype`'s own comment just above), never unboxed here; a
		// capture-of-a-capture (an ordinary, non-cell name) resolves identically either way.
		ctx.emit(I.ref.func(funcIndex));
		for (const name of capturedNames) {
			if (name === 'this')
				emitExpr({ type: 'this' }, ctx);
			else
				emitRawSlot(ctx, name);
		}
		ctx.emit(fields ? I.struct.new(envTypeIndex) : I.struct.new_default(envBase));
		ctx.emit(I.struct.new(structTypeIndex));
		return { closure: sig };
	}

	// A plain named function used as a *value* -- passed as a callback, assigned, returned, etc. --
	// rather than called directly by name (`case 'call'` resolves that straight to `funcs.get(name)`,
	// no closure struct ever involved). An ordinary top-level function is compiled with no `env`
	// param at all (it captures nothing), so its own `funcIndex` can't be used directly as a closure's
	// `code` field -- that always expects `(env, ...params)`. This builds one small, shared,
	// zero-capture trampoline per function name instead: same shape `emitClosureLiteral`'s own
	// zero-capture case builds (`env` ignored, `envBase` reused directly, no distinct env type), just
	// forwarding straight through to the real, already-compiled (or newly compiled here) function.
	function ensureFunctionValueWrapper(name: string, decl: FunctionDecl, homeModule = '.'): { info: FuncInfo; structTypeIndex: number } {
		const key = homeKey(homeModule, name);
		const existing = functionValueWrappers.get(key);
		if (existing) {
			const { structTypeIndex } = ensureClosureType({ params: existing.params, result: existing.result, hasRest: existing.hasRest });
			return { info: existing, structTypeIndex };
		}
		const target = funcs.get(key) ?? compileFunc(name, decl, homeModule);
		if (!target)
			throw `'${name}' can't be used as a value`;

		const sig: FuncSig = { params: target.params, result: target.result, hasRest: target.hasRest };
		const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
		const { funcIndex, typeIndex } = registerFuncAtType(funcTypeIndex);
		const info: FuncInfo = { ...sig, funcIndex, typeIndex, defaults: target.defaults };
		closureLiterals.push(info);
		functionValueWrappers.set(key, info);

		worklist.push(() => {
			const wctx		= new FunctionContext(`<fnvalue>.${name}`.replace(/[^a-zA-Z0-9_]/g, '_'), new Scope(libGlobal), plainReturn(target.result), undefined);
			wctx.declareLocal('#envParam', { typeIndex: ensureEnvBase(), nullable: false });
			const argLocals = target.params.map((p, i) => wctx.declareLocal(`$arg$${i}`, p));
			argLocals.forEach(l => wctx.emit(I.local.get(l.index)));
			wctx.emit(I.call(target.funcIndex));
			info.body = wctx.toFuncBody(1 + argLocals.length, toValType);
		});
		return { info, structTypeIndex };
	}

	// A closure *value* whose own concrete signature doesn't match some slot it's being coerced into, but
	// real TS/JS would still allow it -- either a covariant return (`(x: number) => number` fitting
	// `(x: number) => number | undefined`, the common shape a mapped-type's own homomorphic value type
	// produces: `Partial<{...}>`'s `?`-optional value widens every property's own type with `| undefined`,
	// but a real property/callback value written against one specific key rarely bothers writing that
	// itself), or fewer declared params than `wantSig` offers (the ordinary JS callback convention --
	// `arr.map(x => x*2)` never declares `index`/`array` at all, found via `lib/map.ts`'s own `entries()`
	// calling `Array<K>.map((k, i) => ...)`, itself two short of the real 3-param `callbackfn`). Unlike a
	// scalar (`coerceTop` alone can convert one already-on-the-stack value in place), a closure's own
	// compiled function signature is fixed forever at its own `funcTypeIndex` -- there's no in-place
	// conversion, only wrapping: one small, shared trampoline per (source signature, wanted signature)
	// pair, not one per use site, that declares `wantSig`'s full param list, forwards only the leading
	// `gotSig.params.length` of them through to the original closure (silently dropping the rest, same as
	// real JS ignoring the trailing call arguments a shorter callback never bound), and coerces just the
	// return value. A mismatch in a *shared* leading param's own type (contravariant widening) isn't
	// attempted here -- narrower in scope than full function-type variance, but covers the shape that's
	// actually shown up so far.
	function ensureClosureCoercionWrapper(gotSig: FuncSig, wantSig: FuncSig): { info: FuncInfo; wantStructTypeIndex: number; envTypeIndex: number } {
		const key = `(${gotSig.params.map(wasmTypeKey).join(',')})=>${wasmTypeKey(gotSig.result)}=>(${wantSig.params.map(wasmTypeKey).join(',')})=>${wasmTypeKey(wantSig.result)}`;
		const existing = closureCoercionWrappers.get(key);
		if (existing)
			return existing;

		const { funcTypeIndex: gotFuncTypeIndex, structTypeIndex: gotStructTypeIndex } = ensureClosureType(gotSig);
		const { funcTypeIndex: wantFuncTypeIndex, structTypeIndex: wantStructTypeIndex } = ensureClosureType(wantSig);
		const { funcIndex, typeIndex } = registerFuncAtType(wantFuncTypeIndex);
		const info: FuncInfo = { ...wantSig, funcIndex, typeIndex };
		closureLiterals.push(info);
		// A dedicated one-field env struct (real subtype of `envBase`, like any other closure's own capture
		// struct) holding just the original closure value -- the {code,env} pair itself is *not* a subtype of
		// `envBase` (it has no supertypes at all, see `ensureClosureType`), so it can't be used as this
		// wrapper's own env directly the way `emitClosureLiteral`'s zero-capture case reuses `envBase` as-is.
		const envTypeIndex = addType({ final: true, supertypes: [ensureEnvBase()], type: { kind: 'struct', fields: [
			{ type: toValType({ typeIndex: gotStructTypeIndex, nullable: false }), mut: false },
		] } });
		const result = { info, wantStructTypeIndex, envTypeIndex };
		closureCoercionWrappers.set(key, result);

		worklist.push(() => {
			const wctx		= new FunctionContext(`<coerce>.${key}`.replace(/[^a-zA-Z0-9_]/g, '_'), new Scope(libGlobal), plainReturn(wantSig.result), undefined);
			const envParam	= wctx.declareLocal('#envParam', { typeIndex: ensureEnvBase(), nullable: false });
			// Declares `wantSig`'s *full* param list (matching the wrapper's own real arity, since a caller
			// invoking through `wantFuncTypeIndex` always passes all of them) -- only the leading
			// `gotSig.params.length` are ever read, the rest just go unused, same as a real JS callback
			// simply never binding its own trailing, never-declared params.
			const argLocals	= wantSig.params.map((p, i) => wctx.declareLocal(`$arg$${i}`, p));
			const env		= wctx.declareLocal('#env', { typeIndex: envTypeIndex, nullable: false });
			wctx.emit(I.local.get(envParam.index), I.ref.cast(envTypeIndex), I.local.set(env.index));
			wctx.emit(I.local.get(env.index), I.struct.get(envTypeIndex, 0), I.struct.get(gotStructTypeIndex, 1));
			// Each argument coerced from what the CALLER passes to what the callback declared -- see the
			// `paramFits` guard: for a reference that is a `ref.cast`, and a no-op when the two agree.
			argLocals.slice(0, gotSig.params.length).forEach((l, i) => {
				wctx.emit(I.local.get(l.index));
				coerceTop(wantSig.params[i], wctx, gotSig.params[i]);
			});
			wctx.emit(I.local.get(env.index), I.struct.get(envTypeIndex, 0), I.struct.get(gotStructTypeIndex, 0), I.call_ref(gotFuncTypeIndex));
			coerceTop(gotSig.result, wctx, wantSig.result);
			info.body = wctx.toFuncBody(1 + argLocals.length, toValType);
		});
		return result;
	}

	// Real `ToInt32`: truncate, then keep the low 32 bits. `2147483648 | 0` is -2147483648 and
	// `(4294967296 + 5) | 0` is 5; the plain saturating `i32.trunc_sat_f64_s` that `coerceTop` uses
	// everywhere else answers `i32::MAX` to both. Scoped to the bitwise operators, which is exactly where
	// JS specifies `ToInt32` -- saturation stays the rule for an index or a length, deliberately, for the
	// reasons `coerceTop`'s own comment gives. A non-finite input has no meaningful `i64` truncation, so
	// it is tested for and answered as 0 directly, which is also what JS says.
	function emitToInt32(e: Expr, ctx: FunctionContext): void {
		emitAs(e, ctx, 'f64');
		const tmp = ctx.temp(`$toint32$${optionalTempCounter++}`, 'f64');
		ctx.emit(I.local.set(tmp), I.local.get(tmp), I.f64.abs, I.f64.const(Infinity), I.f64.lt);
		const _old = ctx.swapOut();
		ctx.emit(I.local.get(tmp), I.i64.trunc_sat_f64_s, I.i32.wrap_i64);
		const _then = ctx.swapOut();
		ctx.emit(I.i32.const(0));
		ctx.emit(I.if(toValType('i32'), _then, ctx.swapOut(_old)));
	}

	const BITWISE_METHODS = new Set(['and', 'or', 'xor', 'shl', 'shr_s', 'shr_u']);

	// A numeric/bitwise binary op's instructions as data (`Inline`), keyed by `BINARY_OP_NAMES`'s method name
	function numericOpInline(method: string, a: WasmType | undefined, b: WasmType | undefined, ctx: FunctionContext): Inline {
		const at = scalarKind(a), bt = scalarKind(b);
		const t	=	at === 'i64' || bt === 'i64' ? 'i64'
			:		(at === 'i32' || at === 'u32') && (bt === 'i32' || bt === 'u32') ? 'i32'
			:		at === 'f32' && bt === 'f32' ? 'f32'
			:		'f64';

		switch (method) {
			case 'add': case 'sub': case 'mul':
				return { params: [t, t], result: t, inline: [I[t][method]] };
			// Always float division, matching real JS `number` semantics -- never truncating, never traps on `0/0`, regardless of the operands' own transient wasm representation
			case 'div':
				return t === 'f32'
					? { params: ['f32', 'f32'], result: 'f32', inline: [I.f32.div] }
					: { params: ['f64', 'f64'], result: 'f64', inline: [I.f64.div] };
			case 'mod':
				return builtins.__towasm_mod!([{wtype: t}], ctx) as Inline;
			case 'and': case 'or': case 'xor': case 'shl': case 'shr_s':
				return { params: ['i32', 'i32'], result: 'i32', inline: [I.i32[method]] };
			case 'shr_u':
				return { params: ['i32', 'i32'], result: 'u32', inline: [I.i32[method]] };

			case 'eq': case 'ne':
			case 'lt': case 'gt': case 'le': case 'ge':
				if ((t === 'i32' || t === 'i64')) {
					return method === 'ne' || method === 'eq'
						? { params: [t, t], result: 'i32', inline: [I[t][method]] }
						: { params: [t, t], result: 'i32', inline: [I[t][`${method}_s`]] };
				}
				return { params: [t, t], result: 'i32', inline: [I[t][method]] };
		}
		throw `internal: unsupported compound-assignment method '${method}'`;
	}

	// `want`, when passed, is a hint only -- lets a literal pick its physical representation directly instead
	// of `coerceTop` immediately converting it back. The returned `WasmType` is always the actual physical type left on the stack.
	function emitExpr(e: Expr, ctx: FunctionContext, want?: WasmType): WasmType {
		try { switch (e.type) {
			case 'literal':
				switch (typeof e.value) {
					case 'number':
						// `typeof want === 'string'`: the i32 shortcut only makes sense when the caller wants a
						// plain scalar -- `want` being an object (e.g. boxing into `any`) means a bare `'i32'` here would be indistinguishable from a real boolean once `coerceTop` has to pick a box.
						if (typeof want === 'string' && want !== 'f64' && e.value === (e.value | 0)) {
							ctx.emit(I.i32.const(e.value));
							return 'i32';
						}
						ctx.emit(I.f64.const(e.value));
						return 'f64';

					case 'boolean':
						ctx.emit(I.i32.const(e.value ? 1 : 0));
						return 'i32';

					case 'string':
						emitStringConst(e.value, ctx);
						return ARR_WTYPE.i16;

					case 'bigint': {
						// A `bigint` VALUE is a two's-complement little-endian `u32[]` (see `typeOf`, and
						// `lib/bigint.ts`'s own limb walks) -- so that is what a literal has to build. It
						// used to emit `i64.const` and claim `'i64'`, disagreeing with every other bigint
						// in the compiler: `10n - 4n` reinterpreted an i64 value as a limb array and gave
						// -1, `Number(5n)` could not convert at all, and anything past 64 bits truncated.
						// A real `i64` slot (`__towasm_mulWide`'s declared params, a global on an i64 slot)
						// still gets the constant directly -- that is the one place the two agree.
						if (want === 'i64') {
							ctx.emit(I.i64.const(e.value));
							return 'i64';
						}
						const limbs = bigintLimbs(e.value);
						for (const l of limbs)
							ctx.emit(I.i32.const(l | 0));
						ctx.emit(I.array.new_fixed(ensureArrayType('i32'), limbs.length));
						return ARR_WTYPE.i32;
					}

					case 'object':
						if (e.value instanceof RegExp) {
							// desugars to an ordinary `new RegExp(source, flags)` against `lib/regexp.ts`'s own self-hosted class
							return emitExpr({
								type: 'new',
								callee: { type: 'identifier', name: 'RegExp' },
								arguments: [Literal(e.value.source), Literal(e.value.flags)],
							}, ctx, want);
						}
						if (Array.isArray(e.value)) {
							if (e.value.length === 1 && !e.value[0].exp) {
								emitStringConst(e.value[0].str, ctx);
								return ARR_WTYPE.i16;
							}

							for (const p of e.value)
								emitStringConst(p.str, ctx);
							const hasTrailingLiteral = !e.value[e.value.length - 1].exp;
							if (!hasTrailingLiteral)
								emitStringConst('', ctx);
							ctx.emit(I.array.new_fixed(ensureArrayType('ref'), e.value.length + (hasTrailingLiteral ? 0 : 1)));
							let valueCount = 0;
							for (const p of e.value) {
								if (p.exp) {
									emitAs(p.exp, ctx, REF_ANY);
									valueCount++;
								}
							}
							ctx.emit(I.array.new_fixed(ensureArrayType('ref'), valueCount));
							const decl = LIB_DECL_MAP.get('stringTemplate');
							if (decl && decl.type === 'function_decl') {
								const info = ensureFunc('stringTemplate', decl);
								if (info)
									ctx.emit(I.call(info.funcIndex));
							}
							return ARR_WTYPE.i16;
						}
						throw `unsupported literal type '${typeof e.value}'`;

					default:
						throw `unsupported literal type '${typeof e.value}'`;
				}

			case 'identifier': {
				// There's no way to write NaN or Infinity without using themselves
				if (e.name === 'NaN') {
					ctx.emit(I.f64.const(NaN));
					return 'f64';
				}
				if (e.name === 'Infinity') {
					ctx.emit(I.f64.const(Infinity));
					return 'f64';
				}
			}
			//fall through
			case 'this': {
				const name = e.type === 'this' ? 'this' : e.name;
				// `this` isn't a real value at all yet during `ensureCtor`'s collect-then-`struct.new` path
				// (`ctx.ctorFields` stays set for exactly as long as that's true, cleared the instant the
				// last field's value is collected) -- reading an *already-collected* field straight off
				// `this` has its own dedicated shortcut (`case 'member'`, below) that never reaches here at
				// all, so anything that does reach this point genuinely has no value to produce: a field
				// that hasn't been assigned yet, a method call, or `this` passed/returned/captured as a bare
				// value. All would otherwise fall through to the generic "unresolved identifier" throw below
				// -- caught here first for a clear, specific message instead.
				if (e.type === 'this' && ctx.ctorFields)
					throw `'this' can't be used yet in '${ctx.owner?.name}'s constructor -- it has at least one object-typed field, which needs every field's real value collected up front (for 'struct.new') before 'this' exists at all; assign every field via a plain 'this.field = value' statement before using 'this' any other way`;
				// A captured free variable has no real local of its own -- read via `struct.get` off the
				// cast env local instead. Checked before `ctx.lookup`, since it's never also in `ctx.locals`.
				const captured = ctx.closureEnv?.fields.get(name);
				if (captured) {
					ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index), I.struct.get(ctx.closureEnv!.envTypeIndex, captured.index));
					// A forward-cell's captured field holds the cell itself (`emitRawSlot`'s own comment) --
					// unbox it back to the real, logical value here, the one place an ordinary read of this
					// name (as opposed to `emitClosureLiteral`'s own raw capture) actually wants.
					if (captured.cellInner) {
						emitCellRead((captured.wtype as { typeIndex: number }).typeIndex, captured.cellInner, ctx);
						return captured.cellInner;
					}
					return captured.wtype;
				}
				const local = ctx.lookup(name);
				if (local) {
					ctx.emit(I.local.get(local.index));
					if (local.cellInner) {
						emitCellRead((local.wtype as { typeIndex: number }).typeIndex, local.cellInner, ctx);
						return local.cellInner;
					}
					return local.wtype;
				}

				let g = globals.get(name);
				if (!g) {
					const global = LIB_DECL_MAP.get(name);
					if (global && global.type === 'var_decl')
						g = ensureGlobal(name, typeOf(global.typeAnnotation!)!, global.init!, global.kind !== 'const');
				}
				if (g) {
					ctx.emit(I.global.get(g.index));
					return g.wtype;
				}

				// A module-level `const`/`let` whose value ISN'T a wasm compile-time constant -- an array, an
				// object literal, a string, a `new`, a call. Exactly what `ensureLazyGlobal` already builds for
				// the same declaration when it's *called* (`case 'call'`'s own factory-const path); it just was
				// never reached by a plain READ, which is why `const A = [1,2,3]` was visible to nothing but
				// the top level. Same lookup that path uses, so a cross-module const resolves identically.
				{
					const lazy = lazyGlobalFor(name, ctx);
					if (lazy) {
						ctx.emit(I.call(lazy.wrapper.funcIndex));
						return lazy.wrapper.result;
					}
				}

				// A plain named function read as a value (passed as a callback, assigned, returned, ...)
				// rather than called directly by name -- see `ensureFunctionValueWrapper`'s own comment.
				// `imported`: same idea as `emitCall`'s own named-import redirect -- `name` may be a plain
				// `import { foo } from '...'` binding local to `ctx.homeModule` rather than a real
				// declaration of its own.
				let fnDecl = resolveDecl(ctx.homeModule, name);
				let fnName = name, fnModule = ctx.homeModule;
				if (!fnDecl) {
					const imported = namedImportsByModule.get(ctx.homeModule)?.get(name);
					if (imported) {
						fnDecl = functionDeclByName.get(homeKey(imported.module, imported.name));
						fnName = imported.name;
						fnModule = imported.module;
					}
				}
				if (fnDecl && fnDecl.type === 'function_decl' && fnDecl.body) {
					const { info, structTypeIndex } = ensureFunctionValueWrapper(fnName, fnDecl, fnModule);
					ctx.emit(I.ref.func(info.funcIndex), I.struct.new_default(ensureEnvBase()), I.struct.new(structTypeIndex));
					return { closure: { params: info.params, result: info.result, hasRest: info.hasRest } };
				}
				// CommonJS's own per-module wrapper names -- see `checker.bindModuleNames` for why these are
				// module-scoped and not global. A compile-time constant, the substitution a bundler makes:
				// the compiled module has no file of its own to ask at runtime.
				if (name === '__dirname' || name === '__filename') {
					const file = moduleFilename(ctx.homeModule);
					if (file)
						return emitExpr(Literal(name === '__dirname' ? path.dirname(file) : file), ctx, want);
				}
				throw `unresolved identifier '${name}'`;
			}

			case 'member': {
				if (e.object.type === 'identifier') {
					const owner = namespaceOwner(e.object.name, ctx);
					if (owner) {
						const f = owner.decl.body.find(m => m.type === 'field' && m.key === e.property && m.modifiers?.includes('static'));
						if (!f || f.type !== 'field' || !f.value)
							throw `unknown static field '${owner.name}.${e.property}'`;
						return emitExpr(f.value, ctx);
					}
					// `NS.someConst` -- another module's module-level const, through `import * as NS`. The same
					// lazy wrapper a bare identifier read of one already uses, just resolved in the namespace's
					// own scope. Only when nothing local shadows the namespace name.
					const ns = ctx.lookup(e.object.name) ? undefined : ctx.scope.namespace(e.object.name);
					if (ns) {
						const lazy = lazyGlobalFor(e.property, ctx, ns);
						if (lazy) {
							ctx.emit(I.call(lazy.wrapper.funcIndex));
							return lazy.wrapper.result;
						}
					}
				}

				const cls = classOfForIndexing(e.object, ctx);

				// A dynamic object (`{[k: string]: V}`, routed to `Map<string, V>` -- see
				// `indexSignatureValueType`): `o.a` and `o['a']` are the same access in TS, but only the
				// bracket form was ever routed to `get`, so a dot read threw "unknown field". Before the
				// getter and field checks below, because the receiver's TS type exposes no `Map` member at
				// all -- `env.size` must read the `'size'` KEY, not the map's own count. A real `Map`-typed
				// value is unaffected: its type is a `ref`, for which `indexSignatureValueType` is undefined.
				if (cls && !isOptionalChainLink(e) && indexSignatureValueType(T.resolve(ctx.typeScope, narrowedTypeOf(e.object, ctx))) && methodSig(cls, 'get', ctx)) {
					emitAs(e.object, ctx, cls.thisWtype!);
					return emitMethodCall(cls, 'get', [{ type: 'literal', value: e.property }], ctx);
				}

				// A `get` accessor -- checked before both the `.length` special case and the ordinary
				// struct-field read, so a real getter (e.g. `Array<T>.length`) takes priority over either.
				if (cls?.getterNames?.has(e.property)) {
					// `isOptionalChainLink`, not a bare `e.optional` -- `a?.b.getter` continues `a?.b`'s own
					// chain even though *this* access has no `?.` of its own written on it (see the checker's
					// own `isOptionalChainLink` comment, shared verbatim). Same restriction either way: a
					// getter can't be guarded in this pass, direct `?.` or chain-continued.
					if (isOptionalChainLink(e))
						throw `'a?.${e.property}' on a getter is not supported`;
					emitAs(e.object, ctx, cls.thisWtype!);
					return emitMethodCall(cls, accessorKey('get', e.property), [], ctx);
				}

				const fieldIdx	= cls?.fieldIndex.get(e.property);
				if (!cls || fieldIdx === undefined) {
					// `classOf` couldn't resolve a single owner -- one real reason (besides a genuinely
					// unknown field) is a receiver whose static type is a real union of different object
					// shapes (`unionClassMembers`), physically boxed as `any` by `typeOf`'s own union case.

					const t = T.resolve(ctx.typeScope, narrowedTypeOf(e.object, ctx));
					if (t.type === 'union') {
						const owners = T.unionMembers(t, ctx.typeScope).filter(m => !T.isNullish(m, ctx.typeScope)).flatMap(m => flattenOwners(m, ctx.typeScope) ?? [undefined]);
						if (owners.length > 1 && owners.every(o => o && o.typeIndex !== -1)) {
							emitAs(e.object, ctx, REF_ANY);
							const info = ensureUnionFieldDispatch(owners as ClassInfo[], e.property, T.lookupMember(t, e.property, ctx.typeScope));
							ctx.emit(I.call(info.funcIndex));
							return info.result;
						}
					}
					// A physically-extended value (`Object.defineProperty`'s own write side,
					// `ensureClassExtension`'s own comment) whose checker-level type never reflects that --
					// there's no real TS syntax to express "this value's class was extended" -- so `cls`
					// above, resolved through the checker type, only ever sees the plain base class here. If
					// `e.object` (through an `as`) is a plain local variable, its real wasm local's own
					// physical wtype (not the checker type) might already be the extended form.
					const identExpr = unwrapAs(e.object);
					if (identExpr.type === 'identifier') {
						const local		= ctx.lookup(identExpr.name);
						const physCls	= local && typeof local.wtype !== 'string' && 'ref' in local.wtype ? ensureClass(local.wtype.ref) : undefined;
						const physIdx	= physCls?.fieldIndex.get(e.property);
						if (physCls && physIdx !== undefined) {
							ctx.emit(I.local.get(local!.index), I.struct.get(physCls.typeIndex, physIdx));
							return physCls.fields[physIdx].wtype;
						}
						const extIdx = physCls?.fieldIndex.get('#ext');
						if (physCls && extIdx !== undefined) {
							const mapCls = ensureClass('Map', [TS.RefType('string'), T.ANY]);
							if (mapCls) {
								// The catch-all field itself may still be un-allocated (`null`, never
								// `defineProperty`'d) -- reads as `undefined` either way, matching real JS's
								// own "never-set property reads as undefined" semantics: `Map.get` on a real,
								// allocated map already gives that for a missing key on its own, so only the
								// "map itself never allocated" case needs an explicit branch.
								ctx.emit(I.local.get(local!.index), I.struct.get(physCls.typeIndex, extIdx), I.ref.is_null);
								const _old = ctx.swapOut();
								emitAs({ type: 'identifier', name: 'undefined' }, ctx, REF_ANY);
								const _isNullBranch = ctx.swapOut();
								ctx.emit(I.local.get(local!.index), I.struct.get(physCls.typeIndex, extIdx), I.ref.as_non_null);
								emitMethodCall(mapCls, 'get', [{ type: 'literal', value: e.property }], ctx);
								ctx.emit(I.if(toValType(REF_ANY), _isNullBranch, ctx.swapOut(_old)));
								return REF_ANY;
							}
						}
					}
					// A genuinely dynamic receiver still has a real answer -- see `ensureAnyField`.
					if (T.isAny(T.resolveOwn(narrowedTypeOf(e.object, ctx), ctx.typeScope))) {
						emitAs(e.object, ctx, REF_ANY);
						ctx.emit(I.call(ensureAnyField(e.property, ctx).funcIndex));
						return REF_ANY;
					}
					throw `unknown field '${e.property}'`;
				}
				const fieldWtype = cls.fields[fieldIdx].wtype;

				// Mid-construction, before a real `this` exists (see `ensureCtor`'s struct-collecting path) --
				// an already-initialized field reads straight from its own scratch local instead.
				if (e.object.type === 'this' && ctx.ctorFields?.has(e.property)) {
					const local = ctx.ctorFields.get(e.property)!;
					ctx.emit(I.local.get(local.index));
					return local.wtype;
				}

				// `isOptionalChainLink`, not a bare `e.optional` -- covers both a direct `a?.b` step and a
				// non-optional continuation of an earlier one (`a?.b.c`'s `.c`). `wtypeOf(e.object, ctx)`
				// already reflects the real (possibly chain-induced) nullability -- the checker's own
				// `isOptionalChainLink`-aware inference makes sure of that -- so `emitAs(e.object, ctx,
				// objWtype)` recursing into `e.object` (itself possibly *another* chain link) naturally
				// composes: each link gets its own null check on whatever came before, which is observably
				// identical to one combined chain-wide short-circuit (no side effect ever runs twice, since
				// each link's object is only ever evaluated once, into its own scratch local) -- just several
				// nested `if`s instead of one flat guard. Simpler to get right than flattening the whole
				// chain into a single guard, and this file already leans "correct first" over "most compact".
				if (isOptionalChainLink(e)) {
					const objWtype = wtypeOf(e.object, ctx);
					if (!objWtype)
						throw `'a?.${e.property}' has an unsupported object type`;
					emitAs(e.object, ctx, objWtype);
					const resultWtype = nullableWtype(fieldWtype);
					return emitOptionalAccess(ctx, objWtype, resultWtype, objLocal => {
						ctx.emit(I.local.get(objLocal), I.struct.get(cls.typeIndex, fieldIdx));
						coerceTop(fieldWtype, ctx, resultWtype);
					});
				}

				// `emitAs`, not a raw `emitExpr` -- `e.object` may itself be a ref-kind array element read,
				// whose physical value is always boxed `anyref` -- `struct.get` needs the real narrowed `(ref cls)` first, or wasm validation rejects it. A no-op when already concretely typed (`coerceTop`'s short-circuit).
				emitAs(e.object, ctx, { ref: cls.name });
				ctx.emit(I.struct.get(cls.typeIndex, fieldIdx));
				return fieldWtype;
			}

			case 'index': {
				// Any class with its own `get(i)` (typed-array views, or any other class using the same
				// convention) -- real index syntax dispatched generically, not by name.
				const cls = classOfForIndexing(e.object, ctx);
				const sig = cls && methodSig(cls, 'get', ctx);
				if (cls && sig) {
					// `isOptionalChainLink`, not a bare `e.optional` -- see `case 'member'`'s own comment.
					if (isOptionalChainLink(e)) {
						if (sig.result === 'void')
							throw "'a?.[i]' is not supported -- 'get' returns 'void', which can't become 'void | undefined'";
						const objWtype = wtypeOf(e.object, ctx);
						if (!objWtype)
							throw "'a?.[i]' has an unsupported object type";
						emitAs(e.object, ctx, objWtype);
						const resultWtype = nullableWtype(sig.result);
						return emitOptionalAccess(ctx, objWtype, resultWtype, objLocal => {
							// Receiver pushed directly, skipping `emitMethodCall`'s own receiver-push -- needs an
							// explicit `ref.as_non_null` here, always sound since `readCore` only runs in the proven-non-null arm.
							ctx.emit(I.local.get(objLocal), I.ref.as_non_null);
							coerceTop(emitMethodCall(cls, 'get', [e.index], ctx), ctx, resultWtype);
						});
					}
					// `emitAs`, not a raw `emitExpr` -- `e.object` may itself be boxed `anyref` (`a[i][j]`), same reasoning as the field-read cast above.
					emitAs(e.object, ctx, cls.thisWtype!);
					return emitMethodCall(cls, 'get', [e.index], ctx);
				}
				const kind = objectArrayKind(e.object, ctx);
				if (!kind || kind === 'i16' || kind === 'i8') {
					// Neither a single class with its own `get(i)` nor a single raw array kind -- the one
					// remaining shape this supports is a real union of different indexable classes (e.g.
					// `Uint8Array | number[]`, `updateBuffer`'s own `b[i]`, found compiling `dwg/src/crc16.ts`)
					// -- every member resolves to a real `get(i)`-owning `ClassInfo` via `ownerFor` (a plain
					// `number[]`/`boolean[]` included, via its own 'array' case, same as a genuine typed-array
					// view), so this is exactly `case 'member'`'s own `ensureUnionFieldDispatch` shape, just
					// always through `get(i)` rather than a field/getter (see `ensureUnionIndexDispatch`).
					const t = T.resolve(ctx.typeScope, narrowedTypeOf(e.object, ctx));
					if (t.type === 'union') {
						const owners = T.unionMembers(t, ctx.typeScope).filter(m => !T.isNullish(m, ctx.typeScope)).map(m => ownerFor(m));
						if (owners.length > 1 && owners.every(o => o && o.typeIndex !== -1 && methodSig(o, 'get', ctx))) {
							emitAs(e.object, ctx, REF_ANY);
							emitAs(e.index, ctx, 'i32');
							const info = ensureUnionIndexDispatch(owners as ClassInfo[]);
							ctx.emit(I.call(info.funcIndex));
							return info.result;
						}
					}
					throw "indexing is only supported on number[]/boolean[]/Uint8Array/Int32Array/Uint32Array ('string' is immutable and not indexable in this pass)";
				}
				// `nullable: true` on the 'ref' case -- `ensureArrayType`'s `'ref'`-kind field is declared
				// nullable (shared physical storage for every non-scalar kind), so `array.get` always really
				// produces a nullable `anyref`, whatever the caller's declared TS element type claims.
				const elemWtype: WasmType = kind === 'ref' ? { ref: 'any', nullable: true } : kind;
				// `isOptionalChainLink`, not a bare `e.optional` -- see `case 'member'`'s own comment.
				if (isOptionalChainLink(e)) {
					const objWtype = wtypeOf(e.object, ctx);
					if (!objWtype)
						throw "'a?.[i]' has an unsupported object type";
					emitAs(e.object, ctx, objWtype);
					const resultWtype = nullableWtype(elemWtype);
					return emitOptionalAccess(ctx, objWtype, resultWtype, objLocal => {
						ctx.emit(I.local.get(objLocal));
						emitAs(e.index, ctx, 'i32');
						ctx.emit(I.array.get(ensureArrayType(kind)));
						coerceTop(elemWtype, ctx, resultWtype);
					});
				}
				emitAs(e.object, ctx, ARR_WTYPE[kind]);
				emitAs(e.index, ctx, 'i32');
				ctx.emit(I.array.get(ensureArrayType(kind)));
				return elemWtype;
			}

			// `as`/`as unknown as X` is compile-time-only in real TS too -- a no-op here: compile the inner
			// expression and pass its actual `WasmType` straight through, ignoring the asserted one entirely.
			case 'as':
				return emitExpr(e.expression, ctx, want);

			// `(a, b, c)` -- every expression but the last runs purely for its side effects, same as a bare
			// expression-statement (`emitStmt`'s own `'void'`-then-`I.drop` idiom, reused verbatim); only the
			// last one's value (and `want`) matters.
			case 'sequence':
				for (let i = 0; i < e.expressions.length - 1; i++)
					if (emitExpr(e.expressions[i], ctx, 'void') !== 'void')
						ctx.emit(I.drop);
				return emitExpr(e.expressions[e.expressions.length - 1], ctx, want);

			// A ref-kind element (`string[]`, a class array, ...) needs `REF_ANY` as the per-element target --
			// `coerceTop`'s widen-to-`any` case boxes each one, not the bare `kind` string (only coincides with a real `WasmType` for scalar kinds).
			// `want` naming a real class wins outright; otherwise `matchObjectShape` resolves it structurally
			// -- against a declared interface/class first, falling back to a freshly synthesized anonymous
			// shape (`ensureAnonObjectShape`) only when no declared type matches at all, e.g. a bare
			// `const mapSig = {a: ..., b: ...}` with no `interface`/`type X = ...` anywhere. Fields push in
			// the *shape's own declared order* (`struct.new` needs every field value up front, in that fixed
			// order), not the literal's own written order -- looked up from the literal's properties by name.
			case 'object': {
				// `want` naming one class wins outright when it does; otherwise, a real declared union
				// target (`ctx.contextualReturn`) discriminant-matched to one member wins next -- guarantees
				// the exact same struct `ownerFor` would independently build for that member later, which
				// `matchObjectShape`'s own candidate scan can't (nothing may have triggered building the
				// interface's "official" struct yet). Only once both give up does `matchObjectShape`'s own
				// structural/discriminant match run (most commonly for a `REF_ANY` target, e.g. this literal
				// is a generic callback's own return value, boxed as `any` per `typeOf`'s own union case).
				const owner = (typeof want === 'object' && 'ref' in want ? ensureClass(want.ref) : undefined)
					?? matchContextualUnionMember(e, ctx)
					?? matchObjectShape(e, ctx);
				if (!owner)
					throw "an object literal needs a known target type (e.g. a 'const x: Point = {...}' with a plain 'type Point = {...}' alias) -- not supported here";

				// A dynamic object (this literal's target type was a structural index signature --
				// `{[k: string]: V}` -- routed to `Map<string, V>`, see `indexSignatureValueType`)
				// constructs via the real constructor plus one `.set(key, value)` call per property,
				// not struct-field assignment -- there are no fixed fields to assign at all, the whole
				// point is an arbitrary, runtime key set. `set` returns `this`, so each call's result
				// is already the next one's receiver -- no scratch local needed.
				if (owner.decl.name === 'Map') {
					const ctor = ensureCtor(owner, [], ctx);
					emitCallArgs(`${owner.name}'s constructor`, ctor.params, ctor.defaults, !!ctor.hasRest, [], ctx, ctor.resolvedParams);
					ctx.emit(I.call(ctor.funcIndex));
					if (!e.properties.some(p => p.type === 'spread')) {
						// `set` returns `this`, so each call's result is already the next one's receiver -- no scratch local needed.
						for (const p of e.properties) {
							if (p.type !== 'field' || typeof p.key !== 'string' || !p.value)
								throw `object literal for '${owner.name}' can only have plain 'key: value' properties (no methods or computed keys)`;
							emitMethodCall(owner, 'set', [{ type: 'literal', value: p.key }, p.value], ctx);
						}
						return owner.thisWtype!;
					}
					// `{...other, k: v}` -- spreading one dynamic object's own live entries into another needs a
					// real loop (copy every key `other` currently holds via `.keys()`/`.get()`), unlike a plain
					// `key: value` property, so the map instance needs a real local to reference repeatedly across
					// iterations (the stack-chaining trick above, `set`'s own `this` return feeding the next call,
					// only works for a fixed, statically-known sequence of calls). Every spread argument is its
					// own dynamic object too (the only shape `{...x}` can mean once the whole literal's own target
					// is one) -- evaluated once each into its own local, matching real JS's one-evaluation-per-
					// spread semantics, then copied via the same `for...in`-over-a-dynamic-object desugaring
					// `case 'for'`'s own `'in'` kind already uses.
					const n			= closureCallTempCounter++;
					const mapName	= `#dynobj$${n}`;
					const mapLocal	= ctx.declareValue(mapName, owner.thisWtype!, owner.thisTsType!);
					ctx.emit(I.local.set(mapLocal.index));
					let spreadIndex = 0;
					for (const p of e.properties) {
						if (p.type === 'spread') {
							const spreadName	= `#spread$${n}$${spreadIndex}`;
							const kName			= `#spreadkey$${n}$${spreadIndex++}`;
							const spreadLocal	= ctx.declareValue(spreadName, owner.thisWtype!, owner.thisTsType!);
							emitAs(p.operand, ctx, owner.thisWtype!);
							ctx.emit(I.local.set(spreadLocal.index));
							// Same `for (const k of x.keys()) ...` desugaring `case 'for'`'s own `'in'` kind uses --
							// synthesized directly (not a real `for...in` node) since there's no user-written loop
							// variable/body here, just this one copy step per spread argument.
							emitStmt({
								type: 'for', kind: 'of',
								init: JS.VarDecl('const', JS.Var(kName)),
								right: { type: 'call', callee: { type: 'member', object: { type: 'identifier', name: spreadName }, property: 'keys' }, arguments: [] },
								body: JS.Block({
									type: 'expression', expression: {
										type: 'call',
										callee: { type: 'member', object: { type: 'identifier', name: mapName }, property: 'set' },
										arguments: [{ type: 'identifier', name: kName }, { type: 'call', callee: { type: 'member', object: { type: 'identifier', name: spreadName }, property: 'get' }, arguments: [{ type: 'identifier', name: kName }] }],
									},
								}),
							} as Stmt, ctx);
							continue;
						}
						if (p.type !== 'field' || typeof p.key !== 'string' || !p.value)
							throw `object literal for '${owner.name}' can only have plain 'key: value' properties (no methods or computed keys)`;
						ctx.emit(I.local.get(mapLocal.index));
						emitMethodCall(owner, 'set', [{ type: 'literal', value: p.key }, p.value], ctx);
						//ctx.emit(I.drop);
					}
					ctx.emit(I.local.get(mapLocal.index));
					return owner.thisWtype!;
				}

				// One source per target field name -- either a plain value expression, or (`{...x}`) a
				// class instance to read the field back off, evaluated once into its own scratch local
				// right here (matching real JS's own one-evaluation-per-spread semantics, same idea the
				// Map-backed dynamic-object case above already uses) rather than re-emitting `p.operand`
				// once per field it happens to supply. A later source for the same field name overwrites
				// an earlier one, same "last property wins" rule real JS/TS object-literal syntax already
				// has (`{...x, k: v}` or `{k: v, ...x}`). Only a target field this class actually declares
				// is ever read back off a spread operand -- any of *its* own extra fields are simply not
				// part of this shape, the same way a real JS spread's own excess properties would just
				// never be looked at by a nominally-typed consumer.
				interface FieldSource { expr?: Expr; spreadLocal?: Local; spreadCls?: ClassInfo }
				// Every source for a field, in written order -- not just the last one. `{...D, ...opts}` is the
				// reason: an OPTIONAL property of a later operand is only "last wins" when it's actually
				// present at runtime, so an absent one has to fall back to whatever came before it.
				const sources = new Map<string, FieldSource[]>();
				const addSource = (key: string, src: FieldSource) => sources.set(key, [...(sources.get(key) ?? []), src]);
				for (const p of e.properties) {
					if (p.type === 'spread') {
						// An anonymous object shape is a perfectly good spread operand -- it just has no
						// nominal class for `ownerOf` to find, so give it the same synthesized struct a
						// literal targeting that shape would already get.
						const spreadT	= T.resolve(ctx.scope, narrowedTypeOf(p.operand, ctx));
						const spreadCls	= ownerOf(p.operand, ctx) ?? (spreadT.type === 'object' ? ensureAnonObjectShape(spreadT) : undefined);
						if (!spreadCls)
							throw `object literal for '${owner.name}': a spread operand needs a known object type, got '${T.typeKey(spreadT)}'`;
						const spreadLocal = ctx.declareValue(`$spread$${closureCallTempCounter++}`, spreadCls.thisWtype!, spreadCls.thisTsType!);
						emitAs(p.operand, ctx, spreadCls.thisWtype!);
						ctx.emit(I.local.set(spreadLocal.index));
						for (const f of spreadCls.fields)
							addSource(f.name, { spreadLocal, spreadCls });
						continue;
					}
					if (p.type !== 'field' || typeof p.key !== 'string' || !p.value)
						throw `object literal for '${owner.name}' can only have plain 'key: value' properties or a spread (no methods or computed keys)`;
					if (!owner.fieldIndex.has(p.key))
						throw `object literal for '${owner.name}' has unknown property '${p.key}'`;
					addSource(p.key, { expr: p.value });
				}
				// A source is "certain" when it always yields a value: an explicit `k: v`, or a spread of a
				// field that isn't optional. Everything written before the last certain source is dead.
				const certain	= (src: FieldSource, name: string) => !!src.expr || !src.spreadCls!.fields[src.spreadCls!.fieldIndex.get(name)!].optional;
				const rawWtype	= (src: FieldSource, name: string) => src.spreadCls!.fields[src.spreadCls!.fieldIndex.get(name)!].wtype;
				const emitOne	= (src: FieldSource, f: { name: string; wtype: WasmType }) => {
					if (src.expr) {
						emitAs(src.expr, ctx, f.wtype);
					} else {
						const idx = src.spreadCls!.fieldIndex.get(f.name)!;
						ctx.emit(I.local.get(src.spreadLocal!.index), I.struct.get(src.spreadCls!.typeIndex, idx));
						coerceTop(src.spreadCls!.fields[idx].wtype, ctx, f.wtype);
					}
				};
				// `last ?? (the one before it ?? ...)`, lowered exactly like the `??` operator itself.
				const emitChain = (chain: FieldSource[], f: { name: string; wtype: WasmType }): void => {
					const last = chain[chain.length - 1];
					if (chain.length === 1 || certain(last, f.name))
						return emitOne(last, f);
					const srcWtype	= rawWtype(last, f.name);
					const idx		= last.spreadCls!.fieldIndex.get(f.name)!;
					const tmp		= ctx.declareLocal(`$spread$${f.name}$${optionalTempCounter++}`, srcWtype);
					ctx.emit(I.local.get(last.spreadLocal!.index), I.struct.get(last.spreadCls!.typeIndex, idx));
					ctx.emit(I.local.tee(tmp.index), I.ref.is_null);
					const old = ctx.swapOut();
					emitChain(chain.slice(0, -1), f);
					const _then = ctx.swapOut();
					ctx.emit(I.local.get(tmp.index));
					coerceTop(srcWtype, ctx, f.wtype);
					ctx.emit(I.if(toValType(f.wtype), _then, ctx.swapOut(old)));
				};
				for (const f of owner.fields) {
					const chain = sources.get(f.name);
					if (!chain?.length) {
						if (!f.optional)
							throw `object literal for '${owner.name}' is missing property '${f.name}'`;
						emitDefaultValue(f.wtype, ctx);
					} else {
						// Trim everything before the last certain source -- it can never be observed.
						const from = chain.reduce((acc, src, i) => certain(src, f.name) ? i : acc, 0);
						emitChain(chain.slice(from), f);
					}
				}
				ctx.emit(I.struct.new(owner.typeIndex));
				return owner.thisWtype!;
			}

			case 'array': {
				// `want`'s own kind wins whenever it's asking for something boxable-as-`any` -- either
				// directly (`{arr:'ref'}`, a real `any[]` target) or because this whole literal is
				// itself about to be boxed as one `anyref` value (`{ref:'any'}`, e.g. a tuple's own inner
				// literal `[1, 2]`, or a bare `any`-typed local) -- even if every element looks naturally
				// scalar right now (`const values: any[] = [1, 2, 3]`). `arrayKindOf` only sees the
				// elements themselves, so it would otherwise build a real `number[]` -- a scalar-kind wasm
				// array and a ref-kind one are physically incompatible types (not just a missing cast), so
				// nothing later could ever treat it as the boxed/tuple value its position actually needs.
				// Also wins outright for an *empty* literal (`[]`) -- there are no elements for
				// `arrayKindOf` to infer anything from at all.
				//
				// The `{ref:'any'}` case specifically needs one more distinction, though: it also covers a
				// literal that's merely an *element of an outer ref-kind array* (`[1,2]` inside
				// `number[][]`), and there the array reference itself upcasts to `anyref` for free -- only
				// its own elements would need boxing if IT were genuinely `any`-typed, which (unlike
				// `values: any[]` above) it isn't: `ctx.contextualReturn` (this literal's own real
				// declared/contextual type, when known) says `number[]`, not `any[]`. Only force boxed
				// storage here when that contextual type is itself genuinely `any`/unknown, or unavailable
				// (the same conservative default as before whenever there's nothing better to go on).
				const wantArr = typeof want === 'object' && 'arr' in want ? want.arr : undefined;
				const contextualArr = ctx.contextualReturn && T.resolve(ctx.scope, ctx.contextualReturn);
				const contextualElement = contextualArr?.type === 'array' ? contextualArr.element : undefined;
				const contextForcesAny = !contextualElement || T.isAny(T.resolve(ctx.scope, contextualElement));
				const kind = wantArr === 'ref' || (typeof want === 'object' && 'ref' in want && want.ref === 'any' && contextForcesAny) ? 'ref'
					: (e.elements.length === 0 && wantArr) ? wantArr : arrayKindOf(e, ctx);
				if (!kind || kind === 'i16' || kind === 'i8')
					throw 'array literals are only supported for number[]/boolean[]/T[]';
				emitArrayElements(e.elements, ctx, kind === 'ref' ? REF_ANY_NULLABLE : kind, kind, ensureArrayType(kind), contextualElement);
				return ARR_WTYPE[kind];
			}

			case 'unary': {
				if (e.operator === '++' || e.operator === '--') {
					const target = emitAssignTarget(e.operand, ctx, 'discard');
					const wtype = target.wtype;
					if (wtype !== 'i32' && wtype !== 'f64') {
						// A nullable primitive gets a specific, actionable message -- narrowing it (`if (x !== null)`)
						// to a real non-null occurrence would need codegen to track that narrowing per-read, which
						// it doesn't do for any type (see `coerceTop`'s soundness contract); out of scope here.
						if (unboxedPrimitive(wtype))
							throw "'++'/'--' on a nullable primitive needs narrowing to non-null first, and isn't supported even then";
						throw "'++'/'--' is only supported on number/boolean-kind locals";
					}

					ctx.emit(I[wtype].const(1), I[wtype][e.operator === '++' ? 'add' : 'sub']);
					if (want === 'void') {
						target.write(false);
						return want;
					}
					target.write(true);
					return wtype;
				}

				// `delete obj[k]` -- like `++`/`--`, this needs the target's own object+key, not its
				// evaluated value, so it gets its own branch before the generic operand dispatch below.
				// Only a dynamic object (structural `{[k: string]: V}`, routed to `Map<string, V>`) has
				// a real `delete` to dispatch to.
				if (e.operator === 'delete') {
					if (e.operand.type !== 'index')
						throw "'delete' is only supported on a dynamic object's own bracket-indexed property ('delete obj[k]')";
					const cls = ownerOf(e.operand.object, ctx);
					if (!cls?.methodDecls.get('delete'))
						throw "'delete' is only supported over a dynamic object (a structural '{[k: string]: V}'-typed value)";
					emitAs(e.operand.object, ctx, cls.thisWtype!);
					return emitMethodCall(cls, 'delete', [e.operand.index], ctx);
				}

				const info = operandInfo(e.operand, ctx);
				if (info.owner) {
					const method = UNARY_OP_NAMES[e.operator as keyof typeof UNARY_OP_NAMES];
					if (method && info.owner.methodDecls?.get(method)) {
						emitAs(e.operand, ctx, info.owner.thisWtype!);
						return emitMethodCall(info.owner, method, [], ctx);
					}
				}

				// A bare `typeof x` as a VALUE -- answerable only when the checker's type gives every
				// inhabitant the same tag; a genuinely dynamic one would need a real runtime cascade
				// producing a string, which nothing in the target set actually asks for.
				if (e.operator === 'typeof') {
					const known = T.typeofName(checkerTypeOf(unwrapAs(e.operand), ctx.scope), ctx.scope);
					if (known !== undefined) {
						if (emitExpr(e.operand, ctx, 'void') !== 'void')
							ctx.emit(I.drop);
						return emitExpr(Literal(known), ctx, want);
					}
				}

				// `!x` is exactly "is x falsy", so it answers for every operand shape `emitTruthy` understands
				// -- a nullable object reference, a string (empty is falsy), an array, a scalar -- not just
				// the scalar-kinded ones. The old scalar-only path also coerced the operand to `i32` first,
				// which TRUNCATED a real `f64`: `!0.5` came out `true`.
				if (e.operator === '!') {
					emitTruthy(e.operand, ctx);
					ctx.emit(I.i32.eqz);
					return 'i32';
				}

				const t = notUnsigned(scalarKind(info.wtype));
				if (t) {
					switch (e.operator) {
						case '-':
							if (t === 'i64' || t === 'i32') {
								ctx.emit(I[t](0));
								emitAs(e.operand, ctx, t);
								ctx.emit(I[t].sub);
							} else {
								emitAs(e.operand, ctx, t);
								ctx.emit(I[t].neg);
							}
							return t;
						case '+':
							emitAs(e.operand, ctx, t);
							return t;
						case '~':
							emitAs(e.operand, ctx, 'i32');
							ctx.emit(I.i32(-1), I.i32.xor);
							return 'i32';
					}
				}
				throw `unsupported unary operator '${e.operator}'`;
			}

			case 'unary_post':
				if (e.operator === '!')
					return emitExpr(e.operand, ctx, want);
				if (e.operator === '++' || e.operator === '--') {
					const target = emitAssignTarget(e.operand, ctx, 'keep');
					const wtype = target.wtype;
					if (wtype !== 'i32' && wtype !== 'f64') {
						// A nullable primitive gets a specific, actionable message -- narrowing it (`if (x !== null)`)
						// to a real non-null occurrence would need codegen to track that narrowing per-read, which
						// it doesn't do for any type (see `coerceTop`'s soundness contract); out of scope here.
						if (unboxedPrimitive(wtype))
							throw "'++'/'--' on a nullable primitive needs narrowing to non-null first, and isn't supported even then";
						throw "'++'/'--' is only supported on number/boolean-kind locals";
					}

					ctx.emit(I[wtype].const(1), I[wtype][e.operator === '++' ? 'add' : 'sub']);
					target.write(false);
					if (want === 'void')
						return want;
					ctx.emit(I.local.get(target.old!));
					return wtype;
				}
				throw `unsupported postfix operator '${e.operator}'`;

			case 'binary': {
				const { operator, left, right } = e;
				// `typeof x === 'lit'` (either way round) -- a type test, handled before anything else.
				if (operator === '===' || operator === '!==' || operator === '==' || operator === '!=') {
					const asTypeof = (a: Expr, b: Expr) => a.type === 'unary' && a.operator === 'typeof'
						&& b.type === 'literal' && typeof b.value === 'string' ? { operand: a.operand, tag: b.value } : undefined;
					const test = asTypeof(left, right) ?? asTypeof(right, left);
					if (test && emitTypeofTest(test.operand, test.tag, ctx)) {
						if (operator === '!==' || operator === '!=')
							ctx.emit(I.i32.eqz);
						return 'i32';
					}
				}
				const rightInfo = operandInfo(right, ctx);

				if (ASSIGN_OPS.has(operator)) {

					const target	= emitAssignTarget(left, ctx, operator !== '=' ? 'discard' : 'none');
					const wtype		= target.wtype;

					// The target's own declared type is the value's contextual type -- the same channel
					// `case 'var_decl'` seeds from an annotation, which a bare `new C` on the right needs to
					// find its own type arguments (`scope.resolveCache ??= new WeakMap`).
					const emitValue = () => {
						const saved = ctx.contextualReturn;
						ctx.contextualReturn = checkerTypeOf(left, ctx.scope);
						emitAs(right, ctx, wtype);
						ctx.contextualReturn = saved;
					};

					switch (operator) {
						case '=':
							emitValue();
							break;

						case '??=': {
							// `a ??= b` -- real JS short-circuits: `b` is only evaluated when `a` is null/undefined, unlike
							// every other compound-assignment op. Mirrors the plain `??` binary-op's own `if`-based lowering exactly, just feeding `target.write` instead of returning the value directly.
							if (typeof wtype === 'string' || !wtype.nullable)
								throw "'??=' needs a nullable object-typed target (no boxing in this subset)";
							const leftLocal = ctx.declareLocal(`$nullish$assign$${optionalTempCounter++}`, wtype);
							ctx.emit(I.local.tee(leftLocal.index), I.ref.is_null);
							const _old = ctx.swapOut();
							emitValue();
							const _then = ctx.swapOut();
							ctx.emit(I.local.get(leftLocal.index));
							ctx.emit(I.if(toValType(wtype), _then, ctx.swapOut(_old)));
							break;
						}

						default: {
							const method	= BINARY_OP_NAMES[operator.slice(0, -1) as keyof typeof BINARY_OP_NAMES];
							const owner		= ownerOf(left, ctx);
							if (owner && owner.methodDecls?.get(method)) {
								emitMethodCall(owner, method, [right], ctx);

							} else {
								const inline = numericOpInline(method, wtype, rightInfo.wtype, ctx);
								coerceTop(wtype, ctx, inline.params[0]);
								emitAs(right, ctx, inline.params[1]);
								ctx.emit(...inline.inline);
								coerceTop(inline.result, ctx, wtype);
							}
						}
					}

					const tee = want !== 'void';
					target.write(tee);
					return tee ? wtype : 'void';
				}

				switch (operator) {
					// `a && b` and `a || b` yield an OPERAND, not a boolean: `0.5 && 7` is `7`, `0 || 7` is
					// `7`. Both used to lower to a bare boolean, which agrees with real JS in a condition --
					// which is why it went unnoticed -- but is simply the wrong value anywhere else.
					// `emitTruthy` above keeps the cheap boolean form for conditions.
					case '&&':
					case '||': {
						const isAnd = operator === '&&';
						// As a STATEMENT (`a && f()`) only the short-circuit is observable. Handled before the
						// value form because neither operand needs a representable result then -- `f()` may
						// well return `void`.
						if (want === 'void') {
							emitTruthy(left, ctx);
							if (!isAnd)
								ctx.emit(I.i32.eqz);
							const _old = ctx.swapOut();
							if (inNarrowed(left, isAnd, ctx, () => emitExpr(right, ctx, 'void')) !== 'void')
								ctx.emit(I.drop);
							ctx.emit(I.if(undefined, ctx.swapOut(_old)));
							return 'void';
						}
						const leftWtype		= wtypeOf(left, ctx);
						const rightWtype	= wtypeOf(right, ctx);
						if (!leftWtype || !rightWtype || leftWtype === 'void' || rightWtype === 'void')
							throw `'${operator}' needs both operands to have a representable value type`;
						// Same rule `typeOf`'s own union case uses -- one shared physical form when both
						// sides already agree, else the checker's own type for the whole expression (a real
						// union, so boxed). Not taken from the checker outright: this stays correct even
						// where its type for `&&` is narrower than the two operands together.
						const wtype = wasmTypeEq(leftWtype, rightWtype) ? leftWtype : (wtypeOf(e, ctx) ?? REF_ANY);
						const leftLocal = ctx.declareLocal(`$logic$left$${optionalTempCounter++}`, leftWtype);
						emitAs(left, ctx, leftWtype);
						ctx.emit(I.local.tee(leftLocal.index));
						emitTruthyOf(leftWtype, checkerTypeOf(unwrapAs(left), ctx.scope), ctx);
						const keepLeft = () => {
							ctx.emit(I.local.get(leftLocal.index));
							coerceTop(leftWtype, ctx, wtype);
						};
						const _old = ctx.swapOut();
						const emitRight = () => inNarrowed(left, isAnd, ctx, () => emitAs(right, ctx, wtype));
						if (isAnd)
							emitRight();
						else
							keepLeft();
						const _then = ctx.swapOut();
						if (isAnd)
							keepLeft();
						else
							emitRight();
						ctx.emit(I.if(toValType(wtype), _then, ctx.swapOut(_old)));
						return wtype;
					}
					// `a ?? b` -- `a`'s combined-with-`b` type drives the `if`'s result. A left that can never
					// actually be null/undefined makes `b` provably dead code -- same conclusion real TS's
					// own type checker would reach -- so it's evaluated and returned directly, no runtime
					// check at all; `patternBindings` relies on exactly this for a destructuring default on
					// an already-non-nullable value (an ordinary array element, a non-optional object field).
					case '??': {
						const wtype = wtypeOf(e, ctx);
						if (!wtype)
							throw "'??' has an unsupported result type";
						const leftWtype = wtypeOf(left, ctx);
						if (!leftWtype)
							throw "'??' has an unsupported left-hand type";
						if (typeof leftWtype === 'string' || !leftWtype.nullable) {
							emitAs(left, ctx, wtype);
							return wtype;
						}
						emitAs(left, ctx, leftWtype);
						const leftLocal = ctx.declareLocal(`$nullish$left$${optionalTempCounter++}`, leftWtype);
						ctx.emit(I.local.tee(leftLocal.index), I.ref.is_null);
						const _old = ctx.swapOut();
						emitAs(right, ctx, wtype);
						const _then = ctx.swapOut();
						ctx.emit(I.local.get(leftLocal.index));
						coerceTop(leftWtype, ctx, wtype);
						ctx.emit(I.if(toValType(wtype), _then, ctx.swapOut(_old)));
						return wtype;
					}

					// `x instanceof C`: `C` must be a plain class name -- exactly the same constraint the
					// checker's own narrowing already imposes (`checker.ts`'s `test.operator === 'instanceof'`
					// case), so a program that narrows on this expression at all is already guaranteed to
					// satisfy it here. Lowers straight to `ref.test` against `C`'s own struct type, non-nullable
					// form -- `null instanceof C` is `false` in real JS, which `(ref $C)` (as opposed to
					// `(ref null $C)`) already gives for free. Reliable even between structurally-identical
					// sibling classes (e.g. two subclasses adding no fields of their own): every struct/array
					// type shares one rec group (see the group-building comment near the bottom of this file),
					// which is what makes `ref.test` distinguish them at all -- the same guarantee
					// `ensureVirtualDispatch`'s own `ref.test` cascade already relies on.
					case 'instanceof': {
						if (right.type !== 'identifier')
							throw "'instanceof' is only supported against a plain class name";
						const cls = ensureClass(right.name);
						if (!cls)
							throw `'instanceof' against unknown class '${right.name}'`;
						const leftWtype = wtypeOf(left, ctx);
						if (!leftWtype || typeof leftWtype === 'string')
							throw "'instanceof' needs an object-typed left-hand value";
						emitAs(left, ctx, leftWtype);
						ctx.emit(I.ref.test(cls.typeIndex));
						return 'i32';
					}

					// `k in obj` -- only over a dynamic object (structural `{[k: string]: V}`, routed to
					// `Map<string, V>`), the one case this compiler can give real membership-test
					// semantics to. Same shape as `instanceof` just above: resolve the class, dispatch
					// to its own conventionally-named method (`has`, matching `Map`'s real API).
					case 'in': {
						// `'k' in u` on a UNION is a TYPE test, not a property lookup -- it is how TypeScript
						// narrows a union whose members aren't discriminated by a literal field, and each
						// member is its own nominal struct, so the answer is simply which member `u` is.
						// Decided statically when every member agrees, else a `ref.test` over the members
						// that declare it. A member declaring it OPTIONALLY counts as declaring it: this
						// compiler has no notion of property presence -- an optional field is physically
						// there and null when unset -- and that is also what TS's own `in` narrowing means
						// by it ("this member is possible"), which is what every real use of it wants. The
						// cost is that `in` cannot distinguish an omitted optional property from a set one;
						// a null test would just be a different wrong answer (it would also reject a
						// property explicitly set to `undefined`, which JS says IS present).
						const key = left.type === 'literal' && typeof left.value === 'string' ? left.value : undefined;
						// `T.unionMembers`, not a `.types` walk: `resolve` leaves a union's own members alone,
						// so `typeof LIB_DECLS[number] | undefined` hides a further nested union behind one
						// of them -- see that helper's own comment.
						const flat = key === undefined ? [] : T.unionMembers(checkerTypeOf(unwrapAs(right), ctx.typeScope), ctx.typeScope)
							.filter(m => !T.isNullish(m, ctx.typeScope));
						if (key !== undefined && flat.length > 1) {
							const owners = flat.map(m => ownerFor(m));
							const state = owners.map(o => {
								if (!o || o.typeIndex === -1)
									return undefined;
								const idx = o.fieldIndex.get(key);
								return { o, has: idx !== undefined };
							});
							if (state.every(x => !!x)) {
								const declaring = state.filter(x => x!.has).map(x => x!.o);
								if (!declaring.length || declaring.length === state.length) {
									// Every member agrees, so the operand is only evaluated for its effects.
									if (emitExpr(right, ctx, 'void') !== 'void')
										ctx.emit(I.drop);
									ctx.emit(I.i32.const(declaring.length ? 1 : 0));
									return 'i32';
								}
								const recv = ctx.declareLocal(`$in$${optionalTempCounter++}`, REF_ANY_NULLABLE);
								emitAs(right, ctx, REF_ANY_NULLABLE);
								ctx.emit(I.local.set(recv.index));
								declaring.forEach((o, i) => {
									ctx.emit(I.local.get(recv.index), I.ref.test(o.typeIndex));
									if (i)
										ctx.emit(I.i32.or);
								});
								return 'i32';
							}
						}
						const cls = ownerOf(right, ctx);
						if (!cls?.methodDecls.get('has')) {
							// A genuinely dynamic receiver still has a real answer -- see `ensureAnyIn`.
							if (key !== undefined && T.isAny(checkerTypeOf(unwrapAs(right), ctx.scope))) {
								emitAs(right, ctx, REF_ANY_NULLABLE);
								ctx.emit(I.call(ensureAnyIn(key).funcIndex));
								return 'i32';
							}
							throw "'in' is only supported over a dynamic object (a structural '{[k: string]: V}'-typed value)";
						}
						emitAs(right, ctx, cls.thisWtype!);
						return emitMethodCall(cls, 'has', [left], ctx);
					}

					case '==': case '===': case '!=': case '!==': {
						const negate		= operator[0] === '!';
						const leftIsNull	= isNullLiteral(left);
						const rightIsNull	= isNullLiteral(right);
						if (leftIsNull || rightIsNull) {
							if (leftIsNull && rightIsNull) {
								ctx.emit(I.i32.const(negate ? 0 : 1));	// `null === null`/`null === undefined` -- always true, no value to check.
								return 'i32';
							}
							const valueExpr	= leftIsNull ? right : left;
							const wt		= wtypeOf(valueExpr, ctx);
							if (!wt || typeof wt === 'string' || !wt.nullable)
								throw "comparing to 'null'/'undefined' needs a nullable object-typed value on the other side";
							// `null` and `undefined` are the same physical value (`ref.null`), so `ref.is_null`
							// answers both alike -- correct for `==`, which treats them as equal anyway, but
							// `null === undefined` is FALSE and used to come back true. A strict comparison can
							// only separate them statically: when the value's type carries the OTHER nullish
							// kind and not this one, the answer is constant, whatever it holds at runtime.
							// Deliberately not extended to a type carrying NEITHER -- that still throws above,
							// and must, because this compiler hands back a physical `undefined` in places whose
							// declared type says it cannot (a missing key on `{[k: string]: V}`); answering a
							// constant there would turn a loud error into a silent wrong one.
							if (operator.length === 3) {
								const kind	= nullLiteralKind(leftIsNull ? left : right)!;
								const t		= T.resolve(ctx.typeScope, narrowedTypeOf(valueExpr, ctx));
								const members = T.isAny(t) ? [] : t.type === 'union' ? T.unionMembers(t, ctx.typeScope) : [t];
								const has	= (want: 'null' | 'undefined') => !members.length || members.some(m => {
									const r = T.resolveOwn(m, ctx.typeScope);
									return want === 'null'
										? r.type === 'literal' && r.value === null
										: r.type === 'ref' && (r.name === 'undefined' || r.name === 'void');
								});
								if (!has(kind) && has(kind === 'null' ? 'undefined' : 'null')) {
									if (emitExpr(valueExpr, ctx, 'void') !== 'void')
										ctx.emit(I.drop);
									ctx.emit(I.i32.const(negate ? 1 : 0));
									return 'i32';
								}
							}
							emitAs(valueExpr, ctx, wt);
							ctx.emit(I.ref.is_null);
							if (negate)
								ctx.emit(I.i32.eqz);
							return 'i32';
						}
					}
					//fall through
					default: {
						const leftInfo	= operandInfo(left, ctx);
						const method	= BINARY_OP_NAMES[operator as keyof typeof BINARY_OP_NAMES];

						// JS `+` is string CONCATENATION as soon as either operand is a string, whatever
						// the other one is. Compiled as the equivalent template literal so it goes through
						// exactly the `stringTemplate`/`.toString()` path `${x}` already does, rather than
						// a second stringifier that could disagree with it. Only when the two sides
						// DISAGREE -- `string + string` keeps `String.add`, and `number + number` its
						// numeric op. `definitelyString` is deliberately all-members-of-a-union: a
						// `string | number` operand really is decided at runtime, which this cannot model.
						if (method === 'add') {
							const definitelyString = (x: Expr) => {
								const t = T.resolve(ctx.typeScope, narrowedTypeOf(x, ctx));
								const ms = T.unionMembers(t, ctx.typeScope);
								return ms.length > 0 && ms.every(m => T.isStringLike(m, ctx.typeScope));
							};
							const ls = definitelyString(left), rs = definitelyString(right);
							if (ls !== rs)
								return emitExpr(Literal([{ str: '', exp: left }, { str: '', exp: right }]), ctx, want);
						}

						if (leftInfo.owner) {
							if (leftInfo.owner.methodDecls?.get(method)) {
								emitAs(left, ctx, leftInfo.owner.thisWtype!);
								return emitMethodCall(leftInfo.owner, method, [right], ctx);
							}
							if ((method === 'eq' || method === 'ne' || method === 'lt' || method === 'gt' || method === 'le' || method === 'ge') && leftInfo.owner.methodDecls?.get('compare')) {
								emitAs(left, ctx, leftInfo.owner.thisWtype!);
								const w = notUnsigned(scalarKind(emitMethodCall(leftInfo.owner, 'compare', [right], ctx)));
								if (!w)
									throw 'result of compare must be a scalar';

								if (w === 'i32' || w === 'i64') {
									switch (method) {
										case 'ne':
											return w;
										case 'eq':
											ctx.emit(I[w].eqz);
											return w;
									}
								}
								ctx.emit(I[w](0));
								const inline	= numericOpInline(method, w, w, ctx);
								ctx.emit(...inline.inline);
								return inline.result;
							}
						}

						if (method === 'eq' || method === 'ne') {
							if (leftInfo.wtype && !scalarKind(leftInfo.wtype) && !scalarKind(rightInfo.wtype)) {
								// `ref.eq` requires `eqref`-typed operands. A boxed-`any` value (a generic `T[]`'s
								// own physical element representation when `T` substitutes to a ref type -- see
								// `case 'array'`'s/`case 'index'`'s own comments on why that's always boxed
								// `anyref`, regardless of what the substituted TS type claims) is only ever
								// statically `anyref`, a strict supertype `ref.eq` rejects outright even though
								// every real value it can hold here is always actually eq-comparable (this
								// compiler never puts a `func`/`extern` value in one) -- narrow it with
								// `ref.cast eq` first. A concrete class/array ref (not boxed `any`) is already a
								// real subtype of `eqref` and reaches here unchanged.
								const isBoxedAny = (w: WasmType) => typeof w !== 'string' && 'ref' in w && w.ref === 'any';
								emitAs(left, ctx, leftInfo.wtype);
								if (isBoxedAny(leftInfo.wtype))
									ctx.emit(I.ref.cast('eq', true));
								emitAs(right, ctx, leftInfo.wtype);
								if (isBoxedAny(leftInfo.wtype))
									ctx.emit(I.ref.cast('eq', true));
								ctx.emit(I.ref.eq);
								if (method === 'ne')
									ctx.emit(I.i32.eqz);
								return 'i32';
							}
						}

						const inline	= numericOpInline(method, leftInfo.wtype, rightInfo.wtype, ctx);
						// Only a FLOAT-kinded operand needs the real `ToInt32` sequence; one that is already
						// `i32`/`u32` is exactly its own low 32 bits, so it costs nothing there.
						const asInt32	= (x: Expr, w: WasmType | undefined, want: WasmType) =>
							BITWISE_METHODS.has(method) && want === 'i32' && (scalarKind(w) === 'f64' || scalarKind(w) === 'f32')
								? emitToInt32(x, ctx)
								: emitAs(x, ctx, want);
						asInt32(left, leftInfo.wtype, inline.params[0]);
						asInt32(right, rightInfo.wtype, inline.params[1]);
						ctx.emit(...inline.inline);
						return inline.result;
					}
				}
			}

			case 'conditional': {
				// `want`, when the caller has one, not just this expression's own self-inferred type --
				// self-inference can legitimately pick a *narrower* physical representation than the
				// context needs (e.g. a small integer literal branch of a `number | null` conditional
				// self-infers as an `i32` box, not the `f64` box the declared type actually uses), and
				// both branches need to agree with whatever the caller will consume regardless.
				const wtype = want ?? wtypeOf(e, ctx);
				if (!wtype)
					throw 'conditional expression has an unsupported type';
				emitTruthy(e.test, ctx);
				const _old = ctx.swapOut();
				inNarrowed(e.test, true, ctx, () => emitAs(e.consequent, ctx, wtype));
				const _then = ctx.swapOut();
				inNarrowed(e.test, false, ctx, () => emitAs(e.alternate, ctx, wtype));
				const _else = ctx.swapOut(_old);
				ctx.emit(I.if(toValType(wtype), _then, _else));
				return wtype;
			}

			case 'new': {
				// `new ArrayBuffer(n)`/`Uint8Array`/etc: real views over a GC byte buffer, resolved through the
				// generic `ensureClass`/`ensureCtor` dispatch below like any other class -- including the
				// array-literal form (`new Uint8Array([1, 2, 3])`), which is just an ordinary call against the
				// `constructor(elements: number[])` overload (`lib/typedarray.ts`), same as a real `number[]`
				// variable would be. That overload's own comment covers the (not yet done) literal-specific
				// optimization this used to hand-implement here.
				// `ctx.scope` (not `global`): a non-entry function's own compiled body now roots its scope at
				// its OWN declaring module (see `compileFunc`'s `homeScope`), so a class declared in the SAME
				// file as the function being compiled resolves here even when the entry module itself never
				// imports that class by name at all. `classRefTarget` additionally covers `new T.Scope(...)`
				// and a local alias to either; a plain identifier naming a lib class (`Set`, `Map` -- no
				// `Scope.decl` of its own) falls through to the unqualified lookup it always used.
				const target = classRefTarget(e.callee, ctx.scope)
					?? (e.callee.type === 'identifier' ? { name: e.callee.name, scope: ctx.scope } : undefined);
				if (!target)
					throw `'new' is only supported for a known class`;
				const cls = ensureClass(target.name, newTypeArgs(target.name, e.typeArgs, e, ctx), target.scope);
				if (!cls)
					throw `'new' is only supported for a known class`;
				const ctor = ensureCtor(cls, e.arguments, ctx);
				emitCallArgs(`${target.name}'s constructor`, ctor.params, ctor.defaults, !!ctor.hasRest, e.arguments, ctx, ctor.resolvedParams);
				ctx.emit(I.call(ctor.funcIndex));
				return cls.thisWtype!;
			}

			// `` tag`Hello ${name}` `` -- synthesizes the exact call real JS itself desugars this to
			// (`tag(strings, ...values)`) and re-enters `emitExpr` on it, reusing the ordinary call-
			// resolution path below (`case 'call'`) wholesale instead of a parallel implementation --
			// arg-count/type coercion for the synthesized call comes free from `emitCallArgs`.
			// `.raw` (a second, unescaped-text view real `TemplateStringsArray` also carries) isn't
			// modeled -- the synthesized strings array is a plain `string[]` of the same (cooked) text
			// `case 'literal'`'s own untagged-template handling already uses, so a tag function declared
			// against `TemplateStringsArray` specifically (rather than a plain `string[]`) isn't supported;
			// typing the parameter as `string[]` works.
			case 'tagged_template': {
				// `e.quasi` doesn't include a trailing empty-string part when the template ends right after
				// a `${...}` (no text after) -- same gap `case 'literal'`'s own untagged-template handling
				// already pads for (`hasTrailingLiteral`), reused identically so `strings.length` matches
				// real semantics (interpolation count + 1) regardless.
				const strings = e.quasi.map(p => Literal(p.str));
				if (e.quasi[e.quasi.length - 1].exp)
					strings.push(Literal(''));
				return emitExpr(JS.Call(
					e.tag,
					[JS.ArrayLit(strings), ...e.quasi.filter(p => p.exp).map(p => p.exp!)],
				) as Expr, ctx, want);
			}

			case 'call': {
				// A bare `__asm<[Params],Result>('...')(args...)` call, anywhere an expression is allowed, not
				// just a class member's sole body statement (`scanInlineMethods`). `$this`/element-kind resolve from `ctx.owner` live here instead of pre-computed, so this works inside a top-level function body too.
				if (e.callee.type === 'call' && isAsm(e.callee)) {
					if (e.arguments.some(a => a.type === 'spread'))
						throw 'inline asm does not support spread call arguments';
					const owner = ctx.owner;
					try {
						const builtin = makeAsm(e.callee, owner?.typeIndex ? {this: owner?.typeIndex} : {});
						return emitInline('<inline>', builtin(e.arguments.map(a => operandInfo(a, ctx)), ctx), e.arguments, ctx);
					} catch (e) {
						throw `inline asm failed to resolve ${e}`;
					}
				}

				if (e.callee.type === 'identifier') {
					// A recursive call to the nested `function_decl` currently being compiled, from inside its
					// own body -- resolved to a direct, statically-known `call` (reusing the same env), not a
					// `call_ref` through a closure struct (see `FuncCtx.selfCall`'s own comment for why).
					if (ctx.selfCall && ctx.name === e.callee.name) {
						const { funcIndex, params, result, hasRest } = ctx.selfCall;
						ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index));
						emitCallArgs(e.callee.name, params, undefined, !!hasRest, e.arguments, ctx);
						ctx.emit(I.call(funcIndex));
						return result;
					}
					// A closure value, called directly (`callback(x)`) -- checked via `ctx.resolvesName` so a local
					// shadowing a same-named global function takes priority, matching JS scoping. Bare identifier callee only for now (not e.g. `obj.field(x)`) -- v1 scope, not a fundamental limit.
					if (ctx.resolvesName(e.callee.name)) {
						const calleeWtype = ctx.resolvedWtype(e.callee.name);
						if (calleeWtype && typeof calleeWtype !== 'string' && 'closure' in calleeWtype) {
							const sig = calleeWtype.closure;
							const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
							// `f?.()` on a NULLABLE closure: the whole call short-circuits to `undefined`,
							// so it needs the same guard `a?.[i]`/`a?.m()` already use. Without it the call
							// went straight through and trapped on a null code pointer.
							if (e.optional && calleeWtype.nullable) {
								if (sig.result === 'void')
									throw "'f?.()' is not supported -- 'f' returns 'void', which can't become 'void | undefined'";
								const resultWtype = nullableWtype(sig.result);
								emitExpr(e.callee, ctx);
								return emitOptionalAccess(ctx, calleeWtype, resultWtype, objLocal => {
									ctx.emit(I.local.get(objLocal), I.struct.get(structTypeIndex, 1));
									emitCallArgs(e.callee.name, sig.params, sig.defaults, !!sig.hasRest, e.arguments, ctx, sig.resolvedParams);
									ctx.emit(I.local.get(objLocal), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
									coerceTop(sig.result, ctx, resultWtype);
								});
							}
							emitExpr(e.callee, ctx);
							const scratch = ctx.declareLocal(`$closure$${closureCallTempCounter++}`, calleeWtype);
							ctx.emit(I.local.tee(scratch.index), I.struct.get(structTypeIndex, 1));
							// A closure *literal*'s own params still can't be optional (a real, separate
							// restriction, unaffected) -- `sig.defaults` is only ever populated when this closure's
							// static TYPE (not necessarily its concrete value) declared a bare `p?: T` trailing
							// param, same rest-packing as a plain named function's own call site either way.
							emitCallArgs(e.callee.name, sig.params, sig.defaults, !!sig.hasRest, e.arguments, ctx, sig.resolvedParams);
							// The code pointer (funcref) is pushed last -- `call_ref` consumes it off the stack top, after every real argument.
							ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
							return sig.result;
						}
					}
					// A cross-module (or same-module, non-entry) `const X = someFactory(...)` -- not a
					// `function_decl`, so nothing above ever finds it. `ctx.scope` (correctly rooted at this
					// function's own declaring module, see `compileFunc`'s `homeScope`) resolves it via the
					// same `Scope.decl` mechanism `ensureClass`'s own `declScope` param already uses for a
					// non-entry class. `ensureLazyGlobal` computes the real value once, lazily, on first call
					// (the pervasive `Rule([...], ...)`/`terminal(...)`/`Rules(...)` idiom this whole grammar-
					// spec pair is built from); the result is then called through the ordinary closure
					// `call_ref` mechanism, same as any other closure value.
					{
						const calleeName = e.callee.name;
						const varStmt = ctx.scope.decl(calleeName);
						if (varStmt?.type === 'var_decl') {
							const d = varStmt.declarations.find(d => d.name === calleeName);
							if (d) {
								// `ctx.homeModule` is the CALLER's own home module, not necessarily where this
								// value is actually declared -- `stmtHomeModule` recovers the real one.
								const wrapper = ensureLazyGlobal(calleeName, stmtHomeModule.get(varStmt) ?? ctx.homeModule, d, ctx.scope);
								const calleeWtype = wrapper?.result;
								if (calleeWtype && typeof calleeWtype !== 'string' && 'closure' in calleeWtype) {
									const sig = calleeWtype.closure;
									const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
									ctx.emit(I.call(wrapper!.funcIndex));
									const scratch = ctx.declareLocal(`$closure$${closureCallTempCounter++}`, calleeWtype);
									ctx.emit(I.local.tee(scratch.index), I.struct.get(structTypeIndex, 1));
									emitCallArgs(e.callee.name, sig.params, sig.defaults, !!sig.hasRest, e.arguments, ctx, sig.resolvedParams);
									ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
									return sig.result;
								}
							}
						}
					}
					// One-shot: consumed here (for this call's own generic type-param inference, if it applies)
					// and cleared immediately, so it can't leak into this same call's own arguments below (see
					// `contextualReturn`'s own comment on why that would be wrong).
					const contextualReturn = ctx.contextualReturn;
					ctx.contextualReturn = undefined;
					return emitCall(e.callee.name, e.arguments, ctx, e.typeArgs, contextualReturn);
				}

				// `obj?.method(...)` -- the `?.` sits on the `member` callee (or a chain further out
				// continues one, e.g. `obj?.a.method(...)` -- `isOptionalChainLink`, not a bare
				// `e.callee.optional`, see `case 'member'`'s own comment). Treated as one guarded operation:
				// `obj` evaluated once, checked for null, call only in the non-null arm -- restricted to a real user method (`ensureMethod`), not a `Math`/prelude intrinsic whose result type depends on the call site.
				if (e.callee.type === 'member') {
					if (isOptionalChainLink(e.callee)) {
						const objExpr		= e.callee.object;
						const methodName	= e.callee.property;
						const objWtype		= wtypeOf(objExpr, ctx);
						if (!objWtype || typeof objWtype === 'string')
							throw `'a?.${methodName}(...)' needs an object-typed value on its left`;
						const owner = ownerOf(objExpr, ctx);
						if (!owner)
							throw `unknown method '${methodName}'`;
						const typeArgs = e.typeArgs;
						const method = ensureMethod(owner, methodName, e.arguments, ctx, typeArgs);
						if (!method)
							throw `'a?.${methodName}(...)' is not supported -- only a plain user-defined method (not a 'Math'/prelude intrinsic) can be guarded by '?.' in this pass`;
						if (method.result === 'void')
							throw `'a?.${methodName}(...)' is not supported -- '${methodName}' returns 'void', which can't become 'void | undefined'`;
						emitAs(objExpr, ctx, objWtype);
						const resultWtype = nullableWtype(method.result);
						return emitOptionalAccess(ctx, objWtype, resultWtype, objLocal => {
							// Receiver pushed directly, skipping `emitMethodCall`'s own `receiver` param
							// needs an explicit `ref.as_non_null` here, always sound since `readCore` only runs in the proven-non-null arm.
							ctx.emit(I.local.get(objLocal), I.ref.as_non_null);
							coerceTop(emitMethodCall(owner, methodName, e.arguments, ctx, typeArgs), ctx, resultWtype);
						});
					}

					// `super.method(...)` -- by definition never virtual: real TS's own `super.x()` semantics
					// mean "the ancestor's own implementation, whichever one actually defines it," never "redo
					// the receiver's runtime-type dispatch" (that's exactly what distinguishes it from
					// `this.method()`). `emitMethodCall(superClass, ...)` -- not the cascade `ensureVirtualDispatch`
					// might otherwise route a same-named call through -- reaches `ensureMethod`'s own ordinary
					// "not overridden by `superClass` itself -> delegate further up the chain" fallback for free,
					// so this resolves correctly even when `superClass` itself doesn't define `method` either.
					if (e.callee.object.type === 'super') {
						const superClass = (ctx.owner && 'fields' in ctx.owner ? ctx.owner as ClassInfo : undefined)?.superClass;
						if (!superClass)
							throw `'super.${e.callee.property}(...)' has no superclass to resolve against`;
						// `this`'s own static type is the current class (more derived than `superClass`) --
						// wasm-GC struct subtyping (`ensureClass`'s own `supertypes`) makes it directly usable as
						// `superClass`'s own receiver type, no cast needed, same as any other upcast in this file.
						emitAs({ type: 'this' }, ctx, superClass.thisWtype!);
						return emitMethodCall(superClass, e.callee.property, e.arguments, ctx, e.typeArgs, true);
					}

					const obj = e.callee.object;
					const typeArgs = e.typeArgs;
					if (obj.type === 'identifier') {
						// `Object.entries` -- a known global intrinsic (see `emitObjectEntries`'s own comment for
						// why this can't just be `namespaceOwner`/`ensureClass`-dispatched like an ordinary static
						// method), checked before the generic paths below.
						if (obj.name === 'Object' && e.callee.property === 'entries')
							return emitObjectEntries(e.arguments, ctx);
						if (obj.name === 'Object' && e.callee.property === 'defineProperty')
							return emitObjectDefineProperty(e.arguments, ctx);
						// A namespace-import-qualified call (`NS.foo(...)`, `import * as NS from '...'`) into
						// another module -- checked before `namespaceOwner`, which only knows about real classes/
						// lib namespaces (`Math`, `Array`), never an actual cross-file import; only takes this
						// path when the target module really does declare `foo` as a plain function, so an
						// unsupported cross-module reference (a class, a scalar global, a host-module member like
						// `path.join`) still falls through to the ordinary paths below and their own clear errors.
						// `functionDeclByName` directly, not `resolveDecl` -- a namespace-qualified reference must
						// only ever match what the *target module itself* actually declares, never spuriously
						// fall back to an unrelated same-named `LIB_DECL_MAP` global.
						const nsDecl	= ctx.scope.namespace(obj.name)?.decl(e.callee.property);
						const nsTarget	= nsDecl && stmtHomeModule.get(nsDecl);
						if (nsTarget !== undefined && functionDeclByName.has(homeKey(nsTarget, e.callee.property)))
							return emitCall(e.callee.property, e.arguments, ctx, typeArgs, undefined, nsTarget);
						const owner = namespaceOwner(obj.name, ctx);
						if (owner)
							return emitMethodCall(owner, e.callee.property, e.arguments, ctx, typeArgs);
						const name = `${obj.name}.${e.callee.property}`;
						if (name in builtins)
							return emitCall(name, e.arguments, ctx);
					}
					const owner = ownerOf(obj, ctx);
					if (!owner) {
						// No single static owner -- if the receiver is genuinely `any`, a real runtime dispatch can still resolve it, same as real JS would.
						// Checked via the checker's own type, not `wtypeOf` (gives `undefined`, not `REF_ANY`,
						// for a genuinely `any`-typed expression). `want ?? REF_ANY`: a bare expression-statement calls `emitExpr` with no `want` at all, and `REF_ANY` is always a safe target (`coerceTop` widens to it).
						if (T.isAny(checkerTypeOf(unwrapAs(obj), ctx.scope)) && e.arguments.length === 0) {
							const info = ensureAnyDispatch(e.callee.property, want ?? REF_ANY, ctx);
							emitAs(obj, ctx, REF_ANY);
							ctx.emit(I.call(info.funcIndex));
							return info.result;
						}
						// A real union receiver -- the sibling of `case 'member'`'s own union FIELD dispatch,
						// and the same `ref.test` cascade, just calling each member's method instead of
						// reading its field. Emitted inline rather than as a shared dispatcher function
						// (`ensureUnionFieldDispatch`) because the arguments are ordinary expressions right
						// here: re-emitting them per arm duplicates code but not evaluation, since exactly
						// one arm ever runs. The receiver itself goes through a local so it is evaluated once.
						const methodName = e.callee.property;
						const unionOwners = unionMethodOwners(obj, methodName, e.arguments, ctx);
						if (unionOwners) {
							const args = e.arguments;
							const result = wtypeOf(e, ctx) ?? want ?? REF_ANY;
							const recv = ctx.declareLocal(`$udisp$${optionalTempCounter++}`, REF_ANY_NULLABLE);
							emitAs(obj, ctx, REF_ANY_NULLABLE);
							ctx.emit(I.local.set(recv.index));
							const buildArm = (i: number): wasm.Instr[] => {
								if (i >= unionOwners.length)
									return [I.unreachable];
								const m = unionOwners[i];
								ctx.emit(I.local.get(recv.index), I.ref.test(m.typeIndex));
								const _cond = ctx.swapOut();
								ctx.emit(I.local.get(recv.index), I.ref.cast(m.typeIndex));
								coerceTop(emitMethodCall(m, methodName, args, ctx, typeArgs), ctx, result);
								return [..._cond, I.if(result === 'void' ? undefined : toValType(result), ctx.swapOut(), buildArm(i + 1))];
							};
							ctx.emit(...buildArm(0));
							return result;
						}
						throw `unknown method '${e.callee.property}'`;
					}
					// A method that reassigns `this` (`reassignsThis`/`assignsToThis`) needs its receiver's real
					// physical lvalue -- `emitAssignTarget('keep')` pushes that value for the call and sets up the write-back, reusing the same machinery compound assignment/`++`/`--` use. `target.write` then consumes
					// the callee's own extra wasm-level updated-`this` result, leaving the declared result underneath. A receiver with nothing to write back to gets `emitAssignTarget`'s own error, for free.
					if (ensureMethod(owner, e.callee.property, e.arguments, ctx, typeArgs)?.reassignsThis) {
						const target = emitAssignTarget(obj, ctx, 'keep');
						const result = emitMethodCall(owner, e.callee.property, e.arguments, ctx, typeArgs);
						target.write(false);
						return result;
					}
					// `emitAs`, not a raw `emitExpr` -- `obj` may be a ref-kind array element read, boxed `anyref` -- the call needs the real narrowed receiver type first, same as `case 'member'`'s getter/field reads.
					emitAs(obj, ctx, (owner as ClassInfo).thisWtype!);
					return emitMethodCall(owner, e.callee.property, e.arguments, ctx, typeArgs);
				}

				// A closure value read off an array element, called directly (`arr[i](x)`) -- same shape as
				// the bare-identifier case above, generalized via the callee's own static type (`wtypeOf`)
				// instead of a name-based lookup (an index expression has no name to resolve by).
				if (e.callee.type === 'index') {
					const calleeWtype = wtypeOf(e.callee, ctx);
					if (calleeWtype && typeof calleeWtype !== 'string' && 'closure' in calleeWtype) {
						const sig = calleeWtype.closure;
						const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
						// `emitAs`, not a raw `emitExpr` -- an array element read is a boxed `anyref` (every
						// ref-kind element is stored generically), the call needs the real narrowed closure
						// type first, same reasoning as `case 'call'`'s member-callee receiver above.
						emitAs(e.callee, ctx, calleeWtype);
						const scratch = ctx.declareLocal(`$closure$${closureCallTempCounter++}`, calleeWtype);
						ctx.emit(I.local.tee(scratch.index), I.struct.get(structTypeIndex, 1));
						emitCallArgs('<indexed closure>', sig.params, sig.defaults, !!sig.hasRest, e.arguments, ctx, sig.resolvedParams);
						ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
						return sig.result;
					}
				}

				throw 'only direct calls to named functions, methods, or Math intrinsics are supported';

			}

			// Closures: a captured arrow/function-expression literal compiles to a 2-field `{code, env}`
			// wasm-GC struct -- building it here is "closure creation"; `case 'call'` handles *using* the result. v1 restrictions are all explicit throws, never silent misbehavior.
			case 'arrow':
			case 'function':
				return emitClosureLiteral(e, ctx, false, want);

			default:
				throw `unsupported expression '${e.type}'`;
		} } catch (err) {
			throw new TSWError(err as any, e);
		}
	}

	// ===================================================================
	//  Statement lowering
	// ===================================================================

	// The ordinary meaning of `return` -- an unremarkable function/method/arrow with no
	// generator/async/constructor/reassignsThis-specific behavior overriding `ctx.onReturn`. Shared
	// (not stashed as a `FunctionContext` field default) since the class itself, defined before this
	// closure, can't reach `emitAs` -- see `ReturnHandler`'s own comment for who overrides this and why.
	// `result` has two equivalent "no value" spellings floating around this file -- the plain
	// `WasmType` string `'void'` (what a real `: void`-annotated/inferred function's own `result`
	// holds) and a bare omitted argument (what a caller with no meaningful `WasmType` at all, e.g. a
	// resumable step function, passes) -- normalized to `undefined` right here, once, rather than
	// trusting every caller to already agree on which spelling they're using.
	function plainReturn(result?: WasmType): ReturnHandler {
		if (result === 'void')
			result = undefined;
		return {
			wtype: () => result,
			emit(ctx, argument) {
				if (result === undefined) {
					if (argument)
						throw "a 'void' function cannot return a value";
				} else if (argument) {
					emitAs(argument, ctx, result);
				}
				ctx.emit(I.return);
			},
		};
	}

	function emitStmt(s: Stmt, ctx: FunctionContext): void {
		ctx.stmtScope = (s as any).scope as Scope ?? ctx.stmtScope;
		switch (s.type) {
			case 'empty':
				return;

			case 'block':
				ctx.inScope(() => s.body.forEach(st => emitStmt(st, ctx)));
				return;

			case 'var_decl':
				for (const d of s.declarations) {
					if (!d.init)
						throw `local '${describeBinding(d.name)}' needs an initializer`;
					if (typeof d.name !== 'string') {
						// Materializes `d.init` into a hidden scratch local once (`#destructure$<n>`), then
						// desugars into plain `var_decl`s reading their own piece back off it -- emitted
						// directly (not wrapped in a `block`) since these bindings belong to the *same*
						// scope as the original `var_decl`, not a nested one.
						const tmpName = `#destructure$${destructureTempCounter++}`;
						for (const stmt of [
							JS.VarDecl('const', JS.Var(tmpName, d.init, d.typeAnnotation)),
							...patternBindings(s.kind, d.name, { type: 'identifier', name: tmpName }),
						])
							emitStmt(stmt, ctx);
						continue;
					}
					// Type computed before emitting the init, so the init can be emitted via `emitAs` straight into the local's declared representation.
					// `checker.scopeOfStmt(s)` -- the real, narrowing-aware scope the checker type-checked
					// this statement under -- not `ctx.scope` (towasm's own, separately-tracked scope, which
					// never reflects flow-sensitive narrowing the way the checker's internal scope tree does).
					// Without it, a narrowed-non-null receiver (e.g. `if (m === null) return; ...; m.group(0)`)
					// would still look nullable to `checkerTypeOf` here and member/call resolution could fail
					// on it. Falls back to `ctx.scope` only if somehow unset (shouldn't happen post-`TStypeCheck`).
					const stmtScope = (s as any).scope as Scope ?? ctx.scope;
					const {methodOwner, methodName, calleeOptional} = d.init.type === 'call' && d.init.callee.type === 'member'
						? {methodOwner: ownerOf(d.init.callee.object, ctx), methodName: d.init.callee.property, calleeOptional: d.init.callee.optional}
						: {};

					// No `Array<T>` substitution needed -- `substElemMethods` already monomorphized a method's whole body once, up front, so `d.typeAnnotation` is already concrete here.

					// `ctx.widenedTypes` checked before `T.literalTypeOf` -- a loop-reassigned local's own
					// widened range (covering every value it's ever set to, not just its initial one) must
					// win over the initializer's own narrower literal type, or its wasm local gets fixed too
					// tight and a later in-range-exceeding reassignment corrupts it.
					let tsType = d.typeAnnotation ?? ctx.widenedTypes?.get(d) ?? T.literalTypeOf(d.init);
					if (!tsType && d.init.type === 'index') {
						// The real declared element `Type` of an array-like container -- `T[]`/`Array<T>`'s `T` directly, or the fixed element type real TS gives `Uint8Array`/`Int32Array`/etc indexing.
						// `Uint8Array`/etc resolve (`resolveClassAlias`, before `T.resolve` ever expands the bare
						// alias) to `TypedArray<T>` -- but every element there reads back as `number` regardless
						// of `T` (a physical-storage tag, not the real TS element type), unlike `Array<T>` below,
						// where iterating genuinely gives `T` itself.
						const objT = checkerTypeOf(d.init.object, stmtScope);
						if (objT.type === 'ref' && !objT.typeArgs && resolveClassAlias(objT.name)?.name === 'TypedArray') {
							tsType = T.NUMBER;
						} else {
							const w = T.widenLiterals(T.resolve(global, objT), false, true);
							if (w.type === 'array') {
								tsType = w.element;
							} else if (w.type === 'ref') {
								switch (w.name) {
									case 'Array':
									case 'ReadonlyArray':	tsType = w.typeArgs?.[0]; break;
								}
							}
						}
						// `arr?.[i]` short-circuits to `undefined` same as any other `?.` -- this bypasses
						// `checkerTypeOf` (a fast structural read of the element type instead), so the optional
						// flag has to be reattached here too, same as `case 'member'`'s own `e.optional` handling.
						if (tsType && d.init.optional)
							tsType = T.combineTypes([tsType, T.UNDEFINED]);
					}
					if (!tsType && methodOwner) {
						// This reads the method's raw declared return type directly off the class decl, not
						// `checkerTypeOf(d.init, stmtScope)` -- `stmtScope`'s stamp only exists for a lib
						// method body when `makeLibScope`'s one-time check wasn't muted for it, and (see
						// `makeLibScope`'s own comment) that's deliberately not always the case: a GENERIC lib
						// class method (`Array<T>.reverse`/`.fill`/...) would get a stamp reflecting the
						// template's own unresolved `T` if unmuted, permanently blocking (`??=` first-wins)
						// the real, per-instantiation substituted scope (`ctx.scope`) that codegen actually
						// needs. This bypass sidesteps that tension entirely for method-call return types,
						// same as it always has. A `?.`-guarded call's short-circuit-to-`undefined` also isn't
						// reflected in the class decl's own return type, so it's reattached here too.
						// A `this`-typed return (`sort(): this`) read off the raw class decl this way is still just
						// the literal, unresolved `this` node -- substituted the same way `ensureMethod` resolves
						// it for the method body's own signature (the declaring class's own type, not any more
						// specific receiver type the checker's own call-site inference might know about; this
						// bypass path doesn't have that available, matching its existing generic-lib-method tradeoff).
						const methodReturn = (methodOwner.decl.body.find(m => m.type === 'method' && m.key === methodName) as MethodMember)?.returnType;
						const substituted = methodReturn && T.substituteThisType(methodReturn, methodOwner.thisTsType);
						tsType = substituted && calleeOptional ? T.combineTypes([substituted, T.UNDEFINED]) : substituted;
					}

					tsType ??= checkerTypeOf(d.init, stmtScope);
					// A SYNTHETIC statement (`for...of` and destructuring both synthesize a `var_decl`) is
					// never stamped, so `stmtScope` above is just `ctx.scope`, which carries no narrowing:
					// `for (const i of w.body)` inside `if (w.kind === 'w')` bound `#for0$arr` from an
					// unnarrowed `w` and got `any`. `narrowedTypeOf` rather than `ctx.typeScope` outright,
					// so this only fires where `ctx.scope` had NO answer -- a narrowed scope can otherwise
					// resolve a clean nominal `Map<K,V>` into its full structural shape, which `ownerFor`
					// then builds an anonymous struct for instead of finding the class.
					if (T.isAny(tsType) && !(s as any).scope)
						tsType = narrowedTypeOf(d.init, ctx);

					let wtype = typeOf(tsType);
					// This declarator is itself later the target of a real Object.defineProperty call
					// somewhere in this same function body (`ctx.definePropertyTargets`'s own comment) --
					// allocate its class's own extension subclass instead of the plain base
					// (`ensureClassExtension`'s own comment), so the write actually has a real field (or
					// catch-all `Map`) to land in. `pendingExtensions` is updated with this specific
					// declarator's own real keys *before* the extension is ever built, so a base class
					// reached this way for the first time gets the accurate shape immediately, not a
					// placeholder later calls would need to somehow patch.
					if (wtype && typeof d.name === 'string' && typeof wtype !== 'string' && 'ref' in wtype) {
						const keys = ctx.definePropertyTargets?.get(d.name);
						if (keys) {
							const base = ensureClass(wtype.ref);
							if (base) {
								const prior = pendingExtensions.get(base.name);
								pendingExtensions.set(base.name, prior === 'dynamic' || keys === 'dynamic' ? 'dynamic' : [...new Set([...(prior ?? []), ...keys])]);
								wtype = ensureClassExtension(base).thisWtype!;
							}
						}
					}
					if (!wtype) {
						// Let the actual lowering throw its own more specific error first (e.g. indexing a `string`) -- only fall back to this generic message if it didn't.
						emitExpr(d.init, ctx);
						throw `local '${d.name}' has an unsupported type`;
					}
					if (wtype === 'void')
						throw `local '${d.name}' cannot have type 'void'`;
					// A generator's own hoisted local (`compileGeneratorFunc`) -- storage is a frame struct
					// field, not a real wasm local, same as a real closure capture would be (`declareCaptured`
					// already registered its scope type upfront, so only the write itself is new here).
					const hoisted = ctx.closureEnv?.fields.get(d.name);
					// `tsType` is the one real TS type this declaration has on hand -- seeds `ctx.contextualReturn`
					// (see its own comment) for `d.init`'s own top-level compilation, e.g. an array literal whose
					// element is itself a generic call (`const rules: Expr[] = [makeRule(() => ({...}))]`).
					const savedContextualReturn = ctx.contextualReturn;
					ctx.contextualReturn = tsType;
					if (hoisted) {
						ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index));
						emitAs(d.init, ctx, wtype);
						ctx.emit(I.struct.set(ctx.closureEnv!.envTypeIndex, hoisted.index));
					} else {
						// An EARLIER sibling closure may already have forward-referenced this exact name
						// (`ensureForwardCell`, from `emitClosureLiteral`'s own free-var check) -- but so may
						// `d.init` ITSELF, compiled next (a self-recursive arrow, e.g. walker.ts's own
						// `mapBindingTarget`, calling its own not-yet-declared name from inside its own body).
						// Either way a plain `declareValue` after the fact would silently shadow the cell with
						// a second, independent local, leaving whatever captured it forever empty -- so the
						// check for an existing cell has to happen AFTER `d.init` compiles, not before, and
						// the value goes through a scratch local first (`struct.set` needs the cell's own ref
						// pushed before the value, but the value is what's already on the stack at this point).
						// A local a nested closure captures and something assigns has to BE a cell from the
						// start, not a value copied into the env (`needsCell`). Declared before `d.init`
						// compiles so a closure inside the initializer captures the cell too, and so the
						// store below goes through the same path a forward reference already took.
						if (!ctx.lookup(d.name)?.cellInner && needsCell(ctx, d.name))
							declareCell(ctx, d.name, wtype, tsType);
						emitAs(d.init, ctx, wtype);
						const forwardCell = ctx.lookup(d.name);
						if (forwardCell?.cellInner) {
							const scratch = ctx.temp(`$fwd$${d.name}`, wtype);
							ctx.emit(I.local.set(scratch), I.local.get(forwardCell.index), I.local.get(scratch));
							ctx.emit(I.struct.set((forwardCell.wtype as { typeIndex: number }).typeIndex, 0));
						} else {
							ctx.emit(I.local.set(ctx.declareValue(d.name, wtype, tsType).index));
						}
					}
					ctx.contextualReturn = savedContextualReturn;
				}
				return;

			case 'expression':
				if (emitExpr(s.expression, ctx, 'void') !== 'void')
					ctx.emit(I.drop);
				return;

			case 'if': {
				emitTruthy(s.test, ctx);
				const old = ctx.swapOut();
				ctx.enterLabel();
				emitStmt(s.consequent, ctx);
				if (s.alternate) {
					const _then = ctx.swapOut();
					emitStmt(s.alternate, ctx);
					ctx.exitLabel();
					ctx.emit(I.if(undefined, _then, ctx.swapOut(old)));
				} else {
					ctx.exitLabel();
					ctx.emit(I.if(undefined, ctx.swapOut(old)));
				}
				return;
			}

			case 'while': {
				const _old = ctx.swapOut();
				emitTruthy(s.test, ctx);
				ctx.enterBreakTarget();
				ctx.enterContinueTarget();
				ctx.emit(I.i32.eqz, I.br_if(1));
				emitStmt(s.body, ctx);
				ctx.emit(I.br(0));
				ctx.exitContinueTarget();
				ctx.exitBreakTarget();
				ctx.emit(I.block(undefined, [I.loop(undefined, ctx.swapOut(_old))]));
				return;
			}
			case 'do_while': {
				const _old = ctx.swapOut();
				ctx.enterBreakTarget();
				ctx.enterContinueTarget();
				emitStmt(s.body, ctx);
				emitTruthy(s.test, ctx);
				ctx.emit(I.br_if(0));
				ctx.exitContinueTarget();
				ctx.exitBreakTarget();
				ctx.emit(I.block(undefined, [I.loop(undefined, ctx.swapOut(_old))]));
				return;
			}
			case 'continue': {
				if (s.label)
					throw "labeled 'continue' is not supported";
				if (!ctx.continueTargets.length)
					throw "'continue' outside of a loop";
				ctx.emitContinue();
				return;
			}

			case 'break': {
				if (s.label)
					throw "labeled 'break' is not supported";
				if (!ctx.breakTargets.length)
					throw "'break' outside of a loop or switch";
				ctx.emitBreak();
				return;
			}

			case 'return':
				// Same reasoning as `case 'this'`'s own guard -- a `return` inside a constructor implicitly
				// needs `this` to exist too (that's the whole value being returned), even a bare one with
				// no argument at all: `ctx.onReturn` is still the generic `plainReturn(thisWtype)` handler
				// at this point (not yet swapped to the constructor-specific one, which only happens once
				// every field is collected), so it would either emit invalid wasm (a bare 'return' with
				// nothing of the declared result type on the stack) or, for `return <value>`, try to coerce
				// an arbitrary expression into the class's own struct type -- neither is a real, checkable
				// program error worth a confusing low-level failure instead of a clear one.
				if (ctx.ctorFields)
					throw `'return' can't be used yet in '${ctx.owner?.name}'s constructor -- not every field has been assigned yet (this class has at least one object-typed field, needing 'struct.new' with every field's real value up front, before 'this' -- and so a valid return -- exists at all)`;
				ctx.onReturn.emit(ctx, s.argument);
				return;

			case 'for':
				switch (s.kind) {
					case 'normal':
						ctx.inScope(() => {
							// `s.init`'s own declaration (`for (let t = ...; ...)`) is scoped to the loop itself,
							// same as real JS -- opened here rather than relying on `s.body`'s own block scope
							// (which may not exist at all if the body is a single bare statement).
							if (s.init)
								emitStmt(s.init.type === 'var_decl' ? s.init : { type: 'expression', expression: s.init }, ctx);

							// A `block` wrapping a `loop`, same idiom as `while`, except the body gets its own *inner*
							// block as the real `continue` target -- a plain `while` can reuse its restart label since it has no separate update step, but this desugared `for` has one (`s.update`) that must still run first.
							const old = ctx.swapOut();
							emitTruthy(s.test ?? Literal(true), ctx);
							ctx.emit(I.i32.eqz);
							ctx.enterBreakTarget();
							ctx.enterLabel();	// the bare "loop" level, between the break-block and the continue-block
							ctx.emit(I.br_if(1));

							const bodyOld = ctx.swapOut();
							ctx.enterContinueTarget();
							emitStmt(s.body, ctx);
							ctx.exitContinueTarget();
							ctx.emit(I.block(undefined, ctx.swapOut(bodyOld)));

							if (s.update)
								emitStmt({ type: 'expression', expression: s.update }, ctx);
							ctx.emit(I.br(0));
							ctx.exitLabel();
							ctx.exitBreakTarget();
							ctx.emit(I.block(undefined, [I.loop(undefined, ctx.swapOut(old))]));
						});
						return;

					case  'of': {
						// The loop variable's own `name` (`v.name` below) may be a plain identifier or a real
						// destructuring pattern (`for (const [k, v] of pairs)`) -- `JS.Var`'s own `name: BindingTarget`
						// already carries either through unchanged, and the synthesized `var_decl` this desugars into
						// (`JS.VarDecl(s.init.kind, JS.Var(v.name, ...))` below) is handled the same generic way any
						// other pattern-typed `var_decl` already is (`hoistVar`/`patternBindings`) -- nothing here
						// needs to know or care which shape `v.name` is.
						if (s.init.type !== 'var_decl' || s.init.declarations.length !== 1)
							throw "'for...of' loop variable must be a single declaration";

						const v			= s.init.declarations[0];
						const n			= forTempCounter++;
						const arrId: Expr = { type: 'identifier', name: `#for${n}$arr` };
						const idxId: Expr = { type: 'identifier', name: `#for${n}$i` };

						emitStmt(JS.Block<Stmt>(
							JS.VarDecl('const', JS.Var(arrId.name, s.right)),
							JS.For(
								JS.VarDecl('let', JS.Var(idxId.name, Literal(0))),
								JS.JSBinary('<', idxId, JS.Member(arrId, 'length')),
								JS.JSUnary('++', idxId),
								JS.Block<Stmt>(
									JS.VarDecl(s.init.kind, JS.Var(v.name, JS.Index(arrId, idxId), v.typeAnnotation)),
									s.body
								),
							),
						), ctx);
						return;
					}
					// `for (const k in obj)` -- most efficiently over a dynamic object (structural
					// `{[k: string]: V}`, routed to `Map<string, V>`; see `indexSignatureValueType`),
					// which has a real, live key set: desugars to `for (const k of obj.keys())`,
					// already-supported syntax, same "synthesize and hand back to `emitStmt`" idiom
					// `case 'of'` itself uses one level down -- `keys()` is a real snapshot array (see
					// `lib/map.ts`'s own comment on why), so this iterates the live key set at the moment
					// the loop starts, matching real `for...in` closely enough for every real use this
					// project has (none mutate the object mid-loop).
					//
					// Anything else falls back to `Object.entries`, pulling just the key out of each
					// `[k, v]` pair via ordinary array-destructuring in the loop variable (this session's
					// own for-of-destructuring fix) -- covers a *sealed* struct/class instance the same
					// way `Object.entries` itself does, and throws the same "not supported yet" error for
					// an extended class, for free, by just deferring to `emitObjectEntries`'s own dispatch
					// rather than re-deriving its sealed/extended check here.
					case 'in': {
						if (s.init.type !== 'var_decl' || s.init.declarations.length !== 1)
							throw "'for...in' loop variable must be a single declaration";

						// A real ARRAY enumerates its INDICES, as strings. Falling through to
						// `Object.entries` below bound the entries instead, so `for (const i in [5, 6])`
						// gave the wrong values and the wrong count. `Array._indexKeys` builds them in
						// ordinary typed lib code -- a synthesized `String(i)` here has no checker stamp
						// to resolve `toString` through.
						if (objectArrayKind(s.right, ctx)) {
							emitStmt({
								type: 'for', kind: 'of',
								init: s.init,
								right: { type: 'call', callee: { type: 'member', object: { type: 'identifier', name: 'Array' }, property: '_indexKeys' }, arguments: [s.right] },
								body: s.body,
							}, ctx);
							return;
						}

						if (ownerOf(s.right, ctx)?.methodDecls.get('keys')) {
							emitStmt({
								type: 'for', kind: 'of',
								init: s.init,
								right: { type: 'call', callee: { type: 'member', object: s.right, property: 'keys' }, arguments: [] },
								body: s.body,
							}, ctx);
							return;
						}

						const v = s.init.declarations[0];
						emitStmt({
							type: 'for', kind: 'of',
							init: { type: 'var_decl', kind: s.init.kind, declarations: [{ ...v, name: JS.ArrayPattern([{ target: v.name }]) }] },
							right: { type: 'call', callee: { type: 'member', object: { type: 'identifier', name: 'Object' }, property: 'entries' }, arguments: [s.right] },
							body: s.body,
						}, ctx);
						return;
					}
					default:
						throw `'for...${s.kind}' is not supported`;
				}

			// Lowers to `n` nested `block`s (innermost = case 0), all wrapped in one outer `block` (the `break`
			// target). The discriminant is compared against each `test` in source order; a match branches into that case's block. Falling off a case's block end lands inside the next case's block -- real JS fallthrough.
			case 'switch': {
				const n = s.cases.length;
				if (n === 0) {
					// No cases -- the discriminant is still evaluated once for its side effects, same as real JS.
					emitStmt({ type: 'expression', expression: s.discriminant }, ctx);
					return;
				}

				/*if (wtypeOf(s.discriminant, ctx) === 'f64')*/ {
					const values = new Map<number, number>;
					let linear = true;
					for (let i = 0; i < n; i++) {
						if (s.cases[i].test) {
							const test = foldConstants(s.cases[i].test!)!;
							if (test.type !== 'literal' || typeof test.value !== 'number') {
								linear = false;
								break;
							}
							values.set(i, test.value);
						}
					}
					// Needs at least 2 distinct test values -- a single value has no meaningful gcd/stride.
					if (linear && values.size >= 2) {
						function gcd(a: number, b: number) {
							while (b > 1e-10)
								[a, b] = [b, a % b];
							return a;
						}
						const sorted = [...values.values()].sort((a, b) => a - b);
						let g = sorted[0];
						sorted.slice(1).forEach((v, i) =>
							g = gcd(g, v - sorted[i])
						);

						const tableSize = Math.ceil((sorted.at(-1)! - sorted[0]) / g) + 1;
						if (tableSize < values.size * 4) {
							//worth it?

							const old = ctx.swapOut();

							ctx.enterBreakTarget();
							ctx.enterLabel(n);

							// `br`/`br_table` labels are already relative to the branch point -- case `i`'s own
							// block is the `i`-th one opened above (case 0 innermost), and "no default" falls
							// through all `n` case-blocks to the enclosing break-target block at relative depth `n`.
							const defaultIndex	= s.cases.findIndex(c => !c.test);
							const defaultBr		= defaultIndex >= 0 ? defaultIndex : n;

							const table = new Array<number>(tableSize).fill(defaultBr);
							values.forEach((v, i) => table[Math.round((v - sorted[0]) / g)] = i);

							emitAs(JS.JSBinary('*', JS.JSBinary('-', s.discriminant, Literal(sorted[0])), Literal(1 / g)), ctx, 'i32');
							ctx.emit(I.br_table(table, defaultBr));

							let content = ctx.out;
							for (let k = 0; k < n; k++) {
								ctx.exitLabel();
								ctx.out = [I.block(undefined, content)];
								s.cases[k].consequent.forEach(st => emitStmt(st, ctx));
								content = ctx.out;
							}
							ctx.exitBreakTarget();
							ctx.out = old;
							ctx.emit(I.block(undefined, content));
							return;

						}
					}
				}

				// One shared scope for the whole switch -- real JS gives every case a single common lexical
				// scope (not one per case) unless a case wraps its own body in `{}`, which nests its own
				// block scope inside this one via `case 'block'` as usual.
				ctx.inScope(() => {
					const discName = `#switch$${switchTempCounter++}`;
					emitStmt(JS.VarDecl('const', JS.Var(discName, s.discriminant)), ctx);
					const discId: Expr = { type: 'identifier', name: discName };

					const old = ctx.swapOut();

					ctx.enterBreakTarget();
					ctx.enterLabel(n);

					for (let i = 0; i < n; i++) {
						const c = s.cases[i];
						if (c.test) {
							emitAs(JS.JSBinary('===', discId, c.test), ctx, 'i32');
							ctx.emit(I.br_if(i));
						}
					}

					const defaultIndex = s.cases.findIndex(c => !c.test);
					ctx.emit(I.br(defaultIndex >= 0 ? defaultIndex : n));

					let content = ctx.out;
					for (let i = 0; i < n; i++) {
						ctx.exitLabel();
						ctx.out = [I.block(undefined, content)];
						s.cases[i].consequent.forEach(st => emitStmt(st, ctx));
						content = ctx.out;
					}
					ctx.exitBreakTarget();
					ctx.out = old;
					ctx.emit(I.block(undefined, content));
				});
				return;
			}

			case 'function_decl':
				// A bodyless declaration is one signature of a local overload group (`hoist()`'s own top-
				// level handling already treats these the same way -- only the one real, bodied
				// implementation a group always has gets registered/compiled; the signatures exist purely
				// for the checker's own overload resolution, nothing to emit here at all). Without this, two
				// or more overload signatures sharing a name each tried to declare their own same-named
				// local, hitting the genuine "redeclared" guard below meant for real, user-visible shadowing.
				if (!s.body)
					return;
				ctx.emit(I.local.set(ctx.declareLocal(s.name, emitClosureLiteral(s, ctx, true)).index));
				return;

			case 'throw':
				emitAs(s.argument, ctx, REF_ANY);
				ctx.emit(I.throw(ensureExceptionTag()));
				return;

			// `try_table`'s catch dispatch is branch-based, not legacy EH's inline-handler style: two
			// nested blocks -- `$after` (the shared landing point once either the try body or the catch
			// handler completes) wraps `$catchLand` (the catch clause's own branch target, delivering the
			// caught `anyref` payload as that block's result). The try body's own success path explicitly
			// `br`s past the handler to `$after`, so `$catchLand`'s wrapped `try_table` never actually
			// falls through to its own end -- `unreachable` closes that dead edge; without it the
			// validator still checks `$catchLand`'s declared (anyref) result against what `try_table`'s
			// own fallthrough would produce there (nothing) and rejects the module.
			// JS's grammar allows at most one `catch`, so `handlers` is only ever empty or a single clause here.
			case 'try':
				if (!s.handlers.length && !s.finalizer)
					throw "'try' needs a 'catch' or 'finally'";

				if (!s.finalizer) {
					const saved			= ctx.swapOut();
					ctx.enterLabel(3);
					ctx.inScope(() => s.body.forEach(st => emitStmt(st, ctx)));
					
					ctx.emit(I.br(2));	//ctx.depth - $after
					ctx.exitLabel();
					ctx.emit(I.try_table(undefined, [wasm.Catch.tag(ensureExceptionTag(), 0)], ctx.swapOut()));
					ctx.emit(I.unreachable);
					ctx.exitLabel();
					ctx.emit(I.block(toValType(REF_ANY), ctx.swapOut()));

					ctx.inScope(() => {
						if (s.handlers[0].param) {
							if (typeof s.handlers[0].param !== 'string')
								throw "a destructured catch parameter ('catch ({...})'/'catch ([...])') is not supported";
							ctx.emit(I.local.set(ctx.declareValue(s.handlers[0].param, REF_ANY, T.ANY).index));
						} else {
							ctx.emit(I.drop);
						}
						s.handlers[0].body.forEach(st => emitStmt(st, ctx));
					});

					ctx.exitLabel();
					ctx.emit(I.block(undefined, ctx.swapOut(saved)));

				} else {

					// A 'finally' is present: every exit -- normal completion, a caught exception, an
					// escaping break/continue/return, or an uncaught exception -- funnels through one shared
					// landing point ($land) that runs 'finally' exactly once, then re-dispatches on a
					// recorded action code. `break`/`continue`/`return` inside the protected region redirect
					// here via `ctx.finallyGuards` (see those `case`s above); the exception path needs no
					// such interception -- `throw_ref` below is an ordinary instruction that propagates
					// outward on its own, caught by whatever real `try_table` happens to enclose *this*
					// landing code, exactly like a fresh `throw` would.
					//
					// A `return`/`throw`/`break`/`continue` written directly inside 'finally' itself also
					// needs no special handling: `ctx.finallyGuards`/`ctx.onReturn` are already restored to
					// their outer values by the time 'finally' compiles (below), so it either executes as a
					// real exit (overriding whatever action was pending -- correct JS semantics) or
					// redirects through the next-*outer* guard/`onReturn` if this 'try' is itself nested
					// inside another 'try'/'finally' -- right either way, for free.
					// Works inside a generator/async function, a constructor, or a `reassignsThis` method
					// too -- `ctx.onReturn` (or `plainReturn`) already knows the real per-context return
					// representation, so the redispatch below reconstructs the rest (IteratorResult/Promise
					// resolution/appended `this`) itself, exactly as if compiling that shape fresh.
					const actionLocal		= { wtype: 'i32' as const, index: ctx.temp('#finally$action', 'i32') };
					const exnLocal			= { wtype: REF_EXN, index: ctx.temp('#finally$exn', REF_EXN) };
					const savedOnReturn		= ctx.onReturn;
					const outerOnReturn		= savedOnReturn;
					const outerWtype		= outerOnReturn.wtype(ctx);
					const returnValueLocal	= outerWtype !== undefined ? { wtype: outerWtype, index: ctx.temp('#finally$retval', outerWtype) } : undefined;

					const saved				= ctx.swapOut();
					const landDepth			= ctx.enterLabel();			// $land
					const catchAllDepth 	= ctx.enterLabel();			// $catchAllLand
					const afterDepth		= ctx.enterLabel();			// $after

					const guard = {
						actionLocal,
						breakTargetsLenAtEntry:		ctx.breakTargets.length,
						continueTargetsLenAtEntry:	ctx.continueTargets.length,
						landingDepth:				landDepth,
					};
					ctx.finallyGuards.push(guard);
					// A `return` inside the protected region below must stash its value and redirect here
					// too, same reasoning as `break`/`continue` -- but there's only ever one "current"
					// return meaning at a time (no stack needed the way nested loops need one for `break`),
					// so a plain swap-and-restore suffices, mirroring `ctx.swapOut()`'s own idiom.
					ctx.onReturn = {
						wtype: () => outerWtype,
						emit(ctx, argument) {
							if (returnValueLocal) {
								if (argument)
									emitAs(argument, ctx, returnValueLocal.wtype);
								else
									emitDefaultValue(returnValueLocal.wtype, ctx);
								ctx.emit(I.local.set(returnValueLocal.index));
							} else if (argument) {
								// Same rejection the real (outer) 'return' would give -- delegate to it for
								// that message (a 'void' function vs. a constructor say this differently)
								// rather than inventing a second copy of the same decision here.
								outerOnReturn.emit(ctx, argument);
							}
							ctx.emit(I.i32.const(1), I.local.set(actionLocal.index), I.br(ctx.depth - landDepth));
						},
					};

					if (s.handlers.length) {
						// A's own exceptions: our single project-wide tag is the only thing this compiler ever throws, so the ordinary tag-catch below already covers 'try' exhaustively --
						// no 'catch_all_ref' needed on *this* try_table (unlike the one below, for B).
						ctx.enterLabel(2);			// $catchLand, try_table (A)'s own implicit level
						ctx.inScope(() => s.body.forEach(st => emitStmt(st, ctx)));
						ctx.emit(I.br(ctx.depth - afterDepth));
						ctx.exitLabel();
						ctx.emit(I.try_table(undefined, [wasm.Catch.tag(ensureExceptionTag(), 0)], ctx.swapOut()));
						ctx.emit(I.unreachable);
						ctx.exitLabel();
						ctx.emit(I.block(toValType(REF_ANY), ctx.swapOut()));

						// The catch param binds $catchLand's own delivered value -- outside and *before*
						// try_table (B) starts: a block's body doesn't inherit values left on the outer stack
						// unless declared as real params (none of these are), so try_table (B) itself must
						// start from a clean slate, not reach back for a value produced before it began.
						ctx.openScope();
							if (s.handlers[0].param) {
								if (typeof s.handlers[0].param !== 'string')
									throw "a destructured catch parameter ('catch ({...})'/'catch ([...])') is not supported";
								ctx.emit(I.local.set(ctx.declareValue(s.handlers[0].param, REF_ANY, T.ANY).index));
							} else {
								ctx.emit(I.drop);
							}

							// B (the catch handler) gets its *own* safety net -- unlike A, nothing else already
							// guarantees every exception B might throw is caught before 'finally' needs to run.
							const catchHandlerSaved = ctx.swapOut();
							ctx.enterLabel();			// try_table (B)'s own implicit level
							s.handlers[0].body.forEach(st => emitStmt(st, ctx));
						ctx.closeScope();

						ctx.emit(I.br(ctx.depth - afterDepth));
						ctx.exitLabel();
						ctx.emit(I.try_table(undefined, [wasm.Catch.allRef(ctx.depth - catchAllDepth)], ctx.swapOut(catchHandlerSaved)));
						ctx.emit(I.unreachable);
					} else {
						// No 'catch' clause -- 'finally' alone needs only the safety net around A itself.
						ctx.enterLabel();			// try_table's own implicit level
						ctx.inScope(() => s.body.forEach(st => emitStmt(st, ctx)));
						ctx.emit(I.br(ctx.depth - afterDepth));
						ctx.exitLabel();
						ctx.emit(I.try_table(undefined, [wasm.Catch.allRef(ctx.depth - catchAllDepth)], ctx.swapOut()));
						ctx.emit(I.unreachable);
					}

					ctx.finallyGuards.pop();
					ctx.onReturn = savedOnReturn;

					ctx.exitLabel();				// exit $after
					ctx.emit(I.block(undefined, ctx.swapOut()));
					ctx.emit(I.i32.const(0), I.local.set(actionLocal.index), I.br(ctx.depth - landDepth));
					ctx.exitLabel();				// exit $catchAllLand
					ctx.emit(I.block(toValType(REF_EXN), ctx.swapOut()));
					ctx.emit(I.local.set(exnLocal.index), I.i32.const(4), I.local.set(actionLocal.index));
					ctx.exitLabel();				// exit $land
					ctx.emit(I.block(undefined, ctx.swapOut(saved)));

					ctx.inScope(() => s.finalizer!.forEach(st => emitStmt(st, ctx)));

					// Re-dispatch: exactly one of these ever actually fires per call (the action codes above
					// are mutually exclusive), each gated by its own 'if' so the validator only ever checks
					// one small, simple branch at a time.
					const dispatch = (code: number, build: () => void) => {
						ctx.emit(I.local.get(actionLocal.index), I.i32.const(code), I.i32.eq);
						const old = ctx.swapOut();
						ctx.enterLabel();			// this 'if''s own implicit level -- a depth-relative 'br' built by `build()` (e.g. a nested try/finally's own redispatch) needs it counted
						build();
						ctx.exitLabel();
						ctx.emit(I.if(undefined, ctx.swapOut(old)));
					};
					dispatch(1, () => outerOnReturn.emit(ctx, returnValueLocal ? { type: 'identifier', name: '#finally$retval' } : undefined));
					// A synthesized 'break'/'continue' only ever compiles to a real target this construct
					// could actually reach at runtime -- skip building the arm at all when there wasn't one
					// enclosing it in the first place (action can then never actually be 2/3), or 'case break'/
					// 'case continue' rejects it outright even though it would never really execute.
					if (guard.breakTargetsLenAtEntry > 0)
						dispatch(2, () => ctx.emitBreak());
					if (guard.continueTargetsLenAtEntry > 0)
						dispatch(3, () => ctx.emitContinue());
					dispatch(4, () => ctx.emit(I.local.get(exnLocal.index), I.throw_ref));
				}
				return;

			default:
				throw `unsupported statement '${s.type}'`;
		}
	}

	// ===================================================================
	//  Function/Method
	// ===================================================================

	// A non-`void` body doesn't necessarily end in a top-level `return` -- `if`/`while`/`switch` compile to a `void`-typed block wrapping their branches, leaving wasm's trailing-fallthrough check unsatisfied.
	// No full "does every path return" analysis to avoid it -- a trailing `unreachable` is always safe (dead code whenever a real return already covers every path).
	function emitTrailingUnreachable(ctx: FunctionContext, result: WasmType): void {
		if (result !== 'void')
			ctx.emit(I.unreachable);
	}

	// One shared pair of wasm types per distinct TS function signature (memoized by `wasmTypeKey` -- every
	// literal still gets its own concrete env type and `funcIndex`): `funcTypeIndex` is shared so every literal of this signature is callable via one `call_ref`; `structTypeIndex` is the 2-field `{code, env}` value type.
	function ensureClosureType(sig: FuncSig): ClosureTypeInfo {
		const key = `(${sig.params.map(wasmTypeKey).join(',')})=>${wasmTypeKey(sig.result)}`;
		let info = closureTypes.get(key);
		if (!info) {
			const envBase		= ensureEnvBase();
			const funcTypeIndex	= registerFuncType([{ type: {ref: envBase, nullable: false}, id: 'env' }, ...toParams(sig.params)], toResults(sig.result));
			info = { funcTypeIndex, structTypeIndex: addType({final: true, supertypes: [ensureClosureBase()], type: { kind: 'struct', fields: [
				{ type: { ref: funcTypeIndex, nullable: false }, mut: false },
				{ type: { ref: envBase, nullable: false }, mut: false },
			] } } ) };
			closureTypes.set(key, info);
		}
		return info;
	}

	// Returns both the resolved `Type` and its `WasmType` -- callers that go on to declare this param as
	// a real local (`declareParams`) need the former too, and shouldn't have to re-derive it a second
	// time (which would also need a `checker` instance FuncCtx, a top-level class, doesn't have access to).
	// A default value is only resolved at each omitted call site (`emitCallArgs` re-emits `p.default`
	// itself, verbatim, once per real omitted-argument call it compiles), not evaluated once and
	// shared the way a closure capture would be -- which is fine (matches real JS's own "fresh each
	// call" semantics) as long as the expression never references anything outside its own literal
	// value, or an *earlier* parameter (`earlierNames`, e.g. real code like `updateBuffer(b: Uint8Array,
	// off = 0, len = b.length)`) -- any other identifier/call would resolve against the *call site's*
	// scope, not the declaring function's, so is still rejected. A literal has no such reference by
	// construction; an array literal is exactly as safe whenever every element recursively is too; a
	// (possibly chained) plain, non-optional property read off an earlier parameter is safe the same way
	// a literal is -- no call, no side effect, nothing but a value already known by the time it's needed.
	// `emitCallArgs` is the one that actually makes an earlier-parameter reference resolve correctly (see
	// its own comment) -- this only decides whether the *shape* of the expression is safe to attempt.
	// A CLOSURE default (`sort(compareFn = (a, b) => ...)`) is re-emitted at every call site that omits the
	// argument, so the question is not what kind of expression it is but what it CAPTURES: it may mention
	// only its own parameters and the earlier parameters those call sites already pass. Anything else is an
	// enclosing local that would be re-emitted out of scope. `(a, b) => a < b ? -1 : ...` -- the lib's own
	// `Array.sort` default, and the reason `sort` was unusable at all -- captures nothing.
	function closureDefaultIsSelfContained(e: Expr, earlierNames?: ReadonlySet<string>): boolean {
		if (e.type !== 'arrow' && e.type !== 'function')
			return false;
		const bound = new Set<string>(earlierNames);
		for (const p of e.params)
			if (typeof p.key === 'string')
				bound.add(p.key);
		let ok = true;
		walk(e.body as Walkable, undefined, (x, process) => {
			if (x.type === 'identifier' && !bound.has(x.name))
				ok = false;
			return process(x);
		});
		return ok;
	}

	function isReemittableDefault(e: Expr, earlierNames?: ReadonlySet<string>): boolean {
		return e.type === 'literal'
			|| closureDefaultIsSelfContained(e, earlierNames)
			|| (e.type === 'array' && e.elements.every(el => el !== undefined && el.type !== 'spread' && isReemittableDefault(el, earlierNames)))
			// Same reasoning as the array case, and `{}` -- an all-defaults options bag -- is the common one.
			|| (e.type === 'object' && e.properties.every(pr => pr.type === 'field' && typeof pr.key === 'string' && !!pr.value && isReemittableDefault(pr.value, earlierNames)))
			|| (e.type === 'identifier' && !!earlierNames?.has(e.name))
			|| (e.type === 'member' && !e.optional && isReemittableDefault(e.object, earlierNames))
			// An OPERATOR over things already re-emittable (`b = a * 2`, `n = -1`, `x = a ? 1 : 2`).
			// Adds no new name to resolve at the call site -- every leaf is still a literal, an earlier
			// parameter, or a property chain off one -- so it carries none of the cross-module hazard a
			// default that *called* something would.
			|| (e.type === 'binary' && e.operator !== '=' && isReemittableDefault(e.left, earlierNames) && isReemittableDefault(e.right, earlierNames))
			|| (e.type === 'unary' && isReemittableDefault(e.operand, earlierNames))
			|| (e.type === 'conditional' && isReemittableDefault(e.test, earlierNames) && isReemittableDefault(e.consequent, earlierNames) && isReemittableDefault(e.alternate, earlierNames));
	}

	// A bare `p?: T` (optional, no `= value`) is real, valid TS distinct from `p: T = value` (a real
	// default expression) -- `emitCallArgs`'s own omitted-argument handling only ever consulted a real
	// default expression, so an optional-but-defaultless trailing param could never actually be omitted
	// at a call site (found via `lib/map.ts`'s own `entries()` calling `.map()` with `thisArg` omitted,
	// `lib/array.ts`'s own real method -- `thisArg?: any` has no explicit default, same as every other
	// optional trailing param `arrayMethod`'s hand-built checker signatures declare). Synthesizes a real
	// `undefined` identifier expression as the default whenever one is otherwise missing -- `emitAs`'s
	// own `isNullLiteral` handling already treats a bare `undefined` as a real, valid value wherever a
	// nullable (or plain `any`) target is expected, so this needs no further codegen support at all.
	function defaultsWithImplicitUndefined(params: readonly { default?: Expr; modifiers?: string[] }[]): (Expr | undefined)[] {
		return params.map(p => p.default ?? (hasMod(p, 'optional') ? { type: 'identifier', name: 'undefined' } : undefined));
	}

	// `earlierNames`/`scope`: only ever passed by `resolveParams` below, threading in the sibling
	// parameters already resolved to its own left -- needed both to validate an earlier-parameter-
	// referencing default (`isReemittableDefault`) and, when the default itself has no explicit type
	// annotation, to infer its type against a scope that actually has those earlier parameters declared
	// (plain `libGlobal` can't see them at all -- they're this function's own locals, not global names).
	function resolveParam(p: JS.Param<Type>, earlierNames?: ReadonlySet<string>, scope: Scope = libGlobal): ResolvedParam {
		let tsType = p.typeAnnotation;
		if (p.default) {
			if (!isReemittableDefault(p.default, earlierNames))
				throw `'param '${describeBinding(p.key)}''s default value must be a literal (an array literal of them), or a read of an earlier parameter (e.g. 'b.length')`;
			tsType ??= checkerTypeOf(p.default, scope);
		}
		if (!tsType)
			throw `'param '${describeBinding(p.key)}' needs an explicit type`;
		const rawWtype = typeOf(tsType);
		if (!rawWtype)
			throw `'param '${describeBinding(p.key)}' needs an explicit type`;
		// See `closureFuncSigType`'s own comment -- box a real but wasm-unrepresentable `void` as `any`
		// rather than reject otherwise-valid source.
		const boxed = rawWtype === 'void' ? REF_ANY : rawWtype;
		// A bare `p?: T` (optional, no `=`) widens to `T | undefined` for real TS -- same nullable-slot
		// treatment `closureFuncSigType`'s own identical comment already gives a function TYPE's own
		// optional param, needed here too so an ordinary top-level function (not just a closure value)
		// can actually be called with an explicit `undefined`/an omitted trailing argument
		// (`defaultsWithImplicitUndefined`'s synthesized default) for such a param.
		// `tsType` widens with the slot: it is what goes into `ctx.scope` for this parameter, and leaving
		// it as the bare annotation made `wtypeOf` derive a plain scalar for a slot that is physically a
		// nullable box -- so `b === undefined` on `b?: number` was rejected as "needs a nullable
		// object-typed value" even though the box it is held in answers exactly that.
		return !p.default && hasMod(p, 'optional')
			? { key: p.key, wtype: nullableWtype(boxed), tsType: T.combineTypes([tsType, T.UNDEFINED]) }
			: { key: p.key, wtype: boxed, tsType };
	}

	// Resolves a whole param list left to right, growing the earlier-names/scope `resolveParam` needs to
	// validate and type a default that reads an earlier parameter -- each param sees every param resolved
	// before it (real JS default-evaluation order), never one declared after it.
	function resolveParams(params: readonly JS.Param<Type>[]): ResolvedParam[] {
		const earlierNames = new Set<string>();
		const scope = new Scope(libGlobal);
		return params.map(p => {
			const r = resolveParam(p, earlierNames, scope);
			if (typeof p.key === 'string') {
				earlierNames.add(p.key);
				scope.addValue(p.key, r.tsType);
			}
			return r;
		});
	}

	// Resolves the type-argument substitution map for a generic call (top-level function or method) --
	// shared by `ensureGenericFunc` and `ensureMethod`'s own generic-method case. Explicit call-site type
	// args win outright; otherwise each param's declared type is matched against its argument's real type
	// via the exact inference the checker itself uses (`T.inferTypeArgs`), matching checker.ts's own
	// `instantiate`, not a reimplementation. Falls back to each remaining type param's own `default`/
	// `constraint`/`any` in turn when nothing inferred it, same as the checker's own final fallback.
	// Contextual/expected-return-type inference (`instantiate`'s own `expected` param, checker.ts): `want`
	// -- towasm's codegen equivalent, `ctx.contextualReturn` (see its own comment) -- reaches here as
	// `expected`/`returnType` when the call site had a real one on hand (currently only `case 'array'`'s
	// own per-element loop and `case 'var_decl'` seed it). Matched with the *same* priority checker.ts's
	// own `instantiate` uses: an ordinary direct param (`x: T`) still resolves first and wins outright
	// (`T.inferTypeArgs`'s own `out`-already-has-it guard) -- only a generic callback argument's own
	// *return*-position inference is deferred until after this contextual step gets a chance, since an
	// unannotated callback's own inferred return is otherwise whatever anonymous, non-nominal structural
	// shape its body happened to produce (found via `Rule([...], $ => ({type:'spread', ...}))`-shaped
	// calls, `Rule<T>`'s `T` only ever knowable from the surrounding array literal's own declared element
	// type). `libGlobal` doubles as both `scope` (resolving each argument's own type) and `declScope`
	// (resolving the declared param types a type param is matched against) -- every declaration this is
	// ever called for (a top-level function, or a class method -- its class's own type params already
	// concrete by the time `ensureMethod` reaches here) is declared relative to the one module scope this
	// file ever has, same as `paramType`/`compileFunc` already assume elsewhere -- no separate "declaring
	// module" to track the way `T.declScopeOf` exists for (a cross-module signature, which nothing here
	// ever is).
	function inferTypeArgMap(typeParams: readonly TS.TypeParam[], params: JS.Param<Type>[], args: Expr[], typeArgs: Type[] | undefined, scope: Scope, expected?: Type, returnType?: Type): Map<string, Type> {
		const map = new Map<string, Type>();
		if (typeArgs) {
			typeParams.forEach((p, i) => map.set(p.name, typeArgs[i] ?? p.default ?? T.ANY));
		} else {
			const names = new Map(typeParams.map(p => [p.name, p] as const));
			const deferred: { paramT: Type; argT: Type }[] = [];
			args.forEach((a, i) => {
				const p = params[i];
				if (p?.typeAnnotation && a.type !== 'spread')
					T.inferTypeArgs(p.typeAnnotation, checkerTypeOf(a, scope), names, map, libGlobal, libGlobal, deferred);
			});
			if (expected && returnType)
				T.inferTypeArgs(returnType, expected, names, map, libGlobal);
			for (const { paramT, argT } of deferred)
				T.inferTypeArgs(paramT, argT, names, map, libGlobal);
			typeParams.forEach(p => {
				if (!map.has(p.name))
					map.set(p.name, p.default ?? p.constraint ?? T.ANY);
			});
		}
		return map;
	}

	function ensureFunc(name: string, decl: FunctionDecl, homeModule = '.'): FuncInfo {
		return funcs.get(homeKey(homeModule, name)) ?? compileFunc(name, decl, homeModule)!;
	}

	// Resolves a generic top-level function call to its monomorphized `FuncInfo`, cached under the same
	// composite-key shape `ensureClass` already uses for `Box<number>` (`identity<number>`) -- one real
	// difference from a class reference: a function's type arguments are usually left implicit at the call
	// site, inferred from the arguments (`inferTypeArgMap`, above). Explicit call-site type args
	// (`identity<number>(5)`) are honored too, same as a class's are.
	function ensureGenericFunc(name: string, decl: FunctionDecl, args: Expr[], typeArgs: Type[] | undefined, scope: Scope, expected?: Type, homeModule = '.'): FuncInfo {
		const typeParams	= decl.typeParams!;
		const map			= inferTypeArgMap(typeParams, decl.params, args, typeArgs, scope, expected, decl.returnType as Type | undefined);
		// Bare (unmangled) composite key -- `compileFunc` applies `homeKey` itself when it caches, so this
		// must match without a second wrapping here.
		const key			= genericKey(name, typeParams, map, global);
		const existing		= funcs.get(homeKey(homeModule, key));
		if (existing)
			return existing;
		// `ensureClassExtension`'s own ordering requirement: if this function's body ever calls
		// `Object.defineProperty` at all, every one of *this specific instantiation's* own concrete
		// type arguments might be the target (which one, precisely, isn't resolved until the body
		// itself compiles -- `case 'var_decl'`'s own comment) -- so all of them get marked
		// conservatively, right now, before `compileFunc` below ever reaches an `ensureClass` call for
		// any of them and finalizes its struct type one way or the other.
		if (decl.body && containsDefineProperty(decl.body)) {
			for (const t of map.values())
				if (t.type === 'ref' && !t.typeArgs)
					everExtended.add(t.name);
		}
		return compileFunc(key, { ...substituteTypeParams(decl, map), typeParams: undefined }, homeModule, name)!;
	}

	// `realName`: the function's own real, DECLARED name -- for a generic instantiation, `name` itself is
	// a mangled per-instantiation cache key (`ensureGenericFunc`'s own `genericKey(...)`), never a name
	// `global.value()` could ever find anything under. Defaults to `name` for the ordinary, non-generic
	// case, where they're identical.
	function compileFunc(name: string, decl: FunctionDecl, homeModule = '.', realName: string = name): FuncInfo | undefined {
		try {
			if (hasMod(decl, 'async'))
				return compileAsyncFunc(name, decl, homeModule);

			if (hasMod(decl, 'generator'))
				return compileGeneratorFunc(name, decl, homeModule);

			if (decl.typeParams?.length)
				throw `generic function '${name}' is not supported`;

			// No annotation defaults to `void` (matching real TS's inference) -- but an annotation that's
			// present and doesn't resolve is still a real error, not silently `void` too.
			// A cross-module function's own `decl` (straight from `functionDeclByName`, the real AST node)
			// never gets its inferred return type back-filled at all -- that only ever happens on a
			// throwaway synthetic clone `hoist()` builds for the declaring module's own scope entry
			// (`exportScope`'s lazy, self-memoizing `returnType` accessor -- see its own comment), never
			// copied back onto `decl` itself. `global.value(name)`, when this name is imported directly
			// into the entry module (the reachable case: type-checking the call site that made this
			// function's own compilation necessary in the first place already had to trigger+cache that
			// lazy accessor with the correct, properly `declScope`-stamped result), recovers the exact same
			// already-correctly-inferred signature -- far safer than re-deriving inference here with no way
			// to see the declaring module's own local names. Falls through to the old `'void'` default
			// whenever this doesn't apply (not a function-typed value, or the name isn't directly reachable
			// this way at all -- e.g. a function only ever called indirectly through another non-entry
			// module), unchanged from before.
			// The declaring module's own internal scope (`exportScope` stamps it on the body it hoisted).
			// Without it a non-entry function's body rooted at `libGlobal`, so every module-local name --
			// a sibling function's RETURN TYPE included -- resolved to `any`, and every lowering that reads
			// the checker's type rather than the physical one (indexing, `.length`, a field read) silently
			// lost. `global.value` only ever found a name imported DIRECTLY into the entry, so a function
			// reached through a namespace import (`path.join`) never resolved at all.
			const moduleScope = moduleScopeOf(homeModule);
			const checkedType = moduleScope?.value(realName) ?? global.value(realName);
			const inferredReturnType = !decl.returnType && checkedType?.type === 'function' ? checkedType.returnType : undefined;
			const result = decl.returnType ? typeOf(decl.returnType)
				: inferredReturnType ? typeOf(inferredReturnType)
				: 'void';
			if (!result)
				throw `'${name}' has an unsupported return type`;

			// This function's own declaring module's scope (`stampSig` stamps `declScope` onto a hoisted
			// signature once, using the exact scope `hoist()` itself was given for that module) -- rooting
			// the compiled body's own scope here, instead of always `libGlobal`, is what lets a bare
			// identifier referenced inside the body (a sibling class in the same file, another top-level
			// const, ...) resolve against ITS OWN module's declarations rather than only the entry's. Same
			// reachability limitation as the return-type fallback just above (only when `name` is directly
			// reachable via `global`) -- `homeScope` is simply `undefined` otherwise, falling back to
			// `libGlobal` exactly as before.
			const homeScope = (checkedType?.type === 'function' ? checkedType.declScope as Scope | undefined : undefined) ?? moduleScope;

			const params	= resolveParams(decl.params);
			if (decl.rest?.typeAnnotation)
				params.push({key: decl.rest.key, wtype: typeOf(decl.rest.typeAnnotation)!, tsType: decl.rest.typeAnnotation});

			const {funcIndex, typeIndex} = registerFunc(toParams2(params), toResults(result));
			const info: FuncInfo = {params: params.map(r => r.wtype), result, funcIndex, typeIndex, defaults: defaultsWithImplicitUndefined(decl.params), resolvedParams: params, hasRest: !!decl.rest?.typeAnnotation};
			funcs.set(homeKey(homeModule, name), info);
			worklist.push(withCatch(() => {
				const ctx	= new FunctionContext(name, new Scope(homeScope ?? libGlobal), plainReturn(result), undefined, homeModule);
				ctx.widenedTypes = collectRangeWidenings(decl.body!, ctx.scope);
				ctx.definePropertyTargets = collectDefinePropertyTargets(decl.body!);
				ctx.ownBody = decl.body!;
				ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
				decl.body!.forEach(st => emitStmt(st, ctx));
				emitTrailingUnreachable(ctx, result);
				info.body		= ctx.toFuncBody(params.length, toValType);
			}));
			return info;

		} catch (e) {
			//console.log(e);
			throw new TSWError(e as any, undefined, name, homeModule);
		}
	}

	// Shared by compileGeneratorFunc/compileAsyncFunc -- both restrict a resumable function's own
	// params identically (plain identifier, no default, not optional, no rest); `kind` only changes
	// the error wording.
	function resolveResumableParams(decl: FunctionDecl): ResolvedParam[] {
		if (decl.rest)
			throw `rest parameter is not yet supported`;
		return decl.params.map(p => {
			if (typeof p.key !== 'string')
				throw `destructured is not supported`;
			if (p.default)
				throw `parameter '${p.key}' cannot have a default value`;
			if (hasMod(p, 'optional'))
				throw `parameter '${p.key}' cannot be optional`;
			return resolveParam(p);
		});
	}

	// Shared by compileGeneratorFunc/compileAsyncFunc -- the frame's own field map (one per param, then
	// one per hoisted local -- state and any extra hidden field, e.g. async's own result Promise, are
	// each caller's own concern, appended before/after this). `resumeValueType`, when given, overrides
	// a suspend-boundary declarator's own init-derived type -- needed only for a generator's `const v =
	// yield x;` (see `compileGeneratorFunc`'s own comment on why `checkerTypeOf` can't be trusted
	// there); an async `await` needs no such override, so `compileAsyncFunc` never passes one.
	function buildFrameFields(decl: FunctionDecl, params: ResolvedParam[], widenedTypes: Map<JS.Var<Type>, Type>, resumeValueType?: Type) {
		const hoisted		= collectHoistedLocals(decl.body!);
		const localFields	= new Map<string, LocalField>();
		const frameFields: wasm.FieldType[] = [{ type: 'i32', mut: true }];
		for (const p of params) {
			localFields.set(p.key as string, { index: frameFields.length, wtype: p.wtype, tsType: p.tsType });
			frameFields.push({ type: toValType(p.wtype), mut: true });
		}
		for (const [localName, { stmt, decl: d }] of hoisted) {
			if (localFields.has(localName))
				continue;	// already a param field -- real JS forbids a body-level redeclaration of a param name anyway
			if (!d.init && !d.typeAnnotation)
				throw `local '${localName}' needs an initializer or an explicit type`;
			const tsType = d.typeAnnotation ?? widenedTypes.get(d) ?? (resumeValueType && d.init?.type === 'yield' ? resumeValueType : d.init && T.literalTypeOf(d.init)) ?? checkerTypeOf(d.init!, (stmt as any).scope as Scope ?? libGlobal);
			const wt = typeOf(tsType);
			if (!wt || wt === 'void')
				throw `local '${localName}' has an unsupported type`;
			localFields.set(localName, { index: frameFields.length, wtype: wt, tsType });
			frameFields.push({ type: toValType(wt), mut: true });
		}
		return { localFields, frameFields };
	}

	// A `function*` compiles to two real wasm functions: the exported name itself (`name`, zero
	// wasm-level behavior change from a caller's perspective -- `gen()` never runs the body, it just
	// captures a fresh frame and hands it to `new Generator(step)`, same as a real JS generator call
	// never runs any code until the first `.next()`), and a separate resumable "step" function with
	// exactly the shape an ordinary arrow/function-expression closure already has -- `{code, env}`,
	// except the env doubles as a *frame* (the resume `state`, and -- once params/captures/locals are
	// supported, checkpoint 3 -- everything live across a yield). `Generator<Y,R,N>`/`IteratorResult
	// <Y,R>` (`lib/generator.ts`) are ordinary generic lib classes -- `.next()` calling the closure-
	// typed `step` field is `emitMethodCall`'s new closure-through-a-field path, not anything generator-
	// specific.
	function compileGeneratorFunc(name: string, decl: FunctionDecl, homeModule = '.'): FuncInfo {
		if (decl.typeParams?.length)
			throw `generic generator function '${name}' is not supported`;
		const params = resolveResumableParams(decl);

		// Read off `libGlobal`'s own hoisted function type, not `decl.returnType` directly: `checkStmt`'s
		// own per-statement check (`case 'function_decl'`) re-derives and overwrites `decl.returnType`
		// in place with `N` forced to `T.ANY` regardless of what's declared (`checkFunctionBody`'s
		// `skipReturn` is unconditionally true for a generator) -- but that mutation happens *after*
		// `hoist()` already snapshotted the real declared type into the scope value every call site
		// (`countUp()`) actually resolves through, so the two disagree. Going through the same scope
		// lookup a call site uses keeps this in sync with what callers see, sidestepping the mismatch
		// rather than fighting it.
		const rt = (global.value(name) as TS.FunctionType | undefined)?.returnType;
		if (rt?.type !== 'ref' || rt.name !== 'Generator' || (rt.typeArgs?.length ?? 0) !== 3)
			throw `unexpected inferred return type`;
		const [Y, R, N] = rt.typeArgs!;
		const yWtype = typeOf(Y), nWtype = typeOf(N);
		if (!yWtype || yWtype === 'void')
			throw `unsupported yielded type`;
		if (!typeOf(R))
			throw `unsupported return type`;
		if (!nWtype || nWtype === 'void')
			throw `unsupported '.next()' argument type`;

		const resultClass	= ensureClass('IteratorResult', [Y, R]);
		const genClass		= ensureClass('Generator', [Y, R, N]);
		if (!resultClass || !genClass)
			throw `internal: the generator lib classes were not found`;
		const resultWtype	= ownerThisType(resultClass);

		const sig: FuncSig = { params: [nWtype], result: resultWtype, hasRest: false };
		const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);

		// The frame holds the resume state plus every local the body declares (conservative: hoists
		// every one of them, not just the ones actually live across a yield -- see
		// `collectHoistedLocals`'s own comment). `supertypes: [envBase]`, matching an ordinary closure
		// literal's own env struct -- the step function's real wasm param is declared `(ref $envBase)`
		// (`ensureClosureType`), so whatever concrete frame struct gets stored into the closure at the
		// creation site below must be a real subtype of it.
		const envBase		= ensureEnvBase();
		const STATE_FIELD	= 0;
		// Same fallback chain `case 'var_decl'` itself uses to pick a hoisted local's *actual* write type
		// (typeAnnotation, then a widened-reassignment-range override, then the initializer's own narrow
		// literal type, e.g. a small integer literal defaults to 'i32' not 'f64') -- the frame field's
		// declared type must agree with what the real write emits, or the field type mismatches its own
		// initializer (confirmed the hard way: computing this independently via `checkerTypeOf` alone
		// picked the checker's un-narrowed 'number' -> f64 while the actual `let i = 0` write picked the
		// narrower i32, corrupting the very first assignment). Consistency matters here, not which of the
		// two representations wins -- `emitAs`/`coerceTop` widen i32 -> f64 at every *use* site regardless
		// (`yield i` against a 'number'-typed generator, `i < 3`, ...), so 'i32' is a completely valid,
		// even cheaper choice for the field as long as the declaration and every write agree on it.
		// `resumeValueType: N` -- 'const v = yield x;''s own checker type is always `T.ANY` (the same
		// forced-any inference behind the `N`-in-`decl.returnType` workaround above, `checkFunctionBody`'s
		// `skipReturn`), not the real declared/resolved `N` -- `buildFrameFields` reads `N` directly for
		// that one case instead of trusting `checkerTypeOf`, or the field ends up `anyref`-typed against
		// an `N`-typed write.
		const widenedTypes	= collectRangeWidenings(decl.body!, libGlobal);
		const { localFields, frameFields } = buildFrameFields(decl, params, widenedTypes, N);
		const frameTypeIndex = addType({ final: true, supertypes: [envBase], type: { kind: 'struct', fields: frameFields } });
		const machine		= BuildStateMachine(decl.body!);

		const { funcIndex: stepFuncIndex } = registerFuncAtType(funcTypeIndex);
		const stepInfo: FuncInfo = { params: sig.params, result: sig.result, hasRest: false, funcIndex: stepFuncIndex, typeIndex: funcTypeIndex };
		closureLiterals.push(stepInfo);

		worklist.push(withCatch(() => {
			const fnCtx			= new FunctionContext(name, new Scope(libGlobal), plainReturn(resultWtype), undefined, homeModule);
			// Param order must match `ensureClosureType`'s real wasm signature exactly (env, then `sig.params`)
			// -- the cast-down frame local is declared *after* both real params, as one more genuine local, same as an ordinary closure literal's own `#env` (`emitClosureLiteral`).
			const envParam		= fnCtx.declareLocal('#envParam', { typeIndex: envBase, nullable: false });
			const sentParam		= fnCtx.declareLocal('#sent', nWtype);
			const frameLocal	= fnCtx.declareLocal('#frame', { typeIndex: frameTypeIndex, nullable: false });
			fnCtx.emit(I.local.get(envParam.index), I.ref.cast(frameTypeIndex), I.local.set(frameLocal.index));
			// Every hoisted local reads/writes through the frame automatically from here on --
			// `case 'identifier'`/`emitAssignTarget` already check `closureEnv.fields` first, same as a
			// real closure capture; `case 'var_decl'` gained the one new branch that *writes* one instead
			// of declaring a real wasm local, when its own name is already a frame field.
			fnCtx.closureEnv = { envLocal: frameLocal, envTypeIndex: frameTypeIndex, fields: localFields };
			for (const [localName, { tsType }] of localFields)
				fnCtx.declareCaptured(localName, tsType);
			// The same map already consulted above, building the frame's own field types -- reused (not
			// recomputed) so `case 'var_decl'`'s actual write agrees with what the field was declared as.
			fnCtx.widenedTypes	= widenedTypes;

			const setFrame = (state: number) => fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(state), I.struct.set(frameTypeIndex, STATE_FIELD));

			const resultCtor = ensureCtor(resultClass, [], fnCtx);
			// `resultCtor.params[0]` -- not the bare `rWtype` -- is `IteratorResult<Y,R>.value`'s own real,
			// already-resolved wasm representation: identical to `rWtype` whenever `R` is an ordinary type,
			// but when `R` is `void` (a real, common case -- `Generator<Y, void, N>`), `ensureClass` already
			// boxed that instantiation's `value: Y | R` field to `any` (`void` is never valid as a field's
			// own type -- see `addField`'s guard), and this must push a value matching what the field/
			// constructor was actually built to accept, not the un-substituted bare type.
			const valueWtype = resultCtor.params[0];
			// A plain `return expr;` inside a generator body means "done", not an ordinary wasm return of
			// `expr` (the step function's real wasm result is always an `IteratorResult`, never the bare
			// yield/return type).
			fnCtx.onReturn = {
				wtype: () => valueWtype,
				emit(ctx, argument) {
					setFrame(machine.completeId);
					if (argument)
						emitAs(argument, ctx, valueWtype);
					else
						emitDefaultValue(valueWtype, ctx);
					ctx.emit(I.i32.const(1), I.call(resultCtor.funcIndex), I.return);
				},
			};

			// 'const v = yield x;' -- `v`'s own resume-side binding lives on the *suspending* segment's own
			// `next` (the only place the flattener has it), not the segment it resumes into, so build the
			// reverse lookup once: which segment (by id) needs to write the sent value into which frame field,
			// right before running its own statements.
			const sentBindings = new Map<number, number>();
			for (const seg of machine.segments) {
				if (seg.next.type === 'suspend' && seg.next.resultVar)
					sentBindings.set(seg.next.resumeId, fnCtx.closureEnv!.fields.get(seg.next.resultVar)!.index);
			}

			const oldOuter = fnCtx.swapOut();
			fnCtx.emit(I.local.get(frameLocal.index), I.struct.get(frameTypeIndex, STATE_FIELD));
			fnCtx.emitResumableDispatch(machine,
				setFrame,
				test => emitTruthy(test, fnCtx),
				id => {
					const sentField = sentBindings.get(id);
					if (sentField !== undefined)
						fnCtx.emit(I.local.get(frameLocal.index), I.local.get(sentParam.index), I.struct.set(frameTypeIndex, sentField));
					machine.segments[id].stmts.forEach(st => emitStmt(st, fnCtx));
				},
				(next, resumeId) => {
					if (next.kind !== 'yield')
						throw "'await' is not supported in generators yet";
					if (next.delegate)
						throw "'yield*' delegation is not supported";
					// `valueWtype` (`IteratorResult<Y,R>.value`'s own real, already-resolved type -- see its
					// own comment above), not the bare `yWtype`: identical whenever `Y` and `R` happen to be
					// the same type (every existing test, until now), but a real, different representation
					// once they're not (this constructor's own single `value` param always expects exactly
					// one physical shape, whichever path -- yield or return -- is calling it).
					if (next.operand)
						emitAs(next.operand, fnCtx, valueWtype);
					else
						emitDefaultValue(valueWtype, fnCtx);
					setFrame(resumeId);
					fnCtx.emit(I.i32.const(0), I.call(resultCtor.funcIndex), I.return);
				},
				() => {
					// Natural completion, or a repeat call once already pinned here -- either way,
					// idempotent: re-pin `state` to this same segment's own id, done forever after.
					emitDefaultValue(valueWtype, fnCtx);
					fnCtx.emit(I.i32.const(1), I.call(resultCtor.funcIndex), I.return);
				}
			);
			fnCtx.emit(I.loop(undefined, fnCtx.swapOut(oldOuter)));
			emitTrailingUnreachable(fnCtx, resultWtype);
			stepInfo.body		= fnCtx.toFuncBody(2, toValType);
		}, name, homeModule));

		const outerResult = ownerThisType(genClass);
		const { funcIndex: outerFuncIndex, typeIndex: outerTypeIndex } = registerFunc(toParams2(params), toResults(outerResult));
		const info: FuncInfo = { params: params.map(p => p.wtype), result: outerResult, funcIndex: outerFuncIndex, typeIndex: outerTypeIndex, hasRest: false };
		funcs.set(name, info);

		worklist.push(withCatch(() => {
			const ctx			= new FunctionContext(name, new Scope(libGlobal), plainReturn(outerResult), undefined);
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
			const genCtor		= ensureCtor(genClass, [], ctx);
			const paramNames	= new Set(params.map(p => p.key as string));
			ctx.emit(I.ref.func(stepFuncIndex), I.i32.const(machine.entryId));
			for (const [localName, field] of localFields) {
				if (paramNames.has(localName))
					ctx.emit(I.local.get(ctx.lookup(localName)!.index));
				else
					emitDefaultValue(field.wtype, ctx);
			}
			ctx.emit(I.struct.new(frameTypeIndex), I.struct.new(structTypeIndex), I.call(genCtor.funcIndex), I.return);
			info.body = ctx.toFuncBody(params.length, toValType);
		}, name, homeModule));
		return info;

	}

	// An `async function` reuses the exact same resumable-function machinery a generator does (frame,
	// `flattenStateMachine`, the loop+block dispatch) -- but is driven very differently. A generator
	// waits for an external `.next()` call to ever run any code; an async function's body starts
	// running *immediately*, synchronously, up to its first real suspend or its own completion, and
	// nothing external ever "asks" it to resume -- a suspended `await` instead registers itself as a
	// continuation via `Promise.then()`, so whichever other compiled code eventually calls `.resolve()`
	// on the awaited promise is what re-enters the step function next. Because of that, the step
	// function itself needs no `IteratorResult`-shaped result at all (nothing ever reads one) -- `void`
	// -- and doesn't need the generic `{code,env}` closure-literal shape either (nothing ever calls it
	// through a stored closure value; both callers -- the outer wrapper's one-shot kickoff and every
	// `await`-site trampoline below -- always call its own real `funcIndex` directly), so the frame is
	// simply its first real param, no `envBase`/`ref.cast` indirection needed the way a generator's own
	// step function requires (matching `ensureClosureType`'s generic env-first convention).
	function compileAsyncFunc(name: string, decl: FunctionDecl, homeModule = '.'): FuncInfo {
		if (decl.typeParams?.length)
			throw `generic function '${name}' is not supported`;
		const params = resolveResumableParams(decl);

		// Unlike a generator's own `decl.returnType` (see `compileGeneratorFunc`'s own comment),
		// `checkFunctionBody`'s `skipReturn` is only ever forced for a *generator*, so a plain async
		// function's declared/inferred `Promise<R>` is trustworthy read directly, no scope-lookup
		// workaround needed.
		const rt = decl.returnType;
		if (rt?.type !== 'ref' || rt.name !== 'Promise' || (rt.typeArgs?.length ?? 0) !== 1)
			throw `function '${name}' has an unexpected inferred return type`;

		const promiseClass			= ensureClass('Promise', rt.typeArgs);
		if (!promiseClass)
			throw `the 'Promise' lib class was not found`;
		const promiseWtype			= ownerThisType(promiseClass);

		const envBase				= ensureEnvBase();
		const STATE_FIELD			= 0;
		const widenedTypes			= collectRangeWidenings(decl.body!, libGlobal);
		const { localFields, frameFields } = buildFrameFields(decl, params, widenedTypes);

		// One more hidden field -- this function's own result Promise, resolved directly by every return and by natural completion (emitAsyncDispatch's own 'complete' handling).
		const resultPromiseField	= frameFields.push({ type: toValType(promiseWtype), mut: true }) - 1;
		const frameTypeIndex		= addType({ final: true, supertypes: [envBase], type: { kind: 'struct', fields: frameFields } });
		const machine				= BuildStateMachine(decl.body!);

		// Registered like any other function (not through `ensureClosureType`, see this function's own
		// header comment) -- `funcs`/`closureLiterals` are the only two collections the module assembly
		// pass (`place`) ever reads bodies from, and this one has no name to register under `funcs`, so
		// `closureLiterals` is reused purely as "a body needing placement," not because it's ever
		// actually taken as a first-class closure value (harmless either way -- the `elem declare`
		// segment it also feeds only *permits* `ref.func`, it doesn't require ever using it).
		const { funcIndex: stepFuncIndex, typeIndex: stepFuncTypeIndex } = registerFunc(
			[{ type: { ref: frameTypeIndex, nullable: false }, id: 'frame' }, { type: toValType(REF_ANY), id: 'sent' }],
			[],
		);
		const stepInfo: FuncInfo = { params: [{ typeIndex: frameTypeIndex, nullable: false }, REF_ANY], result: 'void', hasRest: false, funcIndex: stepFuncIndex, typeIndex: stepFuncTypeIndex };
		closureLiterals.push(stepInfo);

		worklist.push(withCatch(() => {
			const fnCtx			= new FunctionContext(name, new Scope(libGlobal), plainReturn(), undefined, homeModule);
			const frameLocal	= fnCtx.declareLocal('#frame', { typeIndex: frameTypeIndex, nullable: false });
			const sentParam		= fnCtx.declareLocal('#sent', REF_ANY);
			fnCtx.closureEnv	= { envLocal: frameLocal, envTypeIndex: frameTypeIndex, fields: localFields };
			for (const [localName, { tsType }] of localFields)
				fnCtx.declareCaptured(localName, tsType);
			fnCtx.widenedTypes	= widenedTypes;
			const resolveMethod	= ensureMethod(promiseClass, 'resolve', [], fnCtx)!;

			const setFrame = (state: number) => fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(state), I.struct.set(frameTypeIndex, STATE_FIELD));

			// `resolveMethod.params[0]` -- not the bare `rWtype` -- is `Promise<T>.resolve`'s own real,
			// already-resolved wasm parameter type: identical to `rWtype` whenever `T` is an ordinary
			// type, but when `T` is `void` (a real, common case -- `Promise<void>`), `ensureClass` already
			// boxed that instantiation's `value: T` field (and `resolve`'s own param) to `any` (`void` is
			// never valid as a field/param's own type -- see `addField`'s guard), and this must push a
			// value matching what `resolve` was actually built to accept, not the un-substituted bare type.
			const valueWtype = resolveMethod.params[0];
			// A plain `return expr;` means "resolve the function's own result Promise with `expr`, then
			// a bare wasm `return`", not an ordinary return of `expr` (the step function's own real wasm
			// result type is always `void` -- nothing ever reads it directly).
			fnCtx.onReturn = {
				wtype: () => valueWtype,
				emit(ctx, argument) {
					ctx.emit(I.local.get(frameLocal.index), I.struct.get(frameTypeIndex, resultPromiseField));
					if (argument)
						emitAs(argument, ctx, valueWtype);
					else
						emitDefaultValue(valueWtype, ctx);
					ctx.emit(I.call(resolveMethod.funcIndex), I.return);
				},
			};
			// `emitResumableDispatch`'s 'suspend'/'complete' arms, specialized for async: a suspend either
			// unwraps immediately (a non-Promise operand -- the synchronous fast path) or registers a
			// trampoline via `Promise.then()` and returns; completion resolves the function's own result
			// Promise directly instead of constructing anything.

			// One trampoline per distinct awaited element type, shared across every await site in this same
			// function that awaits that type -- a trampoline only ever needs to unbox its own received value
			// and forward it (plus the frame, as its own closure env -- a real subtype of `$envBase`, exactly
			// like any other closure literal's own env) into `stepFuncIndex` directly; it has no need to know
			// *which* resume state that call will land on (the frame's own state field, set before `.then()`
			// was ever called, already says so).
			const trampolines = new Map<string, { funcIndex: number; structTypeIndex: number }>();
			const ensureTrampoline = (tWtype: WasmType) => {
				const key = wasmTypeKey(tWtype);
				let info = trampolines.get(key);
				if (!info) {
					const { funcTypeIndex, structTypeIndex } = ensureClosureType({ params: [tWtype], result: 'void' });
					const { funcIndex } = registerFuncAtType(funcTypeIndex);
					const tInfo: FuncInfo = { params: [tWtype], result: 'void', hasRest: false, funcIndex, typeIndex: funcTypeIndex };
					closureLiterals.push(tInfo);
					worklist.push(() => {
						const tCtx			= new FunctionContext(fnCtx.name, new Scope(libGlobal), plainReturn(), undefined);
						const envParam		= tCtx.declareLocal('#envParam', { typeIndex: envBase, nullable: false });
						const valueParam	= tCtx.declareLocal('#value', tWtype);
						tCtx.emit(I.local.get(envParam.index), I.ref.cast(frameTypeIndex), I.local.get(valueParam.index));
						coerceTop(tWtype, tCtx, REF_ANY);
						tCtx.emit(I.call(stepFuncIndex), I.return);
						tInfo.body			= tCtx.toFuncBody(2, toValType);
					});
					info = { funcIndex, structTypeIndex };
					trampolines.set(key, info);
				}
				return info;
			};

			let awaitTemp = 0;

			// Same reverse-lookup idea as `emitGeneratorDispatch`'s own `sentBindings` -- a suspending
			// segment's own `resultVar` lives on *its* `next`, not the segment it resumes into. Only a
			// *real* Promise suspension resumes via `#sent` (a trampoline's own delivered value) -- the
			// synchronous fast path (`onSuspend`, below) already writes `resultVar` directly, inline, before
			// ever transitioning; re-writing it here from `#sent` too would clobber that with whatever
			// `#sent` happened to hold from a *previous, unrelated* resume (confirmed the hard way -- a
			// non-Promise `await x; output = v;` silently read back the wrong value).
			const sentBindings = new Map<number, { index: number; wtype: WasmType }>();
			for (const seg of machine.segments) {
				if (seg.next.type === 'suspend' && seg.next.resultVar && T.asPromiseRef(checkerTypeOf(seg.next.operand!, fnCtx.scope), fnCtx.scope))
					sentBindings.set(seg.next.resumeId, fnCtx.closureEnv!.fields.get(seg.next.resultVar)!);
			}

			const oldOuter = fnCtx.swapOut();
			fnCtx.emit(I.local.get(frameLocal.index), I.struct.get(frameTypeIndex, STATE_FIELD));
			fnCtx.emitResumableDispatch(machine,
				setFrame,
				test => emitTruthy(test, fnCtx),
				id => {
					const sentField = sentBindings.get(id);
					if (sentField) {
						fnCtx.emit(I.local.get(frameLocal.index), I.local.get(sentParam.index));
						coerceTop(REF_ANY, fnCtx, sentField.wtype);
						fnCtx.emit(I.struct.set(frameTypeIndex, sentField.index));
					}
					machine.segments[id].stmts.forEach(st => emitStmt(st, fnCtx));
				},
				(next, resumeId, loopMark) => {
					if (next.kind !== 'await')
						throw "'yield' is not supported inside an async function";
					if (next.delegate)
						throw "'yield*' is not supported inside an async function";
					const operand	= next.operand!;
					const promiseRef = T.asPromiseRef(checkerTypeOf(operand, fnCtx.scope), fnCtx.scope);
					if (!promiseRef) {
						// The synchronous fast path: `operand` isn't Promise-shaped, so there's nothing to suspend on -- real JS unwraps a non-thenable `await` immediately.
						// Still a real state transition (simpler and no less correct than trying to fall through directly; the wasm-level cost is one extra dispatch-loop iteration).
						if (next.resultVar) {
							const field = fnCtx.closureEnv!.fields.get(next.resultVar)!;
							fnCtx.emit(I.local.get(frameLocal.index));
							emitAs(operand, fnCtx, field.wtype);
							fnCtx.emit(I.struct.set(frameTypeIndex, field.index));
						} else if (emitExpr(operand, fnCtx, 'void') !== 'void') {
							fnCtx.emit(I.drop);
						}
						setFrame(resumeId);
						fnCtx.emit(I.br(fnCtx.depth - loopMark));

					} else {
						const tType		= promiseRef.typeArgs![0];
						const tWtype	= typeOf(tType);
						if (!tWtype)
							throw "'await' on a Promise of an unsupported element type";
						// `addField`/`resolveParam` already box a bare `void` reaching a field/param position as
						// `any` (see their own comments), so `ensureClass` needs no help here -- but the
						// trampoline closure below is built from an already-resolved `WasmType`, bypassing that
						// same-path fallback entirely, and needs its own matching substitution.
						const substitutedTWtype	= tWtype === 'void' ? REF_ANY : tWtype;
						const awaitedClass		= ensureClass('Promise', [tType]);
						if (!awaitedClass)
							throw `the 'Promise' lib class was not found`;

						emitAs(operand, fnCtx, ownerThisType(awaitedClass));
						const promiseLocal = fnCtx.declareLocal(`$await$${awaitTemp++}`, ownerThisType(awaitedClass));
						fnCtx.emit(I.local.set(promiseLocal.index));

						// `state` must already say where to resume *before* calling `.then()` -- a promise
						// that's already settled invokes the trampoline synchronously, reentrantly calling
						// `stepFuncIndex` before this `.then()` call itself returns (safe: this arm's own code
						// ends in `return` immediately after, so the reentrant call's own work is never redone).
						setFrame(resumeId);

						const { funcIndex: trampolineFuncIndex, structTypeIndex: trampolineStructTypeIndex } = ensureTrampoline(substitutedTWtype);
						const thenMethod = ensureMethod(awaitedClass, 'then', [], fnCtx)!;
						fnCtx.emit(
							I.local.get(promiseLocal.index),
							I.ref.func(trampolineFuncIndex), I.local.get(frameLocal.index), I.struct.new(trampolineStructTypeIndex),
							I.call(thenMethod.funcIndex), I.return
						);
					}
				},
				() => {
					fnCtx.emit(I.local.get(frameLocal.index), I.struct.get(frameTypeIndex, resultPromiseField));
					emitDefaultValue(valueWtype, fnCtx);
					fnCtx.emit(I.call(resolveMethod.funcIndex), I.return);
				}
			);
			fnCtx.emit(I.loop(undefined, fnCtx.swapOut(oldOuter)));
			stepInfo.body = fnCtx.toFuncBody(2, toValType);
		}, name, homeModule));

		const { funcIndex: outerFuncIndex, typeIndex: outerTypeIndex } = registerFunc(toParams2(params), toResults(promiseWtype));
		const info: FuncInfo = { params: params.map(p => p.wtype), result: promiseWtype, funcIndex: outerFuncIndex, typeIndex: outerTypeIndex, hasRest: false };
		funcs.set(name, info);
		worklist.push(withCatch(() => {
			const ctx = new FunctionContext(name, new Scope(libGlobal), plainReturn(promiseWtype), undefined);
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));

			const promiseCtor = ensureCtor(promiseClass, [], ctx);
			const resultPromiseLocal = ctx.declareLocal('#resultPromise', promiseWtype);
			// `promiseCtor.params[0]` -- not the bare `rWtype` -- matches its own real, already-resolved
			// `initial: T` parameter (see the step function's own `valueWtype` comment for why these can
			// diverge when `T` is `void`); its value never actually matters (`resolve()` always overwrites
			// it for real before anything reads it), just that it's a real type the constructor can accept.
			emitDefaultValue(promiseCtor.params[0], ctx);
			ctx.emit(I.call(promiseCtor.funcIndex), I.local.set(resultPromiseLocal.index));

			// Built via a real `struct.new` (every field's actual value), not `struct.new_default` +
			// later `struct.set`s -- same reasoning as `compileGeneratorFunc`'s own construction: a
			// non-nullable object-typed field (e.g. a `Promise<T>`-typed param) isn't *defaultable*.
			// `resultPromiseField` is always the last field (appended after every param/hoisted-local
			// field above), so its value is pushed last too, matching declaration order.
			const paramNames = new Set(params.map(p => p.key as string));
			ctx.emit(I.i32.const(machine.entryId));
			for (const [localName, field] of localFields) {
				if (paramNames.has(localName))
					ctx.emit(I.local.get(ctx.lookup(localName)!.index));
				else
					emitDefaultValue(field.wtype, ctx);
			}
			ctx.emit(I.local.get(resultPromiseLocal.index), I.struct.new(frameTypeIndex));

			// Kick the body off immediately, synchronously, up to its first real suspend or completion --
			// matching real JS: calling an async function runs its body right away, only ever returning
			// control *to its own caller* at an `await`, not before. The sent value is never read at the
			// entry segment (only a resume segment with a binding reads `#sent`), so any *non-null* value
			// is fine -- `#sent`'s own declared type is non-nullable `any` (matching every other boxed-any
			// value in this file), so a real (if unused) box, not `ref.null`, keeps that true unconditionally.
			ctx.emit(
				I.f64.const(0), I.struct.new(ensureBoxType('f64')),
				I.call(stepFuncIndex),
				I.local.get(resultPromiseLocal.index), I.return
			);
			info.body = ctx.toFuncBody(params.length, toValType);
		}, name));
		return info;
	}

	// Picks the declaration (from possibly several real bodies sharing a name, a genuine overload set) whose
	// declared params fit `args`' actual types, mirroring the checker's own `T.argsFit`-based resolution -- resolves to the exact same overload the checker already validated the call against.
	function resolveOverload(label: string, decls: MethodMember[], args: Expr[], ctx: FunctionContext): MethodMember {
		if (decls.length === 1)
			return decls[0];
		if (args.some(a => a.type === 'spread'))
			throw `spread arguments are not supported in a call to overloaded '${label}'`;
		const argTs = args.map(a => checkerTypeOf(a, ctx.scope));
		const found = decls.find(d => d.body && T.argsFit(T.FixSig(d, T.ANY), argTs, ctx.scope));
		if (!found)
			throw `no overload of '${label}' matches this call`;
		return found;
	}

	// Resolves a bare type-alias name (`declare type X = SomeGenericClass<...>`, e.g. lib.d.ts's own
	// `Uint8Array = TypedArray<u8>`) to its real generic target -- lets a name with no class/function/var
	// declaration of its own (only a type alias) still be instantiated the ordinary generic way (see
	// `ensureClass` below), instead of needing a real physical declaration -- or a name-substituted copy --
	// per alias. General: works for any such alias, not just typed-array ones.
	function resolveClassAlias(name: string): { name: string; typeArgs: Type[] } | undefined {
		const target = libGlobal.type(name)?.type;
		return target?.type === 'ref' && target.typeArgs?.length && LIB_DECL_MAP.get(target.name)?.type === 'class_decl'
			? { name: target.name, typeArgs: target.typeArgs }
			: undefined;
	}

	function addField(info: ClassInfo, key: string, typeAnnotation?: Type, optional = false) {
		// See `closureFuncSigType`'s own comment -- box a real but wasm-unrepresentable `void` as `any` rather than reject otherwise-valid source.
		const rawWt = typeAnnotation && typeOf(typeAnnotation);
		let wt	= rawWt === 'void' ? REF_ANY : rawWt;
		if (!wt) {
			if (process.env.DBG)
				console.error(`addField FAIL info=${info.name} key=${key} ann=${typeAnnotation ? typeAnnotation.type + ' ' + T.typeKey(typeAnnotation).replace(/\s+/g,' ').slice(0,120) : 'undefined'} resolved=${typeAnnotation ? T.typeKey(T.resolve(global, typeAnnotation)).replace(/\s+/g,' ').slice(0,120) : '-'}`);
			throw `'${key}' needs an explicit number/boolean/object type`;
		}
		// An `optional` field's own declared type is just its bare annotation (`value?: Expr`) -- this
		// checker tracks "optional" as a separate modifier, never folding it into an implicit `| undefined`
		// union the way real TS does (same gap already documented for an optional *param*'s own narrowing) --
		// so `wt` alone never reflects that the field can physically be absent. Force it nullable here
		// regardless: a field that can be omitted must always have a real "no value" to construct with
		// (`emitDefaultValue`, when an object literal omits it), independent of what its own annotation says.
		// Scalar kinds (`f64`/`i32`/...) and a boxed-`any` ref already have their own zero-default in
		// `emitDefaultValue` with no `.nullable` needed -- only a real, non-`any` object/array/closure kind
		// needs the wrap.
		if (optional && typeof wt === 'object' && !wt.nullable && !('ref' in wt && wt.ref === 'any'))
			wt = nullableWtype(wt);
		// A scalar-typed one needs the same null-boxing an optional *parameter* already gets: without it
		// there's no "absent" distinct from `0`/`false`, so `??=` and `=== undefined` can't work at all
		// (and an unassigned `n?: number` silently read back as `0`). Only `f64`/`i32` have a box.
		if (optional && (wt === 'f64' || wt === 'i32'))
			wt = nullableWtype(wt);
		if (info.fieldIndex.has(key))
			throw `field '${key}' redeclares an inherited field -- not supported`;
		info.fieldIndex.set(key, info.fields.length);
		info.fields.push({ name: key, wtype: wt, optional});
	}

	// Resolves a plain, non-generic type alias (`type Point = { x: number; y: number };`) whose target
	// resolves to a structural object type of only 'property' members, giving it a real physical wasm-GC
	// struct type -- narrow object-literal support: a literal's target type must be exactly one of these
	// (from a var_decl/param/field/return annotation, or any other context that threads a concrete `want`
	// through `emitAs`), never real structural inference/subtyping the way general TS object types get.
	// Cached into the same `classes` map real classes use -- a name can't be both a `class_decl` and a
	// type alias, so no key collision risk -- which is what lets ordinary field access (`classOf`/`case
	// 'member'`) work completely unchanged afterward, same as any other class.
	// Shared struct-building core for both a named object-shape (`ensureObjectShape`) and an anonymous
	// inline one (`ensureAnonObjectShape`) -- registers `info` into `classes` (with a real `typeIndex`
	// already allocated) *before* resolving any member's own type, same self-/mutually-referential-safety
	// reasoning as `ensureClass`'s own placeholder-first ordering: a union type reachable again through one
	// of its own members' fields (confirmed real: `Type`'s own recursive AST-node union in ts-parser.ts)
	// finds `info` already in `classes` and returns immediately, well before this loop runs twice.
	function buildObjectShape(key: string, members: TS.TypeMember[], thisTsType: Type, declName: string, everFinal: boolean): ClassInfo {
		const info: ClassInfo = {
			name:		key, thisTsType,
			decl:		{ name: declName, body: [] },
			fields:		[],
			fieldIndex:	new Map(),
			methodDecls: new Map(),
			thisWtype: { ref: key },
			typeIndex:	addType({kind: 'struct', fields: []}),
		};
		classes.set(key, info);

		for (const m of members) {
			switch (m.type) {
				case 'property': {
					if (typeof m.key !== 'string')
						throw `object-shape type '${declName}' has a computed property name -- not supported`;
					addField(info, m.key, m.typeAnnotation, hasMod(m, 'optional'));
					break;
				}
				case 'method': {
					if (typeof m.key !== 'string')
						throw `object-shape type '${declName}' has a computed property name -- not supported`;
					addField(info, m.key, {...(m as TS.CallSig), type: 'function'}, hasMod(m, 'optional'));
					break;
				}
				default:
					throw `object-shape type '${declName}' can only have plain properties (no methods/index/call signatures) to be an object literal's target type`;
			}
		}

		types[info.typeIndex] = {
			final: everFinal,
			supertypes: [], type: {
				kind: 'struct',
				fields: info.fields.map(f => ({ type: toValType(f.wtype), mut: true })),
			}
		};
		return info;
	}

	// `declScope`: a cross-module reference (`t.declScope` on the original `RefType`, see checker.ts's/
	// type-utils.ts's own `withScope`/`declScopeOf`) resolves `name` where it was actually *declared*, not
	// wherever it's referenced from -- `global` (the entry module's own checked scope) never sees a type
	// that was only ever reached transitively (e.g. inferred off an imported function's own return type)
	// without itself being explicitly imported by name. Defaults to `global`, matching every existing
	// same-module caller unaffected by this.
	function ensureObjectShape(name: string, typeArgs?: Type[], declScope?: Scope): ClassInfo | undefined {
		const scope = declScope ?? global;
		// Same composite-key convention as `ensureClass` itself -- two different type arguments are two
		// different physical shapes (e.g. `TypeParam<Type>` vs. a bare, implicitly-`any` `TypeParam`).
		const key		= typeArgs?.length ? `${name}<${typeArgs.map(t => T.typeKey(T.resolve(scope, t))).join(',')}>` : name;
		const existing	= classes.get(key);
		if (existing)
			return existing;

		if (!scope.type(name))
			return undefined;

		// Via a `RefType` (not the entry's own raw, still-generic `.type` directly) so a reference to a
		// generic interface/alias -- bare (`TypeParam`) or explicit (`TypeParam<X>`) -- goes through
		// `resolve`'s own type-arg substitution (each param -> its given arg, its own default, or `any`)
		// instead of leaving the type param itself unresolved in every member's type. Stamped with `scope`
		// itself (a plain `TS.RefType` carries no scope of its own) -- this exact ref becomes `thisTsType`
		// below, and `fieldDeclaredType`'s own later re-resolution of it needs to find `name` again from
		// wherever it was actually declared, not wherever `global` (the entry module) happens to be.
		const ref = TS.RefType(name, typeArgs);
		ref.declScope = scope;
		// `resolveObjectType` (not a hand-rolled intersection-flatten here) -- an interface `extends`ing
		// another (`Method<T> extends CallSig<T>`) needs its own parts (`CallSig<T>` itself still an
		// unresolved ref at this point) actually RESOLVED, not just unwrapped-if-already-an-object; a
		// bespoke, weaker version of this same flatten used to live here, silently dropping any part that
		// hadn't already been expanded to a plain object -- a real, previously-latent bug (`Method<Type>`
		// built with only its own 4 directly-declared fields, missing every one of `CallSig`'s, never
		// caught before self-hosting first built and then actually tried to construct a real `Method` value).
		const resolved = resolveObjectType(ref, scope);
		if (!resolved)
			return undefined;
		// An index-signature-shaped object (`Partial<T>`, `Record<string,V>`, ...) isn't a fixed-field
		// struct at all -- `ownerFor`'s own caller already has a real, more appropriate fallback for this
		// exact shape (`indexSignatureValueType`, routing to the `Map`-backed dynamic-object path) once
		// `ensureClass` declines here, same as it always safely declined before `typeArgs` was threaded in.

		if (resolved.members.some(m => m.type !== 'property' && m.type !== 'method'))
			return undefined;

		// Shared with the structurally-identical ANONYMOUS shape, under `ensureAnonObjectShape`'s own
		// `T.typeKey` identity. `type A = { n: number }` written as `A` in one place and inlined in
		// another is ONE type in TS, but keying a named shape by its name alone built a second struct for
		// it -- and then a value built as one failed `ref.cast` to the other ("illegal cast", at runtime,
		// from something as ordinary as spreading an array of them). Only alias/interface SHAPES collapse
		// this way; a real `class` keeps its nominal identity via `ensureClass`'s own name-based key.
		const structural	= T.typeKey(resolved);
		const shared		= classes.get(structural);
		if (shared) {
			classes.set(key, shared);
			return shared;
		}
		const info = buildObjectShape(key, resolved.members, ref, name, !everExtended.has(name));
		if (info)
			classes.set(structural, info);
		return info;
	}

	// An anonymous inline object-type annotation (`{value: T; consumed: number}` as a return/field/param
	// type, never named via `interface`/`type X = ...`) has no name to key `ensureObjectShape` by -- real TS
	// treats these structurally, but this compiler's struct system is nominal, so it needs *some* identity.
	// Uses the already-resolved type's own rendered source text (`T.typeKey`) as that identity: two
	// syntactically-identical anonymous shapes (including after generic substitution, e.g. two different
	// instantiations that happen to produce the same concrete member types) collapse to one physical struct,
	// which is correct -- there's no name to keep them apart by even if desired.
	// Shapes currently being vetted below -- a member whose own type leads back here would otherwise
	// recurse forever, and a cyclic anonymous shape is exactly one this can't build anyway.
	const anonShapeVetting = new Set<string>();

	function ensureAnonObjectShape(obj: TS.ObjectType): ClassInfo | undefined {
		if (obj.members.some(m => m.type !== 'property' && m.type !== 'method'))
			return undefined;
		const key		= T.typeKey(obj);
		const existing	= classes.get(key);
		if (existing)
			return existing;
		if (anonShapeVetting.has(key))
			return undefined;
		// Every property must have a representation before this commits to building a struct. This is a
		// last-resort fallback, so a shape it can't represent is simply not one it should claim -- and
		// failing here rather than inside `addField` matters because the caller still has `wasmTypeOf` to
		// fall back to. The case that forced it: a namespace object (`import * as T from ...`) is a
		// perfectly good object TYPE whose members include classes and type aliases, and is never a value.
		anonShapeVetting.add(key);
		try {
			if (obj.members.some(m => m.type === 'property' && !(m.typeAnnotation && typeOf(m.typeAnnotation))))
				return undefined;
		} finally {
			anonShapeVetting.delete(key);
		}
		return buildObjectShape(key, obj.members, obj, key, true);
	}

	// Resolves fields and the struct type eagerly, but only collects method/ctor decls -- building each is
	// deferred to `ensureMethod`/`ensureCtor`, the same lazy treatment `ensureFunc` gives top-level functions.
	function ensureClass(name: string, typeArgs?: Type[], declScope?: Scope): ClassInfo | undefined {
		// A real generic instantiation (`Box<number>`) is cached under a composite key, not the bare class
		// name -- two different type arguments are two different physical classes. Keying off the *unresolved* class name (not `T.resolve`'s expanded form) keeps two classes with identical field shapes from colliding.
		// A wasm pseudo-type argument (`TypedArray<u8>`/`<i32>`/etc, see `TYPED_ARRAY_TAGS`) is kept
		// unresolved too, by its own name -- `T.resolve` collapses every one of them alike down to plain
		// `number` (they're all just `= number` aliases), which would otherwise key `TypedArray<u8>` and
		// `TypedArray<i32>` identically and wrongly collide the two into one shared (and wrongly $elem-tagged
		// by whichever instantiated first) physical class.
		if (name === 'Array') {
			if (typeArgs?.[0].type !== 'ref' || (!TYPED_ARRAY_TAGS.has(typeArgs[0].name) && typeArgs[0].name !== 'number' && typeArgs[0].name !== 'boolean' && typeArgs[0].name !== 'any'))
				typeArgs = [T.ANY];
		}
		const key = typeArgs?.length
			? `${name}<${typeArgs.map(t => t.type === 'ref' && !t.typeArgs && TYPED_ARRAY_TAGS.has(t.name) ? t.name : T.typeKey(T.resolve(global, t))).join(',')}>`
			: name;
		// A non-generic top-level class is seeded into `classes` *eagerly*, well before any `ensureClass`
		// call ever reaches it (see `TStoWasm`'s own top-level seeding pass) -- `typeIndex` staying `-1` is
		// what distinguishes "reserved but not yet processed" from "fully built" here, unlike
		// `ensureObjectShape` (nothing pre-seeds an object-shape, so its own top-of-function check can be
		// unconditional on mere presence in `classes`). A generic class is never pre-seeded this way (only
		// its own template lives in `userGenericClassDecls`; each concrete instantiation is cached here
		// lazily, by `ensureClass` itself, on first reference).
		let info = classes.get(key);
		if (info && info.typeIndex !== -1)
			return info;

		if (!info) {
			// A plain lib-internal class -- an ordinary struct seeded into `classes` lazily on first reference.
			// `declScope?.decl(name)`: a non-entry module's own class, never eagerly seeded the way an entry-
			// module class is (`TStoWasm`'s own top-level seeding loop stays entry-only) -- resolves via the
			// exact same scope-chain mechanism `ensureObjectShape`'s own `declScope` param already uses, now
			// landing on the *real* class declaration (fields/constructor/methods) instead of that fallback's
			// structural-shape-only reconstruction, which has no representation for a real class's own
			// methods at all.
			let decl = LIB_DECL_MAP.get(name) ?? userGenericClassDecls.get(name) ?? declScope?.decl(name);
			if (decl?.type !== 'class_decl') {
				// `resolveClassAlias` only covers a *lib* alias to a real class name, never generic --
				// a generic interface/type-alias reference (with or without explicit type args, e.g.
				// `TypeParam` bare or `TypeParam<T>`) goes straight to `ensureObjectShape` instead.
				if (!typeArgs?.length) {
					const alias = resolveClassAlias(name);
					if (alias)
						return ensureClass(alias.name, alias.typeArgs, declScope);
				}
				// Checked before the structural fallback below, which would otherwise reconstruct a
				// shape-only stand-in (no constructor, no methods) for what is really a known class -- and
				// cache it under this very name, so whichever of the annotation and the `new` resolves first
				// wins for both. `?? global`: a bare ref annotation often carries no `declScope` of its own,
				// and the alias itself is a top-level declaration either way.
				const aliased = classAliasTarget(name, declScope ?? global);
				if (aliased && (aliased.name !== name || aliased.scope !== (declScope ?? global)))
					return ensureClass(aliased.name, typeArgs, aliased.scope);
				return ensureObjectShape(name, typeArgs, declScope);
			}
			// Read off the ORIGINAL declaration -- a generic instantiation replaces `decl` with a
			// name-substituted copy just below, which `stmtHomeModule` has never seen.
			const homeModule = stmtHomeModule.get(decl);
			if (decl.typeParams?.length) {
				const got = typeArgs?.length ?? 0;
				if (!typeArgs || typeArgs.length !== decl.typeParams.length) {
					for (let i = got; i < decl.typeParams.length; i++)
						if (!decl.typeParams[i].default)
							throw `class '${name}' needs ${decl.typeParams.length} explicit type argument(s)`;
				}
				decl = substituteClassTypeParam(decl, new Map(decl.typeParams.map((p, i) => [p.name, i < got ? typeArgs![i] : p.default!])));
			}
			// `thisTsType` is always a real reference to this class -- the ref itself must carry the real
			// name and type arguments (`{name, typeArgs}`), not the mangled composite cache key as a bare
			// name, or `this.length`/`this[i]` can't resolve (`T.lookupMember` silently falls back to `any`).
			info = { name: key, typeIndex: -1, thisTsType: TS.RefType(name, typeArgs), decl, fields: [], fieldIndex: new Map(), methodDecls: new Map(), declScope, homeModule };
			classes.set(key, info);
		}

		const decl = info.decl;

		// A constructor with its own explicit 'return' overrides `this` entirely (a scalar or array
		// result, never a struct) -- such a class must never get a struct type index allocated, not even
		// as an unused placeholder (a self-referential field would end up pointing at a struct nothing
		// ever actually constructs). Pre-scanned here, before any field type gets resolved (no recursion
		// risk -- `checkerTypeOf` is the checker's own inference, not this file's `typeOf`/`ensureClass`),
		// specifically so this decision is already made before the field loop below runs -- which needs to
		// know up front whether to allocate a struct placeholder for self-reference safety at all.
		let returnType: Type | undefined;
		for (const m of decl.body as TS.ClassMember[]) {
			if (m.type === 'method' && m.key === 'constructor' && m.body) {
				const last = m.body[m.body.length - 1];
				if (last?.type === 'return' && last.argument)
					returnType = checkerTypeOf(unwrapAs(last.argument), m.scope as Scope);
				break;
			}
		}

		// Resolved *before* this class's own `typeIndex` is ever allocated -- wasm-GC requires a `sub`
		// type's own declared supertype to already be a *lower* type-section index than itself (unlike an
		// ordinary field reference, which may freely forward-reference any other type in the same rec
		// group; a supertype relationship is a validation-time, not a runtime-pointer, relationship, so it
		// can't be circular/forward the same way). Resolving the superclass first guarantees
		// `superInfo.typeIndex < info.typeIndex` regardless of how deep the chain goes, matching what
		// always held before self-referential struct support existed (this ordering never risked infinite
		// recursion before, since nothing needed a not-yet-allocated `typeIndex` of its own back then).
		// Real regression, not hypothetical: confirmed a 3-level `super(...)` chain (`class A`, `class B
		// extends A`, `class C extends B`) fails to load ("forward-declared supertype") the moment the
		// superclass block ran *after* this class's own placeholder allocation, since resolving `C`'s own
		// superclass `ensureClass('B')` would recursively resolve `B`'s own superclass `ensureClass('A')`
		// too, giving A the *highest* index of the three -- backwards. Also still seeds `info.fields`/
		// `fieldIndex` from the superclass before this class's own members are walked below, so
		// `addField`'s redeclaration guard sees every inherited field already there, and `info.fields`
		// end up in the order wasm-GC struct subtyping requires: the supertype's own fields first, as an
		// exact prefix, this class's own appended after.
		//
		// Doesn't reopen the self-reference case this ordering used to guard against: a class field of its
		// *own* type is resolved later, in the per-member loop below (after this class's own placeholder
		// *is* allocated) -- this block only ever resolves an *ancestor* class, a structurally separate
		// concern from "does one of my own fields reference me."
		if (decl.superClass && !returnType) {
			const superName = decl.superClass.type === 'identifier' ? decl.superClass.name
				: decl.superClass.type === 'instantiation' && decl.superClass.expression.type === 'identifier' ? decl.superClass.expression.name
				: undefined;
			if (!superName)
				throw `only a plain named superclass ('class ${name} extends Base' or 'extends Base<T>') is supported`;
			const superInfo = ensureClass(superName, decl.superClass.type === 'instantiation' ? decl.superClass.typeArgs : undefined);
			if (!superInfo)
				throw `unknown superclass '${superName}' for class '${name}'`;
			if (typeof superInfo.thisWtype !== 'string' && superInfo.thisWtype && 'arr' in superInfo.thisWtype || superInfo.typeIndex === -1)
				throw `'${name}' can't extend '${superName}' -- extending an array/scalar-backed class (a constructor with its own explicit 'return') is not supported`;
			info.superClass = superInfo;
			info.fields.push(...superInfo.fields);
			superInfo.fieldIndex.forEach((idx, fname) => info.fieldIndex.set(fname, idx));
		}

		if (returnType) {
			if (decl.superClass)
				throw `'${name}' can't both extend '${(decl.superClass as any).name}' and have a constructor with its own explicit 'return' -- not supported`;
			const result = typeOf(returnType);
			if (!result || (typeof result !== 'string' && !('arr' in result)))
				throw `'${name}'s constructor returns a value of an unsupported shape for 'this' -- only a scalar or array-shaped result is supported`;
			info.thisWtype = result;
			info.typeIndex = typeof result === 'string' ? -1 : ensureArrayType(result.arr);
		} else {
			// How an instance is physically represented (struct vs. array) is the separate, towasm-only
			// `thisWtype`. Allocated with a real `typeIndex`/`thisWtype` now, before any of *this* class's
			// own field types resolve -- see `ensureObjectShape`'s own identical comment for why this
			// ordering is what makes a self-/mutually-referential class field safe (a reentrant
			// `ensureClass` call for this same `key`, triggered while resolving one of this class's own
			// field types, finds `typeIndex` already real and short-circuits above instead of recursing
			// into this same pass a second time). The superclass (if any) is already fully resolved by now
			// (above), so this index is always the largest in the chain so far, never a forward reference.
			info.thisWtype = { ref: key };
			info.typeIndex = addType({ kind: 'struct', fields: [] });
		}

		const addMethod = (key: string, m: MethodMember) => {
			const list = info.methodDecls.get(key);
			if (list)
				list.push(m);
			else
				info.methodDecls.set(key, [m]);
		};

		const inlineDecls: { key: string; value: JS.Call<Type>; typeParams?: string[] }[] = [];

		if (decl.abstract)
			throw `abstract class '${name}' is not supported`;

		// `decl.body`'s own declared element type (`JS.ClassMember<Type>`, `Class<T>`'s default `M`) has no
		// `index_signature` variant -- that's only ever added by `TS.ClassMember` (ts-parser.ts's own richer
		// type). `decl` here is always parsed by ts-parser.ts though, so a real index-signature member can
		// genuinely appear -- widened to the type that actually matches what's parsed, not narrowed by which
		// shared interface happened to declare `body`.
		// A field's own type resolves in the class's OWN module, not the entry's: an un-annotated field
		// (`opts;`, `newline = '\n'`) gets its type from the constructor or its initializer, both of which
		// may name things only that file declares -- and `T.lookupMember(thisTsType, ...)` needs the class's
		// own name to be resolvable at all, which it isn't in an importer that only ever wrote `C.Output`.
		const homeScope = info.declScope ?? libGlobal;
		for (const m of decl.body as TS.ClassMember[]) {
			try {
				if (m.type === 'field'/* && !hasMod(m, 'static')*/) {
					if (typeof m.key !== 'string')
						throw `computed field names in '${name}' are not supported`;
					if (isAsm(m.value))
						inlineDecls.push({ key: m.key, value: m.value! });
					else if (!m.modifiers?.includes('static'))
						// Neither an annotation nor an initializer (`opts;`) -- the type lives only in the
						// constructor's own `this.opts = ...`, which `classShapes` already infers. Ask the
						// checker for the member rather than re-deriving it from the AST here.
						addField(info, m.key, m.typeAnnotation ?? (m.value ? checkerTypeOf(m.value, homeScope) : T.lookupMember(info.thisTsType, m.key, homeScope)), !m.value && hasMod(m, 'optional'));

				} else if (m.type === 'method') {
					// A computed name can't be stored as a decl key -- and can never be called via `.name()` syntax either, so it's simply never reachable, no need to throw.
					if (typeof m.key === 'string') {
						const value = isAsmMethod(m);
						if (value) {
							inlineDecls.push({ key: m.key, value, typeParams: m.typeParams?.map(tp => tp.name) });
						} else {
							addMethod(m.key, m);
						}
					}

					if (m.key === 'constructor') {
						for (const p of m.params) {
							if (hasMod(p, 'public') || hasMod(p, 'private') || hasMod(p, 'protected')) {
								if (typeof p.key !== 'string')
									throw `computed field names in '${name}' are not supported`;
								addField(info, p.key, p.typeAnnotation ?? (p.default ? checkerTypeOf(p.default, libGlobal) : undefined), !p.default && hasMod(p, 'optional'));
							}
						}
					}

				} else if (m.type === 'get' || m.type === 'set') {
					if (typeof m.key === 'string') {
						const key = accessorKey(m.type, m.key);
						const value = isAsmMethod(m);
						if (value) {
							inlineDecls.push({ key, value});
						} else {
							addMethod(key, m);
						}
						(m.type === 'get' ? (info.getterNames ??= new Set()) : (info.setterNames ??= new Set())).add(m.key);
					}

				} else if (m.type !== 'index_signature') {
					// Type-checking-only -- real indexing goes through the generic `get`/`set`/array-kind paths (`case 'index'`), never a declared index signature itself, so there's nothing for this pass to do with it.
					throw `unsupported class member kind '${m.type}' in '${name}'`;
				}
			} catch (e) {
				//console.log(e);
				throw new TSWError(e as any, m);
			}
		}

		// An IMPLICIT constructor, exactly as real TS synthesizes one for a class that declares none:
		// empty for a base class, and for a derived one, the base's own parameter list forwarded through
		// `super(...)`. (TS spells that `constructor(...args) { super(...args) }`; the base's real list is
		// the same thing here and avoids a spread `super(...)` this back end does not support.) Without
		// it, `class A { x = 5 }` and `class B extends A {}` -- both entirely ordinary TS -- failed with
		// "needs an explicit constructor" the moment they were instantiated.
		if (!info.methodDecls.has('constructor')) {
			const superCtor = info.superClass?.methodDecls.get('constructor');
			const params	= superCtor?.length === 1 ? superCtor[0].params : [];
			addMethod('constructor', {
				type:	'method',
				key:	'constructor',
				params,
				body:	info.superClass
					? [JS.ExprStmt({ type: 'call', callee: { type: 'super' }, arguments: params.map(p => ({ type: 'identifier', name: p.key as string })) } as Expr)]
					: [],
			} as unknown as MethodMember);
		}

		// `thisWtype`/`typeIndex` were already decided by the pre-scan above -- an explicit-return
		// constructor's scalar/array result needs nothing more here; the ordinary struct case just needs
		// its real field list patched into the placeholder type registered earlier.
		if (!returnType) {
			types[info.typeIndex] = {
				final:		!everExtended.has(name),
				supertypes: info.superClass ? [info.superClass.typeIndex] : [],
				type: {
					kind: 'struct',
					fields: info.fields.map(f => ({ type: toValType(f.wtype), mut: true }))
				}
			};
		}

		const defines: Record<string, string|number> = {this: info.typeIndex};
		if (typeof info.thisWtype === 'object' && 'arr' in info.thisWtype)
			defines.elem = info.thisWtype.arr;

		if (decl.typeParams && typeArgs) {
			decl.typeParams.forEach((p, i) => {
				const t = typeArgs[i];
				if (t.type === 'ref' && TYPED_ARRAY_TAGS.has(t.name)) {
					defines[p.name] = t.name;
				} else {
					const w = typeOf(typeArgs[i]);
					if (typeof w === 'string')
						defines[p.name] = w;
				}
			});
		}

		const inlineMethods = new Map<string, Builtin<Inline>>();
		for (const i of inlineDecls) {
			try {
				inlineMethods.set(i.key, makeAsm(i.value, defines, i.typeParams, w => typeof w === 'object' && 'arr' in w ? ensureArrayType(w.arr) : undefined));
			} catch (err) {
				throw new TSWError(err as any, i.value);
			}
		}

		if (inlineMethods.size)
			info.inlineMethods = inlineMethods;

		return info;
	}

	// Real, general support for `Object.defineProperty(target, key, {value, ...})` when `key` isn't
	// already a declared field on `target`'s own class -- the user's own explicit design call (see the
	// self-hosting plan's own session addendum): a wasm-GC struct can't gain a field at runtime, so
	// this is modeled as real inheritance, not a name-specific hack or a universal field bolted onto
	// every class regardless of use. `base` -- never the extended form itself, `ensureClassExtension`
	// is keyed by (and only ever called with) the *plain* base class -- gets one synthesized subclass,
	// carrying either a real field per statically-enumerable key ever `defineProperty`'d onto any
	// value of this class anywhere in the program (unioned across every such site, boxed `any` since
	// the attached value's own type is whatever that specific call site's own `value` expression is),
	// or one `Map<string, any>` "and others" catch-all field once any of those keys isn't a compile-
	// time literal (`pendingExtensions`'s own comment). `everExtended.add(base.name)` needs to happen
	// before `base`'s own struct type is finalized -- `ensureGenericFunc`'s own hook (run before any of
	// a generic function's own type arguments could reach `ensureClass` at all) is the fast, common-case
	// path, but isn't sufficient alone: `base` may already have been referenced -- and so finalized --
	// through some *other*, earlier, unrelated reference (found the hard way: `const p: Point = {...}`
	// textually before the generic call that turns out to need `Point`'s own extension). Patched
	// retroactively below as a safety net for exactly that case -- safe because `types` is still a
	// plain, mutable in-memory array at this point, not yet serialized into anything.
	function ensureClassExtension(base: ClassInfo): ClassInfo {
		const existing = classExtensions.get(base.name);
		if (existing)
			return existing;
		everExtended.add(base.name);
		const baseType = types[base.typeIndex];
		if (typeof baseType === 'object' && 'final' in baseType && baseType.final)
			baseType.final = false;
		const spec = pendingExtensions.get(base.name);
		// `optional: true` on every synthesized field -- real source syntax can never construct one of
		// these (`#ext` can't be spelled at all; a statically-enumerable key like `pos` is real, but no
		// object-literal construction site ever supplies it directly either), so `case 'object'`'s own
		// per-field loop must fall back to a default for all of them, not throw "missing property".
		const extraFields: { name: string; wtype: WasmType; optional: true }[] = spec && spec !== 'dynamic'
			? spec.map(key => ({ name: key, wtype: REF_ANY, optional: true as const }))
			// The catch-all field is nullable specifically so `emitDefaultValue` can give it a plain
			// `ref.null` at construction time (a non-nullable ref field would need a real `struct.new`-
			// time constructor call instead, extra machinery this compiler's existing "nullable field,
			// lazily filled in" idiom already avoids elsewhere) -- `Object.defineProperty`'s own write
			// path (`emitObjectDefineProperty`) lazily allocates the real `Map` on first use.
			: [{ name: '#ext', wtype: { ...(ensureClass('Map', [TS.RefType('string'), T.ANY]) ?? (() => { throw `internal: 'Map' isn't available for '${base.name}''s own dynamic extension`; })()).thisWtype! as { ref: string }, nullable: true }, optional: true as const }];
		const name = `${base.name}$ext`;
		const fields = [...base.fields, ...extraFields];
		const info: ClassInfo = {
			decl:			base.decl,
			name,
			thisTsType:		base.thisTsType,
			typeIndex:		addType({
				final: true,
				supertypes: [base.typeIndex],
				type: { kind: 'struct', fields: fields.map(f => ({ type: toValType(f.wtype), mut: true })) },
			}),
			thisWtype:		{ ref: name },
			fields,
			fieldIndex:		new Map([...base.fieldIndex, ...extraFields.map((f, i): [string, number] => [f.name, base.fields.length + i])]),
			methodDecls:	new Map(),
			superClass:		base,
		};
		classes.set(name, info);
		classExtensions.set(base.name, info);
		return info;
	}

	// Emits a constructor body statement-by-statement, same as an ordinary `stmts.forEach(st => emitStmt(st,
	// ctx))` -- except a `super(...)` call is recognized and *inlined*: the superclass's own constructor
	// body runs right there, writing into the exact same `this` (there's only ever one physical allocation
	// for the whole hierarchy -- see `ensureClass`'s field-layout comment -- so "calling super" here means
	// "run its init logic", not "allocate a separate base object"). Recurses naturally for a multi-level
	// chain (the superclass's own body may contain its own `super(...)`, resolved against *its* own
	// `cls.superClass` in the recursive call).
	function emitCtorStatements(ctor: MethodMember, cls: ClassInfo, ctx: FunctionContext, setField: (field: string, value: Expr) => void): void {
		const params = ctor.params;
		const stmts	= ctor.body!;

		// A parameter property (`constructor(public x: number)`) has no `this.x = x` statement anywhere
		// in `stmts` at all -- real TS synthesizes that assignment itself, and (verified against real TS
		// output) runs it *before* any class-level field initializer, not after, even though a field's own
		// `= value` is textually declared above the constructor -- e.g. `y = this.x + 1; constructor(public
		// x: number) {}` needs `x` assigned first for `y`'s own initializer to see it. Only reached for a
		// scalar-only class (`ensureCtor`'s `struct.new_default` path); an object-typed field forces the
		// other, explicit-collection path, which already assigns parameter properties itself (`ensureCtor`'s
		// own `setField` loop over `params`).
		const emitParamPropertyInits = () => {
			for (const p of params) {
				if (hasMod(p, 'public') || hasMod(p, 'private') || hasMod(p, 'protected'))
					setField(p.key as string, { type: 'identifier', name: p.key as string });
			}
		};
		// A class-level field initializer (`tag: number = 99`) isn't part of the constructor's own
		// `body` at all -- it has to be synthesized as a real `this.field = value` assignment and run
		// at the right point: after `super(...)` returns (if there is one) but before the rest of this
		// class's own constructor body, matching real JS/TS field-initialization order. Only reached
		// for a scalar-only class (`ensureCtor`'s `struct.new_default` path) -- an object-typed field
		// forces the other, explicit-collection path, whose own `initField` already does this correctly.
		const emitOwnFieldInits = () => {
			for (const m of cls.decl.body) {
				if (m.type === 'field' && !m.modifiers?.includes('static') && m.value)
					setField(m.key as string, m.value);
			}
		};

		if (!stmts.some(st => st.type === 'expression' && st.expression.type === 'call' && st.expression.callee.type === 'super')) {
			emitParamPropertyInits();
			emitOwnFieldInits();
		}
		for (const st of stmts) {
			if (st.type === 'expression' && st.expression.type === 'call' && st.expression.callee.type === 'super') {
				const call = st.expression;
				const superClass = cls.superClass;
				if (!superClass)
					throw `no superclass -- 'super(...)' is not supported here`;
				if (call.arguments.some(a => a.type === 'spread'))
					throw `'super(...)': a spread argument is not supported`;
				const superDecls = superClass.methodDecls.get('constructor');
				if (!superDecls)
					throw `superclass '${superClass.name}' needs an explicit constructor for 'super(...)' to call`;
				const superCtor = resolveOverload(`${superClass.name}'s constructor`, superDecls, call.arguments, ctx);
				if (!superCtor.body)
					throw `needs a body (overload signatures are not supported)`;

				// Binds the base ctor's own param names to this call's own argument expressions -- a plain
				// `var_decl` per param, reusing the ordinary local-declaration path (including its own
				// destructuring-pattern desugaring, for a destructured base param) unchanged. A nested scope
				// closes once the base's own body has run, matching real TS scoping: the base ctor's own
				// params aren't visible to the rest of *this* ctor's body.
				ctx.inScope(() => {
					superCtor.params.forEach((p, i) => {
						const argExpr = call.arguments[i] ?? p.default;
						if (!argExpr)
							throw `'super(...)': missing argument parameter '${describeBinding(p.key)}'`;
						emitStmt(JS.VarDecl('const', JS.Var(p.key, argExpr, p.typeAnnotation)), ctx);
					});
					emitCtorStatements(superCtor, superClass, ctx, setField);
				});
				emitParamPropertyInits();
				emitOwnFieldInits();
			} else
			// An ordinary `this.field = value` statement, written directly in the constructor body (not a
			// param property, not a class-level field initializer) -- the historically-supported way to
			// assign an object-typed field (`this.inner = new Other(...)`, needs a real value collected
			// before `struct.new`, so it can't go through plain assignment codegen at all until `setField`
			// decides it's safe to). Routed through `setField` too, same as the other two synthesized
			// sources above -- `setField` itself (see `ensureCtor`) knows whether this is still mid-
			// collection or `this` already exists. Gated on `cls.fieldIndex` (this constructor's own
			// level's real data fields only, not an inherited one from a *further* subclass, matching real
			// TS scoping) so an accessor write (`this.someSetter = x`) still falls through to ordinary
			// `emitStmt` -- calling a setter needs a real `this` receiver, so it's correctly caught by
			// `case 'this'`'s own guard if attempted too early.
			if (st.type === 'expression' && st.expression.type === 'binary' && st.expression.operator === '=' && st.expression.left.type === 'member' && st.expression.left.object.type === 'this' && cls.fieldIndex.has(st.expression.left.property)) {
				setField(st.expression.left.property, st.expression.right);
			} else {
				emitStmt(st, ctx);
			}
		}
	}

	function ensureCtor(cls: ClassInfo, args: Expr[], callerCtx: FunctionContext): FuncInfo {
		const decls = cls.methodDecls.get('constructor');
		if (!decls)
			throw `class '${cls.name}' needs an explicit constructor`;

		const ctor			= resolveOverload(`${cls.name}'s constructor`, decls, args, callerCtx);
		const key			= decls.length > 1 ? `${cls.name}.constructor#${decls.indexOf(ctor)}` : `${cls.name}.constructor`;
		const existing		= funcs.get(key);
		if (existing)
			return existing;

		const params		= resolveParams(ctor.params);
		if (ctor.rest?.typeAnnotation)
			params.push({key: ctor.rest.key, wtype: typeOf(ctor.rest.typeAnnotation)!, tsType: ctor.rest.typeAnnotation});

		//const thisWtype	= ownerThisType(cls);
		const thisWtype		= cls.thisWtype!;

		const {funcIndex, typeIndex} = registerFunc(toParams2(params), toResults(thisWtype));
		const info: FuncInfo = { params: params.map(r => r.wtype), result: thisWtype, funcIndex, typeIndex, defaults: defaultsWithImplicitUndefined(ctor.params), resolvedParams: params, hasRest: !!ctor.rest?.typeAnnotation };
		funcs.set(key, info);

		// A constructor's own `return;` never carries a value (real TS syntax already enforces this at
		// the checker level) -- it just means "stop early, `this` is the result," same value every real
		// exit already emits via `ctx.ctorThis`.
		const ctorOnReturn: ReturnHandler = {
			wtype: () => undefined,
			emit(ctx, argument) {
				if (argument)
					throw 'a constructor cannot return a value';
				ctx.emit(I.local.get(ctx.ctorThis!.index), I.return);
			},
		};

		worklist.push(withCatch(() => {
			// The class's OWN module (`ensureClass`'s `declScope`/`homeModule`), not the entry's -- a
			// constructor body naming something only its own file declares (a non-exported module-level
			// const, a sibling class) must resolve it there. Same pairing `compileFunc` gives a top-level
			// function; `libGlobal` remains the fallback for a lib class or a synthesized shape.
			const ctx		= new FunctionContext(key, new Scope(cls.declScope ?? libGlobal), plainReturn(thisWtype), cls, cls.homeModule);
			ctx.widenedTypes = collectRangeWidenings(ctor.body!, ctx.scope);
			ctx.ownBody = ctor.body!;
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
			// This constructor supplies `this` directly via its own return value (`ctorReturnsValue`)
			// `cls`'s own `thisWtype`/`typeIndex` already say so; ordinary statement compilation does the right thing once `ctx.ctorThis` is unset.
			const last = ctor.body?.at(-1);
			if (last?.type === 'return' && last.argument) {
				ctor.body!.forEach(st => emitStmt(st, ctx));

			// Defaultability is a whole-struct-type property, not per-field -- one object-typed field forces the collect-then-`struct.new` path for the whole class.
			} else if (cls.fields.some(f => typeof f.wtype !== 'string')) {

				// An optional field is never *required* to be assigned -- it still needs a real value for the
				// single `struct.new` below, so seed it with its own null default up front (`addField` already
				// forced its wtype nullable) and leave it out of `remaining`.
				const remaining	= new Set(cls.fields.filter(f => !f.optional).map(f => f.name));
				const values	= new Map<string, Local>();
				ctx.ctorFields	= values;
				// No real local for `this` yet, but `checkerTypeOf` still needs its static type to resolve a
				// chained read like `this.p.x` (`p` already collected) down to `p`'s own class -- same no-real-
				// local, scope-only registration `declareCaptured` uses for closure captures.
				ctx.scope.addValue('this', cls.thisTsType);

				for (const f of cls.fields) {
					if (f.optional) {
						const local = ctx.declareLocal(`$field$${f.name}`, f.wtype);
						emitDefaultValue(f.wtype, ctx);
						ctx.emit(I.local.set(local.index));
						values.set(f.name, local);
					}
				}

				const materializeThis = () => {
					for (const f of cls.fields)
						ctx.emit(I.local.get(values.get(f.name)!.index));
					ctx.emit(I.struct.new(cls.typeIndex));
					const thisLocal = ctx.declareValue('this', thisWtype, cls.thisTsType);
					ctx.ctorThis = thisLocal;
					ctx.onReturn = ctorOnReturn;
					ctx.ctorFields = undefined;
					ctx.emit(I.local.set(thisLocal.index));
				};
				// Every field optional (or none at all): nothing will ever empty `remaining` from inside the
				// callback below, so `this` has to exist before the body runs at all.
				if (!remaining.size)
					materializeThis();

				emitCtorStatements(ctor, cls, ctx, (field: string, value: Expr) => {
					// Once `this` genuinely exists (either every field was collected earlier in this same
					// constructor, or this is a *reassignment* after that point) -- an ordinary field write,
					// same as the scalar-only path's own `setField` always does. Only reachable via
					// `emitCtorStatements`'s own explicit-`this.field=value`-statement interception (a
					// param property/field initializer is always emitted before `remaining` can be empty).
					if (!ctx.ctorFields) {
						emitStmt({
							type: 'expression',
							expression: { type: 'binary', operator: '=', left: { type: 'member', object: { type: 'this' }, property: field }, right: value },
						}, ctx);
						return;
					}
					const wtype = cls.fields[cls.fieldIndex.get(field)!].wtype;
					const local = ctx.declareLocal(`$field$${field}`, wtype);
					emitAs(value, ctx, wtype);
					ctx.emit(I.local.set(local.index));
					values.set(field, local);
					remaining.delete(field);
					if (!remaining.size)
						materializeThis();
				});
				if (remaining.size)
					throw `never assigns field(s) ${[...remaining].join(', ')}`;
				ctx.emit(I.local.get(ctx.ctorThis!.index), I.return);

			} else {
				const thisLocal = ctx.declareValue('this', thisWtype, cls.thisTsType);
				ctx.ctorThis = thisLocal;
				ctx.onReturn = ctorOnReturn;
				ctx.emit(
					I.struct.new_default(cls.typeIndex),
					I.local.set(thisLocal.index),
				);
				emitCtorStatements(ctor, cls, ctx, (field: string, value: Expr) => emitStmt({
					type: 'expression',
					expression: { type: 'binary', operator: '=', left: { type: 'member', object: { type: 'this' }, property: field }, right: value },
				}, ctx));
				ctx.emit(I.local.get(ctx.ctorThis!.index), I.return);
			}

			info.body = ctx.toFuncBody(ctor.params.length + (ctor.rest ? 1 : 0), toValType);
		}, key));
		return info;
	}

	// `args`/`callerCtx` pick which overload applies when `name` has more than one real body (`resolveOverload`) -- irrelevant, safe to pass an empty probe list, when there's only one (the common case).
	// `typeArgs`: an explicit call-site type argument list for a generic *method*'s own type params
	// (`obj.map<number>(f)`) -- distinct from, and layered on top of, `owner`'s own class-level type
	// params, which are already fully concrete by the time `owner` (a real `ClassInfo`) exists at all.
	function ensureMethod(owner: ClassInfo, name: string, args: Expr[], callerCtx: FunctionContext, typeArgs?: Type[]): FuncInfo | undefined {
		const decls		= owner.methodDecls.get(name);
		const fullName	= `${owner.name}.${name}`;
		// Not overridden by `owner` itself -- delegate straight to the ancestor's own compiled function
		// (cached under *its* own key, e.g. `A.greet`, not `owner.name`'s) rather than recompiling a
		// duplicate copy under `owner`'s name. Sound and free: wasm-GC struct subtyping (`ensureClass`'s own
		// `supertypes`) makes a `(ref Derived)` value directly callable wherever `(ref A)` is declared, no
		// cast needed -- this is the whole reason a non-overridden inherited method stays a single, plain,
		// statically-resolved `call`, exactly as if there were no inheritance involved at all.
		if (!decls)
			return owner.superClass && ensureMethod(owner.superClass, name, args, callerCtx, typeArgs);
		let decl = resolveOverload(fullName, decls, args, callerCtx);
		// Qualified so it can share `funcs` with plain top-level functions (bare identifiers can't contain
		// '.') without colliding; only suffixed when there's a real overload set to disambiguate.
		let key = decls.length > 1 ? `${fullName}#${decls.indexOf(decl)}` : fullName;

		// A generic method's own type params (beyond whatever `owner`'s class-level ones already resolved
		// to, e.g. `class Box<T> { map<U>(f: (t: T) => U): Box<U> {...} }`) -- same composite-key/substitution
		// shape `ensureGenericFunc` uses for a top-level generic function, just layered on top of `owner`'s
		// own already-instantiated key instead of a bare function name. `decl` here is `owner.methodDecls`'
		// own copy, which already has the class's `T` substituted throughout (from `ensureClass`) -- only
		// `U` is left to resolve.
		// A `MethodMember` (unlike a whole `FunctionDecl`) isn't one of `walk`'s own root node types, so this
		// can't reuse `substituteTypeParams` as one call the way `ensureGenericFunc` does -- signature pieces
		// go through `T.substituteType` individually (matching checker.ts's own `instantiate`, which does the
		// exact same per-piece substitution for a signature), the body still through `substituteTypeParams`
		// (a plain `Statement[]`, which `walk` does accept directly).
		if (decl.typeParams?.length) {
			const map = inferTypeArgMap(decl.typeParams, decl.params, args, typeArgs, callerCtx.scope);
			key		= genericKey(key, decl.typeParams, map, global);
			decl	= {
				...decl,
				typeParams: undefined,
				params:		decl.params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteType(p.typeAnnotation, map) } : p),
				rest:		decl.rest?.typeAnnotation ? { ...decl.rest, typeAnnotation: T.substituteType(decl.rest.typeAnnotation, map) } : decl.rest,
				returnType: decl.returnType ? T.substituteType(decl.returnType, map) : decl.returnType,
				body:		decl.body ? substituteTypeParams(decl.body, map) : decl.body,
			};
		}

		const existing = funcs.get(key);
		if (existing)
			return existing;

		// A `this`-typed return/param (`sort(): this`, `equals(other: this): boolean`) means "whatever
		// `owner`'s own concrete type is" -- the checker itself resolves this lazily and contextually
		// (never materializing a concrete type for it, see `T.substituteThisType`'s own comment), but
		// codegen needs one real `WasmType` up front, so it's substituted in here before `typeOf` ever
		// sees it. A no-op (returns the original node) when neither mentions `this` at all.
		decl = {
			...decl,
			returnType: decl.returnType && T.substituteThisType(decl.returnType, owner.thisTsType),
			params:		decl.params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteThisType(p.typeAnnotation, owner.thisTsType) } : p),
		};
		if (!decl.body)
			throw `'${fullName}' needs a body (overload signatures are not supported)`;

		const result = decl.returnType ? typeOf(decl.returnType) : 'void';
		if (!result)
			throw `'${fullName}' has an unsupported return type`;

		const params		= resolveParams(decl.params);
		if (decl.rest?.typeAnnotation)
			params.push({key: decl.rest.key, wtype: typeOf(decl.rest.typeAnnotation)!, tsType: decl.rest.typeAnnotation});

		const isStatic		= decl.modifiers?.includes('static');
		const reassignsThis = !isStatic && assignsToThis(decl.body);
		const thisWtype		= ownerThisType(owner);
		const {funcIndex, typeIndex} = registerFunc(
			isStatic		? toParams2(params) : [{ type: toValType(thisWtype), id: 'this' }, ...toParams2(params)],
			reassignsThis	? [...toResults(result), toValType(thisWtype)] : toResults(result)
		);

		const info: FuncInfo = { params: params.map(r => r.wtype), result, funcIndex, typeIndex, defaults: defaultsWithImplicitUndefined(decl.params), resolvedParams: params, hasRest: !!decl.rest?.typeAnnotation, reassignsThis };
		funcs.set(key, info);
		worklist.push(withCatch(() => {
			// See `ensureCtor`'s own note -- a method body resolves against its class's declaring module too.
			const ctx	= new FunctionContext(key.replace('.', '_').replace('#', '_'), new Scope(owner.declScope ?? libGlobal), plainReturn(result), owner, owner.homeModule);
			if (!isStatic)
				ctx.declareValue('this', thisWtype, owner.thisTsType);
			if (reassignsThis) {
				// A `reassignsThis` method's own (possibly just-updated) `this` rides along as one more
				// wasm-level result on every return, on top of its ordinary declared result -- see
				// `assignsToThis`'s own comment for why a method's body doing this at all is this
				// compiler's own signal to compile it this way.
				ctx.onReturn = {
					wtype: () => result === 'void' ? undefined : result,
					emit(ctx, argument) {
						if (result === 'void') {
							if (argument)
								throw "a 'void' function cannot return a value";
						} else if (argument) {
							emitAs(argument, ctx, result);
						}
						ctx.emit(I.local.get(ctx.lookup('this')!.index), I.return);
					},
				};
			}
			ctx.widenedTypes = collectRangeWidenings(decl.body!, ctx.scope);
			ctx.ownBody = decl.body!;
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
			decl.body!.forEach(st => emitStmt(st, ctx));
			emitTrailingUnreachable(ctx, result);
			info.body = ctx.toFuncBody((isStatic ? 0 : 1) + params.length, toValType);
		}, key));
		return info;
	}

	// Every owner (boxed `number`/`boolean`, plus every class ever reached) declaring a real, non-`this`-
	// reassigning, zero-argument `name` -- the candidate set a dynamic (`any`-typed) dispatch of `name()`
	// cascades over. Deduped by physical `heapType` (several owners sharing one physical type need only one
	// `ref.test` arm). `!assignsToThis` excludes a method with no sensible write-back target through a boxed `any` value (`Array<T>.push`/etc).
	function findAnyDispatchCandidates(name: string, ctx: FunctionContext): { heapType: number; isBoxedScalar: boolean; funcInfo: FuncInfo }[] {
		const found = new Map<number, { heapType: number; isBoxedScalar: boolean; funcInfo: FuncInfo }>();
		const probe = (owner: ClassInfo | undefined, heapType: number, isBoxedScalar: boolean) => {
			if (owner && !found.has(heapType) && owner.methodDecls.get(name)?.find(d => d.body && !assignsToThis(d.body) && T.argsFit(T.FixSig(d, T.ANY), [], ctx.scope))) {
				const funcInfo = ensureMethod(owner, name, [], ctx);
				if (funcInfo)
					found.set(heapType, { heapType, isBoxedScalar, funcInfo });
			}
		};
		probe(builtinTypeOwner('number'), ensureBoxType('f64'), true);
		probe(builtinTypeOwner('boolean'), ensureBoxType('i32'), true);
		for (const cls of classes.values()) {
			// `-1` is `ensureClass`'s sentinel for "scalar-backed, no physical heap type" -- meaningless as a
			// `ref.test` target (every scalar-backed class would collide on it); already covered above via `ensureBoxType` for the two real cases (`number`/`boolean`) that can reach an `any` slot.
			if (cls.typeIndex !== -1)
				probe(cls, cls.typeIndex, false);
		}
		return [...found.values()];
	}

	// `x.name` where `x`'s static type is genuinely `any` -- the FIELD sibling of `ensureAnyDispatch`, and
	// the same `ref.test` cascade `ensureUnionFieldDispatch` runs over a union, just over "every class ever
	// reached" instead of a bounded member set. `guard()`'s own `set.has(node.type)` is the shape.
	// Always yields `REF_ANY`: the candidates' own field types legitimately differ, and every consumer of a
	// dynamic read already has to `coerceTop` its way back out of one.
	function ensureAnyField(name: string, ctx: FunctionContext): FuncInfo {
		const existing = anyFieldFuncs.get(name);
		if (existing)
			return existing;

		const { funcIndex, typeIndex } = registerFunc(toParams2([{key: 'recv', wtype: REF_ANY, tsType: T.ANY}]), toResults(REF_ANY));
		const info: FuncInfo = { params: [REF_ANY], result: REF_ANY, funcIndex, typeIndex };
		anyFieldFuncs.set(name, info);
		funcs.set(`<any field>.${name}`, info);

		lateWorklist.push(() => {
			const dctx = new FunctionContext(`field_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`, new Scope(libGlobal), plainReturn(REF_ANY), undefined);
			const recv = dctx.declareLocal('$recv', REF_ANY);

			// Deduped by physical HEAP type, not by `ClassInfo` -- several owners can share one, and a
			// repeated arm is dead code.
			const seen = new Set<wasm.HeapType>();
			const candidates: { cls: ClassInfo; heap: wasm.HeapType; read: () => void }[] = [];
			const probe = (cls: ClassInfo | undefined, heap: wasm.HeapType | undefined) => {
				if (!cls || heap === undefined || seen.has(heap))
					return;
				const idx = cls.fieldIndex.get(name);
				if (idx !== undefined && cls.typeIndex !== -1) {
					seen.add(heap);
					candidates.push({ cls, heap, read: () => {
						dctx.emit(I.struct.get(cls.typeIndex, idx));
						coerceTop(cls.fields[idx].wtype, dctx, REF_ANY);
					} });
				} else if (cls.getterNames?.has(name)) {
					const sig = methodSig(cls, accessorKey('get', name), dctx);
					if (sig) {
						// Boxed by the member's DECLARED type, not the physical width the getter's body
						// happens to produce. `String.length` is `get length(): number` over an `array.len`,
						// so it yields `u32`; boxed as-is that is an i32 box, while every consumer reads a
						// `number` back out of an `any` by casting to the f64 box, and that cast traps.
						// Anything entering an `any` slot has to be in its logical type's canonical form.
						// `T.lookupMember`, not the decl: an `__asm` accessor keeps no declaration at all
						// (it becomes an `inlineMethods` entry, and `String.length` is exactly one).
						const declared	= cls.thisTsType && T.lookupMember(cls.thisTsType, name, dctx.scope);
						const canonical	= (declared && typeOf(declared)) || sig.result;
						const want		= canonical === 'void' ? sig.result : canonical;
						seen.add(heap);
						candidates.push({ cls, heap, read: () => {
							emitMethodCall(cls, accessorKey('get', name), [], dctx);
							coerceTop(sig.result, dctx, want);
							coerceTop(want, dctx, REF_ANY);
						} });
					}
				}
			};

			// The builtin owners FIRST, exactly as `findAnyDispatchCandidates` seeds `number`/`boolean`:
			// none of them is ever in `classes` unless something happened to reach it as a class, and a
			// `string` in an `any` slot is the commonest dynamic receiver there is. `e.message.length` on a
			// caught error reported "no reachable class declares a field 'length'" purely because of this --
			// `String.length` is a getter on a class with no struct of its own, so neither this loop nor the
			// `typeIndex !== -1` test below could ever see it.
			probe(builtinTypeOwner('string'), ensureArrayType('i16'));
			probe(builtinTypeOwner('bigint'), ensureArrayType('i32'));
			probe(builtinTypeOwner('number'), ensureBoxType('f64'));
			probe(builtinTypeOwner('boolean'), ensureBoxType('i32'));
			// A plain array literal never reaches `ensureClass('Array', ...)` -- it is built straight into
			// its physical array type -- so `Array<T>`'s own members are absent from `classes` however many
			// arrays the program has. Gated on the array type ALREADY existing: if it does not, no value of
			// that kind can be in an `any` slot, and asking would only add a type nothing uses.
			for (const [kind, elem] of [['f64', T.NUMBER], ['ref', T.ANY]] as const) {
				if (hasArrayType(kind))
					probe(ensureClass('Array', [elem]), ensureArrayType(kind));
			}
			for (const cls of classes.values()) {
				// `-1` is `ensureClass`'s no-struct-of-its-own sentinel -- but that does not mean untestable:
				// an array-backed class (`Array<number>` is `arr:f64`, a typed-array view its own element
				// kind) has a real heap type to `ref.test` against. Only a genuinely scalar-backed owner has
				// none, and those are already covered by the boxed probes above.
				const w = cls.thisWtype;
				probe(cls, cls.typeIndex !== -1 ? cls.typeIndex
					: w && typeof w !== 'string' && ('arr' in w || 'typeIndex' in w) ? heapTypeIndexOf(w)
					: undefined);
			}
			if (!candidates.length)
				throw `no reachable class declares a field '${name}' -- a dynamic read on 'any' needs at least one real candidate`;

			// A receiver matching nothing reaches `unreachable` and traps, exactly as `ensureAnyDispatch`
			// does -- reading a field that isn't there has no honest answer.
			function buildArm(i: number): wasm.Instr[] {
				if (i >= candidates.length)
					return [I.unreachable];
				const c = candidates[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(c.heap));
				const _cond = dctx.swapOut();
				dctx.emit(I.local.get(recv.index), I.ref.cast(c.heap));
				c.read();
				return [..._cond, I.if(toValType(REF_ANY), dctx.swapOut(), buildArm(i + 1))];
			}
			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(1, toValType);
		});
		return info;
	}

	// `'k' in x` where `x`'s static type is genuinely `any`: with no runtime property metadata, "has `k`"
	// is exactly "is one of the classes that declare `k`" -- a `ref.test` over every reachable one, OR-ed.
	// A method or getter counts (JS finds a prototype member too), and so does an OPTIONAL field, for the
	// same reason the union case above gives. Null fails every test and so answers `false`, which is what
	// `k in undefined` should be (real JS throws; there is no throwing to do here).
	// Shared function + `lateWorklist` for the same reason `ensureAnyDispatch` needs them: the candidate
	// set is every class ever reached, and is only final once `worklist` has drained.
	function ensureAnyIn(name: string): FuncInfo {
		const existing = anyInFuncs.get(name);
		if (existing)
			return existing;

		const { funcIndex, typeIndex } = registerFunc(toParams2([{key: 'recv', wtype: REF_ANY_NULLABLE, tsType: T.ANY}]), toResults('i32'));
		const info: FuncInfo = { params: [REF_ANY_NULLABLE], result: 'i32', funcIndex, typeIndex };
		anyInFuncs.set(name, info);
		funcs.set(`<any in>.${name}`, info);

		lateWorklist.push(() => {
			const dctx = new FunctionContext(`in_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`, new Scope(libGlobal), plainReturn('i32'), undefined);
			const recv = dctx.declareLocal('$recv', REF_ANY_NULLABLE);
			// `-1` is `ensureClass`'s scalar-backed sentinel -- no physical heap type, so no `ref.test` target.
			const declaring = [...classes.values()].filter(c => c.typeIndex !== -1
				&& (c.fieldIndex.has(name) || c.getterNames?.has(name) || c.methodDecls.has(name)));
			if (!declaring.length) {
				dctx.emit(I.i32.const(0));
			} else {
				declaring.forEach((c, i) => {
					dctx.emit(I.local.get(recv.index), I.ref.test(c.typeIndex));
					if (i)
						dctx.emit(I.i32.or);
				});
			}
			info.body = dctx.toFuncBody(1, toValType);
		});
		return info;
	}

	// A real dynamic-dispatch cascade for `recv.name()` where `recv`'s static type is genuinely `any`.
	// One shared function per `(name, want)` pair, reserved immediately so call sites can `call` it right away -- but its body can only be built
	// once the full, final candidate set is known, needing every class ever discovered. `lateWorklist`, drained only once `worklist` has fully emptied, is what guarantees that.
	function ensureAnyDispatch(name: string, want: WasmType, ctx: FunctionContext): FuncInfo {
		const key = `${name}=>${wasmTypeKey(want)}`;
		const existing = anyDispatchFuncs.get(key);
		if (existing)
			return existing;

		const { funcIndex, typeIndex } = registerFunc(toParams2([{key: 'recv', wtype: REF_ANY, tsType: T.ANY}]), toResults(want));
		const info: FuncInfo = { params: [REF_ANY], result: want, funcIndex, typeIndex };

		anyDispatchFuncs.set(key, info);
		funcs.set(`<any dispatch>.${key}`, info);
		lateWorklist.push(() => {
			const candidates = findAnyDispatchCandidates(name, ctx);
			if (!candidates.length)
				throw `no reachable class (or 'number'/'boolean') declares a matching zero-argument '${name}' -- a dynamic dispatch on 'any' needs at least one real candidate`;
			const dctx = new FunctionContext(key.replace(/[^a-zA-Z0-9_]/g, '_'), new Scope(libGlobal), plainReturn(want), undefined);
			const recv = dctx.declareLocal('$recv', REF_ANY);

			function buildArm(i: number): wasm.Instr[] {
				if (i >= candidates.length)
					return [I.unreachable];
				const c = candidates[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(c.heapType));
				const _cond = dctx.swapOut();
				dctx.emit(I.local.get(recv.index), I.ref.cast(c.heapType));
				if (c.isBoxedScalar)
					dctx.emit(I.struct.get(c.heapType, 0));
				// The call site is zero-`args`, but the candidate may still declare optional/defaulted trailing
				// params beyond `this` -- wasm has no "optional", so their defaults must still be pushed (`emitCallArgs`, shared with `emitMethodCall`).
				emitCallArgs(name, c.funcInfo.params, c.funcInfo.defaults, !!c.funcInfo.hasRest, [], dctx, c.funcInfo.resolvedParams);
				dctx.emit(I.call(c.funcInfo.funcIndex));
				coerceTop(c.funcInfo.result, dctx, want);
				return [..._cond, I.if(want === 'void' ? undefined : toValType(want), dctx.swapOut(), buildArm(i + 1))];
			}

			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(1, toValType);
		});
		return info;
	}

	// A real dynamic-dispatch cascade for `recv.name` (a plain field read, not a call) where `recv`'s
	// static type is a genuine union of >=2 different object shapes (`typeOf`'s own union case boxes
	// this as `any`, same physical representation `ensureAnyDispatch` already uses for a truly untyped
	// receiver) -- found via a generic callback resolving its own type param to a real union, contextually
	// (`Rule([...], $ => ({...}))`-shaped calls, once their own `T` correctly resolves to a union like
	// `SpreadExpr | OtherExpr` rather than an anonymous shape). Unlike `ensureAnyDispatch`, `members` is
	// the union's own exact, bounded set (not "every class ever reached") -- the checker already verified
	// every member declares this field before allowing the access at all, so this never needs a fallback
	// "no candidate matched" arm the way `ensureAnyDispatch` does; a receiver failing every `ref.test` here
	// would mean the checker was wrong, an internal inconsistency, not a real program to guard against.
	// A plain-array-typed union member (`number[]`, `boolean[]`, ...) has TWO real, valid physical forms
	// at runtime, not one: its own natural element-typed representation (`ownerFor`'s own `Array<number>`,
	// a real `f64` array) when the value came from a precisely-typed local/field, OR the ref-kind,
	// boxed-`any`-element representation (`Array<any>`) when it was built as a literal directly in a
	// boxed-`any` position -- `case 'array'`'s own "a literal about to be boxed as `any` picks ref-kind
	// storage regardless of how scalar its elements look" rule (found via `dwg/src/crc16.ts`'s own
	// `updateBuffer([1,2,3])`, an array literal passed straight into a `Uint8Array | number[]` parameter,
	// boxed `any` for the union -- traps at runtime, `ref.test`-ing only the `f64`-array form the
	// literal never actually took). A union member resolving to `Array` dispatches through both forms;
	// `dedupe` by `typeIndex` covers a member that already directly names `Array<any>` (nothing to add).
	function expandArrayMembers(members: readonly ClassInfo[]): ClassInfo[] {
		const seen = new Set<number>();
		const out: ClassInfo[] = [];
		const add = (m: ClassInfo) => { if (!seen.has(m.typeIndex)) { seen.add(m.typeIndex); out.push(m); } };
		for (const m of members) {
			add(m);
			if (m.decl.name === 'Array') {
				const anyForm = ensureClass('Array', [T.ANY]);
				if (anyForm)
					add(anyForm);
			}
		}
		return out;
	}

	function ensureUnionFieldDispatch(members: readonly ClassInfo[], name: string, resultTsType: Type | undefined): FuncInfo {
		members = expandArrayMembers(members);
		const key = `${name}=>[${members.map(m => m.typeIndex).join(',')}]`;
		const existing = unionFieldDispatchFuncs.get(key);
		if (existing)
			return existing;

		// Scratch ctx, live for this whole function's life (not just the deferred body below) -- a
		// getter-backed member (`.length` on `Array<T>`, e.g. `Uint8Array | number[]`) needs `ensureMethod`
		// run right now, synchronously, same as any other method-resolving call site, to learn its real
		// result type before `result` (and so this dispatcher's own signature) can be decided; `onReturn`
		// is swapped in below once `result` is known, but nothing here ever actually reads it -- `buildArm`
		// emits its own raw `I.return`-free branching directly, never through `ctx.onReturn`.
		const dctx = new FunctionContext(key.replace(/[^a-zA-Z0-9_]/g, '_'), new Scope(libGlobal), plainReturn(REF_ANY), undefined);

		// Each member's own field or `get` accessor. A member that has NEITHER is dropped rather than
		// rejected: the checker allowed this access, so either every member has the property or it
		// NARROWED the receiver first (`u.k === 'b' ? u.b : ...`, and every discriminated union in a real
		// program). Codegen doesn't track narrowing, so it still sees the whole union here -- but a member
		// the narrowing excluded cannot be the runtime value, so leaving it out of the cascade is exactly
		// right. It also stays honest for an unchecked program: a receiver matching no arm reaches
		// `buildArm`'s own trailing `unreachable` and traps, rather than reading a field that isn't there.
		const memberFields = members.map(m => {
			// A member declares `name` as a real field, or as a getter (`Array<T>.length` is inline asm, so
			// `methodSig` rather than `ensureMethod` -- the same "either shape" dispatch index-syntax `get`/`set`
			// already needs).
			const idx = m.fieldIndex.get(name);
			if (idx !== undefined)
				return { cls: m, kind: 'field' as const, fieldIdx: idx, wtype: m.fields[idx].wtype };
			if (m.getterNames?.has(name)) {
				const sig = methodSig(m, accessorKey('get', name), dctx);
				if (sig)
					return { cls: m, kind: 'getter' as const, wtype: sig.result };
			}
			return undefined;
		}).filter(f => !!f);

		if (!memberFields.length)
			throw `internal: no member of the union type has a field '${name}'`;

		// The dispatch's own result type comes from the property's real checker type on the union
		// (`T.lookupMember`'s own 'union' case unions each constituent's own property type together) --
		// NOT from comparing each member's raw *physical* wtype, which can legitimately differ even when
		// every member's own declared TS type for the property is identical (e.g. `Uint8Array.length`'s
		// internally-narrowed `i32` field storage vs. `Array<T>.length`'s getter, raw asm result `u32` --
		// both really just `number`). Getting this wrong doesn't just pick a clumsier representation: a
		// per-member `coerceTop(f.wtype, dctx, REF_ANY)` boxes strictly by *physical* wtype (an `i32`-kind
		// box), while the caller's own `coerceTop(REF_ANY, ctx, wantWtype)` unboxes strictly by *wanted*
		// type (here `f64`'s box kind) -- two different box shapes, so the caller's `ref.cast` traps at
		// runtime. Falls back to `REF_ANY` only if the property type genuinely couldn't be resolved here
		// (shouldn't happen -- the one real call site already required `owners.every(o => ...)` to
		// succeed, which needs the same property to exist on every member).
		const result = resultTsType && typeOf(resultTsType) || REF_ANY;
		dctx.onReturn = plainReturn(result);

		const { funcIndex, typeIndex } = registerFunc(toParams2([{ key: 'recv', wtype: REF_ANY, tsType: T.ANY }]), toResults(result));
		const info: FuncInfo = { params: [REF_ANY], result, funcIndex, typeIndex };
		unionFieldDispatchFuncs.set(key, info);
		funcs.set(`<union field dispatch>.${key}`, info);

		worklist.push(withCatch(() => {
			const recv = dctx.declareLocal('$recv', REF_ANY);

			function buildArm(i: number): wasm.Instr[] {
				if (i >= memberFields.length)
					return [I.unreachable];
				const f = memberFields[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(f.cls.typeIndex));
				const _cond = dctx.swapOut();
				dctx.emit(I.local.get(recv.index), I.ref.cast(f.cls.typeIndex));
				if (f.kind === 'getter')
					emitMethodCall(f.cls, accessorKey('get', name), [], dctx);
				else
					dctx.emit(I.struct.get(f.cls.typeIndex, f.fieldIdx));
				coerceUnionArm(f.wtype, dctx, result);
				return [..._cond, I.if(result === 'void' ? undefined : toValType(result), dctx.swapOut(), buildArm(i + 1))];
			}

			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(1, toValType);
		}, key));
		return info;
	}

	// `arr[i]` on a real union of indexable classes (e.g. `Uint8Array | number[]`) -- same per-member
	// `ref.test`/`ref.cast` dispatch shape as `ensureUnionFieldDispatch`, just always through each
	// member's own `get(i)` method rather than a field/getter: every indexable class in this compiler
	// (a typed-array view, or the real `Array<T>` struct a plain `number[]`/`boolean[]`/etc. resolves to
	// via `ownerFor`'s own 'array' case) shares this one convention, so there's no separate "raw array"
	// arm to handle the way `case 'index'`'s own single-receiver path still needs one.
	function ensureUnionIndexDispatch(members: readonly ClassInfo[]): FuncInfo {
		members = expandArrayMembers(members);
		const key = `[]=>[${members.map(m => m.typeIndex).join(',')}]`;
		const existing = unionIndexDispatchFuncs.get(key);
		if (existing)
			return existing;

		// Same scratch-ctx-live-for-the-whole-function reasoning as `ensureUnionFieldDispatch` -- `get`'s
		// own result type must be known, synchronously, before `result` (and so this dispatcher's own
		// signature) can be decided.
		const dctx = new FunctionContext(key.replace(/[^a-zA-Z0-9_]/g, '_'), new Scope(libGlobal), plainReturn(REF_ANY), undefined);

		// Each member's own `get(i)` -- an internal inconsistency (not a real program error) if any member
		// turns out not to have one, since the one real call site already required every member to satisfy
		// `methodSig(o, 'get', ctx)` before ever calling this.
		const memberGets = members.map(m => {
			const sig = methodSig(m, 'get', dctx);
			if (!sig)
				throw `internal: '${m.name}' (a member of a union type) has no 'get' method`;
			return { cls: m, wtype: sig.result };
		});
		// `combineUnionWtypes`, not the checker's own indexing type (unlike `ensureUnionFieldDispatch`'s
		// `T.lookupMember`-based result) -- `checkerTypeOf` on a union receiver's own indexed-access
		// expression doesn't resolve to the same per-member-unioned precision `lookupMember` gives a named
		// property (confirmed directly: `(Uint8Array | number[])[i]` checker-types as plain `any`, not
		// `u8 | number`), so this compares each member's own real `get(i)` result physically instead.
		const result = combineUnionWtypes(memberGets.map(m => m.wtype));
		dctx.onReturn = plainReturn(result);

		const { funcIndex, typeIndex } = registerFunc(
			toParams2([{ key: 'recv', wtype: REF_ANY, tsType: T.ANY }, { key: 'idx', wtype: 'i32', tsType: T.NUMBER }]),
			toResults(result)
		);
		const info: FuncInfo = { params: [REF_ANY, 'i32'], result, funcIndex, typeIndex };
		unionIndexDispatchFuncs.set(key, info);
		funcs.set(`<union index dispatch>.${key}`, info);

		worklist.push(withCatch(() => {
			const recv = dctx.declareLocal('$recv', REF_ANY);
			dctx.declareValue('$idx', 'i32', T.NUMBER);

			function buildArm(i: number): wasm.Instr[] {
				if (i >= memberGets.length)
					return [I.unreachable];
				const m = memberGets[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(m.cls.typeIndex));
				const _cond = dctx.swapOut();
				dctx.emit(I.local.get(recv.index), I.ref.cast(m.cls.typeIndex));
				emitMethodCall(m.cls, 'get', [{ type: 'identifier', name: '$idx' }], dctx);
				coerceUnionArm(m.wtype, dctx, result);
				return [..._cond, I.if(result === 'void' ? undefined : toValType(result), dctx.swapOut(), buildArm(i + 1))];
			}

			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(2, toValType);
		}, key));
		return info;
	}

	// A real dynamic-dispatch cascade for `recv.name(...args)` where `recv`'s *static* type (`owner`) has
	// at least one reachable subclass overriding `name` (`emitMethodCall` only ever routes here when
	// `hasDeclaredOverride` says so -- every other call, the overwhelming majority even in a program that
	// uses inheritance at all, stays a plain direct `call`, exactly as without inheritance). Same shape as
	// `ensureAnyDispatch` (reserve a funcIndex immediately so call sites can `call` it right away; build the
	// real cascade body once `lateWorklist` guarantees every reachable class has been discovered) --
	// generalized to a real receiver type (not just `any`) and real method arguments (not just zero-arg).
	// One assumption this doesn't verify: every override shares `owner`'s own resolved param/result
	// `WasmType`s (real TS requires override signatures to stay compatible with the base's, which this
	// narrow subset takes to mean "the same shape", same trust-the-checker stance as everywhere else here).
	function ensureVirtualDispatch(owner: ClassInfo, name: string, ctx: FunctionContext): FuncInfo {
		const key = `${owner.name}.${name}<virtual>`;
		const existing = anyDispatchFuncs.get(key);
		if (existing)
			return existing;
		// `[]`: safe even for a real-arg method, not just zero-arg like `ensureAnyDispatch`'s own use of this
		// same call -- `resolveOverload` only actually consults `args` to disambiguate a genuine overload
		// set (`decls.length > 1`); a plain, non-overloaded method (the only kind this function supports --
		// see the header comment) returns its one real declaration unconditionally, args ignored.
		const base = ensureMethod(owner, name, [], ctx);
		if (!base)
			throw `internal: virtual dispatch requested for unknown method '${owner.name}.${name}'`;

		const { funcIndex, typeIndex } = registerFunc([{ type: toValType(owner.thisWtype!), id: 'this' }, ...toParams(base.params)], toResults(base.result));
		const info: FuncInfo = { params: base.params, result: base.result, funcIndex, typeIndex, defaults: base.defaults, hasRest: base.hasRest };
		anyDispatchFuncs.set(key, info);
		funcs.set(`<virtual dispatch>.${key}`, info);

		lateWorklist.push(() => {
			// Every *reachable* (already `ensureClass`'d, unlike `directSubclasses`' whole-source-text set) class
			// transitively extending `owner` that overrides `name` with a real body, deepest-first -- `ref.test`
			// recognizes a value as a subtype of *every* ancestor's own struct type too (a grandchild instance
			// passes `ref.test $Child` as well as `ref.test $GrandChild`), so testing shallower candidates first
			// would wrongly stop at an ancestor's override even when the receiver's real, more-derived class has
			// its own. Depth is measured by walking each candidate's own `superClass` chain back up to `owner`.
			const found: { depth: number; cls: ClassInfo }[] = [];
			for (const cls of classes.values()) {
				if (cls === owner || cls.typeIndex === -1 || !cls.methodDecls.get(name)?.some(d => d.body))
					continue;
				let depth = 0;
				for (let p: ClassInfo | undefined = cls; p; p = p.superClass, depth++) {
					if (p === owner) {
						found.push({ depth, cls });
						break;
					}
				}
			}
			const candidates = found.sort((a, b) => b.depth - a.depth).map(({ cls }) => ({ cls, funcInfo: ensureMethod(cls, name, [], ctx)! }));
			const dctx = new FunctionContext(key.replace(/[^a-zA-Z0-9_]/g, '_'), new Scope(libGlobal), plainReturn(base.result), undefined);
			const recv = dctx.declareLocal('$recv', owner.thisWtype!);
			// Already-evaluated argument values (the caller pushed these against `owner`'s own signature,
			// not knowing yet which concrete override will run) -- forwarded as-is to whichever `call`
			// actually fires, never re-evaluated.
			const argLocals = base.params.map((p, i) => dctx.declareLocal(`$arg$${i}`, p));

			const buildArm = (i: number): wasm.Instr[] => {
				if (i >= candidates.length) {
					// No override matched -- the receiver really is (an instance of, or a non-overriding
					// subclass of) `owner` itself. `ensureMethod(owner, ...)` already resolved `base` by
					// walking up to whichever ancestor actually defines `name`; call it directly.
					dctx.emit(I.local.get(recv.index));
					argLocals.forEach(l => dctx.emit(I.local.get(l.index)));
					dctx.emit(I.call(base.funcIndex));
					return dctx.swapOut();
				}
				const c = candidates[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(c.cls.typeIndex));
				const _cond = dctx.swapOut();
				dctx.emit(I.local.get(recv.index), I.ref.cast(c.cls.typeIndex));
				argLocals.forEach(l => dctx.emit(I.local.get(l.index)));
				dctx.emit(I.call(c.funcInfo.funcIndex));
				coerceTop(c.funcInfo.result, dctx, base.result);
				return [..._cond, I.if(base.result === 'void' ? undefined : toValType(base.result), dctx.swapOut(), buildArm(i + 1))];
			};

			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(1 + argLocals.length, toValType);
		});
		return info;
	}


	// ===================================================================
	//  Program lowering
	// ===================================================================

	const mod		= new wasm.WasmModule();

	const promotedConsts = new Set<string>();

	// Seed with every exported (real, user-level top-level) function and reserve every class name eagerly.
	// Only *functions* are seeded across every module this way -- a non-entry module's own classes/scalar
	// globals aren't yet given the module-scoped treatment `ensureClass`/`ensureGlobal` would need (see
	// `TStoWasm`'s own header comment), so `class_decl`/scalar `var_decl` promotion below stays entry-only,
	// exactly as before multi-file support existed.
	for (const [moduleId, body] of moduleBodies) {
		for (let s of body) {
			if (s.type === 'export_decl')
				s = s.declaration;
			stmtHomeModule.set(s, moduleId);
			if (s.type === 'function_decl' && s.body) {
				functionDeclByName.set(homeKey(moduleId, s.name), s);
			} else if (moduleId === '.' && s.type === 'class_decl') {
				if (s.typeParams?.length) {
					userGenericClassDecls.set(s.name, s);
				} else {
					classes.set(s.name, {
						name: 		s.name,
						typeIndex:	-1,
						thisTsType:	TS.RefType(s.name),
						decl:		s,
						fields: 	[],
						fieldIndex: new Map(),
						methodDecls: new Map(),
					});
				}
			} else if (s.type === 'var_decl' && s.kind !== 'var') {
				for (const d of s.declarations) {
					if (typeof d.name !== 'string' || !d.init)
						continue;
					// The entry module's own top-level declarators, so a plain READ of one can find its real
					// initializer. Only `exportScope` (an IMPORTED module's shape) stamps `Scope.addDecl` for a
					// var_decl, so `ctx.scope.decl(name)` -- what the cross-module path uses -- finds nothing at
					// all here. Entry-only, matching the eager/promoted handling right below.
					if (moduleId === '.')
						topLevelVars.set(d.name, { stmt: s, d });
					if (s.kind === 'const' && (d.init.type === 'arrow' || d.init.type === 'function')) {
						functionDeclByName.set(homeKey(moduleId, d.name), arrowOrFunctionToDecl(d.name, d.init));
						if (moduleId === '.')
							promotedConsts.add(d.name);
					} else if (moduleId === '.') {
						// `foldConstants` first -- `-1`/`!true`/etc. parse as a real `unary`/`binary` node, not
						// a bare `literal` one, so checking `d.init.type === 'literal'` directly missed every
						// negative-literal (or other foldable) initializer, silently leaving that global
						// unregistered (confirmed the hard way: any function referencing it then threw
						// "unresolved identifier", unrelated to whatever else that function was doing). Reusing
						// `foldConstants` here matches `case 'switch'`'s own linear-jump-table detection, the
						// file's existing "is this expression actually a compile-time constant" idiom.
						const folded = foldConstants(d.init)!;
						// Only a literal a wasm global can actually be INITIALIZED from -- i.e. one the
						// `mod.globals` builder below accepts. A string literal is still a `literal` node but
						// has no constant form (its physical value is an i16 array built at runtime), and so
						// is a `bigint` unless it lands on a real `i64` slot; claiming those here registered a
						// global that then threw "needs a compile-time-constant initializer" at emit time.
						// Everything rejected here falls through to `ensureLazyGlobal` on first reference.
						const eagerKind = folded.type === 'literal' && notUnsigned(scalarKind(typeOf(d.typeAnnotation ?? checkerTypeOf(d.init, libGlobal))));
						if (eagerKind && (typeof folded.value === 'number' || typeof folded.value === 'boolean' || (typeof folded.value === 'bigint' && eagerKind === 'i64'))) {
							// A top-level `let`/`const` primitive with a compile-time-constant initializer
							// becomes a real wasm global -- the same mechanism a library declaration (e.g.
							// `lib/console.ts`'s `heap`) already uses, just registered *eagerly* here rather than
							// lazily on first reference, since a user declaration's own position in `ast.body`
							// stops mattering once it's a global: every function sees the same slot regardless
							// of compile order. `mut: false` for `const` -- a genuine wasm-level compile-time
							// constant, not just a same-value-never-checked mutable slot.
							const wtype = typeOf(d.typeAnnotation ?? checkerTypeOf(d.init, libGlobal));
							if (wtype && wtype !== 'void') {
								ensureGlobal(d.name, wtype, folded, s.kind !== 'const');
								promotedConsts.add(d.name);
							}
						}
					}
				}
			}
		}
	}

	// wasm requires every import at the lowest, contiguous function indices, assigned before any local
	// function claims one -- so "is this host import needed" must be decided up front, before the worklist
	// first reaches its caller. Deliberately a conservative, name-matching over-approximation, not a precise call-graph simulation -- an unused import is harmless, so this only needs to never *under*-approximate.
	const reached	= new Set<string>();
	const pending: string[] = [];

	const collectNames = (node: TS.Stmt | TS.Stmt[]) => walk(node, undefined, (e, process) => {
		if (e.type === 'identifier')
			pending.push(e.name);
		return process(e);
	});

	// Every module's own top-level statements, not just the entry's -- `walk` already descends into every
	// nested function/class body it finds, so this alone covers everything reachable *syntactically*; the
	// `pending` loop below only adds the (separate) `LIB_AST` declarations on top. Deliberately
	// unconditional (not gated by cross-module call-graph reachability) -- see this pass's own "never
	// under-approximate" comment above; walking a module that turns out unreached just adds a few
	// harmless extra names to `reached`.
	for (const body of moduleBodies.values())
		collectNames(body);

	while (pending.length) {
		const name = pending.shift()!;
		if (!reached.has(name)) {
			reached.add(name);
			const decl = functionDeclByName.get(name) ?? LIB_DECL_MAP.get(name);
			if (decl && (decl.type === 'function_decl' || decl.type === 'class_decl'))
				collectNames(decl);
		}
	}

	// Every module's own host imports, not just the static lib's -- an on-demand `lib/node/*` module
	// declaring `import { path_open } from 'wasi_snapshot_preview1'` now registers it exactly as a lib file
	// does. Deduped by name: the same host function imported by two modules is still ONE wasm import.
	const hostImports = [...new Map(
		[...LIB_HOST_IMPORTS, ...[...moduleBodies.values()].flatMap(hostImportsIn)].map(hi => [hi.name, hi] as const)
	).values()];

	mod.imports = hostImports.filter(hi => reached.has(hi.name)).map(hi => {
		const params = hi.params.map(p => resolveParam({ key: '', typeAnnotation: p }).wtype);
		const result = hi.returnType ? typeOf(hi.returnType) ?? 'void' : 'void';
		const { funcIndex, typeIndex } = registerFunc(toParams(params), toResults(result));
		funcs.set(hi.name, { params, result, funcIndex, typeIndex });
		return { module: hi.source, name: hi.name, desc: { kind: 'func', typeIndex, id: undefined } };
	});

	for (const d of [
		...[...LIB_DECL_MAP.values()].filter(d => d.type === 'class_decl'),
		...userGenericClassDecls.values(),
		...[...classes.values()].map(c => c.decl),
	]) {
		const superName = d.superClass?.type === 'identifier' ? d.superClass.name
			: d.superClass?.type === 'instantiation' && d.superClass.expression.type === 'identifier' ? d.superClass.expression.name
			: undefined;
		if (superName) {
			everExtended.add(superName);
			const list = directSubclasses.get(superName);
			if (list)
				list.push(d);
			else
				directSubclasses.set(superName, [d]);
		}
	}

	//top level
	const {funcIndex, typeIndex} = registerFunc([], []);
	const info: FuncInfo = {params: [], result: 'void', funcIndex, typeIndex};
	funcs.set('__toplevel', info);
	mod.start	= funcIndex;
	worklist.push(withCatch(() => {
		const ctx	= new FunctionContext('__toplevel', new Scope(libGlobal), plainReturn('void'), undefined);
		ctx.widenedTypes = collectRangeWidenings(ast.body!, ctx.scope);
		ctx.ownBody = ast.body!;
		// Each statement emitted into its own buffer so a failure can discard exactly its own partial
		// output and leave everything before it intact -- `ctx.emit` appends, so without the swap a
		// half-emitted statement would corrupt the start function's stack balance.
		const emitTopLevel = (st: Stmt) => {
			if (!onTopLevelError)
				return emitOneTopLevel(st);
			const before = ctx.swapOut();
			try {
				emitOneTopLevel(st);
				ctx.emit(...ctx.swapOut(before));
			} catch (e) {
				ctx.swapOut(before);
				onTopLevelError(new TSWError(e as any, st, '<module init>'));
			}
		};
		const emitOneTopLevel = (st: Stmt) => {
			if (st.type === 'export_decl' || st.type === 'function_decl' || st.type === 'class_decl' || st.type === 'type_alias_decl' || st.type === 'interface_decl' || st.type === 'import')
				return;
			// A bare `export {a, b}` / `export type {T} from '...'` / `export * from '...'` binds nothing and
			// evaluates nothing -- the module's own export list is built from its `export_decl`s, not here.
			// `export default <expr>` is excluded: that one really does have a value to evaluate.
			if (st.type === 'export' && !st.default)
				return;
			if (st.type === 'var_decl') {
				// Declarator by declarator, in source order, so forcing one below never reorders it past a
				// sibling that still emits normally.
				for (const d of st.declarations) {
					// A promoted const is already a real function; an alias (`const Scope = T.Scope`, `const
					// I = wasm.I`) only renames something declared elsewhere -- see `isAliasInit`. Neither
					// leaves anything for the start function to evaluate.
					if (typeof d.name === 'string' && (promotedConsts.has(d.name) || (d.init && isAliasInit(d.init, ctx.scope))))
						continue;
					// A declarator that HAS a lazy global is already evaluated by that wrapper, which caches
					// into the slot every other function reads. Emitting the initializer here as well ran it
					// a SECOND time, into a start-function local nothing else can even see -- so a
					// side-effecting initializer ran twice and two different values circulated. Force the
					// wrapper instead: one evaluation, at module-init time, visible everywhere.
					const lazy = typeof d.name === 'string' && d.init ? lazyGlobalFor(d.name, ctx) : undefined;
					if (lazy)
						ctx.emit(I.call(lazy.wrapper.funcIndex), I.drop);
					else
						emitStmt({ ...st, declarations: [d] }, ctx);
				}
				return;
			}
			emitStmt(st, ctx);
		};
		ast.body!.forEach(emitTopLevel);
		//emitTrailingUnreachable(ctx, result);
		info.body = ctx.toFuncBody(0, toValType);
	}));


	// The exported function name(s) a top-level `export_decl`'s inner declaration represents, or `[]` if
	// it isn't a function export at all (a plain value global, a class, ...) -- shared below by the eager-
	// compile loop (needs the *names*) and the exports-list-building loop further down (needs the same
	// classification to build each `mod.exports` entry), so the two can't silently drift apart.
	const exportedNames = new Set(ast.body.filter(s => s.type === 'export_decl').flatMap(s => {
		if (s.declaration.type === 'function_decl' && s.declaration.body)
			return [s.declaration.name];
		if (s.declaration.type === 'var_decl')
			return s.declaration.declarations.filter(d => typeof d.name === 'string' && promotedConsts.has(d.name) && functionDeclByName.has(d.name)).map(d => d.name as string);
	}));

	// Only *exported* top-level functions need to be compiled unconditionally here -- the exports-list
	// loop further down reads `funcs.get(name)!.funcIndex` for each and needs it to already exist. Every
	// other top-level function (reachable or not) is only ever discovered indirectly, from a real call site
	// (`emitCall`'s own `funcs.get(name) ?? compileFunc(...)`), same worklist-driven "only what's actually
	// reached gets processed" design classes/generic instantiations already get -- this file's own header
	// comment on unreachable-code handling only actually held for those, not top-level functions, until now.
	// A generic entry additionally has no single physical function to eagerly compile at all (like a generic
	// top-level class, kept out of the eagerly-seeded `classes` map for the same reason) -- only a real call
	// site (`ensureGenericFunc`) can ever produce a concrete instantiation. An *exported* generic function has
	// no fixed signature to give a wasm-level export, so it's just skipped here -- a library module's own
	// generic exports are still reachable to other compiled-in files via the ordinary named/namespace-import
	// resolution in `emitCall` etc., which needs no wasm-level export at all.
	for (const [name, decl] of functionDeclByName) {
		if (!exportedNames.has(name))
			continue;
		if (decl.typeParams?.length)
			continue;
		const info = compileFunc(name, decl);
		if (info)
			(mod.exports??=[]).push({ name, kind: 'func', index: info.funcIndex });
	}

	while (worklist.length)
		worklist.shift()!();

	// `lateWorklist` (any-dispatch cascade bodies) needs the *full, final* candidate set, so it only starts
	// once `worklist` has completely drained -- building a cascade can itself reach a not-yet-compiled candidate method, pushing back onto `worklist`, so that's drained again after every `lateWorklist` item too.
	while (lateWorklist.length) {
		lateWorklist.shift()!();
		while (worklist.length)
			worklist.shift()!();
	}

	// ---- assemble the module ----

	const numImports	= mod.imports.length;
	const numFuncs		= [...funcs.values()].filter(info => info.funcIndex >= numImports).length;
	mod.functionTypes	= new Array<number>(numFuncs);
	mod.code			= new Array<wasm.FuncBody>(numFuncs);

	function place(info: FuncInfo) {
		if (info.funcIndex < numImports)
			return;
		mod.functionTypes![info.funcIndex - numImports]	= info.typeIndex;
		mod.code![info.funcIndex - numImports]			= info.body!;
	}

	for (const info of funcs.values())
		place(info);

	for (const info of lazyGlobals.values())
		place(info);

	for (const info of closureLiterals)
		place(info);

	// One shared rec group for every STRUCT/ARRAY type this module registers, not a singleton group each
	// -- wasm-GC type equivalence is structural *within* a group's own shape only up to each member's
	// position in it, but fully structural *across* separate groups (confirmed empirically, not assumed:
	// two singleton groups with identical shape -- e.g. two sibling classes adding no fields of their own
	// beyond a shared base -- canonicalize into one runtime type, which `ref.test` then can't tell apart).
	// One shared group sidesteps that for every struct/array at once, with zero cost: `types[]`'s own
	// registration order already satisfies a rec group's one real requirement (a contiguous run), and
	// grouping never makes two *already*-distinct types collide, only ever adds distinguishing power for
	// ones that would otherwise coincide.
	//
	// Only a *host-imported* func type is excluded from that shared group, each instead getting its own
	// singleton group -- `ref.test`/`ref.cast` (the reason struct/array types need the shared-group
	// protection) is never applied to a bare func type here (a closure wraps its func type inside a real
	// *struct*, and it's the struct that's `ref.test`ed, never the func type itself), so an *internal* func
	// type (a closure's, a method's) is just as safe to share the one big group as any struct/array -- only
	// an externally-declared type (a real host import like WASI's `fd_write`) needs to canonicalize as its
	// own flat shape (a singleton group's canonical form, per the wasm-GC spec) to match what the host
	// itself expects. Confirmed via wasmtime, which -- correctly, per spec -- rejected `fd_write`'s import
	// when its type was bundled into the shared group, even though the flat signature printed identically
	// either way; Node's own WASI/V8 path was lenient about this, masking the bug there.
	// **Narrowed from "every func type" to "every *imported* func type" after a real regression**: the
	// self-/mutually-referential struct fix (`ensureClass`/`ensureObjectShape` registering a placeholder
	// `typeIndex` before resolving fields, so a reentrant call finds a real forward index instead of
	// recursing) can legitimately need two structs to forward-reference each other *around* an ordinary
	// internal func type registered in between (e.g. a closure's own func type, added mid-way through
	// resolving one class's fields, ends up sitting between it and another struct it needs to reference) --
	// splitting the run at every func-kind position (the original, over-broad rule) put the two structs in
	// separate rec groups, which produces an invalid *forward* reference across a group boundary (only
	// valid *within* one contiguous group) -- confirmed via wasmtime rejecting the emitted module outright
	// ("type index N out of bounds"), not a silent miscompile. `mod.imports` (already built above) is the
	// authoritative, narrow set of func types that actually need external-shape canonicalization.
	const importedFuncTypeIndices = new Set((mod.imports ?? []).flatMap(imp => imp.desc.kind === 'func' && typeof imp.desc.typeIndex === 'number' ? [imp.desc.typeIndex] : []));
	const groupSizes: number[] = [];
	for (let i = 0, runStart = 0; i <= types.length; i++) {
		if (i === types.length || importedFuncTypeIndices.has(i)) {
			if (i > runStart)
				groupSizes.push(i - runStart);
			if (i < types.length)
				groupSizes.push(1);
			runStart = i + 1;
		}
	}
	mod.types			= { types, groupSizes };

	// Declare a memory exactly when the compiled code really touches one -- any `load`/`store`/`memory.*`
	// it actually contains, whatever emitted it. This was keyed off the `heap` GLOBAL'S NAME, a proxy for
	// "console.ts's allocator was reached", which missed a linear-memory read that never allocates
	// (`String.fromCharCodesAt`) and emitted a module whose own code then failed validation.
	const memOp		= (op: string) => op.startsWith('memory.') || /^(i32|i64|f32|f64|v128)\.(load|store)/.test(op);
	const seenInstr	= new Set<object>();
	const touchesMemory = (v: unknown): boolean => {
		if (!v || typeof v !== 'object' || seenInstr.has(v))
			return false;
		seenInstr.add(v);
		if (typeof (v as {op?: unknown}).op === 'string' && memOp((v as {op: string}).op))
			return true;
		return (Array.isArray(v) ? v : Object.values(v)).some(touchesMemory);
	};

	if (touchesMemory(mod.code)) {
		mod.memories	= [{ min: 1 }];
		// So a host can actually read back what got written to it (e.g. console.log's fd_write buffer) --
		// any consumer of real linear memory benefits, not just console.log specifically.
		(mod.exports ??= []).push({ name: 'memory', kind: 'memory', index: 0 });
	}
	
	mod.globals			= Array.from(globals.entries()).map(([name, {init, wtype, mut}]) => {
		if (init) {
			const type = { mut, type: toValType(wtype) };
			if (isNullLiteral(init)) {
				if (typeof wtype === 'string' || !wtype.nullable)
					throw `global '${name}' can't be initialized to 'null'/'undefined' -- its type isn't nullable`;
				return {type, init: [I.ref.null(heapTypeIndexOf(wtype))]};
			}
			const wtype2 = notUnsigned(scalarKind(wtype));
			if (wtype2 && init?.type === 'literal') {
				if (typeof init.value === 'number' || typeof init.value === 'boolean')
					return {type, init: [I[wtype2](+init.value)]};
				if (typeof init.value === 'bigint' && wtype2 === 'i64')
					return {type, init: [I[wtype2](init.value)]};
			}
		}
		throw `global '${name}' needs a compile-time-constant initializer`;
	});

	mod.datas			= [{ mode: 'passive', bytes: data }];
	if (tags.length)
		mod.tags		= tags;

	// Every closure literal's `funcIndex` is taken by `ref.func` at its creation site -- wasm requires any function referenced that way to be "declared" first, which a declarative element segment satisfies.
	if (closureLiterals.length)
		mod.elements = [{ mode: 'declarative', reftype: { ref: 'func', nullable: true }, funcIndices: closureLiterals.map(info => info.funcIndex) }];

	return mod;
}
