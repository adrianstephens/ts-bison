import * as TS from './ts-parser';
import * as JS from './js-parser';
import * as T from './type-utils';
import { Identifier, Literal } from '../common';
import { walk, hasMod, dropMod } from './walker';
import { makeChecker, SEVERITY } from './checker';
import { LoadedModule, ModuleLoader, ModuleOptionsDefault } from './module-loader';
import { TSoutput } from './tocode';

type Location		= JS.Location;
type Expr			= JS.Expr;
type BindingTarget	= JS.BindingTarget;
type Type			= TS.Type;
type Scope			= T.Scope;
const Scope			= T.Scope;

const CompilerOptionsDefault = {
//Type Checking
	allowUnreachableCode:					undefined,
	allowUnusedLabels:						undefined,
	alwaysStrict:							false,
	exactOptionalPropertyTypes:				undefined,
	noFallthroughCasesInSwitch:				undefined,
	noImplicitAny:							false,
	noImplicitOverride:						undefined,
	noImplicitReturns:						undefined,
	noImplicitThis:							false,
	noPropertyAccessFromIndexSignature:		undefined,
	noUncheckedIndexedAccess:				undefined,
	noUnusedLocals:							undefined,
	noUnusedParameters:						undefined,
	strict:									false,
	strictBindCallApply:					false,
	strictBuiltinIteratorReturn:			false,
	strictFunctionTypes:					false,
	strictNullChecks:						false,
	strictPropertyInitialization:			false,
	useUnknownInCatchVariables:				false,
//Modules
	...ModuleOptionsDefault,
//Emit
	declaration:							false,
	declarationDir:							undefined,
	declarationMap:							undefined,
	downlevelIteration:						undefined,
	emitBOM:								undefined,
	emitDeclarationOnly:					undefined,
	importHelpers:							undefined,
	inlineSourceMap:						undefined,
	inlineSources:							undefined,
	mapRoot:								undefined,
	newLine:								'lf',
	noEmit:									undefined,
	noEmitHelpers:							undefined,
	noEmitOnError:							undefined,
	outDir:									undefined,
	outFile:								undefined,
	preserveConstEnums:						undefined,
	removeComments:							undefined,
	sourceMap:								undefined,
	sourceRoot:								undefined,
	stripInternal:							undefined,
//JavaScript Support
	allowJs:								undefined,
	checkJs:								undefined,
	maxNodeModuleJsDepth:					0,
//Editor Support
	disableSizeLimit:						undefined,
	plugins:								undefined,
//Interop Constraints
	allowSyntheticDefaultImports:			undefined,
	erasableSyntaxOnly:						undefined,
	esModuleInterop:						undefined,
	forceConsistentCasingInFileNames:		true,
	isolatedDeclarations:					undefined,
	isolatedModules:						undefined,
	preserveSymlinks:						undefined,
	verbatimModuleSyntax:					undefined,
//Backwards Compatibility
	charset:								'utf8',
	importsNotUsedAsValues:					0,
	keyofStringsOnly:						undefined,
	noImplicitUseStrict:					undefined,
	noStrictGenericChecks:					undefined,
	out:									undefined,
	preserveValueImports:					undefined,
	suppressExcessPropertyErrors:			undefined,
	suppressImplicitAnyIndexErrors:			undefined,
//Language
	Environment:							undefined,
	emitDecoratorMetadata:					undefined,
	experimentalDecorators:					undefined,
	jsx:									'preserve',
	jsxFactory:								'React.createElement',
	jsxFragmentFactory:						'React.Fragment',
	jsxImportSource:						'react',
	lib:									undefined,
	libReplacement:							true,
	moduleDetection:						'auto',
	noLib:									undefined,
	reactNamespace:							'React',
	target:									'es5',
	useDefineForClassFields:				false,
//Compiler Diagnostics
	diagnostics:							undefined,
	explainFiles:							undefined,
	extendedDiagnostics:					undefined,
	generateCpuProfile:						'profile.cpuprofile',
	generateTrace:							undefined,
	listEmittedFiles:						undefined,
	listFiles:								undefined,
	noCheck:								undefined,
	traceResolution:						undefined,
//Projects
	composite:								undefined,
	disableReferencedProjectLoad:			undefined,
	disableSolutionSearching:				undefined,
	disableSourceOfProjectReferenceRedirect:undefined,
	incremental:							false,
	tsBuildInfoFile:						'.tsbuildinfo',
//Output Formatting
	noErrorTruncation:						undefined,
	preserveWatchOutput:					undefined,
	pretty:									true,
//Completeness
	skipDefaultLibCheck:					undefined,
	skipLibCheck:							undefined,
};

export type CompilerOptions1 = typeof CompilerOptionsDefault;
export type CompilerOptions = Partial<CompilerOptions1>;

export function FixOptions(options: CompilerOptions): CompilerOptions1 {
	return {
		...CompilerOptionsDefault,
		...options,
		// Normalize `target` to lower-case, as the TS parser expects.
		target: options.target?.toLowerCase() ?? CompilerOptionsDefault.target,
	};
}

