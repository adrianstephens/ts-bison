/// <reference path="./lib.d.ts" />
import { RegExp, RegExpMatch, expandReplacement } from './regexp';

//-----------------------------------------------------------------------------
//	String
//-----------------------------------------------------------------------------

export function strIsSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 10 || code === 13;
}

export class StringParser {
	str: string;
	pos: number;
	n: number;
	constructor(str: string, pos = 0) {
		this.str = str;
		this.pos = pos;
		this.n = str.length;
	}

	remaining(): number { return this.n - this.pos; }
	remainder(): string { return this.str.slice(this.pos); }
	processed(): string { return this.str.slice(0, this.pos); }

	code(): number { return this.pos < this.n ? this.str.charCodeAt(this.pos) : 0; }
	skipCode(c: number): boolean {
		if (this.code() === c) {
			++this.pos;
			return true;
		}
		return false;
	}
	skipWhitespace(): void {
		while (this.pos < this.n && strIsSpace(this.code()))
			++this.pos;
	}
}

export function stringTemplate(strings: string[], ...values: any[]): string {
	const n: number = values.length;
	let result: string = strings[0];
	for (let i = 0; i < n; ++i)
		result = result.concat(values[i].toString()).concat(strings[i + 1]);
	return result;
}

export class String {
	get length(): number { return __asm<[], u32>('array.len')(); }

	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor() {
		return String._alloc(0) as unknown as String;
	}
	// @ts-expect-error - tison extension: multiple constructor implementations
	constructor(s: any) {
		return s.toString();
	}

	private static _alloc	= __asm<[i32], string>('array.new_default $this');
	private static _setChar	= __asm<[string, i32, i32], void>('array.set $this');
	private static _copy	= __asm<[string, i32, string, i32, i32], void>('array.copy $this $this');

	static fromCharCode(c: number): string {
		const result = String._alloc(1);
		String._setChar(result, 0, c);
		return result;
	}
	// One `array.new_default` up front, then a straight fill -- the point is precisely to avoid
	// `concat`'s per-call fresh-array-and-copy-both-sides cost when a caller has `len` bytes in hand.
	static fromCharCodesAt(ptr: i32, len: i32): string {
		const result = String._alloc(len);
		for (let i = 0; i < len; i++)
			String._setChar(result, i, __asm<[i32], i32>('i32.load8_u')(ptr + i));
		return result;
	}

	toString(): string { return this as unknown as string; }
	charCodeAt	= __asm<[i32], i32>('array.get_u $this');

	// Out of range is `''`, not a trap -- so this cannot be the bare `array.get_u`/`array.new_fixed` pair
	// it used to be. `charCodeAt` stays raw: every caller in this file guards its own index.
	charAt(pos: i32): string {
		return pos < 0 || pos >= this.length ? '' : String.fromCharCode(this.charCodeAt(pos));
	}
	// `s[i]`. Was its own asm pair that read with `array.get` (illegal on a packed `i16` array -- V8
	// rejected the whole module) and then wrote through `$this`, i.e. into the receiver rather than the
	// fresh one-character result.
	get(i: i32): string {
		return this.charAt(i);
	}

