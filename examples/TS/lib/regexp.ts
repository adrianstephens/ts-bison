/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	RegExp -- a JS-compatible "core" regex engine: literals, `.`, character classes
//	(negation/ranges), \d\D\w\W\s\S, anchors ^$, greedy/lazy quantifiers * + ? {n,m},
//	capturing/non-capturing groups, alternation, backreferences \1-\9, flags g i m.
//	Not supported (documented scope, not silently wrong): lookahead/lookbehind, named
//	groups, unicode property escapes, u/v/y/s flags, multi-digit backreferences,
//	escaped range bounds in a class (e.g. `[\--/]`), \D\W\S *inside* a class.
//
//	Compiled to a flat variable-width Int32Array bytecode program (classic Pike/Cox-style
//	regex bytecode: CHAR/ANY/CLASS/SAVE/JMP/SPLIT/BACKREF/BOL/EOL/WORDB/NWORDB/SPACE/
//	NSPACE/MATCH/FAIL) and executed by an iterative backtracking VM with an explicit,
//	growable backtrack stack -- no native recursion, no closures, no exceptions, matching
//	this TS subset's hard restrictions (see towasm.ts's own header comment).
//
//	A zero-width-repeatable subpattern (e.g. `(a?)*`) can loop forever -- same known
//	limitation many minimal backtracking engines accept; not guarded against here.
//-----------------------------------------------------------------------------

function isWordChar(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}
function swapCase(code: number): number {
	if (code >= 65 && code <= 90)
		return code + 32;
	if (code >= 97 && code <= 122)
		return code - 32;
	return code;
}

function hasFlag(flags: string, code: number): boolean {
	let i: number = 0;
	while (i < flags.length) {
		if (flags.charCodeAt(i) === code) return true;
		i = i + 1;
	}
	return false;
}

// Shared by RegExpCompiler.ensure (program buffer) and RegExp.pushFrame (backtrack stack) --
// both need "allocate bigger, copy elementwise, reassign" over an Int32Array, same idiom
// array.ts's Array<T>.push already uses for its own growth, just hand-rolled here since a
// private static helper on one class isn't visible to the other.
export function growInt32(a: Int32Array): Int32Array {
	const bigger = new Int32Array(a.length * 2);
	let i: number = 0;
	while (i < a.length) {
		bigger[i] = a[i];
		i = i + 1;
	}
	return bigger;
}

//-----------------------------------------------------------------------------
//	Compiler -- pattern string -> bytecode. A separate class (not methods on RegExp
//	itself): RegExp has object-typed fields, so its own constructor can't call instance
//	methods on its not-yet-fully-built `this` (see towasm.ts's field-collecting-ctor
//	comment) -- compiling happens on this already-fully-constructed helper instead,
//	invoked from the top-level `compilePattern`, then RegExp's ctor just copies the
//	finished fields over.
//-----------------------------------------------------------------------------

// Opcodes: duplicated as `static readonly` fields on *both* RegExpCompiler and RegExp, not
// shared top-level consts. Top-level consts in a lib file resolve via towasm.ts's
// `ensureGlobal`, which registers a wasm global with the right type but never bakes in the
// initializer value -- every reference silently read back `0` at runtime (confirmed the hard
// way: every opcode misread as OP_MATCH=0). `static readonly` is a real, documented
// compile-time-inlined constant instead, just cross-class access isn't resolvable (confirmed
// separately: "unknown field" reading RegExpCompiler.OP_X from RegExp's own methods) -- hence
// two small identical copies rather than one shared source, the least-broken option found.
class RegExpCompiler {
	static readonly OP_MATCH:	number = 0;
	static readonly OP_CHAR:	number = 1;
	static readonly OP_ANY:		number = 2;
	static readonly OP_CLASS:	number = 3;
	static readonly OP_SAVE:	number = 4;
	static readonly OP_JMP:		number = 5;
	static readonly OP_SPLIT:	number = 6;
	static readonly OP_BACKREF:	number = 7;
	static readonly OP_BOL:		number = 8;
	static readonly OP_EOL:		number = 9;
	static readonly OP_WORDB:	number = 10;
	static readonly OP_NWORDB:	number = 11;
	static readonly OP_FAIL:	number = 12;
	static readonly OP_SPACE:	number = 13;
	static readonly OP_NSPACE:	number = 14;

