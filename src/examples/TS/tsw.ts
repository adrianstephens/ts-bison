#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import * as TS from './ts-parser';
import * as JSX from './jsx-parser';
import * as T from './type-utils';
import { TStoWasm, makeLibScope } from './towasm';
import { TStypeCheckAsync, OutputOptionsDefault } from './transform';
import { ModuleLoader, collectModules, OptionsDefault as ModuleOptionsDefault } from './module-loader';
import { SEVERITY } from './checker';

const parser = TS.make();
// Built once, reused across every input file below -- same lib declarations either way, no reason to
// re-check them per file. Passed into `TStypeCheckAsync` so user code is checked with lib members already
// in view -- `TStoWasm` reads the same lib-aware scope back off `ast.scope`, not passed to it directly.
const libScope = makeLibScope();

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
	...OutputOptionsDefault,
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
//JSX
	...JSX.OptionsDefault,
//Language
	Environment:							undefined,
	emitDecoratorMetadata:					undefined,
	experimentalDecorators:					undefined,
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
	const diagnostics	= await TStypeCheckAsync(program, loader, new T.Scope(libScope));
	const errors		= diagnostics.filter(d => d.severity === SEVERITY.ERROR);
	if (errors.length)
		throw new Error('type errors:\n' + errors.map(d => `  ${d.pos.line}:${d.pos.col} - ${d.message}`).join('\n'));

	// Real multi-file codegen: seed `TStoWasm` from every module the loader actually resolved (not just
	// the entry file's own body), plus each module's own namespace-import and named-import bindings, so a
	// real cross-file call (`NS.foo(...)` or a plain `foo(...)` imported via `import { foo } from '...'`)
	// resolves to the declaring file's own AST, not just its checked type. Only a plain top-level
	// *function* declared in another module is supported this way today -- a cross-module class/scalar
	// global still isn't; that throws a clear, specific error from `TStoWasm` rather than miscompiling.
	const { modules, namedImports } = await collectModules(program.body, loader);
	const mod		= TStoWasm(program, modules, namedImports);
	if (wat)
		console.log(mod.toWAT({expandTypes: true, hexFloats: false}));

	await fs.writeFile(fileout, mod.toBytes());
}

// --- CLI ---

const args = process.argv.slice(2);
if (args.length === 0)
	//args.push('/Volumes/DevSSD/dev/packages/tison/src/tison.ts', '--wat');
	args.push('/Volumes/DevSSD/dev/packages/tison/src/examples/TS/lib/bigint.ts', '--wat');

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

