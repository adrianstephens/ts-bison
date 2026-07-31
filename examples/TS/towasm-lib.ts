import * as TS from './ts-parser';

// ===================================================================
//  towasm lib: non-callback String/Array/Uint8Array methods
// ===================================================================
//
// Written as ordinary TS in the same subset `towasm.ts`'s `emitStmt`/`emitExpr` already compile (loops,
// indexing, comparisons, real `this`), parsed once (`LIB_AST`) and folded into `towasm.ts`'s
// per-kind "builtin-class" method tables -- see `arrayBoxOwners` there. Each kind gets its own class
// here (`ArrF64Box`/`ArrI32Box`/`ArrI8Box`/`StringBox`) purely so real TS method-namespacing gives every
// kind's `indexOf`/`slice`/... a plain, un-mangled name -- these classes are never wasm-GC structs and
// never touch `towasm.ts`'s own `classes` registry; `this` inside a method just resolves to the array/
// string `WasmType` directly. Monomorphized per kind (no generics): one template for the three numeric/
// byte kinds, since they only differ in the element/array type name and which allocator to call.
//
// Two gaps the language itself doesn't cover are filled by small hand-built intrinsics in towasm.ts
// instead (the `__towasm_*` names, plus `StringBox`'s `charAt`/`charCodeAt`, registered directly as
// `arrayBoxOwners.i16.inlineMethods`): allocating a fresh zero-filled buffer of a *runtime-computed*
// length (`Uint8Array` already has `new Uint8Array(n)`; the other three kinds don't), and reading/
// writing a `string` element-by-element (`this[i]`/`this[i] = x` are deliberately rejected for `string`
// at the language level -- real JS strings are immutable).
//
// Deliberately narrower than the real JS methods: `slice(start, end)` needs both arguments explicitly
// (no omitted-`end`/negative-index defaulting); `indexOf`/`lastIndexOf`/`includes` take exactly one
// argument (no optional `fromIndex`). Wrong arg counts throw from `towasm.ts`'s dispatch code itself --
// the general checker doesn't validate these calls at all (`string`/`Uint8Array` are `ref` types, never
// `T.sealed()`'s `'object'`, so `s.indexOf(x)` -- or a nonexistent method entirely -- passes `TStypeCheck`
// as `any` with zero argument checking).


function arrayMethodsSrc(className: string, arrType: string, elemType: string, allocFn: string): string {
	return `
		class ${className} {
			indexOf(x: ${elemType}): number {
				let i: number = 0;
				while (i < this.length) {
					if (this[i] === x)
						return i;
					i = i + 1;
				}
				return -1;
			}
			lastIndexOf(x: ${elemType}): number {
				let i: number = this.length - 1;
				while (i >= 0) {
					if (this[i] === x)
						return i;
					i = i - 1;
				}
				return -1;
			}
			includes(x: ${elemType}): boolean {
				return this.indexOf(x) !== -1;
			}
			slice(start: number, end: number): ${arrType} {
				const len: number = end - start;
				const result: ${arrType} = ${allocFn}(len);
				let i: number = 0;
				while (i < len) {
					result[i] = this[start + i];
					i = i + 1;
				}
				return result;
			}
			reverse(): ${arrType} {
				const len: number = this.length;
				const result: ${arrType} = ${allocFn}(len);
				let i: number = 0;
				while (i < len) {
					result[i] = this[len - 1 - i];
					i = i + 1;
				}
				return result;
			}
			concat(b: ${arrType}): ${arrType} {
				const result: ${arrType} = ${allocFn}(this.length + b.length);
				let i: number = 0;
				while (i < this.length) {
					result[i] = this[i];
					i = i + 1;
				}
				let j: number = 0;
				while (j < b.length) {
					result[this.length + j] = b[j];
					j = j + 1;
				}
				return result;
			}
			fill(x: ${elemType}): ${arrType} {
				let i: number = 0;
				while (i < this.length) {
					this[i] = x;
					i = i + 1;
				}
				return this;
			}
		}
	`;
}

