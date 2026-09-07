/// <reference path="./lib.d.ts" />

//-----------------------------------------------------------------------------
//	Map -- linear-scan implementation
//-----------------------------------------------------------------------------

// O(n) get/set/has/delete over a parallel keys_/values_ pair -- real `===` for key equality, which
// is already correct per-type in this compiler (content-based for `string`, reference-based for a
// class instance), matching real Map's own key semantics for both without any special-casing here.
// A real hash table (O(1) for string keys, the common case) is a legitimate later optimization, not
// attempted yet -- this project's own actual Map usage (checker.ts/type-utils.ts/etc, the reason
// this file exists) isn't at a scale where O(n) lookup matters.
class Map<K, V> {
	private keys_: K[] = [];
	private values_: V[] = [];

	constructor(entries: [K, V][] = []) {
		const n = entries.length;
		for (let i = 0; i < n; i++)
			this.set(entries[i][0], entries[i][1]);
	}
	get size(): number { return this.keys_.length; }

	private indexOf(key: K): i32 {
		const n = this.keys_.length;
		for (let i = 0; i < n; i++) {
			if (this.keys_[i] === key)
				return i;
		}
		return -1;
	}

	get(key: K): V | undefined {
		const i = this.indexOf(key);
		return i === -1 ? undefined : this.values_[i];
	}
	has(key: K): boolean {
		return this.indexOf(key) !== -1;
	}
	set(key: K, value: V): this {
		const i = this.indexOf(key);
		if (i === -1) {
			this.keys_.push(key);
			this.values_.push(value);
		} else {
			this.values_[i] = value;
		}
		return this;
	}
	// Shifts every later entry down one slot -- O(n), same as the scan that found `key`, and keeps
	// the remaining entries in their original relative (insertion) order, matching real Map.
	delete(key: K): boolean {
		const i = this.indexOf(key);
		if (i === -1)
			return false;
		const n = this.keys_.length;
		for (let j = i; j < n - 1; j++) {
			this.keys_[j] = this.keys_[j + 1];
			this.values_[j] = this.values_[j + 1];
		}
		this.keys_.pop();
		this.values_.pop();
		return true;
	}
	clear(): void {
		this.keys_ = [];
		this.values_ = [];
	}

	// Real snapshots (plain arrays), not live `MapIterator`s -- full iterator-protocol/`for...of`
	// support is the separate, already-tracked "for...of over a general iterable" gap; these are
	// still genuinely useful without it.
	keys(): K[]			{ return this.keys_.slice(); }
	values(): V[]		{ return this.values_.slice(); }
	entries(): [K, V][]	{ return this.keys_.map((k, i) => [k, this.values_[i]]); }
//	[Symbol.iterator](): MapIterator<[K, V]>;

	// `thisArg` is ignored (not needed for the few real call sites this project has, and not supported by the `for...of` loop either).
	forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void {
		const n = this.keys_.length;
		for (let i = 0; i < n; i++)
			callbackfn(this.values_[i], this.keys_[i], this);
	}
}

//-----------------------------------------------------------------------------
//	Set -- linear-scan implementation (see lib/map.ts's header comment for the tradeoff)
//-----------------------------------------------------------------------------

class Set<T> {
	private items_: T[] = [];

	constructor(values: T[] = []) {
		const n = values.length;
		for (let i = 0; i < n; i++)
			this.add(values[i]);
	}

	get size(): number { return this.items_.length; }

	private indexOf(value: T): i32 {
		const n = this.items_.length;
		for (let i = 0; i < n; i++) {
			if (this.items_[i] === value)
				return i;
		}
		return -1;
	}

	has(value: T): boolean {
		return this.indexOf(value) !== -1;
	}
	add(value: T): this {
		if (this.indexOf(value) === -1)
			this.items_.push(value);
		return this;
	}
	// See Map.delete's own comment -- same shift-down-then-pop, same order guarantee.
	delete(value: T): boolean {
		const i = this.indexOf(value);
		if (i === -1)
			return false;
		const n = this.items_.length;
		for (let j = i; j < n - 1; j++)
			this.items_[j] = this.items_[j + 1];
		this.items_.pop();
		return true;
	}
	clear(): void {
		this.items_ = [];
	}

	// A real snapshot (plain array), not a live `SetIterator` -- see Map.keys's own comment.
	values(): T[]		{ return this.items_.slice(); }
	keys()				{ return this.values(); }
	entries(): [T, T][] { return this.items_.map(k => [k, k]); }
	//[Symbol.iterator](): SetIterator<T>;

	forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: any): void {
		const n = this.items_.length;
		for (let i = 0; i < n; i++)
			callbackfn(this.items_[i], this.items_[i], this);
	}

}

//-----------------------------------------------------------------------------
//	WeakMap -- backed by Map, and not actually weak
//-----------------------------------------------------------------------------

// Nothing is collected: an entry lives as long as the WeakMap does, since there's no finalization to
// hook. Every use in this project is a cache keyed by an immutable Type/AST node, so it costs only
// retention, never correctness.
class WeakMap<K, V> {
	private map_: Map<K, V>;

	constructor(entries: [K, V][] = []) {
		this.map_ = new Map<K, V>(entries);
	}

	get(key: K): V | undefined		{ return this.map_.get(key); }
	has(key: K): boolean			{ return this.map_.has(key); }
	set(key: K, value: V): this		{ this.map_.set(key, value); return this; }
	delete(key: K): boolean			{ return this.map_.delete(key); }
}
