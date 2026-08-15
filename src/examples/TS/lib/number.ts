/* eslint-disable no-loss-of-precision */
/// <reference path="./lib.d.ts" />

export const __towasm_mod = __asm<[number, number], number>(`
	(switch $T
		(($i32 $i64) $T.rem_s)
		(($f32 $f64)
			(local $x $T)
			(local $y $T)
			local.set	$y
			local.tee	$x
			local.get	$x
			local.get	$y
			$T.div
			$T.trunc
			local.get	$y
			$T.mul
			$T.sub
		)
	)
`);

export const ieeeSplit	= __asm<[f64], i64>('i64.reinterpret_f64');
export const ieeeFrom	= __asm<[i64, i64], f64>(`
	i64.const 32
	i64.shl
	i64.add
	f64.reinterpret_i64
`);

function cos_core(r: number): number {
	const z = r * r;
	const C1 = -0.5;
	const C2 = 4.16666666666665929218e-2;
	const C3 = -1.38888888888741095749e-3;
	const C4 = 2.48015872894767294178e-5;
	return z * (C1 + z * (C2 + z * (C3 + z * C4))) + 1.0;
}
function sin_core(r: number): number {
	const z = r * r;
	const S1 = -1.66666666666666324348e-1;
	const S2 = 8.33333333332248946124e-3;
	const S3 = -1.98412698298579493134e-4;
	const S4 = 2.75573137070700676789e-6;
	return r + r * z * (S1 + z * (S2 + z * (S3 + z * S4)));
}

// Leibniz series x - x^3/3 + x^5/5 - x^7/7 + x^9/9 -- only accurate for small |x| (converges slowly near
// its domain edge), so callers must range-reduce down to roughly |x| <= 1/3 first.
function atanPoly(x: number): number {
	const x2 = x * x;
	return x * (1 + x2 * (-1 / 3 + x2 * (1 / 5 + x2 * (-1 / 7 + x2 / 9))));
}

function intPow(x: number, y: number): number {
	if (y < 0)
		return 1 / intPow(x, -y);

	let result = y & 1 ? x : 1;
	while (y >>= 1) {
		x *= x;
		if (y & 1)
			result *= x;
	}
	return result;
}
//-----------------------------------------------------------------------------
//	Boolean
//-----------------------------------------------------------------------------

export class Boolean {
	constructor(value: i32) {
		return value as unknown as Boolean;
	}
	valueOf():	boolean { return this as unknown as boolean; }
	toString(): string	{ return (this as unknown as boolean) ? 'true' : 'false'; }
}

//-----------------------------------------------------------------------------
//	Number
//-----------------------------------------------------------------------------

function getSign(p: StringParser): number {
	const c = p.code();
	if (c === 45) {
		++p.pos;
		return -1;
	} else if (c === 43) {
		++p.pos;
	}
	return 1;
}
function getUnsigned(p: StringParser, radix = 10, value = 0): number {
	// `break` isn't supported (see towasm.ts's own statement dispatch) -- the stop condition folds
	// into the loop condition itself instead of exiting from the middle of the body.
	let stop = false;
	while (!stop && p.pos < p.n) {
		let d = p.code() - 48;
		if (d > 9)
			d = (d + 48 - 65 + 10) & 0x1f;
		if (d < 0 || d > radix) {
			stop = true;
		} else {
			value = value * radix + d;
			++p.pos;
		}
	}
	return value;
}
function getInt(p: StringParser, radix = 10): number {
	const sign = getSign(p);
	const pos = p.pos;
	const value = getUnsigned(p, radix);
	return p.pos === pos ? NaN : sign * value;
}


class NormalizedFloat {
	m: number;
	e: number;
	constructor(m: number) {
		let e = 0;
		if (m) {
			while (m >= 10) {
				m /= 10;
				e++;
			}
			while (m < 1) {
				m *= 10;
				e--;
			}
		}
		this.m = m;
		this.e = e;
	}
}

