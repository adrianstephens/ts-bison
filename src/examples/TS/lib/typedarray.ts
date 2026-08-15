/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	ArrayBuffer / Uint8Array / Int32Array / Uint32Array
//-----------------------------------------------------------------------------
// `ArrayBuffer` is a real GC byte array (`array.new_default $this`/`array.get_u`/`array.set`), not a
// linear-memory allocation -- there's no separate free/finalizer to run, it's reclaimed exactly like any
// other GC value. `TypedArray<T>.get`/`set` compose a multi-byte element byte-by-byte off it (plain TS,
// see their own comment) -- no raw `__asm` needed there at all, only `elemSize()` (below) still uses the
// `$elem`-switch mechanism, to pick the per-instantiation byte width.
//
// `TypedArray<T>` is the one canonical declaration, and deliberately shares its name with lib.d.ts's own
// ambient `TypedArray<T>` interface (the `number`-typed public surface real user code type-checks
// `Uint8Array`/etc against) -- they're meant to be the same thing, this class *is* that interface's real
// physical implementation. Real TS declaration-merging intersects the two (same as any interface+class
// pair sharing a name); `type-utils.ts`'s `lookupMember` (`case 'intersection'`) treats a wasm pseudo-type
// (`i32`/etc) and its own alias target `number` as the same declared member, not a genuine conflict, so
// `length`'s real physical `i32` field type survives the merge instead of collapsing into `number & i32`.
//
// `Uint8Array`/`Int32Array`/etc (`lib.d.ts`) are ordinary `declare type X = TypedArray<u8>`-style aliases --
// `T` is a real generic type argument here, not a name-substitution target: `towasm.ts`'s `ensureClass`
// resolves a bare alias name to its real generic target the first time it's referenced (general -- works
// for any `declare type X = SomeGenericClass<...>` alias, not special-cased per typed-array name), then
// instantiates `TypedArray<T>` the same ordinary way a direct `Box<number>` reference already would.
// `$elem` (each instantiation's real physical storage width, e.g. `'u8'` vs `'i32'`) is read straight off
// that real type argument's own name, not a separate per-name side table. Since the class is never renamed
// away from its own real name `TypedArray`, a self-referential static call inside it (`TypedArray.elemSize()`
// below) resolves normally too -- no separate ambient declaration needed just to give the checker something
// to resolve it against, the way a name-substituted copy would have needed.
//
// `(n)`/`(buffer)`/`(buffer, byteOffset)`/`(buffer, byteOffset, length)`/`(elements)` are real,
// separately-compiled constructor overloads below -- towasm.ts resolves which one a given call site needs
// the same way the checker itself does (argument shape), including the array-literal form
// (`new Uint8Array([1, 2, 3])`, see the last overload's own comment for the one optimization opportunity
// still on the table there).

declare type i8 = number;

export class ArrayBuffer {
	get byteLength(): number { return __asm<[], u32>('array.len')(); }
	[i: number]: u8;
	get(i: i32): u8				{ return __asm<[i32], i32>('array.get_u $this')(i); }
	set(i: i32, v: i32): void	{ return __asm<[i32, i32], void>('array.set $this')(i, v); }

	constructor(byteLength: i32) {
		return __asm<[i32], i8[]>('array.new_default $this')(byteLength) as unknown as ArrayBuffer;
	}
}

export class TypedArray<T> {
	buffer:		ArrayBuffer	= new ArrayBuffer(0);
	byteOffset:	i32	= 0;
	byteLength:	i32	= 0;
	length:		i32 = 0;

	[i: i32]: number;