	pat:		string;
	pos:		number;
	nextGroup:	number;
	failed:		boolean;
	braceMin:	number;
	braceMax:	number;
	groupCount:	number;
	prog:		Int32Array;
	progLen:	number;

	constructor(pattern: string) {
		this.pat		= pattern;
		this.pos		= 0;
		this.nextGroup	= 1;
		this.failed		= false;
		this.braceMin	= 0;
		this.braceMax	= 0;
		this.groupCount	= 0;
		this.prog		= new Int32Array(16);
		this.progLen	= 0;
	}

	run(): void {
		this.emit2(RegExpCompiler.OP_SAVE, 0);
		this.parseDisjunction();
		if (!this.failed && this.pos !== this.pat.length)
			this.failed = true;
		this.emit2(RegExpCompiler.OP_SAVE, 1);
		this.emit1(RegExpCompiler.OP_MATCH);
		this.groupCount = this.nextGroup - 1;
		if (this.failed) {
			this.prog = new Int32Array(1);
			this.prog[0] = RegExpCompiler.OP_FAIL;
			this.progLen = 1;
			this.groupCount = 0;
		}
	}

	private charAt(i: number): number {
		return i < this.pat.length ? this.pat.charCodeAt(i) : -1;
	}

	private ensure(n: number): void {
		while (this.progLen + n > this.prog.length)
			this.prog = growInt32(this.prog);
	}
	private appendWord(v: number): number {
		this.ensure(1);
		const p: number = this.progLen;
		this.prog[p] = v;
		this.progLen = p + 1;
		return p;
	}
	private emit1(op: number): number {
		return this.appendWord(op);
	}
	private emit2(op: number, a: number): number {
		const p: number = this.appendWord(op);
		this.appendWord(a);
		return p;
	}
	private emit3(op: number, a: number, b: number): number {
		const p: number = this.appendWord(op);
		this.appendWord(a);
		this.appendWord(b);
		return p;
	}
	private appendRange(lo: number, hi: number): void {
		this.appendWord(lo);
		this.appendWord(hi);
	}
	private emitClassHeader(negate: boolean, n: number): number {
		return this.emit3(RegExpCompiler.OP_CLASS, negate ? 1 : 0, n);
	}
	private emitWordClass(negate: boolean): void {
		this.emitClassHeader(negate, 4);
		this.appendRange(48, 57);
		this.appendRange(65, 90);
		this.appendRange(97, 122);
		this.appendRange(95, 95);
	}
	private patchWord(pos: number, v: number): void {
		this.prog[pos] = v;
	}