const TARGET_DEFAULT_LIB: Record<string, string> = {
	es3: 	'lib',
	es5: 	'lib',
	es6: 	'lib.es6',
	es2015: 'lib.es6',
	es2016: 'lib.es2016.full',
	es2017: 'lib.es2017.full',
	es2018: 'lib.es2018.full',
	es2019: 'lib.es2019.full',
	es2020: 'lib.es2020.full',
	es2021: 'lib.es2021.full',
	es2022: 'lib.es2022.full',
	es2023: 'lib.es2023.full',
	es2024: 'lib.es2024.full',
	esnext: 'lib.esnext.full',
};

function libSpecs(options: CompilerOptions1): string[] {
	return	options.noLib ? []
		:	options.lib ? Array.isArray(options.lib) ? options.lib : [options.lib]
		:	['typescript/lib/' + (TARGET_DEFAULT_LIB[options.target.toLowerCase()] ?? TARGET_DEFAULT_LIB.es5)];
}

//-----------------------------------------------------------------------------
// TS to JS
//-----------------------------------------------------------------------------

// Plain JS has no `?` -- drops the `'optional'` tag from a `Param`'s modifiers while keeping any others (e.g.
// a parameter property's `public`/`readonly`, cleared separately by whichever caller also strips `modifiers`).
const dropOptional = (p: JS.Param<any>) => dropMod(p, 'optional');

export function TStoJS(ast: TS.Program) {
	return walk(ast, 
		//onStatement
		(stmt, process) => {
			switch (stmt.type) {
				case 'type_alias_decl':
				case 'interface_decl':
				case 'namespace_decl':
					return undefined;

				case 'export_decl':
					stmt = process(stmt);
					return stmt.declaration ? stmt : undefined;

				case 'function_decl':
					if (!stmt.body)
						return undefined;
					stmt = process(stmt);
					stmt.params.forEach(dropOptional);
					return stmt;

				case 'enum_decl': {
					stmt = process(stmt);
					let next = 0;
					return JS.VarDecl('const', {
						name: stmt.name,
						init: JS.ObjectExpr(stmt.members.map(m => {
							let value: Expr;
							if (m.init) {
								value = m.init;
								next = T.isLiteral(m.init, 'number') ? m.init.value + 1 : NaN;
							} else {
								value = Literal(next++);
							}
							return JS.Field(m.name, value);
						})),
					});
				}
				
				case 'var_decl':
					return stmt.ambient ? undefined : process(stmt);

				case 'class_decl':
					if (stmt.ambient)
						return undefined;
					stmt = process(stmt);
					stmt.body.forEach(m => {
						if (m.type === 'field') {
							delete m.modifiers;

						} else if (m.type === 'method') {
							if (m.key === 'constructor') {
								// A parameter-property modifier is anything but the unrelated `'optional'` tag
								// that can now also live in `modifiers` (see `Param`'s own comment).
								const prelude: JS.Statement<any>[] = m.params
									.filter((p) => p.modifiers?.some(x => x !== 'optional'))
									.map(p => ({
										type: 'expression',
										expression: {
											type: 'binary', operator: '=',
											left: { type: 'member', object: { type: 'this' }, property: p.key as string },
											right: { type: 'identifier', name: p.key as string },
										},
									})
								);
								if (prelude.length)
									m.body = [...prelude, ...m.body!];
							}

							for (const p of m.params)
								delete p.modifiers;
							delete m.modifiers;
						}
					});
					delete stmt.typeParams;
					delete stmt.implements;
					delete stmt.abstract;
					return stmt;

				default:
					return process(stmt);
			}

		},
		//onExpr
		(expr, process) => {
			switch (expr.type) {

				case 'function':
					expr = process(expr)!;
					expr.params.forEach(dropOptional);
					return expr;

				case 'arrow':
					expr = process(expr)!;
					expr.params.forEach(dropOptional);
					return expr;

				case 'class':
					return {...process(expr)!, typeParams: undefined, implements: undefined, abstract: undefined};

				case 'as':
				case 'satisfies':
				case 'instantiation':
					return process(expr.expression, true);

				case 'unary_post':
					return expr.operator === '!' ? process(expr.operand, true) : process(expr);

				default:
					return process(expr);
			}
		},
		//onType
		(_type, _process) => undefined
	);
}

// ===================================================================
//  TStypeCheck
// ===================================================================

export interface Diagnostic {
	severity:	SEVERITY;
	pos:		Location;
	message:	string;
}

function makeDiagnostic(func: (d: Diagnostic) => void) {
	const renderer	= new TSoutput;
	const clip		= (s: string, max = 60)	=> s.length > max ? s.slice(0, max - 3) + '...' : s;
	const toString	= (v: any) => v === undefined ? '' : typeof v === 'string' ? v : renderer.toCode(v);

	return (severity: SEVERITY, pos: JS.Location, strings: TemplateStringsArray, ...values: any[]) => func({
		severity,
		message: ['GAP', 'WRN', 'ERR'][severity] + ': ' + strings.map((s, i) => s + clip(toString(values[i]))).join(''),
		pos
	});
}

