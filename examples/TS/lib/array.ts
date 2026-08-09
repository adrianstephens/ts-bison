/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	GC Array
//-----------------------------------------------------------------------------

export class Array<T> {
	[i: number]: T;

	get length(): number { return __asm<[], u32>('array.len')(); }

	get(i: i32): T			{ return __asm<[i32], T>('array.get $this')(i); }
	set(i: i32, v: T): void	{ return __asm<[i32, T], void>('array.set $this')(i, v); }

	private static _alloc<T>(n: i32): T[] { return __asm<[i32], T[]>('array.new_default $this')(n); }
	private static _copy<T>(dst: T[], dstStart: i32, src: T[], srcStart: i32, len: i32): void {
		return __asm<[T[], i32, T[], i32, i32], void>('array.copy $this $this')(dst, dstStart, src, srcStart, len);
	}
	private static _fill<T>(dst: T[], start: i32, val: T, len: i32): void {
		return __asm<[T[], i32, T, i32], void>('array.fill $this')(dst, start, val, len);
	}

	// Not a real wasm-GC struct (see the header comment), so there's no `this` to default-init before this
	// runs -- the body directly constructs and returns the value, same idea as `fill`'s `as unknown as T[]`.
	constructor(n: number) {
		return Array._alloc(n) as unknown as Array<T>;
	}

	// `push`/`pop`/`shift`/`unshift`: real bodies -- growing/shrinking means allocating a fresh physical array
	// (a wasm-GC array's length is fixed at `array.new_default` time), and assigning it to `this` is how this
	// compiler's subset spells "replace my own receiver's physical value" (real TS never allows assigning to
	// `this`, so `towasm.ts`'s `ensureMethod` treats a body that does it as this method's own explicit,
	// general signal to compile it that way -- not a hardcoded list of method names -- and rewrites every
	// call site to write the result back to the receiver's real lvalue; see `assignsToThis`/`reassignsThis`).
	pop(): T | undefined {
		const len = this.length;
		if (len) {
			const last = this[len - 1];
			const result: T[] = Array._alloc(len - 1);
			Array._copy(result, 0, this as unknown as T[], 0, len - 1);
			this = result as unknown as Array<T>;
			return last;
		}
		return undefined;
	}
	push(...items: T[]): i32 {
		const len = this.length;
		const n = items.length;
		const result: T[] = Array._alloc(len + n);
		Array._copy(result, 0, this as unknown as T[], 0, len);
		Array._copy(result, len, items, 0, n);
		this = result as unknown as Array<T>;
		return len + n;
	}
	shift(): T | undefined {
		const len = this.length;
		if (len) {
			const first = this[0];
			const result: T[] = Array._alloc(len - 1);
			Array._copy(result, 0, this as unknown as T[], 1, len - 1);
			this = result as unknown as Array<T>;
			return first;
		}
		return undefined;
	}
	unshift(...items: T[]): i32 {
		const len = this.length;
		const n = items.length;
		const result: T[] = Array._alloc(len + n);
		Array._copy(result, 0, items, 0, n);
		Array._copy(result, n, this as unknown as T[], 0, len);
		this = result as unknown as Array<T>;
		return len + n;
	}
    splice(start: i32, deleteCount: i32 = 0, ...items: T[]): T[] {
		const len = this.length;
		const n = items.length;
		const result: T[] = Array._alloc(len - deleteCount + n);
		Array._copy(result, 0, this as unknown as T[], 0, start);
		Array._copy(result, start, items, 0, n);
		Array._copy(result, start + n - deleteCount, this as unknown as T[], start + deleteCount, len - start - deleteCount);
		this = result as unknown as Array<T>;
		return this as unknown as T[];
	}

	indexOf(x: T): number {
		let i: number = 0;
		while (i < this.length) {
			if (this[i] === x)
				return i;
			i = i + 1;
		}
		return -1;
	}
	lastIndexOf(x: T): number {
		let i: number = this.length - 1;
		while (i >= 0) {
			if (this[i] === x)
				return i;
			i = i - 1;
		}
		return -1;
	}
	includes(x: T): boolean {
		return this.indexOf(x) !== -1;
	}
	// `end`'s "omitted" default can't be `this.length` (towasm's call-site defaults must be plain
	// literals -- see towasm.ts's `paramWasmType`), and a nullable `number` isn't supported either (no
	// boxing) -- so a large literal sentinel stands in for "omitted", clamped down to `len` below,
	// same as real JS already clamps an over-long `end` to the array's length.
	slice(start: number = 0, end: number = 9007199254740991): T[] {
		const len = this.length;
		start	= start < 0 ? start + len : start;
		end		= end < 0 ? end + len : end > len ? len : end;
		const rlen = end - start;
		const result: T[] = Array._alloc(rlen);
		Array._copy(result, 0, this as unknown as T[], start, rlen);
		return result;
	}
	concat(b: T[]): T[] {
		const result: T[] = Array._alloc(this.length + b.length);
		Array._copy(result, 0, this as unknown as T[], 0, this.length);
		Array._copy(result, this.length, b, 0, b.length);
		return result;
	}
	fill(x: T, start: number = 0, end: number = 9007199254740991): T[] {
		const len = this.length;
		start	= start < 0 ? start + len : start;
		end		= end < 0 ? end + len : end > len ? len : end;
		Array._fill(this as unknown as T[], start, x, end - start);
		return this as any;
	}

