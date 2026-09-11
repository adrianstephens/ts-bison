// Checker precision and soundness cases, against lib.esnext.full as the corpus uses. Each case lists the ERRORs it
// must produce (a substring each, in order) -- `[]` means it must be clean. A deliberately wrong annotation is how a
// case proves the checker computed the precise type rather than `any`, which would pass silently.
import * as path from 'path';
import * as TS from '../src/examples/TS/ts-parser';
import * as T from '../src/examples/TS/type-utils';
import { checkBlock, SEVERITY } from '../src/examples/TS/checker';
import { TStypeCheckAsync } from '../src/examples/TS/transform';
import { ModuleLoader } from '../src/examples/TS/module-loader';

const NOT_ASSIGNABLE = (from: string, to: string) => `Type '${from}' is not assignable to type '${to}'`;

// `nonStrict`: checked with `strictNullChecks` off (tsc's default; the corpus's unless a test says `@strict`).
const cases: [name: string, code: string, errors: string[], nonStrict?: true][] = [
	// iteration protocol: every consumer reads `[Symbol.iterator]().next()`
	['for-of over Map.keys()',		'for (const x of new Map([[1, "a"]]).keys()) { const q: string = x; }',					[NOT_ASSIGNABLE('number', 'string')]],
	['for-of destructures entries',	'for (const [k, v] of new Map([[1, "a"]])) { const q: boolean = k; }',					[NOT_ASSIGNABLE('number', 'boolean')]],
	['for-of over a string',		'for (const c of "abc") { const q: number = c; }',										[NOT_ASSIGNABLE('string', 'number')]],
	['spread of a Set',				'const s = [...new Set([1, 2])]; const q: string = s[0];',								[NOT_ASSIGNABLE('number', 'string')]],
	['destructuring a Set',			'const [a] = new Set([1, 2]); const q: string = a;',									[NOT_ASSIGNABLE('number', 'string')]],
	['Map inference via Iterable',	'const m = new Map([["a", 1]]); const q: boolean = m.get("a");',						[NOT_ASSIGNABLE('number | undefined', 'boolean')]],
	['yield* delegates',			'function* g() { yield* new Set([1]); } for (const x of g()) { const q: string = x; }',	[NOT_ASSIGNABLE('number', 'string')]],
	['yield* evaluates to TReturn',	'function* g(): Generator<number, string> { return "x"; } function* h() { const r = yield* g(); const q: number = r; }', [NOT_ASSIGNABLE('string', 'number')]],
	['for await over async gen',	'async function* ag() { yield 1; } async function f() { for await (const x of ag()) { const q: string = x; } }', [NOT_ASSIGNABLE('number', 'string')]],
	['yield* in an async generator', 'async function* a(): AsyncGenerator<number> { yield* b(); } async function* b() { yield 1; }', []],
	['user-defined iterator class',	'class It { next() { return { value: 1, done: false }; } [Symbol.iterator]() { return this; } } for (const v of new It) { const q: string = v; }', [NOT_ASSIGNABLE('number', 'string')]],
	['computed method in a literal', 'function* g(): IterableIterator<(x: string) => number> { yield* { *[Symbol.iterator]() { yield (x: string) => x.length; } }; }', []],

	// unannotated class members infer their return types at every use
	['method and getter returns',	'class B { m() { return 1; } get g() { return "s"; } } const x: string = new B().m(); const y: number = new B().g;', [NOT_ASSIGNABLE('number', 'string'), NOT_ASSIGNABLE('string', 'number')]],
	['static member returns its class', 'class A { static self = A; static make() { return A; } static me() { return this; } } const q: number = A.make();', [NOT_ASSIGNABLE('typeof A', 'number')]],

	// strictNullChecks off: null/undefined belong to every type, and inferred null/undefined widen to `any`
	['non-strict null is in every type', 'let x = null; x = 5; function f() { return null; } const s: string = f(); declare const o: { a?: number } | undefined; const n: number = o.a;', [], true],
	['non-strict: missing property still errs', 'type A = { a: string }; const x: A = 42;', ["Type 'number' is not assignable to type 'A'"], true],
	['a missing required property errs',	'const z: { a: string | undefined } = {};',												["Type '{}' is not assignable to type '{"]],

];

(async () => {
	const global	= T.makeGlobal();
	const lib		= await new ModuleLoader(path.join(__dirname, '../test'), {}).get('typescript/lib/lib.esnext.full', '.');
	checkBlock(lib!.program.body, global);
	const parser	= TS.make();
	let failures = 0;
	for (const [name, code, expected, nonStrict] of cases) {
		global.nullChecks = !nonStrict;
		const diags		= await TStypeCheckAsync(parser.parse(code), new ModuleLoader(__dirname, {}), global);
		const errors	= diags.filter(d => d.severity === SEVERITY.ERROR).map(d => String(d.message));
		const ok		= errors.length === expected.length && expected.every((e, i) => errors[i].includes(e));
		if (!ok) {
			++failures;
			console.error(`FAIL - ${name}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(errors)}`);
		} else {
			console.log(`ok - ${name}`);
		}
	}
	console.log(failures ? `${failures} checker test(s) failed` : 'all checker tests passed');
	process.exitCode = failures ? 1 : 0;
})();