	indexOf(needle: string): number {
		const n= this.length;
		const m = needle.length;
		for (let i = 0; i <= n - m; i++) {
			let j = 0;
			while (j < m && this.charCodeAt(i + j) === needle.charCodeAt(j))
				j++;
			if (j === m)
				return i;
		}
		return -1;
	}
	lastIndexOf(needle: string): number {
		const n = this.length;
		const m = needle.length;
		for (let i = n - m; i >= 0; --i) {
			let j = 0;
			while (j < m && this.charCodeAt(i + j) === needle.charCodeAt(j))
				j++;
			if (j === m)
				return i;
		}
		return -1;
	}
	includes(needle: string): boolean {
		return this.indexOf(needle) !== -1;
	}
	startsWith(prefix: string): boolean {
		const m = prefix.length;
		if (m > this.length)
			return false;
		for (let j = 0; j < m; j++) {
			if (this.charCodeAt(j) !== prefix.charCodeAt(j))
				return false;
		}
		return true;
	}
	endsWith(suffix: string): boolean {
		const m = suffix.length;
		const n = this.length;
		if (m > n)
			return false;
		const offset = n - m;
		for (let j = 0; j < m; ++j) {
			if (this.charCodeAt(offset + j) !== suffix.charCodeAt(j))
				return false;
		}
		return true;
	}
	// CLAMPED at both ends, and a reversed or out-of-range range is empty: `rlen` could otherwise go
	// negative (`slice(3, 1)`, `slice(9)`) and reach `_alloc` as a huge unsigned length -- "requested new
	// array is too large" -- where JS simply gives `''`.
	slice(start: i32 = 0, end: i32 = 0x7fffffff): string {
		const len = this.length;
		let from	= start < 0 ? len + start : start;
		let to		= end < 0 ? len + end : end;
		from	= from < 0 ? 0 : from > len ? len : from;
		to		= to < 0 ? 0 : to > len ? len : to;
		const rlen = to > from ? to - from : 0;
		const result = String._alloc(rlen);
		String._copy(result, 0, this as unknown as string, from, rlen);
		return result;
	}
	trim(): string {
		const len = this.length;
		let start = 0;
		while (start < len && strIsSpace(this.charCodeAt(start)))
			start++;
		let end = len;
		while (end > start && strIsSpace(this.charCodeAt(end - 1)))
			end--;
		return this.slice(start, end);
	}
	toUpperCase(): string {
		const n = this.length;
		const result = String._alloc(n);
		for (let i = 0; i < n; i++) {
			const code = this.charCodeAt(i);
			String._setChar(result, i, (code >= 97 && code <= 122) ? code - 32 : code);
		}
		return result;
	}
	toLowerCase(): string {
		const n = this.length;
		const result = String._alloc(n);
		for (let i = 0; i < n; i++) {
			const code = this.charCodeAt(i);
			String._setChar(result, i, (code >= 65 && code <= 90) ? code + 32 : code);
		}
		return result;
	}
	// No locale support exists in this runtime, so the locale-aware forms ARE the plain ones -- an alias
	// is the honest implementation, not a stub. Declared without a `locales` parameter for the same
	// reason: taking one and ignoring it would be a lie the signature tells.
	toLocaleUpperCase(): string { return this.toUpperCase(); }
	toLocaleLowerCase(): string { return this.toLowerCase(); }
	valueOf(): string { return this as unknown as string; }

	repeat(count: i32): string {
		const len = this.length;
		const result = String._alloc(len * count);
		for (let i = 0; i < count; i++)
			String._copy(result, i * len, this as unknown as string, 0, len);
		return result;
	}
	concat(b: string): string {
		const result = String._alloc(this.length + b.length);
		String._copy(result, 0, this as unknown as string, 0, this.length);
		String._copy(result, this.length, b, 0, b.length);
		return result;
	}

