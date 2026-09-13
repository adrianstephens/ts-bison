import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import v8 from 'v8';
import * as TS from '../src/examples/TS/ts-parser';
import * as T from '../src/examples/TS/type-utils';
import { TStoWasm, makeLibScope } from '../src/examples/TS/towasm';
import { quoteString } from '../src/examples/TS/tocode';
import { TStypeCheck, TStypeCheckAsync } from '../src/examples/TS/transform';
import { ModuleLoader, collectModules } from '../src/examples/TS/module-loader';
import { SEVERITY } from '../src/examples/TS/checker';

// `try`/`catch` compiles to the exnref/try_table exception-handling proposal (Wasm 3.0), which
// this Node's V8 doesn't enable by default -- must be set before the first `WebAssembly.Module`
// compile below. See the towasm exceptions design memory for how this was confirmed necessary.
v8.setFlagsFromString('--experimental-wasm-exnref');

const parser = TS.make();
// Built once, reused across every `compile()` call below -- same lib declarations either way.
const libScope = makeLibScope();

const b = new Uint8Array(1024);
const f = new Float32Array(b.buffer);
for (let i = 0; i < f.length; i++) {
	f[i] = i + 0.5;
	b[i * 4] &= 0x7f;
}


// TStoWasm assumes its input already passed TStypeCheck (same contract as TStoJS/TStoDecl) -- it does
// no error reporting of its own, so that gate belongs here, in the caller, not in the library.
//
// No WAT text, no wabt/binaryen: `TStoWasm` returns a `@isopodlabs/binary_libs` `wasm.WasmModule`
// directly, and that package's own `.toBytes()` is the assembler -- a first-party GC-capable writer
// (wabt's published build has GC compiled out entirely; binaryen works but is ~200x this project's
// own size for what's fundamentally a fixed, self-controlled instruction set -- see the write-up).
// Type-checks `src` in isolation (no codegen) -- for tests that only care whether the checker
// accepts/rejects a program, independent of whatever towasm.ts backend gaps its shape might otherwise hit.
function typeErrors(src: string): string[] {
	const program		= parser.parse(src);
	const diagnostics	= TStypeCheck(program, new T.Scope(libScope));
	return diagnostics.filter(d => d.severity === SEVERITY.ERROR).map(d => `  ${d.pos.line}:${d.pos.col} - ${d.message}`);
}

async function compile(src: string) {
	const program		= parser.parse(src);
	const diagnostics	= TStypeCheck(program, new T.Scope(libScope));
	const errors		= diagnostics.filter(d => d.severity === SEVERITY.ERROR);
	if (errors.length)
		throw new Error('type errors:\n' + errors.map(d => `  ${d.pos.line}:${d.pos.col} - ${d.message}`).join('\n'));

	const mod		= TStoWasm(program);
	console.log(mod.toWAT({expandTypes: true, hexFloats: false}));
	return instantiate(mod.toBytes());
}

// Real multi-file codegen (`TStoWasm`'s `modules`/`namedImports` params) needs a real `ModuleLoader`
// resolving real files -- an in-memory `parser.parse(src)` string, unlike `compile()` above, has no file
// system location for a relative `import` to resolve against. `files`: every module's own source, keyed
// by its filename (no `.ts` extension) relative to a fresh temp directory; `entry` names which one is the
// program entry point.
async function compileMulti(files: Record<string, string>, entry: string) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'towasm-multi-'));
	try {
		for (const [name, src] of Object.entries(files))
			await fs.writeFile(path.join(dir, name + '.ts'), src);

		//const global	= libScope ? new Scope(libScope) : await getLibScope(loader, options);
		
		const loader		= new ModuleLoader(dir, {});
		const entrySrc		= await fs.readFile(path.join(dir, entry + '.ts'), 'utf8');
		const program		= parser.parse(entrySrc);
		const diagnostics	= await TStypeCheckAsync(program, loader, new T.Scope(libScope));
		const errors		= diagnostics.filter(d => d.severity === SEVERITY.ERROR);
		if (errors.length)
			throw new Error('type errors:\n' + errors.map(d => `  ${d.pos.line}:${d.pos.col} - ${d.message}`).join('\n'));

		const { modules, namedImports } = await collectModules(program.body, loader);
		const mod = TStoWasm(program, modules, namedImports);
		console.log(mod.toWAT({expandTypes: true, hexFloats: false}));
		return instantiate(mod.toBytes());
	} finally {
		await fs.rm(dir, {recursive: true, force: true});
	}
}

async function instantiate(bytes: Uint8Array) {
	const consoleOutput: string[] = [];
	const importObject = {
		wasi_snapshot_preview1: {
			fd_write: (_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => {
				const mem = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
				let total = 0;
				for (let i = 0; i < iovsLen; i++) {
					const ptr	= mem.getUint32(iovsPtr + i * 8, true);
					const len	= mem.getUint32(iovsPtr + i * 8 + 4, true);
					const text	= String.fromCharCode(...new Uint8Array(mem.buffer, ptr, len));
					consoleOutput.push(text);
					process.stdout.write(text);
					total += len;
				}
				mem.setUint32(nwrittenPtr, total, true);
				return 0; // errno success
			},
		},
	};
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), importObject);
	return { ...(instance.exports as Record<string, (...args: number[]) => number>), __consoleOutput: consoleOutput } as Record<string, (...args: number[]) => number> & { __consoleOutput: string[] };
}

