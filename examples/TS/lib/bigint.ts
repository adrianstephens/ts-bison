/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	BigInt
//-----------------------------------------------------------------------------

// Limbs are backed by a real `u32[]` (wasm-GC array, reclaimed by the host's GC when unreachable --
// unlike the old `Uint32Array`/linear-memory backing, which never freed). Every indexed read below is
// still bound to an explicit `number` local before use in further arithmetic, rather than mixed directly
// with a `number` local in one expression -- `arithInline` in towasm.ts dispatches purely on the *left*
// operand's physical kind, so e.g. `someArr[i] * someLargeNumberLocal` would silently truncate the right
// side toward `i32`/`u32` (lossy/saturating) if the left side stays a raw indexed read. Bitwise results
// need their own care in the other direction: real JS (and this compiler) gives `&`/`|`/`^`/`<<`/`>>` a
// *signed* 32-bit result even for an unsigned-meaning operand -- see `toU32`.

// Exact 32x32->64 unsigned product (real wasm `i64.mul`, not `number` arithmetic -- see `bigMulMag`).
// Declaring both params `i64` (not `i32`) is what makes this work with no scratch local: `emitCall`
// coerces each argument to its declared param type *before* pushing it (see `emitAs`'s own `f64`->`i64`
// case), so by the time this asm body runs, both operands are already independently widened to `i64` and
// sitting on the stack -- `i64.mul` alone is then the exact 64-bit product, since `(2^32-1)^2 < 2^64`.
export const __towasm_mulWide	= __asm<[i64, i64], i64>('i64.mul');

export function bigFromNumber(n: number): bigint {
	let count: number = 1;
	let t: number = Math.floor(n / 4294967296);
	while (t > 0) {
		count = count + 1;
		t = Math.floor(t / 4294967296);
	}
	const r: u32[] = new Array<u32>(count + 1);
	let i: number = 0;
	let m: number = n;
	while (i < count) {
		r[i] = m - Math.floor(m / 4294967296) * 4294967296;
		m = Math.floor(m / 4294967296);
		i = i + 1;
	}
	return bigTrim(r) as unknown as bigint;
}

export function bigToNumber(a: bigint): number {
	const raw: u32[] = a as unknown as u32[];
	const neg: boolean = (raw[raw.length - 1] & 0x80000000) !== 0;
	const limbs: u32[] = bigApplySign(raw, neg);
	let result: number = 0;
	let scale: number = 1;
	let i: number = 0;
	while (i < limbs.length) {
		const digit: number = limbs[i];
		result = result + digit * scale;
		scale = scale * 4294967296;
		i = i + 1;
	}
	if (neg)
		return -result;
	return result;
}

function bigSign(a: u32[]): boolean {
	return (a[a.length - 1] & 0x80000000) !== 0;
}

export function bigTrim(a: u32[]): u32[] {
	let n: number = a.length;
	while (n > 1 && a[n - 1] === ((a[n - 2] & 0x80000000) !== 0 ? 0xffffffff : 0))
		n = n - 1;
	if (n === a.length)
		return a;
	const r: u32[] = new Array<u32>(n);
	let i: number = 0;
	while (i < n) {
		r[i] = a[i];
		i = i + 1;
	}
	return r;

}
// `x`'s only call site (`toU32(b[i] ^ bx)`) already passes a genuine `i32` (`^`'s declared result type),
// so this takes/returns the real pseudo-types directly rather than `number` -- `i32`->`u32` is a free tag
// reinterpretation in towasm.ts's `coerceTop` (wasm has no separate unsigned storage), so the body compiles
// to nothing but a return, and the caller's `number` context does one unsigned widen (`f64.convert_i32_u`)
// at the very end instead of a signed widen in and a truncate back out around a branch.
function toU32(x: i32): u32 {
	return x;
}

function bigAdd(a: u32[], b: u32[], negb: boolean): u32[] {
	const	bx: number = negb ? 0xffffffff : 0;
	let		carry: number = negb ? 1 : 0;

	const	na: number = a.length;
	const	nb: number = b.length;
	const	n: number = na > nb ? na : nb;
	const	at: number = bigSign(a) ? 0xffffffff : 0;
	const	bSign: boolean = bigSign(b);
	const	bt: number = bSign !== negb ? 0xffffffff : 0;

	const	r: u32[] = new Array<u32>(n + 1);
	let		i: number = 0;
	while (i <= n) {
		// A ternary can't take an indexed read as one of its branches here (the checker can't unify
		// `a[i]`'s type with the other branch's) -- `if`/`else` into a `let` instead.
		let av: number = at;
		if (i < na)
			av = a[i];
		let bv: number = bt;
		if (i < nb)
			bv = toU32(b[i] ^ bx);

		const sum: number	= av + bv + carry;
		carry	= sum > 0xffffffff ? 1 : 0;
		r[i]	= sum & 0xffffffff;
		i = i + 1;
	}
	return r;
}

