/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable no-shadow-restricted-names */
/* eslint-disable no-var */
// Ambient declarations shared by every `lib/*.ts` file -- read and parsed alongside them (see towasm.ts's
// own `LIB_AST`), never `import`ed as a normal module, so none of this needs an `export`.


declare module 'wasi_snapshot_preview1' {
	export function fd_write(fd: i32, iovsPtr: i32, iovsLen: i32, nwrittenPtr: i32): i32;
	export function fd_read(fd: i32, iovsPtr: i32, iovsLen: i32, nreadPtr: i32): i32;
	export function fd_close(fd: i32): i32;
	export function fd_filestat_get(fd: i32, bufPtr: i32): i32;
	export function fd_prestat_get(fd: i32, prestatPtr: i32): i32;
	export function fd_prestat_dir_name(fd: i32, pathPtr: i32, pathLen: i32): i32;
	export function path_open(fd: i32, dirflags: i32, pathPtr: i32, pathLen: i32, oflags: i32, fsRightsBase: i64, fsRightsInheriting: i64, fdflags: i32, openedFdPtr: i32): i32;
	export function fd_readdir(fd: i32, bufPtr: i32, bufLen: i32, cookie: i64, bufusedPtr: i32): i32;
	export function path_create_directory(fd: i32, pathPtr: i32, pathLen: i32): i32;
	export function proc_exit(code: i32): void;
	export function args_get(argvPtr: i32, argvBufPtr: i32): i32;
	export function args_sizes_get(argcPtr: i32, argvBufSizePtr: i32): i32;
	export function environ_get(environPtr: i32, environBufPtr: i32): i32;
	export function environ_sizes_get(environCountPtr: i32, environBufSizePtr: i32): i32;
}
// Declaring standard modern WASI resource management functions
declare module 'wasi:io/resource-error' {
	// Standard WASI function to drop a host resource handle
	export function drop(resourceHandle: i32): void;
}

// `__asm(asmText)` is how a lib file embeds real wasm assembly -- towasm.ts's own `isAsm`/`makeAsmBuiltin`
// recognize a call to this exact name and compile `asmText` as real instructions (see `WAT.parseAsmBody`),
// so `Math.floor = __asm<[number], number>('(switch $T (($f32 $f64) $T.floor))')` really does emit an
// `f64.floor`/`f32.floor` at every call site, per whichever type the switch's own arm declares. This
// `declare` itself is only the *signature* half of that: a bodyless ambient function
// has no real implementation to fall back to, but nothing ever calls it as a plain function either -- the
// general checker and the editor just need *some* type for `__asm<...>(...)` to type-check the field/const
// it's assigned to, and this is what supplies it.
declare function __asm<P extends any[], R>(asm: string): (...args: P) => R;

// `console.ts`'s bump allocator, declared here as a global rather than imported: `lib/node/*` is loaded
// ON DEMAND as a real module, and an `import` of `./console` would compile a SECOND copy of it -- a second
// `heap` over the same linear memory, which is silent corruption, not duplication.
declare function __alloc(size: i32, align: i32): i32;
// Mark/release around `__alloc`'s bump offset -- the only reclamation it has. Release only once every
// value that must outlive the scratch (a GC string/array/object) has been built; a raw pointer does not
// survive a release.
declare function __allocMark(): i32;
declare function __allocRelease(mark: i32): void;

// Same shape as `StringParser` below: the real one is `export`ed from `bigint.ts`, which makes it a
// MODULE to tsc and so invisible to a sibling lib file -- towasm sees one flat scope. Named here rather
// than imported, for the reason `lib/node/*` must never import a static lib file.
declare function bigToNumber(a: bigint): number;

declare function pure(target: any, propertyKey: string, descriptor: PropertyDescriptor): void;

