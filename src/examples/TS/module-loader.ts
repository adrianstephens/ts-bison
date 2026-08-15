import * as TS from './ts-parser';
import * as fs from 'fs/promises';
import * as path from 'path';

export const ModuleOptionsDefault = {
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
	body:		TS.Statement[];
	canonical:	string;	// relative import *inside* that module must resolve relative to where the module really lives
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
	static found = new Map<string, NodeModules>;

	static async get(root: string, restrictTypes?: string[]): Promise<NodeModules|undefined> {
		while (root !== '/') {
			try {
				let nm = this.found.get(root);
				if (!nm) {
					await fs.access(path.join(root, 'node_modules'));
					nm = this.found.get(root);
					if (!nm) {
						nm = new NodeModules(root, restrictTypes);
						this.found.set(root, nm);
					}
				}
				return nm;
			} catch {
				root = path.dirname(root);
			}
		}
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
			if (i.isDirectory())
				return this.loadDirectory(path.join(dir, i.name));
			if (i.name.endsWith('.d.ts'))
				this.registerDeclaredModules(await fs.readFile(path.join(dir, i.name), 'utf8').then(code => TS.parse(code).body));
		}));
	}

	// Ambient `declare module 'X' { ... }` blocks are self-contained (no real file of their own),
	// so there's nothing more meaningful than the module's own name to use as their canonical specifier.
	protected registerDeclaredModules(body: TS.Statement[]) {
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
	private async withReferences(code: string, canonical: string, seen: Set<string>): Promise<TS.Statement[]> {
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
	imported = new Map<string, Promise<LoadedModule|undefined>>;

	constructor(public root: string, public opts: typeof ModuleOptionsDefault, restrictTypes?: string[]) {
		NodeModules.get(root, restrictTypes);
	}

	async local(resolved: string) {
		const load = async (canonical: string) => {
			const code = await tryLoadFile(path.join(this.root, canonical + '.ts'))
					||	await tryLoadFile(path.join(this.root, canonical + '.d.ts'));
			if (code) {
				try {
					return {body: TS.parse(code).body, canonical };
				} catch(e) {
					console.error(`Failed to parse ${canonical}: ${e}`);
				}
			}
		};

		return await load(resolved) || await load(resolved + '/index');
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
