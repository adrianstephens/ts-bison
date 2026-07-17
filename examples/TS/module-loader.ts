import * as TS from './ts-parser';

import * as fs from 'fs';
import * as path from 'path';

const reExt = /\.[^/]+$/;

function stripExt(file: string): string {
	return file.replace(reExt, '');
}
function addMissingExt(file: string, ext: string) {
	return reExt.test(file) ? file : file + ext;
}

async function tryLoadCode(full: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(full, 'utf8');
	} catch {
		return undefined;
	}
}

async function load(root: string, canonical: string) : Promise<LoadedModule | undefined> {
	const code = await tryLoadCode(path.join(root, canonical + '.ts'))
			||	await tryLoadCode(path.join(root, canonical + '.d.ts'));
	if (code)
		try {
			return {body: TS.parse(code).body, canonical: canonical };
		} catch(e) {
			console.error(`Failed to parse ${canonical}: ${e}`);
		}
}

export interface LoadedModule {
	body:		TS.Statement[];
	canonical:	string;	// relative import *inside* that module must resolve relative to where the module really lives
}

async function loadCodeFromPackage(pkgDir: string, pkg: string, subpath: string): Promise<{ code: string; canonical: string } | undefined> {
	const code 	= await tryLoadCode(path.join(pkgDir, subpath) + '.d.ts');
	if (code)
		return { code, canonical: path.join(pkg, subpath) };

	try {
		const pkgjson	= JSON.parse(await fs.promises.readFile(path.join(pkgDir, 'package.json'), 'utf8'));

		if (subpath) {
			const exp = pkgjson.exports?.['./' + subpath]?.['types'];
			if (exp) {
				const code = await tryLoadCode(path.join(pkgDir, exp));
				if (code)
					return { code, canonical: path.join(pkg, stripExt(exp)) };
			}

		} else {
			const types = pkgjson.types ?? pkgjson.typings ?? (stripExt(pkgjson.main) ?? 'index');
			const code	= await tryLoadCode(path.join(pkgDir, addMissingExt(types, '.d.ts')));
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

const referenceRE = /^\/\/\/\s*<reference\s+(path|types|lib)=["']([^"']+)["']\s*\/>/gm;

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
	parent?:	NodeModules;
	ready;

	private constructor(public root: string, restrictTypes?: string[]) {
		this.ready = this.scan(path.join(root, 'node_modules/@types'), restrictTypes);
	}
	private async scan(types: string, restrictTypes?: string[]) {
		try {
			const dirs = await fs.promises.readdir(types, {withFileTypes: true});
			await Promise.all(dirs.filter(i => i.isDirectory() && (!restrictTypes || restrictTypes.includes(i.name))).map(i =>
				this.loadDirectory(path.join(types, i.name))
			));
		} catch {
			// no @types dir
		}
	}

	private async loadDirectory(dir: string): Promise<void> {
		const entries = await fs.promises.readdir(dir, {withFileTypes: true});
		await Promise.all(entries.map(async i => {
			if (i.isDirectory())
				return this.loadDirectory(path.join(dir, i.name));
			if (i.name.endsWith('.d.ts')) {
				const body	= fs.promises.readFile(path.join(dir, i.name), 'utf8').then(code => TS.parse(code).body);
//				this.found.set(i.name, body);
				this.registerDeclaredModules(await body);
			}
		}));
	}

	// Ambient `declare module 'X' { ... }` blocks are self-contained (no real file of their own),
	// so there's nothing more meaningful than the module's own name to use as their canonical specifier.
	protected registerDeclaredModules(body: TS.Statement[]) {
		for (const s of body) {
			if (s.type === 'declare' && s.declaration.type === 'module_decl')
				this.imported.set(s.declaration.name, { body: s.declaration.body, canonical: s.declaration.name });
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
		const body = TS.parse(code).body;
		for (const [, kind, ref] of code.matchAll(referenceRE)) {
			const refMod = kind === 'types' ? ref : joinSpecifier(canonical, kind === 'lib' ? './lib.' + ref : ref);
			if (!seen.has(refMod)) {
				const res = await this.tryLocalCode(refMod);
				if (res)
					body.push(...await this.withReferences(res.code, res.canonical, seen));
			}
		}
		return body;
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
			try {
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
			} catch(e) {
				console.error(`Failed to parse ${mod}: ${e}`);
			}
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

	constructor(public root: string, restrictTypes?: string[]) {
		NodeModules.get(root, restrictTypes);
	}

	async local(resolved: string) {
		return await load(this.root, resolved) || await load(this.root, resolved + '/index');
	}

	async get(mod: string, from: string): Promise<LoadedModule | undefined> {
		const resolved = mod.startsWith('.') ? joinSpecifier(from, mod) : mod;

		if (!this.imported.has(resolved)) {
			if (resolved.startsWith('.')) {
				this.imported.set(resolved, this.local(resolved));
			} else {
				const nm	= await NodeModules.get(this.root);
				if (!nm)
					return undefined;
				this.imported.set(resolved, nm.get(resolved));
			}
		}
		return await this.imported.get(resolved);
	}
}
