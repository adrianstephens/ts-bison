/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	ArrayBuffer / Uint8Array / Int32Array / Uint32Array
//-----------------------------------------------------------------------------
// Real linear-memory views, not GC arrays -- `offset`/`byteOffset`/`length`/`byteLength`/`base` are
// genuine wasm `i32` values (see lib.d.ts's `i32` pseudo-type), and `get`/`set` reach into linear memory
// directly via `__asm` (there's no ordinary TS syntax for a raw memory load/store). A method whose one
// statement forwards straight to `__asm` is the exact same intrinsic shape `lib/array.ts`'s
// `Array<T>.alloc`/`copy`/`fillRange` already use -- towasm.ts's `ensureClass` recognizes it for any
// class now, not just the handful of specially-built-in ones, so `get`/`set` splice their instructions in
// directly (no real `call`) the same way those do. Real index syntax (`a[i]`/`a[i]=v`) dispatches to
// `get`/`set` generically too (see towasm.ts's `case 'index'`/`emitAssignTarget`) -- any class declaring
// them the same way gets the same sugar, not just this one.
//
// `Uint8Array` is the one canonical declaration; `Int32Array`/`Uint32Array` are built by towasm.ts
// substituting this class's own name (and, for `Uint32Array` specifically, `i32`->`u32` so `get` reports
// the correct unsigned element type) -- see towasm.ts's `ensureClass`/`TYPED_ARRAY_ALIASES`. `get`/`set`'s
// own byte-width difference (1 byte vs 4) is *not* part of that substitution -- it's picked by `(switch
// $elem ...)` inside the one shared asm string above, resolved immediately at parse time from a `defines`
// entry `ensureClass` passes down per instantiation, the same general mechanism `$this` already uses for
// the struct's own type index (see `WAT.parseAsmBody`'s `defines`) -- not the deferred/call-site-driven
// `$T`-switch mechanism `Math.floor` etc use.
//
// `(n)`/`(buffer)`/`(buffer, byteOffset)`/`(buffer, byteOffset, length)` are real, separately-compiled
// constructor overloads below -- towasm.ts resolves which one a given call site needs the same way the
// checker itself does (argument shape). Only the array-literal form (`new Uint8Array([1, 2, 3])`) stays
// compile-time sugar in towasm.ts's `case 'new'` -- filling a struct element-by-element from a source-level
// literal isn't expressible as an ordinary constructor body.
//
// `Int32Array`/`Uint32Array` also get their own ambient `declare class` further down, each `implements
// TypedArray<T>` -- unlike `Uint8Array`, they have no real declaration anywhere else (they're pure
// name-substitution products of the paragraph above), so without one the checker has never heard of them:
// a self-referential static call inside their substituted body, or any ordinary user code calling them
// directly, would silently resolve to `any`. See that declaration's own comment for the full story.

let heap: i32 = 0;
export function __towasm_alloc(size: i32): i32 {
	const ret  = heap;
	heap += size;

	// Grow by just enough whole pages (64KiB) to cover the new heap pointer, if it now exceeds the memory's current size.
	const mem = __asm<[], i32>('memory.size')();
	if (heap > (mem << 16)) {
		const extra = (heap - (mem << 16) + 65535) >> 16;
		__asm<[i32], i32>('memory.grow')(extra);
	}
	return ret;
}

class ArrayBuffer {
	offset: i32;
	byteLength: i32;
	constructor(byteLength: i32) {
		this.offset = __towasm_alloc(byteLength);
		this.byteLength = byteLength;
	}
}

