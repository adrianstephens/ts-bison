import * as TS from './ts-parser';
import * as fs from 'fs/promises';
import * as path from 'path';

export const OptionsDefault = {
	allowArbitraryExtensions:				false,
	allowImportingTsExtensions:				false,
	allowUmdGlobalAccess:					false,
	baseUrl:								undefined as string | undefined,
	customConditions:						undefined as string[] | undefined,
	module:									undefined as string | undefined,
	moduleResolution:						'node',
	moduleSuffixes:							undefined as string[] | undefined,
	noResolve:								false,
	noUncheckedSideEffectImports:			false,
	paths:									undefined as Record<string, string[]> | undefined,
	resolveJsonModule:						false,
	resolvePackageJsonExports:				false,
	resolvePackageJsonImports:				false,
	rewriteRelativeImportExtensions:		false,
	rootDir:								undefined as string | undefined,
	rootDirs:								undefined as string[] | undefined,
	typeRoots:								undefined as string[] | undefined,
	types:									undefined as string | undefined,
};

// Ships beside this file, and beside `lib/` proper -- see `ModuleLoader.nodeBuiltin`.
const NODE_LIB_DIR	= path.join(__dirname, 'lib', 'node');

const reExt			= /\.[^/]+$/;
const reReference	= /^\/\/\/\s*<reference\s+(path|types|lib)=["']([^"']+)["']\s*\/>/gm;

function stripExt(file: string): string {
	return file.replace(reExt, '');
}
function addMissingExt(file: string, ext: string) {
	return reExt.test(file) ? file : file + ext;
}

async function tryLoadFile(full: string): Promise<string | undefined> {
	try {
		return await fs.readFile(full, 'utf8');
	} catch {
		return undefined;
	}
}

export interface LoadedModule {
	body:		TS.Stmt[];
	canonical:	string;	// relative import *inside* that module must resolve relative to where the module really lives
	filename?:	string;	// the real file this came from -- what CommonJS derives a module's own `__filename`/`__dirname` from
}

async function loadCodeFromPackage(pkgDir: string, pkg: string, subpath: string): Promise<{ code: string; canonical: string } | undefined> {
	const code 	= await tryLoadFile(path.join(pkgDir, subpath) + '.d.ts');
	if (code)
		return { code, canonical: path.join(pkg, subpath) };

	try {
		const pkgjson	= JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'));

		if (subpath) {
			const exp = pkgjson.exports?.['./' + subpath]?.['types'];
			if (exp) {
				const code = await tryLoadFile(path.join(pkgDir, exp));
				if (code)
					return { code, canonical: path.join(pkg, stripExt(exp)) };
			}

		} else {
			const types = pkgjson.types ?? pkgjson.typings ?? (stripExt(pkgjson.main) ?? 'index');
			const code	= await tryLoadFile(path.join(pkgDir, addMissingExt(types, '.d.ts')));
			if (code)
				return { code, canonical: path.join(pkg, stripExt(types)) };
		}
	} catch {
		//console.log('no package.json);
	}
}



// A re-exporting statement's `source` is relative to *that file's own* location, not the specifier a caller originally asked for --
// `from` is the canonical specifier of the file `rel` was found in.
function joinSpecifier(from: string, rel: string): string {
	const joined = path.join(path.dirname(from), rel);
	// `path.join` strips a leading `./`; only put it back when `from` was itself relative -- a package specifier legitimately joins to another bare one.
	return from.startsWith('.') && !joined.startsWith('.') ? './' + joined : joined;
}

// ===================================================================
// encapsulates a node_modules directory
// ===================================================================

class NodeModules {
	static found		= new Map<string, NodeModules>;
	static notFound		= new Set<string>;