function bigCompare(a: u32[], b: u32[]): number {
	let i: number = a.length;
	if (i !== b.length)
		return i < b.length ? -1 : 1;
	while (i--) {
		if (a[i] !== b[i])
			return a[i] < b[i] ? -1 : 1;
	}
	return 0;
}

function bigNeg(a: u32[]): u32[] {
	const zero: u32[] = new Array<u32>(1);
	return bigAdd(zero, a, true);
}

function bigApplySign(a: u32[], neg: boolean): u32[] {
	if (neg)
		return bigNeg(a);
	return a;
}

// Unsigned magnitude multiply (`mul`'s sign is handled by its caller). Schoolbook/operand-scanning, one
// exact 32x32->64 product per limb pair via `__towasm_mulWide` (real `i64.mul`, not `number` arithmetic
// -- a raw 32x32 product needs up to 64 bits, past what `number` can hold exactly at 2^53) -- read back
// as a 2-limb `bigint` (see towasm.ts's own comment on the intrinsic), low limb at index 0.
function bigMulMag(a: u32[], b: u32[]): u32[] {
	const na: number = a.length;
	const nb: number = b.length;
	const r: u32[] = new Array<u32>(na + nb + 1);
	let i: number = 0;
	while (i < na) {
		let carry: number = 0;
		let j: number = 0;
		while (j < nb) {
			const prod: u32[] = __towasm_mulWide(a[i], b[j]) as unknown as u32[];
			const prodLo: number = prod[0];
			const prodHi: number = prod[1];

			const t: number = r[i + j] + prodLo + carry;
			r[i + j] = t & 0xffffffff;
			carry = prodHi + Math.floor(t / 4294967296);
			j = j + 1;
		}
		// Flushes the row's leftover carry into the columns above it -- a ripple, not a single add, since
		// a column here can receive contributions from both this row's flush and the next row's own pass.
		let k: number = i + nb;
		let c: number = carry;
		while (c > 0) {
			const tf: number = r[k] + c;
			r[k] = tf & 0xffffffff;
			c = Math.floor(tf / 4294967296);
			k = k + 1;
		}
		i = i + 1;
	}
	return r;
}

// `a >= b` by magnitude, MSB-first, where `a` may be longer than `b` (`bigDivModMag`'s remainder buffer
// always carries one guard limb past the divisor's own length).
function bigGeMag(a: u32[], b: u32[]): boolean {
	const nb: number = b.length;
	let i: number = a.length;
	while (i > nb) {
		i = i - 1;
		if (a[i] !== 0)
			return true;
	}
	while (i--) {
		if (a[i] !== b[i])
			return a[i] > b[i];
	}
	return true;
}

// `a - b` by magnitude, assuming `a >= b` (no borrow past `a`'s own top limb) and `a.length >= b.length`.
function bigSubMag(a: u32[], b: u32[]): u32[] {
	const n: number = a.length;
	const nb: number = b.length;
	const r: u32[] = new Array<u32>(n);
	let borrow: number = 0;
	let i: number = 0;
	while (i < n) {
		let bi: number = 0;
		if (i < nb)
			bi = b[i];
		const t: number = a[i] - bi - borrow;
		if (t < 0) {
			r[i] = t + 4294967296;
			borrow = 1;
		} else {
			r[i] = t;
			borrow = 0;
		}
		i = i + 1;
	}
	return r;
}

// Shifts a non-negative magnitude left by one bit, inserting `bit` (0 or 1) at the LSB -- stays the same
// length as `a` (any overflow past the top limb is discarded), only ever used on `bigDivModMag`'s
// fixed-capacity remainder buffer, which is sized with enough guard headroom that the discarded bit is
// always 0 by construction (the remainder never exceeds twice the divisor, and the buffer holds one full
// extra limb beyond the divisor's own length).
function bigShl1(a: u32[], bit: number): u32[] {
	const n: number = a.length;
	const r: u32[] = new Array<u32>(n);
	let carry: number = bit;
	let i: number = 0;
	while (i < n) {
		const v: number = a[i];
		r[i] = ((v << 1) | carry) & 0xffffffff;
		carry = v >>> 31;
		i = i + 1;
	}
	return r;
}