// Pseudo-types for `__asm`'s own `P`/`R` generic args, purely so an asm-backed method can declare its
// *real* wasm-level param/result type when it isn't `number`'s usual `f64` -- e.g. `String.charCodeAt`'s
// index param is a genuine wasm `i32` (an array index), not a general-purpose `number`; declaring it
// `i32` here is what tells `towasm.ts` to actually emit that param as i32, not silently widen/narrow it.
// Not used for arithmetic (never resolved by the general checker either) -- matched directly in
// `towasm.ts`'s `builtinTypes`, ahead of `T.resolve`'s alias-unwrapping, same as any other builtin name --
// so a *plain* class field/method can use one too, not just an `__asm<P,R>` type argument (see
// `lib/typedarray.ts`'s own fields/`get`/`set`). `u32` is wasm's usual `i32` storage, just tagged so a
// caller/comparison knows to treat it as unsigned (see `Uint32Array.get`).
declare type u8 = number;
declare type i8 = number;
declare type i16 = number;
declare type u16 = number;
declare type i32 = number;
declare type i64 = number;
declare type f32 = number;
declare type f64 = number;
declare type u32 = number;
declare type u64 = number;

declare var NaN: number;
declare var Infinity: number;

interface Function {
	apply(this: Function, thisArg: any, argArray?: any): any;
	call(this: Function, thisArg: any, ...argArray: any[]): any;
	bind(this: Function, thisArg: any, ...argArray: any[]): any;
	toString(): string;
	readonly length: number;
	readonly name: string;
}
interface CallableFunction {}
interface NewableFunction {}
interface IArguments {}
interface Boolean {}
declare var Boolean: {
	(value?: any): boolean;
};
interface BigInt {
	// Declared because the lib's own sources call them (`toString` recurses on the magnitude, `pow`
	// squares); `lib/bigint.ts` implements far more, and `lib/tsconfig.json` is the only thing that
	// type-checks those sources at all.
	toString(radix?: number): string;
	mul(b: bigint): bigint;
	add(b: bigint): bigint;
}
// The CALL side, which is not the constructor: `BigInt(5)` is a `bigint`, `new BigInt()` is a `BigInt`.
// Same two-declaration shape `Number` below already uses, and TypeScript's own lib uses for all four.
declare var BigInt: {
	(value?: any): bigint;
};

//-----------------------------------------------------------------------------
//	Object
//-----------------------------------------------------------------------------

interface Symbol {
	toString(): string;
	valueOf(): symbol;
}

declare type PropertyKey = string | number | symbol;

interface PropertyDescriptor {
	configurable?: boolean;
	enumerable?: boolean;
	value?: any;
	writable?: boolean;
	get?(): any;
	set?(v: any): void;
}

interface PropertyDescriptorMap {
	[key: PropertyKey]: PropertyDescriptor;
}

// A compiler intrinsic, not real TS source: what fields exist depends on the argument's own concrete
// type at each call site, which only the compiler itself can see. `entries`/`values`/`keys` currently
// support a `Map`-backed dynamic object (forward to its own real methods) and a *sealed* (never-
// subclassed) struct-backed class/object-shape; an extended class isn't supported yet (would need the
// receiver's real runtime type, not just its static one). `defineProperty` only supports a plain value
// descriptor (`{value: ...}`, real `enumerable`/`configurable`/`writable` flags accepted but with no
// observable effect) and a literal string `key` -- see `emitObjectDefineProperty` in towasm.ts.
interface Object {
	constructor: Function;
	toString(): string;
	toLocaleString(): string;
	valueOf(): Object;
	hasOwnProperty(v: PropertyKey): boolean;
	isPrototypeOf(v: Object): boolean;
	propertyIsEnumerable(v: PropertyKey): boolean;
}
declare var Object: {
	entries<T>(x: T): [string, any][];
	values<T>(x: T): any[];
	keys<T>(x: T): string[];
	is<A, B>(a: A, b: B): boolean;
	// TS's own overloads (lib.es2015.core): the result carries every source's members.
	assign<T extends {}, U>(target: T, source: U): T & U;
	assign<T extends {}, U, V>(target: T, source1: U, source2: V): T & U & V;
	assign<T extends {}, U, V, W>(target: T, source1: U, source2: V, source3: W): T & U & V & W;
	assign(target: object, ...sources: any[]): any;
	defineProperty<T>(target: T, key: PropertyKey, descriptor: PropertyDescriptor): T;
};

//-----------------------------------------------------------------------------
//	Number
//-----------------------------------------------------------------------------

interface Number {
	// `lib/number.ts` implements far more than this; declared here because the lib's own sources call it
	// (`Array._indexKeys`), and `lib/tsconfig.json` is the only thing that type-checks them.
	toString(radix?: number): string;
}
declare var Number: {
	new (value?: any): Number;
	(value?: any): number;
};

