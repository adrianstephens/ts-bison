/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-this-alias */
import * as TS from './ts-parser';
import * as JS from './js-parser';
import { Location, Expr, BindingTarget } from './js-parser';
import { Type } from './ts-parser';
import { TSwalk, Preserve, hasMod } from './walker';
import * as T from './type-utils';
import { Scope } from './type-utils';
import { makeChecker } from './checker';
import { LoadedModule, ModuleLoader } from './module-loader';
import { TSoutput } from './tocode';

import * as fs from 'fs';
import * as path from 'path';

function dropMod(e: {modifiers?: string[]}, m: string) {
	if (e.modifiers?.includes(m))
		e.modifiers = e.modifiers.filter(i => i != m);
}

//-----------------------------------------------------------------------------
// TS to JS
//-----------------------------------------------------------------------------

// Plain JS has no `?` -- drops the `'optional'` tag from a `Param`'s modifiers while keeping any others (e.g.
// a parameter property's `public`/`readonly`, cleared separately by whichever caller also strips `modifiers`).
const dropOptional = (p: JS.Param) => dropMod(p, 'optional');

export function TStoJS(ast: TS.Program) {
	const onExpression = (expr: Expr, process: Preserve<Expr>): Expr|undefined => {
		switch (expr.type) {

			case 'function':
				expr = process(expr);
				expr.params.forEach(dropOptional);
				return expr;

			case 'arrow':
				expr = process(expr);
				expr.params.forEach(dropOptional);
				return expr;

			case 'class':
				return {...process(expr), typeParams: undefined, implementsClause: undefined, abstract: undefined};

			case 'as_expression':
			case 'satisfies_expression':
			case 'non_null':
				return onExpression(expr.expression, process);

			default:
				return process(expr);
		}
	};

	return TSwalk(ast, 
		//onStatement
		(stmt, process) => {
			switch (stmt.type) {
				case 'type_alias_decl':
				case 'interface_decl':
				case 'declare':
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
					return {
						type: 'var', kind: 'const',
						declarations: [{
							name: stmt.name,
							init: {
								type: 'object',
								properties: stmt.members.map(m => {
									let value: Expr;
									if (m.init) {
										value = m.init;
										next = (m.init.type === 'literal' && typeof m.init.value === 'number') ? m.init.value + 1 : NaN;
									} else {
										value = { type: 'literal', value: next++ };
									}
									return { key: m.name, value, kind: 'init' as const };
								}),
							},
						}],
					};
				}
				
				case 'class_decl': {
					stmt = process(stmt);
					stmt.body.forEach(m => {
						if (m.type === 'field') {
							delete m.modifiers;

						} else if (m.type === 'method') {
							const fn = m.value;
							if (m.key === 'constructor') {
								// A parameter-property modifier is anything but the unrelated `'optional'` tag
								// that can now also live in `modifiers` (see `Param`'s own comment).
								const prelude: JS.Statement[] = fn.params
									.filter((p) => p.modifiers?.some(x => x !== 'optional'))
									.map(p => ({
										type: 'expression',
										expression: {
											type: 'assign', operator: '=',
											left: { type: 'member', object: { type: 'this' }, property: p.key as string },
											right: { type: 'identifier', name: p.key as string },
										},
									})
								);
								if (prelude.length)
									fn.body = [...prelude, ...fn.body!];
							}

							for (const p of fn.params)
								delete p.modifiers;
							delete m.modifiers;
						}
					});
					delete stmt.typeParams;
					delete stmt.implementsClause;
					delete stmt.abstract;
					return stmt;
				}

				default:
					return process(stmt);
			}

		},
		onExpression,
		//onType
		(_type, _process) => undefined
	);
}

// ===================================================================
//  TStypeCheck
// ===================================================================

export interface Diagnostic {
	message:	string;
	pos:		Location;
}

function makeDiagnostic(func: (d: Diagnostic) => void) {
	const renderer	= new TSoutput;
	const clip		= (s: string, max = 60)	=> s.length > max ? s.slice(0, max - 3) + '...' : s;
	const toString	= (v: any) => v === undefined ? '' : typeof v === 'string' ? v : renderer.toCode(v);

	return (strings: TemplateStringsArray, pos: Location, ...values: any[]) => func({
		message: strings.map((s, i) => s + clip(toString(values[i - 1]))).join(''),
		pos
	});
}

