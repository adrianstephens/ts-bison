import * as fs from 'fs';
import * as path from 'path';
import * as TS from './ts-parser';
import * as JS from './js-parser';
import * as T from './type-utils';
import * as W from '../wasm-codegen';
import { Literal, Identifier, Binary, Assign, Conditional, Member, hasMod, Module as CModule } from '../common';
import { checkHoisted, typeOf as checkerTypeOf, isOptionalChainLink, narrow, inferTypeArgMap as checkerInferTypeArgMap, resolveOverload } from './checker';
import { Walker, walker, walkerB } from './walker';
import { AsmDecl, makeAsm as makeAsm0 } from '../wasm-codegen';
import { foldConstants, BuildStateMachine, collectHoistedLocals, StateMachine, SuspendBoundary } from './transform';
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
type Module			= CModule<Stmt>;
type BindingTarget	= JS.BindingTarget;
type FunctionDecl	= JS.FunctionDecl<Type>;
type MethodMember	= JS.Method<Type>;
type Scope			= T.Scope;
const Scope			= T.Scope;
const I				= wasm.I;

// ===================================================================
//  The TypeScript-side vocabulary
// ===================================================================
// The language-neutral half -- the physical type vocabulary, the codegen context and the module sections -- lives in `../wasm-codegen`, imported as `WT`.
// What is left here is either about a compiled FUNCTION's shape (`FuncSig` and friends, `Local`/`Global`), or a rule about TypeScript's own type *spellings*
// (`rawElemKind`); neither belongs in a language-neutral module. `T.isNullLiteral`/`T.LITERAL_PRIMITIVES`/`READONLY_ALIAS` are those spelling rules.
// `FuncSig` extends `WT.ClosureSig` with the binding data only argument-binding reads (`defaults`/`resolvedParams`/`restElem`), which is what lets `WT.Type` name no language type at all.
// That binding data is kept BESIDE each closure payload (`closureWtype`), not in it.

// The element kind of a `RawArray<T>`: a typed-array tag names its own PACKED kind directly, since
// resolving it as a type would widen `u8` to `u32` and silently give byte storage an i32 element.
function rawElemKind(a: Type | undefined, resolve: (t: Type) => W.Type | undefined): W.ElementI {
	return a && a.type === 'ref' && !a.typeArgs && T.WASM_PSEUDO_TYPES.has(a.name)
		? W.notUnsigned(a.name as W.Element) : W.elementKind(a && resolve(a));
}

// A function value's own properties that its closure struct stores, by field index (after `code` and `env`).
export const CLOSURE_FIELDS = new Map([['length', 2]]);

// `defaults`: only ever set for a function TYPE with a bare `p?: T` (optional, no `=`) trailing param (`case 'function'`'s own comment);
// a closure *literal*'s own params can never be optional (a real, separate restriction, unaffected), so this stays `undefined` for every other producer.
// `resolvedParams`: those same params before flattening to bare `WasmType`s, needed by `emitCallArgs` when a default value itself reads an earlier parameter (`resolveParams`'s own comment), not a standalone literal.
// Set for a real user function/method/constructor, and for a function TYPE that carries defaults of its own -- a type derived from a declaration (`typeof f`, a method's type) keeps them.
interface FuncSig extends W.ClosureSig	{ defaults?: (Expr | undefined)[]; resolvedParams?: ResolvedParam[]; restElem?: ResolvedParam }
// A signature with `hasRest`/`defaults` definitely settled -- but `resolvedParams`/`restElem` are
// genuinely absent (no params at all, no rest), so they stay optional through `Required`.
type FullSig = Required<Omit<FuncSig, 'resolvedParams' | 'restElem'>> & Pick<FuncSig, 'resolvedParams' | 'restElem'>;
interface FuncInfo extends FuncSig	{ funcIndex: number; typeIndex: number, body?: wasm.FuncBody; reassignsThis?: boolean }
export interface Inline extends FuncSig	{ inline: wasm.Instr[] }
interface ClosureTypeInfo			{ funcTypeIndex: number; structTypeIndex: number; sig: FuncSig }
type TupleT = Extract<Type, { type: 'tuple' }>;


const LIB_DIR		= path.join(__dirname, 'lib');
// Globbed, not listed: a hardcoded list fails SILENTLY when a new lib file is forgotten -- the declarations simply do not exist, and the first sign is an unrelated "unknown class"/"unresolved identifier".
// `readdirSync` order is filesystem-dependent, so it is sorted for a reproducible build, with `lib.d.ts` pinned first: it declares the pseudo-types and ambient host modules the rest are written against.
// `lib/node/*` is deliberately NOT included -- on-demand modules resolved through the loader (see `ModuleLoader.nodeBuiltin`), not part of this always-linked flat scope.
const LIB_FILES		= ['lib.d.ts', ...fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.ts') && f !== 'lib.d.ts').sort()];
export const LIB_AST	= LIB_FILES.flatMap(f => TS.parse(fs.readFileSync(path.join(LIB_DIR, f), 'utf8')).body);
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
// The ambient `declare module '...'` blocks are always the LIB's own (`lib.d.ts` is always loaded); only the `import` statements naming one have to be looked for per body.
// `source` matching an *ambient* `module_decl` (not a filename) discriminates a host import from an ordinary intra-lib one (e.g. regexp.ts's `import { StringParser } from './string'`).
// So an on-demand `lib/node/*` module can declare a host import of its own instead of having to register it in a static lib file.
const LIB_AMBIENT_MODULES = new Map(LIB_AST.filter((n): n is Extract<TS.Stmt, { type: 'module_decl' }> => n.type === 'module_decl' && !!n.ambient).map(n => [n.name, n]));

function hostImportsIn(body: TS.Stmt[]): HostImport[] {
	return body.filter((n): n is JS.Import => n.type === 'import' && LIB_AMBIENT_MODULES.has(n.source)).flatMap(imp => (imp.specifiers ?? []).flatMap(s => {
		const decl = LIB_AMBIENT_MODULES.get(imp.source)!.body.find(d => d.type === 'function_decl' && d.name === s.imported);
		return decl?.type === 'function_decl' ? [{ source: imp.source, name: s.local, params: decl.params.map(p => p.typeAnnotation!), returnType: decl.returnType }] : [];
	}));
}

const LIB_HOST_IMPORTS: HostImport[] = hostImportsIn(LIB_AST);

interface MethodDelegate 			{ owner: ClassInfo; method: string }
// Per-operand info for builtin dispatch -- wtype for kind-polymorphic dispatch, owner for identity dispatch.
interface OperandInfo { wtype: W.Type | undefined; owner?: ClassInfo }
// `typeArgs`: the call site's own type arguments, for an inline whose declared types mention the METHOD's own type parameters (`Array._alloc<T>(n): T[]`).
// Class-level defines are baked once per instantiation and cannot carry these -- see `makeAsm`'s `$ret`.
export type Builtin<T = Inline | MethodDelegate | FunctionDecl> = (args: OperandInfo[], ctx: FunctionContext, typeArgs?: Type[]) => T



class ClassInfo extends W.ClassInfo {
	methodDecls		= new Map<string, MethodMember[]>();
	inlineMethods?:	Map<string, Builtin<Inline>>;
	// Where this class was DECLARED: its own module's scope and canonical path, so a method body compiled from
	// another module can resolve the names its own file declares. Absent for a lib class or a synthesized shape.
	declScope?:		Scope;
	// Built for an unnamed object type, so reached only through that type (`ensureAnonObjectShape`), never matched for another.
	anonymous		= false;
	// Narrows the base's own recursive member, or every walk of the chain would lose the fields above.
	declare superClass?:	ClassInfo;

	constructor(name: string, typeIndex: number, public decl: TS.Class, public thisTsType: Type) {
		super(name, typeIndex);
	}

	// The declared type of `key`: `decl` first, then the resolved shape. A composite cache key (`Field<Type>`)
	// is never a resolvable name, so `thisTsType` is what named and anonymous shapes both carry.
	fieldDeclaredType(key: string, scope: Scope): Type | undefined {
		const m = this.decl.body.find((m): m is JS.Field<Type> => m.type === 'field' && m.key === key);
		if (m)
			return m.typeAnnotation;
		const resolved = T.resolveObjectType(this.thisTsType, scope);
		if (resolved) {
			const p = resolved.members.find(p => p.type === 'property' && p.key === key);
			if (p?.type === 'property')
				return p.typeAnnotation;
		}
		return undefined;
	}
}



// What a plain `return expr;` means here -- ordinarily coerce `expr` to `ctx.result` and emit a wasm `return` (`plainReturn`).
// A generator/async step function, a constructor or a `reassignsThis` method each redefine it.
// Those redefinitions are the IteratorResult protocol, Promise resolution, implicit/appended `this`, ... -- set once by `compileGeneratorFunc`, `compileAsyncFunc`, `ensureCtor` or `ensureMethod`.
// Read by `case 'return'`; a `case 'try'` with a `finally` temporarily swaps in the *outer* meaning to reconstruct a real return once `finally` has run.
interface ReturnHandler {
	wtype(ctx: FunctionContext): W.Type | undefined;
	emit(ctx: FunctionContext, argument: Expr|undefined): void;
};
// `calleeDefault`: a default no call site can re-emit (a call, a capture, `this`). Its slot is an optional one and
// `declareParams` applies the default in the callee, which is where JS evaluates it anyway.
interface ResolvedParam { key: BindingTarget; wtype: W.Type; tsType: Type; calleeDefault?: { value: Expr; tsType: Type } }

interface Global extends W.Local {init: Expr, mut: boolean}

class FunctionContext extends W.FunctionContext {
	// Set when this FuncCtx is a nested `function_decl`'s own body that's allowed to call itself by name: a call to `name` resolves to a direct, statically-known `call funcIndex` (reusing the same env).
	// It can't go through a closure struct, since the struct being constructed can't reference itself while it's still being built -- see `emitClosureLiteral`'s `allowSelfCall`.
	selfCall?:			FuncInfo;

	// Populated once, right after construction, by `collectRangeWidenings` -- a `let`/`var` declarator whose reassignments push its numeric range wider than its own initializer alone gives
	widenedTypes?:		Map<JS.Var<Type>, Type>;
	// Populated once by `collectDefinePropertyTargets`: the plain local names (not full scope-aware identity like `widenedTypes`, an accepted simplification)
	// ever used as `Object.defineProperty`'s own target later in this same body, so that declarator can allocate its class's own extension subclass instead of the plain one.

	// This function's own top-level statement list (not descending into a nested closure's own body -- the same boundary `ownBoundNames`/`collectFreeVars` use), consulted only by `ensureForwardHolder`.
	// It finds a sibling `const`/`let` declared LATER in this same body that an EARLIER closure literal needs to forward-reference; set once after construction, alongside `widenedTypes`.
	ownBody?:			Stmt[];
	// Declarators whose initializers are compiling right now, innermost last -- see `ensureForwardHolder`.
	initializing?:		JS.Var<Type>[];

	// A one-shot hint for the *very next* expression about to be compiled: the enclosing declaration's own real TS type (a var_decl's `Expr[]`, or one array literal element's own `Expr`).
	// Used only to contextually infer a generic call's own type param (`inferCallTypeArgs` feeds it to the checker's `inferTypeArgMap`, the `expected` vs `sig.returnType` step).
	// Set by `case 'var_decl'` and `case 'array'`'s per-element loop; always consumed-then-cleared by `case 'call'`, so it never leaks into an unrelated sub-expression (a call's own arguments, a nested literal).
	// Deliberately narrow -- not a general "expected type" channel threaded through every expression.
	contextualReturn?:	Type;

	// Updated by `emitStmt`'s own entry point, from each statement's own `(stmt as any).scope` checker stamp (`scopeOfStmt`'s comment) -- `scope` itself stays the one static, whole-function scope set at construction.
	// Consulted only by the two real union-member-dispatch fallbacks (`case 'member'`/`case 'index'`) that need a receiver's real *narrowed* type (`switch (m.type) { case 'm1': m.a ...}`).
	// Every other lookup still goes through `scope` directly, since a lib generic method body's own stamp reflects its unresolved template type params, not the concrete per-instantiation substitution `scope` carries.
	// (`case 'var_decl'`'s own longstanding bypass, just above, hit this same tension first.)
	stmtScope?: Scope;
	get typeScope(): Scope { return this.stmtScope ?? this.scope; }

	constructor(name: string, public scope: Scope, public onReturn: ReturnHandler, public owner?: ClassInfo, public homeModule = '.') {
		super(name);

	}

	declareValue(name: string, wtype: W.Type, tsType: Type, pinned = false): W.Local {
		this.scope.addValue(name, tsType);
		return this.declareLocal(name, wtype, pinned);
	}

	// No real wasm local -- storage is a closureEnv struct field.
	declareCaptured(name: string, tsType: Type) {
		this.scope.addValue(name, tsType);
	}


	// `tsType` is the caller's already-resolved effective `Type` (annotation, or inferred from a default) via
	// `paramType`; re-deriving it here would also need a `checker` this top-level class doesn't have.
	declareParams(params: ResolvedParam[]): JS.Stmt<Type>[] {
		const pending: JS.Stmt<Type>[] = [];
		params.forEach((p, i) => {
			if (typeof p.key === 'string' && !p.calleeDefault) {
				this.declareValue(p.key, p.wtype, p.tsType);
			} else {
				const tmpName = `#param$${i}`;
				this.declareValue(tmpName, p.wtype, p.tsType);
				const incoming: Expr = Identifier(tmpName);
				pending.push(JS.VarDecl('let', JS.Var<Type>(p.key,
					p.calleeDefault ? Binary<Expr, '??'>('??', incoming, p.calleeDefault.value) : incoming, p.calleeDefault?.tsType)));
			}
		});
		return pending;
	}

	narrowedTypeOf(e: Expr): Type {
		const unwrapped = unwrapAs(e);
		const t = this.narrowedValueTypeOf(unwrapped);
		// A value typed `never` (an exhausted switch's `default:`, tocode.ts `(type as any).type`) has no type but the asserted one.
		return unwrapped !== e && !T.unionMembers(t, this.scope).length ? checkerTypeOf(e, this.typeScope) : t;
	}

	// Where `e`'s physical type is decided. A call has no slot: its value is what the instance built, and a generic
	// instance is chosen with the NARROWED arguments (`box(v)` inside `if (v === null)` builds `{value: null}`).
	physicalScope(e: Expr): Scope {
		return e.type === 'call' || e.type === 'new' ? this.typeScope : this.scope;
	}

	narrowedValueTypeOf(unwrapped: Expr): Type {
		const base = checkerTypeOf(unwrapped, this.physicalScope(unwrapped));
		// `any` counts as well as a real union: a field read off a NARROWED union receiver (`w.body` inside `if (w.kind === 'w')`)
		// has no baseline, since `ctx.scope` still sees the whole union, on which `body` doesn't exist. Every divergence the
		// union-only guard protected against needs `ctx.scope` to have a real answer, so an `any` baseline can't reach one.
		if (!this.stmtScope || !(T.isAny(base) || T.resolve(this.scope, base).type === 'union'))
			return base;
		const narrowed = checkerTypeOf(unwrapped, this.stmtScope);
		return T.isAny(narrowed) ? base : backToDeclaredMembers(narrowed, base, this.scope);
	}

	// Emit `fn` with `ctx.stmtScope` refined by `test` holding (or failing), for a ternary's or logical operator's own branch.
	// Narrowing reaches codegen only through `stmtScope`, and the checker stamped a scope on STATEMENTS alone -- so a receiver
	// narrowed by the very expression being emitted (`p ? p.typeArgs![0] : x`) was invisible and every read through it fell
	// back to `any`. `typeScope`, not `scope`, so a branch inside an already-narrowed statement composes rather than resets.
	// `branch`'s own stamp (`stampBranch`, checker.ts) comes first: re-deriving reaches the same scope only when `ctx.typeScope`
	// is the one the checker used, which a substituted generic body's deliberately is NOT (see `substituteTypeParams`) -- and
	// where that stamp is correctly absent, this falls back to the same re-derivation.
	inNarrowed<R>(branch: Expr, test: Expr, sense: boolean, fn: () => R): R {
		const saved = this.stmtScope;
		this.stmtScope = (branch as any).scope as Scope ?? narrow(test, this.typeScope, sense);
		try {
			return fn();
		} finally {
			this.stmtScope = saved;
		}
	}

	// A `NS.name` read: qualified by a namespace import rather than by a local binding.
	isNamespaceValue(e: Expr & { type: 'member' }): boolean {
		return e.object.type === 'identifier' && !this.lookup(e.object.name) && this.scope.namespace(e.object.name)?.decl(e.property)?.type === 'var_decl';
	}

	withContext<R>(contextual: Type | undefined, fn: () => R): R {
		const saved = this.contextualReturn;
		this.contextualReturn = contextual;
		try {
			return fn();
		} finally {
			this.contextualReturn = saved;
		}
	}

	// Like `checkerTypeOf(e, ctx.scope)`, but when a receiver's unnarrowed type is a real union, prefer the enclosing
	// statement's `ctx.stmtScope` when it actually narrows that union (`switch (m.type) { case 'm1': m.a }` needs it).
	// `ctx.scope` is the baseline and wins whenever it isn't a union -- `stmtScope`'s stamped type can otherwise diverge
	// for reasons unrelated to narrowing (a synthetic, towasm-only identifier the checker never stamped reads bare `any`;
	// a lib generic body's stamp reflects its template, not the concrete per-instantiation substitution `ctx.scope` has;
	// the checker can fully structuralize where `ctx.scope` keeps its clean nominal `ref`) -- only mattering once a union is.
	// A type guard call (`x is P`, not `asserts`) its argument's type settles: `true` when every value of that type is a `P`,
	// `false` when none can be, `undefined` when only the value can tell. Decided by the checker's own comparability.
	staticGuard(test: Expr): boolean | undefined {
		if (test.type === 'unary' && test.operator === '!') {
			const inner = this.staticGuard(test.operand);
			return inner === undefined ? undefined : !inner;
		}
		if (test.type !== 'call')
			return undefined;
		const scope	= this.typeScope;
		const fn	= T.resolveOwn(checkerTypeOf(test.callee, scope), scope);
		if (fn.type !== 'function' || fn.typeParams?.length)
			return undefined;
		const pred = fn.returnType;
		if (pred?.type !== 'predicate' || pred.asserts || !pred.assertedType)
			return undefined;
		const arg = test.arguments[fn.params.findIndex(p => p.key === pred.paramName)];
		if (!arg || arg.type === 'spread')
			return undefined;
		const a = this.narrowedTypeOf(arg), p = pred.assertedType;
		if (T.isAny(a))
			return undefined;
		if (T.isAssignable(a, p, scope, scope, true))
			return true;
		return T.unionMembers(a, scope).some(m => T.isAssignable(m, p, scope, scope, true) || T.isAssignable(p, m, scope, scope, true)) ? undefined : false;
	}


	// Shared by emitGeneratorDispatch/emitAsyncDispatch: `case 'switch'`'s dispatch + nested blocks (innermost =
	// segment 0) shape, generalized to resume states. A resumed call has no structured nesting, so 'goto'/'branch'
	// writes the new state and `br`s back; 'suspend'/'complete' are caller-supplied (both always `return`).
	// `onSegmentStart(id)` runs first, each caller's own resume-side sent-value write-back (a generator's is
	// unconditional; an async function's is gated to a real Promise suspension only, unboxing `#sent` first).
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


// ===================================================================
// Inline `__asm` -- the TypeScript spelling
// ===================================================================
// The island itself is in `../wasm-codegen` and is language-free. What is here is only what TypeScript alone can
// answer: the SPELLING (recognising the call, and reading the WAT text and the declared types off it) and
// the types -- what a declared type lowers to, and what a `TYPEINDEX` operand names against the signature
// its own call settled on.

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

// A structural `{[k: string]: V}` type has no nominal class, so it gets no owner; routed to `Map<string, V>`, whose `get`/`set` (`case 'index'`) plus `delete`/`has`/`keys` already cover it.
// Purely a shared-implementation choice, invisible to the source: real `{}`/bracket/`delete`/`in`/`for...in` stays genuine syntax.
export function indexSignatureValueType(w: Type): Type | undefined {
	if (w.type !== 'object' || w.members.length !== 1)
		return undefined;
	const m = w.members[0];
	return m.type === 'index' && m.paramType.type === 'ref' && m.paramType.name === 'string' ? m.typeAnnotation : undefined;
}

interface AsmCodegen {
	// The general declared-type mapper, for a declared type `asmDeclaredType` has no case for (an alias, a
	// class). Absent at the module-level builtin registry, which is built before any compile scope exists.
	typeOf?: (t: Type) => W.Type | undefined;
	// The wasm type index a representation was registered at. A `TYPEINDEX` operand needs one, and only a
	// caller with the type section in hand can answer.
	typeIndexOf?: (w: W.Type) => number | undefined;
}

// What a declared type in an asm signature STORES -- not `typeOf`, since a signature may name a packed element
// kind (`i8`/`u8`) that `T.resolve` leaves unresolved and `builtinTypes` doesn't carry, so it comes from the
// neutral `WT.pseudoValueType`; `resolve` answers the rest.
function asmDeclaredType(t: Type, resolve?: (t: Type) => W.Type | undefined): W.Type | undefined {
	if (t.type === 'ref') {
		if (t.name === 'RawArray')
			return W.ARRAY[rawElemKind(t.typeArgs?.[0], x => asmDeclaredType(x, resolve))];
		if (!t.typeArgs) {
			const builtin = builtinTypes.get(t.name)?.wtype;
			if (builtin)
				return builtin;
			if (T.WASM_PSEUDO_TYPES.has(t.name))
				return	t.name === 'i8' || t.name === 'i16' ? 'i32'
					:	t.name === 'u8' || t.name === 'u16' ? 'u32'
					:	t.name;
		}
	}
	if (t.type === 'array') {
		if (t.element.type === 'ref' && T.WASM_PSEUDO_TYPES.has(t.element.name))
			return W.ARRAY[W.notUnsigned(t.element.name)];
		const arr = W.notUnsigned(W.scalarKind(asmDeclaredType(t.element, resolve)));
		return arr ? { arr } : W.ARRAY.ref;
	}
	return resolve?.(t);
}


// A `const f = __asm<[...], R>('...')` declaration or a bare `__asm<...>('...')(args)` call -- the two
// spellings `isAsm`/`isAsmMethod` recognise. Everything about the BODY is `../wasm-codegen`'s; read here is the
// island's TypeScript spelling, and answered here are its types.
function makeAsm(call: JS.Call<Type>, codegen: AsmCodegen, defines?: Record<string, string|number>, typeParams?: string[]): Builtin<Inline> {
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

	const [paramsTuple, resultType] = call.typeArgs ?? [];
	const declared = paramsTuple?.type === 'tuple' ? paramsTuple.elements.map(te => {
		const el = T.tupleElementType(te);
		if (!el)
			throw `unsupported inline-asm param type '${T.tocode.tupleElement(te)}'`;
		return el;
	}) : [];
	const isOpenParam = (t: Type | undefined): boolean => !t ? false
		: t.type === 'ref' ? !!typeParams?.includes(t.name)
		: t.type === 'array' ? isOpenParam(t.element)
		: false;
	// An OPEN type parameter, unsubstituted because this call site gave no explicit type arguments: `T[]` still
	// falls back to `arr:ref` in `asmDeclaredType`, but a bare `T` had none, so `Array._fill(a, i, x, n)` threw
	// instead of letting the per-call signature take the argument's real physical type (`isOpenParam`, in `declFor` below).
	const resolveType = (t: Type): W.Type | undefined => isOpenParam(t) ? W.REF_ANY_NULLABLE : asmDeclaredType(t, codegen.typeOf);
	const generic = !!typeParams?.length || asm.includes(WAT.TYPEINDEX_MACRO);

	// The signature ONE call settled on, in concrete representations -- all `../wasm-codegen` needs of TypeScript's
	// types. Declared types are substituted with the call site's type arguments first, so `__asm<[i32], T[]>`
	// resolves `T[]` to a real element kind instead of the `arr:ref` an unsubstituted `T` falls back to.
	const declFor = (typeArgs: readonly Type[] | undefined, argWtypes: readonly (W.Type | undefined)[]): AsmDecl => {
		const subs = typeParams?.length && typeArgs?.length ? new Map(typeParams.map((n, i) => [n, typeArgs[i]] as const)) : undefined;
		const sub = (t: Type) => subs ? T.substituteType(t, subs) : t;
		const params = declared.map(t => {
			const wt = resolveType(sub(t));
			if (!wt)
				throw `unsupported inline-asm param type '${T.tocode.type(t)}'`;
			return wt;
		});
		const result = resultType ? resolveType(sub(resultType)) : 'void';
		if (!result)
			throw `unsupported inline-asm result type '${T.tocode.type(resultType)}'`;
		// With no explicit type arguments (`Array._copy(dst, 0, src, 0, n)`) an open parameter is still unsubstituted
		// and `resolveType` can only fall back for it; the ARGUMENT in such a position already carries the physical
		// type the callee will receive, so use it -- but ONLY there: a closed position (`start: i32`, `val: T` against
		// an `f64` array) still needs its real declared type, or a coercion the caller's own emit would have inserted silently disappears.
		const finalParams = !subs && typeParams?.length
			? params.map((w, i) => isOpenParam(declared[i]) && argWtypes[i] ? argWtypes[i] : w)
			: params;
		// Every declared type this call has an answer for, keyed by the type as written. A `TYPEINDEX` operand is
		// looked up here rather than by position: where a type parameter is still open, `T[]` alone resolves to the
		// `arr:ref` fallback while this signature has already taken `arr:f64` from the argument -- and an `array.copy`
		// whose operand type disagreed with its operands emitted wasm that would not even encode.
		const known = new Map<string, W.Type>();
		declared.forEach((t, i) => known.set(T.typeKey(t), finalParams[i]));
		if (resultType)
			known.set(T.typeKey(resultType), result);
		return { params: finalParams, result, typeIndex: (text: string): number | undefined => {
			const m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*((?:\[\s*\]\s*)*)$/.exec(text);
			if (!m)
				throw `inline asm '${asm}': TYPEINDEX("${text}") is not a name-and-'[]' type expression`;

			let t: Type = TS.RefType(m[1]);
			for (let i = m[2].split('[').length - 1; i > 0; i--)
				t = TS.ArrayType(t);

			const wt = known.get(T.typeKey(t)) ?? resolveType(t);
			const index = wt && codegen.typeIndexOf?.(wt);
			if (index === undefined)
				throw `inline asm '${asm}': TYPEINDEX("${text}") has no wasm type index`;
			return index;
		} };
	};

	// The island, prepared once. A `$T`-switched body needs no signature at all -- the numeric type its arguments
	// agree on IS its signature -- so `PreparedAsm` distinguishes it rather than taking an optional one.
	const prepared = makeAsm0({ asm, defines, generic, paramCount: declared.length });
	return prepared.switched	? (args, ctx)			=> prepared.render(args.map(a => a.wtype), ctx)
		: generic				? (args, ctx, typeArgs)	=> prepared.render(args.map(a => a.wtype), ctx, declFor(typeArgs, args.map(a => a.wtype)))
		: (args, ctx) => prepared.render(args.map(a => a.wtype), ctx, declFor(undefined, []));
}

// `Uint8Array`/`Int32Array`/`Uint32Array` are real generic instantiations of `TypedArray<T>`
// (`lib/typedarray.ts`, reached through `ensureClass`'s alias resolution -- see its own comment), a struct
// wrapping a real GC byte-array `ArrayBuffer`, so they skip `types.array`'s own monomorphization entirely.
//
// `class` names which real lib class backs a primitive-level type, resolved lazily through `ensureClass`
// (`builtinTypeOwner`) for all of them alike; `Boolean` simply has none (no decl exists at all).
// Maps, not objects, here and below: indexed by names from source, where `constructor`/`toString` must not find `Object.prototype`'s.
const builtinTypes = new Map<string, { wtype: W.Type; class?: string }>([
	['void',	{ wtype: 'void' }],
	// No `class`: `any` has no single owner to dispatch a method call against (`ensureAnyDispatch` handles that
	// dynamically). NULLABLE: an `any` can hold `undefined` (a missing rest arg, an unmatched regex group), which is `ref.null`.
	['any',		{ wtype: W.REF_ANY_NULLABLE }],
	// `unknown` has no dedicated physical representation of its own -- same boxed storage as `any` (the
	// checker's own `T.isAny` already treats the two alike), just without `any`'s implicit-assignability
	// laxness on the *checking* side, which doesn't affect codegen at all.
	['unknown',	{ wtype: W.REF_ANY_NULLABLE }],
	// `object` is any non-primitive value and never null or undefined -- the same boxed storage as `any`, not nullable.
	// Without it a type parameter bounded by `object` (`<N extends object>(n: N) => ...`, erased to its bound) had no representation.
	['object',	{ wtype: W.REF_ANY }],
	['boolean',	{ wtype: 'i32', 			class: 'Boolean' }],
	['Boolean',	{ wtype: 'i32', 			class: 'Boolean' }],
	['number',	{ wtype: 'f64', 			class: 'Number' }],
	['Number',	{ wtype: 'f64', 			class: 'Number' }],
	['string',	{ wtype: W.ARRAY.i16,		class: 'String' }],
	['String',	{ wtype: W.ARRAY.i16,		class: 'String' }],
	['bigint',	{ wtype: W.ARRAY.i32,		class: 'BigInt' }],
	// Pseudo-types from `lib.d.ts` (`declare type i32 = number`, etc) -- real wasm value types, for a field/method whose storage isn't the usual `number`->`f64` mapping (see `lib/typedarray.ts`'s `Uint8Array`).
	// `class: 'Number'` because that is exactly what each one is an alias OF: without it a value that
	// happened to get a storage refinement had no method owner at all, so `let i = 0; i.toString()`
	// failed as "unknown method" where `const n: number = 0; n.toString()` worked.
	['i32',		{ wtype: 'i32',				class: 'Number' }],
	['i64',		{ wtype: 'i64',				class: 'Number' }],
	['f32',		{ wtype: 'f32',				class: 'Number' }],
	['f64',		{ wtype: 'f64',				class: 'Number' }],
	['u32',		{ wtype: 'u32',				class: 'Number' }],
]);

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
const builtins = new Map<string, Builtin>([
	...LIB_DECLS.filter(d => d.type === 'function_decl').filter(d => d.body).map(d => [d.name, () => d] as const),
	...LIB_DECLS.filter(d => d.type === 'var_decl').flatMap(d => {
		if (isAsm(d.init)) {
			const builtin = makeAsm(d.init, {}, {});
			return builtin ? [[d.name as string, builtin] as const] : [];
		}
		return [];
	}),
]);

interface AssignTarget { wtype: W.Type; old?: number; write(tee: boolean): number }



// A top-level `const name = (...) => ...` (or `= function(...) {...}`) is exactly as callable-by-name as a real
// `function_decl` -- it can never be reassigned. Promoted the same way a `function_decl` already is, so it is
// visible to every other top-level function's own `emitCall` lookup (`functionDeclByName`); `promotedConsts`
// then keeps the `__toplevel` body below from *also* compiling it as a wasted local closure.
function arrowOrFunctionToDecl(name: string, e: JS.Arrow<Type> | JS.FunctionExpr<Type>): FunctionDecl {
	return {
		type: 'function_decl', name,
		params: e.params, rest: e.rest, typeParams: e.typeParams, returnType: e.returnType,
		body: Array.isArray(e.body) ? e.body : e.body !== undefined ? [JS.Return(e.body)] : [],
	};
}

// The type a short-circuiting operator (`&&`/`||`/`??`) gives both its arms: the caller's, when both it and the
// self-inferred one are object refs -- only then does building at it rather than converting to it matter (invariance).
function wantedShape(want: W.Type | undefined, self: W.Type): W.Type {
	return typeof want === 'object' && 'ref' in want && typeof self === 'object' && 'ref' in self ? want : self;
}

interface LocalField { index: number; wtype: W.Type; tsType: Type }

// ===================================================================
//  AST queries -- names, free variables, and expression shape
// ===================================================================
// Nothing here knows about wasm: every function answers a question about the TypeScript AST.
// `collectCapturedMutables` is the substantive one -- which of a body's bindings a nested closure both captures and assigns, i.e. the locals that must become shared heap holders.

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
					T.bindingNames(d.name).forEach(n => bound.add(n));
			}
			return process(s);
		},
		// An object literal reaches statements only through its methods' bodies, each a closure boundary.
		(e, process) => (e.type === 'arrow' || e.type === 'function' || e.type === 'object') ? false : process(e)
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
			if (e.type === 'object') {
				for (const p of e.properties) {
					if (p.type !== 'spread' && typeof p.key !== 'string')
						collectFreeVars(bound, p.key.computed, free);
					if (p.type === 'spread')
						collectFreeVars(bound, p.operand, free);
					else if (p.type !== 'field')
						collectClosureFreeVars(bound, p, undefined, free);
					else if (p.value)
						collectFreeVars(bound, p.value, free);
				}
				return false;
			}
			return process(e);
		}
	).body(body);
}

const usesThis = (fn: { body?: Stmt[] }) => walkerB(undefined, (x, process) => x.type === 'this' || process(x)).statements(fn.body ?? []);

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

// For every un-annotated `let`/`var`, widens the numeric range beyond its initializer by unioning in every later
// reassignment safe to fold in: `var_decl` codegen picks storage from the initializer alone, so `let scale = 1; ...; scale = scale * 4294967296;` inside a loop gets `i32` and silently wraps.
//
//  - `x++`/`x--`/`x += <int literal>`/`x -= <int literal>`/`x = x +- <int literal>`: exempt, no range change --
//    ordinary loop counters keep today's accidentally-correct narrow type.
//  - self-referential (RHS/compound operand mentions `x`) and inside a loop: fully unbounded. Always safe -- f64
//    exactly represents every integer up to 2^53, so it only loses the narrow-type optimization.
//  - self-referential but not inside a loop (runs at most once, no compounding risk), or not self-referential at
//    all (`x = freshExpr`, no dependency on `x`'s own prior value): union in the RHS's own range.
//
// Built on `walkB`, matching `ownBoundNames`/`collectFreeVars`'s own idiom: every hook only relays `process(x)`'s own
// result, or `false` at a closure boundary, never intentionally `true` (see walkB's own doc comment in walker.ts for
// why that matters). Scope open/close is "do work, call `process(s)`, do more with what it returns" -- `for`'s own
// init declarator opens via the ordinary `case 'var_decl'` handling below (walker.ts routes a `for`'s `init` through
// the real statement walk, so that case fires for it), while `case 'for'` just bounds the loop variable's scope,
// like a shared `try`/`catch`/`finally` scope (three separate `Statement[]` fields, not their own `block` nodes).
//
// One accepted imprecision: a `for`'s `init`/`test`/`update`/`body` are all visited within one `process(s)` call, so
// `loopDepth` can't be incremented for only part of it -- an assignment to some *other* already-open variable in the
// `init` clause itself (e.g. `for (let i = (x = 5); ...)`) is treated as "inside the loop" though `init` runs once.
// Safe: only extra conservative widening, never incorrect narrowing.
//
// Known limitation: does not scan reassignments made from inside a nested closure body (mirrors `ownBoundNames`/
// `collectFreeVars`'s own closure-boundary stop, needed there for correctness) -- a captured `let` mutated only via
// a closure write keeps today's (possibly too-narrow) behavior.
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
	// "Small" means it can't push a value out of i32 range: checking only `Number.isInteger` exempted `i = i + 3000000000`
	// (a real out-of-i32-range literal), silently overflowing `i`'s wasm local once reassigned.
	const isSmallIntLit = (x: Expr) => x.type === 'literal' && typeof x.value === 'number' && Number.isInteger(x.value) && x.value >= -0x80000000 && x.value <= 0x7fffffff;

	return scoped(() => { walkerB(
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
			if (e.type === 'assign' && e.target.type === 'identifier') {
				const o = findOpen(e.target.name);
				if (o) {
					const op = e.operator;
					const isExempt = ((op === '+' || op === '-') && isSmallIntLit(e.value))
						|| (!op
							&& e.value.type === 'binary'
							&& (e.value.operator === '+' || e.value.operator === '-')
							&& e.value.left.type === 'identifier' && e.value.left.name === e.target.name
							&& isSmallIntLit(e.value.right)
						);
					if (!isExempt)
						contribute(o,
							!op ? (loopDepth > 0 && exprMentionsName(e.target.name, e.value) ? undefined : T.toRange(checkerTypeOf(e.value, scope)))
						:	op === '??' || loopDepth > 0 ? undefined // every other compound op is self-referential by definition
						:	T.toRange(checkerTypeOf(Binary(op, e.target, e.value), scope))
					);
				}
			}
			return process(e);
		}
	).statements(body); return result; });
}

// `Object.defineProperty(target, key, {value, ...})` -- the one real, general escape hatch for dynamically attaching a
// property to an otherwise fixed-shape value (see `ensureClassExtension`'s own comment for how this compiles). Matched
// structurally (a `call` through `Object.defineProperty` by name), not by any special-cased identifier elsewhere --
// this is the one and only place that shape is recognized.
// A call to one of `Object`'s compiler intrinsics (lib.d.ts's `declare var Object`): compiled by its own emitter, never
// through `Object` as a value, which has no runtime shape to build an owner from.
const OBJECT_INTRINSICS = new Set(['entries', 'keys', 'values', 'defineProperty', 'is']);
function objectIntrinsic(e: Expr): string | undefined {
	return e.type === 'call' && e.callee.type === 'member' && e.callee.object.type === 'identifier' && e.callee.object.name === 'Object'
		&& OBJECT_INTRINSICS.has(e.callee.property) ? e.callee.property : undefined;
}
function isDefinePropertyCall(e: Expr): e is JS.Call<Type> & { callee: JS.Member<Type> } {
	return objectIntrinsic(e) === 'defineProperty';
}

// Whole-body presence check only, run before a generic function's substituted body compiles: decides conservatively
// (across every one of its own type arguments at once, not which specific one) whether `everExtended` needs poking
// *now*, before any of them could get `ensureClass`'d and their own struct type finalized first (`ensureGenericFunc`'s own comment).
function containsDefineProperty(body: Stmt[]): boolean {
	return walkerB(undefined, (e, process) => isDefinePropertyCall(e) || process(e)).statements(body);
}

// The plain local names (see `FunctionContext.definePropertyTargets`'s own comment on why this is
// name-based, not full scope-aware identity like `collectRangeWidenings`) ever used as
// `Object.defineProperty`'s own target argument anywhere in this function body, together with the
// literal keys ever defineProperty'd onto each -- `'dynamic'` once any one of them isn't a compile-
// time-literal string, since a non-enumerable key set can't be given real, individually-named fields

// `modules`/`namedImports` come from the caller via the same `ModuleLoader` the checking pass used --
// `TStoWasm` has no loader and no async boundary to make one. `namedImports` maps a local name to
// `{module, name}` (the target's declared name, possibly not the alias); `import * as X` needs no entry,
// since the checker binds `X` to the target module's `Scope` (both the declarations and their home module).
// Only top-level functions cross modules so far -- a cross-module class or scalar global still throws.
// `onTopLevelError` reports and skips a failing top-level statement rather than failing the whole module
// (they share one start function): one unrepresentable module-level `const` otherwise takes every other
// declaration in the file down with it. Omitted, it rethrows. `checkedModules` is module-level, not per
// compile: a module record outlives one `TStoWasm` call, and its stamps are first-wins.
const checkedModules = new WeakSet<Module>();


// JS `fn.length`: the parameters before the first defaulted one; a rest parameter and a TS `this` parameter never count.
function jsLength(params: { key: unknown; default?: unknown }[]): number {
	const own = params.filter(p => p.key !== 'this');
	const i = own.findIndex(p => p.default !== undefined);
	return i < 0 ? own.length : i;
}

// A `get`/`set` accessor's `methodDecls`/`inlineMethods`/`funcs` key, mangled apart from a plain same-named
// method so a getter and a setter for one property can coexist as two entries instead of overwriting each other.
function accessorKey(kind: 'get' | 'set', name: string): string {
	return `${kind}:${name}`;
}

// A structural shape's expando identity: its member names. A named shape and its anonymous twin share it, so they get
// the same expando fields and `layoutTwin` can still merge them.
function shapeKey(members: readonly TS.TypeMember[]): string {
	return `#shape#${members.flatMap(m => (m.type === 'property' || m.type === 'method') && typeof m.key === 'string' ? [m.key] : []).sort().join(',')}`;
}
function structuralKey(name: string, params: JS.Param<Type>[]): string {
	return `${name}#struct<${params.map(p => p.typeAnnotation ? T.typeKey(p.typeAnnotation) : '_').join(',')}>`;
}


function genericKey(name: string, typeParams: readonly TS.TypeParam[], map: Map<string, Type>, scope: Scope) {
	return `${name}<${typeParams.map(p => T.typeKey(T.resolve(scope, map.get(p.name)!))).join(',')}>`;
}

function homeKey(homeModule: string, name: string) {
	return homeModule === '.' ? name : homeModule + '\0' + name;
}


// What iterating `t` yields, and returns once done (TS's iteration types): read off its `[Symbol.iterator]()` iterator's
// `next()` result (`for await` tries `[Symbol.asyncIterator]` first). Without the protocol (an ES5 lib) only arrays and strings iterate.
// `iterator.next()`: JS sends `undefined` to a `next` that takes a value (a generator's).
function nextCall(iterator: Expr, it: T.IterationTypes, typeScope: Scope): Expr {
	return JS.Call(JS.Member(iterator, 'next'), T.isNullish(it.next, typeScope) ? [] : [{ type: 'identifier', name: 'undefined' }]);
}

// Substitutes a generic class's type parameters throughout its decl.
function substituteClassTypeParam(decl: JS.ClassDecl<Type>, map: ReadonlyMap<string, Type>): JS.ClassDecl<Type> {
	const out = walker(undefined, undefined, (t, process) =>
		t.type === 'ref' && map.has(t.name) ? map.get(t.name) : process(t)
	).statement(decl)!;
	// A STATIC member is restored verbatim: real TS forbids one referencing its class's type parameters, so
	// substituting into one can only corrupt a static's OWN same-named type parameter -- `Array<any>`'s
	// `_alloc<T>(n): T[]` became `any[]`, allocating `arr:ref` whatever it was called with, so `$ret` never had a chance to resolve it.
	// Order is structural, so `out.body[i]` is `decl.body[i]` throughout.
	out.body = out.body.map((m, i) => hasMod(decl.body[i] as { modifiers?: string[] }, 'static') ? decl.body[i] : m);
	return out;
}

// Applies a whole set of type-param substitutions in one `walk` pass; the caller resolves `map` for both the
// explicit-type-args and inferred-from-arguments cases (see `ensureGenericFunc`).
function substituteTypeParams(map: ReadonlyMap<string, Type>): Walker {
	return walker(
		// The checker's stamps are the TEMPLATE's scopes, where `T` is opaque: stale for an instance, which `instantiateDecl`
		// re-checks so its own narrowing (on the concrete types) is stamped afresh.
		(s, process) => { const built = process(s); delete (built as any).scope; return built; },
		(e, process) => { const built = process(e); delete (built as any).scope; return built; },
		(t, process) => t.type === 'ref' && map.has(t.name) ? map.get(t.name)! : process(t)
	);
}

// A guard can refine a union member past anything physical (`Lit<string>` out of `Lit<string | number>`),
// but a value's struct is fixed when it is built: each refined part maps back to the one member it came from.
function backToDeclaredMembers(narrowed: Type, base: Type, scope: Scope): Type {
	const r = T.resolve(scope, base);
	if (r.type !== 'union')
		return narrowed;
	const members	= T.unionMembers(r, scope);
	const declared	= new Set(members.map(m => T.typeKey(m)));
	const refined	= T.unionMembers(T.resolve(scope, narrowed), scope);
	const parts		= refined.map(p => {
		if (declared.has(T.typeKey(p)))
			return p;
		const from = members.filter(m => !T.isAny(m) && T.isAssignable(p, m, scope));
		return from.length === 1 ? from[0] : p;
	});
	return parts.some((p, i) => p !== refined[i]) ? T.combineTypes(parts) : narrowed;
}

// A default reading an earlier parameter (`b.length`) has its references rewritten to the scratch local `emitCallArgs`
// binds into, matching the grammar `isReemittableDefault` accepts.
function substituteEarlierParamRefs(e: Expr, rename: ReadonlyMap<string, string>): Expr {
	const sub = (x: Expr) => substituteEarlierParamRefs(x, rename);
	// A node actually REBUILT here loses its branch stamp (`stampBranch`, checker.ts), same as `substituteTypeParams`: the
	// stamp was taken where the original parameter names were bound and cannot resolve the scratch locals they become at the
	// call site. A node returned untouched was not rewritten, so its stamp still means what it said.
	const out = rebuild();
	if (out !== e)
		delete (out as any).scope;
	return out;

	function rebuild(): Expr {
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
}

// A CLOSURE default (`sort(compareFn = (a, b) => ...)`) is judged by what it CAPTURES: only its own params and the earlier
// params the call site already passes -- anything else is an enclosing local re-emitted out of scope.
function closureDefaultIsSelfContained(e: Expr, earlierNames?: ReadonlySet<string>): boolean {
	if (e.type !== 'arrow' && e.type !== 'function')
		return false;
	const bound = new Set<string>(earlierNames);
	for (const p of e.params)
		if (typeof p.key === 'string')
			bound.add(p.key);
	let ok = true;
	walker(undefined, (x, process) => {
		if (x.type === 'identifier' && !bound.has(x.name))
			ok = false;
		return process(x);
	}).body(e.body);
	return ok;
}

// A default is re-emitted verbatim at each omitted call site (`emitCallArgs`), so it may reference only literals or an *earlier*
// parameter (`len = b.length`); anything else would resolve against the call site's scope, so it is applied in the callee instead.
function isReemittableDefault(e: Expr, earlierNames?: ReadonlySet<string>): boolean {
	return e.type === 'literal'
		// `undefined` is a language CONSTANT, not a name to resolve: self-contained and side-effect-free, which is the property this predicate actually tests.
		// The AST has a `null` literal but no `undefined` one, so it arrives as an identifier -- and `defaultsWithImplicitUndefined` synthesizes exactly this node.
		|| (e.type === 'identifier' && e.name === 'undefined')
		|| closureDefaultIsSelfContained(e, earlierNames)
		|| (e.type === 'array' && e.elements.every(el => el !== undefined && el.type !== 'spread' && isReemittableDefault(el, earlierNames)))
		// Same reasoning as the array case, and `{}` -- an all-defaults options bag -- is the common one.
		|| (e.type === 'object' && e.properties.every(pr => pr.type === 'field' && typeof pr.key === 'string' && !!pr.value && isReemittableDefault(pr.value, earlierNames)))
		|| (e.type === 'identifier' && !!earlierNames?.has(e.name))
		|| (e.type === 'member' && !e.optional && isReemittableDefault(e.object, earlierNames))
		// An OPERATOR over things already re-emittable (`b = a * 2`, `n = -1`, `x = a ? 1 : 2`) adds no new name to resolve at the call site,
		// so it carries none of the cross-module hazard a default that *called* something would.
		|| (e.type === 'binary' && isReemittableDefault(e.left, earlierNames) && isReemittableDefault(e.right, earlierNames))
		|| (e.type === 'unary' && isReemittableDefault(e.operand, earlierNames))
		|| (e.type === 'conditional' && isReemittableDefault(e.test, earlierNames) && isReemittableDefault(e.consequent, earlierNames) && isReemittableDefault(e.alternate, earlierNames));
}

// A bare `p?: T` gets a synthesized `undefined` default, so an optional-but-defaultless trailing param can be omitted at a call site.
// A default only the callee can evaluate (`calleeDefault`) is applied there, so callers pass `undefined` for it too.
function defaultsWithImplicitUndefined(params: readonly { key: BindingTarget; default?: Expr; modifiers?: string[] }[]): (Expr | undefined)[] {
	return params.map((p, i) => p.default && isReemittableDefault(p.default, new Set(params.slice(0, i).flatMap(q => typeof q.key === 'string' ? [q.key] : []))) ? p.default
		: p.default || hasMod(p, 'optional') ? { type: 'identifier', name: 'undefined' } : undefined);
}

// An accessor's halves as `Object.defineProperty` stores them: one canonical `() => any` getter and `(v: any) => void`
// setter, so every accessor slot of a kind shares one type whatever the descriptor's own closures declared.
function getterSig(): TS.FunctionType { return { type: 'function', params: [], returnType: T.ANY }; }

function setterSig(): TS.FunctionType { return { type: 'function', params: [{ key: 'v', typeAnnotation: T.ANY }], returnType: T.VOID }; }

// The TS type of a HIDDEN field (`#ext`, an accessor's `#get:`/`#set:` companion) -- named in one place, so a derived shape
// repeating its base's hidden fields repeats them exactly and stays that base's wasm subtype. Plain expandos are `any`.
function hiddenFieldType(name: string): Type {
	return name === '#ext' ? TS.RefType('Map', [T.STRING, T.ANY])
		: name.startsWith('#get:') ? getterSig()
		: name.startsWith('#set:') ? setterSig()
		: T.ANY;
}

// A type argument that changes a generic's physical layout: a value stored unboxed, or a typed-array tag. Any other
// occupies one ref slot whatever it is, and keying on the finite set of these also bounds `Box<T[]>`-style recursion.
function ownsLayout(t: Type, scope: Scope): boolean {
	if (t.type === 'ref' && !t.typeArgs && T.WASM_PSEUDO_TYPES.has(t.name))
		return true;
	const r = T.resolve(scope, t);
	return r.type === 'ref' && (r.name === 'number' || r.name === 'boolean' || r.name === 'any');
}

// The tag is read UNRESOLVED on purpose: `T.resolve` collapses every `TypedArray` tag alike to plain `number`.
function layoutArgKey(t: Type, scope: Scope): string {
	return t.type === 'ref' && !t.typeArgs && T.WASM_PSEUDO_TYPES.has(t.name) ? t.name : T.typeKey(T.resolve(scope, t));
}

// Would these two types occupy the same wasm slot? Answered WITHOUT building a shape -- this runs before codegen -- by the same collapse `ensureClass`
// applies: a reference type argument erases, so `TemplatePart<unknown>` and `TemplatePart<Type>` are one layout (widening one would leave it unbuilt, with nothing for a dynamic read to find).
function layoutSketch(t: Type | undefined, scope: Scope, depth = 3): string {
	if (!t || depth < 0)
		return 'any';
	// A GENERIC's reference is sketched unresolved: `ensureClass` collapses reference type arguments, so
	// `TemplatePart<unknown>` and `TemplatePart<Type>` are one instantiation, which substituting them apart would hide.
	if (t.type === 'ref' && t.typeArgs?.length && !scope.type(t.name)?.isTypeParam)
		return `${t.name}<${t.typeArgs.map(a => ownsLayout(a, scope) ? layoutArgKey(a, scope) : 'ref').join(',')}>`;
	const r = T.resolve(scope, t);
	const members = T.unionMembers(r, scope).filter(m => !T.isNullish(m, scope));
	// A union of references is one `anyref`, and so is `any`/`unknown`/`object` -- `TemplatePart<unknown>`'s `exp?` and
	// `TemplatePart<Type>`'s (a union) are the same slot, while `Sig` and `Meth` are two distinct struct references.
	if (members.length > 1)
		return members.every(m => !!typeOfScalar(m, scope)) ? 'num' : 'any';
	if (r.type === 'ref') {
		if (T.isAny(r) || r.name === 'unknown' || r.name === 'object')
			return 'any';
		const scalar = typeOfScalar(r, scope);
		return scalar ?? `${r.name}<${(r.typeArgs ?? []).map(a => ownsLayout(a, scope) ? layoutArgKey(a, scope) : 'ref').join(',')}>`;
	}
	if (r.type === 'array' || r.type === 'tuple') {
		// A tuple is an `Array` of its combined element type, which is a reference whenever the positions differ.
		const el = r.type === 'array' ? r.element : T.ANY;
		return `arr:${ownsLayout(el, scope) ? layoutSketch(el, scope, depth - 1) : 'ref'}`;
	}
	if (r.type === 'object')
		return `{${r.members.flatMap(m => (m.type === 'property' || m.type === 'method') && typeof m.key === 'string'
			? [`${m.key}:${layoutSketch(T.lookupMember(r, m.key, scope), scope, depth - 1)}`] : []).sort().join(',')}}`;
	return 'ref';
}

// `number`/`boolean` are the only types stored unboxed; everything else is one reference slot.
function typeOfScalar(t: Type, scope: Scope): string | undefined {
	const r = T.resolve(scope, t);
	return r.type === 'ref' && (r.name === 'number' || r.name === 'boolean') ? r.name
		: r.type === 'literal' ? (typeof r.value === 'number' ? 'number' : typeof r.value === 'boolean' ? 'boolean' : undefined)
		: undefined;
}

// A readonly view is a checker-only distinction over the very same physical container.
const READONLY_ALIAS = new Map([['ReadonlyArray', 'Array'], ['ReadonlyMap', 'Map'], ['ReadonlySet', 'Set']]);

// The array-backed part of an intersection with one physical shape (an ARRAY carrying extra properties, e.g.
// `TemplateStringsArray`): the value IS the array. Flattened over the RAW parts, never `flattenIntersection`.
function arrayPartOf(t: Type, scope: Scope): { part: Type; element: Type } | undefined {
	// Matched on the part's own written shape, never through `resolve` -- that expands `Array<string>` into the
	// class's own object shape and loses the very thing being looked for. A TUPLE part is physically the same
	// `arr:ref`, its element the union of every position.
	const elementOf = (x: Type) => x.type === 'tuple' ? T.combineTypes(T.elementTypes(x, scope)) : T.arrayLikeElement(x);
	const arrays = T.flatParts([t], 'intersection').flatMap(part => {
		// A part whose array-ness is one resolution step away -- an alias, or a mapped type over an array.
		const element = elementOf(part) ?? elementOf(T.resolve(scope, part));
		return element ? [{ part, element }] : [];
	});
	return arrays.length && new Set(arrays.map(a => T.typeKey(a.element))).size === 1 ? arrays[0] : undefined;
}

// The primitive member of an intersection, by its own `typeofName`.
function primitivePart(t: TS.IntersectionType, scope: Scope): Type | undefined {
	return t.types.find(p => T.LITERAL_PRIMITIVES.has(T.typeofName(p, scope) ?? ''));
}


// A value with `[Symbol.iterator]()` iterates by the protocol, as JS iterates every iterable; one without (an array: the lib declares it none) is read by position.
function iteratesByProtocol(e: Expr, ctx: FunctionContext): T.IterationTypes | undefined {
	const t = ctx.narrowedTypeOf(e);
	if (!T.lookupMember(t, '[Symbol.iterator]', ctx.typeScope))
		return undefined;
	const it = T.iterationTypes(t, ctx.typeScope);
	if (!it)
		throw `'${T.typeKey(t)}' has '[Symbol.iterator]()' but its iterator has no 'next()'`;
	return it;
}

// A spread argument whose expression has a TUPLE type has a statically known length -- exactly the case real TS allows in a
// fixed-arity call ("A spread argument must either have a tuple type or be passed to a rest parameter") -- and is expanded
// into that many positional index reads, in place, so nothing is reordered. Restricted to a re-emittable expression (an
// identifier or plain property chain off one), since each element re-evaluates it; anything else still gets the error below.
function expandTupleSpreads(args: Expr[], ctx: FunctionContext): Expr[] {
	const reemittable = (e: Expr): boolean => e.type === 'identifier' || e.type === 'this'
		|| (e.type === 'member' && !e.optional && reemittable(e.object));
	return args.flatMap(a => {
		if (a.type !== 'spread' || !reemittable(a.operand))
			return [a];
		const t = T.resolve(ctx.typeScope, ctx.narrowedTypeOf(a.operand));
		if (t.type !== 'tuple')
			return [a];
		return t.elements.map((_, i): Expr => JS.Index(a.operand, Literal(i)));
	});
}



// Reads `name`'s own physical storage slot (captured field or real local) exactly as-is -- never unboxing a forward-holder,
// unlike the ordinary identifier read (`case 'identifier'`). The one caller that needs this is `emitClosureLiteral`'s
// env-capture step, which must capture the holder's real, shared storage itself, never a snapshot of what it holds now.
// An index read TS types as possibly `undefined` (`args[1]` on `[A] | [A, B]`, an optional tuple element, `(T | undefined)[]`):
// JS reads past the end as `undefined`, where `array.get` traps, so such a read is bounds-checked.
function readsPastEnd(e: Expr, ctx: FunctionContext): boolean {
	return T.unionMembers(T.resolve(ctx.typeScope, ctx.narrowedTypeOf(e)), ctx.typeScope).some(m => T.isNullish(m, ctx.typeScope));
}

// A numeric/bitwise binary op's instructions as data (`Inline`), keyed by `BINARY_OP_NAMES`'s method name
function numericOpInline(method: string, a: W.Type | undefined, b: W.Type | undefined, ctx: FunctionContext): Inline {
	const at = W.scalarKind(a), bt = W.scalarKind(b);
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
			return builtins.get('__towasm_mod')!([{wtype: t}], ctx) as Inline;
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

// Whether any instruction touches linear memory (a load/store or `memory.*` op), following only the lists that
// nest: `body` (block/loop/try_table) and `then`/`else` (if). Those are `LooseInstr` -- `Instr` can't name itself.
function touchesMemory(instrs: readonly wasm.LooseInstr[]): boolean {
	return instrs.some(i => /^(memory\.|(i32|i64|f32|f64|v128)\.(load|store))/.test(i.op)
		|| ('body' in i && touchesMemory(i.body))
		|| ('then' in i && (touchesMemory(i.then) || !!i.else && touchesMemory(i.else))));
}

// Checks builtinTypes before T.resolve to avoid expanding a hoisted class name and losing it.
function wasmTypeOf(t: Type, global: Scope): W.Type | undefined {
	if (t.type === 'ref' && !t.typeArgs && builtinTypes.has(t.name))
		return builtinTypes.get(t.name)!.wtype;
	if (t.type === 'range' && t.base === 'number')
		return t.integer && t.min !== undefined && t.max !== undefined ? W.intType(t.min as number, t.max as number) : 'f64';
	// rangeToType collapses a single-value range to a Literal -- needs the same bounds check or it widens to f64.
	if (t.type === 'literal' && typeof t.value === 'number')
		return Number.isInteger(t.value) ? W.intType(t.value, t.value) : 'f64';
	// A type with no inhabitant but null/undefined (`Literal<null>` from a narrowed `e.value === null`) holds only `ref.null`.
	if (T.isNullish(t, global) && !T.isRef(T.resolveOwn(t, global), 'void'))
		return W.REF_ANY_NULLABLE;

	// Resolve each union member first so alias duplicates collapse before arrayElemKind.
	const w = T.widenLiterals(t.type === 'union' ? T.combineTypes(t.types.map(m => T.resolve(global, m))) : T.resolve(global, t), false, true);
	if (w.type === 'array' || (w.type === 'ref' && (w.name === 'Array' || w.name === 'ReadonlyArray'))) {
		const elemType = w.type === 'array' ? w.element : w.typeArgs![0];
		const we = elemType.type === 'ref' && !elemType.typeArgs && (elemType.name === 'i8' || elemType.name === 'u8') ? 'i8'
			: W.elementKind(wasmTypeOf(elemType, global));
		return we ? W.ARRAY[we] : undefined;
	}

	// A tuple's own elements can be heterogeneous, so there's no single per-element wasm kind to pick the way a real array's element type gives one.
	// Physically it's just the same boxed-`anyref` "everything else" storage a mixed/`any`-typed array already uses (`ARR_WTYPE.ref`).
	// The checker already fully tracks each element's own precise type (`type-utils.ts`'s own extensive 'tuple' handling); codegen needed only this one physical-representation mapping, nothing else.
	if (w.type === 'tuple')
		return W.ARRAY.ref;

	if (w.type === 'ref')
		return builtinTypes.get(w.name)?.wtype;

	return undefined;
}

export function TStoWasm(ast: Module, modules?: Map<string, Module>, namedImports?: Map<string, Map<string, { module: string; name: string }>>, onTopLevelError?: (e: unknown) => void): wasm.WasmModule {
	const global = ast.scope as Scope;
	if (!global)
		throw new W.Error('ast must be checked (TStypeCheck/TStypeCheckAsync) before TStoWasm');

	// `libGlobal` must be `global` itself, not a lib-only scope: one would sever the ancestor chain and hide
	// every user declaration from anything built off it (`ctx.scope`) -- confirmed real (`Point`/`Wrapper` broke).
	const libGlobal			= global;

	const classes			= new Map<string, ClassInfo>();
	// User-declared *generic* top-level classes can't be eagerly seeded into `classes` under their bare name
	// (no single physical representation for `Box<T>` alone, only each concrete instantiation) -- `ensureClass`/`resolveGenericClassRef` look here instead, the user-class equivalent of `LIB_DECL_MAP`.
	const userGenericClassDecls = new Map<string, JS.ClassDecl<Type>>();

	const funcs				= new Map<string, FuncInfo>();
	const functionDeclByName = new Map<string, FunctionDecl>();

	// Every module reachable from `ast`, entry included under `'.'`; non-entry top-level functions are keyed
	// `homeKey(canonical, name)`, so a same-named function in two files never collides in the shared caches.
	// `LIB_MODULE`: one identity for the whole static lib (see `lazyGlobalFor`) -- not a real `moduleBodies`
	// entry, since `LIB_AST` is a flat concatenation with no per-file identity; the `moduleId === '.'` cases
	// below are entry-only by design.
	const LIB_MODULE			= '#lib';
	const moduleBodies			= new Map<string, Module>([['.', ast], ...(modules ?? [])]);
	// The checker only HOISTS an imported module; codegen needs its bodies' stamps (narrowing, local annotations).
	for (const m of modules?.values() ?? []) {
		if (m.scope && !checkedModules.has(m)) {
			checkedModules.add(m);
			checkHoisted(m.body, m.scope as Scope);
		}
	}
	// The entry's scope comes from its own `Program`, an imported module's from `makeScope` (see `compileFunc`);
	// `homeModule` is optional on a `ClassInfo`, and "no module" or "no scope yet" both mean: use your own.
	function moduleScopeOf(homeModule: string | undefined): Scope | undefined {
		return homeModule === undefined ? undefined : homeModule === '.' ? global : moduleBodies.get(homeModule)?.scope as Scope | undefined;
	}

	function moduleFilename(homeModule: string): string | undefined {
		return moduleBodies.get(homeModule)?.filename;
	}
	const namedImportsByModule = namedImports ?? new Map<string, Map<string, { module: string; name: string }>>();
	// `Scope.decl(name)` gives back the declaration object but not the file it came from, and a plain top-level
	// `var_decl` (unlike a function/class) has no module-scoped registration -- so the home module is recorded here.
	const stmtHomeModule		= new Map<TS.Stmt, string>();
	// The entry module's top-level `const`/`let` declarators, by name -- see the `moduleBodies` scan's own
	// comment on why `Scope.decl` can't answer this for the entry module.
	const topLevelVars			= new Map<string, { stmt: TS.Stmt; d: JS.Var<Type> }>();	// keyed by `homeKey(module, name)`
	// An enum is COMPILE-TIME here: no runtime object, a member read folds to its constant (see `case 'member'`)
	// and the declaration emits nothing. `enumNames` lets `resolvesGlobally` report one needs no capture slot.
	const enumMembers			= new Map<string, number | string>();
	const enumNames				= new Set<string>();
	// The backing slot of each `ensureLazyGlobal` wrapper, so a WRITE can reach the same storage the
	// wrapper reads. Keyed exactly like `lazyGlobals`.
	const lazyGlobalSlots		= new Map<string, { index: number; wtype: W.Type }>();


	// `const f = __asm<...>('...')` in a user module: `builtins` is built once from `LIB_DECLS` for `lib/*.ts`
	// only, so the same declaration elsewhere failed as "call to unknown function" -- hence a per-module map.
	const moduleAsmBuiltins = new Map<string, Builtin<Inline>>();
	for (const [moduleId, body] of moduleBodies) {
		for (let s of body.body) {
			if (s.type === 'export_decl')
				s = s.declaration;
			if (s.type !== 'var_decl')
				continue;
			for (const d of s.declarations) {
				if (typeof d.name === 'string' && isAsm(d.init))
					moduleAsmBuiltins.set(homeKey(moduleId, d.name), makeAsm(d.init, {}, {}));
			}
		}
	}
	// The one place an unqualified (or namespace-resolved) name turns into a `FunctionDecl` -- a lib
	// declaration is always homeModule-independent, checked only after the calling module's own.
	function resolveDecl(homeModule: string, name: string) {
		return functionDeclByName.get(homeKey(homeModule, name)) ?? LIB_DECL_MAP.get(name);
	}
	// True for a name that resolves without ever needing a closure capture slot: reachable from anywhere via
	// the ordinary `case 'identifier'` fallback chain, regardless of lexical nesting.
	function resolvesGlobally(homeModule: string, name: string): boolean {
		return globals.has(name) || LIB_DECL_MAP.get(name)?.type === 'var_decl' || !!resolveDecl(homeModule, name)
			|| !!namedImportsByModule.get(homeModule)?.has(name)
			// A namespace import binds a compile-time namespace, not a value, so it never needs a capture slot:
			// without this, `TS.parse(...)` inside a callback read as a free variable and threw "unresolved identifier".
			|| !!moduleScopeOf(homeModule)?.namespace(name)
			// A class name is a declaration, not a value, resolved at its own use site -- `collectFreeVars` cannot
			// tell the two apart, so without this ANY closure or nested function mentioning a module-level class threw.
			|| moduleScopeOf(homeModule)?.decl(name)?.type === 'class_decl'
			// An ENUM name, for the same reason: every read of it folds to a constant at its own site.
			|| enumNames.has(homeKey(homeModule, name))
			// The same for the entry module's own top-level `const`/`let`: `hoist` deliberately doesn't hoist a
			// plain `var_decl` into a scope, so `resolveDecl` cannot see one -- `topLevelVars` is where they live,
			// and without this a closure referencing one read as a free variable ("unresolved identifier 'LIB_DIR'").
			|| topLevelVars.has(homeKey(homeModule, name));
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
	const anyFieldWriteFuncs = new Map<string, FuncInfo>();
	const anyEntriesFuncs	= new Map<string, FuncInfo>();
	// `ensureUnionFieldDispatch`'s own cache -- keyed by field name + the exact, bounded member set (not "every
	// class ever reached" like `anyDispatchFuncs`), so a union's field access can't succeed via an unrelated class.
	const unionFieldDispatchFuncs = new Map<string, FuncInfo>();
	// `ensureUnionIndexDispatch`'s own cache -- same "keyed by the exact, bounded member set" reasoning as
	// `unionFieldDispatchFuncs`, just for `arr[i]` reads instead of `.property` access.
	const unionIndexDispatchFuncs = new Map<string, FuncInfo>();
	// A named function used as a *value*, not called directly: one shared zero-capture wrapper per function
	// name, not per use site -- populated the first time another expression shape needs it (callback, return...).
	const functionValueWrappers = new Map<string, FuncInfo>();
	// A closure *value* whose concrete signature has a narrower/nullable-mismatched result than the slot it is
	// coerced into (real TS covariant-return assignability, e.g. `(x: number) => number` fitting one returning
	// `number | undefined`) -- one shared trampoline per (source, wanted) pair. See `ensureClosureCoercionWrapper`.
	const closureCoercionWrappers = new Map<string, { info: FuncInfo; wantStructTypeIndex: number; envTypeIndex: number }>();
	// `adoptingDecl`'s answer per class, `null` for one that adopts no storage.
	const adoptingDecls = new Map<ClassInfo, { decl: MethodMember; storage: W.Type & { arr: W.ElementI } } | null>();
	const anyKeyFuncs = new Map<'get' | 'set', FuncInfo>();

	const closureLiterals: FuncInfo[] = [];
	const closureTypes		= new Map<string, ClosureTypeInfo>();
	// Which DECLARATION each object shape was built from (`Scope.type`'s own entry): two modules can declare the
	// same name (`Common.Member` and js-parser's own `Member`, which adds `optional?`), and a shape keyed by
	// name alone handed the second one the first's struct.
	const shapeEntries		= new Map<ClassInfo, unknown>();
	const shapeModuleTag	= new Map<unknown, string>();
	const moduleTagOf = (name: string, entry: unknown): string => {
		let tag = shapeModuleTag.get(entry);
		if (tag === undefined) {
			tag = '';
			for (const [mod, body] of moduleBodies)
				if (mod !== '.' && (body.scope as Scope | undefined)?.type(name) === entry) {
					tag = mod;
					break;
				}
			shapeModuleTag.set(entry, tag);
		}
		return tag;
	};
	// A hit on `name` that belongs to a DIFFERENT declaration of that name. Only a real type name can say so:
	// `ensureClass` is also asked for a shape by its own key (`want.ref`), which names no declaration at all.
	const otherDeclaration = (info: ClassInfo, name: string, declScope?: Scope): boolean => {
		const asked = shapeEntries.has(info) ? (declScope ?? global).type(name) : undefined;
		return !!asked && shapeEntries.get(info) !== asked;
	};
	const data				= new W.DataSection;
	const globals			= new Map<string, Global>;
	// `ensureLazyGlobal`'s own wrapper `FuncInfo`s, keyed the same `homeKey` way as `funcs` itself.
	const lazyGlobals		= new Map<string, FuncInfo>;

	const types	= new W.Types;

	// One tag for the whole module -- JS/TS `catch(e)` is untyped and catches any thrown value regardless of its real TS type, so there's no reason for more than one
	const tags				= new W.TagSection;
	const ensureExceptionTag = () => tags.exception(types);

	// A closure referencing a SIBLING const/let declared later in the same block (mutually recursive local
	// closures, e.g. walker.ts's `mapStatementC` capturing `mapStatement`) has no local to capture: the
	// ordinary capture copies the current value into the closure's env at creation time (`rawSlot`).
	// Make the missing local an `ensureHolderType` holder -- closure and sibling's var_decl share one storage,
	// so the value is visible once assigned, whichever order they compile in.
	// Its type comes from a shallow scan of `ctx.ownBody`'s top-level `var_decl`s (never into a nested closure,
	// whose locals are never siblings); only a plain single-name declarator is handled, and a non-sibling name
	// returns `undefined`, leaving the "unresolved identifier" throw.
	function ensureForwardHolder(ctx: FunctionContext, name: string): W.Local | undefined {
		// Its own initializer's declarator first: a self-reference may sit in any nested block (a switch case,
		// `objectKeyNames`), which the shallow top-level scan misses -- and its holder then lands in the right scope.
		const d = ctx.initializing?.slice().reverse().find(d => d.name === name)
			?? ctx.ownBody?.flatMap(s => s.type === 'var_decl' ? s.declarations : []).find(d => d.name === name);
		// A sibling function declaration not yet created: mutual recursion (checker.ts `typeOf`'s `recurse` and `recurseUncached`).
		const fd = d ? undefined : ctx.ownBody?.find((s): s is Extract<Stmt, { type: 'function_decl' }> => s.type === 'function_decl' && s.name === name && !!s.body);
		if (fd) {
			const fnType = (fd as { scope?: Scope }).scope?.value(name) ?? checkerTypeOf({ ...fd, type: 'function' } as Expr, ctx.scope);
			const fnWtype = typeOf(fnType);
			return fnWtype ? declareHolder(ctx, name, fnWtype, fnType) : undefined;
		}
		if (!d)
			return undefined;
		const tsType = d.typeAnnotation ?? (d.init && checkerTypeOf(d.init, ctx.scope));
		if (!tsType)
			return undefined;
		const wt = typeOf(tsType);
		return wt ? declareHolder(ctx, name, wt, tsType) : undefined;
	}


	// Promotes `name` to a shared, heap-allocated one-field holder -- the physical form a captured BINDING
	// needs, so that a write from either side of the capture is seen by the other.
	function declareHolder(ctx: FunctionContext, name: string, wt: W.Type, tsType: Type): W.Local {
		if (process.env.DBGHOLDER)
			console.error(`HOLDER ${ctx.name}.${name}`);
		// The holder's field must be DEFAULTABLE (allocated before the declaration that fills it runs): a reference is
		// nullable, but a scalar stays RAW -- `types.nullable` would box it, and `holderInner` must describe the value.
		const holderTypeIndex = types.holder(toValType(typeof wt === 'string' ? wt : types.nullable(wt)));
		const local = ctx.declareValue(name, { typeIndex: holderTypeIndex, nullable: false }, tsType);
		local.holderInner = wt;
		ctx.emit(I.struct.new_default(holderTypeIndex), I.local.set(local.index));
		return local;
	}

	// Memoized per function: which of this body's own locals a nested closure captures AND something
	// assigns (`collectCapturedMutables`). Those must be holders, not plain wasm locals.
	function needsHolder(ctx: FunctionContext, name: string): boolean {
		// Never at module scope: a top-level binding is already shared (a real wasm global or `ensureLazyGlobal`'s
		// slot), so a holder there would leave the global and the holder as two separate storages.
		if (!ctx.ownBody || ctx.ownBody === ast.body)
			return false;
		ctx.holderNames ??= collectCapturedMutables(ctx.ownBody);
		return ctx.holderNames.has(name);
	}

	function toResults(result: W.Type): wasm.ValType[] {
		return result === 'void' ? [] : [toValType(result)];
	}
	function toParams(params: W.Type[]): wasm.ParamType[] {
		return params.map(p => ({ type: toValType(p) }));
	}
	function toParams2(params: ResolvedParam[]): wasm.ParamType[] {
		return params.map((p) => ({ type: toValType(p.wtype), id: typeof p.key === 'string' ? p.key : undefined }));
	}
	function builtinTypeOwner(name: string) {
		const bt = builtinTypes.get(name);
		return bt?.class ? ensureClass(bt.class) : undefined;
	}

	// Whether `init` is something a real wasm global can be initialized from -- a folded scalar literal, and
	// nothing else. A string is still a `literal` node but its physical value is an i16 array built at runtime,
	// and a `bigint` only qualifies on a real `i64` slot; everything rejected here belongs to `ensureLazyGlobal`.
	// Returns the FOLDED initializer the global must actually be registered with (`-99` is a `unary` node and
	// the emitter accepts only a literal), so the test and the value used can't drift apart.
	function eagerGlobalInit(init: Expr, typeAnnotation?: Type): Expr | undefined {
		const folded = foldConstants(init);
		if (folded?.type !== 'literal')
			return undefined;
		const kind = W.notUnsigned(W.scalarKind(typeOf(typeAnnotation ?? checkerTypeOf(init, libGlobal))));
		return kind && (typeof folded.value === 'number' || typeof folded.value === 'boolean' || (typeof folded.value === 'bigint' && kind === 'i64'))
			? folded : undefined;
	}

	function ensureGlobal(name: string, wtype: W.Type, init: Expr, mut: boolean) {
		if (!globals.has(name))
			globals.set(name, {wtype, index: globals.size, init, mut});
		return globals.get(name)!;
	}

	// A top-level `const X = someFactory(...)` -- the pervasive declarative-DSL idiom -- has no wasm representation
	// until something calls the factory, and real globals can only be initialized from a compile-time constant,
	// so it is lazy-on-first-use (the user's explicit call over eager cross-module init ordering): a mutable
	// nullable global starts `null` and a wrapper computes and caches the real value on first call.
	// `d.init` is compiled with `declScope` as the wrapper's own home scope, so any name it references (another
	// lazy global, a sibling function) resolves against ITS OWN declaring module, not the caller's -- `hoist()`'s
	// `exportScope` loop stamps `addDecl` for exactly this shape.
	function ensureLazyGlobal(name: string, homeModule: string, d: JS.Var<Type>, declScope: Scope): FuncInfo | undefined {
		// `const f = __asm<[...], R>('...')` DECLARES a builtin and holds no value, so returning `undefined` lets the
		// reference fall through to `moduleAsmBuiltins`. Guarded here rather than in `lazyGlobalFor` because
		// `case 'call'`'s closure-valued-const path reaches this function directly.
		if (d.init && isAsm(d.init))
			return undefined;
		const key = homeKey(homeModule, name);
		const existing = lazyGlobals.get(key);
		if (existing)
			return existing;

		// An imported module's scope only carries its EXPORTS, so a non-exported module-level binding has
		// no declared type there -- ask the checker for its initializer's instead, in that same scope.
		const checkedType = declScope.value(name) ?? (d.init && checkerTypeOf(d.init, declScope));
		// `typeOf` has no answer for a bare anonymous object shape (only a named class, an index signature or
		// an all-call-signature one), so give it the same synthesized struct an object literal targeting that
		// shape already gets, or a `const D: {a: number} = {...}` has no representation to cache into.
		const resolved = checkedType && T.resolve(global, checkedType);
		const wt = (checkedType && typeOf(checkedType))
			?? (resolved?.type === 'object' ? ensureAnonObjectShape(resolved)?.thisType : undefined);
		if (!wt || wt === 'void' || !d.init)
			return undefined;
		const g = ensureGlobal(`$lazy$${key}`, types.nullable(wt), Identifier('undefined'), true);
		lazyGlobalSlots.set(key, g);

		const { funcIndex, typeIndex } = types.func([], toResults(wt));
		const info: FuncInfo = { params: [], result: wt, funcIndex, typeIndex };
		lazyGlobals.set(key, info);
		worklist.push(W.withCatch(() => {
			const ctx = new FunctionContext(name, new Scope(declScope), plainReturn(wt), undefined, homeModule);
			// Hand-emitted, not `emitStmt`/AST-synthesized like the file's other desugarings -- `wtypeOf`/`checkerTypeOf`
			// can't see `slotName` at all (never real source the checker type-checked); only `d.init` itself goes through the
			// checker-aware `emitAs`. Emits `if (slot === null) slot = <init>; return slot!;`.
			ctx.emit(I.global.get(g.index), I.ref.is_null);
			ctx.emitIf(undefined, () => {
				// The declared type is the initializer's context, as for a local: `[{...}]` builds `Rules<Mod>`'s own shape.
				ctx.withContext(checkedType, () => emitAs(d.init!, ctx, g.wtype));
				ctx.emit(I.global.set(g.index));
			});
			// `coerceTop`, not a bare `ref.as_non_null`: `types.nullable` BOXES a scalar slot, so for an
			// `i32`/`f64` const the slot holds a box while this wrapper's signature promises the scalar.
			ctx.emit(I.global.get(g.index));
			coerceTop(g.wtype, ctx, wt);
			ctx.emit(I.return);
			info.body = ctx.toFuncBody(0, toValType);
		}, name, homeModule));
		return info;
	}


	// A class REFERENCE written as an expression -- a bare name or a namespace-qualified one (`T.Scope`, through an
	// `import * as T`) -- resolved to the class's own name plus the scope to look it up in. A qualified reference
	// resolves in the NAMESPACE's own scope, not the caller's, so both names land on the same physical class.
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

	// A top-level `const X = C`/`const X = T.C`: a class has no runtime value here (nominal, never first-class), so such a const is a compile-time alias, not a global to evaluate.
	// `ensureClass` resolves through it and `__toplevel` emits nothing; `seen` guards a self- or mutually-referential chain.
	function classAliasTarget(name: string, scope: Scope, seen = new Set<string>(), homeModule = '.'): { name: string; scope: Scope } | undefined {
		if (seen.has(name))
			return undefined;
		seen.add(name);
		const varStmt	= scope.decl(name);
		const d			= varStmt?.type === 'var_decl' ? varStmt.declarations.find(v => v.name === name) : topLevelVars.get(homeKey(homeModule, name))?.d;
		return d?.init ? classRefTarget(d.init, scope, seen) : undefined;
	}

	// `scope`: where to resolve `name` -- the reading function's own by default, or an `import * as NS`
	// namespace's scope for an `NS.name` read, reaching the same const its qualified name does (`case 'member'`).
	function lazyGlobalFor(name: string, ctx: FunctionContext, scope: Scope = ctx.scope) {
		const varStmt	= scope.decl(name);
		const own		= varStmt?.type === 'var_decl'
			? { stmt: varStmt as TS.Stmt, d: varStmt.declarations.find(d => d.name === name) }
			: scope === ctx.scope ? topLevelVars.get(homeKey(ctx.homeModule, name)) : undefined;
		if (!own?.d) {
			// A named import of another module's const (`import { isJsStatement } from './walker'` in printer.ts): the same lazy
			// global under its DECLARING module's identity, since the reading module's own scope never declares it.
			const imported	= scope === ctx.scope ? namedImportsByModule.get(ctx.homeModule)?.get(name) : undefined;
			const target	= imported && topLevelVars.get(homeKey(imported.module, imported.name));
			if (imported && target?.d) {
				const wrapper	= ensureLazyGlobal(imported.name, imported.module, target.d, moduleScopeOf(imported.module) ?? scope);
				const slot		= lazyGlobalSlots.get(homeKey(imported.module, imported.name));
				return wrapper && slot ? { wrapper, slot } : undefined;
			}
			// A module-level binding in a STATIC lib file (`LIB_AST`): those files are never in `moduleBodies`, so they are
			// absent from `topLevelVars`, but share one flat `libGlobal` -- so the identity must be a FIXED one, since falling
			// back to `ctx.homeModule` would give each referencing module its own copy of the same shared state.
			const lib = LIB_DECL_MAP.get(name);
			if (lib?.type === 'var_decl' && lib.init && !isAsm(lib.init)) {
				const wrapper	= ensureLazyGlobal(name, LIB_MODULE, lib as unknown as JS.Var<Type>, libGlobal);
				const slot		= lazyGlobalSlots.get(homeKey(LIB_MODULE, name));
				return wrapper && slot ? { wrapper, slot } : undefined;
			}
			return undefined;
		}
		const homeModule	= stmtHomeModule.get(own.stmt) ?? ctx.homeModule;
		// `scope` is only where `name` was FOUND: an `NS.name` read finds it in the module's export scope, which lacks
		// that module's own imports. The initializer compiles in its home module's own scope, as its functions do.
		const wrapper		= ensureLazyGlobal(name, homeModule, own.d, moduleScopeOf(homeModule) ?? scope);
		const slot			= lazyGlobalSlots.get(homeKey(homeModule, name));
		return wrapper && slot ? { wrapper, slot } : undefined;
	}

	// A top-level `const` naming something already declared elsewhere (a class, a cross-module binding) has no module-init effect: reads resolve through `ensureClass`/`lazyGlobalFor` to the real declaration.
	// The start function must emit nothing for it -- evaluating it would demand a physical representation in EVERY module declaring the alias.
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

	// Every class in the program, scanned once for a plain named `superClass` reference: shared by `ensureClass`'s `final` flag and virtual dispatch, which both need the whole inheritance graph known up front.
	// `final` can't be decided lazily: wasm-GC only lets a non-final struct be another's `supertypes` entry once its type is registered. Keyed by bare declared name (`Box<T>` matches `Box`).
	const directSubclasses	= new Map<string, TS.Class[]>();
	const everExtended		= new Set<string>();

	// A base class's own statically-enumerable `Object.defineProperty` keys (`'dynamic'` once any isn't a literal), accumulated across every declarator in the program allocated as the extended form.
	// Populated at each `case 'var_decl'`'s compile time (see its comment); `ensureClassExtension` reads it lazily, keyed the same bare-name way `everExtended` is.
	const pendingExtensions = new Map<string, string[] | 'dynamic'>();
	// `(shape or class name) -> keys` some `Object.defineProperty(x, 'k', { get })` turns into an ACCESSOR. Each gets a
	// companion `#get:k` field holding the getter, which every read of `k` consults first (`emitFieldRead`).
	const accessorKeys = new Map<string, Set<string>>();

	// Whether any class transitively extending `className` declares its own non-static `methodName` -- decided from whole-program source (`directSubclasses`), not the lazily populated `classes` set.
	// `emitMethodCall` uses this to skip `ensureVirtualDispatch`: with no override reachable, a direct `ensureMethod` call is already correct and optimal. Memoized per pair.
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


	// The raw {params, result, hasRest, defaults} for one `TS.CallSig`-shaped signature -- shared by a bare function TYPE (`case 'function'`) and each member of an overloaded object type (`mergeOverloadSigs`).
	// Both are the same shape, so the substitution logic isn't duplicated. `undefined` only when the return type can't be represented -- an unrepresentable param still throws.
	// A rest parameter's own physical type, which must be an array or `emitCallArgs` cannot pack into it.
	function restParamWtype(t: Type): W.Type | undefined {
		const wt = typeOf(t);
		if (storageKindOf(wt) !== undefined)
			return wt;
		const elems = T.elementTypes(t, global);
		return elems.length ? typeOf(TS.ArrayType(T.combineTypes(elems))) : wt;
	}

	function closureSigParts(sig: TS.CallSig): FullSig | undefined {
		// The type-annotation-side twin of `emitClosureLiteral`'s own comment: same bound substitution, same free-when-bounded reasoning.
		const func = T.baseSignature(sig, T.ANY);
		// Naming the whole signature, not just the parameter: one of these reaches a caller from some
		// enclosing declaration's own type, and the parameter name alone rarely says which.
		const sigText = () => T.typeKey({ type: 'function', ...sig } as Type);
		const defaults = defaultsWithImplicitUndefined(func.params);
		const omittable = (i: number) => !!defaults[i] && T.nullLiteralKind(defaults[i]!) === 'undefined';
		const params = func.params.map((p, i) => {
			// `void` is valid TS in a param position but has no wasm value, so box it as `any` like any other "no meaningful value" position rather than rejecting valid source.
			const wt = p.typeAnnotation && typeOf(p.typeAnnotation);
			const boxed = wt === 'void' ? W.REF_ANY : wt;
			if (!boxed)
				throw `function type parameter '${describeBinding(p.key)}': '${p.typeAnnotation ? T.typeKey(p.typeAnnotation) : '<no annotation>'}' has no representation, in '${sigText()}'`;
			// A slot a caller may fill with `undefined` (a bare `p?: T`, or a default only the callee can apply) is nullable;
			// a re-emitted default always arrives. Same rule as `resolveParam`, or the two physical signatures disagree.
			return omittable(i) ? types.nullable(boxed) : boxed;
		});
		// Always built: an UNANNOTATED closure parameter takes its type from the callee's declared
		// signature (`emitClosureLiteral`), which needs the TS type and not just the physical one. It widens with a nullable
		// slot, as `resolveParam`'s does: an imported module's callback reaches here unannotated, and `x === undefined` needs it.
		const resolvedParams = func.params.map((p, i) => ({ key: p.key, wtype: params[i], tsType: omittable(i) ? T.combineTypes([p.typeAnnotation!, T.UNDEFINED]) : p.typeAnnotation! }));
		let hasRest = false;
		// The rest ELEMENT as well as the array: a closure literal with more parameters than the
		// signature has fixed ones takes each extra one from here, and binds it out of the rest array.
		let restElem: ResolvedParam | undefined;
		if (func.rest?.typeAnnotation) {
			const wt = restParamWtype(func.rest.typeAnnotation);
			if (!wt || wt === 'void')
				throw "a function type's rest parameter needs an explicit array type";
			params.push(wt);
			resolvedParams.push({ key: func.rest.key, wtype: wt, tsType: func.rest.typeAnnotation });
			hasRest = true;
			const element = arrayPartOf(func.rest.typeAnnotation, global)?.element;
			const ewt = element && typeOf(element);
			if (element && ewt)
				restElem = { key: func.rest.key, wtype: ewt === 'void' ? W.REF_ANY : ewt, tsType: element };
		}
		let result = func.returnType ? typeOf(func.returnType) : 'void';
		// A function TYPE's return annotation is a genuine declared-type position (unlike `typeOf`'s own 'object' case, see `ensureAnonObjectShape`): an inline `{value: T; consumed: number}` still needs a representation.
		// Scoped to exactly this spot, not a general `typeOf` fallback -- that collides with a NAMED type whose `ref` wrapper `T.combineTypes` flattened away.
		if (!result && func.returnType) {
			const returnResolved = T.resolve(global, func.returnType);
			if (returnResolved.type === 'object' && !indexSignatureValueType(returnResolved)) {
				const cls = ensureAnonObjectShape(returnResolved);
				result = cls?.thisType;
			}
		}
		if (!result)
			return undefined;
		return { params, result, hasRest, defaults, resolvedParams, restElem };
	}

	// A genuinely overloaded VALUE type (every member a 'call' signature): overloads are a type-checking-only fiction with one underlying function, and a value has no name (`resolveOverload` handles named groups).
	// So the overloads' physical signatures merge into ONE position by position: a param in every overload keeps its type, one missing from some becomes optional/nullable.
	function mergeOverloadSigs(sigs: FullSig[]): FullSig | undefined {
		if (!sigs.length)
			return undefined;
		const maxParams = Math.max(...sigs.map(s => s.params.length));
		const params: W.Type[] = [];
		const defaults: (Expr | undefined)[] = [];
		for (let i = 0; i < maxParams; i++) {
			const present = sigs.filter(s => s.params.length > i);
			const distinct = new Set(present.map(s => W.typeKey(s.params[i])));
			const shared = distinct.size === 1 ? present[0].params[i] : W.REF_ANY;
			if (present.length < sigs.length) {
				params.push(types.nullable(shared));
				defaults.push(Identifier('undefined'));
			} else {
				params.push(shared);
				defaults.push(undefined);
			}
		}
		const resultKinds = new Set(sigs.map(s => W.typeKey(s.result)));
		return { params, result: resultKinds.size === 1 ? sigs[0].result : W.REF_ANY, hasRest: sigs.some(s => s.hasRest), defaults };
	}


	// The `ClassInfo` a type REFERENCE names. A namespace-qualified ref resolves its leaf in the NAMESPACE's scope, since `ensureClass` never splits on '.'.
	// Without that it built a shape-only stand-in colliding with the real class. Scoped to a leaf that really is a CLASS there: a dotted interface or alias keeps its structural path.
	function ensureClassRef(t: TS.RefType): ClassInfo | undefined {
		const dot = t.name.lastIndexOf('.');
		if (dot > 0) {
			const leaf	= t.name.slice(dot + 1);
			const ns	= ((t.declScope as Scope | undefined) ?? global).lookupScope(t.name.slice(0, dot).split('.'));
			// A class by its declaration, an interface or alias by its TYPE entry (`JS.CallSig<Type>`): both resolve in the
			// namespace's own scope, so the dotted and the bare spelling reach the one struct.
			if (ns && (ns.decl(leaf)?.type === 'class_decl' || ns.type(leaf)))
				return ensureClass(leaf, t.typeArgs, ns);
		}
		return ensureClass(t.name, t.typeArgs, t.declScope as Scope | undefined);
	}

	// A SELF-REFERENTIAL type has no single physical shape, so re-entering `typeOf` on one already being computed boxes as `any` (as the union case does for an unrepresentable member).
	// The cycle is between `typeOf` calls, not inside one, so `T.resolve`'s cycle guard never sees it -- a function type taking itself overflowed the stack on checker.ts's declarations.
	const typeOfActive = new Set<Type>();
	function typeOf(t: Type): W.Type | undefined {
		if (typeOfActive.has(t))
			return W.REF_ANY;
		typeOfActive.add(t);
		try {
			return typeOfUncached(t);
		} finally {
			typeOfActive.delete(t);
		}
	}
	function typeOfUncached(t: Type): W.Type | undefined {
		if (t.type === 'ref' && t.name === 'RawArray')
			return W.ARRAY[rawElemKind(t.typeArgs?.[0], typeOf)];

		// `T[]` is `Array<T>`, an ORDINARY lib class -- the compiler has no array representation of its own (see
		// [[tison-array-identity]]); `Array<T>`/`ReadonlyArray<T>` already reach the class via the generic-ref branch below.
		if (t.type === 'array') {
			const cls = ensureClass('Array', [t.element]);
			if (cls)
				return cls.thisType;
		}
		// A tuple is an array in TS too, and `ownerFor` already dispatches its methods through `Array` (`tupleArrayOwner`) -- same representation, or a tuple read back out would be cast to a type nothing built.
		if (t.type === 'tuple') {
			const cls = tupleArrayOwner([t]);
			if (cls)
				return cls.thisType;
		}

		if (t.type === 'ref' && t.typeArgs?.length) {
			const name = READONLY_ALIAS.get(t.name) ?? t.name;
			const decl = LIB_DECL_MAP.get(name) ?? userGenericClassDecls.get(name);
			if (decl?.type === 'class_decl' && decl.typeParams?.length) {
				const cls = ensureClass(name, t.typeArgs);
				if (cls)
					return cls.thisType;
			}
		}

		const resolved = T.resolve(global, t);
		switch (resolved.type) {
			// A type that RESOLVES to an array or tuple (an alias, an indexed access `N[K]`) is an `Array` like the `T[]` spelling
			// above -- falling through to `wasmTypeOf` gave it RAW storage, which nothing casts back to.
			case 'array': {
				const cls = ensureClass('Array', [resolved.element]);
				if (cls)
					return cls.thisType;
				break;
			}
			case 'tuple': {
				const cls = tupleArrayOwner([resolved]);
				if (cls)
					return cls.thisType;
				break;
			}
			case 'object': {
				if (openShapes.has(T.typeKey(resolved)))
					return W.REF_ANY;
				const vt	= indexSignatureValueType(resolved);
				const cls	= vt && ensureClass('Map', [TS.RefType('string'), vt]);
				if (cls)
					return cls.thisType;
				if (resolved.members.length && resolved.members.every(m => m.type === 'call')) {
					const sigs = resolved.members.map(closureSigParts);
					// Every overload must resolve, or this isn't attempted at all -- a partial merge would silently
					// misrepresent the physical signature rather than fall through to the caller's own unresolved-type error.
					if (sigs.every((s): s is FullSig => !!s)) {
						const merged = mergeOverloadSigs(sigs);
						if (merged)
							return closureWtype(merged);
					}
				}
				break;
			}
			// An ARRAY carrying extra properties (`TemplateStringsArray`, `WithTextPos<T> = T & {pos}`, `interface RegExpMatchArray extends Array<string>`)
			// is physically just the array: the extras get no slot, so reading one is an honest `unknown field` rather than a wrong answer, and erasing them
			// keeps such a value assignable to a plain array parameter with no conversion, the way real TS subtyping already allows. Only the array part is
			// typed -- an ordinary `Array` -- so object parts never build (or register) anonymous shapes merely because someone asked whether they're
			// array-backed; falls through to the flatten-and-merge path below when no part is array-backed at all (an interface extending another
			// interface), or when two parts disagree on the element kind.
			case 'intersection': {
				const arr = arrayPartOf(resolved, global);
				if (arr)
					return typeOf(TS.ArrayType(arr.element));
				const prim = primitivePart(resolved, global);
				if (prim)
					return typeOf(prim);
				break;
			}
			case 'union': {
				const nonNullish = resolved.types.filter(m => !T.isNullish(m, global));
				if (nonNullish.length < resolved.types.length && nonNullish.length > 0) {
					const base = typeOf(nonNullish.length === 1 ? nonNullish[0] : TS.UnionType(nonNullish));
					if (!base)
						return undefined;
					return types.nullable(base);
				}
				// A real union of >=2 members (not the nullable-collapse case above): `unionStructOwners`/`ensureUnionFieldDispatch` own the separate
				// "which classes member-access can dispatch to" question, still scoped to struct-backed unions because `ref.test` needs a per-member target.
				// Here the question is only whether every member's representation collapses to the same `WasmType`: `IteratorResult<Y,R>.value` with `Y`/`R` both
				// `number` must stay a plain `f64`, not box as `any` just for having >1 syntactic member; genuinely differing members (class vs class, scalar vs
				// scalar, scalar vs struct/array, e.g. `Literal.value: string | number | boolean | null | TemplatePart[]`) box as `any`, like every other
				// "could be one of several shapes" value (an unconstrained generic, a caught exception).
				if (nonNullish.length > 1) {
					const memberWtypes = nonNullish.map(typeOf);
					// A member with no representation of its own (a nested union hitting this same case, or an unrepresentable shape) is trivially
					// "not the same physical type as everything else" -- still a reason to box as `any`, not to give up on the whole union.
					if (!memberWtypes.every((w): w is W.Type => w !== undefined))
						return W.REF_ANY;
					return W.combineUnion(memberWtypes);
				}
				break;
			}
			// A type predicate (`t is Foo`) is a checking-time refinement with no representation of its own: as a plain value it IS a boolean,
			// and an `asserts` one yields nothing at all -- exactly the reduction the checker applies at a call site whose result is used as a value.
			case 'predicate':
				return resolved.asserts ? 'void' : typeOf(T.BOOLEAN);

			case 'function': {
				const parts = closureSigParts(resolved);
				if (!parts)
					throw `a function type has an unsupported return type: '${resolved.returnType ? T.typeKey(resolved.returnType) : 'void'}' in '${T.typeKey(resolved)}'`;
				const { params, result, hasRest, defaults } = parts;
				// Not memoized by physical signature: `resolvedParams` carries this signature's own TS types, and an unannotated
				// closure parameter takes its type from them -- `(x?: Stmt) => boolean` and `(x?: Stmt[]) => boolean` share one physical shape.
				return closureWtype({ params, result, hasRest, defaults, resolvedParams: parts.resolvedParams, restElem: parts.restElem });
			}
		}
		if (t.type === 'ref') {
			const cls = ensureClassRef(t);
			if (cls)
				return cls.thisType;
		}
		// Tried regardless of whether `t` itself is a `ref` (not an `else if`): `ensureClass` only resolves a BARE name (`scope.type(name)` never splits on
		// '.'), so a namespace-qualified ref (`TS.TypeParam`, from `import * as TS from '...'`) that already resolves down to a plain 'object' shape would
		// otherwise never reach this fallback -- a gap only for a dotted ref resolving straight to an object, not a union (which goes through the separate
		// 'union' case above). It is still only reached when `ensureClass` had no nominal name to resolve by (a class currently mid-construction resolving
		// its own name already returned above, so this never preempts it); a generic parameter's own structural bound (`Record<string, any>`) substituted
		// with a real interface-typed argument is the one case actually anonymous by construction (`matchObjectShapeByType`'s own comment). An interface
		// `extends`ing another resolves to a real INTERSECTION rather than an 'object' (`ownerFor`'s own intersection case says the same), so a
		// namespace-qualified ref to one (`JS.CallSig<any>`, which is `{typeParams?; returnType?; ...} & Params<any>`) reached neither `ensureClass`
		// (dotted name) nor the object branch below, and had no representation at all; flattened through the shared `resolveObjectType`, so this agrees
		// with `ownerFor` on the shape.
		const flat = resolved.type === 'object' ? resolved : resolved.type === 'intersection' ? T.resolveObjectType(resolved, global) : undefined;
		if (flat) {
			const shapeMatch = matchObjectShapeByType(flat) ?? ensureAnonObjectShape(flat);
			if (shapeMatch)
				return shapeMatch.thisType;
		}
		return wasmTypeOf(t, global);
	}


	// The `WasmType` a value expression resolves to -- `classOf`/`arrayKindOf` below are thin discriminating views over this checker walk.
	// `unwrapAs`: see that function's own comment -- the checker's `typeOf` must see the real (post-`as`) expression, not the asserted one.
	function wtypeOf(e: Expr, ctx: FunctionContext): W.Type | undefined {
		// `ctx.scope` FIRST: a value's physical type is its slot's, and control-flow narrowing never changes that. Asking
		// `narrowedTypeOf` outright broke `let p: Point | null = null; p = new Point(...); p === null` -- the narrowed type is
		// `Point`, so the comparison was rejected as having no nullable operand, even though the slot it lives in is still
		// nullable. `narrowedTypeOf` only fills in where `ctx.scope` has no answer at all: a read off a receiver narrowed out
		// of `T | undefined` (`if (!r) return; r.min`) comes back `any` there.
		const unwrapped	= unwrapAs(e);
		const base		= checkerTypeOf(unwrapped, ctx.physicalScope(unwrapped));
		if (!T.isAny(base))
			return typeOf(base);
		// A narrowing to just null/undefined (`a = undefined`) says nothing about the slot, which is still `any`; `void` is not
		// one of those -- it is a real answer. A call that yields nothing (`u.forEach(...)`, whose receiver `ctx.scope` alone
		// sees as possibly-undefined, so `base` is `any`) must stay `void`, or the union dispatch that compiles it asks every
		// arm for a boxed value it never had.
		const narrowed = ctx.narrowedTypeOf(e);
		const isVoid   = T.isRef(T.resolveOwn(narrowed, ctx.scope), 'void');
		return typeOf(isVoid || !T.isNullish(narrowed, ctx.scope) ? narrowed : base);
	}




	// Every remaining value of an iterator, into a new array: what JS's `...` does with an iterable, and a rest pattern.
	function drainIterator(iterator: Expr, it: T.IterationTypes, ctx: FunctionContext): Expr {
		const arrName = `#iter$${ctx.tempCounter++}`, rName = `#iter$${ctx.tempCounter++}`;
		const arr: Expr = Identifier(arrName), r: Expr = Identifier(rName);
		emitStmt(JS.VarDecl('const', JS.Var(arrName, { type: 'array', elements: [] } as Expr, TS.ArrayType(it.yield))), ctx);
		emitStmt(JS.For(
			JS.VarDecl('let', JS.Var(rName, nextCall(iterator, it, ctx.typeScope))),
			JS.JSUnary('!', JS.Member(r, 'done')),
			Assign<Expr, never>(r, nextCall(iterator, it, ctx.typeScope)),
			{ type: 'expression' as const, expression: JS.Call(JS.Member(arr, 'push'), [JS.Member(r, 'value')]) },
		), ctx);
		return arr;
	}

	// A spread operand as an array: a non-array iterable's iterator drained into one, anything else as it is.
	function spreadSource(operand: Expr, ctx: FunctionContext): Expr {
		const it = iteratesByProtocol(operand, ctx);
		if (!it)
			return operand;
		const itName = `#iter$${ctx.tempCounter++}`;
		emitStmt(JS.VarDecl('const', JS.Var(itName, JS.Call(JS.Member(operand, '[Symbol.iterator]'), []))), ctx);
		return drainIterator(Identifier(itName), it, ctx);
	}

	// A destructuring pattern bound from `value` one level at a time: each level is materialized into a typed temp first, so
	// an array pattern indexes an array/tuple and iterates anything else, decided from that level's own type.
	function emitPatternBinding(kind: JS.DeclarationKind, target: BindingTarget, value: Expr, typeAnnotation: Type | undefined, ctx: FunctionContext): void {
		if (typeof target === 'string') {
			emitStmt(JS.VarDecl(kind, JS.Var(target, value, typeAnnotation)), ctx);
			return;
		}
		const temp = (): Expr => Identifier(`#destructure$${ctx.tempCounter++}`);
		const declare = (id: Expr, init: Expr, type?: Type) => emitStmt(JS.VarDecl('const', JS.Var((id as { name: string }).name, init, type)), ctx);
		const tmp = temp();
		declare(tmp, value, typeAnnotation);

		if (target.type === 'array_pattern') {
			const it = iteratesByProtocol(tmp, ctx);
			if (!it) {
				// A default applies where the element is `undefined`: past the end (the length guard -- reading past an array's end traps in
				// wasm), or present as `undefined` where the element type admits it. Never for `null`, which is a value JS keeps.
				target.elements.forEach((el, i) => {
					if (!el)
						return;
					const elem = JS.Index(tmp, Literal(i));
					emitPatternBinding(kind, el.target, el.default
						? Conditional<Expr>(
							Binary<Expr, '<'>('<', Literal(i), JS.Member(tmp, 'length')),
							readsPastEnd(elem, ctx)
								? Conditional<Expr>(Binary<Expr, '==='>('===', elem, Identifier('undefined')), el.default, elem)
								: elem,
							el.default)
						: elem, undefined, ctx);
				});
				if (target.rest)
					emitPatternBinding(kind, target.rest, JS.Call(JS.Member(tmp, 'slice'), [Literal(target.elements.length)]), undefined, ctx);
				return;
			}
			const iterator = temp();
			declare(iterator, JS.Call(JS.Member(tmp, '[Symbol.iterator]'), []));
			for (const el of target.elements) {
				const r = temp();
				declare(r, nextCall(iterator, it, ctx.typeScope));	// a hole still advances
				if (!el)
					continue;
				const got = JS.Member(r, 'value');
				emitPatternBinding(kind, el.target, el.default
					? Conditional<Expr>(JS.Member(r, 'done'), el.default, Binary('??', got, el.default))
					: got, el.default ? undefined : it.yield, ctx);
			}
			if (target.rest)
				emitPatternBinding(kind, target.rest, drainIterator(iterator, it, ctx), undefined, ctx);
			return;
		}

		if (target.rest)
			throw "a rest property ('...') in an object destructuring pattern is not supported";
		for (const prop of target.properties) {
			if (typeof prop.key !== 'string')
				throw "a computed key ('[expr]') in an object destructuring pattern is not supported";
			const propExpr = JS.Member(tmp, prop.key);
			emitPatternBinding(kind, prop.value, prop.default ? Binary('??', propExpr, prop.default) : propExpr, undefined, ctx);
		}
	}

	// Type arguments for a `new C(...)` that spells none out. Nothing is inferred: the checker solves them from the constructor's
	// own arguments (`new Set(['a'])` answers `Set<string>`), and `ctx.contextualReturn` -- the same contextual channel
	// array/object literals already read -- carries the surrounding declaration's declared type, all a no-argument `new Map`
	// has to go on. Merged per position, solved winning and contextual filling an `any`, because for some real call site each is
	// the only one that knows. Learning nothing from either deliberately falls through to `ensureClass`'s own "needs N explicit
	// type argument(s)" throw rather than silently building an `any`-typed instance.
	function newTypeArgs(name: string, explicit: Type[] | undefined, e: Expr, ctx: FunctionContext, want?: W.Type): Type[] | undefined {
		if (explicit?.length)
			return explicit;
		// Headed for another instantiation of this same class (`Map<string, Ty>` from `[[k, lit]]`): build that
		// one. Two instantiations are two different structs, so the checker's narrower answer could never convert.
		const dest = typeof want === 'object' && 'ref' in want ? classes.get(want.ref)?.thisTsType : undefined;
		if (dest?.type === 'ref' && dest.name === name && dest.typeArgs?.length)
			return dest.typeArgs;
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

	// A bare object literal with no single resolvable target type (`case 'object'`'s own `want` doesn't name one class) -- a
	// last-resort structural match against every reachable, struct-backed class/object-shape (the same "every class ever
	// discovered" scan `findAnyDispatchCandidates` uses for method dispatch, just picking which shape a literal builds as).
	// A candidate qualifies only when its own field set exactly matches the literal's property names; when several match (the
	// common discriminated-union shape, e.g. `SpreadExpr`/`OtherExpr` both `{kind, value}`), a discriminant narrows: a property
	// whose literal value matches exactly one candidate's literal-typed field declaration. Deliberately narrow -- exact fields
	// plus literal-value discrimination, not general structural subtyping -- covering nothing broader.
	// `cls`'s declared type for field `key`, for `matchObjectShape`'s discriminant check. A real class's member lives on
	// `cls.decl.body` (`JS.Field`'s `typeAnnotation`), but an object-shape type alias (`type X = {...}`, not a real class)
	// never populates that at all (`ensureObjectShape`'s own comment: `decl: { name, body: [] }`, deliberately empty), so its
	// field types are re-resolved from the original structural type the same way `ensureObjectShape` derived them when building `cls`.
	// A spread operand's own keys, resolved exactly as `case 'object'` resolves them to BUILD the spread (`ownerOf` first,
	// then the anonymous shape), so matching and construction cannot disagree about which fields a spread supplies.
	function spreadKeys(operand: Expr, ctx: FunctionContext): string[] | undefined {
		const cls = ownerOf(operand, ctx);
		if (cls)
			return cls.fields.map(f => f.name);
		const t = T.resolve(ctx.scope, ctx.narrowedTypeOf(operand));
		return t.type === 'object' && !indexSignatureValueType(t)
			? t.members.flatMap(m => m.type === 'property' && typeof m.key === 'string' ? [m.key] : [])
			: undefined;
	}

	// A literal whose SHAPE is a runtime fact: a spread of a union (`{ ...e }`, `e: Expr`), or a written discriminant
	// whose value is a union of literals (`{ type, ...sig }`, `type: 'call' | 'construct'`): the deciding value is
	// evaluated once, then pinned per arm (a typed local for the spread, the literal itself for the discriminant), so
	// ordinary shape matching picks that arm's struct -- only when every earlier property is effect-free, so reordering is safe.
	function emitUnionShapedLiteral(e: JS.ObjectExpr<Type>, ctx: FunctionContext, want: W.Type | undefined): W.Type | undefined {
		const pure = (x: Expr): boolean => x.type === 'literal' || x.type === 'identifier' || x.type === 'this' || (x.type === 'member' && pure(x.object));
		const result: W.Type = want && typeof want === 'object' && 'ref' in want && want.ref === 'any' ? want : W.REF_ANY;
		// What `f` emits, as instructions, leaving the context's own buffer as it was.
		const capture = (f: () => void): wasm.Instr[] => {
			const outer = ctx.swapOut();
			f();
			return ctx.swapOut(outer);
		};
		interface Arm { test: () => void; build: () => void }
		const cascade = ([arm, ...rest]: Arm[]): wasm.Instr[] => arm
			? [...capture(arm.test), I.if(toValType(result), capture(arm.build), cascade(rest))]
			: [I.unreachable];
		const emitArms = (arms: Arm[]) => {
			ctx.emit(...cascade(arms));
			return result;
		};
		const withProp = (i: number, q: JS.ObjectExpr<Type>['properties'][number]) => ({ ...e, properties: e.properties.map((p, j) => j === i ? q : p) }) as Expr;
		for (const [i, p] of e.properties.entries()) {
			if (!e.properties.slice(0, i).every(q => q.type === 'spread' ? pure(q.operand) : q.type === 'field' && (!q.value || pure(q.value))))
				break;
			if (p.type === 'spread') {
				const members	= T.unionMembers(T.resolve(ctx.typeScope, ctx.narrowedTypeOf(p.operand)), ctx.typeScope).filter(m => !T.isNullish(m, ctx.typeScope));
				const owners	= members.map(m => ownerFor(m));
				if (members.length < 2 || !owners.every(o => o && o.typeIndex !== -1))
					continue;
				const n		= ctx.tempCounter++;
				const src	= ctx.declareLocal(`$usrc$${n}`, W.REF_ANY_NULLABLE);
				emitAs(p.operand, ctx, W.REF_ANY_NULLABLE);
				ctx.emit(I.local.set(src.index));
				return emitArms(owners.map((o, k) => ({
					test: () => ctx.emit(I.local.get(src.index), I.ref.test(o!.typeIndex)),
					build: () => {
						const name	= `$uvar$${n}$${k}`;
						ctx.emit(I.local.get(src.index), I.ref.cast(o!.typeIndex), I.local.set(ctx.declareValue(name, o!.thisWtype!, members[k]).index));
						coerceTop(emitExpr(withProp(i, JS.Spread(Identifier(name))), ctx), ctx, result);
					},
				})));
			}
			if (p.type === 'field' && p.value && typeof p.key === 'string') {
				// Unwidened: the question is which LITERALS it can hold (`narrowedTypeOf` widens, for physical representation).
				const precise	= checkerTypeOf(unwrapAs(p.value), ctx.stmtScope ?? ctx.scope, false);
				const values	= T.unionMembers(T.resolve(ctx.typeScope, precise), ctx.typeScope).map(m => T.resolveOwn(m, ctx.typeScope));
				// Each arm's discriminant as a real literal EXPRESSION. A literal type and a literal expression are
				// both `Common.Literal`, but a type carries `fresh`/`frozen` that only widening reads, and a template
				// literal's parts are TYPES -- which has no runtime value to compare, so it can't be an arm at all.
				const literals	= values.flatMap(v => v.type === 'literal' && !Array.isArray(v.value) ? [v.value] : []);
				if (values.length < 2 || literals.length !== values.length)
					continue;
				const name	= `$udisc$${ctx.tempCounter++}`;
				const wt	= wtypeOf(p.value, ctx) ?? W.REF_ANY;
				emitAs(p.value, ctx, wt);
				ctx.emit(I.local.set(ctx.declareValue(name, wt, precise).index));
				return emitArms(literals.map(lit => ({
					test: () => { emitAs(Binary<Expr, '==='>('===', Identifier(name), Literal(lit)), ctx, 'i32'); },
					build: () => coerceTop(emitExpr(withProp(i, { ...p, value: Literal(lit) }), ctx), ctx, result),
				})));
			}
		}
		return undefined;
	}

	// `{ ...t, returnType: r }`: a spread operand with ONE known shape that already has every written key IS the
	// literal's shape, as in TS (its type is the operand's own, with those keys replaced).
	function spreadOwner(e: JS.ObjectExpr<Type>, ctx: FunctionContext): ClassInfo | undefined {
		const written = e.properties.flatMap(p => p.type === 'field' && typeof p.key === 'string' ? [p.key] : []);
		for (const p of e.properties) {
			if (p.type !== 'spread')
				continue;
			const cls = ownerOf(p.operand, ctx);
			if (cls && cls.typeIndex !== -1 && written.every(k => cls.fieldIndex.has(k)))
				return cls;
		}
		return undefined;
	}

	function matchObjectShape(e: JS.ObjectExpr<Type>, ctx: FunctionContext, anon = true): ClassInfo | undefined {
		// `props`: every key the literal PROVIDES (a spread can satisfy required fields). `explicit`: only fields
		// actually WRITTEN -- TS never excess-property-checks a spread, so a spread's extra keys must not disqualify.
		const props		= new Map<string, Expr>();
		const explicit	= new Set<string>();
		for (const p of e.properties) {
			if (p.type === 'spread') {
				const keys = spreadKeys(p.operand, ctx);
				if (!keys)
					return undefined;
				// Last source wins, in written order, as it does at runtime. A spread-sourced value is never
				// a literal, so such a key simply takes no part in the discriminant tiebreak below.
				for (const k of keys)
					props.set(k, p.operand);
				continue;
			}
			if (p.type !== 'field' || typeof p.key !== 'string' || !p.value)
				return undefined;
			props.set(p.key, p.value);
			explicit.add(p.key);
		}
		// A literal may legitimately omit a candidate's own *optional* fields (TS object-literal-against-interface
		// semantics), so this is not an exact field-SET match: it names no field the candidate lacks, and no required
		// field goes unfilled. `new Set`: one `ClassInfo` can be reachable under more than one key (a named
		// alias/interface and its structurally identical anonymous shape share one -- see `ensureObjectShape`), and
		// counting it twice fails the "exactly one candidate" test below. The field TYPES must accept the literal's
		// own values, not just share names (the same check, and the same "unknown declared type is not judged"
		// tolerance, `matchObjectShapeByType` makes), or it can't be stored in it (`{sig: Sig}` into `{sig: Meth}`).
		const fits = (cls: ClassInfo) => [...explicit].every(k => {
			const declared	= cls.fieldDeclaredType(k, global);
			const value		= props.get(k);
			return !declared || !value || T.isAssignable(checkerTypeOf(unwrapAs(value), ctx.scope), declared, ctx.typeScope);
		});
		const candidates = [...new Set(classes.values())].filter(cls =>
			cls.typeIndex !== -1 && !cls.anonymous && [...explicit].every(k => cls.fieldIndex.has(k)) && cls.fields.every(f => props.has(f.name) || f.optional) && fits(cls)
		);
		if (candidates.length === 1)
			return candidates[0];
		// No declared interface/class anywhere has this exact field set -- a genuinely anonymous shape (e.g.
		// `const mapSig = {a: ..., b: ...}`, never named via `interface`/`type X = ...`), the same gap
		// `ensureAnonObjectShape` already fills at a function type's own return position; keyed the same way, an
		// identically-shaped anonymous literal elsewhere (or after generic substitution) collapses onto the same
		// physical struct. Also reached when the discriminant tiebreak below rules out every name-matching candidate
		// (`matches.length === 0`) -- see `matchObjectShapeByType`'s own identical fallback for why.
		const fallback = () => {
			if (!anon)
				return undefined;
			const resolved = T.resolve(ctx.scope, checkerTypeOf(e, ctx.scope));
			return resolved.type === 'object' && !indexSignatureValueType(resolved) ? ensureAnonObjectShape(resolved) : undefined;
		};
		if (candidates.length === 0)
			return fallback();

		const matches = candidates.filter(cls => [...props].every(([key, value]) => {
			if (value.type !== 'literal')
				return true;
			const vals = T.literalValues(cls.fieldDeclaredType(key, global) ?? T.ANY);
			return !vals || vals.includes(value.value);
		}));
		return matches.length === 1 ? matches[0] : matches.length === 0 ? fallback() : undefined;
	}

	// `matchObjectShape`'s type-level counterpart, used by `typeOf`'s 'object' case when a real object TYPE (not a
	// literal expression) needs a nominal class: e.g. a generic parameter's structural bound (`Record<string, any>`)
	// substituted with an interface-typed argument. `ensureClass`/`ownerFor` preserve name identity only for a `class`
	// ref, never a plain `interface` (a bare `T.resolve` fully expands it), so its name is gone; self-hosting
	// `walker.ts`'s `mapObject` hit exactly this (`local 'r' has an unsupported type`). Same exact-field-set-then-
	// literal-discriminant matching as the literal version above, but against declared field *types* not expression
	// *values*; ambiguous or partial cases (computed/non-string key, non-property member) return `undefined`, never a guess.
	// One answer per type for the whole compile: which classes exist changes as codegen proceeds, and a value built under
	// one answer is unconvertible to a later one (a local typed before `FunctionType` was built, read after it was).
	function matchObjectShapeByType(t: TS.ObjectType): ClassInfo | undefined {
		const key	= T.typeKey(t);
		const found	= classes.get(key) ?? findObjectShapeByType(t);
		if (found)
			classes.set(key, found);
		return found;
	}

	function findObjectShapeByType(t: TS.ObjectType): ClassInfo | undefined {
		const props = new Map<string, Type>();
		for (const m of t.members) {
			if (m.type !== 'property' || typeof m.key !== 'string')
				return undefined;
			props.set(m.key, m.typeAnnotation);
		}
		// See `matchObjectShape`'s own comment -- same optional-field-omission tolerance and the same `new Set` reason.
		// The field TYPES must agree too, not just their names: `NodeMap<Obj>`'s `values` is a mapper `(x: number[]) =>
		// number[]` where `Obj`'s own is `number[]`, and the literal was then built against the wrong one. Asked of the
		// CHECKER, never `typeOf`: this runs while a shape is being resolved, and `typeOf` builds shapes, so asking it
		// re-enters (ts-parser.ts's `CallSig` -> `Param[]` -> the recursive `Type` union did not terminate). A field
		// whose declared type is unknown to `fieldDeclaredType` is not judged.
		const candidates = [...new Set(classes.values())].filter(cls =>
			cls.typeIndex !== -1 && !cls.anonymous && [...props.keys()].every(k => cls.fieldIndex.has(k)) && cls.fields.every(f => props.has(f.name) || f.optional)
			&& [...props].every(([k, pt]) => { const declared = cls.fieldDeclaredType(k, global); return !declared || T.isAssignable(pt, declared, global); })
		);
		if (candidates.length === 1)
			return candidates[0];
		// No declared interface/class has this exact field set either -- the same genuinely-anonymous-type gap
		// `matchObjectShape`'s expression-level counterpart falls back to `ensureAnonObjectShape` for (its own
		// comment), e.g. a bare `const mapSig = {...}`'s inferred var_decl type (never named via `interface`/`type X = ...`),
		// not just an expression flowing straight through. Also reached when every name-matching candidate is ruled out
		// by its own discriminant (`matches.length === 0` below): the same "nothing real represents this shape"
		// outcome found one step later, e.g. `{type, body}` matching both `static_block` and `FunctionExpr`/`Arrow`.
		const fallback = () => indexSignatureValueType(t) ? undefined : ensureAnonObjectShape(t);
		if (candidates.length === 0)
			return fallback();

		const matches = candidates.filter(cls => [...props].every(([key, propType]) => {
			const wantVals = T.literalValues(propType);
			if (!wantVals)
				return true;
			const gotVals = T.literalValues(cls.fieldDeclaredType(key, global) ?? T.ANY);
			return !gotVals || gotVals.some(v => wantVals.includes(v));
		}));
		return matches.length === 1 ? matches[0] : matches.length === 0 ? fallback() : undefined;
	}

	// Index syntax (`a[i]`, `a[i] = v`) calls a class's own INDEX accessor, `__get`/`__set`, never a real API of that name
	// (`Uint8Array.set(array, offset)`). An index-signature object is routed to `Map`, and indexes through its real `get`/`set`.
	function indexAccessor(cls: ClassInfo, receiver: Expr, kind: 'get' | 'set', ctx: FunctionContext): string | undefined {
		if (methodSig(cls, `__${kind}`, ctx))
			return `__${kind}`;
		return indexSignatureValueType(T.resolve(ctx.typeScope, ctx.narrowedTypeOf(receiver))) && methodSig(cls, kind, ctx) ? kind : undefined;
	}

	// A class read by POSITION, as JS's array-likes are: an index getter keyed by a number, and a real `length` (a field or
	// `get length`) -- not a keyed `get`, whose index signature makes any name, `length` too, look like a member.
	function isPositional(cls: ClassInfo, ctx: FunctionContext): boolean {
		const sig = methodSig(cls, '__get', ctx);
		const key = sig?.params[sig.params.length - 1];
		return key !== undefined && W.scalarKind(key) !== undefined
			&& (cls.fields.some(f => f.name === 'length') || !!methodSig(cls, accessorKey('get', 'length'), ctx));
	}

	// `cls.name`'s own method signature -- whether inline-asm or a plain declared method.
	function methodSig(cls: ClassInfo, name: string, ctx: FunctionContext): { params: W.Type[]; result: W.Type } | undefined {
		const inline = cls.inlineMethods?.get(name);
		if (inline) {
			const b = inline([], ctx);
			return { params: b.params, result: b.result };
		}
		return ensureMethod(cls, name, [], ctx);
	}

	// The constructor by which `cls` adopts raw storage: its overload taking exactly one parameter, a `RawArray` (`Array`'s
	// `constructor(d: RawArray<T>)`, a typed array's over an `ArrayBuffer`). Boxing raw storage into `cls` is a call to it.
	function adoptingDecl(cls: ClassInfo): { decl: MethodMember; storage: W.Type & { arr: W.ElementI } } | undefined {
		let found = adoptingDecls.get(cls);
		if (found === undefined) {
			found = null;
			for (const decl of cls.methodDecls.get('constructor') ?? []) {
				const w = decl.params.length === 1 && !decl.rest ? resolveParams(decl.params, cls.declScope ?? libGlobal)[0].wtype : undefined;
				if (typeof w === 'object' && 'arr' in w) {
					found = { decl, storage: w };
					break;
				}
			}
			adoptingDecls.set(cls, found);
		}
		return found ?? undefined;
	}

	// The element kind of a value's STORAGE: the value IS storage, or its class adopts storage of that kind (`adoptingDecl`).
	function storageKindOf(w: W.Type | undefined): W.ElementI | undefined {
		if (typeof w === 'object' && w && 'arr' in w)
			return w.arr;
		const o = typeof w === 'object' && w && 'ref' in w ? classes.get(w.ref) : undefined;
		return o && adoptingDecl(o)?.storage.arr;
	}

	// The ELEMENT representation of an array-ish value: a raw array (`RawArray`, string, `ArrayBuffer`) carries it in
	// its own wtype; an `Array<T>` is an ordinary class, so its element kind is a fact about its TYPE, not the stack struct -- see [[tison-type-vs-representation]].
	function elementKindOfType(t: Type | undefined, scope: Scope): W.ElementI | undefined {
		if (!t)
			return undefined;
		const r  = T.resolve(scope, t);
		const el = r.type === 'array' ? r.element
			: r.type === 'ref' && (r.name === 'Array' || r.name === 'ReadonlyArray' || r.name === 'RawArray') ? r.typeArgs?.[0]
			: undefined;
		return el ? W.elementKind(typeOf(el)) : undefined;
	}

	// The element kind an array-valued expression resolves to -- raw storage's own, else its `Array` type's -- or `undefined`.
	function arrayKindOf(e: Expr, ctx: FunctionContext): W.ElementI | undefined {
		const wt = wtypeOf(e, ctx);
		return storageKindOf(wt) ?? elementKindOfType(checkerTypeOf(e, ctx.scope), ctx.scope);
	}

	// `arrayKindOf` for a value about to be indexed into (`e[i]`). The ref-collapse below is DISABLED: an inner
	// array keeps its own declared kind (`x[0]` of `number[][]` is a real f64 array), and every read casts back down to it.
	function objectArrayKind(e: Expr, ctx: FunctionContext): W.ElementI | undefined {
		//if (e.type === 'index' && objectArrayKind(e.object, ctx) === 'ref')
		//	return 'ref';
		// `narrowedTypeOf`, not `arrayKindOf`'s plain `ctx.scope` view: a value NARROWED out of `T | undefined` still reads
		// as the whole union there, so a field off it comes back `any` with no array kind (`[...a.rights, ...b.rights]` after `a && b`).
		const nt = ctx.narrowedTypeOf(e);
		const wt = typeOf(nt);
		return storageKindOf(wt) ?? elementKindOfType(nt, ctx.scope);
	}

	// `ownerOf` for a value about to be indexed into (`e[i]`) via generic class-method dispatch (`Array<T>.get(i)`); the
	// Array-at-`any` override below is DISABLED, same reason as `objectArrayKind`'s: an inner array is a real `Array<number>`.
	// A value STORED as `any` has no statically bound members, whatever its checker type names -- an open shape
	// (`openShapes`), or a genuinely dynamic value; its members are reached by the runtime dispatchers instead.
	function physicallyAny(e: Expr, ctx: FunctionContext): boolean {
		return W.isAny(wtypeOf(e, ctx));
	}

	function classOfForIndexing(e: Expr, ctx: FunctionContext): ClassInfo | undefined {
		if (physicallyAny(e, ctx))
			return undefined;
		const cls = ownerOf(e, ctx);
		//if (cls?.decl.name === 'Array' && e.type === 'index' && objectArrayKind(e.object, ctx) === 'ref')
		//	return ensureClass('Array', [T.ANY]);
		// A union of array types (`string[] | never[]`) names no single class, but its members share ONE physical class --
		// dispatch through that one's own accessors. Members of genuinely different shapes are `any`, and dispatch below.
		const w = cls ? undefined : wtypeOf(e, ctx);
		return cls ?? (typeof w === 'object' && w && 'ref' in w ? classes.get(w.ref) : undefined);
	}

	// The `WasmType`/`ClassInfo` a builtin-operator operand resolves to -- `wtypeOf`/`ownerOf` alone can't see an indexed read's element kind, so `numericPairWtype`/etc would silently fall back to `f64`.
	function operandInfo(e: Expr, ctx: FunctionContext): OperandInfo {
		if (e.type === 'index') {
			// `owner` (for owner-based operator dispatch -- '+' on a string/bigint element, etc) is a TS-level identity
			// question, resolved through the checker; `wtype` must match what `case 'index'` leaves on the stack, in its
			// priority order: a class's own `get(i)` signature first (authoritative over the checker's width-blind element
			// type, e.g. plain `number` for `Uint8Array`'s transiently-`i32` reads), then a raw array's physical element
			// kind, and the checker's type last (a ref-kind element -- a class or `string` -- has no narrower physical kind).
			const t		= ctx.narrowedTypeOf(e);
			const owner	= T.isAny(t) ? undefined : ownerFor(t);

			const cls		= classOfForIndexing(e.object, ctx);
			const getter	= cls && indexAccessor(cls, e.object, 'get', ctx);
			const sig		= cls && getter && methodSig(cls, getter, ctx);
			if (sig)
				return { wtype: sig.result, owner };

			const kind = objectArrayKind(e.object, ctx);
			if (kind === 'f64' || kind === 'i32'/* || kind === 'u32'*/)
				return { wtype: kind, owner };
			if (!T.isAny(t))
				return { wtype: typeOf(t), owner };
		}
		const t = ctx.narrowedTypeOf(e);
		return { wtype: typeOf(t), owner: ownerFor(t) };
	}

	// The `ClassInfo` a static `Type` dispatches method calls against -- derived directly from the `Type` itself, never by reverse-decoding an already-collapsed `WasmType`
	// A tuple is an `Array` over REF storage whatever its elements: its element is the union of every position when that is
	// ref-kind, else `any` (`[number, number]` would otherwise name `f64` storage). Asked of the element -- no class built to ask.
	function tupleArrayOwner(tuples: TupleT[]): ClassInfo | undefined {
		const el = T.combineTypes(tuples.flatMap(tu => T.elementTypes(tu, global)));
		return ensureClass('Array', [rawElemKind(el, typeOf) === 'ref' ? el : T.ANY]);
	}

	function ownerFor(t: Type): ClassInfo | undefined {
		// Same fast path `wasmTypeOf` needs, for the same reason -- a hoisted `builtinTypes` name would
		// otherwise fully expand via its own `declScope` before reaching the `w.type === 'ref'` check below.
		if (t.type === 'ref') {
			if (builtinTypes.has(t.name))
				return builtinTypeOwner(t.name);
/*
			if (t.typeArgs?.length) {
				const decl = LIB_DECL_MAP.get(name) ?? userGenericClassDecls.get(name);
				if (decl?.type === 'class_decl' && decl.typeParams?.length)
					return ensureClass(name, t.typeArgs);
			}
*/

			// Try the raw, unresolved reference's own name directly (via `ensureClass`'s shallow, single-level
			// `resolveClassAlias` lookup and its own `classes` cache check) before `T.resolve`'s full expansion below: that
			// no longer just unwraps one alias level (`Uint8Array` -> `TypedArray<u8>`) -- for a name with *both* a real
			// class and a separate ambient `interface` (`TypedArray`, same dual-declaration pattern as `String`), it fully
			// expands and merges both into an `intersection` with no traceable class name/typeArgs at all. Safe
			// unconditionally: `ensureClass` returns `undefined`, no throw, for a name that's neither, so this falls through.
			const direct = ensureClassRef(t);
			if (direct)
				return direct;
		}
		// Widening only ever matters for a scalar/array/union/ref shape here (matching `wasmTypeOf`'s own reasoning) --
		// a real `'object'` shape must NOT be widened: `widenLiterals`'s recursive object case would widen every
		// member's declared type too, including a discriminant field (`{type:'static_block';...}`'s `type`) down to plain
		// `string`, corrupting the literal precision `matchObjectShapeByType`'s discriminant tiebreak needs to tell union members apart.
		const resolvedForOwner = T.resolve(global, t);
		// `obj?.method(...)`'s receiver is nullable by construction -- strip `null`/`undefined` before
		// dispatching; there's no "owner of `null`", only "owner of the non-nullish part `?.` already guarded".
		// Before widening: widened, `{type: 'keyof'} | undefined`'s tag became `string` and matched another struct.
		const nonNullish = resolvedForOwner.type === 'union' ? T.nonNullable(resolvedForOwner, global) : resolvedForOwner;
		if (nonNullish !== resolvedForOwner)
			return ownerFor(nonNullish);
		const w = resolvedForOwner.type === 'object' ? resolvedForOwner : T.widenLiterals(resolvedForOwner, false, true);

		switch (w.type) {
			case 'union': {
				// A union of tuples (js-parser.ts `CallSigParams<T>`, a rest's type) is one `arr:ref` whichever member it is.
				const members = T.unionMembers(w, global).map(m => T.resolve(global, m));
				return members.every(m => m.type === 'tuple') ? tupleArrayOwner(members as TupleT[]) : undefined;
			}
			case 'array':
				// `T[]`/`Array<T>`/`ReadonlyArray<T>` all resolve to `Array`'s own methods -- `ReadonlyArray` has no
				// separate lib declaration, it's a checker-only "readonly view" of the same structural shape.
				return ensureClass('Array', [w.element]);
			case 'tuple':
				return tupleArrayOwner([w]);

			case 'ref': {
				const mutable = READONLY_ALIAS.get(w.name);
				if (mutable)
					return ensureClass(mutable, w.typeArgs);
				if (w.name === 'Array')
					return ensureClass('Array', w.typeArgs);
				// A plain lib class (or alias -- `resolveClassAlias`) not reached by the raw-`t.name` `ensureClass` try above,
				// e.g. a param typed `Uint8Array` with no earlier `new Uint8Array(...)` to have lazily populated `classes`.
				// Safe to call unconditionally: `ensureClass` returns `undefined`, no throw, for a name that's neither.
				// `w.typeArgs`, not just `w.name`: `global` now sees lib type aliases, so `T.resolve` can already expand a
				// bare alias (`Uint8Array` -> `TypedArray<u8>`), and a generic class needs them to resolve at all, same
				// as the `Array`/`ReadonlyArray` case just above.
				return builtinTypeOwner(w.name) ?? ensureClass(w.name, w.typeArgs);
			}

			case 'object': {
				const vt = indexSignatureValueType(w);
				if (vt)
					return ensureClass('Map', [TS.RefType('string'), vt]);
				// Genuinely last resort, same guard as `typeOf`'s own -- only reached once `t.type === 'ref'` had its shot
				// above (a plain class/interface ref, even one mid-construction resolving its own name, is *never* funneled
				// here: that early check returns first). A generic parameter's structural bound substituted with a real
				// interface-typed argument is the one case anonymous by construction (`matchObjectShapeByType`'s own
				// comment). ...and when nothing declared matches either, synthesize the shape -- the same last resort
				// `matchObjectShape` applies on the literal side, so a bare anonymous object (an inferred field, a spread
				// result) has an owner to read fields off.
				return matchObjectShapeByType(w) ?? ensureAnonObjectShape(w);
			}
			// An interface `extends`ing another (`Method<T> extends CallSig<T>`) resolves to an intersection, not an
			// 'object'; `resolveObjectType` flattens+merges it into the flat object `matchObjectShapeByType` expects.
			case 'intersection': {
				// See `arrayPartOf` -- an array carrying extra properties dispatches against `Array` itself.
				const arr = arrayPartOf(w, global);
				if (arr)
					return ensureClass('Array', [arr.element]);
				const prim = primitivePart(w, global);
				if (prim)
					return ownerFor(prim);
				const merged = T.resolveObjectType(w, global);
				// Same last resort the 'object' case above uses -- synthesize the flattened shape when
				// nothing declared matches it, or a value of such a type has no owner to read fields off.
				return merged && (matchObjectShapeByType(merged) ?? ensureAnonObjectShape(merged));
			}
		}
		return undefined;
	}


	// An object literal assigned against a real union target (`const m: ClassMember = {type:'field', ...}`) must pick
	// the ONE member it represents first: `matchObjectShape` only scans already-*registered* classes (`classes`), so the
	// first literal of a shape (nothing yet built the interface's "official" struct via `ownerFor`) would build a
	// narrower anon struct from its written properties than `ownerFor` later builds -- the exact mismatch that makes
	// `ensureUnionFieldDispatch`'s `ref.test` cascade trap. Uses `ctx.contextualReturn` (the same mechanism `case
	// 'array'`'s contextual-kind check relies on) to see the declared union, then matches the literal's discriminant
	// value(s) against each member's declared literal type -- the same tiebreak
	// `matchObjectShape`/`matchObjectShapeByType` use, before structural-only guessing. Requires one literal-valued
	// property and exactly one matching member; ambiguity falls through to `matchObjectShape`'s own (unaffected) existing behavior.
	function matchContextualUnionMember(e: JS.ObjectExpr<Type>, ctx: FunctionContext): ClassInfo | undefined {
		if (!ctx.contextualReturn)
			return undefined;
		const props = new Map<string, Expr>();
		for (const p of e.properties) {
			// A spread is never excess-checked (as in TS): only the fields written out must fit and discriminate.
			if (p.type === 'spread')
				continue;
			if (p.type !== 'field' || typeof p.key !== 'string' || !p.value)
				return undefined;
			props.set(p.key, p.value);
		}
		if (!props.size)
			return undefined;
		const matches = T.objectShapes(ctx.contextualReturn, ctx.scope).filter(({ objT }) => {
			const fieldNames = new Set(objT.members.filter((m): m is TS.TypeMember & { type: 'property'; key: string } => m.type === 'property' && typeof m.key === 'string').map(m => m.key));
			// The literal must name no field this member doesn't declare (an excess-property-style check -- otherwise
			// `Field`'s own `key`/`typeAnnotation` names would equally "fit" `static_block`, which declares neither); a
			// field this member declares as a real discriminant must admit this literal's value among its possible
			// values -- one with no such signal isn't required to "match" anything.
			return [...props.keys()].every(k => fieldNames.has(k)) && [...props].every(([key, value]) => {
				if (value.type !== 'literal')
					return true;
				const m = objT.members.find(m => m.type === 'property' && m.key === key);
				if (m?.type !== 'property')
					return false;
				const vals = T.literalValues(m.typeAnnotation);
				return !vals || vals.includes(value.value);
			});
		});
		const owners = matches.map(m => ownerFor(m.raw) ?? matchObjectShapeByType(m.objT));
		if (owners.length === 1)
			return owners[0];
		// Several fit (`{params, rest}` for `CallSig | Params`): the one that is a SUBTYPE of all the others is
		// acceptable to every consumer (`interface CallSig extends Params` makes its struct a `Params` too).
		return owners.find(o => o && owners.every(q => q && isSubclassOf(o.name, q.name)));
	}

	// A union's own members can themselves resolve to a further union (e.g. a re-exported cross-module alias like
	// `JS.ClassMember<T>`) -- `T.resolve` only ever expands a type's outermost level, never recursing into a union's own members
	// (`typeOf`'s own 'union' case does that recursion itself), and `ownerFor`'s union case only handles the nullable-collapse
	// shape -- a genuine multi-member union has no single owner, so this flattens to the concrete owners a multi-owner dispatch
	// caller (`ensureUnionFieldDispatch`) needs.
	function flattenOwners(t: Type, scope: Scope): ClassInfo[] | undefined {
		// `ownerFor(t)` is tried on the RAW member first -- its `t.type === 'ref'` fast path needs the real nominal ref (a real
		// class's own name/typeArgs/declScope), and pre-resolving would expand a real class to its bare structural shape and land
		// on `matchObjectShapeByType`'s anonymous-shape path instead of its real struct (a regression the `A | B` test catches).
		// Only after that fails does resolving reveal a nested union.
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

	// The union members a `u.m(...)` call could dispatch to: every member must be a struct-backed owner declaring a matching
	// `m` -- a partial answer would be a silent wrong dispatch, so anything less falls through to the caller's own error.
	// Deduped by `typeIndex`: several members can share one physical type, and a repeated `ref.test` arm is dead code.
	function unionMethodOwners(obj: Expr, name: string, args: Expr[], ctx: FunctionContext): ClassInfo[] | undefined {
		const t = T.resolve(ctx.typeScope, ctx.narrowedTypeOf(obj));
		if (t.type !== 'union')
			return undefined;
		const owners = T.unionMembers(t, ctx.typeScope).filter(m => !T.isNullish(m, ctx.typeScope))
			.flatMap(m => flattenOwners(m, ctx.typeScope) ?? [undefined]);
		if (owners.length < 2 || !owners.every(o => o && o.typeIndex !== -1 && methodSig(o, name, ctx)))
			return undefined;
		const seen = new Set<number>();
		return (owners as ClassInfo[]).filter(o => !seen.has(o.typeIndex) && (seen.add(o.typeIndex), true));
	}

	// A namespace-style reference (`Box.describe()`) never carries real type arguments, and real TS forbids a static member from
	// referencing its class's own type parameters (checker-enforced), so `T.ANY` uniformly fills each one rather than
	// `ensureClass`'s "needs N explicit type argument(s)" throw -- always `REF_ANY`, so even another member's type that happens
	// to mention the type param (the static member itself never does) still resolves without failing. `undefined` for a
	// non-generic class leaves `ensureClass(name)` exactly as it was.
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
		return ownerFor(ctx.narrowedTypeOf(e));
	}

	// Populated by the "index space" pass below, before any body is built -- a class ref's `WasmType`
	// only carries its *name*, but the binary format needs the struct's numeric type index.
	function toValType(w: W.Type): wasm.ValType {
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
		return { ref: types.array(w.arr), nullable: !!w.nullable };
	}

	// The heap type a `ref.null` needs -- just `toValType`'s `.ref`, unwrapped from the `wasm.ValType` shape.
	function heapTypeIndexOf(w: W.Type): wasm.HeapType {
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
		ctx.emit(I.i32.const(data.intern(s)), I.i32.const(s.length), I.array.new_data(types.array('i16'), 0));
	}

	// Looked up by name against `classes` rather than taking `ClassInfo`s, since `coerceTop`'s callers only ever have the bare
	// `WasmType`'s own ref name. Every class named here is already resolved -- a value of a class ref type requires `ensureClass`.
	function isSubclassOf(subName: string, baseName: string): boolean {
		return classes.get(baseName)?.isBaseOf(classes.get(subName)) ?? false;
	}

	function coerceTop(got: W.Type, ctx: FunctionContext, want: W.Type): void {
		if (W.typeEq(got, want))
			return;

		// Differing only in result, or having FEWER params than `want` declares, is ordinary JS/TS callback convention (`arr.map(x =>
		// x*2)` ignoring `index`/`array`) -- wrap rather than reject. A real incompatibility in a shared param position, or `got`
		// wanting MORE params than `want` offers, still falls through to the "cannot convert" throw. See `ensureClosureCoercionWrapper`.
		if (typeof got !== 'string' && typeof want !== 'string' && 'closure' in got && 'closure' in want) {
			// The same signature differing only in nullability is the same value, as for a ref or array below.
			if (W.typeEq({ ...got, nullable: false }, { ...want, nullable: false })) {
				if (got.nullable && !want.nullable)
					ctx.emit(I.ref.as_non_null);
				return;
			}
			const gotSig = closureSigOf(got), wantSig = closureSigOf(want);
			// A shared param may DIFFER, so long as adapting it is a reference narrowing the wrapper can do with a cast: `Array<T>`'s
			// methods compile at `T = any` for every non-scalar element (one physical `arr:ref` store for all of them), so a
			// callback declared `(x: string)` meets a `(x: any)` slot. Both sides must be REFERENCE types -- a scalar mismatch
			// (`f64` caller, `i32` callback) would silently truncate, which is worse than the error it replaces; scalar vs a
			// boxed `any` converts by (un)boxing in the wrapper.
			const isAnyRef = (w: W.Type) => typeof w !== 'string' && 'ref' in w && w.ref === 'any';
			const paramFits = (p: W.Type, i: number) => W.typeEq(p, wantSig.params[i])
				|| (typeof p !== 'string' && typeof wantSig.params[i] !== 'string')
				|| (typeof p === 'string' && isAnyRef(wantSig.params[i])) || (typeof wantSig.params[i] === 'string' && isAnyRef(p));
			// MORE params than the slot offers still fits when the wrapper can supply every extra one: checker.ts passes
			// `narrowByDiscriminant(m: Type, depth = 6)` as a `(m: Type) => ...`, ordinary TS since a default makes its JS arity 1.
			if ((gotSig.params.length <= wantSig.params.length || gotSig.params.slice(wantSig.params.length).every((p, i) => {
				const d = gotSig.defaults?.[wantSig.params.length + i];
				return (!!d && isReemittableDefault(d)) || (typeof p !== 'string' && !!p.nullable);
			})) && !!gotSig.hasRest === !!wantSig.hasRest
				&& gotSig.params.slice(0, wantSig.params.length).every(paramFits)) {
				const orig = ctx.temp(`$origClosure$${ctx.tempCounter++}`, got);
				ctx.emit(I.local.set(orig));
				const { info, wantStructTypeIndex, envTypeIndex } = ensureClosureCoercionWrapper(gotSig, wantSig);
				// The wrapper is the same JS function, so it keeps the original's `length`.
					ctx.emit(I.ref.func(info.funcIndex), I.local.get(orig), I.struct.new(envTypeIndex),
						I.local.get(orig), I.struct.get(types.closureBase(), CLOSURE_FIELDS.get('length')!), I.struct.new(wantStructTypeIndex));
				return;
			}
		}

		// `u32`/`i32` are the same physical wasm value -- `u32` only exists so `coerceTop` always knows which
		// conversion direction (`_s` vs `_u`) a value needs, instead of every producer converting eagerly itself.
		if ((got === 'u32' && want === 'i32') || (got === 'i32' && want === 'u32'))
			return;

		// A nullable primitive (`number | null`/`boolean | null`, boxed via `types.box`): into `any` it goes as-is (a box IS
		// an `anyref`, and one holding null must arrive as that null); for a bare scalar it is unboxed, trusting the checker
		// already required narrowing (the same `ref.as_non_null`-traps-on-null contract as for nullable objects). Reassigning
		// `got` lets every scalar-conversion branch below run as if it had been bare all along.
		const gotBox = W.unboxedPrimitive(got);
		if (gotBox) {
			if (typeof want !== 'string' && 'ref' in want && want.ref === 'any') {
				if (typeof got === 'object' && got.nullable && !want.nullable)
					ctx.emit(I.ref.as_non_null);
				return;
			}
			ctx.emit(I.ref.as_non_null, I.struct.get(gotBox.typeIndex, 0));
			got = gotBox.kind;
			if (W.typeEq(got, want))
				return;
		}
		// The opposite direction: a bare scalar meeting a nullable-primitive consumer -- widen/convert
		// to the box's own kind first (recursing into this same function), then box it.
		const wantBox = W.unboxedPrimitive(want);
		if (wantBox && typeof got === 'string') {
			if (got !== wantBox.kind)
				coerceTop(got, ctx, wantBox.kind);
			ctx.emit(I.struct.new(wantBox.typeIndex));
			return;
		}

		// A bare scalar has no heap identity of its own -- unlike ref/array (already a valid `anyref`), a raw
		// `f64`/`i32` needs a real box (`types.box`) to occupy an `any` slot. `u32` reads as `i32` here, same as everywhere else.
		if ((got === 'f64' || got === 'i32' || got === 'u32') && typeof want !== 'string' && 'ref' in want && want.ref === 'any') {
			ctx.emit(I.struct.new(types.box(got === 'f64' ? 'f64' : 'i32')));
			return;
		}

		if (typeof got !== 'string') {
			if ('ref' in got && got.ref === 'any') {
				// Narrowing anyref down to a bare scalar (e.g. unboxing an async step function's own `#sent` param, boxed at its
				// trampoline via this same function's scalar->any branch above) -- unbox via the same box shape a scalar->any box
				// always uses (`types.box`), then widen/convert further via a recursive call when `want` isn't exactly that
				// box's own kind (e.g. an `i32` box read back as `u32`/`i64`).
				if (want === 'f64' || want === 'i32' || want === 'u32' || want === 'i64' || want === 'f32') {
					const boxKind = (want === 'f64' || want === 'f32') ? 'f64' : 'i32';
					ctx.emit(I.ref.cast(types.box(boxKind)), I.struct.get(types.box(boxKind), 0));
					if (boxKind !== want)
						coerceTop(boxKind, ctx, want);
					return;
				}
				// `want.nullable`, not the 1-arg default (non-nullable) -- casting a shared nullable `anyref` read into a nullable
				// target (e.g. a `(number | null)[]` element, stored as a shared nullable `anyref` slot) as non-nullable would
				// trap on a genuinely-null element instead of letting it be checked against `null`.
				if (typeof want !== 'string' && ('ref' in want || 'arr' in want || 'closure' in want || 'typeIndex' in want))
					ctx.emit(I.ref.cast(heapTypeIndexOf(want), !!want.nullable));
				return;
			}

			// The opposite direction: any concrete class ref or array/string value is already a valid `anyref` (structural
			// subtyping), so widening to `any` needs no instruction -- only `ref.as_non_null` if also narrowing nullability.
			// `'arr' in got` covers writing a string/array into a ref-kind slot the same way; `'closure' in got` a closure's
			// `{code,env}` struct (e.g. storing one into a generic `Array<() => void>`'s `any`-typed backing slot).
			if ((('ref' in got) || ('arr' in got) || ('closure' in got)) && typeof want !== 'string' && 'ref' in want && want.ref === 'any') {
				if (got.nullable && !want.nullable)
					ctx.emit(I.ref.as_non_null);
				return;
			}

		// Nullable<->non-null, same underlying ref/array kind -- or `got` a real subclass of `want` (`super.method()`'s receiver,
		// or any other upcast): wasm-GC struct subtyping (`ensureClass`'s own `supertypes`) already makes the value valid
		// wherever `want`'s ref type is declared -- only nullability may still need narrowing.
			if (typeof want !== 'string') {
				const gotKind	= 'ref' in got ? got.ref : 'arr' in got ? got.arr : undefined;
				const wantKind	= 'ref' in want ? want.ref : 'arr' in want ? want.arr : undefined;
				if (gotKind !== undefined && (gotKind === wantKind || ('ref' in got && wantKind !== undefined && isSubclassOf(gotKind, wantKind)))) {
					if (got.nullable && !want.nullable)
						ctx.emit(I.ref.as_non_null);
					return;
				}
				// The opposite direction, `want` a real subclass of `got`: a trusted downcast (a `this`-typed method's checker-inferred
				// return type is more specific than the shared, inherited method body can know). Unlike the free upcast above this needs
				// a real `ref.cast` -- the runtime value must actually be `want`'s type here, the same trust as any other narrowing cast.
				if (wantKind !== undefined && 'ref' in want && gotKind !== undefined && isSubclassOf(wantKind, gotKind)) {
					ctx.emit(I.ref.cast(heapTypeIndexOf(want), !!want.nullable));
					return;
				}
			}
		}

		if (got === 'f64') {
			switch (want) {
				// Direct native saturating conversions -- not an `i64.trunc_sat_f64_s` + `i32.wrap_i64` detour: saturating to
				// i64's range then wrapping to i32 discards the saturation for any out-of-i32-range input (e.g. `+Infinity`
				// saturated to `i64::MAX` wraps to `-1`), defeating the point of a saturating conversion (never trapping, e.g.
				// on `0/0`). `NaN` saturates to `0` like JS's `ToInt32`; `±Infinity` gives `i32::MAX`/`MIN` where JS gives `0` --
				// the same accepted non-finite gap as a huge finite float, well-defined and non-trapping, not bit-perfect JS.
				case 'i32': ctx.emit(I.i32.trunc_sat_f64_s); return;
				case 'u32': ctx.emit(I.i32.trunc_sat_f64_u); return;
				case 'i64': ctx.emit(I.i64.trunc_sat_f64_s); return;
				case 'f32':	ctx.emit(I.f32.demote_f64); return;
			}
		}
		// Raw storage meeting a class that adopts it (`adoptingDecl`) -- `[1,2,3]` (physically `{arr:f64}`) where an `Array<number>` is
		// wanted -- is that class's own constructor call. A literal stays the cheap form and boxes only where a context needs the class.
		if (typeof got === 'object' && 'arr' in got && typeof want === 'object' && 'ref' in want) {
			const owner = classes.get(want.ref);
			const adopt = owner && adoptingDecl(owner);
			if (adopt && W.typeEq(adopt.storage, got)) {
				ctx.emit(I.call(ensureCtorDecl(owner!, adopt.decl).funcIndex));
				return;
			}
		}

		// A bigint (its limb array) to a NUMBER -- the mirror of `bigFromNumber` below: `6 > 5n` needs it, because a mixed comparison
		// dispatches on the LEFT operand, so a number on the left never reaches `BigInt.compare`.
		if (want === 'f64' && W.typeEq(typeof got === 'object' && got.nullable ? { ...got, nullable: false } : got, W.ARRAY.i32)) {
			const decl = LIB_DECL_MAP.get('bigToNumber');
			if (decl && decl.type === 'function_decl') {
				const info = ensureFunc('bigToNumber', decl);
				if (info) {
					ctx.emit(I.call(info.funcIndex));
					return;
				}
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
		// Must track `bigint`'s own physical representation (`builtinTypes.bigint.wtype`, currently `{arr:'u32'}`, see `lib/bigint.ts`),
		// not assume a fixed `{arr:'i32'}`. Nullability is ignored: a non-nullable `(ref array)` is already a subtype of the nullable slot.
		if (W.typeEq(typeof want === 'object' && want.nullable ? { ...want, nullable: false } : want, W.ARRAY.i32)) {
			const array = I.array(types.array('i32'));

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
				// `bigFromNumber` (lib/bigint.ts) is the real, tested conversion, and calling it is the only way this stays in
				// step with the limb encoding it has to produce. A mixed `bigint`/`number` comparison -- legal TS, and what
				// `BigInt.toString`'s own `i > 0` loop depends on -- needs it.
					//fall through
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
		throw `internal: cannot convert ${W.typeKey(got)} to ${W.typeKey(want)}`;
	}

	// `coerceTop`, but for one arm of a union dispatch (`ensureUnionFieldDispatch`/`ensureUnionIndexDispatch`) whose overall
	// `result` boxes as `any` because its sibling arms genuinely differ (not this arm's own fault): every scalar arm must land
	// in the SAME canonical box kind (`f64`, `combineUnionWtypes`'s own comment), not its own narrower physical storage. A
	// caller unboxing a `number` result always assumes the `f64` box, so an arm boxing by its own kind would make its
	// `ref.cast` trap; widening every scalar arm to `f64` first (a cheap numeric conversion, not a box) keeps them consistent.
	function coerceUnionArm(got: W.Type, ctx: FunctionContext, result: W.Type): void {
		if (typeof result !== 'string' && 'ref' in result && result.ref === 'any' && !result.nullable && got !== 'f64' && W.scalarKind(got) !== undefined) {
			coerceTop(got, ctx, 'f64');
			got = 'f64';
		}
		coerceTop(got, ctx, result);
	}

	function emitAs(e: Expr, ctx: FunctionContext, want: W.Type): W.Type {
		// `null`/`undefined` alone (`emitExpr` has no target type to pick a heap type from) is only legal into a nullable slot,
		// the same restriction `typeOf`'s union handling enforces -- except a non-nullable `any` target, which is what a real
		// `void`-typed param/field/local is boxed to (`void` only ever holds `undefined` in real TS), so assigning it there is
		// ordinary source: box the same placeholder `emitDefaultValue` would, rather than reject it.
		if (T.isNullLiteral(e)) {
			if (typeof want !== 'string' && 'ref' in want && want.ref === 'any' && !want.nullable)
				ctx.emit(I.f64.const(0), I.struct.new(types.box('f64')));
			else if (typeof want === 'string' || !want.nullable)
				throw "'null'/'undefined' is only supported where a nullable object type (class/array/string) is expected";
			else
				ctx.emit(I.ref.null(heapTypeIndexOf(want)));

		} else {
			let got = emitExpr(e, ctx, want);
			// A raw array erased into a non-raw slot (`any`, a field, a `??=` default) is boxed first: read back, it is cast to an
			// `Array` class -- its OWN type's if that adopts this storage, else its context's, else (an array all the same) this storage's.
			if (typeof got === 'object' && 'arr' in got && !(typeof want === 'object' && 'arr' in want)) {
				const k = got.arr;
				const owner = (t: Type | undefined) => { const w = t && typeOf(t); return w && typeof w === 'object' && 'ref' in w && storageKindOf(w) === k ? w : undefined; };
				const ownT = checkerTypeOf(unwrapAs(e), ctx.scope);
				const ownW = typeOf(ownT);
				const isArrayValue = !!ownW && typeof ownW === 'object' && 'ref' in ownW && storageKindOf(ownW) !== undefined;
				const own = owner(ownT) ?? owner(ctx.contextualReturn)
					?? (isArrayValue && (k === 'ref' || k === 'f64') ? owner(TS.ArrayType(k === 'ref' ? T.ANY : T.NUMBER)) : undefined);
				if (own && !W.typeEq(own, want)) {
					coerceTop(got, ctx, own);
					got = own;
				}
			}
			// UNboxing from `any`, the mirror of the boxing rule just below: a number was boxed as `f64` whatever its compact
			// integer storage, a real `boolean` as `i32`, so the checker's own type picks which box this value is in.
			if ((want === 'i32' || want === 'u32') && typeof got !== 'string' && 'ref' in got && got.ref === 'any'
				&& ownerFor(checkerTypeOf(unwrapAs(e), ctx.scope))?.name !== 'Boolean') {
				coerceTop(got, ctx, 'f64');
				got = 'f64';
			}
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

	// A runtime TYPE TEST, not a string comparison -- no `typeof` string ever needs to exist. Leaves an `i32` on the stack;
	// returns false, emitting nothing, when the tag has neither a static answer nor a physical form, so the caller errors.
	function emitTypeofTest(operand: Expr, tag: string, ctx: FunctionContext): boolean {
		const t		= ctx.narrowedTypeOf(operand);
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
			emitAs(operand, ctx, W.REF_ANY_NULLABLE);
			ctx.emit(I.ref.is_null);
			if (tag !== 'undefined')
				ctx.emit(I.i32.eqz);
			return true;
		}

		// Only a boxed `any` slot can carry a runtime test: two types sharing a physical form (`number` and `boolean` are both
		// `f64` here) are indistinguishable at runtime, so anything else would be a WRONG answer, not merely an unsupported one.
		const heap = types.heapType(tag);
		const w    = wtypeOf(operand, ctx);
		if (!(w && typeof w === 'object' && 'ref' in w && w.ref === 'any'))
			return false;
		if (heap !== undefined) {
			emitAs(operand, ctx, W.REF_ANY_NULLABLE);
			ctx.emit(I.ref.test(heap));
			return true;
		}
		// `'object'` is the COMPLEMENT of the tags that have a physical form, so a plain OR of those tests answers it with no
		// branching (`guard()`'s own `typeof node === 'object'` is the shape). A null slot reads as `'undefined'` here, so JS's
		// `typeof null === 'object'` is deliberately not reproduced -- that value cannot be told from a real `undefined` either way.
		if (tag === 'object') {
			const tmp = ctx.temp(`$typeofobj$${ctx.tempCounter++}`, W.REF_ANY_NULLABLE);
			emitAs(operand, ctx, W.REF_ANY_NULLABLE);
			ctx.emit(I.local.set(tmp), I.local.get(tmp), I.ref.is_null);
			for (const h of [types.box('f64'), types.box('i32'), types.array('i16'), types.closureBase()])
				ctx.emit(I.local.get(tmp), I.ref.test(h), I.i32.or);
			ctx.emit(I.i32.eqz);
			return true;
		}
		return false;
	}

	// `typeof x` as a VALUE when its type allows several tags: the operand is held once, then each allowed tag is tested
	// (`emitTypeofTest`), `'object'` last and untested as the complement. `null` and `undefined` share one representation, so a
	// type admitting both cannot be answered.
	function emitTypeofValue(operand: Expr, ctx: FunctionContext): W.Type {
		const t			= ctx.narrowedTypeOf(operand);
		const members	= T.unionMembers(t, ctx.scope);
		const hasNull	= members.some(m => T.isLiteral(m, 'null') || T.isRef(m, 'null'));
		if (hasNull && members.some(m => T.isRef(m, 'undefined') || T.isRef(m, 'void')))
			throw `'typeof' of '${T.typeKey(t)}': null and undefined share one representation here, so a null slot cannot be told apart`;
		const ALL		= ['undefined', 'number', 'boolean', 'string', 'bigint', 'function', 'object'];
		const named		= members.map(m => T.isNullish(m, ctx.scope) ? (hasNull ? 'object' : 'undefined') : T.typeofName(m, ctx.scope));
		const tags		= named.some(n => n === undefined) ? ALL : ALL.filter(tag => named.includes(tag));
		const held		= `#typeof$${ctx.tempCounter++}`;
		emitStmt(JS.VarDecl('const', JS.Var(held, operand, t)), ctx);
		const id: Expr	= Identifier(held);
		const str		= typeOf(T.STRING)!;
		const cascade = (i: number): void => {
			const tag = tags[i];
			if (i === tags.length - 1) {
				emitAs(Literal(tag), ctx, str);
				return;
			}
			// A null slot is tested by `emitTypeofTest('undefined')`; its tag is the type's own null tag.
			if (!emitTypeofTest(id, tag === 'object' && hasNull ? 'undefined' : tag, ctx))
				throw `'typeof' of '${T.typeKey(t)}' cannot be told apart at run time (tag '${tag}')`;
			ctx.emitIf(toValType(str), () => emitAs(Literal(tag), ctx, str), () => cascade(i + 1));
		};
		cascade(0);
		return str;
	}

	function emitTruthy(e: Expr, ctx: FunctionContext): void {
		// In a CONDITION `a && b` only has to decide the branch -- both readings agree there -- so this keeps the cheap boolean
		// lowering rather than materialising the operand `case 'binary'` yields; neither side needs a representable value type.
		if (e.type === 'binary' && (e.operator === '&&' || e.operator === '||')) {
			emitTruthy(e.left, ctx);
			const isAnd	= e.operator === '&&';
			const test	= () => ctx.inNarrowed(e.right, e.left, isAnd, () => emitTruthy(e.right, ctx));
			ctx.emitIf('i32', isAnd ? test : () => ctx.emit(I.i32.const(1)), isAnd ? () => ctx.emit(I.i32.const(0)) : test);
			return;
		}
		emitTruthyOf(emitExpr(e, ctx), ctx.narrowedTypeOf(e), ctx);
	}

	// Split out of `emitTruthy` so `&&`/`||` can test their left operand after teeing it into a local -- re-emitting the
	// expression would evaluate its side effects twice. `got` is its physical type, `t` the checker's.
	function emitTruthyOf(gotIn: W.Type, t: Type, ctx: FunctionContext): void {
		let got = gotIn;
		// A boxed primitive (`number | undefined`, `boolean | null`) has no truthiness of its own -- unbox it and test the
		// underlying scalar. A NULLABLE one tests for null first and answers falsy, as JS does for an omitted optional parameter
		// (`r?: number`), which otherwise dereferenced the null box. Same shape the nullable-string case below uses.
		const box = W.unboxedPrimitive(got);
		if (box) {
			if (typeof got === 'object' && got.nullable) {
				const tmp = ctx.declareLocal(`$numtruthy$${ctx.tempCounter++}`, got);
				ctx.emit(I.local.tee(tmp.index), I.ref.is_null);
				ctx.emitIf('i32', () => ctx.emit(I.i32.const(0)), () => {
					ctx.emit(I.local.get(tmp.index));
					coerceTop(got, ctx, box.kind);
					emitTruthyOf(box.kind, t, ctx);
				});
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
			// `abs(x) > 0`, not `x != 0`: NaN is FALSY in JS, but wasm's `ne` is true for an unordered compare, so a bare
			// `x != 0` called it truthy. `gt` is false for NaN and collapses `-0` correctly, needing no scratch local unlike
			// `x != 0 && x == x`.
			case 'f64':
			case 'f32': ctx.emit(I[got].abs, I[got](0), I[got].gt); return;
		}
		// A string is falsy when EMPTY, so it tests its own length rather than its reference. A nullable one
		// is falsy when null too, and `array.len` would trap there -- hence the null test first.
		if (T.isStringLike(t, ctx.scope) && typeof got === 'object' && 'arr' in got) {
			if (got.nullable) {
				const tmp = ctx.declareLocal(`$strtruthy$${ctx.tempCounter++}`, got);
				ctx.emit(I.local.tee(tmp.index), I.ref.is_null);
				ctx.emitIf('i32',
					() => ctx.emit(I.i32.const(0)),
					() => ctx.emit(I.local.get(tmp.index), I.ref.as_non_null, I.array.len, I.i32.const(0), I.i32.ne));
			} else {
				ctx.emit(I.array.len, I.i32.const(0), I.i32.ne);
			}
			return;
		}
		// A real wasm ARRAY slot holds an array whatever the checker's type degraded to, and an array is truthy -- so this is a
		// null test too. `arr:i16` is the exception: a string shares that form and `''` is falsy, so it was handled above.
		if (typeof got === 'object' && 'arr' in got && got.arr !== 'i16') {
			if (got.nullable)
				ctx.emit(I.ref.is_null, I.i32.eqz);
			else
				ctx.emit(I.drop, I.i32.const(1));
			return;
		}
		// A real object/array/closure reference is always truthy in JS -- only null/undefined isn't -- so this is exactly a null
		// test (a non-nullable one is unconditionally true, `drop`ping the value still evaluated for side effects). A boxed `any`
		// qualifies when the CHECKER's type says every non-null thing it can hold is an object (`alwaysTruthy`; `Stmt | undefined`
		// is the common case, the union's members differing physically, not a possible primitive), or `got` names a non-primitive
		// class (printer.ts's `!!expr.operator.match(...)`, typed `any` there).
		const refCls = typeof got === 'object' && 'ref' in got && got.ref !== 'any' && got.ref !== 'exn' ? ensureClass(got.ref) : undefined;
		if (typeof got === 'object' && ((!('ref' in got && (got.ref === 'any' || got.ref === 'exn'))
				? !T.isAny(T.resolveOwn(t, ctx.scope))
				: T.alwaysTruthy(t, ctx.scope))
				|| (!!refCls && !['number', 'boolean', 'string', 'bigint'].some(k => builtinTypeOwner(k) === refCls)))) {
			if (got.nullable)
				ctx.emit(I.ref.is_null, I.i32.eqz);
			else
				ctx.emit(I.drop, I.i32.const(1));
			return;
		}
		// A genuinely dynamic `any` slot -- the checker's type rules nothing out, so decide it at runtime.
		if (typeof got === 'object' && 'ref' in got && got.ref === 'any') {
			ctx.emitAnyTruthy(got, types);
			return;
		}
		throw `'${T.typeKey(t)}' (${W.typeKey(got)}) cannot be used as a boolean condition`;
	}

	// `value`'s elements, read through its own `length` and index and converted to `want`, into new storage `typeIndex` left in
	// `dst`. Read where `value` is evaluated, so a later element of the same literal (`[...a, a.pop()]`) cannot change them.
	function copyElements(value: Expr, got: W.Type, ctx: FunctionContext, want: W.Type, typeIndex: number, dst: number): void {
		const n			= ctx.tempCounter++;
		const fromName	= `$spread$from$${n}`, atName = `$spread$at$${n}`;
		const from		= Identifier(fromName);
		const slot		= wtypeOf(value, ctx) ?? got;
		coerceTop(got, ctx, slot);
		ctx.emit(I.local.set(ctx.declareValue(fromName, slot, ctx.narrowedTypeOf(value)).index));
		const i = ctx.declareValue(atName, 'i32', T.NUMBER).index;
		emitAs(JS.Member(from, 'length'), ctx, 'i32');
		ctx.emit(I.array.new_default(typeIndex), I.local.set(dst), I.i32.const(0), I.local.set(i));
		ctx.emitLoop(() => {
			ctx.emit(I.local.get(i), I.local.get(dst), I.array.len, I.i32.ge_u, I.br_if(1), I.local.get(dst), I.local.get(i));
			emitAs(JS.Index(from, Identifier(atName)), ctx, want);
			ctx.emit(I.array.set(typeIndex), I.local.get(i), I.i32.const(1), I.i32.add, I.local.set(i), I.br(0));
		});
	}

	// `elementTsType` may name each position separately -- a TUPLE rest parameter's arguments.
	function emitArrayElements(elements: readonly (Expr | undefined)[], ctx: FunctionContext, want: W.Type, kind: W.ElementI, typeIndex: number, elementTsType?: Type | ((i: number) => Type | undefined)): void {
		const contextAt		= (el: Expr) => typeof elementTsType === 'function' ? elementTsType(elements.indexOf(el)) : elementTsType;
		const emitElement	= (el: Expr) => ctx.withContext(contextAt(el), () => emitAs(el, ctx, want));
		if (elements.some(el => el?.type === 'spread')) {
			// A `[...]` array literal with at least one spread element. Every element is evaluated exactly once, in source order, into a
			// scratch local (a spread into storage of the literal's own kind); the result is then allocated to the true total and filled.
			type Part = { spread: false; value: number } | { spread: true; src: number; len: number };
			const parts: Part[] = [];

			elements.forEach((el, i) => {
				if (!el) {
					ctx.emitDefaultValue(want, types, toValType);
					const value = ctx.temp(`$spread$elem$${i}`, want);
					ctx.emit(I.local.set(value));
					parts.push({ spread: false, value });
				} else if (el.type === 'spread') {
					const operand	= spreadSource(el.operand, ctx);
					const src		= ctx.temp(`$spread$src$${i}`, W.ARRAY[kind]);
					const len		= ctx.temp(`$spread$len$${i}`, 'i32');
					// Hint the operand's OWN representation, never the storage this literal wants: a hard consumer of the hint (a
					// conditional, whose arms must agree) would otherwise be asked for storage an `Array` arm cannot produce.
					const got		= emitExpr(operand, ctx, wtypeOf(operand, ctx) ?? W.ARRAY[kind]);
					if (typeof got === 'object' && 'arr' in got && got.arr === kind) {
						coerceTop(got, ctx, W.ARRAY[kind]);
						ctx.emit(I.local.set(src));
					} else {
						copyElements(operand, got, ctx, want, typeIndex, src);
					}
					ctx.emit(I.local.get(src), I.array.len, I.local.set(len));
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
			const dst		= ctx.temp('$spread$dst', W.ARRAY[kind]);
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
					ctx.emitDefaultValue(want, types, toValType);
			}
			ctx.emit(I.array.new_fixed(typeIndex, elements.length));
		}
	}

	function emitInline(name: string, inline: Inline, args: Expr[], ctx: FunctionContext): W.Type {
		if (args.length !== inline.params.length)
			throw `'${name}' takes exactly ${inline.params.length} argument(s)`;
		args.forEach((a, i) => emitAs(a, ctx, inline.params[i]));
		ctx.emit(...inline.inline);
		return inline.result;
	}


	function emitCallArgs(label: string, params: W.Type[], defaults: (Expr | undefined)[] | undefined, hasRest: boolean, args: Expr[], ctx: FunctionContext, resolvedParams?: ResolvedParam[]): void {
		// A closure literal passed where the parameter is a UNION with a function member (`String.replace`'s
		// `string | ((substring: string, ...args: any[]) => string)`) must compile to THAT member's physical signature, not its own
		// parameter list -- the callee only calls it through the declared one, and the union's boxed `any` says nothing.
		const wantForArg = (i: number, a: Expr): W.Type => {
			const declared = resolvedParams?.[i]?.tsType;
			if (declared && (a.type === 'arrow' || a.type === 'function')) {
				const r = T.resolveOwn(declared, ctx.typeScope);
				const fn = r.type === 'union' ? r.types.find(t => T.resolveOwn(t, ctx.typeScope).type === 'function') : undefined;
				const wt = fn && typeOf(fn);
				if (wt && typeof wt !== 'string' && 'closure' in wt)
					return wt;
			}
			return params[i];
		};
		// JS applies a parameter's DEFAULT when the argument is `undefined`, so passing it explicitly is exactly the same as
		// omitting it -- `null` is a real value and does NOT trigger the default. Without this, an explicit
		// `resolve(scope, t, undefined, stopAtRef)` tried to emit `undefined` into the scalar slot `depth = 10` declares.
		const argOrDefault = (i: number, a: Expr): Expr => T.nullLiteralKind(a) === 'undefined' && defaults?.[i] ? defaults[i]! : a;
		// Each argument's parameter type is its context: a literal or generic call there builds what the callee reads.
		const emitArg = (i: number, a: Expr) => ctx.withContext(resolvedParams?.[i]?.tsType, () => { const arg = argOrDefault(i, a); return emitAs(arg, ctx, wantForArg(i, arg)); });
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

				// A non-literal default must be reading an earlier parameter (the only other shape `isReemittableDefault` accepts), so bind
				// every argument into its own scratch local first, in declaration order: each default sees its earlier siblings' real
				// values once, matching JS's left-to-right evaluation rather than re-emitting an expression that could have a side effect.
				if (missing.some(d => !isReemittableDefault(d!))) {
					if (!resolvedParams)
						throw `internal: '${label}' has a non-literal default with no resolved parameter info`;
					const rename = new Map<string, string>();
					ctx.openScope();
					const locals = resolvedParams.map((p, i) => {
						const a = i < args.length ? args[i] : substituteEarlierParamRefs(missing[i - args.length]!, rename);
						emitAs(a, ctx, params[i]);
						const name = `$default$${ctx.tempCounter++}`;
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
			args.forEach((a, i) => emitArg(i, a));
		} else {
			const fixedCount = params.length - 1;
			if (args.length < fixedCount)
				throw `'${label}' needs at least ${fixedCount} argument(s)`;
			const fixedArgs = args.slice(0, fixedCount);
			if (fixedArgs.some(a => a.type === 'spread'))
				throw `'${label}': a spread argument can only appear among the trailing rest arguments -- its length isn't known at compile time, so it can't fill a fixed parameter position`;
			fixedArgs.forEach((a, i) => emitArg(i, a));
			// The bundle is built as raw storage and then coerced to whatever the parameter actually is --
			// a `RawArray` takes it as-is, an `Array<T>` boxes it (`coerceTop`), and neither needs a branch here.
			const restArrWtype = params[fixedCount];
			const kind = storageKindOf(restArrWtype) ?? elementKindOfType(resolvedParams?.[fixedCount]?.tsType, ctx.scope);
			if (!kind)
				throw `internal: '${label}' rest param has a non-array type`;
			if (kind === 'i16' || kind === 'i8')
				throw `'${label}' rest param: a 'string[]'/packed-byte-array element is not supported`;
			const restTs = resolvedParams?.[fixedCount]?.tsType;
			emitArrayElements(args.slice(fixedCount), ctx, kind === 'ref' ? W.REF_ANY_NULLABLE : kind, kind, types.array(kind), restTs && (k => T.restArgType(restTs, k, ctx.typeScope)));
			coerceTop(W.ARRAY[kind], ctx, restArrWtype);
		}
	}

	// A struct argument where the parameter is a DIFFERENT struct it does not subtype (`hasMod(e: {modifiers?: string[]})` given
	// a `Param`): TS accepts it structurally and no conversion exists between two unrelated structs, so the callee is compiled
	// once per concrete argument type, as a generic is. The same object goes in, not a copy.
	function ensureStructuralInstance(name: string, decl: FunctionDecl, args: Expr[], ctx: FunctionContext, homeModule: string): FuncInfo | undefined {
		const params = decl.body && structuralParams(decl.params, args, ctx);
		if (!params)
			return undefined;
		const key = structuralKey(name, params);
		return funcs.get(homeKey(homeModule, key)) ?? compileFunc(key, { ...decl, params }, homeModule, name);
	}

	// `declared` with each parameter whose argument is a different struct retyped as that argument; `undefined` when none is.
	function structuralParams(declared: JS.Param<Type>[], args: Expr[], ctx: FunctionContext): JS.Param<Type>[] | undefined {
		let changed = false;
		const params = declared.map((p, i) => {
			const arg = args[i];
			// A literal is built AS the parameter's type (its context), and an index-signature parameter is a dynamic object read
			// by key: neither is a struct to specialize for.
			if (!arg || arg.type === 'spread' || arg.type === 'object' || arg.type === 'array' || !p.typeAnnotation
				|| indexSignatureValueType(T.resolve(global, p.typeAnnotation)))
				return p;
			const want = typeOf(p.typeAnnotation), got = wtypeOf(arg, ctx);
			if (!want || !got || typeof want === 'string' || typeof got === 'string' || !('ref' in want) || !('ref' in got)
				|| want.ref === got.ref || want.ref === 'any' || got.ref === 'any' || isSubclassOf(got.ref, want.ref))
				return p;
			changed = true;
			return { ...p, typeAnnotation: ctx.narrowedTypeOf(arg) };
		});
		return changed ? params : undefined;
	}


	// `typeArgs` is only meaningful for a plain user-declared generic function (`builtins` entries and host imports never are):
	// an explicit `identity<number>(5)` call-site list, or `undefined` when left implicit to `ensureGenericFunc`. `homeModule`
	// names the module whose `functionDeclByName` bucket an unqualified `name` resolves against (a `NS.foo(...)` call site passes the target).
	function emitCall(name: string, args: Expr[], ctx: FunctionContext, typeArgs?: Type[], expected?: Expected, homeModule: string = ctx.homeModule): W.Type {
		let decl;
		const builtin = builtins.get(name) ?? moduleAsmBuiltins.get(homeKey(homeModule, name));
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
				// `name` may be a plain (non-namespace) `import { foo }` binding local to `homeModule`: resolve it to the declaring
				// module and retry there -- the same redirect a namespace-qualified call site's own `nsTarget` makes (`case 'call'`'s
				// member-callee branch), just reached via a bare identifier instead of `NS.foo(...)`.
				const imported = namedImportsByModule.get(homeModule)?.get(name);
				if (imported && functionDeclByName.has(homeKey(imported.module, imported.name)))
					return emitCall(imported.name, args, ctx, typeArgs, expected, imported.module);
				// `C(...)` where `C` names a CLASS: the primitive wrappers are called without `new`, and their constructors are
				// the conversion (`String`'s is `return s.toString()`). Structural, not a name list -- a constructor that IGNORES
				// its argument would silently compute the wrong value, hence the `wrapper/call` difftest cases and real constructors.
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

		// A pre-seeded host import (`LIB_HOST_IMPORTS`) has no `FunctionDecl` and belongs to no module, so it is registered
		// under its BARE name, not `homeKey(homeModule, name)`; looking it up the latter way missed and `compileFunc` then crashed.
		const info = decl
			? (decl.typeParams?.length
				? ensureGenericFunc(name, decl, args, typeArgs, ctx, expected, homeModule)
				: ensureStructuralInstance(name, decl, args, ctx, homeModule) ?? ensureFunc(name, decl, homeModule))
			: funcs.get(name);
		if (!info)
			throw `call to unknown function '${name}'`;
		emitCallArgs(name, info.params, info.defaults, !!info.hasRest, args, ctx, info.resolvedParams);
		ctx.emit(I.call(info.funcIndex));
		return info.result;
	}

	// Dispatches a `receiver.name(...args)` call against any `ClassInfo` -- `inlineMethods` (checked first) splices its instructions into the caller with no `call`.
	// `receiver` is `undefined` for a namespace-style call (`Math.sqrt(x)`), where there is no real value to push, just a bare name used to look up `owner`.
	// `bypassVirtual` is set only by `super.method(...)`, which is by definition never virtual regardless of whether `owner` has overriding subclasses.
	function emitMethodCall(owner: ClassInfo, name: string, args: Expr[], ctx: FunctionContext, typeArgs?: Type[], bypassVirtual?: boolean): W.Type {
		const inline = owner.inlineMethods?.get(name);
		if (inline) {
			if (args.some(a => a.type === 'spread'))
				throw 'spread call arguments are not supported';
			return emitInline(name, inline(args.map(a => operandInfo(a, ctx)), ctx, typeArgs), args, ctx);
		}

		// `owner.decl.name`, not `owner.name`: `hasDeclaredOverride` is keyed by the bare declared name, while a generic
		// instantiation's `owner.name` is a mangled composite -- which `ensureVirtualDispatch` doesn't support, so it never matches.
		const method = !bypassVirtual && !typeArgs && owner.decl.name && hasDeclaredOverride(owner.decl.name, name) ? ensureVirtualDispatch(owner, name, ctx)
			: ensureMethod(owner, name, args, ctx, typeArgs);
		if (!method) {
			// Not a declared method -- a closure-typed *field* called via member syntax ('this.step(v)') is a real, general
			// capability: read the field off the receiver already on the stack, then the same call_ref dance `case 'call'` does.
			const fieldIndex = owner.fieldIndex.get(name);
			const fieldWtype = fieldIndex !== undefined ? owner.fields[fieldIndex].wtype : undefined;
			if (fieldWtype && typeof fieldWtype !== 'string' && 'closure' in fieldWtype) {
				const sig = closureSigOf(fieldWtype);
				const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
				ctx.emit(I.struct.get(owner.typeIndex, fieldIndex!));
				const scratch = ctx.declareLocal(`$closure$${ctx.tempCounter++}`, fieldWtype);
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

	// `Object.entries(x)` -- a known, fixed-identity global intrinsic (`declare var Object` in lib.d.ts), not a name to special-case
	// the way a user method would be: what fields exist depends on `x`'s concrete type, which only the compiler itself can see.
	// A `Map`-backed dynamic object already has a correct, efficient `entries()`, so this forwards to it; a struct that is statically
	// known and never subclassed reads `owner.fields` directly, and anything else needs `ensureAnyEntries`' own `ref.test` cascade.
	// `which` selects the projection: `entries`/`keys`/`values` differ only in what each element is, and `Map` implements all three by name.
	function emitObjectEntries(args: Expr[], ctx: FunctionContext, which: 'entries' | 'keys' | 'values' = 'entries'): W.Type {
		if (args.length !== 1)
			throw `'Object.${which}' takes exactly one argument`;
		const arg	= args[0];
		const owner = ownerOf(arg, ctx);
		// No static field list (`object`, a narrowed `unknown`), or a class whose instances may really be a subclass carrying more
		// fields -- either way only the RECEIVER'S RUNTIME TYPE answers this, so box and go through the `ref.test` cascade.
		if (!owner || (owner.decl.name && everExtended.has(owner.decl.name))) {
			emitAs(arg, ctx, W.REF_ANY);
			ctx.emit(I.call(ensureAnyEntries(which).funcIndex));
			return W.ARRAY.ref;
		}

		emitAs(arg, ctx, owner.thisWtype!);
		if (owner.decl.name === 'Map')
			return emitMethodCall(owner, which, [], ctx);
		return emitEntriesOf(owner, which, ctx);
	}

	// The projection itself, for a receiver whose concrete struct type is already known and on the stack: `owner.fields` is a
	// compile-time-known list, so this synthesizes a real array literal and hands it to the ordinary array-literal codegen.
	// Shared by the static path and every `ensureAnyEntries` arm, so the two cannot disagree about a class's entries.
	function emitEntriesOf(owner: ClassInfo, which: 'entries' | 'keys' | 'values', ctx: FunctionContext): W.Type {
		const objName	= `#objEntries$${ctx.tempCounter++}`;
		const objLocal	= ctx.declareValue(objName, owner.thisWtype!, owner.thisTsType!);
		ctx.emit(I.local.set(objLocal.index));

		// The outer array's own kind is always `ref` (a boxed tuple per field), known outright, so this calls `emitArrayElements`
		// directly rather than routing through `emitAs`/`arrayKindOf` inference. Each tuple element stays a real `Expr` so the usual
		// per-element coercion delegates back to `case 'array'`, reusing the logic every other array literal already relies on.
		if (which === 'keys') {
			emitArrayElements(owner.fields.map((f): Expr => Literal(f.name)), ctx, W.ARRAY.i16, 'ref', types.array('ref'));
			return W.ARRAY.ref;
		}
		const value = (f: { name: string }): Expr => JS.Member(Identifier(objName), f.name);
		emitArrayElements(owner.fields.map((f): Expr => which === 'values' ? value(f) : ({
			type: 'array',
			elements: [Literal(f.name), value(f)],
		})), ctx, W.REF_ANY_NULLABLE, 'ref', types.array('ref'));
		return W.ARRAY.ref;
	}

	// `Object.defineProperty(target, key, {value, ...})` -- a known global intrinsic (`isDefinePropertyCall`), checked the same way
	// `Object.entries` is. Only a plain value descriptor is supported, never a getter/setter: a struct field has no live-computation
	// concept, and `enumerable`/`configurable`/`writable` have no effect without general struct-field reflection. `target` must be a
	// plain local variable, because only then does `case 'var_decl'`'s extension redirect leave it a real slot to write into.
	function emitObjectDefineProperty(args: Expr[], ctx: FunctionContext): W.Type {
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
		// Data (`value`) or an accessor (`get`/`set`). An accessor's halves land in the key's `#get:`/`#set:` companions, which every
		// read and write consults first; a later DATA definition clears them, which is how a self-replacing lazy getter memoizes.
		const member	= (name: string) => descExpr.properties.find(p => (p.type === 'field' || p.type === 'method') && p.key === name);
		const valueProp	= member('value'), getProp = member('get'), setProp = member('set');
		const valueExpr	= valueProp?.type === 'field' ? valueProp.value : undefined;
		if (valueProp && !valueExpr)
			throw "'Object.defineProperty': a descriptor's `value` must be a plain property";
		if (!valueExpr && !getProp && !setProp)
			throw "'Object.defineProperty': the descriptor needs a `value`, a `get` or a `set`";
		if ([getProp, setProp].some(p => p?.type === 'method' && usesThis(p)))
			throw "'Object.defineProperty': an accessor method that uses `this` is not supported -- its `this` is the target, which a closure cannot bind";
		const emitHalf = (p: NonNullable<typeof getProp>, want: W.Type) => {
			if (p.type === 'method')
				coerceTop(emitClosureLiteral(p, ctx, false, want), ctx, want);
			else if (p.type === 'field' && p.value)
				emitAs(p.value, ctx, want);
			else
				throw "'Object.defineProperty': an accessor must be a function";
		};

		// The target's own *real, physical* class, not `ownerOf`'s checker-type-based resolution: `case 'var_decl'`'s extension
		// redirect changes what the identifier's wasm local physically is, which its checker-level TS type cannot express.
		// `resolvedWtype`, not `lookup`: the target may be CAPTURED by the closure this runs in, where it is a closure-env field.
		const wt     = ctx.resolvedWtype(targetExpr.name);
		const owner  = wt && typeof wt !== 'string' && 'ref' in wt ? ensureClass(wt.ref) : undefined;
		// An erased receiver (a generic's `T`, `any`): the key's slot is on whichever structs reach it (`collectReceivedExpandos`),
		// so the write dispatches on the runtime struct.
		if (!owner && wt && typeof wt !== 'string' && 'ref' in wt && wt.ref === 'any') {
			if (valueExpr) {
				emitAs(targetExpr, ctx, W.REF_ANY);
				emitAs(valueExpr, ctx, W.REF_ANY_NULLABLE);
				ctx.emit(I.call(ensureAnyFieldWrite(key).funcIndex));
			}
			for (const [half, p, w] of [['get', getProp, getterWtype()], ['set', setProp, setterWtype()]] as const)
				if (p) {
					emitAs(targetExpr, ctx, W.REF_ANY);
					emitHalf(p, w);
					coerceTop(w, ctx, W.REF_ANY_NULLABLE);
					ctx.emit(I.call(ensureAnyFieldWrite(`#${half}:${key}`).funcIndex));
				}
			return emitExpr(targetExpr, ctx);
		}
		if (!owner)
			throw `'Object.defineProperty': '${targetExpr.name}' needs a known class type`;

		const scratch = ctx.declareLocal(`$defineProperty$${ctx.tempCounter++}`, owner.thisWtype!);
		emitAs(targetExpr, ctx, owner.thisWtype!);
		ctx.emit(I.local.set(scratch.index));

		// An accessor sets both companions (a half not given is cleared, as JS makes it `undefined`); data clears whichever exist.
		for (const [half, p] of [['get', getProp], ['set', setProp]] as const) {
			const idx = owner.fieldIndex.get(`#${half}:${key}`);
			if (idx === undefined) {
				if (getProp || setProp)
					throw `internal: '${owner.name}' has no ${half}ter slot for '${key}' -- every accessor target should have been collected`;
				continue;
			}
			ctx.emit(I.local.get(scratch.index));
			if (p && !valueExpr)
				emitHalf(p, owner.fields[idx].wtype);
			else
				ctx.emitDefaultValue(owner.fields[idx].wtype, types, toValType);
			ctx.emit(I.struct.set(owner.typeIndex, idx));
		}
		if (!valueExpr) {
			ctx.emit(I.local.get(scratch.index));
			return owner.thisWtype!;
		}

		ctx.emit(I.local.get(scratch.index));
		const fieldIdx = owner.fieldIndex.get(key);
		if (fieldIdx !== undefined) {
			// Already a real declared field -- inherited from the base, or synthesized by `ensureClassExtension`: both are
			// ordinary struct fields by this point, no distinction needed.
			emitAs(valueExpr, ctx, owner.fields[fieldIdx].wtype);
			ctx.emit(I.struct.set(owner.typeIndex, fieldIdx));
		} else {
			// The catch-all `Map<string, any>` extension field -- lazily allocated (nullable) on first use, then a real `.set`,
			// the same dynamic-object write a structural index-signature target already uses.
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
			emitMethodCall(mapCls, 'set', [Literal(key), valueExpr], ctx);
			ctx.emit(I.drop);
		}
		ctx.emit(I.local.get(scratch.index));
		return owner.thisWtype!;
	}

	// Two questions: whether the current value needs reading at all (`'none'`, only a plain `=` skips it),
	// and whether it needs preserving for `.old` (`'keep'`, only postfix `++`/`--`) or just combining once (`'discard'`, every compound op and prefix `++`/`--`) -- `'discard'` skips the extra scratch `'keep'` needs.
	function emitAssignTarget(target: Expr, ctx: FunctionContext, old: 'none' | 'discard' | 'keep'): AssignTarget {

		function captureOld(wtype: W.Type, readCore: () => void): number | undefined {
			let savedOld: number | undefined;
			if (old !== 'none') {
				readCore();
				if (old === 'keep') {
					savedOld = ctx.temp(`$old$${ctx.tempCounter++}`, wtype);
					ctx.emit(I.local.tee(savedOld));
				}
			}
			return savedOld;
		}
		function makeWrite(wtype: W.Type, storeCore: (val: number, name: string) => void): (tee: boolean) => number {
			return tee => {
				const name	= `$new$${ctx.tempCounter++}`;
				const val	= ctx.temp(name, wtype);
				ctx.emit(I.local.set(val));
				storeCore(val, name);
				if (tee)
					ctx.emit(I.local.get(val));
				return val;
			};
		}


		// `this = expr` (only inside a `reassignsThis` method): `this` parses as its own `{type:'this'}` node, not an `identifier`,
		// so its name needs the same separate derivation `case 'this'`'s read side does.
		if (target.type === 'identifier' || target.type === 'this') {
			const name = target.type === 'this' ? 'this' : target.name;
			// A captured free variable has no real local and no `local.tee` to lean on (wasm-GC has no `struct.tee`), so the write goes through a `$new` scratch local, same shape as `member` below.
			const captured = ctx.closureEnv?.fields.get(name);
			if (captured) {
				const { wtype, index } = captured;
				const envLocal		= ctx.closureEnv!.envLocal;
				const envTypeIndex	= ctx.closureEnv!.envTypeIndex;
				const getField		= () => ctx.emit(I.local.get(envLocal.index), I.struct.get(envTypeIndex, index));
				// A captured HOLDER holds the binding, not a copy of it, so a write from in here has to go through the holder -- that is the
				// whole reason the capture is a holder (`declareHolder`). The env field itself is never rebound.
				if (captured.holderInner) {
					const holderType = (wtype as { typeIndex: number }).typeIndex;
					return {
						wtype: captured.holderInner,
						old: captureOld(captured.holderInner, () => { getField(); ctx.emitHolderRead(holderType, captured.holderInner!); }),
						write: makeWrite(captured.holderInner, val => { getField(); ctx.emit(I.local.get(val), I.struct.set(holderType, 0)); }),
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
				// A lazily-initialized module-level value (see `lazyGlobalFor`). The old value must be read through the wrapper, never
				// straight off the slot: until the initializer has run once the slot is still null. The write then goes to that same slot.
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
			// Same for this function's own holder-backed local (`needsHolder`): the wasm local holds the holder, and every read and
			// write of the NAME goes through it, or a closure capturing it sees a stale value.
			if (loc.holderInner) {
				const holderType = (wtype as { typeIndex: number }).typeIndex;
				return {
					wtype: loc.holderInner,
					old: captureOld(loc.holderInner, () => { ctx.emit(I.local.get(index)); ctx.emitHolderRead(holderType, loc.holderInner!); }),
					write: makeWrite(loc.holderInner, val => ctx.emit(I.local.get(index), I.local.get(val), I.struct.set(holderType, 0))),
				};
			}
			return {
				wtype,
				old: captureOld(wtype, () => ctx.emit(isGlobal ? I.global.get(index) : I.local.get(index))),
				write(tee) {
					// Wasm has no `global.tee` (`global.set` is void) -- re-`global.get` right after when the caller needs the newly-written
					// value left on the stack too.
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
			const base = ownerOf(target.object, ctx);

			// A `set` accessor -- checked before the ordinary struct-field write, mirroring the read side's getter-probe in `case 'member'`.
			if (base?.setterNames?.has(target.property)) {
				const cls = base;
				const setSig = methodSig(cls, accessorKey('set', target.property), ctx);
				if (!setSig)
					throw `internal: setter '${target.property}' has no signature`;
				const wtype = setSig.params[0];

				// `emitAs`, not a raw `emitExpr` -- `target.object` may itself be a ref-kind array element read, boxed `anyref` regardless of its declared class (same reasoning as the plain struct-field write below).
				const objWtype = cls.thisWtype!;
				const obj = ctx.temp(`$obj$${ctx.tempCounter++}`, objWtype);
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
					write: makeWrite(wtype, (val, name) => {
						ctx.emit(I.local.get(obj));
						emitMethodCall(cls, accessorKey('set', target.property), [Identifier(name)], ctx);
					}),
				};
			}

			// An EXPANDO field is an ordinary field of the shape itself (`addExpandoFields`), so a concrete receiver needs nothing
			// special here. A UNION or `any` one has no single struct to write to, and gets the same `ref.test` cascade the READ side
			// already uses (`ensureAnyFieldWrite`) -- which is how `(s as any).scope ??= scope` on a `Stmt` parameter lands.
			const cls		= base;
			const fieldIdx	= cls?.fieldIndex.get(target.property);
			if (!cls || fieldIdx === undefined) {
				const prop = target.property;
				if ([...classes.values()].some(c => c.fieldIndex.has(prop) && c.typeIndex !== -1)) {
					const dispatch = ensureAnyFieldWrite(prop);
					return {
						wtype: W.REF_ANY_NULLABLE,
						old: captureOld(W.REF_ANY_NULLABLE, () => { emitAs(target.object, ctx, W.REF_ANY); ctx.emit(I.call(ensureAnyField(prop).funcIndex)); }),
						write: makeWrite(W.REF_ANY_NULLABLE, val => {
							emitAs(target.object, ctx, W.REF_ANY);
							ctx.emit(I.local.get(val), I.call(dispatch.funcIndex));
						}),
					};
				}
				throw `unknown field '${target.property}'`;
			}

			const wtype = cls.fields[fieldIdx].wtype;

			// `emitAs`, not a raw `emitExpr` -- `target.object` may be a ref-kind array element read, boxed `anyref`; `struct.set` needs the real narrowed `(ref cls)` first, same as the read-side fix in `case 'member'`.
			const objWtype = cls.thisWtype!;
			const obj = ctx.temp(`$obj$${ctx.tempCounter++}`, objWtype);
			emitAs(target.object, ctx, objWtype);
			ctx.emit(I.local.set(obj));
			return {
				wtype,
				old:	captureOld(wtype, () => { ctx.emit(I.local.get(obj)); emitFieldRead(cls, fieldIdx, ctx); }),
				write:	makeWrite(wtype, val => emitFieldWrite(cls, fieldIdx, obj, val, wtype, ctx)),
			};
			
		} else if (target.type == 'index') {
			// A class's own index accessors (`indexAccessor`) -- real index syntax dispatched generically, not by name.
			const cls		= classOfForIndexing(target.object, ctx);
			const getter	= cls && indexAccessor(cls, target.object, 'get', ctx);
			const setter	= cls && indexAccessor(cls, target.object, 'set', ctx);
			const getSig 	= cls && getter && methodSig(cls, getter, ctx);
			if (cls && getter && setter && getSig) {
				// `emitAs`, not a raw `emitExpr` -- same reasoning as the plain struct-field write path above.
				const objWtype = cls.thisWtype!;
				const obj = ctx.temp(`$obj$${ctx.tempCounter++}`, objWtype);
				emitAs(target.object, ctx, objWtype);
				ctx.emit(I.local.set(obj));
				emitAs(target.index, ctx, getSig.params[0]);
				const indexName = `$index$${ctx.tempCounter++}`;
				ctx.emit(I.local.set(ctx.temp(indexName, getSig.params[0])));
				const idxExpr: Expr = Identifier(indexName);
				const wtype = getSig.result;

				return {
					wtype,
					old: captureOld(wtype, () => {
						ctx.emit(I.local.get(obj));
						emitMethodCall(cls, getter, [idxExpr], ctx);
					}),
					write: makeWrite(wtype, (val, name) => {
						ctx.emit(I.local.get(obj));
						// `storeCore`'s own contract (see `makeWrite`) is to leave nothing on the stack -- true for free for a `void`-returning
						// `set(i,v)`, but `Map.set()` returns `this` for chaining, so its result needs an explicit drop or the whole
						// expression-statement's stack balance is wrong.
						if (emitMethodCall(cls, setter, [idxExpr, Identifier(name)], ctx) !== 'void')
							ctx.emit(I.drop);
					}),
				};
			}

			// A computed STRING key on a struct, the write side of `case 'index'`'s own by-name read (walker.ts's `mapObject`'s
			// `r[k] = ret`): the assignment goes to whichever field the key names, and a key naming none writes nothing, since a
			// struct has no slot to grow.
			const byNameOwner = classOfForIndexing(target.object, ctx);
			if (byNameOwner && byNameOwner.typeIndex !== -1 && byNameOwner.fields.length && T.isAssignable(ctx.narrowedTypeOf(target.index), T.STRING, ctx.typeScope)) {
				const n			= ctx.tempCounter++;
				const objId		= Identifier(`#keyobj$${n}`);
				const keyId		= Identifier(`#key$${n}`);
				const valId		= Identifier(`#keyval$${n}`);
				const keyWtype	= typeOf(T.STRING)!;
				emitAs(target.object, ctx, byNameOwner.thisWtype!);
				ctx.emit(I.local.set(ctx.declareValue(`#keyobj$${n}`, byNameOwner.thisWtype!, byNameOwner.thisTsType!).index));
				emitAs(target.index, ctx, keyWtype);
				ctx.emit(I.local.set(ctx.declareValue(`#key$${n}`, keyWtype, T.STRING).index));
				const valLocal	= ctx.declareValue(`#keyval$${n}`, W.REF_ANY_NULLABLE, T.ANY);
				const readChain	= byNameOwner.fields.reduce<Expr>((alternate, f) => Conditional<Expr>(
					Binary<Expr, '==='>('===', keyId, Literal(f.name)),
					JS.Member(objId, f.name),
					alternate,
				), Identifier('undefined'));
				return {
					wtype:	W.REF_ANY_NULLABLE,
					old:	captureOld(W.REF_ANY_NULLABLE, () => emitAs(readChain, ctx, W.REF_ANY_NULLABLE)),
					write:	makeWrite(W.REF_ANY_NULLABLE, val => {
						ctx.emit(I.local.get(val), I.local.set(valLocal.index));
						byNameOwner.fields.forEach(f => emitStmt({ type: 'if',
							test:		Binary<Expr, '==='>('===', keyId, Literal(f.name)),
							consequent:	JS.ExprStmt(Assign<Expr, never>(JS.Member(objId, f.name), valId)),
						} as Stmt, ctx));
					}),
				};
			}

			// The WRITE half of `ensureAnyKey`, reached the same way its read half is.
			if ((T.isAny(ctx.narrowedTypeOf(target.object)) || physicallyAny(target.object, ctx)) && T.isAssignable(ctx.narrowedTypeOf(target.index), T.STRING, ctx.typeScope)) {
				const n			= ctx.tempCounter++;
				const keyWtype	= typeOf(T.STRING)!;
				const objLocal	= ctx.declareValue(`#anykeyobj$${n}`, W.REF_ANY, T.ANY);
				const keyLocal	= ctx.declareValue(`#anykey$${n}`, keyWtype, T.STRING);
				emitAs(target.object, ctx, W.REF_ANY);
				ctx.emit(I.local.set(objLocal.index));
				emitAs(target.index, ctx, keyWtype);
				ctx.emit(I.local.set(keyLocal.index));
				return {
					wtype:	W.REF_ANY_NULLABLE,
					old:	captureOld(W.REF_ANY_NULLABLE, () => ctx.emit(I.local.get(objLocal.index), I.local.get(keyLocal.index), I.call(ensureAnyKey('get').funcIndex))),
					write:	makeWrite(W.REF_ANY_NULLABLE, val => ctx.emit(I.local.get(objLocal.index), I.local.get(keyLocal.index), I.local.get(val), I.call(ensureAnyKey('set').funcIndex))),
				};
			}

			const kind = objectArrayKind(target.object, ctx);
			// `i16`/`i8` (`string`/packed-byte storage) rejected same as `case 'index'`'s own read side.
			if (!kind || kind === 'i16' || kind === 'i8')
				throw "this operation is not supported";

			const typeIndex = types.array(kind);
			// Mirrors `case 'index'`'s own read-side result exactly -- a ref-kind array's write target is a boxed `any`, not a raw i32.
			const wtype		= kind === 'ref' ? W.REF_ANY_NULLABLE : kind;
			const objWtype	= emitExpr(target.object, ctx);
			const obj		= ctx.temp(`$obj$${ctx.tempCounter++}`, objWtype);
			ctx.emit(I.local.set(obj));
			emitAs(target.index, ctx, 'i32');
			// Always `i32` (an array index), so unlike `$obj`/`$new`/`$old` it genuinely cannot collide across two index writes in the same function.
			const idx		= ctx.temp('$index', 'i32');
			ctx.emit(I.local.set(idx));

			return {
				wtype,
				old: captureOld(wtype, () => ctx.emit(I.local.get(obj), I.local.get(idx), I.array.get(typeIndex))),
				// `wtype` -- the value on the stack was already coerced to it by the caller, so no extra conversion belongs here.
				write: makeWrite(wtype, val => ctx.emit(I.local.get(obj), I.local.get(idx), I.local.get(val), I.array.set(typeIndex))),
			};
		} else if (target.type === 'assign' && isPurePath(target.target)) {
			// `(a.b ??= []).push(x)`: the assignment runs first, and its own target is where the write-back goes (a wasm array's
			// `push` builds a new one). Only for a target without side effects, which is read again rather than held.
			emitStmt(JS.ExprStmt(target), ctx);
			const inner = emitAssignTarget(target.target, ctx, old);
			// The kept value is the assignment's result, non-null when that is (`??=`), though its slot may be nullable.
			const result = wtypeOf(target, ctx);
			if (old === 'keep' && typeof inner.wtype !== 'string' && inner.wtype.nullable && result && typeof result !== 'string' && !result.nullable)
				ctx.emit(I.ref.as_non_null);
			return inner;
		} else {
			// `(c ? a : b).push(x)` (type-utils.ts `iterationTypes`): a `this`-reassigning method's write-back goes to whichever
			// branch the receiver came from, so the test is held and both the read and the write branch on it.
			if (target.type === 'conditional') {
				const test = ctx.temp(`$ctarget$${ctx.tempCounter++}`, 'i32');
				emitTruthy(target.test, ctx);
				ctx.emit(I.local.set(test));
				const _outer	= ctx.swapOut();
				const a			= emitAssignTarget(target.consequent, ctx, old);
				const _readA	= ctx.swapOut();
				const b			= emitAssignTarget(target.alternate, ctx, old);
				const _readB	= ctx.swapOut(_outer);
				if (!W.typeEq(a.wtype, b.wtype))
					throw `cannot assign to a conditional whose branches differ ('${W.typeKey(a.wtype)}' and '${W.typeKey(b.wtype)}')`;
				ctx.emit(I.local.get(test), I.if(old === 'none' ? undefined : toValType(a.wtype), _readA, _readB));
				const savedOld = old === 'keep' ? ctx.temp(`$old$${ctx.tempCounter++}`, a.wtype) : undefined;
				if (savedOld !== undefined)
					ctx.emit(I.local.tee(savedOld));
				return { wtype: a.wtype, old: savedOld, write: tee => {
					const val = ctx.temp(`$new$${ctx.tempCounter++}`, a.wtype);
					ctx.emit(I.local.set(val));
					const _o = ctx.swapOut();
					ctx.emit(I.local.get(val));
					a.write(false);
					const _writeA = ctx.swapOut();
					ctx.emit(I.local.get(val));
					b.write(false);
					ctx.emit(I.local.get(test), I.if(undefined, _writeA, ctx.swapOut(_o)));
					if (tee)
						ctx.emit(I.local.get(val));
					return val;
				} };
			}
			throw `cannot assign to ${target.type}`;
		}
	}


	// Shared by `case 'arrow'`/`case 'function'` (an expression, `allowSelfCall: false`) and `case 'function_decl'` (a statement
	// nested in another function's body, `allowSelfCall: true`) -- builds the `{code, env}` closure struct and leaves it on the
	// stack, returning its `{closure}` wtype. `allowSelfCall` lifts the "can't reference own name" restriction and instead lets
	// calls to `selfName` from inside the body resolve to a direct `call` (see `ctx.selfCall`), since a self-*capture* is
	// impossible -- the struct can't be a field of itself before it exists.
	function emitClosureLiteral(
		e: TS.CallSig & {type: string, name?: string, modifiers?: string[], body?: Stmt[] | Expr },
		ctx: FunctionContext,
		allowSelfCall: boolean,
		want?: W.Type,
	): W.Type {
		if (hasMod(e, 'async'))
			throw 'an async arrow/function expression is not supported';
		if (hasMod(e, 'generator'))
			throw 'a generator function expression is not supported';
		// A closure literal inside a non-entry module's function body can reach here with its own param/return annotations never
		// stamped with a `declScope` (`makeLibScope`'s own "muted" comment documents the same class of gap). `ctx.scope` is exactly
		// the right scope regardless -- wherever `e` was written is `ctx`'s own home module -- and `T.stampScope` skips anything
		// already tagged, so this is safe unconditionally, before any of the literal's own types are asked for a wtype.
		e.params.forEach(p => p.typeAnnotation && T.stampScope(p.typeAnnotation, ctx.scope));
		if (e.returnType)
			T.stampScope(e.returnType, ctx.scope);
		// A generic closure *value* (unlike a generic function called directly, monomorphized per call site) is one physical closure
		// that has to work across every instantiation. Substituting each type param with its own upper bound (defaulting to `any` when
		// unconstrained) throughout params/return/body is enough, because a bounded value is already physically valid as its bound.
		if (e.typeParams?.length) {
			const map = T.constraintMap(e.typeParams, T.ANY);
			e = { ...T.instantiateSig(e, map), body: substituteTypeParams(map).body(e.body) };
		}

		const body	= e.body ?? [];
		if (e.name && !allowSelfCall && walkerB(undefined, (e1, process) => e1.type === 'identifier' ? e1.name === e.name : process(e1)).body(body))
			throw `a named function expression referencing its own name ('${e.name}') is not supported`;

		// The call site's expected closure signature (`want`, forwarded by `case 'arrow'`/`case 'function'`) wins over this literal's own `e.returnType` guess, when available
		// (`Rule([...], $ => ({type: 'spread', ...}))`-shaped calls in ts-parser.ts/js-parser.ts/binary-libs/wasm.ts). An unannotated arrow still gets *a* `e.returnType`
		// -- the checker's structural/anonymous inference back-filled into the same field real TS would have inferred, `checkFunctionBody`'s inference branch --
		// but an anonymous structural object type has no nominal identity for `typeOf`: it degrades to boxed `any`, and `case 'object'` rejects the body as needing a
		// known target type even though the caller's declared signature names the exact shape. An explicit annotation is safe too (the checker verified assignability,
		// so the physical wtypes are equivalent, upcast is free); a later, genuinely different but compatible use of the same closure value still hits `coerceTop`'s wrapper.
		const wantSig	= want && typeof want !== 'string' && 'closure' in want ? closureSigOf(want) : undefined;
		const result	= wantSig?.result ?? (e.returnType ? typeOf(e.returnType) : 'void');
		if (!result)
			throw 'closure has an unsupported return type';

		// Parameters past the callee's fixed ones are covered by its REST, physically a single array, so they are not wasm
		// params: `restBound` names them and the prologue binds each from `restArray[k]`, e.g. `(_, a, b) => ...` against `(s: string, ...args: any[])`.
		const fixedCount	= wantSig?.hasRest ? wantSig.params.length - 1 : e.params.length;
		const restBound		= wantSig?.hasRest && !e.rest ? e.params.slice(fixedCount) : [];
		const ownParams		= restBound.length ? e.params.slice(0, fixedCount) : e.params;

		// A defaulted parameter resolves as a declaration's does (`resolveParam`), typed by the contextual signature
		// when unannotated, with the earlier parameters in scope for its default.
		const earlier = new Set<string>(), defaultScope = new Scope(ctx.typeScope);
		const noteEarlier = (p: JS.Param<Type>, r: ResolvedParam) => {
			if (typeof p.key === 'string') {
				earlier.add(p.key);
				defaultScope.addValue(p.key, r.tsType);
			}
			return r;
		};
		const wantParam = (i: number) => i < fixedCount ? wantSig?.resolvedParams?.[i] : undefined;
		const params = ownParams.map((p, i): ResolvedParam => {
			if (p.default) {
				const fromWant = p.typeAnnotation ? undefined : wantParam(i);
				// Called through the wanted type: where its slot is optional, an omitted argument arrives as `undefined` (checker.ts's
				// `widen = true` as a `typeOf`'s `widen?: boolean`), so the literal applies its own default.
				const slot = i < fixedCount ? wantSig?.params[i] : undefined;
				return noteEarlier(p, resolveParam(fromWant ? { ...p, typeAnnotation: fromWant.tsType } : p, earlier, defaultScope, !!slot && typeof slot !== 'string' && !!slot.nullable));
			}
			// An UNANNOTATED parameter takes the callee's declared one, for the same reason `result` does above -- `Rules<T>(self => [...])`
			// and every `Rule([...], $ => ...)` can name it no other way. An annotation the checker wrote back names types from the
			// SIGNATURE's own module (printer.ts's `m` over `stmt.body` is annotated `ClassMember<Type>`, js-parser's), which need
			// not resolve here -- the wanted signature is the physical truth.
			const annotated = p.typeAnnotation && typeOf(p.typeAnnotation);
			const ctx = annotated ? undefined : wantParam(i);
			// See `closureFuncSigType`'s own identical comment -- box a real but wasm-unrepresentable
			// `void` as `any` rather than reject otherwise-valid source.
			const wt = annotated || ctx?.wtype;
			const boxed = wt === 'void' ? W.REF_ANY : wt;
			if (!boxed) {
				if (process.env.SHOWPARAM)
					console.error(`PARAM '${describeBinding(p.key)}' of ${e.name ?? '<anon>'}: want=${want ? W.typeKey(want) : '-'} wantSig=${!!wantSig} fromWantTs=${ctx ? T.typeKey(ctx.tsType).slice(0, 100) : '-'} ann=${p.typeAnnotation ? T.typeKey(p.typeAnnotation).slice(0, 100) : '-'}`);
				throw `closure parameter '${describeBinding(p.key)}' needs an explicit number/boolean/object type`;
			}
			// A bare `p?: T` needs a nullable physical slot to receive whatever a *caller* passes for an omitted argument -- omission
			// itself is entirely the caller's concern (`closureFuncSigType`'s `defaults`, built from the field/variable's own
			// declared TYPE, not this literal), since `call_ref` always supplies a real value for every physical param. The type
			// widens with the slot, as `resolveParam`'s does: left bare, `x ?? d` read `x` as never nullish and dropped `?? d`.
			const tsType = (annotated ? p.typeAnnotation : ctx?.tsType ?? p.typeAnnotation)!;
			return hasMod(p, 'optional') ? noteEarlier(p, { key: p.key, wtype: types.nullable(boxed), tsType: T.combineTypes([tsType, T.UNDEFINED]) })
				: noteEarlier(p, { key: p.key, wtype: boxed, tsType });
		});
		// The callee's own rest array becomes this literal's last physical parameter, whether or not the
		// literal spelled a rest -- the two must agree on the physical signature.
		if (restBound.length) {
			const restType = wantSig!.restElem;
			if (!restType)
				throw `closure parameter '${describeBinding(restBound[0].key)}' needs an explicit number/boolean/object type`;
			params.push({ key: '#rest', wtype: wantSig!.params[fixedCount], tsType: TS.ArrayType(restType.tsType) });
		}
		if (e.rest?.typeAnnotation) {
			const wt = restParamWtype(e.rest.typeAnnotation);
			if (!wt || wt === 'void')
				throw "a closure's rest parameter needs an explicit array type";
			params.push({key: e.rest.key, wtype: wt, tsType: e.rest.typeAnnotation });
		}

		const free = new Set<string>();
		collectClosureFreeVars(new Set(), e, e.name, free);

		if (e.type !== 'arrow' && free.has('this'))
			throw "'this' inside a function expression is not supported -- only an arrow function's lexical 'this' is";

		for (const name of free) {
			// `undefined`/`NaN`/`Infinity` are always-valid identifiers `case 'identifier'` handles directly (`isNullLiteral` for
			// `undefined` specifically), not real bindings `collectFreeVars` should have marked for capture/resolution -- treating
			// them as free vars made any nested closure using one (e.g. `extra !== undefined`) throw here unconditionally.
			if (name === 'undefined' || name === 'NaN' || name === 'Infinity')
				continue;
			// Module-scoped, so `resolvesGlobally` can never see them; the read site substitutes a constant.
			if ((name === '__dirname' || name === '__filename') && moduleFilename(ctx.homeModule))
				continue;
			if (!ctx.resolvesName(name) && !resolvesGlobally(ctx.homeModule, name) && !ensureForwardHolder(ctx, name))
				throw `unresolved identifier '${name}'`;
		}

		// Zero captures reuse `$envBase` directly -- no distinct type, no cast in the compiled body. A globally
		// resolvable free name (a top-level function, or a real wasm global) needs no capture slot either: the
		// body's own `case 'identifier'` fallback reaches it regardless of this closure's lexical nesting.
		const envBase		= types.envBase();
		const capturedNames = [...free].filter(name => ctx.resolvesName(name));
		const fields		= capturedNames.length ? new Map<string, { index: number; wtype: W.Type; holderInner?: W.Type }>() : undefined;
		let envTypeIndex	= envBase;
		if (fields) {
			// `rawWtype`, not `resolvedWtype`: a forward-holder has to be captured as the SHARED, mutable holder itself, so a later
			// write through it -- from wherever its own var_decl actually runs -- stays visible to this capture; `holderInner` lets
			// every READ unbox back to the logical value (`case 'identifier'`'s own read path).
			envTypeIndex = types.add({ final: true, supertypes: [envBase], type: { kind: 'struct', fields: capturedNames.map((name, i) => {
				const wt = ctx.rawWtype(name)!;
				const holderInner = ctx.closureEnv?.fields.get(name)?.holderInner ?? ctx.lookup(name)?.holderInner;
				fields.set(name, { index: i, wtype: wt, holderInner });
				return { type: toValType(wt), mut: true };
			}) } });
		}

		const sig: FuncSig = { params: params.map(p => p.wtype), result, hasRest: !!e.rest || !!restBound.length, defaults: ownParams.map((p, i) => params[i].calleeDefault || (!p.default && hasMod(p, 'optional')) ? Identifier('undefined') : p.default), resolvedParams: params };
		// Captured now: the body compiles later, once this literal's own context (`Rule<CallSig>`'s action) is gone.
		// The checker's own contextual type wins: it saw the chosen OVERLOAD, where `ctx` only has the implementation's.
		const contextFn		= (e as { contextualType?: Type }).contextualType ?? ctx.contextualReturn;
		const fnContext		= contextFn && T.resolve(ctx.typeScope, contextFn);
		// This function's OWN declared return type is the literal's context: `return { type: kind, ...sig }` against a declared
		// union picks the member it names (`matchContextualUnionMember`), where an untargeted literal matches every same-shaped
		// class in the program and shape matching then refuses to guess.
		const returnContext	= (e.returnType as Type | undefined) ?? (fnContext?.type === 'function' ? fnContext.returnType : undefined);
		const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
		const { funcIndex, typeIndex }	= types.funcAt(funcTypeIndex);
		const info: FuncInfo = { ...sig, funcIndex, typeIndex };
		closureLiterals.push(info);
		// A body naming itself as a VALUE (checker.ts `typeOf`'s `recurse`, captured by arrows inside it) binds its name to the
		// closure it runs as: its own code over the env it was given. A direct self-call stays direct (`selfCall` is tried first).
		// Not where a parameter or the body re-binds the name (printer.ts `function typeArgs(typeArgs?: Type[])`): those references
		// are to that binding, and a local for the function itself would collide with it.
		const selfType = allowSelfCall && e.name && !ownBoundNames(paramNames(e.params, e.rest), body).has(e.name) && namesSelfAsValue(body, e.name)
			? (e as { scope?: Scope }).scope?.value(e.name) ?? checkerTypeOf({ ...e, type: 'function' } as Expr, ctx.typeScope)
			: undefined;

		worklist.push(W.withCatchAt(() => {
			const fnCtx		= new FunctionContext(e.name ?? '<anonymous>', new Scope(libGlobal), plainReturn(result, returnContext), undefined, ctx.homeModule);
			// Env param first (real wasm param index 0), then this literal's own params -- `toFuncBody`'s `numParams` assumes the first `1 + params.length` declared locals are the real wasm params, in order.
			const envParam	= fnCtx.declareLocal('#envParam', { typeIndex: envBase, nullable: false });
			const pending	= fnCtx.declareParams(params);
			// Each rest-covered parameter is read back out of that one array as a real `let x = #rest[k]`, so the
			// ordinary indexing path types and emits it; the declared type must ride along or it reads back as the element type.
			pending.unshift(...restBound.map((p, k) => JS.VarDecl('let', JS.Var<Type>(p.key,
				JS.Index(Identifier('#rest'), Literal(k)), p.typeAnnotation ?? wantSig!.restElem!.tsType))));
			// The cast-down env local (or, with no captures, just the param itself) is declared after the real params, so it's a genuine local, not mistaken for one more wasm param.
			let envLocal	= envParam;
			if (fields) {
				envLocal = fnCtx.declareLocal('#env', { typeIndex: envTypeIndex, nullable: false });
				fnCtx.emit(I.local.get(envParam.index), I.ref.cast(envTypeIndex), I.local.set(envLocal.index));
			}
			fnCtx.closureEnv = { envLocal, envTypeIndex, fields: fields ?? new Map() };
			if (allowSelfCall && e.name)
				fnCtx.selfCall = info;
			if (selfType) {
				fnCtx.emit(I.ref.func(funcIndex), I.local.get(envParam.index), I.i32.const(jsLength(e.params)), I.struct.new(structTypeIndex));
				fnCtx.emit(I.local.set(fnCtx.declareValue(e.name!, closureWtype(sig), selfType).index));
			}
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
				emitStmts(body, fnCtx);
				fnCtx.emitTrailingUnreachable(result);
			} else {
				// The checker stamps an expression body with the scope it checked it in, as it stamps a block body's statements.
				emitStmt(Object.assign(JS.Return(body) as Stmt, { scope: (body as any).scope }), fnCtx);
			}
			info.body = fnCtx.toFuncBody(1 + params.length, toValType);
		}, e, ctx.homeModule, `${e.name ?? '<closure>'} in ${ctx.name}`));

		// `struct.new` pops fields in declaration order (`ensureClosureType`'s `[code, env]`), so the code pointer goes on the
		// stack before the env struct. Each capture is read raw (`rawSlot`, not the ordinary identifier-read case): a
		// forward-holder must be captured as the holder itself (see `rawWtype`'s own comment just above), never unboxed here; a
		// capture-of-a-capture (an ordinary, non-holder name) resolves identically either way.
		ctx.emit(I.ref.func(funcIndex));
		for (const name of capturedNames) {
			if (name === 'this')
				emitExpr({ type: 'this' }, ctx);
			else
				ctx.rawSlot(name);
		}
		ctx.emit(fields ? I.struct.new(envTypeIndex) : I.struct.new_default(envBase));
		ctx.emit(I.i32.const(jsLength(e.params)), I.struct.new(structTypeIndex));
		return closureWtype(sig);
	}

	// A plain named function used as a *value* rather than called directly by name (`case 'call'` resolves that straight to
	// `funcs.get(name)`, no closure struct ever involved). A top-level function captures nothing, so it is compiled with no `env`
	// param and its own `funcIndex` can't fill a closure's `code` field (always `(env, ...params)`). This builds one shared
	// zero-capture trampoline per function name instead -- same shape `emitClosureLiteral`'s own zero-capture case builds (`env`
	// ignored, `envBase` reused directly, no distinct env type) -- forwarding to the real, already- or newly-compiled function.
	function ensureFunctionValueWrapper(name: string, decl: FunctionDecl, homeModule = '.', want?: W.Type, typeArgs?: Type[]): { info: FuncInfo; structTypeIndex: number } {
		const key = typeArgs ? `${homeKey(homeModule, name)}<${typeArgs.map(T.typeKey).join(',')}>` : homeKey(homeModule, name);
		const existing = functionValueWrappers.get(key);
		if (existing) {
			const { structTypeIndex } = ensureClosureType({ params: existing.params, result: existing.result, hasRest: existing.hasRest });
			return { info: existing, structTypeIndex };
		}
		// A GENERIC function used as a VALUE has no call site to infer from, so its type parameters erase to their bounds --
		// exactly what `closureSigParts` already does for a generic function TYPE, and what the value's own declared type
		// (`CommonAction<C> = <T>(value: T, ...) => any`) erases to on the other side of the assignment. One instantiation,
		// since the erasure is fixed; explicit type arguments (an instantiation expression, `f<A>`) pick the instantiation instead.
		const erased	= decl.typeParams?.length
			? new Map(decl.typeParams.map((p, i) => [p.name, (typeArgs?.[i] ?? (typeArgs && p.default) ?? p.constraint ?? T.ANY) as Type]))
			: undefined;
		const instance	= erased && genericKey(name, decl.typeParams!, erased, global);
		const target	= funcs.get(instance || key) ?? (instance
			? compileFunc(instance, instantiateDecl(decl, erased!, homeModule), homeModule, name)
			: compileFunc(name, decl, homeModule));
		if (!target)
			throw `'${name}' can't be used as a value`;

		// `defaults` travel with it: a slot with fewer params converts by supplying them (`ensureClosureCoercionWrapper`).
		const sig: FuncSig = { params: target.params, result: target.result, hasRest: target.hasRest, defaults: target.defaults };
		const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
		const { funcIndex, typeIndex } = types.funcAt(funcTypeIndex);
		// Erasure answers only where the WANTED signature is itself erased (`CommonAction<C> = <T>(value: T, ...) => any`); a
		// concrete one needs the real instantiation, which nothing here can infer (`want` is physical and carries no type
		// arguments), so say that rather than let it surface as an `internal: cannot convert (ref:any)=>ref:any to (f64)=>f64` further out.
		if (erased && !typeArgs && want && typeof want !== 'string' && 'closure' in want
			&& want.closure.params.length === sig.params.length
			&& !want.closure.params.every((p, i) => W.typeEq(p, sig.params[i])))
			throw `generic function '${name}' as a value only erases to its bounds -- a concrete instantiation is not supported`;

		const info: FuncInfo = { ...sig, funcIndex, typeIndex, defaults: target.defaults };
		closureLiterals.push(info);
		functionValueWrappers.set(key, info);

		worklist.push(() => {
			const wctx		= new FunctionContext(`<fnvalue>.${name}`, new Scope(libGlobal), plainReturn(target.result), undefined);
			wctx.declareLocal('#envParam', { typeIndex: types.envBase(), nullable: false });
			const argLocals = target.params.map((p, i) => wctx.declareLocal(`$arg$${i}`, p));
			argLocals.forEach(l => wctx.emit(I.local.get(l.index)));
			wctx.emit(I.call(target.funcIndex));
			info.body = wctx.toFuncBody(1 + argLocals.length, toValType);
		});
		return { info, structTypeIndex };
	}

	// A bare `f` or a namespace-qualified `NS.f` read as a VALUE resolves to a top-level function exactly as a call would.
	function functionValueDecl(e: Expr, ctx: FunctionContext): { name: string; decl: FunctionDecl; module: string } | undefined {
		if (e.type === 'identifier') {
			const own = resolveDecl(ctx.homeModule, e.name);
			if (own)
				return own.type === 'function_decl' && own.body ? { name: e.name, decl: own, module: ctx.homeModule } : undefined;
			const imported = namedImportsByModule.get(ctx.homeModule)?.get(e.name);
			const decl = imported && functionDeclByName.get(homeKey(imported.module, imported.name));
			return decl?.type === 'function_decl' && decl.body ? { name: imported!.name, decl, module: imported!.module } : undefined;
		}
		if (e.type === 'member' && e.object.type === 'identifier' && !ctx.lookup(e.object.name)) {
			const nsDecl	= ctx.scope.namespace(e.object.name)?.decl(e.property);
			const module	= nsDecl && stmtHomeModule.get(nsDecl);
			const decl		= module !== undefined ? functionDeclByName.get(homeKey(module, e.property)) : undefined;
			return decl?.type === 'function_decl' && decl.body ? { name: e.property, decl, module: module! } : undefined;
		}
		return undefined;
	}


	// `e.object[e.index]` held in locals, `read` run only when the index is below the length (unsigned, so a negative index is past the end too), `null` otherwise.
	function emitBoundedRead(e: Expr & { type: 'index' }, objWtype: W.Type, resultWtype: W.Type, ctx: FunctionContext, read: (obj: W.Local, idx: W.Local & { name: string }) => void): W.Type {
		const n		= ctx.tempCounter++;
		const objName	= `$bobj$${n}`;
		const obj		= ctx.declareValue(objName, objWtype, ctx.narrowedTypeOf(e.object));
		const idx		= Object.assign(ctx.declareValue(`$bidx$${n}`, 'i32', T.NUMBER), { name: `$bidx$${n}` });
		emitAs(e.object, ctx, objWtype);
		ctx.emit(I.local.set(obj.index));
		emitAs(e.index, ctx, 'i32');
		ctx.emit(I.local.set(idx.index), I.local.get(idx.index));
		// Raw storage is its own bound; anything else answers through its own `length`, as JS reads it.
		if (typeof objWtype === 'object' && 'arr' in objWtype)
			ctx.emit(I.local.get(obj.index), I.array.len);
		else
			emitAs(JS.Member(Identifier(objName), 'length'), ctx, 'i32');
		ctx.emit(I.i32.lt_u);
		ctx.emitIf(toValType(resultWtype), () => read(obj, idx), () => ctx.emitDefaultValue(resultWtype, types, toValType));
		return resultWtype;
	}

	// A bare name bound to a module-level VALUE, not a function (`walker.ts`'s `export const isJsStatement = guard<TS.Stmt>(...)`,
	// called by name in `printer.ts`): the call calls the value it holds, as a namespace member's does.
	function isModuleValue(name: string, ctx: FunctionContext): boolean {
		if (ctx.resolvesName(name) || resolveDecl(ctx.homeModule, name) || funcs.has(homeKey(ctx.homeModule, name)))
			return false;
		const imported	= namedImportsByModule.get(ctx.homeModule)?.get(name);
		const decl		= imported ? moduleScopeOf(imported.module)?.decl(imported.name) : moduleScopeOf(ctx.homeModule)?.decl(name);
		// Not an inline-asm intrinsic (`const loadI32 = __asm<[i32], i32>('i32.load')`): that IS the instruction, not a value.
		const init		= decl?.type === 'var_decl' ? decl.declarations.find(d => d.name === (imported?.name ?? name))?.init : undefined;
		return !!init && !(init.type === 'call' && isAsm(init));
	}


	function emitFunctionValue(fn: { name: string; decl: FunctionDecl; module: string }, want: W.Type | undefined, ctx: FunctionContext, typeArgs?: Type[]): W.Type {
		const { info, structTypeIndex } = ensureFunctionValueWrapper(fn.name, fn.decl, fn.module, want, typeArgs);
		ctx.emit(I.ref.func(info.funcIndex), I.struct.new_default(types.envBase()), I.i32.const(jsLength(fn.decl.params)), I.struct.new(structTypeIndex));
		return closureWtype({ params: info.params, result: info.result, hasRest: info.hasRest, defaults: info.defaults });
	}

	// A closure *value* whose own concrete signature doesn't match some slot it's being coerced into, but real TS/JS would still
	// allow it -- either a covariant return (`(x: number) => number` fitting `(x: number) => number | undefined`, the common
	// shape a mapped type's own homomorphic value type produces: `Partial<{...}>`'s `?`-optional value widens every property
	// with `| undefined`, though a real property/callback value written against one key rarely bothers writing that itself),
	// or fewer declared params than `wantSig` offers (`arr.map(x => x*2)` never declares `index`/`array` at all; found via
	// `lib/map.ts`'s own `entries()` calling `Array<K>.map((k, i) => ...)`, itself two short of the real 3-param `callbackfn`).
	// Unlike a scalar (`coerceTop` alone converts one already-on-the-stack value in place), a closure's own compiled signature
	// is fixed at its own `funcTypeIndex`, so there is no in-place conversion, only wrapping: one small, shared trampoline per
	// (source, wanted) signature pair, not one per use site, that declares `wantSig`'s full param list (the wrapper's real arity
	// -- a caller through `wantFuncTypeIndex` always passes all of them), forwards only the leading `gotSig.params.length` to the
	// original closure (silently dropping the rest, as real JS ignores a shorter callback's trailing arguments) and coerces just
	// the return. Contravariant widening of a *shared* leading param is not attempted.
	function ensureClosureCoercionWrapper(gotSig: FuncSig, wantSig: FuncSig): { info: FuncInfo; wantStructTypeIndex: number; envTypeIndex: number } {
		const key = `(${gotSig.params.map(W.typeKey).join(',')})=>${W.typeKey(gotSig.result)}=>(${wantSig.params.map(W.typeKey).join(',')})=>${W.typeKey(wantSig.result)}`;
		const existing = closureCoercionWrappers.get(key);
		if (existing)
			return existing;

		const { funcTypeIndex: gotFuncTypeIndex, structTypeIndex: gotStructTypeIndex } = ensureClosureType(gotSig);
		const { funcTypeIndex: wantFuncTypeIndex, structTypeIndex: wantStructTypeIndex } = ensureClosureType(wantSig);
		const { funcIndex, typeIndex } = types.funcAt(wantFuncTypeIndex);
		const info: FuncInfo = { ...wantSig, funcIndex, typeIndex };
		closureLiterals.push(info);
		// A dedicated one-field env struct (a real `envBase` subtype, like any other closure's own capture struct) holding just the
		// original closure value: the {code,env} pair is *not* an `envBase` subtype (no supertypes, see `ensureClosureType`), so unlike
		// `emitClosureLiteral`'s zero-capture case it can't reuse `envBase` as this wrapper's own env directly.
		const envTypeIndex = types.add({ final: true, supertypes: [types.envBase()], type: { kind: 'struct', fields: [
			{ type: toValType({ typeIndex: gotStructTypeIndex, nullable: false }), mut: false },
		] } });
		const result = { info, wantStructTypeIndex, envTypeIndex };
		closureCoercionWrappers.set(key, result);

		worklist.push(() => {
			const wctx		= new FunctionContext(`<coerce>.${key}`, new Scope(libGlobal), plainReturn(wantSig.result), undefined);
			const envParam	= wctx.declareLocal('#envParam', { typeIndex: types.envBase(), nullable: false });
			const argLocals	= wantSig.params.map((p, i) => wctx.declareLocal(`$arg$${i}`, p));
			const env		= wctx.declareLocal('#env', { typeIndex: envTypeIndex, nullable: false });
			wctx.emit(I.local.get(envParam.index), I.ref.cast(envTypeIndex), I.local.set(env.index));
			wctx.emit(I.local.get(env.index), I.struct.get(envTypeIndex, 0), I.struct.get(gotStructTypeIndex, 1));
			// Each argument coerced from what the CALLER passes to what the callback declared -- see the `paramFits` guard: a `ref.cast` for a reference, a no-op when the two agree.
			argLocals.slice(0, gotSig.params.length).forEach((l, i) => {
				wctx.emit(I.local.get(l.index));
				coerceTop(wantSig.params[i], wctx, gotSig.params[i]);
			});
			// Params the caller never passes get the callback's own defaults, exactly as a call site omitting them would.
			gotSig.params.slice(argLocals.length).forEach((p, i) => {
				const d = gotSig.defaults?.[argLocals.length + i];
				if (d)
					emitAs(d, wctx, p);
				else
					wctx.emitDefaultValue(p, types, toValType);
			});
			wctx.emit(I.local.get(env.index), I.struct.get(envTypeIndex, 0), I.struct.get(gotStructTypeIndex, 0), I.call_ref(gotFuncTypeIndex));
			coerceTop(gotSig.result, wctx, wantSig.result);
			info.body = wctx.toFuncBody(1 + argLocals.length, toValType);
		});
		return result;
	}

	// Real `ToInt32`: truncate, then keep the low 32 bits. The plain saturating `i32.trunc_sat_f64_s` that `coerceTop` uses
	// everywhere else would answer `i32::MAX` for `2147483648 | 0` and `(4294967296 + 5) | 0`, which are -2147483648 and 5.
	// Saturation deliberately stays the rule for an index or a length (see `coerceTop`'s own comment); `ToInt32` applies exactly
	// where JS specifies it, the bitwise operators. A non-finite input has no meaningful `i64` truncation, so it answers 0, as JS says.
	function emitToInt32(e: Expr, ctx: FunctionContext): void {
		emitAs(e, ctx, 'f64');
		const tmp = ctx.temp(`$toint32$${ctx.tempCounter++}`, 'f64');
		ctx.emit(I.local.set(tmp), I.local.get(tmp), I.f64.abs, I.f64.const(Infinity), I.f64.lt);
		ctx.emitIf(toValType('i32'),
			() => ctx.emit(I.local.get(tmp), I.i64.trunc_sat_f64_s, I.i32.wrap_i64),
			() => ctx.emit(I.i32.const(0)));
	}

	const BITWISE_METHODS = new Set(['and', 'or', 'xor', 'shl', 'shr_s', 'shr_u']);


	// `want`, when passed, is a hint only -- lets a literal pick its physical representation directly instead
	// of `coerceTop` immediately converting it back. The returned `WasmType` is always the actual physical type left on the stack.
	function emitExpr(e: Expr, ctx: FunctionContext, want?: W.Type): W.Type {
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
						return W.ARRAY.i16;

					case 'bigint': {
						// A `bigint` VALUE is a two's-complement little-endian `u32[]` (see `typeOf`, and `lib/bigint.ts`'s own limb walks), so that
						// is what a literal must build. An `i64` here disagrees with every other bigint: `10n - 4n` reinterprets it as limbs and
						// gives -1, `Number(5n)` cannot convert, past 64 bits truncate. A real `i64` slot (`__towasm_mulWide`'s declared params,
						// a global on an i64 slot) still gets the constant directly -- the one place the two agree.
						if (want === 'i64') {
							ctx.emit(I.i64.const(e.value));
							return 'i64';
						}
						// Limbs in exactly the form `lib/bigint.ts` reads back: little-endian `u32`, TWO'S COMPLEMENT (not sign-magnitude), sign-
						// extended so the top limb's high bit IS the sign, and trimmed the way `bigTrim` trims -- no top limb merely repeating the sign below.
							
						const limbs: number[] = [];
						let x = e.value;
						if (x >= 0n) {
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
						for (const l of limbs)
							ctx.emit(I.i32.const(l | 0));
						ctx.emit(I.array.new_fixed(types.array('i32'), limbs.length));
						return W.ARRAY.i32;
					}

					case 'object':
						if (e.value instanceof RegExp) {
							// desugars to an ordinary `new RegExp(source, flags)` against `lib/regexp.ts`'s own self-hosted class
							return emitExpr({
								type: 'new',
								callee: Identifier('RegExp'),
								arguments: [Literal(e.value.source), Literal(e.value.flags)],
							}, ctx, want);
						}
						if (Array.isArray(e.value)) {
							if (e.value.length === 1 && !e.value[0].exp) {
								emitStringConst(e.value[0].str, ctx);
								return W.ARRAY.i16;
							}

							// Resolved first: `stringTemplate` takes REAL arrays (`string[]`, `any[]`), so each storage array built below is coerced to its parameter as soon as it exists.
							// A missing lib entry would otherwise emit the arrays and silently skip the call.
							const decl = LIB_DECL_MAP.get('stringTemplate');
							const info = decl && decl.type === 'function_decl' ? ensureFunc('stringTemplate', decl) : undefined;
							if (!info)
								throw "internal: lib 'stringTemplate' is unavailable";
							for (const p of e.value)
								emitStringConst(p.str, ctx);
							const hasTrailingLiteral = !e.value[e.value.length - 1].exp;
							if (!hasTrailingLiteral)
								emitStringConst('', ctx);
							ctx.emit(I.array.new_fixed(types.array('ref'), e.value.length + (hasTrailingLiteral ? 0 : 1)));
							coerceTop(W.ARRAY.ref, ctx, info.params[0]);
							let valueCount = 0;
							for (const p of e.value) {
								if (p.exp) {
									emitAs(p.exp, ctx, W.REF_ANY);
									valueCount++;
								}
							}
							ctx.emit(I.array.new_fixed(types.array('ref'), valueCount));
							coerceTop(W.ARRAY.ref, ctx, info.params[1]);
							ctx.emit(I.call(info.funcIndex));
							return W.ARRAY.i16;
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
				// `this` isn't a real value at all yet during `ensureCtor`'s collect-then-`struct.new` path (`ctx.ctorFields` stays set for
				// exactly as long as that's true, cleared once the last field is collected); an *already-collected* field read straight
				// off `this` has its own shortcut in `case 'member'` below. Anything reaching this point -- an unassigned field, a method
				// call, bare `this` -- has no value to produce, and is caught here for a specific message rather than the generic throw.
				if (e.type === 'this' && ctx.ctorFields)
					throw `'this' can't be used yet in '${ctx.owner?.name}'s constructor -- it has at least one object-typed field, which needs every field's real value collected up front (for 'struct.new') before 'this' exists at all; assign every field via a plain 'this.field = value' statement before using 'this' any other way`;
				// A captured free variable has no real local of its own -- read via `struct.get` off the
				// cast env local instead. Checked before `ctx.lookup`, since it's never also in `ctx.locals`.
				const captured = ctx.closureEnv?.fields.get(name);
				if (captured) {
					ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index), I.struct.get(ctx.closureEnv!.envTypeIndex, captured.index));
					// A forward-holder's captured field holds the holder itself (`rawSlot`'s own comment): unbox it back to the real,
					// logical value here -- the one ordinary read of this name that wants it, unlike `emitClosureLiteral`'s own raw capture.
					if (captured.holderInner) {
						ctx.emitHolderRead((captured.wtype as { typeIndex: number }).typeIndex, captured.holderInner);
						return captured.holderInner;
					}
					return captured.wtype;
				}
				const local = ctx.lookup(name);
				if (local) {
					ctx.emit(I.local.get(local.index));
					if (local.holderInner) {
						ctx.emitHolderRead((local.wtype as { typeIndex: number }).typeIndex, local.holderInner);
						return local.holderInner;
					}
					return local.wtype;
				}

				let g = globals.get(name);
				if (!g) {
					const global = LIB_DECL_MAP.get(name);
					// Only an initializer a wasm global can really be INITIALIZED from -- the same test the entry module's own top-level
					// scan applies. Registering an array/object/string/`new` one here would throw "needs a compile-time-constant initializer"
					// at emit time and -- because `g` was set -- shadow the `lazyGlobalFor` fallback that exists for exactly this case.
					const eager = global?.type === 'var_decl' && global.init ? eagerGlobalInit(global.init, global.typeAnnotation) : undefined;
					if (global && global.type === 'var_decl' && eager)
						g = ensureGlobal(name, typeOf(global.typeAnnotation!)!, eager, global.kind !== 'const');
				}
				if (g) {
					ctx.emit(I.global.get(g.index));
					return g.wtype;
				}

				// A module-level `const`/`let` whose value ISN'T a wasm compile-time constant -- an array, object literal, string, `new`,
				// a call: exactly what `ensureLazyGlobal` builds for the same declaration when it's *called* (`case 'call'`'s factory-const path).
				{
					const lazy = lazyGlobalFor(name, ctx);
					if (lazy) {
						ctx.emit(I.call(lazy.wrapper.funcIndex));
						return lazy.wrapper.result;
					}
				}

				// A plain named function read as a value (passed, assigned, returned) rather than called by name -- see
				// `ensureFunctionValueWrapper`'s comment. `name` may also be an `import { foo }` binding local to `ctx.homeModule`, the same redirect `emitCall` does.
				const fnValue = functionValueDecl(e, ctx);
				if (fnValue)
					return emitFunctionValue(fnValue, want, ctx);
				// CommonJS's own per-module wrapper names -- module-scoped rather than global, see `checker.bindModuleNames`.
				// A compile-time constant, the substitution a bundler makes: the compiled module has no file of its own to ask at runtime.
				if (name === '__dirname' || name === '__filename') {
					const file = moduleFilename(ctx.homeModule);
					if (file)
						return emitExpr(Literal(name === '__dirname' ? path.dirname(file) : file), ctx, want);
				}
				throw `unresolved identifier '${name}'`;
			}

			case 'member': {
				// An `enum` MEMBER folds to its constant: an enum has no runtime object here (see
				// `enumMembers`), so this is the only way a read of one resolves at all.
				if (e.object.type === 'identifier') {
					const v = enumMembers.get(homeKey(ctx.homeModule, `${e.object.name}.${e.property}`));
					if (v !== undefined)
						return emitExpr(Literal(v), ctx, want);
				}
				if (e.object.type === 'identifier') {
					const owner = namespaceOwner(e.object.name, ctx);
					if (owner) {
						const f = owner.decl.body.find(m => m.type === 'field' && m.key === e.property && m.modifiers?.includes('static'));
						if (!f || f.type !== 'field' || !f.value)
							throw `unknown static field '${owner.name}.${e.property}'`;
						return emitExpr(f.value, ctx);
					}
					// `NS.someConst` -- another module's module-level const through `import * as NS`: the same lazy wrapper a bare
					// identifier read of one already uses, just resolved in the namespace's own scope, and only when nothing local shadows the name.
					const ns = ctx.lookup(e.object.name) ? undefined : ctx.scope.namespace(e.object.name);
					if (ns) {
						const lazy = lazyGlobalFor(e.property, ctx, ns);
						if (lazy) {
							ctx.emit(I.call(lazy.wrapper.funcIndex));
							return lazy.wrapper.result;
						}
						// `NS.someFunction` read as a VALUE (`makeRule(Common.stampPos)`): the same function-value wrapper a bare reference gets,
						// resolved in the target module exactly as a namespace-qualified CALL resolves it -- without it the read treats the
						// namespace itself as an object and tries to represent every function it exports.
						const fnValue = functionValueDecl(e, ctx);
						if (fnValue)
							return emitFunctionValue(fnValue, want, ctx);
					}
				}

				const cls = classOfForIndexing(e.object, ctx);

				// A dynamic object (`{[k: string]: V}`, routed to `Map<string, V>` -- see `indexSignatureValueType`): `o.a` and `o['a']`
				// are the same access in TS, so a dot read must route to `get` too. Before the getter and field checks below, since the
				// receiver's TS type exposes no `Map` member at all -- `env.size` must read the `'size'` KEY, not the map's own count.
				// A real `Map`-typed value is unaffected: its type is a `ref`, for which `indexSignatureValueType` is undefined.
				if (cls && !isOptionalChainLink(e) && indexSignatureValueType(T.resolve(ctx.typeScope, ctx.narrowedTypeOf(e.object))) && methodSig(cls, 'get', ctx)) {
					emitAs(e.object, ctx, cls.thisWtype!);
					return emitMethodCall(cls, 'get', [Literal(e.property)], ctx);
				}

				// A `get` accessor -- checked before both the `.length` special case and the ordinary
				// struct-field read, so a real getter (e.g. `Array<T>.length`) takes priority over either.
				if (cls?.getterNames?.has(e.property)) {
					// `isOptionalChainLink`, not a bare `e.optional`: `a?.b.getter` continues `a?.b`'s own chain though *this* access writes
					// no `?.` of its own (see the checker's own `isOptionalChainLink` comment, shared verbatim). `methodSig` gives the
					// getter's result type without emitting, which `emitOptionalAccess` needs to type its own result before the call is built.
					const getter = accessorKey('get', e.property);
					const sig = isOptionalChainLink(e) ? methodSig(cls, getter, ctx) : undefined;
					if (sig) {
						const objWtype = types.nullable(cls.thisWtype!);
						emitAs(e.object, ctx, objWtype);
						const resultWtype = types.nullable(sig.result);
						return ctx.emitOptionalAccess(objWtype, resultWtype, toValType, objLocal => {
							ctx.emit(I.local.get(objLocal), I.ref.as_non_null);
							emitMethodCall(cls, getter, [], ctx);
							coerceTop(sig.result, ctx, resultWtype);
						});
					}
					emitAs(e.object, ctx, cls.thisWtype!);
					return emitMethodCall(cls, getter, [], ctx);
				}

				const fieldIdx	= cls?.fieldIndex.get(e.property);
				if (!cls || fieldIdx === undefined) {
					// `classOf` couldn't resolve a single owner -- one real reason, besides a genuinely unknown field, is a receiver
					// whose static type is a union of different object shapes (`unionClassMembers`), boxed as `any` by `typeOf`.

					const t = T.resolve(ctx.typeScope, ctx.narrowedTypeOf(e.object));
					if (t.type === 'union') {
						const owners = T.unionMembers(t, ctx.typeScope).filter(m => !T.isNullish(m, ctx.typeScope)).flatMap(m => flattenOwners(m, ctx.typeScope) ?? [undefined]);
						if (owners.length > 1 && owners.every(o => o && o.typeIndex !== -1)) {
							const info = ensureUnionFieldDispatch(owners as ClassInfo[], e.property, T.lookupMember(T.nonNullable(t, ctx.typeScope), e.property, ctx.typeScope));
							if (isOptionalChainLink(e)) {
								emitAs(e.object, ctx, W.REF_ANY_NULLABLE);
								const resultWtype = types.nullable(info.result);
								return ctx.emitOptionalAccess(W.REF_ANY_NULLABLE, resultWtype, toValType, objLocal => {
									ctx.emit(I.local.get(objLocal), I.ref.as_non_null, I.call(info.funcIndex));
									coerceTop(info.result, ctx, resultWtype);
								});
							}
							emitAs(e.object, ctx, W.REF_ANY);
							ctx.emit(I.call(info.funcIndex));
							return info.result;
						}
					}
					// A physically-extended value (`Object.defineProperty`'s own write side -- see `ensureClassExtension`'s own comment)
					// whose checker-level type never reflects the extension, since no real TS syntax expresses it: `cls` above, resolved
					// through the checker type, only sees the plain base class. A plain local (possibly through an `as`) may instead hold
					// a wasm local whose own physical wtype is already the extended form.
					const identExpr = unwrapAs(e.object);
					if (identExpr.type === 'identifier') {
						const local		= ctx.lookup(identExpr.name);
						const physCls	= local && typeof local.wtype !== 'string' && 'ref' in local.wtype ? ensureClass(local.wtype.ref) : undefined;
						const physIdx	= physCls?.fieldIndex.get(e.property);
						if (physCls && physIdx !== undefined) {
							ctx.emit(I.local.get(local!.index));
							return emitFieldRead(physCls, physIdx, ctx);
						}
						const extIdx = physCls?.fieldIndex.get('#ext');
						if (physCls && extIdx !== undefined) {
							const mapCls = ensureClass('Map', [TS.RefType('string'), T.ANY]);
							if (mapCls) {
								// The catch-all field itself may still be un-allocated (`null`, never `defineProperty`'d), reading as `undefined` either
								// way -- matching real JS's never-set-property semantics: `Map.get` already gives that for a missing key on an
								// allocated map, so only the map itself never allocated needs this branch.
								ctx.emit(I.local.get(local!.index), I.struct.get(physCls.typeIndex, extIdx), I.ref.is_null);
								ctx.emitIf(toValType(W.REF_ANY), () => emitAs(Identifier('undefined'), ctx, W.REF_ANY), () => {
									ctx.emit(I.local.get(local!.index), I.struct.get(physCls.typeIndex, extIdx), I.ref.as_non_null);
									emitMethodCall(mapCls, 'get', [Literal(e.property)], ctx);
								});
								return W.REF_ANY;
							}
						}
					}
					// Every non-nullish member a closure: the value is a closure struct, which stores `CLOSURE_FIELDS` itself.
					const closureField = CLOSURE_FIELDS.get(e.property);
					const recvMembers = closureField !== undefined ? T.unionMembers(T.resolve(ctx.typeScope, ctx.narrowedTypeOf(e.object)), ctx.typeScope).filter(m => !T.isNullish(m, ctx.typeScope)) : [];
					if (recvMembers.length && recvMembers.every(m => { const w = typeOf(m); return !!w && typeof w !== 'string' && 'closure' in w; })) {
						const base = types.closureBase();
						if (isOptionalChainLink(e)) {
							const resultWtype = types.nullable('f64');
							emitAs(e.object, ctx, W.REF_ANY_NULLABLE);
							return ctx.emitOptionalAccess(W.REF_ANY_NULLABLE, resultWtype, toValType, objLocal => {
								ctx.emit(I.local.get(objLocal), I.ref.cast(base), I.struct.get(base, closureField!));
								coerceTop('u32', ctx, 'f64');
								coerceTop('f64', ctx, resultWtype);
							});
						}
						const w = emitExpr(e.object, ctx);
						if (typeof w !== 'string' && 'closure' in w) {
							if (w.nullable)
								ctx.emit(I.ref.as_non_null);
						} else {
							coerceTop(w, ctx, W.REF_ANY_NULLABLE);
							ctx.emit(I.ref.cast(base));
						}
						ctx.emit(I.struct.get(base, closureField!));
						return 'u32';
					}
					// A genuinely dynamic receiver still has a real answer -- see `ensureAnyField`. One stored as `any` (an open shape) is the same
					// question at run time, though its checker type names a shape.
					if (T.isAny(T.resolveOwn(ctx.narrowedTypeOf(e.object), ctx.typeScope)) || physicallyAny(e.object, ctx)) {
						emitAs(e.object, ctx, W.REF_ANY);
						ctx.emit(I.call(ensureAnyField(e.property).funcIndex));
						return W.REF_ANY_NULLABLE;
					}
					// A field the receiver's own shape does not declare but its NARROWED type does (`'type' in c` narrows `c` to a `Class`
					// that has one): the runtime struct decides, as `in` itself answered. A field missing from the declared type too is an error.
					const refined = ctx.stmtScope && checkerTypeOf(unwrapAs(e.object), ctx.stmtScope);
					if (refined && T.lookupMember(refined, e.property, ctx.typeScope)
						&& !T.lookupMember(checkerTypeOf(unwrapAs(e.object), ctx.scope), e.property, ctx.typeScope)) {
						emitAs(e.object, ctx, W.REF_ANY);
						ctx.emit(I.call(ensureAnyField(e.property).funcIndex));
						return W.REF_ANY_NULLABLE;
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

				// `isOptionalChainLink`, not a bare `e.optional` -- covers both a direct `a?.b` step and a non-optional continuation of an
				// earlier one (`a?.b.c`'s `.c`). `wtypeOf(e.object, ctx)` already reflects the real, possibly chain-induced nullability
				// (the checker's own `isOptionalChainLink`-aware inference), so `emitAs(e.object, ctx, objWtype)` recursing into `e.object`
				// (itself possibly *another* chain link) composes naturally: each link gets its own null check on whatever came before,
				// which is observably identical to one combined chain-wide short-circuit -- every link's object is evaluated exactly
				// once, into its own scratch local, so no side effect ever runs twice. Just nested `if`s instead of one flat guard,
				// simpler to get right than flattening the whole chain into a single guard; this file leans "correct first" over "most compact".
				if (isOptionalChainLink(e)) {
					// The class's own nullable ref, not the receiver's: an `any | undefined` local holds a boxed `anyref`.
					const objWtype = types.nullable(cls.thisWtype!);
					emitAs(e.object, ctx, objWtype);
					const resultWtype = types.nullable(fieldWtype);
					return ctx.emitOptionalAccess(objWtype, resultWtype, toValType, objLocal => {
						ctx.emit(I.local.get(objLocal));
						emitFieldRead(cls, fieldIdx, ctx);
						coerceTop(fieldWtype, ctx, resultWtype);
					});
				}

				// `emitAs`, not `emitExpr` -- `e.object` may itself be a ref-kind array element read, whose physical value is always boxed `anyref`; `struct.get`
				// needs the real narrowed `(ref cls)` first or wasm validation rejects it. A no-op when already concrete (`coerceTop`'s short-circuit).
				emitAs(e.object, ctx, { ref: cls.name });
				emitFieldRead(cls, fieldIdx, ctx);
				return fieldWtype;
			}

			case 'index': {
				// A class's own index accessor (`indexAccessor`), dispatched generically for real index syntax rather than by name.
				const cls		= classOfForIndexing(e.object, ctx);
				const getter	= cls && indexAccessor(cls, e.object, 'get', ctx);
				const sig		= cls && getter && methodSig(cls, getter, ctx);
				if (cls && getter && sig) {
					// `isOptionalChainLink`, not a bare `e.optional` -- see `case 'member'`'s own comment.
					if (isOptionalChainLink(e)) {
						if (sig.result === 'void')
							throw "'a?.[i]' is not supported -- 'get' returns 'void', which can't become 'void | undefined'";
						const objWtype = types.nullable(cls.thisWtype!);
						emitAs(e.object, ctx, objWtype);
						const resultWtype = types.nullable(sig.result);
						return ctx.emitOptionalAccess(objWtype, resultWtype, toValType, objLocal => {
							// Receiver pushed directly, skipping `emitMethodCall`'s own receiver-push, so the explicit `ref.as_non_null` is needed -- always sound, since
							// `readCore` only runs in the proven-non-null arm.
							ctx.emit(I.local.get(objLocal), I.ref.as_non_null);
							coerceTop(emitMethodCall(cls, getter, [e.index], ctx), ctx, resultWtype);
						});
					}
					const thisW = cls.thisWtype!;
					if (readsPastEnd(e, ctx) && isPositional(cls, ctx)) {
						const resultWtype = types.nullable(sig.result);
						return emitBoundedRead(e, thisW, resultWtype, ctx, (obj, idx) => {
							ctx.emit(I.local.get(obj.index));
							coerceTop(emitMethodCall(cls, getter, [Identifier(idx.name)], ctx), ctx, resultWtype);
						});
					}
					// `emitAs`, not `emitExpr` -- `e.object` may itself be boxed `anyref` (`a[i][j]`), same reasoning as the field-read cast.
					emitAs(e.object, ctx, thisW);
					return emitMethodCall(cls, getter, [e.index], ctx);
				}
				const kind = objectArrayKind(e.object, ctx);
				if (!kind || kind === 'i16' || kind === 'i8') {
					// Not a single class with its own `get(i)`, nor a single raw array kind: a real union of indexable classes (`Uint8Array | number[]`, `updateBuffer`'s `b[i]` in
					// `dwg/src/crc16.ts`). Every member resolves to a `get(i)`-owning `ClassInfo` via `ownerFor` -- a plain `number[]`/`boolean[]` included, via its own 'array' case,
					// same as a genuine typed-array view -- exactly `case 'member'`'s `ensureUnionFieldDispatch` shape through `get(i)` instead of a field/getter (see `ensureUnionIndexDispatch`).
					const t = T.resolve(ctx.typeScope, ctx.narrowedTypeOf(e.object));
					if (t.type === 'union') {
						const owners = T.unionMembers(t, ctx.typeScope).filter(m => !T.isNullish(m, ctx.typeScope)).map(m => ownerFor(m));
						if (owners.length > 1 && owners.every(o => o && o.typeIndex !== -1 && methodSig(o, '__get', ctx))) {
							emitAs(e.object, ctx, W.REF_ANY);
							emitAs(e.index, ctx, 'i32');
							const info = ensureUnionIndexDispatch(owners as ClassInfo[]);
							ctx.emit(I.call(info.funcIndex));
							return info.result;
						}
					}
					// A computed STRING key on a struct (`walker.ts`'s `mapObject`, `node[k]` with `k: keyof N`): JS looks the property up by name at run time, which is that comparison
					// over the class's own field names -- synthesized, so the ordinary member reads and conditional lowering compile it. A key naming no field reads `undefined`, as JS does.
					const byName = classOfForIndexing(e.object, ctx);
					if (byName && byName.typeIndex !== -1 && byName.fields.length && T.isAssignable(ctx.narrowedTypeOf(e.index), T.STRING, ctx.typeScope)) {
						const n			= ctx.tempCounter++;
						const objId		= Identifier(`#keyobj$${n}`);
						const keyId		= Identifier(`#key$${n}`);
						const keyWtype	= typeOf(T.STRING)!;
						emitAs(e.object, ctx, byName.thisWtype!);
						ctx.emit(I.local.set(ctx.declareValue(`#keyobj$${n}`, byName.thisWtype!, byName.thisTsType!).index));
						emitAs(e.index, ctx, keyWtype);
						ctx.emit(I.local.set(ctx.declareValue(`#key$${n}`, keyWtype, T.STRING).index));
						return emitExpr(byName.fields.reduce<Expr>((alternate, f) => Conditional<Expr>(
							Binary<Expr, '==='>('===', keyId, Literal(f.name)),
							JS.Member(objId, f.name),
							alternate,
						), Identifier('undefined')), ctx, want ?? W.REF_ANY_NULLABLE);
					}
					// A computed key on an ERASED receiver -- typed `any`, or a union of differing structs boxed as one -- has no single struct to chain
					// over, so every class's own arm is picked by `ref.test` at run time: `x[k]` as JS reads it (the checker's own `throughSources`).
					if ((T.isAny(ctx.narrowedTypeOf(e.object)) || physicallyAny(e.object, ctx)) && T.isAssignable(ctx.narrowedTypeOf(e.index), T.STRING, ctx.typeScope)) {
						emitAs(e.object, ctx, W.REF_ANY);
						emitAs(e.index, ctx, typeOf(T.STRING)!);
						ctx.emit(I.call(ensureAnyKey('get').funcIndex));
						return W.REF_ANY_NULLABLE;
					}
					throw `'${T.exprKey(e.object)}' is indexed but is not an array, a typed array, or a class with index accessors (its type: '${T.typeKey(ctx.narrowedTypeOf(e.object))}')`;
				}
				// `nullable: true` on the 'ref' case -- `types.array`'s `'ref'`-kind field is nullable (shared physical storage for every non-scalar kind),
				// so `array.get` always really produces a nullable `anyref`, whatever the caller's declared TS element type claims.
				const elemWtype: W.Type = kind === 'ref' ? { ref: 'any', nullable: true } : kind;
				// `isOptionalChainLink`, not a bare `e.optional` -- see `case 'member'`'s own comment.
				if (isOptionalChainLink(e)) {
					const objWtype = wtypeOf(e.object, ctx);
					if (!objWtype)
						throw "'a?.[i]' has an unsupported object type";
					emitAs(e.object, ctx, objWtype);
					const resultWtype = types.nullable(elemWtype);
					return ctx.emitOptionalAccess(objWtype, resultWtype, toValType, objLocal => {
						ctx.emit(I.local.get(objLocal));
						emitAs(e.index, ctx, 'i32');
						ctx.emit(I.array.get(types.array(kind)));
						coerceTop(elemWtype, ctx, resultWtype);
					});
				}
				if (readsPastEnd(e, ctx)) {
					const resultWtype = types.nullable(elemWtype);
					return emitBoundedRead(e, W.ARRAY[kind], resultWtype, ctx, (obj, idx) => {
						ctx.emit(I.local.get(obj.index), I.local.get(idx.index), I.array.get(types.array(kind)));
						coerceTop(elemWtype, ctx, resultWtype);
					});
				}
				emitAs(e.object, ctx, W.ARRAY[kind]);
				emitAs(e.index, ctx, 'i32');
				ctx.emit(I.array.get(types.array(kind)));
				return elemWtype;
			}

			// The asserted type is compile-time-only: compile the inner expression and pass its actual `WasmType` straight through, ignoring the assertion.
			case 'as':
				// The asserted type is the expression's own context: `{ type: 'array', ... } as Expr` names the union
				// member to build, where an untargeted literal matches every same-shaped class in the program.
				return ctx.withContext(e.typeAnnotation, () => emitExpr(e.expression, ctx, want));

			// `f<A>` / `NS.f<A>` read as a VALUE (`ts-parser.ts`'s `export const CallSig = JS.CallSig<Type>`): the generic function instantiated at those type arguments,
			// as a closure. A call through one goes the same way.
			case 'instantiation': {
				const fnValue = functionValueDecl(e.expression, ctx);
				if (!fnValue)
					throw `'${T.exprKey(e.expression)}' with type arguments names no generic function`;
				return emitFunctionValue(fnValue, want, ctx, e.typeArgs);
			}

			// Every expression but the last runs purely for its side effects (`emitStmt`'s own `'void'`-then-`I.drop` idiom); only the last one's value (and `want`) matters.
			case 'sequence':
				for (let i = 0; i < e.expressions.length - 1; i++)
					if (emitExpr(e.expressions[i], ctx, 'void') !== 'void')
						ctx.emit(I.drop);
				return emitExpr(e.expressions[e.expressions.length - 1], ctx, want);

			// A ref-kind element (`string[]`, a class array, ...) needs `REF_ANY` as the per-element target -- `coerceTop`'s widen-to-`any` case boxes each one, not
			// the bare `kind` string, which only coincides with a real `WasmType` for scalar kinds.
			// `want` naming a real class wins outright; otherwise `matchObjectShape` resolves the literal structurally, against a declared interface/class first and
			// a freshly synthesized anonymous shape (`ensureAnonObjectShape`) only when no declared type matches. Fields push in the *shape's own declared order*
			// (`struct.new` needs every field value up front, in that fixed order), not the literal's written order -- looked up from its properties by name.
			case 'object': {
				// `want` naming one class wins outright when it does; otherwise a real declared union target (`ctx.contextualReturn`) discriminant-matched to one member
				// wins next, which guarantees the exact same struct `ownerFor` would independently build for that member later -- `matchObjectShape`'s own candidate scan
				// cannot, since nothing may have triggered building the interface's "official" struct yet. `matchObjectShape`'s structural/discriminant match runs only
				// once both give up, most commonly for a `REF_ANY` target (a generic callback's own return value, boxed as `any` per `typeOf`'s own union case).
				//
				// A DECLARED shape first, then the union-shaped path, and an anonymous shape only after both: a written discriminant whose value is a union of literals
				// (`{ type: kind, ... }`, `kind: 'f' | 'c'`) fits no single member, and taken as anonymous it built a struct no reader of the union could ever test for.
				const declared = (typeof want === 'object' && 'ref' in want ? ensureClass(want.ref) : undefined)
					?? matchContextualUnionMember(e, ctx)
					?? spreadOwner(e, ctx)
					?? matchObjectShape(e, ctx, false);
				if (!declared) {
					const variants = emitUnionShapedLiteral(e, ctx, want);
					if (variants)
						return variants;
				}
				const owner = declared ?? matchObjectShape(e, ctx);
				if (!owner)
					throw "an object literal needs a known target type (e.g. a 'const x: Point = {...}' with a plain 'type Point = {...}' alias) -- not supported here";

				// A dynamic object -- this literal's target type was a structural index signature, `{[k: string]: V}`, routed to `Map<string, V>` by `indexSignatureValueType` --
				// constructs via the real constructor plus one `.set(key, value)` call per property, not struct-field assignment: no fixed fields to assign at all, the whole point
				// is an arbitrary, runtime key set. `set` returns `this`, so each call's result is already the next one's receiver -- no scratch local needed.
				if (owner.decl.name === 'Map') {
					const ctor = ensureCtor(owner, [], ctx);
					emitCallArgs(`${owner.name}'s constructor`, ctor.params, ctor.defaults, !!ctor.hasRest, [], ctx, ctor.resolvedParams);
					ctx.emit(I.call(ctor.funcIndex));
					if (!e.properties.some(p => p.type === 'spread')) {
						for (const p of e.properties) {
							if (p.type !== 'field' || typeof p.key !== 'string' || !p.value)
								throw `object literal for '${owner.name}' can only have plain 'key: value' properties (no methods or computed keys)`;
							emitMethodCall(owner, 'set', [Literal(p.key), p.value], ctx);
						}
						return owner.thisWtype!;
					}
					// `{...other, k: v}` -- spreading one dynamic object's own live entries into another needs a real loop over the keys `other` currently holds, so the map
					// instance needs a real local to reference across iterations (the stack-chaining above, `set`'s own `this` return feeding the next call, only works for a
					// fixed, statically-known sequence of calls). Each spread argument is evaluated once into a local, matching JS's one-evaluation-per-spread semantics,
					const n			= ctx.tempCounter++;
					const mapName	= `#dynobj$${n}`;
					const mapLocal	= ctx.declareValue(mapName, owner.thisWtype!, owner.thisTsType!);
					ctx.emit(I.local.set(mapLocal.index));
					let spreadIndex = 0;
					for (const p of e.properties) {
						if (p.type === 'spread') {
							// A spread source whose own fields are STATICALLY KNOWN -- a plain object or class, not another dynamic object -- needs no runtime key walk: each
							// known key becomes an ordinary `set`.
							const srcCls = ownerOf(p.operand, ctx);
							if (srcCls && srcCls.decl.name !== 'Map') {
								const srcName	= `#spread$${n}$${spreadIndex++}`;
								const srcLocal	= ctx.declareValue(srcName, srcCls.thisWtype!, srcCls.thisTsType!);
								emitAs(p.operand, ctx, srcCls.thisWtype!);
								ctx.emit(I.local.set(srcLocal.index));
								for (const key of srcCls.fieldIndex.keys()) {
									ctx.emit(I.local.get(mapLocal.index));
									emitMethodCall(owner, 'set', [Literal(key), JS.Member(Identifier(srcName), key)] as Expr[], ctx);
								}
								continue;
							}
							const spreadName	= `#spread$${n}$${spreadIndex}`;
							const kName			= `#spreadkey$${n}$${spreadIndex++}`;
							const spreadLocal	= ctx.declareValue(spreadName, owner.thisWtype!, owner.thisTsType!);
							emitAs(p.operand, ctx, owner.thisWtype!);
							ctx.emit(I.local.set(spreadLocal.index));
							// The same desugaring `case 'for'`'s own `'in'` kind uses, synthesized directly rather than as a real `for...in` node -- there is no user-written
							// loop variable or body, just one copy step per spread argument.
							emitStmt({
								type: 'for', kind: 'of',
								init: JS.VarDecl('const', JS.Var(kName)),
								right: JS.Call(JS.Member(Identifier(spreadName), 'keys'), []),
								body: JS.Block({
									type: 'expression', expression: {
										type: 'call',
										callee: JS.Member(Identifier(mapName), 'set'),
										arguments: [Identifier(kName), JS.Call(JS.Member(Identifier(spreadName), 'get'), [Identifier(kName)])],
									},
								}),
							} as Stmt, ctx);
							continue;
						}
						if (p.type !== 'field' || typeof p.key !== 'string' || !p.value)
							throw `object literal for '${owner.name}' can only have plain 'key: value' properties (no methods or computed keys)`;
						ctx.emit(I.local.get(mapLocal.index));
						if (emitMethodCall(owner, 'set', [Literal(p.key), p.value], ctx) !== 'void')
							ctx.emit(I.drop);
					}
					ctx.emit(I.local.get(mapLocal.index));
					return owner.thisWtype!;
				}

				// One source per target field name -- a plain value expression or a spread operand, with each `{...x}` operand evaluated once into its own scratch local
				// right here (real JS's one-evaluation-per-spread semantics, matching the Map-backed case above) rather than re-emitting `p.operand` once per field it
				// supplies. A later source for the same field name overwrites an earlier one, and only a field this class actually declares is ever read back off a spread
				// operand -- any of the operand's own extra fields are simply not part of this shape, as a real JS spread's excess properties would never be looked at.
				interface FieldSource { expr?: Expr; method?: JS.Method<Type>; spreadLocal?: W.Local; spreadCls?: ClassInfo; unionCls?: ClassInfo[]; nullable?: boolean }
				// Every source for a field, in written order -- not just the last one. `{...D, ...opts}` is the reason: an OPTIONAL property of a later operand is only
				// "last wins" when it is actually present at runtime, so an absent one has to fall back to whatever came before it.
				const sources = new Map<string, FieldSource[]>();
				const addSource = (key: string, src: FieldSource) => sources.set(key, [...(sources.get(key) ?? []), src]);
				for (const p of e.properties) {
					if (p.type === 'spread') {
						// An anonymous object shape has no nominal class for `ownerOf` to find, so it gets the same synthesized struct a literal targeting that shape would.
						const spreadT	= T.resolve(ctx.scope, ctx.narrowedTypeOf(p.operand));
						const spreadCls	= ownerOf(p.operand, ctx) ?? (spreadT.type === 'object' ? ensureAnonObjectShape(spreadT) : undefined);
						if (!spreadCls) {
							// A union spread operand (`js-parser.ts`'s `{ ...args[0] }`, `args[0]: CallSig | Params`): each field is read off whichever member the value is, and is
							// absent where that member has none, as it is for a nullish operand.
							const parts		= spreadT.type === 'union' ? T.unionMembers(spreadT, ctx.scope) : [];
							const solid		= parts.filter(m => !T.isNullish(m, ctx.scope));
							const unionCls	= solid.flatMap(m => flattenOwners(m, ctx.typeScope) ?? [undefined]);
							if (!unionCls.length || !unionCls.every(o => o && o.typeIndex !== -1))
								throw `object literal for '${owner.name}': a spread operand needs a known object type, got '${T.typeKey(spreadT)}'`;
							const spreadLocal = ctx.declareLocal(`$spread$${ctx.tempCounter++}`, W.REF_ANY_NULLABLE);
							emitAs(p.operand, ctx, W.REF_ANY_NULLABLE);
							ctx.emit(I.local.set(spreadLocal.index));
							const src: FieldSource = { spreadLocal, unionCls: unionCls as ClassInfo[], nullable: solid.length < parts.length };
							for (const name of new Set(src.unionCls!.flatMap(m => m.fields.map(f => f.name))))
								addSource(name, src);
							continue;
						}
						const spreadLocal = ctx.declareValue(`$spread$${ctx.tempCounter++}`, spreadCls.thisWtype!, spreadCls.thisTsType!);
						emitAs(p.operand, ctx, spreadCls.thisWtype!);
						ctx.emit(I.local.set(spreadLocal.index));
						for (const f of spreadCls.fields)
							addSource(f.name, { spreadLocal, spreadCls });
						continue;
					}
					const src: FieldSource | undefined = p.type === 'field' ? p.value && { expr: p.value } : p.type === 'method' ? { method: p } : undefined;
					if (typeof p.key !== 'string' || !src)
						throw `object literal for '${owner.name}' can only have plain 'key: value' properties, methods or a spread (no accessors or computed keys)`;
					if (!owner.fieldIndex.has(p.key))
						throw `object literal for '${owner.name}' has unknown property '${p.key}'`;
					if (src.method && usesThis(src.method))
						throw `object literal for '${owner.name}': a method that uses \`this\` is not supported -- its \`this\` is the receiver, which a closure cannot bind`;
					addSource(p.key, src);
				}
				// "Certain" means the source always yields a value: an explicit `k: v`, a spread of a field that isn't optional, or -- for a union spread -- a field every
				// member declares and none optionally, with a never-nullish operand.
				const certain	= (src: FieldSource, name: string) => !!src.expr || !!src.method || (src.unionCls
					? !src.nullable && src.unionCls.every(m => { const i = m.fieldIndex.get(name); return i !== undefined && !m.fields[i].optional; })
					: !src.spreadCls!.fields[src.spreadCls!.fieldIndex.get(name)!].optional);
				const rawWtype	= (src: FieldSource, name: string) => src.spreadCls!.fields[src.spreadCls!.fieldIndex.get(name)!].wtype;
				const readSpread = (src: FieldSource, name: string, want: W.Type): void => {
					if (!src.unionCls) {
						const idx = src.spreadCls!.fieldIndex.get(name)!;
						ctx.emit(I.local.get(src.spreadLocal!.index));
						emitFieldRead(src.spreadCls!, idx, ctx);
						coerceTop(src.spreadCls!.fields[idx].wtype, ctx, want);
						return;
					}
					const members = src.unionCls;
					const arm = (i: number): wasm.Instr[] => {
						if (i >= members.length)
							return [I.unreachable];
						const m = members[i], idx = m.fieldIndex.get(name);
						ctx.emit(I.local.get(src.spreadLocal!.index), I.ref.test(m.typeIndex));
						const _cond = ctx.swapOut();
						if (idx === undefined) {
							ctx.emitDefaultValue(want, types, toValType);
						} else {
							ctx.emit(I.local.get(src.spreadLocal!.index), I.ref.cast(m.typeIndex));
							emitFieldRead(m, idx, ctx);
							coerceTop(m.fields[idx].wtype, ctx, want);
						}
						return [..._cond, I.if(toValType(want), ctx.swapOut(), arm(i + 1))];
					};
					if (!src.nullable)
						return void ctx.emit(...arm(0));
					ctx.emit(I.local.get(src.spreadLocal!.index), I.ref.is_null);
					ctx.emitIf(toValType(want), () => ctx.emitDefaultValue(want, types, toValType), () => ctx.emit(...arm(0)));
				};
				// A spread copies VALUES: JS reads each property through [[Get]] into a plain data property, so an accessor's getter never carries over -- the key's own
				// read (`emitFieldRead`) already called it, and the copy's slot stays empty.
				const copiesGetter = (f: { name: string }) => f.name.startsWith('#get:') || f.name.startsWith('#set:');
				const emitOne	= (src: FieldSource, f: { name: string; wtype: W.Type }) => {
					if (!src.expr && !src.method && copiesGetter(f))
						return void ctx.emitDefaultValue(f.wtype, types, toValType);
					if (src.method) {
						coerceTop(emitClosureLiteral(src.method, ctx, false, f.wtype), ctx, f.wtype);
					} else if (src.expr) {
						// The field's declared type is the value's context: a nested literal picks its union member from it.
						ctx.withContext(owner.fieldDeclaredType(f.name, global), () => emitAs(src.expr!, ctx, f.wtype));
					} else {
						readSpread(src, f.name, f.wtype);
					}
				};
				// `last ?? (the one before it ?? ...)`, lowered like the `??` operator.
				const emitChain = (chain: FieldSource[], f: { name: string; wtype: W.Type }): void => {
					if (copiesGetter(f))
						return void ctx.emitDefaultValue(f.wtype, types, toValType);
					const last = chain[chain.length - 1];
					if (chain.length === 1 || certain(last, f.name))
						return emitOne(last, f);
					const srcWtype	= last.unionCls ? types.nullable(f.wtype) : rawWtype(last, f.name);
					const tmp		= ctx.declareLocal(`$spread$${f.name}$${ctx.tempCounter++}`, srcWtype);
					readSpread(last, f.name, srcWtype);
					ctx.emit(I.local.tee(tmp.index), I.ref.is_null);
					ctx.emitIf(toValType(f.wtype), () => emitChain(chain.slice(0, -1), f), () => {
						ctx.emit(I.local.get(tmp.index));
						coerceTop(srcWtype, ctx, f.wtype);
					});
				};
				for (const f of owner.fields) {
					const chain = sources.get(f.name);
					if (!chain?.length) {
						if (!f.optional)
							throw `object literal for '${owner.name}' is missing property '${f.name}'`;
						ctx.emitDefaultValue(f.wtype, types, toValType);
					} else {
						// Trim before the last certain source: it can never be observed.
						const from = chain.reduce((acc, src, i) => certain(src, f.name) ? i : acc, 0);
						emitChain(chain.slice(from), f);
					}
				}
				ctx.emit(I.struct.new(owner.typeIndex));
				return owner.thisWtype!;
			}

			case 'array': {
				// `want`'s own kind wins whenever it asks for something boxable-as-`any`, either directly (`{arr:'ref'}`, a real `any[]` target) or because this literal
				// is itself about to be boxed as one `anyref` value (`const values: any[] = [1, 2, 3]`) -- `arrayKindOf` only sees the elements, so it would otherwise
				// build a real `number[]`, and a scalar-kind wasm array and a ref-kind one are physically incompatible types (not just a missing cast).
				//
				// The `{ref:'any'}` case covers one more shape: a literal merely an *element* of an outer ref-kind array (`[1,2]` inside `number[][]`), where the array
				// reference itself upcasts to `anyref` for free and only its elements would need boxing if it were genuinely `any`-typed, which it isn't --
				// `ctx.contextualReturn` says `number[]`, not `any[]`. Force boxed storage only when that contextual type is itself `any`/unknown or unavailable.
				// The wanted STORAGE kind: either `want` is the storage itself, or it is a class that owns some (an `Array<T>`), whose single field says which --
				// an empty literal has no elements to infer from and would otherwise default to boxed-`any`.
				const wantArr = storageKindOf(want);
				// A union context names the literal's own member, as the checker takes it (`string | number[]`): reads narrowed to that member expect its representation.
				const contextual	= ctx.contextualReturn && T.resolve(ctx.scope, ctx.contextualReturn);
				const arrayMembers	= contextual?.type === 'union' ? T.unionMembers(contextual, ctx.scope).map(m => T.resolve(ctx.scope, m)).filter(m => m.type === 'array') : [];
				const contextualArr = arrayMembers.length === 1 ? arrayMembers[0] : contextual;
				const contextualElement = contextualArr?.type === 'array' ? contextualArr.element : undefined;
				const contextForcesAny = !contextualElement || T.isAny(T.resolve(ctx.scope, contextualElement));
				// An empty literal has no elements for `arrayKindOf` to read and the checker types it `never[]`/`any[]` (always 'ref'): `want`'s kind, else the CONTEXTUAL
				// element type, which is what its non-empty sibling would infer (`[]` beside `[1,2]` in `number[][]` must be the same `f64` array, not boxed-`any`).
				const kind = wantArr === 'ref' || (typeof want === 'object' && 'ref' in want && want.ref === 'any' && contextForcesAny) ? 'ref'
					: e.elements.length === 0 ? (wantArr ?? (contextualElement && W.elementKind(typeOf(T.resolve(ctx.scope, contextualElement)))) ?? arrayKindOf(e, ctx))
					: arrayKindOf(e, ctx);
				if (!kind || kind === 'i16' || kind === 'i8')
					throw 'array literals are only supported for number[]/boolean[]/T[]';
				emitArrayElements(e.elements, ctx, kind === 'ref' ? W.REF_ANY_NULLABLE : kind, kind, types.array(kind), contextualElement);
				return W.ARRAY[kind];
			}

			case 'unary': {
				if (e.operator === '++' || e.operator === '--')
					return ctx.inScope((): W.Type => {
						const target = emitAssignTarget(e.operand, ctx, 'discard');
						const wtype = target.wtype;
						if (wtype !== 'i32' && wtype !== 'f64') {
							// A nullable primitive gets a specific, actionable message -- narrowing it (`if (x !== null)`) to a real non-null occurrence would need per-read
							// narrowing tracking, which codegen does for no type (see `coerceTop`'s soundness contract).
							if (W.unboxedPrimitive(wtype))
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
					});

				// `delete obj[k]`, like `++`/`--`, needs the target's own object+key rather than its evaluated value, so it gets its own branch before the generic
				// operand dispatch below. Only a dynamic object has a real `delete` to dispatch to.
				if (e.operator === 'delete') {
					if (e.operand.type !== 'index' && e.operand.type !== 'member')
						throw "'delete' is only supported on a property ('delete obj[k]' or 'delete obj.p')";
					const object	= e.operand.object;
					const cls		= classOfForIndexing(object, ctx);
					if (e.operand.type === 'index' && cls?.methodDecls.get('delete')) {
						emitAs(object, ctx, cls.thisWtype!);
						return emitMethodCall(cls, 'delete', [e.operand.index], ctx);
					}
					// A struct cannot lose a slot, and an absent optional field is already one holding `undefined` (an omitted literal
					// field), so deleting stores that. A required field has no such state: its non-null cast traps, as TS forbids it.
					// A union of structs boxed as one `anyref` counts; a value typed `any` may be a dynamic object, where that is no delete.
					if (!(cls && cls.typeIndex !== -1 && cls.fields.length) && !(physicallyAny(object, ctx) && !T.isAny(ctx.narrowedTypeOf(object))))
						throw "'delete' is only supported on a struct's field or a dynamic object's key";
					emitExpr(Assign<Expr, never>(e.operand, Identifier('undefined')), ctx, 'void');
					ctx.emit(I.i32.const(1));
					return 'i32';
				}

				const info = operandInfo(e.operand, ctx);
				if (info.owner) {
					const method = UNARY_OP_NAMES[e.operator as keyof typeof UNARY_OP_NAMES];
					if (method && info.owner.methodDecls?.get(method)) {
						emitAs(e.operand, ctx, info.owner.thisWtype!);
						return emitMethodCall(info.owner, method, [], ctx);
					}
				}

				// A bare `typeof x` as a VALUE: the tag itself when the checker's type gives every inhabitant the same one, else a run-time cascade over the tags its
				// type allows (`emitTypeofValue`).
				if (e.operator === 'typeof') {
					const known = T.typeofName(ctx.narrowedTypeOf(e.operand), ctx.scope);
					if (known !== undefined) {
						if (emitExpr(e.operand, ctx, 'void') !== 'void')
							ctx.emit(I.drop);
						return emitExpr(Literal(known), ctx, want);
					}
					return emitTypeofValue(e.operand, ctx);
				}

				// `!x` is exactly "is x falsy", so it answers for every operand shape `emitTruthy` understands -- a nullable object reference, a string (empty is
				// falsy), an array, a scalar -- not just the scalar-kinded ones. The old scalar-only path also coerced the operand to `i32` first, which TRUNCATED a real
				// `f64`: `!0.5` came out `true`.
				if (e.operator === '!') {
					emitTruthy(e.operand, ctx);
					ctx.emit(I.i32.eqz);
					return 'i32';
				}

				// `+s` is ToNumber, which for a string is exactly `Number(s)`: the lib wrapper's string constructor parses it (trimmed, '' is 0, trailing junk is NaN).
				if (e.operator === '+' && T.typeofName(ctx.narrowedTypeOf(e.operand), ctx.scope) === 'string')
					return emitExpr(JS.Call(Identifier('Number'), [e.operand]), ctx, want);
				const t = W.notUnsigned(W.scalarKind(info.wtype));
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
				if (e.operator === '++' || e.operator === '--')
					return ctx.inScope((): W.Type => {
						const target = emitAssignTarget(e.operand, ctx, 'keep');
						const wtype = target.wtype;
						if (wtype !== 'i32' && wtype !== 'f64') {
							// A nullable primitive gets a specific, actionable message -- narrowing it (`if (x !== null)`) to a real non-null occurrence would need per-read
							// narrowing tracking, which codegen does for no type (see `coerceTop`'s soundness contract).
							if (W.unboxedPrimitive(wtype))
								throw "'++'/'--' on a nullable primitive needs narrowing to non-null first, and isn't supported even then";
							throw "'++'/'--' is only supported on number/boolean-kind locals";
						}

						ctx.emit(I[wtype].const(1), I[wtype][e.operator === '++' ? 'add' : 'sub']);
						target.write(false);
						if (want === 'void')
							return want;
						ctx.emit(I.local.get(target.old!));
						return wtype;
					});
				throw `unsupported postfix operator '${e.operator}'`;

			case 'assign': {
				const { operator, target, value } = e;
				const rightInfo = operandInfo(value, ctx);

				// `**=` is a real assignment operator the parser accepts but is not in `ASSIGN_OPS`, and there is no wasm instruction or `numericOpInline` case for it,
				// so it becomes a plain assignment -- `Math.pow` is the real implementation (see the `**` rewrite further down). Only where the target re-emits without
				// side effects, an identifier or a property chain off one, since it appears on both sides.
				if (operator === '**') {
				const reemittable = (x: Expr): boolean => x.type === 'identifier' || x.type === 'this'
					|| (x.type === 'member' && !x.optional && reemittable(x.object));
				if (!reemittable(target))
					throw "'**=' is only supported on a plain name or property chain";
				return emitExpr(Assign<Expr, JS.assignableOps>(target, Binary('**', target, value)), ctx, want);
				}


				return ctx.inScope((): W.Type => {
					const slot		= emitAssignTarget(target, ctx, operator ? 'discard' : 'none');
					const wtype		= slot.wtype;

					// The target's own declared type is the value's contextual type -- the same channel `case 'var_decl'` seeds from an annotation, which a bare `new C` on
					// the value needs to find its own type arguments (`scope.resolveCache ??= new WeakMap`).
					const emitValue = () => {
						const saved = ctx.contextualReturn;
						ctx.contextualReturn = checkerTypeOf(target, ctx.scope);
						emitAs(value, ctx, wtype);
						ctx.contextualReturn = saved;
					};

					// Both arms unbraced: a braced `if` with a bare `switch` for its `else` is the one shape `custom-control-block-style` rejects.
					if (!operator)
						emitValue();
					else switch (operator) {
						case '&&':
						case '||': {
							// `a &&= b` assigns only when `a` is TRUTHY, `a ||= b` only when it is falsy, and in the other case `b` is not evaluated at all -- the same `if`-based
							// shape `??=` uses below, keyed off truthiness rather than nullishness.
							const isAnd	= operator === '&&';
							const cur	= ctx.declareLocal(`$logical$assign$${ctx.tempCounter++}`, wtype);
							ctx.emit(I.local.tee(cur.index));
							emitTruthyOf(wtype, ctx.narrowedTypeOf(target), ctx);
							// The truthy arm assigns for `&&=` and keeps the old value for `||=`, the falsy arm is the mirror, and `emitValue()` is reached only in the arm that
							// actually assigns -- which is what leaves the right-hand side unevaluated in the other one.
							const keep	= () => ctx.emit(I.local.get(cur.index));
							ctx.emitIf(toValType(wtype), isAnd ? emitValue : keep, isAnd ? keep : emitValue);
							break;
						}

						case '??': {
							// `a ??= b` short-circuits -- `b` is only evaluated when `a` is null/undefined, unlike every other compound-assignment op. Mirrors the plain `??` binary-op's
							// own `if`-based lowering, just feeding `target.write` instead of returning the value directly.
							if (typeof wtype === 'string' || !wtype.nullable)
								throw "'??=' needs a nullable object-typed target (no boxing in this subset)";
							const leftLocal = ctx.declareLocal(`$nullish$assign$${ctx.tempCounter++}`, wtype);
							ctx.emit(I.local.tee(leftLocal.index), I.ref.is_null);
							ctx.emitIf(toValType(wtype), emitValue, () => ctx.emit(I.local.get(leftLocal.index)));
							break;
						}

						default: {
							const method	= BINARY_OP_NAMES[operator as keyof typeof BINARY_OP_NAMES];
							const owner		= ownerOf(target, ctx);
							if (owner && owner.methodDecls?.get(method)) {
								emitMethodCall(owner, method, [value], ctx);

							} else {
								const inline = numericOpInline(method, wtype, rightInfo.wtype, ctx);
								coerceTop(wtype, ctx, inline.params[0]);
								emitAs(value, ctx, inline.params[1]);
								ctx.emit(...inline.inline);
								coerceTop(inline.result, ctx, wtype);
							}
						}
					}

					const tee = want !== 'void';
					slot.write(tee);
					return tee ? wtype : 'void';
				});
			}

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


				switch (operator) {
					// `a && b` and `a || b` yield an OPERAND, not a boolean: `0.5 && 7` is `7`, `0 || 7` is `7`. Lowering to a bare boolean agrees with real JS in a
					// condition, which is why it went unnoticed, but is simply the wrong value anywhere else; `emitTruthy` above keeps the cheap boolean form for conditions.
					case '&&':
					case '||': {
						const isAnd = operator === '&&';
						// As a STATEMENT (`a && f()`) only the short-circuit is observable, and neither operand needs a representable result then -- `f()` may well return `void`.
						if (want === 'void') {
							emitTruthy(left, ctx);
							if (!isAnd)
								ctx.emit(I.i32.eqz);
							ctx.emitIf(undefined, () => {
								if (ctx.inNarrowed(right, left, isAnd, () => emitExpr(right, ctx, 'void')) !== 'void')
									ctx.emit(I.drop);
							});
							return 'void';
						}
						const leftWtype		= wtypeOf(left, ctx);
						const rightWtype	= wtypeOf(right, ctx);
						if (!leftWtype || leftWtype === 'void' || rightWtype === 'void')
							throw `'${operator}' needs both operands to have a representable value type`;
						// Same rule `typeOf`'s own union case uses -- one shared physical form when both sides already agree, else the checker's own type for the whole expression
						// (a real union, so boxed). Not taken from the checker outright, so it stays correct where its type for `&&` is narrower than the two operands together.
						// A right operand with no representation of its own (a bare `undefined`/`null`) is emitted into the whole expression's type, as a conditional's branch is:
						// `every(...) || undefined` is a nullable boolean.
						const self = rightWtype && W.typeEq(leftWtype, rightWtype) ? leftWtype : (wtypeOf(e, ctx) ?? W.REF_ANY);
						// An object-shaped result is BUILT at the caller's type: struct fields are mutable, hence invariant, so a literal operand that inferred its own shape can
						// never be converted afterwards.
						const wtype = wantedShape(want, self);
						const leftLocal = ctx.declareLocal(`$logic$left$${ctx.tempCounter++}`, leftWtype);
						emitAs(left, ctx, leftWtype);
						ctx.emit(I.local.tee(leftLocal.index));
						emitTruthyOf(leftWtype, ctx.narrowedTypeOf(left), ctx);
						const keepLeft = () => {
							// Only the left's falsy (`&&`)/truthy (`||`) part is ever kept, and when that is just null/undefined (an object is never falsy) the result is the result
							// type's own undefined, not the left's physical value.
							if (T.isNullish(T.logicalLeftPart(ctx.narrowedTypeOf(left), operator, ctx.scope), ctx.scope)) {
								emitAs(Identifier('undefined'), ctx, wtype);
								return;
							}
							ctx.emit(I.local.get(leftLocal.index));
							coerceTop(leftWtype, ctx, wtype);
						};
						const emitRight = () => ctx.inNarrowed(right, left, isAnd, () => emitAs(right, ctx, wtype));
						ctx.emitIf(toValType(wtype), isAnd ? emitRight : keepLeft, isAnd ? keepLeft : emitRight);
						return wtype;
					}
					// `a ?? b` -- a left that can never actually be null/undefined makes `b` provably dead code (as real TS's checker concludes), so it is evaluated and
					// returned directly with no runtime check; `emitPatternBinding` relies on exactly this for a destructuring default on an already-non-nullable value.
					case '??': {
						const self = wtypeOf(e, ctx);
						if (!self)
							throw "'??' has an unsupported result type";
						const wtype = wantedShape(want, self);
						const leftWtype = wtypeOf(left, ctx);
						if (!leftWtype)
							throw "'??' has an unsupported left-hand type";
						if (typeof leftWtype === 'string' || !leftWtype.nullable) {
							emitAs(left, ctx, wtype);
							return wtype;
						}
						emitAs(left, ctx, leftWtype);
						const leftLocal = ctx.declareLocal(`$nullish$left$${ctx.tempCounter++}`, leftWtype);
						ctx.emit(I.local.tee(leftLocal.index), I.ref.is_null);
						ctx.emitIf(toValType(wtype), () => emitAs(right, ctx, wtype), () => {
							ctx.emit(I.local.get(leftLocal.index));
							coerceTop(leftWtype, ctx, wtype);
						});
						return wtype;
					}

					// `x instanceof C`: `C` must be a plain class name -- exactly the constraint the checker's own narrowing already imposes (`checker.ts`'s
					// `test.operator === 'instanceof'` case), so a program that narrows on this expression at all already satisfies it here. Lowers straight to `ref.test`
					// against `C`'s own struct type, non-nullable form -- `null instanceof C` is `false` in real JS, which `(ref $C)` already gives for free. Reliable even
					// between structurally-identical sibling classes: every struct/array type shares one rec group (see the group-building comment near the bottom of this
					// file), which is what lets `ref.test` distinguish them -- the same guarantee `ensureVirtualDispatch`'s own `ref.test` cascade relies on.
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

					// `k in obj` -- only over a dynamic object (structural `{[k: string]: V}`, routed to `Map<string, V>`), the one case this compiler can give real
					// membership-test semantics to. Same shape as `instanceof` just above: resolve the class, dispatch to its own conventionally-named method (`has`).
					case 'in': {
						// `'k' in u` on a UNION is a TYPE test, not a property lookup -- how TypeScript narrows a union whose members aren't discriminated by a literal field --
						// and since each member is its own nominal struct, the answer is simply which member `u` is: decided statically when every member agrees, else a
						// `ref.test` over the members declaring it. A member declaring it OPTIONALLY counts as declaring it: this compiler has no notion of property presence --
						// an optional field is physically there and null when unset -- and that is what TS's own `in` narrowing means by it ("this member is possible").
						// The cost is that `in` cannot distinguish an omitted optional property from a set one; a null test would be a different wrong answer, rejecting a property
						// explicitly set to `undefined`, which JS says IS present.
						const key = left.type === 'literal' && typeof left.value === 'string' ? left.value : undefined;
						// `T.unionMembers`, not a `.types` walk: `resolve` leaves a union's own members alone, so `typeof LIB_DECLS[number] | undefined` hides a further nested
						// union behind one of them -- see that helper's own comment.
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
								const recv = ctx.declareLocal(`$in$${ctx.tempCounter++}`, W.REF_ANY_NULLABLE);
								emitAs(right, ctx, W.REF_ANY_NULLABLE);
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
							// The runtime struct decides: a value typed as a BASE (`TS.Class`) may be a subtype that declares the key (`ClassDecl`), and a dynamic receiver has no
							// static shape at all -- `ensureAnyIn`'s `ref.test` over every shape declaring it answers both, while a scalar or array receiver still gets the error
							// rather than a silent `false`.
							const recvWtype = key === undefined ? undefined : wtypeOf(right, ctx);
							if (key !== undefined && recvWtype && typeof recvWtype === 'object' && 'ref' in recvWtype) {
								emitAs(right, ctx, W.REF_ANY_NULLABLE);
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
						const leftIsNull	= T.isNullLiteral(left);
						const rightIsNull	= T.isNullLiteral(right);
						if (leftIsNull || rightIsNull) {
							if (leftIsNull && rightIsNull) {
								ctx.emit(I.i32.const(negate ? 0 : 1));	// `null === null`/`null === undefined` -- always true, no value to check.
								return 'i32';
							}
							const valueExpr	= leftIsNull ? right : left;
							const wt		= wtypeOf(valueExpr, ctx);
							if (!wt || typeof wt === 'string' || !wt.nullable)
								throw "comparing to 'null'/'undefined' needs a nullable object-typed value on the other side";
							// `null` and `undefined` are the same physical value (`ref.null`), so `ref.is_null` answers both alike -- correct for `==`, but `null === undefined` is
							// FALSE. A strict comparison can only separate them statically: when the value's type carries the OTHER nullish kind and not this one, the answer is
							// constant, whatever it holds at runtime.
							//
							// Deliberately not extended to a type carrying NEITHER -- that still throws above, and must, because this compiler hands back a physical `undefined` in
							// places whose declared type says it cannot (a missing key on `{[k: string]: V}`); a constant there would turn a loud error into a silent wrong one.
							if (operator.length === 3) {
								const kind	= T.nullLiteralKind(leftIsNull ? left : right)!;
								const t		= T.resolve(ctx.typeScope, ctx.narrowedTypeOf(valueExpr));
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

						// With a boxed `any` or a nullable ref on either side, what `===` means is only known at runtime -- and a method dispatch (`String.eq`) would trap on a
						// null receiver: `x?.type === 'a'`.
						const isRuntimeEq = (w: W.Type | undefined) => !!w && typeof w !== 'string' && (('ref' in w && w.ref === 'any') || !!w.nullable);
						if ((method === 'eq' || method === 'ne') && (isRuntimeEq(leftInfo.wtype) || isRuntimeEq(rightInfo.wtype))) {
							emitAs(left, ctx, W.REF_ANY_NULLABLE);
							emitAs(right, ctx, W.REF_ANY_NULLABLE);
							ctx.emit(I.call(ensureAnyStrictEq().funcIndex));
							if (method === 'ne')
								ctx.emit(I.i32.eqz);
							return 'i32';
						}

						// JS `+` is string CONCATENATION as soon as either operand is a string, whatever the other one is -- compiled as the equivalent template literal so it
						// goes through exactly the `stringTemplate`/`.toString()` path `${x}` already does, rather than a second stringifier that could disagree with it. Only
						// when the two sides DISAGREE (`string + string` keeps `String.add`, `number + number` its numeric op). `definitelyString` is deliberately
						// all-members-of-a-union: a `string | number` operand is decided at runtime, which this cannot model.
						// `**` has no wasm instruction and no `numericOpInline` case, so it failed for every numeric operand as "unsupported compound-assignment method 'pow'".
						// `Math.pow` (`lib/number.ts`) is the real implementation, so rewriting to it here reuses that rather than adding a second one. A BIGINT operand still
						// dispatches to `BigInt.pow` above via `leftInfo.owner`, so this is only reached for a genuinely numeric `**`.
						if (method === 'pow')
							return emitExpr(JS.Call(JS.Member(Identifier('Math'), 'pow'), [left, right]), ctx, want);

						if (method === 'add') {
							const definitelyString = (x: Expr) => {
								const t = T.resolve(ctx.typeScope, ctx.narrowedTypeOf(x));
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
								const w = W.notUnsigned(W.scalarKind(emitMethodCall(leftInfo.owner, 'compare', [right], ctx)));
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
							if (leftInfo.wtype && !W.scalarKind(leftInfo.wtype) && !W.scalarKind(rightInfo.wtype)) {
								emitAs(left, ctx, leftInfo.wtype);
								emitAs(right, ctx, leftInfo.wtype);
								ctx.emit(I.ref.eq);
								if (method === 'ne')
									ctx.emit(I.i32.eqz);
								return 'i32';
							}
						}

						const inline	= numericOpInline(method, leftInfo.wtype, rightInfo.wtype, ctx);
						// Only a FLOAT-kinded operand needs the real `ToInt32` sequence; one that is already `i32`/`u32` is exactly its own low 32 bits.
						const asInt32	= (x: Expr, w: W.Type | undefined, want: W.Type) =>
							BITWISE_METHODS.has(method) && want === 'i32' && (W.scalarKind(w) === 'f64' || W.scalarKind(w) === 'f32')
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
				// `want`, when the caller has one, not just this expression's own self-inferred type -- self-inference can legitimately pick a *narrower* physical
				// representation than the context needs (a small integer literal branch of a `number | null` conditional self-infers as an `i32` box, not the `f64` box
				// the declared type uses), and both branches need to agree with whatever the caller will consume.
				const wtype = want ?? wtypeOf(e, ctx);
				if (!wtype)
					throw 'conditional expression has an unsupported type';
				emitTruthy(e.test, ctx);
				ctx.emitIf(toValType(wtype),
					() => ctx.inNarrowed(e.consequent, e.test, true, () => emitAs(e.consequent, ctx, wtype)),
					() => ctx.inNarrowed(e.alternate, e.test, false, () => emitAs(e.alternate, ctx, wtype)));
				return wtype;
			}

			case 'new': {
				// `new ArrayBuffer(n)`/`Uint8Array`/etc: real views over a GC byte buffer, resolved through the generic `ensureClass`/`ensureCtor` dispatch below like any
				// other class -- including the array-literal form (`new Uint8Array([1, 2, 3])`), an ordinary call against the `constructor(elements: number[])` overload
				// (`lib/typedarray.ts`), same as a real `number[]` variable would be.
				// `ctx.scope` (not `global`): a non-entry function's own compiled body now roots its scope at its OWN declaring module (see `compileFunc`'s `homeScope`),
				// so a class declared in the SAME file as the function being compiled resolves here even when the entry module itself never imports that class by name.
				// `classRefTarget` additionally covers `new T.Scope(...)` and a local alias to either; a plain identifier naming a lib class (`Set`, `Map` -- no
				// `Scope.decl` of its own) falls through to the unqualified lookup it always used.
				const target = classRefTarget(e.callee, ctx.scope)
					?? (e.callee.type === 'identifier' ? { name: e.callee.name, scope: ctx.scope } : undefined);
				if (!target)
					throw `'new' is only supported for a known class`;
				const cls = ensureClass(target.name, newTypeArgs(target.name, e.typeArgs, e, ctx, want), target.scope);
				if (!cls)
					throw `'new' is only supported for a known class`;
				const ctor = ensureCtor(cls, e.arguments, ctx);
				emitCallArgs(`${target.name}'s constructor`, ctor.params, ctor.defaults, !!ctor.hasRest, e.arguments, ctx, ctor.resolvedParams);
				ctx.emit(I.call(ctor.funcIndex));
				return cls.thisWtype!;
			}

			// `` tag`Hello ${name}` `` -- synthesized as `tag(strings, ...values)` and re-entered via `emitExpr`, so it reuses the
			// ordinary `case 'call'` path below and coercion comes free from `emitCallArgs`.
			// `.raw` isn't modeled: the strings are a plain cooked-text `string[]` (`case 'literal'`'s own untagged handling),
			// so a tag typed against `TemplateStringsArray` isn't supported -- typing the parameter `string[]` works.
			case 'tagged_template': {
				// `e.quasi` has no trailing empty-string part when the template ends right after a `${...}` (no text after) -- the
				// same gap `case 'literal'`'s own untagged handling pads for (`hasTrailingLiteral`), so `strings.length` is interpolation count + 1.
				const strings = e.quasi.map(p => Literal(p.str));
				if (e.quasi[e.quasi.length - 1].exp)
					strings.push(Literal(''));
				return emitExpr(JS.Call(
					e.tag,
					[JS.ArrayLit(strings), ...e.quasi.filter(p => p.exp).map(p => p.exp!)],
				) as Expr, ctx, want);
			}

			case 'call': {
				// A bare `__asm<[Params],Result>('...')(args...)` call anywhere an expression is allowed, not just a class member's
				// sole body statement (`scanInlineMethods`): `$this`/element-kind resolve from `ctx.owner` live here rather than
				// pre-computed, so this works in a top-level function body too.
				if (e.callee.type === 'call' && isAsm(e.callee)) {
					if (e.arguments.some(a => a.type === 'spread'))
						throw 'inline asm does not support spread call arguments';
					const owner = ctx.owner;
					try {
						const builtin = makeAsm(e.callee, { typeOf }, owner?.typeIndex ? {this: owner?.typeIndex} : {});
						return emitInline('<inline>', builtin(e.arguments.map(a => operandInfo(a, ctx)), ctx), e.arguments, ctx);
					} catch (e) {
						throw `inline asm failed to resolve ${e}`;
					}
				}

				if (e.callee.type === 'identifier') {
					// A recursive call to the nested `function_decl` currently being compiled, from inside its own body -- resolved to a
					// direct, statically-known `call` (reusing the same env), not a `call_ref` through a closure struct (see `FuncCtx.selfCall`'s own comment for why).
					if (ctx.selfCall && ctx.name === e.callee.name) {
						const { funcIndex, params, result, hasRest } = ctx.selfCall;
						ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index));
						emitCallArgs(e.callee.name, params, undefined, !!hasRest, e.arguments, ctx);
						ctx.emit(I.call(funcIndex));
						return result;
					}
					// A closure value called directly (`callback(x)`) -- checked via `ctx.resolvesName` so a local shadowing a
					// same-named global function takes priority, matching JS scoping; bare identifier callee only (not `obj.field(x)`).
					if (ctx.resolvesName(e.callee.name)) {
						const calleeWtype = ctx.resolvedWtype(e.callee.name);
						if (calleeWtype && typeof calleeWtype !== 'string' && 'closure' in calleeWtype) {
							const sig = closureSigOf(calleeWtype);
							const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
							// `f?.()` on a NULLABLE closure: the whole call short-circuits to `undefined`,
							// so it needs the same guard `a?.[i]`/`a?.m()` already use. Without it the call
							// went straight through and trapped on a null code pointer.
							if (e.optional && calleeWtype.nullable) {
								if (sig.result === 'void')
									throw "'f?.()' is not supported -- 'f' returns 'void', which can't become 'void | undefined'";
								const resultWtype	= types.nullable(sig.result);
								// Bound out here: the enclosing `e.callee.type === 'identifier'` narrowing
								// doesn't survive into the closure below.
								const calleeName	= e.callee.name;
								emitExpr(e.callee, ctx);
								return ctx.emitOptionalAccess(calleeWtype, resultWtype, toValType, objLocal => {
									ctx.emit(I.local.get(objLocal), I.struct.get(structTypeIndex, 1));
									emitCallArgs(calleeName, sig.params, sig.defaults, !!sig.hasRest, e.arguments, ctx, sig.resolvedParams);
									ctx.emit(I.local.get(objLocal), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
									coerceTop(sig.result, ctx, resultWtype);
								});
							}
							emitExpr(e.callee, ctx);
							const scratch = ctx.declareLocal(`$closure$${ctx.tempCounter++}`, calleeWtype);
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
						// A union member NARROWED to a function (`typeof r === 'function' ? r(x) : r`).
						// The binding's own physical type is the boxed union, so the closure struct has to
						// be cast back out of it before the same `call_ref` dance as above.
						const narrowedWtype = typeOf(ctx.narrowedTypeOf(e.callee));
						if (narrowedWtype && typeof narrowedWtype !== 'string' && 'closure' in narrowedWtype) {
							const sig = closureSigOf(narrowedWtype);
							const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
							emitExpr(e.callee, ctx);
							const scratch = ctx.declareLocal(`$closure$${ctx.tempCounter++}`, narrowedWtype);
							ctx.emit(I.ref.cast(structTypeIndex), I.local.tee(scratch.index), I.struct.get(structTypeIndex, 1));
							emitCallArgs(e.callee.name, sig.params, sig.defaults, !!sig.hasRest, e.arguments, ctx, sig.resolvedParams);
							ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
							return sig.result;
						}
					}
					// A module-level `const X = someFactory(...)` holding a closure (`Rule = makeRule(...)`): found by the
					// same lookup a plain READ of it uses -- entry, imported and lib modules alike -- then called as a closure.
					{
						const lazy = lazyGlobalFor(e.callee.name, ctx);
						const calleeWtype = lazy?.wrapper.result;
						if (lazy && calleeWtype && typeof calleeWtype !== 'string' && 'closure' in calleeWtype) {
							const sig = closureSigOf(calleeWtype);
							const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
							ctx.emit(I.call(lazy.wrapper.funcIndex));
							const scratch = ctx.declareLocal(`$closure$${ctx.tempCounter++}`, calleeWtype);
							ctx.emit(I.local.tee(scratch.index), I.struct.get(structTypeIndex, 1));
							emitCallArgs(e.callee.name, sig.params, sig.defaults, !!sig.hasRest, e.arguments, ctx, sig.resolvedParams);
							ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
							return sig.result;
						}
					}
					// One-shot: consumed here (for this call's own generic type-param inference, if it applies)
					// and cleared immediately, so it can't leak into this same call's own arguments below (see
					// `contextualReturn`'s own comment on why that would be wrong).
					if (!isModuleValue(e.callee.name, ctx)) {
						const contextualReturn = ctx.contextualReturn;
						ctx.contextualReturn = undefined;
						return emitCall(e.callee.name, e.arguments, ctx, e.typeArgs, contextualReturn ?? (() => checkerTypeOf(e, ctx.scope)));
					}
				}

				// `obj?.method(...)` -- the `?.` sits on the `member` callee (a chain further out continues one, e.g.
				// `obj?.a.method(...)`; `isOptionalChainLink`, not a bare `e.callee.optional`, see `case 'member'`'s own comment):
				// one guarded operation, `obj` evaluated once and the call only in the non-null arm, restricted to a real user
				// method (`ensureMethod`), never a `Math`/prelude intrinsic whose result type depends on the call site.
				if (e.callee.type === 'member' && !ctx.isNamespaceValue(e.callee)) {
					if (isOptionalChainLink(e.callee)) {
						const objExpr		= e.callee.object;
						const methodName	= e.callee.property;
						const physWtype		= wtypeOf(objExpr, ctx);
						if (!physWtype || typeof physWtype === 'string')
							throw `'a?.${methodName}(...)' needs an object-typed value on its left`;
						const owner = ownerOf(objExpr, ctx);
						if (!owner) {
							// A receiver typed `any` still has its method at run time: the ordinary dispatch (`ensureAnyDispatch`), inside
							// the null guard, so a nullish receiver skips the arguments too (walker.ts `stmt.finalizer?.some(...)`).
							if (T.isAny(ctx.narrowedTypeOf(objExpr)) && !e.arguments.some(a => a.type === 'spread')) {
								const w = wtypeOf(e, ctx);
								const resultWtype = w && w !== 'void' ? types.nullable(w) : W.REF_ANY_NULLABLE;
								emitAs(objExpr, ctx, W.REF_ANY_NULLABLE);
								return ctx.emitOptionalAccess(W.REF_ANY_NULLABLE, resultWtype, toValType, objLocal => {
									ctx.emit(I.local.get(objLocal), I.ref.as_non_null);
									ctx.emit(I.call(ensureAnyDispatch(methodName, e.arguments.map(a => emitExpr(a, ctx)), e.arguments.map(a => ctx.narrowedTypeOf(a)), resultWtype, ctx).funcIndex));
								});
							}
							throw `unknown method '${methodName}' (its receiver's type: '${T.typeKey(ctx.narrowedTypeOf(objExpr)).slice(0, 160)}')`;
						}
						const objWtype = owner.thisWtype && typeof owner.thisWtype !== 'string' ? types.nullable(owner.thisWtype) : physWtype;
						const typeArgs = e.typeArgs;
						const method = ensureMethod(owner, methodName, e.arguments, ctx, typeArgs);
						if (!method)
							throw `'a?.${methodName}(...)' is not supported -- only a plain user-defined method (not a 'Math'/prelude intrinsic) can be guarded by '?.' in this pass`;
						// As a statement the value is discarded, so a `void` method needs no `void | undefined`: just the guarded call.
						if (want === 'void') {
							emitAs(objExpr, ctx, objWtype);
							const objLocal = ctx.declareLocal(`$optcall$${ctx.tempCounter++}`, objWtype);
							ctx.emit(I.local.tee(objLocal.index), I.ref.is_null, I.i32.eqz);
							ctx.emitIf(undefined, () => {
								ctx.emit(I.local.get(objLocal.index), I.ref.as_non_null);
								if (emitMethodCall(owner, methodName, e.arguments, ctx, typeArgs) !== 'void')
									ctx.emit(I.drop);
							});
							return 'void';
						}
						if (method.result === 'void')
							throw `'a?.${methodName}(...)' is not supported -- '${methodName}' returns 'void', which can't become 'void | undefined'`;
						emitAs(objExpr, ctx, objWtype);
						const resultWtype = types.nullable(method.result);
						return ctx.emitOptionalAccess(objWtype, resultWtype, toValType, objLocal => {
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
						// `Object.entries` -- a known global intrinsic (see `emitObjectEntries`'s own comment for why it can't just be
						// `namespaceOwner`/`ensureClass`-dispatched like an ordinary static method), checked before the generic paths below.
						const intrinsic = objectIntrinsic(e);
						if (intrinsic === 'defineProperty')
							return emitObjectDefineProperty(e.arguments, ctx);
						// SameValue, decided at run time by typed lib code: an operand is often a boxed union value.
						if (intrinsic === 'is')
							return emitCall('__towasm_same_value', e.arguments, ctx);
						if (intrinsic)
							return emitObjectEntries(e.arguments, ctx, intrinsic as 'entries' | 'keys' | 'values');
						// A namespace-import-qualified call (`NS.foo(...)`, `import * as NS from '...'`) into
						// another module -- checked before `namespaceOwner`, which only knows about real classes/
						// lib namespaces (`Math`, `Array`), never an actual cross-file import; only takes this
						// path when the target module really does declare `foo` as a plain function, so an
						// unsupported cross-module reference (a class, a scalar global, a host-module member like
						// `path.join`) still falls through to the ordinary paths below and their own clear errors.
						// `functionDeclByName` directly, not `resolveDecl` -- a namespace-qualified reference must only ever match what the
						// *target module itself* declares, never spuriously fall back to an unrelated same-named `LIB_DECL_MAP` global.
						const nsDecl	= ctx.scope.namespace(obj.name)?.decl(e.callee.property);
						const nsTarget	= nsDecl && stmtHomeModule.get(nsDecl);
						if (nsTarget !== undefined && functionDeclByName.has(homeKey(nsTarget, e.callee.property)))
							return emitCall(e.callee.property, e.arguments, ctx, typeArgs, undefined, nsTarget);
						const owner = namespaceOwner(obj.name, ctx);
						if (owner)
							return emitMethodCall(owner, e.callee.property, e.arguments, ctx, typeArgs);
						const name = `${obj.name}.${e.callee.property}`;
						if (builtins.has(name))
							return emitCall(name, e.arguments, ctx);
					}
					const owner = ownerOf(obj, ctx);
					if (!owner) {
						// No single static owner -- a genuinely `any` receiver still resolves through a real runtime dispatch, as in JS.
						// Checked via the checker's own type, not `wtypeOf` (which gives `undefined`, not `REF_ANY`, for an `any`-typed
						// expression). `want ?? REF_ANY`: a bare expression-statement passes no `want`; `coerceTop` widens to `REF_ANY`.
						if (T.isAny(ctx.narrowedTypeOf(obj)) && !e.arguments.some(a => a.type === 'spread')) {
							emitAs(obj, ctx, W.REF_ANY);
							const info = ensureAnyDispatch(e.callee.property, e.arguments.map(a => emitExpr(a, ctx)), e.arguments.map(a => ctx.narrowedTypeOf(a)), want ?? W.REF_ANY, ctx);
							ctx.emit(I.call(info.funcIndex));
							return info.result;
						}
						// A real union receiver -- the sibling of `case 'member'`'s own union FIELD dispatch, same `ref.test` cascade but
						// calling each member's method. Emitted inline rather than as a shared dispatcher (`ensureUnionFieldDispatch`)
						// because the arguments are ordinary expressions right here: re-emitting them per arm duplicates code but not
						// evaluation, since exactly one arm ever runs. The receiver goes through a local so it is evaluated once.
						const methodName = e.callee.property;
						const unionOwners = unionMethodOwners(obj, methodName, e.arguments, ctx);
						if (unionOwners) {
							const args = e.arguments;
							const result = wtypeOf(e, ctx) ?? want ?? W.REF_ANY;
							const recv = ctx.declareLocal(`$udisp$${ctx.tempCounter++}`, W.REF_ANY_NULLABLE);
							emitAs(obj, ctx, W.REF_ANY_NULLABLE);
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
						throw `unknown method '${e.callee.property}' (its receiver's type: '${T.typeKey(ctx.narrowedTypeOf(obj)).slice(0, 160)}')`;
					}
					// A method that reassigns `this` (`reassignsThis`/`assignsToThis`) needs its receiver's real physical lvalue --
					// `emitAssignTarget('keep')` pushes that value and sets up the write-back (same machinery compound
					// assignment/`++`/`--` use); `target.write` then consumes the callee's extra updated-`this` result, leaving the
					// declared result underneath. A receiver with nothing to write back to gets `emitAssignTarget`'s own error, for free.
					const property	= e.callee.property;
					const args		= e.arguments;
					if (ensureMethod(owner, property, args, ctx, typeArgs)?.reassignsThis) {
						return ctx.inScope((): W.Type => {
							const target = emitAssignTarget(obj, ctx, 'keep');
							// The lvalue read may be a boxed `anyref` (every ref-kind array element is stored generically), so the pushed
							// receiver needs the same narrowing cast the non-reassigning path below gets from its own `emitAs`.
							coerceTop(target.wtype, ctx, (owner as ClassInfo).thisWtype!);
							const result = emitMethodCall(owner, property, args, ctx, typeArgs);
							target.write(false);
							return result;
						});
					}
					// `emitAs`, not a raw `emitExpr` -- `obj` may be a ref-kind array element read, boxed `anyref` -- the call needs the real narrowed receiver type first, same as `case 'member'`'s getter/field reads.
					emitAs(obj, ctx, (owner as ClassInfo).thisWtype!);
					return emitMethodCall(owner, e.callee.property, e.arguments, ctx, typeArgs);
				}

				// A closure value called directly, where the callee has no name to resolve by -- an array element (`arr[i](x)`), the result of another call (`mk(1)(2)`), a
				// parenthesised expression. Same shape as the bare-identifier case above, generalized via the callee's own static type (`wtypeOf`); tried for ANY remaining
				// callee shape, since callable is exactly "wasm type is a closure", asked directly below -- no syntactic guard could add anything.
				{
					const calleeWtype = wtypeOf(e.callee, ctx);
					if (calleeWtype && typeof calleeWtype !== 'string' && 'closure' in calleeWtype) {
						const sig = closureSigOf(calleeWtype);
						const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);
						// `emitAs`, not a raw `emitExpr`: an array element read is a boxed `anyref` (every ref-kind element is stored generically), so the call needs the
						// real narrowed closure type first, same as `case 'call'`'s member-callee receiver above.
						emitAs(e.callee, ctx, calleeWtype);
						const scratch = ctx.declareLocal(`$closure$${ctx.tempCounter++}`, calleeWtype);
						ctx.emit(I.local.tee(scratch.index), I.struct.get(structTypeIndex, 1));
						emitCallArgs('<indexed closure>', sig.params, sig.defaults, !!sig.hasRest, e.arguments, ctx, sig.resolvedParams);
						ctx.emit(I.local.get(scratch.index), I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
						return sig.result;
					}
				}

				// A callee typed `any` (core.ts `params[0](() => rules)`): dispatched over the program's closure types.
				if (T.isAny(ctx.narrowedTypeOf(e.callee)) && !e.arguments.some(a => a.type === 'spread')) {
					emitAs(e.callee, ctx, W.REF_ANY);
					const info = ensureAnyCallDispatch(e.arguments.map(a => emitExpr(a, ctx)), want ?? W.REF_ANY);
					ctx.emit(I.call(info.funcIndex));
					return info.result;
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
			throw new W.Error(err as any, e).inModule(ctx.homeModule);
		}
	}

	// ===================================================================
	//  Statement lowering
	// ===================================================================

	// The ordinary `return` -- a plain function/method/arrow with no generator/async/constructor/`reassignsThis` override of `ctx.onReturn`; shared rather than a
	// `FunctionContext` field because the class, defined before this closure, can't reach `emitAs` -- see `ReturnHandler`'s own comment for who overrides this and why.
	// `result` has two equivalent "no value" spellings -- the `WasmType` string `'void'` (a real `: void` function's own `result`) and a bare omitted argument
	// (a caller with no meaningful `WasmType` at all, e.g. a resumable step function) -- normalized to `undefined` here once, rather than every caller agreeing.
	// `context` is the returned value's TS target, so a literal or generic call there builds what the caller reads.
	function plainReturn(result?: W.Type, context?: Type): ReturnHandler {
		if (result === 'void')
			result = undefined;
		return {
			wtype: () => result,
			emit(ctx, argument) {
				if (result === undefined) {
					// A concise arrow body compiles as `return <expr>`, and a `void` slot accepts a body that really produces a value -- TS's return-type bivariance
					// (`forEach(x => out.push(x))`), where JS discards it exactly as an expression statement does; a genuinely `: void`-annotated function returning
					// a value is the CHECKER's error, raised before codegen.
					if (argument && emitExpr(argument, ctx, 'void') !== 'void')
						ctx.emit(I.drop);
				} else if (argument) {
					// A `void` expression returned where a value is declared: real JS gives `undefined`, so it runs for its effects and the declared result's placeholder is pushed;
					// reached when a `() => void` closure is adapted to an `any`-returning signature -- `Array<T>`'s single physical bucket for every non-scalar element
					// makes the element type `any`, so `q.push(() => sideEffect())` compiles at `result = any`. Decided from the argument's own CHECKER type, so everything
					// else keeps going through `emitAs` (whose null-literal handling emitting directly would skip). Not `wtypeOf`: `typeOf` registers anonymous object
					// shapes as a side effect, perturbing `matchObjectShape`'s candidate set for an unrelated `makeRule(() => ({...}))` elsewhere.
					const argT = checkerTypeOf(unwrapAs(argument), ctx.scope);
					if (argT.type === 'ref' && argT.name === 'void') {
						emitExpr(argument, ctx, 'void');
						ctx.emitDefaultValue(result, types, toValType);
					} else {
						ctx.withContext(context, () => emitAs(argument, ctx, result));
					}
				}
				ctx.emit(I.return);
			},
		};
	}

	// `let x: T;` -- definite assignment guarantees a write before any read, so the starting value is never observed.
	// A non-nullable ref has no default at all, so it starts as an empty holder, exactly as a forward reference does.
	function emitUninitialized(name: string, tsType: Type, ctx: FunctionContext) {
		const wtype = typeOf(tsType);
		if (!wtype || wtype === 'void')
			throw `local '${name}' has an unsupported type`;
		const defaultable = typeof wtype === 'string' || wtype.nullable || ('ref' in wtype && wtype.ref === 'any');
		const hoisted = ctx.closureEnv?.fields.get(name);
		if (hoisted) {
			if (defaultable) {
				ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index));
				ctx.emitDefaultValue(wtype, types, toValType);
				ctx.emit(I.struct.set(ctx.closureEnv!.envTypeIndex, hoisted.index));
			}
		} else if (ctx.lookup(name)?.holderInner) {
			// an earlier sibling closure's forward reference already made the (empty) holder
		} else if (!defaultable || needsHolder(ctx, name)) {
			declareHolder(ctx, name, wtype, tsType);
		} else {
			ctx.emitDefaultValue(wtype, types, toValType);
			ctx.emit(I.local.set(ctx.declareValue(name, wtype, tsType).index));
		}
	}

	// A nested `function` declaration is hoisted: callable before its own line. It is created just before the first
	// statement in its list that mentions it -- closure creation has no side effects, and forward holders cover later siblings.
	function emitStmts(stmts: readonly Stmt[], ctx: FunctionContext) {
		const pending = new Map(stmts.flatMap(s => s.type === 'function_decl' && s.body ? [[s.name, s] as const] : []));
		const freeNames = (s: Stmt) => {
			const free = new Set<string>();
			collectFreeVars(new Set(), [s], free);
			return free;
		};
		const materialize = (fn: Extract<Stmt, { type: 'function_decl' }>) => {
			pending.delete(fn.name);
			const free = freeNames(fn);
			for (const other of [...pending.values()])
				if (pending.has(other.name) && free.has(other.name))
					materialize(other);
			emitStmt(fn, ctx);
		};
		for (const st of stmts) {
			if (pending.size) {
				const free = freeNames(st);
				for (const fn of [...pending.values()])
					if (fn !== st && pending.has(fn.name) && free.has(fn.name))
						materialize(fn);
			}
			if (st.type === 'function_decl' && st.body) {
				if (pending.has(st.name))
					materialize(st);
				continue;
			}
			emitStmt(st, ctx);
		}
	}

	function emitStmt(s: Stmt, ctx: FunctionContext): void {
		ctx.stmtScope = (s as any).scope as Scope ?? ctx.stmtScope;
		switch (s.type) {
			case 'empty':
				return;

			case 'block':
				ctx.inScope(() => emitStmts(s.body, ctx));
				return;

			case 'var_decl':
				for (const d of s.declarations) {
					if (!d.init) {
						if (typeof d.name !== 'string')
							throw `local '${describeBinding(d.name)}' needs an initializer`;
						emitUninitialized(d.name, d.typeAnnotation ?? ctx.widenedTypes?.get(d) ?? T.ANY, ctx);
						continue;
					}
					if (typeof d.name !== 'string') {
						// Desugars into plain `var_decl`s reading their own piece off a hidden scratch local (`#destructure$<n>`), emitted directly rather than
						// wrapped in a `block`: these bindings share the original `var_decl`'s scope, not a nested one.
						emitPatternBinding(s.kind, d.name, d.init, d.typeAnnotation, ctx);
						continue;
					}
					// Type computed before emitting the init, so the init can be emitted via `emitAs` straight into the local's declared representation.
					// `checker.scopeOfStmt(s)` -- the real, narrowing-aware scope the checker type-checked this statement under -- not `ctx.scope` (towasm's own,
					// separately-tracked scope, which never reflects flow-sensitive narrowing the way the checker's internal scope tree does). Without it, a
					// narrowed-non-null receiver (e.g. `if (m === null) return; ...; m.group(0)`) would still look nullable to `checkerTypeOf` here and member/call
					// resolution could fail on it. Unset for a real minority of statements -- see the two reasons spelled out at the `narrowedTypeOf` fallback below.
					const stamped	= (s as any).scope as Scope | undefined;
					const stmtScope = stamped ?? ctx.scope;
					const {methodOwner, methodName, calleeOptional} = d.init.type === 'call' && d.init.callee.type === 'member' && !objectIntrinsic(d.init)
						? {methodOwner: ownerOf(d.init.callee.object, ctx), methodName: d.init.callee.property, calleeOptional: d.init.callee.optional}
						: {};

					// No `Array<T>` substitution needed -- `substElemMethods` already monomorphized a method's whole body once, up front, so `d.typeAnnotation` is already concrete here.

					// `ctx.widenedTypes` before `T.literalTypeOf`: a loop-reassigned local's widened range must win over its initializer's narrower literal type,
					// or its wasm local gets fixed too tight and a later out-of-range reassignment corrupts it.
					let tsType = d.typeAnnotation ?? ctx.widenedTypes?.get(d) ?? T.literalTypeOf(d.init);
					if (!tsType && d.init.type === 'index') {
						// The real declared element `Type`: `T[]`/`Array<T>` give `T`, but `Uint8Array`/etc resolve (`resolveClassAlias`, before `T.resolve`
						// expands the alias) to `TypedArray<T>`, whose elements read back as `number` -- a physical-storage tag, not the real TS element type.
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
						// `arr?.[i]` short-circuits to `undefined` like any `?.`, but this bypasses `checkerTypeOf`, so the optional flag has to be
						// reattached here too -- same as `case 'member'`'s own `e.optional` handling.
						if (tsType && d.init.optional)
							tsType = T.combineTypes([tsType, T.UNDEFINED]);
					}
					if (!tsType && methodOwner) {
						// The method's raw declared return type read off the class decl, not `checkerTypeOf(d.init, stmtScope)`: `stmtScope`'s stamp only exists for a lib
						// method body when `makeLibScope`'s one-time check wasn't muted for it (see its own comment) -- deliberately not always the case, since a GENERIC
						// lib class method's stamp (`Array<T>.reverse`/`.fill`) would reflect the template's unresolved `T` and permanently block (`??=` first-wins) the real
						// per-instantiation substituted scope (`ctx.scope`) codegen needs. A `?.` call's `undefined` is reattached here too, and a `this`-typed return
						// (`sort(): this`) is substituted the way `ensureMethod` resolves it -- the declaring class's own type, since this bypass has no receiver inference.
						const method		= methodOwner.decl.body.find(m => m.type === 'method' && m.key === methodName) as MethodMember | undefined;
							// A return naming the method's OWN type parameter (`map<U>(...): U[]`) is only known from call-site inference; one naming its CLASS's
							// (`Array<T>.filter(): T[]`) is only known from the receiver: this owner is the ERASED instantiation (`Array<any>` backs every array of a
							// non-scalar element), whose decl already reads `any[]`. The original generic declaration says which, and the checker knows the real instantiation.
						const ownerName		= methodOwner.decl.name;
						const generic		= ownerName ? LIB_DECL_MAP.get(ownerName) ?? userGenericClassDecls.get(ownerName) : undefined;
						const genericReturn	= generic?.type === 'class_decl' ? (generic.body.find(m => m.type === 'method' && m.key === methodName) as MethodMember | undefined)?.returnType : undefined;
						const methodReturn	= method?.returnType && !method.typeParams?.some(p => T.mentionsTypeParam(method.returnType!, p.name)) ? method.returnType : undefined;
						const substituted = methodReturn && T.substituteThisType(methodReturn, methodOwner.thisTsType);
						tsType = substituted && calleeOptional ? T.combineTypes([substituted, T.UNDEFINED]) : substituted;
						// An erased `filter(): T[]` owner is `any`-shaped, so the checker -- which knows the real instantiation -- wins, unless it has no
						// answer either: a structural dynamic object routed to `Map` has no `keys()` for the checker to see at all.
						if (tsType && genericReturn && (generic?.type === 'class_decl' ? generic.typeParams ?? [] : []).some(p => T.mentionsTypeParam(genericReturn, p.name))) {
							const checked = checkerTypeOf(d.init, stmtScope);
							if (!T.isAny(checked))
								tsType = checked;
						}
					}

					tsType ??= checkerTypeOf(d.init, stmtScope);
					// Unstamped = synthesized after the check pass, or a generic template's stamp suppressed/stripped.
					// `narrowedTypeOf`, not `ctx.typeScope`: a narrowed scope turns a nominal `Map<K,V>` structural.
					if (T.isAny(tsType) && !stamped)
						tsType = ctx.narrowedTypeOf(d.init);

					const wtype = typeOf(tsType);
					if (!wtype) {
						// Let the actual lowering throw its own more specific error first (e.g. indexing a `string`) -- only fall back to this generic message if it didn't.
						emitExpr(d.init, ctx);
						throw `local '${d.name}' has an unsupported type`;
					}
					if (wtype === 'void')
						throw `local '${d.name}' cannot have type 'void'`;
					// A generator's own hoisted local (`compileGeneratorFunc`): storage is a frame struct field, not a real wasm local, same as a real closure
					// capture would be (`declareCaptured` already registered its scope type upfront, so only the write itself is new here).
					const hoisted = ctx.closureEnv?.fields.get(d.name);
					// `tsType` is the one real TS type this declaration has, seeding `ctx.contextualReturn` (see its own comment) while `d.init` compiles --
					// e.g. an array literal whose element is a generic call (`const rules: Expr[] = [makeRule(() => ({...}))]`).
					const savedContextualReturn = ctx.contextualReturn;
					ctx.contextualReturn = tsType;
					const initializing = (ctx.initializing ??= []);
					initializing.push(d);
					try {
						if (hoisted) {
							ctx.emit(I.local.get(ctx.closureEnv!.envLocal.index));
							emitAs(d.init, ctx, wtype);
							ctx.emit(I.struct.set(ctx.closureEnv!.envTypeIndex, hoisted.index));
						} else {
							// An EARLIER sibling closure may already have forward-referenced this name (`ensureForwardHolder`, from `emitClosureLiteral`'s own free-var check) --
							// but so may `d.init` ITSELF, compiled next (a self-recursive arrow, e.g. walker.ts's own `mapBindingTarget` calling its not-yet-declared name
							// from inside its own body). A plain `declareValue` after the fact would silently shadow the holder with a second, independent local, leaving
							// whatever captured it forever empty -- so the check has to happen AFTER `d.init` compiles; the value goes through a scratch local first
							// (`struct.set` needs the holder's own ref pushed before the value, but the value is what's already on the stack). A captured-and-assigned local
							// must BE a holder from the start (`needsHolder`), declared before `d.init` compiles so a closure inside the initializer captures the holder too,
							// and the store below goes through the same path a forward reference already took.
							if (!ctx.lookup(d.name)?.holderInner && needsHolder(ctx, d.name))
								declareHolder(ctx, d.name, wtype, tsType);
							emitAs(d.init, ctx, wtype);
							const forwardHolder = ctx.lookup(d.name);
							if (forwardHolder?.holderInner) {
								const scratch = ctx.temp(`$fwd$${d.name}`, wtype);
								ctx.emit(I.local.set(scratch), I.local.get(forwardHolder.index), I.local.get(scratch));
								ctx.emit(I.struct.set((forwardHolder.wtype as { typeIndex: number }).typeIndex, 0));
							} else {
								ctx.emit(I.local.set(ctx.declareValue(d.name, wtype, tsType).index));
							}
						}
					} finally {
						initializing.pop();
					}
					ctx.contextualReturn = savedContextualReturn;
				}
				return;

			case 'expression':
				if (emitExpr(s.expression, ctx, 'void') !== 'void')
					ctx.emit(I.drop);
				return;

			case 'if': {
				// A type guard its argument's type settles is decided here, and the dead branch is never compiled: it may not
				// even compile for this instantiation (lib `flat`'s array branch for a `number` element). The test still runs.
				const known = ctx.staticGuard(s.test);
				if (known !== undefined) {
					emitTruthy(s.test, ctx);
					ctx.emit(I.drop);
					const live = known ? s.consequent : s.alternate;
					if (live)
						emitStmt(live, ctx);
					return;
				}
				emitTruthy(s.test, ctx);
				const alternate = s.alternate;
				ctx.emitIf(undefined, () => emitStmt(s.consequent, ctx), alternate ? () => emitStmt(alternate, ctx) : undefined);
				return;
			}

			case 'while': {
				ctx.emitLoop(() => {
					emitTruthy(s.test, ctx);
					ctx.emit(I.i32.eqz, I.br_if(1));
					emitStmt(s.body, ctx);
					ctx.emit(I.br(0));
				});
				return;
			}
			case 'do_while': {
				ctx.emitLoop(() => {
					emitStmt(s.body, ctx);
					emitTruthy(s.test, ctx);
					ctx.emit(I.br_if(0));
				});
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
				// Same reasoning as `case 'this'`'s own guard -- a `return` inside a constructor implicitly needs `this` to exist too (that's the whole value being
				// returned), even a bare one: `ctx.onReturn` is still the generic `plainReturn(thisWtype)` handler here (not yet swapped to the constructor-specific
				// one, which only happens once every field is collected), so it would emit invalid wasm or coerce an arbitrary value into the class's own struct type.
				if (ctx.ctorFields)
					throw `'return' can't be used yet in '${ctx.owner?.name}'s constructor -- not every field has been assigned yet (this class has at least one object-typed field, needing 'struct.new' with every field's real value up front, before 'this' -- and so a valid return -- exists at all)`;
				ctx.onReturn.emit(ctx, s.argument);
				return;

			case 'for':
				switch (s.kind) {
					case 'normal':
						ctx.inScope(() => {
							// `s.init`'s own declaration (`for (let t = ...; ...)`) is scoped to the loop itself, same as real JS -- opened here rather than relying on
							// `s.body`'s own block scope, which may not exist at all if the body is a single bare statement.
							if (s.init)
								emitStmt(s.init.type === 'var_decl' ? s.init : JS.ExprStmt(s.init), ctx);

							// A `block` wrapping a `loop`, same idiom as `while`, except the body gets its own *inner*
							// block as the real `continue` target -- a plain `while` can reuse its restart label since it has no separate update step, but this desugared `for` has one (`s.update`) that must still run first.
							ctx.emitLoop(() => {
								emitTruthy(s.test ?? Literal(true), ctx);
								ctx.emit(I.i32.eqz, I.br_if(1));
								ctx.emitContinueBlock(() => emitStmt(s.body, ctx));
								if (s.update)
									emitStmt(JS.ExprStmt(s.update), ctx);
								ctx.emit(I.br(0));
							});
						});
						return;

					case  'of': {
						// The loop variable's own `name` (`v.name`) may be a plain identifier or a real destructuring pattern (`for (const [k, v] of pairs)`) -- `JS.Var`'s
						// own `name: BindingTarget` carries either through unchanged, and the synthesized `var_decl` (`JS.VarDecl(s.init.kind, JS.Var(v.name, ...))`) is
						// handled the same generic way any pattern-typed `var_decl` already is (`hoistVar`/`emitPatternBinding`) -- nothing here needs to know which shape.
						if (s.init.type !== 'var_decl' || s.init.declarations.length !== 1)
							throw "'for...of' loop variable must be a single declaration";

						const v			= s.init.declarations[0];
						const n			= ctx.tempCounter++;
						// A non-array with `[Symbol.iterator]()` iterates by the protocol, as JS iterates every iterable: `next()` until
						// `done`. `for...of` sends `undefined` to a `next` that takes a value (a generator's). Arrays stay indexed below.
						const it = iteratesByProtocol(s.right, ctx);
						if (it) {
							const itId: Expr	= Identifier(`#for${n}$it`);
							const rId: Expr		= Identifier(`#for${n}$r`);
							emitStmt(JS.Block<Stmt>(
								JS.VarDecl('const', JS.Var(`#for${n}$it`, JS.Call(JS.Member(s.right, '[Symbol.iterator]'), []))),
								JS.For(
									JS.VarDecl('let', JS.Var(`#for${n}$r`, nextCall(itId, it, ctx.typeScope))),
									JS.JSUnary('!', JS.Member(rId, 'done')),
									Assign<Expr, never>(rId, nextCall(itId, it, ctx.typeScope)),
									JS.Block<Stmt>(JS.VarDecl(s.init.kind, JS.Var(v.name, JS.Member(rId, 'value'), v.typeAnnotation ?? it.yield)), s.body),
								),
							), ctx);
							return;
						}
						const arrId: Expr = Identifier(`#for${n}$arr`);
						const idxId: Expr = Identifier(`#for${n}$i`);

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
					// `for (const k in obj)` -- most efficiently over a dynamic object (structural `{[k: string]: V}`, routed to `Map<string, V>`; see `indexSignatureValueType`),
					// which has a real, live key set: desugars to `for (const k of obj.keys())`, already-supported syntax, `keys()` being a real snapshot array (see
					// `lib/map.ts`'s own comment on why) -- so it iterates the live key set as the loop starts, matching real `for...in` closely enough for every real
					// use this project has (none mutate the object mid-loop). Anything else falls back to `Object.entries`, pulling just the key out of each `[k, v]`
					// pair via ordinary array-destructuring: deferring to `emitObjectEntries`'s own dispatch covers a *sealed* struct/class instance the same way, and
					// throws its own "not supported yet" for an extended class, for free.
					case 'in': {
						if (s.init.type !== 'var_decl' || s.init.declarations.length !== 1)
							throw "'for...in' loop variable must be a single declaration";

						// Anything read by POSITION (`isPositional`) enumerates its INDICES, as strings. Falling through to `Object.entries` below bound the entries instead,
						// so `for (const i in [5, 6])` gave the wrong values and the wrong count. `Array._indexKeys` builds them in ordinary typed lib code -- a synthesized
						// `String(i)` here has no checker stamp to resolve `toString` through.
						const indexed = ownerOf(s.right, ctx);
						if (indexed && isPositional(indexed, ctx)) {
							emitStmt({
								type: 'for', kind: 'of',
								init: s.init,
								right: JS.Call(JS.Member(Identifier('Array'), '_indexKeys'), [JS.Member(s.right, 'length')]),
								body: s.body,
							}, ctx);
							return;
						}

						if (ownerOf(s.right, ctx)?.methodDecls.get('keys')) {
							emitStmt({
								type: 'for', kind: 'of',
								init: s.init,
								right: JS.Call(JS.Member(s.right, 'keys'), []),
								body: s.body,
							}, ctx);
							return;
						}

						const v = s.init.declarations[0];
						emitStmt({
							type: 'for', kind: 'of',
							init: JS.VarDecl(s.init.kind, { ...v, name: JS.ArrayPattern([{ target: v.name }]) }),
							right: JS.Call(JS.Member(Identifier('Object'), 'entries'), [s.right]),
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
					emitStmt(JS.ExprStmt(s.discriminant), ctx);
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

							const old = ctx.swapOut();

							ctx.enterBreakTarget();
							ctx.enterLabel(n);

							// `br`/`br_table` labels are relative to the branch point: case `i`'s block is the `i`-th opened above (case 0 innermost), and "no default"
							// falls through all `n` case-blocks to the enclosing break-target block at relative depth `n`.
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
								emitStmts(s.cases[k].consequent, ctx);
								content = ctx.out;
							}
							ctx.exitBreakTarget();
							ctx.out = old;
							ctx.emit(I.block(undefined, content));
							return;

						}
					}
				}

				// One shared scope for the whole switch -- real JS gives every case a common lexical scope unless a case wraps its body in `{}`,
				// which nests its own block via `case 'block'` as usual.
				ctx.inScope(() => {
					const discName = `#switch$${ctx.tempCounter++}`;
					emitStmt(JS.VarDecl('const', JS.Var(discName, s.discriminant)), ctx);
					const discId: Expr = Identifier(discName);

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
						emitStmts(s.cases[i].consequent, ctx);
						content = ctx.out;
					}
					ctx.exitBreakTarget();
					ctx.out = old;
					ctx.emit(I.block(undefined, content));
				});
				return;
			}

			case 'function_decl':
				// A bodyless declaration is one signature of a local overload group (`hoist()`'s own top-level handling already treats these the same way -- only the
				// one real, bodied implementation a group always has gets registered/compiled; the signatures exist purely for the checker's own overload resolution,
				// nothing to emit here at all). Without this, two or more overload signatures sharing a name each tried to declare their own same-named local, hitting
				// the genuine "redeclared" guard below meant for real, user-visible shadowing.
				if (!s.body)
					return;
				// A sibling created earlier already captured this name's forward holder (`ensureForwardHolder`): fill that.
				if (ctx.lookup(s.name)?.holderInner) {
					ctx.inScope(() => {
						const target = emitAssignTarget(Identifier(s.name), ctx, 'none');
						coerceTop(emitClosureLiteral(s, ctx, true), ctx, target.wtype);
						target.write(false);
					});
					return;
				}
				ctx.emit(I.local.set(ctx.declareLocal(s.name, emitClosureLiteral(s, ctx, true)).index));
				return;

			case 'throw':
				emitAs(s.argument, ctx, W.REF_ANY);
				ctx.emit(I.throw(ensureExceptionTag()));
				return;

			// `try_table`'s catch dispatch is branch-based, not legacy EH's inline-handler style: two nested blocks -- `$after` (the shared landing point once either
			// the try body or the catch handler completes) wraps `$catchLand` (the catch clause's own branch target, delivering the caught `anyref` payload as its
			// result). The try body's success path explicitly `br`s past the handler to `$after`, so `$catchLand`'s wrapped `try_table` never falls through to its
			// own end -- `unreachable` closes that dead edge; without it the validator checks the block's declared (anyref) result against the fallthrough's nothing
			// and rejects the module. JS's grammar allows at most one `catch`, so `handlers` is only ever empty or a single clause here.
			case 'try':
				if (!s.handlers.length && !s.finalizer)
					throw "'try' needs a 'catch' or 'finally'";

				if (!s.finalizer) {
					const saved			= ctx.swapOut();
					ctx.enterLabel(3);
					ctx.inScope(() => emitStmts(s.body, ctx));
					
					ctx.emit(I.br(2));	//ctx.depth - $after
					ctx.exitLabel();
					ctx.emit(I.try_table(undefined, [wasm.Catch.tag(ensureExceptionTag(), 0)], ctx.swapOut()));
					ctx.emit(I.unreachable);
					ctx.exitLabel();
					ctx.emit(I.block(toValType(W.REF_ANY), ctx.swapOut()));

					ctx.inScope(() => {
						if (s.handlers[0].param) {
							if (typeof s.handlers[0].param !== 'string')
								throw "a destructured catch parameter ('catch ({...})'/'catch ([...])') is not supported";
							ctx.emit(I.local.set(ctx.declareValue(s.handlers[0].param, W.REF_ANY, T.ANY).index));
						} else {
							ctx.emit(I.drop);
						}
						emitStmts(s.handlers[0].body, ctx);
					});

					ctx.exitLabel();
					ctx.emit(I.block(undefined, ctx.swapOut(saved)));

				} else {

					// With a 'finally', every exit -- normal completion, a caught or uncaught exception, an escaping break/continue/return -- funnels through one shared
					// landing point ($land) that runs 'finally' once, then re-dispatches on a recorded action code; break/continue/return redirect here via
					// `ctx.finallyGuards` (see those `case`s above), while the exception path needs no interception (`throw_ref` propagates on its own). A
					// return/throw/break/continue written directly inside 'finally' needs no special handling either -- guards and `onReturn` are restored to their outer
					// values before 'finally' compiles, so it executes as a real exit or redirects through the next-outer guard. Works in a generator/async function, a
					// constructor, or a `reassignsThis` method too: `onReturn` rebuilds the real per-context return (IteratorResult/Promise/`this`), exactly as if
					// compiling that shape fresh.
					const actionLocal		= { wtype: 'i32' as const, index: ctx.temp('#finally$action', 'i32') };
					const exnLocal			= { wtype: W.REF_EXN, index: ctx.temp('#finally$exn', W.REF_EXN) };
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
					// A `return` in the protected region must stash its value and redirect here too; only one return meaning is ever current (no stack needed
					// as with nested loops' `break`), so a plain swap-and-restore mirrors `ctx.swapOut()`'s idiom.
					ctx.onReturn = {
						wtype: () => outerWtype,
						emit(ctx, argument) {
							if (returnValueLocal) {
								if (argument)
									emitAs(argument, ctx, returnValueLocal.wtype);
								else
									ctx.emitDefaultValue(returnValueLocal.wtype, types, toValType);
								ctx.emit(I.local.set(returnValueLocal.index));
							} else if (argument) {
								// Same rejection the real (outer) 'return' gives -- delegate to it for that message (a 'void' function vs. a constructor say this differently)
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
						ctx.inScope(() => emitStmts(s.body, ctx));
						ctx.emit(I.br(ctx.depth - afterDepth));
						ctx.exitLabel();
						ctx.emit(I.try_table(undefined, [wasm.Catch.tag(ensureExceptionTag(), 0)], ctx.swapOut()));
						ctx.emit(I.unreachable);
						ctx.exitLabel();
						ctx.emit(I.block(toValType(W.REF_ANY), ctx.swapOut()));

						// The catch param binds `$catchLand`'s own delivered value -- outside and *before* try_table (B) starts: a block's body doesn't inherit values left
						// on the outer stack unless declared as real params (none of these are), so try_table (B) itself must start from a clean slate, not reach back for a
						// value produced before it began.
						ctx.openScope();
							if (s.handlers[0].param) {
								if (typeof s.handlers[0].param !== 'string')
									throw "a destructured catch parameter ('catch ({...})'/'catch ([...])') is not supported";
								ctx.emit(I.local.set(ctx.declareValue(s.handlers[0].param, W.REF_ANY, T.ANY).index));
							} else {
								ctx.emit(I.drop);
							}

							// B (the catch handler) gets its *own* safety net -- unlike A, nothing else already
							// guarantees every exception B might throw is caught before 'finally' needs to run.
							const catchHandlerSaved = ctx.swapOut();
							ctx.enterLabel();			// try_table (B)'s own implicit level
							emitStmts(s.handlers[0].body, ctx);
						ctx.closeScope();

						ctx.emit(I.br(ctx.depth - afterDepth));
						ctx.exitLabel();
						ctx.emit(I.try_table(undefined, [wasm.Catch.allRef(ctx.depth - catchAllDepth)], ctx.swapOut(catchHandlerSaved)));
						ctx.emit(I.unreachable);
					} else {
						// No 'catch' clause -- 'finally' alone needs only the safety net around A itself.
						ctx.enterLabel();			// try_table's own implicit level
						ctx.inScope(() => emitStmts(s.body, ctx));
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
					ctx.emit(I.block(toValType(W.REF_EXN), ctx.swapOut()));
					ctx.emit(I.local.set(exnLocal.index), I.i32.const(4), I.local.set(actionLocal.index));
					ctx.exitLabel();				// exit $land
					ctx.emit(I.block(undefined, ctx.swapOut(saved)));

					ctx.inScope(() => emitStmts(s.finalizer!, ctx));

					// Exactly one action code is ever set, and each arm is gated by its own 'if' so the validator only checks one small branch at a time.
					const dispatch = (code: number, build: () => void) => {
						ctx.emit(I.local.get(actionLocal.index), I.i32.const(code), I.i32.eq);
						ctx.emitIf(undefined, build);
					};
					dispatch(1, () => outerOnReturn.emit(ctx, returnValueLocal ? Identifier('#finally$retval') : undefined));
					// Skip an arm entirely when no such target was enclosing this construct (those action codes can then never be set), since
					// 'case break'/'case continue' would otherwise reject the synthesized statement outright.
					if (guard.breakTargetsLenAtEntry > 0)
						dispatch(2, () => ctx.emitBreak());
					if (guard.continueTargetsLenAtEntry > 0)
						dispatch(3, () => ctx.emitContinue());
					dispatch(4, () => ctx.emit(I.local.get(exnLocal.index), I.throw_ref));
				}
				return;

			// Nothing to emit: an enum declares compile-time constants, collected into `enumMembers` by
			// the module scan and folded at each read.
			case 'enum_decl':
				return;

			default:
				throw `unsupported statement '${s.type}'`;
		}
	}

	// ===================================================================
	//  Function/Method
	// ===================================================================


	// A closure `WasmType` plus the language's own binding data for it. `WasmType.closure` is only the PHYSICAL shape (`ClosureSig`), so
	// `defaults`/`resolvedParams`/`restElem` live beside the payload rather than in it -- keyed by the payload OBJECT, not by its physical shape: two
	// same-shaped signatures legitimately differ in `resolvedParams` (see `case 'function'`), while `ensureClosureType` already memoizes by shape, so a
	// shape-keyed store would answer with the wrong one.
	const closureBindings = new WeakMap<W.ClosureSig, FuncSig>();
	function closureWtype(sig: FuncSig): W.Type {
		closureBindings.set(sig, sig);
		return { closure: sig };
	}
	// Total for anything `closureWtype` built, so a miss is an internal inconsistency: throwing keeps a payload assembled some
	// other way from silently looking like "no defaults".
	function closureSigOf(w: W.Type): FuncSig {
		if (typeof w === 'string' || !('closure' in w))
			throw 'internal: expected a closure WasmType';
		const sig = closureBindings.get(w.closure);
		if (!sig)
			throw 'internal: closure WasmType was not built by closureWtype';
		return sig;
	}

	// One shared pair of wasm types per distinct TS function signature (memoized by `wasmTypeKey` -- every
	// literal still gets its own concrete env type and `funcIndex`): `funcTypeIndex` is shared so every literal of this signature is callable via one `call_ref`; `structTypeIndex` is the 2-field `{code, env}` value type.
	// `closureTypes` is the ENUMERATION of every signature seen (`an`-dispatch scans its `sig`s); the struct itself
	// is `types.closure`, which dedupes structurally, so this map is only about which signatures exist.
	function ensureClosureType(sig: FuncSig): ClosureTypeInfo {
		const key = `(${sig.params.map(W.typeKey).join(',')})=>${W.typeKey(sig.result)}`;
		let info = closureTypes.get(key);
		if (!info) {
			const funcTypeIndex	= types.funcType([{ type: {ref: types.envBase(), nullable: false}, id: 'env' }, ...toParams(sig.params)], toResults(sig.result));
			info = { funcTypeIndex, structTypeIndex: types.closure(funcTypeIndex), sig };
			closureTypes.set(key, info);
		}
		return info;
	}




	// `earlierNames`/`scope` are only ever passed by `resolveParams` below -- needed both to validate an earlier-parameter-referencing default
	// (`isReemittableDefault`) and to infer that default's type against a scope that actually has those earlier parameters declared (`libGlobal` can't see them).
	function resolveParam(p: JS.Param<Type>, earlierNames?: ReadonlySet<string>, scope: Scope = libGlobal, calleeOnly = false): ResolvedParam {
		let tsType = p.typeAnnotation;
		const calleeSide = !!p.default && (calleeOnly || !isReemittableDefault(p.default, earlierNames));
		if (p.default)
			tsType ??= checkerTypeOf(p.default, scope);
		if (!tsType)
			throw `'param '${describeBinding(p.key)}' needs an explicit type`;
		const rawWtype = typeOf(tsType);
		if (!rawWtype)
			throw `'param '${describeBinding(p.key)}' needs an explicit type`;
		// See `closureFuncSigType`'s own comment -- box a real but wasm-unrepresentable `void` as `any`
		// rather than reject otherwise-valid source.
		const boxed = rawWtype === 'void' ? W.REF_ANY : rawWtype;
		// A bare `p?: T` widens to `T | undefined`, the same nullable-slot treatment `closureFuncSigType` already gives a function TYPE's own optional param:
		// an ordinary top-level function must likewise accept an explicit `undefined`/an omitted trailing argument for such a param.
		// `tsType` widens with the slot: it is what goes into `ctx.scope`, and leaving it as the bare annotation made `wtypeOf` derive a plain scalar
		// for a slot that is physically a nullable box -- so `b === undefined` on `b?: number` was rejected even though the box answers exactly that.
		if (calleeSide && T.unionMembers(tsType, scope).some(m => { const r = T.resolveOwn(m, scope); return r.type === 'literal' ? r.value === null : r.type === 'ref' && r.name === 'null'; }))
			throw `param '${describeBinding(p.key)}': a default applied in the callee needs a type without 'null' -- an omitted argument arrives as null, so an explicit null would take the default too`;
		return calleeSide ? { key: p.key, wtype: types.nullable(boxed), tsType: T.combineTypes([tsType, T.UNDEFINED]), calleeDefault: { value: p.default!, tsType } }
			: !p.default && hasMod(p, 'optional')
			? { key: p.key, wtype: types.nullable(boxed), tsType: T.combineTypes([tsType, T.UNDEFINED]) }
			: { key: p.key, wtype: boxed, tsType };
	}

	// Resolves a whole param list left to right, growing the earlier-names/scope `resolveParam` needs to validate and type a default that reads an earlier parameter:
	// each param sees every param resolved before it (real JS default-evaluation order), never one declared after it.
	function resolveParams(params: readonly JS.Param<Type>[], home: Scope = libGlobal): ResolvedParam[] {
		const earlierNames = new Set<string>();
		const scope = new Scope(home);
		return params.map(p => {
			const r = resolveParam(p, earlierNames, scope);
			if (typeof p.key === 'string') {
				earlierNames.add(p.key);
				scope.addValue(p.key, r.tsType);
			}
			return r;
		});
	}

	// Converts a generic call's arguments into the `(argTs, restElementTs)` shape the checker's own `inferTypeArgMap` takes, and lets that answer:
	// explicit call-site type args win; otherwise the checker's own policy (`T.Inference`, the contextual result type, deferred callback-return candidates) picks the instantiation.
	// Re-implementing that policy here is why the two could disagree about which instantiation a call picks.
	// `expected` is towasm's equivalent of the checker's contextual type (`ctx.contextualReturn`), passed when the call site had one (currently only `case 'array'` and `case 'var_decl'` seed it).
	type Expected = Type | (() => Type);
	function inferCallTypeArgs(typeParams: TS.TypeParam[], params: JS.Param<Type>[], args: Expr[], typeArgs: Type[] | undefined, ctx: FunctionContext, expected?: Expected, returnType?: Type, rest?: JS.Rest<Type>): Map<string, Type> {
		const scope = ctx.scope;
		// A spread position has no single argument type (`instantiate`'s own `argTs` convention); its element
		// type goes into `restElementTs`, one candidate as TS synthesizes the rest array.
		// NARROWED, as the checker infers: `if (t.type === 'object_pattern') mapObject(t, ...)` instantiates at that member, not the whole union.
		const argTs: (Type | undefined)[] = args.map(a => a.type === 'spread' ? undefined : ctx.narrowedTypeOf(a));
		const restElementTs: Type[] = [];
		args.forEach((a, i) => {
			const t = a.type === 'spread' ? T.resolveOwn(checkerTypeOf(a.operand, scope), scope) : i >= params.length ? argTs[i] : undefined;
			const el = a.type === 'spread' && t ? T.arrayLikeElement(t) ?? (t.type === 'tuple' ? T.combineTypes(T.elementTypes(t, scope)) : undefined)
				: t;
			if (el)
				restElementTs.push(el);
		});
		return checkerInferTypeArgMap({ params, rest, returnType, typeParams }, argTs, typeArgs, scope, restElementTs, typeof expected === 'function' ? expected() : expected);
	}

	function ensureFunc(name: string, decl: FunctionDecl, homeModule = '.'): FuncInfo {
		return funcs.get(homeKey(homeModule, name)) ?? compileFunc(name, decl, homeModule)!;
	}

	// Resolves a generic top-level function call to its monomorphized `FuncInfo`, cached under the same composite-key shape `ensureClass` uses for `Box<number>` (`identity<number>`).
	// Unlike a class reference, a function's type arguments are usually inferred from the arguments (`inferCallTypeArgs`); explicit call-site type args are honored too.
	// The instance is checked as a declaration of its own: its narrowing depends on the type arguments (`typeof x === 'string'` on `T | string` after `Array.isArray`), which the template can't see.
	function instantiateDecl(decl: FunctionDecl, map: Map<string, Type>, homeModule: string): FunctionDecl {
		const inst = { ...substituteTypeParams(map).statement(decl)!, typeParams: undefined } as FunctionDecl;
		checkHoisted([inst], new Scope(moduleScopeOf(homeModule) ?? libGlobal));
		return inst;
	}

	function ensureGenericFunc(name: string, decl: FunctionDecl, args: Expr[], typeArgs: Type[] | undefined, ctx: FunctionContext, expected?: Expected, homeModule = '.'): FuncInfo {
		const typeParams	= decl.typeParams!;
		const map			= inferCallTypeArgs(typeParams, decl.params, args, typeArgs, ctx, expected, decl.returnType as Type | undefined, decl.rest);
		// A class instance filling a structural parameter specializes the instantiation further, as it does a plain function.
		const substituted	= decl.params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteType(p.typeAnnotation, map) } : p);
		const structural	= decl.body && structuralParams(substituted, args, ctx);
		// Bare (unmangled) composite key -- `compileFunc` applies `homeKey` itself when it caches, so this
		// must match without a second wrapping here.
		const key			= structural ? structuralKey(genericKey(name, typeParams, map, global), structural) : genericKey(name, typeParams, map, global);
		const existing		= funcs.get(homeKey(homeModule, key));
		if (existing)
			return existing;
		// `ensureClassExtension`'s ordering requirement: if this function's body ever calls `Object.defineProperty`, any of this specific instantiation's own
		// concrete type arguments might be the target (which one isn't resolved until the body compiles), so all of them get marked conservatively now,
		// before `compileFunc` ever reaches an `ensureClass` call for any of them and finalizes its struct type one way or the other.
		if (decl.body && containsDefineProperty(decl.body)) {
			for (const t of map.values())
				if (t.type === 'ref' && !t.typeArgs)
					everExtended.add(t.name);
		}
		const inst = instantiateDecl(decl, map, homeModule);
		return compileFunc(key, structural ? { ...inst, params: inst.params.map((p, i) => structural[i] === substituted[i] ? p : structural[i]) } : inst, homeModule, name)!;
	}

	// `realName` is the function's own real, DECLARED name; for a generic instantiation `name` is a mangled per-instantiation cache key (`ensureGenericFunc`'s `genericKey(...)`)
	// that `global.value()` could never find anything under. Defaults to `name` in the ordinary, non-generic case, where they are identical.
	function compileFunc(name: string, decl: FunctionDecl, homeModule = '.', realName: string = name): FuncInfo | undefined {
		try {
			if (hasMod(decl, 'async'))
				return compileAsyncFunc(name, decl, homeModule);

			if (hasMod(decl, 'generator'))
				return compileGeneratorFunc(name, decl, homeModule);

			if (decl.typeParams?.length)
				throw `generic function '${name}' is not supported`;

			// No annotation defaults to `void` (matching real TS's inference), but an annotation that is present and does not resolve is still a real error, not silently `void` too.
			// A cross-module function's own `decl` never gets its inferred return type back-filled at all -- that only ever happens on a throwaway synthetic clone `hoist()` builds
			// for the declaring module's own scope entry (`exportScope`'s lazy, self-memoizing `returnType` accessor -- see its own comment), never copied back onto `decl`.
			// `global.value(name)`, when this name is imported directly into the entry module (the reachable case), recovers the exact same already-correctly-inferred signature --
			// far safer than re-deriving inference here with no way to see the declaring module's own local names. Falls through to the old `'void'` default whenever this doesn't apply.
			// The declaring module's own internal scope (`exportScope` stamps it on the body it hoisted). Without it a non-entry function's body rooted at `libGlobal`,
			// so every module-local name -- a sibling function's RETURN TYPE included -- resolved to `any`, and every lowering that reads the checker's type rather than the
			// physical one (indexing, `.length`, a field read) silently lost. `global.value` only ever found a name imported DIRECTLY into the entry, so a function
			// reached through a namespace import (`path.join`) never resolved at all.
			const moduleScope = moduleScopeOf(homeModule);
			const checkedType = moduleScope?.value(realName) ?? global.value(realName);
			const inferredReturnType = !decl.returnType && checkedType?.type === 'function' ? checkedType.returnType : undefined;
			const result = decl.returnType ? typeOf(decl.returnType)
				: inferredReturnType ? typeOf(inferredReturnType)
				: 'void';
			if (!result)
				throw `'${name}' has an unsupported return type`;

			// This function's own declaring module's scope (`stampSig` stamps `declScope` onto a hoisted signature once, using the exact scope `hoist()` was given for that module) --
			// rooting the compiled body's own scope here, instead of always `libGlobal`, is what lets a bare identifier referenced inside the body (a sibling class in the same file,
			// another top-level const, ...) resolve against ITS OWN module's declarations rather than only the entry's. Same reachability limitation as the return-type fallback above
			// (only when `name` is directly reachable via `global`) -- `homeScope` is simply `undefined` otherwise, falling back to `libGlobal` exactly as before.
			const homeScope = (checkedType?.type === 'function' ? checkedType.declScope as Scope | undefined : undefined) ?? moduleScope;

			const params	= resolveParams(decl.params, homeScope ?? libGlobal);
			if (decl.rest?.typeAnnotation)
				params.push({key: decl.rest.key, wtype: restParamWtype(decl.rest.typeAnnotation)!, tsType: decl.rest.typeAnnotation});

			const {funcIndex, typeIndex} = types.func(toParams2(params), toResults(result));
			const info: FuncInfo = {params: params.map(r => r.wtype), result, funcIndex, typeIndex, defaults: defaultsWithImplicitUndefined(decl.params), resolvedParams: params, hasRest: !!decl.rest?.typeAnnotation};
			funcs.set(homeKey(homeModule, name), info);
			worklist.push(W.withCatchAt(() => {
				const ctx	= new FunctionContext(name, new Scope(homeScope ?? libGlobal), plainReturn(result, decl.returnType as Type | undefined), undefined, homeModule);
				ctx.widenedTypes = collectRangeWidenings(decl.body!, ctx.scope);
				ctx.ownBody = decl.body!;
				ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
				emitStmts(decl.body!, ctx);
				ctx.emitTrailingUnreachable(result);
				info.body		= ctx.toFuncBody(params.length, toValType);
			}, decl, homeModule, name));
			return info;

		} catch (e) {
			//console.log(e);
			throw new W.Error(e as any, undefined, name, homeModule);
		}
	}

	// Shared by compileGeneratorFunc/compileAsyncFunc -- both restrict a resumable function's own params identically (plain identifier, no default, not optional, no rest);
	// `kind` only changes the error wording.
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

	// Shared by compileGeneratorFunc/compileAsyncFunc -- the frame's own field map (one per param, then one per hoisted local -- state and any extra hidden field,
	// e.g. async's own result Promise, are each caller's own concern, appended before/after this). `resumeValueType`, when given, overrides a suspend-boundary
	// declarator's own init-derived type -- needed only for a generator's `const v = yield x;` (see `compileGeneratorFunc`'s own comment on why `checkerTypeOf` can't
	// be trusted there); an async `await` needs no such override, so `compileAsyncFunc` never passes one.
	function buildFrameFields(decl: FunctionDecl, params: ResolvedParam[], widenedTypes: Map<JS.Var<Type>, Type>) {
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
			const tsType = d.typeAnnotation ?? widenedTypes.get(d) ?? (d.init && T.literalTypeOf(d.init)) ?? checkerTypeOf(d.init!, (stmt as any).scope as Scope ?? libGlobal);
			const wt = typeOf(tsType);
			if (!wt || wt === 'void')
				throw `local '${localName}' has an unsupported type`;
			localFields.set(localName, { index: frameFields.length, wtype: wt, tsType });
			frameFields.push({ type: toValType(wt), mut: true });
		}
		return { localFields, frameFields };
	}

	// A `function*` compiles to two real wasm functions: the exported name itself (calling it never runs the body, it just captures a fresh frame and hands it to
	// `new Generator(step)`, as a real JS generator call never runs any code until the first `.next()`), and a separate resumable "step" function shaped like an
	// ordinary closure -- `{code, env}` -- except the env doubles as a *frame*. `Generator<Y,R,N>`/`IteratorResult<Y,R>` (`lib/generator.ts`) are ordinary generic lib classes.
	function compileGeneratorFunc(name: string, decl: FunctionDecl, homeModule = '.'): FuncInfo {
		if (decl.typeParams?.length)
			throw `generic generator function '${name}' is not supported`;
		const params = resolveResumableParams(decl);

		const rt = decl.returnType;
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
		const resultWtype	= resultClass.thisType;

		const sig: FuncSig = { params: [nWtype], result: resultWtype, hasRest: false };
		const { funcTypeIndex, structTypeIndex } = ensureClosureType(sig);

		// The frame holds the resume state plus every local the body declares (conservative: hoists every one, not just those live across a yield -- see `collectHoistedLocals`).
		// `supertypes: [envBase]` matches an ordinary closure literal's env struct -- the step function's real wasm param is declared `(ref $envBase)` (`ensureClosureType`),
		// so whatever concrete frame struct gets stored into the closure at the creation site below must be a real subtype of it.
		const envBase		= types.envBase();
		const STATE_FIELD	= 0;
		// A frame field takes the same type `case 'var_decl'` would give the local (annotation, widened range, literal, checker type):
		// field and writes must agree -- the checker's plain `number` against an `i32` `let i = 0` write corrupted the first assignment.
		const widenedTypes	= collectRangeWidenings(decl.body!, libGlobal);
		const { localFields, frameFields } = buildFrameFields(decl, params, widenedTypes);
		const frameTypeIndex = types.add({ final: true, supertypes: [envBase], type: { kind: 'struct', fields: frameFields } });
		const machine		= BuildStateMachine(decl.body!);

		const { funcIndex: stepFuncIndex } = types.funcAt(funcTypeIndex);
		const stepInfo: FuncInfo = { params: sig.params, result: sig.result, hasRest: false, funcIndex: stepFuncIndex, typeIndex: funcTypeIndex };
		closureLiterals.push(stepInfo);

		worklist.push(W.withCatch(() => {
			const fnCtx			= new FunctionContext(name, new Scope(libGlobal), plainReturn(resultWtype), undefined, homeModule);
			// Param order must match `ensureClosureType`'s real wasm signature exactly (env, then `sig.params`) -- the cast-down frame local is declared
			// *after* both real params, as one more genuine local, same as an ordinary closure literal's own `#env` (`emitClosureLiteral`).
			const envParam		= fnCtx.declareLocal('#envParam', { typeIndex: envBase, nullable: false });
			const sentParam		= fnCtx.declareLocal('#sent', nWtype);
			const frameLocal	= fnCtx.declareLocal('#frame', { typeIndex: frameTypeIndex, nullable: false });
			fnCtx.emit(I.local.get(envParam.index), I.ref.cast(frameTypeIndex), I.local.set(frameLocal.index));
			// Every hoisted local reads/writes through the frame automatically from here on -- `case 'identifier'`/`emitAssignTarget` check `closureEnv.fields` first,
			// same as a real closure capture, and `case 'var_decl'` writes one instead of declaring a real wasm local when its own name is already a frame field.
			fnCtx.closureEnv = { envLocal: frameLocal, envTypeIndex: frameTypeIndex, fields: localFields };
			for (const [localName, { tsType }] of localFields)
				fnCtx.declareCaptured(localName, tsType);
			// The same map already consulted above, building the frame's own field types -- reused (not
			// recomputed) so `case 'var_decl'`'s actual write agrees with what the field was declared as.
			fnCtx.widenedTypes	= widenedTypes;

			const setFrame = (state: number) => fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(state), I.struct.set(frameTypeIndex, STATE_FIELD));

			const resultCtor = ensureCtor(resultClass, [], fnCtx);
			// `void` is never valid as a field's own type (`addField`'s guard), so `ensureClass` already boxed this instantiation's `value: Y | R` field to `any` for
			// `Generator<Y, void, N>`. `resultCtor.params[0]` -- not the bare `rWtype` -- is that real, already-resolved representation, and this must push a value
			// matching what the field/constructor was actually built to accept; identical to `rWtype` whenever `R` is an ordinary type.
			const valueWtype = resultCtor.params[0];
			// A plain `return expr;` in a generator body means "done", not an ordinary wasm return of `expr` (the step function's real wasm result is always an `IteratorResult`).
			fnCtx.onReturn = {
				wtype: () => valueWtype,
				emit(ctx, argument) {
					setFrame(machine.completeId);
					if (argument)
						emitAs(argument, ctx, valueWtype);
					else
						ctx.emitDefaultValue(valueWtype, types, toValType);
					ctx.emit(I.i32.const(1), I.call(resultCtor.funcIndex), I.return);
				},
			};

			// 'const v = yield x;' -- `v`'s own resume-side binding lives on the *suspending* segment's own `next` (the only place the flattener has it), not the segment it resumes into:
			// build the reverse lookup once, of which segment (by id) must write the sent value into which frame field, right before running its own statements.
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
					emitStmts(machine.segments[id].stmts, fnCtx);
				},
				(next, resumeId) => {
					if (next.kind !== 'yield')
						throw "'await' is not supported in generators yet";
					if (next.delegate)
						throw "'yield*' delegation is not supported";
					// `valueWtype` (`IteratorResult<Y,R>.value`'s own real, already-resolved type -- see its own comment above), not the bare `yWtype` (identical whenever `Y` and `R`
					// happen to be the same type, but a real, different representation once they're not): this constructor's own single `value` param always expects exactly one
					// physical shape, whichever path -- yield or return -- is calling it.
					if (next.operand)
						emitAs(next.operand, fnCtx, valueWtype);
					else
						fnCtx.emitDefaultValue(valueWtype, types, toValType);
					setFrame(resumeId);
					fnCtx.emit(I.i32.const(0), I.call(resultCtor.funcIndex), I.return);
				},
				() => {
					// Natural completion, or a repeat call once already pinned here -- either way,
					// idempotent: re-pin `state` to this same segment's own id, done forever after.
					fnCtx.emitDefaultValue(valueWtype, types, toValType);
					fnCtx.emit(I.i32.const(1), I.call(resultCtor.funcIndex), I.return);
				}
			);
			fnCtx.emit(I.loop(undefined, fnCtx.swapOut(oldOuter)));
			fnCtx.emitTrailingUnreachable(resultWtype);
			stepInfo.body		= fnCtx.toFuncBody(2, toValType);
		}, name, homeModule));

		const outerResult = genClass.thisType;
		const { funcIndex: outerFuncIndex, typeIndex: outerTypeIndex } = types.func(toParams2(params), toResults(outerResult));
		const info: FuncInfo = { params: params.map(p => p.wtype), result: outerResult, funcIndex: outerFuncIndex, typeIndex: outerTypeIndex, hasRest: false };
		funcs.set(name, info);

		worklist.push(W.withCatch(() => {
			const ctx			= new FunctionContext(name, new Scope(libGlobal), plainReturn(outerResult), undefined);
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
			const genCtor		= ensureCtor(genClass, [], ctx);
			const paramNames	= new Set(params.map(p => p.key as string));
			ctx.emit(I.ref.func(stepFuncIndex), I.i32.const(machine.entryId));
			for (const [localName, field] of localFields) {
				if (paramNames.has(localName))
					ctx.emit(I.local.get(ctx.lookup(localName)!.index));
				else
					ctx.emitDefaultValue(field.wtype, types, toValType);
			}
			ctx.emit(I.struct.new(frameTypeIndex), I.i32.const(sig.params.length), I.struct.new(structTypeIndex), I.call(genCtor.funcIndex), I.return);
			info.body = ctx.toFuncBody(params.length, toValType);
		}, name, homeModule));
		return info;

	}

	// An `async function` reuses the generator's resumable machinery (frame, `flattenStateMachine`, the loop+block dispatch), but is driven very differently: its body
	// starts running immediately, synchronously, up to its first real suspend or its own completion, and nothing external ever "asks" it to resume -- a suspended `await`
	// registers itself as a continuation via `Promise.then()`, so whichever other compiled code eventually calls `.resolve()` on the awaited promise re-enters the step
	// function next. The step function therefore needs no `IteratorResult`-shaped result (`void`) and no generic `{code,env}` closure-literal shape -- both callers call
	// its own real `funcIndex` directly -- so the frame is simply its first real param, no `envBase`/`ref.cast` indirection the way a generator's step function needs.
	function compileAsyncFunc(name: string, decl: FunctionDecl, homeModule = '.'): FuncInfo {
		if (decl.typeParams?.length)
			throw `generic function '${name}' is not supported`;
		const params = resolveResumableParams(decl);

		// Unlike a generator's own `decl.returnType` (see `compileGeneratorFunc`'s own comment), `checkFunctionBody`'s `skipReturn` is only ever forced for a *generator*,
		// so a plain async function's declared/inferred `Promise<R>` is trustworthy read directly, no scope-lookup workaround needed.
		const rt = decl.returnType;
		if (rt?.type !== 'ref' || rt.name !== 'Promise' || (rt.typeArgs?.length ?? 0) !== 1)
			throw `function '${name}' has an unexpected inferred return type`;

		const promiseClass			= ensureClass('Promise', rt.typeArgs);
		if (!promiseClass)
			throw `the 'Promise' lib class was not found`;
		const promiseWtype			= promiseClass.thisType;

		const envBase				= types.envBase();
		const STATE_FIELD			= 0;
		const widenedTypes			= collectRangeWidenings(decl.body!, libGlobal);
		const { localFields, frameFields } = buildFrameFields(decl, params, widenedTypes);

		// One more hidden field -- this function's own result Promise, resolved directly by every return and by natural completion (emitAsyncDispatch's own 'complete' handling).
		const resultPromiseField	= frameFields.push({ type: toValType(promiseWtype), mut: true }) - 1;
		const frameTypeIndex		= types.add({ final: true, supertypes: [envBase], type: { kind: 'struct', fields: frameFields } });
		const machine				= BuildStateMachine(decl.body!);

		// Registered like any other function (not through `ensureClosureType`, see this function's own header comment) -- `funcs`/`closureLiterals` are the only two collections
		// the module assembly pass (`place`) ever reads bodies from, and this one has no name to register under `funcs`, so `closureLiterals` is reused purely as "a body needing
		// placement". It is never actually taken as a first-class closure value -- the `elem declare` segment it also feeds only *permits* `ref.func`, it doesn't require using it.
		const { funcIndex: stepFuncIndex, typeIndex: stepFuncTypeIndex } = types.func(
			[{ type: { ref: frameTypeIndex, nullable: false }, id: 'frame' }, { type: toValType(W.REF_ANY), id: 'sent' }],
			[],
		);
		const stepInfo: FuncInfo = { params: [{ typeIndex: frameTypeIndex, nullable: false }, W.REF_ANY], result: 'void', hasRest: false, funcIndex: stepFuncIndex, typeIndex: stepFuncTypeIndex };
		closureLiterals.push(stepInfo);

		worklist.push(W.withCatch(() => {
			const fnCtx			= new FunctionContext(name, new Scope(libGlobal), plainReturn(), undefined, homeModule);
			const frameLocal	= fnCtx.declareLocal('#frame', { typeIndex: frameTypeIndex, nullable: false });
			const sentParam		= fnCtx.declareLocal('#sent', W.REF_ANY);
			fnCtx.closureEnv	= { envLocal: frameLocal, envTypeIndex: frameTypeIndex, fields: localFields };
			for (const [localName, { tsType }] of localFields)
				fnCtx.declareCaptured(localName, tsType);
			fnCtx.widenedTypes	= widenedTypes;
			const resolveMethod	= ensureMethod(promiseClass, 'resolve', [], fnCtx)!;

			const setFrame = (state: number) => fnCtx.emit(I.local.get(frameLocal.index), I.i32.const(state), I.struct.set(frameTypeIndex, STATE_FIELD));

			// `resolveMethod.params[0]`, not the bare `rWtype`, is `Promise<T>.resolve`'s own already-resolved wasm parameter type: identical for an
			// ordinary `T`, but `void` (e.g. `Promise<void>`) was boxed to `any` by `ensureClass` -- `void` is never valid as a field/param's own type
			// (see `addField`'s guard) -- so push a value matching what `resolve` was actually built to accept.
			const valueWtype = resolveMethod.params[0];
			// A plain `return expr;` resolves the function's own result Promise with `expr` and then does a bare wasm `return`, not an ordinary
			// return of `expr` (the step function's real wasm result type is always `void`; nothing ever reads it).
			fnCtx.onReturn = {
				wtype: () => valueWtype,
				emit(ctx, argument) {
					ctx.emit(I.local.get(frameLocal.index), I.struct.get(frameTypeIndex, resultPromiseField));
					if (argument)
						emitAs(argument, ctx, valueWtype);
					else
						ctx.emitDefaultValue(valueWtype, types, toValType);
					ctx.emit(I.call(resolveMethod.funcIndex), I.return);
				},
			};
			// `emitResumableDispatch`'s 'suspend'/'complete' arms, specialized for async: a suspend either unwraps a non-Promise operand inline
			// (the synchronous fast path) or registers a trampoline via `Promise.then()`; completion resolves the result Promise directly.

			// One trampoline per distinct awaited element type, shared by every await site of that type: it only needs to unbox its own value and
			// forward it (plus the frame, as its closure env -- a real `$envBase` subtype, like any closure literal's) into `stepFuncIndex`; the
			// frame's state field, set before `.then()`, already says which resume state that call lands on.
			const trampolines = new Map<string, { funcIndex: number; structTypeIndex: number }>();
			const ensureTrampoline = (tWtype: W.Type) => {
				const key = W.typeKey(tWtype);
				let info = trampolines.get(key);
				if (!info) {
					const { funcTypeIndex, structTypeIndex } = ensureClosureType({ params: [tWtype], result: 'void' });
					const { funcIndex } = types.funcAt(funcTypeIndex);
					const tInfo: FuncInfo = { params: [tWtype], result: 'void', hasRest: false, funcIndex, typeIndex: funcTypeIndex };
					closureLiterals.push(tInfo);
					worklist.push(() => {
						const tCtx			= new FunctionContext(fnCtx.name, new Scope(libGlobal), plainReturn(), undefined);
						const envParam		= tCtx.declareLocal('#envParam', { typeIndex: envBase, nullable: false });
						const valueParam	= tCtx.declareLocal('#value', tWtype);
						tCtx.emit(I.local.get(envParam.index), I.ref.cast(frameTypeIndex), I.local.get(valueParam.index));
						coerceTop(tWtype, tCtx, W.REF_ANY);
						tCtx.emit(I.call(stepFuncIndex), I.return);
						tInfo.body			= tCtx.toFuncBody(2, toValType);
					});
					info = { funcIndex, structTypeIndex };
					trampolines.set(key, info);
				}
				return info;
			};

			let awaitTemp = 0;

			// Same reverse-lookup idea as `emitGeneratorDispatch`'s own `sentBindings`: only a *real* Promise suspension resumes via `#sent`. The
			// synchronous fast path writes `resultVar` inline first, so also re-writing it from `#sent` clobbers it with an earlier resume's value.
			const sentBindings = new Map<number, { index: number; wtype: W.Type }>();
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
						coerceTop(W.REF_ANY, fnCtx, sentField.wtype);
						fnCtx.emit(I.struct.set(frameTypeIndex, sentField.index));
					}
					emitStmts(machine.segments[id].stmts, fnCtx);
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
						// `addField`/`resolveParam` already box a bare `void` reaching a field/param position as `any` (see their comments), but the
						// trampoline closure below is built from an already-resolved `WasmType`, bypassing that fallback, so it needs its own substitution.
						const awaitedClass		= ensureClass('Promise', [tType]);
						if (!awaitedClass)
							throw `the 'Promise' lib class was not found`;

						emitAs(operand, fnCtx, awaitedClass.thisType);
						const promiseLocal = fnCtx.declareLocal(`$await$${awaitTemp++}`, awaitedClass.thisType);
						fnCtx.emit(I.local.set(promiseLocal.index));

						// `state` must already say where to resume *before* calling `.then()`: an already-settled promise invokes the trampoline
						// synchronously, reentrantly calling `stepFuncIndex` before `.then()` returns (safe: this arm ends in `return`, so nothing is redone).
						setFrame(resumeId);

						const { funcIndex: trampolineFuncIndex, structTypeIndex: trampolineStructTypeIndex } = ensureTrampoline(tWtype === 'void' ? W.REF_ANY : tWtype);
						const thenMethod = ensureMethod(awaitedClass, 'then', [], fnCtx)!;
						fnCtx.emit(
							I.local.get(promiseLocal.index),
							I.ref.func(trampolineFuncIndex), I.local.get(frameLocal.index), I.i32.const(1), I.struct.new(trampolineStructTypeIndex),
							I.call(thenMethod.funcIndex), I.return
						);
					}
				},
				() => {
					fnCtx.emit(I.local.get(frameLocal.index), I.struct.get(frameTypeIndex, resultPromiseField));
					fnCtx.emitDefaultValue(valueWtype, types, toValType);
					fnCtx.emit(I.call(resolveMethod.funcIndex), I.return);
				}
			);
			fnCtx.emit(I.loop(undefined, fnCtx.swapOut(oldOuter)));
			stepInfo.body = fnCtx.toFuncBody(2, toValType);
		}, name, homeModule));

		const { funcIndex: outerFuncIndex, typeIndex: outerTypeIndex } = types.func(toParams2(params), toResults(promiseWtype));
		const info: FuncInfo = { params: params.map(p => p.wtype), result: promiseWtype, funcIndex: outerFuncIndex, typeIndex: outerTypeIndex, hasRest: false };
		funcs.set(name, info);
		worklist.push(W.withCatch(() => {
			const ctx = new FunctionContext(name, new Scope(libGlobal), plainReturn(promiseWtype), undefined);
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));

			const promiseCtor = ensureCtor(promiseClass, [], ctx);
			const resultPromiseLocal = ctx.declareLocal('#resultPromise', promiseWtype);
			// `promiseCtor.params[0]` -- not the bare `rWtype` -- matches its own real, already-resolved `initial: T` parameter (see the step
			// function's `valueWtype` comment for why these diverge when `T` is `void`); its value never matters -- `resolve()` overwrites it.
			ctx.emitDefaultValue(promiseCtor.params[0], types, toValType);
			ctx.emit(I.call(promiseCtor.funcIndex), I.local.set(resultPromiseLocal.index));

			// Built via a real `struct.new` (a value per field) rather than `struct.new_default` + later `struct.set`s -- same reasoning as
			// `compileGeneratorFunc`'s own construction: a non-nullable object-typed field (e.g. a `Promise<T>` param) isn't *defaultable*.
			// Values go in declaration order, `resultPromiseField` last since the field itself was appended after every param/hoisted local.
			const paramNames = new Set(params.map(p => p.key as string));
			ctx.emit(I.i32.const(machine.entryId));
			for (const [localName, field] of localFields) {
				if (paramNames.has(localName))
					ctx.emit(I.local.get(ctx.lookup(localName)!.index));
				else
					ctx.emitDefaultValue(field.wtype, types, toValType);
			}
			ctx.emit(I.local.get(resultPromiseLocal.index), I.struct.new(frameTypeIndex));

			// Kick the body off immediately, synchronously, up to its first real suspend or completion -- real JS runs an async body right away
			// and only returns to its caller at an `await`. The entry segment never reads `#sent`, but its declared type is non-nullable `any`,
			// so a real (if unused) box rather than `ref.null` keeps that true.
			ctx.emit(
				I.f64.const(0), I.struct.new(types.box('f64')),
				I.call(stepFuncIndex),
				I.local.get(resultPromiseLocal.index), I.return
			);
			info.body = ctx.toFuncBody(params.length, toValType);
		}, name));
		return info;
	}


	// Resolves a bare type-alias name (`declare type X = SomeGenericClass<...>`, e.g. lib.d.ts's own `Uint8Array = TypedArray<u8>`) to its real
	// generic target, so a name with only a type alias can still be instantiated the ordinary generic way (see `ensureClass`) -- without a
	// physical declaration or name-substituted copy per alias. General: any such alias, not just typed-array ones.
	function resolveClassAlias(name: string): { name: string; typeArgs: Type[] } | undefined {
		const target = libGlobal.type(name)?.type;
		return target?.type === 'ref' && target.typeArgs?.length && LIB_DECL_MAP.get(target.name)?.type === 'class_decl'
			? { name: target.name, typeArgs: target.typeArgs }
			: undefined;
	}

	// The expando fields `collectExpandoFields` found for this shape, appended before its struct type is finalized. `optional`, because no
	// construction site ever supplies one: source cannot spell `#ext`, and a statically-named one (`scope`, `pos`) is only written afterwards.
	// A field on the shape ITSELF, not a subtype: known before the type exists, so nothing is cast and every instance has the slot.
	function addExpandoFields(info: ClassInfo, name: string) {
		for (const key of accessorKeys.get(name) ?? []) {
			const slots: [string, W.Type][] = [[`#get:${key}`, getterWtype()], [`#set:${key}`, setterWtype()]];
			for (const [slot, wtype] of slots)
				if (!info.fieldIndex.has(slot)) {
					info.fieldIndex.set(slot, info.fields.length);
					info.fields.push({ name: slot, wtype, optional: true });
				}
		}
		const spec = pendingExtensions.get(name);
		if (!spec)
			return;
		if (spec === 'dynamic') {
			if (info.fieldIndex.has('#ext'))
				return;
			const map = ensureClass('Map', [TS.RefType('string'), T.ANY]);
			if (!map)
				throw `internal: 'Map' isn't available for '${name}''s own dynamic expando`;
			info.fieldIndex.set('#ext', info.fields.length);
			info.fields.push({ name: '#ext', wtype: { ...(map.thisWtype! as { ref: string }), nullable: true }, optional: true });
		} else {
			for (const key of spec)
				if (!info.fieldIndex.has(key))
					addField(info, key, T.ANY, true);
		}
	}

	function getterWtype(): W.Type { return types.nullable(typeOf(getterSig())!); }
	function setterWtype(): W.Type { return types.nullable(typeOf(setterSig())!); }

	// A field write; `obj`/`val` are locals holding the receiver and the value (typed `valWtype`). A key some `defineProperty`
	// gave a setter (`accessorKeys`) has a `#set:k` companion: while that holds a setter the write CALLS it; otherwise the field.
	function emitFieldWrite(cls: ClassInfo, idx: number, obj: number, val: number, valWtype: W.Type, ctx: FunctionContext): void {
		const field	= cls.fields[idx];
		const acc	= cls.fieldIndex.get(`#set:${field.name}`);
		const plain	= () => {
			ctx.emit(I.local.get(obj), I.local.get(val));
			coerceTop(valWtype, ctx, field.wtype);
			ctx.emit(I.struct.set(cls.typeIndex, idx));
		};
		if (acc === undefined)
			return plain();
		const setterW	= cls.fields[acc].wtype;
		if (typeof setterW !== 'object' || !('closure' in setterW))
			throw `internal: '${cls.name}'s '#set:${field.name}' is not a setter slot (${W.typeKey(setterW)})`;
		const { funcTypeIndex, structTypeIndex } = ensureClosureType(setterW.closure);
		const setter	= ctx.declareLocal(`$acc$set$${ctx.tempCounter++}`, setterW);
		ctx.emit(I.local.get(obj), I.struct.get(cls.typeIndex, acc), I.local.tee(setter.index), I.ref.is_null);
		ctx.emitIf(undefined, plain, () => {
			ctx.emit(I.local.get(setter.index), I.ref.as_non_null, I.struct.get(structTypeIndex, 1), I.local.get(val));
			coerceTop(valWtype, ctx, setterW.closure.params[0]);
			ctx.emit(I.local.get(setter.index), I.ref.as_non_null, I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
		});
	}

	// A field read, the receiver already on the stack. A field some `Object.defineProperty` gave a getter (`accessorKeys`) has
	// a `#get:k` companion: while that holds a getter the read CALLS it, as JS reads an accessor property; otherwise the field.
	function emitFieldRead(cls: ClassInfo, idx: number, ctx: FunctionContext): W.Type {
		const field	= cls.fields[idx];
		const acc	= cls.fieldIndex.get(`#get:${field.name}`);
		if (acc === undefined) {
			ctx.emit(I.struct.get(cls.typeIndex, idx));
			return field.wtype;
		}
		const getterW	= cls.fields[acc].wtype;
		if (typeof getterW !== 'object' || !('closure' in getterW))
			throw `internal: '${cls.name}'s '#get:${field.name}' is not a getter slot (${W.typeKey(getterW)})`;
		const { funcTypeIndex, structTypeIndex } = ensureClosureType(getterW.closure);
		const obj		= ctx.declareLocal(`$acc$obj$${ctx.tempCounter++}`, types.nullable(cls.thisWtype!));
		const getter	= ctx.declareLocal(`$acc$get$${ctx.tempCounter++}`, getterW);
		ctx.emit(I.local.tee(obj.index), I.struct.get(cls.typeIndex, acc), I.local.tee(getter.index), I.ref.is_null);
		ctx.emitIf(toValType(field.wtype),
			() => ctx.emit(I.local.get(obj.index), I.struct.get(cls.typeIndex, idx)),
			() => {
				ctx.emit(I.local.get(getter.index), I.ref.as_non_null, I.struct.get(structTypeIndex, 1),
					I.local.get(getter.index), I.ref.as_non_null, I.struct.get(structTypeIndex, 0), I.call_ref(funcTypeIndex));
				coerceTop(getterW.closure.result, ctx, field.wtype);
			});
		return field.wtype;
	}

	function addField(info: ClassInfo, key: string, typeAnnotation?: Type, optional = false) {
		// See `closureFuncSigType`'s own comment -- box a real but wasm-unrepresentable `void` as `any` rather than reject otherwise-valid source.
		const rawWt = typeAnnotation && typeOf(typeAnnotation);
		let wt	= rawWt === 'void' ? W.REF_ANY : rawWt;
		if (!wt) {
			if (process.env.DBG)
				console.error(`addField FAIL info=${info.name} key=${key} ann=${typeAnnotation ? typeAnnotation.type + ' ' + T.typeKey(typeAnnotation).replace(/\s+/g,' ').slice(0,120) : 'undefined'} resolved=${typeAnnotation ? T.typeKey(T.resolve(global, typeAnnotation)).replace(/\s+/g,' ').slice(0,120) : '-'}`);
			throw `'${key}' needs an explicit number/boolean/object type`;
		}
		// The checker tracks `optional` as a separate modifier, never folding `value?: T` into `| undefined` (same gap as optional params), so
		// `wt` alone never says a field can be absent: force nullability, or an omitted boxed `any` (default `0`, not `undefined`) defeats `??=`.
		if (optional && typeof wt === 'object' && !wt.nullable)
			wt = types.nullable(wt);
		// A scalar-typed optional field needs the same null-boxing an optional *parameter* already gets: without it there is no absent value
		// distinct from `0`/`false`, so `??=` and `=== undefined` fail (an unassigned `n?: number` reads back as `0`). Only `f64`/`i32` have a box.
		if (optional && (wt === 'f64' || wt === 'i32'))
			wt = types.nullable(wt);
		info.addField(key, wt, optional);
	}

	// Resolves a plain, non-generic type alias (`type Point = { x: number; y: number };`) whose target is a structural object type of only
	// 'property' members into a real wasm-GC struct -- object-literal support only, no structural inference -- cached in the same `classes` map
	// as real classes (a name can't be both a `class_decl` and a type alias), so ordinary field access works on it unchanged.
	// Shared struct-building core for `ensureObjectShape` and `ensureAnonObjectShape`: `info` enters `classes` (with a real `typeIndex`) before
	// any member's type is resolved -- `ensureClass`'s placeholder-first ordering -- so a union reached again through one of its own fields finds
	// it already there. Fields start with `base`'s (a real wasm subtype); a base still being BUILT has no `final` yet, so its link waits.
	const pendingSupertypes = new Map<ClassInfo, ClassInfo[]>();
	const subtypesOf		= new Map<ClassInfo, ClassInfo[]>();
	function linkSupertype(info: ClassInfo, base: ClassInfo): boolean {
		const baseType = types.get(base.typeIndex);
		if (!baseType || !('final' in baseType)) {
			pendingSupertypes.set(base, [...(pendingSupertypes.get(base) ?? []), info]);
			return true;
		}
		if (!baseType.final && base.fields.every((f, i) =>
			info.fields[i]?.name === f.name && !!info.fields[i].optional === !!f.optional && W.typeEq(info.fields[i].wtype, f.wtype))) {
			info.superClass = base;
			(types.get(info.typeIndex) as { supertypes: number[] }).supertypes = [base.typeIndex];
			subtypesOf.set(base, [...(subtypesOf.get(base) ?? []), info]);
		}
		return false;
	}

	// Laid out again over a base that has since GAINED fields -- `addExpandoFields` appends its accessor companions last, well after a subtype
	// reached from one of the base's own field types copied what the base had then. The base's fields stay an exact prefix; its own must agree.
	function relayoutOverBase(info: ClassInfo, base: ClassInfo): void {
		const inherited = new Map(base.fields.map(f => [f.name, f]));
		if (!info.fields.every(f => !inherited.has(f.name)
			|| (W.typeEq(f.wtype, inherited.get(f.name)!.wtype) && !!f.optional === !!inherited.get(f.name)!.optional)))
			return;
		info.fields		= [...base.fields.map(f => ({ name: f.name, wtype: f.wtype, optional: f.optional })), ...info.fields.filter(f => !inherited.has(f.name))];
		info.fieldIndex	= new Map(info.fields.map((f, i) => [f.name, i]));
		(types.get(info.typeIndex) as { type: { fields: { type: wasm.ValType; mut: boolean }[] } }).type.fields
						= info.fields.map(f => ({ type: toValType(f.wtype), mut: true }));
		linkSupertype(info, base);
		(subtypesOf.get(info) ?? []).forEach(sub => relayoutOverBase(sub, info));
	}

	function buildObjectShape(key: string, members: TS.TypeMember[], thisTsType: Type, declName: string, everFinal: boolean, shape = shapeKey(members)): ClassInfo {
		const info = new ClassInfo(key, types.add({kind: 'struct', fields: []}), { name: declName, body: [] }, thisTsType);
		info.thisWtype = { ref: key };
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

		addExpandoFields(info, declName);
		addExpandoFields(info, shape);
		types.set(info.typeIndex, {
			final: everFinal,
			supertypes: [], type: {
				kind: 'struct',
				fields: info.fields.map(f => ({ type: toValType(f.wtype), mut: true })),
			}
		});
		const waiting = pendingSupertypes.get(info);
		if (waiting) {
			pendingSupertypes.delete(info);
			waiting.forEach(w => relayoutOverBase(w, info));
		}
		return info;
	}



	function ensureObjectShape(name: string, typeArgs?: Type[], declScope?: Scope): ClassInfo | undefined {
		const scope = declScope ?? global;
		const entry = scope.type(name);
		if (!entry)
			return undefined;

		// One struct per LAYOUT (`ownsLayout`): `Box<number>`'s `T[]` is a real `number[]`, while every reference argument
		// erases to its constraint -- wasm fields are invariant, so separate `R<C>`/`R<{x}>` could never convert.
		const args: Type[] = [];
		if (entry.typeParams?.length) {
			const chosen = new Map<string, Type>();
			entry.typeParams.forEach((p, i) => {
				const arg = typeArgs?.[i] ?? (p.default ? T.substituteType(p.default, chosen) : p.constraint ?? T.ANY);
				chosen.set(p.name, arg);
				args.push(ownsLayout(arg, scope) ? arg : p.constraint ?? T.ANY);
			});
		}
		let key		= args.length ? `${name}<${args.map(a => layoutArgKey(a, scope)).join(',')}>` : name;
		// Which MODULE declares the name is part of the key: two modules can declare the same one (`Common.Member` and js-parser's own `Member`),
		// and a shape keyed by name alone handed the second one the first's struct. The entry module and the lib keep bare keys.
		const tag = moduleTagOf(name, entry);
		if (tag)
			key += `@${tag}`;
		const existing	= classes.get(key);
		if (existing)
			return existing;

		// Via a `RefType` (not the entry's own raw, still-generic `.type`) so a reference to a generic interface/alias -- bare or explicit -- goes
		// through `resolve`'s own type-arg substitution (each param to its given arg, its default, or `any`) instead of leaving the type param
		// unresolved in every member's type. Stamped with `scope` because this exact ref becomes `thisTsType`, which `fieldDeclaredType` re-resolves.
		const ref = TS.RefType(name, args.length ? args : typeArgs);
		ref.declScope = scope;
		// `resolveObjectType` (not a hand-rolled intersection flatten): an interface `extends`ing another (`Method<T> extends CallSig<T>`) needs its
		// parts (`CallSig<T>` itself still an unresolved ref here) actually RESOLVED, not just unwrapped-if-already-an-object -- a flatten that only
		// handled already-expanded object parts silently dropped the rest, leaving `Method<Type>` with only its own directly-declared fields.
		const resolved = T.resolveObjectType(ref, scope);
		if (!resolved)
			return undefined;
		// An index-signature-shaped object (`Partial<T>`, `Record<string,V>`, ...) isn't a fixed-field struct at all -- `ownerFor`'s caller already
		// has a real, more appropriate fallback for this shape (`indexSignatureValueType`, the `Map`-backed path) once `ensureClass` declines here.

		if (resolved.members.some(m => m.type !== 'property' && m.type !== 'method'))
			return undefined;

		// Shared with the structurally-identical ANONYMOUS shape under `ensureAnonObjectShape`'s own `T.typeKey` identity: `type A = { n: number }`
		// written as `A` in one place and inlined in another is ONE type in TS, but keying a named shape by name alone built a second struct, so a
		// value built as one failed `ref.cast` to the other (an illegal cast at runtime). Only alias/interface SHAPES collapse; a `class` keeps
		// `ensureClass`'s own nominal name-based key.
		const structural	= T.typeKey(resolved);
		const shared		= classes.get(structural);
		if (shared) {
			classes.set(key, shared);
			if (!shapeEntries.has(shared))
				shapeEntries.set(shared, entry);
			return shared;
		}
		// `interface X extends Y` puts Y's fields first, so X's struct can be a wasm SUBTYPE of Y's: an X then IS a Y.
		const top		= T.resolve(scope, ref);
		// An alias of a named shape IS that shape (`type CallSig = JS.CallSig<Type>`): same struct, same supertype. Read off what the alias
		// DECLARES, not what `resolve` expands it to -- an interface that extends another expands to an intersection, and the alias then built a
		// SECOND struct nothing could convert to the first.
		const aliased	= entry.typeParams?.length ? T.substituteType(entry.type, T.typeArgMap(entry.typeParams, typeArgs)) : entry.type;
		const aliasRef	= aliased.type === 'ref' && aliased.name !== name ? aliased
						: top.type === 'ref' && top.name !== name ? top : undefined;
		if (aliasRef) {
			const target = ensureClassRef({ ...aliasRef, declScope: (aliasRef.declScope as Scope | undefined) ?? scope });
			if (target) {
				classes.set(key, target);
				return target;
			}
		}
		const baseRef	= top.type === 'intersection' && top.types[0].type === 'ref' ? top.types[0] : undefined;
		const base		= baseRef && ensureClassRef({ ...baseRef, declScope: baseRef.declScope ?? scope });
		const reached	= classes.get(key);
		if (reached)
			return reached;
		const basePos	= new Map(base?.fields.map((f, i) => [f.name, i]));
		const at		= (m: TS.TypeMember) => ('key' in m && typeof m.key === 'string' ? basePos.get(m.key) : undefined) ?? Infinity;
		// The base's expando fields (and `#ext`) are part of its layout, so they are repeated in place: a base that
		// gains one would otherwise silently stop being this shape's wasm supertype.
		const declared	= new Set(resolved.members.flatMap(m => 'key' in m && typeof m.key === 'string' ? [m.key] : []));
		const inherited	= (base?.fields ?? []).filter(f => !declared.has(f.name))
			.map(f => TS.TypeProperty(f.name, hiddenFieldType(f.name), ['optional']));
		const info		= buildObjectShape(key, base ? [...resolved.members, ...inherited].sort((a, b) => at(a) - at(b)) : resolved.members, ref, name, !everExtended.has(name), shapeKey(resolved.members));
		classes.set(structural, info);
		shapeEntries.set(info, entry);
		// Deferred: a shape merged into a twin could not take the supertype afterwards.
		if (base && linkSupertype(info, base))
			return info;
		return layoutTwin(info, key, structural);
	}

	// A STRUCTURAL shape's identity is its physical layout -- fields sorted, each by its stored wasm type -- since
	// wasm struct fields are invariant and two structs with one layout could never convert. Final, supertype-free only.
	function layoutTwin(info: ClassInfo, ...aliases: string[]): ClassInfo {
		const sub = types.get(info.typeIndex);
		if (info.superClass || !('final' in sub) || !sub.final)
			return info;
		const fieldKey	= (w: W.Type) => typeof w === 'object' && 'ref' in w && classes.get(w.ref) ? `ref:${classes.get(w.ref)!.name}:${!!w.nullable}` : W.typeKey(w);
		const layout	= `#layout#${info.fields.map(f => `${f.name}${f.optional ? '?' : ''}:${fieldKey(f.wtype)}`).sort().join(',')}`;
		const twin		= classes.get(layout);
		if (!twin) {
			classes.set(layout, info);
			return info;
		}
		// Refused once a later type already names `info`'s own index: repointing the key would strand it.
		if (twin === info || types.slice(info.typeIndex + 1).some(t => W.mentionsTypeIndex(t, info.typeIndex)))
			return info;
		// The twin will hold values of both, so its TS type becomes their field-wise union: sound for either, and it
		// keeps every tag `matchObjectShape`'s discriminant tiebreak reads. No representable union, no merge.
		const merged = T.typeKey(twin.thisTsType) === T.typeKey(info.thisTsType) ? twin.thisTsType : T.unionShapes(twin.thisTsType, info.thisTsType, global);
		if (!merged)
			return info;
		twin.anonymous &&= info.anonymous;
		for (const k of aliases)
			classes.set(k, twin);
		if (merged !== twin.thisTsType) {
			twin.thisTsType = merged;
			classes.set(T.typeKey(merged), twin);
		}
		return twin;
	}

	// An anonymous inline object type has no name, so `T.typeKey` is its cache key and its identity is its physical layout (`layoutTwin`):
	// shapes that print differently but store alike share one struct; `anonShapeVetting` breaks the recursion a member leading back here would cause (a cyclic shape can't be built anyway).
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
		// Every property needs a representation before this commits to a struct: failing here, not inside `addField`, leaves the caller its `wasmTypeOf` fallback.
		// The case that forced it: a namespace object (`import * as T`) is a valid object TYPE whose members include classes and type aliases, yet is never a value.
		anonShapeVetting.add(key);
		try {
			if (obj.members.some(m => m.type === 'property' && !(m.typeAnnotation && typeOf(m.typeAnnotation))))
				return undefined;
		} finally {
			anonShapeVetting.delete(key);
		}
		const info = buildObjectShape(key, obj.members, obj, key, true);
		info.anonymous = true;
		return layoutTwin(info, key);
	}

	// Resolves fields and the struct type eagerly, but only collects method/ctor decls -- building each is
	// deferred to `ensureMethod`/`ensureCtor`, the same lazy treatment `ensureFunc` gives top-level functions.
	function ensureClass(name: string, typeArgs?: Type[], declScope?: Scope): ClassInfo | undefined {
		// A generic instantiation whose surviving type argument (`Box<number>`) is cached under a composite key -- keying off
		// the *unresolved* class name, not `T.resolve`'s expanded form, keeps identically-shaped classes from colliding.
		// A wasm pseudo-type argument (`TypedArray<u8>`/`<i32>`, see `T.WASM_PSEUDO_TYPES`) is kept by its own name because
		// `T.resolve` collapses every one to plain `number`, which would key `TypedArray<u8>` and `<i32>` identically and
		// wrongly share one physical class, $elem-tagged by whichever instantiated first.
		// An argument earns its own physical instantiation only when it changes the LAYOUT -- when the value is stored
		// UNBOXED. A reference type occupies one ref slot, so swapping refs cannot reshape a struct; only a scalar
		// (`number` -> f64, `boolean` -> i32) or a typed-array tag can. Everything else collapses to `any`, so a conversion
		// between those instantiations is identity rather than an unsatisfiable `cannot convert ref:X<a> to ref:X<b>` --
		// wasm struct fields are mutable, hence invariant.
		// Restricted to a class with no METHODS of its own: a method body is compiled against the instantiation it was
		// reached through (`substElemMethods`), so merging two whose methods differ runs code built for one layout against
		// the other -- measured as a wasm `invalid struct index`. `Array` is exempt: its methods are compiled for the boxed
		// `any` form, the point of collapsing to it, while a DATA-shaped generic (`Terminal<T>`, `Rule<T>`) has no such code.
		// The trigger is structural, never a class name.
		const classDecl = LIB_DECL_MAP.get(name) ?? userGenericClassDecls.get(name) ?? declScope?.decl(name);
		if (name === 'Array' || (classDecl?.type === 'class_decl' && !classDecl.body.some(m => m.type === 'method')))
			typeArgs = typeArgs?.map(t => ownsLayout(t, global) ? t : T.ANY);
		const key = typeArgs?.length ? `${name}<${typeArgs.map(t => layoutArgKey(t, global)).join(',')}>` : name;
		// A non-generic top-level class is seeded into `classes` *eagerly* (`TStoWasm`'s seeding pass), so `typeIndex === -1` means "reserved but not yet processed"
		// -- unlike `ensureObjectShape`, which nothing pre-seeds. A generic class is never pre-seeded: only its template lives in `userGenericClassDecls`, and each
		// instantiation is cached lazily here on first reference.
		let info = classes.get(key);
		if (info && otherDeclaration(info, name, declScope))
			info = undefined;
		if (info && info.typeIndex !== -1)
			return info;

		if (!info) {
			// A lib-internal class is seeded lazily on first reference. `declScope?.decl(name)` resolves a non-entry module's own class (never eagerly seeded) through
			// the same scope chain `ensureObjectShape` uses, landing on the *real* declaration rather than that fallback's structural-shape-only reconstruction, which has no methods.
			let decl = LIB_DECL_MAP.get(name) ?? userGenericClassDecls.get(name) ?? declScope?.decl(name);
			if (decl?.type !== 'class_decl') {
				// `resolveClassAlias` covers only a *lib* alias to a real class name, never a generic; a generic interface/type-alias reference
				// (with or without explicit type args, e.g. `TypeParam` bare or `TypeParam<T>`) goes straight to `ensureObjectShape`.
				if (!typeArgs?.length) {
					const alias = resolveClassAlias(name);
					if (alias)
						return ensureClass(alias.name, alias.typeArgs, declScope);
				}
				// Checked before the structural fallback, which would otherwise reconstruct a shape-only stand-in (no constructor, no methods) for what is really a known class,
				// and cache it under this very name -- so whichever of the annotation and the `new` resolves first wins for both.
				// `?? global`: a bare ref annotation often carries no `declScope`, and the alias is a top-level declaration either way.
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
			// `thisTsType` must be a real reference to this class -- the ref itself carries the real name and type arguments, not the mangled composite cache key,
			// or `this.length`/`this[i]` can't resolve (`T.lookupMember` silently falls back to `any`).
			info = new ClassInfo(key, -1, decl, TS.RefType(name, typeArgs));
			info.declScope	= declScope;
			info.homeModule	= homeModule;
			classes.set(key, info);
		}

		const decl = info.decl;

		// A constructor with its own explicit 'return' overrides `this` entirely (a scalar or array result, never a struct) and must never get a struct type
		// index, not even an unused placeholder (a self-referential field would then point at a struct nothing constructs). Pre-scanned before any field
		// type resolves, so the field loop below already knows whether to allocate that placeholder; `checkerTypeOf` is the checker's own inference, not this file's `typeOf`/`ensureClass`.
		let returnType: Type | undefined;
		for (const m of decl.body as TS.ClassMember[]) {
			if (m.type === 'method' && m.key === 'constructor' && m.body) {
				const last = m.body[m.body.length - 1];
				if (last?.type === 'return' && last.argument)
					returnType = checkerTypeOf(unwrapAs(last.argument), m.scope as Scope);
				break;
			}
		}

		// Resolved *before* this class's own `typeIndex` is allocated: wasm-GC requires a `sub` type's declared supertype to be a *lower* type-section index
		// than itself (a supertype is a validation-time relationship, unlike an ordinary field reference, which may forward-reference within the same rec group).
		// This guarantees `superInfo.typeIndex < info.typeIndex` however deep the chain goes.
		// Real regression: a 3-level chain (`C extends B extends A`) fails to load with "forward-declared supertype" if the superclass is resolved
		// after this class's own placeholder -- resolving `C`'s superclass then recurses into `B`'s and `A`'s, giving `A` the *highest* index.
		// Seeding `info.fields`/`fieldIndex` here also lets `addField`'s redeclaration guard see inherited fields and keeps the supertype's fields
		// first, as the exact prefix wasm-GC struct subtyping requires.
		// Doesn't reopen the self-reference case: a field of this class's *own* type resolves later, in the per-member loop below, after the
		// placeholder exists; this block resolves only ancestors.
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
			info.typeIndex = typeof result === 'string' ? -1 : types.array(result.arr);
		} else {
			// How an instance is physically represented (struct vs. array) is the separate, towasm-only `thisWtype`, allocated with a real `typeIndex`
			// before any of *this* class's own field types resolve, so a reentrant `ensureClass` for this same `key` finds `typeIndex` real and
			// short-circuits instead of recursing (see `ensureObjectShape`'s identical comment). The superclass is already resolved, so this
			// index is the largest in the chain so far, never a forward reference.
			info.thisWtype = { ref: key };
			info.typeIndex = types.add({ kind: 'struct', fields: [] });
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

		// `decl.body`'s declared element type (`JS.ClassMember<Type>`) has no `index_signature` variant -- only `TS.ClassMember` adds it, and `decl`
		// is always parsed by ts-parser.ts, so a real index-signature member can appear and is widened to what is actually parsed, not narrowed by
		// which shared interface declared `body`.
		// A field's type resolves in the class's OWN module: an un-annotated field takes its type from the constructor or initializer, which may
		// name things only that file declares, and `T.lookupMember(thisTsType, ...)` needs the class's own name resolvable -- it isn't in an
		// importer that only ever wrote `C.Output`.
		const homeScope = info.declScope ?? libGlobal;
		for (const m of decl.body as TS.ClassMember[]) {
			try {
				if (m.type === 'field'/* && !hasMod(m, 'static')*/) {
					if (typeof m.key !== 'string')
						throw `computed field names in '${name}' are not supported`;
					if (isAsm(m.value))
						inlineDecls.push({ key: m.key, value: m.value! });
					else if (!m.modifiers?.includes('static'))
						// Neither an annotation nor an initializer (`opts;`): the type lives only in the constructor's `this.opts = ...`,
						// which `classShapes` already infers -- ask the checker for the member rather than re-deriving it from the AST here.
						addField(info, m.key, m.typeAnnotation ?? (m.value ? checkerTypeOf(m.value, homeScope) : T.lookupMember(info.thisTsType, m.key, homeScope)), !m.value && hasMod(m, 'optional'));

				} else if (m.type === 'method') {
					// A computed name with a static spelling (`[Symbol.iterator]`, via `T.memberKey`) is registered under it:
					// the iteration protocol calls it by that name. A truly dynamic one has no name to call it by.
					const key = T.memberKey(m.key);
					if (key !== undefined) {
						const value = isAsmMethod(m);
						if (value) {
							inlineDecls.push({ key, value, typeParams: m.typeParams?.map(tp => tp.name) });
						} else {
							addMethod(key, m);
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
				throw new W.Error(e as any, m).inModule(info.homeModule ?? '.');
			}
		}

		// An implicit constructor, as real TS synthesizes one: empty for a base class, and for a derived class the base's
		// own parameter list forwarded through `super(...)` (the real list, not the spread `super(...args)` this back end does not support).
		// Without it, `class A { x = 5 }` and `class B extends A {}` failed with "needs an explicit constructor" once instantiated.
		if (!info.methodDecls.has('constructor')) {
			const superCtor = info.superClass?.methodDecls.get('constructor');
			const params	= superCtor?.length === 1 ? superCtor[0].params : [];
			addMethod('constructor', {
				type:	'method',
				key:	'constructor',
				params,
				body:	info.superClass
					? [JS.ExprStmt(JS.Call({ type: 'super' } as Expr, params.map(p => Identifier(p.key as string))))]
					: [],
			} as unknown as MethodMember);
		}

		// The pre-scan above already fixed `thisWtype`/`typeIndex`; the ordinary struct case only patches its real field list into the placeholder registered earlier.
		if (!returnType) {
			addExpandoFields(info, name);
			types.set(info.typeIndex, {
				final:		!everExtended.has(name),
				supertypes: info.superClass ? [info.superClass.typeIndex] : [],
				type: {
					kind: 'struct',
					fields: info.fields.map(f => ({ type: toValType(f.wtype), mut: true }))
				}
			});
		}

		const defines: Record<string, string|number> = {this: info.typeIndex};
		if (typeof info.thisWtype === 'object' && 'arr' in info.thisWtype)
			defines.elem = info.thisWtype.arr;

		if (decl.typeParams && typeArgs) {
			decl.typeParams.forEach((p, i) => {
				const t = typeArgs[i];
				if (t.type === 'ref' && T.WASM_PSEUDO_TYPES.has(t.name)) {
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
				inlineMethods.set(i.key, makeAsm(i.value, { typeOf, typeIndexOf: w => typeof w === 'object' && 'arr' in w ? types.array(w.arr) : undefined }, defines, i.typeParams));
			} catch (err) {
				throw new W.Error(err as any, i.value).inModule(info.homeModule ?? '.');
			}
		}

		if (inlineMethods.size)
			info.inlineMethods = inlineMethods;

		return info;
	}

	// Real, general support for `Object.defineProperty(target, key, {value, ...})` when `key` isn't a declared field
	// on `target`'s class: a wasm-GC struct can't gain a field at runtime, so this is modeled as real inheritance --
	// one synthesized subclass of the *plain* base class (`ensureClassExtension` is keyed by, and only ever called
	// with, it -- never the extended form itself), never a name-specific hack or a universal field on every class.
	// It carries a real field per statically-enumerable key ever `defineProperty`'d onto any value of the class
	// anywhere in the program (unioned across every such site, boxed `any` since each call site's own `value` has its
	// own type), or a `Map<string, any>` catch-all once any key is not a compile-time literal (`pendingExtensions`'s
	// comment). `everExtended.add(base.name)` must run before `base`'s struct type is finalized -- `ensureGenericFunc`'s
	// hook (which runs before any type argument can reach `ensureClass`) is the fast path but insufficient, since
	// `base` may already be finalized through an earlier reference (found the hard way: `const p: Point = {...}`
	// before the generic call needing it); patched retroactively below as a safety net for exactly that case.

	// Emits a constructor body statement-by-statement, except a `super(...)` call is *inlined*: the superclass's body
	// runs right there against the same `this` (one physical allocation for the whole hierarchy -- see `ensureClass`'s
	// field-layout comment). Recurses for a multi-level chain, resolved against each level's own `superClass`.
	function emitCtorStatements(ctor: MethodMember, cls: ClassInfo, ctx: FunctionContext, setField: (field: string, value: Expr) => void): void {
		const params = ctor.params;
		const stmts	= ctor.body!;

		// A parameter property (`constructor(public x: number)`) has no `this.x = x` statement in `stmts`: real TS synthesizes it and
		// runs it *before* any class-level field initializer, even one textually declared above the constructor (verified against
		// real TS output; `y = this.x + 1` needs `x` assigned first). Only `ensureCtor`'s scalar-only `struct.new_default` path
		// reaches here; an object-typed field forces the explicit-collection path, which already assigns parameter properties
		// itself (`ensureCtor`'s own `setField` loop over `params`).
		const emitParamPropertyInits = () => {
			for (const p of params) {
				if (hasMod(p, 'public') || hasMod(p, 'private') || hasMod(p, 'protected'))
					setField(p.key as string, Identifier(p.key as string));
			}
		};
		// A class-level field initializer (`tag: number = 99`) isn't in the constructor's `body`; it is synthesized as `this.field = value`
		// after `super(...)` (if any) and before the rest of this constructor's body, matching real JS/TS order. Only `ensureCtor`'s
		// scalar-only `struct.new_default` path reaches here; the explicit-collection path's own `initField` already does this.
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
				const superCtor = resolveOverload(`${superClass.name}'s constructor`, superDecls, call.arguments, ctx.scope);
				if (!superCtor.body)
					throw `needs a body (overload signatures are not supported)`;

				// Binds the base ctor's param names to this call's arguments as ordinary `var_decl`s (reusing the local-declaration path, destructuring desugaring included).
				// The nested scope closes once the base body has run, matching real TS: those params aren't visible to the rest of *this* ctor.
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
			// An ordinary `this.field = value` in the constructor body is routed through `setField` like the two synthesized sources
			// above -- required for an object-typed field (`this.inner = new Other(...)`), whose value must be collected before
			// `struct.new`; `setField` itself (see `ensureCtor`) knows whether this is still mid-collection or `this` already exists.
			// Gated on `cls.fieldIndex` (this constructor's own level's data fields only, not an inherited one from a *further*
			// subclass, matching real TS scoping), so an accessor write (`this.someSetter = x`) falls through to `emitStmt` and is
			// caught by `case 'this'`'s guard if attempted too early -- calling a setter needs a real `this` receiver.
			if (st.type === 'expression' && st.expression.type === 'assign' && !st.expression.operator && st.expression.target.type === 'member' && st.expression.target.object.type === 'this' && cls.fieldIndex.has(st.expression.target.property)) {
				setField(st.expression.target.property, st.expression.value);
			} else {
				emitStmt(st, ctx);
			}
		}
	}

	function ensureCtor(cls: ClassInfo, args: Expr[], callerCtx: FunctionContext): FuncInfo {
		const decls = cls.methodDecls.get('constructor');
		if (!decls)
			throw `class '${cls.name}' needs an explicit constructor`;

		return ensureCtorDecl(cls, resolveOverload(`${cls.name}'s constructor`, decls, args, callerCtx.scope));
	}

	// One constructor overload's compiled function, however it was chosen: by a call's arguments, or as `adoptingDecl`'s.
	function ensureCtorDecl(cls: ClassInfo, ctor: MethodMember): FuncInfo {
		const decls			= cls.methodDecls.get('constructor')!;
		const key			= decls.length > 1 ? `${cls.name}.constructor#${decls.indexOf(ctor)}` : `${cls.name}.constructor`;
		const existing		= funcs.get(key);
		if (existing)
			return existing;

		const params		= resolveParams(ctor.params, cls.declScope ?? libGlobal);
		if (ctor.rest?.typeAnnotation)
			params.push({key: ctor.rest.key, wtype: restParamWtype(ctor.rest.typeAnnotation)!, tsType: ctor.rest.typeAnnotation});

		//const thisWtype	= cls.thisType;
		const thisWtype		= cls.thisWtype!;

		const {funcIndex, typeIndex} = types.func(toParams2(params), toResults(thisWtype));
		const info: FuncInfo = { params: params.map(r => r.wtype), result: thisWtype, funcIndex, typeIndex, defaults: defaultsWithImplicitUndefined(ctor.params), resolvedParams: params, hasRest: !!ctor.rest?.typeAnnotation };
		funcs.set(key, info);

		// A constructor's own `return;` never carries a value (real TS syntax already enforces that at the checker level) -- it just means
		// "stop early, `this` is the result", the same value every real exit already emits via `ctx.ctorThis`.
		const ctorOnReturn: ReturnHandler = {
			wtype: () => undefined,
			emit(ctx, argument) {
				if (argument)
					throw 'a constructor cannot return a value';
				ctx.emit(I.local.get(ctx.ctorThis!.index), I.return);
			},
		};

		worklist.push(W.withCatch(() => {
			// The DECLARING module's own scope (`ensureClass`'s `declScope`/`homeModule`), not the entry's -- a ctor body naming something only its own file
			// declares (a non-exported module-level const, a sibling class) must resolve it there, the same pairing `compileFunc` gives a top-level function;
			// `libGlobal` remains the fallback for a lib class or a synthesized shape. `declScope` is whatever type reference first built this class, which
			// need not be its own module (a helper `use(h: Holder)` in another file), and then its body could not see its own imports at all -- an
			// `import * as TS` call inside it read as an unresolved identifier.
			const ctx		= new FunctionContext(key, new Scope(moduleScopeOf(cls.homeModule) ?? cls.declScope ?? libGlobal), plainReturn(thisWtype), cls, cls.homeModule);
			ctx.widenedTypes = collectRangeWidenings(ctor.body!, ctx.scope);
			ctx.ownBody = ctor.body!;
			ctx.declareParams(params).forEach(st => emitStmt(st, ctx));
			// This constructor supplies `this` directly via its own return value (`ctorReturnsValue`)
			// `cls`'s own `thisWtype`/`typeIndex` already say so; ordinary statement compilation does the right thing once `ctx.ctorThis` is unset.
			const last = ctor.body?.at(-1);
			if (last?.type === 'return' && last.argument) {
				emitStmts(ctor.body!, ctx);

			// Defaultability is a whole-struct-type property, not per-field -- one object-typed field forces the collect-then-`struct.new` path for the whole class.
			} else if (cls.fields.some(f => typeof f.wtype !== 'string')) {

				// An optional field is never *required* to be assigned, but it still needs a real value for the single `struct.new` below: seed it with its
				// own null default up front (`addField` already forced its wtype nullable) and leave it out of `remaining`.
				const remaining	= new Set(cls.fields.filter(f => !f.optional).map(f => f.name));
				const values	= new Map<string, W.Local>();
				ctx.ctorFields	= values;
				// No real local for `this` yet, but `checkerTypeOf` still needs its static type to resolve a chained read like `this.p.x` (`p` already
				// collected) down to `p`'s own class -- the same scope-only registration `declareCaptured` uses for closure captures.
				ctx.scope.addValue('this', cls.thisTsType);

				for (const f of cls.fields) {
					if (f.optional) {
						const local = ctx.declareLocal(`$field$${f.name}`, f.wtype);
						ctx.emitDefaultValue(f.wtype, types, toValType);
						ctx.emit(I.local.set(local.index));
						values.set(f.name, local);
					}
				}

				const materializeThis = () => {
					for (const f of cls.fields)
						ctx.emit(I.local.get(values.get(f.name)!.index));
					ctx.emit(I.struct.new(cls.typeIndex));
					// PINNED: `this` belongs to the constructor, not to whatever scope happened to be open when the last field landed -- a base class with a
					// param-property constructor completes it inside the `super(...)` call's own scope, and closing that took `this` with it, so any
					// `this.field = ...` after `super(...)` failed with "unresolved identifier 'this'".
					const thisLocal = ctx.declareValue('this', thisWtype, cls.thisTsType, true);
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
					// `this` genuinely exists (every field collected earlier, or this is a reassignment): an ordinary field write, same as the scalar-only path's `setField`.
					// Only reachable via `emitCtorStatements`'s explicit-`this.field=value` interception -- a param property/field initializer always precedes an empty `remaining`.
					if (!ctx.ctorFields) {
						emitStmt({
							type: 'expression',
							expression: Assign<Expr, JS.assignableOps>(Member<Expr>({ type: 'this' }, field), value),
						}, ctx);
						return;
					}
					const wtype = cls.fields[cls.fieldIndex.get(field)!].wtype;
					// An optional field already holds its seeded default, and a field may be assigned twice before `this` exists: one local.
					const local = values.get(field) ?? ctx.declareLocal(`$field$${field}`, wtype);
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
					expression: Assign<Expr, JS.assignableOps>(Member<Expr>({ type: 'this' }, field), value),
				}, ctx));
				ctx.emit(I.local.get(ctx.ctorThis!.index), I.return);
			}

			info.body = ctx.toFuncBody(ctor.params.length + (ctor.rest ? 1 : 0), toValType);
		}, key));
		return info;
	}

	// `args`/`callerCtx` pick the overload when `name` has more than one real body (`resolveOverload`); safe to pass an empty probe list for the one-body case.
	// `typeArgs`: a call-site type argument list for a generic *method*'s own type params (`obj.map<number>(f)`), layered on `owner`'s already-concrete class params.
	function ensureMethod(owner: ClassInfo, name: string, args: Expr[], callerCtx: FunctionContext, typeArgs?: Type[]): FuncInfo | undefined {
		const decls		= owner.methodDecls.get(name);
		const fullName	= `${owner.name}.${name}`;
		// Not overridden by `owner` itself: delegate straight to the ancestor's own compiled function (cached under *its* key, e.g. `A.greet`, not `owner.name`'s) rather
		// than recompiling a duplicate. Sound and free: wasm-GC struct subtyping (`ensureClass`'s own `supertypes`) makes a `(ref Derived)` value directly callable
		// wherever `(ref A)` is declared, no cast needed -- this is why a non-overridden inherited method stays a single, plain `call`.
		if (!decls)
			return owner.superClass && ensureMethod(owner.superClass, name, args, callerCtx, typeArgs);
		let decl = resolveOverload(fullName, decls, args, callerCtx.scope, typeArgs);
		// Qualified so it can share `funcs` with plain top-level functions (bare identifiers can't contain
		// '.') without colliding; only suffixed when there's a real overload set to disambiguate.
		let key = decls.length > 1 ? `${fullName}#${decls.indexOf(decl)}` : fullName;

		// A generic method's own type params (beyond `owner`'s already-resolved class-level ones, e.g. `class Box<T> { map<U>(f: (t: T) => U): Box<U> {...} }`): the same
		// composite-key/substitution shape `ensureGenericFunc` uses for a top-level generic function. `decl` is `owner.methodDecls`' copy, with the class's `T` already
		// substituted (from `ensureClass`), so only `U` remains; a `MethodMember` isn't a `walk` root node, so signature pieces go through `T.substituteType` individually
		// (as checker.ts's `instantiate` does) and the body through `substituteTypeParams` (a plain `Statement[]`, which `walk` does accept directly).
		if (decl.typeParams?.length) {
			const map = inferCallTypeArgs(decl.typeParams, decl.params, args, typeArgs, callerCtx, undefined, undefined, decl.rest);
			key		= genericKey(key, decl.typeParams, map, global);
			decl	= {
				...decl,
				typeParams: undefined,
				params:		decl.params.map(p => p.typeAnnotation ? { ...p, typeAnnotation: T.substituteType(p.typeAnnotation, map) } : p),
				rest:		decl.rest?.typeAnnotation ? { ...decl.rest, typeAnnotation: T.substituteType(decl.rest.typeAnnotation, map) } : decl.rest,
				returnType: decl.returnType ? T.substituteType(decl.returnType, map) : decl.returnType,
				body:		decl.body ? substituteTypeParams(map).statements(decl.body) : decl.body,
			};
		}

		const existing = funcs.get(key);
		if (existing)
			return existing;

		// A `this`-typed return/param (`sort(): this`) means "whatever `owner`'s own concrete type is": the checker resolves it lazily (see `T.substituteThisType`),
		// but codegen needs a real `WasmType` up front, so it is substituted in here before `typeOf` sees it; a no-op when neither mentions `this`.
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

		const params		= resolveParams(decl.params, owner.declScope ?? libGlobal);
		if (decl.rest?.typeAnnotation)
			params.push({key: decl.rest.key, wtype: restParamWtype(decl.rest.typeAnnotation)!, tsType: decl.rest.typeAnnotation});

		const isStatic		= decl.modifiers?.includes('static');
		const reassignsThis = !isStatic && assignsToThis(decl.body);
		const thisWtype		= owner.thisType;
		const {funcIndex, typeIndex} = types.func(
			isStatic		? toParams2(params) : [{ type: toValType(thisWtype), id: 'this' }, ...toParams2(params)],
			reassignsThis	? [...toResults(result), toValType(thisWtype)] : toResults(result)
		);

		const info: FuncInfo = { params: params.map(r => r.wtype), result, funcIndex, typeIndex, defaults: defaultsWithImplicitUndefined(decl.params), resolvedParams: params, hasRest: !!decl.rest?.typeAnnotation, reassignsThis };
		funcs.set(key, info);
		worklist.push(W.withCatch(() => {
			// See `ensureCtor`'s own note -- a method body resolves against its class's declaring module too.
			const ctx	= new FunctionContext(key, new Scope(moduleScopeOf(owner.homeModule) ?? owner.declScope ?? libGlobal), plainReturn(result, decl.returnType as Type | undefined), owner, owner.homeModule);
			if (!isStatic)
				ctx.declareValue('this', thisWtype, owner.thisTsType);
			if (reassignsThis) {
				// A `reassignsThis` method's own (possibly just-updated) `this` rides along as one more wasm-level result on every return, on top of its
				// ordinary declared result -- see `assignsToThis`'s own comment for why a body doing this is this compiler's signal to compile it this way.
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
			emitStmts(decl.body!, ctx);
			ctx.emitTrailingUnreachable(result);
			info.body = ctx.toFuncBody((isStatic ? 0 : 1) + params.length, toValType);
		}, key));
		return info;
	}

	// Every owner (boxed `number`/`boolean`, plus every class ever reached) declaring a real, non-`this`-reassigning, zero-argument `name` -- the candidate set a
	// dynamic (`any`) dispatch of `name()` cascades over, deduped by physical `heapType`; `!assignsToThis` excludes a method with no boxed-`any` write-back target (`Array<T>.push`/etc).
	function findAnyDispatchCandidates(name: string, argTs: Type[], ctx: FunctionContext): { heapType: number; isBoxedScalar: boolean; funcInfo: FuncInfo }[] {
		const found = new Map<number, { heapType: number; isBoxedScalar: boolean; funcInfo: FuncInfo }>();
		const probe = (owner: ClassInfo | undefined, heapType: number, isBoxedScalar: boolean) => {
			if (owner && !found.has(heapType) && owner.methodDecls.get(name)?.find(d => d.body && !d.rest && !assignsToThis(d.body) && T.argsFit(T.FixSig(d, T.ANY), argTs, ctx.scope))) {
				const funcInfo = ensureMethod(owner, name, [], ctx);
				if (funcInfo)
					found.set(heapType, { heapType, isBoxedScalar, funcInfo });
			}
		};
		probe(builtinTypeOwner('number'), types.box('f64'), true);
		probe(builtinTypeOwner('boolean'), types.box('i32'), true);
		// A string and a `RawArray` are bare wasm arrays with no struct of their own. An `Array<T>` is a struct (it owns a
		// `RawArray`) and the class loop below covers it -- probing its storage AS an `Array` dispatched on the wrong type.
		probe(builtinTypeOwner('string'), types.array('i16'), false);
		for (const [kind, elem] of [['f64', T.NUMBER], ['ref', T.ANY]] as const) {
			if (types.hasArray(kind))
				probe(ensureClass('RawArray', [elem]), types.array(kind), false);
		}
		for (const cls of classes.values()) {
			if (cls.typeIndex !== -1)
				probe(cls, cls.typeIndex, false);
		}
		return [...found.values()];
	}

	// `x[k]` where `x`'s static type is `any` and `k` is a computed string -- the dynamic-key sibling of `ensureAnyField`. One shared function per
	// direction, since no static name bounds the candidates: a `ref.test` cascade over every class with fields, each arm chaining that class's own names -- which is what a known receiver's `x[k]` compiles to.
	function ensureAnyKey(kind: 'get' | 'set'): FuncInfo {
		const existing = anyKeyFuncs.get(kind);
		if (existing)
			return existing;

		const keyWtype	= typeOf(T.STRING)!;
		const result: W.Type = kind === 'get' ? W.REF_ANY_NULLABLE : 'void';
		const params	= [{ key: 'recv', wtype: W.REF_ANY, tsType: T.ANY }, { key: 'key', wtype: keyWtype, tsType: T.STRING },
			...(kind === 'set' ? [{ key: 'value', wtype: W.REF_ANY_NULLABLE, tsType: T.ANY }] : [])];
		const { funcIndex, typeIndex } = types.func(toParams2(params), toResults(result));
		const info: FuncInfo = { params: params.map(x => x.wtype), result, funcIndex, typeIndex };
		anyKeyFuncs.set(kind, info);
		funcs.set(`<any key ${kind}>`, info);

		lateWorklist.push(() => {
			const dctx	= new FunctionContext(`key_${kind}`, new Scope(libGlobal), plainReturn(result), undefined);
			const recv	= dctx.declareLocal('$recv', W.REF_ANY);
			const keyId: Expr = Identifier('$key');
			const valId: Expr = Identifier('$value');
			dctx.declareValue('$key', keyWtype, T.STRING);
			if (kind === 'set')
				dctx.declareValue('$value', W.REF_ANY_NULLABLE, T.ANY);

			// Deduped by physical heap type, as the static-name cascades are: several owners can share one.
			const seen = new Set<number>();
			const candidates: { heap: wasm.HeapType; arm: () => void }[] = [];
			for (const cls of classes.values()) {
				if (cls.typeIndex === -1 || !cls.fields.length || !cls.thisTsType || seen.has(cls.typeIndex))
					continue;
				seen.add(cls.typeIndex);
				// Its own prefix: the arms' assignments name temps `$obj$<counter>` in this same context.
				const objName		= `$keyobj$${cls.typeIndex}`;
				const objId: Expr	= Identifier(objName);
				const isKey			= (f: string): Expr => Binary<Expr, '==='>('===', keyId, Literal(f));
				candidates.push({ heap: cls.typeIndex, arm: () => {
					const obj = dctx.declareValue(objName, cls.thisWtype!, cls.thisTsType!);
					dctx.emit(I.local.get(recv.index), I.ref.cast(cls.typeIndex), I.local.set(obj.index));
					if (kind === 'get')
						emitAs(cls.fields.reduce<Expr>((alternate, f) => Conditional<Expr>(
							isKey(f.name),
							JS.Member(objId, f.name),
							alternate,
						), Identifier('undefined')), dctx, W.REF_ANY_NULLABLE);
					else
						cls.fields.forEach(f => emitStmt({ type: 'if',
							test:		isKey(f.name),
							consequent:	JS.ExprStmt(Assign<Expr, never>(JS.Member(objId, f.name), valId)),
						} as Stmt, dctx));
				} });
			}

			// A key no candidate declares reads `undefined`, exactly as JS does -- unlike the static-name cascades, whose
			// name came from source and so must exist somewhere. A write still traps: there is no honest place to put it.
			function buildArm(i: number): wasm.Instr[] {
				if (i >= candidates.length) {
					if (kind === 'set')
						return [I.unreachable];
					dctx.emitDefaultValue(W.REF_ANY_NULLABLE, types, toValType);
					return dctx.swapOut();
				}
				const c = candidates[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(c.heap));
				const _cond = dctx.swapOut();
				c.arm();
				return [..._cond, I.if(kind === 'get' ? toValType(W.REF_ANY_NULLABLE) : undefined, dctx.swapOut(), buildArm(i + 1))];
			}
			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(params.length, toValType);
		});
		return info;
	}

	// `x.name` where `x`'s static type is genuinely `any` -- the FIELD sibling of `ensureAnyDispatch`, and the same `ref.test` cascade `ensureUnionFieldDispatch` runs
	// over a union, just over "every class ever reached" instead of a bounded member set (`guard()`'s own `set.has(node.type)` is the shape). Always yields `REF_ANY`:
	// the candidates' own field types legitimately differ, and every consumer of a dynamic read already has to `coerceTop` its way back out of one.
	function ensureAnyField(name: string): FuncInfo {
		const existing = anyFieldFuncs.get(name);
		if (existing)
			return existing;

		// A field that was never written reads `undefined`, so the result is nullable -- as `any` itself is.
		const { funcIndex, typeIndex } = types.func(toParams2([{key: 'recv', wtype: W.REF_ANY, tsType: T.ANY}]), toResults(W.REF_ANY_NULLABLE));
		const info: FuncInfo = { params: [W.REF_ANY], result: W.REF_ANY_NULLABLE, funcIndex, typeIndex };
		anyFieldFuncs.set(name, info);
		funcs.set(`<any field>.${name}`, info);

		lateWorklist.push(() => {
			const dctx = new FunctionContext(`field_${name}`, new Scope(libGlobal), plainReturn(W.REF_ANY_NULLABLE), undefined);
			const recv = dctx.declareLocal('$recv', W.REF_ANY);

			// Deduped by physical HEAP type, not by `ClassInfo` -- several owners can share one, and a
			// repeated arm is dead code.
			const seen = new Set<wasm.HeapType>();
			const candidates: { heap: wasm.HeapType; read: () => void }[] = [];
			const probe = (cls: ClassInfo | undefined, heap: wasm.HeapType | undefined) => {
				if (!cls || heap === undefined || seen.has(heap))
					return;
				const idx = cls.fieldIndex.get(name);
				if (idx !== undefined && cls.typeIndex !== -1) {
					seen.add(heap);
					candidates.push({ heap, read: () => {
						emitFieldRead(cls, idx, dctx);
						coerceTop(cls.fields[idx].wtype, dctx, W.REF_ANY_NULLABLE);
					} });
				} else if (cls.getterNames?.has(name)) {
					const sig = methodSig(cls, accessorKey('get', name), dctx);
					if (sig) {
						// Boxed by the member's DECLARED type, not the physical width the getter's body produces: `String.length` is `get length(): number` over an `array.len`,
						// so it yields `u32`; boxed as-is that is an i32 box, while every consumer reads a `number` back by casting to the f64 box, and that cast traps --
						// anything entering an `any` slot must be in its logical type's canonical form. `T.lookupMember`, not the decl: an `__asm` accessor keeps no declaration
						// at all (it becomes an `inlineMethods` entry, and `String.length` is exactly one).
						const declared	= cls.thisTsType && T.lookupMember(cls.thisTsType, name, dctx.scope);
						const canonical	= (declared && typeOf(declared)) || sig.result;
						const want		= canonical === 'void' ? sig.result : canonical;
						seen.add(heap);
						candidates.push({ heap, read: () => {
							emitMethodCall(cls, accessorKey('get', name), [], dctx);
							coerceTop(sig.result, dctx, want);
							coerceTop(want, dctx, W.REF_ANY_NULLABLE);
						} });
					}
				}
			};

			// The builtin owners FIRST, exactly as `findAnyDispatchCandidates` seeds `number`/`boolean`: none of them is ever in `classes` unless reached as a class, and
			// a `string` in an `any` slot is the commonest dynamic receiver -- `e.message.length` reported "no reachable class declares a field 'length'" only because
			// `String.length` is a getter on a class with no struct of its own, so neither this loop nor the `typeIndex !== -1` test below could ever see it.
			probe(builtinTypeOwner('string'), types.array('i16'));
			probe(builtinTypeOwner('bigint'), types.array('i32'));
			probe(builtinTypeOwner('number'), types.box('f64'));
			probe(builtinTypeOwner('boolean'), types.box('i32'));
			// Bare storage (a `RawArray`) in an `any` slot has no struct of its own, so the class loop below never sees it; an
			// `Array<T>` IS a struct and is covered there. Gated on the storage type ALREADY existing -- else no such value can.
			for (const [kind, elem] of [['f64', T.NUMBER], ['ref', T.ANY]] as const) {
				if (types.hasArray(kind))
					probe(ensureClass('RawArray', [elem]), types.array(kind));
			}
			for (const cls of classes.values()) {
				// `-1` is `ensureClass`'s no-struct-of-its-own sentinel, but not untestable: an array-backed class (`Array<number>` is `arr:f64`, a typed-array view its
				// own element kind) has a real heap type to `ref.test` against; only a scalar-backed owner has none, and the boxed probes above cover those.
				const w = cls.thisWtype;
				probe(cls, cls.typeIndex !== -1 ? cls.typeIndex
					: w && typeof w !== 'string' && ('arr' in w || 'typeIndex' in w) ? heapTypeIndexOf(w)
					: undefined);
			}
			// Gated like the arrays: with no closure type, no function value can be in an `any` slot.
			const closureField = CLOSURE_FIELDS.get(name);
			if (closureField !== undefined && closureTypes.size) {
				const base = types.closureBase();
				candidates.push({ heap: base, read: () => {
					dctx.emit(I.struct.get(base, closureField));
					coerceTop('u32', dctx, 'f64');
					coerceTop('f64', dctx, W.REF_ANY_NULLABLE);
				} });
			}
			if (!candidates.length)
				throw `no reachable class declares a field '${name}' -- a dynamic read on 'any' needs at least one real candidate`;

			// A receiver matching nothing is a real object that simply doesn't declare this field, and JS defines that read as `undefined` -- which this
			// function's own nullable result already represents. A NULL receiver is the separate case JS throws on, and keeps trapping.
			const missing: wasm.Instr[] = [
				I.local.get(recv.index), I.ref.is_null,
				I.if(toValType(W.REF_ANY_NULLABLE), [I.unreachable], [I.ref.null(heapTypeIndexOf(W.REF_ANY_NULLABLE))]),
			];
			function buildArm(i: number): wasm.Instr[] {
				if (i >= candidates.length)
					return missing;
				const c = candidates[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(c.heap));
				const _cond = dctx.swapOut();
				dctx.emit(I.local.get(recv.index), I.ref.cast(c.heap));
				c.read();
				return [..._cond, I.if(toValType(W.REF_ANY_NULLABLE), dctx.swapOut(), buildArm(i + 1))];
			}
			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(1, toValType);
		});
		return info;
	}

	// `x.name = v` where `x`'s static type is a UNION or `any` -- the WRITE sibling of `ensureAnyField`, and the same `ref.test` cascade. Only struct-backed
	// candidates: a field write needs a real `struct.set` target, so a boxed scalar or an array-backed owner is not one (neither can gain a field, and neither is ever
	// an expando receiver -- `collectExpandoFields` only ever names a `ref`). The value arrives boxed as `REF_ANY`, which is what every expando field holds.
	function ensureAnyFieldWrite(name: string): FuncInfo {
		const existing = anyFieldWriteFuncs.get(name);
		if (existing)
			return existing;

		const { funcIndex, typeIndex } = types.func(toParams2([
			{ key: 'recv', wtype: W.REF_ANY, tsType: T.ANY },
			{ key: 'value', wtype: W.REF_ANY_NULLABLE, tsType: T.ANY },
		]), toResults('void'));
		const info: FuncInfo = { params: [W.REF_ANY, W.REF_ANY_NULLABLE], result: 'void', funcIndex, typeIndex };
		anyFieldWriteFuncs.set(name, info);
		funcs.set(`<any field write>.${name}`, info);

		lateWorklist.push(() => {
			const dctx	= new FunctionContext(`field_set_${name}`, new Scope(libGlobal), plainReturn('void'), undefined);
			const recv	= dctx.declareLocal('$recv', W.REF_ANY);
			const value	= dctx.declareLocal('$value', W.REF_ANY_NULLABLE);

			const seen = new Set<wasm.HeapType>();
			const candidates: { heap: wasm.HeapType; typeIndex: number; index: number; wtype: W.Type; cls: ClassInfo }[] = [];
			for (const cls of classes.values()) {
				const idx = cls.fieldIndex.get(name);
				if (idx === undefined || cls.typeIndex === -1 || seen.has(cls.typeIndex))
					continue;
				seen.add(cls.typeIndex);
				candidates.push({ heap: cls.typeIndex, typeIndex: cls.typeIndex, index: idx, wtype: cls.fields[idx].wtype, cls });
			}
			if (!candidates.length)
				throw `no reachable class declares a field '${name}' -- a dynamic write on 'any' needs at least one real candidate`;

			// A receiver matching nothing traps, same as the read cascade: there is no honest place to put
			// the value, and silently dropping a write is the one outcome that could corrupt a program.
			function buildArm(i: number): wasm.Instr[] {
				if (i >= candidates.length)
					return [I.unreachable];
				const c = candidates[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(c.heap));
				const _cond = dctx.swapOut();
				// Through the candidate's own receiver type, so a key with a setter (`emitFieldWrite`) calls it here too.
				const obj = dctx.declareLocal(`$wobj$${c.typeIndex}`, c.cls.thisWtype!);
				dctx.emit(I.local.get(recv.index), I.ref.cast(c.heap), I.local.set(obj.index));
				emitFieldWrite(c.cls, c.index, obj.index, value.index, W.REF_ANY_NULLABLE, dctx);
				return [..._cond, I.if(undefined, dctx.swapOut(), buildArm(i + 1))];
			}
			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(2, toValType);
		});
		return info;
	}

	// `'k' in x` where `x`'s static type is genuinely `any`: with no runtime property metadata, "has `k`" is exactly "is one of the classes that declare `k`" -- a
	// `ref.test` over every reachable one, OR-ed. A method or getter counts (JS finds a prototype member too), and so does an OPTIONAL field, for the same reason the
	// union case above gives. Null fails every test and so answers `false`, which is what `k in undefined` should be (real JS throws; there is no throwing to do here).
	// Shared function + `lateWorklist` for the same reason `ensureAnyDispatch` needs them: the candidate set is every class ever reached, final only once `worklist` has drained.
	function ensureAnyIn(name: string): FuncInfo {
		const existing = anyInFuncs.get(name);
		if (existing)
			return existing;

		const { funcIndex, typeIndex } = types.func(toParams2([{key: 'recv', wtype: W.REF_ANY_NULLABLE, tsType: T.ANY}]), toResults('i32'));
		const info: FuncInfo = { params: [W.REF_ANY_NULLABLE], result: 'i32', funcIndex, typeIndex };
		anyInFuncs.set(name, info);
		funcs.set(`<any in>.${name}`, info);

		lateWorklist.push(() => {
			const dctx = new FunctionContext(`in_${name}`, new Scope(libGlobal), plainReturn('i32'), undefined);
			const recv = dctx.declareLocal('$recv', W.REF_ANY_NULLABLE);
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

	// `Object.keys/values/entries(x)` where `x`'s static type names no field list at all (the `object` keyword, a narrowed `unknown`) or names a class that is extended
	// somewhere: what fields exist is a property of the receiver's REAL runtime type, so this is the same `ref.test` cascade `ensureAnyDispatch`/`ensureVirtualDispatch`
	// already use. Deepest-first for the reason `ensureVirtualDispatch` gives: a subclass instance passes its base's own `ref.test` too, so a shallower arm tested first
	// would answer with the base's shorter field list. Candidates are every reachable STRUCT-backed class; an array-, string- or boxed-scalar-backed one has no struct
	// fields to read and is excluded, and so is `Map`, whose real answer is its own `keys`/`values`/`entries` method returning a `K[]`/`V[]` whose element KIND (`f64` for
	// `Map<number,_>`) has no conversion to this function's single `any[]` result type. Both fall through to the final arm and trap rather than answer with a struct's internal fields.
	function ensureAnyEntries(which: 'entries' | 'keys' | 'values'): FuncInfo {
		const existing = anyEntriesFuncs.get(which);
		if (existing)
			return existing;

		const result = W.ARRAY.ref;
		const { funcIndex, typeIndex } = types.func(toParams2([{key: 'recv', wtype: W.REF_ANY, tsType: T.ANY}]), toResults(result));
		const info: FuncInfo = { params: [W.REF_ANY], result, funcIndex, typeIndex };
		anyEntriesFuncs.set(which, info);
		funcs.set(`<any ${which}>`, info);

		lateWorklist.push(() => {
			const dctx	= new FunctionContext(`any_${which}`, new Scope(libGlobal), plainReturn(result), undefined);
			const recv	= dctx.declareLocal('$recv', W.REF_ANY);
			const depthOf = (c: ClassInfo) => {
				let d = 0;
				for (let p = c.superClass; p; p = p.superClass)
					++d;
				return d;
			};
			const candidates = [...classes.values()]
				.filter(c => c.typeIndex !== -1 && c.decl.name !== 'Map' && typeof c.thisWtype === 'object' && 'ref' in c.thisWtype)
				.sort((a, b) => depthOf(b) - depthOf(a));

			const buildArm = (i: number): wasm.Instr[] => {
				if (i >= candidates.length)
					return [I.unreachable];
				const c = candidates[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(c.typeIndex));
				const _cond = dctx.swapOut();
				dctx.emit(I.local.get(recv.index), I.ref.cast(c.typeIndex));
				emitEntriesOf(c, which, dctx);
				return [..._cond, I.if(toValType(result), dctx.swapOut(), buildArm(i + 1))];
			};
			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(1, toValType);
		});
		return info;
	}

	// JS `===` when either side is a boxed `any`: a string or boxed primitive compares by VALUE, anything else by
	// identity. Only kinds whose wasm type exists are tested -- a value of an absent kind can't be in the slot.
	let anyStrictEqFunc: FuncInfo | undefined;
	function ensureAnyStrictEq(): FuncInfo {
		if (anyStrictEqFunc)
			return anyStrictEqFunc;
		const param = (key: string) => ({ key, wtype: W.REF_ANY_NULLABLE, tsType: T.ANY });
		const { funcIndex, typeIndex } = types.func(toParams2([param('a'), param('b')]), toResults('i32'));
		const info: FuncInfo = anyStrictEqFunc = { params: [W.REF_ANY_NULLABLE, W.REF_ANY_NULLABLE], result: 'i32', funcIndex, typeIndex };
		funcs.set('<any ===>', info);

		lateWorklist.push(() => {
			const dctx	= new FunctionContext('any_strict_eq', new Scope(libGlobal), plainReturn('i32'), undefined);
			const a		= dctx.declareLocal('$a', W.REF_ANY_NULLABLE);
			const b		= dctx.declareLocal('$b', W.REF_ANY_NULLABLE);
			const arms: { heap: number; compare: wasm.Instr[] }[] = [];
			if (types.hasArray('i16')) {
				const heap = types.array('i16');
				arms.push({ heap, compare: [I.local.get(a.index), I.ref.cast(heap), I.local.get(b.index), I.ref.cast(heap), I.call(ensureMethod(builtinTypeOwner('string')!, 'eq', [], dctx)!.funcIndex)] });
			}
			for (const [kind, eq] of [['f64', I.f64.eq], ['i32', I.i32.eq], ['i64', I.i64.eq]] as const) {
				if (types.hasBox(kind)) {
					const heap = types.box(kind);
					const read = (l: number) => [I.local.get(l), I.ref.cast(heap), I.struct.get(heap, 0)];
					arms.push({ heap, compare: [...read(a.index), ...read(b.index), eq] });
				}
			}
			const buildArm = (i: number): wasm.Instr[] => i >= arms.length
				? [I.local.get(a.index), I.ref.cast('eq', true), I.local.get(b.index), I.ref.cast('eq', true), I.ref.eq]
				: [I.local.get(a.index), I.ref.test(arms[i].heap), I.local.get(b.index), I.ref.test(arms[i].heap), I.i32.and, I.if('i32', arms[i].compare, buildArm(i + 1))];
			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(2, toValType);
		});
		return info;
	}

	// A dynamic-dispatch cascade for a call through a callee whose type is `any` (core.ts `params[0](...)`): the function it holds is known only at run time, so a
	// dispatch per call shape tests it against every closure type the program has, converts each argument to that type's parameter (one the call leaves out must take
	// `undefined`), and the result to what the call wants. None traps. Reserved immediately so call sites can `call` it right away; the body is built by `lateWorklist`,
	// drained only once `worklist` has fully emptied, which is what guarantees the candidate set is final.
	function ensureAnyCallDispatch(argWtypes: W.Type[], want: W.Type): FuncInfo {
		const key = `#call(${argWtypes.map(W.typeKey).join(',')})=>${W.typeKey(want)}`;
		const existing = anyDispatchFuncs.get(key);
		if (existing)
			return existing;

		const { funcIndex, typeIndex } = types.func(toParams2([{ key: 'callee', wtype: W.REF_ANY, tsType: T.ANY },
			...argWtypes.map((wtype, i) => ({ key: `arg${i}`, wtype, tsType: T.ANY }))]), toResults(want));
		const info: FuncInfo = { params: [W.REF_ANY, ...argWtypes], result: want, funcIndex, typeIndex };
		anyDispatchFuncs.set(key, info);
		funcs.set(`<any dispatch>.${key}`, info);
		lateWorklist.push(() => {
			// Only candidates every argument converts to physically: a branch that cannot compile is never the callee of a
			// correct program. `any` on either side boxes or casts; two structs only upcast; closures by the wrapper's own rule.
			const isAnyRef = (w: W.Type) => typeof w !== 'string' && 'ref' in w && w.ref === 'any';
			const kind = (w: W.Type) => typeof w === 'string' ? 'scalar' : 'closure' in w ? 'closure' : 'arr' in w ? `arr:${w.arr}` : 'ref';
			const closureFits = (got: FuncSig, param: FuncSig): boolean => got.params.length <= param.params.length && !!got.hasRest === !!param.hasRest
				&& got.params.every((g, i) => fits(param.params[i], g));
			const fits = (got: W.Type, param: W.Type): boolean => got !== 'void' && param !== 'void' && (W.typeEq(got, param) || isAnyRef(got) || isAnyRef(param)
				|| (kind(got) === kind(param) && (kind(got) === 'scalar' || kind(got).startsWith('arr')
					|| (typeof got !== 'string' && typeof param !== 'string' && 'closure' in got && 'closure' in param && closureFits(got.closure, param.closure))
					|| (typeof got !== 'string' && typeof param !== 'string' && 'ref' in got && 'ref' in param && isSubclassOf(got.ref, param.ref)))));
			// The result too: a callee whose result cannot become what the call wants is never the one a correct program calls.
			const candidates = [...closureTypes.values()].filter(c => !c.sig.hasRest && c.sig.params.length >= argWtypes.length
				&& argWtypes.every((w, i) => fits(w, c.sig.params[i])) && (want === 'void' || fits(c.sig.result, want))
				&& c.sig.params.slice(argWtypes.length).every(p => typeof p !== 'string' && (!!p.nullable || isAnyRef(p))));
			if (!candidates.length)
				throw `no closure type in the program takes ${argWtypes.length} such argument(s) -- a call through 'any' needs at least one real candidate`;
			const dctx = new FunctionContext(key, new Scope(libGlobal), plainReturn(want), undefined);
			const callee = dctx.declareLocal('$callee', W.REF_ANY);
			const argLocals = argWtypes.map((w, i) => dctx.declareLocal(`$arg$${i}`, w));

			function buildArm(i: number): wasm.Instr[] {
				if (i >= candidates.length)
					return [I.unreachable];
				const c = candidates[i];
				dctx.emit(I.local.get(callee.index), I.ref.test(c.structTypeIndex));
				const _cond = dctx.swapOut();
				const held = dctx.temp(`$closure$${dctx.tempCounter++}`, { typeIndex: c.structTypeIndex, nullable: false });
				dctx.emit(I.local.get(callee.index), I.ref.cast(c.structTypeIndex), I.local.tee(held), I.struct.get(c.structTypeIndex, 1));
				c.sig.params.forEach((p, j) => {
					if (j < argLocals.length) {
						dctx.emit(I.local.get(argLocals[j].index));
						coerceTop(argWtypes[j], dctx, p);
					} else {
						emitAs(Identifier('undefined'), dctx, p);
					}
				});
				dctx.emit(I.local.get(held), I.struct.get(c.structTypeIndex, 0), I.call_ref(c.funcTypeIndex));
				coerceTop(c.sig.result, dctx, want);
				return [..._cond, I.if(want === 'void' ? undefined : toValType(want), dctx.swapOut(), buildArm(i + 1))];
			}

			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(1 + argLocals.length, toValType);
		});
		return info;
	}

	// A method call on an `any`/`unknown` receiver: which class's method runs is known only at run time, so a dispatch per call shape tests the receiver against
	// every reachable owner of `name` (strings and arrays too), converts each argument from its own static representation to that candidate's parameter, and the
	// result to what the call wants. None traps.
	function ensureAnyDispatch(name: string, argWtypes: W.Type[], argTs: Type[], want: W.Type, ctx: FunctionContext): FuncInfo {
		const key = `${name}(${argWtypes.map(W.typeKey).join(',')})=>${W.typeKey(want)}`;
		const existing = anyDispatchFuncs.get(key);
		if (existing)
			return existing;

		const { funcIndex, typeIndex } = types.func(toParams2([{key: 'recv', wtype: W.REF_ANY, tsType: T.ANY},
			...argWtypes.map((wtype, i) => ({ key: `arg${i}`, wtype, tsType: argTs[i] }))]), toResults(want));
		const info: FuncInfo = { params: [W.REF_ANY, ...argWtypes], result: want, funcIndex, typeIndex };

		anyDispatchFuncs.set(key, info);
		funcs.set(`<any dispatch>.${key}`, info);
		lateWorklist.push(() => {
			const candidates = findAnyDispatchCandidates(name, argTs, ctx);
			if (!candidates.length)
				throw `no reachable class (or 'number'/'boolean'/'string'/array) declares a '${name}' callable with ${argTs.length} such argument(s) -- a dynamic dispatch on 'any' needs at least one real candidate`;
			const dctx = new FunctionContext(key, new Scope(libGlobal), plainReturn(want), undefined);
			const recv = dctx.declareLocal('$recv', W.REF_ANY);
			const argLocals = argWtypes.map((w, i) => dctx.declareLocal(`$arg$${i}`, w));

			function buildArm(i: number): wasm.Instr[] {
				if (i >= candidates.length)
					return [I.unreachable];
				const c = candidates[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(c.heapType));
				const _cond = dctx.swapOut();
				dctx.emit(I.local.get(recv.index), I.ref.cast(c.heapType));
				if (c.isBoxedScalar)
					dctx.emit(I.struct.get(c.heapType, 0));
				c.funcInfo.params.forEach((p, j) => {
					if (j < argLocals.length) {
						dctx.emit(I.local.get(argLocals[j].index));
						coerceTop(argWtypes[j], dctx, p);
						return;
					}
					// A trailing parameter the call leaves out takes its default (an optional one's implicit `undefined`).
					const d = c.funcInfo.defaults?.[j];
					if (!d)
						throw `'${name}' needs more than ${argLocals.length} argument(s)`;
					emitAs(d, dctx, p);
				});
				dctx.emit(I.call(c.funcInfo.funcIndex));
				coerceTop(c.funcInfo.result, dctx, want);
				return [..._cond, I.if(want === 'void' ? undefined : toValType(want), dctx.swapOut(), buildArm(i + 1))];
			}

			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(1 + argLocals.length, toValType);
		});
		return info;
	}

	// A real dynamic-dispatch cascade for `recv.name` (a plain field read, not a call) where `recv`'s static type is a genuine union of >=2 different object shapes
	// (`typeOf`'s own union case boxes this as `any`, the same physical representation `ensureAnyDispatch` already uses) -- found via a generic callback resolving
	// its own type param to a real union, contextually (`Rule([...], $ => ({...}))`-shaped calls, once their own `T` resolves to a union like
	// `SpreadExpr | OtherExpr` rather than an anonymous shape). Unlike `ensureAnyDispatch`, `members` is the union's own exact, bounded set -- the checker already
	// verified every member declares this field, so this never needs a fallback "no candidate matched" arm the way `ensureAnyDispatch` does; a receiver failing every
	// `ref.test` here would mean the checker was wrong, an internal inconsistency, not a real program to guard against. A plain-array-typed member (`number[]`,
	// `boolean[]`, ...) has TWO real, valid physical forms at runtime: its own natural element-typed representation (`ownerFor`'s own `Array<number>`, a real `f64`
	// array) when the value came from a precisely-typed local/field, OR the ref-kind, boxed-`any`-element representation (`Array<any>`) when built as a literal
	// directly in a boxed-`any` position -- `case 'array'`'s own rule, found via `dwg/src/crc16.ts`'s `updateBuffer([1,2,3])` passed into a `Uint8Array | number[]`
	// parameter (traps at runtime, `ref.test`-ing only the `f64`-array form the literal never took). `expandArrayMembers` adds both, deduped by `typeIndex`.
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

		// Scratch ctx, live for this whole function's life (not just the deferred body below) -- a getter-backed member (`.length` on `Array<T>`, e.g. `Uint8Array | number[]`)
		// needs `ensureMethod` run right now, synchronously, same as any other method-resolving call site, to learn its real result type before `result` (and so this
		// dispatcher's own signature) can be decided; `onReturn` is swapped in below but never read -- `buildArm` emits its own raw branching directly, never through `ctx.onReturn`.
		const dctx = new FunctionContext(key, new Scope(libGlobal), plainReturn(W.REF_ANY), undefined);

		// Each member's own field or `get` accessor. A member that has NEITHER is dropped rather than rejected: the checker allowed this access, so either every
		// member has the property or it NARROWED the receiver first (`u.k === 'b' ? u.b : ...`, and every discriminated union in a real program). Codegen doesn't track
		// narrowing, so it still sees the whole union here -- but a member the narrowing excluded cannot be the runtime value, so leaving it out of the cascade is
		// exactly right; a receiver matching no arm reaches `buildArm`'s own trailing `unreachable` and traps, rather than reading a field that isn't there.
		const memberFields = members.map(m => {
			// A member declares `name` as a real field, or as a getter (`Array<T>.length` is inline asm, so `methodSig` rather than `ensureMethod` -- the
			// same "either shape" dispatch index-syntax `get`/`set` already needs).
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

		// The dispatch's own result type comes from the property's real checker type on the union (`T.lookupMember`'s own 'union' case unions each constituent's own
		// property type together) -- NOT from comparing each member's raw *physical* wtype, which can legitimately differ even when every member's own declared TS type
		// is identical (`Uint8Array.length`'s internally-narrowed `i32` field storage vs. `Array<T>.length`'s getter, raw asm result `u32` -- both really just `number`).
		// Getting this wrong doesn't just pick a clumsier representation: a per-member `coerceTop(f.wtype, dctx, REF_ANY)` boxes strictly by *physical* wtype (an `i32`-kind
		// box), while the caller's own `coerceTop(REF_ANY, ctx, wantWtype)` unboxes strictly by *wanted* type (here `f64`'s box kind) -- two different box shapes, so the
		// caller's `ref.cast` traps at runtime. Falls back to `REF_ANY` only if the property type genuinely couldn't be resolved here (shouldn't happen -- the one real
		// call site already required `owners.every(o => ...)` to succeed, which needs the same property to exist on every member). An OPTIONAL field may be absent, and
		// the checker keeps optionality as a modifier rather than folding `| undefined` into the property's type (`addField`'s own comment) -- so the result is widened
		// here the way `addField` widens the field itself, or each arm unboxed an absent `l.optional` with `ref.as_non_null`.
		const declared	= resultTsType && typeOf(resultTsType) || W.REF_ANY;
		const absent	= memberFields.some(f => f.kind === 'field' && f.cls.fields[f.fieldIdx].optional);
		const result	= absent && declared !== 'void' ? types.nullable(declared) : declared;
		dctx.onReturn = plainReturn(result);

		const { funcIndex, typeIndex } = types.func(toParams2([{ key: 'recv', wtype: W.REF_ANY, tsType: T.ANY }]), toResults(result));
		const info: FuncInfo = { params: [W.REF_ANY], result, funcIndex, typeIndex };
		unionFieldDispatchFuncs.set(key, info);
		funcs.set(`<union field dispatch>.${key}`, info);

		worklist.push(W.withCatch(() => {
			const recv = dctx.declareLocal('$recv', W.REF_ANY);

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
					emitFieldRead(f.cls, f.fieldIdx, dctx);
				coerceUnionArm(f.wtype, dctx, result);
				return [..._cond, I.if(result === 'void' ? undefined : toValType(result), dctx.swapOut(), buildArm(i + 1))];
			}

			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(1, toValType);
		}, key));
		return info;
	}

	// `arr[i]` on a real union of indexable classes (e.g. `Uint8Array | number[]`) -- same per-member `ref.test`/`ref.cast` dispatch shape as `ensureUnionFieldDispatch`,
	// just always through each member's own `get(i)` method rather than a field/getter: every indexable class in this compiler (a typed-array view, or the real `Array<T>`
	// struct a plain `number[]`/`boolean[]`/etc. resolves to via `ownerFor`'s own 'array' case) shares this one convention, so there's no separate "raw array" arm to handle
	// the way `case 'index'`'s own single-receiver path still needs one.
	function ensureUnionIndexDispatch(members: readonly ClassInfo[]): FuncInfo {
		members = expandArrayMembers(members);
		const key = `[]=>[${members.map(m => m.typeIndex).join(',')}]`;
		const existing = unionIndexDispatchFuncs.get(key);
		if (existing)
			return existing;

		// Same scratch-ctx-live-for-the-whole-function reasoning as `ensureUnionFieldDispatch`: `get`'s own result type must be known synchronously.
		const dctx = new FunctionContext(key, new Scope(libGlobal), plainReturn(W.REF_ANY), undefined);

		// Each member's own `__get(i)` -- its one real call site already required every member to have one.
		const memberGets = members.map(m => {
			const sig = methodSig(m, '__get', dctx);
			if (!sig)
				throw `internal: '${m.name}' (a member of a union type) has no '__get' method`;
			return { cls: m, wtype: sig.result };
		});
		// `combineUnionWtypes`, not the checker's own indexing type (unlike `ensureUnionFieldDispatch`'s `T.lookupMember`-based result): `checkerTypeOf`
		// on a union receiver's indexed access resolves to plain `any`, not `u8 | number`, so this compares each member's real `get(i)` result physically.
		const result = W.combineUnion(memberGets.map(m => m.wtype));
		dctx.onReturn = plainReturn(result);

		const { funcIndex, typeIndex } = types.func(
			toParams2([{ key: 'recv', wtype: W.REF_ANY, tsType: T.ANY }, { key: 'idx', wtype: 'i32', tsType: T.NUMBER }]),
			toResults(result)
		);
		const info: FuncInfo = { params: [W.REF_ANY, 'i32'], result, funcIndex, typeIndex };
		unionIndexDispatchFuncs.set(key, info);
		funcs.set(`<union index dispatch>.${key}`, info);

		worklist.push(W.withCatch(() => {
			const recv = dctx.declareLocal('$recv', W.REF_ANY);
			dctx.declareValue('$idx', 'i32', T.NUMBER);

			function buildArm(i: number): wasm.Instr[] {
				if (i >= memberGets.length)
					return [I.unreachable];
				const m = memberGets[i];
				dctx.emit(I.local.get(recv.index), I.ref.test(m.cls.typeIndex));
				const _cond = dctx.swapOut();
				dctx.emit(I.local.get(recv.index), I.ref.cast(m.cls.typeIndex));
				emitMethodCall(m.cls, '__get', [Identifier('$idx')], dctx);
				coerceUnionArm(m.wtype, dctx, result);
				return [..._cond, I.if(result === 'void' ? undefined : toValType(result), dctx.swapOut(), buildArm(i + 1))];
			}

			dctx.emit(...buildArm(0));
			info.body = dctx.toFuncBody(2, toValType);
		}, key));
		return info;
	}

	// A real dynamic-dispatch cascade for `recv.name(...args)` where `recv`'s *static* type (`owner`) has at least one reachable subclass overriding `name` (`emitMethodCall`
	// only ever routes here when `hasDeclaredOverride` says so -- every other call stays a plain direct `call`). Same shape as `ensureAnyDispatch` (reserve a funcIndex
	// immediately so call sites can `call` it right away; build the real cascade body once `lateWorklist` guarantees every reachable class has been discovered) --
	// generalized to a real receiver type (not just `any`) and real method arguments (not just zero-arg). One assumption this doesn't verify: every override shares
	// `owner`'s own resolved param/result `WasmType`s (real TS requires override signatures to stay compatible with the base's, taken here to mean "the same shape").
	function ensureVirtualDispatch(owner: ClassInfo, name: string, ctx: FunctionContext): FuncInfo {
		const key = `${owner.name}.${name}<virtual>`;
		const existing = anyDispatchFuncs.get(key);
		if (existing)
			return existing;
		// `[]`: safe even for a real-arg method -- `resolveOverload` only consults `args` to disambiguate a genuine overload set (`decls.length > 1`); a
		// plain, non-overloaded method (the only kind this function supports, per the header comment) returns its one declaration unconditionally.
		const base = ensureMethod(owner, name, [], ctx);
		if (!base)
			throw `internal: virtual dispatch requested for unknown method '${owner.name}.${name}'`;

		const { funcIndex, typeIndex } = types.func([{ type: toValType(owner.thisWtype!), id: 'this' }, ...toParams(base.params)], toResults(base.result));
		const info: FuncInfo = { params: base.params, result: base.result, funcIndex, typeIndex, defaults: base.defaults, hasRest: base.hasRest };
		anyDispatchFuncs.set(key, info);
		funcs.set(`<virtual dispatch>.${key}`, info);

		lateWorklist.push(() => {
			// Every *reachable* (already `ensureClass`'d, unlike `directSubclasses`' whole-source-text set) class transitively extending `owner` that overrides `name` with a real
			// body, deepest-first: `ref.test` recognizes a value as a subtype of *every* ancestor's own struct type too (a grandchild instance passes `ref.test $Child` as well
			// as `ref.test $GrandChild`), so a shallower arm would wrongly stop at an ancestor's override even when the receiver's real, more-derived class has its own.
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
			const dctx = new FunctionContext(key, new Scope(libGlobal), plainReturn(base.result), undefined);
			const recv = dctx.declareLocal('$recv', owner.thisWtype!);
			// Already-evaluated argument values (pushed against `owner`'s own signature, not knowing yet which concrete override will run) -- forwarded
			// as-is to whichever `call` actually fires, never re-evaluated.
			const argLocals = base.params.map((p, i) => dctx.declareLocal(`$arg$${i}`, p));

			const buildArm = (i: number): wasm.Instr[] => {
				if (i >= candidates.length) {
					// No override matched -- the receiver really is `owner` itself or a non-overriding subclass. `ensureMethod(owner, ...)` already resolved
					// `base` by walking up to whichever ancestor defines `name`; call it directly.
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

	// EXPANDO fields, decided whole-program and UP FRONT: a property write the checker accepted that the receiver's shape does not declare adds a field
	// to that shape, and a wasm struct type is built the first time anything mentions it -- nothing discovered while compiling a body applies
	// retroactively (a struct type is fixed, wasm-GC cannot change an allocated object's type, `ref.cast` only TESTS one). Keyed by SHAPE, not local,
	// which is what makes a write through a PARAMETER work: the object was allocated elsewhere and the declaration site never sees it. TS width
	// subtyping (`Meth` IS a `Sig`) has no wasm analogue -- a struct subtype's extra fields must FOLLOW the supertype's, which no single ordering gives
	// for unrelated shapes -- so a shape receiving a value of another type is stored as `any`, read through the same dispatch an `any` gets.
	const openShapes = new Set<string>();

	// A declared slot meeting a VALUE: an object/array literal is built AT the slot and has no layout of its own yet, so only what it holds can widen anything -- hence the descent.
	// `erased`: an array ELEMENT slot does not survive to the literal's emit site -- `Array<T>` collapses `T` to `any` -- so the literal builds its own shape, and only then can it widen anything.
	function noteSlot(slot: Type | undefined, value: Expr, scope: Scope, depth = 4, erased = false): void {
		if (!slot || depth < 0)
			return;
		const s = T.resolve(scope, slot);
		if (value.type === 'object' && s.type === 'object') {
			for (const f of value.properties)
				if (f.type === 'field' && typeof f.key === 'string' && f.value)
					noteSlot(T.lookupMember(s, f.key, scope), f.value, scope, depth - 1);
			// Literal types widened first, or every `const m: M = {...}` differs from `M` by its own `key: "k"` vs `string`.
			if (erased)
				noteTypes(slot, T.widenLiterals(checkerTypeOf(unwrapAs(value), scope)), scope, depth);
			return;
		}
		if (value.type === 'array' && s.type === 'array') {
			for (const el of value.elements)
				if (el && el.type !== 'spread')
					noteSlot(s.element, el, scope, depth - 1, true);
			return;
		}
		noteTypes(slot, checkerTypeOf(unwrapAs(value), scope), scope, depth);
	}
	// The same question with no expression to descend: a value's TYPE meeting a slot's, member-wise and through elements.
	function noteTypes(slot: Type | undefined, value: Type | undefined, scope: Scope, depth = 4): void {
		if (!slot || !value || depth < 0)
			return;
		const s = T.resolve(scope, slot), v = T.resolve(scope, value);
		if (T.typeKey(s) === T.typeKey(v))
			return;
		if (s.type === 'array' && v.type === 'array')
			return noteTypes(s.element, v.element, scope, depth - 1);
		if (s.type !== 'object')
			return;
		if (v.type === 'object')
			for (const m of s.members)
				if ((m.type === 'property' || m.type === 'method') && typeof m.key === 'string')
					noteTypes(T.lookupMember(s, m.key, scope), T.lookupMember(v, m.key, scope), scope, depth - 1);
		// An `any` value is the program's own promise about what it holds, kept by the `ref.cast` every read of one already
		// emits -- widening on it would open nearly every shape, since `any` reaches everywhere.
		if (T.isAny(v) || (v.type === 'ref' && v.name === 'unknown'))
			return;
		// Only a value of a genuinely different LAYOUT widens: two types that share one are already interchangeable.
		if (layoutSketch(s, scope) !== layoutSketch(v, scope) && T.isAssignable(v, s, scope))
			openShapes.add(T.typeKey(s));
	}
	function collectOpenShapes() {
		for (const [moduleId, m] of moduleBodies) {
			const modScope = moduleScopeOf(moduleId);
			if (!modScope)
				continue;
			let scope = modScope;
			walkerB(
				(st, process) => {
					const saved = scope;
					scope = (st as unknown as { scope?: Scope }).scope ?? scope;
					if (st.type === 'var_decl')
						for (const d of st.declarations)
							if (d.typeAnnotation && d.init)
								noteSlot(d.typeAnnotation, d.init, scope);
					const r = process(st);
					scope = saved;
					return r;
				},
				(e, process) => {
					if (e.type === 'assign') {
						noteSlot(checkerTypeOf(unwrapAs(e.target), scope), e.value, scope);
					// A plain call argument carries no contextual stamp this pass can read, so the parameter types come from
					// the callee's own signature -- a rest parameter by its element type, which `push({ sig, decl })` needs.
					} else if (e.type === 'call') {
						// A callee types either as a function or, for an overload set (`push`), as an object of `call` members.
						// Every overload that could take this many arguments is noted: marking a shape open only costs speed.
						const fn	= T.resolve(scope, checkerTypeOf(unwrapAs(e.callee), scope));
						const sigs	= fn.type === 'function' ? [fn] : fn.type === 'object' ? fn.members.filter(m => m.type === 'call') : [];
						for (const sig of sigs as TS.CallSig[]) {
							if (!sig.rest && sig.params.length < e.arguments.length)
								continue;
							const restEl = sig.rest?.typeAnnotation && T.resolve(scope, sig.rest.typeAnnotation);
							e.arguments.forEach((arg, i) => {
								if (arg.type !== 'spread')
								{
									// A declared parameter is NOT a slot: the callee is monomorphized per argument layout, which keeps the caller's own object (test `structuralParam`).
									// Only a rest parameter's bundle -- an array, so its element type is erased -- has to be widened.
									if (!sig.params[i]?.typeAnnotation && restEl && restEl.type === 'array')
										noteSlot(restEl.element, arg, scope, 4, true);
								}
							});
						}
					}
					return process(e);
				}).statements(m.body);
		}
	}

	function collectExpandoFields() {
		// A local's declared ANNOTATION, by name: a parameter already types as its annotation, but `const p: P = {...}` types as the literal's inferred shape, its declared name gone, and only the local's name identifies the shape to grow.
		// towasm's own local wtype comes from the annotation for exactly this reason. Not scope-precise: over-approximating adds an unused optional field, which costs a slot and breaks nothing.
		const annots = new Map<string, Type>();
		// Every member of a union gets the slot: the write lands on whichever one it turns out to be at runtime. A generic instantiation shares its shape's one struct, keyed by the bare name (`ensureObjectShape`); an array is `Array`'s.
		// A structural shape (an interface, an alias, an inline object type) by its member names -- `shapeKey`, the identity `layoutTwin` merges by, so a named shape and its anonymous twin keep one layout; a class by name.
		// A shape with no name (an inline object type) or a type parameter has nowhere to put one.
		const noteType = (raw: Type, key: string | undefined, scope: Scope, accessor = false) => {
			for (const member of T.unionMembers(raw, scope)) {
				const part = member.type === 'array' || member.type === 'tuple' ? TS.RefType('Array') : member;
				if (part.type === 'ref' && (T.isAny(part) || scope.type(part.name)?.isTypeParam))
					continue;
				const isClass	= part.type === 'ref' && (T.isClassRef(part, scope) || LIB_DECL_MAP.get(part.name)?.type === 'class_decl');
				const shape		= part.type === 'object' ? part : part.type === 'ref' && !isClass ? T.resolveObjectType(part, scope) : undefined;
				const name		= shape ? shapeKey(shape.members) : part.type === 'ref' ? part.name : undefined;
				if (!name)
					continue;
				if (accessor && key !== undefined)
					(accessorKeys.get(name) ?? accessorKeys.set(name, new Set()).get(name)!).add(key);
				const prior = pendingExtensions.get(name);
				if (prior === 'dynamic')
					continue;
				if (key === undefined)
					pendingExtensions.set(name, 'dynamic');
				else if (!(shape ? shape.members.some(m => 'key' in m && m.key === key) : T.lookupMember(part, key, scope)))
					pendingExtensions.set(name, [...new Set([...(prior ?? []), key])]);
			}
		};
		// The RAW type, never `T.resolve`'s: resolving a ref expands it to its object shape and loses the NAME.
		const note = (recv: Expr, key: string | undefined, scope: Scope, accessor = false) => {
			const bare = unwrapAs(recv);
			noteType((bare.type === 'identifier' ? annots.get(bare.name) : undefined) ?? checkerTypeOf(bare, scope), key, scope, accessor);
		};
		for (const [moduleId, m] of moduleBodies) {
			const modScope = moduleScopeOf(moduleId);
			if (!modScope)
				continue;
			// The checker stamps its scope on STATEMENTS, so the enclosing statement's scope is what types the receiver -- a parameter or a local is resolvable there and nowhere else.
			// Tracked down the statement walk; the module scope is only the outermost fallback.
			let scope = modScope;
			walkerB(
				(st, process) => {
					const saved = scope;
					scope = (st as unknown as { scope?: Scope }).scope ?? scope;
					if (st.type === 'var_decl')
						for (const d of st.declarations)
							if (typeof d.name === 'string' && d.typeAnnotation)
								annots.set(d.name, d.typeAnnotation);
					const r = process(st);
					scope = saved;
					return r;
				},
				(e, process) => {
					if (e.type === 'assign' && e.target.type === 'member') {
						note(e.target.object, e.target.property, scope);
					} else if (isDefinePropertyCall(e) && e.arguments[0]) {
						const desc = e.arguments[2];
						note(e.arguments[0], e.arguments[1]?.type === 'literal' && typeof e.arguments[1].value === 'string' ? e.arguments[1].value : undefined, scope,
							desc?.type === 'object' && desc.properties.some(q => (q.type === 'field' || q.type === 'method') && (q.key === 'get' || q.key === 'set')));
					}
					return process(e);
				}).statements(m.body);
		}
		collectReceivedExpandos(noteType);
	}

	// A key written onto a receiver whose static type names no struct -- a type parameter, `any`, `object` -- lands on whatever it holds at runtime, and only its SOURCES say what that is.
	// So the receiver is followed backwards to types that name a struct -- with function values tracked, since a stamper passed as a value (`makeRule(stampPos)`) is called through a parameter.
	// Flow- and context-insensitive: over-approximating only adds an unused optional slot. Not followed: a function value stored into an object or array field and called from there.
	function collectReceivedExpandos(noteType: (t: Type, key: string, scope: Scope) => void) {
		interface Fn		{ params: (Binding | undefined)[]; returns: Site[]; declaredReturn?: Type; callers: Set<Call> }
		interface Binding	{ param?: { fn: Fn; index: number }; fn?: Fn; values: Site[]; declared?: Type; declScope?: Scope }
		interface Container	{ parent?: Container; names: Map<string, Binding>; moduleId: string; fn?: Fn }
		interface Site		{ e: Expr; c: Container; scope: Scope; from?: Fn }
		interface Call		{ callee: Site; args: (Site | undefined)[] }

		const fnOf			= new Map<object, Fn>();
		const moduleOf		= new Map<object, string>();
		const containerOf	= new Map<string, Container>();
		const bindings: Binding[]	= [];
		const calls: Call[]			= [];
		const assigns: { target: Site; value: Site }[]	= [];
		const seeds: { s: Site; key: string }[]			= [];

		const bindingIn = (c: Container, name: string): Binding => {
			let b = c.names.get(name);
			if (!b) {
				c.names.set(name, b = { values: [] });
				bindings.push(b);
			}
			return b;
		};
		const enter = (node: object, sig: TS.CallSig, c: Container, scope: Scope): Container => {
			const contextual	= (node as { contextualType?: Type }).contextualType;
			const fn: Fn		= { params: [], returns: [], callers: new Set(), declaredReturn: sig.returnType ?? (contextual?.type === 'function' ? contextual.returnType : undefined) };
			fnOf.set(node, fn);
			const inner: Container = { parent: c, names: new Map(), moduleId: c.moduleId, fn };
			sig.params.forEach((p, index) => {
				if (typeof p.key === 'string') {
					const b: Binding = { param: { fn, index }, values: [], declared: p.typeAnnotation, declScope: scope };
					inner.names.set(p.key, fn.params[index] = b);
					bindings.push(b);
				}
			});
			return inner;
		};
		// Some part of the receiver's own type names no struct, so its own type cannot say where the key lands.
		const untyped = (recv: Expr, scope: Scope) => T.unionMembers(checkerTypeOf(unwrapAs(recv), scope), scope).some(m =>
			m.type !== 'ref' || T.isAny(m) || m.name === 'object' || !!scope.type(m.name)?.isTypeParam);

		for (const [moduleId, m] of moduleBodies) {
			const modScope = moduleScopeOf(moduleId);
			if (!modScope)
				continue;
			let c: Container = { names: new Map(), moduleId };
			containerOf.set(moduleId, c);
			for (const st of m.body)
				moduleOf.set(st.type === 'export_decl' ? st.declaration : st, moduleId);
			let scope = modScope;
			const site = (e: Expr): Site => ({ e, c, scope });
			const within = (inner: Container, process: () => boolean) => {
				const saved = c;
				c = inner;
				const r = process();
				c = saved;
				return r;
			};
			walkerB(
				(st, process) => {
					const savedScope = scope;
					scope = (st as unknown as { scope?: Scope }).scope ?? scope;
					let r: boolean;
					if (st.type === 'function_decl' && st.body) {
						const inner = enter(st, st, c, scope);
						bindingIn(c, st.name).fn ??= fnOf.get(st);
						r = within(inner, () => process(st));
					} else {
						if (st.type === 'var_decl') {
							for (const d of st.declarations) {
								if (typeof d.name !== 'string')
									continue;
								const b = bindingIn(c, d.name);
								b.declared ??= d.typeAnnotation;
								b.declScope ??= scope;
								if (d.init)
									b.values.push(site(d.init));
							}
						} else if (st.type === 'return' && st.argument && c.fn) {
							c.fn.returns.push(site(st.argument));
						}
						r = process(st);
					}
					scope = savedScope;
					return r;
				},
				(e, process) => {
					if (e.type === 'arrow' || e.type === 'function') {
						const inner = enter(e, e, c, scope);
						const fn = fnOf.get(e)!;
						if (e.type === 'function' && e.name)
							inner.names.set(e.name, { fn, values: [] });
						return within(inner, () => {
							if (e.type === 'arrow' && !Array.isArray(e.body))
								fn.returns.push(site(e.body));
							return process(e);
						});
					}
					if (e.type === 'call') {
						calls.push({ callee: site(e.callee), args: e.arguments.map(a => a.type === 'spread' ? undefined : site(a)) });
						const key = e.arguments[1];
						if (isDefinePropertyCall(e) && e.arguments[0] && key?.type === 'literal' && typeof key.value === 'string' && untyped(e.arguments[0], scope))
							seeds.push({ s: site(e.arguments[0]), key: key.value });
					} else if (e.type === 'assign') {
						if (e.target.type === 'identifier')
							assigns.push({ target: site(e.target), value: site(e.value) });
						else if (e.target.type === 'member' && untyped(e.target.object, scope))
							seeds.push({ s: site(e.target.object), key: e.target.property });
					}
					return process(e);
				},
				undefined,
				(member, process) => (member.type === 'method' || member.type === 'get' || member.type === 'set') && 'body' in member && member.body
					? within(enter(member, member as TS.CallSig, c, scope), () => process(member))
					: process(member)
			).statements(m.body);
		}

		const lookup = (name: string, c: Container): Binding | undefined => {
			for (let k: Container | undefined = c; k; k = k.parent) {
				const b = k.names.get(name);
				if (b)
					return b;
			}
			const imported = namedImportsByModule.get(c.moduleId)?.get(name);
			return imported && containerOf.get(imported.module)?.names.get(imported.name);
		};
		// An identifier, or `NS.name` through an `import * as NS`.
		const bindingOf = (s: Site, e: Expr): Binding | undefined => {
			if (e.type === 'identifier')
				return lookup(e.name, s.c);
			if (e.type === 'member' && e.object.type === 'identifier' && !lookup(e.object.name, s.c)) {
				const decl = s.scope.namespace(e.object.name)?.decl(e.property);
				const home = decl && moduleOf.get(decl);
				return home !== undefined ? containerOf.get(home)?.names.get(e.property) : undefined;
			}
			return undefined;
		};
		for (const { target, value } of assigns)
			bindingOf(target, target.e)?.values.push(value);

		// The functions each parameter or local may hold -- to a fixpoint, since a parameter holds what its callers
		// pass, and who its callers are depends on which functions each callee expression may hold.
		const held = new Map<Binding, Set<Fn>>();
		const fnsOf = (s: Site, seen = new Set<Expr>()): Set<Fn> => {
			const e	= unwrapAs(s.e);
			const out	= new Set<Fn>();
			if (seen.has(e))
				return out;
			seen.add(e);
			const add = (x: Expr) => fnsOf({ ...s, e: x }, seen).forEach(f => out.add(f));
			if (e.type === 'arrow' || e.type === 'function') {
				out.add(fnOf.get(e)!);
			} else if (e.type === 'identifier' || e.type === 'member') {
				const b = bindingOf(s, e);
				if (b?.fn)
					out.add(b.fn);
				else if (b)
					held.get(b)?.forEach(f => out.add(f));
			} else if (e.type === 'call') {
				for (const g of fnsOf({ ...s, e: e.callee }, seen))
					for (const r of g.returns)
						fnsOf(r, seen).forEach(f => out.add(f));
			} else if (e.type === 'conditional') {
				add(e.consequent);
				add(e.alternate);
			} else if (e.type === 'binary' && (e.operator === '&&' || e.operator === '||' || e.operator === '??')) {
				add(e.left);
				add(e.right);
			}
			return out;
		};
		for (let changed = true; changed;) {
			changed = false;
			const hold = (b: Binding | undefined, fs: Set<Fn>) => {
				if (!b || b.fn || !fs.size)
					return;
				let set = held.get(b);
				if (!set)
					held.set(b, set = new Set());
				for (const f of fs)
					if (!set.has(f)) {
						set.add(f);
						changed = true;
					}
			};
			for (const call of calls)
				for (const g of fnsOf(call.callee)) {
					if (!g.callers.has(call)) {
						g.callers.add(call);
						changed = true;
					}
					g.params.forEach((p, i) => {
						const a = call.args[i];
						if (a)
							hold(p, fnsOf(a));
					});
				}
			for (const b of bindings)
				for (const v of b.values)
					hold(b, fnsOf(v));
		}

		const reached	= new Map<string, Set<Expr>>();
		const work		= [...seeds];
		while (work.length) {
			const { s, key } = work.pop()!;
			// A cast states the type the value is used as -- which names its struct where the value's own type may not.
			let e = s.e;
			for (; e.type === 'as'; e = e.expression)
				noteType(e.typeAnnotation, key, s.scope);
			let seen = reached.get(key);
			if (!seen)
				reached.set(key, seen = new Set());
			if (seen.has(e))
				continue;
			seen.add(e);
			const follow = (x: Expr, from = s.from) => work.push({ s: { ...s, e: x, from }, key });
			let followed = false;
			const b = e.type === 'identifier' || e.type === 'member' ? bindingOf(s, e) : undefined;
			if (b && !b.fn) {
				if (b.declared)
					noteType(b.declared, key, b.declScope ?? s.scope);
				if (b.param)
					for (const call of b.param.fn.callers) {
						const a = call.args[b.param.index];
						if (a) {
							work.push({ s: a, key });
							followed = true;
						}
					}
				for (const v of b.values) {
					work.push({ s: v, key });
					followed = true;
				}
			} else if (e.type === 'call') {
				for (const g of fnsOf({ ...s, e: e.callee }))
					for (const r of g.returns) {
						work.push({ s: { ...r, from: g }, key });
						followed = true;
					}
			} else if (e.type === 'conditional') {
				follow(e.consequent);
				follow(e.alternate);
				followed = true;
			} else if (e.type === 'binary' && (e.operator === '&&' || e.operator === '||' || e.operator === '??')) {
				follow(e.left);
				follow(e.right);
				followed = true;
			} else if (e.type === 'object') {
				for (const p of e.properties)
					if (p.type === 'spread')
						follow(p.operand, undefined);
			}
			if (followed)
				continue;
			// Nothing further to follow: the value is made here, or comes from where this analysis does not look.
			if (s.from?.declaredReturn)
				noteType(s.from.declaredReturn, key, s.scope);
			noteType(checkerTypeOf(e, s.scope), key, s.scope);
		}
	}
	collectOpenShapes();
	collectExpandoFields();

	// Only *functions* are seeded across every module; a non-entry module's classes/scalar globals aren't yet
	// module-scoped (`ensureClass`/`ensureGlobal` -- see `TStoWasm`'s header), so class/scalar promotion below stays entry-only.
	for (const [moduleId, body] of moduleBodies) {
		for (let s of body.body) {
			if (s.type === 'export_decl')
				s = s.declaration;
			stmtHomeModule.set(s, moduleId);
			if (s.type === 'function_decl' && s.body) {
				functionDeclByName.set(homeKey(moduleId, s.name), s);
			} else if (s.type === 'enum_decl') {
				// Same numbering rule the checker's own `hoist` uses: an implicit member continues from
				// the previous explicit one, a string member has no successor to continue from.
				let next = 0;
				enumNames.add(homeKey(moduleId, s.name));
				for (const m of s.members) {
					const init = m.init;
					const value = !init ? next++
						: init.type === 'literal' && typeof init.value === 'number' ? (next = init.value + 1, init.value)
						: init.type === 'literal' && typeof init.value === 'string' ? init.value
						: undefined;
					if (value !== undefined)
						enumMembers.set(homeKey(moduleId, `${s.name}.${m.name}`), value);
				}
			} else if (moduleId === '.' && s.type === 'class_decl') {
				if (s.typeParams?.length) {
					userGenericClassDecls.set(s.name, s);
				} else {
					classes.set(s.name, new ClassInfo(s.name, -1, s, TS.RefType(s.name)));
				}
			} else if (s.type === 'var_decl' && s.kind !== 'var') {
				for (const d of s.declarations) {
					if (typeof d.name !== 'string' || !d.init)
						continue;
					// Only `exportScope` stamps `Scope.addDecl` for a var_decl, and only for an EXPORTED one, so a
					// non-exported module-level `const` (js-parser.ts's `import_attributes`) resolved nowhere; keyed per module.
					topLevelVars.set(homeKey(moduleId, d.name), { stmt: s, d });
					if (s.kind === 'const' && (d.init.type === 'arrow' || d.init.type === 'function')) {
						functionDeclByName.set(homeKey(moduleId, d.name), arrowOrFunctionToDecl(d.name, d.init));
						if (moduleId === '.')
							promotedConsts.add(d.name);
					} else if (moduleId === '.') {
						// `foldConstants` first: `-1`/`!true` parse as real `unary`/`binary` nodes, so a direct
						// `type === 'literal'` check missed every foldable initializer, leaving that global unregistered
						// (any function using it then threw "unresolved identifier"); `case 'switch'` folds the same way.
						const folded = foldConstants(d.init)!;
						// Only a literal a wasm global can actually be INITIALIZED from: a string literal has no
						// constant form (its physical value is an i16 array built at runtime), nor a bigint unless it
						// lands on a real `i64` slot; the rest fall through to `ensureLazyGlobal`.
						const eagerKind = folded.type === 'literal' && W.notUnsigned(W.scalarKind(typeOf(d.typeAnnotation ?? checkerTypeOf(d.init, libGlobal))));
						if (eagerKind && (typeof folded.value === 'number' || typeof folded.value === 'boolean' || (typeof folded.value === 'bigint' && eagerKind === 'i64'))) {
							// Registered eagerly (unlike `lib/console.ts`'s `heap`, which registers lazily on first
							// reference): once it's a global, its position in `ast.body` stops mattering. `mut: false` for
							// `const` -- a genuine wasm-level compile-time constant, not just an unchecked mutable slot.
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

	// wasm puts every import at the lowest, contiguous function indices, before any local function claims one,
	// so "is this host import needed" must be decided up front. Deliberately a name-matching over-approximation
	// -- an unused import is harmless, so this only needs to never *under*-approximate.
	const reached	= new Set<string>();
	const pending: string[] = [];

	const collectNames = walker(undefined, (e, process) => {
		if (e.type === 'identifier')
			pending.push(e.name);
		return process(e);
	});

	// `walk` already descends into every nested function/class body, so this covers everything reachable
	// syntactically; leaving it ungated by cross-module reachability is deliberate -- extra names in `reached` are harmless.
	for (const body of moduleBodies.values())
		collectNames.statements(body.body);

	while (pending.length) {
		const name = pending.shift()!;
		if (!reached.has(name)) {
			reached.add(name);
			const decl = functionDeclByName.get(name) ?? LIB_DECL_MAP.get(name);
			if (decl && (decl.type === 'function_decl' || decl.type === 'class_decl'))
				collectNames.statement(decl);
		}
	}

	// Every module's host imports, not just the static lib's; deduped by name, since the same host function
	// imported by two modules is still ONE wasm import.
	const hostImports = [...new Map(
		[...LIB_HOST_IMPORTS, ...[...moduleBodies.values()].flatMap(m => hostImportsIn(m.body))].map(hi => [hi.name, hi] as const)
	).values()];

	mod.imports = hostImports.filter(hi => reached.has(hi.name)).map(hi => {
		const params = hi.params.map(p => resolveParam({ key: '', typeAnnotation: p }).wtype);
		const result = hi.returnType ? typeOf(hi.returnType) ?? 'void' : 'void';
		const { funcIndex, typeIndex } = types.func(toParams(params), toResults(result));
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
	// An `extends`ed interface's shape must stay non-final, so the extending shape can name it as its supertype.
	const markExtendedInterfaces = (body: readonly TS.Stmt[]): void => body.forEach(s => {
		if (s.type === 'interface_decl')
			s.extendsClause?.forEach(b => b.type === 'ref' && everExtended.add(b.name.slice(b.name.lastIndexOf('.') + 1)));
		else if (s.type === 'export_decl')
			markExtendedInterfaces([s.declaration as TS.Stmt]);
		else if (s.type === 'namespace_decl' || s.type === 'module_decl')
			markExtendedInterfaces(s.body as TS.Stmt[]);
	});
	markExtendedInterfaces(LIB_AST);
	for (const m of moduleBodies.values())
		markExtendedInterfaces(m.body);

	//top level
	const {funcIndex, typeIndex} = types.func([], []);
	const info: FuncInfo = {params: [], result: 'void', funcIndex, typeIndex};
	funcs.set('__toplevel', info);
	mod.start	= funcIndex;
	worklist.push(W.withCatch(() => {
		const ctx	= new FunctionContext('__toplevel', new Scope(libGlobal), plainReturn('void'), undefined);
		ctx.widenedTypes = collectRangeWidenings(ast.body!, ctx.scope);
		ctx.ownBody = ast.body!;
		// Each statement gets its own buffer so a failure discards exactly its partial output: `ctx.emit`
		// appends, so a half-emitted statement would otherwise corrupt the start function's stack balance.
		const emitTopLevel = (st: Stmt) => {
			if (!onTopLevelError)
				return emitOneTopLevel(st);
			const before = ctx.swapOut();
			try {
				emitOneTopLevel(st);
				ctx.emit(...ctx.swapOut(before));
			} catch (e) {
				ctx.swapOut(before);
				onTopLevelError(new W.Error(e as any, st, '<module init>').inModule(ctx.homeModule));
			}
		};
		const emitOneTopLevel = (st: Stmt) => {
			if (st.type === 'export_decl' || st.type === 'function_decl' || st.type === 'class_decl' || st.type === 'type_alias_decl' || st.type === 'interface_decl' || st.type === 'import')
				return;
			// A bare `export {a, b}` / `export type {T} from '...'` / `export * from '...'` binds and evaluates
			// nothing; `export default <expr>` is excluded because that one really does have a value to evaluate.
			if (st.type === 'export' && !st.default)
				return;
			if (st.type === 'var_decl') {
				// Declarator by declarator, in source order, so forcing one below never reorders it past a
				// sibling that still emits normally.
				for (const d of st.declarations) {
					// A promoted const is already a real function; an alias (`const Scope = T.Scope`) only renames
					// something declared elsewhere (`isAliasInit`). Neither leaves anything for the start function to evaluate.
					if (typeof d.name === 'string' && (promotedConsts.has(d.name) || (d.init && isAliasInit(d.init, ctx.scope))))
						continue;
					// The lazy-global wrapper already caches this into the slot every other function reads, so
					// emitting the initializer here too ran a side-effecting one a SECOND time, into an invisible local.
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


	// Shared by the eager-compile loop and the exports-list loop so their classification can't drift apart;
	// `[]` for anything that isn't a function export (a value global, a class, ...).
	const exportedNames = new Set(ast.body.filter(s => s.type === 'export_decl').flatMap(s => {
		if (s.declaration.type === 'function_decl' && s.declaration.body)
			return [s.declaration.name];
		if (s.declaration.type === 'var_decl')
			return s.declaration.declarations.filter(d => typeof d.name === 'string' && promotedConsts.has(d.name) && functionDeclByName.has(d.name)).map(d => d.name as string);
	}));

	// Only *exported* top-level functions compile unconditionally here -- the exports-list loop reads
	// `funcs.get(name)!.funcIndex`. Every other one is discovered from a real call site (`emitCall`'s own
	// `funcs.get(name) ?? compileFunc(...)`), the same worklist-driven design classes/instantiations already get.
	// A generic has no single physical function to eagerly compile (like a generic class, kept out of `classes`),
	// and an exported one has no fixed wasm-level signature to give an export.
	const exportedFuncs: { name: string; info: FuncInfo }[] = [];
	for (const [name, decl] of functionDeclByName) {
		if (!exportedNames.has(name))
			continue;
		if (decl.typeParams?.length)
			continue;
		const info = compileFunc(name, decl);
		if (info) {
			(mod.exports??=[]).push({ name, kind: 'func', index: info.funcIndex });
			exportedFuncs.push({ name, info });
		}
	}

	while (worklist.length)
		worklist.shift()!();

	// A host call into an export IS the job boundary -- the same thing a libuv callback is for node -- so the
	// microtask queue drains on export return, never mid-call. "Outermost" is STRUCTURAL, needing no depth
	// counter: the wrapper is reachable only via the export TABLE, never by an internal or export-to-export call.
	// Emitted solely where the lib references `microtasks` (never a hardwired policy), after the worklist.
	if (lazyGlobalSlots.has(homeKey(LIB_MODULE, 'microtasks'))) {
		const hook = (n: string) => {
			const decl = LIB_DECL_MAP.get(n);
			return decl?.type === 'function_decl' ? ensureFunc(n, decl) : undefined;
		};
		const exit = hook('__towasm_exitCall');
		if (exit) {
			for (const { name, info } of exportedFuncs) {
				const { funcIndex, typeIndex } = types.func(toParams(info.params), toResults(info.result));
				const wrapper: FuncInfo = { ...info, funcIndex, typeIndex };
				const wctx		= new FunctionContext(`<export>.${name}`, new Scope(libGlobal), plainReturn(info.result), undefined);
				const argLocals = info.params.map((p, i) => wctx.declareLocal(`$arg$${i}`, p));
				argLocals.forEach(l => wctx.emit(I.local.get(l.index)));
				wctx.emit(I.call(info.funcIndex));
				// The real result sits on the stack underneath this void call, so the drain runs before the
				// return without disturbing it; appending to the callee's own epilogue couldn't handle several `return`s.
				wctx.emit(I.call(exit.funcIndex));
				wrapper.body = wctx.toFuncBody(argLocals.length, toValType);
				closureLiterals.push(wrapper);
				const e = mod.exports!.find(x => x.kind === 'func' && x.name === name);
				if (e)
					e.index = funcIndex;
			}
			while (worklist.length)
				worklist.shift()!();
		}
	}

	// `lateWorklist` (any-dispatch cascade bodies) needs the full, final candidate set, so it starts only
	// once `worklist` drains; building a cascade can push a new candidate back, so it drains again after each item.
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

	const importedFuncTypeIndices = new Set((mod.imports ?? []).flatMap(imp => imp.desc.kind === 'func' && typeof imp.desc.typeIndex === 'number' ? [imp.desc.typeIndex] : []));
	mod.types			= { types, groupSizes: types.groupSizes(importedFuncTypeIndices) };

	if (mod.code.some(b => touchesMemory(b.body))) {
		mod.memories	= [{ min: 1 }];
		// So a host can actually read back what got written to it (e.g. console.log's fd_write buffer) --
		// any consumer of real linear memory benefits, not just console.log specifically.
		(mod.exports ??= []).push({ name: 'memory', kind: 'memory', index: 0 });
	}
	
	mod.globals			= Array.from(globals.entries()).map(([name, {init, wtype, mut}]) => {
		if (init) {
			const type = { mut, type: toValType(wtype) };
			if (T.isNullLiteral(init)) {
				if (typeof wtype === 'string' || !wtype.nullable)
					throw `global '${name}' can't be initialized to 'null'/'undefined' -- its type isn't nullable`;
				return {type, init: [I.ref.null(heapTypeIndexOf(wtype))]};
			}
			const wtype2 = W.notUnsigned(W.scalarKind(wtype));
			if (wtype2 && init?.type === 'literal') {
				if (typeof init.value === 'number' || typeof init.value === 'boolean')
					return {type, init: [I[wtype2](+init.value)]};
				if (typeof init.value === 'bigint' && wtype2 === 'i64')
					return {type, init: [I[wtype2](init.value)]};
			}
		}
		throw `global '${name}' needs a compile-time-constant initializer`;
	});

	mod.datas			= [{ mode: 'passive', bytes: data.bytes }];
	if (tags.length)
		mod.tags		= tags;

	// Every closure literal's `funcIndex` is taken by `ref.func` at its creation site -- wasm requires any function referenced that way to be "declared" first, which a declarative element segment satisfies.
	if (closureLiterals.length)
		mod.elements = [{ mode: 'declarative', reftype: { ref: 'func', nullable: true }, funcIndices: closureLiterals.map(info => info.funcIndex) }];

	return mod;
}