function UnsignedToString(n: number, radix = 10, digits = 1): string {
	let s = '';
	while (n > 0 || digits > 0) {
		digits--;
		const d = n % radix;
		s = String.fromCharCode(d < 10 ? 48 + d : 65 + d - 10) + s;
		n = Math.floor(n / radix);
	}
	return s;
}
function SignedToString(n: number, radix = 10): string {
	return (n < 0 ? '-' : '+') + UnsignedToString(Math.abs(n), radix);
}

function fracToString(f: number, digits: number): string {
	let fs = '';
	for (let i = 0; i < digits && f !== 0; i++) {
		f *= 10;
		const d: number = Math.floor(f);
		fs += String.fromCharCode(48 + d);
		f -= d;
	}
	return fs;
}

export class Number {
	// A real `f64` -- lets `towasm.ts`'s `ensureClass` read this class's own physical `this`-type
	// straight off the (stripped-of-casts) return expression's real type, same as every other class.
	constructor(value: number) {
		return value as unknown as Number;
	}

	static readonly EPSILON = 2.2204460492503130808472633361816e-16;
	static readonly MAX_SAFE_INTEGER: number = 9007199254740991;
	static readonly MIN_SAFE_INTEGER: number = -9007199254740991;

    static readonly MAX_VALUE	= 1.79E+308;
    static readonly MIN_VALUE	= 5.00E-324;
    static readonly NaN			= 0;
    static readonly NEGATIVE_INFINITY	= 0;
    static readonly POSITIVE_INFINITY	= 0;

	static isInteger(x: number): boolean		{ return x === Math.floor(x); }
	static isNaN(x: number): boolean			{ return x !== x; }
	static isSafeInteger(x: number): boolean	{ return Math.abs(x) < Number.MAX_SAFE_INTEGER; }
	static isFinite(x: number): boolean			{ return Math.abs(x) < Infinity; }

	static parseInt(s: string, radix = 10): number {
		return getInt(new StringParser(s), radix);
	}

	static parseFloat(str: string): number {
		const p = new StringParser(str);
		const sign = getSign(p);

		let exp		= 0;
		let pos		= p.pos;
		let value	= getUnsigned(p);
		if (p.pos === pos)
			return NaN;

		// fractional part
		if (p.skipCode(46)) {
			pos		= p.pos;
			value	= getUnsigned(p, 10, value);
			exp		= pos - p.pos;
		}

		const c = p.code();
		if (c === 101 || c === 69) { // 'e' or 'E'
			p.pos++;
			exp += getInt(p);
		}

		return sign * value * intPow(10, exp);
	}

	valueOf():	number { return this as unknown as number; }

	toString(radix = 10): string {
		let x = this as unknown as number;
		const sign = x < 0 ? '-' : '';
		x = Math.abs(x);

		// integer part
		const n = Math.floor(x);
		const s = sign + UnsignedToString(n, radix);

		// fractional part
		const frac = x - n;
		return frac ? s + '.' + fracToString(frac, 16) : s;
	}