// Folds whatever `type-utils.ts`'s structural recursions (`resolve`/`lookupMember`/`isAssignable`/...) hit their depth
// budget on during this check into one summary GAP diagnostic -- see `T.takeDepthExhaustion`'s own comment for why not
// one diagnostic per occurrence.
function pushDepthExhaustionGap(diagnostics: Diagnostic[]) {
	const depthHits = T.takeDepthExhaustion();
	if (depthHits.size) {
		diagnostics.push({
			severity: SEVERITY.GAP,
			pos: { line: 1, col: 1 },
			message: 'GAP: recursion depth limit reached during structural type resolution ('
				+ [...depthHits].map(([fn, n]) => `${fn}×${n}`).join(', ')
				+ ') -- some assignability/member checks may be incomplete',
		});
	}
}

export function TStypeCheck(ast: TS.Program): Diagnostic[] {
	T.takeDepthExhaustion();	// discard any carry-over from a previous check in this same process (e.g. a corpus sweep)
	const diagnostics: Diagnostic[] = [];
	const checker = makeChecker(makeDiagnostic(d => diagnostics.push(d)));
	const global = T.makeGlobal();
	checker.checkBlock(ast.body, global, undefined);
	pushDepthExhaustionGap(diagnostics);
	return diagnostics;
}

// lib.*.d.ts content is cached at process lifetime already (`NodeModules.found`/`imported`, module-loader.ts) -- every
// `TStypeCheckAsync` call was re-hoisting that *same shared AST* into a *fresh* `Scope` anyway, and `stampScope`
// (type-utils.ts) mutates refs in place, skipping one that's already tagged. So whichever file got checked first
// permanently claimed the `declScope` on every lib-sourced ref for the rest of the process -- every later file's own
// lib refs carried a stale `declScope` pointing at an unrelated earlier file's `Scope`. Matching this cache's lifetime
// to the AST's (build once per distinct `libSpecs`, reuse the same `Scope` object for every file) fixes that at the
// source instead of working around it in `resolve()`. Safe to share: `global` only ever receives lib content here --
// a file's own declarations go into its own child `entryScope` (below), never into `global` itself.
// `skipLibCheck`/`skipDefaultLibCheck` only gate *diagnostic reporting* from inside the hoisted `.d.ts` content, not
// what gets hoisted -- the resulting `Scope` is identical either way, so it's deliberately not part of the cache key.
// A caller requesting `skipLibCheck: false` (nothing in this codebase does) would still have those diagnostics
// silently dropped once another call has already built the cache -- an accepted, narrow tradeoff for a flag nothing uses.
const libScopeCache = new Map<string, Promise<Scope>>();

async function getLibScope(loader: ModuleLoader, options: CompilerOptions1): Promise<Scope> {
	const key = libSpecs(options).join('\0');
	let cached = libScopeCache.get(key);
	if (!cached) {
		cached = (async () => {
			const checker = makeChecker(makeDiagnostic(() => {}));
			const global = T.makeGlobal();
			for (const spec of libSpecs(options)) {
				const lib = await loader.get(spec, '.');
				if (lib)
					checker.checkBlock(lib.body, global, true);
			}
			return global;
		})();
		libScopeCache.set(key, cached);
	}
	return cached;
}

// `tainted`: this module's own build (or one it transitively, successfully awaited) had to skip *something* because
// resolving it would have deadlocked on a genuine import cycle (see `importScopeCache`'s comment) -- the shape is
// real and usable, just incomplete in some way that isn't recorded more precisely than that.
interface ModuleShape { scope: Scope; value: Type; tainted: boolean }

// A module's built `Scope` is cached process-wide, matching `libScopeCache`'s reasoning: a `node_modules`/workspace
// package's `LoadedModule` is itself cached at process lifetime (`NodeModules`, module-loader.ts), so rebuilding a
// fresh `Scope` from it per file hit the same `declScope` staleness that motivated `libScopeCache`.
//
// One real complication a plain process-wide cache doesn't handle: `wouldDeadlock` tolerates a *genuine* import
// cycle (Node's own `fs` <-> `fs/promises` `.d.ts` graph references itself both ways, via their `node:`-prefixed
// aliases) by skipping whichever side of the cycle asks second -- relied on already, not new. Which side asks
// second depends on *resolution order*, which used to reset to nothing for every file (a fresh, empty `waitingFor`
// each `TStypeCheckAsync` call) -- so whichever side a given file happened to need most wasn't guaranteed to be the
// truncated one, but at least the decision was made fresh, per file, for that file's own entry point. Sharing
// `waitingFor` process-wide instead means the *very first* file to ever touch the cycle, from wherever it happens
// to enter, permanently decides which side comes back hollow for every other file for the rest of the process --
// and unlike a plain stale-`declScope` mismatch (same value, wrong scope object), a truncated cycle can genuinely
// lose real content (confirmed: entering via `fs/promises` first left `fs`'s own `promises` re-export empty).
// `tainted` tracks exactly this, propagated up through everything that awaited the truncated part, and
// `importScopeCache.delete` (in `makeScope`, below) evicts a tainted result once built rather than caching it --
// so it doesn't poison anyone downstream, and the next file to need it gets a genuinely fresh attempt (which,
// per the sequential-and-then-fully-settled nature of one `TStypeCheckAsync` call finishing before the next
// starts, sees an empty `waitingFor` again, same as the old per-file behavior). Non-circular modules -- the
// overwhelming majority -- are entirely unaffected and stay cached for real.
const importScopeCache = new Map<LoadedModule, Promise<ModuleShape>>();
const waitingFor = new Map<LoadedModule, Set<LoadedModule>>();