	//-- lexical-only skip helpers (no emission) -- used to look past one atom/alternative to
	//	find a following quantifier/'|' without needing to undo any emitted bytecode.
	private skipClass(): void {
		this.pos = this.pos + 1; // consume '['
		if (this.charAt(this.pos) === 94)
			this.pos = this.pos + 1;
		while (true) {
			const d: number = this.charAt(this.pos);
			if (d === -1) { this.failed = true; return; }
			if (d === 92) { this.pos = this.pos + 2; continue; }
			if (d === 93) { this.pos = this.pos + 1; return; }
			this.pos = this.pos + 1;
		}
	}
	private skipOneAtom(): void {
		const c: number = this.charAt(this.pos);
		if (c === -1) { this.failed = true; return; }
		if (c === 40) {
			let depth: number = 1;
			this.pos = this.pos + 1;
			while (depth > 0) {
				const d: number = this.charAt(this.pos);
				if (d === -1) { this.failed = true; return; }
				if (d === 92) { this.pos = this.pos + 2; continue; }
				if (d === 91) { this.skipClass(); continue; }
				if (d === 40) depth = depth + 1;
				else if (d === 41) depth = depth - 1;
				this.pos = this.pos + 1;
			}
		} else if (c === 91) {
			this.skipClass();
		} else if (c === 92) {
			this.pos = this.pos + 2;
		} else {
			this.pos = this.pos + 1;
		}
	}
	private tryParseBraceAt(p: number): number {
		let i: number = p + 1;
		let min: number = 0;
		let sawDigit: boolean = false;
		while (this.charAt(i) >= 48 && this.charAt(i) <= 57) {
			min = min * 10 + (this.charAt(i) - 48);
			i = i + 1;
			sawDigit = true;
		}
		if (!sawDigit)
			return -1;
		if (this.charAt(i) === 125) {
			this.braceMin = min;
			this.braceMax = min;
			return i + 1;
		}
		if (this.charAt(i) !== 44)
			return -1;
		i = i + 1;
		if (this.charAt(i) === 125) {
			this.braceMin = min;
			this.braceMax = -1;
			return i + 1;
		}
		let max: number = 0;
		let sawDigit2: boolean = false;
		while (this.charAt(i) >= 48 && this.charAt(i) <= 57) {
			max = max * 10 + (this.charAt(i) - 48);
			i = i + 1;
			sawDigit2 = true;
		}
		if (!sawDigit2 || this.charAt(i) !== 125)
			return -1;
		this.braceMin = min;
		this.braceMax = max;
		return i + 1;
	}
	private skipQuantifierSuffix(): void {
		const c: number = this.charAt(this.pos);
		if (c === 63 || c === 42 || c === 43) {
			if (this.charAt(++this.pos) === 63)
				++this.pos;
			return;
		}
		if (c === 123) {
			const end: number = this.tryParseBraceAt(this.pos);
			if (end !== -1) {
				this.pos = end;
				if (this.charAt(this.pos) === 63)
					++this.pos;
			}
		}
	}
	private skipAlternative(): void {
		while (true) {
			const c: number = this.charAt(this.pos);
			if (c === -1 || c === 124 || c === 41)
				return;
			this.skipOneAtom();
			if (this.failed)
				return;
			this.skipQuantifierSuffix();
		}
	}

