/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	GC Array
//-----------------------------------------------------------------------------

// The raw fixed-length wasm-GC array -- exactly what `Array<T>` used to be, and the ONLY array the
// compiler itself knows (`WasmType`'s `{arr}`). A string and an `ArrayBuffer` are this too. Fixed length
// is the point: with no mutators it needs no identity of its own, so it stays the bare wasm array.
export class RawArray<T> {
	[i: number]: T;

	get length(): number		{ return __asm<[], u32>('array.len')(); }
	__get(i: i32): T			{ return __asm<[i32], T>('array.get $this')(i); }
	__set(i: i32, v: T): void	{ return __asm<[i32, T], void>('array.set $this')(i, v); }

	// `$this` IS the array type here, so these need no `TYPEINDEX`, and the operand order a receiver
	// gives (`this` first) is exactly `array.copy`'s and `array.fill`'s own.
	copyFrom(dstStart: i32, src: RawArray<T>, srcStart: i32, len: i32): void {
		return __asm<[i32, RawArray<T>, i32, i32], void>('array.copy $this $this')(dstStart, src, srcStart, len);
	}
	fillWith(start: i32, val: T, len: i32): void {
		return __asm<[i32, T, i32], void>('array.fill $this')(start, val, len);
	}

	constructor(n: i32) {
		return __asm<[i32], RawArray<T>>('array.new_default $this')(n) as unknown as RawArray<T>;
	}
}

// The one supertype every `Array<T>` instantiation shares, whatever its storage kind -- so `Array.isArray` is a single
// `instanceof`, and never mistakes raw storage (a string, a bigint's limbs, a `RawArray`) for an array.
export class ArrayBase {
	constructor() {}
}

export class Array<T> extends ArrayBase {
	[i: number]: T;

	// An `Array<T>` OWNS its storage instead of being it. A wasm-GC array has a fixed length, so a mutator
	// must reallocate; replacing `data` is an ordinary field write, so every alias of the array observes
	// it -- which `this = result` could never do, since it reached only the receiver's own lvalue.
	// Nothing here reassigns `this`, so `Array` no longer needs `assignsToThis`/`reassignsThis` at all.
	private data: RawArray<T>;

	get length(): number		{ return this.data.length; }
	__get(i: i32): T			{ return this.data[i]; }
	__set(i: i32, v: T): void	{ this.data[i] = v; }

	// '$ret', not '$this': a static has no 'this', and this one's T is the METHOD's own -- '$this' named
	// the enclosing class's array type, so 'map<U>' over a ref array allocated 'arr:ref' where 'U[]' is
	// 'arr:f64'. '$ret' is the index of this asm's own declared return type, per call site.
	private static _alloc<T>(n: i32): RawArray<T> { return new RawArray<T>(n); }
	// A real `Array<T>` of `n` elements, for every method whose RESULT is an array (a mutator wants bare
	// storage instead, to adopt). `_raw` is just the storage property of one, for the bulk copies below.
	private static _make<T>(n: i32): T[] { return new Array<T>(n) as unknown as T[]; }
	private static _raw<T>(a: T[]): RawArray<T> { return (a as unknown as Array<T>).data; }
	private static _copy<T>(dst: RawArray<T>, dstStart: i32, src: RawArray<T>, srcStart: i32, len: i32): void {
		dst.copyFrom(dstStart, src, srcStart, len);
	}
	// `for (const k in x)` over anything read by position enumerates its INDICES, as strings. towasm desugars it into a `for...of`
	// over this, given `x.length`, so the conversion happens in typed lib code rather than in an unstamped synthesized AST.
	static _indexKeys(n: number): string[] {
		const result: string[] = Array._make<string>(n);
		for (let i = 0; i < n; i++)
			result[i] = i.toString();
		return result;
	}
	static isArray(x: any): x is any[] {
		return x instanceof ArrayBase;
	}
	private static _fill<T>(dst: RawArray<T>, start: i32, val: T, len: i32): void {
		dst.fillWith(start, val, len);
	}

	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(n: number) {
		super();
		this.data = new RawArray<T>(n);
	}
	// Adopts storage the caller already built.
	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(d: RawArray<T>) {
		super();
		this.data = d;
	}

