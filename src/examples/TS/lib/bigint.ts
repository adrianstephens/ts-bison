/* eslint-disable @typescript-eslint/no-inferrable-types */
/* eslint-disable @typescript-eslint/triple-slash-reference */
/* eslint-disable @typescript-eslint/prefer-for-of */
/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	BigInt
//-----------------------------------------------------------------------------

// Limbs are backed by a real `RawArray<u32>` (wasm-GC array, reclaimed by the host's GC when unreachable --
// unlike the old `Uint32Array`/linear-memory backing, which never freed). Every indexed read below is
// still bound to an explicit `number` local before use in further arithmetic, rather than mixed directly
// with a `number` local in one expression -- `arithInline` in backend.ts dispatches purely on the *left*
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
	// The limb loop below builds a MAGNITUDE (its `Math.floor(m / 0x100000000)` walk assumes `n >= 0`),
	// so a negative goes round once on its absolute value and is negated at the end -- otherwise
	// `BigInt(-5)` produced garbage that compared as positive.
	if (n < 0)
		return -bigFromNumber(-n);

	let count = 1;
	for (let t = Math.floor(n / 0x100000000); t > 0; t = Math.floor(t / 0x100000000))
		++count;

	const r: RawArray<u32> = new RawArray<u32>(count + 1);
	for (let i = 0, m = n; i < count; i++) {
		const t = Math.floor(m / 0x100000000);
		r[i] = m - t * 0x100000000;
		m = t;
	}
	return bigTrim(r) as unknown as bigint;
}

// `BigInt('123')`. Real JS accepts optional surrounding whitespace, an optional sign and decimal
// digits (an empty or all-whitespace string is `0n`), and throws a SyntaxError on anything else --
// there is no NaN to fall back on the way `Number('abc')` has. Digits are accumulated through the
// ordinary bigint operators, so this is exact at any length rather than going via `number`.
export function bigFromString(s: string): bigint {
	const n = s.length;
	let i = 0;
	while (i < n && strIsSpace(s.charCodeAt(i)))
		i++;
	let neg = false;
	if (i < n) {
		const c = s.charCodeAt(i);
		if (c === 45 || c === 43) {
			neg = c === 45;
			i++;
		}
	}
	const start = i;
	let result = bigFromNumber(0);
	const ten = bigFromNumber(10);
	while (i < n) {
		const d = s.charCodeAt(i) - 48;
		if (d < 0 || d > 9)
			break;
		result = result.mul(ten).add(bigFromNumber(d));
		i++;
	}
	const digits = i - start;
	while (i < n && strIsSpace(s.charCodeAt(i)))
		i++;
	// Trailing garbage, or a sign with no digits after it. A bare '' or all-whitespace is `0n`, which
	// is why the emptiness test is on `digits` only when something else was actually consumed.
	if (i < n || (digits === 0 && start > 0))
		throw new Error('Cannot convert ' + s + ' to a BigInt');
	return neg ? -result : result;
}