	//-- real (emitting) grammar --
	parseDisjunction(): void {
		if (this.failed)
			return;
		const altPos: number = this.pos;
		this.skipAlternative();
		if (this.failed)
			return;
		const hasAlt: boolean = this.charAt(this.pos) === 124;
		this.pos = altPos;
		if (!hasAlt) {
			this.parseAlternative();
			return;
		}
		const splitPos: number = this.emit3(RegExpCompiler.OP_SPLIT, -1, -1);
		const l1: number = this.progLen;
		this.parseAlternative();
		const jmpPos: number = this.emit2(RegExpCompiler.OP_JMP, -1);
		const l2: number = this.progLen;
		this.pos = this.pos + 1; // consume '|'
		this.parseDisjunction();
		const l3: number = this.progLen;
		this.patchWord(splitPos + 1, l1);
		this.patchWord(splitPos + 2, l2);
		this.patchWord(jmpPos + 1, l3);
	}
	private parseAlternative(): void {
		while (true) {
			if (this.failed)
				return;
			const c: number = this.charAt(this.pos);
			if (c === -1 || c === 124 || c === 41)
				return;
			this.parseTerm();
		}
	}
	private parseTerm(): void {
		if (this.failed)
			return;
		const atomPos: number = this.pos;
		this.skipOneAtom();
		if (this.failed)
			return;
		const afterAtom: number = this.pos;
		const qc: number = this.charAt(afterAtom);
		let kind: number = 0; // 0 none, 1 '?', 2 '*', 3 '+', 4 '{n,m}'
		let quantEnd: number = afterAtom;
		switch (qc) {
			case 63: kind = 1; quantEnd = afterAtom + 1; break;
			case 42: kind = 2; quantEnd = afterAtom + 1; break;
			case 43: kind = 3; quantEnd = afterAtom + 1; break;
			case 123: {
				const end: number = this.tryParseBraceAt(afterAtom);
				if (end !== -1) {
					kind = 4;
					quantEnd = end;
				}
				break;
			}
		}
		let lazy = kind !== 0 && this.charAt(quantEnd) === 63;
		if (lazy)
			++quantEnd;

		const groupBase: number = this.nextGroup;
		switch (kind) {
			case 0:
				this.pos = atomPos;
				this.parseAtom();
				return;
			case 1:
				this.emitOptional(atomPos, groupBase, lazy);
				this.pos = quantEnd;
				return;
			case 2:
				this.emitStarLoop(atomPos, groupBase, lazy);
				this.pos = quantEnd;
				return;
			case 3:
				this.emitPlusLoop(atomPos, groupBase, lazy);
				this.pos = quantEnd;
				return;
			case 4: {
				const min: number = this.braceMin;
				const max: number = this.braceMax;
				let i: number = 0;
				while (i < min) {
					this.pos = atomPos;
					this.nextGroup = groupBase;
					this.parseAtom();
					i = i + 1;
				}
				if (max === -1) {
					this.emitStarLoop(atomPos, groupBase, lazy);
				} else {
					let j: number = min;
					while (j < max) {
						this.emitOptional(atomPos, groupBase, lazy);
						j = j + 1;
					}
				}
				this.pos = quantEnd;
				return;
			}
		}
	}
	private emitOptional(atomPos: number, groupBase: number, lazy: boolean): void {
		this.pos = atomPos;
		this.nextGroup = groupBase;
		const splitPos: number = this.emit3(RegExpCompiler.OP_SPLIT, -1, -1);
		const enterAddr: number = this.progLen;
		this.parseAtom();
		const exitAddr: number = this.progLen;
		if (lazy) {
			this.patchWord(splitPos + 1, exitAddr);
			this.patchWord(splitPos + 2, enterAddr);
		} else {
			this.patchWord(splitPos + 1, enterAddr);
			this.patchWord(splitPos + 2, exitAddr);
		}
	}
	private emitPlusLoop(atomPos: number, groupBase: number, lazy: boolean): void {
		this.pos = atomPos;
		this.nextGroup = groupBase;
		const enterAddr: number = this.progLen;
		this.parseAtom();
		const splitPos: number = this.emit3(RegExpCompiler.OP_SPLIT, -1, -1);
		const exitAddr: number = this.progLen;
		if (lazy) {
			this.patchWord(splitPos + 1, exitAddr);
			this.patchWord(splitPos + 2, enterAddr);
		} else {
			this.patchWord(splitPos + 1, enterAddr);
			this.patchWord(splitPos + 2, exitAddr);
		}
	}
	private emitStarLoop(atomPos: number, groupBase: number, lazy: boolean): void {
		const splitPos: number = this.emit3(RegExpCompiler.OP_SPLIT, -1, -1);
		const enterAddr: number = this.progLen;
		this.pos = atomPos;
		this.nextGroup = groupBase;
		this.parseAtom();
		this.emit2(RegExpCompiler.OP_JMP, splitPos);
		const exitAddr: number = this.progLen;
		if (lazy) {
			this.patchWord(splitPos + 1, exitAddr);
			this.patchWord(splitPos + 2, enterAddr);
		} else {
			this.patchWord(splitPos + 1, enterAddr);
			this.patchWord(splitPos + 2, exitAddr);
		}
	}

