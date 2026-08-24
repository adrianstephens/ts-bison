import * as JSX from '../src/examples/TS/jsx-parser';
import * as TS from '../src/examples/TS/ts-parser';
import { TStypeCheckAsync, FixOptions, applyPragmas } from '../src/examples/TS/transform';
import { ModuleLoader } from '../src/examples/TS/module-loader';

import * as fs from 'fs/promises';
import * as path from 'path';
import { SEVERITY } from '../src/examples/TS/checker';

// Official TypeScript compiler test suite, checked out separately on this machine.
const TS_REPO = '/Volumes/DevSSD/dev/github/TypeScript';

const parser = TS.make();
JSX.add();
const parserX = TS.make();

const total_sev = [] as number[];
let failed = 0, tested = 0;

// The TS test suite bundles multiple virtual files into one physical file with
// `// @Filename: name` marker lines; anything before the first marker is global test
// config (e.g. `// @strict: true`), not code. Splitting on these markers is required --
// without it, a fifth of the corpus is a mangled concatenation of unrelated files (source,
// JSON, sometimes intentionally-invalid snippets) that fails to parse for reasons that have
// nothing to do with the checker itself.
const reFilename = /^\/\/[ \t]*@filename:[ \t]*(\S+)[ \t]*$/gim;

function splitTestFile(source: string, defaultName: string) {
	const markers = [...source.matchAll(reFilename)];
	if (!markers.length)
		return [{name: defaultName, content: source}];

	return markers.map((m, i) => ({
		name:		m[1],
		// Strip the one newline right after the marker line -- a real standalone file never has a
		// leading blank line, and leaving it in breaks a leading shebang (`^#!` only matches col 0).
		content:	source.slice(m.index + m[0].length, markers[i + 1]?.index ?? source.length).replace(/^\r?\n/, ''),
	}));
}

// A handful of corpus files are UTF-16 (BOM-prefixed), not UTF-8 -- reading those as 'utf8' decodes
// every 2-byte char as two garbage/replacement-char bytes, so the BOM itself picks the real encoding.
function readSource(buf: Buffer): string {
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
		return buf.toString('utf16le', 2);
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
		return buf.swap16().toString('utf16le', 2);
	return buf.toString('utf8');
}

async function testFile(filename: string) {
	const source = readSource(await fs.readFile(filename));

	for (const virtual of splitTestFile(source, filename)) {
		if (!/\.tsx?$/.test(virtual.name) || virtual.name.endsWith('.d.ts'))
			continue;

		tested++;
		try {
			const options	= FixOptions({target: 'esnext'});
			applyPragmas(virtual.content, options);
			const loader	= new ModuleLoader(path.dirname(filename), options);

			const useParser	= virtual.name.endsWith('.tsx') ? parserX : parser;
			const program	= useParser.parse(virtual.content);
			const diags		= await TStypeCheckAsync(program, loader, options);

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
