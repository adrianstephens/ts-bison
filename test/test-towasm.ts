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
	console.log(mod.toWAT());
	const bytes		= mod.toBytes();
	const instance	= new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)));
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
		// Uint8Array: both constructor forms, index read/write, .length, for...of
		const { bytesSum, zeroFilledLength } = await compile(`
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
		`);
		check('bytesSum() (Uint8Array literal + index read/write + for...of)', bytesSum(), 355);
		check('zeroFilledLength() (new Uint8Array(n))', zeroFilledLength(), 5);
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

	await checkThrows("new String(number) is rejected (no general stringification)", () => compile(`
		function f(): number {
			const s = new String(5);
			return 1;
		}
	`), /stringifying/);

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
		const { mAbs, mFloor, mCeil, mMin, mMax } = await compile(`
			function mAbs(): number { return Math.abs(-5); }
			function mFloor(): number { return Math.floor(4.7); }
			function mCeil(): number { return Math.ceil(4.2); }
			function mMin(): number { return Math.min(3, 9); }
			function mMax(): number { return Math.max(3, 9); }
		`);
		check('Math.abs()', mAbs(), 5);
		check('Math.floor()', mFloor(), 4);
		check('Math.ceil()', mCeil(), 5);
		check('Math.min()', mMin(), 3);
		check('Math.max()', mMax(), 9);
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
			const b: number[] = a.slice(1);
			return b.length;
		}
	`), /towasm/);

	await checkThrows("indexOf() with wrong arg count is rejected", () => compile(`
		function f(): number {
			const a: number[] = [1, 2, 3];
			return a.indexOf();
		}
	`), /towasm/);

	await checkThrows('push() is rejected (no resizing methods)', () => compile(`
		function f(): number {
			const arr: number[] = [1, 2];
			arr.push(3);
			return arr.length;
		}
	`), /towasm/);

	await checkThrows("indexing a 'string' is rejected", () => compile(`
		function f(): number {
			const s: string = "abc";
			const c = s[0];
			return s.length;
		}
	`), /indexing is only supported on number\[\]\/boolean\[\]\/Uint8Array/);

	await checkThrows("string '===' (by-value equality) is rejected", () => compile(`
		function f(): number {
			const a: string = "x";
			const b: string = "x";
			return a === b ? 1 : 0;
		}
	`), /string equality/);

	await checkThrows("'for...in' is rejected", () => compile(`
		function f(): number {
			const arr: number[] = [1, 2, 3];
			let total: number = 0;
			for (const k in arr)
				total = total + 1;
			return total;
		}
	`), /for\.\.\.in/);

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