	// Real byte width per element, resolved the same `$elem`-switch way `get`/`set` below already are --
	// lets the constructors below convert between element count and byte count without needing to know
	// which of Uint8Array/Int32Array/Uint32Array they actually are (towasm.ts substitutes the class's own
	// name into this call site too, same as everywhere else in this file -- see its header comment).
	private static elemSize(): i32 { return __asm<[], i32>(`
		(switch $elem
			(($u8 $i8)			i32.const 1)
			(($u16 $i16)		i32.const 2)
			(($i32 $u32 $f32)	i32.const 4)
			(($i64 $u64 $f64)	i32.const 8)
		)`)(); }

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
	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(length: i32) {
		const elemSize = TypedArray.elemSize();
		this.buffer = new ArrayBuffer(length * elemSize);
		this.byteOffset = 0;
		this.length = length;
		this.byteLength = length * elemSize;
	}
	// A real, compiled constructor like every other overload here -- works for *any* `number[]` value, not
	// just a source-level array literal (`new Uint8Array([1, 2, 3])`); the latter still goes through this
	// same overload, just with `elements` bound to a real (if freshly-literal) array value. A literal
	// specifically could in principle skip that intermediate array and fill the buffer straight from each
	// element expression -- a real optimization, but a general one (any array-typed argument shape, not
	// just this one constructor), so left for later rather than a special case here.
	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(elements: number[]) {
		const elemSize = TypedArray.elemSize();
		this.buffer = new ArrayBuffer(elements.length * elemSize);
		this.byteOffset = 0;
		this.length = elements.length;
		this.byteLength = elements.length * elemSize;
		for (let i = 0; i < elements.length; i++)
			this[i] = elements[i];
	}
	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(buffer: ArrayBuffer) {
		const elemSize = TypedArray.elemSize();
		const byteLength = buffer.byteLength;
		this.buffer = buffer;
		this.byteOffset = 0;
		this.byteLength = byteLength;
		this.length = byteLength / elemSize;
	}
	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(buffer: ArrayBuffer, byteOffset: i32) {
		const elemSize = TypedArray.elemSize();
		const byteLength = buffer.byteLength - byteOffset;
		this.buffer = buffer;
		this.byteOffset = byteOffset;
		this.byteLength = byteLength;
		this.length = byteLength / elemSize;
	}
	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(buffer: ArrayBuffer, byteOffset: i32, length: i32) {
		const elemSize = TypedArray.elemSize();
		this.buffer = buffer;
		this.byteOffset = byteOffset;
		this.length = length;
		this.byteLength = length * elemSize;
	}

	// Composed byte-by-byte off `buffer` (a real GC byte array, see `ArrayBuffer` above -- no linear memory,
	// so no separate finalizer is ever needed to free it: it's reclaimed exactly like any other GC value).
	// Little-endian, built from `elemSize()`'s own per-instantiation constant -- one shared body for every
	// `Uint8Array`/`Int32Array`/`Uint32Array`/etc alike, same as every other method here. Only covers a
	// `number`-representable (<=4-byte) element -- `i64`/`u64`/`f32`/`f64` elements need a wider *declared*
	// result than this shared `i32` signature can express, not yet supported (see `elemSize`'s own switch).
	get(i: i32): i32 {
		const elemSize: i32 = TypedArray.elemSize();
		const base: i32 = this.byteOffset + i * elemSize;
		let v: i32 = 0;
		for (let b: i32 = 0; b < elemSize; b++)
			v = v | (this.buffer.get(base + b) << (b * 8));
		return v;
	}
	set(i: i32, v: i32): void {
		const elemSize: i32 = TypedArray.elemSize();
		const base: i32 = this.byteOffset + i * elemSize;
		for (let b: i32 = 0; b < elemSize; b++)
			this.buffer.set(base + b, (v >>> (b * 8)) & 0xff);
	}

