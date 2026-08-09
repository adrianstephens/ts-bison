// Ambient declarations shared by every `lib/*.ts` file -- read and parsed alongside them (see towasm.ts's
// own `LIB_AST`), never `import`ed as a normal module, so none of this needs an `export`.
//
// `__asm(asmText)` is how a lib file embeds real wasm assembly -- towasm.ts's own `isAsm`/`makeAsmBuiltin`
// recognize a call to this exact name and compile `asmText` as real instructions (see `WAT.parseAsmBody`),
// so `Math.floor = __asm<[number], number>('(switch $T (($f32 $f64) $T.floor))')` really does emit an
// `f64.floor`/`f32.floor` at every call site, per whichever type the switch's own arm declares. This
// `declare` itself is only the *signature* half of that: a bodyless ambient function
// has no real implementation to fall back to, but nothing ever calls it as a plain function either -- the
// general checker and the editor just need *some* type for `__asm<...>(...)` to type-check the field/const
// it's assigned to, and this is what supplies it.
declare function __asm<P extends any[], R>(asm: string): (...args: P) => R;

// Pseudo-types for `__asm`'s own `P`/`R` generic args, purely so an asm-backed method can declare its
// *real* wasm-level param/result type when it isn't `number`'s usual `f64` -- e.g. `String.charCodeAt`'s
// index param is a genuine wasm `i32` (an array index), not a general-purpose `number`; declaring it
// `i32` here is what tells `towasm.ts` to actually emit that param as i32, not silently widen/narrow it.
// Not used for arithmetic (never resolved by the general checker either) -- matched directly in
// `towasm.ts`'s `builtinTypes`, ahead of `T.resolve`'s alias-unwrapping, same as any other builtin name --
// so a *plain* class field/method can use one too, not just an `__asm<P,R>` type argument (see
// `lib/typedarray.ts`'s own fields/`get`/`set`). `u32` is wasm's usual `i32` storage, just tagged so a
// caller/comparison knows to treat it as unsigned (see `Uint32Array.get`).
declare type i32 = number;
declare type i64 = number;
declare type f32 = number;
declare type f64 = number;
declare type u32 = number;