//-----------------------------------------------------------------------------
//	String
//-----------------------------------------------------------------------------

interface String {
	readonly length: number;

	toString(): string;
	charAt(pos: number): string;
	charCodeAt(index: number): number;
	//concat(...strings: string[]): string;
	concat(b: string): string;
	indexOf(searchString: string, position?: number): number;
	lastIndexOf(searchString: string, position?: number): number;
//	localeCompare(that: string): number;
	match(regexp: string | RegExp): RegExpMatchArray | null;
	replace(searchValue: string | RegExp, replaceValue: string): string;
	replace(searchValue: string | RegExp, replacer: (substring: string, ...args: any[]) => string): string;
	search(regexp: string | RegExp): number;
	slice(start?: number, end?: number): string;
	split(separator: string | RegExp, limit?: number): string[];
	substring(start: number, end?: number): string;
	toLowerCase(): string;
	toLocaleLowerCase(): string;
	toUpperCase(): string;
	toLocaleUpperCase(): string;
	trim(): string;

	valueOf(): string;

	readonly [index: number]: string;
}

declare var String: {
	(value?: any): string;
//	fromCharCode(...codes: number[]): string;
	fromCharCode(code: number): string;
	fromCodePoint(...codePoints: number[]): string;
	// One byte per char code, read straight out of linear memory -- the single-alloc counterpart to
	// building a string one `fromCharCode` at a time, for `lib/node/*`'s own WASI buffers.
	fromCharCodesAt(ptr: i32, len: i32): string;
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

//-----------------------------------------------------------------------------
//	Tagged templates
//-----------------------------------------------------------------------------

// The array a tag function's first parameter really is -- `case 'tagged_template'` synthesizes a plain
// `string[]` of the cooked text for it. `raw` is declared so the checker reports its real type rather
// than "no such property", but has no physical slot: reading it is an honest `unknown field 'raw'`.
interface TemplateStringsArray extends Array<string> {
	raw: string[];
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
}

// As TS's `RegExpConstructor`: callable without `new` (`RegExp(src, flags)`), same as `ArrayConstructor` above.
interface RegExpConstructor {
	new (source: string, flags?: string): RegExp;
	(source: string, flags?: string): RegExp;
}
declare var RegExp: RegExpConstructor;

//-----------------------------------------------------------------------------
//	Array
//-----------------------------------------------------------------------------

declare class Array<T> {
	[i: number]: T;
	length: number;

	constructor(n: number);

	grow(n: i32): i32;
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
	find<S extends T>(predicate: (value: T, index: number, obj: T[]) => value is S, thisArg?: any): S | undefined;
	find(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): T | undefined;
	findIndex(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): number;
	reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T): T;
	reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T, initialValue: T): T;
	reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
	reduceRight(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T): T;
	reduceRight(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T, initialValue: T): T;
	reduceRight<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
}

// As TS's `ArrayConstructor`: `Array` is callable WITHOUT `new` as well (`Array(n).fill(x)`, the standard
// fixed-size idiom), which a `declare class` alone cannot say -- its value has only a construct signature.
// Same shape `TypedArrayConstructor` above already uses; the statics stay on the class in `lib/array.ts`.
interface ArrayConstructor {
	new <T>(n?: number): T[];
	<T>(n?: number): T[];
}
declare var Array: ArrayConstructor;

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


//-----------------------------------------------------------------------------
//	TypedArray
//-----------------------------------------------------------------------------
interface ArrayBuffer {
//	byteLength: number;
}

