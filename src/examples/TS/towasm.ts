import * as fs from 'fs';
import * as path from 'path';
import * as TS from './ts-parser';
import * as JS from './js-parser';
import * as T from './type-utils';
import { Literal, Binary } from '../common';
import { checkBlock, typeOf as checkerTypeOf, isOptionalChainLink } from './checker';
import { walk, walkB, hasMod } from './walker';
import { foldConstants, flattenStateMachine, collectHoistedLocals, StateMachine, SegmentNext } from './transform';
import * as wasm from '@isopodlabs/binary_libs/wasm';
import * as WAT from '../wat-parser';

// TStoWasm -- TS-AST-to-wasm backend for a narrow static subset.
// Assumes ast already passed TStypeCheck. Emits a wasm.WasmModule directly (no WAT stage).
// Every gap below throws a clear error rather than silently miscompiling. Unlisted = fully supported;
// an item under a category is either a whole missing construct or the one unsupported edge of an
// otherwise-working one -- never a description of what does work.
//  - Control flow:
//    - exceptions (try/catch/throw/finally)
//    - labeled break/continue
//    - for-in
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
//    - rejection/'.catch' (no try/catch exists yet either, a separate pre-existing gap)
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
//      through -- see 'ensureObjectShape'; general structural inference/subtyping is not this case)
//    - a tag function typed against the real 'TemplateStringsArray' specifically, rather than a plain
//      'string[]' ('.raw' isn't modeled)
//    - calling a closure read directly off an array element ('arr[i](x)') when the array's element
//      type is a named type alias to a function type rather than an inline function type (e.g.
//      'type Fn = () => number; arr: Fn[]') -- a checker 'declScope' stamping gap ('stampScope' skips
//      a ref that already carries a scope, so a type-arg node resolved once under the wrong scope
//      during generic instantiation stays stuck with it) leaves the alias unresolved at the call site
//      even though the same alias resolves fine as a plain variable's declared type; bind the element
//      to a local first ('const f = arr[i]; f(x);', which 'for...of' already does for you) instead
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
type Statement		= TS.Statement;
type BindingTarget	= JS.BindingTarget;
type FunctionDecl	= JS.FunctionDecl<Type>;
type MethodMember	= JS.Method<Type>;
type Scope			= T.Scope;
const Scope			= T.Scope;

const ASSIGN_OPS	= new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '??=']);

const I = wasm.I;

// lib files concatenated into one flat declaration list.
const LIB_DIR		= path.join(__dirname, 'lib');
const LIB_AST		= ['lib.d.ts', 'number.ts', 'bigint.ts', 'string.ts', 'array.ts', 'typedarray.ts', 'regexp.ts', 'console.ts', 'generator.ts', 'promise.ts'].flatMap(f => TS.parse(fs.readFileSync(path.join(LIB_DIR, f), 'utf8')).body);
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
const LIB_HOST_IMPORTS: HostImport[] = (() => {
	const ambientModules = new Map(LIB_AST.filter((n): n is Extract<TS.Statement, { type: 'module_decl' }> => n.type === 'module_decl' && !!n.ambient).map(n => [n.name, n]));
	return LIB_AST.filter((n): n is JS.Import => n.type === 'import' && ambientModules.has(n.source)).flatMap(imp => (imp.specifiers ?? []).flatMap(s => {
		const decl = ambientModules.get(imp.source)!.body.find(d => d.type === 'function_decl' && d.name === s.imported);
		return decl?.type === 'function_decl' ? [{ source: imp.source, name: s.local, params: decl.params.map(p => p.typeAnnotation!), returnType: decl.returnType }] : [];
	}));
})();

// `void` is only valid as a function result, never a param/local/field.
// `u32` is not a real wasm type -- tracks "unsigned i32" so coerceTop picks convert_i32_u vs _s.
type wasmElement	= 'i16' | 'i32' | 'i64' | 'f32' | 'f64' | 'u32' | 'i8' | 'ref';
type WasmType		= 'i32' | 'u32' | 'i64' | 'f32' | 'f64' | 'void'
	| { ref: string; nullable?: boolean }
	| { arr: wasmElement; nullable?: boolean }
	| { closure: FuncSig; nullable?: boolean }
	| { typeIndex: number; nullable?: boolean }
	// A boxed nullable primitive ('number | null'/'boolean | null'): a real class/closure env struct
	// never sets `primKind`, so it's what tells a `typeIndex`-shaped type apart from those -- see
	// `unboxedPrimitive`. Structural, not a side-table, since `registerType`'s memoization could
	// otherwise coincidentally share a type index with an unrelated single-scalar-field struct.
	| { typeIndex: number; nullable?: boolean; primKind: 'f64' | 'i32' };

// Shared singletons -- ctx.local compares WasmType by object identity
const ARR_WTYPE: Record<wasmElement, WasmType> = {
	i16: { arr: 'i16' }, i32: { arr: 'i32' }, i64: { arr: 'i64' }, f32: { arr: 'f32' },
	f64: { arr: 'f64' }, u32: { arr: 'u32' }, i8: { arr: 'i8' }, ref: { arr: 'ref' },
};
const REF_ANY: WasmType = { ref: 'any' };
const REF_ANY_NULLABLE: WasmType = { ref: 'any', nullable: true };

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

// The wasmElement kind for a T[]/Array<T>/ReadonlyArray<T> element type.
// `i8`/`u8` checked by name before `wasmTypeOf` (which would otherwise resolve either straight through to
// plain `number`/`f64`, same as `builtinTypes`'s own before-`T.resolve` pseudo-type checks) -- the one place
// this project needs a genuine packed-byte GC array (`ArrayBuffer`'s backing store, see `lib/typedarray.ts`).
function arrayElemKind(elemType: Type, global: Scope): 'f64' | 'i32' | 'u32' | 'i8' | 'ref' | undefined {
	if (elemType.type === 'ref' && !elemType.typeArgs && (elemType.name === 'i8' || elemType.name === 'u8'))
		return 'i8';
	const we = wasmTypeOf(elemType, global);
	return we === 'i32' || we === 'f64' || we === 'u32' ? we : 'ref';
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
	const w = T.widenLiterals(t.type === 'union' ? T.combineTypes(t.types.map(m => T.resolve(global, m))) : T.resolve(global, t));
	if (w.type === 'array') {
		const we = arrayElemKind(w.element, global);
		return we ? ARR_WTYPE[we] : undefined;
	}

	if (w.type === 'ref') {
		switch (w.name) {
			case 'Array':
			case 'ReadonlyArray': {
				const we = arrayElemKind(w.typeArgs![0], global);
				return we ? ARR_WTYPE[we] : undefined;
			}
		}
		return builtinTypes[w.name]?.wtype;
	}

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

function storageTypeKey(v: wasm.StorageType): string {
	return typeof v === 'string' ? v : `ref:${v.ref}:${v.nullable}`;
}
function wTypeKey(type: wasm.SubType): string|undefined {
	const comp = 'type' in type ? type.type : type;
	return comp.kind === 'func' ? `func(${comp.params.map(p => storageTypeKey(p.type)).join(',')})=>(${comp.results.map(storageTypeKey).join(',')})`
		: comp.kind === 'array' ? `array(${storageTypeKey(comp.field.type)}:${comp.field.mut})`
		: comp.kind === 'struct' ? `struct(${comp.fields.map(f => storageTypeKey(f.type)).join(',')})`
		: undefined;
}


interface FuncSig					{ params: WasmType[]; result: WasmType; hasRest?: boolean }
interface FuncInfo extends FuncSig	{ funcIndex: number; typeIndex: number, body?: wasm.FuncBody; defaults?: (Expr | undefined)[]; reassignsThis?: boolean }
interface Inline extends FuncSig	{ inline: wasm.Instr[] }
interface MethodDelegate 			{ owner: ClassInfo; method: string }
interface ClosureTypeInfo			{ funcTypeIndex: number; structTypeIndex: number }

type Builtin<T = Inline | MethodDelegate | FunctionDecl> = (args: OperandInfo[], ctx: FuncCtx) => T

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
}

interface ClassInfo extends MethodOwner {
	fields:			{ name: string; wtype: WasmType }[];
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

interface Local			{ wtype: WasmType, index: number; }
interface ResolvedParam { key: BindingTarget; wtype: WasmType; tsType: Type }

class FuncCtx {
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
	out:	wasm.Instr[]	= [];
	ctorThis?: Local;
	// Set only while a struct-collecting constructor (see `ensureCtor`) gathers field values into scratch
	// locals ahead of `struct.new` -- lets `this.field` resolve to the field's own local, for a field already
	// collected, before a real `this` exists. Cleared the moment `ctorThis` is set.
	ctorFields?: Map<string, Local>;
	// depth counts open block/loop/if labels; breakTargets/continueTargets record depth at each label
	// so `br(depth - target)` gives the correct relative index from any nesting depth. Only ever touched
	// via the enter*/exit* pairs below, which mirror `openScope`/`closeScope`'s own pairing but for WAT's
	// structural nesting rather than JS lexical scope -- a related, not identical, kind of "currently open".
	depth = 0;
	breakTargets:		number[] = [];
	continueTargets:	number[] = [];

	// One more WAT label with no `break`/`continue` target of its own (`if`, and the bare "loop" level
	// inside a desugared `for` -- see its own comment). `n` > 1 only for `switch`'s `n` nested case-blocks.
	enterLabel(n = 1) {
		this.depth += n;
	}
	exitLabel(n = 1) {
		this.depth -= n;
	}

	// A loop or switch's enclosing block -- what `break` (with no label) branches to.
	enterBreakTarget() {
		this.breakTargets.push(++this.depth);
	}
	exitBreakTarget() {
		this.breakTargets.pop();
		this.depth--;
	}

	// A loop's own restart point -- what `continue` branches to.
	enterContinueTarget() {
		this.continueTargets.push(++this.depth);
	}
	exitContinueTarget() {
		this.continueTargets.pop();
		this.depth--;
	}

	// Set when this FuncCtx is a closure body -- captured names have no real local, reads/writes go through struct.get/set on envLocal.
	closureEnv?: { envLocal: Local; envTypeIndex: number; fields: Map<string, { index: number; wtype: WasmType }> };
	// Set when this FuncCtx is a nested `function_decl`'s own body that's allowed to call itself by
	// name -- a call to `name` resolves to a direct, statically-known `call funcIndex` (reusing the
	// same env) instead of going through a closure struct, since the struct being constructed can't
	// reference itself while it's still being built. See `emitClosureLiteral`'s `allowSelfCall`.
	selfCall?: { name: string; funcIndex: number; params: WasmType[]; result: WasmType; hasRest?: boolean };
	// Populated once, right after construction, by `collectRangeWidenings` -- a `let`/`var` declarator
	// whose reassignments push its numeric range wider than its own initializer alone gives.
	widenedTypes?: Map<JS.Var<Type>, Type>;
	// Set while compiling a reassignsThis method -- every return also pushes the current `this`.
	appendThisOnReturn = false;
	// Set while compiling a generator's own resumable step function -- `case 'return'` in `emitStmt`
	// checks this first: a plain `return expr;` inside a generator body means "done", not an ordinary
	// wasm return of `expr` (the step function's real wasm result is always an `IteratorResult`, never
	// the bare yield/return type) -- see `compileGeneratorFunc`.
	generatorFrame?: { frameLocal: Local; frameTypeIndex: number; stateField: number; doneStateId: number; resultCtor: FuncInfo; rWtype: WasmType };
	// Set while compiling an async function's own resumable step function -- `case 'return'` checks
	// this first, same reasoning as `generatorFrame`: a plain `return expr;` means "resolve the
	// function's own result Promise with `expr`, then a bare wasm `return`", not an ordinary return of
	// `expr` (the step function's own real wasm result type is always `void` -- see `compileAsyncFunc`).
	asyncFrame?: { frameLocal: Local; frameTypeIndex: number; resultPromiseField: number; promiseClass: ClassInfo; rWtype: WasmType };

	constructor(public scope: Scope, public result: WasmType, public owner: ClassInfo | undefined) {}

	private allocIndex(wtype: WasmType): number {
		const free = this.freeSlots.get(wasmTypeKey(wtype));
		if (free?.length)
			return free.pop()!;
		this.slotTypes.push(wtype);
		return this.slotTypes.length - 1;
	}

	// Opens a new lexical scope -- pair with `closeScope` around anything that's a real JS block
	// (`case 'block'` in emitStmt, plus a `for` loop's own init/body and a `switch`'s temps).
	openScope() {
		this.scopeStack.push(this.declared.length);
	}

	// Closes the innermost open scope: every declaration made since its `openScope` becomes invisible to
	// `lookup` and its wasm slot goes back on the free list for a same-typed declaration to reuse.
	closeScope() {
		const mark = this.scopeStack.pop();
		if (mark === undefined)
			throw new Error('towasm: unbalanced scope close');
		for (let i = mark; i < this.declared.length; i++) {
			const d = this.declared[i];
			if (!d.closed) {
				d.closed = true;
				const key	= wasmTypeKey(d.local.wtype);
				const free	= this.freeSlots.get(key);
				if (free)
					free.push(d.local.index);
				else
					this.freeSlots.set(key, [d.local.index]);
			}
		}
	}

	// Same declaration machinery as `declareLocal`, except a still-visible same-name entry is reused
	// (same slot) rather than rejected -- every call site names its scratch temp deterministically
	// (often qualified by `wtype` via `scratchName`), so a repeat name mid-compile always means "the same
	// scratch purpose, safe to share", never an accidental collision.
	local(name: string, wtype: WasmType): number {
		const prev = this.lookup(name);
		if (prev) {
			if (prev.wtype !== wtype)
				throw new Error(`towasm: local '${name}' redeclared with different type`);
			return prev.index;
		}
		const local = { wtype, index: this.allocIndex(wtype) };
		this.declared.push({ name, local, closed: false });
		return local.index;
	}

