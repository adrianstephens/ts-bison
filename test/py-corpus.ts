// Shared plumbing for reading a real-world Python corpus: the standard library shipped with
// whatever `python3` is on this machine's PATH. Not part of this repo -- consumers must handle
// its absence. Mirrors ts-corpus.ts's shape so the two harnesses don't drift apart in method.

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

let stdlibDir: string | undefined | null; // undefined = not yet resolved, null = no python3 found

async function resolveStdlibDir(): Promise<string | null> {
	if (stdlibDir !== undefined)
		return stdlibDir;
	try {
		const { stdout } = await execFileAsync('python3', ['-c', "import sysconfig; print(sysconfig.get_paths()['stdlib'])"]);
		stdlibDir = stdout.trim();
	} catch {
		stdlibDir = null;
	}
	return stdlibDir;
}

export async function corpusPresent() {
	return (await resolveStdlibDir()) !== null;
}

const EXCLUDE_DIRS = new Set(['test', 'idle_test', '__pycache__']);

// Every .py file under the stdlib, sorted -- the ordering is what makes counts comparable across
// runs. A different python3 (a new install, a different machine) can shift this; that shows up as
// a "corpus size changed" message in the gate, not a false alarm.
export async function corpusFiles(): Promise<string[]> {
	const root = await resolveStdlibDir();
	if (!root)
		return [];
	const out: string[] = [];
	async function walk(dir: string) {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!EXCLUDE_DIRS.has(entry.name))
					await walk(path.join(dir, entry.name));
			} else if (entry.name.endsWith('.py')) {
				out.push(path.join(dir, entry.name));
			}
		}
	}
	await walk(root);
	return out.sort();
}

// Batch-runs the real CPython `ast` module over the whole corpus in one process (fast) and asks
// it, per file, whether the file uses syntax this parser deliberately doesn't support (the
// `match` statement, PEP 695 generics / `type` aliases) -- the real grammar as oracle, not a
// curated list, so it can't silently go stale the way a hand-maintained exclusion list did on
// the TS side (see tison_official_ts_test_suite.md).
export async function unsupportedMap(): Promise<Map<string, string>> {
	const root = await resolveStdlibDir();
	const out = new Map<string, string>();
	if (!root)
		return out;
	const { stdout } = await execFileAsync('python3', [path.join(__dirname, 'py-corpus-classify.py'), root], { maxBuffer: 64 * 1024 * 1024 });
	for (const line of stdout.split('\n')) {
		if (!line.trim())
			continue;
		const { path: p, unsupported } = JSON.parse(line);
		if (unsupported)
			out.set(p, unsupported);
	}
	return out;
}