	indexOf(x: number): i32 {
		for (let i = 0; i < this.length; i++) {
			if (this[i] === x)
				return i;
		}
		return -1;
	}
	lastIndexOf(x: number): i32 {
		for (let i = this.length - 1; i >= 0; --i) {
			if (this[i] === x)
				return i;
		}
		return -1;
	}
	includes(x: number): boolean {
		return this.indexOf(x) !== -1;
	}
	reverse(): TypedArray<T> {
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
	slice(start: i32 = 0, end: i32 = 0x7fffffff): TypedArray<T> {
		const len = this.length;
		start	= start < 0 ? start + len : start;
		end		= end < 0 ? end + len : end > len ? len : end;
		const rlen = end - start;
		const result = new TypedArray<T>(rlen);
		for (let i = 0; i < rlen; i++)
			result[i] = this[start + i];
		return result;
	}
	fill(x: number, start: i32 = 0, end: i32 = 0x7fffffff): TypedArray<T> {
		const len = this.length;
		start	= start < 0 ? start + len : start;
		end		= end < 0 ? end + len : end > len ? len : end;
		for (let i = start; i < end; i++)
			this[i] = x;
		return this;
	}
	concat(other: TypedArray<T>): TypedArray<T> {
		const result = new TypedArray<T>(this.length + other.length);
		const len = this.length;
		for (let i = 0; i < len; i++)
			result[i] = this[i];
		for (let i = 0; i < other.length; i++)
			result[i + len] = other[i];
		return result;
	}
	// A real *view* over the same buffer -- no copy, no alloc -- unlike `slice`. Same clamp/saturate
	// semantics as `slice`.
	subarray(start: i32 = 0, end: i32 = 0x7fffffff): TypedArray<T> {
		const len = this.length;
		start	= start < 0 ? start + len : start;
		end		= end < 0 ? end + len : end > len ? len : end;
		if (end < start)
			end = start;
		// @ts-expect-error - tison extension: multiple constructor implementations
		return new TypedArray<T>(this.buffer, this.byteOffset + start, end - start);
	}
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
/*
class DataView {
	readonly buffer: ArrayBuffer;
	readonly byteOffset: i32;
	readonly byteLength: i32;

	constructor(buffer: ArrayBuffer, byteOffset: i32 = 0, byteLength: i32 = 0xffffff) {
		this.buffer = buffer;
		this.byteOffset = byteOffset;
		this.byteLength = Math.min(byteLength, buffer.byteLength - byteOffset);
	}

	getUint8(byteOffset: i32): u32 {
		return __asm<[i32], i32>('i32.load8_u')(this.byteOffset + byteOffset);
	}
	getInt8(byteOffset: i32): i32 {
		return __asm<[i32], i32>('i32.load8_s')(this.byteOffset + byteOffset);
	}
	getUint16(byteOffset: i32, littleEndian?: boolean): u32 {
		const v = __asm<[i32], i32>('i32.load16_u')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap16(v);
	}
	getInt16(byteOffset: i32, littleEndian?: boolean): i32 {
		const v = __asm<[i32], i32>('i32.load16_s')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap16(v);
	}
	getUint32(byteOffset: i32, littleEndian?: boolean): u32 {
		const v = __asm<[i32], i32>('i32.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap32(v);
	}
	getInt32(byteOffset: i32, littleEndian?: boolean): i32 {
		const v = __asm<[i32], i32>('i32.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap32(v);
	}
	getUint64(byteOffset: i32, littleEndian?: boolean): u64 {
		const v = __asm<[i32], i64>('i64.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap64(v);
	}
	getInt64(byteOffset: i32, littleEndian?: boolean): i64 {
		const v = __asm<[i32], i64>('i64.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap32(v);
	}
	getFloat32(byteOffset: i32, littleEndian?: boolean): number	{
		const offset = this.byteOffset + byteOffset;
		return littleEndian
			? __asm<[i32], f32>('f32.load')(offset)
			: asf32(bswap32(__asm<[i32], i32>('i32.load')(offset)));
	}
	getFloat64(byteOffset: i32, littleEndian?: boolean): number {
		const offset = this.byteOffset + byteOffset;
		return littleEndian
			? __asm<[i32], f64>('f64.load')(offset)
			: asf64(bswap64(__asm<[i32], i64>('i64.load')(offset)));
	}
	setUint8(byteOffset: i32, value: u32): void {
		__asm<[i32, i32], void>('i32.store8')(this.byteOffset + byteOffset, value);
	}
	setInt8(byteOffset: i32, value: i32): void {
		__asm<[i32, i32], i32>('i32.store8')(this.byteOffset + byteOffset, value);
	}
	setUint16(byteOffset: i32, value: u32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store16')(this.byteOffset + byteOffset, littleEndian ? value : bswap16(value));
	}
	setInt16(byteOffset: i32, value: i32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store16')(this.byteOffset + byteOffset, littleEndian ? value : bswap16(value));
	}
	setUint32(byteOffset: i32, value: u32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap32(value));
	}
	setInt32(byteOffset: i32, value: i32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap32(value));
	}
	setUint64(byteOffset: i32, value: u64, littleEndian?: boolean): void {
		__asm<[i32, i64], void>('i64.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap64(value));
	}
	setInt64(byteOffset: i32, value: i64, littleEndian?: boolean): void {
		__asm<[i32, i64], void>('i64.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap64(value));
	}

	setFloat32(byteOffset: i32, value: number, littleEndian?: boolean): void {
		const offset = this.byteOffset + byteOffset;
		if (littleEndian)
			__asm<[i32, f32], void>('f32.store')(offset, value);
		else
			__asm<[i32, i32], void>('i32.store')(offset, bswap32(asi32(value)));

	}
	setFloat64(byteOffset: i32, value: number, littleEndian?: boolean): void {
		const offset = this.byteOffset + byteOffset;
		if (littleEndian)
			__asm<[i32, f64], void>('f64.store')(offset, value);
		else
			__asm<[i32, i64], void>('i64.store')(offset, bswap64(asi64(value)));
	}
}
*/

class DataView {
	readonly buffer: ArrayBuffer;
	readonly byteOffset: i32;
	readonly byteLength: i32;

	constructor(buffer: ArrayBuffer, byteOffset: i32 = 0, byteLength: i32 = 0xffffff) {
		this.buffer = buffer;
		this.byteOffset = byteOffset;
		this.byteLength = Math.min(byteLength, buffer.byteLength - byteOffset);
	}

	getUint8(byteOffset: i32): u32 {
		return this.buffer[this.byteOffset + byteOffset];
	}
	getInt8(byteOffset: i32): i32 {
		return __asm<[i32], i32>('i32.load8_s')(this.byteOffset + byteOffset);
	}
	getUint16(byteOffset: i32, littleEndian?: boolean): u32 {
		const v = __asm<[i32], i32>('i32.load16_u')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap16(v);
	}
	getInt16(byteOffset: i32, littleEndian?: boolean): i32 {
		const v = __asm<[i32], i32>('i32.load16_s')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap16(v);
	}
	getUint32(byteOffset: i32, littleEndian?: boolean): u32 {
		const v = __asm<[i32], i32>('i32.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap32(v);
	}
	getInt32(byteOffset: i32, littleEndian?: boolean): i32 {
		const v = __asm<[i32], i32>('i32.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap32(v);
	}
	getUint64(byteOffset: i32, littleEndian?: boolean): u64 {
		const v = __asm<[i32], i64>('i64.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap64(v);
	}
	getInt64(byteOffset: i32, littleEndian?: boolean): i64 {
		const v = __asm<[i32], i64>('i64.load')(this.byteOffset + byteOffset);
		return littleEndian ? v : bswap32(v);
	}
	getFloat32(byteOffset: i32, littleEndian?: boolean): number	{
		const offset = this.byteOffset + byteOffset;
		return littleEndian
			? __asm<[i32], f32>('f32.load')(offset)
			: asf32(bswap32(__asm<[i32], i32>('i32.load')(offset)));
	}
	getFloat64(byteOffset: i32, littleEndian?: boolean): number {
		const offset = this.byteOffset + byteOffset;
		return littleEndian
			? __asm<[i32], f64>('f64.load')(offset)
			: asf64(bswap64(__asm<[i32], i64>('i64.load')(offset)));
	}
	setUint8(byteOffset: i32, value: u32): void {
		__asm<[i32, i32], void>('i32.store8')(this.byteOffset + byteOffset, value);
	}
	setInt8(byteOffset: i32, value: i32): void {
		__asm<[i32, i32], i32>('i32.store8')(this.byteOffset + byteOffset, value);
	}
	setUint16(byteOffset: i32, value: u32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store16')(this.byteOffset + byteOffset, littleEndian ? value : bswap16(value));
	}
	setInt16(byteOffset: i32, value: i32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store16')(this.byteOffset + byteOffset, littleEndian ? value : bswap16(value));
	}
	setUint32(byteOffset: i32, value: u32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap32(value));
	}
	setInt32(byteOffset: i32, value: i32, littleEndian?: boolean): void {
		__asm<[i32, i32], void>('i32.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap32(value));
	}
	setUint64(byteOffset: i32, value: u64, littleEndian?: boolean): void {
		__asm<[i32, i64], void>('i64.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap64(value));
	}
	setInt64(byteOffset: i32, value: i64, littleEndian?: boolean): void {
		__asm<[i32, i64], void>('i64.store')(this.byteOffset + byteOffset, littleEndian ? value : bswap64(value));
	}

	setFloat32(byteOffset: i32, value: number, littleEndian?: boolean): void {
		const offset = this.byteOffset + byteOffset;
		if (littleEndian)
			__asm<[i32, f32], void>('f32.store')(offset, value);
		else
			__asm<[i32, i32], void>('i32.store')(offset, bswap32(asi32(value)));

	}
	setFloat64(byteOffset: i32, value: number, littleEndian?: boolean): void {
		const offset = this.byteOffset + byteOffset;
		if (littleEndian)
			__asm<[i32, f64], void>('f64.store')(offset, value);
		else
			__asm<[i32, i64], void>('i64.store')(offset, bswap64(asi64(value)));
	}
}