	declareLocal(name: string, wtype: WasmType): Local {
		// Only a live declaration from the *current* (innermost open) scope is a real conflict -- a live
		// declaration from an enclosing scope is a legitimate nested shadow, and a closed one (a finished
		// sibling scope) doesn't count at all.
		const scopeStart = this.scopeStack.at(-1) ?? 0;
		for (let i = this.declared.length - 1; i >= scopeStart; i--) {
			const d = this.declared[i];
			if (!d.closed && d.name === name)
				throw new Error(`towasm: local '${name}' redeclared (shadowing within the same scope is not supported)`);
		}
		const local = { wtype, index: this.allocIndex(wtype) };
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

	// The WasmType a name has in ctx -- real local or closureEnv field.
	resolvedWtype(name: string): WasmType | undefined {
		return this.closureEnv?.fields.get(name)?.wtype ?? this.lookup(name)?.wtype;
	}

	// Destructured params get a hidden #param$<i> local; returns var_decl stmts to bind the real names.
	// `tsTypes` -- the caller already resolved each param's effective `Type` (annotation, or inferred
	// from a default) via `paramType`, to pick `wtypes` in the first place; reused here rather than
	// re-deriving it a second time (which would also need a `checker` this top-level class doesn't have).
	declareParams(params: ResolvedParam[]): JS.Statement<Type>[] {
		const pending: JS.Statement<Type>[] = [];
		params.forEach((p, i) => {
			if (typeof p.key === 'string') {
				this.declareValue(p.key, p.wtype, p.tsType);
			} else {
				const tmpName = `#param$${i}`;
				this.declareValue(tmpName, p.wtype, p.tsType);
				pending.push(...patternBindings(p.key, { type: 'identifier', name: tmpName }));
			}
		});
		return pending;
	}

	lookup(name: string): Local | undefined {
		for (let i = this.declared.length - 1; i >= 0; i--) {
			const d = this.declared[i];
			if (!d.closed && d.name === name)
				return d.local;
		}
		return undefined;
	}

	swapOut(out: wasm.Instr[] = []) {
		const _old	= this.out;
		this.out	= out;
		return _old;
	}

	emit(...instr: wasm.Instr[]) {
		this.out.push(...instr);
	}

	toFuncBody(numParams: number, toValType: (t: WasmType) => wasm.ValType): wasm.FuncBody {
		return { locals: this.slotTypes.slice(numParams).map(t => ({ count: 1, type: toValType(t) })), body: this.out };
	}
}

// null parses as a literal; undefined is a real identifier -- both need ref.null with a heap type.
function isNullLiteral(e: Expr): boolean {
	return (e.type === 'literal' && e.value === null) || (e.type === 'identifier' && e.name === 'undefined');
}

// For error messages only.
function describeBinding(t: BindingTarget): string {
	return typeof t === 'string' ? t : t.type === 'array_pattern' ? '[...]' : '{...}';
}

// Desugars a destructuring BindingTarget into flat var_decls reading off valueExpr (must be side-effect-free).
// A default value (`el.default`/`prop.default`) just becomes a real `??` (`rawExpr ?? dflt`) -- reuses
// `??`'s own codegen wholesale, including its single-evaluation-of-the-left materialization, rather than
// hand-rolling a second copy of that logic here. `??`'s codegen also needs to tolerate a non-nullable
// left for this to work (see its own comment) -- a default on an already-non-nullable value (an ordinary
// array element, or a non-optional object field) is provably dead code, same as real TS itself would
// prove, not a reason to reject it.
function patternBindings(target: BindingTarget, valueExpr: Expr): JS.Statement<Type>[] {
	if (typeof target === 'string')
		return [JS.VarDecl('const', JS.Var(target, valueExpr))];

	if (target.type === 'array_pattern') {
		const stmts = target.elements.flatMap((el, i) => {
			if (!el)
				return [];
			const elemExpr: Expr = JS.Index(valueExpr, Literal(i));
			return patternBindings(el.target, el.default ? Binary('??', elemExpr, el.default) : elemExpr);
		});
		if (target.rest) {
			// Real JS semantics: the rest collects the remaining elements into a genuinely new array, not
			// a view -- `.slice(n)` (already a real `Array<T>` method) gives exactly that.
			stmts.push(JS.VarDecl('const', JS.Var(target.rest, JS.Call(JS.Member(valueExpr, 'slice'), [Literal(target.elements.length)]))));
		}
		return stmts;
	}

	if (target.rest)
		throw new Error("towasm: a rest property ('...') in an object destructuring pattern is not supported -- unlike array rest (a plain '.slice()'), this needs a genuinely new object type holding an arbitrary 'all fields except these' shape, which isn't modeled yet");
	return target.properties.flatMap(prop => {
		const propExpr: Expr = JS.Member(valueExpr, prop.key);
		return patternBindings(prop.value, prop.default ? Binary('??', propExpr, prop.default) : propExpr);
	});
}

// ===================================================================
//  Closures -- free-variable analysis
// ===================================================================

function paramNames(params: JS.Param<Type>[], rest?: JS.Rest<Type>): string[] {
	const names = params.flatMap(p => T.bindingNames(p.key));
	return rest ? [...names, ...T.bindingNames(rest.key)] : names;
}

// Every name body binds directly (own params + var_decls), not descending into nested arrow/function bodies.
function ownBoundNames(names: string[], body: Statement[] | Expr, selfName?: string): Set<string> {
	const bound = new Set(names);
	if (selfName)
		bound.add(selfName);
	// A `for`'s own `init` (e.g. `for (let i = ...)`) reaches this same `var_decl` case too -- walker.ts
	// routes it through the real statement walk, not just a bare declarator walk, so no separate case is
	// needed here to keep a closure's own loop variable from being mistaken for a free (captured) one.
	walkB(body as JS.Statement<any>[] | Expr,
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
function collectFreeVars(bound: Set<string>, body: Statement[] | Expr, free: Set<string>) {
	walkB(body as JS.Statement<any>[] | Expr,
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


// Qualifies a scratch local's name by its own wtype -- a bare fixed name would collide (`FuncCtx.local`
// throws on a same-name-different-type redeclare) once one function writes to two differently-typed targets.
function scratchName(prefix: string, wtype: WasmType): string {
	return `${prefix}$${wasmTypeKey(wtype)}`;
}

// All four numeric wasm types, in "widen to me first" preference order when an operand's own type has no
// real instruction -- f64 first, since widening i32/i64/f32 up to it is exact or an already-accepted tradeoff.
const NUMERIC_TYPES = ['f64', 'f32', 'i64', 'i32'] as const;
type NumericType = typeof NUMERIC_TYPES[number];
function isNumericType(t: WasmType | undefined): t is NumericType { return NUMERIC_TYPES.includes(t as NumericType); }

// WatInstr and wasm.Instr differ on block/loop/if (unsupported in flat inline asm) and on `__local`
// (a `(local ...)` declaration) -- WAT.parseAsmBody/instantiateAsmBody already hoist every local out
// into their own `.locals` before returning `.body`, so a `__local` reaching here means one leaked
// through that hoisting somewhere, a real bug worth failing fast on rather than silently encoding.
function assertFlatInstrs(instrs: WAT.WatInstr[], asm: string): wasm.Instr[] {
	return instrs.map(i => {
		if (i.op === 'block' || i.op === 'loop' || i.op === 'if')
			throw new Error(`inline asm '${asm}': '${i.op}' (control flow) is not supported in inline asm`);
		if (i.op === '__switch')
			throw new Error(`inline asm '${asm}': switch '${i.key}' is unresolved -- not a ctx.defines entry, and inline asm has no enclosing macro call to bind it to a $tag argument`);
		if (i.op === '__local')
			throw new Error(`inline asm '${asm}': local '${i.id}' should already have been hoisted into a separate locals list`);
		// A `$T.<suffix>` reference with no enclosing `(switch $T ...)` declaring its supported types is a
		// real authoring error, not a type this body happens to support.
		if (i.op === 'local.get' && typeof i.localIndex === 'string' && i.localIndex.startsWith('$T.'))
			throw new Error(`inline asm '${asm}': '${i.localIndex}' needs an enclosing '(switch $T ...)' declaring which types it's for`);
		return i;
	});
}

function isAsm(e?: Expr): e is JS.Call<Type> {
	return e?.type === 'call' && e.callee.type === 'identifier' && e.callee.name === '__asm';
}

const NUMERIC_OP_NAMES = new Set<string>(Object.values(WAT.ROOT_OPS.NONE));

function instantiateAsmBody(generic: WAT.ParsedAsmBody, type: 'i32' | 'i64' | 'f32' | 'f64'): { locals: WAT.WatLocal[]; body: WAT.WatInstr[] } | undefined {
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
				const opName = `${type}.${i.localIndex.slice('$T.'.length)}`;
				if (!NUMERIC_OP_NAMES.has(opName))
					return false;
				body.push({ op: opName } as WAT.WatInstr);
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

	addLocals(generic.locals);
	return process(generic.body) ? { locals, body } : undefined;
}

function makeAsm(key: string, value: Expr | undefined, builtin: string, index: number, elemKind?: wasmElement, elemType?: Type, elemDefine?: TypedArrayTag): Builtin<Inline> | undefined {
	try {
		const	call	= value as JS.Call<Type>;
		let		asm		= (call.arguments[0] as Literal<string | JS.TemplatePart<Expr>[]>).value;

		if (typeof asm !== 'string') {
			if (Array.isArray(asm)) {
				if (asm.some(p => p.exp !== undefined))
					throw new Error('inline asm: template-literal interpolation is not supported, only a plain static string');
				asm = asm.map(p => p.str).join('');
			} else {
				throw new Error('inline asm: expected a string literal');
			}
		}

		const parsed = WAT.parseAsmBody(asm, elemDefine ? {'this': index, elem: elemDefine} : {'this': index});

		// A param/result type that isn't a plain wasm primitive is this owner's own array type or one element of it -- `elemKind` (its real physical storage) is authoritative for both, checked *before* the name switch below:
		// a bare `T` substituting to e.g. `string` is still physically boxed `{ref:'any'}` like every other non-scalar element, not a real `{arr:'i16'}`.
		const resolveType = (t: Type): WasmType | undefined => {
			if (t.type === 'ref') {
				switch (t.name) {
					case 'i32': case 'i64': case 'f32': case 'f64': case 'u32': return t.name;
					case 'void': return 'void';
				}
			}
			// `elemType` (the class's own `T`, substituted verbatim by `walk`) disambiguates a bare `T` from a real `T[]` even when `T` itself resolves array-shaped -- both are `t.type === 'array'` and otherwise indistinguishable, so reference equality is the only safe test.
			// `nullable: true` on the `'ref'` case matches `ensureArrayType`'s own nullable field -- a bare `T` (one boxed element) always physically reads as a nullable `anyref`, regardless of what the substituted TS type claims (see `case 'index'`'s identical fix).
			if (t === elemType)
				return elemKind === 'i16' || elemKind === 'i8' ? ARR_WTYPE[elemKind] : elemKind === 'ref' ? { ref: 'any', nullable: true } : elemKind!;
			if (elemKind)
				return t.type === 'array' ? ARR_WTYPE[elemKind] : elemKind === 'i16' || elemKind === 'i8' ? ARR_WTYPE[elemKind] : elemKind === 'ref' ? { ref: 'any', nullable: true } : elemKind;

			if (t.type === 'ref') {
				switch (t.name) {
					case 'number':	return 'f64';
					case 'boolean':	return 'i32';
					case 'string':	return ARR_WTYPE.i16;
				}
			}
			return undefined;
		};

		// Resolves named scratch locals to real local indices via ctx.local
		const resolveAsmLocals = (instrs: wasm.Instr[], locals: WAT.WatLocal[], ctx: FuncCtx, asm: string): wasm.Instr[] => {
			const indices = new Map(locals.map(l => {
				if (!l.id)
					throw new Error(`inline asm '${asm}': an anonymous local can't be referenced by name`);
				if (l.type === 'i32' || l.type === 'i64' || l.type === 'f32' || l.type === 'f64')
					return [l.id, ctx.local(l.id, l.type)];
				throw new Error(`inline asm '${asm}': unsupported local type '${JSON.stringify(l.type)}'`);
			}));
			return instrs.map(i => {
				if ('localIndex' in i && typeof i.localIndex === 'string') {
					const index = indices.get(i.localIndex);
					if (index === undefined)
						throw new Error(`inline asm '${asm}': undeclared local '${i.localIndex}'`);
					return { ...i, localIndex: index };
				}
				return i;
			});
		};

		const sw = parsed.body.find((i): i is WAT.SwitchPlaceholder => i.op === '__switch' && i.key === '$T');
		if (sw) {
			//generic case
			const variants: Partial<Record<NumericType, { locals: WAT.WatLocal[]; body: wasm.Instr[] }>> = {};

			for (const t of new Set(sw.arms.flatMap(a => a.values).filter(a => typeof a === 'string').map(a => a.slice(1) as NumericType))) {
				const inst = instantiateAsmBody(parsed, t);
				if (!inst)
					throw new Error(`inline asm '${asm}': switch arm '(${sw.arms.find(a => a.values.includes(`$${t}`))!.values.join(' ')})' claims '${t}' but its own body doesn't resolve for it`);
				variants[t] = { locals: inst.locals, body: assertFlatInstrs(inst.body, asm) };
			}
			if (!Object.keys(variants).length)
				throw new Error(`inline asm '${asm}': switch '$T' has no arms`);

			const paramCount = call.typeArgs?.[0]?.type === 'tuple' ? call.typeArgs[0].elements.length : 0;

			return (args, ctx) => {
				let t = args[0]?.wtype;
				if (!isNumericType(t) || !variants[t] || args.length !== paramCount || !args.every(a => a.wtype === t)) {
					t = NUMERIC_TYPES.find(nt => variants[nt]);
					if (!t)
						throw new Error(`towasm: '${builtin}.${key}': no numeric type supports this operation`);
				}
				const parsed = variants[t]!;
				return { params: Array(paramCount).fill(t), result: t, inline: resolveAsmLocals(parsed.body, parsed.locals, ctx, asm) };
			};

		} else {
			const body = {
				locals: parsed.locals.map(l => {
					if (typeof l.type === 'object' && 'typeParam' in l.type)
						throw new Error(`inline asm '${asm}': '(local ${l.id ?? ''} $${l.type.typeParam})' needs a '$T'-generic asm`);
					return { id: l.id, count: l.count, type: l.type };
				}),
				body: assertFlatInstrs(parsed.body, asm)
			};
			const [paramsTuple, resultType] = call.typeArgs ?? [];
			const params = paramsTuple?.type === 'tuple' ? paramsTuple.elements.map(te => {
				const wt = T.tupleElementType(te) && resolveType(T.tupleElementType(te)!);
				if (!wt)
					throw new Error(`unsupported inline-asm param type '${JSON.stringify(te)}'`);
				return wt;
			}) : [];
			const result = resultType ? resolveType(resultType) : 'void';
			if (!result)
				throw new Error(`unsupported inline-asm result type '${JSON.stringify(resultType)}'`);
			return (_args, ctx) => ({ params, result, inline: resolveAsmLocals(body.body, body.locals, ctx, asm) });
		}
	} catch (e) {
		console.warn(`towasm: skipping inline asm '${builtin}.${key}': ${(e as Error).message}`);
		return undefined;
	}
}

// A `get`/`set` accessor's `methodDecls`/`inlineMethods`/`funcs` key, mangled apart from a plain same-named
// method so a getter and a setter for one property can coexist as two entries instead of overwriting each other.
function accessorKey(kind: 'get' | 'set', name: string): string {
	return `${kind}:${name}`;
}

// wasm requires every import at the lowest, contiguous function indices, assigned before any local
// function claims one -- so "is this host import needed" must be decided up front, before the worklist
// first reaches its caller. Deliberately a conservative, name-matching over-approximation, not a precise call-graph simulation -- an unused import is harmless, so this only needs to never *under*-approximate.
function reachedNames(program: TS.Program): Set<string> {
	const functionDeclByName	= new Map(program.body.filter(s => s.type === 'function_decl').map(s => [s.name, s]));

	const reached	= new Set<string>();
	const pending: string[] = [];

	const collectNames = (node: TS.Statement | TS.Statement[]) => walk(node, undefined, (e, process) => {
		if (e.type === 'identifier')
			pending.push(e.name);
		return process(e);
	});

	collectNames(program.body);
	while (pending.length) {
		const name = pending.shift()!;
		if (!reached.has(name)) {
			reached.add(name);
			const decl = functionDeclByName.get(name) ?? LIB_DECL_MAP.get(name);
			if (decl && (decl.type === 'function_decl' || decl.type === 'class_decl'))
				collectNames(decl);
		}
	}
	return reached;
}

function scanInlineMethods(decl: TS.Class, builtin: string, index: number, elemKind?: wasmElement, elemType?: Type, elemDefine?: TypedArrayTag) {
	const inlineDecls: { key: string; value: Expr }[] = [];
	const asmMethodKeys = new Set<string>();

	for (const m of decl.body) {
		if (m.type === 'field' && typeof m.key === 'string' && isAsm(m.value)) {
			inlineDecls.push({ key: m.key, value: m.value! });
		} else if ((m.type === 'method' || m.type === 'get' || m.type === 'set') && typeof m.key === 'string' && m.body?.[0]?.type === 'return') {
			const outer = m.body[0].argument;
			// `outer` is the *invocation* (`__asm<...>('text')(args)`) -- the asm-ness check belongs on
			// its callee (the inner `__asm<...>('text')` call), not on `outer` itself.
			if (outer?.type === 'call' && isAsm(outer.callee)) {
				const paramNames = m.params.map(p => typeof p.key === 'string' ? p.key : undefined);
				const argNames = outer.arguments.map(a => a.type === 'identifier' ? a.name : undefined);
				if (paramNames.length === argNames.length && paramNames.every((p, i) => p !== undefined && p === argNames[i])) {
					const key = m.type === 'get' || m.type === 'set' ? accessorKey(m.type, m.key) : m.key;
					inlineDecls.push({ key, value: outer.callee });
					asmMethodKeys.add(key);
				}
			}
		}
	}

	const inlineMethods = new Map<string, Builtin<Inline>>();
	for (const i of inlineDecls) {
		const builtinFn = makeAsm(i.key, i.value, builtin, index, elemKind, elemType, elemDefine);
		if (builtinFn)
			inlineMethods.set(i.key, builtinFn);
	}
	return { inlineMethods, asmMethodKeys };
}

// Substitutes a generic class's own single type parameter (`PARAM`) for `subs` throughout its decl -- shared
// by `builtinOwner` and `ensureClass`. `thisTsType`, when given, also substitutes a `T[]`-shaped member type for the whole instantiation itself -- specific to `Array<T>`'s own shape, ordinary callers omit it.
function substituteClassTypeParam(decl: JS.ClassDecl<Type>, PARAM: string, subs: Type, thisTsType?: Type): JS.ClassDecl<Type> {
	return walk(decl, undefined, undefined, (t, process) =>
		thisTsType !== undefined && t.type === 'array' && t.element.type === 'ref' && t.element.name === PARAM	? thisTsType
		: t.type === 'ref' && t.name === PARAM																	? subs
		: process(t)
	)!;
}

// General N-type-param substitution, for a generic top-level function/method's own type params -- unlike
// `substituteClassTypeParam` (one name, re-invoked once per class type param), takes every substitution at
// once via a plain `Map`, one `walk` pass regardless of how many type params `node` has. Also unlike a
// class reference (`Box<number>`, always an explicit type argument at the use site), unifies both the
// explicit-type-args and inferred-from-arguments cases: the caller resolves `map` either way (see
// `ensureGenericFunc`), this just applies it structurally through params/return type/body alike.
function substituteTypeParams<N extends TS.Program | Statement | Expr | Type | Statement[]>(node: N, map: ReadonlyMap<string, Type>): N {
	return walk(node, undefined, undefined, (t, process) =>
		t.type === 'ref' && map.has(t.name) ? map.get(t.name)! : process(t)
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
	boolean:	{ wtype: 'i32', 			class: 'Boolean' },
	Boolean:	{ wtype: 'i32', 			class: 'Boolean' },
	number:		{ wtype: 'f64', 			class: 'Number' },
	Number:		{ wtype: 'f64', 			class: 'Number' },
	string:		{ wtype: ARR_WTYPE.i16,		class: 'String' },
	String:		{ wtype: ARR_WTYPE.i16,		class: 'String' },
	bigint:		{ wtype: ARR_WTYPE.u32,		class: 'BigInt' },
	// Pseudo-types from `lib.d.ts` (`declare type i32 = number`, etc) -- real wasm value types, for a field/method whose storage isn't the usual `number`->`f64` mapping (see `lib/typedarray.ts`'s `Uint8Array`).
	i32:		{ wtype: 'i32' },
	i64:		{ wtype: 'i64' },
	f32:		{ wtype: 'f32' },
	f64:		{ wtype: 'f64' },
	u32:		{ wtype: 'u32' },
};

// `Uint8Array`/`Int32Array`/etc are real generic instantiations of `TypedArray<T>` (`lib/typedarray.ts`),
// reached through `ensureClass`'s general alias-resolution (see its own comment) -- `T` is a real type
// argument, e.g. `u8`/`i32`, not a name-substitution target. `elem` (the one thing an ordinary generic
// instantiation doesn't otherwise give `get`/`set` -- a real instruction choice, not a type) is read
// straight off that same type argument's own name, passed down as one more `defines` entry alongside
// `this`, the same per-instantiation mechanism `$this` uses (see `ensureClass`'s `scanInlineMethods` call).
type TypedArrayTag = 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'i64' | 'u64' | 'f32' | 'f64';
const TYPED_ARRAY_TAGS = new Set<TypedArrayTag>(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64']);

const UNARY_OP_NAMES = {
	'-':	'neg',
	'~':	'not',
	'++':	'inc',
	'--':	'dec',
};
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
	'>>':	'shrs',
	'>>>':	'shru',
	'==':	'eq',
	'===':	'eq',
	'!=':	'ne',
	'!==':	'ne',
	'<':	'lt',
	'>':	'gt',
	'<=':	'le',
	'>=':	'ge',
};

const COMPARE_OPS	= {
	'==':	'eq',
	'===':	'eq',
	'!=':	'ne',
	'!==':	'ne',
	'<':	'lt',
	'>':	'gt',
	'<=':	'le',
	'>=':	'ge',
} as const;


// If `wtype` is a boxed nullable primitive (see `nullableWtype`/`ensureBoxType`), its underlying
// scalar kind and box type index; otherwise `undefined` (a real class/array/closure-env-struct, or
// already a bare scalar). Structural (checks `primKind` on the object itself), not a lookup table --
// `registerType`'s structural memoization means an unrelated single-scalar-field struct (e.g. a
// closure's env struct capturing exactly one `f64`) could otherwise coincidentally share a box's
// type index, which a table keyed by type index alone couldn't tell apart.
function unboxedPrimitive(wtype: WasmType): { kind: 'f64' | 'i32'; typeIndex: number } | undefined {
	return typeof wtype !== 'string' && 'primKind' in wtype ? { kind: wtype.primKind, typeIndex: wtype.typeIndex } : undefined;
}
// The plain scalar kind a value acts as for arithmetic/comparison dispatch -- unwraps a boxed
// nullable primitive the same way `coerceTop` does, or passes a bare scalar through unchanged.
// `undefined` for anything else (a real class/array/closure).
function scalarKind(wtype: WasmType | undefined): WasmType | undefined {
	return typeof wtype === 'string' ? wtype : wtype && unboxedPrimitive(wtype)?.kind;
}

// The wasm numeric type a 2-operand op should run in -- widened across *both* operands, not just the left
// one, or an i32-typed left operand (e.g. literal `1`) would silently truncate a fractional right operand.
function numericPairWtype(a: OperandInfo, b: OperandInfo): 'i32' | 'i64' | 'f64' {
	const at = scalarKind(a.wtype), bt = scalarKind(b.wtype);
	if (at === 'i64' || bt === 'i64')
		return 'i64';
	if (at === 'i32' && bt === 'i32')
		return 'i32';
	return 'f64';
}

// bigint/string equality checked by owner name, not physical shape -- {arr:'i16'} could mean something else later.
// A boxed nullable primitive is excluded from the ref.eq path (`unboxedPrimitive` check) even though
// it's object-shaped -- it needs a value comparison after unboxing, not an identity comparison.
function equalityInline(args: OperandInfo[], negate: boolean): Inline | MethodDelegate {
	const t = args[0].wtype;
	if (t && typeof t !== 'string' && !unboxedPrimitive(t))
		return { params: [t, t], result: 'i32', inline: negate ? [I.ref.eq, I.i32.eqz] : [I.ref.eq] };
	return numericPairWtype(args[0], args[1]) === 'i32'
		? { params: ['i32', 'i32'], result: 'i32', inline: [negate ? I.i32.ne : I.i32.eq] }
		: { params: ['f64', 'f64'], result: 'i32', inline: [negate ? I.f64.ne : I.f64.eq] };
}

function arithInline(args: OperandInfo[], f64instr: wasm.Instr[], i32instr: wasm.Instr[], i64instr: wasm.Instr[], boolResult: boolean): Inline {
	const t = numericPairWtype(args[0], args[1]);
	return t === 'i32'
		? { params: ['i32', 'i32'], result: 'i32', inline: i32instr }
		: t === 'i64'
		? { params: ['i64', 'i64'], result: boolResult ? 'i32' : 'i64', inline: i64instr }
		: { params: ['f64', 'f64'], result: boolResult ? 'i32' : 'f64', inline: f64instr };
}
function arithInline1(args: OperandInfo[], f64instr: wasm.Instr[], i32instr: wasm.Instr[], i64instr: wasm.Instr[]): Inline {
	const t = scalarKind(args[0].wtype);
	return t === 'i32'
		? { params: ['i32'], result: 'i32', inline: i32instr }
		: t === 'i64'
		? { params: ['i64'], result: 'i64', inline: i64instr }
		: { params: ['f64'], result: 'f64', inline: f64instr };
}

// Per-operand info for builtin dispatch -- wtype for kind-polymorphic dispatch, owner for identity dispatch.
interface OperandInfo { wtype: WasmType | undefined; owner: ClassInfo | undefined }

// Looks up a top-level const X = __asm<P,R>('...') entry by name and resolves it eagerly.
function libAsmBuiltin(name: string): Builtin<Inline> {
	const info = LIB_DECL_MAP.get(name);
	if (info?.type !== 'var_decl' || !isAsm(info.init))
		throw new Error(`towasm: internal: '${name}' isn't defined as inline asm in towasm-lib.ts`);
	const builtin = makeAsm(name, info.init, name, -1);
	if (!builtin)
		throw new Error(`towasm: internal: inline asm '${name}' failed to resolve`);
	return builtin;
}

// Every entry is a real callable (a plain lib function hands back its own `FunctionDecl`, see `emitCall`).
// `Math.abs`/`Array.alloc`/etc aren't here -- registered into each owner's own `inlineMethods` instead (`builtinOwner`).
const builtins: Record<string, Builtin> = {
	// Unary `-` on `bigint` throws (no `BigInt.neg` method exists yet, unsigned-only). `i32`/`i64`'s own
	// `inline` here is unused -- `emitExpr`'s `'unary'` case special-cases integer `-` as a real `0 - operand` via `swapOut` (a trailing `[const(0), sub]` would wrongly compute `operand - 0`); `f64.neg` is unaffected.
	'prefix-':	args => arithInline1(args, [I.f64.neg], [], []),
	'prefix+':	() => ({params: ['f64'], result: 'f64', inline: []}),
	'prefix!':	() => ({params: ['i32'], result: 'i32', inline: [I.i32.eqz]}),
	'prefix~':	() => ({params: ['i32'], result: 'i32', inline: [I.i32.const(-1), I.i32.xor]}),

	// `+`'s own dispatch, not `arithInline` directly -- `bigint`/`string` operands delegate to their own
	// `add`/`concat` method via `args[0].owner`, the same owner-vs-name-check split `equalityInline` uses.
	'+':	args => arithInline(args, [I.f64.add], [I.i32.add], [I.i64.add], false),
	'-':	args => arithInline(args, [I.f64.sub], [I.i32.sub], [I.i64.sub], false),
	'*':	args => arithInline(args, [I.f64.mul], [I.i32.mul], [I.i64.mul], false),
	// Not `arithInline` -- `i32.div_s` is flatly wrong for JS `number` division (truncating, traps on zero
	// instead of `NaN`/`Infinity`). `number` division is always float division.
	'/':	() => ({ params: ['f64', 'f64'], result: 'f64', inline: [I.f64.div] }),
	// Not `arithInline` -- `__towasm_mod` is itself a `$T`-generic asm builtin, dispatching i32/i64's native
	// `rem_s` vs float's long-hand `x - trunc(x/y)*y` internally, so it needs no per-kind arrays here.
	'%':	libAsmBuiltin('__towasm_mod'),
	'<':	args => arithInline(args, [I.f64.lt], [I.i32.lt_s], [I.i64.lt_s], true),
	'>':	args => arithInline(args, [I.f64.gt], [I.i32.gt_s], [I.i64.gt_s], true),
	'<=':	args => arithInline(args, [I.f64.le], [I.i32.le_s], [I.i64.le_s], true),
	'>=':	args => arithInline(args, [I.f64.ge], [I.i32.ge_s], [I.i64.ge_s], true),

	// Bitwise/shift -- always `i32,i32`, same reasoning. Shift amounts don't need masking mod 32
	// separately -- wasm's own `shl`/`shr_s`/`shr_u` already do that per spec.
	'&':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [I.i32.and]}),
	'|':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [I.i32.or]}),
	'^':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [I.i32.xor]}),
	'<<':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [I.i32.shl]}),
	'>>':	() => ({params: ['i32', 'i32'], result: 'i32', inline: [I.i32.shr_s]}),
	// `result: 'u32'`, not `'i32'` -- `>>>` is the one JS bitwise op whose result is unsigned by spec
	// (`ToUint32`, never `ToInt32`), so it needs `convert_i32_u` if it's ever widened to `f64`.
	'>>>':	() => ({params: ['i32', 'i32'], result: 'u32', inline: [I.i32.shr_u]}),

	'===':	args => equalityInline(args, false),
	'==':	args => equalityInline(args, false),
	'!==':	args => equalityInline(args, true),
	'!=':	args => equalityInline(args, true),

	...Object.fromEntries(LIB_DECLS.filter(d => d.type === 'function_decl').filter(d => d.body).map(d => [d.name, () => d])),
	...Object.fromEntries(LIB_DECLS.filter(d => d.type === 'var_decl').map(d => {
		const name = d.name as string;
		if (isAsm(d.init)) {
			const builtin = makeAsm(name, d.init, name, -1);
			return builtin && [name, builtin] as const;
		}
	}).filter(e => !!e)),
};