declare var NaN: number;
declare var Infinity: number;
/*
interface Object {}
interface Function {}
interface CallableFunction {}
interface NewableFunction {}
interface IArguments {}
interface Symbol {}
interface Boolean {}
interface Number {}

//-----------------------------------------------------------------------------
//	String
//-----------------------------------------------------------------------------

interface String {
	toString(): string;
	charAt(pos: number): string;
	charCodeAt(index: number): number;
	//concat(...strings: string[]): string;
	concat(b: string): string;
	indexOf(searchString: string, position?: number): number;
	lastIndexOf(searchString: string, position?: number): number;
	localeCompare(that: string): number;
	match(regexp: string | RegExp): RegExpMatchArray | null;
	replace(searchValue: string | RegExp, replaceValue: string): string;
	replace(searchValue: string | RegExp, replacer: (substring: string, ...args: any[]) => string): string;
	search(regexp: string | RegExp): number;
	slice(start?: number, end?: number): string;
	split(separator: string | RegExp, limit?: number): string[];
	substring(start: number, end?: number): string;
	toLowerCase(): string;
	toLocaleLowerCase(locales?: string | string[]): string;
	toUpperCase(): string;
	toLocaleUpperCase(locales?: string | string[]): string;
	trim(): string;
	readonly length: number;

	// IE extensions
	substr(from: number, length?: number): string;
	valueOf(): string;

	readonly [index: number]: string;
}

declare var String: {
//	fromCharCode(...codes: number[]): string;
	fromCharCode(code: number): string;
};

//-----------------------------------------------------------------------------
//	RegExp
//-----------------------------------------------------------------------------

interface RegExpMatchArray extends Array<string> {
	index?: number;
	input?: string;
	0: string;
}

interface RegExpExecArray extends Array<string> {
	index: number;
	input: string;
	0: string;
}

interface RegExp {
	exec(string: string): RegExpExecArray | null;
	test(string: string): boolean;
	readonly source: string;
	readonly global: boolean;
	readonly ignoreCase: boolean;
	readonly multiline: boolean;

	lastIndex: number;

	// Non-standard extensions
	compile(pattern: string, flags?: string): this;
}

//-----------------------------------------------------------------------------
//	Array
//-----------------------------------------------------------------------------

interface ArrayLike<T> {
    readonly length: number;
    readonly [n: number]: T;
}

interface ConcatArray<T> {
	readonly length: number;
	readonly [n: number]: T;
	join(separator?: string): string;
	slice(start?: number, end?: number): T[];
}

interface Array<T> {
	[i: number]: T;
	length: number;

	toString(): string;
	toLocaleString(): string;
	pop(): T | undefined;
	//push(...items: T[]): number;
	//concat(...items: ConcatArray<T>[]): T[];
	//concat(...items: (T | ConcatArray<T>)[]): T[];
	//unshift(...items: T[]): number;
	push(item: T): number;
	concat(item: T[]): T[];
	unshift(item: T): number;
	join(separator?: string): string;
	reverse(): T[];
	shift(): T | undefined;
	slice(start?: number, end?: number): T[];
	sort(compareFn?: (a: T, b: T) => number): this;
	splice(start: number, deleteCount?: number): T[];
	splice(start: number, deleteCount: number, ...items: T[]): T[];
	indexOf(searchElement: T, fromIndex?: number): number;
	lastIndexOf(searchElement: T, fromIndex?: number): number;
	every<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: any): this is S[];
	every(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean;
	some(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean;
	forEach(callbackfn: (value: T, index: number, array: T[]) => void, thisArg?: any): void;
	map<U>(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any): U[];
	filter<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: any): S[];
	filter(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): T[];
	reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T): T;
	reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T, initialValue: T): T;
	reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
	reduceRight(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T): T;
	reduceRight(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T, initialValue: T): T;
	reduceRight<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
}

//-----------------------------------------------------------------------------
//	TypedArray
//-----------------------------------------------------------------------------

interface TypedArray<T> {
    readonly BYTES_PER_ELEMENT: number;
    readonly buffer: ArrayBuffer;
    readonly byteLength: number;
    readonly byteOffset: number;
    copyWithin(target: number, start: number, end?: number): this;
    every(predicate: (value: number, index: number, array: this) => unknown, thisArg?: any): boolean;
    fill(value: number, start?: number, end?: number): this;
    filter(predicate: (value: number, index: number, array: this) => any, thisArg?: any): TypedArray<T>;
    find(predicate: (value: number, index: number, obj: this) => boolean, thisArg?: any): number | undefined;
    findIndex(predicate: (value: number, index: number, obj: this) => boolean, thisArg?: any): number;
    forEach(callbackfn: (value: number, index: number, array: this) => void, thisArg?: any): void;
    indexOf(searchElement: number, fromIndex?: number): number;
    join(separator?: string): string;
    lastIndexOf(searchElement: number, fromIndex?: number): number;
    readonly length: number;
    map(callbackfn: (value: number, index: number, array: this) => number, thisArg?: any): TypedArray<T>;
    reduce(callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: this) => number): number;
    reduce(callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: this) => number, initialValue: number): number;
    reduce<U>(callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: this) => U, initialValue: U): U;
    reduceRight(callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: this) => number): number;
    reduceRight(callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: this) => number, initialValue: number): number;
    reduceRight<U>(callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: this) => U, initialValue: U): U;
    reverse(): this;
    set(array: ArrayLike<number>, offset?: number): void;
    slice(start?: number, end?: number): TypedArray<T>;
    some(predicate: (value: number, index: number, array: this) => unknown, thisArg?: any): boolean;
    sort(compareFn?: (a: number, b: number) => number): this;
    subarray(begin?: number, end?: number): TypedArray<T>;
    toLocaleString(): string;
    toString(): string;
    valueOf(): this;

    [index: number]: number;
}

declare var TypedArray: {
    new (length: number): TypedArray<any>;
    new (buffer: ArrayBuffer, byteOffset?: number, length?: number): TypedArray<any>;
    new (array: ArrayBuffer): TypedArray<any>;
    new <T>(array: ArrayLike<T>): TypedArray<any>;
    readonly BYTES_PER_ELEMENT: number;
    of<T>(...items: T[]): TypedArray<T>;
    from<T>(arrayLike: ArrayLike<T>): TypedArray<T>;
    from<T, U>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => U, thisArg?: any): TypedArray<U>;
}

//-----------------------------------------------------------------------------
//	Math
//-----------------------------------------------------------------------------

declare var Math: {
	readonly E: number;
	readonly LN10: number;
	readonly LN2: number;
	readonly LOG2E: number;
	readonly LOG10E: number;
	readonly PI: number;
	readonly SQRT1_2: number;
	readonly SQRT2: number;
	abs(x: number): number;
	acos(x: number): number;
	asin(x: number): number;
	atan(x: number): number;
	atan2(y: number, x: number): number;
	ceil(x: number): number;
	cos(x: number): number;
	exp(x: number): number;
	floor(x: number): number;
	log(x: number): number;
//	max(...values: number[]): number;
//	min(...values: number[]): number;
	max(a: number, b: number): number;
	min(a: number, b: number): number;
	pow(x: number, y: number): number;
	random(): number;
	round(x: number): number;
	sin(x: number): number;
	sqrt(x: number): number;
	tan(x: number): number;
};
*/
//-----------------------------------------------------------------------------
//
//-----------------------------------------------------------------------------

declare function UnsignedToString(n: number, radix?: number, digits?: number): string;
