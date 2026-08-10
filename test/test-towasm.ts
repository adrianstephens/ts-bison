import assert from 'assert';
import * as TS from '../examples/TS/ts-parser';
import { TStoWasm } from '../examples/TS/towasm';
import { TStypeCheck } from '../examples/TS/transform';
import { SEVERITY } from '../examples/TS/checker';

const parser = TS.make();

// TStoWasm assumes its input already passed TStypeCheck (same contract as TStoJS/TStoDecl) -- it does
// no error reporting of its own, so that gate belongs here, in the caller, not in the library.
//
// No WAT text, no wabt/binaryen: `TStoWasm` returns a `@isopodlabs/binary_libs` `wasm.WasmModule`
// directly, and that package's own `.toBytes()` is the assembler -- a first-party GC-capable writer
// (wabt's published build has GC compiled out entirely; binaryen works but is ~200x this project's
// own size for what's fundamentally a fixed, self-controlled instruction set -- see the write-up).
async function compile(src: string) {
	const program		= parser.parse(src);
	const diagnostics	= TStypeCheck(program);
	const errors		= diagnostics.filter(d => d.severity === SEVERITY.ERROR);
	if (errors.length)
		throw new Error('type errors:\n' + errors.map(d => `  ${d.pos.line}:${d.pos.col} - ${d.message}`).join('\n'));

	const mod		= TStoWasm(program);
	console.log(mod.toWAT({expandTypes: true, hexFloats: false}));
	const bytes		= mod.toBytes();
	// The real global `console` is always passed as the `console` import -- harmless when a program
	// doesn't call `console.log` at all (an unused import binding is simply ignored), and lets one that
	// does just work, since `TStoWasm` coerces each `console.log` overload to its own real wasm type itself.
	const instance	= new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), { console: console as unknown as WebAssembly.ModuleImports });
	return instance.exports as Record<string, (...args: number[]) => number>;
}

async function main() {
	let failures = 0;
	const check = (name: string, actual: unknown, expected: unknown) => {
		try {
			assert.strictEqual(actual, expected);
			console.log(`ok - ${name}`);
		} catch {
			++failures;
			console.error(`FAIL - ${name}: expected ${expected}, got ${actual}`);
		}
	};
	const checkThrows = async (name: string, fn: () => Promise<unknown>, pattern: RegExp) => {
		try {
			await fn();
			++failures;
			console.error(`FAIL - ${name}: expected a throw, got none`);
		} catch (e) {
			check(name, pattern.test((e as Error).message), true);
		}
	};
	// The `Math.*` transcendental functions are polynomial approximations, not exact -- a relative
	// tolerance well above their observed error (worst case ~2e-4, `Math.cos(0)`) but far below a real
	// regression (the pre-fix `Math.atan`/`Math.asin` were off by 5-9%) catches genuine breakage without
	// being flaky over exact float equality.
	const checkClose = (name: string, actual: number, expected: number, tol = 1e-3) => {
		if (Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected))) {
			console.log(`ok - ${name}`);
		} else {
			++failures;
			console.error(`FAIL - ${name}: expected ~${expected}, got ${actual}`);
		}
	};
	// A wasm export can't hand back a real JS string (it's a wasm-GC array reference) -- every string-
	// producing test below instead returns a "hash" (length plus a position-weighted sum of char codes)
	// computed *inside* wasm via this same helper, compared against computing the identical hash from real
	// JS's own string result (a collision would need two different strings to hash equal, which this
	// weighting makes essentially impossible for the short strings here).
	const jsHash = (s: string): number => {
		let h = s.length;
		for (let i = 0; i < s.length; i++)
			h += s.charCodeAt(i) * (i + 1);
		return h;
	};

	{
		const { test } = await compile(`
function test(): number {
	const x = new Uint8Array(100);
	const d = new DataView(x.buffer);
	return d.getFloat32(0, true);
}
		`);
		check('test', test(), 0);
	}