// Magnitude of `2^k`, with one guard limb above the set bit so it's unambiguously non-negative even when
// the set bit lands exactly on a limb's own top bit (e.g. `k=31` sets `0x80000000` in limb 0, which
// needs a zero limb 1 above it to still read as +2147483648, not -2147483648).
function bigPow2(k: number): u32[] {
	const limb: number = k >> 5;
	const r: u32[] = new Array<u32>(limb + 2);
	r[limb] = 1 << (k & 0x1f);
	return r;
}

// Unsigned magnitude division (`div`/`mod`'s sign is handled by their caller): `mod ? a mod b : floor(a/b)`.
// Binary (bit-at-a-time) restoring division -- ~32x more iterations than a multi-limb quotient-digit
// estimate (Knuth's algorithm D), but nothing here needs a digit *estimate* (and the correction step
// that comes with one) -- each step's decision is an exact compare, so this is the version that's
// actually easy to get right.
function bigDivModMag(a: u32[], b: u32[], mod: boolean): u32[] {
	const na: number = a.length;
	const nb: number = b.length;
	const q: u32[] = new Array<u32>(na);
	let r: u32[] = new Array<u32>(nb + 1);

	let bit: number = na * 32;
	while (bit--) {
		const limb: number = Math.floor(bit / 32);
		const off: number = bit - limb * 32;
		const abit: number = (a[limb] >>> off) & 1;
		r = bigShl1(r, abit);
		if (bigGeMag(r, b)) {
			r = bigSubMag(r, b);
			q[limb] = q[limb] | (1 << off);
		}
	}
	return mod ? r : q;
}

export class BigInt {
	// `value` is never actually read -- this exists purely so `towasm.ts`'s `ensureClass` has a real,
	// explicit-return constructor to determine this class's own physical `this`-type from (a `u32[]`,
	// same representation real bigint arithmetic already reinterprets `this` as everywhere below).
	constructor(value?: any) {
		return new Array<u32>(0) as unknown as BigInt;
	}

    valueOf(): bigint { return this as unknown as bigint; }
//	static readonly [Symbol.toStringTag]: "BigInt";

	neg(): bigint {
		return bigTrim(bigNeg(this as unknown as u32[])) as unknown as bigint;
	}
	add(b: bigint): bigint {
		return bigTrim(bigAdd(this as unknown as u32[], b as unknown as u32[], false)) as unknown as bigint;
	}
	sub(b: bigint): bigint {
		return bigTrim(bigAdd(this as unknown as u32[], b as unknown as u32[], true)) as unknown as bigint;
	}

	mul(b: bigint): bigint {
		const av: u32[] = this as unknown as u32[];
		const bv: u32[] = b as unknown as u32[];
		const nega: boolean = bigSign(av);
		const negb: boolean = bigSign(bv);
		const r: u32[] = bigMulMag(bigApplySign(av, nega), bigApplySign(bv, negb));
		return bigTrim(bigApplySign(r, nega !== negb)) as unknown as bigint;
	}

	div(b: bigint): bigint {
		const av: u32[] = this as unknown as u32[];
		const bv: u32[] = b as unknown as u32[];
		const nega: boolean = bigSign(av);
		const negb: boolean = bigSign(bv);
		const r: u32[] = bigDivModMag(bigApplySign(av, nega), bigApplySign(bv, negb), false);
		return bigTrim(bigApplySign(r, nega !== negb)) as unknown as bigint;
	}
	mod(b: bigint): bigint {
		const av: u32[] = this as unknown as u32[];
		const bv: u32[] = b as unknown as u32[];
		const nega: boolean = bigSign(av);
		const negb: boolean = bigSign(bv);
		const r: u32[] = bigDivModMag(bigApplySign(av, nega), bigApplySign(bv, negb), true);
		return bigTrim(bigApplySign(r, nega)) as unknown as bigint;
	}