// `src`'s own hoisted declarations (imports resolved, `export ... from` re-exports NOT yet merged in), recorded
// synchronously the moment they're ready -- typically well before `importScopeCache`'s entry for the same module,
// since re-export merging is what can hit a genuine cycle. A regular `import` only ever needs a target's own
// declarations, never its re-exports, so `awaitScope`'s `fallbackToOwn` consults this to resolve what would
// otherwise look like a deadlock through the full `importScopeCache` path -- e.g. `factors.ts` importing
// `Polynomial` from `polynomial.ts`, which itself re-exports from `factors.ts`: not a genuine cycle at the
// declaration level, only in how eagerly the re-export merge waits on it.
// Deliberately a plain (not `Promise<...>`) map, checked synchronously, never awaited: if `waiter`'s own regular
// imports genuinely, mutually depend on `target` (an actual cycle, not just this one-directional re-export shape),
// `target`'s entry here won't exist yet either -- awaiting it would just deadlock on the very call in progress.
const ownScopeSettled = new Map<LoadedModule, { scope: Scope; value: Type; isAlias: boolean }>();

function wouldDeadlock(waiter: LoadedModule, target: LoadedModule): boolean {
	const seen = new Set<LoadedModule>([target]);
	const stack = [target];
	while (stack.length) {
		const cur = stack.pop()!;
		if (cur === waiter)
			return true;
		for (const next of waitingFor.get(cur) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				stack.push(next);
			}
		}
	}
	return false;
}

