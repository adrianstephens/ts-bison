// The on-disk table cache: a cache that is still current must be a HIT (the file is not rewritten), an
// edited grammar source, a different source set, a table-affecting option change, a truncated file and
// trailing junk must each be a MISS, and the tables a hit loads must be byte-for-byte the ones a fresh
// `buildTables` produced -- i.e. the binary format round-trips.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GrammarBuilder, makeParser, Rules, Rule, WithPrec, serializeTables, type GrammarSpec, type LALROptions, type LALRParser } from '../dist/tison';
import { makeCachedParser, type GrammarCache } from '../dist/tableCache';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
	if (Object.is(actual, expected)) {
		console.log(`  ok   ${name} = ${String(actual)}`);
	} else {
		console.error(`  FAIL ${name}: got ${String(actual)}, expected ${String(expected)}`);
		failures++;
		process.exitCode = 1;
	}
}

function checkThrows(name: string, fn: () => unknown, match: RegExp) {
	try {
		const value = fn();
		console.error(`  FAIL ${name}: expected a throw, got ${String(value)}`);
		failures++;
		process.exitCode = 1;
	} catch (e) {
		const msg = (e as Error).message;
		if (match.test(msg)) {
			console.log(`  ok   ${name} threw: ${msg.split('\n')[0]}`);
		} else {
			console.error(`  FAIL ${name}: threw ${JSON.stringify(msg)}, expected /${match.source}/`);
			failures++;
			process.exitCode = 1;
		}
	}
}

function section(name: string) {
	console.log(`\n=== ${name} ===`);
}

const NUMBER = /[0-9]+/;

const arith: GrammarSpec<number> = {
	skip: [/\s+/],
	precedence: {
		additive:		'left',
		multiplicative:	'left',
	},
	start: Rules<number>(self => [
		WithPrec(Rule([self, '+', self] as const,	$ => $[0] + $[2]), 'additive'),
		WithPrec(Rule([self, '*', self] as const,	$ => $[0] * $[2]), 'multiplicative'),
		Rule(['(', self, ')'] as const,				$ => $[1]),
		Rule([NUMBER],								$ => parseFloat($[0])),
	]),
};

const EXPRS		= ['1 + 2 * 3', '(1 + 2) * 3', '2 * 3 + 4', '7'];
const parseAll	= (p: LALRParser<number>) => EXPRS.map(e => p.parse(e)).join();

// What a cache file has to reproduce: the rows `serializeTables` derives from a parser's own tables.
const rowsOf = (parser: LALRParser<number>) => JSON.stringify(serializeTables(new GrammarBuilder(arith), parser.tables));

const dir		= fs.mkdtempSync(path.join(os.tmpdir(), 'tison-table-cache-'));
const source	= path.join(dir, 'grammar.ts');
const other		= path.join(dir, 'other.ts');
const cachePath	= path.join(dir, 'grammar.tables');
const build		= (options: LALROptions = {}, sources: GrammarCache['sources'] = source) => makeCachedParser(arith, options, { sources, cachePath });

fs.writeFileSync(source, '// v1\n');
fs.writeFileSync(other, '// other\n');
fs.utimesSync(other, 4242, 4242);

// A rewrite of identical bytes is invisible in the file, so every miss is observed through the cache
// file's mtime: move it to a sentinel first, and only a rewrite can move it off that value.
const SENTINEL	= 1000_000;
const markFile	= () => fs.utimesSync(cachePath, SENTINEL / 1000, SENTINEL / 1000);
const rewritten	= () => fs.statSync(cachePath).mtimeMs !== SENTINEL;

section('round trip');
{
	const reference	= makeParser(arith);
	check('the first call parses', parseAll(build()), parseAll(reference));
	check('the first call wrote a cache', fs.existsSync(cachePath), true);

	markFile();
	const hit = build();
	check('a hit does not rewrite the cache', rewritten(), false);
	check('a hit parses the same', parseAll(hit), parseAll(reference));
	check('a hit loads the tables that were built', rowsOf(hit), rowsOf(reference));
}

section('misses');
{
	markFile();
	fs.writeFileSync(source, '// v2, longer\n');
	check('an edited source parses', parseAll(build()), parseAll(makeParser(arith)));
	check('an edited source is a miss', rewritten(), true);

	markFile();
	build({ optimize: false });
	check('another option set is a miss', rewritten(), true);
	markFile();
	build({ optimize: false });
	check('the same option set is a hit', rewritten(), false);

	markFile();
	build({}, other);
	check('another source is a miss', rewritten(), true);
	markFile();
	build({}, [source, other]);
	check('an extra source is a miss', rewritten(), true);

	markFile();
	checkThrows('a source that is not there throws', () => build({}, path.join(dir, 'nope.ts')), /ENOENT/);
	check('a source that is not there leaves the cache alone', rewritten(), false);
}

section('a grammar changed in memory');
{
	// The regression this guards: `jsx-parser.add()` pushes rules into the shared rule objects AFTER the first
	// `make()`, so the grammar on the second call is a different one while its source files are untouched --
	// only the digest can tell, and a miss here is the difference between JSX parsing and silent garbage.
	const start		= Rules<number>(Rule([NUMBER], $ => parseFloat($[0])));
	const grammar	= { skip: [/\s+/], start };
	const before	= makeCachedParser(grammar, {}, { sources: source, cachePath });
	checkThrows('the grammar as it stands rejects a unary minus', () => before.parse('-1'), /./);

	start.push(Rule(['-', NUMBER] as const, $ => -parseFloat($[1])));
	markFile();
	const after = makeCachedParser(grammar, {}, { sources: source, cachePath });
	check('the added alternative parses', after.parse('-1'), -1);
	check('the tables were rebuilt, not reused', after.tables.action.length > before.tables.action.length, true);
	check('a grammar changed in memory is a miss', rewritten(), true);
}

section('damaged and foreign files');
{
	fs.writeFileSync(cachePath, 'TSLR\x04');
	check('a truncated file parses', parseAll(build()), parseAll(makeParser(arith)));
	check('a truncated file was replaced', fs.readFileSync(cachePath).length > 5, true);

	// A complete file with one byte appended.
	fs.writeFileSync(cachePath, Buffer.concat([fs.readFileSync(cachePath), Buffer.from([0])]));
	markFile();	check('trailing junk parses', parseAll(build()), parseAll(makeParser(arith)));
	check('trailing junk is a miss', rewritten(), true);

	fs.writeFileSync(cachePath, 'not a cache at all');
	check('a foreign file parses', build().parse(EXPRS[0]), makeParser(arith).parse(EXPRS[0]));
	check('a foreign file was replaced', fs.readFileSync(cachePath).subarray(0, 4).toString('latin1'), 'TSLR');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall table cache tests passed');
