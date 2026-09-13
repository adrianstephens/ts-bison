
// A language's walker, one entry per node kind `K`: what `walk` returns and every handler's `recurse`. The caller
// names the kind, since a tag can't always tell (a TS 'literal' or 'this' is identical as a type and an expression).
export type Walker<K>	= { [P in keyof K]: <T extends K[P]>(x?: T) => T | undefined };
// The printing counterpart: a language's code printer, one entry per node kind.
export type Printer<K>	= { [P in keyof K]: (x: K[P]) => string };
export type OnAST<U, R>	= (x: U, process: <T extends U>(x: T) => T, recurse: R) => U | undefined;

export function makeProcess<U, R>(parts: (x: U) => U, on: OnAST<U, R> | undefined, recurse: R, always = false) {
	return	on		? <T extends U>(t?: T) => t ? on(t, <T extends U>(t: T) => parts(t) as T, recurse) as T | undefined : undefined
		:	always	? <T extends U>(t?: T) => t ? parts(t) as T : undefined
					: <T extends U>(t?: T) => t;
}

export function mapArray<T>(map: (x: T) => T | undefined) {
	return (x: readonly T[]): T[] | undefined => {
		const result = x.map(map).filter(i => i !== undefined);
		return result.length > 0 ? result : undefined;
	};
}
export function mapArrayA<T>(map: (x: T) => T | undefined) {
	return (x: readonly T[]): T[] => x.map(map).filter(i => i !== undefined);
}
export function mapDefined<T>(map: (x: T) => T | undefined) {
	return (x: T) => {
		const r = map(x);
		if (r === undefined)
			throw new Error('walk: mapper deleted a required node');
		return r;
	};
}

export function notUndefined<T>(x: T | undefined): T {
	if (x === undefined)
		throw new Error('mapor returned undefined');
	return x;
}

export type NodeMap<N> = Partial<{[K in keyof N]: (x: Exclude<N[K], undefined>) => Exclude<N[K], undefined> | undefined}>;

export function mapObject<N extends Record<string, any>>(node: N, fields: NodeMap<N>): N {
	const r = {...node};
	for (const f in fields) {
		const k = f as keyof N;
		if (node[k] !== undefined) {
			const ret = fields[k]?.(node[k]);
			if (ret !== undefined)
				r[k] = ret;
			else
				delete r[k];
		}
	}
	
	//transfer source location
	const pos = (node as any).pos;
	if (pos)
		Object.defineProperty(r, 'pos', {value: pos, enumerable: false, configurable: true, writable: false });
	return r;
}


// ===================================================================
//  walkB -- boolean short-circuit search
// ===================================================================

export type WalkerB<K>		= { [P in keyof K]: (x?: K[P]) => boolean };
export type OnASTB<U, R>	= (x: U, process: (x: U) => boolean, recurse: R) => boolean;

export function makeProcessB<U, R>(parts: (x: U) => boolean, on: OnASTB<U, R> | undefined, recurse: R, always = false) {
	return	on		? (t?: U) => t ? on(t, (t: U) => parts(t), recurse) : false
		:	always	? (t?: U) => t ? parts(t) : false
					: (_?: U) => false;
}