export async function TStypeCheckAsync(program: TS.Program, loader: ModuleLoader, options: CompilerOptions1) {
	T.takeDepthExhaustion();	// discard any carry-over from a previous check in this same process (e.g. a corpus sweep)
	const diagnostics: Diagnostic[] = [];
	const checker	= makeChecker(makeDiagnostic(d => diagnostics.push(d)));
	const global	= await getLibScope(loader, options);

	// Awaits `makeScope(target)` on `waiter`'s behalf, recording the wait so `wouldDeadlock` can see it -- or, if
	// awaiting would deadlock, skips without recursing further, returning `undefined`. `fallbackToOwn` (set only by
	// `resolveImport`, never by `makeScope`'s own `export ... from` handling) falls back to `target`'s own-scope-only
	// result instead: a plain `import` never needs `target`'s re-exports, just its own declarations, which are already
	// settled regardless of whether the deadlock is real or just an artifact of re-export merging waiting on `waiter`.
	async function awaitScope(waiter: LoadedModule, target: LoadedModule, fallbackToOwn = false): Promise<ModuleShape | undefined> {
		if (!wouldDeadlock(waiter, target)) {
			let waits = waitingFor.get(waiter);
			if (!waits)
				waitingFor.set(waiter, waits = new Set());
			waits.add(target);
			try {
				return await makeScope(target);
			} finally {
				waits.delete(target);
			}
		}
		const own = fallbackToOwn && ownScopeSettled.get(target);
		if (!own)
			return undefined;
		return { scope: own.scope, value: own.isAlias ? own.value : own.scope.toObject(), tainted: true };
	}

	// Resolves one `import` statement's bindings (default/namespace/named specifiers) from `imp.source` into `importScope`,
	// shared by `makeScope` (building a dependency's own import scope) and the entry program (which has no `makeScope`
	// call of its own, since nothing else ever imports it). `waiter` identifies who's asking, for `wouldDeadlock`.
	// Returns whether this import resolved *cleanly* (no cycle truncation, directly or in what it pulled in) --
	// `makeScope` folds these into its own `tainted` verdict.
	const resolveImport = async (waiter: LoadedModule, importScope: Scope, imp: JS.Import, from: string): Promise<boolean> => {
		const impSrc = await loader.get(imp.source, from);
		if (!impSrc) {
			diagnostics.push({ severity: 1, pos: (imp as any).pos, message: `Could not resolve import '${imp.source}'` });
			return true;	// unresolvable specifier, not a cycle -- nothing for `makeScope` to retry later
		}
		const resolved = await awaitScope(waiter, impSrc, true);
		if (!resolved)
			return false;	// genuine import cycle -- contribute nothing further rather than deadlock

		const { scope: impScope, value } = resolved;

		// `import X from 'mod'` (default import) -- independent of `namespace`/`specifiers` below (`import X, {y} from 'mod'` and
		// `import X, * as NS from 'mod'` both combine a default with the other form in the same statement). `checker.exportScope`
		// registers a module's default export under the literal key `'default'`; this is the only place that key is read back.
		if (imp.default)
			importScope.copy(impScope, 'default', imp.default, imp.typeOnly);

		if (imp.namespace) {
			importScope.addValue(imp.namespace, value);
			importScope.addNamespace(imp.namespace, impScope);
		} else {
			for (const spec of imp.specifiers ?? [])
				importScope.copy(impScope, spec.imported, spec.local, spec.typeOnly || imp.typeOnly);
		}
		return !resolved.tainted;
	};

	// The result of `makeScope` is a `Scope` containing precisely `src`'s exported symbols (values, types, and nested
	// namespaces alike), keyed by their public name -- callers never need to re-scan `src.body`'s statements themselves.
	// The one exception is `export ... from` re-exports: `checker.exportScope` only sees local declarations and same-file
	// `export {a, b}` (no `source`), since resolving a re-export's target needs the loader, which the checker itself
	// doesn't have -- so that part alone is still handled here, by folding the target's own (recursively resolved) scope
	// into this one.
	async function makeScope(src: LoadedModule): Promise<ModuleShape> {
		const existing = importScopeCache.get(src);
		if (existing)
			return existing;

		const importScope = new Scope(global);
		const cached = Promise.all(src.body.filter(s => s.type === 'import').map(s => resolveImport(src, importScope, s, src.canonical))).then(async imports => {
			let tainted = imports.some(clean => !clean);
			const { scope, value, isAlias } = checker.exportScope(src.body, importScope);
			// Recorded synchronously here, before the (possibly cyclic) re-export loop below ever awaits anything --
			// see `ownScopeSettled`'s own comment for why this specific placement is what makes the fallback safe.
			ownScopeSettled.set(src, { scope, value, isAlias });
			for (const stmt of src.body) {
				if (stmt.type !== 'export' || !stmt.source)
					continue;
				const target = await loader.get(stmt.source, src.canonical);
				if (!target)
					continue;
				const targetShape = await awaitScope(src, target);
				if (!targetShape) {
					tainted = true;
					continue;	// genuine circular re-export chain -- contribute nothing further rather than deadlock/recurse forever
				}
				tainted ||= targetShape.tainted;

				if (stmt.namespace) {
					// `export * as name from './x'`: one property holding the target's whole shape.
					scope.addValue(stmt.namespace, targetShape.value);
					scope.addNamespace(stmt.namespace, targetShape.scope);

				} else if (stmt.specifiers) {
					for (const spec of stmt.specifiers)
						scope.copy(targetShape.scope, spec.local, spec.exported, stmt.typeOnly || spec.typeOnly);
				} else {
					// bare `export * from './x'`: everything, as-is
					scope.copyAll(targetShape.scope, stmt.typeOnly);
				}
			}
			return { scope, value: isAlias ? value : scope.toObject(), tainted };
		});
		importScopeCache.set(src, cached);
		// Only ever cache a clean build -- a tainted one stays valid for whoever's already awaiting `cached` (they're
		// part of the same cyclic build attempt and would see the same truncation either way), but the next caller
		// with no reason to inherit this attempt's particular truncation gets a genuinely fresh one instead of this
		// poisoned result forever. Identity-checked before deleting: if a concurrent rebuild has already replaced
		// this entry (e.g. a prior attempt for the same `src` was itself evicted and rebuilt), this stale `.then`
		// firing later must not clobber whatever's there now.
		cached.then(result => { if (result.tainted && importScopeCache.get(src) === cached) importScopeCache.delete(src); });
		return cached;
	}

	// The entry program itself never goes through `makeScope` -- nothing else ever imports it, so it needs no cache entry
	// and no "exported symbols" view, just its own import bindings to check its body against. It's also not in
	// `importScopeCache`, so it needs its own stable identity object purely for `wouldDeadlock`'s bookkeeping.
	const entrySrc: LoadedModule = { body: program.body, canonical: '.' };
	const entryScope = new Scope(global);
	await Promise.all(program.body.filter(s => s.type === 'import').map(s => resolveImport(entrySrc, entryScope, s, '.')));

	checker.checkBlock(program.body, entryScope);
	pushDepthExhaustionGap(diagnostics);
	program.scope = entryScope;
	return diagnostics;
}

// ===================================================================
//  TStoDecl -- TypeScript AST to a .d.ts-shaped AST
// ===================================================================

