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
// Which constructor form applies (`new Uint8Array(n)` vs `(elements)` vs `(buffer)` vs `(buffer,
// byteOffset, length)`) is a compile-time-only decision towasm.ts's `case 'new'` still makes -- this
// narrow subset has no runtime overload dispatch to express it as ordinary declared constructors instead.

declare class ArrayBuffer {
	offset: i32;
	byteLength: i32;
}

class Uint8Array {
	buffer:		ArrayBuffer	= new ArrayBuffer();
	byteOffset: i32	= 0;
	length:		i32	= 0;
	byteLength: i32	= 0;
	base:		i32	= 0;

	[i: number]: number;

	constructor(length: number);
	constructor(buffer: ArrayBuffer, byteOffset?: number, length?: number);
	constructor(...args: any[]) {}

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