	toFixed(digits: number): string {
		const x		= this as unknown as number;
		const sign	= x < 0 ? '-' : '';
		const scale	= intPow(10, digits);
		const n		= Math.floor(Math.abs(x) * scale + 0.5); // round
		const s		= sign + UnsignedToString(Math.floor(n / scale));
		return digits > 0 ? s + '.' + UnsignedToString(n % scale, 10, digits) : s;
	}
	toExponential(digits: number): string {
		const x		= this as unknown as number;
		const sign	= x < 0 ? '-' : '';
		const nf	= new NormalizedFloat(Math.abs(x));
		const m		= nf.m;
		const e		= nf.e;
		const scale	= intPow(10, digits);
		const n		= Math.floor(m * scale + 0.5);
		return sign + String.fromCharCode(48 + Math.floor(n / scale)) + (digits > 0 ? '.' + UnsignedToString(n % scale, 10, digits) : '') + 'e' + SignedToString(e);
	}
	toPrecision(precision: number): string {
		const x		= this as unknown as number;
		const sign	= x < 0 ? '-' : '';
		const nf	= new NormalizedFloat(Math.abs(x));
		const m		= nf.m;
		const e		= nf.e;
		const scale	= intPow(10, precision - 1);
		// `s[0]` (real indexing) isn't supported on `string` -- see `StringParser.peek`'s own comment.
		const rounded = UnsignedToString(Math.floor(m * scale + 0.5), 10, precision);
		const carried = rounded.length > precision;
		const e2	= carried ? e + 1 : e;
		const digits = carried ? rounded.slice(0, precision) : rounded;

		if (e2 < -6 || e2 >= precision) {
			const frac = precision > 1 ? '.' + digits.slice(1, precision) : '';
			return sign + digits.charAt(0) + frac + 'e' + SignedToString(e2);
		}
		if (e2 === precision - 1)
			return sign + digits;
		if (e2 >= 0)
			return sign + digits.slice(0, e2 + 1) + '.' + digits.slice(e2 + 1, precision);

		let zeros = '';
		for (let i = 0; i < -(e2 + 1); i++)
			zeros = zeros + '0';
		return sign + '0.' + zeros + digits;
	}
}

export class Math {
	static readonly E		= 2.718281828459045;
	static readonly LN10	= 2.302585092994046;
	static readonly LN2		= 0.6931471805599453;
	static readonly LOG2E	= 1.442695040888963;
	static readonly LOG10E	= 0.4342944819032521;
	static readonly PI		= 3.141592653589793;
	static readonly SQRT1_2	= 0.707106781186548;
	static readonly SQRT2	= 1.414213562373095;

	static readonly PI_2		= Math.PI / 2;

	private static seed = 123456789;

	static abs		= __asm<[number], number>('(switch $T (($f32 $f64) $T.abs))');
	static max		= __asm<[number, number], number>('(switch $T (($f32 $f64) $T.max))');
	static min		= __asm<[number, number], number>('(switch $T (($f32 $f64) $T.min))');
	static floor	= __asm<[number], number>('(switch $T (($f32 $f64) $T.floor))');
	static ceil		= __asm<[number], number>('(switch $T (($f32 $f64) $T.ceil))');
	static trunc	= __asm<[number], number>('(switch $T (($f32 $f64) $T.trunc))');
	static round	= __asm<[number], number>('(switch $T (($f32 $f64) $T.nearest))');
	static fround	= __asm<[f64], f32>('f32.demote_f64');
	static sqrt		= __asm<[number], number>('(switch $T (($f32 $f64) $T.sqrt))');
	static clz32	= __asm<[i32], i32>('i32.clz');

	// -----------------------------------------------------------------------------
	// fdlibm-style exp / log
	// -----------------------------------------------------------------------------
	
	static exp(x: number): number {
		if (x > 709.782712893384)
			return Infinity;
		if (x < -745.133219101941)
			return 0;
	
		// x = k*ln2 + r, |r| <= ln2/2 -- needs a real round-to-nearest: `|0` truncates toward zero, so for
		// negative x (e.g. x=-0.675) k came out 0 instead of -1, leaving |r| well outside the ln2/2 bound
		// the Taylor series below assumes (found via a direct sweep against real Math.exp).
		const k	= Math.round(x * Math.LOG2E);
		const r	= x - k * Math.LN2;
		const r2 = r * r;
		const p = 1 + r + r2 / 2 + r2 * r / 6 + r2 * r2 / 24 + r2 * r2 * r / 120;
		return p * intPow(2, k);
	}
	