	private parseAtom(): void {
		if (this.failed)
			return;
		const c: number = this.charAt(this.pos++);
		switch (c) {
			case 40: this.parseGroup(); return;
			case 91: this.parseClass(); return;
			case 46: this.emit1(RegExpCompiler.OP_ANY); return;
			case 94: this.emit1(RegExpCompiler.OP_BOL); return;
			case 36: this.emit1(RegExpCompiler.OP_EOL); return;
			case 92: this.parseEscape(); return;
			case -1: case 124: case 41:
				this.failed = true;
				--this.pos;
				return;
			default:
				this.emit2(RegExpCompiler.OP_CHAR, c);
		}
	}
	private parseGroup(): void {
		let capturing: boolean = true;
		if (this.charAt(this.pos) === 63) {
			const k: number = this.charAt(this.pos + 1);
			if (k === 58) {
				capturing = false;
				this.pos = this.pos + 2;
			}
			else { this.failed = true; return; } // '?=' '?!' '?<' -- lookaround/named groups, out of scope
		}
		let idx: number = 0;
		if (capturing) {
			idx = this.nextGroup;
			this.nextGroup = this.nextGroup + 1;
			this.emit2(RegExpCompiler.OP_SAVE, idx * 2);
		}
		this.parseDisjunction();
		if (this.failed)
			return;
		if (this.charAt(this.pos) !== 41) {
			this.failed = true;
			return;
		}
		++this.pos; // consume ')'
		if (capturing)
			this.emit2(RegExpCompiler.OP_SAVE, idx * 2 + 1);
	}
	private parseEscape(): void {
		let c: number = this.charAt(this.pos++);
		switch (c) {
			case -1:	--this.pos; this.failed = true; return;
			case 100: 	this.emitClassHeader(false, 1); this.appendRange(48, 57); return;			// \d
			case 68: 	this.emitClassHeader(true, 1); this.appendRange(48, 57); return;			// \D
			case 119: 	this.emitWordClass(false); return;				// \w
			case 87: 	this.emitWordClass(true); return;				// \W
			case 115: 	this.emit1(RegExpCompiler.OP_SPACE); return;	// \s
			case 83: 	this.emit1(RegExpCompiler.OP_NSPACE); return;	// \S
			case 98: 	this.emit1(RegExpCompiler.OP_WORDB); return;	// \b
			case 66: 	this.emit1(RegExpCompiler.OP_NWORDB); return;	// \B
			case 110: 	c = 10;	break;									// \n
			case 114: 	c = 13;	break;									// \r
			case 116: 	c = 9;	break;									// \t
			case 102: 	c = 12;	break;									// \f
			case 118: 	c = 11;	break;									// \v
			case 48:  	c = 0;	break;									// \0
		}
		if (c >= 49 && c <= 57)
			this.emit2(RegExpCompiler.OP_BACKREF, c - 48);				// \1-\9
		else
			this.emit2(RegExpCompiler.OP_CHAR, c);
	}
	private parseClassEscapeRanges(): void {
		let c: number = this.charAt(this.pos++);
		switch (c) {
			case -1: --this.pos; this.failed = true; return;
			case 100:		// \d
				this.appendRange(48, 57);
				return;
			case 119:		// \w
				this.appendRange(48, 57);
				this.appendRange(65, 90);
				this.appendRange(97, 122);
				this.appendRange(95, 95);
				return;
			case 115:		// \s
				this.appendRange(9, 9);
				this.appendRange(10, 10);
				this.appendRange(13, 13);
				this.appendRange(32, 32);
				return;
			case 68: case 87: case 83: // \D \W \S -- unsupported inside a class
				this.failed = true;
				return;
			case 110:	c = 10;	break;
			case 114:	c = 13;	break;
			case 116:	c = 9;	break;
			case 102:	c = 12;	break;
			case 118:	c = 11;	break;
			case 48:	c = 0;	break;
		}
		this.appendRange(c, c);
	}
	private parseClass(): void {
		let negate = this.charAt(this.pos) === 94;
		if (negate)
			++this.pos;
		const headerPos = this.emitClassHeader(negate, 0);
		let first: boolean = true;
		while (true) {
			const c: number = this.charAt(this.pos++);
			if (c === -1) { this.failed = true; --this.pos; return; }
			if (c === 93 && !first) break;
			first = false;
			if (c === 92) {
				this.parseClassEscapeRanges();
				if (this.failed)
					return;
			} else {
				let lo: number = c;
				let hi: number = c;
				if (this.charAt(this.pos) === 45 && this.charAt(this.pos + 1) !== 93 && this.charAt(this.pos + 1) !== -1) {
					++this.pos;
					const hc: number = this.charAt(this.pos);
					if (hc === 92) { // escaped range bound -- unsupported
						this.failed = true;
						return;
					}
					hi = hc;
					++this.pos;
				}
				this.appendRange(lo, hi);
			}
		}
		this.patchWord(headerPos + 2, (this.progLen - headerPos - 3) / 2);
	}
}

function compilePattern(pattern: string): RegExpCompiler {
	const c = new RegExpCompiler(pattern);
	c.run();
	return c;
}

//-----------------------------------------------------------------------------
//	RegExp / RegExpMatch
//-----------------------------------------------------------------------------