// Purely a documentation contract: towasm.ts's `ensureClass` only ever rejects a real `superClass`
// (`extends`), never reads `implements` at all, and this project's own checker parses `implements` into
// `decl.implements` but never reads it back either -- so `Uint8Array`/`Int32Array`/`Uint32Array` each
// declaring `implements TypedArray<...>` below isn't structurally enforced (a real mismatch wouldn't be
// flagged). It's still worth having: it makes the shared shape explicit, and a human reviewer (or a future
// checker enhancement) can use it to catch drift between the three declarations.
interface TypedArray<T> {
	readonly buffer: ArrayBuffer;
	readonly byteOffset: number;
	readonly length: number;
	readonly byteLength: number;
	[i: number]: T;
	get(i: number): T;
	set(i: number, v: T): void;
	indexOf(x: T): number;
	lastIndexOf(x: T): number;
	includes(x: T): boolean;
	reverse(): TypedArray<T>;
	slice(start?: number, end?: number): TypedArray<T>;
	fill(x: T, start?: number, end?: number): TypedArray<T>;
	concat(other: TypedArray<T>): TypedArray<T>;
	subarray(start?: number, end?: number): TypedArray<T>;
}

class Uint8Array implements TypedArray<u8> {
	buffer:		ArrayBuffer	= new ArrayBuffer(0);
	byteOffset: i32	= 0;
	length:		i32	= 0;
	byteLength: i32	= 0;
	base:		i32	= 0;

	[i: number]: number;

	// Real byte width per element, resolved the same `$elem`-switch way `get`/`set` below already are --
	// lets the constructors below convert between element count and byte count without needing to know
	// which of Uint8Array/Int32Array/Uint32Array they actually are (towasm.ts substitutes the class's own
	// name into this call site too, same as everywhere else in this file -- see its header comment).
	private static elemSize(): i32 { return __asm<[], i32>('(switch $elem (($u8) i32.const 1) (($i32 $u32) i32.const 4))')(); }

	// Real, separately-compiled constructors -- towasm.ts now supports genuine overloading (each of these
	// gets its own wasm function, resolved per call site by argument shape, the same way the checker itself
	// already resolves which one a given call typechecks against), so this no longer needs to be a single
	// permissive stub with the real construction logic hand-built in towasm.ts's `case 'new'`.
	//
	// Every field write here must stay a plain `this.field = <expr>` statement with no `this.field` *read*
	// anywhere in this constructor (a struct with an object-typed field, `buffer`, is built by collecting
	// every field's value up front and a single `struct.new` -- see `ensureCtor` -- so `this` isn't a real,
	// readable value until the last field is set): every intermediate value goes through a plain local
	// (`elemSize`/`byteLength`) instead of writing then reading a field back.
	constructor(length: number) {
		const elemSize = Uint8Array.elemSize();
		this.buffer = new ArrayBuffer(length * elemSize);
		this.byteOffset = 0;
		this.length = length;
		this.byteLength = length * elemSize;
		this.base = this.buffer.offset;
	}
	constructor(buffer: ArrayBuffer) {
		const elemSize = Uint8Array.elemSize();
		const byteLength = buffer.byteLength;
		this.buffer = buffer;
		this.byteOffset = 0;
		this.byteLength = byteLength;
		this.length = byteLength / elemSize;
		this.base = buffer.offset;
	}
	constructor(buffer: ArrayBuffer, byteOffset: number) {
		const elemSize = Uint8Array.elemSize();
		const byteLength = buffer.byteLength - byteOffset;
		this.buffer = buffer;
		this.byteOffset = byteOffset;
		this.byteLength = byteLength;
		this.length = byteLength / elemSize;
		this.base = buffer.offset + byteOffset;
	}
	constructor(buffer: ArrayBuffer, byteOffset: number, length: number) {
		const elemSize = Uint8Array.elemSize();
		this.buffer = buffer;
		this.byteOffset = byteOffset;
		this.length = length;
		this.byteLength = length * elemSize;
		this.base = buffer.offset + byteOffset;
	}
	// No backing body -- an array literal (`new Uint8Array([1, 2, 3])`) is filled element-by-element at the
	// call site (`towasm.ts`'s `case 'new'`, same as before), never actually invoking a compiled constructor
	// -- this signature exists purely so the checker accepts the call, the same "declared for type-checking,
	// intercepted earlier by towasm.ts" shape `TYPED_ARRAY_RANGES` already uses for `.indexOf`/`.slice`/etc.
	constructor(elements: number[]);