export function bigToNumber(a: bigint): number {
	const raw: RawArray<u32> = a as unknown as RawArray<u32>;
	const neg: boolean = (raw[raw.length - 1] & 0x80000000) !== 0;
	const limbs: RawArray<u32> = bigApplySign(raw, neg);
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

function bigSign(a: RawArray<u32>): boolean {
	return (a[a.length - 1] & 0x80000000) !== 0;
}

export function bigTrim(a: RawArray<u32>): RawArray<u32> {
	let n = a.length;
	while (n > 1 && a[n - 1] === ((a[n - 2] & 0x80000000) !== 0 ? 0xffffffff : 0))
		n = n - 1;
	if (n === a.length)
		return a;
	const r: RawArray<u32> = new RawArray<u32>(n);
	for (let i = 0; i < n; i++)
		r[i] = a[i];
	return r;

}
// `x`'s only call site (`toU32(b[i] ^ bx)`) already passes a genuine `i32` (`^`'s declared result type),
// so this takes/returns the real pseudo-types directly rather than `number` -- `i32`->`u32` is a free tag
// reinterpretation in backend.ts's `coerceTop` (wasm has no separate unsigned storage), so the body compiles
// to nothing but a return, and the caller's `number` context does one unsigned widen (`f64.convert_i32_u`)
// at the very end instead of a signed widen in and a truncate back out around a branch.
function toU32(x: i32): u32 {
	return x;
}

function bigAdd(a: RawArray<u32>, b: RawArray<u32>, negb: boolean): RawArray<u32> {
	const	bx = negb ? 0xffffffff : 0;
	let		carry = negb ? 1 : 0;

	const	na = a.length;
	const	nb = b.length;
	const	n = na > nb ? na : nb;
	const	at = bigSign(a) ? 0xffffffff : 0;
	const	bt = bigSign(b) !== negb ? 0xffffffff : 0;

	const	r = new RawArray<u32>(n + 1);
	for (let i = 0; i <= n; ++i) {
		const sum = (i < na ? a[i] : at) + (i < nb ? toU32(b[i] ^ bx) : bt) + carry;
		carry	= sum > 0xffffffff ? 1 : 0;
		r[i]	= sum & 0xffffffff;
	}
	return r;
}

function bigCompare(a: RawArray<u32>, b: RawArray<u32>): number {
	// SIGN FIRST. These limbs are two's complement -- `bigToNumber` reads the sign off the top bit of the
	// highest limb -- so an unsigned walk gets every mixed-sign comparison wrong: `0n > -1n` was false,
	// because `0 < 0xffffffff` as unsigned. Every `<`/`>`/`<=`/`>=`/`==`/`!=` on bigints comes through
	// here, so that one line was wrong for all of them.
	const an = a.length > 0 && (a[a.length - 1] & 0x80000000) !== 0;
	const bn = b.length > 0 && (b[b.length - 1] & 0x80000000) !== 0;
	if (an !== bn)
		return an ? -1 : 1;

	// SIGN-EXTENDED, so this compares VALUES rather than representations. Length alone cannot decide it:
	// a `bigint` has two physical forms here -- a literal emits `i64.const`, the `BigInt` class holds
	// `RawArray<u32>` -- so the same number reaches this with different limb counts, and `BigInt(0) === 0n` was
	// false purely because one zero was one limb longer than the other.
	let i = a.length > b.length ? a.length : b.length;
	while (i--) {
		const av = i < a.length ? a[i] : (an ? 0xffffffff : 0);
		const bv = i < b.length ? b[i] : (bn ? 0xffffffff : 0);
		if (av !== bv)
			return av < bv ? -1 : 1;
	}
	return 0;
}

function bigNeg(a: RawArray<u32>): RawArray<u32> {
	return bigAdd(new RawArray<u32>(1), a, true);
}

function bigApplySign(a: RawArray<u32>, neg: boolean): RawArray<u32> {
	if (neg)
		return bigNeg(a);
	return a;
}

// Unsigned magnitude multiply (`mul`'s sign is handled by its caller). Schoolbook/operand-scanning, one
// exact 32x32->64 product per limb pair via `__towasm_mulWide` (real `i64.mul`, not `number` arithmetic
// -- a raw 32x32 product needs up to 64 bits, past what `number` can hold exactly at 2^53) -- read back
// as a 2-limb `bigint` (see backend.ts's own comment on the intrinsic), low limb at index 0.
function bigMulMag(a: RawArray<u32>, b: RawArray<u32>): RawArray<u32> {
	const na = a.length;
	const nb = b.length;
	const r = new RawArray<u32>(na + nb + 1);
	for (let i = 0; i < na; i++) {
		let carry = 0;
		let j = 0;
		while (j < nb) {
			const prod: RawArray<u32> = __towasm_mulWide(a[i], b[j]) as unknown as RawArray<u32>;
			// Each limb bound to its own `number` local FIRST -- the idiom this file's header describes,
			// and the reason for it: two limb reads added directly are both `u32`-kinded, so the add is
			// done in `i32` and WRAPS. `t` then went negative, `Math.floor(t / 2^32)` gave -1 instead of
			// 0, and the row lost a carry -- `1000000n * 1000000n` came out exactly 2^32 short.
			const acc: number	= r[i + j];
			const lo: number	= prod[0];
			const hi: number	= prod[1];
			const t: number		= acc + lo + carry;
			r[i + j] = t & 0xffffffff;
			carry = hi + Math.floor(t / 4294967296);
			j = j + 1;
		}
		// Flushes the row's leftover carry into the columns above it -- a ripple, not a single add, since
		// a column here can receive contributions from both this row's flush and the next row's own pass.
		for (let k = i + nb, c = carry; c > 0; ++k) {
			const at: number = r[k];
			const tf: number = at + c;
			r[k] = tf & 0xffffffff;
			c = Math.floor(tf / 4294967296);
		}
	}
	return r;
}

// `a >= b` by magnitude, MSB-first, where `a` may be longer than `b` (`bigDivModMag`'s remainder buffer
// always carries one guard limb past the divisor's own length).
function bigGeMag(a: RawArray<u32>, b: RawArray<u32>): boolean {
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
function bigSubMag(a: RawArray<u32>, b: RawArray<u32>): RawArray<u32> {
	const n		= a.length;
	const nb	= b.length;
	const r		= new RawArray<u32>(n);
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
function bigShl1(a: RawArray<u32>, bit: number): RawArray<u32> {
	const n = a.length;
	const r = new RawArray<u32>(n);
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
function bigPow2(k: number): RawArray<u32> {
	const limb: number = k >> 5;
	const r: RawArray<u32> = new RawArray<u32>(limb + 2);
	r[limb] = 1 << (k & 0x1f);
	return r;
}

// Unsigned magnitude division (`div`/`mod`'s sign is handled by their caller): `mod ? a mod b : floor(a/b)`.
// Binary (bit-at-a-time) restoring division -- ~32x more iterations than a multi-limb quotient-digit
// estimate (Knuth's algorithm D), but nothing here needs a digit *estimate* (and the correction step
// that comes with one) -- each step's decision is an exact compare, so this is the version that's
// actually easy to get right.
function bigDivModMag(a: RawArray<u32>, b: RawArray<u32>, mod: boolean): RawArray<u32> {
	const na = a.length;
	const q = new RawArray<u32>(na);
	let r = new RawArray<u32>(b.length + 1);

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
	// A REAL conversion, not a placeholder: `BigInt(5)` is a call, and towasm lowers a call on a class to
	// its constructor, so a constructor that ignored `value` silently produced zero for every input.
	// The `as unknown as` is for tsc's benefit only -- towasm reads the last statement's type with the
	// casts stripped, so `bigFromNumber`'s own `bigint` is what determines this class's physical form
	// (a `RawArray<u32>`, the same representation the arithmetic below reinterprets `this` as).
	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(value: bigint) {
		return value as unknown as BigInt;
	}
	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(value: string) {
		return bigFromString(value) as unknown as BigInt;
	}
	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(value: number) {
		return bigFromNumber(value) as unknown as BigInt;
	}

    valueOf(): bigint { return this as unknown as bigint; }
//	static readonly [Symbol.toStringTag]: "BigInt";

	neg(): bigint {
		return bigTrim(bigNeg(this as unknown as RawArray<u32>)) as unknown as bigint;
	}
	add(b: bigint): bigint {
		return bigTrim(bigAdd(this as unknown as RawArray<u32>, b as unknown as RawArray<u32>, false)) as unknown as bigint;
	}
	sub(b: bigint): bigint {
		return bigTrim(bigAdd(this as unknown as RawArray<u32>, b as unknown as RawArray<u32>, true)) as unknown as bigint;
	}

	mul(b: bigint): bigint {
		const av = this as unknown as RawArray<u32>;
		const bv = b as unknown as RawArray<u32>;
		const nega = bigSign(av);
		const negb = bigSign(bv);
		return bigTrim(bigApplySign(bigMulMag(bigApplySign(av, nega), bigApplySign(bv, negb)), nega !== negb)) as unknown as bigint;
	}

	div(b: bigint): bigint {
		const av = this as unknown as RawArray<u32>;
		const bv = b as unknown as RawArray<u32>;
		const nega = bigSign(av);
		const negb = bigSign(bv);
		return bigTrim(bigApplySign(bigDivModMag(bigApplySign(av, nega), bigApplySign(bv, negb), false), nega !== negb)) as unknown as bigint;
	}
	mod(b: bigint): bigint {
		const av = this as unknown as RawArray<u32>;
		const bv = b as unknown as RawArray<u32>;
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
	shr_s(b: bigint): bigint {
		const k			= bigToNumber(b);
		const limbShift = k >>> 5;
		const bitShift	= k & 31;
		const a			= this as unknown as RawArray<u32>;
		const na		= a.length;
		const ext		= bigSign(a) ? 0xffffffff : 0;
		const r			= new RawArray<u32>(na);
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
	shr_u(b: bigint): bigint {
		const k			= bigToNumber(b);
		const limbShift = k >>> 5;
		const bitShift	= k & 31;
		const a			= this as unknown as RawArray<u32>;
		const na		= a.length;
		const r			= new RawArray<u32>(na + 1);
		for (let i = 0; i < na; i++) {
			const srcLo = i + limbShift;
			const lo = srcLo < na ? a[srcLo] : 0;
			r[0] = bitShift === 0 ? lo: ((lo >>> bitShift) | ((srcLo + 1 < na ? a[srcLo + 1] : 0) << (32 - bitShift))) & 0xffffffff;
		}
		return bigTrim(r) as unknown as bigint;
	}

	// `&`/`|`/`^` limb-wise over the two's-complement bit patterns, each operand sign-extended to the
	// wider length plus one guard limb -- which is what makes the infinite sign extension real JS
	// specifies fall out for free, including for a negative operand. `toU32` because this compiler (like
	// JS) gives a bitwise op a *signed* 32-bit result even for unsigned-meaning limbs.
	private static bitwise(a: RawArray<u32>, b: RawArray<u32>, op: i32): RawArray<u32> {
		const na = a.length;
		const nb = b.length;
		const n = (na > nb ? na : nb) + 1;
		const aext: u32 = bigSign(a) ? 0xffffffff : 0;
		const bext: u32 = bigSign(b) ? 0xffffffff : 0;
		const r = new RawArray<u32>(n);
		for (let i = 0; i < n; i++) {
			const x: u32 = i < na ? a[i] : aext;
			const y: u32 = i < nb ? b[i] : bext;
			r[i] = op === 0 ? toU32(x & y) : op === 1 ? toU32(x | y) : toU32(x ^ y);
		}
		return bigTrim(r);
	}
	and(b: bigint): bigint	{ return BigInt.bitwise(this as unknown as RawArray<u32>, b as unknown as RawArray<u32>, 0) as unknown as bigint; }
	or(b: bigint): bigint	{ return BigInt.bitwise(this as unknown as RawArray<u32>, b as unknown as RawArray<u32>, 1) as unknown as bigint; }
	xor(b: bigint): bigint	{ return BigInt.bitwise(this as unknown as RawArray<u32>, b as unknown as RawArray<u32>, 2) as unknown as bigint; }

	// `~x` inverts every bit of the infinite two's-complement pattern, which is `-x - 1`.
	not(): bigint {
		const a = this as unknown as RawArray<u32>;
		const n = a.length;
		const r = new RawArray<u32>(n + 1);
		const ext: u32 = bigSign(a) ? 0xffffffff : 0;
		for (let i = 0; i < n + 1; i++)
			r[i] = toU32(~(i < n ? a[i] : ext));
		return bigTrim(r) as unknown as bigint;
	}

	// Exponentiation by squaring. A negative exponent is a RangeError in real JS; there is no useful
	// integer answer, so it comes back as zero rather than looping forever.
	pow(b: bigint): bigint {
		let e = bigToNumber(b);
		if (e < 0)
			return bigFromNumber(0);
		let base = this as unknown as bigint;
		let result = bigFromNumber(1);
		while (e > 0) {
			if ((e & 1) !== 0)
				result = result.mul(base);
			base = base.mul(base);
			e = Math.floor(e / 2);
		}
		return result;
	}

	// -1/0/1, comparing by magnitude.
	compare(b: bigint): number {
		return bigCompare(this as unknown as RawArray<u32>, b as unknown as RawArray<u32>);
	}

	// `<`/`>`/`<=`/`>=`/`==`/`!=` on two `bigint`s all lower to one of these (see backend.ts's
	// `BIGINT_OPS`) -- each just wraps `compare` rather than re-walking the limbs, so the actual
	// comparison logic exists exactly once.
	lt(b: bigint): boolean { return this.compare(b) < 0; }
	gt(b: bigint): boolean { return this.compare(b) > 0; }
	le(b: bigint): boolean { return this.compare(b) <= 0; }
	ge(b: bigint): boolean { return this.compare(b) >= 0; }
	eq(b: bigint): boolean { return this.compare(b) === 0; }
	ne(b: bigint): boolean { return this.compare(b) !== 0; }

	toString(radix?: number): string {
		const self = this as unknown as bigint;
		// Zero has no digits to walk, so the loop below produced '' for it rather than '0'.
		if (self === 0n)
			return '0';
		// A NEGATIVE walks its own magnitude and prefixes '-': the digit loop below is `i > 0`, so
		// anything negative came back as '' too.
		if (self < 0n)
			return '-'.concat((-self).toString(radix));
		let s = '';
		const radixb = radix ? bigFromNumber(radix) : 10n;
		for (let i = self; i > 0; i /= radixb) {
			const d = Number(i % radixb);
			// LOWERCASE above 9, matching JS -- and `Number.prototype.toString`, which had the same bug.
			s = String.fromCharCode(d < 10 ? 48 + d : 97 + d - 10).concat(s);
		}
		return s;
	}
}