export class RegExp {
	// Duplicated from RegExpCompiler -- see that class's own header comment for why (cross-class
	// static access to RegExpCompiler.OP_X isn't resolvable, and a shared top-level const silently
	// reads back 0 at runtime).
	static readonly OP_MATCH: 	number = 0;
	static readonly OP_CHAR: 	number = 1;
	static readonly OP_ANY: 	number = 2;
	static readonly OP_CLASS: 	number = 3;
	static readonly OP_SAVE: 	number = 4;
	static readonly OP_JMP: 	number = 5;
	static readonly OP_SPLIT: 	number = 6;
	static readonly OP_BACKREF: number = 7;
	static readonly OP_BOL: 	number = 8;
	static readonly OP_EOL: 	number = 9;
	static readonly OP_WORDB: 	number = 10;
	static readonly OP_NWORDB: 	number = 11;
	static readonly OP_FAIL: 	number = 12;
	static readonly OP_SPACE: 	number = 13;
	static readonly OP_NSPACE: 	number = 14;

	source: 	string;
	global: 	boolean;
	ignoreCase: boolean;
	multiline: 	boolean;
	lastIndex: 	number;

	private compiled: 	RegExpCompiler;
	private groups: 	Int32Array;
	private stack: 		Int32Array;
	private stackTop: 	number;
	private bpc: 		number;
	private bsp: 		number;

	// Every statement here must be a plain `this.field = value` (towasm.ts's field-collecting-ctor
	// requirement for any class with an object-typed field) -- no local temporaries, no loops. Flag
	// parsing lives in the top-level `hasFlag` for that reason; the compiler's whole result collapses
	// into one `compiled` field instead of several derived ones, so it's only built once.
	constructor(pattern: string, flags: string = '') {
		this.source		= pattern;
		this.global		= hasFlag(flags, 103);      // 'g'
		this.ignoreCase = hasFlag(flags, 105);  // 'i'
		this.multiline	= hasFlag(flags, 109);   // 'm'
		this.lastIndex	= 0;
		this.compiled	= compilePattern(pattern);
		// Deliberately re-compiles rather than reading `this.compiled.groupCount` back -- towasm.ts's
		// field-collecting ctor can't read a subfield of a field assigned earlier in the same
		// constructor (confirmed: "unknown field 'groupCount'"). Cheap: construction-time only, short
		// pattern string.
		this.groups		= new Int32Array((compilePattern(pattern).groupCount + 1) * 2);
		this.stack		= new Int32Array(64);
		this.stackTop	= 0;
		this.bpc		= 0;
		this.bsp		= 0;
	}

	private charEq(a: number, b: number): boolean {
		return a === b || this.ignoreCase && swapCase(a) === b;
	}
	private classMatch(c: number, pc: number, rangeCount: number, negate: number): boolean {
		const alt: number = swapCase(c);
		let found: boolean = false;
		for (let i = 0; i < rangeCount && !found; i++) {
			const lo: number = this.compiled.prog[pc + 3 + i * 2];
			const hi: number = this.compiled.prog[pc + 3 + i * 2 + 1];
			found = (c >= lo && c <= hi) || (this.ignoreCase && alt >= lo && alt <= hi);
		}
		return negate === 1 ? !found : found;
	}
	private pushFrame(pc: number, sp: number): void {
		const frameWidth: number = 2 + this.groups.length;
		while (this.stackTop + frameWidth > this.stack.length)
			this.stack = growInt32(this.stack);
		this.stack[this.stackTop] = pc;
		this.stack[this.stackTop + 1] = sp;
		for (let i = 0; i < this.groups.length; i++)
			this.stack[this.stackTop + 2 + i] = this.groups[i];
		this.stackTop = this.stackTop + frameWidth;
	}
	private popFrame(): boolean {
		const frameWidth: number = 2 + this.groups.length;
		if (this.stackTop === 0) return false;
		this.stackTop = this.stackTop - frameWidth;
		this.bpc = this.stack[this.stackTop];
		this.bsp = this.stack[this.stackTop + 1];
		for (let i = 0; i < this.groups.length; i++)
			this.groups[i] = this.stack[this.stackTop + 2 + i];
		return true;
	}