	grow(n: i32): i32 {
		const len = this.length;
		const result: RawArray<T> = Array._alloc<T>(len + n);
		Array._copy(result, 0, this.data, 0, len);
		this.data = result;
		return len;
	}

	// `push`/`pop`/`shift`/`unshift`: real bodies -- growing/shrinking means allocating a fresh physical array
	// (a wasm-GC array's length is fixed at `array.new_default` time), and assigning it to `this` is how this
	// compiler's subset spells "replace my own receiver's physical value" (real TS never allows assigning to
	// `this`, so `backend.ts`'s `ensureMethod` treats a body that does it as this method's own explicit,
	// general signal to compile it that way -- not a hardcoded list of method names -- and rewrites every
	// call site to write the result back to the receiver's real lvalue; see `assignsToThis`/`reassignsThis`).
	pop(): T | undefined {
		const len = this.length;
		if (len) {
			const last = this[len - 1];
			const result: RawArray<T> = Array._alloc<T>(len - 1);
			Array._copy(result, 0, this.data, 0, len - 1);
			this.data = result;
			return last;
		}
		return undefined;
	}
	push(...items: T[]): i32 {
		const len = this.length;
		const n = items.length;
		const result: RawArray<T> = Array._alloc<T>(len + n);
		Array._copy(result, 0, this.data, 0, len);
		Array._copy(result, len, (items as unknown as Array<T>).data, 0, n);
		this.data = result;
		return len + n;
	}
	shift(): T | undefined {
		const len = this.length;
		if (len) {
			const first = this[0];
			const result: RawArray<T> = Array._alloc<T>(len - 1);
			Array._copy(result, 0, this.data, 1, len - 1);
			this.data = result;
			return first;
		}
		return undefined;
	}
	unshift(...items: T[]): i32 {
		const len = this.length;
		const n = items.length;
		const result: RawArray<T> = Array._alloc<T>(len + n);
		Array._copy(result, 0, (items as unknown as Array<T>).data, 0, n);
		Array._copy(result, n, this.data, 0, len);
		this.data = result;
		return len + n;
	}
    splice(start: i32, deleteCount: i32 = 0, ...items: T[]): T[] {
		const len = this.length;
		const n = items.length;
		const result: RawArray<T> = Array._alloc<T>(len - deleteCount + n);
		Array._copy(result, 0, this.data, 0, start);
		Array._copy(result, start, (items as unknown as Array<T>).data, 0, n);
		Array._copy(result, start + n - deleteCount, this.data, start + deleteCount, len - start - deleteCount);
		this.data = result;
		return this as unknown as T[];
	}