	// `$elem` resolves immediately at parse time (see `WAT.parseAsmBody`'s `defines`) -- the same general
	// mechanism `$this` already uses for the struct's own type index, just one more per-instantiation
	// compile-time constant. This one string is reused verbatim for `Uint8Array`/`Int32Array`/`Uint32Array`
	// alike (see towasm.ts's `ensureClass`/`TYPED_ARRAY_ALIASES`) -- nothing here varies by kind.
	get(i: i32): i32 { return __asm<[i32], i32>('(local $i i32) local.set $i struct.get $this 4 local.get $i (switch $elem (($u8) i32.add i32.load8_u) (($i32 $u32) i32.const 4 i32.mul i32.add i32.load))')(i); }
	set(i: i32, v: i32): void { return __asm<[i32, i32], void>('(local $i i32) (local $v i32) local.set $v local.set $i struct.get $this 4 local.get $i (switch $elem (($u8) i32.add local.get $v i32.store8) (($i32 $u32) i32.const 4 i32.mul i32.add local.get $v i32.store))')(i, v); }

	indexOf(x: number): number {
		let i: number = 0;
		while (i < this.length) {
			if (this[i] === x)
				return i;
			i = i + 1;
		}
		return -1;
	}
	lastIndexOf(x: number): number {
		let i: number = this.length - 1;
		while (i >= 0) {
			if (this[i] === x)
				return i;
			i = i - 1;
		}
		return -1;
	}
	includes(x: number): boolean {
		return this.indexOf(x) !== -1;
	}
	reverse(): Uint8Array {
		const len = this.length;
		for (let i = 0; i < len / 2; i++) {
			const tmp = this[i];
			this[i] = this[len - 1 - i];
			this[len - 1 - i] = tmp;
		}
		return this;
	}
	// Same "omitted `end`" large-sentinel-clamped-to-`length` trick as `lib/array.ts`'s own `slice`/
	// `fill` -- a call-site default must be a plain literal (towasm's `fillDefaultArgs`), and
	// `this.length` isn't one.
	slice(start: number = 0, end: number = 9007199254740991): Uint8Array {
		const len = this.length;
		start	= start < 0 ? start + len : start;
		end		= end < 0 ? end + len : end > len ? len : end;
		const rlen = end - start;
		const result = new Uint8Array(rlen);
		for (let i = 0; i < rlen; i++)
			result[i] = this[start + i];
		return result;
	}
	fill(x: number, start: number = 0, end: number = 9007199254740991): Uint8Array {
		const len = this.length;
		start	= start < 0 ? start + len : start;
		end		= end < 0 ? end + len : end > len ? len : end;
		for (let i = start; i < end; i++)
			this[i] = x;
		return this;
	}
	concat(other: Uint8Array): Uint8Array {
		const result = new Uint8Array(this.length + other.length);
		let i: number = 0;
		while (i < this.length) {
			result[i] = this[i];
			i = i + 1;
		}
		let j: number = 0;
		while (j < other.length) {
			result[i] = other[j];
			i = i + 1;
			j = j + 1;
		}
		return result;
	}
	// A real *view* over the same buffer -- no copy, no alloc -- unlike `slice`. Same clamp/saturate
	// semantics as `slice`.
	subarray(start: number = 0, end: number = 9007199254740991): Uint8Array {
		const len = this.length;
		start	= start < 0 ? start + len : start;
		end		= end < 0 ? end + len : end > len ? len : end;
		if (end < start)
			end = start;
		return new Uint8Array(this.buffer, this.byteOffset + start, end - start);
	}
}