interface TypedArray<T> {
	readonly BYTES_PER_ELEMENT: number;
	/*readonly*/ buffer: ArrayBuffer;
	/*readonly*/ byteOffset: number;
	/*readonly*/ byteLength: number;
	/*readonly*/ length: number;
//	[i: i32]: number;

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
	map(callbackfn: (value: number, index: number, array: this) => number, thisArg?: any): TypedArray<T>;
	reduce(callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: this) => number): number;
	reduce(callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: this) => number, initialValue: number): number;
	reduce<U>(callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: this) => U, initialValue: U): U;
	reduceRight(callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: this) => number): number;
	reduceRight(callbackfn: (previousValue: number, currentValue: number, currentIndex: number, array: this) => number, initialValue: number): number;
	reduceRight<U>(callbackfn: (previousValue: U, currentValue: number, currentIndex: number, array: this) => U, initialValue: U): U;
	reverse(): this;
	// Iterable, as TS's own typed arrays are; `lib/typedarray.ts` implements it as an indexed generator.
	[Symbol.iterator](): Generator<number, void, unknown>;
	set(array: ArrayLike<number>, offset?: number): void;
	slice(start?: number, end?: number): TypedArray<T>;
	some(predicate: (value: number, index: number, array: this) => unknown, thisArg?: any): boolean;
	sort(compareFn?: (a: number, b: number) => number): this;
	subarray(begin?: number, end?: number): TypedArray<T>;
	toLocaleString(): string;
	toString(): string;
	valueOf(): this;

}
declare type Int8Array = TypedArray<i8>;
declare type Uint8Array = TypedArray<u8>;
declare type Uint8ClampedArray = TypedArray<u8>;
declare type Int16Array = TypedArray<i16>;
declare type Uint16Array = TypedArray<u16>;
declare type Int32Array = TypedArray<i32>;
declare type Uint32Array = TypedArray<u32>;
declare type Float32Array = TypedArray<f32>;
declare type Float64Array = TypedArray<f64>;
declare type BigInt64Array = TypedArray<i64>;
declare type BigUint64Array = TypedArray<u64>;

// The values `new Uint8Array(...)` resolves against, as TS's `Uint8ArrayConstructor`: the constructors `lib/typedarray.ts` implements.
interface TypedArrayConstructor<A> {
	new (length: number): A;
	new (elements: number[]): A;
	new (buffer: ArrayBuffer, byteOffset?: number, length?: number): A;
}
declare var Int8Array: TypedArrayConstructor<Int8Array>;
declare var Uint8Array: TypedArrayConstructor<Uint8Array>;
declare var Uint8ClampedArray: TypedArrayConstructor<Uint8ClampedArray>;
declare var Int16Array: TypedArrayConstructor<Int16Array>;
declare var Uint16Array: TypedArrayConstructor<Uint16Array>;
declare var Int32Array: TypedArrayConstructor<Int32Array>;
declare var Uint32Array: TypedArrayConstructor<Uint32Array>;
declare var Float32Array: TypedArrayConstructor<Float32Array>;
declare var Float64Array: TypedArrayConstructor<Float64Array>;
declare var BigInt64Array: TypedArrayConstructor<BigInt64Array>;
declare var BigUint64Array: TypedArrayConstructor<BigUint64Array>;

//declare var TypedArray: {
//	new (length: number): TypedArray<any>;
//	new (buffer: ArrayBuffer, byteOffset?: number, length?: number): TypedArray<any>;
//	new (array: ArrayBuffer): TypedArray<any>;
//	new <T>(array: ArrayLike<T>): TypedArray<any>;
//	readonly BYTES_PER_ELEMENT: number;
//	of<T>(...items: T[]): TypedArray<T>;
//	from<T>(arrayLike: ArrayLike<T>): TypedArray<T>;
//	from<T, U>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => U, thisArg?: any): TypedArray<U>;
//}

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

//-----------------------------------------------------------------------------
//
//-----------------------------------------------------------------------------
//-----------------------------------------------------------------------------
//
//-----------------------------------------------------------------------------
declare class StringParser {
	str: string;
	pos: number;
	n: number;
	constructor(str: string, pos?: number);

	remaining(): number;
	remainder(): string;
	processed(): string;

	code(): number;
	skipCode(c: number): boolean;
	skipWhitespace(): void;
}
declare function UnsignedToString(n: number, radix?: number, digits?: number): string;
declare function strIsSpace(code: number): boolean;
declare function __towasm_alloc(size: i32, align: i32): i32;

//-----------------------------------------------------------------------------
//	Utility types
//-----------------------------------------------------------------------------

type Partial<T> = { [P in keyof T]?: T[P]; };
type Record<K extends keyof any, T> = { [P in K]: T; };
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type NonNullable<T> = T & {};
type Pick<T, K extends keyof T> = { [P in K]: T[P]; };
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
type Readonly<T> = { readonly [P in keyof T]: T[P]; };