	private runVM(s: string, start: number): boolean {
		this.stackTop = 0;
		for (let gi = 0; gi < this.groups.length; gi++)
			this.groups[gi] = -1;

		let pc: number = 0;
		let sp: number = start;
		while (true) {
			let ok: boolean = false;
			const op: number = this.compiled.prog[pc];
			switch (op) {
				case RegExp.OP_MATCH:
					return true;
				case RegExp.OP_CHAR:
					if (sp < s.length && this.charEq(s.charCodeAt(sp), this.compiled.prog[pc + 1])) {
						sp = sp + 1;
						pc = pc + 2;
						ok = true;
					}
					break;
				case RegExp.OP_ANY:
					if (sp < s.length && s.charCodeAt(sp) !== 10 && s.charCodeAt(sp) !== 13) {
						sp = sp + 1;
						pc = pc + 1;
						ok = true;
					}
					break;
				case RegExp.OP_CLASS:
					if (sp < s.length && this.classMatch(s.charCodeAt(sp), pc, this.compiled.prog[pc + 2], this.compiled.prog[pc + 1])) {
						sp = sp + 1;
						pc = pc + 3 + this.compiled.prog[pc + 2] * 2;
						ok = true;
					}
					break;
				case RegExp.OP_SAVE:
					this.groups[this.compiled.prog[pc + 1]] = sp;
					pc = pc + 2;
					ok = true;
					break;
				case RegExp.OP_JMP:
					pc = this.compiled.prog[pc + 1];
					ok = true;
					break;
				case RegExp.OP_SPLIT:
					this.pushFrame(this.compiled.prog[pc + 2], sp);
					pc = this.compiled.prog[pc + 1];
					ok = true;
					break;
				case RegExp.OP_BACKREF: {
					const g: number = this.compiled.prog[pc + 1];
					const gs: number = this.groups[g * 2];
					const ge: number = this.groups[g * 2 + 1];
					if (gs === -1) {
						pc = pc + 2;
						ok = true;
					} else {
						const len: number = ge - gs;
						let match: boolean = true;
						let j: number = 0;
						while (j < len) {
							if (sp + j >= s.length || !this.charEq(s.charCodeAt(sp + j), s.charCodeAt(gs + j))) {
								match = false;
								break;
							}
							j = j + 1;
						}
						if (match) {
							sp = sp + len;
							pc = pc + 2;
							ok = true;
						}
					}
					break;
				}
				case RegExp.OP_BOL:
					if (sp === 0 || (this.multiline && s.charCodeAt(sp - 1) === 10)) {
						pc = pc + 1;
						ok = true;
					}
					break;
				case RegExp.OP_EOL:
					if (sp === s.length || (this.multiline && s.charCodeAt(sp) === 10)) {
						pc = pc + 1;
						ok = true;
					}
					break;
				case RegExp.OP_SPACE:
					if (sp < s.length && strIsSpace(s.charCodeAt(sp))) {
						sp = sp + 1;
						pc = pc + 1;
						ok = true;
					}
					break;
				case RegExp.OP_NSPACE:
					if (sp < s.length && !strIsSpace(s.charCodeAt(sp))) {
						sp = sp + 1;
						pc = pc + 1;
						ok = true;
					}
					break;
				case RegExp.OP_WORDB: case RegExp.OP_NWORDB: {
					const before: boolean = sp > 0 && isWordChar(s.charCodeAt(sp - 1));
					const after: boolean = sp < s.length && isWordChar(s.charCodeAt(sp));
					const boundary: boolean = before !== after;
					if ((op === RegExp.OP_WORDB) === boundary) {
						pc = pc + 1;
						ok = true;
					}
				}
			}
			if (!ok) {
				if (this.popFrame()) {
					pc = this.bpc;
					sp = this.bsp;
				} else {
					return false;
				}
			}
		}
	}

	private buildMatch(s: string): RegExpMatch {
		const offsets = new Int32Array(this.groups.length);
		for (let i = 0; i < this.groups.length; ++i)
			offsets[i] = this.groups[i];
		return new RegExpMatch(s, this.groups[0], this.compiled.groupCount + 1, offsets);
	}

