// Fast parser regression ratchet against a real-world Python corpus: the standard library shipped
// with whatever `python3` is on this machine's PATH (~700 files of idiomatic, definitely-valid
// modern Python -- CPython itself accepts every one of them). Mirrors test-ts-corpus-gate.ts.
//
//   npx ts-node -T test/test-py-corpus-gate.ts             # check against the baseline
//   npx ts-node -T test/test-py-corpus-gate.ts --update    # re-baseline after a real improvement
//   npx ts-node -T test/test-py-corpus-gate.ts --list      # print the failing files
//
// Two failure classes, both gated: a throw (can't parse at all), and an unstable round-trip
// (parse -> tocode -> reparse -> tocode gives a different string second time) -- the latter catches
// silent misparses that "did it throw" alone would miss (see tison_official_ts_test_suite.md's
// `3.e5` note). Files using syntax this parser deliberately doesn't support (`match` statements,
// PEP 695 generics/`type` aliases -- see py-parser.ts's file header) are excluded from the
// denominator via the real `ast` module as oracle, not a curated list.

import * as fs from 'fs/promises';
import * as path from 'path';
import { parse } from '../src/examples/PY/py-parser';
import { Output } from '../src/examples/PY/tocode';
import { corpusPresent, corpusFiles, unsupportedMap } from './py-corpus';

const BASELINE = path.join(__dirname, 'py-corpus-gate-baseline.json');
interface Baseline { files: number; failed: number; note: string }

(async () => {
	if (!await corpusPresent()) {
		console.log('SKIP: no python3 found on PATH -- gate not applicable on this machine');
		return;
	}

	const unsupported = await unsupportedMap();
	const files = (await corpusFiles()).filter(f => !unsupported.has(f));

	const t0 = Date.now();
	const failures: string[] = [];
	for (const file of files) {
		const source = await fs.readFile(file, 'utf8');
		try {
			const ast1 = parse(source);
			const printed1 = new Output().toCode(ast1);
			const printed2 = new Output().toCode(parse(printed1));
			if (printed1 !== printed2)
				failures.push(`${file} [unstable round-trip]`);
		} catch (e) {
			failures.push(`${file} [${(e as Error).message}]`);
		}
	}
	const elapsed = Date.now() - t0;

	if (process.argv.includes('--list'))
		failures.forEach(f => console.log(`  ${f}`));

	const failed = failures.length;
	if (process.argv.includes('--update')) {
		const next: Baseline = { files: files.length, failed, note: 'stdlib files that fail to parse or round-trip unstably, excluding files using syntax deliberately unsupported (match statement, PEP 695); lower is better' };
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

	if (base.files !== files.length) {
		console.log(`corpus size changed (${base.files} -> ${files.length} files) -- counts aren't comparable.`);
		console.log('Review with --list, then re-baseline with --update.');
		process.exit(1);
	}

	console.log(`corpus gate: ${failed} failures in ${files.length} files, baseline ${base.failed} (${elapsed}ms); ${unsupported.size} more use deliberately unsupported syntax`);
	if (failed > base.failed) {
		console.log(`\nFAIL: ${failed - base.failed} more file(s) fail than the baseline.`);
		console.log('Re-run with --list to see them. If this is a deliberate scope change, --update.');
		process.exit(1);
	}
	if (failed < base.failed)
		console.log(`${base.failed - failed} fewer than baseline -- commit the improvement with --update.`);
})();