	// Walks up from `root` looking for the nearest ancestor with a `node_modules` dir. Every directory
	// visited along the way gets cached either way (`found`/`notFound`), not just the one where the walk
	// resolves -- otherwise a directory with no `node_modules` anywhere above it (a common case for a
	// scratch/leaf directory) redoes the whole failed walk, uncached, on every single call.
	static async get(root: string, restrictTypes?: string[]): Promise<NodeModules|undefined> {
		root = path.resolve(root);
		const visited: string[] = [];
		let result: NodeModules | undefined;
		while (root !== '/') {
			let nm = this.found.get(root);
			if (nm) {
				result = nm;
				break;
			}
			if (this.notFound.has(root))
				break;
			visited.push(root);
			try {
				await fs.access(path.join(root, 'node_modules'));
				nm = this.found.get(root);	// a concurrent call may have created it while this one awaited
				if (!nm) {
					nm = new NodeModules(root, restrictTypes);
					this.found.set(root, nm);
				}
				result = nm;
				break;
			} catch {
				root = path.dirname(root);
			}
		}
		for (const r of visited) {
			if (result)
				this.found.set(r, result);
			else
				this.notFound.add(r);
		}
		return result;
	}

	imported	= new Map<string, LoadedModule | undefined>;
	parent?:	NodeModules;
	ready;

	private constructor(public root: string, restrictTypes?: string[]) {
		this.ready = this.scan(path.join(root, 'node_modules/@types'), restrictTypes);
	}
	private async scan(types: string, restrictTypes?: string[]) {
		try {
			await Promise.all((await fs.readdir(types, {withFileTypes: true})).filter(
				i => i.isDirectory() && (!restrictTypes || restrictTypes.includes(i.name))
			).map(i =>
				this.loadDirectory(path.join(types, i.name))
			));
		} catch {
			// no @types dir
		}
	}

	private async loadDirectory(dir: string): Promise<void> {
		await Promise.all((await fs.readdir(dir, {withFileTypes: true})).map(async i => {
			const full = path.join(dir, i.name);
			if (i.isDirectory())
				return this.loadDirectory(full);
			if (!i.name.endsWith('.d.ts'))
				return;
			// One unparseable `.d.ts` must not reject the whole scan. `Promise.all` short-circuits, so
			// `scan`'s own catch used to resolve `ready` while the rest of `@types` was still registering --
			// leaving ambient-module resolution to depend on which specifier happened to be asked for first.
			// Silent by default: this is a bulk scan of third-party types, and `export * from '...'` inside a
			// `declare module` block (which this parser doesn't accept yet) alone fails ~164 files of
			// `@types/node`. `DBGMODULES=1` to see them.
			try {
				this.registerDeclaredModules(TS.parse(await fs.readFile(full, 'utf8')).body);
			} catch (e) {
				if (process.env.DBGMODULES)
					console.error(`Failed to parse ${full}: ${e}`);
			}
		}));
	}

	// Ambient `declare module 'X' { ... }` blocks are self-contained (no real file of their own),
	// so there's nothing more meaningful than the module's own name to use as their canonical specifier.
	protected registerDeclaredModules(body: TS.Stmt[]) {
		for (const s of body) {
			if (s.type === 'module_decl' && s.ambient)
				this.imported.set(s.name, { body: s.body, canonical: s.name });
		}
	}

	// The package/`@types` resolution `get()` alone uses -- not the parent-directory walk-up, which stays in `get()` itself
	// since it needs to fall through to the *parent's own* `get()` (cache included), not just a resolved-code lookup.
	private async tryLocalCode(mod: string): Promise<{ code: string; canonical: string } | undefined> {
		const parts		= mod.split('/');
		const pkgParts	= mod.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
		const pkg		= pkgParts.join('/'), subpath = parts.slice(pkgParts.length).join('/');
		return	await loadCodeFromPackage(path.join(this.root, 'node_modules', pkg), pkg, subpath)
			||	await loadCodeFromPackage(path.join(this.root, 'node_modules', '@types', pkg.startsWith('@') ? pkg.slice(1).replace('/', '__') : pkg), pkg, subpath);
	}