	indexOf(x: T): number {
		for (let i = 0; i < this.length; i++) {
			if (this[i] === x)
				return i;
		}
		return -1;
	}
	lastIndexOf(x: T): number {
		for (let i = this.length - 1; i >= 0; --i) {
			if (this[i] === x)
				return i;
		}
		return -1;
	}
	// SameValueZero, NOT `indexOf(x) !== -1`: the two genuinely differ on NaN -- `indexOf` uses strict
	// equality and can never find one (correctly), while `[NaN].includes(NaN)` is true.
	// A negative index counts back from the end; out of range is `undefined`.
	at(index: number): T | undefined {
		const i = index < 0 ? this.length + index : index;
		return i >= 0 && i < this.length ? this[i] : undefined;
	}
	includes(x: T): boolean {
		for (let i = 0; i < this.length; i++) {
			const v = this[i];
			if (v === x || (v !== v && x !== x))
				return true;
		}
		return false;
	}
	// `end`'s "omitted" default can't be `this.length` (towasm's call-site defaults must be plain
	// literals -- see backend.ts's `paramWasmType`), and a nullable `number` isn't supported either (no
	// boxing) -- so a large literal sentinel stands in for "omitted", clamped down to `len` below,
	// same as real JS already clamps an over-long `end` to the array's length.
	slice(start: i32 = 0, end: i32 = 0x7fffffff): T[] {
		const len = this.length;
		// CLAMPED at both ends, and a reversed or out-of-range range is empty. `rlen` could go negative
		// (`slice(5)` on length 3, `slice(2, 1)`) and reached `_alloc` as a huge unsigned length --
		// "requested new array is too large" -- where JS simply gives `[]`.
		let from	= start < 0 ? len + start : start;
		let to		= end < 0 ? len + end : end;
		from	= from < 0 ? 0 : from > len ? len : from;
		to		= to < 0 ? 0 : to > len ? len : to;
		const rlen = to > from ? to - from : 0;
		start	= from;
		const result: T[] = Array._make<T>(rlen);
		Array._copy(Array._raw(result), 0, this.data, start, rlen);
		return result;
	}
	concat(b: T[]): T[] {
		const result: T[] = Array._make<T>(this.length + b.length);
		Array._copy(Array._raw(result), 0, this.data, 0, this.length);
		Array._copy(Array._raw(result), this.length, Array._raw(b), 0, b.length);
		return result;
	}
	fill(x: T, start: i32 = 0, end: i32 = 0x7fffffff): T[] {
		const len = this.length;
		start	= start < 0 ? start + len : start;
		end		= end < 0 ? end + len : end > len ? len : end;
		Array._fill(this.data, start, x, end - start);
		return this as any;
	}

