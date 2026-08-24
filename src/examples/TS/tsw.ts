#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import * as TS from './ts-parser';
import { TStoWasm, makeLibScope } from './towasm';
import { TStypeCheckAsync, FixOptions, applyPragmas } from './transform';
import { ModuleLoader, collectModules } from './module-loader';
import { SEVERITY } from './checker';

const parser = TS.make();
// Built once, reused across every input file below -- same lib declarations either way, no reason to
// re-check them per file. Passed into `TStypeCheckAsync` so user code is checked with lib members already
// in view -- `TStoWasm` reads the same lib-aware scope back off `ast.scope`, not passed to it directly.
const libScope = makeLibScope();

// TStoWasm assumes its input already passed a real checking pass (same contract as TStoJS/TStoDecl) -- it
// does no error reporting of its own, so that gate belongs here, in the caller, not in the library.
// `TStypeCheckAsync` (not the synchronous, single-file `TStypeCheck`) so a real `import` resolves against
// the file's own directory via `ModuleLoader`, matching `test-ts-parser.ts`'s own `testAsync` -- otherwise
// every cross-file reference is silently left unresolved and leniently un-flagged.
//
// No WAT text, no wabt/binaryen: `TStoWasm` returns a `@isopodlabs/binary_libs` `wasm.WasmModule`
// directly, and that package's own `.toBytes()` is the assembler -- a first-party GC-capable writer
// (wabt's published build has GC compiled out entirely; binaryen works but is ~200x this project's
// own size for what's fundamentally a fixed, self-controlled instruction set -- see the write-up).
async function compile(filein: string, fileout: string, wat = false) {
	const src			= await fs.readFile(filein, 'utf8');
	const options		= FixOptions({target: 'es2022'});
	applyPragmas(src, options);
	const loader		= new ModuleLoader(path.dirname(filein), options);

	const program		= parser.parse(src);
	const diagnostics	= await TStypeCheckAsync(program, loader, options, libScope);
	const errors		= diagnostics.filter(d => d.severity === SEVERITY.ERROR);
	if (errors.length)
		throw new Error('type errors:\n' + errors.map(d => `  ${d.pos.line}:${d.pos.col} - ${d.message}`).join('\n'));

	// Real multi-file codegen: seed `TStoWasm` from every module the loader actually resolved (not just
	// the entry file's own body), plus each module's own namespace-import bindings, so a real cross-file
	// call (`NS.foo(...)`) resolves to the declaring file's own AST, not just its checked type. Only a
	// plain top-level *function* declared in another module is supported this way today -- a cross-module
	// class/scalar global, or a plain (non-namespace) `import { foo } from '...'`, still isn't; either
	// throws a clear, specific error from `TStoWasm` rather than miscompiling.
	const { modules, namespaceImports } = await collectModules(program.body, loader);
	const mod		= TStoWasm(program, modules, namespaceImports);
	if (wat)
		console.log(mod.toWAT({expandTypes: true, hexFloats: false}));

	await fs.writeFile(fileout, mod.toBytes());
}

// --- CLI ---

const args = process.argv.slice(2);
let wat = false;
const inputs: string[] = [];
let output: string | undefined;

for (let i = 0; i < args.length; i++) {
	switch (args[i]) {
		case '--wat': wat = true; break;
		case '-o': output = args[++i]; break;
		case '--help':
		case '-h':
			console.log('Usage: tsw [--wat] [-o output.wasm] input.ts');
			process.exit(0);
			break;
		default:
			if (args[i].startsWith('-')) {
				console.error(`Unknown option: ${args[i]}`);
				process.exit(1);
			}
			inputs.push(args[i]);
	}
}

if (inputs.length === 0) {
	console.error('Error: no input file specified');
	console.error('Usage: tsw [--wat] [-o output.wasm] input.ts');
	process.exit(1);
}
if (inputs.length > 1 && output) {
	console.error('Error: -o cannot be used with multiple input files');
	process.exit(1);
}

for (const input of inputs) {
	const out = output ?? input.replace(/\.ts$/, '.wasm');
	compile(input, out, wat).catch(e => {
		console.error(e.message);
		process.exit(1);
	});
}

