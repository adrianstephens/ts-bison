import * as TS from './ts-parser';
import * as JS from './js-parser';
import * as JSX from './jsx-parser';
import * as T from './type-utils';
import { Identifier, Literal, Binary } from '../common';
import { walk, hasMod, dropMod } from './walker';
import { makeChecker, SEVERITY } from './checker';
import { LoadedModule, ModuleLoader, ModuleOptionsDefault } from './module-loader';
import { Output } from './tocode';

type Location		= JS.Location;
type Expr			= JS.Expr;
type BindingTarget	= JS.BindingTarget;
type Type			= TS.Type;
type Scope			= T.Scope;
const Scope			= T.Scope;

type JSX = 'preserve' | 'react-jsx' | 'react-jsxdev'	| 'automatic' | 'react' | 'classic';

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
	newLine:								'\n',
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
	jsx:									'preserve' satisfies JSX,
	jsxFactory:								'React.createElement',
	jsxFragmentFactory:						'React.Fragment',
	jsxImportSource:						'react',
	lib:									undefined as string[] | undefined,
	libReplacement:							true,
	moduleDetection:						'auto',
	noLib:									false,
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

export function FixOptions(options: CompilerOptions): CompilerOptions1 {
	const target	= options.target?.toLowerCase() ?? CompilerOptionsDefault.target;
	const lib		= options.lib ? Array.isArray(options.lib) ? options.lib : [options.lib]
		:	options.noLib ? []
		:	['typescript/lib/' + (TARGET_DEFAULT_LIB[target] ?? TARGET_DEFAULT_LIB.es5)];

	return {
		...CompilerOptionsDefault,
		...options,
		target,
		lib
	};
}

// Leading whitespace/comments/shebang -- matches js-parser.ts's own lexer `skip` list, so real tsc pragma scope.
const reLeadingTrivia = /^(?:#![^\n]*\n)?(?:\s+|\/\/[^\n]*|\/\*[^]*?\*\/)*/;
const rePragmaTag = /@(\w+)\s+(\S+)/g;

// `@tag value` pragmas in the file's leading trivia -- same scope real tsc uses, no built-in tag knowledge here.
export function scanPragmas(source: string): Record<string, string> {
	const pragmas: Record<string, string> = {};
	rePragmaTag.lastIndex = 0;
	for (let m; (m = rePragmaTag.exec(source)); )
		pragmas[m[1]] = m[2];
	return pragmas;
}

// Tag -> compiler option for known pragmas; add an entry to support a new one.
const pragmaOptionKey = {
	jsx:				'jsxFactory',
	jsxFrag:			'jsxFragmentFactory',
	jsxImportSource:	'jsxImportSource',
} as const satisfies Record<string, keyof CompilerOptions1>;

export function applyPragmas(source: string, options: CompilerOptions1) {
	const leading = reLeadingTrivia.exec(source)?.[0] ?? '';
	for (const [tag, value] of Object.entries(scanPragmas(leading))) {
		if (tag in pragmaOptionKey)
			options[pragmaOptionKey[tag as keyof typeof pragmaOptionKey]] = value;
	}
}

//-----------------------------------------------------------------------------
// TS to JS
//-----------------------------------------------------------------------------

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
										expression: Binary('=',
											{ type: 'member', object: { type: 'this' }, property: p.key as string } as Expr,
											Identifier(p.key as string),
										),
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
	const renderer	= new Output;
	const clip		= (s: string, max = 60)	=> s.length > max ? s.slice(0, max - 3) + '...' : s;
	const toString	= (v: any) => v === undefined ? '' : typeof v === 'string' ? v : renderer.toCode(v);

	return (severity: SEVERITY, pos: JS.Location, strings: TemplateStringsArray, ...values: any[]) => func({
		severity,
		message: ['GAP', 'WRN', 'ERR'][severity] + ': ' + strings.map((s, i) => s + clip(toString(values[i]))).join(''),
		pos
	});
}