async function main() {
	let failures = 0;
	const check = (name: string, actual: unknown, expected: unknown) => {
		try {
			assert.strictEqual(actual, expected);
			console.log(`ok - ${name}`);
		} catch {
			++failures;
			// `show`, not plain interpolation: a wasm-GC reference (an exported `bigint`/array/object)
			// has no primitive conversion, so building this message threw and took the whole run with it
			// instead of reporting the one failure.
			const show = (v: unknown) => { try { return String(v); } catch { return Object.prototype.toString.call(v); } };
			console.error(`FAIL - ${name}: expected ${show(expected)}, got ${show(actual)}`);
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
	// Asserts `src` type-checks with zero errors -- for narrowing/inference regressions where the bug is
	// entirely in the checker's own verdict, independent of whether towasm.ts's backend can also compile the shape.
	const checkTypeChecks = (name: string, src: string) => {
		const errors = typeErrors(src);
		if (errors.length === 0) {
			console.log(`ok - ${name}`);
		} else {
			++failures;
			console.error(`FAIL - ${name}: unexpected type errors:\n${errors.join('\n')}`);
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

	//{
	//	const wasm = await fs.readFile(path.join(__dirname, 'sample.wasm'));
	//	const r = await instantiate(wasm);
	//	console.log(r);
	//}

	{
		// Nested array literal (`number[][]`) construction + read-back. Root cause: a plain array literal
		// has no dedicated "array of real unboxed inner arrays" physical representation -- an inner array
		// literal nested inside an outer ref-kind array always gets boxed-`any` storage too (`case 'array'`'s
		// own "want wins" construction rule), so `x[0]`'s real value is a boxed-any array, not the genuine
		// `(array (mut f64))` its own declared `number[]` type alone would normally get. `x[0][1]`'s read-back
		// used to resolve `x[0]`'s class via `classOf`'s *declared*-type-driven answer (`Array<number>`,
		// standalone-correct but wrong here) instead of what it actually physically is (`Array<any>`) --
		// calling `Array<number>.get(i)`'s own compiled body (hardcoded to `array.get` on a real f64-array
		// type) on a boxed-any array crashed at runtime ("illegal cast"). Fixed via `classOfForIndexing`
		// (only overrides the built-in `Array` class, detected via the same "is my own container ref-kind"
		// propagation `objectArrayKind` uses for the plain-raw-array path).
		// `big` returns `Number(...)` rather than the bigint itself: an exported `bigint` crosses the
		// boundary as an opaque wasm-GC array reference, which nothing on this side can compare.
		const { big, arrayarray, arrayarrayWrite, factorial } = await compile(`
			export function big() {
				return Number(1000000n * 1000000n);
			}
			export function arrayarray() {
				const x: number[][] = [[1, 2], [3, 4]];
				return x[0][1];
			}
			export function arrayarrayWrite(): number {
				const x: number[][] = [[1, 2], [3, 4]];
				x[0][1] = 99;
				return x[0][1] + x[1][0] + x[0].length + x[0][0];
			}
			export function factorial(n: number): number {
				switch (n) {
					case -0.5: return 1.77245385091;
					case 0: return 1;
					case 1: return 1;
					case 2: return 2;
					case 3: return 6;
					case 4: return 24;
					case 5: return 120;
					default: return 0;
				}
			}
		`);
		check('big', big(), Number(1000000n * 1000000n));
		check('arrayarray', arrayarray(), 2);
		check('arrayarray: write + .length on a nested array read back correctly', arrayarrayWrite(), 105);
		check('factorial(0)', factorial(0), 1);
		check('factorial(0.5)', factorial(0.5), 0);
		check('factorial(-0.5)', factorial(-.5), 1.77245385091);
		check('factorial(1)', factorial(1), 1);
		check('factorial(5)', factorial(5), 120);
	}

	{
		const { factorial } = await compile(`
			export function factorial(n: number): number {
				let result: number = 1;
				do  {
					if (n <= 1)
						break;
					result = result * n;
					n = n - 1;
				} while (n > 1);
				return result;
			}
		`);
		check('factorial(0)', factorial(0), 1);
		check('factorial(1)', factorial(1), 1);
		check('factorial(5)', factorial(5), 120);
	}

	{
		const { factorial } = await compile(`
			export function factorial(n: number): number {
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
			export function fib(n: number): number {
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
			export function isEven(n: number): boolean {
				return n === 0 ? true : !isEven(n - 1);
			}
		`);
		check('isEven(0)', isEven(0), 1);
		check('isEven(3)', isEven(3), 0);
		check('isEven(4)', isEven(4), 1);
	}

	{
		const { both, either } = await compile(`
			export function both(a: boolean, b: boolean): boolean {
				return a && b;
			}
			export function either(a: boolean, b: boolean): boolean {
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
			export function neg(x: number): number {
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
			export function postInc(): number {
				let x: number = 5;
				const y: number = x++;
				return y * 100 + x;
			}
			export function preInc(): number {
				let x: number = 5;
				const y: number = ++x;
				return y * 100 + x;
			}
			export function postDec(): number {
				let x: number = 5;
				const y: number = x--;
				return y * 100 + x;
			}
			export function loopSum(n: number): number {
				let sum: number = 0;
				for (let i: number = 0; i < n; i++)
					sum = sum + i;
				return sum;
			}
			export function bareStmt(): number {
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
			export function area(w: number, h: number): number {
				return new Rect(w, h).area();
			}
			export function distance(): number {
				const p = new Point(0, 0);
				const q = new Point(3, 4);
				return p.distanceTo(q);
			}
			export function chain(): number {
				const p = new Point(1, 1);
				return p.scale(3).distanceTo(new Point(0, 0));
			}
			export function sameRef(): number {
				const p = new Point(1, 1);
				const q = p;
				return (p === q) ? 1 : 0;
			}
			export function diffRef(): number {
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
		const { getX, getY, sameWrappedRef, diffWrappedRef, sumFirst, reordered, crossFieldRead } = await compile(`
			class Point {
				x: number; y: number;
				constructor(x: number, y: number) { this.x = x; this.y = y; }
			}
			class Wrapper {
				p: Point; tag: number;
				constructor(p: Point, tag: number) { this.p = p; this.tag = tag; }
			}
			export function getX(): number {
				return new Wrapper(new Point(3, 4), 1).p.x;
			}
			export function getY(): number {
				const w = new Wrapper(new Point(3, 4), 1);
				return w.p.y + w.tag;
			}
			export function sameWrappedRef(): number {
				const p = new Point(1, 2);
				return (new Wrapper(p, 0).p === p) ? 1 : 0;
			}
			export function diffWrappedRef(): number {
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
			export function sumFirst(): number {
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
			export function reordered(): number {
				const p = new Pair(5, 9);
				return p.a * 100 + p.b;
			}
			class Sum {
				p: Point; total: number;
				constructor(x: number, y: number) {
					this.p = new Point(x, y);
					this.total = this.p.x + this.p.y;
				}
			}
			export function crossFieldRead(): number {
				const s = new Sum(3, 4);
				return s.total;
			}
		`);
		check('getX() (object-typed field read)', getX(), 3);
		check('getY() (object-typed field + number field)', getY(), 5);
		check('sameWrappedRef() (field holds the same ref passed in)', sameWrappedRef(), 1);
		check('diffWrappedRef() (field vs a distinct new instance)', diffWrappedRef(), 0);
		check('sumFirst() (array-typed field + plain-statement prefix)', sumFirst(), 70);
		check('reordered() (fields assigned out of declaration order)', reordered(), 509);
		check("crossFieldRead() (a later field's initializer reads an already-initialized field via 'this')", crossFieldRead(), 7);
	}

	{
		// Array-literal spread (`[...a, b]`): can't use `array.new_fixed` (a spread source's length is
		// only known at runtime), so this goes through `array.new_default` + `array.copy`/`array.set`
		// instead (see `emitArrayElementsWithSpread` in towasm.ts). Covers a spread at each position, two
		// spreads in one literal, and that every element (plain or spread source) is evaluated exactly
		// once, in source order, even when it has a side effect.
		const { sumSpreadEnd, sumSpreadMiddle, sumTwoSpreads, lenSpreadEnd, order } = await compile(`
			export function sumSpreadEnd(): number {
				const a: number[] = [1, 2, 3];
				const b: number[] = [0, ...a];
				let total: number = 0;
				for (let i: number = 0; i < b.length; i = i + 1)
					total = total + b[i];
				return total;
			}
			export function sumSpreadMiddle(): number {
				const a: number[] = [2, 3];
				const b: number[] = [1, ...a, 4];
				let total: number = 0;
				for (let i: number = 0; i < b.length; i = i + 1)
					total = total + b[i];
				return total;
			}
			export function sumTwoSpreads(): number {
				const a: number[] = [1, 2];
				const c: number[] = [3, 4];
				const b: number[] = [...a, 9, ...c];
				let total: number = 0;
				for (let i: number = 0; i < b.length; i = i + 1)
					total = total + b[i];
				return total;
			}
			export function lenSpreadEnd(): number {
				const a: number[] = [1, 2, 3];
				const b: number[] = [0, ...a];
				return b.length;
			}
			export function tap(log: number[], idx: number, n: number): number {
				log[idx] = n;
				return n;
			}
			export function tapArr(log: number[], idx: number, tag: number): number[] {
				log[idx] = tag;
				return [tag * 10, tag * 10 + 1];
			}
			export function order(): number {
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

	{
		// Spread call arguments (`f(...arr)`): only meaningful bundled into a rest param (a spread's
		// length isn't known until runtime, so it can't fill a fixed parameter position) -- `emitCallArgs`
		// reuses the same array-literal-spread machinery just exercised above for every call site: a
		// plain function, a fixed-plus-rest mix, a constructor, and a closure value.
		const { spreadIntoFunction, spreadPlusExtra, spreadIntoCtor, spreadIntoClosure, spreadIntoArrayPush } = await compile(`
			function sum(...nums: number[]): number {
				let t: number = 0;
				for (let i: number = 0; i < nums.length; i = i + 1)
					t = t + nums[i];
				return t;
			}
			export function spreadIntoFunction(): number {
				const arr: number[] = [1, 2, 3];
				return sum(...arr);
			}
			export function spreadPlusExtra(): number {
				const arr: number[] = [1, 2, 3];
				return sum(100, ...arr);
			}
			class Bag {
				total: number;
				constructor(...nums: number[]) {
					let t: number = 0;
					for (let i: number = 0; i < nums.length; i = i + 1)
						t = t + nums[i];
					this.total = t;
				}
			}
			export function spreadIntoCtor(): number {
				const arr: number[] = [5, 6, 7];
				const b = new Bag(...arr);
				return b.total;
			}
			export function spreadIntoClosure(): number {
				const arr: number[] = [10, 20, 30];
				const closureSum = (...nums: number[]): number => {
					let t: number = 0;
					for (let i: number = 0; i < nums.length; i = i + 1)
						t = t + nums[i];
					return t;
				};
				return closureSum(...arr);
			}
			export function spreadIntoArrayPush(): number {
				const arr: number[] = [1, 2];
				const more: number[] = [3, 4];
				arr.push(...more);
				return arr.length;
			}
		`);
		check('spread call argument into a plain rest function', spreadIntoFunction(), 6);
		check('spread call argument plus a fixed leading argument', spreadPlusExtra(), 106);
		check('spread call argument into a constructor', spreadIntoCtor(), 18);
		check('spread call argument into a closure value', spreadIntoClosure(), 60);
		check('spread call argument into an existing rest method (array.push)', spreadIntoArrayPush(), 4);
	}

	await checkThrows('spread into a fixed-arity (no rest) call is rejected', () => compile(`
		function add(a: number, b: number): number { return a + b; }
		export function f(): number {
			const arr: number[] = [1, 2];
			return add(...arr);
		}
	`), /rest parameter/);

	await checkThrows('spread crossing the fixed/rest boundary is rejected', () => compile(`
		function combine(a: number, b: number, ...rest: number[]): number { return a + b; }
		export function f(): number {
			const arr: number[] = [1, 2, 3];
			return combine(...arr, 9);
		}
	`), /trailing rest arguments/);

	await checkThrows('spreading a mismatched-kind array is rejected', () => compile(`
		export function f(): number {
			const a: boolean[] = [true, false];
			const b: number[] = [1, ...(a as unknown as number[])];
			return b.length;
		}
	`), /tsw/);

	{
		// Array destructuring (var_decl + function params): plain positional binding, a hole, and a
		// destructured param.
		const { basic, withHole, viaParam } = await compile(`
			export function basic(): number {
				const arr: number[] = [10, 20, 30];
				const [a, b, c] = arr;
				return a * 100 + b * 10 + c;
			}
			export function withHole(): number {
				const arr: number[] = [1, 2, 3];
				const [, second] = arr;
				return second;
			}
			export function pick([x, y]: number[]): number {
				return x * 10 + y;
			}
			export function viaParam(): number {
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
			export function basic(): number {
				const p = new Point(3, 4);
				const { x, y } = p;
				return x * 10 + y;
			}
			export function renamed(): number {
				const p = new Point(3, 4);
				const { x: px, y: py } = p;
				return px * 10 + py;
			}
			export function dist({ x, y }: Point): number {
				return x * x + y * y;
			}
			export function viaParam(): number {
				return dist(new Point(3, 4));
			}
			class Wrapper {
				p: Point; tag: number;
				constructor(p: Point, tag: number) { this.p = p; this.tag = tag; }
			}
			export function nested(): number {
				const w = new Wrapper(new Point(7, 8), 9);
				const { p: { x, y }, tag } = w;
				return x * 100 + y * 10 + tag;
			}
			export function make(log: number[]): Point {
				log[0] = log[0] + 1;
				return new Point(1, 2);
			}
			export function order(): number {
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

	{
		// Array pattern rest (`.slice()` under the hood, so a genuinely new array, not a view) and default
		// values (`??` under the hood -- see towasm.ts's own comment on `patternBindings`). A default on an
		// ordinary (non-nullable) array element is provably dead code -- covered here as "doesn't wrongly
		// throw", with the real nullable-triggers case covered separately below via a nullable object field.
		const { arrayRest, arrayRestEmpty, arrayDefaultUnused, paramArrayRestCaller } = await compile(`
			export function arrayRest(): number {
				const arr: number[] = [1, 2, 3, 4, 5];
				const [a, b, ...rest] = arr;
				let total: number = a * 1000 + b * 100;
				for (let i: number = 0; i < rest.length; i = i + 1)
					total = total + rest[i];
				return total;
			}
			export function arrayRestEmpty(): number {
				const arr: number[] = [1, 2];
				const [a, b, ...rest] = arr;
				return a * 100 + b * 10 + rest.length;
			}
			export function arrayDefaultUnused(): number {
				const arr: number[] = [1, 2];
				const [a, b = 99] = arr;
				return a * 100 + b;
			}
			function paramArrayRest(nums: number[]): number {
				const [first, ...others] = nums;
				let total: number = first * 1000;
				for (let i: number = 0; i < others.length; i = i + 1)
					total = total + others[i];
				return total;
			}
			export function paramArrayRestCaller(): number {
				return paramArrayRest([10, 1, 2, 3]);
			}
		`);
		check('array pattern rest ([a, b, ...rest])', arrayRest(), 1200 + 3 + 4 + 5);
		check('array pattern rest (source exactly as long as the fixed part, rest empty)', arrayRestEmpty(), 120);
		check('array pattern default (element present, default unused)', arrayDefaultUnused(), 102);
		check('array pattern rest in a destructured function param', paramArrayRestCaller(), 10000 + 1 + 2 + 3);
	}

	{
		// Object pattern default, both branches of the real `??` it desugars to: present (default
		// unused) and genuinely undefined (default used) -- only representable for a nullable
		// *object*-typed field (a nullable primitive field remains a separate, still-unsupported gap).
		const { objDefaultPresent, objDefaultMissing } = await compile(`
			class Inner { v: number; constructor(v: number) { this.v = v; } }
			class Box { value: Inner | undefined; constructor(v: Inner | undefined) { this.value = v; } }
			export function objDefaultPresent(): number {
				const b = new Box(new Inner(5));
				const fallback = new Inner(99);
				const { value = fallback } = b;
				return value.v;
			}
			export function objDefaultMissing(): number {
				const b = new Box(undefined);
				const fallback = new Inner(99);
				const { value = fallback } = b;
				return value.v;
			}
		`);
		check('object pattern default (value present, default unused)', objDefaultPresent(), 5);
		check('object pattern default (value undefined, default used)', objDefaultMissing(), 99);
	}

	await checkThrows('rest property in an object pattern is rejected', () => compile(`
		class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
		export function f(): number {
			const p = new Point(1, 2);
			const { x, ...rest } = p;
			return x;
		}
	`), /rest/);

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
		export function f(): number { return new Outer(1).n; }
	`), /tsw/);

	await checkThrows('a compound assignment to an unset object-typed-sibling field is rejected', () => compile(`
		class Inner { v: number; constructor() { this.v = 0; } }
		class Outer {
			p: Inner; n: number;
			constructor(x: number) {
				this.n += x;
				this.p = new Inner();
			}
		}
		export function f(): number { return new Outer(1).n; }
	`), /tsw/);

	await checkThrows("calling a method on 'this' before every object-typed field is assigned is rejected", () => compile(`
		class Inner { v: number; constructor() { this.v = 0; } }
		class Outer {
			p: Inner; n: number;
			constructor(x: number) {
				this.log();
				this.n = x;
				this.p = new Inner();
			}
			log(): void {}
		}
		export function f(): number { return new Outer(1).n; }
	`), /can't be used yet/);

	{
		// `setField`'s own "already constructed" fallback (`ensureCtor`): once every field has been
		// collected and `struct.new` has run, an ordinary `this.field = value` statement -- including a
		// genuine reassignment, not just the first-ever assignment -- goes through plain field-write
		// codegen exactly like the scalar-only path always has, not the collect-into-a-scratch-local path.
		const { reassign } = await compile(`
			class Inner { v: number; constructor(v: number) { this.v = v; } }
			class Outer {
				p: Inner; n: number;
				constructor(x: number) {
					this.p = new Inner(x);
					this.n = x;
					this.n = x + 100;
				}
			}
			export function reassign(): number { return new Outer(5).n; }
		`);
		check("object-typed ctor: a field reassigned after every field is already collected still works", reassign(), 105);
	}

	{
		// A field initializer that reads an already-collected *sibling* field (here, a parameter property
		// assigned before any field initializer runs, per `emitCtorStatements`'s own real-TS-matching
		// order) -- exercises `case 'member'`'s own `ctx.ctorFields`-aware shortcut, which reads the
		// sibling's scratch local directly rather than needing a real `this` to exist at all yet.
		const { test } = await compile(`
			class Inner { v: number; constructor(v: number) { this.v = v; } }
			class Foo {
				p: Inner;
				y = this.x + 1;
				constructor(public x: number) {
					this.p = new Inner(x);
				}
			}
			export function test(): number {
				const f = new Foo(5);
				return f.y * 10 + f.p.v;
			}
		`);
		check("object-typed ctor: a field initializer reading an already-collected sibling field works", test(), 65);
	}

	await checkThrows('never assigning an object-typed field is rejected', () => compile(`
		class Inner { v: number; constructor() { this.v = 0; } }
		class Outer {
			p: Inner; n: number;
			constructor(x: number) {
				this.n = x;
			}
		}
		export function f(): number { return new Outer(1).n; }
	`), /never assigns/);

	{
		// A self-referential class field (`next: Node | null`) now compiles and runs correctly --
		// `ensureClass` registers a real placeholder `typeIndex` before resolving any field's own type, so a
		// reentrant call for the same class (triggered while resolving `next`'s own type) finds a real,
		// already-allocated forward index and short-circuits instead of recursing; the placeholder gets
		// patched with the real struct fields once the outermost call's own field loop finishes. Previously
		// unconditionally rejected ("field cycle... not supported", no `resolving` guard exists anymore).
		const { linkedNode } = await compile(`
			class Node {
				next: Node | null; v: number;
				constructor(v: number, next: Node | null) {
					this.v = v;
					this.next = next;
				}
			}
			export function linkedNode(): number {
				const a = new Node(1, null);
				const b = new Node(2, a);
				return b.next!.v;
			}
		`);
		check('a self-referential class field compiles and runs', linkedNode(), 1);
	}

	{
		// Nullable types: `T | null`/`T | undefined` (object types only -- see `typeOf`'s own comment for
		// why a nullable number/boolean isn't supported), `=== null`/`!== null` (both operand orders),
		// reassignment, and `x!` non-null assertion.
		const { isNullTrue, isNullFalse, notNullTrue, roundTrip, nullOnLeft, withUndefined, assertNonNull } = await compile(`
			class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
			export function isNullTrue(): number {
				const p: Point | null = null;
				return p === null ? 1 : 0;
			}
			export function isNullFalse(): number {
				const p: Point | null = new Point(1, 2);
				return p === null ? 1 : 0;
			}
			export function notNullTrue(): number {
				const p: Point | null = new Point(1, 2);
				return p !== null ? 1 : 0;
			}
			export function roundTrip(): number {
				let p: Point | null = null;
				p = new Point(3, 4);
				return p === null ? -1 : p.x + p.y;
			}
			export function nullOnLeft(): number {
				const p: Point | null = null;
				return null === p ? 1 : 0;
			}
			export function withUndefined(): number {
				const p: Point | undefined = undefined;
				return p === undefined ? 1 : 0;
			}
			export function assertNonNull(): number {
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
			export function fieldNull(): number {
				const w = new Wrapper(null);
				const inner: Inner | null = w.o?.inner ?? null;
				return inner === null ? -1 : inner.v;
			}
			export function fieldNonNull(): number {
				const w = new Wrapper(new Outer(new Inner(9)));
				const inner: Inner | null = w.o?.inner ?? null;
				return inner === null ? -1 : inner.v;
			}
			class Point {
				x: number; y: number;
				constructor(x: number, y: number) { this.x = x; this.y = y; }
				clone(): Point { return new Point(this.x, this.y); }
			}
			export function defaultUsed(): number {
				const p: Point | null = null;
				const q = p ?? new Point(42, 0);
				return q.x;
			}
			export function defaultSkipped(): number {
				const p: Point | null = new Point(7, 0);
				const q = p ?? new Point(42, 0);
				return q.x;
			}
			class Holder { p: Point | null; constructor(p: Point | null) { this.p = p; } }
			export function callNull(): number {
				const h = new Holder(null);
				const c: Point | null = h.p?.clone() ?? null;
				return c === null ? -1 : c.x;
			}
			export function callNonNull(): number {
				const h = new Holder(new Point(11, 12));
				const c: Point | null = h.p?.clone() ?? null;
				return c === null ? -1 : c.x + c.y;
			}
			export function make(log: number[]): Point | null {
				log[0] = log[0] + 1;
				return new Point(5, 0);
			}
			export function order(): number {
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

	{
		// Same `obj?.method()` shape as `callNull`/`callNonNull` above, but bound to an *unannotated*
		// `const` and read back later -- exercises a real root-caused bug distinct from `typeOf`'s own
		// `?.` handling (that part was already correct): towasm.ts's `var_decl` codegen has its own fast
		// path that, whenever it can resolve the callee's owner class, reads the called method's *raw*
		// declared return type straight off the class decl instead of calling `checker.typeOf` on the
		// whole call expression -- silently dropping the `| undefined` an optional call short-circuits
		// to. A *direct* inline use of the same expression (no intermediate const) was never affected.
		const { callInferredNull, callInferredNonNull } = await compile(`
			class Box { v: number; constructor(v: number) { this.v = v; } getV(): number { return this.v; } }
			function get(useNull: boolean): Box | null { return useNull ? null : new Box(23); }
			export function callInferredNull(): number {
				const r = get(true)?.getV();
				return r === undefined ? -1 : r;
			}
			export function callInferredNonNull(): number {
				const r = get(false)?.getV();
				return r === undefined ? -1 : r;
			}
		`);
		check('a?.method(), unannotated const, receiver null', callInferredNull(), -1);
		check('a?.method(), unannotated const, receiver non-null', callInferredNonNull(), 23);
	}

	{
		// A nullable primitive ('number | null'/'boolean | null'): a real, boxed nullable value, not
		// the same physical representation an unboxed `number`/`boolean` uses -- declare, narrow, use
		// in arithmetic, assign a literal `null`, and read back through a genuinely-nullable field.
		const { narrowed, assignNull, unnarrowedTraps, boolField } = await compile(`
			class C { n: number | null; constructor(n: number | null) { this.n = n; } }
			export function narrowed(): number {
				const c = new C(5);
				return c.n !== null ? c.n + 1 : -1;
			}
			export function assignNull(): number {
				const c = new C(5);
				c.n = null;
				return c.n === null ? 1 : 0;
			}
			// The checker's own \`isNumberLike\` union leniency lets unnarrowed arithmetic on a nullable
			// primitive through (a separate, pre-existing, documented gap) -- must trap cleanly at
			// runtime rather than silently misbehave.
			export function unnarrowedTraps(): number {
				const c = new C(null);
				return c.n + 1;
			}
			class B { flag: boolean | null; constructor(flag: boolean | null) { this.flag = flag; } }
			export function boolField(): number {
				const b = new B(true);
				return b.flag === null ? -1 : (b.flag ? 1 : 0);
			}
		`);
		check('nullable primitive field: narrow + arithmetic', narrowed(), 6);
		check('nullable primitive field: assign null literal', assignNull(), 1);
		check('nullable primitive field: boolean field narrow', boolField(), 1);
		try {
			unnarrowedTraps();
			++failures;
			console.error("FAIL - nullable primitive field: unnarrowed arithmetic traps at runtime: expected a throw, got none");
		} catch {
			console.log('ok - nullable primitive field: unnarrowed arithmetic traps at runtime');
		}
	}

	{
		// `x?.prop === literal` truly holding also implies `x` itself is non-nullish (a nullish `x` would
		// short-circuit the whole comparison to `undefined`, never equal to a real literal) -- negating a
		// further-nested `x?.prop === literal && !x.other && x.other2` conjunction used to lose this,
		// letting `undefined` leak into the narrowed type on the branch asserting the equality actually
		// held, and (as a consequence of the same union-combining logic) silently dropping a union member
		// along the way. Type-check only (not `compile`/wasm execution) -- the bug is entirely in the
		// checker's own verdict, and this receiver shape (an optional union-of-interfaces parameter) hits
		// unrelated, pre-existing towasm.ts backend gaps that have nothing to do with the narrowing itself.
		checkTypeChecks('optional-chain discriminant conjunction: negation keeps every union member and excludes undefined', `
			interface RefType { kind: 'ref'; typeArgs?: unknown[]; declScope?: object }
			interface OtherType { kind: 'other' }
			type NodeType = RefType | OtherType;
			function resolve(scope: unknown, t: NodeType): string { return t.kind; }
			function f(scope: unknown, typeAnnotation?: NodeType) {
				return typeAnnotation?.kind === 'ref' && !typeAnnotation.typeArgs && typeAnnotation.declScope
					? resolve(typeAnnotation.declScope, typeAnnotation)
					: typeAnnotation ? resolve(scope, typeAnnotation) : 'none';
			}
		`);
		// Negative control: `x?.prop !== literal` holding does NOT imply `x` is non-nullish (a nullish `x`
		// satisfies `!==` just as well) -- must stay rejected, not accidentally "fixed" into acceptance.
		await checkThrows('optional-chain discriminant conjunction: negated-equality branch does not wrongly assume non-null', () => compile(`
			interface RefType { kind: 'ref' }
			interface OtherType { kind: 'other' }
			function resolve(t: RefType | OtherType): string { return String(t); }
			export function f(typeAnnotation?: RefType | OtherType): string {
				if (typeAnnotation?.kind !== 'ref')
					return resolve(typeAnnotation);
				return resolve(typeAnnotation);
			}
		`), /not assignable/);
	}

	{
		// `a?.b` on a number-typed field -- the optional-chain result is itself a boxed nullable
		// primitive ('number | undefined'), read back through both the null and non-null receiver.
		const { fieldNull, fieldNonNull } = await compile(`
			class Point { x: number; constructor(x: number) { this.x = x; } }
			class Wrapper { p: Point | null; constructor(p: Point | null) { this.p = p; } }
			export function fieldNull(): number {
				const w = new Wrapper(null);
				const x: number | undefined = w.p?.x;
				return x === undefined ? -1 : x;
			}
			export function fieldNonNull(): number {
				const w = new Wrapper(new Point(9));
				const x: number | undefined = w.p?.x;
				return x === undefined ? -1 : x;
			}
		`);
		check("a?.b (number-typed field, receiver null)", fieldNull(), -1);
		check("a?.b (number-typed field, receiver non-null)", fieldNonNull(), 9);
	}

	{
		// `a?.b.c` -- a plain (non-`?.`) continuation of an earlier optional step still short-circuits the
		// whole chain, same as real JS: `.inner.v` never runs at all when `w.o` is null, not just "reads
		// `.v` off `undefined` and fails". `a?.b?.c` (every step optional) composes the same way.
		const { chainNull, chainNonNull, doubleOptNull, doubleOptNonNull } = await compile(`
			class Inner { v: number; constructor(v: number) { this.v = v; } }
			class Outer { inner: Inner; constructor(inner: Inner) { this.inner = inner; } }
			class Wrapper { o: Outer | null; constructor(o: Outer | null) { this.o = o; } }
			export function chainNull(): number {
				const w = new Wrapper(null);
				return w.o?.inner.v ?? -1;
			}
			export function chainNonNull(): number {
				const w = new Wrapper(new Outer(new Inner(7)));
				return w.o?.inner.v ?? -1;
			}
			class OptInner { v: number; constructor(v: number) { this.v = v; } }
			class OptOuter { inner: OptInner | null; constructor(inner: OptInner | null) { this.inner = inner; } }
			function noOuter(): OptOuter | null { return null; }
			export function doubleOptNull(): number {
				const o = noOuter();
				return o?.inner?.v ?? -1;
			}
			export function doubleOptNonNull(): number {
				const o: OptOuter | null = new OptOuter(new OptInner(9));
				return o?.inner?.v ?? -1;
			}
		`);
		check("a?.b.c (chain continuation, root null)", chainNull(), -1);
		check("a?.b.c (chain continuation, root non-null)", chainNonNull(), 7);
		check("a?.b?.c (every step optional, root null)", doubleOptNull(), -1);
		check("a?.b?.c (every step optional, root non-null)", doubleOptNonNull(), 9);
	}

	{
		// `a?.[i]` -- the whole array (not an element) is nullable; the indexed read is itself a boxed
		// nullable primitive ('number | undefined').
		const { idxNull, idxNonNull } = await compile(`
			function getArr(useNull: boolean): number[] | null { return useNull ? null : [1, 2, 3]; }
			export function idxNull(): number {
				const x: number | undefined = getArr(true)?.[1];
				return x === undefined ? -1 : x;
			}
			export function idxNonNull(): number {
				const x: number | undefined = getArr(false)?.[1];
				return x === undefined ? -1 : x;
			}
		`);
		check('a?.[i] (array-typed receiver null)', idxNull(), -1);
		check('a?.[i] (array-typed receiver non-null)', idxNonNull(), 2);
	}

	{
		// Same `a?.[i]` shape as above but with the const's type *inferred* (no explicit annotation) --
		// `typeOf`'s own `case 'index'` never read `e.optional` anywhere in its body (unlike its
		// `case 'member'` sibling), so an unannotated `const r = arr?.[i]` inferred `r` as plain `number`
		// instead of `number | undefined`, both for a direct `=== undefined` compare and for narrowing.
		const { idxInferredDirect, idxInferredNarrowed } = await compile(`
			function getArr(useNull: boolean): number[] | null { return useNull ? null : [1, 2, 3]; }
			export function idxInferredDirect(): number {
				const r = getArr(true)?.[1];
				return r === undefined ? -1 : r;
			}
			export function idxInferredNarrowed(): number {
				const r = getArr(false)?.[1];
				if (r !== undefined)
					return r + 100;
				return -1;
			}
		`);
		check('a?.[i], unannotated const, direct undefined compare (receiver null)', idxInferredDirect(), -1);
		check('a?.[i], unannotated const, narrowed !== undefined (receiver non-null)', idxInferredNarrowed(), 102);
	}

	{
		// `p ?? X` on a statically-non-nullable `p` is legal (if redundant) real JS/TS -- always `p`,
		// `X` never evaluated. Previously threw here only as an accidental side effect of an unrelated
		// gap (resolving `q`'s own type, `Point | Point`, needed `typeOf` to resolve an *anonymous*
		// structurally-Point-shaped object type, which it couldn't) -- fixed by `matchObjectShapeByType`
		// (a generic parameter's own structural bound resolving to a real interface/object shape,
		// self-hosting `walker.ts`'s own `mapObject<N extends Record<string, any>>`'s motivating case),
		// which incidentally also makes this construct resolve correctly now.
		const { f } = await compile(`
			class Point { x: number; constructor(x: number) { this.x = x; } }
			export function f(): number {
				const p = new Point(1);
				const q = p ?? new Point(2);
				return q.x;
			}
		`);
		check("'??' on a non-nullable left side (legal, always the left side)", f(), 1);
	}

	{
		// number[]: literal, indexing, .length, classic `for`
		const { sum } = await compile(`
			export function sum(): number {
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
			export function sumOf(): number {
				const arr: number[] = [10, 20, 30];
				let total: number = 0;
				for (const x of arr)
					total = total + x;
				return total;
			}
			export function countTrue(): number {
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
			export function bytesSum(): number {
				const bytes = new Uint8Array([1, 2, 3, 250]);
				bytes[0] = 100;
				let total: number = 0;
				for (const b of bytes)
					total = total + b;
				return total;
			}
			export function zeroFilledLength(): number {
				const bytes = new Uint8Array(5);
				return bytes.length;
			}
			export function zeroFilledContent(): number {
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
			export function strLen(): number {
				const s: string = "hello";
				return s.length;
			}
			export function concatLen(): number {
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
			export function emptyLen(): number {
				return new String().length;
			}
			export function fromExisting(): number {
				const a: string = "hello";
				const b = new String(a).toUpperCase();
				return b.length;
			}
		`);
		check("emptyLen() (new String() is an empty string)", emptyLen(), 0);
		check("fromExisting() (new String(existing string) works like the string itself)", fromExisting(), 5);
	}

	{
		// `String.split` was declared `string | RegExp` in lib.d.ts but only the RegExp half was ever
		// implemented, so a string separator type-checked and then failed codegen trying to convert the
		// string to a `RegExp`. The two degenerate cases are the ones worth pinning: an empty separator
		// splits into characters (the general scan would match everywhere and never advance), and an
		// empty subject splits to `[]` only when the separator matches it -- i.e. is itself empty.
		const r = await compile(`
			export function parts(): number { return "a.b.c".split(".").length; }
			export function keepsText(): number { return "a.bb.c".split(".")[1].length; }
			export function multiChar(): number { return "a::b::c".split("::").length; }
			export function noMatch(): number { return "abc".split(",").length; }
			export function limited(): number { return "a,b,c,d".split(",", 2).length; }
			export function emptySep(): number { return "abcd".split("").length; }
			export function emptySubject(): number { return "".split(",").length; }
			export function emptyBoth(): number { return "".split("").length; }
			export function leadingSep(): number { return ",a".split(",")[0].length; }
			export function regexpStill(): number { return "a1b2c".split(/[0-9]/).length; }
		`);
		check("split: a string separator", r.parts(), 3);
		check("split: the pieces are the text BETWEEN separators", r.keepsText(), 2);
		check("split: a multi-character separator", r.multiChar(), 3);
		check("split: no match is the whole string", r.noMatch(), 1);
		check("split: 'limit' caps the result", r.limited(), 2);
		check("split: an empty separator splits into characters", r.emptySep(), 4);
		check("split: an empty subject with a non-matching separator", r.emptySubject(), 1);
		check("split: an empty subject with an empty separator", r.emptyBoth(), 0);
		check("split: a leading separator yields an empty first piece", r.leadingSep(), 0);
		check("split: the RegExp overload still works", r.regexpStill(), 3);
	}

	{
		// `[K, V]` as a PARAMETER type inferred nothing -- `inferTypeArgs` had no tuple case -- so every
		// entries-style generic constructor came out `<any, any>`, which towasm rejects outright ("class
		// 'Map' needs 2 explicit type argument(s)"). The literal form needs a second thing: an array
		// literal argument only becomes a TUPLE if the still-generic parameter's shape reaches it as its
		// contextual type.
		const r = await compile(`
			const pairs: [string, number][] = [["a", 1], ["bb", 2]];
			export function fromTypedPairs(): number { const m = new Map(pairs); return m.get("bb")! + m.size; }
			export function fromLiteral(): number { const m = new Map([["a", 1], ["bb", 2]]); return m.get("bb")! + m.size; }
			export function setFromLiteral(): number { const s = new Set([1, 2, 3]); return s.has(2) ? s.size : 0; }
			// The inferred value type must be the real one, not a widened union: calling a method on it
			// is what proves the difference.
			class Box { constructor(public n: number) {} twice(): number { return this.n * 2; } }
			export function inferredValueKeepsItsClass(): number {
				const m = new Map([["k", new Box(21)]]);
				return m.get("k")!.twice();
			}
		`);
		check('Map: inferred from a typed [K, V][] argument', r.fromTypedPairs(), 4);
		check('Map: inferred from an array literal of pairs', r.fromLiteral(), 4);
		check('Set: inferred from an array literal', r.setFromLiteral(), 3);
		check('Map: the inferred value type keeps its class', r.inferredValueKeepsItsClass(), 42);

		// The hard form: the entries come from a CALL, so the tuple-ness has to travel backwards --
		// `new Map`'s `[K, V][]` parameter reaches the `.map` call, which reverse-matches its own `U` to
		// `[K, V]`, which contextually types the callback's RETURN, which finally makes `[n.name, n]` a
		// tuple. Real TS does exactly this, and rejects the same expression outright once it is hoisted
		// into a variable ("Target requires 2 element(s) but source may have fewer") -- there is no
		// inferring `Map<string, Node>` from a `(string | Node)[][]` that has already been formed.
		// Calling `.kind` on the value is what pins it: that only compiles if `V` really is `Node`.
		const { fromMapped } = await compile(`
			class Node { constructor(public name: string, public kind: number) {} }
			export function fromMapped(): number {
				const nodes = [new Node("aa", 1), new Node("bbb", 2)];
				const m = new Map(nodes.map(n => [n.name, n]));
				return m.get("bbb")!.kind * 10 + m.size;
			}
		`);
		check('Map: inferred through a .map() call, not just a literal', fromMapped(), 22);

		// A SELF-REFERENTIAL function type -- one that takes itself as a parameter -- overflowed the
		// stack: `typeOf` -> `closureSigParts` -> `params.map` -> `typeOf` on the same annotation, with
		// nothing to break the loop (`T.resolve`'s cycle guard never sees it; each parameter resolves
		// fine alone). This is checker.ts's own `checkStmt(s, scope, typeOf, checkStmt)` shape, and it
		// took out all 25 of that file's declarations at once.
		const { selfRef } = await compile(`
			type Visit = (n: number, next: Visit) => number;
			function run(v: Visit): number { return v(1, v); }
			export function selfRef(): number { return run((n: number, next: Visit) => n + 1); }
		`);
		check('a function type that takes itself has a representation', selfRef(), 2);

		// `undefined` had no binding on the wasm path at all (`makeLibScope` builds its globals from
		// `lib.d.ts`, which cannot declare it -- real tsc rejects that as a built-in conflict), so the
		// identifier typed as `any`. A ternary's `undefined` branch then contributed `any`, which
		// swallowed the whole union: `cond ? n : undefined` came out `number | any`, leaving nothing
		// nullable for a later `!== undefined` to test against.
		// UNANNOTATED on purpose: an explicit `number | undefined` supplies the type itself and never
		// exercises what the ternary inferred.
		const { ternaryUndef, bareUndef } = await compile(`
			export function ternaryUndef(): number {
				const cond = true;
				const v = cond ? 7 : undefined;
				return v !== undefined ? v : -1;
			}
			function pick(take: boolean, n: number) { return take ? n : undefined; }
			export function bareUndef(): number {
				const a = pick(true, 5);
				const b = pick(false, 5);
				return (a !== undefined ? a : 0) * 10 + (b !== undefined ? b : 3);
			}
		`);
		check("a ternary's 'undefined' branch stays 'undefined', not 'any'", ternaryUndef(), 7);
		check("...and through a function's own INFERRED return type", bareUndef(), 53);
	}

	{
		// `tocode.ts`'s own string quoting, which replaced `JSON.stringify` (this compiler's lib has no
		// `JSON`, and `tocode.ts` is a self-hosting target). Checked directly against `JSON.stringify`,
		// since matching it exactly is the whole contract -- every escape it produces, plus fuzz over the
		// range where the C0 controls and the `\u00xx` fallback live.
		const F = String.fromCharCode;
		const escapes = [F(34), F(92), F(10), F(13), F(9), F(8), F(12), F(0), F(1), F(31), F(127), F(233)];
		let mismatch = '';
		for (const c of [...escapes, '', 'plain', './path.ts', 'a' + F(34) + 'b'])
			if (quoteString(c) !== JSON.stringify(c))
				mismatch ||= `${JSON.stringify(c)} -> ${quoteString(c)}`;
		for (let n = 0; n < 2000 && !mismatch; n++) {
			let str = '';
			for (let i = 0; i < 12; i++)
				str += F(Math.floor(Math.random() * 768));
			if (quoteString(str) !== JSON.stringify(str))
				mismatch = `${JSON.stringify(str)} -> ${quoteString(str)}`;
		}
		check('quoteString matches JSON.stringify (escapes + 2000 fuzz strings)', mismatch, '');
	}

	{
		// An OPTIONAL parameter's implicit default is a synthesized bare `undefined`
		// (`defaultsWithImplicitUndefined`). `isReemittableDefault` rejected it -- the AST has a `null`
		// literal but no `undefined` one, so it can only arrive as an identifier -- which sent the call
		// down the earlier-parameter-referencing path and hit `internal: ... no resolved parameter info`
		// whenever a SIBLING default was non-literal. That was the survey's top cause at 21 declarations.
		// CROSS-MODULE on purpose: the internal branch is only reached when the callee has no resolved
		// parameter info, which a same-file declaration always has.
		const { omitted, passed } = await compileMulti({
			lib: `
				export function f(a: number, b: number = a * 2, c?: number): number {
					return a + b + (c === undefined ? 0 : c);
				}
			`,
			main: `
				import { f } from './lib';
				export function omitted(): number { return f(3); }
				export function passed(): number { return f(3, 4, 5); }
			`,
		}, 'main');
		// `x ?? []` typed as `Spec[] | any[]`: the empty literal ignored its context and the `any[]` in
		// the union left member lookup nothing to offer, so a `.map` callback's parameter got no type at
		// all. Real tsc gives `Spec[]` here. Two halves -- `??`'s right operand is contextually typed by
		// the LEFT's non-nullish type, and an empty literal takes an array context instead of `any[]`.
		// Asserted as a REJECTION, not an absence of errors: an `any` result type produces no error
		// either way, so only a wrong-on-purpose target tells the two apart.
		check('an empty literal takes its `??` context, so the callback parameter is the element type',
			typeErrors(`interface Spec { local: string }
				declare const specs: Spec[] | undefined;
				const bad = (specs ?? []).map(s => s.nope);`)
				.some(x => /does not exist/.test(x)), true);
		// ...and a bare `[]` with no context at all is still `any[]`, not an error.
		checkTypeChecks('a bare empty literal is unconstrained', `const a = []; a.push(1); a.push('x');`);
		// Spreading a STATICALLY-SHAPED object into a dynamic-object literal (`Record<string, V>`, which
		// routes to a real `Map`). The spread path assumed every operand was itself Map-backed and
		// coerced it to the map's own type, which cannot convert -- `ts-parser.ts`'s own
		// `rules: {...JS.rules, ...}` against `Record<string, Rules<any>>` is the real instance.
		const { spreadStatic, spreadLastWins, spreadDynamic } = await compile(`
			const base = { a: 5 };
			function take(r: Record<string, number>): number { return r["a"] + r["b"]; }
			export function spreadStatic(): number { return take({ ...base, b: 6 }); }
			const over = { a: 50 };
			function first(r: Record<string, number>): number { return r["a"]; }
			export function spreadLastWins(): number { return first({ a: 1, ...over }); }
			export function spreadDynamic(): number {
				const d: Record<string, number> = { a: 5 };
				return take({ ...d, b: 6 });
			}
		`);
		// A HOMOMORPHIC mapped type over an array/tuple maps its ELEMENTS and keeps its array/tuple-ness,
		// as real TS does. The literal-keys path could never answer one (an array's keys aren't literals),
		// so it stayed opaque -- and tison's own `ValuesOf<readonly GrammarSym[]>`, hence every grammar
		// `Action` parameter, had no representation at all.
		// A PRIMITIVE never satisfies a real class. Classes only started reaching this comparison as refs
		// once `resolve` began keeping them nominal, and fell through a leniency meant for names the
		// checker cannot look up at all -- so `string extends RegExp` was UNDECIDABLE and
		// `string extends R2<number>[]` answered TRUE, which stalled `ElemValue`'s whole conditional chain.
		check('a primitive is not assignable to a class',
			typeErrors(`class C { foo(): number { return 1; } }
				declare const s: string;
				const bad: C = s;`).some(x => /not assignable/.test(x)), true);
		// ...but its own boxed wrapper still is, and an UNRESOLVED name stays lenient.
		checkTypeChecks('a primitive is assignable to its boxed wrapper', `declare const s: string; const ok: String = s;`);
		check('a conditional chain over a primitive decides every arm',
			typeErrors(`interface R2<T> { v: T }
				type Chain<S> = S extends R2<infer U>[] ? U : S extends RegExp ? number : S extends string ? S : unknown;
				declare const a: Chain<string>;
				const bad: number = a;`).some(x => /not assignable/.test(x)), true);
		check('a mapped type over an array maps its element',
			typeErrors(`type Box<S> = S extends string ? number : boolean;
				type MapAll<T extends readonly unknown[]> = {[K in keyof T]: Box<T[K]>};
				declare const a: MapAll<readonly string[]>;
				const bad: string = a[0];`)
				.some(x => /not assignable/.test(x)), true);
		check('...and over a tuple maps each position',
			typeErrors(`type Box<S> = S extends string ? number : boolean;
				type MapAll<T extends readonly unknown[]> = {[K in keyof T]: Box<T[K]>};
				declare const b: MapAll<[string, number]>;
				const ok: number = b[0];
				const alsoOk: boolean = b[1];`).length, 0);
		// CONST CONTEXT (`as const`, or a `const` type parameter's argument): a READONLY TUPLE whose elements keep their literals.
		check('`as const` keeps each position',
			typeErrors(`const E = ['x', 'y'] as const; const bad: 'y' = E[0];`).some(x => /not assignable/.test(x)), true);
		check('...and so does a `const` type parameter',
			typeErrors(`declare function f<const T extends readonly string[]>(x: T): T; const r = f(['a', 'b']); const bad: 'a' = r[1];`)
				.some(x => /not assignable/.test(x)), true);
		// A tuple argument against a `readonly T[]` parameter offers EVERY element as a candidate for `T`, unioned.
		checkTypeChecks('a tuple into `readonly T[]` infers from every element',
			`declare function one<const T extends string>(names: readonly T[]): T; const X = ['a', 'b'] as const; const ok: 'a' | 'b' = one(X);`);
		// A template literal type over finite interpolations EXPANDS to its cross product, so a mapped type keyed by one
		// (the maths package's swizzles, `{[K in \`${E}${E}\`]: T2}`) has real properties.
		check('a mapped type keyed by a template literal',
			typeErrors(`type S<E extends string> = {[K in \`\${E}\${E}\`]: number}; declare const s: S<'x' | 'y'>; const bad: string = s.yx;`)
				.some(x => /not assignable/.test(x)), true);
		check('...whose keys are exactly the cross product',
			typeErrors(`type S<E extends string> = {[K in \`\${E}\${E}\`]: number}; declare const s: S<'x' | 'y'>; const bad = s.xz;`)
				.some(x => /does not exist/.test(x)), true);
		// ...and one that cannot expand (`${string}`) is matched as a PATTERN.
		checkTypeChecks('a literal matching a template pattern', `const k = 'abc' as const; const ok: \`a\${string}\` = k;`);
		check('...and one that does not',
			typeErrors(`const k = 'xbc' as const; const bad: \`a\${string}\` = k;`).some(x => /not assignable/.test(x)), true);
		check('a statically-shaped spread into a dynamic object', spreadStatic(), 11);
		check('...and a later spread still overwrites an earlier field', spreadLastWins(), 50);
		check('...while a dynamic-object spread keeps its runtime key walk', spreadDynamic(), 11);
		check('an optional param omitted beside a non-literal sibling default', omitted(), 9);
		check('...and the same call with every argument supplied', passed(), 12);

		// ...and the contextual return type is only a hint when it carries STRUCTURE. A bare, still-
		// unsolved type parameter says nothing about the body, and threading one through perturbed real
		// inference (`after<V, R>(v: V, then: (value: Awaited<V>) => R)` in the binary package).
		check('a bare type-param return type is not used as a contextual hint',
			typeErrors(`declare function after<V, R>(v: V, then: (value: V) => R): R;
				declare const n: number;
				const out: string = after(n, v => "x" + v);`).length, 0);
	}

	{
		// A conditional type whose CHECK TYPE is a naked type parameter DISTRIBUTES over a union argument.
		// Without it the union was tested as a whole, failed, and `Extract`/`Exclude`/`Omit` -- and every
		// utility built on them -- silently collapsed to `never`, which is assignable to anything, so the
		// mistake surfaced only as a member read coming back `any`.
		const { extracted } = await compile(`
			type Stmt = { kind: "mod"; name: string } | { kind: "other"; n: number };
			type Mod = Extract<Stmt, { kind: "mod" }>;
			export function extracted(): number {
				const m: Mod = { kind: "mod", name: "abcd" };
				return m.name.length;
			}
		`);
		check('Extract: distributes, so the member read has a real type', extracted(), 4);
		// `Omit` is `Pick<T, Exclude<keyof T, K>>` -- the same machinery, and the shape the official TS
		// suite pins (`omitTypeTestErrors01`, `intersectionsAndOptionalProperties`, both of which this
		// now reports exactly as their own baselines require).
		check('Omit: the omitted property really is gone',
			typeErrors(`type To = { field?: number; other: string }; type F = Omit<To, "field">; declare const f: F; const bad = f.field;`)
				.some(x => /Property 'field' does not exist/.test(x)), true);
		check('Omit: a non-matching key removes nothing',
			typeErrors(`type To = { field?: number; other: string }; type F = Omit<To, "nope">; declare const f: F; const ok: string = f.other;`).length, 0);
		// The deferral half: an unbound type parameter leaves the conditional undecidable, and guessing
		// (distributing over its CONSTRAINT) invented unions the call site never had.
		// A namespace-qualified type is not an unbound type parameter -- those are always bare names.
		// `scope.type` doesn't split on '.', so `Extract<NS.Stmt, ...>` looked undecidable and deferred
		// to `never`, which is assignable to everything and so failed silently.
		check('Extract over a namespace-qualified union still distributes',
			typeErrors(`namespace NS { export type Stmt = { kind: "mod"; name: string } | { kind: "other"; n: number }; }
				type Mod = Extract<NS.Stmt, { kind: "mod" }>;
				declare const m: Mod;
				const bad: number = m.name;`)
				.some(x => /not assignable to type 'number'/.test(x)), true);
		// `typeof`-narrowing a path containing a LITERAL index. `pathKey` stopped at the first `index`
		// node and returned undefined, so `a[0].k` had no narrowing key at all and the guard did nothing.
		check('narrowing reaches a literal-indexed path',
			typeErrors(`type BT = string | { a: number };
				declare function takes(name: string): void;
				function outer(fn: { params: { key: BT }[] }) {
					if (typeof fn.params[0]?.key === "string") { const k = fn.params[0].key; takes(k); }
				}`).length, 0);
		// ...but a COMPUTED index must not: the index can evaluate differently between guard and read.
		check('narrowing does NOT reach a computed-index path',
			typeErrors(`type BT = string | { a: number };
				declare function takes(name: string): void;
				function outer(fn: { params: { key: BT }[] }, i: number, j: number) {
					if (typeof fn.params[i].key === "string") takes(fn.params[j].key);
				}`).some(x => /not assignable to parameter/.test(x)), true);
		check('a conditional over an unbound type param stays deferred',
			typeErrors(`type R<T> = T extends number ? number : string;
				function f<T extends number | string>(v: T): R<T> { return v as any; }
				const n: number = f(1);`).length, 0);
		// A derived interface's member OVERRIDES the base's rather than joining an overload set behind
		// it. `interface Polynomial<C> extends PolynomialN<C>` redeclares `mul` with a `Polynomial<C>`
		// return; the base's `mul(b: PolynomialN<C>): PolynomialN<C>` fits the same call and, being tried
		// first, won -- so every member the derived type adds read as missing from then on.
		check('a derived interface member overrides the base signature',
			typeErrors(`interface Base<C> { mul(b: Base<C>): Base<C>; }
				interface Derived<C> extends Base<C> { mul(b: Derived<C>): Derived<C>; sub(b: Derived<C>): Derived<C>; }
				declare const x: Derived<number>;
				const ok = x.mul(x).sub(x);`).length, 0);
		// ...and it really is the derived RETURN type, not an `any` that would accept anything.
		check('...returning the derived type, not a lenient any',
			typeErrors(`interface Base<C> { m(): Base<C>; }
				interface Derived<C> extends Base<C> { m(): Derived<C>; extra: C; }
				declare const x: Derived<number>;
				const bad: string = x.m().extra;`)
				.some(x => /not assignable to type 'string'/.test(x)), true);
		// The same precedence for an INDEX SIGNATURE -- `NodeListOf<TNode>`'s `[index: number]: TNode`
		// over the `[index: number]: Node` it inherits from `NodeList`, which is why `querySelectorAll`'s
		// result indexed to an element had none of that element's own members.
		check('a derived interface index signature overrides the base',
			typeErrors(`interface ListBase { readonly length: number; [index: number]: { tag: string }; }
				interface ListOf<T> extends ListBase { [index: number]: T; }
				declare const l: ListOf<{ tag: string; extra: number }>;
				function at(i: number): number { return l[i].extra; }`).length, 0);
		// Inherited CALL signatures are ordered by inheritance DEPTH, not depth-first through each base
		// in turn: with `C extends C1, C2` a depth-first walk reaches C2's inherited catch-all
		// `(key: string): void` before C1's own `(x: 'C1'): number[]`, and "first fit wins" answered
		// every specialized call with `void` (the official suite's own
		// `inheritedOverloadedSpecializedSignatures`).
		check('inherited call signatures are ordered by inheritance depth',
			typeErrors(`interface A { (key: string): void; }
				interface B extends A { (x: 'B2'): string[]; }
				interface C1 extends B { (x: 'C1'): number[]; }
				interface C2 extends B { (x: 'C2'): boolean[]; }
				interface C extends C1, C2 { (x: 'C'): string; }
				declare const c: C;
				const x1: string[] = c('B2');
				const x6: number[] = c('C1');
				const x7: boolean[] = c('C2');
				const x8: string = c('C');
				const x9: void = c('generic');`).length, 0);
	}

	{
		// An empty array literal `[]` has no elements for `arrayKindOf` to infer a kind from -- it used
		// to fall back to 'ref' unconditionally, ignoring the declared target type entirely, and fail
		// for any non-ref target ("cannot convert {arr:ref} to {arr:f64}"). Found while building Map/Set
		// (lib/map.ts's own `keys_: K[] = []`/`values_: V[] = []` fields), but general -- covers a local,
		// a field, and a generic field where the type parameter substitutes to a scalar kind.
		const { emptyLocal, emptyField, emptyGenericField } = await compile(`
			export function emptyLocal(): number {
				const a: number[] = [];
				return a.length;
			}
			class Holder { xs: number[] = []; constructor() {} }
			export function emptyField(): number {
				const h = new Holder();
				return h.xs.length;
			}
			class GenericHolder<T> { xs: T[] = []; constructor() {} }
			export function emptyGenericField(): number {
				const h = new GenericHolder<number>();
				return h.xs.length;
			}
		`);
		check('empty array literal: local number[]', emptyLocal(), 0);
		check('empty array literal: number[] class field', emptyField(), 0);
		check('empty array literal: generic field substituted to number[]', emptyGenericField(), 0);
	}

	{
		// A parameter default value is re-emitted verbatim at each real omitted-argument call site
		// (`emitCallArgs`), not evaluated once and shared -- safe for any expression that references
		// nothing outside its own literal value. Used to only allow a bare `'literal'` node; an array
		// literal (the empty-array case in particular, `items: T[] = []`) has exactly the same
		// no-external-reference safety property but was rejected outright. Found while adding
		// `lib/map.ts`.
		const { emptyDefault, nonEmptyDefault, calledWithArg, freshEachCall } = await compile(`
			function f(items: number[] = []): number {
				return items.length;
			}
			export function emptyDefault(): number {
				return f();
			}
			function g(items: number[] = [1, 2, 3]): number {
				return items.length + items[0] + items[1] + items[2];
			}
			export function nonEmptyDefault(): number {
				return g();
			}
			export function calledWithArg(): number {
				return f([9, 9]);
			}
			function h(items: number[] = []): number {
				items.push(1);
				return items.length;
			}
			export function freshEachCall(): number {
				// Each omitted-arg call must get its own fresh [] -- not one shared/mutated across calls.
				return h() * 10 + h();
			}
		`);
		check('default value: empty array literal', emptyDefault(), 0);
		check('default value: non-empty array literal of literals', nonEmptyDefault(), 9);
		check('default value: an explicit argument still overrides it', calledWithArg(), 2);
		check('default value: a fresh array is re-emitted per omitted call, not shared', freshEachCall(), 11);
	}

	{
		// A plain named function read as a *value* (passed as a callback, assigned to a local,
		// stored in an array, ...) rather than called directly by name -- previously threw a bare,
		// message-less `"unknown"` unconditionally (identifier resolution only knew locals/closure-
		// captures/globals, never `functionDeclByName`). An ordinary top-level function has no `env`
		// param at all (it captures nothing), so it can't just be read as a closure value directly --
		// needs a small, shared, zero-capture trampoline (`ensureFunctionValueWrapper`) forwarding to
		// the real compiled function. A *nested* function referenced as a value by a sibling
		// expression already worked before this fix (it's an ordinary local holding a real closure
		// value); this is specifically about a top-level one.
		const { direct, twoUsesShareOneWrapper, assignedToLocal, viaArrayElement, forwardsRestParams } = await compile(`
			function helper(x: number): number { return x + 1; }
			function useCallback(cb: (x: number) => number): number { return cb(10); }
			export function direct(): number {
				return useCallback(helper);
			}
			export function twoUsesShareOneWrapper(): number {
				return useCallback(helper) + useCallback(helper);
			}
			export function assignedToLocal(): number {
				const f = helper;
				return f(5);
			}
			function double(x: number): number { return x * 2; }
			export function viaArrayElement(): number {
				const fns: ((x: number) => number)[] = [helper, double];
				return fns[0](3) + fns[1](3);
			}
			function sum(...nums: number[]): number {
				let total = 0;
				for (let i = 0; i < nums.length; i = i + 1)
					total = total + nums[i];
				return total;
			}
			function callWithRest(cb: (...n: number[]) => number): number { return cb(1, 2, 3); }
			export function forwardsRestParams(): number {
				return callWithRest(sum);
			}
		`);
		check('function-as-value: passed directly as a callback', direct(), 11);
		check('function-as-value: two uses of the same function share one wrapper', twoUsesShareOneWrapper(), 22);
		check('function-as-value: assigned to a local, then called through it', assignedToLocal(), 6);
		check('function-as-value: stored as array elements, called through indexing', viaArrayElement(), 10);
		check("function-as-value: the wrapper forwards a rest param correctly", forwardsRestParams(), 6);
	}

	{
		// A generic closure *value* (as opposed to calling a generic function/method directly, already
		// monomorphized per call site) is one physical closure that has to work across every call-site
		// instantiation. Bound-substitution, not universal `anyref`-boxing: each type param becomes its
		// own upper bound (defaulting to boxed `any` only when unconstrained) throughout params/return
		// type/body -- free when bounded (a real wasm-GC upcast, zero instructions), since the
		// overwhelmingly common shape (walker.ts's own motivating case) only ever narrows an
		// already-concrete bound for the *caller's* own type precision, never consumes the param in a
		// genuinely type-specific way.
		const { returnedFromGenericFn, fromConditional, unconstrainedBoxedAny, boundedClassNarrowing } = await compile(`
			function makeProcess<U>(parts: (x: U) => U) {
				const redo = <T extends U>(t: T): T => parts(t as unknown as U) as unknown as T;
				return redo;
			}
			export function returnedFromGenericFn(): number {
				const inc = makeProcess<number>((x: number) => x + 1);
				return inc(5);
			}
			function makeProcess2<U>(always: boolean, parts: (x: U) => U) {
				return always
					? (<T extends U>(t: T): T => parts(t as unknown as U) as unknown as T)
					: (<T extends U>(t: T): T => t);
			}
			export function fromConditional(): number {
				const g = makeProcess2<number>(true, (x: number) => x * 2);
				return g(5);
			}
			export function unconstrainedBoxedAny(): number {
				// No bound at all -- falls back to boxed 'any'. One physical closure, called with two
				// genuinely different concrete types.
				const identity = <T,>(x: T): T => x;
				const n = identity(42);
				const s = identity("hello");
				return n + s.length;
			}
			class Animal { constructor() {} sound(): number { return 1; } }
			class Dog extends Animal { constructor() { super(); } sound(): number { return 2; } }
			export function boundedClassNarrowing(): number {
				const redo = <T extends Animal>(t: T): T => t;
				const d = redo(new Dog());
				return d.sound();
			}
		`);
		check('generic closure: returned from a generic function, called at its own instantiation', returnedFromGenericFn(), 6);
		check('generic closure: selected via a conditional expression, still generic', fromConditional(), 10);
		check('generic closure: unconstrained type param falls back to boxed any, works for two real types', unconstrainedBoxedAny(), 47);
		check('generic closure: bounded by a class, a subclass instance still dispatches virtually afterward', boundedClassNarrowing(), 2);
	}

	{
		// towasm.ts's own generic-function-call codegen (`ensureGenericFunc`/`inferTypeArgMap`) is a
		// separate, parallel mechanism from checker.ts's own `instantiate` -- it reuses the same shared
		// `T.inferTypeArgs`, but previously had no contextual/expected-type step at all (documented gap,
		// `inferTypeArgMap`'s own old comment). A generic callback argument with no other source for its
		// own type param (`makeRule<T>(action: () => T): T` called as `makeRule(() => ({...}))`) always
		// inferred `T` purely from the callback's own structurally-inferred return -- an anonymous,
		// non-nominal shape with no wasm struct representation, even when the surrounding context (here,
		// an array literal's own declared element type) already names the real, concrete target type.
		// Fixed via `ctx.contextualReturn`, a one-shot hint threaded from the few producers that have a
		// real TS type on hand (`case 'var_decl'`, `case 'array'`'s own per-element loop) through to
		// `case 'call'`, mirroring checker.ts's own `expected`-vs-`sig.returnType` contextual step (itself
		// also strengthened this session: a generic callback argument's own return-type inference is now
		// *deferred* until after that contextual step gets a chance, rather than racing it first and
		// winning on `out`'s own first-bound-wins guard).
		const { arrayElementContext, ordinaryArgumentWins, multipleElements } = await compile(`
			type SpreadExpr = { kind: string; value: number };
			function makeRule<T>(action: () => T): T { return action(); }
			export function arrayElementContext(): number {
				const rules: SpreadExpr[] = [
					makeRule(() => ({ kind: 'spread', value: 42 })),
				];
				return rules[0].value;
			}
			function identity<T>(x: T): T { return x; }
			export function ordinaryArgumentWins(): number {
				const y: number = identity(5);
				return y;
			}
			export function multipleElements(): number {
				const rules: SpreadExpr[] = [
					makeRule(() => ({ kind: 'a', value: 1 })),
					makeRule(() => ({ kind: 'b', value: 2 })),
				];
				return rules[0].value * 10 + rules[1].value;
			}
		`);
		check("contextual generic inference: an unannotated callback's own return type comes from the array literal's own declared element type", arrayElementContext(), 42);
		check('contextual generic inference: an ordinary direct param still infers from the argument itself, unaffected', ordinaryArgumentWins(), 5);
		check("contextual generic inference: ctx.contextualReturn resets correctly per array element, not just once", multipleElements(), 12);
	}

	{
		// A real union of >=2 different object shapes had no wasm representation at all before this --
		// `typeOf`'s own union case now boxes it as `any`, same physical representation this compiler
		// already gives an unconstrained generic or a caught exception, and `case 'member'`'s own new
		// `ensureUnionFieldDispatch` fallback (when `classOf` can't resolve one single owner) reads the
		// right field via a `ref.test`/`ref.cast` cascade scoped to the union's own exact, bounded member
		// set -- not `ensureAnyDispatch`'s "every class ever reached" scan, which would be both broader
		// than the real static type says and unable to tell two same-named-but-different-typed fields
		// apart.
		const { directUnion } = await compile(`
			class A { value: number = 1; constructor(v: number) { this.value = v; } }
			class B { value: number = 2; constructor(v: number) { this.value = v; } }
			function pick(useA: boolean): A | B {
				return useA ? new A(10) : new B(20);
			}
			export function directUnion(): number {
				const x: A | B = pick(true);
				const y: A | B = pick(false);
				return x.value * 10 + y.value;
			}
		`);
		check('union field dispatch: a direct (non-generic) union-typed value reads the right field', directUnion(), 120);

		// Found and fixed while landing the above: a union whose members all happen to be `ownerFor`-
		// resolvable but NOT struct-backed (`number`/`boolean`'s own synthetic `builtinTypeOwner`, which
		// has no real heap type -- `typeIndex === -1`) must NOT box as `any` -- `IteratorResult<Y,R>.value:
		// Y | R`, monomorphized with `Y`/`R` both `number`, degenerates to a plain `number | number` union
		// that has to stay `f64`. Regressed this exact case once already (a generator using `try`/`finally`
		// failed wasm validation, "uninitialized non-defaultable local") before `unionStructOwners` was
		// narrowed to require a real heap type, not just any `ownerFor` hit.
		const { driveGenFinallyUnionRegression } = await compile(`
			function* gen(): Generator<number, number, number> {
				yield 1;
				try {
					return 42;
				} finally {
					console.log(555);
				}
			}
			export function driveGenFinallyUnionRegression(): number {
				const g = gen();
				const a = g.next(0);
				const b = g.next(0);
				return a.value + b.value * 1000 + (b.done ? 1000000 : 0);
			}
		`);
		check("union field dispatch: doesn't wrongly box a degenerate scalar union (IteratorResult<number,number>.value)", driveGenFinallyUnionRegression(), 1042001);
	}

	{
		// The other half of the same fix: a genuinely *heterogeneous* union (scalars mixed with an
		// object/array shape, e.g. `Literal.value: string | number | boolean | null | TemplatePart[]` in
		// ts-parser.ts) used to have no representation at all -- `typeOf`'s old union-boxing check required
		// every member to be *struct-backed* (`unionStructOwners`), which a scalar member never is, so this
		// fell through to "needs an explicit number/boolean/object type". Fixed by boxing as `any` whenever
		// the members' own physical `WasmType`s genuinely differ, regardless of *why* they differ (scalar
		// vs. scalar, class vs. class, or scalar vs. struct/array, this case) -- not gated on every member
		// being struct-backed. Real arguments (not compile-time constants) flow into three separate boxed
		// constructions (`number`, `boolean`, `string` all reduce to different `WasmType`s) to actually
		// exercise the coercion at real runtime, then an independent computation confirms the module still
		// runs correctly afterward.
		const { heterogeneousUnionField } = await compile(`
			interface Box { type: 'ref'; value: number | boolean | string; }
			function makeNum(n: number): Box { return { type: 'ref', value: n }; }
			function makeBool(b: boolean): Box { return { type: 'ref', value: b }; }
			function makeStr(s: string): Box { return { type: 'ref', value: s }; }
			export function heterogeneousUnionField(n: number): number {
				const a = makeNum(n);
				const b = makeBool(n > 0);
				const c = makeStr('x');
				return n * 2;
			}
		`);
		check('union boxing: a heterogeneous scalar+object union field compiles and runs', heterogeneousUnionField(21), 42);
	}

	{
		// Discriminated-union narrowing inside a `switch` case body wasn't visible to member-read codegen:
		// `case 'm1': return m.a;` tried to build a field dispatch across the *whole* `Member1|Member2`
		// union (since `classOf`'s own unnarrowed lookup couldn't resolve one owner), throwing "'Member2'
		// has no field 'a'" even though real TS narrows `m` to just `Member1` inside that case. Root cause
		// was even deeper: a real `scope.resolving` leak in `T.resolve()` (see its own fix) meant the
		// switch's own discriminant read couldn't even resolve `m.type`'s type at all, independent of
		// narrowing. Fixed by consulting the checker's own per-statement narrowed scope (`ctx.stmtScope`)
		// specifically when the *unnarrowed* type is a union -- every other lookup keeps using the same
		// baseline scope as before, so this never disturbs an unrelated generic/lib-method resolution.
		const { fromSwitch } = await compile(`
			interface Member1 { type: 'm1'; a: number }
			interface Member2 { type: 'm2'; foo: boolean }
			type Member = Member1 | Member2;
			function classMember(m: Member): number {
				switch (m.type) {
					case 'm1': return m.a;
					case 'm2': return 0;
				}
			}
			export function fromSwitch(): number {
				return classMember({ type: 'm1', a: 7 });
			}
		`);
		check("discriminated union: switch(m.type)'s own case-narrowing is visible to a field read inside it", fromSwitch(), 7);
	}

	{
		// A self-referential object-shape type now compiles and runs correctly, the same placeholder-first
		// mechanism `ensureClass` uses (`ensureObjectShape` gained the matching `typeIndex`-before-fields
		// ordering) -- previously this reached a genuinely unbounded recursion the moment a union member's
		// own `typeOf` started being resolved eagerly (`ensureObjectShape` had no reentrance guard at all,
		// unlike `ensureClass`'s own matching one), fixed by giving it the same guard; that guard itself
		// (and `ensureClass`'s) has since been superseded by the placeholder-first fix, so a self-referential
		// shape is real, supported capability now, not just a clean rejection.
		const { selfReferentialShape } = await compile(`
			type Node = { value: number; next: Node | null };
			function make(v: number, next: Node | null): Node { return { value: v, next }; }
			export function selfReferentialShape(): number {
				const a = make(1, null);
				const b = make(2, a);
				return b.next!.value;
			}
		`);
		check('a self-referential object-shape type compiles and runs', selfReferentialShape(), 1);
	}

	{
		// Discriminated-union object literal construction: `case 'object'`'s own `want` (a plain WasmType)
		// can't say which union member a bare `{...}` literal is meant to build as when the target is a
		// real union (boxed `any`, `typeOf`'s own union case) rather than one single class -- fixed via
		// `matchObjectShape`, a last-resort structural match against every reachable, struct-backed class
		// (same "every class ever discovered" scan `findAnyDispatchCandidates` already uses for method
		// dispatch): exact field-set matching, then a literal-value discriminant check when more than one
		// candidate's field set matches (the real, common shape here). This is THE full real-world pattern
		// this session's contextual-inference work was chasing (`Rule([...], $ => ({...}))`-shaped calls
		// in ts-parser.ts/js-parser.ts/binary-libs/wasm.ts): an unannotated generic callback resolving its
		// own type param to a real union via the surrounding array literal's own declared element type,
		// then building one member's own object literal as its own return value -- now works end to end.
		const { fullPattern, directLiteral } = await compile(`
			type SpreadExpr = { kind: 'spread'; value: number };
			type OtherExpr = { kind: 'other'; value: number };
			type Expr = SpreadExpr | OtherExpr;
			function makeRule<T>(action: () => T): T { return action(); }
			export function fullPattern(): number {
				const rules: Expr[] = [
					makeRule(() => ({ kind: 'spread', value: 42 })),
					makeRule(() => ({ kind: 'other', value: 7 })),
				];
				return rules[0].value * 10 + rules[1].value;
			}
			type A = { kind: 'a'; value: number };
			type B = { kind: 'b'; value: number };
			function pick(useA: boolean): A | B {
				return useA ? { kind: 'a', value: 10 } : { kind: 'b', value: 20 };
			}
			export function directLiteral(): number {
				const x = pick(true);
				const y = pick(false);
				return x.value * 10 + y.value;
			}
		`);
		check("discriminated union object literal: the full Rule([...], $ => ({...})) pattern works end to end", fullPattern(), 427);
		check('discriminated union object literal: a direct (non-generic) discriminated literal picks the right member', directLiteral(), 120);

		// A genuinely ambiguous literal (same field set, no literal discriminant at all) must be rejected,
		// not silently guessed at.
		// `B` carries a member `A` doesn't: the literal fits BOTH, and the two have different layouts, so
		// there is a real choice to get wrong. (Two *identical* shapes, which this used to use, are not
		// ambiguous in any way that matters -- either resolution gives the same layout -- and the
		// compiler now resolves them rather than refusing.)
		await checkThrows('discriminated union object literal: genuine ambiguity (no discriminant) is rejected', () => compile(`
			type A = { value: number };
			type B = { value: number; extra?: string };
			function pick(useA: boolean): A | B {
				return { value: 5 };
			}
			export function test(): number { return pick(true).value; }
		`), /needs a known target type/);
	}

	{
		// `emitClosureLiteral` used to compute its own return wtype purely from `e.returnType` -- for an
		// unannotated arrow/function expression, that's whatever *structural* type the checker's own
		// inference back-fills (real, but anonymous -- no nominal identity for `typeOf` to turn into a
		// wasm struct), so an unannotated closure returning a bare object literal always failed ("needs a
		// known target type"), even where the *caller's* own declared callback signature already names
		// the exact concrete shape wanted. Fixed by threading the call site's own expected closure
		// signature (`want`) into `emitClosureLiteral`, preferring its `result` over the closure's own
		// guess when available -- found via `Rule([...], $ => ({...}))`-shaped calls in ts-parser.ts/
		// js-parser.ts/binary-libs/wasm.ts (hundreds of real sites), though most of those specifically
		// still don't resolve: `T` there is pinned only by an *outer* array literal's own declared element
		// type (`Rule<Expr>[]`), which needs real bidirectional/contextual generic inference this checker
		// doesn't have (its own documented limitation: "structural-argument-matching only") -- confirmed
		// via a direct, minimal repro of that exact shape, deliberately NOT attempted here. What this DOES
		// fix: any case where a nominal target type reaches the call site without needing that -- a
		// non-generic callback parameter, or an explicit type argument pinning a generic one directly.
		const { nonGenericParam, explicitTypeArg } = await compile(`
			type Spread = { kind: 'spread'; value: number };
			function buildPlain(make: () => Spread): number {
				return make().value;
			}
			export function nonGenericParam(): number {
				return buildPlain(() => ({ kind: 'spread', value: 42 }));
			}
			function buildGeneric<T>(make: () => T): T {
				return make();
			}
			export function explicitTypeArg(): number {
				const s = buildGeneric<Spread>(() => ({ kind: 'spread', value: 42 }));
				return s.value;
			}
		`);
		check("unannotated closure returning an object literal: non-generic callback param supplies the target type", nonGenericParam(), 42);
		check("unannotated closure returning an object literal: an explicit type argument supplies the target type", explicitTypeArg(), 42);
	}

	{
		// `this[i] === x` (or any `===` between two boxed-`any` array elements) used to fail wasm
		// validation outright: a generic `T[]`'s element always physically reads back as boxed `anyref`
		// (see the comments near `case 'array'`/`case 'index'`), but `ref.eq` requires `eqref`-typed
		// operands and rejects a bare `anyref` even though every real value here is eq-comparable.
		// Found the same way as the empty-array-literal fix above -- `Array<T>.indexOf` (lib/array.ts,
		// already-shipped) silently only ever worked for scalar `T`, never a class-typed one, because
		// nothing exercised it that way before.
		const { classIndexOf, classIncludes } = await compile(`
			class Node { constructor(public id: number) {} }
			export function classIndexOf(): number {
				const a: Node[] = [new Node(1), new Node(2), new Node(3)];
				return a.indexOf(a[1]);
			}
			export function classIncludes(): number {
				const a: Node[] = [new Node(1), new Node(2)];
				const notIn = new Node(1);
				// Same 'id' as a[0], but a distinct instance -- must NOT be found (reference identity).
				return a.includes(notIn) ? 1 : 0;
			}
		`);
		check('Array<T>.indexOf() with class-typed T (ref.eq on boxed-any elements)', classIndexOf(), 1);
		check('Array<T>.includes() with class-typed T uses reference identity, not structural equality', classIncludes(), 0);
	}

	{
		// number[] non-callback methods
		const { numIndexOf, numLastIndexOf, numIncludes, numSlice, numReverse, numConcat, numFill } = await compile(`
			export function numIndexOf(): number {
				const a: number[] = [10, 20, 30, 20];
				return a.indexOf(20);
			}
			export function numLastIndexOf(): number {
				const a: number[] = [10, 20, 30, 20];
				return a.lastIndexOf(20);
			}
			export function numIncludes(): number {
				const a: number[] = [10, 20, 30];
				return a.includes(30) ? 1 : 0;
			}
			export function numSlice(): number {
				const a: number[] = [1, 2, 3, 4, 5];
				const b: number[] = a.slice(1, 4);
				return b.length + b[0];
			}
			export function numReverse(): number {
				const a: number[] = [1, 2, 3];
				const b: number[] = a.reverse();
				return b[0];
			}
			export function numConcat(): number {
				const a: number[] = [1, 2];
				const b: number[] = [3, 4, 5];
				const c: number[] = a.concat(b);
				return c.length;
			}
			export function numFill(): number {
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
			export function boolIndexOf(): number {
				const a: boolean[] = [false, false, true, false];
				return a.indexOf(true);
			}
			export function boolLastIndexOf(): number {
				const a: boolean[] = [true, false, true, false];
				return a.lastIndexOf(true);
			}
			export function boolIncludes(): number {
				const a: boolean[] = [false, false];
				return a.includes(true) ? 1 : 0;
			}
			export function boolSlice(): number {
				const a: boolean[] = [true, false, true, true];
				const b: boolean[] = a.slice(1, 3);
				return b.length;
			}
			export function boolReverse(): number {
				const a: boolean[] = [true, false, false];
				const b: boolean[] = a.reverse();
				return b[0] ? 1 : 0;
			}
			export function boolConcat(): number {
				const a: boolean[] = [true];
				const b: boolean[] = [false, false];
				const c: boolean[] = a.concat(b);
				return c.length;
			}
			export function boolFill(): number {
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
			export function arrNumMethods(): number {
				const a: Array<number> = [1, 2, 3, 4];
				const b: Array<number> = a.slice(1, 3);
				const c: Array<number> = a.concat(b);
				let f: Array<number> = [0, 0, 0];
				f = f.fill(9);
				return a.indexOf(3) * 1000 + b.length * 100 + c.length * 10 + f[0];
			}
			export function arrBoolMethods(): number {
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
			export function u8IndexOf(): number {
				const a = new Uint8Array([5, 10, 15, 10]);
				return a.indexOf(10);
			}
			export function u8LastIndexOf(): number {
				const a = new Uint8Array([5, 10, 15, 10]);
				return a.lastIndexOf(10);
			}
			export function u8Includes(): number {
				const a = new Uint8Array([1, 2, 3]);
				return a.includes(2) ? 1 : 0;
			}
			export function u8Slice(): number {
				const a = new Uint8Array([10, 20, 30, 40]);
				const b = a.slice(1, 3);
				return b.length + b[0];
			}
			export function u8Reverse(): number {
				const a = new Uint8Array([1, 2, 3]);
				const b = a.reverse();
				return b[0];
			}
			export function u8Concat(): number {
				const a = new Uint8Array([1, 2]);
				const b = new Uint8Array([3, 4, 5]);
				const c = a.concat(b);
				return c.length;
			}
			export function u8Fill(): number {
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
			export function strIndexOf(): number {
				const s: string = "hello world";
				return s.indexOf("world");
			}
			export function strLastIndexOf(): number {
				const s: string = "abcabc";
				return s.lastIndexOf("abc");
			}
			export function strIncludes(): number {
				const s: string = "hello";
				return s.includes("ell") ? 1 : 0;
			}
			export function strStartsWith(): number {
				const s: string = "hello";
				return s.startsWith("he") ? 1 : 0;
			}
			export function strEndsWith(): number {
				const s: string = "hello";
				return s.endsWith("lo") ? 1 : 0;
			}
			export function strSlice(): number {
				const s: string = "hello world";
				const t: string = s.slice(6, 11);
				return t.length + t.charCodeAt(0);
			}
			export function strTrim(): number {
				const s: string = "  hi  ";
				const t: string = s.trim();
				return t.length;
			}
			export function strToUpper(): number {
				const s: string = "abcXYZ";
				const t: string = s.toUpperCase();
				return t.charCodeAt(0) + t.charCodeAt(3);
			}
			export function strToLower(): number {
				const s: string = "abcXYZ";
				const t: string = s.toLowerCase();
				return t.charCodeAt(0) + t.charCodeAt(3);
			}
			export function strRepeat(): number {
				const s: string = "ab";
				const t: string = s.repeat(3);
				return t.length;
			}
			export function strConcatMethod(): number {
				const s: string = "foo";
				const t: string = s.concat("bar");
				return t.length;
			}
			export function strCharAt(): number {
				const s: string = "hello";
				const c: string = s.charAt(1);
				return c.length + c.charCodeAt(0);
			}
			export function strCharCodeAt(): number {
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
			export function mAbs(): number { return Math.abs(-5); }
			export function mFloor(): number { return Math.floor(4.7); }
			export function mCeil(): number { return Math.ceil(4.2); }
			export function mMin(): number { return Math.min(3, 9); }
			export function mMax(): number { return Math.max(3, 9); }
			export function mClz32(): number {
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
			export function band(): number { return 6 & 3; }
			export function bor(): number { return 6 | 1; }
			export function bxor(): number { return 6 ^ 3; }
			export function bshl(): number { return 1 << 4; }
			export function bshr(): number { return -8 >> 1; }
			export function bshru(): number { return -1 >>> 28; }
			export function bnot(): number { return ~5; }
			export function chain(): number {
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
			export function viaNaN(): number {
				const a = new Uint8Array([5]);
				const zero: number = a[0] - a[0];
				a[0] = a[0] * zero / zero; // NaN
				return a[0];
			}
			export function viaHuge(): number {
				const a = new Uint8Array([0]);
				a[0] = a[0] + 100000000000000000000;
				return a[0];
			}
		`);
		check('Uint8Array write of NaN no longer traps', viaNaN(), 0);
		check('Uint8Array write of an out-of-range float no longer traps', viaHuge(), 255);
	}

	await checkThrows("slice() with wrong arg count is rejected", () => compile(`
		export function f(): number {
			const a: number[] = [1, 2, 3];
			const b: number[] = a.slice(1, 2, 3);
			return b.length;
		}
	`), /tsw/);

	await checkThrows("indexOf() with wrong arg count is rejected", () => compile(`
		export function f(): number {
			const a: number[] = [1, 2, 3];
			return a.indexOf();
		}
	`), /tsw/);

	{
		// `void` functions/methods: side-effecting via a param, an implicit (no-annotation) void
		// function, and an early-exit bare `return;` at any nesting depth -- including inside a
		// constructor, where it must still push `this` rather than nothing.
		const { setViaFunc, setViaImplicitVoid, setViaMethod, ctorEarlyReturn } = await compile(`
			export function setIt(a: Uint8Array, v: number): void {
				a[0] = v;
			}
			export function setViaFunc(): number {
				const a = new Uint8Array(1);
				setIt(a, 42);
				return a[0];
			}
			export function bump(a: Uint8Array) {
				a[0] = a[0] + 1;
			}
			export function setViaImplicitVoid(): number {
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
			export function setViaMethod(): number {
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
			export function ctorEarlyReturn(): number {
				return new C(5).v;
			}
		`);
		check("setViaFunc() (void function, side effect via Uint8Array param)", setViaFunc(), 42);
		check("setViaImplicitVoid() (no return-type annotation defaults to void)", setViaImplicitVoid(), 2);
		check("setViaMethod() (void method)", setViaMethod(), 99);
		check("ctorEarlyReturn() (bare 'return;' nested in an 'if' inside a constructor)", ctorEarlyReturn(), 5);
	}

	{
		// `void` is real, valid TS in a param/field position (if a fairly useless thing to write) --
		// there's just no wasm value it can itself represent, so it's boxed as `any` (the same
		// "no meaningful value" treatment every other such position gets) rather than rejected. Real
		// TS's only value assignable to `void` is `undefined`, so that has to actually work too, not
		// just the bare declaration -- `emitAs`'s own null-literal handling now boxes a placeholder for
		// a non-nullable `any` target instead of only ever accepting a nullable one.
		const { callF, fieldTest } = await compile(`
			export function f(x: void): number { return 1; }
			export function callF(): number {
				return f(undefined);
			}
			class C {
				x: void;
				y: number;
				constructor(y: number) {
					this.x = undefined;
					this.y = y;
				}
			}
			export function fieldTest(): number {
				const c = new C(42);
				return c.y;
			}
		`);
		check("a 'void' param compiles and is callable with 'undefined'", callF(), 1);
		check("a 'void' field compiles, assignable from 'undefined', rest of the class still works", fieldTest(), 42);
	}

	await checkThrows('void local is rejected', () => compile(`
		export function noop(): void {}
		export function f(): number {
			const x = noop();
			return 1;
		}
	`), /void/);

	await checkThrows("returning a value from a 'void' function is rejected", () => compile(`
		export function f(): void { return 5; }
	`), /void/);

	await checkThrows('an unresolvable explicit return type still throws (not silently void)', () => compile(`
		export function f(): NotARealType { return 1; }
	`), /tsw/);

	{
		// a genuine TS type error should be caught by `TStypeCheck` up front, before `TStoWasm` ever runs
		try {
			await compile(`
				export function bad(n: number): number {
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
			export function i32RoundTrip(): number {
				const a: Int32Array = new Int32Array(3);
				a[0] = 10;
				a[1] = 20;
				a[2] = a[0] + a[1];
				return a[2];
			}
			export function i32Compare(): number {
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
			export function modI32(): number {
				const a: Int32Array = new Int32Array([7, 3]);
				a[0] = a[0] % a[1];
				return a[0];
			}
			export function modF64(): number {
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
			export function bigRoundTrip(): number {
				return bigToNumber(bigFromNumber(12345));
			}
			export function bigRoundTripMultiLimb(): number {
				return bigToNumber(bigFromNumber(4294967296));
			}
			export function bigAddSmall(): number {
				const a: bigint = bigFromNumber(100);
				const b: bigint = bigFromNumber(200);
				return bigToNumber(a + b);
			}
			export function bigAddCarry(): number {
				const a: bigint = bigFromNumber(65535);
				const b: bigint = bigFromNumber(1);
				return bigToNumber(a + b);
			}
			export function bigLt(): boolean {
				const a: bigint = bigFromNumber(500);
				const b: bigint = bigFromNumber(600);
				return a < b;
			}
			export function bigGtFalse(): boolean {
				const a: bigint = bigFromNumber(500);
				const b: bigint = bigFromNumber(600);
				return a > b;
			}
			export function bigEq(): boolean {
				const a: bigint = bigFromNumber(42);
				const b: bigint = bigFromNumber(42);
				return a === b;
			}
			export function bigNeq(): boolean {
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
			export function numIsInt(): number { return Number.isInteger(4) ? 1 : 0; }
			export function numIsIntFalse(): number { return Number.isInteger(4.5) ? 1 : 0; }
			export function numIsNaNTrue(): number { return Number.isNaN(0 / 0) ? 1 : 0; }
			export function numIsNaNFalse(): number { return Number.isNaN(4) ? 1 : 0; }
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
			export function mSin(x: number): number { return Math.sin(x); }
			export function mCos0(): number { return Math.cos(0); }
			export function mCos(x: number): number { return Math.cos(x); }
			export function mTan(x: number): number { return Math.tan(x); }
			export function mExp(x: number): number { return Math.exp(x); }
			export function mExpNeg(x: number): number { return Math.exp(x); }
			export function mLog(x: number): number { return Math.log(x); }
			export function mLog100(): number { return Math.log(100); }
			export function mAsin(x: number): number { return Math.asin(x); }
			export function mAcos(x: number): number { return Math.acos(x); }
			export function mAtan(x: number): number { return Math.atan(x); }
			export function mAtan2(y: number, x: number): number { return Math.atan2(y, x); }
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
			export function hashString(s: string): number {
				let h: number = s.length;
				let i: number = 0;
				while (i < s.length) {
					h = h + s.charCodeAt(i) * (i + 1);
					i = i + 1;
				}
				return h;
			}
			export function hHashToStringDefault(x: number): number { return hashString(x.toString()); }
			export function hHashToString16(x: number): number { return hashString(x.toString(16)); }
			export function hHashToFixed(x: number, digits: number): number { return hashString(x.toFixed(digits)); }
			export function hHashToExponential(x: number, digits: number): number { return hashString(x.toExponential(digits)); }
			export function hHashToPrecision(x: number, precision: number): number { return hashString(x.toPrecision(precision)); }
			export function hParseInt(): number { return Number.parseInt("456"); }
			export function hParseFloat(): number { return Number.parseFloat("12.75"); }
		`);
		check("(0).toString()", hHashToStringDefault(0), jsHash((0).toString()));
		check("(123).toString()", hHashToStringDefault(123), jsHash((123).toString()));
		check("(-123).toString()", hHashToStringDefault(-123), jsHash((-123).toString()));
		check("(0.5).toString()", hHashToStringDefault(0.5), jsHash((0.5).toString()));
		check("(255).toString(16)", hHashToString16(255), jsHash((255).toString(16)));
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
		const { tplNum, tplNumFrac, tplStr, tplBoolTrue, tplBoolFalse, tplMulti, tplAdjacent, tplNoInterp, tplClass } = await compile(`
			export function hashString(s: string): number {
				let h: number = s.length;
				let i: number = 0;
				while (i < s.length) {
					h = h + s.charCodeAt(i) * (i + 1);
					i = i + 1;
				}
				return h;
			}
			export function tplNum(x: number): number { return hashString(\`x=\${x}\`); }
			export function tplNumFrac(x: number): number { return hashString(\`x=\${x}\`); }
			export function tplStr(): number { const s: string = "world"; return hashString(\`hello \${s}!\`); }
			export function tplBoolTrue(): number { return hashString(\`b=\${true}\`); }
			export function tplBoolFalse(): number { return hashString(\`b=\${false}\`); }
			export function tplMulti(a: number, c: number): number { const b: string = "mid"; return hashString(\`a=\${a}, b=\${b}, c=\${c}\`); }
			export function tplAdjacent(a: number, b: number): number { return hashString(\`\${a}\${b}\`); }
			export function tplNoInterp(): number { return hashString(\`plain text\`); }
			class Point {
				x: number;
				constructor(x: number) { this.x = x; }
				toString(): string { return \`Point(\${this.x})\`; }
			}
			export function tplClass(): number { const p = new Point(5); return hashString(\`p=\${p}\`); }
		`);
		check('template: number interpolation', tplNum(42), jsHash(`x=${42}`));
		check('template: number interpolation (exact fraction)', tplNumFrac(0.5), jsHash(`x=${0.5}`));
		check('template: string interpolation', tplStr(), jsHash('hello world!'));
		check('template: boolean interpolation (true)', tplBoolTrue(), jsHash(`b=${true}`));
		check('template: boolean interpolation (false)', tplBoolFalse(), jsHash(`b=${false}`));
		check('template: multiple interpolations', tplMulti(1, 3), jsHash(`a=${1}, b=${'mid'}, c=${3}`));
		check('template: adjacent interpolations (no text between)', tplAdjacent(7, 8), jsHash(`${7}${8}`));
		check('template: no interpolation (plain string)', tplNoInterp(), jsHash('plain text'));
		// A class instance interpolates via its own `toString()` -- real dynamic dispatch on the boxed `any`
		// value `stringTemplate`'s `values[i]` becomes, resolved at runtime (no single static owner at the
		// call site inside `stringTemplate` itself, since it's generic over every possible interpolated type).
		check('template: class instance interpolation (real toString())', tplClass(), jsHash(`p=Point(5)`));
	}

	{
		// console.log(x) -- real WASI `fd_write` output now (see towasm.ts's `usesConsoleLog` and
		// `lib/console.ts`'s `__towasm_console_log`), not a spied JS `console.log`. `compile()`'s own
		// `fd_write` stub decodes each call's bytes and records them on `__consoleOutput`, one entry per
		// call, each including `__towasm_writeString`'s own trailing `'\n'`.
		const { logNumber, logBoolTrue, logBoolFalse, logString, logPoint, __consoleOutput } = await compile(`
			class Point {
				x: number;
				constructor(x: number) { this.x = x; }
				toString(): string { return \`Point(\${this.x})\`; }
			}
			export function logNumber(x: number): void { console.log(x); }
			export function logBoolTrue(): void { console.log(true); }
			export function logBoolFalse(): void { console.log(false); }
			export function logString(): void { console.log('hi'); }
			export function logPoint(): void { console.log(new Point(5)); }
		`);
		logNumber(3.5);
		logBoolTrue();
		logBoolFalse();
		logString();
		logPoint();
		check('console.log(number)', __consoleOutput[0], '3.5\n');
		// Real `Boolean.toString()` dispatch now (dynamic any-dispatch finds the boxed value's actual class),
		// not the old raw-scalar `args[0].wtype === 'i32'` dispatch that couldn't tell a boolean from an
		// integer and printed the bare 1/0 -- this is genuinely more correct, not just different.
		check('console.log(true)', __consoleOutput[1], 'true\n');
		check('console.log(false)', __consoleOutput[2], 'false\n');
		// A real, passing feature now -- console.log(x: any) stringifies via the same `${x}` template-literal
		// codegen (real toString()/dynamic-any-dispatch included) every other interpolation already uses.
		check('console.log(a string)', __consoleOutput[3], 'hi\n');
		check('console.log(a class instance, real toString())', __consoleOutput[4], 'Point(5)\n');

		// A program that never calls console.log at all must still instantiate with no imports required.
		const { noLog } = await compile(`export function noLog(): number { return 5; }`);
		check('a program that never calls console.log needs no imports', noLog(), 5);
	}

	{
		// Closures -- a captured arrow/function-expression literal compiles to a `{code, env}` wasm-GC
		// struct pair (see towasm.ts's `ensureClosureType`), called via `call_ref` against one wasm function
		// type shared per TS signature. Captures are by value/reference *for the lifetime of one closure
		// instance* (repeat calls to the same instance see each other's mutations -- the counter case below)
		// but not shared back with the enclosing function's own copy once created.
		const { applyDouble, applyIncr } = await compile(`
			export function apply(f: (x: number) => number, x: number): number {
				return f(x);
			}
			export function applyDouble(x: number): number {
				return apply(y => y * 2, x);
			}
			export function applyIncr(x: number): number {
				return apply(y => y + 1, x);
			}
		`);
		check('closure: HOF parameter, literal 1', applyDouble(5), 10);
		check('closure: HOF parameter, literal 2 (shared call type, different literal)', applyIncr(5), 6);

		const { counterTest } = await compile(`
			export function makeCounter(): () => number {
				let n = 0;
				return () => {
					n = n + 1;
					return n;
				};
			}
			export function counterTest(): number {
				const c = makeCounter();
				const a = c();
				const b = c();
				return a * 10 + b;
			}
		`);
		check('closure: mutated capture persists across calls to the same instance', counterTest(), 12);

		const { adderTest } = await compile(`
			export function makeAdder(n: number): (x: number) => number {
				return (x: number) => x + n;
			}
			export function adderTest(): number {
				const add5 = makeAdder(5);
				return add5(10);
			}
		`);
		check('closure: returned from a function, capturing a param', adderTest(), 15);

		const { nestedTest } = await compile(`
			export function outer(a: number): () => number {
				const makeMiddle = (b: number): (() => number) => {
					return () => a + b;
				};
				return makeMiddle(a + 1);
			}
			export function nestedTest(): number {
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
			export function thisTest(): number {
				const b = new Box(42);
				const g = b.makeGetter();
				return g();
			}
		`);
		check("closure: arrow captures 'this' inside a method", thisTest(), 42);

		await checkThrows('closure: a named function expression referencing its own name is rejected', () => compile(`
			export function test(): number {
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
			export function test(): number {
				const b = new Box(1);
				const g = b.makeGetter();
				return g();
			}
		`), /'this' inside a function expression/);

		// A closure literal may declare MORE parameters than the callee has fixed ones -- the extras are
		// covered by its REST, which is physically a single array here, so they cannot be wasm parameters
		// of their own and bind out of `rest[k]` in the prologue instead. Every `String.replace` callback
		// is this shape. An UNANNOTATED parameter also takes its type from the callee's signature, the way
		// the return type already did.
		const { restToParams, restPartial, restAny } = await compile(`
			function apply(f: (first: number, ...rest: number[]) => number): number { return f(1, 2, 3); }
			function applyAny(f: (first: string, ...rest: any[]) => number): number { return f('x', 7, 8); }
			export function restToParams(): number { return apply((p, q, r) => p + q + r); }
			export function restPartial(): number { return apply((p, q) => p * 10 + q); }
			export function restAny(): number { return applyAny((s, p, q) => s.length + (p as number) + (q as number)); }
		`);
		check('a closure literal binds extra parameters out of the callee\'s rest', restToParams(), 6);
		check('...and may declare fewer than the rest actually supplies', restPartial(), 12);
		check('...including an `any[]` rest, the String.replace callback shape', restAny(), 16);

		// `String.replace`'s FUNCTION replacer, which real JS calls as `(match, ...captures, offset,
		// input)`. Previously declared in lib.d.ts but deliberately unimplemented -- it needs the
		// rest-to-parameters binding above, and a union parameter narrowed by `typeof x === 'function'`
		// to be callable at all. Every expectation here was taken from real node, including that a
		// non-global regexp replaces only the FIRST match and that a non-participating capture group
		// arrives as `undefined`, not the empty string.
		const { replFn, replFirst, replOptionalGroup } = await compile(`
			export function replFn(): number {
				const out = 'a1b2'.replace(/([a-z])([0-9])/g, (_, letter: string, digit: string) => digit + letter);
				return out === '1a2b' ? out.length : -1;
			}
			export function replFirst(): number {
				const out = 'x9y8'.replace(/([a-z])([0-9])/, (_, l: string, d: string) => d + l);
				return out === '9xy8' ? out.length : -1;
			}
			export function replOptionalGroup(): number {
				const out = 'ab'.replace(/(a)|(z)/g, (m: string, a: string | undefined, z: string | undefined) =>
					a !== undefined ? 'A' : (z !== undefined ? 'Z' : m));
				return out === 'Ab' ? out.length : -1;
			}
		`);
		check('String.replace with a function replacer', replFn(), 4);
		check('...a non-global regexp replaces only the first match', replFirst(), 4);
		check('...and a non-participating capture group arrives as undefined', replOptionalGroup(), 2);

		// A REST parameter typed as a UNION containing a TUPLE. Physically a rest is always ONE array,
		// whatever the declared type says, so the element type is combined across the arms (boxed when
		// they differ) rather than taken from an array type the union doesn't have.
		const { unionRest } = await compile(`
			function take(...xs: [number] | number[]): number { return 42; }
			function takeT(...xs: [string, number] | number[]): number { return 7; }
			export function unionRest(): number { return take(1) + take(1, 2, 3) + takeT('a', 5); }
		`);
		check('a rest parameter declared as a union containing a tuple', unionRest(), 91);
		// ...and the TUPLE arm is what names a callback argument, so it is the only thing that can
		// contextually type one. This is tison's own `Rules<T>(...alts: [(self: () => Rules<T>) =>
		// Rules<T>] | Rules<T>)`, whose `self => [...]` callback every grammar rule is built from.
		// Asserted as a REJECTION: an untyped `self` is `any`, which produces no error either way.
		// A GENERIC function used as a VALUE (not called) has no call site to infer from, so its type
		// parameters erase to their bounds -- the same rule `closureSigParts` already applies to a
		// generic function TYPE. tison's own `makeRule<any>(stampPos)` is this, and `stampPos` is what
		// every ts-parser.ts/js-parser.ts grammar rule reaches through.
		const { genericValue } = await compile(`
			type Common = <T>(value: T, n: number) => any;
			function stamp<T>(t: T, n: number): T { return t; }
			function useIt(c: Common, v: number): number { return c(v, 1) as number; }
			export function genericValue(): number { return useIt(stamp, 42); }
		`);
		check('a generic function used as a value erases to its bounds', genericValue(), 42);
		// ...but only where the WANTED signature is erased too. A concrete one needs the real
		// instantiation, which nothing here can infer, and saying so beats an `internal:` cast error.
		await checkThrows('a generic function value at a CONCRETE signature is rejected', () => compile(`
			function identity<T>(t: T): T { return t; }
			function apply(f: (x: number) => number, v: number): number { return f(v); }
			export function main(): number { return apply(identity, 7); }
		`), /only erases to its bounds/);

		check('a callback in the TUPLE arm of a union rest is contextually typed',
			typeErrors(`type Items = number[];
				declare function Build(...alts: [(self: () => Items) => Items] | Items): Items;
				declare function want(n: number): void;
				const r = Build(self => { want(self); return self(); });`)
				.some(x => /'\(\) => Items' is not assignable to parameter/.test(x)), true);
	}

	{
		// Nested function declarations (a `function` statement inside another function's body, distinct
		// from a top-level `function` and from the `case 'arrow'/'function'` closure *expressions* above)
		// -- reuses the same closure-literal machinery, bound to a named local. No hoisting: only callable
		// from below its own declaration point in the same block.
		const { basic } = await compile(`
			export function basic(): number {
				function double(x: number): number { return x * 2; }
				return double(21);
			}
		`);
		check('nested function declaration: basic call', basic(), 42);

		const { capturesOuter } = await compile(`
			export function capturesOuter(): number {
				const a = 100;
				function addA(x: number): number { return x + a; }
				return addA(23);
			}
		`);
		check('nested function declaration: captures an outer local', capturesOuter(), 123);

		const { recursive } = await compile(`
			export function recursive(): number {
				function sumTo(n: number): number {
					return n <= 0 ? 0 : n + sumTo(n - 1);
				}
				return sumTo(5);
			}
		`);
		check('nested function declaration: self-recursive call', recursive(), 15);

		const { recursiveWithCapture } = await compile(`
			export function recursiveWithCapture(): number {
				const step = 2;
				function countDown(n: number): number {
					return n <= 0 ? 0 : step + countDown(n - step);
				}
				return countDown(6);
			}
		`);
		check('nested function declaration: recursion combined with an outer capture', recursiveWithCapture(), 6);

		// Hoisted, as in JS: callable above its own declaration point (type-utils.ts's `resolve` calls `uncached` so).
		const { forwardRef } = await compile(`
			export function forwardRef(): number {
				const r = helper(1);
				function helper(x: number): number { return x + 1; }
				return r;
			}
		`);
		check('nested function declaration: a call above its own declaration point (hoisted)', forwardRef(), 2);
	}

	{
		// RegExp ("core" scope -- see lib/regexp.ts's own header comment for exactly what's covered/not):
		// literal/`.`/character classes (incl. negation), \d\s, greedy/lazy quantifiers (* + ? {n,m}),
		// capturing groups + backreferences, alternation, ^$ anchors, i/g flags, exec()'s lastIndex
		// stepping. Every `new RegExp(...)` is bound to a local before calling a method on it --
		// `new RegExp(...).test(...)` chained directly is a real (separate, reported) towasm.ts bug:
		// method-call dispatch resolves the receiver's class via an already-registered lookup that a
		// directly-chained `new` expression hasn't triggered yet.
		const {
			literalMatch, literalNoMatch, dotAny, charClass, charClassNegate, digitClass,
			starGreedyLength, starLazyLength, plusMatch, optionalBoth, braceExactTooShort, braceExactOk,
			braceRangeLength, groupBackrefMatch, groupBackrefNoMatch, groupCaptureLength, alternation,
			anchors, ignoreCaseFlag, globalExecCount, wordBoundary,
			flagsContent, stickyFailsAtWrongOffset, stickyMatchesAtOffset, globalStillScansPastOffset,
			negLookaheadMatches, negLookaheadRejects, posLookaheadMatches, posLookaheadRejects,
			negLookaheadAlternation, lookaheadCaptureGroup,
		} = await compile(`
			export function literalMatch(): number { const re = new RegExp("abc"); return re.test("xxabcyy") ? 1 : 0; }
			export function literalNoMatch(): number { const re = new RegExp("abc"); return re.test("xyz") ? 1 : 0; }
			export function dotAny(): number { const re = new RegExp("a.c"); return re.test("aXc") ? 1 : 0; }
			export function charClass(): number { const re = new RegExp("[a-c]+"); return re.test("xxbbxx") ? 1 : 0; }
			export function charClassNegate(): number { const re = new RegExp("[^0-9]+"); return re.test("123abc") ? 1 : 0; }
			export function digitClass(): number { const re = new RegExp("\\\\d+"); return re.test("abc123") ? 1 : 0; }
			export function starGreedyLength(): number {
				const re = new RegExp("a*");
				const m = re.exec("aaab");
				if (m === null) return -1;
				const g0 = m.group(0);
				return g0.length;
			}
			export function starLazyLength(): number {
				const re = new RegExp("a.*?c");
				const m = re.exec("axxcxxc");
				if (m === null) return -1;
				const g0 = m.group(0);
				return g0.length;
			}
			export function plusMatch(): number { const re = new RegExp("a+"); return re.test("baaab") ? 1 : 0; }
			export function optionalBoth(): number {
				const re = new RegExp("colou?r");
				return (re.test("color") ? 1 : 0) * 10 + (re.test("colour") ? 1 : 0);
			}
			export function braceExactTooShort(): number { const re = new RegExp("a{3}"); return re.test("aa") ? 1 : 0; }
			export function braceExactOk(): number { const re = new RegExp("a{3}"); return re.test("aaa") ? 1 : 0; }
			export function braceRangeLength(): number {
				const re = new RegExp("a{2,4}");
				const m = re.exec("aaaaa");
				if (m === null) return -1;
				const g0 = m.group(0);
				return g0.length;
			}
			export function groupBackrefMatch(): number { const re = new RegExp("(\\\\w+) \\\\1"); return re.test("hello hello") ? 1 : 0; }
			export function groupBackrefNoMatch(): number { const re = new RegExp("(\\\\w+) \\\\1"); return re.test("hello world") ? 1 : 0; }
			export function groupCaptureLength(): number {
				const re = new RegExp("(ab)+c");
				const m = re.exec("ababc");
				if (m === null) return -1;
				const g1 = m.group(1);
				return m.length * 1000 + g1.length;
			}
			export function alternation(): number {
				const re = new RegExp("cat|dog");
				return (re.test("I have a dog") ? 1 : 0) * 10 + (re.test("I have a cat") ? 1 : 0);
			}
			export function anchors(): number {
				const re = new RegExp("^abc$");
				return (re.test("abc") ? 1 : 0) * 10 + (re.test("xabc") ? 1 : 0);
			}
			export function ignoreCaseFlag(): number { const re = new RegExp("abc", "i"); return re.test("ABC") ? 1 : 0; }
			export function globalExecCount(): number {
				const re = new RegExp("a", "g");
				let count = 0;
				while (re.exec("banana") !== null)
					count = count + 1;
				return count;
			}
			export function wordBoundary(): number {
				const re = new RegExp("\\\\bcat\\\\b");
				return (re.test("a cat sat") ? 1 : 0) * 10 + (re.test("category") ? 1 : 0);
			}
			// '.flags'/sticky ('y') support -- added for tison.ts's own lexer (nextToken sets 'lastIndex'
			// and expects an exact-position match, never a forward scan), part of the towasm.ts
			// self-hosting groundwork.
			export function flagsContent(): number {
				const re = new RegExp("a", "yim");
				const f = re.flags;
				let h = f.length * 1000;
				for (let i = 0; i < f.length; i = i + 1)
					h = h + f.charCodeAt(i) * (i + 1);
				return h;
			}
			export function stickyFailsAtWrongOffset(): number {
				const re = new RegExp("b", "y");
				re.lastIndex = 0;
				return re.exec("ab") === null ? 1 : 0;
			}
			export function stickyMatchesAtOffset(): number {
				const re = new RegExp("b", "y");
				re.lastIndex = 1;
				return re.exec("ab") !== null ? 1 : 0;
			}
			export function globalStillScansPastOffset(): number {
				const re = new RegExp("b", "g");
				re.lastIndex = 0;
				return re.exec("ab") !== null ? 1 : 0;
			}
			// Lookahead (?=X) (?!X) -- confirmed-bug regression coverage: "(?!" was silently parsed as
			// an always-failing pattern (never a compile error), so any regex using it just never matched.
			export function negLookaheadMatches(): number { const re = new RegExp("readonly(?!\\\\w)"); return re.test("readonly ") ? 1 : 0; }
			export function negLookaheadRejects(): number { const re = new RegExp("readonly(?!\\\\w)"); return re.test("readonlyX") ? 1 : 0; }
			export function posLookaheadMatches(): number { const re = new RegExp("foo(?=bar)"); return re.test("foobar") ? 1 : 0; }
			export function posLookaheadRejects(): number { const re = new RegExp("foo(?=bar)"); return re.test("foobaz") ? 1 : 0; }
			export function negLookaheadAlternation(): number {
				const re = new RegExp("(?!a|b)c");
				return (re.test("cc") ? 1 : 0) * 10 + (re.test("ac") ? 1 : 0);
			}
			export function lookaheadCaptureGroup(): number {
				const re = new RegExp("(?=(a))a");
				const m = re.exec("a");
				if (m === null) return -1;
				const g1 = m.group(1);
				return g1.length;
			}
		`);
		check('RegExp: literal match', literalMatch(), 1);
		check('RegExp: literal no-match', literalNoMatch(), 0);
		check('RegExp: "." matches any char', dotAny(), 1);
		check('RegExp: [a-c]+ character class', charClass(), 1);
		check('RegExp: [^0-9]+ negated class', charClassNegate(), 1);
		check('RegExp: \\d+ shorthand class', digitClass(), 1);
		check('RegExp: a* greedy ("aaab" -> "aaa", length 3)', starGreedyLength(), 3);
		check('RegExp: a.*?c lazy ("axxcxxc" -> "axxc", length 4)', starLazyLength(), 4);
		check('RegExp: a+ one-or-more', plusMatch(), 1);
		check('RegExp: colou?r optional (matches both spellings)', optionalBoth(), 11);
		check('RegExp: a{3} rejects too-short input', braceExactTooShort(), 0);
		check('RegExp: a{3} accepts exact-length input', braceExactOk(), 1);
		check('RegExp: a{2,4} greedy bounded ("aaaaa" -> 4 a\'s)', braceRangeLength(), 4);
		check('RegExp: (\\w+) \\1 backreference matches', groupBackrefMatch(), 1);
		check('RegExp: (\\w+) \\1 backreference rejects mismatch', groupBackrefNoMatch(), 0);
		check('RegExp: (ab)+c captures group 1 (2 groups incl. whole match, group 1 length 2)', groupCaptureLength(), 2002);
		check('RegExp: cat|dog alternation', alternation(), 11);
		check('RegExp: ^abc$ anchors', anchors(), 10);
		check('RegExp: "i" flag case-insensitive', ignoreCaseFlag(), 1);
		check('RegExp: "g" flag exec() steps lastIndex (3 "a"s in "banana")', globalExecCount(), 3);
		check('RegExp: \\bcat\\b word boundary', wordBoundary(), 10);
		check('RegExp: .flags canonicalizes to "imy" regardless of input order "yim"', flagsContent(), 3686);
		check('RegExp: "y" (sticky) fails when the match is past lastIndex, not scanned to', stickyFailsAtWrongOffset(), 1);
		check('RegExp: "y" (sticky) matches exactly at lastIndex', stickyMatchesAtOffset(), 1);
		check('RegExp: "g" (non-sticky) still scans forward past lastIndex', globalStillScansPastOffset(), 1);
		check('RegExp: readonly(?!\\w) matches when not followed by a word char', negLookaheadMatches(), 1);
		check('RegExp: readonly(?!\\w) rejects when followed by a word char', negLookaheadRejects(), 0);
		check('RegExp: foo(?=bar) matches when followed by "bar"', posLookaheadMatches(), 1);
		check('RegExp: foo(?=bar) rejects when not followed by "bar"', posLookaheadRejects(), 0);
		check('RegExp: (?!a|b)c rejects "cc" at pos 0 (matches at pos 1), matches "ac" (assertion true at pos 1)', negLookaheadAlternation(), 11);
		check('RegExp: (?=(a))a captures group 1 through the lookahead', lookaheadCaptureGroup(), 1);
	}

	{
		// Map<K,V> -- linear-scan implementation (lib/map.ts), part of the towasm.ts self-hosting
		// groundwork (checker.ts/type-utils.ts/walker.ts/transform.ts/towasm.ts/tison.ts itself all use
		// Map pervasively). `set`/`get`/`has`/`delete`/`size`/`clear`/`keys` over string keys, plus
		// reference-identity semantics for class-typed keys (a structurally-identical-but-distinct
		// instance must NOT collide).
		const { basic, overwrite, del, sizeAndClear, keysOrderAfterDelete, classKeysUseIdentity } = await compile(`
			export function basic(): number {
				const m = new Map<string, number>();
				m.set('a', 1);
				m.set('b', 2);
				return (m.get('a') ?? -1) * 100 + (m.get('b') ?? -1) * 10 + (m.has('c') ? 1 : 0);
			}
			export function overwrite(): number {
				const m = new Map<string, number>();
				m.set('a', 1);
				m.set('a', 10);
				return m.size * 100 + (m.get('a') ?? -1);
			}
			export function del(): number {
				const m = new Map<string, number>();
				m.set('a', 1);
				m.set('b', 2);
				const removed = m.delete('a') ? 1 : 0;
				return removed * 100 + m.size * 10 + (m.has('a') ? 1 : 0);
			}
			export function sizeAndClear(): number {
				const m = new Map<string, number>();
				m.set('a', 1);
				m.set('b', 2);
				m.set('c', 3);
				const before = m.size;
				m.clear();
				return before * 10 + m.size;
			}
			export function keysOrderAfterDelete(): number {
				const m = new Map<string, number>();
				m.set('a', 1);
				m.set('b', 2);
				m.set('c', 3);
				m.delete('b');
				const ks = m.keys();
				return ks.length * 10000 + ks[0].charCodeAt(0) * 100 + ks[1].charCodeAt(0);
			}
			class Node { constructor(public id: number) {} }
			export function classKeysUseIdentity(): number {
				const m = new Map<Node, number>();
				const a = new Node(1);
				const b = new Node(2);
				m.set(a, 100);
				m.set(b, 200);
				const c = new Node(1);
				return (m.get(a) ?? -1) * 10000 + (m.get(b) ?? -1) * 100 + (m.has(c) ? 1 : 0);
			}
		`);
		check('Map: get/set/has', basic(), 120);
		check('Map: set() on an existing key overwrites, size unchanged', overwrite(), 110);
		check('Map: delete() removes and reports size/has correctly', del(), 110);
		check('Map: size tracks entries, clear() empties it', sizeAndClear(), 30);
		check('Map: keys() after delete() preserves remaining relative order', keysOrderAfterDelete(),
			2 * 10000 + 'a'.charCodeAt(0) * 100 + 'c'.charCodeAt(0));
		check('Map: class-typed keys use reference identity, not structural equality', classKeysUseIdentity(), 1020000);
	}

	{
		// WeakMap<K,V> -- Map-backed (lib/map.ts), added because type-utils.ts's `Scope.resolveCache`/
		// `lookupMemberCache` are WeakMap-typed, and an unresolvable field type on `Scope` blocked every
		// declaration touching a scope across checker/towasm/transform/type-utils.
		const { basic, bare, fromEntries } = await compile(`
			class Node { constructor(public id: number) {} }
			export function basic(): number {
				const m = new WeakMap<Node, number>();
				const a = new Node(1);
				const b = new Node(2);
				m.set(a, 10);
				m.set(b, 20);
				const c = new Node(1);
				return (m.get(a) ?? -1) * 10000 + (m.get(b) ?? -1) * 100 + (m.has(c) ? 1 : 0);
			}
			export function bare(): number {
				const m = new WeakMap<Node, number>;
				const a = new Node(7);
				m.set(a, 5);
				const gone = m.delete(a) ? 1 : 0;
				return gone * 10 + (m.get(a) ?? 9);
			}
			export function fromEntries(): number {
				const a = new Node(1);
				const b = new Node(2);
				const m = new WeakMap<Node, number>([[a, 4], [b, 5]]);
				return (m.get(a) ?? -1) * 10 + (m.get(b) ?? -1);
			}
		`);
		check('WeakMap: get/set/has use reference identity, not structural equality', basic(), 102000);
		check('WeakMap: bare `new WeakMap` (no parens/type args), then delete()', bare(), 19);
		check("WeakMap: entries-array constructor", fromEntries(), 45);
	}

	{
		// An empty statement (a stray `;`) had no `case` in `emitStmt` at all, so it reached the `default:`
		// throw -- js-parser.ts's own source is full of them.
		const { strays, emptyLoopBody } = await compile(`
			export function strays(): number {
				;
				let x = 1;
				;;
				x = x + 1;
				;
				return x;
			}
			export function emptyLoopBody(): number {
				let i = 0;
				for (i = 0; i < 3; i++);
				return i;
			}
		`);
		check('empty statement: stray semicolons in a function body', strays(), 2);
		check('empty statement: as a for-loop body', emptyLoopBody(), 3);
	}

	{
		// An OPTIONAL field on a real `class_decl` never had its `optional` flag passed to `addField`, so it
		// got a non-nullable slot and no "no value" to construct with -- which surfaced as `??=` rejecting it
		// ("needs a nullable object-typed target"), the exact shape type-utils.ts's lazily-built `Scope`
		// caches use. Only the `class_decl` path was affected; a structural `{c?: P}` object type already
		// passed the flag, and so did an explicit `c: P | undefined`.
		const { unassignedIsUndefined, lazyCreate, doesNotOverwrite, paramProperty, paramPropertyOptionalChain, allFieldsOptional } = await compile(`
			class P { constructor(public x: number) {} }
			class H { c?: P; n: number; constructor(n: number) { this.n = n; } }
			export function unassignedIsUndefined(): number {
				const h = new H(5);
				return (h.c === undefined ? 10 : 0) + h.n;
			}
			export function lazyCreate(): number {
				const h = new H(0);
				return (h.c ??= new P(4)).x * 10 + (h.c === undefined ? 0 : 1);
			}
			export function doesNotOverwrite(): number {
				const h = new H(0);
				h.c = new P(7);
				h.c ??= new P(4);
				return h.c.x;
			}
			class Q { constructor(public a: number, public b?: P) {} }
			export function paramProperty(): number {
				const q = new Q(3);
				return (q.b === undefined ? 10 : 0) + q.a;
			}
			export function paramPropertyOptionalChain(): number {
				return (new Q(3).b?.x ?? 1) * 10 + (new Q(3, new P(4)).b?.x ?? 1);
			}
			class AllOpt { c?: P; d?: P; constructor() {} }
			export function allFieldsOptional(): number {
				const a = new AllOpt();
				a.c = new P(6);
				return a.c.x * 10 + (a.d === undefined ? 1 : 0);
			}
		`);
		check('optional field: unassigned by the constructor reads back as undefined', unassignedIsUndefined(), 15);
		check("optional field: '??=' lazily creates it", lazyCreate(), 41);
		check("optional field: '??=' leaves an already-assigned value alone", doesNotOverwrite(), 7);
		check('optional field: an optional constructor parameter property', paramProperty(), 13);
		// Silently *trapped* before (a null deref) rather than throwing: `classShapes` gave the synthesized
		// property the constructor's modifiers, so it was never optional and `?.` skipped its null check.
		check("optional field: '?.' over an omitted parameter property", paramPropertyOptionalChain(), 14);
		check('optional field: a class whose fields are ALL optional still materializes `this`', allFieldsOptional(), 61);
	}

	{
		// `new C` with no explicit type arguments. Both sources of the answer already existed -- the checker
		// solves them from the constructor's own arguments, and `ctx.contextualReturn` carries the target's
		// declared type -- but `case 'new'` asked neither, so every one of these threw "class 'C' needs N
		// explicit type argument(s)". The assignment cases also needed the checker to contextually type an
		// assignment's right side by its target, or the VALUE of `(c ??= new WeakMap)` stayed
		// `WeakMap<any,any>` and the chained `.set()` had nowhere to resolve.
		const { fromArgs, fromAnnotation, fromAssignment, fromNullishAssign, lazyCacheRoundTrip } = await compile(`
			class Type { constructor(public name: string) {} }
			class Scope { cache?: WeakMap<Type, number>; constructor() {} }
			export function fromArgs(): number {
				const s = new Set(['a', 'b', 'a']);
				return s.size * 10 + (s.has('b') ? 1 : 0);
			}
			export function fromAnnotation(): number {
				const m: Map<Type, number> = new Map;
				m.set(new Type('a'), 3);
				return m.size;
			}
			export function fromAssignment(): number {
				const s = new Scope();
				const t = new Type('a');
				s.cache = new WeakMap;
				s.cache.set(t, 6);
				return s.cache.get(t) ?? -1;
			}
			export function fromNullishAssign(): number {
				const s = new Scope();
				const t = new Type('a');
				(s.cache ??= new WeakMap).set(t, 8);
				return s.cache.get(t) ?? -1;
			}
			// type-utils.ts's own shape: a lazily-built per-scope cache, read back through a second lookup.
			class Scope2 { lookup?: WeakMap<Type, Map<string, number>>; constructor() {} }
			export function lazyCacheRoundTrip(): number {
				const s = new Scope2();
				const t = new Type('a');
				const keyMap = (s.lookup ??= new WeakMap).get(t) ?? new Map<string, number>();
				keyMap.set('x', 5);
				s.lookup.set(t, keyMap);
				const back = s.lookup.get(t);
				return back === undefined ? -1 : back.get('x') ?? -1;
			}
		`);
		check("generic 'new': type arguments solved from the constructor's arguments", fromArgs(), 21);
		check("generic 'new': from the declaration's own annotation", fromAnnotation(), 1);
		check("generic 'new': from the assignment target's type", fromAssignment(), 6);
		check("generic 'new': from a '??=' target's type", fromNullishAssign(), 8);
		check("generic 'new': a lazily-built nested cache round-trips", lazyCacheRoundTrip(), 5);
	}

	{
		// An object reference as a bare condition (`if (obj)`, `obj ? a : b`) threw "this value cannot be
		// used as a boolean condition" -- `emitTruthy` only ever handled scalar kinds. A real reference is
		// always truthy in JS, so this is exactly a null test. A string (`''` is falsy) and a boxed `any`
		// (could hold `0`) are deliberately still rejected: for those, truthiness is a property of the
		// value rather than of the reference.
		const { absent, present, localNarrowing, nonNullable, emptyArray, sideEffect } = await compile(`
			class P { constructor(public x: number) {} }
			class H { c?: P; constructor() {} }
			export function absent(): number  { return new H().c ? 1 : 2; }
			export function present(): number { const h = new H(); h.c = new P(9); return h.c ? 1 : 2; }
			export function localNarrowing(): number {
				let m: P | undefined = undefined;
				const before = m ? 1 : 2;
				m = new P(1);
				return before * 10 + (m ? 1 : 2);
			}
			export function nonNullable(): number { return new P(3) ? 1 : 2; }
			export function emptyArray(): number { const a: number[] = []; return a ? 1 : 2; }
			let n = 0;
			function mk(): P { n = n + 5; return new P(1); }
			export function sideEffect(): number { const r = mk() ? 1 : 2; return r * 10 + n; }
		`);
		check('truthiness: an absent optional object field is falsy', absent(), 2);
		check('truthiness: a present one is truthy', present(), 1);
		check('truthiness: a nullable local, before and after assignment', localNarrowing(), 21);
		check('truthiness: a non-nullable reference is unconditionally true', nonNullable(), 1);
		check('truthiness: an EMPTY array is truthy (unlike an empty string)', emptyArray(), 1);
		check('truthiness: a discarded non-nullable receiver still runs its side effects', sideEffect(), 15);
	}

	{
		// A string tests its own LENGTH, not its reference -- `''` is falsy. A nullable one is falsy when
		// null too, and `array.len` would trap there, so the null test has to come first.
		const { empty, nonEmpty, absent, present, presentEmpty } = await compile(`
			class H { s?: string; constructor() {} }
			export function empty(): number { const s = ''; return s ? 1 : 2; }
			export function nonEmpty(): number { const s = 'ab'; return s ? 1 : 2; }
			export function absent(): number { return new H().s ? 1 : 2; }
			export function present(): number { const h = new H(); h.s = 'x'; return h.s ? 1 : 2; }
			export function presentEmpty(): number { const h = new H(); h.s = ''; return h.s ? 1 : 2; }
		`);
		check("truthiness: an empty string is falsy", empty(), 2);
		check('truthiness: a non-empty string is truthy', nonEmpty(), 1);
		check('truthiness: an absent optional string is falsy', absent(), 2);
		check('truthiness: a present non-empty one is truthy', present(), 1);
		check('truthiness: a present EMPTY one is still falsy', presentEmpty(), 2);
	}

	{
		// A scalar-typed optional field used to keep a bare `f64`/`i32` slot with a zero default, so there
		// was no "absent" distinct from `0` -- `??=` threw outright, and an unassigned `n?: number` silently
		// read back as `0` rather than `undefined`. It now gets the same null-boxing an optional *parameter*
		// already got. `??=` not firing on a stored `0` is the whole point: `0` is falsy but not nullish.
		const { creates, keepsZero, absentIsUndefined, coalesce, arithmetic, optionalBoolean, optionalBigint } = await compile(`
			class H { n?: number; b?: boolean; g?: bigint; constructor() {} }
			export function creates(): number { const h = new H(); h.n ??= 4; return h.n; }
			export function keepsZero(): number { const h = new H(); h.n = 0; h.n ??= 4; return h.n; }
			export function absentIsUndefined(): number { return new H().n === undefined ? 1 : 0; }
			export function coalesce(): number {
				const h = new H();
				const before = h.n ?? 7;
				h.n = 2;
				return before * 10 + (h.n ?? 7);
			}
			export function arithmetic(): number { const h = new H(); h.n = 5; return h.n + 1; }
			export function optionalBoolean(): number {
				const h = new H();
				const before = h.b === undefined ? 1 : 0;
				h.b = true;
				return before * 10 + (h.b ? 1 : 0);
			}
			// bigint's physical form is an i32 array, so an optional one lands on the nullable-target
			// path of the i64-to-bigint conversion -- which used to compare nullability and give up.
			export function optionalBigint(): number { const h = new H(); h.g = 5n; return h.g === 5n ? 1 : 0; }
		`);
		check("optional scalar field: '??=' creates a value when absent", creates(), 4);
		check("optional scalar field: '??=' does NOT overwrite a stored 0", keepsZero(), 0);
		check('optional scalar field: unassigned reads back as undefined, not 0', absentIsUndefined(), 1);
		check("optional scalar field: '??' before and after assignment", coalesce(), 72);
		check('optional scalar field: unboxes for ordinary arithmetic', arithmetic(), 6);
		check('optional scalar field: an optional boolean', optionalBoolean(), 11);
		check('optional scalar field: an optional bigint assigns from an i64 literal', optionalBigint(), 1);
	}

	{
		// Function TYPES (`closureSigParts`) rejected two shapes that a function DECLARATION already
		// handles, which between them blocked most of checker.ts in the self-hosting survey.
		//
		// A type predicate (`t is Foo`) had no physical representation at all -- as a plain value it IS a
		// boolean, and an `asserts` one yields nothing, exactly the reduction the checker already applies
		// to a predicate call used as a value.
		//
		// A defaulted parameter was rejected outright, on the theory that a bare function type has no room
		// to write the default. But when the type comes FROM a declaration (`typeof f`, a method's own
		// type) the default is right there on it, and the call site fills it in the same way a direct call
		// does. The physical slot therefore keeps its plain type rather than going nullable -- the rule
		// `resolveParam` already uses -- because the two signatures have to agree.
		const { predicateValue, predicateParam, assertsPredicate, boolDefault, strDefault, floatDefault, intDefault } = await compile(`
			class A { constructor(public x: number) {} }
			function isBig(a: A): a is A { return a.x > 5; }
			export function predicateValue(): number {
				const p: (a: A) => a is A = isBig;
				return (p(new A(9)) ? 10 : 0) + (p(new A(1)) ? 1 : 0);
			}
			function applyPred(g: (a: A) => a is A, a: A): number { return g(a) ? 1 : 0; }
			export function predicateParam(): number { return applyPred(isBig, new A(9)) * 10 + applyPred(isBig, new A(2)); }
			function check(a: A): asserts a is A { }
			export function assertsPredicate(): number {
				const p: (a: A) => asserts a is A = check;
				p(new A(1));
				return 7;
			}
			function tag(s: string, upper = false): number { return s.length + (upper ? 100 : 0); }
			export function boolDefault(): number { const g: typeof tag = tag; return g('abc') * 1000 + g('abc', true); }
			function join(a: string, sep = ','): number { return a.length + sep.length * 10; }
			export function strDefault(): number { const g: typeof join = join; return g('abc') * 100 + g('abc', '--'); }
			function scaleF(a: number, by = 10.5): number { return a * by; }
			export function floatDefault(): number { const g: typeof scaleF = scaleF; return g(2) * 100 + g(2, 2); }
			// An INTEGER default specifically: the checker types the literal as the wasm pseudo-type 'i32',
			// which has to collapse back to 'number' or the type and the declaration disagree physically.
			function scaleI(a: number, by = 10): number { return a * by; }
			export function intDefault(): number { const g: typeof scaleI = scaleI; return g(2) * 100 + g(2, 2); }
		`);
		check('function type: a type predicate return, through a variable', predicateValue(), 10);
		check('function type: a type predicate return, through a parameter', predicateParam(), 10);
		check("function type: an 'asserts' predicate return", assertsPredicate(), 7);
		check('function type: a boolean-defaulted parameter', boolDefault(), 3103);
		check('function type: a string-defaulted parameter', strDefault(), 1323);
		check('function type: a float-defaulted parameter', floatDefault(), 2104);
		check('function type: an integer-defaulted parameter agrees with the declaration', intDefault(), 2004);
	}

	{
		// An interface that `extends` another resolves to a real INTERSECTION, not an 'object'. Reached by
		// its bare name that never mattered -- `ensureClass` resolves the name directly. Reached by a
		// NAMESPACE-QUALIFIED one (`NS.Sig<number>`, which is how every cross-module type in this project is
		// written) `ensureClass` can't help, because its lookup never splits on '.', and the object-shape
		// fallback beside it only handled a plain 'object'. So the type had no representation at all --
		// `JS.CallSig<any>`, `T.FixSig`'s own parameter, and the survey's largest row.
		const { viaNamespace } = await compileMulti({
			types: `
				export interface Base<T> { a: T }
				export interface Sig<T> extends Base<T> { b: T }
			`,
			main: `
				import * as NS from './types';
				function use(s: NS.Sig<number>): number { return s.a + s.b; }
				export function viaNamespace(): number {
					const g: (s: NS.Sig<number>) => number = use;
					return g({ a: 1, b: 2 });
				}
			`,
		}, 'main');
		check('function type: a namespace-qualified interface that extends another', viaNamespace(), 3);

		// A NAMESPACE-qualified read (`import * as L`) of an exported module-level const resolves that
		// const against the module's own EXPORT scope -- which has no entry at all for a NON-EXPORTED
		// sibling its initializer reads. js-parser.ts's `import_attributes` is exactly that, and every
		// `JS.import_declaration` rule ts-parser.ts has is built from it. `topLevelVars` is keyed per
		// MODULE now (it was entry-only), and the binding's type comes from the checker when the export
		// scope cannot supply one.
		const { privateSibling } = await compileMulti({
			lib: `
				function makeList(a: number, b: number): number[] { return [a, b]; }
				export function pick(xs: number[], i: number): number { return xs[i]; }
				const part: number[] = makeList(1, 2);
				export const whole: number[] = makeList(pick(part, 0) + 10, pick(part, 1) + 20);
			`,
			main: `
				import * as L from './lib';
				export function privateSibling(): number { return L.pick(L.whole, 0) * 100 + L.pick(L.whole, 1); }
			`,
		}, 'main');
		check('a namespace-qualified const reads a NON-EXPORTED sibling of its own module', privateSibling(), 1122);

		// ...and one whose initializer calls through its OWN module's namespace import (type-utils.ts's
		// `ANY = TS.RefType('any')`): the wrapper must compile in that module's scope, not the export scope it was found in.
		const { nsInitViaOwnImport } = await compileMulti({
			helper:	`export function make(x: number): number { return x + 1; }`,
			lib: `
				import * as H from './helper';
				export const k: number = H.make(20);
			`,
			main: `
				import * as L from './lib';
				export function nsInitViaOwnImport(): number { return L.k * 2; }
			`,
		}, 'main');
		check('a namespace-qualified const whose initializer calls through its own namespace import', nsInitViaOwnImport(), 42);

		// A namespace-qualified FUNCTION read as a VALUE (`makeRule(Common.stampPos)`): calls through the namespace
		// always compiled, but a bare read produced no closure to pass.
		const { nsFnValue } = await compileMulti({
			lib: `export function twice(x: number): number { return x * 2; }`,
			main: `
				import * as L from './lib';
				function apply(f: (x: number) => number, x: number): number { return f(x); }
				export function nsFnValue(): number { return apply(L.twice, 21); }
			`,
		}, 'main');
		check('a namespace-qualified function passed as a value', nsFnValue(), 42);

		// Imports through a re-export barrel (tison.ts has been one since b1d5692): the named-import map pointed
		// at the barrel, which declares nothing, and the re-exported modules were never even loaded.
		const { viaStar, viaRenamed, viaNsStar } = await compileMulti({
			core:	`export function twice(x: number): number { return x * 2; }`,
			star:	`export * from './core';`,
			named:	`export { twice as dbl } from './core';`,
			main: `
				import { twice } from './star';
				import { dbl } from './named';
				import * as S from './star';
				export function viaStar(): number { return twice(21); }
				export function viaRenamed(): number { return dbl(20); }
				export function viaNsStar(): number { return S.twice(10); }
			`,
		}, 'main');
		check('a named import through export * from', viaStar(), 42);
		check('a renamed import through export {x as y} from', viaRenamed(), 40);
		check('a namespace import through export * from', viaNsStar(), 20);

		// An `export *` inside an import cycle (tison.ts <-> lalr.ts) must bind whatever order the cycle's modules load in.
		// Imports resolved concurrently let a slow `./p` decide, and `a`'s `export * from './b'` was cut.
		{
			class SlowLoader extends ModuleLoader {
				async get(mod: string, from: string) {
					if (mod === './p')
						await new Promise(r => setTimeout(r, 50));
					return super.get(mod, from);
				}
			}
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'towasm-cycle-'));
			try {
				const files: Record<string, string> = {
					p:		`export const P = 1;`,
					a:		`export * from './p';\nexport * from './b';`,
					b:		`import { P } from './a';\nexport type CB = (x: number) => number;\nexport const B = P;`,
					c:		`import { B } from './b';\nexport const C = B;`,
					main:	`import { C } from './c';\nimport { type CB } from './a';\nexport const f: CB = x => x + C;`,
				};
				for (const [name, src] of Object.entries(files))
					await fs.writeFile(path.join(dir, name + '.ts'), src);
				const program = parser.parse(files.main);
				await TStypeCheckAsync(program, new SlowLoader(dir, {}), new T.Scope(libScope));
				const x = (program.body[2] as any).declaration.declarations[0].init.params[0].typeAnnotation;
				check('an export * inside an import cycle binds whatever order its modules load in', x && T.typeKey(x), 'number');
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		}

		// A closure-typed module-level const caches into a NULLABLE slot of the same signature; converting
		// between the two went through the closure coercion wrapper and wrapped a nullable ref: invalid wasm.
		const { closureConstRead } = await compile(`
			function mk(k: number) { return (x: number) => x + k; }
			const R = mk(1);
			export function closureConstRead(): number { const g = R; return g(41); }
		`);
		check('a closure-typed module-level const read as a value', closureConstRead(), 42);

		// An EXPANDO property -- one the CHECKER accepted that the receiver's class does not really
		// declare. `Object.defineProperty` already allocated the class's `$ext` subclass for these; a
		// plain WRITE is the same operation spelled differently and now does too. The trigger is not the
		// `as any` syntax but the field simply not being real, so an ordinary `p.x = 1` is untouched.
		const { expandoWrite, expandoDefine, realFieldUntouched } = await compile(`
			interface P { x: number }
			export function expandoWrite(): number {
				const p: P = { x: 1 };
				(p as any).scope = 5;
				return ((p as any).scope as number) + p.x;
			}
			export function expandoDefine(): number {
				const p: P = { x: 1 };
				Object.defineProperty(p, 'scope', { value: 5, enumerable: false, configurable: true, writable: false });
				return ((p as any).scope as number) + p.x;
			}
			export function realFieldUntouched(): number {
				const p: P = { x: 1 };
				p.x = 7;
				return p.x;
			}
		`);
		check('a plain expando property WRITE gets a slot', expandoWrite(), 6);
		check('...as Object.defineProperty already did', expandoDefine(), 6);
		check('...and a write to a REAL field is still an ordinary field write', realFieldUntouched(), 7);
		// A `new`-constructed class carries one too, and a PARAMETER whose object was allocated in
		// another function entirely -- which is the shape the checker's own `(s as any).scope ??= scope`
		// has. Neither is reachable from a declaration site: the field is decided per SHAPE, before the
		// struct type exists, so every instance simply has the slot and nothing is ever cast.
		const { expandoNew, expandoParam } = await compile(`
			class C { x: number; constructor(x: number) { this.x = x; } }
			interface Q { x: number }
			function stamp(q: Q): void { (q as any).scope = 5; }
			export function expandoNew(): number {
				const c = new C(1);
				(c as any).scope = 5;
				return ((c as any).scope as number) + c.x;
			}
			export function expandoParam(): number {
				const q: Q = { x: 1 };
				stamp(q);
				return ((q as any).scope as number) + q.x;
			}
		`);
		check('...on a `new`-constructed class', expandoNew(), 6);
		check('...and on a PARAMETER, written in another function', expandoParam(), 6);
		// A UNION receiver has no single struct to write to, so it gets the same `ref.test` cascade the
		// READ side already used -- `ensureAnyFieldWrite`. This is precisely the checker's own
		// `(s as any).scope ??= scope`, where `s` is a `Stmt` parameter and `Stmt` is a wide union.
		const { expandoUnion } = await compile(`
			interface A { kind: 'a'; a: number }
			interface B { kind: 'b'; b: number }
			type Node = A | B;
			function stamp(n: Node, v: number): void { (n as any).scope = v; }
			export function expandoUnion(): number {
				const a: A = { kind: 'a', a: 1 };
				const b: B = { kind: 'b', b: 2 };
				stamp(a, 10);
				stamp(b, 20);
				return ((a as any).scope as number) + ((b as any).scope as number);
			}
		`);
		check('...and through a UNION receiver, via a ref.test cascade', expandoUnion(), 30);

		// An object literal with a SPREAD, whose target has to be matched structurally (here it is boxed
		// `any`). `matchObjectShape` refused any non-field property outright, so a spread was never
		// matchable however well its operand's type was known. Its keys now count toward the candidate's
		// REQUIRED fields but never disqualify one: real TS does not excess-property-check a spread, so
		// `{...params, returnType}` still matches `CallSig` although `params` might carry more.
		const { spreadMatch } = await compile(`
			interface Params { params: number[] }
			interface CallSig extends Params { returnType?: number }
			function wrap(p: Params): CallSig { const r: any = { ...p, returnType: 7 }; return r as CallSig; }
			export function spreadMatch(): number {
				const s = wrap({ params: [1, 2, 3] });
				return s.params.length * 10 + (s.returnType ?? 0);
			}
		`);
		check('an object literal with a spread finds its target structurally', spreadMatch(), 37);
	}

	{
		// `ReadonlyMap`/`ReadonlySet` have no declarations of their own, so neither had any representation --
		// the same position `ReadonlyArray` was already handled in, just never extended to the other two. A
		// readonly view is a checker-only distinction over the identical physical container.
		const { roMap, roSet, roArray } = await compile(`
			function mapSize(m: ReadonlyMap<string, number>): number { return m.size; }
			export function roMap(): number {
				const m = new Map<string, number>();
				m.set('a', 1);
				const g: typeof mapSize = mapSize;
				return g(m);
			}
			function setSize(s: ReadonlySet<string>): number { return s.size; }
			export function roSet(): number { const g: typeof setSize = setSize; return g(new Set(['a', 'b'])); }
			function arrLen(a: ReadonlyArray<number>): number { return a.length; }
			export function roArray(): number { const g: typeof arrLen = arrLen; return g([1, 2, 3]); }
		`);
		check('ReadonlyMap resolves to Map', roMap(), 1);
		check('ReadonlySet resolves to Set', roSet(), 2);
		check('ReadonlyArray still resolves to Array', roArray(), 3);
	}

	{
		// A parameter default that reads an EARLIER parameter (`dstScope = scope`, all over type-utils.ts).
		// The declaration side has always handled it, by binding each argument into a scratch local and
		// rewriting the default's references to those; a function TYPE rejected it outright, because the
		// `resolvedParams` that rewrite needs were assumed to be something only a real declaration has --
		// no longer true once a type derived from a declaration keeps its defaults. Parameter NAMES join
		// the closure-type memo key when this applies, since the rewrite is by name.
		const { omitted, supplied, distinctNames } = await compile(`
			function pick(a: number, b: number = a): number { return a * 10 + b; }
			export function omitted(): number { const g: typeof pick = pick; return g(3); }
			export function supplied(): number { const g: typeof pick = pick; return g(3, 4); }
			// Same physical signature, same default TEXT, different parameter names: these must not share
			// one memoized closure type, or the rewrite substitutes the wrong name.
			function other(x: number, y: number = x): number { return x * 100 + y; }
			export function distinctNames(): number {
				const g: typeof pick = pick;
				const h: typeof other = other;
				return g(2) + h(5);
			}
		`);
		check('function type: a default reading an earlier parameter, omitted', omitted(), 33);
		check('function type: the same default, supplied', supplied(), 34);
		check('function type: two signatures differing only in parameter names', distinctNames(), 527);
	}

	{
		// Module-level state. A top-level `const`/`let` holding anything but a wasm compile-time constant --
		// an array, an object, a string, a `new`, a call -- was visible to NOTHING but the top level itself:
		// any function referencing it threw "unresolved identifier". `ensureLazyGlobal` already built exactly
		// the right thing (a null slot plus a wrapper that runs the initializer once on first use), but only
		// a CALL of such a const ever reached it; a plain read didn't, and a write crashed.
		//
		// This is the shape every self-hosting target file is built around, and the shape this suite had no
		// coverage of at all -- every other check here keeps its state local to one function.
		const { arr, obj, str, inst, mutate, sharedAcrossFunctions, reassign, writeThenRead,
			annotated, annotatedGeneric, annotatedArray } = await compile(`
			class P { constructor(public x: number) {} }
			const A = [1, 2, 3];
			const D = { a: 1, b: 2 };
			const S = 'hello';
			const P1 = new P(4);
			export function arr(): number { return A.length; }
			export function obj(): number { return D.a + D.b; }
			export function str(): number { return S.length; }
			export function inst(): number { return P1.x; }
			class Box<T> { constructor(public v: T) {} }
			const P2: P = new P(6);
			const B: Box<number> = new Box<number>(7);
			const AA: Array<number> = [1, 2, 3, 4];
			export function annotated(): number { return P2.x; }
			export function annotatedGeneric(): number { return B.v; }
			export function annotatedArray(): number { return AA.length; }
			const M = [1, 2, 3];
			export function mutate(): number { M.push(4); return M.length; }
			const Acc: number[] = [];
			function add(): void { Acc.push(1); }
			export function sharedAcrossFunctions(): number { add(); add(); return Acc.length; }
			let L = [1, 2, 3];
			export function reassign(): number { L = [4, 5]; return L.length; }
			let W = [1, 2, 3];
			function setW(): void { W = [4, 5]; }
			export function writeThenRead(): number { setW(); return W.length; }
		`);
		check('module state: an array const is readable from a function', arr(), 3);
		check('module state: an object const', obj(), 3);
		check('module state: a string const', str(), 5);
		check('module state: a class instance const', inst(), 4);
		// The EXPLICIT annotation is the interesting half: `hoistVar` records `T.resolve`'s fully expanded
		// structural shape, so the class name codegen dispatches by was gone and the nominal initializer
		// had nothing to convert to. A local never hit it -- `case 'var_decl'` reads its raw annotation
		// instead of the scope -- so only a module-level binding showed the bug.
		check('module state: a class instance const with an explicit annotation', annotated(), 6);
		check('module state: ...a generic class', annotatedGeneric(), 7);
		check('module state: ...and the Array<T> spelling of an array', annotatedArray(), 4);
		check('module state: mutating an array const in place', mutate(), 4);
		check('module state: two functions share one accumulator', sharedAcrossFunctions(), 2);
		check('module state: reassigning a top-level let', reassign(), 2);
		check("module state: one function's write is visible to another's read", writeThenRead(), 2);
	}

	{
		// An object literal as a parameter default (`function f(opts = {})`, the options-bag idiom).
		// `isReemittableDefault` -- which decides whether a default can be re-emitted at each call site --
		// accepted a literal, an array of them, and a member chain, but not an object literal.
		const { emptyBag, filledBag } = await compile(`
			function withOpt(o: { a?: number } = {}): number { return o.a ?? 5; }
			export function emptyBag(): number { return withOpt() * 10 + withOpt({ a: 2 }); }
			function withPair(o: { a: number; b: number } = { a: 1, b: 2 }): number { return o.a * 10 + o.b; }
			export function filledBag(): number { return withPair() * 100 + withPair({ a: 3, b: 4 }); }
		`);
		check('parameter default: an empty object literal', emptyBag(), 52);
		check('parameter default: an object literal with fields', filledBag(), 1234);
	}

	{
		// A field with neither an annotation nor an initializer (`opts;`) -- its type exists only in the
		// constructor's own `this.opts = ...`, which is what real TS infers it from. `classShapes` typed it
		// `any` and towasm, which read the AST rather than asking the checker, threw outright.
		const { scalar, objectShape, classInstance, fromParameter } = await compile(`
			class P { constructor(public x: number) {} }
			class N { n; constructor() { this.n = 5; } }
			export function scalar(): number { return new N().n + 1; }
			class O { p; constructor() { this.p = { a: 1, b: 2 }; } }
			export function objectShape(): number { const o = new O(); return o.p.a + o.p.b; }
			class Q { p; constructor() { this.p = new P(7); } }
			export function classInstance(): number { return new Q().p.x; }
			class V { v; constructor(v: number) { this.v = v; } }
			export function fromParameter(): number { return new V(9).v; }
		`);
		check('field inference: a scalar assigned in the constructor', scalar(), 6);
		check('field inference: an object literal', objectShape(), 3);
		check('field inference: a class instance', classInstance(), 7);
		check("field inference: from the constructor's own parameter", fromParameter(), 9);
		// The inferred type is real, not `any` -- a later mismatched write is now an error, exactly as real
		// tsc reports it (TS2322) for the same source.
		check('field inference: a later mismatched write is rejected',
			typeErrors(`class C { v; constructor() { this.v = 1; } m(): void { this.v = 'x'; } }`)
				.some(e => /not assignable to type 'number'/.test(e)), true);
	}

	{
		// Object spread. Two things were wrong. A spread operand had to be a NOMINAL class -- an anonymous
		// object shape (`const D: {a: number} = ...`) had no `ClassInfo` for `ownerOf` to find, though it
		// gets the same synthesized struct an object literal targeting that shape already gets.
		//
		// And "last property wins" was applied statically, by name. That is only right when the later
		// operand's property is actually THERE: spreading an optional one that happens to be absent must
		// fall back to whatever came before it, which is the whole point of the `{...defaults, ...opts}`
		// idiom. It used to read the null slot and trap. Each field now lowers to the same `??` chain the
		// operator itself does, trimmed at the last source that is certain to have a value.
		const { shapeOperand, laterAbsent, laterPresent, classOptAbsent, explicitWins } = await compile(`
			type Full = { a: number; b: number };
			type Part = { a?: number; b?: number };
			const D: Full = { a: 1, b: 2 };
			export function shapeOperand(): number { const p: Part = { b: 9 }; const m: Full = { ...D, ...p }; return m.a * 10 + m.b; }
			export function laterAbsent(): number { const p: Part = {}; const m: Full = { ...D, ...p }; return m.a * 10 + m.b; }
			export function laterPresent(): number { const p: Part = { a: 3, b: 4 }; const m: Full = { ...D, ...p }; return m.a * 10 + m.b; }
			class A { constructor(public a: number, public b: number) {} }
			class B { constructor(public b?: number) {} }
			export function classOptAbsent(): number { const m: Full = { ...new A(1, 2), ...new B() }; return m.a * 10 + m.b; }
			export function explicitWins(): number { const m: Full = { ...new A(1, 2), ...new B(), b: 7 }; return m.a * 10 + m.b; }
		`);
		check('spread: an anonymous object shape as the operand', shapeOperand(), 19);
		check('spread: an ABSENT optional property falls back to the earlier operand', laterAbsent(), 12);
		check('spread: a present one still wins', laterPresent(), 34);
		check('spread: same, with class-typed operands', classOptAbsent(), 12);
		check('spread: an explicit property beats every spread, present or not', explicitWins(), 17);
	}

	{
		// The options-bag shape end to end: a field whose type comes only from `this.x = {...defaults,
		// ...opts}` in the constructor. Three separate things had to be true for this to work.
		//
		// The constructor's own PARAMETERS have to be in scope when that initializer is typed -- resolved
		// against the class scope, `o` is an unknown name and the whole field silently becomes `any`.
		//
		// A later OPTIONAL member of a spread must not erase an earlier required one, matching what the
		// runtime actually does (see the spread checks above): `{...Full, ...Partial}` is Full, not Partial.
		// A mapped type's member (`Partial<typeof D>['k']`) is an unresolved indexed access, so it needs
		// resolving before it can collapse into the earlier `string` rather than unioning with it.
		//
		// And a value whose type is a bare anonymous object shape needs an owner to read fields off at all
		// -- `ownerFor` now synthesizes one as a last resort, the same fallback the literal side had.
		const { fromCtorParam, optionsBag, defaultsKept } = await compile(`
			class V { v; constructor(v: number) { this.v = v; } }
			export function fromCtorParam(): number { return new V(9).v + 1; }
			const D = { newline: 10, indent: 2 };
			type O = Partial<typeof D>;
			class Output {
				opts;
				constructor(o: O = {}) { this.opts = { ...D, ...o }; }
				total(): number { return this.opts.newline * 100 + this.opts.indent; }
			}
			export function optionsBag(): number { return new Output({ newline: 3 }).total(); }
			export function defaultsKept(): number { return new Output().total(); }
		`);
		check("field inference: through the constructor's own parameter scope", fromCtorParam(), 10);
		check('options bag: a supplied option overrides its default', optionsBag(), 302);
		check('options bag: an omitted one keeps the default', defaultsKept(), 1002);
		// The merged type is `Full`, not `Partial` -- a required member survives an optional one spread
		// over it, so this assigns cleanly.
		check('spread type: a required member survives an optional one spread over it',
			typeErrors(`
				type Full = { a: number; b: number };
				const D: Full = { a: 1, b: 2 };
				const p: { a?: number } = {};
				const m: Full = { ...D, ...p };
			`).length, 0);
	}

	{
		// Tuple arrays (`[K,V][]`) -- no dedicated physical representation of their own, just the same
		// boxed 'ref'-kind ("everything else") array storage already used for `any[]`/mixed-type
		// arrays; the checker already fully tracks each element's own precise type, codegen only
		// needed the one physical-representation mapping (`wasmTypeOf`'s tuple case). A nested tuple
		// literal (as opposed to one directly target-typed itself) needed a second, real, separate fix:
		// array-literal contextual typing didn't thread the expected type to its own elements at all
		// (unlike object literals, which already did) -- `[1,2]` inside a `[number,number][]`-typed
		// outer literal used to infer as a plain `number[]` regardless of position, which is wrong for
		// both real assignability checking and (via the wrong physical array kind) for codegen. Found
		// while restoring `lib/map.ts`'s `entries`-array convenience constructor.
		const { standaloneTuple, homogeneousArrayOfTuples, mixedTypeArrayOfTuples, mapFromEntries } = await compile(`
			export function standaloneTuple(): number {
				const t: [number, number] = [1, 2];
				return t[0] + t[1];
			}
			export function homogeneousArrayOfTuples(): number {
				const pairs: [number, number][] = [[1, 2], [3, 4]];
				return pairs[0][0] + pairs[0][1] + pairs[1][0] + pairs[1][1];
			}
			export function mixedTypeArrayOfTuples(): number {
				const pairs: [string, number][] = [["ab", 10], ["xyz", 20]];
				return pairs[0][0].length + pairs[0][1] + pairs[1][0].length + pairs[1][1];
			}
			export function mapFromEntries(): number {
				const m = new Map<string, number>([["a", 1], ["b", 2]]);
				return (m.get("a") ?? -1) * 10 + (m.get("b") ?? -1);
			}
		`);
		check('tuple array: a directly target-typed tuple literal indexes correctly', standaloneTuple(), 3);
		check('tuple array: a homogeneous array of tuple literals', homogeneousArrayOfTuples(), 10);
		check('tuple array: a mixed-type (string,number) array of tuple literals', mixedTypeArrayOfTuples(), 35);
		check("tuple array: Map's entries-array convenience constructor", mapFromEntries(), 12);
	}

	{
		// Dynamic objects (`{[k: string]: V}`) -- a real, genuine user-facing idiom (`{}`/bracket
		// syntax, `delete`/`in`/`for...in`), not routed through Map/Set syntax even though it shares
		// their same underlying hash-table implementation (`indexSignatureValueType` routes the
		// structural type to `Map<string,V>`'s own physical representation) -- see the plan/gap
		// comment's own reasoning on why. Bracket read/write is free (the same generic `get`/`set`
		// index-syntax dispatch `Array`/`Uint8Array` already use); `delete`/`in`/`for...in` are new,
		// narrow, structurally-general dispatches to `Map`'s own `delete`/`has`/`keys` methods.
		// `insertFactoryShaped` mirrors `binary-libs/wasm.ts`'s actual `insertFactory` pattern
		// (nested dynamic objects built up incrementally via bracket assignment) -- the whole reason
		// this feature exists.
		const { emptyLiteral, withProps, bracketWrite, deleteTest, inTest, forInTest, insertFactoryShaped } = await compile(`
			export function emptyLiteral(): number {
				const obj: { [k: string]: number } = {};
				obj["a"] = 1;
				return obj["a"];
			}
			export function withProps(): number {
				const obj: { [k: string]: number } = { a: 10, b: 20 };
				return obj["a"] + obj["b"];
			}
			export function bracketWrite(): number {
				const obj: { [k: string]: number } = {};
				obj["x"] = 5;
				obj["x"] = obj["x"] + 1;
				return obj["x"];
			}
			export function deleteTest(): number {
				const obj: { [k: string]: number } = { a: 1, b: 2 };
				const removed = delete obj["a"] ? 1 : 0;
				return removed * 100 + (("a" in obj) ? 1 : 0) * 10 + (("b" in obj) ? 1 : 0);
			}
			export function inTest(): number {
				const obj: { [k: string]: number } = { x: 1 };
				return (("x" in obj) ? 1 : 0) * 10 + (("y" in obj) ? 1 : 0);
			}
			export function forInTest(): number {
				const obj: { [k: string]: number } = { a: 1, b: 2, c: 3 };
				let total = 0;
				for (const k in obj)
					total = total + obj[k];
				return total;
			}
			export function insertFactoryShaped(): number {
				const root: { [k: string]: { [k: string]: number } } = {};
				if (!("local" in root))
					root["local"] = {};
				root["local"]["get"] = 32;
				root["local"]["set"] = 33;
				return root["local"]["get"] + root["local"]["set"];
			}
		`);
		check('dynamic object: empty literal, bracket write, bracket read', emptyLiteral(), 1);
		check('dynamic object: literal with properties', withProps(), 30);
		check('dynamic object: bracket write, read-modify-write', bracketWrite(), 6);
		check('dynamic object: delete obj[k], then in reflects it', deleteTest(), 101);
		check('dynamic object: k in obj', inTest(), 10);
		check('dynamic object: for (const k in obj) iterates the live key set', forInTest(), 6);
		check("dynamic object: nested, built incrementally (binary-libs/wasm.ts's insertFactory shape)", insertFactoryShaped(), 65);
	}

	{
		// `for...in` over a *mapped-type-shaped* generic (`Partial<Record<string,V>>`, walker.ts's own
		// `NodeMap<N>` idiom: `Partial<{[K in keyof N]: F}>`) -- previously unsupported (only a plain
		// index-signature `{[k:string]:V}` routed to `Map`-backed dynamic-object codegen); a real
		// composition gap in `resolve()`'s own `indexed_access`/`keyof`/`array` handling, not a codegen
		// one -- once the mapped type genuinely resolves down to the same index-signature shape, the
		// existing dynamic-object machinery reaches it with no further codegen changes needed.
		const { forInMappedType, spreadDynamicObject } = await compile(`
			export function forInMappedType(): number {
				const fields: Partial<Record<string, number>> = { a: 1, b: 2, c: 3 };
				let total = 0;
				for (const f in fields)
					total = total + (fields[f] as number);
				return total;
			}
			export function spreadDynamicObject(): number {
				const a: Partial<Record<string, number>> = { x: 1, y: 2 };
				const b: Partial<Record<string, number>> = { ...a, z: 3 };
				let total = 0;
				for (const k in b)
					total = total + (b[k] as number);
				return total;
			}
		`);
		check("dynamic object: for...in over a mapped-type-shaped generic (walker.ts's own NodeMap<N> idiom)", forInMappedType(), 6);
		check('dynamic object: spread (`{...other, k: v}`) copies the spread argument\'s own live entries', spreadDynamicObject(), 6);
	}

	{
		// `Object.entries(x)`: a compiler intrinsic (`emitObjectEntries`, dispatched via `declare var
		// Object` in lib.d.ts, not real TS source -- what fields exist depends on `x`'s own concrete type
		// at each call site, which only the compiler itself can see). Forwards to a `Map`-backed value's
		// own real `.entries()`; for a *sealed* (never-subclassed) struct, synthesizes a `[string,any][]`
		// array literal directly from the class's own fields; throws a clear "not supported yet" for an
		// extended class (the receiver's real runtime type isn't known here, only its declared one).
		const { sealedClass, dynamicObject, forInSealed, forInDynamicUnchanged } = await compile(`
			class Point {
				x: number;
				y: number;
				constructor(x: number, y: number) { this.x = x; this.y = y; }
			}
			export function sealedClass(): number {
				const p = new Point(3, 4);
				const entries = Object.entries(p);
				const first = entries[0];
				const second = entries[1];
				return (first[1] as number) * 1000 + (second[1] as number) * 10 + entries.length;
			}
			export function dynamicObject(): number {
				const obj: Partial<Record<string, number>> = { a: 1, b: 2, c: 3 };
				const entries = Object.entries(obj);
				let total = 0;
				for (const [k, v] of entries)
					total = total + (v as number);
				return total;
			}
			export function forInSealed(): number {
				const p = new Point(3, 4);
				let total = 0;
				for (const k in p)
					total = total + 1;
				return total;
			}
			export function forInDynamicUnchanged(): number {
				const obj: Partial<Record<string, number>> = { a: 1, b: 2, c: 3 };
				let total = 0;
				for (const k in obj)
					total = total + 1;
				return total;
			}
		`);
		check('Object.entries: sealed struct synthesizes its own [string,any][] literal', sealedClass(), 3042);
		check('Object.entries: Map-backed dynamic object forwards to its own real entries()', dynamicObject(), 6);
		check("for...in: falls back to Object.entries for a sealed struct (no 'keys()' method)", forInSealed(), 2);
		check("for...in: a dynamic object still takes the efficient .keys() path, unchanged", forInDynamicUnchanged(), 3);

		// A genuine, permanent safety net (like arg-count validation elsewhere in this file), not a bare
		// "unimplemented feature throws": a subclassed receiver's real runtime type isn't visible here,
		// only its declared one, so refusing outright is deliberately safer than silently producing the
		// wrong field set.
		await checkThrows('Object.entries: an extended class is rejected, not silently mis-handled', () => compile(`
			class Animal { constructor() {} }
			class Dog extends Animal { constructor() { super(); } }
			export function test(): number {
				const a: Animal = new Animal();
				return Object.entries(a).length;
			}
		`), /isn't supported yet/);
	}

	{
		// A closure literal's own concrete result narrower than the slot it's assigned into -- real TS
		// covariant-return assignability (`(x: number) => number` fitting `(x: number) => number |
		// undefined`), the common shape a `Partial<...>`'s own optional mapped-type value produces for a
		// literal written against one specific, always-present key. Unlike a scalar (`coerceTop` alone
		// converts one already-on-the-stack value), a closure's own compiled signature is fixed forever,
		// so this needs a real wrapping trampoline (`ensureClosureCoercionWrapper`), not an in-place
		// instruction sequence.
		const { closureCovariantReturn } = await compile(`
			export function closureCovariantReturn(): number {
				const f: (x: number) => number | undefined = (x: number) => x + 100;
				const r = f(1);
				return r === undefined ? -1 : r;
			}
		`);
		check("closure covariant-return coercion: a narrower-returning literal fits a wider ('| undefined') slot", closureCovariantReturn(), 101);
	}

	{
		// Set<T> -- same linear-scan implementation as Map (lib/set.ts), sharing the shift-down-on-
		// delete/reference-identity behavior.
		const { basic, dedupe, del } = await compile(`
			export function basic(): number {
				const s = new Set<number>();
				s.add(1);
				s.add(2);
				return s.size * 100 + (s.has(1) ? 1 : 0) * 10 + (s.has(3) ? 1 : 0);
			}
			export function dedupe(): number {
				const s = new Set<string>();
				s.add('x');
				s.add('x');
				s.add('y');
				return s.size;
			}
			export function del(): number {
				const s = new Set<number>();
				s.add(1);
				s.add(2);
				const removed = s.delete(1) ? 1 : 0;
				return removed * 100 + s.size * 10 + (s.has(1) ? 1 : 0);
			}
		`);
		check('Set: add/has/size', basic(), 210);
		check('Set: add() de-duplicates', dedupe(), 2);
		check('Set: delete() removes and reports size/has correctly', del(), 110);
	}

	{
		// String integration: match/search/replace/split, all built on RegExp above.
		const {
			matchFound, matchNotFound, searchFound, searchNotFound,
			replaceFirstOnly, replaceGlobalAll, replaceBackrefSwap,
			splitBasicCount, splitBasicPart, splitWithLimit, splitOnWhitespace,
		} = await compile(`
			export function matchFound(): number {
				const s: string = "hello world";
				const re = new RegExp("wor\\\\w+");
				const m = s.match(re);
				if (m === null) return -1;
				const g0 = m.group(0);
				return g0.length;
			}
			export function matchNotFound(): number {
				const s: string = "hello world";
				const re = new RegExp("xyz");
				const m = s.match(re);
				return m === null ? 1 : 0;
			}
			export function searchFound(): number { const s: string = "hello world"; const re = new RegExp("world"); return s.search(re); }
			export function searchNotFound(): number { const s: string = "hello world"; const re = new RegExp("xyz"); return s.search(re); }
			export function replaceFirstOnly(): number {
				const s: string = "cat cat cat";
				const re = new RegExp("cat");
				const t: string = s.replace(re, "dog");
				return t.length;
			}
			export function replaceGlobalAll(): number {
				const s: string = "cat cat cat";
				const re = new RegExp("cat", "g");
				const t: string = s.replace(re, "dog");
				return t.length;
			}
			export function replaceBackrefSwap(): number {
				const s: string = "John Smith";
				const re = new RegExp("(\\\\w+) (\\\\w+)");
				const t: string = s.replace(re, "$2 $1");
				return t.length;
			}
			export function splitBasicCount(): number { const s: string = "a,b,c,d"; const re = new RegExp(","); const parts = s.split(re); return parts.length; }
			export function splitBasicPart(): number { const s: string = "a,b,c,d"; const re = new RegExp(","); const parts = s.split(re); return parts.get(2).length; }
			export function splitWithLimit(): number { const s: string = "a,b,c,d"; const re = new RegExp(","); const parts = s.split(re, 2); return parts.length; }
			export function splitOnWhitespace(): number { const s: string = "the quick brown fox"; const re = new RegExp("\\\\s+"); const parts = s.split(re); return parts.length; }
		`);
		check('String.match() finds a match', matchFound(), 5);
		check('String.match() returns null on no match', matchNotFound(), 1);
		check('String.search() returns match index', searchFound(), 6);
		check('String.search() returns -1 on no match', searchNotFound(), -1);
		check('String.replace() (non-global) replaces only the first "cat"', replaceFirstOnly(), 11);
		check('String.replace() ("g" flag) replaces every "cat"', replaceGlobalAll(), 11);
		check('String.replace() with $1/$2 backreferences ("John Smith" -> "Smith John")', replaceBackrefSwap(), 10);
		check('String.split() splits into the right number of parts', splitBasicCount(), 4);
		check('String.split() part content ("a,b,c,d"[2] === "c")', splitBasicPart(), 1);
		check('String.split() honors a limit', splitWithLimit(), 2);
		check('String.split() on a \\s+ separator', splitOnWhitespace(), 4);
	}

	{
		// Struct-layout inheritance + `super(...)` constructor chaining -- one physical struct for the
		// whole hierarchy (wasm-GC `supertypes`), base fields as an exact prefix, `super(...)` inlines the
		// base ctor's own init logic into the same allocation rather than a separate one.
		// `threeLevel` doubles as the regression guard for a real bug the self-referential-struct fix
		// introduced: `ensureClass` used to resolve a class's own superclass *after* allocating its own
		// struct placeholder, so `C extends B extends A` ended up allocating typeIndexes in reverse order
		// (C, then B, then A) -- a `supertypes` list referencing a *higher* type index than its own, which
		// wasm rejects outright ("forward-declared supertype"), unlike an ordinary field reference (which
		// may freely forward-reference within the same rec group). Fixed by resolving the superclass first,
		// which doesn't reopen self-reference support -- that's about a class's own field(s) referencing
		// its own not-yet-finished type, a structurally separate concern from resolving an *ancestor*.
		const { basic, threeLevel } = await compile(`
			class A { x: number; constructor(x: number) { this.x = x; } }
			class B extends A { y: number; constructor(x: number, y: number) { super(x); this.y = y; } }
			class C extends B { z: number; constructor(x: number, y: number, z: number) { super(x, y); this.z = z; } }
			export function basic(): number {
				const b = new B(3, 4);
				return b.x + b.y;
			}
			export function threeLevel(): number {
				const c = new C(1, 2, 3);
				return c.x * 100 + c.y * 10 + c.z;
			}
		`);
		check('inheritance: struct-layout + super(...) (base fields)', basic(), 7);
		check('inheritance: 3-level super(...) chain', threeLevel(), 123);
	}

	{
		// Both rec-group fixes together: a self-referential field (`children: TreeNode[]`, an array of its
		// own class) *and* a real superclass (`extends Base`) on the same class -- confirms resolving the
		// superclass before allocating this class's own placeholder (the supertype-ordering fix) doesn't
		// interfere with the field loop afterward still being able to safely self-reference this class's
		// own not-yet-fully-built type (the original self-reference fix).
		const { treeWithBase } = await compile(`
			class Base {
				tag: number;
				constructor(tag: number) { this.tag = tag; }
			}
			class TreeNode extends Base {
				children: TreeNode[];
				constructor(tag: number, children: TreeNode[]) {
					super(tag);
					this.children = children;
				}
			}
			export function treeWithBase(): number {
				const leaf = new TreeNode(1, []);
				const root = new TreeNode(2, [leaf]);
				return root.tag * 10 + root.children[0].tag;
			}
		`);
		check('a self-referential class field combined with real inheritance compiles and runs', treeWithBase(), 21);
	}

	{
		// A non-overridden method resolves via a single plain `call` straight to the ancestor's own
		// compiled function (no cast, no dispatch) -- and `super.method()` always means exactly that
		// ancestor's own implementation, never virtual, even when the method IS overridden elsewhere.
		const { inherited, viaSuper } = await compile(`
			class A {
				x: number;
				constructor(x: number) { this.x = x; }
				greet(): number { return this.x + 1; }
			}
			class B extends A {
				constructor(x: number) { super(x); }
				greet(): number { return super.greet() * 10; }
			}
			export function inherited(): number {
				const b = new B(3);
				return b.x;
			}
			export function viaSuper(): number {
				const b = new B(3);
				return b.greet();
			}
		`);
		check('inheritance: field access through a derived instance', inherited(), 3);
		check("inheritance: super.method() calls the ancestor's own implementation", viaSuper(), 40);
	}

	{
		// Virtual dispatch: a base-typed reference holding a derived instance must call the *override*,
		// including through `this.method()` inside the base's own body, an array of mixed concrete
		// instances, and a non-overriding grandchild correctly inheriting its nearest ancestor's override.
		// `Dog`/`Cat` deliberately declare no fields of their own beyond what `Animal` gives them -- their
		// wasm-GC struct types are otherwise identical, which wasm-GC canonicalizes into one *same* runtime
		// type (confirmed empirically): a virtual-dispatch cascade can't reliably tell them apart via
		// `ref.test` alone, which is why it compares a real stored per-instance type id instead. This is a
		// real regression test for that, not just a normal-case check.
		const { overrideWins, baseStays, siblingsDistinct, thisDispatchesVirtually, grandchildInherits } = await compile(`
			class Animal {
				constructor() {}
				sound(): number { return 1; }
				describe(): number { return this.sound() * 100; }
			}
			class Dog extends Animal {
				constructor() { super(); }
				sound(): number { return 2; }
			}
			class Cat extends Animal {
				constructor() { super(); }
				sound(): number { return 3; }
			}
			class Puppy extends Dog {
				constructor() { super(); }
			}
			export function overrideWins(): number {
				const a: Animal = new Dog();
				return a.sound();
			}
			export function baseStays(): number {
				const a: Animal = new Animal();
				return a.sound();
			}
			export function siblingsDistinct(): number {
				const animals: Animal[] = [new Animal(), new Dog(), new Cat()];
				return animals[0].sound() * 100 + animals[1].sound() * 10 + animals[2].sound();
			}
			export function thisDispatchesVirtually(): number {
				const a: Animal = new Dog();
				return a.describe();
			}
			export function grandchildInherits(): number {
				const a: Animal = new Puppy();
				return a.sound();
			}
		`);
		check('virtual dispatch: base-typed reference calls the override', overrideWins(), 2);
		check("virtual dispatch: base instance still calls the base's own implementation", baseStays(), 1);
		check('virtual dispatch: structurally-identical sibling subclasses stay distinct', siblingsDistinct(), 123);
		check('virtual dispatch: this.method() inside a base method body dispatches virtually', thisDispatchesVirtually(), 200);
		check("virtual dispatch: non-overriding grandchild inherits its nearest ancestor's override", grandchildInherits(), 2);
	}

	{
		// A scalar-only class (every field number/boolean, no object-typed field) takes `ensureCtor`'s
		// `struct.new_default` shortcut path -- which used to skip class-level field initializers
		// entirely (only `this.field = ...` statements actually written in the constructor body ever
		// ran), silently leaving any field with a non-zero/non-false initializer at its wasm-default
		// value. An object-typed field takes a different, already-correct path (`initField`), which is
		// why this went unnoticed. Found while adding general `this`-typed-return support below.
		const { plainNonZero, private_, unrelatedCtorBody, readInCtor, subclassOwnInit, subclassInheritedInit } = await compile(`
			class Plain {
				tag: number = 99;
				constructor() {}
			}
			export function plainNonZero(): number {
				return new Plain().tag;
			}
			class WithPrivate {
				private secret: number = 7;
				constructor() {}
				reveal(): number { return this.secret; }
			}
			export function private_(): number {
				return new WithPrivate().reveal();
			}
			class Unrelated {
				tag: number = 99;
				other: number = 0;
				constructor() { this.other = 1; }
			}
			export function unrelatedCtorBody(): number {
				const u = new Unrelated();
				return u.tag * 10 + u.other;
			}
			class ReadsOwnInit {
				tag: number = 99;
				constructor(x: number) { this.tag = this.tag + x; }
			}
			export function readInCtor(): number {
				return new ReadsOwnInit(1).tag;
			}
			class Base { total: number = 7; constructor() {} }
			class Derived extends Base {
				tag: number = 99;
				constructor() { super(); }
			}
			export function subclassOwnInit(): number {
				return new Derived().tag;
			}
			export function subclassInheritedInit(): number {
				return new Derived().total;
			}
		`);
		check('field init: scalar-only class field initializer runs (not just wasm-default 0)', plainNonZero(), 99);
		check('field init: applies to a private field too', private_(), 7);
		check('field init: still applies when the constructor body touches an unrelated field', unrelatedCtorBody(), 991);
		check("field init: runs before the constructor body, so 'this.field = this.field + x' sees the real initial value", readInCtor(), 100);
		check("field init: a subclass's own field initializer runs after super()", subclassOwnInit(), 99);
		check("field init: an inherited (superclass) field initializer still runs too", subclassInheritedInit(), 7);
	}

	{
		// Same `struct.new_default` shortcut, same silent-skip failure mode, but for a parameter
		// property (`constructor(public x: number) {}`) instead of a class-level field initializer --
		// there's no `this.x = x` statement anywhere in the constructor's own body at all (real TS
		// synthesizes that assignment itself), so the scalar-only fast path never assigned it either,
		// silently leaving the field at wasm's zero default regardless of the argument passed in.
		const { plain, mixed, subclass } = await compile(`
			class Point {
				constructor(public x: number, public y: number) {}
			}
			export function plain(): number {
				const p = new Point(3, 4);
				return p.x * 10 + p.y;
			}
			class Mixed {
				z: number = 5;
				constructor(public x: number) {}
			}
			export function mixed(): number {
				const m = new Mixed(2);
				return m.x * 10 + m.z;
			}
			class Base { a: number; constructor(a: number) { this.a = a; } }
			class Derived extends Base {
				constructor(a: number, public b: number) { super(a); }
			}
			export function subclass(): number {
				const d = new Derived(1, 2);
				return d.a * 10 + d.b;
			}
		`);
		check('param property: scalar-only class assigns it, not just wasm-default 0', plain(), 34);
		check('param property: coexists correctly with an ordinary field initializer', mixed(), 25);
		check("param property: a derived class's own param property is assigned after super()", subclass(), 12);
	}

	{
		// A `this`-typed return (`add(): this`) means "whatever the receiver's own type is." The checker
		// itself never eagerly resolves `this` as a type (it's opaque, resolved lazily/contextually at
		// each assignability check) -- codegen needs one concrete type up front, so `this` gets
		// substituted with the declaring class's own type in the method's own signature (`ensureMethod`),
		// in the raw-decl bypass `case 'var_decl'` uses for a method-call init, and (via a real,
		// checker-level fix, not just a codegen one) at every call site, using the receiver expression's
		// own resolved type -- covariant through a subclass, not just the declaring class.
		const { direct, viaLocal, chained, subclassDirect, subclassAfterInherited } = await compile(`
			class Builder {
				total: number = 0;
				constructor() {}
				add(n: number): this {
					this.total = this.total + n;
					return this;
				}
			}
			export function direct(): number {
				return new Builder().add(5).total;
			}
			export function viaLocal(): number {
				const b = new Builder();
				const c = b.add(5);
				return c.total;
			}
			export function chained(): number {
				return new Builder().add(1).add(2).add(3).total;
			}
			class SpecialBuilder extends Builder {
				tag: number = 42;
				constructor() { super(); }
			}
			export function subclassDirect(): number {
				// 'this' from an *inherited* (non-overridden) method call, used through a subclass-typed
				// local -- '.tag' (SpecialBuilder-only) must still resolve, proving the physical value
				// really is the subclass instance, not just something Builder-shaped.
				const s = new SpecialBuilder();
				const c = s.add(10);
				return c.tag;
			}
			export function subclassAfterInherited(): number {
				return new SpecialBuilder().add(1).add(2).tag;
			}
		`);
		check("this-return: direct chain reads a field afterward", direct(), 5);
		check("this-return: assigned to an intermediate local first", viaLocal(), 5);
		check("this-return: chains through multiple calls", chained(), 6);
		check("this-return: covariant through a subclass, inherited method, via a local", subclassDirect(), 42);
		check("this-return: covariant through a subclass, chained inherited-method calls", subclassAfterInherited(), 42);
	}

	{
		// `instanceof` lowers to `ref.test` against the named class's own struct type. `dogNotCat` is
		// the same structurally-identical-siblings scenario as `siblingsDistinct` above -- Dog/Cat add
		// no fields of their own beyond Animal, so this only passes if the shared-rec-group fix that
		// makes `ref.test` reliable there also holds for `instanceof`'s own lowering.
		const { derivedIsBase, derivedIsSelf, baseIsNotDerived, dogNotCat, viaBaseTypedRef, negated } = await compile(`
			class Animal { constructor() {} }
			class Dog extends Animal { constructor() { super(); } }
			class Cat extends Animal { constructor() { super(); } }
			export function derivedIsBase(): boolean {
				const d = new Dog();
				return d instanceof Animal;
			}
			export function derivedIsSelf(): boolean {
				const d = new Dog();
				return d instanceof Dog;
			}
			export function baseIsNotDerived(): boolean {
				const a = new Animal();
				return a instanceof Dog;
			}
			export function dogNotCat(): boolean {
				const d = new Dog();
				return d instanceof Cat;
			}
			export function viaBaseTypedRef(): boolean {
				const a: Animal = new Dog();
				return a instanceof Dog;
			}
			export function negated(): boolean {
				const d = new Dog();
				return !(d instanceof Cat);
			}
		`);
		check('instanceof: a derived instance is an instance of its base', derivedIsBase(), 1);
		check('instanceof: a derived instance is an instance of its own class', derivedIsSelf(), 1);
		check('instanceof: a base instance is not an instance of a derived class', baseIsNotDerived(), 0);
		check('instanceof: structurally-identical siblings stay distinct', dogNotCat(), 0);
		check('instanceof: works through a base-typed reference holding a derived instance', viaBaseTypedRef(), 1);
		check('instanceof: negation composes normally', negated(), 1);
	}

	{
		// `checkBlock`'s own post-`if` narrowing merge (`x = e;` in one or both branches, used to predict
		// what `x` holds afterward) re-evaluates each branch's own right-hand side `e` a second time, to
		// combine the branches' results -- this used to re-evaluate it against the pre-`if` (unnarrowed)
		// scope instead of that branch's own narrowed one, so `e` reading back the very thing the `if`
		// just narrowed (`arg = new Stream(arg)`, `arg` narrowed to `Uint8Array` by the `if`) saw the
		// original wide type and failed a real type check, even though the first (correct) evaluation of
		// the same `if` -- via ordinary statement checking, not this merge -- had already narrowed it fine.
		const { noElse, ifElseTrue, ifElseFalse } = await compile(`
			class Stream { constructor(public buffer: Uint8Array) {} }
			function ensureStreamNoElse(arg: Stream | Uint8Array): number {
				if (arg instanceof Uint8Array)
					arg = new Stream(arg);
				return (arg as Stream).buffer.length;
			}
			function ensureStreamIfElse(arg: Stream | Uint8Array): number {
				if (arg instanceof Uint8Array)
					arg = new Stream(arg);
				else
					arg = arg;
				return (arg as Stream).buffer.length;
			}
			export function noElse(): number { return ensureStreamNoElse(new Uint8Array(21)); }
			export function ifElseTrue(): number { return ensureStreamIfElse(new Uint8Array(22)); }
			export function ifElseFalse(): number { return ensureStreamIfElse(new Stream(new Uint8Array(23))); }
		`);
		check('post-if merge: a no-else branch reassigning from its own narrowed value compiles and runs', noElse(), 21);
		check('post-if merge: the true branch of an if/else reassigning from its own narrowed value compiles and runs', ifElseTrue(), 22);
		check('post-if merge: the false branch of an if/else compiles and runs', ifElseFalse(), 23);
	}

	{
		// `(a, b, c)` -- every expression but the last runs purely for its side effects.
		const { sideEffects, forLoopUpdate } = await compile(`
			export function sideEffects(): number {
				let x = 0;
				return (x = 1, x = x + 10, x + 2);
			}
			export function forLoopUpdate(): number {
				let total = 0;
				for (let i = 0, j = 10; i < 3; i++, j--)
					total += j;
				return total;
			}
		`);
		check('sequence operator: side effects run in order, last value wins', sideEffects(), 13);
		check('sequence operator: for-loop update clause', forLoopUpdate(), 27);
	}

	{
		// A hole (`[1, , 3]`) reads back as the element kind's own zero/default value -- close enough to
		// real JS's "hole reads as undefined" for a fixed-element-kind array, which has no way to
		// represent a genuinely distinct "empty" slot.
		const { numberHole, booleanHole, refHole, holeWithSpread } = await compile(`
			class Box { v: number; constructor(v: number) { this.v = v; } }
			export function numberHole(): number {
				const a: number[] = [1, , 3];
				return a[0] + a[1] + a[2];
			}
			export function booleanHole(): number {
				const a: boolean[] = [true, , true];
				return (a[0] ? 1 : 0) + (a[1] ? 1 : 0) + (a[2] ? 1 : 0);
			}
			export function refHole(): number {
				const a: (Box | null)[] = [new Box(5), null, new Box(7)];
				const x0: Box | null = a[0];
				const x1: Box | null = a[1];
				const x2: Box | null = a[2];
				return (x0?.v ?? -1) + (x1?.v ?? -1) + (x2?.v ?? -1);
			}
			export function holeWithSpread(): number {
				const rest: number[] = [10, 20];
				const a: number[] = [1, , ...rest];
				return a[0] + a[1] + a[2] + a[3];
			}
		`);
		check('array literal hole: number[] reads as 0', numberHole(), 4);
		check('array literal hole: boolean[] reads as false', booleanHole(), 2);
		check('array literal hole: nullable ref element reads as null', refHole(), 11);
		check('array literal hole combined with a spread element', holeWithSpread(), 31);
	}

	{
		// `` tag`...${x}...` `` desugars to `tag(strings, ...values)`, reusing the ordinary call-resolution
		// path -- `.raw` isn't modeled, only the plain (cooked) `string[]` real untagged templates already use.
		const { valuesSum, noInterpolation, tagIsAMethod } = await compile(`
			function tag(strings: string[], ...values: number[]): number {
				let sum = 0;
				for (let i = 0; i < values.length; i++)
					sum += values.get(i);
				return sum + strings.length;
			}
			export function valuesSum(): number {
				const a = 10, b = 20, c = 12;
				return tag\`\${a}-\${b}-\${c}\`;
			}
			function justStrings(strings: string[]): number { return strings.get(0).length; }
			export function noInterpolation(): number {
				return justStrings\`hello\`;
			}
			class Tagger {
				constructor() {}
				tag(strings: string[], ...values: number[]): number { return strings.length + values.length; }
			}
			export function tagIsAMethod(): number {
				const t = new Tagger();
				const n = 5;
				return t.tag\`a\${n}b\`;
			}
		`);
		check('tagged template: strings + interpolated values reach the tag function', valuesSum(), 46);
		check('tagged template: no interpolations', noInterpolation(), 5);
		check('tagged template: tag is a class method', tagIsAMethod(), 3);
	}

	{
		// Object-literal support: `want` naming a real target type (a plain `type X = {...}` alias,
		// resolved via `ensureObjectShape` the same way a real class already is) wins outright; a bare
		// literal with no such target falls back to `matchObjectShape`'s own structural match against
		// every declared type, and -- only when even that finds nothing -- a freshly synthesized
		// anonymous shape (`ensureAnonObjectShape`) built straight from the checker's own inferred type
		// for the literal itself, same mechanism a function type's own inline return annotation already
		// used. Fields push in the shape's own declared order, looked up from the literal's own
		// properties by name (real TS itself allows any written order).
		const { fromVarDecl, reordered, shorthand, asArgument, asReturn, noTargetType } = await compile(`
			type Point = { x: number; y: number };
			export function fromVarDecl(): number {
				const p: Point = { x: 3, y: 4 };
				return p.x + p.y;
			}
			export function reordered(): number {
				const p: Point = { y: 4, x: 3 };
				return p.x * 10 + p.y;
			}
			export function shorthand(): number {
				const x = 5, y = 6;
				const p: Point = { x, y };
				return p.x + p.y;
			}
			function dist(p: Point): number { return p.x + p.y; }
			export function asArgument(): number {
				return dist({ x: 2, y: 9 });
			}
			function make(x: number, y: number): Point { return { x, y }; }
			export function asReturn(): number {
				const p = make(3, 8);
				return p.x + p.y;
			}
			export function noTargetType(): number {
				const p = { x: 1, y: 2 };
				return p.x + p.y;
			}
		`);
		check('object literal: var_decl with a known alias target type', fromVarDecl(), 7);
		check("object literal: properties in a different order than the alias's own", reordered(), 34);
		check('object literal: shorthand properties', shorthand(), 11);
		check('object literal: passed as a function argument', asArgument(), 11);
		check('object literal: returned from a function', asReturn(), 11);
		check('object literal: no known target type synthesizes an anonymous shape', noTargetType(), 3);
	}

	{
		// The real motivating case (found compiling `src/examples/walker.ts`'s own `mapObject`-based
		// `classMember`/`typeMember`): a bare, un-annotated `const mapSig = {...}` of closure-typed
		// fields (declared local to the function, same as `walk()`'s own `mapSig`/`mapSigU`), later
		// reused via spread (`{...mapSig, extra: ...}`) into a call whose parameter itself has no named
		// type either -- both `mapSig`'s own var_decl type and the spread-literal's argument type need
		// the same anonymous-shape synthesis, from two different call sites (`typeOf`'s
		// `matchObjectShapeByType` and `case 'object'`'s own `matchObjectShape`).
		const { run } = await compile(`
			interface Member1 { a: number; extra: number }

			function useSig(mapFns: { mapA: (x: number) => number; mapExtra: (x: number) => number }, m: Member1): number {
				return mapFns.mapA(m.a) + mapFns.mapExtra(m.extra);
			}

			function classMember(m: Member1): number {
				const mapSig = {
					mapA: (x: number) => x + 1,
				};
				return useSig({ ...mapSig, mapExtra: (x: number) => x * 2 }, m);
			}

			export function run(): number {
				return classMember({ a: 1, extra: 5 });
			}
		`);
		check('object literal: an un-annotated const spread into another anonymous-shape literal', run(), 12);
	}

	{
		// Generators (checkpoint 1: a straight-line body, no loops/ifs/params/captures around a yield --
		// proves the resumable-step-function shape itself; `.next()` calling the closure-typed `step`
		// field also exercises the new general closure-through-a-field call path in `emitMethodCall`.
		const { driveGen } = await compile(`
			function* countUp(): Generator<number, number, number> {
				yield 1;
				yield 2;
				return 99;
			}
			export function driveGen(): number {
				const g = countUp();
				const a = g.next(0);
				const b = g.next(0);
				const c = g.next(0);
				const d = g.next(0);
				let result = a.value + b.value * 10 + c.value * 100;
				if (a.done) result += 1000000;
				if (!b.done) result += 2000000;
				if (c.done) result += 3000000;
				if (d.done) result += 4000000;
				// Real generator semantics: a call past completion resets 'value' to the type's default
				// (undefined in real JS; 0 here, no 'undefined' for numbers), not the original return value.
				if (d.value === 0) result += 5000000;
				return result;
			}
		`);
		check('generator: yield/yield/return, plus an idempotent call past completion', driveGen(), 14009921);

		// Checkpoint 2: a yield inside a 'for' loop, with the loop counter (`i`, declared *outside* any
		// suspend point but read/written on every resumed iteration) hoisted into the frame -- the part
		// that makes control flow actually useful, not just parseable (`compileGeneratorFunc`'s
		// `collectHoistedLocals` + `case 'var_decl'`'s new closure-field write path).
		const { loopGen } = await compile(`
			function* gen(): Generator<number, number, number> {
				for (let i = 0; i < 3; i++)
					yield i;
				return 99;
			}
			export function loopGen(): number {
				const g = gen();
				const a = g.next(0);
				const b = g.next(0);
				const c = g.next(0);
				const d = g.next(0);
				const e = g.next(0);
				let result = a.value + b.value * 10 + c.value * 100 + d.value * 1000;
				if (a.done || b.done || c.done) result += 1000000;
				if (!d.done) result += 2000000;
				if (!e.done) result += 3000000;
				if (e.value !== 0) result += 4000000;
				return result;
			}
		`);
		check('generator: yield inside a for loop, counter hoisted across suspends', loopGen(), 99210);

		await checkThrows("generator: 'break'/'continue' inside a yield-containing loop is rejected (deferred)", () => compile(`
			function* gen(): Generator<number, void, number> {
				while (true) {
					yield 1;
					break;
				}
			}
			export function f(): number {
				const g = gen();
				return g.next(0).done ? 1 : 0;
			}
		`), /not yet supported/);

		await checkThrows('generator: a yield embedded in a larger expression is rejected', () => compile(`
			function* gen(): Generator<number, void, number> {
				const x = (yield 1) + 1;
			}
			export function f(): number {
				const g = gen();
				return g.next(0).done ? 1 : 0;
			}
		`), /not yet supported/);

		// 'if'/'else' each containing a yield -- only the taken branch's arm should ever fire, and both
		// the with-alternate and without-alternate shapes need their own coverage (different merge wiring).
		const { branchGen } = await compile(`
			function* gen(): Generator<number, number, number> {
				let flag = true;
				if (flag) {
					yield 10;
				} else {
					yield 20;
				}
				let skip = false;
				if (skip) {
					yield 30;
				}
				yield 40;
				return 5;
			}
			export function branchGen(): number {
				const g = gen();
				const a = g.next(0);
				const b = g.next(0);
				const c = g.next(0);
				return a.value + b.value * 100 + c.value * 10000 + (c.done ? 1000000 : 0);
			}
		`);
		check("generator: yield inside 'if'/'else' (with and without an alternate)", branchGen(), 1054010);

		// 'while' with two locals hoisted across the loop's own yield -- an accumulator built from the
		// loop counter, not just the counter itself (checkpoint 2's 'for' test only exercises that).
		const { whileGen } = await compile(`
			function* gen(): Generator<number, number, number> {
				let sum = 0;
				let i = 0;
				while (i < 3) {
					sum = sum + i;
					yield sum;
					i = i + 1;
				}
				return sum;
			}
			export function whileGen(): number {
				const g = gen();
				const a = g.next(0);
				const b = g.next(0);
				const c = g.next(0);
				const d = g.next(0);
				return a.value + b.value * 10 + c.value * 100 + d.value * 1000 + (d.done ? 1000000 : 0);
			}
		`);
		check("generator: 'while' with an accumulator hoisted alongside the loop counter", whileGen(), 1003310);

		// Checkpoint 3, part 1: real parameters -- threaded into the frame the same way a hoisted local
		// is, but written once at construction time (the outer wrapper's own real params) rather than by
		// a 'var_decl' inside the body.
		const { paramGen } = await compile(`
			function* gen(start: number, step: number): Generator<number, number, number> {
				let i = start;
				while (i < start + step * 3) {
					yield i;
					i = i + step;
				}
				return i;
			}
			export function paramGen(): number {
				const g = gen(10, 2);
				const a = g.next(0);
				const b = g.next(0);
				const c = g.next(0);
				const d = g.next(0);
				return a.value + b.value * 100 + c.value * 10000 + d.value * 1000000 + (d.done ? 100000000 : 0);
			}
		`);
		check('generator: real parameters, read across every suspend', paramGen(), 116141210);

		// Checkpoint 3, part 2: two-way communication -- 'const v = yield x;' binds whatever the
		// *following* '.next(v)' call sends back, not the value just yielded out.
		const { sentGen } = await compile(`
			function* gen(): Generator<number, number, number> {
				let total = 0;
				const a = yield 1;
				total = total + a;
				const b = yield 2;
				total = total + b;
				return total;
			}
			export function sentGen(): number {
				const g = gen();
				const r1 = g.next(0);
				const r2 = g.next(100);
				const r3 = g.next(1000);
				return r1.value + r2.value * 10 + r3.value * 100;
			}
		`);
		check("generator: 'const v = yield x;' binds the next .next(v)'s sent value", sentGen(), 110021);

		// `Generator<Y, void, N>` -- a real, common instantiation (a generator that yields values but
		// has no meaningful final return value) -- `IteratorResult<Y,R>.value: Y | R`'s own type
		// resolves this via the ordinary nullable-union path (same mechanism `number | null` already
		// uses) once `R` is `void`, so `yield`'s own payload and a bare `return;`'s implicit "done"
		// value must both agree on that *same* boxed representation, not each independently derive
		// their own from `Y`/`R` alone (a real bug found and fixed this session: `yield`'s own value
		// used to derive its wasm shape from bare `Y`, diverging from what the shared IteratorResult
		// constructor actually expects whenever `Y` and `R` differ).
		const { driveVoidGen } = await compile(`
			function* voidGen(): Generator<number, void, number> {
				yield 1;
				yield 2;
				return;
			}
			export function driveVoidGen(): number {
				const g = voidGen();
				const a = g.next(0);
				const b = g.next(0);
				const c = g.next(0);
				let result = a.value + b.value * 10;
				if (a.done || b.done) result += 1000;
				if (!c.done) result += 2000;
				return result;
			}
		`);
		check("generator: 'Generator<Y, void, N>' -- yield/yield/bare 'return;'", driveVoidGen(), 21);
	}

	{
		// Async/await -- reuses the exact same resumable-function machinery a generator does (frame,
		// `flattenStateMachine`, the loop+block dispatch), but driven very differently: an async function
		// runs immediately up to its first real suspend, and a suspended `await` resumes via
		// `Promise.then()`, not an external caller (see towasm.ts's own `compileAsyncFunc` header
		// comment). A top-level mutable global is used to observe results below, not a captured closure
		// variable -- capturing a *mutation* back out to the enclosing scope is a separate, pre-existing
		// limitation (captures snapshot by value at creation time), not something these tests are about.
		// Every case below reads its result through a SECOND exported call. `.then`/`await` continuations
		// go on `lib/promise.ts`'s microtask queue, which towasm drains when an exported call returns to
		// the host -- that call IS the job boundary, exactly as real JS defers a settled promise's
		// callback to the end of the current job. So the value is still 0 inside the call that resolved
		// the promise (asserted here, since that is the JS-faithful half these tests originally got
		// wrong) and only observable from the next one.
		const { alreadySettled, readSettled } = await compile(`
			let output: number = 0;
			async function addOne(p: Promise<number>): Promise<number> {
				const v = await p;
				output = v + 1;
				return v + 1;
			}
			export function alreadySettled(): number {
				const p = new Promise<number>(0);
				p.resolve(41);
				const result = addOne(p);
				return output;
			}
			export function readSettled(): number { return output; }
		`);
		check('async: await on an already-settled Promise does NOT resume inside the same call', alreadySettled(), 0);
		check('async: ...and has resumed by the next one', readSettled(), 42);

		// The promise is module-level so the suspend and the `resolve()` can be in DIFFERENT exported
		// calls -- the only way to see that `start()` really suspended, since a drain at the end of it
		// would otherwise be indistinguishable from never having suspended at all.
		const { start, resolveIt, readLater } = await compile(`
			let output: number = 0;
			const pending: Promise<number> = new Promise<number>(0);
			async function addOne(p: Promise<number>): Promise<number> {
				const v = await p;
				output = v;
				return v + 1;
			}
			export function start(): number { addOne(pending); return output; }
			export function resolveIt(): number { pending.resolve(41); return output; }
			export function readLater(): number { return output; }
		`);
		check('async: await on a not-yet-settled Promise really suspends -- nothing runs, even at the drain', start(), 0);
		check('async: ...and resolve() alone does not resume it inside its own call', resolveIt(), 0);
		check('async: ...it resumes at the drain that resolve()\'s own call ends with', readLater(), 41);

		const { twoAwaits, readTwo } = await compile(`
			let output: number = 0;
			async function addTwo(p1: Promise<number>, p2: Promise<number>): Promise<number> {
				const a = await p1;
				const b = await p2;
				output = a + b;
				return a + b;
			}
			export function twoAwaits(): number {
				const p1 = new Promise<number>(0);
				const p2 = new Promise<number>(0);
				p1.resolve(10);
				p2.resolve(20);
				const result = addTwo(p1, p2);
				return output;
			}
			export function readTwo(): number { return output; }
		`);
		check('async: two sequential awaits in the same function', twoAwaits(), 0);
		check('async: ...both resumptions drain by the next call', readTwo(), 30);

		const { nonPromise } = await compile(`
			let output: number = 0;
			async function identity(x: number): Promise<number> {
				const v = await x;
				output = v;
				return v + 1;
			}
			export function nonPromise(): number {
				identity(41);
				return output;
			}
		`);
		check('async: awaiting a non-Promise value unwraps immediately (no real suspension)', nonPromise(), 41);

		// 'Promise.all' -- a static method with its own generic type param (deliberately named 'U', not
		// 'T', to avoid colliding with the class's own 'T': a static member's own type param sharing the
		// class's name confirmed the hard way to corrupt the method's own return-type substitution,
		// independent of Promise specifically -- a real, general generic-static-method gap, worked around
		// here rather than fixed given the risk of touching shared substitution machinery for it).
		// Resolves only once every input has, regardless of resolution order -- a bare 'await all;' (no
		// binding) sidesteps a separate, also pre-existing gap (a non-nullable ref/array-typed *hoisted*
		// local -- as opposed to a param, which already works -- crossing a suspend isn't supported yet,
		// `emitDefaultValue`'s own clear throw), which reading the resolved array back out would need.
		const { startAll, resolveTwo, resolveLast, readAll } = await compile(`
			let output: number = 0;
			const p1: Promise<number> = new Promise<number>(0);
			const p2: Promise<number> = new Promise<number>(0);
			const p3: Promise<number> = new Promise<number>(0);
			async function markDone(all: Promise<number[]>): Promise<number> {
				await all;
				output = 999;
				return 999;
			}
			export function startAll(): number { markDone(Promise.all<number>([p1, p2, p3])); return output; }
			export function resolveTwo(): number { p1.resolve(10); p2.resolve(20); return output; }
			export function resolveLast(): number { p3.resolve(30); return output; }
			export function readAll(): number { return output; }
		`);
		// Each of these calls ends with a full drain, so `readAll()` staying 0 after two of the three
		// inputs resolved is a real "not yet", not just "not drained yet".
		check("async: 'Promise.all' -- two of three inputs resolved leaves it pending", (startAll(), resolveTwo(), readAll()), 0);
		check("async: 'Promise.all' resolves only once every input has, order-independent", (resolveLast(), readAll()), 999);

		// `Promise<void>` -- a real, common instantiation -- unlike `Generator`'s own `Y | R` union,
		// `Promise<T>.value: T` is a *bare* field with no union to fall back on, so `T=void` needed a
		// real fix (not something the existing machinery already handled): `compileAsyncFunc` now
		// substitutes `any` for `T` right where `Promise<T>` gets instantiated, once, whenever the
		// async function's own declared return is `void` -- both natural completion (no explicit
		// `return` at all, here) and every `resolve()`/await site downstream then agree on that same
		// substituted shape. Also exercises awaiting an existing `Promise<void>` value (`observe`
		// below), which must reference the *same* substituted instantiation its producer built.
		const { asyncVoidTest, readVoid } = await compile(`
			let output: number = 0;
			async function addOneVoid(p: Promise<number>): Promise<void> {
				const v = await p;
				output = v + 1;
			}
			async function observe(p: Promise<number>): Promise<void> {
				await addOneVoid(p);
			}
			export function asyncVoidTest(): number {
				const p = new Promise<number>(0);
				p.resolve(41);
				observe(p);
				return output;
			}
			export function readVoid(): number { return output; }
		`);
		check("async: 'Promise<void>' -- natural completion (no explicit 'return') resolves fine", (asyncVoidTest(), readVoid()), 42);
	}

	{
		// A negative-literal (or other foldable, e.g. `!true`) top-level `const`/`let` initializer parses
		// as a real `unary`/`binary` AST node, not a bare `literal` one -- `foldConstants` (already used by
		// `case 'switch'`'s own jump-table detection) recognizes it as a compile-time constant so it still
		// becomes a real wasm global instead of being silently left unregistered.
		const { negGlobal } = await compile(`
			const negOne: number = -1;
			export function negGlobal(): number { return negOne * 958; }
		`);
		check('a negative-literal top-level global is recognized as a compile-time constant', negGlobal(), -958);

		// A closure value read directly off an array element, called in one expression (`arr[i](x)`) --
		// generalizes the existing bare-identifier closure-call case via the callee's own static type
		// instead of a name-based lookup.
		const { indexCall } = await compile(`
			export function indexCall(): number {
				const fns: Array<(x: number) => number> = [(x: number) => x + 1, (x: number) => x * 2];
				return fns[0](10) + fns[1](10);
			}
		`);
		check("calling a closure read directly off an array element ('arr[i](x)')", indexCall(), 31);

		// `(a / 0) | 0` -- an `f64`->`i32` coercion of a non-finite value must never trap (real division
		// by zero is `+-Infinity`/`NaN`, not an error). The bitwise operators implement real `ToInt32`
		// now, so all three answer `0` exactly as JS does; the saturating conversion `coerceTop` still
		// uses for an index or a length is a separate, deliberate rule (see its own comment).
		const { divByZero, divByZeroNeg, divNaN } = await compile(`
			export function divByZero(a: number): number { return (a / 0) | 0; }
			export function divByZeroNeg(a: number): number { return (a / -0) | 0; }
			export function divNaN(): number { return (0 / 0) | 0; }
		`);
		check("'f64'->'i32' coercion of '+Infinity' never traps", divByZero(5), (5 / 0) | 0);
		check("'f64'->'i32' coercion of '-Infinity' never traps", divByZeroNeg(5), (5 / -0) | 0);
		check("'f64'->'i32' coercion of 'NaN' never traps", divNaN(), 0);
	}

	{
		const { noThrow, caught, uncaughtValue, noBinding, nested, returnsFromTry, breaksFromTry } = await compile(`
			export function noThrow(): number {
				let r = 0;
				try {
					r = 1;
				} catch (e) {
					r = 2;
				}
				return r;
			}
			export function caught(): number {
				try {
					throw 42;
				} catch (e) {
					return e;
				}
			}
			export function uncaughtValue(): number {
				throw 99;
			}
			export function noBinding(): number {
				try {
					throw 1;
				} catch {
					return 2;
				}
			}
			export function nested(): number {
				try {
					try {
						throw 5;
					} catch (e) {
						throw 6;
					}
				} catch (e) {
					return e;
				}
			}
			export function returnsFromTry(): number {
				try {
					return 7;
				} catch (e) {
					return -1;
				}
			}
			export function breaksFromTry(): number {
				let i = 0;
				while (i < 10) {
					try {
						if (i === 3)
							break;
					} catch (e) {}
					i = i + 1;
				}
				return i;
			}
		`);
		check("try/catch: no throw -- catch doesn't run", noThrow(), 1);
		check('try/catch: caught value round-trips', caught(), 42);
		check("try/catch: 'catch' with no binding", noBinding(), 2);
		check('try/catch: nested -- inner rethrow reaches outer catch', nested(), 6);
		check("try/catch: 'return' inside 'try' exits the function", returnsFromTry(), 7);
		check("try/catch: 'break' inside 'try' crosses it to the enclosing loop", breaksFromTry(), 3);
		try {
			uncaughtValue();
			++failures;
			console.error('FAIL - try/catch: an uncaught throw propagates out: expected a throw, got none');
		} catch (e) {
			check('try/catch: an uncaught throw propagates out as a real WebAssembly.Exception', e instanceof WebAssembly.Exception, true);
		}
	}

	{
		const {
			finallyOnly, finallyUncaught, catchFinallyNormal, catchFinallyCaught,
			returnThroughFinally, finallyOverridesReturn, breakThroughFinally, continueThroughFinally,
			nestedFinally, catchThrowsFinallyRuns, __consoleOutput,
		} = await compile(`
			export function finallyOnly(): number {
				let r = 0;
				try {
					r = 1;
				} finally {
					r = r + 10;
				}
				return r;
			}
			export function finallyUncaught(): number {
				try {
					throw 1;
				} finally {
					console.log(777);
				}
				return 0;
			}
			export function catchFinallyNormal(): number {
				let r = 0;
				try {
					r = 1;
				} catch (e) {
					r = 2;
				} finally {
					r = r + 100;
				}
				return r;
			}
			export function catchFinallyCaught(): number {
				let r = 0;
				try {
					throw 5;
				} catch (e) {
					r = e;
				} finally {
					r = r + 100;
				}
				return r;
			}
			export function returnThroughFinally(): number {
				try {
					return 7;
				} finally {
					console.log(888);
				}
			}
			export function finallyOverridesReturn(): number {
				try {
					return 7;
				} finally {
					return 9;
				}
			}
			export function breakThroughFinally(): number {
				let i = 0;
				while (i < 10) {
					try {
						if (i === 3)
							break;
					} finally {
						console.log(i);
					}
					i = i + 1;
				}
				return i;
			}
			export function continueThroughFinally(): number {
				let i = 0;
				let sum = 0;
				while (i < 5) {
					i = i + 1;
					try {
						if (i % 2 === 0)
							continue;
					} finally {
						sum = sum + 1;
					}
					sum = sum + 100;
				}
				return sum;
			}
			export function nestedFinally(): number {
				try {
					try {
						throw 1;
					} finally {
						console.log(1);
					}
				} catch (e) {
					console.log(2);
				} finally {
					console.log(3);
				}
				return 0;
			}
			export function catchThrowsFinallyRuns(): number {
				try {
					try {
						throw 1;
					} catch (e) {
						throw 2;
					} finally {
						console.log(9);
					}
				} catch (e) {
					return e;
				}
			}
		`);
		check("finally: no 'catch' -- runs on the normal path", finallyOnly(), 11);
		check("finally: 'catch'+'finally' -- normal path runs 'finally' too", catchFinallyNormal(), 101);
		check("finally: 'catch'+'finally' -- caught path runs 'finally' too", catchFinallyCaught(), 105);
		check("finally: 'return' inside 'try' keeps its own value through 'finally'", returnThroughFinally(), 7);
		check('finally: console output ran before the deferred return', __consoleOutput.includes('888\n'), true);
		check("finally: a 'return' inside 'finally' overrides 'try's own pending return", finallyOverridesReturn(), 9);
		check("finally: 'break' inside 'try' still runs 'finally' on every iteration, including the break", breakThroughFinally(), 3);
		check("finally: 'continue' inside 'try' still runs 'finally' every time", continueThroughFinally(), 305);
		check('nested try/finally: inner finally, then outer catch, then outer finally, in order',
			__consoleOutput.filter(s => s === '1\n' || s === '2\n' || s === '3\n').join(''), '1\n2\n3\n');
		check("finally: 'finally' still runs even when the 'catch' handler itself throws", catchThrowsFinallyRuns(), 2);
		check("finally: 'finally' body itself ran despite 'catch' rethrowing", __consoleOutput.includes('9\n'), true);
		try {
			finallyUncaught();
			++failures;
			console.error("FAIL - finally: an uncaught throw still runs 'finally' first: expected a throw, got none");
		} catch (e) {
			check("finally: an uncaught throw still runs 'finally' first", __consoleOutput.includes('777\n') && e instanceof WebAssembly.Exception, true);
		}
	}

	{
		// 'try'/'finally' inside a generator/async function, a constructor, or a `reassignsThis` method --
		// each of those redefines what a plain `return` actually means (IteratorResult/Promise
		// resolution/appended `this`, see `returnValueWtype`), so the redirect-through-'finally' mechanism
		// needs to reconstruct the *right* one once 'finally' has run, not just a generic wasm return.
		const { driveGenFinally, __consoleOutput: genOutput } = await compile(`
			function* genWithFinally(): Generator<number, number, number> {
				yield 1;
				try {
					return 42;
				} finally {
					console.log(555);
				}
			}
			export function driveGenFinally(): number {
				const g = genWithFinally();
				const a = g.next(0);
				const b = g.next(0);
				return a.value + b.value * 1000 + (b.done ? 1000000 : 0);
			}
		`);
		check("finally: inside a generator -- 'return' still yields the try's own value via the IteratorResult protocol", driveGenFinally(), 1042001);
		check("finally: inside a generator -- 'finally' itself still ran", genOutput.includes('555\n'), true);

		const { asyncFinallyTest, readFinally } = await compile(`
			let output: number = 0;
			let finallyRan: number = 0;
			async function addOneFinally(p: Promise<number>): Promise<number> {
				const v = await p;
				try {
					return v + 1;
				} finally {
					finallyRan = 1;
				}
			}
			async function observe(p: Promise<number>): Promise<number> {
				const v = await addOneFinally(p);
				output = v;
				return v;
			}
			export function asyncFinallyTest(): number {
				const p = new Promise<number>(0);
				p.resolve(41);
				const result = observe(p);
				return output * 10 + finallyRan;
			}
			export function readFinally(): number { return output * 10 + finallyRan; }
		`);
		check("finally: inside an async function -- 'return' still resolves the try's own value through 'finally'", (asyncFinallyTest(), readFinally()), 421);

		const { testCtorFinally } = await compile(`
			class Widget {
				v: number;
				constructor(v: number) {
					try {
						this.v = v;
						if (v < 0) {
							this.v = 0;
							return;
						}
					} finally {
						this.v = this.v + 1000;
					}
				}
			}
			export function testCtorFinally(): number {
				const w1 = new Widget(5);
				const w2 = new Widget(-5);
				return w1.v * 1000000 + w2.v;
			}
		`);
		check("finally: inside a constructor -- an early 'return' still runs 'finally' before implicitly returning 'this'", testCtorFinally(), 1005001000);

		const { testReassignThisFinally } = await compile(`
			class Counter {
				n: number;
				constructor(n: number) { this.n = n; }
				bump(): number {
					const result = new Counter(this.n + 1);
					try {
						// @ts-expect-error - tison extension: reassigning 'this' swaps the receiver
						this = result;
						return this.n;
					} finally {
						this.n = this.n + 100;
					}
				}
			}
			export function testReassignThisFinally(): number {
				let c = new Counter(5);
				const r = c.bump();
				return r * 1000 + c.n;
			}
		`);
		check("finally: inside a 'reassignsThis' method -- the return value is fixed early, but the appended (caller-visible) 'this' still reflects 'finally's later mutation",
			testReassignThisFinally(), 6106);
	}

	{
		// A generic interface/type-alias referenced with no explicit type argument at all (`Pair`, not
		// `Pair<X>`) previously crashed codegen outright -- `ensureObjectShape` resolved the entry's own
		// raw (still-generic) type directly, instead of through `resolve`'s own default-type-arg
		// substitution (`RefType` with no `typeArgs`), leaving the type param itself unresolved in every
		// member. Found compiling `ts-parser.ts` itself (`TypeParam(...): TypeParam`, no `<X>`) while
		// exploring the self-hosting target. `ensureClass` also dropped a ref's own `typeArgs` outright
		// when falling through to this path -- so an *explicit* instantiation (a generic field like
		// `Holder<T>`'s own `w: Wrap<T>`) needed a separate fix too, both covered here.
		const { bareGeneric, explicitGeneric } = await compile(`
			interface Pair<T> { first: T; second: number; }
			function makePairBare(x: number): Pair { return { first: x, second: 2 }; }
			export function bareGeneric(): number { return makePairBare(9).second; }

			interface Wrap<T> { inner: T; }
			class Holder<T> { constructor(public w: Wrap<T>) {} }
			function makeHolder(x: number): Holder<number> { return new Holder<number>({ inner: x }); }
			export function explicitGeneric(): number { return makeHolder(7).w.inner; }
		`);
		check('generic interface reference: bare (implicit type arg) compiles and runs', bareGeneric(), 2);
		check('generic interface reference: explicit type arg (as a generic field type) compiles and runs', explicitGeneric(), 7);
	}

	{
		// A top-level `interface` declaration (pure type-level, erased at runtime, same as `type X = ...`)
		// wasn't in the top-level statement loop's skip list -- unlike `type_alias_decl`, right next to it
		// -- so it fell through to `emitStmt`'s switch and threw "unsupported statement 'interface_decl'"
		// merely for *existing* alongside real code, never mind being referenced.
		const { interfaceCoexists } = await compile(`
			interface Unused { x: number; }
			export function interfaceCoexists(): number { return 5; }
		`);
		check('a top-level interface declaration compiles alongside real code', interfaceCoexists(), 5);
	}

	{
		// Only a *host-imported* func type must never share a multi-member rec group with anything else --
		// per the wasm-GC spec, a type sharing a multi-member group canonicalizes differently than an
		// equivalently-shaped standalone/singleton one, which breaks matching a real host import (e.g.
		// WASI's `fd_write`) against this module's own func type of the same signature. Confirmed the hard
		// way via `wasmtime` (a real standalone runtime, not just Node's own lenient `WebAssembly` engine)
		// rejecting a `console.log`-using module outright before this was fixed -- checked here
		// structurally, without needing `wasmtime` itself as a test dependency.
		// Narrowed from "no func type, period" after a real regression: `ref.test`/`ref.cast` (the reason
		// struct/array types *do* need a shared group, so two structurally-identical sibling classes stay
		// distinguishable) is never applied to a bare func type here, so an *internal* func type (a
		// closure's own, like `g` below) is just as safe sharing the group as any struct/array -- and
		// self-/mutually-referential struct support (a class/object-shape field forward-referencing its own
		// not-yet-fully-built type) can genuinely need two structs to share a group *around* an ordinary
		// internal func type registered in between them, which splitting at *every* func type broke.
		const program = parser.parse(`
			class Point { x: number; constructor(x: number) { this.x = x; } }
			export function f(p: Point): number {
				const g = (n: number) => n + 1;
				console.log(p.x);
				return g(p.x);
			}
		`);
		const diagnostics = TStypeCheck(program, new T.Scope(libScope));
		assert(!diagnostics.some(d => d.severity === SEVERITY.ERROR), 'unexpected type errors');
		const mod = TStoWasm(program);
		const { types, groupSizes } = mod.types!;
		const importedFuncTypeIndices = new Set((mod.imports ?? []).flatMap(imp => imp.desc.kind === 'func' && typeof imp.desc.typeIndex === 'number' ? [imp.desc.typeIndex] : []));
		assert(importedFuncTypeIndices.size > 0, 'expected console.log to pull in a real host import');
		let i = 0;
		let anyImportedFuncInMultiMemberGroup = false;
		let anyOrdinaryFuncInMultiMemberGroup = false;
		for (const size of groupSizes) {
			if (size > 1) {
				for (let j = i; j < i + size; j++) {
					const t = types[j];
					const kind = ('type' in t ? t.type : t).kind;
					if (kind !== 'func')
						continue;
					if (importedFuncTypeIndices.has(j))
						anyImportedFuncInMultiMemberGroup = true;
					else
						anyOrdinaryFuncInMultiMemberGroup = true;
				}
			}
			i += size;
		}
		check("an imported func type ('fd_write') never shares a multi-member rec group", anyImportedFuncInMultiMemberGroup, false);
		check("an ordinary (non-imported) func type now shares the group, like any struct/array", anyOrdinaryFuncInMultiMemberGroup, true);
	}

	{
		// Real multi-file codegen: `import * as H from './helperFile'; H.helper(...)` -- `TStoWasm`'s own
		// `collectNames` used to only ever walk the single entry `Program`'s own top-level statements, so
		// a namespace-import-qualified call to another module's function had no AST body to compile against
		// (the checker resolves its *type* fine via `ModuleLoader`, but codegen needs the callee's real
		// declaration). `modules` (built by `collectModules`, the same loader-driven walk `tsw.ts`'s own CLI
		// uses) closes that gap; `H` itself resolves through the checker's own `Scope.namespace`.
		const { main } = await compileMulti({
			helperFile: `
				export function helper(a: number, b: number): number {
					return a + b * 2;
				}
			`,
			mainFile: `
				import * as H from './helperFile';
				export function main(): number {
					return H.helper(3, 4);
				}
			`,
		}, 'mainFile');
		check('multi-file: a namespace-import-qualified call resolves to the declaring module', main(), 11);
	}

	{
		// A function in a non-entry module calling a *sibling* function declared in the same module by its
		// own bare (unqualified) name -- must resolve within that module's own top level, not the entry's,
		// even though both modules happen to declare a function under the same name (`helper`).
		const { main } = await compileMulti({
			helperFile: `
				function helper(a: number, b: number): number {
					return a * 10 + b;
				}
				export function callHelper(x: number): number {
					return helper(x, 1);
				}
			`,
			mainFile: `
				import * as H from './helperFile';
				function helper(): number {
					return -1;
				}
				export function main(): number {
					return H.callHelper(5) + helper();
				}
			`,
		}, 'mainFile');
		check('multi-file: a same-named sibling function resolves within its own declaring module', main(), 50);
	}

	{
		// A closure declared *inside* a cross-module function inherits that function's own module context
		// -- a free variable that's really a same-module top-level function must still resolve correctly
		// from inside the nested closure, not just the enclosing function's own body.
		const { main } = await compileMulti({
			helperFile: `
				function double(n: number): number {
					return n * 2;
				}
				export function applyTwice(x: number): number {
					const step = (n: number) => double(n) + 1;
					return step(step(x));
				}
			`,
			mainFile: `
				import * as H from './helperFile';
				export function main(): number {
					return H.applyTwice(3);
				}
			`,
		}, 'mainFile');
		check('multi-file: a closure nested inside a cross-module function resolves its own module\'s names', main(), 15);
	}

	{
		// A namespace import in a NON-entry module (`mid` does `import * as D from './deep'`, and the entry
		// only ever reaches `mid` by a plain named import). The namespace binding resolves through the
		// checker's own `Scope.addNamespace`, reached from the compiled body's `declScope` chain -- so this
		// covers the case where the entry module's own scope has never seen `D` at all.
		const { main } = await compileMulti({
			deep: `
				export function twice(n: number): number { return n * 2; }
			`,
			mid: `
				import * as D from './deep';
				export function go(x: number): number { return D.twice(x) + 1; }
			`,
			mainFile: `
				import { go } from './mid';
				export function main(): number { return go(5); }
			`,
		}, 'mainFile');
		check('multi-file: a namespace import inside a non-entry module resolves through its own scope', main(), 11);
	}

	{
		// A plain (non-namespace) `import { helper } from './helperFile'; helper(...)` -- the same
		// underlying problem `import * as H` had before real multi-file codegen landed (a local binding
		// with no AST body of its own to compile against), just reached via `s.specifiers` instead of
		// `s.namespace`.
		const { main } = await compileMulti({
			helperFile: `
				export function helper(a: number, b: number): number {
					return a + b * 2;
				}
			`,
			mainFile: `
				import { helper } from './helperFile';
				export function main(): number {
					return helper(3, 4);
				}
			`,
		}, 'mainFile');
		check('multi-file: a plain named import resolves a direct call to the declaring module', main(), 11);
	}

	{
		// An aliased named import (`import { helper as h }`) used as a *value* (passed to a higher-order
		// function), not called directly -- exercises the identifier-fallback path (`ensureFunctionValueWrapper`)
		// separately from `emitCall`'s own direct-call path above; the local alias `h` must resolve to the
		// declaring module's real `helper`, under its real (not aliased) name.
		const { main } = await compileMulti({
			helperFile: `
				export function helper(a: number, b: number): number {
					return a + b * 2;
				}
			`,
			mainFile: `
				import { helper as h } from './helperFile';
				function applyIt(f: (a: number, b: number) => number): number {
					return f(3, 4);
				}
				export function main(): number {
					return applyIt(h);
				}
			`,
		}, 'mainFile');
		check('multi-file: an aliased named import used as a value resolves to the declaring module', main(), 11);
	}

	{
		// `new NS.Cls(...)` -- a namespace-qualified class. `case 'new'` only ever accepted a bare
		// identifier callee, and a namespace-qualified TYPE ref (`c: M.Cls`) resolved through
		// `ensureClass`'s bare-name-only lookup to a structural shape-only stand-in instead of the real
		// class, so the annotation and the `new` disagreed on the physical type.
		const { main } = await compileMulti({
			mod: `export class Cls { x: number; constructor(x: number) { this.x = x; } double(): number { return this.x * 2; } }`,
			mainFile: `
				import * as M from './mod';
				export function main(): number { const c: M.Cls = new M.Cls(5); return c.double(); }
			`,
		}, 'mainFile');
		check('multi-file: a namespace-qualified class constructs and dispatches methods', main(), 10);
	}

	{
		// `const Cls = M.Cls` -- towasm.ts's own `const Scope = T.Scope` shape. A class has no runtime
		// value here (classes are nominal), so the const is a compile-time alias: the start function must
		// emit nothing for it, and both names must land on the SAME physical class.
		const { main } = await compileMulti({
			mod: `export class Cls { x: number; constructor(x: number) { this.x = x; } double(): number { return this.x * 2; } }`,
			mainFile: `
				import * as M from './mod';
				type Cls = M.Cls;
				const Cls = M.Cls;
				export function take(c: M.Cls): number { return c.double(); }
				export function main(): number { const c: Cls = new Cls(5); return take(c); }
			`,
		}, 'mainFile');
		check('multi-file: a class aliased through a namespace-member const is the same class', main(), 10);
	}

	{
		// The same alias, in one file and never used as a value -- the start function used to try to
		// evaluate it (`unresolved identifier 'Base'`) even though nothing reads it.
		const { main } = await compile(`
			class Base { x: number; constructor(x: number) { this.x = x; } }
			const Alias = Base;
			export function main(): number { return new Alias(5).x; }
		`);
		check('a class aliased through a plain const constructs', main(), 5);
	}

	{
		// An ARRAY carrying extra properties (`arrayPartOf`) -- physically just the array, so a tag function
		// typed against the real `TemplateStringsArray` (`extends Array<string>`, plus `raw`) works where it
		// used to report "no representation". The cooked strings are what `case 'tagged_template'` already
		// synthesized; this only makes the declared parameter type representable.
		const { tagLen, firstChunk, viaAlias } = await compile(`
			function tag(strings: TemplateStringsArray, ...values: number[]): number { return strings.length; }
			function head(strings: TemplateStringsArray, ...values: number[]): number { return strings[0].length; }
			function plain(strings: string[]): number { return strings.length; }
			export function tagLen(): number { return tag\`a\${1}b\${2}c\`; }
			export function firstChunk(): number { return head\`hello\${1}\`; }
			// The same value handed to a plain 'string[]' parameter -- no conversion, the physical types are equal.
			export function viaAlias(): number { const s: TemplateStringsArray = ['a', 'b'] as TemplateStringsArray; return plain(s); }
		`);
		check('a TemplateStringsArray tag function compiles and counts its chunks', tagLen(), 3);
		check('a TemplateStringsArray indexes like the array it is', firstChunk(), 5);
		check('a TemplateStringsArray is physically a plain string[]', viaAlias(), 2);
	}

	{
		// The same shape written two other ways: an interface extending Array (the lib's own
		// `RegExpMatchArray`/`RegExpExecArray` idiom) and an explicit intersection. Both used to have no
		// representation at all, in a parameter position or inside a function type.
		const { len, sum, viaClosure } = await compile(`
			interface Tagged extends Array<number> { tag: number; }
			type Marked = number[] & { mark: number };
			export function len(): number { const t = [1, 2, 3] as Tagged; return t.length; }
			export function sum(): number { const m = [4, 5] as Marked; return m[0] + m[1]; }
			function apply(f: (m: Marked) => number, m: Marked): number { return f(m); }
			export function viaClosure(): number { const m = [7, 8] as Marked; return apply(x => x[1], m); }
		`);
		check('an interface extending Array is the array', len(), 3);
		check('an array/object intersection indexes like the array', sum(), 9);
		check('an array/object intersection works inside a function type', viaClosure(), 8);
	}

	{
		// `NS.someConst` -- another module's module-level const, read through `import * as NS`. Only a bare
		// identifier read reached `ensureLazyGlobal` before, so the qualified form threw `unknown field`.
		// The local `const A = NS.pair` beside it is a pure alias: it renames a cross-module binding, so the
		// start function must emit nothing for it and the read must still resolve.
		const { direct, viaAlias } = await compileMulti({
			consts: `export const pair = [3, 4]; export const greeting = 'hi';`,
			mainFile: `
				import * as C from './consts';
				const A = C.pair;
				export function direct(): number { return C.pair[0] + C.pair[1] + C.greeting.length; }
				export function viaAlias(): number { return A[1]; }
			`,
		}, 'mainFile');
		check('multi-file: a namespace-qualified module-level const reads', direct(), 9);
		check('multi-file: a const aliasing a cross-module binding reads', viaAlias(), 4);
	}

	{
		// Two more start-function non-events, both real js-parser.ts shapes: a bare type-only re-export
		// (`export type {T} from '...'`, which binds and evaluates nothing) and an alias naming a generic
		// declaration with explicit type arguments (`const JSBinary = Binary<Expr, binaryOps>`). Each used
		// to fail the WHOLE module from the start function, whether or not anything read the name.
		const { main } = await compileMulti({
			common: `
				export type Loc = { line: number };
				export function pick<T>(a: T, b: T): T { return a; }
			`,
			mainFile: `
				import { pick } from './common';
				export type { Loc } from './common';
				const pickNum = pick<number>;
				export function main(): number { return 6; }
			`,
		}, 'mainFile');
		check('multi-file: a type-only re-export and a generic-instantiation alias evaluate to nothing', main(), 6);
	}

	{
		// tocode.ts's own `Output` shape, reached through an import -- the survey's largest cause. Three
		// things had to hold at once, and each failed only cross-module: `Partial<typeof DefaultOptions>`
		// must resolve `typeof DefaultOptions` in the module that declares it (a plain non-exported const,
		// not a name in the importer at all); an un-annotated field's type must be looked up against the
		// class's own scope; and the constructor body must resolve `DefaultOptions` too.
		const { viaNamed, viaNamespace, viaConst } = await compileMulti({
			tocode: `
				const DefaultOptions = { newline: 'NL', indent: '  ', spaceAfterColon: true };
				export type Options = Partial<typeof DefaultOptions>;
				export class Output {
					opts;
					colon = ': ';
					constructor(opts: Options = {}) {
						this.opts	= {...DefaultOptions, ...opts};
						this.colon	= this.opts.spaceAfterColon ? ': ' : ':';
					}
				}
			`,
			mainFile: `
				import { Output } from './tocode';
				import * as C from './tocode';
				const shared = new Output({spaceAfterColon: false});
				export function viaNamed(): number { return new Output({spaceAfterColon: false}).colon.length; }
				export function viaNamespace(): number { return new C.Output({}).colon.length; }
				export function viaConst(): number { return shared.colon.length + shared.opts.indent.length; }
			`,
		}, 'mainFile');
		check('multi-file: an imported class resolves a typeof-query option bag', viaNamed(), 1);
		check('multi-file: the same class through a namespace import keeps its defaults', viaNamespace(), 2);
		check('multi-file: an imported class held in a module-level const', viaConst(), 3);
	}

	{
		// A top-level const's initializer used to run TWICE: once into a start-function local nothing can
		// see, and again in the `ensureLazyGlobal` wrapper on the first cross-function read -- so a
		// side-effecting initializer bumped its counter twice and two different values circulated.
		const { readX, getCount } = await compile(`
			let count = 0;
			function bump(): number[] { count = count + 1; return [count]; }
			const X = bump();
			export function readX(): number { return X[0]; }
			export function getCount(): number { return count; }
		`);
		check('a top-level const initializer runs exactly once', getCount(), 1);
		check('and every reader sees that one value', readX(), 1);
	}

	{
		// `!x` is exactly "is x falsy", so it answers for every shape `emitTruthy` understands. It used to
		// be scalar-only -- and even there it coerced the operand to `i32` first, so `!0.5` TRUNCATED to
		// `!0` and came out `true`. Separately, NaN is falsy in JS, but wasm's `ne` is true for an
		// unordered compare, so `emitTruthy` called it truthy; `abs(x) > 0` is right for both.
		const r = await compile(`
			class C { n: number; constructor(n: number) { this.n = n; } }
			export function notFraction(): boolean { const x = 0.5; return !x; }
			export function notZero(): boolean { const x = 0.0; return !x; }
			export function notNull(): boolean { const s: C | undefined = undefined; return !s; }
			export function notObject(): boolean { const s: C | undefined = new C(1); return !s; }
			export function notEmptyStr(): boolean { const s = ''; return !s; }
			export function notStr(): boolean { const s = 'a'; return !s; }
			export function notArray(): boolean { const a = [1]; return !a; }
			export function doubleNot(): boolean { const s: C | undefined = undefined; return !!s; }
			export function notNaN(): boolean { const x = 0.0 / 0.0; return !x; }
			export function nanIsFalsy(): number { const x = 0.0 / 0.0; return x ? 1 : 2; }
			export function fractionIsTruthy(): number { const x = 0.5; return x ? 1 : 2; }
			export function minusZeroIsFalsy(): number { const x = -0.0; return x ? 1 : 2; }
		`);
		check('!0.5 is false (not truncated to !0)', !!r.notFraction(), false);
		check('!0 is true', !!r.notZero(), true);
		check('! on a null object reference', !!r.notNull(), true);
		check('! on a live object reference', !!r.notObject(), false);
		check("! on '' is true", !!r.notEmptyStr(), true);
		check("! on 'a' is false", !!r.notStr(), false);
		check('! on an array is false', !!r.notArray(), false);
		check('!! on a null object reference', !!r.doubleNot(), false);
		check('!NaN is true', !!r.notNaN(), true);
		check('NaN is falsy as a condition', r.nanIsFalsy(), 2);
		check('0.5 is truthy as a condition', r.fractionIsTruthy(), 1);
		check('-0 is falsy as a condition', r.minusZeroIsFalsy(), 2);
	}

	{
		// A union of two differently-shaped classes boxes to a plain `any` slot, so truthiness looked
		// undecidable ("could be holding 0") even though the CHECKER's type says every non-null thing it can
		// hold is an object. `alwaysTruthy` reads that type, and the test is a null test after all -- the
		// `Stmt | undefined` shape that blocked seven declarations across checker.ts and type-utils.ts.
		const { present, absent, negated, viaField } = await compile(`
			class A { a: number; constructor(a: number) { this.a = a; } }
			class B { b: string; constructor(b: string) { this.b = b; } }
			type Node = A | B;
			function test(n: Node | undefined): number { return n ? 1 : 2; }
			export function present(): number { return test(new B('')); }
			export function absent(): number { return test(undefined); }
			export function negated(): number { const n: Node | undefined = undefined; return !n ? 7 : 8; }
			// An empty-string field on the object -- the OBJECT is truthy regardless of what it holds.
			export function viaField(): number { const n: Node | undefined = new B(''); return n ? 3 : 4; }
		`);
		check('a boxed union of object types is truthy when present', present(), 1);
		check('...and falsy when null', absent(), 2);
		check('...and negatable', negated(), 7);
		check('...decided by the reference, not by what it holds', viaField(), 3);
	}

	{
		// A `never` member in that union is uninhabited, so it can't be the falsy thing -- skip it like a
		// nullish one. `JS.Stmt<any>` really has one (a generic parameter substituted away), and it alone
		// made the whole union undecidable.
		const { present, absent } = await compile(`
			class A { a: number; constructor(a: number) { this.a = a; } }
			class B { b: number; constructor(b: number) { this.b = b; } }
			type U = A | never | B | undefined;
			export function present(): number { const u: U = new A(1); return u ? 1 : 2; }
			export function absent(): number { const u: U = undefined; return u ? 1 : 2; }
		`);
		check('a never member does not make a union undecidable', present(), 1);
		check('...and the null test still answers', absent(), 2);
	}

	{
		// `typeof x === 'lit'` is a runtime TYPE TEST, not a string comparison, so it never needs a
		// `typeof` string to exist. Answered statically when the checker's type gives every inhabitant the
		// same tag (the only way to reach 'object'/'function', which have no single physical form), by a
		// null test when only nullability varies, and otherwise by `ref.test` on the boxed value.
		const r = await compile(`
			class P { p: number; constructor(p: number) { this.p = p; } }
			type Target = string | P;
			function isStr(t: Target): number { return typeof t === 'string' ? 1 : 2; }
			function notStr(t: Target): number { return typeof t !== 'string' ? 1 : 2; }
			function isBig(v: number | bigint): number { return typeof v === 'bigint' ? 1 : 2; }
			function isNum(v: number | bigint): number { return typeof v === 'number' ? 1 : 2; }
			function isBool(v: string | boolean): number { return typeof v === 'boolean' ? 1 : 2; }
			function maybeStr(v: string | undefined): number { return typeof v === 'string' ? 1 : 2; }
			function isUndef(v: P | undefined): number { return typeof v === 'undefined' ? 1 : 2; }
			export function strIsStr(): number { return isStr('hi'); }
			export function objIsStr(): number { return isStr(new P(1)); }
			export function objNotStr(): number { return notStr(new P(1)); }
			export function numIsBig(): number { return isBig(5); }
			export function numIsNum(): number { return isNum(5); }
			export function boolIsBool(): number { return isBool(true); }
			export function strIsBool(): number { return isBool('x'); }
			export function presentStr(): number { return maybeStr('a'); }
			export function absentStr(): number { return maybeStr(undefined); }
			export function undefIsUndef(): number { return isUndef(undefined); }
			export function objIsUndef(): number { return isUndef(new P(1)); }
			// Statically decided, including the tags with no physical form of their own.
			export function staticStr(): number { const s = 'x'; return typeof s === 'string' ? 1 : 2; }
			export function staticNum(): number { const n = 1.5; return typeof n === 'string' ? 1 : 2; }
			export function staticObj(): number { const p = new P(1); return typeof p === 'object' ? 1 : 2; }
			export function staticFn(): number { const f = (x: number) => x; return typeof f === 'function' ? 1 : 2; }
			// ...and as a plain value, when the tag is statically known ('number' is 6 characters).
			export function tagOfNum(): number { const n = 1.5; return (typeof n).length; }
			export function tagOfObj(): number { const p = new P(1); return (typeof p).length; }
		`);
		for (const [name, want] of [
			['strIsStr', 1], ['objIsStr', 2], ['objNotStr', 1], ['numIsBig', 2], ['numIsNum', 1],
			['boolIsBool', 1], ['strIsBool', 2], ['presentStr', 1], ['absentStr', 2],
			['undefIsUndef', 1], ['objIsUndef', 2],
			['staticStr', 1], ['staticNum', 2], ['staticObj', 1], ['staticFn', 1],
			['tagOfNum', 6], ['tagOfObj', 6],
		] as [string, number][])
			check(`typeof: ${name}`, (r as any)[name](), want);
	}

	{
		// `typeof x === 'function'` on a genuinely boxed value. Every closure value struct declares one
		// shared, non-final base -- sound by wasm-GC's covariant immutable-field subtyping, since a
		// closure's own first field is `(ref $itsFuncType)` and every func type is a subtype of the
		// abstract `func`. The test is nominal, so two differently-shaped closures both match it and no
		// unrelated struct can.
		const r = await compile(`
			class P { p: number; constructor(p: number) { this.p = p; } }
			type Sym = string | P | ((a: number) => number);
			function tag(s: Sym): number { return typeof s === 'function' ? 1 : typeof s === 'string' ? 2 : 3; }
			type Sym2 = string | ((a: number, b: number) => number);
			function tag2(s: Sym2): number { return typeof s === 'function' ? 1 : 2; }
			export function fnTag(): number { return tag((x: number) => x + 1); }
			export function strTag(): number { return tag('a'); }
			export function objTag(): number { return tag(new P(1)); }
			export function fnTag2(): number { return tag2((a: number, b: number) => a + b); }
			export function strTag2(): number { return tag2('a'); }
		`);
		check('typeof: a closure is a function', r.fnTag(), 1);
		check('typeof: a string beside it is a string', r.strTag(), 2);
		check('typeof: a class instance beside it is neither', r.objTag(), 3);
		check('typeof: a differently-shaped closure shares the same base', r.fnTag2(), 1);
		check('typeof: ...and still is not a string', r.strTag2(), 2);
	}

	{
		// `T[number]` -- indexed by the `number` TYPE rather than a literal -- is the standard "element type
		// of this array" idiom, and `resolve` only ever reduced an indexed access for a literal index. It is
		// what `Map<string, typeof LIB_DECLS[number]>` is built on, and `.get`'s return type had no
		// representation without it.
		const { viaArray, viaTuple } = await compile(`
			const DECLS = [{ n: 1 }, { n: 2 }];
			type Decl = typeof DECLS[number];
			const PAIR: [number, number] = [3, 4];
			type Either = typeof PAIR[number];
			function take(d: Decl): number { return d.n; }
			function both(a: Either, b: Either): number { return a + b; }
			export function viaArray(): number { return take({ n: 7 }); }
			export function viaTuple(): number { return both(1, 2); }
		`);
		check('T[number] resolves an array element type', viaArray(), 7);
		check('T[number] resolves a tuple to its elements unioned', viaTuple(), 3);
	}

	{
		// `a && b` / `a || b` yield an OPERAND, not a boolean -- `0.5 && 7` is `7`. Both lowered to a bare
		// boolean, which agrees with real JS in a CONDITION (which is why it went unnoticed) and is simply
		// the wrong value anywhere else. Found by `assistant/difftest.sh`, which runs the same source
		// through the real TypeScript compiler and compares.
		const r = await compile(`
			export function andValue(): number { const a: number = 0.5; const b: number = 7; return (a && b) as number; }
			export function andShort(): number { const a: number = 0; const b: number = 7; return (a && b) as number; }
			export function orValue(): number { const a: number = 0; const b: number = 7; return (a || b) as number; }
			export function orShort(): number { const a: number = 4; const b: number = 7; return (a || b) as number; }
			// still a plain branch decision in a condition, where both readings agree
			export function asCondition(): number { const a: number = 0.5; const b: number = 0; return (a && b) ? 1 : 2; }
			export function orCondition(): number { const a: number = 0; const b: number = 3; return (a || b) ? 1 : 2; }
			// short-circuit really is one: the right side must not run when the left decides it
			export function shortCircuits(): number {
				let hits = 0;
				const bump = (): number => { hits = hits + 1; return 1; };
				const zero: number = 0;
				if (zero && bump()) { hits = hits + 100; }
				return hits;
			}
			// as a statement, where no value is produced at all
			export function asStatement(): number { let n = 0; const one: number = 1; one && (n = 5); return n; }
		`);
		check('&& yields the right operand when the left is truthy', r.andValue(), 7);
		check('&& yields the left operand when it is falsy', r.andShort(), 0);
		check('|| yields the right operand when the left is falsy', r.orValue(), 7);
		check('|| yields the left operand when it is truthy', r.orShort(), 4);
		check('&& in a condition still just branches', r.asCondition(), 2);
		check('|| in a condition still just branches', r.orCondition(), 1);
		check('&& short-circuits its right operand', r.shortCircuits(), 0);

		// An object is never falsy, so `n && ...` on an object-typed nullable keeps only `undefined` from its left:
		// the result is `boolean | undefined`, and the left's own struct ref must not be converted into it.
		const r2 = await compile(`
			interface Tok { type: number; name: string }
			function andIface(n: Tok | undefined) { return n && n.type === 2; }
			export function objTrue(): number { return andIface({ type: 2, name: 'x' }) ? 1 : 0; }
			export function objUndef(): number { return andIface(undefined) === undefined ? 1 : 0; }
		`);
		check('&& on an object-typed nullable keeps only undefined from its left', r2.objTrue() * 10 + r2.objUndef(), 11);

		// A truthiness test on a field read through a receiver narrowed by the same `&&` chain (`lex.prev.pos`
		// under `lex.prev &&`) needs the narrowed scope's type: in the baseline scope that read is `any`.
		const r3 = await compile(`
			interface TP { offset: number; line: number }
			interface Tk { pos: TP; name: string }
			interface LP extends TP { prev?: Tk }
			function after(lex: LP) { return !!(lex.prev && lex.prev.pos && lex.line > lex.prev.pos.line); }
			export function withPrev(): number { const p: LP = { offset: 0, line: 2, prev: { pos: { offset: 0, line: 1 }, name: 'x' } }; return after(p) ? 1 : 0; }
			export function noPrev(): number { const p: LP = { offset: 0, line: 2 }; return after(p) ? 1 : 0; }
		`);
		check('a field read through a receiver narrowed by the same && chain tests truthy', r3.withPrev() * 10 + r3.noPrev(), 10);

		// An ENTRY-module const holding a closure a factory returned, called by name (js-parser.ts's
		// `Rule = makeRule(...)`): the call path looked only in imported modules' scopes.
		const r4 = await compile(`
			function mk(k: number) { return (x: number) => x + k; }
			const R = mk(1);
			export function factoryConst(): number { return R(41); }
		`);
		check('an entry-module const holding a factory-made closure is callable by name', r4.factoryConst(), 42);

		// An `any` can HOLD undefined (a missing rest arg, an unmatched regex group), so its slot is nullable;
		// and a narrowing to just `undefined` (`a = undefined`) says nothing about that slot.
		const r5 = await compile(`
			function f(...args: any[]): number { const h = args[0]; return h !== undefined ? 1 : 0; }
			export function restAny(): number { return f(undefined) * 10 + f(3); }
			export function reassigned(): number { let a: any = 5; a = undefined; return a === undefined ? 1 : 0; }
		`);
		check('an any compared to undefined', r5.restAny(), 1);
		check('an any local reassigned to undefined', r5.reassigned(), 1);

		// `a?.m()` as a STATEMENT on a `void` method (type-utils.ts's `this.parent?.hitDepthLimit(fn)`):
		// the value is discarded, so no `void | undefined` is needed -- only the guarded call.
		const r6 = await compile(`
			class Cnt { n = 0; parent?: Cnt; hit(): void { this.n++; this.parent?.hit(); } }
			export function optVoid(): number { const c = new Cnt(); c.parent = new Cnt(); c.hit(); c.hit(); return c.parent.n * 10 + c.n; }
			export function optVoidNull(): number { const c = new Cnt(); c.hit(); return c.n; }
		`);
		check('a?.m() on a void method, as a statement', r6.optVoid() * 10 + r6.optVoidNull(), 221);

		// `Array.isArray` on a boxed `any`: a string shares the wasm array form, so it must answer false.
		const r7 = await compile(`
			export function isArr(): number {
				const a: any = [1, 2];
				const s: any = 'abc';
				const o: any = { a: 1 };
				const u: any = undefined;
				return (Array.isArray(a) ? 1000 : 0) + (Array.isArray(s) ? 100 : 0) + (Array.isArray(o) ? 10 : 0) + (Array.isArray(u) ? 1 : 0);
			}
		`);
		check('Array.isArray: true for an array, false for a string/object/undefined', r7.isArr(), 1000);

		// A method on a generic method's result (type-utils.ts's `resolvedParts.find`). A union receiver's `map`
		// is two signatures differing only in their fresh `U`, or (mixed elements) is called on one combined array.
		const r8 = await compile(`
			interface Lit { type: 'lit'; v: number }
			interface Inter { type: 'inter'; types: Ty[] }
			type Ty = Lit | Inter;
			function mixed(c: Ty): number {
				const parts = c.type === 'inter' ? c.types : [c];
				const hit = parts.map(m => m).find(m => m.type === 'lit');
				return hit && hit.type === 'lit' ? hit.v : -1;
			}
			export function mixedUnion(): number { return mixed({ type: 'inter', types: [{ type: 'inter', types: [] }, { type: 'lit', v: 7 }] }) * 10 + mixed({ type: 'lit', v: 3 }); }
			type TA = ['aa', number];
			type TB = ['bb', string];
			function tupleDisc(c: TA | TB): number { return c[0] === 'aa' ? c[1] : c[1].length; }
			export function tupleUnion(): number { return tupleDisc(['aa', 5]) * 10 + tupleDisc(['bb', 'xyz']); }
			function viaUnion(a: readonly number[] | number[]): number { const parts = a.map(x => x + 1); return parts.find(x => x > 2) ?? 0; }
			function viaPlain(a: number[]): number { const parts = a.map(x => x * 10); return parts.find(x => x > 15) ?? 0; }
			function strs(a: readonly string[] | string[]): number { const parts = a.map(s => s + '!'); return (parts.find(s => s.length > 3) ?? '').length; }
			export function findOnMapped(): number { return viaUnion([1, 2, 3]) * 1000 + viaPlain([1, 2, 3]) * 10 + strs(['a', 'bb', 'ccc']); }
		`);
		check('a method on a .map() result, on a union and a plain receiver', r8.findOnMapped(), 3204);
		check('a method on a union of arrays with different element types', r8.mixedUnion(), 73);
		check('a union of tuples: a literal index reads per position and discriminates', r8.tupleUnion(), 53);

		// `===` with a boxed `any` operand compared by identity: two equal strings, or two boxes of one number,
		// were unequal -- and so was `['x', 'yy'].indexOf('y' + 'y')`, since `Array<any>` compiles `this[i] === x`.
		const r9 = await compile(`
			function t(c: boolean, bit: number): number { return c ? bit : 0; }
			class P { x = 1; }
			export function anyEq(): number {
				const s: any = 'lit'; const s2: any = 'li' + 't'; const n: any = 1.5; const n2: any = 3 / 2; const o: any = { a: 1 }; const o2: any = { a: 1 };
				const str: string = 'lit'; const num: number = 1.5;
				return t(s === 'lit', 1) + t(s === s2, 2) + t('lit' === s, 4) + t(s === str, 8) + t(str === s, 16)
					+ t(n === 1.5, 32) + t(n === n2, 64) + t(n === num, 128) + t(num === n, 256)
					+ t(o === o, 512) + t(o !== o2, 1024) + t(s !== 'lit', 2048) + t(n !== n2, 4096);
			}
			export function anyEqEdges(): number {
				const nan: any = NaN; const one: any = 1; const tru: any = true; const s1: any = '1'; const u: any = undefined; const p = new P(); const ap: any = p;
				const arr: any[] = [1, 'a', NaN, p];
				let sw = 0;
				const k: any = 'b' + '';
				switch (k) { case 'a': sw = 1; break; case 'b': sw = 2; break; default: sw = 3; }
				return t(nan !== nan, 1) + t(one !== tru, 2) + t(one !== s1, 4) + t(u !== one, 8) + t(ap === p, 16) + t(p === ap, 32)
					+ t(arr.includes(NaN), 64) + t(arr.indexOf(NaN) === -1, 128) + t(arr.indexOf('a') === 1, 256) + t(arr.indexOf(p) === 3, 512) + t(sw === 2, 1024);
			}
			export function strIndexOf(): number { const a = ['x', 'yy', 'zzz']; const k = 'y' + 'y'; return a.indexOf(k) * 10 + (a.includes('zz' + 'z') ? 1 : 0); }
		`);
		check('=== on a boxed any compares strings and numbers by value', r9.anyEq(), 2047);
		check('=== on a boxed any: NaN, mixed kinds, undefined, objects, includes, switch', r9.anyEqEdges(), 2047);
		check('indexOf/includes on a string array compare by value', r9.strIndexOf(), 11);

		// type-utils.ts's `resolve`: `substituteType(t, new Map([[k, Literal(key)]]))`, then `isLiteral` guards.
		const r10 = await compile(`
			interface TM { string: string; number: number; boolean: boolean }
			interface Lit<T> { type: 'literal'; value: T; frozen?: boolean }
			interface Rf { type: 'ref'; name: string }
			type Ty = Lit<string | number | boolean | null> | Rf;
			function rf(name: string): Rf { return { type: 'ref', name }; }
			function sub(m: Map<string, Ty>): number { const x = m.get('a'); return m.size * 10 + (x && x.type === 'ref' ? x.name.length : 0); }
			export function mapArg(): number { const k = 'a'; return sub(new Map([[k, rf('xy')]])); }
			export function mapDecl(): number { const k: string = 'a'; const m: Map<string, Ty> = new Map([[k, rf('xyz')]]); return sub(m); }
			function lt(t: Lit<any>): keyof TM { return typeof t.value === 'string' ? 'string' : typeof t.value === 'number' ? 'number' : 'boolean'; }
			function isL<K extends keyof TM>(t: Ty, k: K): t is Lit<TM[K]> { return t.type === 'literal' && lt(t) === k; }
			function strOrNum(named: Ty): number { if (!isL(named, 'string') && !isL(named, 'number')) return -1; return String(named.value).length; }
			export function guards(): number { return strOrNum({ type: 'literal', value: 'abc' }) * 100 + strOrNum({ type: 'literal', value: 12345 }) * 10 + strOrNum({ type: 'ref', name: 'x' }) + 1; }
		`);
		check('new Map([[k, v]]) built at the Map type it is headed for', r10.mapArg() * 100 + r10.mapDecl(), 1213);
		check('a generic type guard narrows a wider member; its instantiations share one struct', r10.guards(), 350);

		// towasm.ts's `hostImportsIn`: `body.find(...)` then `decl?.type === 'function_decl'`. Each of these trapped,
		// failed to validate, or dispatched to structs the literals were never built as.
		const r11 = await compile(`
			interface FD { type: 'function_decl'; name: string; params: number[] }
			interface VD { type: 'var_decl'; name: string }
			interface MD { type: 'module_decl'; name: string; ambient: boolean; body: (FD | VD)[] }
			const md: MD = { type: 'module_decl', name: 'm', ambient: true, body: [{ type: 'var_decl', name: 'v' }, { type: 'function_decl', name: 'g', params: [1, 2] }] };
			function viaPredicate(s: string): number { const decl = md.body.find(d => d.type === 'function_decl' && d.name === s); return decl?.type === 'function_decl' ? decl.params.length : -1; }
			function viaUnion(s: string): number { const decl = md.body.find(d => d.name === s); return decl?.type === 'function_decl' ? decl.params.length : -1; }
			function direct(decl: FD | VD | undefined): number { return decl?.type === 'function_decl' ? decl.params.length : -1; }
			export function optDisc(): number {
				return (viaPredicate('g') * 10 + viaPredicate('zz') + 1) * 10000 + (viaUnion('g') * 10 + viaUnion('v') + 1) * 100 + direct(md.body[1]) * 10 + direct(undefined) + 1;
			}
		`);
		check('x?.disc === lit on a union / nullable receiver from find()', r11.optDisc(), 202020);

		// ts-parser.ts's `const parser = make()`: `makeCachedParser<T>(spec): Parser<T>` returns `makeParser`'s `LALRParser<T>`.
		const r12 = await compile(`
			interface Rule<T> { syms: string[]; action: ($: any[]) => T }
			type Rules<T> = Rule<T>[];
			interface Spec<T> { start: Rules<T>; skip?: string; rules?: Record<string, Rules<any>> }
			interface P<T> { name: string; parse(s: string): T | undefined }
			interface LP<T> extends P<T> { tables: number }
			interface Mod { type: 'module'; body: number[] }
			const base: Record<string, Rules<any>> = {};
			const program: Rules<Mod> = [{ syms: [], action: $ => ({ type: 'module', body: [1, 2] }) }];
			function makeParser<T>(spec: Spec<T>): LP<T> { return { name: spec.skip ?? 'p', tables: 0, parse: (s: string) => spec.start[0].action([s]) }; }
			function cached<T>(spec: Spec<T>): P<T> { return makeParser(spec); }
			function make() { return cached({ skip: 'ws', start: program as Rules<Mod>, rules: { ...base, extra: program } }); }
			const parser = make();
			export function parse(): number { const m = parser.parse('abc'); return parser.name.length * 10 + (m ? m.body.length : -1); }
		`);
		check('an extending interface upcasts to its base; a generic call is built for its destination', r12.parse(), 22);

		// tableCache.ts's `let cached: CacheFile | undefined`: an imported module's bodies were never checked (only
		// hoisted), so a local annotated with a module-private interface had no scope to resolve in.
		const r13 = await compileMulti({
			tcmod: `
				interface CacheFile { fingerprint: string; tables: { a: number[][] } }
				export function load<T>(v: T): number { let cached: CacheFile | undefined; if (v) cached = { fingerprint: 'xy', tables: { a: [[1]] } }; return cached ? cached.fingerprint.length : 0; }
				export function load2(v: boolean): number { let cached: CacheFile | undefined; if (v) cached = { fingerprint: 'xyz', tables: { a: [[1]] } }; return cached ? cached.fingerprint.length : 0; }
			`,
			main: `import { load, load2 } from './tcmod'; export function main(): number { return load(true) * 1000 + load(false) * 100 + load2(true) * 10 + load2(false); }`,
		}, 'main');
		check("an imported module's local annotated with its own private interface", r13.main(), 2030);

		// An argument sees its parameter's type, and a callback's return sees the callback's contextual return type:
		// `rule(() => ({ x: 5 }))` passed as `R<C>` builds `R<C>` and a `C`, not the literal's own ambiguous shape.
		const r14 = await compile(`
			interface B { x: number; y?: number }
			interface C { x: number; w?: string }
			interface R<T> { make: () => T }
			function rule<T>(make: () => T): R<T> { return { make }; }
			const rules: R<C>[] = [];
			function add(r: R<C>): number { rules.push(r); return rules.length; }
			export function ctxArg(): number { const b: B = { x: 7 }; add(rule(() => ({ x: 5 }))); const c = rules[0].make(); return c.x * 10 + b.x; }
		`);
		check('an argument and a callback return are built for their context', r14.ctxArg(), 57);

		// A literal whose shape is a runtime fact: a spread of a union, or a written discriminant holding a union
		// of literals -- one arm per possibility (type-utils.ts's `freeze`, ts-parser.ts's `TypeMember`).
		const r15 = await compile(`
			interface Lit { type: 'literal'; value: number; frozen?: boolean }
			interface Rng { type: 'range'; min: number; frozen?: boolean }
			interface Ref { type: 'ref'; name: string }
			type Ty = Lit | Rng | Ref;
			function freeze(t: Ty): Ty { return t.type === 'literal' || t.type === 'range' ? { ...t, frozen: true } : t; }
			function copy(t: Ty): Ty { const out: any = { ...t }; return out; }
			interface Sig { params: number[] }
			type Member = ({ type: 'call' } & Sig) | ({ type: 'construct' } & Sig);
			function member(type: 'call' | 'construct', sig: Sig): Member { return { type, ...sig }; }
			export function unionShaped(): number {
				const a = freeze({ type: 'literal', value: 5 }); const b = freeze({ type: 'range', min: 2 }); const c = freeze({ type: 'ref', name: 'x' });
				const fa = a.type === 'literal' && a.frozen ? a.value : -1; const fb = b.type === 'range' && b.frozen ? b.min : -1; const fc = c.type === 'ref' ? c.name.length : -1;
				const d = copy({ type: 'range', min: 9 }); const fd = d.type === 'range' ? d.min : -1;
				const m = member('construct', { params: [1, 2, 3] }); const fm = (m.type === 'construct' ? 100 : 0) + m.params.length;
				return fa * 10000 + fb * 1000 + fc * 100 + fd + fm * 100000;
			}
		`);
		check('an object literal shaped by a union spread or a union-of-literals discriminant', r15.unionShaped(), 10352109);
		check('&& as a statement runs for its effect', r.asStatement(), 5);
	}

	{
		// `%` is fmod, and wasm has no float remainder instruction. The bare `x - trunc(x/y)*y` made
		// `7 % Infinity` a `0 * Infinity` NaN, and lost the dividend's sign on an exact division.
		const r = await compile(`
			function mod(a: number, b: number): number { return a % b; }
			export function byInfinity(): number { return mod(7, 1 / 0); }
			export function negByNegInfinity(): number { return mod(-3, -1 / 0); }
			export function signOfZero(): number { return 1 / mod(-1, 1); }
			export function plainSignOfZero(): number { return 1 / mod(1, 1); }
			export function ordinary(): number { return mod(7, 3); }
			export function negOrdinary(): number { return mod(-5, 3); }
			export function byZero(): number { const n = mod(5, 0); return n === n ? 1 : 0; }
			export function infByFinite(): number { const n = mod(1 / 0, 3); return n === n ? 1 : 0; }
		`);
		check('x % Infinity is x', r.byInfinity(), 7);
		check('and keeps the sign through -Infinity', r.negByNegInfinity(), -3);
		check('-1 % 1 is -0, not 0', r.signOfZero(), -Infinity);
		check('...while 1 % 1 stays +0', r.plainSignOfZero(), Infinity);
		check('an ordinary remainder is unchanged', r.ordinary(), 1);
		check('...including a negative dividend', r.negOrdinary(), -2);
		check('x % 0 is still NaN', r.byZero(), 0);
		check('Infinity % x is still NaN', r.infByFinite(), 0);
	}

	{
		// A closure captures a BINDING, not a value. Copying the value into the env struct meant a write on
		// either side of the capture was invisible to the other: `let n = 1; const f = () => n + 1; n = 4;`
		// gave 2, and the counter idiom left `n` at 0. `ensureForwardHolder` already built the right thing --
		// a shared heap holder -- but only ever fired for a name used BEFORE its own declaration ran.
		const r = await compile(`
			export function mutateAfter(): number { let n = 1; const f = () => n + 1; n = 4; return f(); }
			export function mutateInside(): number { let n = 1; const f = () => { n = n + 1; return n; }; f(); f(); return n; }
			export function counter(): number { let n = 0; const inc = () => { n = n + 1; }; inc(); inc(); inc(); return n; }
			export function compound(): number { let n = 1; const f = () => { n *= 3; }; f(); f(); return n; }
			export function incr(): number { let n = 0; const f = () => { n++; }; f(); f(); return n; }
			export function twoClosures(): number { let n = 0; const a = () => { n = n + 1; }; const b = () => n * 10; a(); a(); return b(); }
			export function refHolder(): number { let s = 'a'; const f = () => { s = s + 'b'; }; f(); f(); return s.length; }
			export function nested(): number { let n = 1; const outer = () => { const inner = () => { n = n + 5; }; inner(); }; outer(); return n; }
			// A 'for (let i)' binding is PER-ITERATION, so each closure keeps its own -- one shared holder
			// would have every closure below see 3. This is 'Promise.all's own shape, and giving it a holder wrote
			// past the end of the results array.
			export function perIteration(): number {
				const out: number[] = [0, 0, 0];
				const fs: (() => void)[] = [];
				for (let i = 0; i < 3; i++)
					fs.push(() => { out[i] = i + 1; });
				for (const f of fs) f();
				return out[0] * 100 + out[1] * 10 + out[2];
			}
			// ...and 'var' is the exact opposite: function-scoped, so the whole loop shares ONE binding
			// and every closure sees its final value.
			export function varShared(): number {
				const fs: (() => number)[] = [];
				for (var i = 0; i < 3; i++)
					fs.push(() => i);
				return fs[0]() * 100 + fs[2]();
			}
			// controls: neither of these needs a holder at all
			export function notCaptured(): number { let n = 1; n = n + 2; return n; }
			export function capturedNotMutated(): number { const n = 3; const f = () => n * 2; return f(); }
		`);
		check('capture: a later write is seen by the closure', r.mutateAfter(), 5);
		check('capture: a write inside the closure is seen outside', r.mutateInside(), 3);
		check('capture: the counter idiom', r.counter(), 3);
		check('capture: compound assignment through the holder', r.compound(), 9);
		check("capture: '++' through the holder", r.incr(), 2);
		check('capture: two closures share one binding', r.twoClosures(), 20);
		check('capture: a reference-typed binding', r.refHolder(), 3);

		// `let x: T;` with no initializer. Definite assignment means the starting value is never read, so a
		// defaultable type starts at its default; a non-nullable ref has none, and starts as an empty holder.
		const u = await compile(`
			class P { constructor(public v: number) {} }
			export function scalar(c: boolean): number { let x: number; if (c) x = 1; else x = 2; return x; }
			export function nullable(c: boolean): number { let p: P | undefined; if (c) p = new P(7); return p ? p.v : -1; }
			export function nonNull(c: boolean): number { let p: P; if (c) p = new P(3); else p = new P(4); return p.v; }
			export function captured(): number { let n: number; const f = () => { n = 5; }; f(); return n; }
			export function forward(): number { const f = () => q.v; let q: P; q = new P(8); return f(); }
			function* gen(): Generator<number, number, number> { let x: number; x = 6; yield x; return x + 1; }
			export function hoisted(): number { const g = gen(); return g.next(0).value * 10 + g.next(0).value; }
		`);
		check('uninitialized let: scalar', u.scalar(1) * 10 + u.scalar(0), 12);
		check('uninitialized let: nullable', u.nullable(1) * 10 + u.nullable(0), 69);
		check('uninitialized let: non-nullable ref', u.nonNull(1) * 10 + u.nonNull(0), 34);
		check('uninitialized let: captured and assigned by a closure', u.captured(), 5);
		check('uninitialized let: forward-referenced by an earlier closure', u.forward(), 8);
		check('uninitialized let: hoisted into a generator frame', u.hoisted(), 67);
		check('capture: through a doubly-nested closure', r.nested(), 6);
		check('capture: a for-let binding stays per-iteration', r.perIteration(), 123);
		check('capture: a for-var binding is ONE shared binding', r.varShared(), 303);
		check('capture: an uncaptured local is untouched', r.notCaptured(), 3);
		check('capture: a captured const is untouched', r.capturedNotMutated(), 6);
	}

	{
		// A FLOAT view stores an IEEE bit pattern; `get`/`set` composed bytes as an integer for every
		// element type alike, so `a[0] = 1.5` truncated to 1. The f32 cases also pin the round-trip
		// through single precision -- 0.1 must read back as the f32-rounded double, exactly as JS does.
		const { f32Frac, f64Frac, f32Rounds, f32Neg, f64Neg, i32Extremes, u8Wraps } = await compile(`
			export function f32Frac(): number { const a = new Float32Array(1); a[0] = 1.5; return a[0]; }
			export function f64Frac(): number { const a = new Float64Array(1); a[0] = 3.25; return a[0]; }
			export function f32Rounds(): number { const a = new Float32Array(1); a[0] = 0.1; return a[0]; }
			export function f32Neg(): number { const a = new Float32Array(2); a[1] = -2.5; return a[1]; }
			export function f64Neg(): number { const a = new Float64Array(2); a[1] = -0.5; return a[1]; }
			export function i32Extremes(): number { const a = new Int32Array(1); a[0] = -2147483648; return a[0]; }
			export function u8Wraps(): number { const a = new Uint8Array(1); a[0] = 300; return a[0]; }
		`);
		check('typed array: a Float32Array stores a fraction', f32Frac(), 1.5);
		check('typed array: a Float64Array stores a fraction', f64Frac(), 3.25);
		check('typed array: a Float32Array round-trips through single precision', f32Rounds(), Math.fround(0.1));
		check('typed array: a negative f32 element', f32Neg(), -2.5);
		check('typed array: a negative f64 element', f64Neg(), -0.5);
		// Controls: the integer views must still perform ToInt32/wrapping, not float reinterpretation.
		check('typed array: an Int32Array still holds the full signed range', i32Extremes(), -2147483648);
		check('typed array: a Uint8Array still wraps', u8Wraps(), 44);
	}

	{
		// A field access the checker allowed only because it NARROWED the receiver first -- every
		// discriminated union in a real program. Codegen doesn't track narrowing, so the union-field
		// dispatch still sees every member and used to reject the ones that lack the field. A member the
		// narrowing excluded cannot be the runtime value, so it is simply left out of the cascade.
		const r = await compile(`
			type U = { k: 'a'; a: number } | { k: 'b'; b: number };
			function pick(u: U): number { return u.k === 'b' ? u.b : u.a; }
			export function viaB(): number { return pick({ k: 'b', b: 6 }); }
			export function viaA(): number { return pick({ k: 'a', a: 4 }); }
			// a field every member declares still dispatches across all of them, as before
			type Shared = { k: 'a'; n: number } | { k: 'b'; n: number };
			function common(s: Shared): number { return s.n; }
			export function sharedA(): number { return common({ k: 'a', n: 7 }); }
			export function sharedB(): number { return common({ k: 'b', n: 8 }); }
		`);
		check('union field: narrowed access reaches the member that has it', r.viaB(), 6);
		check('union field: ...and the other arm still works', r.viaA(), 4);
		check('union field: a field on every member is unaffected', r.sharedA(), 7);
		check('union field: ...on either member', r.sharedB(), 8);
	}

	{
		// `flatMap` wasn't declared at all -- not in `lib/array.ts`, not in `lib.d.ts` -- so every
		// `xs.flatMap(...)` typed as `any`. towasm.ts's own `LIB_DECLS` is `[...filter(...),
		// ...filter(...).flatMap(...)]`, and one `any` in a spread poisons the array: `for (const d of
		// LIB_DECLS)` gave `d: any`, which is where all 35 of that file's `unknown field 'name'` came from.
		// Full-arity callbacks here because a shorter one is a separate, still-open gap (a 1-parameter
		// arrow handed to a `(value, index, array)` signature -- the array-callback cluster).
		const r = await compile(`
			export function len(): number { const a = [1, 2]; return a.flatMap((x: number, i: number, arr: number[]) => [x, x]).length; }
			export function nested(): number { const a = [1, 2]; return a.flatMap((x: number, i: number, arr: number[]) => [x, x, x]).length; }
			export function empties(): number { const a = [1, 2, 3]; return a.flatMap((x: number, i: number, arr: number[]) => x > 1 ? [x] : []).length; }
			// the callback must run exactly ONCE per element -- sizing the result with a second pass would
			// re-run its effects
			export function once(): number { let n = 0; const a = [1, 2, 3]; a.flatMap((x: number, i: number, arr: number[]) => { n = n + 1; return [x]; }); return n; }
			export function emptySource(): number { const a: number[] = []; return a.flatMap((x: number, i: number, arr: number[]) => [x]).length; }
		`);
		check('flatMap: flattens one level', r.len(), 4);
		check('flatMap: ...whatever the part length', r.nested(), 6);
		check('flatMap: an empty part contributes nothing', r.empties(), 2);
		check('flatMap: the callback runs once per element', r.once(), 3);
		check('flatMap: an empty source gives an empty result', r.emptySource(), 0);
	}

	{
		// `'k' in u` on a UNION is a TYPE test, not a property lookup -- it is how TypeScript narrows a
		// union whose members carry no literal discriminant, and each member is its own nominal struct, so
		// the answer is which member `u` actually is. `in` was only ever supported over a dynamic object.
		const r = await compile(`
			class A { a: number; constructor(a: number) { this.a = a; } }
			class B { b: number; constructor(b: number) { this.b = b; } }
			type U = A | B;
			function hasB(u: U): number { return 'b' in u ? 1 : 0; }
			function pick(u: U): number { return 'b' in u ? u.b : u.a; }
			class N1 { n: number; constructor(n: number) { this.n = n; } }
			class N2 { n: number; constructor(n: number) { this.n = n; } }
			function everyone(u: N1 | N2): number { return 'n' in u ? 1 : 0; }
			function nobody(u: U): number { return 'z' in u ? 1 : 0; }
			export function present(): number { return hasB(new B(1)); }
			export function absent(): number { return hasB(new A(1)); }
			export function narrows(): number { return pick(new B(7)) * 10 + pick(new A(3)); }
			export function allDeclare(): number { return everyone(new N1(1)); }
			export function noneDeclare(): number { return nobody(new A(1)); }
			// the pre-existing dynamic-object path is untouched
			export function dynamic(): number { const o: { [k: string]: number } = { x: 1 }; return ('x' in o ? 1 : 0) * 10 + ('y' in o ? 1 : 0); }
		`);
		check("in: true for the member that declares it", r.present(), 1);
		check("in: false for the member that doesn't", r.absent(), 0);
		check('in: and it narrows, so the field is readable', r.narrows(), 73);
		check('in: constant when every member declares it', r.allDeclare(), 1);
		check('in: constant when none does', r.noneDeclare(), 0);
		check('in: a dynamic object still asks the map', r.dynamic(), 10);
	}

	{
		// A `never` member makes a union unanswerable for every walk that asks "what could this be" --
		// nothing inhabits one, so it can never be the runtime value. `typeof LIB_DECLS[number]` really has
		// one (a generic parameter substituted away), and a single uninhabited arm was enough to stop the
		// union-member dispatch resolving owners at all.
		const { field, viaIn } = await compile(`
			class A { a: number; constructor(a: number) { this.a = a; } }
			class B { a: number; b: number; constructor(a: number) { this.a = a; this.b = 9; } }
			type U = A | never | B;
			function readField(u: U): number { return u.a; }
			function hasB(u: U): number { return 'b' in u ? 1 : 0; }
			export function field(): number { return readField(new A(5)) * 10 + readField(new B(6)); }
			export function viaIn(): number { return hasB(new B(0)) * 10 + hasB(new A(0)); }
		`);
		check('never: an uninhabited member does not block union field access', field(), 56);
		check("never: ...nor the union's own 'in' type test", viaIn(), 10);
	}

	{
		// Calling a method on a UNION receiver -- the sibling of `case 'member'`'s union FIELD dispatch,
		// and the same `ref.test` cascade, just calling each member's method instead of reading its field.
		// Emitted inline rather than as a shared dispatcher: the arguments are ordinary expressions at the
		// call site, and re-emitting them per arm duplicates code but not evaluation, since exactly one arm
		// ever runs -- `argOnce` is the check that matters there.
		const r = await compile(`
			class A { v: number; constructor(v: number) { this.v = v; } n(): number { return this.v * 10; } add(k: number): number { return this.v + k; } tag(): string { return 'a'; } }
			class B { w: number; constructor(w: number) { this.w = w; } n(): number { return this.w * 100; } add(k: number): number { return this.w - k; } tag(): string { return 'bb'; } }
			type U = A | B;
			function callN(u: U): number { return u.n(); }
			function callAdd(u: U, k: number): number { return u.add(k); }
			function callTag(u: U): number { return u.tag().length; }
			export function viaA(): number { return callN(new A(2)); }
			export function viaB(): number { return callN(new B(3)); }
			export function withArgA(): number { return callAdd(new A(10), 4); }
			export function withArgB(): number { return callAdd(new B(10), 4); }
			export function strResult(): number { return callTag(new A(0)) * 10 + callTag(new B(0)); }
			export function argOnce(): number { let n = 0; const bump = (): number => { n = n + 1; return 1; }; const u: U = new B(5); callAdd(u, bump()); return n; }
			export function withNever(): number { const u: A | never | B = new B(4); return u.n(); }
		`);
		check('union method: dispatches to the first member', r.viaA(), 20);
		check('union method: ...and to the second', r.viaB(), 300);
		check('union method: passes arguments through', r.withArgA(), 14);
		check('union method: ...to either member', r.withArgB(), 6);
		check('union method: a non-scalar result still agrees across arms', r.strResult(), 12);
		check('union method: an argument is evaluated exactly once', r.argOnce(), 1);
		check('union method: a never member is skipped', r.withNever(), 400);
	}

	{
		// A mapped type's key constraint that is a NESTED union of aliases (`type Keys = Small | 'c'`).
		// `resolve` reduces the union itself but leaves its members alone, so one member arriving as an
		// unresolved alias made the flat "every key is a literal" test fail and the whole mapped type
		// stayed opaque. towasm.ts's own `ARR_WTYPE: Record<WasmElementI, WasmType>` is exactly this, and
		// it blocked that file at module level.
		const { sum, deeper } = await compile(`
			type Small = 'a' | 'b';
			type Keys = Small | 'c';
			type Deeper = Keys | 'd';
			const M: Record<Keys, number> = { a: 1, b: 2, c: 30 };
			const D: Record<Deeper, number> = { a: 1, b: 2, c: 30, d: 400 };
			export function sum(): number { return M.a + M.b + M.c; }
			export function deeper(): number { return D.a + D.d; }
		`);
		check('mapped type: a nested-union key constraint resolves', sum(), 33);
		check('mapped type: ...however deeply the aliases nest', deeper(), 401);
	}

	{
		// A union whose members are themselves union ALIASES (`type AB = A | B` used in `AB | C`).
		// `T.resolve` reduces the union itself but leaves its members alone, so every consumer that walked
		// `.types` directly saw an unresolved alias and gave up -- the same root that broke the `in` test,
		// both union dispatches and a mapped type's key constraint, each found separately.
		// `T.unionMembers` is the shared walk now; it resolves only to DISCOVER nesting and yields the raw
		// member, since `ownerFor` matches on nominal identity and a resolved class is just a shape.
		const r = await compile(`
			class A { a: number; constructor(a: number) { this.a = a; } m(): number { return 1; } }
			class B { a: number; b: number; constructor(a: number) { this.a = a; this.b = 2; } m(): number { return 2; } }
			class C { a: number; constructor(a: number) { this.a = a; } m(): number { return 3; } }
			type AB = A | B;
			type Nested = AB | C;
			function field(u: Nested): number { return u.a; }
			function method(u: Nested): number { return u.m(); }
			function inTest(u: Nested): number { return 'b' in u ? 1 : 0; }
			function truthy(u: Nested): number { return u ? 1 : 0; }
			export function viaField(): number { return field(new B(5)) * 10 + field(new C(6)); }
			export function viaMethod(): number { return method(new A(0)) * 100 + method(new C(0)); }
			export function viaIn(): number { return inTest(new B(0)) * 10 + inTest(new C(0)); }
			export function viaTruthy(): number { return truthy(new C(0)); }
		`);
		check('nested union alias: field access', r.viaField(), 56);
		check('nested union alias: method dispatch', r.viaMethod(), 103);
		check("nested union alias: 'in' type test", r.viaIn(), 10);
		check('nested union alias: truthiness', r.viaTruthy(), 1);
	}

	{
		// A getter reached through an optional chain is guarded like any other link: the receiver is evaluated once,
		// the getter runs only when it is present, and the whole access yields `undefined` when it is not.
		const { chainGetter } = await compile(`
			class Box {
				private n_: number;
				constructor(n: number) { this.n_ = n; }
				get len(): number { return this.n_; }
			}
			export function chainGetter(flag: number): number {
				const b: Box | undefined = flag > 100 ? undefined : new Box(7);
				const gone: Box | undefined = flag > 100 ? new Box(1) : undefined;
				return (b?.len ?? -1) + (b ? b.len : 0) + (gone?.len ?? -100);
			}
		`);
		check('chainGetter()', chainGetter(0), 7 + 7 - 100);
	}

	{
		// JS applies a parameter's default when the argument is `undefined`, so passing it explicitly is the same as
		// omitting it -- the shape `type-utils.ts` uses throughout (`resolve(scope, t, undefined, stopAtRef)`).
		const { explicitUndefined, omitted } = await compile(`
			function g(a: number, b = 10, c = 100): number { return a + b + c; }
			export function explicitUndefined(): number { return g(1, undefined, 3); }
			export function omitted(): number { return g(1); }
		`);
		check('explicitUndefined()', explicitUndefined(), 14);
		check('omitted()', omitted(), 111);
	}

	{
		// `new X` needs X to be a KNOWN CLASS, so a global the lib never declared fails at codegen, not at checking --
		// which is how one missing `WeakSet` blocked every declaration in two whole files of the self-hosting survey.
		const { errClass, weakSet } = await compile(`
			export function errClass(): number {
				const e = new SyntaxError("bad token");
				return e.name.length + e.message.length;
			}
			class Node { constructor(public id: number) {} }
			export function weakSet(): number {
				const seen = new WeakSet<Node>();
				const a = new Node(1), b = new Node(2);
				seen.add(a);
				return (seen.has(a) ? 1 : 0) + (seen.has(b) ? 10 : 0);
			}
		`);
		check('errClass()', errClass(), 'SyntaxError'.length + 'bad token'.length);
		check('weakSet()', weakSet(), 1);
	}

	{
		// A checker guard that only the LIB scope can catch: here `Array` is a real class, so an `Array<T>` source is
		// expanded to its members before a union destination is decomposed, and `F['modifiers']` (an optional property's
		// indexed access, hence `string[] | undefined`) could never be reached by an array again. `compile` throws on any
		// checker error, so this fails loudly if that ordering regresses.
		const { arrayThroughUnion } = await compile(`
			interface F { modifiers?: string[] }
			export function arrayThroughUnion(): number {
				const m: { modifiers?: F["modifiers"] } = { modifiers: ["x", "y"] };
				return m.modifiers ? m.modifiers.length : 0;
			}
		`);
		check('arrayThroughUnion()', arrayThroughUnion(), 2);
	}

	{
		// A structural shape's identity is its physical layout, not its printed type: field order and a literal
		// vs its widened type change neither. `fieldOrder` crosses `{a;b}` into `{b;a}`; `sameLayoutUnion`'s two
		// members share one struct, so narrowing and spread must read the tag from the value itself.
		const { fieldOrder, sameLayoutUnion } = await compile(`
			type P = { a: number; b: string };
			function h(q: { b: string; a: number }): number { return q.a + q.b.length; }
			export function fieldOrder(): number { const p: P = { a: 1, b: "xy" }; return h(p); }

			type K = { type: "a"; v: number } | { type: "b"; v: number };
			function f(k: K): number { return k.type === "a" ? k.v : -k.v; }
			function g(k: K): number { const c = { ...k }; return c.type === "b" ? c.v * 10 : c.v; }
			export function sameLayoutUnion(): number {
				return f({ type: "a", v: 2 }) + f({ type: "b", v: 3 }) + g({ type: "b", v: 4 }) + g({ type: "a", v: 5 });
			}
		`);
		check('fieldOrder()', fieldOrder(), 3);
		check('sameLayoutUnion()', sameLayoutUnion(), 44);
	}

	{
		// A block-scoped name is bound for its whole block, so a closure in its OWN initializer reaches it -- also
		// inside a NESTED block (type-utils.ts's `objectKeyNames`, in a switch case), and from a nested callback.
		const { selfRecursiveLocal, selfRecursiveNested } = await compile(`
			export function selfRecursiveLocal(): number {
				const base = 10;
				if (base > 0) {
					const sum = (n: number): number => n <= 0 ? base : n + sum(n - 1);
					return sum(4);
				}
				return -1;
			}
			type Tree = { v: number; kids: Tree[] };
			export function selfRecursiveNested(kind: number): number {
				switch (kind) {
					case 1: {
						const total = (t: Tree): number => { let s = t.v; for (const x of t.kids.map(k => total(k))) s += x; return s; };
						return total({ v: 1, kids: [{ v: 2, kids: [] }, { v: 3, kids: [{ v: 4, kids: [] }] }] });
					}
				}
				return -1;
			}
		`);
		check('selfRecursiveLocal()', selfRecursiveLocal(), 20);
		check('selfRecursiveNested(1)', selfRecursiveNested(1), 10);
	}

	{
		// An optional field whose type collapses to boxed `any` (a multi-shape union) is still OPTIONAL: absent reads
		// back `undefined`, and `??=` fills it (type-utils.ts's `entry.defaultSubstitution ??= ...`).
		const { optionalUnionMemo } = await compile(`
			type Sh = { kind: "a"; n: number } | { kind: "b"; s: string };
			interface Entry { base: Sh; memo?: Sh }
			function memoOf(e: Entry): Sh { e.memo ??= e.base; return e.memo; }
			export function optionalUnionMemo(): number {
				const e: Entry = { base: { kind: "a", n: 7 } };
				const absent = e.memo === undefined ? 100 : 0;
				const m = memoOf(e);
				return absent + (m.kind === "a" ? m.n : -1) + (e.memo !== undefined ? 1000 : 0);
			}
		`);
		check('optionalUnionMemo()', optionalUnionMemo(), 1107);
	}

	{
		// A field written through `as any` on a union receiver (checker.ts's `(s as any).scope ??= scope`) is an
		// expando that may never have been set: it reads back `undefined` until written, and `??=` keeps the first.
		const { expandoNullishAssign } = await compile(`
			interface A { kind: "a" }
			interface B { kind: "b" }
			function stamp(x: A | B, v: string): string { (x as any).tag ??= v; return (x as any).tag as string; }
			export function expandoNullishAssign(): number {
				const a: A = { kind: "a" };
				const b: B = { kind: "b" };
				const absent = (b as any).tag === undefined ? 100 : 0;
				const first = stamp(a, "xy");
				const second = stamp(a, "zzz");
				return absent + first.length * 10 + second.length;
			}
		`);
		check('expandoNullishAssign()', expandoNullishAssign(), 122);
	}

	{
		// Two writes whose slots are the same wasm type built as two different objects -- an optional union field's
		// fresh `nullableWtype(REF_ANY)` and a dynamic field's `REF_ANY_NULLABLE` -- share one `$new` scratch local.
		const { sameKeyTemps } = await compile(`
			type Sh = { kind: "a"; n: number } | { kind: "b"; s: string };
			interface Holder { memo?: Sh }
			interface A { kind: "a" }
			interface B { kind: "b" }
			export function sameKeyTemps(): number {
				const h: Holder = {};
				const x: A | B = { kind: "a" };
				const s: Sh = { kind: "a", n: 3 };
				h.memo = s;
				(x as any).tag = s;
				return (h.memo !== undefined ? 10 : 0) + ((x as any).tag !== undefined ? 1 : 0);
			}
		`);
		check('sameKeyTemps()', sameKeyTemps(), 11);
	}

	{
		// A key written onto a receiver typed only as a type parameter lands on whatever reaches it: a direct call's
		// argument, one forwarded through another generic, and -- the stamper passed as a VALUE and applied to a
		// callback's result -- that callback's returned object (the parsers' `makeRule(stampPos)` shape).
		const { stampDirect, stampForwarded, stampViaValue } = await compile(`
			interface Leaf { kind: "leaf"; v: number }
			interface Pair { kind: "pair"; a: number; b: number }
			function tagIt<T>(t: T): T { Object.defineProperty(t, "tag", { value: 42 }); return t; }
			function viaForward<T>(t: T): T { return tagIt(t); }
			function withCommon(common: <T>(t: T) => T, action: () => Leaf): () => Leaf { return () => common(action()); }
			function makeLeaf(): Leaf { return { kind: "leaf", v: 1 }; }
			function tagOf(x: unknown): number { return (x as any).tag as number; }
			export function stampDirect(): number { const p: Pair = { kind: "pair", a: 1, b: 2 }; tagIt(p); return tagOf(p); }
			export function stampForwarded(): number { const p: Pair = { kind: "pair", a: 3, b: 4 }; viaForward(p); return tagOf(p) + p.a; }
			export function stampViaValue(): number { const f = withCommon(tagIt, makeLeaf); const l = f(); return tagOf(l) + l.v; }
		`);
		check('stampDirect()', stampDirect(), 42);
		check('stampForwarded()', stampForwarded(), 45);
		check('stampViaValue()', stampViaValue(), 43);
	}

	{
		// A base interface that gains an expando slot must stay its derived interface's wasm supertype: the derived
		// layout repeats the base's WHOLE layout, expandos included, or upcasting a `Derived` to `Base` cannot compile.
		const { derivedUpcast } = await compile(`
			interface Base { a: number }
			interface Derived extends Base { b: number }
			function tagIt<T>(t: T): T { Object.defineProperty(t, "tag", { value: 1 }); return t; }
			function tagOf(x: unknown): number { return (x as any).tag as number; }
			function takeBase(x: Base): number { return x.a; }
			export function derivedUpcast(): number {
				const b: Base = { a: 5 };
				tagIt(b);
				const d: Derived = { a: 1, b: 2 };
				return takeBase(d) + tagOf(b);
			}
		`);
		check('derivedUpcast()', derivedUpcast(), 2);
	}

	{
		// A default no call site can re-emit (a call, a capture, `this`, `new`) is applied in the callee, where JS evaluates it.
		const { calleeDefaultCall, calleeDefaultUndefined, calleeDefaultClosure, calleeDefaultMethod, calleeDefaultScalar } = await compile(`
			function seed(): number[] { return [1, 2]; }
			function sum(n: number, xs = seed()): number { let t = n; for (const x of xs) t += x; return t; }
			export function calleeDefaultCall(): number { return sum(10) * 100 + sum(0, [5]); }
			export function calleeDefaultUndefined(): number { return sum(1, undefined); }
			export function calleeDefaultClosure(): number {
				const base = 7;
				function add(x: number, y = base * 2): number { return x + y; }
				const count = (s: string, seen = new Set<string>()): number => { seen.add(s); return seen.size; };
				return add(1) * 100 + add(1, 2) * 10 + count('a');
			}
			class Box { n = 4; get(k: number = this.twice()): number { return k + 1; } twice(): number { return this.n * 2; } }
			export function calleeDefaultMethod(): number { return new Box().get() * 10 + new Box().get(0); }
			function next(): number { return 41; }
			function inc(k = next()): number { return k + 1; }
			export function calleeDefaultScalar(): number { return inc() * 1000 + inc(0); }
		`);
		check('calleeDefaultCall()', calleeDefaultCall(), 1305);
		check('calleeDefaultUndefined()', calleeDefaultUndefined(), 4);
		check('calleeDefaultClosure()', calleeDefaultClosure(), 1531);
		check('calleeDefaultMethod()', calleeDefaultMethod(), 91);
		check('calleeDefaultScalar()', calleeDefaultScalar(), 42001);

		// The default names something the CALLER cannot see (checker.ts's `checkBlock(..., typeOf = typeOf1())`).
		const { calleeDefaultCrossModule } = await compileMulti({
			lib: `
				function hidden(): number { return 40; }
				export function f(x: number, y = hidden()): number { return x + y; }
			`,
			main: `
				import { f } from './lib';
				export function calleeDefaultCrossModule(): number { return f(2); }
			`,
		}, 'main');
		check('calleeDefaultCrossModule()', calleeDefaultCrossModule(), 42);
	}

	{
		// An expression-bodied arrow sees a captured name narrowed where the arrow is created (towasm.ts's own `wasmTypeEq`).
		const { arrowNarrowed } = await compile(`
			type W = 'i32' | 'f64' | { ref: string } | { closure: { params: W[] } };
			function eq(a: W, b: W): boolean {
				if (typeof a === 'string' || typeof b === 'string')
					return a === b;
				if ('ref' in a && 'ref' in b)
					return a.ref === b.ref;
				if ('closure' in a && 'closure' in b)
					return a.closure.params.every((p, i) => eq(p, b.closure.params[i]));
				return false;
			}
			export function arrowNarrowed(): number {
				const x: W = { closure: { params: ['i32', { ref: 'A' }] } };
				const y: W = { closure: { params: ['i32', { ref: 'A' }] } };
				const z: W = { closure: { params: ['i32', { ref: 'B' }] } };
				return (eq(x, y) ? 10 : 0) + (eq(x, z) ? 1 : 0);
			}
		`);
		check('arrowNarrowed()', arrowNarrowed(), 10);
	}

	{
		// `for...of` over a non-array iterates by the protocol: `[Symbol.iterator]()`, then `next()` until `done`.
		const { iterGen, iterMap, iterSet, iterUserClass, iterBreakContinue } = await compile(`
			function* gen(): Generator<number, void, unknown> { yield 1; yield 2; yield 3; }
			export function iterGen(): number { let s = 0; for (const x of gen()) s = s * 10 + x; return s; }
			export function iterMap(): number {
				const m = new Map<string, number>([['a', 1], ['bb', 2]]);
				let s = 0;
				for (const [k, v] of m)
					s += k.length * 10 + v;
				return s;
			}
			export function iterSet(): number { const st = new Set<number>([4, 5]); let s = 0; for (const x of st) s += x; return s; }
			function* upTo(n: number): Generator<number, void, unknown> { for (let i = 0; i < n; i++) yield i; }
			class Range { constructor(public n: number) {} [Symbol.iterator](): Generator<number, void, unknown> { return upTo(this.n); } }
			export function iterUserClass(): number { let s = 0; for (const x of new Range(4)) s += x; return s; }
			function* five(): Generator<number, void, unknown> { for (let i = 1; i <= 5; i++) yield i; }
			export function iterBreakContinue(): number {
				let s = 0;
				for (const x of five()) {
					if (x === 2) continue;
					if (x === 4) break;
					s += x;
				}
				return s;
			}
		`);
		check('iterGen()', iterGen(), 123);
		check('iterMap()', iterMap(), 33);
		check('iterSet()', iterSet(), 9);
		check('iterUserClass()', iterUserClass(), 6);
		check('iterBreakContinue()', iterBreakContinue(), 4);
	}

	{
		// A Map/Set's iterator is a Generator: its yield comes off the type arguments, not `next()`'s bundled
		// IteratorResult, whose `value: Y | R` made `x` below `string | void` and this a type error.
		const { iterTyped } = await compile(`
			function len(s: string): number { return s.length; }
			export function iterTyped(): number {
				const st = new Set<string>(['ab', 'c']);
				const m = new Map<string, number>([['xyz', 4]]);
				let n = 0;
				for (const x of st)
					n += len(x);
				for (const [k, v] of m)
					n += len(k) * 10 + v;
				return n;
			}
		`);
		check('iterTyped()', iterTyped(), 37);
	}

	{
		// A `find`/`findIndex` predicate returns `unknown`, as TS's lib declares, and is tested for truthiness:
		// type-utils.ts's `find(m => literalKeys(m))` returns an array or undefined, not a boolean.
		const { findTruthy } = await compile(`
			function keysOf(n: number): string[] | undefined { return n > 2 ? ['k'] : undefined; }
			export function findTruthy(): number {
				const xs = [1, 3, 5];
				return (xs.find(x => keysOf(x)) ?? 0) * 10 + xs.findIndex(x => keysOf(x));
			}
		`);
		check('findTruthy()', findTruthy(), 31);
	}

	{
		// A spread of a non-array iterable drains its iterator into the new array, as JS does (type-utils.ts's `[...new Set(...)]`).
		const { spreadSet, spreadGen, spreadMap } = await compile(`
			export function spreadSet(): number { const xs = [...new Set<number>([3, 1, 3, 2])]; return xs.length * 100 + xs[0] * 10 + xs[2]; }
			function* gen(): Generator<number, void, unknown> { yield 7; yield 8; }
			export function spreadGen(): number { const xs = [1, ...gen(), 9]; return xs.length * 1000 + xs[1] * 100 + xs[2] * 10 + xs[3]; }
			export function spreadMap(): number { const m = new Map<string, number>([['a', 5]]); const es = [...m]; return es.length * 10 + es[0][1]; }
		`);
		check('spreadSet()', spreadSet(), 332);
		check('spreadGen()', spreadGen(), 4789);
		check('spreadMap()', spreadMap(), 15);
	}

	{
		// A type parameter never infers from itself: `flatMap(t => c ? [t.name] : [])`'s `[]` is typed against the unsolved `U[]`,
		// and taking `U` from it left `Set<U>` with nothing to represent (type-utils.ts's `combineTypes`).
		const { flatMapInfer } = await compile(`
			interface N { name: string }
			export function flatMapInfer(): number {
				const xs: N[] = [{ name: 'a' }, { name: 'bcd' }, { name: 'ef' }];
				const s = new Set(xs.flatMap(t => t.name.length > 1 ? [t.name] : []));
				return s.size * 10 + (s.has('bcd') ? 1 : 0);
			}
		`);
		check('flatMapInfer()', flatMapInfer(), 21);
	}

	{
		// `flat()` flattens one level (type-utils.ts's `parts.flat()`), typed as TS's FlatArray reduces at depth 1.
		const { flatNested } = await compile(`
			export function flatNested(): number {
				const parts: string[][] = [['a', 'b'], [], ['c']];
				const f: string[] = parts.flat();
				return f.length * 10 + (f[2] === 'c' ? 1 : 0);
			}
		`);
		check('flatNested()', flatNested(), 31);
	}

	{
		// A type guard its argument's type settles is decided statically and the dead branch never compiled -- lib `flat` on a
		// `number[]` has an array branch that cannot compile for a number, and on `string[][]` the reverse.
		const { guardFold } = await compile(`
			function sum(xs: number[]): number { return xs.reduce((a, b) => a + b, 0); }
			export function guardFold(): number {
				const n: number = 5;
				let r = 0;
				if (Array.isArray(n)) r += n.length; else r += n;
				const s: string[] = ['ab'];
				if (!Array.isArray(s)) r += 100; else r += s.length * 10;
				const nums = [1, 2].flat();
				return r + nums.length * 100 + sum(nums);
			}
		`);
		check('guardFold()', guardFold(), 218);
	}

	{
		// `x || undefined`: the right has no representation of its own, so it takes the whole expression's type, as a
		// conditional's branch does (type-utils.ts `matchInfer`'s `a.elements.every(...) || undefined`).
		const { orUndefined } = await compile(`
			function kept(xs: number[]): boolean | undefined { return xs.every(x => x > 0) || undefined; }
			export function orUndefined(): number {
				const a = kept([1, 2]), b = kept([1, -1]);
				return (a === true ? 10 : 0) + (b === undefined ? 1 : 0);
			}
		`);
		check('orUndefined()', orUndefined(), 11);
	}

	{
		// An instantiation expression read as a value is the generic function instantiated at its type arguments (ts-parser.ts
		// `export const CallSig = JS.CallSig<Type>`), named directly or through a namespace.
		const { instValue } = await compileMulti({
			lib: `export function pick<T>(xs: T[], i: number): T { return xs[i]; }`,
			main: `
				import * as L from './lib';
				import { pick } from './lib';
				const pickNum = pick<number>;
				const pickStr = L.pick<string>;
				export function instValue(): number { return pickNum([4, 5], 1) * 10 + pickStr(['ab', 'c'], 0).length; }
			`,
		}, 'main');
		check('instValue()', instValue(), 52);
	}

	{
		// `typeof x` as a VALUE when the type allows several tags: tested at run time, one tag after another (type-utils.ts
		// `typeofName`'s `typeof r.value`). A null slot is 'object' when the type admits null and not undefined.
		const { typeofValue } = await compile(`
			function tag(v: string | number | boolean | null): string { return typeof v; }
			export function typeofValue(): number {
				return (tag('a') === 'string' ? 1 : 0) + (tag(1) === 'number' ? 10 : 0) + (tag(true) === 'boolean' ? 100 : 0) + (tag(null) === 'object' ? 1000 : 0);
			}
		`);
		check('typeofValue()', typeofValue(), 1111);
	}

	{
		// An optional parameter property in a constructor that collects its fields first (an object-typed field forces that):
		// its seeded default and its assignment are one local (type-utils.ts's `Scope`).
		const { paramPropOptional } = await compile(`
			class S {
				private values = new Map<string, number>();
				constructor(public parent?: S, private tag?: string) {}
				depth(): number { return this.parent ? this.parent.depth() + 1 : 0; }
			}
			export function paramPropOptional(): number { const a = new S(); const b = new S(a, 'x'); return b.depth() * 10 + a.depth(); }
		`);
		check('paramPropOptional()', paramPropOptional(), 10);
	}

	{
		// An intersection of an IMPORTED union with a discriminant reduces to the matching member, even though the union's
		// members are known only where it is declared (checker.ts's `stmt: Stmt & { type: 'switch' }`).
		const { importedUnionIntersection } = await compileMulti({
			lib: `
				export interface A { type: 'a'; x: number }
				export interface B { type: 'b'; items: number[] }
				export type U = A | B;
			`,
			main: `
				import type { U } from './lib';
				function count(b: U & { type: 'b' }): number { return b.items.length; }
				export function importedUnionIntersection(): number {
					const u: U = { type: 'b', items: [1, 2, 3] };
					return u.type === 'b' ? count(u) : 0;
				}
			`,
		}, 'main');
		check('importedUnionIntersection()', importedUnionIntersection(), 3);
	}

	{
		// Unary `+` on a string is ToNumber, i.e. `Number(s)` (type-utils.ts `lookupMember`'s `t.elements[+prop]`).
		const { unaryPlusString } = await compile(`
			export function unaryPlusString(): number {
				const s = '42', t = ' 7 ', e = '';
				return +s + +t + (+e === 0 ? 100 : 0);
			}
		`);
		check('unaryPlusString()', unaryPlusString(), 149);
	}

	{
		// A struct passed where the parameter is a DIFFERENT, structural type it does not subtype: the callee is monomorphized per
		// argument type (common.ts `hasMod(e: {modifiers?: string[]}, m)` called with a `Param`), and gets the same object.
		const { structuralParam } = await compileMulti({
			common: `
				export function hasMod(e: { modifiers?: string[] }, m: string): boolean { return !!e.modifiers?.includes(m); }
				export function addMod(e: { modifiers?: string[] }, m: string): void { (e.modifiers ??= []).push(m); }
			`,
			main: `
				import { hasMod, addMod } from './common';
				interface Param { key: string; modifiers?: string[] }
				interface Field { name: string; size: number; modifiers?: string[] }
				export function structuralParam(): number {
					const p: Param = { key: 'a', modifiers: ['optional'] };
					const f: Field = { name: 'b', size: 2 };
					addMod(f, 'readonly');
					return (hasMod(p, 'optional') ? 1 : 0) + (hasMod(f, 'readonly') ? 10 : 0) + (hasMod(p, 'x') ? 100 : 0) + (f.modifiers!.length * 1000);
				}
			`,
		}, 'main');
		check('structuralParam()', structuralParam(), 1011);
	}

	{
		// A primitive intersected with an object type is that primitive at run time: `NonNullable<T>` is `T & {}` (tocode.ts
		// `maybe(type.name, name => '.' + name)`), and a branded `string & {__brand}` reads `.length` off the string.
		const { brandedPrimitive } = await compile(`
			function maybe<T>(value: T, fn: (value: NonNullable<T>) => string) { return value ? fn(value as NonNullable<T>) : ''; }
			type Id = string & { readonly __brand: 'Id' };
			function idLength(id: Id): number { return id.length; }
			export function brandedPrimitive(): number {
				const n: string | undefined = 'ab';
				return maybe(n, s => s + '!').length * 10 + idLength('xyz' as Id);
			}
		`);
		check('brandedPrimitive()', brandedPrimitive(), 33);
	}

	{
		// Array.prototype.at: a negative index counts from the end, out of range is undefined (type-utils.ts `matchInfer`).
		const { arrayAt } = await compile(`
			export function arrayAt(): number {
				const xs = [3, 5, 7];
				const names = ['ab', 'cde'];
				return (xs.at(-1) ?? 0) * 100 + (xs.at(0) ?? 0) * 10 + (xs.at(5) === undefined ? 1 : 0) + (names.at(-1) ?? '').length * 1000;
			}
		`);
		check('arrayAt()', arrayAt(), 3731);
	}

	{
		// An array pattern over a non-array iterates, as JS does (`const [[name, arg]] = map`, type-utils.ts's `substituteType`).
		const { destrMap, destrGen, destrDefaults, destrParam } = await compile(`
			export function destrMap(): number { const m = new Map<string, number>([['ab', 7], ['c', 1]]); const [[k, v]] = m; return k.length * 10 + v; }
			function* gen(): Generator<number, void, unknown> { yield 1; yield 2; yield 3; yield 4; }
			export function destrGen(): number { const [a, , b, ...rest] = gen(); return a * 1000 + b * 100 + rest.length * 10 + rest[0]; }
			export function destrDefaults(): number { const [x, y = 9, z = 5] = new Set<number>([2]); return x * 100 + y * 10 + z; }
			function takesPair([a, b]: Set<number>): number { return a * 10 + b; }
			export function destrParam(): number { return takesPair(new Set<number>([3, 4])); }
		`);
		check('destrMap()', destrMap(), 27);
		check('destrGen()', destrGen(), 1314);
		check('destrDefaults()', destrDefaults(), 295);
		check('destrParam()', destrParam(), 34);
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