	static log(x: number): number {
		// `Number.isNaN`/`x === Infinity` are checked explicitly: falling through to the ieeeSplit/ieeeFrom
		// bit-twiddling below for either would silently reconstruct a finite mantissa from NaN's or
		// Infinity's own all-1s exponent field, producing a large finite garbage value instead of NaN/Infinity.
		if (Number.isNaN(x))
			return NaN;
		if (x < 0)
			return NaN;
		if (x === 0)
			return -Infinity;
		if (x === Infinity)
			return Infinity;

		const i = ieeeSplit(x) as unknown as u32[];
		const e = (i[1] >>> 20) - 1023;
		const m = ieeeFrom(i[0], (i[1] & 0x000FFFFF) | 0x3FF00000);		// Normalize mantissa to [1,2)
	
		// ln(m) = 2*atanh(u), u = (m-1)/(m+1) in [0, 1/3) for m in [1,2) -- converges far faster than the
		// bare f - f^2/2 + f^3/3 series (f = m-1 ranges up to ~1, not small; that series was off by up to
		// ~2.7% relative, e.g. Math.log(100)).
		const u = (m - 1) / (m + 1);
		const u2 = u * u;
		const atanh_u = u * (1 + u2 * (1 / 3 + u2 * (1 / 5 + u2 * (1 / 7 + u2 / 9))));
		return e * Math.LN2 + 2 * atanh_u;
	}
	static log2(x: number): number  { return Math.log(x) * Math.LOG2E; }
	static log10(x: number): number { return Math.log(x) * Math.LOG10E; }

	static log1p(x: number): number {
		if (x <= -1)
			 return NaN;
		if (Math.abs(x) < 1e-4) {
			// series for small x
			const x2 = x * x;
			return x - x2 / 2 + (x2 * x) / 3;
		}
		return Math.log(1 + x);
	}
	
	static expm1(x: number): number {
		const ax = Math.abs(x);
		if (ax < 1e-5) {
			const x2 = x * x;
			return x + x2 / 2 + (x2 * x) / 6;
		}
		return Math.exp(x) - 1;
	}
	
	// -----------------------------------------------------------------------------
	// fdlibm-style trig: sin, cos, tan
	// -----------------------------------------------------------------------------
	
	static sin(x: number): number {
		if (!Number.isFinite(x))
			return NaN;
		const k = Math.round(x / Math.PI_2); // quadrant index
		const r = x - k * Math.PI_2;
		switch (k & 3) {
			default:
			case 0: return sin_core(r);
			case 1: return cos_core(r);
			case 2: return -sin_core(r);
			case 3: return -cos_core(r);
		}
	}
	
	static cos(x: number): number {
		if (!Number.isFinite(x))
			return NaN;
		const k = Math.round(x / Math.PI_2); // quadrant index
		const r = x - k * Math.PI_2;
		switch (k & 3) {
			default:
			case 0: return cos_core(r);
			case 1: return -sin_core(r);
			case 2: return -cos_core(r);
			case 3: return sin_core(r);
		}
	}
	
	static tan(x: number): number { return Math.sin(x) / Math.cos(x); }
	
	// -----------------------------------------------------------------------------
	// fdlibm-style inverse trig
	// -----------------------------------------------------------------------------
	
	static asin(x: number): number {
		if (x > 1 || x < -1)
			return NaN;

		const ax = Math.abs(x);
		if (ax > 0.5) {
			// t = cos(asin(ax)) = sqrt(1 - ax^2), not sqrt(1 - ax) -- the latter isn't even the right
			// identity (confirmed against a direct sweep: it was off by up to 13% around x=+-0.77).
			const t = Math.sqrt(1 - ax * ax);
			// asin(ax) = pi/2 - atan(t / ax): t/ax = cos(theta)/sin(theta) = cot(theta) = tan(pi/2-theta).
			const r = Math.PI_2 - Math.atan(t / ax);
			return x < 0 ? -r : r;
		}
	
		const x2 = ax * ax;
		const x3 = x2 * ax;
		const x5 = x3 * x2;
		const x7 = x5 * x2;
		const s = ax + x3 / 6 + 3 * x5 / 40 + 5 * x7 / 112;
		return x < 0 ? -s : s;
	}
	static acos(x: number): number  {
		return Math.PI_2 - Math.asin(x);
	}