	// Scans from `from` regardless of `global`/`lastIndex` -- `exec` (below) layers the real JS
	// `global`-vs-not `lastIndex` contract on top of this; `String.split` (string.ts) also calls
	// this directly, since split must scan the whole string regardless of the separator's own flags.
	execFrom(s: string, from: number): RegExpMatch | null {
		let pos: number = from;
		while (pos <= s.length) {
			if (this.runVM(s, pos))
				return this.buildMatch(s);
			pos = pos + 1;
		}
		return null;
	}
	exec(s: string): RegExpMatch | null {
		const start: number = this.global ? this.lastIndex : 0;
		if (start > s.length) {
			if (this.global)
				this.lastIndex = 0;
			return null;
		}
		const result: RegExpMatch | null = this.execFrom(s, start);
		if (this.global) {
			if (result === null) {
				this.lastIndex = 0;
			} else {
				const end: number = result.groupEnd(0);
				this.lastIndex = end > result.index ? end : end + 1;
			}
		}
		return result;
	}
	test(s: string): boolean {
		return this.exec(s) !== null;
	}
}

// `values: Array<string>` was the first design here -- reverted: a field/return-type typed
// `Array<string>` loses its type argument somewhere in towasm.ts's inference when read back
// through a local (`local 'x' has an unsupported type`, traced to `typeOf`'s bare-name
// `classes.get(t.name)` fallback missing the composite `'Array<string>'` cache key), separate
// from the two other real bugs found building this file. `group(i)` slices on demand off
// `offsets` instead -- entirely proven machinery (Int32Array, String.slice), no Array<T> at all.
export class RegExpMatch {
	input: string;
	index: number;
	count: number;
	private offsets: Int32Array;

	constructor(input: string, index: number, count: number, offsets: Int32Array) {
		this.input = input;
		this.index = index;
		this.count = count;
		this.offsets = offsets;
	}
	get length(): number { return this.count; }
	groupStart(i: number): number { return this.offsets[i * 2]; }
	groupEnd(i: number): number { return this.offsets[i * 2 + 1]; }
	group(i: number): string {
		const gs: number = this.offsets[i * 2];
		const ge: number = this.offsets[i * 2 + 1];
		return gs === -1 ? '' : this.input.slice(gs, ge);
	}
}

// `$1`.."$9"/`$&`/`$$` substitution for String.replace -- a plain fixed digit 1-9 (see the
// header comment's documented multi-digit-backreference exclusion, same limit here for consistency).
export function expandReplacement(pattern: string, m: RegExpMatch): string {
	let result: string = '';
	let i: number = 0;
	const n: number = pattern.length;
	while (i < n) {
		const c: number = pattern.charCodeAt(i);
		if (c === 36 && i + 1 < n) {
			const d: number = pattern.charCodeAt(i + 1);
			if (d === 36) { result = result.concat('$'); i = i + 2; }
			else if (d === 38) { result = result.concat(m.group(0)); i = i + 2; }
			else if (d >= 49 && d <= 57) {
				const g: number = d - 48;
				if (g < m.length) result = result.concat(m.group(g));
				else result = result.concat('$').concat(String.fromCharCode(d));
				i = i + 2;
			} else {
				result = result.concat(String.fromCharCode(c));
				i = i + 1;
			}
		} else {
			result = result.concat(String.fromCharCode(c));
			i = i + 1;
		}
	}
	return result;
}

// String.split's result -- same offset-based reasoning as RegExpMatch above (no Array<string>).
// Capture groups are not interleaved into the result (unlike real JS's split(/(\d)/)) -- explicit
// scope simplification, not an oversight.
export class StringParts {
	input: string;
	count: number;
	private offsets: Int32Array;

	constructor(input: string, count: number, offsets: Int32Array) {
		this.input = input;
		this.count = count;
		this.offsets = offsets;
	}
	get length(): number { return this.count; }
	get(i: number): string {
		return this.input.slice(this.offsets[i * 2], this.offsets[i * 2 + 1]);
	}
}