export function TStypeCheck(ast: TS.Program): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const checker = makeChecker(makeDiagnostic(d => diagnostics.push(d)));
	checker.checkBlock(ast.body, checker.global, undefined);
	return diagnostics;
}

export async function TStypeCheckAsync(filename: string): Promise<{program: TS.Program, diagnostics: Diagnostic[]}> {
	const diagnostics: Diagnostic[] = [];
	const checker	= makeChecker(makeDiagnostic(d => diagnostics.push(d)));
	const global	= checker.global;

	const program	= TS.parse(await fs.promises.readFile(filename, 'utf8'));
	const loader	= new ModuleLoader(path.dirname(filename), ['node']);

	interface ModuleShape { scope: Scope; value: Type }

	const importScopeCache = new Map<LoadedModule, Promise<ModuleShape>>();

	// A dynamic wait-for graph: `waitingFor.get(a)` is the set of modules `a` is *currently* blocked awaiting the
	// resolution of, at this exact instant in the pass (edges appear and disappear as individual awaits start and
	// finish). Two concurrent call chains reaching the same shared dependency from unrelated directions (one file
	// importing `sync` directly, another reaching it only via `export * from` elsewhere) are both safe to await --
	// `sync` isn't waiting on either of them, so there's no cycle. A genuine cycle (Node's own `https`/`http`/`url`/
	// `tls` `.d.ts` graph cross-references itself through a tangle of `import` and `export * from` edges via
	// *different* concurrent paths) shows up as: walking forward from the target about to be awaited eventually
	// reaches the waiter itself -- i.e. the target is, transitively, already waiting on the waiter's own completion.
	// That's the only shape that can actually deadlock; anything else is safe to await regardless of how many other
	// things happen to be mid-build concurrently.
	const waitingFor = new Map<LoadedModule, Set<LoadedModule>>();

	function wouldDeadlock(waiter: LoadedModule, target: LoadedModule): boolean {
		const seen = new Set<LoadedModule>();
		const stack = [target];
		while (stack.length) {
			const cur = stack.pop()!;
			if (cur === waiter)
				return true;
			if (!seen.has(cur)) {
				seen.add(cur);
				for (const next of waitingFor.get(cur) ?? [])
					stack.push(next);
			}
		}
		return false;
	}

	// Awaits `makeScope(parent, target)` on `waiter`'s behalf, recording the wait so `wouldDeadlock` can see it --
	// or, if awaiting would deadlock, skips without recursing further, returning `undefined`.
	async function awaitScope(waiter: LoadedModule, parent: Scope, target: LoadedModule): Promise<ModuleShape | undefined> {
		if (wouldDeadlock(waiter, target))
			return undefined;
		let waits = waitingFor.get(waiter);
		if (!waits)
			waitingFor.set(waiter, waits = new Set());
		waits.add(target);
		try {
			return await makeScope(parent, target);
		} finally {
			waits.delete(target);
		}
	}

	// Resolves one `import` statement's bindings (default/namespace/named specifiers) from `imp.source` into `importScope`,
	// shared by `makeScope` (building a dependency's own import scope) and the entry program (which has no `makeScope`
	// call of its own, since nothing else ever imports it). `waiter` identifies who's asking, for `wouldDeadlock`.
	const resolveImport = async (waiter: LoadedModule, importScope: Scope, imp: JS.Import, from: string): Promise<void> => {
		const impSrc = await loader.get(imp.source, from);
		if (!impSrc) {
			diagnostics.push({ message: `Could not resolve import '${imp.source}'`, pos: (imp as any).pos });
			return;
		}
		const resolved = await awaitScope(waiter, importScope, impSrc);
		if (!resolved)
			return;	// genuine import cycle -- contribute nothing further rather than deadlock

		const { scope: impScope, value } = resolved;

		if (imp.namespace) {
			importScope.values.set(imp.namespace, value);
			importScope.addNamespace(imp.namespace, impScope);
		}

		for (const spec of imp.specifiers ?? []) {
			const v = impScope.values.get(spec.imported);
			if (v)
				importScope.values.set(spec.local, v);
			const typeEntry = impScope.types.get(spec.imported);
			if (typeEntry) {
				const prev = importScope.types.get(spec.local);
				importScope.types.set(spec.local, prev ? { typeParams: prev.typeParams ?? typeEntry.typeParams, type: { type: 'intersection', types: [prev.type, typeEntry.type] } } : typeEntry);
			}
			const ns = impScope.namespace(spec.imported);
			if (ns)
				importScope.addNamespace(spec.local, ns);
		}
	};

	// The result of `makeScope` is a `Scope` containing precisely `src`'s exported symbols (values, types, and nested
	// namespaces alike), keyed by their public name -- callers never need to re-scan `src.body`'s statements themselves.
	// The one exception is `export ... from` re-exports: `checker.exportScope` only sees local declarations and same-file
	// `export {a, b}` (no `source`), since resolving a re-export's target needs the loader, which the checker itself
	// doesn't have -- so that part alone is still handled here, by folding the target's own (recursively resolved) scope
	// into this one.
	async function makeScope(parent: Scope, src: LoadedModule): Promise<ModuleShape> {
		const existing = importScopeCache.get(src);
		if (existing)
			return existing;

		const importScope = new Scope(parent);
		const cached = Promise.all(src.body.filter(s => s.type === 'import').map(s => resolveImport(src, importScope, s, src.canonical))).then(async () => {
			const { scope, value, isAlias } = checker.exportScope(src.body, importScope);
			for (const stmt of src.body) {
				if (stmt.type !== 'export' || !stmt.source)
					continue;
				const target = await loader.get(stmt.source, src.canonical);
				if (!target)
					continue;
				const targetShape = await awaitScope(src, global, target);
				if (!targetShape)
					continue;	// genuine circular re-export chain -- contribute nothing further rather than deadlock/recurse forever
				if (stmt.namespace) {
					// `export * as name from './x'`: one property holding the target's whole shape.
					scope.values.set(stmt.namespace, targetShape.value);
					scope.addNamespace(stmt.namespace, targetShape.scope);
					
				} else if (stmt.specifiers) {
					for (const spec of stmt.specifiers) {
						if (!stmt.typeOnly && !spec.typeOnly) {
							const v = targetShape.scope.values.get(spec.local);
							if (v)
								scope.values.set(spec.exported, v);
							const ns = targetShape.scope.namespace(spec.local);
							if (ns)
								scope.addNamespace(spec.exported, ns);
						}
						const te = targetShape.scope.types.get(spec.local);
						if (te)
							scope.types.set(spec.exported, te);
					}
				} else {
					// bare `export * from './x'`: everything, as-is
					if (!stmt.typeOnly) {
						for (const [n, v] of targetShape.scope.values)
							scope.values.set(n, v);
						for (const [n, ns] of targetShape.scope.namespaces ?? [])
							scope.addNamespace(n, ns);
					}
					for (const [n, te] of targetShape.scope.types)
						scope.types.set(n, te);
				}
			}
			return { scope, value: isAlias ? value : scope.toObject() };
		});
		importScopeCache.set(src, cached);
		return cached;
	}

	// The entry program itself never goes through `makeScope` -- nothing else ever imports it, so it needs no cache entry
	// and no "exported symbols" view, just its own import bindings to check its body against. It's also not in
	// `importScopeCache`, so it needs its own stable identity object purely for `wouldDeadlock`'s bookkeeping.
	const entrySrc: LoadedModule = { body: program.body, canonical: '.' };
	const entryScope = new Scope(global);
	await Promise.all(program.body.filter(s => s.type === 'import').map(s => resolveImport(entrySrc, entryScope, s, '.')));

	checker.checkBlock(program.body, entryScope);
	return {program, diagnostics };
}

