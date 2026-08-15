/* eslint-disable @typescript-eslint/no-inferrable-types */
/* eslint-disable @typescript-eslint/triple-slash-reference */
/* eslint-disable @typescript-eslint/prefer-for-of */
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
	let count = 1;
	for (let t = Math.floor(n / 0x100000000); t > 0; t = Math.floor(t / 0x100000000))
		++count;

	const r: u32[] = new Array<u32>(count + 1);
	for (let i = 0, m = n; i < count; i++) {
		const t = Math.floor(m / 0x100000000);
		r[i] = m - t * 0x100000000;
		m = t;
	}
	return bigTrim(r) as unknown as bigint;
}

export function bigToNumber(a: bigint): number {
	const raw: u32[] = a as unknown as u32[];
	const neg: boolean = (raw[raw.length - 1] & 0x80000000) !== 0;
	const limbs: u32[] = bigApplySign(raw, neg);
	let result: number = 0;
	let scale: number = 1;
	for (let i = 0; i < limbs.length; i++) {
		result = result + limbs[i] * scale;
		scale = scale * 4294967296;
	}
	if (neg)
		return -result;
	return result;
}

function bigSign(a: u32[]): boolean {
	return (a[a.length - 1] & 0x80000000) !== 0;
}

export function bigTrim(a: u32[]): u32[] {
	let n = a.length;
	while (n > 1 && a[n - 1] === ((a[n - 2] & 0x80000000) !== 0 ? 0xffffffff : 0))
		n = n - 1;
	if (n === a.length)
		return a;
	const r: u32[] = new Array<u32>(n);
	for (let i = 0; i < n; i++)
		r[i] = a[i];
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
	const	bx = negb ? 0xffffffff : 0;
	let		carry = negb ? 1 : 0;

	const	na = a.length;
	const	nb = b.length;
	const	n = na > nb ? na : nb;
	const	at = bigSign(a) ? 0xffffffff : 0;
	const	bt = bigSign(b) !== negb ? 0xffffffff : 0;

	const	r = new Array<u32>(n + 1);
	for (let i = 0; i <= n; ++i) {
		const sum = (i < na ? a[i] : at) + (i < nb ? toU32(b[i] ^ bx) : bt) + carry;
		carry	= sum > 0xffffffff ? 1 : 0;
		r[i]	= sum & 0xffffffff;
	}
	return r;
}

function bigCompare(a: u32[], b: u32[]): number {
	let i = a.length;
	if (i !== b.length)
		return i < b.length ? -1 : 1;
	while (i--) {
		if (a[i] !== b[i])
			return a[i] < b[i] ? -1 : 1;
	}
	return 0;
}