	// `this << b` -- `b` is itself a `bigint` (real TS only allows shifting a `bigint` by a `bigint`),
	// converted via `bigToNumber` since a shift count too large for that to round-trip exactly isn't a
	// realistic amount to shift by anyway. Reuses `mul` (`x << k` is exactly `x * 2^k`, for either sign)
	// rather than hand-rolling its own sign-extension.
	shl(b: bigint): bigint {
		const k: number = bigToNumber(b);
		return this.mul(bigTrim(bigPow2(k)) as unknown as bigint);
	}

	// Arithmetic (signed) right shift -- `this >> b`, floor-rounding like real `bigint` `>>` (which
	// rounds toward -Infinity, *not* toward zero the way `div` does: `-5n >> 1n === -3n`, not `-2n`).
	// That's exactly what a bit-level shift with sign-extension from the top gives for free, so this
	// shifts limbs directly rather than going through `div`/`bigPow2`.
	shrs(b: bigint): bigint {
		const k: number = bigToNumber(b);
		const limbShift: number = Math.floor(k / 32);
		const bitShift: number	= k - limbShift * 32;
		const a: u32[]	= this as unknown as u32[];
		const na: number		= a.length;
		const ext: number		= bigSign(a) ? 0xffffffff : 0;
		const r: u32[]	= new Array<u32>(na);
		let i: number = 0;
		while (i < na) {
			const srcLo: number = i + limbShift;
			let lo: number = ext;
			if (srcLo < na)
				lo = a[srcLo];
			let hi: number = ext;
			if (srcLo + 1 < na)
				hi = a[srcLo + 1];
			if (bitShift === 0) {
				r[i] = lo;
			} else {
				r[i] = ((lo >>> bitShift) | (hi << (32 - bitShift))) & 0xffffffff;
			}
			i = i + 1;
		}
		return bigTrim(r) as unknown as bigint;
	}

	// Logical (unsigned) right shift -- real `bigint` has no `>>>` at all (arbitrary precision has no
	// fixed width to be unsigned *within*, so real JS throws). This library defines it anyway: shift the
	// current two's-complement bit pattern right, zero-filling from the top regardless of sign, treating
	// `this` as if it were a fixed-width unsigned integer exactly as wide as its own current limbs. One
	// guard limb above the result (unlike `shrs`) forces a non-negative read even when a negative input's
	// shifted-down bits leave the new top limb's own top bit set.
	shru(b: bigint): bigint {
		const k: number			= bigToNumber(b);
		const limbShift: number = Math.floor(k / 32);
		const bitShift: number	= k - limbShift * 32;
		const a: u32[]	= this as unknown as u32[];
		const na: number		= a.length;
		const r: u32[]	= new Array<u32>(na + 1);
		let i: number = 0;
		while (i < na) {
			const srcLo: number = i + limbShift;
			let lo: number = 0;
			if (srcLo < na)
				lo = a[srcLo];
			let hi: number = 0;
			if (srcLo + 1 < na)
				hi = a[srcLo + 1];
			if (bitShift === 0) {
				r[i] = lo;
			} else {
				r[i] = ((lo >>> bitShift) | (hi << (32 - bitShift))) & 0xffffffff;
			}
			i = i + 1;
		}
		return bigTrim(r) as unknown as bigint;
	}

	// -1/0/1, comparing by magnitude.
	compare(b: bigint): number {
		return bigCompare(this as unknown as u32[], b as unknown as u32[]);
	}

	// `<`/`>`/`<=`/`>=`/`==`/`!=` on two `bigint`s all lower to one of these (see towasm.ts's
	// `BIGINT_OPS`) -- each just wraps `compare` rather than re-walking the limbs, so the actual
	// comparison logic exists exactly once.
	lt(b: bigint): boolean { return this.compare(b) < 0; }
	gt(b: bigint): boolean { return this.compare(b) > 0; }
	le(b: bigint): boolean { return this.compare(b) <= 0; }
	ge(b: bigint): boolean { return this.compare(b) >= 0; }
	eq(b: bigint): boolean { return this.compare(b) === 0; }
	ne(b: bigint): boolean { return this.compare(b) !== 0; }

	toString(radix?: number): string {
		let s = '';
		let i = this as unknown as bigint;
		let radixb = radix ? bigFromNumber(radix) : 10n;
		while (i > 0) {
			const d = Number(i % radixb);
			s = String.fromCharCode(d < 10 ? 48 + d : 65 + d - 10) + s;
			i /= radixb;
		}
		return s;
	}
}