	match(regexp: RegExp): RegExpMatch | null {
		return regexp.exec(this as unknown as string);
	}
	search(regexp: RegExp): number {
		const s: string = this as unknown as string;
		const m: RegExpMatch | null = regexp.exec(s);
		return m === null ? -1 : m.index;
	}
	// `$1`.."$9"/`$&`/`$$` substitution (see regexp.ts's `expandReplacement`), or the FUNCTION replacer,
	// which real JS calls as `(match, ...captures, offset, input)`. Honors `g` (all matches) vs first-only.
	replace(regexp: RegExp, replacement: string | ((substring: string, ...args: any[]) => string)): string {
		const s: string = this as unknown as string;
		let result = '';
		let last = 0;
		let go = true;
		regexp.lastIndex = 0;
		while (go) {
			const m: RegExpMatch | null = regexp.exec(s);
			if (m === null) {
				go = false;
			} else {
				let piece = '';
				if (typeof replacement === 'string') {
					piece = expandReplacement(replacement, m);
				} else {
					// A group that did not participate is `undefined` in real JS, not the empty string
					// `group` itself returns -- callers routinely test the arguments with `!== undefined`.
					const args: any[] = [];
					for (let i = 1; i < m.length; i++)
						args.push(m.groupStart(i) === -1 ? undefined : m.group(i));
					args.push(m.index);
					args.push(s);
					piece = replacement(m.group(0), ...args);
				}
				result = result.concat(s.slice(last, m.index)).concat(piece);
				last = m.groupEnd(0);
				if (!regexp.global)
					go = false;
			}
		}
		return result.concat(s.slice(last, s.length));
	}
	// Capture groups aren't interleaved into the result (unlike real JS's `split(/(\d)/)`) -- explicit
	// scope simplification (see StringParts's own comment), not an oversight.
	// ES `SplitMatcher`, which is not "find the next separator": the separator must match starting
	// EXACTLY at the cursor, and an empty match at the previous split point never splits again. The old
	// loop pushed each SEPARATOR match instead of the text between them, so `'a,b,c'.split(/,/)` was
	// `[',', ',', 'c']` -- with the right length, which is why only a value comparison caught it.
	// `string | RegExp`, narrowed by `typeof`: lib.d.ts always declared the union, but only the RegExp
	// half existed, so `'a.b'.split('.')` type-checked and then failed codegen converting the string to
	// a `RegExp`.
	split(separator: string | RegExp, limit: i32 = 0x7fffffff): string[] {
		const s: string = this as unknown as string;
		const result: string[] = [];
		const size = s.length;
		if (limit === 0)
			return result;
		if (typeof separator === 'string') {
			const sep: string = separator;
			const m = sep.length;
			// An empty subject splits to `[]` only when the separator matches it -- i.e. is itself empty.
			if (size === 0) {
				if (m !== 0)
					result.push(s);
				return result;
			}
			// An empty separator splits into single characters; the general scan below would match at
			// every position and make no progress.
			if (m === 0) {
				for (let i = 0; i < size; i++) {
					result.push(s.slice(i, i + 1));
					if (result.length >= limit)
						return result;
				}
				return result;
			}
			let p = 0;
			let q = 0;
			while (q + m <= size) {
				let j = 0;
				while (j < m && s.charCodeAt(q + j) === sep.charCodeAt(j))
					j++;
				if (j === m) {
					result.push(s.slice(p, q));
					if (result.length >= limit)
						return result;
					q = q + m;
					p = q;
				} else {
					q = q + 1;
				}
			}
			result.push(s.slice(p, size));
			return result;
		}
		// An empty subject is `[]` when the separator matches it, `['']` otherwise.
		if (size === 0) {
			// `execFrom`, not `exec` -- split scans regardless of `separator`'s own `g`/`lastIndex`
			// state, the same way real JS split() ignores them.
			if (separator.execFrom(s, 0) === null)
				result.push(s);
			return result;
		}
		let p = 0;
		let q = 0;
		while (q < size) {
			const m: RegExpMatch | null = separator.execFrom(s, q);
			if (m === null || m.groupStart(0) !== q) {
				q = q + 1;
				continue;
			}
			const e = m.groupEnd(0);
			if (e === p) {
				q = q + 1;
				continue;
			}
			result.push(s.slice(p, q));
			if (result.length >= limit)
				return result;
			p = e;
			q = p;
		}
		result.push(s.slice(p));
		return result;
	}

	// NOT `slice`: `substring` clamps a negative (or NaN) argument to 0 rather than counting from the
	// end, and SWAPS the two when `start > end`.
	substring(start: i32, end: i32 = 0x7fffffff): string {
		const len = this.length;
		let from	= start < 0 ? 0 : start > len ? len : start;
		let to		= end < 0 ? 0 : end > len ? len : end;
		if (from > to) {
			const t = from;
			from = to;
			to = t;
		}
		const result = String._alloc(to - from);
		String._copy(result, 0, this as unknown as string, from, to - from);
		return result;
	}

	add(b: string) { return this.concat(b); }
	compare(b: string): number {
		const len = Math.min(this.length, b.length);
		for (let i = 0; i < len; i++) {
			const d = this.charCodeAt(i) - b.charCodeAt(i);
			if (d)
				return d;
		}
		return this.length - b.length;
	}
	lt(b: string): boolean { return this.compare(b) < 0; }
	gt(b: string): boolean { return this.compare(b) > 0; }
	le(b: string): boolean { return this.compare(b) <= 0; }
	ge(b: string): boolean { return this.compare(b) >= 0; }
	eq(b: string): boolean { return this.compare(b) === 0; }
	ne(b: string): boolean { return this.compare(b) !== 0; }
}