	// Parses `code` (the file reached via `canonical`) and folds in every file its own `/// <reference .../>` directives
	// reach, transitively. A plain `seen` guard, not `ts-codegen.ts`'s full concurrent-cycle machinery -- `.d.ts` reference
	// cycles are vanishingly rare in practice, unlike real import cycles.
	private async withReferences(code: string, canonical: string, seen: Set<string>): Promise<TS.Stmt[]> {
		seen.add(canonical);
		try {
			const body = TS.parse(code).body;
			for (const [, kind, ref] of code.matchAll(reReference)) {
				const refMod = kind === 'types' ? ref : joinSpecifier(canonical, kind === 'lib' ? './lib.' + ref : ref);
				if (!seen.has(refMod)) {
					const res = await this.tryLocalCode(refMod);
					if (res)
						body.push(...await this.withReferences(res.code, res.canonical, seen));
				}
			}
			return body;
		} catch(e) {
			console.error(`Failed to parse ${canonical}: ${e}`);
			return [];
		}
	}

	async get(mod: string): Promise<LoadedModule | undefined> {
		await this.ready;
		if (this.imported.has(mod))
			return this.imported.get(mod);

		const res = await this.tryLocalCode(mod);
		if (res) {
			// A package-exports-mapped specifier (`@pkg/name`) and the `dist/...`-shaped path an internal relative import within that same
			// package resolves to (via `joinSpecifier` against a canonical `dist/...` path) name the same physical file under different strings --
			// reuse the existing entry instead of re-parsing, so both requesters share one `LoadedModule` object (identity-based cycle detection
			// and `importScopeCache` both depend on that).
			const existing = this.imported.get(res.canonical);
			if (existing) {
				this.imported.set(mod, existing);
				return existing;
			}
			const body = await this.withReferences(res.code, res.canonical, new Set());
			this.registerDeclaredModules(body);
			const fileEntry = { body, canonical: res.canonical };
			this.imported.set(res.canonical, fileEntry);
			// `registerDeclaredModules` may have just registered an ambient `declare module '<mod>' { ... }` found *inside* this
			// file under the exact key `mod` (e.g. `@types/vscode`'s `index.d.ts` is just `declare module 'vscode' { ... }`) --
			// that unwrapped inner body is what `mod` itself should resolve to, not this file's own (still-wrapped) top level.
			const entry = this.imported.get(mod) ?? fileEntry;
			this.imported.set(mod, entry);
			return entry;
		}

		if (!this.parent)
			this.parent = await NodeModules.get(path.dirname(this.root));

		return this.parent?.get(mod);
	}
}

// ===================================================================
//  ModuleLoader
// ===================================================================

export class ModuleLoader {
	opts = OptionsDefault;
	imported = new Map<string, Promise<LoadedModule|undefined>>;

	constructor(public root: string, opts: Partial<typeof OptionsDefault>, restrictTypes?: string[]) {
		this.opts = {...this.opts, ...opts};
		NodeModules.get(root, restrictTypes);
	}

	async local(resolved: string) {
		const load = async (canonical: string) => {
			let filename = path.join(this.root, canonical + '.ts');
			let code = await tryLoadFile(filename);
			if (code === undefined) {
				filename = path.join(this.root, canonical + '.d.ts');
				code = await tryLoadFile(filename);
			}
			if (code !== undefined) {
				try {
					return {body: TS.parse(code).body, canonical, filename };
				} catch(e) {
					console.error(`Failed to parse ${canonical}: ${e}`);
				}
			}
		};

		return await load(resolved) || await load(resolved + '/index');
	}

	// A node builtin (`import * as path from 'path'`) served from this compiler's own runtime library.
	// Loaded ON DEMAND, unlike `lib/*.ts` proper -- those are concatenated into one always-present global
	// declaration list (towasm.ts's `LIB_AST`), so everything in them is linked into every module whether
	// it is used or not. These are ordinary modules instead: nothing resolves here unless a program really
	// imports the specifier, and adding a new builtin is a new file, not a compiler change. Its own
	// directory, not `lib/` itself, so a bare specifier can never collide with a static lib file
	// (`string`, `map`, `array` are all plausible package names).
	private async nodeBuiltin(spec: string): Promise<LoadedModule | undefined> {
		const canonical = 'lib/node/' + spec.replace(/^node:/, '');
		const filename = path.join(NODE_LIB_DIR, path.basename(canonical) + '.ts');
		const code = await tryLoadFile(filename);
		if (!code)
			return undefined;
		try {
			return { body: TS.parse(code).body, canonical, filename };
		} catch (e) {
			console.error(`Failed to parse ${canonical}: ${e}`);
		}
	}

