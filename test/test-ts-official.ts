import * as JSX from '../src/examples/TS/jsx-parser';
import * as TS from '../src/examples/TS/ts-parser';
import * as T from '../src/examples/TS/type-utils';
import { SEVERITY, checkBlock } from '../src/examples/TS/checker';

import { TStypeCheckAsync } from '../src/examples/TS/transform';
import { ModuleLoader } from '../src/examples/TS/module-loader';

import * as fs from 'fs/promises';
import * as path from 'path';
import { TS_REPO, readSource, splitTestFile } from './ts-corpus';

const parser = TS.make();
JSX.add();
const parserX = TS.make();

const lib = (async () => {
	const global	= T.makeGlobal();
	const loader	= new ModuleLoader(__dirname, {});
	const lib		= await loader.get('typescript/lib/lib.esnext.full', '.');
	checkBlock(lib!.body, global);
	return global;
})();

const total_sev = [] as number[];
let failed = 0, tested = 0;

async function testFile(filename: string) {
	const source = readSource(await fs.readFile(filename));

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
				total_sev[d.severity] ??= 0;
				++total_sev[d.severity];
			}
		} catch (e) {
			++failed;
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
	// compiler/conformance are real standalone TS source snippets, so parser+checker crashes here
	// point at real gaps. fourslash embeds its code in `//// ` comments behind a test DSL, and
	// project/projects/transpile are fixture directories (configs, multi-project setups), not
	// plain source files -- neither is meaningful input for this smoke test.
	for (const dir of ['compiler', 'conformance'])
		await testDir(path.join(TS_REPO, 'tests/cases', dir));

	console.log(`\n${tested} files tested, ${failed} threw`);
	total_sev.forEach((n, i) => console.log(`${['GAP', 'WARNING', 'ERROR'][i]}: ${n}`));
})();