// Real, independently-checked classes purely for the checker -- each is what closed the actual bug found
// while investigating this file (`Int32Array.elemSize()`, a self-referential static call inside towasm.ts's
// name-substituted copy of `Uint8Array`'s real body, was resolving to `any`: `Int32Array`/`Uint32Array`
// aren't declared anywhere else, so the checker had never heard of them). towasm.ts's own codegen is
// entirely unaffected -- it still builds `Int32Array`/`Uint32Array`'s real physical implementation by
// substituting `Uint8Array`'s canonical decl (`ensureClass`/`TYPED_ARRAY_ALIASES`), same as before; these
// two declarations are never read by codegen at all, only by the checker validating call sites -- including
// the substituted constructor bodies' own internal `elemSize()` self-call, which is why that otherwise-
// private static method is declared here too, not just the real public surface.
declare class Int32Array implements TypedArray<i32> {
	readonly buffer: ArrayBuffer;
	readonly byteOffset: number;
	readonly length: number;
	readonly byteLength: number;
	[i: number]: number;

	private static elemSize(): i32;

	constructor(length: number);
	constructor(buffer: ArrayBuffer);
	constructor(buffer: ArrayBuffer, byteOffset: number);
	constructor(buffer: ArrayBuffer, byteOffset: number, length: number);
	constructor(elements: number[]);

	get(i: number): number;
	set(i: number, v: number): void;
	indexOf(x: number): number;
	lastIndexOf(x: number): number;
	includes(x: number): boolean;
	reverse(): Int32Array;
	slice(start?: number, end?: number): Int32Array;
	fill(x: number, start?: number, end?: number): Int32Array;
	concat(other: Int32Array): Int32Array;
	subarray(start?: number, end?: number): Int32Array;
}

declare class Uint32Array implements TypedArray<u32> {
	readonly buffer: ArrayBuffer;
	readonly byteOffset: number;
	readonly length: number;
	readonly byteLength: number;
	[i: number]: number;

	private static elemSize(): i32;

	constructor(length: number);
	constructor(buffer: ArrayBuffer);
	constructor(buffer: ArrayBuffer, byteOffset: number);
	constructor(buffer: ArrayBuffer, byteOffset: number, length: number);
	constructor(elements: number[]);

	get(i: number): number;
	set(i: number, v: number): void;
	indexOf(x: number): number;
	lastIndexOf(x: number): number;
	includes(x: number): boolean;
	reverse(): Uint32Array;
	slice(start?: number, end?: number): Uint32Array;
	fill(x: number, start?: number, end?: number): Uint32Array;
	concat(other: Uint32Array): Uint32Array;
	subarray(start?: number, end?: number): Uint32Array;
}

const asi32 = __asm<[f32], i32>('i32.reinterpret_f32');
const asi64 = __asm<[f64], i64>('i64.reinterpret_f64');
const asf32 = __asm<[i32], f32>('f32.reinterpret_i32');
const asf64 = __asm<[i64], f64>('f64.reinterpret_i64');

const bswap16 = __asm<[i32], i32>(`
	(i32.shl 8)
	(i32.rotr 16)
`);
const bswap32 = __asm<[i32], i32>(`
	(local $val i32)
	local.set $val
	(i32.or
		(i32.rotr	(i32.and (local.get $val) (i32.const 0x00FF00FF))	8)	;; ABCD => D0B0
		(i32.rotl	(i32.and (local.get $val) 0xFF00FF00)	8)	;; ABCD => 0C0A
	)
`);
const bswap64 = __asm<[i64], i64>(`
	(local $val i64)
	local.set $val
	(i64.or
		(i64.rotr (i64.and (local.get $val) 0x00FF00FF00FF00FF) 8)
		(i64.rotl (i64.and (local.get $val) 0xFF00FF00FF00FF00) 8)
	)
	(i64.rotr 32)
`);

class DataView {
	readonly buffer: ArrayBuffer;
	readonly byteOffset: i32;
	readonly byteLength: i32;