// Resolves a (possibly dotted, `NS.Foo`) ref the same way `T.resolve`'s own `case 'ref'` walks it -- split on '.',
// hop through `scope.namespace(...)` for every segment but the last, then look the last one up as a type -- except
// this stops at one level (the raw `TypeEntry`, not `resolve`'s further recursive expansion): `qualifyForeignRefs`
// below needs the *un-expanded* target to search for by identity, not what it structurally reduces to.
function resolveRefEntry(ref: TS.RefType, scope: Scope): T.TypeEntry | undefined {
	const parts	= ref.name.split('.');
	for (const p of parts.slice(0, -1)) {
		const ns = scope.namespace(p);
		if (!ns)
			return undefined;
		scope = ns;
	}
	return scope.type(parts[parts.length - 1]);
}

// BFS from `root` through its own namespace imports (`bin`, then one hop further like `bin.interop`, ...) for one
// whose `.type(leaf)` is *the same object* as `target` -- name-only matching risks a false positive (two unrelated
// modules exporting an unrelated same-named type, which `export * from` re-exporting can genuinely collide on).
function findQualifiedPath(root: Scope, leaf: string, target: Type): string[] | undefined {
	const seen = new Set<Scope>([root]);
	let frontier: { scope: Scope; path: string[] }[] = [{ scope: root, path: [] }];
	while (frontier.length) {
		const next: typeof frontier = [];
		for (const { scope, path } of frontier) {
			for (const [name, ns] of scope.ownNamespaces()) {
				if (seen.has(ns))
					continue;
				seen.add(ns);
				const here = [...path, name];
				if (ns.type(leaf)?.type === target)
					return here;
				next.push({ scope: ns, path: here });
			}
		}
		frontier = next;
	}
	return undefined;
}

// A type inferred for an un-annotated declaration can embed a `ref` whose `declScope` is some *other* module's own
// scope (e.g. `uint16`'s inferred `{get: get<number>; ...}` names `get` from `@isopodlabs/binary`'s own
// `interop.d.ts`) -- printed bare, by `tocode.ts`'s ref case, that name doesn't exist in this file's own scope at
// all. Each such ref gets either requalified through whatever namespace import already reaches it (`get` ->
// `bin.interop.get`), or, if it's not actually exported from its module (a private helper type that some other
// export's inferred type happens to mention, e.g. binary's own unexported `FlagsObject`/`DiscrimSwitch`), inlined
// in place instead -- safe since a type alias carries no nominal identity worth preserving.
function qualifyForeignRefs(importScope: Scope) {
	// An unexported type inlined in place of a bare ref can itself be self- or mutually-recursive (a linked-list-shaped
	// alias, say) -- inlining loses the name that made that recursion finite, so re-entering the same `entry.type`
	// while it's still being expanded on this same path would recurse forever. Tracks only what's currently on the
	// stack (not "ever inlined"): the same type inlined again in an unrelated, sibling position is still fine.
	const inlining = new Set<Type>();

	return (type: Type, process: (t: Type, recall?: boolean) => Type | undefined): Type | undefined => {
		if (type.type !== 'ref' || !type.declScope)
			return process(type);

		const entry = resolveRefEntry(type, type.declScope as Scope);
		if (!entry)
			return process(type);	// unresolved (shouldn't happen for a real declScope) -- leave as printed

		const leaf = type.name.split('.').pop()!;
		if (importScope.type(leaf)?.type === entry.type)
			return process(type);	// already reachable unqualified from the printed file's own scope

		const path = findQualifiedPath(importScope, leaf, entry.type);
		if (path)
			return process(TS.RefType([...path, leaf].join('.'), type.typeArgs));

		if (inlining.has(entry.type))
			return process(type);	// recursive inline -- give up and leave the unreachable bare name rather than loop forever

		inlining.add(entry.type);
		try {
			return process(entry.typeParams?.length
				? T.substituteType(entry.type, new Map(entry.typeParams.map((p, i) => [p.name, type.typeArgs?.[i] ?? p.default ?? T.ANY])))
				: entry.type, true);	// recall -- the inlined subtree's own nested refs need this same treatment
		} finally {
			inlining.delete(entry.type);
		}
	};
}

