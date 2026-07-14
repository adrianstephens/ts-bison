import * as TS from './ts-parser';

import * as fs from 'fs';
import * as path from 'path';

// ===================================================================
//  Module
// ===================================================================

async function tryLoadCode(full: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(full, 'utf8');
	} catch {
		return undefined;
	}
}

// The parsed body, plus the specifier that actually reached it -- a relative import *inside* that module must resolve relative to where the
// module really lives, not the (possibly quite different, e.g. bare-package) specifier the caller originally asked for.
export interface LoadedModule {
	body:		TS.Statement[];
	canonical:	string;
}

// Reads+parses `base/rel<ext>` for each extension, falling back to `base/rel/index<ext>`.
async function tryLoad(base: string, rel: string, extensions: string[]): Promise<LoadedModule | undefined> {
	// ESM-style TS source imports its sibling by its *compiled* extension (`import './x.js'` for a
	// source file that's actually `./x.ts`) -- strip it so the real extension list below still matches.
	rel = rel.replace(/\.[mc]?js$/, '');
	for (const ext of extensions) {
		for (const candidate of [rel, path.join(rel || '.', 'index')]) {
			const full = path.join(base, candidate + ext);
			const code = await tryLoadCode(full);
			if (code) {
				try {
					return { body: TS.parse(code)!.body, canonical: candidate.startsWith('.') ? candidate : './' + candidate };
				} catch (e) {
					console.error(`Failed to parse ${full}: ${e}`);
				}
			}
		}
	}
	return undefined;
}

const reExt = /\.[^/]+$/;

function stripExt(file: string): string {
	return file.replace(reExt, '');
}
function addMissingExt(file: string, ext: string) {
	return reExt.test(file) ? file : file + ext;
}

// encapsulates a node_modules directory

class NodeModules {
	static found = new Map<string, NodeModules>;