	private async get0(resolved: string): Promise<LoadedModule|undefined> {
		if (this.opts.paths) {
			for (const [alias, paths] of Object.entries(this.opts.paths)) {
				if (resolved.startsWith(alias)) {
					for (const i of paths) {
						const candidate = i + resolved.slice(alias.length);
						const loaded = await this.local(candidate);
						if (loaded)
							return loaded;
					}
				}
			}
		}
		if (resolved.startsWith('.'))
			return this.local(resolved);

		// Ahead of `node_modules`: `@types/node` also declares these, as bodyless `.d.ts` signatures with
		// nothing to compile, which is exactly what made `path` an "unresolved identifier" in codegen.
		const builtin = await this.nodeBuiltin(resolved);
		if (builtin)
			return builtin;

		const nm	= await NodeModules.get(this.root);
		if (nm)
			return nm.get(resolved);
	}

	async get(mod: string, from: string): Promise<LoadedModule | undefined> {
		const resolved = mod.startsWith('.') ? stripExt(joinSpecifier(from, mod)) : mod;
		if (!this.imported.has(resolved))
			this.imported.set(resolved, this.get0(resolved));

		return await this.imported.get(resolved);
	}
}

// Walks every `import` statement reachable from `entryBody` (via the given, already-warm `loader` --
// typically the very same instance a preceding `TStypeCheckAsync` call resolved against), collecting
// every other module's own body (keyed by its `LoadedModule.canonical`, entry excluded -- callers
// conventionally treat `'.'` as the entry itself) plus, per module, its plain `import { foo } from '...'`
// bindings mapped to where they really come from (foo, or its local alias, -> {module: target canonical,
// name: the *exported* name, which may differ from the local one}). `TStoWasm` (towasm.ts) needs the
// bodies to compile a real cross-file call, and `namedImports` because a named import's local binding
// carries no module of its own. An `import * as X` needs nothing here: the checker's `Scope` already
// binds `X` to the target module's own scope, declarations included. Only plain `import` is walked
// (matching every real import in this monorepo's own self-hosting target files) -- a re-exporting
// `export ... from` isn't resolved here, a real, narrower, separate gap if one is ever found in practice.
export async function collectModules(entryBody: TS.Stmt[], loader: ModuleLoader) {
	const modules = new Map<string, TS.Stmt[]>();
	const namedImports = new Map<string, Map<string, { module: string; name: string }>>();
	const seen = new Set<string>(['.']);

	async function walk(canonical: string, body: TS.Stmt[]) {
		for (const s of body) {
			if (s.type !== 'import')
				continue;
			const target = await loader.get(s.source, canonical);
			if (!target)
				continue;
			if (s.specifiers) {
				let bindings = namedImports.get(canonical);
				if (!bindings)
					namedImports.set(canonical, bindings = new Map());
				for (const spec of s.specifiers)
					bindings.set(spec.local, { module: target.canonical, name: spec.imported });
			}
			if (!seen.has(target.canonical)) {
				seen.add(target.canonical);
				// Stamped beside `exportScope`'s own `.scope`: `TStoWasm` receives these bodies and nothing
				// else, and a module's `__filename`/`__dirname` are derived from where it really lives.
				(target.body as TS.Stmt[] & { filename?: string }).filename ??= target.filename;
				modules.set(target.canonical, target.body);
				await walk(target.canonical, target.body);
			}
		}
	}
	await walk('.', entryBody);
	return { modules, namedImports };
}