interface AssignTarget { wtype: WasmType; old?: number; write(tee: boolean): number }

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
function collectRangeWidenings(body: Statement[], scope: Scope): Map<JS.Var<Type>, Type> {
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

// Builds the `Scope` holding every lib declaration `TStoWasm` needs (`String`, `RegExpMatch`, ...),
// rooted in a fresh `T.makeGlobal()`, not in any particular user program's own scope -- callers pass
// the *same* returned `Scope` to both `TStypeCheck`/`TStypeCheckAsync` (as `libScope`, so user code is
// checked with lib members already in view -- a scope only sees its own ancestors, so a user program's
// `global` needs the lib scope as an actual ancestor, not a sibling branch) and `TStoWasm` (which needs
// it directly too, e.g. to compile a lib method's own body in isolation from user-declared names).
// A throwaway `makeChecker` instance here is fine -- `Scope` is plain data, not tied to whichever
// checker instance populated it, so this result is equally usable by any later, separate instance.
// Muted, deliberately -- tried unmuted once (its diag sink is already a no-op, so muting itself buys
// nothing directly): that DOES fix `checker.scopeOfStmt` for a declared-return-type lib method's body
// (`checkFunctionBody`'s `if (expected && muted) return;` otherwise skips the walk that would stamp it,
// found via `String.split`'s `m.groupStart(0)` resolving to `any` post-narrowing instead of `number`) --
// but it simultaneously breaks every GENERIC lib class method (`Array<T>.reverse`/`.fill`/...): the stamp
// it leaves is the template's own, with `T` still unresolved, and `??=` first-wins then blocks the real,
// per-instantiation substituted scope from ever overriding it (`ctx.scope`, built fresh per monomorphized
// instantiation, used to be the *only* thing var_decl's codegen ever saw here, precisely because muted
// left the template unstamped). No fix found yet that satisfies both narrowing-dependent AND
// generic-instantiation-dependent lib bodies through the same stamp -- reverted to muted, keeping
// `ctx.scope` as the sole (unnarrowed but instantiation-correct) fallback var_decl's codegen relies on
// for lib method bodies. `methodOwner`'s special-case in `var_decl` (below) still needed for this reason.
export function makeLibScope(): Scope {
	const libScope = new Scope(T.makeGlobal());
	checkBlock(LIB_AST, libScope);
	return libScope;
}

export function TStoWasm(ast: TS.Program): wasm.WasmModule {
	const global = ast.scope as Scope;
	if (!global)
		throw new Error('towasm: ast must be checked (TStypeCheck/TStypeCheckAsync) before TStoWasm');

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
	const resolving			= new Set<string>();			// Classes currently mid-`ensureClass`

	const funcs				= new Map<string, FuncInfo>();
	const functionDeclByName = new Map<string, FunctionDecl>();
	let nextFunc			= 0;

	const worklist:			(()=>void)[] = [];
	const lateWorklist: 	(()=>void)[] = [];
	const anyDispatchFuncs	= new Map<string, FuncInfo>();

	const closureLiterals: FuncInfo[] = [];
	const closureWasmTypes	= new Map<string, WasmType>();	// The `{closure: FuncSig}` wrapper object itself, memoized per signature
	const closureTypes		= new Map<string, ClosureTypeInfo>();
	let closureCallTempCounter	= 0;

	let data				= new Uint8Array(0);
	const strings			= new Map<string, number>;

	type Global = Local & {init: Expr, mut: boolean}
	const globals			= new Map<string, Global>;
	// Real declared initializer, and whether it's a `const` (vs `let`), per global (by name), consumed
	// once at the very end to build `mod.globals`'s own `init`/`mut` -- see `constGlobalInit`. Keyed
	// separately from `globals` since `Local` (locals and globals share that shape) has no notion of
	// an initializer or of `const`-ness at all.
	//const globalInits		= new Map<string, Expr>();
	//const globalMut			= new Map<string, boolean>();

	let forTempCounter			= 0;
	let destructureTempCounter	= 0;
	let optionalTempCounter 	= 0;
	let switchTempCounter		= 0;

	// `func`/`array` are structurally deduped 
	// `struct` needs to maintain distinctness for `ref.test`-based dispatch
	const types: wasm.SubType[] = [];
	const typeMap = new Map<string, number>();
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

	function ensureArrayType(kind: wasmElement): number {
		return registerType({ final: true, supertypes: [], type: { kind: 'array', field: { type: kind === 'ref' ? { ref: 'any', nullable: true } : kind === 'i8' ? 'i8' : kind === 'u32' ? 'i32' : kind as NumericType, mut: true } } });
	}
	function ensureBoxType(kind: 'f64' | 'i32'): number {
		return registerType({ final: true, supertypes: [], type: { kind: 'struct', fields: [{ type: kind, mut: false }] } });
	}
	function nullableWtype(base: WasmType): WasmType {
		if (typeof base !== 'string')
			return { ...base, nullable: true };
		if (base !== 'f64' && base !== 'i32')
			throw new Error(`towasm: a nullable '${base}'-kind value is not supported -- only 'number'/'boolean' can be null-boxed`);
		return { typeIndex: ensureBoxType(base), nullable: true, primKind: base };
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


	// Resolves a possibly-generic class `ref` (`Foo<X>`, `Array<X>`, ...) to its monomorphized `ClassInfo`,
	// shared by `typeOf`/`ownerFor`. `t` must be the original unresolved `ref` node -- `T.resolve`'s expanded form discards the class name entirely.
	function resolveGenericClassRef(t: Type): ClassInfo | undefined {
		if (t.type === 'ref' && t.typeArgs?.length) {
			const decl = LIB_DECL_MAP.get(t.name) ?? userGenericClassDecls.get(t.name);
			if (decl?.type === 'class_decl' && decl.typeParams?.length)
				return ensureClass(t.name, t.typeArgs);
		}
		return undefined;
	}

	function typeOf(t: Type): WasmType | undefined {
		const generic = resolveGenericClassRef(t);
		if (generic)
			return ownerThisType(generic);
		const resolved = T.resolve(global, t);
		if (resolved.type === 'union') {
			const nonNullish = resolved.types.filter(m => !T.isNullish(m, global));
			if (nonNullish.length < resolved.types.length && nonNullish.length > 0) {
				const base = typeOf(nonNullish.length === 1 ? nonNullish[0] : TS.UnionType(nonNullish));
				if (!base)
					return undefined;
				return nullableWtype(base);
			}
		}
		if (resolved.type === 'function')
			return closureFuncSigType(resolved);
		// An already-cached class (any ref resolves here once seen, generic or not -- `String` is non-generic
		// so it only ever goes through this path). Same `ownerThisType` delegation as the generic branch above -- an array-backed class's real `WasmType` is `{arr:kind}`, not the generic `{ref:name}`.
		if (t.type === 'ref') {
			const cls = ensureClass(t.name);
			if (cls)
				return ownerThisType(cls);
		}
		return wasmTypeOf(t, global);
	}

	// Builds (and memoizes) the `{closure: FuncSig}` `WasmType` for a TS function type
	function closureFuncSigType(t: TS.FunctionType): WasmType {
		if (t.typeParams?.length)
			throw new Error('towasm: a generic function type is not supported');
		const params = t.params.map(p => {
			if (p.default)
				throw new Error(`towasm: function type parameter '${describeBinding(p.key)}' cannot have a default value`);
			if (p.modifiers?.includes('optional'))
				throw new Error(`towasm: function type parameter '${describeBinding(p.key)}' cannot be optional`);
			const wt = p.typeAnnotation && typeOf(p.typeAnnotation);
			if (!wt || wt === 'void')
				throw new Error(`towasm: function type parameter '${describeBinding(p.key)}' needs an explicit number/boolean/object type`);
			return wt;
		});
		if (t.rest?.typeAnnotation) {
			const wt = typeOf(t.rest.typeAnnotation);
			if (!wt || wt === 'void')
				throw new Error("towasm: a function type's rest parameter needs an explicit array type");
			params.push(wt);
		}
		const result = t.returnType ? typeOf(t.returnType) : 'void';
		if (!result)
			throw new Error('towasm: a function type has an unsupported return type');
		// `hasRest` folded into the memoization key too -- see `funcSigEq`'s own comment on why it's part
		// of a closure's real type identity, not just incidental metadata.
		const key = `(${params.map(wasmTypeKey).join(',')})=>${wasmTypeKey(result)}${t.rest ? '...' : ''}`;
		let wt = closureWasmTypes.get(key);
		if (!wt)
			closureWasmTypes.set(key, wt = { closure: { params, result, hasRest: !!t.rest } });
		return wt;
	}

	// `this`'s `WasmType`. A real `ClassInfo` carries its own already-resolved `thisWtype` directly (never
	// guessed from its name); a builtin (non-class) owner has no such field, so it derives one from `thisTsType`.
	function ownerThisType(owner: MethodOwner): WasmType {
		const wt = 'fields' in owner ? (owner as ClassInfo).thisWtype ?? { ref: owner.name } : typeOf(owner.thisTsType);
		if (!wt)
			throw new Error(`towasm: internal: '${owner.name}' has no representable this-type`);
		return wt;
	}

	// The `WasmType` a value expression resolves to -- `classOf`/`arrayKindOf` below are thin discriminating views over this one (previously identical) checker walk.
	// `unwrapAs`: see that function's own comment -- the checker's `typeOf` must see the real (post-`as`) expression, not the asserted one.
	function wtypeOf(e: Expr, ctx: FuncCtx): WasmType | undefined {
		return typeOf(checkerTypeOf(unwrapAs(e), ctx.scope));
	}

	// The class a value expression resolves to, or `undefined`. Goes through `ownerOf` (the checker type,
	// not `wtypeOf`'s collapsed `WasmType`) since an array-backed class's `WasmType` is `{arr:kind}`, not `{ref:name}` -- reverse-mapping a `WasmType` back to "which class" is the anti-pattern `ownerFor` avoids.
	function classOf(e: Expr, ctx: FuncCtx): ClassInfo | undefined {
		const owner = ownerOf(e, ctx);
		return owner && 'fields' in owner ? owner as ClassInfo : undefined;
	}

	// `cls.name`'s own `get(i)`/`set(i,v)` -- real index syntax dispatched generically to any class using
	// this convention (typed-array views are just one user of it), whether inline-asm or a plain declared method.
	function methodSig(cls: ClassInfo, name: string, ctx: FuncCtx): { params: WasmType[]; result: WasmType } | undefined {
		const inline = cls.inlineMethods?.get(name);
		if (inline) {
			const b = inline([], ctx);
			return { params: b.params, result: b.result };
		}
		return ensureMethod(cls, name, [], ctx);
	}

	// The array-kind (`{arr}`) a value expression resolves to, or `undefined` if it isn't one.
	function arrayKindOf(e: Expr, ctx: FuncCtx): wasmElement | undefined {
		const wt = wtypeOf(e, ctx);
		return wt && typeof wt !== 'string' && 'arr' in wt ? wt.arr : undefined;
	}

	// The `WasmType`/`MethodOwner` a builtin-operator operand resolves to -- `wtypeOf`/`ownerOf` alone can't see an indexed read's element kind, so `arithInline`/etc would silently fall back to `f64`.
	function operandInfo(e: Expr, ctx: FuncCtx): OperandInfo {
		if (e.type === 'index') {
			// A real element type (a class/string/etc, not just `f64`/`i32`/`u32`) resolves through the
			// checker, and must go through `ownerFor` here (not the undefined-owner fast paths below) since owner-sensitive operators (`+` on `string`, bigint identity checks) need the real owner to dispatch.
			const t = checkerTypeOf(unwrapAs(e), ctx.scope);
			if (!T.isAny(t))
				return { wtype: typeOf(t), owner: ownerFor(t) };
			// Only reached when the checker genuinely can't resolve an element type (typed-array-style
			// classes probed via `get(i)`, which the checker gives `any`) -- probed the same empty-args way `makeAsmBuiltin` does, since `get` is always fixed (non-`$T`), independent of its (nonexistent) arguments.
			const getInline = classOf(e.object, ctx)?.inlineMethods?.get('get');
			if (getInline)
				return { wtype: getInline([], ctx).result, owner: undefined };
			const kind = arrayKindOf(e.object, ctx);
			if (kind === 'f64' || kind === 'i32' || kind === 'u32')
				return { wtype: kind, owner: undefined };
		}
		const t = checkerTypeOf(unwrapAs(e), ctx.scope);
		return { wtype: typeOf(t), owner: ownerFor(t) };
	}

	// The `MethodOwner` a static `Type` dispatches method calls against -- derived directly from the `Type` itself, never by reverse-decoding an already-collapsed `WasmType`
	function ownerFor(t: Type): ClassInfo | undefined {
		// Same fast path `wasmTypeOf` needs, for the same reason -- a hoisted `builtinTypes` name would
		// otherwise fully expand via its own `declScope` before reaching the `w.type === 'ref'` check below.
		if (t.type === 'ref' && !t.typeArgs && t.name in builtinTypes)
			return builtinTypeOwner(t.name);
		const generic = resolveGenericClassRef(t);
		if (generic)
			return generic;
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
		if (t.type === 'ref') {
			const direct = ensureClass(t.name, t.typeArgs);
			if (direct)
				return direct;
		}
		const w = T.widenLiterals(T.resolve(global, t));
		// `obj?.method(...)`'s receiver is nullable by construction -- strip `null`/`undefined` before
		// dispatching; there's no "owner of `null`", only "owner of the non-nullish part `?.` already guarded".
		if (w.type === 'union') {
			const nonNullish = T.nonNullable(w, global);
			return nonNullish !== w ? ownerFor(nonNullish) : undefined;
		}
		// `T[]`/`Array<T>`/`ReadonlyArray<T>` all resolve to `Array`'s own methods -- `ReadonlyArray` has no
		// separate lib declaration, it's a checker-only "readonly view" of the same structural shape.
		if (w.type === 'array')
			return ensureClass('Array', [w.element]);
		if (w.type === 'ref') {
			switch (w.name) {
				case 'Array':
				case 'ReadonlyArray':
					return ensureClass('Array', w.typeArgs);
			}
			// A plain lib class (or alias -- `resolveClassAlias`) not yet reached through the raw-`t.name`
			// `ensureClass` try above -- e.g. a param typed `Uint8Array` with no earlier `new Uint8Array(...)`
			// call in this compile to have lazily populated `classes` already. Safe to call unconditionally: `ensureClass` returns
			// `undefined`, no throw, for a name that's neither. `w.typeArgs` (not just `w.name`) -- now that
			// `global` sees lib type aliases too, `T.resolve` can already expand a bare alias name like
			// `Uint8Array` into its real generic form (`TypedArray<u8>`) by this point, and a generic class
			// needs its type arguments to resolve at all, same as the `Array`/`ReadonlyArray` case just above.
			return builtinTypeOwner(w.name) ?? ensureClass(w.name, w.typeArgs);
		}
		return undefined;
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
	function namespaceOwner(name: string, ctx: FuncCtx) {
		// A self-referential call site (`X.method()`) can match either name a class goes by: a generic
		// instantiation's `name` is the composite cache key while `decl.name` stays plain `Array`; a typed-array alias's `decl.name` stays canonical `Uint8Array` while `name` is the real alias, e.g. `Int32Array`.
		return builtinTypeOwner(name) ?? (ctx.owner && (ctx.owner.decl.name === name || ctx.owner.name === name) ? ctx.owner : undefined)
			?? ensureClass(name, staticTypeArgsFor(name));
	}

	// Field access stays `classOf`-only (arrays/scalars have no fields), but method-call dispatch is
	// otherwise identical across real classes, array kinds, and scalar box kinds -- all handled by `ownerFor` above.
	function ownerOf(e: Expr, ctx: FuncCtx) {
		return ownerFor(checkerTypeOf(unwrapAs(e), ctx.scope));
	}

	// Populated by the "index space" pass below, before any body is built -- a class ref's `WasmType`
	// only carries its *name*, but the binary format needs the struct's numeric type index.
	function toValType(w: WasmType): wasm.ValType {
		if (w === 'void')
			throw new Error('towasm: internal: void has no value representation');
		if (w === 'u32')
			return 'i32';
		if (typeof w === 'string')
			return w;
		if ('ref' in w) {
			// `any` is wasm's own abstract heap type (a real string, not a type-section index) -- a real
			// local declared `{ref:'any'}` needs this to resolve directly, not have `ensureClass` treat "any" as an unknown user class name.
			if (w.ref === 'any')
				return { ref: 'any', nullable: !!w.nullable };
			// Lazy like every other class use -- a not-yet-reached class still needs a real `typeIndex` now, not the stale `-1` `classes` seeded it with.
			const cls = ensureClass(w.ref);
			if (!cls)
				throw new Error(`towasm: internal: unresolved class '${w.ref}'`);
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
			throw new Error('towasm: internal: expected a reference type');
		return vt.ref;
	}

	// ===================================================================
	//  Expression lowering -- every case leaves exactly one value on the stack
	// ===================================================================

	function emitStringConst(s: string, ctx: FuncCtx): void {
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

	function coerceTop(got: WasmType, ctx: FuncCtx, want: WasmType): void {
		if (wasmTypeEq(got, want))
			return;

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
			}
		}

		if (got === 'f64') {
			switch (want) {
				case 'i32':
				case 'u32': ctx.emit(I.i64.trunc_sat_f64_s, I.i32.wrap_i64); return;
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
		if (wasmTypeEq(want, ARR_WTYPE.u32)) {
			const array = I.array(ensureArrayType('u32'));

			switch (got) {
				case 'i32': case 'u32':
					ctx.emit(array.new(1));
					return;
				case 'i64': {
					const tmp64 = ctx.local('$tmp64', 'i64');
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
				case 'f64': {
					const tmp64 = ctx.local('$tmp64', 'i64');
					const exp = ctx.local('$exp', 'i32');
					const arr = ctx.local('$exp', {arr: 'u32'});
					ctx.emit(I.local.tee(tmp64));
					// get exponent
					ctx.emit(I.i64.reinterpret_f64, I.i64(53), I.i64.shr_u, I.i32.wrap_i64, I.i32(0x7ff), I.i32.and, I.i32(1023), I.i32.add, I.local.tee(exp));
					ctx.emit(array.new([I.i32(5), I.i32.shr_s]), I.local.set(arr));
					ctx.emit(array.set(I.local.get(arr), 0, [I.local.get(tmp64), I.i64.const(0xffffffffn), I.i64.and, I.i32.wrap_i64]));
					break;
				}

			}
		}
		throw new Error(`towasm: internal: cannot convert ${JSON.stringify(got)} to ${JSON.stringify(want)}`);
	}

	function emitAs(e: Expr, ctx: FuncCtx, want: WasmType): void {
		// `null`/`undefined` alone (`emitExpr` has no target type to pick a heap type from) -- only legal into a nullable slot, same restriction `typeOf`'s union handling already enforces.
		if (isNullLiteral(e)) {
			if (typeof want === 'string' || !want.nullable)
				throw new Error("towasm: 'null'/'undefined' is only supported where a nullable object type (class/array/string) is expected");
			ctx.emit(I.ref.null(heapTypeIndexOf(want)));
			return;
		}
		const got = emitExpr(e, ctx, want);
		// Boxing into `any`: `i32` is this compiler's physical representation for *both* a real `boolean` and
		// a compact-integer `number` -- by the time a bare `'i32'` reaches `coerceTop` that distinction is gone, so it always picked the boolean box. Disambiguated here via the checker's own real type for `e`.
		if (got === 'i32' && typeof want !== 'string' && 'ref' in want && want.ref === 'any' && ownerFor(checkerTypeOf(unwrapAs(e), ctx.scope))?.name !== 'Boolean') {
			coerceTop('i32', ctx, 'f64');
			coerceTop('f64', ctx, want);
			return;
		}
		coerceTop(got, ctx, want);
	}

	function emitTruthy(e: Expr, ctx: FuncCtx): void {
		let got = emitExpr(e, ctx);
		// A boxed nullable primitive (`number | null`/`boolean | null`) has no truthiness of its own --
		// unbox it first (same unconditional-narrowing contract `coerceTop` uses everywhere else), then
		// test the underlying scalar. A genuinely-null value traps here, same as any other unguarded use.
		const box = unboxedPrimitive(got);
		if (box) {
			coerceTop(got, ctx, box.kind);
			got = box.kind;
		}
		switch (got) {
			case 'i32': return;
			case 'f64': ctx.emit(I.f64.const(0), I.f64.ne); return;
			case 'f32': ctx.emit(I.f32.const(0), I.f32.ne); return;
			case 'i64': ctx.emit(I.i64.const(0n), I.i64.ne); return;
			default: throw new Error('towasm: this value cannot be used as a boolean condition');
		}
	}

	// Shared by every optional (`?.`) lowering -- `objectExpr` must only ever be evaluated once, so this
	// materializes it into a scratch local up front and hands that off to `emitOptionalGuard`.
	function emitOptionalAccess(ctx: FuncCtx, objWtype: WasmType, resultWtype: WasmType, readCore: (objLocal: number) => void): WasmType {
		const objLocal = ctx.local(`$opt$obj$${optionalTempCounter++}`, objWtype);
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
	function emitDefaultValue(want: WasmType, ctx: FuncCtx): void {
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
		}
		throw new Error("towasm: an array literal hole needs a nullable or scalar element type");
	}

	// Shared by array literals and `new Uint8Array([...])` -- both coerce every plain element to `want`,
	// a hole (`emitDefaultValue`, above) included. A spread element forces the slower
	// `emitArrayElementsWithSpread` path (runtime length, not `array.new_fixed`'s compile-time count).
	function emitArrayElements(elements: readonly (Expr | undefined)[], ctx: FuncCtx, want: WasmType, kind: wasmElement, typeIndex: number): void {
		if (elements.some(el => el?.type === 'spread')) {
			// A `[...]` array literal with at least one spread element. Every element is evaluated exactly once, in
			// source order, into a scratch local before anything is allocated (side effects must not run twice). The real array is then `array.new_default`-allocated to the true runtime total and filled in a second pass.
			type Part = { spread: false; value: number } | { spread: true; src: number; len: number };
			const parts: Part[] = [];

			elements.forEach((el, i) => {
				if (!el) {
					emitDefaultValue(want, ctx);
					const value = ctx.local(`$spread$elem$${i}`, want);
					ctx.emit(I.local.set(value));
					parts.push({ spread: false, value });
					return;
				}
				if (el.type === 'spread') {
					const srcKind = arrayKindOf(el.operand, ctx);
					if (srcKind !== kind)
						throw new Error('towasm: a spread element in an array literal must be an array of the same element type');
					emitAs(el.operand, ctx, ARR_WTYPE[srcKind]);
					const src = ctx.local(`$spread$src$${i}`, ARR_WTYPE[srcKind]);
					const len = ctx.local(`$spread$len$${i}`, 'i32');
					ctx.emit(I.local.set(src), I.local.get(src), I.array.len, I.local.set(len));
					parts.push({ spread: true, src, len });
				} else {
					emitAs(el, ctx, want);
					const value = ctx.local(`$spread$elem$${i}`, want);
					ctx.emit(I.local.set(value));
					parts.push({ spread: false, value });
				}
			});

			ctx.emit(I.i32.const(parts.filter(p => !p.spread).length));
			for (const p of parts) {
				if (p.spread)
					ctx.emit(I.local.get(p.len), I.i32.add);
			}
			const dst		= ctx.local('$spread$dst', ARR_WTYPE[kind]);
			const offset	= ctx.local('$spread$offset', 'i32');
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
						I.array.set(typeIndex),
						I.local.get(offset), I.i32.const(1), I.i32.add, I.local.set(offset)
					);
				}
			}
			ctx.emit(I.local.get(dst));

		} else {
			for (const el of elements) {
				if (el)
					emitAs(el, ctx, want);
				else
					emitDefaultValue(want, ctx);
			}
			ctx.emit(I.array.new_fixed(typeIndex, elements.length));
		}
	}

	function emitInline(name: string, inline: Inline, args: Expr[], ctx: FuncCtx): WasmType {
		if (args.length !== inline.params.length)
			throw new Error(`towasm: '${name}' takes exactly ${inline.params.length} argument(s)`);
		args.forEach((a, i) => emitAs(a, ctx, inline.params[i]));
		ctx.emit(...inline.inline);
		return inline.result;
	}

	// Fills in trailing arguments a call site omitted, from each missing param's own literal default
	function fillDefaultArgs(label: string, params: WasmType[], defaults: (Expr | undefined)[] | undefined, args: Expr[]): Expr[] {
		if (args.length === params.length)
			return args;
		if (args.length > params.length || !defaults)
			throw new Error(`towasm: '${label}' takes exactly ${params.length} argument(s)`);
		const missing = defaults.slice(args.length);
		if (missing.some(d => !d))
			throw new Error(`towasm: '${label}' takes exactly ${params.length} argument(s)`);
		return [...args, ...missing as Expr[]];
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
	function emitCallArgs(label: string, params: WasmType[], defaults: (Expr | undefined)[] | undefined, hasRest: boolean, args: Expr[], ctx: FuncCtx): void {
		if (!hasRest) {
			if (args.some(a => a.type === 'spread'))
				throw new Error(`towasm: '${label}' takes no rest parameter -- a spread argument has nowhere to expand into`);
			fillDefaultArgs(label, params, defaults, args).forEach((a, i) => emitAs(a, ctx, params[i]));
			return;
		}
		const fixedCount = params.length - 1;
		if (args.length < fixedCount)
			throw new Error(`towasm: '${label}' needs at least ${fixedCount} argument(s)`);
		const fixedArgs = args.slice(0, fixedCount);
		if (fixedArgs.some(a => a.type === 'spread'))
			throw new Error(`towasm: '${label}': a spread argument can only appear among the trailing rest arguments -- its length isn't known at compile time, so it can't fill a fixed parameter position`);
		fixedArgs.forEach((a, i) => emitAs(a, ctx, params[i]));
		const restArrWtype = params[fixedCount];
		if (typeof restArrWtype === 'string' || !('arr' in restArrWtype))
			throw new Error(`towasm: internal: '${label}' rest param has a non-array type`);
		const kind = restArrWtype.arr;
		if (kind === 'i16' || kind === 'i8')
			throw new Error(`towasm: '${label}' rest param: a 'string[]'/packed-byte-array element is not supported`);
		emitArrayElements(args.slice(fixedCount), ctx, kind === 'ref' ? REF_ANY_NULLABLE : kind, kind, ensureArrayType(kind));
	}

	// Dispatches every `builtins` entry, coercing args via `emitAs`; falls back to `ensureFunc` for a plain user-declared function not in `builtins` at all.
	// `typeArgs`: only ever meaningful for a plain user-declared generic function (`builtins` entries and
	// host imports are never generic) -- an explicit `identity<number>(5)` call-site type argument list, or
	// `undefined` when left implicit (the common case, inferred by `ensureGenericFunc`).
	function emitCall(name: string, args: Expr[], ctx: FuncCtx, typeArgs?: Type[]): WasmType {
		let decl;
		const builtin = builtins[name];
		if (builtin) {
			const result = builtin(args.map(a => operandInfo(a, ctx)), ctx);
			if ('inline' in result)
				return emitInline(name, result, args, ctx);
			// Only a binary operator's own `builtins` entry can resolve to a `MethodDelegate` -- a bare call
			// has no receiver, so getting one here is an internal inconsistency, not a user error.
			if ('owner' in result)
				throw new Error(`towasm: internal: '${name}' resolved to a method delegate outside operator dispatch`);

			decl = result;
		} else {
			decl = functionDeclByName.get(name);
			// A pre-seeded host import (`LIB_HOST_IMPORTS`) has no `FunctionDecl` to compile a body from -- a missing `decl` is only a real error when `funcs` doesn't already know the name either.
			if (!decl && !funcs.has(name))
				throw new Error(`towasm: call to unknown function '${name}'`);
		}

		const info = decl?.typeParams?.length ? ensureGenericFunc(name, decl, args, typeArgs, ctx)
			: funcs.get(name) ?? compileFunc(name, decl!);
		if (!info)
			throw new Error(`towasm: call to unknown function '${name}'`);
		emitCallArgs(name, info.params, info.defaults, !!info.hasRest, args, ctx);
		ctx.emit(I.call(info.funcIndex));
		return info.result;
	}

	// Dispatches a `receiver.name(...args)` call against any `MethodOwner` -- `inlineMethods` (checked first) splices its instructions directly into the caller with no `call` at all.
	// `receiver` is `undefined` for a namespace-style call (`Math.sqrt(x)`, `Array.alloc(n)` from inside `Array<T>`'s own methods) -- no real value to push, just a bare name used to look up `owner`.
	// `typeArgs`: an explicit `obj.method<T>(...)` call-site type argument list -- only ever meaningful for
	// a real user method call (an inline/accessor/index/operator dispatch is never independently generic).
	// `bypassVirtual`: set only by `super.method(...)`'s own call site -- by definition never virtual (see
	// that call site's own comment), regardless of whether `owner` has overriding subclasses elsewhere.
	function emitMethodCall(owner: ClassInfo, name: string, args: Expr[], ctx: FuncCtx, typeArgs?: Type[], bypassVirtual?: boolean): WasmType {
		const inline = owner.inlineMethods?.get(name);
		if (inline) {
			if (args.some(a => a.type === 'spread'))
				throw new Error('towasm: spread call arguments are not supported');
			return emitInline(name, inline(args.map(a => operandInfo(a, ctx)), ctx), args, ctx);
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
				emitCallArgs(name, sig.params, undefined, !!sig.hasRest, args, ctx);
				ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
				return sig.result;
			}
			throw new Error(`towasm: unknown method '${name}' on ${owner.name}`);
		}
		// A spread argument is only meaningful bundled into a rest param (`arr.push(...other)`) --
		// `emitCallArgs` validates and handles that itself.
		emitCallArgs(name, method.params, method.defaults, !!method.hasRest, args, ctx);
		ctx.emit(I.call(method.funcIndex));
		return method.result;
	}

	function captureOld(ctx: FuncCtx, wtype: WasmType, old: 'none' | 'discard' | 'keep', readCore: () => void): number | undefined {
		let savedOld: number | undefined;
		if (old !== 'none') {
			readCore();
			if (old === 'keep') {
				savedOld = ctx.local(scratchName('$old', wtype), wtype);
				ctx.emit(I.local.tee(savedOld));
			}
		}
		return savedOld;
	}
	function makeWrite(ctx: FuncCtx, wtype: WasmType, storeCore: (val: number) => void): (tee: boolean) => number {
		return tee => {
			const val = ctx.local(scratchName('$new', wtype), wtype);
			ctx.emit(I.local.set(val));
			storeCore(val);
			if (tee)
				ctx.emit(I.local.get(val));
			return val;
		};
	}

	// Two questions: whether the current value needs reading at all (`'none'`, only a plain `=` skips it),
	// and whether it needs preserving for `.old` (`'keep'`, only postfix `++`/`--`) or just combining once (`'discard'`, every compound op and prefix `++`/`--`) -- `'discard'` skips the extra scratch `'keep'` needs.
	function emitAssignTarget(target: Expr, ctx: FuncCtx, old: 'none' | 'discard' | 'keep'): AssignTarget {
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
				return {
					wtype,
					old: captureOld(ctx, wtype, old, () => ctx.emit(I.local.get(envLocal.index), I.struct.get(envTypeIndex, index))),
					write: makeWrite(ctx, wtype, val => ctx.emit(I.local.get(envLocal.index), I.local.get(val), I.struct.set(envTypeIndex, index))),
				};
			}

			let loc = ctx.lookup(name);
			const isGlobal = !loc;
			if (!loc)
				loc = globals.get(name);
			const { wtype, index } = loc!;
			return {
				wtype,
				old: captureOld(ctx, wtype, old, () => ctx.emit(isGlobal ? I.global.get(index) : I.local.get(index))),
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
			const cls = classOf(target.object, ctx);

			// A `set` accessor -- checked before the ordinary struct-field write, mirroring the read side's getter-probe in `case 'member'`
			if (cls?.setterNames?.has(target.property)) {
				const setSig = methodSig(cls, accessorKey('set', target.property), ctx);
				if (!setSig)
					throw new Error(`towasm: internal: setter '${target.property}' has no signature`);
				const wtype = setSig.params[0];
				const valExpr: Expr = { type: 'identifier', name: scratchName('$new', wtype) };

				// `emitAs`, not a raw `emitExpr` -- `target.object` may itself be a ref-kind array element read, boxed `anyref` regardless of its declared class (same reasoning as the plain struct-field write below).
				const objWtype = cls.thisWtype!;
				const obj = ctx.local(scratchName('$obj', objWtype), objWtype);
				emitAs(target.object, ctx, objWtype);
				ctx.emit(I.local.set(obj));
				return {
					wtype,
					old: captureOld(ctx, wtype, old, () => {
						if (!cls.getterNames?.has(target.property))
							throw new Error(`towasm: '${target.property}' has no getter -- its old value can't be read for a compound assignment/'++'/'--'`);
						ctx.emit(I.local.get(obj));
						emitMethodCall(cls, accessorKey('get', target.property), [], ctx);
					}),
					write: makeWrite(ctx, wtype, () => {
						ctx.emit(I.local.get(obj));
						emitMethodCall(cls, accessorKey('set', target.property), [valExpr], ctx);
					}),
				};
			}

			const fieldIdx	= cls?.fieldIndex.get(target.property);
			if (!cls || fieldIdx === undefined)
				throw new Error(`towasm: unknown field '${target.property}'`);

			const wtype = cls.fields[fieldIdx].wtype;

			// `emitAs`, not a raw `emitExpr` -- `target.object` may be a ref-kind array element read, boxed `anyref` -- `struct.set` needs the real narrowed `(ref cls)` first, same as the read-side fix in `case 'member'`.
			const objWtype = cls.thisWtype!;
			const obj = ctx.local(scratchName('$obj', objWtype), objWtype);
			emitAs(target.object, ctx, objWtype);
			ctx.emit(I.local.set(obj));
			return {
				wtype,
				old:	captureOld(ctx, wtype, old, () => ctx.emit(I.local.get(obj), I.struct.get(cls.typeIndex, fieldIdx))),
				write:	makeWrite(ctx, wtype, val => ctx.emit(I.local.get(obj), I.local.get(val), I.struct.set(cls.typeIndex, fieldIdx))),
			};
			
		} else if (target.type == 'index') {
			// Any class with its own `get(i)`/`set(i,v)` (typed-array views, or any other class using the
			// same convention -- see `methodSig`) -- real index syntax dispatched generically, not by name.
			const cls		= classOf(target.object, ctx);
			const getSig 	= cls && methodSig(cls, 'get', ctx);
			if (cls && getSig && methodSig(cls, 'set', ctx)) {
				// `emitAs`, not a raw `emitExpr` -- same reasoning as the plain struct-field write path above.
				const objWtype = cls.thisWtype!;
				const obj = ctx.local(scratchName('$obj', objWtype), objWtype);
				emitAs(target.object, ctx, objWtype);
				ctx.emit(I.local.set(obj));
				emitAs(target.property, ctx, getSig.params[0]);
				const indexName = scratchName('$index', getSig.params[0]);
				ctx.emit(I.local.set(ctx.local(indexName, getSig.params[0])));
				const idxExpr: Expr = { type: 'identifier', name: indexName };
				const wtype = getSig.result;
				const valExpr: Expr = { type: 'identifier', name: scratchName('$new', wtype) };

				return {
					wtype,
					old: captureOld(ctx, wtype, old, () => {
						ctx.emit(I.local.get(obj));
						emitMethodCall(cls, 'get', [idxExpr], ctx);
					}),
					write: makeWrite(ctx, wtype, () => {
						ctx.emit(I.local.get(obj));
						emitMethodCall(cls, 'set', [idxExpr, valExpr], ctx);
					}),
				};
			}

			const kind = arrayKindOf(target.object, ctx);
			// `i16`/`i8` (`string`/packed-byte storage) rejected same as `case 'index'`'s own read side.
			if (!kind || kind === 'i16' || kind === 'i8')
				throw new Error("towasm: this operation is not supported");

			const typeIndex = ensureArrayType(kind);
			// Mirrors `case 'index'`'s own read-side result exactly -- a ref-kind array's write target is a boxed `any`, not a raw i32.
			const wtype		= kind === 'ref' ? REF_ANY_NULLABLE : kind;
			const objWtype	= emitExpr(target.object, ctx);
			const obj		= ctx.local(scratchName('$obj', objWtype), objWtype);
			ctx.emit(I.local.set(obj));
			emitAs(target.property, ctx, 'i32');
			// Always `i32` (an array index, never anything else) -- unlike `$obj`/`$new`/`$old` here, this one genuinely can't collide across two index writes in the same function, no qualification needed.
			const idx		= ctx.local('$index', 'i32');
			ctx.emit(I.local.set(idx));

			return {
				wtype,
				old: captureOld(ctx, wtype, old, () => ctx.emit(I.local.get(obj), I.local.get(idx), I.array.get(typeIndex))),
				// `wtype` -- the value on the stack was already coerced to it by the caller (`emitAssign`'s `emitAs(right, ctx, target.wtype)` or its compound-op equivalent), so no extra conversion belongs here.
				write: makeWrite(ctx, wtype, val => ctx.emit(I.local.get(obj), I.local.get(idx), I.local.get(val), I.array.set(typeIndex))),
			};
		} else {
			throw new Error(`towasm: cannot assign to ${target.type}`);
		}
	}

	// Shared by `case 'arrow'`/`case 'function'` (an expression, `allowSelfCall: false`) and `case
	// 'function_decl'` (a statement nested in another function's body, `allowSelfCall: true`) --
	// builds the `{code, env}` closure struct and leaves it on the stack, returning its `{closure}`
	// wtype. `allowSelfCall` lifts the "can't reference own name" restriction and instead lets calls
	// to `selfName` from inside the body resolve to a direct `call` (see `ctx.selfCall`), since a
	// self-*capture* is impossible -- the struct can't be a field of itself before it exists.
	function emitClosureLiteral(
		e: TS.CallSig & {type: string, name?: string, modifiers?: string[], body?: Statement[] | Expr },
		ctx: FuncCtx,
		allowSelfCall: boolean,
	): WasmType {
		if (hasMod(e, 'async'))
			throw new Error('towasm: an async arrow/function expression is not supported');
		if (hasMod(e, 'generator'))
			throw new Error('towasm: a generator function expression is not supported');
		if (e.typeParams?.length)
			throw new Error('towasm: a generic arrow/function expression is not supported');

		const body	= e.body ?? [];
		if (e.name && !allowSelfCall && walkB(body, undefined, (e, process) => e.type === 'identifier' ? true : process(e)))
			throw new Error(`towasm: a named function expression referencing its own name ('${e.name}') is not supported`);

		const result = e.returnType ? typeOf(e.returnType) : 'void';
		if (!result)
			throw new Error('towasm: closure has an unsupported return type');

		const params = e.params.map((p): ResolvedParam => {
			if (p.default)
				throw new Error(`towasm: closure parameter '${describeBinding(p.key)}' cannot have a default value`);
			if (hasMod(p, 'optional'))
				throw new Error(`towasm: closure parameter '${describeBinding(p.key)}' cannot be optional`);
			const wt = p.typeAnnotation && typeOf(p.typeAnnotation);
			if (!wt || wt === 'void')
				throw new Error(`towasm: closure parameter '${describeBinding(p.key)}' needs an explicit number/boolean/object type`);
			return {key: p.key, wtype: wt, tsType: p.typeAnnotation! };
		});
		if (e.rest?.typeAnnotation) {
			const wt = typeOf(e.rest.typeAnnotation);
			if (!wt || wt === 'void')
				throw new Error("towasm: a closure's rest parameter needs an explicit array type");
			params.push({key: e.rest.key, wtype: wt, tsType: e.rest.typeAnnotation });
		}

		const free = new Set<string>();
		collectFreeVars(ownBoundNames(paramNames(e.params, e.rest), body, e.name), body, free);

		if (e.type !== 'arrow' && free.has('this'))
			throw new Error("towasm: 'this' inside a function expression is not supported -- only an arrow function's lexical 'this' is");

		for (const name of free) {
			if (!ctx.resolvesName(name))
				throw new Error(`towasm: unresolved identifier '${name}'`);
		}

		// This literal's own concrete env struct type -- zero captures just reuses `$envBase`
		// directly (no distinct type, no cast needed in the compiled body either).
		const envBase		= ensureEnvBase();
		const capturedNames = [...free];
		const fields		= capturedNames.length ? new Map<string, { index: number; wtype: WasmType }>() : undefined;
		let envTypeIndex	= envBase;
		if (fields) {
			envTypeIndex = addType({ final: true, supertypes: [envBase], type: { kind: 'struct', fields: capturedNames.map((name, i) => {
				const wt = ctx.resolvedWtype(name)!;
				fields.set(name, { index: i, wtype: wt });
				return { type: toValType(wt), mut: true };
			}) } });
		}

		const sig: FuncSig = { params: params.map(p => p.wtype), result, hasRest: !!e.rest };
		const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
		const { funcIndex, typeIndex }	= registerFuncAtType(funcTypeIndex);
		const info: FuncInfo = { ...sig, funcIndex, typeIndex };
		closureLiterals.push(info);

		worklist.push(() => {
			const fnCtx		= new FuncCtx(new Scope(libGlobal), result, undefined);
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
				fnCtx.selfCall = { name: e.name, ...info };
			for (const name of capturedNames) {
				const tsType = ctx.scope.value(name);
				if (tsType)
					fnCtx.declareCaptured(name, tsType);
			}
			if (Array.isArray(body))
				fnCtx.widenedTypes = collectRangeWidenings(body, fnCtx.scope);
			pending.forEach(st => emitStmt(st, fnCtx));
			if (Array.isArray(body)) {
				body.forEach(st => emitStmt(st, fnCtx));
				emitTrailingUnreachable(fnCtx, result);
			} else {
				emitStmt({ type: 'return', argument: body }, fnCtx);
			}
			info.body = fnCtx.toFuncBody(1 + params.length, toValType);
		});

		// Creation site: `struct.new` pops fields in declaration order (`ensureClosureType`'s `[code,
		// env]`), so the code pointer goes on the stack before the env struct. Each captured value is read via the identifier-read case above, so a capture-of-a-capture resolves like a plain local.
		ctx.emit(I.ref.func(funcIndex));
		for (const name of capturedNames)
			emitExpr(name === 'this' ? { type: 'this' } : { type: 'identifier', name }, ctx);
		ctx.emit(fields ? I.struct.new(envTypeIndex) : I.struct.new_default(envBase));
		ctx.emit(I.struct.new(structTypeIndex));
		return { closure: sig };
	}

	// `want`, when passed, is a hint only -- lets a literal pick its physical representation directly instead
	// of `coerceTop` immediately converting it back. The returned `WasmType` is always the actual physical type left on the stack.
	function emitExpr(e: Expr, ctx: FuncCtx, want?: WasmType): WasmType {
		switch (e.type) {
			case 'literal':
				if (Array.isArray(e.value)) {
					// No interpolation at all -- a template of just `${x}` (one part, `.exp` set) still needs the general path below, not this shortcut.
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
					// The real interpolation count -- not `e.value.length - 1`, which undercounts whenever `hasTrailingLiteral` is false.
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
						const info = funcs.get('stringTemplate') ?? compileFunc('stringTemplate', decl);
						if (info)
							ctx.emit(I.call(info.funcIndex));
					}
					return ARR_WTYPE.i16;
				}
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

					case 'bigint':
						ctx.emit(I.i64.const(e.value));
						return 'i64';

					default:
						throw new Error(`towasm: unsupported literal type '${typeof e.value}'`);
				}

			case 'identifier': {
				// `NaN`/`Infinity` are real globals, not locals -- constant-fold directly rather than
				// routing through `ctx.lookup`, same as `isNullLiteral`'s `undefined` special-case.
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
				// A captured free variable has no real local of its own -- read via `struct.get` off the
				// cast env local instead. Checked before `ctx.lookup`, since it's never also in `ctx.locals`.
				const captured = ctx.closureEnv?.fields.get(name);
				if (captured) {
					ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index), I.struct.get(ctx.closureEnv!.envTypeIndex, captured.index));
					return captured.wtype;
				}
				const local = ctx.lookup(name);
				if (local) {
					ctx.emit(I.local.get(local.index));
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
				throw "unknown";
			}

			case 'member': {
				if (e.object.type === 'identifier') {
					const owner = namespaceOwner(e.object.name, ctx);
					if (owner) {
						const f = owner.decl.body.find(m => m.type === 'field' && m.key === e.property && m.modifiers?.includes('static'));
						if (!f || f.type !== 'field' || !f.value)
							throw new Error(`towasm: unknown static field '${owner.name}.${e.property}'`);
						return emitExpr(f.value, ctx);
					}
				}

				const cls = classOf(e.object, ctx);

				// A `get` accessor -- checked before both the `.length` special case and the ordinary
				// struct-field read, so a real getter (e.g. `Array<T>.length`) takes priority over either.
				if (cls?.getterNames?.has(e.property)) {
					// `isOptionalChainLink`, not a bare `e.optional` -- `a?.b.getter` continues `a?.b`'s own
					// chain even though *this* access has no `?.` of its own written on it (see the checker's
					// own `isOptionalChainLink` comment, shared verbatim). Same restriction either way: a
					// getter can't be guarded in this pass, direct `?.` or chain-continued.
					if (isOptionalChainLink(e))
						throw new Error(`towasm: 'a?.${e.property}' on a getter is not supported`);
					emitAs(e.object, ctx, cls.thisWtype!);
					return emitMethodCall(cls, accessorKey('get', e.property), [], ctx);
				}

				const fieldIdx	= cls?.fieldIndex.get(e.property);
				if (!cls || fieldIdx === undefined)
					throw new Error(`towasm: unknown field '${e.property}'`);
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
						throw new Error(`towasm: 'a?.${e.property}' has an unsupported object type`);
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
				const cls = classOf(e.object, ctx);
				const sig = cls && methodSig(cls, 'get', ctx);
				if (cls && sig) {
					// `isOptionalChainLink`, not a bare `e.optional` -- see `case 'member'`'s own comment.
					if (isOptionalChainLink(e)) {
						if (sig.result === 'void')
							throw new Error("towasm: 'a?.[i]' is not supported -- 'get' returns 'void', which can't become 'void | undefined'");
						const objWtype = wtypeOf(e.object, ctx);
						if (!objWtype)
							throw new Error("towasm: 'a?.[i]' has an unsupported object type");
						emitAs(e.object, ctx, objWtype);
						const resultWtype = nullableWtype(sig.result);
						return emitOptionalAccess(ctx, objWtype, resultWtype, objLocal => {
							// Receiver pushed directly, skipping `emitMethodCall`'s own receiver-push -- needs an
							// explicit `ref.as_non_null` here, always sound since `readCore` only runs in the proven-non-null arm.
							ctx.emit(I.local.get(objLocal), I.ref.as_non_null);
							coerceTop(emitMethodCall(cls, 'get', [e.property], ctx), ctx, resultWtype);
						});
					}
					// `emitAs`, not a raw `emitExpr` -- `e.object` may itself be boxed `anyref` (`a[i][j]`), same reasoning as the field-read cast above.
					emitAs(e.object, ctx, cls.thisWtype!);
					return emitMethodCall(cls, 'get', [e.property], ctx);
				}
				const kind = arrayKindOf(e.object, ctx);
				if (!kind || kind === 'i16' || kind === 'i8')
					throw new Error("towasm: indexing is only supported on number[]/boolean[]/Uint8Array/Int32Array/Uint32Array ('string' is immutable and not indexable in this pass)");
				// `nullable: true` on the 'ref' case -- `ensureArrayType`'s `'ref'`-kind field is declared
				// nullable (shared physical storage for every non-scalar kind), so `array.get` always really
				// produces a nullable `anyref`, whatever the caller's declared TS element type claims.
				const elemWtype: WasmType = kind === 'ref' ? { ref: 'any', nullable: true } : kind;
				// `isOptionalChainLink`, not a bare `e.optional` -- see `case 'member'`'s own comment.
				if (isOptionalChainLink(e)) {
					const objWtype = wtypeOf(e.object, ctx);
					if (!objWtype)
						throw new Error("towasm: 'a?.[i]' has an unsupported object type");
					emitAs(e.object, ctx, objWtype);
					const resultWtype = nullableWtype(elemWtype);
					return emitOptionalAccess(ctx, objWtype, resultWtype, objLocal => {
						ctx.emit(I.local.get(objLocal));
						emitAs(e.property, ctx, 'i32');
						ctx.emit(I.array.get(ensureArrayType(kind)));
						coerceTop(elemWtype, ctx, resultWtype);
					});
				}
				emitAs(e.object, ctx, ARR_WTYPE[kind]);
				emitAs(e.property, ctx, 'i32');
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
			// Narrow support only: `want` must already name a real object-shape type (`ensureObjectShape`,
			// via `ensureClass`'s own fallback chain) -- a plain `type Point = { x: number; y: number };`
			// assigned/passed/returned somewhere a concrete target type is known, never general structural
			// inference (an object literal with no such target, or one whose declared shape doesn't
			// nominally resolve this way, throws below). Fields push in the *shape's own declared order*
			// (`struct.new` needs every field value up front, in that fixed order), not the literal's own
			// written order -- looked up from the literal's properties by name instead.
			case 'object': {
				const owner = typeof want === 'object' && 'ref' in want ? ensureClass(want.ref) : undefined;
				if (!owner)
					throw new Error("towasm: an object literal needs a known target type (e.g. a 'const x: Point = {...}' with a plain 'type Point = {...}' alias) -- not supported here");
				const byKey = new Map<string, Expr>();
				for (const p of e.properties) {
					if (p.type !== 'field' || typeof p.key !== 'string' || !p.value)
						throw new Error(`towasm: object literal for '${owner.name}' can only have plain 'key: value' properties (no methods, spreads, or computed keys)`);
					byKey.set(p.key, p.value);
				}
				for (const f of owner.fields) {
					const propValue = byKey.get(f.name);
					if (!propValue)
						throw new Error(`towasm: object literal for '${owner.name}' is missing property '${f.name}'`);
					emitAs(propValue, ctx, f.wtype);
					byKey.delete(f.name);
				}
				if (byKey.size)
					throw new Error(`towasm: object literal for '${owner.name}' has unknown propert${byKey.size > 1 ? 'ies' : 'y'} '${[...byKey.keys()].join("', '")}'`);
				ctx.emit(I.struct.new(owner.typeIndex));
				return owner.thisWtype!;
			}

			case 'array': {
				// `want`'s own kind wins when `'ref'` (a real `any[]` target) even if every element is
				// naturally scalar (`const values: any[] = [1, 2, 3]`) -- `arrayKindOf` only sees the elements themselves, so it would otherwise build a real `number[]` and fail to widen it to `any[]` afterward.
				const kind = typeof want === 'object' && 'arr' in want && want.arr === 'ref' ? 'ref' : arrayKindOf(e, ctx);
				if (!kind || kind === 'i16' || kind === 'i8')
					throw new Error('towasm: array literals are only supported for number[]/boolean[]/T[]');
				emitArrayElements(e.elements, ctx, kind === 'ref' ? REF_ANY_NULLABLE : kind, kind, ensureArrayType(kind));
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
							throw new Error("towasm: '++'/'--' on a nullable primitive needs narrowing to non-null first, and isn't supported even then");
						throw new Error("towasm: '++'/'--' is only supported on number/boolean-kind locals");
					}

					ctx.emit(I[wtype].const(1), I[wtype][e.operator === '++' ? 'add' : 'sub']);
					if (want === 'void') {
						target.write(false);
						return want;
					}
					target.write(true);
					return wtype;
				}

				const info = operandInfo(e.operand, ctx);
				if (info.owner) {
					const method = UNARY_OP_NAMES[e.operator as keyof typeof UNARY_OP_NAMES];
					if (method && info.owner.methodDecls?.get(method)) {
						emitAs(e.operand, ctx, info.owner.thisWtype!);
						return emitMethodCall(info.owner, method, [], ctx);
					}
				}

				const builtin = builtins['prefix' + e.operator];
				if (builtin) {
					const result = builtin([info], ctx);
					// A `'prefix'`-mangled key can never collide with a real function name -- an internal
					// inconsistency, not a user error, same reasoning as `emitCall`'s `'owner' in` check.
					if ('type' in result || 'owner' in result)
						throw new Error(`towasm: internal: 'prefix${e.operator}' resolved to a ${'type' in result ? 'function' : 'method'} delegate outside its own dispatch`);
					if (e.operator === '-' && (result.params[0] === 'i32' || result.params[0] === 'i64')) {
						const wtype = result.params[0];
						const _old = ctx.swapOut();
						emitAs(e.operand, ctx, wtype);
						const operand = ctx.swapOut(_old);
						if (wtype === 'i32')
							ctx.emit(I.i32.const(0), ...operand, I.i32.sub);
						else
							ctx.emit(I.i64.const(0n), ...operand, I.i64.sub);
						return result.result;
					}
					emitAs(e.operand, ctx, result.params[0]);
					ctx.emit(...result.inline);
					return result.result;
				}
				throw new Error(`towasm: unsupported unary operator '${e.operator}'`);
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
							throw new Error("towasm: '++'/'--' on a nullable primitive needs narrowing to non-null first, and isn't supported even then");
						throw new Error("towasm: '++'/'--' is only supported on number/boolean-kind locals");
					}

					ctx.emit(I[wtype].const(1), I[wtype][e.operator === '++' ? 'add' : 'sub']);
					target.write(false);
					if (want === 'void')
						return want;
					ctx.emit(I.local.get(target.old!));
					return wtype;
				}
				throw new Error(`towasm: unsupported postfix operator '${e.operator}'`);

			case 'binary': {
				const op = e.operator;
				if (ASSIGN_OPS.has(op))
					return emitAssign(e, ctx, want !== 'void');

				switch (op) {
					case '&&': {
						emitTruthy(e.left, ctx);
						const _old = ctx.swapOut();
						emitTruthy(e.right, ctx);
						ctx.emit(I.if('i32', ctx.swapOut(_old), [I.i32.const(0)]));
						return 'i32';
					}
					case '||': {
						emitTruthy(e.left, ctx);
						const _old = ctx.swapOut();
						emitTruthy(e.right, ctx);
						ctx.emit(I.if('i32', [I.i32.const(1)], ctx.swapOut(_old)));
						return 'i32';
					}
					// `a ?? b` -- `a`'s combined-with-`b` type drives the `if`'s result. A left that can never
					// actually be null/undefined makes `b` provably dead code -- same conclusion real TS's
					// own type checker would reach -- so it's evaluated and returned directly, no runtime
					// check at all; `patternBindings` relies on exactly this for a destructuring default on
					// an already-non-nullable value (an ordinary array element, a non-optional object field).
					case '??': {
						const wtype = wtypeOf(e, ctx);
						if (!wtype)
							throw new Error("towasm: '??' has an unsupported result type");
						const leftWtype = wtypeOf(e.left, ctx);
						if (!leftWtype)
							throw new Error("towasm: '??' has an unsupported left-hand type");
						if (typeof leftWtype === 'string' || !leftWtype.nullable) {
							emitAs(e.left, ctx, wtype);
							return wtype;
						}
						emitAs(e.left, ctx, leftWtype);
						const leftLocal = ctx.declareLocal(`$nullish$left$${optionalTempCounter++}`, leftWtype);
						ctx.emit(I.local.set(leftLocal.index));
						ctx.emit(I.local.get(leftLocal.index), I.ref.is_null);
						const _old = ctx.swapOut();
						emitAs(e.right, ctx, wtype);
						const _then = ctx.swapOut();
						ctx.emit(I.local.get(leftLocal.index));
						coerceTop(leftWtype, ctx, wtype);
						ctx.emit(I.if(toValType(wtype), _then, ctx.swapOut(_old)));
						return wtype;
					}
					// `x === null`/`x !== undefined`/etc -- checked ahead of `equalityInline` (picks its comparison
					// kind from the left operand's `WasmType`, and a bare null literal has none). Also the more direct lowering either way: a real `ref.is_null` check, not `ref.eq` against a synthesized null.
					case '===': case '!==': case '==': case '!=': {
						const leftIsNull	= isNullLiteral(e.left);
						const rightIsNull	= isNullLiteral(e.right);
						if (leftIsNull || rightIsNull) {
							const negate = op === '!==' || op === '!=';
							if (leftIsNull && rightIsNull) {
								// `null === null`/`null === undefined` -- always true, no value to check.
								ctx.emit(I.i32.const(negate ? 0 : 1));
								return 'i32';
							}
							const valueExpr	= leftIsNull ? e.right : e.left;
							const wt		= wtypeOf(valueExpr, ctx);
							if (!wt || typeof wt === 'string' || !wt.nullable)
								throw new Error("towasm: comparing to 'null'/'undefined' needs a nullable object-typed value on the other side");
							emitAs(valueExpr, ctx, wt);
							ctx.emit(I.ref.is_null);
							if (negate)
								ctx.emit(I.i32.eqz);
							return 'i32';
						}
						//fallthrough
					}
					default: {
						const leftInfo = operandInfo(e.left, ctx);
						if (leftInfo.owner) {
							const method = BINARY_OP_NAMES[op as keyof typeof BINARY_OP_NAMES];
							if (method && leftInfo.owner.methodDecls?.get(method)) {
								emitAs(e.left, ctx, leftInfo.owner.thisWtype!);
								return emitMethodCall(leftInfo.owner, method, [e.right], ctx);
							}
							const comp = COMPARE_OPS[op as keyof typeof COMPARE_OPS];
							if (comp && leftInfo.owner.methodDecls?.get('compare')) {
								emitAs(e.left, ctx, leftInfo.owner.thisWtype!);
								const w = emitMethodCall(leftInfo.owner, 'compare', [e.right], ctx);
								if (w === 'i32' || w === 'i64') {
									switch (comp) {
										case 'eq': ctx.emit(I[w].eqz); break;
										case 'lt': case 'le': case 'gt': case 'ge': ctx.emit(I[w](0), I[w][`${comp}_s`]); break;
										case 'ne': break;
									}
								} else if (w === 'f64' || w === 'f32') {
									ctx.emit(I[w](0), I[w][comp]);
								}
							}
						}

						const builtin = builtins[op];
						if (!builtin)
							throw new Error(`towasm: unsupported binary operator '${op}'`);
						const inline = builtin([leftInfo, operandInfo(e.right, ctx)], ctx);
						if ('type' in inline)
							throw new Error(`towasm: internal: '${op}' resolved to a function delegate outside its own dispatch`);
						if ('owner' in inline) {
							// `emitAs`, not a raw `emitExpr` -- `e.left` may be a ref-kind array element read, boxed `anyref` -- same reasoning as the method-call receiver casts elsewhere in this file.
							emitAs(e.left, ctx, (inline.owner as ClassInfo).thisWtype!);
							return emitMethodCall(inline.owner, inline.method, [e.right], ctx);
						}
						emitAs(e.left, ctx, inline.params[0]);
						emitAs(e.right, ctx, inline.params[1]);
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
					throw new Error('towasm: conditional expression has an unsupported type');
				emitTruthy(e.test, ctx);
				const _old = ctx.swapOut();
				emitAs(e.consequent, ctx, wtype);
				const _then = ctx.swapOut();
				emitAs(e.alternate, ctx, wtype);
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
				if (e.callee.type !== 'identifier')
					throw new Error(`towasm: 'new' is only supported for a known class`);
				const cls = ensureClass(e.callee.name, e.typeArgs);
				if (!cls)
					throw new Error(`towasm: 'new' is only supported for a known class`);
				const ctor = ensureCtor(cls, e.arguments, ctx);
				emitCallArgs(`${e.callee.name}'s constructor`, ctor.params, ctor.defaults, !!ctor.hasRest, e.arguments, ctx);
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
						throw new Error('towasm: inline asm does not support spread call arguments');
					const owner = ctx.owner;
					const ownerCls = owner && 'fields' in owner ? owner as ClassInfo : undefined;
					const ownerTypeArgs = ownerCls?.thisTsType.type === 'ref' ? ownerCls.thisTsType.typeArgs : undefined;
					const builtin = makeAsm('<inline>', e.callee, owner?.name ?? '<top-level>', owner?.typeIndex ?? -1,
						ownerCls && typeof ownerCls.thisWtype !== 'string' && ownerCls.thisWtype && 'arr' in ownerCls.thisWtype ? ownerCls.thisWtype.arr : undefined,
						ownerTypeArgs?.length === 1 ? ownerTypeArgs[0] : undefined);
					if (!builtin)
						throw new Error('towasm: inline asm failed to resolve (see the console warning above for details)');
					return emitInline('<inline>', builtin(e.arguments.map(a => operandInfo(a, ctx)), ctx), e.arguments, ctx);
				}

				// `obj?.method(...)` -- the `?.` sits on the `member` callee (or a chain further out
				// continues one, e.g. `obj?.a.method(...)` -- `isOptionalChainLink`, not a bare
				// `e.callee.optional`, see `case 'member'`'s own comment). Treated as one guarded operation:
				// `obj` evaluated once, checked for null, call only in the non-null arm -- restricted to a real user method (`ensureMethod`), not a `Math`/prelude intrinsic whose result type depends on the call site.
				if (e.callee.type === 'member' && isOptionalChainLink(e.callee)) {
					const objExpr = e.callee.object;
					const methodName = e.callee.property;
					const objWtype = wtypeOf(objExpr, ctx);
					if (!objWtype || typeof objWtype === 'string')
						throw new Error(`towasm: 'a?.${methodName}(...)' needs an object-typed value on its left`);
					const owner = ownerOf(objExpr, ctx);
					if (!owner)
						throw new Error(`towasm: unknown method '${methodName}'`);
					const typeArgs = e.typeArgs;
					const method = ensureMethod(owner, methodName, e.arguments, ctx, typeArgs);
					if (!method)
						throw new Error(`towasm: 'a?.${methodName}(...)' is not supported -- only a plain user-defined method (not a 'Math'/prelude intrinsic) can be guarded by '?.' in this pass`);
					if (method.result === 'void')
						throw new Error(`towasm: 'a?.${methodName}(...)' is not supported -- '${methodName}' returns 'void', which can't become 'void | undefined'`);
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
				if (e.callee.type === 'member' && e.callee.object.type === 'super') {
					const superClass = (ctx.owner && 'fields' in ctx.owner ? ctx.owner as ClassInfo : undefined)?.superClass;
					if (!superClass)
						throw new Error(`towasm: 'super.${e.callee.property}(...)' has no superclass to resolve against`);
					// `this`'s own static type is the current class (more derived than `superClass`) --
					// wasm-GC struct subtyping (`ensureClass`'s own `supertypes`) makes it directly usable as
					// `superClass`'s own receiver type, no cast needed, same as any other upcast in this file.
					emitAs({ type: 'this' }, ctx, superClass.thisWtype!);
					return emitMethodCall(superClass, e.callee.property, e.arguments, ctx, e.typeArgs, true);
				}

				if (e.callee.type === 'member') {
					const obj = e.callee.object;
					const typeArgs = e.typeArgs;
					if (obj.type === 'identifier') {
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
						throw new Error(`towasm: unknown method '${e.callee.property}'`);
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
				// A recursive call to the nested `function_decl` currently being compiled, from inside its
				// own body -- resolved to a direct, statically-known `call` (reusing the same env), not a
				// `call_ref` through a closure struct (see `FuncCtx.selfCall`'s own comment for why).
				if (e.callee.type === 'identifier' && ctx.selfCall?.name === e.callee.name) {
					const { funcIndex, params, result, hasRest } = ctx.selfCall;
					ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index));
					emitCallArgs(e.callee.name, params, undefined, !!hasRest, e.arguments, ctx);
					ctx.emit(I.call(funcIndex));
					return result;
				}
				// A closure value, called directly (`callback(x)`) -- checked via `ctx.resolvesName` so a local
				// shadowing a same-named global function takes priority, matching JS scoping. Bare identifier callee only for now (not e.g. `obj.field(x)`) -- v1 scope, not a fundamental limit.
				if (e.callee.type === 'identifier' && ctx.resolvesName(e.callee.name)) {
					const calleeWtype = ctx.resolvedWtype(e.callee.name);
					if (calleeWtype && typeof calleeWtype !== 'string' && 'closure' in calleeWtype) {
						const sig = calleeWtype.closure;
						const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
						emitExpr(e.callee, ctx);
						const scratch = ctx.declareLocal(`$closure$${closureCallTempCounter++}`, calleeWtype);
						ctx.emit(I.local.tee(scratch.index), I.struct.get(structTypeIndex, 1));
						// No defaults for a closure (an explicit restriction above, on the literal side) --
						// same rest-packing as a plain named function's own call site, reusing `emitCallArgs`.
						emitCallArgs(e.callee.name, sig.params, undefined, !!sig.hasRest, e.arguments, ctx);
						// The code pointer (funcref) is pushed last -- `call_ref` consumes it off the stack top, after every real argument.
						ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
						return sig.result;
					}
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
						emitCallArgs('<indexed closure>', sig.params, undefined, !!sig.hasRest, e.arguments, ctx);
						ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
						return sig.result;
					}
				}

				if (e.callee.type !== 'identifier')
					throw new Error('towasm: only direct calls to named functions, methods, or Math intrinsics are supported');

				return emitCall(e.callee.name, e.arguments, ctx, e.typeArgs);
			}

			// Closures: a captured arrow/function-expression literal compiles to a 2-field `{code, env}`
			// wasm-GC struct -- building it here is "closure creation"; `case 'call'` handles *using* the result. v1 restrictions are all explicit throws, never silent misbehavior.
			case 'arrow':
			case 'function':
				return emitClosureLiteral(e, ctx, false);

			default:
				throw new Error(`towasm: unsupported expression '${e.type}'`);
		}
	}

	// Handles `=` and every compound operator -- `tee` says whether the assigned value stays on the stack afterward
	function emitAssign(e: Binary<Expr, string>, ctx: FuncCtx, tee: boolean): WasmType {
		const { left, right, operator } = e;

		// A compound op reads the current value only to combine it with `right` -- never touches `.old` afterward, so `'discard'`, not `'keep'`
		const target =	emitAssignTarget(left, ctx, operator !== '=' ? 'discard' : 'none');
		const wtype = target.wtype;

		if (operator === '=') {
			emitAs(right, ctx, target.wtype);

		} else if (operator === '??=') {
			// `a ??= b` -- real JS short-circuits: `b` is only evaluated when `a` is null/undefined, unlike
			// every other compound-assignment op. Mirrors the plain `??` binary-op's own `if`-based lowering exactly, just feeding `target.write` instead of returning the value directly.
			if (typeof wtype === 'string' || !wtype.nullable)
				throw new Error("towasm: '??=' needs a nullable object-typed target (no boxing in this subset)");
			const leftLocal = ctx.declareLocal(`$nullish$assign$${optionalTempCounter++}`, wtype);
			ctx.emit(I.local.set(leftLocal.index));
			ctx.emit(I.local.get(leftLocal.index), I.ref.is_null);
			const _old = ctx.swapOut();
			emitAs(right, ctx, wtype);
			const _then = ctx.swapOut();
			ctx.emit(I.local.get(leftLocal.index));
			ctx.emit(I.if(toValType(wtype), _then, ctx.swapOut(_old)));

		} else {
			const op = operator.slice(0, -1);
			const builtin = builtins[op];
			if (!builtin)
				throw new Error(`towasm: unsupported compound-assignment operator '${operator}'`);

			// The owner comes from the checker's own type for `left`, not a guess off the physical `WasmType`
			// alone -- `{arr:'i16'}` happens to mean "string" today, but pattern-matching that shape is exactly the fragility `equalityInline`'s owner-based checks avoid.
			const owner		= ownerOf(left, ctx);
			const binname	= BINARY_OP_NAMES[op as keyof typeof BINARY_OP_NAMES];
			const inline	= owner && owner.methodDecls?.get(binname)
				? {owner, method: binname}
				: builtin([{ wtype, owner }, operandInfo(right, ctx)], ctx);
			
			if ('type' in inline)
				throw new Error(`towasm: internal: '${operator}' resolved to a function delegate outside its own dispatch`);

			if ('owner' in inline) {
				emitMethodCall(inline.owner, inline.method, [right], ctx);
			} else {
				coerceTop(wtype, ctx, inline.params[0]);
				emitAs(right, ctx, inline.params[1]);
				ctx.emit(...inline.inline);
				coerceTop(inline.result, ctx, wtype);
			}
		}

		target.write(tee);
		return tee ? target.wtype : 'void';
	}

	// ===================================================================
	//  Statement lowering
	// ===================================================================

	function emitStmt(s: Statement, ctx: FuncCtx): void {
		switch (s.type) {
			case 'block':
				ctx.openScope();
				s.body.forEach(st => emitStmt(st, ctx));
				ctx.closeScope();
				return;

			case 'var_decl':
				for (const d of s.declarations) {
					if (!d.init)
						throw new Error(`towasm: local '${describeBinding(d.name)}' needs an initializer`);
					if (typeof d.name !== 'string') {
						// Materializes `d.init` into a hidden scratch local once (`#destructure$<n>`), then
						// desugars into plain `var_decl`s reading their own piece back off it -- emitted
						// directly (not wrapped in a `block`) since these bindings belong to the *same*
						// scope as the original `var_decl`, not a nested one.
						const tmpName = `#destructure$${destructureTempCounter++}`;
						for (const stmt of [
							JS.VarDecl('const', JS.Var(tmpName, d.init, d.typeAnnotation)),
							...patternBindings(d.name, { type: 'identifier', name: tmpName }),
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
							const w = T.widenLiterals(T.resolve(global, objT));
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
						const methodReturn = (methodOwner.decl.body.find(m => m.type === 'method' && m.key === methodName) as MethodMember)?.returnType;
						tsType = methodReturn && calleeOptional ? T.combineTypes([methodReturn, T.UNDEFINED]) : methodReturn;
					}

					tsType ??= checkerTypeOf(d.init, stmtScope);

					const wtype = typeOf(tsType);
					if (!wtype) {
						// Let the actual lowering throw its own more specific error first (e.g. indexing a `string`) -- only fall back to this generic message if it didn't.
						emitExpr(d.init, ctx);
						throw new Error(`towasm: local '${d.name}' has an unsupported type`);
					}
					if (wtype === 'void')
						throw new Error(`towasm: local '${d.name}' cannot have type 'void'`);
					// A generator's own hoisted local (`compileGeneratorFunc`) -- storage is a frame struct
					// field, not a real wasm local, same as a real closure capture would be (`declareCaptured`
					// already registered its scope type upfront, so only the write itself is new here).
					const hoisted = ctx.closureEnv?.fields.get(d.name);
					if (hoisted) {
						ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index));
						emitAs(d.init, ctx, wtype);
						ctx.emit(I.struct.set(ctx.closureEnv!.envTypeIndex, hoisted.index));
					} else {
						emitAs(d.init, ctx, wtype);
						ctx.emit(I.local.set(ctx.declareValue(d.name, wtype, tsType).index));
					}
				}
				return;

			case 'expression':
				if (s.expression.type === 'binary' && ASSIGN_OPS.has(s.expression.operator)) {
					emitAssign(s.expression, ctx, false);
				} else {
					if (emitExpr(s.expression, ctx, 'void') !== 'void')
						ctx.emit(I.drop);
				}
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
			case 'continue':
				if (s.label)
					throw new Error("towasm: labeled 'continue' is not supported");
				if (!ctx.continueTargets.length)
					throw new Error("towasm: 'continue' outside of a loop");
				ctx.emit(I.br(ctx.depth - ctx.continueTargets.at(-1)!));
				return;

			case 'break':
				if (s.label)
					throw new Error("towasm: labeled 'break' is not supported");
				if (!ctx.breakTargets.length)
					throw new Error("towasm: 'break' outside of a loop or switch");
				ctx.emit(I.br(ctx.depth - ctx.breakTargets.at(-1)!));
				return;

			case 'return':
				if (ctx.generatorFrame) {
					const { frameLocal, frameTypeIndex, stateField, doneStateId, resultCtor, rWtype } = ctx.generatorFrame;
					ctx.emit(I.local.get(frameLocal.index), I.i32.const(doneStateId), I.struct.set(frameTypeIndex, stateField));
					if (s.argument)
						emitAs(s.argument, ctx, rWtype);
					else
						emitDefaultValue(rWtype, ctx);
					ctx.emit(I.i32.const(1), I.call(resultCtor.funcIndex), I.return);
					return;
				}
				if (ctx.asyncFrame) {
					const { frameLocal, frameTypeIndex, resultPromiseField, promiseClass, rWtype } = ctx.asyncFrame;
					ctx.emit(I.local.get(frameLocal.index), I.struct.get(frameTypeIndex, resultPromiseField));
					if (s.argument)
						emitAs(s.argument, ctx, rWtype);
					else
						emitDefaultValue(rWtype, ctx);
					ctx.emit(I.call(ensureMethod(promiseClass, 'resolve', [], ctx)!.funcIndex), I.return);
					return;
				}
				if (ctx.ctorThis) {
					if (s.argument)
						throw new Error('towasm: a constructor cannot return a value');
					ctx.emit(I.local.get(ctx.ctorThis.index));
				} else {
					if (ctx.result === 'void' && s.argument)
						throw new Error("towasm: a 'void' function cannot return a value");
					if (s.argument)
						emitAs(s.argument, ctx, ctx.result);
				}
				// A `reassignsThis` method's own (possibly just-updated) `this` rides along as one more wasm-level result on every return
				if (ctx.appendThisOnReturn)
					ctx.emit(I.local.get(ctx.lookup('this')!.index));
				ctx.emit(I.return);
				return;

			// `for...of` desugars into a synthetic `block`/`var_decl`/`for` (normal-kind) and recurses into
			// `emitStmt` itself, rather than adding a second instruction-emission path -- `kind: 'normal'`
			// below is the one real implementation both share.
			case 'for':
				switch (s.kind) {
					case 'normal': {
						// `s.init`'s own declaration (`for (let t = ...; ...)`) is scoped to the loop itself,
						// same as real JS -- opened here rather than relying on `s.body`'s own block scope
						// (which may not exist at all if the body is a single bare statement).
						ctx.openScope();
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
						ctx.closeScope();
						return;
					}
					case  'of': {
						if (s.init.type !== 'var_decl' || s.init.declarations.length !== 1 || typeof s.init.declarations[0].name !== 'string')
							throw new Error("towasm: 'for...of' loop variable must be a single plain identifier declaration");

						const v			= s.init.declarations[0];
						const n			= forTempCounter++;
						const arrId: Expr = { type: 'identifier', name: `#for${n}$arr` };
						const idxId: Expr = { type: 'identifier', name: `#for${n}$i` };

						emitStmt(JS.Block(
							JS.VarDecl('const', JS.Var(arrId.name, s.right)),
							JS.For(
								JS.VarDecl('let', JS.Var(idxId.name, Literal(0))),
								JS.JSBinary('<', idxId, JS.Member(arrId, 'length')),
								JS.JSUnary('++', idxId),
								JS.Block(
									JS.VarDecl(s.init.kind, JS.Var(v.name, JS.Index(arrId, idxId), v.typeAnnotation)),
									s.body
								),
							),
						), ctx);
						return;
					}
					default:
						throw new Error(`towasm: 'for...${s.kind}' is not supported`);
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
							const test = foldConstants(s.cases[i].test);
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
				ctx.openScope();
				const discName = `#switch$${switchTempCounter++}`;
				emitStmt(JS.VarDecl('const', JS.Var(discName, s.discriminant)), ctx);
				const discId: Expr = { type: 'identifier', name: discName };

				const old = ctx.swapOut();

				ctx.enterBreakTarget();
				ctx.enterLabel(n);

				// `br`/`br_if` labels are already relative to the branch point -- case `i`'s own block is
				// the `i`-th one opened above (case 0 innermost), and "no default" falls through all `n`
				// case-blocks to the enclosing break-target block at relative depth `n`.
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
				for (let k = 0; k < n; k++) {
					ctx.exitLabel();
					ctx.out = [I.block(undefined, content)];
					s.cases[k].consequent.forEach(st => emitStmt(st, ctx));
					content = ctx.out;
				}
				ctx.exitBreakTarget();
				ctx.out = old;
				ctx.emit(I.block(undefined, content));
				ctx.closeScope();
				return;
			}

			case 'function_decl':
				ctx.emit(I.local.set(ctx.declareLocal(s.name, emitClosureLiteral(s, ctx, true)).index));
				return;

			default:
				throw new Error(`towasm: unsupported statement '${s.type}'`);
		}
	}

	// ===================================================================
	//  Function/Method
	// ===================================================================

	// A non-`void` body doesn't necessarily end in a top-level `return` -- `if`/`while`/`switch` compile to a `void`-typed block wrapping their branches, leaving wasm's trailing-fallthrough check unsatisfied.
	// No full "does every path return" analysis to avoid it -- a trailing `unreachable` is always safe (dead code whenever a real return already covers every path).
	function emitTrailingUnreachable(ctx: FuncCtx, result: WasmType): void {
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
			info = { funcTypeIndex, structTypeIndex: addType({final: true, supertypes: [], type: { kind: 'struct', fields: [
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
	function resolveParam(p: JS.Param<Type>): ResolvedParam {
		// A default value is only resolved at each omitted call site (see `fillDefaultArgs`), not evaluated
		// dynamically the way real JS does -- so it must be a plain literal, safe to re-emit verbatim.
		let tsType = p.typeAnnotation;
		if (p.default) {
			if (p.default.type !== 'literal')
				throw new Error(`towasm: 'param '${describeBinding(p.key)}''s default value must be a literal`);
			tsType ??= checkerTypeOf(p.default, libGlobal);
		}
		if (!tsType)
			throw new Error(`towasm: 'param '${describeBinding(p.key)}' needs an explicit type`);
		const wtype = typeOf(tsType);
		if (!wtype)
			throw new Error(`towasm: 'param '${describeBinding(p.key)}' needs an explicit type`);
		if (wtype === 'void')
			throw new Error(`towasm: 'param '${describeBinding(p.key)}' cannot be 'void'`);
		return { key: p.key, wtype, tsType };
	}

	// Resolves the type-argument substitution map for a generic call (top-level function or method) --
	// shared by `ensureGenericFunc` and `ensureMethod`'s own generic-method case. Explicit call-site type
	// args win outright; otherwise each param's declared type is matched against its argument's real type
	// via the exact inference the checker itself uses (`T.inferTypeArgs`), matching checker.ts's own
	// `instantiate`, not a reimplementation. Falls back to each remaining type param's own `default`/
	// `constraint`/`any` in turn when nothing inferred it, same as the checker's own final fallback.
	// No contextual/expected-return-type inference (`instantiate` also tries that, via its own `expected`
	// param) -- towasm's codegen has no comparable "expected type" threaded through a call expression today.
	// `libGlobal` doubles as both `scope` (resolving each argument's own type) and `declScope` (resolving
	// the declared param types a type param is matched against) -- every declaration this is ever called
	// for (a top-level function, or a class method -- its class's own type params already concrete by the
	// time `ensureMethod` reaches here) is declared relative to the one module scope this file ever has,
	// same as `paramType`/`compileFunc` already assume elsewhere -- no separate "declaring module" to track
	// the way `T.declScopeOf` exists for (a cross-module signature, which nothing here ever is).
	function inferTypeArgMap(typeParams: readonly TS.TypeParam[], params: JS.Param<Type>[], args: Expr[], typeArgs: Type[] | undefined, ctx: FuncCtx): Map<string, Type> {
		const map = new Map<string, Type>();
		if (typeArgs) {
			typeParams.forEach((p, i) => map.set(p.name, typeArgs[i] ?? p.default ?? T.ANY));
		} else {
			const names = new Map(typeParams.map(p => [p.name, p] as const));
			args.forEach((a, i) => {
				const p = params[i];
				if (p?.typeAnnotation && a.type !== 'spread')
					T.inferTypeArgs(p.typeAnnotation, checkerTypeOf(a, ctx.scope), names, map, libGlobal);
			});
			typeParams.forEach(p => {
				if (!map.has(p.name))
					map.set(p.name, p.default ?? p.constraint ?? T.ANY);
			});
		}
		return map;
	}

	// Resolves a generic top-level function call to its monomorphized `FuncInfo`, cached under the same
	// composite-key shape `ensureClass` already uses for `Box<number>` (`identity<number>`) -- one real
	// difference from a class reference: a function's type arguments are usually left implicit at the call
	// site, inferred from the arguments (`inferTypeArgMap`, above). Explicit call-site type args
	// (`identity<number>(5)`) are honored too, same as a class's are.
	function ensureGenericFunc(name: string, decl: FunctionDecl, args: Expr[], typeArgs: Type[] | undefined, ctx: FuncCtx): FuncInfo {
		const typeParams = decl.typeParams!;
		const map = inferTypeArgMap(typeParams, decl.params, args, typeArgs, ctx);
		const key = `${name}<${typeParams.map(p => T.typeKey(T.resolve(global, map.get(p.name)!))).join(',')}>`;
		return funcs.get(key) ?? compileFunc(key, { ...substituteTypeParams(decl, map), typeParams: undefined })!;
	}

	function compileFunc(name: string, decl: FunctionDecl): FuncInfo | undefined {
		if (hasMod(decl, 'async'))
			return compileAsyncFunc(name, decl);
		if (hasMod(decl, 'generator'))
			return compileGeneratorFunc(name, decl);
		if (decl.typeParams?.length)
			throw new Error(`towasm: generic function '${name}' is not supported`);

		// No annotation defaults to `void` (matching real TS's inference) -- but an annotation that's present and doesn't resolve is still a real error, not silently `void` too.
		const result = decl.returnType ? typeOf(decl.returnType) : 'void';
		if (!result)
			throw new Error(`towasm: '${name}' has an unsupported return type`);

		const params	= decl.params.map(p => resolveParam(p));
		if (decl.rest?.typeAnnotation)
			params.push({key: decl.rest.key, wtype: typeOf(decl.rest.typeAnnotation)!, tsType: decl.rest.typeAnnotation});
		
		const {funcIndex, typeIndex} = registerFunc(toParams2(params), toResults(result));
		const info: FuncInfo = {params: params.map(r => r.wtype), result, funcIndex, typeIndex, defaults: decl.params.map(p => p.default), hasRest: !!decl.rest?.typeAnnotation};
		funcs.set(name, info);
		worklist.push(() => {
			const ctx	= new FuncCtx(new Scope(libGlobal), result, undefined);
			ctx.widenedTypes = collectRangeWidenings(decl.body!, ctx.scope);
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
			decl.body!.forEach(st => emitStmt(st, ctx));
			emitTrailingUnreachable(ctx, result);
			info.body		= ctx.toFuncBody(params.length, toValType);
			info.body.id	= name;
		});
		return info;
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
	//
	// v1 scope (checkpoint 1): no params, no locals live across a yield, no loops/ifs containing a
	// yield (`flattenStateMachine` itself throws for that last one) -- all lifted in later checkpoints.

	// Shared by compileGeneratorFunc/compileAsyncFunc -- both restrict a resumable function's own
	// params identically (plain identifier, no default, not optional, no rest); `kind` only changes
	// the error wording.
	function resolveResumableParams(kind: 'generator' | 'async', decl: FunctionDecl): ResolvedParam[] {
		if (decl.rest)
			throw new Error(`towasm: a${kind === 'async' ? 'n async function' : ' generator function'}'s rest parameter is not yet supported`);
		const label = kind === 'async' ? 'async function' : 'generator';
		return decl.params.map(p => {
			if (typeof p.key !== 'string')
				throw new Error(`towasm: a destructured ${label} parameter is not supported`);
			if (p.default)
				throw new Error(`towasm: ${label} parameter '${p.key}' cannot have a default value`);
			if (hasMod(p, 'optional'))
				throw new Error(`towasm: ${label} parameter '${p.key}' cannot be optional`);
			return resolveParam(p);
		});
	}

	// Shared by compileGeneratorFunc/compileAsyncFunc -- the frame's own field map (one per param, then
	// one per hoisted local -- state and any extra hidden field, e.g. async's own result Promise, are
	// each caller's own concern, appended before/after this). `resumeValueType`, when given, overrides
	// a suspend-boundary declarator's own init-derived type -- needed only for a generator's `const v =
	// yield x;` (see `compileGeneratorFunc`'s own comment on why `checkerTypeOf` can't be trusted
	// there); an async `await` needs no such override, so `compileAsyncFunc` never passes one.
	function buildFrameFields(kind: 'generator' | 'async', decl: FunctionDecl, params: ResolvedParam[], widenedTypes: Map<JS.Var<Type>, Type>, resumeValueType?: Type) {
		const hoisted = collectHoistedLocals(decl.body!);
		const localFields = new Map<string, { index: number; wtype: WasmType; tsType: Type }>();
		const frameFields: wasm.FieldType[] = [{ type: 'i32', mut: true }];
		for (const p of params) {
			localFields.set(p.key as string, { index: frameFields.length, wtype: p.wtype, tsType: p.tsType });
			frameFields.push({ type: toValType(p.wtype), mut: true });
		}
		for (const [localName, { stmt, decl: d }] of hoisted) {
			if (localFields.has(localName))
				continue;	// already a param field -- real JS forbids a body-level redeclaration of a param name anyway
			if (!d.init && !d.typeAnnotation)
				throw new Error(`towasm: ${kind} local '${localName}' needs an initializer or an explicit type`);
			const tsType = d.typeAnnotation ?? widenedTypes.get(d) ?? (resumeValueType && d.init?.type === 'yield' ? resumeValueType : d.init && T.literalTypeOf(d.init)) ?? checkerTypeOf(d.init!, (stmt as any).scope as Scope ?? libGlobal);
			const wt = typeOf(tsType);
			if (!wt || wt === 'void')
				throw new Error(`towasm: ${kind} local '${localName}' has an unsupported type`);
			localFields.set(localName, { index: frameFields.length, wtype: wt, tsType });
			frameFields.push({ type: toValType(wt), mut: true });
		}
		return { localFields, frameFields };
	}

	function compileGeneratorFunc(name: string, decl: FunctionDecl): FuncInfo {
		if (decl.typeParams?.length)
			throw new Error(`towasm: generic generator function '${name}' is not supported`);
		const params = resolveResumableParams('generator', decl);

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
			throw new Error(`towasm: generator function '${name}' has an unexpected inferred return type`);
		const [Y, R, N] = rt.typeArgs!;
		const yWtype = typeOf(Y), rWtype = typeOf(R), nWtype = typeOf(N);
		if (!yWtype || yWtype === 'void')
			throw new Error(`towasm: generator function '${name}' has an unsupported yielded type`);
		if (!rWtype)
			throw new Error(`towasm: generator function '${name}' has an unsupported return type`);
		if (!nWtype || nWtype === 'void')
			throw new Error(`towasm: generator function '${name}' has an unsupported '.next()' argument type`);

		const resultClass = ensureClass('IteratorResult', [Y, R]);
		const genClass = ensureClass('Generator', [Y, R, N]);
		if (!resultClass || !genClass)
			throw new Error(`towasm: internal: the generator lib classes were not found`);
		const resultWtype = ownerThisType(resultClass);

		const sig: FuncSig = { params: [nWtype], result: resultWtype, hasRest: false };
		const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);

		// The frame holds the resume state plus every local the body declares (conservative: hoists
		// every one of them, not just the ones actually live across a yield -- see
		// `collectHoistedLocals`'s own comment). `supertypes: [envBase]`, matching an ordinary closure
		// literal's own env struct -- the step function's real wasm param is declared `(ref $envBase)`
		// (`ensureClosureType`), so whatever concrete frame struct gets stored into the closure at the
		// creation site below must be a real subtype of it.
		const envBase = ensureEnvBase();
		const STATE_FIELD = 0;
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
		const widenedTypes = collectRangeWidenings(decl.body!, libGlobal);
		const { localFields, frameFields } = buildFrameFields('generator', decl, params, widenedTypes, N);
		const frameTypeIndex = addType({ final: true, supertypes: [envBase], type: { kind: 'struct', fields: frameFields } });

		const machine = flattenStateMachine(decl.body!);

		const { funcIndex: stepFuncIndex } = registerFuncAtType(funcTypeIndex);
		const stepInfo: FuncInfo = { params: sig.params, result: sig.result, hasRest: false, funcIndex: stepFuncIndex, typeIndex: funcTypeIndex };
		closureLiterals.push(stepInfo);

		worklist.push(() => {
			const fnCtx		= new FuncCtx(new Scope(libGlobal), resultWtype, undefined);
			// Param order must match `ensureClosureType`'s real wasm signature exactly (env, then
			// `sig.params`) -- the cast-down frame local is declared *after* both real params, as one
			// more genuine local, same as an ordinary closure literal's own `#env` (`emitClosureLiteral`).
			const envParam	= fnCtx.declareLocal('#envParam', { typeIndex: envBase, nullable: false });
			const sentParam	= fnCtx.declareLocal('#sent', nWtype);
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
			fnCtx.widenedTypes = widenedTypes;
			const resultCtor = ensureCtor(resultClass, [], fnCtx);
			emitGeneratorDispatch(machine, fnCtx, frameLocal, frameTypeIndex, STATE_FIELD, resultCtor, yWtype, rWtype, sentParam);
			emitTrailingUnreachable(fnCtx, resultWtype);
			stepInfo.body = fnCtx.toFuncBody(2, toValType);
		});

		const outerResult = ownerThisType(genClass);
		const { funcIndex: outerFuncIndex, typeIndex: outerTypeIndex } = registerFunc(toParams2(params), toResults(outerResult));
		const info: FuncInfo = { params: params.map(p => p.wtype), result: outerResult, funcIndex: outerFuncIndex, typeIndex: outerTypeIndex, hasRest: false };
		funcs.set(name, info);
		worklist.push(() => {
			const ctx = new FuncCtx(new Scope(libGlobal), outerResult, undefined);
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
			const genCtor = ensureCtor(genClass, [], ctx);
			// Build the step closure exactly like an ordinary closure literal's own creation site
			// (`I.ref.func`, then the env/frame value, then the 2-field `{code,env}` struct), then
			// construct `new Generator(step)` -- calling `name(...)` never runs the body, matching a real
			// JS generator's own "nothing runs before the first `.next()`" semantics. `state` is set to
			// the state machine's own real entry segment explicitly (`machine.entryId`) -- NOT left at
			// some implicit default, which is only the entry point by coincidence when nothing else
			// claimed id 0 first (e.g. `completeId` reserves it whenever the body's very first statement
			// is itself a suspend point).
			//
			// The frame is built via a real `struct.new` (every field's actual value, not
			// `struct.new_default` + later `struct.set`s) -- a real object-typed field (a ref-typed
			// param, e.g. a `Promise<T>` argument to an async function sharing this same construction
			// shape) isn't *defaultable*, so `struct.new_default` would reject the whole struct type the
			// moment even one field needs one. A param already has a real value ready (the wrapper's own
			// local); a hoisted (non-param) local doesn't yet -- `emitDefaultValue` covers a scalar or
			// nullable-ref one, and throws its own clear error for a still-unsupported non-nullable-ref
			// hoisted local (deliberately not attempted this round).
			const paramNames = new Set(params.map(p => p.key as string));
			ctx.emit(I.ref.func(stepFuncIndex), I.i32.const(machine.entryId));
			for (const [localName, field] of localFields) {
				if (paramNames.has(localName))
					ctx.emit(I.local.get(ctx.lookup(localName)!.index));
				else
					emitDefaultValue(field.wtype, ctx);
			}
			ctx.emit(I.struct.new(frameTypeIndex), I.struct.new(structTypeIndex));
			ctx.emit(I.call(genCtor.funcIndex), I.return);
			info.body = ctx.toFuncBody(params.length, toValType);
			info.body.id = name;
		});
		return info;
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
	function emitResumableDispatch(
		machine: StateMachine, fnCtx: FuncCtx, frameLocal: Local, frameTypeIndex: number, stateField: number,
		onSegmentStart: (segmentId: number) => void,
		onSuspend: (next: Extract<SegmentNext, { type: 'suspend' }>, loopMark: number) => void,
		onComplete: () => void,
	): void {
		const segs = machine.segments;
		const n = segs.length;

		const gotoLoop = (depthMark: number) => fnCtx.emit(I.br(fnCtx.depth - depthMark));

		const emitNext = (next: SegmentNext, loopMark: number) => {
			switch (next.type) {
				case 'goto':
					fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(next.target), I.struct.set(frameTypeIndex, stateField));
					gotoLoop(loopMark);
					return;

				case 'branch': {
					emitTruthy(next.test, fnCtx);
					const old = fnCtx.swapOut();
					fnCtx.enterLabel();
					fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(next.then), I.struct.set(frameTypeIndex, stateField));
					gotoLoop(loopMark);
					const thenInstrs = fnCtx.swapOut();
					fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(next.else), I.struct.set(frameTypeIndex, stateField));
					gotoLoop(loopMark);
					fnCtx.exitLabel();
					fnCtx.emit(I.if(undefined, thenInstrs, fnCtx.swapOut(old)));
					return;
				}
				case 'suspend':
					onSuspend(next, loopMark);
					return;
				case 'complete':
					onComplete();
					return;
			}
		};

		const oldOuter = fnCtx.swapOut();
		fnCtx.enterLabel();
		const loopMark = fnCtx.depth;
		fnCtx.enterLabel(n);

		// Every valid state (0..n-1) has its own explicit table entry -- the required 'default' arm is
		// truly unreachable in practice (`state` is always in range by construction), so any valid index
		// is a safe, arbitrary choice.
		fnCtx.emit(I.local.get(frameLocal.index), I.struct.get(frameTypeIndex, stateField));
		fnCtx.emit(I.br_table(Array.from({ length: n }, (_, i) => i), 0));

		let content = fnCtx.out;
		for (let k = 0; k < n; k++) {
			fnCtx.exitLabel();
			fnCtx.out = [I.block(undefined, content)];
			onSegmentStart(k);
			segs[k].stmts.forEach(st => emitStmt(st, fnCtx));
			emitNext(segs[k].next, loopMark);
			content = fnCtx.out;
		}

		fnCtx.exitLabel();	// the outer loop's own label
		fnCtx.out = oldOuter;
		fnCtx.emit(I.loop(undefined, content));
	}

	// `emitResumableDispatch`'s 'suspend'/'complete' arms, specialized for a generator: a suspend
	// always evaluates+yields a real value and returns a fresh `IteratorResult`; completion (natural or
	// a repeat call once already pinned there) does too, idempotently.
	function emitGeneratorDispatch(machine: StateMachine, fnCtx: FuncCtx, frameLocal: Local, frameTypeIndex: number, stateField: number, resultCtor: FuncInfo, yWtype: WasmType, rWtype: WasmType, sentParam: Local): void {
		fnCtx.generatorFrame = { frameLocal, frameTypeIndex, stateField, doneStateId: machine.completeId, resultCtor, rWtype };

		// 'const v = yield x;' -- `v`'s own resume-side binding lives on the *suspending* segment's own
		// `next` (the only place the flattener has it), not the segment it resumes into, so build the
		// reverse lookup once: which segment (by id) needs to write the sent value into which frame field,
		// right before running its own statements.
		const sentBindings = new Map<number, number>();
		for (const seg of machine.segments) {
			if (seg.next.type === 'suspend' && seg.next.resultVar)
				sentBindings.set(seg.next.resumeId, fnCtx.closureEnv!.fields.get(seg.next.resultVar)!.index);
		}

		emitResumableDispatch(machine, fnCtx, frameLocal, frameTypeIndex, stateField,
			id => {
				const sentField = sentBindings.get(id);
				if (sentField !== undefined)
					fnCtx.emit(I.local.get(frameLocal.index), I.local.get(sentParam.index), I.struct.set(frameTypeIndex, sentField));
			},
			next => {
				if (next.kind !== 'yield')
					throw new Error("towasm: 'await' is not supported yet (generators only, for now)");
				if (next.delegate)
					throw new Error("towasm: 'yield*' delegation is not supported");
				if (next.operand)
					emitAs(next.operand, fnCtx, yWtype);
				else
					emitDefaultValue(yWtype, fnCtx);
				fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(next.resumeId), I.struct.set(frameTypeIndex, stateField));
				fnCtx.emit(I.i32.const(0), I.call(resultCtor.funcIndex), I.return);
			},
			() => {
				// Natural completion, or a repeat call once already pinned here -- either way,
				// idempotent: re-pin `state` to this same segment's own id, done forever after.
				fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(machine.completeId), I.struct.set(frameTypeIndex, stateField));
				emitDefaultValue(rWtype, fnCtx);
				fnCtx.emit(I.i32.const(1), I.call(resultCtor.funcIndex), I.return);
			},
		);
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
	function compileAsyncFunc(name: string, decl: FunctionDecl): FuncInfo {
		if (decl.typeParams?.length)
			throw new Error(`towasm: generic async function '${name}' is not supported`);
		const params = resolveResumableParams('async', decl);

		// Unlike a generator's own `decl.returnType` (see `compileGeneratorFunc`'s own comment),
		// `checkFunctionBody`'s `skipReturn` is only ever forced for a *generator*, so a plain async
		// function's declared/inferred `Promise<R>` is trustworthy read directly, no scope-lookup
		// workaround needed.
		const rt = decl.returnType;
		if (rt?.type !== 'ref' || rt.name !== 'Promise' || (rt.typeArgs?.length ?? 0) !== 1)
			throw new Error(`towasm: async function '${name}' has an unexpected inferred return type`);
		const [R] = rt.typeArgs!;
		const rWtype = typeOf(R);
		if (!rWtype)
			throw new Error(`towasm: async function '${name}' has an unsupported return type`);

		const promiseClass = ensureClass('Promise', [R]);
		if (!promiseClass)
			throw new Error(`towasm: internal: the 'Promise' lib class was not found`);
		const promiseWtype = ownerThisType(promiseClass);

		const envBase = ensureEnvBase();
		const STATE_FIELD = 0;
		// No `resumeValueType` override needed here (unlike a generator's own 'yield', see
		// `compileGeneratorFunc`'s comment) -- `checkFunctionBody`'s forced-`any` corruption is tied to
		// `skipReturn`, which only a generator ever sets; `typeOf(await x)` (`T.awaitType`) already
		// resolves the real unwrapped type correctly.
		const widenedTypes = collectRangeWidenings(decl.body!, libGlobal);
		const { localFields, frameFields } = buildFrameFields('async', decl, params, widenedTypes);
		// One more hidden field -- this function's own result Promise, resolved directly (a real public
		// method call, not routed through the executor-callback pattern) by every `return` and by
		// natural completion (`ctx.asyncFrame`, `emitAsyncDispatch`'s own 'complete' handling).
		const resultPromiseField = frameFields.length;
		frameFields.push({ type: toValType(promiseWtype), mut: true });
		const frameTypeIndex = addType({ final: true, supertypes: [envBase], type: { kind: 'struct', fields: frameFields } });

		const machine = flattenStateMachine(decl.body!);

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

		worklist.push(() => {
			const fnCtx		= new FuncCtx(new Scope(libGlobal), 'void', undefined);
			const frameLocal	= fnCtx.declareLocal('#frame', { typeIndex: frameTypeIndex, nullable: false });
			const sentParam		= fnCtx.declareLocal('#sent', REF_ANY);
			fnCtx.closureEnv = { envLocal: frameLocal, envTypeIndex: frameTypeIndex, fields: localFields };
			for (const [localName, { tsType }] of localFields)
				fnCtx.declareCaptured(localName, tsType);
			fnCtx.widenedTypes = widenedTypes;
			fnCtx.asyncFrame = { frameLocal, frameTypeIndex, resultPromiseField, promiseClass, rWtype };
			emitAsyncDispatch(machine, fnCtx, frameLocal, frameTypeIndex, STATE_FIELD, sentParam, envBase, stepFuncIndex);
			stepInfo.body = fnCtx.toFuncBody(2, toValType);
		});

		const { funcIndex: outerFuncIndex, typeIndex: outerTypeIndex } = registerFunc(toParams2(params), toResults(promiseWtype));
		const info: FuncInfo = { params: params.map(p => p.wtype), result: promiseWtype, funcIndex: outerFuncIndex, typeIndex: outerTypeIndex, hasRest: false };
		funcs.set(name, info);
		worklist.push(() => {
			const ctx = new FuncCtx(new Scope(libGlobal), promiseWtype, undefined);
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));

			const promiseCtor = ensureCtor(promiseClass, [], ctx);
			const resultPromiseLocal = ctx.declareLocal('#resultPromise', promiseWtype);
			emitDefaultValue(rWtype, ctx);
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
			ctx.emit(I.local.get(resultPromiseLocal.index));
			ctx.emit(I.struct.new(frameTypeIndex));

			// Kick the body off immediately, synchronously, up to its first real suspend or completion --
			// matching real JS: calling an async function runs its body right away, only ever returning
			// control *to its own caller* at an `await`, not before. The sent value is never read at the
			// entry segment (only a resume segment with a binding reads `#sent`), so any *non-null* value
			// is fine -- `#sent`'s own declared type is non-nullable `any` (matching every other boxed-any
			// value in this file), so a real (if unused) box, not `ref.null`, keeps that true unconditionally.
			ctx.emit(I.f64.const(0), I.struct.new(ensureBoxType('f64')));
			ctx.emit(I.call(stepFuncIndex));

			ctx.emit(I.local.get(resultPromiseLocal.index), I.return);
			info.body = ctx.toFuncBody(params.length, toValType);
			info.body.id = name;
		});
		return info;
	}

	// `emitResumableDispatch`'s 'suspend'/'complete' arms, specialized for async: a suspend either
	// unwraps immediately (a non-Promise operand -- the synchronous fast path) or registers a
	// trampoline via `Promise.then()` and returns; completion resolves the function's own result
	// Promise directly instead of constructing anything.
	function emitAsyncDispatch(machine: StateMachine, fnCtx: FuncCtx, frameLocal: Local, frameTypeIndex: number, stateField: number, sentParam: Local, envBase: number, stepFuncIndex: number): void {
		const { resultPromiseField, promiseClass, rWtype } = fnCtx.asyncFrame!;

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
					const tCtx = new FuncCtx(new Scope(libGlobal), 'void', undefined);
					const envParam = tCtx.declareLocal('#envParam', { typeIndex: envBase, nullable: false });
					const valueParam = tCtx.declareLocal('#value', tWtype);
					tCtx.emit(I.local.get(envParam.index), I.ref.cast(frameTypeIndex));
					tCtx.emit(I.local.get(valueParam.index));
					coerceTop(tWtype, tCtx, REF_ANY);
					tCtx.emit(I.call(stepFuncIndex), I.return);
					tInfo.body = tCtx.toFuncBody(2, toValType);
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

		emitResumableDispatch(machine, fnCtx, frameLocal, frameTypeIndex, stateField,
			id => {
				const sentField = sentBindings.get(id);
				if (sentField) {
					fnCtx.emit(I.local.get(frameLocal.index), I.local.get(sentParam.index));
					coerceTop(REF_ANY, fnCtx, sentField.wtype);
					fnCtx.emit(I.struct.set(frameTypeIndex, sentField.index));
				}
			},
			(next, loopMark) => {
				if (next.kind !== 'await')
					throw new Error("towasm: 'yield' is not supported inside an async function");
				if (next.delegate)
					throw new Error("towasm: 'yield*' is not supported inside an async function");
				const operand = next.operand!;
				const promiseRef = T.asPromiseRef(checkerTypeOf(operand, fnCtx.scope), fnCtx.scope);
				if (!promiseRef) {
					// The synchronous fast path: `operand` isn't Promise-shaped, so there's nothing to
					// suspend on -- real JS unwraps a non-thenable `await` immediately. Still a real state
					// transition (simpler and no less correct than trying to fall through directly; the
					// wasm-level cost is one extra dispatch-loop iteration).
					if (next.resultVar) {
						const field = fnCtx.closureEnv!.fields.get(next.resultVar)!;
						fnCtx.emit(I.local.get(frameLocal.index));
						emitAs(operand, fnCtx, field.wtype);
						fnCtx.emit(I.struct.set(frameTypeIndex, field.index));
					} else if (emitExpr(operand, fnCtx, 'void') !== 'void') {
						fnCtx.emit(I.drop);
					}
					fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(next.resumeId), I.struct.set(frameTypeIndex, stateField));
					fnCtx.emit(I.br(fnCtx.depth - loopMark));
					return;
				}

				const tType = promiseRef.typeArgs![0];
				const tWtype = typeOf(tType);
				if (!tWtype)
					throw new Error("towasm: 'await' on a Promise of an unsupported element type");
				const awaitedClass = ensureClass('Promise', [tType]);
				if (!awaitedClass)
					throw new Error(`towasm: internal: the 'Promise' lib class was not found`);

				emitAs(operand, fnCtx, ownerThisType(awaitedClass));
				const promiseLocal = fnCtx.declareLocal(`$await$${awaitTemp++}`, ownerThisType(awaitedClass));
				fnCtx.emit(I.local.set(promiseLocal.index));

				// `state` must already say where to resume *before* calling `.then()` -- a promise
				// that's already settled invokes the trampoline synchronously, reentrantly calling
				// `stepFuncIndex` before this `.then()` call itself returns (safe: this arm's own code
				// ends in `return` immediately after, so the reentrant call's own work is never redone).
				fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(next.resumeId), I.struct.set(frameTypeIndex, stateField));

				const { funcIndex: trampolineFuncIndex, structTypeIndex: trampolineStructTypeIndex } = ensureTrampoline(tWtype);
				const thenMethod = ensureMethod(awaitedClass, 'then', [], fnCtx)!;
				fnCtx.emit(I.local.get(promiseLocal.index));
				fnCtx.emit(I.ref.func(trampolineFuncIndex), I.local.get(frameLocal.index), I.struct.new(trampolineStructTypeIndex));
				fnCtx.emit(I.call(thenMethod.funcIndex), I.return);
			},
			() => {
				fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(machine.completeId), I.struct.set(frameTypeIndex, stateField));
				fnCtx.emit(I.local.get(frameLocal.index), I.struct.get(frameTypeIndex, resultPromiseField));
				emitDefaultValue(rWtype, fnCtx);
				fnCtx.emit(I.call(ensureMethod(promiseClass, 'resolve', [], fnCtx)!.funcIndex), I.return);
			},
		);
	}

	// Picks the declaration (from possibly several real bodies sharing a name, a genuine overload set) whose
	// declared params fit `args`' actual types, mirroring the checker's own `T.argsFit`-based resolution -- resolves to the exact same overload the checker already validated the call against.
	function resolveOverload(label: string, decls: MethodMember[], args: Expr[], ctx: FuncCtx): MethodMember {
		if (decls.length === 1)
			return decls[0];
		if (args.some(a => a.type === 'spread'))
			throw new Error(`towasm: spread arguments are not supported in a call to overloaded '${label}'`);
		const argTs = args.map(a => checkerTypeOf(a, ctx.scope));
		const found = decls.find(d => d.body && T.argsFit(T.FixSig(d, T.ANY), argTs, ctx.scope));
		if (!found)
			throw new Error(`towasm: no overload of '${label}' matches this call`);
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

	// Resolves a plain, non-generic type alias (`type Point = { x: number; y: number };`) whose target
	// resolves to a structural object type of only 'property' members, giving it a real physical wasm-GC
	// struct type -- narrow object-literal support: a literal's target type must be exactly one of these
	// (from a var_decl/param/field/return annotation, or any other context that threads a concrete `want`
	// through `emitAs`), never real structural inference/subtyping the way general TS object types get.
	// Cached into the same `classes` map real classes use -- a name can't be both a `class_decl` and a
	// type alias, so no key collision risk -- which is what lets ordinary field access (`classOf`/`case
	// 'member'`) work completely unchanged afterward, same as any other class.
	function ensureObjectShape(name: string): ClassInfo | undefined {
		const existing = classes.get(name);
		if (existing)
			return existing;
		const target = global.type(name)?.type;
		if (!target)
			return undefined;
		const resolved = T.resolve(global, target);
		if (resolved.type !== 'object')
			return undefined;

		const fields: { name: string; wtype: WasmType }[] = [];
		const fieldIndex = new Map<string, number>();
		for (const m of resolved.members) {
			if (m.type !== 'property')
				throw new Error(`towasm: object-shape type '${name}' can only have plain properties (no methods/index/call signatures) to be an object literal's target type`);
			if (typeof m.key !== 'string')
				throw new Error(`towasm: object-shape type '${name}' has a computed property name -- not supported`);
			const wt = typeOf(m.typeAnnotation);
			if (!wt || wt === 'void')
				throw new Error(`towasm: object-shape type '${name}.${m.key}' needs an explicit number/boolean/object type`);
			fieldIndex.set(m.key, fields.length);
			fields.push({ name: m.key, wtype: wt });
		}

		const info: ClassInfo = {
			name, typeIndex: -1, thisTsType: TS.RefType(name),
			decl: { name, body: [] },
			fields, fieldIndex, methodDecls: new Map(),
		};
		classes.set(name, info);
		info.thisWtype = { ref: name };
		info.typeIndex = addType({ final: !everExtended.has(name), supertypes: [], type: {
			kind: 'struct',
			fields: fields.map(f => ({ type: toValType(f.wtype), mut: true })),
		} });
		return info;
	}

	// Resolves fields and the struct type eagerly, but only collects method/ctor decls -- building each is
	// deferred to `ensureMethod`/`ensureCtor`, the same lazy treatment `ensureFunc` gives top-level functions.
	function ensureClass(name: string, typeArgs?: Type[]): ClassInfo | undefined {
		// A real generic instantiation (`Box<number>`) is cached under a composite key, not the bare class
		// name -- two different type arguments are two different physical classes. Keying off the *unresolved* class name (not `T.resolve`'s expanded form) keeps two classes with identical field shapes from colliding.
		// A wasm pseudo-type argument (`TypedArray<u8>`/`<i32>`/etc, see `TYPED_ARRAY_TAGS`) is kept
		// unresolved too, by its own name -- `T.resolve` collapses every one of them alike down to plain
		// `number` (they're all just `= number` aliases), which would otherwise key `TypedArray<u8>` and
		// `TypedArray<i32>` identically and wrongly collide the two into one shared (and wrongly $elem-tagged
		// by whichever instantiated first) physical class.
		const key = typeArgs?.length
			? `${name}<${typeArgs.map(t => t.type === 'ref' && !t.typeArgs && TYPED_ARRAY_TAGS.has(t.name as TypedArrayTag) ? t.name : T.typeKey(T.resolve(global, t))).join(',')}>`
			: name;
		let info = classes.get(key);
		if (!info) {
			// A plain lib-internal class -- an ordinary struct seeded into `classes` lazily on first reference.
			let decl = LIB_DECL_MAP.get(name) ?? userGenericClassDecls.get(name);
			if (decl?.type !== 'class_decl' && !typeArgs?.length) {
				const alias = resolveClassAlias(name);
				if (alias)
					return ensureClass(alias.name, alias.typeArgs);
				const shape = ensureObjectShape(name);
				if (shape)
					return shape;
			}
			if (decl?.type !== 'class_decl')
				return undefined;
			if (decl.typeParams?.length) {
				if (!typeArgs || typeArgs.length !== decl.typeParams.length)
					throw new Error(`towasm: class '${name}' needs ${decl.typeParams.length} explicit type argument(s)`);
				decl.typeParams.forEach((p, i) => decl = substituteClassTypeParam(decl as JS.ClassDecl<Type>, p.name, typeArgs[i]));
			}
			// `thisTsType` is always a real reference to this class -- the ref itself must carry the real name
			// and type arguments (`{name, typeArgs}`), not the mangled composite cache key as a bare name, or
			// `this.length`/`this[i]` can't resolve (`T.lookupMember` silently falls back to `any`). How an
			// instance is physically represented (struct vs. array) is the separate, towasm-only `thisWtype`, set below.
			info = { name: key, typeIndex: -1, thisTsType: TS.RefType(name, typeArgs), decl, fields: [], fieldIndex: new Map(), methodDecls: new Map() };
			classes.set(key, info);
		}
		if (info.typeIndex !== -1)
			return info;

		if (resolving.has(key))
			throw new Error(`towasm: class '${key}' has a field cycle (directly or indirectly has a field of its own type) -- not supported`);

		resolving.add(key);
		
		const addField = (key: string, typeAnnotation?: Type) => {
			const wt = typeAnnotation && typeOf(typeAnnotation);
			if (!wt || wt === 'void')
				throw new Error(`towasm: field '${name}.${key}' needs an explicit number/boolean/object type`);
			// A field sharing a name already seeded from the superclass (below) would silently clobber its
			// index in `fieldIndex` while leaving the physical struct slot untouched -- the base class's own
			// (already-compiled-against-that-slot) methods would then read/write the wrong logical field.
			// Real TS allows re-declaring an inherited field (with a compatible type); this compiler doesn't
			// model that, so it throws rather than silently miscompiling it.
			if (info.fieldIndex.has(key))
				throw new Error(`towasm: field '${name}.${key}' redeclares an inherited field -- not supported`);
			info.fieldIndex.set(key, info.fields.length);
			info.fields.push({ name: key, wtype: wt });
		};

		const addMethod = (key: string, m: MethodMember) => {
			const list = info.methodDecls.get(key);
			if (list)
				list.push(m);
			else
				info.methodDecls.set(key, [m]);
		};

		try {
			const decl = info.decl;
			if (decl.abstract)
				throw new Error(`towasm: abstract class '${name}' is not supported`);

			// Resolved *before* this class's own members, so `addField`'s redeclaration guard (above) sees
			// every inherited field already seeded, and `info.fields`/`fieldIndex` end up in the order
			// wasm-GC struct subtyping requires: the supertype's own fields first, as an exact prefix, this
			// class's own appended after.
			if (decl.superClass) {
				const superName = decl.superClass.type === 'identifier' ? decl.superClass.name
					: decl.superClass.type === 'instantiation' && decl.superClass.expression.type === 'identifier' ? decl.superClass.expression.name
					: undefined;
				if (!superName)
					throw new Error(`towasm: only a plain named superclass ('class ${name} extends Base' or 'extends Base<T>') is supported`);
				const superInfo = ensureClass(superName, decl.superClass.type === 'instantiation' ? decl.superClass.typeArgs : undefined);
				if (!superInfo)
					throw new Error(`towasm: unknown superclass '${superName}' for class '${name}'`);
				if (typeof superInfo.thisWtype !== 'string' && superInfo.thisWtype && 'arr' in superInfo.thisWtype || superInfo.typeIndex === -1)
					throw new Error(`towasm: '${name}' can't extend '${superName}' -- extending an array/scalar-backed class (a constructor with its own explicit 'return') is not supported`);
				info.superClass = superInfo;
				info.fields.push(...superInfo.fields);
				superInfo.fieldIndex.forEach((idx, fname) => info.fieldIndex.set(fname, idx));
			}

			let returnType;

			for (const m of decl.body) {
				if (m.type === 'field'/* && !hasMod(m, 'static')*/) {
					if (m.modifiers?.includes('static') || isAsm(m.value))
						continue;

					if (typeof m.key !== 'string')
						throw new Error(`towasm: computed field names in '${name}' are not supported`);
					addField(m.key, m.typeAnnotation ?? (m.value ? checkerTypeOf(m.value, libGlobal) : undefined));

				} else if (m.type === 'method') {
					// A computed name can't be stored as a decl key -- and can never be called via `.name()` syntax either, so it's simply never reachable, no need to throw.
					if (typeof m.key === 'string')
						addMethod(m.key, m);

					if (m.key === 'constructor') {
						for (const p of m.params) {
							if (hasMod(p, 'public') || hasMod(p, 'private') || hasMod(p, 'protected')) {
								if (typeof p.key !== 'string')
									throw new Error(`towasm: computed field names in '${name}' are not supported`);
								addField(p.key, p.typeAnnotation ?? (p.default ? checkerTypeOf(p.default, libGlobal) : undefined));
							}
						}

						if (!returnType && m.body) {
							const last = m.body[m.body.length - 1];
							if (last?.type === 'return' && last.argument)
								returnType = checkerTypeOf(unwrapAs(last.argument), m.scope as Scope);
						}
					}

				} else if (m.type === 'get' || m.type === 'set') {
					if (typeof m.key === 'string') {
						addMethod(accessorKey(m.type, m.key), m);
						(m.type === 'get' ? (info.getterNames ??= new Set()) : (info.setterNames ??= new Set())).add(m.key);
					}

				} else if (m.type === 'index_signature') {
					// Type-checking-only -- real indexing goes through the generic `get`/`set`/array-kind paths (`case 'index'`), never a declared index signature itself, so there's nothing for this pass to do with it.
					continue;

				} else {
					throw new Error(`towasm: unsupported class member kind '${m.type}' in '${name}'`);
				}
			}

			// `thisWtype` is determined by a constructor that explicitly returns a value
			// Every other class keeps the ordinary struct path. Any one overload's explicit-return shape already tells us `thisWtype`/`typeIndex` -- no need to check they all agree.
			if (returnType) {
				if (decl.superClass)
					throw new Error(`towasm: '${name}' can't both extend '${(decl.superClass as any).name}' and have a constructor with its own explicit 'return' -- not supported`);
				const result	= typeOf(returnType);
				if (!result || (typeof result !== 'string' && !('arr' in result)))
					throw new Error(`towasm: '${name}'s constructor returns a value of an unsupported shape for 'this' -- only a scalar or array-shaped result is supported`);
				info.thisWtype = result;
				info.typeIndex = typeof result === 'string' ? -1 : ensureArrayType(result.arr);
			} else {
				info.thisWtype = { ref: key };
				// `final: !everExtended.has(name)` -- wasm-GC requires a struct type be declared extensible
				// (`final: false`) *at the point it's registered* to ever be usable as another's
				// `supertypes` entry later; `everExtended` (computed once, from the whole program's own
				// `class ... extends X` references, before any class's struct type is actually registered)
				// is what makes that decision knowable up front instead of needing to patch it in after the
				// fact. `supertypes: [info.superClass.typeIndex]` is exactly what makes `(ref Derived)` a
				// real subtype of `(ref Base)` in the wasm type section -- a subclass instance can be passed
				// anywhere a `(ref Base)` is expected with zero cast/conversion, which is the whole reason a
				// non-overridden inherited method can stay a single, ordinary, statically-resolved `call`
				// straight to `Base`'s own compiled function (see `ensureMethod`'s own delegation).
				info.typeIndex = addType({ final: !everExtended.has(name), supertypes: info.superClass ? [info.superClass.typeIndex] : [], type: {
					kind: 'struct',
					fields: info.fields.map(f => ({ type: toValType(f.wtype), mut: true }))
				} });
			}

			// A method whose one statement forwards straight to `__asm` -- same intrinsic recognition
			const elemType = typeArgs?.length === 1 ? typeArgs[0] : undefined;
			const { inlineMethods, asmMethodKeys } = scanInlineMethods(decl, name, info.typeIndex,
				typeof info.thisWtype !== 'string' && info.thisWtype && 'arr' in info.thisWtype ? info.thisWtype.arr : undefined,
				elemType,
				// `$elem` (a real instruction choice `get`/`set`/`elemSize` switch on, e.g. `TypedArray<u8>`)
				// read straight off the real type argument's own name -- general, not typed-array-specific:
				// any class whose single type argument happens to be one of these pseudo-type names gets it,
				// the same way `elemKind`/`elemType` above already flow from the real instantiation.
				elemType?.type === 'ref' && !elemType.typeArgs && TYPED_ARRAY_TAGS.has(elemType.name as TypedArrayTag)
					? elemType.name as TypedArrayTag : undefined);
			for (const k of asmMethodKeys)
				info.methodDecls.delete(k);
			if (inlineMethods.size)
				info.inlineMethods = inlineMethods;

			return info;

		} finally {
			resolving.delete(key);
		}
	}

	// Whether `body` assigns to `this` anywhere -- real TS never allows this, so it has exactly one meaning
	// here: "this method replaces its own receiver's physical value" (a wasm-GC array/struct can't resize in place). Detected structurally -- any method on any class doing this gets the same treatment, not a hardcoded list.
	function assignsToThis(body: Statement[]): boolean {
		return walkB(body, undefined, (e, process) =>
			e.type === 'binary' && e.operator === '=' && e.left.type === 'this' ? true : process(e));
	}

	// Emits a constructor body statement-by-statement, same as an ordinary `stmts.forEach(st => emitStmt(st,
	// ctx))` -- except a `super(...)` call is recognized and *inlined*: the superclass's own constructor
	// body runs right there, writing into the exact same `this` (there's only ever one physical allocation
	// for the whole hierarchy -- see `ensureClass`'s field-layout comment -- so "calling super" here means
	// "run its init logic", not "allocate a separate base object"). Recurses naturally for a multi-level
	// chain (the superclass's own body may contain its own `super(...)`, resolved against *its* own
	// `cls.superClass` in the recursive call).
	function emitCtorStatements(stmts: Statement[], cls: ClassInfo, ctx: FuncCtx): void {
		for (const st of stmts) {
			if (st.type === 'expression' && st.expression.type === 'call' && st.expression.callee.type === 'super') {
				const call = st.expression;
				const superClass = cls.superClass;
				if (!superClass)
					throw new Error(`towasm: '${cls.name}' has no superclass -- 'super(...)' is not supported here`);
				if (call.arguments.some(a => a.type === 'spread'))
					throw new Error(`towasm: 'super(...)': a spread argument is not supported`);
				const superDecls = superClass.methodDecls.get('constructor');
				if (!superDecls)
					throw new Error(`towasm: superclass '${superClass.name}' needs an explicit constructor for 'super(...)' to call`);
				const superCtor = resolveOverload(`${superClass.name}'s constructor`, superDecls, call.arguments, ctx);
				if (!superCtor.body)
					throw new Error(`towasm: '${superClass.name}'s constructor needs a body (overload signatures are not supported)`);

				// Binds the base ctor's own param names to this call's own argument expressions -- a plain
				// `var_decl` per param, reusing the ordinary local-declaration path (including its own
				// destructuring-pattern desugaring, for a destructured base param) unchanged. A nested scope
				// closes once the base's own body has run, matching real TS scoping: the base ctor's own
				// params aren't visible to the rest of *this* ctor's body.
				ctx.openScope();
				superCtor.params.forEach((p, i) => {
					const argExpr = call.arguments[i] ?? p.default;
					if (!argExpr)
						throw new Error(`towasm: 'super(...)': missing argument for '${superClass.name}'s constructor parameter '${describeBinding(p.key)}'`);
					emitStmt(JS.VarDecl('const', JS.Var(p.key, argExpr, p.typeAnnotation)), ctx);
				});
				emitCtorStatements(superCtor.body, superClass, ctx);
				ctx.closeScope();
				continue;
			}
			emitStmt(st, ctx);
		}
	}

	function ensureCtor(cls: ClassInfo, args: Expr[], callerCtx: FuncCtx): FuncInfo {
		const decls = cls.methodDecls.get('constructor');
		if (!decls)
			throw new Error(`towasm: class '${cls.name}' needs an explicit constructor`);

		const ctor			= resolveOverload(`${cls.name}'s constructor`, decls, args, callerCtx);
		const key			= decls.length > 1 ? `${cls.name}.constructor#${decls.indexOf(ctor)}` : `${cls.name}.constructor`;
		const existing		= funcs.get(key);
		if (existing)
			return existing;

		const params		= ctor.params.map(p => resolveParam(p));
		if (ctor.rest?.typeAnnotation)
			params.push({key: ctor.rest.key, wtype: typeOf(ctor.rest.typeAnnotation)!, tsType: ctor.rest.typeAnnotation});

		//const thisWtype	= ownerThisType(cls);
		const thisWtype		= cls.thisWtype!;

		const {funcIndex, typeIndex} = registerFunc(toParams2(params), toResults(thisWtype));
		const info: FuncInfo = { params: params.map(r => r.wtype), result: thisWtype, funcIndex, typeIndex, defaults: ctor.params.map(p => p.default), hasRest: !!ctor.rest?.typeAnnotation };
		funcs.set(key, info);

		worklist.push(() => {
			const ctx		= new FuncCtx(new Scope(libGlobal), thisWtype, cls);
			ctx.widenedTypes = collectRangeWidenings(ctor.body!, ctx.scope);
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
			// This constructor supplies `this` directly via its own return value (`ctorReturnsValue`)
			// `cls`'s own `thisWtype`/`typeIndex` already say so; ordinary statement compilation does the right thing once `ctx.ctorThis` is unset.
			const last = ctor.body?.at(-1);
			if (last?.type === 'return' && last.argument) {
				ctor.body!.forEach(st => emitStmt(st, ctx));

			// Defaultability is a whole-struct-type property, not per-field -- one object-typed field forces the collect-then-`struct.new` path for the whole class.
			} else if (cls.fields.some(f => typeof f.wtype !== 'string')) {
				// Scope limit, not a fundamental one: this path collects every field's real value up front
				// (`struct.new`, not `struct.new_default`) by scanning `cls.decl.body`'s own field
				// initializers and `this.field =` statements directly -- neither of those account for
				// inherited fields/initializers or a spliced-in `super(...)` body the way
				// `emitCtorStatements`/the plain `struct.new_default` path below do. Combining the two
				// would need this whole path taught the same inheritance-awareness; not attempted here.
				if (cls.superClass)
					throw new Error(`towasm: '${cls.name}' extends '${cls.superClass.name}' and also has at least one object-typed field of its own -- combining inheritance with a field that needs 'struct.new' (real values up front, instead of 'struct.new_default') is not supported`);
				const remaining	= new Set(cls.fields.map(f => f.name));
				const values	= new Map<string, Local>();
				ctx.ctorFields	= values;
				// No real local for `this` yet, but `checkerTypeOf` still needs its static type to resolve a
				// chained read like `this.p.x` (`p` already collected) down to `p`'s own class -- same no-real-
				// local, scope-only registration `declareCaptured` uses for closure captures.
				ctx.scope.addValue('this', cls.thisTsType);

				const setField = (field: string, wtype: WasmType) => {
					const local = ctx.declareLocal(`$field$${field}`, wtype);
					ctx.emit(I.local.set(local.index));
					values.set(field, local);
					remaining.delete(field);
					if (!remaining.size) {
						for (const f of cls.fields)
							ctx.emit(I.local.get(values.get(f.name)!.index));
						ctx.emit(I.struct.new(cls.typeIndex));
						const thisLocal = ctx.declareValue('this', thisWtype, cls.thisTsType);
						ctx.ctorThis = thisLocal;
						ctx.ctorFields = undefined;
						ctx.emit(I.local.set(thisLocal.index));
					}
				};

				const initField = (field: string, value: Expr) => {
					const wtype = cls.fields[cls.fieldIndex.get(field)!].wtype;
					emitAs(value, ctx, wtype);
					setField(field, wtype);
				};

				for (const m of cls.decl.body) {
					if (m.type === 'field' && !m.modifiers?.includes('static') && m.value)
						initField(m.key as string, m.value);
				}
				for (const p of ctor.params) {
					if (hasMod(p, 'public') || hasMod(p, 'private') || hasMod(p, 'protected')) {
						const loc = ctx.lookup(p.key as string)!;
						ctx.emit(I.local.get(loc.index));
						setField(p.key as string, loc.wtype);
					}
				}

				for (const st of ctor.body!) {
					if (!remaining.size || st.type === 'var_decl') {
						emitStmt(st, ctx);
						continue;
					}

					if (st.type === 'expression' && st.expression.type === 'binary' && st.expression.operator === '=' && st.expression.left.type === 'member' && st.expression.left.object.type === 'this') {
						const field	 = st.expression.left.property;
						if (remaining.has(field)) {
							initField(field, st.expression.right);
							continue;
						}
					}

					throw new Error(`towasm: '${cls.name}'s constructor must assign every field via a plain 'this.field = value' statement, before any other statement -- it has at least one object-typed field, which needs 'struct.new' (real values up front) instead of 'struct.new_default'`);
				}

				if (remaining.size)
					throw new Error(`towasm: '${cls.name}'s constructor never assigns field(s) ${[...remaining].join(', ')}`);
				ctx.emit(I.local.get(ctx.ctorThis!.index), I.return);

			} else {
				const thisLocal = ctx.declareValue('this', thisWtype, cls.thisTsType);
				ctx.ctorThis = thisLocal;
				ctx.emit(
					I.struct.new_default(cls.typeIndex),
					I.local.set(thisLocal.index),
				);
				emitCtorStatements(ctor.body!, cls, ctx);
				ctx.emit(I.local.get(ctx.ctorThis!.index), I.return);
			}

			info.body = ctx.toFuncBody(ctor.params.length + (ctor.rest ? 1 : 0), toValType);
			info.body.id = key;
		});
		return info;
	}

	// `args`/`callerCtx` pick which overload applies when `name` has more than one real body (`resolveOverload`) -- irrelevant, safe to pass an empty probe list, when there's only one (the common case).
	// `typeArgs`: an explicit call-site type argument list for a generic *method*'s own type params
	// (`obj.map<number>(f)`) -- distinct from, and layered on top of, `owner`'s own class-level type
	// params, which are already fully concrete by the time `owner` (a real `ClassInfo`) exists at all.
	function ensureMethod(owner: ClassInfo, name: string, args: Expr[], callerCtx: FuncCtx, typeArgs?: Type[]): FuncInfo | undefined {
		const decls = owner.methodDecls.get(name);
		// Not overridden by `owner` itself -- delegate straight to the ancestor's own compiled function
		// (cached under *its* own key, e.g. `A.greet`, not `owner.name`'s) rather than recompiling a
		// duplicate copy under `owner`'s name. Sound and free: wasm-GC struct subtyping (`ensureClass`'s own
		// `supertypes`) makes a `(ref Derived)` value directly callable wherever `(ref A)` is declared, no
		// cast needed -- this is the whole reason a non-overridden inherited method stays a single, plain,
		// statically-resolved `call`, exactly as if there were no inheritance involved at all.
		if (!decls)
			return owner.superClass && ensureMethod(owner.superClass, name, args, callerCtx, typeArgs);
		let decl = resolveOverload(`${owner.name}.${name}`, decls, args, callerCtx);
		// Qualified so it can share `funcs` with plain top-level functions (bare identifiers can't contain
		// '.') without colliding; only suffixed when there's a real overload set to disambiguate.
		let key = decls.length > 1 ? `${owner.name}.${name}#${decls.indexOf(decl)}` : `${owner.name}.${name}`;

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
			const map = inferTypeArgMap(decl.typeParams, decl.params, args, typeArgs, callerCtx);
			key += `<${decl.typeParams.map(p => T.typeKey(T.resolve(global, map.get(p.name)!))).join(',')}>`;
			decl = {
				...decl,
				typeParams: undefined,
				params: decl.params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteType(p.typeAnnotation, map) } : p),
				rest: decl.rest?.typeAnnotation ? { ...decl.rest, typeAnnotation: T.substituteType(decl.rest.typeAnnotation, map) } : decl.rest,
				returnType: decl.returnType ? T.substituteType(decl.returnType, map) : decl.returnType,
				body: decl.body ? substituteTypeParams(decl.body, map) : decl.body,
			};
		}

		const existing = funcs.get(key);
		if (existing)
			return existing;
		if (!decl.body)
			throw new Error(`towasm: '${owner.name}.${name}' needs a body (overload signatures are not supported)`);

		const result = decl.returnType ? typeOf(decl.returnType) : 'void';
		if (!result)
			throw new Error(`towasm: '${owner.name}.${name}' has an unsupported return type`);

		const params = decl.params.map(p => resolveParam(p));
		if (decl.rest?.typeAnnotation)
			params.push({key: decl.rest.key, wtype: typeOf(decl.rest.typeAnnotation)!, tsType: decl.rest.typeAnnotation});

		const isStatic		= decl.modifiers?.includes('static');
		const reassignsThis = !isStatic && assignsToThis(decl.body);
		const thisWtype		= ownerThisType(owner);
		const {funcIndex, typeIndex} = registerFunc(
			isStatic		? toParams2(params) : [{ type: toValType(thisWtype), id: 'this' }, ...toParams2(params)],
			reassignsThis	? [...toResults(result), toValType(thisWtype)] : toResults(result)
		);

		const info: FuncInfo = { params: params.map(r => r.wtype), result, funcIndex, typeIndex, defaults: decl.params.map(p => p.default), hasRest: !!decl.rest?.typeAnnotation, reassignsThis };
		funcs.set(key, info);
		worklist.push(() => {
			const ctx	= new FuncCtx(new Scope(libGlobal), result, owner);
			if (!isStatic)
				ctx.declareValue('this', thisWtype, owner.thisTsType);
			if (reassignsThis)
				ctx.appendThisOnReturn = true;
			ctx.widenedTypes = collectRangeWidenings(decl.body!, ctx.scope);
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
			decl.body!.forEach(st => emitStmt(st, ctx));
			emitTrailingUnreachable(ctx, result);
			info.body = ctx.toFuncBody((isStatic ? 0 : 1) + params.length, toValType);
			info.body.id = key.replace('.', '_').replace('#', '_');
		});
		return info;
	}

	// Every owner (boxed `number`/`boolean`, plus every class ever reached) declaring a real, non-`this`-
	// reassigning, zero-argument `name` -- the candidate set a dynamic (`any`-typed) dispatch of `name()`
	// cascades over. Deduped by physical `heapType` (several owners sharing one physical type need only one
	// `ref.test` arm). `!assignsToThis` excludes a method with no sensible write-back target through a boxed `any` value (`Array<T>.push`/etc).
	function findAnyDispatchCandidates(name: string, ctx: FuncCtx): { heapType: number; isBoxedScalar: boolean; funcInfo: FuncInfo }[] {
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

	// A real dynamic-dispatch cascade for `recv.name()` where `recv`'s static type is genuinely `any`.
	// One shared function per `(name, want)` pair, reserved immediately so call sites can `call` it right away -- but its body can only be built
	// once the full, final candidate set is known, needing every class ever discovered. `lateWorklist`, drained only once `worklist` has fully emptied, is what guarantees that.
	function ensureAnyDispatch(name: string, want: WasmType, ctx: FuncCtx): FuncInfo {
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
				throw new Error(`towasm: no reachable class (or 'number'/'boolean') declares a matching zero-argument '${name}' -- a dynamic dispatch on 'any' needs at least one real candidate`);
			const dctx = new FuncCtx(new Scope(libGlobal), want, undefined);
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
				emitCallArgs(name, c.funcInfo.params, c.funcInfo.defaults, !!c.funcInfo.hasRest, [], dctx);
				dctx.emit(I.call(c.funcInfo.funcIndex));
				coerceTop(c.funcInfo.result, dctx, want);
				return [..._cond, I.if(want === 'void' ? undefined : toValType(want), dctx.swapOut(), buildArm(i + 1))];
			}

			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(1, toValType);
			info.body.id = key.replace(/[^a-zA-Z0-9_]/g, '_');
		});
		return info;
	}

	// Every *reachable* (already `ensureClass`'d, unlike `directSubclasses`' whole-source-text set) class
	// transitively extending `owner` that overrides `name` with a real body, deepest-first -- `ref.test`
	// recognizes a value as a subtype of *every* ancestor's own struct type too (a grandchild instance
	// passes `ref.test $Child` as well as `ref.test $GrandChild`), so testing shallower candidates first
	// would wrongly stop at an ancestor's override even when the receiver's real, more-derived class has
	// its own. Depth is measured by walking each candidate's own `superClass` chain back up to `owner`.
	function collectOverridingCandidates(owner: ClassInfo, name: string): { depth: number; cls: ClassInfo }[] {
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
		return found.sort((a, b) => b.depth - a.depth);
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
	function ensureVirtualDispatch(owner: ClassInfo, name: string, ctx: FuncCtx): FuncInfo {
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
			throw new Error(`towasm: internal: virtual dispatch requested for unknown method '${owner.name}.${name}'`);

		const { funcIndex, typeIndex } = registerFunc([{ type: toValType(owner.thisWtype!), id: 'this' }, ...toParams(base.params)], toResults(base.result));
		const info: FuncInfo = { params: base.params, result: base.result, funcIndex, typeIndex, defaults: base.defaults, hasRest: base.hasRest };
		anyDispatchFuncs.set(key, info);
		funcs.set(`<virtual dispatch>.${key}`, info);
		lateWorklist.push(() => {
			const candidates = collectOverridingCandidates(owner, name).map(({ cls }) => ({ cls, funcInfo: ensureMethod(cls, name, [], ctx)! }));
			const dctx = new FuncCtx(new Scope(libGlobal), base.result, undefined);
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
			info.body.id = key.replace(/[^a-zA-Z0-9_]/g, '_');
		});
		return info;
	}


	// ===================================================================
	//  Program lowering
	// ===================================================================

	const mod		= new wasm.WasmModule();

	const reached	= reachedNames(ast);
	mod.imports = LIB_HOST_IMPORTS.filter(hi => reached.has(hi.name)).map(hi => {
		const params = hi.params.map(p => resolveParam({ key: '', typeAnnotation: p }).wtype);
		const result = hi.returnType ? typeOf(hi.returnType) ?? 'void' : 'void';
		const { funcIndex, typeIndex } = registerFunc(toParams(params), toResults(result));
		funcs.set(hi.name, { params, result, funcIndex, typeIndex });
		return { module: hi.source, name: hi.name, desc: { kind: 'func', typeIndex, id: undefined } };
	});

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
	const promotedConsts = new Set<string>();

	// Seed with every exported (real, user-level top-level) function and reserve every class name eagerly
	for (let s of ast.body) {
		if (s.type === 'export_decl')
			s = s.declaration;
		if (s.type === 'function_decl' && s.body) {
			functionDeclByName.set(s.name, s);
		} else if (s.type === 'class_decl') {
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
				if (s.kind === 'const' && (d.init.type === 'arrow' || d.init.type === 'function')) {
					functionDeclByName.set(d.name, arrowOrFunctionToDecl(d.name, d.init));
					promotedConsts.add(d.name);
				} else {
					// `foldConstants` first -- `-1`/`!true`/etc. parse as a real `unary`/`binary` node, not
					// a bare `literal` one, so checking `d.init.type === 'literal'` directly missed every
					// negative-literal (or other foldable) initializer, silently leaving that global
					// unregistered (confirmed the hard way: any function referencing it then threw
					// "unresolved identifier", unrelated to whatever else that function was doing). Reusing
					// `foldConstants` here matches `case 'switch'`'s own linear-jump-table detection, the
					// file's existing "is this expression actually a compile-time constant" idiom.
					const folded = foldConstants(d.init) as Expr;
					if (folded.type === 'literal') {
						// A top-level `let`/`const` primitive with a compile-time-constant initializer
						// becomes a real wasm global -- the same mechanism a library declaration (e.g.
						// `lib/console.ts`'s `heap`) already uses, just registered *eagerly* here rather than
						// lazily on first reference, since a user declaration's own position in `ast.body`
						// stops mattering once it's a global: every function sees the same slot regardless
						// of compile order. `mut: false` for `const` -- a genuine wasm-level compile-time
						// constant, not just a same-value-never-checked mutable slot.
						const tsType = d.typeAnnotation ?? checkerTypeOf(d.init, libGlobal);
						const wtype = typeOf(tsType);
						if (wtype && wtype !== 'void') {
							ensureGlobal(d.name, wtype, folded, s.kind !== 'const');
							promotedConsts.add(d.name);
						}
					}
				}
			}
		}
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
	const directSubclasses = new Map<string, TS.Class[]>();
	const everExtended = new Set<string>();
	for (const d of [
		...[...LIB_DECL_MAP.values()].filter((d): d is Extract<typeof d, { type: 'class_decl' }> => d.type === 'class_decl'),
		...[...userGenericClassDecls.values()].map(d => d as unknown as TS.Class & { name: string }),
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
			cached = (directSubclasses.get(className) ?? []).some(sub =>
				sub.body.some(m => m.type === 'method' && m.key === methodName && !hasMod(m, 'static'))
				|| hasDeclaredOverride(sub.name!, methodName)
			);
			declaredOverrideCache.set(key, cached);
		}
		return cached;
	}

	//top level
	const {funcIndex, typeIndex} = registerFunc([], []);
	const info: FuncInfo = {params: [], result: 'void', funcIndex, typeIndex};
	funcs.set('__toplevel', info);
	mod.start	= funcIndex;
	worklist.push(() => {
		const ctx	= new FuncCtx(new Scope(libGlobal), 'void', undefined);
		ctx.widenedTypes = collectRangeWidenings(ast.body!, ctx.scope);
		ast.body!.forEach(st => {
			if (st.type === 'export_decl' || st.type === 'function_decl' || st.type === 'class_decl' || st.type === 'type_alias_decl')
				return;
			if (st.type === 'var_decl' && promotedConsts.size) {
				const declarations = st.declarations.filter(d => typeof d.name !== 'string' || !promotedConsts.has(d.name));
				if (!declarations.length)
					return;
				emitStmt({ ...st, declarations }, ctx);
				return;
			}
			emitStmt(st, ctx);
		});
		//emitTrailingUnreachable(ctx, result);
		info.body = ctx.toFuncBody(0, toValType);
		info.body.id = '__toplevel';
	});


	// The exported function name(s) a top-level `export_decl`'s inner declaration represents, or `[]` if
	// it isn't a function export at all (a plain value global, a class, ...) -- shared below by the eager-
	// compile loop (needs the *names*) and the exports-list-building loop further down (needs the same
	// classification to build each `mod.exports` entry), so the two can't silently drift apart.
	function exportedFuncNames(s: Statement): string[] {
		if (s.type === 'function_decl' && s.body)
			return [s.name];
		if (s.type === 'var_decl')
			return s.declarations.filter(d => typeof d.name === 'string' && promotedConsts.has(d.name) && functionDeclByName.has(d.name)).map(d => d.name as string);
		return [];
	}
	const exportedNames = new Set(ast.body.filter(s => s.type === 'export_decl').flatMap(s => exportedFuncNames(s.declaration)));

	// Only *exported* top-level functions need to be compiled unconditionally here -- the exports-list
	// loop further down reads `funcs.get(name)!.funcIndex` for each and needs it to already exist. Every
	// other top-level function (reachable or not) is only ever discovered indirectly, from a real call site
	// (`emitCall`'s own `funcs.get(name) ?? compileFunc(...)`), same worklist-driven "only what's actually
	// reached gets processed" design classes/generic instantiations already get -- this file's own header
	// comment on unreachable-code handling only actually held for those, not top-level functions, until now.
	// A generic entry additionally has no single physical function to eagerly compile at all (like a generic
	// top-level class, kept out of the eagerly-seeded `classes` map for the same reason) -- only a real call
	// site (`ensureGenericFunc`) can ever produce a concrete instantiation, so an *exported* generic function
	// (no fixed signature to give the export) is a real error, not silently skipped.
	for (const f of functionDeclByName) {
		if (!exportedNames.has(f[0]))
			continue;
		if (f[1].typeParams?.length)
			throw new Error(`towasm: exported function '${f[0]}' is generic -- a generic function has no single fixed signature to export`);
		compileFunc(f[0], f[1]);
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

	for (const info of closureLiterals)
		place(info);

	// One shared rec group for every type this module ever registered, not a singleton group each --
	// wasm-GC type equivalence is structural *within* a group's own shape only up to each member's
	// position in it, but fully structural *across* separate groups (confirmed empirically, not assumed:
	// two singleton groups with identical shape -- e.g. two sibling classes adding no fields of their own
	// beyond a shared base -- canonicalize into one runtime type, which `ref.test` then can't tell apart).
	// One group sidesteps that for every type at once, with zero cost: `types[]`'s own registration order
	// already satisfies a rec group's one real requirement (a contiguous run), so this needs no reordering
	// and no index remapping, and it's monotonic -- grouping never makes two *already*-distinct types
	// collide, only ever adds distinguishing power for ones that would otherwise coincide. Func/array/
	// closure types that are *deliberately* meant to share one physical type (identical signature, see
	// `registerType`'s and `ensureClosureType`'s own dedup) are unaffected either way: that merge already
	// happened before either one ever reached `types[]`, long before grouping is decided here.
	mod.types			= { types, groupSizes: types.length ? [types.length] : [] };

	if (globals.has('heap')) {
		mod.memories	= [{ min: 1 }];
		// So a host can actually read back what got written to it (e.g. console.log's fd_write buffer) --
		// any consumer of real linear memory benefits, not just console.log specifically.
		(mod.exports ??= []).push({ name: 'memory', kind: 'memory', index: 0 });
	}
	
	
	function constGlobalInit(name: string, init: Expr | undefined, wtype: WasmType): wasm.Instr[] {
		if (init && isNullLiteral(init)) {
			if (typeof wtype === 'string' || !wtype.nullable)
				throw new Error(`towasm: global '${name}' can't be initialized to 'null'/'undefined' -- its type isn't nullable`);
			return [I.ref.null(heapTypeIndexOf(wtype))];
		}
		if (init?.type === 'literal') {
			if (typeof init.value === 'number') {
				switch (wtype) {
					case 'i32': case 'u32': return [I.i32.const(init.value)];
					case 'i64': return [I.i64.const(BigInt(init.value))];
					case 'f32': return [I.f32.const(init.value)];
					case 'f64': return [I.f64.const(init.value)];
				}
			} else if (typeof init.value === 'boolean' && wtype === 'i32') {
				return [I.i32.const(init.value ? 1 : 0)];
			} else if (typeof init.value === 'bigint' && wtype === 'i64') {
				return [I.i64.const(init.value)];
			}
		}
		throw new Error(`towasm: global '${name}' needs a compile-time-constant initializer`);
	}
	mod.globals			= Array.from(globals.entries()).map(([name, g]) => ({
		type: { mut: g.mut, type: toValType(g.wtype) },
		init: constGlobalInit(name, g.init, g.wtype),
	}));
	mod.datas			= [{ mode: 'passive', bytes: data }];

	// Every closure literal's `funcIndex` is taken by `ref.func` at its creation site -- wasm requires any function referenced that way to be "declared" first, which a declarative element segment satisfies.
	if (closureLiterals.length)
		mod.elements = [{ mode: 'declarative', reftype: { ref: 'func', nullable: true }, funcIndices: closureLiterals.map(info => info.funcIndex) }];

	for (const outer of ast.body) {
		if (outer.type !== 'export_decl')
			continue;
		for (const name of exportedFuncNames(outer.declaration))
			(mod.exports??=[]).push({ name, kind: 'func', index: funcs.get(name)!.funcIndex });
	}

	return mod;
}
