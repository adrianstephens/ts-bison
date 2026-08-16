// Opt-in, Node-only wrapper around `makeParser` that persists built LALR tables to disk and skips
// `buildTables` on subsequent runs when the grammar hasn't changed. Kept out of tison.ts so the core
// engine stays free of `fs`/`crypto`/`zlib` and usable outside Node.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { GrammarBuilder, makeParser, grammarFingerprint, serializeTables, deserializeTables, type GrammarSpec, type Parser, type SerializedTables } from './tison';

interface CacheFile {
	fingerprint: string;
	tables: SerializedTables;
}

function hash(value: unknown): string {
	return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// `SerializedTables` is already just a small alphabet of repeated small integers (terminal/nonterminal
// indices, entry tags, rule/state numbers) -- exactly what gzip's dictionary-based compression targets,
// and cheaply: cutting the on-disk size by another order of magnitude costs nothing but a `gzipSync`.
// Files are gzip'd, so `cachePath` should carry a `.gz`-ish name (not enforced, just convention).

// `cachePath` should be specific to the grammar it's caching (one file per `makeCachedParser` call
// site) -- there's no namespacing beyond the fingerprint check.
export function makeCachedParser<T>(spec: GrammarSpec<T>, cachePath: string, gz = true): Parser<T> {
	const g				= new GrammarBuilder(spec);
	const fingerprint	= hash(grammarFingerprint(g, spec));

	let cached: CacheFile | undefined;
	try {
		cached = JSON.parse(gz ? zlib.gunzipSync(fs.readFileSync(cachePath)).toString('utf8') : fs.readFileSync(cachePath, 'utf8'));
	} catch {
		// missing or unreadable cache -- fall through to a fresh build
	}

	if (cached?.fingerprint === fingerprint) {
		try {
			return makeParser(spec, { g, tables: deserializeTables(g, cached.tables) });
		} catch {
			// stale/corrupt cache content despite a matching fingerprint (e.g. hand-edited) -- rebuild
		}
	}

	// No `tables` given: makeParser builds and (unless `spec.optimize === false`) optimizes them itself.
	const parser = makeParser(spec, { g });
	try {
		const json = JSON.stringify({ fingerprint, tables: serializeTables(g, parser.tables) });
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, gz ? zlib.gzipSync(json) : json);
	} catch {
		// best-effort: a failed write just means next run rebuilds too
	}
	return parser;
}