	static async get(root: string, restrictTypes?: string[]): Promise<NodeModules|undefined> {
		while (root !== '/') {
			try {
				let nm = this.found.get(root);
				if (!nm) {
					await fs.promises.access(path.join(root, 'node_modules'));
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
	found		= new Map<string, Promise<TS.Statement[]>>;
	parent?:	NodeModules;
	ready;

	private constructor(public root: string, restrictTypes?: string[]) {
		this.ready = this.scan(path.join(root, 'node_modules/@types'), restrictTypes);
	}
	private async scan(types: string, restrictTypes?: string[]) {
		try {
			const dirs = await fs.promises.readdir(types, {withFileTypes: true});
			const all = dirs.filter(i => i.isDirectory() && (!restrictTypes || restrictTypes.includes(i.name))).map(i =>
				this.loadTypes(path.join(types, i.name))
			);
			await Promise.all(all);
		} catch {
			// no @types dir
		}
	}

	private async loadTypes(dir: string): Promise<void> {
		const entries = await fs.promises.readdir(dir, {withFileTypes: true});
		await Promise.all(entries.map(async i => {
			if (i.isDirectory())
				return this.loadTypes(path.join(dir, i.name));
			if (i.name.endsWith('.d.ts')) {
				const body	= fs.promises.readFile(path.join(dir, i.name), 'utf8').then(code => TS.parse(code).body);
				this.found.set(i.name, body);
				this.registerDeclaredModules(await body);
			}
		}));
	}

	private async loadCodeFromPackage(pkgDir: string, pkg: string, subpath: string): Promise<{ code: string; canonical: string } | undefined> {
		const load0 	= await tryLoadCode(path.join(pkgDir, subpath) + '.d.ts');
		if (load0)
			return { code: load0, canonical: path.join(pkg, subpath) };

		try {
			const pkgjson	= JSON.parse(await fs.promises.readFile(path.join(pkgDir, 'package.json'), 'utf8'));

			if (subpath) {
				const exp = pkgjson.exports?.['./' + subpath]?.['types'];
				if (exp) {
					const load = await tryLoadCode(path.join(pkgDir, exp));
					if (load)
						return { code: load, canonical: path.join(pkg, stripExt(exp)) };
				}

			} else {
				const types = pkgjson.types ?? pkgjson.typings ?? (stripExt(pkgjson.main) ?? 'index');
				const load = await tryLoadCode(path.join(pkgDir, addMissingExt(types, '.d.ts')));
				if (load)
					return { code: load, canonical: path.join(pkg, stripExt(types)) };
			}
		} catch {
			//console.log('no package.json);
		}
	}

	// Ambient `declare module 'X' { ... }` blocks are self-contained (no real file of their own),
	// so there's nothing more meaningful than the module's own name to use as their canonical specifier.
	protected registerDeclaredModules(body: TS.Statement[]) {
		for (const s of body) {
			if (s.type === 'declare' && s.declaration.type === 'module_decl')
				this.imported.set(s.declaration.name, { body: s.declaration.body, canonical: s.declaration.name });
		}
	}

	async get(mod: string): Promise<LoadedModule | undefined> {
		await this.ready;
		if (this.imported.has(mod))
			return this.imported.get(mod);

		const parts		= mod.split('/');
		const pkgParts	= mod.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
		const pkg		= pkgParts.join('/'), subpath = parts.slice(pkgParts.length).join('/');;
		const res		=	await this.loadCodeFromPackage(path.join(this.root, 'node_modules', pkg), pkg, subpath)
						||	await this.loadCodeFromPackage(path.join(this.root, 'node_modules', '@types', pkg.startsWith('@') ? pkg.slice(1).replace('/', '__') : pkg), pkg, subpath);

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
			try {
				const body = TS.parse(res.code).body;
				this.registerDeclaredModules(body);
				const fileEntry = { body, canonical: res.canonical };
				this.imported.set(res.canonical, fileEntry);
				// `registerDeclaredModules` may have just registered an ambient `declare module '<mod>' { ... }` found *inside* this
				// file under the exact key `mod` (e.g. `@types/vscode`'s `index.d.ts` is just `declare module 'vscode' { ... }`) --
				// that unwrapped inner body is what `mod` itself should resolve to, not this file's own (still-wrapped) top level.
				const entry = this.imported.get(mod) ?? fileEntry;
				this.imported.set(mod, entry);
				return entry;
			} catch(e) {
				console.error(`Failed to parse ${mod}: ${e}`);
			}
		}

		if (!this.parent)
			this.parent = await NodeModules.get(path.dirname(this.root));

		return this.parent?.get(mod);
	}
}



// A re-exporting statement's `source` is relative to *that file's own* location, not the specifier a caller originally asked for --
// `from` is the canonical specifier of the file `rel` was found in.
function joinSpecifier(from: string, rel: string): string {
	if (!rel.startsWith('.'))
		return rel;
	const joined = path.join(path.dirname(from), rel);
	// `path.join` strips a leading `./`; only put it back when `from` was itself relative -- a package specifier legitimately joins to another bare one.
	return from.startsWith('.') && !joined.startsWith('.') ? './' + joined : joined;
}

export class ModuleLoader {
	imported = new Map<string, Promise<LoadedModule|undefined>>;

	constructor(public root: string, restrictTypes?: string[]) {
		NodeModules.get(root, restrictTypes);
	}

	// `from` is the canonical specifier of the file `mod` was found in -- `'.'` for the entry
	// program's own top-level imports, which have nothing else to be relative to.
	async get(mod: string, from: string): Promise<LoadedModule | undefined> {
		const resolved = mod.startsWith('.') ? joinSpecifier(from, mod) : mod;
		if (resolved.startsWith('.')) {
			if (!this.imported.has(resolved)) {
				const imp = tryLoad(this.root, resolved, ['.ts', '.d.ts']);
				this.imported.set(resolved, imp);
			}
			return await this.imported.get(resolved);
		}

		const nm	= await NodeModules.get(this.root);//path.join(this.root, path.dirname(resolved)));
		const res	= await nm?.get(resolved);
		if (res)
			this.imported.set(resolved, Promise.resolve(res));
		return res;
	}
}
