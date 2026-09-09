// Shared plumbing for reading the official TypeScript compiler test corpus.
// Used by both `test-ts-official.ts` (the full parse+check smoke run) and `test-ts-corpus-gate.ts`
// (the fast pre-commit regression ratchet) -- kept in one place so the two can't drift apart.

import * as fs from 'fs/promises';
import * as path from 'path';

// Checked out separately on this machine; not part of this repo. Consumers must handle its absence.
export const TS_REPO = '/Volumes/DevSSD/dev/github/TypeScript';

export async function corpusPresent() {
	try {
		await fs.access(path.join(TS_REPO, 'tests/cases'));
		return true;
	} catch {
		return false;
	}
}

// A handful of corpus files are UTF-16 (BOM-prefixed), not UTF-8 -- reading those as 'utf8' decodes
// every 2-byte char as two garbage/replacement-char bytes, so the BOM itself picks the real encoding.
export function readSource(buf: Buffer): string {
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
		return buf.toString('utf16le', 2);
	if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
		return buf.swap16().toString('utf16le', 2);
	return buf.toString('utf8');
}

// The TS test suite bundles multiple virtual files into one physical file with
// `// @Filename: name` marker lines; anything before the first marker is global test
// config (e.g. `// @strict: true`), not code. Splitting on these markers is required --
// without it, a fifth of the corpus is a mangled concatenation of unrelated files (source,
// JSON, sometimes intentionally-invalid snippets) that fails to parse for reasons that have
// nothing to do with the checker itself.
const reFilename = /^\/\/[ \t]*@filename:[ \t]*(\S+)[ \t]*$/gim;

export function splitTestFile(source: string, defaultName: string) {
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

export const isSource = (name: string) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts');

// The real compiler's output for each test is baselined in tests/baselines/reference/. A test that
// produces any diagnostic gets a `NAME.errors.txt` (or `NAME(opt=val).errors.txt` per config
// variant); no such baseline means it is expected to compile clean. Basenames are globally unique
// across compiler/ + conformance/ and the baseline dir is flat, so basename is the key.
// We only act on the clean set -- an ERROR there is our checker rejecting code tsc accepts; whether
// we also reject what tsc rejects is not measured. (Rare stale baselines exist, so the clean signal
// is slightly lenient; the false-positive list gets eyeballed anyway.)
export async function expectsErrorsSet(): Promise<Set<string>> {
	const dir = path.join(TS_REPO, 'tests/baselines/reference');
	const out = new Set<string>();
	for (const f of await fs.readdir(dir)) {
		const m = /^(.*?)(?:\([^)]*\))?\.errors\.txt$/.exec(f);
		if (m)
			out.add(m[1]);
	}
	return out;
}

export const expectsErrors = (set: Set<string>, filename: string) =>
	set.has(path.basename(filename).replace(/\.tsx?$/, ''));

// Every corpus source file, sorted -- the ordering is what makes a fixed-size slice of it a stable,
// comparable sample across runs. Adding a file to the TS checkout can shift the slice; that is
// visible as a baseline change, which is the intended behaviour, not a false alarm.
export async function corpusFiles(dirs = ['compiler', 'conformance']): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string) {
		for (const entry of (await fs.readdir(dir, {withFileTypes: true})).sort((a, b) => a.name < b.name ? -1 : 1)) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory())
				await walk(full);
			else if (isSource(full))
				out.push(full);
		}
	}
	for (const d of dirs)
		await walk(path.join(TS_REPO, 'tests/cases', d));
	return out.sort();
}