// ===================================================================
//  TStoDecl -- TypeScript AST to a .d.ts-shaped AST
// ===================================================================

export function TStoDecl(ast: TS.Program): TS.Program {
	// ---- Type/value reference collection (used to build the reachability graph below) -------------

	// Dotted type names (`ns.Type`) only need their leftmost segment tracked -- that's the actual
	// locally-bound identifier (an import, typically); the rest is just a member access on it.
	const addRef = (name: string, refs: Set<string>) => refs.add(name.split('.')[0]);

	// ---- Gathering every top-level declaration, and the explicitly-exported roots ------------------

	type Owner = TS.Statement | JS.VarDeclarator;
	class Owners extends Map<string, Owner[]> {
		add(name: string, owner: Owner) {
			this.set(name, [...(this.get(name) ?? []), owner]);
		}
		//get(name: string): Owner[] | undefined {
		//	return super.get(name) ?? this.parent?.get(name);
		//}
	}

	const owners = new Owners;
	const roots = new Set<string>();

	// Shared inference: the checker's scope/typeOf machinery, run silently over the whole program once so identifier lookups resolve during the rebuild below
	const checker		= makeChecker(()=>{});
	const global		= checker.global;
	checker.checkBlock(ast.body, checker.global);

	// `undefined` (rather than an explicit `: any` annotation) keeps unknowable types implicit, as before
	const inferType		= (e: Expr, narrow: boolean): Type | undefined => {
		const t = narrow ? checker.typeOf(e, global) : T.widenLiterals(checker.typeOf(e, global));
		return t.type === 'ref' && t.name === 'any' ? undefined : t;
	};

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
			case 'var':
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
		} else if (stmt.type === 'declare') {
			registerDecl(stmt.declaration, false);
		} else {
			registerDecl(stmt, false);
		}
	}


	// ---- Final rebuild: strip bodies/initializers, keep only what's reachable ----------------------
	const stripBindingDefaults = (t: BindingTarget): BindingTarget => {
		if (typeof t === 'string')
			return t;
		if (t.type === 'object_pattern')
			return { ...t, properties: t.properties.map(p => ({ ...p, value: stripBindingDefaults(p.value), default: undefined })) };
		return { ...t, elements: t.elements.map(el => el && ({ ...el, target: stripBindingDefaults(el.target), default: undefined })) };
	};
	const stripParam = (p: JS.Param): JS.Param => ({ ...p,
		key:			stripBindingDefaults(p.key),
		typeAnnotation: p.typeAnnotation ?? (p.default && inferType(p.default, false)),
		default:		undefined,
		modifiers:		hasMod(p, 'optional') || !!p.default ? ['optional'] : []
	});

	const wrapType = (t: Type, names: Set<string>, name: string) => t.type === 'ref' && names.has(t.name) ? t : { type: 'ref', name, typeArgs: [t] };
	const PROMISE_TYPES		= new Set(['Promise']);
	const GENERATOR_TYPES	= new Set(['Generator', 'IterableIterator', 'Iterator', 'Iterable']);

	const stripFunctionDecl = (stmt: JS.FunctionDecl): JS.Declaration => {
		const returnType: Type = stmt.returnType ? stmt.returnType as Type : stmt.body ? checker.inferReturn(stmt, global) : T.ANY;
		return JS.FunctionDecl(stmt.name, {
			params:		stmt.params.map(stripParam),
			typeParams:	stmt.typeParams,
			returnType: hasMod(stmt, 'async') ? wrapType(returnType, PROMISE_TYPES, 'Promise') : hasMod(stmt, 'generator') ? wrapType(returnType, GENERATOR_TYPES, 'Generator') : returnType
		});
	};

	// Same `ClassMember`/`TS.ClassMember` gap as `TStoJS`'s `processClassMember`: `stmt.body`'s declared element type is narrower than what a
	// class body can actually hold once ts-parser.ts's grammar extensions (`static_block`/`method_signature`) are in play.
	const stripClassDecl = (stmt: JS.ClassDecl): JS.Declaration => {
		const setKeys	= new Set(stmt.body.filter((m): m is Extract<JS.ClassMember, { type: 'method' }> => m.type === 'method' && m.kind === 'set' && typeof m.key === 'string').map(m => m.key as string));
		const seen		= new Set<string>();
		const extra:	JS.ClassMember[] = [];

		const body = stmt.body.map((m): TS.ClassMember | undefined => {
			if (m.type === 'field')
				return { ...m,
					typeAnnotation: (m.typeAnnotation as Type | undefined) ?? (m.value && inferType(m.value, false)) ?? { type: 'ref', name: 'any' },
					value: undefined,
				};

			if (m.type === 'method') {
				const fn = m.value as JS.Function<Type>;
				if (m.kind) {
					if (typeof m.key === 'string') {
						if (seen.has(m.key))
							return undefined;
						seen.add(m.key);
					}
					return { type: 'field', key: m.key,
						typeAnnotation: (m.kind === 'get' ? fn.returnType : fn.params[0]?.typeAnnotation) ?? T.ANY,
						modifiers:		m.kind === 'get' && typeof m.key === 'string' && !setKeys.has(m.key) ? ['readonly'] : undefined,
					};
				}
				if (m.key === 'constructor') {
					for (const p of fn.params) {
						if (p.modifiers?.length)
							extra.push({type: 'field', key: typeof p.key === 'string' ? p.key : '?', typeAnnotation: p.typeAnnotation, modifiers: p.modifiers});
					}
					return { type: 'method_signature', key: m.key, params: fn.params.map(stripParam) as JS.Param<Type>[], rest: fn.rest };
				}
				return { type: 'method_signature', key: m.key, params: fn.params.map(stripParam) as JS.Param<Type>[], rest: fn.rest, modifiers: m.modifiers, returnType: fn.returnType ?? checker.inferReturn(fn, global) };
			}
			return undefined;
		}).filter(m => m !== undefined).concat(...extra) as JS.ClassMember[];
		return { ...stmt, body};
	};

	// A destructured declarator (`const {a, b} = x;`) can't survive into a .d.ts as one statement -- ambient declarations have no initializer to
	// destructure from. Split into one simple-name declarator per bound name instead (`declare const a: any, b: any;`), each typed `any`.
	const stripVarDeclarator = (d: JS.VarDeclarator, narrow: boolean): JS.VarDeclarator[] => typeof d.name === 'string'
		? [{...d,
			typeAnnotation: (d.typeAnnotation as Type | undefined) ?? (d.init && inferType(d.init, narrow)) ?? { type: 'ref', name: 'any' },
			init: undefined,
		}]
		: T.bindingNames(d.name).map(name => ({ name, typeAnnotation: T.ANY }));


	const collectDeclRefs = (owner: TS.Statement|Expr|Type, refs: Set<string>) => {
		TSwalk(owner, 
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
					addRef(e.name, refs);
				return process(e);
			},
			(t, process) =>{
				if (t.type === 'ref')
					addRef(t.name, refs);
				return process(t);
			}
		);
	};

	const reachable = new Set<string>(roots);
	const worklist = [...roots];
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
			case 'var':
				return stmt.declarations.some(d => T.bindingNames(d.name).some(n => reachable.has(n)));
			default:
				return false;
		}
	};

	const processNamedDecl = (stmt: TS.Declaration): TS.Declaration|TS.Declare => {
		switch (stmt.type) {
			case 'function_decl':	return {type: 'declare', declaration: stripFunctionDecl(stmt)};
			case 'class_decl':		return {type: 'declare', declaration: stripClassDecl(stmt)};
			case 'interface_decl':
			case 'type_alias_decl':
			case 'enum_decl':
			case 'namespace_decl':
			case 'module_decl':
			case 'export_assignment':
				return stmt;
			case 'var': {
				return {type: 'declare', declaration: { ...stmt, 
					declarations: stmt.declarations
						.filter(d => T.bindingNames(d.name).some(n => reachable.has(n)))
						.flatMap(d => stripVarDeclarator(d, stmt.kind === 'const'))
				 }};
			}
		}
	};

	const filterDecls = (stmt: TS.Statement): TS.Statement|undefined => {
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
				const decl = stmt.declaration as JS.Declaration|TS.Declare;
				if (decl.type === 'declare') {
					if (isReachable(decl.declaration))
						return stmt;
				} else if (isReachable(decl)) {
					return { type: 'export_decl', declaration: processNamedDecl(decl) as JS.Declaration };
				}
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
							if (stmt.default.name) {
								// `export default function foo() {}` parses as a *named function expression*, not a `function_decl` statement (`class`
								// doesn't have this asymmetry). Converted to the idiomatic bodyless `export default function foo(): T;` .d.ts form.
								return { ...stmt, default: stripFunctionDecl({
									type: 'function_decl', name: stmt.default.name,
									params: stmt.default.params, rest: stmt.default.rest,
									returnType: stmt.default.returnType, typeParams: stmt.default.typeParams,
								})};
							}
							//fallthrough
						default:
							// Anonymous default export -- ambient declarations can't have an inline value, so synthesize a name, the same trick `tsc` uses.
							return { type: 'export', default: { type: 'identifier', name: '_default' } } as JS.Statement;
					}
				}
				return stmt;

			case 'declare':
				if (isReachable(stmt.declaration))
					return stmt;
				return undefined;
			
			default:
				if (isReachable(stmt as JS.Declaration))
					return processNamedDecl(stmt as unknown as JS.Declaration);
				return undefined;
		}
	};

	const x = ast.body.map(filterDecls).filter(s => s !== undefined);
	return {type: 'program', body: x };
}
