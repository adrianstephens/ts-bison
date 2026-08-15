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
	constructor(str: string, pos: number = 0) {
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

	// @ts-ignore - tison extension: multiple constructor implementations
	constructor() {
		return String._alloc(0) as unknown as String;
	}
	// @ts-ignore - tison extension: multiple constructor implementations
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

	toString(): string { return this as unknown as string; }
	charAt		= __asm<[i32], string>('array.get_u $this array.new_fixed $this 1');
	charCodeAt	= __asm<[i32], i32>('array.get_u $this');

	get(i: i32): string {
		const result = String._alloc(1);
		const v = __asm<[i32], u32>('array.get $this')(i);
		__asm<[i32, u32], void>('array.set $this')(0, v);
		return result;
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
	slice(start: i32 = 0, end: i32 = 0x7fffffff): string {
		const len = this.length;
		start	= start < 0 ? start + len : start;
		end		= end < 0 ? end + len : end > len ? len : end;
		const rlen = end - start;
		const result = String._alloc(rlen);
		String._copy(result, 0, this as unknown as string, start, rlen);
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
	// `$1`.."$9"/`$&`/`$$` substitution (see regexp.ts's `expandReplacement`) -- the function-replacer
	// overload real JS also has is out of scope. Honors `g` (all matches) vs first-only.
	replace(regexp: RegExp, replacement: string): string {
		const s: string = this as unknown as string;
		let result: string = '';
		let last: number = 0;
		let go: boolean = true;
		regexp.lastIndex = 0;
		while (go) {
			const m: RegExpMatch | null = regexp.exec(s);
			if (m === null) {
				go = false;
			} else {
				result = result.concat(s.slice(last, m.index)).concat(expandReplacement(replacement, m));
				last = m.groupEnd(0);
				if (!regexp.global) go = false;
			}
		}
		return result.concat(s.slice(last, s.length));
	}
	// Capture groups aren't interleaved into the result (unlike real JS's `split(/(\d)/)`) -- explicit
	// scope simplification (see StringParts's own comment), not an oversight.
	split(separator: RegExp, limit: i32 = 0x7fffffff): string[] {
		const s: string = this as unknown as string;
		const result: string[] = [];
		let last = 0;
		let pos = 0;
		while (pos <= s.length && result.length < limit) {
			// `execFrom`, not `exec` -- split scans the whole string regardless of `separator`'s own
			// `g`/`lastIndex` state (real JS split() ignores them the same way).
			const m: RegExpMatch | null = separator.execFrom(s, pos);
			if (m === null) {
				result.push(this.substring(pos));
				break;
			}
			const ms = m.groupStart(0);
			const me = m.groupEnd(0);
			if (ms >= s.length)
				break;
			if (me === ms) {
				pos = pos + 1;
			} else {
				result.push(s.substring(ms, me));
				last = me;
				pos = me;
			}
		}
		return result;
	}

	substring(start: i32, end: i32 = 0x7fffffff): string {
		return this.slice(start, end);
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