/*
	{
		const { strTemplate } = await compile(`
			function strTemplate(): number {
				const s: string = \`hello \${1+2} world\`;
				return s.length;
			}
		`);
		check('strTemplate', strTemplate(), 13);
	}
*/
	{
		const {alloc} = await compile(`
type i32 = number;
let heap: i32 = 0;
function alloc(size: i32): i32 {
	const ret  = heap;
	heap += size;

	// Grow by just enough whole pages (64KiB) to cover the new heap pointer, if it now exceeds the memory's current size.
	const mem = __asm<[], i32>('memory.size')();
	if (heap > (mem << 16)) {
		const extra = (heap - (mem << 16) + 65535) >> 16;
		__asm<[i32], i32>('memory.grow')(extra);
	}
	return ret;
}		`);
		check('alloc', alloc(10), 0);
	}
	{
		const { factorial } = await compile(`
			function factorial(n: number): number {
				let result: number = 1;
				while (n > 1) {
					result = result * n;
					n = n - 1;
				}
				return result;
			}
		`);
		check('factorial(0)', factorial(0), 1);
		check('factorial(1)', factorial(1), 1);
		check('factorial(5)', factorial(5), 120);
	}

	{
		const { fib } = await compile(`
			function fib(n: number): number {
				if (n <= 1)
					return n;
				return fib(n - 1) + fib(n - 2);
			}
		`);
		check('fib(0)', fib(0), 0);
		check('fib(1)', fib(1), 1);
		check('fib(10)', fib(10), 55);
	}

	{
		const { isEven } = await compile(`
			function isEven(n: number): boolean {
				return n === 0 ? true : !isEven(n - 1);
			}
		`);
		check('isEven(0)', isEven(0), 1);
		check('isEven(3)', isEven(3), 0);
		check('isEven(4)', isEven(4), 1);
	}

	{
		const { both, either } = await compile(`
			function both(a: boolean, b: boolean): boolean {
				return a && b;
			}
			function either(a: boolean, b: boolean): boolean {
				return a || b;
			}
		`);
		check('both(1,1)', both(1, 1), 1);
		check('both(1,0)', both(1, 0), 0);
		check('either(0,0)', either(0, 0), 0);
		check('either(0,1)', either(0, 1), 1);
	}

	{
		const { neg } = await compile(`
			function neg(x: number): number {
				return -x;
			}
		`);
		check('neg(5)', neg(5), -5);
	}

	{
		// `++`/`--`, prefix and postfix -- identifiers only (see towasm.ts's `emitIncDec`). Postfix must
		// yield the *old* value, prefix the *new* one; a bare `x++;`/`++x;` statement and a `for` loop's
		// update clause both exercise the same lowering as an ordinary sub-expression.
		const { postInc, preInc, postDec, loopSum, bareStmt } = await compile(`
			function postInc(): number {
				let x: number = 5;
				const y: number = x++;
				return y * 100 + x;
			}
			function preInc(): number {
				let x: number = 5;
				const y: number = ++x;
				return y * 100 + x;
			}
			function postDec(): number {
				let x: number = 5;
				const y: number = x--;
				return y * 100 + x;
			}
			function loopSum(n: number): number {
				let sum: number = 0;
				for (let i: number = 0; i < n; i++)
					sum = sum + i;
				return sum;
			}
			function bareStmt(): number {
				let x: number = 0;
				x++;
				x++;
				++x;
				return x;
			}
		`);
		check('postInc() (x++ yields old value)', postInc(), 506);
		check('preInc() (++x yields new value)', preInc(), 606);
		check('postDec() (x-- yields old value)', postDec(), 504);
		check('loopSum(5) (for-loop update clause)', loopSum(5), 10);
		check('bareStmt() (x++/++x as bare statements)', bareStmt(), 3);
	}

	{
		// wasm-GC: struct.new_default/struct.get/struct.set for fields, direct `call` for methods
		// (no inheritance -> no virtual dispatch needed), Math.sqrt as a closed intrinsic.
		const { area, distance, chain, sameRef, diffRef } = await compile(`
			class Point {
				x: number;
				y: number;
				constructor(x: number, y: number) {
					this.x = x;
					this.y = y;
				}
				distanceTo(other: Point): number {
					const dx = this.x - other.x;
					const dy = this.y - other.y;
					return Math.sqrt(dx * dx + dy * dy);
				}
				scale(factor: number): Point {
					return new Point(this.x * factor, this.y * factor);
				}
			}
			class Rect {
				w: number;
				h: number;
				constructor(w: number, h: number) {
					this.w = w;
					this.h = h;
				}
				area(): number {
					return this.w * this.h;
				}
			}
			function area(w: number, h: number): number {
				return new Rect(w, h).area();
			}
			function distance(): number {
				const p = new Point(0, 0);
				const q = new Point(3, 4);
				return p.distanceTo(q);
			}
			function chain(): number {
				const p = new Point(1, 1);
				return p.scale(3).distanceTo(new Point(0, 0));
			}
			function sameRef(): number {
				const p = new Point(1, 1);
				const q = p;
				return (p === q) ? 1 : 0;
			}
			function diffRef(): number {
				const p = new Point(1, 1);
				const q = new Point(1, 1);
				return (p !== q) ? 1 : 0;
			}
		`);
		check('area(3,4)', area(3, 4), 12);
		check('distance()', distance(), 5);
		check('chain()', chain(), Math.sqrt(18));
		check('sameRef() (class instance === is reference identity)', sameRef(), 1);
		check('diffRef() (class instance !== for two distinct instances)', diffRef(), 1);
	}

	{
		// An object-typed (class/array) field: `struct.new_default` has no zero value for a non-null ref,
		// so a class with such a field is built via the collect-then-`struct.new` path instead (see
		// `emitFieldCollectingCtorBody` in towasm.ts) -- real field values pushed straight into `struct.new`,
		// no zero-init step at all. Covers a class-typed field (cross-class dependency, forcing `Point`'s
		// own `struct` type to resolve before `Wrapper`'s), a plain local declared before any field is
		// assigned, and fields assigned out of declaration order.
		const { getX, getY, sameWrappedRef, diffWrappedRef, sumFirst, reordered } = await compile(`
			class Point {
				x: number; y: number;
				constructor(x: number, y: number) { this.x = x; this.y = y; }
			}
			class Wrapper {
				p: Point; tag: number;
				constructor(p: Point, tag: number) { this.p = p; this.tag = tag; }
			}
			function getX(): number {
				return new Wrapper(new Point(3, 4), 1).p.x;
			}
			function getY(): number {
				const w = new Wrapper(new Point(3, 4), 1);
				return w.p.y + w.tag;
			}
			function sameWrappedRef(): number {
				const p = new Point(1, 2);
				return (new Wrapper(p, 0).p === p) ? 1 : 0;
			}
			function diffWrappedRef(): number {
				const w = new Wrapper(new Point(1, 2), 0);
				return (w.p === new Point(1, 2)) ? 1 : 0;
			}
			class Holder {
				arr: number[]; n: number;
				constructor(a: number, b: number, c: number) {
					const total = a + b + c;
					this.arr = [a, b, c];
					this.n = total;
				}
			}
			function sumFirst(): number {
				const h = new Holder(10, 20, 30);
				return h.arr[0] + h.n;
			}
			class Pair {
				a: number; b: number;
				constructor(x: number, y: number) {
					this.b = y;
					this.a = x;
				}
			}
			function reordered(): number {
				const p = new Pair(5, 9);
				return p.a * 100 + p.b;
			}
		`);
		check('getX() (object-typed field read)', getX(), 3);
		check('getY() (object-typed field + number field)', getY(), 5);
		check('sameWrappedRef() (field holds the same ref passed in)', sameWrappedRef(), 1);
		check('diffWrappedRef() (field vs a distinct new instance)', diffWrappedRef(), 0);
		check('sumFirst() (array-typed field + plain-statement prefix)', sumFirst(), 70);
		check('reordered() (fields assigned out of declaration order)', reordered(), 509);
	}

	{
		// Array-literal spread (`[...a, b]`): can't use `array.new_fixed` (a spread source's length is
		// only known at runtime), so this goes through `array.new_default` + `array.copy`/`array.set`
		// instead (see `emitArrayElementsWithSpread` in towasm.ts). Covers a spread at each position, two
		// spreads in one literal, and that every element (plain or spread source) is evaluated exactly
		// once, in source order, even when it has a side effect.
		const { sumSpreadEnd, sumSpreadMiddle, sumTwoSpreads, lenSpreadEnd, order } = await compile(`
			function sumSpreadEnd(): number {
				const a: number[] = [1, 2, 3];
				const b: number[] = [0, ...a];
				let total: number = 0;
				for (let i: number = 0; i < b.length; i = i + 1)
					total = total + b[i];
				return total;
			}
			function sumSpreadMiddle(): number {
				const a: number[] = [2, 3];
				const b: number[] = [1, ...a, 4];
				let total: number = 0;
				for (let i: number = 0; i < b.length; i = i + 1)
					total = total + b[i];
				return total;
			}
			function sumTwoSpreads(): number {
				const a: number[] = [1, 2];
				const c: number[] = [3, 4];
				const b: number[] = [...a, 9, ...c];
				let total: number = 0;
				for (let i: number = 0; i < b.length; i = i + 1)
					total = total + b[i];
				return total;
			}
			function lenSpreadEnd(): number {
				const a: number[] = [1, 2, 3];
				const b: number[] = [0, ...a];
				return b.length;
			}
			function tap(log: number[], idx: number, n: number): number {
				log[idx] = n;
				return n;
			}
			function tapArr(log: number[], idx: number, tag: number): number[] {
				log[idx] = tag;
				return [tag * 10, tag * 10 + 1];
			}
			function order(): number {
				const log: number[] = [0, 0, 0];
				const b: number[] = [tap(log, 0, 1), ...tapArr(log, 1, 2), tap(log, 2, 3)];
				let total: number = 0;
				for (let i: number = 0; i < log.length; i = i + 1)
					total = total * 100 + log[i];
				return total * 1000 + b.length;
			}
		`);
		check('sumSpreadEnd() ([0, ...a])', sumSpreadEnd(), 6);
		check('sumSpreadMiddle() ([1, ...a, 4])', sumSpreadMiddle(), 10);
		check('sumTwoSpreads() ([...a, 9, ...c])', sumTwoSpreads(), 19);
		check('lenSpreadEnd() (spread contributes runtime length)', lenSpreadEnd(), 4);
		// side-effect order: tap logs 1, tapArr logs 2, tap logs 3 -> log = [1,2,3] -> 10203; b.length = 4
		check('order() (each element evaluated exactly once, in source order)', order(), 10203004);
	}

	await checkThrows('spreading a mismatched-kind array is rejected', () => compile(`
		function f(): number {
			const a: boolean[] = [true, false];
			const b: number[] = [1, ...(a as unknown as number[])];
			return b.length;
		}
	`), /towasm/);

	{
		// Array destructuring (var_decl + function params): plain positional binding, a hole, and a
		// destructured param.
		const { basic, withHole, viaParam } = await compile(`
			function basic(): number {
				const arr: number[] = [10, 20, 30];
				const [a, b, c] = arr;
				return a * 100 + b * 10 + c;
			}
			function withHole(): number {
				const arr: number[] = [1, 2, 3];
				const [, second] = arr;
				return second;
			}
			function pick([x, y]: number[]): number {
				return x * 10 + y;
			}
			function viaParam(): number {
				return pick([4, 5]);
			}
		`);
		check('basic() ([a, b, c] = arr)', basic(), 1230);
		check('withHole() ([, second] = arr)', withHole(), 2);
		check('viaParam() (destructured function param)', viaParam(), 45);
	}

	{
		// Object destructuring (var_decl + function params): plain binding, renaming, a destructured
		// class-typed param, and a pattern nested inside another pattern.
		const { basic, renamed, viaParam, nested, order } = await compile(`
			class Point {
				x: number; y: number;
				constructor(x: number, y: number) { this.x = x; this.y = y; }
			}
			function basic(): number {
				const p = new Point(3, 4);
				const { x, y } = p;
				return x * 10 + y;
			}
			function renamed(): number {
				const p = new Point(3, 4);
				const { x: px, y: py } = p;
				return px * 10 + py;
			}
			function dist({ x, y }: Point): number {
				return x * x + y * y;
			}
			function viaParam(): number {
				return dist(new Point(3, 4));
			}
			class Wrapper {
				p: Point; tag: number;
				constructor(p: Point, tag: number) { this.p = p; this.tag = tag; }
			}
			function nested(): number {
				const w = new Wrapper(new Point(7, 8), 9);
				const { p: { x, y }, tag } = w;
				return x * 100 + y * 10 + tag;
			}
			function make(log: number[]): Point {
				log[0] = log[0] + 1;
				return new Point(1, 2);
			}
			function order(): number {
				const log: number[] = [0];
				const { x, y } = make(log);
				return log[0] * 100 + x * 10 + y;
			}
		`);
		check('basic() ({x, y} = p)', basic(), 34);
		check('renamed() ({x: px, y: py} = p)', renamed(), 34);
		check('viaParam() (destructured class-typed param)', viaParam(), 25);
		check('nested() (a pattern nested inside another pattern)', nested(), 789);
		check('order() (destructured init evaluated exactly once)', order(), 112);
	}

	await checkThrows('rest element in an array pattern is rejected', () => compile(`
		function f(): number {
			const arr: number[] = [1, 2, 3];
			const [a, ...rest] = arr;
			return a;
		}
	`), /rest/);

	await checkThrows('rest property in an object pattern is rejected', () => compile(`
		class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
		function f(): number {
			const p = new Point(1, 2);
			const { x, ...rest } = p;
			return x;
		}
	`), /rest/);

	await checkThrows('a default value in a destructuring pattern is rejected', () => compile(`
		function f(): number {
			const arr: number[] = [1, 2];
			const [a, b = 5] = arr;
			return a + b;
		}
	`), /default/);

	await checkThrows("a bare 'return' before every object-typed field is assigned is rejected", () => compile(`
		class Inner { v: number; constructor() { this.v = 0; } }
		class Outer {
			p: Inner; n: number;
			constructor(x: number) {
				if (x < 0)
					return;
				this.p = new Inner();
				this.n = x;
			}
		}
		function f(): number { return new Outer(1).n; }
	`), /towasm/);

	await checkThrows('a compound assignment to an unset object-typed-sibling field is rejected', () => compile(`
		class Inner { v: number; constructor() { this.v = 0; } }
		class Outer {
			p: Inner; n: number;
			constructor(x: number) {
				this.n += x;
				this.p = new Inner();
			}
		}
		function f(): number { return new Outer(1).n; }
	`), /towasm/);

	await checkThrows('never assigning an object-typed field is rejected', () => compile(`
		class Inner { v: number; constructor() { this.v = 0; } }
		class Outer {
			p: Inner; n: number;
			constructor(x: number) {
				this.n = x;
			}
		}
		function f(): number { return new Outer(1).n; }
	`), /never assigns/);

	await checkThrows('a self-referential class field is rejected (no rec-group support)', () => compile(`
		class Node {
			next: Node; v: number;
			constructor(v: number, next: Node) {
				this.v = v;
				this.next = next;
			}
		}
		function f(a: Node): number {
			return new Node(1, a).v;
		}
	`), /cycle/);

	{
		// Nullable types: `T | null`/`T | undefined` (object types only -- see `typeOf`'s own comment for
		// why a nullable number/boolean isn't supported), `=== null`/`!== null` (both operand orders),
		// reassignment, and `x!` non-null assertion.
		const { isNullTrue, isNullFalse, notNullTrue, roundTrip, nullOnLeft, withUndefined, assertNonNull } = await compile(`
			class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
			function isNullTrue(): number {
				const p: Point | null = null;
				return p === null ? 1 : 0;
			}
			function isNullFalse(): number {
				const p: Point | null = new Point(1, 2);
				return p === null ? 1 : 0;
			}
			function notNullTrue(): number {
				const p: Point | null = new Point(1, 2);
				return p !== null ? 1 : 0;
			}
			function roundTrip(): number {
				let p: Point | null = null;
				p = new Point(3, 4);
				return p === null ? -1 : p.x + p.y;
			}
			function nullOnLeft(): number {
				const p: Point | null = null;
				return null === p ? 1 : 0;
			}
			function withUndefined(): number {
				const p: Point | undefined = undefined;
				return p === undefined ? 1 : 0;
			}
			function assertNonNull(): number {
				const p: Point | null = new Point(5, 6);
				return p!.x + p!.y;
			}
		`);
		check('isNullTrue() (p: Point|null = null; p === null)', isNullTrue(), 1);
		check('isNullFalse() (p: Point|null = new Point(); p === null)', isNullFalse(), 0);
		check('notNullTrue() (p !== null)', notNullTrue(), 1);
		check('roundTrip() (reassign null -> non-null, then read fields)', roundTrip(), 7);
		check('nullOnLeft() (null === p)', nullOnLeft(), 1);
		check('withUndefined() (p: Point|undefined = undefined)', withUndefined(), 1);
		check('assertNonNull() (p!.x + p!.y)', assertNonNull(), 11);
	}

	{
		// Optional chaining (`?.`) on a ref-typed field and on a method call, both null and non-null,
		// combined with `??` (nullish coalescing) -- and that the chain's base is only ever evaluated once.
		const { fieldNull, fieldNonNull, defaultUsed, defaultSkipped, callNull, callNonNull, order } = await compile(`
			class Inner { v: number; constructor(v: number) { this.v = v; } }
			class Outer { inner: Inner; constructor(inner: Inner) { this.inner = inner; } }
			class Wrapper { o: Outer | null; constructor(o: Outer | null) { this.o = o; } }
			function fieldNull(): number {
				const w = new Wrapper(null);
				const inner: Inner | null = w.o?.inner ?? null;
				return inner === null ? -1 : inner.v;
			}
			function fieldNonNull(): number {
				const w = new Wrapper(new Outer(new Inner(9)));
				const inner: Inner | null = w.o?.inner ?? null;
				return inner === null ? -1 : inner.v;
			}
			class Point {
				x: number; y: number;
				constructor(x: number, y: number) { this.x = x; this.y = y; }
				clone(): Point { return new Point(this.x, this.y); }
			}
			function defaultUsed(): number {
				const p: Point | null = null;
				const q = p ?? new Point(42, 0);
				return q.x;
			}
			function defaultSkipped(): number {
				const p: Point | null = new Point(7, 0);
				const q = p ?? new Point(42, 0);
				return q.x;
			}
			class Holder { p: Point | null; constructor(p: Point | null) { this.p = p; } }
			function callNull(): number {
				const h = new Holder(null);
				const c: Point | null = h.p?.clone() ?? null;
				return c === null ? -1 : c.x;
			}
			function callNonNull(): number {
				const h = new Holder(new Point(11, 12));
				const c: Point | null = h.p?.clone() ?? null;
				return c === null ? -1 : c.x + c.y;
			}
			function make(log: number[]): Point | null {
				log[0] = log[0] + 1;
				return new Point(5, 0);
			}
			function order(): number {
				const log: number[] = [0];
				const c: Point | null = make(log)?.clone() ?? null;
				return log[0] * 100 + (c === null ? -1 : c.x);
			}
		`);
		check('fieldNull() (w.o?.inner ?? null, o is null)', fieldNull(), -1);
		check('fieldNonNull() (w.o?.inner ?? null, o is non-null)', fieldNonNull(), 9);
		check('defaultUsed() (p ?? new Point(42), p is null)', defaultUsed(), 42);
		check('defaultSkipped() (p ?? new Point(42), p is non-null)', defaultSkipped(), 7);
		check('callNull() (h.p?.clone() ?? null, p is null)', callNull(), -1);
		check('callNonNull() (h.p?.clone() ?? null, p is non-null)', callNonNull(), 23);
		check('order() (base of ?. evaluated exactly once)', order(), 105);
	}

	await checkThrows("a nullable number/boolean field type is rejected", () => compile(`
		class C { n: number | null; constructor(n: number | null) { this.n = n; } }
		function f(): number { return new C(null).n === null ? 1 : 0; }
	`), /nullable number\/boolean/);

	await checkThrows("optional access on a number-typed field ('a?.b') is rejected", () => compile(`
		class Point { x: number; constructor(x: number) { this.x = x; } }
		class Wrapper { p: Point | null; constructor(p: Point | null) { this.p = p; } }
		function f(): number {
			const w = new Wrapper(null);
			const x: number | undefined = w.p?.x;
			return 1;
		}
	`), /towasm/);

	// This surfaces via '??'s own combined-result-type lookup (checker.typeOf can't resolve a chained
	// access through an optional result any better than towasm.ts can), not the more specific "chaining"
	// message emitExpr's 'member' case would throw if it got as far as actually lowering the chain --
	// still a real, safe rejection either way, just a more generic one.
	await checkThrows("chaining another access onto an optional result ('a?.b.c') is rejected", () => compile(`
		class Inner { v: number; constructor(v: number) { this.v = v; } }
		class Outer { inner: Inner; constructor(inner: Inner) { this.inner = inner; } }
		class Wrapper { o: Outer | null; constructor(o: Outer | null) { this.o = o; } }
		function f(): number {
			const w = new Wrapper(null);
			return w.o?.inner.v ?? -1;
		}
	`), /towasm/);

	await checkThrows("optional indexing ('a?.[i]') is rejected", () => compile(`
		function f(): number {
			const arr: number[] | null = null;
			const x: number | undefined = arr?.[0];
			return 1;
		}
	`), /towasm/);

	await checkThrows("'??' on a non-nullable left side is rejected", () => compile(`
		class Point { x: number; constructor(x: number) { this.x = x; } }
		function f(): number {
			const p = new Point(1);
			const q = p ?? new Point(2);
			return q.x;
		}
	`), /towasm/);

	{
		// number[]: literal, indexing, .length, classic `for`
		const { sum } = await compile(`
			function sum(): number {
				const arr: number[] = [1, 2, 3, 4, 5];
				let total: number = 0;
				for (let i: number = 0; i < arr.length; i = i + 1)
					total = total + arr[i];
				return total;
			}
		`);
		check('sum() (number[] + classic for + index)', sum(), 15);
	}

	{
		// number[] via `for...of`, and `boolean[]` via `for...of` + index-assignment
		const { sumOf, countTrue } = await compile(`
			function sumOf(): number {
				const arr: number[] = [10, 20, 30];
				let total: number = 0;
				for (const x of arr)
					total = total + x;
				return total;
			}
			function countTrue(): number {
				const flags: boolean[] = [true, false, true, true];
				flags[1] = true;
				let count: number = 0;
				for (const f of flags) {
					if (f)
						count = count + 1;
				}
				return count;
			}
		`);
		check('sumOf() (number[] for...of)', sumOf(), 60);
		check('countTrue() (boolean[] for...of + index assign)', countTrue(), 4);
	}

	{
		// Uint8Array: both constructor forms, index read/write, .length, for...of. The length-only form
		// (`new Uint8Array(n)`) goes through `Array<T>`'s own real `constructor` (see towasm-lib.ts),
		// substituted for `i8` like its other methods -- not a hand-built allocation in towasm.ts (see
		// `ensureBuiltinCtor`); the array-literal form stays a small special case in `emitExpr`'s `'new'`
		// case, since a single-signature ctor can't express "length or array literal" without overloading.
		const { bytesSum, zeroFilledLength, zeroFilledContent } = await compile(`
			function bytesSum(): number {
				const bytes = new Uint8Array([1, 2, 3, 250]);
				bytes[0] = 100;
				let total: number = 0;
				for (const b of bytes)
					total = total + b;
				return total;
			}
			function zeroFilledLength(): number {
				const bytes = new Uint8Array(5);
				return bytes.length;
			}
			function zeroFilledContent(): number {
				const bytes = new Uint8Array(5);
				return bytes[0] + bytes[4];
			}
		`);
		check('bytesSum() (Uint8Array literal + index read/write + for...of)', bytesSum(), 355);
		check('zeroFilledLength() (new Uint8Array(n) via real constructor)', zeroFilledLength(), 5);
		check('zeroFilledContent() (new Uint8Array(n) zero-initializes)', zeroFilledContent(), 0);
	}

	{
		// string: literal, .length, `+` concatenation, template literal with no interpolation
		const { strLen, concatLen } = await compile(`
			function strLen(): number {
				const s: string = "hello";
				return s.length;
			}
			function concatLen(): number {
				const s: string = "hello" + " world" + \`!\`;
				return s.length;
			}
		`);
		check('strLen() (string literal .length)', strLen(), 5);
		check("concatLen() (string '+' concatenation + no-interpolation template)", concatLen(), 12);
	}

	{
		// `new String(...)`: zero-arg empty string, and the one-existing-string form (no general
		// stringification -- see the rejection check below).
		const { emptyLen, fromExisting } = await compile(`
			function emptyLen(): number {
				return new String().length;
			}
			function fromExisting(): number {
				const a: string = "hello";
				const b = new String(a).toUpperCase();
				return b.length;
			}
		`);
		check("emptyLen() (new String() is an empty string)", emptyLen(), 0);
		check("fromExisting() (new String(existing string) works like the string itself)", fromExisting(), 5);
	}

	{
		// number[] non-callback methods
		const { numIndexOf, numLastIndexOf, numIncludes, numSlice, numReverse, numConcat, numFill } = await compile(`
			function numIndexOf(): number {
				const a: number[] = [10, 20, 30, 20];
				return a.indexOf(20);
			}
			function numLastIndexOf(): number {
				const a: number[] = [10, 20, 30, 20];
				return a.lastIndexOf(20);
			}
			function numIncludes(): number {
				const a: number[] = [10, 20, 30];
				return a.includes(30) ? 1 : 0;
			}
			function numSlice(): number {
				const a: number[] = [1, 2, 3, 4, 5];
				const b: number[] = a.slice(1, 4);
				return b.length + b[0];
			}
			function numReverse(): number {
				const a: number[] = [1, 2, 3];
				const b: number[] = a.reverse();
				return b[0];
			}
			function numConcat(): number {
				const a: number[] = [1, 2];
				const b: number[] = [3, 4, 5];
				const c: number[] = a.concat(b);
				return c.length;
			}
			function numFill(): number {
				const a: number[] = [1, 2, 3];
				a.fill(9);
				return a[0] + a[1] + a[2];
			}
		`);
		check('numIndexOf()', numIndexOf(), 1);
		check('numLastIndexOf()', numLastIndexOf(), 3);
		check('numIncludes()', numIncludes(), 1);
		check('numSlice()', numSlice(), 5);
		check('numReverse()', numReverse(), 3);
		check('numConcat()', numConcat(), 5);
		check('numFill()', numFill(), 27);
	}

	{
		// boolean[] non-callback methods
		const { boolIndexOf, boolLastIndexOf, boolIncludes, boolSlice, boolReverse, boolConcat, boolFill } = await compile(`
			function boolIndexOf(): number {
				const a: boolean[] = [false, false, true, false];
				return a.indexOf(true);
			}
			function boolLastIndexOf(): number {
				const a: boolean[] = [true, false, true, false];
				return a.lastIndexOf(true);
			}
			function boolIncludes(): number {
				const a: boolean[] = [false, false];
				return a.includes(true) ? 1 : 0;
			}
			function boolSlice(): number {
				const a: boolean[] = [true, false, true, true];
				const b: boolean[] = a.slice(1, 3);
				return b.length;
			}
			function boolReverse(): number {
				const a: boolean[] = [true, false, false];
				const b: boolean[] = a.reverse();
				return b[0] ? 1 : 0;
			}
			function boolConcat(): number {
				const a: boolean[] = [true];
				const b: boolean[] = [false, false];
				const c: boolean[] = a.concat(b);
				return c.length;
			}
			function boolFill(): number {
				const a: boolean[] = [false, false];
				a.fill(true);
				return (a[0] && a[1]) ? 1 : 0;
			}
		`);
		check('boolIndexOf()', boolIndexOf(), 2);
		check('boolLastIndexOf()', boolLastIndexOf(), 2);
		check('boolIncludes()', boolIncludes(), 0);
		check('boolSlice()', boolSlice(), 2);
		check('boolReverse()', boolReverse(), 0);
		check('boolConcat()', boolConcat(), 3);
		check('boolFill()', boolFill(), 1);
	}

	{
		// `Array<number>`/`Array<boolean>` -- the `Array<T>` spelling, not just `number[]`/`boolean[]`
		// literal types, dispatches through the exact same (genuinely shared, not per-kind-duplicated)
		// method table.
		const { arrNumMethods, arrBoolMethods } = await compile(`
			function arrNumMethods(): number {
				const a: Array<number> = [1, 2, 3, 4];
				const b: Array<number> = a.slice(1, 3);
				const c: Array<number> = a.concat(b);
				let f: Array<number> = [0, 0, 0];
				f = f.fill(9);
				return a.indexOf(3) * 1000 + b.length * 100 + c.length * 10 + f[0];
			}
			function arrBoolMethods(): number {
				const a: Array<boolean> = [true, false, true];
				const b: Array<boolean> = a.slice(0, 2);
				const r: Array<boolean> = a.reverse();
				return a.indexOf(false) === 1 && b.length === 2 && r[0] === true && a.includes(false) ? 1 : 0;
			}
		`);
		check('arrNumMethods() (Array<number> spelling)', arrNumMethods(), 2269);
		check('arrBoolMethods() (Array<boolean> spelling)', arrBoolMethods(), 1);
	}

	{
		// Uint8Array non-callback methods
		const { u8IndexOf, u8LastIndexOf, u8Includes, u8Slice, u8Reverse, u8Concat, u8Fill } = await compile(`
			function u8IndexOf(): number {
				const a = new Uint8Array([5, 10, 15, 10]);
				return a.indexOf(10);
			}
			function u8LastIndexOf(): number {
				const a = new Uint8Array([5, 10, 15, 10]);
				return a.lastIndexOf(10);
			}
			function u8Includes(): number {
				const a = new Uint8Array([1, 2, 3]);
				return a.includes(2) ? 1 : 0;
			}
			function u8Slice(): number {
				const a = new Uint8Array([10, 20, 30, 40]);
				const b = a.slice(1, 3);
				return b.length + b[0];
			}
			function u8Reverse(): number {
				const a = new Uint8Array([1, 2, 3]);
				const b = a.reverse();
				return b[0];
			}
			function u8Concat(): number {
				const a = new Uint8Array([1, 2]);
				const b = new Uint8Array([3, 4, 5]);
				const c = a.concat(b);
				return c.length;
			}
			function u8Fill(): number {
				const a = new Uint8Array([1, 2, 3]);
				a.fill(9);
				return a[0] + a[1] + a[2];
			}
		`);
		check('u8IndexOf()', u8IndexOf(), 1);
		check('u8LastIndexOf()', u8LastIndexOf(), 3);
		check('u8Includes()', u8Includes(), 1);
		check('u8Slice()', u8Slice(), 22);
		check('u8Reverse()', u8Reverse(), 3);
		check('u8Concat()', u8Concat(), 5);
		check('u8Fill()', u8Fill(), 27);
	}

	{
		// string non-callback methods
		const {
			strIndexOf, strLastIndexOf, strIncludes, strStartsWith, strEndsWith, strSlice,
			strTrim, strToUpper, strToLower, strRepeat, strConcatMethod, strCharAt, strCharCodeAt,
		} = await compile(`
			function strIndexOf(): number {
				const s: string = "hello world";
				return s.indexOf("world");
			}
			function strLastIndexOf(): number {
				const s: string = "abcabc";
				return s.lastIndexOf("abc");
			}
			function strIncludes(): number {
				const s: string = "hello";
				return s.includes("ell") ? 1 : 0;
			}
			function strStartsWith(): number {
				const s: string = "hello";
				return s.startsWith("he") ? 1 : 0;
			}
			function strEndsWith(): number {
				const s: string = "hello";
				return s.endsWith("lo") ? 1 : 0;
			}
			function strSlice(): number {
				const s: string = "hello world";
				const t: string = s.slice(6, 11);
				return t.length + t.charCodeAt(0);
			}
			function strTrim(): number {
				const s: string = "  hi  ";
				const t: string = s.trim();
				return t.length;
			}
			function strToUpper(): number {
				const s: string = "abcXYZ";
				const t: string = s.toUpperCase();
				return t.charCodeAt(0) + t.charCodeAt(3);
			}
			function strToLower(): number {
				const s: string = "abcXYZ";
				const t: string = s.toLowerCase();
				return t.charCodeAt(0) + t.charCodeAt(3);
			}
			function strRepeat(): number {
				const s: string = "ab";
				const t: string = s.repeat(3);
				return t.length;
			}
			function strConcatMethod(): number {
				const s: string = "foo";
				const t: string = s.concat("bar");
				return t.length;
			}
			function strCharAt(): number {
				const s: string = "hello";
				const c: string = s.charAt(1);
				return c.length + c.charCodeAt(0);
			}
			function strCharCodeAt(): number {
				const s: string = "A";
				return s.charCodeAt(0);
			}
		`);
		check('strIndexOf()', strIndexOf(), 6);
		check('strLastIndexOf()', strLastIndexOf(), 3);
		check('strIncludes()', strIncludes(), 1);
		check('strStartsWith()', strStartsWith(), 1);
		check('strEndsWith()', strEndsWith(), 1);
		check('strSlice()', strSlice(), 5 + 'w'.charCodeAt(0));
		check('strTrim()', strTrim(), 2);
		check('strToUpper()', strToUpper(), 'A'.charCodeAt(0) + 'X'.charCodeAt(0));
		check('strToLower()', strToLower(), 'a'.charCodeAt(0) + 'x'.charCodeAt(0));
		check('strRepeat()', strRepeat(), 6);
		check('strConcatMethod()', strConcatMethod(), 6);
		check('strCharAt()', strCharAt(), 1 + 'e'.charCodeAt(0));
		check('strCharCodeAt()', strCharCodeAt(), 'A'.charCodeAt(0));
	}

	{
		// Math.* -- now dispatched through the same `builtins`/`emitBuiltinCall` mechanism as the
		// __towasm_* alloc/setChar intrinsics, not a separate hand-written case; sqrt already covered
		// above via `distance()`/`chain()`, so this covers the other five.
		const { mAbs, mFloor, mCeil, mMin, mMax, mClz32 } = await compile(`
			function mAbs(): number { return Math.abs(-5); }
			function mFloor(): number { return Math.floor(4.7); }
			function mCeil(): number { return Math.ceil(4.2); }
			function mMin(): number { return Math.min(3, 9); }
			function mMax(): number { return Math.max(3, 9); }
			function mClz32(): number {
				const a: Int32Array = new Int32Array([1]);
				return Math.clz32(a[0]);
			}
		`);
		check('Math.abs()', mAbs(), 5);
		check('Math.floor()', mFloor(), 4);
		check('Math.ceil()', mCeil(), 5);
		check('Math.min()', mMin(), 3);
		check('Math.max()', mMax(), 9);
		// A fixed op (`i32.clz`, no `$T`) -- real i32 operand (via Int32Array) proves it emits/dispatches
		// correctly now that clz32 no longer goes through the generic $T mechanism at all.
		check('Math.clz32()', mClz32(), 31);
	}

	{
		// Bitwise/shift operators (&, |, ^, <<, >>, >>>, ~) -- i32-native, matching real JS's
		// ToInt32/ToUint32-then-op semantics. Also exercises the transient-i32 path end to end: `a[i]`
		// (a Uint8Array read) feeds directly into a shift without an f64 round-trip in between.
		const { band, bor, bxor, bshl, bshr, bshru, bnot, chain } = await compile(`
			function band(): number { return 6 & 3; }
			function bor(): number { return 6 | 1; }
			function bxor(): number { return 6 ^ 3; }
			function bshl(): number { return 1 << 4; }
			function bshr(): number { return -8 >> 1; }
			function bshru(): number { return -1 >>> 28; }
			function bnot(): number { return ~5; }
			function chain(): number {
				const a = new Uint8Array([0xF0, 0x0F]);
				return (a[0] << 4) | a[1];
			}
		`);
		check('a & b', band(), 6 & 3);
		check('a | b', bor(), 6 | 1);
		check('a ^ b', bxor(), 6 ^ 3);
		check('a << b', bshl(), 1 << 4);
		check('a >> b', bshr(), -8 >> 1);
		check('a >>> b', bshru(), -1 >>> 28);
		check('~a', bnot(), ~5);
		check('Uint8Array reads chained through <</| with no f64 round-trip', chain(), (0xF0 << 4) | 0x0F);
	}

	{
		// `f64`->`i32` coercion (writing a computed `number` into a `Uint8Array`, or feeding a bitwise
		// op) uses the saturating `i32.trunc_sat_f64_s`, not the trapping `i32.trunc_f64_s` used
		// elsewhere in this file for index/length truncation -- NaN and huge finite values used to crash
		// the whole module (`float unrepresentable in integer range`); now they clamp instead.
		const { viaNaN, viaHuge } = await compile(`
			function viaNaN(): number {
				const a = new Uint8Array([5]);
				const zero: number = a[0] - a[0];
				a[0] = a[0] * zero / zero; // NaN
				return a[0];
			}
			function viaHuge(): number {
				const a = new Uint8Array([0]);
				a[0] = a[0] + 100000000000000000000;
				return a[0];
			}
		`);
		check('Uint8Array write of NaN no longer traps', viaNaN(), 0);
		check('Uint8Array write of an out-of-range float no longer traps', viaHuge(), 255);
	}

	await checkThrows("slice() with wrong arg count is rejected", () => compile(`
		function f(): number {
			const a: number[] = [1, 2, 3];
			const b: number[] = a.slice(1, 2, 3);
			return b.length;
		}
	`), /towasm/);

	await checkThrows("indexOf() with wrong arg count is rejected", () => compile(`
		function f(): number {
			const a: number[] = [1, 2, 3];
			return a.indexOf();
		}
	`), /towasm/);

	{
		// `void` functions/methods: side-effecting via a param, an implicit (no-annotation) void
		// function, and an early-exit bare `return;` at any nesting depth -- including inside a
		// constructor, where it must still push `this` rather than nothing.
		const { setViaFunc, setViaImplicitVoid, setViaMethod, ctorEarlyReturn } = await compile(`
			function setIt(a: Uint8Array, v: number): void {
				a[0] = v;
			}
			function setViaFunc(): number {
				const a = new Uint8Array(1);
				setIt(a, 42);
				return a[0];
			}
			function bump(a: Uint8Array) {
				a[0] = a[0] + 1;
			}
			function setViaImplicitVoid(): number {
				const a = new Uint8Array(1);
				bump(a);
				bump(a);
				return a[0];
			}
			class Box {
				v: number;
				constructor(v: number) { this.v = v; }
				setV(x: number): void {
					if (x < 0)
						return;
					this.v = x;
				}
			}
			function setViaMethod(): number {
				const b = new Box(1);
				b.setV(99);
				return b.v;
			}
			class C {
				v: number;
				constructor(x: number) {
					this.v = 0;
					if (x > 0) {
						this.v = x;
						return;
					}
					this.v = -1;
				}
			}
			function ctorEarlyReturn(): number {
				return new C(5).v;
			}
		`);
		check("setViaFunc() (void function, side effect via Uint8Array param)", setViaFunc(), 42);
		check("setViaImplicitVoid() (no return-type annotation defaults to void)", setViaImplicitVoid(), 2);
		check("setViaMethod() (void method)", setViaMethod(), 99);
		check("ctorEarlyReturn() (bare 'return;' nested in an 'if' inside a constructor)", ctorEarlyReturn(), 5);
	}

	await checkThrows('void param is rejected', () => compile(`
		function f(x: void): number { return 1; }
	`), /void/);

	await checkThrows('void field is rejected', () => compile(`
		class C {
			x: void;
			constructor() {}
		}
		function f(): number {
			const c = new C();
			return 1;
		}
	`), /number\/boolean/);

	await checkThrows('void local is rejected', () => compile(`
		function noop(): void {}
		function f(): number {
			const x = noop();
			return 1;
		}
	`), /void/);

	await checkThrows("returning a value from a 'void' function is rejected", () => compile(`
		function f(): void { return 5; }
	`), /void/);

	await checkThrows('an unresolvable explicit return type still throws (not silently void)', () => compile(`
		function f(): NotARealType { return 1; }
	`), /towasm/);

	{
		// a genuine TS type error should be caught by `TStypeCheck` up front, before `TStoWasm` ever runs
		try {
			await compile(`
				function bad(n: number): number {
					return "x";
				}
			`);
			++failures;
			console.error('FAIL - rejects a real type error: expected a throw, got none');
		} catch (e) {
			const msg = (e as Error).message;
			check('rejects a real type error', /type errors/.test(msg), true);
		}
	}

	{
		// Int32Array + real i32 arithmetic (arithInline/equalityInline dispatch on the *operand's* kind,
		// not just declared `number`/`boolean` -- see towasm.ts's `operandKind`).
		const { i32RoundTrip, i32Compare } = await compile(`
			function i32RoundTrip(): number {
				const a: Int32Array = new Int32Array(3);
				a[0] = 10;
				a[1] = 20;
				a[2] = a[0] + a[1];
				return a[2];
			}
			function i32Compare(): number {
				const a: Int32Array = new Int32Array([5, 5]);
				const b: Int32Array = new Int32Array([5, 5]);
				return a[0] === b[0] && a[1] < 6 ? 1 : 0;
			}
		`);
		check('i32RoundTrip() (Int32Array + real i32 arithmetic)', i32RoundTrip(), 30);
		check('i32Compare() (Int32Array equality/comparison)', i32Compare(), 1);
	}

	{
		// `%` (towasm-lib.ts's `__towasm_mod`) is a `(typecase ...)` body -- a `switch` keyed on the
		// reserved `$T` name (see wat-parser.ts's own comment on it) whose two arms cover all four numeric
		// types: `(i32 i64)` shares a real `rem_s` instruction, `(f32 f64)` has no native op and falls back
		// to the long-hand `x - trunc(x/y)*y`. `modI32` (via `Int32Array`, same real-i32-dispatch path as
		// `i32RoundTrip` above) exercises the shared-op arm; `modF64` (plain `number`, wasm f64) exercises
		// the long-hand arm -- between them, both `(typecase ...)` arms actually get instantiated and run,
		// not just parsed.
		const { modI32, modF64 } = await compile(`
			function modI32(): number {
				const a: Int32Array = new Int32Array([7, 3]);
				a[0] = a[0] % a[1];
				return a[0];
			}
			function modF64(): number {
				return 7.5 % 2;
			}
		`);
		check('modI32() (typecase (i32 i64) shared rem_s arm)', modI32(), 1);
		check('modF64() (typecase (f32 f64) long-hand arm)', modF64(), 1.5);
	}

	{
		// Partial BigInt -- unsigned, base-65536-limb `bigint` (real primitive, backed by `BigInt`'s
		// methods -- see towasm-lib.ts's header comment for the documented scope). `+`/`<`/`<=`/`>`/`>=`/
		// `==`/`!=` all lower through `BIGINT_OPS` onto `BigInt`'s own methods (see towasm.ts's `emitExpr`
		// `'binary'` case) -- real TS itself allows these operators on two `bigint`s, so this is exercising
		// genuine operator syntax, not a hand-written method call. Operands are bound to explicit
		// `bigint`-annotated locals first, not chained straight through a call -- `bigFromNumber` itself is
		// invisible to the general checker (same gap as `Uint8Array`/`String`'s methods, see towasm-lib.ts's
		// header comment), so operator dispatch (which does need the checker's own type inference, unlike a
		// plain nested call) can only see a `bigint` operand via its declared type, not a call's return type.
		const {
			bigRoundTrip, bigRoundTripMultiLimb, bigAddSmall, bigAddCarry,
			bigLt, bigGtFalse, bigEq, bigNeq,
		} = await compile(`
			function bigRoundTrip(): number {
				return bigToNumber(bigFromNumber(12345));
			}
			function bigRoundTripMultiLimb(): number {
				return bigToNumber(bigFromNumber(4294967296));
			}
			function bigAddSmall(): number {
				const a: bigint = bigFromNumber(100);
				const b: bigint = bigFromNumber(200);
				return bigToNumber(a + b);
			}
			function bigAddCarry(): number {
				const a: bigint = bigFromNumber(65535);
				const b: bigint = bigFromNumber(1);
				return bigToNumber(a + b);
			}
			function bigLt(): boolean {
				const a: bigint = bigFromNumber(500);
				const b: bigint = bigFromNumber(600);
				return a < b;
			}
			function bigGtFalse(): boolean {
				const a: bigint = bigFromNumber(500);
				const b: bigint = bigFromNumber(600);
				return a > b;
			}
			function bigEq(): boolean {
				const a: bigint = bigFromNumber(42);
				const b: bigint = bigFromNumber(42);
				return a === b;
			}
			function bigNeq(): boolean {
				const a: bigint = bigFromNumber(42);
				const b: bigint = bigFromNumber(43);
				return a !== b;
			}
		`);
		check('bigRoundTrip() (bigFromNumber/bigToNumber)', bigRoundTrip(), 12345);
		check('bigRoundTripMultiLimb() (round-trips across a limb boundary)', bigRoundTripMultiLimb(), 4294967296);
		check('bigAddSmall() (bigint + bigint, no carry)', bigAddSmall(), 300);
		check('bigAddCarry() (bigint + bigint, carries into a new limb)', bigAddCarry(), 65536);
		check('bigLt() (bigint <)', bigLt(), 1);
		check('bigGtFalse() (bigint >)', bigGtFalse(), 0);
		check('bigEq() (bigint ===)', bigEq(), 1);
		check('bigNeq() (bigint !==)', bigNeq(), 1);
	}

	{
		// Partial Number -- Number.isInteger/isNaN, dispatched the same way as Math.* (see
		// emitExpr's 'call' case).
		const { numIsInt, numIsIntFalse, numIsNaNTrue, numIsNaNFalse, numSignPos, numSignNeg, numSignZero } = await compile(`
			function numIsInt(): number { return Number.isInteger(4) ? 1 : 0; }
			function numIsIntFalse(): number { return Number.isInteger(4.5) ? 1 : 0; }
			function numIsNaNTrue(): number { return Number.isNaN(0 / 0) ? 1 : 0; }
			function numIsNaNFalse(): number { return Number.isNaN(4) ? 1 : 0; }
		`);
		check('numIsInt() (Number.isInteger true)', numIsInt(), 1);
		check('numIsIntFalse() (Number.isInteger false)', numIsIntFalse(), 0);
		check('numIsNaNTrue() (Number.isNaN true)', numIsNaNTrue(), 1);
		check('numIsNaNFalse() (Number.isNaN false)', numIsNaNFalse(), 0);
	}

	{
		// Math's transcendental functions -- each a real (non-exact) polynomial approximation, so
		// `checkClose` rather than `check`. `Math.PI2`/`.PI_HALF`/`.INV_LN2` (private static fields) and
		// `Math.abs`/`.sqrt`/etc (asm builtins) are exercised transitively through these.
		const { mSin, mCos0, mCos, mTan, mExp, mExpNeg, mLog, mLog100, mAsin, mAcos, mAtan, mAtan2 } = await compile(`
			function mSin(x: number): number { return Math.sin(x); }
			function mCos0(): number { return Math.cos(0); }
			function mCos(x: number): number { return Math.cos(x); }
			function mTan(x: number): number { return Math.tan(x); }
			function mExp(x: number): number { return Math.exp(x); }
			function mExpNeg(x: number): number { return Math.exp(x); }
			function mLog(x: number): number { return Math.log(x); }
			function mLog100(): number { return Math.log(100); }
			function mAsin(x: number): number { return Math.asin(x); }
			function mAcos(x: number): number { return Math.acos(x); }
			function mAtan(x: number): number { return Math.atan(x); }
			function mAtan2(y: number, x: number): number { return Math.atan2(y, x); }
		`);
		checkClose('Math.sin(0.5)', mSin(0.5), Math.sin(0.5));
		checkClose('Math.cos(0)', mCos0(), 1);
		checkClose('Math.cos(2)', mCos(2), Math.cos(2));
		checkClose('Math.tan(1)', mTan(1), Math.tan(1));
		checkClose('Math.exp(1)', mExp(1), Math.E);
		checkClose('Math.exp(-1)', mExpNeg(-1), 1 / Math.E);
		checkClose('Math.log(2)', mLog(2), Math.LN2);
		checkClose('Math.log(100)', mLog100(), Math.log(100));
		// `asin`/`atan` near/at the `ax > 0.5` reduction boundary -- the values that exposed the original
		// missing-`x`-factor (`asin`) and slow-Taylor-convergence (`atan`) bugs (~5-9% off before the fix).
		checkClose('Math.asin(0.5)', mAsin(0.5), Math.PI / 6);
		checkClose('Math.acos(0.5)', mAcos(0.5), Math.PI / 3);
		checkClose('Math.atan(1)', mAtan(1), Math.PI / 4);
		checkClose('Math.atan2(1, 1)', mAtan2(1, 1), Math.PI / 4);
		checkClose('Math.atan2(-1, 1)', mAtan2(-1, 1), -Math.PI / 4);
	}

	{
		// Number's formatting methods -- each returns a real string, so every test hashes it (see
		// `jsHash`'s own comment) rather than comparing raw wasm exports. Deliberately skips a plain
		// `.toString()` on a value like `3.14` whose binary representation isn't exact (`3.14 - 3 ===
		// 0.14000000000000012`): `fracToString`'s naive repeated-multiply-by-10 has no shortest-round-trip
		// logic (unlike real engines' Grisu/Ryu-style algorithms), so it surfaces that representation noise
		// as extra trailing digits -- a known, inherent limitation of this simplified implementation, not
		// exercised here to keep this test meaningful rather than flaky-by-design.
		const { hHashToStringDefault, hHashToString16, hHashToFixed, hHashToExponential, hHashToPrecision, hParseInt, hParseFloat } = await compile(`
			function hashString(s: string): number {
				let h: number = s.length;
				let i: number = 0;
				while (i < s.length) {
					h = h + s.charCodeAt(i) * (i + 1);
					i = i + 1;
				}
				return h;
			}
			function hHashToStringDefault(x: number): number { return hashString(x.toString()); }
			function hHashToString16(x: number): number { return hashString(x.toString(16)); }
			function hHashToFixed(x: number, digits: number): number { return hashString(x.toFixed(digits)); }
			function hHashToExponential(x: number, digits: number): number { return hashString(x.toExponential(digits)); }
			function hHashToPrecision(x: number, precision: number): number { return hashString(x.toPrecision(precision)); }
			function hParseInt(): number { return Number.parseInt("456"); }
			function hParseFloat(): number { return Number.parseFloat("12.75"); }
		`);
		check("(0).toString()", hHashToStringDefault(0), jsHash((0).toString()));
		check("(123).toString()", hHashToStringDefault(123), jsHash((123).toString()));
		check("(-123).toString()", hHashToStringDefault(-123), jsHash((-123).toString()));
		check("(0.5).toString()", hHashToStringDefault(0.5), jsHash((0.5).toString()));
		// This lib's radix conversion uses uppercase letter digits ('A'-'F'), unlike real JS's lowercase.
		check("(255).toString(16)", hHashToString16(255), jsHash((255).toString(16).toUpperCase()));
		check("(3.14159).toFixed(2)", hHashToFixed(3.14159, 2), jsHash((3.14159).toFixed(2)));
		check("(0).toFixed(2)", hHashToFixed(0, 2), jsHash((0).toFixed(2)));
		check("(123.456).toExponential(2)", hHashToExponential(123.456, 2), jsHash((123.456).toExponential(2)));
		check("(0).toExponential(2)", hHashToExponential(0, 2), jsHash((0).toExponential(2)));
		// Plain fixed-notation output (not exponential) -- the original always used exponential the moment
		// `e !== 0`, which these two wouldn't have exercised correctly (see towasm-lib.ts's own comment).
		check("(123.456).toPrecision(4) ('123.5', not exponential)", hHashToPrecision(123.456, 4), jsHash((123.456).toPrecision(4)));
		// Rounding carry: 2 significant digits of 9.99 rounds up to a 3rd digit ('100'), renormalized back
		// to 2 ('10') -- the case that exposed the carry bug in `toPrecision`'s own digit rounding.
		check("(-9.99).toPrecision(2) (rounding carry)", hHashToPrecision(-9.99, 2), jsHash((-9.99).toPrecision(2)));
		check("Number.parseInt('456')", hParseInt(), 456);
		check("Number.parseFloat('12.75')", hParseFloat(), 12.75);
	}

	{
		// Template literals -- `\`a${b}c\`` desugars to the same left-to-right '+' chain real JS builds it
		// from (see towasm.ts's `emitTemplateLiteral`). Every interpolated value's type decides how it
		// stringifies: `string` passes through, `number` calls `.toString()`, `boolean` is a ternary (no
		// `Boolean` class in this lib to call a real `.toString()` on).
		const { tplNum, tplNumFrac, tplStr, tplBoolTrue, tplBoolFalse, tplMulti, tplAdjacent, tplNoInterp } = await compile(`
			function hashString(s: string): number {
				let h: number = s.length;
				let i: number = 0;
				while (i < s.length) {
					h = h + s.charCodeAt(i) * (i + 1);
					i = i + 1;
				}
				return h;
			}
			function tplNum(x: number): number { return hashString(\`x=\${x}\`); }
			function tplNumFrac(x: number): number { return hashString(\`x=\${x}\`); }
			function tplStr(): number { const s: string = "world"; return hashString(\`hello \${s}!\`); }
			function tplBoolTrue(): number { return hashString(\`b=\${true}\`); }
			function tplBoolFalse(): number { return hashString(\`b=\${false}\`); }
			function tplMulti(a: number, c: number): number { const b: string = "mid"; return hashString(\`a=\${a}, b=\${b}, c=\${c}\`); }
			function tplAdjacent(a: number, b: number): number { return hashString(\`\${a}\${b}\`); }
			function tplNoInterp(): number { return hashString(\`plain text\`); }
		`);
		check('template: number interpolation', tplNum(42), jsHash(`x=${42}`));
		check('template: number interpolation (exact fraction)', tplNumFrac(0.5), jsHash(`x=${0.5}`));
		check('template: string interpolation', tplStr(), jsHash('hello world!'));
		check('template: boolean interpolation (true)', tplBoolTrue(), jsHash(`b=${true}`));
		check('template: boolean interpolation (false)', tplBoolFalse(), jsHash(`b=${false}`));
		check('template: multiple interpolations', tplMulti(1, 3), jsHash(`a=${1}, b=${'mid'}, c=${3}`));
		check('template: adjacent interpolations (no text between)', tplAdjacent(7, 8), jsHash(`${7}${8}`));
		check('template: no interpolation (plain string)', tplNoInterp(), jsHash('plain text'));

		await checkThrows('template: interpolating a class instance is rejected', () => compile(`
			class Foo { x: number = 0; constructor() { this.x = 0; } }
			function f(): string { const foo = new Foo(); return \`\${foo}\`; }
		`), /towasm/);
	}

	{
		// console.log(x) -- see towasm.ts's own `emitConsoleLog`. This is the first towasm feature with a
		// side effect instead of a return value, so it's verified by spying on the real global `console.log`
		// (the same binding `compile`'s own instantiation passes through as the `console` import) rather
		// than checking a returned number.
		const { logNumber, logBoolTrue, logBoolFalse } = await compile(`
			function logNumber(x: number): void { console.log(x); }
			function logBoolTrue(): void { console.log(true); }
			function logBoolFalse(): void { console.log(false); }
		`) as unknown as { logNumber: (x: number) => void; logBoolTrue: () => void; logBoolFalse: () => void };

		const captured: unknown[] = [];
		const realLog = console.log;
		console.log = (...args: unknown[]) => { captured.push(args[0]); };
		try {
			logNumber(3.5);
			logBoolTrue();
			logBoolFalse();
		} finally {
			console.log = realLog;
		}
		check('console.log(number)', captured[0], 3.5);
		// wasm has no distinct boolean runtime tag -- a boolean argument prints as 1/0, not true/false
		// (documented deviation, see emitConsoleLog's own comment).
		check('console.log(true) prints 1 (no boolean runtime tag)', captured[1], 1);
		check('console.log(false) prints 0 (no boolean runtime tag)', captured[2], 0);

		await checkThrows('console.log(...) with more than one argument is rejected', () => compile(`
			function f(): void { console.log(1, 2); }
		`), /exactly one argument/);
		await checkThrows('console.log(a string) is rejected', () => compile(`
			function f(): void { console.log('hi'); }
		`), /number\/boolean argument/);

		// A program that never calls console.log at all must still instantiate with no imports required.
		const { noLog } = await compile(`function noLog(): number { return 5; }`);
		check('a program that never calls console.log needs no imports', noLog(), 5);
	}

	{
		// Closures -- a captured arrow/function-expression literal compiles to a `{code, env}` wasm-GC
		// struct pair (see towasm.ts's `ensureClosureType`), called via `call_ref` against one wasm function
		// type shared per TS signature. Captures are by value/reference *for the lifetime of one closure
		// instance* (repeat calls to the same instance see each other's mutations -- the counter case below)
		// but not shared back with the enclosing function's own copy once created.
		const { applyDouble, applyIncr } = await compile(`
			function apply(f: (x: number) => number, x: number): number {
				return f(x);
			}
			function applyDouble(x: number): number {
				return apply(y => y * 2, x);
			}
			function applyIncr(x: number): number {
				return apply(y => y + 1, x);
			}
		`);
		check('closure: HOF parameter, literal 1', applyDouble(5), 10);
		check('closure: HOF parameter, literal 2 (shared call type, different literal)', applyIncr(5), 6);

		const { counterTest } = await compile(`
			function makeCounter(): () => number {
				let n = 0;
				return () => {
					n = n + 1;
					return n;
				};
			}
			function counterTest(): number {
				const c = makeCounter();
				const a = c();
				const b = c();
				return a * 10 + b;
			}
		`);
		check('closure: mutated capture persists across calls to the same instance', counterTest(), 12);

		const { adderTest } = await compile(`
			function makeAdder(n: number): (x: number) => number {
				return (x: number) => x + n;
			}
			function adderTest(): number {
				const add5 = makeAdder(5);
				return add5(10);
			}
		`);
		check('closure: returned from a function, capturing a param', adderTest(), 15);

		const { nestedTest } = await compile(`
			function outer(a: number): () => number {
				const makeMiddle = (b: number): (() => number) => {
					return () => a + b;
				};
				return makeMiddle(a + 1);
			}
			function nestedTest(): number {
				const f = outer(10);
				return f();
			}
		`);
		check('closure: nested two levels deep, transitively captures the outermost variable', nestedTest(), 21);

		const { thisTest } = await compile(`
			class Box {
				value: number;
				constructor(v: number) { this.value = v; }
				makeGetter(): () => number {
					return () => this.value;
				}
			}
			function thisTest(): number {
				const b = new Box(42);
				const g = b.makeGetter();
				return g();
			}
		`);
		check("closure: arrow captures 'this' inside a method", thisTest(), 42);

		await checkThrows('closure: a named function expression referencing its own name is rejected', () => compile(`
			function test(): number {
				const f = function self(x: number): number {
					return x <= 0 ? 0 : self(x - 1);
				};
				return f(3);
			}
		`), /referencing its own name/);

		await checkThrows("closure: 'this' inside a (non-arrow) function expression is rejected", () => compile(`
			class Box {
				value: number;
				constructor(v: number) { this.value = v; }
				makeGetter(): () => number {
					return function(): number { return this.value; };
				}
			}
			function test(): number {
				const b = new Box(1);
				const g = b.makeGetter();
				return g();
			}
		`), /'this' inside a function expression/);
	}

	{
		// TStoWasm assumes `ast` already went through TStypeCheck (which stamps `ast.scope`) -- calling it
		// on a freshly parsed, never-checked program should fail loudly instead of silently doing the wrong thing.
		try {
			TStoWasm(parser.parse('function f(n: number): number { return n; }'));
			++failures;
			console.error('FAIL - rejects an unchecked ast: expected a throw, got none');
		} catch (e) {
			check('rejects an unchecked ast', /must be checked/.test((e as Error).message), true);
		}
	}

	if (failures) {
		console.error(`${failures} failure(s)`);
		process.exit(1);
	}
	console.log('all towasm tests passed');
}

main().catch(e => { console.error(e); process.exit(1); });
