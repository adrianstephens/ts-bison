// Opt-in, Node-only wrapper around `makeParser` that keeps built LALR tables on disk and skips
// `buildTables` on the next run while the grammar's sources are unchanged. Kept out of tison.ts so the
// core engine stays free of `fs` and usable outside Node.
//
// The cache file is binary -- no `JSON`, `crypto` or `zlib`. Every number in the tables is a small
// non-negative index (entry tag, terminal/nonterminal/rule/state number, row length), so unsigned varints
// encode them directly: one byte per number where the JSON text of the same rows needed two or more.
// Gzipping the old JSON text still came out smaller than this file; the larger file is the deliberate
// choice, since a cache this size does not need the ratio and `zlib`/`crypto` are two more Node builtins.
//
//   'TSLR'    magic
//   varint    TABLE_FORMAT_VERSION of the engine that wrote it
//   varint    table-affecting options: bit 0 `slr`, bit 1 `optimize !== false`
//   varint    `grammarDigest` of the grammar built from
//   varint    source count, then per source: mtimeMs as an f64, then size as a varint
//   varint    state count, then that many `action` rows and that many `goto` rows, each row a
//             varint length followed by that many varints
//
// The stamps catch an edited source file; the digest catches an edited GRAMMAR (jsx-parser's `add()` pushes
// rules into the shared objects after the first `make()`, which no timestamp can see). Neither alone is
// enough: the stamps save the digest walk on a miss, the digest is what makes a hit trustworthy.
//
// The engine's own modules are not among the sources: a change to what `buildLALR` builds is invalidated
// by bumping `TABLE_FORMAT_VERSION`, not by a timestamp.
import * as fs from 'fs';
import * as path from 'path';
import { GrammarBuilder, makeParser, type GrammarSpec } from './tison';
import { LALROptions, TABLE_FORMAT_VERSION, deserializeTables, grammarDigest, serializeTables, type LALRParser, type SerializedTables } from './lalr';

const MAGIC = 'TSLR';

export interface GrammarCache {
	// The example module(s) that declare the grammar's terminals and rules. A grammar assembled from
	// several of them (ts-parser.ts folds in js-parser.ts's rules, cpp-parser.ts pushes onto c-parser.ts's)
	// has to name every one -- a source left out is a source whose edits leave stale tables in place.
	sources:	string | [string, ...string[]];
	// One file per `makeCachedParser` call site: a cache identifies its grammar by these stamps alone, so
	// two grammars sharing a path would overwrite each other. Conventionally under `.tables-cache/`.
	cachePath:	string;
}

interface Stamp {
	mtimeMs:	number;
	size:		number;
}

// A module sitting next to the one that names it, in whatever form that one was loaded as -- `.ts` under
// ts-node, `.js` from `dist` -- so a grammar spread over two modules can name both by plain path arithmetic.
export function siblingSource(from: string, name: string): string {
	return path.join(path.dirname(from), name + path.extname(from));
}

// A source that isn't there is a caller mistake, not a cache miss -- a mistyped path would otherwise
// silently never invalidate anything -- so `statSync`'s throw is left to propagate.
function stampOf(source: string): Stamp {
	const stat = fs.statSync(source);
	return { mtimeMs: stat.mtimeMs, size: stat.size };
}

// `slr`/`optimize` are the only options that reach `buildLALR`; everything else in `LALROptions` is
// consumed by the parse itself and cannot change a table.
function tableFlags(options: LALROptions): number {
	return (options.slr ? 1 : 0) | (options.optimize === false ? 2 : 0);
}

// ===================================================================
//  Varint codec
// ===================================================================

// Values are table indices, rule numbers and row lengths: non-negative and far below 2^31, which is what
// makes the `& 0x7f` splitting safe.
function putVarint(out: number[], value: number) {
	while (value >= 0x80) {
		out.push((value & 0x7f) | 0x80);
		value = Math.floor(value / 0x80);
	}
	out.push(value);
}

// The state count is already in the header, so a row set is just rows.
function putRows(out: number[], rows: number[][]) {
	for (const row of rows) {
		putVarint(out, row.length);
		for (const value of row)
			putVarint(out, value);
	}
}

const stampScratch = new DataView(new ArrayBuffer(8));

function putStamp(out: number[], stamp: Stamp) {
	stampScratch.setFloat64(0, stamp.mtimeMs);
	for (let i = 0; i < 8; i++)
		out.push(stampScratch.getUint8(i));
	putVarint(out, stamp.size);
}