function bigNeg(a: u32[]): u32[] {
	return bigAdd(new Array<u32>(1), a, true);
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
	const na = a.length;
	const nb = b.length;
	const r = new Array<u32>(na + nb + 1);
	for (let i = 0; i < na; i++) {
		let carry = 0;
		let j = 0;
		while (j < nb) {
			const prod: u32[] = __towasm_mulWide(a[i], b[j]) as unknown as u32[];
			const t: number = r[i + j] + prod[0] + carry;
			r[i + j] = t & 0xffffffff;
			carry = prod[1] + Math.floor(t / 4294967296);
			j = j + 1;
		}
		// Flushes the row's leftover carry into the columns above it -- a ripple, not a single add, since
		// a column here can receive contributions from both this row's flush and the next row's own pass.
		for (let k = i + nb, c = carry; c > 0; ++k) {
			const tf: number = r[k] + c;
			r[k] = tf & 0xffffffff;
			c = Math.floor(tf / 4294967296);
		}
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
	const n		= a.length;
	const nb	= b.length;
	const r		= new Array<u32>(n);
	let borrow = 0;
	for (let i = 0; i < n; i++) {
		const t = a[i] - (i < nb ? b[i] : 0) - borrow;
		if (t < 0) {
			r[i] = t + 4294967296;
			borrow = 1;
		} else {
			r[i] = t;
			borrow = 0;
		}
	}
	return r;
}

// Shifts a non-negative magnitude left by one bit, inserting `bit` (0 or 1) at the LSB -- stays the same
// length as `a` (any overflow past the top limb is discarded), only ever used on `bigDivModMag`'s
// fixed-capacity remainder buffer, which is sized with enough guard headroom that the discarded bit is
// always 0 by construction (the remainder never exceeds twice the divisor, and the buffer holds one full
// extra limb beyond the divisor's own length).
function bigShl1(a: u32[], bit: number): u32[] {
	const n = a.length;
	const r = new Array<u32>(n);
	let carry: number = bit;
	for (let i = 0; i < n; i++) {
		const v = a[i];
		r[i] = ((v << 1) | carry) & 0xffffffff;
		carry = v >>> 31;
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
	const na = a.length;
	const q = new Array<u32>(na);
	let r = new Array<u32>(b.length + 1);

	let bit = na * 32;
	while (bit--) {
		const limb = bit >> 5;
		const off = bit & 31;
		r = bigShl1(r, (a[limb] >>> off) & 1);
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
		const av = this as unknown as u32[];
		const bv = b as unknown as u32[];
		const nega = bigSign(av);
		const negb = bigSign(bv);
		return bigTrim(bigApplySign(bigMulMag(bigApplySign(av, nega), bigApplySign(bv, negb)), nega !== negb)) as unknown as bigint;
	}

	div(b: bigint): bigint {
		const av = this as unknown as u32[];
		const bv = b as unknown as u32[];
		const nega = bigSign(av);
		const negb = bigSign(bv);
		return bigTrim(bigApplySign(bigDivModMag(bigApplySign(av, nega), bigApplySign(bv, negb), false), nega !== negb)) as unknown as bigint;
	}
	mod(b: bigint): bigint {
		const av = this as unknown as u32[];
		const bv = b as unknown as u32[];
		const nega = bigSign(av);
		const negb = bigSign(bv);
		return bigTrim(bigApplySign(bigDivModMag(bigApplySign(av, nega), bigApplySign(bv, negb), true), nega)) as unknown as bigint;
	}

	// `this << b` -- `b` is itself a `bigint` (real TS only allows shifting a `bigint` by a `bigint`),
	// converted via `bigToNumber` since a shift count too large for that to round-trip exactly isn't a
	// realistic amount to shift by anyway. Reuses `mul` (`x << k` is exactly `x * 2^k`, for either sign)
	// rather than hand-rolling its own sign-extension.
	shl(b: bigint): bigint {
		return this.mul(bigTrim(bigPow2(bigToNumber(b))) as unknown as bigint);
	}

	// Arithmetic (signed) right shift -- `this >> b`, floor-rounding like real `bigint` `>>` (which
	// rounds toward -Infinity, *not* toward zero the way `div` does: `-5n >> 1n === -3n`, not `-2n`).
	// That's exactly what a bit-level shift with sign-extension from the top gives for free, so this
	// shifts limbs directly rather than going through `div`/`bigPow2`.
	shrs(b: bigint): bigint {
		const k			= bigToNumber(b);
		const limbShift = k >>> 5;
		const bitShift	= k & 31;
		const a			= this as unknown as u32[];
		const na		= a.length;
		const ext		= bigSign(a) ? 0xffffffff : 0;
		const r			= new Array<u32>(na);
		for (let i = 0; i < na; i++) {
			const srcLo = i + limbShift;
			const lo = srcLo < na ? a[srcLo] : ext;
			r[i] = bitShift === 0 ? lo : ((lo >>> bitShift) | ((srcLo + 1 < na ?a[srcLo + 1] : ext) << (32 - bitShift))) & 0xffffffff;
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
		const k			= bigToNumber(b);
		const limbShift = k >>> 5;
		const bitShift	= k & 31;
		const a			= this as unknown as u32[];
		const na		= a.length;
		const r			= new Array<u32>(na + 1);
		for (let i = 0; i < na; i++) {
			const srcLo = i + limbShift;
			const lo = srcLo < na ? a[srcLo] : 0;
			r[0] = bitShift === 0 ? lo: ((lo >>> bitShift) | ((srcLo + 1 < na ? a[srcLo + 1] : 0) << (32 - bitShift))) & 0xffffffff;
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
		const radixb = radix ? bigFromNumber(radix) : 10n;
		for (let i = this as unknown as bigint; i > 0; i /= radixb) {
			const d = Number(i % radixb);
			s = String.fromCharCode(d < 10 ? 48 + d : 65 + d - 10) + s;
		}
		return s;
	}
}
