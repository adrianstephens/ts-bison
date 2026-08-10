/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	String
//-----------------------------------------------------------------------------

// Not itself a JS-visible method -- stays a plain top-level function, dispatched as a bare identifier
// call, unrelated to the class/`this` machinery every real method goes through.
export function strIsSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 13;
}

export function stringTemplate(strings: string[], ...values: number[]): string {
	const n: number = values.length;
	let result: string = strings[0];
	let i: number = 0;
	while (i < n) {
		result = result.concat(values[i].toString()).concat(strings[i + 1]);
		i = i + 1;
	}
	return result;
}

export class String {
	// A real wasm-GC array's length is intrinsic (`array.len`), not a stored slot -- a getter, not a field,
	// so `String` has zero real fields and towasm.ts's `ensureClass` can register it as the real array type
	// it physically is instead of an (empty, wrong) struct, same fix as `Array<T>.length` (`lib/array.ts`).
	// `u32`, not `i32`: `array.len` can in principle exceed i32's signed range.
	get length(): number { return __asm<[], u32>('array.len')(); }

	// `new String(...)`'s own real zero-arg/one-existing-string construction is handled entirely by
	// `towasm.ts`'s `'new'` case (irregular, argument-count-dependent -- not expressible as one ordinary
	// constructor body); this one's `value` param exists purely so the *general checker* has a permissive
	// (any arg count) signature to validate `new String(...)` against once `String` is hoisted into it. Its
	// body, though, *is* real and used: `towasm.ts`'s `ensureClass` reads this class's own physical
	// representation from whatever it returns (`ctorReturnHelper`) -- a fresh, empty string is exactly
	// `String`'s own "default" value, and `alloc`'s declared `string` return type is what tells
	// `ensureClass` this class is array-backed at all, with no name check anywhere.
	constructor(value?: any) {
		return String.alloc(0) as unknown as String;
	}

	// Every count/index/code-unit param here is a genuine wasm i32 (array length, array index, packed
	// i16 element value widened to i32 on write) -- `number`'s usual f64 would leave the wrong type on
	// the stack for `array.new_default`/`array.set`/`array.copy`, all of which take i32 operands.
	private static alloc	= __asm<[i32], string>('array.new_default $this');
	private static setChar	= __asm<[string, i32, i32], void>('array.set $this');
	private static copy		= __asm<[string, i32, string, i32, i32], void>('array.copy $this $this');


	static fromCharCode(c: number): string {
		const result: string = String.alloc(1);
		String.setChar(result, 0, c);
		return result;
	}

	// Real WAT instruction text (see towasm.ts's `WAT.parseAsmBody`/`resolveOwnerRef`), not a bespoke
	// syntax -- `$this` resolves to this class's own array typeIndex after parsing, same value
	// `builtinArrayOwners.i16.typeIndex` carries elsewhere. `i32` (not `number`) on the index param/
	// charCodeAt's result is what makes towasm.ts emit real wasm i32, not `number`'s usual f64.
	charCodeAt	= __asm<[i32], i32>('array.get_u $this');
	charAt		= __asm<[i32], string>('array.get_u $this array.new_fixed $this 1');

	get(i: i32): string				{
		const result = String.alloc(1);
		const v = __asm<[i32], u32>('array.get $this')(i);
		__asm<[i32, u32], void>('array.set $this')(0, v);
		return result;
	}

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
		const result: string = String.alloc(end - start);
		String.copy(result, 0, this as unknown as string, start, end - start);
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
		const result: string = String.alloc(n);
		let i: number = 0;
		while (i < n) {
			const code: number = this.charCodeAt(i);
			const upper: number = (code >= 97 && code <= 122) ? code - 32 : code;
			String.setChar(result, i, upper);
			i = i + 1;
		}
		return result;
	}
	toLowerCase(): string {
		const n: number = this.length;
		const result: string = String.alloc(n);
		let i: number = 0;
		while (i < n) {
			const code: number = this.charCodeAt(i);
			const lower: number = (code >= 65 && code <= 90) ? code + 32 : code;
			String.setChar(result, i, lower);
			i = i + 1;
		}
		return result;
	}
	repeat(count: number): string {
		const len: number = this.length;
		const result: string = String.alloc(len * count);
		let i: number = 0;
		while (i < count) {
			let j: number = 0;
			while (j < len) {
				String.setChar(result, i * len + j, this.charCodeAt(j));
				j = j + 1;
			}
			i = i + 1;
		}
		return result;
	}
	// Also what the `+` operator itself lowers to (towasm.ts has no TS-level `+` on two strings to lower from).
	concat(b: string): string {
		const result: string = String.alloc(this.length + b.length);
		String.copy(result, 0, this as unknown as string, 0, this.length);
		String.copy(result, this.length, b, 0, b.length);
		return result;
	}

	toString(): string { return this as unknown as string; }
}