	constructor(buffer: ArrayBuffer, byteOffset: i32 = 0, byteLength: i32 = 0xffffff) {
		this.buffer = buffer;
		this.byteOffset = byteOffset;
		this.byteLength = Math.min(byteLength, buffer.byteLength - byteOffset);
	}

	getUint8(byteOffset: number): number {
		return __asm<[i32], i32>('i32.load8_u')(this.byteOffset + byteOffset);
	}
	getInt8(byteOffset: number): number {
		return __asm<[i32], i32>('i32.load8_s')(this.byteOffset + byteOffset);
	}
	getUint16(byteOffset: number, littleEndian?: boolean): number {
		const v = __asm<[i32], i32>('i32.load16_u')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap16(v);
	}
	getInt16(byteOffset: number, littleEndian?: boolean): number {
		const v = __asm<[i32], i32>('i32.load16_s')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap16(v);
	}
	getUint32(byteOffset: number, littleEndian?: boolean): number {
		const v = __asm<[i32], i32>('i32.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap32(v);
	}
	getInt32(byteOffset: number, littleEndian?: boolean): number {
		const v = __asm<[i32], i32>('i32.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap32(v);
	}
	getUint64(byteOffset: number, littleEndian?: boolean): u64 {
		const v = __asm<[i32], i64>('i64.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap64(v);
	}
	getInt64(byteOffset: number, littleEndian?: boolean): i64 {
		const v = __asm<[i32], i64>('i64.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap32(v);
	}
	getFloat32(byteOffset: number, littleEndian?: boolean): number	{
		const offset = this.byteOffset + byteOffset;
		return littleEndian
			? __asm<[i32], f32>('f32.load')(offset)
			: asf32(bswap32(__asm<[i32], i32>('i32.load')(offset)));
	}
	getFloat64(byteOffset: number, littleEndian?: boolean): number {
		const offset = this.byteOffset + byteOffset;
		return littleEndian
			? __asm<[i32], f64>('f64.load')(offset)
			: asf64(bswap64(__asm<[i32], i64>('i64.load')(offset)));
	}
	setUint8(byteOffset: number, value: i32): void {
		__asm<[i32, i32], void>('i32.store8')(this.byteOffset + byteOffset, value);
	}
	setInt8(byteOffset: number, value: i32): void {
		__asm<[i32, i32], i32>('i32.store8')(this.byteOffset + byteOffset, value);
	}
	setUint16(byteOffset: number, value: i32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store16')(this.byteOffset + byteOffset, littleEndian ? value : bswap16(value));
	}
	setInt16(byteOffset: number, value: i32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store16')(this.byteOffset + byteOffset, littleEndian ? value : bswap16(value));
	}
	setUint32(byteOffset: number, value: i32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap32(value));
	}
	setInt32(byteOffset: number, value: i32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap32(value));
	}
	setUint64(byteOffset: number, value: i64, littleEndian?: boolean): void {
		__asm<[i32, i64], void>('i64.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap64(value));
	}
	setInt64(byteOffset: number, value: i64, littleEndian?: boolean): void {
		__asm<[i32, i64], void>('i64.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap64(value));
	}

	setFloat32(byteOffset: number, value: number, littleEndian?: boolean): void {
		const offset = this.byteOffset + byteOffset;
		if (littleEndian)
			__asm<[i32, f32], void>('f32.store')(offset, value);
		else
			__asm<[i32, i32], void>('i32.store')(offset, bswap32(asi32(value)));

	}
	setFloat64(byteOffset: number, value: number, littleEndian?: boolean): void {
		const offset = this.byteOffset + byteOffset;
		if (littleEndian)
			__asm<[i32, f64], void>('f64.store')(offset, value);
		else
			__asm<[i32, i64], void>('i64.store')(offset, bswap64(asi64(value)));
	}
}