	copyWithin(target: number, start: number, end: number = 9007199254740991): T[] {
		const len = this.length;
		if (end > len)
			end = len;
		if (target < 0)
			target += len;
		if (start < 0)
			start += len;
		if (end < 0)
			end += len;
		const me = this as unknown as T[];
		Array._copy(me, target, me, start, end - start);
		return me;
	}
	every(callback: (value: T, index: number, array: this) => unknown, thisArg?: any): boolean {
		for (let i = 0; i < this.length; i++) {
			if (!callback(this[i], i, this))
				return false;
		}
		return true;
	}
	filter(callback: (value: T, index: number, array: this) => any, thisArg?: any): T[] {
		const result: T[] = Array._alloc(this.length);
		for (let i = 0, j = 0; i < this.length; i++) {
			if (callback(this[i], i, this))
				result[j++] = this[i];
		}
		return result;
	}
	find(callback: (value: T, index: number, array: this) => boolean, thisArg?: any): T | undefined {
		for (let i = 0; i < this.length; i++) {
			if (callback(this[i], i, this))
				return this[i];
		}
	}
	findIndex(callback: (value: T, index: number, array: this) => boolean, thisArg?: any): number {
		for (let i = 0; i < this.length; i++) {
			if (callback(this[i], i, this))
				return i;
		}
		return -1;
	}
	forEach(callback: (value: T, index: number, array: this) => void, thisArg?: any): void {
		for (let i = 0; i < this.length; i++)
			callback(this[i], i, this);
	}
	join(separator?: string): string {
		separator ??= ',';
		let result: string = '';
		for (let i = 0; i < this.length; i++) {
			if (i > 0)
				result = result.concat(separator);
			result = result.concat((this[i] as any).toString());
		}
		return result;
	}
	map<U>(callback: (value: T, index: number, array: this) => U, thisArg?: any): U[] {
		//result.push(callback.call(thisArg, array[i], i, array));
		const result = Array._alloc<U>(this.length);
		for (let i = 0; i < this.length; i++)
			result[i] = callback(this[i], i, this);
		return result;
	}
	reduce(callback: (prev: T, curr: T, index: number, array: this) => T, initial?: T): T;
    reduce<U>(callback: (prev: U, curr: T, index: number, array: this) => U, initial: U): U {
		let result = initial;
		for (let i = 0; i < this.length; i++)
			result = callback(result, this[i], i, this);
		return result;
	}
	reduceRight(callback: (prev: T, curr: T, index: number, array: this) => T, initial?: T): T;
    reduceRight<U>(callback: (prev: U, curr: T, index: number, array: this) => U, initial: U): U {
		let result = initial;
		for (let i = this.length - 1; i >= 0; i--)
			result = callback(result, this[i], i, this);
		return result;
	}
	reverse(): T[] {
		const len = this.length;
		for (let i = 0; i < len / 2; i++) {
			const tmp = this[i];
			this[i] = this[len - 1 - i];
			this[len - 1 - i] = tmp;
		}
		return this as unknown as T[];
	}
	some(callback: (value: T, index: number, array: this) => unknown, thisArg?: any): boolean {
		for (let i = 0; i < this.length; i++) {
			if (callback(this[i], i, this))
				return true;
		}
		return false;
	}
	sort(compareFn: (a: T, b: T) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0)): T[]  {
		// Make a copy so we don't mutate the original
		const input = this.slice();

		function merge(left: T[], right: T[]): T[] {
			const result = Array._alloc<T>(left.length + right.length);
			let i = 0, j = 0, k = 0;
			while (i < left.length && j < right.length)
				result[k++] = compareFn(left[i], right[j]) <= 0 ? left[i++] : right[j++];

			// Append remaining items
			Array._copy(result, k, left, i, left.length - i );
			Array._copy(result, k + left.length - i, right, j, right.length - j);
			return result;
		}

		function mergeSort(items: T[]): T[] {
			if (items.length <= 1)
				return items;
			const mid = Math.floor(items.length / 2);
			return merge(mergeSort(items.slice(0, mid)), mergeSort(items.slice(mid)));
		}

		return mergeSort(input);
	}


	toString(): string {
		return this.join(',');
	}
}
