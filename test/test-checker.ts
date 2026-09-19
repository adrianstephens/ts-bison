// Checker precision and soundness cases, against lib.esnext.full as the corpus uses. Each case lists the ERRORs it
// must produce (a substring each, in order) -- `[]` means it must be clean. A deliberately wrong annotation is how a
// case proves the checker computed the precise type rather than `any`, which would pass silently.
import * as path from 'path';
import * as TS from '../dist/examples/TS/ts-parser';
import * as T from '../dist/examples/TS/type-utils';
import { checkBlock, SEVERITY } from '../dist/examples/TS/checker';
import { TStypeCheckAsync } from '../dist/examples/TS/transform';
import { ModuleLoader } from '../dist/examples/TS/module-loader';

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
	['overload trial, final context', 'declare function mk<K, V>(entries: readonly (readonly [K, V])[]): Map<K, V>; declare function mk<K, V>(other: Map<K, V>): Map<K, V>; const m = mk([1, 2].map(x => [String(x), x])); const q: boolean = m.get("1");', [NOT_ASSIGNABLE('number | undefined', 'boolean')]],
	['yield* delegates',			'function* g() { yield* new Set([1]); } for (const x of g()) { const q: string = x; }',	[NOT_ASSIGNABLE('number', 'string')]],
	['yield* evaluates to TReturn',	'function* g(): Generator<number, string> { return "x"; } function* h() { const r = yield* g(); const q: number = r; }', [NOT_ASSIGNABLE('string', 'number')]],
	['for await over async gen',	'async function* ag() { yield 1; } async function f() { for await (const x of ag()) { const q: string = x; } }', [NOT_ASSIGNABLE('number', 'string')]],
	['yield* in an async generator', 'async function* a(): AsyncGenerator<number> { yield* b(); } async function* b() { yield 1; }', []],
	['user-defined iterator class',	'class It { next() { return { value: 1, done: false }; } [Symbol.iterator]() { return this; } } for (const v of new It) { const q: string = v; }', [NOT_ASSIGNABLE('number', 'string')]],
	['mixin constructor intersection', 'declare class M { constructor(...args: any[]); p: number } declare class C { constructor(s: string); a: number } declare const X: typeof M & typeof C; const x = new X("a"); const q: string = x.p; const r: string = x.a;', [NOT_ASSIGNABLE('number', 'string'), NOT_ASSIGNABLE('number', 'string')]],
	['construct signature merged onto a class', 'interface D { x: number } class C { m() {} } interface C { new (): D } declare const y: C; const z = new y(); const q: string = z.x;', [NOT_ASSIGNABLE('number', 'string')]],
	['template literal key',			'const o = { ab: 1 }; const q: string = o[`ab`];',												[NOT_ASSIGNABLE('number', 'string')]],
	['template literal `in`',			'declare const o: { test: string } | {}; if (`test` in o) { const q: number = o.test; }',		[NOT_ASSIGNABLE('string', 'number')]],
	['iterator through this["entries"]', 'class M { *entries(): Generator<[string, number], void> { yield ["a", 1]; } declare [Symbol.iterator]: this["entries"]; } for (const [k, v] of new M) { const q: string = v; }', [NOT_ASSIGNABLE('number', 'string')]],
	['computed method in a literal','function* g(): IterableIterator<(x: string) => number> { yield* { *[Symbol.iterator]() { yield (x: string) => x.length; } }; }', []],

	['a declared generator types yield',	'function* g(): Generator<number, string, boolean> { const v = yield 1; const w: number = v; yield "x"; return 1; }', [NOT_ASSIGNABLE('boolean', 'number'), `Type '"x"' is not assignable to the yielded type 'number'`, "Type '1' is not assignable to declared return type 'string'"]],
	['a declared return is never replaced', 'function f(): any { return 1; } const q: string = f();',								[]],

	// unannotated class members infer their return types at every use
	['method and getter returns',	'class B { m() { return 1; } get g() { return "s"; } } const x: string = new B().m(); const y: number = new B().g;', [NOT_ASSIGNABLE('number', 'string'), NOT_ASSIGNABLE('string', 'number')]],
	['static accessors see the constructor', 'class A { static #n: number; static get g(): string { return this.#n; } static set s(v: number) { const q: string = this.#n; } }', ["is not assignable to declared return type 'string'", NOT_ASSIGNABLE('number', 'string')]],
	['fluent this',					'class A { foo() { return this; } } class B extends A { bar() { return this; } } declare const b: B; const q: number = b.foo().bar();', ["Type 'B' is not assignable to type 'number'"]],
	['a guard drops a nullish member', 'class A { a = 1 } class B { b = 2 } declare const x: A | B | undefined; if (x instanceof A) { const q: number = x; }', [NOT_ASSIGNABLE('A', 'number')]],
	['a guard keeps a narrower type', 'class A { a = 1; } class C extends A { c = ""; } declare function isA(x: any): x is A; declare const s: C; if (isA(s)) { const q: number = s.c; }', [NOT_ASSIGNABLE('string', 'number')]],
	['a guard keeps narrower members', 'class A { a = 1; } class B { b = 1; } class C extends A { c = ""; } declare function isA(x: any): x is A; declare const u: C | B; if (isA(u)) { const q: number = u.c; }', [NOT_ASSIGNABLE('string', 'number')]],
	['a nested function has its own this', 'class Foo { x: number; bar() { function inner() { const q: string = this.x; } const g = function () { const r: string = this.x; }; } }', []],
	['an annotated sibling parameter infers', 'class C { test: string } class D extends C { test2: number } declare function test<T extends C>(a: (t: T, t1: T) => void): T; test((t1: D, t2) => { const q: string = t2.test2; });', [NOT_ASSIGNABLE('number', 'string')]],
	['super reaches a generic base', 'declare class A<T> { constructor(x: T); m(): T; } class B extends A<string> { constructor() { super("s"); } n() { const q: number = super.m(); } }', [NOT_ASSIGNABLE('string', 'number')]],
	['super() fixes the base type args', 'class A<T> { constructor(x: T) {} } class B extends A<string> { constructor() { super(1); } }', ["Argument of type '1' is not assignable to parameter 'x: string'"]],
	['super reaches the base method', 'class A { m(): string { return ""; } } class B extends A { m(): number { return 1; } n() { const q: number = super.m(); } }', [NOT_ASSIGNABLE('string', 'number')]],
	['super.m() has the derived this', 'class A { self(): this { return this; } } class B extends A { b = 1; n() { const q: number = super.self(); } }', [NOT_ASSIGNABLE('this', 'number')]],
	['super() checks its arguments', 'class A { constructor(x: number) {} } class B extends A { constructor() { super("x"); } }', ["Argument of type '\"x\"' is not assignable to parameter 'x: number'"]],
	['super() accepts the base arguments', 'class A { constructor(x: number) {} } class B extends A { constructor() { super(1); } }', []],
	['static super reaches the base', 'class A { static s(): string { return ""; } } class B extends A { static t() { const q: number = super.s(); } }', [NOT_ASSIGNABLE('string', 'number')]],
	['static member returns its class', 'class A { static self = A; static make() { return A; } static me() { return this; } } const q: number = A.make();', [NOT_ASSIGNABLE('typeof A', 'number')]],

	// strictNullChecks off: null/undefined belong to every type, and inferred null/undefined widen to `any`
	['non-strict null is in every type', 'let x = null; x = 5; function f() { return null; } const s: string = f(); declare const o: { a?: number } | undefined; const n: number = o.a;', [], true],
	['non-strict: missing property still errs', 'type A = { a: string }; const x: A = 42;', ["Type 'number' is not assignable to type 'A'"], true],
	['a missing required property errs',	'const z: { a: string | undefined } = {};',												["Type '{}' is not assignable to type '{"]],

	// generic inference: candidates by polarity, TS's common supertype, parameters fixed as callbacks are typed
	['common supertype of candidates',	'function f<T>(y: T, x: T): T { return y; } interface A { a: number } interface B extends A { b: number } declare const a: A, b: B; const r: string = f(b, a);', [NOT_ASSIGNABLE('A', 'string')]],
	['literal candidates union',		'enum E { A, B, C } interface I<T extends E> { type: T } declare function foo<T extends E>(x: I<T>): T; declare const x: I<E.A | E.B> | I<E.C>; const r: string = foo(x);', ["is not assignable to type 'string'"]],
	['contravariant candidates',		'declare function f1<T>(a: (x: T) => void, b: (x: T) => void): T; declare function fo(x: Object): void; declare function fs(x: string): void; const r: number = f1(fo, fs);', [NOT_ASSIGNABLE('string', 'number')]],
	['instantiation expression rest',	'declare function g<T>(...args: ((x: T) => void)[]): T; const h = g<number>; h(x => { const s: string = x; });', [NOT_ASSIGNABLE('number', 'string')]],
	['callback context fixes',			'declare function f<T, U>(t: T, u: U, a: (u: U) => T, b: (t: T) => U): [T, U]; interface A { a: A } interface B extends A { b: any } declare const a: A, b: B; const d = f(a, b, u => u.b, t => t);', []],

	['superclass type arguments',		'declare class Base<P> { readonly props: Readonly<P>; } interface CP { ref?: () => void; } class X extends Base<CP> { m() { const a: number = this.props.ref; } }', ["is not assignable to type 'number'"]],
	['numeric index answers numbers only', 'declare const s: String; const p = s.push;',												["Property 'push' does not exist"]],

	// class references compare by their members; shadowing, tuple contexts and readonly are respected
	['unrelated classes',				'class A { a = 1; } class B { b = ""; } const x: A = new B();',							["Type 'B' is not assignable to type 'A'"]],
	['an array is not a number',		'const n: number = [1];',																["is not assignable to type 'number'"]],
	['a method type parameter shadows', 'class G<T> { foo<T>(t: T): T { return t; } } declare const g: G<string>; const r: number = g.foo(1);', []],
	['a union of tuples is a tuple context', "type TA = ['a', number]; type TB = ['b', string]; declare function f(c: TA | TB): void; f(['a', 5]); f(['b', 'x']);", []],
	['as const under a mutable context', 'const a = [1, 2] as const satisfies unknown[];',										[]],
	['readonly tuple into a mutable array', 'declare const r: readonly [number]; const m: number[] = r;',						["is not assignable to type 'number[]'"]],

	['a quoted type argument is opaque', "declare function g<A, B>(a: string): number; declare function h(x: number): void; h(g<number, '<'>('<')); const r: string = g<number, `>${'<'}`>('');", [NOT_ASSIGNABLE('number', 'string')]],
	['a tagged template is a call',	'declare function tag(s: TemplateStringsArray): number; declare function tag(s: TemplateStringsArray, n: number): string; const r: boolean = tag`x${1}`;', [NOT_ASSIGNABLE('string', 'boolean')]],
	['object literal candidates union', 'declare function f<T>(a: T, b: T): T; const r = f({ x: 1, z: 2 }, { x: 1, y: "" });',		[]],
	['primitive candidates do not',	'declare function f<T>(x: { bar: T; baz: T }): T; f({ bar: 1, baz: "" });',						["is not assignable to parameter"]],

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

	// an implementation signature is invisible to callers when overloads exist
	['overloads hide the implementation', 'class C { m(x: string): number; m(x: any) { return x; } } const r: string[] = ["a"].map(new C().m);', [NOT_ASSIGNABLE('number[]', 'string[]')]],
	['a truthy optional chain narrows its roots', 'declare const f: (() => boolean) | undefined, x: string[] | undefined; if (f?.()) { const g: () => boolean = f; } if (x?.[0]) { const n: string[] = x; }', []],
	['an exiting branch does not merge',	'declare const c: boolean; function f() { let y; if (c) y = "s"; else return; const q: number = y; }', [NOT_ASSIGNABLE('string', 'number')]],
	// overloads: a context-sensitive callback is untyped until a candidate fits, then fixed by it; the next is tried with it fixed
	['a callback fixed by the first fit',	'declare function foo(arg: (x: string) => string): string; declare function foo(arg: (x: string) => number): number; const r: boolean = foo(x => 1);', [NOT_ASSIGNABLE('number', 'boolean')]],
	['an alias is transparent to inference', 'type MP<T> = T | Promise<T>; declare function f<D>(m: (x: number) => MP<D>): D; const r = f(u => u as number | string); const q: boolean = r;', [NOT_ASSIGNABLE('number | string', 'boolean')]],
	['shared subtrees are walked once',		`declare function d<T>(x: T): { a: T; b: T }; declare function id<U>(u: U, f?: <V>(v: V) => V): U; const x = id(${'d('.repeat(40)}1${')'.repeat(40)}); const q: number = x.a.b;`, ["is not assignable to type 'number'"]],
	['an IIFE parameter with no argument is optional', '((a) => a)(); (({ x = 1 }) => x)(); (function (a, b: number) {})();', ['Expected 2 arguments, but got 0']],
	['any absorbs a union, unknown the rest', 'declare const a: unknown, b: string, c: any; const u = Math.random() > 0.5 ? a : b; const v = Math.random() > 0.5 ? b : c; const q: number = [u]; const p: number = [v];', ["Type 'unknown[]' is not assignable to type 'number'", "Type 'any[]' is not assignable to type 'number'"]],
	['a union of signatures is callable',	'declare const f: ((x: number) => string) | ((x: number) => number); const r: boolean = f(1); declare const g: ((a?: {x: number}, ...b: {x: number}[]) => void) | ((a?: {y: number}) => void); g({x: 0, y: 0}, {x: 0});', [NOT_ASSIGNABLE('string | number', 'boolean')]],
	['an any callee still checks its arguments', 'declare const k: any; const r = new k(); const q: number = r; k(() => { const s: string = 1; });', [NOT_ASSIGNABLE('number', 'string')]],
	['an assignment narrows as its target',	'declare function next(): string | null; let s; while ((s = next()) !== null) { const n: string = s; } let t: string | null; if (typeof (t = next()) === "string") { const w: string = t; }', []],
	['names never reach Object.prototype',	'declare const v: constructor; const n = v.solutionRead; declare const w: toString | number; const m = w.valueOf;', []],
	['a function type inside call type arguments', 'declare function g<T>(x?: T): T; const r: number = g<() => string>();', [NOT_ASSIGNABLE('() => string', 'number')]],
	['null stands aside for the supertype',	'declare function g<T>(a: T, b: T): T; const s: boolean = g(1, null); declare function f<U>(x: U[]): U; declare const b: boolean; const r = f(b ? [1] : [undefined]); const q: boolean = r;', [NOT_ASSIGNABLE('number | null', 'boolean'), NOT_ASSIGNABLE('number | undefined', 'boolean')]],
	['a compared path narrows from its precise type', 'declare const m: { type: "method" | "get" | "set" }; declare function acc(k: "get" | "set"): void; if (m.type === "get") acc(m.type); if (m.type === "get" || m.type === "set") acc(m.type);', []],
	['as const reaches every property',		'const b = { type: "v", a: [1, "x"] } as const; const q: { type: "w"; a: readonly [1, "x"] } = b; declare const d: { name: string }; const c = [d].map(x => ({ type: "v", ...x } as const)); const r: "v" = c[0].type;', ["Type '{\n  type: \"v\";"]],
	['a const is bound inside its own initializer', 'declare function pure(a: any, b: string, c: number): void; function f() { const pure = (x: number): boolean => x > 0 && pure(x - 1); const s: (n: number) => string = n => n ? s(n - 1) : ""; const q: number = s(2); }', [NOT_ASSIGNABLE('string', 'number')]],
	['as const takes mutability from its context', 'declare function fg<T>(more?: Partial<{ m: string[]; t: T }>): void; fg({ m: ["a"] } as const); const m: { args: number[] } = { args: [] } as const; declare const c: boolean; const o = { e: c ? [1] : [2] } as const; const e: number[] = o.e; declare function R<const T extends readonly unknown[]>(x: T): T; const s: boolean = R([1, "a"]);', [NOT_ASSIGNABLE('readonly [1, "a"]', 'boolean')]],
	['an overload trial types an argument in its candidate\'s context', 'type Rl<T> = { t: T }; declare function Rule<T, const R extends readonly unknown[]>(rhs: R, action: (v: R) => T): Rl<T>; type K = { key: string; modifiers?: string[] }; interface L<T> { push(item: T): number; push(...items: T[]): number } declare const list: L<Rl<K>>; list.push(Rule(["a"] as const, $ => ({ key: "x", modifiers: ["optional"] } as const)));', []],
	['a literal excludes what it cannot be',	'type V = "i32" | "f64" | "ref"; interface P { tp: string } declare const l: { type: V | P }; declare function temp(w: "i32" | "f64"): void; if (l.type === "i32" || l.type === "f64") temp(l.type);', []],
	['a union of tuples destructures by member', 'declare const u: readonly ["a", number] | readonly ["b", string]; const [k, v] = u; declare function ab(x: "a" | "b"): void; ab(k); declare function onlyA(x: "a"): void; onlyA(k); const r: boolean = v; for (const [a] of [["f64", 1], ["ref", "x"]] as const) { const z: boolean = a; }', ["Argument of type '\"a\" | \"b\"' is not assignable", NOT_ASSIGNABLE('number | string', 'boolean'), NOT_ASSIGNABLE('"f64" | "ref"', 'boolean')]],
	['a thrown end adds no undefined',		'const f = (b: boolean) => { if (b) return 1; throw new Error(); }; const q: string = f(true); function h(b: boolean) { if (b) return 1; } const t: string = h(true);', [NOT_ASSIGNABLE('number', 'string'), NOT_ASSIGNABLE('number | undefined', 'string')]],
	['an instantiated intersection reduces',	'declare function f<T, U>(a: T, b: U): { v: T & U }; const s = f<unknown, string>(1, ""); const q: boolean = s.v; const t = f<any, string>(1, ""); const r: boolean = t.v;', [NOT_ASSIGNABLE('string', 'boolean')]],
	['a class instance is never falsy',		'class Sc { a = 1 } declare const s: Sc | undefined; const m = s && "x"; const q: boolean = m;', [NOT_ASSIGNABLE('undefined | string', 'boolean')]],
	['an optional chain equal to a value narrows its roots', 'interface D { type: string } interface N { decl(k: string): D | undefined } declare const h: N | undefined; if (h?.decl("a")?.type === "c") { const n: N = h; } if (h?.decl("a")?.type !== "c") { const m: N = h; }', [NOT_ASSIGNABLE('N | undefined', 'N')]],
	['a literal index path narrows its reads',	'declare const args: [{ a: 1 }] | [number[]]; if (Array.isArray(args[0])) { const q: number[] = args[0]; }', []],
	['null is not an array',					'const c: number[] = null;', [NOT_ASSIGNABLE('null', 'number[]')]],
	["an array guard's false branch keeps null",	'declare const v: number | null | RegExp | string[]; if (!Array.isArray(v) && typeof v === "object") { const q: RegExp = v; }', [NOT_ASSIGNABLE('null | RegExp', 'RegExp')]],
	['a spread of an interface that extends another keeps its shape',	'interface B { b: number } interface D extends B { d: number } declare const d: D; const o = { ...d, e: 1 }; const q: string = o.b;', [NOT_ASSIGNABLE('number', 'string')]],
	['an assignment target is its declared type', 'let x: { o: boolean } = { o: false }; if (x["o"] === false) { x["o"] = true; } const y: [number, number] = [0, 0]; if (y[0] === 0) { y[0] = -1; }', []],
	// literal freshness: only a literal written as an expression widens (TS's fresh vs regular literal types)
	['a declared literal stays literal',	'declare const c: "this"; const a = [c]; const q: boolean = a; declare const k: { kind: "a" | "b" }; let s = k.kind; s = "c";', [NOT_ASSIGNABLE('"this"[]', 'boolean'), "Type '\"c\"' is not assignable to type '\"a\" | \"b\"'"]],
	['a fresh literal widens in either union order', 'declare function t(): "void" | "x" | undefined; let r1 = Math.random() ? t() : "void"; const q1: boolean = r1; let r2 = Math.random() ? "void" : t(); const q2: boolean = r2; const e = ""; let z = e; z = "other";', [NOT_ASSIGNABLE('string | undefined', 'boolean'), NOT_ASSIGNABLE('string | undefined', 'boolean')]],
	['a disjunction infers a type predicate', 'type U = { type: "this" } | { type: "fn"; x: 1 } | { type: "ctor"; x: 2 }; declare function take(s: { x: 1 | 2 }): void; declare const xs: U[]; const f = xs.find(p => p.type === "fn" || p.type === "ctor"); if (f) take(f); const g = xs.filter(p => p.type === "fn" || p.type === "ctor"); take(g[0]);', []],
	['inference picks a supertype by the real relation', 'declare function f3<T>(obj: T, f2: (f: (x: T) => void) => void): T; declare function fx(f: (x: "def") => void): void; const x3 = f3("abc", fx); const q: boolean = x3;', [NOT_ASSIGNABLE('string', 'boolean')]],
	// TS's control-flow containers: a function declaration or class declaration member sees declared types; closures and class expressions carry narrowings
	['a function declaration starts from declared types', 'interface R { ref: string } type W = "a" | R; const C: W = { ref: "x" }; function fd() { const a: R = C; } const fe = function () { const b: R = C; }; const ar = () => { const c: R = C; };', [NOT_ASSIGNABLE('"a" | R', 'R')]],
	['a class declaration\'s members start from declared types', 'interface R { ref: string } type W = "a" | R; const C: W = { ref: "x" }; class CD { p = (() => { const a: R = C; })(); } const CE = class { m() { const b: R = C; } };', [NOT_ASSIGNABLE('"a" | R', 'R')]],
	['a narrowed parameter does not reach a nested function declaration', 'function outer(q: string | undefined) { if (q) { function f7() { const s: string = q; } const a6 = () => { const t: string = q; }; } }', [NOT_ASSIGNABLE('string | undefined', 'string')]],
	// TS's intersection normalization (getIntersectionType) -- see `reduceIntersection`
	['NonNullable of a union narrows like the union', 'type G = { type: "a"; x: 1 } | { type: "b"; y: 2 }; declare function takeA(a: { x: 1 }): void; declare function takeB(b: { y: 2 }): void; declare const n: NonNullable<G | undefined>; if (n.type === "a") takeA(n); else takeB(n); const g: G = n;', []],
	['an intersection of type parameters relates by its constraint', 'type A = 1 | 2; type B = 2 | 3; function f2<T extends A, U extends B>(ab: T & U): (A | B) & T & U { return ab; }', []],
	['a function satisfies an interface extending Function', 'interface IResultCallback extends Function {} declare function fn(cb: IResultCallback): void; fn((a: number, b: number) => true);', []],
	['a phantom parameter infers nothing from its intersection with never', 'type AT<P> = string & { hack?: P & never }; type H<S, P> = P extends void ? (s: S) => S : (s: S, p: P) => S; declare function h<S, P>(a: AT<P>, handler: H<S, P>): void; declare const act: AT<number>; h<{ d: string }, number>(act, (state, _p) => state);', []],
	['a deferred conditional part is not dropped as unknown', 'type Foo<K> = K extends unknown ? { a: number } : unknown; const mk = <K,>(x: K): Foo<K> & { x: K } => { return { a: 1, x: x }; };', []],
	['an optional property\'s indexed access includes undefined', 'interface K { a: boolean } class S { kind?: K; parent?: S; enclosing(): S["kind"] { return this.kind ?? this.parent?.enclosing(); } } declare const s: S["kind"]; const q: boolean = s;', [NOT_ASSIGNABLE('K | undefined', 'boolean')]],
	['a construct-only value is not callable without new', 'class C { x = 1 } C(); interface CtorOnly { new (): C } declare const co: CtorOnly; co(); declare function f(): void; new f();', ["is not callable without 'new'", "is not callable without 'new'"]],
	['reduce with and without a seed',		'const r: string = [1, 2].reduce((a, v) => a + v, ""); const s: boolean = [1, 2].reduce((a, v) => a + v);', [NOT_ASSIGNABLE('number', 'boolean')]],
	['functions have Function members',		'function f(a: number) {} f.call(null, 1); const n: string = f.length;',					[NOT_ASSIGNABLE('number', 'string')]],
	['an expando assignment declares, not narrows', 'const E = function () {}; E.prop = { x: 2 }; E.prop = { y: "" }; const n = E.prop.x || 0;', []],
	// TS narrows a discriminant compared with a value typed as a union of literals, on the matching branch only.
	['a discriminant compared with a literal-union value narrows', 'type A = { type: "a"; x: 1 } | { type: "b"; y: 2 } | { type: "c"; z: 3 }; function f(m: A, k: "a" | "b") { if (m.type === k) { const n: { type: "a"; x: 1 } | { type: "b"; y: 2 } = m; } }', []],
	['a literal-union comparand does not narrow the other branch', 'type A = { type: "a"; x: 1 } | { type: "b"; y: 2 } | { type: "c"; z: 3 }; function f(m: A, k: "a" | "b") { if (m.type !== k) { const o: { type: "c"; z: 3 } = m; } }', ['is not assignable']],
	// A guard's false branch drops only members ASSIGNABLE to the guarded type: `R` (its `T` defaulted to `string`) is not an
	// `R<'never'>`, so it stays. Dropping it narrowed `src.type === 'ref'` to `never` (type-utils.ts `isAssignable`'s `recurse`).
	['a guard with a narrower type argument keeps a defaulted member', 'interface R<T extends string = string> { type: "ref"; name: T } interface L { type: "lit" } type Ty = R | L; declare function isRef<T extends string>(t: Ty, name: T): t is R<T>; function f(src: Ty) { if (isRef(src, "never")) return; const l: L = src; }', ['is not assignable']],
	['a primitive-constrained type parameter infers the literal', 'declare function lit<T extends string>(x: T): T; const a: "a" = lit("a");', []],
	// TS 5.5 infers a type predicate only when the function is true exactly when the parameter has that type. `isTop` is false for
	// most `R`s, so its false branch must not exclude `R` (type-utils.ts `isAny`, which left `src.type === 'ref'` as `never`).
	['an inferred predicate needs its false branch to be exact', 'interface R { type: "ref"; name: string } interface L { type: "lit" } type Ty = R | L; function isTop(t: Ty) { return t.type === "ref" && t.name === "any"; } function f(src: Ty) { if (isTop(src)) return; const l: L = src; }', ['is not assignable']],
	// TS's arity rule: a source needing more arguments than the target passes is not assignable (towasm's `staticGuard` folded
	// `has0args(f2)` to true on it). Optional, defaulted and trailing `void` parameters, and a rest target, are not needed.
	['a function needing more arguments than the target passes is not assignable', 'const f2 = (a: number, b: number) => a + b; const g: () => number = f2;', ['is not assignable']],
	['optional, defaulted, void and rest parameters are not needed arguments', 'const f = (a: number, b?: number, c = 1) => a; const g: (a: number) => number = f; const h: (...xs: number[]) => number = (a: number, b: number) => a; declare const r: (v: void) => void; const p: () => void = r;', []],
	// TS's read of a tuple position: an optional element, or a union member too short for it, reads `undefined` too (towasm's
	// bounds-checked read relies on it); a position a rest spread covers reads the spread's element, with no error.
	['a union of tuples read past a shorter member is possibly undefined', 'function f(...args: [number] | [number, number]) { const q: number = args[1]; }', ['is not assignable']],
	['an optional tuple element reads as possibly undefined', 'function g(t: [number, string?]) { const r: string = t[1]; }', ['is not assignable']],
	['a rest tuple position reads its element type', 'function h(t: [number, ...string[]]) { const s: string = t[3]; const n: number = t[0]; }', []],
	// TS's `T[number]`: a computed index reads any position, an optional one contributing `undefined` too.
	['a tuple indexed by a computed number reads any position', 'declare const i: number; const t = [1, "a"] as const; const q: boolean = t[i];', ['is not assignable']],
	['a tuple indexed by a computed number includes an optional position', 'declare function f(t: [number, string?], i: number): void; const g = (t: [number, string?], i: number) => { const q: number = t[i]; };', ['is not assignable']],
	// TS narrows at an assignment wherever it sits, so a branch that assigns inside a call argument still settles the type after it.
	['an assignment nested in a call argument narrows after the branch', 'interface B { v: number } declare const m: Map<string, B>; function f(k: string): B { let b = m.get(k); if (!b) { m.set(k, b = { v: 1 }); } return b; }', []],
	// TS instantiates a type parameter's default with the arguments already chosen, so one naming an earlier parameter resolves.
	['a type parameter default naming an earlier one is instantiated with it', 'interface C<E, A = E> { c: E; args: A[] } declare const x: C<number>; const q: boolean = x.args;', ['number[]']],
	// A generic argument infers through its base signature (TS's `getBaseSignature`), or its own bound `T` escapes into the result.
	// Arguments are typed in order, each against its parameter under what the arguments before it inferred -- or the explicit
	// type arguments -- so an inner generic call can infer from that context (walker.ts's `mapObject(t, { ps: mapArray(p => ...) })`).
	['an argument is typed against what the earlier arguments inferred', 'declare function mapArray<T>(map: (x: T) => T | undefined): (x: readonly T[]) => T[] | undefined; interface Pn { n: number } interface Q { ps: Pn[] } declare const q: Q; declare function withPlain<N>(node: N, fields: {[K in keyof N]?: (x: N[K]) => N[K] | undefined}): N; const b = withPlain(q, { ps: mapArray(p => p.nope) });', ["Property 'nope' does not exist"]],
	['an argument is typed against the explicit type arguments', 'declare function mapArray<T>(map: (x: T) => T | undefined): (x: readonly T[]) => T[] | undefined; interface Pn { n: number } interface Q { ps: Pn[] } declare const q: Q; declare function withPlain<N>(node: N, fields: {[K in keyof N]?: (x: N[K]) => N[K] | undefined}): N; const b = withPlain<Q>(q, { ps: mapArray(p => p.nope) });', ["Property 'nope' does not exist"]],
	// A guard narrows a union by TS's subtype relation, where `any` is below nothing but itself: `x is any[]` keeps `string[]`.
	['a guard to any[] keeps the union member that is an array', 'declare const v: number | string[]; if (Array.isArray(v)) { const q: number = v; }', [NOT_ASSIGNABLE('string[]', 'number')]],
	// ...and the same relation picks inference's common supertype: an `any` candidate makes it `any`, not the other candidate.
	['an any candidate makes the inferred type any', 'declare function f<T>(a: T, b: T): T; declare const x: any; const q: string = f(x, 1);', []],
	// Callback parameters are bivariant, TS's weakest rule: a pair unrelated in both directions is still no fit.
	['callback parameters unrelated both ways do not fit', 'interface A { a: number } interface B { b: number } declare function srt(f: (x: A) => number): void; declare function byB(x: B): number; srt(byB);', ["Argument of type '(x: B) => number'"]],
	// A literal against a structural target boxes as its primitive does, so a literal-typed value is an `Object` as `string` is.
	['a literal-typed value satisfies Object', 'declare const s: "def"; const o: Object = s; declare function fo(x: Object): void; const d: (x: "def") => void = fo;', []],
	// TS's isAritySmaller: an overload whose callback takes fewer parameters than the literal requires gives it no context.
	['a too-short overload does not type a callback', 'interface O { (h1: (a: string) => void): void; (h2: (a: number, b: number) => void): void; } declare const use: O; use((req, res) => { const q: string = req; });', [NOT_ASSIGNABLE('number', 'string')]],
	// A written `undefined`, or a discriminant the literal leaves out, discriminates a union context as TS does.
	['an undefined or omitted discriminant picks the optional member', 'type DT = { disc: true; cb: (x: string) => void }; type DF = { disc?: false; cb: (x: number) => void }; declare function f(o: DT | DF): void; f({ disc: undefined, cb: n => { const q: string = n; } }); f({ cb: n => { const q: string = n; } });', [NOT_ASSIGNABLE('number', 'string'), NOT_ASSIGNABLE('number', 'string')]],
	// A property's truthiness narrows the union holding it (TS's discriminant rule): past `if (c.errors) return`, only the member
	// whose `errors` can be falsy is left, so `coerced` is no longer possibly undefined.
	['a property truthiness test narrows the union holding it', "interface E { e: number } type C = { errors: ReadonlyArray<E>; coerced?: never } | { coerced: { [v: string]: unknown }; errors?: never }; declare const c: C; function g(): { vv: { [v: string]: unknown } } | undefined { if (c.errors) return undefined; const k: number = c.coerced; return { vv: c.coerced }; }", ["unknown\n}' is not assignable to type 'number'"]],
	// A read off a union is each member's read: one member's optional property makes it possibly undefined.
	['an optional property read through a union includes undefined', "interface C { n: number; s?: string } interface D { m: string; s?: string } declare const u: C | D; const q: string = u.s;", [NOT_ASSIGNABLE('string | undefined', 'string')]],
	// A spread of a union distributes, as TS's getSpreadType does: the literal is one shape per member, not an unknowable `any`.
	['a spread of a union is the union of each spread', "interface A { type: 'a'; x: number } interface B { type: 'b'; y: string } declare const u: A | B; const r = { ...u, z: 1 }; const s: number = r;", ['z: number\n} | {']],
	// A mapped type's key binds only inside it: `Partial`'s own `[P in keyof T]` must not capture a caller's type named `P`.
	['a mapped type key does not capture a same-named type substituted into it', 'interface P { n: number } declare const a: Partial<{ ps: P[] }>; const q: string = a.ps;', ['ps: P[]']],
	// An uncontextual `[]` is `never[]`, which a union drops; an auto-typed declaration or assignment still evolves (`any[]`).
	['an empty array arm of a conditional takes the other arm', 'declare const c: boolean; declare const xs: { n: number }[]; const r = c ? xs : []; const q: string = r.map(x => x.n);', [NOT_ASSIGNABLE('number[]', 'string')]],
	['an empty array declaration or assignment evolves', 'let a = []; a.push(1); let b; (b = [], b).push(5);', []],
	['a destructuring default adds its own type', "let [x = 'a' in {}] = []; x = !x; const { y = 1 } = {} as { y?: string }; const q: boolean = y;", [NOT_ASSIGNABLE('string | number', 'boolean')]],
	// Stripping `undefined` keeps an aliased union by name, as TS does: expanded, it no longer matched the alias itself.
	['?? and ! keep an aliased union by name', "type U = { a: 1 } | { b: 2 }; declare const p: { c?: U }; declare function d(): U; const q: string = p.c ?? d(); declare const n: U | undefined; const r: string = n!;", [NOT_ASSIGNABLE('U', 'string'), NOT_ASSIGNABLE('U', 'string')]],
	// The rest parameter takes every argument past the fixed ones as ONE tuple, a spread as a spread element; neither was checked.
	['rest and spread arguments are checked', "function f(a: number, ...xs: number[]): number { return a; } declare const ys: string[]; f(1, 'x', 2); f(1, ...ys);", ["Arguments of type '[\"x\", 2]' are not assignable to rest parameter", "Arguments of type '[...string[]]' are not assignable to rest parameter"]],
	['fitting rest and spread arguments are clean', 'function f(a: number, ...xs: number[]): number { return a; } declare const ns: number[]; declare const t: [number, number]; f(1); f(1, 2, 3); f(1, ...ns); f(1, 2, ...t); const q: number[] = []; q.push(...ns, 4);', []],
	['an overload is chosen by its rest arguments too', 'declare const fa: number[]; const r: string = fa.concat(0);', [NOT_ASSIGNABLE('number[]', 'string')]],
	// `oneStepIndexed` stepped into tuples and arrays but not a named property, so `T[K] extends any[]` took the false branch (TS's genericRestParameters1).
	['a rest type conditional over an indexed access decides', "type Rec = { move: [number, 'left' | 'right']; stop: string; done: [] }; type Ev<T> = { emit<K extends keyof T = keyof T>(e: K, ...payload: T[K] extends any[] ? T[K] : [T[K]]): void }; declare var events: Ev<Rec>; events.emit('move', 10, 'left'); events.emit('done');", []],
	// Every block of a namespace is checked in the MERGED scope: re-hoisting a block into a fresh one hid what a later block adds.
	['a namespace block sees what later blocks merge in', 'declare namespace N { interface I { a: number } const make: { new(): I } } declare namespace N { interface I { b: string } } const x = new N.make(); const s: string = x.b; const n: string = x.a;', [NOT_ASSIGNABLE('number', 'string')]],
	['a namespace merged onto a function keeps its call', 'function f(): number { return 1; } namespace f { export const hello: number = 1; } const r: number = f(); const s: string = f.hello;', [NOT_ASSIGNABLE('number', 'string')]],
	// An annotation-only declaration keeps its ref, so an interface augmented after it is read whole (lib.es2020.intl's constructors).
	['a declaration typed by an interface sees its later augmentation', 'declare namespace N { interface C { new(a: string): number } const K: C } declare namespace N { interface C { new(a: number): string } } const r: boolean = new N.K(1);', [NOT_ASSIGNABLE('string', 'boolean')]],
	// TS's preferCovariantType: `U extends T` is inferred `C`, which the covariant `B` does not hold, so `T` is the callback's `A` (coAndContraVariantInferences2).
	['a covariant inference yields where a bounded parameter would not fit it', 'interface A { a: string } interface B extends A { b: string } interface C extends A { c: string } declare function isC(x: A): x is C; declare function pick<T, U extends T>(arr: readonly T[], f: (x: T) => x is U): T; declare const arr: readonly B[] | readonly C[]; const r: string = pick(arr, isC);', [NOT_ASSIGNABLE('A', 'string')]],
	// Rest arguments are inferred from as one tuple: against `[(self) => R<T>[]] | R<T>[]` (core.ts's `Rules`), the array member infers `T`.
	['a rest parameter of tuple-or-array type infers from its arguments', 'interface R<T> { a?: (x: number) => T } declare function rule<T>(action: (x: number) => T): R<T>; declare function rules<T>(...alts: [(self: () => R<T>[]) => R<T>[]] | R<T>[]): R<T>[]; const q: string = rules(rule(x => ({ p: 1 })), rule(x => ({ p: 2 })));', [NOT_ASSIGNABLE('R<{\n  p: number\n}>[]', 'string')]],
	// A resolution cut short by the depth limit answers `any` for THAT call; cached, every alias it passed through stayed `any`.
	['a type resolved past the depth limit is not cached as any', 'type A0 = A1; type A1 = A2; type A2 = A3; type A3 = A4; type A4 = A5; type A5 = A6; type A6 = A7; type A7 = A8; type A8 = A9; type A9 = A10; type A10 = A11; type A11 = A12; type A12 = { x: number }; const b: A0 = { x: 1 }; const q: A9 = { x: "s" };', ["is not assignable to type 'A9'"]],
	['a generic callback argument infers from its constraints','declare function total<T>(map: (x: T) => T | undefined): (x: T) => T; declare function id<T extends string>(t?: T): T | undefined; const q: boolean = total(id);', ['(x: string) => string']],
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
