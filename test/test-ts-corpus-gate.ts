// Fast parser regression ratchet against the official TypeScript corpus.
//
// This is a GATE, not a progress driver -- `test-ts-official.ts` is the one that walks the whole
// corpus and reports GAP/WARNING/ERROR counts. This one parses a fixed slice in a few seconds and
// fails if the failure count went UP, so a parser regression is caught at commit time instead of
// weeks later. (A real one shipped undetected through two commits: `makeCachedParser` stopped
// forwarding `recover`, which disabled ASI -- that took a 200-file sample from 37 to 62 failures.)
//
//   npx ts-node -T test/test-ts-corpus-gate.ts             # check against the baseline (~10s)
//   npx ts-node -T test/test-ts-corpus-gate.ts --update    # re-baseline after a real improvement
//   npx ts-node -T test/test-ts-corpus-gate.ts --list       # print the failing files
//
// Deliberately only detects THROWS. It cannot see a silent misparse (e.g. `3.e5` parsing as
// `(3.).e5`) -- that needs a round-trip check, which belongs in a separate, slower gate.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as TS from '../src/examples/TS/ts-parser';
import { corpusFiles, corpusPresent, readSource, splitTestFile, isSource, syntaxErrorsSet, usesUnsupportedSyntax, TS_REPO } from './ts-corpus';

const BASELINE	= path.join(__dirname, 'ts-corpus-gate-baseline.json');
// No sampling: the whole corpus parses in well under 10s, so the gate is complete rather than a
// slice -- which also means adding files to the TS checkout can't silently shift what's measured.
interface Baseline { files: number; failed: number; note: string }

(async () => {
	if (!await corpusPresent()) {
		console.log(`SKIP: no TypeScript corpus at ${TS_REPO} -- gate not applicable on this machine`);
		return;
	}

	// Deliberately-invalid fixtures, by tsc's OWN baseline reporting a syntactic (TS1xxx) diagnostic:
	// it could not parse them either, so failing to is not a gap here. Derived, not a curated list.
	const excluded	= await syntaxErrorsSet();
	const files		= (await corpusFiles()).filter(f => !excluded.has(path.basename(f).replace(/\.tsx?$/, '')));
	const parser = TS.make();

	const t0 = Date.now();
	const failures: string[] = [];
	let unsupported = 0;
	for (const file of files) {
		const source = readSource(await fs.readFile(file));
		for (const virtual of splitTestFile(source, file)) {
			if (!isSource(virtual.name))
				continue;
			try {
				parser.parse(virtual.content);
			} catch {
				if (usesUnsupportedSyntax(virtual.name, virtual.content))
					unsupported++;
				else
					failures.push(`${path.relative(TS_REPO, file)}${virtual.name === file ? '' : ` [${virtual.name}]`}`);
			}
		}
	}
	const elapsed = Date.now() - t0;

	if (process.argv.includes('--list'))
		failures.forEach(f => console.log(`  ${f}`));

	const failed = failures.length;
	if (process.argv.includes('--update')) {
		const next: Baseline = { files: files.length, failed, note: 'corpus files that fail to PARSE (no checker), excluding fixtures tsc itself reports a TS1xxx syntax error on, and ones using syntax deliberately unsupported (legacy <T>expr casts); lower is better' };
		await fs.writeFile(BASELINE, JSON.stringify(next, null, '\t') + '\n');
		console.log(`baseline updated: ${failed} failures in ${files.length} files (${elapsed}ms)`);
		return;
	}

	let base: Baseline;
	try {
		base = JSON.parse(await fs.readFile(BASELINE, 'utf8'));
	} catch {
		console.log(`no baseline yet -- run with --update to record ${failed} failures in ${files.length} files`);
		process.exit(1);
	}

	// A changed file count means the TS checkout moved, so the two numbers measure different things.
	if (base.files !== files.length) {
		console.log(`corpus size changed (${base.files} -> ${files.length} files) -- counts aren't comparable.`);
		console.log(`Review with --list, then re-baseline with --update.`);
		process.exit(1);
	}

	console.log(`corpus gate: ${failed} failures in ${files.length} files, baseline ${base.failed} (${elapsed}ms); ${unsupported} more use deliberately unsupported syntax`);
	if (failed > base.failed) {
		console.log(`\nFAIL: ${failed - base.failed} more file(s) fail to parse than the baseline.`);
		console.log(`Re-run with --list to see them. If this is a deliberate scope change, --update.`);
		process.exit(1);
	}
	if (failed < base.failed)
		console.log(`${base.failed - failed} fewer than baseline -- commit the improvement with --update.`);
})();
