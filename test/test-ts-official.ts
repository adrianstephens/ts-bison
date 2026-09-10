import * as JSX from '../src/examples/TS/jsx-parser';
import * as TS from '../src/examples/TS/ts-parser';
import * as T from '../src/examples/TS/type-utils';
import { SEVERITY, checkBlock } from '../src/examples/TS/checker';

import { TStypeCheckAsync } from '../src/examples/TS/transform';
import { ModuleLoader } from '../src/examples/TS/module-loader';

import * as fs from 'fs/promises';
import * as path from 'path';
import { TS_REPO, readSource, splitTestFile, expectsErrorsSet, expectsErrors } from './ts-corpus';

const parser = TS.make();
JSX.add();
const parserX = TS.make();

const lib = (async () => {
	const global	= T.makeGlobal();
	const loader	= new ModuleLoader(__dirname, {});
	const lib		= await loader.get('typescript/lib/lib.esnext.full', '.');
	checkBlock(lib!.program.body, global);
	return global;
})();

// Counts are split by whether the real compiler produces a diagnostic for the test. The `clean`
// bucket is the one that matters: an ERROR (or throw) there is our checker rejecting source tsc
// accepts. The `expectErr` bucket is informational -- we don't try to match tsc's rejections.
const sev = { clean: [] as number[], expectErr: [] as number[] };
let failed = { clean: 0, expectErr: 0 }, tested = 0;
const falsePositives: string[] = [];			// clean-bucket files where we emit an ERROR or throw

let errset: Set<string>;

async function testFile(filename: string) {
	const source = readSource(await fs.readFile(filename));
	const bucket = expectsErrors(errset, filename) ? 'expectErr' : 'clean';

	for (const virtual of splitTestFile(source, filename)) {
		if (!/\.tsx?$/.test(virtual.name) || virtual.name.endsWith('.d.ts'))
			continue;

		tested++;
		try {
			const loader	= new ModuleLoader(path.dirname(filename), {});
			const useParser	= virtual.name.endsWith('.tsx') ? parserX : parser;
			const program	= useParser.parse(virtual.content);
			const diags		= await TStypeCheckAsync(program, loader, await lib);

			for (const d of diags) {
				sev[bucket][d.severity] ??= 0;
				++sev[bucket][d.severity];
				if (bucket === 'clean' && d.severity === SEVERITY.ERROR)
					falsePositives.push(`${path.relative(TS_REPO, filename)}\t${d.pos.line}:${d.pos.col}\t${d.message.split('\n')[0]}`);
			}
		} catch (e) {
			++failed[bucket];
			if (bucket === 'clean')
				falsePositives.push(`${path.relative(TS_REPO, filename)}\tthrew\t${e instanceof Error ? e.message.split('\n')[0] : e}`);
			console.error(`${filename} (${virtual.name}) failed:`, e);
		}
	}
}

async function testDir(dir: string) {
	for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory())
			await testDir(full);
		else if (/\.tsx?$/.test(full) && !full.endsWith('.d.ts'))
			await testFile(full);
	}
}

(async () => {
	errset = await expectsErrorsSet();

	// compiler/conformance are real standalone TS source snippets, so parser+checker crashes here
	// point at real gaps. fourslash embeds its code in `//// ` comments behind a test DSL, and
	// project/projects/transpile are fixture directories (configs, multi-project setups), not
	// plain source files -- neither is meaningful input for this smoke test.
	for (const dir of ['compiler', 'conformance'])
		await testDir(path.join(TS_REPO, 'tests/cases', dir));

	const names = ['GAP', 'WARNING', 'ERROR'];
	const line = (label: string, f: number, s: number[]) =>
		`${label.padEnd(12)} threw ${String(f).padStart(5)}   ` + names.map((n, i) => `${n} ${String(s[i] ?? 0).padStart(6)}`).join('   ');

	console.log(`\n${tested} virtual files tested`);
	console.log(line('tsc-clean', failed.clean, sev.clean));
	console.log(line('tsc-errors', failed.expectErr, sev.expectErr));
	console.log(`\n${falsePositives.length} ERROR/throw on tsc-clean files (our false positives):`);

	if (falsePositives.length) {
		const dump = path.join(__dirname, '../../assistant/corpus-false-positives.txt');
		try {
			await fs.writeFile(dump, falsePositives.sort().join('\n') + '\n');
			console.log(`  written to ${path.relative(process.cwd(), dump)}`);
		} catch {
			// no assistant/ dir (e.g. running from a bare worktree) -- the console list is enough
			falsePositives.sort().forEach(l => console.log(`  ${l}`));
		}
	}
})();