export function TStoDecl(ast: TS.Program): TS.Program {
	const importScope = ast.scope as Scope | undefined;

	// ---- Gathering every top-level declaration, and the explicitly-exported roots ------------------

	type Owner = TS.Statement | JS.VarDeclarator<any>;
	class Owners extends Map<string, Owner[]> {
		add(name: string, owner: Owner) {
			this.set(name, [...(this.get(name) ?? []), owner]);
		}
	}

	const owners	= new Owners;
	const roots		= new Set<string>();

	// Registers a statement's own name(s) into `owners`, and -- if `exported` -- into `roots` too.
	const registerDecl = (stmt: TS.Statement, exported: boolean) => {
		switch (stmt.type) {
			case 'function_decl':
			case 'class_decl':
			case 'interface_decl':
			case 'type_alias_decl':
			case 'enum_decl':
			case 'namespace_decl':
				owners.add(stmt.name, stmt);
				if (exported)
					roots.add(stmt.name);
				break;
			case 'var_decl':
				for (const d of stmt.declarations) {
					for (const name of T.bindingNames(d.name)) {
						owners.add(name, d);
						if (exported)
							roots.add(name);
					}
				}
				break;
			default:
				break;
		}
	};

	for (const stmt of ast.body) {
		if (stmt.type === 'export') {
			if (stmt.default?.type === 'identifier')
				roots.add(stmt.default.name);
			else if (stmt.specifiers && !stmt.source)
				stmt.specifiers.forEach(s => roots.add(s.local));
		} else if (stmt.type === 'export_decl') {
			registerDecl(stmt.declaration, true);
		} else {
			registerDecl(stmt, false);
		}
	}


	// ---- Final rebuild: strip bodies/initializers, keep only what's reachable ----------------------

	const checker		= makeChecker(()=>{});
	const global		= importScope ? new Scope(importScope) : T.makeGlobal();
	checker.checkBlock(ast.body, global);

	// `undefined` (rather than an explicit `: any` annotation) keeps unknowable types implicit, as before
	const inferType		= (e: Expr, narrow: boolean): Type | undefined => {
		const t = narrow ? checker.typeOf(e, global) : T.widenLiterals(checker.typeOf(e, global));
		return t.type === 'ref' && t.name === 'any' ? undefined : t;
	};

	const stripBindingDefaults = (t: BindingTarget): BindingTarget => {
		if (typeof t === 'string')
			return t;
		if (t.type === 'object_pattern')
			return { ...t, properties: t.properties.map(p => ({ ...p, value: stripBindingDefaults(p.value), default: undefined })) };
		return { ...t, elements: t.elements.map(el => el && ({ ...el, target: stripBindingDefaults(el.target), default: undefined })) };
	};
	const stripParam = (p: JS.Param<any>): JS.Param<any> => ({ ...p,
		key:			stripBindingDefaults(p.key),
		typeAnnotation: p.typeAnnotation ?? (p.default && inferType(p.default, false)),
		default:		undefined,
		modifiers:		hasMod(p, 'optional') || !!p.default ? ['optional'] : []
	});

	const PROMISE_TYPES		= new Set(['Promise']);
	const GENERATOR_TYPES	= new Set(['Generator', 'IterableIterator', 'Iterator', 'Iterable']);

	const stripFunctionDecl = (stmt: JS.FunctionDecl<any>): JS.Declaration<any> => {
		const returnType: Type = stmt.returnType ? stmt.returnType as Type : stmt.body ? checker.inferReturn(stmt, stmt.body, global) : T.ANY;
		return JS.FunctionDecl(stmt.name, {
			params:		stmt.params.map(stripParam),
			typeParams:	stmt.typeParams,
			returnType: hasMod(stmt, 'async')		? T.wrapType(returnType, PROMISE_TYPES, 'Promise')
					:	hasMod(stmt, 'generator')	? T.wrapType(returnType, GENERATOR_TYPES, 'Generator')
					:	returnType
		}, undefined, {ambient: true});
	};

	const stripClassDecl = (stmt: JS.ClassDecl<any>): JS.Declaration<any> => {
		const setKeys	= new Set(stmt.body.map(m => m.type === 'set' && typeof m.key === 'string' ? m.key : undefined).filter(m => m !== undefined));
		const seen		= new Set<string>();
		const extra:	TS.ClassMember[] = [];

		const body = (stmt.body as TS.ClassMember[]).map((m): TS.ClassMember | undefined => {
			switch (m.type) {
				case 'field':
				return JS.Field(m.key, undefined, m.typeAnnotation ?? (m.value && inferType(m.value, false)) ?? T.ANY);

			case 'get':
				if (typeof m.key === 'string') {
					if (seen.has(m.key))
						return undefined;
					seen.add(m.key);
				}
				return JS.Field(m.key, undefined, m.returnType ?? T.ANY, typeof m.key === 'string' && !setKeys.has(m.key) ? ['readonly'] : undefined);

			case 'set':
				if (typeof m.key === 'string') {
					if (seen.has(m.key))
						return undefined;
					seen.add(m.key);
				}
				return JS.Field(m.key, undefined, m.params[0]?.typeAnnotation ?? T.ANY);

			case 'method':
				if (m.key === 'constructor') {
					for (const p of m.params) {
						if (hasMod(p, 'public') || hasMod(p, 'private') || hasMod(p, 'protected') || hasMod(p, 'readonly'))
							extra.push(JS.Field(typeof p.key === 'string' ? p.key : '?', undefined, p.typeAnnotation, p.modifiers));
					}
					return JS.Method('method', m.key, {params: m.params.map(stripParam), rest: m.rest, typeParams: m.typeParams});
				}
				return JS.Method('method', m.key, {
					params:		m.params.map(stripParam),
					rest:		m.rest,
					returnType: m.returnType ?? (m.body ? checker.inferReturn(m, m.body, global) : undefined),
					typeParams: m.typeParams
				}, undefined, m.modifiers);
			}
			return undefined;
		}).filter(m => m !== undefined).concat(...extra) as JS.ClassMember<any>[];
		return { ...stmt, body, ambient: true};
	};

	// A destructured declarator (`const {a, b} = x;`) can't survive into a .d.ts as one statement -- ambient declarations have no initializer to
	// destructure from. Split into one simple-name declarator per bound name instead (`declare const a: any, b: any;`), each typed `any`.
	const stripVarDeclarator = (d: JS.VarDeclarator<any>, narrow: boolean): JS.VarDeclarator<any>[] => typeof d.name === 'string'
		? [{...d,
			typeAnnotation: (d.typeAnnotation as Type | undefined) ?? (d.init && inferType(d.init, narrow)) ?? { type: 'ref', name: 'any' },
			init: undefined,
		}]
		: T.bindingNames(d.name).map(name => ({ name, typeAnnotation: T.ANY }));


	const collectDeclRefs = (owner: TS.Statement|Expr|Type, refs: Set<string>) => {
		walk(owner, 
			(s, process) => {
				switch (s.type) {
					case 'class_decl':
						return process(stripClassDecl(s));
					case 'function_decl':
						return process(stripFunctionDecl(s));
				}
				return process(s);
			},
			(e, process) => {
				if (e.type === 'identifier')
					refs.add(e.name.split('.')[0]);
				return process(e);
			},
			(t, process) =>{
				if (t.type === 'ref')
					refs.add(t.name.split('.')[0]);
				return process(t);
			}
		);
	};

	const reachable = new Set<string>(roots);
	const worklist	= [...roots];
	while (worklist.length) {
		const refs = new Set<string>();
		for (const owner of owners.get(worklist.pop()!) ?? []) {
			if ('type' in owner) {
				collectDeclRefs(owner, refs);
			} else {
				if (owner.init)
					collectDeclRefs(owner.init, refs);
				if (owner.typeAnnotation)
					collectDeclRefs(owner.typeAnnotation as Type, refs);
			}
		}
		for (const ref of refs) {
			if (!reachable.has(ref)) {
				reachable.add(ref);
				worklist.push(ref);
			}
		}
	}

	const isReachable = (stmt: TS.Declaration) => {
		switch (stmt.type) {
			case 'function_decl':
			case 'class_decl':
			case 'interface_decl':
			case 'type_alias_decl':
			case 'enum_decl':
			case 'namespace_decl':
				return reachable.has(stmt.name);
			case 'var_decl':
				return stmt.declarations.some(d => T.bindingNames(d.name).some(n => reachable.has(n)));
			default:
				return false;
		}
	};

	const processNamedDecl = (stmt: TS.Declaration): TS.Declaration => {
		switch (stmt.type) {
			case 'function_decl':	return stripFunctionDecl(stmt);
			case 'class_decl':		return stripClassDecl(stmt);
			case 'interface_decl':
			case 'type_alias_decl':
			case 'enum_decl':
			case 'namespace_decl':
			case 'module_decl':
			case 'export_assignment':
				return stmt;
			case 'var_decl': {
				return { ...stmt,
					ambient:		true,
					declarations:	stmt.declarations
						.filter(d => T.bindingNames(d.name).some(n => reachable.has(n)))
						.flatMap(d => stripVarDeclarator(d, stmt.kind === 'const'))
				 };
			}
		}
	};

	const result: TS.Program = {
		type: 'program',
		body: ast.body.map((stmt: TS.Statement): TS.Statement|undefined => {
			switch (stmt.type) {
				case 'import':
					if (stmt.specifiers) {
						const spec = stmt.specifiers!.filter(s => reachable.has(s.local));
						if (!spec.length)
							return undefined;
						return { ...stmt, specifiers: spec};

					} else if (stmt.namespace) {
						if (!reachable.has(stmt.namespace))
							return undefined;
					}
					return stmt;

				case 'export_decl': {
					const decl = stmt.declaration as JS.Declaration<any>;
					if (isReachable(decl))
						return { type: 'export_decl', declaration: processNamedDecl(decl) as JS.Declaration<any> };
					return undefined;
				}

				case 'export':
					if (stmt.default) {
						switch (stmt.default.type) {
							case 'identifier':
								return stmt;
							case 'function_decl':
								return { ...stmt, default: stripFunctionDecl(stmt.default) };
							case 'class_decl':
								return { ...stmt, default: stripClassDecl(stmt.default) };
							case 'function':
								if (stmt.default.name)
									return { ...stmt, default: stripFunctionDecl(JS.FunctionDecl(stmt.default.name, stmt.default))};
								//fallthrough
							default:
								// Anonymous default export -- ambient declarations can't have an inline value, so synthesize a name, the same trick `tsc` uses.
								return { type: 'export', default: Identifier('_default') };
						}
					}
					return stmt;

				default:
					if (isReachable(stmt as JS.Declaration<any>))
						return processNamedDecl(stmt as unknown as JS.Declaration<any>);
					return undefined;
			}
		}).filter(s => s !== undefined)
	};

	return importScope ? walk(result, undefined, undefined, qualifyForeignRefs(importScope))! : result;
}
