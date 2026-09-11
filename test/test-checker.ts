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

	['a declared generator types yield',	'function* g(): Generator<number, string, boolean> { const v = yield 1; const w: number = v; yield "x"; return 1; }', [NOT_ASSIGNABLE('boolean', 'number'), `Type '"x"' is not assignable to the yielded type 'number'`, "Type '1' is not assignable to declared return type 'string'"]],
	['a declared return is never replaced', 'function f(): any { return 1; } const q: string = f();',								[]],

	// unannotated class members infer their return types at every use
	['method and getter returns',	'class B { m() { return 1; } get g() { return "s"; } } const x: string = new B().m(); const y: number = new B().g;', [NOT_ASSIGNABLE('number', 'string'), NOT_ASSIGNABLE('string', 'number')]],
	['static member returns its class', 'class A { static self = A; static make() { return A; } static me() { return this; } } const q: number = A.make();', [NOT_ASSIGNABLE('typeof A', 'number')]],

	// strictNullChecks off: null/undefined belong to every type, and inferred null/undefined widen to `any`
	['non-strict null is in every type', 'let x = null; x = 5; function f() { return null; } const s: string = f(); declare const o: { a?: number } | undefined; const n: number = o.a;', [], true],
	['non-strict: missing property still errs', 'type A = { a: string }; const x: A = 42;', ["Type 'number' is not assignable to type 'A'"], true],
	['a missing required property errs',	'const z: { a: string | undefined } = {};',												["Type '{}' is not assignable to type '{"]],

	// generic inference: candidates by polarity, TS's common supertype, parameters fixed as callbacks are typed
	['common supertype of candidates',	'function f<T>(y: T, x: T): T { return y; } interface A { a: number } interface B extends A { b: number } declare const a: A, b: B; const r: string = f(b, a);', ["a: number\n}' is not assignable to type 'string'"]],
	['literal candidates union',		'enum E { A, B, C } interface I<T extends E> { type: T } declare function foo<T extends E>(x: I<T>): T; declare const x: I<E.A | E.B> | I<E.C>; const r: string = foo(x);', ["is not assignable to type 'string'"]],
	['contravariant candidates',		'declare function f1<T>(a: (x: T) => void, b: (x: T) => void): T; declare function fo(x: Object): void; declare function fs(x: string): void; const r: number = f1(fo, fs);', [NOT_ASSIGNABLE('string', 'number')]],
	['callback context fixes',			'declare function f<T, U>(t: T, u: U, a: (u: U) => T, b: (t: T) => U): [T, U]; interface A { a: A } interface B extends A { b: any } declare const a: A, b: B; const d = f(a, b, u => u.b, t => t);', []],

	['superclass type arguments',		'declare class Base<P> { readonly props: Readonly<P>; } interface CP { ref?: () => void; } class X extends Base<CP> { m() { const a: number = this.props.ref; } }', ["is not assignable to type 'number'"]],
	['numeric index answers numbers only', 'declare const s: String; const p = s.push;',												["Property 'push' does not exist"]],

	// equality narrows by any unit-typed operand, and enum members are types
	['enum member discriminant',		'enum Kind { A, B } interface Base { kind: Kind } interface A extends Base { kind: Kind.A; yar: number } interface B extends Base { kind: Kind.B; gar: number } declare const foo: A | B; switch (foo.kind) { case Kind.A: const myA: A = foo; break; case Kind.B: const myB: B = foo; }', []],
	['const-named unit narrows',		'declare const x: "a" | "b"; const k = "a"; if (x === k) { const q: "a" = x; }',		[]],
	['compared path narrows itself',	'enum E { A = 1, B = 2 } declare function never(v: never): never; function f(v: Partial<{ t: E.A } | { t: E.B }>) { if (v.t !== undefined) switch (v.t) { case E.A: break; case E.B: break; default: never(v.t); } }', []],
	['exhaustive switch narrows after',	'declare function assertNever(x: never): never; function f(x: 1 | 2) { switch (x) { case 1: return "a"; case 2: return "b"; } return assertNever(x); }', []],
	['switch that breaks does not',		'declare function assertNever(x: never): never; function f(x: 1 | 2) { switch (x) { case 1: break; case 2: return "b"; } return assertNever(x); }', ["Argument of type '1 | 2' is not assignable to parameter 'x: never'"]],
	['string enum members are strings', 'enum C { Y = "yes", N = "no" } function f(a: C.Y, b: C.Y | C.N) { const s: string = a + b; }', []],
	['const reads its initializer',		'declare enum E { ONE, TWO, THREE = "x" } const e: E = E.ONE; const x: E.ONE = e;',		[]],
	['typeof narrows object and aliases', 'type Basic = number | object | Function; declare function n(x: number): void; declare function fn(x: Function): void; function f(x: Basic) { switch (typeof x) { case "number": n(x); return; case "function": fn(x); return; } }', []],
	['typeof exclusions apply together', 'declare function assertNever(x: never): never; function f(x: number | object) { switch (typeof x) { case "number": return; case `function`: return; case "object": return; } assertNever(x); }', []],
	['a repeated case is unreachable',	'declare function assertNever(x: never): never; function f(x: string | number) { switch (typeof x) { case "string": return 1; case "number": return 2; case "number": return assertNever(x); } }', []],
	['discriminant values split',		'enum K { A = 1, B = 2 } type T = { kind: K.A, id?: number } | ({ kind: K.B } & ({ id?: undefined } | { id: number })); declare function take(t: T): void; function f(kind: K, id?: number) { take({ kind, id }); }', []],
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