	copyWithin(target: i32, start: i32, end: i32 = 0x7fffffff): T[] {
		const len = this.length;
		if (end > len)
			end = len;
		if (target < 0)
			target += len;
		if (start < 0)
			start += len;
		if (end < 0)
			end += len;
		const me = this.data;
		Array._copy(me, target, me, start, end - start);
		return this as unknown as T[];
	}
	every(callback: (value: T, index: number, array: this) => unknown, thisArg?: any): boolean {
		for (let i = 0; i < this.length; i++) {
			if (!callback(this[i], i, this))
				return false;
		}
		return true;
	}
	filter(callback: (value: T, index: number, array: this) => any, thisArg?: any): T[] {
		// Collected into a full-length scratch first, then copied down to the real count: a wasm-GC array's
		// length is fixed at allocation, and the old code returned the SCRATCH, so `.length` was always the
		// input's. Counting in a first pass instead would call `callback` twice per element, which is
		// observable whenever the predicate has a side effect.
		const scratch: T[] = Array._make<T>(this.length);
		let n = 0;
		for (let i = 0; i < this.length; i++) {
			if (callback(this[i], i, this))
				scratch[n++] = this[i];
		}
		const result: T[] = Array._make<T>(n);
		Array._copy(Array._raw(result), 0, Array._raw(scratch), 0, n);
		return result;
	}
	find(callback: (value: T, index: number, array: this) => unknown, thisArg?: any): T | undefined {
		for (let i = 0; i < this.length; i++) {
			if (callback(this[i], i, this))
				return this[i];
		}
		// Explicit: falling off the end reached `unreachable` rather than returning the `undefined` JS
		// specifies for no match.
		return undefined;
	}
	findIndex(callback: (value: T, index: number, array: this) => unknown, thisArg?: any): number {
		for (let i = 0; i < this.length; i++) {
			if (callback(this[i], i, this))
				return i;
		}
		return -1;
	}
	// One level, TS's default depth: an element that is itself an array contributes its elements. The element type is
	// what TS's `FlatArray<T[], 1>` reduces to. `flat(depth)` beyond 1 is not declared, so the checker rejects it.
	flat(): (T extends readonly (infer U)[] ? U : T)[] {
		const out: (T extends readonly (infer U)[] ? U : T)[] = [];
		for (let i = 0; i < this.length; i++) {
			const el: T = this[i];
			if (Array.isArray(el)) {
				// Typed, so its elements are read as an array's: a ref-element Array<T> is compiled as Array<any>, where `el` is `any`.
				const inner: any[] = el;
				for (let j = 0; j < inner.length; j++)
					out.push(inner[j]);
			} else
				out.push(el as T extends readonly (infer U)[] ? U : T);	// compiled only when `T` is no array (towasm `staticGuard`), where this is `T`
		}
		return out;
	}
	// Real TS lets the callback return `U | readonly U[]`; here it must return an array. Telling the two
	// apart needs a runtime array test on a union, which this compiler has no representation for -- and
	// the array form is what every real caller uses.
	// Grown through `push` rather than sized up front by a first pass: the callback must run exactly ONCE
	// per element (they have effects), and holding the parts to measure them would need a `U[][]`, whose
	// `arr:ref` elements a concrete `number[]` part has no conversion into.
	flatMap<U>(callback: (value: T, index: number, array: this) => U[], thisArg?: any): U[] {
		let result: U[] = Array._make<U>(0);
		for (let i = 0; i < this.length; i++) {
			const part = callback(this[i], i, this);
			for (let j = 0; j < part.length; j++)
				result.push(part[j]);
		}
		return result;
	}
	forEach(callback: (value: T, index: number, array: this) => void, thisArg?: any): void {
		for (let i = 0; i < this.length; i++)
			callback(this[i], i, this);
	}
	// What a value known only as an `Iterable` iterates by; a `for...of` over a known array still reads by position.
	[Symbol.iterator](): Generator<T, void, unknown> {
		return __towasm_indexed<T>(() => this.length, i => this[i]);
	}
	join(separator = ','): string {
		let result = '';
		for (let i = 0; i < this.length; i++) {
			if (i > 0)
				result = result.concat(separator);
			result = result.concat((this[i] as any).toString());
		}
		return result;
	}
	map<U>(callback: (value: T, index: number, array: this) => U, thisArg?: any): U[] {
		//result.push(callback.call(thisArg, array[i], i, array));
		const result: U[] = Array._make<U>(this.length);
		for (let i = 0; i < this.length; i++)
			result[i] = callback(this[i], i, this);
		return result;
	}
	// With no seed the accumulator starts at the first element and the walk at the second, and an empty
	// array is a TypeError -- seeding with `initial` regardless folded a leading `undefined` into every
	// no-seed reduce. `initial === undefined` is the only signal available (no `arguments.length` here).
	reduce(callback: (prev: T, curr: T, index: number, array: this) => T, initial?: T): T;
	reduce<U>(callback: (prev: U, curr: T, index: number, array: this) => U, initial?: U): U {
		const len = this.length;
		let i = 0;
		let result = initial;
		if (initial === undefined) {
			if (len === 0)
				throw new Error('Reduce of empty array with no initial value');
			result = this[0] as any as U;
			i = 1;
		}
		for (; i < len; i++)
			result = callback(result as U, this[i], i, this);
		return result as U;
	}
	reduceRight(callback: (prev: T, curr: T, index: number, array: this) => T, initial?: T): T;
	reduceRight<U>(callback: (prev: U, curr: T, index: number, array: this) => U, initial?: U): U {
		const len = this.length;
		let i = len - 1;
		let result = initial;
		if (initial === undefined) {
			if (len === 0)
				throw new Error('Reduce of empty array with no initial value');
			result = this[len - 1] as any as U;
			i = len - 2;
		}
		for (; i >= 0; i--)
			result = callback(result as U, this[i], i, this);
		return result as U;
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
			const result: T[] = Array._make<T>(left.length + right.length);
			let i = 0, j = 0, k = 0;
			while (i < left.length && j < right.length)
				result[k++] = compareFn(left[i], right[j]) <= 0 ? left[i++] : right[j++];

			// Append remaining items
			Array._copy(Array._raw(result), k, Array._raw(left), i, left.length - i );
			Array._copy(Array._raw(result), k + left.length - i, Array._raw(right), j, right.length - j);
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
	// Real JS calls `toLocaleString` on each element; with no locale support here that is exactly
	// `toString`, so this is an alias rather than a stub. Same reasoning as `String.toLocaleLowerCase`.
	toLocaleString(): string {
		return this.toString();
	}
}