// Folds any depth-budget hits from type-utils.ts's structural recursion into one summary GAP diagnostic, not one per occurrence.
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
	ast.scope = global;
	return diagnostics;
}

// Cached per `libSpecs`, not per-call -- `stampScope` (type-utils.ts) mutates lib refs in place, so a fresh `Scope`
// per file left every ref pointing at whichever file's `Scope` got there first.
const libScopeCache = new Map<string, Promise<Scope>>();

async function getLibScope(loader: ModuleLoader, options: CompilerOptions1): Promise<Scope> {
	const key = options.lib!.join(';');
	let cached = libScopeCache.get(key);
	if (!cached) {
		cached = (async () => {
			const checker = makeChecker(makeDiagnostic(() => {}));
			const global = T.makeGlobal();
			for (const spec of options.lib!) {
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

// `tainted`: this build (or one it awaited) had to skip something to avoid deadlocking on a genuine import cycle -- real and usable, just incomplete.
interface ModuleShape { scope: Scope; value: Type; tainted: boolean }

// Process-wide, like `libScopeCache`. A genuine cycle (e.g. Node's `fs`<->`fs/promises` `.d.ts` graph) truncates
// whichever side asks second; `tainted` marks that so it's evicted instead of poisoning later callers.
const importScopeCache	= new Map<LoadedModule, Promise<ModuleShape>>();
const waitingFor		= new Map<LoadedModule, Set<LoadedModule>>();

// Own declarations recorded before re-export merging (the part that can cycle) -- lets a plain `import`'s deadlock
// fallback (`awaitScope`'s `fallbackToOwn`) resolve from here instead, since imports never need re-exports.
const ownScopeSettled	= new Map<LoadedModule, { scope: Scope; value: Type; isAlias: boolean }>();

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

// `func` must be awaited *inside* this try -- calling an async function returns immediately (it doesn't block
// until its first await), so awaiting only at the call site would run `finally` before `func` actually finishes,
// collapsing the window `wouldDeadlock` relies on to detect a real in-progress cycle.
async function safely<T>(waiter: LoadedModule, target: LoadedModule, func: () => Promise<T>): Promise<T | undefined> {
	if (wouldDeadlock(waiter, target))
		return undefined;

	let waits = waitingFor.get(waiter);
	if (!waits)
		waitingFor.set(waiter, waits = new Set());
	waits.add(target);
	try {
		return await func();
	} finally {
		waits.delete(target);
	}
}

export async function TStypeCheckAsync(program: TS.Program, loader: ModuleLoader, options: CompilerOptions1) {
	T.takeDepthExhaustion();	// discard any carry-over from a previous check in this same process (e.g. a corpus sweep)
	const diagnostics: Diagnostic[] = [];
	const checker	= makeChecker(makeDiagnostic(d => diagnostics.push(d)));
	const global	= await getLibScope(loader, options);

	// Resolves one `import` into `importScope` (shared by `makeScope` and the entry program); return value feeds
	// `makeScope`'s own `tainted` verdict (false = cycle truncation).
	const resolveImport = async (waiter: LoadedModule, importScope: Scope, imp: JS.Import, from: string): Promise<boolean> => {
		const impSrc = await loader.get(imp.source, from);
		if (!impSrc) {
			diagnostics.push({ severity: 1, pos: (imp as any).pos, message: `Could not resolve import '${imp.source}'` });
			return true;	// unresolvable specifier, not a cycle -- nothing for `makeScope` to retry later
		}
		let resolved = await safely(waiter, impSrc, () => makeScope(impSrc));
		if (!resolved) {
			const own = ownScopeSettled.get(impSrc);
			if (!own)
				return false;	// genuine import cycle -- contribute nothing further rather than deadlock
			resolved = { scope: own.scope, value: own.isAlias ? own.value : own.scope.toObject(), tainted: true };
		}

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

	// Returns `src`'s exported symbols as one `Scope`; also resolves `export ... from` re-exports here, since only
	// this has the loader that `checker.exportScope` doesn't.
	async function makeScope(src: LoadedModule): Promise<ModuleShape> {
		const existing = importScopeCache.get(src);
		if (existing)
			return existing;

		const importScope = new Scope(global);
		const cached = Promise.all(src.body.filter(s => s.type === 'import').map(s => resolveImport(src, importScope, s, src.canonical))).then(async imports => {
			let tainted = imports.some(clean => !clean);
			const { scope, value, isAlias } = checker.exportScope(src.body, importScope);
			// Recorded before the (possibly cyclic) re-export loop awaits anything -- see `ownScopeSettled` for why placement matters.
			ownScopeSettled.set(src, { scope, value, isAlias });
			for (const stmt of src.body) {
				if (stmt.type !== 'export' || !stmt.source)
					continue;
				const target = await loader.get(stmt.source, src.canonical);
				if (!target)
					continue;
				const targetShape = await safely(src, target, () => makeScope(target));
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
		// Caches only clean builds; a tainted one stays valid for concurrent awaiters, then gets evicted (identity-checked,
		// so a stale rebuild can't clobber a newer entry) so the next caller gets a fresh attempt.
		cached.then(result => {
			if (result.tainted && importScopeCache.get(src) === cached)
				importScopeCache.delete(src);
		});
		return cached;
	}

	// The entry program never goes through `makeScope` (nothing imports it) -- just its own stable identity for `wouldDeadlock`'s bookkeeping.
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

// The type-node kinds `T.resolve` can actually simplify -- constructs with no printable name of their own
// (unlike a plain `ref`, which should stay a name rather than get flattened to its structural body).
const RESOLVABLE = new Set(['mapped', 'conditional', 'indexed_access', 'keyof', 'typeof']);

// Combines two passes over the printed type tree, since `walk` takes one `onType` callback:
//  1. Requalifies a `ref` pointing at another module's scope (e.g. an inferred type naming an unexported
//     helper) through whatever namespace import reaches it, or inlines it in place if nothing does.
//  2. Resolves otherwise-unprintable constructs (`mapped`/`conditional`/`indexed_access`/`keyof`/`typeof`)
//     to their structural result via `T.resolve` -- the tison analogue of a tsc transform calling
//     `typeChecker.typeToTypeNode` instead of re-emitting the raw syntax.
// Plain named refs (interfaces/classes/type aliases) are deliberately left as names rather than expanded --
// matches real declaration emit (which preserves alias identity) and avoids flattening self-referential types.

function resolveTypes(entryScope: Scope, importScope: Scope | undefined) {
	// Tracks (alias, first type-argument) pairs currently on the inline/resolve stack -- not "ever expanded",
	// since a type can be self/mutually recursive and re-entering it while still expanding would loop forever.
	// Keyed on the *argument* too, not just the alias: a generic like `ReadType<T>` legitimately re-enters
	// itself once per nested field with a *different* T -- that's ordinary finite recursion, not a cycle: only
	// re-entering with the exact same argument is. The argument is keyed by `T.typeKey` (structural, printed-code
	// equality), not object identity -- `T.substituteType` builds a fresh object at every instantiation step even
	// when the same logical type genuinely recurs, so a reference-identity key would never catch a real cycle.
	const inlining = new Map<Type, Set<string | undefined>>();
	let depth = 0;	// nesting depth across *all* active inlines, not per-alias -- distinct from the per-(alias,argument) cycle check just above: bounds legitimately deep but finite recursion (real generic helper libraries chain many distinct instantiations), which the cycle check alone wouldn't catch since each level's argument genuinely differs.
	let scope = entryScope;	// ambient scope for scope-less constructs (`typeof`, `mapped`'s `keyof` &c) -- tracks whichever module's body we're currently inlining through

	// Thrown when a computed-type unwrap's own cycle guard (or the depth cap) fires (see the `RESOLVABLE` branch
	// below) -- caught only by the top-level call that started the chain, which reverts to printing the original
	// ref rather than committing to a partial expansion that dangles on an inaccessible self-recursive helper
	// (e.g. a computed type built from a discriminated union of specs, recursing through an unexported helper).
	class ComputedCycle {}

	const MAX_DEPTH = 40;

	return (type: Type, process: (t: Type, recall?: boolean) => Type | undefined): Type | undefined => {
		if (type.type === 'ref' && type.declScope) {
			const declScope	= type.declScope as Scope;
			const entry		= declScope.lookupType(type.name);
			if (entry) {
				// Requalifies this ref through whatever namespace import reaches it (e.g. `ReadType` -> `bin.ReadType`),
				// or down to its bare leaf name if that alone already reaches it unqualified (e.g. a type declared in
				// *this* module but referenced via `pe.PE` from within a signature written in some other module that
				// imports this one as a namespace -- printed from this module's own perspective, `pe.` would be circular
				// nonsense). Tried whenever we're not going to fully unwrap the ref in place -- either because its body
				// isn't a nameless computed construct to begin with, or because unwrapping it bailed on a cycle/depth-
				// exhaustion -- so neither the wrong qualifier nor a fully-bare foreign name ends up in the output just
				// because the unwrap attempt gave up partway through.
				const requalify = (): Type | undefined => {
					if (!importScope)
						return undefined;
					const leaf = type.name.split('.').pop()!;
					// Reference-identity match, same as `findQualifiedPath` -- the normal case.
					if (importScope.type(leaf)?.type === entry.type)
						return leaf === type.name ? process(type) : process(TS.RefType(leaf, type.typeArgs));
					const path = importScope.findQualifiedPath(leaf, entry.type);
					if (path)
						return process(TS.RefType([...path, leaf].join('.'), type.typeArgs));
					// Neither matched by identity -- a genuine import cycle (this module importing, directly or
					// transitively, whatever declared `type`) settles one side for an independently-checked view
					// of the other, so a *type declared in this very module* can come back as a non-identical
					// object when referenced from within the cyclic partner. Same leaf name in this module's own
					// top-level scope is as good a signal as we get short of structural equality -- print bare.
					return importScope.type(leaf) ? process(TS.RefType(leaf, type.typeArgs)) : undefined;
				};

				// A ref whose own declared body is itself a nameless "computed" construct (mapped/conditional/&c,
				// e.g. a type-level function like `bin.ReadType<T>`) never gets a stable printable identity in
				// real TS either -- unwrap it one level rather than printing a name that just hides the
				// computation the reader actually wants to see.
				// `topLevel`/the try-catch wrap *both* branches below, not just the `RESOLVABLE` one -- a
				// `ComputedCycle` thrown deep inside a foreign/unreachable (`else`-branch) inline still has to
				// unwind to here, since that branch's own `inlineEntry` call has nothing to catch it locally.
				const topLevel = inlining.size === 0;
				try {
					const resolvable = RESOLVABLE.has(entry.type.type);
					if (!resolvable) {
						const r = requalify();
						if (r !== undefined)
							return r;
					}

					// Substitutes `typeArgs` into `entry`'s declared body and recurses into it -- cycle-guarded, since an
					// unexported or computed type can be self/mutually recursive. `bail`: throw `ComputedCycle` instead of
					// quietly stopping, for the `RESOLVABLE` chain, which has nothing sensible to fall back to mid-expansion.

					const argKey	= type.typeArgs?.[0] && T.typeKey(type.typeArgs[0]);
					const active	= inlining.get(entry.type);
					if (active?.has(argKey) || depth >= MAX_DEPTH) {
						if (resolvable)
							throw new ComputedCycle;
					} else {
						const set = active ?? new Set<string | undefined>();
						if (!active)
							inlining.set(entry.type, set);
						set.add(argKey);
						++depth;
						const savedScope = scope;
						scope = declScope;
						try {
							return process(entry.typeParams?.length
								? T.substituteType(entry.type, new Map(entry.typeParams.map((p, i) => [p.name, type.typeArgs?.[i] ?? p.default ?? T.ANY])))
								: entry.type
								, true);
						} finally {
							scope = savedScope;
							--depth;
							set.delete(argKey);
							if (!set.size)
								inlining.delete(entry.type);
						}
					}
				} catch (e) {
					if (!topLevel || !(e instanceof ComputedCycle))
						throw e;
					// The resolvable unwrap bailed -- still worth requalifying (e.g. `ReadType` -> `bin.ReadType`)
					// before giving up to the original, possibly-unreachable-as-written bare ref.
					const r = requalify();
					if (r !== undefined)
						return r;
				}
			}
			return process(type);
		}

		if (RESOLVABLE.has(type.type)) {
			// `stopAtRef` -- once resolution bottoms out at a named type (e.g. a conditional's chosen branch is just
			// `MappedMemory`), print that name rather than recursing one hop further into its structural body.
			const resolved = T.resolve(scope, type, undefined, true);
			if (resolved !== type) {
				const found = scope.findDeclaredName(resolved);
				return process(found ? T.withScope(TS.RefType(found.name), found.scope) : resolved, true);	// recall
			}
		}
		return process(type);
	};
}
	// A single generic type parameter constrained to a union of literals, used directly (unparameterized) as exactly
	// one parameter's type, expands into one non-generic overload per literal member -- each overload's return type
	// collapses toward its own concrete result (e.g. a conditional keyed off the now-literal T narrows to one table
	// entry) instead of the printed signature needing to expose whatever machinery type (often a big lookup table)
	// computed the generic return for every member at once.
function expandConstrainedGeneric(typeParams: TS.TypeParam[] | undefined, params: JS.Param<any>[], returnType: Type | undefined, scope: Scope) {
	const tparam = typeParams?.length === 1 ? typeParams[0] : undefined;
	if (!tparam?.constraint)
		return undefined;
	let target: JS.Param<any> | undefined;
	for (const p of params) {
		if (p.typeAnnotation?.type === 'ref' && !p.typeAnnotation.typeArgs && p.typeAnnotation.name === tparam.name) {
			if (target)
				return undefined;	// ambiguous -- more than one param depends directly on T
			target = p;
		}
	}
	if (!target)
		return undefined;

	const constraint	= T.resolve(scope, tparam.constraint);
	const members		= constraint.type === 'union' ? constraint.types : [constraint];
	if (!members.every(m => T.isLiteral(m, 'string') || T.isLiteral(m, 'number')))
		return undefined;

	return members.map(m => ({
		params:		params.map(p => p === target ? { ...p, typeAnnotation: m } : p),
		returnType:	returnType && T.expandRefOnce(scope, T.substituteType(returnType, new Map([[tparam.name, m]]))),
	}));
}

export function TStoDecl(ast: TS.Program): TS.Program {
	const importScope = ast.scope as Scope | undefined;

	// ---- Gathering every top-level declaration, and seeding `reachable` with the explicit exports ----

	type Owner = TS.Statement | JS.Var<any>;
	class Owners extends Map<string, Owner[]> {
		exported	= false;
		add(name: string, owner: Owner) {
			this.set(name, [...(this.get(name) ?? []), owner]);
			if (this.exported)
				reachable.add(name);
		}
	}

	const owners	= new Owners;
	const reachable = new Set<string>();

	// ---- Shared checking/resolution machinery, needed by the strip helpers below --------------------

	const checker	= makeChecker(()=>{});
	const global	= importScope ? new Scope(importScope) : T.makeGlobal();
	checker.checkBlock(ast.body, global);

	// A class whose heritage is a call expression (e.g. `bin.Class(spec)`) can't keep that expression in a
	// `declare class` -- collected here and prepended to `stripped`'s body (below) as `declare const <Name>_base:
	// <computed type>;` ahead of the class, which then just extends the name (mirrors how tsc's own declaration
	// emitter handles this). Names tracked separately so they can be seeded into `reachable`, below -- a
	// synthesized base is always wanted whenever its class is, but nothing else ever references it by name for
	// the normal reachability walk to find on its own.
	const syntheticBases: TS.Statement[] = [];

	// Cheap, non-recursive scan of every top-level name -- seeded before any stripping starts, so a
	// synthesized base name can't collide with a real declaration the single pass below hasn't reached yet.
	const usedNames = new Set<string>();
	for (let stmt of ast.body) {
		if (stmt.type === 'export_decl')
			stmt = stmt.declaration;
		switch (stmt.type) {
			case 'function_decl': case 'class_decl': case 'interface_decl':
			case 'type_alias_decl': case 'enum_decl': case 'namespace_decl':
				usedNames.add(stmt.name);
				break;
			case 'var_decl':
				for (const d of stmt.declarations)
					for (const name of T.bindingNames(d.name))
						usedNames.add(name);
				break;
		}
	}
	const uniqueName = (base: string) => {
		let name = base;
		for (let n = 1; usedNames.has(name); n++)
			name = base + n;
		usedNames.add(name);
		return name;
	};

	// ---- Strip helpers -------------------------------------------------------------------------------

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

		const body = (stmt.body as TS.ClassMember[]).flatMap((m): TS.ClassMember[] => {
			switch (m.type) {
				case 'field':
					return [JS.Field(m.key, undefined, m.typeAnnotation ?? (m.value && inferType(m.value, false)) ?? T.ANY)];

				case 'get':
					if (typeof m.key === 'string') {
						if (seen.has(m.key))
							return [];
						seen.add(m.key);
					}
					return [JS.Field(m.key, undefined, m.returnType ?? T.ANY, typeof m.key === 'string' && !setKeys.has(m.key) ? ['readonly'] : undefined)];

				case 'set':
					if (typeof m.key === 'string') {
						if (seen.has(m.key))
							return [];
						seen.add(m.key);
					}
					return [JS.Field(m.key, undefined, m.params[0]?.typeAnnotation ?? T.ANY)];

				case 'method': {
					if (m.key === 'constructor') {
						for (const p of m.params) {
							if (hasMod(p, 'public') || hasMod(p, 'private') || hasMod(p, 'protected') || hasMod(p, 'readonly'))
								extra.push(JS.Field(typeof p.key === 'string' ? p.key : '?', undefined, p.typeAnnotation, p.modifiers));
						}
						return [JS.Method('method', m.key, {params: m.params.map(stripParam), rest: m.rest, typeParams: m.typeParams})];
					}
					const params		= m.params.map(stripParam);
					const returnType	= m.returnType ?? (m.body ? checker.inferReturn(m, m.body, global) : undefined);
					const expansions	= expandConstrainedGeneric(m.typeParams, params, returnType, global);
					if (expansions)
						return expansions.map(o => JS.Method('method', m.key, { params: o.params, rest: m.rest, returnType: o.returnType, typeParams: undefined }, undefined, m.modifiers));

					return [JS.Method('method', m.key, { params, rest: m.rest, returnType, typeParams: m.typeParams }, undefined, m.modifiers)];
				}
			}
			return [];
		}).concat(extra) as JS.ClassMember<any>[];

		// `extends bin.Class(spec)` (or any non-identifier heritage) can't survive into a `.d.ts` -- there's no runtime call in an ambient declaration.
		// Hoist its *type* into a synthesized `declare const _base` instead and extend that name instead.
		let superClass = stmt.superClass;
		if (superClass && superClass.type !== 'identifier') {
			const name = uniqueName((stmt.name ?? '_default') + '_base');
			reachable.add(name);
			syntheticBases.push(JS.AmbientVarDecl('const', JS.Var(name, undefined, checker.typeOf(superClass, global))));
			superClass = Identifier(name);
		}
		return { ...stmt, body, superClass, ambient: true};
	};

	// Ambient declarations have no initializer to destructure from -- split a destructured declarator into one
	// simple-name declarator per bound name instead, each typed `any`.
	const stripVarDeclarator = (d: JS.Var<any>, narrow: boolean): JS.Var<any>[] => typeof d.name === 'string'
		? [JS.Var(d.name, undefined, (d.typeAnnotation as Type) ?? (d.init && inferType(d.init, narrow)) ?? T.ANY)]
		: T.bindingNames(d.name).map(name => JS.Var(name, undefined, T.ANY));


	// ---- Strip bodies/initializers down to their essentials in one pass, registering owners as we go --

	const stripped = walk(ast, (stmt, process) => {
		switch (stmt.type) {
			case 'import':
				return stmt;

			case 'export':
				if (stmt.default?.type === 'identifier')
					reachable.add(stmt.default.name);
				else if (stmt.specifiers && !stmt.source)
					stmt.specifiers.forEach(s => reachable.add(s.local));
				return process(stmt);

			case 'export_decl':
				try {
					owners.exported = true;
					return process(stmt);
				} finally {
					owners.exported = false;
				}
			case 'function_decl': {
				const s = stripFunctionDecl(stmt);
				owners.add(stmt.name, s);
				return s;
			}
			case 'class_decl': {
				const s = stripClassDecl(stmt);
				owners.add(stmt.name, s);
				return s;
			}
			case 'interface_decl':
			case 'type_alias_decl':
			case 'enum_decl':
			case 'namespace_decl':
			case 'module_decl':
				owners.add(stmt.name, stmt);
				return process(stmt);	// namespace/module bodies can nest further declarations -- recurse so those get stripped too

			case 'export_assignment':
				// `export = Foo;` -- not a declaration itself, just marks whatever it names as always needed.
				reachable.add(stmt.expr.split('.')[0]);
				return stmt;

			case 'var_decl':
				for (const d of stmt.declarations) {
					for (const name of T.bindingNames(d.name))
						owners.add(name, d);
				}
				return stmt;
			default:
				return undefined;
		}
	})!;

	// `owners` already holds the stripped form (function/class bodies reduced to signatures above) --
	// just walk it for the identifiers/refs its signature depends on, no re-stripping needed.
	const collectDeclRefs = (owner: TS.Statement|Expr|Type, refs: Set<string>) => {
		walk(owner, undefined,
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

	const worklist	= [...reachable];
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

	// ---- Final rebuild: keep only what's reachable, from the already-stripped tree above -------------

	const lastImport = stripped.body.findLastIndex(i => i.type === 'import');

	return walk({ ...stripped, body: [...stripped.body.slice(0, lastImport), ...syntheticBases, ...stripped.body.slice(lastImport)] },
		(stmt, process) => {
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
					const r = process(stmt);
					return r.declaration ? r : undefined;
				}

				case 'export':
					if (stmt.default) {
						switch (stmt.default.type) {
							case 'identifier':
								return stmt;
							case 'function_decl':
							case 'class_decl':
								// already stripped in the earlier pass -- still needs `process` to run its types through `onType`
								return process(stmt);
							case 'function':
								if (stmt.default.name)
									return process({ ...stmt, default: stripFunctionDecl(JS.FunctionDecl(stmt.default.name, stmt.default))});
								//fallthrough
							default:
								// Anonymous default export -- ambient declarations can't have an inline value, so synthesize a name, the same trick `tsc` uses.
								return { type: 'export', default: Identifier('_default') };
						}
					}
					return stmt;

				case 'function_decl':
				case 'class_decl':
				case 'interface_decl':
				case 'type_alias_decl':
				case 'enum_decl':
				case 'namespace_decl':
				case 'module_decl':
					return reachable.has(stmt.name) ? process(stmt) : undefined;

				case 'export_assignment':
					return stmt;

				case 'var_decl': {
					const declarations = stmt.declarations.filter(d => T.bindingNames(d.name).some(n => reachable.has(n)));
					return declarations.length
						? process({ ...stmt,
							ambient:		true,
							declarations:	declarations.flatMap(d => stripVarDeclarator(d, stmt.kind === 'const'))
						})
						: undefined;
				}

				default:
					return undefined;
			}
		},
		undefined,
		resolveTypes(global, importScope)
	)!;
}