const STRING_METHODS_SRC = `
	// Not itself a JS-visible method -- stays a plain top-level function in the lib source, dispatched
	// as a bare identifier call, unrelated to the class/\`this\` machinery every real method goes through.
	function strIsSpace(code: number): boolean {
		return code === 32 || code === 9 || code === 10 || code === 13;
	}
	class String {
		indexOf(needle: string): number {
			const n: number = this.length;
			const m: number = needle.length;
			let i: number = 0;
			while (i <= n - m) {
				let j: number = 0;
				while (j < m && this.charCodeAt(i + j) === needle.charCodeAt(j))
					j = j + 1;
				if (j === m)
					return i;
				i = i + 1;
			}
			return -1;
		}
		lastIndexOf(needle: string): number {
			const n: number = this.length;
			const m: number = needle.length;
			let i: number = n - m;
			while (i >= 0) {
				let j: number = 0;
				while (j < m && this.charCodeAt(i + j) === needle.charCodeAt(j))
					j = j + 1;
				if (j === m)
					return i;
				i = i - 1;
			}
			return -1;
		}
		includes(needle: string): boolean {
			return this.indexOf(needle) !== -1;
		}
		startsWith(prefix: string): boolean {
			const m: number = prefix.length;
			if (m > this.length)
				return false;
			let j: number = 0;
			while (j < m) {
				if (this.charCodeAt(j) !== prefix.charCodeAt(j))
					return false;
				j = j + 1;
			}
			return true;
		}
		endsWith(suffix: string): boolean {
			const m: number = suffix.length;
			const n: number = this.length;
			if (m > n)
				return false;
			const offset: number = n - m;
			let j: number = 0;
			while (j < m) {
				if (this.charCodeAt(offset + j) !== suffix.charCodeAt(j))
					return false;
				j = j + 1;
			}
			return true;
		}
		slice(start: number, end: number): string {
			const result: string = __towasm_str_alloc(end - start);
			__towasm_str_copy(result, 0, this, start, end - start);
			return result;
		}
		trim(): string {
			const n: number = this.length;
			let start: number = 0;
			while (start < n && strIsSpace(this.charCodeAt(start)))
				start = start + 1;
			let end: number = n;
			while (end > start && strIsSpace(this.charCodeAt(end - 1)))
				end = end - 1;
			return this.slice(start, end);
		}
		toUpperCase(): string {
			const n: number = this.length;
			const result: string = __towasm_str_alloc(n);
			let i: number = 0;
			while (i < n) {
				const code: number = this.charCodeAt(i);
				const upper: number = (code >= 97 && code <= 122) ? code - 32 : code;
				__towasm_str_setChar(result, i, upper);
				i = i + 1;
			}
			return result;
		}
		toLowerCase(): string {
			const n: number = this.length;
			const result: string = __towasm_str_alloc(n);
			let i: number = 0;
			while (i < n) {
				const code: number = this.charCodeAt(i);
				const lower: number = (code >= 65 && code <= 90) ? code + 32 : code;
				__towasm_str_setChar(result, i, lower);
				i = i + 1;
			}
			return result;
		}
		repeat(count: number): string {
			const len: number = this.length;
			const result: string = __towasm_str_alloc(len * count);
			let i: number = 0;
			while (i < count) {
				let j: number = 0;
				while (j < len) {
					__towasm_str_setChar(result, i * len + j, this.charCodeAt(j));
					j = j + 1;
				}
				i = i + 1;
			}
			return result;
		}
		// Also what the \`+\` operator itself lowers to (towasm.ts has no TS-level \`+\` on two strings to
		// lower from).
		concat(b: string): string {
			const result: string = __towasm_str_alloc(this.length + b.length);
			__towasm_str_copy(result, 0, this, 0, this.length);
			__towasm_str_copy(result, this.length, b, 0, b.length);
			return result;
		}
	}
`;

const BIGINT_METHODS_SRC = `
//internally an array of i32
function addbig(a: Uint32Array, b: Uint32Array): Uint32Array {
	const result: Uint32Array = __towasm_arr_i32_alloc(a.length);
	let carry = 0;
	for (let i = 0; i < b.length; i++) {
		const sum = a[i] + b[i] + carry;
		result[i] = sum & 0xFFFFFFFF;
		carry = sum > 0x100000000 ? 1 : 0;
	}
	const atop = (a[a.length - 1] >> 31) >>> 0;
	const btop = (b[b.length - 1] >> 31) >>> 0;
	for (let i = b.length; i < a.length; i++) {
		const sum = a[i] + btop + carry;
		result[i] = sum & 0xFFFFFFFF;
		carry = sum > 0x100000000 ? 1 : 0;
	}
	if (atop + btop + carry > 1) {
		//overflow

	}
	return result;
}


class BigInt {
	array = new Uint32Array;
	top() {
		return this.array[this.array.length - 1];
	}
	add(other: BigInt): BigInt {
		return this.array.length < other.array.length
			? addbig(other.array, this.array)
			: addbig(this.array, other.array);
	}

}
`;

const LIB_SRC =
	arrayMethodsSrc('ArrF64Box', 'number[]', 'number', '__towasm_arr_f64_alloc') +
	arrayMethodsSrc('ArrI32Box', 'boolean[]', 'boolean', '__towasm_arr_i32_alloc') +
	arrayMethodsSrc('ArrI8Box', 'Uint8Array', 'number', '__towasm_arr_i8_alloc') +
	STRING_METHODS_SRC;

export const LIB_AST = TS.parse(LIB_SRC).body;