	static atan(x: number): number {
		const ax = Math.abs(x);
		if (ax > 1) {
			const r = Math.PI_2 - Math.atan(1 / ax);
			return x < 0 ? -r : r;
		}
		if (ax > 0.5) {
			// atan(a) - atan(b) = atan((a-b)/(1+ab)) with b=1 -- atan(ax) = pi/4 + atan((ax-1)/(ax+1)),
			// which keeps atanPoly's argument within [-1/3, 0] instead of up to 1 (needs dozens of terms
			// to converge there, e.g. atan(1) via the bare series was off by ~14%).
			const t = (ax - 1) / (ax + 1);
			const r2 = Math.PI / 4 + atanPoly(t);
			return x < 0 ? -r2 : r2;
		}

		return atanPoly(x);
	}
	
	static atan2(y: number, x: number): number {
		if (Number.isNaN(x) || Number.isNaN(y))
			return NaN;
		return	x > 0 ? Math.atan(y / x)
			:	x < 0 ? (y >= 0 ? Math.atan(y / x) + Math.PI : Math.atan(y / x) - Math.PI)
			:	y > 0 ? Math.PI_2 : y < 0 ? -Math.PI_2 : 0;
	}
	
	// -----------------------------------------------------------------------------
	// fdlibm-style hyperbolic + inverses
	// -----------------------------------------------------------------------------
	
	static sinh(x: number): number { return (Math.exp(x) - Math.exp(-x)) / 2; };
	static cosh(x: number): number { return (Math.exp(x) + Math.exp(-x)) / 2; };
	
	static tanh(x: number): number {
		const er = Math.exp(x);
		const ei = Math.exp(-x);
		return (er - ei) / (er + ei);
	};
	
	static asinh(x: number): number { return Math.log(x + Math.sqrt(x * x + 1)); }
	static acosh(x: number): number { return x < 1 ? NaN : Math.log(x + Math.sqrt((x - 1) * (x + 1))); };
	static atanh(x: number): number { return x <= -1 || x >= 1 ? NaN : 0.5 * Math.log((1 + x) / (1 - x)); };
	
	static imul(x: number, y: number): number {
		const xl = x & 0xFFFF, xh = x >>> 16, yl = y & 0xFFFF, yh = y >>> 16;
		return (xl * yl + ((xl * yh + xh * yl) << 16)) | 0;
	}
	static sign(x: number): 	number { return x === 0 ? 0 : x > 0 ? 1 : -1; }

	static random(): number {
		Math.seed = (1664525 * Math.seed + 1013904223) >>> 0;
		return Math.seed / 0xFFFFFFFF;
	}
	static pow(x: number, y: number): number {
		// An integer exponent goes through `intPow`'s plain repeated-squaring multiplication instead of
		// `exp(log(x)*y)`: exact to floating-point rounding (vs. the transcendentals' ~1e-4 relative
		// error), and it already gets a negative base right on its own -- no separate sign-factoring
		// needed (`intPow(-2, 3) === -8`, `intPow(-2, 4) === 16`, `intPow(0, -3) === Infinity`, all via
		// plain multiplication, verified against real `Math.pow` directly).
		if (Number.isInteger(y))
			return intPow(x, y);
		// log(negative) is NaN, so a negative base only has a real result for an integer exponent.
		if (x < 0)
			return NaN;
		return Math.exp(Math.log(x) * y);
	}

	static hypot(...values: number[]): number {
		let total = 0;
		for (const v of values)
			total += v * v;
		return Math.sqrt(total);
	}
	static cbrt(x: number): number {
		return x < 0 ? -Math.pow(-x, 1 / 3) : Math.pow(x, 1 / 3);
	}

}