// Reads stop at the end of the bytes rather than throwing: a truncated file (an interrupted write, or one
// left by some other format) is a normal thing to find on disk, and `complete` reports it.
class Reader {
	constructor(private bytes: Buffer, private offset = 0) {}

	varint(): number {
		let value = 0;
		for (let place = 1; ; place *= 0x80) {
			const byte = this.bytes[this.offset++];
			if (byte === undefined)
				return 0;
			value += (byte & 0x7f) * place;
			if ((byte & 0x80) === 0)
				return value;
		}
	}

	// NaN past the end, which no real stamp can equal.
	stamp(): Stamp {
		if (!this.fits(8))
			return { mtimeMs: NaN, size: 0 };
		const stamp: Stamp = { mtimeMs: this.bytes.readDoubleBE(this.offset), size: 0 };
		this.offset += 8;
		stamp.size = this.varint();
		return stamp;
	}

	row(): number[] {
		const row: number[] = [];
		for (let n = this.varint(); n > 0 && this.fits(1); n--)
			row.push(this.varint());
		return row;
	}

	rows(count: number): number[][] {
		const rows: number[][] = [];
		for (let n = count; n > 0 && this.fits(1); n--)
			rows.push(this.row());
		return rows;
	}

	// The tail of the file: two row sets per state.
	tables(): SerializedTables | undefined {
		const states = this.varint();
		return this.complete({ action: this.rows(states), goto: this.rows(states) });
	}

	// The decode is an argument, so it has already happened by the time this runs. That ordering is the
	// point: a file is only usable if it ends exactly where the last row did, and a truncated one (an
	// interrupted write) or one with trailing junk is a miss rather than a parse of garbage.
	private complete(tables: SerializedTables): SerializedTables | undefined {
		return this.offset === this.bytes.length ? tables : undefined;
	}

	// A `count` that runs off the end stops its loop rather than spinning on a garbage one.
	private fits(count: number): boolean {
		return this.offset + count <= this.bytes.length;
	}
}

function sameStamp(a: Stamp, b: Stamp): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

// Absent, foreign, truncated or stale: each is just "build the tables this run".
function loadTables(cachePath: string, stamps: Stamp[], flags: number, digest: number): SerializedTables | undefined {
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(cachePath);
	} catch {
		return undefined;
	}
	if (bytes.toString('latin1', 0, MAGIC.length) !== MAGIC)
		return undefined;

	const reader = new Reader(bytes, MAGIC.length);
	if (reader.varint() !== TABLE_FORMAT_VERSION || reader.varint() !== flags || reader.varint() !== digest || reader.varint() !== stamps.length)
		return undefined;
	if (!stamps.every(stamp => sameStamp(reader.stamp(), stamp)))
		return undefined;
	return reader.tables();
}

// Best effort: a read-only install (a global one, say) rebuilds every run instead -- slower, still
// correct, and not worth a warning on every process start. The bytes themselves are built outside the
// guard, so a codec bug stays loud.
function saveTables(cachePath: string, stamps: Stamp[], flags: number, digest: number, tables: SerializedTables) {
	const bytes: number[] = [...MAGIC].map(c => c.charCodeAt(0));
	putVarint(bytes, TABLE_FORMAT_VERSION);
	putVarint(bytes, flags);
	putVarint(bytes, digest);
	putVarint(bytes, stamps.length);
	for (const stamp of stamps)
		putStamp(bytes, stamp);
	putVarint(bytes, tables.action.length);
	putRows(bytes, tables.action);
	putRows(bytes, tables.goto);

	try {
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, Buffer.from(bytes));
	} catch {
		// see above
	}
}

export function makeCachedParser<T>(spec: GrammarSpec<T>, options: LALROptions, cache: GrammarCache): LALRParser<T> {
	const g			= new GrammarBuilder(spec);
	const stamps	= (typeof cache.sources === 'string' ? [cache.sources] : cache.sources).map(stampOf);
	const flags		= tableFlags(options);
	const digest	= grammarDigest(g);
	const tables	= loadTables(cache.cachePath, stamps, flags, digest);
	if (tables)
		return makeParser(spec, { ...options, prebuiltBuilder: g, prebuiltTables: deserializeTables(g, tables) });

	// No `tables` given, so makeParser builds them and (unless `options.optimize === false`) optimizes them.
	const parser = makeParser(spec, { ...options, prebuiltBuilder: g });
	saveTables(cache.cachePath, stamps, flags, digest, serializeTables(g, parser.tables));
	return parser;
}
